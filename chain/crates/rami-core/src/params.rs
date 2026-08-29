//! Parámetros de red. Fijan la dificultad de génesis y el suelo de dificultad.
//! `testnet()` usa la calibración real (≈1 CPU a 1e6 H/s => 60 s/bloque). `regtest()`
//! usa dificultad 1 (todo hash pasa) para pruebas deterministas e instantáneas.

use crate::genesis::{testnet_genesis_bits, TESTNET_MIN_DIFFICULTY};
use crate::pow::{bits_from_target, target_from_difficulty};

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub genesis_bits: u32,
    pub min_difficulty: u128,
}

impl Params {
    /// Red de pruebas pública de RAMI-Chain (la real). Arranca con dificultad
    /// baja y el LWMA la reconduce hacia 60 s/bloque según el hashrate real.
    /// El génesis es fijo (`crate::genesis::testnet_genesis`), así que todos los
    /// nodos comparten el mismo network-id.
    pub fn testnet() -> Self {
        Params { genesis_bits: testnet_genesis_bits(), min_difficulty: TESTNET_MIN_DIFFICULTY }
    }

    /// Regtest: dificultad 1, minería instantánea. Solo para tests locales.
    pub fn regtest() -> Self {
        let bits = bits_from_target(&target_from_difficulty(1));
        Params { genesis_bits: bits, min_difficulty: 1 }
    }
}
