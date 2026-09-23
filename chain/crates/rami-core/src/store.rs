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
    /// v0.11.0: un bloque BIEN FORMADO que no se puede leer solo porque trae
    /// transacciones de un TIPO que esta versión no conoce lo escribió una
    /// versión posterior (volver atrás de versión sobre el mismo directorio).
    /// No es corrupción: se salta, se avisa, y sus descendientes quedan
    /// huérfanos al reconstruir el árbol. El nodo se queda en la altura
    /// anterior, que es lo mismo que le pasa por red a un binario que no se
    /// actualiza. Hasta la v0.10.16 esa línea abortaba la carga. El criterio
    /// es estricto (`tipos_de_otra_version`): un campo estropeado de un tipo
    /// CONOCIDO, o de la cabecera, sigue abortando (docs/VIVIENDA.md, §7).
    pub fn load_blocks(&self) -> Result<Vec<Block>, String> {
        let text = fs::read_to_string(self.chain_path())
            .map_err(|e| format!("no se pudo leer chain.jsonl: {e}"))?;
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let mut blocks = Vec::new();
        // Bloques de una versión posterior: cuántos, el primero y qué tipos.
        let mut de_otra_version = 0usize;
        let mut primera_linea = 0usize;
        let mut tipos_ajenos: Vec<String> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            match serde_json::from_str::<Block>(line) {
                Ok(b) => blocks.push(b),
                Err(e) => match tipos_de_otra_version(line) {
                    Some(tipos) => {
                        de_otra_version += 1;
                        if primera_linea == 0 {
                            primera_linea = i + 1;
                        }
                        for t in tipos {
                            if !tipos_ajenos.contains(&t) {
                                tipos_ajenos.push(t);
                            }
                        }
                    }
                    None if i + 1 == lines.len() => {
                        eprintln!(
                            "[cadena] última línea de chain.jsonl ilegible (escritura interrumpida): {e}; se ignora"
                        );
                    }
                    None => return Err(format!("línea {}: bloque JSON inválido: {e}", i + 1)),
                },
            }
        }
        if de_otra_version > 0 {
            eprintln!(
                "[cadena] {de_otra_version} bloque(s) de chain.jsonl (el primero en la línea {primera_linea}) traen tipos de transacción que esta versión no conoce ({}): los escribió una versión posterior; se ignoran",
                tipos_ajenos.join(", ")
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

/// Si `line` es un bloque bien formado de una versión POSTERIOR, los tipos de
/// transacción que esta versión no conoce; si es cualquier otra cosa, `None`
/// (y el cargador aborta, como hasta la v0.10.16). Lo es solo si:
///   · es JSON, su cabecera se lee entera como `BlockHeader` y `txs` es una lista;
///   · cada transacción de un tipo CONOCIDO se lee entera como `Tx` (un campo
///     estropeado de un tipo conocido es corrupción, no otra versión);
///   · cada una de las demás tiene la forma de una transacción de otro tipo:
///     un objeto con UNA clave, un nombre de tipo (mayúscula y letras o
///     cifras ASCII, como los de `Tx`) que no está en `Tx`, y un objeto dentro;
///   · y hay al menos una de esas.
/// Lo que se escapa: una corrupción que cambie el NOMBRE de un tipo por otro
/// nombre válido que no existe (p. ej. «Transfxr»). El aviso lo nombra.
fn tipos_de_otra_version(line: &str) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    serde_json::from_value::<crate::block::BlockHeader>(v.get("header")?.clone()).ok()?;
    let conocidos = tipos_de_tx_conocidos();
    let mut ajenos = Vec::new();
    for tx in v.get("txs")?.as_array()? {
        let obj = tx.as_object()?;
        if obj.len() != 1 {
            return None;
        }
        let (nombre, cuerpo) = obj.iter().next()?;
        if conocidos.contains(&nombre.as_str()) {
            serde_json::from_value::<crate::tx::Tx>(tx.clone()).ok()?;
        } else if es_nombre_de_tipo(nombre) && cuerpo.is_object() {
            ajenos.push(nombre.clone());
        } else {
            return None;
        }
    }
    if ajenos.is_empty() {
        None
    } else {
        Some(ajenos)
    }
}

/// Un nombre de variante como los de `Tx`: mayúscula ASCII y después letras
/// o cifras ASCII, hasta 64.
fn es_nombre_de_tipo(s: &str) -> bool {
    s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Los nombres de las variantes de `Tx` que conoce ESTA versión, tal como los
/// escribe serde (etiqueta externa: `{"Transfer": {…}}`). Salen del propio
/// `Deserialize` derivado: un deserializador espía solo anota la lista que
/// serde le pasa a `deserialize_enum` y se retira. No hay una lista escrita a
/// mano que alguien olvide al añadir un tipo.
fn tipos_de_tx_conocidos() -> &'static [&'static str] {
    use serde::de::{self, Visitor};
    struct Espia<'a>(&'a mut &'static [&'static str]);
    impl<'de> serde::Deserializer<'de> for Espia<'_> {
        type Error = de::value::Error;
        fn deserialize_any<V: Visitor<'de>>(self, _: V) -> Result<V::Value, Self::Error> {
            Err(de::Error::custom("espía"))
        }
        fn deserialize_enum<V: Visitor<'de>>(
            self,
            _: &'static str,
            variantes: &'static [&'static str],
            _: V,
        ) -> Result<V::Value, Self::Error> {
            *self.0 = variantes;
            Err(de::Error::custom("espía"))
        }
        serde::forward_to_deserialize_any! {
            bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
            bytes byte_buf option unit unit_struct newtype_struct seq tuple
            tuple_struct map struct identifier ignored_any
        }
    }
    let mut variantes: &'static [&'static str] = &[];
    let _ = <crate::tx::Tx as serde::Deserialize>::deserialize(Espia(&mut variantes));
    variantes
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
        assert_eq!(tipos_de_otra_version(&futura), Some(vec!["TxDeUnaVersionPosterior".to_string()]));
        assert_eq!(tipos_de_otra_version("basura no json"), None);
        assert_eq!(tipos_de_otra_version("{\"header\":{\"version\":1},\"txs\":[]}"), None, "cabecera incompleta");
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

    /// La lista de tipos conocidos sale del `Deserialize` de `Tx`: están los
    /// de siempre y los de vivienda, y ninguno inventado.
    #[test]
    fn tipos_de_tx_conocidos_salen_de_serde() {
        let t = tipos_de_tx_conocidos();
        for nombre in ["Coinbase", "Transfer", "MintAsset", "BuyParcel", "SetProfile", "DivideParcel", "TransferUnit", "SellUnit", "BuyUnit"] {
            assert!(t.contains(&nombre), "falta {nombre} en {t:?}");
        }
        assert!(!t.contains(&"TxDeUnaVersionPosterior"));
        assert!(t.iter().all(|n| es_nombre_de_tipo(n)), "todos los nombres de Tx cumplen es_nombre_de_tipo");
    }

    /// Corrupción en medio del fichero que NO es un bloque de otra versión:
    /// sigue abortando la carga con la línea (la revisión encontró que el
    /// primer criterio, «cabecera legible y lista txs», se tragaba un campo
    /// estropeado de la coinbase y `verify` decía «íntegra»).
    #[test]
    fn corrupcion_en_un_tipo_conocido_sigue_abortando() {
        let genesis = crate::genesis::testnet_genesis();
        let linea = serde_json::to_string(&genesis).unwrap();
        let base: serde_json::Value = serde_json::from_str(&linea).unwrap();
        let cb = base["txs"][0]["Coinbase"].clone();
        let con_txs = |txs: serde_json::Value| {
            let mut v = base.clone();
            v["txs"] = txs;
            v.to_string()
        };
        let mut estropeada = cb.clone();
        estropeada["reward"] = serde_json::json!("corrupto");
        let casos = [
            // Un campo de un tipo conocido con otro tipo de dato.
            ("campo de la coinbase", con_txs(serde_json::json!([{ "Coinbase": estropeada }]))),
            // Un tipo desconocido junto a un conocido estropeado.
            ("mezcla", con_txs(serde_json::json!([{ "TxNueva": cb }, { "Coinbase": estropeada }]))),
            // Nombres que no son de un tipo: espacio, minúscula, vacío.
            ("nombre con espacio", con_txs(serde_json::json!([{ "Coin base": cb }]))),
            ("nombre en minúscula", con_txs(serde_json::json!([{ "coinbase": cb }]))),
            ("nombre vacío", con_txs(serde_json::json!([{ "": cb }]))),
            // Un tipo desconocido sin cuerpo de objeto, o con dos claves.
            ("cuerpo que no es objeto", con_txs(serde_json::json!([{ "TxNueva": 7 }]))),
            ("dos claves", con_txs(serde_json::json!([{ "TxNueva": cb, "Otra": cb }]))),
            // La cabecera estropeada.
            ("cabecera", linea.replacen("\"height\":0", "\"height\":\"cero\"", 1)),
        ];
        let dir = tmp_dir("corrupta");
        for (caso, mala) in casos {
            assert_eq!(tipos_de_otra_version(&mala), None, "{caso} no es de otra versión");
            let _ = fs::remove_dir_all(&dir);
            let chain = ChainDir::new(&dir);
            chain.init(&genesis).unwrap();
            {
                let mut f = fs::OpenOptions::new().append(true).open(chain.chain_path()).unwrap();
                f.write_all(format!("{mala}\n{linea}\n").as_bytes()).unwrap();
            }
            let e = chain.load_blocks().expect_err(caso);
            assert!(e.starts_with("línea 2: bloque JSON inválido"), "{caso}: {e}");
            assert!(chain.load_tree(Params::testnet()).is_err(), "{caso}: verify tiene que fallar");
        }
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
