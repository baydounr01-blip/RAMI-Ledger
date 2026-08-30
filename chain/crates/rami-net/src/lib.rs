//! rami-net — gossip P2P de RAMI-Chain sobre TCP con framing JSON por líneas.
//!
//! Diseño *sin servidor central* (sin punto de fallo único): cada nodo escucha,
//! marca seeds, intercambia peers y retransmite bloques/transacciones. La capa
//! es SOLO transporte: valida el network-id en el handshake y entrega los
//! `Frame` al nodo, que revalida todo con las reglas de consenso. Nada aquí
//! decide validez de bloques.
//!
//! Concurrencia con `std` (hilos + canales), sin dependencias asíncronas:
//! - un **hilo central** es el único dueño de la tabla de pares;
//! - por conexión, un **hilo lector** (que además hace el handshake, para no
//!   perder bytes ya bufferizados) y un **hilo escritor**;
//! - un **hilo de escucha** acepta entrantes y un **hilo de mantenimiento**
//!   re-marca seeds caídos.

pub mod protocol;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub use protocol::{Frame, PROTO_VERSION};

pub type PeerId = u64;

/// Configuración de arranque de la red.
#[derive(Clone)]
pub struct NetConfig {
    /// network-id: hash del génesis. Solo se aceptan pares con el mismo.
    pub network_id: [u8; 32],
    /// Identificador aleatorio de ESTE proceso (evita auto-conexión y duplicados).
    pub node_id: u64,
    /// Puerto de escucha. `Some(0)` = efímero; `None` = solo salidas.
    pub listen: Option<u16>,
    /// Pares iniciales a los que marcar (`host:puerto`).
    pub seeds: Vec<String>,
    /// Tope de conexiones simultáneas.
    pub max_peers: usize,
}

impl NetConfig {
    fn net_hex(&self) -> String {
        hex::encode(self.network_id)
    }
}

/// Datos públicos de un par conectado.
#[derive(Clone, Debug)]
pub struct PeerInfo {
    pub peer: PeerId,
    pub addr: String,
    pub inbound: bool,
}

/// Eventos que la red entrega al nodo. `dial_addr` es la dirección REMARCABLE
/// del par (su IP + el puerto de escucha que anunció en el Hello); None si el
/// par no escucha. Para entrantes el `addr` del socket lleva un puerto efímero
/// que NO sirve para volver a conectar — usa `dial_addr`.
#[derive(Debug)]
pub enum NetEvent {
    Connected { peer: PeerId, addr: String, inbound: bool, dial_addr: Option<String> },
    Disconnected { peer: PeerId },
    Message { peer: PeerId, frame: Frame },
}

/// IP del socket + puerto anunciado => dirección remarcable.
fn dialable(addr: &str, announced_port: u16) -> Option<String> {
    if announced_port == 0 {
        return None;
    }
    // "1.2.3.4:5678" o "[::1]:5678" -> host es todo menos el último ':'
    let host = addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr);
    Some(format!("{host}:{announced_port}"))
}

// --- mensajería interna del hilo central ---
enum Internal {
    Inbound(TcpStream, String),
    Outbound(TcpStream, String),
    Registered {
        writer: TcpStream,
        addr: String,
        inbound: bool,
        node: u64,
        /// Puerto de escucha ANUNCIADO por el par en su Hello (0 = no escucha).
        port: u16,
        assign: Sender<PeerId>,
    },
    FromPeer(PeerId, Frame),
    PeerClosed(PeerId),
    Cmd(Cmd),
    Maintenance,
}

enum Cmd {
    Broadcast(Frame),
    Send(PeerId, Frame),
    Dial(String),
}

struct Peer {
    addr: String,
    inbound: bool,
    node: u64,
    out_tx: Sender<Frame>,
}

/// Manejador de la red (clonable). El nodo lo usa para difundir y marcar.
#[derive(Clone)]
pub struct Network {
    tx: Sender<Internal>,
    pub node_id: u64,
    pub listen_port: u16,
    peers: Arc<Mutex<Vec<PeerInfo>>>,
    count: Arc<AtomicUsize>,
}

impl Network {
    /// Arranca la red. Devuelve el manejador y el canal de eventos.
    pub fn start(cfg: NetConfig) -> (Network, Receiver<NetEvent>) {
        let (tx, rx) = channel::<Internal>();
        let (event_tx, event_rx) = channel::<NetEvent>();
        let peers = Arc::new(Mutex::new(Vec::new()));
        let count = Arc::new(AtomicUsize::new(0));

        // Escucha (si procede): se enlaza AQUÍ para conocer el puerto efímero real.
        let mut listen_port = 0u16;
        if let Some(port) = cfg.listen {
            match TcpListener::bind(("0.0.0.0", port)) {
                Ok(listener) => {
                    listen_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
                    let ltx = tx.clone();
                    thread::spawn(move || {
                        for stream in listener.incoming().flatten() {
                            let addr = stream
                                .peer_addr()
                                .map(|a| a.to_string())
                                .unwrap_or_else(|_| "?".into());
                            if ltx.send(Internal::Inbound(stream, addr)).is_err() {
                                break;
                            }
                        }
                    });
                }
                Err(e) => eprintln!("[net] no se pudo escuchar en :{port}: {e}"),
            }
        }

        // Marcado inicial de seeds.
        for s in &cfg.seeds {
            let _ = tx.send(Internal::Cmd(Cmd::Dial(s.clone())));
        }

        // Hilo de mantenimiento: re-marca seeds caídos cada 15 s.
        {
            let mtx = tx.clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(15));
                if mtx.send(Internal::Maintenance).is_err() {
                    break;
                }
            });
        }

        // Hilo central.
        {
            let cfg = cfg.clone();
            let peers_arc = peers.clone();
            let count_arc = count.clone();
            let ctx = tx.clone();
            thread::spawn(move || {
                central_loop(cfg, rx, ctx, event_tx, peers_arc, count_arc, listen_port);
            });
        }

        (Network { tx, node_id: cfg.node_id, listen_port, peers, count }, event_rx)
    }

    /// Difunde un frame a todos los pares.
    pub fn broadcast(&self, f: Frame) {
        let _ = self.tx.send(Internal::Cmd(Cmd::Broadcast(f)));
    }
    /// Envía un frame a un par concreto.
    pub fn send(&self, peer: PeerId, f: Frame) {
        let _ = self.tx.send(Internal::Cmd(Cmd::Send(peer, f)));
    }
    /// Marca (conecta) a una dirección `host:puerto`.
    pub fn dial(&self, addr: String) {
        let _ = self.tx.send(Internal::Cmd(Cmd::Dial(addr)));
    }
    /// Número de pares conectados.
    pub fn peer_count(&self) -> usize {
        self.count.load(Ordering::Relaxed)
    }
    /// Instantánea de los pares conectados.
    pub fn peers(&self) -> Vec<PeerInfo> {
        self.peers.lock().map(|p| p.clone()).unwrap_or_default()
    }
}

#[allow(clippy::too_many_arguments)]
fn central_loop(
    cfg: NetConfig,
    rx: Receiver<Internal>,
    tx: Sender<Internal>,
    event_tx: Sender<NetEvent>,
    peers_arc: Arc<Mutex<Vec<PeerInfo>>>,
    count_arc: Arc<AtomicUsize>,
    listen_port: u16,
) {
    let mut peers: HashMap<PeerId, Peer> = HashMap::new();
    let mut by_node: HashMap<u64, PeerId> = HashMap::new();
    let mut next_id: PeerId = 1;

    let refresh = |peers: &HashMap<PeerId, Peer>| {
        let snap: Vec<PeerInfo> = peers
            .iter()
            .map(|(id, p)| PeerInfo { peer: *id, addr: p.addr.clone(), inbound: p.inbound })
            .collect();
        count_arc.store(snap.len(), Ordering::Relaxed);
        if let Ok(mut g) = peers_arc.lock() {
            *g = snap;
        }
    };

    while let Ok(ev) = rx.recv() {
        match ev {
            Internal::Inbound(stream, addr) => {
                spawn_conn(stream, addr, true, &cfg, listen_port, tx.clone());
            }
            Internal::Outbound(stream, addr) => {
                spawn_conn(stream, addr, false, &cfg, listen_port, tx.clone());
            }
            Internal::Registered { writer, addr, inbound, node, port, assign } => {
                if node == cfg.node_id || by_node.contains_key(&node) || peers.len() >= cfg.max_peers {
                    // auto-conexión, duplicado o aforo lleno: se rechaza (assign se cae).
                    let _ = writer.shutdown(Shutdown::Both);
                    continue;
                }
                let id = next_id;
                next_id += 1;
                let (out_tx, out_rx) = channel::<Frame>();
                thread::spawn(move || writer_loop(writer, out_rx));
                peers.insert(id, Peer { addr: addr.clone(), inbound, node, out_tx });
                by_node.insert(node, id);
                if assign.send(id).is_err() {
                    // el lector murió entre medias: deshacer.
                    if let Some(p) = peers.remove(&id) {
                        by_node.remove(&p.node);
                    }
                    refresh(&peers);
                    continue;
                }
                refresh(&peers);
                let dial_addr = if inbound { dialable(&addr, port) } else { Some(addr.clone()) };
                let _ = event_tx.send(NetEvent::Connected { peer: id, addr, inbound, dial_addr });
            }
            Internal::FromPeer(id, frame) => {
                if peers.contains_key(&id) {
                    let _ = event_tx.send(NetEvent::Message { peer: id, frame });
                }
            }
            Internal::PeerClosed(id) => {
                if let Some(p) = peers.remove(&id) {
                    by_node.remove(&p.node);
                    refresh(&peers);
                    let _ = event_tx.send(NetEvent::Disconnected { peer: id });
                }
            }
            Internal::Cmd(Cmd::Broadcast(f)) => {
                let mut dead = Vec::new();
                for (id, p) in &peers {
                    if p.out_tx.send(f.clone()).is_err() {
                        dead.push(*id);
                    }
                }
                for id in dead {
                    if let Some(p) = peers.remove(&id) {
                        by_node.remove(&p.node);
                    }
                }
                refresh(&peers);
            }
            Internal::Cmd(Cmd::Send(id, f)) => {
                if let Some(p) = peers.get(&id) {
                    let _ = p.out_tx.send(f);
                }
            }
            Internal::Cmd(Cmd::Dial(addr)) => {
                spawn_dialer(addr, tx.clone());
            }
            Internal::Maintenance => {
                let live: HashSet<String> = peers.values().map(|p| p.addr.clone()).collect();
                if peers.len() < cfg.max_peers {
                    for s in &cfg.seeds {
                        if !live.contains(s) {
                            spawn_dialer(s.clone(), tx.clone());
                        }
                    }
                }
                refresh(&peers);
            }
        }
    }
}

fn spawn_dialer(addr: String, tx: Sender<Internal>) {
    thread::spawn(move || {
        let targets = match addr.to_socket_addrs() {
            Ok(it) => it,
            Err(_) => return,
        };
        for sa in targets {
            if let Ok(stream) = TcpStream::connect_timeout(&sa, Duration::from_secs(5)) {
                let _ = tx.send(Internal::Outbound(stream, addr));
                return;
            }
        }
    });
}

/// Hilo lector + handshake de una conexión. Hace el handshake con el MISMO
/// BufReader que luego usa en bucle (así no se pierden bytes ya bufferizados).
fn spawn_conn(
    stream: TcpStream,
    addr: String,
    inbound: bool,
    cfg: &NetConfig,
    listen_port: u16,
    tx: Sender<Internal>,
) {
    let net_hex = cfg.net_hex();
    let node_id = cfg.node_id;
    thread::spawn(move || {
        // Handle de escritura para el hilo escritor (dup del socket).
        let writer = match stream.try_clone() {
            Ok(w) => w,
            Err(_) => return,
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut reader = BufReader::new(stream);

        // 1) enviar nuestro Hello.
        let hello = Frame::Hello { net: net_hex.clone(), node: node_id, port: listen_port, ver: PROTO_VERSION };
        if write_line(&writer, &hello.to_line()).is_err() {
            return;
        }
        // 2) leer su Hello (con timeout).
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let (their_node, their_port) = match Frame::from_line(line.trim()) {
            Some(Frame::Hello { net, node, port, .. }) if net == net_hex => (node, port),
            _ => return, // red distinta o basura → cortar
        };
        // 3) modo estable: sin timeout de lectura.
        let _ = reader.get_ref().set_read_timeout(None);

        // 4) registrar y esperar id asignado.
        let (assign_tx, assign_rx) = channel::<PeerId>();
        if tx
            .send(Internal::Registered {
                writer,
                addr,
                inbound,
                node: their_node,
                port: their_port,
                assign: assign_tx,
            })
            .is_err()
        {
            return;
        }
        let peer = match assign_rx.recv() {
            Ok(id) => id,
            Err(_) => return, // rechazado por el central
        };

        // 5) bucle de lectura.
        loop {
            let mut l = String::new();
            match reader.read_line(&mut l) {
                Ok(0) => break,
                Ok(_) => {
                    if let Some(f) = Frame::from_line(l.trim()) {
                        if matches!(f, Frame::Hello { .. }) {
                            continue; // Hello fuera de sitio: ignorar
                        }
                        if tx.send(Internal::FromPeer(peer, f)).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(Internal::PeerClosed(peer));
    });
}

fn writer_loop(writer: TcpStream, out_rx: Receiver<Frame>) {
    for f in out_rx {
        if write_line(&writer, &f.to_line()).is_err() {
            break;
        }
    }
    let _ = writer.shutdown(Shutdown::Both);
}

fn write_line(mut w: &TcpStream, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(node: u64, listen: Option<u16>, seeds: Vec<String>, net: [u8; 32]) -> NetConfig {
        NetConfig { network_id: net, node_id: node, listen, seeds, max_peers: 16 }
    }

    fn wait_connected(rx: &Receiver<NetEvent>) -> Option<PeerId> {
        // espera hasta 5 s un evento Connected
        for _ in 0..50 {
            if let Ok(ev) = rx.recv_timeout(Duration::from_millis(100)) {
                if let NetEvent::Connected { peer, .. } = ev {
                    return Some(peer);
                }
            }
        }
        None
    }

    #[test]
    fn two_nodes_handshake_and_exchange() {
        let net = [7u8; 32];
        // A escucha en puerto efímero.
        let (a, a_rx) = Network::start(cfg(1, Some(0), vec![], net));
        let port = a.listen_port;
        assert!(port > 0, "A debe tener puerto de escucha");
        // B marca a A.
        let (b, b_rx) = Network::start(cfg(2, Some(0), vec![format!("127.0.0.1:{port}")], net));

        let a_peer = wait_connected(&a_rx).expect("A no vio la conexión");
        let _b_peer = wait_connected(&b_rx).expect("B no vio la conexión");
        assert_eq!(a.peer_count(), 1);
        assert_eq!(b.peer_count(), 1);

        // A envía Ping a B; B debe recibirlo.
        a.send(a_peer, Frame::Ping { nonce: 123 });
        let mut got = false;
        for _ in 0..50 {
            if let Ok(NetEvent::Message { frame: Frame::Ping { nonce }, .. }) =
                b_rx.recv_timeout(Duration::from_millis(100))
            {
                assert_eq!(nonce, 123);
                got = true;
                break;
            }
        }
        assert!(got, "B no recibió el Ping");
    }

    #[test]
    fn wrong_network_is_rejected() {
        let (a, _a_rx) = Network::start(cfg(1, Some(0), vec![], [1u8; 32]));
        let port = a.listen_port;
        // B tiene OTRO network-id → el handshake debe fallar.
        let (b, b_rx) = Network::start(cfg(2, Some(0), vec![format!("127.0.0.1:{port}")], [2u8; 32]));
        // No debe llegar Connected en ~1.5 s.
        let mut connected = false;
        for _ in 0..15 {
            if let Ok(NetEvent::Connected { .. }) = b_rx.recv_timeout(Duration::from_millis(100)) {
                connected = true;
                break;
            }
        }
        assert!(!connected, "no debería conectar entre redes distintas");
        assert_eq!(b.peer_count(), 0);
    }
}
