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
pub const PROTO_VERSION: u32 = 1;

/// Un fotograma del protocolo. Serialización externamente etiquetada:
/// `{"Ping":{"nonce":7}}`, una por línea.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Frame {
    /// Primer mensaje de toda conexión. `net` = network-id (hash de génesis) en
    /// hex; si no coincide con el nuestro, se corta la conexión. `node` desambigua
    /// auto-conexiones y duplicados; `port` es el puerto de escucha anunciado.
    Hello { net: String, node: u64, port: u16, ver: u32 },
    /// Anuncio de punta de cadena tras el handshake (y cuando cambia).
    Status { height: u64, best: String, work: String },
    /// Pide hasta `max` bloques contiguos desde la altura `from` por la cadena
    /// del observador del que responde.
    GetBlocks { from: u64, max: u32 },
    /// Respuesta: bloques por altura ascendente.
    Blocks { blocks: Vec<Block> },
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
            Frame::Status { height: 7, best: "00".repeat(32), work: "123456789".into() },
            Frame::GetBlocks { from: 1, max: 500 },
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
    fn garbage_is_none() {
        assert_eq!(Frame::from_line("no soy json"), None);
        assert_eq!(Frame::from_line("{\"Desconocido\":1}"), None);
    }
}
