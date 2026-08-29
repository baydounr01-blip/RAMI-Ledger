//! # RAMI-Chain — MATEMÁTICA NO PROBADA / EXPERIMENTAL / UNPROVEN
//!
//! ## Desempate de fork-choice por transformada de Collatz (colapso de coherencia)
//!
//! ÚLTIMO criterio de fork-choice: cuando dos puntas (tips) de ramas rivales
//! tienen trabajo acumulado EXACTAMENTE igual, elige de forma determinista cuál
//! es la cabeza canónica. Es la "decoherencia" del Universo de Bloques
//! Ramificados: dos historias de igual peso colapsan a una.
//!
//! ### CONJETURA EXACTA (NO PROBADA NI REFUTADA)
//! Conjetura de Collatz (3n+1): para todo entero n >= 1, iterar
//!     T(n) = n/2      si n es par
//!     T(n) = 3n + 1   si n es impar
//! alcanza finalmente el 1. Estado: abierta (sin prueba y sin contraejemplo;
//! verificada por computadora hasta ~2^68). Propiedad ADICIONAL de la que
//! depende SOLO la CALIDAD del desempate (resistencia a grinding), también NO
//! PROBADA: los vectores de paridad de las órbitas de Collatz están
//! equidistribuidos / se comportan pseudoaleatoriamente (Terras, Lagarias).
//!
//! ### POR QUÉ ES SEGURO SI LA CONJETURA ES FALSA
//! * La terminación NO depende de Collatz: `COLLATZ_STEP_CAP` acota cada llamada.
//! * El desempate solo se ejecuta entre puntas de trabajo IDÉNTICO; nunca cambia
//!   el trabajo, la validez, la emisión, ni ningún saldo o raíz de Merkle.
//! * Si alguna semilla no converge dentro del presupuesto (contraejemplo real, o
//!   desbordamiento de 3n+1), se DEGRADA a comparación lexicográfica pura de los
//!   hashes: sigue siendo determinista y total. Peor caso: desempate más débil,
//!   JAMÁS una división de consenso ni un error de emisión.

use std::cmp::Ordering;

pub const COLLATZ_STEP_CAP: u32 = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tiebreak {
    pub converged: bool,
    pub steps: u32,
    pub score: u64,
}

fn seed_from_hash(tip_hash: &[u8; 32]) -> u128 {
    let mut hi = [0u8; 16];
    let mut lo = [0u8; 16];
    hi.copy_from_slice(&tip_hash[..16]);
    lo.copy_from_slice(&tip_hash[16..]);
    let s = u128::from_be_bytes(hi) ^ u128::from_be_bytes(lo);
    if s == 0 {
        1
    } else {
        s | 1
    }
}

pub fn collatz_tiebreak(tip_hash: &[u8; 32]) -> Tiebreak {
    let mut n: u128 = seed_from_hash(tip_hash);
    let mut acc: u64 = 0x9E37_79B9_7F4A_7C15u64 ^ (n as u64);
    let mut steps: u32 = 0;

    while n != 1 && steps < COLLATZ_STEP_CAP {
        let bit = (n & 1) as u64;
        acc = (acc ^ bit).wrapping_mul(0x2545_F491_4F6C_DD1D).rotate_left(29);
        if n & 1 == 0 {
            n >>= 1;
        } else {
            match n.checked_mul(3).and_then(|v| v.checked_add(1)) {
                Some(v) => n = v,
                None => return Tiebreak { converged: false, steps, score: acc },
            }
        }
        steps += 1;
    }

    let converged = n == 1;
    let score = acc ^ (steps as u64).rotate_left(32) ^ ((converged as u64) << 63);
    Tiebreak { converged, steps, score }
}

/// Orden total y determinista entre dos puntas de trabajo IGUAL.
/// `Less` cuando `a` debe ser la cabeza canónica (mayor score gana);
/// `Equal` solo cuando `a == b`.
pub fn canonical_tip_order(a: &[u8; 32], b: &[u8; 32]) -> Ordering {
    let ta = collatz_tiebreak(a);
    let tb = collatz_tiebreak(b);
    if ta.converged && tb.converged {
        match tb.score.cmp(&ta.score) {
            Ordering::Equal => a.cmp(b),
            other => other,
        }
    } else {
        a.cmp(b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_bounded() {
        let mut h = [0u8; 32];
        h[31] = 27;
        let t = collatz_tiebreak(&h);
        assert!(t.converged);
        assert!(t.steps <= COLLATZ_STEP_CAP);
        assert_eq!(t, collatz_tiebreak(&h));
    }

    #[test]
    fn total_order_is_antisymmetric_and_reflexive() {
        let mut a = [0u8; 32];
        a[31] = 7;
        let mut b = [0u8; 32];
        b[31] = 9;
        assert_eq!(canonical_tip_order(&a, &a), Ordering::Equal);
        assert_eq!(canonical_tip_order(&a, &b), canonical_tip_order(&b, &a).reverse());
    }
}
