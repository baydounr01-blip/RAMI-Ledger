//! Parámetros de red. Fijan la dificultad de génesis y el suelo de dificultad.
//! `testnet()` usa la calibración real (≈1 CPU a 1e6 H/s => 60 s/bloque). `regtest()`
//! usa dificultad 1 (todo hash pasa) para pruebas deterministas e instantáneas.

use crate::pow::{bits_from_target, target_from_difficulty, GENESIS_BITS, GENESIS_DIFFICULTY};

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub genesis_bits: u32,
    pub min_difficulty: u128,
}

impl Params {
    /// Red de pruebas pública de RAMI-Chain (la real).
    pub fn testnet() -> Self {
        Params { genesis_bits: GENESIS_BITS, min_difficulty: GENESIS_DIFFICULTY }
    }

    /// Regtest: dificultad 1, minería instantánea. Solo para tests locales.
    pub fn regtest() -> Self {
        let bits = bits_from_target(&target_from_difficulty(1));
        Params { genesis_bits: bits, min_difficulty: 1 }
    }
}
