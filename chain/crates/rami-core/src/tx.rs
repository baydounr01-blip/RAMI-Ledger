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
        | Tx::Reveal { sig, .. } => Some(sig),
    }
}

/// Clave firmante (el pagador) de una tx firmada.
pub fn signer_of(tx: &Tx) -> Option<&AccountId> {
    match tx {
        Tx::Coinbase { .. } => None,
        Tx::Transfer { from, .. } => Some(from),
        Tx::Stake { who, .. } | Tx::Unstake { who, .. } => Some(who),
        Tx::Commit { by, .. } | Tx::Reveal { by, .. } => Some(by),
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
    // Cota de payload del Reveal (anti-DoS).
    if let Tx::Reveal { payload, .. } = tx {
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err("payload de reveal excede MAX_PAYLOAD_BYTES".into());
        }
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
