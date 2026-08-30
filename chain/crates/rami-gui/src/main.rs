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

struct Gui {
    node: NodeHandle,
    kp: KeyPair,
    chain_dir: PathBuf,
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

fn route(g: &Gui, req: Request) -> Response {
    let pubkey = g.kp.public_bytes();
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => Response::html(DASHBOARD),

        ("GET", "/api/status") => {
            let s = g.node.status();
            let acc = g.node.account(pubkey);
            let mut v = serde_json::to_value(&s).unwrap_or_else(|_| json!({}));
            v["version"] = json!(env!("CARGO_PKG_VERSION"));
            v["wallet"] = json!({
                "address": hex::encode(pubkey),
                "short": address_from_pubkey(&pubkey),
                "balance": fmt_ram(acc.balance),
                "staked": fmt_ram(acc.staked),
                "nonce": acc.nonce,
            });
            Response::json(&v)
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
            let nonce = g.node.next_nonce(pubkey);
            let tx = build_transfer(&g.kp, to, amount, fee_of(&b), nonce);
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
            let nonce = g.node.next_nonce(pubkey);
            let tx = build_stake(&g.kp, amount, fee_of(&b), nonce, unstake);
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
            let nonce = g.node.next_nonce(pubkey);
            let (tx, secret) = match build_commit(&g.kp, &payload, fee_of(&b), nonce) {
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
            let nonce = g.node.next_nonce(pubkey);
            let tx = build_reveal(&g.kp, commit_txid, &payload, secret, fee_of(&b), nonce);
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

    // Monedero: crea la clave por defecto si no existe (listo para usar).
    let keystore_path = arg(&args, "--keystore").unwrap_or_else(default_keystore_path);
    let mut ks = Keystore::load(&keystore_path);
    let kp = match ks.get_or_create(&label) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("✗ monedero: {e}");
            return ExitCode::FAILURE;
        }
    };
    let pubkey = kp.public_bytes();

    // Nodo: mina hacia ESTE monedero (minería apagada hasta que el usuario la active).
    let node = match spawn(NodeConfig {
        chain_dir: chain_dir.clone(),
        params,
        is_testnet,
        listen: Some(p2p_port),
        seeds: seeds.clone(),
        miner: Some(pubkey),
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
    println!("  dirección  : {}", hex::encode(pubkey));
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

    let gui = Arc::new(Gui { node, kp, chain_dir });
    http::serve(listener, move |req| route(&gui, req));
    ExitCode::SUCCESS
}
