//! Hashing y árbol de Merkle, estilo Bitcoin (SHA-256d), idénticos a la
//! referencia Python para que un verificador externo reproduzca las raíces.

use sha2::{Digest, Sha256};

/// SHA-256 simple.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(data));
    out
}

/// SHA-256 doble (SHA256d), la primitiva de PoW y Merkle de Bitcoin.
pub fn sha256d(data: &[u8]) -> [u8; 32] {
    sha256(&sha256(data))
}

/// Raíz de Merkle sobre hojas ya hasheadas. Si un nivel tiene un número impar
/// de nodos, se duplica el último (regla de Bitcoin). Lista vacía -> sha256("").
pub fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return sha256(b"");
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256d_known_vector() {
        // SHA256d("") — vector conocido.
        assert_eq!(
            hex::encode(sha256d(b"")),
            "5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456"
        );
    }

    #[test]
    fn merkle_single_leaf() {
        let leaf = sha256(b"tx0");
        assert_eq!(merkle_root(&[leaf]), leaf);
    }

    #[test]
    fn merkle_odd_duplicates_last() {
        let a = sha256(b"a");
        let b = sha256(b"b");
        let c = sha256(b"c");
        // Con 3 hojas se duplica la última: root = d(d(a,b), d(c,c)).
        let mut ab = [0u8; 64];
        ab[..32].copy_from_slice(&a);
        ab[32..].copy_from_slice(&b);
        let mut cc = [0u8; 64];
        cc[..32].copy_from_slice(&c);
        cc[32..].copy_from_slice(&c);
        let mut top = [0u8; 64];
        top[..32].copy_from_slice(&sha256d(&ab));
        top[32..].copy_from_slice(&sha256d(&cc));
        assert_eq!(merkle_root(&[a, b, c]), sha256d(&top));
    }
}
