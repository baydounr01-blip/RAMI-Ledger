//! rami-net — gossip P2P de RAMI-Chain sobre TCP por el **Túnel RAMI**: cada
//! conexión se autentica con la identidad Ed25519 (con prueba de trabajo) de
//! los dos nodos y va cifrada frame a frame (ver `identity.rs` y `secure.rs`).
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

pub mod identity;
pub mod protocol;
pub mod secure;
pub mod selftest;

use std::collections::{HashMap, HashSet};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub use identity::{NodeIdentity, IDENTITY_POW_BITS};
pub use protocol::{Frame, TipInfo, PROTO_VERSION};
pub use secure::{
    handshake_initiator, handshake_responder, FrameError, HandshakeError, PeerIdentity, SecureReader, SecureStream,
    SecureWriter, MAX_FRAME,
};

pub type PeerId = u64;

/// Longitud máxima de un frame (cifrado) que aceptamos leer de un par: ver
/// `secure::MAX_FRAME`. Un `Branch` de 512 bloques cabe de sobra; un frame
/// mayor es un par roto o malicioso y se corta ANTES de reservar memoria: los
/// topes del nodo se aplican tras parsear, así que el transporte debe acotar
/// primero.
pub const MAX_LINE: u64 = MAX_FRAME as u64;
/// Frames pendientes de escribir por par. Si un par no lee su socket, la cola
/// se llena y se le expulsa en vez de acumular memoria sin límite (antes era un
/// canal ilimitado: una amplificación tan grande como el atacante quisiera).
pub const OUT_QUEUE: usize = 128;

/// Configuración de arranque de la red.
#[derive(Clone)]
pub struct NetConfig {
    /// network-id: hash del génesis. Solo se aceptan pares con el mismo.
    pub network_id: [u8; 32],
    /// Identidad de ESTE nodo (clave Ed25519 con prueba de trabajo). De ella
    /// se deriva el `node_id` (evita auto-conexión y duplicados) y la huella.
    pub identity: NodeIdentity,
    /// Puerto de escucha. `Some(0)` = efímero; `None` = solo salidas.
    pub listen: Option<u16>,
    /// Pares iniciales a los que marcar (`host:puerto`).
    pub seeds: Vec<String>,
    /// Tope de conexiones simultáneas.
    pub max_peers: usize,
    /// Descubrimiento en la red local (UDP): los nodos de la misma casa u
    /// oficina se encuentran solos, sin escribir ninguna IP.
    pub lan_discovery: bool,
}

impl NetConfig {
    fn net_hex(&self) -> String {
        hex::encode(self.network_id)
    }
    /// Identificador de nodo derivado de la identidad.
    pub fn node_id(&self) -> u64 {
        self.identity.node_id()
    }
}

/// Datos públicos de un par conectado.
#[derive(Clone, Debug)]
pub struct PeerInfo {
    pub peer: PeerId,
    pub addr: String,
    pub inbound: bool,
    /// Huella de su identidad (`xxxx-xxxx-xxxx-xxxx`).
    pub fingerprint: String,
    /// Su clave pública Ed25519 en hex.
    pub pubkey: String,
}

/// Eventos que la red entrega al nodo. `dial_addr` es la dirección REMARCABLE
/// del par (su IP + el puerto de escucha que anunció en el handshake); None si
/// el par no escucha. Para entrantes el `addr` del socket lleva un puerto
/// efímero que NO sirve para volver a conectar — usa `dial_addr`. `pubkey` y
/// `fingerprint` son la identidad AUTENTICADA del par (firmó el handshake).
#[derive(Debug)]
pub enum NetEvent {
    Connected {
        peer: PeerId,
        addr: String,
        inbound: bool,
        dial_addr: Option<String>,
        pubkey: [u8; 32],
        fingerprint: String,
    },
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
        writer: SecureWriter<TcpStream>,
        addr: String,
        inbound: bool,
        node: u64,
        /// Puerto de escucha ANUNCIADO por el par en su handshake (0 = no escucha).
        port: u16,
        pubkey: [u8; 32],
        fingerprint: String,
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
    Drop(PeerId),
}

struct Peer {
    addr: String,
    inbound: bool,
    node: u64,
    pubkey: [u8; 32],
    fingerprint: String,
    out_tx: SyncSender<Frame>,
}

/// Manejador de la red (clonable). El nodo lo usa para difundir y marcar.
#[derive(Clone)]
pub struct Network {
    tx: Sender<Internal>,
    /// Identificador derivado de la identidad del nodo.
    pub node_id: u64,
    /// Huella de la identidad del nodo (para mostrarla en el monedero).
    pub fingerprint: String,
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
        let node_id = cfg.node_id();
        let fingerprint = cfg.identity.fingerprint();

        // Escucha (si procede): se enlaza AQUÍ para conocer el puerto efímero real.
        let mut listen_port = 0u16;
        if let Some(port) = cfg.listen {
            // Si el puerto pedido está ocupado (otra instancia, la CLI, otro
            // programa), reintenta en efímero: mejor aceptar entrantes en un
            // puerto cualquiera (se anuncia el real) que quedar solo-salientes.
            let bound = TcpListener::bind(("0.0.0.0", port)).or_else(|e| {
                eprintln!("[net] no se pudo escuchar en :{port}: {e}; probando puerto efímero");
                TcpListener::bind(("0.0.0.0", 0))
            });
            match bound {
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
                Err(e) => eprintln!("[net] sin puerto de escucha (solo salientes): {e}"),
            }
        }

        // Marcado inicial de seeds.
        for s in &cfg.seeds {
            let _ = tx.send(Internal::Cmd(Cmd::Dial(s.clone())));
        }

        // Descubrimiento LAN: anuncia «estoy aquí» por UDP y marca a quien oiga.
        if cfg.lan_discovery && listen_port != 0 {
            spawn_lan_discovery(cfg.net_hex(), node_id, listen_port, tx.clone());
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

        (Network { tx, node_id, fingerprint, listen_port, peers, count }, event_rx)
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
    /// Expulsa a un par (cierra su socket). El nodo recibe `Disconnected`.
    pub fn disconnect(&self, peer: PeerId) {
        let _ = self.tx.send(Internal::Cmd(Cmd::Drop(peer)));
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

    let own_node = cfg.node_id();
    let refresh = |peers: &HashMap<PeerId, Peer>| {
        let snap: Vec<PeerInfo> = peers
            .iter()
            .map(|(id, p)| PeerInfo {
                peer: *id,
                addr: p.addr.clone(),
                inbound: p.inbound,
                fingerprint: p.fingerprint.clone(),
                pubkey: hex::encode(p.pubkey),
            })
            .collect();
        count_arc.store(snap.len(), Ordering::Relaxed);
        if let Ok(mut g) = peers_arc.lock() {
            *g = snap;
        }
    };

    // Un par sale de la tabla por UNA sola puerta: se cierra su cola (el hilo
    // escritor cierra el socket y el lector termina) y el nodo recibe
    // `Disconnected` exactamente una vez.
    let drop_peer = |peers: &mut HashMap<PeerId, Peer>, by_node: &mut HashMap<u64, PeerId>, id: PeerId| {
        if let Some(p) = peers.remove(&id) {
            by_node.remove(&p.node);
            drop(p.out_tx);
            let _ = event_tx.send(NetEvent::Disconnected { peer: id });
        }
    };
    // Encola un frame a un par; si su cola está llena (no lee), se le expulsa.
    let push = |p: &Peer, f: Frame| -> bool {
        match p.out_tx.try_send(f) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                eprintln!("[net] par {} no lee (cola de salida llena): se desconecta", p.addr);
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
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
            Internal::Registered { writer, addr, inbound, node, port, pubkey, fingerprint, assign } => {
                if node == own_node || by_node.contains_key(&node) || peers.len() >= cfg.max_peers {
                    // auto-conexión, duplicado o aforo lleno: se rechaza (assign se cae).
                    let _ = writer.get_ref().shutdown(Shutdown::Both);
                    continue;
                }
                let id = next_id;
                next_id += 1;
                let (out_tx, out_rx) = sync_channel::<Frame>(OUT_QUEUE);
                thread::spawn(move || writer_loop(writer, out_rx));
                peers.insert(id, Peer { addr: addr.clone(), inbound, node, pubkey, fingerprint: fingerprint.clone(), out_tx });
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
                let _ = event_tx.send(NetEvent::Connected { peer: id, addr, inbound, dial_addr, pubkey, fingerprint });
            }
            Internal::FromPeer(id, frame) => {
                if peers.contains_key(&id) {
                    let _ = event_tx.send(NetEvent::Message { peer: id, frame });
                }
            }
            Internal::PeerClosed(id) => {
                if peers.contains_key(&id) {
                    drop_peer(&mut peers, &mut by_node, id);
                    refresh(&peers);
                }
            }
            Internal::Cmd(Cmd::Broadcast(f)) => {
                let mut dead = Vec::new();
                for (id, p) in &peers {
                    if !push(p, f.clone()) {
                        dead.push(*id);
                    }
                }
                for id in dead {
                    drop_peer(&mut peers, &mut by_node, id);
                }
                refresh(&peers);
            }
            Internal::Cmd(Cmd::Send(id, f)) => {
                if let Some(p) = peers.get(&id) {
                    if !push(p, f) {
                        drop_peer(&mut peers, &mut by_node, id);
                        refresh(&peers);
                    }
                }
            }
            Internal::Cmd(Cmd::Drop(id)) => {
                if peers.contains_key(&id) {
                    drop_peer(&mut peers, &mut by_node, id);
                    refresh(&peers);
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

/// Puerto UDP del descubrimiento en red local.
pub const LAN_DISCOVERY_PORT: u16 = 30303;
/// Grupo multicast del descubrimiento (además del broadcast clásico).
const LAN_MCAST: std::net::Ipv4Addr = std::net::Ipv4Addr::new(239, 255, 77, 77);

/// Anuncio de descubrimiento: `RAMI1 <net_hex> <node_id> <puerto>`.
fn discovery_line(net_hex: &str, node_id: u64, port: u16) -> String {
    format!("RAMI1 {net_hex} {node_id} {port}")
}

/// Parsea un anuncio; None si no es nuestro formato.
fn parse_discovery(line: &str) -> Option<(String, u64, u16)> {
    let mut it = line.split_whitespace();
    if it.next()? != "RAMI1" {
        return None;
    }
    let net = it.next()?.to_string();
    let node: u64 = it.next()?.parse().ok()?;
    let port: u16 = it.next()?.parse().ok()?;
    if net.len() != 64 || port == 0 {
        return None;
    }
    Some((net, node, port))
}

/// Descubrimiento en red local: cada 10 s se envía el anuncio por broadcast
/// (255.255.255.255) y multicast (239.255.77.77) al puerto 30303; un hilo
/// escucha ese puerto y, al oír a OTRO nodo de la MISMA red, lo marca (como
/// máximo una vez por minuto por dirección). Así dos ordenadores de la misma
/// casa se conectan sin escribir IPs. Es el mismo mecanismo que usan las
/// impresoras o Chromecast para aparecer en la red.
fn spawn_lan_discovery(net_hex: String, node_id: u64, listen_port: u16, tx: Sender<Internal>) {
    use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
    // Emisor.
    {
        let line = discovery_line(&net_hex, node_id, listen_port);
        thread::spawn(move || {
            let Ok(sock) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else { return };
            let _ = sock.set_broadcast(true);
            let _ = sock.set_multicast_ttl_v4(1);
            let bcast = SocketAddrV4::new(Ipv4Addr::BROADCAST, LAN_DISCOVERY_PORT);
            let mcast = SocketAddrV4::new(LAN_MCAST, LAN_DISCOVERY_PORT);
            loop {
                let _ = sock.send_to(line.as_bytes(), bcast);
                let _ = sock.send_to(line.as_bytes(), mcast);
                thread::sleep(Duration::from_secs(10));
            }
        });
    }
    // Receptor.
    thread::spawn(move || {
        let Ok(sock) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, LAN_DISCOVERY_PORT)) else {
            // Otra instancia en esta máquina ya escucha: seguimos anunciándonos
            // (ella nos marcará a nosotros).
            return;
        };
        let _ = sock.join_multicast_v4(&LAN_MCAST, &Ipv4Addr::UNSPECIFIED);
        let mut last: HashMap<String, Instant> = HashMap::new();
        let mut buf = [0u8; 256];
        while let Ok((n, from)) = sock.recv_from(&mut buf) {
            let Ok(text) = std::str::from_utf8(&buf[..n]) else { continue };
            let Some((net, node, port)) = parse_discovery(text.trim()) else { continue };
            if net != net_hex || node == node_id {
                continue;
            }
            let addr = format!("{}:{port}", from.ip());
            let now = Instant::now();
            if last.get(&addr).map_or(true, |t| now.duration_since(*t) > Duration::from_secs(60)) {
                last.insert(addr.clone(), now);
                if tx.send(Internal::Cmd(Cmd::Dial(addr))).is_err() {
                    break;
                }
            }
        }
    });
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

/// Hilo lector + handshake de una conexión. El handshake del Túnel RAMI usa
/// el MISMO BufReader que luego usa el bucle de lectura (así no se pierden
/// bytes ya bufferizados). El escritor cifrado se entrega al hilo escritor.
fn spawn_conn(
    stream: TcpStream,
    addr: String,
    inbound: bool,
    cfg: &NetConfig,
    listen_port: u16,
    tx: Sender<Internal>,
) {
    let net = cfg.network_id;
    let identity = cfg.identity.clone();
    thread::spawn(move || {
        // 1) handshake autenticado (con timeout de lectura de 5 s).
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let res = if inbound {
            handshake_responder(stream, &net, &identity, listen_port)
        } else {
            handshake_initiator(stream, &net, &identity, listen_port)
        };
        let (ss, peer_id) = match res {
            Ok(ok) => ok,
            Err(HandshakeError::OldProtocol) => {
                // Un nodo v0.6.x habla en claro: no nos entenderíamos. Se avisa
                // UNA vez por proceso para no inundar el registro.
                static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
                if !WARNED.swap(true, Ordering::Relaxed) {
                    eprintln!("[net] {addr}: par con protocolo antiguo; que actualice RAMI-Chain (se corta).");
                }
                return;
            }
            Err(HandshakeError::Version(ver)) => {
                // Misma red pero otro protocolo: no nos entenderíamos (ni
                // sincronizaríamos) y ocuparíamos una ranura de par cada uno.
                eprintln!(
                    "[net] {addr}: protocolo v{ver} (el nuestro es v{PROTO_VERSION}); se corta. \
                     Uno de los dos necesita actualizar RAMI-Chain."
                );
                return;
            }
            Err(HandshakeError::Invalid(m)) => {
                eprintln!("[net] {addr}: handshake rechazado: {m}");
                return;
            }
            // red distinta, auto-conexión, E/S o timeout → cortar en silencio
            Err(_) => return,
        };
        let (mut reader, writer) = ss.into_split();
        // 2) modo estable: sin timeout de lectura.
        let _ = reader.get_ref().get_ref().set_read_timeout(None);

        // 3) registrar y esperar id asignado.
        let (assign_tx, assign_rx) = channel::<PeerId>();
        if tx
            .send(Internal::Registered {
                writer,
                addr,
                inbound,
                node: peer_id.node_id,
                port: peer_id.port,
                pubkey: peer_id.pubkey,
                fingerprint: peer_id.fingerprint,
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

        // 4) bucle de lectura: cada frame se autentica y descifra; uno que no
        //    autentique, repetido o mayor que MAX_FRAME corta la conexión.
        loop {
            match reader.read_frame() {
                Ok(Frame::Hello { .. }) => continue, // Hello fuera de sitio: ignorar
                Ok(f) => {
                    if tx.send(Internal::FromPeer(peer, f)).is_err() {
                        break;
                    }
                }
                Err(FrameError::Parse) => continue, // autenticado pero desconocido: ignorar
                Err(_) => break,
            }
        }
        let _ = tx.send(Internal::PeerClosed(peer));
    });
}

fn writer_loop(mut writer: SecureWriter<TcpStream>, out_rx: Receiver<Frame>) {
    for f in out_rx {
        if writer.write_frame(&f).is_err() {
            break;
        }
    }
    let _ = writer.get_ref().shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure::HsOpts;
    use std::io::{BufRead, BufReader, Write};

    #[test]
    fn discovery_line_roundtrip() {
        let net = "ab".repeat(32);
        let l = discovery_line(&net, 42, 30301);
        assert_eq!(parse_discovery(&l), Some((net.clone(), 42, 30301)));
        assert_eq!(parse_discovery("hola"), None);
        assert_eq!(parse_discovery(&format!("RAMI1 {net} 1 0")), None);
        assert_eq!(parse_discovery("RAMI1 corto 1 30301"), None);
    }

    /// Identidades de prueba (la búsqueda de PoW cuesta ~1 s; se generan una
    /// vez por proceso y se comparten entre pruebas).
    fn ident(i: usize) -> NodeIdentity {
        use std::sync::OnceLock;
        static IDS: OnceLock<Vec<NodeIdentity>> = OnceLock::new();
        IDS.get_or_init(|| (1..=4u8).map(|k| NodeIdentity::from_seed_search([k; 32])).collect())[i].clone()
    }

    fn cfg(node: usize, listen: Option<u16>, seeds: Vec<String>, net: [u8; 32]) -> NetConfig {
        NetConfig { network_id: net, identity: ident(node), listen, seeds, max_peers: 16, lan_discovery: false }
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
        let (a, a_rx) = Network::start(cfg(0, Some(0), vec![], net));
        let port = a.listen_port;
        assert!(port > 0, "A debe tener puerto de escucha");
        assert_eq!(a.node_id, ident(0).node_id());
        assert_eq!(a.fingerprint, ident(0).fingerprint());
        // B marca a A.
        let (b, b_rx) = Network::start(cfg(1, Some(0), vec![format!("127.0.0.1:{port}")], net));

        let a_peer = wait_connected(&a_rx).expect("A no vio la conexión");
        let _b_peer = wait_connected(&b_rx).expect("B no vio la conexión");
        assert_eq!(a.peer_count(), 1);
        assert_eq!(b.peer_count(), 1);
        // Cada uno ve la identidad AUTENTICADA del otro.
        let pa = a.peers();
        assert_eq!(pa.len(), 1);
        assert_eq!(pa[0].fingerprint, ident(1).fingerprint());
        assert_eq!(pa[0].pubkey, hex::encode(ident(1).pubkey));
        assert!(pa[0].inbound);
        let pb = b.peers();
        assert_eq!(pb[0].fingerprint, ident(0).fingerprint());
        assert!(!pb[0].inbound);

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

    /// Cliente crudo: conecta a `port`, hace el handshake del túnel con `ver`
    /// y devuelve la conexión cifrada ya en modo estable (o None si el otro
    /// lado cortó).
    fn raw_client(port: u16, net: [u8; 32], ver: u32) -> Option<SecureStream> {
        let s = TcpStream::connect(("127.0.0.1", port)).ok()?;
        let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
        let opts = HsOpts { ver, ..HsOpts::default() };
        let (ss, _) = secure::handshake_initiator_opts(s, &net, &ident(3), 0, &opts).ok()?;
        Some(ss)
    }

    #[test]
    fn old_protocol_version_is_rejected() {
        let net = [9u8; 32];
        let (a, a_rx) = Network::start(cfg(0, Some(0), vec![], net));
        // A no debe registrar el par: el handshake falla y el socket se cierra
        // sin `Connected`.
        assert!(raw_client(a.listen_port, net, PROTO_VERSION - 1).is_none(), "no debía completar el handshake");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(a.peer_count(), 0);
        // Un nodo v0.6.x (Hello en claro) tampoco.
        {
            let s = TcpStream::connect(("127.0.0.1", a.listen_port)).unwrap();
            let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
            let old = Frame::Hello { net: hex::encode(net), node: 999, port: 0, ver: 1 };
            let mut w = &s;
            w.write_all(format!("{}\n", old.to_line()).as_bytes()).unwrap();
            let mut r = BufReader::new(s);
            let mut l = String::new();
            assert_eq!(r.read_line(&mut l).unwrap_or(0), 0, "el socket debería estar cerrado");
            assert_eq!(a.peer_count(), 0);
        }
        // con la versión correcta sí conecta
        let _ok = raw_client(a.listen_port, net, PROTO_VERSION).expect("conexión TCP");
        assert!(wait_connected(&a_rx).is_some(), "no conectó con la versión correcta");
        assert_eq!(a.peer_count(), 1);
    }

    #[test]
    fn oversized_frame_disconnects_peer() {
        let net = [10u8; 32];
        let (a, a_rx) = Network::start(cfg(0, Some(0), vec![], net));
        let s = raw_client(a.listen_port, net, PROTO_VERSION).expect("conexión TCP");
        assert!(wait_connected(&a_rx).is_some());
        assert_eq!(a.peer_count(), 1);
        // Un frame que anuncia más de MAX_FRAME bytes: el lector corta antes
        // de reservar memoria para él (no hace falta ni enviar el cuerpo).
        let mut w = s.writer.get_ref();
        let mut hdr = (MAX_FRAME + 1).to_be_bytes().to_vec();
        hdr.extend_from_slice(&[0u8; 64]);
        let _ = w.write_all(&hdr);
        let mut gone = false;
        for _ in 0..50 {
            if let Ok(NetEvent::Disconnected { .. }) = a_rx.recv_timeout(Duration::from_millis(100)) {
                gone = true;
                break;
            }
        }
        assert!(gone, "el par con frame gigante no fue expulsado");
        assert_eq!(a.peer_count(), 0);
    }

    #[test]
    fn tampered_frame_disconnects_peer() {
        let net = [12u8; 32];
        let (a, a_rx) = Network::start(cfg(0, Some(0), vec![], net));
        let mut s = raw_client(a.listen_port, net, PROTO_VERSION).expect("conexión TCP");
        let peer = wait_connected(&a_rx).expect("Connected");
        // Un frame legítimo llega...
        s.write_frame(&Frame::Ping { nonce: 5 }).unwrap();
        let mut got = false;
        for _ in 0..50 {
            if let Ok(NetEvent::Message { peer: p, frame: Frame::Ping { nonce: 5 } }) =
                a_rx.recv_timeout(Duration::from_millis(100))
            {
                assert_eq!(p, peer);
                got = true;
                break;
            }
        }
        assert!(got, "no llegó el Ping cifrado");
        // ...pero uno cifrado con OTRA clave (o repetido) no autentica y corta.
        let mut fake = Vec::new();
        SecureWriter::new(&mut fake, &[0u8; 32]).write_frame(&Frame::Ping { nonce: 6 }).unwrap();
        let mut w = s.writer.get_ref();
        let _ = w.write_all(&fake);
        let mut gone = false;
        for _ in 0..50 {
            if let Ok(NetEvent::Disconnected { .. }) = a_rx.recv_timeout(Duration::from_millis(100)) {
                gone = true;
                break;
            }
        }
        assert!(gone, "el par con frame manipulado no fue expulsado");
        assert_eq!(a.peer_count(), 0);
    }

    #[test]
    fn peer_that_does_not_read_is_dropped_when_queue_fills() {
        let net = [11u8; 32];
        let (a, a_rx) = Network::start(cfg(0, Some(0), vec![], net));
        let s = raw_client(a.listen_port, net, PROTO_VERSION).expect("conexión TCP");
        let peer = wait_connected(&a_rx).expect("Connected");
        // El cliente NO lee. Se le envían frames grandes hasta que el búfer TCP
        // y la cola de OUT_QUEUE frames se llenan; entonces se le expulsa.
        let big = Frame::Peers { addrs: vec!["x".repeat(60_000); 4] };
        let mut gone = false;
        'outer: for _ in 0..(OUT_QUEUE * 8) {
            a.send(peer, big.clone());
            while let Ok(ev) = a_rx.recv_timeout(Duration::from_millis(5)) {
                if matches!(ev, NetEvent::Disconnected { .. }) {
                    gone = true;
                    break 'outer;
                }
            }
        }
        if !gone {
            for _ in 0..50 {
                if let Ok(NetEvent::Disconnected { .. }) = a_rx.recv_timeout(Duration::from_millis(100)) {
                    gone = true;
                    break;
                }
            }
        }
        drop(s);
        assert!(gone, "el par que no lee no fue expulsado");
        assert_eq!(a.peer_count(), 0);
    }

    #[test]
    fn wrong_network_is_rejected() {
        let (a, _a_rx) = Network::start(cfg(0, Some(0), vec![], [1u8; 32]));
        let port = a.listen_port;
        // B tiene OTRO network-id → el handshake debe fallar.
        let (b, b_rx) = Network::start(cfg(1, Some(0), vec![format!("127.0.0.1:{port}")], [2u8; 32]));
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

    #[test]
    fn same_identity_twice_is_not_registered_twice() {
        // Dos procesos con la MISMA node.key (copia del directorio): el segundo
        // se ve como auto-conexión y no entra en la tabla.
        let net = [13u8; 32];
        let (a, a_rx) = Network::start(cfg(0, Some(0), vec![], net));
        let port = a.listen_port;
        let (b, b_rx) = Network::start(cfg(0, Some(0), vec![format!("127.0.0.1:{port}")], net));
        assert!(wait_connected(&b_rx).is_none());
        assert!(wait_connected(&a_rx).is_none());
        assert_eq!(a.peer_count(), 0);
        assert_eq!(b.peer_count(), 0);
    }
}
