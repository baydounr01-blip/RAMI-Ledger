//! Identidad y multiverso (v0.10.0) con las piezas reales: un perfil con
//! nombre único y vínculo firmado por la identidad del nodo entra en la
//! cadena, un binario sin perfiles se queda en su altura sin romperse, la
//! ficha del jugador sale de hechos, y dos puntas del árbol son dos ciudades
//! cuyas diferencias son los edificios «en superposición».

use std::collections::HashSet;

use rami_core::blocktree::BlockTree;
use rami_core::crypto::KeyPair;
use rami_core::params::Params;
use rami_core::tx::{vinculo_mensaje, Tx};
use rami_node::{build_block, fantasmas, grado_jugador, make_genesis, now_secs, profile_view};
use rami_wallet::{build_claim_parcel, build_set_profile};

fn mina(tree: &BlockTree, miner: [u8; 32], mempool: &[Tx]) -> rami_core::block::Block {
    let head = tree.head();
    let height = tree.get(&head).unwrap().block.header.height + 1;
    let bits = tree.expected_bits(&head);
    let state = tree.head_state().unwrap();
    let (block, _) = build_block(height, head, bits, miner, &state, mempool, *b"main", &tree.firma_ctx(now_secs()));
    block
}

#[test]
fn perfil_vinculado_ficha_del_jugador_y_ciudades_paralelas() {
    let kp = KeyPair::from_secret(&[51u8; 32]);
    let nodo = KeyPair::from_secret(&[52u8; 32]); // hace de identidad del nodo
    let miner = kp.public_bytes();
    let sin = Params::regtest();
    let genesis = make_genesis(false, sin, miner);
    let con = sin.con_dubai_desde(Some(now_secs() - 1));
    let mut arbol = BlockTree::new(genesis.clone(), con).unwrap();
    let mut viejo = BlockTree::new(genesis.clone(), con).unwrap(); // mismo consenso, para bifurcar
    let mut anterior = BlockTree::new(genesis, sin).unwrap(); // binario sin Dubái

    // Saldo para pagar el perfil (2 RAMI quemados) y una empresa.
    for _ in 0..4 {
        let b = mina(&arbol, miner, &[]);
        arbol.insert(b.clone()).unwrap();
        viejo.insert(b.clone()).unwrap();
        anterior.insert(b).unwrap();
    }
    let ctx = arbol.firma_ctx(now_secs());
    assert!(ctx.dubai);
    let st = arbol.head_state().unwrap();
    let nonce = st.nonce_of(&miner);
    let firma_nodo = nodo.sign(&vinculo_mensaje(&miner));
    let perfil = build_set_profile(&ctx, &kp, "rami", "Rami", "aprendo a hacer negocios", 2, 7, Some((nodo.public_bytes(), firma_nodo)), 1, nonce);
    let cafe = build_claim_parcel(&ctx, &kp, 57, 36, "Café Internacional", 22, 1, nonce + 1);
    let b = mina(&arbol, miner, &[perfil, cafe]);
    assert_eq!(b.txs.len(), 3, "coinbase + perfil + cafetería");
    arbol.insert(b.clone()).unwrap();
    let st = arbol.head_state().unwrap();
    let p = &st.profiles[&miner];
    assert_eq!((p.handle.as_str(), p.display.as_str(), p.avatar, p.color), ("rami", "Rami", 2, 7));
    assert_eq!(st.handles["rami"], miner);
    assert_eq!(st.nodes[&nodo.public_bytes()], miner);
    // El binario sin Dubái no admite el bloque y sigue entero en su altura.
    assert!(anterior.insert(b.clone()).is_err());
    assert_eq!(anterior.get(&anterior.head()).unwrap().block.header.height, 4);

    // La ficha: letra por hechos (una empresa que ya cobra: C), número por lo
    // observado (su nodo está en la ciudad y el vínculo está en la cadena: 1).
    let height = arbol.get(&arbol.head()).unwrap().block.header.height;
    let presentes: HashSet<[u8; 32]> = [nodo.public_bytes()].into_iter().collect();
    let ficha = profile_view(&st, height, &miner, &presentes, &HashSet::new()).unwrap();
    assert_eq!(ficha.grado.codigo, "C1", "motivos: {:?}", ficha.grado.motivos);
    assert_eq!(ficha.empresas.len(), 1);
    assert!(ficha.presente && ficha.ingresos > 0);
    assert_eq!(ficha.node_pk, hex::encode(nodo.public_bytes()));
    // Sin su nodo a la vista, solo un avatar que dice llamarse «rami»: 2. Sin nadie: 3.
    let nombres: HashSet<String> = ["rami".to_string()].into_iter().collect();
    assert_eq!(profile_view(&st, height, &miner, &HashSet::new(), &nombres).unwrap().grado.codigo, "C2");
    assert_eq!(grado_jugador(&st, height, &miner, false, false).codigo, "C3");
    assert_eq!(grado_jugador(&st, height, &nodo.public_bytes(), false, false).codigo, "F6", "sin perfil: F6");

    // Bifurcación: el otro árbol mina, desde la misma altura, un bloque con
    // OTRA empresa. Al reunir los dos bloques en un árbol hay dos puntas: dos
    // ciudades. Lo que existe en una y no en la otra está en superposición.
    let ctx2 = viejo.firma_ctx(now_secs());
    let tienda = build_claim_parcel(&ctx2, &kp, 57, 37, "Tienda Internacional", 27, 1, viejo.head_state().unwrap().nonce_of(&miner));
    let b2 = mina(&viejo, miner, &[tienda]);
    assert_eq!(b2.txs.len(), 2, "coinbase + tienda");
    assert_ne!(b2.hash(), b.hash());
    viejo.insert(b2.clone()).unwrap();
    arbol.insert(b2.clone()).unwrap();
    assert_eq!(arbol.tips().len(), 2);
    let cabeza = arbol.head();
    let otra = if cabeza == b.hash() { b2.hash() } else { b.hash() };
    let (ghosts, total) = fantasmas(arbol.tip_state_of(&cabeza).unwrap(), arbol.tip_state_of(&otra).unwrap());
    assert_eq!(total, 2);
    let estados: Vec<(u16, u16, &str)> = ghosts.iter().map(|g| (g.x, g.y, g.estado.as_str())).collect();
    assert!(estados.contains(&(57, 37, if cabeza == b.hash() { "solo_alli" } else { "solo_aqui" })), "{estados:?}");
    assert!(estados.contains(&(57, 36, if cabeza == b.hash() { "solo_aqui" } else { "solo_alli" })), "{estados:?}");
    // La misma ciudad frente a sí misma no tiene fantasmas.
    assert_eq!(fantasmas(arbol.tip_state_of(&cabeza).unwrap(), arbol.tip_state_of(&cabeza).unwrap()).1, 0);
}
