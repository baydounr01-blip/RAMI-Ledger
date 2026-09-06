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
/// Diccionarios del panel (en, zh, ru, sw); el español es el texto original.
const I18N_JS: &str = include_str!("i18n.js");
/// Cliente 3D de la Ciudad RAMI (Three.js r150, licencia MIT, empaquetado en
/// el binario: el panel no necesita internet para renderizar).
const THREE_JS: &[u8] = include_bytes!("vendor/three.min.js");
const CITY3D_JS: &str = include_str!("city3d.js");
/// Terreno de Tenerife (datos abiertos: Mapzen/AWS Terrain Tiles; ver
/// tools/geo/README.md). Mapa de alturas PNG de 16 bits + metadatos.
const GEO_HGT: &[u8] = include_bytes!("geo/tenerife.hgt.png");
const GEO_META: &str = include_str!("geo/tenerife.json");
/// Icono del panel (pestaña del navegador): el logo del proyecto.
const FAVICON_SVG: &str = include_str!("../../../../packaging/icon/rami.svg");

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
        ("GET", "/favicon.ico") | ("GET", "/favicon.svg") => Response {
            status: 200,
            content_type: "image/svg+xml".into(),
            body: FAVICON_SVG.as_bytes().to_vec(),
        },
        ("GET", "/vendor/three.min.js") => Response {
            status: 200,
            content_type: "application/javascript; charset=utf-8".into(),
            body: THREE_JS.to_vec(),
        },
        ("GET", "/city3d.js") => Response {
            status: 200,
            content_type: "application/javascript; charset=utf-8".into(),
            body: CITY3D_JS.as_bytes().to_vec(),
        },
        ("GET", "/geo/tenerife.hgt.png") => Response { status: 200, content_type: "image/png".into(), body: GEO_HGT.to_vec() },
        ("GET", "/geo/tenerife.json") => Response {
            status: 200,
            content_type: "application/json; charset=utf-8".into(),
            body: GEO_META.as_bytes().to_vec(),
        },
        // Localiza una dirección de Tenerife (OpenStreetMap Nominatim, solo a
        // petición del usuario). No verifica ninguna empresa.
        ("POST", "/api/geocode") => {
            let q = str_field(&body_json(&req), "q").to_string();
            match rami_node::geo::search(&q) {
                Ok(places) => Response::json(&json!({ "ok": true, "places": places })),
                Err(e) => Response::json(&json!({ "ok": false, "error": e })),
            }
        }
        ("GET", "/i18n.js") => Response {
            status: 200,
            content_type: "application/javascript; charset=utf-8".into(),
            body: I18N_JS.as_bytes().to_vec(),
        },
        // Idioma elegido en el panel: se guarda para que los diálogos NATIVOS
        // (p. ej. «instalar en Aplicaciones») salgan en el mismo idioma.
        ("POST", "/api/lang") => {
            let lang = str_field(&body_json(&req), "lang").to_string();
            if ["es", "en", "zh", "ru", "sw"].contains(&lang.as_str()) {
                let _ = std::fs::create_dir_all(format!("{}/.rami", rami_wallet::home_dir()));
                let _ = std::fs::write(lang_path(), &lang);
                Response::json(&json!({ "ok": true, "lang": lang }))
            } else {
                Response::json(&json!({ "ok": false, "error": "idioma no soportado" }))
            }
        }

        ("GET", "/api/status") => {
            let w = g.wallet.lock().unwrap_or_else(|e| e.into_inner());
            let mut wallet = json!({ "state": w.state(), "encrypted": w.encrypted, "corrupt": g.ks_corrupt });
            let node = match g.node_ready() {
                Ok(n) => n,
                Err(_) => {
                    // El panel abre al instante; el nodo sigue cargando (o falló).
                    let mut v = json!({ "version": env!("CARGO_PKG_VERSION"), "wallet": wallet });
                    v["pid"] = json!(std::process::id());
                    v["install"] = serde_json::to_value(rami_node::update::install_info()).unwrap_or(json!({}));
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
            // pid: el panel detecta que el proceso cambió (actualización o
            // reinstalación) y se recarga. install: dónde corre esta copia.
            v["pid"] = json!(std::process::id());
            v["install"] = serde_json::to_value(rami_node::update::install_info()).unwrap_or(json!({}));
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
                safe_exit(0);
            });
            Response::json(&json!({"ok": true, "bye": true}))
        }

        // Instala ESTA app en Aplicaciones (macOS) y la reabre desde allí. Es
        // lo que hace falta para que las actualizaciones automáticas puedan
        // sustituirla; aparece cuando la app corre desde el .dmg o Descargas.
        ("POST", "/api/install") => {
            dlog("instalación en Aplicaciones solicitada desde el panel");
            match rami_node::update::self_install() {
                Ok(dest) => {
                    let relaunch = rami_node::update::relaunch_after_exit_with(&dest, &["--no-install"]).is_ok();
                    if relaunch {
                        rami_node::update::exit_soon();
                    }
                    Response::json(&json!({
                        "ok": true, "dest": dest.to_string_lossy(), "relaunch": relaunch,
                        "message": format!("Instalada en {}. El monedero se cierra y se vuelve a abrir desde ahí.", dest.display())
                    }))
                }
                Err(e) => {
                    dlog(&format!("instalación fallida: {e}"));
                    Response::json(&json!({ "ok": false, "error": e }))
                }
            }
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

/// `--no-open`: nunca abrir el navegador (pruebas, CI, reapertura por icono).
static NO_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Salida INMEDIATA y segura desde CUALQUIER hilo.
///
/// Causa raíz de «la aplicación no responde» tras cada actualización (v0.5.2 a
/// v0.6.1): la salida se pedía con `exit()` de la libc desde un hilo
/// secundario (el que atendía «Actualizar ahora» o «Salir») mientras el hilo
/// principal estaba dentro del bucle de eventos de Cocoa. `exit()` ejecuta los
/// manejadores atexit y los destructores de AppKit, que esperan al hilo
/// principal: el proceso se quedaba colgado sin terminar nunca, el relanzador
/// esperaba a un PID que no moría, y el siguiente clic en el icono encontraba
/// un proceso «no responde». `_exit()` termina el proceso en el acto (el
/// núcleo cierra descriptores y conserva lo ya escrito en disco: la cadena y el
/// mempool se escriben con append+write_all, no hay búferes propios pendientes).
fn safe_exit(code: i32) -> ! {
    dlog(&format!("salida inmediata del proceso (código {code})"));
    {
        use std::io::Write as _;
        let _ = std::io::stderr().flush();
        let _ = std::io::stdout().flush();
    }
    rami_node::update::hard_exit(code)
}

fn open_browser(url: &str) {
    if NO_OPEN.load(std::sync::atomic::Ordering::Relaxed) {
        dlog(&format!("(--no-open) no se abre el navegador: {url}"));
        return;
    }
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
        let u = PANEL_URL.get().cloned().unwrap_or_else(|| "http://127.0.0.1:8645".to_string());
        super::dlog("reabrir: abriendo el panel en el navegador");
        super::open_browser(&u);
        false
    }

    /// URL del panel para el clic en el icono (se fija cuando se conoce el puerto).
    pub fn set_panel_url(url: String) {
        let _ = PANEL_URL.set(url);
    }

    /// `- (NSUInteger)applicationShouldTerminate:(NSApplication*)app`
    /// Cierre pedido por el sistema (Cmd+Q, cerrar sesión, apagar, «quit» por
    /// AppleScript): salida inmediata, igual que «Salir» (nunca exit() de
    /// AppKit con el nodo aún corriendo).
    extern "C" fn should_terminate(_this: Id, _sel: Sel, _app: Id) -> usize {
        super::dlog("cierre pedido por el sistema");
        super::safe_exit(0)
    }

    /// No vuelve: ejecuta el bucle de eventos en el hilo actual (debe ser el
    /// principal). El hilo principal NO hace nada más: cualquier trabajo
    /// (puertos, nodo, diálogos) va en otros hilos, así macOS siempre recibe
    /// respuesta a sus eventos y la app nunca aparece como «no responde».
    pub fn run_app_loop() {
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
                class_addMethod(
                    cls,
                    sel(c"applicationShouldTerminate:"),
                    should_terminate as *const c_void,
                    c"Q@:@".as_ptr(),
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

fn lang_path() -> PathBuf {
    PathBuf::from(format!("{}/.rami/lang", rami_wallet::home_dir()))
}

/// Idioma para los diálogos nativos: el elegido en el panel (~/.rami/lang),
/// si no el del sistema (RAMI_LANG, LANG/LC_ALL, AppleLocale en macOS), si no
/// español. Solo los cinco del panel: es, en, zh, ru, sw.
#[allow(dead_code)]
fn ui_lang() -> &'static str {
    fn pick(code: &str) -> Option<&'static str> {
        let c = code.trim().to_ascii_lowercase();
        for l in ["es", "en", "zh", "ru", "sw"] {
            if c.starts_with(l) {
                return Some(l);
            }
        }
        None
    }
    if let Ok(saved) = std::fs::read_to_string(lang_path()) {
        if let Some(l) = pick(&saved) {
            return l;
        }
    }
    for var in ["RAMI_LANG", "LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(var) {
            if let Some(l) = pick(&v) {
                return l;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("defaults").args(["read", "-g", "AppleLocale"]).output() {
            if let Some(l) = pick(&String::from_utf8_lossy(&out.stdout)) {
                return l;
            }
        }
    }
    "es"
}

/// Textos de los diálogos nativos en los cinco idiomas del panel.
#[allow(dead_code)]
fn native_text(key: &str) -> &'static str {
    let l = ui_lang();
    match (key, l) {
        ("install.q", "en") => "For RAMI-Chain to update itself, it must be in the Applications folder.\n\nInstall it now? (a previous version is replaced; your wallet and chain are untouched)",
        ("install.q", "zh") => "为了让 RAMI-Chain 能自动更新，它必须位于“应用程序”文件夹中。\n\n现在安装吗？（旧版本会被替换；你的钱包和链不受影响）",
        ("install.q", "ru") => "Чтобы RAMI-Chain обновлялся сам, он должен находиться в папке «Программы».\n\nУстановить сейчас? (предыдущая версия заменяется; кошелёк и цепочка не затрагиваются)",
        ("install.q", "sw") => "Ili RAMI-Chain ijisasishe yenyewe, lazima iwe kwenye folda ya Applications.\n\nIsakinishe sasa? (toleo la awali hubadilishwa; pochi yako na mnyororo hazitaguswa)",
        ("install.q", _) => "Para que RAMI-Chain se actualice sola, debe estar en la carpeta Aplicaciones.\n\n¿Instalarla ahora? (si hay una versión anterior, se sustituye; tu monedero y tu cadena no se tocan)",
        ("btn.later", "en") => "Not now",
        ("btn.later", "zh") => "暂不",
        ("btn.later", "ru") => "Не сейчас",
        ("btn.later", "sw") => "Si sasa",
        ("btn.later", _) => "Ahora no",
        ("btn.install", "en") => "Install",
        ("btn.install", "zh") => "安装",
        ("btn.install", "ru") => "Установить",
        ("btn.install", "sw") => "Sakinisha",
        ("btn.install", _) => "Instalar",
        ("installed.noreopen", "en") => "Installed in {dest}, but it could not be reopened automatically ({e}). Open it from Applications.",
        ("installed.noreopen", "zh") => "已安装到 {dest}，但无法自动重新打开（{e}）。请从“应用程序”中打开它。",
        ("installed.noreopen", "ru") => "Установлено в {dest}, но не удалось открыть заново ({e}). Откройте из папки «Программы».",
        ("installed.noreopen", "sw") => "Imesakinishwa kwenye {dest}, lakini haikuweza kufunguka yenyewe ({e}). Ifungue kutoka Applications.",
        ("installed.noreopen", _) => "Instalada en {dest}, pero no pude reabrirla sola ({e}). Ábrela desde Aplicaciones.",
        ("install.failed", "en") => "Could not install into Applications ({e}). Drag RAMI-Chain to Applications by hand. It will keep opening from here.",
        ("install.failed", "zh") => "无法安装到“应用程序”（{e}）。请手动把 RAMI-Chain 拖到“应用程序”。它将继续从这里打开。",
        ("install.failed", "ru") => "Не удалось установить в «Программы» ({e}). Перетащите RAMI-Chain в «Программы» вручную. Приложение продолжит открываться отсюда.",
        ("install.failed", "sw") => "Haikuweza kusakinishwa kwenye Applications ({e}). Buruta RAMI-Chain kwenye Applications mwenyewe. Itaendelea kufunguka kutoka hapa.",
        ("install.failed", _) => "No pude instalarla en Aplicaciones ({e}). Arrastra RAMI-Chain a Aplicaciones a mano. Seguiré abriéndose desde aquí.",
        _ => "",
    }
}

/// Pregunta NATIVA de macOS con dos botones; devuelve true si el usuario
/// pulsa `yes`. Si osascript falla, devuelve false (no se hace nada).
#[cfg(target_os = "macos")]
fn native_ask(title: &str, msg: &str, no: &str, yes: &str) -> bool {
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display dialog \"{}\" with title \"{}\" buttons {{\"{}\", \"{}\"}} default button \"{}\" with icon note",
        q(msg), q(title), q(no), q(yes), q(yes)
    );
    match Command::new("osascript").args(["-e", &script]).output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&format!("button returned:{yes}")),
        Err(_) => false,
    }
}
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn native_ask(_title: &str, _msg: &str, _no: &str, _yes: &str) -> bool {
    false
}

/// Pide a OTRA instancia del monedero (puerto `port`) que se cierre y espera
/// a que libere el puerto (hasta ~10 s). true si quedó libre.
fn ask_other_to_quit(port: u16, other_pid: Option<u32>) -> bool {
    let _ = http::post_local(port, "/api/quit");
    let t0 = std::time::Instant::now();
    let mut killed = false;
    while t0.elapsed() < std::time::Duration::from_secs(10) {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return true;
        }
        // Las versiones ≤ 0.6.1 salían con exit() desde un hilo secundario y
        // en macOS podían quedarse colgadas sin morir («no responde»). Si tras
        // 4 s la otra instancia sigue con el puerto, se termina a la fuerza:
        // es nuestro propio monedero (misma red, mismo puerto) y su cadena y
        // mempool ya están en disco.
        if !killed && t0.elapsed() > std::time::Duration::from_secs(4) {
            if let Some(pid) = other_pid {
                if pid != std::process::id() {
                    dlog(&format!("la instancia anterior (pid {pid}) no termina; se fuerza su cierre"));
                    force_kill(pid);
                    killed = true;
                }
            }
        }
    }
    false
}

/// Termina a la fuerza OTRO proceso de este monedero (ver ask_other_to_quit).
fn force_kill(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).stdin(std::process::Stdio::null()).output();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
    }
}

/// Versión que declara un `/api/status` ajeno (`"version":"x.y.z"`).
fn version_in(body: &str) -> Option<String> {
    json_field(body, "version").and_then(|v| v.strip_prefix('"').map(|r| r.split('"').next().unwrap_or("").to_string()))
}

/// PID que declara un `/api/status` ajeno (`"pid":123`, desde v0.5.3).
fn pid_in(body: &str) -> Option<u32> {
    let v = json_field(body, "pid")?;
    let digits: String = v.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Texto que sigue a `"clave":` (tolera espacios) en un JSON plano.
fn json_field<'a>(body: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{key}\"");
    let mut from = 0;
    while let Some(i) = body[from..].find(&pat) {
        let after = &body[from + i + pat.len()..];
        let after = after.trim_start();
        if let Some(rest) = after.strip_prefix(':') {
            return Some(rest.trim_start());
        }
        from += i + pat.len();
    }
    None
}

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
    if has(&args, "--no-open") {
        NO_OPEN.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    // Caja negra: cualquier panic de cualquier hilo queda registrado en disco.
    std::panic::set_hook(Box::new(|info| {
        dlog(&format!("PANIC: {info}"));
    }));

    // macOS lanzada desde el Finder (sin terminal): el hilo principal ejecuta
    // SOLO el bucle de eventos de Cocoa desde el primer instante, y TODO el
    // arranque (puertos, otra instancia, instalación, nodo, panel) corre en un
    // hilo de trabajo. Antes el arranque iba en el hilo principal y el bucle
    // se entraba al final: cualquier espera previa (otra instancia que tarda
    // en cerrarse, un diálogo, el sondeo de puertos) dejaba a la app sin
    // atender eventos y macOS la marcaba como «no responde». Desde una
    // terminal (stdin es TTY) o con --no-cocoa se comporta como siempre.
    #[cfg(target_os = "macos")]
    {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() && !has(&args, "--no-cocoa") {
            let args2 = args.clone();
            std::thread::spawn(move || {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| real_main(args2)));
                match r {
                    Ok(code) => safe_exit(if code == ExitCode::SUCCESS { 0 } else { 1 }),
                    Err(_) => {
                        fail_page(
                            "el monedero falló al arrancar (panic)",
                            &format!("Mira el registro: {}", log_path().display()),
                        );
                        safe_exit(2)
                    }
                }
            });
            cocoa::run_app_loop(); // no vuelve
        }
    }
    real_main(args)
}

/// Arranque completo del monedero (puertos, nodo, panel). Solo vuelve si la
/// app decide salir (p. ej. ya hay otra instancia abierta) o si el servidor
/// del panel termina. `--foreground` se acepta por compatibilidad (v0.4.2–0.5.0).
fn real_main(args: Vec<String>) -> ExitCode {

    let is_testnet = arg(&args, "--network").as_deref() != Some("regtest"); // testnet por defecto
    let params = if is_testnet { Params::testnet() } else { Params::regtest() };
    let net_name = if is_testnet { "testnet" } else { "regtest" };

    let home = rami_wallet::home_dir();
    let chain_dir: PathBuf = arg(&args, "--chain")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("{home}/.rami/chain-{net_name}")));
    let dash_port: u16 = arg(&args, "--port").and_then(|s| s.parse().ok()).unwrap_or(8645);
    let p2p_port: u16 = arg(&args, "--listen").and_then(|s| s.parse().ok()).unwrap_or(30301);
    // Semillas: las de --connect más la semilla DNS del proyecto (si el nombre
    // no existe todavía, simplemente no resuelve). La lista web se añade
    // cuando el nodo está listo (ver más abajo).
    let mut seeds = args_all(&args, "--connect");
    if !has(&args, "--no-seeds") {
        seeds.push(rami_node::seeds::DNS_SEED.to_string());
    }
    let lan_discovery = !has(&args, "--no-lan");
    let portmap = !has(&args, "--no-portmap");
    let web_seeds_on = !has(&args, "--no-seeds");
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
    // macOS: si la app se abrió desde el .dmg, desde Descargas o desde la
    // cuarentena de traslocación, NO está instalada: las actualizaciones no
    // podrían sustituirla y al expulsar el .dmg desaparecería. Como hacen
    // muchas apps de Mac, se ofrece instalarla en Aplicaciones con un clic
    // (sustituyendo la versión anterior), y se reabre desde allí. Sin terminal.
    #[cfg(target_os = "macos")]
    {
        use std::io::IsTerminal;
        let info = rami_node::update::install_info();
        if info.can_install && !has(&args, "--no-install") && !std::io::stdin().is_terminal() {
            dlog(&format!("la app corre desde «{}» ({}); ofrezco instalarla", info.bundle, info.location));
            let yes = native_ask("RAMI-Chain", native_text("install.q"), native_text("btn.later"), native_text("btn.install"));
            if yes {
                // Cierra la versión anterior si está abierta (puerto del panel).
                for p in dash_port..dash_port.saturating_add(10) {
                    if let Some(body) = http::probe_local(p) {
                        if body.contains("network_id") || body.contains("starting") {
                            dlog(&format!("cierro el monedero anterior del puerto {p}"));
                            ask_other_to_quit(p, pid_in(&body));
                        }
                    }
                }
                match rami_node::update::self_install() {
                    Ok(dest) => {
                        dlog(&format!("instalada en {}; me reabro desde ahí", dest.display()));
                        match rami_node::update::relaunch_after_exit_with(&dest, &["--no-install"]) {
                            Ok(()) => return ExitCode::SUCCESS,
                            Err(e) => native_dialog(
                                "RAMI-Chain",
                                &native_text("installed.noreopen").replace("{dest}", &dest.display().to_string()).replace("{e}", &e),
                            ),
                        }
                        return ExitCode::SUCCESS;
                    }
                    Err(e) => {
                        dlog(&format!("instalación fallida: {e}"));
                        native_dialog("RAMI-Chain", &native_text("install.failed").replace("{e}", &e));
                    }
                }
            } else {
                dlog("el usuario prefirió no instalar ahora");
            }
        }
    }

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
                        let other = version_in(&body).unwrap_or_default();
                        if other != env!("CARGO_PKG_VERSION") {
                            // Otra VERSIÓN abierta (p. ej. la anterior tras
                            // instalar esta): le pedimos que se cierre y esta
                            // toma su sitio. Antes, la nueva abría el panel
                            // viejo y salía: parecía que «no se actualizaba».
                            dlog(&format!("monedero v{other} abierto en {p}; le pido que se cierre y tomo su sitio"));
                            if ask_other_to_quit(p, pid_in(&body)) {
                                if let Ok(l) = TcpListener::bind(("127.0.0.1", p)) {
                                    bound = Some((l, p));
                                    break;
                                }
                            }
                            dlog(&format!("el monedero v{other} no liberó el puerto {p}; pruebo el siguiente"));
                            continue;
                        }
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
                    lan_discovery,
                    portmap,
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
                    // Semillas publicadas en la web (quantbot.army/descargas/seeds.json):
                    // se consultan al arrancar y cada 15 minutos.
                    if web_seeds_on {
                        let h2 = h.clone();
                        std::thread::spawn(move || loop {
                            let list = rami_node::seeds::fetch_web_seeds();
                            if !list.is_empty() {
                                dlog(&format!("semillas web: {}", list.join(", ")));
                            }
                            for s in list {
                                h2.add_peer(s);
                            }
                            std::thread::sleep(std::time::Duration::from_secs(900));
                        });
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

    #[cfg(target_os = "macos")]
    cocoa::set_panel_url(url.clone());
    open_browser(&url);

    http::serve(listener, move |req| route(&gui, req));
    ExitCode::SUCCESS
}
