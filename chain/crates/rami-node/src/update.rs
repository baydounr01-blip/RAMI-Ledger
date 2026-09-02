//! Auto-actualizador del monedero de escritorio.
//!
//! El monedero comprueba si hay una versión más nueva publicada en el Release
//! oficial de GitHub y, si el usuario lo pide, DESCARGA el instalador oficial,
//! **verifica su SHA-256** contra `SHA256SUMS.txt` (publicado en el mismo
//! Release) ANTES de tocar nada, y solo entonces lo aplica.
//!
//! Propiedad de seguridad clave: nunca ejecutamos ni sobrescribimos nada cuyo
//! hash no coincida exactamente con el publicado. Si falta el hash o no cuadra,
//! se aborta. La descarga va por HTTPS (TLS con rustls). En macOS/Windows el
//! instalador descargado, cuando esté firmado, sigue pasando el filtro del
//! sistema operativo al ejecutarse: NO nos saltamos ninguna comprobación.
//!
//! Testnet experimental, sin valor monetario.

use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
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

/// Página web oficial del proyecto (sin barra final). La web publica en
/// `/descargas/latest.json` un espejo del release (mismos nombres de archivo,
/// servidos desde el propio dominio de la web), así que el monedero queda
/// «anclado» a la página: si la API de GitHub no responde, se usa la web.
/// Se puede sobrescribir con `RAMI_WEB_URL`.
const DEFAULT_WEB_URL: &str = "https://quantbot.army";

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
}

/// Resultado de aplicar la actualización.
#[derive(Serialize, Clone, Default)]
pub struct ApplyResult {
    pub ok: bool,
    pub stage: String,
    pub needs_restart: bool,
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
fn save_dir() -> PathBuf {
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(h) = std::env::var(var) {
            let d = PathBuf::from(&h).join("Downloads");
            if d.is_dir() {
                return d;
            }
        }
    }
    std::env::temp_dir()
}

/// Descarga, VERIFICA el SHA-256 y aplica la actualización.
///
/// - Linux (AppImage): reemplaza el propio ejecutable de forma atómica; basta
///   con reiniciar el monedero.
/// - macOS (.dmg) / Windows (.exe): guarda el instalador **verificado** y lo
///   abre; el instalador firmado del sistema completa la instalación (y pasa el
///   filtro de Gatekeeper/SmartScreen al ejecutarse).
pub fn apply(current: &str) -> ApplyResult {
    match apply_inner(current) {
        Ok(r) => r,
        Err(message) => ApplyResult { ok: false, stage: "error".into(), needs_restart: false, message },
    }
}

fn apply_inner(current: &str) -> Result<ApplyResult, String> {
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

    match platform() {
        "linux" => apply_linux(&bytes),
        "macos-arm64" | "macos-x64" => apply_open(&bytes, &info.asset_name, "macOS"),
        "windows" => apply_open(&bytes, &info.asset_name, "Windows"),
        _ => Err("plataforma no soportada".into()),
    }
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}
#[cfg(not(unix))]
fn make_executable(_path: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

/// AppImage: escribe el nuevo binario junto al actual y lo renombra encima
/// (atómico en el mismo sistema de archivos). Reiniciar aplica la versión nueva.
fn apply_linux(bytes: &[u8]) -> Result<ApplyResult, String> {
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
    Ok(ApplyResult {
        ok: true,
        stage: "installed".into(),
        needs_restart: true,
        message: "Actualización aplicada. Cierra y vuelve a abrir el monedero para usar la nueva versión.".into(),
    })
}

/// macOS/Windows: guarda el instalador verificado, lo abre y CIERRA esta app
/// tras unos segundos — con la app vieja viva, el instalador no puede
/// reemplazar el ejecutable en uso y la versión nueva no podría abrir el panel.
fn apply_open(bytes: &[u8], asset_name: &str, os: &str) -> Result<ApplyResult, String> {
    let path = save_dir().join(asset_name);
    std::fs::write(&path, bytes).map_err(|e| format!("no pude guardar el instalador: {e}"))?;
    let spawned = if cfg!(target_os = "macos") {
        // El .dmg no necesita permisos de ejecución; `open` lo monta.
        Command::new("open").arg(&path).spawn()
    } else {
        // Windows: ejecuta el instalador .exe (verificado).
        Command::new(&path).spawn()
    };
    spawned.map_err(|e| format!("descargado y verificado, pero no pude abrir el instalador: {e}"))?;
    // Salida limpia diferida: da tiempo a que la respuesta HTTP llegue al panel.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        std::process::exit(0);
    });
    Ok(ApplyResult {
        ok: true,
        stage: "downloaded".into(),
        needs_restart: true,
        message: format!(
            "Instalador verificado y abierto ({os}). Este monedero se cerrará ahora para que el \
             instalador pueda reemplazarlo; sigue sus pasos y vuelve a abrir la app. \
             (Instalador guardado en {})",
            path.display()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_compares_semver() {
        assert!(is_newer("0.4.1", "0.4.0"));
        assert!(is_newer("v0.5.0", "0.4.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
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
