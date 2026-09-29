//! SHARAMI — cifrado «de dos cúbits» de RAMI-Chain (v1).
//!
//! La idea que lo motiva (ver `docs/SHARAMI.md`): un mensaje no viaja como un
//! solo bloque cifrado sino como DOS celdas que coexisten a la vez en espacios
//! distintos —dos pares, dos rutas, dos lotes— y que, por separado, son ruido
//! puro. Cada celda lleva una mitad de un secreto compartido (una máscara
//! aleatoria y el mensaje enmascarado con ella), como los dos cúbits de un par
//! entrelazado, que solo dicen algo cuando se leen juntos. Las celdas de muchos
//! remitentes se mezclan en un mismo lote de celdas del MISMO tamaño (estilo
//! CoinJoin): un observador no sabe qué dos celdas forman pareja ni para quién
//! son; solo el destinatario, probando a abrir cada celda con su clave,
//! reconoce las suyas y las junta.
//!
//! Primitivas, todas de RustCrypto/dalek y ya presentes en el Túnel RAMI (nunca
//! criptografía casera):
//! - X25519 con clave EFÍMERA por celda (cada celda tiene su propio secreto
//!   hacia delante: una clave efímera comprometida abre una mitad, que sola
//!   no dice nada);
//! - HKDF-SHA256 (RFC 5869) para derivar la clave y el nonce de cada celda;
//! - ChaCha20-Poly1305 con la cabecera como dato asociado;
//! - Ed25519 para el sobre firmado (el destinatario sabe quién escribe; nadie
//!   más lo sabe).
//!
//! La clave del destinatario es su identidad Ed25519 de nodo (o cualquier clave
//! Ed25519 de cuenta): se convierte a X25519 por el mapa birracional estándar
//! (la misma conversión que hace libsodium en
//! `crypto_sign_ed25519_pk_to_curve25519`), así que nadie necesita una clave
//! nueva para recibir.
//!
//! **Cabecera** de una celda (34 bytes, en claro, autenticada como AAD):
//! `ver(1) || kem(1) || eph(32)`. `kem = 1`: X25519. El byte `kem` reserva el
//! sitio del modo híbrido post-cuántico (`kem = 2`: X25519 + ML-KEM-768, con el
//! secreto compartido de los dos concatenado como IKM del HKDF), que entra en
//! cuanto la dependencia esté en `Cargo.lock`; una celda con un `kem` que no se
//! entiende se rechaza antes de tocar la curva.
//!
//! **Cuerpo** de una celda (en claro antes de cifrar, siempre `BODY_LEN`
//! bytes): `pair(16) || idx(1) || len(2 BE) || share(SHARE_LEN)`. La celda 0
//! lleva en `share` la máscara aleatoria `R`; la celda 1 lleva `M' XOR R`, con
//! `M'` el mensaje rellenado con ceros hasta `SHARE_LEN`. `pair` es un
//! identificador aleatorio que solo se ve tras descifrar: es lo único que une
//! las dos mitades, y solo lo ve quien puede abrirlas.
//!
//! **Derivación** por celda:
//! `ss = X25519(eph_secreto, X_destinatario)` (todo-ceros ⇒ rechazo);
//! `prk = HKDF-Extract(salt = "SHARAMI-v1", ikm = ss)`;
//! `okm = HKDF-Expand(prk, "sharami cell" || cabecera || X_destinatario, 44)`;
//! `clave = okm[0..32]`, `nonce = okm[32..44]`. La clave efímera es nueva en
//! cada celda, así que el nonce nunca se repite bajo una misma clave.
//!
//! Lo que SHARAMI no hace (dicho claro): no oculta que alguien envía celdas,
//! solo qué dicen, a quién van y cuáles van juntas; no protege contra un
//! destinatario que reenvíe lo que leyó; y en v1 no resiste todavía un
//! ordenador cuántico (para eso está reservado `kem = 2`).

use std::collections::HashMap;
use std::fmt;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use curve25519_dalek::edwards::CompressedEdwardsY;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha512};

use crate::secure::{hkdf_expand, hkdf_extract, x25519_public, x25519_shared};

/// Versión del formato de celda.
pub const VERSION: u8 = 1;
/// Acuerdo de claves X25519 (el único de v1).
pub const KEM_X25519: u8 = 1;
/// Reservado: X25519 + ML-KEM-768 (híbrido post-cuántico). Hoy se rechaza.
pub const KEM_HYBRID_MLKEM768: u8 = 2;
/// Bytes de cada mitad. Todas las celdas de la red tienen el mismo tamaño:
/// es lo que hace posible mezclarlas sin que el tamaño delate nada.
pub const SHARE_LEN: usize = 512;
/// Bytes del identificador de pareja (aleatorio, solo visible tras descifrar).
pub const PAIR_LEN: usize = 16;
/// `ver(1) || kem(1) || eph(32)`.
pub const HEADER_LEN: usize = 34;
/// `pair || idx || len || share`.
pub const BODY_LEN: usize = PAIR_LEN + 1 + 2 + SHARE_LEN;
/// Etiqueta Poly1305.
pub const TAG_LEN: usize = 16;
/// Tamaño fijo de una celda en el cable.
pub const CELL_LEN: usize = HEADER_LEN + BODY_LEN + TAG_LEN;
/// Bytes del sobre firmado: `from(32) || sig(64)`.
pub const ENVELOPE_LEN: usize = 32 + 64;
/// Texto máximo de un mensaje con sobre firmado.
pub const MAX_TEXT: usize = SHARE_LEN - ENVELOPE_LEN;

const SALT: &[u8] = b"SHARAMI-v1";
const INFO: &[u8] = b"sharami cell";
/// Etiqueta de dominio de la firma del sobre: nunca se confunde con una
/// transacción, un saludo P2P ni una firma de release.
const ENVELOPE_DS: &[u8] = b"SHARAMI-v1/sobre";

/// Por qué no se pudo sellar o abrir.
#[derive(Debug, PartialEq, Eq)]
pub enum SharamiError {
    /// El mensaje no cabe en una pareja de celdas.
    TooLong(usize),
    /// La clave pública Ed25519 del destinatario no es un punto válido (o es
    /// de orden pequeño).
    BadRecipient,
    /// Secreto compartido degenerado (todo ceros).
    Degenerate,
    /// El AEAD no pudo cifrar (no ocurre con entradas bien formadas).
    Cipher,
    /// Las dos mitades no son pareja (identificador, índice o longitud).
    Incomplete,
    /// Sobre malformado o firma del remitente inválida.
    BadEnvelope,
}

impl fmt::Display for SharamiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SharamiError::TooLong(n) => write!(f, "mensaje de {n} bytes: no cabe en una pareja de celdas"),
            SharamiError::BadRecipient => write!(f, "clave pública del destinatario inválida"),
            SharamiError::Degenerate => write!(f, "secreto compartido degenerado"),
            SharamiError::Cipher => write!(f, "fallo al cifrar la celda"),
            SharamiError::Incomplete => write!(f, "las dos mitades no son pareja"),
            SharamiError::BadEnvelope => write!(f, "sobre malformado o firma inválida"),
        }
    }
}

/// Una celda SHARAMI: media información, en un espacio.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    /// Acuerdo de claves usado (`KEM_X25519`).
    pub kem: u8,
    /// Clave pública X25519 efímera de esta celda.
    pub eph: [u8; 32],
    /// Cuerpo cifrado y autenticado (`BODY_LEN + TAG_LEN` bytes).
    pub ct: Vec<u8>,
}

impl Cell {
    /// Bytes de cable (`CELL_LEN`, siempre los mismos).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(CELL_LEN);
        v.push(VERSION);
        v.push(self.kem);
        v.extend_from_slice(&self.eph);
        v.extend_from_slice(&self.ct);
        v
    }

    /// Lee una celda de sus bytes. Tamaño, versión y `kem` se comprueban
    /// aquí, antes de cualquier operación de curva.
    pub fn from_bytes(b: &[u8]) -> Option<Cell> {
        if b.len() != CELL_LEN || b[0] != VERSION || b[1] != KEM_X25519 {
            return None;
        }
        let mut eph = [0u8; 32];
        eph.copy_from_slice(&b[2..HEADER_LEN]);
        Some(Cell { kem: b[1], eph, ct: b[HEADER_LEN..].to_vec() })
    }

    /// Cabecera en claro (lo que autentica el AEAD como AAD).
    fn header(&self) -> [u8; HEADER_LEN] {
        let mut h = [0u8; HEADER_LEN];
        h[0] = VERSION;
        h[1] = self.kem;
        h[2..].copy_from_slice(&self.eph);
        h
    }
}

/// Una mitad ya descifrada.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Half {
    pub pair: [u8; PAIR_LEN],
    pub idx: u8,
    pub len: u16,
    pub share: [u8; SHARE_LEN],
}

/// Un mensaje reconstruido a partir de sus dos mitades.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub pair: [u8; PAIR_LEN],
    pub plaintext: Vec<u8>,
}

/// Un sobre firmado ya verificado: quién escribió y qué.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signed {
    pub from: [u8; 32],
    pub text: Vec<u8>,
}

// ------------------------------------------------------------------ claves

/// Clave X25519 de un destinatario a partir de su clave pública Ed25519 (la
/// identidad de nodo o una cuenta). Rechaza lo que no decodifica como punto de
/// la curva y los puntos de orden pequeño.
pub fn recipient_key(ed_pub: &[u8; 32]) -> Result<[u8; 32], SharamiError> {
    let p = CompressedEdwardsY(*ed_pub).decompress().ok_or(SharamiError::BadRecipient)?;
    if p.is_small_order() {
        return Err(SharamiError::BadRecipient);
    }
    Ok(p.to_montgomery().0)
}

/// Secreto X25519 de un destinatario a partir de su semilla Ed25519 (32
/// bytes): la mitad baja de SHA-512(semilla), que X25519 recorta («clamping»)
/// exactamente igual que Ed25519 al firmar. Por eso
/// `x25519_public(&secret_key(seed)) == recipient_key(&pubkey_ed25519(seed))`
/// (lo fija un test).
pub fn secret_key(seed: &[u8; 32]) -> [u8; 32] {
    let h = Sha512::digest(seed);
    let mut s = [0u8; 32];
    s.copy_from_slice(&h[..32]);
    s
}

fn derive(ss: &[u8; 32], header: &[u8; HEADER_LEN], recipient_x: &[u8; 32]) -> ([u8; 32], [u8; 12]) {
    let prk = hkdf_extract(SALT, ss);
    let mut info = INFO.to_vec();
    info.extend_from_slice(header);
    info.extend_from_slice(recipient_x);
    let okm = hkdf_expand(&prk, &info, 44);
    let mut key = [0u8; 32];
    key.copy_from_slice(&okm[..32]);
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&okm[32..44]);
    (key, nonce)
}

// ------------------------------------------------------------------ sellar

/// Sella `msg` (≤ `SHARE_LEN` bytes) para el destinatario `recipient_x`
/// (clave X25519, ver `recipient_key`) en DOS celdas. Cada una sola es ruido
/// uniforme; juntas, y solo con la clave del destinatario, devuelven `msg`.
/// El orden en que se devuelven no importa: cada celda sabe qué mitad es.
pub fn seal(recipient_x: &[u8; 32], msg: &[u8]) -> Result<[Cell; 2], SharamiError> {
    let mut pair = [0u8; PAIR_LEN];
    OsRng.fill_bytes(&mut pair);
    seal_with_pair(recipient_x, msg, pair)
}

fn seal_with_pair(recipient_x: &[u8; 32], msg: &[u8], pair: [u8; PAIR_LEN]) -> Result<[Cell; 2], SharamiError> {
    if msg.len() > SHARE_LEN {
        return Err(SharamiError::TooLong(msg.len()));
    }
    // Máscara aleatoria R y mensaje enmascarado M' XOR R (M' = msg || ceros).
    let mut mask = [0u8; SHARE_LEN];
    OsRng.fill_bytes(&mut mask);
    let mut masked = mask;
    for (m, b) in masked.iter_mut().zip(msg.iter()) {
        *m ^= *b;
    }
    let len = msg.len() as u16;
    let c0 = seal_cell(recipient_x, &pair, 0, len, &mask)?;
    let c1 = seal_cell(recipient_x, &pair, 1, len, &masked)?;
    Ok([c0, c1])
}

fn seal_cell(
    recipient_x: &[u8; 32],
    pair: &[u8; PAIR_LEN],
    idx: u8,
    len: u16,
    share: &[u8; SHARE_LEN],
) -> Result<Cell, SharamiError> {
    let mut eph_secret = [0u8; 32];
    OsRng.fill_bytes(&mut eph_secret);
    let eph = x25519_public(&eph_secret);
    let ss = x25519_shared(&eph_secret, recipient_x).ok_or(SharamiError::Degenerate)?;
    let mut cell = Cell { kem: KEM_X25519, eph, ct: Vec::new() };
    let header = cell.header();
    let (key, nonce) = derive(&ss, &header, recipient_x);
    let mut body = Vec::with_capacity(BODY_LEN);
    body.extend_from_slice(pair);
    body.push(idx);
    body.extend_from_slice(&len.to_be_bytes());
    body.extend_from_slice(share);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    cell.ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &body, aad: &header })
        .map_err(|_| SharamiError::Cipher)?;
    Ok(cell)
}

// ------------------------------------------------------------------- abrir

/// Intenta abrir UNA celda con el secreto `secret_x` (ver `secret_key`).
/// `None` si no es para este destinatario, está manipulada o no se entiende.
pub fn open_cell(secret_x: &[u8; 32], cell: &Cell) -> Option<Half> {
    open_cell_with(secret_x, &x25519_public(secret_x), cell)
}

fn open_cell_with(secret_x: &[u8; 32], recipient_x: &[u8; 32], cell: &Cell) -> Option<Half> {
    if cell.kem != KEM_X25519 || cell.ct.len() != BODY_LEN + TAG_LEN {
        return None;
    }
    let ss = x25519_shared(secret_x, &cell.eph)?;
    let header = cell.header();
    let (key, nonce) = derive(&ss, &header, recipient_x);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let body = cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: &cell.ct, aad: &header }).ok()?;
    if body.len() != BODY_LEN {
        return None;
    }
    let mut pair = [0u8; PAIR_LEN];
    pair.copy_from_slice(&body[..PAIR_LEN]);
    let idx = body[PAIR_LEN];
    let len = u16::from_be_bytes([body[PAIR_LEN + 1], body[PAIR_LEN + 2]]);
    if idx > 1 || len as usize > SHARE_LEN {
        return None;
    }
    let mut share = [0u8; SHARE_LEN];
    share.copy_from_slice(&body[PAIR_LEN + 3..]);
    Some(Half { pair, idx, len, share })
}

/// Junta dos mitades de la misma pareja y devuelve el mensaje.
pub fn join(a: &Half, b: &Half) -> Result<Message, SharamiError> {
    if a.pair != b.pair || a.idx == b.idx || a.len != b.len {
        return Err(SharamiError::Incomplete);
    }
    let n = a.len as usize;
    let plaintext: Vec<u8> = a.share[..n].iter().zip(b.share[..n].iter()).map(|(x, y)| x ^ y).collect();
    Ok(Message { pair: a.pair, plaintext })
}

/// Abre TODAS las celdas de un lote que sean para este secreto y devuelve los
/// mensajes completos (las parejas encontradas), en el orden en que se
/// completan. Las celdas de otros destinatarios no autentican y se saltan en
/// silencio; una mitad sin pareja se descarta; una mitad repetida no hace
/// perder a la de verdad.
pub fn open_batch(secret_x: &[u8; 32], cells: &[Cell]) -> Vec<Message> {
    let recipient_x = x25519_public(secret_x);
    let mut pending: HashMap<[u8; PAIR_LEN], Half> = HashMap::new();
    let mut out = Vec::new();
    for c in cells {
        let Some(h) = open_cell_with(secret_x, &recipient_x, c) else {
            continue;
        };
        let joined = pending.get(&h.pair).and_then(|other| join(other, &h).ok());
        match joined {
            Some(m) => {
                pending.remove(&h.pair);
                out.push(m);
            }
            None => {
                pending.entry(h.pair).or_insert(h);
            }
        }
    }
    out
}

// ------------------------------------------------------------------ mezcla

/// Mezcla un lote de celdas (Fisher–Yates con el RNG del sistema): tras la
/// mezcla, la posición de una celda no dice nada de su pareja ni de su origen.
/// Es la parte «CoinJoin»: las celdas de todos, del mismo tamaño, en un solo
/// lote sin orden.
pub fn shuffle(cells: &mut [Cell]) {
    let n = cells.len();
    for i in (1..n).rev() {
        // j uniforme en 0..=i; el sesgo del módulo sobre 64 bits es < 2^-50.
        let j = (OsRng.next_u64() % (i as u64 + 1)) as usize;
        cells.swap(i, j);
    }
}

// ------------------------------------------------------------ sobre firmado

/// Lo que firma el remitente: `"SHARAMI-v1/sobre" || destinatario_x || pair || texto`.
/// Liga el texto a este destinatario y a esta pareja de celdas: un sobre no
/// sirve para otro destinatario ni se puede reutilizar en otra pareja.
pub fn envelope_message(recipient_x: &[u8; 32], pair: &[u8; PAIR_LEN], text: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(ENVELOPE_DS.len() + 32 + PAIR_LEN + text.len());
    m.extend_from_slice(ENVELOPE_DS);
    m.extend_from_slice(recipient_x);
    m.extend_from_slice(pair);
    m.extend_from_slice(text);
    m
}

/// Sella un texto (≤ `MAX_TEXT` bytes) dentro de un sobre firmado por `from`
/// (clave pública Ed25519 del remitente; `sign` firma con su clave privada,
/// p. ej. `NodeIdentity::sign`). Solo el destinatario ve el sobre: quién
/// escribe queda dentro del cifrado.
pub fn seal_signed(
    recipient_x: &[u8; 32],
    text: &[u8],
    from: &[u8; 32],
    sign: impl Fn(&[u8]) -> [u8; 64],
) -> Result<[Cell; 2], SharamiError> {
    if text.len() > MAX_TEXT {
        return Err(SharamiError::TooLong(text.len()));
    }
    let mut pair = [0u8; PAIR_LEN];
    OsRng.fill_bytes(&mut pair);
    let sig = sign(&envelope_message(recipient_x, &pair, text));
    let mut env = Vec::with_capacity(ENVELOPE_LEN + text.len());
    env.extend_from_slice(from);
    env.extend_from_slice(&sig);
    env.extend_from_slice(text);
    seal_with_pair(recipient_x, &env, pair)
}

/// Verifica el sobre de un mensaje reconstruido (`open_batch`) y devuelve
/// quién lo firmó y el texto. Sin firma válida no se devuelve nada.
pub fn open_signed(recipient_x: &[u8; 32], m: &Message) -> Result<Signed, SharamiError> {
    if m.plaintext.len() < ENVELOPE_LEN {
        return Err(SharamiError::BadEnvelope);
    }
    let mut from = [0u8; 32];
    from.copy_from_slice(&m.plaintext[..32]);
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&m.plaintext[32..ENVELOPE_LEN]);
    let text = m.plaintext[ENVELOPE_LEN..].to_vec();
    if !rami_core::crypto::verify(&from, &envelope_message(recipient_x, &m.pair, &text), &sig) {
        return Err(SharamiError::BadEnvelope);
    }
    Ok(Signed { from, text })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::NodeIdentity;

    /// Destinatario de prueba: identidad Ed25519 (sin prueba de trabajo, que
    /// aquí no hace falta) y sus dos claves SHARAMI.
    fn recipient(seed: u8) -> (NodeIdentity, [u8; 32], [u8; 32]) {
        let id = NodeIdentity::from_seed([seed; 32], 0);
        let x_pub = recipient_key(&id.pubkey).expect("clave válida");
        let x_sec = secret_key(&id.seed());
        (id, x_pub, x_sec)
    }

    #[test]
    fn claves_ed25519_y_x25519_coinciden() {
        // La conversión pública (Edwards → Montgomery) y la privada (SHA-512 de
        // la semilla) llegan al MISMO par X25519: recibir no exige clave nueva.
        for s in 1..=5u8 {
            let (_, x_pub, x_sec) = recipient(s);
            assert_eq!(x25519_public(&x_sec), x_pub);
        }
        // Punto de orden pequeño (la identidad del grupo, y = 1): rechazado.
        let mut identidad = [0u8; 32];
        identidad[0] = 1;
        assert_eq!(recipient_key(&identidad), Err(SharamiError::BadRecipient));
    }

    #[test]
    fn ida_y_vuelta_dos_celdas() {
        let (_, x_pub, x_sec) = recipient(1);
        for msg in [Vec::new(), "hola Dubái".as_bytes().to_vec(), vec![0x5au8; SHARE_LEN]] {
            let cells = seal(&x_pub, &msg).unwrap();
            assert_eq!(cells[0].to_bytes().len(), CELL_LEN);
            assert_eq!(cells[1].to_bytes().len(), CELL_LEN);
            let got = open_batch(&x_sec, &cells);
            assert_eq!(got.len(), 1);
            assert_eq!(got[0].plaintext, msg);
            // El orden de las celdas no importa.
            let got = open_batch(&x_sec, &[cells[1].clone(), cells[0].clone()]);
            assert_eq!(got[0].plaintext, msg);
        }
        assert_eq!(seal(&x_pub, &vec![0u8; SHARE_LEN + 1]), Err(SharamiError::TooLong(SHARE_LEN + 1)));
    }

    #[test]
    fn una_celda_sola_no_dice_nada() {
        let (_, x_pub, x_sec) = recipient(2);
        let msg = b"el mensaje que nadie debe ver a medias".to_vec();
        let a = seal(&x_pub, &msg).unwrap();
        let b = seal(&x_pub, &msg).unwrap();
        // Dos sellados del mismo texto: claves efímeras, cifrados y mitades
        // distintas (máscara nueva cada vez).
        assert_ne!(a[0].eph, b[0].eph);
        assert_ne!(a[0].ct, b[0].ct);
        assert_ne!(a[1].ct, b[1].ct);
        let ha = open_cell(&x_sec, &a[0]).unwrap();
        let hb = open_cell(&x_sec, &b[0]).unwrap();
        assert_ne!(ha.share, hb.share);
        // Ninguna mitad contiene el mensaje en claro.
        let ha1 = open_cell(&x_sec, &a[1]).unwrap();
        assert_ne!(&ha.share[..msg.len()], &msg[..]);
        assert_ne!(&ha1.share[..msg.len()], &msg[..]);
        // Una sola mitad no es un mensaje.
        assert!(open_batch(&x_sec, &a[..1]).is_empty());
        assert_eq!(join(&ha, &ha), Err(SharamiError::Incomplete));
        assert_eq!(join(&ha, &hb), Err(SharamiError::Incomplete));
        // Y las dos de la misma pareja, sí.
        assert_eq!(join(&ha, &ha1).unwrap().plaintext, msg);
    }

    #[test]
    fn otro_destinatario_no_abre_nada() {
        let (_, x_pub, _) = recipient(3);
        let (_, _, otro_sec) = recipient(4);
        let cells = seal(&x_pub, b"solo para 3").unwrap();
        assert!(open_cell(&otro_sec, &cells[0]).is_none());
        assert!(open_cell(&otro_sec, &cells[1]).is_none());
        assert!(open_batch(&otro_sec, &cells).is_empty());
    }

    #[test]
    fn celda_manipulada_no_autentica() {
        let (_, x_pub, x_sec) = recipient(5);
        let cells = seal(&x_pub, b"intacto").unwrap();
        let mut c = cells[0].clone();
        c.ct[7] ^= 0x01;
        assert!(open_cell(&x_sec, &c).is_none());
        let mut c = cells[0].clone();
        c.eph[0] ^= 0x01;
        assert!(open_cell(&x_sec, &c).is_none());
        let mut c = cells[0].clone();
        c.kem = KEM_HYBRID_MLKEM768;
        assert!(open_cell(&x_sec, &c).is_none());
        // Bytes: tamaño, versión y kem se comprueban antes de tocar la curva.
        let b = cells[1].to_bytes();
        assert_eq!(Cell::from_bytes(&b), Some(cells[1].clone()));
        assert!(Cell::from_bytes(&b[..CELL_LEN - 1]).is_none());
        let mut v = b.clone();
        v[0] = 2;
        assert!(Cell::from_bytes(&v).is_none());
        let mut v = b.clone();
        v[1] = KEM_HYBRID_MLKEM768;
        assert!(Cell::from_bytes(&v).is_none());
    }

    #[test]
    fn mezcla_conserva_los_mensajes_de_cada_uno() {
        // Cinco destinatarios, tres mensajes cada uno, todo en un lote mezclado.
        let rx: Vec<_> = (10..15u8).map(recipient).collect();
        let mut lote: Vec<Cell> = Vec::new();
        let mut esperado: Vec<Vec<Vec<u8>>> = Vec::new();
        for (i, (_, x_pub, _)) in rx.iter().enumerate() {
            let mut mios = Vec::new();
            for k in 0..3u8 {
                let msg = format!("para {i} numero {k}").into_bytes();
                let cells = seal(x_pub, &msg).unwrap();
                lote.extend_from_slice(&cells);
                mios.push(msg);
            }
            esperado.push(mios);
        }
        assert_eq!(lote.len(), 30);
        let antes = lote.clone();
        shuffle(&mut lote);
        assert_ne!(lote, antes, "30 celdas mezcladas no quedan en el mismo orden");
        for (i, (_, _, x_sec)) in rx.iter().enumerate() {
            let mut got: Vec<Vec<u8>> = open_batch(x_sec, &lote).into_iter().map(|m| m.plaintext).collect();
            got.sort();
            let mut want = esperado[i].clone();
            want.sort();
            assert_eq!(got, want, "el destinatario {i} recupera exactamente lo suyo");
        }
    }

    #[test]
    fn mitad_repetida_no_pierde_la_pareja() {
        let (_, x_pub, x_sec) = recipient(6);
        let cells = seal(&x_pub, b"dos veces la misma mitad").unwrap();
        let lote = vec![cells[0].clone(), cells[0].clone(), cells[1].clone(), cells[1].clone()];
        let got = open_batch(&x_sec, &lote);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].plaintext, b"dos veces la misma mitad".to_vec());
    }

    #[test]
    fn sobre_firmado_dice_quien_escribe_y_rechaza_al_impostor() {
        let (rx_id, x_pub, x_sec) = recipient(7);
        let remitente = NodeIdentity::from_seed([8u8; 32], 0);
        let cells = seal_signed(&x_pub, b"firmado por 8", &remitente.pubkey, |m| remitente.sign(m)).unwrap();
        let msgs = open_batch(&x_sec, &cells);
        assert_eq!(msgs.len(), 1);
        let s = open_signed(&x_pub, &msgs[0]).unwrap();
        assert_eq!(s.from, remitente.pubkey);
        assert_eq!(s.text, b"firmado por 8".to_vec());
        // Un impostor que firma con otra clave pero declara la de 8.
        let impostor = NodeIdentity::from_seed([9u8; 32], 0);
        let cells = seal_signed(&x_pub, b"soy 8, de verdad", &remitente.pubkey, |m| impostor.sign(m)).unwrap();
        let msgs = open_batch(&x_sec, &cells);
        assert_eq!(open_signed(&x_pub, &msgs[0]), Err(SharamiError::BadEnvelope));
        // El sobre está ligado al destinatario: con otra clave no verifica.
        let (_, otra_pub, _) = recipient(3);
        let cells = seal_signed(&x_pub, b"para 7", &remitente.pubkey, |m| remitente.sign(m)).unwrap();
        let msgs = open_batch(&x_sec, &cells);
        assert_eq!(open_signed(&otra_pub, &msgs[0]), Err(SharamiError::BadEnvelope));
        // Un mensaje sin sobre no pasa por firmado.
        let cells = seal(&x_pub, b"corto").unwrap();
        let msgs = open_batch(&x_sec, &cells);
        assert_eq!(open_signed(&x_pub, &msgs[0]), Err(SharamiError::BadEnvelope));
        // Texto máximo con sobre, y uno más se rechaza.
        assert!(seal_signed(&x_pub, &vec![1u8; MAX_TEXT], &remitente.pubkey, |m| remitente.sign(m)).is_ok());
        assert_eq!(
            seal_signed(&x_pub, &vec![1u8; MAX_TEXT + 1], &remitente.pubkey, |m| remitente.sign(m)),
            Err(SharamiError::TooLong(MAX_TEXT + 1))
        );
        let _ = rx_id;
    }

    #[test]
    fn derivacion_determinista_y_ligada_a_la_cabecera() {
        let ss = [0x42u8; 32];
        let cell = Cell { kem: KEM_X25519, eph: [0x11u8; 32], ct: vec![] };
        let (k1, n1) = derive(&ss, &cell.header(), &[0x22u8; 32]);
        let (k2, n2) = derive(&ss, &cell.header(), &[0x22u8; 32]);
        assert_eq!((k1, n1), (k2, n2));
        // Otro destinatario u otra clave efímera cambian clave y nonce.
        let (k3, _) = derive(&ss, &cell.header(), &[0x23u8; 32]);
        assert_ne!(k1, k3);
        let otra = Cell { kem: KEM_X25519, eph: [0x12u8; 32], ct: vec![] };
        let (k4, n4) = derive(&ss, &otra.header(), &[0x22u8; 32]);
        assert_ne!(k1, k4);
        assert_ne!(n1, n4);
        assert_eq!(BODY_LEN, 531);
        assert_eq!(CELL_LEN, 581);
        assert_eq!(MAX_TEXT, 416);
    }
}
