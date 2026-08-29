//! rami-wallet — monedero de RAMI-Chain (Ed25519), sin dependencias pesadas.
//!
//! AVISO: las claves se guardan en TEXTO PLANO. Es una TESTNET sin valor
//! monetario. No reutilices estas claves en ningún otro sitio.
//!
//!   rami-wallet new      [--keystore F] [--label L]
//!   rami-wallet address  [--keystore F] [--label L]
//!   rami-wallet balance  --chain DIR [--keystore F | --address HEXPUB] [--network N]
//!   rami-wallet send     --chain DIR --to HEXPUB --amount RAMI [--fee ram] [--keystore F]
//!   rami-wallet stake    --chain DIR --amount RAMI [--fee ram] [--keystore F]
//!   rami-wallet unstake  --chain DIR --amount RAMI [--fee ram] [--keystore F]
//!   rami-wallet commit   --chain DIR --payload JSON [--fee ram] [--keystore F]
//!   rami-wallet reveal   --chain DIR --commit TXID [--fee ram] [--keystore F]
//!
//! La dirección de pago = clave pública en hex (64 caracteres). El monedero firma
//! transacciones y las deja en el mempool del nodo (mempool.jsonl); el nodo las
//! incluye al minar. La clave privada NUNCA sale de la máquina.

use std::collections::BTreeMap;
use std::fs;
use std::process::ExitCode;

use rami_core::crypto::{address_from_pubkey, KeyPair};
use rami_core::params::Params;
use rami_core::state::COIN;
use rami_core::store::ChainDir;
use rami_core::tx::{commit_hash, signing_message, signer_of, txid, AccountId, Tx};

fn die(msg: &str) -> ExitCode {
    eprintln!("✗ {msg}");
    ExitCode::FAILURE
}
fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn default_keystore() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    format!("{home}/.rami/wallet.json")
}

/// Almacén: etiqueta -> secreto hex (32 bytes). Texto plano, TESTNET.
fn load_keystore(path: &str) -> BTreeMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn save_keystore(path: &str, ks: &BTreeMap<String, String>) -> Result<(), String> {
    if let Some(dir) = std::path::Path::new(path).parent() {
        let _ = fs::create_dir_all(dir);
    }
    fs::write(path, serde_json::to_string_pretty(ks).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    // permisos 0600 (best-effort)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn keypair_from(args: &[String]) -> Result<KeyPair, String> {
    let path = arg(args, "--keystore").unwrap_or_else(default_keystore);
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    let ks = load_keystore(&path);
    let secret_hex = ks.get(&label).ok_or_else(|| {
        format!("no hay clave '{label}' en {path}; crea una con: rami-wallet new")
    })?;
    let v = hex::decode(secret_hex).map_err(|_| "secreto corrupto".to_string())?;
    if v.len() != 32 {
        return Err("el secreto no mide 32 bytes".into());
    }
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&v);
    Ok(KeyPair::from_secret(&sk))
}

fn parse_pubkey(hexs: &str) -> Result<AccountId, String> {
    let v = hex::decode(hexs.trim()).map_err(|_| "pubkey no es hex".to_string())?;
    if v.len() != 32 {
        return Err("la dirección debe ser la pubkey de 32 bytes (64 hex)".into());
    }
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    Ok(a)
}

/// Convierte "X" o "X.Y" (hasta 8 decimales) en unidades base (ram).
fn parse_ram(s: &str) -> Result<u64, String> {
    let s = s.trim();
    let (int_part, frac_part) = match s.split_once('.') {
        Some((a, b)) => (a, b),
        None => (s, ""),
    };
    if frac_part.len() > 8 {
        return Err("máximo 8 decimales".into());
    }
    let int_v: u64 = int_part.parse().map_err(|_| "importe inválido".to_string())?;
    let mut frac = frac_part.to_string();
    while frac.len() < 8 {
        frac.push('0');
    }
    let frac_v: u64 = if frac.is_empty() { 0 } else { frac.parse().map_err(|_| "decimales inválidos".to_string())? };
    int_v
        .checked_mul(COIN)
        .and_then(|x| x.checked_add(frac_v))
        .ok_or_else(|| "importe demasiado grande".into())
}

fn fmt_ram(v: u64) -> String {
    format!("{}.{:08}", v / COIN, v % COIN)
}

fn params_of(args: &[String]) -> Params {
    match arg(args, "--network").as_deref() {
        Some("testnet") => Params::testnet(),
        _ => Params::regtest(),
    }
}

/// nonce siguiente = nonce en cadena + nº de tx pendientes de este firmante.
fn next_nonce(chain: &ChainDir, params: Params, me: &AccountId) -> Result<u64, String> {
    let tree = chain.load_tree(params)?;
    let state = tree.head_state()?;
    let base = state.nonce_of(me);
    let pending = chain
        .load_mempool()
        .iter()
        .filter(|t| signer_of(t) == Some(me))
        .count() as u64;
    Ok(base + pending)
}

fn sign_into(kp: &KeyPair, mut tx: Tx) -> Tx {
    let sig = kp.sign(&signing_message(&tx));
    match &mut tx {
        Tx::Transfer { sig: s, .. }
        | Tx::Stake { sig: s, .. }
        | Tx::Unstake { sig: s, .. }
        | Tx::Commit { sig: s, .. }
        | Tx::Reveal { sig: s, .. } => *s = sig,
        Tx::Coinbase { .. } => {}
    }
    tx
}

fn cmd_new(args: &[String]) -> ExitCode {
    let path = arg(args, "--keystore").unwrap_or_else(default_keystore);
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    let mut ks = load_keystore(&path);
    if ks.contains_key(&label) {
        return die(&format!("ya existe una clave '{label}' en {path}"));
    }
    let kp = KeyPair::generate();
    ks.insert(label.clone(), hex::encode(kp.secret_bytes()));
    if let Err(e) = save_keystore(&path, &ks) {
        return die(&e);
    }
    println!("✓ clave '{label}' creada en {path}");
    println!("  dirección (pubkey) : {}", hex::encode(kp.public_bytes()));
    println!("  etiqueta corta     : {}", address_from_pubkey(&kp.public_bytes()));
    println!("  ⚠ TESTNET: la clave está en texto plano y sin valor monetario.");
    ExitCode::SUCCESS
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

fn submit(chain: &ChainDir, tx: &Tx) -> ExitCode {
    if let Err(e) = chain.append_mempool(tx) {
        return die(&e);
    }
    println!("✓ tx {} enviada al mempool (se incluirá al minar)", hex::encode(&txid(tx)[..12]));
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
    let fee: u64 = arg(args, "--fee").and_then(|s| s.parse().ok()).unwrap_or(1);
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let nonce = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    let tx = sign_into(
        &kp,
        Tx::Transfer { from: kp.public_bytes(), to, amount, fee, nonce, sig: [0u8; 64] },
    );
    submit(&chain, &tx)
}

fn cmd_stake(args: &[String], unstake: bool) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(amount_s) = arg(args, "--amount") else { return die("falta --amount RAMI") };
    let amount = match parse_ram(&amount_s) {
        Ok(a) => a,
        Err(e) => return die(&e),
    };
    let fee: u64 = arg(args, "--fee").and_then(|s| s.parse().ok()).unwrap_or(1);
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let nonce = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    let who = kp.public_bytes();
    let tx = if unstake {
        sign_into(&kp, Tx::Unstake { who, amount, fee, nonce, sig: [0u8; 64] })
    } else {
        sign_into(&kp, Tx::Stake { who, amount, fee, nonce, sig: [0u8; 64] })
    };
    submit(&chain, &tx)
}

fn reveals_path(chain: &ChainDir) -> std::path::PathBuf {
    chain.root.join("wallet_reveals.json")
}

fn cmd_commit(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(payload_s) = arg(args, "--payload") else { return die("falta --payload JSON") };
    let payload: serde_json::Value = match serde_json::from_str(&payload_s) {
        Ok(v) => v,
        Err(_) => return die("payload no es JSON válido"),
    };
    let fee: u64 = arg(args, "--fee").and_then(|s| s.parse().ok()).unwrap_or(1);
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    // secreto aleatorio de 32 bytes; commitment = sha256(canon(payload)||secret)
    let secret = KeyPair::generate().secret_bytes(); // 32 bytes aleatorios del sistema
    let commitment = match commit_hash(&payload, &secret) {
        Ok(c) => c,
        Err(e) => return die(&e),
    };
    let nonce = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    let tx = sign_into(
        &kp,
        Tx::Commit { by: kp.public_bytes(), commitment, fee, nonce, sig: [0u8; 64] },
    );
    let cid = txid(&tx);
    // guarda payload+secreto para revelar después (local, nunca se publica)
    let mut store: serde_json::Map<String, serde_json::Value> =
        fs::read_to_string(reveals_path(&chain)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    store.insert(
        hex::encode(cid),
        serde_json::json!({"payload": payload, "secret": hex::encode(secret)}),
    );
    let _ = fs::write(reveals_path(&chain), serde_json::to_string_pretty(&store).unwrap());
    println!("✓ commit txid: {}", hex::encode(cid));
    println!("  (guardado el secreto para revelar con: rami-wallet reveal --commit {})", hex::encode(cid));
    submit(&chain, &tx)
}

fn cmd_reveal(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(commit_s) = arg(args, "--commit") else { return die("falta --commit TXID") };
    let fee: u64 = arg(args, "--fee").and_then(|s| s.parse().ok()).unwrap_or(1);
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let store: serde_json::Map<String, serde_json::Value> =
        fs::read_to_string(reveals_path(&chain)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let Some(entry) = store.get(&commit_s) else {
        return die("no tengo el secreto de ese commit (¿lo hiciste con este monedero?)");
    };
    let payload = entry.get("payload").cloned().unwrap_or(serde_json::Value::Null);
    let secret = match entry.get("secret").and_then(|s| s.as_str()).and_then(|s| hex::decode(s).ok()) {
        Some(s) => s,
        None => return die("secreto corrupto en el almacén de reveals"),
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
    let payload_bytes = serde_json::to_vec(&payload).unwrap();
    let tx = sign_into(
        &kp,
        Tx::Reveal {
            by: kp.public_bytes(),
            commit_txid,
            payload: payload_bytes,
            secret,
            fee,
            nonce,
            sig: [0u8; 64],
        },
    );
    submit(&chain, &tx)
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
