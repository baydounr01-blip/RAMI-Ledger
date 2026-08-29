//! rami-node — nodo de RAMI-Chain: génesis, minería, estado y verificación.
//!
//! v0.1 es un nodo de una sola máquina (persistencia en disco, minería local,
//! mempool en fichero). El gossip P2P por TCP JSON-lines queda como v0.2 (el tipo
//! de mensajes es agnóstico del transporte; ver docs). Uso:
//!
//!   rami-node init   --chain DIR [--network testnet|regtest] [--miner HEXPUB]
//!   rami-node mine   --chain DIR --address HEXPUB [--blocks N]
//!   rami-node status --chain DIR
//!   rami-node verify --chain DIR
//!   rami-node show   --chain DIR [N]
//!
//! La red neuronal (rami_core::nn) es SOLO asesora: este nodo acepta o rechaza
//! bloques únicamente por las reglas de consenso sobre los bytes.

use std::collections::HashMap;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use rami_core::block::{Block, BlockHeader, Hash, ZERO_HASH};
use rami_core::params::Params;
use rami_core::pow::{difficulty_from_bits, meets_target, pow_hash};
use rami_core::state::{block_reward, State, COIN};
use rami_core::store::ChainDir;
use rami_core::tx::{merkle_root_txids, txid, verify_tx, AccountId, Tx, TxId};

const CHANCELLOR: &str = "RAMI-Chain genesis — el pasado, el presente y el futuro coexisten. Red experimental, sin valor monetario.";

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn die(msg: &str) -> ExitCode {
    eprintln!("✗ {msg}");
    ExitCode::FAILURE
}

/// Lee `--flag valor` de forma sencilla (sin dependencias).
fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}
fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn parse_pubkey(hexs: &str) -> Result<AccountId, String> {
    let v = hex::decode(hexs.trim_start_matches("rami1")).map_err(|_| "dirección no es hex".to_string())?;
    if v.len() != 32 {
        return Err("la dirección debe ser la clave pública de 32 bytes (64 hex)".into());
    }
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    Ok(a)
}

fn params_of(args: &[String]) -> Params {
    match arg(args, "--network").as_deref() {
        Some("testnet") => Params::testnet(),
        _ => Params::regtest(),
    }
}

/// Minería: busca un nonce que cumpla el objetivo (bits). Devuelve la cabecera.
fn mine_header(mut header: BlockHeader) -> BlockHeader {
    loop {
        let h = pow_hash(&header.canonical_bytes());
        if meets_target(&h, header.bits) {
            return header;
        }
        header.nonce = header.nonce.wrapping_add(1);
        // refresca el timestamp de vez en cuando para no quedarse obsoleto
        if header.nonce % 2_000_000 == 0 {
            header.timestamp = now_secs();
        }
    }
}

/// Construye un bloque válido a la altura `height` sobre `prev`, incluyendo del
/// mempool las tx que apliquen limpiamente contra `state`.
fn build_block(
    height: u64,
    prev: Hash,
    bits: u32,
    miner: AccountId,
    state: &State,
    mempool: &[Tx],
    tag: [u8; 4],
) -> (Block, Vec<TxId>) {
    // Selección de mempool: simula el estado para descartar las que no aplican.
    let mut sim = state.clone();
    let mut included: Vec<Tx> = Vec::new();
    let mut fees: u128 = 0;
    for tx in mempool {
        if verify_tx(tx).is_err() {
            continue;
        }
        // prueba de aplicación en un bloque de una sola tx (barata, aproximada)
        if try_apply(&mut sim, tx, height, included.len() + 1).is_ok() {
            let fee = tx_fee(tx);
            fees += fee as u128;
            included.push(tx.clone());
        }
    }
    let reward = (block_reward(height) as u128 + fees).min(u64::MAX as u128) as u64;
    let coinbase = Tx::Coinbase { height, to: miner, reward, memo: CHANCELLOR.as_bytes().to_vec() };

    let mut txs = vec![coinbase];
    txs.extend(included);
    let ids: Vec<TxId> = txs.iter().map(txid).collect();
    let merkle_root = merkle_root_txids(&ids);
    let header = mine_header(BlockHeader {
        version: 1,
        prev_hash: prev,
        height,
        timestamp: now_secs(),
        merkle_root,
        bits,
        nonce: 0,
        branch_tag: tag,
    });
    let included_ids = ids;
    (Block { header, txs }, included_ids)
}

fn tx_fee(tx: &Tx) -> u64 {
    match tx {
        Tx::Coinbase { .. } => 0,
        Tx::Transfer { fee, .. }
        | Tx::Stake { fee, .. }
        | Tx::Unstake { fee, .. }
        | Tx::Commit { fee, .. }
        | Tx::Reveal { fee, .. } => *fee,
    }
}

/// Aplica una sola tx a `sim` (para selección de mempool). Reutiliza la
/// transición real envolviéndola en un bloque de prueba.
fn try_apply(sim: &mut State, tx: &Tx, _height: u64, _idx: usize) -> Result<(), String> {
    // No podemos llamar apply_block por tx suelta; replicamos la comprobación
    // económica mínima que la selección necesita: nonce y saldo.
    match tx {
        Tx::Transfer { from, amount, fee, nonce, .. } => {
            if *nonce != sim.nonce_of(from) {
                return Err("nonce".into());
            }
            if (sim.balance_of(from) as u128) < (*amount as u128 + *fee as u128) {
                return Err("saldo".into());
            }
            let a = sim.accounts.entry(*from).or_default();
            a.nonce += 1;
            a.balance -= amount + fee;
            sim.accounts.entry(match tx { Tx::Transfer { to, .. } => *to, _ => unreachable!() }).or_default().balance += *amount;
            Ok(())
        }
        Tx::Stake { who, amount, fee, nonce, .. }
        | Tx::Unstake { who, amount, fee, nonce, .. } => {
            if *nonce != sim.nonce_of(who) {
                return Err("nonce".into());
            }
            if (sim.balance_of(who) as u128) < (*amount as u128 + *fee as u128) {
                return Err("saldo".into());
            }
            sim.accounts.entry(*who).or_default().nonce += 1;
            Ok(())
        }
        Tx::Commit { by, fee, nonce, .. } | Tx::Reveal { by, fee, nonce, .. } => {
            if *nonce != sim.nonce_of(by) {
                return Err("nonce".into());
            }
            if (sim.balance_of(by) as u128) < (*fee as u128) {
                return Err("saldo".into());
            }
            sim.accounts.entry(*by).or_default().nonce += 1;
            Ok(())
        }
        Tx::Coinbase { .. } => Err("coinbase no va en mempool".into()),
    }
}

fn cmd_init(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let params = params_of(args);
    let miner = match arg(args, "--miner") {
        Some(m) => match parse_pubkey(&m) {
            Ok(a) => a,
            Err(e) => return die(&e),
        },
        None => [0u8; 32], // dirección quemada: el subsidio de génesis no es de nadie
    };
    let chain = ChainDir::new(&dir);
    if chain.exists() {
        return die("la cadena ya existe en ese directorio");
    }
    // Génesis: coinbase con el mensaje del chancellor. Sin premine: el faucet se
    // financia MINANDO como cualquiera (no hay excepción a la cota de emisión).
    let reward = block_reward(0);
    let coinbase = Tx::Coinbase { height: 0, to: miner, reward, memo: CHANCELLOR.as_bytes().to_vec() };
    let ids = vec![txid(&coinbase)];
    let merkle_root = merkle_root_txids(&ids);
    let header = mine_header(BlockHeader {
        version: 1,
        prev_hash: ZERO_HASH,
        height: 0,
        timestamp: now_secs(),
        merkle_root,
        bits: params.genesis_bits,
        nonce: 0,
        branch_tag: *b"gen0",
    });
    let genesis = Block { header, txs: vec![coinbase] };
    if let Err(e) = chain.init(&genesis) {
        return die(&e);
    }
    let net = if arg(args, "--network").as_deref() == Some("testnet") { "testnet" } else { "regtest" };
    println!("✓ génesis #{} {}", 0, hex::encode(&genesis.hash()[..16]));
    println!("  red      : {net}");
    println!("  network-id (hash de génesis): {}", hex::encode(genesis.hash()));
    println!("  bits     : {:#010x}  dificultad {}", genesis.header.bits, difficulty_from_bits(genesis.header.bits));
    println!("  mensaje  : {CHANCELLOR}");
    println!("  chain    : {}", chain.chain_path().display());
    ExitCode::SUCCESS
}

fn cmd_mine(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(addr) = arg(args, "--address") else { return die("falta --address HEXPUB (a quién pagar)") };
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
        let head_node = tree.get(&head).unwrap();
        let height = head_node.block.header.height + 1;
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
    // Vacía el mempool (las tx incluidas ya están en cadena).
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
    // suministro circulante = suma de balances + staked
    let mut supply: u128 = 0;
    for acc in state.accounts.values() {
        supply += acc.balance as u128 + acc.staked as u128;
    }
    println!("[STATUS] RAMI-Chain");
    println!("  altura        : {}", node.block.header.height);
    println!("  head          : {}", hex::encode(head));
    println!("  trabajo acum. : {}", node.cum_work);
    println!("  dificultad    : {}", difficulty_from_bits(node.block.header.bits));
    println!("  bloques (árbol): {}  puntas: {}", tree.len(), tree.tips().len());
    println!("  suministro    : {}.{:08} RAMI", supply / COIN as u128, supply % COIN as u128);
    ExitCode::SUCCESS
}

fn cmd_verify(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let params = params_of(args);
    let chain = ChainDir::new(&dir);
    // load_tree re-admite cada bloque con todas las reglas: si carga, es válida.
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
    let mut by_height: HashMap<u64, ()> = HashMap::new();
    for b in &blocks[start..] {
        by_height.insert(b.header.height, ());
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
        eprintln!("uso: rami-node init|mine|status|verify|show [opciones]");
        return ExitCode::FAILURE;
    };
    let _ = has; // silencia si no se usa en algún build
    match cmd.as_str() {
        "init" => cmd_init(&args[2..]),
        "mine" => cmd_mine(&args[2..]),
        "status" => cmd_status(&args[2..]),
        "verify" => cmd_verify(&args[2..]),
        "show" => cmd_show(&args[2..]),
        other => die(&format!("subcomando desconocido: {other}")),
    }
}
