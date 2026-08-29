//! Prueba de integración: dos nodos reales sobre TCP comparten el génesis
//! canónico de testnet; uno mina y el otro sincroniza por gossip.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use rami_core::params::Params;
use rami_node::{spawn, NodeConfig};

fn tmpdir(tag: &str) -> PathBuf {
    let uniq = format!(
        "rami-it-{}-{}-{tag}",
        std::process::id(),
        Instant::now().elapsed().as_nanos() ^ (tag.len() as u128)
    );
    std::env::temp_dir().join(uniq)
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
    })
    .expect("B no arrancó");

    // Mismo network-id (génesis canónico compartido).
    assert_eq!(a.status().network_id, b.status().network_id, "network-id distinto");

    // B debe sincronizar al menos hasta 5 desde A.
    let bh = wait_height(&b, 5, 20);
    assert!(bh >= 5, "B no sincronizó (altura {bh})");
    assert_eq!(b.status().peers.len(), 1, "B debería tener 1 par");

    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}
