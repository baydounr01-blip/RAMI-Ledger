//! rami-core::tx — conjunto de transacciones nativo, modelo de cuentas y
//! commit/reveal RAMI como transacciones de primera clase.
//!
//! Dos capas de serialización:
//!   * CONSENSO: binario determinista (little-endian, longitud-prefijado, 1 byte
//!     de dominio por variante). Sin floats jamás.
//!   * PAYLOAD de Commit: JSON canónico (canon.rs), opaco para la cadena, igual
//!     que la referencia Python.
//! Importes en unidades base u64 ("ramiwei"). Dirección = clave pública Ed25519
//! cruda (32 bytes).

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canon::canon;

pub type Amount = u64;
pub type AccountId = [u8; 32];
pub type TxId = [u8; 32];

/// Separador de dominio de firma (evita reutilización de firmas entre contextos).
pub const DS_TAG: &[u8] = b"RAMI-CHAIN/tx/v1";
/// Tope del payload de un Reveal (anti-DoS / anti-bloat).
pub const MAX_PAYLOAD_BYTES: usize = 4096;

/// Cotas de bloque (consenso, anti-DoS): un bloque con más transacciones o
/// más bytes que esto es INVÁLIDO aunque su PoW sea correcta. Un minero no
/// puede obligar a toda la red a validar/guardar bloques gigantes.
pub const MAX_BLOCK_TXS: usize = 4096;
pub const MAX_BLOCK_BYTES: usize = 2 * 1024 * 1024;

/// Tamaño de una transacción a efectos de la cota de bloque: cuerpo
/// codificado + firma (64 bytes si la lleva).
pub fn tx_size(tx: &Tx) -> usize {
    encode_body(tx).len() + if sig_of(tx).is_some() { 64 } else { 0 }
}

const T_COINBASE: u8 = 0x00;
const T_TRANSFER: u8 = 0x01;
const T_STAKE: u8 = 0x02;
const T_UNSTAKE: u8 = 0x03;
const T_COMMIT: u8 = 0x04;
const T_REVEAL: u8 = 0x05;
// Ciudad RAMI (fase 0 del metaverso): parcelas y activos como reglas nativas.
const T_CLAIM_PARCEL: u8 = 0x10;
const T_MINT_ASSET: u8 = 0x11;
const T_TRANSFER_ASSET: u8 = 0x12;
const T_LIST_LEASE: u8 = 0x13;
const T_RENT: u8 = 0x14;
const T_HARVEST: u8 = 0x15;
// Dubái RAMI (fase 1, v0.9.0): mercado de compra/venta en RAMI. Solo válidas
// desde la activación (`FirmaCtx.dubai`).
const T_SELL_ASSET: u8 = 0x20;
const T_BUY_ASSET: u8 = 0x21;
const T_SELL_PARCEL: u8 = 0x22;
const T_BUY_PARCEL: u8 = 0x23;

/// Lado de la cuadrícula de la ciudad HASTA la activación de Dubái (parcelas
/// 0..CITY_SIZE en x e y). Desde Dubái: `crate::ciudad::CITY_SIZE_DUBAI` (64).
pub const CITY_SIZE: u16 = 32;
/// Tope del nombre de una parcela/empresa (bytes UTF-8).
pub const MAX_NAME_BYTES: usize = 32;
/// Tope de los metadatos de un activo (bytes UTF-8).
pub const MAX_META_BYTES: usize = 64;
/// Plazo máximo de un alquiler, en bloques (~1 año a 60 s/bloque).
pub const MAX_LEASE_TERM: u64 = 525_600;
/// Tipos de parcela hasta Dubái: 0 empresa, 1 granja, 2 tienda, 3 oficina.
/// Desde Dubái: los 30 sectores de `crate::ciudad::SECTORES`.
pub const MAX_PARCEL_KIND: u8 = 3;
/// Tipos de activo hasta Dubái: 0 planta (cosecha), 1 objeto. Desde Dubái
/// también 2 vehículo y 3 local (`crate::ciudad::MAX_ASSET_KIND_DUBAI`).
pub const MAX_ASSET_KIND: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tx {
    /// Recompensa de minería. Sin firma; su validez (cota de recompensa, una por
    /// bloque) es una regla de estado, no de firma.
    Coinbase { height: u64, to: AccountId, reward: Amount, memo: Vec<u8> },
    Transfer { from: AccountId, to: AccountId, amount: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    Stake { who: AccountId, amount: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    Unstake { who: AccountId, amount: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Publica sha256(canon(payload)||secret) ANTES del hecho.
    Commit { by: AccountId, commitment: [u8; 32], fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Abre un Commit anterior. El nodo comprueba el hash y que el bloque es
    /// estrictamente posterior.
    Reveal {
        by: AccountId,
        commit_txid: TxId,
        payload: Vec<u8>,
        secret: Vec<u8>,
        fee: Amount,
        nonce: u64,
        #[serde(with = "crate::serdehex::b64")]
        sig: [u8; 64],
    },
    // ---------- Ciudad RAMI (metaverso, fase 0) ----------
    /// Reclama (o renombra, si ya es tuya) la parcela (x, y) y "monta la
    /// empresa": nombre + tipo. Una parcela libre cuesta PARCEL_PRICE (se quema).
    ClaimParcel { who: AccountId, x: u16, y: u16, name: Vec<u8>, kind: u8, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Acuña un activo (planta u objeto) en una parcela propia. Su id = txid.
    MintAsset { who: AccountId, x: u16, y: u16, kind: u8, meta: Vec<u8>, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Transfiere un activo propio (no puede estar alquilado).
    TransferAsset { from: AccountId, asset: TxId, to: AccountId, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Publica un activo propio en alquiler: precio por plazo y plazo en bloques.
    ListLease { who: AccountId, asset: TxId, price: Amount, term: u64, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Alquila un activo publicado: paga el precio al dueño y queda arrendatario
    /// hasta altura_actual + plazo.
    Rent { who: AccountId, asset: TxId, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Cosecha: el dueño de la parcela reparte `total` de SU saldo a partes
    /// iguales entre los arrendatarios activos de las plantas de esa parcela.
    Harvest { who: AccountId, x: u16, y: u16, total: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    // ---------- Dubái RAMI (metaverso, fase 1): mercado en RAMI ----------
    /// Pone un activo propio en venta por `price` RAMI (0 = retira la venta).
    SellAsset { who: AccountId, asset: TxId, price: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Compra un activo en venta: paga el precio al dueño y el activo cambia de
    /// manos en la misma transacción. `max_price` protege al comprador si el
    /// vendedor cambia el precio antes de que se mine.
    BuyAsset { who: AccountId, asset: TxId, max_price: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Pone una parcela propia (la empresa) en venta por `price` RAMI (0 = retira).
    SellParcel { who: AccountId, x: u16, y: u16, price: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
    /// Compra una parcela en venta: paga al dueño y la parcela pasa al comprador.
    BuyParcel { who: AccountId, x: u16, y: u16, max_price: Amount, fee: Amount, nonce: u64, #[serde(with = "crate::serdehex::b64")] sig: [u8; 64] },
}

fn put_u8(o: &mut Vec<u8>, x: u8) {
    o.push(x);
}
fn put_u64(o: &mut Vec<u8>, x: u64) {
    o.extend_from_slice(&x.to_le_bytes());
}
fn put_32(o: &mut Vec<u8>, x: &[u8; 32]) {
    o.extend_from_slice(x);
}
fn put_var(o: &mut Vec<u8>, x: &[u8]) {
    put_u64(o, x.len() as u64);
    o.extend_from_slice(x);
}

/// Cuerpo = byte de dominio + campos, EXCLUYENDO la firma.
pub fn encode_body(tx: &Tx) -> Vec<u8> {
    let mut o = Vec::new();
    match tx {
        Tx::Coinbase { height, to, reward, memo } => {
            put_u8(&mut o, T_COINBASE);
            put_u64(&mut o, *height);
            put_32(&mut o, to);
            put_u64(&mut o, *reward);
            put_var(&mut o, memo);
        }
        Tx::Transfer { from, to, amount, fee, nonce, .. } => {
            put_u8(&mut o, T_TRANSFER);
            put_32(&mut o, from);
            put_32(&mut o, to);
            put_u64(&mut o, *amount);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Stake { who, amount, fee, nonce, .. } => {
            put_u8(&mut o, T_STAKE);
            put_32(&mut o, who);
            put_u64(&mut o, *amount);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Unstake { who, amount, fee, nonce, .. } => {
            put_u8(&mut o, T_UNSTAKE);
            put_32(&mut o, who);
            put_u64(&mut o, *amount);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Commit { by, commitment, fee, nonce, .. } => {
            put_u8(&mut o, T_COMMIT);
            put_32(&mut o, by);
            put_32(&mut o, commitment);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Reveal { by, commit_txid, payload, secret, fee, nonce, .. } => {
            put_u8(&mut o, T_REVEAL);
            put_32(&mut o, by);
            put_32(&mut o, commit_txid);
            put_var(&mut o, payload);
            put_var(&mut o, secret);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::ClaimParcel { who, x, y, name, kind, fee, nonce, .. } => {
            put_u8(&mut o, T_CLAIM_PARCEL);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_var(&mut o, name);
            put_u8(&mut o, *kind);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::MintAsset { who, x, y, kind, meta, fee, nonce, .. } => {
            put_u8(&mut o, T_MINT_ASSET);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_u8(&mut o, *kind);
            put_var(&mut o, meta);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::TransferAsset { from, asset, to, fee, nonce, .. } => {
            put_u8(&mut o, T_TRANSFER_ASSET);
            put_32(&mut o, from);
            put_32(&mut o, asset);
            put_32(&mut o, to);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::ListLease { who, asset, price, term, fee, nonce, .. } => {
            put_u8(&mut o, T_LIST_LEASE);
            put_32(&mut o, who);
            put_32(&mut o, asset);
            put_u64(&mut o, *price);
            put_u64(&mut o, *term);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Rent { who, asset, fee, nonce, .. } => {
            put_u8(&mut o, T_RENT);
            put_32(&mut o, who);
            put_32(&mut o, asset);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::Harvest { who, x, y, total, fee, nonce, .. } => {
            put_u8(&mut o, T_HARVEST);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_u64(&mut o, *total);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::SellAsset { who, asset, price, fee, nonce, .. } => {
            put_u8(&mut o, T_SELL_ASSET);
            put_32(&mut o, who);
            put_32(&mut o, asset);
            put_u64(&mut o, *price);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::BuyAsset { who, asset, max_price, fee, nonce, .. } => {
            put_u8(&mut o, T_BUY_ASSET);
            put_32(&mut o, who);
            put_32(&mut o, asset);
            put_u64(&mut o, *max_price);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::SellParcel { who, x, y, price, fee, nonce, .. } => {
            put_u8(&mut o, T_SELL_PARCEL);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_u64(&mut o, *price);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
        Tx::BuyParcel { who, x, y, max_price, fee, nonce, .. } => {
            put_u8(&mut o, T_BUY_PARCEL);
            put_32(&mut o, who);
            put_u64(&mut o, *x as u64);
            put_u64(&mut o, *y as u64);
            put_u64(&mut o, *max_price);
            put_u64(&mut o, *fee);
            put_u64(&mut o, *nonce);
        }
    }
    o
}

fn sig_of(tx: &Tx) -> Option<&[u8; 64]> {
    match tx {
        Tx::Coinbase { .. } => None,
        Tx::Transfer { sig, .. }
        | Tx::Stake { sig, .. }
        | Tx::Unstake { sig, .. }
        | Tx::Commit { sig, .. }
        | Tx::Reveal { sig, .. }
        | Tx::ClaimParcel { sig, .. }
        | Tx::MintAsset { sig, .. }
        | Tx::TransferAsset { sig, .. }
        | Tx::ListLease { sig, .. }
        | Tx::Rent { sig, .. }
        | Tx::Harvest { sig, .. }
        | Tx::SellAsset { sig, .. }
        | Tx::BuyAsset { sig, .. }
        | Tx::SellParcel { sig, .. }
        | Tx::BuyParcel { sig, .. } => Some(sig),
    }
}

/// Clave firmante (el pagador) de una tx firmada.
pub fn signer_of(tx: &Tx) -> Option<&AccountId> {
    match tx {
        Tx::Coinbase { .. } => None,
        Tx::Transfer { from, .. } => Some(from),
        Tx::Stake { who, .. } | Tx::Unstake { who, .. } => Some(who),
        Tx::Commit { by, .. } | Tx::Reveal { by, .. } => Some(by),
        Tx::ClaimParcel { who, .. }
        | Tx::MintAsset { who, .. }
        | Tx::ListLease { who, .. }
        | Tx::Rent { who, .. }
        | Tx::Harvest { who, .. }
        | Tx::SellAsset { who, .. }
        | Tx::BuyAsset { who, .. }
        | Tx::SellParcel { who, .. }
        | Tx::BuyParcel { who, .. } => Some(who),
        Tx::TransferAsset { from, .. } => Some(from),
    }
}

/// Comisión de una transacción (0 para la coinbase).
pub fn fee_of(tx: &Tx) -> Amount {
    match tx {
        Tx::Coinbase { .. } => 0,
        Tx::Transfer { fee, .. }
        | Tx::Stake { fee, .. }
        | Tx::Unstake { fee, .. }
        | Tx::Commit { fee, .. }
        | Tx::Reveal { fee, .. }
        | Tx::ClaimParcel { fee, .. }
        | Tx::MintAsset { fee, .. }
        | Tx::TransferAsset { fee, .. }
        | Tx::ListLease { fee, .. }
        | Tx::Rent { fee, .. }
        | Tx::Harvest { fee, .. }
        | Tx::SellAsset { fee, .. }
        | Tx::BuyAsset { fee, .. }
        | Tx::SellParcel { fee, .. }
        | Tx::BuyParcel { fee, .. } => *fee,
    }
}

/// ¿Es una transacción de la fase Dubái (solo válida desde la activación)?
pub fn es_tx_dubai(tx: &Tx) -> bool {
    matches!(tx, Tx::SellAsset { .. } | Tx::BuyAsset { .. } | Tx::SellParcel { .. } | Tx::BuyParcel { .. })
}

/// Mensaje firmado (regla v1) = DS_TAG || cuerpo(sin firma).
pub fn signing_message(tx: &Tx) -> Vec<u8> {
    let mut m = DS_TAG.to_vec();
    m.extend_from_slice(&encode_body(tx));
    m
}

/// Etiqueta de dominio de la regla v2 (v0.8.0): la firma queda ligada a la red.
pub const DS_TAG_V2: &[u8] = b"RAMI-CHAIN/tx/v2";

/// Mensaje firmado (regla v2) = DS_TAG_V2 || network_id || cuerpo(sin firma).
/// `net` es el hash del génesis de la red: una firma de testnet no vale en
/// regtest ni en ninguna otra red con el mismo cuerpo de transacción.
pub fn signing_message_v2(tx: &Tx, net: &[u8; 32]) -> Vec<u8> {
    let mut m = DS_TAG_V2.to_vec();
    m.extend_from_slice(net);
    m.extend_from_slice(&encode_body(tx));
    m
}

/// Regla de firma vigente para una transacción. Se decide por el timestamp
/// del bloque que la incluye (o por «ahora» en el mempool y las carteras).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Regla {
    /// `RAMI-CHAIN/tx/v1 || cuerpo` (hasta la activación).
    V1,
    /// `RAMI-CHAIN/tx/v2 || network_id || cuerpo` (desde la activación).
    V2,
}

/// Regla que rige en `timestamp` dada la fecha de activación `v2_desde`.
/// Sin fecha (regtest por defecto) rige v1 para siempre; con fecha, v2 rige
/// exactamente desde ese segundo (inclusive). Es una función pura y total:
/// dos nodos con los mismos parámetros llegan a la misma regla para el mismo
/// bloque, que es lo que evita la bifurcación.
pub fn regla_para(v2_desde: Option<u64>, timestamp: u64) -> Regla {
    match v2_desde {
        Some(desde) if timestamp >= desde => Regla::V2,
        _ => Regla::V1,
    }
}

/// Contexto de las reglas que rigen: la regla de firma, la red y si rigen ya
/// las reglas de **Dubái** (`crate::ciudad`). Se pasa a `verify_tx_con`, a la
/// transición de estado y a las carteras para que produzcan/acepten
/// exactamente lo que rige. (Conserva el nombre de la v0.8.0 para que nada de
/// esa versión cambie de significado.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FirmaCtx {
    pub regla: Regla,
    pub net: [u8; 32],
    /// Rigen las reglas de Dubái (cuadrícula 64×64, sectores, fondo de la
    /// ciudad, mercado). Lo decide el árbol por la fecha del bloque y no
    /// retrocede dentro de una rama, igual que la regla v2.
    pub dubai: bool,
}

impl FirmaCtx {
    /// Regla v1 pura (la red no interviene en el mensaje), sin Dubái.
    pub fn v1() -> Self {
        FirmaCtx { regla: Regla::V1, net: [0u8; 32], dubai: false }
    }
    /// Regla v2 sobre la red `net`, sin Dubái.
    pub fn v2(net: [u8; 32]) -> Self {
        FirmaCtx { regla: Regla::V2, net, dubai: false }
    }
    /// Contexto para un instante dado, según la activación de los parámetros
    /// (firma v2 y Dubái, cada una con su fecha).
    pub fn para(v2_desde: Option<u64>, timestamp: u64, net: [u8; 32]) -> Self {
        FirmaCtx { regla: regla_para(v2_desde, timestamp), net, dubai: false }
    }
    /// El mismo contexto con las reglas de Dubái activadas o no.
    pub fn con_dubai(mut self, dubai: bool) -> Self {
        self.dubai = dubai;
        self
    }
    /// ¿Rigen las reglas de Dubái en `timestamp` dada su fecha de activación?
    pub fn dubai_para(dubai_desde: Option<u64>, timestamp: u64) -> bool {
        matches!(dubai_desde, Some(desde) if timestamp >= desde)
    }
    /// Lado de la cuadrícula que rige en este contexto.
    pub fn city_size(&self) -> u16 {
        if self.dubai { crate::ciudad::CITY_SIZE_DUBAI } else { CITY_SIZE }
    }
    /// Sector/tipo de parcela más alto que rige en este contexto.
    pub fn max_parcel_kind(&self) -> u8 {
        if self.dubai { crate::ciudad::MAX_SECTOR } else { MAX_PARCEL_KIND }
    }
    /// Tipo de activo más alto que rige en este contexto.
    pub fn max_asset_kind(&self) -> u8 {
        if self.dubai { crate::ciudad::MAX_ASSET_KIND_DUBAI } else { MAX_ASSET_KIND }
    }
    /// Mensaje que debe firmar/verificar esta transacción bajo el contexto.
    pub fn mensaje(&self, tx: &Tx) -> Vec<u8> {
        match self.regla {
            Regla::V1 => signing_message(tx),
            Regla::V2 => signing_message_v2(tx, &self.net),
        }
    }
    /// Número de regla tal y como se anuncia por la red (`Status.rule`):
    /// 1 firma v1, 2 firma v2, 3 firma v2 con las reglas de Dubái.
    pub fn numero(&self) -> u32 {
        match (self.regla, self.dubai) {
            (Regla::V1, false) => 1,
            (Regla::V2, false) => 2,
            (_, true) => 3,
        }
    }
}

fn sha256d(data: &[u8]) -> [u8; 32] {
    let a = Sha256::digest(data);
    let b = Sha256::digest(a);
    let mut out = [0u8; 32];
    out.copy_from_slice(&b);
    out
}

/// txid = sha256d(cuerpo || firma). La firma va DENTRO del txid (anti-maleabilidad).
pub fn txid(tx: &Tx) -> TxId {
    let mut buf = encode_body(tx);
    if let Some(sig) = sig_of(tx) {
        buf.extend_from_slice(sig);
    }
    sha256d(&buf)
}

/// commit_hash = sha256(canon(payload) || secret). SHA-256 simple (no doble) para
/// coincidir byte a byte con el hexdigest de la referencia Python.
pub fn commit_hash(payload: &Value, secret: &[u8]) -> Result<[u8; 32], String> {
    let mut buf = canon(payload)?.into_bytes();
    buf.extend_from_slice(secret);
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(&buf));
    Ok(out)
}

/// Raíz de Merkle sobre txids (SHA-256d, duplica el último si impar). Bloque
/// vacío -> 32 ceros.
pub fn merkle_root_txids(txids: &[TxId]) -> [u8; 32] {
    if txids.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<[u8; 32]> = txids.to_vec();
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

/// Verificación SIN estado: estructura + firma. Las comprobaciones económicas
/// (saldo, orden de nonce, cota de recompensa, suficiencia de stake) y las de
/// commit/reveal con estado se hacen en la transición de estado.
pub fn verify_tx(tx: &Tx) -> Result<(), String> {
    verify_tx_con(tx, &FirmaCtx::v1())
}

/// Como `verify_tx`, pero la firma se comprueba contra el mensaje que dicta
/// `ctx` (regla v1 o v2 sobre una red concreta). Una firma v1 no pasa bajo v2
/// ni al revés: el mensaje es distinto en la etiqueta y en la red.
pub fn verify_tx_con(tx: &Tx, ctx: &FirmaCtx) -> Result<(), String> {
    // Cotas estructurales (anti-DoS / anti-bloat), sin estado. La cuadrícula y
    // los catálogos dependen de si rigen ya las reglas de Dubái (`ctx.dubai`).
    let size = ctx.city_size();
    match tx {
        Tx::Reveal { payload, .. } if payload.len() > MAX_PAYLOAD_BYTES => {
            return Err("payload de reveal excede MAX_PAYLOAD_BYTES".into());
        }
        Tx::ClaimParcel { x, y, name, kind, .. } => {
            if *x >= size || *y >= size {
                return Err("parcela fuera de la ciudad".into());
            }
            if name.is_empty() || name.len() > MAX_NAME_BYTES || std::str::from_utf8(name).is_err() {
                return Err("nombre de parcela vacío, demasiado largo o no UTF-8".into());
            }
            if *kind > ctx.max_parcel_kind() {
                return Err("tipo de parcela desconocido".into());
            }
        }
        Tx::MintAsset { x, y, kind, meta, .. } => {
            if *x >= size || *y >= size {
                return Err("parcela fuera de la ciudad".into());
            }
            if meta.len() > MAX_META_BYTES || std::str::from_utf8(meta).is_err() {
                return Err("metadatos del activo demasiado largos o no UTF-8".into());
            }
            if *kind > ctx.max_asset_kind() {
                return Err("tipo de activo desconocido".into());
            }
        }
        Tx::ListLease { term, .. } => {
            if *term == 0 || *term > MAX_LEASE_TERM {
                return Err("plazo de alquiler fuera de rango".into());
            }
        }
        Tx::Harvest { x, y, total, .. } => {
            if *x >= size || *y >= size {
                return Err("parcela fuera de la ciudad".into());
            }
            if *total == 0 {
                return Err("la cosecha debe repartir algo".into());
            }
        }
        Tx::SellAsset { .. } | Tx::BuyAsset { .. } | Tx::SellParcel { .. } | Tx::BuyParcel { .. } if !ctx.dubai => {
            return Err("transacción de Dubái antes de su activación".into());
        }
        Tx::SellParcel { x, y, .. } | Tx::BuyParcel { x, y, .. } => {
            if *x >= size || *y >= size {
                return Err("parcela fuera de la ciudad".into());
            }
        }
        Tx::BuyAsset { max_price, .. } if *max_price == 0 => {
            return Err("el precio máximo de compra debe ser mayor que cero".into());
        }
        _ => {}
    }
    // La coinbase no lleva firma.
    let (Some(sig_bytes), Some(pk_bytes)) = (sig_of(tx), signer_of(tx)) else {
        return match tx {
            Tx::Coinbase { .. } => Ok(()),
            _ => Err("transacción firmada sin firma o sin firmante".into()),
        };
    };
    let vk = VerifyingKey::from_bytes(pk_bytes).map_err(|_| "pubkey inválida".to_string())?;
    let signature = Signature::from_bytes(sig_bytes);
    // verify_strict rechaza claves de orden pequeño / no canónicas.
    vk.verify_strict(&ctx.mensaje(tx), &signature)
        .map_err(|_| match ctx.regla {
            Regla::V1 => "firma inválida".to_string(),
            Regla::V2 => "firma inválida bajo la regla v2 (etiqueta+red)".to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::KeyPair;
    use serde_json::json;

    fn signed_transfer(kp: &KeyPair, to: AccountId, amount: u64, nonce: u64) -> Tx {
        let mut tx = Tx::Transfer { from: kp.public_bytes(), to, amount, fee: 1, nonce, sig: [0u8; 64] };
        let sig = kp.sign(&signing_message(&tx));
        if let Tx::Transfer { sig: s, .. } = &mut tx {
            *s = sig;
        }
        tx
    }

    #[test]
    fn transfer_verifies_and_detects_tamper() {
        let kp = KeyPair::from_secret(&[3u8; 32]);
        let tx = signed_transfer(&kp, [9u8; 32], 100, 0);
        assert!(verify_tx(&tx).is_ok());
        // manipular el importe invalida la firma
        let mut bad = tx.clone();
        if let Tx::Transfer { amount, .. } = &mut bad {
            *amount = 101;
        }
        assert!(verify_tx(&bad).is_err());
    }

    #[test]
    fn txid_covers_signature() {
        let kp = KeyPair::from_secret(&[4u8; 32]);
        let a = signed_transfer(&kp, [1u8; 32], 5, 0);
        let mut b = a.clone();
        if let Tx::Transfer { sig, .. } = &mut b {
            sig[0] ^= 0xFF; // maleabilidad de firma
        }
        assert_ne!(txid(&a), txid(&b)); // distinto txid => no maleable
    }

    #[test]
    fn coinbase_has_no_signature_and_verifies() {
        let cb = Tx::Coinbase { height: 0, to: [1u8; 32], reward: 50, memo: b"genesis".to_vec() };
        assert!(verify_tx(&cb).is_ok());
    }

    #[test]
    fn commit_hash_matches_reference_layer() {
        let payload = json!({"pair":"BTC","dir":"LONG","z":2.0});
        let secret = [0u8; 32];
        let c = commit_hash(&payload, &secret).unwrap();
        // Igual que reference/rami_ledger.py commit_hash con nonce de ceros.
        assert_eq!(hex::encode(c), "107a3366fe9633b88c49a21c63ddc9655ec878fca2671be19155a8969e545603");
    }

    #[test]
    fn empty_merkle_is_zero() {
        assert_eq!(merkle_root_txids(&[]), [0u8; 32]);
    }

    fn signed_transfer_con(kp: &KeyPair, ctx: &FirmaCtx, nonce: u64) -> Tx {
        let mut tx = Tx::Transfer { from: kp.public_bytes(), to: [7u8; 32], amount: 3, fee: 1, nonce, sig: [0u8; 64] };
        let sig = kp.sign(&ctx.mensaje(&tx));
        if let Tx::Transfer { sig: s, .. } = &mut tx {
            *s = sig;
        }
        tx
    }

    #[test]
    fn regla_se_decide_por_fecha_inclusive() {
        assert_eq!(regla_para(None, u64::MAX), Regla::V1);
        assert_eq!(regla_para(Some(1000), 999), Regla::V1);
        assert_eq!(regla_para(Some(1000), 1000), Regla::V2);
        assert_eq!(regla_para(Some(1000), 1001), Regla::V2);
        assert_eq!(regla_para(Some(0), 0), Regla::V2);
    }

    #[test]
    fn firma_v1_no_vale_bajo_v2_ni_al_reves() {
        let kp = KeyPair::from_secret(&[5u8; 32]);
        let net = [0xABu8; 32];
        let v1 = FirmaCtx::v1();
        let v2 = FirmaCtx::v2(net);
        let tx1 = signed_transfer_con(&kp, &v1, 0);
        let tx2 = signed_transfer_con(&kp, &v2, 0);
        assert!(verify_tx_con(&tx1, &v1).is_ok());
        assert!(verify_tx_con(&tx2, &v2).is_ok());
        assert!(verify_tx_con(&tx1, &v2).is_err(), "una firma v1 no debe pasar bajo v2");
        assert!(verify_tx_con(&tx2, &v1).is_err(), "una firma v2 no debe pasar bajo v1");
        // `verify_tx` sigue siendo la regla v1 (compatibilidad con v0.7.x).
        assert!(verify_tx(&tx1).is_ok());
        assert!(verify_tx(&tx2).is_err());
    }

    #[test]
    fn firma_v2_queda_ligada_a_la_red() {
        let kp = KeyPair::from_secret(&[6u8; 32]);
        let red_a = FirmaCtx::v2([1u8; 32]);
        let red_b = FirmaCtx::v2([2u8; 32]);
        let tx = signed_transfer_con(&kp, &red_a, 0);
        assert!(verify_tx_con(&tx, &red_a).is_ok());
        assert!(verify_tx_con(&tx, &red_b).is_err(), "misma tx, otra red: rechazada");
        // El txid no depende de la regla: cubre cuerpo y firma, no la etiqueta.
        assert_eq!(txid(&tx), txid(&tx.clone()));
    }

    #[test]
    fn las_tx_de_dubai_solo_valen_con_la_regla_activa_y_la_cuadricula_crece() {
        let kp = KeyPair::from_secret(&[21u8; 32]);
        let net = [3u8; 32];
        let sin = FirmaCtx::v2(net);
        let con = FirmaCtx::v2(net).con_dubai(true);
        assert_eq!(sin.numero(), 2);
        assert_eq!(con.numero(), 3);
        assert_eq!(sin.city_size(), 32);
        assert_eq!(con.city_size(), 64);
        assert!(FirmaCtx::dubai_para(Some(100), 100) && !FirmaCtx::dubai_para(Some(100), 99) && !FirmaCtx::dubai_para(None, u64::MAX));
        let mut venta = Tx::SellParcel { who: kp.public_bytes(), x: 50, y: 40, price: 5, fee: 1, nonce: 0, sig: [0u8; 64] };
        let sig = kp.sign(&con.mensaje(&venta));
        if let Tx::SellParcel { sig: s, .. } = &mut venta { *s = sig; }
        assert!(es_tx_dubai(&venta));
        assert!(verify_tx_con(&venta, &con).is_ok());
        let err = verify_tx_con(&venta, &sin).unwrap_err();
        assert!(err.contains("Dubái"), "motivo: {err}");
        // Una parcela (50, 40) queda fuera de la ciudad de 32×32, dentro de la de 64×64.
        let mut claim = Tx::ClaimParcel { who: kp.public_bytes(), x: 50, y: 40, name: b"Hotel".to_vec(), kind: 5, fee: 1, nonce: 0, sig: [0u8; 64] };
        let sig = kp.sign(&con.mensaje(&claim));
        if let Tx::ClaimParcel { sig: s, .. } = &mut claim { *s = sig; }
        assert!(verify_tx_con(&claim, &con).is_ok());
        assert!(verify_tx_con(&claim, &sin).is_err());
        // Un sector > 3 tampoco vale antes de Dubái, aunque la parcela quepa.
        let mut claim2 = Tx::ClaimParcel { who: kp.public_bytes(), x: 5, y: 5, name: b"Hotel".to_vec(), kind: 5, fee: 1, nonce: 0, sig: [0u8; 64] };
        let sig = kp.sign(&sin.mensaje(&claim2));
        if let Tx::ClaimParcel { sig: s, .. } = &mut claim2 { *s = sig; }
        assert!(verify_tx_con(&claim2, &sin).is_err());
        // El mensaje firmado no depende del bit Dubái: la firma es la misma.
        assert_eq!(sin.mensaje(&venta), con.mensaje(&venta));
    }

    #[test]
    fn mensajes_v1_y_v2_difieren_en_etiqueta_y_red() {
        let kp = KeyPair::from_secret(&[8u8; 32]);
        let tx = signed_transfer_con(&kp, &FirmaCtx::v1(), 0);
        let m1 = signing_message(&tx);
        let m2 = signing_message_v2(&tx, &[9u8; 32]);
        assert!(m1.starts_with(DS_TAG));
        assert!(m2.starts_with(DS_TAG_V2));
        assert_eq!(&m2[DS_TAG_V2.len()..DS_TAG_V2.len() + 32], &[9u8; 32]);
        assert_eq!(&m1[DS_TAG.len()..], &m2[DS_TAG_V2.len() + 32..], "el cuerpo es el mismo");
        assert_eq!(FirmaCtx::v1().numero(), 1);
        assert_eq!(FirmaCtx::v2([0u8; 32]).numero(), 2);
    }
}
