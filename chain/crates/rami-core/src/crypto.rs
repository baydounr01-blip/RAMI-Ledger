//! Firmas Ed25519 y derivación de direcciones.
//!
//! Dirección = primeros 20 bytes de sha256(pubkey), en hex con prefijo "rami1".
//! (Elección deliberadamente simple y verificable; sin checksum bech32 en v0.1.)

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::OsRng;

use crate::hashing::sha256;

pub const ADDRESS_PREFIX: &str = "rami1";
pub const ADDRESS_BYTES: usize = 20;

/// Par de claves Ed25519.
pub struct KeyPair {
    signing: SigningKey,
}

impl KeyPair {
    /// Genera un par nuevo con el RNG del sistema.
    pub fn generate() -> Self {
        Self { signing: SigningKey::generate(&mut OsRng) }
    }

    /// Reconstruye desde 32 bytes de clave privada.
    pub fn from_secret(secret: &[u8; 32]) -> Self {
        Self { signing: SigningKey::from_bytes(secret) }
    }

    pub fn secret_bytes(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    pub fn public_bytes(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }

    pub fn address(&self) -> String {
        address_from_pubkey(&self.public_bytes())
    }
}

/// Verifica una firma Ed25519 de 64 bytes contra una pubkey de 32 bytes.
pub fn verify(pubkey: &[u8; 32], message: &[u8], sig: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pubkey) else {
        return false;
    };
    let signature = Signature::from_bytes(sig);
    vk.verify(message, &signature).is_ok()
}

/// Etiqueta de dominio de la FIRMA DE RELEASE: el mantenedor firma con Ed25519
/// (la misma criptografía de la cadena) el `SHA256SUMS.txt` de cada release y
/// el monedero solo instala una actualización cuya lista de hashes lleve esa
/// firma. Una firma de release nunca puede confundirse con una transacción
/// (DS_TAG de tx) ni con un saludo P2P (transcripción "RAMI-P2P-v2").
pub const RELEASE_SIG_DS: &[u8] = b"RAMI-CHAIN/release/v1";

/// Mensaje que se firma para un archivo de release: `RELEASE_SIG_DS || bytes`.
pub fn release_message(file_bytes: &[u8]) -> Vec<u8> {
    let mut m = RELEASE_SIG_DS.to_vec();
    m.extend_from_slice(file_bytes);
    m
}

/// Verifica la firma de release (hex de 64 bytes) de `file_bytes` con la
/// clave pública del mantenedor (hex de 32 bytes).
pub fn verify_release_signature(pubkey_hex: &str, file_bytes: &[u8], sig_hex: &str) -> Result<(), String> {
    let pk: [u8; 32] = hex::decode(pubkey_hex.trim())
        .map_err(|_| "clave pública de release no es hex".to_string())?
        .try_into()
        .map_err(|_| "clave pública de release: longitud incorrecta".to_string())?;
    let sig: [u8; 64] = hex::decode(sig_hex.trim())
        .map_err(|_| "firma de release no es hex".to_string())?
        .try_into()
        .map_err(|_| "firma de release: longitud incorrecta".to_string())?;
    if verify(&pk, &release_message(file_bytes), &sig) {
        Ok(())
    } else {
        Err("la firma de release NO es válida".into())
    }
}

/// Dirección legible a partir de la pubkey.
pub fn address_from_pubkey(pubkey: &[u8; 32]) -> String {
    let h = sha256(pubkey);
    format!("{}{}", ADDRESS_PREFIX, hex::encode(&h[..ADDRESS_BYTES]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip() {
        let kp = KeyPair::generate();
        let msg = b"rami-chain";
        let sig = kp.sign(msg);
        assert!(verify(&kp.public_bytes(), msg, &sig));
        assert!(!verify(&kp.public_bytes(), b"otro", &sig));
    }

    #[test]
    fn address_is_deterministic_and_prefixed() {
        let kp = KeyPair::from_secret(&[7u8; 32]);
        let a = kp.address();
        assert!(a.starts_with("rami1"));
        assert_eq!(a.len(), 5 + 40);
        assert_eq!(a, kp.address()); // determinista
    }
}
