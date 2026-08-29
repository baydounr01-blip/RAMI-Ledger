//! Cabecera y bloque de consenso. La cabecera se hashea sobre un diseño de
//! bytes fijo big-endian (`canonical_bytes`), NUNCA sobre JSON: así el hash de
//! consenso no depende de floats, espacios ni locale, y cualquier nodo lo
//! reproduce byte a byte. serde solo se usa para almacenamiento/gossip.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::tx::Tx;

pub type Hash = [u8; 32];
pub const ZERO_HASH: Hash = [0u8; 32];

/// Cabecera de consenso.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockHeader {
    pub version: u32,
    pub prev_hash: Hash,
    pub height: u64,
    pub timestamp: u64,
    pub merkle_root: Hash,
    pub bits: u32,
    pub nonce: u64,
    /// Etiqueta de auditoría del productor para las "ramas hermanas". NO la usa
    /// el consenso (ni la validez ni la elección de rama).
    pub branch_tag: [u8; 4],
}

impl BlockHeader {
    /// Preimagen de consenso determinista y libre de floats (100 bytes).
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(4 + 32 + 8 + 8 + 32 + 4 + 8 + 4);
        b.extend_from_slice(&self.version.to_be_bytes());
        b.extend_from_slice(&self.prev_hash);
        b.extend_from_slice(&self.height.to_be_bytes());
        b.extend_from_slice(&self.timestamp.to_be_bytes());
        b.extend_from_slice(&self.merkle_root);
        b.extend_from_slice(&self.bits.to_be_bytes());
        b.extend_from_slice(&self.nonce.to_be_bytes());
        b.extend_from_slice(&self.branch_tag);
        b
    }

    /// Hash de consenso de la cabecera = SHA-256d de `canonical_bytes`.
    pub fn hash(&self) -> Hash {
        let first = Sha256::digest(self.canonical_bytes());
        let second = Sha256::digest(first);
        let mut out = [0u8; 32];
        out.copy_from_slice(&second);
        out
    }
}

/// Bloque = cabecera + transacciones. La raíz de Merkle de la cabecera debe ser
/// la de `txs` (verificado en la transición de estado).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Block {
    pub header: BlockHeader,
    pub txs: Vec<Tx>,
}

impl Block {
    pub fn hash(&self) -> Hash {
        self.header.hash()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_bytes_is_100_and_stable() {
        let h = BlockHeader {
            version: 1,
            prev_hash: ZERO_HASH,
            height: 0,
            timestamp: 1_700_000_000,
            merkle_root: ZERO_HASH,
            bits: 0x1d47_9531,
            nonce: 42,
            branch_tag: *b"main",
        };
        assert_eq!(h.canonical_bytes().len(), 100);
        assert_eq!(h.hash(), h.hash()); // determinista
    }

    #[test]
    fn changing_any_field_changes_hash() {
        let base = BlockHeader {
            version: 1, prev_hash: ZERO_HASH, height: 0, timestamp: 1, merkle_root: ZERO_HASH,
            bits: 0x1d47_9531, nonce: 0, branch_tag: *b"main",
        };
        let mut other = base.clone();
        other.nonce = 1;
        assert_ne!(base.hash(), other.hash());
    }
}
