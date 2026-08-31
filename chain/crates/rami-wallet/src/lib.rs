//! rami-wallet (biblioteca): claves, almacén y construcción de transacciones
//! firmadas de RAMI-Chain. Lo comparten la CLI (`rami-wallet`) y el monedero de
//! escritorio (`rami-gui`), para que haya UN SOLO camino de firma.
//!
//! Desde v0.4 el almacén va **cifrado con contraseña por defecto** (formato v2:
//! PBKDF2-HMAC-SHA256 + ChaCha20-Poly1305 de RustCrypto — nunca criptografía
//! casera). La clave pública se guarda en claro para poder minar y consultar
//! saldo con el monedero bloqueado; el secreto solo se descifra al firmar.
//! Los almacenes v1 (texto plano) se siguen leyendo y pueden migrarse con
//! `set_password`. TESTNET sin valor monetario: aún así, protege tus claves.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use pbkdf2::pbkdf2_hmac;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use rami_core::crypto::KeyPair;
use rami_core::state::COIN;
use rami_core::tx::{commit_hash, signing_message, AccountId, Tx};

/// Ruta por defecto del almacén de claves.
pub fn default_keystore_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    format!("{home}/.rami/wallet.json")
}

/// Iteraciones PBKDF2 (OWASP 2023 para HMAC-SHA256).
const KDF_ITERATIONS: u32 = 600_000;

#[derive(Clone, Serialize, Deserialize)]
struct EncEntry {
    /// Clave pública en claro (para minar/saldo con el monedero bloqueado).
    #[serde(rename = "pub")]
    public: String,
    nonce: String,
    ct: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct EncFile {
    version: u32,
    kdf: String,
    iterations: u32,
    salt: String,
    entries: BTreeMap<String, EncEntry>,
}

enum Store {
    /// v1: etiqueta -> secreto hex en claro (legado).
    Plain(BTreeMap<String, String>),
    /// v2: cifrado con contraseña.
    Encrypted(EncFile),
}

/// Almacén de claves del monedero (v1 en claro o v2 cifrado).
pub struct Keystore {
    pub path: PathBuf,
    store: Store,
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> Key {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    *Key::from_slice(&key)
}

impl Keystore {
    pub fn load(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let text = fs::read_to_string(&path).unwrap_or_default();
        // v2 si es un objeto con "version":2; si no, v1 (mapa plano) o vacío.
        if let Ok(f) = serde_json::from_str::<EncFile>(&text) {
            if f.version == 2 {
                return Keystore { path, store: Store::Encrypted(f) };
            }
        }
        let map: BTreeMap<String, String> = serde_json::from_str(&text).unwrap_or_default();
        Keystore { path, store: Store::Plain(map) }
    }

    /// ¿Existe algún dato en disco?
    pub fn exists(&self) -> bool {
        match &self.store {
            Store::Plain(m) => !m.is_empty(),
            Store::Encrypted(f) => !f.entries.is_empty(),
        }
    }

    pub fn is_encrypted(&self) -> bool {
        matches!(self.store, Store::Encrypted(_))
    }

    pub fn labels(&self) -> Vec<String> {
        match &self.store {
            Store::Plain(m) => m.keys().cloned().collect(),
            Store::Encrypted(f) => f.entries.keys().cloned().collect(),
        }
    }

    pub fn contains(&self, label: &str) -> bool {
        match &self.store {
            Store::Plain(m) => m.contains_key(label),
            Store::Encrypted(f) => f.entries.contains_key(label),
        }
    }

    /// Clave pública de una etiqueta SIN necesitar la contraseña (para minar y
    /// consultar saldo con el monedero bloqueado).
    pub fn public_key(&self, label: &str) -> Option<AccountId> {
        match &self.store {
            Store::Plain(m) => {
                let sk = hex::decode(m.get(label)?).ok()?;
                let sk: [u8; 32] = sk.try_into().ok()?;
                Some(KeyPair::from_secret(&sk).public_bytes())
            }
            Store::Encrypted(f) => {
                let e = f.entries.get(label)?;
                let v = hex::decode(&e.public).ok()?;
                v.try_into().ok()
            }
        }
    }

    /// Devuelve el par de claves de una etiqueta. Si el almacén está cifrado, la
    /// `password` es OBLIGATORIA (contraseña incorrecta => Err).
    pub fn keypair(&self, label: &str, password: Option<&str>) -> Result<KeyPair, String> {
        match &self.store {
            Store::Plain(m) => {
                let hexs = m
                    .get(label)
                    .ok_or_else(|| format!("no hay clave '{label}' en {}", self.path.display()))?;
                let v = hex::decode(hexs).map_err(|_| "secreto corrupto".to_string())?;
                let sk: [u8; 32] = v.try_into().map_err(|_| "el secreto no mide 32 bytes".to_string())?;
                Ok(KeyPair::from_secret(&sk))
            }
            Store::Encrypted(f) => {
                let pw = password.ok_or("el monedero está cifrado: hace falta la contraseña")?;
                let e = f
                    .entries
                    .get(label)
                    .ok_or_else(|| format!("no hay clave '{label}'"))?;
                let salt = hex::decode(&f.salt).map_err(|_| "salt corrupto".to_string())?;
                let key = derive_key(pw, &salt, f.iterations);
                let public: [u8; 32] =
                    hex::decode(&e.public).ok().and_then(|v| v.try_into().ok()).ok_or("pubkey corrupta")?;
                let sk = decrypt_secret(&key, &e.nonce, &e.ct, &public)?;
                Ok(KeyPair::from_secret(&sk))
            }
        }
    }

    /// ¿Es correcta la contraseña? (intenta descifrar una entrada).
    pub fn verify_password(&self, password: &str) -> bool {
        match &self.store {
            Store::Plain(_) => true,
            Store::Encrypted(f) => match f.entries.keys().next() {
                Some(label) => self.keypair(label, Some(password)).is_ok(),
                None => true,
            },
        }
    }

    /// Crea una etiqueta nueva. Con `password` el almacén queda CIFRADO (inicia
    /// el fichero v2 si estaba vacío); sin ella se guarda en claro (legado).
    pub fn create(&mut self, label: &str, password: Option<&str>) -> Result<KeyPair, String> {
        if self.contains(label) {
            return Err(format!("ya existe una clave '{label}'"));
        }
        let kp = KeyPair::generate();
        match password {
            Some(pw) => {
                // Asegura que el almacén sea v2 (migra si estaba vacío en claro).
                match &self.store {
                    Store::Plain(m) if m.is_empty() => {
                        self.store = Store::Encrypted(new_enc_file());
                    }
                    Store::Plain(_) => {
                        return Err("el almacén está en texto plano; usa set_password para cifrarlo primero".into());
                    }
                    Store::Encrypted(_) => {}
                }
                let Store::Encrypted(f) = &mut self.store else { unreachable!() };
                // Si ya hay entradas, la contraseña debe coincidir con la del fichero.
                if let Some(existing) = f.entries.values().next() {
                    let salt = hex::decode(&f.salt).map_err(|_| "salt corrupto".to_string())?;
                    let key = derive_key(pw, &salt, f.iterations);
                    let pub_: [u8; 32] = hex::decode(&existing.public)
                        .ok()
                        .and_then(|v| v.try_into().ok())
                        .ok_or("pubkey corrupta")?;
                    decrypt_secret(&key, &existing.nonce, &existing.ct, &pub_)
                        .map_err(|_| "contraseña distinta a la del monedero".to_string())?;
                }
                let salt = hex::decode(&f.salt).map_err(|_| "salt corrupto".to_string())?;
                let key = derive_key(pw, &salt, f.iterations);
                let public = kp.public_bytes();
                let (nonce, ct) = encrypt_secret(&key, &kp.secret_bytes(), &public);
                f.entries.insert(
                    label.to_string(),
                    EncEntry { public: hex::encode(public), nonce, ct },
                );
            }
            None => match &mut self.store {
                Store::Encrypted(_) => {
                    return Err("el monedero está cifrado: crea la clave con contraseña".into());
                }
                Store::Plain(m) => {
                    m.insert(label.to_string(), hex::encode(kp.secret_bytes()));
                }
            },
        }
        self.save()?;
        Ok(kp)
    }

    /// Devuelve el par de una etiqueta creándolo si no existe (para el monedero
    /// de escritorio, que arranca listo para usar).
    pub fn get_or_create(&mut self, label: &str, password: Option<&str>) -> Result<KeyPair, String> {
        if self.contains(label) {
            self.keypair(label, password)
        } else {
            self.create(label, password)
        }
    }

    /// Migra un almacén v1 (texto plano) a v2 (cifrado) con la contraseña dada.
    pub fn set_password(&mut self, password: &str) -> Result<(), String> {
        let plain = match &self.store {
            Store::Plain(m) => m.clone(),
            Store::Encrypted(_) => return Err("el monedero ya está cifrado".into()),
        };
        let mut f = new_enc_file();
        let salt = hex::decode(&f.salt).unwrap();
        let key = derive_key(password, &salt, f.iterations);
        for (label, sk_hex) in plain {
            let v = hex::decode(&sk_hex).map_err(|_| "secreto corrupto".to_string())?;
            let sk: [u8; 32] = v.try_into().map_err(|_| "secreto no mide 32 bytes".to_string())?;
            let public = KeyPair::from_secret(&sk).public_bytes();
            let (nonce, ct) = encrypt_secret(&key, &sk, &public);
            f.entries.insert(label, EncEntry { public: hex::encode(public), nonce, ct });
        }
        self.store = Store::Encrypted(f);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let text = match &self.store {
            Store::Plain(m) => serde_json::to_string_pretty(m).map_err(|e| e.to_string())?,
            Store::Encrypted(f) => serde_json::to_string_pretty(f).map_err(|e| e.to_string())?,
        };
        fs::write(&self.path, text).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

fn new_enc_file() -> EncFile {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    EncFile {
        version: 2,
        kdf: "pbkdf2-hmac-sha256".into(),
        iterations: KDF_ITERATIONS,
        salt: hex::encode(salt),
        entries: BTreeMap::new(),
    }
}

fn encrypt_secret(master: &Key, secret: &[u8; 32], public: &[u8; 32]) -> (String, String) {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = ChaCha20Poly1305::new(master);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: secret, aad: public })
        .expect("cifrado del keystore");
    (hex::encode(nonce), hex::encode(ct))
}

fn decrypt_secret(master: &Key, nonce_hex: &str, ct_hex: &str, public: &[u8; 32]) -> Result<[u8; 32], String> {
    let nonce = hex::decode(nonce_hex).map_err(|_| "nonce corrupto".to_string())?;
    let ct = hex::decode(ct_hex).map_err(|_| "ciphertext corrupto".to_string())?;
    let cipher = ChaCha20Poly1305::new(master);
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: public })
        .map_err(|_| "contraseña incorrecta o monedero corrupto".to_string())?;
    pt.try_into().map_err(|_| "secreto de tamaño inesperado".to_string())
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

    fn tmp_ks(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("rami-ks-{}-{tag}.json", std::process::id()))
    }

    #[test]
    fn encrypted_keystore_roundtrip() {
        let p = tmp_ks("enc");
        let _ = std::fs::remove_file(&p);
        // crear cifrado
        let mut ks = Keystore::load(&p);
        let kp = ks.create("yo", Some("clave-secreta")).unwrap();
        let pubk = kp.public_bytes();
        assert!(ks.is_encrypted());

        // recargar de disco
        let ks2 = Keystore::load(&p);
        assert!(ks2.is_encrypted());
        // la pubkey se lee SIN contraseña (para minar/saldo bloqueado)
        assert_eq!(ks2.public_key("yo"), Some(pubk));
        // sin contraseña no se puede firmar
        assert!(ks2.keypair("yo", None).is_err());
        // contraseña incorrecta => Err
        assert!(ks2.keypair("yo", Some("mala")).is_err());
        assert!(!ks2.verify_password("mala"));
        // contraseña correcta => mismo secreto
        let kp2 = ks2.keypair("yo", Some("clave-secreta")).unwrap();
        assert_eq!(kp2.secret_bytes(), kp.secret_bytes());
        assert!(ks2.verify_password("clave-secreta"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn migrate_plaintext_to_encrypted() {
        let p = tmp_ks("mig");
        let _ = std::fs::remove_file(&p);
        let mut ks = Keystore::load(&p);
        let kp = ks.create("yo", None).unwrap(); // v1 plano
        assert!(!ks.is_encrypted());
        ks.set_password("nueva").unwrap(); // migra a v2
        assert!(ks.is_encrypted());
        let ks2 = Keystore::load(&p);
        assert!(ks2.is_encrypted());
        assert_eq!(ks2.keypair("yo", Some("nueva")).unwrap().secret_bytes(), kp.secret_bytes());
        let _ = std::fs::remove_file(&p);
    }
}
