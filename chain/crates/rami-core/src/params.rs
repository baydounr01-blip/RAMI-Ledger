//! Parámetros de red. Fijan la dificultad de génesis, el suelo de dificultad y
//! la FECHA de activación de la regla de firma v2 (firma ligada a la red).
//! `testnet()` usa la calibración real (≈1 CPU a 1e6 H/s => 60 s/bloque). `regtest()`
//! usa dificultad 1 (todo hash pasa) para pruebas deterministas e instantáneas.

use crate::genesis::{testnet_genesis_bits, TESTNET_MIN_DIFFICULTY};
use crate::pow::{bits_from_target, target_from_difficulty};

/// Activación de la firma v2 en la testnet: 2026-10-20 00:00:00 UTC (segundos
/// Unix). Un bloque cuyo `timestamp` sea ≥ esta fecha solo admite transacciones
/// firmadas con `"RAMI-CHAIN/tx/v2" || network_id || cuerpo`; uno anterior,
/// solo con la regla v1. Es un cambio de consenso: los nodos que no actualicen
/// dejan de seguir la cadena a partir de esa fecha (ver docs/CONSENSO-V2.md).
pub const FIRMA_V2_DESDE_TESTNET: u64 = 1_792_454_400;

/// Activación de **Dubái** (v0.9.0) en la testnet: 2026-12-01 00:00:00 UTC.
/// Desde esa fecha (y sin vuelta atrás dentro de una rama) rigen las reglas de
/// `crate::ciudad`: cuadrícula 64×64, 30 sectores, precio de parcela por
/// distrito, fondo de la ciudad (20 % de la emisión) y su reparto por bloque,
/// compra/venta de parcelas y activos. Segundo cambio de consenso: los nodos
/// que no actualicen dejan de seguir la cadena desde el primer bloque que la
/// aplique (ver docs/DUBAI.md).
pub const DUBAI_DESDE_TESTNET: u64 = 1_796_083_200;

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub genesis_bits: u32,
    pub min_difficulty: u128,
    /// Fecha (Unix) desde la que rige la regla de firma v2; `None` = nunca
    /// (solo tiene sentido en regtest).
    pub firma_v2_desde: Option<u64>,
    /// Fecha (Unix) desde la que rigen las reglas de Dubái (`crate::ciudad`);
    /// `None` = nunca (regtest por defecto).
    pub dubai_desde: Option<u64>,
}

impl Params {
    /// Red de pruebas pública de RAMI-Chain (la real). Arranca con dificultad
    /// baja y el LWMA la reconduce hacia 60 s/bloque según el hashrate real.
    /// El génesis es fijo (`crate::genesis::testnet_genesis`), así que todos los
    /// nodos comparten el mismo network-id.
    pub fn testnet() -> Self {
        Params {
            genesis_bits: testnet_genesis_bits(),
            min_difficulty: TESTNET_MIN_DIFFICULTY,
            firma_v2_desde: Some(FIRMA_V2_DESDE_TESTNET),
            dubai_desde: Some(DUBAI_DESDE_TESTNET),
        }
    }

    /// Regtest: dificultad 1, minería instantánea. Solo para tests locales. La
    /// regla v2 está desactivada salvo que se pida (`con_firma_v2_desde`), para
    /// que las pruebas de compatibilidad con versiones anteriores sigan
    /// valiendo tal cual.
    pub fn regtest() -> Self {
        let bits = bits_from_target(&target_from_difficulty(1));
        Params { genesis_bits: bits, min_difficulty: 1, firma_v2_desde: None, dubai_desde: None }
    }

    /// Mismos parámetros con otra fecha de activación (pruebas y regtest).
    pub fn con_firma_v2_desde(mut self, desde: Option<u64>) -> Self {
        self.firma_v2_desde = desde;
        self
    }

    /// Mismos parámetros con otra fecha de activación de Dubái (pruebas y regtest).
    pub fn con_dubai_desde(mut self, desde: Option<u64>) -> Self {
        self.dubai_desde = desde;
        self
    }
}
