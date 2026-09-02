//! Prueba de extremo a extremo del auto-actualizador (solo Linux/AppImage).
//!
//! Levanta un servidor HTTP local que imita el Release de GitHub y comprueba:
//!   1. `check()` detecta la versión nueva y extrae el SHA-256 correcto.
//!   2. `apply()` descarga, VERIFICA el hash y reemplaza el AppImage destino.
//!   3. Si el hash NO coincide, `apply()` aborta y NO toca el archivo destino.
//!
//! Es la garantía de que nunca aplicamos un binario cuyo hash no cuadra.

#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc::channel;
use std::thread;

use sha2::{Digest, Sha256};

const ASSET: &[u8] = b"#!/bin/sh\n# AppImage falso vNUEVA para la prueba del actualizador\n";

fn sha_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Arranca el servidor de mentira; devuelve la URL base (http://127.0.0.1:PORT).
fn start_server(good_hash: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let base = format!("http://127.0.0.1:{port}");

    let asset_url = format!("{base}/asset");
    let sums_url = format!("{base}/sums");
    let release = format!(
        r#"{{"tag_name":"v9.9.9","html_url":"{base}/rel",
        "assets":[
          {{"name":"RAMI-Chain-v9.9.9-x86_64.AppImage","browser_download_url":"{asset_url}","size":{}}},
          {{"name":"RAMI-Chain-v9.9.9-macos-arm64.dmg","browser_download_url":"{asset_url}","size":1}},
          {{"name":"SHA256SUMS.txt","browser_download_url":"{sums_url}","size":1}}
        ]}}"#,
        ASSET.len()
    );
    let hash = if good_hash { sha_hex(ASSET) } else { "0".repeat(64) };
    let sums = format!(
        "{hash}  RAMI-Chain-v9.9.9-x86_64.AppImage\n{}  RAMI-Chain-v9.9.9-macos-arm64.dmg\n",
        "0".repeat(64)
    );

    // Señala que ya escucha antes de devolver el control.
    let (ready_tx, ready_rx) = channel();
    thread::spawn(move || {
        ready_tx.send(()).ok();
        for stream in listener.incoming().flatten() {
            let release = release.clone();
            let sums = sums.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                // Drena cabeceras.
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h.trim().is_empty() {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let port = stream.local_addr().map(|a| a.port()).unwrap_or(0);
                // Emula también github.com/…/releases/latest (302 → tag) y las
                // URLs de descarga deterministas …/releases/download/<tag>/<name>.
                let mut status = "200 OK";
                let mut extra = String::new();
                let (ctype, body): (&str, Vec<u8>) = if path.ends_with("/release") {
                    ("application/json", release.into_bytes())
                } else if path.ends_with("/latest") {
                    status = "302 Found";
                    extra = format!("Location: http://127.0.0.1:{port}/o/r/releases/tag/v9.9.9\r\n");
                    ("text/plain", Vec::new())
                } else if path.ends_with("/sums") || path.ends_with("SHA256SUMS.txt") {
                    ("text/plain", sums.into_bytes())
                } else if path.ends_with("/asset") || path.ends_with(".AppImage") {
                    ("application/octet-stream", ASSET.to_vec())
                } else {
                    status = "404 Not Found";
                    ("text/plain", b"not found".to_vec())
                };
                let mut s = stream;
                let head = format!(
                    "HTTP/1.1 {status}\r\n{extra}Content-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(head.as_bytes());
                let _ = s.write_all(&body);
                let _ = s.flush();
            });
        }
    });
    ready_rx.recv().unwrap();
    base
}

// Los tests comparten variables de entorno de proceso, así que van en uno solo.
#[test]
fn check_and_apply_verify_sha256() {
    let tmp = std::env::temp_dir().join(format!("rami-upd-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();

    // ---- 1) check(): detecta la versión nueva y su hash ----
    let base = start_server(true);
    std::env::set_var("RAMI_UPDATE_RELEASE_URL", format!("{base}/release"));
    let info = rami_node::update::check("0.4.0").expect("check debe funcionar");
    assert_eq!(info.latest, "9.9.9");
    assert!(info.newer, "9.9.9 es más nueva que 0.4.0");
    assert!(info.asset_name.ends_with("x86_64.AppImage"));
    assert_eq!(info.sha256, sha_hex(ASSET), "el hash debe salir de SHA256SUMS.txt");

    // ---- 2) apply(): descarga, verifica y reemplaza el AppImage ----
    let target = tmp.join("RAMI.AppImage");
    std::fs::write(&target, b"binario VIEJO").unwrap();
    std::env::set_var("APPIMAGE", &target);
    let r = rami_node::update::apply("0.4.0");
    assert!(r.ok, "apply con hash correcto debe tener éxito: {}", r.message);
    assert!(r.needs_restart);
    assert_eq!(std::fs::read(&target).unwrap(), ASSET, "el destino debe ser el binario NUEVO");

    // ---- 3) hash que NO coincide: aborta y NO toca el destino ----
    let base_bad = start_server(false);
    std::env::set_var("RAMI_UPDATE_RELEASE_URL", format!("{base_bad}/release"));
    std::fs::write(&target, b"binario VIEJO").unwrap();
    let r = rami_node::update::apply("0.4.0");
    assert!(!r.ok, "apply con hash incorrecto debe fallar");
    assert!(r.message.contains("coincide"), "mensaje debe explicar el fallo de hash: {}", r.message);
    assert_eq!(std::fs::read(&target).unwrap(), b"binario VIEJO", "el destino NO debe cambiar");

    // ---- 4) API caída: se usa la redirección «releases/latest» (sin API) ----
    std::env::set_var("RAMI_UPDATE_RELEASE_URL", "http://127.0.0.1:9/inalcanzable");
    std::env::set_var("RAMI_UPDATE_LATEST_URL", format!("{base}/latest"));
    std::env::set_var("RAMI_WEB_URL", ""); // sin espejo web: la redirección debe bastar
    let info = rami_node::update::check("0.4.0").expect("la redirección debe bastar");
    assert_eq!(info.latest, "9.9.9");
    assert!(info.newer);
    assert_eq!(info.asset_name, "RAMI-Chain-v9.9.9-x86_64.AppImage");
    assert_eq!(info.sha256, sha_hex(ASSET), "el hash sale del SHA256SUMS.txt del tag");
    std::fs::write(&target, b"binario VIEJO").unwrap();
    let r = rami_node::update::apply("0.4.0");
    assert!(r.ok, "apply vía redirección: {}", r.message);
    assert_eq!(std::fs::read(&target).unwrap(), ASSET);

    // Limpieza y evitar fugas de entorno a otros tests del binario.
    for k in ["APPIMAGE", "RAMI_UPDATE_RELEASE_URL", "RAMI_UPDATE_LATEST_URL", "RAMI_WEB_URL"] {
        std::env::remove_var(k);
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
