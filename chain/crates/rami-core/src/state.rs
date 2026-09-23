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
use crate::tx::{fee_of, merkle_root_txids, txid, verify_tx_con, AccountId, Amount, FirmaCtx, Tx, TxId, MAX_UNIDADES_POR_CUENTA, MAX_UNIDADES_POR_PARCELA};

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
    /// Escritura de vivienda (v0.11.0): en cuántas viviendas se dividió la
    /// parcela (0 = sin dividir; una sola vez, de 1 a
    /// `MAX_UNIDADES_POR_PARCELA`) y su registro: `units[n - 1]` es la
    /// vivienda `n`. Siempre `units.len() == unidades`.
    pub unidades: u16,
    pub units: Vec<Unidad>,
}

/// Una vivienda de una parcela dividida (v0.11.0): de quién es y si está en
/// venta. No cobra nada del fondo de la ciudad (eso sigue siendo de la
/// empresa, el dueño de la parcela): es la escritura del piso, no una parte
/// del negocio.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Unidad {
    pub owner: AccountId,
    /// Precio de venta publicado (RAMI), si está en venta.
    pub sale: Option<Amount>,
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

/// Perfil del jugador (v0.10.0): lo que la cadena sabe de una cuenta que
/// quiere tener cara en la ciudad. Todo lo demás (empresas, activos,
/// operaciones) se deriva del estado; nada se duplica aquí.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Profile {
    /// Nombre único (`a-z`, `0-9`, `_`), el que se ve en la ciudad.
    pub handle: String,
    pub display: String,
    pub bio: String,
    pub avatar: u8,
    pub color: u8,
    /// Identidad del nodo con la que este jugador se pasea por la ciudad
    /// (firma de presencia y chat), si la vinculó. Verificada por consenso.
    pub node_pk: Option<AccountId>,
    /// Altura del primer perfil y de la última actualización.
    pub since: u64,
    pub updated: u64,
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
    /// v0.10.0: perfiles por cuenta, nombres únicos → cuenta y vínculos
    /// identidad-del-nodo → cuenta (un nodo, una cuenta).
    pub profiles: BTreeMap<AccountId, Profile>,
    pub handles: BTreeMap<String, AccountId>,
    pub nodes: BTreeMap<AccountId, AccountId>,
    /// v0.11.0: viviendas que cada cuenta tiene en parcelas de OTROS (las de
    /// una parcela propia no cuentan), para el tope `MAX_UNIDADES_POR_CUENTA`.
    /// Solo aparecen las cuentas con al menos una. Se mantiene en cada
    /// transacción que mueve una vivienda o una parcela dividida; se puede
    /// recontar desde las parcelas (`viviendas_ajenas_recontadas`).
    pub viviendas_ajenas: BTreeMap<AccountId, u16>,
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
    /// Viviendas de `id` en parcelas de otros (el contador del tope).
    pub fn viviendas_ajenas_de(&self, id: &AccountId) -> u16 {
        self.viviendas_ajenas.get(id).copied().unwrap_or(0)
    }
}

/// Recuento desde cero de las viviendas de cada cuenta en parcelas de otros.
/// Es la definición del contador `State.viviendas_ajenas`: las pruebas lo
/// comparan con él tras cada bloque (que el contador incremental nunca se
/// separe de la definición es lo que hace creíble el tope).
pub fn viviendas_ajenas_recontadas(state: &State) -> BTreeMap<AccountId, u16> {
    let mut out: BTreeMap<AccountId, u16> = BTreeMap::new();
    for p in state.parcels.values() {
        for u in &p.units {
            if u.owner != p.owner {
                let c = out.entry(u.owner).or_insert(0);
                *c = c.saturating_add(1);
            }
        }
    }
    out
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
        apply_tx(&mut next, tx, expected_height, i, &ids[i], firma)?;
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

// ---------- Escritura de vivienda (v0.11.0): ayudantes ----------
//
// Las cuatro transacciones de vivienda COMPRUEBAN todo antes de tocar el
// estado (nonce, saldo, reglas, topes) y solo entonces lo mutan: si fallan, no
// dejan nada a medias. Importa fuera del bloque: el mempool y el candidato del
// minero las prueban sobre una copia que siguen usando para las siguientes.
// Toda la aritmética es `checked_*`: un desbordamiento es un rechazo, nunca un
// pánico ni una vuelta al cero.

fn comprobar_nonce(state: &State, who: &AccountId, nonce: u64) -> Result<(), String> {
    let expected = state.nonce_of(who);
    if nonce != expected {
        return Err(format!("nonce {nonce} != esperado {expected} (anti-replay)"));
    }
    Ok(())
}

fn comprobar_saldo(state: &State, who: &AccountId, amount: Amount, fee: Amount) -> Result<Amount, String> {
    let need = amount.checked_add(fee).ok_or("importe más comisión se salen de rango")?;
    let bal = state.balance_of(who);
    if bal < need {
        return Err(format!("saldo insuficiente: {bal} < {need}"));
    }
    Ok(need)
}

/// Consume el nonce y cobra `total` (ya comprobados).
fn consumir(state: &mut State, who: &AccountId, total: Amount) -> Result<(), String> {
    let a = state.acct(who);
    a.nonce = a.nonce.checked_add(1).ok_or("nonce fuera de rango")?;
    a.balance = a.balance.checked_sub(total).ok_or("saldo insuficiente")?;
    Ok(())
}

/// Índice de la vivienda `n` (1..=unidades) en `units`.
fn indice_vivienda(p: &Parcel, n: u16) -> Result<usize, String> {
    if p.unidades == 0 {
        return Err("la parcela no está dividida en viviendas".into());
    }
    if n == 0 || n > p.unidades {
        return Err(format!("la parcela tiene {} viviendas: no existe la {n}", p.unidades));
    }
    let i = (n - 1) as usize;
    if i >= p.units.len() {
        return Err("registro de viviendas incoherente".into());
    }
    Ok(i)
}

/// ¿Cabe una vivienda ajena más en la cuenta `who`?
fn comprobar_tope_cuenta(state: &State, who: &AccountId) -> Result<(), String> {
    if state.viviendas_ajenas_de(who) >= MAX_UNIDADES_POR_CUENTA {
        return Err(format!(
            "tope de viviendas por cuenta: ya tiene {MAX_UNIDADES_POR_CUENTA} en parcelas de otros"
        ));
    }
    Ok(())
}

fn sumar_ajenas(state: &mut State, who: &AccountId, k: u16) -> Result<(), String> {
    if k == 0 {
        return Ok(());
    }
    let c = state.viviendas_ajenas.entry(*who).or_insert(0);
    *c = c.checked_add(k).ok_or("contador de viviendas fuera de rango")?;
    Ok(())
}

fn restar_ajenas(state: &mut State, who: &AccountId, k: u16) -> Result<(), String> {
    if k == 0 {
        return Ok(());
    }
    let c = state.viviendas_ajenas.get(who).copied().unwrap_or(0);
    let nuevo = c.checked_sub(k).ok_or("contador de viviendas incoherente")?;
    if nuevo == 0 {
        state.viviendas_ajenas.remove(who);
    } else {
        state.viviendas_ajenas.insert(*who, nuevo);
    }
    Ok(())
}

/// Las viviendas del dueño de una parcela en venta van con ella: no se
/// transfieren, no se ponen en venta ni se compran sueltas mientras dure la
/// venta de la parcela. Así el comprador de la parcela recibe las que había
/// cuando la vio publicada (salvo que el vendedor retire la venta antes).
fn comprobar_no_congelada(p: &Parcel, owner_unidad: &AccountId) -> Result<(), String> {
    if p.sale.is_some() && *owner_unidad == p.owner {
        return Err("la parcela está en venta y sus viviendas del dueño van con ella: retira antes la venta de la parcela".into());
    }
    Ok(())
}

/// `apply_tx` para quien sigue usando el estado después de un rechazo: el
/// mempool y el bloque candidato del nodo, que encadenan transacciones sobre
/// una copia. Dentro de un bloque da igual lo que un rechazo deje a medias:
/// `apply_block_con` trabaja sobre una copia y tira el bloque entero. Fuera,
/// no: varios tipos anteriores a la v0.11.0 suben el nonce (`require_nonce`),
/// cobran la comisión o suman a lo quemado ANTES de una comprobación que
/// puede fallar (Unstake, Reveal, TransferAsset, BuyAsset, MintAsset…). Con
/// esa copia, la siguiente transacción del mismo firmante entraba en el
/// candidato con un nonce que el bloque real no admite, y el minero fabricaba
/// una y otra vez bloques que su propio árbol rechazaba. Aquí, si falla, se
/// reponen la cuenta del firmante y `quemado`, que es lo único que `apply_tx`
/// toca antes de un rechazo: los tipos que pagan a un tercero o mueven una
/// parcela, un activo o una vivienda lo hacen cuando ya no queda ninguna
/// comprobación que pueda fallar (en la vivienda, los contadores se
/// comprueban antes de mutar). Lo fija el test
/// `un_rechazo_sin_rastro_en_los_tipos_que_mutan_antes_de_fallar`, y la
/// revisión lo sometió a 300 000 tx aleatorias sin un solo rechazo con
/// rastro. Si un tipo nuevo muta otra cosa antes de fallar, ese test tiene
/// que cubrirlo. Clonar el estado antes de cada tx no es alternativa: con el
/// mempool lleno, un candidato pasaba de 0,3 s a entre 2 y 360 s.
pub fn apply_tx_sin_rastro(
    state: &mut State,
    tx: &Tx,
    height: u64,
    index: usize,
    this_txid: &TxId,
    firma: &FirmaCtx,
) -> Result<(), String> {
    let firmante = crate::tx::signer_of(tx).copied();
    let cuenta = firmante.and_then(|w| state.accounts.get(&w).cloned());
    let quemado = state.quemado;
    let r = apply_tx(state, tx, height, index, this_txid, firma);
    if r.is_err() {
        if let Some(w) = firmante {
            match cuenta {
                Some(c) => {
                    state.accounts.insert(w, c);
                }
                None => {
                    state.accounts.remove(&w);
                }
            }
        }
        state.quemado = quemado;
    }
    r
}

/// Transición de estado de UNA transacción. Pública para que el mempool y el
/// constructor de bloques usen EXACTAMENTE las mismas reglas que la validación
/// de bloques (una tx que pase aquí nunca invalidará el bloque minado; si
/// falla y el estado se reutiliza, `apply_tx_sin_rastro`).
/// `firma`: las reglas que rigen en el bloque (lo decide el árbol por su
/// fecha): Dubái (precios por distrito, mercado, tipos nuevos) y la escritura
/// de vivienda (`FirmaCtx::vivienda_rige`).
pub fn apply_tx(
    state: &mut State,
    tx: &Tx,
    height: u64,
    index: usize,
    this_txid: &TxId,
    firma: &FirmaCtx,
) -> Result<(), String> {
    let dubai = firma.dubai;
    let vivienda = firma.vivienda_rige();
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
                // Desde la escritura de vivienda, también el dueño de cualquier
                // vivienda de la parcela (tu local, tu objeto, en tu edificio).
                // Antes, exactamente como siempre: solo el dueño de la parcela.
                Some(p) if p.owner == *who || (vivienda && p.units.iter().any(|u| u.owner == *who)) => {
                    // Dubái: los vehículos solo los acuña un concesionario.
                    if dubai && *kind == 2 && p.kind != ciudad::SECTOR_CONCESIONARIO {
                        return Err("solo un concesionario puede acuñar vehículos".into());
                    }
                }
                Some(_) if vivienda => {
                    return Err("solo el dueño de la parcela o de una de sus viviendas puede acuñar en ella".into())
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
            // Vivienda (v0.11.0): si la parcela está dividida, las viviendas
            // que eran del vendedor pasan al comprador con ella (y salen de la
            // venta); las de terceros siguen siendo suyas. Las que el
            // comprador ya tenía aquí dejan de ser «ajenas». El tope por cuenta
            // no bloquea esta compra: todo lo que el comprador recibe es de su
            // propia parcela, que el tope no cuenta (docs/VIVIENDA.md, §4).
            // Sin dividir, nada de esto hace nada: exactamente como antes.
            let ya_del_comprador = {
                let p = state.parcels.get(&(*x, *y)).ok_or("la parcela no tiene dueño")?;
                p.units.iter().filter(|u| u.owner == *who).count() as u16
            };
            if state.viviendas_ajenas_de(who) < ya_del_comprador {
                return Err("contador de viviendas incoherente".into());
            }
            spend(state, who, price, *fee)?;
            state.acct(&owner).balance += price;
            let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
            p.owner = *who;
            p.sale = None;
            p.since = height;
            for u in p.units.iter_mut() {
                if u.owner == owner {
                    u.owner = *who;
                    u.sale = None;
                }
            }
            restar_ajenas(state, who, ya_del_comprador)?;
            ciudad::apuntar_trade(
                &mut state.trades,
                Trade { height, kind: 0, x: *x, y: *y, sector, distrito: ciudad::distrito(*x, *y).id, price },
            );
            Ok(())
        }

        // ---------- Dubái RAMI (fase 2): identidad ----------
        Tx::SetProfile { who, handle, display, bio, avatar, color, node_pk, fee, nonce, .. } => {
            if !dubai {
                return Err("las reglas de Dubái no rigen todavía".into());
            }
            require_nonce(state, who, *nonce)?;
            // La forma (longitudes, alfabeto, UTF-8, firma del vínculo) ya la
            // comprobó `verify_tx_con`; aquí, lo que depende del estado.
            let handle_s = String::from_utf8(handle.clone()).map_err(|_| "nombre no UTF-8".to_string())?;
            if let Some(dueno) = state.handles.get(&handle_s) {
                if dueno != who {
                    return Err("ese nombre ya tiene dueño".into());
                }
            }
            let vinculo = if *node_pk == [0u8; 32] { None } else { Some(*node_pk) };
            if let Some(npk) = vinculo {
                if let Some(cuenta) = state.nodes.get(&npk) {
                    if cuenta != who {
                        return Err("ese nodo ya está vinculado a otra cuenta".into());
                    }
                }
            }
            let anterior = state.profiles.get(who).cloned();
            let nombre_nuevo = anterior.as_ref().map(|p| p.handle != handle_s).unwrap_or(true);
            let quema = if nombre_nuevo { ciudad::PRECIO_NOMBRE } else { 0 };
            spend(state, who, quema, *fee)?;
            state.quemado += quema;
            if let Some(p) = &anterior {
                if p.handle != handle_s {
                    state.handles.remove(&p.handle);
                }
                if let Some(old) = p.node_pk {
                    if Some(old) != vinculo {
                        state.nodes.remove(&old);
                    }
                }
            }
            state.handles.insert(handle_s.clone(), *who);
            if let Some(npk) = vinculo {
                state.nodes.insert(npk, *who);
            }
            state.profiles.insert(
                *who,
                Profile {
                    handle: handle_s,
                    display: String::from_utf8_lossy(display).to_string(),
                    bio: String::from_utf8_lossy(bio).to_string(),
                    avatar: *avatar,
                    color: *color,
                    node_pk: vinculo,
                    since: anterior.as_ref().map(|p| p.since).unwrap_or(height),
                    updated: height,
                },
            );
            Ok(())
        }

        // ---------- Escritura de vivienda (v0.11.0) ----------
        Tx::DivideParcel { who, x, y, unidades, fee, nonce, .. } => {
            if !vivienda {
                return Err("la escritura de vivienda no rige todavía".into());
            }
            comprobar_nonce(state, who, *nonce)?;
            let total = comprobar_saldo(state, who, 0, *fee)?;
            let p = state.parcels.get(&(*x, *y)).ok_or("la parcela no tiene dueño")?;
            if p.owner != *who {
                return Err("solo el dueño de la parcela puede dividirla".into());
            }
            if p.unidades > 0 {
                return Err(format!("la parcela ya está dividida en {} viviendas", p.unidades));
            }
            if p.sale.is_some() {
                return Err("la parcela está en venta: retira la venta antes de dividirla".into());
            }
            if *unidades == 0 || *unidades > MAX_UNIDADES_POR_PARCELA {
                return Err(format!("número de viviendas fuera de rango (de 1 a {MAX_UNIDADES_POR_PARCELA})"));
            }
            consumir(state, who, total)?;
            // Todas nacen del dueño: son de su propia parcela y el tope por
            // cuenta no las cuenta. Solo cuesta la comisión: el suelo ya se
            // pagó (y se quemó) al reclamar la parcela.
            let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
            p.unidades = *unidades;
            p.units = vec![Unidad { owner: *who, sale: None }; *unidades as usize];
            Ok(())
        }
        Tx::TransferUnit { from, x, y, n, to, fee, nonce, .. } => {
            if !vivienda {
                return Err("la escritura de vivienda no rige todavía".into());
            }
            comprobar_nonce(state, from, *nonce)?;
            let total = comprobar_saldo(state, from, 0, *fee)?;
            let p = state.parcels.get(&(*x, *y)).ok_or("la parcela no tiene dueño")?;
            let i = indice_vivienda(p, *n)?;
            let u = &p.units[i];
            if u.owner != *from {
                return Err("no eres el dueño de esa vivienda".into());
            }
            if to == from {
                return Err("la vivienda ya es tuya".into());
            }
            if u.sale.is_some() {
                return Err("la vivienda está en venta: retira la venta antes de transferirla".into());
            }
            comprobar_no_congelada(p, &u.owner)?;
            let dueno_parcela = p.owner;
            let sale_de_ajena = *from != dueno_parcela;
            let entra_en_ajena = *to != dueno_parcela;
            if entra_en_ajena {
                comprobar_tope_cuenta(state, to)?;
            }
            // Los contadores, antes de mutar nada: así ningún rechazo de este
            // tipo deja la vivienda movida (el invariante lo mantiene, pero la
            // garantía de `apply_tx_sin_rastro` no depende de él).
            if sale_de_ajena && state.viviendas_ajenas_de(from) < 1 {
                return Err("contador de viviendas incoherente".into());
            }
            consumir(state, from, total)?;
            let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
            p.units[i].owner = *to;
            if sale_de_ajena {
                restar_ajenas(state, from, 1)?;
            }
            if entra_en_ajena {
                sumar_ajenas(state, to, 1)?;
            }
            Ok(())
        }
        Tx::SellUnit { who, x, y, n, price, fee, nonce, .. } => {
            if !vivienda {
                return Err("la escritura de vivienda no rige todavía".into());
            }
            comprobar_nonce(state, who, *nonce)?;
            let total = comprobar_saldo(state, who, 0, *fee)?;
            let p = state.parcels.get(&(*x, *y)).ok_or("la parcela no tiene dueño")?;
            let i = indice_vivienda(p, *n)?;
            if p.units[i].owner != *who {
                return Err("no eres el dueño de esa vivienda".into());
            }
            // Retirar una venta (precio 0) se puede siempre; publicarla, no si
            // la vivienda va con una parcela en venta.
            if *price > 0 {
                comprobar_no_congelada(p, who)?;
            }
            consumir(state, who, total)?;
            let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
            p.units[i].sale = if *price == 0 { None } else { Some(*price) };
            Ok(())
        }
        Tx::BuyUnit { who, x, y, n, max_price, fee, nonce, .. } => {
            if !vivienda {
                return Err("la escritura de vivienda no rige todavía".into());
            }
            comprobar_nonce(state, who, *nonce)?;
            let p = state.parcels.get(&(*x, *y)).ok_or("la parcela no tiene dueño")?;
            let i = indice_vivienda(p, *n)?;
            let u = &p.units[i];
            let price = u.sale.ok_or("la vivienda no está en venta")?;
            let vendedor = u.owner;
            if vendedor == *who {
                return Err("ya es tuya".into());
            }
            if price > *max_price {
                return Err(format!("el precio ({price}) supera tu máximo ({max_price})"));
            }
            comprobar_no_congelada(p, &vendedor)?;
            let dueno_parcela = p.owner;
            let sector = p.kind;
            let sale_de_ajena = vendedor != dueno_parcela;
            let entra_en_ajena = *who != dueno_parcela;
            if entra_en_ajena {
                comprobar_tope_cuenta(state, who)?;
            }
            // Como en TransferUnit: el contador del vendedor, antes de pagar.
            if sale_de_ajena && state.viviendas_ajenas_de(&vendedor) < 1 {
                return Err("contador de viviendas incoherente".into());
            }
            // La misma política que BuyAsset y BuyParcel: el comprador paga el
            // precio entero al vendedor y la comisión al minero; no se quema
            // nada. Pago y cambio de dueño, en la misma transacción.
            let total = comprobar_saldo(state, who, price, *fee)?;
            let saldo_vendedor = state.balance_of(&vendedor).checked_add(price).ok_or("saldo del vendedor fuera de rango")?;
            consumir(state, who, total)?;
            state.acct(&vendedor).balance = saldo_vendedor;
            let p = state.parcels.get_mut(&(*x, *y)).expect("existe");
            p.units[i].owner = *who;
            p.units[i].sale = None;
            if sale_de_ajena {
                restar_ajenas(state, &vendedor, 1)?;
            }
            if entra_en_ajena {
                sumar_ajenas(state, who, 1)?;
            }
            ciudad::apuntar_trade(
                &mut state.trades,
                Trade { height, kind: 2, x: *x, y: *y, sector, distrito: ciudad::distrito(*x, *y).id, price },
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
            | Tx::BuyParcel { sig: s, .. }
            | Tx::SetProfile { sig: s, .. }
            | Tx::DivideParcel { sig: s, .. }
            | Tx::TransferUnit { sig: s, .. }
            | Tx::SellUnit { sig: s, .. }
            | Tx::BuyUnit { sig: s, .. } => *s = sig,
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
            | Tx::BuyParcel { sig: s, .. }
            | Tx::SetProfile { sig: s, .. }
            | Tx::DivideParcel { sig: s, .. }
            | Tx::TransferUnit { sig: s, .. }
            | Tx::SellUnit { sig: s, .. }
            | Tx::BuyUnit { sig: s, .. } => *s = sig,
            Tx::Coinbase { .. } => {}
        }
        tx
    }

    /// Identidad (v0.10.0): el nombre es único y cuesta 2 RAMI quemados, el
    /// vínculo con el nodo exige la firma de ese nodo, cambiar de nombre libera
    /// el anterior, actualizar sin cambiar de nombre no quema, y nada de esto
    /// vale antes de la activación de Dubái.
    #[test]
    fn perfil_nombre_unico_vinculo_y_quema() {
        use crate::tx::vinculo_mensaje;
        let net = [9u8; 32];
        let con = FirmaCtx::v2(net).con_dubai(true);
        let sin = FirmaCtx::v2(net);
        let a = KeyPair::from_secret(&[41u8; 32]);
        let b = KeyPair::from_secret(&[42u8; 32]);
        let nodo = KeyPair::from_secret(&[43u8; 32]);
        let (pa, pb, pn) = (a.public_bytes(), b.public_bytes(), nodo.public_bytes());
        let mut st = State::default();
        let b0 = block_with(0, ZERO_HASH, vec![coinbase(0, pa, 50 * COIN)]);
        apply_block_con(&mut st, &b0, 0, &sin).unwrap();
        let perfil = |kp: &KeyPair, handle: &str, display: &str, nonce: u64, vinculo: Option<([u8; 32], [u8; 64])>| {
            let (node_pk, node_sig) = vinculo.unwrap_or(([0u8; 32], [0u8; 64]));
            Tx::SetProfile {
                who: kp.public_bytes(), handle: handle.as_bytes().to_vec(), display: display.as_bytes().to_vec(),
                bio: b"aprendo a hacer negocios".to_vec(), avatar: 3, color: 5, node_pk, node_sig, fee: 1, nonce, sig: [0u8; 64],
            }
        };
        // Antes de la activación no vale (ni siquiera por la forma).
        let temprano = signed_con(&a, &sin, perfil(&a, "rami", "Rami", 0, None));
        assert!(verify_tx_con(&temprano, &sin).unwrap_err().contains("antes de su activación"));
        // Forma: nombre inválido, vínculo mal firmado.
        for malo in ["Ra", "Rami", "rami-ledger", "abcdefghijklmnopqrstu", "ramí"] {
            let tx = signed_con(&a, &con, perfil(&a, malo, "x", 0, None));
            assert!(verify_tx_con(&tx, &con).is_err(), "{malo} debería ser inválido");
        }
        // Catálogo de avatar/color y topes de alias y biografía (los flags de la
        // CLI y el panel se apoyan en estos rechazos).
        let fuera = |avatar: u8, color: u8| {
            let mut tx = perfil(&a, "rami", "Rami", 0, None);
            if let Tx::SetProfile { avatar: av, color: co, .. } = &mut tx {
                *av = avatar;
                *co = color;
            }
            signed_con(&a, &con, tx)
        };
        assert!(verify_tx_con(&fuera(16, 0), &con).unwrap_err().contains("catálogo"));
        assert!(verify_tx_con(&fuera(0, 16), &con).unwrap_err().contains("catálogo"));
        assert!(verify_tx_con(&fuera(15, 15), &con).is_ok());
        let largo = |display: Vec<u8>, bio: Vec<u8>| {
            let mut tx = perfil(&a, "rami", "Rami", 0, None);
            if let Tx::SetProfile { display: d, bio: b, .. } = &mut tx {
                *d = display;
                *b = bio;
            }
            signed_con(&a, &con, tx)
        };
        assert!(verify_tx_con(&largo(vec![b'x'; 33], vec![]), &con).unwrap_err().contains("alias"));
        assert!(verify_tx_con(&largo(vec![], vec![b'x'; 161]), &con).unwrap_err().contains("biografía"));
        assert!(verify_tx_con(&largo(vec![0xff], vec![]), &con).unwrap_err().contains("alias"), "alias no UTF-8");
        assert!(verify_tx_con(&largo(vec![b'x'; 32], vec![b'x'; 160]), &con).is_ok());

        let firma_ajena = nodo.sign(&vinculo_mensaje(&pb)); // firma la cuenta de B, no la de A
        let tx = signed_con(&a, &con, perfil(&a, "rami", "Rami", 0, Some((pn, firma_ajena))));
        assert!(verify_tx_con(&tx, &con).unwrap_err().contains("vínculo"));
        let tx = signed_con(&a, &con, perfil(&a, "rami", "Rami", 0, Some(([0u8; 32], [1u8; 64]))));
        assert!(verify_tx_con(&tx, &con).is_err());

        // Bloque 1: A registra «rami» vinculado a su nodo; B paga con el saldo que A le manda.
        let firma_nodo = nodo.sign(&vinculo_mensaje(&pa));
        let alta = signed_con(&a, &con, perfil(&a, "rami", "Rami", 0, Some((pn, firma_nodo))));
        let pago_b = signed_con(&a, &con, Tx::Transfer { from: pa, to: pb, amount: 10 * COIN, fee: 1, nonce: 1, sig: [0u8; 64] });
        let quemado_antes = st.quemado;
        let saldo_antes = st.balance_of(&pa);
        let b1 = block_with(1, b0.hash(), vec![coinbase(1, pa, 40 * COIN + 2), alta, pago_b]);
        apply_block_con(&mut st, &b1, 1, &con).unwrap();
        let p = &st.profiles[&pa];
        assert_eq!(p.handle, "rami");
        assert_eq!(p.node_pk, Some(pn));
        assert_eq!((p.since, p.updated), (1, 1));
        assert_eq!(st.handles["rami"], pa);
        assert_eq!(st.nodes[&pn], pa);
        assert_eq!(st.quemado, quemado_antes + ciudad::PRECIO_NOMBRE);
        assert_eq!(st.balance_of(&pa), saldo_antes + 40 * COIN + 2 - ciudad::PRECIO_NOMBRE - 1 - 10 * COIN - 1);
        // Un binario sin Dubái no admite el bloque.
        let mut viejo = State::default();
        apply_block_con(&mut viejo, &b0, 0, &sin).unwrap();
        assert!(apply_block_con(&mut viejo, &b1, 1, &sin).is_err());

        // Bloque 2: B no puede coger «rami» ni el nodo de A; sí «beatriz».
        let usurpa = signed_con(&b, &con, perfil(&b, "rami", "B", 0, None));
        let b2mal = block_with(2, b1.hash(), vec![coinbase(2, pa, 40 * COIN), usurpa]);
        assert!(apply_block_con(&mut st.clone(), &b2mal, 2, &con).unwrap_err().contains("ya tiene dueño"));
        let firma_nodo_b = nodo.sign(&vinculo_mensaje(&pb));
        let roba_nodo = signed_con(&b, &con, perfil(&b, "beatriz", "B", 0, Some((pn, firma_nodo_b))));
        let b2mal = block_with(2, b1.hash(), vec![coinbase(2, pa, 40 * COIN), roba_nodo]);
        assert!(apply_block_con(&mut st.clone(), &b2mal, 2, &con).unwrap_err().contains("vinculado a otra cuenta"));
        let alta_b = signed_con(&b, &con, perfil(&b, "beatriz", "Beatriz", 0, None));
        // A actualiza su alias sin cambiar de nombre: no quema.
        let alias = signed_con(&a, &con, perfil(&a, "rami", "Rami B.", 2, Some((pn, firma_nodo))));
        let b2 = block_with(2, b1.hash(), vec![coinbase(2, pa, 40 * COIN + 2), alta_b, alias]);
        let quemado_antes = st.quemado;
        apply_block_con(&mut st, &b2, 2, &con).unwrap();
        assert_eq!(st.quemado, quemado_antes + ciudad::PRECIO_NOMBRE, "solo el nombre de B quema");
        assert_eq!(st.profiles[&pa].display, "Rami B.");
        assert_eq!((st.profiles[&pa].since, st.profiles[&pa].updated), (1, 2));
        assert_eq!(st.profiles[&pb].handle, "beatriz");

        // Bloque 3: A cambia de nombre y suelta el vínculo: «rami» queda libre y el nodo también.
        let cambio = signed_con(&a, &con, perfil(&a, "rami_2", "Rami", 3, None));
        let b3 = block_with(3, b2.hash(), vec![coinbase(3, pa, 40 * COIN + 1), cambio]);
        apply_block_con(&mut st, &b3, 3, &con).unwrap();
        assert!(!st.handles.contains_key("rami"));
        assert_eq!(st.handles["rami_2"], pa);
        assert!(st.nodes.is_empty());
        assert_eq!(st.profiles[&pa].node_pk, None);
        // Y ahora B puede quedarse con «rami».
        let hereda = signed_con(&b, &con, perfil(&b, "rami", "Beatriz", 1, None));
        let b4 = block_with(4, b3.hash(), vec![coinbase(4, pa, 40 * COIN + 1), hereda]);
        apply_block_con(&mut st, &b4, 4, &con).unwrap();
        assert_eq!(st.handles["rami"], pb);
        assert!(!st.handles.contains_key("beatriz"));
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

    // ---------------- Escritura de vivienda (v0.11.0) ----------------

    /// Cadena de prueba: aplica bloques bajo un contexto fijo y, tras cada
    /// bloque aceptado, comprueba que el contador del tope por cuenta coincide
    /// con su definición recontada desde las parcelas y que nadie pasa del tope.
    struct Cadena {
        st: State,
        prev: [u8; 32],
        h: u64,
        ctx: FirmaCtx,
        minero: AccountId,
    }

    impl Cadena {
        fn nueva(minero: AccountId, ctx: FirmaCtx) -> Self {
            let mut c = Cadena { st: State::default(), prev: ZERO_HASH, h: 0, ctx, minero };
            let b0 = block_with(0, ZERO_HASH, vec![coinbase(0, minero, 50 * COIN)]);
            apply_block_con(&mut c.st, &b0, 0, &FirmaCtx::v2(ctx.net)).unwrap();
            c.prev = b0.hash();
            c
        }
        fn bloque_de(&self, txs: Vec<Tx>) -> Block {
            let mut v = vec![coinbase(self.h + 1, self.minero, 40 * COIN)];
            v.extend(txs);
            block_with(self.h + 1, self.prev, v)
        }
        /// Aplica un bloque que DEBE valer.
        fn ok(&mut self, txs: Vec<Tx>) {
            let b = self.bloque_de(txs);
            apply_block_con(&mut self.st, &b, self.h + 1, &self.ctx).unwrap_or_else(|e| panic!("bloque {} rechazado: {e}", self.h + 1));
            self.h += 1;
            self.prev = b.hash();
            self.invariantes();
        }
        /// Un bloque que NO debe valer: devuelve el motivo y no cambia nada.
        fn falla(&self, txs: Vec<Tx>) -> String {
            let b = self.bloque_de(txs);
            let mut copia = self.st.clone();
            let e = apply_block_con(&mut copia, &b, self.h + 1, &self.ctx).expect_err("el bloque debía ser inválido");
            e
        }
        fn invariantes(&self) {
            let recontado = viviendas_ajenas_recontadas(&self.st);
            assert_eq!(recontado, self.st.viviendas_ajenas, "el contador del tope se separó de su definición");
            for (cuenta, k) in &recontado {
                assert!(*k <= MAX_UNIDADES_POR_CUENTA, "{} tiene {k} viviendas ajenas", hex::encode(&cuenta[..4]));
            }
            for p in self.st.parcels.values() {
                assert_eq!(p.units.len(), p.unidades as usize);
                assert!(p.unidades <= MAX_UNIDADES_POR_PARCELA);
            }
        }
        fn nonce(&self, kp: &KeyPair) -> u64 {
            self.st.nonce_of(&kp.public_bytes())
        }
    }

    fn ctx_vivienda() -> FirmaCtx {
        FirmaCtx::v2([0x51u8; 32]).con_dubai(true).con_vivienda(true)
    }

    /// Suma de lo importado por todas las empresas: el reparto de cada bloque
    /// quema eso y nada más, así que `quemado − importado` solo cambia con
    /// las quemas de las transacciones.
    fn quemas_de_tx(st: &State) -> Amount {
        st.quemado - st.parcels.values().map(|p| p.importado).sum::<Amount>()
    }

    /// Dividir, transferir, vender y comprar viviendas; cada caso válido y cada
    /// rechazo con su motivo; MintAsset por el dueño de una vivienda; y la
    /// compra de una parcela dividida.
    #[test]
    fn vivienda_dividir_transferir_vender_comprar_y_acunar() {
        let ctx = ctx_vivienda();
        let a = KeyPair::from_secret(&[61u8; 32]);
        let b = KeyPair::from_secret(&[62u8; 32]);
        let c = KeyPair::from_secret(&[63u8; 32]);
        let d = KeyPair::from_secret(&[64u8; 32]);
        let (pa, pb, pc, pd) = (a.public_bytes(), b.public_bytes(), c.public_bytes(), d.public_bytes());
        let mut k = Cadena::nueva(pa, ctx);
        let s = |kp: &KeyPair, tx: Tx| signed_con(kp, &ctx, tx);
        // Bloque 1: A monta una inmobiliaria en el desierto (5 RAMI) y reparte fondos.
        let n = k.nonce(&a);
        k.ok(vec![
            s(&a, Tx::ClaimParcel { who: pa, x: 21, y: 45, name: b"Residencial".to_vec(), kind: 7, fee: 1, nonce: n, sig: [0u8; 64] }),
            s(&a, Tx::Transfer { from: pa, to: pb, amount: 35 * COIN, fee: 1, nonce: n + 1, sig: [0u8; 64] }),
            s(&a, Tx::Transfer { from: pa, to: pc, amount: 20 * COIN, fee: 1, nonce: n + 2, sig: [0u8; 64] }),
            s(&a, Tx::Transfer { from: pa, to: pd, amount: 10 * COIN, fee: 1, nonce: n + 3, sig: [0u8; 64] }),
        ]);
        let divide = |kp: &KeyPair, x: u16, y: u16, unidades: u16, nonce: u64| {
            s(kp, Tx::DivideParcel { who: kp.public_bytes(), x, y, unidades, fee: 1, nonce, sig: [0u8; 64] })
        };
        // Solo el dueño divide; una parcela sin dueño no se divide.
        assert!(k.falla(vec![divide(&b, 21, 45, 4, 0)]).contains("solo el dueño"));
        assert!(k.falla(vec![divide(&a, 30, 50, 4, k.nonce(&a))]).contains("no tiene dueño"));
        // Fuera de rango: lo rechaza la forma (verify_tx_con), antes que el estado.
        assert!(verify_tx_con(&divide(&a, 21, 45, 0, 0), &ctx).unwrap_err().contains("fuera de rango"));
        assert!(verify_tx_con(&divide(&a, 21, 45, 65, 0), &ctx).unwrap_err().contains("fuera de rango"));
        assert!(verify_tx_con(&divide(&a, 21, 45, 64, 0), &ctx).is_ok());
        // Bloque 2: A divide en 4. Todas nacen suyas y no cuentan para el tope.
        let quemas = quemas_de_tx(&k.st);
        let saldo_a = k.st.balance_of(&pa);
        k.ok(vec![divide(&a, 21, 45, 4, k.nonce(&a))]);
        let p = &k.st.parcels[&(21, 45)];
        assert_eq!(p.unidades, 4);
        assert!(p.units.iter().all(|u| u.owner == pa && u.sale.is_none()));
        assert!(k.st.viviendas_ajenas.is_empty());
        assert_eq!(quemas_de_tx(&k.st), quemas, "dividir no quema nada");
        assert!(k.st.balance_of(&pa) + 1 >= saldo_a, "solo paga la comisión (y cobra el reparto)");
        // Una vez.
        assert!(k.falla(vec![divide(&a, 21, 45, 8, k.nonce(&a))]).contains("ya está dividida"));

        let transfiere = |kp: &KeyPair, n: u16, to: AccountId, nonce: u64| {
            s(kp, Tx::TransferUnit { from: kp.public_bytes(), x: 21, y: 45, n, to, fee: 1, nonce, sig: [0u8; 64] })
        };
        let vende = |kp: &KeyPair, n: u16, price: Amount, nonce: u64| {
            s(kp, Tx::SellUnit { who: kp.public_bytes(), x: 21, y: 45, n, price, fee: 1, nonce, sig: [0u8; 64] })
        };
        let compra = |kp: &KeyPair, n: u16, max_price: Amount, nonce: u64| {
            s(kp, Tx::BuyUnit { who: kp.public_bytes(), x: 21, y: 45, n, max_price, fee: 1, nonce, sig: [0u8; 64] })
        };
        // Rechazos de TransferUnit: vivienda inexistente, ajena, a uno mismo.
        assert!(k.falla(vec![transfiere(&a, 5, pb, k.nonce(&a))]).contains("no existe la 5"));
        assert!(k.falla(vec![transfiere(&b, 1, pc, k.nonce(&b))]).contains("no eres el dueño"));
        assert!(k.falla(vec![transfiere(&a, 1, pa, k.nonce(&a))]).contains("ya es tuya"));
        // Bloque 3: A da la 1 a B y pone la 2 en venta por 3 RAMI.
        let na = k.nonce(&a);
        k.ok(vec![transfiere(&a, 1, pb, na), vende(&a, 2, 3 * COIN, na + 1)]);
        assert_eq!(k.st.parcels[&(21, 45)].units[0].owner, pb);
        assert_eq!(k.st.parcels[&(21, 45)].units[1].sale, Some(3 * COIN));
        assert_eq!(k.st.viviendas_ajenas_de(&pb), 1);
        // Una vivienda en venta no se transfiere.
        assert!(k.falla(vec![transfiere(&a, 2, pc, k.nonce(&a))]).contains("en venta"));
        // Rechazos de BuyUnit: por encima del máximo, no en venta, propia.
        assert!(k.falla(vec![compra(&c, 2, 2 * COIN, k.nonce(&c))]).contains("supera tu máximo"));
        assert!(k.falla(vec![compra(&c, 3, 9 * COIN, k.nonce(&c))]).contains("no está en venta"));
        assert!(k.falla(vec![compra(&a, 2, 9 * COIN, k.nonce(&a))]).contains("ya es tuya"));
        assert!(verify_tx_con(&compra(&c, 2, 0, 0), &ctx).unwrap_err().contains("mayor que cero"));
        // Bloque 4: C compra la 2 por 3 RAMI. Paga el precio entero a A y la
        // comisión al minero; no se quema nada; la operación queda apuntada.
        let (sc, trades) = (k.st.balance_of(&pc), k.st.trades.len());
        let quemas = quemas_de_tx(&k.st);
        k.ok(vec![compra(&c, 2, 3 * COIN, k.nonce(&c))]);
        assert_eq!(k.st.balance_of(&pc), sc - 3 * COIN - 1);
        assert_eq!(quemas_de_tx(&k.st), quemas);
        let u2 = &k.st.parcels[&(21, 45)].units[1];
        assert_eq!((u2.owner, u2.sale), (pc, None));
        assert_eq!(k.st.trades.len(), trades + 1);
        let t = k.st.trades.back().unwrap();
        assert_eq!((t.kind, t.x, t.y, t.sector, t.price, t.height), (2, 21, 45, 7, 3 * COIN, k.h));
        assert_eq!(k.st.viviendas_ajenas_de(&pc), 1);
        // El vendedor cobra: el mismo bloque con y sin la compra difiere en 3 RAMI para A.
        {
            let mut con = Cadena { st: k.st.clone(), prev: k.prev, h: k.h, ctx, minero: pd };
            let mut sin = Cadena { st: k.st.clone(), prev: k.prev, h: k.h, ctx, minero: pd };
            let nb = k.nonce(&b);
            sin.ok(vec![vende(&b, 1, 2 * COIN, nb)]);
            con.ok(vec![vende(&b, 1, 2 * COIN, nb), compra(&d, 1, 2 * COIN, k.nonce(&d))]);
            assert_eq!(con.st.balance_of(&pb), sin.st.balance_of(&pb) + 2 * COIN);
        }

        // MintAsset: C (dueña de la vivienda 2) acuña un objeto en la parcela;
        // D (sin vivienda) no puede.
        let mint = |kp: &KeyPair, nonce: u64| {
            s(kp, Tx::MintAsset { who: kp.public_bytes(), x: 21, y: 45, kind: 1, meta: b"Sofa".to_vec(), fee: 1, nonce, sig: [0u8; 64] })
        };
        assert!(k.falla(vec![mint(&d, k.nonce(&d))]).contains("o de una de sus viviendas"));
        let m = mint(&c, k.nonce(&c));
        let id = txid(&m);
        k.ok(vec![m]);
        assert_eq!(k.st.assets[&id].owner, pc);
        // Sin la regla de vivienda (el mismo estado, contexto de Dubái sin
        // vivienda), el dueño de una vivienda NO acuña: exactamente como antes.
        {
            let sin_viv = FirmaCtx::v2(ctx.net).con_dubai(true);
            let m2 = signed_con(&c, &sin_viv, Tx::MintAsset { who: pc, x: 21, y: 45, kind: 1, meta: b"Mesa".to_vec(), fee: 1, nonce: k.nonce(&c), sig: [0u8; 64] });
            let b = k.bloque_de(vec![m2]);
            let err = apply_block_con(&mut k.st.clone(), &b, k.h + 1, &sin_viv).unwrap_err();
            assert!(err.contains("solo el dueño de la parcela puede acuñar"), "motivo: {err}");
        }

        // C pone su vivienda en venta y luego la retira; en venta no se transfiere.
        k.ok(vec![vende(&c, 2, 5 * COIN, k.nonce(&c))]);
        assert!(k.falla(vec![transfiere(&c, 2, pd, k.nonce(&c))]).contains("en venta"));
        k.ok(vec![vende(&c, 2, 0, k.nonce(&c))]);
        assert_eq!(k.st.parcels[&(21, 45)].units[1].sale, None);
        assert!(k.falla(vec![vende(&d, 2, 5 * COIN, k.nonce(&d))]).contains("no eres el dueño"));

        // Parcela en venta: las viviendas del dueño van con ella. A pone la 4 a
        // la venta y DESPUÉS la parcela: la 4 no se compra suelta, la 3 no se
        // vende ni se transfiere; las de terceros (la 2 de C) siguen libres.
        let na = k.nonce(&a);
        k.ok(vec![vende(&a, 4, 2 * COIN, na), s(&a, Tx::SellParcel { who: pa, x: 21, y: 45, price: 30 * COIN, fee: 1, nonce: na + 1, sig: [0u8; 64] })]);
        assert!(k.falla(vec![compra(&d, 4, 2 * COIN, k.nonce(&d))]).contains("van con ella"));
        assert!(k.falla(vec![vende(&a, 3, COIN, k.nonce(&a))]).contains("van con ella"));
        assert!(k.falla(vec![transfiere(&a, 3, pd, k.nonce(&a))]).contains("van con ella"));
        let nc = k.nonce(&c);
        k.ok(vec![vende(&c, 2, 4 * COIN, nc), vende(&c, 2, 0, nc + 1)]);
        // Retirar la venta de una vivienda propia sí se puede siempre, también
        // con la parcela en venta.
        k.ok(vec![vende(&a, 4, 0, k.nonce(&a))]);
        assert_eq!(k.st.parcels[&(21, 45)].units[3].sale, None);
        // Una parcela en venta y sin dividir no se divide.
        let na = k.nonce(&a);
        k.ok(vec![
            s(&a, Tx::ClaimParcel { who: pa, x: 22, y: 45, name: b"Solar".to_vec(), kind: 8, fee: 1, nonce: na, sig: [0u8; 64] }),
            s(&a, Tx::SellParcel { who: pa, x: 22, y: 45, price: 9 * COIN, fee: 1, nonce: na + 1, sig: [0u8; 64] }),
        ]);
        assert!(k.falla(vec![divide(&a, 22, 45, 2, k.nonce(&a))]).contains("en venta"));

        // Compra de la parcela dividida: B la compra. Las viviendas que eran
        // de A (3 y 4) pasan a B; la 1, que ya era de B, deja de ser «ajena»;
        // la 2 sigue siendo de C.
        let (sb, sa, fondo) = (k.st.balance_of(&pb), k.st.balance_of(&pa), k.st.city_fund);
        k.ok(vec![s(&b, Tx::BuyParcel { who: pb, x: 21, y: 45, max_price: 30 * COIN, fee: 1, nonce: k.nonce(&b), sig: [0u8; 64] })]);
        // Lo que el fondo repartió en este bloque (entre dueños y proveedores).
        let repartido = fondo + ciudad::parte_ciudad(block_reward(k.h)) - k.st.city_fund;
        let p = &k.st.parcels[&(21, 45)];
        assert_eq!(p.owner, pb);
        let duenos: Vec<AccountId> = p.units.iter().map(|u| u.owner).collect();
        assert_eq!(duenos, vec![pb, pc, pb, pb]);
        assert!(p.units.iter().all(|u| u.sale.is_none()));
        assert_eq!(k.st.viviendas_ajenas_de(&pb), 0);
        assert_eq!(k.st.viviendas_ajenas_de(&pc), 1);
        assert!(k.st.balance_of(&pb) + 30 * COIN + 1 >= sb);
        assert!(k.st.balance_of(&pb) <= sb - 30 * COIN - 1 + repartido);
        assert!(k.st.balance_of(&pa) >= sa + 30 * COIN);
        let _ = pd;
    }

    /// Los dos topes. Por parcela: 64 (la forma). Por cuenta: 16 viviendas en
    /// parcelas de OTROS, por TransferUnit y por BuyUnit; el dueño de la
    /// parcela recibe las suyas sin tope; y la compra de una parcela dividida
    /// no es una puerta trasera: tras cualquier secuencia, nadie tiene más de
    /// 16 viviendas ajenas (lo comprueba `Cadena::invariantes` tras cada bloque).
    #[test]
    fn vivienda_topes_por_parcela_y_por_cuenta_sin_puerta_trasera() {
        let ctx = ctx_vivienda();
        let a = KeyPair::from_secret(&[71u8; 32]);
        let b = KeyPair::from_secret(&[72u8; 32]);
        let c = KeyPair::from_secret(&[73u8; 32]);
        let e = KeyPair::from_secret(&[75u8; 32]);
        let (pa, pb, pc, pe) = (a.public_bytes(), b.public_bytes(), c.public_bytes(), e.public_bytes());
        let mut k = Cadena::nueva(pa, ctx);
        let s = |kp: &KeyPair, tx: Tx| signed_con(kp, &ctx, tx);
        // A reclama P1 (21,45) y la divide en 64; E recibe fondos y reclama P2 (23,45) con 20.
        let n = k.nonce(&a);
        k.ok(vec![
            s(&a, Tx::ClaimParcel { who: pa, x: 21, y: 45, name: b"Torre".to_vec(), kind: 7, fee: 1, nonce: n, sig: [0u8; 64] }),
            s(&a, Tx::Transfer { from: pa, to: pb, amount: 20 * COIN, fee: 1, nonce: n + 1, sig: [0u8; 64] }),
            s(&a, Tx::Transfer { from: pa, to: pc, amount: 10 * COIN, fee: 1, nonce: n + 2, sig: [0u8; 64] }),
            s(&a, Tx::Transfer { from: pa, to: pe, amount: 10 * COIN, fee: 1, nonce: n + 3, sig: [0u8; 64] }),
        ]);
        let ne = k.nonce(&e);
        k.ok(vec![
            s(&a, Tx::DivideParcel { who: pa, x: 21, y: 45, unidades: MAX_UNIDADES_POR_PARCELA, fee: 1, nonce: k.nonce(&a), sig: [0u8; 64] }),
            s(&e, Tx::ClaimParcel { who: pe, x: 23, y: 45, name: b"Bloque".to_vec(), kind: 7, fee: 1, nonce: ne, sig: [0u8; 64] }),
            s(&e, Tx::DivideParcel { who: pe, x: 23, y: 45, unidades: 20, fee: 1, nonce: ne + 1, sig: [0u8; 64] }),
        ]);
        assert_eq!(k.st.parcels[&(21, 45)].unidades, 64);
        let unidad = |kp: &KeyPair, x: u16, n: u16, to: AccountId, nonce: u64| {
            s(kp, Tx::TransferUnit { from: kp.public_bytes(), x, y: 45, n, to, fee: 1, nonce, sig: [0u8; 64] })
        };
        // TransferUnit: A da 16 viviendas de P1 a B en un bloque; la 17.ª no cabe.
        let na = k.nonce(&a);
        k.ok((0..16).map(|i| unidad(&a, 21, 1 + i as u16, pb, na + i)).collect());
        assert_eq!(k.st.viviendas_ajenas_de(&pb), MAX_UNIDADES_POR_CUENTA);
        let err = k.falla(vec![unidad(&a, 21, 17, pb, k.nonce(&a))]);
        assert!(err.contains("tope de viviendas por cuenta"), "motivo: {err}");
        // Tampoco desde otra parcela ni de otro dueño.
        assert!(k.falla(vec![unidad(&e, 23, 1, pb, k.nonce(&e))]).contains("tope"));
        // BuyUnit: igual. A pone la 20 en venta; B no puede, C sí.
        k.ok(vec![s(&a, Tx::SellUnit { who: pa, x: 21, y: 45, n: 20, price: COIN, fee: 1, nonce: k.nonce(&a), sig: [0u8; 64] })]);
        let compra = |kp: &KeyPair, x: u16, n: u16, nonce: u64| {
            s(kp, Tx::BuyUnit { who: kp.public_bytes(), x, y: 45, n, max_price: COIN, fee: 1, nonce, sig: [0u8; 64] })
        };
        assert!(k.falla(vec![compra(&b, 21, 20, k.nonce(&b))]).contains("tope"));
        k.ok(vec![compra(&c, 21, 20, k.nonce(&c))]);
        // Devolver una al dueño de la parcela libera hueco: B da la 1 a A y ya
        // cabe la 17 (y el dueño la recibe aunque tenga 47: las suyas no cuentan).
        k.ok(vec![unidad(&b, 21, 1, pa, k.nonce(&b))]);
        assert_eq!(k.st.viviendas_ajenas_de(&pb), 15);
        assert_eq!(k.st.viviendas_ajenas_de(&pa), 0);
        k.ok(vec![unidad(&a, 21, 17, pb, k.nonce(&a))]);
        assert_eq!(k.st.viviendas_ajenas_de(&pb), 16);
        // El dueño de la parcela recompra su vivienda sin tope: C vende la 20 y A la compra.
        k.ok(vec![s(&c, Tx::SellUnit { who: pc, x: 21, y: 45, n: 20, price: COIN, fee: 1, nonce: k.nonce(&c), sig: [0u8; 64] })]);
        k.ok(vec![compra(&a, 21, 20, k.nonce(&a))]);
        assert_eq!(k.st.viviendas_ajenas_de(&pc), 0);
        assert_eq!(k.st.viviendas_ajenas_de(&pa), 0);

        // La compra de la parcela dividida no la bloquea el tope, y no abre
        // una puerta trasera: B (16 ajenas, todas en P1) compra P1. Recibe las
        // 47 de A (de su propia parcela: no cuentan) y sus 16 dejan de ser ajenas.
        k.ok(vec![s(&a, Tx::SellParcel { who: pa, x: 21, y: 45, price: 5 * COIN, fee: 1, nonce: k.nonce(&a), sig: [0u8; 64] })]);
        k.ok(vec![s(&b, Tx::BuyParcel { who: pb, x: 21, y: 45, max_price: 5 * COIN, fee: 1, nonce: k.nonce(&b), sig: [0u8; 64] })]);
        assert!(k.st.parcels[&(21, 45)].units.iter().all(|u| u.owner == pb));
        assert_eq!(k.st.viviendas_ajenas_de(&pb), 0);
        // Ahora B puede tener 16 ajenas en P2 (de E)…
        let ne = k.nonce(&e);
        k.ok((0..16).map(|i| unidad(&e, 23, 1 + i as u16, pb, ne + i)).collect());
        assert_eq!(k.st.viviendas_ajenas_de(&pb), 16);
        assert!(k.falla(vec![unidad(&e, 23, 17, pb, k.nonce(&e))]).contains("tope"));
        // …y si intenta sacar viviendas de P1 a una cuenta suya (C), esa cuenta
        // tiene su propio tope de 16 ajenas.
        let nb = k.nonce(&b);
        k.ok((0..16).map(|i| unidad(&b, 21, 1 + i as u16, pc, nb + i)).collect());
        assert!(k.falla(vec![unidad(&b, 21, 17, pc, k.nonce(&b))]).contains("tope"));
        // Si B vende P1 (a E), todas las viviendas que B tenía en P1 van con
        // ella: B se queda con sus 16 de P2 y nada más.
        k.ok(vec![s(&b, Tx::SellParcel { who: pb, x: 21, y: 45, price: COIN, fee: 1, nonce: k.nonce(&b), sig: [0u8; 64] })]);
        k.ok(vec![s(&e, Tx::BuyParcel { who: pe, x: 21, y: 45, max_price: COIN, fee: 1, nonce: k.nonce(&e), sig: [0u8; 64] })]);
        let p1 = &k.st.parcels[&(21, 45)];
        assert_eq!(p1.units.iter().filter(|u| u.owner == pe).count(), 48);
        assert_eq!(p1.units.iter().filter(|u| u.owner == pc).count(), 16);
        assert_eq!(p1.units.iter().filter(|u| u.owner == pb).count(), 0);
        assert_eq!(k.st.viviendas_ajenas_de(&pb), 16);
        assert_eq!(k.st.viviendas_ajenas_de(&pc), 16);
        // E es ahora dueña de P1 y de P2: sus 16 de P2 en manos de B siguen
        // siendo ajenas para B, y ninguna de las suyas cuenta para ella.
        assert_eq!(k.st.viviendas_ajenas_de(&pe), 0);
    }

    /// Antes de la activación (o sin Dubái) ninguna de las cuatro vale: ni en
    /// la forma ni en el estado. El bloque que las lleve es inválido.
    #[test]
    fn vivienda_antes_de_la_activacion_el_bloque_es_invalido() {
        let net = [0x52u8; 32];
        let a = KeyPair::from_secret(&[81u8; 32]);
        let pa = a.public_bytes();
        let solo_dubai = FirmaCtx::v2(net).con_dubai(true);
        let sin_dubai = FirmaCtx::v2(net).con_vivienda(true);
        let con = FirmaCtx::v2(net).con_dubai(true).con_vivienda(true);
        let mut k = Cadena::nueva(pa, solo_dubai);
        k.ok(vec![signed_con(&a, &solo_dubai, Tx::ClaimParcel { who: pa, x: 21, y: 45, name: b"Casa".to_vec(), kind: 7, fee: 1, nonce: 0, sig: [0u8; 64] })]);
        let divide = signed_con(&a, &con, Tx::DivideParcel { who: pa, x: 21, y: 45, unidades: 2, fee: 1, nonce: 1, sig: [0u8; 64] });
        for ctx in [solo_dubai, sin_dubai] {
            assert!(verify_tx_con(&divide, &ctx).unwrap_err().contains("antes de su activación"));
        }
        assert!(k.falla(vec![divide.clone()]).contains("antes de su activación"));
        // apply_tx por sí solo (mempool) también se niega sin la regla.
        let mut st = k.st.clone();
        let err = apply_tx(&mut st, &divide, k.h + 1, 1, &txid(&divide), &solo_dubai).unwrap_err();
        assert!(err.contains("no rige"), "motivo: {err}");
        assert_eq!(st.nonce_of(&pa), 1, "el rechazo no consume el nonce");
        // Con la regla, el mismo bloque vale.
        k.ctx = con;
        k.ok(vec![divide]);
        assert_eq!(k.st.parcels[&(21, 45)].unidades, 2);
    }

    /// Un rechazo de vivienda no deja nada a medias: ni nonce, ni saldo, ni
    /// contadores (el candidato del minero sigue usando la copia).
    #[test]
    fn vivienda_un_rechazo_no_deja_nada_a_medias() {
        let ctx = ctx_vivienda();
        let a = KeyPair::from_secret(&[91u8; 32]);
        let b = KeyPair::from_secret(&[92u8; 32]);
        let (pa, pb) = (a.public_bytes(), b.public_bytes());
        let mut k = Cadena::nueva(pa, ctx);
        let s = |kp: &KeyPair, tx: Tx| signed_con(kp, &ctx, tx);
        k.ok(vec![
            s(&a, Tx::ClaimParcel { who: pa, x: 21, y: 45, name: b"Casa".to_vec(), kind: 7, fee: 1, nonce: 0, sig: [0u8; 64] }),
            s(&a, Tx::Transfer { from: pa, to: pb, amount: COIN, fee: 1, nonce: 1, sig: [0u8; 64] }),
        ]);
        k.ok(vec![
            s(&a, Tx::DivideParcel { who: pa, x: 21, y: 45, unidades: 3, fee: 1, nonce: 2, sig: [0u8; 64] }),
            s(&a, Tx::SellUnit { who: pa, x: 21, y: 45, n: 1, price: 50 * COIN, fee: 1, nonce: 3, sig: [0u8; 64] }),
        ]);
        let antes = k.st.clone();
        // B no tiene 50 RAMI: la compra falla por saldo, DESPUÉS de todas las
        // demás comprobaciones, y el estado de prueba queda intacto.
        let caro = s(&b, Tx::BuyUnit { who: pb, x: 21, y: 45, n: 1, max_price: 50 * COIN, fee: 1, nonce: 0, sig: [0u8; 64] });
        let mut sim = k.st.clone();
        assert!(apply_tx(&mut sim, &caro, k.h + 1, 1, &txid(&caro), &ctx).unwrap_err().contains("saldo insuficiente"));
        assert_eq!(sim.nonce_of(&pb), antes.nonce_of(&pb));
        assert_eq!(sim.balance_of(&pb), antes.balance_of(&pb));
        assert_eq!(sim.parcels, antes.parcels);
        assert_eq!(sim.viviendas_ajenas, antes.viviendas_ajenas);
        // Y la siguiente de B (nonce 0) sigue aplicando sobre esa copia.
        let barata = s(&b, Tx::TransferUnit { from: pb, x: 21, y: 45, n: 2, to: pa, fee: 1, nonce: 0, sig: [0u8; 64] });
        assert!(apply_tx(&mut sim, &barata, k.h + 1, 2, &txid(&barata), &ctx).unwrap_err().contains("no eres el dueño"));
        assert_eq!(sim.nonce_of(&pb), 0);
    }

    /// Foto determinista de TODO el estado (los HashMap, ordenados).
    fn foto(st: &State) -> String {
        let mut cuentas: Vec<String> = st.accounts.iter().map(|(k, a)| format!("{}:{a:?}", hex::encode(k))).collect();
        cuentas.sort();
        let mut commits: Vec<String> = st.commits.iter().map(|(k, v)| format!("{k:?}{v:?}")).collect();
        commits.sort();
        let mut compromisos: Vec<String> = st.commit_commitment.iter().map(|(k, v)| format!("{k:?}{v:?}")).collect();
        compromisos.sort();
        let mut revelados: Vec<String> = st.revealed.iter().map(|k| format!("{k:?}")).collect();
        revelados.sort();
        format!(
            "{cuentas:?}|{:?}|{:?}|{commits:?}|{compromisos:?}|{revelados:?}|{}|{}|{}|{:?}|{:?}|{:?}|{:?}|{:?}",
            st.parcels, st.assets, st.height, st.city_fund, st.quemado, st.trades, st.profiles, st.handles, st.nodes, st.viviendas_ajenas
        )
    }

    /// El candidato y el mempool del nodo encadenan transacciones sobre una
    /// copia del estado. Los tipos anteriores a la v0.11.0 que suben el nonce,
    /// cobran la comisión o queman ANTES de fallar dejan rastro con `apply_tx`
    /// (y la siguiente tx del firmante entraba en un bloque inválido);
    /// `apply_tx_sin_rastro` no deja ninguno, en ningún tipo. Los cuatro de
    /// vivienda no dejan rastro ni siquiera con `apply_tx`.
    #[test]
    fn un_rechazo_sin_rastro_en_los_tipos_que_mutan_antes_de_fallar() {
        let ctx = ctx_vivienda();
        let a = KeyPair::from_secret(&[93u8; 32]);
        let b = KeyPair::from_secret(&[94u8; 32]);
        let (pa, pb) = (a.public_bytes(), b.public_bytes());
        let mut k = Cadena::nueva(pa, ctx);
        let s = |kp: &KeyPair, tx: Tx| signed_con(kp, &ctx, tx);
        let acunado = s(&a, Tx::MintAsset { who: pa, x: 21, y: 45, kind: 1, meta: b"banco".to_vec(), fee: 1, nonce: 1, sig: [0u8; 64] });
        let activo = txid(&acunado);
        k.ok(vec![
            s(&a, Tx::ClaimParcel { who: pa, x: 21, y: 45, name: b"Casa".to_vec(), kind: 7, fee: 1, nonce: 0, sig: [0u8; 64] }),
            acunado,
            s(&a, Tx::Transfer { from: pa, to: pb, amount: 3 * COIN, fee: 1, nonce: 2, sig: [0u8; 64] }),
        ]);
        k.ok(vec![
            s(&a, Tx::DivideParcel { who: pa, x: 21, y: 45, unidades: 3, fee: 1, nonce: 3, sig: [0u8; 64] }),
            s(&a, Tx::TransferUnit { from: pa, x: 21, y: 45, n: 2, to: pb, fee: 1, nonce: 4, sig: [0u8; 64] }),
        ]);
        // B: 3 RAMI, nonce 0, dueña de la vivienda 2. Cada una de estas pasa
        // el nonce y falla después (algunas, también tras cobrar o quemar).
        let z = [0u8; 64];
        let n = 0;
        let mutan = vec![
            ("Transfer sin saldo", Tx::Transfer { from: pb, to: pa, amount: 99 * COIN, fee: 1, nonce: n, sig: z }),
            ("Stake sin saldo", Tx::Stake { who: pb, amount: 99 * COIN, fee: 1, nonce: n, sig: z }),
            ("Unstake de más", Tx::Unstake { who: pb, amount: COIN, fee: 1, nonce: n, sig: z }),
            ("Reveal sin commit", Tx::Reveal { by: pb, commit_txid: [7u8; 32], payload: b"{}".to_vec(), secret: vec![1], fee: 1, nonce: n, sig: z }),
            ("ClaimParcel ajena", Tx::ClaimParcel { who: pb, x: 21, y: 45, name: b"Mia".to_vec(), kind: 7, fee: 1, nonce: n, sig: z }),
            ("MintAsset en parcela ajena", Tx::MintAsset { who: pb, x: 22, y: 45, kind: 1, meta: b"x".to_vec(), fee: 1, nonce: n, sig: z }),
            ("MintAsset con meta no UTF-8", Tx::MintAsset { who: pb, x: 21, y: 45, kind: 1, meta: vec![0xff, 0xfe], fee: 1, nonce: n, sig: z }),
            ("TransferAsset ajeno", Tx::TransferAsset { from: pb, asset: activo, to: pa, fee: 1, nonce: n, sig: z }),
            ("ListLease ajeno", Tx::ListLease { who: pb, asset: activo, price: 1, term: 10, fee: 1, nonce: n, sig: z }),
            ("Rent sin oferta", Tx::Rent { who: pb, asset: activo, fee: 1, nonce: n, sig: z }),
            ("Harvest ajena", Tx::Harvest { who: pb, x: 21, y: 45, total: COIN, fee: 1, nonce: n, sig: z }),
            ("SellAsset ajeno", Tx::SellAsset { who: pb, asset: activo, price: COIN, fee: 1, nonce: n, sig: z }),
            ("BuyAsset sin venta", Tx::BuyAsset { who: pb, asset: activo, max_price: COIN, fee: 1, nonce: n, sig: z }),
            ("SellParcel ajena", Tx::SellParcel { who: pb, x: 21, y: 45, price: COIN, fee: 1, nonce: n, sig: z }),
            ("BuyParcel sin venta", Tx::BuyParcel { who: pb, x: 21, y: 45, max_price: COIN, fee: 1, nonce: n, sig: z }),
            ("Commit sin saldo para la comisión", Tx::Commit { by: pb, commitment: [3u8; 32], fee: 99 * COIN, nonce: n, sig: z }),
            (
                "SetProfile sin saldo para el nombre",
                Tx::SetProfile {
                    who: pb,
                    handle: b"beatriz".to_vec(),
                    display: Vec::new(),
                    bio: Vec::new(),
                    avatar: 0,
                    color: 0,
                    node_pk: [0u8; 32],
                    node_sig: [0u8; 64],
                    fee: 2 * COIN,
                    nonce: n,
                    sig: z,
                },
            ),
        ];
        let antes = foto(&k.st);
        let h = k.h + 1;
        for (caso, tx) in &mutan {
            let mut sim = k.st.clone();
            assert!(apply_tx(&mut sim, tx, h, 1, &txid(tx), &ctx).is_err(), "{caso} tenía que fallar");
            assert_ne!(foto(&sim), antes, "{caso}: apply_tx deja rastro (por eso existe apply_tx_sin_rastro)");
            let mut sim = k.st.clone();
            assert!(apply_tx_sin_rastro(&mut sim, tx, h, 1, &txid(tx), &ctx).is_err(), "{caso}");
            assert_eq!(foto(&sim), antes, "{caso}: apply_tx_sin_rastro dejó rastro");
        }
        // La que quema antes de fallar: con apply_tx, el precio del acuñado
        // queda sumado a lo quemado; sin rastro, no.
        let (_, meta_mala) = &mutan[6];
        let mut sim = k.st.clone();
        let _ = apply_tx(&mut sim, meta_mala, h, 1, &txid(meta_mala), &ctx);
        assert!(sim.quemado > k.st.quemado);
        // Los cuatro de vivienda lo comprueban todo antes de mutar.
        let vivienda = vec![
            ("DivideParcel ajena", Tx::DivideParcel { who: pb, x: 21, y: 45, unidades: 4, fee: 1, nonce: n, sig: z }),
            ("TransferUnit ajena", Tx::TransferUnit { from: pb, x: 21, y: 45, n: 1, to: pa, fee: 1, nonce: n, sig: z }),
            ("SellUnit ajena", Tx::SellUnit { who: pb, x: 21, y: 45, n: 3, price: COIN, fee: 1, nonce: n, sig: z }),
            ("BuyUnit sin venta", Tx::BuyUnit { who: pb, x: 21, y: 45, n: 1, max_price: COIN, fee: 1, nonce: n, sig: z }),
        ];
        for (caso, tx) in &vivienda {
            let mut sim = k.st.clone();
            assert!(apply_tx(&mut sim, tx, h, 1, &txid(tx), &ctx).is_err(), "{caso} tenía que fallar");
            assert_eq!(foto(&sim), antes, "{caso}: una tx de vivienda dejó rastro con apply_tx");
        }
        // Y una que vale sigue valiendo igual por los dos caminos.
        let buena = Tx::SellUnit { who: pb, x: 21, y: 45, n: 2, price: COIN, fee: 1, nonce: n, sig: z };
        let (mut x1, mut x2) = (k.st.clone(), k.st.clone());
        apply_tx(&mut x1, &buena, h, 1, &txid(&buena), &ctx).unwrap();
        apply_tx_sin_rastro(&mut x2, &buena, h, 1, &txid(&buena), &ctx).unwrap();
        assert_eq!(foto(&x1), foto(&x2));
        assert_ne!(foto(&x1), antes);
    }
}
