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
    ///
    /// Recuperación de escrituras a medias: si la ÚLTIMA línea no parsea
    /// (apagón o cierre forzado durante un append), se ignora y se sigue con el
    /// prefijo válido — el bloque perdido se re-pedirá a la red. El archivo NO
    /// se modifica. Una línea ilegible en MEDIO sí es corrupción real y aborta.
    ///
    /// v0.11.0: un bloque BIEN FORMADO (JSON con una cabecera de bloque válida
    /// y una lista de transacciones) que no se puede leer porque trae un tipo
    /// de transacción que esta versión no conoce lo escribió una versión
    /// posterior (volver atrás de versión sobre el mismo directorio). No es
    /// corrupción: se salta, se avisa, y sus descendientes quedan huérfanos al
    /// reconstruir el árbol. El nodo se queda en la altura anterior, que es lo
    /// mismo que le pasa por red a un binario que no se actualiza. Hasta la
    /// v0.10.16 esa línea abortaba la carga (docs/VIVIENDA.md, §7).
    pub fn load_blocks(&self) -> Result<Vec<Block>, String> {
        let text = fs::read_to_string(self.chain_path())
            .map_err(|e| format!("no se pudo leer chain.jsonl: {e}"))?;
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let mut blocks = Vec::new();
        let mut de_otra_version = 0usize;
        for (i, line) in lines.iter().enumerate() {
            match serde_json::from_str::<Block>(line) {
                Ok(b) => blocks.push(b),
                Err(_) if es_bloque_de_otra_version(line) => de_otra_version += 1,
                Err(e) if i + 1 == lines.len() => {
                    eprintln!(
                        "[cadena] última línea de chain.jsonl ilegible (escritura interrumpida): {e}; se ignora"
                    );
                }
                Err(e) => return Err(format!("línea {}: bloque JSON inválido: {e}", i + 1)),
            }
        }
        if de_otra_version > 0 {
            eprintln!(
                "[cadena] {de_otra_version} bloque(s) de chain.jsonl con transacciones que esta versión no conoce (los escribió una versión posterior); se ignoran"
            );
        }
        Ok(blocks)
    }

    /// Reconstruye y VERIFICA el árbol desde disco (todos los bloques se re-admiten
    /// con enlace + PoW + bits-LWMA + transición de estado).
    ///
    /// Un bloque que no se re-admite (duplicado, huérfano por una línea perdida,
    /// inválido) se SALTA en vez de brickear el arranque: el árbol se queda con
    /// el subgrafo válido y la sincronización P2P re-pide lo que falte.
    pub fn load_tree(&self, params: Params) -> Result<BlockTree, String> {
        let blocks = self.load_blocks()?;
        let mut it = blocks.into_iter();
        let genesis = it.next().ok_or("cadena vacía")?;
        let mut tree = BlockTree::new(genesis, params)?;
        let mut skipped = 0usize;
        for b in it {
            if tree.insert(b).is_err() {
                skipped += 1;
            }
        }
        if skipped > 0 {
            eprintln!(
                "[cadena] {skipped} bloque(s) de chain.jsonl no se re-admitieron; se re-pedirán a la red"
            );
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

/// ¿Es `line` un bloque bien formado que esta versión no sabe leer? Lo es si
/// es un objeto JSON con una cabecera que se lee como `BlockHeader` y una
/// lista `txs`: lo que falla es una transacción (un tipo desconocido), no el
/// fichero. Basura, JSON truncado o sin cabecera no lo son.
fn es_bloque_de_otra_version(line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return false };
    let (Some(header), Some(txs)) = (v.get("header"), v.get("txs")) else { return false };
    txs.is_array() && serde_json::from_value::<crate::block::BlockHeader>(header.clone()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("rami-store-{tag}-{}", std::process::id()))
    }

    /// Apagón o cierre forzado a mitad de un append: la última línea queda
    /// truncada. El arranque debe RECUPERARSE (prefijo válido), no brickearse.
    #[test]
    fn truncated_tail_recovers() {
        let dir = tmp_dir("tail");
        let _ = fs::remove_dir_all(&dir);
        let chain = ChainDir::new(&dir);
        chain.init(&crate::genesis::testnet_genesis()).unwrap();
        // Simula la escritura interrumpida: media línea JSON al final.
        {
            let mut f = fs::OpenOptions::new().append(true).open(chain.chain_path()).unwrap();
            f.write_all(b"{\"header\":{\"version\":1,\"prev_ha").unwrap();
        }
        let tree = chain.load_tree(Params::testnet()).expect("debe recuperarse del tail truncado");
        assert_eq!(tree.len(), 1); // el génesis sobrevive; lo perdido se re-pide a la red
        // El archivo NO se ha modificado (la recuperación nunca borra datos).
        assert!(fs::read_to_string(chain.chain_path()).unwrap().contains("prev_ha"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Corrupción en MEDIO del archivo: eso sí es un error real y visible.
    #[test]
    fn corrupt_middle_line_errors() {
        let dir = tmp_dir("middle");
        let _ = fs::remove_dir_all(&dir);
        let chain = ChainDir::new(&dir);
        let genesis = crate::genesis::testnet_genesis();
        chain.init(&genesis).unwrap();
        {
            let mut f = fs::OpenOptions::new().append(true).open(chain.chain_path()).unwrap();
            f.write_all(b"basura no json\n").unwrap();
            // y una línea válida detrás para que la basura quede en medio
            f.write_all(format!("{}\n", serde_json::to_string(&genesis).unwrap()).as_bytes()).unwrap();
        }
        assert!(chain.load_blocks().is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Un bloque bien formado con un tipo de transacción que esta versión no
    /// conoce (lo escribió una versión posterior) se salta aunque esté en
    /// MEDIO del fichero; la basura en medio sigue abortando.
    #[test]
    fn bloque_de_una_version_posterior_se_salta_sin_abortar() {
        let dir = tmp_dir("futuro");
        let _ = fs::remove_dir_all(&dir);
        let chain = ChainDir::new(&dir);
        let genesis = crate::genesis::testnet_genesis();
        chain.init(&genesis).unwrap();
        let linea = serde_json::to_string(&genesis).unwrap();
        assert!(linea.contains("\"Coinbase\""));
        let futura = linea.replace("\"Coinbase\"", "\"TxDeUnaVersionPosterior\"");
        assert!(serde_json::from_str::<Block>(&futura).is_err(), "esta versión no la lee");
        assert!(es_bloque_de_otra_version(&futura));
        assert!(!es_bloque_de_otra_version("basura no json"));
        assert!(!es_bloque_de_otra_version("{\"header\":{\"version\":1},\"txs\":[]}"), "cabecera incompleta");
        {
            let mut f = fs::OpenOptions::new().append(true).open(chain.chain_path()).unwrap();
            f.write_all(format!("{futura}\n{linea}\n").as_bytes()).unwrap();
        }
        let bloques = chain.load_blocks().expect("un bloque de otra versión en medio no aborta");
        assert_eq!(bloques.len(), 2, "génesis y su duplicado; el de otra versión, fuera");
        let tree = chain.load_tree(Params::testnet()).unwrap();
        assert_eq!(tree.len(), 1);
        // El fichero no se toca.
        assert!(fs::read_to_string(chain.chain_path()).unwrap().contains("TxDeUnaVersionPosterior"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Una línea DUPLICADA (o un bloque que ya no re-admite) se salta sin
    /// brickear el arranque.
    #[test]
    fn duplicate_line_skipped() {
        let dir = tmp_dir("dup");
        let _ = fs::remove_dir_all(&dir);
        let chain = ChainDir::new(&dir);
        let genesis = crate::genesis::testnet_genesis();
        chain.init(&genesis).unwrap();
        chain.append_block(&genesis).unwrap(); // duplicado
        let tree = chain.load_tree(Params::testnet()).expect("el duplicado no debe brickear");
        assert_eq!(tree.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
