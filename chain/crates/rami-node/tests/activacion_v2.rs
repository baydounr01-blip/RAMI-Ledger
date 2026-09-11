//! Activación de la regla de firma v2 (v0.8.0) de punta a punta, con las
//! piezas reales: génesis regtest, bloques minados con `build_block`, tx
//! firmadas por el monedero bajo el contexto que rige y árboles con y sin
//! activación abriendo los mismos bloques.
//!
//! Lo que se prueba es lo que evita la bifurcación: dos árboles con los
//! MISMOS parámetros llegan al mismo veredicto para el mismo bloque; y un
//! árbol con la regla v1 para siempre (un binario anterior, o regtest sin
//! fecha) no admite un bloque con firmas v2 pero tampoco se rompe.

use rami_core::blocktree::BlockTree;
use rami_core::crypto::KeyPair;
use rami_core::params::Params;
use rami_core::tx::{regla_para, verify_tx_con, FirmaCtx, Regla};
use rami_node::{build_block, build_candidate, make_genesis, mine_header, now_secs};
use rami_wallet::build_transfer;

fn mina(tree: &mut BlockTree, miner: [u8; 32], mempool: &[rami_core::tx::Tx]) -> rami_core::block::Block {
    let head = tree.head();
    let height = tree.get(&head).unwrap().block.header.height + 1;
    let bits = tree.expected_bits(&head);
    let state = tree.head_state().unwrap();
    let (block, _) = build_block(height, head, bits, miner, &state, mempool, *b"main", &tree.firma_ctx(now_secs()));
    block
}

/// Como `mina`, pero con el timestamp que se pida y el contexto que se pida
/// (para fabricar bloques que un minero honrado no haría).
fn mina_con(tree: &BlockTree, miner: [u8; 32], mempool: &[rami_core::tx::Tx], ts: u64, firma: &FirmaCtx) -> rami_core::block::Block {
    let head = tree.head();
    let height = tree.get(&head).unwrap().block.header.height + 1;
    let bits = tree.expected_bits(&head);
    let state = tree.head_state().unwrap();
    let (header, txs, _) = build_candidate(height, head, bits, miner, &state, mempool, *b"main", ts, firma);
    rami_core::block::Block { header: mine_header(header), txs }
}

#[test]
fn la_activacion_por_fecha_decide_la_regla_y_los_viejos_se_quedan_sin_romperse() {
    let kp = KeyPair::from_secret(&[11u8; 32]);
    let miner = kp.public_bytes();
    let otro = [5u8; 32];
    let sin = Params::regtest(); // v1 para siempre (como un binario anterior a v0.8.0)
    let genesis = make_genesis(false, sin, miner);
    let net = genesis.hash();

    // Activación ya vigente para este árbol.
    let desde = now_secs() - 1;
    let con = sin.con_firma_v2_desde(Some(desde));
    let mut arbol_v2 = BlockTree::new(genesis.clone(), con).unwrap();
    let mut arbol_v1 = BlockTree::new(genesis.clone(), sin).unwrap();
    assert_eq!(arbol_v2.firma_ctx(now_secs()).regla, Regla::V2);
    assert_eq!(arbol_v1.firma_ctx(now_secs()).regla, Regla::V1);
    assert_eq!(regla_para(Some(desde), desde - 1), Regla::V1, "antes de la fecha rige v1 también con activación");
    // (El génesis de este árbol ya tiene timestamp ≥ fecha, así que sobre él
    // rige v2 aunque el hijo traiga un timestamp anterior: la regla no retrocede.)
    assert!(arbol_v2.firma_v2_sobre(&arbol_v2.head(), desde - 1));

    // El monedero firma con el contexto que le da el árbol (v2, ligada a la red).
    let firma = arbol_v2.firma_ctx(now_secs());
    let tx_v2 = build_transfer(&firma, &kp, otro, 3, 1, 0);
    let tx_v1 = build_transfer(&FirmaCtx::v1(), &kp, otro, 3, 1, 0);
    assert!(verify_tx_con(&tx_v2, &firma).is_ok());
    assert!(verify_tx_con(&tx_v1, &firma).is_err(), "una firma v1 no vale tras la activación");
    // Y una firma v2 de OTRA red no vale en esta.
    let ajena = build_transfer(&FirmaCtx::v2([9u8; 32]), &kp, otro, 3, 1, 0);
    assert!(verify_tx_con(&ajena, &firma).is_err());

    // El minero sólo incluye lo que vale bajo la regla del bloque: la v1 se queda fuera.
    let b1 = mina(&mut arbol_v2, miner, &[tx_v1.clone(), tx_v2.clone()]);
    assert_eq!(b1.txs.len(), 2, "coinbase + la tx v2");
    assert_eq!(b1.txs[1], tx_v2);
    arbol_v2.insert(b1.clone()).expect("el árbol con activación admite el bloque v2");

    // El árbol SIN activación (binario viejo) no lo admite… y sigue entero.
    let err = arbol_v1.insert(b1.clone()).unwrap_err();
    assert!(err.contains("firma"), "motivo: {err}");
    assert_eq!(arbol_v1.len(), 1);
    assert_eq!(arbol_v1.head(), net);

    // Otro árbol con los MISMOS parámetros llega al mismo veredicto (sin bifurcación).
    let mut gemelo = BlockTree::new(genesis.clone(), con).unwrap();
    gemelo.insert(b1.clone()).unwrap();
    assert_eq!(gemelo.head(), arbol_v2.head());
    assert_eq!(gemelo.head_state().unwrap().balance_of(&otro), 3);

    // Un bloque sólo con coinbase vale para todos: la regla sólo muerde a las firmas.
    let b2 = mina(&mut arbol_v2, miner, &[]);
    arbol_v2.insert(b2.clone()).unwrap();
    assert!(arbol_v1.insert(b2).is_err(), "huérfano para el viejo: su padre (b1) no está");
    assert_eq!(arbol_v1.len(), 1, "el viejo se queda en el génesis, sin romperse");

    // Activada en la rama, la regla no vuelve atrás: un bloque con timestamp
    // ANTERIOR a la fecha, hijo de un bloque v2, sigue exigiendo v2. Sin esto,
    // un minero podría colar firmas v1 (repetidas de otra red) tras la
    // activación, porque la cadena no acota el timestamp.
    let kp2 = KeyPair::from_secret(&[13u8; 32]);
    let tx_v1_tarde = build_transfer(&FirmaCtx::v1(), &kp, kp2.public_bytes(), 1, 1, 1);
    let viejo_ts = mina_con(&arbol_v2, miner, &[tx_v1_tarde.clone()], desde - 3600, &FirmaCtx::v1());
    assert_eq!(viejo_ts.txs.len(), 2, "el candidato v1 sí la incluye");
    let err = arbol_v2.insert(viejo_ts).unwrap_err();
    assert!(err.contains("firma"), "motivo: {err}");
    assert!(arbol_v2.firma_v2_sobre(&arbol_v2.head(), desde - 3600));
    // Y el mismo bloque con la firma v2 entra aunque su timestamp sea antiguo.
    let tx_v2_tarde = build_transfer(&FirmaCtx::v2(net), &kp, kp2.public_bytes(), 1, 1, 1);
    let ok = mina_con(&arbol_v2, miner, &[tx_v2_tarde], desde - 3600, &FirmaCtx::v2(net));
    assert_eq!(ok.txs.len(), 2);
    arbol_v2.insert(ok).unwrap();
}

#[test]
fn sin_fecha_todo_sigue_como_en_v0_7() {
    let kp = KeyPair::from_secret(&[12u8; 32]);
    let miner = kp.public_bytes();
    let p = Params::regtest();
    let genesis = make_genesis(false, p, miner);
    let mut tree = BlockTree::new(genesis, p).unwrap();
    let firma = tree.firma_ctx(now_secs());
    assert_eq!(firma, FirmaCtx { regla: Regla::V1, net: tree.genesis });
    let tx = build_transfer(&firma, &kp, [6u8; 32], 2, 1, 0);
    // La misma firma que produciría la v0.7.x (verify_tx = regla v1).
    assert!(rami_core::tx::verify_tx(&tx).is_ok());
    let b = mina(&mut tree, miner, &[tx]);
    assert_eq!(b.txs.len(), 2);
    tree.insert(b).unwrap();
}
