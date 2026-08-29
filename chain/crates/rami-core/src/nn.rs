//! rami-core::nn — MLP entero bit-exacto para puntuar la INVARIANZA DE RAMA (UBR).
//! SOLO ASESOR. Nunca decide la validez de un bloque/tx, el objetivo de PoW ni la
//! elección de rama. Aritmética entera pura (i64, desplazamiento aritmético,
//! redondeo add-half) => bits idénticos en toda plataforma. Sin floats, sin deps.
//! Los pesos viajan como arrays `const` fijados por el hash del génesis.

pub const QBITS: u32 = 16;
pub const QONE: i64 = 1 << QBITS;
pub const IN: usize = 12;
pub const H1: usize = 16;
pub const H2: usize = 8;

/// Cuantiza una razón entera a/b (b > 0) a Q16, acotada a [0, QONE].
#[inline]
pub fn ratio_q16(a: u64, b: u64) -> i64 {
    if b == 0 {
        return 0;
    }
    (((a as u128) << QBITS) / (b as u128)).min(QONE as u128) as i64
}

#[inline]
fn relu_q16(x: i64) -> i64 {
    if x < 0 {
        0
    } else {
        x
    }
}

#[inline]
fn hard_sigmoid_q16(x: i64) -> i64 {
    const THREE: i64 = 3 * QONE;
    const INV6: i64 = 10923; // round(65536/6)
    let y = ((x + THREE) * INV6) >> QBITS;
    y.clamp(0, QONE)
}

fn fc_q16(input: &[i64], w: &[&[i64]], b: &[i64], relu: bool, out: &mut [i64]) {
    for (o, oref) in out.iter_mut().enumerate() {
        let mut acc: i64 = b[o] << QBITS;
        for i in 0..input.len() {
            acc += w[o][i] * input[i];
        }
        let v = (acc + (1 << (QBITS - 1))) >> QBITS;
        *oref = if relu { relu_q16(v) } else { v };
    }
}

pub struct RamiNet {
    pub w1: [[i64; IN]; H1],
    pub b1: [i64; H1],
    pub w2: [[i64; H1]; H2],
    pub b2: [i64; H2],
    pub w3: [i64; H2],
    pub b3: i64,
}

impl RamiNet {
    /// Vector de rasgos Q16 -> puntuación de invarianza de rama Q16 en [0,1].
    pub fn forward(&self, feats: &[i64; IN]) -> i64 {
        let w1: Vec<&[i64]> = self.w1.iter().map(|r| r.as_slice()).collect();
        let mut a1 = [0i64; H1];
        fc_q16(feats, &w1, &self.b1, true, &mut a1);

        let w2: Vec<&[i64]> = self.w2.iter().map(|r| r.as_slice()).collect();
        let mut a2 = [0i64; H2];
        fc_q16(&a1, &w2, &self.b2, true, &mut a2);

        let mut acc: i64 = self.b3 << QBITS;
        for i in 0..H2 {
            acc += self.w3[i] * a2[i];
        }
        let logit = (acc + (1 << (QBITS - 1))) >> QBITS;
        hard_sigmoid_q16(logit)
    }

    /// Red neutra (identidad-cero): útil como base y para tests. Una versión
    /// entrenada se fija por hash en el génesis.
    pub fn zero() -> Self {
        RamiNet {
            w1: [[0; IN]; H1],
            b1: [0; H1],
            w2: [[0; H1]; H2],
            b2: [0; H2],
            w3: [0; H2],
            b3: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_is_bounded_and_deterministic() {
        let net = RamiNet::zero();
        let feats = [QONE / 2; IN];
        let a = net.forward(&feats);
        let b = net.forward(&feats);
        assert_eq!(a, b); // bit-exacto reproducible
        assert!(a >= 0 && a <= QONE); // rango de hard-sigmoid
        // hard_sigmoid(0) ≈ 0.5, con un pequeño error de punto fijo por INV6
        // redondeado (65536/6 = 10922.67 -> 10923). El invariante es rango +
        // determinismo, no la igualdad exacta.
        assert!((a - QONE / 2).abs() <= 8);
    }

    #[test]
    fn ratio_q16_clamps() {
        assert_eq!(ratio_q16(0, 4096), 0);
        assert_eq!(ratio_q16(1, 2), QONE / 2);
        assert_eq!(ratio_q16(9, 4), QONE); // >1 se acota a 1
    }
}
