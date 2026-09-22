//! Activación de la **escritura de vivienda** (v0.11.0) de punta a punta, con
//! las piezas reales: génesis regtest, bloques minados con `build_block`,
//! transacciones firmadas por el monedero bajo el contexto que da el árbol, y
//! árboles con y sin la fecha de vivienda abriendo los mismos bloques.
//!
//! El árbol «viejo» tiene Dubái y no tiene vivienda: es lo que ve un binario
//! v0.10.x. Admite todo hasta el primer bloque con una transacción de vivienda
//! y ahí se queda, sin romperse.

use rami_core::blocktree::BlockTree;
use rami_core::crypto::KeyPair;
use rami_core::params::Params;
use rami_core::state::{viviendas_ajenas_recontadas, COIN};
use rami_core::tx::{txid, verify_tx_con, FirmaCtx, Tx};
use rami_node::{build_block, build_candidate, make_genesis, mine_header, now_secs};
use rami_wallet::{build_buy_unit, build_claim_parcel, build_divide_parcel, build_mint_asset, build_sell_unit, build_transfer, build_transfer_unit};

fn mina(tree: &BlockTree, miner: [u8; 32], mempool: &[Tx]) -> rami_core::block::Block {
    let head = tree.head();
    let height = tree.get(&head).unwrap().block.header.height + 1;
    let bits = tree.expected_bits(&head);
    let state = tree.head_state().unwrap();
    let (block, _) = build_block(height, head, bits, miner, &state, mempool, *b"main", &tree.firma_ctx(now_secs()));
    block
}

fn mina_con(tree: &BlockTree, miner: [u8; 32], mempool: &[Tx], ts: u64, ctx: &FirmaCtx) -> rami_core::block::Block {
    let head = tree.head();
    let height = tree.get(&head).unwrap().block.header.height + 1;
    let bits = tree.expected_bits(&head);
    let state = tree.head_state().unwrap();
    let (header, txs, _) = build_candidate(height, head, bits, miner, &state, mempool, *b"main", ts, ctx);
    rami_core::block::Block { header: mine_header(header), txs }
}

#[test]
fn vivienda_se_activa_por_fecha_y_los_binarios_sin_ella_se_quedan_sin_romperse() {
    let kp = KeyPair::from_secret(&[51u8; 32]);
    let kp2 = KeyPair::from_secret(&[52u8; 32]);
    let yo = kp.public_bytes();
    let ella = kp2.public_bytes();
    let solo_dubai = Params::regtest().con_dubai_desde(Some(0)); // como un binario v0.10.x
    let genesis = make_genesis(false, solo_dubai, yo);
    let desde = now_secs() - 1;
    let con = solo_dubai.con_vivienda_desde(Some(desde));
    let mut arbol = BlockTree::new(genesis.clone(), con).unwrap();
    let mut viejo = BlockTree::new(genesis.clone(), solo_dubai).unwrap();
    let ctx = arbol.firma_ctx(now_secs());
    assert!(ctx.vivienda_rige() && ctx.numero() == 4);
    let ctx_viejo = viejo.firma_ctx(now_secs());
    assert!(ctx_viejo.dubai && !ctx_viejo.vivienda_rige() && ctx_viejo.numero() == 3);

    // Bloques 1-2: coinbase de Dubái; los dos árboles los admiten.
    for _ in 0..2 {
        let b = mina(&arbol, yo, &[]);
        arbol.insert(b.clone()).unwrap();
        viejo.insert(b).unwrap();
    }
    // Bloque 3: una inmobiliaria en el desierto (21,45) y fondos para ella.
    let n = arbol.head_state().unwrap().nonce_of(&yo);
    let claim = build_claim_parcel(&ctx, &kp, 21, 45, "Residencial", 7, 1, n);
    let pago = build_transfer(&ctx, &kp, ella, 30 * COIN, 1, n + 1);
    let b = mina(&arbol, yo, &[claim, pago]);
    assert_eq!(b.txs.len(), 3);
    arbol.insert(b.clone()).unwrap();
    viejo.insert(b).unwrap();
    assert_eq!(arbol.head(), viejo.head(), "hasta aquí, la misma cadena");

    // Bloque 4: la división. El candidato de un binario sin vivienda la deja
    // fuera (no verifica bajo su regla); el árbol nuevo la admite.
    let n = arbol.head_state().unwrap().nonce_of(&yo);
    let divide = build_divide_parcel(&ctx, &kp, 21, 45, 8, 1, n);
    assert!(verify_tx_con(&divide, &ctx).is_ok());
    let err = verify_tx_con(&divide, &ctx_viejo).unwrap_err();
    assert!(err.contains("vivienda antes de su activación"), "motivo: {err}");
    let del_viejo = mina_con(&viejo, yo, &[divide.clone()], now_secs(), &ctx_viejo);
    assert_eq!(del_viejo.txs.len(), 1, "el minero sin vivienda no la incluye");
    let b4 = mina(&arbol, yo, &[divide]);
    assert_eq!(b4.txs.len(), 2);
    arbol.insert(b4.clone()).unwrap();
    let st = arbol.head_state().unwrap();
    assert_eq!(st.parcels[&(21, 45)].unidades, 8);
    // El viejo no lo admite y sigue entero, en su altura.
    let err = viejo.insert(b4.clone()).unwrap_err();
    assert!(err.contains("antes de su activación"), "motivo: {err}");
    assert_eq!(viejo.len(), 4);

    // Bloque 5: la vivienda 3 en venta por 4 RAMI y ella la compra en el
    // mismo bloque; la 5 se la transfiere a ella.
    let ctx = arbol.firma_ctx(now_secs());
    let n = st.nonce_of(&yo);
    let vende = build_sell_unit(&ctx, &kp, 21, 45, 3, 4 * COIN, 1, n);
    let da = build_transfer_unit(&ctx, &kp, 21, 45, 5, ella, 1, n + 1);
    let compra = build_buy_unit(&ctx, &kp2, 21, 45, 3, 4 * COIN, 1, 0);
    let saldo_ella = st.balance_of(&ella);
    let b5 = mina(&arbol, yo, &[vende, da, compra]);
    assert_eq!(b5.txs.len(), 4);
    arbol.insert(b5.clone()).unwrap();
    let st = arbol.head_state().unwrap();
    let p = &st.parcels[&(21, 45)];
    assert_eq!(p.units[2].owner, ella);
    assert_eq!(p.units[4].owner, ella);
    assert_eq!(p.units[2].sale, None);
    assert_eq!(st.balance_of(&ella), saldo_ella - 4 * COIN - 1);
    assert_eq!(st.viviendas_ajenas_de(&ella), 2);
    assert_eq!(viviendas_ajenas_recontadas(&st), st.viviendas_ajenas);
    let t = st.trades.back().unwrap();
    assert_eq!((t.kind, t.price), (2, 4 * COIN));
    // Para el viejo es un huérfano (no tiene el padre).
    assert!(viejo.insert(b5).is_err());
    assert_eq!(viejo.len(), 4);

    // Bloque 6: ella, dueña de dos viviendas, acuña un local en la parcela.
    let ctx = arbol.firma_ctx(now_secs());
    let local = build_mint_asset(&ctx, &kp2, 21, 45, 3, "Mi piso · local", 1, 1);
    let b6 = mina(&arbol, yo, &[local.clone()]);
    assert_eq!(b6.txs.len(), 2);
    arbol.insert(b6).unwrap();
    assert_eq!(arbol.head_state().unwrap().assets[&txid(&local)].owner, ella);

    // Un gemelo con los MISMOS parámetros llega a la misma cabeza y al mismo estado.
    let mut gemelo = BlockTree::new(genesis.clone(), con).unwrap();
    for h in arbol.observer_chain().iter().skip(1) {
        gemelo.insert(arbol.get(h).unwrap().block.clone()).unwrap();
    }
    assert_eq!(gemelo.head(), arbol.head());
    assert_eq!(gemelo.head_state().unwrap().parcels, arbol.head_state().unwrap().parcels);

    // La regla no retrocede: un bloque con timestamp una hora anterior a la
    // fecha, hijo de un bloque con vivienda, sigue rigiéndose por ella.
    let ctx_viv = FirmaCtx::v1().con_dubai(true).con_vivienda(true);
    let retira = build_sell_unit(&ctx_viv, &kp2, 21, 45, 3, 9 * COIN, 1, 2);
    assert!(arbol.vivienda_sobre(&arbol.head(), desde - 3600));
    let antiguo = mina_con(&arbol, yo, &[retira], desde - 3600, &ctx_viv);
    assert_eq!(antiguo.txs.len(), 2);
    arbol.insert(antiguo).unwrap();
    assert_eq!(arbol.head_state().unwrap().parcels[&(21, 45)].units[2].sale, Some(9 * COIN));
}

#[test]
fn sin_fecha_la_vivienda_no_rige_y_nada_cambia() {
    let kp = KeyPair::from_secret(&[53u8; 32]);
    let yo = kp.public_bytes();
    // Regtest con Dubái y sin vivienda, y regtest con vivienda y sin Dubái:
    // en ninguno de los dos rige (vivienda implica Dubái).
    for p in [Params::regtest().con_dubai_desde(Some(0)), Params::regtest().con_vivienda_desde(Some(0))] {
        let genesis = make_genesis(false, p, yo);
        let mut tree = BlockTree::new(genesis, p).unwrap();
        let ctx = tree.firma_ctx(now_secs());
        assert!(!ctx.vivienda_rige());
        let claim = build_claim_parcel(&ctx, &kp, 5, 5, "Casa", 1, 1, 0);
        let b = mina(&tree, yo, &[claim]);
        assert_eq!(b.txs.len(), 2);
        tree.insert(b).unwrap();
        let divide = build_divide_parcel(&ctx, &kp, 5, 5, 4, 1, 1);
        assert!(verify_tx_con(&divide, &ctx).is_err());
        let b = mina(&tree, yo, &[divide]);
        assert_eq!(b.txs.len(), 1, "la división no entra en ningún bloque");
        tree.insert(b).unwrap();
        assert_eq!(tree.head_state().unwrap().parcels[&(5, 5)].unidades, 0);
    }
}
