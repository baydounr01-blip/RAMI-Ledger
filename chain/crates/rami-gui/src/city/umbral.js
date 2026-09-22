/*
 * Dubái RAMI — módulo «umbral»: el umbral y el apartamento.
 *
 * Entrega 5 del plan del metaverso (docs/METAVERSO.md): cruzar el portal de un
 * edificio sin pantalla de carga —zaguán, ascensor, apartamento amueblado— y ver
 * la ciudad de verdad por la ventana, porque es la de verdad.
 *
 * Cómo está hecho, en cuatro ideas:
 *
 * 1. EL PORTAL SALE DEL CATÁLOGO, NO DE UNA COPIA. Cada edificio (los 3.052 de
 *    barrio y los de las parcelas) se vuelve a pedir al catálogo de cuerpos del
 *    núcleo (`edificioPartes`, `parcelaPartes`) y en la lista de piezas se busca
 *    la puerta por su firma: el tono de puerta y un hueco de persona (≤ 3,5 m).
 *    Así el portal está exactamente donde se dibuja en cada variante —lámina,
 *    en L, en U, gemelas, villa, nave, cada sector— sin repetir una sola fórmula.
 *    Los portales van en una rejilla de 64 m y la búsqueda del cercano corre
 *    cada 0,1 s mirando nueve celdas.
 *
 * 2. EL EDIFICIO ES EL ÚNICO HUECO DE LA CIUDAD. La malla de los edificios es de
 *    caras frontales: desde dentro no se dibuja. El interior es una envolvente
 *    cerrada (suelo, techo y paredes) con huecos donde hay ventana o puerta. Se
 *    pinta en dos pasadas: la primera escribe SOLO profundidad con la prueba
 *    «siempre» (borra lo que del edificio o de sus vecinos se cuele dentro del
 *    volumen del interior), la segunda pinta con la prueba normal. Donde la
 *    envolvente tiene un hueco la primera pasada no escribe, y queda lo que el
 *    visor ya había dibujado: la ciudad real, a la altura real. Solo se dibuja el
 *    espacio en el que está la cámara (zaguán, cabina o planta), para que ningún
 *    otro trozo del interior se proyecte por una ventana.
 *
 * 3. GENOTIPO EN ENTEROS. La distribución del piso, los colores, la planta de
 *    muestra y los coches de exposición salen de `semillaMorfologia` del
 *    edificio con los canales 41–43 y de los datos de la ciudad; nunca de
 *    `Math.random`. Mover muebles es cliente, no consenso: se guarda en el
 *    navegador (`localStorage`, 'rami.piso.' + id).
 *
 * 4. NADA EXISTE FUERA. El interior se construye al entrar (en el mismo cuadro
 *    en que se cruza la puerta) y se libera al salir; fuera, los encuadres dan
 *    las mismas cifras que sin el módulo. Ninguna luz de three.js: el material
 *    del interior lleva sus lámparas como uniformes y la luz del día entra por
 *    el plano de las ventanas con el sol, el cielo y la noche del visor.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('umbral', function (ctx) {
    var THREE = ctx.THREE, S = ctx.S, walk = ctx.walk, UT = ctx.util, G = ctx.geom, MU = ctx.mundo, t = ctx.t;
    var clamp = UT.clamp, lerp = UT.lerp, lcg = UT.lcg, real01 = UT.real01, semilla = UT.semillaMorfologia;

    // ---- Medidas ----------------------------------------------------------------
    var ALCANCE = 3.0;            // m desde el punto de llegada del portal para ofrecer «Entrar»
    var PASO_BUSCA = 0.1;         // s entre dos búsquedas del portal cercano
    var REJILLA = 64;             // m: celda del índice de portales
    var R_JUGADOR = 0.3;          // m: el jugador dentro, un círculo
    var ALTO_PLANTA = 3.6;        // m de forjado a forjado (el mismo paso que las ventanas del sombreador)
    var LIBRE = 2.8;              // m de altura libre de un piso
    var FACHADA_POR_UNIDAD = 11;  // m de fachada por vivienda: unidades por planta = ⌊(ancho − 1) / 11⌋, de 1 a 4
    var VEL = 2.4;                // m/s andando dentro (y en los tramos guiados)
    var CANAL_PISO = 41, CANAL_MUESTRA = 42, CANAL_EXPO = 43;
    var MAX_LAMPARAS = 8, LAMPARA_CABINA = 7, LAMPARA_RELLANO = 6;

    // ---- Paletas (sRGB) ---------------------------------------------------------
    var PAL = {
      pared: ['#ebe6dc', '#dde5e8', '#efe6d4', '#e3dce6', '#dde7da', '#f1ede6'],
      madera: ['#9a7652', '#b58f66', '#7a5a3d', '#c4a47c', '#8b6b4e'],
      marmol: ['#d9d5cd', '#c8c3ba', '#e4dfd5', '#bfc6c9'],
      sofa: ['#5a6e8c', '#8c5a4f', '#4f7a66', '#b8a58c', '#6b5d7a', '#3f4a57'],
      alfombra: ['#a84a3c', '#3c6f8c', '#c9a44a', '#6a8c4f', '#8c4f7a', '#d8cbb0'],
      mueble: ['#6e4b32', '#a07a55', '#3b2f28', '#c8b08a', '#e8e4dc'],
      azulejo: ['#dfeef2', '#f2efe8', '#d9e6df', '#e9e1d8'],
      carpinteria: ['#f2f2f0', '#3a3d42', '#8a8f96'],
      funda: ['#e8e2d6', '#c9d6e3', '#e3c9c0', '#d2dcc6', '#f0e6c8'],
      libro: ['#8c2f2f', '#2f4f8c', '#c9a44a', '#2f6b4f', '#e8e4dc', '#4a4a4a', '#b0603a']
    };
    function hex(h) { return [parseInt(h.substr(1, 2), 16) / 255, parseInt(h.substr(3, 2), 16) / 255, parseInt(h.substr(5, 2), 16) / 255]; }
    function elige(lista, u) { return hex(lista[Math.min(lista.length - 1, Math.floor(u * lista.length))]); }
    function tono(c, k) { return [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)]; }
    var ACERO = [0.72, 0.74, 0.78], NEGRO = [0.05, 0.05, 0.06], BLANCO = [0.94, 0.94, 0.93], PANTALLA = [0.03, 0.035, 0.045];
    var TERRACOTA = [0.72, 0.42, 0.3], HOJA = [0.26, 0.5, 0.28], PANTALLA_LUZ = [1, 0.94, 0.82];

    // ---- Material del interior ---------------------------------------------------
    // Color por vértice; `aLamp` = índice + 1 de la lámpara a la que pertenece la
    // pieza (la pantalla brilla si está encendida); `aDesliza` = −1/+1 en las hojas
    // de la puerta del ascensor, que se abren con `uAbre` (metros, eje x local).
    var VS = [
      '#include <common>',
      '#include <color_pars_vertex>',
      '#include <logdepthbuf_pars_vertex>',
      'attribute float aLamp; attribute float aDesliza;',
      'uniform float uAbre;',
      'varying vec3 vN; varying vec3 vW; varying float vLamp;',
      '#ifdef MAPA', 'varying vec2 vUv;', '#endif',
      'void main(){',
      '  #include <color_vertex>',
      '  #ifdef MAPA', '  vUv = uv;', '  #endif',
      '  vec3 p = position; p.x += aDesliza * uAbre;',
      '  vec4 wp = modelMatrix * vec4(p, 1.0); vW = wp.xyz;',
      '  vN = normalize(mat3(modelMatrix) * normal); vLamp = aLamp;',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '  #include <logdepthbuf_vertex>',
      '}'].join('\n');
    var FS = [
      '#include <common>',
      '#include <color_pars_fragment>',
      '#include <logdepthbuf_pars_fragment>',
      'uniform vec3 uSun, uSunColor, uSkyColor; uniform float uNight;',
      'uniform vec3 uLampPos[8]; uniform float uLampOn[8]; uniform vec3 uLampCol[8];',
      'uniform vec3 uVenN; uniform float uVenD; uniform float uVentanas; uniform float uK;',
      'varying vec3 vN; varying vec3 vW; varying float vLamp;',
      '#ifdef MAPA', 'uniform sampler2D uMapa; varying vec2 vUv;', '#endif',
      'void main(){',
      '  #include <logdepthbuf_fragment>',
      '  vec3 base = vec3(1.0);',
      '  #ifdef USE_COLOR', '  base = vColor.rgb;', '  #endif',
      '  #ifdef MAPA', '  base *= texture2D(uMapa, vUv).rgb;', '  #endif',
      '  vec3 n = normalize(vN);',
      // La luz del día que entra: del sol y del cielo del visor, por el plano de
      // las ventanas, más fuerte cerca de ellas y en las caras que las miran.
      '  float dia = clamp(uSun.y * 3.0, 0.0, 1.0) * (1.0 - uNight);',
      '  float dW = max(uVenD - dot(uVenN, vW), 0.0);',
      '  float entra = uVentanas * uK * dia * (0.28 + 1.15 * exp(-dW * 0.30));',
      '  float cara = 0.62 + 0.38 * max(dot(n, uVenN), 0.0) + 0.12 * max(n.y, 0.0);',
      '  vec3 cielo = uSkyColor * 2.1 + uSunColor * 0.30;',
      '  vec3 luz = vec3(0.030, 0.029, 0.034) + cielo * entra * cara;',
      '  luz += vec3(0.020, 0.022, 0.034) * uNight * uVentanas * uK * exp(-dW * 0.25);',   // el resplandor de la ciudad, de noche
      '  float brillo = 0.0;',
      '  for (int i = 0; i < 8; i++) {',
      '    vec3 d = uLampPos[i] - vW; float r2 = dot(d, d);',
      '    float nd = max(dot(n, d * inversesqrt(max(r2, 1e-4))), 0.0);',
      '    luz += uLampCol[i] * uLampOn[i] * (0.30 + 0.70 * nd) * 2.4 / (1.0 + r2 * 0.22);',
      '    brillo += uLampOn[i] * (1.0 - step(0.5, abs(vLamp - float(i + 1))));',
      '  }',
      '  vec3 col = base * luz + base * brillo * 1.7;',
      '  gl_FragColor = vec4(col, 1.0);',
      '  #include <tonemapping_fragment>',
      '  #include <encodings_fragment>',
      '}'].join('\n');
    var sh = ctx.shared;
    var UNI = {
      uSun: sh.uSun, uSunColor: sh.uSunColor, uSkyColor: sh.uSkyColor, uNight: sh.uNight,
      uLampPos: { value: [] }, uLampOn: { value: [] }, uLampCol: { value: [] },
      uVenN: { value: new THREE.Vector3(0, 0, 1) }, uVenD: { value: 0 }, uVentanas: { value: 0 }
    };
    for (var il = 0; il < MAX_LAMPARAS; il++) { UNI.uLampPos.value.push(new THREE.Vector3()); UNI.uLampOn.value.push(0); UNI.uLampCol.value.push(new THREE.Vector3(1, 0.72, 0.45)); }
    /**
     * Un material del interior. Va en la lista de los transparentes (sin mezcla:
     * el color sale opaco) para dibujarse DESPUÉS de todo lo del visor, incluidos
     * el mar, las estrellas y los rótulos: el mar es transparente y, dibujado
     * detrás del interior, se colaba por encima de él bajo la línea del horizonte
     * (medido: con el mar oculto, la mancha desaparecía). Así el interior tapa
     * lo que haya y por las ventanas queda la ciudad tal como la dibujó el visor.
     * `soloFondo`: la primera pasada (solo profundidad,
     * prueba «siempre»); comparte el sombreador de vértices con la segunda para
     * que las dos escriban exactamente la misma profundidad.
     */
    function material(op) {
      op = op || {};
      var u = {}, k;
      for (k in UNI) u[k] = UNI[k];
      u.uAbre = op.uAbre || { value: 0 }; u.uK = { value: op.k === undefined ? 1 : op.k };
      if (op.mapa) u.uMapa = { value: op.mapa };
      var m = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: FS, vertexColors: op.color !== false, fog: false, lights: false, defines: op.mapa ? { MAPA: 1 } : {},
        transparent: true, blending: THREE.NoBlending, depthWrite: true });
      if (op.soloFondo) { m.colorWrite = false; m.depthFunc = THREE.AlwaysDepth; }
      return m;
    }
    var MAT = null;                   // se crean al primer uso y se reutilizan (un programa)
    function mats() {
      if (!MAT) MAT = { fondo: material({ soloFondo: true }), env: material(), dec: material(), fondoCab: material({ soloFondo: true, k: 0 }), envCab: material({ k: 0 }), hojas: { value: 0 } };
      if (!MAT.cabDec) MAT.cabDec = material({ k: 0, uAbre: MAT.hojas });
      return MAT;
    }

    // ---- Acumuladores de geometría ------------------------------------------------
    var _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
    function lote() { return { pos: [], nor: [], col: [], lamp: [], desl: [] }; }
    function pon(a, p, lamp, desl, padre) {
      G.pushPart(a, p, padre || null);
      var v = lamp || 0, s = desl || 0;
      while (a.lamp.length * 3 < a.pos.length) { a.lamp.push(v); a.desl.push(s); }
    }
    /** Caja por sus esquinas (marco local del edificio). */
    function caja(a, x0, y0, z0, x1, y1, z1, c, lamp, desl) {
      if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || z1 - z0 < 1e-3) return;
      pon(a, { sx: x1 - x0, sy: y1 - y0, sz: z1 - z0, x: (x0 + x1) / 2, y: y0, z: (z0 + z1) / 2, c: c }, lamp, desl);
    }
    function geometria(a) {
      if (!a.pos.length) return null;
      var g = G.accGeometry(a);
      g.setAttribute('aLamp', new THREE.Float32BufferAttribute(a.lamp, 1));
      g.setAttribute('aDesliza', new THREE.Float32BufferAttribute(a.desl, 1));
      return g;
    }
    function malla(g, m, orden) {
      var o = new THREE.Mesh(g, m); o.renderOrder = orden; o.castShadow = false; o.receiveShadow = false; o.matrixAutoUpdate = true;
      return o;
    }

    // ---- Marco local de un edificio -------------------------------------------------
    // Mundo = O + R_y(yaw)·local (el mismo compose que usa el núcleo): +z local es
    // el frente, hacia la calle. El «yaw a pie» local yl y el del mundo se suman.
    function marco(o, yaw) { return { ox: o.x, oy: o.y, oz: o.z, yaw: yaw, c: Math.cos(yaw), s: Math.sin(yaw) }; }
    function aMundo(m, lx, lz, out) { out = out || {}; out.x = m.ox + lx * m.c + lz * m.s; out.z = m.oz - lx * m.s + lz * m.c; return out; }
    function aLocal(m, wx, wz, out) { out = out || {}; var dx = wx - m.ox, dz = wz - m.oz; out.x = dx * m.c - dz * m.s; out.z = dx * m.s + dz * m.c; return out; }
    function dirMundo(m, dx, dz, out) { out = out || {}; out.x = dx * m.c + dz * m.s; out.z = -dx * m.s + dz * m.c; return out; }
    function dirLocal(m, dx, dz, out) { out = out || {}; out.x = dx * m.c - dz * m.s; out.z = dx * m.s + dz * m.c; return out; }
    function angulo(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

    // =====================================================================================
    // 1. PORTALES: dónde está la puerta de cada edificio
    // =====================================================================================
    /** La puerta en una lista de piezas del catálogo: tono de puerta y hueco de persona. */
    function esPuerta(p) {
      var c = p.c;
      return !p.g && c && Math.abs(c[0] - 0.06) < 1e-6 && Math.abs(c[1] - 0.07) < 1e-6 && Math.abs(c[2] - 0.09) < 1e-6 && (p.sx || 1) <= 3.5 && (p.sy || 1) <= 3.3;
    }
    /**
     * { px, zf, dw, dh }: el centro del hueco en x, el plano de la fachada (la
     * puerta del portal es una caja de 0,6 m que sobresale de zf; la de villas y
     * naves, de 0,5 m desde zf − 0,05), el ancho y el alto de la puerta.
     */
    function puertaDe(piezas) {
      for (var i = 0; i < piezas.length; i++) {
        var p = piezas[i];
        if (esPuerta(p)) return { px: p.x || 0, zf: (p.z || 0) - p.sz / 2 + (p.sz < 0.55 ? 0.05 : 0), dw: p.sx, dh: p.sy };
      }
      return null;
    }
    var portales = [], indice = {}, porId = {};
    function claveRejilla(x, z) { return Math.floor(x / REJILLA) + ':' + Math.floor(z / REJILLA); }
    function indexa(po) {
      porId[po.id] = po;
      var k = claveRejilla(po.A.x, po.A.z);
      (indice[k] || (indice[k] = [])).push(po);
      portales.push(po);
    }
    /** El punto de llegada: delante de la puerta o, si está en un patio (L, U), en la boca del patio. */
    function completaPortal(po) {
      var m = marco(po.o, po.yaw), pz = po.puerta, zA;
      if (pz.zf < po.hd - 0.3 && pz.zf > -po.hd && Math.abs(pz.px) < po.hw) { zA = po.hd + 0.75; po.patio = true; }
      else { zA = pz.zf + 1.35; po.patio = false; }
      po.m = m; po.zA = zA;
      po.A = aMundo(m, pz.px, zA); po.D = aMundo(m, pz.px, pz.zf);
      return po;
    }
    var TIPO_BARRIO = { towers: 'Torre', blocks: 'Bloque', villas: 'Villa', warehouses: 'Nave' };
    /** Los portales de los barrios: una vez, al tener el mundo. */
    function indexaBarrios() {
      var i, j, t0 = performance.now(), n = 0;
      for (i = 0; i < S.edificios.length; i++) for (j = 0; j < S.edificios[i].length; j++) {
        var e = S.edificios[i][j], pz = puertaDe(G.edificioPartes(e));
        if (!pz) continue;
        indexa(completaPortal({ id: 'b:' + Math.round(e.x) + ':' + Math.round(e.z), tipo: 'barrio', e: e, bi: i, bj: j, o: { x: e.x, y: e.y, z: e.z }, yaw: e.yaw, suelo: 1,
          puerta: pz, hw: e.w / 2, hd: e.d / 2, kind: e.kind, nombre: e.barrio || '', sx: Math.round(e.x), sz: Math.round(e.z) }));
        n++;
      }
      medidas.portalesBarrio = n; medidas.msIndice = performance.now() - t0;
    }
    /** Los datos del edificio de una parcela, con las mismas cuentas que applyCity. */
    function edificioParcela(pc) {
      var N = ctx.N(), CELL = ctx.CELL(), x = pc.x | 0, y = pc.y | 0;
      var kind = clamp(pc.kind | 0, 0, MU.SECTOR_COLORS.length - 1), pend = !!pc.pending, arch = MU.SECTOR_ARCH[kind] || 'torre';
      var sy = (pend ? 0.3 : 1) * (0.85 + 0.3 * real01(semilla(x, y, 2)) + Math.min(pc.assets | 0, 6) * 0.03);
      var ed = G.parcelaPartes(arch, CELL, { v: real01(semilla(x, y, 13)), v2: real01(semilla(x, y, 14)), sy: sy, T: [1, 1, 1] });
      var w = MU.cellWorld(x, y), y0 = S.cellH[y * N + x] + 0.5 - ed.suelo;
      return { kind: kind, arch: arch, ed: ed, o: { x: w.x, y: y0, z: w.z } };
    }
    var portalesParcela = [];
    /** Los portales de las parcelas: en cada ciudad nueva. */
    function indexaParcelas() {
      var i, k, lista;
      for (i = 0; i < portalesParcela.length; i++) {
        var po = portalesParcela[i]; delete porId[po.id];
        lista = indice[claveRejilla(po.A.x, po.A.z)]; if (lista) { k = lista.indexOf(po); if (k >= 0) lista.splice(k, 1); }
        k = portales.indexOf(po); if (k >= 0) portales.splice(k, 1);
      }
      portalesParcela = [];
      var ps = (S.city && S.city.parcels) || [], N = ctx.N();
      for (i = 0; i < ps.length; i++) {
        var pc = ps[i];
        if (!(pc.x >= 0 && pc.x < N && pc.y >= 0 && pc.y < N)) continue;
        var ep = edificioParcela(pc), pz = puertaDe(ep.ed.p);
        if (!pz) continue;
        var p2 = completaPortal({ id: 'p:' + (pc.x | 0) + ':' + (pc.y | 0), tipo: 'parcela', pc: pc, cx: pc.x | 0, cy: pc.y | 0, o: ep.o, yaw: ctx.rotR(), suelo: ep.ed.suelo,
          puerta: pz, hw: ep.ed.hw, hd: ep.ed.hd, arch: ep.arch, kind: ep.kind, nombre: pc.name || MU.sectorName(ep.kind), sx: pc.x | 0, sz: pc.y | 0 });
        indexa(p2); portalesParcela.push(p2);
      }
    }
    /** ¿Se dibuja hoy ese edificio? (calidad y ocultos bajo una parcela) */
    function dibujado(po) {
      if (po.tipo !== 'barrio') return true;
      if (po.e.oculto) return false;
      var lista = S.edificios[po.bi];
      return !!lista && po.bj < Math.round(lista.length * ctx.Q().clusters);
    }
    function nombrePortal(po) {
      if (po.tipo === 'barrio') return t(TIPO_BARRIO[po.kind] || 'Edificio') + (po.nombre ? ' · ' + po.nombre : '');
      var h = po.pc && po.pc.handle ? ' · @' + po.pc.handle : '';
      return (po.nombre || t(MU.sectorName(po.kind))) + h;
    }
    var medidas = { busquedas: 0, msBusqueda: 0, msBusquedaMax: 0, msBusquedaTotal: 0, portalesBarrio: 0, msIndice: 0, msConstruir: 0 };
    /** El portal al que se está mirando a menos de ALCANCE, o null. */
    function buscaCercano() {
      var t0 = performance.now(), px = walk.pos.x, pz = walk.pos.z;
      var fx = -Math.sin(walk.yaw), fz = -Math.cos(walk.yaw), mejor = null, md = ALCANCE, i, j, n;
      var ci = Math.floor(px / REJILLA), cj = Math.floor(pz / REJILLA);
      for (i = -1; i <= 1; i++) for (j = -1; j <= 1; j++) {
        var lista = indice[(ci + i) + ':' + (cj + j)]; if (!lista) continue;
        for (n = 0; n < lista.length; n++) {
          var po = lista[n], dx = po.A.x - px, dz = po.A.z - pz, d = Math.sqrt(dx * dx + dz * dz);
          if (d >= md || !dibujado(po)) continue;
          var vx = po.D.x - px, vz = po.D.z - pz, vl = Math.sqrt(vx * vx + vz * vz) || 1;
          if ((vx * fx + vz * fz) / vl < 0.35) continue;                                   // mirándolo (±70°)
          mejor = po; md = d;
        }
      }
      var ms = performance.now() - t0;
      medidas.busquedas++; medidas.msBusqueda = ms; medidas.msBusquedaTotal += ms; if (ms > medidas.msBusquedaMax) medidas.msBusquedaMax = ms;
      return mejor ? { po: mejor, d: md } : null;
    }

    // =====================================================================================
    // 2. EL PLAN: qué hay dentro de cada edificio
    // =====================================================================================
    function esCuerpo(p, suelo) { return !p.g && (p.y || 0) <= suelo + 0.01 && (p.sy || 1) >= 6 && (p.sx || 1) >= 5 && (p.sz || 1) >= 5; }
    function rect(p) { return { x0: (p.x || 0) - p.sx / 2, x1: (p.x || 0) + p.sx / 2, z0: (p.z || 0) - p.sz / 2, z1: (p.z || 0) + p.sz / 2, y0: p.y || 0, y1: (p.y || 0) + p.sy, x: p.x || 0, z: p.z || 0, sx: p.sx, sz: p.sz }; }
    /** La semilla del edificio para un canal: barrio por su posición redondeada, parcela por su celda. */
    function semillaEdificio(po, canal, extra) {
      var h = semilla(po.sx, po.sz, canal);
      if (extra) h = (h ^ Math.imul(extra | 0, 0x9e3779b9)) >>> 0;
      return h;
    }
    function tipoInterior(po) {
      if (po.tipo === 'barrio') return po.kind === 'villas' ? 'villa' : (po.kind === 'warehouses' ? 'nave' : 'torre');
      if (po.arch === 'hotel') return 'hotel';
      if (po.arch === 'concesionario') return 'concesionario';
      if (po.arch === 'industria' || po.arch === 'solar' || po.arch === 'agua' || po.arch === 'granja' || po.arch === 'taxi') return 'nave';
      return 'torre';
    }
    /**
     * El plan de un edificio: el cuerpo del portal (B0), el cuerpo alto (B1, donde
     * van los pisos), las plantas cuya fachada da a la calle sin nada delante, las
     * unidades por planta y la posición del ascensor, el zaguán y el rellano.
     */
    function planifica(po) {
      var piezas = po.tipo === 'barrio' ? G.edificioPartes(po.e) : edificioParcela(po.pc).ed.p;
      var su = po.suelo, pz = po.puerta, i, cuerpos = [], otros = [];
      for (i = 0; i < piezas.length; i++) {
        if (esCuerpo(piezas[i], su)) cuerpos.push(rect(piezas[i]));
        else if (!piezas[i].g) otros.push(rect(piezas[i]));
      }
      var B0 = null, B1 = null;
      for (i = 0; i < cuerpos.length; i++) {
        var b = cuerpos[i];
        if (!B0 && Math.abs(b.z1 - pz.zf) < 0.6 && pz.px >= b.x0 - 0.01 && pz.px <= b.x1 + 0.01) B0 = b;
      }
      if (!B0) {                                                                            // la puerta no está en ninguna fachada: el cuerpo más cercano
        var md = 1e9;
        for (i = 0; i < cuerpos.length; i++) { var dd = Math.abs(cuerpos[i].z1 - pz.zf) + Math.abs(clamp(pz.px, cuerpos[i].x0, cuerpos[i].x1) - pz.px); if (dd < md) { md = dd; B0 = cuerpos[i]; } }
      }
      if (!B0) B0 = { x0: pz.px - 6, x1: pz.px + 6, z0: pz.zf - 12, z1: pz.zf, y0: 0, y1: su + 4, x: pz.px, z: pz.zf - 6, sx: 12, sz: 12 };
      for (i = 0; i < cuerpos.length; i++) {
        var c = cuerpos[i];
        if (!B1 || c.y1 > B1.y1 + 0.01 || (Math.abs(c.y1 - B1.y1) <= 0.01 && Math.abs(c.x - pz.px) < Math.abs(B1.x - pz.px) - 0.01)) B1 = c;
      }
      if (!B1) B1 = B0;
      for (i = 0; i < cuerpos.length; i++) if (cuerpos[i] !== B1) otros.push(cuerpos[i]);
      var plan = { po: po, tipo: tipoInterior(po), piezas: piezas, B0: B0, B1: B1, suelo: su, px: pz.px, zf: pz.zf, dw: pz.dw };
      plan.hueco = clamp(pz.dw - 1.2, 1.0, 2.0);
      if (plan.tipo === 'torre' || plan.tipo === 'hotel' || plan.tipo === 'concesionario') {
        // Plantas con la fachada del cuerpo alto libre: nada del propio edificio
        // (podio, cuerpos escalonados, peto, marquesina) delante de las ventanas.
        // Por planta, el tramo de fachada libre en torno al portal: lo que tape por
        // delante del cuerpo alto (podio, cuerpos escalonados, las alas de una U o
        // de una L, el peto) lo recorta o, si cae encima del portal, anula la planta.
        var top = B1.y1 - 1.5, zF = B1.z1, validas = [], tramos = {}, k, altoZ = altoZaguan(plan.tipo), anc = clamp(pz.px, B1.x0 + 4, B1.x1 - 4);
        var tramoLibre = function (yb) {
          var a = B1.x0, b = B1.x1, j;
          for (j = 0; j < otros.length; j++) {
            var o = otros[j];
            if (!(o.z1 > zF + 0.05 && o.z0 < zF + 1.2 && o.y0 < yb + 2.6 && o.y1 > yb + 0.6 && o.x0 < b && o.x1 > a)) continue;
            if (o.x1 <= anc) a = Math.max(a, o.x1); else if (o.x0 >= anc) b = Math.min(b, o.x0); else return null;
          }
          return b - a >= 7.5 ? { a: a, b: b } : null;
        };
        for (k = 1; k < 200; k++) {
          var yb = su + ALTO_PLANTA * k; if (yb + ALTO_PLANTA > top) break;
          if (ALTO_PLANTA * k < altoZ + 0.4) continue;                                         // encima del techo del zaguán
          var tr = tramoLibre(yb);
          if (tr) { validas.push(k); tramos[k] = tr; }
        }
        // Un solo tramo para todas las plantas (las unidades se numeran igual en
        // cada una): la intersección; si queda corta, las plantas que contienen el
        // tramo de la más alta.
        if (validas.length) {
          var fa = -1e9, fb = 1e9, ta = tramos[validas[validas.length - 1]];
          for (k = 0; k < validas.length; k++) { fa = Math.max(fa, tramos[validas[k]].a); fb = Math.min(fb, tramos[validas[k]].b); }
          if (fb - fa < 7.5) { validas = validas.filter(function (q) { return tramos[q].a <= ta.a + 0.01 && tramos[q].b >= ta.b - 0.01; }); fa = ta.a; fb = ta.b; }
          plan.fx0 = fa; plan.fx1 = fb;
        }
        plan.plantas = validas;
        if (!validas.length) plan.tipo = 'villa';                                          // demasiado bajo: la casa en planta baja
      }
      if (plan.tipo === 'villa') return planVilla(plan);
      if (plan.tipo === 'nave') return planNave(plan);
      // Torre, hotel y concesionario: zaguán, ascensor y pisos.
      var b1 = B1;
      plan.upp = clamp(Math.floor((plan.fx1 - plan.fx0 - 1) / FACHADA_POR_UNIDAD), 1, 4);
      plan.zF = b1.z1; plan.zI = b1.z1 - 0.35;
      plan.D = clamp(b1.sz - 6, 6.5, 10.5);
      plan.zA0 = plan.zI - plan.D;
      plan.ex = clamp(pz.px, plan.fx0 + 1.6, plan.fx1 - 1.6);
      var fondoZ = plan.tipo === 'concesionario' ? 20 : (plan.tipo === 'hotel' ? 12 : 7.5);
      plan.zL0 = Math.min(plan.zA0 - 2.4, pz.zf - 0.45 - fondoZ);
      var ancho = plan.tipo === 'concesionario' ? 17 : (plan.tipo === 'hotel' ? 7 : 3.4);
      plan.zx0 = Math.max(Math.min(pz.px - ancho, plan.ex - 2.4), B0.x0 + 0.6);
      plan.zx1 = Math.min(Math.max(pz.px + ancho, plan.ex + 2.4), B0.x1 - 0.6);
      if (plan.zx1 - plan.zx0 < 5) { plan.zx0 = Math.min(pz.px, plan.ex) - 2.6; plan.zx1 = Math.max(pz.px, plan.ex) + 2.6; }
      plan.zaguan = { x0: plan.zx0, x1: plan.zx1, z0: plan.zL0, z1: pz.zf - 0.45, yb: su, alto: altoZaguan(plan.tipo) };
      plan.cab = { x0: plan.ex - 0.95, x1: plan.ex + 0.95, z0: plan.zL0 - 2.05, z1: plan.zL0 };
      return plan;
    }
    function altoZaguan(tipo) { return tipo === 'concesionario' ? 5.2 : (tipo === 'hotel' ? 4.2 : 3.4); }
    function planVilla(plan) {
      var B = plan.B0, su = plan.suelo;
      plan.tipo = 'villa';
      plan.casa = { x0: Math.max(B.x0 + 0.3, plan.px - 8), x1: Math.min(B.x1 - 0.3, plan.px + 8), zI: B.z1 - 0.35, yb: su };   // 16 m de fachada como mucho
      var D = clamp(plan.casa.zI - (B.z0 + 0.3), 6.5, 11.5);
      plan.casa.z0 = plan.casa.zI - D;
      plan.alto = clamp(B.y1 - su - 0.6, 2.6, 3.0);
      return plan;
    }
    function planNave(plan) {
      var B = plan.B0, su = plan.suelo;
      plan.tipo = 'nave';
      var ancho = Math.min(B.sx - 1.2, 48), fondo = Math.min(B.sz - 1.2, 32);
      var cx = clamp(plan.px, B.x0 + 0.6 + ancho / 2, B.x1 - 0.6 - ancho / 2);
      plan.sala = { x0: cx - ancho / 2, x1: cx + ancho / 2, z0: plan.zf - 0.45 - fondo, z1: plan.zf - 0.45, yb: su, alto: clamp(B.y1 - su - 1.2, 3.2, 9) };
      return plan;
    }

    // ---- De quién es ------------------------------------------------------------------
    function corta(a) { a = String(a || ''); return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a; }
    function precio(v) { return (Number(v) / 1e8).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' RAMI'; }
    function quien(owner, handle) { return handle ? '@' + handle : corta(owner); }
    /**
     * El piso que toca: el ático si eres el dueño de la parcela; tu unidad si la
     * parcela está dividida (`unidades` > 0 y `units` = [{ n, owner, handle, sale }],
     * n desde 1; unidad n → planta válida ⌊(n − 1) / upp⌋, hueco (n − 1) mod upp);
     * si no, el piso de muestra que dicta la morfología del edificio.
     */
    function eligePiso(plan) {
      var po = plan.po, me = S.city && S.city.me, pc = po.pc, v = plan.plantas, upp = plan.upp, i;
      if (pc && me && pc.owner === me) return { clase: 'atico', planta: v[v.length - 1], slot: -1 };
      if (pc && me && (pc.unidades | 0) > 0 && pc.units && pc.units.length) {
        var mia = null;
        for (i = 0; i < pc.units.length; i++) { var u = pc.units[i]; if (u && u.owner === me && (!mia || (u.n | 0) < (mia.n | 0))) mia = u; }
        if (mia) { var idx = Math.max(0, (mia.n | 0) - 1); return { clase: 'unidad', planta: v[Math.min(Math.floor(idx / upp), v.length - 1)], slot: idx % upp, n: Math.max(1, mia.n | 0) }; }
      }
      var r = lcg(semillaEdificio(po, CANAL_MUESTRA));
      return { clase: 'muestra', planta: v[Math.min(v.length - 1, Math.floor(r() * v.length))], slot: Math.min(upp - 1, Math.floor(r() * upp)) };
    }
    /** Lo que el HUD dice del piso. */
    function titularPiso(plan, piso) {
      var po = plan.po, pc = po.pc, lineas = [], idxP = plan.plantas ? plan.plantas.indexOf(piso.planta) : -1;
      var num = idxP >= 0 && piso.slot >= 0 ? idxP * plan.upp + piso.slot + 1 : 0;
      if (piso.clase === 'atico') lineas.push(t('Tu ático') + ' · ' + t('planta') + ' ' + piso.planta);
      else if (piso.clase === 'unidad') lineas.push(t('Tu piso') + ' · ' + t('unidad') + ' ' + piso.n + ' · ' + t('planta') + ' ' + piso.planta);
      else lineas.push(t('Piso de muestra') + ' · ' + t('planta') + ' ' + piso.planta);
      if (pc) {
        var u = null, i;
        if ((pc.unidades | 0) > 0 && pc.units && num) for (i = 0; i < pc.units.length; i++) if (pc.units[i] && (pc.units[i].n | 0) === num) u = pc.units[i];
        if (piso.clase !== 'atico') lineas.push(u && u.owner ? t('Unidad') + ' ' + num + ' · ' + quien(u.owner, u.handle) : t('Edificio de') + ' ' + quien(pc.owner, pc.handle));
        else lineas.push(quien(pc.owner, pc.handle));
        if (u && u.sale) lineas.push(t('Unidad en venta') + ': ' + precio(u.sale));
        else if (pc.sale) lineas.push(t('Parcela en venta') + ': ' + precio(pc.sale));
      } else lineas.push(t('Barrio') + ': ' + (po.nombre || '—'));
      return lineas;
    }

    // =====================================================================================
    // 3. LA OBRA: paredes con huecos, suelos, techos, carpintería
    // =====================================================================================
    /**
     * Un espacio: lo que se dibuja y se pisa a la vez. `env` (envolvente: suelo,
     * techo, paredes) va en dos pasadas; `dec` (lo fijo) y los muebles, en la
     * segunda. `solidos`: rectángulos en planta que paran al jugador.
     */
    function nuevoEspacio(nombre, yb) {
      return { nombre: nombre, yb: yb, env: lote(), dec: lote(), solidos: [], lamparas: [], interact: [], muebles: [], mallas: [], grupo: new THREE.Group(), limites: null, ventana: null, salida: null, triangulos: 0 };
    }
    /**
     * Pared a lo largo de x (en z0..z1) o de z (en x0..x1), del suelo al techo, con
     * huecos { a, b, y0, y1, ventana }: a..b en el eje de la pared, y0..y1 sobre el
     * suelo. El antepecho de una ventana también para al jugador.
     */
    function pared(E, eje, a0, a1, b0, b1, alto, huecos, c, carp) {
      huecos = (huecos || []).slice().sort(function (p, q) { return p.a - q.a; });
      var yb = E.yb, cur = a0, i;
      function pieza(u0, u1, v0, v1, solida) {
        if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return;
        if (eje === 'x') caja(E.env, u0, yb + v0, b0, u1, yb + v1, b1, c);
        else caja(E.env, b0, yb + v0, u0, b1, yb + v1, u1, c);
        if (solida && v0 <= 0.01) E.solidos.push(eje === 'x' ? { x0: u0, x1: u1, z0: b0, z1: b1 } : { x0: b0, x1: b1, z0: u0, z1: u1 });
      }
      for (i = 0; i < huecos.length; i++) {
        var h = huecos[i], ha = Math.max(h.a, cur), hb = Math.min(h.b, a1);
        if (hb <= ha) continue;
        pieza(cur, ha, 0, alto, true);
        pieza(ha, hb, 0, h.y0, true);
        pieza(ha, hb, h.y1, alto, false);
        if (h.ventana && carp) ventana(E, eje, ha, hb, b0, b1, h.y0, h.y1, carp);
        else if (carp) marcoPuerta(E, eje, ha, hb, b0, b1, h.y1, carp);
        cur = hb;
      }
      pieza(cur, a1, 0, alto, true);
    }
    /** Carpintería de una ventana: cerco, montante central y vierteaguas interior. */
    function ventana(E, eje, a, b, b0, b1, y0, y1, c) {
      var yb = E.yb, g = 0.06, m = (a + b) / 2, e0 = b0 - 0.03, e1 = b1 + 0.03;
      function k(u0, u1, v0, v1, w0, w1, col) { if (eje === 'x') caja(E.dec, u0, yb + v0, w0, u1, yb + v1, w1, col); else caja(E.dec, w0, yb + v0, u0, w1, yb + v1, u1, col); }
      k(a, b, y0, y0 + g, e0, e1, c); k(a, b, y1 - g, y1, e0, e1, c);
      k(a, a + g, y0, y1, e0, e1, c); k(b - g, b, y0, y1, e0, e1, c);
      if (b - a > 1.1) k(m - g / 2, m + g / 2, y0, y1, (b0 + b1) / 2 - 0.03, (b0 + b1) / 2 + 0.03, c);
      k(a + (b - a) * 0.02, b - (b - a) * 0.02, (y1 - y0) * 0.5 + y0 - 0.02, (y1 - y0) * 0.5 + y0 + 0.02, (b0 + b1) / 2 - 0.02, (b0 + b1) / 2 + 0.02, c);
      if (eje === 'x') caja(E.dec, a - 0.05, yb + y0 - 0.04, b0 - 0.16, b + 0.05, yb + y0, b0, tono(c, 0.92));
    }
    function marcoPuerta(E, eje, a, b, b0, b1, y1, c) {
      var yb = E.yb, g = 0.07, e0 = b0 - 0.02, e1 = b1 + 0.02;
      function k(u0, u1, v0, v1) { if (eje === 'x') caja(E.dec, u0, yb + v0, e0, u1, yb + v1, e1, c); else caja(E.dec, e0, yb + v0, u0, e1, yb + v1, u1, c); }
      k(a, a + g, 0, y1); k(b - g, b, 0, y1); k(a, b, y1 - g, y1);
    }
    /** Suelo y techo de un rectángulo. */
    function losa(E, x0, z0, x1, z1, alto, cs, ct) {
      caja(E.env, x0, E.yb - 0.2, z0, x1, E.yb, z1, cs);
      caja(E.env, x0, E.yb + alto, z0, x1, E.yb + alto + 0.2, z1, ct);
    }
    /** Una lámpara de techo (pantalla que brilla) en el espacio. */
    function lamparaTecho(E, idx, x, z, alto, on, nombre, fija) {
      pon(E.dec, { g: 'cyl', a: 14, sx: 0.55, sy: 0.07, sz: 0.55, x: x, y: E.yb + alto - 0.08, z: z, c: PANTALLA_LUZ }, idx + 1);
      pon(E.dec, { g: 'cyl', a: 6, sx: 0.04, sy: 0.02, sz: 0.04, x: x, y: E.yb + alto - 0.02, z: z, c: ACERO });
      E.lamparas[idx] = { x: x, y: E.yb + alto - 0.35, z: z, on: !!on, col: [1, 0.78, 0.52], nombre: nombre, fija: !!fija, techo: true };
    }

    // =====================================================================================
    // 4. EL MOBILIARIO: el catálogo de muebles (marco del mueble: suelo en y = 0,
    //    frente hacia +z) y su sitio en el piso
    // =====================================================================================
    var MUEBLES = {
      sofa: function (c) {
        var b = tono(c, 0.82);
        return { sx: 2.2, sz: 0.9, alto: 0.92, p: [
          { sx: 2.2, sy: 0.4, sz: 0.9, y: 0.04, c: b }, { sx: 1.96, sy: 0.14, sz: 0.62, y: 0.44, z: 0.1, c: c },
          { sx: 2.2, sy: 0.5, sz: 0.22, y: 0.42, z: -0.34, c: c }, { sx: 0.2, sy: 0.24, sz: 0.9, x: -1.0, y: 0.44, c: b }, { sx: 0.2, sy: 0.24, sz: 0.9, x: 1.0, y: 0.44, c: b },
          { sx: 0.06, sy: 0.04, sz: 0.06, x: -1.0, z: 0.36, c: NEGRO }, { sx: 0.06, sy: 0.04, sz: 0.06, x: 1.0, z: 0.36, c: NEGRO }, { sx: 0.06, sy: 0.04, sz: 0.06, x: -1.0, z: -0.36, c: NEGRO }, { sx: 0.06, sy: 0.04, sz: 0.06, x: 1.0, z: -0.36, c: NEGRO }] };
      },
      mesa: function (c) {
        return { sx: 1.1, sz: 0.6, alto: 0.42, p: [{ sx: 1.1, sy: 0.05, sz: 0.6, y: 0.37, c: c },
          { sx: 0.05, sy: 0.37, sz: 0.05, x: -0.5, z: -0.25, c: tono(c, 0.8) }, { sx: 0.05, sy: 0.37, sz: 0.05, x: 0.5, z: -0.25, c: tono(c, 0.8) },
          { sx: 0.05, sy: 0.37, sz: 0.05, x: -0.5, z: 0.25, c: tono(c, 0.8) }, { sx: 0.05, sy: 0.37, sz: 0.05, x: 0.5, z: 0.25, c: tono(c, 0.8) },
          { sx: 0.28, sy: 0.03, sz: 0.2, x: 0.2, y: 0.42, c: [0.85, 0.3, 0.25] }] };
      },
      alfombra: function (c) { return { sx: 2.6, sz: 1.8, alto: 0.02, pasa: true, p: [{ sx: 2.6, sy: 0.015, sz: 1.8, c: c }, { sx: 2.2, sy: 0.017, sz: 1.4, c: tono(c, 0.78) }] }; },
      tele: function (c) {
        return { sx: 1.8, sz: 0.42, alto: 1.45, p: [{ sx: 1.8, sy: 0.46, sz: 0.42, y: 0.04, c: c }, { sx: 1.7, sy: 0.02, sz: 0.4, y: 0.5, c: tono(c, 0.8) },
          { sx: 0.3, sy: 0.12, sz: 0.2, y: 0.5, z: -0.08, c: NEGRO }, { sx: 1.4, sy: 0.8, sz: 0.05, y: 0.62, z: -0.08, c: PANTALLA }] };
      },
      estanteria: function (c, r) {
        var p = [{ sx: 0.04, sy: 2.0, sz: 0.34, x: -0.58, c: c }, { sx: 0.04, sy: 2.0, sz: 0.34, x: 0.58, c: c }, { sx: 1.2, sy: 2.0, sz: 0.02, z: -0.16, c: tono(c, 0.85) }], k, x;
        for (k = 0; k < 5; k++) p.push({ sx: 1.16, sy: 0.03, sz: 0.34, y: 0.02 + k * 0.48, c: c });
        for (k = 0; k < 4; k++) for (x = -0.52; x < 0.5;) {
          var w = 0.04 + 0.05 * r(), h = 0.2 + 0.12 * r();
          if (r() < 0.82) p.push({ sx: w, sy: h, sz: 0.24, x: x + w / 2, y: 0.05 + k * 0.48, c: elige(PAL.libro, r()) });
          x += w + 0.006;
        }
        return { sx: 1.2, sz: 0.36, alto: 2.0, p: p };
      },
      planta: function (c, r) {
        var s = 0.8 + 0.5 * r();
        return { sx: 0.5, sz: 0.5, alto: 1.3 * s, p: [{ g: 'cyl', a: 10, sx: 0.38, sy: 0.36, sz: 0.38, c: TERRACOTA },
          { g: 'ball', sx: 0.62 * s, sy: 0.8 * s, sz: 0.62 * s, y: 0.36 + 0.42 * s, c: HOJA }, { g: 'ball', sx: 0.42 * s, sy: 0.5 * s, sz: 0.42 * s, x: 0.12, y: 0.4 + 0.8 * s, c: tono(HOJA, 1.2) }] };
      },
      pie: function () {
        return { sx: 0.4, sz: 0.4, alto: 1.6, luz: { x: 0, y: 1.45, z: 0 }, p: [{ g: 'cyl', a: 12, sx: 0.32, sy: 0.03, sz: 0.32, c: NEGRO },
          { g: 'cyl', a: 6, sx: 0.03, sy: 1.34, sz: 0.03, y: 0.03, c: NEGRO }, { g: 'tcyl', a: 16, sx: 0.44, sy: 0.3, sz: 0.44, y: 1.3, c: PANTALLA_LUZ, lamp: true }] };
      },
      cama: function (c, r, madera) {
        return { sx: 1.7, sz: 2.12, alto: 1.1, p: [{ sx: 1.64, sy: 0.3, sz: 2.05, y: 0.08, c: madera }, { sx: 1.56, sy: 0.2, sz: 1.96, y: 0.38, c: BLANCO },
          { sx: 1.6, sy: 0.08, sz: 1.36, y: 0.56, z: 0.3, c: c }, { sx: 0.6, sy: 0.12, sz: 0.34, x: -0.38, y: 0.58, z: -0.72, c: BLANCO }, { sx: 0.6, sy: 0.12, sz: 0.34, x: 0.38, y: 0.58, z: -0.72, c: BLANCO },
          { sx: 1.7, sy: 1.0, sz: 0.08, y: 0.08, z: -1.04, c: tono(madera, 0.9) }] };
      },
      mesilla: function (c) {
        return { sx: 0.46, sz: 0.4, alto: 0.9, luz: { x: 0, y: 0.78, z: 0 }, p: [{ sx: 0.46, sy: 0.48, sz: 0.4, c: c }, { sx: 0.4, sy: 0.02, sz: 0.01, y: 0.3, z: 0.2, c: tono(c, 0.6) },
          { g: 'cyl', a: 10, sx: 0.12, sy: 0.2, sz: 0.12, y: 0.48, c: ACERO }, { g: 'tcyl', a: 14, sx: 0.28, sy: 0.2, sz: 0.28, y: 0.66, c: PANTALLA_LUZ, lamp: true }] };
      },
      armario: function (c) {
        return { sx: 1.8, sz: 0.6, alto: 2.2, p: [{ sx: 1.8, sy: 2.2, sz: 0.6, c: c }, { sx: 0.02, sy: 2.1, sz: 0.01, y: 0.05, z: 0.3, c: tono(c, 0.6) },
          { sx: 0.03, sy: 0.3, sz: 0.03, x: -0.08, y: 1.0, z: 0.31, c: ACERO }, { sx: 0.03, sy: 0.3, sz: 0.03, x: 0.08, y: 1.0, z: 0.31, c: ACERO }] };
      }
    };
    /** Vuelca un mueble (tipo, color, sorteo) con su giro r (cuartos de vuelta) en (x, z). */
    function piezasMueble(mu) {
      if (!mu.forma) mu.forma = MUEBLES[mu.tipo](mu.c, lcg(mu.semilla), mu.c2);
      return mu.forma;
    }
    function huellaMueble(mu) {
      var f = piezasMueble(mu), impar = mu.r % 2 === 1, hx = (impar ? f.sz : f.sx) / 2, hz = (impar ? f.sx : f.sz) / 2;
      return { x0: mu.x - hx, x1: mu.x + hx, z0: mu.z - hz, z1: mu.z + hz };
    }
    function volcarMueble(a, mu, yb, lampIdx) {
      var f = piezasMueble(mu), i;
      _m4.compose(_v.set(mu.x, yb, mu.z), _q.setFromEuler(_e.set(0, mu.r * Math.PI / 2, 0)), _s.set(1, 1, 1));
      for (i = 0; i < f.p.length; i++) pon(a, f.p[i], f.p[i].lamp && lampIdx >= 0 ? lampIdx + 1 : 0, 0, _m4);
    }
    function luzMueble(mu, yb) {
      var f = piezasMueble(mu), a = mu.r * Math.PI / 2, lx = f.luz.x * Math.cos(a) + f.luz.z * Math.sin(a), lz = -f.luz.x * Math.sin(a) + f.luz.z * Math.cos(a);
      return { x: mu.x + lx, y: yb + f.luz.y, z: mu.z + lz };
    }
    /** Mete el mueble en su habitación (el giro cambia la huella). */
    function encaja(mu) {
      var h = huellaMueble(mu), R = mu.cuarto, hx = (h.x1 - h.x0) / 2, hz = (h.z1 - h.z0) / 2;
      mu.x = clamp(mu.x, R.x0 + hx + 0.02, Math.max(R.x0 + hx + 0.02, R.x1 - hx - 0.02));
      mu.z = clamp(mu.z, R.z0 + hz + 0.02, Math.max(R.z0 + hz + 0.02, R.z1 - hz - 0.02));
    }

    // =====================================================================================
    // 5. LOS ESPACIOS: zaguán, cabina, rellano y piso, villa y nave
    // =====================================================================================
    /** La paleta de un edificio (zaguán) y de un piso: sale de la semilla, en orden fijo. */
    function paletaPiso(r) {
      return { pared: elige(PAL.pared, r()), suelo: elige(PAL.madera, r()), sofa: elige(PAL.sofa, r()), alfombra: elige(PAL.alfombra, r()),
        mueble: elige(PAL.mueble, r()), azulejo: elige(PAL.azulejo, r()), carp: elige(PAL.carpinteria, r()), funda: elige(PAL.funda, r()), techo: [0.96, 0.95, 0.93] };
    }
    /**
     * El piso: salón y dormitorio a la fachada (con ventanas), cocina, recibidor y
     * baño detrás. La proporción, el lado del salón y los colores salen de `r`.
     * `x0..x1` × `z0..zI` (zI = cara interior del muro de fachada, que va de zI a
     * zI + 0,3); `entrada`: { lado: 'atras'|'frente', x } (en 'frente' la puerta
     * cae en el salón); `atras0..atras1`: hasta dónde llega la pared de atrás (el
     * rellano comparte esa pared).
     */
    function construyePiso(E, x0, x1, z0, zI, alto, entrada, r, atras0, atras1, pal) {
      var W = x1 - x0, D = zI - z0, s = 0.56 + 0.1 * r(), espejo = r() < 0.5, df = 0.56 + 0.08 * r();
      var nPlantas = 1 + Math.floor(r() * 3), camaIzq = r() < 0.5, dosVent = r() < 0.7;
      if (entrada.lado === 'frente') {                                                       // la puerta de la calle cae en el salón
        var enIzq = entrada.x < x0 + s * W - 0.8;
        espejo = !enIzq;
      }
      function X(u) { return espejo ? x0 + x1 - u : u; }
      function R(u0, u1, zz0, zz1) { var a = X(u0), b = X(u1); return { x0: Math.min(a, b), x1: Math.max(a, b), z0: zz0, z1: zz1 }; }
      var ua = x0 + s * W, zm = zI - df * D, uk = x0 + (ua - x0) * 0.52;
      var sal = R(x0, ua, zm, zI), dor = R(ua, x1, zm, zI), coc = R(x0, uk, z0, zm), rec = R(uk, ua, z0, zm), ban = R(ua, x1, z0, zm);
      E.cuartos = { salon: sal, dormitorio: dor, cocina: coc, recibidor: rec, bano: ban };
      var cp = pal.pared, cs = pal.suelo, ct = pal.techo, carp = pal.carp;
      // Suelos (madera; azulejo en baño y cocina) y techos.
      losa(E, Math.min(sal.x0, dor.x0), zm, Math.max(sal.x1, dor.x1), zI, alto, cs, ct);
      losa(E, rec.x0, z0, rec.x1, zm, alto, cs, ct);
      losa(E, coc.x0, z0, coc.x1, zm, alto, tono(pal.azulejo, 0.92), ct);
      losa(E, ban.x0, z0, ban.x1, zm, alto, pal.azulejo, ct);
      // Muro de fachada con ventanas: dos (o una) en el salón, una en el dormitorio.
      var hv = [], i, anchoS = sal.x1 - sal.x0, anchoD = dor.x1 - dor.x0;
      var nv = dosVent && anchoS > 4.6 ? 2 : 1, wv = Math.min(2.4, (anchoS - 1) / nv - 0.5);
      for (i = 0; i < nv; i++) { var cx = sal.x0 + anchoS * (i + 0.5) / nv; hv.push({ a: cx - wv / 2, b: cx + wv / 2, y0: 0.45, y1: 2.45, ventana: true, cuarto: 'salon' }); }
      var wd = Math.min(1.8, anchoD - 1.2);
      if (wd > 0.6) hv.push({ a: (dor.x0 + dor.x1) / 2 - wd / 2, b: (dor.x0 + dor.x1) / 2 + wd / 2, y0: 0.85, y1: 2.3, ventana: true, cuarto: 'dormitorio' });
      if (entrada.lado === 'frente') {                                                       // la puerta de la calle, sin ventana encima
        var pa = entrada.x - entrada.ancho / 2, pb = entrada.x + entrada.ancho / 2;
        hv = hv.filter(function (h) { return h.b < pa - 0.3 || h.a > pb + 0.3; });
        hv.push({ a: pa, b: pb, y0: 0, y1: 2.3 });
      }
      pared(E, 'x', x0 - 0.3, x1 + 0.3, zI, zI + 0.3, alto, hv, cp, carp);
      E.ventanas = hv.filter(function (h) { return h.ventana; });
      // Laterales y muro de atrás (con la puerta del rellano).
      pared(E, 'z', z0 - 0.15, zI, x0 - 0.3, x0, alto, [], cp);
      pared(E, 'z', z0 - 0.15, zI, x1, x1 + 0.3, alto, [], cp);
      var puertaX = (rec.x0 + rec.x1) / 2, hAtras = [];
      if (entrada.lado === 'atras') { puertaX = clamp(entrada.x, rec.x0 + 0.6, rec.x1 - 0.6); hAtras.push({ a: puertaX - 0.5, b: puertaX + 0.5, y0: 0, y1: 2.15 }); }
      pared(E, 'x', Math.min(x0 - 0.3, atras0 === undefined ? x0 : atras0), Math.max(x1 + 0.3, atras1 === undefined ? x1 : atras1), z0 - 0.15, z0, alto, hAtras, cp, carp);
      E.puertaPiso = { x: puertaX, z: z0 };
      // Tabiques: salón | dormitorio con la puerta atrás; dormitorio | baño con la
      // puerta del baño; recibidor | baño ciego. La cocina queda abierta.
      var xa = X(ua), tp = 0.06;
      pared(E, 'z', zm, zI, xa - tp, xa + tp, alto, [{ a: zm + 0.2, b: zm + 1.1, y0: 0, y1: 2.1 }], cp, carp);
      pared(E, 'z', z0, zm, xa - tp, xa + tp, alto, [], cp);
      var bp = espejo ? { a: ban.x1 - 1.3, b: ban.x1 - 0.4 } : { a: ban.x0 + 0.4, b: ban.x0 + 1.3 };
      pared(E, 'x', ban.x0, ban.x1, zm - tp, zm + tp, alto, [{ a: bp.a, b: bp.b, y0: 0, y1: 2.1 }], pal.azulejo, carp);
      // Zócalo claro bajo las ventanas del salón (detalle) y lámparas de techo.
      lamparaTecho(E, 1, (sal.x0 + sal.x1) / 2, (sal.z0 + sal.z1) / 2, alto, false, 'salón');
      lamparaTecho(E, 2, (coc.x0 + coc.x1) / 2, (coc.z0 + coc.z1) / 2, alto, false, 'cocina');
      lamparaTecho(E, 4, (ban.x0 + ban.x1) / 2, (ban.z0 + ban.z1) / 2, alto, false, 'baño');
      lamparaTecho(E, 5, (dor.x0 + dor.x1) / 2, (dor.z0 + dor.z1) / 2 + 0.4, alto, false, 'dormitorio');
      // Cocina fija: nevera y encimera contra la pared de atrás, con muebles altos.
      var dirK = espejo ? -1 : 1, kx0 = espejo ? coc.x1 : coc.x0, kL = Math.max(1.2, coc.x1 - coc.x0 - 0.9);
      var nev = kx0 + dirK * 0.4;
      caja(E.dec, nev - 0.35, E.yb, z0 + 0.05, nev + 0.35, E.yb + 1.9, z0 + 0.73, [0.86, 0.87, 0.88]);
      caja(E.dec, nev + dirK * 0.28 - 0.015, E.yb + 1.0, z0 + 0.73, nev + dirK * 0.28 + 0.015, E.yb + 1.5, z0 + 0.77, ACERO);
      var e0 = kx0 + dirK * 0.8, e1 = e0 + dirK * kL, ea = Math.min(e0, e1), eb = Math.max(e0, e1);
      caja(E.dec, ea, E.yb, z0 + 0.02, eb, E.yb + 0.86, z0 + 0.62, pal.mueble);
      caja(E.dec, ea - 0.01, E.yb + 0.86, z0, eb + 0.01, E.yb + 0.9, z0 + 0.64, tono(PAL.marmol ? hex(PAL.marmol[1]) : BLANCO, 0.95));
      caja(E.dec, ea + 0.3, E.yb + 0.9, z0 + 0.12, ea + 0.9, E.yb + 0.905, z0 + 0.55, NEGRO);                       // placa
      caja(E.dec, eb - 0.8, E.yb + 0.9, z0 + 0.15, eb - 0.3, E.yb + 0.91, z0 + 0.5, ACERO);                         // fregadero
      caja(E.dec, ea, E.yb + 1.5, z0 + 0.02, eb, E.yb + 2.2, z0 + 0.36, tono(pal.mueble, 1.08));
      E.solidos.push({ x0: Math.min(nev - 0.35, ea), x1: Math.max(nev + 0.35, eb), z0: z0, z1: z0 + 0.74 });
      // Baño fijo: lavabo con espejo, inodoro y ducha.
      var bx0 = espejo ? ban.x1 : ban.x0, dirB = espejo ? -1 : 1, bl = bx0 + dirB * 1.9, bi = bx0 + dirB * 2.8;
      var lavX = clamp(bl, ban.x0 + 0.45, ban.x1 - 0.45), inoX = clamp(bi, ban.x0 + 0.3, ban.x1 - 0.3);
      caja(E.dec, lavX - 0.4, E.yb, z0, lavX + 0.4, E.yb + 0.8, z0 + 0.48, BLANCO);
      caja(E.dec, lavX - 0.3, E.yb + 0.8, z0 + 0.06, lavX + 0.3, E.yb + 0.86, z0 + 0.42, [0.97, 0.97, 0.97]);
      caja(E.dec, lavX - 0.35, E.yb + 1.05, z0 + 0.005, lavX + 0.35, E.yb + 1.85, z0 + 0.025, [0.72, 0.8, 0.84]);  // espejo
      pon(E.dec, { g: 'cyl', a: 12, sx: 0.4, sy: 0.4, sz: 0.55, x: inoX, y: E.yb, z: z0 + 0.45, c: BLANCO });
      caja(E.dec, inoX - 0.2, E.yb + 0.35, z0, inoX + 0.2, E.yb + 0.8, z0 + 0.18, BLANCO);
      var dx0 = espejo ? ban.x0 : ban.x1 - 0.95, dz1 = z0 + 0.95;
      caja(E.dec, dx0, E.yb, z0, dx0 + 0.95, E.yb + 0.06, dz1, [0.95, 0.95, 0.96]);
      caja(E.dec, espejo ? dx0 + 0.93 : dx0, E.yb, z0, espejo ? dx0 + 0.95 : dx0 + 0.02, E.yb + 1.95, dz1, [0.72, 0.84, 0.9]);
      E.solidos.push({ x0: Math.min(lavX - 0.4, inoX - 0.25, dx0), x1: Math.max(lavX + 0.4, inoX + 0.25, dx0 + 0.95), z0: z0, z1: z0 + 0.6 });
      // Los muebles que se mueven, en su sitio de partida.
      var cS = (sal.z0 + sal.z1) / 2, lado = espejo ? -1 : 1;
      var sofaX = espejo ? sal.x1 - 0.5 : sal.x0 + 0.5, teleX = espejo ? sal.x0 + 0.24 : sal.x1 - 0.24;
      var ms = E.muebles;
      function mueble(id, tipo, cuarto, x, z, rr, c, c2) { var mu = { id: id, tipo: tipo, cuarto: cuarto, x: x, z: z, r: ((rr % 4) + 4) % 4, c: c, c2: c2, semilla: (r() * 4294967296) >>> 0 }; encaja(mu); mu.x0 = mu.x; mu.z0 = mu.z; mu.r0 = mu.r; ms.push(mu); return mu; }
      mueble('alfombra', 'alfombra', sal, (sofaX + teleX) / 2, cS, 1, pal.alfombra);
      mueble('sofa', 'sofa', sal, sofaX, cS, lado > 0 ? 1 : 3, pal.sofa);
      mueble('mesa', 'mesa', sal, (sofaX + teleX) / 2 - lado * 0.1, cS, 1, pal.mueble);
      mueble('tele', 'tele', sal, teleX, cS, lado > 0 ? 3 : 1, pal.mueble);
      mueble('estanteria', 'estanteria', sal, espejo ? sal.x1 - 0.2 : sal.x0 + 0.2, sal.z1 - 0.75, lado > 0 ? 1 : 3, pal.mueble);
      var pie = mueble('pie', 'pie', sal, espejo ? sal.x1 - 0.35 : sal.x0 + 0.35, sal.z0 + 0.45, 0, NEGRO);
      pie.lampara = 0;
      for (i = 0; i < nPlantas; i++) {
        var pxp = [teleX - lado * 0.1, (sal.x0 + sal.x1) / 2 + lado * (0.6 + i * 0.3), teleX][i];
        var pzp = [sal.z1 - 0.4, sal.z1 - 0.4, sal.z0 + 0.4][i];
        mueble('planta' + i, 'planta', sal, pxp, pzp, i, HOJA);
      }
      var camaX = camaIzq ? dor.x0 + 1.1 : dor.x1 - 1.1, cD = (dor.z0 + dor.z1) / 2 + 0.2;
      mueble('cama', 'cama', dor, camaX, cD, camaIzq ? 1 : 3, pal.funda, pal.suelo);
      var mes = mueble('mesilla', 'mesilla', dor, camaIzq ? dor.x0 + 0.26 : dor.x1 - 0.26, cD + 1.3, camaIzq ? 1 : 3, pal.mueble);
      mes.lampara = 3;
      mueble('armario', 'armario', dor, camaIzq ? dor.x1 - 0.35 : dor.x0 + 0.35, (dor.z0 + dor.z1) / 2 + 0.6, camaIzq ? 3 : 1, pal.mueble);
      E.lamparas[0] = { on: false, col: [1, 0.74, 0.46], nombre: 'pie', mueble: pie };
      E.lamparas[3] = { on: false, col: [1, 0.72, 0.44], nombre: 'mesilla', mueble: mes };
      E.limites = { x0: x0, x1: x1, z0: z0, z1: zI };
      E.ventana = { z: zI + 0.3, k: 1 };
      E.salon = sal;
      return E;
    }

    /** Los buzones: una textura con los números, hecha en un lienzo. */
    function texturaBuzones(n, cols) {
      var filas = Math.ceil(n / cols), cw = 64, chh = 48, cv = document.createElement('canvas');
      cv.width = cols * cw; cv.height = filas * chh;
      var g = cv.getContext('2d'), i;
      g.fillStyle = '#8f949b'; g.fillRect(0, 0, cv.width, cv.height);
      g.font = 'bold 18px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (i = 0; i < n; i++) {
        var cx = (i % cols) * cw, cy = Math.floor(i / cols) * chh;
        g.fillStyle = '#b7bcc3'; g.fillRect(cx + 3, cy + 3, cw - 6, chh - 6);
        g.fillStyle = '#2b2f36'; g.fillRect(cx + 12, cy + 9, cw - 24, 5);
        g.fillStyle = '#1b1e23'; g.fillText(String(i + 1), cx + cw / 2, cy + chh * 0.62);
      }
      var tx = new THREE.CanvasTexture(cv);
      tx.encoding = THREE.sRGBEncoding; tx.anisotropy = 4;
      return { tx: tx, filas: filas };
    }

    /** El zaguán: suelo de piedra, buzones numerados, escalera, puerta del ascensor, luz. Hotel: recepción. Concesionario: sala de exposición. */
    function construyeZaguan(casa) {
      var plan = casa.plan, Z = plan.zaguan, E = nuevoEspacio('bajo', Z.yb), r = lcg(semillaEdificio(plan.po, CANAL_PISO, 7));
      var cp = elige(PAL.pared, r()), cs = elige(PAL.marmol, r()), carp = elige(PAL.carpinteria, r()), alto = Z.alto, px = plan.px, ex = plan.ex;
      if (plan.tipo === 'concesionario') { cp = [0.93, 0.94, 0.95]; cs = [0.82, 0.83, 0.85]; }
      losa(E, Z.x0, Z.z0, Z.x1, Z.z1, alto, cs, [0.95, 0.95, 0.94]);
      // Fachada: la puerta de la calle y, a los lados, la vidriera del portal.
      var hueco = plan.hueco, hf = [{ a: px - hueco / 2, b: px + hueco / 2, y0: 0, y1: Math.min(2.9, alto - 0.3) }];
      var vid = Math.max(4, Math.min(plan.dw + 6, 14)) / 2;
      if (vid > hueco / 2 + 1) { hf.push({ a: px - vid + 0.2, b: px - hueco / 2 - 0.3, y0: 0.3, y1: Math.min(3.9, alto - 0.2), ventana: true }); hf.push({ a: px + hueco / 2 + 0.3, b: px + vid - 0.2, y0: 0.3, y1: Math.min(3.9, alto - 0.2), ventana: true }); }
      if (plan.tipo === 'concesionario') hf = [{ a: px - hueco / 2, b: px + hueco / 2, y0: 0, y1: 3.0 }, { a: Math.max(Z.x0 + 0.4, px - 6.8), b: px - hueco / 2 - 0.3, y0: 0.2, y1: 4.2, ventana: true }, { a: px + hueco / 2 + 0.3, b: Math.min(Z.x1 - 0.4, px + 6.8), y0: 0.2, y1: 4.2, ventana: true }];
      pared(E, 'x', Z.x0 - 0.2, Z.x1 + 0.2, Z.z1, Z.z1 + 0.2, alto, hf, cp, carp);
      E.salida = { x: px, ancho: hueco, z: Z.z1 };
      pared(E, 'z', Z.z0 - 0.2, Z.z1 + 0.2, Z.x0 - 0.2, Z.x0, alto, [], cp);
      pared(E, 'z', Z.z0 - 0.2, Z.z1 + 0.2, Z.x1, Z.x1 + 0.2, alto, [], cp);
      pared(E, 'x', Z.x0 - 0.2, Z.x1 + 0.2, Z.z0 - 0.2, Z.z0, alto, [{ a: ex - 0.55, b: ex + 0.55, y0: 0, y1: 2.2 }], cp);
      marcoAscensor(E, plan);
      // Luz: tres plafones encendidos (se apagan y se encienden como las demás).
      var lz = (Z.z0 + Z.z1) / 2, nl = plan.tipo === 'concesionario' ? 3 : 2;
      for (var i = 0; i < nl; i++) lamparaTecho(E, i, Z.x0 + (Z.x1 - Z.x0) * (i + 0.5) / nl, lz, alto, true, 'techo');
      lamparaTecho(E, 2 + (nl === 3 ? 1 : 0), ex, Z.z0 + 1.4, alto, true, 'ascensor');
      var ladoEsc = (ex - Z.x0) > (Z.x1 - ex) ? -1 : 1;                                          // la escalera, en el lado contrario al ascensor
      if (plan.tipo === 'torre') {
        escalera(E, ladoEsc > 0 ? Z.x1 - 1.35 : Z.x0 + 0.15, Z.z0 + 0.3, alto, cp, r);
        buzones(E, ladoEsc > 0 ? Z.x0 : Z.x1, (Z.z0 + Z.z1) / 2 + 0.6, ladoEsc > 0 ? 1 : -1, plan);
        pon(E.dec, { g: 'cyl', a: 10, sx: 0.44, sy: 0.4, sz: 0.44, x: px + ladoEsc * (hueco / 2 + 0.8), y: E.yb, z: Z.z1 - 0.6, c: TERRACOTA });
        pon(E.dec, { g: 'ball', sx: 0.8, sy: 1.0, sz: 0.8, x: px + ladoEsc * (hueco / 2 + 0.8), y: E.yb + 0.85, z: Z.z1 - 0.6, c: HOJA });
        caja(E.dec, px - 1.2, E.yb, Z.z1 - 3.6, px + 1.2, E.yb + 0.012, Z.z1 - 0.6, elige(PAL.alfombra, r()));
      } else if (plan.tipo === 'hotel') recepcion(E, plan, r, ladoEsc);
      else exposicion(E, plan, r);
      E.limites = { x0: Z.x0, x1: Z.x1, z0: Z.z0, z1: Z.z1 };
      E.ventana = { z: Z.z1 + 0.2, k: plan.tipo === 'concesionario' ? 0.9 : 0.55 };
      E.interact.push({ tipo: 'salida', x: px, y: E.yb + 1.3, z: Z.z1 + 0.1, caja: { x0: px - hueco / 2, x1: px + hueco / 2, y0: E.yb, y1: E.yb + 2.6, z0: Z.z1 - 0.1, z1: Z.z1 + 0.4 } });
      E.interact.push({ tipo: 'ascensor', x: ex, y: E.yb + 1.3, z: Z.z0, caja: { x0: ex - 0.8, x1: ex + 0.8, y0: E.yb, y1: E.yb + 2.4, z0: Z.z0 - 0.3, z1: Z.z0 + 0.3 } });
      return E;
    }
    /** El cerco de acero del ascensor y la botonera, en la pared de atrás del espacio (z = zL0). */
    function marcoAscensor(E, plan) {
      var ex = plan.ex, z = plan.zL0;
      caja(E.dec, ex - 0.68, E.yb, z, ex - 0.55, E.yb + 2.32, z + 0.06, ACERO);
      caja(E.dec, ex + 0.55, E.yb, z, ex + 0.68, E.yb + 2.32, z + 0.06, ACERO);
      caja(E.dec, ex - 0.68, E.yb + 2.2, z, ex + 0.68, E.yb + 2.34, z + 0.06, ACERO);
      caja(E.dec, ex + 0.85, E.yb + 1.05, z, ex + 0.99, E.yb + 1.35, z + 0.03, ACERO);
      pon(E.dec, { g: 'cyl', a: 10, sx: 0.05, sy: 0.02, sz: 0.05, x: ex + 0.92, y: E.yb + 1.2, z: z + 0.03, rx: Math.PI / 2, c: [1, 0.8, 0.4] }, 0);
    }
    function escalera(E, x0, z0, alto, c, r) {
      var n = Math.round(alto / 0.18), paso = 0.28, huella = 1.2, i, cc = tono(c, 0.9);
      for (i = 0; i < n; i++) caja(E.dec, x0, E.yb, z0 + (n - 1 - i) * paso, x0 + huella, E.yb + (i + 1) * (alto / n), z0 + (n - i) * paso, i % 2 ? cc : tono(cc, 0.96));
      var z1 = z0 + n * paso;
      // El pasamanos: una barra inclinada con la escalera (sube hacia −z) y dos postes.
      var largo = n * paso, inc = Math.atan2(alto, largo), xr = x0 + huella - 0.03;
      pon(E.dec, { g: 'slab', sx: 0.05, sy: 0.05, sz: Math.sqrt(largo * largo + alto * alto), x: xr, y: E.yb + 0.9 + alto / 2, z: z0 + largo / 2, rx: inc, c: [0.3, 0.3, 0.32] });
      caja(E.dec, xr - 0.025, E.yb, z1 - 0.3, xr + 0.025, E.yb + 0.9 + alto / n, z1 - 0.25, [0.3, 0.3, 0.32]);
      E.solidos.push({ x0: x0, x1: x0 + huella, z0: z0, z1: z1 });
    }
    function buzones(E, xPared, zc, haciaDentro, plan) {
      var n = clamp(plan.plantas.length * plan.upp, 4, 48), cols = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(n * 1.6))));
      var tb = texturaBuzones(n, cols), w = cols * 0.34, h = tb.filas * 0.26, x = xPared + haciaDentro * 0.02;
      caja(E.dec, Math.min(x, x + haciaDentro * 0.3), E.yb + 1.55 - h / 2 - 0.03, zc - w / 2 - 0.03, Math.max(x, x + haciaDentro * 0.3), E.yb + 1.55 + h / 2 + 0.03, zc + w / 2 + 0.03, [0.55, 0.57, 0.6]);
      var g = new THREE.PlaneGeometry(w, h);
      g.rotateY(haciaDentro > 0 ? Math.PI / 2 : -Math.PI / 2);
      g.translate(x + haciaDentro * 0.305, E.yb + 1.55, zc);
      var m = material({ color: false, mapa: tb.tx });
      E.extra = { g: g, m: m, tx: tb.tx };
      E.buzones = { x: x + haciaDentro * 0.3, z: zc, n: n, dentro: haciaDentro };
    }
    function recepcion(E, plan, r, lado) {
      var Z = plan.zaguan, px = plan.px, zc = Z.z0 + 3.2, mx = lado > 0 ? Z.x1 - 3.4 : Z.x0 + 3.4, madera = elige(PAL.madera, r());
      caja(E.dec, mx - 2.2, E.yb, zc - 0.5, mx + 2.2, E.yb + 1.05, zc + 0.5, madera);                              // el mostrador
      caja(E.dec, mx - 2.3, E.yb + 1.05, zc - 0.58, mx + 2.3, E.yb + 1.11, zc + 0.58, hex(PAL.marmol[0]));
      pon(E.dec, { g: 'hemi', sx: 0.14, sy: 0.08, sz: 0.14, x: mx + 1.2, y: E.yb + 1.11, z: zc + 0.3, c: [0.86, 0.7, 0.36] });   // el timbre
      caja(E.dec, mx - 0.4, E.yb + 1.11, zc - 0.2, mx + 0.1, E.yb + 1.14, zc + 0.15, BLANCO);                      // el libro de registro
      var i, j;
      for (i = 0; i < 6; i++) for (j = 0; j < 3; j++) caja(E.dec, mx - 1.2 + i * 0.4, E.yb + 1.4 + j * 0.3, Z.z0, mx - 0.96 + i * 0.4, E.yb + 1.6 + j * 0.3, Z.z0 + 0.06, [0.86, 0.7, 0.36]);   // el casillero de llaves
      E.solidos.push({ x0: mx - 2.3, x1: mx + 2.3, z0: zc - 0.6, z1: zc + 0.6 });
      var sx = lado > 0 ? Z.x0 + 1.4 : Z.x1 - 1.4, sz = (Z.z0 + Z.z1) / 2 + 1.5;
      var sofa = { tipo: 'sofa', c: elige(PAL.sofa, r()), x: sx, z: sz, r: lado > 0 ? 1 : 3, semilla: 1 }, mesa = { tipo: 'mesa', c: madera, x: sx + lado * 1.3, z: sz, r: 1, semilla: 2 };
      volcarMueble(E.dec, sofa, E.yb, -1); volcarMueble(E.dec, mesa, E.yb, -1);
      E.solidos.push(huellaMueble(sofa)); E.solidos.push(huellaMueble(mesa));
      caja(E.dec, px - 1.6, E.yb, Z.z1 - 6, px + 1.6, E.yb + 0.012, Z.z1 - 0.6, [0.55, 0.12, 0.12]);                  // la alfombra roja
      E.letrero = t('Recepción');
    }
    /** La sala de exposición: un coche por activo coche de la parcela (o los que dicte la morfología). */
    function exposicion(E, plan, r) {
      var Z = plan.zaguan, po = plan.po, coches = [], i, as = (S.city && S.city.assets) || [];
      for (i = 0; i < as.length; i++) if ((as[i].kind | 0) === 2 && (as[i].x | 0) === po.cx && (as[i].y | 0) === po.cy) coches.push(i);
      var sinActivos = !coches.length, n = sinActivos ? 3 + Math.floor(real01(semillaEdificio(po, CANAL_EXPO)) * 4) : Math.min(coches.length, 12);
      var geo = G.carGeometry(), pa = geo.attributes.position.array, na = geo.attributes.normal.array, ca = geo.attributes.color.array, col = new THREE.Color();
      var filas = 2, porFila = Math.ceil(n / filas), ancho = Z.x1 - Z.x0 - 4, k, j;
      for (k = 0; k < n; k++) {
        var fila = Math.floor(k / porFila), enFila = k % porFila, nf = Math.min(porFila, n - fila * porFila);
        var cx = (Z.x0 + Z.x1) / 2 + (enFila - (nf - 1) / 2) * Math.min(6.2, ancho / Math.max(nf, 1)), cz = Z.z0 + 5 + fila * 6.5;
        if (sinActivos) col.setHSL(real01(semillaEdificio(po, CANAL_EXPO, k + 1)), 0.65, 0.5); else col.setHSL(UT.hash2(coches[k], 23), 0.65, 0.5);
        var giro = 0.5 + (k % 2) * 0.25, cg = Math.cos(giro), sg = Math.sin(giro);
        for (j = 0; j < pa.length; j += 3) {
          var x = pa[j] * cg + pa[j + 2] * sg, z = -pa[j] * sg + pa[j + 2] * cg;
          E.dec.pos.push(cx + x, E.yb + 0.3 + pa[j + 1], cz + z);
          E.dec.nor.push(na[j] * cg + na[j + 2] * sg, na[j + 1], -na[j] * sg + na[j + 2] * cg);
          var blanco = ca[j] > 0.99 && ca[j + 1] > 0.99 && ca[j + 2] > 0.99;
          E.dec.col.push(blanco ? col.r : ca[j], blanco ? col.g : ca[j + 1], blanco ? col.b : ca[j + 2]);
          E.dec.lamp.push(0); E.dec.desl.push(0);
        }
        pon(E.dec, { g: 'cyl', a: 24, sx: 5.6, sy: 0.3, sz: 5.6, x: cx, y: E.yb, z: cz, c: [0.9, 0.9, 0.92] });            // la peana
        E.solidos.push({ x0: cx - 2.8, x1: cx + 2.8, z0: cz - 2.8, z1: cz + 2.8 });
      }
      geo.dispose();
      var dx = Z.x1 - 3;
      caja(E.dec, dx - 1.2, E.yb, Z.z1 - 4, dx + 1.2, E.yb + 0.76, Z.z1 - 3.2, [0.95, 0.95, 0.96]);                  // la mesa del vendedor
      E.solidos.push({ x0: dx - 1.2, x1: dx + 1.2, z0: Z.z1 - 4, z1: Z.z1 - 3.2 });
      E.letrero = t('Sala de exposición') + ' · ' + n + ' ' + (n === 1 ? t('coche') : t('coches'));
      E.coches = n;
    }
    /** La cabina del ascensor (en su propio grupo, que sube y baja con el jugador). */
    function construyeCabina(casa) {
      var plan = casa.plan, c = plan.cab, E = nuevoEspacio('cabina', 0), ex = plan.ex, alto = 2.45, z1 = c.z1 - 0.02;
      var pared0 = [0.78, 0.8, 0.83];
      losa(E, c.x0, c.z0, c.x1, z1, alto, [0.3, 0.3, 0.32], [0.9, 0.9, 0.9]);
      pared(E, 'x', c.x0, c.x1, c.z0, c.z0 + 0.06, alto, [], pared0);
      pared(E, 'z', c.z0, z1, c.x0, c.x0 + 0.06, alto, [], pared0);
      pared(E, 'z', c.z0, z1, c.x1 - 0.06, c.x1, alto, [], pared0);
      pared(E, 'x', c.x0, c.x1, z1 - 0.08, z1, alto, [{ a: ex - 0.5, b: ex + 0.5, y0: 0, y1: 2.15 }], pared0);
      caja(E.dec, c.x0 + 0.1, 0.9, c.z0 + 0.06, c.x1 - 0.1, 0.94, c.z0 + 0.12, ACERO);                              // el pasamanos
      caja(E.dec, c.x0 + 0.3, 1.0, c.z0 + 0.06, c.x1 - 0.3, 2.1, c.z0 + 0.075, [0.7, 0.78, 0.82]);                    // el espejo
      caja(E.dec, ex + 0.6, 1.0, z1 - 0.1, ex + 0.8, 1.5, z1 - 0.085, [0.3, 0.3, 0.33]);                              // la botonera
      pon(E.dec, { g: 'cyl', a: 14, sx: 0.4, sy: 0.05, sz: 0.4, x: ex, y: alto - 0.06, z: (c.z0 + z1) / 2, c: PANTALLA_LUZ }, LAMPARA_CABINA + 1);
      // Las hojas: dos, por dentro del frente, que se abren 0,52 m hacia los lados.
      caja(E.dec, ex - 0.55, 0.01, z1 - 0.16, ex + 0.01, 2.14, z1 - 0.11, [0.62, 0.64, 0.67], 0, -1);
      caja(E.dec, ex - 0.01, 0.01, z1 - 0.16, ex + 0.55, 2.14, z1 - 0.11, [0.62, 0.64, 0.67], 0, 1);
      E.solidos.push({ x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1 });
      return E;
    }
    /** El rellano de una planta: del ascensor a la puerta del piso. */
    function construyeRellano(E, plan, puertaX, pal) {
      var ex = plan.ex, x0 = Math.min(ex - 1.3, puertaX - 0.9), x1 = Math.max(ex + 1.3, puertaX + 0.9), z0 = plan.zL0, z1 = plan.zA0 - 0.15, alto = LIBRE;
      var cp = tono(pal.pared, 0.97), cs = hex(PAL.marmol[0]);
      losa(E, x0, z0, x1, z1, alto, cs, [0.95, 0.95, 0.94]);
      pared(E, 'z', z0 - 0.2, z1, x0 - 0.2, x0, alto, [], cp);
      pared(E, 'z', z0 - 0.2, z1, x1, x1 + 0.2, alto, [], cp);
      pared(E, 'x', x0 - 0.2, x1 + 0.2, z0 - 0.2, z0, alto, [{ a: ex - 0.55, b: ex + 0.55, y0: 0, y1: 2.2 }], cp);
      marcoAscensor(E, plan);
      lamparaTecho(E, LAMPARA_RELLANO, (x0 + x1) / 2, (z0 + z1) / 2, alto, true, 'rellano', true);
      E.interact.push({ tipo: 'ascensor', x: ex, y: E.yb + 1.3, z: z0, caja: { x0: ex - 0.8, x1: ex + 0.8, y0: E.yb, y1: E.yb + 2.4, z0: z0 - 0.3, z1: z0 + 0.3 } });
      E.rellano = { x0: x0, x1: x1, z0: z0, z1: z1 };
      return { x0: x0, x1: x1 };
    }
    /** Una planta: rellano y piso (el ático a todo lo ancho, o el hueco de su unidad). */
    function construyePlanta(casa, piso) {
      var plan = casa.plan, B1 = plan.B1, yb = plan.suelo + ALTO_PLANTA * piso.planta, E = nuevoEspacio('planta', yb);
      var W, cx, fx = plan.fx1 - plan.fx0;
      if (piso.slot < 0) { W = Math.max(7, Math.min(fx - 1.4, 16)); cx = (plan.fx0 + plan.fx1) / 2; }
      else { var Ws = (fx - 1) / plan.upp; W = Math.max(7, Math.min(Ws - 0.4, 15)); cx = plan.fx0 + 0.5 + (piso.slot + 0.5) * Ws; }
      var x0 = cx - W / 2, x1 = cx + W / 2;
      var r = lcg(semillaEdificio(plan.po, CANAL_PISO, piso.planta * 16 + piso.slot + 2)), pal = paletaPiso(r);
      var rx0 = Math.min(plan.ex - 1.3, (x0 + x1) / 2 - 0.9), rx1 = Math.max(plan.ex + 1.3, (x0 + x1) / 2 + 0.9);
      construyePiso(E, x0, x1, plan.zA0, plan.zI, LIBRE, { lado: 'atras', x: clamp(plan.ex, x0 + 2, x1 - 2) }, r, rx0 - 0.2, rx1 + 0.2, pal);
      construyeRellano(E, plan, E.puertaPiso.x, pal);
      E.limites = { x0: Math.min(x0, E.rellano.x0), x1: Math.max(x1, E.rellano.x1), z0: plan.zL0, z1: plan.zI };
      E.piso = piso;
      E.pisoId = plan.po.id + ':' + piso.planta + ':' + (piso.slot < 0 ? 'a' : piso.slot);
      return E;
    }
    /** La villa: la casa entera en planta baja, con la puerta de la calle en el salón. */
    function construyeVilla(casa) {
      var plan = casa.plan, V = plan.casa, E = nuevoEspacio('bajo', V.yb), r = lcg(semillaEdificio(plan.po, CANAL_PISO, 1)), pal = paletaPiso(r);
      construyePiso(E, V.x0, V.x1, V.z0, V.zI, plan.alto, { lado: 'frente', x: plan.px, ancho: plan.hueco }, r, undefined, undefined, pal);
      E.salida = { x: plan.px, ancho: plan.hueco, z: V.zI };
      E.interact.push({ tipo: 'salida', x: plan.px, y: E.yb + 1.3, z: V.zI + 0.2, caja: { x0: plan.px - plan.hueco / 2, x1: plan.px + plan.hueco / 2, y0: E.yb, y1: E.yb + 2.3, z0: V.zI - 0.1, z1: V.zI + 0.4 } });
      E.piso = { clase: plan.po.pc && S.city && S.city.me && plan.po.pc.owner === S.city.me ? 'atico' : 'muestra', planta: 0, slot: 0 };
      E.pisoId = plan.po.id + ':0:0';
      return E;
    }
    /** La nave: una sala diáfana con estanterías, palés y focos. */
    function construyeNave(casa) {
      var plan = casa.plan, N = plan.sala, E = nuevoEspacio('bajo', N.yb), r = lcg(semillaEdificio(plan.po, CANAL_PISO, 3)), alto = N.alto, px = plan.px;
      var cp = [0.78, 0.78, 0.76], cs = [0.55, 0.56, 0.57], i, j, k;
      losa(E, N.x0, N.z0, N.x1, N.z1, alto, cs, [0.62, 0.63, 0.64]);
      pared(E, 'x', N.x0 - 0.2, N.x1 + 0.2, N.z1, N.z1 + 0.2, alto, [{ a: px - plan.hueco / 2, b: px + plan.hueco / 2, y0: 0, y1: 2.3 }], cp, [0.4, 0.42, 0.45]);
      pared(E, 'z', N.z0 - 0.2, N.z1 + 0.2, N.x0 - 0.2, N.x0, alto, [], cp);
      pared(E, 'z', N.z0 - 0.2, N.z1 + 0.2, N.x1, N.x1 + 0.2, alto, [], cp);
      pared(E, 'x', N.x0 - 0.2, N.x1 + 0.2, N.z0 - 0.2, N.z0, alto, [], cp);
      E.salida = { x: px, ancho: plan.hueco, z: N.z1 };
      var filas = Math.max(1, Math.floor((N.z1 - N.z0 - 8) / 5)), largo = Math.min(14, N.x1 - N.x0 - 8), naranja = [0.9, 0.5, 0.15], azul = [0.2, 0.35, 0.6];
      for (i = 0; i < filas; i++) {
        var z = N.z0 + 2 + i * 5, x0 = (N.x0 + N.x1) / 2 - largo / 2, hs = Math.min(alto - 1.2, 5.4);
        for (k = 0; k <= Math.floor(largo / 2.7); k++) caja(E.dec, x0 + k * 2.7 - 0.05, E.yb, z, x0 + k * 2.7 + 0.05, E.yb + hs, z + 1.1, azul);
        for (j = 0; j < 3; j++) {
          caja(E.dec, x0, E.yb + 0.2 + j * hs / 3, z, x0 + largo, E.yb + 0.3 + j * hs / 3, z + 1.1, naranja);
          for (k = 0; k < Math.floor(largo / 1.35); k++) if (r() < 0.75) { var hb = 0.4 + 0.5 * r(); caja(E.dec, x0 + k * 1.35 + 0.1, E.yb + 0.3 + j * hs / 3, z + 0.1, x0 + k * 1.35 + 1.2, E.yb + 0.3 + j * hs / 3 + hb, z + 1.0, [0.66 + 0.1 * r(), 0.5, 0.3]); }
        }
        E.solidos.push({ x0: x0, x1: x0 + largo, z0: z, z1: z + 1.1 });
      }
      for (i = 0; i < 4; i++) { var ppx = N.x0 + 2 + i * 1.6; caja(E.dec, ppx, E.yb, N.z1 - 3, ppx + 1.2, E.yb + 0.15, N.z1 - 2, [0.7, 0.55, 0.35]); caja(E.dec, ppx + 0.1, E.yb + 0.15, N.z1 - 2.9, ppx + 1.1, E.yb + 0.95, N.z1 - 2.1, [0.72, 0.58, 0.38]); }
      E.solidos.push({ x0: N.x0 + 2, x1: N.x0 + 8, z0: N.z1 - 3, z1: N.z1 - 2 });
      var nl = Math.min(6, 2 + Math.floor((N.x1 - N.x0) / 14));
      for (i = 0; i < nl; i++) lamparaTecho(E, i, N.x0 + (N.x1 - N.x0) * (i + 0.5) / nl, (N.z0 + N.z1) / 2, alto, true, 'foco');
      E.limites = { x0: N.x0, x1: N.x1, z0: N.z0, z1: N.z1 };
      E.ventana = { z: N.z1 + 0.2, k: 0.25 };
      E.interact.push({ tipo: 'salida', x: px, y: E.yb + 1.3, z: N.z1 + 0.1, caja: { x0: px - plan.hueco / 2, x1: px + plan.hueco / 2, y0: E.yb, y1: E.yb + 2.3, z0: N.z1 - 0.1, z1: N.z1 + 0.4 } });
      E.letrero = t('Nave');
      return E;
    }

    // =====================================================================================
    // 6. MALLAS DE UN ESPACIO, MUEBLES Y SU MEMORIA EN EL NAVEGADOR
    // =====================================================================================
    function montaEspacio(E, cabina) {
      var M = mats(), g;
      g = geometria(E.env);
      if (g) {
        E.mallas.push(malla(g, cabina ? M.fondoCab : M.fondo, 1000));
        E.mallas.push(malla(g, cabina ? M.envCab : M.env, 1001));
      }
      g = geometria(E.dec);
      if (g) E.mallas.push(malla(g, cabina ? M.cabDec : M.dec, 1001));
      if (E.extra) E.mallas.push(malla(E.extra.g, E.extra.m, 1001));
      for (var i = 0; i < E.mallas.length; i++) E.grupo.add(E.mallas[i]);
      E.triangulos = cuentaTriangulos(E.mallas);
      E.env = E.dec = null;                                                                  // los arrays ya están en la tarjeta
      if (E.muebles.length) rehazMuebles(E);
    }
    function cuentaTriangulos(ms) {
      var n = 0; for (var i = 0; i < ms.length; i++) { var g = ms[i].geometry, p = g.attributes.position; n += g.index ? g.index.count / 3 : (p ? p.count / 3 : 0); } return n;
    }
    function rehazMuebles(E) {
      if (E.mMuebles) { E.grupo.remove(E.mMuebles); E.mMuebles.geometry.dispose(); E.mMuebles = null; }
      var a = lote(), i;
      for (i = 0; i < E.muebles.length; i++) volcarMueble(a, E.muebles[i], E.yb, E.muebles[i].lampara === undefined ? -1 : E.muebles[i].lampara);
      var g = geometria(a);
      if (g) { E.mMuebles = malla(g, mats().dec, 1001); E.grupo.add(E.mMuebles); }
      E.trianMuebles = g ? g.attributes.position.count / 3 : 0;
      for (i = 0; i < E.lamparas.length; i++) { var L = E.lamparas[i]; if (L && L.mueble) { var p = luzMueble(L.mueble, E.yb); L.x = p.x; L.y = p.y; L.z = p.z; } }
      if (casa && casa.visible === E) subeLamparas();
      marcaSeleccion();
    }
    function soltarEspacio(E) {
      if (!E) return;
      var i;
      for (i = 0; i < E.mallas.length; i++) { if (E.mallas[i].geometry && (i === 0 || E.mallas[i].geometry !== E.mallas[i - 1].geometry)) E.mallas[i].geometry.dispose(); }
      if (E.mMuebles) E.mMuebles.geometry.dispose();
      if (E.extra) { E.extra.tx.dispose(); E.extra.m.dispose(); }
      if (E.grupo.parent) E.grupo.parent.remove(E.grupo);
    }
    function clavePiso(id) { return 'rami.piso.' + id; }
    function leePiso(E) {
      if (!E.pisoId) return;
      var d = null;
      try { d = JSON.parse(global.localStorage.getItem(clavePiso(E.pisoId)) || 'null'); } catch (e) { d = null; }
      if (!d || d.v !== 1) return;
      var i;
      for (i = 0; i < E.muebles.length; i++) {
        var mu = E.muebles[i], g = d.m && d.m[mu.id];
        if (g && g.length === 3 && isFinite(g[0]) && isFinite(g[1])) { mu.x = +g[0]; mu.z = +g[1]; mu.r = ((g[2] | 0) % 4 + 4) % 4; encaja(mu); }
      }
      if (d.l) for (i = 0; i < E.lamparas.length; i++) if (E.lamparas[i] && !E.lamparas[i].fija && d.l[i] !== undefined) E.lamparas[i].on = !!d.l[i];
      E.recuperado = true;
    }
    function guardaPiso(E) {
      if (!E || !E.pisoId) return false;
      var m = {}, l = [], i;
      for (i = 0; i < E.muebles.length; i++) { var mu = E.muebles[i]; m[mu.id] = [Math.round(mu.x * 100) / 100, Math.round(mu.z * 100) / 100, mu.r]; }
      for (i = 0; i < E.lamparas.length; i++) l.push(E.lamparas[i] ? (E.lamparas[i].on ? 1 : 0) : 0);
      try { global.localStorage.setItem(clavePiso(E.pisoId), JSON.stringify({ v: 1, m: m, l: l })); return true; } catch (e) { return false; }
    }
    function restauraPiso(E) {
      if (!E || !E.muebles.length) return false;
      try { global.localStorage.removeItem(clavePiso(E.pisoId)); } catch (e) {}
      for (var i = 0; i < E.muebles.length; i++) { var mu = E.muebles[i]; mu.x = mu.x0; mu.z = mu.z0; mu.r = mu.r0; }
      for (i = 0; i < E.lamparas.length; i++) if (E.lamparas[i] && !E.lamparas[i].fija && !E.lamparas[i].techoFijo) E.lamparas[i].on = false;
      sel = null; rehazMuebles(E); return true;
    }

    // =====================================================================================
    // 7. DENTRO: estado, luces, recorridos guiados, colisión, ascensor
    // =====================================================================================
    var casa = null, seq = null, sel = null, cercano = null, tBusca = 0, hud = null;
    function subeLamparas() {
      var E = casa && casa.visible, i, L;
      for (i = 0; i < MAX_LAMPARAS; i++) UNI.uLampOn.value[i] = 0;
      if (!casa) return;
      var p = {};
      if (E) for (i = 0; i < E.lamparas.length && i < MAX_LAMPARAS; i++) {
        L = E.lamparas[i]; if (!L) continue;
        aMundo(casa.m, L.x, L.z, p);
        UNI.uLampPos.value[i].set(p.x, casa.m.oy + L.y, p.z); UNI.uLampOn.value[i] = L.on ? 1 : 0; UNI.uLampCol.value[i].set(L.col[0], L.col[1], L.col[2]);
      }
      var c = casa.plan.cab;
      if (c && casa.cabina) {
        aMundo(casa.m, casa.plan.ex, (c.z0 + c.z1) / 2, p);
        UNI.uLampPos.value[LAMPARA_CABINA].set(p.x, casa.m.oy + casa.cabY + 2.1, p.z); UNI.uLampOn.value[LAMPARA_CABINA] = 1; UNI.uLampCol.value[LAMPARA_CABINA].set(1, 0.88, 0.7);
      }
      // La luz del día entra por el plano de la fachada del espacio visible.
      if (E && E.ventana) {
        var n = dirMundo(casa.m, 0, 1), q = aMundo(casa.m, 0, E.ventana.z);
        UNI.uVenN.value.set(n.x, 0, n.z); UNI.uVenD.value = n.x * q.x + n.z * q.z; UNI.uVentanas.value = E.ventana.k;
      } else UNI.uVentanas.value = 0;
    }
    /** Qué espacio se ve: uno (más la cabina, salvo durante el viaje, que va sola). */
    function ponVisible(E, soloCabina) {
      if (!casa) return;
      var todos = [casa.bajo, casa.planta], i;
      for (i = 0; i < todos.length; i++) if (todos[i]) todos[i].grupo.visible = !soloCabina && todos[i] === E;
      if (casa.cabina) casa.cabina.grupo.visible = true;
      casa.visible = soloCabina ? null : E;
      casa.soloCabina = !!soloCabina;
      subeLamparas();
    }
    function espacioActual() { return casa ? (casa.soloCabina ? casa.cabina : casa.visible) : null; }
    function sonido(nombre) {
      var s = ctx.servicios && ctx.servicios.sonido;
      if (s && typeof s.play === 'function') { try { s.play(nombre); } catch (e) {} }
    }
    /** Construye el interior del portal (en el mismo cuadro) y lo cuelga en la escena, oculto. */
    function abreCasa(po, op) {
      var t0 = performance.now(), plan = planifica(po), c = { po: po, plan: plan, m: marco(po.o, po.yaw), grupo: new THREE.Group(), cabY: 0, entrado: false };
      c.grupo.position.set(po.o.x, po.o.y, po.o.z); c.grupo.rotation.set(0, po.yaw, 0); c.grupo.name = 'umbral';
      casa = c;
      if (plan.tipo === 'villa') c.bajo = construyeVilla(c);
      else if (plan.tipo === 'nave') c.bajo = construyeNave(c);
      else {
        c.bajo = construyeZaguan(c);
        c.cabina = construyeCabina(c);
        c.cabY = plan.suelo;
        c.piso = eligePiso(plan);
        if (op && op.planta !== undefined) c.piso = pisoEnPlanta(plan, op.planta, c.piso);
      }
      if (c.bajo.muebles.length) leePiso(c.bajo);
      montaEspacio(c.bajo, false); c.grupo.add(c.bajo.grupo);
      if (c.cabina) { montaEspacio(c.cabina, true); c.grupo.add(c.cabina.grupo); c.cabina.grupo.position.y = c.cabY; }
      c.grupo.visible = false;
      ctx.scene.add(c.grupo);
      ponVisible(c.bajo, false);
      medidas.msConstruir = performance.now() - t0;
      return c;
    }
    function pisoEnPlanta(plan, n, actual) {
      var v = plan.plantas, k = v[0], i;
      for (i = 0; i < v.length; i++) if (Math.abs(v[i] - n) < Math.abs(k - n)) k = v[i];
      if (actual && actual.planta === k) return actual;
      return { clase: 'muestra', planta: k, slot: 0 };
    }
    function montaPlanta(piso) {
      if (casa.planta) { soltarEspacio(casa.planta); casa.planta = null; }
      var E = construyePlanta(casa, piso);
      leePiso(E);
      montaEspacio(E, false); casa.grupo.add(E.grupo);
      E.grupo.visible = false;
      casa.planta = E;
      return E;
    }
    function cierraCasa() {
      if (!casa) return;
      soltarEspacio(casa.bajo); soltarEspacio(casa.planta); soltarEspacio(casa.cabina);
      if (casa.grupo.parent) casa.grupo.parent.remove(casa.grupo);
      casa = null; seq = null; sel = null;
      for (var i = 0; i < MAX_LAMPARAS; i++) UNI.uLampOn.value[i] = 0;
      marcaSeleccion();
    }

    // ---- La posición del jugador en el marco del edificio ---------------------------------
    var _l = { x: 0, z: 0 }, _w = { x: 0, z: 0 };
    function posLocal() { return aLocal(casa.m, walk.pos.x, walk.pos.z, _l); }
    function ponLocal(x, z, y) { aMundo(casa.m, x, z, _w); walk.pos.x = _w.x; walk.pos.z = _w.z; if (y !== undefined) walk.pos.y = casa.m.oy + y; }
    function yawLocal() { return angulo(walk.yaw - casa.m.yaw); }
    function ponYawLocal(yl) { walk.yaw = angulo(yl + casa.m.yaw); }
    /** El yaw local con el que se mira en la dirección (dx, dz) local. */
    function yawHacia(dx, dz) { return Math.atan2(-dx, -dz); }

    // ---- Recorridos guiados (entrar, salir, subir al ascensor) ---------------------------
    function corre(pasos) { seq = { pasos: pasos, i: 0, t: 0, ini: false }; }
    function avanza(dt) {
      var guard = 0;
      while (seq && guard++ < 20) {
        var p = seq.pasos[seq.i];
        if (!p) { seq = null; break; }
        if (!seq.ini) { seq.ini = true; seq.t = 0; if (p.inicio) p.inicio(); }
        seq.t += dt;
        var fin = p.paso ? p.paso(seq.t, dt) : true;
        if (!fin) break;
        if (p.fin) p.fin();
        if (!seq) break;
        seq.i++; seq.ini = false; dt = 0;
      }
    }
    /** Anda por puntos locales {x, z, y (cota local de los pies)} a VEL, mirando hacia donde va; al final gira a `yawFinal`. */
    function pasoAndar(puntos, yawFinal, vel) {
      var tramo = null;
      return {
        inicio: function () {
          var p0 = posLocal(), pts = [{ x: p0.x, z: p0.z, y: walk.pos.y - casa.m.oy }], i, L = 0;
          for (i = 0; i < puntos.length; i++) pts.push(puntos[i]);
          for (i = 1; i < pts.length; i++) { if (pts[i].y === undefined) pts[i].y = pts[i - 1].y; pts[i].s = L = L + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); }
          pts[0].s = 0;
          tramo = { pts: pts, L: L, v: vel || VEL, giro: 0 };
        },
        paso: function (tt, dt) {
          var T = tramo, s = Math.min(T.L, tt * T.v), i = 1;
          while (i < T.pts.length - 1 && T.pts[i].s < s) i++;
          var a = T.pts[i - 1], b = T.pts[i], f = b.s > a.s ? clamp((s - a.s) / (b.s - a.s), 0, 1) : 1;
          ponLocal(lerp(a.x, b.x, f), lerp(a.z, b.z, f), lerp(a.y, b.y, f));
          var yf = typeof yawFinal === 'function' ? yawFinal() : yawFinal;
          var obj = s < T.L - 0.05 ? yawHacia(b.x - a.x, b.z - a.z) : (yf === undefined ? yawLocal() : yf);
          var yl = yawLocal(), d = angulo(obj - yl);
          ponYawLocal(yl + d * Math.min(1, dt * 7));
          walk.pitch += (0 - walk.pitch) * Math.min(1, dt * 5);
          if (s < T.L) return false;
          T.giro += dt;
          return Math.abs(d) < 0.02 || T.giro > 0.6;
        },
        fin: function () { if (yawFinal !== undefined) ponYawLocal(typeof yawFinal === 'function' ? yawFinal() : yawFinal); }
      };
    }
    function pasoFn(fn) { return { paso: function () { fn(); return true; } }; }
    function pasoPuertas(abrir, dur) {
      dur = dur || 0.9;
      return { inicio: function () { sonido('puerta'); }, paso: function (tt) { var f = clamp(tt / dur, 0, 1); mats().hojas.value = 0.52 * (abrir ? f : 1 - f); return f >= 1; } };
    }
    function pasoViaje(y0, y1) {
      var dur = clamp(1.6 + Math.abs(y1 - y0) / ALTO_PLANTA * 0.09, 2.5, 6);
      return {
        paso: function (tt) {
          var f = UT.smoothstep(tt / dur), y = lerp(y0, y1, f);
          casa.cabY = y; casa.cabina.grupo.position.y = y; walk.pos.y = casa.m.oy + y;
          casa.viaje = { f: f, dur: dur };
          subeLamparas();
          return tt >= dur;
        },
        fin: function () { casa.viaje = null; }
      };
    }

    /** Entrar por el portal `po`, andando desde donde se está (o, con `inmediato`, ya dentro). */
    function entrar(po, op) {
      op = op || {};
      if (!po || !S.ready) return false;
      if (casa) cierraCasa();
      if (S.mode !== 'walk') ctx.setMode('walk');
      abreCasa(po, op);
      casa.grupo.visible = false;
      sel = null;
      var pz = po.puerta, dentro = { x: pz.px, z: casa.bajo.salida.z - 1.6 };
      walk.fly = 0;
      if (op.inmediato) {
        ponLocal(dentro.x, dentro.z, casa.bajo.yb); ponYawLocal(0); walk.pitch = 0;
        casa.entrado = true; casa.grupo.visible = true;
        return true;
      }
      corre([pasoAndar([{ x: pz.px, z: po.zA }, { x: pz.px, z: pz.zf + 0.4, y: casa.bajo.yb }, dentro], 0), pasoFn(function () { casa.entrado = true; })]);
      return true;
    }
    /** Salir andando por la puerta de la calle, hasta quedar delante del portal mirando a la calle. */
    function salirAndando() {
      if (!casa || seq) return false;
      if (casa.visible !== casa.bajo) return salirYa();
      var po = casa.po, pz = po.puerta, fuera = aMundo(casa.m, pz.px, po.zA + 1.2), yf = ctx.mundo.groundH(fuera.x, fuera.z) - casa.m.oy;
      casa.entrado = false; sel = null;
      corre([pasoAndar([{ x: pz.px, z: casa.bajo.salida.z - 0.3 }, { x: pz.px, z: pz.zf + 0.4 }, { x: pz.px, z: po.zA + 1.2, y: yf }], Math.PI), pasoFn(function () { cierraCasa(); })]);
      return true;
    }
    /** Salir sin andar: delante del portal, mirando a la calle (Escape en un piso, órbita, VR). */
    function salirYa() {
      if (!casa) return false;
      var po = casa.po, fuera = aMundo(casa.m, po.puerta.px, po.zA + 1.2);
      walk.pos.set(fuera.x, ctx.mundo.groundH(fuera.x, fuera.z), fuera.z); walk.yaw = angulo(po.yaw + Math.PI); walk.pitch = 0.05; walk.fly = 0;
      cierraCasa();
      return true;
    }
    /** Al salir de la cabina se mira a la puerta del piso (arriba) o a la de la calle (abajo). */
    function mirarAlSalir() {
      var plan = casa.plan, E = casa.visible, z0 = plan.zL0 + 1.3;
      return function () {
        E = casa.visible;
        var tx = E && E.puertaPiso ? E.puertaPiso.x : plan.px, tz = E && E.puertaPiso ? E.puertaPiso.z : plan.zf;
        return yawHacia(tx - plan.ex, tz - z0);
      };
    }
    /** Coger el ascensor hasta la planta del piso (o bajar al zaguán). */
    function tomaAscensor(destino, inmediato) {
      if (!casa || !casa.cabina || seq) return false;
      var plan = casa.plan, c = plan.cab, ex = plan.ex, zc = (c.z0 + c.z1) / 2 - 0.1, subir = destino !== 'bajo';
      var piso = subir ? (typeof destino === 'object' ? destino : casa.piso) : null;
      var yD = subir ? plan.suelo + ALTO_PLANTA * piso.planta : plan.suelo;
      function llega() {
        var E = subir ? (casa.planta && casa.planta.piso === piso ? casa.planta : montaPlanta(piso)) : casa.bajo;
        casa.cabY = yD; casa.cabina.grupo.position.y = yD;
        ponVisible(E, false);
        return E;
      }
      if (inmediato) {
        var E = llega();
        ponLocal(ex, plan.zL0 + 1.3, yD); ponYawLocal(mirarAlSalir()()); walk.pitch = 0;
        mats().hojas.value = 0;
        return E;
      }
      sel = null;
      corre([
        pasoPuertas(true),
        pasoAndar([{ x: ex, z: c.z1 + 0.2 }, { x: ex, z: zc }], Math.PI, 1.6),
        pasoPuertas(false),
        pasoFn(function () { if (subir) { if (!(casa.planta && casa.planta.piso === piso)) montaPlanta(piso); } ponVisible(null, true); }),
        pasoViaje(casa.cabY, yD),
        pasoFn(function () { llega(); sonido('timbre'); }),
        pasoPuertas(true),
        pasoAndar([{ x: ex, z: c.z1 + 0.3 }, { x: ex, z: plan.zL0 + 1.3 }], mirarAlSalir(), 1.6),
        pasoPuertas(false)
      ]);
      return true;
    }

    // ---- Andar dentro, con su colisión ----------------------------------------------------
    function empuja(p, r, lista) {
      var pass, i, s, cx, cz, dx, dz, d2, d;
      for (pass = 0; pass < 2; pass++) {
        var movido = false;
        for (i = 0; i < lista.length; i++) {
          s = lista[i];
          cx = clamp(p.x, s.x0, s.x1); cz = clamp(p.z, s.z0, s.z1);
          dx = p.x - cx; dz = p.z - cz; d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          if (d2 > 1e-10) { d = Math.sqrt(d2); p.x += dx / d * (r - d); p.z += dz / d * (r - d); }
          else {
            var ex0 = p.x - s.x0, ex1 = s.x1 - p.x, ez0 = p.z - s.z0, ez1 = s.z1 - p.z, m = Math.min(ex0, ex1, ez0, ez1);
            if (m === ex0) p.x = s.x0 - r; else if (m === ex1) p.x = s.x1 + r; else if (m === ez0) p.z = s.z0 - r; else p.z = s.z1 + r;
          }
          movido = true;
        }
        if (!movido) break;
      }
    }
    function solidosDe(E) {
      var l = E.solidos.slice(), i;
      for (i = 0; i < E.muebles.length; i++) { var f = piezasMueble(E.muebles[i]); if (!f.pasa) l.push(huellaMueble(E.muebles[i])); }
      if (casa.cabina && E !== casa.cabina) { var c = casa.plan.cab; l.push({ x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1 }); }
      return l;
    }
    function andaDentro(dt) {
      var E = casa.visible; if (!E) return;
      var k = ctx.keys(), mx = 0, mz = 0;
      if (k.w || (!sel && k.arrowup)) mz -= 1; if (k.s || (!sel && k.arrowdown)) mz += 1;
      if (k.a || (!sel && k.arrowleft)) mx -= 1; if (k.d || (!sel && k.arrowright)) mx += 1;
      walk.fly = 0;
      var p = posLocal(), q = { x: p.x, z: p.z };
      if (mx || mz) {
        var n = Math.sqrt(mx * mx + mz * mz), sp = VEL * (k.shift ? 1.7 : 1) * dt, yl = yawLocal();
        mx /= n; mz /= n;
        var fx = -Math.sin(yl), fz = -Math.cos(yl), rx = Math.cos(yl), rz = -Math.sin(yl);
        q.x += (fx * -mz + rx * mx) * sp; q.z += (fz * -mz + rz * mx) * sp;
      }
      empuja(q, R_JUGADOR, solidosDe(E));
      var L = E.limites;
      q.x = clamp(q.x, L.x0 + 0.05, L.x1 - 0.05);
      if (!(E.salida && Math.abs(q.x - E.salida.x) < E.salida.ancho / 2)) q.z = clamp(q.z, L.z0 + 0.05, L.z1 - 0.05);
      ponLocal(q.x, q.z, E.yb);
      if (E.salida && q.z > E.salida.z - 0.12 && Math.abs(q.x - E.salida.x) < E.salida.ancho / 2) salirAndando();
    }

    // ---- Mirar, interactuar -------------------------------------------------------------------
    function ojo() {
      var cp = Math.cos(walk.pitch);
      return { o: { x: walk.pos.x, y: walk.pos.y + ctx.EYE, z: walk.pos.z }, d: { x: -Math.sin(walk.yaw) * cp, y: Math.sin(walk.pitch), z: -Math.cos(walk.yaw) * cp } };
    }
    /** Lo que se tiene delante (a menos de 3,2 m y a menos de ~22°): lámpara, ascensor, salida. */
    function objetivo() {
      var E = casa && casa.visible; if (!E || seq) return null;
      var v = ojo(), mejor = null, mc = 0.925, i, p = {};
      function mira(obj, x, y, z) {
        aMundo(casa.m, x, z, p);
        var dx = p.x - v.o.x, dy = casa.m.oy + y - v.o.y, dz = p.z - v.o.z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > 3.2 || d < 0.05) return;
        var c = (dx * v.d.x + dy * v.d.y + dz * v.d.z) / d;
        if (c > mc) { mc = c; mejor = obj; }
      }
      for (i = 0; i < E.lamparas.length; i++) if (E.lamparas[i] && !E.lamparas[i].fija) mira({ tipo: 'lampara', i: i }, E.lamparas[i].x, E.lamparas[i].y, E.lamparas[i].z);
      for (i = 0; i < E.interact.length; i++) mira(E.interact[i], E.interact[i].x, E.interact[i].y, E.interact[i].z);
      return mejor;
    }
    function accion(obj) {
      if (!obj || !casa) return false;
      if (obj.tipo === 'lampara') return conmuta(obj.i);
      if (obj.tipo === 'ascensor') return tomaAscensor(casa.visible === casa.bajo ? casa.piso : 'bajo');
      if (obj.tipo === 'salida') return salirAndando();
      return false;
    }
    function conmuta(i, on) {
      var E = casa && casa.visible; if (!E || !E.lamparas[i]) return false;
      E.lamparas[i].on = on === undefined ? !E.lamparas[i].on : !!on;
      subeLamparas();
      if (E.muebles.length) guardaPiso(E);
      return true;
    }
    /** Rayo (mundo) contra las cajas locales: muebles, lámparas, ascensor, salida. */
    function tocado(o, d) {
      var E = casa && casa.visible; if (!E) return null;
      var lo = aLocal(casa.m, o.x, o.z), ld = dirLocal(casa.m, d.x, d.z), oy = o.y - casa.m.oy, mejor = null, mt = 6, i;
      function prueba(obj, b) {
        var t0 = 0, t1 = mt, org = [lo.x, oy, lo.z], dir = [ld.x, d.y, ld.z], mn = [b.x0, b.y0, b.z0], mx = [b.x1, b.y1, b.z1], k;
        for (k = 0; k < 3; k++) {
          if (Math.abs(dir[k]) < 1e-9) { if (org[k] < mn[k] || org[k] > mx[k]) return; continue; }
          var a = (mn[k] - org[k]) / dir[k], bb = (mx[k] - org[k]) / dir[k];
          if (a > bb) { var tmp = a; a = bb; bb = tmp; }
          if (a > t0) t0 = a; if (bb < t1) t1 = bb; if (t0 > t1) return;
        }
        if (t0 < mt) { mt = t0; mejor = obj; }
      }
      for (i = 0; i < E.lamparas.length; i++) { var L = E.lamparas[i]; if (L && !L.fija) prueba({ tipo: 'lampara', i: i }, { x0: L.x - 0.3, x1: L.x + 0.3, y0: L.y - 0.3, y1: L.y + 0.35, z0: L.z - 0.3, z1: L.z + 0.3 }); }
      for (i = 0; i < E.interact.length; i++) prueba(E.interact[i], E.interact[i].caja);
      for (i = 0; i < E.muebles.length; i++) {
        var mu = E.muebles[i], h = huellaMueble(mu), f = piezasMueble(mu);
        prueba({ tipo: 'mueble', mu: mu }, { x0: h.x0, x1: h.x1, z0: h.z0, z1: h.z1, y0: E.yb, y1: E.yb + Math.max(f.alto, 0.05) });
      }
      return mejor;
    }
    // ---- Mover y girar muebles ----------------------------------------------------------------
    var selMalla = null;
    function marcaSeleccion() {
      if (selMalla) { if (selMalla.parent) selMalla.parent.remove(selMalla); selMalla.geometry.dispose(); selMalla.material.dispose(); selMalla = null; }
      var E = casa && casa.visible;
      if (!sel || !E) return;
      var h = huellaMueble(sel), f = piezasMueble(sel), g = new THREE.BoxGeometry(h.x1 - h.x0 + 0.06, Math.max(f.alto, 0.05) + 0.06, h.z1 - h.z0 + 0.06);
      g.translate((h.x0 + h.x1) / 2, E.yb + Math.max(f.alto, 0.05) / 2, (h.z0 + h.z1) / 2);
      selMalla = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x7ef0c0, transparent: true }));
      g.dispose();
      selMalla.renderOrder = 1002;
      E.grupo.add(selMalla);
    }
    function selecciona(mu) { sel = mu || null; marcaSeleccion(); return !!sel; }
    /** Mueve el seleccionado un paso de rejilla (0,25 m) hacia donde se mira (flecha arriba) o a los lados. */
    function mueveSel(adelante, derecha) {
      var E = casa && casa.visible; if (!sel || !E) return false;
      var yl = yawLocal(), fx = -Math.sin(yl), fz = -Math.cos(yl), ax, az;
      if (Math.abs(fx) > Math.abs(fz)) { ax = Math.sign(fx); az = 0; } else { ax = 0; az = Math.sign(fz); }
      // La derecha a pie es (cos yl, −sin yl): con el frente redondeado a (ax, az), es (−az, ax).
      var dx = ax * adelante - az * derecha, dz = az * adelante + ax * derecha;
      sel.x = Math.round((sel.x + dx * 0.25) * 4) / 4; sel.z = Math.round((sel.z + dz * 0.25) * 4) / 4;
      encaja(sel); rehazMuebles(E); guardaPiso(E);
      return true;
    }
    function giraSel() {
      var E = casa && casa.visible; if (!sel || !E) return false;
      sel.r = (sel.r + 1) % 4; encaja(sel); rehazMuebles(E); guardaPiso(E);
      return true;
    }

    // =====================================================================================
    // 8. EL AVISO (HUD) en el contenedor del visor
    // =====================================================================================
    function creaHud() {
      if (hud || !ctx.container || typeof document === 'undefined') return;
      var d = document.createElement('div');
      d.className = 'umbralHud';
      d.style.cssText = 'position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:3;max-width:78%;padding:6px 12px;border-radius:9px;' +
        'background:rgba(6,10,15,.8);color:#e9eff7;font:12px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none;display:none;box-shadow:0 2px 10px rgba(0,0,0,.35)';
      var txt = document.createElement('div'), btn = document.createElement('button');
      btn.type = 'button'; btn.textContent = t('Restaurar muebles');
      btn.style.cssText = 'pointer-events:auto;margin-top:6px;font:12px system-ui,sans-serif;padding:3px 10px;border-radius:7px;border:1px solid #7ef0c0;background:transparent;color:#7ef0c0;cursor:pointer;display:none';
      btn.addEventListener('click', function (ev) { ev.stopPropagation(); if (casa && casa.visible) restauraPiso(casa.visible); try { ctx.canvas.focus({ preventScroll: true }); } catch (e) {} });
      var mira = document.createElement('div');
      mira.style.cssText = 'position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.75);box-shadow:0 0 2px #000;z-index:3;pointer-events:none;display:none';
      d.appendChild(txt); d.appendChild(btn);
      ctx.container.appendChild(d); ctx.container.appendChild(mira);
      hud = { el: d, txt: txt, btn: btn, mira: mira, html: '', btnOn: false, on: false };
    }
    function escapa(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function pintaHud() {
      if (!hud) return;
      var lineas = null, boton = false;
      if (casa && (casa.entrado || seq)) lineas = lineasDentro();
      else if (cercano && !S.xr && S.mode === 'walk') lineas = ['<b>F · ' + escapa(t('Entrar')) + '</b>', escapa(nombrePortal(cercano.po))];
      if (casa && casa.visible && casa.visible.muebles.length && casa.entrado && !seq) boton = true;
      var html = lineas ? lineas.join('<br>') : '';
      if (html !== hud.html) { hud.txt.innerHTML = html; hud.html = html; }
      var on = !!lineas;
      if (on !== hud.on) { hud.el.style.display = on ? 'block' : 'none'; hud.on = on; }
      if (boton !== hud.btnOn) { hud.btn.style.display = boton ? 'inline-block' : 'none'; hud.btnOn = boton; }
      var mira = !!(casa && casa.entrado && !seq);
      hud.mira.style.display = mira ? 'block' : 'none';
    }
    function lineasDentro() {
      var plan = casa.plan, E = casa.visible, l = [], ob = objetivo();
      var nombre = escapa(nombrePortal(casa.po));
      if (casa.soloCabina) {
        var dest = casa.viaje ? Math.round(casa.viaje.f * 100) : 0;
        l.push('<b>' + escapa(t('Ascensor')) + '</b> · ' + nombre);
        l.push(escapa(t('planta')) + ' ' + Math.max(0, Math.round((casa.cabY - plan.suelo) / ALTO_PLANTA)) + ' · ' + dest + ' %');
        return l;
      }
      if (!E) return [nombre];
      if (E === casa.bajo) {
        if (plan.tipo === 'villa') l.push('<b>' + escapa(t(E.piso.clase === 'atico' ? 'Tu casa' : 'Casa de muestra')) + '</b> · ' + nombre);
        else if (plan.tipo === 'nave') l.push('<b>' + escapa(E.letrero) + '</b> · ' + nombre);
        else l.push('<b>' + escapa(E.letrero || t('Zaguán')) + '</b> · ' + nombre);
        if (plan.tipo !== 'villa' && plan.tipo !== 'nave' && casa.piso) l.push(escapa(titularPiso(plan, casa.piso)[0]));
      } else {
        var tl = titularPiso(plan, E.piso);
        l.push('<b>' + escapa(tl[0]) + '</b> · ' + nombre);
        for (var i = 1; i < tl.length; i++) l.push(escapa(tl[i]));
      }
      var ayuda = [];
      if (sel) ayuda.push(t('Flechas: mover') + ' · ' + t('R: girar') + ' · ' + t('Escape: soltar'));
      else if (ob && ob.tipo === 'lampara') ayuda.push('F · ' + t(E.lamparas[ob.i].on ? 'Apagar' : 'Encender'));
      else if (ob && ob.tipo === 'ascensor') ayuda.push('F · ' + t(E === casa.bajo ? 'Subir al piso' : 'Bajar al zaguán'));
      else if (ob && ob.tipo === 'salida') ayuda.push('F · ' + t('Salir'));
      else ayuda.push((E.muebles.length ? t('Clic en un mueble para moverlo') + ' · ' : '') + t('Escape: salir'));
      l.push('<span style="color:#9fb3c8">' + escapa(ayuda.join(' · ')) + '</span>');
      return l;
    }

    // =====================================================================================
    // 9. GANCHOS
    // =====================================================================================
    function puedeEntrar() { return S.ready && S.mode === 'walk' && !S.xr && walk.fly < 2; }
    function visibilidadTransito() {
      // Mientras se cruza la puerta el interior se dibuja solo con la cámara ya en
      // el hueco (la envolvente se pinta con la prueba «siempre»: vista desde la
      // calle se vería a través de la fachada).
      if (!casa) return;
      if (casa.entrado) { casa.grupo.visible = true; return; }
      var p = posLocal(), pz = casa.po.puerta;
      casa.grupo.visible = p.z < pz.zf + 0.6 && Math.abs(p.x - pz.px) < casa.plan.hueco / 2 + 0.6;
    }
    var ganchos = {
      listo: function () { creaHud(); indexaBarrios(); indexaParcelas(); },
      ciudad: function () {
        indexaParcelas();
        if (casa && casa.po.tipo === 'parcela') {                                             // la parcela ha cambiado: fuera si ya no es el mismo edificio
          var nuevo = porId[casa.po.id];
          if (!nuevo || nuevo.arch !== casa.po.arch || Math.abs(nuevo.o.y - casa.po.o.y) > 0.01) salirYa();
          else { nuevo = porId[casa.po.id]; casa.po.pc = nuevo.pc; }
        }
      },
      calidad: function () { cercano = null; },
      andar: function (dt) {
        if (!casa) return false;
        if (seq) { avanza(dt); if (casa) visibilidadTransito(); return true; }
        if (!casa.entrado) { cierraCasa(); return false; }
        andaDentro(dt);
        return true;
      },
      cuadro: function (dt) {
        tBusca += dt;
        if (!casa && puedeEntrar()) {
          if (tBusca >= PASO_BUSCA) { tBusca = 0; cercano = buscaCercano(); }
        } else if (!casa) cercano = null;
        if (casa) { visibilidadTransito(); if (seq && S.mode !== 'walk') salirYa(); }
        pintaHud();
      },
      tecla: function (k, e, abajo) {
        if (!abajo) return false;
        if (e && e.repeat && k === 'f') return !!casa;
        if (casa) {
          if (k === 'escape') { if (sel) { selecciona(null); return true; } if (seq) return true; if (casa.visible === casa.bajo) salirAndando(); else salirYa(); return true; }
          if (k === 'f') { if (!seq) accion(objetivo()); return true; }
          if (sel && !seq) {
            if (k === 'r') return giraSel();
            if (k === 'arrowup') return mueveSel(1, 0);
            if (k === 'arrowdown') return mueveSel(-1, 0);
            if (k === 'arrowleft') return mueveSel(0, -1);
            if (k === 'arrowright') return mueveSel(0, 1);
            if (k === 'delete' || k === 'backspace') { selecciona(null); return true; }
          }
          return false;
        }
        if (k === 'f' && cercano && puedeEntrar()) return entrar(cercano.po);
        return false;
      },
      clic: function (info) {
        if (casa) {
          if (seq || !casa.entrado) return true;
          var ob = tocado(info.origen, info.dir);
          if (ob && ob.tipo === 'mueble') { selecciona(sel === ob.mu ? null : ob.mu); return true; }
          if (sel) { selecciona(null); return true; }
          if (ob) accion(ob);
          return true;
        }
        if (!cercano || !puedeEntrar()) return false;
        // Clic en la puerta del portal cercano: el rayo contra la caja de la puerta.
        var po = cercano.po, m = marco(po.o, po.yaw), lo = aLocal(m, info.origen.x, info.origen.z), ld = dirLocal(m, info.dir.x, info.dir.z);
        var y0 = po.o.y + po.suelo, b = { x0: po.puerta.px - po.puerta.dw / 2 - 0.4, x1: po.puerta.px + po.puerta.dw / 2 + 0.4, y0: y0, y1: y0 + po.puerta.dh + 0.8, z0: po.puerta.zf - 0.3, z1: po.puerta.zf + 1.0 };
        var t0 = 0, t1 = 90, org = [lo.x, info.origen.y, lo.z], dir = [ld.x, info.dir.y, ld.z], mn = [b.x0, b.y0, b.z0], mx = [b.x1, b.y1, b.z1], k2;
        for (k2 = 0; k2 < 3; k2++) {
          if (Math.abs(dir[k2]) < 1e-9) { if (org[k2] < mn[k2] || org[k2] > mx[k2]) return false; continue; }
          var a = (mn[k2] - org[k2]) / dir[k2], bb = (mx[k2] - org[k2]) / dir[k2];
          if (a > bb) { var tmp = a; a = bb; bb = tmp; }
          if (a > t0) t0 = a; if (bb < t1) t1 = bb; if (t0 > t1) return false;
        }
        return entrar(po);
      },
      modo: function (m) {
        if (!casa) return;
        if (m !== 'walk') {                                                                   // a la órbita: fuera, delante del portal
          salirYa();
          var c = ctx.cam; c.cur.target.copy(walk.pos); c.goal.target.copy(walk.pos);
        }
      },
      vr: function (activo) {
        if (activo && casa) {
          salirYa();
          ctx.rig.position.set(walk.pos.x, walk.pos.y, walk.pos.z); ctx.rig.rotation.set(0, walk.yaw, 0);
        }
        cercano = null;
      },
      estadisticas: function (o) {
        var E = espacioActual(), mallas = 0, tri = 0, i;
        if (casa) {
          var lista = [casa.bajo, casa.planta, casa.cabina];
          for (i = 0; i < lista.length; i++) if (lista[i] && lista[i].grupo.visible) { mallas += lista[i].mallas.length + (lista[i].mMuebles ? 1 : 0); tri += lista[i].triangulos + (lista[i].trianMuebles || 0); }
          if (!casa.grupo.visible) { mallas = 0; tri = 0; }
        }
        o.umbral = { portales: portales.length, dentro: !!casa, espacio: E ? E.nombre : 'fuera', mallas: mallas, triangulos: tri,
          msBusqueda: +medidas.msBusqueda.toFixed(4), msBusquedaMax: +medidas.msBusquedaMax.toFixed(4), msBusquedaMedia: medidas.busquedas ? +(medidas.msBusquedaTotal / medidas.busquedas).toFixed(4) : 0, busquedas: medidas.busquedas, msIndice: +medidas.msIndice.toFixed(2), msConstruir: +medidas.msConstruir.toFixed(2) };
      },
      soltar: function () {
        cierraCasa();
        if (MAT) { for (var k in MAT) if (MAT[k] && MAT[k].dispose) MAT[k].dispose(); MAT = null; }
        if (hud) { if (hud.el.parentNode) hud.el.parentNode.removeChild(hud.el); if (hud.mira.parentNode) hud.mira.parentNode.removeChild(hud.mira); hud = null; }
      }
    };

    // =====================================================================================
    // 10. LO PÚBLICO (pruebas deterministas y panel): handle.ext.umbral
    // =====================================================================================
    function portalDe(q) {
      if (!q) return cercano ? cercano.po : null;
      if (typeof q === 'string') return porId[q] || null;
      return q.po || q;
    }
    function resumenPortal(po) {
      return po ? { id: po.id, tipo: po.tipo, nombre: nombrePortal(po), x: po.D.x, z: po.D.z, llegada: { x: po.A.x, z: po.A.z }, yaw: po.yaw, patio: po.patio, dibujado: dibujado(po), interior: tipoInterior(po) } : null;
    }
    ganchos.publico = {
      version: 1,
      /** Entra por un portal: { id } (o el cercano), { inmediato } para aparecer ya dentro, { planta } para el piso de esa planta. */
      entrar: function (op) { op = op || {}; var po = portalDe(op.id); if (!po) return false; return entrar(po, op); },
      salir: function (andando) { return andando ? salirAndando() : salirYa(); },
      estado: function () {
        if (!casa) return { dentro: false, cercano: cercano ? resumenPortal(cercano.po) : null };
        var E = espacioActual(), p = posLocal(), i, luces = [], muebles = [];
        if (E) { for (i = 0; i < E.lamparas.length; i++) luces.push(E.lamparas[i] ? { i: i, nombre: E.lamparas[i].nombre, on: E.lamparas[i].on } : null); for (i = 0; i < E.muebles.length; i++) muebles.push({ id: E.muebles[i].id, x: E.muebles[i].x, z: E.muebles[i].z, r: E.muebles[i].r }); }
        var plan = casa.plan;
        return { dentro: true, entrado: casa.entrado, guiado: !!seq, espacio: E ? E.nombre : null, portal: resumenPortal(casa.po), tipo: plan.tipo,
          plantas: plan.plantas || [0], unidadesPorPlanta: plan.upp || 1, piso: casa.piso || (casa.bajo && casa.bajo.piso) || null,
          planta: E && E.piso ? E.piso.planta : 0, pisoId: E ? E.pisoId || null : null, recuperado: !!(E && E.recuperado),
          titular: E && E.piso && plan.plantas ? titularPiso(plan, E.piso) : null, letrero: E ? E.letrero || null : null, coches: E ? E.coches || 0 : 0,
          buzones: casa.bajo && casa.bajo.buzones ? casa.bajo.buzones.n : 0,
          pos: { x: +p.x.toFixed(3), z: +p.z.toFixed(3), y: +(walk.pos.y - casa.m.oy).toFixed(3) }, yawLocal: +yawLocal().toFixed(4),
          cabina: casa.cabina ? +casa.cabY.toFixed(3) : null, luces: luces, muebles: muebles, seleccion: sel ? sel.id : null,
          objetivo: (function () { var o = objetivo(); return o ? (o.tipo === 'lampara' ? 'lampara:' + o.i : o.tipo) : null; })(),
          visible: casa.grupo.visible };
      },
      portalCercano: function () { return cercano ? { portal: resumenPortal(cercano.po), d: cercano.d } : null; },
      buscar: function () { cercano = puedeEntrar() ? buscaCercano() : null; return cercano ? { portal: resumenPortal(cercano.po), d: cercano.d } : null; },
      /** Los portales a menos de r metros de (x, z) de mundo, del más cercano al más lejano. */
      portales: function (x, z, r, filtro) {
        var out = [], i;
        for (i = 0; i < portales.length; i++) {
          var po = portales[i], d = Math.hypot(po.A.x - x, po.A.z - z);
          if (d <= r && (!filtro || po.tipo === filtro || po.kind === filtro || po.arch === filtro)) { var rp = resumenPortal(po); rp.d = d; out.push(rp); }
        }
        return out.sort(function (a, b) { return a.d - b.d; });
      },
      total: function () { return portales.length; },
      /** Planta n (0 = zaguán): en ascensor, o `inmediato` sin viaje. */
      irAPlanta: function (n, inmediato) {
        if (!casa || !casa.cabina) return false;
        if (n === 0 || n === 'bajo') return tomaAscensor('bajo', inmediato);
        var piso = n === undefined ? casa.piso : pisoEnPlanta(casa.plan, n, casa.piso);
        if (inmediato) { casa.entrado = true; casa.grupo.visible = true; seq = null; return !!tomaAscensor(piso, true); }
        return tomaAscensor(piso, false);
      },
      /** Pone al jugador en (x, z) locales del espacio visible, mirando con yaw local yl (0 = hacia dentro, π = hacia la fachada). */
      colocar: function (x, z, yl, pitch) { if (!casa) return false; ponLocal(x, z, espacioActual().yb); ponYawLocal(yl || 0); walk.pitch = pitch || 0; return true; },
      /** Una pose para mirar algo: 'ventana', 'pared', 'buzones', 'ascensor', 'lampara', 'salida', 'salon', 'recepcion', 'coches', 'dormitorio'. */
      mirar: function (que) {
        var E = casa && casa.visible; if (!E) return false;
        var yb = E.yb, s = E.salon, c, v;
        function pon2(x, z, yl, p) { ponLocal(x, z, yb); ponYawLocal(yl); walk.pitch = p || 0; return true; }
        if (que === 'ventana' && E.ventanas && E.ventanas.length) { v = E.ventanas[0]; return pon2((v.a + v.b) / 2, E.limites.z1 - 3.0, Math.PI, -0.06); }
        if (que === 'pared' && s) return pon2((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2 + 0.3, s.x0 < E.limites.x0 + 0.5 ? Math.PI / 2 : -Math.PI / 2, 0);
        if (que === 'salon' && s) { c = E.cuartos.recibidor; return pon2((c.x0 + c.x1) / 2, c.z0 + 0.6, Math.atan2(-((s.x0 + s.x1) / 2 - (c.x0 + c.x1) / 2), -(s.z1 - c.z0)), -0.12); }
        if (que === 'dormitorio' && E.cuartos) { c = E.cuartos.dormitorio; return pon2(c.x0 < s.x0 ? c.x1 - 0.5 : c.x0 + 0.5, c.z0 + 0.5, Math.atan2(-((c.x0 + c.x1) / 2 - (c.x0 < s.x0 ? c.x1 - 0.5 : c.x0 + 0.5)), -(c.z1 - c.z0 - 0.5)), -0.15); }
        if (que === 'lampara') { var L = E.lamparas[0]; if (!L) return false; return pon2(L.x + (L.x < (E.limites.x0 + E.limites.x1) / 2 ? 2.2 : -2.2), L.z + 0.4, L.x < (E.limites.x0 + E.limites.x1) / 2 ? Math.PI / 2 - 0.2 : -Math.PI / 2 + 0.2, -0.1); }
        if (que === 'buzones' && E.buzones) { var bz = E.buzones; return pon2(bz.x + bz.dentro * 2.6, bz.z, bz.dentro > 0 ? Math.PI / 2 : -Math.PI / 2, -0.05); }
        if (que === 'ascensor') return pon2(casa.plan.ex, casa.plan.zL0 + 1.6, 0, 0);
        if (que === 'salida' && E.salida) return pon2(E.salida.x, E.salida.z - 3.2, Math.PI, 0);
        if (que === 'recepcion' || que === 'coches' || que === 'zaguan') { var Z = E.limites; return pon2((Z.x0 + Z.x1) / 2, Z.z1 - 1.2, 0, -0.08); }
        return false;
      },
      accion: function () { return accion(objetivo()); },
      luz: function (i, on) { return conmuta(i, on); },
      seleccionar: function (id) { var E = casa && casa.visible, i; if (!E) return false; if (!id) return selecciona(null); for (i = 0; i < E.muebles.length; i++) if (E.muebles[i].id === id) return selecciona(E.muebles[i]); return false; },
      mover: function (adelante, derecha) { return mueveSel(adelante | 0, derecha | 0); },
      girar: giraSel,
      restaurar: function () { return casa && casa.visible ? restauraPiso(casa.visible) : false; },
      medidas: function () { return JSON.parse(JSON.stringify(medidas)); },
      /** El plan de cada portal (sin construir nada): cuántos de cada interior, plantas y unidades, y lo que tarda. */
      diagnostico: function () {
        var t0 = performance.now(), cuenta = {}, sinPlantas = 0, plantas = 0, unidades = 0, fallos = 0, i;
        for (i = 0; i < portales.length; i++) {
          var pl = null;
          try { pl = planifica(portales[i]); } catch (e) { fallos++; continue; }
          cuenta[pl.tipo] = (cuenta[pl.tipo] || 0) + 1;
          if (pl.plantas && pl.upp) { plantas += pl.plantas.length; unidades += pl.plantas.length * pl.upp; }
          if (tipoInterior(portales[i]) === 'torre' && pl.tipo === 'villa') sinPlantas++;
        }
        return { portales: portales.length, interiores: cuenta, torresSinPlantaLibre: sinPlantas, plantas: plantas, unidades: unidades, fallos: fallos, ms: +(performance.now() - t0).toFixed(1) };
      }
    };
    return ganchos;
  });
})(typeof window !== 'undefined' ? window : this);
