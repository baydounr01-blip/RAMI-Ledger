//! Las cotas del bloque en el candidato del minero (v0.11.0).
//!
//! `apply_block` rechaza un bloque de más de `MAX_BLOCK_TXS` transacciones
//! (con la coinbase) o de más de `MAX_BLOCK_BYTES`. Hasta la v0.11.0 el
//! candidato no las miraba: un mempool grande, o una sola tx enorme (un
//! Reveal con un secreto de varios megabytes, que `verify_tx_con` no acota),
//! dejaba al minero fabricando bloques que ni su propio árbol admite, una y
//! otra vez mientras la tx siguiera en el mempool. Aquí se comprueba con las
//! piezas reales que el bloque sale dentro de las cotas y el árbol lo admite.

use rami_core::blocktree::BlockTree;
use rami_core::crypto::KeyPair;
use rami_core::params::Params;
use rami_core::tx::{commit_hash, tx_size, txid, Tx, MAX_BLOCK_BYTES, MAX_BLOCK_TXS};
use rami_node::{build_block, make_genesis, now_secs};
use rami_wallet::{build_reveal, build_transfer, sign_into};

fn mina(tree: &BlockTree, miner: [u8; 32], mempool: &[Tx]) -> rami_core::block::Block {
    let head = tree.head();
    let height = tree.get(&head).unwrap().block.header.height + 1;
    let bits = tree.expected_bits(&head);
    let state = tree.head_state().unwrap();
    let (block, _) = build_block(height, head, bits, miner, &state, mempool, *b"main", &tree.firma_ctx(now_secs()));
    block
}

/// Un Reveal de 3 MB no entra (no cabe en ningún bloque) y la tx que va
/// detrás, con el mismo nonce, sí: el bloque es válido.
#[test]
fn una_tx_mas_grande_que_el_bloque_se_salta() {
    let kp = KeyPair::from_secret(&[61u8; 32]);
    let yo = kp.public_bytes();
    let mut arbol = BlockTree::new(make_genesis(false, Params::regtest(), yo), Params::regtest()).unwrap();
    let ctx = arbol.firma_ctx(now_secs());
    for _ in 0..2 {
        let b = mina(&arbol, yo, &[]);
        arbol.insert(b).unwrap();
    }
    let payload = serde_json::json!({ "termino": "cota" });
    let secreto = vec![7u8; 3 * 1024 * 1024];
    let n = arbol.head_state().unwrap().nonce_of(&yo);
    let commit = sign_into(
        &ctx,
        &kp,
        Tx::Commit { by: yo, commitment: commit_hash(&payload, &secreto).unwrap(), fee: 1, nonce: n, sig: [0u8; 64] },
    );
    let b = mina(&arbol, yo, &[commit.clone()]);
    assert_eq!(b.txs.len(), 2);
    arbol.insert(b).unwrap();

    let enorme = build_reveal(&ctx, &kp, txid(&commit), &payload, secreto, 1, n + 1);
    assert!(tx_size(&enorme) > MAX_BLOCK_BYTES, "la prueba necesita una tx que no quepa");
    let pago = build_transfer(&ctx, &kp, [9u8; 32], 1, 1, n + 1);
    let b = mina(&arbol, yo, &[enorme, pago.clone()]);
    assert_eq!(b.txs.len(), 2, "coinbase y el pago; el Reveal no cabe");
    assert_eq!(b.txs[1], pago);
    arbol.insert(b).expect("el árbol admite el bloque de su propio minero");
}

/// Con más tx de las que caben, el candidato se corta en `MAX_BLOCK_TXS`
/// contando la coinbase; las que sobran esperan al bloque siguiente.
#[test]
fn el_candidato_se_corta_en_el_numero_maximo_de_tx() {
    let kp = KeyPair::from_secret(&[62u8; 32]);
    let yo = kp.public_bytes();
    let mut arbol = BlockTree::new(make_genesis(false, Params::regtest(), yo), Params::regtest()).unwrap();
    let ctx = arbol.firma_ctx(now_secs());
    for _ in 0..2 {
        let b = mina(&arbol, yo, &[]);
        arbol.insert(b).unwrap();
    }
    let n = arbol.head_state().unwrap().nonce_of(&yo);
    let total = MAX_BLOCK_TXS as u64 + 100;
    let mempool: Vec<Tx> = (0..total).map(|i| build_transfer(&ctx, &kp, [9u8; 32], 1, 1, n + i)).collect();
    let b = mina(&arbol, yo, &mempool);
    assert_eq!(b.txs.len(), MAX_BLOCK_TXS, "justo el máximo, con la coinbase");
    arbol.insert(b).expect("el árbol admite el bloque de su propio minero");
    // Las que sobran entran en el siguiente, en orden de nonce.
    let resto = &mempool[MAX_BLOCK_TXS - 1..];
    let b = mina(&arbol, yo, resto);
    assert_eq!(b.txs.len(), resto.len() + 1);
    arbol.insert(b).unwrap();
    assert_eq!(arbol.head_state().unwrap().nonce_of(&yo), n + total);
}
