//! Graduación de los pares como FUENTES, con el código Admiralty (OTAN /
//! STANAG 2511): una letra por la fiabilidad de la fuente —su historial— y un
//! número por la credibilidad de lo que dice en esta sesión. Se evalúan por
//! separado y se publican juntos («B2»), con los motivos, para que el panel
//! diga de quién viene cada rama y cuánto vale su palabra.
//!
//! Nada de esto toca el consenso: un par «A1» sigue sin ser fuente de
//! confianza —`accept_block` revalida todo—; la graduación solo describe, con
//! la palabra exacta, lo que ya observó el nodo. La letra sobrevive a los
//! reinicios en `peer-grades.json` (un archivo NUEVO en el directorio de la
//! cadena, indexado por clave pública; las versiones anteriores lo ignoran y
//! esta lo recrea si falta o está corrupto). El número nace con cada conexión.
//!
//! Vocabulario fijo: *fiabilidad* es la letra (historial), *credibilidad* es
//! el número (esta sesión). «Confianza» no se usa aquí: es otra cosa.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Entradas máximas persistidas (un par por clave pública).
pub const GRADOS_CAP: usize = 256;
/// Bloques de retraso a partir de los cuales lo que cuenta un par es dato viejo.
pub const RETRASO_VIEJO: u64 = 100;

/// Historial de un par, acumulado entre sesiones. Solo cuenta lo que este nodo
/// verificó por sí mismo con las reglas de consenso.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistorialPar {
    /// Bloques recibidos de este par que se admitieron (válidos y nuevos).
    #[serde(default)]
    pub validos: u64,
    /// Bloques recibidos de este par rechazados por inválidos (no huérfanos).
    #[serde(default)]
    pub invalidos: u64,
    /// Bloques huérfanos: ni prueban ni desmienten nada; se cuentan aparte.
    #[serde(default)]
    pub huerfanos: u64,
    /// Lotes `Branch` aplicados con al menos un bloque nuevo.
    #[serde(default)]
    pub ramas: u64,
    /// Veces que la dirección apareció con OTRA identidad (aviso TOFU).
    #[serde(default)]
    pub cambios_identidad: u64,
    /// Última vez visto (segundos Unix); solo informativo.
    #[serde(default)]
    pub visto: u64,
}

impl HistorialPar {
    pub fn juzgados(&self) -> u64 {
        self.validos + self.invalidos
    }
}

/// Lo observado en ESTA sesión, desde el saludo. Se descarta al desconectar.
#[derive(Clone, Debug, Default)]
pub struct EvidenciaSesion {
    /// Puntas que ha anunciado (`Tips`), acumuladas.
    pub puntas_anunciadas: u64,
    /// Bloques suyos admitidos en esta sesión.
    pub validos: u64,
    /// Bloques suyos rechazados por inválidos en esta sesión.
    pub invalidos: u64,
    /// Alguna punta que anunció está en nuestro árbol verificado Y la anuncia
    /// también otro par: dos fuentes independientes dicen lo mismo.
    pub corroborado: bool,
    /// Alguna punta que anunció está en nuestro árbol verificado (aunque nadie
    /// más la anuncie): lo comprobamos nosotros.
    pub verificado: bool,
    /// Altura que declara, frente a la mejor altura del resto de pares.
    pub altura: u64,
    pub mejor_altura_ajena: u64,
}

pub type Fiabilidad = char;
pub type Credibilidad = u8;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Graduacion {
    pub fiabilidad: Fiabilidad,
    pub credibilidad: Credibilidad,
    /// «B2».
    pub codigo: String,
    /// Por qué esa letra y ese número, en castellano, sin adornos.
    pub motivos: Vec<String>,
}

/// La letra: el historial. F mientras no haya juzgado nada suficiente; de A a
/// E según la proporción de bloques inválidos y los cambios de identidad.
pub fn fiabilidad(h: &HistorialPar) -> (Fiabilidad, String) {
    let n = h.juzgados();
    if n < 3 {
        return ('F', format!("sin historial suficiente: {n} bloque(s) juzgado(s), hacen falta 3"));
    }
    // Proporción en milésimas, entera: aquí no se decide dinero pero sí una
    // letra, y una letra no debe depender de un redondeo de coma flotante.
    let malos_pm = h.invalidos * 1000 / n;
    let letra = if h.invalidos == 0 && n >= 50 {
        'A'
    } else if malos_pm <= 20 && n >= 10 {
        'B'
    } else if malos_pm <= 100 {
        'C'
    } else if malos_pm <= 300 {
        'D'
    } else {
        'E'
    };
    // Cambiar de identidad no es inválido, pero sí es motivo para no pasar de C.
    let letra = if h.cambios_identidad > 0 && letra < 'C' { 'C' } else { letra };
    let mut motivo = format!("{} válidos, {} inválidos de {} juzgados", h.validos, h.invalidos, n);
    if h.cambios_identidad > 0 {
        motivo.push_str(&format!("; {} cambio(s) de identidad en su dirección (tope C)", h.cambios_identidad));
    }
    (letra, motivo)
}

/// El número: esta sesión. Se decide de peor a mejor, y gana la primera
/// condición que se cumpla: dato viejo o contradicción mandan sobre cualquier
/// corroboración.
pub fn credibilidad(e: &EvidenciaSesion) -> (Credibilidad, String) {
    if e.puntas_anunciadas == 0 && e.validos == 0 && e.invalidos == 0 {
        return (6, "todavía no ha anunciado puntas ni enviado bloques".into());
    }
    if e.mejor_altura_ajena > e.altura && e.mejor_altura_ajena - e.altura > RETRASO_VIEJO {
        return (5, format!("va {} bloques por detrás del mejor par: dato viejo", e.mejor_altura_ajena - e.altura));
    }
    if e.invalidos > 0 {
        return (3, format!("{} bloque(s) inválido(s) en esta sesión: contradicho por el consenso", e.invalidos));
    }
    if !e.verificado {
        return (4, "anuncia puntas pero aún no tenemos ninguna en el árbol: sin verificar".into());
    }
    if e.corroborado {
        (1, "una punta suya está en nuestro árbol y la anuncia también otro par".into())
    } else {
        (2, "sus bloques están en nuestro árbol, pero ningún otro par los corrobora".into())
    }
}

pub fn graduar(h: &HistorialPar, e: &EvidenciaSesion) -> Graduacion {
    let (letra, m1) = fiabilidad(h);
    let (numero, m2) = credibilidad(e);
    Graduacion { fiabilidad: letra, credibilidad: numero, codigo: format!("{letra}{numero}"), motivos: vec![m1, m2] }
}

// ── Persistencia: peer-grades.json (clave pública hex → historial) ──────────

pub fn grados_path(root: &Path) -> PathBuf {
    root.join("peer-grades.json")
}

/// Carga el libro; si falta o no se puede leer, empieza vacío. Nunca es un
/// error: el historial es descriptivo, no de consenso.
pub fn cargar(root: &Path) -> HashMap<String, HistorialPar> {
    std::fs::read_to_string(grados_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, HistorialPar>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .take(GRADOS_CAP)
        .collect()
}

/// Guarda como mucho `GRADOS_CAP` entradas, las más recientes primero.
/// Escritura atómica (temporal + rename): un corte a mitad deja el archivo
/// anterior intacto, y un archivo a medias se descartaría al cargar.
pub fn guardar(root: &Path, grados: &HashMap<String, HistorialPar>) {
    let mut lista: Vec<(&String, &HistorialPar)> = grados.iter().collect();
    lista.sort_by(|a, b| b.1.visto.cmp(&a.1.visto).then(a.0.cmp(b.0)));
    lista.truncate(GRADOS_CAP);
    let mapa: serde_json::Map<String, serde_json::Value> = lista
        .into_iter()
        .filter_map(|(k, v)| serde_json::to_value(v).ok().map(|v| (k.clone(), v)))
        .collect();
    let Ok(json) = serde_json::to_string_pretty(&mapa) else { return };
    let path = grados_path(root);
    let tmp = root.join(".peer-grades.json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hist(validos: u64, invalidos: u64) -> HistorialPar {
        HistorialPar { validos, invalidos, ..Default::default() }
    }

    #[test]
    fn la_letra_empieza_en_f_y_sube_con_el_historial() {
        assert_eq!(fiabilidad(&hist(2, 0)).0, 'F');
        assert_eq!(fiabilidad(&hist(3, 0)).0, 'C', "tres válidos no bastan para B: hacen falta 10");
        assert_eq!(fiabilidad(&hist(10, 0)).0, 'B');
        assert_eq!(fiabilidad(&hist(49, 0)).0, 'B');
        assert_eq!(fiabilidad(&hist(50, 0)).0, 'A');
        // La proporción es sobre los juzgados (válidos + inválidos).
        assert_eq!(fiabilidad(&hist(98, 2)).0, 'B', "2 % de inválidos sigue siendo B");
        assert_eq!(fiabilidad(&hist(97, 3)).0, 'C');
        assert_eq!(fiabilidad(&hist(90, 10)).0, 'C');
        assert_eq!(fiabilidad(&hist(70, 30)).0, 'D');
        assert_eq!(fiabilidad(&hist(69, 31)).0, 'E');
    }

    #[test]
    fn cambiar_de_identidad_pone_un_tope_en_c() {
        let mut h = hist(100, 0);
        h.cambios_identidad = 1;
        let (letra, motivo) = fiabilidad(&h);
        assert_eq!(letra, 'C');
        assert!(motivo.contains("cambio(s) de identidad"));
        // Y no mejora una letra que ya era peor.
        let mut malo = hist(60, 40);
        malo.cambios_identidad = 1;
        assert_eq!(fiabilidad(&malo).0, 'E');
    }

    #[test]
    fn el_numero_se_decide_de_peor_a_mejor() {
        let nada = EvidenciaSesion::default();
        assert_eq!(credibilidad(&nada).0, 6);
        let viejo = EvidenciaSesion { puntas_anunciadas: 1, altura: 10, mejor_altura_ajena: 200, ..Default::default() };
        assert_eq!(credibilidad(&viejo).0, 5);
        let contradicho =
            EvidenciaSesion { puntas_anunciadas: 1, invalidos: 1, verificado: true, corroborado: true, ..Default::default() };
        assert_eq!(credibilidad(&contradicho).0, 3, "una contradicción manda sobre la corroboración");
        let sin_verificar = EvidenciaSesion { puntas_anunciadas: 3, ..Default::default() };
        assert_eq!(credibilidad(&sin_verificar).0, 4);
        let solo = EvidenciaSesion { puntas_anunciadas: 1, verificado: true, ..Default::default() };
        assert_eq!(credibilidad(&solo).0, 2);
        let corroborado = EvidenciaSesion { puntas_anunciadas: 1, verificado: true, corroborado: true, ..Default::default() };
        assert_eq!(credibilidad(&corroborado).0, 1);
    }

    #[test]
    fn el_codigo_junta_letra_y_numero_con_sus_motivos() {
        let g = graduar(&hist(10, 0), &EvidenciaSesion { puntas_anunciadas: 1, verificado: true, ..Default::default() });
        assert_eq!(g.codigo, "B2");
        assert_eq!(g.motivos.len(), 2);
    }

    #[test]
    fn el_libro_sobrevive_al_disco_y_tolera_lo_que_falte() {
        let dir = std::env::temp_dir().join(format!("rami-grados-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Sin archivo: vacío, sin error.
        assert!(cargar(&dir).is_empty());
        let mut g = HashMap::new();
        g.insert("aa".to_string(), HistorialPar { validos: 5, visto: 10, ..Default::default() });
        g.insert("bb".to_string(), HistorialPar { invalidos: 1, visto: 20, ..Default::default() });
        guardar(&dir, &g);
        assert_eq!(cargar(&dir), g);
        // Un campo desconocido de una versión futura no rompe la carga; un
        // campo que falte se rellena con cero.
        std::fs::write(grados_path(&dir), r#"{"cc":{"validos":7,"futuro":true}}"#).unwrap();
        let leido = cargar(&dir);
        assert_eq!(leido["cc"].validos, 7);
        assert_eq!(leido["cc"].invalidos, 0);
        // Corrupto: vacío, sin error.
        std::fs::write(grados_path(&dir), "{no es json").unwrap();
        assert!(cargar(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
