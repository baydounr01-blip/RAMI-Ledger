//! Calibración de las predicciones PROPIAS: la palabra exacta aplicada al
//! commit/reveal.
//!
//! Una predicción anclada en la cadena lleva, si el usuario quiere, un término
//! de la escala ICD 203 —«probable (55–80 %)»— dentro del payload. El payload
//! es opaco para el consenso (bytes bajo un hash), así que esto no cambia una
//! sola regla de la cadena. Cuando el usuario sabe el desenlace, lo apunta en
//! un libro local (`predicciones-libro.json`, junto al monedero; un archivo
//! NUEVO que las versiones anteriores ignoran) y el panel enseña si sus
//! «probable» ocurren entre el 55 y el 80 % de las veces: calibración, no
//! acierto. Lo apunta él: nadie más sabe qué predijo ni qué pasó.
//!
//! Aritmética entera hasta el final: las probabilidades van en centésimas
//! (p = 65 ⇒ 0,65) y el Brier en diezmilésimas, para que el resumen sea el
//! mismo byte a byte en cualquier máquina.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// La escala de siete términos (ICD 203 §2.4), con su rango en centésimas y
/// el punto medio que se usa para puntuar. Un término, un rango: nunca un
/// porcentaje suelto y nunca 0 ni 100.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Termino {
    pub clave: &'static str,
    pub desde: u8,
    pub hasta: u8,
}

impl Termino {
    /// Punto medio del rango, en centésimas (55–80 ⇒ 67; 45–55 ⇒ 50).
    pub fn punto_medio(&self) -> u8 {
        ((self.desde as u16 + self.hasta as u16) / 2) as u8
    }
    pub fn rango(&self) -> String {
        format!("{}–{} %", self.desde, self.hasta)
    }
}

pub const ESCALA: [Termino; 7] = [
    Termino { clave: "remoto", desde: 1, hasta: 5 },
    Termino { clave: "muy improbable", desde: 5, hasta: 20 },
    Termino { clave: "improbable", desde: 20, hasta: 45 },
    Termino { clave: "posibilidad aproximadamente igual", desde: 45, hasta: 55 },
    Termino { clave: "probable", desde: 55, hasta: 80 },
    Termino { clave: "muy probable", desde: 80, hasta: 95 },
    Termino { clave: "casi seguro", desde: 95, hasta: 99 },
];

pub fn termino(clave: &str) -> Option<&'static Termino> {
    ESCALA.iter().find(|t| t.clave == clave)
}

/// Una predicción del libro: lo que se dijo y, cuando se sabe, lo que pasó.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Prediccion {
    /// Txid del commit (hex): el ancla en la cadena.
    pub commit: String,
    /// Término de la escala con el que se enunció (o vacío si no se puso).
    #[serde(default)]
    pub termino: String,
    /// Texto libre de la predicción (lo que había en el payload, resumido).
    #[serde(default)]
    pub texto: String,
    /// Segundos Unix en que se apuntó.
    #[serde(default)]
    pub apuntada: u64,
    /// `Some(true)` ocurrió, `Some(false)` no ocurrió, `None` sin resolver.
    #[serde(default)]
    pub ocurrio: Option<bool>,
    #[serde(default)]
    pub resuelta: u64,
}

/// Una banda de la tabla de calibración, en enteros.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Banda {
    pub termino: String,
    pub rango: String,
    pub n: u32,
    pub ocurridos: u32,
    /// Frecuencia observada en centésimas (None sin casos).
    pub frecuencia: Option<u8>,
    /// Punto medio dicho − frecuencia ocurrida, en puntos porcentuales;
    /// positivo = se dijo más de lo que ocurrió.
    pub desvio: Option<i16>,
    /// `dentro` / `exceso` / `defecto` / `insuficiente` (menos de 5 casos).
    pub veredicto: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Resumen {
    pub apuntadas: u32,
    pub resueltas: u32,
    pub sin_termino: u32,
    /// Brier medio en diezmilésimas (0 perfecto, 2500 = decir siempre 50 %).
    pub brier_x10000: Option<u32>,
    pub bandas: Vec<Banda>,
    /// La frase honesta, redactada con lo que hay.
    pub lectura: String,
}

/// Mínimo de casos resueltos en una banda para decir algo de ella.
pub const MINIMO_BANDA: u32 = 5;

pub fn resumir(libro: &[Prediccion]) -> Resumen {
    let apuntadas = libro.len() as u32;
    let mut sin_termino = 0u32;
    let mut resueltas = 0u32;
    let mut brier_suma: u64 = 0;
    let mut por_banda: BTreeMap<usize, (u32, u32)> = BTreeMap::new();
    for p in libro {
        let Some(t) = termino(&p.termino) else {
            sin_termino += 1;
            continue;
        };
        let Some(o) = p.ocurrio else { continue };
        resueltas += 1;
        let pm = t.punto_medio() as i64;
        let obs: i64 = if o { 100 } else { 0 };
        // (p − o)² en centésimas² = diezmilésimas.
        brier_suma += ((pm - obs) * (pm - obs)) as u64;
        let idx = ESCALA.iter().position(|e| e.clave == t.clave).unwrap_or(0);
        let e = por_banda.entry(idx).or_insert((0, 0));
        e.0 += 1;
        if o {
            e.1 += 1;
        }
    }
    let brier_x10000 = if resueltas > 0 { Some((brier_suma / resueltas as u64) as u32) } else { None };
    let bandas: Vec<Banda> = ESCALA
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let (n, ocurridos) = por_banda.get(&i).copied().unwrap_or((0, 0));
            let frecuencia = if n > 0 { Some((ocurridos * 100 / n) as u8) } else { None };
            let desvio = frecuencia.map(|f| t.punto_medio() as i16 - f as i16);
            let veredicto = match frecuencia {
                Some(f) if n >= MINIMO_BANDA => {
                    if f < t.desde {
                        "exceso"
                    } else if f > t.hasta {
                        "defecto"
                    } else {
                        "dentro"
                    }
                }
                _ => "insuficiente",
            };
            Banda { termino: t.clave.to_string(), rango: t.rango(), n, ocurridos, frecuencia, desvio, veredicto }
        })
        .collect();
    let lectura = lectura(apuntadas, resueltas, sin_termino, &bandas);
    Resumen { apuntadas, resueltas, sin_termino, brier_x10000, bandas, lectura }
}

fn lectura(apuntadas: u32, resueltas: u32, sin_termino: u32, bandas: &[Banda]) -> String {
    if apuntadas == 0 {
        return "Sin predicciones apuntadas todavía. Elige un término de la escala al comprometer y apunta el desenlace cuando lo sepas.".into();
    }
    let utiles: Vec<&Banda> = bandas.iter().filter(|b| b.veredicto != "insuficiente").collect();
    let base = if utiles.is_empty() {
        format!(
            "Todavía no hay base: {resueltas} de {apuntadas} resueltas y ninguna banda llega a {MINIMO_BANDA} casos. Lo que hay es transparencia, no evidencia."
        )
    } else {
        let frases: Vec<String> = utiles
            .iter()
            .map(|b| {
                let dice = match b.veredicto {
                    "dentro" => "ocurre con la frecuencia que dice",
                    "exceso" => "ocurre menos de lo que dice",
                    _ => "ocurre más de lo que dice",
                };
                format!("«{}» ({}) {} en {} casos", b.termino, b.rango, dice, b.n)
            })
            .collect();
        format!("{resueltas} resueltas de {apuntadas}. {}.", frases.join("; "))
    };
    let sin = if sin_termino > 0 { format!(" {sin_termino} sin término de la escala no cuentan.") } else { String::new() };
    format!("{base}{sin} Esto mide si tus palabras significan lo que dicen; no mide acierto ni rentabilidad.")
}

// ── El libro en disco ──────────────────────────────────────────────────

pub fn libro_path(dir: &Path) -> PathBuf {
    dir.join("predicciones-libro.json")
}

pub fn cargar_libro(dir: &Path) -> Vec<Prediccion> {
    fs::read_to_string(libro_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Prediccion>>(&s).ok())
        .unwrap_or_default()
}

/// Escritura atómica (temporal + rename), como el keystore: un corte a mitad
/// deja el libro anterior intacto.
pub fn guardar_libro(dir: &Path, libro: &[Prediccion]) -> Result<(), String> {
    let _ = fs::create_dir_all(dir);
    let json = serde_json::to_string_pretty(libro).map_err(|e| e.to_string())?;
    let tmp = dir.join(".predicciones-libro.json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("no se pudo escribir el libro: {e}"))?;
    fs::rename(&tmp, libro_path(dir)).map_err(|e| format!("no se pudo reemplazar el libro: {e}"))
}

/// Apunta (o actualiza) una predicción por su commit. Devuelve el libro.
pub fn apuntar(dir: &Path, nueva: Prediccion) -> Result<Vec<Prediccion>, String> {
    let mut libro = cargar_libro(dir);
    match libro.iter_mut().find(|p| p.commit == nueva.commit) {
        Some(p) => {
            if !nueva.termino.is_empty() {
                p.termino = nueva.termino;
            }
            if !nueva.texto.is_empty() {
                p.texto = nueva.texto;
            }
            if nueva.ocurrio.is_some() {
                p.ocurrio = nueva.ocurrio;
                p.resuelta = nueva.resuelta;
            }
        }
        None => libro.push(nueva),
    }
    guardar_libro(dir, &libro)?;
    Ok(libro)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pred(commit: &str, termino: &str, ocurrio: Option<bool>) -> Prediccion {
        Prediccion { commit: commit.into(), termino: termino.into(), ocurrio, ..Default::default() }
    }

    #[test]
    fn la_escala_cierra_sin_huecos_y_sin_extremos() {
        for par in ESCALA.windows(2) {
            assert_eq!(par[0].hasta, par[1].desde, "la escala no puede tener huecos ni solapes");
        }
        assert_eq!(ESCALA[0].desde, 1, "nunca 0 %");
        assert_eq!(ESCALA[6].hasta, 99, "nunca 100 %");
        assert_eq!(termino("probable").unwrap().punto_medio(), 67);
        assert_eq!(termino("probable").unwrap().rango(), "55–80 %");
        assert!(termino("quizá").is_none());
    }

    #[test]
    fn el_brier_es_entero_y_castiga_lo_que_no_ocurrio() {
        // «casi seguro» (97) y no ocurrió: (97−0)² = 9409; ocurrió: 9.
        let r = resumir(&[pred("a", "casi seguro", Some(false))]);
        assert_eq!(r.brier_x10000, Some(9409));
        let r = resumir(&[pred("a", "casi seguro", Some(true))]);
        assert_eq!(r.brier_x10000, Some(9));
        // Decir siempre «posibilidad aproximadamente igual» (50) da 2500.
        let r = resumir(&[pred("a", "posibilidad aproximadamente igual", Some(true)), pred("b", "posibilidad aproximadamente igual", Some(false))]);
        assert_eq!(r.brier_x10000, Some(2500));
    }

    #[test]
    fn las_bandas_juzgan_solo_con_cinco_casos() {
        let mut libro: Vec<Prediccion> = (0..4).map(|i| pred(&format!("c{i}"), "probable", Some(true))).collect();
        let r = resumir(&libro);
        let b = r.bandas.iter().find(|b| b.termino == "probable").unwrap();
        assert_eq!((b.n, b.veredicto), (4, "insuficiente"));
        assert!(r.lectura.contains("Todavía no hay base"));
        // Cinco casos: 3 de 5 ocurrieron = 60 %, dentro de 55–80.
        libro.push(pred("c4", "probable", Some(false)));
        libro[1].ocurrio = Some(false);
        let r = resumir(&libro);
        let b = r.bandas.iter().find(|b| b.termino == "probable").unwrap();
        assert_eq!((b.n, b.ocurridos, b.frecuencia, b.desvio, b.veredicto), (5, 3, Some(60), Some(7), "dentro"));
        assert!(r.lectura.contains("ocurre con la frecuencia que dice"));
        assert!(r.lectura.ends_with("no mide acierto ni rentabilidad."));
        // Cinco «casi seguro» de los que ocurren 2: exceso.
        let exceso: Vec<Prediccion> = (0..5).map(|i| pred(&format!("s{i}"), "casi seguro", Some(i < 2))).collect();
        let r = resumir(&exceso);
        assert_eq!(r.bandas.iter().find(|b| b.termino == "casi seguro").unwrap().veredicto, "exceso");
    }

    #[test]
    fn sin_termino_o_sin_resolver_no_cuentan_pero_se_dicen() {
        let r = resumir(&[pred("a", "", Some(true)), pred("b", "probable", None)]);
        assert_eq!((r.apuntadas, r.resueltas, r.sin_termino, r.brier_x10000), (2, 0, 1, None));
        assert!(r.lectura.contains("1 sin término"));
        assert!(resumir(&[]).lectura.starts_with("Sin predicciones"));
    }

    #[test]
    fn el_libro_se_guarda_se_actualiza_y_tolera_lo_desconocido() {
        let dir = std::env::temp_dir().join(format!("rami-libro-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(cargar_libro(&dir).is_empty());
        apuntar(&dir, Prediccion { commit: "abc".into(), termino: "probable".into(), texto: "BTC sube".into(), apuntada: 1, ..Default::default() }).unwrap();
        let libro = apuntar(&dir, Prediccion { commit: "abc".into(), ocurrio: Some(true), resuelta: 2, ..Default::default() }).unwrap();
        assert_eq!(libro.len(), 1);
        assert_eq!((libro[0].termino.as_str(), libro[0].texto.as_str(), libro[0].ocurrio, libro[0].resuelta), ("probable", "BTC sube", Some(true), 2));
        // Campos de una versión futura: se ignoran; los que falten, por defecto.
        fs::write(libro_path(&dir), r#"[{"commit":"zzz","futuro":1}]"#).unwrap();
        let leido = cargar_libro(&dir);
        assert_eq!(leido[0].commit, "zzz");
        assert_eq!(leido[0].ocurrio, None);
        fs::write(libro_path(&dir), "no json").unwrap();
        assert!(cargar_libro(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
