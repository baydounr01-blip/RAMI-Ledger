//! Pruebas de integración: nodos reales sobre TCP que comparten el génesis
//! canónico de testnet. La sincronización es la del universo de ramas
//! (`Tips` -> `GetBranch` -> `Branch`): toda rama válida llega a todos.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rami_core::block::{Block, BlockHeader, Hash};
use rami_core::blocktree::BlockTree;
use rami_core::params::Params;
use rami_core::pow::{meets_target, pow_hash};
use rami_core::state::block_reward;
use rami_core::store::ChainDir;
use rami_core::tx::{merkle_root_txids, txid, Tx, TxId};
use rami_net::{handshake_initiator, Frame, NodeIdentity, SecureStream, TipInfo};
use rami_node::{spawn, NodeConfig, NodeHandle};

/// Las pruebas con PoW REAL de testnet (varios nodos minando a la vez) se
/// ejecutan de una en una: en un runner de CI compartido, en paralelo agotarían
/// su presupuesto de tiempo. Las de regtest no lo necesitan.
static POW_LOCK: Mutex<()> = Mutex::new(());

fn tmpdir(tag: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let uniq = format!(
        "rami-it-{}-{nanos}-{}-{tag}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let dir = std::env::temp_dir().join(uniq);
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn wait_height(h: &rami_node::NodeHandle, target: u64, secs: u64) -> u64 {
    let t0 = Instant::now();
    let mut last = 0;
    while t0.elapsed() < Duration::from_secs(secs) {
        last = h.status().height;
        if last >= target {
            return last;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    last
}

#[test]
fn two_nodes_share_genesis_and_sync() {
    let _pow = POW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let da = tmpdir("a");
    let db = tmpdir("b");

    // Nodo A: testnet, escucha efímera, minando.
    let a = spawn(NodeConfig {
        chain_dir: da.clone(),
        params: Params::testnet(),
        is_testnet: true,
        listen: Some(0),
        seeds: vec![],
        miner: Some([1u8; 32]),
        mining: true,
        lan_discovery: false,
        portmap: false,
    })
    .expect("A no arrancó");

    // Espera a conocer el puerto de escucha real.
    let mut port = 0;
    let t0 = Instant::now();
    while port == 0 && t0.elapsed() < Duration::from_secs(3) {
        port = a.status().listen_port;
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(port > 0, "A debe escuchar en un puerto");

    // A debe minar unos cuantos bloques de arranque (dificultad baja => rápido).
    let ah = wait_height(&a, 5, 15);
    assert!(ah >= 5, "A no minó bloques de arranque (altura {ah})");

    // Nodo B: testnet, marca a A, sin minar.
    let b = spawn(NodeConfig {
        chain_dir: db.clone(),
        params: Params::testnet(),
        is_testnet: true,
        listen: Some(0),
        seeds: vec![format!("127.0.0.1:{port}")],
        miner: None,
        mining: false,
        lan_discovery: false,
        portmap: false,
    })
    .expect("B no arrancó");

    // Mismo network-id (génesis canónico compartido).
    assert_eq!(a.status().network_id, b.status().network_id, "network-id distinto");

    // B debe sincronizar al menos hasta 5 desde A (Tips -> GetBranch -> Branch).
    let bh = wait_height(&b, 5, 20);
    assert!(bh >= 5, "B no sincronizó (altura {bh})");
    assert_eq!(b.status().peers.len(), 1, "B debería tener 1 par");
    let bs = b.status();
    assert!(bs.universe.branches_synced >= 1, "B no aplicó ningún lote Branch");
    assert!(bs.universe.last_sync_from.contains("127.0.0.1"), "origen del lote: {}", bs.universe.last_sync_from);

    // v0.3: B debe haber persistido la dirección remarcable de A (peers.json)
    // para re-marcarla en el próximo arranque (descubrimiento sin servidor).
    let peers_file = db.join("peers.json");
    let mut saved = String::new();
    for _ in 0..50 {
        saved = std::fs::read_to_string(&peers_file).unwrap_or_default();
        if saved.contains(&format!("127.0.0.1:{port}")) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        saved.contains(&format!("127.0.0.1:{port}")),
        "B no persistió el par remarcable de A en peers.json (contenido: {saved})"
    );

    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

/// Detiene el minero de `h` y espera a que el nodo lo confirme y la altura se
/// estabilice (un `Mined` ya encolado podría aceptarse justo después de la
/// orden). Devuelve la altura final.
fn stop_mining_and_settle(h: &rami_node::NodeHandle) -> u64 {
    h.set_mining(false);
    let t0 = Instant::now();
    while h.status().mining && t0.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!h.status().mining, "el minero no se detuvo");
    // altura estable durante medio segundo
    loop {
        let a = h.status().height;
        std::thread::sleep(Duration::from_millis(500));
        if h.status().height == a {
            return a;
        }
        assert!(t0.elapsed() < Duration::from_secs(10), "la altura no se estabiliza");
    }
}

fn listen_port(h: &rami_node::NodeHandle) -> u16 {
    let t0 = Instant::now();
    loop {
        let p = h.status().listen_port;
        if p > 0 || t0.elapsed() > Duration::from_secs(3) {
            return p;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Universo de bloques ramificados: dos nodos aislados minan ramas distintas
/// desde el mismo génesis; al conectarse, CADA bloque de AMBAS ramas acaba en
/// los dos árboles (ninguna rama se descarta) y los dos observan la misma
/// cabeza (la rama más pesada).
#[test]
fn universe_merges_divergent_branches() {
    let _pow = POW_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let da = tmpdir("ua");
    let db = tmpdir("ub");

    let mk = |dir: &PathBuf, miner: u8| {
        spawn(NodeConfig {
            chain_dir: dir.clone(),
            params: Params::testnet(),
            is_testnet: true,
            listen: Some(0),
            seeds: vec![],
            miner: Some([miner; 32]),
            mining: true,
            lan_discovery: false,
            portmap: false,
        })
        .expect("el nodo no arrancó")
    };
    let a = mk(&da, 0xA1);
    let b = mk(&db, 0xB2);
    let port_a = listen_port(&a);
    assert!(port_a > 0, "A debe escuchar en un puerto");

    // Cada uno mina su propia rama, sin conocerse (sin seeds).
    assert!(wait_height(&a, 4, 30) >= 4, "A no minó su rama");
    assert!(wait_height(&b, 2, 30) >= 2, "B no minó su rama");
    let a_blocks = stop_mining_and_settle(&a);
    let b_blocks = stop_mining_and_settle(&b);
    assert!(a_blocks >= 4 && b_blocks >= 2);
    assert_eq!(a.status().peers.len(), 0, "A no debía tener pares aún");
    assert_eq!(a.status().tips, 1);
    assert_eq!(b.status().tips, 1);
    assert_ne!(a.status().head, b.status().head, "las ramas deben ser distintas");

    // B marca a A: intercambio de Tips y fusión del universo.
    b.add_peer(format!("127.0.0.1:{port_a}"));

    let want_total = 1 + a_blocks as usize + b_blocks as usize;
    let t0 = Instant::now();
    let (mut sa, mut sb) = (a.status(), b.status());
    while t0.elapsed() < Duration::from_secs(30) {
        sa = a.status();
        sb = b.status();
        // Condición de reposo: ambos árboles completos, misma cabeza y cada uno
        // ha recibido ya el reanuncio de Tips del otro (2 puntas).
        let merged = sa.blocks_total == want_total && sb.blocks_total == want_total && sa.head == sb.head;
        let seen = sa.peers.iter().any(|p| p.tips == 2) && sb.peers.iter().any(|p| p.tips == 2);
        if merged && seen {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(sa.blocks_total, want_total, "A no tiene todos los bloques de ambas ramas");
    assert_eq!(sb.blocks_total, want_total, "B no tiene todos los bloques de ambas ramas");
    assert_eq!(sa.tips, 2, "A debería ver dos puntas");
    assert_eq!(sb.tips, 2, "B debería ver dos puntas");
    assert_eq!(sa.universe.tips, 2);
    assert_eq!(sb.universe.tips, 2);
    assert_eq!(sa.universe.blocks, want_total);
    assert_eq!(sb.universe.blocks, want_total);
    assert_eq!(sa.head, sb.head, "ambos deben observar la misma cabeza (rama más pesada)");
    assert_eq!(sa.work, sb.work);
    // ambos aplicaron al menos un lote de rama del otro
    assert!(sa.universe.branches_synced >= 1 && sb.universe.branches_synced >= 1);
    // los pares se ven mutuamente con dos puntas anunciadas
    assert!(sa.peers.iter().any(|p| p.tips == 2), "A no registró las puntas de B: {:?}", sa.peers);
    assert!(sb.peers.iter().any(|p| p.tips == 2), "B no registró las puntas de A: {:?}", sb.peers);

    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

// ------------------------- regtest: cadenas preconstruidas -------------------------

/// Bloque minado (regtest: dificultad 1, instantáneo) con un solo coinbase.
fn mined_block(height: u64, prev: Hash, bits: u32, miner: [u8; 32], ts: u64, tag: [u8; 4]) -> Block {
    let txs = vec![Tx::Coinbase { height, to: miner, reward: block_reward(height), memo: vec![] }];
    let ids: Vec<TxId> = txs.iter().map(txid).collect();
    let mut header = BlockHeader {
        version: 1, prev_hash: prev, height, timestamp: ts,
        merkle_root: merkle_root_txids(&ids), bits, nonce: 0, branch_tag: tag,
    };
    while !meets_target(&pow_hash(&header.canonical_bytes()), header.bits) {
        header.nonce += 1;
    }
    Block { header, txs }
}

/// Extiende `prev` con `n` bloques (60 s entre ellos) admitiéndolos en `tree`;
/// devuelve los bloques en orden ascendente.
fn extend(tree: &mut BlockTree, prev: Hash, n: usize, miner: u8, ts0: u64) -> Vec<Block> {
    let mut out = Vec::new();
    let mut prev = prev;
    for i in 0..n {
        let height = tree.get(&prev).unwrap().block.header.height + 1;
        let bits = tree.expected_bits(&prev);
        let tag = [miner, b'_', (i / 100) as u8 + b'0', (i % 100) as u8];
        let b = mined_block(height, prev, bits, [miner; 32], ts0 + 60 * (i as u64 + 1), tag);
        prev = tree.insert(b.clone()).unwrap();
        out.push(b);
    }
    out
}

/// Génesis regtest compartido por todos los nodos de una prueba.
fn regtest_genesis() -> Block {
    rami_node::make_genesis(false, Params::regtest(), [7u8; 32])
}

/// Escribe en `dir` una cadena regtest: génesis + `blocks` (en orden).
fn write_chain(dir: &Path, genesis: &Block, blocks: &[&[Block]]) {
    let cd = ChainDir::new(dir);
    cd.init(genesis).expect("init");
    for group in blocks {
        for b in group.iter() {
            cd.append_block(b).expect("append");
        }
    }
}

fn regtest_node(dir: &Path, listen: bool, seeds: Vec<String>) -> NodeHandle {
    spawn(NodeConfig {
        chain_dir: dir.to_path_buf(),
        params: Params::regtest(),
        is_testnet: false,
        listen: if listen { Some(0) } else { None },
        seeds,
        miner: None,
        mining: false,
        lan_discovery: false,
        portmap: false,
    })
    .expect("el nodo no arrancó")
}

/// Espera hasta `secs` a que TODOS los nodos tengan `total` bloques y `tips` puntas.
fn wait_universe(nodes: &[&NodeHandle], total: usize, tips: usize, secs: u64) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        if nodes.iter().all(|n| {
            let s = n.status();
            s.blocks_total == total && s.tips == tips
        }) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Bifurcación PROFUNDA (muy por debajo de las muestras densas del
/// localizador): A tiene 1000 bloques; B comparte los 300 primeros y sigue 50
/// por su cuenta. La rama de B empieza 700 bloques por debajo de la cabeza de A,
/// así que el primer lote que A recibe son bloques que ya tiene: la
/// continuación por cursor debe reanudar tras él en vez de repetirlo. Sin
/// minar: ningún azar puede sacar a los nodos de un estancamiento.
#[test]
fn deep_fork_syncs_via_cursor() {
    let g = regtest_genesis();
    let mut ta = BlockTree::new(g.clone(), Params::regtest()).unwrap();
    let mut tb = BlockTree::new(g.clone(), Params::regtest()).unwrap();
    let trunk = extend(&mut ta, g.hash(), 300, b'A', 1_700_000_000);
    let a_more = extend(&mut ta, trunk.last().unwrap().hash(), 700, b'A', 1_700_000_000 + 60 * 300);
    for b in &trunk {
        tb.insert(b.clone()).unwrap();
    }
    let b_fork = extend(&mut tb, trunk.last().unwrap().hash(), 50, b'B', 1_700_000_000 + 60 * 300);
    let da = tmpdir("deep-a");
    let db = tmpdir("deep-b");
    write_chain(&da, &g, &[&trunk, &a_more]);
    write_chain(&db, &g, &[&trunk, &b_fork]);

    let a = regtest_node(&da, true, vec![]);
    let port_a = listen_port(&a);
    assert!(port_a > 0);
    assert_eq!(a.status().height, 1000);
    let b = regtest_node(&db, true, vec![format!("127.0.0.1:{port_a}")]);
    assert_eq!(b.status().height, 350);
    assert_eq!(a.status().network_id, b.status().network_id);

    let total = 1 + 300 + 700 + 50;
    assert!(wait_universe(&[&a, &b], total, 2, 60), "universo sin fusionar: A={:?} B={:?}", a.status().universe, b.status().universe);
    let (sa, sb) = (a.status(), b.status());
    assert_eq!(sa.head, sb.head, "misma cabeza (la rama más pesada)");
    assert_eq!(sa.height, 1000);
    assert_eq!(sb.height, 1000);
    assert!(sa.universe.branches_synced >= 1 && sb.universe.branches_synced >= 1);
    // el par de A (B) anunció sus dos puntas y viceversa (delta de Tips)
    let t0 = Instant::now();
    let seen = loop {
        let (sa, sb) = (a.status(), b.status());
        if sa.peers.iter().any(|p| p.tips == 2) && sb.peers.iter().any(|p| p.tips == 2) {
            break true;
        }
        if t0.elapsed() > Duration::from_secs(10) {
            break false;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(seen, "los pares no vieron las dos puntas: {:?} / {:?}", a.status().peers, b.status().peers);

    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

/// Tres nodos en línea A - B - C: C solo conoce a B (ni A ni C escuchan, así
/// que ni el intercambio de pares puede acercarlos). La rama lateral que solo
/// tiene A debe llegar a C a través de los `Tips` de B.
#[test]
fn side_branch_reaches_node_two_hops_away() {
    let g = regtest_genesis();
    let mut ta = BlockTree::new(g.clone(), Params::regtest()).unwrap();
    let trunk = extend(&mut ta, g.hash(), 20, b'T', 1_700_000_000);
    let side = extend(&mut ta, trunk[9].hash(), 3, b'S', 1_700_900_000);
    let (da, db, dc) = (tmpdir("hop-a"), tmpdir("hop-b"), tmpdir("hop-c"));
    write_chain(&da, &g, &[&trunk, &side]);
    write_chain(&db, &g, &[&trunk]);
    write_chain(&dc, &g, &[&trunk]);

    let b = regtest_node(&db, true, vec![]);
    let port_b = listen_port(&b);
    assert!(port_b > 0);
    let c = regtest_node(&dc, false, vec![format!("127.0.0.1:{port_b}")]);
    let a = regtest_node(&da, false, vec![format!("127.0.0.1:{port_b}")]);
    assert_eq!(a.status().tips, 2);

    let total = 1 + 20 + 3;
    assert!(wait_universe(&[&a, &b, &c], total, 2, 40), "C no recibió la rama lateral: {:?}", c.status().universe);
    let sc = c.status();
    assert_eq!(sc.peers.len(), 1, "C solo debía conocer a B: {:?}", sc.peers);
    assert_eq!(sc.head, a.status().head);
    assert!(sc.universe.last_sync_from.contains(&format!("127.0.0.1:{port_b}")), "C sincronizó de B: {}", sc.universe.last_sync_from);

    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
    let _ = std::fs::remove_dir_all(&dc);
}

/// Cliente crudo del protocolo (un «par» que hace lo que quiere), pero por el
/// Túnel RAMI: sin identidad con prueba de trabajo y handshake firmado, el
/// nodo ni le escucha.
struct RawPeer {
    s: SecureStream,
}

impl RawPeer {
    fn connect(port: u16, net_hex: &str) -> RawPeer {
        let net: [u8; 32] = hex::decode(net_hex).unwrap().try_into().unwrap();
        let id = NodeIdentity::from_seed_search([0x42; 32]);
        let w = TcpStream::connect(("127.0.0.1", port)).expect("conexión TCP");
        w.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let (s, peer) = handshake_initiator(w, &net, &id, 0).expect("handshake del túnel");
        assert_eq!(peer.fingerprint.len(), 19);
        RawPeer { s }
    }
    fn send(&mut self, f: &Frame) {
        self.s.write_frame(f).expect("write");
    }
    fn recv(&mut self, timeout: Duration) -> Option<Frame> {
        self.s.reader.get_ref().get_ref().set_read_timeout(Some(timeout)).unwrap();
        loop {
            match self.s.read_frame() {
                Ok(f) => return Some(f),
                Err(rami_net::FrameError::Parse) => continue,
                Err(_) => return None,
            }
        }
    }
    /// Frames recibidos durante `window` (sin bloquear más).
    fn drain(&mut self, window: Duration) -> Vec<Frame> {
        let t0 = Instant::now();
        let mut out = Vec::new();
        while t0.elapsed() < window {
            let left = window.saturating_sub(t0.elapsed()).max(Duration::from_millis(10));
            match self.recv(left) {
                Some(f) => out.push(f),
                None => break,
            }
        }
        out
    }
}

fn fake_tips(seed: u8, n: usize) -> Vec<TipInfo> {
    (0..n)
        .map(|i| {
            let mut h = [seed; 32];
            h[0] = (i % 256) as u8;
            h[1] = (i / 256) as u8;
            TipInfo { hash: hex::encode(h), height: 1_000_000 + i as u64, work: "1".into() }
        })
        .collect()
}

/// Par adversario: anuncia cientos de puntas inventadas y responde lotes
/// vacíos con `more`. El nodo debe pedir como mucho MAX_INFLIGHT_PER_PEER
/// ramas a la vez (sin amplificación), no continuar sin progreso y seguir
/// atendiendo peticiones legítimas.
#[test]
fn hostile_tips_do_not_amplify_requests() {
    let g = regtest_genesis();
    let mut ta = BlockTree::new(g.clone(), Params::regtest()).unwrap();
    let chain = extend(&mut ta, g.hash(), 10, b'A', 1_700_000_000);
    let da = tmpdir("hostile-a");
    write_chain(&da, &g, &[&chain]);
    let a = regtest_node(&da, true, vec![]);
    let port = listen_port(&a);
    let net_hex = a.status().network_id;

    let mut p = RawPeer::connect(port, &net_hex);
    // tras el handshake el nodo nos manda Status, Tips (1 punta) y GetPeers
    let hello = p.drain(Duration::from_millis(500));
    assert!(hello.iter().any(|f| matches!(f, Frame::Tips { tips, partial: false } if tips.len() == 1)), "{hello:?}");

    // 1) 256 puntas inventadas => como mucho 4 GetBranch, no 256.
    p.send(&Frame::Tips { tips: fake_tips(0xAA, 256), partial: false });
    let got = p.drain(Duration::from_millis(1500));
    let reqs: Vec<&Frame> = got.iter().filter(|f| matches!(f, Frame::GetBranch { .. })).collect();
    assert!(!reqs.is_empty(), "debería pedir alguna rama");
    assert!(reqs.len() <= 4, "amplificación: {} GetBranch por un Tips", reqs.len());
    let Frame::GetBranch { tip, known, .. } = reqs[0].clone() else { unreachable!() };
    assert!(known.len() < 64, "localizador desmesurado: {}", known.len());

    // 2) más Tips inventadas mientras las ranuras siguen ocupadas => nada nuevo.
    p.send(&Frame::Tips { tips: fake_tips(0xBB, 256), partial: true });
    p.send(&Frame::Tips { tips: fake_tips(0xCC, 256), partial: true });
    let got = p.drain(Duration::from_millis(1000));
    assert_eq!(got.iter().filter(|f| matches!(f, Frame::GetBranch { .. })).count(), 0, "{got:?}");

    // 3) lote vacío con `more`: sin progreso no hay continuación inmediata.
    p.send(&Frame::Branch { tip: tip.clone(), blocks: vec![], more: true });
    let got = p.drain(Duration::from_millis(1000));
    assert_eq!(got.iter().filter(|f| matches!(f, Frame::GetBranch { .. })).count(), 0, "{got:?}");

    // 4) el nodo sigue sirviendo: su rama real entera en un lote.
    p.send(&Frame::GetBranch { tip: a.status().head, known: vec![], max: 512 });
    let got = p.drain(Duration::from_millis(1000));
    let served = got.iter().find_map(|f| match f {
        Frame::Branch { blocks, more, .. } => Some((blocks.len(), *more)),
        _ => None,
    });
    assert_eq!(served, Some((10, false)));
    // y el par sigue conectado (nada de esto es motivo de expulsión por sí solo)
    assert_eq!(a.status().peers.len(), 1);

    let _ = std::fs::remove_dir_all(&da);
}
