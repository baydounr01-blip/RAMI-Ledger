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
