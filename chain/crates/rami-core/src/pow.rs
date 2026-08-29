//! Prueba de trabajo SHA-256d, codificación compacta de objetivo ("bits" estilo
//! Bitcoin) y retargeting LWMA-1 por bloque. Todo entero, determinista, bit-exacto.
//!
//! Números de génesis (calculados para una testnet minada por CPUs):
//!   * tiempo de bloque objetivo = 60 s
//!   * dificultad de génesis = 60_000_000 hashes esperados/bloque (≈1 CPU a 1e6 H/s)
//!   * nBits de génesis = 0x1d479531
//! La red neuronal y el desempate de Collatz NUNCA tocan este objetivo ni el retarget.

use sha2::{Digest, Sha256};

pub const TARGET_SPACING: u64 = 60;
pub const LWMA_N: u64 = 60;
pub const GENESIS_BITS: u32 = 0x1d47_9531;
pub const GENESIS_DIFFICULTY: u128 = 60_000_000;

const MAX256: [u8; 32] = [0xFF; 32];

pub fn pow_hash(header_bytes: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(header_bytes);
    let second = Sha256::digest(first);
    let mut out = [0u8; 32];
    out.copy_from_slice(&second);
    out
}

pub fn target_from_bits(bits: u32) -> [u8; 32] {
    let exp = (bits >> 24) as usize;
    let mant = bits & 0x007f_ffff;
    let mut t = [0u8; 32];
    if exp == 0 {
        return t;
    }
    let mb = [(mant >> 16) as u8, (mant >> 8) as u8, mant as u8];
    for k in 0..3 {
        let place = exp as isize - 1 - k as isize;
        if place < 0 || place >= 32 {
            continue;
        }
        t[31 - place as usize] = mb[k];
    }
    t
}

pub fn bits_from_target(target: &[u8; 32]) -> u32 {
    let mut i = 0usize;
    while i < 32 && target[i] == 0 {
        i += 1;
    }
    if i == 32 {
        return 0;
    }
    let mut size = (32 - i) as u32;
    let b0 = target[i];
    let b1 = if i + 1 < 32 { target[i + 1] } else { 0 };
    let b2 = if i + 2 < 32 { target[i + 2] } else { 0 };
    let mut mant = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
    if mant & 0x0080_0000 != 0 {
        mant >>= 8;
        size += 1;
    }
    (size << 24) | (mant & 0x007f_ffff)
}

/// PoW: hash <= objetivo. DEBE ser `<=` (no `<`) en toda implementación o hay fork.
pub fn meets_target(hash_be: &[u8; 32], bits: u32) -> bool {
    let target = target_from_bits(bits);
    for k in 0..32 {
        if hash_be[k] != target[k] {
            return hash_be[k] < target[k];
        }
    }
    true
}

fn u256_div_u128(dividend: &[u8; 32], divisor: u128) -> [u8; 32] {
    let mut q = [0u8; 32];
    let mut rem: u128 = 0;
    for bit in 0..256usize {
        let b = (dividend[bit / 8] >> (7 - (bit % 8))) & 1;
        rem = (rem << 1) | b as u128;
        if rem >= divisor {
            rem -= divisor;
            q[bit / 8] |= 1 << (7 - (bit % 8));
        }
    }
    q
}

pub fn target_from_difficulty(difficulty: u128) -> [u8; 32] {
    assert!(difficulty > 0);
    // El divisor debe caber en u64 para que rem<<1 no desborde u128 (testnet).
    assert!(difficulty <= u64::MAX as u128, "dificultad fuera de rango testnet");
    u256_div_u128(&MAX256, difficulty)
}

/// Dificultad en unidades de "hashes esperados" = floor((2^256-1)/target).
/// Coincide con la calibración de génesis (target_from_difficulty es su inversa).
/// División bit-serie de un u256 entre un u256, cociente acumulado en u128
/// (satura si excediera, imposible a escala testnet).
pub fn difficulty_from_target(target: &[u8; 32]) -> u128 {
    // divisor == 0 no puede ocurrir con bits válidos; se trata como dificultad máxima.
    if target.iter().all(|&b| b == 0) {
        return u128::MAX;
    }
    let mut rem: [u8; 32] = [0u8; 32];
    let mut q: u128 = 0;
    for bit in 0..256usize {
        // rem = (rem << 1) | dividendo_bit ; dividendo = MAX256 (todos unos)
        let mut carry = 1u8; // el bit del dividendo (MAX256) siempre es 1
        for byte in rem.iter_mut().rev() {
            let new = ((*byte as u16) << 1) | carry as u16;
            *byte = new as u8;
            carry = (new >> 8) as u8;
        }
        // si rem >= target: rem -= target; q = q*2 + 1 ; else q = q*2
        if ge_256(&rem, target) {
            sub_256(&mut rem, target);
            q = q.saturating_mul(2).saturating_add(1);
        } else {
            q = q.saturating_mul(2);
        }
        let _ = bit;
    }
    q.max(1)
}

fn ge_256(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] != b[i] {
            return a[i] > b[i];
        }
    }
    true
}

fn sub_256(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let diff = a[i] as i16 - b[i] as i16 - borrow;
        if diff < 0 {
            a[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            a[i] = diff as u8;
            borrow = 0;
        }
    }
}

/// Dificultad (hashes esperados) a partir de los bits compactos.
pub fn difficulty_from_bits(bits: u32) -> u128 {
    difficulty_from_target(&target_from_bits(bits))
}

/// Trabajo de un bloque a partir de sus bits ~= 2^128 / (target+1). Entero, para
/// acumular cum_work en u128 (supuesto de testnet).
pub fn work_from_bits(bits: u32) -> u128 {
    let target = target_from_bits(bits);
    // target como u128 saturado (los bytes altos son 0 en dificultades de testnet).
    let mut hi: u128 = 0;
    for &byte in target.iter() {
        hi = hi.saturating_mul(256).saturating_add(byte as u128);
        if hi == u128::MAX {
            break;
        }
    }
    if hi == u128::MAX {
        1 // objetivo enorme => trabajo mínimo
    } else {
        (u128::MAX / hi.saturating_add(1)).max(1)
    }
}

/// LWMA-1: `window` = últimos (LWMA_N+1) pares (timestamp, dificultad), más antiguo
/// primero. Recalculado cada bloque. Devuelve los bits compactos del siguiente.
pub fn lwma_next_bits(window: &[(u64, u128)], min_difficulty: u128) -> u32 {
    let n = LWMA_N as usize;
    if window.len() < n + 1 {
        return bits_from_target(&target_from_difficulty(min_difficulty));
    }
    let start = window.len() - (n + 1);
    let t = TARGET_SPACING as i128;

    let mut weighted: i128 = 0;
    let mut sum_d: u128 = 0;
    for j in 1..=n {
        let (t_prev, _) = window[start + j - 1];
        let (t_cur, d_cur) = window[start + j];
        let mut st = t_cur as i128 - t_prev as i128;
        if st < 1 {
            st = 1;
        }
        if st > 6 * t {
            st = 6 * t;
        }
        weighted += (j as i128) * st;
        sum_d += d_cur;
    }
    let k = (n as i128 * (n as i128 + 1)) / 2;
    let floor = (k * t) / 8;
    if weighted < floor {
        weighted = floor;
    }

    let numer: u128 = sum_d * (k as u128) * (t as u128);
    let denom: u128 = (n as u128) * (weighted as u128);
    let mut next_d = numer / denom;

    let prev_d = window[window.len() - 1].1;
    let up = prev_d.saturating_mul(4);
    let down = (prev_d / 4).max(1);
    if next_d > up {
        next_d = up;
    }
    if next_d < down {
        next_d = down;
    }
    if next_d < min_difficulty {
        next_d = min_difficulty;
    }

    bits_from_target(&target_from_difficulty(next_d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_target_roundtrip() {
        let bits = GENESIS_BITS;
        assert_eq!(bits_from_target(&target_from_bits(bits)), bits);
    }

    #[test]
    fn genesis_difficulty_matches_bits() {
        // El objetivo derivado de la dificultad de génesis codifica a GENESIS_BITS.
        let t = target_from_difficulty(GENESIS_DIFFICULTY);
        assert_eq!(bits_from_target(&t), GENESIS_BITS);
    }

    #[test]
    fn meets_target_boundary_is_inclusive() {
        let target = target_from_bits(GENESIS_BITS);
        assert!(meets_target(&target, GENESIS_BITS)); // hash == target pasa
        let mut over = target;
        // incrementa en 1 -> supera el objetivo -> falla
        for k in (0..32).rev() {
            if over[k] != 0xFF {
                over[k] += 1;
                break;
            }
            over[k] = 0;
        }
        assert!(!meets_target(&over, GENESIS_BITS));
    }

    #[test]
    fn difficulty_from_genesis_bits_is_about_60m() {
        let d = difficulty_from_bits(GENESIS_BITS);
        // ~6.0e7 (calibración: 1 CPU a 1e6 H/s durante 60 s).
        assert!(d >= 59_900_000 && d <= 60_100_000, "d={d}");
    }

    #[test]
    fn lwma_returns_genesis_before_window_fills() {
        let short = [(0u64, GENESIS_DIFFICULTY); 10];
        assert_eq!(lwma_next_bits(&short, GENESIS_DIFFICULTY), GENESIS_BITS);
    }

    #[test]
    fn lwma_raises_difficulty_when_blocks_too_fast() {
        // Bloques a 6 s (10x más rápido que el objetivo 60 s) -> sube dificultad.
        let mut window = Vec::new();
        for i in 0..=(LWMA_N as u64) {
            window.push((i * 6, GENESIS_DIFFICULTY));
        }
        let next = lwma_next_bits(&window, GENESIS_DIFFICULTY);
        let next_target = target_from_bits(next);
        let genesis_target = target_from_bits(GENESIS_BITS);
        // objetivo menor == más difícil == bytes lexicográficamente menores
        assert!(next_target < genesis_target);
    }
}
