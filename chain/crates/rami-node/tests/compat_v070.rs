//! La versión nueva abre TODO lo que escribió la v0.7.0 publicada.
//!
//! Los ficheros de `fixtures/v0.7.0/` los escribieron los binarios reales de
//! esa etiqueta (ver su README). Aquí no se prueba «el formato que creemos
//! que tenía la v0.7.0»: se prueban sus bytes. Si un test de estos falla, la
//! actualización rompe el archivo de alguien; se arregla el formato, no el
//! test. La dirección contraria (la v0.7.0 abre lo que escribe esta versión)
//! la ejecuta `tools/compat/roundtrip.sh` con los dos binarios en el CI.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rami_core::params::Params;
use rami_core::store::ChainDir;
use rami_net::identity::{fingerprint, load_or_create};
use rami_node::{spawn, NodeConfig};
use rami_wallet::{load_reveal, Keystore};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v0.7.0")
}

fn esperado() -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("esperado.json")).unwrap()).unwrap()
}

fn campo(v: &serde_json::Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_string()
}

/// Copia el directorio de cadena a un temporal: el nodo escribe encima.
fn copia_cadena(tag: &str) -> PathBuf {
    let dst = std::env::temp_dir().join(format!("rami-compat-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dst);
    std::fs::create_dir_all(&dst).unwrap();
    for e in std::fs::read_dir(fixtures().join("chain-regtest")).unwrap() {
        let e = e.unwrap();
        std::fs::copy(e.path(), dst.join(e.file_name())).unwrap();
    }
    dst
}

#[test]
fn el_keystore_cifrado_v2_abre_con_la_contrasena_y_sin_ella_solo_la_direccion() {
    let e = esperado();
    let ks = Keystore::load(fixtures().join("wallet.json"));
    assert!(ks.exists() && ks.is_encrypted() && !ks.corrupt_on_disk());
    let mut labels = ks.labels();
    labels.sort();
    assert_eq!(labels, vec!["otro", "yo"]);
    // La dirección se lee sin contraseña (para minar y ver saldo).
    assert_eq!(hex::encode(ks.public_key("yo").unwrap()), campo(&e, "yo"));
    assert_eq!(hex::encode(ks.public_key("otro").unwrap()), campo(&e, "otro"));
    // Firmar exige la contraseña, y la contraseña equivocada no abre nada.
    let kp = ks.keypair("yo", Some(&campo(&e, "password"))).expect("contraseña correcta");
    assert_eq!(hex::encode(kp.public_bytes()), campo(&e, "yo"));
    assert!(ks.keypair("yo", Some("otra")).is_err());
    assert!(ks.keypair("yo", None).is_err());
}

#[test]
fn el_keystore_plano_v1_sigue_abriendo() {
    let ks = Keystore::load(fixtures().join("wallet-v1.json"));
    assert!(ks.exists() && !ks.is_encrypted());
    assert_eq!(ks.labels(), vec!["plano"]);
    assert!(ks.keypair("plano", None).is_ok());
}

#[test]
fn la_cadena_regtest_se_carga_y_verifica_entera() {
    let e = esperado();
    let cd = ChainDir::new(fixtures().join("chain-regtest"));
    let tree = cd.load_tree(Params::regtest()).expect("la cadena de la v0.7.0 no carga");
    assert_eq!(tree.len() as u64, e["bloques"].as_u64().unwrap());
    let head = tree.get(&tree.head()).unwrap();
    assert_eq!(head.block.header.height, e["altura"].as_u64().unwrap());
    // Las transacciones que la v0.7.0 minó siguen en el estado: el commit y
    // su reveal (bloque estrictamente posterior) están aplicados.
    let st = tree.head_state().unwrap();
    let commit: [u8; 32] = hex::decode(campo(&e, "commit_txid")).unwrap().try_into().unwrap();
    assert!(st.revealed.contains(&commit), "el reveal de la v0.7.0 no consta como aplicado");
}

#[test]
fn el_nodo_nuevo_arranca_sobre_el_directorio_antiguo_y_no_lo_estropea() {
    let e = esperado();
    let dir = copia_cadena("spawn");
    let h = spawn(NodeConfig {
        chain_dir: dir.clone(),
        params: Params::regtest(),
        is_testnet: false,
        listen: None,
        seeds: vec![],
        miner: None,
        mining: false,
        lan_discovery: false,
        portmap: false,
    })
    .expect("el nodo no arrancó sobre los ficheros de la v0.7.0");
    let s = h.status();
    assert_eq!(s.height, e["altura"].as_u64().unwrap());
    assert_eq!(s.blocks_total as u64, e["bloques"].as_u64().unwrap());
    // La tx que quedó pendiente en mempool.jsonl sigue en el mempool.
    assert!(s.mempool >= 1, "el mempool de la v0.7.0 se perdió");
    // Y el hecho detrás de «sincronizado», sin pares: vamos por delante.
    assert!(s.synced);
    assert_eq!((s.sync.mi_altura, s.sync.pares_total, s.sync.atras), (s.height, 0, 0));
    drop(h);
    // Lo que había sigue leyéndose con los MISMOS formatos de la v0.7.0.
    let peers: Vec<String> = serde_json::from_str(&std::fs::read_to_string(dir.join("peers.json")).unwrap()).unwrap();
    assert_eq!(peers, vec![campo(&e, "peer_b")]);
    let ids: HashMap<String, String> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("known-identities.json")).unwrap()).unwrap();
    assert_eq!(ids[&campo(&e, "peer_b")], campo(&e, "identidad_par_b"));
    let claims: HashMap<String, u64> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("faucet_claims.json")).unwrap()).unwrap();
    assert_eq!(claims.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn la_identidad_del_nodo_es_la_misma_que_vio_el_otro_par() {
    let e = esperado();
    let id = load_or_create(&fixtures().join("chain-regtest/node.key")).expect("node.key de la v0.7.0 ilegible");
    assert_eq!(hex::encode(id.pubkey), campo(&e, "identidad_propia"));
    assert_eq!(id.fingerprint(), fingerprint(&id.pubkey));
    assert!(id.pow_ok(), "la prueba de trabajo de la identidad debe seguir valiendo");
}

#[test]
fn el_secreto_del_reveal_y_el_payload_siguen_disponibles() {
    let e = esperado();
    let (payload, secret) = load_reveal(&fixtures().join("chain-regtest"), &campo(&e, "commit_txid"))
        .expect("wallet_reveals.json de la v0.7.0 ilegible");
    assert_eq!(payload["termino"], "probable");
    assert_eq!(secret.len(), 32);
    // El libro de calibración es un archivo NUEVO: sobre un directorio de la
    // v0.7.0 empieza vacío y no toca wallet_reveals.json.
    assert!(rami_wallet::calibracion::cargar_libro(&fixtures().join("chain-regtest")).is_empty());
}
