//! rami-wallet — monedero de RAMI-Chain (CLI). Firma y deja las tx en el
//! mempool del nodo (mempool.jsonl); el nodo las incluye al minar.
//!
//! AVISO: claves en TEXTO PLANO. TESTNET sin valor monetario.
//!
//!   rami-wallet new      [--keystore F] [--label L]
//!   rami-wallet address  [--keystore F] [--label L]
//!   rami-wallet balance  --chain DIR [--keystore F | --address HEXPUB] [--network N]
//!   rami-wallet send     --chain DIR --to HEXPUB --amount RAMI [--fee ram] [--label L]
//!   rami-wallet stake    --chain DIR --amount RAMI [--fee ram] [--label L]
//!   rami-wallet unstake  --chain DIR --amount RAMI [--fee ram] [--label L]
//!   rami-wallet commit   --chain DIR --payload JSON [--fee ram] [--label L]
//!   rami-wallet reveal   --chain DIR --commit TXID [--fee ram] [--label L]

use std::process::ExitCode;

use rami_core::crypto::{address_from_pubkey, KeyPair};
use rami_core::params::Params;
use rami_core::store::ChainDir;
use rami_core::tx::{signer_of, txid, AccountId, Tx};

use rami_wallet::{
    build_commit, build_reveal, build_stake, build_transfer, default_keystore_path, fmt_ram,
    load_reveal, parse_pubkey, parse_ram, save_reveal, Keystore,
};

fn die(msg: &str) -> ExitCode {
    eprintln!("✗ {msg}");
    ExitCode::FAILURE
}
fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn keystore_of(args: &[String]) -> Keystore {
    let path = arg(args, "--keystore").unwrap_or_else(default_keystore_path);
    Keystore::load(path)
}
fn keypair_from(args: &[String]) -> Result<KeyPair, String> {
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    keystore_of(args).keypair(&label)
}
fn params_of(args: &[String]) -> Params {
    match arg(args, "--network").as_deref() {
        Some("testnet") => Params::testnet(),
        _ => Params::regtest(),
    }
}
fn fee_of(args: &[String]) -> u64 {
    arg(args, "--fee").and_then(|s| s.parse().ok()).unwrap_or(1)
}

/// nonce siguiente = nonce en cadena + tx pendientes de este firmante.
fn next_nonce(chain: &ChainDir, params: Params, me: &AccountId) -> Result<u64, String> {
    let tree = chain.load_tree(params)?;
    let base = tree.head_state()?.nonce_of(me);
    let pending = chain.load_mempool().iter().filter(|t| signer_of(t) == Some(me)).count() as u64;
    Ok(base + pending)
}

fn submit(chain: &ChainDir, tx: &Tx) -> ExitCode {
    if let Err(e) = chain.append_mempool(tx) {
        return die(&e);
    }
    println!("✓ tx {} enviada al mempool (se incluirá al minar)", hex::encode(&txid(tx)[..12]));
    ExitCode::SUCCESS
}

fn cmd_new(args: &[String]) -> ExitCode {
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    let mut ks = keystore_of(args);
    match ks.create(&label) {
        Ok(kp) => {
            println!("✓ clave '{label}' creada en {}", ks.path.display());
            println!("  dirección (pubkey) : {}", hex::encode(kp.public_bytes()));
            println!("  etiqueta corta     : {}", address_from_pubkey(&kp.public_bytes()));
            println!("  ⚠ TESTNET: clave en texto plano, sin valor monetario.");
            ExitCode::SUCCESS
        }
        Err(e) => die(&e),
    }
}

fn cmd_address(args: &[String]) -> ExitCode {
    match keypair_from(args) {
        Ok(kp) => {
            println!("{}", hex::encode(kp.public_bytes()));
            eprintln!("(etiqueta corta: {})", address_from_pubkey(&kp.public_bytes()));
            ExitCode::SUCCESS
        }
        Err(e) => die(&e),
    }
}

fn cmd_balance(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let me = match arg(args, "--address") {
        Some(a) => match parse_pubkey(&a) {
            Ok(p) => p,
            Err(e) => return die(&e),
        },
        None => match keypair_from(args) {
            Ok(kp) => kp.public_bytes(),
            Err(e) => return die(&e),
        },
    };
    let chain = ChainDir::new(&dir);
    let tree = match chain.load_tree(params_of(args)) {
        Ok(t) => t,
        Err(e) => return die(&e),
    };
    let st = tree.head_state().unwrap_or_default();
    let acc = st.accounts.get(&me).cloned().unwrap_or_default();
    println!("dirección : {}", hex::encode(me));
    println!("saldo     : {} RAMI", fmt_ram(acc.balance));
    println!("apostado  : {} RAMI", fmt_ram(acc.staked));
    println!("nonce     : {}", acc.nonce);
    ExitCode::SUCCESS
}

fn cmd_send(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(to_s) = arg(args, "--to") else { return die("falta --to HEXPUB") };
    let Some(amount_s) = arg(args, "--amount") else { return die("falta --amount RAMI") };
    let to = match parse_pubkey(&to_s) {
        Ok(p) => p,
        Err(e) => return die(&e),
    };
    let amount = match parse_ram(&amount_s) {
        Ok(a) => a,
        Err(e) => return die(&e),
    };
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let nonce = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    submit(&chain, &build_transfer(&kp, to, amount, fee_of(args), nonce))
}

fn cmd_stake(args: &[String], unstake: bool) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(amount_s) = arg(args, "--amount") else { return die("falta --amount RAMI") };
    let amount = match parse_ram(&amount_s) {
        Ok(a) => a,
        Err(e) => return die(&e),
    };
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let nonce = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    submit(&chain, &build_stake(&kp, amount, fee_of(args), nonce, unstake))
}

fn cmd_commit(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(payload_s) = arg(args, "--payload") else { return die("falta --payload JSON") };
    let payload: serde_json::Value = match serde_json::from_str(&payload_s) {
        Ok(v) => v,
        Err(_) => return die("payload no es JSON válido"),
    };
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let nonce = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    let (tx, secret) = match build_commit(&kp, &payload, fee_of(args), nonce) {
        Ok(v) => v,
        Err(e) => return die(&e),
    };
    let cid = txid(&tx);
    save_reveal(&chain.root, &cid, &payload, &secret);
    println!("✓ commit txid: {}", hex::encode(cid));
    println!("  (revela luego con: rami-wallet reveal --commit {})", hex::encode(cid));
    submit(&chain, &tx)
}

fn cmd_reveal(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(commit_s) = arg(args, "--commit") else { return die("falta --commit TXID") };
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let Some((payload, secret)) = load_reveal(&chain.root, &commit_s) else {
        return die("no tengo el secreto de ese commit (¿lo hiciste con este monedero?)");
    };
    let commit_txid = match hex::decode(&commit_s).ok().filter(|v| v.len() == 32) {
        Some(v) => {
            let mut a = [0u8; 32];
            a.copy_from_slice(&v);
            a
        }
        None => return die("commit txid inválido"),
    };
    let nonce = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    submit(&chain, &build_reveal(&kp, commit_txid, &payload, secret, fee_of(args), nonce))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let Some(cmd) = args.get(1) else {
        eprintln!("uso: rami-wallet new|address|balance|send|stake|unstake|commit|reveal [opciones]");
        eprintln!("⚠ TESTNET experimental — sin valor monetario, no es una inversión.");
        return ExitCode::FAILURE;
    };
    match cmd.as_str() {
        "new" => cmd_new(&args[2..]),
        "address" => cmd_address(&args[2..]),
        "balance" => cmd_balance(&args[2..]),
        "send" => cmd_send(&args[2..]),
        "stake" => cmd_stake(&args[2..], false),
        "unstake" => cmd_stake(&args[2..], true),
        "commit" => cmd_commit(&args[2..]),
        "reveal" => cmd_reveal(&args[2..]),
        other => die(&format!("subcomando desconocido: {other}")),
    }
}
