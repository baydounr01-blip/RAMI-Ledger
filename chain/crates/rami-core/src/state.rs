//! Estado de cuentas y función de transición. Aquí viven las reglas económicas
//! y la consistencia de rama del observador:
//!   * nonce por cuenta estrictamente secuencial  => imposible el doble gasto,
//!   * cota de recompensa (emisión + comisiones)   => imposible inflar la emisión,
//!   * regla anti-look-ahead de commit/reveal       => el reveal va en un bloque
//!     ESTRICTAMENTE posterior al commit, mismo firmante, hash reproducido.
//!
//! La red neuronal y el desempate de Collatz NO intervienen aquí.

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde::Serialize;
use serde_json::Value;

use crate::block::Block;
use crate::ciudad::{self, Trade};
use crate::tx::{fee_of, merkle_root_txids, txid, verify_tx_con, AccountId, Amount, FirmaCtx, Tx, TxId};

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

/// Precio de una parcela libre de la ciudad HASTA Dubái (se QUEMA: sumidero
/// anti-spam, nadie lo cobra). 10 RAMI. Desde Dubái el precio depende del
/// distrito (`ciudad::precio_parcela`) y sigue quemándose.
pub const PARCEL_PRICE: Amount = 10 * COIN;
/// Precio de acuñar un activo hasta Dubái (se quema). 1 RAMI. Desde Dubái,
/// por tipo (`ciudad::precio_acunado`).
pub const MINT_PRICE: Amount = COIN;

/// Parcela de la ciudad RAMI: la "empresa" montada sobre ella.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Parcel {
    pub owner: AccountId,
    pub name: String,
    /// Sector: 0 empresa, 1 granja, 2 tienda, 3 oficina; desde Dubái, uno de
    /// los 30 de `ciudad::SECTORES`.
    pub kind: u8,
    pub since: u64,
    /// Nº de cosechas repartidas y la última (altura, total).
    pub harvests: u64,
    pub last_harvest: Option<(u64, Amount)>,
    /// Dubái: precio de venta publicado (RAMI), si está en venta.
    pub sale: Option<Amount>,
    /// Dubái: RAMI netos cobrados del fondo de la ciudad (acumulado).
    pub ingresos: Amount,
    /// Dubái: ingreso neto del último bloque con reparto y su altura.
    pub ultimo_ingreso: Amount,
    pub ultimo_bloque: u64,
    /// Dubái: pagado a proveedores de la ciudad, importado (quemado) y
    /// cobrado como proveedor de otras empresas (acumulados).
    pub insumos_pagados: Amount,
    pub importado: Amount,
    pub ventas: Amount,
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
    /// 0 planta (participa en cosechas), 1 objeto; desde Dubái 2 vehículo, 3 local.
    pub kind: u8,
    pub meta: String,
    pub minted: u64,
    pub offer: Option<Offer>,
    pub lease: Option<Lease>,
    /// Dubái: precio de venta publicado (RAMI), si está en venta.
    pub sale: Option<Amount>,
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
    /// Dubái: fondo de la ciudad (parte de la emisión aún no repartida).
    pub city_fund: Amount,
    /// RAMI quemados (precios de parcela y acuñado, importaciones de Dubái).
    pub quemado: Amount,
    /// Dubái: últimas operaciones del mercado (cotización), acotadas.
    pub trades: VecDeque<Trade>,
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

/// Aplica un bloque bajo la regla de firma v1 (la de v0.7.x). Sólo para
/// pruebas: el árbol de bloques usa `apply_block_con` con la regla que rige
/// según el timestamp del bloque.
#[cfg(test)]
pub fn apply_block(state: &mut State, block: &Block, expected_height: u64) -> Result<(), String> {
    apply_block_con(state, block, expected_height, &FirmaCtx::v1())
}

/// Aplica un bloque al estado (que debe ser el estado tras el bloque padre).
/// Devuelve `Ok(())` y muta `state`, o `Err` con el motivo (bloque inválido).
/// `firma` fija la regla con la que se verifican las firmas de las tx del
/// bloque (v1 o v2 ligada a la red); la decide el árbol por el timestamp.
pub fn apply_block_con(state: &mut State, block: &Block, expected_height: u64, firma: &FirmaCtx) -> Result<(), String> {
    if block.header.height != expected_height {
        return Err(format!(
            "altura {} != esperada {}",
            block.header.height, expected_height
        ));
    }

    // 0) Cotas del bloque (anti-DoS): número de tx y bytes. Se comprueban
    //    ANTES de hashear o verificar firmas, que es lo caro.
    if block.txs.len() > crate::tx::MAX_BLOCK_TXS {
        return Err(format!("bloque con {} tx > máximo {}", block.txs.len(), crate::tx::MAX_BLOCK_TXS));
    }
    let bytes: usize = block.txs.iter().map(crate::tx::tx_size).sum();
    if bytes > crate::tx::MAX_BLOCK_BYTES {
        return Err(format!("bloque de {bytes} bytes > máximo {}", crate::tx::MAX_BLOCK_BYTES));
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
        verify_tx_con(tx, firma)?;
    }

    // 4) Suma de comisiones de las tx no-coinbase (para acotar la recompensa).
    let total_fees: u128 = block.txs.iter().map(|t| fee_of(t) as u128).sum();

    // 5) Cota de la recompensa coinbase = emisión(altura) + comisiones. Desde
    //    Dubái, una parte de la emisión (`ciudad::parte_ciudad`) no es del
    //    minero: entra en el fondo de la ciudad. Las comisiones siguen enteras.
    //    El bloque 0 queda fuera: el génesis de la testnet es fijo y anterior a
    //    la activación, y en regtest su coinbase debe valer con o sin Dubái.
    let emision = block_reward(expected_height);
    let parte_ciudad = if firma.dubai && expected_height > 0 { ciudad::parte_ciudad(emision) } else { 0 };
    if let Some(Tx::Coinbase { height, reward, .. }) = block.txs.first() {
        if *height != expected_height {
            return Err("altura de la coinbase incorrecta".into());
        }
        let cap = (emision - parte_ciudad) as u128 + total_fees;
        if *reward as u128 > cap {
            return Err(format!("recompensa coinbase {reward} > cota {cap}"));
        }
    }

    // 6) Aplicar transacciones en orden. Se trabaja sobre una COPIA para que un
    //    fallo a mitad no deje el estado corrupto.
    let mut next = state.clone();
    for (i, tx) in block.txs.iter().enumerate() {
        apply_tx(&mut next, tx, expected_height, i, &ids[i], firma.dubai)?;
    }
    // 7) Dubái: la parte de la ciudad entra en el fondo y el fondo se reparte
    //    entre las empresas (regla determinista: `ciudad::tick`).
    if firma.dubai {
        next.city_fund += parte_ciudad;
        ciudad::tick(&mut next, expected_height);
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
/// `dubai`: rigen las reglas de Dubái (precios por distrito, mercado, tipos
/// nuevos); lo decide el contexto del bloque (`FirmaCtx.dubai`).
pub fn apply_tx(
    state: &mut State,
    tx: &Tx,
    height: u64,
    index: usize,
    this_txid: &TxId,
    dubai: bool,
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
                    // Parcela libre: el precio se QUEMA (nadie lo recibe). Desde
                    // Dubái depende del distrito; antes, fijo.
                    let precio = if dubai { ciudad::precio_parcela(*x, *y) } else { PARCEL_PRICE };
                    spend(state, who, precio, *fee)?;
                    state.quemado += precio;
                    state.parcels.insert((*x, *y), ciudad::nueva_parcela(*who, name, *kind, height));
                }
            }
            Ok(())
        }
        Tx::MintAsset { who, x, y, kind, meta, fee, nonce, .. } => {
            require_nonce(state, who, *nonce)?;
            match state.parcels.get(&(*x, *y)) {
                Some(p) if p.owner == *who => {
                    // Dubái: los vehículos solo los acuña un concesionario.
                    if dubai && *kind == 2 && p.kind != ciudad::SECTOR_CONCESIONARIO {
                        return Err("solo un concesionario puede acuñar vehículos".into());
                    }
                }
                Some(_) => return Err("solo el dueño de la parcela puede acuñar en ella".into()),
                None => return Err("la parcela no tiene dueño".into()),
            }
            let precio = if dubai { ciudad::precio_acunado(*kind) } else { MINT_PRICE };
            spend(state, who, precio, *fee)?; // precio quemado
            state.quemado += precio;
            let meta = String::from_utf8(meta.clone()).map_err(|_| "meta no UTF-8".to_string())?;
            state.assets.insert(
                *this_txid,
                Asset { owner: *who, x: *x, y: *y, kind: *kind, meta, minted: height, offer: None, lease: None, sale: None },
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
            a.sale = None;
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

        // ---------- Dubái RAMI: mercado ----------
        Tx::SellAsset { who, asset, price, fee, nonce, .. } => {
            if !dubai {
                return Err("las reglas de Dubái no rigen todavía".into());
            }
            require_nonce(state, who, *nonce)?;
            spend(state, who, 0, *fee)?;
            let a = state.assets.get_mut(asset).ok_or("activo inexistente")?;
            if a.owner != *who {
                return Err("no eres el dueño del activo".into());
            }
            if *price > 0 && a.leased_at(height) {
                return Err("el activo está alquilado; espera a que venza".into());
            }
            a.sale = if *price == 0 { None } else { Some(*price) };
            Ok(())
        }
        Tx::BuyAsset { who, asset, max_price, fee, nonce, .. } => {
            if !dubai {
                return Err("las reglas de Dubái no rigen todavía".into());
            }
            require_nonce(state, who, *nonce)?;
            let (owner, price, x, y, kind) = {
                let a = state.assets.get(asset).ok_or("activo inexistente")?;
                let price = a.sale.ok_or("el activo no está en venta")?;
                if a.owner == *who {
                    return Err("ya es tuyo".into());
                }
                if a.leased_at(height) {
                    return Err("el activo está alquilado; espera a que venza".into());
                }
                if price > *max_price {
                    return Err(format!("el precio ({price}) supera tu máximo ({max_price})"));
                }
                (a.owner, price, a.x, a.y, a.kind)
            };
            // Pago y cambio de manos en la misma transacción (atómico).
            spend(state, who, price, *fee)?;
            state.acct(&owner).balance += price;
            let a = state.assets.get_mut(asset).expect("existe");
            a.owner = *who;
            a.sale = None;
            a.offer = None;
            ciudad::apuntar_trade(
                &mut state.trades,
                Trade { height, kind: 1, x, y, sector: kind, distrito: ciudad::distrito(x, y).id, price },
            );
            Ok(())
        }
        Tx::SellParcel { who, x, y, price, fee, nonce, .. } => {
            if !dubai {
                return Err("las reglas de Dubái no rigen todavía".into());
            }
            require_nonce(state, who, *nonce)?;
            spend(state, who, 0, *fee)?;
            let p = state.parcels.get_mut(&(*x, *y)).ok_or("la parcela no tiene dueño")?;
            if p.owner != *who {
                return Err("no eres el dueño de la parcela".into());
            }
            p.sale = if *price == 0 { None } else { Some(*price) };
            Ok(())
        }
        Tx::BuyParcel { who, x, y, max_price, fee, nonce, .. } => {
            if !dubai {
                return Err("las reglas de Dubái no rigen todavía".into());
            }
            require_nonce(state, who, *nonce)?;
            let (owner, price, sector) = {
                let p = state.parcels.get(&(*x, *y)).ok_or("la parcela no tiene dueño")?;
                let price = p.sale.ok_or("la parcela no está en venta")?;
                if p.owner == *who {
                    return Err("ya es tuya".into());
                }
                if price > *max_price {
                    return Err(format!("el precio ({price}) supera tu máximo ({max_price})"));
                }
                (p.owner, price, p.kind)
            };
            spend(state, who, price, *fee)?;
            state.acct(&owner).balance += price;
            let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
            p.owner = *who;
            p.sale = None;
            p.since = height;
            ciudad::apuntar_trade(
                &mut state.trades,
                Trade { height, kind: 0, x: *x, y: *y, sector, distrito: ciudad::distrito(*x, *y).id, price },
            );
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
            | Tx::Harvest { sig: s, .. }
            | Tx::SellAsset { sig: s, .. }
            | Tx::BuyAsset { sig: s, .. }
            | Tx::SellParcel { sig: s, .. }
            | Tx::BuyParcel { sig: s, .. } => *s = sig,
            Tx::Coinbase { .. } => {}
        }
        tx
    }

    /// Firma bajo un contexto dado (Dubái usa el mismo mensaje que la v2).
    fn signed_con(kp: &KeyPair, ctx: &FirmaCtx, mut tx: Tx) -> Tx {
        let sig = kp.sign(&ctx.mensaje(&tx));
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
            | Tx::Harvest { sig: s, .. }
            | Tx::SellAsset { sig: s, .. }
            | Tx::BuyAsset { sig: s, .. }
            | Tx::SellParcel { sig: s, .. }
            | Tx::BuyParcel { sig: s, .. } => *s = sig,
            Tx::Coinbase { .. } => {}
        }
        tx
    }

    /// Dubái de punta a punta: la coinbase deja el 20 % al fondo, la parcela
    /// cuesta lo que dice su distrito (y se quema), el fondo se reparte a las
    /// empresas cada bloque, una parcela y un activo se compran y venden en la
    /// misma transacción, y nada de esto vale antes de la activación.
    #[test]
    fn dubai_fondo_reparto_y_mercado() {
        let net = [7u8; 32];
        let con = FirmaCtx::v2(net).con_dubai(true);
        let sin = FirmaCtx::v2(net);
        let a = KeyPair::from_secret(&[31u8; 32]);
        let b = KeyPair::from_secret(&[32u8; 32]);
        let (pa, pb) = (a.public_bytes(), b.public_bytes());
        let mut st = State::default();
        // Bloque 0 (génesis de prueba): regla sin Dubái, coinbase entera.
        let b0 = block_with(0, ZERO_HASH, vec![coinbase(0, pa, 50 * COIN)]);
        apply_block_con(&mut st, &b0, 0, &sin).unwrap();
        // Bloque 1 con Dubái: la coinbase solo puede cobrar 40 + comisiones.
        let mal = block_with(1, b0.hash(), vec![coinbase(1, pa, 50 * COIN)]);
        let err = apply_block_con(&mut st.clone(), &mal, 1, &con).unwrap_err();
        assert!(err.contains("cota"), "motivo: {err}");
        let b1 = block_with(1, b0.hash(), vec![coinbase(1, pa, 40 * COIN)]);
        apply_block_con(&mut st, &b1, 1, &con).unwrap();
        assert_eq!(st.city_fund, 10 * COIN, "el 20 % de la emisión entra en el fondo (sin empresas no se reparte)");
        assert_eq!(st.balance_of(&pa), 90 * COIN);
        // Y el mismo bloque bajo la regla sin Dubái también vale (cobra menos de la cota).
        let mut viejo = State::default();
        apply_block_con(&mut viejo, &b0, 0, &sin).unwrap();
        apply_block_con(&mut viejo, &b1, 1, &sin).unwrap();
        assert_eq!(viejo.city_fund, 0);

        // Bloque 2: A monta un hotel en Palm (300 RAMI) — no tiene tanto: falla.
        let hotel_caro = signed_con(&a, &con, Tx::ClaimParcel { who: pa, x: 21, y: 8, name: b"Hotel Palm".to_vec(), kind: 5, fee: 1, nonce: 0, sig: [0u8; 64] });
        let b2mal = block_with(2, b1.hash(), vec![coinbase(2, pa, 40 * COIN), hotel_caro]);
        assert!(apply_block_con(&mut st.clone(), &b2mal, 2, &con).is_err());
        // Un supermercado en International City (20 RAMI) sí; B recibe fondos.
        let super_ = signed_con(&a, &con, Tx::ClaimParcel { who: pa, x: 57, y: 36, name: b"Super".to_vec(), kind: 22, fee: 1, nonce: 0, sig: [0u8; 64] });
        let pago_b = signed_con(&a, &con, Tx::Transfer { from: pa, to: pb, amount: 60 * COIN, fee: 1, nonce: 1, sig: [0u8; 64] });
        let b2 = block_with(2, b1.hash(), vec![coinbase(2, pa, 40 * COIN + 2), super_, pago_b]);
        let fondo_antes = st.city_fund;
        apply_block_con(&mut st, &b2, 2, &con).unwrap();
        let p = &st.parcels[&(57, 36)];
        assert_eq!(p.kind, 22);
        // El fondo (10 + 10 RAMI) reparte el 1 % a la única empresa: importa
        // sus 3 insumos (40 % quemado) y cobra el neto.
        assert!(p.ultimo_ingreso > 0 && p.ultimo_bloque == 2);
        assert!(p.importado > 0 && p.insumos_pagados == 0);
        assert!(st.city_fund < fondo_antes + 10 * COIN);
        assert_eq!(st.quemado, 20 * COIN + p.importado);
        // Antes de la activación, ese mismo bloque es inválido (sector 22 > 3 y
        // parcela fuera de 32×32): los nodos sin Dubái no lo admiten.
        assert!(apply_block_con(&mut viejo.clone(), &b2, 2, &sin).is_err());

        // Bloque 3: A pone la parcela en venta por 25 RAMI y B la compra; el pago
        // y el cambio de dueño van en la misma transacción.
        let venta = signed_con(&a, &con, Tx::SellParcel { who: pa, x: 57, y: 36, price: 25 * COIN, fee: 1, nonce: 2, sig: [0u8; 64] });
        let compra = signed_con(&b, &con, Tx::BuyParcel { who: pb, x: 57, y: 36, max_price: 25 * COIN, fee: 1, nonce: 0, sig: [0u8; 64] });
        let (sa, sb) = (st.balance_of(&pa), st.balance_of(&pb));
        let b3 = block_with(3, b2.hash(), vec![coinbase(3, pa, 40 * COIN + 2), venta, compra]);
        apply_block_con(&mut st, &b3, 3, &con).unwrap();
        let p = &st.parcels[&(57, 36)];
        assert_eq!(p.owner, pb);
        assert_eq!(p.sale, None);
        assert_eq!(p.since, 3);
        assert_eq!(st.trades.len(), 1);
        assert_eq!(st.trades[0].price, 25 * COIN);
        assert_eq!(st.trades[0].kind, 0);
        // A cobró 25 (menos su comisión de vender) más la coinbase; B pagó 25 + comisión
        // y cobró el reparto del bloque como nueva dueña.
        assert_eq!(st.balance_of(&pa), sa + 40 * COIN + 2 + 25 * COIN - 1);
        assert!(st.balance_of(&pb) >= sb - 25 * COIN - 1);
        // Comprar con un máximo por debajo del precio falla; comprar lo no puesto en venta, también.
        let barato = signed_con(&a, &con, Tx::BuyParcel { who: pa, x: 57, y: 36, max_price: 1, fee: 1, nonce: 3, sig: [0u8; 64] });
        let b4mal = block_with(4, b3.hash(), vec![coinbase(4, pa, 40 * COIN), barato]);
        assert!(apply_block_con(&mut st.clone(), &b4mal, 4, &con).is_err());

        // Bloque 4: B (dueña) acuña un local (20 RAMI, quemado) y lo vende a A por 3 RAMI.
        let local = signed_con(&b, &con, Tx::MintAsset { who: pb, x: 57, y: 36, kind: 3, meta: b"Local 1".to_vec(), fee: 1, nonce: 1, sig: [0u8; 64] });
        let local_id = txid(&local);
        let venta_local = signed_con(&b, &con, Tx::SellAsset { who: pb, asset: local_id, price: 3 * COIN, fee: 1, nonce: 2, sig: [0u8; 64] });
        let compra_local = signed_con(&a, &con, Tx::BuyAsset { who: pa, asset: local_id, max_price: 3 * COIN, fee: 1, nonce: 3, sig: [0u8; 64] });
        // Un vehículo NO se puede acuñar aquí (no es un concesionario).
        let coche = signed_con(&b, &con, Tx::MintAsset { who: pb, x: 57, y: 36, kind: 2, meta: b"Coche".to_vec(), fee: 1, nonce: 3, sig: [0u8; 64] });
        let b4mal2 = block_with(4, b3.hash(), vec![coinbase(4, pa, 40 * COIN), local.clone(), venta_local.clone(), coche]);
        let err = apply_block_con(&mut st.clone(), &b4mal2, 4, &con).unwrap_err();
        assert!(err.contains("concesionario"), "motivo: {err}");
        let quemado_antes = st.quemado;
        let b4 = block_with(4, b3.hash(), vec![coinbase(4, pa, 40 * COIN + 3), local, venta_local, compra_local]);
        apply_block_con(&mut st, &b4, 4, &con).unwrap();
        let asset = &st.assets[&local_id];
        assert_eq!(asset.owner, pa);
        assert_eq!(asset.kind, 3);
        assert_eq!(asset.sale, None);
        assert!(st.quemado >= quemado_antes + 20 * COIN);
        assert_eq!(st.trades.len(), 2);
        assert_eq!(st.trades[1].kind, 1);
        assert_eq!(st.trades[1].price, 3 * COIN);
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
