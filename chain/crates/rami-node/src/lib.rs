//! rami-node (biblioteca): el motor del nodo de RAMI-Chain.
//!
//! Reúne el árbol de bloques, el mempool, la minería y el gossip P2P en un
//! runtime con un único dueño de estado (el hilo del nodo) al que la CLI y el
//! monedero de escritorio hablan por canales. Diseño sin punto de fallo único:
//! el nodo sincroniza y retransmite con varios pares y revalida TODO lo que
//! llega de la red con las reglas de consenso (`rami-core`).
//!
//! La red neuronal (`rami_core::nn`) sigue siendo SOLO asesora: nada aquí
//! rechaza un bloque por su salida.

pub mod http;
pub mod update;
pub mod geo;
pub mod portmap;
/// Autoauditoría del Túnel RAMI (re-exportada para el monedero de escritorio).
pub use rami_net::selftest;
pub mod seeds;
pub mod grado;

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use rami_core::block::{Block, BlockHeader, Hash};
use rami_core::blocktree::is_orphan_err;
use rami_core::ciudad;
use rami_core::crypto::verify as ed_verify;
use rami_core::params::Params;
use rami_core::pow::{difficulty_from_bits, meets_target, pow_hash};
use rami_core::state::{block_reward, Account, State, COIN};
use rami_core::store::ChainDir;
use rami_core::tx::{merkle_root_txids, signer_of, txid, verify_tx_con, AccountId, FirmaCtx, Tx, TxId};

use rami_net::{Frame, NetConfig, NetEvent, Network, PeerId, TipInfo};
use rami_net::identity::{fingerprint as fingerprint_of, identity_pow_ok, NodeIdentity};

use crate::grado::{EvidenciaSesion, HistorialPar};

/// Mensaje del coinbase (aparece en cada bloque minado).
pub const CHANCELLOR: &str =
    "RAMI-Chain — el pasado, el presente y el futuro coexisten. Testnet experimental, sin valor monetario.";

/// Tamaño de lote de sincronización (bloques por petición `GetBranch`).
const SYNC_BATCH: u32 = 256;
/// Tope de bloques servidos en una respuesta `Branch`.
const SERVE_MAX: usize = 512;
/// Tope de bytes (JSON) de bloques en una respuesta `Branch`: por debajo de la
/// cota de línea del transporte (`rami_net::MAX_LINE`) con margen.
const SERVE_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Peticiones `GetBranch` que se atienden a UN par por ventana `BRANCH_RETRY`
/// (cota de amplificación: un `GetBranch` de 100 bytes puede pedir 512 bloques).
/// Un peticionario honesto (4 en vuelo, continuación inmediata) no la alcanza
/// salvo en una sincronización enorme, y entonces solo se ralentiza.
const SERVE_RATE_MAX: u32 = 128;
/// Rondas máximas de `GetBranch` por (par, punta) SIN progreso (cota contra
/// pares que responden basura o nunca terminan). Progreso = el cursor avanza
/// (bloques nuevos O un lote entero ya conocido que reanuda más adelante). Se
/// cuenta por par: un par que no sirve una punta no la «quema» para los demás.
const BRANCH_MAX_ROUNDS: u32 = 200;
/// (par, punta) agotadas que se toleran a un mismo par antes de expulsarlo.
const PEER_STRIKES_MAX: u32 = 8;
/// Ventana anti-spam: no se repite la misma petición de rama a un par antes de
/// este plazo (salvo la continuación inmediata de un lote con `more`).
const BRANCH_RETRY: Duration = Duration::from_secs(10);
/// Peticiones `GetBranch` activas (enviadas hace menos de `BRANCH_RETRY`) que
/// se mantienen por par: las puntas pendientes esperan cola, no se piden todas
/// de golpe (un `Tips` con 256 puntas inventadas costaba 256 peticiones).
const MAX_INFLIGHT_PER_PEER: usize = 4;
/// Latido del universo de ramas: el conjunto COMPLETO de puntas se reanuncia
/// periódicamente; entre latidos solo viajan las puntas nuevas (delta).
const TIPS_HEARTBEAT: Duration = Duration::from_secs(30);
/// Tope de puntas que se anuncian (las más pesadas) y que se registran por par
/// (un par no puede inflar memoria).
const PEER_TIPS_CAP: usize = 256;
/// Bloques inválidos (no huérfanos) recordados para no revalidarlos.
const BAD_BLOCKS_CAP: usize = 4096;
/// Topes del mempool: transacciones pendientes en total y por firmante, y
/// tamaño de la memoria de txids ya vistos.
const MEMPOOL_MAX: usize = 5_000;
const MEMPOOL_MAX_PER_SIGNER: usize = 64;
const SEEN_TX_CAP: usize = 100_000;
/// Hashes por vuelta del minero antes de refrescar métricas/epoch.
const MINE_CHUNK: u64 = 120_000;
/// Presencia y chat del metaverso (efímeros, nunca consenso): topes de
/// memoria, ritmo por identidad, caducidad y saltos de retransmisión.
const PRESENCE_CAP: usize = 256;
const PRESENCE_MIN_INTERVAL: Duration = Duration::from_millis(400);
const PRESENCE_TTL: Duration = Duration::from_secs(20);
const PRESENCE_MAX_HOPS: u8 = 2;
const CHAT_CAP: usize = 64;
const CHAT_MIN_INTERVAL: Duration = Duration::from_millis(1500);
const CHAT_MAX_HOPS: u8 = 3;
/// Tope del nombre visible y del texto de chat (bytes UTF-8).
pub const PRESENCE_NAME_MAX: usize = 24;
pub const CHAT_TEXT_MAX: usize = 280;
/// Coordenadas locales del avatar acotadas (metros; la ciudad mide ~42 km).
const PRESENCE_COORD_MAX: i32 = 100_000;

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Convierte una dirección de pago (hex de 32 bytes, con o sin prefijo `rami1`).
pub fn parse_pubkey(hexs: &str) -> Result<AccountId, String> {
    let v = hex::decode(hexs.trim().trim_start_matches("rami1"))
        .map_err(|_| "dirección no es hex".to_string())?;
    if v.len() != 32 {
        return Err("la dirección debe ser la clave pública de 32 bytes (64 hex)".into());
    }
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    Ok(a)
}

/// Hash de bloque en hex (64 caracteres) -> `Hash`; None si no es válido.
fn parse_hash(hexs: &str) -> Option<Hash> {
    let v = hex::decode(hexs).ok()?;
    if v.len() != 32 {
        return None;
    }
    let mut h = [0u8; 32];
    h.copy_from_slice(&v);
    Some(h)
}

pub fn tx_fee(tx: &Tx) -> u64 {
    rami_core::tx::fee_of(tx)
}

/// Comprobación de una tx suelta contra una copia del estado, con las MISMAS
/// reglas que la validación de bloques (`apply_tx`): así el mempool y el bloque
/// candidato nunca admiten una tx que luego invalidaría el bloque minado (y
/// dejaría al minero atascado). `height` = altura del bloque en que iría.
/// Mutar `sim` permite encadenar varias en el mismo bloque candidato.
fn try_apply(sim: &mut State, tx: &Tx, height: u64, dubai: bool) -> Result<(), String> {
    if matches!(tx, Tx::Coinbase { .. }) {
        return Err("coinbase no va en mempool".into());
    }
    rami_core::state::apply_tx(sim, tx, height, 1, &txid(tx), dubai)
}

/// Construye la CABECERA candidata (sin minar, nonce 0) y las tx de un bloque a
/// la altura dada, seleccionando del mempool lo que aplique limpiamente.
#[allow(clippy::too_many_arguments)]
pub fn build_candidate(
    height: u64,
    prev: Hash,
    bits: u32,
    miner: AccountId,
    state: &State,
    mempool: &[Tx],
    tag: [u8; 4],
    timestamp: u64,
    firma: &FirmaCtx,
) -> (BlockHeader, Vec<Tx>, Vec<TxId>) {
    let mut sim = state.clone();
    let mut included: Vec<Tx> = Vec::new();
    let mut fees: u128 = 0;
    for tx in mempool {
        // Solo entran las tx firmadas bajo la regla que rige para ESTE
        // timestamp: así el bloque candidato es válido para todos los nodos
        // con los mismos parámetros (v1 antes de la activación, v2 después).
        if verify_tx_con(tx, firma).is_err() {
            continue;
        }
        if try_apply(&mut sim, tx, height, firma.dubai).is_ok() {
            fees += tx_fee(tx) as u128;
            included.push(tx.clone());
        }
    }
    // Desde Dubái, la parte de la ciudad no es del minero (cota de la coinbase).
    let emision = block_reward(height);
    let propia = if firma.dubai { emision - ciudad::parte_ciudad(emision) } else { emision };
    let reward = (propia as u128 + fees).min(u64::MAX as u128) as u64;
    let coinbase = Tx::Coinbase { height, to: miner, reward, memo: CHANCELLOR.as_bytes().to_vec() };
    let mut txs = vec![coinbase];
    txs.extend(included);
    let ids: Vec<TxId> = txs.iter().map(txid).collect();
    let merkle_root = merkle_root_txids(&ids);
    let header = BlockHeader {
        version: 1,
        prev_hash: prev,
        height,
        timestamp,
        merkle_root,
        bits,
        nonce: 0,
        branch_tag: tag,
    };
    (header, txs, ids)
}

/// Minero bloqueante (para la CLI): gira el nonce hasta cumplir el objetivo.
pub fn mine_header(mut header: BlockHeader) -> BlockHeader {
    loop {
        if meets_target(&pow_hash(&header.canonical_bytes()), header.bits) {
            return header;
        }
        header.nonce = header.nonce.wrapping_add(1);
        if header.nonce % 2_000_000 == 0 {
            header.timestamp = now_secs();
        }
    }
}

/// Construye y MINA un bloque completo (para la CLI `mine`).
#[allow(clippy::too_many_arguments)]
pub fn build_block(
    height: u64,
    prev: Hash,
    bits: u32,
    miner: AccountId,
    state: &State,
    mempool: &[Tx],
    tag: [u8; 4],
    firma: &FirmaCtx,
) -> (Block, Vec<TxId>) {
    let (header, txs, ids) = build_candidate(height, prev, bits, miner, state, mempool, tag, now_secs(), firma);
    (Block { header: mine_header(header), txs }, ids)
}

/// Regla más alta que entiende este binario (se anuncia en `Status.rule`):
/// 1 firma v1, 2 firma v2 (v0.8.0), 3 firma v2 + Dubái (v0.9.0).
pub const REGLA_SOPORTADA: u32 = 3;
/// Regla que anunciaba la v0.8.0 (firma v2 sin Dubái).
pub const REGLA_V2: u32 = 2;

/// El bloque génesis para inicializar una cadena. Testnet = génesis canónico
/// fijo (network-id estable); regtest = uno minado localmente.
pub fn make_genesis(is_testnet: bool, params: Params, miner: AccountId) -> Block {
    if is_testnet {
        return rami_core::genesis::testnet_genesis();
    }
    let coinbase = Tx::Coinbase {
        height: 0,
        to: miner,
        reward: block_reward(0),
        memo: CHANCELLOR.as_bytes().to_vec(),
    };
    let merkle_root = merkle_root_txids(&[txid(&coinbase)]);
    let header = mine_header(BlockHeader {
        version: 1,
        prev_hash: rami_core::block::ZERO_HASH,
        height: 0,
        timestamp: now_secs(),
        merkle_root,
        bits: params.genesis_bits,
        nonce: 0,
        branch_tag: *b"gen0",
    });
    Block { header, txs: vec![coinbase] }
}

/// Pares conocidos persistidos (peers.json, array JSON de "host:puerto").
/// Tope de 64 para que el archivo no crezca sin límite.
const KNOWN_PEERS_CAP: usize = 64;

fn peers_path(root: &Path) -> PathBuf {
    root.join("peers.json")
}

fn load_known_peers(root: &Path) -> HashSet<String> {
    std::fs::read_to_string(peers_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .take(KNOWN_PEERS_CAP)
        .collect()
}

fn persist_known_peers(root: &Path, peers: &HashSet<String>) {
    let mut list: Vec<&String> = peers.iter().collect();
    list.sort();
    list.truncate(KNOWN_PEERS_CAP);
    if let Ok(json) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(peers_path(root), json);
    }
}

/// Identidades conocidas (TOFU, «confía la primera vez»): dirección
/// remarcable -> clave pública hex del nodo que la atendía. Como con SSH, si
/// una dirección aparece luego con OTRA identidad se avisa (no se corta: es
/// una testnet, y una IP puede cambiar de dueño legítimamente).
const KNOWN_IDENTITIES_CAP: usize = 256;
/// Tope de avisos de identidad cambiada que se exponen en el panel.
const IDENTITY_WARNINGS_CAP: usize = 16;

fn identities_path(root: &Path) -> PathBuf {
    root.join("known-identities.json")
}

fn load_known_identities(root: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(identities_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .take(KNOWN_IDENTITIES_CAP)
        .collect()
}

fn persist_known_identities(root: &Path, ids: &HashMap<String, String>) {
    let mut list: Vec<(&String, &String)> = ids.iter().collect();
    list.sort();
    list.truncate(KNOWN_IDENTITIES_CAP);
    let map: serde_json::Map<String, serde_json::Value> =
        list.into_iter().map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone()))).collect();
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(identities_path(root), json);
    }
}

// ------------------------- runtime -------------------------

#[derive(Clone)]
pub struct NodeConfig {
    pub chain_dir: PathBuf,
    pub params: Params,
    pub is_testnet: bool,
    pub listen: Option<u16>,
    pub seeds: Vec<String>,
    pub miner: Option<AccountId>,
    pub mining: bool,
    /// Descubrimiento de nodos en la red local (UDP 30303).
    pub lan_discovery: bool,
    /// Abrir el puerto P2P en el router (NAT-PMP / UPnP).
    pub portmap: bool,
}

/// Diagnóstico de red para el panel: IP local, IP pública y estado del mapeo
/// de puerto. `code` es lo que hay que darle a otra persona para conectarse.
#[derive(Clone, Debug, Serialize, Default)]
pub struct NetInfo {
    pub lan_ip: Option<String>,
    pub external_ip: Option<String>,
    pub portmap_ok: bool,
    pub portmap_method: String,
    pub portmap_detail: String,
    pub portmap_enabled: bool,
    pub lan_discovery: bool,
    pub code: String,
    pub code_lan: String,
    /// Avisos «la identidad del par X ha cambiado (huella A → B)» (TOFU).
    pub identity_warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct PeerView {
    pub addr: String,
    pub inbound: bool,
    /// Huella de la identidad autenticada del par.
    pub fingerprint: String,
    /// Clave pública Ed25519 del par (hex).
    pub pubkey: String,
    pub height: u64,
    /// Nº de puntas (ramas) que el par ha anunciado con `Tips`.
    pub tips: usize,
    /// Mayor trabajo acumulado entre sus puntas (u128 decimal).
    pub best_work: String,
    /// Código Admiralty de este par como fuente («B2»): letra por historial,
    /// número por lo observado en esta sesión. Ver `grado`.
    pub fuente: String,
    pub fiabilidad: String,
    pub credibilidad: u8,
    /// Por qué esa letra y ese número.
    pub motivos: Vec<String>,
    /// Regla de firma más alta que anuncia el par en `Status.rule` (0 si no
    /// la anuncia: binario anterior a v0.8.0, que solo entiende v1).
    pub regla_tx: u32,
}

/// Hechos del cambio de consenso (regla de firma v2 ligada a la red).
#[derive(Clone, Debug, Serialize, Default)]
pub struct ConsensoInfo {
    /// Regla que rige AHORA para las tx nuevas (1 o 2).
    pub regla_vigente: u32,
    /// Regla más alta que entiende este binario.
    pub regla_soportada: u32,
    /// Instante de activación (Unix, UTC); `None` si esta red no la tiene.
    pub v2_desde: Option<u64>,
    /// Segundos hasta la activación (0 si ya rige o no hay fecha).
    pub faltan_segundos: u64,
    /// Pares que anuncian entender la regla v2.
    pub pares_v2: usize,
    pub pares_total: usize,
    /// Tx del mempool que NO valen bajo la regla vigente (quedan a la espera
    /// de que su autor las vuelva a firmar; se podan al activarse).
    pub mempool_fuera_de_regla: usize,
    /// Dubái (v0.9.0): fecha de activación, si rige ya, segundos que faltan
    /// y pares que anuncian entenderla (regla 3).
    pub dubai_desde: Option<u64>,
    pub dubai_vigente: bool,
    pub dubai_faltan_segundos: u64,
    pub pares_dubai: usize,
}

/// El hecho detrás del juicio «sincronizado»: alturas, no adjetivos.
#[derive(Clone, Debug, Serialize, Default)]
pub struct SyncInfo {
    pub mi_altura: u64,
    /// Mejor altura declarada por un par (0 sin pares).
    pub mejor_altura_pares: u64,
    /// Pares que declaran una altura ≤ la nuestra.
    pub pares_a_mi_altura: usize,
    pub pares_total: usize,
    /// Bloques que nos faltan respecto al mejor par (0 si vamos por delante).
    pub atras: u64,
}

/// Estado del universo de ramas para el panel: el árbol completo (todas las
/// ramas, no solo la del observador) y la sincronización rama a rama.
#[derive(Clone, Debug, Serialize, Default)]
pub struct UniverseInfo {
    /// Bloques en el árbol (todas las ramas).
    pub blocks: usize,
    /// Puntas (hojas) del árbol.
    pub tips: usize,
    /// Lotes `Branch` aplicados (con al menos un bloque nuevo).
    pub branches_synced: u64,
    /// Par del que llegó el último lote aplicado.
    pub last_sync_from: String,
    /// Código de fuente de ese par cuando llegó el lote («B2»; vacío si no hay).
    pub last_sync_fuente: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct NodeStatus {
    pub network: String,
    pub network_id: String,
    pub node_id: u64,
    /// Huella de la identidad de este nodo (`xxxx-xxxx-xxxx-xxxx`).
    pub node_fingerprint: String,
    /// Todas las conexiones van por el Túnel RAMI (autenticado y cifrado).
    pub secure: bool,
    pub listen_port: u16,
    pub height: u64,
    pub head: String,
    pub difficulty: u128,
    pub work: String,
    pub tips: usize,
    pub blocks_total: usize,
    pub supply_ram: String,
    pub mempool: usize,
    pub peers: Vec<PeerView>,
    pub synced: bool,
    pub mining: bool,
    pub hashrate: u64,
    pub found: u64,
    pub netinfo: NetInfo,
    pub universe: UniverseInfo,
    pub consenso: ConsensoInfo,
    /// Alturas que sostienen (o no) el juicio `synced`.
    pub sync: SyncInfo,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct AccountView {
    pub balance: u64,
    pub staked: u64,
    pub nonce: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct BlockView {
    pub height: u64,
    pub hash: String,
    pub txs: usize,
    pub bits: u32,
    pub difficulty: u128,
    pub timestamp: u64,
}

/// Transacción resumida para el explorador (todo en hex/enteros, sin floats).
#[derive(Clone, Debug, Serialize)]
pub struct TxView {
    pub kind: String,
    pub txid: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub amount: Option<u64>,
    pub fee: u64,
    pub memo: Option<String>,
}

/// Bloque completo para el explorador del panel.
#[derive(Clone, Debug, Serialize)]
pub struct BlockDetail {
    pub height: u64,
    pub hash: String,
    pub prev_hash: String,
    pub merkle_root: String,
    pub timestamp: u64,
    pub bits: u32,
    pub difficulty: u128,
    pub nonce: u64,
    pub branch_tag: String,
    pub txs: Vec<TxView>,
}

fn tx_view(tx: &Tx) -> TxView {
    let id = hex::encode(txid(tx));
    match tx {
        Tx::Coinbase { to, reward, memo, .. } => TxView {
            kind: "coinbase".into(),
            txid: id,
            from: None,
            to: Some(hex::encode(to)),
            amount: Some(*reward),
            fee: 0,
            memo: String::from_utf8(memo.clone()).ok(),
        },
        Tx::Transfer { from, to, amount, fee, .. } => TxView {
            kind: "transfer".into(),
            txid: id,
            from: Some(hex::encode(from)),
            to: Some(hex::encode(to)),
            amount: Some(*amount),
            fee: *fee,
            memo: None,
        },
        Tx::Stake { who, amount, fee, .. } => TxView {
            kind: "stake".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*amount),
            fee: *fee,
            memo: None,
        },
        Tx::Unstake { who, amount, fee, .. } => TxView {
            kind: "unstake".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*amount),
            fee: *fee,
            memo: None,
        },
        Tx::Commit { by, fee, .. } => TxView {
            kind: "commit".into(),
            txid: id,
            from: Some(hex::encode(by)),
            to: None,
            amount: None,
            fee: *fee,
            memo: None,
        },
        Tx::Reveal { by, commit_txid, fee, .. } => TxView {
            kind: "reveal".into(),
            txid: id,
            from: Some(hex::encode(by)),
            to: Some(hex::encode(commit_txid)),
            amount: None,
            fee: *fee,
            memo: None,
        },
        Tx::ClaimParcel { who, x, y, name, fee, .. } => TxView {
            kind: "claim_parcel".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: None,
            fee: *fee,
            memo: Some(format!("({x},{y}) {}", String::from_utf8_lossy(name))),
        },
        Tx::MintAsset { who, x, y, meta, fee, .. } => TxView {
            kind: "mint_asset".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: None,
            fee: *fee,
            memo: Some(format!("({x},{y}) {}", String::from_utf8_lossy(meta))),
        },
        Tx::TransferAsset { from, asset, to, fee, .. } => TxView {
            kind: "transfer_asset".into(),
            txid: id,
            from: Some(hex::encode(from)),
            to: Some(hex::encode(to)),
            amount: None,
            fee: *fee,
            memo: Some(hex::encode(asset)),
        },
        Tx::ListLease { who, asset, price, term, fee, .. } => TxView {
            kind: "list_lease".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*price),
            fee: *fee,
            memo: Some(format!("{} por {term} bloques", hex::encode(asset))),
        },
        Tx::Rent { who, asset, fee, .. } => TxView {
            kind: "rent".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: None,
            fee: *fee,
            memo: Some(hex::encode(asset)),
        },
        Tx::Harvest { who, x, y, total, fee, .. } => TxView {
            kind: "harvest".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*total),
            fee: *fee,
            memo: Some(format!("cosecha en ({x},{y})")),
        },
        Tx::SellAsset { who, asset, price, fee, .. } => TxView {
            kind: "sell_asset".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*price),
            fee: *fee,
            memo: Some(hex::encode(asset)),
        },
        Tx::BuyAsset { who, asset, max_price, fee, .. } => TxView {
            kind: "buy_asset".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*max_price),
            fee: *fee,
            memo: Some(hex::encode(asset)),
        },
        Tx::SellParcel { who, x, y, price, fee, .. } => TxView {
            kind: "sell_parcel".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*price),
            fee: *fee,
            memo: Some(format!("parcela ({x},{y}) en venta")),
        },
        Tx::BuyParcel { who, x, y, max_price, fee, .. } => TxView {
            kind: "buy_parcel".into(),
            txid: id,
            from: Some(hex::encode(who)),
            to: None,
            amount: Some(*max_price),
            fee: *fee,
            memo: Some(format!("compra de la parcela ({x},{y})")),
        },
    }
}

// ------------------------- Ciudad RAMI (vistas) -------------------------

#[derive(Clone, Debug, Serialize)]
pub struct ParcelView {
    pub x: u16,
    pub y: u16,
    pub owner: String,
    pub name: String,
    pub kind: u8,
    pub since: u64,
    pub harvests: u64,
    pub last_harvest: Option<(u64, u64)>,
    pub assets: usize,
    /// Dubái: distrito, venta publicada y cuentas de la empresa.
    pub distrito: u8,
    pub sale: Option<u64>,
    pub ingresos: u64,
    pub ultimo_ingreso: u64,
    pub ultimo_bloque: u64,
    pub insumos_pagados: u64,
    pub importado: u64,
    pub ventas: u64,
}

/// Distrito para el panel (rectángulo de la cuadrícula y precio en unidades base).
#[derive(Clone, Debug, Serialize)]
pub struct DistritoView {
    pub id: u8,
    pub clave: String,
    pub nombre: String,
    pub precio: u64,
    pub actividad: u32,
    pub x0: u16,
    pub y0: u16,
    pub x1: u16,
    pub y1: u16,
}

fn distrito_view(d: &ciudad::Distrito) -> DistritoView {
    DistritoView {
        id: d.id,
        clave: d.clave.to_string(),
        nombre: d.nombre.to_string(),
        precio: d.precio_rami as u64 * COIN,
        actividad: d.actividad,
        x0: d.x0,
        y0: d.y0,
        x1: d.x1,
        y1: d.y1,
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SectorView {
    pub id: u8,
    pub clave: String,
    pub nombre: String,
    pub insumos: Vec<u8>,
    pub demanda: u32,
    /// Empresas de este sector en la ciudad.
    pub empresas: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct LeaseView {
    pub tenant: String,
    pub from: u64,
    pub until: u64,
    pub price: u64,
    pub active: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct AssetView {
    pub id: String,
    pub owner: String,
    pub x: u16,
    pub y: u16,
    pub kind: u8,
    pub meta: String,
    pub minted: u64,
    pub offer: Option<rami_core::state::Offer>,
    pub lease: Option<LeaseView>,
    /// Dubái: precio de venta publicado.
    pub sale: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct CityView {
    pub size: u16,
    pub height: u64,
    pub parcel_price: u64,
    pub mint_price: u64,
    pub parcels: Vec<ParcelView>,
    pub assets: Vec<AssetView>,
    /// Operaciones de la ciudad aún en el mempool (se aplican al minarse el
    /// próximo bloque): el panel las muestra como «pendientes».
    #[serde(default)]
    pub pending: Vec<PendingView>,
    // ---- Dubái ----
    /// Rigen ya las reglas de Dubái sobre la cabeza.
    pub dubai: bool,
    /// Fecha de activación (Unix) si esta red la tiene, y segundos que faltan (0 si rige).
    pub dubai_desde: Option<u64>,
    pub dubai_faltan_segundos: u64,
    /// Fondo de la ciudad, lo que reparte el próximo bloque, lo que entra por
    /// bloque (parte de la emisión) y lo quemado en total.
    pub fund: u64,
    pub pago_bloque: u64,
    pub parte_ciudad_bloque: u64,
    pub emision_bloque: u64,
    pub quemado: u64,
    pub districts: Vec<DistritoView>,
    pub sectors: Vec<SectorView>,
    /// Sectores que la ciudad importa (nadie los ofrece) y cuántas empresas los necesitan.
    pub huecos: Vec<(u8, usize)>,
    /// Últimas operaciones del mercado (parcelas y activos).
    pub trades: Vec<ciudad::Trade>,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct PendingView {
    pub op: String,
    pub who: String,
    pub x: u16,
    pub y: u16,
    pub name: String,
    pub kind: u8,
    pub asset: String,
    pub txid: String,
    /// Precio (venta/compra) de la operación pendiente, si lo tiene.
    #[serde(default)]
    pub price: u64,
}

fn city_view(st: &State, height: u64, firma: &FirmaCtx, dubai_desde: Option<u64>, ahora: u64) -> CityView {
    let assets: Vec<AssetView> = st
        .assets
        .iter()
        .map(|(id, a)| AssetView {
            id: hex::encode(id),
            owner: hex::encode(a.owner),
            x: a.x,
            y: a.y,
            kind: a.kind,
            meta: a.meta.clone(),
            minted: a.minted,
            offer: a.offer.clone(),
            lease: a.lease.as_ref().map(|l| LeaseView {
                tenant: hex::encode(l.tenant),
                from: l.from,
                until: l.until,
                price: l.price,
                active: height <= l.until,
            }),
            sale: a.sale,
        })
        .collect();
    let parcels = st
        .parcels
        .iter()
        .map(|((x, y), p)| ParcelView {
            x: *x,
            y: *y,
            owner: hex::encode(p.owner),
            name: p.name.clone(),
            kind: p.kind,
            since: p.since,
            harvests: p.harvests,
            last_harvest: p.last_harvest,
            assets: st.assets.values().filter(|a| a.x == *x && a.y == *y).count(),
            distrito: ciudad::distrito(*x, *y).id,
            sale: p.sale,
            ingresos: p.ingresos,
            ultimo_ingreso: p.ultimo_ingreso,
            ultimo_bloque: p.ultimo_bloque,
            insumos_pagados: p.insumos_pagados,
            importado: p.importado,
            ventas: p.ventas,
        })
        .collect();
    let emision = block_reward(height + 1);
    let sectors = ciudad::SECTORES
        .iter()
        .map(|sc| SectorView {
            id: sc.id,
            clave: sc.clave.to_string(),
            nombre: sc.nombre.to_string(),
            insumos: sc.insumos.to_vec(),
            demanda: sc.demanda,
            empresas: st.parcels.values().filter(|p| p.kind == sc.id).count(),
        })
        .collect();
    CityView {
        size: firma.city_size(),
        height,
        parcel_price: rami_core::state::PARCEL_PRICE,
        mint_price: rami_core::state::MINT_PRICE,
        parcels,
        assets,
        pending: Vec::new(),
        dubai: firma.dubai,
        dubai_desde,
        dubai_faltan_segundos: if firma.dubai { 0 } else { dubai_desde.map(|d| d.saturating_sub(ahora)).unwrap_or(0) },
        fund: st.city_fund,
        pago_bloque: ciudad::pago_del_bloque(st.city_fund),
        parte_ciudad_bloque: if firma.dubai { ciudad::parte_ciudad(emision) } else { 0 },
        emision_bloque: emision,
        quemado: st.quemado,
        districts: ciudad::distritos().iter().map(distrito_view).collect(),
        sectors,
        huecos: ciudad::huecos(st),
        trades: st.trades.iter().cloned().collect(),
    }
}

// ------------------------- Dubái: mentor y mercado -------------------------

/// Lo que el mentor (una regla, no una persona) dice de una parcela: el
/// distrito, lo que cuesta, lo que el reparto haría hoy con cada sector, y los
/// huecos de la ciudad. Cifras del estado actual, no una promesa.
#[derive(Clone, Debug, Serialize, Default)]
pub struct MentorView {
    pub x: u16,
    pub y: u16,
    pub dubai: bool,
    pub distrito: Option<DistritoView>,
    pub precio_parcela: u64,
    /// ¿La parcela es del monedero? ¿Es de otro?
    pub mia: bool,
    pub de_otro: bool,
    pub pago_referencia: u64,
    pub oportunidades: Vec<ciudad::Evaluacion>,
    pub huecos: Vec<(u8, usize)>,
    pub empresas: usize,
}

fn mentor_view(st: &State, height: u64, firma: &FirmaCtx, x: u16, y: u16, me: Option<AccountId>) -> MentorView {
    let dist = ciudad::distrito(x, y);
    let emision = block_reward(height + 1);
    let (mia, de_otro) = match st.parcels.get(&(x, y)) {
        Some(p) => (me == Some(p.owner), me != Some(p.owner)),
        None => (false, false),
    };
    MentorView {
        x,
        y,
        dubai: firma.dubai,
        distrito: Some(distrito_view(&dist)),
        precio_parcela: ciudad::precio_parcela(x, y),
        mia,
        de_otro,
        pago_referencia: ciudad::pago_de_referencia(st, emision),
        oportunidades: if firma.dubai { ciudad::oportunidades(st, x, y, me.as_ref(), emision) } else { Vec::new() },
        huecos: ciudad::huecos(st),
        empresas: st.parcels.len(),
    }
}

/// Un «par» del mercado de la ciudad: parcelas de un distrito o activos de un
/// tipo, cotizados en RAMI. Formato pensado para que un agregador lo lea
/// (identificador, base, destino, último precio, mejor oferta, volumen).
#[derive(Clone, Debug, Serialize, Default)]
pub struct TickerView {
    pub ticker_id: String,
    pub base: String,
    pub target: String,
    /// Último precio cerrado (unidades base) y altura del bloque.
    pub last_price: Option<u64>,
    pub last_height: Option<u64>,
    /// Precio de referencia del protocolo: lo que cuesta una parcela libre del
    /// distrito (se quema) o acuñar el activo.
    pub base_price: u64,
    pub asks: usize,
    pub low_ask: Option<u64>,
    /// Suma de precios cerrados y número de operaciones en los últimos 1440
    /// bloques (≈ 24 h a 60 s/bloque).
    pub volume_1440: u64,
    pub trades_1440: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct OrderView {
    pub ticker_id: String,
    /// "parcel" o "asset".
    pub kind: String,
    pub x: u16,
    pub y: u16,
    pub asset: String,
    pub sector: u8,
    pub distrito: u8,
    pub price: u64,
    pub owner: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct TradeView {
    pub ticker_id: String,
    pub height: u64,
    pub kind: String,
    pub x: u16,
    pub y: u16,
    pub sector: u8,
    pub distrito: u8,
    pub price: u64,
}

/// Hechos agregados del mercado (el «índice»): no es una cotización externa,
/// es lo que la cadena registra en RAMI de prueba.
#[derive(Clone, Debug, Serialize, Default)]
pub struct IndexView {
    pub empresas: usize,
    pub activos: usize,
    pub parcelas_en_venta: usize,
    pub activos_en_venta: usize,
    pub operaciones: usize,
    /// Media y último precio de las parcelas vendidas (unidades base).
    pub precio_medio_parcela: Option<u64>,
    pub ultimo_precio_parcela: Option<u64>,
    /// Capital quemado por la ciudad (precios de parcela/acuñado e importaciones).
    pub quemado: u64,
    pub fondo: u64,
    pub pago_bloque: u64,
    pub parte_ciudad_bloque: u64,
    /// Superficie de una celda (m²) y m² que compra 1 RAMI en el distrito más
    /// caro y en el más barato (precio de parcela libre).
    pub m2_por_celda: u64,
    pub m2_por_rami_max: u64,
    pub m2_por_rami_min: u64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct MarketView {
    pub network: String,
    pub network_id: String,
    pub height: u64,
    pub dubai: bool,
    pub tickers: Vec<TickerView>,
    pub orders: Vec<OrderView>,
    pub trades: Vec<TradeView>,
    pub index: IndexView,
}

fn ticker_parcela(distrito: u8) -> String {
    let clave = ciudad::distritos().get(distrito as usize).map(|d| d.clave.to_uppercase()).unwrap_or_else(|| "X".into());
    format!("PARCELA-{clave}_RAMI")
}
fn ticker_activo(kind: u8) -> String {
    let n = match kind {
        0 => "PLANTA",
        1 => "OBJETO",
        2 => "VEHICULO",
        _ => "LOCAL",
    };
    format!("ACTIVO-{n}_RAMI")
}

fn market_view(st: &State, height: u64, firma: &FirmaCtx, network: &str, network_id: &str) -> MarketView {
    let mut tickers: BTreeMap<String, TickerView> = BTreeMap::new();
    for d in ciudad::distritos() {
        let id = ticker_parcela(d.id);
        tickers.insert(
            id.clone(),
            TickerView { ticker_id: id, base: format!("PARCELA-{}", d.clave.to_uppercase()), target: "RAMI".into(), base_price: d.precio_rami as u64 * COIN, ..Default::default() },
        );
    }
    for k in 0..=3u8 {
        let id = ticker_activo(k);
        tickers.insert(id.clone(), TickerView { ticker_id: id, base: ticker_activo(k).trim_end_matches("_RAMI").to_string(), target: "RAMI".into(), base_price: ciudad::precio_acunado(k), ..Default::default() });
    }
    let mut orders = Vec::new();
    for ((x, y), p) in st.parcels.iter() {
        if let Some(price) = p.sale {
            let d = ciudad::distrito(*x, *y);
            let id = ticker_parcela(d.id);
            if let Some(t) = tickers.get_mut(&id) {
                t.asks += 1;
                t.low_ask = Some(t.low_ask.map_or(price, |l| l.min(price)));
            }
            orders.push(OrderView { ticker_id: id, kind: "parcel".into(), x: *x, y: *y, asset: String::new(), sector: p.kind, distrito: d.id, price, owner: hex::encode(p.owner), name: p.name.clone() });
        }
    }
    for (aid, a) in st.assets.iter() {
        if let Some(price) = a.sale {
            if a.leased_at(height) {
                continue;
            }
            let id = ticker_activo(a.kind);
            if let Some(t) = tickers.get_mut(&id) {
                t.asks += 1;
                t.low_ask = Some(t.low_ask.map_or(price, |l| l.min(price)));
            }
            orders.push(OrderView { ticker_id: id, kind: "asset".into(), x: a.x, y: a.y, asset: hex::encode(aid), sector: a.kind, distrito: ciudad::distrito(a.x, a.y).id, price, owner: hex::encode(a.owner), name: a.meta.clone() });
        }
    }
    orders.sort_by(|a, b| a.price.cmp(&b.price).then(a.ticker_id.cmp(&b.ticker_id)));
    let mut trades = Vec::new();
    let mut suma_parcelas: u128 = 0;
    let mut n_parcelas = 0usize;
    let mut ultimo_parcela = None;
    for t in st.trades.iter() {
        let id = if t.kind == 0 { ticker_parcela(t.distrito) } else { ticker_activo(t.sector) };
        if let Some(tk) = tickers.get_mut(&id) {
            tk.last_price = Some(t.price);
            tk.last_height = Some(t.height);
            if height.saturating_sub(t.height) <= 1440 {
                tk.volume_1440 += t.price;
                tk.trades_1440 += 1;
            }
        }
        if t.kind == 0 {
            suma_parcelas += t.price as u128;
            n_parcelas += 1;
            ultimo_parcela = Some(t.price);
        }
        trades.push(TradeView { ticker_id: id, height: t.height, kind: if t.kind == 0 { "parcel".into() } else { "asset".into() }, x: t.x, y: t.y, sector: t.sector, distrito: t.distrito, price: t.price });
    }
    let m2 = 650u64 * 650;
    let precios: Vec<u64> = ciudad::distritos().iter().map(|d| d.precio_rami as u64).collect();
    let pmax = precios.iter().copied().max().unwrap_or(1).max(1);
    let pmin = precios.iter().copied().min().unwrap_or(1).max(1);
    let emision = block_reward(height + 1);
    MarketView {
        network: network.to_string(),
        network_id: network_id.to_string(),
        height,
        dubai: firma.dubai,
        tickers: tickers.into_values().collect(),
        trades,
        index: IndexView {
            empresas: st.parcels.len(),
            activos: st.assets.len(),
            parcelas_en_venta: orders.iter().filter(|o| o.kind == "parcel").count(),
            activos_en_venta: orders.iter().filter(|o| o.kind == "asset").count(),
            operaciones: st.trades.len(),
            precio_medio_parcela: if n_parcelas == 0 { None } else { Some((suma_parcelas / n_parcelas as u128) as u64) },
            ultimo_precio_parcela: ultimo_parcela,
            quemado: st.quemado,
            fondo: st.city_fund,
            pago_bloque: ciudad::pago_del_bloque(st.city_fund),
            parte_ciudad_bloque: if firma.dubai { ciudad::parte_ciudad(emision) } else { 0 },
            m2_por_celda: m2,
            m2_por_rami_max: m2 / pmin,
            m2_por_rami_min: m2 / pmax,
        },
        orders,
    }
}

// ------------------------- Dubái: presencia y chat (efímeros) -------------------------

/// Lo que el panel manda del avatar local (metros locales de la cuadrícula).
#[derive(Clone, Debug, Default, serde::Deserialize, Serialize)]
pub struct PresenceLocal {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub yaw: i32,
    pub avatar: u8,
}

/// Un avatar visto en la red (o el propio), tal como lo lee el panel.
#[derive(Clone, Debug, Serialize)]
pub struct AvatarView {
    pub pk: String,
    pub fingerprint: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub yaw: i32,
    pub avatar: u8,
    /// Segundos desde la última señal y marca de tiempo que declaró el emisor.
    pub age: u64,
    pub ts: u64,
    pub me: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChatView {
    pub pk: String,
    pub fingerprint: String,
    pub name: String,
    pub text: String,
    pub ts: u64,
    pub me: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct PresenceView {
    pub me: Option<AvatarView>,
    pub avatars: Vec<AvatarView>,
    pub chat: Vec<ChatView>,
    pub fingerprint: String,
}

struct PresenceEntry {
    seq: u64,
    ts: u64,
    name: String,
    x: i32,
    y: i32,
    z: i32,
    yaw: i32,
    avatar: u8,
    seen: Instant,
}

struct ChatEntry {
    pk: [u8; 32],
    name: String,
    text: String,
    ts: u64,
}

fn presence_msg(pk: &[u8; 32], seq: u64, ts: u64, name: &str, x: i32, y: i32, z: i32, yaw: i32, avatar: u8) -> Vec<u8> {
    let mut m = b"RAMI-CITY/presence/v1".to_vec();
    m.extend_from_slice(pk);
    m.extend_from_slice(&seq.to_le_bytes());
    m.extend_from_slice(&ts.to_le_bytes());
    m.push(name.len() as u8);
    m.extend_from_slice(name.as_bytes());
    for v in [x, y, z, yaw] {
        m.extend_from_slice(&v.to_le_bytes());
    }
    m.push(avatar);
    m
}

fn chat_msg(pk: &[u8; 32], seq: u64, ts: u64, name: &str, text: &str) -> Vec<u8> {
    let mut m = b"RAMI-CITY/chat/v1".to_vec();
    m.extend_from_slice(pk);
    m.extend_from_slice(&seq.to_le_bytes());
    m.extend_from_slice(&ts.to_le_bytes());
    m.push(name.len() as u8);
    m.extend_from_slice(name.as_bytes());
    m.extend_from_slice(&(text.len() as u16).to_le_bytes());
    m.extend_from_slice(text.as_bytes());
    m
}

/// Nombre visible saneado: sin saltos ni control, acotado en bytes UTF-8.
pub fn sane_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > PRESENCE_NAME_MAX {
            break;
        }
        out.push(c);
    }
    let t = out.trim().to_string();
    if t.is_empty() { "visitante".into() } else { t }
}

fn sane_text(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().filter(|c| !c.is_control() || *c == ' ') {
        if out.len() + c.len_utf8() > CHAT_TEXT_MAX {
            break;
        }
        out.push(c);
    }
    out.trim().to_string()
}

fn parse_pk_sig(pk: &str, sig: &str) -> Option<([u8; 32], [u8; 64])> {
    let pk: [u8; 32] = hex::decode(pk).ok()?.try_into().ok()?;
    let sig: [u8; 64] = hex::decode(sig).ok()?.try_into().ok()?;
    Some((pk, sig))
}

#[derive(Clone)]
struct MiningJob {
    header: BlockHeader,
    txs: Vec<Tx>,
}

struct MiningShared {
    on: AtomicBool,
    epoch: AtomicU64,
    hashrate: AtomicU64,
    found: AtomicU64,
    job: Mutex<Option<MiningJob>>,
}

enum NodeMsg {
    Net(NetEvent),
    Mined(Block),
    Tick,
    Cmd(NodeCmd),
}

enum NodeCmd {
    SubmitTx(Box<Tx>, Sender<Result<String, String>>),
    SetMining(bool),
    SetMiner(AccountId),
    AddPeer(String),
    GetAccount(AccountId, Sender<AccountView>),
    NextNonce(AccountId, Sender<u64>),
    RecentBlocks(usize, Sender<Vec<BlockView>>),
    GetBlock(u64, Sender<Option<BlockDetail>>),
    GetCity(Sender<CityView>),
    /// Contexto de firma que rige ahora sobre la cabeza (para las carteras).
    Firma(Sender<FirmaCtx>),
    /// Dubái: consejo del mentor para (x, y) visto por `me`.
    GetMentor(u16, u16, Option<AccountId>, Sender<MentorView>),
    /// Dubái: mercado (pares, órdenes, operaciones, índice).
    GetMarket(Sender<MarketView>),
    /// Metaverso: mi avatar (se firma y se difunde), lo que veo, y chat.
    SetPresence(Box<PresenceLocal>),
    GetPresence(Sender<PresenceView>),
    SendChat(String, String, Sender<Result<(), String>>),
}

/// Manejador del nodo para la CLI y el monedero de escritorio.
#[derive(Clone)]
pub struct NodeHandle {
    tx: Sender<NodeMsg>,
    status: Arc<Mutex<NodeStatus>>,
}

impl NodeHandle {
    pub fn status(&self) -> NodeStatus {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }
    /// Contexto de firma que rige AHORA sobre la cabeza del nodo: con él
    /// firman las carteras para que el nodo admita la tx y el próximo bloque
    /// la incluya. Si el nodo no responde, la regla v1 (la de siempre).
    pub fn firma(&self) -> FirmaCtx {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::Firma(r))).is_err() {
            return FirmaCtx::v1();
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_else(|_| FirmaCtx::v1())
    }
    pub fn set_mining(&self, on: bool) {
        let _ = self.tx.send(NodeMsg::Cmd(NodeCmd::SetMining(on)));
    }
    pub fn set_miner(&self, a: AccountId) {
        let _ = self.tx.send(NodeMsg::Cmd(NodeCmd::SetMiner(a)));
    }
    pub fn add_peer(&self, addr: String) {
        let _ = self.tx.send(NodeMsg::Cmd(NodeCmd::AddPeer(addr)));
    }
    pub fn submit_tx(&self, tx: Tx) -> Result<String, String> {
        let (r, rx) = channel();
        self.tx
            .send(NodeMsg::Cmd(NodeCmd::SubmitTx(Box::new(tx), r)))
            .map_err(|_| "nodo caído".to_string())?;
        // Con timeout: un nodo muy ocupado no debe congelar el panel para
        // siempre (la petición sigue encolada y se procesará igualmente).
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "el nodo está ocupado; reintenta en unos segundos".to_string())?
    }
    pub fn account(&self, a: AccountId) -> AccountView {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::GetAccount(a, r))).is_err() {
            return AccountView::default();
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
    }
    /// Siguiente nonce utilizable = nonce en cadena + tx pendientes de ese firmante.
    pub fn next_nonce(&self, a: AccountId) -> u64 {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::NextNonce(a, r))).is_err() {
            return 0;
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or(0)
    }
    pub fn recent_blocks(&self, n: usize) -> Vec<BlockView> {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::RecentBlocks(n, r))).is_err() {
            return Vec::new();
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
    }
    /// Estado de la ciudad RAMI (parcelas y activos) en la punta del observador.
    pub fn city(&self) -> CityView {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::GetCity(r))).is_err() {
            return CityView::default();
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
    }
    /// Detalle de un bloque de la cadena del observador, por altura.
    pub fn block(&self, height: u64) -> Option<BlockDetail> {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::GetBlock(height, r))).is_err() {
            return None;
        }
        rx.recv_timeout(Duration::from_secs(3)).ok().flatten()
    }
    /// Dubái: el mentor sobre la parcela (x, y) para el monedero `me`.
    pub fn mentor(&self, x: u16, y: u16, me: Option<AccountId>) -> MentorView {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::GetMentor(x, y, me, r))).is_err() {
            return MentorView::default();
        }
        rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default()
    }
    /// Dubái: el mercado de la ciudad en la punta del observador.
    pub fn market(&self) -> MarketView {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::GetMarket(r))).is_err() {
            return MarketView::default();
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
    }
    /// Metaverso: publica la posición del avatar local (firmada y difundida).
    pub fn set_presence(&self, p: PresenceLocal) {
        let _ = self.tx.send(NodeMsg::Cmd(NodeCmd::SetPresence(Box::new(p))));
    }
    /// Metaverso: avatares vistos y chat reciente.
    pub fn presence(&self) -> PresenceView {
        let (r, rx) = channel();
        if self.tx.send(NodeMsg::Cmd(NodeCmd::GetPresence(r))).is_err() {
            return PresenceView::default();
        }
        rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default()
    }
    /// Metaverso: envía un mensaje de chat (firmado con la identidad del nodo).
    pub fn chat(&self, name: String, text: String) -> Result<(), String> {
        let (r, rx) = channel();
        self.tx.send(NodeMsg::Cmd(NodeCmd::SendChat(name, text, r))).map_err(|_| "nodo caído".to_string())?;
        rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "el nodo está ocupado".to_string())?
    }
}

/// Puntas anunciadas por un par (`Tips`), ordenadas por trabajo descendente:
/// las que nos falten se piden con `GetBranch`, las más pesadas primero.
#[derive(Default)]
struct PeerTips {
    /// (hash, altura, trabajo acumulado)
    tips: Vec<(Hash, u64, u128)>,
}

impl PeerTips {
    fn normalize(&mut self) {
        self.tips.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        self.tips.dedup_by(|a, b| a.0 == b.0);
        self.tips.truncate(PEER_TIPS_CAP);
    }
    /// Olvida las puntas anunciadas que ya son bloques INTERIORES de nuestro
    /// árbol: los anuncios delta (`partial`) solo traen puntas nuevas, así que
    /// la punta anterior de una rama que creció quedaría registrada para
    /// siempre (hasta el latido completo). Si tenemos el bloque y ya tiene
    /// hijos, no hay nada que pedir por él.
    fn forget_interior(&mut self, tree: &rami_core::blocktree::BlockTree, my_tips: &HashSet<Hash>) {
        self.tips.retain(|t| !tree.contains(&t.0) || my_tips.contains(&t.0));
    }
    fn best_work(&self) -> u128 {
        self.tips.first().map(|t| t.2).unwrap_or(0)
    }
    fn best_height(&self) -> u64 {
        self.tips.iter().map(|t| t.1).max().unwrap_or(0)
    }
}

/// Qué se apunta de un par al juzgar lo que envió (ver `grado`).
#[derive(Clone, Copy)]
enum Anota {
    Valido,
    Invalido,
    Huerfano,
    Rama,
}

/// Una petición `GetBranch` a un par por una punta.
struct BranchReq {
    /// Último envío (ventana anti-spam y «activa» para el tope en vuelo).
    sent: Instant,
    /// Rondas sin progreso (cota `BRANCH_MAX_ROUNDS`).
    rounds: u32,
    /// Cursor de la última continuación (último bloque del lote anterior que ya
    /// teníamos): si el par repite el mismo lote, no cuenta como progreso.
    cursor: Option<Hash>,
}

struct Node {
    tree: rami_core::blocktree::BlockTree,
    chain: ChainDir,
    is_testnet: bool,
    network_id: Hash,
    mempool: Vec<Tx>,
    seen_tx: HashSet<TxId>,
    /// Bloques que NO se admitieron por inválidos (no por huérfanos): un par
    /// que los repita no nos hace revalidarlos. Acotado.
    bad_blocks: HashSet<Hash>,
    /// Fuentes graduadas: historial por clave pública (peer-grades.json) y
    /// evidencia de esta sesión por conexión. Descriptivo, nunca de consenso.
    grados: HashMap<String, HistorialPar>,
    sesion: HashMap<PeerId, EvidenciaSesion>,
    grados_sucio: bool,
    grados_guardado: Instant,
    last_sync_fuente: String,
    peer_height: HashMap<rami_net::PeerId, u64>,
    /// Regla de firma anunciada por cada par (`Status.rule`; 0 = no anuncia).
    peer_rule: HashMap<rami_net::PeerId, u32>,
    /// Universo de ramas: puntas anunciadas por cada par.
    peer_tips: HashMap<PeerId, PeerTips>,
    /// Peticiones `GetBranch` por par y punta (rondas, ventana, cursor). Se
    /// limpia al desconectar el par.
    inflight: HashMap<PeerId, HashMap<Hash, BranchReq>>,
    /// (par, punta) que agotaron las rondas, por par: al llegar a
    /// `PEER_STRIKES_MAX` el par se expulsa (no se castiga a la punta).
    strikes: HashMap<PeerId, u32>,
    /// `GetBranch` atendidas por par en la ventana actual: (inicio, cuenta).
    served: HashMap<PeerId, (Instant, u32)>,
    /// Localizador cacheado por tamaño del árbol (solo cambia si entra un
    /// bloque): calcularlo es O(altura), y un `Tips` no debe costar 256 veces eso.
    locator_cache: Option<(usize, Vec<Hash>)>,
    /// Último conjunto de puntas anunciado (por trabajo) y cuándo se envió el
    /// conjunto completo por última vez (latido).
    last_tips_sent: Vec<Hash>,
    last_tips_at: Instant,
    /// Lotes `Branch` aplicados y de quién llegó el último.
    branches_synced: u64,
    last_sync_from: String,
    /// peer -> (addr del socket, entrante, dirección REMARCABLE si el par escucha)
    peer_meta: HashMap<rami_net::PeerId, (String, bool, Option<String>)>,
    /// peer -> (clave pública hex, huella) autenticadas en el handshake.
    peer_ident: HashMap<rami_net::PeerId, (String, String)>,
    /// Identidades fijadas por dirección (TOFU); known-identities.json.
    known_identities: HashMap<String, String>,
    /// Pares conocidos remarcables; se persisten en peers.json del directorio de
    /// cadena y se re-marcan al arrancar (descubrimiento sin servidor central).
    known_peers: HashSet<String>,
    netinfo: Arc<Mutex<NetInfo>>,
    net: Network,
    mining: Arc<MiningShared>,
    miner: Option<AccountId>,
    mining_on: bool,
    last_candidate_ts: u64,
    status: Arc<Mutex<NodeStatus>>,
    /// Identidad del nodo (la del Túnel RAMI): firma presencia y chat.
    identity: NodeIdentity,
    /// Metaverso: avatares vistos (por clave pública), ritmo por identidad,
    /// chat reciente y el avatar propio. Efímero: nada se persiste.
    presence: HashMap<[u8; 32], PresenceEntry>,
    presence_last: HashMap<[u8; 32], Instant>,
    chat: VecDeque<ChatEntry>,
    chat_last: HashMap<[u8; 32], Instant>,
    my_presence: Option<PresenceLocal>,
    my_presence_at: Option<Instant>,
    my_seq: u64,
}

/// Arranca un nodo completo. Auto-inicializa la cadena si no existe.
pub fn spawn(cfg: NodeConfig) -> Result<NodeHandle, String> {
    let chain = ChainDir::new(&cfg.chain_dir);
    if !chain.exists() {
        let genesis = make_genesis(cfg.is_testnet, cfg.params, cfg.miner.unwrap_or([0u8; 32]));
        chain.init(&genesis)?;
    }
    let tree = chain.load_tree(cfg.params)?;
    let genesis_hash = tree.chain_to(&tree.head()).first().copied().ok_or("cadena vacía")?;

    // Identidad del nodo (Túnel RAMI): clave Ed25519 con prueba de trabajo en
    // <chain_dir>/node.key. La primera vez se crea (≈ un segundo de PoW).
    let identity = rami_net::identity::load_or_create(&chain.root.join("node.key"))?;
    let identity_local = identity.clone();
    let (net, net_rx) = Network::start(NetConfig {
        network_id: genesis_hash,
        identity,
        listen: cfg.listen,
        seeds: cfg.seeds.clone(),
        max_peers: 32,
        lan_discovery: cfg.lan_discovery,
    });

    // Diagnóstico de red + apertura del puerto en el router (en segundo
    // plano: SSDP/NAT-PMP tardan unos segundos; se renueva cada hora).
    let netinfo = Arc::new(Mutex::new(NetInfo {
        portmap_enabled: cfg.portmap,
        lan_discovery: cfg.lan_discovery,
        ..Default::default()
    }));
    {
        let ni = netinfo.clone();
        let port = net.listen_port;
        let do_map = cfg.portmap && port != 0;
        thread::spawn(move || loop {
            let lan = portmap::lan_ip().map(|ip| ip.to_string());
            let res = if do_map { portmap::map_port(port) } else { portmap::MapResult::default() };
            if let Ok(mut g) = ni.lock() {
                g.lan_ip = lan.clone();
                g.external_ip = res.external_ip.clone();
                g.portmap_ok = res.ok;
                g.portmap_method = res.method.clone();
                g.portmap_detail = res.detail.clone();
                g.code_lan = lan.as_ref().map(|l| format!("{l}:{port}")).unwrap_or_default();
                g.code = match (&res.external_ip, res.ok) {
                    (Some(ext), true) => format!("{ext}:{port}"),
                    _ => g.code_lan.clone(),
                };
            }
            thread::sleep(Duration::from_secs(3600));
        });
    }

    let (tx, rx) = channel::<NodeMsg>();
    let status = Arc::new(Mutex::new(NodeStatus::default()));
    let mining = Arc::new(MiningShared {
        on: AtomicBool::new(false),
        epoch: AtomicU64::new(0),
        hashrate: AtomicU64::new(0),
        found: AtomicU64::new(0),
        job: Mutex::new(None),
    });

    // Puente: eventos de red -> mensajes del nodo.
    {
        let tx = tx.clone();
        thread::spawn(move || {
            for ev in net_rx {
                if tx.send(NodeMsg::Net(ev)).is_err() {
                    break;
                }
            }
        });
    }
    // Minero.
    {
        let shared = mining.clone();
        let tx = tx.clone();
        thread::spawn(move || miner_loop(shared, tx));
    }
    // Reloj de mantenimiento (~2 s): sincroniza y refresca métricas.
    {
        let tx = tx.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(2));
            if tx.send(NodeMsg::Tick).is_err() {
                break;
            }
        });
    }

    let grados_cargados = crate::grado::cargar(&chain.root);
    let mut node = Node {
        tree,
        chain,
        is_testnet: cfg.is_testnet,
        network_id: genesis_hash,
        mempool: Vec::new(),
        seen_tx: HashSet::new(),
        bad_blocks: HashSet::new(),
        grados: grados_cargados,
        sesion: HashMap::new(),
        grados_sucio: false,
        // Restado un minuto: el PRIMER cambio se guarda al instante y a partir
        // de ahí, como mucho cada 30 s.
        grados_guardado: Instant::now().checked_sub(Duration::from_secs(60)).unwrap_or_else(Instant::now),
        last_sync_fuente: String::new(),
        peer_height: HashMap::new(),
        peer_rule: HashMap::new(),
        peer_tips: HashMap::new(),
        inflight: HashMap::new(),
        strikes: HashMap::new(),
        served: HashMap::new(),
        locator_cache: None,
        last_tips_sent: Vec::new(),
        last_tips_at: Instant::now(),
        branches_synced: 0,
        last_sync_from: String::new(),
        peer_meta: HashMap::new(),
        peer_ident: HashMap::new(),
        known_identities: HashMap::new(),
        known_peers: HashSet::new(),
        netinfo: netinfo.clone(),
        net,
        mining: mining.clone(),
        miner: cfg.miner,
        mining_on: cfg.mining && cfg.miner.is_some(),
        last_candidate_ts: 0,
        status: status.clone(),
        identity: identity_local,
        presence: HashMap::new(),
        presence_last: HashMap::new(),
        chat: VecDeque::new(),
        chat_last: HashMap::new(),
        my_presence: None,
        my_presence_at: None,
        my_seq: 0,
    };
    // Carga el mempool persistido.
    node.mempool = node.chain.load_mempool();
    for t in &node.mempool {
        node.seen_tx.insert(txid(t));
    }
    // Descubrimiento: re-marca los pares conocidos de sesiones anteriores
    // (peers.json), además de los seeds pasados por configuración.
    node.known_peers = load_known_peers(&node.chain.root);
    node.known_identities = load_known_identities(&node.chain.root);
    for a in node.known_peers.clone() {
        node.net.dial(a);
    }
    node.refresh_candidate();
    node.publish_status();

    let handle = NodeHandle { tx: tx.clone(), status };
    thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            node.handle(msg);
        }
    });
    Ok(handle)
}

impl Node {
    fn head_height(&self) -> u64 {
        self.tree.get(&self.tree.head()).map(|n| n.block.header.height).unwrap_or(0)
    }

    fn handle(&mut self, msg: NodeMsg) {
        match msg {
            NodeMsg::Net(ev) => self.on_net(ev),
            NodeMsg::Mined(block) => self.on_mined(block),
            NodeMsg::Tick => self.on_tick(),
            NodeMsg::Cmd(cmd) => self.on_cmd(cmd),
        }
    }

    /// Contexto de firma que rige para un instante en esta red.
    fn firma_ctx(&self, ts: u64) -> FirmaCtx {
        self.tree.firma_ctx(ts)
    }

    fn my_status_frame(&self) -> Frame {
        let head = self.tree.head();
        Frame::Status {
            height: self.head_height(),
            best: hex::encode(head),
            work: self.tree.get(&head).map(|n| n.cum_work).unwrap_or(0).to_string(),
            rule: REGLA_SOPORTADA,
        }
    }

    /// Puntas que anunciamos: las `PEER_TIPS_CAP` más pesadas, la cabeza
    /// primero (así la cabeza SIEMPRE viaja aunque el universo sea frondoso).
    fn announced_tips(&self) -> Vec<Hash> {
        self.tree.tips_by_work().into_iter().take(PEER_TIPS_CAP).map(|(h, _)| h).collect()
    }

    fn tips_frame(&self, hashes: &[Hash], partial: bool) -> Frame {
        let tips: Vec<TipInfo> = hashes
            .iter()
            .filter_map(|h| {
                self.tree.get(h).map(|n| TipInfo {
                    hash: hex::encode(h),
                    height: n.block.header.height,
                    work: n.cum_work.to_string(),
                })
            })
            .collect();
        Frame::Tips { tips, partial }
    }

    /// Anuncio COMPLETO de nuestras puntas (al conectar y como latido).
    fn my_tips_frame(&self) -> Frame {
        self.tips_frame(&self.announced_tips(), false)
    }

    /// Reanuncia puntas: el conjunto completo si venció el latido
    /// `TIPS_HEARTBEAT` o si `force`; si no, solo las puntas NUEVAS desde el
    /// último anuncio (delta), y nada si no hay ninguna.
    fn maybe_broadcast_tips(&mut self, force: bool) {
        let cur = self.announced_tips();
        if force || self.last_tips_at.elapsed() >= TIPS_HEARTBEAT {
            self.net.broadcast(self.tips_frame(&cur, false));
            self.last_tips_sent = cur;
            self.last_tips_at = Instant::now();
            return;
        }
        let last: HashSet<Hash> = self.last_tips_sent.iter().copied().collect();
        let fresh: Vec<Hash> = cur.iter().filter(|h| !last.contains(*h)).copied().collect();
        if !fresh.is_empty() {
            self.net.broadcast(self.tips_frame(&fresh, true));
        }
        self.last_tips_sent = cur;
    }

    /// Etiqueta legible de un par (dirección remarcable o del socket).
    /// Historial persistente del par (por clave pública autenticada).
    fn historial_de(&mut self, peer: PeerId) -> &mut HistorialPar {
        let pk = self.peer_ident.get(&peer).map(|(p, _)| p.clone()).unwrap_or_default();
        self.grados.entry(pk).or_default()
    }

    /// Apunta una observación verificada por este nodo en el historial (letra)
    /// y en la sesión (número). Nunca decide nada: describe.
    fn anotar(&mut self, peer: PeerId, que: Anota) {
        {
            let h = self.historial_de(peer);
            match que {
                Anota::Valido => h.validos += 1,
                Anota::Invalido => h.invalidos += 1,
                Anota::Huerfano => h.huerfanos += 1,
                Anota::Rama => h.ramas += 1,
            }
            h.visto = now_secs();
        }
        if let Some(e) = self.sesion.get_mut(&peer) {
            match que {
                Anota::Valido => e.validos += 1,
                Anota::Invalido => e.invalidos += 1,
                _ => {}
            }
        }
        self.grados_sucio = true;
        self.guardar_grados(false);
    }

    /// Persiste peer-grades.json si hay cambios; como mucho cada 30 s salvo
    /// que se fuerce (desconexión). Un archivo nuevo, aditivo: la v0.7.0 no lo
    /// mira y no le hace falta.
    fn guardar_grados(&mut self, forzar: bool) {
        if !self.grados_sucio {
            return;
        }
        if !forzar && self.grados_guardado.elapsed() < Duration::from_secs(30) {
            return;
        }
        crate::grado::guardar(&self.chain.root, &self.grados);
        self.grados_sucio = false;
        self.grados_guardado = Instant::now();
    }

    /// Evidencia de la sesión completada con lo que solo el nodo sabe: la
    /// mejor altura ajena y si alguna punta suya está en nuestro árbol y la
    /// anuncia también otro par.
    fn evidencia_de(&self, peer: PeerId) -> EvidenciaSesion {
        let mut e = self.sesion.get(&peer).cloned().unwrap_or_default();
        e.altura = e.altura.max(self.peer_height.get(&peer).copied().unwrap_or(0));
        e.mejor_altura_ajena =
            self.peer_height.iter().filter(|(p, _)| **p != peer).map(|(_, h)| *h).max().unwrap_or(0);
        if let Some(pt) = self.peer_tips.get(&peer) {
            for (h, _, _) in &pt.tips {
                if !self.tree.contains(h) {
                    continue;
                }
                e.verificado = true;
                let otro = self
                    .peer_tips
                    .iter()
                    .any(|(p, t)| *p != peer && t.tips.iter().any(|(oh, _, _)| oh == h));
                if otro {
                    e.corroborado = true;
                    break;
                }
            }
        }
        if e.validos > 0 {
            e.verificado = true;
        }
        e
    }

    fn graduacion_de(&self, peer: PeerId) -> crate::grado::Graduacion {
        let pk = self.peer_ident.get(&peer).map(|(p, _)| p.as_str()).unwrap_or("");
        let vacio = HistorialPar::default();
        let h = self.grados.get(pk).unwrap_or(&vacio);
        crate::grado::graduar(h, &self.evidencia_de(peer))
    }

    fn peer_label(&self, peer: PeerId) -> String {
        self.peer_meta
            .get(&peer)
            .map(|(addr, _, dial)| dial.clone().unwrap_or_else(|| addr.clone()))
            .unwrap_or_default()
    }

    /// Localizador actual (cacheado mientras el árbol no cambie).
    fn locator(&mut self) -> Vec<Hash> {
        let n = self.tree.len();
        if let Some((k, l)) = &self.locator_cache {
            if *k == n {
                return l.clone();
            }
        }
        let l = self.tree.locator();
        self.locator_cache = Some((n, l.clone()));
        l
    }

    /// Peticiones activas (enviadas hace menos de `BRANCH_RETRY`) a un par.
    fn active_requests(&self, peer: PeerId) -> usize {
        self.inflight
            .get(&peer)
            .map(|s| s.values().filter(|r| r.sent.elapsed() < BRANCH_RETRY).count())
            .unwrap_or(0)
    }

    /// Pide a `peer` la rama que termina en `tip` con un localizador fresco
    /// más `cursor` (último bloque del lote anterior que ya teníamos: el par
    /// reanuda justo después, aunque la bifurcación caiga entre dos muestras
    /// lejanas del localizador). `force` salta la ventana anti-spam y el tope
    /// en vuelo (continuación inmediata de un lote con `more`). Devuelve true
    /// si se envió la petición.
    fn request_branch(&mut self, peer: PeerId, tip: Hash, force: bool, cursor: Option<Hash>) -> bool {
        if self.tree.contains(&tip) {
            return false;
        }
        let existing = self
            .inflight
            .get(&peer)
            .and_then(|s| s.get(&tip))
            .map(|r| (r.rounds, r.sent.elapsed(), r.cursor));
        if let Some((rounds, _, _)) = existing {
            if rounds >= BRANCH_MAX_ROUNDS {
                return false;
            }
        }
        // Progreso = el cursor avanzó respecto a la última continuación. Un par
        // que repite el mismo lote no consigue que se le vuelva a pedir al
        // instante: cae en la ventana anti-spam y consume una ronda.
        let advanced = cursor.is_some() && existing.is_none_or(|(_, _, prev)| cursor != prev);
        let force = force && advanced;
        if !force {
            if let Some((_, age, _)) = existing {
                if age < BRANCH_RETRY {
                    return false;
                }
            } else if self.active_requests(peer) >= MAX_INFLIGHT_PER_PEER {
                return false;
            }
        }
        let rounds = if advanced { 1 } else { existing.map(|e| e.0).unwrap_or(0) + 1 };
        let prev_cursor = existing.and_then(|e| e.2);
        let slot = self.inflight.entry(peer).or_default();
        if slot.len() >= PEER_TIPS_CAP * 2 {
            // cota de memoria por par: fuera lo más antiguo
            slot.retain(|_, r| r.sent.elapsed() < BRANCH_RETRY);
            if slot.len() >= PEER_TIPS_CAP * 2 {
                return false;
            }
        }
        slot.insert(tip, BranchReq { sent: Instant::now(), rounds, cursor: cursor.or(prev_cursor) });
        if rounds >= BRANCH_MAX_ROUNDS {
            let st = self.strikes.entry(peer).or_insert(0);
            *st += 1;
            if *st >= PEER_STRIKES_MAX {
                eprintln!("[sync] par {} agota rondas de rama una y otra vez: se expulsa", self.peer_label(peer));
                self.net.disconnect(peer);
                return false;
            }
        }
        let mut known = self.locator();
        if let Some(c) = cursor {
            known.push(c);
        }
        let known: Vec<String> = known.iter().map(hex::encode).collect();
        self.net.send(peer, Frame::GetBranch { tip: hex::encode(tip), known, max: SYNC_BATCH });
        true
    }

    /// Pide a `peer`, por orden de trabajo, las puntas que anunció y aún nos
    /// faltan, hasta llenar las `MAX_INFLIGHT_PER_PEER` ranuras activas.
    fn pump_peer(&mut self, peer: PeerId) {
        let wanted: Vec<Hash> = match self.peer_tips.get(&peer) {
            Some(pt) => pt.tips.iter().map(|t| t.0).filter(|h| !self.tree.contains(h)).collect(),
            None => return,
        };
        let mut active = self.active_requests(peer);
        for h in wanted {
            if active >= MAX_INFLIGHT_PER_PEER {
                break;
            }
            if self.request_branch(peer, h, false, None) {
                active += 1;
            }
        }
    }

    /// ¿Atendemos otra `GetBranch` de este par en la ventana actual?
    fn serve_allowed(&mut self, peer: PeerId) -> bool {
        let e = self.served.entry(peer).or_insert((Instant::now(), 0));
        if e.0.elapsed() >= BRANCH_RETRY {
            *e = (Instant::now(), 0);
        }
        if e.1 >= SERVE_RATE_MAX {
            return false;
        }
        e.1 += 1;
        true
    }

    fn remember_bad(&mut self, h: Hash) {
        if self.bad_blocks.len() >= BAD_BLOCKS_CAP {
            self.bad_blocks.clear();
        }
        self.bad_blocks.insert(h);
    }

    /// Poda el estado de sincronización: puntas ya en el árbol y peticiones
    /// caducadas dejan de ocupar memoria. Nunca se reinicia todo de golpe.
    fn prune_sync_state(&mut self) {
        let tree = &self.tree;
        let my_tips: HashSet<Hash> = tree.tips().into_iter().collect();
        for pt in self.peer_tips.values_mut() {
            pt.forget_interior(tree, &my_tips);
        }
        for slot in self.inflight.values_mut() {
            slot.retain(|h, r| !tree.contains(h) && r.sent.elapsed() < BRANCH_RETRY * 12);
        }
        self.inflight.retain(|_, slot| !slot.is_empty());
        self.served.retain(|_, (t, _)| t.elapsed() < BRANCH_RETRY * 2);
    }

    fn on_net(&mut self, ev: NetEvent) {
        match ev {
            NetEvent::Connected { peer, addr, inbound, dial_addr, pubkey, fingerprint } => {
                self.peer_height.insert(peer, 0);
                self.peer_ident.insert(peer, (hex::encode(pubkey), fingerprint.clone()));
                self.sesion.insert(peer, EvidenciaSesion::default());
                self.historial_de(peer).visto = now_secs();
                self.grados_sucio = true;
                if let Some(d) = &dial_addr {
                    self.pin_identity(d, &pubkey, &fingerprint);
                }
                // Recuerda al par si es remarcable (descubrimiento persistente).
                // El tope también rige en memoria: un atacante no puede hacer
                // crecer known_peers sin límite a base de conexiones.
                if let Some(d) = &dial_addr {
                    if self.known_peers.len() < KNOWN_PEERS_CAP && self.known_peers.insert(d.clone()) {
                        persist_known_peers(&self.chain.root, &self.known_peers);
                    }
                }
                self.peer_meta.insert(peer, (addr, inbound, dial_addr));
                let s = self.my_status_frame();
                self.net.send(peer, s);
                // Universo de ramas: le contamos TODAS nuestras puntas para que
                // pida las ramas que le falten (y él hará lo mismo).
                let t = self.my_tips_frame();
                self.net.send(peer, t);
                self.net.send(peer, Frame::GetPeers);
            }
            NetEvent::Disconnected { peer } => {
                self.sesion.remove(&peer);
                self.guardar_grados(true);
                self.peer_height.remove(&peer);
                self.peer_rule.remove(&peer);
                self.peer_meta.remove(&peer);
                self.peer_ident.remove(&peer);
                self.peer_tips.remove(&peer);
                self.inflight.remove(&peer);
                self.strikes.remove(&peer);
                self.served.remove(&peer);
            }
            NetEvent::Message { peer, frame } => self.on_frame(peer, frame),
        }
        // El libro de fuentes se persiste aquí (con su límite de 30 s): así un
        // par que se conecta y no manda bloques también queda apuntado.
        self.guardar_grados(false);
        self.publish_status();
    }

    /// TOFU: fija la identidad vista en `addr`. Si ya había OTRA, avisa (en el
    /// registro y en `netinfo.identity_warnings`) y actualiza la fijación; no
    /// se corta la conexión (testnet).
    fn pin_identity(&mut self, addr: &str, pubkey: &[u8; 32], fp: &str) {
        let pk_hex = hex::encode(pubkey);
        match self.known_identities.get(addr) {
            Some(known) if *known == pk_hex => return,
            Some(known) => {
                let old_fp = hex::decode(known)
                    .ok()
                    .and_then(|v| <[u8; 32]>::try_from(v).ok())
                    .map(|k| fingerprint_of(&k))
                    .unwrap_or_else(|| "?".into());
                let msg = format!("la identidad del par {addr} ha cambiado (huella {old_fp} → {fp})");
                eprintln!("[net] AVISO: {msg}");
                self.grados.entry(pk_hex.clone()).or_default().cambios_identidad += 1;
                self.grados_sucio = true;
                if let Ok(mut g) = self.netinfo.lock() {
                    if !g.identity_warnings.contains(&msg) {
                        if g.identity_warnings.len() >= IDENTITY_WARNINGS_CAP {
                            g.identity_warnings.remove(0);
                        }
                        g.identity_warnings.push(msg);
                    }
                }
            }
            None => {
                if self.known_identities.len() >= KNOWN_IDENTITIES_CAP {
                    return; // tope: no se fija (ni se persiste) nada más
                }
            }
        }
        self.known_identities.insert(addr.to_string(), pk_hex);
        persist_known_identities(&self.chain.root, &self.known_identities);
    }

    fn on_frame(&mut self, peer: rami_net::PeerId, frame: Frame) {
        match frame {
            Frame::Hello { .. } => {}
            Frame::Status { height, rule, .. } => {
                self.peer_height.insert(peer, height);
                self.peer_rule.insert(peer, rule);
                if let Some(e) = self.sesion.get_mut(&peer) {
                    e.altura = e.altura.max(height);
                }
            }
            Frame::Tips { tips, partial } => {
                // Registra las puntas del par (completas o delta) y pide, por
                // orden de trabajo y dentro del tope en vuelo, toda rama que
                // nos falte: en el universo de ramas todo bloque válido llega
                // a todos.
                let entries = tips.into_iter().take(PEER_TIPS_CAP).filter_map(|t| {
                    let h = parse_hash(&t.hash)?;
                    let w = t.work.parse::<u128>().ok()?;
                    Some((h, t.height, w))
                });
                let my_tips: HashSet<Hash> = self.tree.tips().into_iter().collect();
                let entries: Vec<(Hash, u64, u128)> = entries.collect();
                if let Some(e) = self.sesion.get_mut(&peer) {
                    e.puntas_anunciadas += entries.len() as u64;
                }
                let entries = entries.into_iter();
                let pt = self.peer_tips.entry(peer).or_default();
                if partial {
                    pt.tips.extend(entries);
                } else {
                    pt.tips = entries.collect();
                }
                pt.normalize();
                pt.forget_interior(&self.tree, &my_tips);
                let best_height = pt.best_height();
                let ph = self.peer_height.entry(peer).or_insert(0);
                if best_height > *ph {
                    *ph = best_height;
                }
                self.pump_peer(peer);
            }
            Frame::GetBranch { tip, known, max } => {
                if let Some(tip_h) = parse_hash(&tip) {
                    if !self.serve_allowed(peer) {
                        return self.publish_status();
                    }
                    let known: Vec<Hash> = known.iter().take(4096).filter_map(|k| parse_hash(k)).collect();
                    let max = (max as usize).clamp(1, SERVE_MAX);
                    if let Some((blocks, more)) = self.tree.branch_to(&tip_h, &known, max) {
                        // Presupuesto de bytes: la respuesta debe caber en una
                        // línea del transporte; si se recorta, `more` avisa.
                        let mut out: Vec<Block> = Vec::new();
                        let mut bytes = 0usize;
                        let mut more = more;
                        for b in blocks {
                            let sz = serde_json::to_vec(&b).map(|v| v.len()).unwrap_or(0);
                            if !out.is_empty() && bytes + sz > SERVE_MAX_BYTES {
                                more = true;
                                break;
                            }
                            bytes += sz;
                            out.push(b);
                        }
                        if !out.is_empty() {
                            self.net.send(peer, Frame::Branch { tip, blocks: out, more });
                        }
                    }
                }
            }
            Frame::Branch { tip, blocks, more } => {
                // Admite el lote en orden; `accept_block` revalida TODO con las
                // reglas de consenso (la red nunca es fuente de confianza).
                let tip_h = parse_hash(&tip);
                let requested = tip_h
                    .map(|t| self.inflight.get(&peer).is_some_and(|s| s.contains_key(&t)))
                    .unwrap_or(false);
                let mut accepted = 0usize;
                let mut orphan = false;
                // Cursor: último bloque del lote que está en nuestro árbol
                // (nuevo o ya conocido). Solo vale si TODO el lote quedó en el
                // árbol: si algo falló, reanudar tras el cursor repetiría el fallo.
                let mut cursor: Option<Hash> = None;
                let mut all_in_tree = true;
                let mut n = 0usize;
                for b in blocks.into_iter().take(SERVE_MAX) {
                    n += 1;
                    let h = b.hash();
                    if self.bad_blocks.contains(&h) {
                        all_in_tree = false;
                        continue;
                    }
                    match self.accept_block(b, Some(peer)) {
                        Ok(true) => {
                            accepted += 1;
                            cursor = Some(h);
                            self.anotar(peer, Anota::Valido);
                        }
                        Ok(false) => cursor = Some(h),
                        Err(e) => {
                            all_in_tree = false;
                            if is_orphan_err(&e) {
                                orphan = true;
                                self.anotar(peer, Anota::Huerfano);
                            } else {
                                self.remember_bad(h);
                                self.anotar(peer, Anota::Invalido);
                            }
                        }
                    }
                }
                if accepted > 0 {
                    self.branches_synced += 1;
                    self.last_sync_from = self.peer_label(peer);
                    self.anotar(peer, Anota::Rama);
                    self.last_sync_fuente = self.graduacion_de(peer).codigo;
                    self.refresh_candidate();
                    self.maybe_broadcast_tips(false);
                }
                if let Some(t) = tip_h {
                    if self.tree.contains(&t) {
                        // rama completa: libera la ranura
                        if let Some(slot) = self.inflight.get_mut(&peer) {
                            slot.remove(&t);
                        }
                    } else if requested {
                        if more && n > 0 && all_in_tree {
                            // El cursor avanzó (haya o no bloques nuevos):
                            // continuación inmediata reanudando tras él.
                            self.request_branch(peer, t, true, cursor);
                        } else if more || orphan {
                            // Sin progreso o huérfano: el reintento respeta la
                            // ventana anti-spam y la cota de rondas.
                            self.request_branch(peer, t, false, None);
                        }
                    }
                }
                // ranuras libres => siguientes puntas pendientes de este par
                self.pump_peer(peer);
            }
            Frame::NewBlock { block } => {
                let h = block.hash();
                if self.bad_blocks.contains(&h) {
                    return self.publish_status();
                }
                match self.accept_block(block, Some(peer)) {
                    Ok(true) => {
                        self.anotar(peer, Anota::Valido);
                        self.refresh_candidate();
                        self.maybe_broadcast_tips(false);
                    }
                    Ok(false) => {}
                    Err(e) => {
                        if is_orphan_err(&e) {
                            self.anotar(peer, Anota::Huerfano);
                            // nos falta el padre: pide la rama entera de este
                            // bloque a quien lo anuncia.
                            self.request_branch(peer, h, false, None);
                        } else {
                            self.remember_bad(h);
                            self.anotar(peer, Anota::Invalido);
                        }
                    }
                }
            }
            Frame::NewTx { tx } => {
                let _ = self.accept_tx(tx, Some(peer));
            }
            Frame::GetPeers => {
                // Solo se comparten direcciones REMARCABLES (IP + puerto anunciado);
                // los puertos efímeros de los sockets entrantes no sirven a nadie.
                let addrs: Vec<String> = self
                    .peer_meta
                    .values()
                    .filter_map(|(_, _, d)| d.clone())
                    .take(32)
                    .collect();
                if !addrs.is_empty() {
                    self.net.send(peer, Frame::Peers { addrs });
                }
            }
            Frame::Peers { addrs } => {
                if self.net.peer_count() < 16 {
                    for a in addrs.into_iter().take(8) {
                        self.net.dial(a);
                    }
                }
            }
            Frame::Ping { nonce } => self.net.send(peer, Frame::Pong { nonce }),
            Frame::Pong { .. } => {}
            Frame::Presence { pk, pow, seq, ts, name, x, y, z, yaw, avatar, hops, sig } => {
                self.on_presence(peer, pk, pow, seq, ts, name, x, y, z, yaw, avatar, hops, sig);
                return; // efímero: no cambia el estado que publica el panel
            }
            Frame::Chat { pk, pow, seq, ts, name, text, hops, sig } => {
                self.on_chat(peer, pk, pow, seq, ts, name, text, hops, sig);
                return;
            }
        }
        self.publish_status();
    }

    /// Pares que entienden Dubái (anuncian regla ≥ 3): solo a ellos se les
    /// retransmite lo efímero del metaverso (los demás lo ignorarían igual).
    fn peers_dubai(&self, except: Option<PeerId>) -> Vec<PeerId> {
        self.peer_rule.iter().filter(|(p, r)| **r >= REGLA_SOPORTADA && Some(**p) != except).map(|(p, _)| *p).collect()
    }

    /// Presencia recibida: identidad con prueba de trabajo, firma válida,
    /// secuencia creciente, ritmo acotado, campos acotados. Si pasa, se guarda
    /// (tope de memoria) y se retransmite con un salto menos.
    #[allow(clippy::too_many_arguments)]
    fn on_presence(&mut self, from: PeerId, pk: String, pow: u64, seq: u64, ts: u64, name: String, x: i32, y: i32, z: i32, yaw: i32, avatar: u8, hops: u8, sig: String) {
        let Some((pkb, sigb)) = parse_pk_sig(&pk, &sig) else { return };
        if pkb == self.identity.pubkey {
            return; // eco de lo nuestro
        }
        if name.len() > PRESENCE_NAME_MAX || name.chars().any(|c| c.is_control()) {
            return;
        }
        if [x, y, z].iter().any(|v| v.abs() > PRESENCE_COORD_MAX) || !(0..=360).contains(&yaw) {
            return;
        }
        if !identity_pow_ok(&pkb, pow) {
            return;
        }
        if !ed_verify(&pkb, &presence_msg(&pkb, seq, ts, &name, x, y, z, yaw, avatar), &sigb) {
            return;
        }
        if let Some(e) = self.presence.get(&pkb) {
            if seq <= e.seq {
                return; // repetida o antigua
            }
        }
        if let Some(t) = self.presence_last.get(&pkb) {
            if t.elapsed() < PRESENCE_MIN_INTERVAL {
                return;
            }
        }
        if !self.presence.contains_key(&pkb) && self.presence.len() >= PRESENCE_CAP {
            // Tope: fuera el más antiguo.
            if let Some((&old, _)) = self.presence.iter().min_by_key(|(_, e)| e.seen) {
                self.presence.remove(&old);
                self.presence_last.remove(&old);
            }
        }
        self.presence_last.insert(pkb, Instant::now());
        self.presence.insert(pkb, PresenceEntry { seq, ts, name: name.clone(), x, y, z, yaw, avatar, seen: Instant::now() });
        if hops < PRESENCE_MAX_HOPS {
            let f = Frame::Presence { pk, pow, seq, ts, name, x, y, z, yaw, avatar, hops: hops + 1, sig };
            for p in self.peers_dubai(Some(from)) {
                self.net.send(p, f.clone());
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn on_chat(&mut self, from: PeerId, pk: String, pow: u64, seq: u64, ts: u64, name: String, text: String, hops: u8, sig: String) {
        let Some((pkb, sigb)) = parse_pk_sig(&pk, &sig) else { return };
        if pkb == self.identity.pubkey {
            return;
        }
        if name.len() > PRESENCE_NAME_MAX || text.is_empty() || text.len() > CHAT_TEXT_MAX {
            return;
        }
        if name.chars().any(|c| c.is_control()) || text.chars().any(|c| c.is_control() && c != ' ') {
            return;
        }
        if !identity_pow_ok(&pkb, pow) || !ed_verify(&pkb, &chat_msg(&pkb, seq, ts, &name, &text), &sigb) {
            return;
        }
        if let Some(t) = self.chat_last.get(&pkb) {
            if t.elapsed() < CHAT_MIN_INTERVAL {
                return;
            }
        }
        // Un mismo mensaje (misma identidad y secuencia) no entra dos veces.
        if self.chat.iter().any(|c| c.pk == pkb && c.ts == ts && c.text == text) {
            return;
        }
        self.chat_last.insert(pkb, Instant::now());
        if self.chat_last.len() > PRESENCE_CAP * 2 {
            self.chat_last.retain(|_, t| t.elapsed() < Duration::from_secs(60));
        }
        if self.chat.len() >= CHAT_CAP {
            self.chat.pop_front();
        }
        self.chat.push_back(ChatEntry { pk: pkb, name: name.clone(), text: text.clone(), ts });
        if hops < CHAT_MAX_HOPS {
            let f = Frame::Chat { pk, pow, seq, ts, name, text, hops: hops + 1, sig };
            for p in self.peers_dubai(Some(from)) {
                self.net.send(p, f.clone());
            }
        }
    }

    /// Caduca la presencia sin señal reciente.
    fn prune_presence(&mut self) {
        self.presence.retain(|_, e| e.seen.elapsed() < PRESENCE_TTL);
        self.presence_last.retain(|_, t| t.elapsed() < PRESENCE_TTL);
        if let Some(t) = self.my_presence_at {
            if t.elapsed() > PRESENCE_TTL {
                self.my_presence = None;
            }
        }
    }

    fn avatar_view(&self, pk: &[u8; 32], e: &PresenceEntry) -> AvatarView {
        AvatarView {
            pk: hex::encode(pk),
            fingerprint: fingerprint_of(pk),
            name: e.name.clone(),
            x: e.x,
            y: e.y,
            z: e.z,
            yaw: e.yaw,
            avatar: e.avatar,
            age: e.seen.elapsed().as_secs(),
            ts: e.ts,
            me: false,
        }
    }

    fn presence_view(&self) -> PresenceView {
        let me_pk = self.identity.pubkey;
        let mut avatars: Vec<AvatarView> = self.presence.iter().map(|(pk, e)| self.avatar_view(pk, e)).collect();
        avatars.sort_by(|a, b| a.fingerprint.cmp(&b.fingerprint));
        let me = self.my_presence.as_ref().map(|p| AvatarView {
            pk: hex::encode(me_pk),
            fingerprint: self.identity.fingerprint(),
            name: p.name.clone(),
            x: p.x,
            y: p.y,
            z: p.z,
            yaw: p.yaw,
            avatar: p.avatar,
            age: self.my_presence_at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
            ts: now_secs(),
            me: true,
        });
        let chat = self
            .chat
            .iter()
            .map(|c| ChatView { pk: hex::encode(c.pk), fingerprint: fingerprint_of(&c.pk), name: c.name.clone(), text: c.text.clone(), ts: c.ts, me: c.pk == me_pk })
            .collect();
        PresenceView { me, avatars, chat, fingerprint: self.identity.fingerprint() }
    }

    /// Admite un bloque en el árbol (revalida con las reglas de consenso) y lo
    /// persiste. Devuelve Ok(true) si era nuevo y se aceptó.
    fn accept_block(&mut self, block: Block, _from: Option<rami_net::PeerId>) -> Result<bool, String> {
        let h = block.hash();
        if self.tree.contains(&h) {
            return Ok(false);
        }
        let included: Vec<TxId> = block.txs.iter().map(txid).collect();
        self.tree.insert(block.clone())?;
        self.chain.append_block(&block)?;
        // Retira del mempool las tx ya incluidas.
        self.mempool.retain(|t| !included.contains(&txid(t)));
        self.persist_mempool();
        Ok(true)
    }

    /// Admite una tx en el mempool si es válida y aplica económicamente.
    fn accept_tx(&mut self, tx: Tx, from: Option<rami_net::PeerId>) -> Result<String, String> {
        if matches!(tx, Tx::Coinbase { .. }) {
            return Err("coinbase no se retransmite".into());
        }
        // La regla que rige AHORA (por fecha): una tx firmada bajo la regla
        // anterior/siguiente no entra en el mempool, y se dice por qué.
        let firma = self.firma_ctx(now_secs());
        verify_tx_con(&tx, &firma).map_err(|e| format!("firma/estructura: {e} (rige la regla v{})", firma.numero()))?;
        let id = txid(&tx);
        if self.seen_tx.contains(&id) {
            return Ok(hex::encode(id));
        }
        // Topes del mempool (anti-DoS): nadie puede llenarnos la memoria a
        // base de tx válidas pero infinitas, ni acaparar el mempool un solo
        // firmante.
        if self.mempool.len() >= MEMPOOL_MAX {
            return Err("mempool lleno: inténtalo cuando se mine el siguiente bloque".into());
        }
        if let Some(who) = rami_core::tx::signer_of(&tx) {
            let mine = self.mempool.iter().filter(|t| rami_core::tx::signer_of(t) == Some(who)).count();
            if mine >= MEMPOOL_MAX_PER_SIGNER {
                return Err(format!("demasiadas tx pendientes de este firmante (máx. {MEMPOOL_MAX_PER_SIGNER})"));
            }
        }
        if self.seen_tx.len() >= SEEN_TX_CAP {
            self.seen_tx.clear();
        }
        // Valida sobre el estado de la punta CON el mempool ya aplicado en orden,
        // para admitir nonces consecutivos del mismo firmante (p. ej. enviar y
        // luego comprometer sin esperar a que se mine el primero).
        let mut sim = self.tree.head_state().unwrap_or_default();
        let next_height = self.head_height() + 1;
        for t in &self.mempool {
            let _ = try_apply(&mut sim, t, next_height, firma.dubai);
        }
        try_apply(&mut sim, &tx, next_height, firma.dubai).map_err(|e| format!("no aplica: {e}"))?;
        self.mempool.push(tx.clone());
        self.seen_tx.insert(id);
        let _ = self.chain.append_mempool(&tx);
        self.refresh_candidate();
        // Retransmite a los demás pares.
        for (&p, _) in self.peer_height.iter() {
            if Some(p) != from {
                self.net.send(p, Frame::NewTx { tx: tx.clone() });
            }
        }
        Ok(hex::encode(id))
    }

    fn on_mined(&mut self, block: Block) {
        match self.accept_block(block.clone(), None) {
            Ok(true) => {
                self.mining.found.fetch_add(1, Ordering::Relaxed);
                self.net.broadcast(Frame::NewBlock { block });
                // `Tips` lleva la nueva cabeza (altura y trabajo): `Status`
                // sería redundante en cada bloque.
                self.maybe_broadcast_tips(false);
                self.refresh_candidate();
            }
            _ => self.refresh_candidate(),
        }
        self.publish_status();
    }

    fn on_tick(&mut self) {
        // Universo de ramas: vuelve a pedir las puntas anunciadas que aún nos
        // faltan (p. ej. si se perdió una respuesta), dentro de la ventana
        // anti-spam y la cota de rondas; y late las puntas cada 30 s.
        self.prune_sync_state();
        let peers: Vec<PeerId> = self.peer_tips.keys().copied().collect();
        for p in peers {
            self.pump_peer(p);
        }
        self.maybe_broadcast_tips(false);
        self.podar_mempool_por_regla();
        self.prune_presence();
        // Refresca el candidato cada ~30 s para renovar el timestamp del bloque.
        if self.mining_on && now_secs().saturating_sub(self.last_candidate_ts) >= 30 {
            self.refresh_candidate();
        }
        self.publish_status();
    }

    fn on_cmd(&mut self, cmd: NodeCmd) {
        match cmd {
            NodeCmd::SubmitTx(tx, reply) => {
                let r = self.accept_tx(*tx, None);
                let _ = reply.send(r);
            }
            NodeCmd::SetMining(on) => {
                self.mining_on = on && self.miner.is_some();
                self.refresh_candidate();
            }
            NodeCmd::SetMiner(a) => {
                self.miner = Some(a);
                self.refresh_candidate();
            }
            NodeCmd::AddPeer(addr) => self.net.dial(addr),
            NodeCmd::GetAccount(a, reply) => {
                let st = self.tree.head_state().unwrap_or_default();
                let acc: Account = st.accounts.get(&a).cloned().unwrap_or_default();
                let _ = reply.send(AccountView { balance: acc.balance, staked: acc.staked, nonce: acc.nonce });
            }
            NodeCmd::Firma(reply) => {
                let _ = reply.send(self.firma_ctx(now_secs()));
            }
            NodeCmd::NextNonce(a, reply) => {
                let base = self.tree.head_state().map(|s| s.nonce_of(&a)).unwrap_or(0);
                // Sólo cuentan las pendientes que aún valen bajo la regla vigente
                // (las demás se podan y su nonce sigue libre).
                let firma = self.firma_ctx(now_secs());
                let pending = self
                    .mempool
                    .iter()
                    .filter(|t| signer_of(t) == Some(&a) && verify_tx_con(t, &firma).is_ok())
                    .count() as u64;
                let _ = reply.send(base + pending);
            }
            NodeCmd::RecentBlocks(n, reply) => {
                let chain = self.tree.observer_chain();
                let start = chain.len().saturating_sub(n);
                let out: Vec<BlockView> = chain[start..]
                    .iter()
                    .filter_map(|h| self.tree.get(h))
                    .map(|node| BlockView {
                        height: node.block.header.height,
                        hash: hex::encode(node.block.hash()),
                        txs: node.block.txs.len(),
                        bits: node.block.header.bits,
                        difficulty: difficulty_from_bits(node.block.header.bits),
                        timestamp: node.block.header.timestamp,
                    })
                    .collect();
                let _ = reply.send(out);
            }
            NodeCmd::GetCity(reply) => {
                let st = self.tree.head_state().unwrap_or_default();
                let ahora = now_secs();
                let firma = self.firma_ctx(ahora);
                let mut v = city_view(&st, self.head_height(), &firma, self.tree.params().dubai_desde, ahora);
                for t in &self.mempool {
                    let id = hex::encode(txid(t));
                    let who = signer_of(t).map(hex::encode).unwrap_or_default();
                    let pv = match t {
                        Tx::ClaimParcel { x, y, name, kind, .. } => PendingView {
                            op: "claim".into(), who, x: *x, y: *y,
                            name: String::from_utf8_lossy(name).to_string(), kind: *kind, asset: String::new(), txid: id, price: 0,
                        },
                        Tx::MintAsset { x, y, kind, .. } => PendingView { op: "mint".into(), who, x: *x, y: *y, kind: *kind, txid: id, ..Default::default() },
                        Tx::TransferAsset { asset, .. } => PendingView { op: "transfer".into(), who, asset: hex::encode(asset), txid: id, ..Default::default() },
                        Tx::ListLease { asset, .. } => PendingView { op: "list".into(), who, asset: hex::encode(asset), txid: id, ..Default::default() },
                        Tx::Rent { asset, .. } => PendingView { op: "rent".into(), who, asset: hex::encode(asset), txid: id, ..Default::default() },
                        Tx::Harvest { x, y, .. } => PendingView { op: "harvest".into(), who, x: *x, y: *y, txid: id, ..Default::default() },
                        Tx::SellAsset { asset, price, .. } => PendingView { op: "sell_asset".into(), who, asset: hex::encode(asset), price: *price, txid: id, ..Default::default() },
                        Tx::BuyAsset { asset, max_price, .. } => PendingView { op: "buy_asset".into(), who, asset: hex::encode(asset), price: *max_price, txid: id, ..Default::default() },
                        Tx::SellParcel { x, y, price, .. } => PendingView { op: "sell_parcel".into(), who, x: *x, y: *y, price: *price, txid: id, ..Default::default() },
                        Tx::BuyParcel { x, y, max_price, .. } => PendingView { op: "buy_parcel".into(), who, x: *x, y: *y, price: *max_price, txid: id, ..Default::default() },
                        _ => continue,
                    };
                    v.pending.push(pv);
                }
                let _ = reply.send(v);
            }
            NodeCmd::GetMentor(x, y, me, reply) => {
                let st = self.tree.head_state().unwrap_or_default();
                let firma = self.firma_ctx(now_secs());
                let _ = reply.send(mentor_view(&st, self.head_height(), &firma, x, y, me));
            }
            NodeCmd::GetMarket(reply) => {
                let st = self.tree.head_state().unwrap_or_default();
                let firma = self.firma_ctx(now_secs());
                let network = if self.is_testnet { "testnet" } else { "regtest" };
                let _ = reply.send(market_view(&st, self.head_height(), &firma, network, &hex::encode(self.network_id)));
            }
            NodeCmd::SetPresence(p) => {
                // Ritmo propio acotado (el panel manda ~1/s; la red no ve más de
                // uno cada PRESENCE_MIN_INTERVAL).
                let mut p = *p;
                p.name = sane_name(&p.name);
                p.x = p.x.clamp(-PRESENCE_COORD_MAX, PRESENCE_COORD_MAX);
                p.y = p.y.clamp(-PRESENCE_COORD_MAX, PRESENCE_COORD_MAX);
                p.z = p.z.clamp(-PRESENCE_COORD_MAX, PRESENCE_COORD_MAX);
                p.yaw = p.yaw.rem_euclid(361).min(360);
                let ok_ritmo = self.my_presence_at.is_none_or(|t| t.elapsed() >= PRESENCE_MIN_INTERVAL);
                self.my_presence = Some(p.clone());
                if ok_ritmo {
                    self.my_presence_at = Some(Instant::now());
                    self.my_seq += 1;
                    let ts = now_secs();
                    let pk = self.identity.pubkey;
                    let sig = self.identity.sign(&presence_msg(&pk, self.my_seq, ts, &p.name, p.x, p.y, p.z, p.yaw, p.avatar));
                    let f = Frame::Presence {
                        pk: hex::encode(pk), pow: self.identity.pow_nonce, seq: self.my_seq, ts, name: p.name.clone(),
                        x: p.x, y: p.y, z: p.z, yaw: p.yaw, avatar: p.avatar, hops: 0, sig: hex::encode(sig),
                    };
                    for peer in self.peers_dubai(None) {
                        self.net.send(peer, f.clone());
                    }
                }
            }
            NodeCmd::GetPresence(reply) => {
                let _ = reply.send(self.presence_view());
            }
            NodeCmd::SendChat(name, text, reply) => {
                let name = sane_name(&name);
                let text = sane_text(&text);
                let r = if text.is_empty() {
                    Err("mensaje vacío".to_string())
                } else if self.chat_last.get(&self.identity.pubkey).is_some_and(|t| t.elapsed() < CHAT_MIN_INTERVAL) {
                    Err("espera un momento antes de otro mensaje".to_string())
                } else {
                    let pk = self.identity.pubkey;
                    self.chat_last.insert(pk, Instant::now());
                    self.my_seq += 1;
                    let ts = now_secs();
                    let sig = self.identity.sign(&chat_msg(&pk, self.my_seq, ts, &name, &text));
                    if self.chat.len() >= CHAT_CAP {
                        self.chat.pop_front();
                    }
                    self.chat.push_back(ChatEntry { pk, name: name.clone(), text: text.clone(), ts });
                    let f = Frame::Chat { pk: hex::encode(pk), pow: self.identity.pow_nonce, seq: self.my_seq, ts, name, text, hops: 0, sig: hex::encode(sig) };
                    for peer in self.peers_dubai(None) {
                        self.net.send(peer, f.clone());
                    }
                    Ok(())
                };
                let _ = reply.send(r);
            }
            NodeCmd::GetBlock(height, reply) => {
                let chain = self.tree.observer_chain();
                let detail = chain.get(height as usize).and_then(|h| self.tree.get(h)).map(|node| {
                    let b = &node.block;
                    BlockDetail {
                        height: b.header.height,
                        hash: hex::encode(b.hash()),
                        prev_hash: hex::encode(b.header.prev_hash),
                        merkle_root: hex::encode(b.header.merkle_root),
                        timestamp: b.header.timestamp,
                        bits: b.header.bits,
                        difficulty: difficulty_from_bits(b.header.bits),
                        nonce: b.header.nonce,
                        branch_tag: String::from_utf8_lossy(&b.header.branch_tag).into_owned(),
                        txs: b.txs.iter().map(tx_view).collect(),
                    }
                });
                let _ = reply.send(detail);
            }
        }
        self.publish_status();
    }

    /// Reconstruye el trabajo de minería sobre la punta actual (o lo apaga).
    fn refresh_candidate(&mut self) {
        if !self.mining_on || self.miner.is_none() {
            self.mining.on.store(false, Ordering::Relaxed);
            *self.mining.job.lock().unwrap() = None;
            self.mining.epoch.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let miner = self.miner.unwrap();
        let head = self.tree.head();
        let height = self.head_height() + 1;
        let bits = self.tree.expected_bits(&head);
        let state = match self.tree.head_state() {
            Ok(s) => s,
            Err(_) => return,
        };
        let ts = now_secs();
        let firma = self.firma_ctx(ts);
        let (header, txs, _ids) =
            build_candidate(height, head, bits, miner, &state, &self.mempool, *b"main", ts, &firma);
        *self.mining.job.lock().unwrap() = Some(MiningJob { header, txs });
        self.mining.epoch.fetch_add(1, Ordering::Relaxed);
        self.mining.on.store(true, Ordering::Relaxed);
        self.last_candidate_ts = ts;
    }

    /// Tx del mempool que no valen bajo la regla que rige ahora.
    fn mempool_fuera_de_regla(&self) -> usize {
        let firma = self.firma_ctx(now_secs());
        self.mempool.iter().filter(|t| verify_tx_con(t, &firma).is_err()).count()
    }

    /// Al activarse la regla v2, las tx firmadas bajo v1 que seguían en el
    /// mempool ya no pueden entrar en ningún bloque: se retiran (su autor
    /// debe volver a firmarlas; el nonce no se consumió). Solo actúa al cruzar
    /// la fecha: antes de ella el mempool no cambia.
    fn podar_mempool_por_regla(&mut self) {
        let firma = self.firma_ctx(now_secs());
        if firma.regla != rami_core::tx::Regla::V2 {
            return;
        }
        let antes = self.mempool.len();
        self.mempool.retain(|t| verify_tx_con(t, &firma).is_ok());
        if self.mempool.len() != antes {
            self.persist_mempool();
            self.refresh_candidate();
        }
    }

    fn persist_mempool(&self) {
        let _ = self.chain.clear_mempool();
        for t in &self.mempool {
            let _ = self.chain.append_mempool(t);
        }
    }

    fn publish_status(&self) {
        let head = self.tree.head();
        let node = self.tree.get(&head);
        let st = self.tree.head_state().unwrap_or_default();
        let mut supply: u128 = 0;
        for acc in st.accounts.values() {
            supply += acc.balance as u128 + acc.staked as u128;
        }
        let best_peer = self.peer_height.values().copied().max().unwrap_or(0);
        let height = node.map(|n| n.block.header.height).unwrap_or(0);
        let peers: Vec<PeerView> = self
            .peer_meta
            .iter()
            .map(|(id, (addr, inbound, dial))| {
                let pt = self.peer_tips.get(id);
                let ident = self.peer_ident.get(id);
                let mut g = self.graduacion_de(*id);
                let regla_tx = self.peer_rule.get(id).copied().unwrap_or(0);
                let ctx_ahora = self.firma_ctx(now_secs());
                if self.tree.params().firma_v2_desde.is_some() && regla_tx < REGLA_V2 {
                    // Hecho, no juicio: lo que anuncia el par y lo que eso
                    // significa según rija ya la regla v2 o todavía no.
                    let que = match regla_tx {
                        0 => "no anuncia regla de firma (binario anterior a v0.8.0)".to_string(),
                        r => format!("anuncia regla de firma v{r}"),
                    };
                    let efecto = if ctx_ahora.regla == rami_core::tx::Regla::V2 {
                        "no sigue la cadena desde la activación de la regla v2"
                    } else {
                        "quedará fuera al activarse la regla v2"
                    };
                    g.motivos.push(format!("{que}: {efecto}"));
                } else if self.tree.params().dubai_desde.is_some() && regla_tx < REGLA_SOPORTADA {
                    let efecto = if ctx_ahora.dubai {
                        "no sigue la cadena desde la activación de Dubái"
                    } else {
                        "quedará fuera al activarse Dubái"
                    };
                    g.motivos.push(format!("anuncia la regla {regla_tx} sin Dubái (binario anterior a v0.9.0): {efecto}"));
                }
                PeerView {
                    addr: dial.clone().unwrap_or_else(|| addr.clone()),
                    inbound: *inbound,
                    fingerprint: ident.map(|(_, f)| f.clone()).unwrap_or_default(),
                    pubkey: ident.map(|(p, _)| p.clone()).unwrap_or_default(),
                    height: self.peer_height.get(id).copied().unwrap_or(0),
                    tips: pt.map(|t| t.tips.len()).unwrap_or(0),
                    best_work: pt.map(|t| t.best_work().to_string()).unwrap_or_default(),
                    fuente: g.codigo,
                    fiabilidad: g.fiabilidad.to_string(),
                    credibilidad: g.credibilidad,
                    motivos: g.motivos,
                    regla_tx,
                }
            })
            .collect();
        let tips = self.tree.tips().len();
        let status = NodeStatus {
            network: if self.is_testnet { "testnet".into() } else { "regtest".into() },
            network_id: hex::encode(self.network_id),
            node_id: self.net.node_id,
            node_fingerprint: self.net.fingerprint.clone(),
            secure: true,
            listen_port: self.net.listen_port,
            height,
            head: hex::encode(head),
            difficulty: node.map(|n| difficulty_from_bits(n.block.header.bits)).unwrap_or(0),
            work: node.map(|n| n.cum_work).unwrap_or(0).to_string(),
            tips,
            blocks_total: self.tree.len(),
            supply_ram: format!("{}.{:08}", supply / COIN as u128, supply % COIN as u128),
            mempool: self.mempool.len(),
            peers,
            synced: height >= best_peer,
            mining: self.mining.on.load(Ordering::Relaxed),
            hashrate: self.mining.hashrate.load(Ordering::Relaxed),
            found: self.mining.found.load(Ordering::Relaxed),
            netinfo: self.netinfo.lock().map(|g| g.clone()).unwrap_or_default(),
            universe: UniverseInfo {
                blocks: self.tree.len(),
                tips,
                branches_synced: self.branches_synced,
                last_sync_from: self.last_sync_from.clone(),
                last_sync_fuente: self.last_sync_fuente.clone(),
            },
            consenso: {
                let ahora = now_secs();
                let v2_desde = self.tree.params().firma_v2_desde;
                let dubai_desde = self.tree.params().dubai_desde;
                let ctx = self.firma_ctx(ahora);
                ConsensoInfo {
                    regla_vigente: ctx.numero(),
                    regla_soportada: REGLA_SOPORTADA,
                    v2_desde,
                    faltan_segundos: v2_desde.map(|d| d.saturating_sub(ahora)).unwrap_or(0),
                    pares_v2: self.peer_rule.values().filter(|r| **r >= REGLA_V2).count(),
                    pares_total: self.peer_meta.len(),
                    mempool_fuera_de_regla: self.mempool_fuera_de_regla(),
                    dubai_desde,
                    dubai_vigente: ctx.dubai,
                    dubai_faltan_segundos: if ctx.dubai { 0 } else { dubai_desde.map(|d| d.saturating_sub(ahora)).unwrap_or(0) },
                    pares_dubai: self.peer_rule.values().filter(|r| **r >= REGLA_SOPORTADA).count(),
                }
            },
            sync: SyncInfo {
                mi_altura: height,
                mejor_altura_pares: best_peer,
                pares_a_mi_altura: self.peer_height.values().filter(|h| **h <= height).count(),
                pares_total: self.peer_height.len(),
                atras: best_peer.saturating_sub(height),
            },
        };
        if let Ok(mut g) = self.status.lock() {
            *g = status;
        }
    }
}

fn miner_loop(shared: Arc<MiningShared>, tx: Sender<NodeMsg>) {
    let mut local: Option<MiningJob> = None;
    let mut local_epoch = u64::MAX;
    // Tras encontrar un bloque, espera a que el nodo publique una época NUEVA
    // y no vuelvas a enviar la misma cabecera: con dificultad baja (regtest)
    // recargar el mismo trabajo producía miles de `Mined` duplicados por
    // segundo que saturaban el hilo del nodo (panel y órdenes sin respuesta).
    let mut wait_new_epoch = false;
    let mut last_found: Option<Vec<u8>> = None;
    let mut hashes = 0u64;
    let mut t0 = Instant::now();
    loop {
        if !shared.on.load(Ordering::Relaxed) {
            local = None;
            wait_new_epoch = false;
            shared.hashrate.store(0, Ordering::Relaxed);
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        let cur = shared.epoch.load(Ordering::Relaxed);
        if wait_new_epoch {
            if cur == local_epoch {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            wait_new_epoch = false;
        }
        if local.is_none() || local_epoch != cur {
            local = shared.job.lock().unwrap().clone();
            local_epoch = cur;
            // Misma cabecera que la ya encontrada => no la reenvíes; espera.
            if let (Some(j), Some(lf)) = (local.as_ref(), last_found.as_ref()) {
                if &j.header.canonical_bytes() == lf {
                    local = None;
                    wait_new_epoch = true;
                    continue;
                }
            }
        }
        let Some(job) = local.as_mut() else {
            thread::sleep(Duration::from_millis(50));
            continue;
        };
        let mut found = false;
        for _ in 0..MINE_CHUNK {
            if meets_target(&pow_hash(&job.header.canonical_bytes()), job.header.bits) {
                found = true;
                break;
            }
            job.header.nonce = job.header.nonce.wrapping_add(1);
            hashes += 1;
        }
        if found {
            if shared.epoch.load(Ordering::Relaxed) == local_epoch {
                last_found = Some(job.header.canonical_bytes());
                let block = Block { header: job.header.clone(), txs: job.txs.clone() };
                if tx.send(NodeMsg::Mined(block)).is_err() {
                    return;
                }
            }
            local = None;
            wait_new_epoch = true; // espera a que el nodo publique el siguiente candidato
        }
        let dt = t0.elapsed().as_secs_f64();
        if dt >= 1.0 {
            shared.hashrate.store((hashes as f64 / dt) as u64, Ordering::Relaxed);
            hashes = 0;
            t0 = Instant::now();
        }
    }
}
