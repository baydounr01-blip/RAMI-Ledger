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
//!   rami-wallet profile  --chain DIR --handle NOMBRE [--display A] [--bio B] [--avatar N] [--color N]
//!   rami-wallet claim    --chain DIR --x X --y Y --name NOMBRE [--kind SECTOR]
//!   rami-wallet divide   --chain DIR --x X --y Y --unidades N          (vivienda, v0.11.0)
//!   rami-wallet unit-transfer --chain DIR --x X --y Y --n N --to HEXPUB
//!   rami-wallet unit-sell     --chain DIR --x X --y Y --n N --price RAMI   (0 retira)
//!   rami-wallet unit-buy      --chain DIR --x X --y Y --n N --max-price RAMI
//!
//! En regtest, `--firma-v2-desde`, `--dubai-desde` y `--vivienda-desde <unix>`
//! fuerzan las activaciones (las mismas que se pasen al nodo).

use std::process::ExitCode;

use rami_core::crypto::{address_from_pubkey, KeyPair};
use rami_core::params::Params;
use rami_core::store::ChainDir;
use rami_core::tx::{signer_of, txid, verify_tx_con, AccountId, FirmaCtx, Tx};

use rami_wallet::{
    build_buy_unit, build_claim_parcel, build_commit, build_divide_parcel, build_reveal, build_sell_unit, build_set_profile,
    build_stake, build_transfer, build_transfer_unit, default_keystore_path, fmt_ram, load_reveal, parse_pubkey, parse_ram,
    save_reveal, Keystore,
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
/// Contraseña: de `--password`, o de la variable de entorno RAMI_WALLET_PASSWORD.
fn password_of(args: &[String]) -> Option<String> {
    arg(args, "--password").or_else(|| std::env::var("RAMI_WALLET_PASSWORD").ok())
}
fn keypair_from(args: &[String]) -> Result<KeyPair, String> {
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    keystore_of(args).keypair(&label, password_of(args).as_deref())
}
fn params_of(args: &[String]) -> Params {
    let p = match arg(args, "--network").as_deref() {
        Some("testnet") => Params::testnet(),
        _ => Params::regtest(),
    };
    // Solo para pruebas en regtest: fuerza las fechas de activación de la
    // regla de firma v2 y de Dubái (Unix, UTC). En testnet son las de consenso.
    if matches!(arg(args, "--network").as_deref(), Some("testnet")) {
        return p;
    }
    let p = match arg(args, "--firma-v2-desde").and_then(|s| s.parse::<u64>().ok()) {
        Some(t) => p.con_firma_v2_desde(Some(t)),
        None => p,
    };
    let p = match arg(args, "--dubai-desde").and_then(|s| s.parse::<u64>().ok()) {
        Some(t) => p.con_dubai_desde(Some(t)),
        None => p,
    };
    // Escritura de vivienda (v0.11.0): solo tiene efecto con Dubái.
    match arg(args, "--vivienda-desde").and_then(|s| s.parse::<u64>().ok()) {
        Some(t) => p.con_vivienda_desde(Some(t)),
        None => p,
    }
}
fn fee_of(args: &[String]) -> u64 {
    arg(args, "--fee").and_then(|s| s.parse().ok()).unwrap_or(1)
}

/// nonce siguiente = nonce en cadena + tx pendientes de este firmante, y el
/// contexto de firma que rige AHORA en esta cadena (regla v1 o v2 ligada a la
/// red): con él se firma para que el nodo admita la tx.
fn next_nonce(chain: &ChainDir, params: Params, me: &AccountId) -> Result<(u64, FirmaCtx), String> {
    let tree = chain.load_tree(params)?;
    let base = tree.head_state()?.nonce_of(me);
    let ahora = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let firma = tree.firma_ctx(ahora);
    // Solo cuentan las pendientes que AÚN valen bajo la regla vigente: una tx
    // firmada con v1 antes de la activación ya no entrará en ningún bloque,
    // así que su nonce sigue libre (el nodo la poda; aquí se ignora).
    let pending = chain
        .load_mempool()
        .iter()
        .filter(|t| signer_of(t) == Some(me) && verify_tx_con(t, &firma).is_ok())
        .count() as u64;
    Ok((base + pending, firma))
}

fn submit(chain: &ChainDir, firma: &FirmaCtx, tx: &Tx) -> ExitCode {
    // Las mismas reglas que aplicará el nodo: si la tx no vale, decirlo AQUÍ.
    // Si no, se escribiría en el mempool, se anunciaría «enviada» y nunca
    // entraría en un bloque (el minero la salta y la poda se la lleva).
    if let Err(e) = verify_tx_con(tx, firma) {
        return die(&e);
    }
    if let Err(e) = chain.append_mempool(tx) {
        return die(&e);
    }
    println!("✓ tx {} enviada al mempool (se incluirá al minar)", hex::encode(&txid(tx)[..12]));
    ExitCode::SUCCESS
}

fn cmd_new(args: &[String]) -> ExitCode {
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    let pw = password_of(args);
    // Por defecto, CIFRADO. Solo se guarda en claro con --plaintext explícito.
    if pw.is_none() && !has(args, "--plaintext") {
        return die("da una contraseña con --password (o RAMI_WALLET_PASSWORD). El monedero se cifra por defecto; usa --plaintext solo si sabes lo que haces.");
    }
    let mut ks = keystore_of(args);
    match ks.create(&label, pw.as_deref()) {
        Ok(kp) => {
            println!("✓ clave '{label}' creada en {}", ks.path.display());
            println!("  dirección (pubkey) : {}", hex::encode(kp.public_bytes()));
            println!("  etiqueta corta     : {}", address_from_pubkey(&kp.public_bytes()));
            if ks.is_encrypted() {
                println!("  🔒 cifrado con tu contraseña (PBKDF2 + ChaCha20-Poly1305).");
                println!("  ⚠ si olvidas la contraseña, NO hay recuperación posible.");
            } else {
                println!("  ⚠ TESTNET: clave en TEXTO PLANO (--plaintext). Cífrala con: rami-wallet passwd --password ...");
            }
            ExitCode::SUCCESS
        }
        Err(e) => die(&e),
    }
}

fn cmd_passwd(args: &[String]) -> ExitCode {
    let Some(pw) = password_of(args) else {
        return die("da la nueva contraseña con --password (o RAMI_WALLET_PASSWORD)");
    };
    let mut ks = keystore_of(args);
    if ks.is_encrypted() {
        return die("el monedero ya está cifrado (cambiar contraseña llegará en una versión futura)");
    }
    match ks.set_password(&pw) {
        Ok(()) => {
            println!("🔒 monedero cifrado en {} ({} clave/s).", ks.path.display(), ks.labels().len());
            ExitCode::SUCCESS
        }
        Err(e) => die(&e),
    }
}

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn cmd_address(args: &[String]) -> ExitCode {
    // La dirección (pubkey) se lee SIN contraseña, aunque el monedero esté cifrado.
    let label = arg(args, "--label").unwrap_or_else(|| "default".into());
    match keystore_of(args).public_key(&label) {
        Some(pk) => {
            println!("{}", hex::encode(pk));
            eprintln!("(etiqueta corta: {})", address_from_pubkey(&pk));
            ExitCode::SUCCESS
        }
        None => die(&format!("no hay clave '{label}' (crea una con: rami-wallet new)")),
    }
}

fn cmd_balance(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let me = match arg(args, "--address") {
        Some(a) => match parse_pubkey(&a) {
            Ok(p) => p,
            Err(e) => return die(&e),
        },
        None => {
            let label = arg(args, "--label").unwrap_or_else(|| "default".into());
            match keystore_of(args).public_key(&label) {
                Some(pk) => pk,
                None => return die(&format!("no hay clave '{label}'")),
            }
        }
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
    let (nonce, firma) = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    submit(&chain, &firma, &build_transfer(&firma, &kp, to, amount, fee_of(args), nonce))
}

/// v0.10.0: `profile --handle NOMBRE [--display ALIAS] [--bio TEXTO] [--avatar N]
/// [--color N]`. Desde la CLI el perfil va sin vínculo con un nodo; el vínculo
/// (el avatar de tu nodo «es» esta cuenta) lo firma el monedero de escritorio,
/// que tiene la identidad del nodo a mano.
fn cmd_profile(args: &[String]) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let Some(handle) = arg(args, "--handle") else { return die("falta --handle NOMBRE (3–20: a-z, 0-9, _)") };
    let handle = handle.trim().to_lowercase();
    if !rami_core::tx::handle_valido(handle.as_bytes()) {
        return die("nombre inválido: de 3 a 20 caracteres, solo a-z, 0-9 y _");
    }
    let display = arg(args, "--display").unwrap_or_default();
    if display.len() > rami_core::tx::MAX_DISPLAY_BYTES {
        return die("alias demasiado largo (máx. 32 bytes)");
    }
    let bio = arg(args, "--bio").unwrap_or_default();
    if bio.len() > rami_core::tx::MAX_BIO_BYTES {
        return die("biografía demasiado larga (máx. 160 bytes)");
    }
    // Un `--avatar rojo` o un `--avatar 16` no pueden volverse 0 en silencio.
    let catalogo = |flag: &str, max: u8| -> Result<u8, String> {
        match arg(args, flag) {
            None => Ok(0),
            Some(v) => match v.trim().parse::<u8>() {
                Ok(n) if n <= max => Ok(n),
                _ => Err(format!("{flag} debe ser un número de 0 a {max}")),
            },
        }
    };
    let avatar = match catalogo("--avatar", rami_core::tx::MAX_AVATAR) { Ok(v) => v, Err(e) => return die(&e) };
    let color = match catalogo("--color", rami_core::tx::MAX_COLOR) { Ok(v) => v, Err(e) => return die(&e) };
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let (nonce, firma) = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    println!("perfil «{handle}» · registrar un nombre nuevo quema {} RAMI", fmt_ram(rami_core::ciudad::PRECIO_NOMBRE));
    submit(&chain, &firma, &build_set_profile(&firma, &kp, &handle, &display, &bio, avatar, color, None, fee_of(args), nonce))
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
    let (nonce, firma) = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    submit(&chain, &firma, &build_stake(&firma, &kp, amount, fee_of(args), nonce, unstake))
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
    let (nonce, firma) = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    let (tx, secret) = match build_commit(&firma, &kp, &payload, fee_of(args), nonce) {
        Ok(v) => v,
        Err(e) => return die(&e),
    };
    let cid = txid(&tx);
    save_reveal(&chain.root, &cid, &payload, &secret);
    println!("✓ commit txid: {}", hex::encode(cid));
    println!("  (revela luego con: rami-wallet reveal --commit {})", hex::encode(cid));
    submit(&chain, &firma, &tx)
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
    let (nonce, firma) = match next_nonce(&chain, params_of(args), &kp.public_bytes()) {
        Ok(n) => n,
        Err(e) => return die(&e),
    };
    submit(&chain, &firma, &build_reveal(&firma, &kp, commit_txid, &payload, secret, fee_of(args), nonce))
}

// ---- Ciudad: parcela y escritura de vivienda (v0.11.0) ----
//
// Estas órdenes comprueban la transacción contra el ESTADO de la cabeza con
// las pendientes del mempool ya aplicadas (las mismas reglas que el nodo al
// admitirla): si no aplica, se dice aquí y no se escribe en el mempool.

/// Firma y envía una tx de la ciudad tras simularla sobre el estado.
fn enviar_ciudad(args: &[String], build: impl FnOnce(&FirmaCtx, &KeyPair, u64) -> Tx) -> ExitCode {
    let Some(dir) = arg(args, "--chain") else { return die("falta --chain DIR") };
    let kp = match keypair_from(args) {
        Ok(k) => k,
        Err(e) => return die(&e),
    };
    let chain = ChainDir::new(&dir);
    let tree = match chain.load_tree(params_of(args)) {
        Ok(t) => t,
        Err(e) => return die(&e),
    };
    let ahora = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let firma = tree.firma_ctx(ahora);
    let mut sim = match tree.head_state() {
        Ok(s) => s,
        Err(e) => return die(&e),
    };
    let altura = tree.get(&tree.head()).map(|n| n.block.header.height + 1).unwrap_or(1);
    for t in chain.load_mempool() {
        // Las que ya no aplican se saltan sin dejar nada en `sim`.
        if verify_tx_con(&t, &firma).is_ok() {
            let _ = rami_core::state::apply_tx_sin_rastro(&mut sim, &t, altura, 1, &txid(&t), &firma);
        }
    }
    let nonce = sim.nonce_of(&kp.public_bytes());
    let tx = build(&firma, &kp, nonce);
    if let Err(e) = verify_tx_con(&tx, &firma) {
        return die(&e);
    }
    if let Err(e) = rami_core::state::apply_tx(&mut sim, &tx, altura, 1, &txid(&tx), &firma) {
        return die(&format!("no aplica: {e}"));
    }
    submit(&chain, &firma, &tx)
}

/// Entero de un flag con su rango (un `--n 0` o un `--x 99` no se aceptan en silencio).
fn entero(args: &[String], flag: &str, min: u64, max: u64) -> Result<u64, String> {
    let v = arg(args, flag).ok_or_else(|| format!("falta {flag}"))?;
    match v.trim().parse::<u64>() {
        Ok(n) if (min..=max).contains(&n) => Ok(n),
        _ => Err(format!("{flag} debe ser un número de {min} a {max}")),
    }
}

fn coordenadas(args: &[String]) -> Result<(u16, u16), String> {
    let max = rami_core::ciudad::CITY_SIZE_DUBAI as u64 - 1;
    Ok((entero(args, "--x", 0, max)? as u16, entero(args, "--y", 0, max)? as u16))
}

fn cmd_claim(args: &[String]) -> ExitCode {
    let (x, y) = match coordenadas(args) { Ok(c) => c, Err(e) => return die(&e) };
    let Some(name) = arg(args, "--name") else { return die("falta --name NOMBRE (máx. 32 bytes)") };
    let kind = match arg(args, "--kind") {
        None => 0,
        Some(_) => match entero(args, "--kind", 0, rami_core::ciudad::MAX_SECTOR as u64) { Ok(k) => k as u8, Err(e) => return die(&e) },
    };
    let fee = fee_of(args);
    enviar_ciudad(args, move |firma, kp, nonce| {
        let precio = if firma.dubai { rami_core::ciudad::precio_parcela(x, y) } else { rami_core::state::PARCEL_PRICE };
        println!("parcela ({x},{y}) · si está libre, reclamarla quema {} RAMI", fmt_ram(precio));
        build_claim_parcel(firma, kp, x, y, &name, kind, fee, nonce)
    })
}

fn cmd_divide(args: &[String]) -> ExitCode {
    let (x, y) = match coordenadas(args) { Ok(c) => c, Err(e) => return die(&e) };
    let max = rami_core::tx::MAX_UNIDADES_POR_PARCELA as u64;
    let unidades = match entero(args, "--unidades", 1, max) { Ok(n) => n as u16, Err(e) => return die(&e) };
    let fee = fee_of(args);
    println!("parcela ({x},{y}) · dividir en {unidades} viviendas (solo la comisión)");
    enviar_ciudad(args, move |firma, kp, nonce| build_divide_parcel(firma, kp, x, y, unidades, fee, nonce))
}

fn numero_vivienda(args: &[String]) -> Result<u16, String> {
    entero(args, "--n", 1, rami_core::tx::MAX_UNIDADES_POR_PARCELA as u64).map(|n| n as u16)
}

fn cmd_unit_transfer(args: &[String]) -> ExitCode {
    let (x, y) = match coordenadas(args) { Ok(c) => c, Err(e) => return die(&e) };
    let n = match numero_vivienda(args) { Ok(n) => n, Err(e) => return die(&e) };
    let Some(to_s) = arg(args, "--to") else { return die("falta --to HEXPUB") };
    let to = match parse_pubkey(&to_s) { Ok(p) => p, Err(e) => return die(&e) };
    let fee = fee_of(args);
    enviar_ciudad(args, move |firma, kp, nonce| build_transfer_unit(firma, kp, x, y, n, to, fee, nonce))
}

fn cmd_unit_sell(args: &[String]) -> ExitCode {
    let (x, y) = match coordenadas(args) { Ok(c) => c, Err(e) => return die(&e) };
    let n = match numero_vivienda(args) { Ok(n) => n, Err(e) => return die(&e) };
    let Some(price_s) = arg(args, "--price") else { return die("falta --price RAMI (0 retira la venta)") };
    let price = match parse_ram(&price_s) { Ok(a) => a, Err(e) => return die(&e) };
    let fee = fee_of(args);
    enviar_ciudad(args, move |firma, kp, nonce| build_sell_unit(firma, kp, x, y, n, price, fee, nonce))
}

fn cmd_unit_buy(args: &[String]) -> ExitCode {
    let (x, y) = match coordenadas(args) { Ok(c) => c, Err(e) => return die(&e) };
    let n = match numero_vivienda(args) { Ok(n) => n, Err(e) => return die(&e) };
    let Some(max_s) = arg(args, "--max-price") else { return die("falta --max-price RAMI") };
    let max_price = match parse_ram(&max_s) { Ok(a) => a, Err(e) => return die(&e) };
    let fee = fee_of(args);
    enviar_ciudad(args, move |firma, kp, nonce| build_buy_unit(firma, kp, x, y, n, max_price, fee, nonce))
}

// ---- firma de release (Ed25519, la misma criptografía de la cadena) ----
//
//   rami-wallet release-keygen                 → semilla (secreta) + clave pública
//   rami-wallet release-sign   --file SHA256SUMS.txt [--seed HEX | RAMI_RELEASE_SEED]
//   rami-wallet release-verify --file SHA256SUMS.txt --sig SHA256SUMS.sig --pubkey HEX
//
// El mantenedor guarda la semilla como secreto de CI (RAMI_RELEASE_SEED); la
// clave pública se compila en el monedero (update.rs, RELEASE_PUBKEY_HEX).

fn cmd_release_keygen() -> ExitCode {
    let kp = KeyPair::generate();
    println!("semilla (SECRETA, guárdala como secreto de CI RAMI_RELEASE_SEED):");
    println!("  {}", hex::encode(kp.secret_bytes()));
    println!("clave pública (ponla en RELEASE_PUBKEY_HEX de update.rs y en SIGNING.md):");
    println!("  {}", hex::encode(kp.public_bytes()));
    ExitCode::SUCCESS
}

fn cmd_release_sign(args: &[String]) -> ExitCode {
    let Some(file) = arg(args, "--file") else { return die("falta --file") };
    let seed_hex = match arg(args, "--seed").or_else(|| std::env::var("RAMI_RELEASE_SEED").ok()) {
        Some(s) => s,
        None => return die("falta --seed (o la variable RAMI_RELEASE_SEED)"),
    };
    let seed: [u8; 32] = match hex::decode(seed_hex.trim()).ok().and_then(|v| v.try_into().ok()) {
        Some(s) => s,
        None => return die("la semilla debe ser 32 bytes en hex"),
    };
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(e) => return die(&format!("no se pudo leer {file}: {e}")),
    };
    let kp = KeyPair::from_secret(&seed);
    let sig = kp.sign(&rami_core::crypto::release_message(&bytes));
    let out = arg(args, "--out").unwrap_or_else(|| format!("{file}.sig").replace(".txt.sig", ".sig"));
    if let Err(e) = std::fs::write(&out, format!("{}\n", hex::encode(sig))) {
        return die(&format!("no se pudo escribir {out}: {e}"));
    }
    println!("✓ firma escrita en {out} (clave pública {})", hex::encode(kp.public_bytes()));
    ExitCode::SUCCESS
}

fn cmd_release_verify(args: &[String]) -> ExitCode {
    let (Some(file), Some(sig), Some(pk)) = (arg(args, "--file"), arg(args, "--sig"), arg(args, "--pubkey")) else {
        return die("uso: release-verify --file F --sig F.sig --pubkey HEX");
    };
    let bytes = match std::fs::read(&file) {
        Ok(b) => b,
        Err(e) => return die(&format!("no se pudo leer {file}: {e}")),
    };
    let sig_hex = match std::fs::read_to_string(&sig) {
        Ok(s) => s,
        Err(e) => return die(&format!("no se pudo leer {sig}: {e}")),
    };
    match rami_core::crypto::verify_release_signature(&pk, &bytes, &sig_hex) {
        Ok(()) => {
            println!("✓ firma de release VÁLIDA para {file}");
            ExitCode::SUCCESS
        }
        Err(e) => die(&e),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let Some(cmd) = args.get(1) else {
        eprintln!("uso: rami-wallet new|address|balance|send|stake|unstake|commit|reveal|profile|claim|divide|unit-transfer|unit-sell|unit-buy [opciones]");
        eprintln!("⚠ TESTNET experimental — sin valor monetario, no es una inversión.");
        return ExitCode::FAILURE;
    };
    match cmd.as_str() {
        "new" => cmd_new(&args[2..]),
        "passwd" => cmd_passwd(&args[2..]),
        "release-keygen" => cmd_release_keygen(),
        "release-sign" => cmd_release_sign(&args[2..]),
        "release-verify" => cmd_release_verify(&args[2..]),
        "address" => cmd_address(&args[2..]),
        "balance" => cmd_balance(&args[2..]),
        "send" => cmd_send(&args[2..]),
        "stake" => cmd_stake(&args[2..], false),
        "unstake" => cmd_stake(&args[2..], true),
        "commit" => cmd_commit(&args[2..]),
        "reveal" => cmd_reveal(&args[2..]),
        "profile" => cmd_profile(&args[2..]),
        "claim" => cmd_claim(&args[2..]),
        "divide" => cmd_divide(&args[2..]),
        "unit-transfer" => cmd_unit_transfer(&args[2..]),
        "unit-sell" => cmd_unit_sell(&args[2..]),
        "unit-buy" => cmd_unit_buy(&args[2..]),
        other => die(&format!("subcomando desconocido: {other}")),
    }
}
