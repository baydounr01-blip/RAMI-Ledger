//! Ayudantes serde para arrays que serde no soporta por defecto (> 32 bytes).
//! Se serializan como cadena hex; solo afecta a almacenamiento/gossip, nunca al
//! encoding binario de consenso.

pub mod b64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 64], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 64], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(&s).map_err(serde::de::Error::custom)?;
        if v.len() != 64 {
            return Err(serde::de::Error::custom("firma no mide 64 bytes"));
        }
        let mut out = [0u8; 64];
        out.copy_from_slice(&v);
        Ok(out)
    }
}
