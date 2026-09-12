//! El árbol de bloques del Universo de Bloques Ramificados: TODO bloque válido
//! se conserva para siempre (pasado, presente y futuro coexisten como el árbol
//! completo). La "realidad del observador" es la rama que elige un fork-choice
//! determinista (heaviest work; empate exacto -> desempate de Collatz). Las ramas
//! hermanas (mismo `prev_hash`) se retienen para auditoría; ninguna se descarta.
//!
//! Admisión de un bloque = enlace + PoW + bits-LWMA correctos + transición de
//! estado válida desde el estado del padre. Por inducción, toda punta admitida es
//! una rama internamente consistente (sin doble gasto). El doble gasto solo se
//! previene DENTRO de la rama del observador, que es justo lo que la teoría dice:
//! el mismo UTXO puede existir en ramas hermanas (realidades distintas).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::block::{Block, Hash, ZERO_HASH};
use crate::params::Params;
use crate::pow::{difficulty_from_bits, lwma_next_bits, meets_target, LWMA_N};
use crate::state::{apply_block_con, State};
use crate::tx::{regla_para, FirmaCtx, Regla};
use crate::tiebreak::canonical_tip_order;

pub struct BlockNode {
    pub block: Block,
    pub cum_work: u128,
    /// La regla de firma v2 rige en este bloque (por su timestamp o porque ya
    /// regía en su padre: una vez activada en una rama, no se vuelve atrás).
    pub firma_v2: bool,
    /// Las reglas de Dubái (`crate::ciudad`) rigen en este bloque; misma
    /// disciplina: por su timestamp o porque ya regían en su padre.
    pub dubai: bool,
}

/// Prefijo inequívoco del error de `insert` cuando falta el padre (huérfano).
/// El nodo lo usa para distinguir «me falta la rama» de «bloque inválido».
pub const ORPHAN_ERR: &str = "huérfano: padre desconocido";

/// ¿Es `err` (de `BlockTree::insert`) el error de padre desconocido?
pub fn is_orphan_err(err: &str) -> bool {
    err.starts_with(ORPHAN_ERR)
}

/// Puntas que viajan en el localizador (las más pesadas): cota para que un
/// universo frondoso no convierta cada `GetBranch` en cientos de KB.
pub const LOCATOR_TIPS: usize = 64;

pub struct BlockTree {
    nodes: HashMap<Hash, BlockNode>,
    children: HashMap<Hash, Vec<Hash>>,
    /// Estado resultante SOLO de las puntas actuales (hojas). O(hojas), no O(árbol).
    tip_state: HashMap<Hash, State>,
    pub genesis: Hash,
    params: Params,
}

/// Resultado de mover la cabeza (reorg auditable, reconstruible porque las ramas
/// perdedoras se conservan).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reorg {
    pub common_ancestor: Hash,
    pub disconnected: Vec<Hash>, // bloques que dejan de estar en la rama observada
    pub connected: Vec<Hash>,    // bloques que pasan a estar en la rama observada
}

impl BlockTree {
    /// Crea el árbol con el bloque génesis. Valida altura 0, prev cero, bits de
    /// génesis, PoW y la transición de estado inicial.
    pub fn new(genesis: Block, params: Params) -> Result<Self, String> {
        if genesis.header.height != 0 {
            return Err("el génesis debe tener altura 0".into());
        }
        if genesis.header.prev_hash != ZERO_HASH {
            return Err("el génesis debe tener prev cero".into());
        }
        if genesis.header.bits != params.genesis_bits {
            return Err("el génesis debe usar los genesis_bits de los parámetros".into());
        }
        let h = genesis.hash();
        if !meets_target(&h, genesis.header.bits) {
            return Err("el génesis no cumple el objetivo de PoW".into());
        }
        let mut state = State::default();
        let firma_v2 = regla_para(params.firma_v2_desde, genesis.header.timestamp) == Regla::V2;
        let dubai = FirmaCtx::dubai_para(params.dubai_desde, genesis.header.timestamp);
        apply_block_con(&mut state, &genesis, 0, &Self::ctx_de(firma_v2, dubai, h))?;
        let cum_work = difficulty_from_bits(genesis.header.bits);

        let mut nodes = HashMap::new();
        nodes.insert(h, BlockNode { block: genesis, cum_work, firma_v2, dubai });
        let mut tip_state = HashMap::new();
        tip_state.insert(h, state);
        Ok(BlockTree { nodes, children: HashMap::new(), tip_state, genesis: h, params })
    }

    pub fn contains(&self, h: &Hash) -> bool {
        self.nodes.contains_key(h)
    }

    pub fn get(&self, h: &Hash) -> Option<&BlockNode> {
        self.nodes.get(h)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Cadena génesis..=`h` (más antiguo primero).
    pub fn chain_to(&self, h: &Hash) -> Vec<Hash> {
        let mut out = Vec::new();
        let mut cur = *h;
        while cur != ZERO_HASH {
            out.push(cur);
            match self.nodes.get(&cur) {
                Some(n) => cur = n.block.header.prev_hash,
                None => break,
            }
        }
        out.reverse();
        out
    }

    /// Ventana LWMA (timestamp, dificultad) de los últimos LWMA_N+1 bloques que
    /// terminan en `parent`, más antiguo primero.
    fn lwma_window(&self, parent: &Hash) -> Vec<(u64, u128)> {
        let mut anc = Vec::new();
        let mut cur = *parent;
        for _ in 0..(LWMA_N as usize + 1) {
            match self.nodes.get(&cur) {
                Some(n) => {
                    anc.push((n.block.header.timestamp, difficulty_from_bits(n.block.header.bits)));
                    if cur == self.genesis {
                        break;
                    }
                    cur = n.block.header.prev_hash;
                }
                None => break,
            }
        }
        anc.reverse();
        anc
    }

    /// Bits esperados para un hijo de `parent` según la regla LWMA.
    pub fn expected_bits(&self, parent: &Hash) -> u32 {
        lwma_next_bits(&self.lwma_window(parent), self.params.min_difficulty)
    }

    fn ctx_de(firma_v2: bool, dubai: bool, net: Hash) -> FirmaCtx {
        FirmaCtx { regla: if firma_v2 { Regla::V2 } else { Regla::V1 }, net, dubai }
    }

    /// ¿Rige la regla v2 para un bloque hijo de `parent` con ese timestamp?
    /// Sí si su timestamp alcanza la fecha de activación O si ya regía en el
    /// padre. Lo segundo es lo que impide que, activada la regla, un minero
    /// ponga un timestamp anterior a la fecha para colar firmas v1 (no hay
    /// cota de timestamp en la cadena): en una rama la regla sólo avanza.
    pub fn firma_v2_sobre(&self, parent: &Hash, timestamp: u64) -> bool {
        let padre_v2 = self.nodes.get(parent).map(|n| n.firma_v2).unwrap_or(false);
        padre_v2 || regla_para(self.params.firma_v2_desde, timestamp) == Regla::V2
    }

    /// ¿Rigen las reglas de Dubái para un hijo de `parent` con ese timestamp?
    /// Igual que la firma v2: por la fecha, o porque ya regían en el padre.
    pub fn dubai_sobre(&self, parent: &Hash, timestamp: u64) -> bool {
        let padre = self.nodes.get(parent).map(|n| n.dubai).unwrap_or(false);
        padre || FirmaCtx::dubai_para(self.params.dubai_desde, timestamp)
    }

    /// Contexto de reglas para un bloque hijo de `parent` con ese timestamp.
    pub fn firma_ctx_sobre(&self, parent: &Hash, timestamp: u64) -> FirmaCtx {
        Self::ctx_de(self.firma_v2_sobre(parent, timestamp), self.dubai_sobre(parent, timestamp), self.genesis)
    }

    /// Contexto de firma que rige para lo que se construya AHORA sobre la
    /// cabeza (mempool, candidato, carteras): red = génesis.
    pub fn firma_ctx(&self, timestamp: u64) -> FirmaCtx {
        self.firma_ctx_sobre(&self.head(), timestamp)
    }

    /// Parámetros de consenso con los que se construyó el árbol.
    pub fn params(&self) -> &Params {
        &self.params
    }

    /// Reproduce el estado a lo largo de la rama que termina en `h` (para puntas
    /// de las que no guardamos estado, p. ej. al bifurcar en un bloque interior).
    fn replay_state(&self, h: &Hash) -> Result<State, String> {
        let mut state = State::default();
        for (i, bh) in self.chain_to(h).iter().enumerate() {
            let node = self.nodes.get(bh).ok_or("bloque ausente al reproducir")?;
            apply_block_con(&mut state, &node.block, i as u64, &Self::ctx_de(node.firma_v2, node.dubai, self.genesis))?;
        }
        Ok(state)
    }

    /// Admite un bloque. Idempotente (si ya está, Ok). Valida enlace, PoW, bits
    /// LWMA y la transición de estado desde el padre.
    pub fn insert(&mut self, block: Block) -> Result<Hash, String> {
        let h = block.hash();
        if self.nodes.contains_key(&h) {
            return Ok(h);
        }
        let parent = block.header.prev_hash;
        let parent_node = self
            .nodes
            .get(&parent)
            .ok_or_else(|| format!("{ORPHAN_ERR} (no se admiten huérfanos)"))?;
        if block.header.height != parent_node.block.header.height + 1 {
            return Err(format!(
                "altura {} incorrecta: la anterior es {}",
                block.header.height, parent_node.block.header.height
            ));
        }
        if !meets_target(&h, block.header.bits) {
            return Err("el bloque no cumple el objetivo de PoW".into());
        }
        let expected = self.expected_bits(&parent);
        if block.header.bits != expected {
            return Err(format!(
                "bits {:#x} != esperado LWMA {:#x}",
                block.header.bits, expected
            ));
        }

        // Estado del padre: de tip_state si es hoja, si no se reproduce.
        let mut parent_state = match self.tip_state.get(&parent) {
            Some(s) => s.clone(),
            None => self.replay_state(&parent)?,
        };
        let firma_v2 = parent_node.firma_v2 || regla_para(self.params.firma_v2_desde, block.header.timestamp) == Regla::V2;
        let dubai = parent_node.dubai || FirmaCtx::dubai_para(self.params.dubai_desde, block.header.timestamp);
        apply_block_con(&mut parent_state, &block, block.header.height, &Self::ctx_de(firma_v2, dubai, self.genesis))?;

        let cum_work = parent_node.cum_work + difficulty_from_bits(block.header.bits);

        // Insertar.
        self.nodes.insert(h, BlockNode { block, cum_work, firma_v2, dubai });
        self.children.entry(parent).or_default().push(h);
        // El padre deja de ser hoja; el hijo pasa a ser hoja.
        self.tip_state.remove(&parent);
        self.tip_state.insert(h, parent_state);
        Ok(h)
    }

    /// Puntas (hojas) actuales.
    pub fn tips(&self) -> Vec<Hash> {
        self.tip_state.keys().copied().collect()
    }

    /// Puntas ordenadas por trabajo acumulado DESCENDENTE (la cabeza primero;
    /// a igual trabajo, por hash para que el orden sea estable).
    pub fn tips_by_work(&self) -> Vec<(Hash, u128)> {
        let mut out: Vec<(Hash, u128)> = self
            .tip_state
            .keys()
            .filter_map(|h| self.nodes.get(h).map(|n| (*h, n.cum_work)))
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        out
    }

    /// Fork-choice determinista: mayor trabajo acumulado; empate EXACTO -> Collatz.
    /// La red neuronal NO participa aquí.
    pub fn head(&self) -> Hash {
        let mut best: Option<(&Hash, u128)> = None;
        // orden estable de puntas para determinismo antes del criterio de trabajo
        let mut tips = self.tips();
        tips.sort();
        for tip in &tips {
            let w = self.nodes[tip].cum_work;
            match best {
                None => best = Some((tips.iter().find(|t| *t == tip).unwrap(), w)),
                Some((bh, bw)) => match w.cmp(&bw) {
                    Ordering::Greater => best = Some((tip_ref(&tips, tip), w)),
                    Ordering::Equal => {
                        // trabajo idéntico -> colapso de coherencia (Collatz)
                        if canonical_tip_order(tip, bh) == Ordering::Less {
                            best = Some((tip_ref(&tips, tip), w));
                        }
                    }
                    Ordering::Less => {}
                },
            }
        }
        best.map(|(h, _)| *h).unwrap_or(self.genesis)
    }

    /// Cadena del observador: génesis..=head.
    pub fn observer_chain(&self) -> Vec<Hash> {
        self.chain_to(&self.head())
    }

    /// Estado de la rama del observador.
    pub fn head_state(&self) -> Result<State, String> {
        let head = self.head();
        match self.tip_state.get(&head) {
            Some(s) => Ok(s.clone()),
            None => self.replay_state(&head),
        }
    }

    /// Localizador para la sincronización del universo de ramas: muestra de
    /// nuestra cadena del observador (los últimos 8 bloques y después huecos que
    /// se duplican), el génesis y las `LOCATOR_TIPS` puntas más pesadas. Sin
    /// duplicados. Un par que reciba esto puede recortar la rama que nos falta
    /// justo donde nuestras realidades se separan de la suya. Si la
    /// bifurcación cae entre dos muestras lejanas, el peticionario avanza con
    /// un cursor (ver `branch_to`): el localizador solo acota el primer lote.
    pub fn locator(&self) -> Vec<Hash> {
        let chain = self.observer_chain();
        let mut out: Vec<Hash> = Vec::new();
        let mut seen: HashSet<Hash> = HashSet::new();
        let n = chain.len();
        let mut dist = 0usize; // distancia a la cabeza
        let mut step = 1usize;
        let mut dense = 0usize;
        while dist < n {
            let h = chain[n - 1 - dist];
            if seen.insert(h) {
                out.push(h);
            }
            dense += 1;
            if dense >= 8 {
                step = step.saturating_mul(2);
            }
            dist = dist.saturating_add(step);
        }
        if seen.insert(self.genesis) {
            out.push(self.genesis);
        }
        for (t, _) in self.tips_by_work().into_iter().take(LOCATOR_TIPS) {
            if seen.insert(t) {
                out.push(t);
            }
        }
        out
    }

    /// Segmento de rama que termina en `tip` y que el peticionario aún no tiene:
    /// retrocede desde `tip` hasta encontrar un hash de `known` (o el génesis,
    /// que todos comparten) y devuelve los bloques en orden ASCENDENTE (el más
    /// antiguo primero), truncado a los `max` MÁS ANTIGUOS. `more == true` si se
    /// truncó: el peticionario admite lo recibido y vuelve a pedir añadiendo a
    /// `known` el último bloque del lote (cursor), de modo que aunque todo el
    /// lote fuera ya conocido la siguiente petición reanuda justo después.
    /// `None` si `tip` no está en el árbol.
    ///
    /// Solo se recorren hashes (32 B por paso); únicamente se clonan los `max`
    /// bloques devueltos, así una petición sobre una rama larga no cuesta
    /// O(longitud) en memoria.
    pub fn branch_to(&self, tip: &Hash, known: &[Hash], max: usize) -> Option<(Vec<Block>, bool)> {
        if !self.nodes.contains_key(tip) {
            return None;
        }
        let known_set: HashSet<Hash> = known.iter().copied().collect();
        let mut path: Vec<Hash> = Vec::new();
        let mut cur = *tip;
        while cur != ZERO_HASH && cur != self.genesis && !known_set.contains(&cur) {
            match self.nodes.get(&cur) {
                Some(n) => {
                    path.push(cur);
                    cur = n.block.header.prev_hash;
                }
                None => break,
            }
        }
        let more = path.len() > max;
        let take = path.len().min(max);
        // los `take` más antiguos son los ÚLTIMOS del recorrido (que va de la punta hacia atrás)
        let segment: Vec<Block> = path[path.len() - take..]
            .iter()
            .rev()
            .filter_map(|h| self.nodes.get(h).map(|n| n.block.clone()))
            .collect();
        Some((segment, more))
    }

    /// Calcula el reorg entre dos cabezas (antigua -> nueva).
    pub fn reorg_between(&self, old: Hash, new: Hash) -> Reorg {
        let old_chain: Vec<Hash> = self.chain_to(&old);
        let new_chain: Vec<Hash> = self.chain_to(&new);
        let old_set: HashSet<Hash> = old_chain.iter().copied().collect();
        let new_set: HashSet<Hash> = new_chain.iter().copied().collect();
        let common = new_chain
            .iter()
            .rev()
            .find(|h| old_set.contains(*h))
            .copied()
            .unwrap_or(self.genesis);
        let disconnected = old_chain.iter().rev().take_while(|h| **h != common).copied().collect();
        let connected: Vec<Hash> =
            new_chain.iter().rev().take_while(|h| **h != common).copied().collect::<Vec<_>>()
                .into_iter().rev().collect();
        let _ = new_set;
        Reorg { common_ancestor: common, disconnected, connected }
    }
}

fn tip_ref<'a>(tips: &'a [Hash], want: &Hash) -> &'a Hash {
    tips.iter().find(|t| *t == want).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::BlockHeader;
    use crate::params::Params;
    use crate::pow::pow_hash;
    use crate::state::block_reward;
    use crate::tx::{merkle_root_txids, txid, Tx, TxId};

    fn mine(mut header: BlockHeader) -> BlockHeader {
        // búsqueda de nonce (dificultad de génesis es fácil)
        loop {
            let h = pow_hash(&header.canonical_bytes());
            if meets_target(&h, header.bits) {
                return header;
            }
            header.nonce += 1;
        }
    }

    fn mined_block(height: u64, prev: Hash, bits: u32, miner: [u8; 32], ts: u64, tag: [u8; 4]) -> Block {
        let txs = vec![Tx::Coinbase { height, to: miner, reward: block_reward(height), memo: vec![] }];
        let ids: Vec<TxId> = txs.iter().map(txid).collect();
        let header = mine(BlockHeader {
            version: 1, prev_hash: prev, height, timestamp: ts,
            merkle_root: merkle_root_txids(&ids), bits, nonce: 0, branch_tag: tag,
        });
        Block { header, txs }
    }

    fn genesis() -> Block {
        let p = Params::regtest();
        mined_block(0, ZERO_HASH, p.genesis_bits, [1u8; 32], 1_700_000_000, *b"gen0")
    }

    #[test]
    fn builds_and_extends_observer_chain() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        let bits1 = tree.expected_bits(&g.hash());
        let b1 = mined_block(1, g.hash(), bits1, [1u8; 32], 1_700_000_060, *b"main");
        tree.insert(b1.clone()).unwrap();
        assert_eq!(tree.head(), b1.hash());
        assert_eq!(tree.observer_chain(), vec![g.hash(), b1.hash()]);
        // el minero cobró dos coinbases
        let st = tree.head_state().unwrap();
        assert_eq!(st.balance_of(&[1u8; 32]), block_reward(0) + block_reward(1));
    }

    #[test]
    fn siblings_are_retained_and_heaviest_wins() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        let bits1 = tree.expected_bits(&g.hash());
        // dos ramas hermanas en altura 1 (mismo prev, distinto tag/timestamp)
        let a = mined_block(1, g.hash(), bits1, [1u8; 32], 1_700_000_060, *b"a__1");
        let b = mined_block(1, g.hash(), bits1, [2u8; 32], 1_700_000_061, *b"b__1");
        tree.insert(a.clone()).unwrap();
        tree.insert(b.clone()).unwrap();
        // ambas conservadas (coexisten)
        assert!(tree.contains(&a.hash()) && tree.contains(&b.hash()));
        assert_eq!(tree.tips().len(), 2);
        // extiende A -> A gana por trabajo acumulado
        let bits2 = tree.expected_bits(&a.hash());
        let a2 = mined_block(2, a.hash(), bits2, [1u8; 32], 1_700_000_120, *b"a__2");
        tree.insert(a2.clone()).unwrap();
        assert_eq!(tree.head(), a2.hash());
        // b sigue existiendo como rama hermana
        assert!(tree.contains(&b.hash()));
    }

    #[test]
    fn equal_work_tie_is_broken_deterministically() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        let bits1 = tree.expected_bits(&g.hash());
        let a = mined_block(1, g.hash(), bits1, [1u8; 32], 1_700_000_060, *b"a__1");
        let b = mined_block(1, g.hash(), bits1, [2u8; 32], 1_700_000_060, *b"b__1");
        tree.insert(a.clone()).unwrap();
        tree.insert(b.clone()).unwrap();
        // igual trabajo (mismos bits) -> el head es determinista y estable
        let h1 = tree.head();
        let h2 = tree.head();
        assert_eq!(h1, h2);
        assert!(h1 == a.hash() || h1 == b.hash());
        // y coincide con el desempate canónico
        let want = if canonical_tip_order(&a.hash(), &b.hash()) == Ordering::Less {
            a.hash()
        } else {
            b.hash()
        };
        assert_eq!(h1, want);
    }

    /// Extiende `prev` con `n` bloques minados por `miner` (tags distintos por
    /// altura); devuelve los hashes en orden ascendente.
    fn extend(tree: &mut BlockTree, prev: Hash, n: usize, miner: [u8; 32], ts0: u64) -> Vec<Hash> {
        let mut out = Vec::new();
        let mut prev = prev;
        for i in 0..n {
            let height = tree.get(&prev).unwrap().block.header.height + 1;
            let bits = tree.expected_bits(&prev);
            let tag = [miner[0], b'_', (i / 10) as u8 + b'0', (i % 10) as u8 + b'0'];
            let b = mined_block(height, prev, bits, miner, ts0 + 60 * (i as u64 + 1), tag);
            prev = tree.insert(b).unwrap();
            out.push(prev);
        }
        out
    }

    #[test]
    fn locator_samples_chain_tips_and_genesis_without_duplicates() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        // árbol con un solo bloque: el génesis aparece UNA vez
        assert_eq!(tree.locator(), vec![g.hash()]);
        // rama principal de 40 bloques + rama hermana corta desde el génesis
        let main = extend(&mut tree, g.hash(), 40, [1u8; 32], 1_700_000_000);
        let side = extend(&mut tree, g.hash(), 2, [2u8; 32], 1_700_100_000);
        assert_eq!(tree.head(), *main.last().unwrap());
        let loc = tree.locator();
        let uniq: HashSet<Hash> = loc.iter().copied().collect();
        assert_eq!(uniq.len(), loc.len(), "el localizador no puede repetir hashes");
        // los últimos 8 bloques de la cabeza están todos
        for h in main.iter().rev().take(8) {
            assert!(loc.contains(h));
        }
        // huecos que se duplican: distancias 9,13,21,37 (desde la cabeza)
        for d in [9usize, 13, 21, 37] {
            assert!(loc.contains(&main[main.len() - 1 - d]), "falta distancia {d}");
        }
        for d in [8usize, 10, 12, 20, 30] {
            assert!(!loc.contains(&main[main.len() - 1 - d]), "sobra distancia {d}");
        }
        // todas las puntas y el génesis, en una lista mucho menor que la cadena
        assert!(loc.contains(side.last().unwrap()));
        assert!(loc.contains(&g.hash()));
        assert!(loc.len() < 20);
    }

    #[test]
    fn branch_to_returns_missing_segment_of_a_fork() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        let a = extend(&mut tree, g.hash(), 3, [1u8; 32], 1_700_000_000);
        let b = extend(&mut tree, a[0], 4, [2u8; 32], 1_700_100_000);
        assert_eq!(tree.tips().len(), 2);
        // el peticionario conoce la rama A entera: de la rama B le faltan sus 4 bloques
        let (seg, more) = tree.branch_to(b.last().unwrap(), &a, 100).unwrap();
        assert!(!more);
        let hashes: Vec<Hash> = seg.iter().map(|x| x.hash()).collect();
        assert_eq!(hashes, b, "orden ascendente, sólo lo que falta");
        // el primer bloque devuelto engancha con algo que el peticionario tiene
        assert_eq!(seg[0].header.prev_hash, a[0]);
        // sólo conoce el génesis: rama A completa
        let (seg, more) = tree.branch_to(a.last().unwrap(), &[g.hash()], 100).unwrap();
        assert!(!more);
        assert_eq!(seg.iter().map(|x| x.hash()).collect::<Vec<_>>(), a);
        // sin localizador alguno: el génesis se asume conocido por todos
        let (seg, _) = tree.branch_to(a.last().unwrap(), &[], 100).unwrap();
        assert_eq!(seg.len(), 3);
        // punta ya conocida: nada que enviar
        let (seg, more) = tree.branch_to(&a[2], &a, 100).unwrap();
        assert!(seg.is_empty() && !more);
        // punta desconocida
        assert!(tree.branch_to(&[0xEE; 32], &a, 100).is_none());
    }

    #[test]
    fn branch_to_truncates_to_oldest_blocks_and_flags_more() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        let a = extend(&mut tree, g.hash(), 7, [1u8; 32], 1_700_000_000);
        let tip = *a.last().unwrap();
        // primer lote: los 3 MÁS ANTIGUOS, con more=true
        let (seg, more) = tree.branch_to(&tip, &[g.hash()], 3).unwrap();
        assert!(more);
        assert_eq!(seg.iter().map(|x| x.hash()).collect::<Vec<_>>(), a[..3].to_vec());
        // el peticionario los admite y vuelve a pedir con localizador fresco
        let (seg, more) = tree.branch_to(&tip, &[a[2], g.hash()], 3).unwrap();
        assert!(more);
        assert_eq!(seg.iter().map(|x| x.hash()).collect::<Vec<_>>(), a[3..6].to_vec());
        let (seg, more) = tree.branch_to(&tip, &[a[5]], 3).unwrap();
        assert!(!more);
        assert_eq!(seg.iter().map(|x| x.hash()).collect::<Vec<_>>(), vec![a[6]]);
        // max exacto: no se marca more
        let (seg, more) = tree.branch_to(&tip, &[], 7).unwrap();
        assert_eq!(seg.len(), 7);
        assert!(!more);
    }

    /// Bifurcación MÁS PROFUNDA que la ventana densa del localizador: el
    /// primer lote son bloques que el peticionario ya tiene, pero añadiendo el
    /// último del lote como cursor la siguiente petición reanuda justo después
    /// y en pocas rondas llega la rama entera (nunca se repite el mismo lote).
    #[test]
    fn deep_fork_advances_with_cursor_instead_of_repeating_batch() {
        let g = genesis();
        let mut server = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        let mut client = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        // tronco común de 60 bloques
        let trunk = extend(&mut server, g.hash(), 60, [1u8; 32], 1_700_000_000);
        for h in &trunk {
            client.insert(server.get(h).unwrap().block.clone()).unwrap();
        }
        // el cliente sigue 140 bloques por su cuenta; el servidor 10 por la suya
        let _mine = extend(&mut client, *trunk.last().unwrap(), 140, [3u8; 32], 1_700_500_000);
        let theirs = extend(&mut server, *trunk.last().unwrap(), 10, [2u8; 32], 1_700_900_000);
        let tip = *theirs.last().unwrap();
        let batch = 50usize;
        let base = client.locator();
        // la bifurcación (altura 60) está a 140 de la cabeza del cliente: fuera
        // de las muestras densas => el primer lote es TODO conocido
        let (seg, more) = server.branch_to(&tip, &base, batch).unwrap();
        assert!(more);
        assert!(seg.iter().all(|b| client.contains(&b.hash())), "primer lote ya conocido");
        // ... y con el MISMO localizador se repetiría: por eso hace falta el cursor
        let (again, _) = server.branch_to(&tip, &base, batch).unwrap();
        assert_eq!(again.iter().map(|b| b.hash()).collect::<Vec<_>>(), seg.iter().map(|b| b.hash()).collect::<Vec<_>>());
        // bucle del peticionario: cursor = último bloque del lote que está en su árbol
        let mut cursor: Option<Hash> = Some(seg.last().unwrap().hash());
        let mut rounds = 1usize;
        let mut last_seen: Option<Vec<Hash>> = None;
        let mut more = more;
        while more {
            let mut known = client.locator();
            known.extend(cursor);
            let (seg, m) = server.branch_to(&tip, &known, batch).unwrap();
            let hashes: Vec<Hash> = seg.iter().map(|b| b.hash()).collect();
            assert_ne!(last_seen.as_ref(), Some(&hashes), "el lote no puede repetirse");
            for b in seg {
                if !client.contains(&b.hash()) {
                    client.insert(b).unwrap();
                }
            }
            cursor = hashes.last().copied();
            last_seen = Some(hashes);
            more = m;
            rounds += 1;
            assert!(rounds < 10, "demasiadas rondas");
        }
        assert!(client.contains(&tip), "la rama lateral llegó entera");
        assert_eq!(client.len(), 1 + 60 + 140 + 10);
        assert_eq!(client.tips().len(), 2);
    }

    #[test]
    fn locator_caps_tips_to_heaviest() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        // muchas ramas hermanas de 1 bloque desde el génesis y una rama larga
        for i in 0..(LOCATOR_TIPS + 20) {
            let bits = tree.expected_bits(&g.hash());
            let b = mined_block(1, g.hash(), bits, [(i % 250) as u8 + 1; 32], 1_700_000_000 + i as u64, [b's', b'i', (i / 100) as u8 + b'0', (i % 100) as u8]);
            tree.insert(b).unwrap();
        }
        let long = extend(&mut tree, g.hash(), 5, [9u8; 32], 1_700_100_000);
        let loc = tree.locator();
        assert!(loc.contains(long.last().unwrap()), "la cabeza va siempre");
        assert!(loc.contains(&g.hash()));
        let by_work = tree.tips_by_work();
        assert_eq!(by_work[0].0, tree.head());
        // como mucho las muestras de la cadena (6) + génesis + LOCATOR_TIPS puntas
        assert!(loc.len() <= 6 + 1 + LOCATOR_TIPS, "localizador sin cota: {}", loc.len());
        assert!(loc.len() >= LOCATOR_TIPS);
        // el error de huérfano se distingue del de altura
        let bits = tree.expected_bits(long.last().unwrap());
        let orphan = mined_block(7, [0xCD; 32], bits, [1u8; 32], 1_700_200_000, *b"orph");
        let err = tree.insert(orphan).unwrap_err();
        assert!(is_orphan_err(&err));
        let wrong_h = mined_block(9, *long.last().unwrap(), bits, [1u8; 32], 1_700_200_000, *b"badh");
        let err = tree.insert(wrong_h).unwrap_err();
        assert!(!is_orphan_err(&err), "altura incorrecta no es huérfano: {err}");
    }

    #[test]
    fn rejects_wrong_pow() {
        let g = genesis();
        let mut tree = BlockTree::new(g.clone(), Params::regtest()).unwrap();
        let bits1 = tree.expected_bits(&g.hash());
        // bloque sin minar (nonce 0, casi seguro no cumple objetivo)
        let txs = vec![Tx::Coinbase { height: 1, to: [1u8; 32], reward: block_reward(1), memo: vec![] }];
        let ids: Vec<TxId> = txs.iter().map(txid).collect();
        let header = BlockHeader {
            version: 1, prev_hash: g.hash(), height: 1, timestamp: 1_700_000_060,
            merkle_root: merkle_root_txids(&ids), bits: bits1, nonce: 0, branch_tag: *b"bad_",
        };
        // por si acaso el nonce 0 cumpliera, forzamos un merkle roto
        let mut bad = Block { header, txs };
        bad.header.merkle_root = [0xAB; 32];
        assert!(tree.insert(bad).is_err());
    }
}
