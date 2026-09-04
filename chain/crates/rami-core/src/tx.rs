//! rami-core::tx — conjunto de transacciones nativo, modelo de cuentas y
//! commit/reveal RAMI como transacciones de primera clase.
//!
//! Dos capas de serialización:
//!   * CONSENSO: binario determinista (little-endian, longitud-prefijado, 1 byte
//!     de dominio por variante). Sin floats jamás.
//!   * PAYLOAD de Commit: JSON canónico (canon.rs), opaco para la cadena, igual
//!     que la referencia Python.
//! Importes en unidades base u64 ("ramiwei"). Dirección = clave pública Ed25519
//! cruda (32 bytes).

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canon::canon;

pub type Amount = u64;
pub type AccountId = [u8; 32];
pub type TxId = [u8; 32];

/// Separador de dominio de firma (evita reutilización de firmas entre contextos).
pub const DS_TAG: &[u8] = b"RAMI-CHAIN/tx/v1";
/// Tope del payload de un Reveal (anti-DoS / anti-bloat).
pub const MAX_PAYLOAD_BYTES: usize = 4096;

const T_COINBASE: u8 = 0x00;
const T_TRANSFER: u8 = 0x01;
const T_STAKE: u8 = 0x02;
const T_UNSTAKE: u8 = 0x03;
const T_COMMIT: u8 = 0x04;
const T_REVEAL: u8 = 0x05;
// Ciudad RAMI (fase 0 del metaverso): parcelas y activos como reglas nativas.
const T_CLAIM_PARCEL: u8 = 0x10;
const T_MINT_ASSET: u8 = 0x11;
const T_TRANSFER_ASSET: u8 = 0x12;
const T_LIST_LEASE: u8 = 0x13;
const T_RENT: u8 = 0x14;
const T_HARVEST: u8 = 0x15;

/// Lado de la cuadrícula de la ciudad (parcelas 0..CITY_SIZE en x e y).
pub const CITY_SIZE: u16 = 32;
/// Tope del nombre de una parcela/empresa (bytes UTF-8).
pub const MAX_NAME_BYTES: usize = 32;
/// Tope de los metadatos de un activo (bytes UTF-8).
pub const MAX_META_BYTES: usize = 64;
/// Plazo máximo de un alquiler, en bloques (~1 año a 60 s/bloque).
pub const MAX_LEASE_TERM: u64 = 525_600;
/// Tipos de parcela: 0 empresa, 1 granja, 2 tienda, 3 oficina.
pub const MAX_PARCEL_KIND: u8 = 3;
/// Tipos de activo: 0 planta (cosecha), 1 objeto.
pub const MAX_ASSET_KIND: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tx {
    /// Recompensa de minería. Sin firma; su validez (cota de recompensa, una por
    /// bloque) es una regla de estado, no de firma.
    Coinbase { height: u64, to: AccountId, reward: Amount, memo: Vec<u8> },
    Transfer { from: AccountId, to: AccountId, amount: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    Stake { who: AccountId, amount: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    Unstake { who: AccountId, amount: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Publica sha256(canon(payload)||secret) ANTES del hecho.
    Commit { by: AccountId, commitment: [u8; 32], fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Abre un Commit anterior. El nodo comprueba el hash y que el bloque es
    /// estrictamente posterior.
    Reveal {
        by: AccountId,
        commit_txid: TxId,
        payload: Vec<u8>,
        secret: Vec<u8>,
        fee: Amount,
        nonce: u64,
        #[serde(with = "crate::serdehex::b64")]
        sig: [u8; 64],
    },
    // ---------- Ciudad RAMI (metaverso, fase 0) ----------
    /// Reclama (o renombra, si ya es tuya) la parcela (x, y) y "monta la
    /// empresa": nombre + tipo. Una parcela libre cuesta PARCEL_PRICE (se quema).
    ClaimParcel { who: AccountId, x: u16, y: u16, name: Vec<u8>, kind: u8, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Acuña un activo (planta u objeto) en una parcela propia. Su id = txid.
    MintAsset { who: AccountId, x: u16, y: u16, kind: u8, meta: Vec<u8>, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Transfiere un activo propio (no puede estar alquilado).
    TransferAsset { from: AccountId, asset: TxId, to: AccountId, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Publica un activo propio en alquiler: precio por plazo y plazo en bloques.
    ListLease { who: AccountId, asset: TxId, price: Amount, term: u64, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Alquila un activo publicado: paga el precio al dueño y queda arrendatario
    /// hasta altura_actual + plazo.
    Rent { who: AccountId, asset: TxId, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Cosecha: el dueño de la parcela reparte `total` de SU saldo a partes
    /// iguales entre los arrendatarios activos de las plantas de esa parcela.
    Harvest { who: AccountId, x: u16, y: u16, total: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
}

fn put_u8(o: &mut Vec<u8>, x: u8) {
    o.push(x);
}
fn put_u64(o: &mut Vec<u8>, x: u64) {
    o.extend_from_slice(&x.to_le_bytes());
}
fn put_32(o: &mut Vec<u8>, x: &[u8; 32]) {
    o.extend_from_slice(x);
}
fn put_var(o: &mut Vec<u8>, x: &[u8]) {
    put_u64(o, x.len() as u64);
    o.extend_from_slice(x);
}

/// Cuerpo = byte de dominio + campos, EXCLUYENDO la firma.
pub fn encode_body(tx: &Tx) -> Vec<u8> {
    let mut o = Vec::new();
    match tx {
        Tx::Coinbase { height, to, reward, memo } => {
            put_u8(&mut o, T_COINBASE);
            put_u64(&mut o, *height);
            put_32(&mut o, to);
            put_u64(&mut o, *reward);
            put_var(&mut o, memo);
        }
        Tx::Transfer { from, to, amount, fee, nonce, .. } => {
            put_u8(&mut o, T_TRANSFER);
            put_32(&mut o, from);
            put_32(&mut o, to);
            put_u64(&mut o, *amount);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Stake { who, amount, fee, nonce, .. } => {
            put_u8(&mut o, T_STAKE);
            put_32(&mut o, who);
            put_u64(&mut o, *amount);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Unstake { who, amount, fee, nonce, .. } => {
            put_u8(&mut o, T_UNSTAKE);
            put_32(&mut o, who);
            put_u64(&mut o, *amount);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Commit { by, commitment, fee, nonce, .. } => {
            put_u8(&mut o, T_COMMIT);
            put_32(&mut o, by);
            put_32(&mut o, commitment);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Reveal { by, commit_txid, payload, secret, fee, nonce, .. } => {
            put_u8(&mut o, T_REVEAL);
            put_32(&mut o, by);
            put_32(&mut o, commit_txid);
            put_var(&mut o, payload);
            put_var(&mut o, secret);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::ClaimParcel { who, x, y, name, kind, fee, nonce, .. } => {
            put_u8(&mut o, T_CLAIM_PARCEL);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_var(&mut o, name);
            put_u8(&mut o, *kind);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::MintAsset { who, x, y, kind, meta, fee, nonce, .. } => {
            put_u8(&mut o, T_MINT_ASSET);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_u8(&mut o, *kind);
            put_var(&mut o, meta);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::TransferAsset { from, asset, to, fee, nonce, .. } => {
            put_u8(&mut o, T_TRANSFER_ASSET);
            put_32(&mut o, from);
            put_32(&mut o, asset);
            put_32(&mut o, to);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::ListLease { who, asset, price, term, fee, nonce, .. } => {
            put_u8(&mut o, T_LIST_LEASE);
            put_32(&mut o, who);
            put_32(&mut o, asset);
            put_u64(&mut o, *price);
            put_u64(&mut o, *term);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Rent { who, asset, fee, nonce, .. } => {
            put_u8(&mut o, T_RENT);
            put_32(&mut o, who);
            put_32(&mut o, asset);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Harvest { who, x, y, total, fee, nonce, .. } => {
            put_u8(&mut o, T_HARVEST);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_u64(&mut o, *total);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
    }
    o
}

fn sig_of(tx: &Tx) -> Option<&[u8; 64]> {
    match tx {
        Tx::Coinbase { .. } => None,
        Tx::Transfer { sig, .. }
        | Tx::Stake { sig, .. }
        | Tx::Unstake { sig, .. }
        | Tx::Commit { sig, .. }
        | Tx::Reveal { sig, .. }
        | Tx::ClaimParcel { sig, .. }
        | Tx::MintAsset { sig, .. }
        | Tx::TransferAsset { sig, .. }
        | Tx::ListLease { sig, .. }
        | Tx::Rent { sig, .. }
        | Tx::Harvest { sig, .. } => Some(sig),
    }
}

/// Clave firmante (el pagador) de una tx firmada.
pub fn signer_of(tx: &Tx) -> Option<&AccountId> {
    match tx {
        Tx::Coinbase { .. } => None,
        Tx::Transfer { from, .. } => Some(from),
        Tx::Stake { who, .. } | Tx::Unstake { who, .. } => Some(who),
        Tx::Commit { by, .. } | Tx::Reveal { by, .. } => Some(by),
        Tx::ClaimParcel { who, .. }
        | Tx::MintAsset { who, .. }
        | Tx::ListLease { who, .. }
        | Tx::Rent { who, .. }
        | Tx::Harvest { who, .. } => Some(who),
        Tx::TransferAsset { from, .. } => Some(from),
    }
}

/// Comisión de una transacción (0 para la coinbase).
pub fn fee_of(tx: &Tx) -> Amount {
    match tx {
        Tx::Coinbase { .. } => 0,
        Tx::Transfer { fee, .. }
        | Tx::Stake { fee, .. }
        | Tx::Unstake { fee, .. }
        | Tx::Commit { fee, .. }
        | Tx::Reveal { fee, .. }
        | Tx::ClaimParcel { fee, .. }
        | Tx::MintAsset { fee, .. }
        | Tx::TransferAsset { fee, .. }
        | Tx::ListLease { fee, .. }
        | Tx::Rent { fee, .. }
        | Tx::Harvest { fee, .. } => *fee,
    }
}

/// Mensaje firmado = DS_TAG || cuerpo(sin firma).
pub fn signing_message(tx: &Tx) -> Vec<u8> {
    let mut m = DS_TAG.to_vec();
    m.extend_from_slice(&encode_body(tx));
    m
}

fn sha256d(data: &[u8]) -> [u8; 32] {
    let a = Sha256::digest(data);
    let b = Sha256::digest(a);
    let mut out = [0u8; 32];
    out.copy_from_slice(&b);
    out
}

/// txid = sha256d(cuerpo || firma). La firma va DENTRO del txid (anti-maleabilidad).
pub fn txid(tx: &Tx) -> TxId {
    let mut buf = encode_body(tx);
    if let Some(sig) = sig_of(tx) {
        buf.extend_from_slice(sig);
    }
    sha256d(&buf)
}

/// commit_hash = sha256(canon(payload) || secret). SHA-256 simple (no doble) para
/// coincidir byte a byte con el hexdigest de la referencia Python.
pub fn commit_hash(payload: &Value, secret: &[u8]) -> Result<[u8; 32], String> {
    let mut buf = canon(payload)?.into_bytes();
    buf.extend_from_slice(secret);
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(&buf));
    Ok(out)
}

/// Raíz de Merkle sobre txids (SHA-256d, duplica el último si impar). Bloque
/// vacío -> 32 ceros.
pub fn merkle_root_txids(txids: &[TxId]) -> [u8; 32] {
    if txids.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<[u8; 32]> = txids.to_vec();
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(*level.last().unwrap());
        }
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(&pair[0]);
            buf[32..].copy_from_slice(&pair[1]);
            next.push(sha256d(&buf));
        }
        level = next;
    }
    level[0]
}

/// Verificación SIN estado: estructura + firma. Las comprobaciones económicas
/// (saldo, orden de nonce, cota de recompensa, suficiencia de stake) y las de
/// commit/reveal con estado se hacen en la transición de estado.
pub fn verify_tx(tx: &Tx) -> Result<(), String> {
    // Cotas estructurales (anti-DoS / anti-bloat), sin estado.
    match tx {
        Tx::Reveal { payload, .. } if payload.len() > MAX_PAYLOAD_BYTES => {
            return Err("payload de reveal excede MAX_PAYLOAD_BYTES".into());
        }
        Tx::ClaimParcel { x, y, name, kind, .. } => {
            if *x >= CITY_SIZE || *y >= CITY_SIZE {
                return Err("parcela fuera de la ciudad".into());
            }
            if name.is_empty() || name.len() > MAX_NAME_BYTES || std::str::from_utf8(name).is_err() {
                return Err("nombre de parcela vacío, demasiado largo o no UTF-8".into());
            }
            if *kind > MAX_PARCEL_KIND {
                return Err("tipo de parcela desconocido".into());
            }
        }
        Tx::MintAsset { x, y, kind, meta, .. } => {
            if *x >= CITY_SIZE || *y >= CITY_SIZE {
                return Err("parcela fuera de la ciudad".into());
            }
            if meta.len() > MAX_META_BYTES || std::str::from_utf8(meta).is_err() {
                return Err("metadatos del activo demasiado largos o no UTF-8".into());
            }
            if *kind > MAX_ASSET_KIND {
                return Err("tipo de activo desconocido".into());
            }
        }
        Tx::ListLease { term, .. } => {
            if *term == 0 || *term > MAX_LEASE_TERM {
                return Err("plazo de alquiler fuera de rango".into());
            }
        }
        Tx::Harvest { x, y, total, .. } => {
            if *x >= CITY_SIZE || *y >= CITY_SIZE {
                return Err("parcela fuera de la ciudad".into());
            }
            if *total == 0 {
                return Err("la cosecha debe repartir algo".into());
            }
        }
        _ => {}
    }
    // La coinbase no lleva firma.
    let (Some(sig_bytes), Some(pk_bytes)) = (sig_of(tx), signer_of(tx)) else {
        return match tx {
            Tx::Coinbase { .. } => Ok(()),
            _ => Err("transacción firmada sin firma o sin firmante".into()),
        };
    };
    let vk = VerifyingKey::from_bytes(pk_bytes).map_err(|_| "pubkey inválida".to_string())?;
    let signature = Signature::from_bytes(sig_bytes);
    // verify_strict rechaza claves de orden pequeño / no canónicas.
    vk.verify_strict(&signing_message(tx), &signature)
        .map_err(|_| "firma inválida".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::KeyPair;
    use serde_json::json;

    fn signed_transfer(kp: &KeyPair, to: AccountId, amount: u64, nonce: u64) -> Tx {
        let mut tx = Tx::Transfer { from: kp.public_bytes(), to, amount, fee: 1, nonce, sig: [0u8; 64] };
        let sig = kp.sign(&signing_message(&tx));
        if let Tx::Transfer { sig: s, .. } = &mut tx {
            *s = sig;
        }
        tx
    }

    #[test]
    fn transfer_verifies_and_detects_tamper() {
        let kp = KeyPair::from_secret(&[3u8; 32]);
        let tx = signed_transfer(&kp, [9u8; 32], 100, 0);
        assert!(verify_tx(&tx).is_ok());
        // manipular el importe invalida la firma
        let mut bad = tx.clone();
        if let Tx::Transfer { amount, .. } = &mut bad {
            *amount = 101;
        }
        assert!(verify_tx(&bad).is_err());
    }

    #[test]
    fn txid_covers_signature() {
        let kp = KeyPair::from_secret(&[4u8; 32]);
        let a = signed_transfer(&kp, [1u8; 32], 5, 0);
        let mut b = a.clone();
        if let Tx::Transfer { sig, .. } = &mut b {
            sig[0] ^= 0xFF; // maleabilidad de firma
        }
        assert_ne!(txid(&a), txid(&b)); // distinto txid => no maleable
    }

    #[test]
    fn coinbase_has_no_signature_and_verifies() {
        let cb = Tx::Coinbase { height: 0, to: [1u8; 32], reward: 50, memo: b"genesis".to_vec() };
        assert!(verify_tx(&cb).is_ok());
    }

    #[test]
    fn commit_hash_matches_reference_layer() {
        let payload = json!({"pair":"BTC","dir":"LONG","z":2.0});
        let secret = [0u8; 32];
        let c = commit_hash(&payload, &secret).unwrap();
        // Igual que reference/rami_ledger.py commit_hash con nonce de ceros.
        assert_eq!(hex::encode(c), "107a3366fe9633b88c49a21c63ddc9655ec878fca2671be19155a8969e545603");
    }

    #[test]
    fn empty_merkle_is_zero() {
        assert_eq!(merkle_root_txids(&[]), [0u8; 32]);
    }
}
