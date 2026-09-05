//! Geolocalización de direcciones para la Ciudad RAMI (isla de Tenerife).
//!
//! Usa el servicio público Nominatim de OpenStreetMap SOLO cuando el usuario
//! pulsa «Localizar»: una petición por acción, con User-Agent identificable y
//! como máximo una por segundo (política de uso de Nominatim). No se usa
//! Google Maps: sus condiciones prohíben extraer o replicar sus datos. La
//! respuesta se limita a coordenadas y nombre; RAMI-Chain NO verifica la
//! legalidad ni la existencia de ninguna empresa (eso lo hace el Registro
//! Mercantil, un servicio de pago fuera de este proyecto).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

const NOMINATIM: &str = "https://nominatim.openstreetmap.org/search";

/// Caja de Tenerife (algo más ancha que la isla): las búsquedas se acotan a
/// ella para que «Calle Castillo» resuelva en Tenerife y no en otra provincia.
const VIEWBOX: &str = "-17.0,28.70,-16.05,27.95";

#[derive(Serialize, Clone, Debug)]
pub struct Place {
    pub lat: f64,
    pub lon: f64,
    pub name: String,
}

static LAST: Mutex<Option<Instant>> = Mutex::new(None);

/// Busca una dirección (texto libre) dentro de Tenerife. Devuelve hasta 3
/// resultados. Errores en texto llano para el panel.
pub fn search(query: &str) -> Result<Vec<Place>, String> {
    let q = query.trim();
    if q.len() < 3 {
        return Err("escribe una dirección (mínimo 3 caracteres)".into());
    }
    if q.len() > 200 {
        return Err("dirección demasiado larga".into());
    }
    // Máximo una petición por segundo (política de Nominatim).
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = *last {
            let el = t.elapsed();
            if el < Duration::from_secs(1) {
                std::thread::sleep(Duration::from_secs(1) - el);
            }
        }
        *last = Some(Instant::now());
    }
    let url = format!(
        "{NOMINATIM}?format=jsonv2&limit=3&countrycodes=es&bounded=1&viewbox={VIEWBOX}&q={}",
        urlencode(q)
    );
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(6))
        .timeout(Duration::from_secs(12))
        .build();
    let txt = agent
        .get(&url)
        .set("User-Agent", "RAMI-Chain-Wallet/1.0 (https://quantbot.army; testnet)")
        .set("Accept-Language", "es")
        .call()
        .map_err(|e| format!("no se pudo consultar OpenStreetMap: {e}"))?
        .into_string()
        .map_err(|e| format!("respuesta ilegible: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| format!("JSON inválido: {e}"))?;
    let arr = v.as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for it in arr {
        let lat = it.get("lat").and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok());
        let lon = it.get("lon").and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok());
        let name = it.get("display_name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if let (Some(lat), Some(lon)) = (lat, lon) {
            out.push(Place { lat, lon, name });
        }
    }
    if out.is_empty() {
        return Err("no se encontró esa dirección en Tenerife".into());
    }
    Ok(out)
}

fn urlencode(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            b' ' => o.push('+'),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_query() {
        assert_eq!(urlencode("Calle Castillo 1, Santa Cruz"), "Calle+Castillo+1%2C+Santa+Cruz");
        assert_eq!(urlencode("Güímar"), "G%C3%BC%C3%ADmar");
    }

    #[test]
    fn rejects_short_and_long() {
        assert!(search("ab").is_err());
        assert!(search(&"x".repeat(201)).is_err());
    }
}
