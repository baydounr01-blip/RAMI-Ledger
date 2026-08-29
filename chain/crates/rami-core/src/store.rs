//! Persistencia en disco de la cadena (chain.jsonl: un bloque JSON por línea) y
//! reconstrucción del árbol de bloques verificándolo. Compartido por nodo y
//! wallet para que ambos lean exactamente los mismos bytes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::block::Block;
use crate::blocktree::BlockTree;
use crate::params::Params;

pub struct ChainDir {
    pub root: PathBuf,
}

impl ChainDir {
    pub fn new<P: AsRef<Path>>(root: P) -> Self {
        ChainDir { root: root.as_ref().to_path_buf() }
    }
    pub fn chain_path(&self) -> PathBuf {
        self.root.join("chain.jsonl")
    }
    pub fn genesis_path(&self) -> PathBuf {
        self.root.join("genesis.json")
    }
    pub fn mempool_path(&self) -> PathBuf {
        self.root.join("mempool.jsonl")
    }

    pub fn exists(&self) -> bool {
        self.chain_path().exists()
    }

    /// Carga todos los bloques (en el orden en que se escribieron).
    pub fn load_blocks(&self) -> Result<Vec<Block>, String> {
        let text = fs::read_to_string(self.chain_path())
            .map_err(|e| format!("no se pudo leer chain.jsonl: {e}"))?;
        let mut blocks = Vec::new();
        for (i, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let b: Block = serde_json::from_str(line)
                .map_err(|e| format!("línea {}: bloque JSON inválido: {e}", i + 1))?;
            blocks.push(b);
        }
        Ok(blocks)
    }

    /// Reconstruye y VERIFICA el árbol desde disco (todos los bloques se re-admiten
    /// con enlace + PoW + bits-LWMA + transición de estado).
    pub fn load_tree(&self, params: Params) -> Result<BlockTree, String> {
        let blocks = self.load_blocks()?;
        let mut it = blocks.into_iter();
        let genesis = it.next().ok_or("cadena vacía")?;
        let mut tree = BlockTree::new(genesis, params)?;
        for b in it {
            tree.insert(b)?;
        }
        Ok(tree)
    }

    /// Escribe el bloque génesis y arranca chain.jsonl.
    pub fn init(&self, genesis: &Block) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        if self.exists() {
            return Err("la cadena ya existe; no se sobrescribe".into());
        }
        let line = serde_json::to_string(genesis).map_err(|e| e.to_string())?;
        fs::write(self.chain_path(), format!("{line}\n")).map_err(|e| e.to_string())?;
        fs::write(self.genesis_path(), serde_json::to_string_pretty(genesis).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Añade un bloque a chain.jsonl (append atómico por línea).
    pub fn append_block(&self, block: &Block) -> Result<(), String> {
        let line = serde_json::to_string(block).map_err(|e| e.to_string())?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.chain_path())
            .map_err(|e| e.to_string())?;
        f.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Lee el mempool (transacciones pendientes).
    pub fn load_mempool(&self) -> Vec<crate::tx::Tx> {
        let Ok(text) = fs::read_to_string(self.mempool_path()) else {
            return Vec::new();
        };
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    pub fn append_mempool(&self, tx: &crate::tx::Tx) -> Result<(), String> {
        let line = serde_json::to_string(tx).map_err(|e| e.to_string())?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.mempool_path())
            .map_err(|e| e.to_string())?;
        f.write_all(format!("{line}\n").as_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_mempool(&self) -> Result<(), String> {
        if self.mempool_path().exists() {
            fs::write(self.mempool_path(), "").map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
