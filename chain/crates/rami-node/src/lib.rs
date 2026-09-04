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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use rami_core::block::{Block, BlockHeader, Hash};
use rami_core::params::Params;
use rami_core::pow::{difficulty_from_bits, meets_target, pow_hash};
use rami_core::state::{block_reward, Account, State, COIN};
use rami_core::store::ChainDir;
use rami_core::tx::{merkle_root_txids, signer_of, txid, verify_tx, AccountId, Tx, TxId};

use rami_net::{Frame, NetConfig, NetEvent, Network};

/// Mensaje del coinbase (aparece en cada bloque minado).
pub const CHANCELLOR: &str =
    "RAMI-Chain — el pasado, el presente y el futuro coexisten. Testnet experimental, sin valor monetario.";

/// Tamaño de lote de sincronización (bloques por petición).
const SYNC_BATCH: u32 = 256;
/// Tope de bloques servidos en una respuesta.
const SERVE_MAX: usize = 512;
/// Hashes por vuelta del minero antes de refrescar métricas/epoch.
const MINE_CHUNK: u64 = 120_000;

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

pub fn tx_fee(tx: &Tx) -> u64 {
    rami_core::tx::fee_of(tx)
}

/// Comprobación de una tx suelta contra una copia del estado, con las MISMAS
/// reglas que la validación de bloques (`apply_tx`): así el mempool y el bloque
/// candidato nunca admiten una tx que luego invalidaría el bloque minado (y
/// dejaría al minero atascado). `height` = altura del bloque en que iría.
/// Mutar `sim` permite encadenar varias en el mismo bloque candidato.
fn try_apply(sim: &mut State, tx: &Tx, height: u64) -> Result<(), String> {
    if matches!(tx, Tx::Coinbase { .. }) {
        return Err("coinbase no va en mempool".into());
    }
    rami_core::state::apply_tx(sim, tx, height, 1, &txid(tx))
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
) -> (BlockHeader, Vec<Tx>, Vec<TxId>) {
    let mut sim = state.clone();
    let mut included: Vec<Tx> = Vec::new();
    let mut fees: u128 = 0;
    for tx in mempool {
        if verify_tx(tx).is_err() {
            continue;
        }
        if try_apply(&mut sim, tx, height).is_ok() {
            fees += tx_fee(tx) as u128;
            included.push(tx.clone());
        }
    }
    let reward = (block_reward(height) as u128 + fees).min(u64::MAX as u128) as u64;
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
) -> (Block, Vec<TxId>) {
    let (header, txs, ids) = build_candidate(height, prev, bits, miner, state, mempool, tag, now_secs());
    (Block { header: mine_header(header), txs }, ids)
}

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
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct PeerView {
    pub addr: String,
    pub inbound: bool,
    pub height: u64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct NodeStatus {
    pub network: String,
    pub network_id: String,
    pub node_id: u64,
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
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct CityView {
    pub size: u16,
    pub height: u64,
    pub parcel_price: u64,
    pub mint_price: u64,
    pub parcels: Vec<ParcelView>,
    pub assets: Vec<AssetView>,
}

fn city_view(st: &State, height: u64) -> CityView {
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
        })
        .collect();
    CityView {
        size: rami_core::tx::CITY_SIZE,
        height,
        parcel_price: rami_core::state::PARCEL_PRICE,
        mint_price: rami_core::state::MINT_PRICE,
        parcels,
        assets,
    }
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
}

struct Node {
    tree: rami_core::blocktree::BlockTree,
    chain: ChainDir,
    is_testnet: bool,
    network_id: Hash,
    mempool: Vec<Tx>,
    seen_tx: HashSet<TxId>,
    seen_block: HashSet<Hash>,
    peer_height: HashMap<rami_net::PeerId, u64>,
    /// peer -> (addr del socket, entrante, dirección REMARCABLE si el par escucha)
    peer_meta: HashMap<rami_net::PeerId, (String, bool, Option<String>)>,
    /// Pares conocidos remarcables; se persisten en peers.json del directorio de
    /// cadena y se re-marcan al arrancar (descubrimiento sin servidor central).
    known_peers: HashSet<String>,
    net: Network,
    mining: Arc<MiningShared>,
    miner: Option<AccountId>,
    mining_on: bool,
    sync_backoff: u64,
    last_candidate_ts: u64,
    status: Arc<Mutex<NodeStatus>>,
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

    let node_id = {
        use rand_core::{OsRng, RngCore};
        OsRng.next_u64()
    };
    let (net, net_rx) = Network::start(NetConfig {
        network_id: genesis_hash,
        node_id,
        listen: cfg.listen,
        seeds: cfg.seeds.clone(),
        max_peers: 32,
    });

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

    let mut node = Node {
        tree,
        chain,
        is_testnet: cfg.is_testnet,
        network_id: genesis_hash,
        mempool: Vec::new(),
        seen_tx: HashSet::new(),
        seen_block: HashSet::new(),
        peer_height: HashMap::new(),
        peer_meta: HashMap::new(),
        known_peers: HashSet::new(),
        net,
        mining: mining.clone(),
        miner: cfg.miner,
        mining_on: cfg.mining && cfg.miner.is_some(),
        sync_backoff: 0,
        last_candidate_ts: 0,
        status: status.clone(),
    };
    // Carga el mempool persistido.
    node.mempool = node.chain.load_mempool();
    for t in &node.mempool {
        node.seen_tx.insert(txid(t));
    }
    // Descubrimiento: re-marca los pares conocidos de sesiones anteriores
    // (peers.json), además de los seeds pasados por configuración.
    node.known_peers = load_known_peers(&node.chain.root);
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

    fn my_status_frame(&self) -> Frame {
        let head = self.tree.head();
        Frame::Status {
            height: self.head_height(),
            best: hex::encode(head),
            work: self.tree.get(&head).map(|n| n.cum_work).unwrap_or(0).to_string(),
        }
    }

    fn on_net(&mut self, ev: NetEvent) {
        match ev {
            NetEvent::Connected { peer, addr, inbound, dial_addr } => {
                self.peer_height.insert(peer, 0);
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
                self.net.send(peer, Frame::GetPeers);
            }
            NetEvent::Disconnected { peer } => {
                self.peer_height.remove(&peer);
                self.peer_meta.remove(&peer);
            }
            NetEvent::Message { peer, frame } => self.on_frame(peer, frame),
        }
        self.publish_status();
    }

    fn on_frame(&mut self, peer: rami_net::PeerId, frame: Frame) {
        match frame {
            Frame::Hello { .. } => {}
            Frame::Status { height, .. } => {
                self.peer_height.insert(peer, height);
            }
            Frame::GetBlocks { from, max } => {
                let chain = self.tree.observer_chain();
                let start = from as usize;
                let end = (start + (max as usize).min(SERVE_MAX)).min(chain.len());
                if start < chain.len() {
                    let blocks: Vec<Block> = chain[start..end]
                        .iter()
                        .filter_map(|h| self.tree.get(h).map(|n| n.block.clone()))
                        .collect();
                    if !blocks.is_empty() {
                        self.net.send(peer, Frame::Blocks { blocks });
                    }
                }
            }
            Frame::Blocks { blocks } => {
                let before = self.head_height();
                let mut accepted = 0usize;
                let mut orphan = false;
                for b in blocks {
                    match self.accept_block(b, None) {
                        Ok(true) => accepted += 1,
                        Ok(false) => {}
                        Err(e) => {
                            if e.contains("padre") {
                                orphan = true;
                            }
                        }
                    }
                }
                if accepted > 0 {
                    self.sync_backoff = 0;
                    self.refresh_candidate();
                    if self.head_height() != before {
                        self.net.broadcast(self.my_status_frame());
                    }
                } else if orphan {
                    // vamos por otra rama: pide desde más atrás la próxima vez.
                    self.sync_backoff = (self.sync_backoff + SYNC_BATCH as u64).min(100_000);
                }
            }
            Frame::NewBlock { block } => {
                let h = block.hash();
                match self.accept_block(block, Some(peer)) {
                    Ok(true) => {
                        self.refresh_candidate();
                        self.net.broadcast(self.my_status_frame());
                    }
                    Ok(false) => {}
                    Err(e) => {
                        if e.contains("padre") {
                            // nos falta el padre: sincroniza desde este par.
                            let from = (self.head_height() + 1).saturating_sub(self.sync_backoff);
                            self.net.send(peer, Frame::GetBlocks { from, max: SYNC_BATCH });
                        }
                        let _ = h;
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
        }
        self.publish_status();
    }

    /// Admite un bloque en el árbol (revalida con las reglas de consenso) y lo
    /// persiste. Devuelve Ok(true) si era nuevo y se aceptó.
    fn accept_block(&mut self, block: Block, _from: Option<rami_net::PeerId>) -> Result<bool, String> {
        let h = block.hash();
        if self.seen_block.contains(&h) || self.tree.contains(&h) {
            return Ok(false);
        }
        let included: Vec<TxId> = block.txs.iter().map(txid).collect();
        self.tree.insert(block.clone())?;
        self.chain.append_block(&block)?;
        self.seen_block.insert(h);
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
        verify_tx(&tx).map_err(|e| format!("firma/estructura: {e}"))?;
        let id = txid(&tx);
        if self.seen_tx.contains(&id) {
            return Ok(hex::encode(id));
        }
        // Valida sobre el estado de la punta CON el mempool ya aplicado en orden,
        // para admitir nonces consecutivos del mismo firmante (p. ej. enviar y
        // luego comprometer sin esperar a que se mine el primero).
        let mut sim = self.tree.head_state().unwrap_or_default();
        let next_height = self.head_height() + 1;
        for t in &self.mempool {
            let _ = try_apply(&mut sim, t, next_height);
        }
        try_apply(&mut sim, &tx, next_height).map_err(|e| format!("no aplica: {e}"))?;
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
                self.net.broadcast(self.my_status_frame());
                self.refresh_candidate();
            }
            _ => self.refresh_candidate(),
        }
        self.publish_status();
    }

    fn on_tick(&mut self) {
        // Sincronización: si algún par va por delante, pide bloques.
        let our_h = self.head_height();
        let best = self.peer_height.values().copied().max().unwrap_or(0);
        if best > our_h {
            if let Some((&peer, _)) = self.peer_height.iter().max_by_key(|(_, h)| **h) {
                let from = (our_h + 1).saturating_sub(self.sync_backoff);
                self.net.send(peer, Frame::GetBlocks { from, max: SYNC_BATCH });
            }
        }
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
            NodeCmd::NextNonce(a, reply) => {
                let base = self.tree.head_state().map(|s| s.nonce_of(&a)).unwrap_or(0);
                let pending = self.mempool.iter().filter(|t| signer_of(t) == Some(&a)).count() as u64;
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
                let _ = reply.send(city_view(&st, self.head_height()));
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
        let (header, txs, _ids) =
            build_candidate(height, head, bits, miner, &state, &self.mempool, *b"main", ts);
        *self.mining.job.lock().unwrap() = Some(MiningJob { header, txs });
        self.mining.epoch.fetch_add(1, Ordering::Relaxed);
        self.mining.on.store(true, Ordering::Relaxed);
        self.last_candidate_ts = ts;
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
            .map(|(id, (addr, inbound, dial))| PeerView {
                addr: dial.clone().unwrap_or_else(|| addr.clone()),
                inbound: *inbound,
                height: self.peer_height.get(id).copied().unwrap_or(0),
            })
            .collect();
        let status = NodeStatus {
            network: if self.is_testnet { "testnet".into() } else { "regtest".into() },
            network_id: hex::encode(self.network_id),
            node_id: self.net.node_id,
            listen_port: self.net.listen_port,
            height,
            head: hex::encode(head),
            difficulty: node.map(|n| difficulty_from_bits(n.block.header.bits)).unwrap_or(0),
            work: node.map(|n| n.cum_work).unwrap_or(0).to_string(),
            tips: self.tree.tips().len(),
            blocks_total: self.tree.len(),
            supply_ram: format!("{}.{:08}", supply / COIN as u128, supply % COIN as u128),
            mempool: self.mempool.len(),
            peers,
            synced: height >= best_peer,
            mining: self.mining.on.load(Ordering::Relaxed),
            hashrate: self.mining.hashrate.load(Ordering::Relaxed),
            found: self.mining.found.load(Ordering::Relaxed),
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
