/*
 * Dubái RAMI — módulo «vida»: los peatones.
 *
 * Entrega 6 del plan del metaverso (docs/METAVERSO.md): gente que va a algún
 * sitio. Los carriles y la cesión de paso de los coches van en el núcleo
 * (city3d.js, «La vida de la calle»); aquí van los peatones.
 *
 * Un peatón no es una entidad de red: es una FUNCIÓN DEL TIEMPO. Su casa, su
 * trabajo, su horario y su camino salen de enteros deducidos de datos que ya son
 * consenso (la posición de los edificios, las parcelas de la ciudad), así que la
 * posición del peatón i en el instante T es la misma en todas las máquinas que
 * tengan los mismos datos, y cuesta cero bytes de protocolo.
 *
 *   CASA: el portal de una villa o de un bloque de viviendas de un barrio con
 *     trama. De cada edificio sale un número de vecinos según su tamaño.
 *   TRABAJO: sale de la economía. Cada empresa de una parcela contrata su
 *     plantilla (según su sector, sus ingresos y sus activos) entre los
 *     trabajadores que viven más cerca de su parcela; los demás (y todos, sin
 *     parcelas: Dubái se activa el 1 de diciembre de 2026) van a las torres de
 *     oficinas —o a las naves, uno de cada cuatro— de un barrio de oficinas
 *     sorteado por gravedad: sus plantas / (1 + km)². Ver «Quién trabaja dónde».
 *   CAMINO: por las aceras de la retícula del barrio, doblando las esquinas por
 *     su curva y cruzando solo por los pasos de peatones pintados. Si el trabajo
 *     queda a más de RADIO_ANDABLE, el peatón no cruza la ciudad a pie: sale de
 *     casa hacia la parada de su barrio más cercana (en el borde del barrio, a
 *     menos de PARADA_MAX por la acera) y desaparece en su bordillo, como quien
 *     sube al metro o al autobús; al otro lado, aparece en el bordillo de la
 *     parada más cercana a su trabajo y llega andando. Sin parada a mano, en el
 *     bordillo de delante de su portal, como quien baja de un taxi. Una parcela
 *     fuera de toda trama se alcanza desde la puerta del taxi, a unas decenas de
 *     metros del portal.
 *   HORARIO: salida entre las 7:00 y las 9:30, comida para algo más de la mitad,
 *     vuelta entre las 17:00 y las 19:30, recados para quien no trabaja (uno
 *     entre las 9:00 y las 14:00 y otro entre las 15:00 y las 20:30: con la
 *     tarde a partir de las 16:00, de 15:00 a 16:00 no había nadie en la calle),
 *     un paseo de noche para uno de cada ocho y unos pocos de madrugada.
 *
 * Reglas de genotipo: todo lo que decide (quién vive dónde, dónde trabaja, a
 * qué hora sale, por qué calles va) sale de enteros —semillas, pesos enteros,
 * distancias del grafo en centímetros enteros con desempate por índice—. La
 * geometría del camino es coma flotante: pintura.
 *
 * Los coches (núcleo) se paran ante un paso de peatones ocupado: este módulo
 * marca en S.cebraOcupada los pasos que un peatón pisa o va a pisar en los
 * próximos segundos.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('vida', function (ctx) {
    var THREE = ctx.THREE, S = ctx.S, U = ctx.util, M = ctx.mundo, G = ctx.geom, CAT = ctx.catastro;
    var DIA = 86400;
    var RADIO_ANDABLE = 1200;          // más lejos que esto (en metros, por la retícula) se va en metro o taxi
    var RUTA_MAX = 3000;               // un camino más largo no se anda: el viaje no se ve
    var V_MIN = 1.2, V_MAX = 1.6;      // m/s
    // Cada paso de peatones tiene su turno: un ciclo de CICLO segundos, desfasado
    // por paso, en el que durante VENTANA segundos se empieza a cruzar (con 60 s
    // y 15 un paso de una calle de 16 m quedaba tapado unos 36 s de cada minuto
    // y en diez minutos de hora punta tres coches pasaban de un minuto parados;
    // con 90 y 12, unos 33 de cada 90). Quien
    // llega fuera de su turno espera en el bordillo. Sin esto, en hora punta un
    // paso concurrido tenía gente encima minutos seguidos —los peatones son una
    // función del tiempo y no esperan a nadie— y los coches no pasaban nunca.
    // Como la llegada al paso es función del tiempo, la espera también.
    // Desde la ronda 2 los turnos van coordinados por cruce, como un semáforo de
    // peatones: los dos pasos que cruzan la misma calle en un cruce (a un lado y
    // a otro de la otra calle) comparten turno, y los que cruzan la otra calle
    // van medio ciclo después. Con un turno por paso, un coche esperaba primero
    // al paso de su entrada y después al de su salida, con turnos sin relación:
    // en diez minutos de ultra junto a la glorieta 0, uno llegó a 62 s parado.
    var CICLO = 90, VENTANA = 12, ESPERA_MAX = 1500;
    var DMAX = Math.ceil(RUTA_MAX / V_MIN) + ESPERA_MAX;
    var R_PROC = 1600;                 // alrededor del foco se calculan los peatones (pasos ocupados)
    var MUESTRA = 2.5;                 // cada cuánto se comprueba que la acera es acera
    var MIEMBROS_R = 80;               // más lejos, el peatón va sin brazos ni piernas
    var PEATON_R = 0.35;
    var PARADA_MAX = 600;              // metros por la acera hasta la parada; más lejos, el taxi a la puerta
    // Caminos guardados. Desde la ronda 2 solo se guardan los de quien está en la
    // calle (el de un viaje acabado se suelta: basta su duración, `V.dur`), así
    // que en hora punta hay de cientos a unos pocos miles; con más de CACHE_MAX
    // se sueltan los que no se han usado en PODA_CUADROS cuadros.
    var CACHE_MAX = 8000, PODA_CUADROS = 120;
    // Una empresa de una parcela contrata a los más cercanos (ronda 2): por
    // anillos de celdas de la cuadrícula y, dentro de un anillo, por sorteo.
    // Las oficinas de los barrios de torres y naves, por gravedad: capacidad
    // (plantas) / (1 + km)².
    var KM = 1000;
    var CALIENTA_ANTES = 60;           // segundos por delante que se precalculan al cambiar la población
    var AVISO_CEBRA = 4;               // segundos antes de pisar el paso en que ya cuenta como ocupado
    // Cuántos se dibujan como mucho, y hasta dónde, por calidad. Sin sombras en
    // baja y media: la pasada de sombra dibujaría cada cuerpo otra vez.
    var TOPES = { baja: { n: 0, r: 0, sombra: false }, media: { n: 300, r: 260, sombra: false },
                  alta: { n: 800, r: 420, sombra: true }, ultra: { n: 1500, r: 650, sombra: true } };
    // La plantilla de una empresa por arquetipo de su sector (personas).
    var PLANTILLA = { torre: 300, hotel: 150, comercio: 40, concesionario: 30, industria: 80, solar: 8, agua: 25, granja: 15,
                      clinica: 90, escuela: 70, gimnasio: 20, turismo: 40, taxi: 60, seguridad: 40 };
    // Tintes claros: el color de la instancia multiplica también la piel, así
    // que la ropa se tiñe con tonos que dejan la cara en su color.
    var PALETA = [[0.95, 0.95, 0.93], [0.72, 0.82, 1.0], [1.0, 0.88, 0.72], [0.8, 0.95, 0.82], [1.0, 0.8, 0.82],
                  [0.9, 0.86, 1.0], [0.98, 0.96, 0.78], [0.75, 0.92, 0.95], [0.88, 0.88, 0.9], [1.0, 0.9, 0.86]];
    var BLANCOS = [[1, 1, 1], [0.97, 0.96, 0.92], [0.94, 0.93, 0.9]];

    var V = {
      hecho: false, firma: null, zonas: [], personas: [], viajes: [], accesos: [],
      cache: {}, uso: {}, nCache: 0, dur: null, arboles: 0, reloj: 0, horaVista: undefined, manual: null, nCuadro: 0, limite: 0, aplazados: 0, trabajo: null,
      activos: [], dibujados: [], marcadas: [], mallas: null, cap: -1, ms: 0,
      asfalto: null, cebraIdx: null, nAristas: 0, nOcupadas: 0, diag: {}, faseCebra: {}
    };

    // ---- Utilidades -----------------------------------------------------------
    function mezcla(a, b) {
      var h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x9e3779b9)) | 0;
      h = Math.imul(h ^ (h >>> 15), 0x2545f491);
      return (h ^ (h >>> 13)) >>> 0;
    }
    function enVivos(vv, s) {
      for (var i = 0; i < vv.length; i++) if (s >= vv[i][0] - 1 && s <= vv[i][1] + 1) return true;
      return false;
    }
    // SONDA (ronda 2, solo para la prueba de márgenes, `huella`): desplaza todo lo
    // que se comprueba (los puntos de las aristas y los portales). Medido: con ±1 nm
    // en x y en z sale todo igual; con ±1 µm, el grafo, sus pesos, los accesos, los
    // trabajos y los viajes salen iguales y solo cambia el redondeo a centímetros
    // del sitio de un acceso (el margen más pequeño de esos redondeos es de 1,5 µm).
    // La diferencia de un último bit en Math.sin o Math.cos entre dos motores mueve
    // un punto a 40 km del origen unos 7e-12 m: mil veces menos que el nanómetro.
    // En uso normal vale cero.
    var SONDA = { x: 0, z: 0 };
    function aMundo(Z, lx, lz) { return { x: Z.x + Z.cs * lx - Z.sn * lz + SONDA.x, z: Z.z + Z.sn * lx + Z.cs * lz + SONDA.z }; }
    function aLocal(Z, wx, wz) { var dx = wx - Z.x, dz = wz - Z.z; return { x: Z.cs * dx + Z.sn * dz, z: -Z.sn * dx + Z.cs * dz }; }

    // ---- Dónde hay calzada ------------------------------------------------------
    // Una acera que cruza la calzada de otra calle (la de un barrio vecino que se
    // monta, una vía del mapa) no es acera: esa arista del grafo no existe.
    var ASF_CELDA = 64;
    function indiceAsfalto(idx, v0, v1) {
      var vias = S.vias || [], v, j, cx, cz;
      idx = idx || {};
      for (v = v0 || 0; v < Math.min(v1 === undefined ? vias.length : v1, vias.length); v++) {
        var L = vias[v], m = L.muestras, hh = L.calzada * 0.5 + 1;
        for (j = 0; j + 1 < m.length; j++) {
          var x0 = Math.min(m[j].x, m[j + 1].x) - hh, x1 = Math.max(m[j].x, m[j + 1].x) + hh;
          var z0 = Math.min(m[j].z, m[j + 1].z) - hh, z1 = Math.max(m[j].z, m[j + 1].z) + hh;
          for (cx = Math.floor(x0 / ASF_CELDA); cx <= Math.floor(x1 / ASF_CELDA); cx++) {
            for (cz = Math.floor(z0 / ASF_CELDA); cz <= Math.floor(z1 / ASF_CELDA); cz++) {
              var k = cx + ':' + cz; (idx[k] || (idx[k] = [])).push(v, j);
            }
          }
        }
      }
      return idx;
    }
    function enAsfalto(x, z, salvo) {
      var l = V.asfalto[Math.floor(x / ASF_CELDA) + ':' + Math.floor(z / ASF_CELDA)], k;
      if (!l) return false;
      for (k = 0; k < l.length; k += 2) {
        var v = l[k]; if (v === salvo) continue;
        var L = S.vias[v], j = l[k + 1], a = L.muestras[j], b = L.muestras[j + 1];
        var dx = b.x - a.x, dz = b.z - a.z, ll = dx * dx + dz * dz; if (ll < 1e-6) continue;
        var u = ((x - a.x) * dx + (z - a.z) * dz) / ll; if (u < -0.02 || u > 1.02) continue;
        var px = a.x + dx * u - x, pz = a.z + dz * u - z;
        if (px * px + pz * pz > (L.calzada * 0.5 - 0.3) * (L.calzada * 0.5 - 0.3)) continue;
        var s = L.arco[j] + u * Math.sqrt(ll);
        if (M.enTramo(L.cortes, s) || !enVivos(L.vivos || [], s)) continue;
        return true;
      }
      return false;
    }
    function indiceCebras() {
      var idx = {}, c = S.cebras || [], i;
      for (i = 0; i < c.length; i++) { var k = Math.floor(c[i].x / 8) + ':' + Math.floor(c[i].z / 8); (idx[k] || (idx[k] = [])).push(i); }
      return idx;
    }
    /** El paso de peatones de la vía `via` cuyo centro cae a menos de 2,5 m de (x, z), o −1. */
    function cebraEn(x, z, via) {
      var i, j, k, mejor = -1, md = 6.25;
      for (i = -1; i <= 1; i++) for (j = -1; j <= 1; j++) {
        var l = V.cebraIdx[(Math.floor(x / 8) + i) + ':' + (Math.floor(z / 8) + j)]; if (!l) continue;
        for (k = 0; k < l.length; k++) {
          var c = S.cebras[l[k]]; if (c.via !== via) continue;
          var d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
          if (d < md) { md = d; mejor = c.id; }
        }
      }
      return mejor;
    }

    // ---- El grafo de las aceras de un barrio ---------------------------------------
    // La retícula de un barrio (tramaBarrio en el núcleo) son dos familias de
    // calles paralelas cada `paso` metros dentro de un círculo. En el marco local
    // de la retícula, la calle k de la familia 1 corre por lx = k·paso y la j de la
    // familia 0 por lz = j·paso; la familia 0 manda en sus cruces.
    //
    // Cada cruce (k, j) tiene cuatro esquinas; cada esquina, dos nodos: A en la
    // acera de la calle j, donde empieza la curva de la esquina, y B en la de la
    // calle k. Las aristas son los lados de las manzanas (A–A, B–B), la vuelta a la
    // esquina (A–B, por la curva de la acera) y los pasos de peatones (A–A
    // cruzando la calle k, B–B cruzando la j), que existen solo si el núcleo ha
    // pintado ese paso. Una arista que pisa agua, un edificio o la calzada de otra
    // calle no existe.
    function zonaDeTrama(zi) {
      var t = S.tramas[zi], n = Math.floor(t.R / t.paso), k;
      var Z = { i: zi, tipo: 'trama', kind: t.kind, x: t.x, z: t.z, R: t.R + 60, cs: Math.cos(t.ang), sn: Math.sin(t.ang),
                paso: t.paso, n: n, h: t.calzada * 0.5, ac: t.acera, Rr: t.radio, semi: [], via: [[], []],
                aristas: [], adj: {}, lados: {}, accesos: [], viajes: [], t0s: null, arbol: {} };
      Z.nNodos = (2 * n + 1) * (2 * n + 1) * 8;
      Z.m = Z.h + 0.45 + Z.ac * 0.5;                       // la línea por la que se anda
      Z.T = Z.h + Z.Rr;                                    // donde empieza la curva de la esquina
      Z.Dc = Z.h + 0.45 + Z.ac + 0.3 + 1.25;               // el centro del paso, desde el eje de la otra
      var lo = Z.m, hi = Z.T, it;
      for (it = 0; it < 40; it++) { var md = (lo + hi) * 0.5; if (curva(Z, md) > md) lo = md; else hi = md; }
      Z.q = (lo + hi) * 0.5;                               // donde se juntan las dos curvas de la esquina
      for (k = -n; k <= n; k++) {
        var sm = Math.sqrt(Math.max(0, t.R * t.R - k * t.paso * k * t.paso));
        Z.semi.push(sm >= t.paso * 0.6 ? sm : -1);
      }
      var vias = S.vias || [];
      for (k = 0; k < vias.length; k++) if (vias[k].barrio === zi) Z.via[vias[k].familia][vias[k].k + n] = k;
      return Z;
    }
    /** La línea por la que se anda junto a una calle, separándose en la esquina con el ensanche del bordillo. */
    function curva(Z, d) { return Z.m + M.ensancheBoca(d - Z.h, Z.Rr); }
    function semiDe(Z, k) { return Math.abs(k) <= Z.n ? Z.semi[k + Z.n] : -1; }
    function viaDe(Z, fam, k) { var v = Math.abs(k) <= Z.n ? Z.via[fam][k + Z.n] : undefined; return v === undefined ? -1 : v; }
    function cruceExiste(Z, k, j) {
      var sk = semiDe(Z, k), sj = semiDe(Z, j);
      return sk > 0 && sj > 0 && Math.abs(k * Z.paso) <= sj && Math.abs(j * Z.paso) <= sk && viaDe(Z, 1, k) >= 0 && viaDe(Z, 0, j) >= 0;
    }
    /** Identificador de un nodo: cruce (k, j), esquina (sx, sz) y acera (0 = A, 1 = B). */
    function nodo(Z, k, j, sx, sz, ab) {
      // Fuera de la retícula no hay nodo: sin esta guarda, la manzana n+1 de un
      // portal en el borde del círculo caía en el índice de otra fila entera.
      if (Math.abs(k) > Z.n || Math.abs(j) > Z.n) return -1;
      var w = 2 * Z.n + 1;
      return ((((k + Z.n) * w + (j + Z.n)) * 4 + (sx > 0 ? 1 : 0) + (sz > 0 ? 2 : 0)) * 2) + ab;
    }
    /**
     * Dónde está un nodo, en el marco local: en la línea por la que se anda o,
     * con `bordillo`, a 0,35 m del borde del bordillo (donde para un coche). El
     * nodo A de la esquina (sx, sz) del cruce (k, j) está en la acera de la calle
     * j, donde empieza la curva; el B, en la de la calle k.
     */
    function nodoLocal(Z, id, bordillo) {
      var w = 2 * Z.n + 1, ab = id % 2, q = (id - ab) / 2, es = q % 4, r = (q - es) / 4;
      var sx = es & 1 ? 1 : -1, sz = es & 2 ? 1 : -1, j = r % w - Z.n, k = (r - (r % w)) / w - Z.n;
      var d = bordillo ? Z.h + 0.8 : Z.m;
      return ab === 0 ? [k * Z.paso + sx * Z.T, j * Z.paso + sz * d] : [k * Z.paso + sx * d, j * Z.paso + sz * Z.T];
    }
    /**
     * Las paradas del barrio (ronda 1): donde bajan del metro o del autobús
     * quienes vienen de lejos. En cada una de las ocho direcciones (cada 45°), el
     * nodo con acera más alejado del centro en esa dirección (a igualdad, el de
     * índice menor): paradas en el borde del barrio, junto a las calles por las
     * que se llega. Antes, el que venía de lejos aparecía en un nodo sorteado a
     * 120–450 m de su destino, en mitad de la acera; ahora aparece en el bordillo
     * de una parada, y si no hay ninguna a menos de PARADA_MAX, en el bordillo de
     * delante de su portal, como si bajara de un taxi.
     */
    function paradasDe(Z) {
      // Direcciones enteras (sin seno ni coseno: su último bit puede cambiar de un
      // motor a otro) y proyección redondeada a centímetros.
      var out = [], a, id, DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
      for (a = 0; a < 8; a++) {
        var dx = DIRS[a][0], dz = DIRS[a][1], mejor = -1, mp = -Infinity;
        for (id in Z.adj) {
          if (!Object.prototype.hasOwnProperty.call(Z.adj, id)) continue;
          var n = +id, l = nodoLocal(Z, n, false), pr = Math.round((l[0] * dx + l[1] * dz) * 100);
          if (pr > mp || (pr === mp && n < mejor)) { mp = pr; mejor = n; }
        }
        if (mejor >= 0 && out.indexOf(mejor) < 0) out.push(mejor);
      }
      out.sort(function (x, y) { return x - y; });
      return out;
    }
    /** El bordillo de un nodo, en mundo y con cota. */
    function bordilloDe(Z, id) {
      var l = nodoLocal(Z, id, true), w = aMundo(Z, l[0], l[1]);
      return [w.x, cotaEn(Z, l[0], l[1], w.x, w.z), w.z];
    }
    /** ¿Tiene acera la esquina? Las dos calles tienen que llegar más allá de la curva. */
    function esquinaExiste(Z, k, j, sx, sz) {
      return cruceExiste(Z, k, j) && Math.abs(k * Z.paso + sx * Z.T) <= semiDe(Z, j) - 1 && Math.abs(j * Z.paso + sz * Z.T) <= semiDe(Z, k) - 1;
    }
    /** La cota de la acera (o del paso) en un punto local: la de la calzada de la calle más cercana, más el bordillo. */
    function cotaEn(Z, lx, lz, wx, wz) {
      var y = M.groundH(wx, wz), k = Math.round(lx / Z.paso), j = Math.round(lz / Z.paso);
      var dX = Math.abs(lx - k * Z.paso), dY = Math.abs(lz - j * Z.paso), lim = Z.h + 0.45 + Z.ac + 0.8, v, sm;
      if (dX < lim && (v = viaDe(Z, 1, k)) >= 0 && (sm = semiDe(Z, k)) > 0) y = Math.max(y, M.cotaVia(S.vias[v], lz + sm) + (dX > Z.h + 0.4 ? 0.18 : 0));
      if (dY < lim && (v = viaDe(Z, 0, j)) >= 0 && (sm = semiDe(Z, j)) > 0) y = Math.max(y, M.cotaVia(S.vias[v], lx + sm) + (dY > Z.h + 0.4 ? 0.18 : 0));
      return y;
    }
    /**
     * Da de alta una arista con su polilínea local `pts` ([lx, lz, cruza]):
     * se densifica, se comprueba cada MUESTRA metros y se guarda en metros de
     * mundo con su cota. `cruza` marca el tramo del paso de peatones (ese sí
     * pisa la calzada de la calle que cruza, y solo esa). Devuelve el índice o −1.
     */
    function arista(Z, a, b, pts, cebra, viaCruzada) {
      var xs = [], ys = [], zs = [], ds = [], i, k, d = 0, c0 = -1, c1 = -1, ci0 = -1, ci1 = -1;
      for (i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (i > 0) {
          var q = pts[i - 1], L = Math.sqrt((p[0] - q[0]) * (p[0] - q[0]) + (p[1] - q[1]) * (p[1] - q[1]));
          if (L < 1e-3) continue;
          var nn = Math.max(1, Math.ceil(L / (p[2] && q[2] ? 1 : MUESTRA)));
          for (k = 1; k <= nn; k++) {
            var f = k / nn, lx = q[0] + (p[0] - q[0]) * f, lz = q[1] + (p[1] - q[1]) * f, w = aMundo(Z, lx, lz);
            var cruza = p[2] && q[2];
            if (M.surfaceH(w.x, w.z) <= 0.6) return -1;
            if (CAT.bajo(w.x, w.z)) return -1;
            if (enAsfalto(w.x, w.z, cruza ? viaCruzada : -2)) return -1;
            d += L / nn;
            if (cruza && c0 < 0) { c0 = d - L / nn; ci0 = xs.length - 1; }
            if (cruza) { c1 = d; ci1 = xs.length; }
            xs.push(w.x); zs.push(w.z); ys.push(cotaEn(Z, lx, lz, w.x, w.z)); ds.push(d);
          }
        } else {
          var w0 = aMundo(Z, p[0], p[1]);
          if (M.surfaceH(w0.x, w0.z) <= 0.6 || CAT.bajo(w0.x, w0.z)) return -1;
          xs.push(w0.x); zs.push(w0.z); ys.push(cotaEn(Z, p[0], p[1], w0.x, w0.z)); ds.push(0);
        }
      }
      if (d < 0.5) return -1;
      var e = { a: a, b: b, x: new Float32Array(xs), y: new Float32Array(ys), z: new Float32Array(zs), d: new Float32Array(ds), len: d,
                peso: Math.max(1, Math.round(d * 100)), cebra: cebra, c0: c0, c1: c1, ci0: ci0, ci1: ci1 };
      var id = Z.aristas.length; Z.aristas.push(e);
      (Z.adj[a] || (Z.adj[a] = [])).push(id); (Z.adj[b] || (Z.adj[b] = [])).push(id);
      return id;
    }
    // Puntos de las curvas de una esquina, en distancias (X al eje de la calle k,
    // Y al de la j) de su cuadrante.
    function tramoCurva0(Z, X0, X1, out) {                 // por la acera de la calle j, X de X0 a X1
      for (var i = 0; i <= 3; i++) { var X = X0 + (X1 - X0) * i / 3; out.push([X, curva(Z, X)]); }
    }
    function tramoCurva1(Z, Y0, Y1, out) {                 // por la acera de la calle k, Y de Y0 a Y1
      for (var i = 0; i <= 3; i++) { var Y = Y0 + (Y1 - Y0) * i / 3; out.push([curva(Z, Y), Y]); }
    }
    function enCuadrante(Z, k, j, sx, sz, XY, cruza, out) {
      for (var i = 0; i < XY.length; i++) out.push([k * Z.paso + sx * XY[i][0], j * Z.paso + sz * XY[i][1], cruza ? 1 : 0]);
      return out;
    }
    /** Las aristas del cruce (k, j) (la construcción va cruce a cruce: ver trabajoPaso). */
    function cruceGrafo(Z, k, j) {
      var sx, sz, i, XY, pts, c;
      {
        if (!cruceExiste(Z, k, j)) return;
        for (i = 0; i < 4; i++) {
          sx = i & 1 ? 1 : -1; sz = i & 2 ? 1 : -1;
          if (!esquinaExiste(Z, k, j, sx, sz)) continue;
          // La vuelta a la esquina: de A a B por las dos curvas.
          XY = []; tramoCurva0(Z, Z.T, Z.q, XY); tramoCurva1(Z, Z.q, Z.T, XY); XY.splice(4, 1);
          arista(Z, nodo(Z, k, j, sx, sz, 0), nodo(Z, k, j, sx, sz, 1), enCuadrante(Z, k, j, sx, sz, XY, false, []));
        }
        for (sz = -1; sz <= 1; sz += 2) {
          // Cruzar la calle k (la que cede) por su paso, en el lado sz de la calle j.
          if (!esquinaExiste(Z, k, j, -1, sz) || !esquinaExiste(Z, k, j, 1, sz)) continue;
          var cw = aMundo(Z, k * Z.paso, j * Z.paso + sz * Z.Dc), ce = cebraEn(cw.x, cw.z, viaDe(Z, 1, k));
          if (ce < 0) continue;
          V.faseCebra[ce] = faseCruce(Z, k, j, 0);
          XY = []; tramoCurva0(Z, Z.T, Z.q, XY); tramoCurva1(Z, Z.q, Math.min(Z.Dc, Z.T), XY); XY.splice(4, 1);
          if (Z.Dc > Z.T) XY.push([Z.m, Z.Dc]);
          pts = enCuadrante(Z, k, j, -1, sz, XY, false, []);
          pts[pts.length - 1][2] = 1;
          c = enCuadrante(Z, k, j, 1, sz, XY.slice().reverse(), false, []);
          c[0][2] = 1;
          arista(Z, nodo(Z, k, j, -1, sz, 0), nodo(Z, k, j, 1, sz, 0), pts.concat(c), ce, viaDe(Z, 1, k));
        }
        for (sx = -1; sx <= 1; sx += 2) {
          // Cruzar la calle j (la que manda) por su paso, en el lado sx de la calle k.
          if (!esquinaExiste(Z, k, j, sx, -1) || !esquinaExiste(Z, k, j, sx, 1)) continue;
          var cw2 = aMundo(Z, k * Z.paso + sx * Z.Dc, j * Z.paso), ce2 = cebraEn(cw2.x, cw2.z, viaDe(Z, 0, j));
          if (ce2 < 0) continue;
          V.faseCebra[ce2] = faseCruce(Z, k, j, 1);
          XY = []; tramoCurva1(Z, Z.T, Z.q, XY); tramoCurva0(Z, Z.q, Math.min(Z.Dc, Z.T), XY); XY.splice(4, 1);
          if (Z.Dc > Z.T) XY.push([Z.Dc, Z.m]);
          pts = enCuadrante(Z, k, j, sx, -1, XY, false, []);
          pts[pts.length - 1][2] = 1;
          c = enCuadrante(Z, k, j, sx, 1, XY.slice().reverse(), false, []);
          c[0][2] = 1;
          arista(Z, nodo(Z, k, j, sx, -1, 1), nodo(Z, k, j, sx, 1, 1), pts.concat(c), ce2, viaDe(Z, 0, j));
        }
        // Los lados de manzana que salen de este cruce hacia +k y hacia +j.
        for (sz = -1; sz <= 1; sz += 2) {
          if (!esquinaExiste(Z, k, j, 1, sz) || !esquinaExiste(Z, k + 1, j, -1, sz)) continue;
          var ya = j * Z.paso + sz * Z.m;
          i = arista(Z, nodo(Z, k, j, 1, sz, 0), nodo(Z, k + 1, j, -1, sz, 0), [[k * Z.paso + Z.T, ya, 0], [(k + 1) * Z.paso - Z.T, ya, 0]]);
          if (i >= 0) Z.lados[nodo(Z, k, j, 1, sz, 0) + ':' + nodo(Z, k + 1, j, -1, sz, 0)] = i;
        }
        for (sx = -1; sx <= 1; sx += 2) {
          if (!esquinaExiste(Z, k, j, sx, 1) || !esquinaExiste(Z, k, j + 1, sx, -1)) continue;
          var xa = k * Z.paso + sx * Z.m;
          i = arista(Z, nodo(Z, k, j, sx, 1, 1), nodo(Z, k, j + 1, sx, -1, 1), [[xa, j * Z.paso + Z.T, 0], [xa, (j + 1) * Z.paso - Z.T, 0]]);
          if (i >= 0) Z.lados[nodo(Z, k, j, sx, 1, 1) + ':' + nodo(Z, k, j + 1, sx, -1, 1)] = i;
        }
      }
    }
    /** El turno de los pasos del cruce (k, j) de la zona Z que cruzan la calle k (`cual` 0) o la j (1): enteros. */
    function faseCruce(Z, k, j, cual) {
      return (mezcla(mezcla(Z.i + 1, k + 4096), j + 4096) % CICLO + cual * (CICLO >> 1)) % CICLO;
    }
    function cierraGrafo(Z) {
      V.nAristas += Z.aristas.length;
      Z.paradas = paradasDe(Z);
    }
    /**
     * El acceso de un portal a la acera: la manzana en la que cae, el lado más
     * cercano cuya arista existe y cuyo camino hasta la puerta no pisa nada.
     * Devuelve { e, u, P, F } (arista, metros desde su nodo a, portal y pie en la
     * acera, con cota) o null.
     */
    function acceso(Z, px, pz, py) {
      var l = aLocal(Z, px, pz), i = Math.floor(l.x / Z.paso), j = Math.floor(l.z / Z.paso), P = Z.paso, lados = [], k;
      // Oeste, este, sur y norte de la manzana (i, j): [distancia, clave, pie local].
      var aX = i * P + Z.T, bX = (i + 1) * P - Z.T, aZ = j * P + Z.T, bZ = (j + 1) * P - Z.T;
      if (bZ > aZ + 1) {
        lados.push([Math.abs(l.x - (i * P + Z.m)), nodo(Z, i, j, 1, 1, 1) + ':' + nodo(Z, i, j + 1, 1, -1, 1), i * P + Z.m, U.clamp(l.z, aZ + 0.5, bZ - 0.5), 1]);
        lados.push([Math.abs(l.x - ((i + 1) * P - Z.m)), nodo(Z, i + 1, j, -1, 1, 1) + ':' + nodo(Z, i + 1, j + 1, -1, -1, 1), (i + 1) * P - Z.m, U.clamp(l.z, aZ + 0.5, bZ - 0.5), 1]);
      }
      if (bX > aX + 1) {
        lados.push([Math.abs(l.z - (j * P + Z.m)), nodo(Z, i, j, 1, 1, 0) + ':' + nodo(Z, i + 1, j, -1, 1, 0), U.clamp(l.x, aX + 0.5, bX - 0.5), j * P + Z.m, 0]);
        lados.push([Math.abs(l.z - ((j + 1) * P - Z.m)), nodo(Z, i, j + 1, 1, -1, 0) + ':' + nodo(Z, i + 1, j + 1, -1, -1, 0), U.clamp(l.x, aX + 0.5, bX - 0.5), (j + 1) * P - Z.m, 0]);
      }
      lados.sort(function (a, b) { return a[0] - b[0]; });
      var motivo = 'sinLado';
      for (k = 0; k < lados.length; k++) {
        var ei = Z.lados[lados[k][1]]; if (ei === undefined) continue;
        var e = Z.aristas[ei], F = aMundo(Z, lados[k][2], lados[k][3]);
        // El camino del portal a la acera: libre de edificios, de agua y de calzada.
        var dx = F.x - px, dz = F.z - pz, L = Math.sqrt(dx * dx + dz * dz), ok = L < 120, s;
        if (!ok) motivo = 'lejos';
        // Con 0,8 m de holgura a cada lado: el peatón anda apartado de la línea.
        var hx = L > 0 ? -dz / L * 0.8 : 0, hz = L > 0 ? dx / L * 0.8 : 0;
        for (s = 0.6; ok && s < L; s += MUESTRA) {
          var x = px + dx * s / L, z = pz + dz * s / L;
          if (M.surfaceH(x, z) <= 0.6) { ok = false; motivo = 'agua'; }
          else if (CAT.bajo(x, z) || (s > 1.5 && (CAT.bajo(x + hx, z + hz) || CAT.bajo(x - hx, z - hz)))) { ok = false; motivo = 'edificio'; }
          else if (enAsfalto(x, z, -2)) { ok = false; motivo = 'calzada'; }
        }
        if (!ok) continue;
        var u = Math.sqrt((F.x - e.x[0]) * (F.x - e.x[0]) + (F.z - e.z[0]) * (F.z - e.z[0]));
        // El bordillo de delante (donde para el taxi): del pie en la acera hacia
        // el eje de la calle, hasta 0,35 m del borde del bordillo.
        var cl = [lados[k][2], lados[k][3]], fam = lados[k][4] === 1 ? 0 : 1, eje = Math.round(cl[fam] / P) * P;
        cl[fam] = eje + (cl[fam] > eje ? 1 : -1) * (Z.h + 0.8);
        var Cw = aMundo(Z, cl[0], cl[1]);
        return { e: ei, u: Math.min(e.len - 0.1, Math.max(0.1, u)), P: [px, py, pz], F: [F.x, cotaEn(Z, lados[k][2], lados[k][3], F.x, F.z), F.z],
                 C: [Cw.x, cotaEn(Z, cl[0], cl[1], Cw.x, Cw.z), Cw.z] };
      }
      V.diag[motivo] = (V.diag[motivo] || 0) + 1;
      return null;
    }

    // ---- Caminos: Dijkstra con pesos enteros --------------------------------------
    // Los pesos son centímetros enteros y el montículo desempata por el índice del
    // nodo: en una retícula hay muchos caminos igual de largos, y con distancias de
    // coma flotante dos máquinas eligen distinto si un empate cae en el último bit. Así eligen igual.
    function arbolDe(Z, ac) {
      var key = ac.id, A = Z.arbol[key];
      if (A) return A;
      var nN = Z.nNodos, dist = new Int32Array(nN), prev = new Int32Array(nN), Hk = [], Hn = [], e = Z.aristas[ac.e], q;
      for (q = 0; q < nN; q++) { dist[q] = -1; prev[q] = -2; }
      function sube(i) { while (i > 0) { var p = (i - 1) >> 1; if (Hk[i] < Hk[p] || (Hk[i] === Hk[p] && Hn[i] < Hn[p])) { var tk = Hk[i]; Hk[i] = Hk[p]; Hk[p] = tk; tk = Hn[i]; Hn[i] = Hn[p]; Hn[p] = tk; i = p; } else break; } }
      function baja(i) {
        var n = Hk.length;
        for (;;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < n && (Hk[l] < Hk[m] || (Hk[l] === Hk[m] && Hn[l] < Hn[m]))) m = l;
          if (r < n && (Hk[r] < Hk[m] || (Hk[r] === Hk[m] && Hn[r] < Hn[m]))) m = r;
          if (m === i) return;
          var tk = Hk[i]; Hk[i] = Hk[m]; Hk[m] = tk; tk = Hn[i]; Hn[i] = Hn[m]; Hn[m] = tk; i = m;
        }
      }
      function mete(nd, dd, pe) {
        if (dist[nd] >= 0 && dist[nd] <= dd) return;
        dist[nd] = dd; prev[nd] = pe; Hk.push(dd); Hn.push(nd); sube(Hk.length - 1);
      }
      var ua = Math.round(ac.u * 100);
      mete(e.a, ua, -1); mete(e.b, Math.max(0, e.peso - ua), -1);
      while (Hk.length) {
        var dk = Hk[0], nd = Hn[0], lk = Hk.pop(), ln = Hn.pop();
        if (Hk.length) { Hk[0] = lk; Hn[0] = ln; baja(0); }
        if (dk > dist[nd]) continue;
        var ad = Z.adj[nd] || [], i;
        for (i = 0; i < ad.length; i++) {
          var ed = Z.aristas[ad[i]], otro = ed.a === nd ? ed.b : ed.a;
          mete(otro, dk + ed.peso, ad[i]);
        }
      }
      A = { dist: dist, prev: prev };
      // Unos 11 kB por árbol en el barrio más grande: se guardan hasta 800.
      if (V.arboles > 800) { for (q = 0; q < V.zonas.length; q++) V.zonas[q].arbol = {}; V.arboles = 0; }
      Z.arbol[key] = A; V.arboles++;
      return A;
    }
    /** Coste entero (cm) de ir del acceso origen de `A` al acceso `b`, y por qué nodo. */
    function hastaAcceso(Z, A, ac, b) {
      var e = Z.aristas[b.e], ub = Math.round(b.u * 100), best = null, via = null, x;
      if (A.dist[e.a] >= 0) { x = A.dist[e.a] + ub; best = x; via = e.a; }
      if (A.dist[e.b] >= 0) { x = A.dist[e.b] + e.peso - ub; if (best === null || x < best) { best = x; via = e.b; } }
      if (ac.e === b.e) { x = Math.abs(Math.round(ac.u * 100) - ub); if (best === null || x <= best) { best = x; via = -1; } }
      return best === null ? null : { cm: best, nodo: via };
    }
    /** La polilínea de una arista entre dos distancias (u0 → u1, al revés si u1 < u0). */
    function trozo(e, u0, u1, out, ceb, base) {
      var i, n = e.d.length, sube = u1 >= u0, lo = Math.min(u0, u1), hi = Math.max(u0, u1);
      function pt(u) {
        var k = 0; while (k + 1 < n && e.d[k + 1] < u) k++;
        if (k + 1 >= n) return [e.x[n - 1], e.y[n - 1], e.z[n - 1]];
        var f = (u - e.d[k]) / Math.max(1e-6, e.d[k + 1] - e.d[k]);
        return [e.x[k] + (e.x[k + 1] - e.x[k]) * f, e.y[k] + (e.y[k + 1] - e.y[k]) * f, e.z[k] + (e.z[k + 1] - e.z[k]) * f];
      }
      // Los dos extremos del tramo del paso van marcados ([3] = el paso): así se
      // mide dónde empieza y acaba sobre la polilínea ya apartada, sin escalar.
      var lista = [pt(lo)];
      for (i = 0; i < n; i++) if (e.d[i] > lo + 1e-3 && e.d[i] < hi - 1e-3) lista.push(i === e.ci0 || i === e.ci1 ? [e.x[i], e.y[i], e.z[i], e.cebra] : [e.x[i], e.y[i], e.z[i]]);
      lista.push(pt(hi));
      if (!sube) lista.reverse();
      for (i = 0; i < lista.length; i++) out.push(lista[i]);
      return hi - lo;
    }
    /**
     * El camino de un viaje: del portal del acceso `ac` al destino `dst` —otro
     * acceso o un nodo—, como polilínea de mundo. Con `vuelta` se recorre al
     * revés. Devuelve { x, y, z, d, L, ceb } o null.
     */
    function camino(Z, ac, dst, vuelta, lado) {
      var A = arbolDe(Z, ac), fin, pts = [], ceb = [], base = 0, e0 = Z.aristas[ac.e], nodos = [], aris = [], nd, uFin = 0, eFin = null;
      if (dst.acc) {
        fin = hastaAcceso(Z, A, ac, dst.acc); if (!fin) return null;
        eFin = Z.aristas[dst.acc.e]; uFin = dst.acc.u;
      } else {
        if (!(A.dist[dst.nodo] >= 0)) return null;
        fin = { cm: A.dist[dst.nodo], nodo: dst.nodo };
      }
      if (fin.cm > RUTA_MAX * 100) return null;
      pts.push(ac.P.slice(), ac.F.slice());
      base = Math.sqrt((ac.P[0] - ac.F[0]) * (ac.P[0] - ac.F[0]) + (ac.P[2] - ac.F[2]) * (ac.P[2] - ac.F[2]));
      if (fin.nodo === -1) {
        base += trozo(e0, ac.u, uFin, pts, ceb, base);
      } else {
        nd = fin.nodo;
        while (A.prev[nd] >= 0) { var pe = A.prev[nd]; aris.push(pe); nodos.push(nd); var ed = Z.aristas[pe]; nd = ed.a === nd ? ed.b : ed.a; }
        // nd es el extremo de la arista de salida por el que se sale.
        base += trozo(e0, ac.u, nd === e0.a ? 0 : e0.len, pts, ceb, base);
        for (var i = aris.length - 1; i >= 0; i--) {
          var E = Z.aristas[aris[i]], haciaB = E.b === nodos[i];
          base += trozo(E, haciaB ? 0 : E.len, haciaB ? E.len : 0, pts, ceb, base);
        }
        if (eFin) base += trozo(eFin, fin.nodo === eFin.a ? 0 : eFin.len, uFin, pts, ceb, base);
      }
      if (dst.acc) pts.push(dst.acc.F.slice(), dst.acc.P.slice());
      else if (dst.bordillo) pts.push(dst.bordillo.slice());
      return monta(pts, ceb, vuelta, lado, !!dst.acc);
    }
    /**
     * Monta la polilínea: quita puntos repetidos, la aparta `lado` metros a la
     * derecha del sentido de marcha (cada uno por su derecha, así que los que se
     * cruzan no se atraviesan), acumula distancias y recoloca los pasos.
     */
    function monta(pts, ceb, vuelta, lado, finPortal) {
      var i, limpio = [], total = 0;
      for (i = 1; i < pts.length; i++) total += Math.sqrt((pts[i][0] - pts[i - 1][0]) * (pts[i][0] - pts[i - 1][0]) + (pts[i][2] - pts[i - 1][2]) * (pts[i][2] - pts[i - 1][2]));
      for (i = 0; i < pts.length; i++) {
        var u = limpio.length ? limpio[limpio.length - 1] : null;
        if (u && Math.abs(u[0] - pts[i][0]) < 0.02 && Math.abs(u[2] - pts[i][2]) < 0.02) { if (pts[i][3] !== undefined) u[3] = pts[i][3]; continue; }
        limpio.push(pts[i]);
      }
      if (vuelta) limpio.reverse();
      var n = limpio.length; if (n < 2) return null;
      // En un portal no se aparta: se sale y se entra por la puerta.
      var portalIni = vuelta ? finPortal : true, portalFin = vuelta ? true : finPortal;
      var X = new Float32Array(n), Y = new Float32Array(n), Zz = new Float32Array(n), D = new Float64Array(n), abiertos = 0, marca = {};
      for (i = 0; i < n; i++) {
        // ¿Está este punto en el tramo de un paso? (entre las dos marcas del paso)
        var mk = limpio[i][3], enPaso = abiertos > 0;
        if (mk !== undefined) { if (marca[mk]) { delete marca[mk]; abiertos--; } else { marca[mk] = 1; abiertos++; } enPaso = true; }
        var p = limpio[i], nx = 0, nz = 0, a = i > 0 ? limpio[i - 1] : null, b = i + 1 < n ? limpio[i + 1] : null, l;
        var d1x = 0, d1z = 0, d2x = 0, d2z = 0;
        if (a) { d1x = p[0] - a[0]; d1z = p[2] - a[2]; l = Math.sqrt(d1x * d1x + d1z * d1z) || 1; d1x /= l; d1z /= l; }
        if (b) { d2x = b[0] - p[0]; d2z = b[2] - p[2]; l = Math.sqrt(d2x * d2x + d2z * d2z) || 1; d2x /= l; d2z /= l; }
        if (!a) { if (!portalIni) { nx = -d2z; nz = d2x; } }
        else if (!b) { if (!portalFin) { nx = -d1z; nz = d1x; } }
        else {
          // Inglete: la suma de las dos normales, alargada para que el apartado
          // sea el mismo en los dos tramos (sin pasar del doble en los picos).
          var mx = -d1z - d2z, mz = d1x + d2x, ml = Math.sqrt(mx * mx + mz * mz);
          if (ml > 0.2) { mx /= ml; mz /= ml; var co = Math.max(0.5, -mx * d1z + mz * d1x); nx = mx / co; nz = mz / co; }
          else { nx = -d1z; nz = d1x; }
        }
        X[i] = p[0] + nx * lado; Y[i] = p[1]; Zz[i] = p[2] + nz * lado;
        // Apartado, un vértice de una esquina puede caer en la calzada de la otra
        // calle (ronda 2: 2 de 128.791 muestras de un día entero); fuera de los
        // pasos, entonces, se queda en la línea de la acera.
        if (!enPaso && lado && V.asfalto && enAsfalto(X[i], Zz[i], -2) && !enAsfalto(p[0], p[2], -2)) { X[i] = p[0]; Zz[i] = p[2]; }
        D[i] = i ? D[i - 1] + Math.sqrt((X[i] - X[i - 1]) * (X[i] - X[i - 1]) + (Zz[i] - Zz[i - 1]) * (Zz[i] - Zz[i - 1])) : 0;
      }
      var L = D[n - 1], cb = [], abierto = {};
      // Los pasos, en el orden en que se pisan: entre sus dos puntos marcados.
      for (i = 0; i < n; i++) {
        var id = limpio[i][3]; if (id === undefined) continue;
        if (abierto[id] === undefined) abierto[id] = D[i];
        else { cb.push(id, abierto[id], D[i]); delete abierto[id]; }
      }
      return { x: X, y: Y, z: Zz, d: D, L: L, ceb: cb };
    }
    /** Un camino recto de la puerta del taxi al portal (parcelas fuera de toda trama). */
    function caminoRecto(ac, vuelta) {
      var pts = [ac.T.slice(), ac.P.slice()];
      return monta(pts, [], vuelta, 0, true);
    }
    /** Del portal al bordillo de delante, donde para el taxi (con `vuelta`, del bordillo al portal). */
    function caminoTaxi(ac, vuelta, lado) {
      if (!ac.C) return null;
      return monta([ac.P.slice(), ac.F.slice(), ac.C.slice()], [], vuelta, lado, false);
    }

    // ---- La gente -----------------------------------------------------------------
    function plantilla(pc) {
      var arch = (M.SECTOR_ARCH[pc.kind | 0] || 'torre'), base = PLANTILLA[arch] || 40, ing = Math.floor((pc.ingresos || 0) / 1e8), bits = 0;
      while (ing >= 2 && bits < 12) { ing = Math.floor(ing / 2); bits++; }
      return base + Math.min(base * 2, Math.floor(bits * base / 4)) + Math.min(200, (pc.assets | 0) * 10);
    }
    /** La trama en la que cae un punto: la primera que lo contiene, como hace el núcleo al orientar los edificios. */
    function tramaDe(x, z) {
      for (var i = 0; i < S.tramas.length; i++) { var t = S.tramas[i], dx = x - t.x, dz = z - t.z; if (dx * dx + dz * dz <= t.R * t.R) return i; }
      return -1;
    }
    function nuevoAcceso(Z, ac, extra) {
      ac.id = V.accesos.length; ac.zona = Z.id;
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) ac[k] = extra[k];
      V.accesos.push(ac); Z.accesos.push(ac);
      return ac;
    }
    /** Los nodos del árbol de `ac` a una distancia (cm) entre lo y hi, ordenados por índice. */
    function nodosEntre(Z, ac, lo, hi) {
      var A = arbolDe(Z, ac), out = [], k;
      for (k = 0; k < Z.nNodos; k++) if (A.dist[k] >= lo && A.dist[k] <= hi) out.push(k);
      return out;
    }
    function accesosEntre(Z, ac, lo, hi) {
      var A = arbolDe(Z, ac), out = [], i;
      for (i = 0; i < Z.accesos.length; i++) {
        var b = Z.accesos[i]; if (b === ac || !b.edificio) continue;
        var h = hastaAcceso(Z, A, ac, b); if (h && h.cm >= lo && h.cm <= hi) out.push(b);
      }
      return out;
    }
    // ---- La construcción, por trozos (ronda 1) ---------------------------------------
    // Construir la población entera cuesta de 1,4 a 2,3 s (medido por la revisión)
    // y se rehace cuando cambian las parcelas: su sitio, su sector o su plantilla,
    // que sube con cada activo que compra la empresa. Hecho de una vez en el hilo
    // principal, cada compra congelaba el visor más de un segundo y medio. Ahora
    // es un trabajo por fases que avanza unos milisegundos en cada cuadro (un
    // cuarto de lo que dura el cuadro, entre 6 y 200 ms) sobre un estado nuevo, con
    // la población de antes en la calle hasta que el nuevo está entero; entonces se
    // cambia de una vez. El resultado es el mismo que de una vez: cada fase recorre
    // lo mismo en el mismo orden, solo que en trozos. La primera construcción (al
    // cargar, en `listo`) y la del cambio de calidad siguen siendo de una vez: son
    // momentos en que el visor ya está recargando. Fases (ronda 2): 0 índices de
    // calzada, 1 grafo de aceras cruce a cruce, 2 portales, 3 empresas de las
    // parcelas, 4 vecinos, 5 contratación de cada empresa, 6 oficinas y agenda,
    // 7 índice de horas y, solo por trozos, 8 precalentado de los caminos de quien
    // estará en la calle cerca del foco cuando se cambie de población.
    var CAMPOS = ['zonas', 'personas', 'viajes', 'accesos', 'cache', 'uso', 'nCache', 'dur', 'arboles', 'nAristas', 'diag', 'asfalto', 'cebraIdx', 'empleo', 'faseCebra'];
    function trabajoNuevo(calienta) {
      return { N: { zonas: [], personas: [], viajes: [], accesos: [], cache: {}, uso: {}, nCache: 0, dur: null, arboles: 0, nAristas: 0, diag: {}, asfalto: null, cebraIdx: null,
                    empleo: { parcelas: 0, puestos: 0, oficinas: 0, porZona: {} }, faseCebra: {}, nCuadro: 0 },
               fase: 0, i: 0, j: 0, k: 0, Z: null, ms: 0, trozos: 0, trozoMax: 0, fases: [0, 0, 0, 0, 0, 0, 0, 0, 0], t0: Date.now(), calienta: !!calienta,
               casas: [], oficinas: { towers: [], warehouses: [] }, empresas: [], trab: [], ofZonas: null, porZona: { towers: {}, warehouses: {} }, pcs: null, sol: null, pre: null };
    }
    /** Avanza el trabajo hasta `hasta` (performance.now()); true si ha acabado. */
    function trabajoPaso(J, hasta) {
      var Vv = V, t0 = performance.now(), hecho = false;
      // El reloj y el cuadro del estado en uso: el precalentado (fase 8) calcula
      // los caminos de la hora de ahora y los marca como usados en este cuadro.
      J.N.nCuadro = Vv.nCuadro; J.T = Vv.T || 0;
      V = J.N;                                   // lo que construyen las funciones de arriba va al estado nuevo
      J.tf = t0;
      try { hecho = fases(J, hasta); } finally { V = Vv; }
      var t1 = performance.now(), dt = t1 - t0;
      J.fases[J.fase] += t1 - J.tf;
      J.ms += dt; J.trozos++; if (dt > J.trozoMax) { J.trozoMax = dt; J.faseMax = J.fase; }
      return hecho;
    }
    function trabajoFin(J) {
      for (var k = 0; k < CAMPOS.length; k++) V[CAMPOS[k]] = J.N[CAMPOS[k]];
      // Lo precalentado cuenta como usado ahora: la reconstrucción dura cientos
      // de cuadros y la poda lo soltaría por viejo.
      for (k in V.uso) if (Object.prototype.hasOwnProperty.call(V.uso, k)) V.uso[k] = V.nCuadro;
      V.hecho = true; V.ms = Math.round(J.ms); V.trozos = J.trozos; V.trozoMax = Math.round(J.trozoMax * 10) / 10; V.faseMax = J.faseMax;
      V.fasesMs = J.fases.map(function (x) { return Math.round(x); }); V.paredMs = Date.now() - J.t0; V.calentados = J.pre ? J.pre.length : 0;
    }
    function construye() {
      var J = trabajoNuevo(false);
      trabajoPaso(J, Infinity);
      trabajoFin(J);
      V.trabajo = null;
    }
    function fase(J, f) { var t = performance.now(); J.fases[J.fase] += t - J.tf; J.tf = t; J.fase = f; J.i = 0; J.j = 0; }
    function fases(J, hasta) {
      var i, j, Z, N = J.N;
      for (;;) {
        if (J.fase === 0) {
          if (!S.tramas || !S.tramas.length || !S.vias) return true;
          // El índice de la calzada, de 10 vías en 10 (entero son 70–100 ms).
          if (!N.asfalto) { N.asfalto = {}; J.k = 0; }
          if (J.k < (S.vias || []).length) { indiceAsfalto(N.asfalto, J.k, J.k + 10); J.k += 10; }
          else { N.cebraIdx = indiceCebras(); fase(J, 1); }
        } else if (J.fase === 1) {
          // Un cruce de un barrio por vuelta: el barrio más grande tarda más de
          // 100 ms entero, y una columna de cruces, hasta 100 ms.
          if (J.i >= S.tramas.length) { fase(J, 2); continue; }
          if (!J.Z) { J.Z = zonaDeTrama(J.i); J.Z.id = N.zonas.length; N.zonas.push(J.Z); J.k = -J.Z.n; J.j = -J.Z.n; }
          cruceGrafo(J.Z, J.k, J.j++);
          if (J.j > J.Z.n) { J.j = -J.Z.n; J.k++; }
          if (J.k > J.Z.n) { cierraGrafo(J.Z); J.Z = null; J.i++; }
        } else if (J.fase === 2) {
          // Los portales de los edificios de barrio, en la trama que los orienta.
          if (J.i >= S.edificios.length) { fase(J, 3); continue; }
          if (J.j >= S.edificios[J.i].length) { J.i++; J.j = 0; continue; }
          var e = S.edificios[J.i][J.j++]; if (e.oculto || !e.alineado) continue;
          var zi = tramaDe(e.x, e.z); if (zi < 0) continue;
          Z = N.zonas[zi];
          var px = e.x + Math.sin(e.yaw) * (e.d * 0.5 + 0.3) + SONDA.x, pz = e.z + Math.cos(e.yaw) * (e.d * 0.5 + 0.3) + SONDA.z;
          var ac = acceso(Z, px, pz, e.y + 1);
          if (ac) {
            nuevoAcceso(Z, ac, { edificio: e, tipo: e.kind });
            if (e.kind === 'villas' || e.kind === 'blocks') J.casas.push(ac);
            else J.oficinas[e.kind].push(ac);
          }
        } else if (J.fase === 3) {
          // Las empresas de las parcelas (la economía): su portal, en la trama que las
          // contenga si hay acera que llegue; si no, desde la puerta del taxi.
          if (!J.pcs) {
            var items = S.catastro ? S.catastro.items : [];
            J.sol = {}; for (i = 0; i < items.length; i++) if (items[i].tipo === 'parcela') J.sol[items[i].id] = items[i];
            J.pcs = ((S.city && S.city.parcels) || []).slice().sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
          }
          if (J.i >= J.pcs.length) { fase(J, 4); continue; }
          parcelaEmpresa(J, J.pcs[J.i++]);
        } else if (J.fase === 4) {
          // Los vecinos de cada casa: quién es y si trabaja.
          if (J.i >= J.casas.length) { fase(J, 5); continue; }
          vecinos(J, J.casas[J.i++]);
        } else if (J.fase === 5) {
          // Cada empresa de una parcela contrata su plantilla, una por vuelta.
          if (J.i >= J.empresas.length) { fase(J, 6); continue; }
          recluta(J, J.empresas[J.i], J.i); J.i++;
        } else if (J.fase === 6) {
          // Los demás que trabajan, a las oficinas; y el día de cada uno.
          if (!J.ofZonas) J.ofZonas = { towers: zonasDeOficina(J.oficinas.towers), warehouses: zonasDeOficina(J.oficinas.warehouses) };
          if (J.i >= N.personas.length) { fase(J, 7); continue; }
          destino(J, N.personas[J.i++]);
        } else if (J.fase === 7) {
          // El índice de cada zona: viajes ordenados por hora de salida.
          if (J.i >= N.zonas.length) {
            N.dur = new Float64Array(N.viajes.length);
            for (j = 0; j < N.dur.length; j++) N.dur[j] = NaN;
            if (!J.calienta) return true;
            fase(J, 8); continue;
          }
          Z = N.zonas[J.i++];
          Z.viajes.sort(function (a, b) { return (a.t0 - b.t0) || (a.id - b.id); });
          Z.t0s = new Int32Array(Z.viajes.length);
          for (j = 0; j < Z.viajes.length; j++) Z.t0s[j] = Z.viajes[j].t0;
        } else if (J.fase === 8) {
          // El precalentado (ronda 2): antes de cambiar de población, los caminos
          // de quien estará en la calle cerca del foco (a la hora de ahora y hasta
          // CALIENTA_ANTES segundos después). Sin esto, la población nueva salía
          // vacía y se llenaba al ritmo del plazo de caminos: la revisión contó 40
          // cuadros seguidos sin ningún peatón tras un cambio de la economía.
          if (!J.pre) J.pre = aCalentar(J.T, foco());
          if (J.i >= J.pre.length) return true;
          // Quien ya ha salido, a la hora de ahora; quien sale en los próximos
          // segundos, a la de dentro de CALIENTA_ANTES.
          var v = N.viajes[J.pre[J.i++]], el0 = ((J.T - v.t0) % DIA + DIA) % DIA;
          transcurrido(v, el0 <= DMAX ? J.T : (J.T + CALIENTA_ANTES) % DIA, false);
        }
        if (performance.now() >= hasta) return false;
      }
    }
    /** Los viajes que salieron en los últimos DMAX segundos (o saldrán en los próximos CALIENTA_ANTES) en las zonas cercanas a `f`. */
    function aCalentar(T, f) {
      var out = [], zs = zonasCerca(f);
      enVentana(T + CALIENTA_ANTES, DMAX + CALIENTA_ANTES, zs, function (v) { out.push(v.id); });
      return out;
    }
    function parcelaEmpresa(J, pc) {
      var N = J.N, so = J.sol['parcela:' + pc.x + ':' + pc.y]; if (!so) return;
      var ppx = so.x + Math.sin(so.yaw) * (so.hd + 0.3) + SONDA.x, ppz = so.z + Math.cos(so.yaw) * (so.hd + 0.3) + SONDA.z, ppy = so.y0 + 1;
      var ztr = tramaDe(ppx, ppz), acp = ztr >= 0 ? acceso(N.zonas[ztr], ppx, ppz, ppy) : null;
      if (acp) nuevoAcceso(N.zonas[ztr], acp, { parcela: pc, tipo: 'parcela', edificio: null });
      else {
        // Fuera de trama: la puerta del taxi, de 40 a 70 m delante del portal, lo
        // más lejos que esté libre; si delante hay una calle, en su bordillo. Si
        // la fachada principal no tiene salida (un edificio, el agua), se prueba
        // por los costados y por detrás, con el portal en esa fachada. Solo con
        // la fachada principal, 8.006 de 9.164 trabajadores de parcelas sueltas
        // de la prueba se quedaban sin llegada: delante había calzada a menos de
        // diez metros, que es justo donde para un taxi.
        var lim = 10 + (mezcla(pc.x, pc.y) % 31) + 30, cara, T = null, Pp = [ppx, ppy, ppz];
        for (cara = 0; cara < 4 && !T; cara++) {
          var ang = so.yaw + [0, Math.PI * 0.5, -Math.PI * 0.5, Math.PI][cara], med = cara === 1 || cara === 2 ? so.hw : so.hd;
          var dxp = Math.sin(ang), dzp = Math.cos(ang), ox = so.x + dxp * (med + 0.3), oz = so.z + dzp * (med + 0.3), s2, libre = 0, calle = false;
          if (M.surfaceH(ox, oz) <= 0.6 || CAT.bajo(ox, oz)) { N.diag.taxiPortal = (N.diag.taxiPortal || 0) + 1; continue; }
          for (s2 = 0.6; s2 <= lim; s2 += 0.5) {
            var qx = ox + dxp * s2, qz = oz + dzp * s2;
            if (enAsfalto(qx, qz, -2)) { calle = true; break; }
            if (M.surfaceH(qx, qz) <= 0.6) { N.diag.taxiAgua = (N.diag.taxiAgua || 0) + 1; break; }
            if (CAT.bajo(qx, qz)) { N.diag.taxiEdificio = (N.diag.taxiEdificio || 0) + 1; break; }
            libre = s2;
          }
          if (libre >= 10 || (calle && libre >= 1)) {
            T = [ox + dxp * libre, M.groundH(ox + dxp * libre, oz + dzp * libre), oz + dzp * libre];
            Pp = [ox, ppy, oz];
          }
        }
        if (!T) N.diag.sinPuertaDeTaxi = (N.diag.sinPuertaDeTaxi || 0) + 1;
        var Zs = { id: N.zonas.length, tipo: 'suelta', x: Pp[0], z: Pp[2], R: 80, accesos: [], viajes: [], arbol: {} };
        N.zonas.push(Zs);
        acp = nuevoAcceso(Zs, { P: Pp, T: T }, { parcela: pc, tipo: 'parcela', edificio: null });
      }
      // Una parcela sin salida por ninguna fachada (en el agua de la ría o de la
      // costa: las celdas de tierra del consenso no miran el relieve fino) no
      // recibe a nadie que se vea llegar: su plantilla no entra en el sorteo.
      if (acp.T === null) return;
      J.empresas.push({ ac: acp, pc: pc, peso: plantilla(pc) });
    }
    // ---- Quién trabaja dónde (ronda 2) ------------------------------------------------
    // Hasta la ronda 1 cada trabajador sorteaba empresa con un peso por plantilla
    // y cercanía, sin tope: con ocho parcelas, las ocho recibían los 20.000
    // trabajadores de la ciudad (con plantillas que suman unas 2.150) y las torres
    // se quedaban vacías. Y sin parcelas, cada barrio de viviendas iba entero al
    // barrio de oficinas de centro más cercano: el centro (zona 0) y otros dos no
    // recibían a nadie en todo el día. Ahora:
    //   1. Cada empresa de una parcela contrata exactamente su plantilla (o todos
    //      los que queden, si no llegan): a los trabajadores de los anillos de
    //      celdas más cercanos a su parcela y, dentro de un anillo, por sorteo
    //      entero (mezcla de la semilla de la persona y el índice de la empresa).
    //      Las empresas contratan en orden (fila y columna de su parcela).
    //   2. El resto va a las oficinas: torres (tres de cada cuatro) o naves; el
    //      barrio, por gravedad —plantas del barrio / (1 + km)², en enteros—, y el
    //      edificio del barrio, por sus plantas.
    /** Los vecinos de una casa: quién es cada uno y si trabaja. El dónde, después (recluta, destino). */
    function vecinos(J, H) {
      var eb = H.edificio, bx = Math.round(eb.x), bz = Math.round(eb.z), sb = U.semillaMorfologia(bx, bz, 21), k;
      var nv = eb.kind === 'villas' ? 2 + (sb % 3) : U.clamp(Math.round(Math.max(2, Math.floor(eb.h / 3.2)) * Math.max(2, Math.round(eb.w * eb.d / 110)) * 0.6), 6, 70);
      var celda = M.worldToCell(eb.x, eb.z);
      for (k = 0; k < nv; k++) {
        var sem = mezcla(sb, k + 1), r = U.lcg(sem), per = { id: V.personas.length, casa: H, trabajo: null, viajes: [], celda: celda, sem: mezcla(sem, 0x5eed) };
        r(); r();
        per.trabaja = r() < 0.72;
        per.v = V_MIN + (V_MAX - V_MIN) * r();
        var est = r(); per.estilo = est < 0.34 ? 0 : (est < 0.58 ? 1 : (est < 0.78 ? 2 : 3));
        var pal = per.estilo === 1 ? BLANCOS : PALETA; per.color = pal[Math.floor(r() * pal.length)];
        per.lado = 0.35 + 0.35 * r();
        per.fase = r() * 6.28;
        V.personas.push(per);
        if (per.trabaja) J.trab.push(per.id);
      }
    }
    /** La empresa `E` (índice `ie`) contrata su plantilla entre los que aún no tienen trabajo, de los anillos más cercanos. */
    function recluta(J, E, ie) {
      var pc = E.pc, anillos = {}, ds = [], i, quedan = E.peso, libres = [];
      for (i = 0; i < J.trab.length; i++) {
        var p = V.personas[J.trab[i]]; if (p.trabajo) continue;
        libres.push(p.id);
        var d = p.celda ? Math.max(Math.abs(p.celda.x - pc.x), Math.abs(p.celda.y - pc.y)) : 99999;
        if (!anillos[d]) { anillos[d] = []; ds.push(d); }
        anillos[d].push(p.id);
      }
      J.trab = libres;                            // los que ya tienen trabajo no se vuelven a mirar
      ds.sort(function (a, b) { return a - b; });
      for (i = 0; i < ds.length && quedan > 0; i++) {
        var l = anillos[ds[i]];
        if (l.length > quedan) {
          var cl = {};
          for (var q = 0; q < l.length; q++) cl[l[q]] = mezcla(V.personas[l[q]].sem, ie + 1);
          l.sort(function (a, b) { return (cl[a] - cl[b]) || (a - b); });
          l.length = quedan;
        }
        for (var m = 0; m < l.length; m++) V.personas[l[m]].trabajo = E.ac;
        quedan -= l.length;
      }
      V.empleo.parcelas += E.peso - quedan; V.empleo.puestos += E.peso;
    }
    /** Los barrios de oficinas de una lista de portales: { zona, lista, acum (plantas acumuladas), cap }, por zona. */
    function zonasDeOficina(lista) {
      var porZ = {}, out = [], i;
      for (i = 0; i < lista.length; i++) {
        var a = lista[i], z = porZ[a.zona];
        if (!z) { z = porZ[a.zona] = { zona: a.zona, lista: [], acum: [], cap: 0 }; out.push(z); }
        z.cap += Math.max(1, Math.floor(a.edificio.h / 3.2)); z.lista.push(a); z.acum.push(z.cap);
      }
      out.sort(function (a, b) { return a.zona - b.zona; });
      return out;
    }
    /** Pesos acumulados (enteros) de los barrios de oficinas vistos desde la zona `zh`. */
    function gravedad(J, tipo, zh) {
      var c = J.porZona[tipo][zh]; if (c) return c;
      var lz = J.ofZonas[tipo], zc = V.zonas[zh], acum = [], tot = 0, i;
      for (i = 0; i < lz.length; i++) {
        var zo = V.zonas[lz[i].zona], km = Math.floor(Math.round(Math.abs(zo.x - zc.x) + Math.abs(zo.z - zc.z)) / KM);
        tot += Math.max(1, Math.floor(lz[i].cap * 10000 / ((1 + km) * (1 + km)))); acum.push(tot);
      }
      return (J.porZona[tipo][zh] = { acum: acum, tot: tot });
    }
    function sorteo(acum, x) { var q = 0; while (q < acum.length - 1 && acum[q] <= x) q++; return q; }
    /** El trabajo de quien no lo tiene en una parcela, y el día de cada persona. */
    function destino(J, per) {
      var r = U.lcg(per.sem), a = r(), b = r(), c = r();   // siempre tres sorteos: la serie de la agenda no depende de la rama
      if (per.trabaja && !per.trabajo) {
        var tipo = a < 0.75 && J.ofZonas.towers.length ? 'towers' : (J.ofZonas.warehouses.length ? 'warehouses' : 'towers'), lz = J.ofZonas[tipo];
        if (lz.length) {
          var g = gravedad(J, tipo, per.casa.zona), zo = lz[sorteo(g.acum, Math.floor(b * g.tot))];
          per.trabajo = zo.lista[sorteo(zo.acum, Math.floor(c * zo.cap))];
          V.empleo.oficinas++; V.empleo.porZona[zo.zona] = (V.empleo.porZona[zo.zona] || 0) + 1;
        }
      }
      agenda(per, r);
    }
    function viaje(per, zona, t0, src, dst, vuelta, tipo) {
      var v = { id: V.viajes.length, p: per.id, zona: zona, t0: ((t0 % DIA) + DIA) % DIA, src: src, dst: dst, vuelta: !!vuelta, tipo: tipo };
      V.viajes.push(v); V.zonas[zona].viajes.push(v); per.viajes.push(v.id);
      return v;
    }
    /**
     * El día de una persona: sus viajes, con la hora de salida en segundos
     * enteros. Los destinos que dependen del grafo (la calle del metro, el sitio
     * de la comida) se guardan como un sorteo entero y se resuelven al pedir el
     * camino, con el mismo resultado siempre.
     */
    function agenda(per, r) {
      var H = per.casa, W = per.trabajo, zh = H.zona;
      if (W) {
        var sale = 7 * 3600 + Math.floor(r() * 9000), vuelve = 17 * 3600 + Math.floor(r() * 9000);
        var ida = 900 + Math.floor(r() * 1500), regreso = 900 + Math.floor(r() * 1500);
        var mismo = W.zona === zh && W.edificio !== undefined && V.zonas[zh].tipo === 'trama';
        var cerca = mismo && (Math.round(Math.abs(W.P[0] - H.P[0])) + Math.round(Math.abs(W.P[2] - H.P[2]))) <= RADIO_ANDABLE;
        if (cerca) {
          viaje(per, zh, sale, H, { acc: W }, false, 'ida');
          viaje(per, zh, vuelve, H, { acc: W }, true, 'vuelta');
        } else {
          // Metro o taxi: a pie de casa a la parada del barrio más cercana (o al
          // bordillo de delante, si no hay ninguna a menos de PARADA_MAX), y al otro
          // lado, de la parada más cercana al trabajo (o del bordillo de delante)
          // hasta el portal.
          var enTrama = V.zonas[W.zona].tipo === 'trama';
          viaje(per, zh, sale, H, { parada: true }, false, 'ida');
          viaje(per, W.zona, sale + ida, W, enTrama ? { parada: true } : { taxi: true }, true, 'llegada');
          viaje(per, W.zona, vuelve, W, enTrama ? { parada: true } : { taxi: true }, false, 'salida');
          viaje(per, zh, vuelve + regreso, H, { parada: true }, true, 'vuelta');
        }
        if (V.zonas[W.zona].tipo === 'trama' && r() < 0.55) {
          var come = 12 * 3600 + Math.floor(r() * 7200), estancia = 1500 + Math.floor(r() * 2100), sc = Math.floor(r() * 1e9);
          viaje(per, W.zona, come, W, { sitio: sc, lo: 8000, hi: 45000 }, false, 'comida');
          viaje(per, W.zona, come + estancia, W, { sitio: sc, lo: 8000, hi: 45000 }, true, 'comida');
        }
      } else {
        if (r() < 0.8) {
          var t1 = 9 * 3600 + Math.floor(r() * 18000), e1 = 1200 + Math.floor(r() * 2400), sa = Math.floor(r() * 1e9);
          viaje(per, zh, t1, H, { sitio: sa, lo: 15000, hi: 70000 }, false, 'recado');
          viaje(per, zh, t1 + e1, H, { sitio: sa, lo: 15000, hi: 70000 }, true, 'recado');
        }
        if (r() < 0.6) {
          var t2 = 15 * 3600 + Math.floor(r() * 19800), e2 = 1200 + Math.floor(r() * 2400), sb2 = Math.floor(r() * 1e9);
          viaje(per, zh, t2, H, { sitio: sb2, lo: 15000, hi: 70000 }, false, 'recado');
          viaje(per, zh, t2 + e2, H, { sitio: sb2, lo: 15000, hi: 70000 }, true, 'recado');
        }
      }
      if (r() < 0.12) viaje(per, zh, 20 * 3600 + Math.floor(r() * 10800), H, { nodo: Math.floor(r() * 1e9), lo: 15000, hi: 35000, bucle: true }, false, 'paseo');
      if (r() < 0.02) viaje(per, zh, 23 * 3600 + Math.floor(r() * 21600), H, { nodo: Math.floor(r() * 1e9), lo: 8000, hi: 25000, bucle: true }, false, 'madrugada');
    }
    /**
     * El camino de un viaje (se calcula la primera vez que hace falta y se guarda;
     * su duración queda además en `V.dur`, que no se poda). Con `pres` (el cuadro),
     * si este cuadro ya ha gastado su tiempo de caminos nuevos, devuelve undefined
     * y el viaje espera al cuadro siguiente sin dibujarse ni marcar sus pasos: sin
     * eso, al llegar a un barrio o a la hora punta se calculaban de golpe cientos
     * de caminos (la revisión midió pasos de 116 y 372 ms). `posicion` calcula
     * siempre, y da lo mismo.
     */
    function rutaDe(v, pres) {
      var R = V.cache[v.id];
      if (R !== undefined) { V.uso[v.id] = V.nCuadro; return R; }
      if (pres && performance.now() > V.limite) { V.aplazados++; return undefined; }
      var Z = V.zonas[v.zona], per = V.personas[v.p], d = v.dst, dst = null, R2 = null;
      if (Z.tipo === 'suelta') R2 = v.src.T ? caminoRecto(v.src, !v.vuelta) : null;
      else if (d.acc) R2 = camino(Z, v.src, { acc: d.acc }, v.vuelta, per.lado);
      else if (d.parada) {
        // La parada más cercana por la acera (centímetros enteros; a igualdad, la
        // de índice menor), si está a menos de PARADA_MAX; si no, el taxi.
        var A = arbolDe(Z, v.src), mejor = -1, mc = PARADA_MAX * 100 + 1, q;
        for (q = 0; q < Z.paradas.length; q++) { var dd = A.dist[Z.paradas[q]]; if (dd >= 0 && dd < mc) { mc = dd; mejor = Z.paradas[q]; } }
        R2 = mejor >= 0 ? camino(Z, v.src, { nodo: mejor, bordillo: bordilloDe(Z, mejor) }, v.vuelta, per.lado) : caminoTaxi(v.src, v.vuelta, per.lado);
      }
      else if (d.nodo !== undefined) {
        var cand = nodosEntre(Z, v.src, d.lo, d.hi);
        if (!cand.length) cand = nodosEntre(Z, v.src, 0, d.hi);
        if (cand.length) {
          dst = cand[d.nodo % cand.length];
          if (d.bucle) {
            var ida = camino(Z, v.src, { nodo: dst }, false, per.lado), vta = camino(Z, v.src, { nodo: dst }, true, per.lado);
            R2 = ida && vta ? une(ida, vta) : null;
          } else R2 = camino(Z, v.src, { nodo: dst }, v.vuelta, per.lado);
        }
      } else if (d.sitio !== undefined) {
        var cs = accesosEntre(Z, v.src, d.lo, d.hi);
        if (cs.length) R2 = camino(Z, v.src, { acc: cs[d.sitio % cs.length] }, v.vuelta, per.lado);
      }
      if (R2) horario(R2, v, per);
      if (R2 && R2.dur > DMAX) R2 = null;
      V.cache[v.id] = R2; V.uso[v.id] = V.nCuadro; V.nCache++;
      if (V.dur) V.dur[v.id] = R2 ? R2.dur : -1;
      return R2;
    }
    /**
     * El horario del viaje sobre su camino: anda a su velocidad y, en cada paso de
     * peatones, si llega fuera del turno del paso, espera en el bordillo. Deja en
     * el camino las esperas ([metros, empieza, acaba], en segundos desde la
     * salida), cuándo pisa y deja cada paso, y la duración total.
     */
    function horario(R, v, per) {
      var t = 0, d = 0, k, esp = [], ocup = [];
      for (k = 0; k < R.ceb.length; k += 3) {
        var d0 = R.ceb[k + 1], d1 = R.ceb[k + 2], id = R.ceb[k];
        if (d0 < d) d0 = d;
        var fc = V.faseCebra[id], ta = t + (d0 - d) / per.v, fase = fc !== undefined ? fc : mezcla(id, 97) % CICLO;
        var loc = (((v.t0 + ta - fase) % CICLO) + CICLO) % CICLO, w = loc < VENTANA ? 0 : CICLO - loc;
        if (w > 0) esp.push(d0, ta, ta + w);
        var entra = ta + w, sale = entra + Math.max(0, d1 - d0) / per.v;
        ocup.push(id, entra, sale);
        t = sale; d = Math.max(d0, d1);
      }
      R.esperas = esp; R.ocupa = ocup;
      R.dur = t + Math.max(0, R.L - d) / per.v;
    }
    /** Lo andado a los `el` segundos de la salida, con las esperas. */
    function andadoEn(R, vp, el) {
      var e = R.esperas, k, parado = 0;
      for (k = 0; k < e.length; k += 3) {
        if (el <= e[k + 1]) break;
        if (el < e[k + 2]) return { d: e[k], quieto: true };
        parado += e[k + 2] - e[k + 1];
      }
      return { d: (el - parado) * vp, quieto: false };
    }
    function une(a, b) {
      var n = a.x.length + b.x.length - 1, X = new Float32Array(n), Y = new Float32Array(n), Zz = new Float32Array(n), D = new Float64Array(n), i;
      for (i = 0; i < a.x.length; i++) { X[i] = a.x[i]; Y[i] = a.y[i]; Zz[i] = a.z[i]; D[i] = a.d[i]; }
      for (i = 1; i < b.x.length; i++) { var k = a.x.length - 1 + i; X[k] = b.x[i]; Y[k] = b.y[i]; Zz[k] = b.z[i]; D[k] = a.L + b.d[i]; }
      var cb = a.ceb.slice(); for (i = 0; i < b.ceb.length; i += 3) cb.push(b.ceb[i], b.ceb[i + 1] + a.L, b.ceb[i + 2] + a.L);
      return { x: X, y: Y, z: Zz, d: D, L: a.L + b.L, ceb: cb };
    }
    /** Dónde está un viaje a los `dd` metros: x, y, z y la dirección de marcha. */
    function puntoRuta(R, dd, out) {
      var D = R.d, lo = 0, hi = D.length - 1, mid;
      if (dd <= 0) lo = 0; else if (dd >= R.L) lo = hi - 1;
      else while (lo + 1 < hi) { mid = (lo + hi) >> 1; if (D[mid] <= dd) lo = mid; else hi = mid; }
      var b = Math.min(lo + 1, D.length - 1), f = U.clamp((dd - D[lo]) / Math.max(1e-6, D[b] - D[lo]), 0, 1);
      out.x = R.x[lo] + (R.x[b] - R.x[lo]) * f; out.y = R.y[lo] + (R.y[b] - R.y[lo]) * f; out.z = R.z[lo] + (R.z[b] - R.z[lo]) * f;
      var dx = R.x[b] - R.x[lo], dz = R.z[b] - R.z[lo], l = Math.sqrt(dx * dx + dz * dz) || 1;
      out.dx = dx / l; out.dz = dz / l;
      return out;
    }
    /**
     * Los segundos desde la salida de un viaje en el instante T, o −1 si no está
     * en la calle (o si su camino espera turno). Con la duración ya sabida
     * (`V.dur`), un viaje acabado no necesita su camino; el camino de un viaje
     * acabado se suelta de la caché (ronda 2): así la caché guarda solo a quien
     * está en la calle. Antes guardaba también todo lo que salió en los últimos
     * DMAX segundos, que con parcelas pasaba de CACHE_MAX en hora punta, y la
     * poda la vaciaba entera 28 veces por minuto (la gente parpadeaba).
     */
    function transcurrido(v, T, pres) {
      var el = ((T - v.t0) % DIA + DIA) % DIA, du = V.dur ? V.dur[v.id] : NaN;
      if (du === du && (du < 0 || el >= du)) {
        // Con la duración sabida, el camino se guardó a la vez que ella: si
        // no se suelta aquí, el de un viaje acabado se queda en la caché
        // hasta que la poda lo echa (la caché crecía hasta CACHE_MAX).
        if (du >= 0) suelta(v.id);
        return -1;
      }
      var R = rutaDe(v, pres); if (!R) return -1;
      if (el >= R.dur) { suelta(v.id); return -1; }
      return el;
    }
    function suelta(id) { if (V.cache[id] !== undefined) { delete V.cache[id]; delete V.uso[id]; V.nCache--; } }
    /** La posición del peatón i en T, o null si está dentro de algún sitio. Función pura de (datos, i, T). */
    function posicion(i, T) {
      var per = V.personas[i]; if (!per) return null;
      for (var k = 0; k < per.viajes.length; k++) {
        var v = V.viajes[per.viajes[k]], el = transcurrido(v, T);
        if (el >= 0) {
          var R = rutaDe(v), a = andadoEn(R, per.v, el), o = puntoRuta(R, a.d, {});
          o.i = i; o.viaje = v.id; o.tipo = v.tipo; o.andado = a.d; o.quieto = a.quieto; return o;
        }
      }
      return null;
    }
    /** Los viajes de las zonas `zonas` (en ese orden) que salieron entre T − ancho y T. */
    function enVentana(T, ancho, zonas, cada) {
      var zi, j;
      T = ((T % DIA) + DIA) % DIA;
      for (zi = 0; zi < zonas.length; zi++) {
        var Z = zonas[zi]; if (!Z.t0s || !Z.t0s.length) continue;
        var rangos = T - ancho >= 0 ? [[T - ancho, T]] : [[0, T], [T - ancho + DIA, DIA]];
        for (var q = 0; q < rangos.length; q++) {
          var a = rangos[q][0], b = rangos[q][1], lo = 0, hi = Z.t0s.length;
          while (lo < hi) { var mid = (lo + hi) >> 1; if (Z.t0s[mid] < a) lo = mid + 1; else hi = mid; }
          for (j = lo; j < Z.t0s.length && Z.t0s[j] <= b; j++) cada(Z.viajes[j], Z);
        }
      }
    }
    /** Los viajes en la calle a la hora T de las zonas de la lista `zonas`, en ese orden. */
    function enLaCalle(T, zonas, cada, pres) {
      enVentana(T, DMAX, zonas, function (v, Z) { var el = transcurrido(v, T, pres); if (el >= 0) cada(v, el, Z); });
    }
    /** Las zonas a menos de R_PROC (más su radio) de `f`, de la más cercana a la más lejana. */
    function zonasCerca(f) {
      var zs = [], i;
      for (i = 0; i < V.zonas.length; i++) {
        var Zq = V.zonas[i], zx = Zq.x - f.x, zz = Zq.z - f.z, lim = R_PROC + Zq.R;
        if (zx * zx + zz * zz < lim * lim) zs.push([zx * zx + zz * zz, Zq]);
      }
      zs.sort(function (a, b) { return (a[0] - b[0]) || (a[1].id - b[1].id); });
      for (i = 0; i < zs.length; i++) zs[i] = zs[i][1];
      return zs;
    }

    // ---- El reloj -----------------------------------------------------------------
    // El de Dubái (UTC+4), en segundos del día. Con la hora fijada en el visor
    // (setTimeOfDay), el tiempo corre desde esa hora para que la gente se mueva.
    function avanzaReloj(dt) {
      if (V.manual !== null) { V.manual = ((V.manual + dt) % DIA + DIA) % DIA; return V.manual; }
      var h = S.hour;
      if (h === null || h === undefined) { V.horaVista = undefined; return ((Date.now() / 1000 + 4 * 3600) % DIA + DIA) % DIA; }
      if (h !== V.horaVista) { V.horaVista = h; V.reloj = h * 3600; } else V.reloj = (V.reloj + dt) % DIA;
      return V.reloj;
    }

    // ---- El dibujo ------------------------------------------------------------------
    function tope() { return TOPES[ctx.calidad()] || TOPES.media; }
    function mallas() {
      var tp = tope(), st;
      if (V.mallas && V.cap === tp.n) { for (st in V.mallas) if (V.mallas[st]) V.mallas[st].castShadow = tp.sombra; return; }
      quitaMallas();
      V.cap = tp.n; if (!tp.n) return;
      V.mallas = {};
      function hazla(nombre, geo, n) {
        var m = new THREE.InstancedMesh(geo, ctx.plainMat, n);
        m.count = 0; m.visible = false; m.frustumCulled = false; m.castShadow = tp.sombra; m.receiveShadow = true; m.name = 'peatones_' + nombre;
        m.setColorAt(0, new THREE.Color(1, 1, 1)); ctx.scene.add(m); V.mallas[nombre] = m;
      }
      // Cuatro cuerpos (uno por estilo), dos brazos (el brazo solo cambia en el
      // tono de la mano: estilos pares e impares) y una pierna: siete llamadas.
      for (st = 0; st < 4; st++) hazla('cuerpo' + st, G.avatarBodyGeometry(st, true), tp.n);
      for (st = 0; st < 2; st++) hazla('brazo' + st, G.avatarLimbGeometry('arm', st, true), tp.n * 2);
      hazla('pierna', G.avatarLimbGeometry('leg', 0, true), tp.n * 2);
    }
    function quitaMallas() {
      if (!V.mallas) return;
      for (var k in V.mallas) if (Object.prototype.hasOwnProperty.call(V.mallas, k)) { ctx.scene.remove(V.mallas[k]); V.mallas[k].geometry.dispose(); V.mallas[k].dispose(); }
      V.mallas = null; V.cap = -1;
    }
    var dummy = new THREE.Object3D(), col = new THREE.Color(), _p = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
    function miembro(m, idx, a, th, ox, oy, sw, c) {
      var cs = Math.cos(th), sn = Math.sin(th);
      dummy.position.set(a.x + ox * cs, a.y + a.bob + oy, a.z - ox * sn);
      dummy.rotation.set(sw, th, 0, 'YXZ'); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      m.setMatrixAt(idx, dummy.matrix); m.setColorAt(idx, c);
    }
    function dibuja(lista) {
      if (!V.mallas) return;
      var cnt = [0, 0, 0, 0], brazos = [0, 0], piernas = 0, i, st;
      var cam = new THREE.Vector3().setFromMatrixPosition(ctx.camera.matrixWorld);   // ya refrescada en cuadro()
      for (i = 0; i < lista.length; i++) {
        var a = lista[i], per = V.personas[a.p], s = per.estilo, th = Math.atan2(-a.dx, -a.dz);
        // Quien espera en el bordillo, quieto y con los brazos caídos.
        var fase = a.andado / 0.75 * Math.PI + per.fase, sw = a.quieto ? 0 : Math.sin(fase) * 0.55;
        a.bob = a.quieto ? 0 : Math.abs(Math.sin(fase)) * 0.04;
        col.setRGB(per.color[0], per.color[1], per.color[2]);
        dummy.position.set(a.x, a.y + a.bob, a.z); dummy.rotation.set(0, th, 0, 'YXZ'); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
        var bi = cnt[s]++;
        V.mallas['cuerpo' + s].setMatrixAt(bi, dummy.matrix); V.mallas['cuerpo' + s].setColorAt(bi, col);
        var dx = a.x - cam.x, dz = a.z - cam.z;
        // Brazos y piernas solo de cerca: a más de MIEMBROS_R no se distinguen.
        if (dx * dx + dz * dz < MIEMBROS_R * MIEMBROS_R) {
          miembro(V.mallas['brazo' + (s % 2)], brazos[s % 2]++, a, th, -0.29, 1.34, sw * 0.8, col);
          miembro(V.mallas['brazo' + (s % 2)], brazos[s % 2]++, a, th, 0.29, 1.34, -sw * 0.8, col);
          if (s === 0 || s === 3) { miembro(V.mallas.pierna, piernas++, a, th, -0.11, 0.76, -sw, col); miembro(V.mallas.pierna, piernas++, a, th, 0.11, 0.76, sw, col); }
        }
      }
      for (st = 0; st < 4; st++) fin(V.mallas['cuerpo' + st], cnt[st]);
      for (st = 0; st < 2; st++) fin(V.mallas['brazo' + st], brazos[st]);
      fin(V.mallas.pierna, piernas);
      V.triangulos = 0;
      for (st in V.mallas) if (Object.prototype.hasOwnProperty.call(V.mallas, st)) {
        var mm = V.mallas[st], g = mm.geometry;
        V.triangulos += mm.count * (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    }
    // Una malla sin instancias no se envía: three.js cuenta la llamada igual.
    function fin(m, n) { m.count = n; m.visible = n > 0; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

    // ---- Cada cuadro ------------------------------------------------------------------
    function foco() {
      if (S.xr) return ctx.rig.position;
      if (S.mode === 'walk') return ctx.walk.pos;
      return ctx.cam.cur.target;
    }
    function cuadro(dt) {
      var T = avanzaReloj(dt || 0), ahora = performance.now(), msCuadro = (dt || 0) * 1000;
      V.T = T; V.nCuadro++; V.aplazados = 0;
      // La reconstrucción pendiente avanza un cuarto de lo que dura el cuadro.
      if (V.trabajo) {
        var J = V.trabajo;
        if (trabajoPaso(J, ahora + U.clamp(msCuadro * 0.25, 6, 200))) { trabajoFin(J); V.trabajo = null; }
      }
      // Y los caminos nuevos, un 15 % (entre 3 y 60 ms).
      V.limite = performance.now() + U.clamp(msCuadro * 0.15, 3, 60);
      var ocu = S.cebraOcupada, i;
      for (i = 0; i < V.marcadas.length; i++) if (ocu) ocu[V.marcadas[i]] = 0;
      V.marcadas.length = 0;
      var tp = tope();
      if (!V.hecho || !tp.n) { V.activos = 0; V.dibujados = []; if (V.mallas) dibuja([]); return; }
      mallas();
      // La cámara cuelga del grupo que la lleva a pie: sin refrescar la cadena, en
      // un paso sin dibujo su matriz de mundo es la del cuadro anterior.
      ctx.camera.updateWorldMatrix(true, false);
      var f = foco(), cam = new THREE.Vector3().setFromMatrixPosition(ctx.camera.matrixWorld), lista = [], r2 = tp.r * tp.r, activos = 0;
      // Las zonas cercanas, de la más cercana a la más lejana: si el tiempo de
      // caminos nuevos se acaba, lo que espera es lo más lejano.
      var zs = zonasCerca(f);
      enLaCalle(T, zs, function (v, el, Z) {
        var R = rutaDe(v), k, per = V.personas[v.p], a = andadoEn(R, per.v, el);
        activos++;
        // Los pasos que pisa o va a pisar dentro de AVISO_CEBRA segundos (quien
        // espera su turno en el bordillo no cuenta hasta que le toca).
        if (ocu) for (k = 0; k < R.ocupa.length; k += 3) {
          if (el >= R.ocupa[k + 1] - AVISO_CEBRA && el <= R.ocupa[k + 2] + 0.3 && !ocu[R.ocupa[k]]) { ocu[R.ocupa[k]] = 1; V.marcadas.push(R.ocupa[k]); }
        }
        puntoRuta(R, a.d, _p);
        var dx = _p.x - cam.x, dz = _p.z - cam.z, d2 = dx * dx + dz * dz;
        if (d2 < r2) lista.push({ p: v.p, v: v.id, x: _p.x, y: _p.y, z: _p.z, dx: _p.dx, dz: _p.dz, andado: a.d, quieto: a.quieto, d2: d2 });
      }, true);
      lista.sort(function (a, b) { return a.d2 - b.d2; });
      if (lista.length > tp.n) lista.length = tp.n;
      V.activos = activos; V.dibujados = lista; V.nOcupadas = V.marcadas.length;
      dibuja(lista);
      // Unos 1,2 kB por camino: con más de CACHE_MAX guardados se sueltan los que
      // no se han usado en los últimos PODA_CUADROS cuadros (se recalculan igual).
      if (V.nCache > CACHE_MAX) poda();
    }
    /**
     * Suelta los caminos que no se han usado en PODA_CUADROS cuadros. Nunca vacía
     * la caché entera (ronda 2): hasta la ronda 1, si más del 90 % estaba en uso,
     * la borraba toda, y con parcelas en hora punta eso pasaba 28 veces por
     * minuto. Lo que está en uso es quien está en la calle cerca del foco (los
     * viajes acabados ya se soltaron), así que si pasa de CACHE_MAX la caché
     * crece hasta ese número en vez de tirar lo que se está dibujando.
     */
    function poda() {
      var k, n = 0, lim = V.nCuadro - PODA_CUADROS, nuevo = {}, uso = {};
      for (k in V.cache) {
        if (!Object.prototype.hasOwnProperty.call(V.cache, k)) continue;
        if (V.uso[k] >= lim) { nuevo[k] = V.cache[k]; uso[k] = V.uso[k]; n++; }
      }
      V.cache = nuevo; V.uso = uso; V.nCache = n; V.podas = (V.podas || 0) + 1;
    }

    return {
      listo: function () {
        V.listo = true;
        mallas();
        V.firma = firmaCiudad();
        if (ctx.Q().clusters >= 1) construye();
      },
      ciudad: function () {
        // Las parcelas cambian el catastro (sus edificios, los de barrio que
        // quedan ocultos) y los puestos de trabajo: se rehace todo si cambian,
        // por trozos (trabajoPaso) y con la población de antes en la calle hasta
        // que la nueva está entera. Si cambian otra vez a medias, se empieza de
        // nuevo. La primera ciudad llega antes que «listo» (buildWorld la aplica
        // justo antes): la construcción de «listo» ya la incluye.
        var f = firmaCiudad();
        if (!V.listo || f === V.firma) return;
        V.firma = f;
        if (ctx.Q().clusters >= 1) V.trabajo = trabajoNuevo(true); else { V.hecho = false; V.trabajo = null; }
      },
      calidad: function (nombre, Q) {
        // El grafo se hace con el catastro completo (calidades media, alta y
        // ultra, que dibujan todos los edificios): en baja no hay peatones.
        if (!V.hecho && Q.clusters >= 1 && S.ready) construye();
        mallas();
      },
      cuadro: cuadro,
      empujar: function (pos, r) {
        var l = V.dibujados, i, toco = null, rr = r + PEATON_R;
        for (i = 0; i < l.length && i < 64; i++) {
          var dx = pos.x - l[i].x, dz = pos.z - l[i].z, d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          var d = Math.sqrt(d2);
          if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; } else { dx /= d; dz /= d; }
          pos.x += dx * (rr - d); pos.z += dz * (rr - d);
          toco = 'peaton';
        }
        return toco;
      },
      estadisticas: function (o) {
        o.vida = { zonas: V.zonas.length, aristas: V.nAristas, accesos: V.accesos.length, personas: V.personas.length, viajes: V.viajes.length,
                   enLaCalle: V.activos, dibujados: V.dibujados.length, triangulos: Math.round(V.triangulos || 0), pasosOcupados: V.nOcupadas,
                   caminos: V.nCache, arboles: V.arboles, construccionMs: V.ms, trozos: V.trozos || 1, trozoMaxMs: V.trozoMax, faseDelTrozoMax: V.faseMax, fasesMs: V.fasesMs,
                   reconstruyendo: !!V.trabajo, aplazados: V.aplazados, podas: V.podas || 0, calentados: V.calentados || 0, reloj: Math.round(V.T || 0), tope: tope().n, radio: tope().r };
      },
      soltar: function () { quitaMallas(); },
      publico: {
        version: 1,
        reloj: function () { return V.T; },
        /** Fija el reloj (segundos del día) y lo deja correr desde ahí; null vuelve al de Dubái. */
        fijaReloj: function (T) { V.manual = T === null ? null : ((+T % DIA) + DIA) % DIA; },
        posicion: posicion,
        personas: function () { return V.personas.length; },
        persona: function (i) {
          var p = V.personas[i]; if (!p) return null;
          return { casa: p.casa.P, zona: p.casa.zona, trabajo: p.trabajo ? { P: p.trabajo.P, zona: p.trabajo.zona, parcela: p.trabajo.parcela ? [p.trabajo.parcela.x, p.trabajo.parcela.y] : null, tipo: p.trabajo.tipo } : null,
                   v: p.v, estilo: p.estilo, viajes: p.viajes.map(function (k) { var v = V.viajes[k], R = rutaDe(v); return { tipo: v.tipo, t0: v.t0, zona: v.zona, L: R ? R.L : null, dur: R ? R.dur : null, pasos: R ? R.ceb.length / 3 : 0 }; }) };
        },
        /** Los peatones en la calle a la hora T en las zonas a menos de `radio` de (x, z). */
        enLaCalle: function (T, x, z, radio) {
          var out = [];
          var zs = V.zonas.filter(function (Z) { var dx = Z.x - x, dz = Z.z - z, l = radio + Z.R; return dx * dx + dz * dz < l * l; });
          enLaCalle(T, zs, function (v, el) {
            var R = rutaDe(v), a = andadoEn(R, V.personas[v.p].v, el), o = puntoRuta(R, a.d, {});
            o.i = v.p; o.viaje = v.id; o.tipo = v.tipo; o.andado = a.d; o.quieto = a.quieto; out.push(o);
          });
          return out;
        },
        /** Los pasos de peatones de un viaje: [id, metros de entrada, metros de salida, segundo del día en que lo pisa, en que lo deja]. */
        pasosDe: function (vid) {
          var v = V.viajes[vid], R = v && rutaDe(v), out = [], k; if (!R) return out;
          for (k = 0; k < R.ceb.length; k += 3) out.push([R.ceb[k], R.ceb[k + 1], R.ceb[k + 2], (v.t0 + R.ocupa[k + 1]) % DIA, (v.t0 + R.ocupa[k + 2]) % DIA]);
          return out;
        },
        ciclo: { CICLO: CICLO, VENTANA: VENTANA },
        viaje: function (vid) { var v = V.viajes[vid]; return v ? { p: v.p, t0: v.t0, zona: v.zona, tipo: v.tipo, vuelta: v.vuelta } : null; },
        ruta: function (vid) { var v = V.viajes[vid], R = v && rutaDe(v); return R ? { x: Array.prototype.slice.call(R.x), y: Array.prototype.slice.call(R.y), z: Array.prototype.slice.call(R.z), L: R.L, dur: R.dur, ceb: R.ceb.slice() } : null; },
        /** Borra caminos y árboles guardados (para comprobar que se recalculan igual). */
        limpia: function () {
          V.cache = {}; V.uso = {}; V.nCache = 0; for (var i = 0; i < V.zonas.length; i++) V.zonas[i].arbol = {};
          if (V.dur) for (i = 0; i < V.dur.length; i++) V.dur[i] = NaN;
        },
        /** De una vez; con `porTrozos`, como al cambiar las parcelas (avanza en cada cuadro). */
        reconstruye: function (porTrozos) { if (porTrozos) { V.trabajo = trabajoNuevo(true); return 0; } construye(); return V.ms; },
        reconstruyendo: function () { return !!V.trabajo; },
        paradas: function (zi) { var Z = V.zonas[zi]; return Z && Z.paradas ? Z.paradas.map(function (id) { var b = bordilloDe(Z, id); return { nodo: id, x: b[0], y: b[1], z: b[2] }; }) : []; },
        zona: function (i) { var Z = V.zonas[i]; return Z ? { tipo: Z.tipo, kind: Z.kind, x: Z.x, z: Z.z, R: Z.R, aristas: Z.aristas ? Z.aristas.length : 0, accesos: Z.accesos.length, viajes: Z.viajes.length, q: Z.q, T: Z.T, Dc: Z.Dc, m: Z.m } : null; },
        dibujados: function () { return V.dibujados.map(function (a) { return { i: a.p, x: a.x, y: a.y, z: a.z }; }); },
        topes: TOPES, radioAndable: RADIO_ANDABLE,
        /** ¿Cae (x, z) en la calzada de alguna calle (la del paso que se cruza incluida)? Para las pruebas. */
        enCalzada: function (x, z) { return V.asfalto ? enAsfalto(x, z, -2) : null; },
        /** Por qué un portal se quedó sin acera (recuentos de la última construcción). */
        diagnostico: function () { return V.diag; },
        /**
         * La prueba de márgenes: reconstruye con los puntos desplazados (dx, dz)
         * metros y devuelve la huella del genotipo (aristas, accesos, trabajo y
         * viajes de cada persona); sin argumentos, la huella de lo que hay.
         * Después reconstruye sin desplazar.
         */
        huella: function (dx, dz) {
          if (dx !== undefined) { SONDA.x = dx; SONDA.z = dz; try { construye(); } finally { SONDA.x = 0; SONDA.z = 0; } }
          // Por partes: el grafo (qué aristas y pasos existen), sus pesos en cm, los
          // accesos (arista) y su sitio en cm, el trabajo de cada persona y los viajes.
          var hs = [0, 0, 0, 0, 0, 0], n = [0, 0, 0, 0], i, k;
          function mete(q, x) { hs[q] = mezcla(hs[q], x | 0); }
          for (i = 0; i < V.zonas.length; i++) {
            var Z = V.zonas[i]; if (!Z.aristas) continue;
            for (k = 0; k < Z.aristas.length; k++) { var e = Z.aristas[k]; mete(0, e.a); mete(0, e.b); mete(0, e.cebra); mete(1, e.peso); n[0]++; }
          }
          for (i = 0; i < V.accesos.length; i++) { var a = V.accesos[i]; mete(2, a.zona); mete(2, a.e === undefined ? -1 : a.e); mete(3, Math.round((a.u || 0) * 100)); n[1]++; }
          for (i = 0; i < V.personas.length; i++) { var p = V.personas[i]; mete(4, p.casa.id); mete(4, p.trabajo ? p.trabajo.id : -1); n[2]++; }
          for (i = 0; i < V.viajes.length; i++) { var v = V.viajes[i]; mete(5, v.t0); mete(5, v.zona); mete(5, v.src.id); n[3]++; }
          var h = 0; for (i = 0; i < hs.length; i++) h = mezcla(h, hs[i]);
          // El margen de los redondeos a centímetros (pesos del grafo y sitio del
          // acceso): lo más cerca que cae un valor de la mitad entre dos enteros.
          var mr = Infinity;
          function margen(x) { var f = x - Math.floor(x); mr = Math.min(mr, Math.abs(f - 0.5)); }
          for (i = 0; i < V.zonas.length; i++) if (V.zonas[i].aristas) for (k = 0; k < V.zonas[i].aristas.length; k++) margen(V.zonas[i].aristas[k].len * 100);
          for (i = 0; i < V.accesos.length; i++) if (V.accesos[i].u !== undefined) margen(V.accesos[i].u * 100);
          var out = { huella: h, partes: { grafo: hs[0], pesosCm: hs[1], accesos: hs[2], sitioAccesoCm: hs[3], trabajos: hs[4], viajes: hs[5] },
                      aristas: n[0], accesos: n[1], personas: n[2], viajes: n[3], margenRedondeoCm: mr };
          if (dx !== undefined) construye();
          return out;
        },
        /** Cuántos trabajan en las parcelas (y cuántos puestos suman sus plantillas) y cuántos en las oficinas, por barrio. */
        empleo: function () { return V.empleo || null; }
      }
    };
    /**
     * Lo que cambia quién trabaja dónde: el sitio, el sector y la plantilla de
     * cada empresa (que solo cambia cuando los ingresos se duplican o cambian los
     * activos), y los edificios de barrio ocultos. Los ingresos crecen cada
     * bloque: con ellos en la firma se rehacía la población entera en cada uno.
     */
    function firmaCiudad() {
      var p = (S.city && S.city.parcels) || [], out = [], i;
      for (i = 0; i < p.length; i++) out.push(p[i].x + ',' + p[i].y + ',' + (p[i].kind | 0) + ',' + plantilla(p[i]));
      out.sort();
      return out.join(';') + '|' + (S.ocultos || 0);
    }
  });
})(typeof window !== 'undefined' ? window : this);
