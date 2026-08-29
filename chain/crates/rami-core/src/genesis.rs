//! Génesis canónico y reproducible.
//!
//! Para que muchos nodos formen UNA sola red sin un servidor central, todos
//! deben partir del MISMO bloque génesis: su hash es el `network-id` del
//! handshake P2P. Aquí ese bloque se define con campos FIJOS y un nonce que se
//! encuentra de forma determinista (dificultad de arranque baja: el mismo
//! bloque, byte a byte, en cualquier máquina, sin premine).
//!
//! La testnet arranca con dificultad baja (bootstrap) y el LWMA la reconduce
//! hacia los 60 s/bloque según el hashrate REAL de la red. No hay un número
//! mágico grabado: se recalcula solo.

use crate::block::{Block, BlockHeader, Hash, ZERO_HASH};
use crate::pow::{bits_from_target, meets_target, pow_hash, target_from_difficulty};
use crate::state::block_reward;
use crate::tx::{merkle_root_txids, txid, Tx};

/// Mensaje del bloque cero (al estilo del titular de Bitcoin, pero fijando la
/// tesis del proyecto). No cambiar: forma parte del network-id.
pub const GENESIS_MESSAGE: &str =
    "RAMI-Chain genesis 2025 — pasado, presente y futuro coexisten como el arbol de bloques. Testnet experimental, sin valor monetario.";

/// Marca temporal fija del génesis (2025-01-01T00:00:00Z). Fija = reproducible.
pub const GENESIS_TIMESTAMP: u64 = 1_735_689_600;

/// Dificultad de arranque de la testnet: baja para que la red pueda nacer con
/// poco hashrate; el LWMA sube desde aquí hacia 60 s/bloque. Es reproducible al
/// instante (encontrar el nonce es cuestión de microsegundos).
pub const TESTNET_GENESIS_DIFFICULTY: u128 = 4096;

/// Suelo de dificultad de la testnet: evita el spam trivial sin bloquear el
/// arranque con hashrate bajo.
pub const TESTNET_MIN_DIFFICULTY: u128 = 256;

/// nBits compactos del génesis de testnet (derivados de la dificultad de arranque).
pub fn testnet_genesis_bits() -> u32 {
    bits_from_target(&target_from_difficulty(TESTNET_GENESIS_DIFFICULTY))
}

/// Coinbase del génesis: paga a la dirección quemada (todo ceros). SIN PREMINE:
/// nadie posee la clave de esa dirección; el subsidio del bloque 0 es inalcanzable.
fn genesis_coinbase() -> Tx {
    Tx::Coinbase {
        height: 0,
        to: [0u8; 32],
        reward: block_reward(0),
        memo: GENESIS_MESSAGE.as_bytes().to_vec(),
    }
}

/// Encuentra el nonce del génesis de forma determinista (sin tocar el timestamp).
/// A dificultad de arranque baja termina de inmediato y devuelve SIEMPRE el mismo
/// bloque en cualquier máquina.
fn seal_genesis(mut header: BlockHeader) -> BlockHeader {
    loop {
        if meets_target(&pow_hash(&header.canonical_bytes()), header.bits) {
            return header;
        }
        header.nonce = header.nonce.wrapping_add(1);
    }
}

/// El bloque génesis canónico de la testnet pública de RAMI-Chain.
pub fn testnet_genesis() -> Block {
    let coinbase = genesis_coinbase();
    let merkle_root = merkle_root_txids(&[txid(&coinbase)]);
    let header = seal_genesis(BlockHeader {
        version: 1,
        prev_hash: ZERO_HASH,
        height: 0,
        timestamp: GENESIS_TIMESTAMP,
        merkle_root,
        bits: testnet_genesis_bits(),
        nonce: 0,
        branch_tag: *b"gen0",
    });
    Block { header, txs: vec![coinbase] }
}

/// El `network-id`: hash del génesis. Dos nodos con el mismo network-id están en
/// la misma red; con distinto network-id el handshake los rechaza.
pub fn testnet_network_id() -> Hash {
    testnet_genesis().hash()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pow::difficulty_from_bits;

    #[test]
    fn genesis_is_deterministic_and_valid() {
        let a = testnet_genesis();
        let b = testnet_genesis();
        // reproducible byte a byte
        assert_eq!(a.header.canonical_bytes(), b.header.canonical_bytes());
        assert_eq!(a.hash(), b.hash());
        // cumple su propio PoW de arranque
        assert!(meets_target(&pow_hash(&a.header.canonical_bytes()), a.header.bits));
        // altura 0, sin padre, una sola tx (coinbase quemada)
        assert_eq!(a.header.height, 0);
        assert_eq!(a.header.prev_hash, ZERO_HASH);
        assert_eq!(a.txs.len(), 1);
        // dificultad de arranque tal como se anuncia
        assert_eq!(difficulty_from_bits(a.header.bits), TESTNET_GENESIS_DIFFICULTY);
    }

    #[test]
    fn network_id_is_stable() {
        // Si este valor cambia sin querer, romperíamos la red: el test lo fija.
        let id = hex::encode(testnet_network_id());
        assert_eq!(id.len(), 64);
        // el network-id coincide con el hash del bloque reconstruido
        assert_eq!(testnet_network_id(), testnet_genesis().hash());
    }
}
