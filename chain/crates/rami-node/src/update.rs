//! Auto-actualizador del monedero de escritorio.
//!
//! El monedero comprueba si hay una versión más nueva publicada en el Release
//! oficial de GitHub y, si el usuario lo pide, DESCARGA el instalador oficial,
//! **verifica su SHA-256** contra `SHA256SUMS.txt` (publicado en el mismo
//! Release) ANTES de tocar nada, y solo entonces lo aplica.
//!
//! Propiedad de seguridad clave: nunca ejecutamos ni sobrescribimos nada cuyo
//! hash no coincida exactamente con el publicado. Si falta el hash o no cuadra,
//! se aborta. La descarga va por HTTPS (TLS con rustls).
//!
//! Desde v0.5.2 la actualización es de UN clic en los tres sistemas: se
//! instala la versión nueva en el sitio de la actual (macOS: se copia la app
//! del .dmg verificado sobre el bundle instalado; Windows: el instalador
//! oficial en modo silencioso; Linux: el AppImage se reemplaza de forma
//! atómica), el monedero se cierra y **se vuelve a abrir solo** con la versión
//! nueva. No se salta ninguna comprobación del sistema: es el mismo esquema que
//! usan los actualizadores de escritorio habituales (verificación criptográfica
//! del paquete y sustitución de una app que el usuario ya había instalado).
//!
//! Testnet experimental, sin valor monetario.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Release oficial (API de GitHub). Se puede sobrescribir con
/// `RAMI_UPDATE_RELEASE_URL` (solo para pruebas locales del actualizador).
const DEFAULT_RELEASE_URL: &str =
    "https://api.github.com/repos/baydounr01-blip/RAMI-Ledger/releases/latest";

/// Tope de descarga del instalador (64 MiB): los instaladores reales pesan
/// pocos MB; esto acota un servidor malicioso o un archivo corrupto enorme.
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

/// Tope de las notas del release que se muestran en el panel.
const MAX_NOTES_CHARS: usize = 6000;

/// Página web oficial del proyecto (sin barra final). La web publica en
/// `/descargas/latest.json` un espejo del release (mismos nombres de archivo,
/// servidos desde el propio dominio de la web), así que el monedero queda
/// «anclado» a la página: si la API de GitHub no responde, se usa la web.
/// Se puede sobrescribir con `RAMI_WEB_URL`.
const DEFAULT_WEB_URL: &str = "https://quantbot.army";

/// Nombre del bundle de macOS que publica release.yml / package.sh.
#[allow(dead_code)]
const MAC_APP_NAME: &str = "RAMI-Chain.app";

fn release_url() -> String {
    std::env::var("RAMI_UPDATE_RELEASE_URL").unwrap_or_else(|_| DEFAULT_RELEASE_URL.to_string())
}

fn web_base() -> Option<String> {
    let v = std::env::var("RAMI_WEB_URL").unwrap_or_else(|_| DEFAULT_WEB_URL.to_string());
    let v = v.trim().trim_end_matches('/').to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

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

/// Caja negra compartida con la app de escritorio (`~/.rami/gui-launch.log`):
/// cada paso de la actualización queda registrado para poder diagnosticar un
/// fallo aunque la app se haya cerrado y no haya terminal.
fn ulog(msg: &str) {
    let line = format!("[{} pid {}] update: {msg}\n", crate::now_secs(), std::process::id());
    eprint!("{line}");
    if let Some(h) = home_dir() {
        let p = h.join(".rami").join("gui-launch.log");
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Información de la comprobación de actualización (lo que ve el panel).
#[derive(Serialize, Clone, Default)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub platform: String,
    pub asset_name: String,
    /// URL del instalador; no se expone al navegador.
    #[serde(skip_serializing)]
    pub asset_url: String,
    pub sha256: String,
    pub supported: bool,
    pub html_url: String,
    pub note: String,
    /// Notas del release («Novedades»), texto plano/markdown tal cual se
    /// publicó; vacío si la fuente consultada no las incluye.
    pub notes: String,
    /// Fecha de publicación (ISO 8601) si la fuente la incluye.
    pub published: String,
}

/// Resultado de aplicar la actualización.
#[derive(Serialize, Clone, Default)]
pub struct ApplyResult {
    pub ok: bool,
    pub stage: String,
    pub needs_restart: bool,
    /// true: este proceso se cerrará en unos segundos y la versión nueva se
    /// abrirá sola (el panel puede esperar y recargarse).
    pub relaunch: bool,
    /// Versión que se ha instalado (para que el panel sepa a qué esperar).
    pub new_version: String,
    pub message: String,
}

/// Plataforma en tiempo de ejecución (para elegir el instalador correcto).
pub fn platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "macos-arm64"
        } else {
            "macos-x64"
        }
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unsupported"
    }
}

/// Sufijo del nombre del instalador para esta plataforma (o None si no hay
/// build empaquetado). Coincide con los nombres que publica release.yml:
/// `RAMI-Chain-vX.Y.Z-<sufijo>`.
fn asset_suffix() -> Option<&'static str> {
    match platform() {
        "linux" => Some("x86_64.AppImage"),
        "macos-arm64" => Some("macos-arm64.dmg"),
        "macos-x64" => Some("macos-x64.dmg"),
        "windows" => Some("setup.exe"),
        _ => None,
    }
}

/// Quita una 'v' inicial de la versión (`v0.4.1` -> `0.4.1`).
fn norm(v: &str) -> String {
    v.trim().trim_start_matches('v').trim().to_string()
}

/// ¿`latest` es estrictamente más nueva que `current`? Comparación semver por
/// componentes numéricos; lo no numérico se trata como 0.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let pa: Vec<u64> = norm(latest).split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let pb: Vec<u64> = norm(current).split('.').map(|x| x.parse().unwrap_or(0)).collect();
    let n = pa.len().max(pb.len());
    for i in 0..n {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x > y {
            return true;
        }
        if x < y {
            return false;
        }
    }
    false
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout(Duration::from_secs(120))
        .build()
}

/// Página «releases/latest» de GitHub (SIN pasar por la API): responde 302 con
/// `Location: …/releases/tag/vX.Y.Z`. No cuenta para el límite de la API
/// (60 peticiones/hora por IP sin autenticar — fácil de agotar detrás de un
/// NAT compartido), y los nombres de los instaladores son deterministas.
/// Sobrescribible con `RAMI_UPDATE_LATEST_URL` (pruebas).
const DEFAULT_LATEST_URL: &str = "https://github.com/baydounr01-blip/RAMI-Ledger/releases/latest";

fn latest_url() -> String {
    std::env::var("RAMI_UPDATE_LATEST_URL").unwrap_or_else(|_| DEFAULT_LATEST_URL.to_string())
}

fn latest_via_redirect() -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
        .build();
    let resp = match agent.get(&latest_url()).set("User-Agent", "RAMI-Chain-Wallet").call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) if (300..400).contains(&code) => r,
        Err(e) => return Err(format!("no se pudo conectar: {e}")),
    };
    let loc = resp.header("Location").ok_or("sin redirección a la última versión")?.to_string();
    let (prefix, tag) = loc.rsplit_once("/releases/tag/").ok_or("redirección inesperada")?;
    let tag = tag.trim_end_matches('/').to_string();
    if tag.is_empty() {
        return Err("etiqueta vacía en la redirección".into());
    }
    let names = [
        format!("RAMI-Chain-{tag}-x86_64.AppImage"),
        format!("RAMI-Chain-{tag}-macos-arm64.dmg"),
        format!("RAMI-Chain-{tag}-macos-x64.dmg"),
        format!("RAMI-Chain-{tag}-setup.exe"),
        "SHA256SUMS.txt".to_string(),
    ];
    let assets: Vec<serde_json::Value> = names
        .iter()
        .map(|n| {
            serde_json::json!({
                "name": n,
                "browser_download_url": format!("{prefix}/releases/download/{tag}/{n}"),
            })
        })
        .collect();
    Ok(serde_json::json!({ "tag_name": tag, "html_url": loc, "assets": assets }))
}

/// Descripción del último release, probando fuentes en orden hasta que una
/// responda: (1) API de GitHub (canónica); (2) redirección de github.com (sin
/// límite de API); (3) espejo de la web del proyecto (`descargas/latest.json`,
/// misma forma de JSON, mismos hashes). Así la actualización queda anclada a
/// la página web y no depende de una sola vía.
fn fetch_release_json() -> Result<serde_json::Value, String> {
    let mut errs: Vec<String> = Vec::new();
    match http_get_text(&release_url()) {
        Ok(t) => match serde_json::from_str::<serde_json::Value>(&t) {
            Ok(v) if v.get("tag_name").is_some() => return Ok(v),
            Ok(_) => errs.push("API: respuesta sin tag_name".into()),
            Err(e) => errs.push(format!("API: no es JSON: {e}")),
        },
        Err(e) => errs.push(format!("API: {e}")),
    }
    match latest_via_redirect() {
        Ok(v) => return Ok(v),
        Err(e) => errs.push(format!("redirección: {e}")),
    }
    if let Some(w) = web_base() {
        match http_get_text(&format!("{w}/descargas/latest.json")) {
            Ok(t) => match serde_json::from_str::<serde_json::Value>(&t) {
                Ok(v) if v.get("tag_name").is_some() => return Ok(v),
                _ => errs.push("espejo web: JSON inválido".into()),
            },
            Err(e) => errs.push(format!("espejo web: {e}")),
        }
    }
    Err(errs.join(" | "))
}

fn http_get_text(url: &str) -> Result<String, String> {
    agent()
        .get(url)
        .set("User-Agent", "RAMI-Chain-Wallet")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("no se pudo conectar: {e}"))?
        .into_string()
        .map_err(|e| format!("respuesta ilegible: {e}"))
}

fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = agent()
        .get(url)
        .set("User-Agent", "RAMI-Chain-Wallet")
        .call()
        .map_err(|e| format!("no se pudo descargar: {e}"))?;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_ASSET_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("descarga interrumpida: {e}"))?;
    if buf.len() as u64 > MAX_ASSET_BYTES {
        return Err("el instalador es demasiado grande (posible archivo malicioso)".into());
    }
    Ok(buf)
}

/// Extrae el hash de `SHA256SUMS.txt` (salida de `sha256sum`) para un archivo.
fn sha_for(sums: &str, asset_name: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Formato: "<hash>  <nombre>"; el nombre puede llevar prefijo '*'.
        let mut it = line.split_whitespace();
        let hash = it.next()?;
        let name = it.last()?.trim_start_matches('*');
        if name == asset_name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(hash.to_lowercase());
        }
    }
    None
}

/// Comprueba el Release oficial y devuelve qué instalador aplicaría y su hash.
pub fn check(current: &str) -> Result<UpdateInfo, String> {
    let suffix = asset_suffix();
    let mut info = UpdateInfo {
        current: norm(current),
        platform: platform().to_string(),
        supported: suffix.is_some(),
        ..Default::default()
    };

    let v = fetch_release_json()?;
    let tag = v.get("tag_name").and_then(|t| t.as_str()).ok_or("el Release no tiene tag")?;
    info.latest = norm(tag);
    info.html_url = v.get("html_url").and_then(|t| t.as_str()).unwrap_or("").to_string();
    info.newer = is_newer(&info.latest, &info.current);
    info.published = v.get("published_at").and_then(|t| t.as_str()).unwrap_or("").to_string();
    if let Some(body) = v.get("body").and_then(|b| b.as_str()) {
        info.notes = body.chars().take(MAX_NOTES_CHARS).collect::<String>().trim().to_string();
    }

    let assets = v.get("assets").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let mut sums_url = String::new();
    for a in &assets {
        let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let url = a.get("browser_download_url").and_then(|n| n.as_str()).unwrap_or("");
        if name == "SHA256SUMS.txt" {
            sums_url = url.to_string();
        }
        if let Some(suf) = suffix {
            if name.ends_with(suf) {
                info.asset_name = name.to_string();
                info.asset_url = url.to_string();
            }
        }
    }

    // Solo tiene sentido buscar el hash si hay instalador para esta plataforma.
    if !info.asset_name.is_empty() {
        if sums_url.is_empty() {
            info.note = "el Release no publica SHA256SUMS.txt; no puedo verificar la descarga".into();
        } else if let Ok(sums) = http_get_text(&sums_url) {
            match sha_for(&sums, &info.asset_name) {
                Some(h) => info.sha256 = h,
                None => info.note = "no encuentro el hash del instalador en SHA256SUMS.txt".into(),
            }
        } else {
            info.note = "no pude descargar SHA256SUMS.txt para verificar".into();
        }
    } else if info.supported {
        info.note = "el Release no incluye un instalador para tu sistema".into();
    } else {
        info.note = "plataforma sin instalador empaquetado; actualiza desde el código".into();
    }

    Ok(info)
}

/// Directorio donde guardar el instalador descargado (macOS/Windows).
#[allow(dead_code)]
fn save_dir() -> PathBuf {
    if let Some(h) = home_dir() {
        let d = h.join("Downloads");
        if d.is_dir() {
            return d;
        }
    }
    std::env::temp_dir()
}

/// Descarga, VERIFICA el SHA-256 e instala la actualización SIN reabrir la
/// app ni cerrar este proceso (pruebas y uso desde scripts). El monedero de
/// escritorio usa [`apply_and_relaunch`].
pub fn apply(current: &str) -> ApplyResult {
    apply_with(current, false)
}

/// Descarga, VERIFICA el SHA-256, instala la versión nueva, programa su
/// reapertura automática y cierra este proceso en unos segundos (tiempo para
/// que la respuesta llegue al panel). Es la actualización «de un clic».
pub fn apply_and_relaunch(current: &str) -> ApplyResult {
    apply_with(current, true)
}

fn apply_with(current: &str, relaunch: bool) -> ApplyResult {
    match apply_inner(current, relaunch) {
        Ok(r) => {
            ulog(&format!("{}: {}", r.stage, r.message));
            r
        }
        Err(message) => {
            ulog(&format!("ERROR: {message}"));
            ApplyResult { ok: false, stage: "error".into(), message, ..Default::default() }
        }
    }
}

fn apply_inner(current: &str, relaunch: bool) -> Result<ApplyResult, String> {
    // Re-comprueba en el momento de aplicar (no confíes en un estado viejo).
    let info = check(current)?;
    if !info.supported {
        return Err("tu sistema no tiene un instalador empaquetado".into());
    }
    if !info.newer {
        return Err("ya tienes la última versión".into());
    }
    if info.asset_url.is_empty() {
        return Err("el Release no incluye un instalador para tu sistema".into());
    }
    if info.sha256.is_empty() {
        return Err("no puedo verificar la descarga (falta el hash SHA-256): se aborta".into());
    }
    ulog(&format!("v{} → v{}: descargando {}", info.current, info.latest, info.asset_name));

    // Descarga y VERIFICA antes de tocar nada.
    let bytes = http_get_bytes(&info.asset_url)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let got = hex::encode(hasher.finalize());
    if !got.eq_ignore_ascii_case(&info.sha256) {
        return Err(format!(
            "el SHA-256 NO coincide (esperado {}, obtenido {}): descarga rechazada",
            &info.sha256[..16.min(info.sha256.len())],
            &got[..16]
        ));
    }
    ulog(&format!("SHA-256 verificado ({} bytes)", bytes.len()));

    let mut r = match platform() {
        "linux" => apply_linux(&bytes, relaunch)?,
        "macos-arm64" | "macos-x64" => apply_macos(&bytes, &info.asset_name, relaunch)?,
        "windows" => apply_windows(&bytes, &info.asset_name, relaunch)?,
        _ => return Err("plataforma no soportada".into()),
    };
    r.new_version = info.latest.clone();
    if r.relaunch {
        exit_soon();
    }
    Ok(r)
}

/// Salida limpia diferida: da tiempo a que la respuesta HTTP llegue al panel.
fn exit_soon() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(2500));
        ulog("cerrando este proceso para dejar paso a la versión nueva");
        std::process::exit(0);
    });
}

#[allow(dead_code)]
fn run(cmd: &mut Command, what: &str) -> Result<String, String> {
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{what}: no se pudo ejecutar: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{what}: falló ({}): {}", out.status, err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}
#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Unix: proceso auxiliar desacoplado que espera a que ESTE proceso termine y
/// entonces abre la versión nueva. Así la app nueva nunca encuentra el puerto
/// del panel ocupado por la vieja (que la haría salir creyendo que ya hay un
/// monedero abierto).
fn spawn_relauncher_unix(open_cmd: &str, target: &Path) -> Result<(), String> {
    // Se conservan los argumentos con los que se abrió esta instancia
    // (--network, --port, --chain…): la versión nueva arranca igual que la vieja.
    let user_args: Vec<String> = std::env::args().skip(1).collect();
    let pass_args = if user_args.is_empty() {
        ""
    } else if open_cmd.is_empty() {
        " \"$@\""
    } else {
        " --args \"$@\"" // `open <app> --args …` en macOS
    };
    let script = format!(
        "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; sleep 0.3; t=\"$2\"; shift 2; exec {open_cmd} \"$t\"{pass_args}"
    );
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("rami-relaunch")
        .arg(std::process::id().to_string())
        .arg(target)
        .args(&user_args)
        // Sin herencia del entorno del AppImage/bundle viejo.
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env_remove("ARGV0")
        .env_remove("OWD")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("no pude programar la reapertura: {e}"))
}

/// AppImage: escribe el nuevo binario junto al actual y lo renombra encima
/// (atómico en el mismo sistema de archivos). Con `relaunch`, la versión
/// nueva se abre sola al cerrarse esta.
fn apply_linux(bytes: &[u8], relaunch: bool) -> Result<ApplyResult, String> {
    let target = std::env::var("APPIMAGE")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .ok_or("no sé qué archivo reemplazar")?;
    let tmp = target.with_extension("new");
    std::fs::write(&tmp, bytes).map_err(|e| format!("no pude escribir el archivo nuevo: {e}"))?;
    make_executable(&tmp).map_err(|e| format!("no pude dar permisos: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("no pude sustituir el ejecutable: {e}")
    })?;
    ulog(&format!("AppImage sustituido: {}", target.display()));
    let mut relaunched = false;
    if relaunch {
        relaunched = spawn_relauncher_unix("", &target).map(|_| true).unwrap_or_else(|e| {
            ulog(&e);
            false
        });
    }
    Ok(ApplyResult {
        ok: true,
        stage: "installed".into(),
        needs_restart: true,
        relaunch: relaunched,
        message: if relaunched {
            "Actualización instalada. El monedero se cierra y se vuelve a abrir solo con la versión nueva.".into()
        } else {
            "Actualización aplicada. Cierra y vuelve a abrir el monedero para usar la nueva versión.".into()
        },
        ..Default::default()
    })
}

/// macOS: bundle `.app` que contiene a este ejecutable, si está instalado en
/// un sitio «de verdad» (no dentro del .dmg montado ni en la cuarentena de
/// traslocación de macOS, donde no se puede/debe escribir).
#[cfg(target_os = "macos")]
fn installed_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut p: &Path = &exe;
    while let Some(parent) = p.parent() {
        if parent.extension().and_then(|e| e.to_str()) == Some("app") {
            let s = parent.to_string_lossy();
            if s.starts_with("/Volumes/") || s.contains("/AppTranslocation/") {
                return None;
            }
            return Some(parent.to_path_buf());
        }
        p = parent;
    }
    None
}

/// macOS: instala la app del `.dmg` VERIFICADO en el sitio de la actual (o en
/// Aplicaciones si la actual no está instalada) y la reabre.
#[cfg(target_os = "macos")]
fn apply_macos(bytes: &[u8], asset_name: &str, relaunch: bool) -> Result<ApplyResult, String> {
    let dmg = save_dir().join(asset_name);
    std::fs::write(&dmg, bytes).map_err(|e| format!("no pude guardar el instalador: {e}"))?;

    // Destinos por orden: el bundle en uso; /Applications; ~/Applications.
    let mut dests: Vec<PathBuf> = Vec::new();
    if let Some(b) = installed_bundle() {
        dests.push(b);
    }
    dests.push(PathBuf::from("/Applications").join(MAC_APP_NAME));
    if let Some(h) = home_dir() {
        dests.push(h.join("Applications").join(MAC_APP_NAME));
    }

    // Monta el .dmg en un punto conocido (sin abrir ventana del Finder).
    let mnt = std::env::temp_dir().join(format!("rami-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&mnt);
    std::fs::create_dir_all(&mnt).map_err(|e| format!("no pude crear el punto de montaje: {e}"))?;
    run(
        Command::new("hdiutil")
            .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"])
            .arg(&mnt)
            .arg(&dmg),
        "montar el .dmg",
    )?;
    let result = install_from_mounted_dmg(&mnt, &dests);
    let _ = Command::new("hdiutil").args(["detach", "-force"]).arg(&mnt).stdin(Stdio::null()).output();
    let _ = std::fs::remove_dir(&mnt);

    let dest = match result {
        Ok(d) => d,
        Err(e) => {
            // Último recurso: deja el .dmg verificado abierto para que el
            // usuario arrastre la app a Aplicaciones (el método clásico).
            ulog(&format!("instalación automática fallida: {e}; abro el .dmg"));
            let _ = Command::new("open").arg(&dmg).stdin(Stdio::null()).spawn();
            return Ok(ApplyResult {
                ok: true,
                stage: "downloaded".into(),
                needs_restart: true,
                relaunch: false,
                message: format!(
                    "No pude instalar la app automáticamente ({e}). He abierto el instalador verificado: \
                     arrastra RAMI-Chain a Aplicaciones (sustituye la actual), cierra este monedero con \
                     «Salir» y vuelve a abrir la app. (Instalador guardado en {})",
                    dmg.display()
                ),
                ..Default::default()
            });
        }
    };
    let _ = std::fs::remove_file(&dmg);
    ulog(&format!("app instalada en {}", dest.display()));

    let mut relaunched = false;
    if relaunch {
        relaunched = spawn_relauncher_unix("open", &dest).map(|_| true).unwrap_or_else(|e| {
            ulog(&e);
            false
        });
    }
    Ok(ApplyResult {
        ok: true,
        stage: "installed".into(),
        needs_restart: true,
        relaunch: relaunched,
        message: if relaunched {
            format!(
                "Versión nueva instalada en {}. El monedero se cierra y se vuelve a abrir solo.",
                dest.display()
            )
        } else {
            format!("Versión nueva instalada en {}. Cierra este monedero y vuelve a abrir la app.", dest.display())
        },
        ..Default::default()
    })
}

/// macOS: copia la app del .dmg montado al primer destino donde se pueda,
/// con verificación de la firma del bundle copiado y vuelta atrás si falla.
#[cfg(target_os = "macos")]
fn install_from_mounted_dmg(mnt: &Path, dests: &[PathBuf]) -> Result<PathBuf, String> {
    let src = std::fs::read_dir(mnt)
        .map_err(|e| format!("no pude leer el .dmg montado: {e}"))?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_dir() && p.extension().and_then(|e| e.to_str()) == Some("app"))
        .ok_or("el .dmg no contiene ninguna app")?;
    let mut errs: Vec<String> = Vec::new();
    for dest in dests {
        match install_bundle(&src, dest) {
            Ok(()) => return Ok(dest.clone()),
            Err(e) => errs.push(format!("{}: {e}", dest.display())),
        }
    }
    Err(errs.join(" | "))
}

#[cfg(target_os = "macos")]
fn install_bundle(src: &Path, dest: &Path) -> Result<(), String> {
    let parent = dest.parent().ok_or("destino sin carpeta")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("no pude crear la carpeta: {e}"))?;
    let staged = parent.join("RAMI-Chain.app.actualizando");
    let old = parent.join("RAMI-Chain.app.anterior");
    let _ = std::fs::remove_dir_all(&staged);
    // `ditto` conserva firma, atributos y permisos del bundle (lo que Apple
    // recomienda para copiar apps).
    run(Command::new("ditto").arg(src).arg(&staged), "copiar la app")?;
    if let Err(e) = run(Command::new("codesign").args(["--verify", "--deep", "--strict"]).arg(&staged), "verificar la firma") {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(e);
    }
    // Intercambio: la app en uso pasa a .anterior (el proceso vivo sigue
    // funcionando: macOS mantiene el ejecutable abierto), la nueva ocupa su sitio.
    let _ = std::fs::remove_dir_all(&old);
    let had_old = dest.exists();
    if had_old {
        std::fs::rename(dest, &old).map_err(|e| {
            let _ = std::fs::remove_dir_all(&staged);
            format!("no pude apartar la app actual: {e}")
        })?;
    }
    if let Err(e) = std::fs::rename(&staged, dest) {
        if had_old {
            let _ = std::fs::rename(&old, dest);
        }
        let _ = std::fs::remove_dir_all(&staged);
        return Err(format!("no pude colocar la app nueva: {e}"));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn apply_macos(_bytes: &[u8], _asset_name: &str, _relaunch: bool) -> Result<ApplyResult, String> {
    Err("no es macOS".into())
}

/// Windows: guarda el instalador oficial VERIFICADO y, tras cerrarse este
/// proceso, lo ejecuta en modo silencioso sobre la carpeta actual y vuelve a
/// abrir el monedero. Sin `relaunch`, solo deja el instalador descargado.
#[cfg(target_os = "windows")]
fn apply_windows(bytes: &[u8], asset_name: &str, relaunch: bool) -> Result<ApplyResult, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let setup = save_dir().join(asset_name);
    std::fs::write(&setup, bytes).map_err(|e| format!("no pude guardar el instalador: {e}"))?;
    if !relaunch {
        return Ok(ApplyResult {
            ok: true,
            stage: "downloaded".into(),
            needs_restart: true,
            message: format!("Instalador verificado guardado en {}. Ejecútalo para actualizar.", setup.display()),
            ..Default::default()
        });
    }
    let exe = std::env::current_exe().map_err(|e| format!("no sé dónde está el monedero: {e}"))?;
    let dir = exe.parent().ok_or("carpeta del monedero desconocida")?.to_path_buf();
    let ps = |p: &Path| p.to_string_lossy().replace('\'', "''");
    // Wait-Process: espera a que ESTE proceso termine (el instalador no puede
    // sustituir un .exe en uso). /S = instalación silenciosa de NSIS; /D= (sin
    // comillas, siempre el último) instala en la carpeta actual del monedero.
    // Se conservan los argumentos de esta instancia (p. ej. «--network testnet»
    // del acceso directo) para que la versión nueva arranque igual.
    let user_args: Vec<String> = std::env::args().skip(1).collect();
    let relaunch_args = if user_args.is_empty() {
        String::new()
    } else {
        let quoted: Vec<String> = user_args.iter().map(|a| format!("'{}'", a.replace('\'', "''"))).collect();
        format!(" -ArgumentList @({})", quoted.join(", "))
    };
    let script = format!(
        "Wait-Process -Id {pid} -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; \
         Start-Process -FilePath '{setup}' -ArgumentList @('/S', '/D={dir}') -Wait; \
         Start-Process -FilePath '{exe}'{relaunch_args}",
        pid = std::process::id(),
        setup = ps(&setup),
        dir = dir.to_string_lossy(),
        exe = ps(&exe),
    );
    Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("descargado y verificado, pero no pude programar la instalación: {e}"))?;
    Ok(ApplyResult {
        ok: true,
        stage: "installing".into(),
        needs_restart: true,
        relaunch: true,
        message: format!(
            "Instalador verificado. El monedero se cierra, se instala la versión nueva en {} y se vuelve a abrir solo.",
            dir.display()
        ),
        ..Default::default()
    })
}

#[cfg(not(target_os = "windows"))]
fn apply_windows(_bytes: &[u8], _asset_name: &str, _relaunch: bool) -> Result<ApplyResult, String> {
    Err("no es Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_compares_semver() {
        assert!(is_newer("0.4.1", "0.4.0"));
        assert!(is_newer("v0.5.0", "0.4.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("0.5.10", "0.5.2"));
        assert!(!is_newer("0.4.0", "0.4.0"));
        assert!(!is_newer("0.4.0", "0.4.1"));
        assert!(!is_newer("0.3.9", "0.4.0"));
    }

    #[test]
    fn parses_sha256sums() {
        let sums = "\
aaaa000000000000000000000000000000000000000000000000000000000000  RAMI-Chain-v0.4.1-x86_64.AppImage
bbbb000000000000000000000000000000000000000000000000000000000000  RAMI-Chain-v0.4.1-setup.exe
";
        assert_eq!(
            sha_for(sums, "RAMI-Chain-v0.4.1-x86_64.AppImage").as_deref(),
            Some("aaaa000000000000000000000000000000000000000000000000000000000000")
        );
        assert_eq!(sha_for(sums, "no-existe.dmg"), None);
    }

    #[test]
    fn platform_has_suffix_on_supported_targets() {
        // En los objetivos donde corren los tests (linux/macos/windows) siempre
        // hay un sufijo de instalador.
        if platform() != "unsupported" {
            assert!(asset_suffix().is_some());
        }
    }
}
