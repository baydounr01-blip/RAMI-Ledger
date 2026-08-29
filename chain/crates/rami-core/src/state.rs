//! Estado de cuentas y función de transición. Aquí viven las reglas económicas
//! y la consistencia de rama del observador:
//!   * nonce por cuenta estrictamente secuencial  => imposible el doble gasto,
//!   * cota de recompensa (emisión + comisiones)   => imposible inflar la emisión,
//!   * regla anti-look-ahead de commit/reveal       => el reveal va en un bloque
//!     ESTRICTAMENTE posterior al commit, mismo firmante, hash reproducido.
//!
//! La red neuronal y el desempate de Collatz NO intervienen aquí.

use std::collections::HashMap;

use serde_json::Value;

use crate::block::Block;
use crate::tx::{merkle_root_txids, txid, verify_tx, AccountId, Amount, Tx, TxId};

/// 1 RAMI = 100_000_000 ramiwei (8 decimales, como BTC).
pub const COIN: Amount = 100_000_000;
/// Recompensa inicial de bloque: 50 RAMI.
pub const INITIAL_REWARD: Amount = 50 * COIN;
/// Intervalo de halving (bloques). Testnet: como Bitcoin, 210_000.
pub const HALVING_INTERVAL: u64 = 210_000;

/// Recompensa de emisión a una altura dada (se halviza cada HALVING_INTERVAL).
pub fn block_reward(height: u64) -> Amount {
    let halvings = height / HALVING_INTERVAL;
    if halvings >= 64 {
        return 0;
    }
    INITIAL_REWARD >> halvings
}

/// Suministro máximo teórico (suma de la serie de emisión). ~21 M * COIN.
pub fn max_supply() -> u128 {
    let mut total: u128 = 0;
    let mut halvings = 0u64;
    loop {
        let reward = block_reward(halvings * HALVING_INTERVAL) as u128;
        if reward == 0 {
            break;
        }
        total += reward * HALVING_INTERVAL as u128;
        halvings += 1;
    }
    total
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Account {
    pub balance: Amount,
    pub staked: Amount,
    pub nonce: u64,
}

#[derive(Clone, Debug, Default)]
pub struct State {
    pub accounts: HashMap<AccountId, Account>,
    /// commit_txid -> (firmante, altura de inclusión del commit)
    pub commits: HashMap<TxId, (AccountId, u64)>,
    /// commit_txid -> commitment de 32 bytes registrado por la tx Commit
    pub commit_commitment: HashMap<TxId, [u8; 32]>,
    /// commits ya revelados (no se puede revelar dos veces)
    pub revealed: std::collections::HashSet<TxId>,
    pub height: u64,
}

impl State {
    pub fn balance_of(&self, id: &AccountId) -> Amount {
        self.accounts.get(id).map(|a| a.balance).unwrap_or(0)
    }
    pub fn nonce_of(&self, id: &AccountId) -> u64 {
        self.accounts.get(id).map(|a| a.nonce).unwrap_or(0)
    }
    fn acct(&mut self, id: &AccountId) -> &mut Account {
        self.accounts.entry(*id).or_default()
    }
}

/// Aplica un bloque al estado (que debe ser el estado tras el bloque padre).
/// Devuelve `Ok(())` y muta `state`, o `Err` con el motivo (bloque inválido).
pub fn apply_block(state: &mut State, block: &Block, expected_height: u64) -> Result<(), String> {
    if block.header.height != expected_height {
        return Err(format!(
            "altura {} != esperada {}",
            block.header.height, expected_height
        ));
    }

    // 1) Merkle raíz coincide con las transacciones.
    let ids: Vec<TxId> = block.txs.iter().map(txid).collect();
    if merkle_root_txids(&ids) != block.header.merkle_root {
        return Err("merkle_root no coincide con las transacciones".into());
    }

    // 2) Exactamente una coinbase, en el índice 0, con la altura del bloque.
    let coinbase_count = block.txs.iter().filter(|t| matches!(t, Tx::Coinbase { .. })).count();
    if coinbase_count != 1 {
        return Err("debe haber exactamente una coinbase".into());
    }
    if !matches!(block.txs.first(), Some(Tx::Coinbase { .. })) {
        return Err("la coinbase debe ser la primera transacción".into());
    }

    // 3) Verificación sin estado de todas las tx (estructura + firma).
    for tx in &block.txs {
        verify_tx(tx)?;
    }

    // 4) Suma de comisiones de las tx no-coinbase (para acotar la recompensa).
    let mut total_fees: u128 = 0;
    for tx in &block.txs {
        match tx {
            Tx::Coinbase { .. } => {}
            Tx::Transfer { fee, .. }
            | Tx::Stake { fee, .. }
            | Tx::Unstake { fee, .. }
            | Tx::Commit { fee, .. }
            | Tx::Reveal { fee, .. } => total_fees += *fee as u128,
        }
    }

    // 5) Cota de la recompensa coinbase = emisión(altura) + comisiones.
    if let Some(Tx::Coinbase { height, reward, .. }) = block.txs.first() {
        if *height != expected_height {
            return Err("altura de la coinbase incorrecta".into());
        }
        let cap = block_reward(expected_height) as u128 + total_fees;
        if *reward as u128 > cap {
            return Err(format!("recompensa coinbase {reward} > cota {cap}"));
        }
    }

    // 6) Aplicar transacciones en orden. Se trabaja sobre una COPIA para que un
    //    fallo a mitad no deje el estado corrupto.
    let mut next = state.clone();
    for (i, tx) in block.txs.iter().enumerate() {
        apply_tx(&mut next, tx, expected_height, i, &ids[i])?;
    }
    next.height = expected_height;
    *state = next;
    Ok(())
}

fn require_nonce(state: &mut State, who: &AccountId, nonce: u64) -> Result<(), String> {
    let expected = state.nonce_of(who);
    if nonce != expected {
        return Err(format!("nonce {nonce} != esperado {expected} (anti-replay)"));
    }
    state.acct(who).nonce = expected + 1;
    Ok(())
}

fn spend(state: &mut State, who: &AccountId, amount: Amount, fee: Amount) -> Result<(), String> {
    let need = (amount as u128) + (fee as u128);
    let bal = state.balance_of(who) as u128;
    if bal < need {
        return Err(format!("saldo insuficiente: {bal} < {need}"));
    }
    let a = state.acct(who);
    a.balance -= (amount + fee) as u64;
    Ok(())
}

fn apply_tx(
    state: &mut State,
    tx: &Tx,
    height: u64,
    index: usize,
    this_txid: &TxId,
) -> Result<(), String> {
    match tx {
        Tx::Coinbase { to, reward, .. } => {
            if index != 0 {
                return Err("coinbase fuera del índice 0".into());
            }
            state.acct(to).balance += *reward;
            Ok(())
        }
        Tx::Transfer { from, to, amount, fee, nonce, .. } => {
            require_nonce(state, from, *nonce)?;
            spend(state, from, *amount, *fee)?;
            state.acct(to).balance += *amount;
            Ok(())
        }
        Tx::Stake { who, amount, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            spend(state, who, *amount, *fee)?;
            state.acct(who).staked += *amount;
            Ok(())
        }
        Tx::Unstake { who, amount, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            // la comisión sale del saldo; el importe vuelve de staked a balance
            spend(state, who, 0, *fee)?;
            let a = state.acct(who);
            if a.staked < *amount {
                return Err("unstake mayor que lo apostado".into());
            }
            a.staked -= *amount;
            a.balance += *amount;
            Ok(())
        }
        Tx::Commit { by, commitment, fee, nonce, .. } => {
            require_nonce(state, by, *nonce)?;
            spend(state, by, 0, *fee)?;
            // Registra el commit por su txid a la altura actual y su commitment.
            state.commits.insert(*this_txid, (*by, height));
            state.commit_commitment.insert(*this_txid, *commitment);
            Ok(())
        }
        Tx::Reveal { by, commit_txid, payload, secret, fee, nonce, .. } => {
            require_nonce(state, by, *nonce)?;
            spend(state, by, 0, *fee)?;
            let (committer, commit_height) = *state
                .commits
                .get(commit_txid)
                .ok_or("reveal de un commit inexistente")?;
            if committer != *by {
                return Err("el reveal no lo firma el committer original".into());
            }
            // ANTI-LOOK-AHEAD: el reveal va en un bloque ESTRICTAMENTE posterior.
            if height <= commit_height {
                return Err("reveal en el mismo bloque o anterior al commit".into());
            }
            if state.revealed.contains(commit_txid) {
                return Err("commit ya revelado".into());
            }
            // La señal revelada debe reproducir el commit almacenado.
            let payload_json: Value =
                serde_json::from_slice(payload).map_err(|_| "payload no es JSON".to_string())?;
            let recomputed = crate::tx::commit_hash(&payload_json, secret)?;
            // Buscar el commitment original guardado en la tx Commit: lo tenemos
            // implícito por txid; aquí solo comprobamos coherencia estructural del
            // hash recomputado contra el commitment registrado.
            let expected = state
                .commit_commitment
                .get(commit_txid)
                .ok_or("commitment original no encontrado")?;
            if &recomputed != expected {
                return Err("la señal revelada NO coincide con el commit".into());
            }
            state.revealed.insert(*commit_txid);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::{BlockHeader, ZERO_HASH};
    use crate::crypto::KeyPair;
    use crate::pow::GENESIS_BITS;
    use crate::tx::{signing_message, Tx};

    fn coinbase(height: u64, to: AccountId, reward: Amount) -> Tx {
        Tx::Coinbase { height, to, reward, memo: vec![] }
    }

    fn block_with(height: u64, prev: [u8; 32], txs: Vec<Tx>) -> Block {
        let ids: Vec<TxId> = txs.iter().map(txid).collect();
        let merkle_root = merkle_root_txids(&ids);
        Block {
            header: BlockHeader {
                version: 1, prev_hash: prev, height, timestamp: 1000 + height,
                merkle_root, bits: GENESIS_BITS, nonce: 0, branch_tag: *b"main",
            },
            txs,
        }
    }

    #[test]
    fn reward_halves_and_supply_is_finite() {
        assert_eq!(block_reward(0), 50 * COIN);
        assert_eq!(block_reward(HALVING_INTERVAL), 25 * COIN);
        assert_eq!(block_reward(2 * HALVING_INTERVAL), 12 * COIN + COIN / 2);
        // ~21 M RAMI
        let sup = max_supply();
        assert!(sup > 20_000_000u128 * COIN as u128 && sup < 21_000_001u128 * COIN as u128);
    }

    #[test]
    fn coinbase_over_cap_rejected() {
        let mut st = State::default();
        let to = [1u8; 32];
        let blk = block_with(0, ZERO_HASH, vec![coinbase(0, to, 50 * COIN + 1)]);
        assert!(apply_block(&mut st, &blk, 0).is_err());
    }

    #[test]
    fn transfer_and_nonce_replay() {
        let mut st = State::default();
        let miner = KeyPair::from_secret(&[2u8; 32]);
        let mid = miner.public_bytes();
        // bloque 0: coinbase paga al minero
        let b0 = block_with(0, ZERO_HASH, vec![coinbase(0, mid, 50 * COIN)]);
        apply_block(&mut st, &b0, 0).unwrap();
        assert_eq!(st.balance_of(&mid), 50 * COIN);

        // bloque 1: el minero transfiere 10 RAMI a bob (nonce 0)
        let bob = [7u8; 32];
        let mut tx = Tx::Transfer { from: mid, to: bob, amount: 10 * COIN, fee: 1, nonce: 0, sig: [0u8; 64] };
        let sig = miner.sign(&signing_message(&tx));
        if let Tx::Transfer { sig: s, .. } = &mut tx { *s = sig; }
        let b1 = block_with(1, b0.hash(), vec![coinbase(1, mid, block_reward(1)), tx.clone()]);
        apply_block(&mut st, &b1, 1).unwrap();
        assert_eq!(st.balance_of(&bob), 10 * COIN);
        assert_eq!(st.nonce_of(&mid), 1);

        // reusar la MISMA tx (nonce 0) en el bloque 2 -> rechazado (anti-doble-gasto)
        let b2 = block_with(2, b1.hash(), vec![coinbase(2, mid, block_reward(2)), tx]);
        assert!(apply_block(&mut st, &b2, 2).is_err());
    }
}
