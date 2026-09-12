//! rami-core::ciudad — **Dubái RAMI** (fase 1 del metaverso): las reglas de
//! consenso de la ciudad. Desde la activación (`Params.dubai_desde`) la
//! cuadrícula pasa de 32×32 a 64×64 celdas de 650 m tendidas sobre una
//! réplica abierta de Dubái, cada celda pertenece a un **distrito** con su
//! precio de parcela, cada parcela es una **empresa** de un **sector**, los
//! sectores se necesitan unos a otros (grafo de insumos) y se pagan en RAMI,
//! una parte de la emisión de cada bloque entra en el **fondo de la ciudad**
//! y el fondo se reparte cada bloque entre las empresas según su demanda,
//! su distrito y cuántos de sus insumos existen en la ciudad.
//!
//! Todo es aritmética entera (u128 en los productos) y recorre mapas
//! ordenados (`BTreeMap`), así que dos nodos con el mismo estado llegan al
//! mismo resultado byte a byte. Nada aquí usa floats ni el reloj.
//!
//! Testnet experimental: los RAMI no tienen valor monetario. Lo que aquí se
//! llama «ingreso» es RAMI de prueba repartido por una regla pública.

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;

use crate::state::{Parcel, State, COIN};
use crate::tx::{AccountId, Amount};

/// Lado de la cuadrícula desde la activación de Dubái (antes, 32).
pub const CITY_SIZE_DUBAI: u16 = 64;
/// Sector más alto admitido desde la activación (antes, 3).
pub const MAX_SECTOR: u8 = 29;
/// Tipo de activo más alto desde la activación (antes, 1): 2 vehículo, 3 local.
pub const MAX_ASSET_KIND_DUBAI: u8 = 3;
/// Sector cuyo dueño puede acuñar vehículos (activos de tipo 2).
pub const SECTOR_CONCESIONARIO: u8 = 4;

/// Parte de la EMISIÓN de cada bloque que entra en el fondo de la ciudad
/// (puntos básicos de la recompensa de emisión; las comisiones siguen
/// siendo del minero enteras). 2000 = 20 %.
pub const CITY_SHARE_BPS: u64 = 2000;
/// Parte del fondo que se reparte en cada bloque (puntos básicos). 100 = 1 %:
/// el fondo actúa como colchón y tiende a repartir lo que entra.
pub const PAYOUT_BPS: u64 = 100;
/// Parte del ingreso de una empresa que paga a sus proveedores (puntos
/// básicos). Los insumos que no existen en la ciudad se «importan»: esa parte
/// se quema. 4000 = 40 %.
pub const SUPPLY_BPS: u64 = 4000;
/// Operaciones de mercado que se recuerdan en el estado (cotización).
pub const MAX_TRADES: usize = 256;

/// Precio de acuñar cada tipo de activo desde Dubái (se quema).
pub fn precio_acunado(kind: u8) -> Amount {
    match kind {
        2 => 5 * COIN,  // vehículo
        3 => 20 * COIN, // local (unidad de un edificio)
        _ => COIN,      // planta u objeto
    }
}

/// Parte de la emisión de un bloque que va al fondo de la ciudad.
pub fn parte_ciudad(emision: Amount) -> Amount {
    ((emision as u128) * CITY_SHARE_BPS as u128 / 10_000) as Amount
}

// ---------------------------------------------------------------------------
// Distritos
// ---------------------------------------------------------------------------

/// Un distrito de la réplica: rectángulo de la cuadrícula (inclusive), precio
/// de una parcela libre (RAMI, se quema) y «actividad» (permil; el pulso de
/// clientes y turistas del distrito, que multiplica la demanda de toda empresa
/// situada en él). La lista se recorre en orden y gana la PRIMERA coincidencia.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Distrito {
    pub id: u8,
    pub clave: &'static str,
    pub nombre: &'static str,
    /// Precio de una parcela libre, en RAMI enteros.
    pub precio_rami: u32,
    pub actividad: u32,
    pub x0: u16,
    pub y0: u16,
    pub x1: u16,
    pub y1: u16,
}

const fn d(id: u8, clave: &'static str, nombre: &'static str, precio_rami: u32, actividad: u32, x0: u16, y0: u16, x1: u16, y1: u16) -> Distrito {
    Distrito { id, clave, nombre, precio_rami, actividad, x0, y0, x1, y1 }
}

/// Distritos con rectángulo propio (los dos últimos, mar y desierto, se
/// deciden por regla en `distrito`). Las coordenadas salen de proyectar cada
/// barrio real sobre la cuadrícula del dataset (`geo/dubai.json`, `grid`).
pub const DISTRITOS: [Distrito; 32] = [
    d(0, "palm", "Palm Jumeirah", 300, 2500, 18, 5, 25, 12),
    d(1, "downtown", "Downtown Dubái", 250, 3000, 44, 16, 48, 18),
    d(2, "difc", "DIFC · Sheikh Zayed Road", 200, 2200, 47, 15, 51, 17),
    d(3, "marina", "Dubai Marina · JBR", 180, 2500, 14, 12, 19, 16),
    d(4, "citywalk", "City Walk · Al Wasl", 120, 1500, 44, 14, 49, 15),
    d(5, "jumeirah", "Jumeirah", 150, 1800, 41, 11, 50, 13),
    d(6, "satwa", "Satwa", 60, 1400, 50, 13, 53, 14),
    d(7, "ummsuqeim", "Umm Suqeim · Burj Al Arab", 120, 1600, 27, 12, 40, 15),
    d(8, "sufouh", "Al Sufouh · Internet City", 100, 1500, 20, 13, 26, 16),
    d(9, "jlt", "JLT", 90, 1300, 15, 17, 19, 19),
    d(10, "barsha", "Al Barsha", 80, 1300, 25, 16, 31, 21),
    d(11, "hills", "Dubai Hills", 90, 1100, 27, 22, 36, 27),
    d(12, "quoz", "Al Quoz", 40, 900, 31, 17, 40, 22),
    d(13, "bbay", "Business Bay", 150, 1800, 41, 17, 46, 21),
    d(14, "d3", "Dubai Design District", 110, 1400, 47, 19, 50, 21),
    d(15, "zabeel", "Zabeel · Karama", 60, 1400, 51, 14, 56, 19),
    d(16, "burdubai", "Bur Dubái", 60, 1600, 54, 10, 56, 14),
    d(17, "deira", "Deira", 60, 2000, 57, 9, 63, 16),
    d(18, "creek", "Dubai Creek Harbour · Festival City", 100, 1200, 52, 20, 59, 27),
    d(19, "dxb", "Aeropuerto DXB", 80, 1500, 59, 17, 63, 24),
    d(20, "meydan", "Meydan · Nad Al Sheba", 70, 900, 41, 22, 50, 29),
    d(21, "jebelali", "Puerto de Jebel Ali", 50, 1200, 0, 11, 5, 17),
    d(22, "furjan", "Al Furjan · Discovery Gardens", 40, 1000, 6, 15, 14, 24),
    d(23, "jafza", "Zona Franca Jebel Ali", 30, 800, 0, 18, 8, 27),
    d(24, "dip", "Dubai Investments Park", 25, 700, 6, 25, 15, 31),
    d(25, "expo", "Expo City", 60, 1200, 0, 28, 6, 34),
    d(26, "motorcity", "Motor City · Sports City", 40, 900, 19, 27, 27, 32),
    d(27, "ranches", "Arabian Ranches", 50, 800, 26, 31, 31, 35),
    d(28, "parques", "Global Village · IMG", 40, 1300, 31, 33, 39, 38),
    d(29, "dubailand", "Dubailand", 20, 700, 27, 28, 44, 35),
    d(30, "silicon", "Silicon Oasis · Academic City", 30, 1000, 44, 35, 53, 44),
    d(31, "intl", "International City", 20, 900, 54, 33, 60, 39),
];
/// Islas de The World (mar con precio propio).
pub const WORLD: Distrito = d(32, "world", "The World", 200, 600, 36, 1, 41, 4);
/// Mar abierto (una parcela aquí es una isla artificial).
pub const GOLFO: Distrito = d(33, "golfo", "Golfo Pérsico (mar)", 10, 300, 0, 0, 63, 63);
/// Todo lo demás: desierto.
pub const DESIERTO: Distrito = d(34, "desierto", "Desierto", 5, 300, 0, 0, 63, 63);

/// Número total de distritos (ids 0..NDISTRITOS).
pub const NDISTRITOS: usize = 35;

/// Todos los distritos, por id (para el panel y las pruebas).
pub fn distritos() -> Vec<Distrito> {
    let mut v: Vec<Distrito> = DISTRITOS.to_vec();
    v.push(WORLD);
    v.push(GOLFO);
    v.push(DESIERTO);
    v
}

/// ¿La celda (x, y) es mar? La costa corre a lo largo del eje x de la
/// cuadrícula (bearing 42°), de y≈13 en Jebel Ali a y≈10 en Deira:
/// `63·y + 3·x < 819`. Palm, Bluewaters, The World y Deira Islands son
/// distritos con rectángulo propio y se resuelven antes.
pub fn es_mar(x: u16, y: u16) -> bool {
    (63u32 * y as u32) + (3u32 * x as u32) < 819
}

/// Distrito de una celda (primera coincidencia; mar; desierto).
pub fn distrito(x: u16, y: u16) -> Distrito {
    for dd in DISTRITOS.iter() {
        if x >= dd.x0 && x <= dd.x1 && y >= dd.y0 && y <= dd.y1 {
            return *dd;
        }
    }
    if x >= WORLD.x0 && x <= WORLD.x1 && y >= WORLD.y0 && y <= WORLD.y1 {
        return WORLD;
    }
    if es_mar(x, y) {
        return GOLFO;
    }
    DESIERTO
}

/// Precio de una parcela libre en unidades base (se quema).
pub fn precio_parcela(x: u16, y: u16) -> Amount {
    distrito(x, y).precio_rami as Amount * COIN
}

// ---------------------------------------------------------------------------
// Sectores y su grafo de insumos
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Sector {
    pub id: u8,
    pub clave: &'static str,
    pub nombre: &'static str,
    /// Sectores que esta empresa necesita comprar (proveedores).
    pub insumos: &'static [u8],
    /// Demanda base (permil): cuánto tira de él el público y el turismo.
    pub demanda: u32,
}

const fn s(id: u8, clave: &'static str, nombre: &'static str, insumos: &'static [u8], demanda: u32) -> Sector {
    Sector { id, clave, nombre, insumos, demanda }
}

/// Catálogo de sectores. Los cuatro primeros son los de la fase 0 (Tenerife)
/// y conservan su número. El grafo se cierra sobre sí mismo: toda empresa
/// necesita a otras y es necesitada por otras.
pub const SECTORES: [Sector; 30] = [
    s(0, "empresa", "Empresa", &[3, 14], 800),
    s(1, "granja", "Granja", &[10, 9, 11], 600),
    s(2, "tienda", "Tienda", &[11, 14, 27], 1200),
    s(3, "oficina", "Oficina", &[12, 9, 26], 500),
    s(4, "concesionario", "Concesionario de coches", &[11, 16, 17, 13, 14], 1500),
    s(5, "hotel", "Hotel", &[9, 10, 6, 24, 28, 23], 2000),
    s(6, "restaurante", "Restaurante", &[1, 11, 9, 14], 1400),
    s(7, "inmobiliaria", "Inmobiliaria", &[8, 14, 18], 900),
    s(8, "constructora", "Constructora", &[29, 9, 11, 3, 7], 700),
    s(9, "energia", "Energía solar", &[8, 12], 400),
    s(10, "agua", "Desaladora", &[9, 8], 400),
    s(11, "logistica", "Logística y puerto", &[9, 12, 16], 500),
    s(12, "telecom", "Telecomunicaciones", &[9, 15], 500),
    s(13, "banco", "Banco", &[15, 18, 28], 900),
    s(14, "marketing", "Agencia de marketing", &[15, 12], 500),
    s(15, "software", "Empresa de software", &[12, 3, 20], 700),
    s(16, "taller", "Taller mecánico", &[11, 29], 800),
    s(17, "seguros", "Aseguradora", &[18, 15, 19], 500),
    s(18, "bufete", "Bufete de abogados", &[3, 12], 600),
    s(19, "clinica", "Clínica", &[9, 10, 17, 11], 1300),
    s(20, "escuela", "Escuela de negocios", &[3, 15, 14, 0], 900),
    s(21, "joyeria", "Joyería (Zoco del Oro)", &[28, 11, 14], 1300),
    s(22, "supermercado", "Supermercado", &[1, 11, 9], 1600),
    s(23, "gimnasio", "Gimnasio", &[9, 14], 900),
    s(24, "turismo", "Agencia de turismo", &[5, 14, 11], 1000),
    s(25, "taxi", "Taxi y movilidad", &[4, 16, 9], 1200),
    s(26, "cafeteria", "Cafetería", &[1, 11, 22], 1100),
    s(27, "moda", "Moda", &[11, 14, 2, 21], 1000),
    s(28, "seguridad", "Seguridad", &[12, 25], 400),
    s(29, "materiales", "Materiales (cemento y acero)", &[9, 11], 400),
];

pub fn sector(id: u8) -> Option<&'static Sector> {
    SECTORES.get(id as usize)
}

/// Afinidad distrito × sector (permil; 1000 = neutra). Refleja dónde está
/// cada actividad en el Dubái real: el puerto en Jebel Ali, el oro en Deira,
/// los bancos en DIFC, los concesionarios en Al Quoz y Sheikh Zayed Road, las
/// placas solares en el desierto… Lo que no aparece vale 1000.
const AFINIDAD: &[(u8, u8, u32)] = &[
    // Palm Jumeirah: hoteles, restaurantes, turismo, gimnasios, moda
    (0, 5, 2500), (0, 6, 1500), (0, 24, 2000), (0, 23, 1500), (0, 27, 1500), (0, 7, 1500),
    // Downtown: hoteles, tienda, restaurantes, moda, turismo, inmobiliaria, oficinas
    (1, 5, 2200), (1, 2, 1800), (1, 6, 1600), (1, 27, 2000), (1, 24, 2000), (1, 7, 1800), (1, 3, 1500),
    // DIFC / SZR: bancos, bufetes, seguros, oficinas, concesionarios
    (2, 13, 3000), (2, 18, 2200), (2, 17, 2200), (2, 3, 1800), (2, 4, 1800), (2, 15, 1300),
    // Marina · JBR: hoteles, restaurantes, gimnasios, cafeterías, turismo
    (3, 5, 2200), (3, 6, 1700), (3, 23, 1600), (3, 26, 1600), (3, 24, 1800), (3, 7, 1400),
    // City Walk: cafeterías, moda, restaurantes, clínicas
    (4, 26, 2000), (4, 27, 1800), (4, 6, 1500), (4, 19, 1500),
    // Jumeirah: cafeterías, clínicas, supermercados, gimnasios, inmobiliaria
    (5, 26, 1800), (5, 19, 1600), (5, 22, 1400), (5, 23, 1400), (5, 7, 1400),
    // Satwa: tiendas, talleres, cafeterías
    (6, 2, 1500), (6, 16, 1500), (6, 26, 1400),
    // Umm Suqeim: hoteles, turismo, restaurantes
    (7, 5, 2000), (7, 24, 1600), (7, 6, 1400),
    // Al Sufouh · Internet City: software, telecom, escuela, marketing
    (8, 15, 2500), (8, 12, 2000), (8, 20, 2500), (8, 14, 1800),
    // JLT: oficinas, software, bufetes
    (9, 3, 1600), (9, 15, 1400), (9, 18, 1300),
    // Al Barsha: supermercados, tiendas, clínicas, gimnasios
    (10, 22, 1800), (10, 2, 1400), (10, 19, 1400), (10, 23, 1300),
    // Dubai Hills: inmobiliaria, supermercados, clínicas, constructora
    (11, 7, 1800), (11, 22, 1400), (11, 19, 1400), (11, 8, 1400),
    // Al Quoz: talleres, concesionarios, materiales, logística, constructora
    (12, 16, 3000), (12, 4, 2500), (12, 29, 3000), (12, 11, 2000), (12, 8, 1800),
    // Business Bay: inmobiliaria, marketing, oficinas, bufetes, software
    (13, 7, 2500), (13, 14, 2000), (13, 3, 1600), (13, 18, 1400), (13, 15, 1400),
    // D3: marketing, moda, software, cafeterías
    (14, 14, 2500), (14, 27, 2200), (14, 15, 1500), (14, 26, 1500),
    // Zabeel · Karama: tiendas, restaurantes, supermercados, oficinas
    (15, 2, 1600), (15, 6, 1400), (15, 22, 1400), (15, 3, 1200),
    // Bur Dubái: tiendas, restaurantes, turismo, joyería
    (16, 2, 1700), (16, 6, 1500), (16, 24, 1500), (16, 21, 1600),
    // Deira: joyería, tiendas, logística, supermercados, hoteles
    (17, 21, 3000), (17, 2, 1800), (17, 11, 1500), (17, 22, 1300), (17, 5, 1300),
    // Creek Harbour · Festival City: clínicas (Healthcare City), inmobiliaria, constructora
    (18, 19, 2500), (18, 7, 1800), (18, 8, 1500), (18, 2, 1300),
    // DXB: logística, taxi, hoteles
    (19, 11, 2500), (19, 25, 3000), (19, 5, 1400),
    // Meydan: inmobiliaria, gimnasio, turismo
    (20, 7, 1500), (20, 23, 1300), (20, 24, 1300),
    // Puerto de Jebel Ali: logística, materiales, taller, energía
    (21, 11, 3000), (21, 29, 2500), (21, 16, 1800), (21, 9, 1300),
    // Al Furjan: supermercados, clínicas, gimnasios
    (22, 22, 1600), (22, 19, 1300), (22, 23, 1300),
    // JAFZA: materiales, constructora, logística, taller
    (23, 29, 3000), (23, 8, 2000), (23, 11, 2200), (23, 16, 1600),
    // DIP: materiales, constructora, logística, granja
    (24, 29, 2000), (24, 8, 1800), (24, 11, 1600), (24, 1, 1300),
    // Expo City: escuela, software, turismo, energía
    (25, 20, 2200), (25, 15, 1800), (25, 24, 1600), (25, 9, 1800),
    // Motor City · Sports City: concesionario, taller, taxi, gimnasio
    (26, 4, 2500), (26, 16, 2200), (26, 25, 1600), (26, 23, 1600),
    // Arabian Ranches: supermercado, clínica, inmobiliaria
    (27, 22, 1500), (27, 19, 1300), (27, 7, 1400),
    // Global Village · IMG: turismo, restaurantes, tiendas
    (28, 24, 2500), (28, 6, 1800), (28, 2, 1600),
    // Dubailand: constructora, inmobiliaria, granja, energía
    (29, 8, 1800), (29, 7, 1500), (29, 1, 1500), (29, 9, 1600),
    // Silicon Oasis · Academic City: software, escuela, telecom
    (30, 15, 2500), (30, 20, 3000), (30, 12, 1800),
    // International City: supermercado, tienda, logística
    (31, 22, 1600), (31, 2, 1500), (31, 11, 1300),
    // The World: hotel, turismo
    (32, 5, 2000), (32, 24, 1800),
    // Golfo (islas artificiales): desaladora, energía, logística, hotel
    (33, 10, 2000), (33, 9, 1200), (33, 11, 1400), (33, 5, 1200),
    // Desierto: energía solar, granja, materiales
    (34, 9, 3000), (34, 1, 2000), (34, 29, 1500),
];

/// Afinidad de un sector en un distrito (permil).
pub fn afinidad(distrito_id: u8, sector_id: u8) -> u32 {
    for (dd, ss, p) in AFINIDAD {
        if *dd == distrito_id && *ss == sector_id {
            return *p;
        }
    }
    1000
}

// ---------------------------------------------------------------------------
// Mercado (compra/venta en RAMI) — memoria de operaciones
// ---------------------------------------------------------------------------

/// Una operación cerrada en el mercado de la ciudad (parcela o activo).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Trade {
    pub height: u64,
    /// 0 parcela, 1 activo.
    pub kind: u8,
    pub x: u16,
    pub y: u16,
    /// Sector de la parcela (parcela) o tipo del activo (activo).
    pub sector: u8,
    pub distrito: u8,
    pub price: Amount,
}

/// Apunta una operación (cola acotada).
pub fn apuntar_trade(trades: &mut VecDeque<Trade>, t: Trade) {
    if trades.len() >= MAX_TRADES {
        trades.pop_front();
    }
    trades.push_back(t);
}

// ---------------------------------------------------------------------------
// Economía: el reparto de cada bloque
// ---------------------------------------------------------------------------

/// Empresas por sector, en el orden de la cuadrícula (determinista).
fn por_sector(state: &State) -> Vec<Vec<(u16, u16)>> {
    let mut v: Vec<Vec<(u16, u16)>> = vec![Vec::new(); SECTORES.len()];
    for ((x, y), p) in state.parcels.iter() {
        if let Some(bucket) = v.get_mut(p.kind as usize) {
            bucket.push((*x, *y));
        }
    }
    v
}

/// Proveedor más cercano (distancia Manhattan; a igual distancia, el primero
/// en el orden de la cuadrícula) que no sea la propia parcela.
fn proveedor_mas_cercano(cands: &[(u16, u16)], x: u16, y: u16) -> Option<(u16, u16)> {
    let mut best: Option<((u16, u16), u32)> = None;
    for &(cx, cy) in cands {
        if cx == x && cy == y {
            continue;
        }
        let dist = (cx as i32 - x as i32).unsigned_abs() + (cy as i32 - y as i32).unsigned_abs();
        match best {
            Some((_, bd)) if bd <= dist => {}
            _ => best = Some(((cx, cy), dist)),
        }
    }
    best.map(|(c, _)| c)
}

/// Cobertura de insumos de un sector con las empresas que hay (permil) y la
/// lista de insumos cubiertos / sin cubrir, excluyendo la propia parcela.
fn cobertura(ps: &[Vec<(u16, u16)>], sec: &Sector, x: u16, y: u16) -> (u32, Vec<u8>, Vec<u8>) {
    if sec.insumos.is_empty() {
        return (1000, Vec::new(), Vec::new());
    }
    let mut ok = Vec::new();
    let mut falta = Vec::new();
    for &i in sec.insumos {
        if proveedor_mas_cercano(&ps[i as usize], x, y).is_some() {
            ok.push(i);
        } else {
            falta.push(i);
        }
    }
    let permil = (1000 * ok.len() as u32) / sec.insumos.len() as u32;
    (permil, ok, falta)
}

/// Puntuación de una empresa: demanda × actividad del distrito × afinidad ×
/// (1 + cobertura). Entera; sin unidades (se usa como peso relativo).
pub fn puntuacion(sec: &Sector, dist: &Distrito, cobertura_permil: u32) -> u128 {
    sec.demanda as u128 * dist.actividad as u128 * afinidad(dist.id, sec.id) as u128 * (1000 + cobertura_permil) as u128
}

/// Lo que el fondo reparte en un bloque con `fondo` acumulado.
pub fn pago_del_bloque(fondo: Amount) -> Amount {
    ((fondo as u128) * PAYOUT_BPS as u128 / 10_000) as Amount
}

/// Resultado del reparto de un bloque (para pruebas y el panel).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Reparto {
    pub repartido: Amount,
    pub a_duenos: Amount,
    pub a_proveedores: Amount,
    pub importado_quemado: Amount,
    pub empresas: usize,
}

/// El reparto del fondo de la ciudad en el bloque `height`. Muta `state`:
/// saldos de dueños y proveedores, estadísticas de las parcelas, fondo y
/// quemado. Determinista: mismo estado ⇒ mismo resultado.
pub fn tick(state: &mut State, height: u64) -> Reparto {
    let mut out = Reparto::default();
    let pago_total = pago_del_bloque(state.city_fund);
    if pago_total == 0 || state.parcels.is_empty() {
        return out;
    }
    let ps = por_sector(state);
    // 1) puntuaciones
    let mut filas: Vec<((u16, u16), u8, u128)> = Vec::with_capacity(state.parcels.len());
    let mut total: u128 = 0;
    for ((x, y), p) in state.parcels.iter() {
        let Some(sec) = sector(p.kind) else { continue };
        let dist = distrito(*x, *y);
        let (cob, _, _) = cobertura(&ps, sec, *x, *y);
        let sc = puntuacion(sec, &dist, cob);
        total += sc;
        filas.push(((*x, *y), p.kind, sc));
    }
    if total == 0 {
        return out;
    }
    // 2) reparto proporcional; de cada ingreso, SUPPLY_BPS va a los insumos
    //    (al proveedor más cercano de cada uno, o se quema si no existe).
    let mut pagos: Vec<(AccountId, Amount)> = Vec::new();
    let mut ventas: Vec<((u16, u16), Amount)> = Vec::new();
    for ((x, y), kind, sc) in filas {
        let ingreso = ((pago_total as u128) * sc / total) as Amount;
        if ingreso == 0 {
            continue;
        }
        let sec = sector(kind).expect("sector válido");
        let n = sec.insumos.len() as u64;
        let bolsa = ((ingreso as u128) * SUPPLY_BPS as u128 / 10_000) as Amount;
        let por_insumo = if n == 0 { 0 } else { bolsa / n };
        let mut a_proveedores = 0u64;
        let mut importado = 0u64;
        for &i in sec.insumos {
            match proveedor_mas_cercano(&ps[i as usize], x, y) {
                Some(prov) => {
                    let owner = state.parcels.get(&prov).map(|p| p.owner).expect("proveedor existe");
                    pagos.push((owner, por_insumo));
                    ventas.push((prov, por_insumo));
                    a_proveedores += por_insumo;
                }
                None => importado += por_insumo,
            }
        }
        let neto = ingreso - a_proveedores - importado;
        let p = state.parcels.get_mut(&(x, y)).expect("existe");
        let owner = p.owner;
        p.ingresos += neto;
        p.ultimo_ingreso = neto;
        p.ultimo_bloque = height;
        p.insumos_pagados += a_proveedores;
        p.importado += importado;
        pagos.push((owner, neto));
        out.repartido += ingreso;
        out.a_duenos += neto;
        out.a_proveedores += a_proveedores;
        out.importado_quemado += importado;
        out.empresas += 1;
    }
    for (who, amt) in pagos {
        if amt > 0 {
            state.accounts.entry(who).or_default().balance += amt;
        }
    }
    for (prov, amt) in ventas {
        if let Some(p) = state.parcels.get_mut(&prov) {
            p.ventas += amt;
        }
    }
    state.city_fund -= out.repartido;
    state.quemado += out.importado_quemado;
    out
}

// ---------------------------------------------------------------------------
// Mentor: la misma regla, usada para ACONSEJAR (no es consenso)
// ---------------------------------------------------------------------------

/// Evaluación de «montar el sector S en la parcela (x, y)» con la ciudad tal
/// como está. Usa exactamente las funciones del reparto, así que lo que dice
/// es lo que la regla haría con el estado actual (el estado cambia con cada
/// bloque: son cifras del ahora, no una promesa).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Evaluacion {
    pub sector: u8,
    pub distrito: u8,
    /// Capital necesario para empezar: precio de la parcela (0 si ya es tuya).
    pub capex: Amount,
    /// Ingreso neto estimado por bloque (tras pagar insumos) con el reparto actual.
    pub ingreso_por_bloque: Amount,
    /// Lo que cobraría por bloque como PROVEEDOR de las empresas que hoy
    /// importan este sector (no tienen a nadie que se lo venda).
    pub ventas_por_bloque: Amount,
    pub cobertura_permil: u32,
    pub insumos_cubiertos: Vec<u8>,
    pub insumos_faltantes: Vec<u8>,
    /// Empresas de la ciudad que necesitan este sector y hoy lo importan.
    pub clientes_sin_proveedor: usize,
    /// Empresas del mismo sector ya en la ciudad (competencia).
    pub competidores: usize,
    pub afinidad_permil: u32,
    /// Bloques hasta recuperar el capex con el ingreso estimado (None si 0).
    pub bloques_recuperacion: Option<u64>,
}

/// Pago por bloque con el que razona el mentor: el reparto actual del fondo
/// o, si el fondo aún está vacío, lo que entra por bloque (régimen estable).
pub fn pago_de_referencia(state: &State, emision_bloque: Amount) -> Amount {
    pago_del_bloque(state.city_fund).max(parte_ciudad(emision_bloque))
}

pub fn evaluar(state: &State, x: u16, y: u16, sector_id: u8, me: Option<&AccountId>, emision_bloque: Amount) -> Option<Evaluacion> {
    let sec = sector(sector_id)?;
    let dist = distrito(x, y);
    let ps = por_sector(state);
    let (cob, ok, falta) = cobertura(&ps, sec, x, y);
    // Total de puntuaciones de la ciudad tal como está, sin (x,y).
    let mut total: u128 = 0;
    let mut filas: Vec<((u16, u16), u8, u128)> = Vec::new();
    for ((px, py), p) in state.parcels.iter() {
        if (*px, *py) == (x, y) {
            continue;
        }
        let Some(s2) = sector(p.kind) else { continue };
        let (c2, _, _) = cobertura(&ps, s2, *px, *py);
        let sc = puntuacion(s2, &distrito(*px, *py), c2);
        total += sc;
        filas.push(((*px, *py), p.kind, sc));
    }
    let mio = puntuacion(sec, &dist, cob);
    let pago = pago_de_referencia(state, emision_bloque) as u128;
    let ingreso = if total + mio == 0 { 0 } else { pago * mio / (total + mio) };
    let bolsa = ingreso * SUPPLY_BPS as u128 / 10_000;
    let neto = ingreso - bolsa;
    // Ventas: empresas que necesitan este sector y hoy no tienen proveedor.
    let mut ventas: u128 = 0;
    let mut clientes = 0usize;
    for ((px, py), kind, sc) in &filas {
        let s2 = sector(*kind).expect("válido");
        if !s2.insumos.contains(&sector_id) {
            continue;
        }
        if proveedor_mas_cercano(&ps[sector_id as usize], *px, *py).is_some() {
            continue; // ya tiene a quien comprar
        }
        clientes += 1;
        let ing2 = if total + mio == 0 { 0 } else { pago * sc / (total + mio) };
        let bolsa2 = ing2 * SUPPLY_BPS as u128 / 10_000;
        ventas += bolsa2 / s2.insumos.len() as u128;
    }
    let capex = match state.parcels.get(&(x, y)) {
        Some(p) if me.is_some_and(|m| *m == p.owner) => 0,
        Some(_) => return None, // parcela de otro: no se puede montar ahí
        None => precio_parcela(x, y),
    };
    let ingreso_por_bloque = neto as Amount;
    let ventas_por_bloque = ventas as Amount;
    let total_bloque = ingreso_por_bloque + ventas_por_bloque;
    let bloques_recuperacion = if total_bloque == 0 { None } else { Some(capex.div_ceil(total_bloque)) };
    Some(Evaluacion {
        sector: sector_id,
        distrito: dist.id,
        capex,
        ingreso_por_bloque,
        ventas_por_bloque,
        cobertura_permil: cob,
        insumos_cubiertos: ok,
        insumos_faltantes: falta,
        clientes_sin_proveedor: clientes,
        competidores: ps[sector_id as usize].iter().filter(|c| **c != (x, y)).count(),
        afinidad_permil: afinidad(dist.id, sector_id),
        bloques_recuperacion,
    })
}

/// Todos los sectores evaluados en (x, y), de mayor a menor ingreso total
/// estimado (ingreso + ventas); a igual ingreso, por id de sector.
pub fn oportunidades(state: &State, x: u16, y: u16, me: Option<&AccountId>, emision_bloque: Amount) -> Vec<Evaluacion> {
    let mut v: Vec<Evaluacion> = SECTORES.iter().filter_map(|s| evaluar(state, x, y, s.id, me, emision_bloque)).collect();
    v.sort_by(|a, b| {
        let ta = a.ingreso_por_bloque + a.ventas_por_bloque;
        let tb = b.ingreso_por_bloque + b.ventas_por_bloque;
        tb.cmp(&ta).then(a.sector.cmp(&b.sector))
    });
    v
}

/// Sectores que la ciudad necesita y nadie ofrece (insumos importados), con
/// cuántas empresas los importan. Ordenado de más a menos demandado.
pub fn huecos(state: &State) -> Vec<(u8, usize)> {
    let ps = por_sector(state);
    let mut cuenta: BTreeMap<u8, usize> = BTreeMap::new();
    for ((x, y), p) in state.parcels.iter() {
        let Some(sec) = sector(p.kind) else { continue };
        for &i in sec.insumos {
            if proveedor_mas_cercano(&ps[i as usize], *x, *y).is_none() {
                *cuenta.entry(i).or_insert(0) += 1;
            }
        }
    }
    let mut v: Vec<(u8, usize)> = cuenta.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

/// Ayuda para las pruebas y el panel: una parcela recién creada.
pub fn nueva_parcela(owner: AccountId, name: String, kind: u8, since: u64) -> Parcel {
    Parcel {
        owner,
        name,
        kind,
        since,
        harvests: 0,
        last_harvest: None,
        sale: None,
        ingresos: 0,
        ultimo_ingreso: 0,
        ultimo_bloque: 0,
        insumos_pagados: 0,
        importado: 0,
        ventas: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distritos_cubren_lugares_reales_y_el_mar_queda_donde_toca() {
        assert_eq!(distrito(46, 17).clave, "downtown"); // Burj Khalifa ≈ (46,17)
        assert_eq!(distrito(17, 15).clave, "marina");
        assert_eq!(distrito(21, 7).clave, "palm"); // Atlantis
        assert_eq!(distrito(57, 11).clave, "deira"); // Zoco del Oro
        assert_eq!(distrito(56, 12).clave, "burdubai"); // Al Fahidi
        assert_eq!(distrito(0, 13).clave, "jebelali");
        assert_eq!(distrito(38, 2).clave, "world");
        assert_eq!(distrito(47, 4).clave, "golfo"); // mar frente a Jumeirah
        assert_eq!(distrito(21, 45).clave, "desierto"); // Al Qudra
        assert_eq!(distrito(47, 38).clave, "silicon");
        assert!(es_mar(10, 5) && !es_mar(10, 20));
        // Todos los ids son únicos y consecutivos.
        let ds = distritos();
        assert_eq!(ds.len(), NDISTRITOS);
        for (i, dd) in ds.iter().enumerate() {
            assert_eq!(dd.id as usize, i);
        }
        assert_eq!(precio_parcela(46, 17), 250 * COIN);
        assert_eq!(precio_parcela(21, 45), 5 * COIN);
    }

    #[test]
    fn el_grafo_de_insumos_es_cerrado_y_valido() {
        for (i, sec) in SECTORES.iter().enumerate() {
            assert_eq!(sec.id as usize, i);
            assert!(!sec.insumos.is_empty(), "{} sin insumos", sec.clave);
            for &ins in sec.insumos {
                assert!((ins as usize) < SECTORES.len(), "{} necesita un sector inexistente", sec.clave);
                assert_ne!(ins, sec.id, "{} se necesita a sí mismo", sec.clave);
            }
        }
        // Todo sector es insumo de alguien: nadie queda sin clientes posibles.
        for sec in SECTORES.iter() {
            assert!(SECTORES.iter().any(|o| o.insumos.contains(&sec.id)), "{} no lo necesita nadie", sec.clave);
        }
        assert_eq!(MAX_SECTOR as usize, SECTORES.len() - 1);
        assert_eq!(afinidad(17, 21), 3000); // oro en Deira
        assert_eq!(afinidad(17, 9), 1000); // lo no listado es neutro
    }

    fn ciudad_de_prueba() -> State {
        let mut st = State::default();
        let a = [1u8; 32];
        let b = [2u8; 32];
        // Hotel en Palm (necesita energía, agua, restaurante, turismo, seguridad)
        st.parcels.insert((21, 8), nueva_parcela(a, "Hotel".into(), 5, 1));
        // Restaurante en Marina (necesita granja, logística, energía, marketing)
        st.parcels.insert((17, 14), nueva_parcela(b, "Rest".into(), 6, 1));
        // Energía solar en el desierto
        st.parcels.insert((30, 50), nueva_parcela(b, "Solar".into(), 9, 1));
        st.city_fund = 1_000 * COIN;
        st
    }

    #[test]
    fn el_reparto_es_determinista_conserva_el_total_y_paga_a_proveedores() {
        let mut s1 = ciudad_de_prueba();
        let mut s2 = ciudad_de_prueba();
        let r1 = tick(&mut s1, 10);
        let r2 = tick(&mut s2, 10);
        assert_eq!(r1, r2);
        assert_eq!(s1.balance_of(&[1u8; 32]), s2.balance_of(&[1u8; 32]));
        // Se reparte el 1 % del fondo (menos redondeos), y todo lo repartido
        // acaba en dueños, proveedores o quemado.
        assert!(r1.repartido <= pago_del_bloque(1_000 * COIN));
        assert!(r1.repartido > pago_del_bloque(1_000 * COIN) - 10);
        assert_eq!(r1.repartido, r1.a_duenos + r1.a_proveedores + r1.importado_quemado);
        assert_eq!(s1.city_fund, 1_000 * COIN - r1.repartido);
        assert_eq!(s1.quemado, r1.importado_quemado);
        let total_saldos = s1.balance_of(&[1u8; 32]) + s1.balance_of(&[2u8; 32]);
        assert_eq!(total_saldos, r1.a_duenos + r1.a_proveedores);
        // La solar vende energía al hotel y al restaurante (ambos la necesitan).
        assert!(s1.parcels[&(30, 50)].ventas > 0);
        // El hotel importa lo que no existe (agua, turismo, seguridad): se quema.
        assert!(s1.parcels[&(21, 8)].importado > 0);
        assert!(r1.importado_quemado > 0);
        assert_eq!(r1.empresas, 3);
        // Sin fondo no hay reparto.
        let mut vacio = ciudad_de_prueba();
        vacio.city_fund = 0;
        assert_eq!(tick(&mut vacio, 11), Reparto::default());
    }

    #[test]
    fn el_mentor_ve_los_huecos_y_estima_con_la_misma_regla() {
        let st = ciudad_de_prueba();
        let h = huecos(&st);
        // Logística la importan el restaurante y (por energía→logística no) … al
        // menos aparece; y energía NO aparece porque existe la solar.
        assert!(h.iter().any(|(s, _)| *s == 11));
        assert!(!h.iter().any(|(s, _)| *s == 9));
        // Montar una desaladora en el mar frente a Jebel Ali: capex = precio del golfo,
        // y el hotel (que importa agua) pasa a comprarnos.
        let ev = evaluar(&st, 8, 3, 10, None, 50 * COIN).unwrap();
        assert_eq!(ev.capex, 10 * COIN);
        assert_eq!(ev.clientes_sin_proveedor, 1);
        assert!(ev.ventas_por_bloque > 0);
        assert!(ev.ingreso_por_bloque > 0);
        assert!(ev.bloques_recuperacion.is_some());
        // No se puede montar en la parcela de otro.
        assert!(evaluar(&st, 21, 8, 10, None, 50 * COIN).is_none());
        // En la propia parcela el capex es 0.
        let propia = evaluar(&st, 21, 8, 10, Some(&[1u8; 32]), 50 * COIN).unwrap();
        assert_eq!(propia.capex, 0);
        let ops = oportunidades(&st, 8, 3, None, 50 * COIN);
        assert_eq!(ops.len(), SECTORES.len());
        for w in ops.windows(2) {
            assert!(w[0].ingreso_por_bloque + w[0].ventas_por_bloque >= w[1].ingreso_por_bloque + w[1].ventas_por_bloque);
        }
    }

    #[test]
    fn parte_de_la_ciudad_y_precios() {
        assert_eq!(parte_ciudad(50 * COIN), 10 * COIN);
        assert_eq!(parte_ciudad(0), 0);
        assert_eq!(precio_acunado(2), 5 * COIN);
        assert_eq!(precio_acunado(3), 20 * COIN);
        assert_eq!(precio_acunado(0), COIN);
        let mut t = VecDeque::new();
        for i in 0..(MAX_TRADES + 5) {
            apuntar_trade(&mut t, Trade { height: i as u64, kind: 0, x: 0, y: 0, sector: 0, distrito: 0, price: 1 });
        }
        assert_eq!(t.len(), MAX_TRADES);
        assert_eq!(t.front().unwrap().height, 5);
    }
}
