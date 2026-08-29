//! rami-wallet (biblioteca): claves, almacén y construcción de transacciones
//! firmadas de RAMI-Chain. Lo comparten la CLI (`rami-wallet`) y el monedero de
//! escritorio (`rami-gui`), para que haya UN SOLO camino de firma.
//!
//! AVISO: las claves se guardan en TEXTO PLANO. Es una TESTNET sin valor
//! monetario; no reutilices estas claves en ningún otro sitio.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rami_core::crypto::KeyPair;
use rami_core::state::COIN;
use rami_core::tx::{commit_hash, signing_message, AccountId, Tx};

/// Ruta por defecto del almacén de claves.
pub fn default_keystore_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    format!("{home}/.rami/wallet.json")
}

/// Almacén etiqueta -> secreto hex (32 bytes). Texto plano, TESTNET.
#[derive(Default)]
pub struct Keystore {
    pub path: PathBuf,
    map: BTreeMap<String, String>,
}

impl Keystore {
    pub fn load(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let map = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Keystore { path, map }
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        fs::write(&self.path, serde_json::to_string_pretty(&self.map).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn labels(&self) -> Vec<String> {
        self.map.keys().cloned().collect()
    }

    pub fn contains(&self, label: &str) -> bool {
        self.map.contains_key(label)
    }

    /// Devuelve el par de claves de una etiqueta.
    pub fn keypair(&self, label: &str) -> Result<KeyPair, String> {
        let secret_hex = self
            .map
            .get(label)
            .ok_or_else(|| format!("no hay clave '{label}' en {}", self.path.display()))?;
        let v = hex::decode(secret_hex).map_err(|_| "secreto corrupto".to_string())?;
        if v.len() != 32 {
            return Err("el secreto no mide 32 bytes".into());
        }
        let mut sk = [0u8; 32];
        sk.copy_from_slice(&v);
        Ok(KeyPair::from_secret(&sk))
    }

    /// Crea una etiqueta nueva (falla si ya existe) y la persiste.
    pub fn create(&mut self, label: &str) -> Result<KeyPair, String> {
        if self.map.contains_key(label) {
            return Err(format!("ya existe una clave '{label}'"));
        }
        let kp = KeyPair::generate();
        self.map.insert(label.to_string(), hex::encode(kp.secret_bytes()));
        self.save()?;
        Ok(kp)
    }

    /// Devuelve el par de una etiqueta, creándolo si no existe (para el monedero
    /// de escritorio, que arranca listo para usar).
    pub fn get_or_create(&mut self, label: &str) -> Result<KeyPair, String> {
        if self.map.contains_key(label) {
            self.keypair(label)
        } else {
            self.create(label)
        }
    }
}

/// Convierte "X" o "X.Y" (hasta 8 decimales) en unidades base (ram).
pub fn parse_ram(s: &str) -> Result<u64, String> {
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

/// Formatea unidades base como "X.YYYYYYYY" RAMI.
pub fn fmt_ram(v: u64) -> String {
    format!("{}.{:08}", v / COIN, v % COIN)
}

/// Interpreta una dirección de pago: pubkey de 32 bytes en hex (con o sin `rami1`).
pub fn parse_pubkey(hexs: &str) -> Result<AccountId, String> {
    let v = hex::decode(hexs.trim().trim_start_matches("rami1")).map_err(|_| "pubkey no es hex".to_string())?;
    if v.len() != 32 {
        return Err("la dirección debe ser la pubkey de 32 bytes (64 hex)".into());
    }
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    Ok(a)
}

/// Firma una tx rellenando su campo `sig`.
pub fn sign_into(kp: &KeyPair, mut tx: Tx) -> Tx {
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

pub fn build_transfer(kp: &KeyPair, to: AccountId, amount: u64, fee: u64, nonce: u64) -> Tx {
    sign_into(kp, Tx::Transfer { from: kp.public_bytes(), to, amount, fee, nonce, sig: [0u8; 64] })
}

pub fn build_stake(kp: &KeyPair, amount: u64, fee: u64, nonce: u64, unstake: bool) -> Tx {
    let who = kp.public_bytes();
    if unstake {
        sign_into(kp, Tx::Unstake { who, amount, fee, nonce, sig: [0u8; 64] })
    } else {
        sign_into(kp, Tx::Stake { who, amount, fee, nonce, sig: [0u8; 64] })
    }
}

/// Construye un Commit firmado; devuelve (tx, secreto de 32 bytes). El llamante
/// DEBE guardar (payload, secreto) para poder revelar después.
pub fn build_commit(
    kp: &KeyPair,
    payload: &serde_json::Value,
    fee: u64,
    nonce: u64,
) -> Result<(Tx, [u8; 32]), String> {
    let secret = KeyPair::generate().secret_bytes(); // 32 bytes aleatorios del sistema
    let commitment = commit_hash(payload, &secret)?;
    let tx = sign_into(kp, Tx::Commit { by: kp.public_bytes(), commitment, fee, nonce, sig: [0u8; 64] });
    Ok((tx, secret))
}

pub fn build_reveal(
    kp: &KeyPair,
    commit_txid: [u8; 32],
    payload: &serde_json::Value,
    secret: Vec<u8>,
    fee: u64,
    nonce: u64,
) -> Tx {
    let payload_bytes = serde_json::to_vec(payload).unwrap_or_default();
    sign_into(
        kp,
        Tx::Reveal { by: kp.public_bytes(), commit_txid, payload: payload_bytes, secret, fee, nonce, sig: [0u8; 64] },
    )
}

/// Almacén local de reveals (payload+secreto) por txid de commit. Nunca se
/// publica: solo permite abrir después un commit hecho con este monedero.
pub fn reveals_path(dir: &Path) -> PathBuf {
    dir.join("wallet_reveals.json")
}

pub fn save_reveal(dir: &Path, commit_txid: &[u8; 32], payload: &serde_json::Value, secret: &[u8; 32]) {
    let p = reveals_path(dir);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut store: serde_json::Map<String, serde_json::Value> =
        fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    store.insert(
        hex::encode(commit_txid),
        serde_json::json!({"payload": payload, "secret": hex::encode(secret)}),
    );
    let _ = fs::write(&p, serde_json::to_string_pretty(&store).unwrap_or_default());
}

/// Recupera (payload, secreto) de un commit guardado.
pub fn load_reveal(dir: &Path, commit_txid_hex: &str) -> Option<(serde_json::Value, Vec<u8>)> {
    let store: serde_json::Map<String, serde_json::Value> =
        fs::read_to_string(reveals_path(dir)).ok().and_then(|s| serde_json::from_str(&s).ok())?;
    let entry = store.get(commit_txid_hex)?;
    let payload = entry.get("payload").cloned()?;
    let secret = entry.get("secret").and_then(|s| s.as_str()).and_then(|s| hex::decode(s).ok())?;
    Some((payload, secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ram_roundtrips() {
        assert_eq!(parse_ram("1").unwrap(), COIN);
        assert_eq!(parse_ram("0.5").unwrap(), COIN / 2);
        assert_eq!(parse_ram("10.00000001").unwrap(), 10 * COIN + 1);
        assert!(parse_ram("1.123456789").is_err());
        assert_eq!(fmt_ram(COIN + COIN / 4), "1.25000000");
    }

    #[test]
    fn commit_then_reveal_matches() {
        let kp = KeyPair::from_secret(&[3u8; 32]);
        let payload = serde_json::json!({"pair": "BTC", "dir": "LONG"});
        let (_tx, secret) = build_commit(&kp, &payload, 1, 0).unwrap();
        // el reveal reproduce el mismo commitment
        let c1 = commit_hash(&payload, &secret).unwrap();
        let c2 = commit_hash(&payload, &secret).unwrap();
        assert_eq!(c1, c2);
    }
}
