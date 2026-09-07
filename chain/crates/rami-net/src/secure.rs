//! Túnel RAMI: handshake autenticado de tres mensajes y cifrado de cada frame.
//!
//! Reutiliza las primitivas de la propia cadena — nada de criptografía casera:
//! - identidad Ed25519 con prueba de trabajo SHA-256d (`identity.rs`);
//! - acuerdo de claves X25519 con claves EFÍMERAS por conexión (secreto
//!   perfecto hacia delante: una clave de nodo robada no descifra sesiones
//!   pasadas);
//! - HKDF-SHA256 (RFC 5869) para derivar una clave por sentido;
//! - ChaCha20-Poly1305 para cada frame, con contador implícito como nonce.
//!
//! **Handshake** (`net` = network-id, hash del génesis):
//! 1. iniciador → respondedor, en claro, una línea JSON:
//!    `{"RamiHello1":{net,ver,pub,pow_nonce,eph,nonce,port}}`
//! 2. respondedor → iniciador, en claro: `{"RamiHello2":{…mismos campos…,sig}}`
//!    con `sig` = Ed25519 del respondedor sobre la transcripción `T`.
//! 3. iniciador → respondedor, CIFRADO con la clave iniciador→respondedor
//!    (contador n = 0): `{"RamiHello3":{sig}}`, firma del iniciador sobre `T`.
//!
//! Transcripción (203 bytes, disposición fija):
//! `T = "RAMI-P2P-v2" || net(32) || init.pub(32) || init.eph(32) || init.nonce(16)
//!      || resp.pub(32) || resp.eph(32) || resp.nonce(16)`
//!
//! Claves de sesión: `shared = X25519(eph_propio, eph_ajeno)` (se rechaza el
//! todo-ceros); `prk = HKDF-Extract(salt = net, ikm = shared)`;
//! `k_i2r = HKDF-Expand(prk, "rami i2r" || T, 32)`; `k_r2i` igual con `"rami r2i"`.
//!
//! Framing tras el handshake, por sentido con contador `n` de 64 bits desde 0:
//! `len (u32 BE, longitud del cifrado, ≤ 16 MiB) || ChaCha20-Poly1305(k_dir,
//! nonce = 4 ceros || n LE, aad = vacío, texto = línea JSON del Frame sin '\n')`.
//! El contador nunca viaja: un frame repetido, reordenado o manipulado no
//! autentica y cierra la conexión.

use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use curve25519_dalek::montgomery::MontgomeryPoint;
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::identity::{fingerprint, identity_pow_ok, node_id, NodeIdentity};
use crate::protocol::{Frame, PROTO_VERSION};

/// Tamaño máximo del cifrado de un frame (16 MiB). Se comprueba ANTES de
/// reservar memoria: un par roto o malicioso no puede hacernos reservar más.
pub const MAX_FRAME: u32 = 16 * 1024 * 1024;
/// Longitud máxima de las líneas del handshake (mensajes 1 y 2).
pub const MAX_HELLO_LINE: u64 = 4096;
/// Etiqueta de dominio de la transcripción firmada.
const TRANSCRIPT_TAG: &[u8] = b"RAMI-P2P-v2";
const INFO_I2R: &[u8] = b"rami i2r";
const INFO_R2I: &[u8] = b"rami r2i";
/// Longitud de la etiqueta Poly1305.
const TAG_LEN: usize = 16;

/// Lo que sabemos del par tras el handshake.
#[derive(Clone, Debug)]
pub struct PeerIdentity {
    pub pubkey: [u8; 32],
    pub node_id: u64,
    /// Puerto de escucha anunciado (0 = no escucha).
    pub port: u16,
    pub fingerprint: String,
}

/// Por qué falló un handshake.
#[derive(Debug)]
pub enum HandshakeError {
    /// El par habla el protocolo en claro de v0.6.x (`{"Hello":…}`).
    OldProtocol,
    /// Misma red pero otra versión de protocolo.
    Version(u32),
    /// Otro network-id (otra cadena).
    WrongNet,
    /// Auto-conexión (su identidad es la nuestra).
    SelfConnect,
    Io(io::Error),
    /// Mensaje malformado, prueba de trabajo o firma inválidas.
    Invalid(String),
}

impl fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HandshakeError::OldProtocol => write!(f, "par con protocolo antiguo (sin cifrar)"),
            HandshakeError::Version(v) => write!(f, "protocolo v{v} (el nuestro es v{PROTO_VERSION})"),
            HandshakeError::WrongNet => write!(f, "network-id distinto"),
            HandshakeError::SelfConnect => write!(f, "auto-conexión"),
            HandshakeError::Io(e) => write!(f, "E/S: {e}"),
            HandshakeError::Invalid(s) => write!(f, "{s}"),
        }
    }
}

impl From<io::Error> for HandshakeError {
    fn from(e: io::Error) -> Self {
        HandshakeError::Io(e)
    }
}

/// Cuerpo de `RamiHello1`/`RamiHello2` (en el 1 no viaja `sig`).
#[derive(Clone, Serialize, Deserialize)]
struct HelloBody {
    net: String,
    ver: u32,
    #[serde(rename = "pub")]
    pubkey: String,
    pow_nonce: u64,
    eph: String,
    nonce: String,
    port: u16,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    sig: String,
}

#[derive(Serialize, Deserialize)]
enum HsMsg {
    RamiHello1(HelloBody),
    RamiHello2(HelloBody),
    RamiHello3 { sig: String },
}

/// Campos ya decodificados y validados de un Hello.
struct HelloParsed {
    pubkey: [u8; 32],
    eph: [u8; 32],
    nonce: [u8; 16],
    port: u16,
    sig: Option<[u8; 64]>,
}

fn hex_array<const N: usize>(s: &str, what: &str) -> Result<[u8; N], HandshakeError> {
    let v = hex::decode(s).map_err(|_| HandshakeError::Invalid(format!("{what}: no es hex")))?;
    v.try_into().map_err(|_| HandshakeError::Invalid(format!("{what}: longitud incorrecta")))
}

/// Valida un cuerpo de Hello ajeno: red, versión, prueba de trabajo, no ser
/// nosotros mismos. La firma se comprueba aparte (necesita la transcripción).
fn parse_hello(b: &HelloBody, net_hex: &str, own_node: u64, need_sig: bool) -> Result<HelloParsed, HandshakeError> {
    if b.net != net_hex {
        return Err(HandshakeError::WrongNet);
    }
    if b.ver != PROTO_VERSION {
        return Err(HandshakeError::Version(b.ver));
    }
    let pubkey: [u8; 32] = hex_array(&b.pubkey, "pub")?;
    let eph: [u8; 32] = hex_array(&b.eph, "eph")?;
    let nonce: [u8; 16] = hex_array(&b.nonce, "nonce")?;
    if !identity_pow_ok(&pubkey, b.pow_nonce) {
        return Err(HandshakeError::Invalid("prueba de trabajo de identidad inválida".into()));
    }
    if node_id(&pubkey) == own_node {
        return Err(HandshakeError::SelfConnect);
    }
    let sig = if need_sig { Some(hex_array::<64>(&b.sig, "sig")?) } else { None };
    Ok(HelloParsed { pubkey, eph, nonce, port: b.port, sig })
}

/// Transcripción firmada por ambos (disposición fija, 203 bytes).
#[allow(clippy::too_many_arguments)]
pub fn transcript(
    net: &[u8; 32],
    init_pub: &[u8; 32],
    init_eph: &[u8; 32],
    init_nonce: &[u8; 16],
    resp_pub: &[u8; 32],
    resp_eph: &[u8; 32],
    resp_nonce: &[u8; 16],
) -> Vec<u8> {
    let mut t = Vec::with_capacity(TRANSCRIPT_TAG.len() + 32 * 6 + 32);
    t.extend_from_slice(TRANSCRIPT_TAG);
    t.extend_from_slice(net);
    t.extend_from_slice(init_pub);
    t.extend_from_slice(init_eph);
    t.extend_from_slice(init_nonce);
    t.extend_from_slice(resp_pub);
    t.extend_from_slice(resp_eph);
    t.extend_from_slice(resp_nonce);
    t
}

// ---------------------------------------------------------------- HKDF

type HmacSha256 = Hmac<Sha256>;

/// HKDF-Extract (RFC 5869 §2.2): `PRK = HMAC-SHA256(salt, IKM)`.
pub fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    // HMAC admite cualquier longitud de clave (vacía = HashLen ceros, como manda el RFC).
    let mut mac = <HmacSha256 as Mac>::new_from_slice(salt).expect("HMAC acepta cualquier longitud de clave");
    mac.update(ikm);
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

/// HKDF-Expand (RFC 5869 §2.3): `T(i) = HMAC(PRK, T(i-1) || info || i)`.
pub fn hkdf_expand(prk: &[u8; 32], info: &[u8], len: usize) -> Vec<u8> {
    assert!(len <= 255 * 32, "HKDF: longitud máxima 255*HashLen");
    let mut okm = Vec::with_capacity(len);
    let mut prev: Vec<u8> = Vec::new();
    let mut i = 1u8;
    while okm.len() < len {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(prk).expect("HMAC acepta cualquier longitud de clave");
        mac.update(&prev);
        mac.update(info);
        mac.update(&[i]);
        prev = mac.finalize().into_bytes().to_vec();
        okm.extend_from_slice(&prev);
        i = i.wrapping_add(1);
    }
    okm.truncate(len);
    okm
}

// --------------------------------------------------------------- X25519

/// Clave pública X25519 de un secreto efímero (RFC 7748, con «clamping»).
pub fn x25519_public(secret: &[u8; 32]) -> [u8; 32] {
    MontgomeryPoint::mul_base_clamped(*secret).0
}

/// Secreto compartido X25519; `None` si sale todo ceros (punto de orden
/// pequeño: un par malicioso intentando forzar una clave conocida).
pub fn x25519_shared(secret: &[u8; 32], peer_pub: &[u8; 32]) -> Option<[u8; 32]> {
    let s = MontgomeryPoint(*peer_pub).mul_clamped(*secret).0;
    if s.iter().all(|&b| b == 0) {
        None
    } else {
        Some(s)
    }
}

/// Claves de sesión `(k_i2r, k_r2i)` a partir del secreto compartido, el
/// network-id y la transcripción.
pub fn derive_keys(shared: &[u8; 32], net: &[u8; 32], t: &[u8]) -> ([u8; 32], [u8; 32]) {
    let prk = hkdf_extract(net, shared);
    let mut info_i = INFO_I2R.to_vec();
    info_i.extend_from_slice(t);
    let mut info_r = INFO_R2I.to_vec();
    info_r.extend_from_slice(t);
    let mut k_i2r = [0u8; 32];
    k_i2r.copy_from_slice(&hkdf_expand(&prk, &info_i, 32));
    let mut k_r2i = [0u8; 32];
    k_r2i.copy_from_slice(&hkdf_expand(&prk, &info_r, 32));
    (k_i2r, k_r2i)
}

// -------------------------------------------------------------- framing

/// Por qué no se pudo leer un frame. Salvo `Parse`, todos cierran la conexión.
#[derive(Debug)]
pub enum FrameError {
    /// El par cerró el socket.
    Closed,
    Io(io::Error),
    /// Longitud anunciada fuera de rango (se corta antes de reservar memoria).
    Oversized(u32),
    /// No autentica: manipulado, repetido o reordenado.
    Auth,
    /// Autenticado pero no es un `Frame` conocido (se ignora el mensaje).
    Parse,
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::Closed => write!(f, "conexión cerrada"),
            FrameError::Io(e) => write!(f, "E/S: {e}"),
            FrameError::Oversized(n) => write!(f, "frame de {n} bytes supera el máximo"),
            FrameError::Auth => write!(f, "frame no autentica (manipulado o repetido)"),
            FrameError::Parse => write!(f, "frame desconocido"),
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::Closed
        } else {
            FrameError::Io(e)
        }
    }
}

fn nonce_for(n: u64) -> Nonce {
    let mut b = [0u8; 12];
    b[4..].copy_from_slice(&n.to_le_bytes());
    Nonce::from(b)
}

/// Lado de escritura del túnel: cifra y envía frames con contador propio.
pub struct SecureWriter<W: Write> {
    w: W,
    cipher: ChaCha20Poly1305,
    n: u64,
}

impl<W: Write> SecureWriter<W> {
    pub fn new(w: W, key: &[u8; 32]) -> Self {
        SecureWriter { w, cipher: ChaCha20Poly1305::new(Key::from_slice(key)), n: 0 }
    }
    /// Cifra y escribe un mensaje (bytes en claro) como un frame.
    pub fn write_msg(&mut self, plaintext: &[u8]) -> io::Result<()> {
        if self.n == u64::MAX {
            return Err(io::Error::new(io::ErrorKind::Other, "contador de frames agotado"));
        }
        let ct = self
            .cipher
            .encrypt(&nonce_for(self.n), plaintext)
            .map_err(|_| io::Error::new(io::ErrorKind::Other, "cifrado fallido"))?;
        if ct.len() > MAX_FRAME as usize {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame demasiado grande"));
        }
        self.n += 1;
        let mut buf = Vec::with_capacity(4 + ct.len());
        buf.extend_from_slice(&(ct.len() as u32).to_be_bytes());
        buf.extend_from_slice(&ct);
        self.w.write_all(&buf)?;
        self.w.flush()
    }
    /// Serializa y envía un `Frame`.
    pub fn write_frame(&mut self, f: &Frame) -> io::Result<()> {
        self.write_msg(f.to_line().as_bytes())
    }
    pub fn get_ref(&self) -> &W {
        &self.w
    }
    /// Frames enviados hasta ahora (valor del contador).
    pub fn counter(&self) -> u64 {
        self.n
    }
}

/// Lado de lectura del túnel: lee, autentica y descifra frames.
pub struct SecureReader<R: Read> {
    r: R,
    cipher: ChaCha20Poly1305,
    n: u64,
}

impl<R: Read> SecureReader<R> {
    pub fn new(r: R, key: &[u8; 32]) -> Self {
        SecureReader { r, cipher: ChaCha20Poly1305::new(Key::from_slice(key)), n: 0 }
    }
    /// Lee un frame y devuelve su texto en claro.
    pub fn read_msg(&mut self) -> Result<Vec<u8>, FrameError> {
        let mut lb = [0u8; 4];
        self.r.read_exact(&mut lb)?;
        let len = u32::from_be_bytes(lb);
        if len > MAX_FRAME || (len as usize) < TAG_LEN {
            return Err(FrameError::Oversized(len));
        }
        let mut ct = vec![0u8; len as usize];
        self.r.read_exact(&mut ct)?;
        if self.n == u64::MAX {
            return Err(FrameError::Auth);
        }
        let pt = self.cipher.decrypt(&nonce_for(self.n), ct.as_ref()).map_err(|_| FrameError::Auth)?;
        self.n += 1;
        Ok(pt)
    }
    /// Lee un frame y lo deserializa.
    pub fn read_frame(&mut self) -> Result<Frame, FrameError> {
        let pt = self.read_msg()?;
        let s = std::str::from_utf8(&pt).map_err(|_| FrameError::Parse)?;
        Frame::from_line(s.trim()).ok_or(FrameError::Parse)
    }
    pub fn get_ref(&self) -> &R {
        &self.r
    }
    pub fn counter(&self) -> u64 {
        self.n
    }
}

/// Conexión ya autenticada y cifrada sobre TCP.
pub struct SecureStream {
    pub reader: SecureReader<BufReader<TcpStream>>,
    pub writer: SecureWriter<TcpStream>,
}

impl SecureStream {
    pub fn read_frame(&mut self) -> Result<Frame, FrameError> {
        self.reader.read_frame()
    }
    pub fn write_frame(&mut self, f: &Frame) -> io::Result<()> {
        self.writer.write_frame(f)
    }
    /// Separa lector y escritor (para hilos distintos).
    pub fn into_split(self) -> (SecureReader<BufReader<TcpStream>>, SecureWriter<TcpStream>) {
        (self.reader, self.writer)
    }
}

// ------------------------------------------------------------ handshake

/// Opciones internas del handshake. Las pruebas las usan para fabricar pares
/// defectuosos (versión antigua, red equivocada, sin prueba de trabajo, firma
/// manipulada); el código de producción usa `HsOpts::default()`.
#[derive(Clone)]
pub(crate) struct HsOpts {
    pub ver: u32,
    /// Nonce de prueba de trabajo a anunciar (None = el real de la identidad).
    pub pow_nonce: Option<u64>,
    /// Corrompe un byte de nuestra firma antes de enviarla.
    pub flip_sig: bool,
}

impl Default for HsOpts {
    fn default() -> Self {
        HsOpts { ver: PROTO_VERSION, pow_nonce: None, flip_sig: false }
    }
}

/// Lee una línea del handshake acotada a `MAX_HELLO_LINE`.
fn read_hello_line(reader: &mut BufReader<TcpStream>) -> Result<String, HandshakeError> {
    let mut l = String::new();
    let n = reader.by_ref().take(MAX_HELLO_LINE).read_line(&mut l)?;
    if n == 0 {
        return Err(HandshakeError::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "el par cerró")));
    }
    if !l.ends_with('\n') {
        return Err(HandshakeError::Invalid("línea de saludo demasiado larga".into()));
    }
    Ok(l)
}

/// Parsea un mensaje del handshake; detecta el `Hello` en claro de v0.6.x.
fn parse_hs(line: &str) -> Result<HsMsg, HandshakeError> {
    match serde_json::from_str::<HsMsg>(line.trim()) {
        Ok(m) => Ok(m),
        Err(_) => {
            if let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                if o.contains_key("Hello") {
                    return Err(HandshakeError::OldProtocol);
                }
            }
            Err(HandshakeError::Invalid("saludo malformado".into()))
        }
    }
}

fn write_line(mut w: &TcpStream, line: &str) -> io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

fn fresh_ephemeral() -> ([u8; 32], [u8; 32], [u8; 16]) {
    let mut secret = [0u8; 32];
    OsRng.fill_bytes(&mut secret);
    let mut nonce = [0u8; 16];
    OsRng.fill_bytes(&mut nonce);
    (secret, x25519_public(&secret), nonce)
}

fn own_body(net_hex: &str, id: &NodeIdentity, eph_pub: &[u8; 32], nonce: &[u8; 16], port: u16, o: &HsOpts) -> HelloBody {
    HelloBody {
        net: net_hex.to_string(),
        ver: o.ver,
        pubkey: hex::encode(id.pubkey),
        pow_nonce: o.pow_nonce.unwrap_or(id.pow_nonce),
        eph: hex::encode(eph_pub),
        nonce: hex::encode(nonce),
        port,
        sig: String::new(),
    }
}

fn sign_transcript(id: &NodeIdentity, t: &[u8], o: &HsOpts) -> [u8; 64] {
    let mut sig = id.sign(t);
    if o.flip_sig {
        sig[5] ^= 0x40;
    }
    sig
}

fn peer_identity(p: &HelloParsed) -> PeerIdentity {
    PeerIdentity { pubkey: p.pubkey, node_id: node_id(&p.pubkey), port: p.port, fingerprint: fingerprint(&p.pubkey) }
}

/// Handshake como INICIADOR (el que marcó). `port` es nuestro puerto de
/// escucha anunciado (0 = no escuchamos). El timeout de lectura lo fija quien
/// llama sobre el `TcpStream`.
pub fn handshake_initiator(
    stream: TcpStream,
    net: &[u8; 32],
    id: &NodeIdentity,
    port: u16,
) -> Result<(SecureStream, PeerIdentity), HandshakeError> {
    handshake_initiator_opts(stream, net, id, port, &HsOpts::default())
}

pub(crate) fn handshake_initiator_opts(
    stream: TcpStream,
    net: &[u8; 32],
    id: &NodeIdentity,
    port: u16,
    o: &HsOpts,
) -> Result<(SecureStream, PeerIdentity), HandshakeError> {
    let writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let net_hex = hex::encode(net);
    let (eph_secret, eph_pub, nonce) = fresh_ephemeral();

    // 1) RamiHello1
    let body1 = own_body(&net_hex, id, &eph_pub, &nonce, port, o);
    let line1 = serde_json::to_string(&HsMsg::RamiHello1(body1)).map_err(|e| HandshakeError::Invalid(e.to_string()))?;
    write_line(&writer, &line1)?;

    // 2) RamiHello2
    let line2 = read_hello_line(&mut reader)?;
    let body2 = match parse_hs(&line2)? {
        HsMsg::RamiHello2(b) => b,
        _ => return Err(HandshakeError::Invalid("esperaba RamiHello2".into())),
    };
    let resp = parse_hello(&body2, &net_hex, id.node_id(), true)?;
    let t = transcript(net, &id.pubkey, &eph_pub, &nonce, &resp.pubkey, &resp.eph, &resp.nonce);
    let sig2 = resp.sig.ok_or_else(|| HandshakeError::Invalid("sin firma".into()))?;
    if !rami_core::crypto::verify(&resp.pubkey, &t, &sig2) {
        return Err(HandshakeError::Invalid("firma del respondedor inválida".into()));
    }
    let shared = x25519_shared(&eph_secret, &resp.eph)
        .ok_or_else(|| HandshakeError::Invalid("clave efímera degenerada".into()))?;
    let (k_i2r, k_r2i) = derive_keys(&shared, net, &t);
    let mut ss = SecureStream {
        reader: SecureReader::new(reader, &k_r2i),
        writer: SecureWriter::new(writer, &k_i2r),
    };

    // 3) RamiHello3 (cifrado, contador i2r = 0)
    let sig3 = sign_transcript(id, &t, o);
    let msg3 = serde_json::to_string(&HsMsg::RamiHello3 { sig: hex::encode(sig3) })
        .map_err(|e| HandshakeError::Invalid(e.to_string()))?;
    ss.writer.write_msg(msg3.as_bytes())?;

    Ok((ss, peer_identity(&resp)))
}

/// Handshake como RESPONDEDOR (conexión entrante).
pub fn handshake_responder(
    stream: TcpStream,
    net: &[u8; 32],
    id: &NodeIdentity,
    port: u16,
) -> Result<(SecureStream, PeerIdentity), HandshakeError> {
    handshake_responder_opts(stream, net, id, port, &HsOpts::default())
}

pub(crate) fn handshake_responder_opts(
    stream: TcpStream,
    net: &[u8; 32],
    id: &NodeIdentity,
    port: u16,
    o: &HsOpts,
) -> Result<(SecureStream, PeerIdentity), HandshakeError> {
    let writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let net_hex = hex::encode(net);

    // 1) RamiHello1
    let line1 = read_hello_line(&mut reader)?;
    let body1 = match parse_hs(&line1)? {
        HsMsg::RamiHello1(b) => b,
        _ => return Err(HandshakeError::Invalid("esperaba RamiHello1".into())),
    };
    let init = parse_hello(&body1, &net_hex, id.node_id(), false)?;

    // 2) RamiHello2 firmado
    let (eph_secret, eph_pub, nonce) = fresh_ephemeral();
    let t = transcript(net, &init.pubkey, &init.eph, &init.nonce, &id.pubkey, &eph_pub, &nonce);
    let mut body2 = own_body(&net_hex, id, &eph_pub, &nonce, port, o);
    body2.sig = hex::encode(sign_transcript(id, &t, o));
    let line2 = serde_json::to_string(&HsMsg::RamiHello2(body2)).map_err(|e| HandshakeError::Invalid(e.to_string()))?;
    write_line(&writer, &line2)?;

    let shared = x25519_shared(&eph_secret, &init.eph)
        .ok_or_else(|| HandshakeError::Invalid("clave efímera degenerada".into()))?;
    let (k_i2r, k_r2i) = derive_keys(&shared, net, &t);
    let mut ss = SecureStream {
        reader: SecureReader::new(reader, &k_i2r),
        writer: SecureWriter::new(writer, &k_r2i),
    };

    // 3) RamiHello3 (cifrado): firma del iniciador
    let msg3 = match ss.reader.read_msg() {
        Ok(m) => m,
        Err(FrameError::Io(e)) => return Err(HandshakeError::Io(e)),
        Err(FrameError::Closed) => {
            return Err(HandshakeError::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "el par cerró")))
        }
        Err(e) => return Err(HandshakeError::Invalid(format!("RamiHello3: {e}"))),
    };
    let s3 = std::str::from_utf8(&msg3).map_err(|_| HandshakeError::Invalid("RamiHello3 no es UTF-8".into()))?;
    let sig3 = match parse_hs(s3)? {
        HsMsg::RamiHello3 { sig } => hex_array::<64>(&sig, "sig")?,
        _ => return Err(HandshakeError::Invalid("esperaba RamiHello3".into())),
    };
    if !rami_core::crypto::verify(&init.pubkey, &t, &sig3) {
        return Err(HandshakeError::Invalid("firma del iniciador inválida".into()));
    }

    Ok((ss, peer_identity(&init)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::OnceLock;
    use std::thread;
    use std::time::Duration;

    /// Identidades de prueba (la búsqueda de PoW cuesta ~1 s; se comparten).
    fn ids() -> &'static (NodeIdentity, NodeIdentity) {
        static IDS: OnceLock<(NodeIdentity, NodeIdentity)> = OnceLock::new();
        IDS.get_or_init(|| (NodeIdentity::from_seed_search([0x11; 32]), NodeIdentity::from_seed_search([0x22; 32])))
    }

    #[test]
    fn hkdf_rfc5869_case_1() {
        let ikm = [0x0bu8; 22];
        let salt = hex::decode("000102030405060708090a0b0c").unwrap();
        let info = hex::decode("f0f1f2f3f4f5f6f7f8f9").unwrap();
        let prk = hkdf_extract(&salt, &ikm);
        assert_eq!(hex::encode(prk), "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5");
        let okm = hkdf_expand(&prk, &info, 42);
        assert_eq!(
            hex::encode(okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn x25519_rfc7748_vector() {
        // RFC 7748 §6.1: claves de Alice y Bob y su secreto compartido.
        let a: [u8; 32] = hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a").unwrap().try_into().unwrap();
        let b: [u8; 32] = hex::decode("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb").unwrap().try_into().unwrap();
        let a_pub = x25519_public(&a);
        let b_pub = x25519_public(&b);
        assert_eq!(hex::encode(a_pub), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
        assert_eq!(hex::encode(b_pub), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
        let s1 = x25519_shared(&a, &b_pub).unwrap();
        let s2 = x25519_shared(&b, &a_pub).unwrap();
        assert_eq!(s1, s2);
        assert_eq!(hex::encode(s1), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
        // Punto de orden pequeño (todo ceros) => secreto degenerado, rechazado.
        assert!(x25519_shared(&a, &[0u8; 32]).is_none());
    }

    #[test]
    fn transcript_layout_is_fixed() {
        let t = transcript(&[1; 32], &[2; 32], &[3; 32], &[4; 16], &[5; 32], &[6; 32], &[7; 16]);
        assert_eq!(t.len(), 11 + 32 + 32 + 32 + 16 + 32 + 32 + 16);
        assert_eq!(&t[..11], b"RAMI-P2P-v2");
        assert_eq!(&t[11..43], &[1u8; 32]);
        assert_eq!(&t[43..75], &[2u8; 32]);
        assert_eq!(&t[75..107], &[3u8; 32]);
        assert_eq!(&t[107..123], &[4u8; 16]);
        assert_eq!(&t[123..155], &[5u8; 32]);
        assert_eq!(&t[155..187], &[6u8; 32]);
        assert_eq!(&t[187..203], &[7u8; 16]);
    }

    #[test]
    fn framing_roundtrip_20_frames() {
        let key = [0x42u8; 32];
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut w = SecureWriter::new(&mut buf, &key);
            for i in 0..20u64 {
                w.write_frame(&Frame::Ping { nonce: i }).unwrap();
            }
            assert_eq!(w.counter(), 20);
        }
        let mut r = SecureReader::new(std::io::Cursor::new(buf), &key);
        for i in 0..20u64 {
            assert_eq!(r.read_frame().unwrap(), Frame::Ping { nonce: i });
        }
        assert!(matches!(r.read_frame(), Err(FrameError::Closed)));
        assert_eq!(r.counter(), 20);
    }

    #[test]
    fn framing_replay_reorder_and_tamper_are_rejected() {
        let key = [0x43u8; 32];
        let mut buf: Vec<u8> = Vec::new();
        let mut w = SecureWriter::new(&mut buf, &key);
        w.write_frame(&Frame::Ping { nonce: 1 }).unwrap();
        let first_len = w.get_ref().len();
        let mut w = SecureWriter::new(&mut buf, &key);
        // el escritor nuevo reinicia el contador: el mismo frame n=0 otra vez
        w.write_frame(&Frame::Ping { nonce: 1 }).unwrap();
        let replay = buf.clone();
        // 1) repetición: el segundo frame lleva n=0 pero el lector espera n=1
        let mut r = SecureReader::new(std::io::Cursor::new(replay), &key);
        assert_eq!(r.read_frame().unwrap(), Frame::Ping { nonce: 1 });
        assert!(matches!(r.read_frame(), Err(FrameError::Auth)));
        // 2) reordenación: dos frames legítimos intercambiados
        let mut buf2: Vec<u8> = Vec::new();
        let mut w = SecureWriter::new(&mut buf2, &key);
        w.write_frame(&Frame::Ping { nonce: 1 }).unwrap();
        let split = w.get_ref().len();
        w.write_frame(&Frame::Ping { nonce: 2 }).unwrap();
        let mut swapped = buf2[split..].to_vec();
        swapped.extend_from_slice(&buf2[..split]);
        let mut r = SecureReader::new(std::io::Cursor::new(swapped), &key);
        assert!(matches!(r.read_frame(), Err(FrameError::Auth)));
        // 3) manipulación de un byte del cifrado
        let mut bad = buf[..first_len].to_vec();
        bad[7] ^= 1;
        let mut r = SecureReader::new(std::io::Cursor::new(bad), &key);
        assert!(matches!(r.read_frame(), Err(FrameError::Auth)));
        // 4) otra clave
        let mut r = SecureReader::new(std::io::Cursor::new(buf[..first_len].to_vec()), &[0u8; 32]);
        assert!(matches!(r.read_frame(), Err(FrameError::Auth)));
    }

    #[test]
    fn framing_oversized_length_is_rejected_before_reading() {
        let key = [0x44u8; 32];
        let mut data = (MAX_FRAME + 1).to_be_bytes().to_vec();
        data.extend_from_slice(&[0u8; 64]);
        let mut r = SecureReader::new(std::io::Cursor::new(data), &key);
        assert!(matches!(r.read_frame(), Err(FrameError::Oversized(_))));
        // longitud menor que la etiqueta: tampoco
        let mut r = SecureReader::new(std::io::Cursor::new(3u32.to_be_bytes().to_vec()), &key);
        assert!(matches!(r.read_frame(), Err(FrameError::Oversized(3))));
        // exactamente el máximo se ACEPTA como longitud (aunque luego no autentique)
        let mut data = MAX_FRAME.to_be_bytes().to_vec();
        data.extend_from_slice(&vec![0u8; MAX_FRAME as usize]);
        let mut r = SecureReader::new(std::io::Cursor::new(data), &key);
        assert!(matches!(r.read_frame(), Err(FrameError::Auth)));
    }

    /// Ejecuta un handshake completo por localhost con las opciones dadas para
    /// cada lado; devuelve los resultados de iniciador y respondedor.
    #[allow(clippy::type_complexity)]
    fn run_handshake(
        net_i: [u8; 32],
        net_r: [u8; 32],
        oi: HsOpts,
        or: HsOpts,
    ) -> (
        Result<(SecureStream, PeerIdentity), HandshakeError>,
        Result<(SecureStream, PeerIdentity), HandshakeError>,
    ) {
        let (ia, ib) = ids();
        let (ia, ib) = (ia.clone(), ib.clone());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let resp = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            handshake_responder_opts(s, &net_r, &ib, port, &or)
        });
        let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let init = handshake_initiator_opts(s, &net_i, &ia, 0, &oi);
        (init, resp.join().unwrap())
    }

    #[test]
    fn handshake_both_directions_and_traffic() {
        let net = [5u8; 32];
        let (init, resp) = run_handshake(net, net, HsOpts::default(), HsOpts::default());
        let (mut si, pr) = init.expect("iniciador");
        let (mut sr, pi) = resp.expect("respondedor");
        let (ia, ib) = ids();
        assert_eq!(pr.pubkey, ib.pubkey);
        assert_eq!(pi.pubkey, ia.pubkey);
        assert_eq!(pr.node_id, ib.node_id());
        assert_eq!(pi.node_id, ia.node_id());
        assert_eq!(pr.fingerprint, ib.fingerprint());
        assert_eq!(pi.port, 0);
        assert!(pr.port > 0);
        // el RamiHello3 consumió n=0 del sentido i2r
        assert_eq!(si.writer.counter(), 1);
        assert_eq!(sr.reader.counter(), 1);
        // tráfico en ambos sentidos
        si.write_frame(&Frame::Ping { nonce: 7 }).unwrap();
        assert_eq!(sr.read_frame().unwrap(), Frame::Ping { nonce: 7 });
        sr.write_frame(&Frame::Pong { nonce: 7 }).unwrap();
        assert_eq!(si.read_frame().unwrap(), Frame::Pong { nonce: 7 });
        for i in 0..20u64 {
            sr.write_frame(&Frame::Ping { nonce: i }).unwrap();
        }
        for i in 0..20u64 {
            assert_eq!(si.read_frame().unwrap(), Frame::Ping { nonce: i });
        }
        // Lo que viaja por el cable no es JSON legible: comprobamos que un
        // frame cifrado no contiene el texto en claro.
        let key = [9u8; 32];
        let mut raw = Vec::new();
        SecureWriter::new(&mut raw, &key).write_frame(&Frame::Peers { addrs: vec!["1.2.3.4:30301".into()] }).unwrap();
        assert!(!raw.windows(5).any(|w| w == b"Peers"));
    }

    #[test]
    fn tampered_responder_signature_is_rejected() {
        let net = [6u8; 32];
        let (init, _resp) = run_handshake(net, net, HsOpts::default(), HsOpts { flip_sig: true, ..HsOpts::default() });
        match init {
            Err(HandshakeError::Invalid(m)) => assert!(m.contains("firma"), "{m}"),
            other => panic!("debía rechazar la firma: {:?}", other.map(|(_, p)| p)),
        }
    }

    #[test]
    fn tampered_initiator_signature_is_rejected() {
        let net = [6u8; 32];
        let (_init, resp) = run_handshake(net, net, HsOpts { flip_sig: true, ..HsOpts::default() }, HsOpts::default());
        match resp {
            Err(HandshakeError::Invalid(m)) => assert!(m.contains("firma"), "{m}"),
            other => panic!("debía rechazar la firma: {:?}", other.map(|(_, p)| p)),
        }
    }

    #[test]
    fn wrong_net_is_rejected() {
        let (init, resp) = run_handshake([1u8; 32], [2u8; 32], HsOpts::default(), HsOpts::default());
        assert!(matches!(resp, Err(HandshakeError::WrongNet)), "respondedor");
        assert!(init.is_err(), "iniciador");
    }

    #[test]
    fn invalid_identity_pow_is_rejected() {
        let net = [7u8; 32];
        let (ia, _) = ids();
        let mut bad = ia.pow_nonce.wrapping_add(1);
        while identity_pow_ok(&ia.pubkey, bad) {
            bad += 1;
        }
        let (init, resp) = run_handshake(net, net, HsOpts { pow_nonce: Some(bad), ..HsOpts::default() }, HsOpts::default());
        match resp {
            Err(HandshakeError::Invalid(m)) => assert!(m.contains("prueba de trabajo"), "{m}"),
            other => panic!("debía rechazar la PoW: {:?}", other.map(|(_, p)| p)),
        }
        assert!(init.is_err());
        // y al revés: respondedor sin PoW válida
        let (init, _resp) = run_handshake(net, net, HsOpts::default(), HsOpts { pow_nonce: Some(bad), ..HsOpts::default() });
        assert!(matches!(init, Err(HandshakeError::Invalid(_))));
    }

    #[test]
    fn old_version_and_old_protocol_are_rejected() {
        let net = [8u8; 32];
        let (init, resp) = run_handshake(net, net, HsOpts { ver: PROTO_VERSION - 1, ..HsOpts::default() }, HsOpts::default());
        assert!(matches!(resp, Err(HandshakeError::Version(v)) if v == PROTO_VERSION - 1));
        assert!(init.is_err());
        // Un nodo v0.6.x manda `{"Hello":…}` en claro nada más conectar.
        let (_, ib) = ids();
        let ib = ib.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let resp = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            handshake_responder(s, &net, &ib, port)
        });
        let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let old = Frame::Hello { net: hex::encode(net), node: 1, port: 0, ver: 1 };
        write_line(&s, &old.to_line()).unwrap();
        assert!(matches!(resp.join().unwrap(), Err(HandshakeError::OldProtocol)));
        // y como iniciador frente a un respondedor antiguo
        let (ia, _) = ids();
        let ia = ia.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let old = Frame::Hello { net: hex::encode(net), node: 1, port: 0, ver: 1 };
            let _ = write_line(&s, &old.to_line());
            thread::sleep(Duration::from_millis(500));
        });
        let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        assert!(matches!(handshake_initiator(s, &net, &ia, 0), Err(HandshakeError::OldProtocol)));
    }

    #[test]
    fn self_connection_is_rejected() {
        let net = [3u8; 32];
        let (ia, _) = ids();
        let ia = ia.clone();
        let ia2 = ia.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let resp = thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            handshake_responder(s, &net, &ia2, port)
        });
        let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let init = handshake_initiator(s, &net, &ia, 0);
        assert!(matches!(resp.join().unwrap(), Err(HandshakeError::SelfConnect)));
        assert!(init.is_err());
    }
}
