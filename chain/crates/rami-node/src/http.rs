//! Servidor HTTP/1.1 mínimo (solo `std`) para el panel LOCAL del monedero.
//!
//! Escucha solo en 127.0.0.1: es la interfaz de una app de escritorio, no un
//! servicio público. Un hilo por conexión, `Connection: close`. Sin dependencias.
//!
//! Defensas (v0.7.1): líneas y cabeceras acotadas (nadie puede hacernos
//! reservar memoria sin límite), timeouts de lectura/escritura (un cliente
//! que abre conexiones y no habla no bloquea hilos para siempre), y un
//! **token de sesión** (`~/.rami/panel-<puerto>.token`, permisos 0600, como el
//! `.cookie` de Bitcoin Core) que el panel manda en `X-Rami-Token`: otro
//! usuario de la misma máquina o un proceso sin acceso a tu carpeta personal
//! no puede dar órdenes al monedero. Las cabeceras `Host`, `Origin` y
//! `Referer` se entregan al manejador para vetar peticiones cross-origin.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Longitud máxima de la línea de petición y de cada cabecera.
const MAX_LINE: usize = 8 * 1024;
/// Número máximo de cabeceras por petición.
const MAX_HEADERS: usize = 100;
/// Cuerpo máximo (panel local, cuerpos pequeños).
const MAX_BODY: usize = 1 << 20;
/// Un cliente que no termina de hablar en este tiempo se corta.
const IO_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Vec<u8>,
    /// Cabecera Content-Type (minúsculas; vacía si no vino).
    pub content_type: String,
    /// Cabecera Host (minúsculas; vacía si no vino).
    pub host: String,
    /// Cabecera Origin (minúsculas; vacía si no vino).
    pub origin: String,
    /// Cabecera Referer (minúsculas; vacía si no vino).
    pub referer: String,
    /// Cabecera X-Rami-Token (token de sesión del panel; vacía si no vino).
    pub token: String,
}

impl Request {
    /// Valor de un parámetro de query (`?n=15`). Sin descodificar %; nos basta
    /// para claves/valores simples (números, hex).
    pub fn query_get(&self, key: &str) -> Option<String> {
        for pair in self.query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == key {
                    return Some(v.to_string());
                }
            }
        }
        None
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(v: &serde_json::Value) -> Self {
        Response {
            status: 200,
            content_type: "application/json; charset=utf-8".into(),
            body: serde_json::to_vec(v).unwrap_or_default(),
        }
    }
    pub fn html(s: &str) -> Self {
        Response { status: 200, content_type: "text/html; charset=utf-8".into(), body: s.as_bytes().to_vec() }
    }
    pub fn not_found() -> Self {
        Response { status: 404, content_type: "text/plain; charset=utf-8".into(), body: b"not found".to_vec() }
    }
}

// ------------------------------------------------------------ token

fn home_dir() -> Option<PathBuf> {
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(h) = std::env::var(var) {
            if !h.is_empty() {
                return Some(PathBuf::from(h));
            }
        }
    }
    None
}

/// Archivo del token dentro de una carpeta personal dada (parametrizado para
/// poder probarlo sin tocar el `~/.rami` real del usuario).
fn token_file(home: &Path, port: u16) -> PathBuf {
    home.join(".rami").join(format!("panel-{port}.token"))
}

/// Archivo del token de sesión del panel de un puerto: `~/.rami/panel-<puerto>.token`.
pub fn token_path(port: u16) -> Option<PathBuf> {
    home_dir().map(|h| token_file(&h, port))
}

/// Token nuevo: 32 bytes del generador del sistema, en hex.
pub fn new_token() -> String {
    use rand_core::{OsRng, RngCore};
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// ¿Tiene forma de token del panel (64 caracteres hexadecimales)?
fn token_is_valid(t: &str) -> bool {
    t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit())
}

fn write_token_at(p: &Path, token: &str) -> io::Result<()> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(p)?;
    f.write_all(token.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Guarda el token con permisos 0600 (solo tu usuario puede leerlo).
pub fn write_token(port: u16, token: &str) -> io::Result<()> {
    let p = token_path(port).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "sin carpeta personal"))?;
    write_token_at(&p, token)
}

fn read_token_at(p: &Path) -> Option<String> {
    let t = std::fs::read_to_string(p).ok()?;
    let t = t.trim().to_string();
    if token_is_valid(&t) {
        Some(t)
    } else {
        None
    }
}

/// Lee el token del panel que escucha en `port` (si este usuario lo creó).
pub fn read_token(port: u16) -> Option<String> {
    read_token_at(&token_path(port)?)
}

/// Token de sesión ESTABLE entre arranques: reutiliza el que ya haya en
/// `<home>/.rami/panel-<puerto>.token` si sigue siendo válido, y solo crea uno
/// nuevo cuando falta o está corrupto.
///
/// Por qué NO se rota en cada arranque, a diferencia del `.cookie` de Bitcoin
/// Core: el cliente de este token es un NAVEGADOR, y un navegador no puede leer
/// archivos. El panel guarda su token y, al detectar que el proceso cambió
/// (una actualización), se recarga solo. Con un token distinto en cada arranque
/// esa recarga mandaba el token viejo, el monedero respondía «sesión no
/// autorizada» y quien tuviera el panel abierto antes de actualizar se quedaba
/// fuera hasta reabrir desde la app (regresión de la v0.7.1). El archivo sigue
/// siendo 0600: su vida útil es la de la cuenta del usuario, no la del proceso.
pub fn load_or_create_token_in(home: &Path, port: u16) -> io::Result<String> {
    let p = token_file(home, port);
    if let Some(t) = read_token_at(&p) {
        // Reafirma los permisos por si el archivo llegó de una copia o backup.
        write_token_at(&p, &t)?;
        return Ok(t);
    }
    let t = new_token();
    write_token_at(&p, &t)?;
    Ok(t)
}

/// Como [`load_or_create_token_in`], en la carpeta personal del usuario.
pub fn load_or_create_token(port: u16) -> io::Result<String> {
    let h = home_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "sin carpeta personal"))?;
    load_or_create_token_in(&h, port)
}

/// Comparación en tiempo constante (no depende de en qué byte difieren).
pub fn token_ok(given: &str, expected: &str) -> bool {
    let a = given.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() || b.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

// ------------------------------------------------------------ cliente

/// Sonda de instancia única: pide `GET /api/status` a un puerto local y
/// devuelve el cuerpo si algo respondió HTTP. Sirve para detectar que YA hay
/// un monedero RAMI abierto en esa máquina (el cuerpo contiene "network_id").
/// Sin token solo se obtiene la parte pública (versión, pid, red).
pub fn probe_local(port: u16) -> Option<String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(700)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(700)));
    let req = format!("GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    let mut reader = BufReader::new(s);
    reader.read_to_string(&mut buf).ok()?;
    // Cuerpo = lo que sigue a la línea en blanco de las cabeceras.
    buf.split_once("\r\n\r\n").map(|(_, body)| body.to_string())
}

/// POST local sin cuerpo útil (p. ej. `/api/quit` de OTRA instancia del
/// monedero). Cumple la guardia anti-CSRF del panel (Host local y JSON) y
/// adjunta el token de ese puerto si este usuario lo tiene.
pub fn post_local(port: u16, path: &str) -> Option<String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(700)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(2500)));
    let _ = s.set_write_timeout(Some(Duration::from_millis(700)));
    let tok = read_token(port).map(|t| format!("X-Rami-Token: {t}\r\n")).unwrap_or_default();
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n{tok}Content-Length: 2\r\nConnection: close\r\n\r\n{{}}"
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = String::new();
    let mut reader = BufReader::new(s);
    reader.read_to_string(&mut buf).ok()?;
    buf.split_once("\r\n\r\n").map(|(_, body)| body.to_string())
}

// ------------------------------------------------------------ servidor

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

/// El proceso sirve una API PÚBLICA de solo lectura (`rami-node market`): las
/// respuestas llevan `Access-Control-Allow-Origin: *` para que una web (la de
/// cotización) las lea desde el navegador. El panel local NUNCA lo activa: su
/// defensa es justo lo contrario (Host exacto, Origin, token).
static PUBLIC_CORS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Sirve para siempre. `handler` se comparte entre hilos.
pub fn serve<F>(listener: TcpListener, handler: F)
where
    F: Fn(Request) -> Response + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    for stream in listener.incoming().flatten() {
        let h = handler.clone();
        thread::spawn(move || {
            let _ = handle_conn(stream, h);
        });
    }
}

/// Como `serve`, para una API pública de solo lectura: añade CORS abierto a
/// TODAS las respuestas de este proceso. Solo lo usa `rami-node market`.
pub fn serve_public<F>(listener: TcpListener, handler: F)
where
    F: Fn(Request) -> Response + Send + Sync + 'static,
{
    PUBLIC_CORS.store(true, std::sync::atomic::Ordering::Relaxed);
    serve(listener, handler)
}

/// Lee una línea de como mucho `MAX_LINE` bytes; más largo = petición
/// rechazada (nunca se acumula memoria sin tope).
fn read_line_bounded<R: BufRead>(reader: &mut R) -> io::Result<Option<String>> {
    let mut l = String::new();
    let n = reader.take((MAX_LINE + 1) as u64).read_line(&mut l)?;
    if n == 0 {
        return Ok(None);
    }
    if n > MAX_LINE || !l.ends_with('\n') {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "línea demasiado larga"));
    }
    Ok(Some(l))
}

fn handle_conn<F>(stream: TcpStream, handler: Arc<F>) -> io::Result<()>
where
    F: Fn(Request) -> Response,
{
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let mut reader = BufReader::new(stream.try_clone()?);
    let line = match read_line_bounded(&mut reader) {
        Ok(Some(l)) => l,
        Ok(None) => return Ok(()),
        Err(_) => return write_simple(stream, 400, "bad request"),
    };
    let mut parts = line.trim_end().split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };

    // Cabeceras: Content-Length + las que el manejador usa para vetar
    // peticiones cross-origin (Host, Origin, Referer) y el token de sesión.
    let mut content_length = 0usize;
    let mut content_type = String::new();
    let mut host = String::new();
    let mut origin = String::new();
    let mut referer = String::new();
    let mut token = String::new();
    let mut count = 0usize;
    loop {
        let hl = match read_line_bounded(&mut reader) {
            Ok(Some(l)) => l,
            Ok(None) => break,
            Err(_) => return write_simple(stream, 400, "bad request"),
        };
        let t = hl.trim_end();
        if t.is_empty() {
            break;
        }
        count += 1;
        if count > MAX_HEADERS {
            return write_simple(stream, 400, "too many headers");
        }
        if let Some((k, v)) = t.split_once(':') {
            let k = k.trim();
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("content-type") {
                content_type = v.trim().to_ascii_lowercase();
            } else if k.eq_ignore_ascii_case("host") {
                host = v.trim().to_ascii_lowercase();
            } else if k.eq_ignore_ascii_case("origin") {
                origin = v.trim().to_ascii_lowercase();
            } else if k.eq_ignore_ascii_case("referer") {
                referer = v.trim().to_ascii_lowercase();
            } else if k.eq_ignore_ascii_case("x-rami-token") {
                token = v.trim().to_string();
            }
        }
    }
    if content_length > MAX_BODY {
        return write_simple(stream, 413, "body too large");
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    let resp = handler(Request { method, path, query, body, content_type, host, origin, referer, token });
    write_response(stream, resp)
}

fn write_simple(stream: TcpStream, status: u16, msg: &str) -> io::Result<()> {
    write_response(
        stream,
        Response { status, content_type: "text/plain; charset=utf-8".into(), body: msg.as_bytes().to_vec() },
    )
}

fn write_response(mut w: TcpStream, resp: Response) -> io::Result<()> {
    let cors = if PUBLIC_CORS.load(std::sync::atomic::Ordering::Relaxed) { "Access-Control-Allow-Origin: *\r\n" } else { "" };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n{cors}\r\n",
        resp.status,
        reason(resp.status),
        resp.content_type,
        resp.body.len()
    );
    w.write_all(head.as_bytes())?;
    w.write_all(&resp.body)?;
    w.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare_is_exact() {
        let t = new_token();
        assert_eq!(t.len(), 64);
        assert!(token_ok(&t, &t));
        assert!(!token_ok("", &t));
        assert!(!token_ok(&t[..63], &t));
        assert!(!token_ok("", ""));
        let mut other = t.clone();
        other.replace_range(0..1, if t.starts_with('0') { "1" } else { "0" });
        assert!(!token_ok(&other, &t));
    }

    fn tmp_home(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rami-token-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// REGRESIÓN v0.7.1: el token se generaba en cada arranque, así que tras
    /// actualizar el panel ya abierto mandaba el viejo y se quedaba fuera del
    /// monedero. El token debe sobrevivir a un reinicio.
    #[test]
    fn token_survives_a_restart() {
        let home = tmp_home("restart");
        let first = load_or_create_token_in(&home, 8645).unwrap();
        assert!(token_is_valid(&first));
        // Segundo arranque del monedero: mismo usuario, mismo puerto.
        let second = load_or_create_token_in(&home, 8645).unwrap();
        assert_eq!(first, second, "el token del panel debe sobrevivir a un reinicio");
        // Y una tercera vez, por si acaso (una actualización más).
        assert_eq!(first, load_or_create_token_in(&home, 8645).unwrap());
        // Cada puerto tiene el suyo: dos monederos a la vez no se pisan.
        assert_ne!(first, load_or_create_token_in(&home, 8646).unwrap());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Un archivo de token ilegible o a medias no deja al usuario fuera: se
    /// sustituye por uno nuevo, que a partir de ahí ya es estable.
    #[test]
    fn corrupt_token_file_is_replaced() {
        let home = tmp_home("corrupt");
        let p = token_file(&home, 8645);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "esto-no-es-un-token").unwrap();
        let t = load_or_create_token_in(&home, 8645).unwrap();
        assert!(token_is_valid(&t));
        assert_eq!(t, load_or_create_token_in(&home, 8645).unwrap());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Reutilizar el token no puede costar privacidad: el archivo sigue siendo
    /// solo para su dueño.
    #[cfg(unix)]
    #[test]
    fn reused_token_file_stays_private() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp_home("perms");
        let p = token_file(&home, 8645);
        load_or_create_token_in(&home, 8645).unwrap();
        // Alguien deja el archivo legible por todos (una copia, un backup).
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        load_or_create_token_in(&home, 8645).unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "otros usuarios no deben poder leer el token");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn bounded_line_rejects_long_input() {
        let long = "x".repeat(MAX_LINE + 10);
        let mut r = BufReader::new(std::io::Cursor::new(format!("{long}\n")));
        assert!(read_line_bounded(&mut r).is_err());
        let mut r = BufReader::new(std::io::Cursor::new("GET / HTTP/1.1\r\n".to_string()));
        assert_eq!(read_line_bounded(&mut r).unwrap().unwrap().trim_end(), "GET / HTTP/1.1");
    }
}
