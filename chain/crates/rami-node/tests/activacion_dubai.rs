//! Activación de **Dubái** (v0.9.0) de punta a punta, con las piezas reales:
//! génesis regtest, bloques minados con `build_block`, transacciones firmadas
//! por el monedero bajo el contexto que da el árbol, y árboles con y sin la
//! fecha abriendo los mismos bloques.
//!
//! Lo que se comprueba es lo que evita la bifurcación entre nodos con los
//! mismos parámetros, y que un nodo sin Dubái (un binario anterior, o regtest
//! sin fecha) no admite los bloques nuevos pero tampoco se rompe.

use rami_core::blocktree::BlockTree;
use rami_core::ciudad;
use rami_core::crypto::KeyPair;
use rami_core::params::Params;
use rami_core::state::COIN;
use rami_core::tx::{verify_tx_con, FirmaCtx, Tx};
use rami_node::{build_block, build_candidate, make_genesis, mine_header, now_secs};
use rami_wallet::{build_buy_parcel, build_claim_parcel, build_mint_asset, build_sell_asset, build_sell_parcel, build_transfer};

fn mina(tree: &mut BlockTree, miner: [u8; 32], mempool: &[Tx]) -> rami_core::block::Block {
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
fn dubai_se_activa_por_fecha_reparte_el_fondo_y_los_viejos_se_quedan_sin_romperse() {
    let kp = KeyPair::from_secret(&[41u8; 32]);
    let kp2 = KeyPair::from_secret(&[42u8; 32]);
    let miner = kp.public_bytes();
    let otro = kp2.public_bytes();
    let sin = Params::regtest(); // sin Dubái (como un binario anterior a v0.9.0)
    let genesis = make_genesis(false, sin, miner);
    let net = genesis.hash();

    let desde = now_secs() - 1;
    let con = sin.con_dubai_desde(Some(desde));
    let mut arbol = BlockTree::new(genesis.clone(), con).unwrap();
    let mut viejo = BlockTree::new(genesis.clone(), sin).unwrap();
    let ctx = arbol.firma_ctx(now_secs());
    assert!(ctx.dubai && ctx.numero() == 3);
    assert!(!viejo.firma_ctx(now_secs()).dubai);
    assert_eq!(ctx.city_size(), 64);

    // Génesis con Dubái ya vigente: el fondo empieza a llenarse con cada bloque
    // (20 % de la emisión) y la coinbase no puede cobrar la emisión entera.
    for _ in 0..7 {
        let b = mina(&mut arbol, miner, &[]);
        let cb = &b.txs[0];
        if let Tx::Coinbase { reward, .. } = cb {
            assert_eq!(*reward, 40 * COIN, "el minero cobra la emisión menos la parte de la ciudad");
        }
        arbol.insert(b.clone()).unwrap();
        // El viejo también los admite: una coinbase por debajo de su cota vale.
        viejo.insert(b).unwrap();
    }
    let st = arbol.head_state().unwrap();
    assert_eq!(st.city_fund, 7 * 10 * COIN, "sin empresas, el fondo solo acumula");
    assert_eq!(viejo.head_state().unwrap().city_fund, 0);
    // Un minero que cobre 50 bajo Dubái fabrica un bloque inválido.
    let avaro = {
        let head = arbol.head();
        let height = arbol.get(&head).unwrap().block.header.height + 1;
        let bits = arbol.expected_bits(&head);
        let state = arbol.head_state().unwrap();
        let (mut header, mut txs, _) = build_candidate(height, head, bits, miner, &state, &[], *b"main", now_secs(), &ctx);
        if let Some(Tx::Coinbase { reward, .. }) = txs.first_mut() {
            *reward = 50 * COIN;
        }
        header.merkle_root = rami_core::tx::merkle_root_txids(&txs.iter().map(rami_core::tx::txid).collect::<Vec<_>>());
        rami_core::block::Block { header: mine_header(header), txs }
    };
    let err = arbol.insert(avaro).unwrap_err();
    assert!(err.contains("cota"), "motivo: {err}");

    // El monedero monta un hotel en Downtown (46,17): 250 RAMI, y le pasa fondos a `otro`.
    let ctx = arbol.firma_ctx(now_secs());
    let nonce = arbol.head_state().unwrap().nonce_of(&miner);
    let hotel = build_claim_parcel(&ctx, &kp, 46, 17, "Hotel Downtown", 5, 1, nonce);
    let pago = build_transfer(&ctx, &kp, otro, 60 * COIN, 1, nonce + 1);
    assert!(verify_tx_con(&hotel, &ctx).is_ok());
    assert!(verify_tx_con(&hotel, &viejo.firma_ctx(now_secs())).is_err(), "sector 5 no existe antes de Dubái");
    let b = mina(&mut arbol, miner, &[hotel.clone(), pago.clone()]);
    assert_eq!(b.txs.len(), 3, "coinbase + hotel + pago");
    arbol.insert(b.clone()).unwrap();
    let st = arbol.head_state().unwrap();
    let p = &st.parcels[&(46, 17)];
    assert_eq!(p.kind, 5);
    assert_eq!(ciudad::distrito(46, 17).clave, "downtown");
    assert!(st.quemado >= 250 * COIN, "el precio del distrito se quema");
    assert!(p.ultimo_ingreso > 0, "en el mismo bloque la única empresa ya cobra del fondo");
    assert!(p.importado > 0, "sin proveedores en la ciudad, sus insumos se importan (se queman)");
    // El viejo no lo admite (tipo de parcela desconocido) y sigue entero.
    let err = viejo.insert(b.clone()).unwrap_err();
    assert!(err.contains("tipo de parcela") || err.contains("fuera de la ciudad"), "motivo: {err}");
    assert_eq!(viejo.len(), 8);
    // Un gemelo con los MISMOS parámetros llega a la misma cabeza y al mismo saldo.
    let mut gemelo = BlockTree::new(genesis.clone(), con).unwrap();
    for h in arbol.observer_chain().iter().skip(1) {
        gemelo.insert(arbol.get(h).unwrap().block.clone()).unwrap();
    }
    assert_eq!(gemelo.head(), arbol.head());
    assert_eq!(gemelo.head_state().unwrap().balance_of(&miner), st.balance_of(&miner));

    // Mercado: el hotel se pone en venta por 30 RAMI y `otro` lo compra; en la
    // misma transacción cambia el dueño y se apunta la operación.
    let ctx = arbol.firma_ctx(now_secs());
    let n1 = st.nonce_of(&miner);
    let venta = build_sell_parcel(&ctx, &kp, 46, 17, 30 * COIN, 1, n1);
    let compra = build_buy_parcel(&ctx, &kp2, 46, 17, 30 * COIN, 1, 0);
    let b = mina(&mut arbol, miner, &[venta, compra]);
    assert_eq!(b.txs.len(), 3);
    arbol.insert(b.clone()).unwrap();
    let st = arbol.head_state().unwrap();
    assert_eq!(st.parcels[&(46, 17)].owner, otro);
    assert_eq!(st.trades.len(), 1);
    assert_eq!(st.trades[0].price, 30 * COIN);
    // El viejo: huérfano (no tiene el padre).
    assert!(viejo.insert(b).is_err());
    assert_eq!(viejo.len(), 8);

    // El nuevo dueño acuña un local (20 RAMI) y lo pone en venta; un vehículo no (no es concesionario).
    let ctx = arbol.firma_ctx(now_secs());
    let local = build_mint_asset(&ctx, &kp2, 46, 17, 3, "Local 1", 1, 1);
    let coche = build_mint_asset(&ctx, &kp2, 46, 17, 2, "Coche", 1, 2);
    let b = mina(&mut arbol, miner, &[local.clone(), coche]);
    assert_eq!(b.txs.len(), 2, "el candidato deja fuera el vehículo que no aplica");
    arbol.insert(b).unwrap();
    let ctx = arbol.firma_ctx(now_secs());
    let venta_local = build_sell_asset(&ctx, &kp2, rami_core::tx::txid(&local), 2 * COIN, 1, 2);
    let b = mina(&mut arbol, miner, &[venta_local]);
    assert_eq!(b.txs.len(), 2);
    arbol.insert(b).unwrap();
    let st = arbol.head_state().unwrap();
    assert_eq!(st.assets[&rami_core::tx::txid(&local)].sale, Some(2 * COIN));

    // La regla no retrocede: un bloque con timestamp anterior a la fecha, hijo
    // de un bloque Dubái, sigue rigiéndose por Dubái (una tx de mercado entra).
    let ctx_dubai = FirmaCtx::v1().con_dubai(true);
    let retira = build_sell_asset(&ctx_dubai, &kp2, rami_core::tx::txid(&local), 0, 1, 3);
    let viejo_ts = mina_con(&arbol, miner, &[retira], desde - 3600, &ctx_dubai);
    assert_eq!(viejo_ts.txs.len(), 2);
    assert!(arbol.dubai_sobre(&arbol.head(), desde - 3600));
    arbol.insert(viejo_ts).unwrap();
    assert_eq!(arbol.head_state().unwrap().assets[&rami_core::tx::txid(&local)].sale, None);
    let _ = net;
}

#[test]
fn sin_fecha_dubai_no_rige_y_nada_cambia() {
    let kp = KeyPair::from_secret(&[43u8; 32]);
    let miner = kp.public_bytes();
    let p = Params::regtest();
    let genesis = make_genesis(false, p, miner);
    let mut tree = BlockTree::new(genesis, p).unwrap();
    let ctx = tree.firma_ctx(now_secs());
    assert!(!ctx.dubai);
    assert_eq!(ctx.city_size(), 32);
    // La coinbase cobra la emisión entera y el fondo no existe.
    let b = mina(&mut tree, miner, &[]);
    if let Tx::Coinbase { reward, .. } = &b.txs[0] {
        assert_eq!(*reward, 50 * COIN);
    }
    tree.insert(b).unwrap();
    assert_eq!(tree.head_state().unwrap().city_fund, 0);
    // Una tx de mercado no entra en el mempool ni en un bloque.
    let venta = build_sell_parcel(&ctx, &kp, 3, 3, 5, 1, 0);
    assert!(verify_tx_con(&venta, &ctx).is_err());
    let b = mina(&mut tree, miner, &[venta]);
    assert_eq!(b.txs.len(), 1);
}
