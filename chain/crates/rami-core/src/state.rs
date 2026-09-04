//! Estado de cuentas y función de transición. Aquí viven las reglas económicas
//! y la consistencia de rama del observador:
//!   * nonce por cuenta estrictamente secuencial  => imposible el doble gasto,
//!   * cota de recompensa (emisión + comisiones)   => imposible inflar la emisión,
//!   * regla anti-look-ahead de commit/reveal       => el reveal va en un bloque
//!     ESTRICTAMENTE posterior al commit, mismo firmante, hash reproducido.
//!
//! La red neuronal y el desempate de Collatz NO intervienen aquí.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use serde_json::Value;

use crate::block::Block;
use crate::tx::{fee_of, merkle_root_txids, txid, verify_tx, AccountId, Amount, Tx, TxId};

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

/// Precio de una parcela libre de la ciudad (se QUEMA: sumidero anti-spam,
/// nadie lo cobra). 10 RAMI.
pub const PARCEL_PRICE: Amount = 10 * COIN;
/// Precio de acuñar un activo (se quema). 1 RAMI.
pub const MINT_PRICE: Amount = COIN;

/// Parcela de la ciudad RAMI: la "empresa" montada sobre ella.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Parcel {
    pub owner: AccountId,
    pub name: String,
    /// 0 empresa, 1 granja, 2 tienda, 3 oficina.
    pub kind: u8,
    pub since: u64,
    /// Nº de cosechas repartidas y la última (altura, total).
    pub harvests: u64,
    pub last_harvest: Option<(u64, Amount)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Lease {
    pub tenant: AccountId,
    pub from: u64,
    /// Última altura (inclusive) en la que el alquiler está vigente.
    pub until: u64,
    pub price: Amount,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Offer {
    pub price: Amount,
    pub term: u64,
}

/// Activo (NFT nativo) de la ciudad: una planta o un objeto en una parcela.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Asset {
    pub owner: AccountId,
    pub x: u16,
    pub y: u16,
    /// 0 planta (participa en cosechas), 1 objeto.
    pub kind: u8,
    pub meta: String,
    pub minted: u64,
    pub offer: Option<Offer>,
    pub lease: Option<Lease>,
}

impl Asset {
    /// ¿Hay un alquiler vigente a esta altura?
    pub fn leased_at(&self, height: u64) -> bool {
        self.lease.as_ref().map(|l| height <= l.until).unwrap_or(false)
    }
}

#[derive(Clone, Debug, Default)]
pub struct State {
    pub accounts: HashMap<AccountId, Account>,
    /// Ciudad RAMI: parcelas por coordenada y activos por id (= txid de acuñado).
    pub parcels: BTreeMap<(u16, u16), Parcel>,
    pub assets: BTreeMap<TxId, Asset>,
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
    let total_fees: u128 = block.txs.iter().map(|t| fee_of(t) as u128).sum();

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

/// Transición de estado de UNA transacción. Pública para que el mempool y el
/// constructor de bloques usen EXACTAMENTE las mismas reglas que la validación
/// de bloques (una tx que pase aquí nunca invalidará el bloque minado).
pub fn apply_tx(
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

        // ---------- Ciudad RAMI ----------
        Tx::ClaimParcel { who, x, y, name, kind, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            let name = String::from_utf8(name.clone()).map_err(|_| "nombre no UTF-8".to_string())?;
            match state.parcels.get(&(*x, *y)) {
                Some(p) if p.owner != *who => return Err("la parcela ya tiene dueño".into()),
                Some(_) => {
                    // Renombrar / cambiar el tipo de una parcela propia: solo comisión.
                    spend(state, who, 0, *fee)?;
                    let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
                    p.name = name;
                    p.kind = *kind;
                }
                None => {
                    // Parcela libre: el precio se QUEMA (nadie lo recibe).
                    spend(state, who, PARCEL_PRICE, *fee)?;
                    state.parcels.insert(
                        (*x, *y),
                        Parcel { owner: *who, name, kind: *kind, since: height, harvests: 0, last_harvest: None },
                    );
                }
            }
            Ok(())
        }
        Tx::MintAsset { who, x, y, kind, meta, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            match state.parcels.get(&(*x, *y)) {
                Some(p) if p.owner == *who => {}
                Some(_) => return Err("solo el dueño de la parcela puede acuñar en ella".into()),
                None => return Err("la parcela no tiene dueño".into()),
            }
            spend(state, who, MINT_PRICE, *fee)?; // precio quemado
            let meta = String::from_utf8(meta.clone()).map_err(|_| "meta no UTF-8".to_string())?;
            state.assets.insert(
                *this_txid,
                Asset { owner: *who, x: *x, y: *y, kind: *kind, meta, minted: height, offer: None, lease: None },
            );
            Ok(())
        }
        Tx::TransferAsset { from, asset, to, fee, nonce, .. } => {
            require_nonce(state, from, *nonce)?;
            spend(state, from, 0, *fee)?;
            let a = state.assets.get_mut(asset).ok_or("activo inexistente")?;
            if a.owner != *from {
                return Err("no eres el dueño del activo".into());
            }
            if a.leased_at(height) {
                return Err("el activo está alquilado; espera a que venza".into());
            }
            a.owner = *to;
            a.offer = None;
            Ok(())
        }
        Tx::ListLease { who, asset, price, term, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            spend(state, who, 0, *fee)?;
            let a = state.assets.get_mut(asset).ok_or("activo inexistente")?;
            if a.owner != *who {
                return Err("no eres el dueño del activo".into());
            }
            if a.leased_at(height) {
                return Err("el activo ya está alquilado".into());
            }
            a.offer = Some(Offer { price: *price, term: *term });
            Ok(())
        }
        Tx::Rent { who, asset, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            let (owner, price, term) = {
                let a = state.assets.get(asset).ok_or("activo inexistente")?;
                let o = a.offer.as_ref().ok_or("el activo no está en alquiler")?;
                if a.owner == *who {
                    return Err("no puedes alquilarte tu propio activo".into());
                }
                if a.leased_at(height) {
                    return Err("el activo ya está alquilado".into());
                }
                (a.owner, o.price, o.term)
            };
            // El arrendatario paga el precio al dueño (más la comisión al minero).
            spend(state, who, price, *fee)?;
            state.acct(&owner).balance += price;
            let a = state.assets.get_mut(asset).expect("existe");
            a.lease = Some(Lease { tenant: *who, from: height, until: height + term, price });
            a.offer = None;
            Ok(())
        }
        Tx::Harvest { who, x, y, total, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            match state.parcels.get(&(*x, *y)) {
                Some(p) if p.owner == *who => {}
                Some(_) => return Err("solo el dueño de la parcela puede repartir cosecha".into()),
                None => return Err("la parcela no tiene dueño".into()),
            }
            // Arrendatarios ACTIVOS de las plantas de la parcela (orden determinista).
            let tenants: Vec<AccountId> = state
                .assets
                .values()
                .filter(|a| a.x == *x && a.y == *y && a.kind == 0 && a.leased_at(height))
                .map(|a| a.lease.as_ref().expect("vigente").tenant)
                .collect();
            if tenants.is_empty() {
                return Err("no hay plantas alquiladas en esta parcela: nada que repartir".into());
            }
            // El total sale del saldo del dueño; el resto de la división se queda con él.
            let share = *total / tenants.len() as u64;
            if share == 0 {
                return Err("cosecha demasiado pequeña para repartir".into());
            }
            let distributed = share * tenants.len() as u64;
            spend(state, who, distributed, *fee)?;
            for t in &tenants {
                state.acct(t).balance += share;
            }
            let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
            p.harvests += 1;
            p.last_harvest = Some((height, distributed));
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

    /// Firma cualquier tx con firma poniendo su campo `sig`; deja la coinbase intacta.
    fn signed(kp: &KeyPair, mut tx: Tx) -> Tx {
        let sig = kp.sign(&signing_message(&tx));
        match &mut tx {
            Tx::Transfer { sig: s, .. }
            | Tx::Stake { sig: s, .. }
            | Tx::Unstake { sig: s, .. }
            | Tx::Commit { sig: s, .. }
            | Tx::Reveal { sig: s, .. }
            | Tx::ClaimParcel { sig: s, .. }
            | Tx::MintAsset { sig: s, .. }
            | Tx::TransferAsset { sig: s, .. }
            | Tx::ListLease { sig: s, .. }
            | Tx::Rent { sig: s, .. }
            | Tx::Harvest { sig: s, .. } => *s = sig,
            Tx::Coinbase { .. } => {}
        }
        tx
    }

    /// Ciudad: reclamar parcela → acuñar planta → publicar alquiler → alquilar →
    /// cosecha repartida al arrendatario; y las reglas que lo protegen.
    #[test]
    fn city_claim_mint_rent_harvest() {
        let mut st = State::default();
        let farmer = KeyPair::from_secret(&[11u8; 32]);
        let renter = KeyPair::from_secret(&[12u8; 32]);
        let (f, r) = (farmer.public_bytes(), renter.public_bytes());
        // bloque 0/1: fondos para ambos
        let b0 = block_with(0, ZERO_HASH, vec![coinbase(0, f, 50 * COIN)]);
        apply_block(&mut st, &b0, 0).unwrap();
        let b1 = block_with(1, b0.hash(), vec![coinbase(1, r, block_reward(1))]);
        apply_block(&mut st, &b1, 1).unwrap();

        // bloque 2: el granjero reclama (5,7) como granja y acuña una planta
        let claim = signed(&farmer, Tx::ClaimParcel { who: f, x: 5, y: 7, name: b"Granja demo".to_vec(), kind: 1, fee: 1, nonce: 0, sig: [0u8; 64] });
        let mint = signed(&farmer, Tx::MintAsset { who: f, x: 5, y: 7, kind: 0, meta: b"planta #1".to_vec(), fee: 1, nonce: 1, sig: [0u8; 64] });
        let plant = txid(&mint);
        let b2 = block_with(2, b1.hash(), vec![coinbase(2, f, block_reward(2)), claim, mint]);
        apply_block(&mut st, &b2, 2).unwrap();
        assert_eq!(st.parcels[&(5, 7)].owner, f);
        // precio de parcela y de acuñado QUEMADOS (no van a nadie)
        assert_eq!(st.balance_of(&f), 50 * COIN + block_reward(2) - PARCEL_PRICE - MINT_PRICE - 2);

        // otro NO puede reclamar una parcela con dueño ni acuñar en ella
        let steal = signed(&renter, Tx::ClaimParcel { who: r, x: 5, y: 7, name: b"mia".to_vec(), kind: 0, fee: 1, nonce: 0, sig: [0u8; 64] });
        let bad = block_with(3, b2.hash(), vec![coinbase(3, f, block_reward(3)), steal]);
        assert!(apply_block(&mut st.clone(), &bad, 3).is_err());

        // bloque 3: publicar alquiler (2 RAMI por 100 bloques) y alquilar
        let list = signed(&farmer, Tx::ListLease { who: f, asset: plant, price: 2 * COIN, term: 100, fee: 1, nonce: 2, sig: [0u8; 64] });
        let rent = signed(&renter, Tx::Rent { who: r, asset: plant, fee: 1, nonce: 0, sig: [0u8; 64] });
        let b3 = block_with(3, b2.hash(), vec![coinbase(3, f, block_reward(3)), list, rent]);
        let before_f = st.balance_of(&f);
        apply_block(&mut st, &b3, 3).unwrap();
        let a = &st.assets[&plant];
        assert!(a.leased_at(3) && a.leased_at(103) && !a.leased_at(104));
        assert_eq!(a.lease.as_ref().unwrap().tenant, r);
        assert_eq!(st.balance_of(&f), before_f + block_reward(3) + 2 * COIN - 1); // cobró el alquiler (menos su comisión de publicar)

        // alquilado: no se puede transferir
        let xfer = signed(&farmer, Tx::TransferAsset { from: f, asset: plant, to: r, fee: 1, nonce: 3, sig: [0u8; 64] });
        let bad = block_with(4, b3.hash(), vec![coinbase(4, f, block_reward(4)), xfer]);
        assert!(apply_block(&mut st.clone(), &bad, 4).is_err());

        // bloque 4: cosecha de 9 RAMI → va íntegra al único arrendatario, del saldo del granjero
        let harvest = signed(&farmer, Tx::Harvest { who: f, x: 5, y: 7, total: 9 * COIN, fee: 1, nonce: 3, sig: [0u8; 64] });
        let b4 = block_with(4, b3.hash(), vec![coinbase(4, f, block_reward(4)), harvest]);
        let (bf, br) = (st.balance_of(&f), st.balance_of(&r));
        apply_block(&mut st, &b4, 4).unwrap();
        assert_eq!(st.balance_of(&r), br + 9 * COIN);
        assert_eq!(st.balance_of(&f), bf + block_reward(4) - 9 * COIN - 1);
        assert_eq!(st.parcels[&(5, 7)].harvests, 1);

        // bloque 200: el alquiler venció → cosecha sin arrendatarios se rechaza
        let mut later = st.clone();
        later.height = 199;
        let harvest2 = signed(&farmer, Tx::Harvest { who: f, x: 5, y: 7, total: COIN, fee: 1, nonce: 4, sig: [0u8; 64] });
        let b200 = block_with(200, b4.hash(), vec![coinbase(200, f, block_reward(200)), harvest2]);
        assert!(apply_block(&mut later, &b200, 200).is_err());
    }

    // Un Reveal colocado en el MISMO bloque que su Commit viola la regla
    // anti-look-ahead: no puedes «revelar» una predicción en el mismo instante en
    // que la anclas. Debe rechazarse aunque el commitment sea correcto.
    #[test]
    fn reveal_in_commit_block_rejected() {
        let mut st = State::default();
        let signer = KeyPair::from_secret(&[9u8; 32]);
        let who = signer.public_bytes();

        // bloque 0: el firmante recibe fondos para pagar comisiones
        let b0 = block_with(0, ZERO_HASH, vec![coinbase(0, who, 50 * COIN)]);
        apply_block(&mut st, &b0, 0).unwrap();

        // commitment VÁLIDO sobre una señal concreta
        let payload = serde_json::json!({"pair": "BTC", "dir": "LONG"});
        let secret = b"semilla-anti-look-ahead".to_vec();
        let commitment = crate::tx::commit_hash(&payload, &secret).unwrap();

        let commit = signed(&signer, Tx::Commit { by: who, commitment, fee: 1, nonce: 0, sig: [0u8; 64] });
        let commit_id = txid(&commit);
        let reveal = signed(&signer, Tx::Reveal {
            by: who,
            commit_txid: commit_id,
            payload: serde_json::to_vec(&payload).unwrap(),
            secret: secret.clone(),
            fee: 1,
            nonce: 1,
            sig: [0u8; 64],
        });

        // bloque 1: commit y reveal en el MISMO bloque -> rechazado por anti-look-ahead
        let b1 = block_with(1, b0.hash(), vec![coinbase(1, who, block_reward(1)), commit, reveal]);
        let err = apply_block(&mut st, &b1, 1).unwrap_err();
        assert!(err.contains("mismo bloque o anterior"), "motivo inesperado: {err}");
        // y el commit NO queda marcado como revelado
        assert!(st.revealed.is_empty());
    }

    // El mismo commit, revelado en un bloque ESTRICTAMENTE posterior, sí se acepta:
    // demuestra que el rechazo anterior es por la regla temporal, no por el hash.
    #[test]
    fn reveal_in_later_block_accepted() {
        let mut st = State::default();
        let signer = KeyPair::from_secret(&[9u8; 32]);
        let who = signer.public_bytes();

        let b0 = block_with(0, ZERO_HASH, vec![coinbase(0, who, 50 * COIN)]);
        apply_block(&mut st, &b0, 0).unwrap();

        let payload = serde_json::json!({"pair": "BTC", "dir": "LONG"});
        let secret = b"semilla-anti-look-ahead".to_vec();
        let commitment = crate::tx::commit_hash(&payload, &secret).unwrap();

        let commit = signed(&signer, Tx::Commit { by: who, commitment, fee: 1, nonce: 0, sig: [0u8; 64] });
        let commit_id = txid(&commit);

        // bloque 1: solo el commit
        let b1 = block_with(1, b0.hash(), vec![coinbase(1, who, block_reward(1)), commit]);
        apply_block(&mut st, &b1, 1).unwrap();

        // bloque 2: el reveal, en un bloque estrictamente posterior -> aceptado
        let reveal = signed(&signer, Tx::Reveal {
            by: who,
            commit_txid: commit_id,
            payload: serde_json::to_vec(&payload).unwrap(),
            secret,
            fee: 1,
            nonce: 1,
            sig: [0u8; 64],
        });
        let b2 = block_with(2, b1.hash(), vec![coinbase(2, who, block_reward(2)), reveal]);
        apply_block(&mut st, &b2, 2).unwrap();
        assert!(st.revealed.contains(&commit_id));
    }
}
