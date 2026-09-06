//! Nodos semilla: cómo un monedero recién instalado encuentra la red sin que
//! nadie escriba una IP.
//!
//! 1. **Semilla DNS** `seed.quantbot.army:30301`: un nombre que el proyecto
//!    puede apuntar a uno o varios nodos siempre encendidos (VPS). Mientras el
//!    nombre no exista, simplemente no resuelve y no pasa nada.
//! 2. **Lista web** `https://quantbot.army/descargas/seeds.json`
//!    (`{"seeds": ["host:puerto", ...]}`): se publica desde el repositorio de
//!    la web sin necesidad de sacar una versión nueva de la app.
//! 3. Los pares de sesiones anteriores (`peers.json`) y los que se descubren
//!    en la red local (UDP) o se añaden a mano en la pestaña Red.
//!
//! Testnet experimental, sin valor monetario.

use std::time::Duration;

/// Semilla DNS del proyecto (puede no existir todavía).
pub const DNS_SEED: &str = "seed.quantbot.army:30301";

fn web_base() -> Option<String> {
    let v = std::env::var("RAMI_WEB_URL").unwrap_or_else(|_| "https://quantbot.army".to_string());
    let v = v.trim().trim_end_matches('/').to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Descarga la lista de semillas publicada en la web (vacía si no hay red o
/// el archivo no existe). Solo acepta entradas `host:puerto` razonables.
pub fn fetch_web_seeds() -> Vec<String> {
    let Some(base) = web_base() else { return Vec::new() };
    let url = format!("{base}/descargas/seeds.json");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(6))
        .timeout(Duration::from_secs(10))
        .build();
    let Ok(resp) = agent.get(&url).set("User-Agent", "RAMI-Chain-Wallet").call() else { return Vec::new() };
    let Ok(txt) = resp.into_string() else { return Vec::new() };
    parse_seeds(&txt)
}

/// Parsea `{"seeds":[...]}` con validación básica (host:puerto, ≤ 64).
pub fn parse_seeds(txt: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(txt) else { return Vec::new() };
    v.get("seeds")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| valid_addr(s))
                .take(64)
                .collect()
        })
        .unwrap_or_default()
}

fn valid_addr(s: &str) -> bool {
    let Some((host, port)) = s.rsplit_once(':') else { return false };
    if host.is_empty() || host.len() > 253 || port.parse::<u16>().map(|p| p == 0).unwrap_or(true) {
        return false;
    }
    host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '[' || c == ']' || c == ':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates() {
        let s = parse_seeds(r#"{"seeds":["1.2.3.4:30301","seed.example.org:30301","malo","x:0",":1","a b:1"]}"#);
        assert_eq!(s, vec!["1.2.3.4:30301".to_string(), "seed.example.org:30301".to_string()]);
        assert!(parse_seeds("no json").is_empty());
        assert!(parse_seeds(r#"{"otra":1}"#).is_empty());
    }
}
