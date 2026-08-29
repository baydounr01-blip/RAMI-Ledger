//! Capa de compromiso RAMI (commit-reveal), puerto fiel de la referencia
//! Python. Independiente del consenso de la cadena de bloques: permite
//! publicar sha256(canon(señal) ‖ nonce) ANTES de un hecho y revelarlo
//! después, de modo que nadie pueda ajustar un historial a posteriori.
//!
//! Los hashes coinciden byte a byte con `reference/rami_ledger.py`, por lo que
//! un `chain.jsonl` producido por el Python se verifica aquí y viceversa.

use serde_json::Value;

use crate::canon::canon;
use crate::crypto::verify as ed_verify;
use crate::hashing::sha256;

/// Hash hex de SHA-256 (la referencia usa sha256 hex, no sha256d, en la capa
/// de compromiso).
fn sha256_hex(data: &[u8]) -> String {
    hex::encode(sha256(data))
}

/// commit = sha256(canon(signal).utf8 ‖ nonce_bytes), en hex.
pub fn commit_hash(signal: &Value, nonce_hex: &str) -> Result<String, String> {
    let mut buf = canon(signal)?.into_bytes();
    let nonce = hex::decode(nonce_hex).map_err(|_| "nonce no es hex".to_string())?;
    buf.extend_from_slice(&nonce);
    Ok(sha256_hex(&buf))
}

/// Hoja de reveal = sha256(canon(objeto_reveal)), en hex.
pub fn reveal_leaf(reveal: &Value) -> Result<String, String> {
    Ok(sha256_hex(canon(reveal)?.as_bytes()))
}

/// Raíz de Merkle sobre hojas dadas en hex (SHA-256 simple por nivel, como la
/// referencia de la capa de compromiso). Vacío -> sha256("").
pub fn merkle_root_hex(leaves_hex: &[String]) -> Result<String, String> {
    if leaves_hex.is_empty() {
        return Ok(sha256_hex(b""));
    }
    let mut level: Vec<[u8; 32]> = Vec::with_capacity(leaves_hex.len());
    for h in leaves_hex {
        let bytes = hex::decode(h).map_err(|_| "hoja no es hex".to_string())?;
        if bytes.len() != 32 {
            return Err("hoja no mide 32 bytes".into());
        }
        let mut a = [0u8; 32];
        a.copy_from_slice(&bytes);
        level.push(a);
    }
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(*level.last().unwrap());
        }
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(&pair[0]);
            buf[32..].copy_from_slice(&pair[1]);
            next.push(sha256(&buf)); // SHA-256 simple: espejo del Python de la capa commit
        }
        level = next;
    }
    Ok(hex::encode(level[0]))
}

/// Hash de bloque de la capa de compromiso = sha256(canon(bloque sin hash/sig)).
pub fn block_hash(block: &Value) -> Result<String, String> {
    let obj = block.as_object().ok_or("bloque no es objeto")?;
    let filtered: serde_json::Map<String, Value> = obj
        .iter()
        .filter(|(k, _)| k.as_str() != "hash" && k.as_str() != "sig")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    Ok(sha256_hex(canon(&Value::Object(filtered))?.as_bytes()))
}

/// Resultado de verificar una cadena RAMI de la capa de compromiso.
#[derive(Debug, Default)]
pub struct LedgerVerdict {
    pub errors: Vec<String>,
    pub committed: usize,
    pub revealed: usize,
}

impl LedgerVerdict {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

/// Verifica una cadena de compromiso RAMI (lista de bloques JSON), replicando
/// las reglas de `verify_chain` en Python: enlaces, merkle, firma Ed25519 del
/// génesis-pubkey, no doble-commit, reveal en bloque estrictamente posterior,
/// y que la señal revelada reproduce su commit.
pub fn verify_ledger(chain: &[Value]) -> LedgerVerdict {
    let mut v = LedgerVerdict::default();
    if chain.is_empty() {
        v.errors.push("cadena vacía".into());
        return v;
    }
    let pk_hex = chain[0].get("pubkey").and_then(|p| p.as_str());
    let Some(pk_hex) = pk_hex else {
        v.errors.push("génesis sin pubkey".into());
        return v;
    };
    let Ok(pk_vec) = hex::decode(pk_hex) else {
        v.errors.push("pubkey del génesis no es hex".into());
        return v;
    };
    if pk_vec.len() != 32 {
        v.errors.push("pubkey del génesis no mide 32 bytes".into());
        return v;
    }
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&pk_vec);

    let genesis_prev = "0".repeat(64);
    let mut prev_hash = genesis_prev;
    let mut prev_ts = String::new();
    // commit -> altura donde se comprometió
    let mut seen: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut revealed: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (i, b) in chain.iter().enumerate() {
        let tag = format!("#{}", b.get("height").and_then(|h| h.as_i64()).unwrap_or(-1));
        let height = b.get("height").and_then(|h| h.as_i64()).unwrap_or(-1);
        if height != i as i64 {
            v.errors.push(format!("{tag}: altura fuera de secuencia (esperada {i})"));
        }
        if b.get("prev").and_then(|p| p.as_str()) != Some(prev_hash.as_str()) {
            v.errors.push(format!("{tag}: prev no enlaza con el bloque anterior"));
        }
        let ts = b.get("ts").and_then(|t| t.as_str()).unwrap_or("");
        if ts < prev_ts.as_str() {
            v.errors.push(format!("{tag}: timestamp retrocede"));
        }
        if i > 0 && b.get("pubkey").is_some() {
            v.errors.push(format!("{tag}: pubkey solo se permite en génesis"));
        }

        let empty: Vec<Value> = Vec::new();
        let commits: Vec<&str> = b
            .get("commits").and_then(|c| c.as_array()).unwrap_or(&empty)
            .iter().filter_map(|c| c.as_str()).collect();
        let reveals: &Vec<Value> = b.get("reveals").and_then(|r| r.as_array()).unwrap_or(&empty);

        // merkle
        let mut leaves: Vec<String> = commits.iter().map(|s| s.to_string()).collect();
        for r in reveals {
            match reveal_leaf(r) {
                Ok(l) => leaves.push(l),
                Err(_) => v.errors.push(format!("{tag}: reveal malformado")),
            }
        }
        match merkle_root_hex(&leaves) {
            Ok(root) => {
                if b.get("merkle_root").and_then(|m| m.as_str()) != Some(root.as_str()) {
                    v.errors.push(format!("{tag}: merkle_root incorrecto"));
                }
            }
            Err(e) => v.errors.push(format!("{tag}: merkle: {e}")),
        }

        // hash + firma
        match block_hash(b) {
            Ok(hh) => {
                if b.get("hash").and_then(|h| h.as_str()) != Some(hh.as_str()) {
                    v.errors.push(format!("{tag}: hash incorrecto"));
                }
                let sig_ok = (|| {
                    let sig_hex = b.get("sig").and_then(|s| s.as_str())?;
                    let sig_vec = hex::decode(sig_hex).ok()?;
                    if sig_vec.len() != 64 {
                        return Some(false);
                    }
                    let mut sig = [0u8; 64];
                    sig.copy_from_slice(&sig_vec);
                    let hash_vec = hex::decode(hh.as_str()).ok()?;
                    Some(ed_verify(&pk, &hash_vec, &sig))
                })().unwrap_or(false);
                if !sig_ok {
                    v.errors.push(format!("{tag}: firma inválida"));
                }
            }
            Err(e) => v.errors.push(format!("{tag}: {e}")),
        }

        for c in &commits {
            if seen.contains_key(*c) {
                v.errors.push(format!("{tag}: commit duplicado {}…", &c[..12.min(c.len())]));
            }
            seen.insert(c.to_string(), height);
        }
        for r in reveals {
            let c = r.get("commit").and_then(|c| c.as_str()).unwrap_or("");
            match seen.get(c) {
                None => v.errors.push(format!("{tag}: reveal de commit inexistente {}…", &c[..12.min(c.len())])),
                Some(&ch) if ch >= i as i64 => {
                    v.errors.push(format!("{tag}: reveal antes o en el mismo bloque que el commit"))
                }
                Some(&ch) => {
                    if r.get("height").and_then(|h| h.as_i64()) != Some(ch) {
                        v.errors.push(format!("{tag}: altura de commit incorrecta en reveal"));
                    }
                }
            }
            if revealed.contains(c) {
                v.errors.push(format!("{tag}: doble reveal {}…", &c[..12.min(c.len())]));
            }
            revealed.insert(c.to_string());
            match (r.get("signal"), r.get("nonce").and_then(|n| n.as_str())) {
                (Some(signal), Some(nonce)) => match commit_hash(signal, nonce) {
                    Ok(ch) if ch == c => {}
                    Ok(_) => v.errors.push(format!(
                        "{tag}: la señal revelada NO coincide con el commit {}…",
                        &c[..12.min(c.len())]
                    )),
                    Err(_) => v.errors.push(format!("{tag}: reveal malformado")),
                },
                _ => v.errors.push(format!("{tag}: reveal malformado")),
            }
        }

        prev_hash = b.get("hash").and_then(|h| h.as_str()).unwrap_or("").to_string();
        prev_ts = ts.to_string();
    }

    v.committed = seen.len();
    v.revealed = revealed.len();
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commit_hash_matches_python_reference() {
        let sig = json!({"pair":"BTC","dir":"LONG","z":2.0});
        let nonce = "00".repeat(32);
        // Valor capturado de reference/rami_ledger.py (RAMI_FORCE_PY=1).
        assert_eq!(
            commit_hash(&sig, &nonce).unwrap(),
            "107a3366fe9633b88c49a21c63ddc9655ec878fca2671be19155a8969e545603"
        );
    }

    #[test]
    fn reveal_leaf_matches_python_reference() {
        let rev = json!({"commit":"ab","height":1,"nonce":"00".repeat(32),"signal":{"pair":"BTC","dir":"LONG","z":2.0}});
        assert_eq!(
            reveal_leaf(&rev).unwrap(),
            "405868409394a30240b8834605eff335ed6064c7841d0443500755c11ac6c57c"
        );
    }

    #[test]
    fn wrong_signal_fails_commit_check() {
        let sig = json!({"pair":"BTC","dir":"LONG","z":2.0});
        let nonce = "00".repeat(32);
        let c = commit_hash(&sig, &nonce).unwrap();
        let tampered = json!({"pair":"BTC","dir":"SHORT","z":2.0}); // cambiado a posteriori
        assert_ne!(commit_hash(&tampered, &nonce).unwrap(), c);
    }
}
