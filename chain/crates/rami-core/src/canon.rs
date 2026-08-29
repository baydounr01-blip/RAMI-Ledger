//! Canonicalización JSON compatible con la referencia Python (RAMI ledger).
//!
//! Reglas (idénticas a `canon()` en `reference/rami_ledger.py`):
//!   * claves ordenadas alfabéticamente,
//!   * sin espacios entre tokens,
//!   * floats de valor entero y |x| < 2^53  ->  se emiten como enteros,
//!   * `NaN`/`Infinity` prohibidos.
//!
//! IMPORTANTE: esta canonicalización solo se usa en la capa de compromiso
//! (commit/reveal), donde el *payload* es opaco para la cadena. El consenso
//! (bloques y transacciones) usa serialización binaria determinista, de modo
//! que ningún float entra jamás en la validación de consenso. Para el payload,
//! sigue la misma disciplina que la referencia: redondea a 4 decimales y evita
//! magnitudes < 1e-4, porque la representación textual de floats no enteros no
//! está garantizada bit a bit entre lenguajes.

use serde_json::Value;

/// Serializa un `Value` en la forma canónica. Devuelve error si contiene
/// `NaN`/`Infinity` (que romperían la reproducibilidad).
pub fn canon(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    write_canon(value, &mut out)?;
    Ok(out)
}

fn write_canon(value: &Value, out: &mut String) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n, out)?,
        Value::String(s) => write_json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canon(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_canon(&map[*key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_number(n: &serde_json::Number, out: &mut String) -> Result<(), String> {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
        return Ok(());
    }
    if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
        return Ok(());
    }
    let f = n.as_f64().ok_or("número no representable")?;
    if !f.is_finite() {
        return Err("NaN/Infinity prohibidos en canon".into());
    }
    // Float de valor entero -> entero (espejo de `_norm` en Python).
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        out.push_str(&(f as i64).to_string());
    } else {
        // Round-trip más corto (equivalente a repr de Python en la práctica).
        out.push_str(&f.to_string());
    }
    Ok(())
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_sorted_no_spaces() {
        let v = json!({"b": 1, "a": 2});
        assert_eq!(canon(&v).unwrap(), r#"{"a":2,"b":1}"#);
    }

    #[test]
    fn integer_valued_float_becomes_int() {
        // Igual que la referencia Python: 2.0 -> "2".
        let v = json!({"z": 2.0, "dir": "LONG"});
        assert_eq!(canon(&v).unwrap(), r#"{"dir":"LONG","z":2}"#);
    }

    #[test]
    fn nested_and_arrays() {
        let v = json!({"xs": [1, 2.0, 3], "m": {"k": true}});
        assert_eq!(canon(&v).unwrap(), r#"{"m":{"k":true},"xs":[1,2,3]}"#);
    }

    #[test]
    fn non_integer_float_kept() {
        let v = json!({"p": 2.5});
        assert_eq!(canon(&v).unwrap(), r#"{"p":2.5}"#);
    }
}
