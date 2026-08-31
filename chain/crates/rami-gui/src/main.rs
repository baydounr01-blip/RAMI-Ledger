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

use rami_node::http;

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::sync::Arc;

use rami_core::crypto::{address_from_pubkey, KeyPair};
use rami_core::params::Params;
use rami_core::tx::txid;

use rami_node::{spawn, NodeConfig, NodeHandle};
use rami_wallet::{
    build_commit, build_reveal, build_stake, build_transfer, default_keystore_path, fmt_ram,
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

struct Gui {
    node: NodeHandle,
    chain_dir: PathBuf,
    ks_path: String,
    label: String,
    wallet: std::sync::Mutex<WalletState>,
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

fn route(g: &Gui, req: Request) -> Response {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => Response::html(DASHBOARD),

        ("GET", "/api/status") => {
            let w = g.wallet.lock().unwrap();
            let s = g.node.status();
            let mut v = serde_json::to_value(&s).unwrap_or_else(|_| json!({}));
            v["version"] = json!(env!("CARGO_PKG_VERSION"));
            let mut wallet = json!({ "state": w.state(), "encrypted": w.encrypted });
            if let Some(pk) = w.pubkey {
                let acc = g.node.account(pk);
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
            let mut w = g.wallet.lock().unwrap();
            if w.pubkey.is_some() {
                return err("ya existe un monedero en esta máquina");
            }
            let mut ks = Keystore::load(&g.ks_path);
            match ks.create(&g.label, Some(&pw)) {
                Ok(kp) => {
                    let pk = kp.public_bytes();
                    g.node.set_miner(pk);
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
            let mut w = g.wallet.lock().unwrap();
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
            let mut w = g.wallet.lock().unwrap();
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
            let mut w = g.wallet.lock().unwrap();
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
            let n = req.query_get("n").and_then(|s| s.parse().ok()).unwrap_or(15);
            Response::json(&json!({"blocks": g.node.recent_blocks(n)}))
        }

        ("GET", "/api/block") => {
            let Some(h) = req.query_get("height").and_then(|s| s.parse::<u64>().ok()) else {
                return err("falta ?height=N");
            };
            match g.node.block(h) {
                Some(b) => Response::json(&json!({"ok": true, "block": b})),
                None => err("bloque no encontrado en la cadena del observador"),
            }
        }

        ("POST", "/api/mine") => {
            let on = body_json(&req).get("on").and_then(|v| v.as_bool()).unwrap_or(false);
            g.node.set_mining(on);
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
            let w = g.wallet.lock().unwrap();
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let nonce = g.node.next_nonce(kp.public_bytes());
            let tx = build_transfer(kp, to, amount, fee_of(&b), nonce);
            match g.node.submit_tx(tx) {
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
            let w = g.wallet.lock().unwrap();
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let nonce = g.node.next_nonce(kp.public_bytes());
            let tx = build_stake(kp, amount, fee_of(&b), nonce, unstake);
            match g.node.submit_tx(tx) {
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
            let w = g.wallet.lock().unwrap();
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let nonce = g.node.next_nonce(kp.public_bytes());
            let (tx, secret) = match build_commit(kp, &payload, fee_of(&b), nonce) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            let cid = txid(&tx);
            save_reveal(&g.chain_dir, &cid, &payload, &secret);
            match g.node.submit_tx(tx) {
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
            let w = g.wallet.lock().unwrap();
            let Some(kp) = w.kp.as_ref() else { return err("monedero bloqueado: desbloquéalo con tu contraseña") };
            let nonce = g.node.next_nonce(kp.public_bytes());
            let tx = build_reveal(kp, commit_txid, &payload, secret, fee_of(&b), nonce);
            match g.node.submit_tx(tx) {
                Ok(id) => Response::json(&json!({"ok": true, "txid": id})),
                Err(e) => err(e),
            }
        }

        ("POST", "/api/peer") => {
            let b = body_json(&req);
            let addr = b.get("addr").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if addr.is_empty() {
                return err("dirección vacía");
            }
            g.node.add_peer(addr);
            Response::json(&json!({"ok": true}))
        }

        _ => Response::not_found(),
    }
}

fn open_browser(url: &str) {
    let _ = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        Command::new("xdg-open").arg(url).spawn()
    };
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let is_testnet = arg(&args, "--network").as_deref() != Some("regtest"); // testnet por defecto
    let params = if is_testnet { Params::testnet() } else { Params::regtest() };
    let net_name = if is_testnet { "testnet" } else { "regtest" };

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
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
    let encrypted = ks.is_encrypted();
    let pubkey = ks.public_key(&label);
    let kp = if !encrypted {
        pubkey.and_then(|_| ks.keypair(&label, None).ok()) // legado en claro => desbloqueado
    } else {
        None // cifrado => bloqueado hasta que el usuario desbloquee
    };
    let wallet = WalletState { pubkey, kp, encrypted };
    let wstate = wallet.state();

    // Nodo: mina hacia el monedero si ya hay pubkey; si no, se fija tras el setup.
    let node = match spawn(NodeConfig {
        chain_dir: chain_dir.clone(),
        params,
        is_testnet,
        listen: Some(p2p_port),
        seeds: seeds.clone(),
        miner: pubkey,
        mining: false,
    }) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("✗ nodo: {e}");
            return ExitCode::FAILURE;
        }
    };

    let listener = match TcpListener::bind(("127.0.0.1", dash_port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("✗ no se pudo abrir el panel en 127.0.0.1:{dash_port}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let url = format!("http://127.0.0.1:{dash_port}");
    let s = node.status();
    println!("● RAMI-Chain — monedero de escritorio ({net_name})");
    println!("  panel      : {url}");
    match pubkey {
        Some(pk) => println!("  dirección  : {}", hex::encode(pk)),
        None => println!("  monedero   : sin crear — el panel pedirá una contraseña"),
    }
    println!("  monedero   : estado «{wstate}»");
    println!("  network-id : {}", s.network_id);
    println!("  P2P        : 0.0.0.0:{}", s.listen_port);
    if !seeds.is_empty() {
        println!("  seeds      : {}", seeds.join(", "));
    }
    println!("  cadena     : {}", chain_dir.display());
    println!("  ⚠ TESTNET experimental — sin valor monetario, no es una inversión.");
    println!("  (Ctrl-C para salir)");

    if !has(&args, "--no-open") {
        open_browser(&url);
    }

    let gui = Arc::new(Gui {
        node,
        chain_dir,
        ks_path: keystore_path,
        label,
        wallet: std::sync::Mutex::new(wallet),
    });
    http::serve(listener, move |req| route(&gui, req));
    ExitCode::SUCCESS
}
