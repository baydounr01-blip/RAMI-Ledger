/*
 * Dubái RAMI — módulo «memoria»: la ciudad que recuerda, encargos y el día uno.
 *
 * Secciones 6 a 8 del plan del metaverso: la placa y la pátina de cada
 * edificio (la cadena como memoria), los encargos que la economía ya genera,
 * el día uno de un jugador nuevo y el aviso de NOTICE.md siempre a la vista.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 *
 * Tres piezas, y las tres leen solo datos de consenso:
 *
 *   placa    junto al portal de cada edificio de parcela, «Bloque #<since>» y el
 *            nombre de la empresa. Una malla con un grupo de 16 placas que se
 *            reparten entre las más cercanas a la cámara (a menos de 70 m):
 *            legibles a pie, inexistentes de lejos.
 *   pátina   el tono del cuerpo se templa y se apaga con los días de cadena
 *            transcurridos desde `since` (1.440 bloques de 60 s). El NIVEL es un
 *            entero —mismo nivel en todas las máquinas— y solo la mezcla de color
 *            es coma flotante. Lo aplica el núcleo al color del edificio en
 *            `applyCity` a través de `servicios.patina`.
 *   encargos lo que la ciudad importa (`huecos`: nadie lo ofrece) repartido por
 *            el distrito de las empresas que lo necesitan; etiquetas sobre los
 *            distritos y una barrita con 📋. La tarjeta del panel hace la misma
 *            cuenta (`encargosDe` en dashboard.html).
 *
 * Y la guía del día uno (📖): seis pasos marcables, con el progreso en
 * localStorage, la cuenta atrás a Dubái y a la escritura de vivienda, y lo que
 * cambia de un día para otro.
 */
(function (global) {
  'use strict';

  // ---- Constantes ------------------------------------------------------------------
  var BLOQUES_DIA = 1440;              // 60 s por bloque (rami-core/params.rs): un día de cadena
  var PATINA_NIVELES = 12;             // el nivel n llega el día n² → el tope, el día 144 (~cinco meses)
  var PLAN_DUBAI = 1796083200;         // 1-dic-2026 00:00 UTC (si /api/city no trae `dubai_desde`)
  var PLAN_VIVIENDA = 1803859200;      // 1-mar-2027 00:00 UTC (si /api/city no trae `vivienda_desde`)
  var PLACA_W = 1.1, PLACA_H = 0.55, PLACA_FONDO = 0.04;   // metros
  var PLACA_DIST = 70;                 // a más distancia no se asigna placa
  var HUECOS_PLACA = 16;               // placas simultáneas (un atlas de 4 × 4)
  var SLOT_W = 512, SLOT_H = 256;      // píxeles de cada placa en el atlas
  var GUIA_CLAVE = 'rami.memoria.guia', ENC_CLAVE = 'rami.memoria.encargos';

  /**
   * Nivel de pátina: entero de 0 a 12. Solo aritmética entera sobre dos datos de
   * consenso (la altura de la cabeza y el `since` de la parcela), así que dos
   * máquinas en la misma cabeza ven el mismo nivel. Rápido al principio (día 1,
   * 4, 9…) y lento después: se nota la primera semana y no se ensucia nunca.
   */
  function nivelPatina(altura, desde) {
    var edad = (altura | 0) - (desde | 0);
    if (!(edad > 0)) return 0;
    var dias = Math.floor(edad / BLOQUES_DIA), n = 0;
    while (n < PATINA_NIVELES && (n + 1) * (n + 1) <= dias) n++;
    return n;
  }
  /**
   * La curva de color (fenotipo): con k = nivel/12, hasta un 28 % hacia el gris
   * de su propia luminancia, una dominante cálida (azul −12 %, verde −4 %) y un
   * 10 % menos de luz. En el tope el edificio parece asentado, no sucio.
   */
  function patina(altura, desde, rgb) {
    var k = nivelPatina(altura, desde) / PATINA_NIVELES;
    if (!k || !rgb) return rgb;
    var r = rgb[0], g = rgb[1], b = rgb[2], lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    var gris = 0.28 * k, luz = 1 - 0.10 * k;
    var cr = 1 + 0.02 * k, cg = 1 - 0.04 * k, cb = 1 - 0.12 * k;
    function c1(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    return [c1((r + (lum - r) * gris) * cr * luz), c1((g + (lum - g) * gris) * cg * luz), c1((b + (lum - b) * gris) * cb * luz)];
  }

  /**
   * Encargos por distrito. `d` es la vista de /api/city: `huecos` = [[sector,
   * empresas], …] (lo que nadie ofrece en la ciudad y cuántas empresas lo
   * importan), `sectors[k].insumos`, `parcels[i].distrito` y `districts`. Una
   * empresa necesita el hueco `h` si `h` está entre los insumos de su sector;
   * se cuenta en el distrito de la empresa. La suma por distritos de cada hueco
   * es la cifra de `huecos` (el consenso no cuenta la propia parcela como
   * proveedora, y ningún sector se tiene a sí mismo de insumo).
   * Devuelve [{ distrito, nombre, precio, empresas, faltan: [{ sector, empresas }], cx, cy }],
   * de más a menos empresas; a igualdad, por id de distrito. (cx, cy) es la
   * celda de una de esas empresas —la más cercana a su centroide; a igualdad,
   * la de menor y y luego menor x—: el centroide redondeado puede caer en una
   * celda libre o en otro distrito, y la ficha que abre el clic sería otra.
   */
  function encargos(d) {
    if (!d || !d.huecos || !d.huecos.length || !d.parcels || !d.sectors) return [];
    var hueco = {}, i, j, porD = {}, lista = [], dist = {};
    for (i = 0; i < d.huecos.length; i++) hueco[d.huecos[i][0]] = true;
    for (i = 0; i < (d.districts || []).length; i++) dist[d.districts[i].id] = d.districts[i];
    for (i = 0; i < d.parcels.length; i++) {
      var p = d.parcels[i];
      if (p.pending) continue;                                  // lo del mempool aún no es ciudad
      var sec = d.sectors[p.kind | 0];
      if (!sec || !sec.insumos) continue;
      var di = p.distrito | 0, e = porD[di], usa = false;
      for (j = 0; j < sec.insumos.length; j++) {
        var h = sec.insumos[j];
        if (!hueco[h]) continue;
        if (!e) e = porD[di] = { distrito: di, faltan: {}, empresas: 0, sx: 0, sy: 0 };
        e.faltan[h] = (e.faltan[h] || 0) + 1; usa = true;
      }
      if (usa) { e.empresas++; e.sx += p.x; e.sy += p.y; (e.celdas || (e.celdas = [])).push(p.x | 0, p.y | 0); }
    }
    for (var k in porD) {
      if (!Object.prototype.hasOwnProperty.call(porD, k)) continue;
      var E = porD[k], fal = [], s;
      for (s in E.faltan) if (Object.prototype.hasOwnProperty.call(E.faltan, s)) fal.push({ sector: s | 0, empresas: E.faltan[s] });
      fal.sort(function (a, b) { return (b.empresas - a.empresas) || (a.sector - b.sector); });
      var D = dist[E.distrito] || {}, mx = E.sx / E.empresas, my = E.sy / E.empresas, bx = 0, by = 0, bd = Infinity;
      for (j = 0; j < E.celdas.length; j += 2) {
        var ex = E.celdas[j], ey = E.celdas[j + 1], d2 = (ex - mx) * (ex - mx) + (ey - my) * (ey - my);
        if (d2 < bd || (d2 === bd && (ey < by || (ey === by && ex < bx)))) { bd = d2; bx = ex; by = ey; }
      }
      lista.push({ distrito: E.distrito, nombre: D.nombre || ('#' + E.distrito), precio: D.precio || 0, empresas: E.empresas, faltan: fal, cx: bx, cy: by });
    }
    lista.sort(function (a, b) { return (b.empresas - a.empresas) || (a.distrito - b.distrito); });
    return lista;
  }

  // Las funciones puras, también para las pruebas y para quien no monte el visor.
  global.RamiMemoria = { nivelPatina: nivelPatina, patina: patina, encargos: encargos, BLOQUES_DIA: BLOQUES_DIA, PATINA_NIVELES: PATINA_NIVELES };

  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;

  function leeLocal(k) { try { return global.localStorage ? global.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function guardaLocal(k, v) { try { if (global.localStorage) global.localStorage.setItem(k, v); } catch (e) { /* ventana privada: el progreso dura la sesión */ } }
  function miles(n) { return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** «… {n} …» → el valor: la frase entera pasa por t() y cada idioma pone el número donde le toca. */
  function fmt(s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v[k] !== undefined ? String(v[k]) : m; }); }
  function hhmm(h) { var m = Math.floor(h * 60 + 1e-6) % 1440; return Math.floor(m / 60) + ':' + ('0' + m % 60).slice(-2); }
  function dhm(seg) { seg = Math.max(0, seg | 0); var d = Math.floor(seg / 86400), h = Math.floor(seg % 86400 / 3600), m = Math.floor(seg % 3600 / 60); return (d ? d + ' d ' : '') + h + ' h ' + m + ' min'; }

  var CSS = [
    '.mem-barra{position:absolute;left:10px;bottom:10px;z-index:3;display:flex;gap:6px;flex-wrap:wrap}',
    '.mem-barra button{font:600 12px system-ui,sans-serif;color:#e9eff7;background:rgba(8,13,20,.82);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:5px 9px;cursor:pointer}',
    '.mem-barra button.on{border-color:#ffb35c;color:#ffd7a8}',
    '.mem-barra button.nuevo{border-color:#7ef0c0;color:#7ef0c0}',
    // Sin min(): los webviews viejos no la entienden. En el visor de 644 px del
    // panel a 1280 × 800, 300 px; más estrecho, el 62 %.
    '.mem-guia{position:absolute;right:10px;top:54px;bottom:48px;width:62%;max-width:300px;z-index:3;overflow:auto;display:none;',
    'font:13px/1.45 system-ui,sans-serif;color:#e9eff7;background:rgba(8,13,20,.92);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:12px 14px}',
    '.mem-guia.on{display:block}',
    '.mem-guia h3{margin:0 0 4px;font-size:14px}',
    '.mem-guia .mem-prog{height:5px;border-radius:3px;background:rgba(255,255,255,.12);margin:6px 0 10px;overflow:hidden}',
    '.mem-guia .mem-prog i{display:block;height:100%;background:#7ef0c0}',
    '.mem-guia .mem-paso{border-top:1px solid rgba(255,255,255,.1);padding:8px 0}',
    '.mem-guia .mem-paso label{display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-weight:600}',
    '.mem-guia .mem-paso.hecho label{color:#7ef0c0}',
    '.mem-guia .mem-paso p{margin:3px 0 0 24px;color:#b9c3d6;font-size:12.5px}',
    '.mem-guia .mem-paso .mem-bt{margin:5px 0 0 24px;display:flex;gap:6px;flex-wrap:wrap}',
    '.mem-guia button{font:600 12px system-ui,sans-serif;color:#0b0f14;background:#7ef0c0;border:0;border-radius:7px;padding:4px 9px;cursor:pointer}',
    '.mem-guia .mem-cerrar{position:absolute;right:8px;top:6px;background:transparent;color:#e9eff7;font-size:16px}',
    '.mem-guia .mem-manana{border-top:1px solid rgba(255,255,255,.18);margin-top:6px;padding-top:8px}',
    '.mem-guia .mem-manana ul{margin:4px 0 0 18px;padding:0;color:#b9c3d6;font-size:12.5px}',
    '.mem-guia .mem-aviso{margin-top:10px;font-size:11.5px;color:#ffd166}'
  ].join('\n');

  global.RamiCity3D.extend('memoria', function (ctx) {
    var THREE = ctx.THREE, S = ctx.S, t = ctx.t, U = ctx.util, M = ctx.mundo;
    ctx.servicios.patina = patina;

    // =============================================================================
    // 1. La placa
    // =============================================================================
    var placas = [], huecos = [], placaMalla = null, placaTex = null, placaCanvas = null, placaG2 = null;
    var placaT = 0, _cam = new THREE.Vector3(), _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1);
    // La caja de una placa en su marco (x a la derecha, y arriba, +z hacia la
    // calle): el frente lleva el hueco del atlas; los cantos, un texel del marco.
    var CARAS = [
      { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], frente: true },
      { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
      { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
      { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
      { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] }
    ];
    var VPP = CARAS.length * 4, IPP = CARAS.length * 6;          // vértices e índices por placa

    function creaMallaPlacas() {
      placaCanvas = document.createElement('canvas');
      placaCanvas.width = SLOT_W * 4; placaCanvas.height = SLOT_H * 4;
      placaG2 = placaCanvas.getContext('2d');
      placaTex = new THREE.CanvasTexture(placaCanvas);
      placaTex.encoding = THREE.sRGBEncoding;
      placaTex.anisotropy = 4;
      var n = HUECOS_PLACA, pos = new Float32Array(n * VPP * 3), nor = new Float32Array(n * VPP * 3), uv = new Float32Array(n * VPP * 2), idx = new Uint16Array(n * IPP), i, f, c;
      for (i = 0; i < n; i++) {
        var u0 = (i % 4) * SLOT_W / placaCanvas.width, v0 = 1 - (Math.floor(i / 4) + 1) * SLOT_H / placaCanvas.height;
        var du = SLOT_W / placaCanvas.width, dv = SLOT_H / placaCanvas.height;
        for (f = 0; f < CARAS.length; f++) {
          var base = i * VPP + f * 4;
          for (c = 0; c < 4; c++) {
            var cu = CARAS[f].v[c][0] > 0 ? 1 : 0, cv = CARAS[f].v[c][1] > 0 ? 1 : 0;
            if (CARAS[f].frente) { uv[(base + c) * 2] = u0 + cu * du; uv[(base + c) * 2 + 1] = v0 + cv * dv; }
            else { uv[(base + c) * 2] = u0 + du * 0.01; uv[(base + c) * 2 + 1] = v0 + dv * 0.02; }    // el marco del hueco
          }
          var o = i * IPP + f * 6;
          idx[o] = base; idx[o + 1] = base + 1; idx[o + 2] = base + 2; idx[o + 3] = base; idx[o + 4] = base + 2; idx[o + 5] = base + 3;
        }
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      var mat = new THREE.MeshLambertMaterial({ map: placaTex, emissive: 0x3a3a3a, emissiveMap: placaTex });
      placaMalla = new THREE.Mesh(g, mat);
      placaMalla.name = 'memoria_placas'; placaMalla.frustumCulled = false; placaMalla.visible = false;
      placaMalla.receiveShadow = true;
      ctx.scene.add(placaMalla);
      for (i = 0; i < n; i++) huecos.push({ placa: null, clave: '' });
    }

    /** Dónde va la placa de cada parcela: junto a la vidriera del portal, a 1,5 m del suelo. */
    function calculaPlacas(d) {
      placas = [];
      if (!d || !d.parcels || !S.cellH) return;
      var N = ctx.N(), CELL = ctx.CELL(), rotR = ctx.rotR(), i, k;
      for (i = 0; i < d.parcels.length; i++) {
        var pc = d.parcels[i], x = pc.x | 0, y = pc.y | 0;
        if (pc.pending || x < 0 || y < 0 || x >= N || y >= N) continue;
        var kind = U.clamp(pc.kind | 0, 0, M.SECTOR_COLORS.length - 1), arch = M.SECTOR_ARCH[kind] || 'torre';
        // Los mismos sorteos que applyCity: planta (13, 14) y esbeltez (2).
        var sy = 0.85 + 0.3 * U.real01(U.semillaMorfologia(x, y, 2)) + Math.min(pc.assets | 0, 6) * 0.03;
        var ed = ctx.geom.parcelaPartes(arch, CELL, { v: U.real01(U.semillaMorfologia(x, y, 13)), v2: U.real01(U.semillaMorfologia(x, y, 14)), sy: sy, T: [1, 1, 1] });
        var lx = 0, lz = ed.hd, vid = null, ofi = null, valla = null;
        for (k = 0; k < ed.p.length; k++) {
          var q = ed.p[k];
          if (q.g) continue;
          if (q.sy === 4.4 && q.sz === 0.4) vid = vid || q;                      // la vidriera del portal (piezas.portal)
          else if (q.sx === 2 && q.sy === 2.6 && q.sz === 0.5) ofi = q;          // la puerta de la oficina de la nave
          else if (q.sy === 3 && q.sz === 1) valla = q;                          // la valla de «seguridad», delante del portal
        }
        if (vid) { lx = vid.x + vid.sx / 2 + 0.3 + PLACA_W / 2; lz = vid.z; }
        else if (ofi) { lx = ofi.x - ofi.sx / 2 - 0.4 - PLACA_W / 2; lz = ofi.z - 0.2; }
        if (valla) lz = valla.z + valla.sz / 2;                                  // la valla taparía la placa: va en ella
        var w = M.cellWorld(x, y), y0 = S.cellH[y * N + x] + 0.5 - ed.suelo;
        _m.compose(_v.set(w.x, y0, w.z), _q.setFromEuler(_e.set(0, rotR, 0)), _s);
        var centro = new THREE.Vector3(lx, ed.suelo, lz + PLACA_FONDO / 2 + 0.02).applyMatrix4(_m);
        // A 1,5 m del suelo que pisa quien la lee: el relieve delante del portal
        // puede quedar por encima de la planta baja (la celda es una cota media).
        centro.y = Math.max(centro.y, M.groundH(centro.x, centro.z)) + 1.5;
        var der = new THREE.Vector3(1, 0, 0).applyQuaternion(_q), nor = new THREE.Vector3(0, 0, 1).applyQuaternion(_q);
        placas.push({ x: x, y: y, since: pc.since | 0, nombre: pc.name || '', handle: pc.handle || '', mia: !!(d.me && pc.owner === d.me),
          centro: centro, der: der, nor: nor, clave: x + ':' + y + ':' + (pc.since | 0) + ':' + (pc.name || '') + ':' + (pc.handle || '') });
      }
      for (i = 0; i < huecos.length; i++) huecos[i].clave = '';               // se repintan al volver a asignarse
      placaT = 1e9;
    }

    function pintaPlaca(i, pl) {
      var g = placaG2, ox = (i % 4) * SLOT_W, oy = Math.floor(i / 4) * SLOT_H;
      var gr = g.createLinearGradient(ox, oy, ox, oy + SLOT_H);
      gr.addColorStop(0, '#c9a46a'); gr.addColorStop(0.5, '#a9844c'); gr.addColorStop(1, '#8a6a3a');
      g.fillStyle = gr; g.fillRect(ox, oy, SLOT_W, SLOT_H);
      g.lineWidth = 8; g.strokeStyle = '#5b4322'; g.strokeRect(ox + 14, oy + 14, SLOT_W - 28, SLOT_H - 28);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      var cx = ox + SLOT_W / 2;
      function grabado(txt, px, y, negrita) {
        g.font = (negrita ? 'bold ' : '') + px + 'px Georgia, "Times New Roman", serif';
        var s = txt, max = SLOT_W - 70;
        while (s.length > 3 && g.measureText(s).width > max) s = s.slice(0, -2);
        if (s !== txt) s = s.slice(0, -1) + '…';
        g.fillStyle = 'rgba(255,236,196,0.55)'; g.fillText(s, cx + 1.5, y + 2);      // el bisel claro del grabado
        g.fillStyle = '#2b1d0c'; g.fillText(s, cx, y);
      }
      grabado(t('Bloque') + ' #' + miles(pl.since), 62, oy + (pl.handle ? 76 : 92), true);
      grabado(pl.nombre || t('Empresa'), 40, oy + (pl.handle ? 146 : 170), false);
      if (pl.handle) grabado('@' + pl.handle, 34, oy + 198, false);
    }

    function escribeHueco(i, pl) {
      var g = placaMalla.geometry, pos = g.attributes.position.array, nor = g.attributes.normal.array, f, c;
      for (f = 0; f < CARAS.length; f++) for (c = 0; c < 4; c++) {
        var o = (i * VPP + f * 4 + c) * 3;
        if (!pl) { pos[o] = pos[o + 1] = pos[o + 2] = 0; nor[o] = nor[o + 1] = 0; nor[o + 2] = 1; continue; }
        var a = CARAS[f].v[c], hx = a[0] * PLACA_W / 2, hy = a[1] * PLACA_H / 2, hz = a[2] * PLACA_FONDO / 2, nn = CARAS[f].n;
        pos[o] = pl.centro.x + pl.der.x * hx + pl.nor.x * hz; pos[o + 1] = pl.centro.y + hy; pos[o + 2] = pl.centro.z + pl.der.z * hx + pl.nor.z * hz;
        nor[o] = pl.der.x * nn[0] + pl.nor.x * nn[2]; nor[o + 1] = nn[1]; nor[o + 2] = pl.der.z * nn[0] + pl.nor.z * nn[2];
      }
    }

    /** Reparte los 16 huecos entre las placas más cercanas a la cámara (cada 0,25 s). */
    function actualizaPlacas(dt) {
      if (!placaMalla) return;
      placaT += dt;
      if (placaT < 0.25) return;
      placaT = 0;
      ctx.camera.getWorldPosition(_cam);
      var cerca = [], i, j;
      for (i = 0; i < placas.length; i++) {
        var p = placas[i], dx = p.centro.x - _cam.x, dy = p.centro.y - _cam.y, dz = p.centro.z - _cam.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < PLACA_DIST * PLACA_DIST) cerca.push({ p: p, d2: d2 });
      }
      cerca.sort(function (a, b) { return a.d2 - b.d2; });
      if (cerca.length > HUECOS_PLACA) cerca.length = HUECOS_PLACA;
      var quiero = {}, cambioGeo = false, cambioTex = false, libres = [];
      for (i = 0; i < cerca.length; i++) quiero[cerca[i].p.clave] = cerca[i].p;
      for (i = 0; i < huecos.length; i++) {                                   // se quedan las que ya estaban
        if (huecos[i].clave && quiero[huecos[i].clave]) { delete quiero[huecos[i].clave]; continue; }
        if (huecos[i].clave || huecos[i].placa) { huecos[i].clave = ''; huecos[i].placa = null; escribeHueco(i, null); cambioGeo = true; }
        libres.push(i);
      }
      j = 0;
      for (var k in quiero) {
        if (!Object.prototype.hasOwnProperty.call(quiero, k) || j >= libres.length) continue;
        var h = libres[j++];
        huecos[h].clave = k; huecos[h].placa = quiero[k];
        pintaPlaca(h, quiero[k]); escribeHueco(h, quiero[k]); cambioGeo = cambioTex = true;
      }
      if (cambioGeo) { placaMalla.geometry.attributes.position.needsUpdate = true; placaMalla.geometry.attributes.normal.needsUpdate = true; }
      if (cambioTex) placaTex.needsUpdate = true;
      var activas = 0; for (i = 0; i < huecos.length; i++) if (huecos[i].clave) activas++;
      // La malla se envía entera (16 × 12 triángulos; los huecos libres son
      // degenerados y no rasterizan) o no se envía: una llamada de dibujo.
      placaMalla.visible = activas > 0;
    }

    // =============================================================================
    // 2. Los encargos
    // =============================================================================
    var lista = [], encLabels = null, verEncargos = leeLocal(ENC_CLAVE) !== '0';
    function nombreSector(k) { return M.sectorName(k); }
    // Corta (el primer insumo y cuántos más): la lista entera está en la
    // tarjeta «Encargos» del panel, y una etiqueta larga choca con más rótulos.
    function textoEncargo(e) {
      var partes = [t(nombreSector(e.faltan[0].sector)) + ' ×' + e.faltan[0].empresas];
      if (e.faltan.length > 1) partes.push('+' + (e.faltan.length - 1));
      return '📋 ' + fmt(t('{distrito}: falta {lista}'), { distrito: e.nombre, lista: partes.join(', ') });
    }
    function ponEncargos(d) {
      lista = encargos(d && d.datos ? d.datos : d);
      // Con `ctx.etiquetas`, como manda el contrato: el núcleo las recorta con sus
      // rótulos (barrios, hitos, ventas) y la que chocaría con uno no se dibuja.
      // Ancladas en una empresa del distrito (no en su centro, donde cae el
      // rótulo del barrio) y a 0,9 celdas de altura (585 m; tope 700): los
      // rótulos del núcleo van a 8 m del suelo y, en la vista oblicua, la altura
      // sube la etiqueta por encima de ellos. Medido en la vista de la ciudad con
      // la ciudad sintética: a 0,3 celdas (195 m) no pasaba ninguna; a 0,9 pasa
      // la de Downtown sin tocar ningún rótulo. La lista entera está en la
      // tarjeta del panel.
      if (!encLabels) { encLabels = new ctx.LabelSet(ctx.uniformes.viewport, false); encLabels.mesh.name = 'memoria_encargos'; ctx.scene.add(encLabels.mesh); ctx.etiquetas(encLabels); }
      var items = [], i;
      for (i = 0; i < lista.length && i < 40; i++) {
        var e = lista[i], w = M.cellWorld(U.clamp(e.cx, 0, ctx.N() - 1), U.clamp(e.cy, 0, ctx.N() - 1));
        items.push({ x: w.x, y: w.y + U.clamp(ctx.CELL() * 0.9, 60, 700), z: w.z, text: textoEncargo(e), color: '#ffb35c', size: 12, bold: true, pin: true, maxDist: S.L * 0.9, priority: 3 });
      }
      encLabels.set(items);
      encLabels.mesh.visible = verEncargos && items.length > 0;
      pintaBarra();
    }

    // =============================================================================
    // 3. La barrita y la guía del día uno
    // =============================================================================
    var raiz = ctx.container, barra = null, btnEnc = null, btnGuia = null, guia = null, estilo = null, reloj = 0;
    var jugador = { perfil: false, saldo: 0 }, oyentes = [], resaltar = false;
    var progreso = { h: {}, c: 0 };
    try { var pg0 = JSON.parse(leeLocal(GUIA_CLAVE) || 'null'); if (pg0 && typeof pg0 === 'object') progreso = { h: pg0.h || {}, c: pg0.c ? 1 : 0, visto: pg0.v || pg0.c ? 1 : 0 }; } catch (e0) { /* progreso nuevo */ }
    function guarda() { guardaLocal(GUIA_CLAVE, JSON.stringify({ h: progreso.h, c: progreso.c, v: progreso.visto ? 1 : 0 })); }

    var PASOS = [
      { id: 'mirar', titulo: 'Mira la ciudad', texto: 'Arrastra para girar y usa la rueda para acercarte. «Centro» y «Dubái» te llevan volando.',
        botones: [['🌇 Ir al centro', function () { ctx.handle.flyToSkyline(); }]] },
      { id: 'a_pie', titulo: 'Baja a pie', texto: 'Con «🚶 A pie» caminas con WASD y miras arrastrando; Q y E te suben y te bajan.',
        botones: [['🚶 Bajar a pie', function () { ctx.setMode('walk'); }]] },
      { id: 'entrar', titulo: 'Entra en un edificio', texto: 'Camina hasta el portal de un edificio y cruza la puerta. Junto al portal de cada edificio de parcela hay una placa con el bloque en que se fundó la empresa.' },
      { id: 'nombre', titulo: 'Crea tu nombre único', texto: 'En «Mi perfil de jugador», debajo del mapa. Registrar un nombre quema 2 RAMI de prueba y la transacción vale desde la activación de Dubái; tu avatar lo lleva con ✓.',
        botones: [['🪪 Ir a mi perfil', function () { irA('perfil'); }]] },
      { id: 'rami', titulo: 'Consigue RAMI de prueba', texto: 'Gratis: minando con este mismo programa o pidiéndolo a un faucet con tu dirección. Nadie vende RAMI y no tiene valor monetario.',
        botones: [['⛏ Minar', function () { irA('minar'); }], ['↙️ Mi dirección', function () { irA('recibir'); }]] },
      { id: 'fechas', titulo: 'Lo que llega', texto: '',
        botones: [['Entendido', function () { marca('fechas', true); }]] }
    ];
    function irA(destino) { if (typeof ctx.opts.irA === 'function') ctx.opts.irA(destino); }

    function hechos() { var n = 0; for (var i = 0; i < PASOS.length; i++) if (progreso.h[PASOS[i].id]) n++; return n; }
    function marca(id, v) {
      v = !!v;
      if (!!progreso.h[id] === v) return;
      if (v) progreso.h[id] = 1; else delete progreso.h[id];
      guarda(); pintaBarra(); if (guia && guia.className.indexOf(' on') >= 0) pintaGuia();
    }
    function abreGuia(v) {
      if (!guia) return;
      progreso.c = v ? 0 : 1; if (v) { progreso.visto = 1; resaltar = false; } guarda();
      guia.className = 'mem-guia' + (v ? ' on' : '');
      if (v) pintaGuia();
      pintaBarra();
    }

    function fechas() {
      var cargada = !!(S.city && S.city.datos), dd = cargada ? S.city.datos : {}, ahora = Date.now() / 1000;
      // La fecha de Dubái es la de la cadena. Solo sin datos todavía se enseña la
      // del plan; con datos y sin `dubai_desde` (regtest sin --dubai-desde), lo
      // mismo que la tarjeta del panel: esta red no tiene fecha.
      var dub = cargada ? dd.dubai_desde : PLAN_DUBAI, viv = dd.vivienda_desde || PLAN_VIVIENDA;
      function fecha(s) { try { return new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return new Date(s * 1000).toISOString().slice(0, 10); } }
      var h = dd.dubai ? '<p>🏙️ ' + esc(t('Dubái ya rige en esta cadena: parcelas, empresas, mercado y encargos.')) + '</p>'
        : !dub ? '<p>🏙️ ' + esc(t('Esta red no tiene fecha de activación de Dubái (regtest sin --dubai-desde).')) + '</p>'
        : '<p>🏙️ <b>' + esc(fecha(dub)) + '</b> — ' + (ahora >= dub ? esc(t('Dubái ya rige en esta cadena: parcelas, empresas, mercado y encargos.'))
        : esc(fmt(t('se activa Dubái: parcelas, empresas, mercado y encargos. Faltan {t}.'), { t: dhm(dub - ahora) }))) + '</p>';
      h += '<p>🏠 <b>' + esc(fecha(viv)) + '</b> — ' + (dd.vivienda_rige || ahora >= viv ? esc(t('rige la escritura de vivienda: tu piso, en el libro mayor.'))
        : esc(fmt(t('se activa la escritura de vivienda: tu piso, en el libro mayor. Faltan {t}.'), { t: dhm(viv - ahora) }))) + '</p>';
      return h;
    }
    function manana() {
      var dd = (S.city && S.city.datos) || {}, h = '<b>' + esc(t('Por qué vuelves mañana')) + '</b><ul>', i;
      var nEnc = 0; for (i = 0; i < lista.length; i++) nEnc += lista[i].faltan.length;
      // Los huecos dependen solo de las parcelas (ciudad::huecos): cambian cuando
      // se funda una empresa o una cambia de sector, no con cada bloque.
      h += '<li>' + (dd.dubai ? esc(fmt(t('Los encargos cambian cuando se funda una empresa o una cambia de sector: hoy hay {n} en {d} distritos.'), { n: nEnc, d: lista.length }))
        : esc(t('Los encargos empiezan con Dubái: cada bloque, el consenso calcula qué insumos importa la ciudad.'))) + '</li>';
      // La hora real de Dubái (UTC+4) sale del reloj, no de M.dubaiHour(), que
      // devuelve la hora fijada con el selector «Hora del día» si la hay.
      var real = ((Date.now() / 3600000 + 4) % 24 + 24) % 24, fijada = S.hour !== null && S.hour !== undefined;
      h += '<li>' + esc(fijada ? fmt(t('En Dubái son las {h}; la luz de la escena está fijada a las {f} (elige «Hora real de Dubái» para que la siga).'), { h: hhmm(real), f: hhmm(S.hour) })
        : fmt(t('La luz sigue la hora real de Dubái: ahora son las {h}.'), { h: hhmm(real) })) + '</li>';
      var mio = null;
      for (i = 0; i < placas.length; i++) if (placas[i].mia && (!mio || placas[i].since < mio.since)) mio = placas[i];
      if (mio) {
        var n = nivelPatina(S.city.height, mio.since), dias = Math.floor(Math.max(0, S.city.height - mio.since) / BLOQUES_DIA);
        h += '<li>' + esc(n < PATINA_NIVELES ? fmt(t('Tu edificio envejece con los bloques: pátina {n}/{max}; el siguiente nivel, dentro de {d} días de cadena.'), { n: n, max: PATINA_NIVELES, d: (n + 1) * (n + 1) - dias })
          : fmt(t('Tu edificio envejece con los bloques: pátina {n}/{max}, la más alta.'), { n: n, max: PATINA_NIVELES })) + '</li>';
      } else h += '<li>' + esc(t('Cada edificio envejece con los bloques: su pátina avanza el día 1, 4, 9… de cadena desde su fundación, hasta el día 144.')) + '</li>';
      return h + '</ul>';
    }
    function pintaGuia() {
      if (!guia) return;
      var n = hechos(), h = '<button class="mem-cerrar" data-mem="cerrar" title="' + esc(t('Cerrar')) + '">✕</button>';
      h += '<h3>📖 ' + esc(t('Primeros pasos')) + '</h3><div style="font-size:12px;color:#b9c3d6">' + n + ' / ' + PASOS.length + ' ' + esc(t('hechos')) + '</div>';
      h += '<div class="mem-prog"><i style="width:' + Math.round(100 * n / PASOS.length) + '%"></i></div>';
      for (var i = 0; i < PASOS.length; i++) {
        var P = PASOS[i], ok = !!progreso.h[P.id];
        h += '<div class="mem-paso' + (ok ? ' hecho' : '') + '"><label><input type="checkbox" data-mem-paso="' + P.id + '"' + (ok ? ' checked' : '') + '> ' + (i + 1) + '. ' + esc(t(P.titulo)) + '</label>';
        h += P.id === 'fechas' ? '<div class="mem-fechas" style="margin-left:24px;font-size:12.5px;color:#b9c3d6">' + fechas() + '</div>' : '<p>' + esc(t(P.texto)) + '</p>';
        if (P.botones && !ok) {
          h += '<div class="mem-bt">';
          for (var b = 0; b < P.botones.length; b++) h += '<button data-mem-bt="' + i + ':' + b + '">' + esc(t(P.botones[b][0])) + '</button>';
          h += '</div>';
        }
        h += '</div>';
      }
      h += '<div class="mem-manana">' + manana() + '</div>';
      h += '<div class="mem-aviso">⚠️ ' + esc(t('Simulación en una red de pruebas: RAMI no tiene valor monetario, no se vende y no es una inversión.')) + '</div>';
      guia.innerHTML = h;
    }
    function pintaBarra() {
      if (!barra) return;
      var nEnc = 0; for (var i = 0; i < lista.length; i++) nEnc += lista[i].faltan.length;
      btnEnc.textContent = '📋 ' + t('Encargos') + ' (' + nEnc + ')';
      btnEnc.className = verEncargos ? 'on' : '';
      btnGuia.textContent = '📖 ' + t('Primeros pasos') + ' ' + hechos() + '/' + PASOS.length;
      btnGuia.className = guia && guia.className.indexOf(' on') >= 0 ? 'on' : (resaltar ? 'nuevo' : '');
    }
    function oye(el, ev, fn, op) { el.addEventListener(ev, fn, op || false); oyentes.push([el, ev, fn, op || false]); }

    function montaUI() {
      if (!raiz || !global.document) return;
      if (!document.getElementById('mem-estilo')) { estilo = document.createElement('style'); estilo.id = 'mem-estilo'; estilo.textContent = CSS; document.head.appendChild(estilo); }
      barra = document.createElement('div'); barra.className = 'mem-barra';
      btnEnc = document.createElement('button'); btnEnc.type = 'button'; btnEnc.title = t('Lo que la ciudad importa, por distrito');
      btnGuia = document.createElement('button'); btnGuia.type = 'button';
      barra.appendChild(btnEnc); barra.appendChild(btnGuia); raiz.appendChild(barra);
      guia = document.createElement('div'); guia.className = 'mem-guia'; raiz.appendChild(guia);
      oye(btnEnc, 'click', function () {
        verEncargos = !verEncargos; guardaLocal(ENC_CLAVE, verEncargos ? '1' : '0');
        if (encLabels) encLabels.mesh.visible = verEncargos && encLabels.items.length > 0;
        pintaBarra();
      });
      oye(btnGuia, 'click', function () { abreGuia(guia.className.indexOf(' on') < 0); });
      oye(guia, 'click', function (ev) {
        var el = ev.target;
        if (el.getAttribute('data-mem') === 'cerrar') { abreGuia(false); return; }
        var bt = el.getAttribute('data-mem-bt');
        if (bt) { var ij = bt.split(':'), P = PASOS[ij[0] | 0]; if (P && P.botones[ij[1] | 0]) P.botones[ij[1] | 0][1](); }
      });
      oye(guia, 'change', function (ev) { var id = ev.target.getAttribute('data-mem-paso'); if (id) marca(id, ev.target.checked); });
      // Las teclas de la guía no mueven al jugador.
      oye(guia, 'keydown', function (ev) { ev.stopPropagation(); });
      // «Mirar la ciudad»: un arrastre o la rueda sobre el lienzo, en órbita.
      var abajo = null;
      oye(ctx.canvas, 'pointerdown', function (ev) { abajo = { x: ev.clientX, y: ev.clientY }; });
      oye(ctx.canvas, 'pointermove', function (ev) { if (abajo && S.mode === 'orbit' && Math.abs(ev.clientX - abajo.x) + Math.abs(ev.clientY - abajo.y) > 40) marca('mirar', true); });
      oye(ctx.canvas, 'pointerup', function () { abajo = null; });
      oye(ctx.canvas, 'wheel', function () { if (S.mode === 'orbit') marca('mirar', true); }, { passive: true });
      // Se abre sola la primera vez solo si deja ciudad a la vista: en un visor
      // de menos de 760 px taparía más de un tercio (la placa, a pie). Entonces
      // el botón 📖 se resalta hasta que se abre una vez.
      var nueva = !progreso.c && !progreso.visto && hechos() < PASOS.length;
      var ancho = raiz.clientWidth || 0;
      guia.className = 'mem-guia' + (!progreso.c && hechos() < PASOS.length && (progreso.visto || ancho >= 760) ? ' on' : '');
      resaltar = nueva && guia.className.indexOf(' on') < 0;
      if (guia.className.indexOf(' on') >= 0) { progreso.visto = 1; guarda(); pintaGuia(); }
      pintaBarra();
    }

    /** Solo las partes de la guía abierta que cambian solas (fechas, cuenta atrás, hora, encargos). */
    function refrescaGuia() {
      if (!guia || guia.className.indexOf(' on') < 0) return;
      var f = guia.querySelector('.mem-fechas'), m = guia.querySelector('.mem-manana');
      if (f) f.innerHTML = fechas();
      if (m) m.innerHTML = manana();
    }
    /**
     * Lo que usan las placas y los encargos de la vista de la ciudad: las
     * parcelas (sitio, sector, fundación, nombres, dueño), los huecos, los
     * distritos y quién soy. La altura y la cuenta atrás no entran.
     */
    var firmaVista = '';
    function firmaCiudad(d) {
      var dd = d && d.datos ? d.datos : d;
      if (!dd) return '';
      var ps = dd.parcels || [], out = [!!S.cellH, dd.me || '', JSON.stringify(dd.huecos || []), (dd.districts || []).length], i, p;
      for (i = 0; i < (dd.districts || []).length; i++) out.push(dd.districts[i].id + '=' + dd.districts[i].nombre + '=' + dd.districts[i].precio);
      for (i = 0; i < ps.length; i++) { p = ps[i]; out.push(p.x + ',' + p.y + ',' + p.kind + ',' + p.since + ',' + (p.pending ? 1 : 0) + ',' + p.distrito + ',' + (p.owner || '') + ',' + (p.name || '') + ',' + (p.handle || '')); }
      return out.join('|');
    }
    /** Cada segundo: la cuenta atrás de la guía abierta y si el módulo «umbral» dice que estás dentro. */
    function cadaSegundo() {
      try {
        var u = ctx.handle && ctx.handle.ext && ctx.handle.ext.umbral;
        if (u && typeof u.estado === 'function') { var st = u.estado(); if (st && st.dentro) marca('entrar', true); }
      } catch (eU) { /* el otro módulo manda; aquí solo se mira */ }
      refrescaGuia();
    }

    creaMallaPlacas();
    montaUI();

    return {
      listo: function () { if (S.city) { firmaVista = firmaCiudad(S.city); calculaPlacas(S.city); ponEncargos(S.city); } },
      // Antes de Dubái /api/city cambia en cada sondeo (la cuenta atrás), así que
      // este gancho llega cada ~5 s: se rehace solo lo que dependa de algo que
      // cambió, y de la guía abierta solo sus partes vivas (repintarla entera se
      // comería un clic o el foco de una casilla).
      ciudad: function (d) {
        var firma = firmaCiudad(d);
        if (firma !== firmaVista) { firmaVista = firma; calculaPlacas(d); ponEncargos(d); }
        refrescaGuia();
      },
      cuadro: function (dt) {
        actualizaPlacas(dt || 0);
        // Con el reloj de pared y no con dt: el núcleo recorta dt y, con un
        // dibujo lento (0,2–2 cuadros por segundo por software), «cada segundo»
        // en tiempo simulado tardaría medio minuto de verdad.
        var ya = Date.now();
        if (ya - reloj >= 1000) { reloj = ya; cadaSegundo(); }
      },
      modo: function (m) { if (m === 'walk') marca('a_pie', true); },
      estadisticas: function (o) {
        var activas = 0; for (var i = 0; i < huecos.length; i++) if (huecos[i].clave) activas++;
        // etiquetasEncargos: las encendidas; …Visibles: las que pasan el recorte con los rótulos del núcleo.
        var pasan = 0;
        if (encLabels && encLabels.mesh.visible && encLabels.lvis) for (i = 0; i < encLabels.items.length; i++) if (encLabels.lvis[i * 4]) pasan++;
        o.memoria = { placas: placas.length, placasVisibles: activas, triangulosPlacas: activas ? HUECOS_PLACA * IPP / 3 : 0, encargos: lista.length,
          etiquetasEncargos: encLabels && encLabels.mesh.visible ? encLabels.items.length : 0, etiquetasEncargosVisibles: pasan };
      },
      soltar: function () {
        for (var i = 0; i < oyentes.length; i++) oyentes[i][0].removeEventListener(oyentes[i][1], oyentes[i][2], oyentes[i][3]);
        oyentes = [];
        if (barra && barra.parentNode) barra.parentNode.removeChild(barra);
        if (guia && guia.parentNode) guia.parentNode.removeChild(guia);
        if (encLabels) encLabels.dispose();
        if (placaTex) placaTex.dispose();
        if (ctx.servicios.patina === patina) delete ctx.servicios.patina;
      },
      publico: {
        version: 1,
        nivelPatina: nivelPatina, patina: patina,
        /** Los encargos por distrito de la ciudad actual. */
        encargos: function () { return lista; },
        /** Placas calculadas y las que tienen hueco ahora (pruebas). */
        placas: function () { return { total: placas.length, todas: placas.map(function (p) { return { x: p.x, y: p.y, since: p.since, centro: p.centro.toArray(), normal: p.nor.toArray() }; }), visibles: huecos.filter(function (h) { return !!h.clave; }).map(function (h) { return { x: h.placa.x, y: h.placa.y, since: h.placa.since, nombre: h.placa.nombre, centro: h.placa.centro.toArray(), normal: h.placa.nor.toArray() }; }) }; },
        mostrarEncargos: function (v) { verEncargos = !!v; if (encLabels) encLabels.mesh.visible = verEncargos && encLabels.items.length > 0; pintaBarra(); },
        /** El panel cuenta lo que el visor no sabe: si hay perfil y cuánto saldo. */
        jugador: function (info) {
          info = info || {};
          jugador.perfil = !!info.perfil; jugador.saldo = Number(info.saldo) || 0;
          if (jugador.perfil) marca('nombre', true);
          if (jugador.saldo > 0) marca('rami', true);
        },
        guia: {
          abrir: function () { abreGuia(true); }, cerrar: function () { abreGuia(false); },
          marcar: marca, pasos: function () { return PASOS.map(function (p) { return { id: p.id, hecho: !!progreso.h[p.id] }; }); },
          abierta: function () { return !!(guia && guia.className.indexOf(' on') >= 0); }
        }
      }
    };
  });
})(typeof window !== 'undefined' ? window : this);
