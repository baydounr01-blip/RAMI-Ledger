//! rami-node — nodo de RAMI-Chain (CLI).
//!
//!   rami-node init   --chain DIR [--network testnet|regtest] [--miner HEXPUB]
//!   rami-node run    --chain DIR [--network testnet] [--listen PORT]
//!                    [--connect host:port]... [--miner HEXPUB] [--mine]
//!   rami-node mine   --chain DIR --address HEXPUB [--blocks N]
//!   rami-node faucet --chain DIR [--network testnet] [--port 8700] [--bind IP]
//!                    [--keystore F] [--label L] [--drip RAMI] [--cooldown SEG]
//!   rami-node status --chain DIR
//!   rami-node verify --chain DIR
//!   rami-node show   --chain DIR [N]
//!
//! `run` es el demonio P2P: escucha, marca pares, sincroniza y (opcional) mina.
//! `faucet` es el grifo de UN OPERADOR: reparte monedas de su propio monedero
//! (financiado minando) con goteo y espera por dirección — un monedero normal,
//! JAMÁS una excepción de consenso. La red neuronal (rami_core::nn) es SOLO asesora.

use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use rami_core::params::Params;
use rami_core::pow::difficulty_from_bits;
use rami_core::state::COIN;
use rami_core::store::ChainDir;

use rami_node::{build_block, make_genesis, parse_pubkey, spawn, NodeConfig};

fn die(msg: &str) -> ExitCode {
    eprintln!("✗ {msg}");
    ExitCode::FAILURE
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
fn is_testnet(args: &[String]) -> bool {
    arg(args, "--network").as_deref() == Some("testnet")
}
fn params_of(args: &[String]) -> Params {
    if is_testnet(args) {
        Params::testnet()
    } else {
        Params::regtest()
    }
}

fn cmd_init(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let params = params_of(args);
    let testnet = is_testnet(args);
    let miner = match arg(args, "--miner") {
        Some(m) => match parse_pubkey(&m) {
            Ok(a) => a,
            Err(e) => return die(&e),
        },
        None => [0u8; 32],
    };
    let chain = ChainDir::new(&dir);
    if chain.exists() {
        return die("la cadena ya existe en ese directorio");
    }
    let genesis = make_genesis(testnet, params, miner);
    if let Err(e) = chain.init(&genesis) {
        return die(&e);
    }
    println!("✓ génesis #0 {}", hex::encode(&genesis.hash()[..16]));
    println!("  red        : {}", if testnet { "testnet" } else { "regtest" });
    println!("  network-id : {}", hex::encode(genesis.hash()));
    println!(
        "  bits       : {:#010x}  dificultad {}",
        genesis.header.bits,
        difficulty_from_bits(genesis.header.bits)
    );
    println!("  chain      : {}", chain.chain_path().display());
    if testnet {
        println!("  (génesis canónico fijo: todos los nodos de testnet comparten este network-id)");
    }
    ExitCode::SUCCESS
}

fn cmd_run(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let params = params_of(args);
    let testnet = is_testnet(args);
    let listen: Option<u16> = arg(args, "--listen").and_then(|s| s.parse().ok()).or(Some(30301));
    let seeds = args_all(args, "--connect");
    let miner = match arg(args, "--miner") {
        Some(m) => match parse_pubkey(&m) {
            Ok(a) => Some(a),
            Err(e) => return die(&e),
        },
        None => None,
    };
    let mining = has(args, "--mine");
    if mining && miner.is_none() {
        return die("--mine requiere --miner HEXPUB (a quién pagar la recompensa)");
    }
    let cfg = NodeConfig {
        chain_dir: dir.into(),
        params,
        is_testnet: testnet,
        listen,
        seeds: seeds.clone(),
        miner,
        mining,
    };
    let handle = match spawn(cfg) {
        Ok(h) => h,
        Err(e) => return die(&e),
    };
    let s0 = handle.status();
    println!("● rami-node en marcha ({})", s0.network);
    println!("  network-id : {}", s0.network_id);
    println!("  escuchando : 0.0.0.0:{}", s0.listen_port);
    if !seeds.is_empty() {
        println!("  seeds      : {}", seeds.join(", "));
    }
    println!("  minería    : {}", if mining { "ON" } else { "off" });
    println!("  (Ctrl-C para salir)\n");
    loop {
        thread::sleep(Duration::from_secs(3));
        let s = handle.status();
        println!(
            "altura {:>6}  head {}  pares {:>2}  {}  mempool {:>3}  dif {}  {}",
            s.height,
            &s.head[..12.min(s.head.len())],
            s.peers.len(),
            if s.synced { "sinc" } else { "SYNC" },
            s.mempool,
            s.difficulty,
            if s.mining { format!("⛏ {} H/s (+{})", s.hashrate, s.found) } else { String::new() }
        );
    }
}

fn cmd_mine(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(addr) = arg(args, "--address") else { return die("falta --address HEXPUB") };
    let miner = match parse_pubkey(&addr) {
        Ok(a) => a,
        Err(e) => return die(&e),
    };
    let blocks: u64 = arg(args, "--blocks").and_then(|s| s.parse().ok()).unwrap_or(1);
    let params = params_of(args);
    let chain = ChainDir::new(&dir);
    let mut tree = match chain.load_tree(params) {
        Ok(t) => t,
        Err(e) => return die(&e),
    };
    let mempool = chain.load_mempool();
    for _ in 0..blocks {
        let head = tree.head();
        let height = tree.get(&head).unwrap().block.header.height + 1;
        let bits = tree.expected_bits(&head);
        let state = match tree.head_state() {
            Ok(s) => s,
            Err(e) => return die(&e),
        };
        let (block, _ids) = build_block(height, head, bits, miner, &state, &mempool, *b"main");
        match tree.insert(block.clone()) {
            Ok(h) => {
                if let Err(e) = chain.append_block(&block) {
                    return die(&e);
                }
                println!(
                    "⛏  #{height} {}  {} tx  dificultad {}",
                    hex::encode(&h[..12]),
                    block.txs.len(),
                    difficulty_from_bits(bits)
                );
            }
            Err(e) => return die(&format!("bloque inválido al insertar: {e}")),
        }
    }
    let _ = chain.clear_mempool();
    println!("✓ minados {blocks} bloque(s). Altura {}", tree.get(&tree.head()).unwrap().block.header.height);
    ExitCode::SUCCESS
}

/// Faucet de operador: HTTP mínimo que firma transfers desde el keystore del
/// operador y los deja en el mempool del nodo (que corre aparte con `run`).
/// Goteo limitado y espera por dirección, persistida en faucet_claims.json.
fn cmd_faucet(args: &[String]) -> ExitCode {
    use rami_node::http::{self, Request, Response};
    use rami_wallet::{build_transfer, default_keystore_path, fmt_ram, parse_pubkey as wparse, parse_ram, Keystore};
    use std::collections::HashMap;
    use std::net::TcpListener;
    use std::sync::Mutex;

    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let params = params_of(args);
    let port: u16 = arg(args, "--port").and_then(|s| s.parse().ok()).unwrap_or(8700);
    let bind = arg(args, "--bind").unwrap_or_else(|| "127.0.0.1".into());
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    let keystore = arg(args, "--keystore").unwrap_or_else(default_keystore_path);
    let drip = match parse_ram(&arg(args, "--drip").unwrap_or_else(|| "10".into())) {
        Ok(v) => v,
        Err(e) => return die(&e),
    };
    let cooldown: u64 = arg(args, "--cooldown").and_then(|s| s.parse().ok()).unwrap_or(3600);

    let kp = match Keystore::load(&keystore).keypair(&label) {
        Ok(k) => k,
        Err(e) => return die(&format!("keystore: {e}")),
    };
    let me = kp.public_bytes();
    let chain = ChainDir::new(&dir);
    let claims_path = chain.root.join("faucet_claims.json");
    let claims: Mutex<HashMap<String, u64>> = Mutex::new(
        std::fs::read_to_string(&claims_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
    );

    let listener = match TcpListener::bind((bind.as_str(), port)) {
        Ok(l) => l,
        Err(e) => return die(&format!("no se pudo escuchar en {bind}:{port}: {e}")),
    };
    println!("● faucet de RAMI-Chain en http://{bind}:{port}");
    println!("  paga desde : {}", hex::encode(me));
    println!("  goteo      : {} RAMI · espera {cooldown}s por dirección", fmt_ram(drip));
    println!("  ⚠ reparte monedas SIN VALOR de la testnet; nunca pide pago.");

    let dir2 = dir.clone();
    http::serve(listener, move |req: Request| -> Response {
        let chain = ChainDir::new(&dir2);
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/") => {
                let balance = chain
                    .load_tree(params)
                    .ok()
                    .and_then(|t| t.head_state().ok())
                    .map(|s| s.balance_of(&me))
                    .unwrap_or(0);
                Response::json(&serde_json::json!({
                    "name": "RAMI-Chain faucet",
                    "drip_ram": fmt_ram(drip),
                    "cooldown_secs": cooldown,
                    "faucet_address": hex::encode(me),
                    "faucet_balance": fmt_ram(balance),
                    "notice": "Monedas de prueba SIN valor monetario. Este faucet nunca pide pago."
                }))
            }
            ("POST", "/claim") => {
                let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
                let addr_s = body.get("address").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                let to = match wparse(&addr_s) {
                    Ok(a) => a,
                    Err(e) => return Response::json(&serde_json::json!({"ok": false, "error": e})),
                };
                let now = rami_node::now_secs();
                {
                    let mut g = claims.lock().unwrap();
                    if let Some(last) = g.get(&addr_s) {
                        if now.saturating_sub(*last) < cooldown {
                            let wait = cooldown - now.saturating_sub(*last);
                            return Response::json(&serde_json::json!({
                                "ok": false,
                                "error": format!("espera {wait}s antes de volver a pedir (o mina tú mismo)")
                            }));
                        }
                    }
                    g.insert(addr_s.clone(), now);
                    let _ = std::fs::write(&claims_path, serde_json::to_string(&*g).unwrap_or_default());
                }
                // nonce = estado + pendientes del faucet en el mempool
                let (nonce, balance) = match chain.load_tree(params).and_then(|t| t.head_state()) {
                    Ok(st) => {
                        let pending = chain
                            .load_mempool()
                            .iter()
                            .filter(|t| rami_core::tx::signer_of(t) == Some(&me))
                            .count() as u64;
                        (st.nonce_of(&me) + pending, st.balance_of(&me))
                    }
                    Err(e) => return Response::json(&serde_json::json!({"ok": false, "error": e})),
                };
                if balance < drip + 1 {
                    return Response::json(&serde_json::json!({
                        "ok": false,
                        "error": "faucet sin fondos ahora mismo — mina tú mismo desde el monedero: es la vía principal"
                    }));
                }
                let tx = build_transfer(&kp, to, drip, 1, nonce);
                let id = hex::encode(rami_core::tx::txid(&tx));
                match chain.append_mempool(&tx) {
                    Ok(()) => Response::json(&serde_json::json!({
                        "ok": true, "txid": id, "drip": fmt_ram(drip),
                        "note": "se incluirá cuando el nodo mine el próximo bloque"
                    })),
                    Err(e) => Response::json(&serde_json::json!({"ok": false, "error": e})),
                }
            }
            _ => Response::not_found(),
        }
    });
    ExitCode::SUCCESS
}

fn cmd_status(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let params = params_of(args);
    let chain = ChainDir::new(&dir);
    let tree = match chain.load_tree(params) {
        Ok(t) => t,
        Err(e) => return die(&e),
    };
    let head = tree.head();
    let node = tree.get(&head).unwrap();
    let state = tree.head_state().unwrap_or_default();
    let mut supply: u128 = 0;
    for acc in state.accounts.values() {
        supply += acc.balance as u128 + acc.staked as u128;
    }
    println!("[STATUS] RAMI-Chain");
    println!("  altura         : {}", node.block.header.height);
    println!("  head           : {}", hex::encode(head));
    println!("  trabajo acum.  : {}", node.cum_work);
    println!("  dificultad     : {}", difficulty_from_bits(node.block.header.bits));
    println!("  bloques (árbol): {}  puntas: {}", tree.len(), tree.tips().len());
    println!("  suministro     : {}.{:08} RAMI", supply / COIN as u128, supply % COIN as u128);
    ExitCode::SUCCESS
}

fn cmd_verify(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let params = params_of(args);
    let chain = ChainDir::new(&dir);
    match chain.load_tree(params) {
        Ok(tree) => {
            println!(
                "✓ cadena íntegra: {} bloques, altura {}, head {}",
                tree.len(),
                tree.get(&tree.head()).unwrap().block.header.height,
                hex::encode(&tree.head()[..16])
            );
            ExitCode::SUCCESS
        }
        Err(e) => die(&format!("cadena INVÁLIDA: {e}")),
    }
}

fn cmd_show(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let n: usize = args.iter().rev().find_map(|a| a.parse::<usize>().ok()).unwrap_or(5);
    let chain = ChainDir::new(&dir);
    let blocks = match chain.load_blocks() {
        Ok(b) => b,
        Err(e) => return die(&e),
    };
    let start = blocks.len().saturating_sub(n);
    for b in &blocks[start..] {
        println!(
            "#{:<5} {}  {} tx  bits {:#010x}  {}",
            b.header.height,
            hex::encode(&b.hash()[..12]),
            b.txs.len(),
            b.header.bits,
            if b.header.height == 0 { "GÉNESIS" } else { "" }
        );
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let Some(cmd) = args.get(1) else {
        eprintln!("uso: rami-node init|run|mine|faucet|status|verify|show [opciones]");
        return ExitCode::FAILURE;
    };
    match cmd.as_str() {
        "init" => cmd_init(&args[2..]),
        "run" => cmd_run(&args[2..]),
        "mine" => cmd_mine(&args[2..]),
        "faucet" => cmd_faucet(&args[2..]),
        "status" => cmd_status(&args[2..]),
        "verify" => cmd_verify(&args[2..]),
        "show" => cmd_show(&args[2..]),
        other => die(&format!("subcomando desconocido: {other}")),
    }
}
