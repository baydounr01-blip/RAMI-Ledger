//! Servidor HTTP/1.1 mínimo (solo `std`) para el panel LOCAL del monedero.
//!
//! Escucha solo en 127.0.0.1: es la interfaz de una app de escritorio, no un
//! servicio público. Un hilo por conexión, `Connection: close`. Sin dependencias.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Vec<u8>,
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

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    }
}

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

fn handle_conn<F>(stream: TcpStream, handler: Arc<F>) -> std::io::Result<()>
where
    F: Fn(Request) -> Response,
{
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    let mut parts = line.trim_end().split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };

    // Cabeceras: solo nos interesa Content-Length.
    let mut content_length = 0usize;
    loop {
        let mut hl = String::new();
        if reader.read_line(&mut hl)? == 0 {
            break;
        }
        let t = hl.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    // Cota anti-abuso (panel local, cuerpos pequeños).
    content_length = content_length.min(1 << 20);
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    let resp = handler(Request { method, path, query, body });

    let mut w = stream;
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
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
