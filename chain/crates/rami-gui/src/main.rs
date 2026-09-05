//! rami-gui — monedero de escritorio de RAMI-Chain.
//!
//! Un solo binario que arranca tu NODO P2P (con minería opcional) y sirve un
//! PANEL local en el navegador, para hacerlo todo desde ahí: minar, enviar,
//! recibir, apostar y anclar predicciones. La CLI (`rami-node`, `rami-wallet`)
//! sigue disponible para usuarios avanzados.
//!
//!   rami-gui [--network testnet] [--chain DIR] [--port 8645] [--listen 30301]
//!            [--connect host:port]... [--label NOMBRE] [--no-open]
//!
//! Sin punto de fallo único: el panel es local; la red es P2P. TESTNET
//! experimental, sin valor monetario.

// En Windows la app se lanza con doble clic: sin ventana de consola (como
// Bitcoin Core). Los errores fatales se muestran en el navegador (fail_visible).
#![cfg_attr(windows, windows_subsystem = "windows")]

use rami_node::http;

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::sync::Arc;

use rami_core::crypto::{address_from_pubkey, KeyPair};
use rami_core::params::Params;
use rami_core::tx::{txid, Tx};

use rami_node::{spawn, NodeConfig, NodeHandle};
use rami_wallet::{
    build_claim_parcel, build_commit, build_harvest, build_list_lease, build_mint_asset, build_rent,
    build_reveal, build_stake, build_transfer, build_transfer_asset, default_keystore_path, fmt_ram,
    load_reveal, parse_pubkey, parse_ram, save_reveal, Keystore,
};

use http::{Request, Response};
use serde_json::{json, Value};

const DASHBOARD: &str = include_str!("dashboard.html");

/// Estado del monedero en memoria. `pubkey` se conoce aunque esté bloqueado
/// (para minar y ver saldo); `kp` solo está presente cuando se puede FIRMAR.
struct WalletState {
    pubkey: Option<[u8; 32]>,
    kp: Option<KeyPair>,
    encrypted: bool,
}

impl WalletState {
    fn state(&self) -> &'static str {
        match (self.pubkey.is_some(), self.encrypted, self.kp.is_some()) {
            (false, _, _) => "none",       // no hay monedero: hay que crear contraseña
            (true, false, _) => "plain",   // legado en texto plano (usable, sin cifrar)
            (true, true, true) => "unlocked",
            (true, true, false) => "locked",
        }
    }
}

/// El nodo arranca en SEGUNDO PLANO (revalidar una cadena grande tarda): el
/// panel se abre al instante y muestra «cargando la cadena…» hasta que esté.
enum NodeSlot {
    Starting,
    Ready(NodeHandle),
    Failed(String),
}

struct Gui {
    node: std::sync::RwLock<NodeSlot>,
    chain_dir: PathBuf,
    ks_path: String,
    /// El archivo del keystore existe pero es ilegible: modo solo-lectura del
    /// panel de monedero (JAMÁS se sobrescribe un keystore ilegible).
    ks_corrupt: bool,
    label: String,
    wallet: std::sync::Mutex<WalletState>,
}

impl Gui {
    /// Manejador del nodo, o una respuesta de error si aún carga / falló.
    fn node_ready(&self) -> Result<NodeHandle, Response> {
        match &*self.node.read().unwrap_or_else(|e| e.into_inner()) {
            NodeSlot::Ready(h) => Ok(h.clone()),
            NodeSlot::Starting => Err(err("el nodo aún está arrancando (cargando la cadena)")),
            NodeSlot::Failed(e) => Err(err(format!("el nodo no pudo arrancar: {e}"))),
        }
    }
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}
fn args_all(args: &[String], flag: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, a) in args.iter().enumerate() {
        if a == flag {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
        }
    }
    out
}
fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn body_json(req: &Request) -> Value {
    serde_json::from_slice(&req.body).unwrap_or(Value::Null)
}
fn err(msg: impl Into<String>) -> Response {
    Response::json(&json!({"ok": false, "error": msg.into()}))
}
fn fee_of(b: &Value) -> u64 {
    b.get("fee").and_then(|v| v.as_u64()).unwrap_or(1)
}

fn password_field(b: &Value) -> String {
    b.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Firma con el monedero (desbloqueado) y envía al nodo: camino común de todas
/// las acciones de la ciudad.
fn signed_submit(g: &Gui, build: impl FnOnce(&KeyPair, u64) -> Tx) -> Response {
    let w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
    let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
    let node = match g.node_ready() {
        Ok(n) => n,
        Err(r) => return r,
    };
    let nonce = node.next_nonce(kp.public_bytes());
    let tx = build(kp, nonce);
    match node.submit_tx(tx) {
        Ok(id) => Response::json(&json!({"ok": true, "txid": id})),
        Err(e) => err(e),
    }
}

fn coord(b: &Value, key: &str) -> Result<u16, String> {
    let v = b.get(key).and_then(|v| v.as_u64()).ok_or_else(|| format!("falta {key}"))?;
    if v >= rami_core::tx::CITY_SIZE as u64 {
        return Err("coordenada fuera de la ciudad".into());
    }
    Ok(v as u16)
}

fn asset_id(b: &Value) -> Result<[u8; 32], String> {
    let s = b.get("asset").and_then(|v| v.as_str()).unwrap_or("").trim();
    let v = hex::decode(s).map_err(|_| "id de activo no es hex".to_string())?;
    v.try_into().map_err(|_| "id de activo inválido".to_string())
}

fn str_field<'a>(b: &'a Value, key: &str) -> &'a str {
    b.get(key).and_then(|v| v.as_str()).unwrap_or("").trim()
}

fn route(g: &Gui, req: Request) -> Response {
    // Defensa del panel local frente a webs maliciosas abiertas en el mismo
    // navegador: (1) Host debe ser local — corta el DNS-rebinding; (2) todo
    // POST debe ser application/json — un formulario cross-origin solo puede
    // enviar text/plain o urlencoded sin disparar el preflight CORS (que este
    // servidor nunca aprueba), así que con esto no puede dar órdenes al nodo.
    let host_ok = req.host.is_empty()
        || req.host.starts_with("127.0.0.1")
        || req.host.starts_with("localhost");
    if !host_ok {
        return err("host no local");
    }
    if req.method == "POST" && !req.content_type.starts_with("application/json") {
        return err("Content-Type debe ser application/json");
    }
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => Response::html(DASHBOARD),

        ("GET", "/api/status") => {
            let w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            let mut wallet = json!({ "state": w.state(), "encrypted": w.encrypted, "corrupt": g.ks_corrupt });
            let node = match g.node_ready() {
                Ok(n) => n,
                Err(_) => {
                    // El panel abre al instante; el nodo sigue cargando (o falló).
                    let mut v = json!({ "version": env!("CARGO_PKG_VERSION"), "wallet": wallet });
                    match &*g.node.read().unwrap_or_else(|e| e.into_inner()) {
                        NodeSlot::Failed(e) => v["failed"] = json!(e),
                        _ => v["starting"] = json!(true),
                    }
                    return Response::json(&v);
                }
            };
            let s = node.status();
            let mut v = serde_json::to_value(&s).unwrap_or_else(|_| json!({}));
            v["version"] = json!(env!("CARGO_PKG_VERSION"));
            if let Some(pk) = w.pubkey {
                let acc = node.account(pk);
                wallet["address"] = json!(hex::encode(pk));
                wallet["short"] = json!(address_from_pubkey(&pk));
                wallet["balance"] = json!(fmt_ram(acc.balance));
                wallet["staked"] = json!(fmt_ram(acc.staked));
                wallet["nonce"] = json!(acc.nonce);
            }
            v["wallet"] = wallet;
            Response::json(&v)
        }

        // ---- gestión de contraseña / bloqueo ----
        ("POST", "/api/setup") => {
            let pw = password_field(&body_json(&req));
            if pw.chars().count() < 8 {
                return err("la contraseña debe tener al menos 8 caracteres");
            }
            let mut w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            if w.pubkey.is_some() {
                return err("ya existe un monedero en esta máquina");
            }
            let mut ks = Keystore::load(&g.ks_path);
            match ks.create(&g.label, Some(&pw)) {
                Ok(kp) => {
                    let pk = kp.public_bytes();
                    // Si el nodo aún carga, el hilo de arranque fijará el minero
                    // al terminar (lee la pubkey del monedero).
                    if let Ok(node) = g.node_ready() {
                        node.set_miner(pk);
                    }
                    w.pubkey = Some(pk);
                    w.kp = Some(kp);
                    w.encrypted = true;
                    Response::json(&json!({"ok": true, "state": "unlocked", "address": hex::encode(pk)}))
                }
                Err(e) => err(e),
            }
        }

        ("POST", "/api/unlock") => {
            let pw = password_field(&body_json(&req));
            let mut w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            if !w.encrypted {
                return err("el monedero no está cifrado");
            }
            match Keystore::load(&g.ks_path).keypair(&g.label, Some(&pw)) {
                Ok(kp) => {
                    w.kp = Some(kp);
                    Response::json(&json!({"ok": true, "state": "unlocked"}))
                }
                Err(_) => err("contraseña incorrecta"),
            }
        }

        ("POST", "/api/lock") => {
            let mut w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            if w.encrypted {
                w.kp = None;
            }
            Response::json(&json!({"ok": true, "state": w.state()}))
        }

        ("POST", "/api/encrypt") => {
            let pw = password_field(&body_json(&req));
            if pw.chars().count() < 8 {
                return err("la contraseña debe tener al menos 8 caracteres");
            }
            let mut w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            if w.encrypted {
                return err("el monedero ya está cifrado");
            }
            if w.pubkey.is_none() {
                return err("no hay ningún monedero que cifrar");
            }
            match Keystore::load(&g.ks_path).set_password(&pw) {
                Ok(()) => {
                    w.encrypted = true; // el kp sigue en memoria => queda desbloqueado
                    Response::json(&json!({"ok": true, "state": "unlocked"}))
                }
                Err(e) => err(e),
            }
        }

        ("GET", "/api/blocks") => {
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let n = req.query_get("n").and_then(|s| s.parse().ok()).unwrap_or(15);
            Response::json(&json!({"blocks": node.recent_blocks(n)}))
        }

        ("GET", "/api/block") => {
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let Some(h) = req.query_get("height").and_then(|s| s.parse::<u64>().ok()) else {
                return err("falta ?height=N");
            };
            match node.block(h) {
                Some(b) => Response::json(&json!({"ok": true, "block": b})),
                None => err("bloque no encontrado en la cadena del observador"),
            }
        }

        ("POST", "/api/mine") => {
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let on = body_json(&req).get("on").and_then(|v| v.as_bool()).unwrap_or(false);
            node.set_mining(on);
            Response::json(&json!({"ok": true, "mining": on}))
        }

        ("POST", "/api/send") => {
            let b = body_json(&req);
            let to = match parse_pubkey(b.get("to").and_then(|v| v.as_str()).unwrap_or("")) {
                Ok(a) => a,
                Err(e) => return err(e),
            };
            let amount = match parse_ram(b.get("amount").and_then(|v| v.as_str()).unwrap_or("")) {
                Ok(a) => a,
                Err(e) => return err(e),
            };
            let w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let nonce = node.next_nonce(kp.public_bytes());
            let tx = build_transfer(kp, to, amount, fee_of(&b), nonce);
            match node.submit_tx(tx) {
                Ok(id) => Response::json(&json!({"ok": true, "txid": id})),
                Err(e) => err(e),
            }
        }

        ("POST", "/api/stake") | ("POST", "/api/unstake") => {
            let unstake = req.path.ends_with("unstake");
            let b = body_json(&req);
            let amount = match parse_ram(b.get("amount").and_then(|v| v.as_str()).unwrap_or("")) {
                Ok(a) => a,
                Err(e) => return err(e),
            };
            let w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let nonce = node.next_nonce(kp.public_bytes());
            let tx = build_stake(kp, amount, fee_of(&b), nonce, unstake);
            match node.submit_tx(tx) {
                Ok(id) => Response::json(&json!({"ok": true, "txid": id})),
                Err(e) => err(e),
            }
        }

        ("POST", "/api/commit") => {
            let b = body_json(&req);
            let payload_s = b.get("payload").and_then(|v| v.as_str()).unwrap_or("");
            let payload: Value = match serde_json::from_str(payload_s) {
                Ok(v) => v,
                Err(_) => return err("el payload no es JSON válido"),
            };
            let w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let nonce = node.next_nonce(kp.public_bytes());
            let (tx, secret) = match build_commit(kp, &payload, fee_of(&b), nonce) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            let cid = txid(&tx);
            save_reveal(&g.chain_dir, &cid, &payload, &secret);
            match node.submit_tx(tx) {
                Ok(id) => Response::json(&json!({"ok": true, "txid": id, "commit_txid": hex::encode(cid)})),
                Err(e) => err(e),
            }
        }

        ("POST", "/api/reveal") => {
            let b = body_json(&req);
            let commit = b.get("commit").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let Some((payload, secret)) = load_reveal(&g.chain_dir, &commit) else {
                return err("no tengo el secreto de ese commit (¿lo hiciste con este monedero?)");
            };
            let commit_txid = match hex::decode(&commit).ok().filter(|v| v.len() == 32) {
                Some(v) => {
                    let mut a = [0u8; 32];
                    a.copy_from_slice(&v);
                    a
                }
                None => return err("commit txid inválido"),
            };
            let w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let nonce = node.next_nonce(kp.public_bytes());
            let tx = build_reveal(kp, commit_txid, &payload, secret, fee_of(&b), nonce);
            match node.submit_tx(tx) {
                Ok(id) => Response::json(&json!({"ok": true, "txid": id})),
                Err(e) => err(e),
            }
        }

        // ---- Ciudad RAMI (metaverso, fase 0) ----
        ("GET", "/api/city") => {
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            let me = g.wallet.lock().unwrap_or_else(|e| e.into_inner()).pubkey.map(hex::encode);
            let mut v = serde_json::to_value(node.city()).unwrap_or_else(|_| json!({}));
            v["ok"] = json!(true);
            v["me"] = json!(me);
            Response::json(&v)
        }
        ("POST", "/api/city/claim") => {
            let b = body_json(&req);
            let (x, y) = match (coord(&b, "x"), coord(&b, "y")) { (Ok(x), Ok(y)) => (x, y), (Err(e), _) | (_, Err(e)) => return err(e) };
            let name = str_field(&b, "name").to_string();
            if name.is_empty() || name.len() > rami_core::tx::MAX_NAME_BYTES {
                return err("nombre vacío o demasiado largo (máx. 32 bytes)");
            }
            let kind = b.get("kind").and_then(|v| v.as_u64()).unwrap_or(0);
            if kind > rami_core::tx::MAX_PARCEL_KIND as u64 {
                return err("tipo de parcela desconocido");
            }
            let fee = fee_of(&b);
            signed_submit(g, move |kp, nonce| build_claim_parcel(kp, x, y, &name, kind as u8, fee, nonce))
        }
        ("POST", "/api/city/mint") => {
            let b = body_json(&req);
            let (x, y) = match (coord(&b, "x"), coord(&b, "y")) { (Ok(x), Ok(y)) => (x, y), (Err(e), _) | (_, Err(e)) => return err(e) };
            let meta = str_field(&b, "meta").to_string();
            if meta.len() > rami_core::tx::MAX_META_BYTES {
                return err("metadatos demasiado largos (máx. 64 bytes)");
            }
            let kind = b.get("kind").and_then(|v| v.as_u64()).unwrap_or(0);
            if kind > rami_core::tx::MAX_ASSET_KIND as u64 {
                return err("tipo de activo desconocido");
            }
            let fee = fee_of(&b);
            signed_submit(g, move |kp, nonce| build_mint_asset(kp, x, y, kind as u8, &meta, fee, nonce))
        }
        ("POST", "/api/city/transfer") => {
            let b = body_json(&req);
            let asset = match asset_id(&b) { Ok(a) => a, Err(e) => return err(e) };
            let to = match parse_pubkey(str_field(&b, "to")) { Ok(a) => a, Err(e) => return err(e) };
            let fee = fee_of(&b);
            signed_submit(g, move |kp, nonce| build_transfer_asset(kp, asset, to, fee, nonce))
        }
        ("POST", "/api/city/list") => {
            let b = body_json(&req);
            let asset = match asset_id(&b) { Ok(a) => a, Err(e) => return err(e) };
            let price = match parse_ram(str_field(&b, "price")) { Ok(a) => a, Err(e) => return err(e) };
            let term = b.get("term").and_then(|v| v.as_u64()).unwrap_or(0);
            if term == 0 || term > rami_core::tx::MAX_LEASE_TERM {
                return err("plazo (en bloques) fuera de rango");
            }
            let fee = fee_of(&b);
            signed_submit(g, move |kp, nonce| build_list_lease(kp, asset, price, term, fee, nonce))
        }
        ("POST", "/api/city/rent") => {
            let b = body_json(&req);
            let asset = match asset_id(&b) { Ok(a) => a, Err(e) => return err(e) };
            let fee = fee_of(&b);
            signed_submit(g, move |kp, nonce| build_rent(kp, asset, fee, nonce))
        }
        ("POST", "/api/city/harvest") => {
            let b = body_json(&req);
            let (x, y) = match (coord(&b, "x"), coord(&b, "y")) { (Ok(x), Ok(y)) => (x, y), (Err(e), _) | (_, Err(e)) => return err(e) };
            let total = match parse_ram(str_field(&b, "total")) { Ok(a) => a, Err(e) => return err(e) };
            let fee = fee_of(&b);
            signed_submit(g, move |kp, nonce| build_harvest(kp, x, y, total, fee, nonce))
        }

        ("POST", "/api/peer") => {
            let b = body_json(&req);
            let addr = b.get("addr").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if addr.is_empty() {
                return err("dirección vacía");
            }
            let node = match g.node_ready() { Ok(n) => n, Err(r) => return r };
            node.add_peer(addr);
            Response::json(&json!({"ok": true}))
        }

        // Cierre limpio desde el panel (botón «Salir»): en macOS la app no tiene
        // ventana propia, así que sin esto quedaba corriendo invisible y el
        // siguiente clic en el icono «no respondía».
        ("POST", "/api/quit") => {
            dlog("salida solicitada desde el panel («Salir»)");
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(400));
                std::process::exit(0);
            });
            Response::json(&json!({"ok": true, "bye": true}))
        }

        // ---- auto-actualizador ----
        // Comprueba el Release oficial (sin tocar nada) y dice si hay versión
        // nueva y con qué instalador se aplicaría.
        ("GET", "/api/update") => match rami_node::update::check(env!("CARGO_PKG_VERSION")) {
            Ok(info) => {
                let mut v = serde_json::to_value(&info).unwrap_or_else(|_| json!({}));
                v["ok"] = json!(true);
                Response::json(&v)
            }
            Err(e) => err(e),
        },

        // Descarga el instalador oficial, VERIFICA su SHA-256, instala la
        // versión nueva y programa su reapertura (este proceso se cierra en
        // unos segundos). Nunca ejecuta ni sobrescribe nada cuyo hash no coincida.
        ("POST", "/api/update/apply") => {
            dlog("actualización solicitada desde el panel");
            let r = rami_node::update::apply_and_relaunch(env!("CARGO_PKG_VERSION"));
            let mut v = serde_json::to_value(&r).unwrap_or_else(|_| json!({}));
            v["ok"] = json!(r.ok);
            Response::json(&v)
        }

        _ => Response::not_found(),
    }
}

fn open_browser(url: &str) {
    if cfg!(target_os = "macos") {
        if Command::new("open").arg(url).spawn().is_ok() {
            return;
        }
    } else if cfg!(target_os = "windows") {
        if Command::new("cmd").args(["/C", "start", "", url]).spawn().is_ok() {
            return;
        }
    } else {
        // Linux: xdg-open no está garantizado (entornos mínimos). Prueba
        // $BROWSER y varias alternativas; xdg-open sale con error casi al
        // instante si no hay manejador, así que se comprueba brevemente.
        let mut cands: Vec<String> = Vec::new();
        if let Ok(b) = std::env::var("BROWSER") {
            if !b.is_empty() {
                cands.push(b);
            }
        }
        for c in ["xdg-open", "sensible-browser", "x-www-browser", "firefox", "chromium", "chromium-browser", "google-chrome"] {
            cands.push(c.to_string());
        }
        for c in cands {
            if let Ok(mut child) = Command::new(&c).arg(url).spawn() {
                std::thread::sleep(std::time::Duration::from_millis(300));
                match child.try_wait() {
                    Ok(Some(status)) if !status.success() => continue, // probó y falló
                    _ => return, // sigue vivo o terminó bien
                }
            }
        }
    }
    eprintln!("⚠ no pude abrir el navegador; abre a mano: {url}");
}

/// macOS: bucle de eventos Cocoa mínimo para que la app se comporte como una
/// app de verdad. Sin él, macOS no recibe respuesta a sus eventos (el clic en
/// el icono, «reabrir») y muestra «La aplicación RAMI-Chain no responde»
/// aunque el nodo funcione. Se usa el runtime de Objective‑C por FFI, sin
/// dependencias: `[NSApplication sharedApplication]`, un delegado con
/// `applicationShouldHandleReopen:` que abre el panel en el navegador, y
/// `[NSApp run]` en el hilo principal (el servidor del panel va en otro hilo).
#[cfg(target_os = "macos")]
mod cocoa {
    use std::ffi::{c_char, c_void, CStr};
    use std::sync::OnceLock;

    type Id = *mut c_void;
    type Sel = *mut c_void;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_allocateClassPair(superclass: Id, name: *const c_char, extra: usize) -> Id;
        fn objc_registerClassPair(cls: Id);
        fn class_addMethod(cls: Id, name: Sel, imp: *const c_void, types: *const c_char) -> bool;
    }
    // Enlazar los frameworks hace que las clases (NSApplication…) existan.
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    static PANEL_URL: OnceLock<String> = OnceLock::new();

    unsafe fn sel(s: &CStr) -> Sel {
        sel_registerName(s.as_ptr())
    }
    // objc_msgSend se llama SIEMPRE con la firma exacta del método: en arm64 de
    // Apple los argumentos variádicos van por la pila y romperían la llamada.
    unsafe fn msg0(receiver: Id, s: Sel) -> Id {
        let f: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
        f(receiver, s)
    }
    unsafe fn msg1(receiver: Id, s: Sel, a: Id) -> Id {
        let f: extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
        f(receiver, s, a)
    }

    /// `- (BOOL)applicationShouldHandleReopen:(NSApplication*)app hasVisibleWindows:(BOOL)v`
    /// Clic en el icono con la app ya abierta => reabrir el panel en el navegador.
    extern "C" fn reopen(_this: Id, _sel: Sel, _app: Id, _visible: bool) -> bool {
        if let Some(u) = PANEL_URL.get() {
            super::dlog("reabrir: abriendo el panel en el navegador");
            super::open_browser(u);
        }
        false
    }

    /// No vuelve: ejecuta el bucle de eventos en el hilo actual (debe ser el principal).
    pub fn run_app_loop(url: String) {
        let _ = PANEL_URL.set(url);
        unsafe {
            let app = msg0(objc_getClass(c"NSApplication".as_ptr()), sel(c"sharedApplication"));
            if app.is_null() {
                super::dlog("cocoa: NSApplication no disponible; sigo sin bucle de eventos");
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                }
            }
            let sup = objc_getClass(c"NSObject".as_ptr());
            let cls = objc_allocateClassPair(sup, c"RamiChainAppDelegate".as_ptr(), 0);
            if !cls.is_null() {
                class_addMethod(
                    cls,
                    sel(c"applicationShouldHandleReopen:hasVisibleWindows:"),
                    reopen as *const c_void,
                    c"B@:@B".as_ptr(),
                );
                objc_registerClassPair(cls);
                let delegate = msg0(msg0(cls, sel(c"alloc")), sel(c"init"));
                msg1(app, sel(c"setDelegate:"), delegate);
            }
            super::dlog("cocoa: bucle de eventos en marcha");
            msg0(app, sel(c"run"));
        }
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Caja negra del arranque (~/.rami/gui-launch.log): en macOS/Windows la app
/// corre sin consola, así que este archivo es la única evidencia si algo falla
/// antes de que exista el panel. Si tras un fallo el archivo NI EXISTE, el
/// sistema no llegó a ejecutar el binario (arquitectura equivocada/Gatekeeper).
fn log_path() -> PathBuf {
    PathBuf::from(format!("{}/.rami/gui-launch.log", rami_wallet::home_dir()))
}

fn dlog(msg: &str) {
    let line = format!("[{} pid {}] {msg}\n", rami_node::now_secs(), std::process::id());
    eprint!("{line}");
    let p = log_path();
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Rotación simple para que nunca crezca sin límite.
    if std::fs::metadata(&p).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&p);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write as _;
        let _ = f.write_all(line.as_bytes());
    }
}

/// Diálogo NATIVO de macOS (osascript): visible aunque el navegador no se abra.
#[cfg(target_os = "macos")]
fn native_dialog(title: &str, msg: &str) {
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display dialog \"{}\" with title \"{}\" buttons {{\"OK\"}} default button 1 with icon caution",
        q(msg),
        q(title)
    );
    let _ = Command::new("osascript").args(["-e", &script]).spawn();
}
#[cfg(not(target_os = "macos"))]
fn native_dialog(_title: &str, _msg: &str) {}

/// Error fatal VISIBLE: en macOS/Windows la app se lanza sin consola, así que
/// un eprintln+exit es invisible («la app no responde»). Escribimos una página
/// de error y la abrimos en el navegador para que el usuario sepa qué pasó.
fn fail_visible(title: &str, detail: &str) -> ExitCode {
    fail_page(title, detail);
    ExitCode::FAILURE
}

/// Escribe y abre la página de error sin terminar el proceso (para hilos).
/// Triple visibilidad: registro en disco + diálogo nativo (macOS) + página en
/// el navegador — un fallo de arranque nunca más puede ser invisible.
fn fail_page(title: &str, detail: &str) {
    dlog(&format!("ERROR FATAL: {title}: {}", detail.replace('\n', " | ")));
    let mut short = detail.chars().take(280).collect::<String>();
    if short.len() < detail.len() {
        short.push('…');
    }
    native_dialog(
        "RAMI-Chain no pudo arrancar",
        &format!("{title}\n\n{short}\n\nRegistro: ~/.rami/gui-launch.log"),
    );
    let html = format!(
        "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\">\
         <title>RAMI-Chain — error al arrancar</title>\
         <body style=\"font-family:system-ui,sans-serif;background:#0b0f14;color:#e8eef5;\
         display:flex;min-height:96vh;align-items:center;justify-content:center;margin:0\">\
         <div style=\"max-width:600px;padding:32px\">\
         <h1 style=\"color:#ff6b6b;font-size:22px\">El monedero RAMI-Chain no pudo arrancar</h1>\
         <p style=\"font-size:16px\"><b>{}</b></p>\
         <p style=\"color:#9fb0c3;white-space:pre-wrap\">{}</p>\
         <p style=\"color:#9fb0c3;font-size:13px;margin-top:24px\">Cierra esta pestaña y vuelve a \
         abrir la aplicación cuando lo hayas resuelto. RAMI-Chain es una testnet experimental sin \
         valor monetario.</p></div>",
        esc(title),
        esc(detail)
    );
    let path = std::env::temp_dir().join("rami-chain-error.html");
    if std::fs::write(&path, html).is_ok() {
        open_browser(&format!("file://{}", path.display()));
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Caja negra: cualquier panic de cualquier hilo queda registrado en disco.
    std::panic::set_hook(Box::new(|info| {
        dlog(&format!("PANIC: {info}"));
    }));

    // macOS: la app corre como una app de verdad — con bucle de eventos Cocoa en
    // el hilo principal (ver `cocoa` y el final de main). Sin él, macOS mostraba
    // «La aplicación RAMI-Chain no responde» al hacer clic en el icono, aunque el
    // nodo funcionara. `--foreground` se acepta por compatibilidad (v0.4.2–0.5.0).

    let is_testnet = arg(&args, "--network").as_deref() != Some("regtest"); // testnet por defecto
    let params = if is_testnet { Params::testnet() } else { Params::regtest() };
    let net_name = if is_testnet { "testnet" } else { "regtest" };

    let home = rami_wallet::home_dir();
    let chain_dir: PathBuf = arg(&args, "--chain")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("{home}/.rami/chain-{net_name}")));
    let dash_port: u16 = arg(&args, "--port").and_then(|s| s.parse().ok()).unwrap_or(8645);
    let p2p_port: u16 = arg(&args, "--listen").and_then(|s| s.parse().ok()).unwrap_or(30301);
    let seeds = args_all(&args, "--connect");
    let label = arg(&args, "--label").unwrap_or_else(|| "default".into());

    // Monedero: NO se crea solo. Si no existe, el panel pedirá una contraseña
    // (estado "none"). Si está cifrado, arranca BLOQUEADO. La pubkey se conoce
    // sin contraseña para poder minar y ver saldo.
    let keystore_path = arg(&args, "--keystore").unwrap_or_else(default_keystore_path);
    let ks = Keystore::load(&keystore_path);
    let ks_corrupt = ks.corrupt_on_disk();
    let encrypted = ks.is_encrypted();
    let pubkey = ks.public_key(&label);
    let kp = if !encrypted {
        pubkey.and_then(|_| ks.keypair(&label, None).ok()) // legado en claro => desbloqueado
    } else {
        None // cifrado => bloqueado hasta que el usuario desbloquee
    };
    let wallet = WalletState { pubkey, kp, encrypted };
    let wstate = wallet.state();

    // Panel local ANTES de arrancar el nodo. Instancia única, como Bitcoin
    // Core: si el puerto ya lo ocupa OTRO monedero RAMI (p. ej. quedó abierto
    // de antes), no es un fallo — abrimos el navegador hacia ese panel y
    // salimos. Si lo ocupa otro programa, probamos los puertos siguientes.
    // Sin esto, el segundo lanzamiento moría en silencio («la app no responde»).
    let explicit_port = arg(&args, "--port").is_some();
    let mut bound = None;
    for off in 0..10u16 {
        let p = dash_port + off;
        match TcpListener::bind(("127.0.0.1", p)) {
            Ok(l) => {
                bound = Some((l, p));
                break;
            }
            Err(_) => {
                if let Some(body) = http::probe_local(p) {
                    if body.contains("network_id") || body.contains("starting") {
                        let url = format!("http://127.0.0.1:{p}");
                        dlog(&format!("ya hay un monedero abierto; reabriendo su panel {url}"));
                        println!("● Ya hay un monedero RAMI-Chain abierto — abriendo su panel: {url}");
                        if !has(&args, "--no-open") {
                            open_browser(&url);
                        }
                        return ExitCode::SUCCESS;
                    }
                }
                if explicit_port {
                    return fail_visible(
                        &format!("el puerto {p} está ocupado por otro programa"),
                        "Elige otro puerto con --port, o cierra el programa que lo usa.",
                    );
                }
            }
        }
    }
    let Some((listener, dash_port)) = bound else {
        return fail_visible(
            &format!("no hay ningún puerto libre entre {dash_port} y {}", dash_port + 9),
            "Cierra otras aplicaciones que usen esos puertos e inténtalo de nuevo.",
        );
    };
    let url = format!("http://127.0.0.1:{dash_port}");
    dlog(&format!("v{} panel escuchando en {url} ({net_name})", env!("CARGO_PKG_VERSION")));

    println!("● RAMI-Chain — monedero de escritorio ({net_name})");
    println!("  panel      : {url}");
    match pubkey {
        Some(pk) => println!("  dirección  : {}", hex::encode(pk)),
        None if ks_corrupt => {
            println!("  monedero   : ⚠ el keystore existe pero es ILEGIBLE — no se tocará");
            println!("               ({keystore_path})");
        }
        None => println!("  monedero   : sin crear — el panel pedirá una contraseña"),
    }
    println!("  monedero   : estado «{wstate}»");
    if !seeds.is_empty() {
        println!("  seeds      : {}", seeds.join(", "));
    }
    println!("  cadena     : {}", chain_dir.display());
    println!("  ⚠ TESTNET experimental — sin valor monetario, no es una inversión.");
    println!("  (Ctrl-C para salir)");

    let gui = Arc::new(Gui {
        node: std::sync::RwLock::new(NodeSlot::Starting),
        chain_dir: chain_dir.clone(),
        ks_path: keystore_path,
        ks_corrupt,
        label,
        wallet: std::sync::Mutex::new(wallet),
    });

    // El nodo arranca en SEGUNDO PLANO: revalidar una cadena grande tarda, y el
    // panel debe abrirse al instante mostrando «cargando la cadena…» en vez de
    // parecer que la app no responde.
    {
        let gui = gui.clone();
        let seeds = seeds.clone();
        std::thread::spawn(move || {
            // catch_unwind: un panic aquí dejaría el panel en «cargando…» para
            // siempre; mejor convertirlo en estado Failed visible.
            let spawned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                spawn(NodeConfig {
                    chain_dir: chain_dir.clone(),
                    params,
                    is_testnet,
                    listen: Some(p2p_port),
                    seeds,
                    miner: pubkey,
                    mining: false,
                })
            }));
            match spawned {
                Ok(Ok(h)) => {
                    let s = h.status();
                    dlog(&format!("nodo listo: altura {}, P2P :{}", s.height, s.listen_port));
                    println!("  network-id : {}", s.network_id);
                    println!("  P2P        : 0.0.0.0:{}", s.listen_port);
                    // Si el usuario creó el monedero MIENTRAS cargaba el nodo,
                    // fija ahora el minero con su pubkey.
                    if let Some(pk) = gui.wallet.lock().unwrap_or_else(|e| e.into_inner()).pubkey {
                        h.set_miner(pk);
                    }
                    *gui.node.write().unwrap_or_else(|e| e.into_inner()) = NodeSlot::Ready(h);
                }
                Ok(Err(e)) => {
                    *gui.node.write().unwrap_or_else(|e| e.into_inner()) =
                        NodeSlot::Failed(e.clone());
                    // Error visible también fuera del panel.
                    fail_page(
                        "el nodo no pudo arrancar",
                        &format!("{e}\n\nDirectorio de cadena: {}", chain_dir.display()),
                    );
                }
                Err(_) => {
                    *gui.node.write().unwrap_or_else(|e| e.into_inner()) =
                        NodeSlot::Failed("error interno (panic) al cargar la cadena".into());
                    fail_page(
                        "error interno al cargar la cadena",
                        &format!("Mira el registro: {}", log_path().display()),
                    );
                }
            }
        });
    }

    if !has(&args, "--no-open") {
        open_browser(&url);
    }

    // macOS lanzada desde el Finder (sin terminal): el panel se sirve en un
    // hilo y el hilo principal ejecuta el bucle de eventos Cocoa, para que
    // macOS nunca marque la app como «no responde» y el clic en el icono
    // reabra el panel. Desde una terminal (stdin es TTY) se sirve en primer
    // plano, como siempre.
    #[cfg(target_os = "macos")]
    {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() {
            let gui2 = gui.clone();
            std::thread::spawn(move || http::serve(listener, move |req| route(&gui2, req)));
            cocoa::run_app_loop(url.clone());
            return ExitCode::SUCCESS;
        }
    }
    http::serve(listener, move |req| route(&gui, req));
    ExitCode::SUCCESS
}
