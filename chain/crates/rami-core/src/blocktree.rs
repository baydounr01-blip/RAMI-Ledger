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
use crate::state::{apply_block, State};
use crate::tiebreak::canonical_tip_order;

pub struct BlockNode {
    pub block: Block,
    pub cum_work: u128,
}

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
        apply_block(&mut state, &genesis, 0)?;
        let cum_work = difficulty_from_bits(genesis.header.bits);

        let mut nodes = HashMap::new();
        nodes.insert(h, BlockNode { block: genesis, cum_work });
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

    /// Reproduce el estado a lo largo de la rama que termina en `h` (para puntas
    /// de las que no guardamos estado, p. ej. al bifurcar en un bloque interior).
    fn replay_state(&self, h: &Hash) -> Result<State, String> {
        let mut state = State::default();
        for (i, bh) in self.chain_to(h).iter().enumerate() {
            let node = self.nodes.get(bh).ok_or("bloque ausente al reproducir")?;
            apply_block(&mut state, &node.block, i as u64)?;
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
            .ok_or("padre desconocido (no se admiten huérfanos)")?;
        if block.header.height != parent_node.block.header.height + 1 {
            return Err("altura != altura_del_padre + 1".into());
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
        apply_block(&mut parent_state, &block, block.header.height)?;

        let cum_work = parent_node.cum_work + difficulty_from_bits(block.header.bits);

        // Insertar.
        self.nodes.insert(h, BlockNode { block, cum_work });
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
    use crate::state::{block_reward, COIN};
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
