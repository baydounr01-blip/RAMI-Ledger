//! rami-node — nodo de RAMI-Chain (CLI).
//!
//!   rami-node init   --chain DIR [--network testnet|regtest] [--miner HEXPUB]
//!   rami-node run    --chain DIR [--network testnet] [--listen PORT]
//!                    [--connect host:port]... [--miner HEXPUB] [--mine]
//!   rami-node mine   --chain DIR --address HEXPUB [--blocks N]
//!   rami-node status --chain DIR
//!   rami-node verify --chain DIR
//!   rami-node show   --chain DIR [N]
//!
//! `run` es el demonio P2P v0.2: escucha, marca pares, sincroniza y (opcional)
//! mina en segundo plano. `mine` sigue siendo la minería local por lotes de v0.1.
//! La red neuronal (rami_core::nn) es SOLO asesora.

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
        eprintln!("uso: rami-node init|run|mine|status|verify|show [opciones]");
        return ExitCode::FAILURE;
    };
    match cmd.as_str() {
        "init" => cmd_init(&args[2..]),
        "run" => cmd_run(&args[2..]),
        "mine" => cmd_mine(&args[2..]),
        "status" => cmd_status(&args[2..]),
        "verify" => cmd_verify(&args[2..]),
        "show" => cmd_show(&args[2..]),
        other => die(&format!("subcomando desconocido: {other}")),
    }
}
