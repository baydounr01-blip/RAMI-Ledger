//! Autoauditoría del Túnel RAMI: un «pentest» hecho con nuestra propia
//! tecnología. Se conecta a un nodo (normalmente el propio, en
//! `127.0.0.1:<puerto P2P>`) y se comporta como un par MALICIOSO: saludo en
//! claro de v0.6.x, versión de protocolo antigua, otra red, identidad sin
//! prueba de trabajo, firma manipulada, trama sin autenticar, trama gigante y
//! una avalancha de puntas falsas. Cada intento debe ser rechazado; si alguno
//! no lo es, la prueba lo dice. Es la misma batería que corre en los tests de
//! `secure.rs`/`lib.rs`, pero contra un nodo REAL en ejecución, para que
//! cualquiera pueda comprobarlo desde el panel o con `rami-node audit`.
//!
//! Testnet experimental, sin valor monetario.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::identity::{identity_pow_ok, NodeIdentity};
use crate::protocol::{Frame, TipInfo, PROTO_VERSION};
use crate::secure::{handshake_initiator_opts, FrameError, HsOpts, SecureStream, SecureWriter, MAX_FRAME};

/// Resultado de una comprobación.
#[derive(Clone, Debug, Serialize)]
pub struct Check {
    /// Nombre corto (en español, tal como se muestra).
    pub name: String,
    pub ok: bool,
    /// Qué se observó.
    pub detail: String,
    /// Duración en milisegundos.
    pub ms: u64,
}

/// Peticiones de rama que, como máximo, debe provocar una avalancha de puntas
/// falsas (el nodo limita las peticiones en vuelo por par a 4).
pub const MAX_EXPECTED_BRANCH_REQUESTS: usize = 4;

const IO_TIMEOUT: Duration = Duration::from_secs(3);

fn connect(addr: &str) -> Result<TcpStream, String> {
    let sa = addr
        .to_socket_addrs()
        .map_err(|e| format!("dirección inválida {addr}: {e}"))?
        .next()
        .ok_or_else(|| format!("dirección sin resolver: {addr}"))?;
    let s = TcpStream::connect_timeout(&sa, IO_TIMEOUT).map_err(|e| format!("no se pudo conectar a {addr}: {e}"))?;
    let _ = s.set_read_timeout(Some(IO_TIMEOUT));
    let _ = s.set_write_timeout(Some(IO_TIMEOUT));
    Ok(s)
}

/// ¿El par cerró la conexión (fin de flujo o reset) antes del timeout?
fn closed_by_peer(mut s: &TcpStream) -> bool {
    let mut b = [0u8; 1];
    match s.read(&mut b) {
        Ok(0) => true,
        Ok(_) => false,
        Err(e) => matches!(
            e.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::UnexpectedEof
        ),
    }
}

fn run_check<F>(out: &mut Vec<Check>, name: &str, f: F)
where
    F: FnOnce() -> Result<(bool, String), String>,
{
    let t0 = Instant::now();
    let (ok, detail) = match f() {
        Ok(r) => r,
        Err(e) => (false, format!("no se pudo ejecutar: {e}")),
    };
    out.push(Check { name: name.to_string(), ok, detail, ms: t0.elapsed().as_millis() as u64 });
}

fn handshake(addr: &str, net: &[u8; 32], id: &NodeIdentity, o: HsOpts) -> Result<SecureStream, String> {
    let s = connect(addr)?;
    match handshake_initiator_opts(s, net, id, 0, &o) {
        Ok((ss, _)) => Ok(ss),
        Err(e) => Err(format!("{e}")),
    }
}

/// Ejecuta la batería contra `addr` (host:puerto P2P) en la red `net`.
/// Tarda unos segundos (crear una identidad con prueba de trabajo cuesta
/// ~1 s; cada intento espera hasta 3 s a que el nodo corte).
pub fn run(addr: &str, net: [u8; 32]) -> Vec<Check> {
    let mut out = Vec::new();
    let t0 = Instant::now();
    // Identidad de atacante con prueba de trabajo válida (para los intentos
    // que necesitan completar el saludo).
    let id = NodeIdentity::generate();
    out.push(Check {
        name: "identidad de prueba con prueba de trabajo".into(),
        ok: id.pow_ok(),
        detail: format!("huella {} (SHA-256d con {} bits a cero)", id.fingerprint(), crate::IDENTITY_POW_BITS),
        ms: t0.elapsed().as_millis() as u64,
    });

    // 1) Saludo en claro de v0.6.x: debe cortarse sin más.
    run_check(&mut out, "saludo en claro (protocolo v0.6.x) rechazado", || {
        let s = connect(addr)?;
        let old = Frame::Hello { net: hex::encode(net), node: 1, port: 0, ver: 1 };
        (&s).write_all(format!("{}\n", old.to_line()).as_bytes()).map_err(|e| e.to_string())?;
        let closed = closed_by_peer(&s);
        Ok((closed, if closed { "el nodo cortó la conexión".into() } else { "el nodo NO cortó la conexión en 3 s".into() }))
    });

    // 2) Versión de protocolo distinta.
    run_check(&mut out, "versión de protocolo antigua rechazada", || {
        let o = HsOpts { ver: PROTO_VERSION - 1, ..HsOpts::default() };
        Ok(match handshake(addr, &net, &id, o) {
            Err(e) => (true, format!("rechazado: {e}")),
            Ok(_) => (false, "el nodo completó el saludo con otra versión".into()),
        })
    });

    // 3) Otra red (network-id distinto).
    run_check(&mut out, "otra red (network-id distinto) rechazada", || {
        let mut other = net;
        other[0] ^= 0xff;
        Ok(match handshake(addr, &other, &id, HsOpts::default()) {
            Err(e) => (true, format!("rechazado: {e}")),
            Ok(_) => (false, "el nodo aceptó un par de otra red".into()),
        })
    });

    // 4) Identidad sin prueba de trabajo válida.
    run_check(&mut out, "identidad sin prueba de trabajo rechazada", || {
        let mut bad = id.pow_nonce.wrapping_add(1);
        while identity_pow_ok(&id.pubkey, bad) {
            bad = bad.wrapping_add(1);
        }
        let o = HsOpts { pow_nonce: Some(bad), ..HsOpts::default() };
        Ok(match handshake(addr, &net, &id, o) {
            Err(e) => (true, format!("rechazado: {e}")),
            Ok(_) => (false, "el nodo aceptó una identidad sin prueba de trabajo".into()),
        })
    });

    // 5) Firma manipulada: el respondedor debe rechazar nuestro RamiHello3 y
    //    cortar (nosotros no vemos su veredicto hasta leer).
    run_check(&mut out, "firma de saludo manipulada rechazada", || {
        let o = HsOpts { flip_sig: true, ..HsOpts::default() };
        match handshake(addr, &net, &id, o) {
            Err(e) => Ok((true, format!("rechazado: {e}"))),
            Ok(ss) => {
                let closed = closed_by_peer(ss.reader.get_ref().get_ref());
                Ok((closed, if closed { "el nodo cortó tras la firma inválida".into() } else { "el nodo mantuvo una conexión con firma inválida".into() }))
            }
        }
    });

    // 6) Trama sin autenticar (cifrada con otra clave): debe cortar.
    run_check(&mut out, "trama sin autenticar (otra clave) rechazada", || {
        let mut ss = handshake(addr, &net, &id, HsOpts::default())?;
        ss.write_frame(&Frame::Ping { nonce: 1 }).map_err(|e| e.to_string())?;
        let mut fake = Vec::new();
        SecureWriter::new(&mut fake, &[0u8; 32]).write_frame(&Frame::Ping { nonce: 2 }).map_err(|e| e.to_string())?;
        ss.writer.get_ref().write_all(&fake).map_err(|e| e.to_string())?;
        // Tras cortar, cualquier lectura termina en cierre/reset.
        let closed = wait_closed(&mut ss);
        Ok((closed, if closed { "el nodo cortó la conexión".into() } else { "el nodo siguió tras una trama que no autentica".into() }))
    });

    // 7) Trama gigante: se anuncia más de MAX_FRAME y el nodo debe cortar
    //    antes de reservar memoria.
    run_check(&mut out, "trama gigante (> 16 MiB) rechazada", || {
        let mut ss = handshake(addr, &net, &id, HsOpts::default())?;
        let mut hdr = (MAX_FRAME + 1).to_be_bytes().to_vec();
        hdr.extend_from_slice(&[0u8; 64]);
        ss.writer.get_ref().write_all(&hdr).map_err(|e| e.to_string())?;
        let closed = wait_closed(&mut ss);
        Ok((closed, if closed { "el nodo cortó la conexión".into() } else { "el nodo no cortó ante una trama gigante".into() }))
    });

    // 8) Avalancha de puntas falsas: como mucho 4 peticiones de rama.
    run_check(&mut out, "avalancha de 256 puntas falsas no amplifica", || {
        let mut ss = handshake(addr, &net, &id, HsOpts::default())?;
        let tips: Vec<TipInfo> = (0..256u32)
            .map(|i| {
                let mut h = [0u8; 32];
                h[..4].copy_from_slice(&i.to_be_bytes());
                h[31] = 0xAB;
                TipInfo { hash: hex::encode(h), height: 1_000_000 + i as u64, work: "1000000000".into() }
            })
            .collect();
        ss.write_frame(&Frame::Tips { tips, partial: false }).map_err(|e| e.to_string())?;
        let t1 = Instant::now();
        let mut branch_requests = 0usize;
        let mut other = 0usize;
        while t1.elapsed() < Duration::from_millis(2500) {
            match ss.read_frame() {
                Ok(Frame::GetBranch { .. }) => branch_requests += 1,
                Ok(_) => other += 1,
                Err(FrameError::Parse) => other += 1,
                Err(_) => break,
            }
        }
        let ok = branch_requests <= MAX_EXPECTED_BRANCH_REQUESTS;
        Ok((ok, format!("{branch_requests} peticiones de rama (máximo esperado {MAX_EXPECTED_BRANCH_REQUESTS}), {other} tramas más")))
    });

    out
}

/// Espera (hasta el timeout de lectura) a que el nodo cierre la conexión.
/// Un nodo real manda sus puntas (y responde a nuestro Ping) nada más
/// completar el saludo, antes de procesar la trama maliciosa: ese tráfico
/// legítimo se ignora; lo que cuenta es que la conexión acabe cerrada.
fn wait_closed(ss: &mut SecureStream) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < IO_TIMEOUT {
        match ss.read_frame() {
            Ok(_) => continue,
            Err(FrameError::Closed) => return true,
            Err(FrameError::Io(_)) => {
                // Io puede ser timeout: distingue con una lectura cruda.
                return closed_by_peer(ss.reader.get_ref().get_ref()) || matches!(ss.read_frame(), Err(FrameError::Closed));
            }
            Err(_) => return true,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NetConfig, Network};

    #[test]
    fn selftest_passes_against_a_real_node() {
        let net = [21u8; 32];
        let cfg = NetConfig {
            network_id: net,
            identity: NodeIdentity::from_seed_search([0x77; 32]),
            listen: Some(0),
            seeds: vec![],
            max_peers: 16,
            lan_discovery: false,
        };
        let (a, rx) = Network::start(cfg);
        // Un «nodo» mínimo: consume eventos y no responde nada (la capa de red
        // sola ya debe rechazar todo lo anterior a un saludo válido).
        std::thread::spawn(move || for _ in rx {});
        let checks = run(&format!("127.0.0.1:{}", a.listen_port), net);
        for c in &checks {
            eprintln!("{} {} — {} ({} ms)", if c.ok { "✓" } else { "✗" }, c.name, c.detail, c.ms);
        }
        // Todas salvo la avalancha (que necesita la lógica del nodo) deben pasar
        // solo con la capa de red.
        for c in checks.iter().filter(|c| !c.name.starts_with("avalancha")) {
            assert!(c.ok, "{}: {}", c.name, c.detail);
        }
    }
}
