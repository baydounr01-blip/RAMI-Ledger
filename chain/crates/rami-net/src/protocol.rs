//! Protocolo de cable de RAMI-Chain: un mensaje = una línea JSON (`\n`).
//!
//! El transporte (ver `lib.rs`) intercepta `Hello` para el handshake y entrega
//! el resto de variantes al nodo. Todo lo que viaja son bloques y transacciones
//! ya definidos en `rami-core`, así que el nodo los revalida con las MISMAS
//! reglas de consenso al recibirlos: la red nunca es una fuente de confianza.

use rami_core::block::Block;
use rami_core::tx::Tx;
use serde::{Deserialize, Serialize};

/// Versión del protocolo P2P. Súbela si cambia el formato de `Frame`.
/// v2: sincronización del universo de ramas (`Tips`/`GetBranch`/`Branch`)
/// en lugar de la lineal por altura (`GetBlocks`/`Blocks`, retirados).
pub const PROTO_VERSION: u32 = 2;

/// Una punta (hoja) del árbol de bloques de un par: hash en hex, altura y
/// trabajo acumulado (u128 en decimal, como texto para no perder precisión).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TipInfo {
    pub hash: String,
    pub height: u64,
    pub work: String,
}

/// Un fotograma del protocolo. Serialización externamente etiquetada:
/// `{"Ping":{"nonce":7}}`, una por línea.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Frame {
    /// Primer mensaje de toda conexión. `net` = network-id (hash de génesis) en
    /// hex; si no coincide con el nuestro, se corta la conexión. `node` desambigua
    /// auto-conexiones y duplicados; `port` es el puerto de escucha anunciado.
    Hello { net: String, node: u64, port: u16, ver: u32 },
    /// Anuncio de punta de cadena tras el handshake (y cuando cambia).
    /// `rule` (v0.8.0): regla de firma más alta que entiende el emisor; los
    /// binarios anteriores no la envían (→ 0) y la ignoran al recibirla.
    Status {
        height: u64,
        best: String,
        work: String,
        #[serde(default)]
        rule: u32,
    },
    /// Anuncio de puntas del árbol (universo de ramas), las más pesadas
    /// primero (la cabeza siempre viaja) y acotado por el emisor. `partial ==
    /// false`: conjunto completo (tras el handshake y como latido periódico),
    /// sustituye lo que el par sabía de nosotros. `partial == true`: solo las
    /// puntas NUEVAS desde el último anuncio (cada bloque aceptado), que el par
    /// suma a las que ya tenía. Un par que vea una punta que no tiene pide su
    /// rama con `GetBranch`.
    Tips { tips: Vec<TipInfo>, partial: bool },
    /// Pide la rama que termina en `tip` (hex): el que responde retrocede desde
    /// `tip` hasta un hash de `known` (localizador del peticionario, o el
    /// génesis) y devuelve hasta `max` bloques, los más antiguos primero.
    GetBranch { tip: String, known: Vec<String>, max: u32 },
    /// Respuesta a `GetBranch`: bloques en orden ascendente; `more` indica que
    /// la rama sigue (el peticionario los admite y vuelve a pedir).
    Branch { tip: String, blocks: Vec<Block>, more: bool },
    /// Retransmite un bloque recién aceptado.
    NewBlock { block: Block },
    /// Retransmite una transacción de mempool.
    NewTx { tx: Tx },
    /// Pide direcciones de otros pares (intercambio de peers).
    GetPeers,
    /// Comparte direcciones `host:puerto` conocidas.
    Peers { addrs: Vec<String> },
    Ping { nonce: u64 },
    Pong { nonce: u64 },
}

impl Frame {
    /// Serializa a una línea (sin `\n`).
    pub fn to_line(&self) -> String {
        // nunca debería fallar: son tipos de datos simples
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
    /// Parsea una línea. Devuelve None si no es un `Frame` válido.
    pub fn from_line(line: &str) -> Option<Frame> {
        serde_json::from_str(line).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_roundtrip() {
        let cases = vec![
            Frame::Hello { net: "ab".repeat(32), node: 42, port: 30301, ver: PROTO_VERSION },
            Frame::Status { height: 7, best: "00".repeat(32), work: "123456789".into(), rule: 2 },
            Frame::Tips {
                tips: vec![
                    TipInfo { hash: "11".repeat(32), height: 7, work: u128::MAX.to_string() },
                    TipInfo { hash: "22".repeat(32), height: 3, work: "5".into() },
                ],
                partial: false,
            },
            Frame::Tips { tips: vec![], partial: true },
            Frame::GetBranch { tip: "11".repeat(32), known: vec!["00".repeat(32), "22".repeat(32)], max: 256 },
            Frame::Branch { tip: "11".repeat(32), blocks: vec![], more: true },
            Frame::GetPeers,
            Frame::Peers { addrs: vec!["1.2.3.4:30301".into()] },
            Frame::Ping { nonce: 99 },
            Frame::Pong { nonce: 99 },
        ];
        for f in cases {
            let line = f.to_line();
            assert!(!line.contains('\n'), "una línea no puede llevar saltos");
            assert_eq!(Frame::from_line(&line), Some(f));
        }
    }

    #[test]
    fn status_rule_es_opcional_en_ambos_sentidos() {
        // Un `Status` de v0.7.x (sin `rule`) se lee como regla 0.
        let viejo = r#"{"Status":{"height":3,"best":"ab","work":"9"}}"#;
        assert_eq!(
            Frame::from_line(viejo),
            Some(Frame::Status { height: 3, best: "ab".into(), work: "9".into(), rule: 0 })
        );
        // Y un `Status` de v0.8.0 (con `rule`) lo lee un enum con la forma
        // de v0.7.x: serde ignora los campos desconocidos.
        #[derive(Debug, PartialEq, serde::Deserialize)]
        enum FrameViejo {
            Status { height: u64, best: String, work: String },
        }
        let nuevo = Frame::Status { height: 3, best: "ab".into(), work: "9".into(), rule: 2 }.to_line();
        let leido: FrameViejo = serde_json::from_str(&nuevo).unwrap();
        assert_eq!(leido, FrameViejo::Status { height: 3, best: "ab".into(), work: "9".into() });
    }

    #[test]
    fn garbage_is_none() {
        assert_eq!(Frame::from_line("no soy json"), None);
        assert_eq!(Frame::from_line("{\"Desconocido\":1}"), None);
        // v1 retirado: la sincronización lineal por altura ya no existe
        assert_eq!(Frame::from_line("{\"GetBlocks\":{\"from\":1,\"max\":5}}"), None);
    }
}
