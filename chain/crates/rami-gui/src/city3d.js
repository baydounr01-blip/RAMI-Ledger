/*
 * city3d.js — Cliente 3D de «Dubái RAMI» (metaverso de pruebas, sin valor
 * monetario) para el monedero de escritorio RAMI-Chain.
 *
 * Script ES5 sin módulos ni paso de compilación. Requiere el global THREE
 * (three.min.js r150) cargado ANTES de este fichero. No usa ninguna otra
 * dependencia y solo accede a la red para leer las dos URL geográficas que
 * recibe en `opts` (heightUrl y metaUrl): todo lo demás viene empaquetado.
 *
 * API pública: window.RamiCity3D.mount(container, opts) -> handle
 *   handle.setCity(city) / select(x,y|null) / flyTo(x,y) / flyToCity() /
 *   flyToSkyline() [portada: el skyline del centro] / flyToIsland() [vista
 *   general de Dubái] / flyToLandmark(id) / landmarks() /
 *   setMode('orbit'|'walk') / mode() / setQuality('baja'|'media'|'alta'|'ultra') /
 *   setTimeOfDay(horas|null) / setPresence(lista) / myPose() /
 *   resize() / setVisible(bool) / dispose() / xrSupported() / enterVR() /
 *   stats() / bench(opts) [mide la fluidez en cuatro vistas fijas] / gpu() /
 *   latLonToCell(lat,lon) / cellLatLon(x,y) / cellWorld(x,y) /
 *   cellInfo(x,y) / project(x,y) / heightAt(lat,lon) / ready (Promise)
 *
 * Arquitectura (de abajo arriba):
 *   1. Utilidades: hash FNV-1a, inflate (zlib) propio, decodificador PNG de 16
 *      bits, proyección Web-Mercator (contrato de datos geo), rampa de color
 *      del desierto, generador congruencial para variaciones estables.
 *   2. Terreno: malla fina + malla gruesa (LOD), colores por vértice, mar
 *      turquesa animado (shader), cúpula de cielo con día y noche, niebla
 *      (calima), carreteras y etiquetas en atlas de texto.
 *   3. Dubái: hitos icónicos procedurales (Burj Khalifa, Burj Al Arab, Museo
 *      del Futuro, Dubai Frame, Ain Dubai, Atlantis, Cayan, Emirates Towers,
 *      Palm…) en UNA geometría con ventanas que se encienden de noche;
 *      skylines por barrio y edificios de las parcelas deducidos de la posición
 *      —planta, fachada, coronación y portal— en una malla por tesela; tráfico ambiente por las vías;
 *      la cuadrícula de parcelas (64×64, drapeada) con un edificio por sector,
 *      coches de los concesionarios, carteles de venta y avatares de otros
 *      visitantes (presencia efímera de la red).
 *   4. Cámaras: orbital, a pie (primera persona) y VR (WebXR, mandos, factor
 *      de framebuffer alto para gafas 4K); calidad configurable; bucle.
 *
 * Convenciones: unidades del mundo en metros; X crece hacia el este,
 * Z hacia el sur, Y es la altura. El nivel del mar es Y = 0.
 *
 * Anclaje de la cuadrícula: `grid.anchor` del JSON es la esquina NOROESTE de
 * la celda (0,0); x crece hacia el este de la cuadrícula e y hacia su sur;
 * `rotationDeg` gira la cuadrícula (horario visto desde arriba) para que el
 * eje x siga la costa. lat/lon <-> celda usan la aproximación equirectangular
 * compartida con el panel 2D; Mercator solo interviene sobre el mapa de alturas.
 */
(function (global) {
  // v0.10.0 — canal de color físico: los colores sRGB se convierten a lineal al
  // entrar, la luz se calcula en lineal y el renderer aplica ACES + sRGB al salir.
  if (global.THREE && global.THREE.ColorManagement) { if ('enabled' in global.THREE.ColorManagement) global.THREE.ColorManagement.enabled = true; else global.THREE.ColorManagement.legacyMode = false; }
  function lin1(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lin3(c) { return [lin1(c[0]), lin1(c[1]), lin1(c[2])]; }
  'use strict';
  // ---------------------------------------------------------------------
  // 1. UTILIDADES
  // ---------------------------------------------------------------------

  /** Hash FNV-1a de 32 bits de una cadena (para detectar cambios en setCity). */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ':' + str.length;
  }

  /** Hash numérico determinista (para variaciones "aleatorias" estables). */
  function hash2(a, b) {
    var h = (a * 374761393 + b * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** Generador congruencial (semilla entera): variaciones estables por barrio. */
  /**
   * GENOTIPO — la semilla entera de una parcela, y el contrato que separa dos
   * capas que no se pueden mezclar:
   *
   *   morfología  lo que NO cambia nunca: la posición en la rejilla y el
   *               terreno. De aquí sale la FORMA del edificio. Si dependiera
   *               del dueño, una torre entera se reharía cada vez que alguien
   *               vende un piso.
   *   ropaje      lo que cambia con la cadena: dueño, antigüedad, activos. De
   *               aquí salen el rótulo, el color y las luces encendidas.
   *
   * Las dos son enteras (`Math.imul`, `|0`, `>>>0`), así que dan el mismo
   * número en cualquier máquina y cualquier navegador: dos nodos que sigan la
   * misma rama deducen exactamente la misma ciudad. La malla en metros que sale
   * de ellas es coma flotante y puede diferir en el último bit entre dos
   * tarjetas gráficas; da igual, porque es pintura y no entra en consenso.
   */
  function semillaMorfologia(x, y, canal) {
    var h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(canal | 0, 0x9e3779b9)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x2545f491);
    return (h ^ (h >>> 13)) >>> 0;
  }
  /** La semilla entera llevada a [0,1) para usarla como medida. */
  function real01(semilla) { return (semilla >>> 0) / 4294967296; }
  /** Ropaje: la misma parcela con otro dueño da otro número, y debe darlo. */
  function semillaRopaje(x, y, dueno, desde) {
    var h = semillaMorfologia(x, y) | 0, i;
    if (dueno) for (i = 0; i < dueno.length; i++) h = Math.imul(h ^ dueno.charCodeAt(i), 0x01000193) | 0;
    h = Math.imul(h ^ ((desde | 0) + 0x9e3779b9), 0x85ebca6b);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function lcg(seed) {
    var s = (seed >>> 0) || 1;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  // ---- Inflate (RFC 1950/1951) ------------------------------------------
  // Implementación propia y compacta (estilo "tinf"): respaldo cuando el
  // navegador no ofrece DecompressionStream. Descomprime el flujo zlib de los
  // trozos IDAT de un PNG.
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function buildTree(lengths, n) {
    var counts = new Uint16Array(16), symbols = new Uint16Array(n), offs = new Uint16Array(16), i, sum;
    for (i = 0; i < n; i++) counts[lengths[i]]++;
    counts[0] = 0;
    for (sum = 0, i = 0; i < 16; i++) { offs[i] = sum; sum += counts[i]; }
    for (i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
    return { counts: counts, symbols: symbols };
  }

  function inflate(src, expected) {
    var pos = 0, bitBuf = 0, bitCnt = 0;
    var out = new Uint8Array(expected > 0 ? expected : Math.max(1024, src.length * 4)), outLen = 0;
    function grow(need) {
      if (outLen + need <= out.length) return;
      var n = new Uint8Array(Math.max(out.length * 2, outLen + need));
      n.set(out.subarray(0, outLen)); out = n;
    }
    function bit() {
      if (bitCnt === 0) { bitBuf = src[pos++]; bitCnt = 8; }
      var b = bitBuf & 1; bitBuf >>>= 1; bitCnt--; return b;
    }
    function bits(n) { var v = 0; for (var i = 0; i < n; i++) v |= bit() << i; return v; }
    function decodeSym(tree) {
      var sum = 0, cur = 0, len = 0;
      do { cur = 2 * cur + bit(); len++; sum += tree.counts[len]; cur -= tree.counts[len]; } while (cur >= 0);
      return tree.symbols[sum + cur];
    }
    // Cabecera zlib (CMF/FLG)
    if ((src[0] & 0x0f) !== 8) throw new Error('zlib: método desconocido');
    pos = 2;
    // Árboles fijos
    var fl = new Uint8Array(288), i;
    for (i = 0; i < 144; i++) fl[i] = 8;
    for (; i < 256; i++) fl[i] = 9;
    for (; i < 280; i++) fl[i] = 7;
    for (; i < 288; i++) fl[i] = 8;
    var fixedLit = buildTree(fl, 288);
    var fd = new Uint8Array(30); for (i = 0; i < 30; i++) fd[i] = 5;
    var fixedDist = buildTree(fd, 30);

    var final;
    do {
      final = bit();
      var type = bits(2);
      if (type === 0) { // bloque almacenado
        bitBuf = 0; bitCnt = 0;
        var len = src[pos] | (src[pos + 1] << 8); pos += 4;
        grow(len); out.set(src.subarray(pos, pos + len), outLen); outLen += len; pos += len;
      } else {
        var lit, dist;
        if (type === 1) { lit = fixedLit; dist = fixedDist; }
        else if (type === 2) {
          var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          var cl = new Uint8Array(19);
          for (i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
          var clTree = buildTree(cl, 19);
          var lens = new Uint8Array(hlit + hdist), k = 0;
          while (k < hlit + hdist) {
            var sym = decodeSym(clTree), rep, prev;
            if (sym < 16) lens[k++] = sym;
            else if (sym === 16) { prev = lens[k - 1]; rep = 3 + bits(2); while (rep--) lens[k++] = prev; }
            else if (sym === 17) { rep = 3 + bits(3); while (rep--) lens[k++] = 0; }
            else { rep = 11 + bits(7); while (rep--) lens[k++] = 0; }
          }
          lit = buildTree(lens.subarray(0, hlit), hlit);
          dist = buildTree(lens.subarray(hlit), hdist);
        } else throw new Error('zlib: tipo de bloque inválido');
        for (;;) {
          var s = decodeSym(lit);
          if (s === 256) break;
          if (s < 256) { grow(1); out[outLen++] = s; }
          else {
            s -= 257;
            var l = LEN_BASE[s] + bits(LEN_BITS[s]);
            var ds = decodeSym(dist);
            var d = DIST_BASE[ds] + bits(DIST_BITS[ds]);
            grow(l);
            var from = outLen - d;
            for (i = 0; i < l; i++) out[outLen++] = out[from + i];
          }
        }
      }
    } while (!final);
    return out.subarray(0, outLen);
  }

  /** Inflate nativo (DecompressionStream 'deflate' = formato zlib). Devuelve Promise<Uint8Array>. */
  function inflateStream(z) {
    return new Promise(function (resolve, reject) {
      try {
        var ds = new DecompressionStream('deflate');
        var writer = ds.writable.getWriter();
        writer.write(z).then(null, reject);
        writer.close().then(null, reject);
        var reader = ds.readable.getReader(), chunks = [], total = 0;
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              var out = new Uint8Array(total), o = 0;
              for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
              resolve(out); return null;
            }
            chunks.push(r.value); total += r.value.length;
            return pump();
          });
        }
        pump().then(null, reject);
      } catch (e) { reject(e); }
    });
  }

  // ---- Decodificador PNG (escala de grises 8/16 bits, sin entrelazado) ----
  /** Lee los trozos del PNG: {width, height, depth, z (zlib concatenado), stride, bpp}. */
  function parsePng(buf) {
    var u8 = new Uint8Array(buf);
    var sig = [137, 80, 78, 71, 13, 10, 26, 10], i;
    for (i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error('PNG: firma inválida');
    var dv = new DataView(buf), p = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
    var idat = [], idatLen = 0;
    while (p < u8.length) {
      var len = dv.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      var body = p + 8;
      if (type === 'IHDR') {
        width = dv.getUint32(body); height = dv.getUint32(body + 4);
        depth = u8[body + 8]; ctype = u8[body + 9]; interlace = u8[body + 12];
      } else if (type === 'IDAT') { idat.push(u8.subarray(body, body + len)); idatLen += len; }
      else if (type === 'IEND') break;
      p = body + len + 4;
    }
    if (ctype !== 0 || (depth !== 8 && depth !== 16) || interlace !== 0) {
      throw new Error('PNG: se esperaba gris de 8/16 bits sin entrelazar (tipo ' + ctype + ', ' + depth + ' bits)');
    }
    var z = new Uint8Array(idatLen), off = 0;
    for (i = 0; i < idat.length; i++) { z.set(idat[i], off); off += idat[i].length; }
    var bpp = depth === 16 ? 2 : 1;
    return { width: width, height: height, depth: depth, z: z, bpp: bpp, stride: width * bpp };
  }
  /** Desfiltrado (None/Sub/Up/Average/Paeth) -> {width, height, depth, data}. */
  function unfilterPng(raw, info) {
    var width = info.width, height = info.height, depth = info.depth, bpp = info.bpp, stride = info.stride;
    if (raw.length < height * (stride + 1)) throw new Error('PNG: datos incompletos');
    var line = new Uint8Array(stride), prevLine = new Uint8Array(stride), y, x;
    var samples = depth === 16 ? new Uint16Array(width * height) : new Uint8Array(width * height);
    var rp = 0;
    for (y = 0; y < height; y++) {
      var f = raw[rp++];
      for (x = 0; x < stride; x++) {
        var v = raw[rp++], a = x >= bpp ? line[x - bpp] : 0, b = prevLine[x], c = x >= bpp ? prevLine[x - bpp] : 0;
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) {
          var pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        line[x] = v & 255;
      }
      var row = y * width;
      if (depth === 16) for (x = 0; x < width; x++) samples[row + x] = (line[x * 2] << 8) | line[x * 2 + 1];
      else for (x = 0; x < width; x++) samples[row + x] = line[x];
      var tmp = prevLine; prevLine = line; line = tmp;
    }
    return { width: width, height: height, depth: depth, data: samples };
  }
  /** Decodificación síncrona (inflate propio). Devuelve {width, height, depth, data} o lanza. */
  function decodePngGray(buf) {
    var info = parsePng(buf);
    return unfilterPng(inflate(info.z, info.height * (info.stride + 1)), info);
  }
  /** Decodificación asíncrona: DecompressionStream si existe, si no (o si falla) el inflate propio. -> Promise<{img, path}> */
  function decodePngGrayAsync(buf) {
    var info;
    try { info = parsePng(buf); } catch (e) { return Promise.reject(e); }
    function custom() { return { img: unfilterPng(inflate(info.z, info.height * (info.stride + 1)), info), path: 'custom' }; }
    if (typeof DecompressionStream === 'undefined') return Promise.resolve().then(custom);
    return inflateStream(info.z).then(function (raw) { return { img: unfilterPng(raw, info), path: 'stream' }; }, function () { return custom(); });
  }

  // ---- Carga por XHR --------------------------------------------------------
  function loadBinary(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response);
        else reject(new Error('HTTP ' + xhr.status + ' al cargar ' + url));
      };
      xhr.onerror = function () { reject(new Error('Error de red al cargar ' + url)); };
      xhr.send();
    });
  }
  function loadJson(url) {
    return loadBinary(url).then(function (buf) {
      var txt;
      if (typeof TextDecoder !== 'undefined') txt = new TextDecoder('utf-8').decode(new Uint8Array(buf));
      else { var u = new Uint8Array(buf), s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); txt = decodeURIComponent(escape(s)); }
      return JSON.parse(txt);
    });
  }

  // ---- Proyección Web-Mercator (contrato de datos geo) -----------------------
  var TILE_WORLD = 4096 * 256; // 2^12 teselas de 256 px
  /** lon -> píxel de tesela (zoom 12, antes de reducir). */
  function lonToTilePx(lon) { return (lon + 180) / 360 * TILE_WORLD; }
  function latToTilePx(lat) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * TILE_WORLD;
  }
  function tilePxToLon(px) { return px / TILE_WORLD * 360 - 180; }
  function tilePxToLat(py) { var n = Math.PI * (1 - 2 * py / TILE_WORLD); return Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180 / Math.PI; }
  /** Crea el "geo": mapeo lat/lon <-> píxel de salida <-> metros del mundo. */
  function makeGeo(meta) {
    var ds = meta.downsample || 1, ox = meta.origin_px.x, oy = meta.origin_px.y, mpp = meta.meters_per_pixel;
    return {
      meta: meta,
      mpp: mpp,
      width: meta.width, height: meta.height,
      worldW: (meta.width - 1) * mpp, worldH: (meta.height - 1) * mpp,
      toPx: function (lat, lon) { return { x: (lonToTilePx(lon) - ox) / ds, y: (latToTilePx(lat) - oy) / ds }; },
      toWorld: function (lat, lon) { var p = this.toPx(lat, lon); return { x: p.x * mpp, z: p.y * mpp }; },
      toLatLon: function (wx, wz) { return { lat: tilePxToLat(wz / mpp * ds + oy), lon: tilePxToLon(wx / mpp * ds + ox) }; }
    };
  }

  // ---- Rampa de color del terreno --------------------------------------------
  // Paradas [altura en m, r, g, b]; interpolación lineal entre paradas.
  var RAMP = [
    [-4000, 0.02, 0.10, 0.22],  // fondo profundo (no se da en el Golfo)
    [-60, 0.05, 0.28, 0.42],    // mar
    [-12, 0.10, 0.55, 0.62],    // aguas someras turquesa
    [-1, 0.55, 0.85, 0.80],     // orilla
    [0, 0.93, 0.86, 0.66],      // arena de playa
    [3, 0.90, 0.80, 0.58],      // arena
    [12, 0.85, 0.72, 0.48],     // desierto
    [40, 0.80, 0.64, 0.40],     // dunas
    [120, 0.72, 0.56, 0.36],    // interior
    [300, 0.62, 0.50, 0.34],
    [5000, 0.58, 0.48, 0.34]
  ];
  var ROCK = [0.55, 0.45, 0.35];
  /** Color (0..1) para altura h, pendiente s (|grad|) y ruido n (-1..1). Escribe en out[o..o+2]. */
  function terrainColor(h, s, n, out, o) {
    var i = 0;
    while (i < RAMP.length - 2 && h > RAMP[i + 1][0]) i++;
    var a = RAMP[i], b = RAMP[i + 1], t = clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
    var r = lerp(a[1], b[1], t), g = lerp(a[2], b[2], t), bl = lerp(a[3], b[3], t);
    if (h > 0) { // laderas empinadas (raras en Dubái) -> roca
      var k = smoothstep((s - 0.35) / 0.55) * 0.85;
      r = lerp(r, ROCK[0], k); g = lerp(g, ROCK[1], k); bl = lerp(bl, ROCK[2], k);
    }
    var v = 1 + n * 0.06;
    out[o] = lin1(clamp(r * v, 0, 1)) * 255; out[o + 1] = lin1(clamp(g * v, 0, 1)) * 255; out[o + 2] = lin1(clamp(bl * v, 0, 1)) * 255;
  }

  // ---- Costa procedural de respaldo -------------------------------------
  // Se usa solo si el PNG (o el JSON) no se puede cargar: un litoral recto
  // con desierto detrás, para que la escena siga funcionando.
  var DEFAULT_META = {
    name: 'Dubái', attribution: 'procedural fallback', zoom: 12, downsample: 2, width: 512, height: 500,
    origin_px: { x: lonToTilePx(54.90), y: latToTilePx(25.40) },
    meters_per_pixel: 156543.03392 * Math.cos(25.1 * Math.PI / 180) / 4096 * 2 * (1020 / 512),
    offset: 1000, min_h: -60, max_h: 60,
    bbox: { west: 54.90, south: 24.78, east: 55.60, north: 25.40 },
    peak: { name: 'Dubái', lat: 25.0, lon: 55.4, h: 60 },
    grid: { anchor: { lat: 25.064, lon: 54.994 }, cellMeters: 650, rotationDeg: -48, size: 64 },
    towns: [
      { name: 'Dubái centro', lat: 25.197, lon: 55.274, kind: 'city' },
      { name: 'Deira', lat: 25.270, lon: 55.312, kind: 'city' },
      { name: 'Dubai Marina', lat: 25.080, lon: 55.140, kind: 'district' }
    ],
    landmarks: [], clusters: [], roads: []
  };
  function proceduralHeights(meta) {
    var w = meta.width, h = meta.height, geo = makeGeo(meta), data = new Uint16Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var ll = geo.toLatLon(x * meta.meters_per_pixel, y * meta.meters_per_pixel);
      // la costa corre SO-NE: tierra al sureste de la recta lat = 25.03 + 0.7*(lon-55.0)
      var d = (ll.lat - (25.03 + 0.7 * (ll.lon - 55.0))) * 111000;
      var alt = d > 0 ? -8 - d * 0.001 : Math.min(60, 3 - d * 0.0015);
      data[y * w + x] = clamp(Math.round(alt + meta.offset), 0, 65535);
    }
    return { width: w, height: h, depth: 16, data: data };
  }

  // ---- Campo de alturas (muestreo bilineal del mapa completo) ---------------
  function makeHeightField(img, offset, mpp) {
    var w = img.width, h = img.height, d = img.data, scale = img.depth === 16 ? 1 : 256;
    function at(ix, iy) {
      ix = ix < 0 ? 0 : (ix >= w ? w - 1 : ix); iy = iy < 0 ? 0 : (iy >= h ? h - 1 : iy);
      return d[iy * w + ix] * scale - offset;
    }
    /** Altura interpolada en coordenadas de píxel (fraccionarias). */
    function atPx(px, py) {
      var x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
      var a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), e = at(x0 + 1, y0 + 1);
      return lerp(lerp(a, b, fx), lerp(c, e, fx), fy);
    }
    return {
      width: w, height: h, at: at, atPx: atPx,
      atWorld: function (wx, wz) { return atPx(wx / mpp, wz / mpp); }
    };
  }

  // ---------------------------------------------------------------------
  // 2. TERRENO, MAR, CIELO, CARRETERAS Y ETIQUETAS
  // ---------------------------------------------------------------------

  /**
   * Construye una malla de terreno muestreando el campo de alturas con
   * `segs` segmentos en el eje mayor. Devuelve {mesh, grid, sx, sz, dx, dz, maxH}
   * donde `grid` son las alturas muestreadas (para consultar la superficie
   * visible exactamente, triángulo a triángulo). El 2 % exterior del mapa se
   * funde con el color del fondo marino (bedH) para ocultar el borde del bbox.
   */
  /**
   * Tiñe de ciudad el suelo bajo los barrios construidos. El relieve viene de
   * datos de elevación, que no saben de asfalto: sin esto las torres se
   * levantaban sobre un desierto liso y el conjunto no leía como una ciudad.
   * Se hace una sola vez, sobre los colores por vértice ya calculados.
   */
  var URBANO = [108, 104, 99], URBANO_VERDE = [96, 116, 82];
  function urbanizarTerreno(tr, clusters, geo) {
    if (!clusters || !clusters.length) return;
    var col = tr.mesh.geometry.attributes.color.array, i, j, c, k;
    var cs = [];
    for (c = 0; c < clusters.length; c++) {
      var w = geo.toWorld(clusters[c].lat, clusters[c].lon);
      cs.push({ x: w.x, z: w.z, r: (clusters[c].radius_m || 600) * 1.6, verde: clusters[c].kind === 'villas' });
    }
    for (j = 0; j < tr.nz; j++) for (i = 0; i < tr.nx; i++) {
      k = j * tr.nx + i;
      if (tr.grid[k] <= 0.4) continue;                 // el agua no se asfalta
      var mx = 0, verde = 0;
      for (c = 0; c < cs.length; c++) {
        var dx = i * tr.dx - cs[c].x, dz = j * tr.dz - cs[c].z, d2 = dx * dx + dz * dz, rr = cs[c].r * cs[c].r;
        if (d2 >= rr) continue;
        // Meseta con borde suave: un barrio es asfalto de punta a punta, no un
        // degradado radial desde su centro.
        var f = clamp((1 - Math.sqrt(d2 / rr)) * 2.6, 0, 1);
        if (f > mx) { mx = f; verde = cs[c].verde ? 1 : 0; }
      }
      if (mx <= 0) continue;
      var t = Math.min(0.74, mx * 0.78) * (0.80 + 0.40 * hash2(i * 7 + 1, j * 5 + 3));
      var dst = verde ? URBANO_VERDE : URBANO;
      col[k * 3] = lerp(col[k * 3], dst[0], t);
      col[k * 3 + 1] = lerp(col[k * 3 + 1], dst[1], t);
      col[k * 3 + 2] = lerp(col[k * 3 + 2], dst[2], t);
    }
    tr.mesh.geometry.attributes.color.needsUpdate = true;
  }
  function buildTerrain(field, geo, segs, material, bedH) {
    var W = geo.worldW, H = geo.worldH;
    var sx = W >= H ? segs : Math.max(8, Math.round(segs * W / H));
    var sz = W >= H ? Math.max(8, Math.round(segs * H / W)) : segs;
    sx = Math.min(sx, field.width - 1); sz = Math.min(sz, field.height - 1);
    var nx = sx + 1, nz = sz + 1, dx = W / sx, dz = H / sz;
    var grid = new Float32Array(nx * nz), i, j, maxH = -1e9;
    for (j = 0; j < nz; j++) for (i = 0; i < nx; i++) {
      var hv = field.atPx(i * dx / geo.mpp, j * dz / geo.mpp);
      grid[j * nx + i] = hv; if (hv > maxH) maxH = hv;
    }
    var bed = new Uint8Array(3); terrainColor(bedH, 0, 0, bed, 0);
    var pos = new Float32Array(nx * nz * 3), col = new Uint8Array(nx * nz * 3);
    for (j = 0; j < nz; j++) for (i = 0; i < nx; i++) {
      var k = j * nx + i, h = grid[k];
      pos[k * 3] = i * dx; pos[k * 3 + 1] = h; pos[k * 3 + 2] = j * dz;
      var hl = grid[j * nx + (i > 0 ? i - 1 : i)], hr = grid[j * nx + (i < sx ? i + 1 : i)];
      var hu = grid[(j > 0 ? j - 1 : j) * nx + i], hd = grid[(j < sz ? j + 1 : j) * nx + i];
      var gx = (hr - hl) / (2 * dx), gz = (hd - hu) / (2 * dz);
      terrainColor(h, Math.sqrt(gx * gx + gz * gz), hash2(i, j) * 2 - 1, col, k * 3);
      var e = Math.min(i / sx, 1 - i / sx, j / sz, 1 - j / sz); // distancia normalizada al borde
      if (e < 0.02) {
        var te = 1 - e / 0.02;
        col[k * 3] = lerp(col[k * 3], bed[0], te); col[k * 3 + 1] = lerp(col[k * 3 + 1], bed[1], te); col[k * 3 + 2] = lerp(col[k * 3 + 2], bed[2], te);
      }
    }
    var idx = new Uint32Array(sx * sz * 6), q = 0;
    for (j = 0; j < sz; j++) for (i = 0; i < sx; i++) {
      var a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; // normal hacia +Y
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    var mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    return { mesh: mesh, grid: grid, nx: nx, nz: nz, sx: sx, sz: sz, dx: dx, dz: dz, maxH: maxH };
  }

  /** Altura exacta de la superficie de la malla (usa la triangulación real). */
  function meshSurfaceHeight(t, wx, wz) {
    var fx = clamp(wx / t.dx, 0, t.sx - 1e-6), fz = clamp(wz / t.dz, 0, t.sz - 1e-6);
    var i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, nx = t.nx, g = t.grid;
    var ha = g[j * nx + i], hb = g[j * nx + i + 1], hc = g[(j + 1) * nx + i], hd = g[(j + 1) * nx + i + 1];
    if (u + v <= 1) return ha + (hb - ha) * u + (hc - ha) * v;
    return hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
  }

  /** Material del mar: ondas animadas en el fragment shader + fresnel + niebla. */
  /**
   * Mar (v0.10.0): olas de varias frecuencias, reflejo del cielo real (mapa
   * cúbico) con Fresnel, brillo del sol, color por profundidad leída del
   * relieve (turquesa en la orilla, azul en alta mar) y espuma en la costa.
   */
  function makeSeaMaterial(sunDir) {
    var uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uSun: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(0xfff1d6) },
      uDeep: { value: new THREE.Color(0x0b3d63) },
      uShallow: { value: new THREE.Color(0x2ab8b5) },
      uNight: { value: 0 },
      uEnv: { value: null },
      uDepth: { value: null },
      uWorld: { value: new THREE.Vector2(1, 1) }
    }]);
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      transparent: true, depthWrite: false, fog: true,
      vertexShader: [
        '#include <common>',
        '#include <fog_pars_vertex>',
        '#include <logdepthbuf_pars_vertex>',
        'varying vec3 vWorld;',
        'void main(){',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vWorld = wp.xyz;',
        '  vec4 mvPosition = viewMatrix * wp;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '  #include <logdepthbuf_vertex>',
        '  #include <fog_vertex>',
        '}'].join('\n'),
      fragmentShader: [
        '#include <common>',
        '#include <fog_pars_fragment>',
        '#include <logdepthbuf_pars_fragment>',
        'uniform float uTime, uNight; uniform vec3 uSun, uSunColor, uDeep, uShallow; uniform samplerCube uEnv; uniform sampler2D uDepth; uniform vec2 uWorld;',
        'varying vec3 vWorld;',
        'void main(){',
        '  #include <logdepthbuf_fragment>',
        '  float t = uTime;',
        '  vec2 p = vWorld.xz;',
        '  vec2 uv = p / uWorld;',
        '  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);',
        '  float d = mix(70.0, texture2D(uDepth, uv).r * 80.0, inside);',
        '  float att = 1.0 / (1.0 + length(cameraPosition - vWorld) / 9000.0);',
        '  vec2 d1 = vec2(0.020, 0.011), d2 = vec2(-0.013, 0.023), d3 = vec2(0.061, -0.047), d4 = vec2(0.083, 0.071);',
        '  float c1 = cos(dot(p, d1) + t * 1.10), c2 = cos(dot(p, d2) - t * 0.90), c3 = cos(dot(p, d3) + t * 1.90), c4 = cos(dot(p, d4) - t * 1.50);',
        '  vec2 g = (d1 * c1 * 2.6 + d2 * c2 * 2.2 + d3 * c3 * 0.55 + d4 * c4 * 0.35) * att;',
        '  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));',
        '  vec3 v = normalize(cameraPosition - vWorld);',
        '  float fres = 0.025 + 0.975 * pow(1.0 - max(dot(n, v), 0.0), 5.0);',
        '  vec3 r = reflect(-v, n); r.y = abs(r.y) + 0.02;',
        '  vec3 sky = textureCube(uEnv, r, 1.5).rgb;',
        '  float depthK = 1.0 - exp(-d / 14.0);',
        '  vec3 water = mix(uShallow, uDeep, depthK) * (0.45 + 0.55 * max(dot(n, uSun), 0.0)) * (1.0 - uNight * 0.85);',
        '  vec3 col = mix(water, sky, fres);',
        '  vec3 h = normalize(uSun + v);',
        '  float ndh = max(dot(n, h), 0.0);',
        '  float spec = pow(ndh, 400.0) * 3.0 + pow(ndh, 48.0) * 0.12;',
        '  col += uSunColor * spec * (1.0 - uNight) * max(uSun.y, 0.0);',
        '  float orilla = (1.0 - smoothstep(0.0, 1.6, d)) * inside;',
        '  float foam = orilla * (0.45 + 0.55 * smoothstep(-0.2, 0.8, c3 * 0.6 + c4 * 0.4));',
        '  col = mix(col, vec3(0.9, 0.93, 0.95) * (1.0 - uNight * 0.8), foam * 0.5);',
        '  float alpha = mix(0.5, 0.92, depthK);',
        '  gl_FragColor = vec4(col, alpha);',
        '  #include <tonemapping_fragment>',
        '  #include <encodings_fragment>',
        '  #include <fog_fragment>',
        '}'].join('\n')
    });
    return mat;
  }

  // ---- Cielo por dispersión atmosférica (Rayleigh + Mie, v0.10.0) -------------
  // Un solo modelo físico da el azul del mediodía, el arrebol del atardecer, la
  // calima de Dubái (turbidez alta) y el disco solar; de noche se apaga solo.
  // Las mismas fórmulas, en JS (`skyRadiance`), dan el color de la niebla y de
  // la luz ambiente para que suelo, edificios y horizonte casen sin costura.
  var SKY_VS = [
    'uniform vec3 sunPosition; uniform float rayleigh, turbidity, mieCoefficient;',
    'varying vec3 vWorldPosition, vSunDirection, vBetaR, vBetaM; varying float vSunfade, vSunE;',
    'const vec3 up = vec3(0.0, 1.0, 0.0);',
    'const float e = 2.71828182845904523536028747135266249775724709369995957;',
    'const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);',
    'const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);',
    'const float cutoffAngle = 1.6110731556870734; const float steepness = 1.5; const float EE = 1000.0;',
    'float sunIntensity(float zenithAngleCos){ zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0); return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness))); }',
    'vec3 totalMie(float T){ float c = (0.2 * T) * 10E-18; return 0.434 * c * MieConst; }',
    'void main(){',
    '  vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorldPosition = worldPosition.xyz;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '  vSunDirection = normalize(sunPosition); vSunE = sunIntensity(dot(vSunDirection, up));',
    '  vSunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);',
    '  float rayleighCoefficient = rayleigh - (1.0 * (1.0 - vSunfade));',
    '  vBetaR = totalRayleigh * rayleighCoefficient; vBetaM = totalMie(turbidity) * mieCoefficient;',
    '}'].join('\n');
  var SKY_FS = [
    'varying vec3 vWorldPosition, vSunDirection, vBetaR, vBetaM; varying float vSunfade, vSunE;',
    'uniform float mieDirectionalG, uNight, uGain;',
    'const vec3 up = vec3(0.0, 1.0, 0.0);',
    'const float pi = 3.141592653589793238462643383279502884197169;',
    'const float rayleighZenithLength = 8.4E3; const float mieZenithLength = 1.25E3;',
    'const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;',
    'const float THREE_OVER_SIXTEENPI = 0.05968310365946075; const float ONE_OVER_FOURPI = 0.07957747154594767;',
    'float rayleighPhase(float cosTheta){ return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0)); }',
    'float hgPhase(float cosTheta, float g){ float g2 = pow(g, 2.0); float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5); return ONE_OVER_FOURPI * ((1.0 - g2) * inverse); }',
    'void main(){',
    '  vec3 direction = normalize(vWorldPosition - cameraPosition);',
    '  float zenithAngle = acos(max(0.0, dot(up, direction)));',
    '  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));',
    '  float sR = rayleighZenithLength * inverse; float sM = mieZenithLength * inverse;',
    '  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));',
    '  float cosTheta = dot(direction, vSunDirection);',
    '  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5); vec3 betaRTheta = vBetaR * rPhase;',
    '  float mPhase = hgPhase(cosTheta, mieDirectionalG); vec3 betaMTheta = vBetaM * mPhase;',
    '  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));',
    '  Lin *= mix(vec3(1.0), pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(1.0 / 2.0)), clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));',
    '  vec3 L0 = vec3(0.1) * Fex;',
    '  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);',
    '  L0 += (vSunE * 19000.0 * Fex) * sundisk;',
    '  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);',
    '  vec3 retColor = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade)))) * uGain;',
    '  retColor = mix(retColor, vec3(0.010, 0.014, 0.028) + retColor * 0.25, uNight);',
    '  gl_FragColor = vec4(retColor, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '}'].join('\n');
  var SKY_DEFAULTS = { turbidity: 7.0, rayleigh: 2.4, mieCoefficient: 0.006, mieDirectionalG: 0.86, gain: 0.85 };
  function makeSkyMaterial() {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        sunPosition: { value: new THREE.Vector3(0, 400000, 0) }, turbidity: { value: SKY_DEFAULTS.turbidity }, rayleigh: { value: SKY_DEFAULTS.rayleigh },
        mieCoefficient: { value: SKY_DEFAULTS.mieCoefficient }, mieDirectionalG: { value: SKY_DEFAULTS.mieDirectionalG }, uNight: { value: 0 }, uGain: { value: SKY_DEFAULTS.gain }
      },
      vertexShader: SKY_VS, fragmentShader: SKY_FS
    });
  }
  function makeSky(radius, material) {
    var m = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 20), material);
    m.frustumCulled = false; m.renderOrder = -1000;
    return m;
  }
  /** El mismo modelo de cielo en JS: radiancia lineal (r,g,b) en la dirección `dir` con el sol en `sun` (unitarios). */
  function skyRadiance(dir, sun, night) {
    var P = SKY_DEFAULTS;
    var up = sun.y, sunE = 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(clamp(up, -1, 1))) / 1.5)));
    var sunfade = 1 - clamp(1 - Math.exp(sun.y * 400000 / 450000), 0, 1);
    var rc = P.rayleigh - (1 - sunfade);
    var betaR = [5.804542996261093e-6 * rc, 1.3562911419845635e-5 * rc, 3.0265902468824876e-5 * rc];
    var mc = (0.2 * P.turbidity) * 10e-18 * 0.434 * P.mieCoefficient;
    var betaM = [1.8399918514433978e14 * mc, 2.7798023919660528e14 * mc, 4.0790479543861094e14 * mc];
    var zenith = Math.acos(Math.max(0, dir.y));
    var inverse = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180 / Math.PI), -1.253));
    var sR = 8.4e3 * inverse, sM = 1.25e3 * inverse;
    var cosTheta = dir.x * sun.x + dir.y * sun.y + dir.z * sun.z;
    var rPhase = 0.05968310365946075 * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
    var g = P.mieDirectionalG, g2 = g * g, mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5));
    var k = clamp(Math.pow(1 - up, 5), 0, 1), out = [0, 0, 0], i;
    for (i = 0; i < 3; i++) {
      var Fex = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
      var ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
      var Lin = Math.pow(sunE * ratio * (1 - Fex), 1.5);
      Lin *= lerp(1, Math.pow(sunE * ratio * Fex, 0.5), k);
      var L0 = 0.1 * Fex;
      var tex = (Lin + L0) * 0.04 + [0, 0.0003, 0.00075][i];
      var c = Math.pow(tex, 1 / (1.2 + 1.2 * sunfade)) * P.gain;
      out[i] = lerp(c, [0.010, 0.014, 0.028][i] + c * 0.25, night || 0);
    }
    return out;
  }
  /** Extinción atmosférica hacia el sol: color de la luz solar directa (lineal, 0..1). */
  function sunTransmittance(sun) {
    var P = SKY_DEFAULTS, sunfade = 1 - clamp(1 - Math.exp(sun.y * 400000 / 450000), 0, 1), rc = P.rayleigh - (1 - sunfade);
    var betaR = [5.804542996261093e-6 * rc, 1.3562911419845635e-5 * rc, 3.0265902468824876e-5 * rc];
    var mc = (0.2 * P.turbidity) * 10e-18 * 0.434 * P.mieCoefficient;
    var betaM = [1.8399918514433978e14 * mc, 2.7798023919660528e14 * mc, 4.0790479543861094e14 * mc];
    var zenith = Math.acos(clamp(sun.y, 0, 1));
    var inverse = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180 / Math.PI), -1.253));
    var sR = 8.4e3 * inverse, sM = 1.25e3 * inverse, out = [0, 0, 0], i;
    for (i = 0; i < 3; i++) out[i] = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
    return out;
  }
  /** ACES (la misma curva que aplica el renderer) + sRGB, para que la niebla, que se mezcla después del tono, case con el cielo. */
  function acesSRGB(c, exposure) {
    var v = [c[0] * exposure / 0.6, c[1] * exposure / 0.6, c[2] * exposure / 0.6];
    var a = [0.59719 * v[0] + 0.35458 * v[1] + 0.04823 * v[2], 0.07600 * v[0] + 0.90834 * v[1] + 0.01566 * v[2], 0.02840 * v[0] + 0.13383 * v[1] + 0.83777 * v[2]];
    var i, f = [0, 0, 0];
    for (i = 0; i < 3; i++) f[i] = (a[i] * (a[i] + 0.0245786) - 0.000090537) / (a[i] * (0.983729 * a[i] + 0.4329510) + 0.238081);
    var o = [1.60475 * f[0] - 0.53108 * f[1] - 0.07367 * f[2], -0.10208 * f[0] + 1.10813 * f[1] - 0.00605 * f[2], -0.00327 * f[0] - 0.07276 * f[1] + 1.07602 * f[2]];
    for (i = 0; i < 3; i++) { o[i] = clamp(o[i], 0, 1); o[i] = o[i] <= 0.0031308 ? o[i] * 12.92 : 1.055 * Math.pow(o[i], 1 / 2.4) - 0.055; }
    return o;
  }

  /** Estrellas: nube de puntos fija al cielo, visible solo de noche. */
  function makeStars(radius, n, seed) {
    var pos = new Float32Array(n * 3), rnd = lcg(seed || 7);
    for (var i = 0; i < n; i++) {
      var u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      var y = Math.abs(u); // solo hemisferio superior
      pos[i * 3] = r * Math.cos(a) * radius; pos[i * 3 + 1] = y * radius; pos[i * 3 + 2] = r * Math.sin(a) * radius;
    }
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var m = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    m.frustumCulled = false; m.renderOrder = -999;
    return m;
  }

  // ---- Material "drapeado" ---------------------------------------------------
  // Geometrías que siguen el relieve: cada vértice lleva su altura sobre la
  // malla fina (position.y) y sobre la gruesa (atributo hc); el uniforme
  // compartido uLod (0/1) elige una u otra según el LOD del terreno visible,
  // de modo que la capa nunca se hunde bajo el terreno dibujado.
  var DRAPE_VS = [
    '#include <common>',
    '#include <fog_pars_vertex>',
    '#include <logdepthbuf_pars_vertex>',
    'attribute float hc; uniform float uLod; uniform float uDrop;',
    '#ifdef CELL_COLOR', 'attribute vec4 cellColor; varying vec4 vColor;', '#endif',
    'void main(){',
    '  vec3 p = position; p.y = mix(position.y, hc, uLod) - uDrop;',
    '  #ifdef CELL_COLOR', '  vColor = cellColor;', '  #endif',
    '  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '  #include <fog_vertex>',
    '}'].join('\n');
  var DRAPE_FS = [
    '#include <fog_pars_fragment>',
    '#include <logdepthbuf_pars_fragment>',
    'uniform vec4 uColor; uniform float uNight;',
    '#ifdef CELL_COLOR', 'varying vec4 vColor;', '#endif',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec4 c = uColor;',
    '  #ifdef CELL_COLOR', '  c *= vColor;', '  #endif',
    '  c.rgb *= 1.0 - 0.75 * uNight; c.a *= 1.0 - 0.5 * uNight;',
    '  if (c.a < 0.004) discard;',
    '  gl_FragColor = c;',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '  #include <fog_fragment>',
    '}'].join('\n');
  var dropUniform = { value: 0 }, nightUniform = { value: 0 };
  function makeDrapeMaterial(lodUniform, color, alpha, cellColor) {
    var u = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    u.uLod = lodUniform; u.uDrop = dropUniform; u.uNight = nightUniform;
    var c = new THREE.Color(color);
    u.uColor = { value: new THREE.Vector4(c.r, c.g, c.b, alpha) };
    return new THREE.ShaderMaterial({
      uniforms: u, vertexShader: DRAPE_VS, fragmentShader: DRAPE_FS,
      defines: cellColor ? { CELL_COLOR: 1 } : {},
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide, forceSinglePass: true
    });
  }

  // ---- Etiquetas: atlas de texto en canvas + una malla por conjunto ------------
  // Cada etiqueta es un cuadrilátero anclado a un punto 3D cuyo tamaño se fija
  // en píxeles en el vertex shader (siempre legible, no depende de la
  // distancia). Todas las etiquetas del conjunto se dibujan en UNA llamada.
  // `lvis` (por vértice) lo rellena el rechazo de solapes en pantalla.
  var LABEL_VS = [
    '#include <common>',
    '#include <logdepthbuf_pars_vertex>',
    'attribute vec2 corner; attribute vec2 lsize; attribute float lmax; attribute float lvis;',
    'uniform vec2 uViewport; varying vec2 vUv; varying float vVis;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  float d = length(mv.xyz);',
    '  vec4 clip = projectionMatrix * mv;',
    '  vVis = (d < lmax && clip.w > 0.0) ? lvis : 0.0;',
    '  clip.xy += corner * lsize / uViewport * 2.0 * clip.w;',
    '  gl_Position = clip; vUv = uv;',
    '  #include <logdepthbuf_vertex>',
    '}'].join('\n');
  var LABEL_FS = [
    '#include <logdepthbuf_pars_fragment>',
    'uniform sampler2D uMap; varying vec2 vUv; varying float vVis;',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec4 c = texture2D(uMap, vUv); if (c.a * vVis < 0.03) discard; gl_FragColor = vec4(c.rgb, c.a * vVis);',
    '}'
  ].join('\n');

  function LabelSet(viewportUniform, depthTest) {
    this.viewport = viewportUniform;
    this.texture = null;
    this.items = [];
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uViewport: viewportUniform },
      vertexShader: LABEL_VS, fragmentShader: LABEL_FS,
      transparent: true, depthTest: !!depthTest, depthWrite: false
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 50;
    this.mesh.visible = false;
    this.lvis = null;
  }
  /**
   * items: [{x,y,z, text, color, size (px), maxDist, pin (bool), bold, priority}]
   * Reconstruye el atlas y la geometría (ordena por prioridad ascendente).
   */
  LabelSet.prototype.set = function (items) {
    items = items.slice().sort(function (a, b) { return (a.priority || 0) - (b.priority || 0); });
    var SS = 2; // sobre-muestreo del canvas para nitidez
    var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    var boxes = [], i, atlasW = 1024, x = 0, y = 0, rowH = 0;
    for (i = 0; i < items.length; i++) {
      var it = items[i], fs = (it.size || 13) * SS;
      ctx.font = (it.bold ? 'bold ' : '') + fs + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      var tw = Math.ceil(ctx.measureText(it.text).width) + 8 * SS, th = Math.ceil(fs * 1.35) + (it.pin ? 10 * SS : 4 * SS);
      if (tw > atlasW) tw = atlasW;
      if (x + tw > atlasW) { x = 0; y += rowH; rowH = 0; }
      boxes.push({ x: x, y: y, w: tw, h: th });
      x += tw; rowH = Math.max(rowH, th);
    }
    var atlasH = Math.max(4, y + rowH);
    canvas.width = atlasW; canvas.height = atlasH;
    ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, atlasW, atlasH);
    ctx.textBaseline = 'top';
    for (i = 0; i < items.length; i++) {
      var b = boxes[i], item = items[i], f = (item.size || 13) * SS;
      ctx.font = (item.bold ? 'bold ' : '') + f + 'px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      var cx = b.x + b.w / 2;
      // Halo oscuro para legibilidad sobre cualquier fondo
      ctx.lineWidth = 3 * SS; ctx.strokeStyle = 'rgba(10,16,24,0.85)'; ctx.lineJoin = 'round';
      ctx.strokeText(item.text, cx, b.y + 2 * SS);
      ctx.fillStyle = item.color || '#ffffff';
      ctx.fillText(item.text, cx, b.y + 2 * SS);
      if (item.pin) { // marcador circular en el punto anclado (borde inferior)
        ctx.beginPath(); ctx.arc(cx, b.y + b.h - 4 * SS, 3.2 * SS, 0, Math.PI * 2);
        ctx.fillStyle = item.color || '#ffffff'; ctx.fill();
        ctx.lineWidth = 1.2 * SS; ctx.strokeStyle = 'rgba(10,16,24,0.9)'; ctx.stroke();
      }
      item.pw = b.w / SS; item.ph = b.h / SS; // tamaño en píxeles (para el rechazo de solapes)
    }
    var n = items.length;
    var pos = new Float32Array(n * 12), corner = new Float32Array(n * 8), uv = new Float32Array(n * 8);
    var lsize = new Float32Array(n * 8), lmax = new Float32Array(n * 4), lvis = new Float32Array(n * 4), idx = new Uint16Array(n * 6);
    var CORNERS = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
    for (i = 0; i < n; i++) {
      var bb = boxes[i], itm = items[i];
      for (var c = 0; c < 4; c++) {
        var vi = i * 4 + c;
        pos[vi * 3] = itm.x; pos[vi * 3 + 1] = itm.y; pos[vi * 3 + 2] = itm.z;
        corner[vi * 2] = CORNERS[c][0]; corner[vi * 2 + 1] = CORNERS[c][1];
        var u = (CORNERS[c][0] + 0.5), v = CORNERS[c][1];
        uv[vi * 2] = (bb.x + u * bb.w) / atlasW;
        uv[vi * 2 + 1] = 1 - (bb.y + (1 - v) * bb.h) / atlasH;
        lsize[vi * 2] = bb.w / SS; lsize[vi * 2 + 1] = bb.h / SS;
        lmax[vi] = itm.maxDist || 1e12;
        lvis[vi] = 1;
      }
      idx[i * 6] = i * 4; idx[i * 6 + 1] = i * 4 + 1; idx[i * 6 + 2] = i * 4 + 2;
      idx[i * 6 + 3] = i * 4; idx[i * 6 + 4] = i * 4 + 2; idx[i * 6 + 5] = i * 4 + 3;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('lsize', new THREE.BufferAttribute(lsize, 2));
    g.setAttribute('lmax', new THREE.BufferAttribute(lmax, 1));
    var lv = new THREE.BufferAttribute(lvis, 1); lv.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('lvis', lv);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    if (this.texture) this.texture.dispose();
    // Sin `encoding`: el shader de etiquetas escribe el texel tal cual (el canvas
    // ya está en sRGB y el búfer de dibujo también).
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.minFilter = THREE.LinearFilter; this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.material.uniforms.uMap.value = this.texture;
    this.mesh.visible = n > 0;
    this.items = items; this.lvis = lvis; this.lvisAttr = lv;
  };
  var _lv = new THREE.Vector3();
  /**
   * Rechazo de solapes en pantalla: recorre las etiquetas por prioridad y
   * oculta las que intersecan un rectángulo ya aceptado. `rects` es un
   * acumulador compartido entre conjuntos ({arr: Float32Array, n}) que se
   * reinicia cada fotograma. Sin reservas de memoria por fotograma.
   */
  LabelSet.prototype.cull = function (camera, camPos, W, H, rects) {
    var items = this.items, lvis = this.lvis, changed = false, i, k;
    for (i = 0; i < items.length; i++) {
      var it = items[i], vis = 0;
      _lv.set(it.x, it.y, it.z);
      if (_lv.distanceTo(camPos) < (it.maxDist || 1e12)) {
        _lv.project(camera);
        if (_lv.z < 1 && _lv.x > -1.3 && _lv.x < 1.3 && _lv.y > -1.3 && _lv.y < 1.3) {
          var sx = (_lv.x + 1) / 2 * W, sy = (1 - _lv.y) / 2 * H;
          var x0 = sx - it.pw / 2, x1 = sx + it.pw / 2, y0 = sy - it.ph, y1 = sy, free = true, a = rects.arr;
          for (k = 0; k < rects.n; k++) {
            if (x0 < a[k * 4 + 2] && x1 > a[k * 4] && y0 < a[k * 4 + 3] && y1 > a[k * 4 + 1]) { free = false; break; }
          }
          if (free) {
            vis = 1;
            if (rects.n * 4 + 4 <= a.length) { a[rects.n * 4] = x0; a[rects.n * 4 + 1] = y0; a[rects.n * 4 + 2] = x1; a[rects.n * 4 + 3] = y1; rects.n++; }
          }
        }
      }
      if (lvis[i * 4] !== vis) { lvis[i * 4] = lvis[i * 4 + 1] = lvis[i * 4 + 2] = lvis[i * 4 + 3] = vis; changed = true; }
    }
    if (changed) this.lvisAttr.needsUpdate = true;
  };
  LabelSet.prototype.dispose = function () {
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    if (this.texture) this.texture.dispose();
    this.material.dispose();
  };

  // ---------------------------------------------------------------------
  // 3. DUBÁI: piezas, material de edificios, hitos, skylines y sectores
  // ---------------------------------------------------------------------

  // ---- Piezas: primitivas unitarias cacheadas + volcado con transformación ----
  // Cada pieza {g, a, x,y,z, rx,ry,rz, sx,sy,sz, c:[r,g,b]} se expresa en metros
  // locales con la base en y = 0 y se vuelca (posición, normal, color) en un
  // acumulador; un hito o un arquetipo de sector es una lista de piezas y
  // acaba en UNA geometría con colores por vértice.
  var GEO_CACHE = {};
  function prim(kind, a) {
    var key = kind + ':' + (a || '');
    if (GEO_CACHE[key]) return GEO_CACHE[key];
    var g;
    switch (kind) {
      case 'cyl': g = new THREE.CylinderGeometry(0.5, 0.5, 1, a || 16); g.translate(0, 0.5, 0); break;
      case 'tcyl': g = new THREE.CylinderGeometry(0.32, 0.5, 1, a || 16); g.translate(0, 0.5, 0); break;
      case 'cone': g = new THREE.ConeGeometry(0.5, 1, a || 16); g.translate(0, 0.5, 0); break;
      case 'prism3': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 3); g.translate(0, 0.5, 0); break;
      case 'sphere': g = new THREE.SphereGeometry(0.5, 20, 12); break;
      // Esfera de lejos: 80 triángulos en vez de 440. Para bultos que nunca se
      // miran de cerca (racimos de dátiles, cabinas de noria). Un racimo a 20
      // metros de altura no distingue 440 caras de 80, pero 916 palmeras sí
      // distinguen medio millón de triángulos de ciento noventa mil.
      case 'ball': g = new THREE.IcosahedronGeometry(0.5, 1); break;
      case 'hemi': g = new THREE.SphereGeometry(0.5, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2); break;
      case 'torus': g = new THREE.TorusGeometry(0.5, a || 0.05, 10, 48); break;
      case 'halfcyl': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1, false, 0, Math.PI); g.translate(0, 0.5, 0); break;
      case 'shell': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1, true, 0, Math.PI); g.translate(0, 0.5, 0); break;
      case 'ring': g = new THREE.RingGeometry(0.44, 0.5, 48); g.rotateX(-Math.PI / 2); break;
      case 'slab': g = new THREE.BoxGeometry(1, 1, 1); break; // caja CENTRADA (para vigas inclinadas)
      default: g = new THREE.BoxGeometry(1, 1, 1); g.translate(0, 0.5, 0);
    }
    g = g.toNonIndexed();
    GEO_CACHE[key] = g;
    return g;
  }
  var _m4 = new THREE.Matrix4(), _m4b = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _pv = new THREE.Vector3(), _sv = new THREE.Vector3(), _nm = new THREE.Matrix3();
  function newAcc() { return { pos: [], nor: [], col: [] }; }
  /** Vuelca una pieza en `out`, opcionalmente bajo una matriz padre (mundo). */
  function pushPart(out, p, parent) {
    var g = prim(p.g || 'box', p.a);
    _e.set(p.rx || 0, p.ry || 0, p.rz || 0); _q.setFromEuler(_e);
    _m4.compose(_pv.set(p.x || 0, p.y || 0, p.z || 0), _q, _sv.set(p.sx || 1, p.sy || 1, p.sz || 1));
    if (parent) _m4.premultiply(parent);
    _nm.getNormalMatrix(_m4);
    var pa = g.attributes.position.array, na = g.attributes.normal.array, c = lin3(p.c || [0.82, 0.82, 0.84]), i;
    for (i = 0; i < pa.length; i += 3) {
      _pv.set(pa[i], pa[i + 1], pa[i + 2]).applyMatrix4(_m4); out.pos.push(_pv.x, _pv.y, _pv.z);
      _pv.set(na[i], na[i + 1], na[i + 2]).applyMatrix3(_nm).normalize(); out.nor.push(_pv.x, _pv.y, _pv.z);
      out.col.push(c[0], c[1], c[2]);
    }
  }
  function pushParts(out, parts, parent) { for (var i = 0; i < parts.length; i++) pushPart(out, parts[i], parent); }
  function accGeometry(out) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
    g.computeBoundingSphere();
    return g;
  }

  // ---- Material de edificios (v0.10.0): sol con sombras reales, luz de cielo,
  // reflejo del cielo (mapa cúbico) con Fresnel, cristal según el color, forjados,
  // oclusión de contacto y ventanas que se encienden al anochecer ----
  // Sirve para geometrías con color por vértice y para InstancedMesh con color
  // por instancia (THREE define USE_INSTANCING / USE_INSTANCING_COLOR solo).
  var BUILD_VS = [
    '#include <common>',
    '#include <color_pars_vertex>',
    '#include <fog_pars_vertex>',
    '#include <logdepthbuf_pars_vertex>',
    '#include <shadowmap_pars_vertex>',
    // `abase` (v0.10.14): la cota del pie de cada edificio en las mallas
    // fundidas por tesela, para que las ventanas cuenten desde su planta baja y
    // no desde el nivel del mar. Las mallas sin el atributo leen 0: como antes.
    'attribute float abase;',
    // `aflags` (v0.10.14–16): el tipo de fachada del catálogo. 0 = retícula de
    // oficina (huecos de 4,5 por 3,6 m), 1 = lisa, sin ventanas (villas, naves,
    // granjas, depósitos), 2 = muro cortina (paños de 1,5 m con montantes finos),
    // 3 = ventana corrida (una cinta de fachada a fachada por planta). Las mallas
    // sin el atributo leen 0.
    'attribute float aflags;',
    'varying vec3 vNormalW; varying vec3 vWorld; varying float vLocalY; varying float vFlags;',
    'void main(){',
    '  vFlags = aflags;',
    '  #include <color_vertex>',
    '  vec3 on = normal;',
    '  #ifdef USE_INSTANCING', '  on = mat3(instanceMatrix) * on;', '  #endif',
    '  vec3 transformedNormal = normalMatrix * on;',
    '  vNormalW = normalize(mat3(modelMatrix) * on);',
    '  vec4 wp = vec4(position, 1.0); float lh = position.y - abase;',
    '  #ifdef USE_INSTANCING', '  wp = instanceMatrix * wp; lh = wp.y - instanceMatrix[3].y;', '  #endif',
    '  vec4 worldPosition = modelMatrix * wp; vWorld = worldPosition.xyz; vLocalY = lh;',
    '  vec4 mvPosition = viewMatrix * worldPosition;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '  #include <fog_vertex>',
    '  #include <shadowmap_vertex>',
    '}'].join('\n');
  var BUILD_FS = [
    '#include <common>',
    '#include <packing>',
    '#include <color_pars_fragment>',
    '#include <fog_pars_fragment>',
    '#include <logdepthbuf_pars_fragment>',
    '#include <lights_pars_begin>',
    '#include <shadowmap_pars_fragment>',
    '#include <shadowmask_pars_fragment>',
    'uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor; uniform float uNight, uDusk, uWindows; uniform samplerCube uEnv;',
    'varying vec3 vNormalW; varying vec3 vWorld; varying float vLocalY; varying float vFlags;',
    'float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  float tipo = floor(vFlags + 0.5);',
    '  float lisa = step(0.5, tipo) * step(tipo, 1.5), cortina = step(1.5, tipo) * step(tipo, 2.5), cinta = step(2.5, tipo);',
    '  float uWin = uWindows * (1.0 - lisa);',
    '  vec3 base = vec3(0.8);',
    '  #if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)', '  base = vColor.rgb;', '  #endif',
    '  vec3 n = normalize(vNormalW);',
    '  vec3 v = normalize(cameraPosition - vWorld);',
    '  float shadow = getShadowMask();',
    '  float ndl = max(dot(n, uSun), 0.0) * shadow;',
    '  float glassy = smoothstep(0.02, 0.16, base.b - base.r) * uWin;',
    '  float facade = clamp(1.0 - abs(n.y) * 1.2, 0.0, 1.0);',
    '  vec2 uvw = vec2(dot(vWorld.xz, vec2(n.z, -n.x)), vWorld.y);',
    '  vec2 cellSz = vec2(mix(4.5, 1.5, cortina), 3.6);',
    '  vec2 cell = floor(uvw / vec2(4.5, 3.6)); vec2 f = fract(uvw / cellSz);',
    '  float winRet = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.86);',   // retícula: hueco por hueco
    '  float winCor = step(0.04, f.x) * step(f.x, 0.96) * step(0.05, f.y) * step(f.y, 0.95);',   // muro cortina: el paño casi entero
    '  float winCin = step(0.30, f.y) * step(f.y, 0.86);',                                          // cinta: de fachada a fachada
    '  float win = mix(mix(winRet, winCor, cortina), winCin, cinta);',
    '  float glass = win * facade * step(5.0, vLocalY) * uWin;',
    '  float slab = (1.0 - smoothstep(0.0, 0.07, f.y)) * facade * uWin * step(5.0, vLocalY) * (1.0 - 0.6 * cortina);',
    '  float rnd = hash21(cell + floor(vWorld.xz * 0.002));',
    '  float lit = step(0.55, rnd);',
    '  float ao = mix(0.6, 1.0, smoothstep(0.0, 16.0, vLocalY));',
    '  vec3 amb = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y) * ao;',
    '  vec3 albedo = base;',
    '  albedo = mix(albedo, albedo * 0.45 + vec3(0.015, 0.04, 0.07), glass * mix(0.65, 0.85, max(cortina, cinta)));',   // cortina y cinta: más cristal, menos pared
    '  albedo *= 1.0 - slab * 0.4;',
    '  albedo *= mix(1.0, 0.82, step(0.9, n.y) * uWin);',
    '  vec3 col = albedo * (amb * 0.85 + uSunColor * ndl * 1.15);',
    '  vec3 r = reflect(-v, n);',
    '  float mirror = max(glass, glassy * 0.6);',
    '  vec3 env = textureCube(uEnv, r, mix(3.5, 0.0, mirror)).rgb;',
    '  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);',
    '  float refl = mix(0.03, 0.30, mirror) + fres * mix(0.12, 0.55, mirror);',
    '  col = mix(col, env * (1.0 - uNight * 0.75), refl * (1.0 - uNight * 0.6));',
    '  vec3 h = normalize(uSun + v);',
    '  float spec = pow(max(dot(n, h), 0.0), mix(20.0, 240.0, mirror)) * shadow;',
    '  col += uSunColor * spec * mix(0.06, 0.55, mirror) * (1.0 - uNight) * max(uSun.y, 0.0);',
    '  float on = lit * max(uNight, uDusk * 0.45);',
    '  col = mix(col, col * 0.28 + vec3(0.008, 0.010, 0.018), uNight);',
    '  col += vec3(1.0, 0.63, 0.32) * glass * on * (0.20 + 0.95 * rnd * rnd);',
    '  gl_FragColor = vec4(col, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '  #include <fog_fragment>',
    '}'].join('\n');
  function makeBuildingMaterial(shared, windows) {
    var u = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]);
    u.uSun = shared.uSun; u.uSunColor = shared.uSunColor; u.uSkyColor = shared.uSkyColor; u.uGroundColor = shared.uGroundColor; u.uNight = shared.uNight; u.uDusk = shared.uDusk; u.uEnv = shared.uEnv;
    u.uWindows = { value: windows ? 1 : 0 };
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: BUILD_VS, fragmentShader: BUILD_FS, vertexColors: true, fog: true, lights: true });
  }

  /** sRGB -> lineal exacto, para las texturas de material. */
  var GLSL_LINEAL = [
    'vec3 aLineal(vec3 c){',
    '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));',
    '}'].join('\n');
  // ---- Calzada (v0.10.4): asfalto, bordillo y acera con marcas viales ----------
  // Las 21 polilíneas del dataset se dibujaban como LineSegments de un píxel a
  // tres metros del suelo: de cerca no eran una carretera, eran un alambre
  // flotando. Ahora son geometría: una cinta con perfil —acera, bordillo de cara
  // vertical, calzada— remuestreada cada 100 m para que siga el relieve.
  //
  // Las marcas son analíticas, no una textura: la línea de eje, las de carril y
  // las discontinuas salen de la coordenada transversal (metros desde el eje) y
  // de la longitudinal (metros recorridos), que llegan por atributo. Cuestan
  // cuatro instrucciones y no ocupan un byte de descarga.
  var ROAD_VS = [
    '#include <common>',
    '#include <fog_pars_vertex>',
    '#include <logdepthbuf_pars_vertex>',
    '#include <shadowmap_pars_vertex>',
    'attribute float hc; attribute vec3 via;',       // via = (u transversal, s longitudinal, clase 0..3)
    'uniform float uLod;',
    'varying vec3 vVia; varying vec3 vWorld;',
    'void main(){',
    '  vec3 p = position; p.y = mix(position.y, hc, uLod);',
    '  vVia = via;',
    '  vec3 transformedNormal = vec3(0.0, 1.0, 0.0);',
    '  vec4 worldPosition = modelMatrix * vec4(p, 1.0); vWorld = worldPosition.xyz;',
    '  vec4 mvPosition = viewMatrix * worldPosition;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '  #include <fog_vertex>',
    '  #include <shadowmap_vertex>',
    '}'].join('\n');
  var ROAD_FS = [
    '#include <common>',
    '#include <packing>',
    '#include <fog_pars_fragment>',
    '#include <logdepthbuf_pars_fragment>',
    '#include <lights_pars_begin>',
    '#include <shadowmap_pars_fragment>',
    '#include <shadowmask_pars_fragment>',
    'uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor; uniform float uNight; uniform sampler2D uNoise;',
    'uniform sampler2D uAsfalto, uHormigon, uAcera;',
    'varying vec3 vVia; varying vec3 vWorld;',
    GLSL_LINEAL,
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  float u = vVia.x, sl = vVia.y, clase = vVia.z;',
    '  float dist = length(cameraPosition - vWorld);',
    '  float cerca = 1.0 - smoothstep(120.0, 2600.0, dist);',   // las marcas se apagan de lejos: aliasing
    // Cada material con su periodo de teselado, en metros de mundo.
    '  vec4 tA = texture2D(uAsfalto, vWorld.xz / 6.0);',
    '  vec4 tH = texture2D(uHormigon, vWorld.xz / 3.0);',
    '  vec4 tC = texture2D(uAcera, vWorld.xz / 4.8);',          // 8 losas de 60 cm
    // Clases: 0 asfalto con marcas, 1 hormigón del bordillo, 2 losa de acera,
    // 3 asfalto sin marcas —la glorieta, que no lleva eje ni carriles pintados—,
    // 4 pintura continua (línea de detención), 5 pintura discontinua (ceda el
    // paso) y 6 cebra del paso de peatones, las tres sobre asfalto.
    '  vec4 tex = clase < 0.5 ? tA : (clase < 1.5 ? tH : (clase < 2.5 ? tC : tA));',
    '  float esAsfalto = clamp(step(clase, 0.5) + step(2.5, clase), 0.0, 1.0);',
    '  vec3 base = aLineal(tex.rgb);',
    '  float manchas = texture2D(uNoise, vWorld.xz / 220.0).r;',
    '  base *= mix(0.88, 1.12, manchas);',                      // veladuras de escala grande
    // El relieve por texel se saca de la altura del ALFA, pero solo del asfalto:
    // GLSL no deja elegir un sampler con un ternario, y muestrear los tres en dos
    // desplazamientos costaría seis lecturas más por fragmento. En bordillo y
    // acera el color de las juntas ya insinúa el relieve.
    '  float relieve = (1.0 - smoothstep(3.0, 45.0, dist)) * esAsfalto;',
    '  float hx = texture2D(uAsfalto, (vWorld.xz + vec2(0.06, 0.0)) / 6.0).a;',
    '  float hz = texture2D(uAsfalto, (vWorld.xz + vec2(0.0, 0.06)) / 6.0).a;',
    // Marcas: eje doble continuo, carriles discontinuos cada 3,5 m de ancho.
    '  if (clase < 0.5) {',
    '    float eje = 1.0 - smoothstep(0.10, 0.34, abs(abs(u) - 0.42));',
    '    float carril = mod(abs(u) + 1.75, 3.5) - 1.75;',
    '    float linea = (1.0 - smoothstep(0.05, 0.16, abs(carril))) * step(1.9, abs(u));',
    '    float trazo = step(0.42, fract(sl / 12.0));',   // 5 m pintados, 7 m de hueco
    '    float pintura = clamp(eje + linea * trazo, 0.0, 1.0) * cerca;',
    '    base = mix(base, vec3(0.72, 0.70, 0.64), pintura * 0.92);',
    '  }',
    // Las transversales de las bocas: continua la de detención; el ceda el paso,
    // 60 cm pintados y 30 de hueco a lo ancho; la cebra, bandas de 50 cm a lo
    // largo de la calle con 50 de hueco, que es por donde cruza la gente.
    '  if (clase > 3.5) {',
    '    float raya = clase > 5.5 ? (1.0 - step(0.5, fract(u))) : (clase > 4.5 ? step(0.34, fract(u / 0.9)) : 1.0);',
    '    base = mix(base, vec3(0.72, 0.70, 0.64), raya * 0.92 * cerca);',
    '  }',
    '  float shadow = getShadowMask();',
    '  vec3 n = normalize(vec3((tA.a - hx) * 9.0 * relieve, 1.0, (tA.a - hz) * 9.0 * relieve));',
    '  float ndl = max(dot(n, uSun), 0.0) * shadow;',
    '  vec3 amb = mix(uGroundColor, uSkyColor, 0.9);',
    '  vec3 col = base * (amb * 0.9 + uSunColor * ndl * 1.15);',
    '  col = mix(col, col * 0.22 + vec3(0.010, 0.010, 0.016), uNight);',
    '  gl_FragColor = vec4(col, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '  #include <fog_fragment>',
    '}'].join('\n');
  function makeRoadMaterial(shared, lodUniform, noise, mats) {
    var u = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]);
    u.uSun = shared.uSun; u.uSunColor = shared.uSunColor; u.uSkyColor = shared.uSkyColor;
    u.uGroundColor = shared.uGroundColor; u.uNight = shared.uNight;
    u.uLod = lodUniform; u.uNoise = { value: noise };
    u.uAsfalto = { value: mats.asfalto }; u.uHormigon = { value: mats.hormigon }; u.uAcera = { value: mats.acera };
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: ROAD_VS, fragmentShader: ROAD_FS, fog: true, lights: true });
  }

  // ---- Terreno (v0.10.0): color por vértice, sol con sombras, luz de cielo y
  // relieve fino de arena a partir de un ruido generado en el arranque ----
  var TERR_VS = [
    '#include <common>',
    '#include <color_pars_vertex>',
    '#include <fog_pars_vertex>',
    '#include <logdepthbuf_pars_vertex>',
    '#include <shadowmap_pars_vertex>',
    'varying vec3 vNormalW; varying vec3 vWorld;',
    'void main(){',
    '  #include <color_vertex>',
    '  vec3 transformedNormal = normalMatrix * normal;',
    '  vNormalW = normalize(mat3(modelMatrix) * normal);',
    '  vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorld = worldPosition.xyz;',
    '  vec4 mvPosition = viewMatrix * worldPosition;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '  #include <fog_vertex>',
    '  #include <shadowmap_vertex>',
    '}'].join('\n');
  var TERR_FS = [
    '#include <common>',
    '#include <packing>',
    '#include <color_pars_fragment>',
    '#include <fog_pars_fragment>',
    '#include <logdepthbuf_pars_fragment>',
    '#include <lights_pars_begin>',
    '#include <shadowmap_pars_fragment>',
    '#include <shadowmask_pars_fragment>',
    'uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor; uniform float uNight; uniform sampler2D uNoise, uArena;',
    'varying vec3 vNormalW; varying vec3 vWorld;',
    GLSL_LINEAL,
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec3 base = vec3(0.6);',
    '  #ifdef USE_COLOR', '  base = vColor.rgb;', '  #endif',
    '  float shadow = getShadowMask();',
    '  float dist = length(cameraPosition - vWorld);',
    '  float n2 = texture2D(uNoise, vWorld.xz / 760.0 + 0.37).r;',
    '  float near = 1.0 - smoothstep(60.0, 900.0, dist);',
    // El grano y los rizos de la arena salen de la textura, no de ruido de valor:
    // es lo que da escala al suelo cuando lo tienes a dos metros.
    '  vec4 tS = texture2D(uArena, vWorld.xz / 9.0);',
    '  float ar = dot(aLineal(tS.rgb), vec3(0.2126, 0.7152, 0.0722));',
    '  float detail = 0.78 + 1.05 * ar + 0.12 * (n2 - 0.5);',
    '  vec3 n = normalize(vNormalW);',
    '  float ex = texture2D(uArena, (vWorld.xz + vec2(0.35, 0.0)) / 9.0).a - tS.a;',
    '  float ez = texture2D(uArena, (vWorld.xz + vec2(0.0, 0.35)) / 9.0).a - tS.a;',
    '  n = normalize(n + vec3(-ex, 0.0, -ez) * 6.0 * (1.0 - smoothstep(120.0, 1400.0, dist)));',
    '  float ndl = max(dot(n, uSun), 0.0) * shadow;',
    '  vec3 amb = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y);',
    '  vec3 col = base * detail * (amb * 0.9 + uSunColor * ndl * 1.2);',
    '  col = mix(col, col * 0.2 + vec3(0.004, 0.006, 0.012), uNight);',
    '  gl_FragColor = vec4(col, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '  #include <fog_fragment>',
    '}'].join('\n');
  function makeTerrainMaterial(shared, noise, arena) {
    var u = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]);
    u.uSun = shared.uSun; u.uSunColor = shared.uSunColor; u.uSkyColor = shared.uSkyColor; u.uGroundColor = shared.uGroundColor; u.uNight = shared.uNight;
    u.uNoise = { value: noise }; u.uArena = { value: arena };
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: TERR_VS, fragmentShader: TERR_FS, vertexColors: true, fog: true, lights: true });
  }
  /** Ruido de valor con 4 octavas, 256×256, repetible: relieve de la arena y variación del suelo. */
  /**
   * Carga una textura de material (RGBA: color en sRGB, altura en el alfa).
   * La conversión sRGB -> lineal se hace a mano en el sombreador: `texture2D()`
   * dentro de un material propio NO pasa por la conversión que three inyecta en
   * sus materiales de serie, así que marcar `encoding` aquí no haría nada.
   * Devuelve la textura ya usable; la imagen llega después y se refresca sola.
   */
  function cargaMaterial(url) {
    var tex = new THREE.Texture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true; tex.anisotropy = 4;
    var img = new Image();
    img.onload = function () { tex.image = img; tex.needsUpdate = true; };
    img.onerror = function () { console.warn('city3d: no se pudo cargar la textura ' + url); };
    img.src = url;
    return tex;
  }
  function makeNoiseTexture(size, seed) {
    var data = new Uint8Array(size * size * 4), i, j, o;
    function vnoise(x, y, freq) {
      var fx = x * freq, fy = y * freq, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      var n = Math.max(1, Math.round(freq));
      function h(a, b) { return hash2(((a % n) + n) % n + seed, ((b % n) + n) % n + seed * 7); }
      var sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      return lerp(lerp(h(x0, y0), h(x0 + 1, y0), sx), lerp(h(x0, y0 + 1), h(x0 + 1, y0 + 1), sx), sy);
    }
    for (j = 0; j < size; j++) for (i = 0; i < size; i++) {
      var u = i / size, w = j / size;
      var v = 0.5 * vnoise(u, w, 4) + 0.25 * vnoise(u, w, 8) + 0.15 * vnoise(u, w, 16) + 0.1 * vnoise(u, w, 32);
      o = (j * size + i) * 4; data[o] = data[o + 1] = data[o + 2] = clamp(v, 0, 1) * 255; data[o + 3] = 255;
    }
    var tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
    return tex;
  }
  /** Profundidad del mar (0..80 m → 0..255) a partir del relieve, para el color y la espuma del agua. */
  function makeDepthTexture(img, offset) {
    var w = img.width, h = img.height, d = img.data, scale = img.depth === 16 ? 1 : 256, data = new Uint8Array(w * h * 4), i, o;
    for (i = 0; i < w * h; i++) {
      var hv = d[i] * scale - offset, depth = clamp(-hv, 0, 80) / 80;
      o = i * 4; data[o] = data[o + 1] = data[o + 2] = depth * 255; data[o + 3] = 255;
    }
    var tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.flipY = false; tex.needsUpdate = true;
    return tex;
  }

  // ---- Paleta -------------------------------------------------------------
  var GLASS = [0.62, 0.74, 0.86], GLASS2 = [0.55, 0.66, 0.78], STEEL = [0.72, 0.74, 0.78], WHITE = [0.95, 0.95, 0.96];
  var SAND = [0.86, 0.77, 0.62], GOLD = [0.86, 0.70, 0.36], DARK = [0.24, 0.26, 0.30], GREEN = [0.30, 0.56, 0.32];
  var PINK = [0.88, 0.70, 0.60], RED = [0.72, 0.18, 0.16], ASPHALT = [0.22, 0.22, 0.24], WATER = [0.25, 0.65, 0.78];
  function shade(c, k) { return [clamp(c[0] * k, 0, 1), clamp(c[1] * k, 0, 1), clamp(c[2] * k, 0, 1)]; }

  // ---- Hitos: cada forma es una lista de piezas en metros locales -------------
  // (l = {h, w, d} del JSON; la base está en y = 0 y el frente mira a -Z.)
  var SHAPES = {
    tower: function (l, r) {
      var c = [GLASS, GLASS2, STEEL, [0.78, 0.72, 0.62]][Math.floor(r() * 4)];
      return [{ sx: l.w, sy: l.h, sz: l.d, c: c }, { sx: l.w * 0.62, sy: l.h * 0.05, sz: l.d * 0.62, y: l.h, c: DARK },
        { g: 'cyl', a: 8, sx: l.w * 0.05, sy: l.h * 0.12, sz: l.w * 0.05, y: l.h * 1.05, c: STEEL }];
    },
    burj_khalifa: function (l) {
      var parts = [], tiers = 27, tierH = l.h * 0.78 / tiers, t, k;
      for (t = 0; t < tiers; t++) {
        var len = l.w * (0.5 - 0.42 * t / tiers), wid = l.w * (0.17 - 0.09 * t / tiers), y0 = t * tierH;
        for (k = 0; k < 3; k++) {
          var ang = k * Math.PI * 2 / 3 + 0.3;
          parts.push({ sx: len, sy: tierH * 1.001, sz: wid, x: Math.sin(ang) * len / 2, z: Math.cos(ang) * len / 2, y: y0, ry: ang, c: shade(GLASS, 0.9 + 0.1 * (t / tiers)) });
        }
      }
      parts.push({ g: 'cyl', a: 6, sx: l.w * 0.13, sy: l.h * 0.88, sz: l.w * 0.13, c: STEEL });
      parts.push({ g: 'cone', a: 6, sx: l.w * 0.09, sy: l.h * 0.14, sz: l.w * 0.09, y: l.h * 0.86, c: STEEL });
      parts.push({ g: 'cyl', a: 6, sx: l.w * 0.015, sy: l.h * 0.06, sz: l.w * 0.015, y: l.h * 0.94, c: WHITE });
      return parts;
    },
    twin_prism: function (l) {
      return [{ g: 'prism3', sx: l.w * 0.5, sy: l.h, sz: l.w * 0.5, x: -l.w * 0.27, ry: 0.2, c: STEEL },
        { g: 'prism3', sx: l.w * 0.5, sy: l.h * 0.87, sz: l.w * 0.5, x: l.w * 0.27, ry: Math.PI / 3 + 0.2, c: GLASS2 },
        { sx: l.w * 1.3, sy: 22, sz: l.d * 1.2, c: SAND }];
    },
    torus: function (l) {
      var s = l.h / 1.32;
      return [{ g: 'hemi', sx: l.w * 1.6, sy: l.h * 0.14, sz: l.w * 1.6, c: GREEN },
        { g: 'torus', a: 0.16, sx: s, sy: s, sz: s * 0.62, y: l.h * 0.55, c: STEEL }];
    },
    frame: function (l) {
      var p = l.w * 0.14;
      return [{ sx: p, sy: l.h, sz: l.d, x: -(l.w / 2 - p / 2), c: GOLD }, { sx: p, sy: l.h, sz: l.d, x: l.w / 2 - p / 2, c: GOLD },
        { sx: l.w, sy: l.h * 0.12, sz: l.d, y: l.h * 0.88, c: GOLD }, { sx: l.w, sy: 3, sz: l.d * 1.5, c: DARK }];
    },
    gate: function (l) {
      return [{ sx: l.w * 0.26, sy: l.h * 0.66, sz: l.d, x: -l.w * 0.37, c: STEEL }, { sx: l.w * 0.26, sy: l.h * 0.66, sz: l.d, x: l.w * 0.37, c: STEEL },
        { sx: l.w, sy: l.h * 0.34, sz: l.d, y: l.h * 0.66, c: STEEL }];
    },
    link: function (l) {
      return [{ sx: l.w * 0.24, sy: l.h, sz: l.d, x: -l.w * 0.34, c: GLASS }, { sx: l.w * 0.24, sy: l.h * 0.78, sz: l.d, x: l.w * 0.34, c: GLASS2 },
        { sx: l.w * 1.08, sy: l.h * 0.07, sz: l.d * 0.7, x: l.w * 0.06, y: l.h * 0.33, c: STEEL }];
    },
    wheel: function (l) {
      var parts = [], R = l.h * 0.46, cy = l.h * 0.52, i;
      parts.push({ g: 'torus', a: 0.02, sx: R * 2, sy: R * 2, sz: R * 2, y: cy, c: WHITE });
      parts.push({ g: 'sphere', sx: R * 0.16, sy: R * 0.16, sz: R * 0.16, y: cy, c: STEEL });
      for (i = 0; i < 12; i++) parts.push({ g: 'slab', sx: R * 0.02, sy: R * 2, sz: R * 0.02, y: cy, rz: i * Math.PI / 12, c: STEEL });
      for (i = 0; i < 24; i++) {
        var a = i / 24 * Math.PI * 2;
        parts.push({ g: 'ball', sx: R * 0.09, sy: R * 0.09, sz: R * 0.12, x: Math.cos(a) * R, y: cy + Math.sin(a) * R, c: GLASS });
      }
      parts.push({ g: 'slab', sx: R * 0.06, sy: cy * 1.05, sz: R * 0.06, x: -R * 0.35, y: cy / 2, rz: 0.32, c: WHITE });
      parts.push({ g: 'slab', sx: R * 0.06, sy: cy * 1.05, sz: R * 0.06, x: R * 0.35, y: cy / 2, rz: -0.32, c: WHITE });
      parts.push({ sx: l.w * 0.5, sy: 6, sz: l.d * 1.5, c: SAND });
      return parts;
    },
    arch: function (l) {
      return [{ sx: l.w * 0.34, sy: l.h * 0.74, sz: l.d, x: -l.w * 0.33, c: PINK }, { sx: l.w * 0.34, sy: l.h * 0.74, sz: l.d, x: l.w * 0.33, c: PINK },
        { sx: l.w * 0.44, sy: l.h * 0.3, sz: l.d, y: l.h * 0.7, c: PINK }, { g: 'cone', a: 4, sx: l.w * 0.2, sy: l.h * 0.22, sz: l.d * 1.1, y: l.h, ry: Math.PI / 4, c: [0.75, 0.62, 0.55] },
        { g: 'cone', a: 4, sx: l.w * 0.12, sy: l.h * 0.14, sz: l.d * 0.9, x: -l.w * 0.33, y: l.h * 0.74, ry: Math.PI / 4, c: [0.75, 0.62, 0.55] },
        { g: 'cone', a: 4, sx: l.w * 0.12, sy: l.h * 0.14, sz: l.d * 0.9, x: l.w * 0.33, y: l.h * 0.74, ry: Math.PI / 4, c: [0.75, 0.62, 0.55] }];
    },
    twist: function (l) {
      var parts = [], n = 24, i;
      for (i = 0; i < n; i++) parts.push({ sx: l.w, sy: l.h / n * 1.01, sz: l.d, y: i * l.h / n, ry: (Math.PI / 2) * i / n, c: shade(GLASS, 0.85 + 0.15 * i / n) });
      return parts;
    },
    twin: function (l) {
      return [{ sx: l.w * 0.38, sy: l.h, sz: l.d, x: -l.w * 0.31, c: GLASS2 }, { sx: l.w * 0.38, sy: l.h, sz: l.d, x: l.w * 0.31, c: GLASS2 },
        { g: 'cone', a: 4, sx: l.w * 0.3, sy: l.h * 0.08, sz: l.d * 0.8, x: -l.w * 0.31, y: l.h, ry: Math.PI / 4, c: STEEL },
        { g: 'cone', a: 4, sx: l.w * 0.3, sy: l.h * 0.08, sz: l.d * 0.8, x: l.w * 0.31, y: l.h, ry: Math.PI / 4, c: STEEL }];
    },
    twin_bridge: function (l) {
      return [{ sx: l.w * 0.34, sy: l.h, sz: l.d, x: -l.w * 0.33, c: GLASS }, { sx: l.w * 0.34, sy: l.h, sz: l.d, x: l.w * 0.33, c: GLASS },
        { sx: l.w, sy: l.h * 0.08, sz: l.d, y: l.h * 0.92, c: STEEL }];
    },
    sail: function (l) {
      return [{ g: 'cyl', a: 24, sx: l.w * 2.2, sy: 4, sz: l.w * 2.2, c: SAND },
        { g: 'shell', sx: l.d * 1.6, sy: l.h, sz: l.w, ry: -Math.PI / 2, z: 0, c: WHITE },
        { sx: l.w * 0.07, sy: l.h * 1.03, sz: l.d * 0.16, z: -l.d * 0.6, c: STEEL },
        { g: 'cyl', a: 20, sx: l.w * 0.34, sy: 2.5, sz: l.w * 0.34, y: l.h * 0.66, z: -l.d * 0.7, c: [0.3, 0.6, 0.3] }];
    },
    wave: function (l) {
      var parts = [], n = 8, i;
      for (i = 0; i < n; i++) parts.push({ sx: l.w, sy: l.h / n * 1.01, sz: l.d * (1 - i * 0.05), y: i * l.h / n, z: -l.d * 0.45 * Math.pow(i / n, 2), c: shade(GLASS, 0.9 + 0.1 * i / n) });
      return parts;
    },
    mall: function (l) {
      var parts = [{ sx: l.w, sy: l.h, sz: l.d, c: SAND }, { sx: l.w * 0.92, sy: l.h * 0.15, sz: l.d * 0.92, y: l.h, c: shade(SAND, 0.92) }], i;
      for (i = 0; i < 4; i++) parts.push({ g: 'hemi', sx: l.d * 0.25, sy: l.h * 0.3, sz: l.d * 0.25, x: -l.w * 0.3 + i * l.w * 0.2, y: l.h * 1.15, c: GLASS });
      return parts;
    },
    ski: function (l) {
      return [{ g: 'slab', sx: Math.sqrt(l.w * l.w + l.h * l.h * 0.6), sy: l.d * 0.35, sz: l.d, x: 0, y: l.h * 0.45, rz: Math.atan2(l.h * 0.8, l.w), c: STEEL }];
    },
    dhow: function (l) {
      return [{ sx: l.w, sy: l.h * 0.45, sz: l.d, c: SAND }, { g: 'halfcyl', sx: l.d * 1.1, sy: l.w * 0.9, sz: l.h * 1.2, x: l.w * 0.45, y: l.h * 0.45, rz: Math.PI / 2, c: WHITE }];
    },
    pyramid: function (l) { return [{ g: 'cone', a: 4, sx: l.w * 1.41, sy: l.h, sz: l.d * 1.41, ry: Math.PI / 4, c: GLASS }]; },
    globe: function (l) {
      return [{ sx: l.w, sy: l.h * 0.8, sz: l.d, c: WHITE }, { g: 'sphere', sx: l.w * 1.9, sy: l.w * 1.9, sz: l.w * 1.9, y: l.h * 0.8 + l.w * 0.6, c: STEEL }];
    },
    clock: function (l) {
      return [{ sx: l.w * 0.3, sy: l.h, sz: l.d * 0.3, x: -l.w, c: WHITE }, { sx: l.w * 0.3, sy: l.h, sz: l.d * 0.3, x: l.w, c: WHITE },
        { g: 'torus', a: 0.06, sx: l.w * 2.2, sy: l.w * 2.2, sz: l.w * 2.2, y: l.h * 0.8, c: GOLD }];
    },
    souk: function (l) {
      var parts = [], rows = 6, i;
      for (i = 0; i < rows; i++) parts.push({ sx: l.w, sy: l.h * 0.8, sz: l.d * 0.11, z: -l.d / 2 + (i + 0.5) * l.d / rows, c: SAND });
      parts.push({ sx: l.w * 1.02, sy: 1.5, sz: l.d, y: l.h * 0.8, c: [0.55, 0.42, 0.25] });
      parts.push({ g: 'halfcyl', sx: l.d * 0.4, sy: l.w * 0.3, sz: l.h, x: l.w * 0.15, y: l.h, rz: Math.PI / 2, c: GOLD });
      return parts;
    },
    fort: function (l) {
      var t = 3, parts = [{ sx: l.w, sy: l.h, sz: t, z: -l.d / 2, c: SAND }, { sx: l.w, sy: l.h, sz: t, z: l.d / 2, c: SAND },
        { sx: t, sy: l.h, sz: l.d, x: -l.w / 2, c: SAND }, { sx: t, sy: l.h, sz: l.d, x: l.w / 2, c: SAND }];
      parts.push({ g: 'cyl', a: 14, sx: l.w * 0.22, sy: l.h * 1.4, sz: l.w * 0.22, x: -l.w / 2, z: -l.d / 2, c: SAND });
      parts.push({ g: 'cyl', a: 14, sx: l.w * 0.22, sy: l.h * 1.4, sz: l.w * 0.22, x: l.w / 2, z: -l.d / 2, c: SAND });
      parts.push({ g: 'cyl', a: 14, sx: l.w * 0.22, sy: l.h * 1.4, sz: l.w * 0.22, x: l.w / 2, z: l.d / 2, c: SAND });
      parts.push({ sx: l.w * 0.22, sy: l.h * 1.5, sz: l.d * 0.22, x: -l.w / 2, z: l.d / 2, c: SAND });
      return parts;
    },
    windtowers: function (l, r) {
      var parts = [], nx = Math.max(2, Math.round(l.w / 26)), nz = Math.max(2, Math.round(l.d / 26)), i, j;
      for (i = 0; i < nx; i++) for (j = 0; j < nz; j++) {
        var x = -l.w / 2 + (i + 0.5) * l.w / nx, z = -l.d / 2 + (j + 0.5) * l.d / nz, hh = l.h * (0.55 + 0.35 * r());
        parts.push({ sx: 17, sy: hh, sz: 17, x: x, z: z, c: shade(SAND, 0.9 + 0.15 * r()) });
        if (r() < 0.55) parts.push({ sx: 6, sy: hh * 1.1, sz: 6, x: x + 4, z: z - 4, y: hh, c: shade(SAND, 0.85) });
      }
      return parts;
    },
    mosque: function (l) {
      return [{ sx: l.w, sy: l.h * 0.45, sz: l.d, c: WHITE }, { g: 'hemi', sx: l.w * 0.5, sy: l.h * 0.4, sz: l.w * 0.5, y: l.h * 0.45, c: WHITE },
        { g: 'cyl', a: 12, sx: l.w * 0.08, sy: l.h, sz: l.w * 0.08, x: -l.w * 0.42, z: -l.d * 0.42, c: WHITE }, { g: 'cyl', a: 12, sx: l.w * 0.08, sy: l.h, sz: l.w * 0.08, x: l.w * 0.42, z: -l.d * 0.42, c: WHITE },
        { g: 'cone', a: 12, sx: l.w * 0.1, sy: l.h * 0.12, sz: l.w * 0.1, x: -l.w * 0.42, z: -l.d * 0.42, y: l.h, c: GOLD }, { g: 'cone', a: 12, sx: l.w * 0.1, sy: l.h * 0.12, sz: l.w * 0.1, x: l.w * 0.42, z: -l.d * 0.42, y: l.h, c: GOLD }];
    },
    pavilion: function (l) { return [{ sx: l.w, sy: l.h, sz: l.d, c: WHITE }, { g: 'slab', sx: l.w * 1.12, sy: l.h * 0.12, sz: l.d * 1.12, y: l.h * 1.02, rz: 0.08, c: STEEL }]; },
    palace: function (l) {
      return [{ sx: l.w * 1.6, sy: 0.6, sz: l.d * 1.6, c: GREEN }, { sx: l.w, sy: l.h * 0.6, sz: l.d, c: WHITE }, { g: 'hemi', sx: l.w * 0.3, sy: l.h * 0.4, sz: l.w * 0.3, y: l.h * 0.6, c: GOLD },
        { sx: l.w * 0.12, sy: l.h, sz: l.w * 0.12, x: -l.w * 0.44, z: -l.d * 0.44, c: WHITE }, { sx: l.w * 0.12, sy: l.h, sz: l.w * 0.12, x: l.w * 0.44, z: -l.d * 0.44, c: WHITE }];
    },
    grandstand: function (l) {
      var parts = [{ g: 'slab', sx: l.w, sy: l.d * 0.5, sz: l.d, y: l.h * 0.3, rx: -0.35, c: STEEL }, { sx: l.w, sy: l.h * 0.1, sz: l.d * 1.3, y: l.h * 0.9, c: WHITE }], i;
      for (i = 0; i < 12; i++) parts.push({ g: 'cyl', a: 8, sx: 4, sy: l.h * 0.9, sz: 4, x: -l.w / 2 + (i + 0.5) * l.w / 12, z: l.d * 0.5, c: STEEL });
      return parts;
    },
    terminal: function (l) {
      return [{ sx: l.w, sy: l.h * 0.6, sz: l.d, c: WHITE }, { g: 'halfcyl', sx: l.d * 1.05, sy: l.w, sz: l.h * 0.8, x: l.w / 2, y: l.h * 0.6, rz: Math.PI / 2, c: STEEL }];
    },
    dome: function (l) { return [{ g: 'ring', sx: l.w * 1.3, sy: 1, sz: l.d * 1.3, c: SAND }, { g: 'hemi', sx: l.w, sy: l.h, sz: l.d, c: [0.9, 0.9, 0.86] }]; },
    track: function (l) { return [{ g: 'ring', sx: l.w, sy: 1, sz: l.d, y: 0.5, c: ASPHALT }, { sx: l.w * 0.25, sy: l.h, sz: 18, z: -l.d * 0.44, c: WHITE }]; },
    village: function (l, r) {
      var parts = [{ g: 'cyl', a: 24, sx: l.w * 0.3, sy: 1, sz: l.w * 0.3, c: SAND }], i;
      var cols = [[0.85, 0.3, 0.3], [0.3, 0.55, 0.85], [0.9, 0.75, 0.3], [0.4, 0.7, 0.4], [0.75, 0.4, 0.75], [0.9, 0.55, 0.3]];
      for (i = 0; i < 14; i++) {
        var a = i / 14 * Math.PI * 2, R = l.w * 0.4;
        parts.push({ sx: 28, sy: l.h * (0.7 + 0.6 * r()), sz: 28, x: Math.cos(a) * R, z: Math.sin(a) * R * (l.d / l.w), ry: -a, c: cols[i % cols.length] });
      }
      return parts;
    },
    garden: function (l) {
      var parts = [], cols = [[0.9, 0.3, 0.5], [0.95, 0.85, 0.3], [0.6, 0.3, 0.8], [0.9, 0.45, 0.25], [0.35, 0.7, 0.35]], i, j;
      for (i = 0; i < 6; i++) for (j = 0; j < 4; j++) parts.push({ sx: l.w / 6 * 0.9, sy: 1.5, sz: l.d / 4 * 0.9, x: -l.w / 2 + (i + 0.5) * l.w / 6, z: -l.d / 2 + (j + 0.5) * l.d / 4, c: cols[(i + j) % cols.length] });
      parts.push({ g: 'torus', a: 0.06, sx: l.d * 0.5, sy: l.d * 0.5, sz: l.d * 0.5, y: l.d * 0.2, c: [0.9, 0.3, 0.5] });
      return parts;
    },
    cranes: function (l) {
      var parts = [], n = Math.max(2, Math.round(l.w / 130)), i;
      for (i = 0; i < n; i++) {
        var x = -l.w / 2 + (i + 0.5) * l.w / n;
        parts.push({ sx: 6, sy: l.h * 0.7, sz: 6, x: x - 12, z: -l.d * 0.25, c: [0.85, 0.85, 0.85] });
        parts.push({ sx: 6, sy: l.h * 0.7, sz: 6, x: x + 12, z: -l.d * 0.25, c: [0.85, 0.85, 0.85] });
        parts.push({ sx: 30, sy: 8, sz: l.d * 1.6, x: x, y: l.h * 0.7, z: -l.d * 0.1, c: [0.85, 0.85, 0.85] });
        parts.push({ g: 'slab', sx: 5, sy: l.h * 0.45, sz: 5, x: x, y: l.h * 0.88, rx: -0.55, c: RED });
      }
      parts.push({ sx: l.w * 1.05, sy: 2, sz: l.d, c: ASPHALT });
      return parts;
    },
    ship: function (l) {
      return [{ sx: l.w, sy: l.h * 0.35, sz: l.d, c: [0.35, 0.12, 0.12] }, { sx: l.w * 0.6, sy: l.h * 0.35, sz: l.d * 0.8, y: l.h * 0.35, c: WHITE },
        { sx: l.w * 0.3, sy: l.h * 0.15, sz: l.d * 0.6, y: l.h * 0.7, c: WHITE }, { g: 'cyl', a: 12, sx: l.d * 0.3, sy: l.h * 0.25, sz: l.d * 0.3, x: -l.w * 0.05, y: l.h * 0.85, c: [0.8, 0.2, 0.15] }];
    },
    blocks: function (l, r) {
      var parts = [], n = 4 + Math.floor(r() * 3), i;
      for (i = 0; i < n; i++) {
        var w = l.w * (0.18 + 0.14 * r()), d = l.d * (0.18 + 0.14 * r());
        parts.push({ sx: w, sy: l.h * (0.45 + 0.55 * r()), sz: d, x: (r() - 0.5) * (l.w - w), z: (r() - 0.5) * (l.d - d), c: [GLASS, STEEL, SAND, WHITE][i % 4] });
      }
      return parts;
    }
  };

  /** Hash numérico de una cadena (semilla estable por hito). */
  function strSeed(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // ---- Sectores de las parcelas: colores y arquetipos --------------------------
  // Ids = rami-core::ciudad::SECTORES. Nombres en español (el panel traduce
  // con su diccionario); los colores alimentan la capa drapeada, los
  // edificios y la leyenda.
  var SECTOR_NAMES = ['Empresa', 'Granja', 'Tienda', 'Oficina', 'Concesionario de coches', 'Hotel', 'Restaurante', 'Inmobiliaria', 'Constructora',
    'Energía solar', 'Desaladora', 'Logística y puerto', 'Telecomunicaciones', 'Banco', 'Agencia de marketing', 'Empresa de software', 'Taller mecánico',
    'Aseguradora', 'Bufete de abogados', 'Clínica', 'Escuela de negocios', 'Joyería (Zoco del Oro)', 'Supermercado', 'Gimnasio', 'Agencia de turismo',
    'Taxi y movilidad', 'Cafetería', 'Moda', 'Seguridad', 'Materiales (cemento y acero)'];
  var SECTOR_COLORS = ['#4f8cff', '#4ccf6e', '#f2b84b', '#c77dff', '#ff5d5d', '#ffd166', '#ff8f4b', '#7ec8ff', '#b08968',
    '#2f6fed', '#3ad1e0', '#8a7a66', '#9cc5ff', '#3fbf8f', '#ff7ab6', '#a78bfa', '#c9a227',
    '#5eead4', '#94a3b8', '#f87171', '#818cf8', '#fbbf24', '#86efac', '#a3e635', '#22d3ee',
    '#facc15', '#fdba74', '#f472b6', '#64748b', '#a8a29e'];
  var SECTOR_ARCH = ['torre', 'granja', 'comercio', 'torre', 'concesionario', 'hotel', 'comercio', 'torre', 'industria',
    'solar', 'agua', 'industria', 'torre', 'torre', 'torre', 'torre', 'industria',
    'torre', 'torre', 'clinica', 'escuela', 'comercio', 'comercio', 'gimnasio', 'turismo',
    'taxi', 'comercio', 'comercio', 'seguridad', 'industria'];
  var ARCH_KEYS = ['torre', 'hotel', 'comercio', 'concesionario', 'industria', 'solar', 'agua', 'granja', 'clinica', 'escuela', 'gimnasio', 'turismo', 'taxi', 'seguridad'];

  // ---- El catálogo de cuerpos (v0.10.14–15) --------------------------------------
  // Lo comparten los edificios de los barrios (edificioPartes) y los de las
  // parcelas (parcelaPartes). Marco local: origen en el centro de la huella, x a
  // lo largo de la calle, +z hacia ella; el suelo está en y = `suelo` (el cuerpo
  // arranca en 0, por debajo, para que ninguna pendiente deje hueco).
  var TONO_MAQUINAS = [0.5, 0.52, 0.56], TONO_PUERTA = [0.06, 0.07, 0.09], TONO_MARQUESINA = [0.9, 0.88, 0.82], TONO_VIDRIERA = [0.5, 0.66, 0.86], TONO_ANTENA = [0.55, 0.55, 0.58];
  // ---- El catálogo de fachadas (v0.10.16) ------------------------------------------
  // Cuatro fachadas; el número va en el atributo `aflags` de cada vértice y lo lee
  // el sombreador de edificios. Cuál lleva cada edificio sale de su morfología.
  var FACHADA_RETICULA = 0, FACHADA_LISA = 1, FACHADA_CORTINA = 2, FACHADA_CINTA = 3;
  /** La fachada de un edificio de barrio: por tipo y por el sorteo `u` de su morfología. */
  function fachadaBarrio(kind, u) {
    if (kind === 'towers') return u < 0.4 ? FACHADA_CORTINA : (u < 0.8 ? FACHADA_RETICULA : FACHADA_CINTA);
    if (kind === 'blocks') return u < 0.65 ? FACHADA_RETICULA : FACHADA_CINTA;
    return FACHADA_LISA;                                                                       // villas y naves
  }
  /** La fachada del edificio de una parcela: por arquetipo del sector y el sorteo `u` de la celda. */
  function fachadaParcela(arch, u) {
    switch (arch) {
      case 'torre': return u < 0.5 ? FACHADA_CORTINA : FACHADA_RETICULA;
      case 'hotel': case 'clinica': return u < 0.5 ? FACHADA_CINTA : FACHADA_RETICULA;
      case 'comercio': case 'gimnasio': return u < 0.5 ? FACHADA_CINTA : FACHADA_LISA;
      case 'concesionario': return FACHADA_CORTINA;
      case 'industria': case 'solar': case 'agua': case 'granja': case 'taxi': return FACHADA_LISA;
      default: return FACHADA_RETICULA;                                                      // escuela, turismo, seguridad
    }
  }
  /** Los ayudantes de un edificio: escriben en `p` con el tono `T` y el suelo en `suelo`. */
  function piezas(p, T, suelo) {
    var TC = [Math.min(1, T[0] * 0.9 + 0.08), Math.min(1, T[1] * 0.9 + 0.07), Math.min(1, T[2] * 0.9 + 0.05)];   // coronación: un punto más clara y cálida
    var K = {
      T: T, TC: TC, TP: [T[0] * 0.82, T[1] * 0.82, T[2] * 0.82], suelo: suelo,
      caja: function (sx, sy, sz, x, y, z, c) { p.push({ sx: sx, sy: sy, sz: sz, x: x || 0, y: y || 0, z: z || 0, c: c || T }); },
      peto: function (sx, sz, x, y, z) { K.caja(sx + 1.4, 1.4, sz + 1.4, x, y - 1.2, z, TC); },        // el remate sobresale 70 cm y sube 20
      corona: function (sx, sz, x, y, z, alta) {
        K.peto(sx, sz, x, y, z);
        K.caja(sx * 0.42, 4.5, sz * 0.42, x - sx * 0.14, y, z - sz * 0.14, TONO_MAQUINAS);            // cuarto de máquinas
        if (alta) p.push({ g: 'cyl', a: 6, sx: 1.4, sy: Math.max(8, (y - suelo) * 0.1), sz: 1.4, x: x + sx * 0.24, y: y, z: z + sz * 0.2, c: TONO_ANTENA });
      },
      // El portal en la cara z = zf, mirando a +z: vidriera del vestíbulo, hueco de la puerta y marquesina.
      portal: function (x, zf, ancho) {
        var g = Math.max(4, Math.min(ancho - 2, 14));
        K.caja(g, 4.4, 0.4, x, suelo, zf, TONO_VIDRIERA);
        K.caja(3.4, 3.2, 0.6, x, suelo, zf + 0.3, TONO_PUERTA);
        K.caja(Math.min(8, g), 0.35, 3.2, x, suelo + 3.8, zf + 1.4, TONO_MARQUESINA);
      }
    };
    return K;
  }
  /** Torre: lámina, podio y torre, escalonada, en L o gemelas sobre podio, según `v`. `H` es la cota de la azotea. */
  function cuerpoTorre(K, w, d, H, v, v2, alta) {
    var s0 = K.suelo, caja = K.caja, peto = K.peto, corona = K.corona;
    if (v < 0.25) {                                                                              // lámina
      caja(w, H, d); corona(w, d, 0, H, 0, alta); K.portal(0, d / 2, w);
    } else if (v < 0.5) {                                                                        // podio y torre
      caja(w, s0 + 13, d, 0, 0, 0, K.TP); peto(w, d, 0, s0 + 13, 0);
      var tw = w * 0.66, td = d * 0.66, tx = (v2 - 0.5) * w * 0.2, tz = -d * 0.1;
      caja(tw, H, td, tx, 0, tz); corona(tw, td, tx, H, tz, alta); K.portal(0, d / 2, w);
    } else if (v < 0.7) {                                                                        // escalonada
      var h1 = s0 + (H - s0) * 0.6, h2 = s0 + (H - s0) * 0.82;
      caja(w, h1, d); peto(w, d, 0, h1, 0);
      caja(w * 0.78, h2, d * 0.78, -w * 0.08, 0, -d * 0.08); peto(w * 0.78, d * 0.78, -w * 0.08, h2, -d * 0.08);
      caja(w * 0.55, H, d * 0.55, -w * 0.16, 0, -d * 0.16); corona(w * 0.55, d * 0.55, -w * 0.16, H, -d * 0.16, alta);
      K.portal(0, d / 2, w);
    } else if (v < 0.85) {                                                                       // en L
      caja(w, H, d * 0.45, 0, 0, -d * 0.275); corona(w, d * 0.45, 0, H, -d * 0.275, alta);
      var hb = s0 + (H - s0) * 0.8;
      caja(w * 0.45, hb, d, -w * 0.275, 0, 0); peto(w * 0.45, d, -w * 0.275, hb, 0);
      K.portal(w * 0.15, -d * 0.05, w * 0.5);
    } else {                                                                                     // gemelas sobre podio
      caja(w, s0 + 8, d, 0, 0, 0, K.TP); peto(w, d, 0, s0 + 8, 0);
      caja(w * 0.36, H, d * 0.72, -w * 0.3, 0, -d * 0.1); corona(w * 0.36, d * 0.72, -w * 0.3, H, -d * 0.1, alta);
      caja(w * 0.36, H, d * 0.72, w * 0.3, 0, -d * 0.1); peto(w * 0.36, d * 0.72, w * 0.3, H, -d * 0.1);
      caja(w * 0.3, 4, d * 0.3, 0, s0 + (H - s0) * 0.55, -d * 0.1, TONO_MAQUINAS);                 // la pasarela
      K.portal(0, d / 2, w);
    }
  }
  /** Bloque: barra, en L, en U con el patio a la calle o con ático retranqueado. */
  function cuerpoBloque(K, w, d, H, v) {
    var s0 = K.suelo, caja = K.caja, peto = K.peto, corona = K.corona;
    if (v < 0.35) {                                                                              // barra
      caja(w, H, d); corona(w, d, 0, H, 0, false); K.portal(0, d / 2, w);
    } else if (v < 0.6) {                                                                        // en L
      caja(w, H, d * 0.45, 0, 0, -d * 0.275); corona(w, d * 0.45, 0, H, -d * 0.275, false);
      caja(w * 0.42, H, d, -w * 0.29, 0, 0); peto(w * 0.42, d, -w * 0.29, H, 0);
      K.portal(w * 0.15, -d * 0.05, w * 0.5);
    } else if (v < 0.8) {                                                                        // en U
      caja(w, H, d * 0.42, 0, 0, -d * 0.29); corona(w, d * 0.42, 0, H, -d * 0.29, false);
      caja(w * 0.28, H, d, -w * 0.36, 0, 0); peto(w * 0.28, d, -w * 0.36, H, 0);
      caja(w * 0.28, H, d, w * 0.36, 0, 0); peto(w * 0.28, d, w * 0.36, H, 0);
      K.portal(0, -d * 0.08, w * 0.4);
    } else {                                                                                     // con ático retranqueado
      var ha = s0 + (H - s0) * 0.88;
      caja(w, ha, d); peto(w, d, 0, ha, 0);
      caja(w * 0.84, H, d * 0.84, 0, 0, -d * 0.05, K.TC); peto(w * 0.84, d * 0.84, 0, H, -d * 0.05);
      K.portal(0, d / 2, w);
    }
  }
  /** Nave: con bóveda o plana con casetones; el muelle de carga con dos portones y la puerta de la oficina. */
  function cuerpoNave(K, w, d, H, v, p) {
    var s0 = K.suelo, caja = K.caja, hv = Math.min(d * 0.5, 6);
    if (v < 0.5) { caja(w, H - hv, d); p.push({ g: 'halfcyl', sx: hv * 2, sy: w, sz: d, x: w / 2, y: H - hv, rz: Math.PI / 2, c: K.TC }); }
    else { caja(w, H, d); K.peto(w, d, 0, H, 0); caja(4, 2.5, 4, -w * 0.3, H, -d * 0.2, TONO_MAQUINAS); caja(4, 2.5, 4, 0, H, -d * 0.2, TONO_MAQUINAS); caja(4, 2.5, 4, w * 0.3, H, -d * 0.2, TONO_MAQUINAS); }
    caja(w * 0.5, 1.2, 4, w * 0.1, s0, d / 2 + 2, [0.55, 0.55, 0.55]);
    caja(4.5, 4.5, 0.5, -w * 0.02, s0, d / 2 + 0.2, TONO_PUERTA); caja(4.5, 4.5, 0.5, w * 0.22, s0, d / 2 + 0.2, TONO_PUERTA);
    caja(2, 2.6, 0.5, -w * 0.3, s0, d / 2 + 0.2, TONO_PUERTA);
  }
  /** Villa: casa con losa de tejado, tapia con cancela, puerta y marquesina. */
  function cuerpoVilla(K, w, d, H) {
    var s0 = K.suelo, caja = K.caja;
    caja(w, H, d); caja(w * 1.08, 0.8, d * 1.08, 0, H, 0, [0.9, 0.85, 0.78]);
    var mw = w + 7, md = d + 7, hueco = 3.5, tr = (mw - hueco) / 2;
    caja(0.3, 2.2, md, -mw / 2, s0, 0, TONO_MARQUESINA); caja(0.3, 2.2, md, mw / 2, s0, 0, TONO_MARQUESINA); caja(mw, 2.2, 0.3, 0, s0, -md / 2, TONO_MARQUESINA);
    caja(tr, 2.2, 0.3, -(hueco + tr) / 2, s0, md / 2, TONO_MARQUESINA); caja(tr, 2.2, 0.3, (hueco + tr) / 2, s0, md / 2, TONO_MARQUESINA);
    caja(2.4, 2.6, 0.5, 0, s0, d / 2 + 0.2, TONO_PUERTA); caja(4, 0.3, 2.2, 0, s0 + 2.6, d / 2 + 0.9, TONO_MARQUESINA);
  }
  /**
   * El edificio de una parcela (v0.10.15): el cuerpo sale del catálogo con la
   * planta que dicta la morfología de la celda (`e.v`, `e.v2`) y la altura de la
   * esbeltez (`e.sy`); cada sector conserva sus piezas propias —la piscina del
   * hotel, la chimenea y la grúa, los paneles, los depósitos, el silo, la cruz,
   * la cúpula, la bóveda, el cono y la bandera, los taxis, el mástil—, que ya no
   * se tiñen del color del sector: solo el cuerpo lleva `e.T`. Escalado con la
   * celda (huella ~0.28·CELL, alturas acotadas a [8, 400] m). El cuerpo baja
   * `suelo` metros bajo la cota de la celda para no flotar en laderas.
   * Devuelve { p: piezas, top: cota de lo más alto, hw, hd: media huella }.
   */
  function parcelaPartes(key, c, e) {
    var f = c * 0.28, suelo = clamp(c * 0.02, 3, 20), p = [], i, top, hw, hd;
    var Hf = function (k, lo, hi) { return suelo + clamp(c * k, lo || 8, hi || 400) * e.sy; };
    var K = piezas(p, e.T, suelo), caja = K.caja, v = e.v, v2 = e.v2;
    switch (key) {
      case 'torre': { var Ht = Hf(0.32); cuerpoTorre(K, f * 0.38, f * 0.38, Ht, v, v2, Ht - suelo > 150); top = Ht + 6; hw = f * 0.19; hd = f * 0.19; break; }   // v0.10.16: esbelta (69 × 208 m con la celda de 650)
      case 'hotel': { var Hh = Hf(0.14); cuerpoBloque(K, f * 1.1, f * 0.45, Hh, v * 0.8);
        caja(f * 1.12, 1.6, f * 0.47, 0, Hh - 0.4, 0, GOLD);                                         // la banda dorada de la coronación
        caja(f * 0.5, 1.2, f * 0.3, 0, suelo, f * 0.5, WATER); caja(f * 1.2, 0.6, f * 1.3, 0, suelo - 0.3, f * 0.3, [0.95, 0.9, 0.75]);   // piscina y terraza
        top = Hh + 5; hw = f * 0.55; hd = f * 0.225; break; }
      case 'comercio': { var Hc = Hf(0.05); cuerpoBloque(K, f * 0.9, f * 0.7, Hc, v < 0.5 ? 0.1 : 0.9);
        caja(f * 1.0, (Hc - suelo) * 0.12, f * 0.25, 0, suelo + (Hc - suelo) * 0.5, f * 0.45, [1, 1, 1]);   // la marquesina grande
        caja(f * 0.6, (Hc - suelo) * 0.3, f * 0.04, 0, Hc, f * 0.3, [1, 1, 0.85]);                        // el rótulo luminoso
        top = Hc + (Hc - suelo) * 0.3; hw = f * 0.45; hd = f * 0.35; break; }
      case 'concesionario': { var Hd = Hf(0.045); K.T = [0.8, 0.9, 1]; cuerpoBloque(K, f * 1.0, f * 0.6, Hd, 0.1);
        caja(f * 1.3, 0.5, f * 1.2, 0, suelo - 0.3, f * 0.35, ASPHALT); caja(f * 0.9, (Hd - suelo) * 0.25, f * 0.04, 0, Hd, f * 0.3, [1, 0.35, 0.3]);
        for (i = 0; i < 6; i++) caja(f * 0.09, 1.6, f * 0.045, -f * 0.45 + i * f * 0.18, suelo, f * 0.7, [0.9, 0.9, 0.95]);
        top = Hd + (Hd - suelo) * 0.25; hw = f * 0.5; hd = f * 0.3; break; }
      case 'industria': { var Hi = Hf(0.04); cuerpoNave(K, f * 1.2, f * 0.8, Hi, v, p);
        p.push({ g: 'cyl', a: 10, sx: f * 0.14, sy: Hf(0.09) - suelo, sz: f * 0.14, x: f * 0.75, y: suelo, z: -f * 0.3, c: [0.7, 0.7, 0.72] });   // chimenea
        caja(f * 0.05, Hf(0.12) - suelo, f * 0.05, -f * 0.7, suelo, f * 0.4, [0.9, 0.55, 0.2]); caja(f * 0.9, f * 0.04, f * 0.04, -f * 0.35, Hf(0.12), f * 0.4, [0.9, 0.55, 0.2]);   // grúa
        top = Hf(0.12) + f * 0.04; hw = f * 0.6; hd = f * 0.4; break; }
      case 'solar': { var Hs = Hf(0.02); caja(f * 0.4, Hs, f * 0.3, 0, 0, -f * 0.6); K.peto(f * 0.4, f * 0.3, 0, Hs, -f * 0.6); K.portal(0, -f * 0.45, f * 0.4);
        for (i = 0; i < 24; i++) p.push({ g: 'slab', sx: f * 0.22, sy: 0.4, sz: f * 0.12, x: -f * 0.6 + (i % 6) * f * 0.24, y: suelo + 3, z: -f * 0.25 + Math.floor(i / 6) * f * 0.2, rx: -0.45, c: [0.12, 0.18, 0.45] });
        top = Hs + 1; hw = f * 0.2; hd = f * 0.15; break; }
      case 'agua': { var Ha = Hf(0.03); caja(f * 0.7, Ha, f * 0.5); K.peto(f * 0.7, f * 0.5, 0, Ha, 0); K.portal(0, f * 0.25, f * 0.7);
        for (i = 0; i < 4; i++) p.push({ g: 'cyl', a: 14, sx: f * 0.22, sy: Hf(0.05) - suelo, sz: f * 0.22, x: -f * 0.45 + i * f * 0.3, y: suelo, z: -f * 0.45, c: [0.8, 0.9, 0.95] });
        p.push({ g: 'cyl', a: 8, sx: f * 0.05, sy: f * 1.2, sz: f * 0.05, x: 0, y: suelo + (Hf(0.05) - suelo) * 0.5, z: -f * 0.45, rz: Math.PI / 2, c: [0.3, 0.6, 0.75] });
        top = Math.max(Ha, Hf(0.05)) + 1; hw = f * 0.35; hd = f * 0.25; break; }
      case 'granja': { var Hg = Hf(0.035); K.T = [1, 1, 0.94]; caja(f * 1.2, Hg, f); caja(f * 1.26, (Hg - suelo) * 0.25, f * 1.06, 0, Hg, 0, [0.55, 1, 0.55]); K.portal(0, f * 0.5, f * 1.2);
        p.push({ g: 'cyl', a: 12, sx: f * 0.16, sy: (Hg - suelo) * 0.6, sz: f * 0.16, x: f * 0.5, y: suelo + (Hg - suelo) * 1.2, z: f * 0.4, c: [0.7, 0.7, 0.75] });
        top = Hg + (Hg - suelo) * 0.9; hw = f * 0.6; hd = f * 0.5; break; }
      case 'clinica': { var Hk = Hf(0.09); cuerpoBloque(K, f * 0.9, f * 0.6, Hk, v < 0.5 ? 0.1 : 0.9);
        caja(f * 0.12, f * 0.36, f * 0.03, f * 0.25, suelo + (Hk - suelo) * 0.5, f * 0.31, RED); caja(f * 0.36, f * 0.12, f * 0.03, f * 0.25, suelo + (Hk - suelo) * 0.5 + f * 0.12, f * 0.31, RED);
        p.push({ g: 'ring', sx: f * 0.4, sy: 1, sz: f * 0.4, x: -f * 0.7, y: suelo + 0.5, c: RED });                 // helipuerto en el jardín
        top = Hk + 5; hw = f * 0.45; hd = f * 0.3; break; }
      case 'escuela': { var He = Hf(0.07); K.T = [0.95, 0.9, 0.8]; cuerpoBloque(K, f * 1.1, f * 0.7, He, 0.7);     // en U, con el patio a la calle
        p.push({ g: 'hemi', sx: f * 0.3, sy: (He - suelo) * 0.4, sz: f * 0.3, y: He, z: -f * 0.2, c: [0.6, 0.5, 0.9] });
        caja(f * 0.5, 0.5, f * 0.4, 0, suelo - 0.25, f * 0.1, GREEN);
        top = He + (He - suelo) * 0.4; hw = f * 0.55; hd = f * 0.35; break; }
      case 'gimnasio': { var Hm = Hf(0.05); K.T = [0.9, 0.9, 0.9]; caja(f * 0.9, Hm, f * 0.7); K.peto(f * 0.9, f * 0.7, 0, Hm, 0); K.portal(0, f * 0.35, f * 0.9);
        p.push({ g: 'halfcyl', sx: (Hm - suelo) * 0.6, sy: f * 0.9, sz: f * 0.7, x: f * 0.45, y: Hm, rz: Math.PI / 2, c: [0.65, 0.9, 0.3] });
        caja(f * 0.6, 0.4, f * 0.35, 0, suelo - 0.2, f * 0.55, [0.85, 0.5, 0.3]);
        top = Hm + (Hm - suelo) * 0.3; hw = f * 0.45; hd = f * 0.35; break; }
      case 'turismo': { var Hu = Hf(0.04); caja(f * 0.5, Hu, f * 0.5); K.portal(0, f * 0.25, f * 0.5);
        p.push({ g: 'cone', a: 8, sx: f * 0.7, sy: (Hu - suelo) * 0.5, sz: f * 0.7, y: Hu, c: [0.2, 0.8, 0.85] });
        p.push({ g: 'cyl', a: 8, sx: f * 0.03, sy: Hf(0.1) - suelo, sz: f * 0.03, x: f * 0.4, y: suelo, c: [0.7, 0.7, 0.72] });
        p.push({ g: 'slab', sx: f * 0.25, sy: f * 0.15, sz: 0.5, x: f * 0.52, y: Hf(0.1) * 0.92, c: [0.9, 0.2, 0.2] });
        top = Math.max(Hu + (Hu - suelo) * 0.5, Hf(0.1)); hw = f * 0.25; hd = f * 0.25; break; }
      case 'taxi': { var Hx = Hf(0.035); caja(f * 0.5, Hx, f * 0.4, 0, 0, -f * 0.5); K.peto(f * 0.5, f * 0.4, 0, Hx, -f * 0.5); K.portal(0, -f * 0.3, f * 0.5);
        caja(f * 1.3, 0.5, f * 1.0, 0, suelo - 0.3, f * 0.2, ASPHALT);
        for (i = 0; i < 8; i++) caja(f * 0.08, 1.5, f * 0.04, -f * 0.5 + (i % 4) * f * 0.3, suelo, -f * 0.05 + Math.floor(i / 4) * f * 0.35, [1, 0.85, 0.2]);
        top = Hx + 1; hw = f * 0.25; hd = f * 0.2; break; }
      case 'seguridad': { var Hz = Hf(0.06); K.T = [0.55, 0.6, 0.68]; caja(f * 0.5, Hz, f * 0.5); K.peto(f * 0.5, f * 0.5, 0, Hz, 0); K.portal(0, f * 0.25, f * 0.5);
        p.push({ g: 'cyl', a: 8, sx: f * 0.04, sy: Hf(0.2) - suelo, sz: f * 0.04, x: f * 0.3, y: suelo, z: -f * 0.3, c: [0.75, 0.75, 0.78] });
        p.push({ g: 'sphere', sx: f * 0.1, sy: f * 0.1, sz: f * 0.1, x: f * 0.3, y: Hf(0.2), z: -f * 0.3, c: [0.95, 0.3, 0.3] });
        caja(f * 1.1, 3, 1, 0, suelo, f * 0.55, [0.6, 0.6, 0.64]);                                                     // la valla
        top = Hf(0.2) + f * 0.05; hw = f * 0.25; hd = f * 0.25; break; }
      default: { var Hq = Hf(0.1); caja(f, Hq, f * 0.8); K.peto(f, f * 0.8, 0, Hq, 0); K.portal(0, f * 0.4, f); top = Hq + 1; hw = f * 0.5; hd = f * 0.4; }
    }
    return { p: p, top: top, hw: hw, hd: hd, suelo: suelo };
  }

  /** Coche sencillo (metros reales): carrocería + cabina, color por instancia. */
  function carGeometry() {
    var out = newAcc(), W = [0.2, 0.24, 0.3], K = [0.06, 0.06, 0.07], H = [0.75, 0.75, 0.78];
    pushParts(out, [
      { sx: 4.5, sy: 0.55, sz: 1.9, y: 0.42, c: [1, 1, 1] },                                   // bajos (color de la carrocería)
      { sx: 4.2, sy: 0.22, sz: 1.94, y: 0.97, c: [1, 1, 1] },                                  // cintura
      { sx: 2.3, sy: 0.62, sz: 1.72, x: -0.15, y: 1.19, c: [1, 1, 1] },                        // habitáculo
      { g: 'slab', sx: 0.9, sy: 0.5, sz: 1.6, x: 1.05, y: 1.45, rz: 0.55, c: W },              // parabrisas
      { g: 'slab', sx: 0.7, sy: 0.5, sz: 1.6, x: -1.35, y: 1.45, rz: -0.6, c: W },             // luneta
      { g: 'slab', sx: 1.7, sy: 0.4, sz: 0.06, x: -0.15, y: 1.42, z: 0.86, c: W }, { g: 'slab', sx: 1.7, sy: 0.4, sz: 0.06, x: -0.15, y: 1.42, z: -0.86, c: W }, // ventanillas
      { sx: 0.25, sy: 0.16, sz: 0.5, x: 2.2, y: 0.72, z: 0.6, c: H }, { sx: 0.25, sy: 0.16, sz: 0.5, x: 2.2, y: 0.72, z: -0.6, c: H },   // faros
      { sx: 0.2, sy: 0.14, sz: 0.45, x: -2.2, y: 0.72, z: 0.6, c: [0.6, 0.06, 0.05] }, { sx: 0.2, sy: 0.14, sz: 0.45, x: -2.2, y: 0.72, z: -0.6, c: [0.6, 0.06, 0.05] }, // pilotos
      { g: 'cyl', a: 12, sx: 0.66, sy: 0.32, sz: 0.66, x: 1.45, y: 0.33, z: 0.98, rx: Math.PI / 2, c: K }, { g: 'cyl', a: 12, sx: 0.66, sy: 0.32, sz: 0.66, x: -1.45, y: 0.33, z: 0.98, rx: Math.PI / 2, c: K },
      { g: 'cyl', a: 12, sx: 0.66, sy: 0.32, sz: 0.66, x: 1.45, y: 0.33, z: -0.98, rx: Math.PI / 2, c: K }, { g: 'cyl', a: 12, sx: 0.66, sy: 0.32, sz: 0.66, x: -1.45, y: 0.33, z: -0.98, rx: Math.PI / 2, c: K },
      { g: 'cyl', a: 10, sx: 0.36, sy: 0.34, sz: 0.36, x: 1.45, y: 0.33, z: 0.98, rx: Math.PI / 2, c: [0.6, 0.6, 0.62] }, { g: 'cyl', a: 10, sx: 0.36, sy: 0.34, sz: 0.36, x: -1.45, y: 0.33, z: 0.98, rx: Math.PI / 2, c: [0.6, 0.6, 0.62] },
      { g: 'cyl', a: 10, sx: 0.36, sy: 0.34, sz: 0.36, x: 1.45, y: 0.33, z: -0.98, rx: Math.PI / 2, c: [0.6, 0.6, 0.62] }, { g: 'cyl', a: 10, sx: 0.36, sy: 0.34, sz: 0.36, x: -1.45, y: 0.33, z: -0.98, rx: Math.PI / 2, c: [0.6, 0.6, 0.62] }
    ]);
    return accGeometry(out);
  }
  /**
   * Avatares (v0.10.0, metros reales): cuerpo articulado en cinco piezas
   * instanciadas (tronco+cabeza, dos brazos, dos piernas) que se animan al
   * andar. Cuatro estilos de cuerpo: 0 casual con gorra, 1 kandura y gutra
   * (blanco), 2 abaya (negra), 3 traje. El color de la instancia tiñe la ropa.
   */
  var SKIN = [0.87, 0.68, 0.55], SKIN2 = [0.62, 0.42, 0.28], HAIR = [0.12, 0.09, 0.07];
  function avatarBodyGeometry(style) {
    var out = newAcc(), skin = style % 2 ? SKIN2 : SKIN, parts = [];
    var head = [{ g: 'sphere', sx: 0.27, sy: 0.3, sz: 0.27, y: 1.56, c: skin }, { g: 'cyl', a: 8, sx: 0.09, sy: 0.08, sz: 0.09, y: 1.4, c: skin }];
    if (style === 1) { // kandura + gutra
      parts = [{ g: 'tcyl', a: 12, sx: 0.55, sy: 1.42, sz: 0.4, y: 0.02, c: [1, 1, 1] }, { g: 'hemi', sx: 0.34, sy: 0.22, sz: 0.34, y: 1.62, c: [1, 1, 1] },
        { g: 'slab', sx: 0.34, sy: 0.02, sz: 0.36, y: 1.7, c: [0.1, 0.1, 0.1] }, { g: 'slab', sx: 0.36, sy: 0.55, sz: 0.06, y: 1.42, z: 0.14, c: [1, 1, 1] }];
    } else if (style === 2) { // abaya
      parts = [{ g: 'tcyl', a: 12, sx: 0.58, sy: 1.42, sz: 0.42, y: 0.02, c: [0.06, 0.06, 0.07] }, { g: 'hemi', sx: 0.33, sy: 0.24, sz: 0.33, y: 1.6, c: [0.06, 0.06, 0.07] },
        { g: 'slab', sx: 0.34, sy: 0.5, sz: 0.06, y: 1.45, z: 0.14, c: [0.06, 0.06, 0.07] }];
    } else {
      parts = [{ sx: 0.4, sy: 0.14, sz: 0.24, y: 0.72, c: style === 3 ? [0.12, 0.13, 0.18] : [0.2, 0.22, 0.3] }, // cadera / pantalón
        { sx: 0.44, sy: 0.56, sz: 0.26, y: 0.86, c: [1, 1, 1] },                                                    // camisa (color de instancia)
        { g: 'hemi', sx: 0.3, sy: 0.12, sz: 0.3, y: 1.62, c: style === 3 ? HAIR : [0.85, 0.2, 0.15] }];               // pelo o gorra
      if (style === 0) parts.push({ g: 'slab', sx: 0.3, sy: 0.03, sz: 0.16, y: 1.63, z: -0.2, c: [0.85, 0.2, 0.15] });
      if (style === 3) parts.push({ g: 'slab', sx: 0.06, sy: 0.4, sz: 0.02, y: 1.16, z: -0.14, c: [0.5, 0.08, 0.1] });
    }
    pushParts(out, parts.concat(head));
    return accGeometry(out);
  }
  function avatarLimbGeometry(kind, style) {
    var out = newAcc();
    if (kind === 'arm') pushParts(out, [{ g: 'cyl', a: 8, sx: 0.11, sy: 0.58, sz: 0.11, y: -0.58, c: [1, 1, 1] }, { g: 'sphere', sx: 0.1, sy: 0.1, sz: 0.1, y: -0.62, c: style % 2 ? SKIN2 : SKIN }]);
    else pushParts(out, [{ g: 'cyl', a: 8, sx: 0.14, sy: 0.72, sz: 0.14, y: -0.72, c: [0.2, 0.22, 0.3] }, { sx: 0.16, sy: 0.08, sz: 0.28, y: -0.76, z: -0.04, c: [0.1, 0.1, 0.1] }]);
    return accGeometry(out);
  }
  /**
   * Palmera datilera (metros): tronco recto y ocho hojas caídas; color por
   * instancia para el verde. Una sola geometría: la escala, el giro y la
   * inclinación —que antes era de la geometría y separaba las palmeras en dos
   * mallas— van en la matriz de cada instancia, así que la palmera entera se
   * inclina con su copa, y cada una lo hace distinto.
   */
  function palmGeometry() {
    var out = newAcc(), parts = [{ g: 'tcyl', a: 8, sx: 0.36, sy: 7.5, sz: 0.36, c: [0.36, 0.28, 0.2] }], k;
    for (k = 0; k < 8; k++) {
      var a = k * Math.PI / 4;
      parts.push({ g: 'slab', sx: 0.5, sy: 0.08, sz: 3.2, x: Math.sin(a) * 1.4, y: 7.6, z: Math.cos(a) * 1.4, ry: a, rx: 0.62, c: [1, 1, 1] });
    }
    parts.push({ g: 'ball', sx: 0.5, sy: 0.4, sz: 0.5, y: 7.5, c: [0.55, 0.42, 0.18] });
    pushParts(out, parts);
    return accGeometry(out);
  }
  var AVATAR_COLORS = ['#7ef0c0', '#6ea8fe', '#ffd166', '#ff6b6b', '#c77dff', '#4ccf6e', '#f2b84b', '#3ad1e0', '#f4f4f4', '#2b3a67', '#8c5a3c', '#e07a5f', '#81b29a', '#f2cc8f', '#9b5de5', '#00bbf9'];
  // Edificios en superposición (multiverso): brillo de borde, líneas de barrido y pulso lento.
  var GHOST_VS = [
    '#include <common>',
    '#include <logdepthbuf_pars_vertex>',
    'varying vec3 vN; varying vec3 vW; varying vec3 vC;',
    'void main(){',
    '  vec3 on = normal; vec4 wp = vec4(position, 1.0);',
    '  #ifdef USE_INSTANCING', '  on = mat3(instanceMatrix) * on; wp = instanceMatrix * wp;', '  #endif',
    '  vC = vec3(1.0);', '  #ifdef USE_COLOR', '  vC = color;', '  #endif', '  #ifdef USE_INSTANCING_COLOR', '  vC = instanceColor;', '  #endif',
    '  vN = normalize(mat3(modelMatrix) * on); wp = modelMatrix * wp; vW = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '  #include <logdepthbuf_vertex>',
    '}'].join('\n');
  var GHOST_FS = [
    '#include <logdepthbuf_pars_fragment>',
    'uniform float uTime; varying vec3 vN; varying vec3 vW; varying vec3 vC;',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec3 v = normalize(cameraPosition - vW);',
    '  float fres = pow(1.0 - abs(dot(normalize(vN), v)), 2.0);',
    '  float scan = 0.55 + 0.45 * sin(vW.y * 0.9 - uTime * 2.5);',
    '  float pulse = 0.8 + 0.2 * sin(uTime * 1.3);',
    '  float a = (0.28 + 0.5 * fres) * scan * pulse;',
    '  gl_FragColor = vec4(vC * (0.8 + 0.8 * fres), a);',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '}'].join('\n');
  function makeGhostMaterial(timeUniform) {
    return new THREE.ShaderMaterial({ uniforms: { uTime: timeUniform }, vertexShader: GHOST_VS, fragmentShader: GHOST_FS, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  }

  /** Mueve la etiqueta i-ésima de un conjunto sin reconstruir el atlas. */
  LabelSet.prototype.move = function (i, x, y, z) {
    var p = this.mesh.geometry.attributes.position; if (!p) return;
    var a = p.array, k;
    for (k = 0; k < 4; k++) { a[(i * 4 + k) * 3] = x; a[(i * 4 + k) * 3 + 1] = y; a[(i * 4 + k) * 3 + 2] = z; }
    p.needsUpdate = true;
    this.items[i].x = x; this.items[i].y = y; this.items[i].z = z;
  };

  // ---- Extensiones (v0.11.0) -----------------------------------------------------
  // El cliente creció hasta ser un solo fichero de casi cinco mil líneas. Desde la
  // v0.11.0 las piezas nuevas del metaverso —el umbral y los interiores, la vida
  // de la calle, el acabado de imagen, el sonido y los extras— van en módulos
  // aparte (`/city/*.js`) que se registran aquí ANTES de montar el visor. Cada
  // módulo es una fábrica `function (ctx) { return { gancho: fn, … } }`: recibe
  // el contexto del visor (escena, cámara, estado, ayudantes del genotipo…) y
  // devuelve los ganchos que quiere oír. El contrato está en
  // docs/EXTENSIONES-3D.md. Un módulo que falla no tumba el visor: su gancho se
  // salta y el error se anota una vez en la consola.
  var EXTENSIONES = [];
  function extend(nombre, fabrica) {
    if (typeof nombre !== 'string' || !nombre || typeof fabrica !== 'function') throw new Error('RamiCity3D.extend(nombre, fabrica)');
    for (var i = 0; i < EXTENSIONES.length; i++) if (EXTENSIONES[i].nombre === nombre) { EXTENSIONES[i].fabrica = fabrica; return; }
    EXTENSIONES.push({ nombre: nombre, fabrica: fabrica });
  }

  // ---------------------------------------------------------------------
  // 4. MONTAJE: mundo, cámaras, VR, bucle y API pública
  // ---------------------------------------------------------------------

  var DEFAULT_COLORS = {
    accent: '#7ef0c0', select: '#7ef0c0', hover: '#ffffff', tileFree: '#eaf3ff', tileSea: '#d2ebff', border: '#0c1a26', lease: '#4fd8ff', sale: '#ffd166',
    sky: '#cfe3f3', fog: '#e2d9c8', plant: '#3fa34d', crate: '#a8783f', road: '#4a4440',
    labelCity: '#ffffff', labelTown: '#ffe9b0', labelLandmark: '#ffd166', labelAirport: '#bfe6ff', labelBeach: '#ffd9a8', labelPort: '#c9f0ff', labelIsland: '#bfeaff', cityLabel: '#7ef0c0'
  };
  var QUALITY = {
    baja: { pr: 0.75, vr: 1.0, shadows: false, shadowMap: 1024, traffic: 0, clusters: 0.4, far: 0.6, palms: 0 },
    media: { pr: 1.0, vr: 1.2, shadows: true, shadowMap: 1536, traffic: 120, clusters: 1, far: 1, palms: 900 },
    alta: { pr: 2, vr: 1.5, shadows: true, shadowMap: 2048, traffic: 240, clusters: 1, far: 1, palms: 2200 },
    ultra: { pr: 3, vr: 2.0, shadows: true, shadowMap: 4096, traffic: 400, clusters: 1, far: 1, palms: 4000 }
  };

  function mount(container, opts) {
    opts = opts || {};
    var t = typeof opts.t === 'function' ? opts.t : function (k) { return k; };
    // Cuadrícula: valores iniciales de opts; el JSON geográfico (grid) manda al cargarse.
    var N = opts.gridSize || 64;
    var anchor = opts.anchor || { lat: 25.064, lon: 54.994, cellMeters: 650, rotationDeg: -48 };
    var CELL = anchor.cellMeters || 650, SUB = 1, VPC = 4, LIFT = 2, ASSET = 3;
    var MX = 111320, MY = 110574, rotR = 0, sinR = 0, cosR = 1;
    function applyGrid(g) {
      if (g) {
        N = g.size || N; CELL = g.cellMeters || CELL;
        anchor = { lat: g.anchor.lat, lon: g.anchor.lon, cellMeters: CELL, rotationDeg: g.rotationDeg || 0 };
      }
      SUB = CELL >= 500 ? 6 : 1; VPC = (SUB + 1) * (SUB + 1);
      LIFT = clamp(CELL * 0.002, 0.6, 3); ASSET = clamp(CELL * 0.04, 1.2, 250);
      MX = 111320 * Math.cos(anchor.lat * Math.PI / 180); MY = 110574;
      rotR = -(anchor.rotationDeg || 0) * Math.PI / 180; sinR = Math.sin(rotR); cosR = Math.cos(rotR);
    }
    applyGrid(null);
    var colors = {}, key;
    for (key in DEFAULT_COLORS) colors[key] = DEFAULT_COLORS[key];
    if (opts.theme && opts.theme.colors) for (key in opts.theme.colors) colors[key] = opts.theme.colors[key];
    var onSelect = opts.onSelect || function () {}, onHover = opts.onHover || function () {}, onMode = opts.onMode || function () {};
    var dpr = global.devicePixelRatio || 1;
    var Q = QUALITY[opts.quality] || QUALITY.media;
    var qualityName = QUALITY[opts.quality] ? opts.quality : 'media';

    // --- Comprobación de WebGL ANTES de tocar el DOM ------------------------
    var canvas = document.createElement('canvas'), gl = null;
    var glAttrs = { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false };
    try {
      gl = canvas.getContext('webgl2', glAttrs) || canvas.getContext('webgl', glAttrs) || canvas.getContext('experimental-webgl', glAttrs);
    } catch (e) { gl = null; }
    if (!gl) throw new Error(t('WebGL no disponible en este navegador/webview; se usará la vista 2D.'));

    // --- Renderer, escena, cámara, luces ---------------------------------------
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: true, alpha: false, logarithmicDepthBuffer: true });
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.72;
    renderer.setPixelRatio(Math.min(dpr, Q.pr));
    renderer.info.autoReset = true;
    renderer.shadowMap.enabled = !!Q.shadows; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvas.style.display = 'block'; canvas.style.width = '100%'; canvas.style.height = '100%';
    canvas.style.touchAction = 'none'; canvas.style.outline = 'none'; canvas.style.cursor = 'grab';
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', t('Dubái RAMI'));
    container.appendChild(canvas);

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.sky);
    scene.fog = new THREE.Fog(new THREE.Color(colors.fog), 1000, 100000);
    var camera = new THREE.PerspectiveCamera(50, 1, 2, 900000);
    var rig = new THREE.Group(); rig.add(camera); scene.add(rig);
    var sunDir = new THREE.Vector3(-0.55, 0.75, 0.35).normalize();
    var hemi = new THREE.HemisphereLight(0xdcecff, 0x9a7f60, 0.65); scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xfff1d6, 1.2); sun.position.copy(sunDir).multiplyScalar(1500); scene.add(sun); scene.add(sun.target);
    sun.castShadow = !!Q.shadows; sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
    sun.shadow.camera.near = 50; sun.shadow.camera.far = 6000; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 1.5;
    sun.shadow.camera.left = -1400; sun.shadow.camera.right = 1400; sun.shadow.camera.top = 1400; sun.shadow.camera.bottom = -1400;
    var viewportUniform = { value: new THREE.Vector2(1, 1) };
    var lodUniform = { value: 0 };
    // Entorno: el cielo se renderiza a un mapa cúbico cada vez que cambia el sol
    // (cada ~2 s); edificios y mar lo reflejan. Solo el cielo entra en él.
    var envRT = new THREE.WebGLCubeRenderTarget(128, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, encoding: THREE.LinearEncoding });
    var envCam = new THREE.CubeCamera(1, 5000, envRT);
    var skyMat = makeSkyMaterial(), skyScene = new THREE.Scene();
    skyScene.add(makeSky(1000, skyMat));
    var noiseTex = makeNoiseTexture(256, 11);
    // Los cuatro materiales de la ciudad, empotrados en el binario. Llegan
    // asíncronos: el material ya los tiene como uniforme y se refrescan solos.
    var mats = {
      asfalto: cargaMaterial('/tex/asfalto.png'), hormigon: cargaMaterial('/tex/hormigon.png'),
      arena: cargaMaterial('/tex/arena.png'), acera: cargaMaterial('/tex/acera.png')
    };
    // Uniformes compartidos por edificios, terreno y mar (sol, cielo, noche, entorno).
    var shared = {
      uSun: { value: sunDir.clone() }, uSunColor: { value: new THREE.Color(0xfff1d6) },
      uSkyColor: { value: new THREE.Color(0xdcecff) }, uGroundColor: { value: new THREE.Color(0x9a7f60) }, uNight: { value: 0 }, uDusk: { value: 0 },
      uEnv: { value: envRT.texture }
    };
    var buildMat = makeBuildingMaterial(shared, true), plainMat = makeBuildingMaterial(shared, false);
    var terrainMat = makeTerrainMaterial(shared, noiseTex, mats.arena);

    // Estado global del visor
    var S = {
      ready: false, disposed: false, visible: true, docHidden: !!document.hidden, xr: false, lod: 0, bench: null,
      field: null, geo: null, meta: null, fine: null, coarse: null, L: 60000, center: new THREE.Vector3(),
      sea: null, seabed: null, sky: null, stars: null, roads: null, towns: null, townsTop: null, lmLabels: null,
      city: null, cityHash: null, cellH: null, cellTop: null, cellSea: null, cellState: null, parcelAt: null, districts: null,
      gridCenter: new THREE.Vector3(), counts: null, inflatePath: null,
      sel: null, hover: null, frame: 0, fps: 0, fpsN: 0, fpsT: 0, lastT: 0, raf: 0,
      mode: 'orbit', hour: null, night: 0, landmarks: [], lmIndex: {}, clusterTotal: 0,
      avatars: {}, avatarOrder: [], traffic: null, gridShown: false, catastro: null, tramas: [], glorietas: [], nCruces: 0, trozosVia: 0,
      edificios: [], barrios: null, trozosBarrio: 0, parcelas: null, trozosParcela: 0, rechazadosPorHuella: 0, ocultos: 0, fantasmas: null, trozosFantasma: 0
    };
    var gridGroup = new THREE.Group(); scene.add(gridGroup);
    var pending = null, pendingFlight = null;

    function surfaceH(wx, wz) { return S.fine ? meshSurfaceHeight(S.fine, wx, wz) : 0; }
    function coarseH(wx, wz) { return S.coarse ? meshSurfaceHeight(S.coarse, wx, wz) : 0; }
    function insideMap(wx, wz) { return S.geo && wx >= 0 && wz >= 0 && wx <= S.geo.worldW && wz <= S.geo.worldH; }
    // Altura del suelo PISABLE: la malla que se dibuja (fina y la de lejos) va
    // muestreada, así que puede quedar por encima del campo de alturas crudo; si
    // se usara solo el campo, a pie la cámara se metería dentro del terreno.
    function groundH(wx, wz) { return Math.max(S.field ? S.field.atWorld(wx, wz) : 0, surfaceH(wx, wz), coarseH(wx, wz), 0); }

    // --- Cuadrícula: celda <-> local (m desde el anclaje) <-> lat/lon <-> mundo ---
    function cellLocal(x, y) { return { x: (x + 0.5) * CELL, z: (y + 0.5) * CELL }; }
    function localToLatLon(lx, lz) {
      var dx = lx * cosR + lz * sinR, dz = -lx * sinR + lz * cosR;
      return { lat: anchor.lat - dz / MY, lon: anchor.lon + dx / MX };
    }
    function latLonToLocal(lat, lon) {
      var dx = (lon - anchor.lon) * MX, dz = (anchor.lat - lat) * MY;
      return { x: dx * cosR - dz * sinR, z: dx * sinR + dz * cosR };
    }
    function latLonToCell(lat, lon) {
      var l = latLonToLocal(lat, lon), x = Math.floor(l.x / CELL), y = Math.floor(l.z / CELL);
      return { x: x, y: y, inside: (x >= 0 && y >= 0 && x < N && y < N) };
    }
    function cellLatLon(x, y) { var l = cellLocal(x, y); return localToLatLon(l.x, l.z); }
    function localToWorld(lx, lz) { var ll = localToLatLon(lx, lz); return S.geo.toWorld(ll.lat, ll.lon); }
    function worldToLocal(wx, wz) { var ll = S.geo.toLatLon(wx, wz); return latLonToLocal(ll.lat, ll.lon); }
    function worldToCell(wx, wz) {
      var l = worldToLocal(wx, wz), x = Math.floor(l.x / CELL), y = Math.floor(l.z / CELL);
      return (x >= 0 && y >= 0 && x < N && y < N) ? { x: x, y: y } : null;
    }
    function cellWorld(x, y) {
      var l = cellLocal(x, y), w = localToWorld(l.x, l.z);
      return new THREE.Vector3(w.x, (S.cellH ? S.cellH[y * N + x] : 0) + LIFT, w.z);
    }
    function rotOff(dlx, dlz) { return { x: dlx * cosR + dlz * sinR, z: -dlx * sinR + dlz * cosR }; }
    /** Ángulo de guiñada del mundo (rad, giro sobre Y) que mira al «norte» local de la cuadrícula. */
    function gridYaw() { return rotR; }

    // --- Distritos (espejo de rami-core::ciudad::distrito) -----------------------
    function esMar(x, y) { return 63 * y + 3 * x < 819; }
    function districtOf(x, y) {
      var ds = S.districts;
      if (!ds || !ds.length) return null;
      var i;
      for (i = 0; i < ds.length; i++) {
        var d = ds[i];
        if (d.clave === 'golfo' || d.clave === 'desierto') continue;
        if (x >= d.x0 && x <= d.x1 && y >= d.y0 && y <= d.y1) return d;
      }
      for (i = 0; i < ds.length; i++) if (ds[i].clave === (esMar(x, y) ? 'golfo' : 'desierto')) return ds[i];
      return null;
    }

    // --- Capa drapeada de la cuadrícula ------------------------------------------
    var C = {};
    function drapedH(hf) { return Math.max(hf, 0) + LIFT; }
    function buildTileLayer() {
      var nV = N * N * VPC, pos = new Float32Array(nV * 3), hc = new Float32Array(nV), col = new Uint8Array(nV * 4);
      var idx = nV > 65535 ? new Uint32Array(N * N * SUB * SUB * 6) : new Uint16Array(N * N * SUB * SUB * 6), q = 0;
      S.cellH = new Float32Array(N * N); S.cellTop = new Float32Array(N * N); S.cellSea = new Uint8Array(N * N);
      var x, y, i, j;
      for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
        var ci = y * N + x, base = ci * VPC, top = -1e9;
        for (j = 0; j <= SUB; j++) for (i = 0; i <= SUB; i++) {
          var w = localToWorld((x + i / SUB) * CELL, (y + j / SUB) * CELL), hf = surfaceH(w.x, w.z);
          if (hf > top) top = hf;
          var v = base + j * (SUB + 1) + i;
          pos[v * 3] = w.x; pos[v * 3 + 1] = drapedH(hf); pos[v * 3 + 2] = w.z;
          hc[v] = drapedH(coarseH(w.x, w.z));
        }
        var wc = localToWorld((x + 0.5) * CELL, (y + 0.5) * CELL);
        S.cellH[ci] = Math.max(surfaceH(wc.x, wc.z), 0); S.cellTop[ci] = top; S.cellSea[ci] = top < 0.5 ? 1 : 0;
        for (j = 0; j < SUB; j++) for (i = 0; i < SUB; i++) {
          var a = base + j * (SUB + 1) + i, b = a + 1, c = a + SUB + 1, d = c + 1;
          idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
        }
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('hc', new THREE.BufferAttribute(hc, 1));
      var ca = new THREE.BufferAttribute(col, 4, true); ca.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('cellColor', ca);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      C.tiles = new THREE.Mesh(g, makeDrapeMaterial(lodUniform, '#ffffff', 1, true));
      C.tiles.frustumCulled = false; C.tiles.renderOrder = 2; C.tiles.visible = S.gridShown;
      gridGroup.add(C.tiles);
      var M = N * SUB, nSeg = 2 * (N + 1) * M, bp = new Float32Array(nSeg * 6), bh = new Float32Array(nSeg * 2), o = 0, k, s;
      function seg(l0x, l0z, l1x, l1z) {
        var w0 = localToWorld(l0x, l0z), w1 = localToWorld(l1x, l1z);
        bp[o * 3] = w0.x; bp[o * 3 + 1] = drapedH(surfaceH(w0.x, w0.z)) + LIFT * 0.2 + 0.2; bp[o * 3 + 2] = w0.z; bh[o] = drapedH(coarseH(w0.x, w0.z)) + LIFT * 0.2 + 0.2; o++;
        bp[o * 3] = w1.x; bp[o * 3 + 1] = drapedH(surfaceH(w1.x, w1.z)) + LIFT * 0.2 + 0.2; bp[o * 3 + 2] = w1.z; bh[o] = drapedH(coarseH(w1.x, w1.z)) + LIFT * 0.2 + 0.2; o++;
      }
      for (k = 0; k <= N; k++) for (s = 0; s < M; s++) {
        seg(k * CELL, s * CELL / SUB, k * CELL, (s + 1) * CELL / SUB);
        seg(s * CELL / SUB, k * CELL, (s + 1) * CELL / SUB, k * CELL);
      }
      var bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
      bg.setAttribute('hc', new THREE.BufferAttribute(bh, 1));
      C.borders = new THREE.LineSegments(bg, makeDrapeMaterial(lodUniform, colors.border, 0.14, false));
      C.borders.frustumCulled = false; C.borders.renderOrder = 3; C.borders.visible = S.gridShown;
      gridGroup.add(C.borders);
      C.hover = cellMesh(colors.hover, 0.3); C.hover.renderOrder = 4;
      C.selFill = cellMesh(colors.select, 0.22); C.selFill.renderOrder = 5;
      var lg = new THREE.BufferGeometry(), lp = new THREE.BufferAttribute(new Float32Array(4 * SUB * 3), 3), lh = new THREE.BufferAttribute(new Float32Array(4 * SUB), 1);
      lp.setUsage(THREE.DynamicDrawUsage); lh.setUsage(THREE.DynamicDrawUsage);
      lg.setAttribute('position', lp); lg.setAttribute('hc', lh);
      C.selLoop = new THREE.LineLoop(lg, makeDrapeMaterial(lodUniform, colors.select, 1, false));
      C.selLoop.frustumCulled = false; C.selLoop.renderOrder = 6; C.selLoop.visible = false;
      gridGroup.add(C.selLoop);
    }
    function cellMesh(color, alpha) {
      var g = new THREE.BufferGeometry();
      var p = new THREE.BufferAttribute(new Float32Array(VPC * 3), 3), h = new THREE.BufferAttribute(new Float32Array(VPC), 1);
      p.setUsage(THREE.DynamicDrawUsage); h.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', p); g.setAttribute('hc', h);
      var idx = new Uint16Array(SUB * SUB * 6), q = 0, i, j;
      for (j = 0; j < SUB; j++) for (i = 0; i < SUB; i++) {
        var a = j * (SUB + 1) + i, b = a + 1, c = a + SUB + 1, d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      var m = new THREE.Mesh(g, makeDrapeMaterial(lodUniform, color, alpha, false));
      m.frustumCulled = false; m.visible = false;
      gridGroup.add(m);
      return m;
    }
    function fillCell(mesh, x, y, extra) {
      var tp = C.tiles.geometry.attributes.position.array, th = C.tiles.geometry.attributes.hc.array, base = (y * N + x) * VPC;
      var p = mesh.geometry.attributes.position, h = mesh.geometry.attributes.hc, pa = p.array, ha = h.array, k;
      for (k = 0; k < VPC; k++) {
        pa[k * 3] = tp[(base + k) * 3]; pa[k * 3 + 1] = tp[(base + k) * 3 + 1] + extra; pa[k * 3 + 2] = tp[(base + k) * 3 + 2];
        ha[k] = th[base + k] + extra;
      }
      p.needsUpdate = true; h.needsUpdate = true;
    }
    function fillLoop(mesh, x, y, extra) {
      var tp = C.tiles.geometry.attributes.position.array, th = C.tiles.geometry.attributes.hc.array, base = (y * N + x) * VPC;
      var p = mesh.geometry.attributes.position, h = mesh.geometry.attributes.hc, pa = p.array, ha = h.array, n = 0, i, j;
      function put(i, j) { var v = base + j * (SUB + 1) + i; pa[n * 3] = tp[v * 3]; pa[n * 3 + 1] = tp[v * 3 + 1] + extra; pa[n * 3 + 2] = tp[v * 3 + 2]; ha[n] = th[v] + extra; n++; }
      for (i = 0; i < SUB; i++) put(i, 0);
      for (j = 0; j < SUB; j++) put(SUB, j);
      for (i = SUB; i > 0; i--) put(i, SUB);
      for (j = SUB; j > 0; j--) put(0, j);
      p.needsUpdate = true; h.needsUpdate = true;
    }

    // --- Mallas instanciadas (edificios por sector, activos, coches, avatares) ----
    var dummy = new THREE.Object3D(), tmpColor = new THREE.Color();
    function inst(geometry, material, capacity, name, shadow) {
      var m = new THREE.InstancedMesh(geometry, material, capacity);
      m.count = 0; m.frustumCulled = false; m.name = name;
      m.castShadow = !!shadow;
      // Sin esto three no compila USE_SHADOWMAP para el objeto y getShadowMask()
      // vale 1 siempre: las sombras se verían en el suelo pero no sobre lo demás.
      m.receiveShadow = true;
      for (var i = 0; i < capacity; i++) m.setColorAt(i, tmpColor.set(0xffffff));
      m.instanceColor.needsUpdate = true;
      gridGroup.add(m);
      return m;
    }
    function place(mesh, idx, wx, wy, wz, sx, sy, sz, color, yaw) {
      dummy.position.set(wx, wy, wz); dummy.rotation.set(0, yaw === undefined ? rotR : yaw, 0); dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix(); mesh.setMatrixAt(idx, dummy.matrix);
      if (color) mesh.setColorAt(idx, color);
    }
    function finish(mesh, count) {
      mesh.count = count; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    /** Asegura capacidad `n` en la malla instanciada `C[name]` (reconstruye si hace falta). */
    function ensureCap(name, geometry, material, n, shadow) {
      var m = C[name];
      if (m && m.instanceMatrix.count >= n) return m;
      var cap = 64; while (cap < n) cap *= 2;
      if (m) { gridGroup.remove(m); m.dispose(); }
      C[name] = inst(geometry, material, cap, name, shadow);
      return C[name];
    }
    var PALMA_GEO = null;
    // El color del cuerpo de cada sector, en sRGB, para las piezas (pushPart lo linealiza).
    var SECTOR_SRGB = [];
    for (var ks = 0; ks < SECTOR_COLORS.length; ks++) {
      var hx = SECTOR_COLORS[ks].replace('#', '');
      SECTOR_SRGB.push([parseInt(hx.slice(0, 2), 16) / 255, parseInt(hx.slice(2, 4), 16) / 255, parseInt(hx.slice(4, 6), 16) / 255]);
    }
    var ghostTime = { value: 0 }, ghostMat = makeGhostMaterial(ghostTime);
    function buildCityMeshes() {
      var a = ASSET;
      var cone = new THREE.ConeGeometry(a * 0.45, a * 1.3, 7); cone.translate(0, a * 0.65, 0);
      var crate = new THREE.BoxGeometry(a * 0.7, a * 0.7, a * 0.7); crate.translate(0, a * 0.35, 0);
      var local = new THREE.BoxGeometry(a * 1.2, a * 0.9, a * 0.8); local.translate(0, a * 0.45, 0);
      var ring = new THREE.TorusGeometry(a * 0.8, a * 0.06, 6, 20); ring.rotateX(Math.PI / 2); ring.translate(0, a * 0.08, 0);
      C.plants = inst(cone, new THREE.MeshLambertMaterial({ color: 0xffffff }), 256, 'plants');
      C.crates = inst(crate, new THREE.MeshLambertMaterial({ color: 0xffffff }), 256, 'crates');
      C.locals = inst(local, plainMat, 256, 'locals');
      C.cars = inst(carGeometry(), plainMat, 256, 'cars');
      C.rings = inst(ring, new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.lease), transparent: true, opacity: 0.85 }), 256, 'rings');
      C.saleRings = inst(ring, new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.sale), transparent: true, opacity: 0.9 }), 256, 'saleRings');
      var st;
      for (st = 0; st < 4; st++) { C['avBody' + st] = inst(avatarBodyGeometry(st), plainMat, 16, 'avBody' + st, true); C['avArm' + st] = inst(avatarLimbGeometry('arm', st), plainMat, 32, 'avArm' + st, true); }
      C.avLeg = inst(avatarLimbGeometry('leg', 0), plainMat, 32, 'avLeg', true);
      PALMA_GEO = palmGeometry();
      C.ghostLabels = new LabelSet(viewportUniform, false); scene.add(C.ghostLabels.mesh);
      C.selLabel = new LabelSet(viewportUniform, false); scene.add(C.selLabel.mesh);
      C.saleLabels = new LabelSet(viewportUniform, true); scene.add(C.saleLabels.mesh);
      C.ownerLabels = new LabelSet(viewportUniform, true); scene.add(C.ownerLabels.mesh);
      C.avatarLabels = new LabelSet(viewportUniform, false); scene.add(C.avatarLabels.mesh);
    }
    var sectorColors = [], sectorRGB = [], ownRGB = [];
    var accentC = new THREE.Color(colors.accent), freeC = new THREE.Color(colors.tileFree), seaC = new THREE.Color(colors.tileSea);
    for (var kc = 0; kc < SECTOR_COLORS.length; kc++) {
      sectorColors.push(new THREE.Color(SECTOR_COLORS[kc]));
      sectorRGB.push([sectorColors[kc].r * 255, sectorColors[kc].g * 255, sectorColors[kc].b * 255]);
      tmpColor.copy(sectorColors[kc]).lerp(accentC, 0.35).multiplyScalar(1.15);
      ownRGB.push([clamp(tmpColor.r, 0, 1) * 255, clamp(tmpColor.g, 0, 1) * 255, clamp(tmpColor.b, 0, 1) * 255]);
    }
    var plantColor = new THREE.Color(colors.plant), crateColor = new THREE.Color(colors.crate);
    var FREE_RGBA = [freeC.r * 255, freeC.g * 255, freeC.b * 255, 12], SEA_RGBA = [seaC.r * 255, seaC.g * 255, seaC.b * 255, 0];
    function paintCell(col, ci, rgb, a) {
      var o = ci * VPC * 4;
      for (var k = 0; k < VPC; k++) { col[o] = rgb[0]; col[o + 1] = rgb[1]; col[o + 2] = rgb[2]; col[o + 3] = a; o += 4; }
    }
    function sectorName(k) { var sec = S.city && S.city.sectors && S.city.sectors[k]; return sec ? sec.nombre : (SECTOR_NAMES[k] || ('sector ' + k)); }

    /** Vuelca los datos de la ciudad: colores de la capa + instancias por sector + activos + carteles. */
    function applyCity(d) {
      var parcels = d.parcels || [], assets = d.assets || [];
      var n = N, i, x, y, cnt = { free: 0, sea: 0, plot: 0, own: 0, arch: {}, plants: 0, crates: 0, locals: 0, cars: 0, rings: 0, sale: 0 };
      var parcelAt = new Int32Array(n * n); for (i = 0; i < n * n; i++) parcelAt[i] = -1;
      for (i = 0; i < parcels.length; i++) {
        var p = parcels[i];
        if (p.x >= 0 && p.x < n && p.y >= 0 && p.y < n) parcelAt[p.y * n + p.x] = i;
      }
      S.parcelAt = parcelAt;
      if (d.districts && d.districts.length) S.districts = d.districts;
      var me = d.me || null, col = C.tiles.geometry.attributes.cellColor.array, state = S.cellState;
      var k, teselas = {}, parcelasSolidas = [];
      for (k = 0; k < ARCH_KEYS.length; k++) cnt.arch[ARCH_KEYS[k]] = 0;
      var saleItems = [], signItems = [];
      for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
        var ci = y * n + x, pi = parcelAt[ci];
        if (pi < 0) {
          if (S.cellSea[ci]) { paintCell(col, ci, SEA_RGBA, SEA_RGBA[3]); cnt.sea++; state[ci] = 1; }
          else { paintCell(col, ci, FREE_RGBA, FREE_RGBA[3]); cnt.free++; state[ci] = 0; }
          continue;
        }
        var pc = parcels[pi], kind = clamp(pc.kind | 0, 0, SECTOR_COLORS.length - 1), own = !!(me && pc.owner === me), pend = !!pc.pending;
        paintCell(col, ci, own ? ownRGB[kind] : sectorRGB[kind], pend ? 30 : (own ? 95 : 42));
        state[ci] = own ? 3 : 2; cnt.plot++; if (own) cnt.own++;
        var w = cellWorld(x, y);
        // Canal 1 el tono, canal 2 la esbeltez: los dos salen SOLO de (x,y), así
        // que la torre no cambia de forma ni de color cuando cambia de dueño. Lo
        // que sí depende de la cadena —los activos acuñados— se suma aparte.
        var v = 0.9 + 0.2 * real01(semillaMorfologia(x, y, 1));
        // Ropaje: dos torres de la misma forma pero de dueños distintos no son
        // idénticas. Esto SÍ cambia cuando la parcela cambia de manos, y tiene
        // que cambiar: es lo que hace que la ciudad se vea vivida.
        v *= 0.94 + 0.12 * real01(semillaRopaje(x, y, pc.owner || '', pc.since | 0));
        var sy = (pend ? 0.3 : 1) * (0.85 + 0.3 * real01(semillaMorfologia(x, y, 2)) + Math.min(pc.assets | 0, 6) * 0.03);
        var arch = SECTOR_ARCH[kind] || 'torre';
        // El edificio de la parcela (v0.10.15): su planta sale de los canales 13
        // y 14 de la morfología de la celda —solo de (x, y)—, su altura de la
        // esbeltez y su color del sector con el ropaje. Se escribe en metros en
        // la malla de su tesela, con el portal hacia el frente de la parcela
        // (+y de la cuadrícula, donde arranca el paseo a pie).
        var sr = SECTOR_SRGB[kind], ed = parcelaPartes(arch, CELL, { v: real01(semillaMorfologia(x, y, 13)), v2: real01(semillaMorfologia(x, y, 14)), sy: sy, T: [Math.min(1, sr[0] * v), Math.min(1, sr[1] * v), Math.min(1, sr[2] * v)] });
        var y0 = S.cellH[ci] + 0.5 - ed.suelo, clave = Math.floor(w.x / TESELA_VIA) + ':' + Math.floor(w.z / TESELA_VIA);
        var TT = teselas[clave] || (teselas[clave] = { acc: newAcc(), abase: [], aflags: [] });
        _m4b.compose(_pv.set(w.x, y0, w.z), _q.setFromEuler(_e.set(0, rotR, 0)), _sv.set(1, 1, 1));
        pushParts(TT.acc, ed.p, _m4b);
        var fachada = fachadaParcela(arch, real01(semillaMorfologia(x, y, 15)));
        while (TT.abase.length * 3 < TT.acc.pos.length) { TT.abase.push(y0 + ed.suelo - 1); TT.aflags.push(fachada); }
        parcelasSolidas.push({ x: w.x, z: w.z, hw: ed.hw, hd: ed.hd, yaw: rotR, y0: y0, h: ed.top, tipo: 'parcela', id: 'parcela:' + x + ':' + y, nombre: pc.name || '', celda: ci });
        cnt.arch[arch]++;
        // El rótulo (v0.10.14): el nombre único del dueño —`SetProfile` garantiza
        // que no hay dos iguales en toda la cadena— sobre la coronación de su
        // edificio. Es ropaje: cambia cuando cambia el dueño, y sin perfil no hay
        // rótulo (una dirección en hexadecimal no es un nombre).
        if (pc.handle) {
          signItems.push({ x: w.x, y: y0 + ed.top + 10, z: w.z, text: '@' + pc.handle,
            color: own ? colors.accent : '#ffffff', size: 12, bold: true, pin: true, maxDist: S.L * 0.4, priority: 2 });
        }
        if (pc.sale) {
          saleItems.push({ x: w.x, y: w.y + LIFT * 2 + clamp(CELL * 0.2, 20, 160), z: w.z, text: '💰 ' + (pc.sale / 1e8).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' RAMI', color: colors.sale, size: 12, bold: true, pin: true, maxDist: S.L * 0.6, priority: 4 });
          cnt.sale++;
        }
      }
      C.tiles.geometry.attributes.cellColor.needsUpdate = true;
      // El plano de los barrios se hizo sin conocer las parcelas (v0.10.16): el
      // edificio de barrio que se monta sobre el de una parcela comprada se oculta
      // —y sale del catastro— mientras esa parcela tenga edificio. Basta mirar la
      // celda en la que cae: el radio del de la parcela más el suyo no llega a la
      // celda vecina. Las mallas solo se rehacen si cambia alguno.
      var porCelda = {}, cambio = false, ocultos = 0, eb, ps, dxo, dzo, ra, rp, oc;
      for (i = 0; i < parcelasSolidas.length; i++) porCelda[parcelasSolidas[i].celda] = parcelasSolidas[i];
      for (i = 0; i < S.edificios.length; i++) for (k = 0; k < S.edificios[i].length; k++) {
        eb = S.edificios[i][k]; ps = eb.celda >= 0 ? porCelda[eb.celda] : null; oc = false;
        if (ps) { dxo = ps.x - eb.x; dzo = ps.z - eb.z; ra = Math.sqrt(eb.w * eb.w + eb.d * eb.d) * 0.5; rp = Math.sqrt(ps.hw * ps.hw + ps.hd * ps.hd); oc = dxo * dxo + dzo * dzo < (ra + rp) * (ra + rp) * 0.64; }
        if (oc !== eb.oculto) { eb.oculto = oc; cambio = true; }
        if (oc) ocultos++;
      }
      S.ocultos = ocultos;
      if (cambio && S.barrios) buildClusters();
      // Las mallas de las parcelas, una por tesela; y sus sólidos en el catastro,
      // en lugar de los de la ciudad anterior.
      if (S.parcelas) {
        scene.remove(S.parcelas);
        for (i = 0; i < S.parcelas.children.length; i++) S.parcelas.children[i].geometry.dispose();
      }
      S.parcelas = new THREE.Group(); S.parcelas.name = 'parcelas'; S.trozosParcela = 0;
      for (clave in teselas) {
        if (!Object.prototype.hasOwnProperty.call(teselas, clave)) continue;
        var gp = accGeometry(teselas[clave].acc);
        gp.setAttribute('abase', new THREE.Float32BufferAttribute(teselas[clave].abase, 1));
        gp.setAttribute('aflags', new THREE.Float32BufferAttribute(teselas[clave].aflags, 1));
        gp.boundingSphere.radius += 5;
        var mp = new THREE.Mesh(gp, buildMat);
        mp.castShadow = true; mp.receiveShadow = true; mp.frustumCulled = true; mp.name = 'parcela_' + clave;
        S.parcelas.add(mp); S.trozosParcela++;
      }
      scene.add(S.parcelas);
      if (S.catastro) {
        catastroQuita(S.catastro, function (so) { return so.tipo === 'parcela'; });
        for (i = 0; i < parcelasSolidas.length; i++) catastroAlta(S.catastro, parcelasSolidas[i]);
      }
      // Activos: anillos de 12 huecos alrededor del edificio; los coches en el aparcamiento del frente.
      var need = Math.max(assets.length, 1);
      C.plants = ensureCap('plants', C.plants.geometry, C.plants.material, need); C.crates = ensureCap('crates', C.crates.geometry, C.crates.material, need);
      C.locals = ensureCap('locals', C.locals.geometry, C.locals.material, need); C.cars = ensureCap('cars', C.cars.geometry, C.cars.material, need);
      C.rings = ensureCap('rings', C.rings.geometry, C.rings.material, need); C.saleRings = ensureCap('saleRings', C.saleRings.geometry, C.saleRings.material, need);
      var slots = new Uint16Array(n * n), carSlots = new Uint16Array(n * n);
      for (i = 0; i < assets.length; i++) {
        var a = assets[i];
        if (!(a.x >= 0 && a.x < n && a.y >= 0 && a.y < n)) continue;
        var cj = a.y * n + a.x, wcen = cellWorld(a.x, a.y), ax, az, off;
        if ((a.kind | 0) === 2) {
          var cs = carSlots[cj]++, row = Math.floor(cs / 8), colI = cs % 8;
          off = rotOff(-CELL * 0.14 + colI * CELL * 0.04, CELL * 0.30 + row * CELL * 0.03);
          ax = wcen.x + off.x; az = wcen.z + off.z;
          tmpColor.setHSL(hash2(i, 23), 0.65, 0.5);
          place(C.cars, cnt.cars++, ax, drapedH(surfaceH(ax, az)) + LIFT * 0.1, az, 1.4, 1.4, 1.4, tmpColor, rotR + Math.PI / 2);
          continue;
        }
        var si = slots[cj]++, ringI = (si / 12) | 0, ang = (si % 12) / 12 * Math.PI * 2 + ringI * 0.26;
        var rad = CELL * (0.34 + 0.08 * (ringI % 2));
        off = rotOff(Math.cos(ang) * rad, Math.sin(ang) * rad);
        ax = wcen.x + off.x; az = wcen.z + off.z;
        var hh = drapedH(surfaceH(ax, az)) + LIFT * 0.1;
        if ((a.kind | 0) === 1) {
          tmpColor.copy(crateColor).multiplyScalar(0.85 + 0.3 * hash2(i, 11));
          place(C.crates, cnt.crates++, ax, hh, az, 1, 1, 1, tmpColor);
        } else if ((a.kind | 0) === 3) {
          tmpColor.setHSL(0.08 + 0.05 * hash2(i, 31), 0.35, 0.72);
          place(C.locals, cnt.locals++, ax, hh, az, 1, 1 + 0.6 * hash2(i, 37), 1, tmpColor);
        } else {
          var gsc = 0.8 + 0.5 * hash2(i, 5);
          tmpColor.copy(plantColor).offsetHSL(0.03 * (hash2(i, 17) - 0.5), 0, 0.1 * (hash2(i, 19) - 0.5));
          place(C.plants, cnt.plants++, ax, hh, az, gsc, gsc, gsc, tmpColor);
        }
        if (a.lease && a.lease.active) place(C.rings, cnt.rings++, ax, hh, az, 1, 1, 1, null);
        if (a.sale) place(C.saleRings, cnt.sale, ax, hh + 0.3, az, 1.15, 1, 1.15, null);
      }
      finish(C.plants, cnt.plants); finish(C.crates, cnt.crates); finish(C.locals, cnt.locals); finish(C.cars, cnt.cars); finish(C.rings, cnt.rings);
      var saleRingCount = 0; for (i = 0; i < assets.length; i++) if (assets[i].sale) saleRingCount++;
      finish(C.saleRings, saleRingCount);
      C.saleLabels.set(saleItems.slice(0, 200));
      C.ownerLabels.set(signItems.slice(0, 300));
      S.counts = cnt;
      refreshSelection();
      emitir('ciudad', d);
    }

    // --- Catastro de sólidos ------------------------------------------------------
    // Toda la ciudad construida —los 56 hitos modelados y las miles de instancias
    // de skyline— en una rejilla espacial con la HUELLA de cada edificio: centro,
    // medidas, giro y altura. Una sola estructura que resuelve las dos cosas que
    // hasta ahora no se podían hacer:
    //
    //   chocar   a pie se atravesaban los edificios, los hitos y los coches;
    //            `empujarFuera` saca al jugador de cualquier huella.
    //   pinchar  `pick()` solo intersecta el terreno y devuelve una casilla de
    //            650 m: no había forma de señalar un edificio concreto, así que
    //            tampoco puede haber portales, escaparates ni coches a los que
    //            subir. `rayoSolido` devuelve QUÉ hay, no dónde.
    //
    // La rejilla es de 256 m, del orden de una manzana: con ~3.200 edificios en
    // 70 km de mapa, la celda típica tiene cero o un elemento y la consulta es
    // constante. La huella es una caja orientada (el giro importa: las torres del
    // skyline se colocan con una guiñada aleatoria).
    var SOLIDO_CELDA = 256;
    function catastroNuevo() {
      var nx = Math.max(1, Math.ceil((S.geo.worldW + SOLIDO_CELDA) / SOLIDO_CELDA));
      var nz = Math.max(1, Math.ceil((S.geo.worldH + SOLIDO_CELDA) / SOLIDO_CELDA));
      return { nx: nx, nz: nz, bins: new Array(nx * nz), items: [] };
    }
    /** Mete un sólido en todas las celdas que toca su huella (con el giro ya aplicado). */
    function catastroAlta(cat, so) {
      var idx = cat.items.length; cat.items.push(so);
      var r = Math.sqrt(so.hw * so.hw + so.hd * so.hd);      // radio que envuelve la caja girada
      var i0 = Math.max(0, Math.floor((so.x - r) / SOLIDO_CELDA)), i1 = Math.min(cat.nx - 1, Math.floor((so.x + r) / SOLIDO_CELDA));
      var j0 = Math.max(0, Math.floor((so.z - r) / SOLIDO_CELDA)), j1 = Math.min(cat.nz - 1, Math.floor((so.z + r) / SOLIDO_CELDA));
      for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
        var k = j * cat.nx + i;
        (cat.bins[k] || (cat.bins[k] = [])).push(idx);
      }
    }
    /** Rehace las celdas a partir de la lista de sólidos (tras quitar o cambiar alguno). */
    function catastroReconstruye(cat) {
      var items = cat.items, i;
      cat.bins = new Array(cat.nx * cat.nz); cat.items = [];
      for (i = 0; i < items.length; i++) catastroAlta(cat, items[i]);
    }
    /** Quita del catastro los sólidos que cumplen `pred` y rehace las celdas. */
    function catastroQuita(cat, pred) {
      cat.items = cat.items.filter(function (so) { return !pred(so); });
      catastroReconstruye(cat);
    }
    /**
     * ¿Cabe una huella circular de radio `r` en (wx, wz) sin montarse en ningún
     * sólido ya alzado? Dos círculos que se solapan más de un quinto de sus
     * radios se consideran montados. Mira solo las celdas vecinas: ningún
     * sólido envuelve más de 256 m.
     */
    function huellaLibre(cat, wx, wz, r) {
      var i0 = Math.max(0, Math.floor((wx - r) / SOLIDO_CELDA) - 1), i1 = Math.min(cat.nx - 1, Math.floor((wx + r) / SOLIDO_CELDA) + 1);
      var j0 = Math.max(0, Math.floor((wz - r) / SOLIDO_CELDA) - 1), j1 = Math.min(cat.nz - 1, Math.floor((wz + r) / SOLIDO_CELDA) + 1);
      var vistos = {}, i, j, n;
      for (j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) {
        var lista = cat.bins[j * cat.nx + i]; if (!lista) continue;
        for (n = 0; n < lista.length; n++) {
          var id = lista[n]; if (vistos[id]) continue; vistos[id] = 1;
          var so = cat.items[id], dx = so.x - wx, dz = so.z - wz, ro = Math.sqrt(so.hw * so.hw + so.hd * so.hd);
          if (dx * dx + dz * dz < (r + ro) * (r + ro) * 0.64) return false;
        }
      }
      return true;
    }
    /** Punto (wx,wz) en el marco local de la huella: girar por -yaw. */
    function aLocal(so, wx, wz, out) {
      var dx = wx - so.x, dz = wz - so.z, c = Math.cos(-so.yaw), sn = Math.sin(-so.yaw);
      out.x = dx * c - dz * sn; out.z = dx * sn + dz * c;
      return out;
    }
    var _loc = { x: 0, z: 0 }, _loc2 = { x: 0, z: 0 };
    /**
     * Saca un círculo de radio `r` de cualquier huella que pise, y devuelve el
     * sólido del que lo sacó (o null). Dos pasadas: salir de una esquina puede
     * meterte en el edificio de al lado.
     */
    function empujarFuera(pos, r) {
      var cat = S.catastro; if (!cat) return null;
      var choque = null, pass, i, j, k, n, lista, so, cx, cz, nx2, nz2;
      for (pass = 0; pass < 2; pass++) {
        var i0 = Math.max(0, Math.floor((pos.x - r) / SOLIDO_CELDA)), i1 = Math.min(cat.nx - 1, Math.floor((pos.x + r) / SOLIDO_CELDA));
        var j0 = Math.max(0, Math.floor((pos.z - r) / SOLIDO_CELDA)), j1 = Math.min(cat.nz - 1, Math.floor((pos.z + r) / SOLIDO_CELDA));
        var movido = false;
        for (j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) {
          lista = cat.bins[j * cat.nx + i]; if (!lista) continue;
          for (n = 0; n < lista.length; n++) {
            so = cat.items[lista[n]];
            aLocal(so, pos.x, pos.z, _loc);
            cx = clamp(_loc.x, -so.hw, so.hw); cz = clamp(_loc.z, -so.hd, so.hd);
            var ex = _loc.x - cx, ez = _loc.z - cz, d2 = ex * ex + ez * ez;
            if (d2 >= r * r) continue;                        // fuera: no toca
            var d = Math.sqrt(d2);
            if (d > 1e-4) { ex /= d; ez /= d; }                // borde: empuja por la normal
            else {                                            // dentro del todo: por la cara más cercana
              var px = so.hw - Math.abs(_loc.x), pz = so.hd - Math.abs(_loc.z);
              if (px < pz) { ex = _loc.x >= 0 ? 1 : -1; ez = 0; d = -px; } else { ex = 0; ez = _loc.z >= 0 ? 1 : -1; d = -pz; }
            }
            var empuje = r - d;
            var c = Math.cos(so.yaw), sn = Math.sin(so.yaw);   // volver al mundo
            nx2 = ex * c - ez * sn; nz2 = ex * sn + ez * c;
            pos.x += nx2 * empuje; pos.z += nz2 * empuje;
            movido = true; choque = so;
          }
        }
        if (!movido) break;
      }
      return choque;
    }
    /** El sólido cuya huella contiene (wx,wz), o null. */
    function solidoBajo(wx, wz) {
      var cat = S.catastro; if (!cat) return null;
      var i = Math.floor(wx / SOLIDO_CELDA), j = Math.floor(wz / SOLIDO_CELDA);
      if (i < 0 || j < 0 || i >= cat.nx || j >= cat.nz) return null;
      var lista = cat.bins[j * cat.nx + i]; if (!lista) return null;
      for (var n = 0; n < lista.length; n++) {
        var so = cat.items[lista[n]];
        aLocal(so, wx, wz, _loc2);
        if (Math.abs(_loc2.x) <= so.hw && Math.abs(_loc2.z) <= so.hd) return so;
      }
      return null;
    }
    /**
     * Primer sólido que corta el rayo, recorriendo la rejilla celda a celda
     * (nunca la ciudad entera). Devuelve {solido, t} o null.
     */
    function rayoSolido(o, dir, maxT) {
      var cat = S.catastro; if (!cat) return null;
      var vistos = {}, mejor = null, mejorT = maxT;
      var paso = SOLIDO_CELDA * 0.5, t = 0;
      while (t < mejorT) {
        var wx = o.x + dir.x * t, wz = o.z + dir.z * t;
        var i = Math.floor(wx / SOLIDO_CELDA), j = Math.floor(wz / SOLIDO_CELDA);
        if (i >= 0 && j >= 0 && i < cat.nx && j < cat.nz) {
          var lista = cat.bins[j * cat.nx + i];
          if (lista) for (var n = 0; n < lista.length; n++) {
            var id = lista[n]; if (vistos[id]) continue; vistos[id] = 1;
            var tt = cortaCaja(cat.items[id], o, dir, mejorT);
            if (tt !== null && tt < mejorT) { mejorT = tt; mejor = cat.items[id]; }
          }
        }
        t += paso;
      }
      return mejor ? { solido: mejor, t: mejorT } : null;
    }
    /** Rayo contra caja orientada: se gira el rayo al marco local y se hace el test de láminas. */
    function cortaCaja(so, o, dir, maxT) {
      var c = Math.cos(-so.yaw), sn = Math.sin(-so.yaw);
      var ox = o.x - so.x, oz = o.z - so.z;
      var lx = ox * c - oz * sn, lz = ox * sn + oz * c;
      var dx = dir.x * c - dir.z * sn, dz = dir.x * sn + dir.z * c;
      var t0 = 0, t1 = maxT, i, a, b, tmp;
      var mins = [-so.hw, so.y0, -so.hd], maxs = [so.hw, so.y0 + so.h, so.hd];
      var orig = [lx, o.y, lz], dirs = [dx, dir.y, dz];
      for (i = 0; i < 3; i++) {
        if (Math.abs(dirs[i]) < 1e-9) { if (orig[i] < mins[i] || orig[i] > maxs[i]) return null; continue; }
        a = (mins[i] - orig[i]) / dirs[i]; b = (maxs[i] - orig[i]) / dirs[i];
        if (a > b) { tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
        if (t0 > t1) return null;
      }
      return t0 > 0 ? t0 : (t1 > 0 ? t1 : null);
    }

    // --- Hitos y skylines --------------------------------------------------------
    function buildLandmarks(meta) {
      var list = meta.landmarks || [], acc = newAcc(), labels = [], i, parent = new THREE.Matrix4();
      S.landmarks = []; S.lmIndex = {};
      for (i = 0; i < list.length; i++) {
        var l = list[i], fn = SHAPES[l.shape] || SHAPES.tower;
        var w = S.geo.toWorld(l.lat, l.lon);
        if (w.x < 0 || w.z < 0 || w.x > S.geo.worldW || w.z > S.geo.worldH) continue;
        var hy = Math.max(surfaceH(w.x, w.z), 0);
        var dims = { h: l.h || 50, w: l.w || 60, d: l.d || 60 };
        parent.compose(new THREE.Vector3(w.x, hy - 1, w.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -(l.rot || 0) * Math.PI / 180, 0)), new THREE.Vector3(1, 1, 1));
        pushParts(acc, fn(dims, lcg(strSeed(l.id || l.name || ('lm' + i)))), parent);
        var entry = { id: l.id, name: l.name, x: w.x, y: hy, z: w.z, h: dims.h, w: dims.w, d: dims.d,
          rot: (l.rot || 0) * Math.PI / 180, lat: l.lat, lon: l.lon, shape: l.shape };
        S.landmarks.push(entry); S.lmIndex[l.id] = entry;
        // Al catastro solo lo que tiene cuerpo: una fuente o una explanada de dos
        // metros no debe frenar a nadie. La huella es una caja aunque el hito sea
        // redondo (la noria, las cúpulas): para chocar y para señalar sobra.
        if (dims.h >= 4) catastroAlta(S.catastro, { x: w.x, z: w.z, hw: dims.w * 0.5, hd: dims.d * 0.5,
          yaw: -entry.rot, y0: hy - 1, h: dims.h + 1, tipo: 'hito', id: l.id, nombre: l.name });
        labels.push({ x: w.x, y: hy + dims.h + 12, z: w.z, text: l.name, color: colors.labelLandmark, size: 12, maxDist: S.L * 0.55, bold: false, pin: true, priority: 3 });
      }
      if (acc.pos.length) {
        C.landmarks = new THREE.Mesh(accGeometry(acc), buildMat);
        C.landmarks.castShadow = true; C.landmarks.receiveShadow = true; C.landmarks.frustumCulled = false;
        scene.add(C.landmarks);
      }
      S.lmLabels = new LabelSet(viewportUniform, true); S.lmLabels.set(labels); scene.add(S.lmLabels.mesh);
    }
    // --- TRAMA: la manzana y la fachada (v0.10.14) -----------------------------------
    // Las 3.124 cajas anónimas del skyline pasan a ser edificios: planta (lámina,
    // podio y torre, escalonada, en L, gemelas sobre podio; barra, en L, en U,
    // con ático; villa con tapia; nave con bóveda o plana), coronación (peto,
    // cuarto de máquinas, antena en las altas) y portal —vidriera, puerta y
    // marquesina— hacia la calle más cercana, con la fachada paralela a ella.
    // La forma sale SOLO de la posición (semillaMorfologia), así que dos
    // máquinas deducen el mismo edificio; la posición, la altura y la huella
    // siguen saliendo de la misma serie que en la v0.10.6. Ya no son mallas
    // instanciadas de una caja escalada: un portal de tres metros no puede
    // escalar con la torre. Cada edificio se escribe en metros en la malla de su
    // tesela de ocho kilómetros, con esfera envolvente, como la calzada y las
    // palmeras. Desde la v0.10.15 un edificio no se planta sobre otro ni sobre un
    // hito (huellaLibre), y el catastro tiene exactamente los que se dibujan.
    var TONOS_BARRIO = { towers: [[0.62, 0.74, 0.86], [0.55, 0.62, 0.72], [0.82, 0.78, 0.7], [0.7, 0.8, 0.9]], blocks: [[0.88, 0.84, 0.76], [0.8, 0.8, 0.82], [0.9, 0.87, 0.8]], villas: [[0.95, 0.92, 0.85], [0.9, 0.84, 0.72]], warehouses: [[0.85, 0.85, 0.86], [0.75, 0.75, 0.78], [0.9, 0.9, 0.9]] };
    var TIPOS_BARRIO = ['towers', 'blocks', 'villas', 'warehouses'];
    /**
     * Cómo se orienta un edificio: dentro de una trama de barrio, con la fachada
     * paralela a la calle más cercana y el portal mirando a ella; fuera, con el
     * giro libre que traía. Devuelve el yaw con el que el +z local del edificio
     * (donde va el portal) apunta a la calle.
     */
    function orientaEnTrama(wx, wz, yawLibre) {
      var i, t, dx, dz, cs, sn, lx, lz, ex, ez, fx, fz;
      for (i = 0; i < S.tramas.length; i++) {
        t = S.tramas[i]; dx = wx - t.x; dz = wz - t.z;
        if (dx * dx + dz * dz > t.R * t.R) continue;
        cs = Math.cos(-t.ang); sn = Math.sin(-t.ang);
        lx = dx * cs - dz * sn; lz = dx * sn + dz * cs;
        ex = lx - Math.round(lx / t.paso) * t.paso;          // distancia con signo a la calle que corre por z local
        ez = lz - Math.round(lz / t.paso) * t.paso;          // y a la que corre por x local
        if (Math.abs(ex) <= Math.abs(ez)) { fx = ex > 0 ? -1 : 1; fz = 0; } else { fx = 0; fz = ez > 0 ? -1 : 1; }
        var wxd = fx * Math.cos(t.ang) - fz * Math.sin(t.ang), wzd = fx * Math.sin(t.ang) + fz * Math.cos(t.ang);
        return { yaw: Math.atan2(wxd, wzd), alineado: true };
      }
      return { yaw: yawLibre, alineado: false };
    }
    /** Las piezas de un edificio de barrio en su marco local (ver el catálogo de cuerpos). */
    function edificioPartes(e) {
      var p = [], K = piezas(p, e.tono, 1);
      if (e.kind === 'towers') cuerpoTorre(K, e.w, e.d, e.h, e.v, e.v2, e.h > 150);
      else if (e.kind === 'blocks') cuerpoBloque(K, e.w, e.d, e.h, e.v);
      else if (e.kind === 'villas') cuerpoVilla(K, e.w, e.d, e.h);
      else cuerpoNave(K, e.w, e.d, e.h, e.v, p);
      return p;
    }
    /**
     * El plano de los barrios: dónde va cada edificio, cuánto mide y cómo se
     * orienta. Se calcula una vez; las mallas se levantan aparte (buildClusters)
     * porque la calidad cambia cuántos se dibujan, no cuáles hay. Cada edificio
     * aceptado se da de alta en el catastro al momento, para que el siguiente no
     * se plante encima de él ni de un hito.
     */
    function planificarBarrios(meta) {
      var cl = meta.clusters || [], i, j;
      S.edificios = []; S.rechazadosPorHuella = 0;
      for (i = 0; i < cl.length; i++) {
        var c = cl[i], rnd = lcg(c.seed || (i + 1) * 7919), cw = S.geo.toWorld(c.lat, c.lon);
        var kind = TIPOS_BARRIO.indexOf(c.kind) >= 0 ? c.kind : 'blocks', lista = [], tries = 0;
        for (j = 0; j < c.count && tries < c.count * 4; tries++) {
          var ang = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * c.radius_m;
          var x = cw.x + Math.cos(ang) * rr, z = cw.z + Math.sin(ang) * rr;
          if (!insideMap(x, z)) continue;
          var hg = surfaceH(x, z);
          if (hg <= 0.3) continue; // en el agua no
          var h = c.hmin + (c.hmax - c.hmin) * Math.pow(rnd(), 1.6);
          var fw = c.kind === 'towers' ? 22 + rnd() * 20 : (c.kind === 'blocks' ? 26 + rnd() * 24 : (c.kind === 'villas' ? 12 + rnd() * 8 : 40 + rnd() * 60));
          var fd = c.kind === 'warehouses' ? 25 + rnd() * 30 : fw * (0.8 + rnd() * 0.5);
          // Un edificio no se planta en mitad de la calle. Rechazando las
          // posiciones que pisan la trama, las MANZANAS salen solas: el edificio
          // se queda donde queda sitio, que es exactamente como crece una ciudad.
          if (enCalle(x, z, Math.max(fw, fd) * 0.5)) continue;
          var yawLibre = rnd() * Math.PI, tono = rnd();
          // Ni sobre otro edificio ni sobre un hito (v0.10.15).
          if (!huellaLibre(S.catastro, x, z, Math.sqrt(fw * fw + fd * fd) * 0.5)) { S.rechazadosPorHuella++; continue; }
          var ori = orientaEnTrama(x, z, yawLibre);
          // La planta y sus detalles salen de la POSICIÓN, no de la serie del
          // barrio: canal 11 de la morfología, el mismo número en toda máquina.
          var r2 = lcg(semillaMorfologia(Math.round(x), Math.round(z), 11)), v1 = r2(), v2 = r2(), v3 = r2();
          var tl = TONOS_BARRIO[kind][Math.floor(tono * TONOS_BARRIO[kind].length)], m = 0.9 + 0.2 * hash2(j, i);
          // La celda de la cuadrícula en la que cae (o −1): si una parcela comprada
          // le pone su edificio encima, este se oculta (v0.10.16, applyCity).
          var cel = worldToCell(x, z);
          var it = { x: x, y: hg - 1, z: z, h: h + 1, w: fw, d: fd, yaw: ori.yaw, alineado: ori.alineado, kind: kind,
                     tono: [tl[0] * m, tl[1] * m, tl[2] * m], barrio: c.name || '', v: v1, v2: v2, fachada: fachadaBarrio(kind, v3),
                     celda: cel ? cel.y * N + cel.x : -1, oculto: false };
          it.solido = { x: x, z: z, hw: fw * 0.5, hd: fd * 0.5, yaw: ori.yaw, y0: it.y, h: it.h, tipo: kind, id: kind + ':' + i + ':' + j, nombre: it.barrio };
          catastroAlta(S.catastro, it.solido);
          lista.push(it);
          j++;
        }
        S.edificios.push(lista);
      }
    }
    /**
     * Las mallas de los barrios, una por tesela, con la fracción de la calidad; y
     * el catastro con exactamente esos edificios, ni uno más: en calidad «baja»
     * no se choca con lo que no se ve.
     */
    function buildClusters(meta) {
      if (meta) planificarBarrios(meta);
      var i, j, clave, teselas = {}, total = 0, f = Q.clusters, dibujados = [];
      if (S.barrios) {
        scene.remove(S.barrios);
        for (i = 0; i < S.barrios.children.length; i++) S.barrios.children[i].geometry.dispose();
      }
      S.barrios = new THREE.Group(); S.barrios.name = 'barrios'; S.trozosBarrio = 0;
      for (i = 0; i < S.edificios.length; i++) {
        var lista = S.edificios[i], n = Math.round(lista.length * f);
        for (j = 0; j < n; j++) {
          var e = lista[j];
          if (e.oculto) continue;                                                              // debajo del edificio de una parcela
          clave = Math.floor(e.x / TESELA_VIA) + ':' + Math.floor(e.z / TESELA_VIA);
          var T = teselas[clave] || (teselas[clave] = { acc: newAcc(), abase: [], aflags: [] });
          _m4b.compose(_pv.set(e.x, e.y, e.z), _q.setFromEuler(_e.set(0, e.yaw, 0)), _sv.set(1, 1, 1));
          pushParts(T.acc, edificioPartes(e), _m4b);
          while (T.abase.length * 3 < T.acc.pos.length) { T.abase.push(e.y); T.aflags.push(e.fachada); }
          dibujados.push(e.solido);
          total++;
        }
      }
      for (clave in teselas) {
        if (!Object.prototype.hasOwnProperty.call(teselas, clave)) continue;
        var g = accGeometry(teselas[clave].acc);
        g.setAttribute('abase', new THREE.Float32BufferAttribute(teselas[clave].abase, 1));
        g.setAttribute('aflags', new THREE.Float32BufferAttribute(teselas[clave].aflags, 1));
        g.boundingSphere.radius += 5;
        var mesh = new THREE.Mesh(g, buildMat);
        mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = true; mesh.name = 'barrio_' + clave;
        S.barrios.add(mesh); S.trozosBarrio++;
      }
      scene.add(S.barrios); S.clusterTotal = total;
      // El catastro se queda con los dibujados: fuera los de barrio, y de vuelta solo estos.
      catastroQuita(S.catastro, function (so) { return TIPOS_BARRIO.indexOf(so.tipo) >= 0; });
      for (i = 0; i < dibujados.length; i++) catastroAlta(S.catastro, dibujados[i]);
    }
    // --- Tráfico ambiente por las vías -------------------------------------------
    // --- Las palmeras dejan de enviarse enteras (v0.10.10) -------------------------
    // Las palmeras iban en dos mallas instanciadas marcadas «no las descartes
    // nunca»: 192.400 triángulos a la tarjeta cada cuadro, estuvieras donde
    // estuvieras, el 21 % de lo que se ve a pie. Ahora van por teselas, como la
    // calzada: cada tesela es una malla instanciada con su esfera envolvente, y la
    // que no entra en el cono de visión no se envía. En la pasada de sombra pasa lo
    // mismo con la caja del sol, que mide 700 m de lado a pie y hasta 7 km en
    // órbita lejana (updateShadowFrame).
    //
    // Three r150 no sabe calcular la esfera de una malla instanciada: la haría
    // sobre la palmera suelta, en el origen, y descartaría la tesela entera en
    // cuanto ese punto saliera de pantalla. Así que se le da hecha —centro y radio
    // de los pies de la tesela, más lo que sobresale la palmera más alta— sobre una
    // copia de la geometría, porque la esfera es de la geometría y no de la malla.
    var TESELA_PALMA = 8000;
    var PALMA_ALCANCE = 13;                     // hasta dónde llega una palmera desde su pie: 8,5 m de alto por 1,3 de escala, y la inclinación
    /**
     * Palmeras: en las celdas de costa (tierra con mar al lado) y, con menos
     * densidad, por la ciudad baja. Fijas: no dependen de la cadena.
     */
    function buildPalms() {
      var rnd = lcg(77), x, y, k, i, cap = Q.palms || 0, teselas = {}, total = 0, clave;
      if (S.palmeras) {
        gridGroup.remove(S.palmeras);
        for (i = 0; i < S.palmeras.children.length; i++) { S.palmeras.children[i].geometry.dispose(); S.palmeras.children[i].dispose(); }
      }
      S.palmeras = new THREE.Group(); S.palmeras.name = 'palmeras'; S.trozosPalma = 0; S.nPalmeras = 0;
      gridGroup.add(S.palmeras);
      if (!cap) return;
      for (y = 0; y < N && total < cap; y++) for (x = 0; x < N; x++) {
        var ci = y * N + x; if (S.cellSea[ci]) continue;
        var coast = (x > 0 && S.cellSea[ci - 1]) || (x < N - 1 && S.cellSea[ci + 1]) || (y > 0 && S.cellSea[ci - N]) || (y < N - 1 && S.cellSea[ci + N]);
        var n = coast ? 7 : (S.cellH[ci] < 25 && rnd() < 0.35 ? 2 : 0);
        for (k = 0; k < n; k++) {
          var l = { x: (x + 0.08 + rnd() * 0.84) * CELL, z: (y + 0.08 + rnd() * 0.84) * CELL };
          var w = localToWorld(l.x, l.z), h = surfaceH(w.x, w.z);
          if (h < 0.4 || h > 60) continue;
          clave = Math.floor(w.x / TESELA_PALMA) + ':' + Math.floor(w.z / TESELA_PALMA);
          (teselas[clave] || (teselas[clave] = [])).push({ x: w.x, y: h + 0.1, z: w.z, s: 0.8 + rnd() * 0.5, yaw: rnd() * Math.PI * 2, g: 0.28 + rnd() * 0.16, lean: 0.02 + rnd() * 0.1 });
          total++;
        }
      }
      for (clave in teselas) {
        if (!Object.prototype.hasOwnProperty.call(teselas, clave)) continue;
        var lista = teselas[clave], m = new THREE.InstancedMesh(PALMA_GEO.clone(), plainMat, lista.length);
        var lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity), c = new THREE.Vector3(), r = 0;
        for (i = 0; i < lista.length; i++) {
          var p = lista[i];
          // Orden XYZ explícito (el `dummy` es compartido y los avatares lo dejan
          // en YXZ): primero la inclinación sobre Z y luego el giro, así que cada
          // palmera se inclina hacia un lado distinto.
          dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, p.yaw, p.lean, 'XYZ'); dummy.scale.set(p.s, p.s, p.s);
          dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix);
          m.setColorAt(i, tmpColor.setRGB(0.12 + p.g * 0.3, p.g + 0.12, 0.08 + p.g * 0.25));
          lo.min(dummy.position); hi.max(dummy.position);
        }
        c.addVectors(lo, hi).multiplyScalar(0.5);
        for (i = 0; i < lista.length; i++) r = Math.max(r, c.distanceTo(dummy.position.set(lista[i].x, lista[i].y, lista[i].z)));
        m.geometry.boundingSphere = new THREE.Sphere(c, r + PALMA_ALCANCE);
        m.frustumCulled = true;
        // receiveShadow por lo mismo que en inst(): sin él three no compila
        // USE_SHADOWMAP para el objeto y las hojas no se sombrean entre sí.
        m.castShadow = true; m.receiveShadow = true; m.name = 'palmeras ' + clave;
        m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
        S.palmeras.add(m); S.trozosPalma++; S.nPalmeras += lista.length;
      }
    }
    function buildTrafficPaths(meta) {
      var roads = ejesDelMapa(meta), paths = [], r, i;
      for (r = 0; r < roads.length; r++) {
        var line = roads[r].pts; if (!line || line.length < 2) continue;
        var pts = [], cum = [0], len = 0, prev = null;
        for (i = 0; i < line.length; i++) {
          var w = S.geo.toWorld(line[i][1], line[i][0]);
          if (!insideMap(w.x, w.z)) { prev = null; continue; }
          var p = new THREE.Vector3(w.x, groundH(w.x, w.z) + 0.6, w.z);
          if (prev) { len += prev.distanceTo(p); cum.push(len); }
          pts.push(p); prev = p;
        }
        if (pts.length < 2 || len <= 2000) continue;
        // El ancho de la vía, medido igual que al levantarla (por su longitud
        // remuestreada), da el sitio que tiene un coche para desviarse: del
        // carril hacia el eje hasta quedarse a 1,2 m de él y hacia fuera hasta
        // quedarse a 1,2 m del bordillo.
        var m0 = remuestrea(line, S.geo, VIA_PASO), largo = 0, k;
        for (k = 0; k + 1 < m0.length; k++) largo += Math.sqrt(Math.pow(m0[k + 1].x - m0[k].x, 2) + Math.pow(m0[k + 1].z - m0[k].z, 2));
        var an = roads[r].calzada ? roads[r] : anchoVia(largo / 1000);
        paths.push({ pts: pts, cum: cum, len: len, id: paths.length, desvMin: 1.2 - COCHE_CARRIL, desvMax: an.calzada * 0.5 - 1.2 - COCHE_CARRIL });
      }
      return paths;
    }
    function buildTraffic(count) {
      if (S.traffic && S.traffic.mesh) { scene.remove(S.traffic.mesh); S.traffic.mesh.dispose(); }
      var paths = S.trafficPaths || [], cars = [], rnd = lcg(4242), i;
      if (!paths.length || count <= 0) { S.traffic = { cars: [], mesh: null }; return; }
      var total = 0; for (i = 0; i < paths.length; i++) total += paths[i].len;
      for (i = 0; i < count; i++) {
        var pick = rnd() * total, acc = 0, pi = 0;
        for (pi = 0; pi < paths.length; pi++) { acc += paths[pi].len; if (pick <= acc) break; }
        pi = Math.min(pi, paths.length - 1);
        var vc = 22 + rnd() * 14;
        cars.push({ path: paths[pi], t: rnd() * paths[pi].len, v: vc, vel: vc, dir: rnd() < 0.5 ? 1 : -1, hue: rnd(), desvio: 0, lado: 0 });
      }
      var m = new THREE.InstancedMesh(C.cars.geometry, plainMat, cars.length); m.frustumCulled = false; m.receiveShadow = true; m.name = 'traffic';
      for (i = 0; i < cars.length; i++) m.setColorAt(i, tmpColor.setHSL(cars[i].hue, cars[i].hue < 0.3 ? 0.1 : 0.6, 0.55));
      m.instanceColor.needsUpdate = true;
      scene.add(m);
      S.traffic = { cars: cars, mesh: m };
    }
    var _tp = new THREE.Vector3(), _tq = new THREE.Vector3();
    // --- Colisión con lo que se mueve (v0.10.12) ------------------------------------
    // El jugador chocaba con las fachadas y con nada más: los coches lo
    // atravesaban y él atravesaba a los demás avatares. Ahora los coches son cajas
    // orientadas por su sentido de marcha —2,3 m de medio largo y 1 m de medio
    // ancho, lo que mide la carrocería con faros y ruedas— y los avatares ajenos
    // círculos de 35 cm, y el jugador sale de los dos con el mismo empuje por la
    // normal que ya usaba con los edificios. Los coches, además, frenan: por el que
    // llevan delante en su misma vía y sentido, y por el jugador si pisa su carril,
    // y arrancan otra vez cuando el hueco se abre. Desde la v0.10.13, antes que
    // frenar por el jugador, se desvían para pasarle de largo.
    var COCHE_HL = 2.3, COCHE_HW = 1.0, AVATAR_R = 0.35;
    // Un coche a 22 m/s necesita 40 m para pararse a 6 m/s²; a 36 m/s, 108. La
    // distancia a la que empieza a frenar sale de su propia velocidad, y el
    // perfil es el de una deceleración constante: v·√(hueco / D).
    var COCHE_FRENO = 7, COCHE_DECEL = 6, COCHE_ACEL = 3;
    // El desvío (v0.10.13): el coche que ve al jugador en su carril se aparta
    // en vez de pararse, si hay sitio. El carril va a 4,5 m del eje; el coche
    // pasa a 2,4 m del jugador, por el lado que menos lo saque del carril, y se
    // mueve de lado a 2,5 m/s. Solo frena si no le da tiempo a quitarse antes
    // de llegar, o si no cabe por ningún lado.
    var COCHE_CARRIL = 4.5, DESVIO_HOLGURA = 2.4, DESVIO_V = 2.5;
    /** El punto del suelo que ocupa el jugador, o null si va volando o en órbita. */
    function jugadorEnSuelo() {
      if (S.xr) return rig.position;
      if (S.mode === 'walk' && walk.fly < 2) return walk.pos;
      return null;
    }
    /**
     * Saca un círculo de radio `r` de cualquier coche o avatar ajeno que pise y
     * devuelve qué lo empujó ('coche', 'avatar' o null). El coche se trata en su
     * marco (adelante, derecha): la misma matemática de caja que `empujarFuera`.
     */
    function empujarDeMoviles(pos, r) {
      var tocado = null, i, tr = S.traffic;
      if (tr && tr.mesh) for (i = 0; i < tr.cars.length; i++) {
        var c = tr.cars[i]; if (c.fx === undefined) continue;
        var dx = pos.x - c.x, dz = pos.z - c.z;
        if (dx * dx + dz * dz > 16) continue;                      // a más de 4 m no toca
        var al = dx * c.fx + dz * c.fz, la = -dx * c.fz + dz * c.fx;
        var cx = clamp(al, -COCHE_HL, COCHE_HL), cz = clamp(la, -COCHE_HW, COCHE_HW);
        var ex = al - cx, ez = la - cz, d2 = ex * ex + ez * ez;
        if (d2 >= r * r) continue;
        var d = Math.sqrt(d2);
        if (d > 1e-4) { ex /= d; ez /= d; }
        else {
          var px = COCHE_HL - Math.abs(al), pz = COCHE_HW - Math.abs(la);
          if (px < pz) { ex = al >= 0 ? 1 : -1; ez = 0; d = -px; } else { ex = 0; ez = la >= 0 ? 1 : -1; d = -pz; }
        }
        var emp = r - d;
        pos.x += (ex * c.fx - ez * c.fz) * emp; pos.z += (ex * c.fz + ez * c.fx) * emp;
        tocado = 'coche';
      }
      for (i = 0; i < S.avatarOrder.length; i++) {
        var e = S.avatars[S.avatarOrder[i]]; if (!e) continue;
        var ax = pos.x - e.cur.x, az = pos.z - e.cur.z, ad2 = ax * ax + az * az, rr = r + AVATAR_R;
        if (ad2 >= rr * rr) continue;
        var ad = Math.sqrt(ad2);
        if (ad < 1e-4) { ax = 1; az = 0; } else { ax /= ad; az /= ad; }
        pos.x += ax * (rr - ad); pos.z += az * (rr - ad);
        tocado = 'avatar';
      }
      // Lo que se mueve y no es coche ni avatar (los peatones de la v0.11.0) lo
      // empuja su módulo.
      var otro = emitirValor('empujar', pos, r);
      if (otro) tocado = otro;
      return tocado;
    }
    /** Por vía y sentido, cuánto hueco lleva cada coche hasta el de delante (metros por la vía). */
    function ordenaColas(cars) {
      var grupos = {}, i, k, key;
      for (i = 0; i < cars.length; i++) { key = cars[i].path.id + ':' + cars[i].dir; (grupos[key] || (grupos[key] = [])).push(cars[i]); }
      for (key in grupos) {
        if (!Object.prototype.hasOwnProperty.call(grupos, key)) continue;
        var g = grupos[key], n = g.length, len = g[0].path.len;
        g.sort(function (a, b) { return a.t - b.t; });
        for (k = 0; k < n; k++) {
          var c = g[k];
          if (n < 2) { c.hueco = 1e9; continue; }
          var d = c.dir > 0 ? g[(k + 1) % n] : g[(k - 1 + n) % n];
          var h = c.dir > 0 ? d.t - c.t : c.t - d.t;
          if (h < 0) h += len;
          c.hueco = h;
        }
      }
    }
    function updateTraffic(dt) {
      var tr = S.traffic; if (!tr || !tr.mesh) return;
      var i, j, jug = jugadorEnSuelo();
      ordenaColas(tr.cars);
      for (i = 0; i < tr.cars.length; i++) {
        var c = tr.cars[i], P = c.path;
        // El hueco libre por delante: el coche de su cola y, si el jugador pisa el
        // carril, el jugador. Se para a COCHE_FRENO metros del obstáculo; antes,
        // la velocidad sigue el perfil de una deceleración constante.
        var hueco = c.hueco, D = c.v * c.v / (2 * COCHE_DECEL), quiere = 0, enVentana = false;
        if (jug && c.fx !== undefined) {
          var dx = jug.x - c.x, dz = jug.z - c.z, al = dx * c.fx + dz * c.fz, la = -dx * c.fz + dz * c.fx;
          // El jugador por delante, dentro de la distancia de frenado: el coche
          // elige por qué lado pasarle. `lp` es dónde está el jugador respecto al
          // CENTRO del carril (derecha positiva); pasar por su izquierda es ir a
          // lp − holgura y por su derecha a lp + holgura, si cabe en la calzada.
          if (al > -COCHE_HL - 3 && al < D + COCHE_FRENO) {
            enVentana = true;
            var lp = la + c.desvio, izq = lp - DESVIO_HOLGURA, der = lp + DESVIO_HOLGURA;
            var cabeI = izq >= P.desvMin, cabeD = der <= P.desvMax;
            // El lado se elige UNA vez y se mantiene mientras quepa. Reelegido
            // cada cuadro, con el jugador en el centro del carril los dos lados
            // empatan y el coche se quedaba dudando entre uno y otro sin moverse.
            if ((c.lado < 0 && !cabeI) || (c.lado > 0 && !cabeD)) c.lado = 0;
            if (!c.lado) c.lado = cabeI && (!cabeD || Math.abs(izq) <= Math.abs(der)) ? -1 : (cabeD ? 1 : 0);
            quiere = c.lado < 0 ? izq : (c.lado > 0 ? der : c.desvio);   // sin sitio: se queda y frena
            // Frena solo si el jugador sigue en su trayectoria y no le da tiempo
            // a quitarse antes de llegar a él (o no cabe por ningún lado).
            var tLibre = Math.abs(quiere - c.desvio) / DESVIO_V;
            if (Math.abs(la) < DESVIO_HOLGURA && al < hueco && (al < COCHE_FRENO + c.vel * tLibre || !c.lado)) hueco = Math.max(0, al);
          }
        }
        if (!enVentana) c.lado = 0;
        var meta = c.v * Math.sqrt(clamp((hueco - COCHE_FRENO) / D, 0, 1));
        c.vel = meta < c.vel ? Math.max(meta, c.vel - COCHE_DECEL * 1.5 * dt) : Math.min(meta, c.vel + COCHE_ACEL * dt);
        var desvioAntes = c.desvio;
        c.desvio += clamp(quiere - c.desvio, -DESVIO_V * dt, DESVIO_V * dt);
        c.t += c.vel * dt * c.dir;
        if (c.t > P.len) c.t -= P.len; else if (c.t < 0) c.t += P.len;
        for (j = 1; j < P.cum.length && P.cum[j] < c.t; j++) {}
        j = Math.min(j, P.pts.length - 1);
        var a = P.pts[j - 1], b = P.pts[j], segLen = P.cum[j] - P.cum[j - 1] || 1, u = (c.t - P.cum[j - 1]) / segLen;
        _tp.lerpVectors(a, b, u); _tq.subVectors(b, a).normalize();
        var yaw = Math.atan2(-_tq.z, _tq.x) + (c.dir < 0 ? Math.PI : 0);
        // Al desviarse gira el morro lo que dicta su velocidad de lado: girar a
        // la derecha es girar en sentido horario visto desde arriba, o sea, yaw
        // negativo.
        if (dt > 0) yaw -= Math.atan2((c.desvio - desvioAntes) / dt, Math.max(c.vel, 1));
        // carril: a la derecha del sentido de marcha (4,5 m), más el desvío
        var side = c.dir * (COCHE_CARRIL + c.desvio);
        _tp.x += -_tq.z * side; _tp.z += _tq.x * side;
        _tp.y = groundH(_tp.x, _tp.z) + 0.4;
        // La pose se guarda: es lo que consultan el empuje del jugador y el
        // frenado del cuadro siguiente.
        c.x = _tp.x; c.z = _tp.z; c.fx = _tq.x * c.dir; c.fz = _tq.z * c.dir;
        dummy.position.copy(_tp); dummy.rotation.set(0, yaw, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
        tr.mesh.setMatrixAt(i, dummy.matrix);
      }
      tr.mesh.instanceMatrix.needsUpdate = true;
    }

    // --- Avatares (presencia efímera de la red) -----------------------------------
    function setPresence(list) {
      list = list || [];
      var seen = {}, i, changed = false;
      for (i = 0; i < list.length; i++) {
        var a = list[i]; if (!a || a.me) continue;
        seen[a.pk] = true;
        var e = S.avatars[a.pk];
        var w = S.ready ? localToWorld(a.x, a.y) : { x: 0, z: 0 };
        var ty = S.ready ? groundH(w.x, w.z) : 0;
        // Con el sello va el nombre ÚNICO de la cadena: el alias es libre y no
        // es único, así que rotular con él dejaría pasar avatares «✓ rami» que
        // no son @rami. El alias se ve en la ficha del panel, junto a su cuenta.
        var label = a.verified ? (a.handle || a.name) : (a.name || ''), verified = !!a.verified;
        var ci = a.verified ? (a.color | 0) : (a.avatar | 0), style = a.verified ? (a.style | 0) : (a.avatar | 0);
        if (!e) {
          e = S.avatars[a.pk] = { name: label, verified: verified, style: style % 4, color: new THREE.Color(AVATAR_COLORS[ci % AVATAR_COLORS.length]), cur: new THREE.Vector3(w.x, ty, w.z), tgt: new THREE.Vector3(w.x, ty, w.z), yaw: (a.yaw || 0) * Math.PI / 180, yawT: (a.yaw || 0) * Math.PI / 180, phase: hash2(i, 3) * 6, moving: 0 };
          S.avatarOrder.push(a.pk); changed = true;
        } else {
          if (e.name !== label || e.verified !== verified || e.style !== style % 4) { e.name = label; e.verified = verified; e.style = style % 4; changed = true; }
          e.tgt.set(w.x, ty, w.z); e.yawT = (a.yaw || 0) * Math.PI / 180;
          e.color.set(AVATAR_COLORS[ci % AVATAR_COLORS.length]);
        }
      }
      var keep = [];
      for (i = 0; i < S.avatarOrder.length; i++) { var pk = S.avatarOrder[i]; if (seen[pk]) keep.push(pk); else { delete S.avatars[pk]; changed = true; } }
      S.avatarOrder = keep;
      if (changed && S.ready) rebuildAvatarLabels();
    }
    function rebuildAvatarLabels() {
      var items = [], i;
      for (i = 0; i < S.avatarOrder.length; i++) {
        var e = S.avatars[S.avatarOrder[i]];
        items.push({ x: e.cur.x, y: e.cur.y + 2.3, z: e.cur.z, text: (e.verified ? '✓ ' : '🧑 ') + (e.name || t('visitante')), color: e.verified ? '#ffffff' : '#' + e.color.getHexString(), size: 12, bold: true, pin: false, maxDist: 4000, priority: 1 });
      }
      C.avatarLabels.set(items);
    }
    var _lp = new THREE.Vector3(), _lo = new THREE.Vector3();
    function limb(mesh, idx, e, ox, oy, oz, swing, sy) {
      // Pivote en el hombro/cadera: T(mundo) · Ry(guiñada) · Rx(balanceo).
      var yaw = rotR - e.yaw;
      _lo.set(ox * Math.cos(yaw) + oz * Math.sin(yaw), oy, -ox * Math.sin(yaw) + oz * Math.cos(yaw));
      dummy.position.set(e.cur.x + _lo.x, e.cur.y + e.bob + oy, e.cur.z + _lo.z);
      dummy.rotation.set(swing, yaw, 0, 'YXZ'); dummy.scale.set(1, sy || 1, 1);
      dummy.updateMatrix(); mesh.setMatrixAt(idx, dummy.matrix); mesh.setColorAt(idx, e.color);
    }
    function updateAvatars(dt) {
      var n = S.avatarOrder.length, i, k = 1 - Math.exp(-dt * 4), counts = [0, 0, 0, 0], legs = 0, st;
      for (st = 0; st < 4; st++) { C['avBody' + st] = ensureCap('avBody' + st, C['avBody' + st].geometry, C['avBody' + st].material, Math.max(n, 1), true); C['avArm' + st] = ensureCap('avArm' + st, C['avArm' + st].geometry, C['avArm' + st].material, Math.max(2 * n, 1), true); }
      C.avLeg = ensureCap('avLeg', C.avLeg.geometry, C.avLeg.material, Math.max(2 * n, 1), true);
      for (i = 0; i < n; i++) {
        var e = S.avatars[S.avatarOrder[i]];
        _lp.copy(e.cur); e.cur.lerp(e.tgt, k);
        var speed = _lp.distanceTo(e.cur) / Math.max(dt, 1e-3);
        e.moving = lerp(e.moving || 0, clamp(speed / 1.4, 0, 1), 1 - Math.exp(-dt * 6));
        e.phase = (e.phase || 0) + dt * (2.0 + 6.5 * e.moving);
        var swing = Math.sin(e.phase) * 0.7 * e.moving, robe = e.style === 1 || e.style === 2;
        e.bob = Math.abs(Math.sin(e.phase)) * 0.045 * e.moving + Math.sin(e.phase * 0.5) * 0.01;
        var dy = e.yawT - e.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); e.yaw += dy * k;
        var bi = counts[e.style]++, body = C['avBody' + e.style], arms = C['avArm' + e.style];
        // guiñada de la cuadrícula: 0 = norte local (−z local)
        place(body, bi, e.cur.x, e.cur.y + e.bob, e.cur.z, 1, 1, 1, e.color, rotR - e.yaw);
        limb(arms, bi * 2, e, -0.29, 1.34, 0, swing * 0.8, 1); limb(arms, bi * 2 + 1, e, 0.29, 1.34, 0, -swing * 0.8, 1);
        if (!robe) { limb(C.avLeg, legs++, e, -0.11, 0.76, 0, -swing, 1); limb(C.avLeg, legs++, e, 0.11, 0.76, 0, swing, 1); }
        if (C.avatarLabels.items.length > i) C.avatarLabels.move(i, e.cur.x, e.cur.y + e.bob + 2.3, e.cur.z);
      }
      for (st = 0; st < 4; st++) { finish(C['avBody' + st], counts[st]); finish(C['avArm' + st], counts[st] * 2); }
      finish(C.avLeg, legs);
    }

    // --- Multiverso: edificios en superposición ----------------------------------------
    // Lo que existe en otra punta del árbol y no en la cabeza (o es distinto) se
    // dibuja como un edificio translúcido con brillo de borde; al colapsar el
    // consenso hacia una rama, desaparece o se vuelve sólido.
    function setGhosts(list) {
      S.ghosts = list || [];
      if (!S.ready) return;
      var i, j, clave, labels = [], teselas = {};
      if (S.fantasmas) {
        scene.remove(S.fantasmas);
        for (i = 0; i < S.fantasmas.children.length; i++) S.fantasmas.children[i].geometry.dispose();
      }
      S.fantasmas = new THREE.Group(); S.fantasmas.name = 'fantasmas'; S.trozosFantasma = 0;
      for (i = 0; i < S.ghosts.length; i++) {
        var g = S.ghosts[i];
        if (!(g.x >= 0 && g.x < N && g.y >= 0 && g.y < N) || g.estado === 'solo_aqui') continue;
        var kind = clamp(g.kind | 0, 0, SECTOR_COLORS.length - 1), arch = SECTOR_ARCH[kind] || 'torre', w = cellWorld(g.x, g.y), ci = g.y * N + g.x;
        var sy = 0.85 + 0.3 * hash2(g.x + 3, g.y + 7), tinte = g.estado === 'distinta' ? [1.0, 0.45, 0.9] : [0.25, 0.9, 1.0];
        // La misma planta que tendría el edificio real de esa celda (canales 13 y
        // 14, v0.10.16): el fantasma ES ese edificio, en otra rama del árbol.
        var ed = parcelaPartes(arch, CELL, { v: real01(semillaMorfologia(g.x, g.y, 13)), v2: real01(semillaMorfologia(g.x, g.y, 14)), sy: sy, T: WHITE });
        var y0 = S.cellH[ci] + 0.5 - ed.suelo;
        clave = Math.floor(w.x / TESELA_VIA) + ':' + Math.floor(w.z / TESELA_VIA);
        var TT = teselas[clave] || (teselas[clave] = newAcc()), desde = TT.col.length;
        _m4b.compose(_pv.set(w.x, y0, w.z), _q.setFromEuler(_e.set(0, rotR, 0)), _sv.set(1.02, 1, 1.02));
        pushParts(TT, ed.p, _m4b);
        for (j = desde; j < TT.col.length; j += 3) { TT.col[j] = tinte[0]; TT.col[j + 1] = tinte[1]; TT.col[j + 2] = tinte[2]; }   // el edificio entero del color de su estado
        labels.push({ x: w.x, y: y0 + ed.top + 8, z: w.z, text: '⟂ ' + (g.name || '') + (g.tip ? ' · ' + g.tip : ''), color: g.estado === 'distinta' ? '#ffb3ec' : '#9df3ff', size: 11, bold: true, pin: true, maxDist: S.L * 0.7, priority: 3 });
      }
      for (clave in teselas) {
        if (!Object.prototype.hasOwnProperty.call(teselas, clave)) continue;
        var gp = accGeometry(teselas[clave]);
        gp.boundingSphere.radius += 5;
        var mp = new THREE.Mesh(gp, ghostMat);
        mp.frustumCulled = true; mp.name = 'fantasma_' + clave;
        S.fantasmas.add(mp); S.trozosFantasma++;
      }
      scene.add(S.fantasmas);
      C.ghostLabels.set(labels.slice(0, 200));
    }

    // --- Selección / hover ----------------------------------------------------------
    function parcelInfo(x, y) {
      if (!S.city || !S.parcelAt) return null;
      var pi = S.parcelAt[y * N + x];
      return pi >= 0 ? S.city.parcels[pi] : null;
    }
    function refreshSelection() {
      if (!S.ready) return;
      if (!S.sel) { C.selFill.visible = false; C.selLoop.visible = false; C.selLabel.mesh.visible = false; return; }
      var x = S.sel.x, y = S.sel.y;
      fillCell(C.selFill, x, y, LIFT * 0.45); fillLoop(C.selLoop, x, y, LIFT * 0.55);
      C.selFill.visible = true; C.selLoop.visible = true;
      var p = parcelInfo(x, y), d = districtOf(x, y), txt;
      if (p) {
        txt = t(sectorName(clamp(p.kind | 0, 0, SECTOR_NAMES.length - 1))) + ' (' + x + ', ' + y + ')';
        if (p.name) txt += ' · ' + p.name;
        if (S.city && S.city.me && p.owner === S.city.me) txt += ' · ' + t('Mía');
        if (p.sale) txt += ' · 💰 ' + (p.sale / 1e8).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' RAMI';
      } else txt = t(S.cellSea[y * N + x] ? 'Parcela libre (mar)' : 'Parcela libre') + ' (' + x + ', ' + y + ')';
      if (d) txt += ' · ' + d.nombre;
      var w = cellWorld(x, y);
      C.selLabel.set([{ x: w.x, y: w.y + LIFT * 2 + 6, z: w.z, text: txt, color: colors.accent, size: 13, bold: true, pin: true }]);
      C.selLabel.mesh.visible = true;
    }
    function setHover(cell) {
      var soA = cell && cell.solido ? cell.solido.id : null, soB = S.hover && S.hover.solido ? S.hover.solido.id : null;
      var same = (cell === null && S.hover === null) ||
        (cell && S.hover && cell.x === S.hover.x && cell.y === S.hover.y && soA === soB);
      if (same) return;
      S.hover = cell;
      if (cell) {
        fillCell(C.hover, cell.x, cell.y, LIFT * 0.3); C.hover.visible = true;
        canvas.style.cursor = 'pointer';
      } else { C.hover.visible = false; canvas.style.cursor = S.mode === 'walk' ? 'crosshair' : 'grab'; }
      onHover(cell ? cell.x : null, cell ? cell.y : null, cell ? cell.solido : null);
    }
    var raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), _hit = new THREE.Vector3();
    function pickSurf(wx, wz, tr) { return insideMap(wx, wz) ? Math.max(meshSurfaceHeight(tr, wx, wz), 0) : 0; }
    function rayTerrain(o, d, out) {
      var tr = S.lod ? S.coarse : S.fine, step = Math.min(tr.dx, tr.dz) * 0.6, maxH = Math.max(tr.maxH, 0);
      var tt = 0, tEnd, i;
      if (o.y > maxH) { if (d.y >= 0) return false; tt = (o.y - maxH) / -d.y; }
      tEnd = d.y < 0 ? o.y / -d.y + step : S.L * 12;
      if (o.y + d.y * tt < pickSurf(o.x + d.x * tt, o.z + d.z * tt, tr)) return false;
      var prev = tt;
      for (tt += step; tt <= tEnd; tt += step) {
        var px = o.x + d.x * tt, py = o.y + d.y * tt, pz = o.z + d.z * tt;
        if (py < pickSurf(px, pz, tr)) {
          var a = prev, b = tt;
          for (i = 0; i < 12; i++) {
            var m = (a + b) / 2;
            if (o.y + d.y * m < pickSurf(o.x + d.x * m, o.z + d.z * m, tr)) b = m; else a = m;
          }
          out.set(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
          return true;
        }
        prev = tt;
        if (py > maxH && d.y > 0) return false;
      }
      return false;
    }
    /**
     * Qué hay bajo el puntero. Devuelve {x, y, solido} —la casilla de parcela y,
     * si el rayo topa antes con un edificio, el sólido del catastro— o null.
     * Hasta ahora solo intersectaba el terreno, así que señalar un edificio
     * concreto era imposible y el suelo se «veía» a través de las torres.
     */
    function pick(clientX, clientY) {
      if (!S.ready) return null;
      var r = canvas.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      var o = raycaster.ray.origin, dir = raycaster.ray.direction;
      var suelo = rayTerrain(o, dir, _hit) ? _hit.clone() : null;
      var alcance = suelo ? o.distanceTo(suelo) : Math.min(S.L, 12000);
      var so = rayoSolido(o, dir, alcance);
      var p = so ? { x: o.x + dir.x * so.t, z: o.z + dir.z * so.t } : suelo;
      if (!p) return null;
      var cell = worldToCell(p.x, p.z);
      if (!cell) return null;
      cell.solido = so ? so.solido : null;
      return cell;
    }

    // --- Cámara orbital + modo a pie -------------------------------------------------
    var cam = {
      cur: { theta: 0.4, phi: 0.85, radius: 1000, target: new THREE.Vector3() },
      goal: { theta: 0.4, phi: 0.85, radius: 1000, target: new THREE.Vector3() },
      minR: 30, maxR: 300000, minPhi: 0.06, maxPhi: 1.45, flight: null
    };
    // A pie: posición de los pies (mundo), guiñada (rad, mundo), cabeceo, altura extra («volar»).
    var walk = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, fly: 0, speed: 1 };
    var EYE = 1.7;
    var pointers = {}, nPointers = 0, drag = null, keys = {}, pointerPos = null, pointerDirty = false;
    function cancelFlight() { cam.flight = null; }
    function setGoalTarget(v) { cam.goal.target.copy(v); cam.goal.target.y = Math.max(surfaceH(v.x, v.z), 0); }
    var _tg = new THREE.Vector3();
    function panBy(dx, dy) {
      var th = cam.cur.theta, k = cam.cur.radius * 0.0016;
      var rx = Math.cos(th), rz = -Math.sin(th), fx = -Math.sin(th), fz = -Math.cos(th);
      _tg.copy(cam.goal.target);
      _tg.x += (-rx * dx - fx * dy) * k; _tg.z += (-rz * dx - fz * dy) * k;
      _tg.x = clamp(_tg.x, -S.L, S.geo ? S.geo.worldW + S.L : S.L); _tg.z = clamp(_tg.z, -S.L, S.geo ? S.geo.worldH + S.L : S.L);
      setGoalTarget(_tg);
    }
    function zoomBy(f) { cam.goal.radius = clamp(cam.goal.radius * f, cam.minR, cam.maxR); }
    function pdist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }
    function pointerList() { var l = []; for (var id in pointers) l.push(pointers[id]); return l; }
    var L = {};
    L.pointerdown = function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
      try { canvas.focus({ preventScroll: true }); } catch (x2) {}
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY }; nPointers++;
      cancelFlight();
      if (nPointers === 1) {
        drag = { mode: (e.button === 2 || e.shiftKey) ? 'pan' : 'rotate', x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0, button: e.button };
        canvas.style.cursor = 'grabbing';
      } else if (nPointers === 2) {
        var l = pointerList(); drag = { mode: 'pinch', dist: pdist(l[0], l[1]), mx: (l[0].x + l[1].x) / 2, my: (l[0].y + l[1].y) / 2, moved: 99 };
      }
      e.preventDefault();
    };
    L.pointermove = function (e) {
      if (!pointerPos) pointerPos = { x: 0, y: 0 };
      pointerPos.x = e.clientX; pointerPos.y = e.clientY; pointerDirty = true;
      var p = pointers[e.pointerId];
      if (!p || !drag) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (S.mode === 'walk') {
        if (drag.mode === 'pinch' && nPointers === 2) {
          var lp = pointerList(), dd = pdist(lp[0], lp[1]);
          if (dd > 0 && drag.dist > 0) walk.speed = clamp(walk.speed * (dd / drag.dist), 0.25, 40);
          drag.dist = dd;
        } else { walk.yaw -= dx * 0.004; walk.pitch = clamp(walk.pitch - dy * 0.004, -1.4, 1.4); }
        return;
      }
      if (drag.mode === 'rotate') {
        cam.goal.theta -= dx * 0.006; cam.goal.phi = clamp(cam.goal.phi + dy * 0.006, cam.minPhi, cam.maxPhi);
      } else if (drag.mode === 'pan') panBy(dx, dy);
      else if (drag.mode === 'pinch' && nPointers === 2) {
        var l = pointerList(), d = pdist(l[0], l[1]), mx = (l[0].x + l[1].x) / 2, my = (l[0].y + l[1].y) / 2;
        if (d > 0 && drag.dist > 0) zoomBy(drag.dist / d);
        panBy(mx - drag.mx, my - drag.my);
        drag.dist = d; drag.mx = mx; drag.my = my;
      }
    };
    L.pointerup = function (e) {
      if (pointers[e.pointerId]) { delete pointers[e.pointerId]; nPointers--; }
      if (drag && nPointers === 0) {
        var isClick = drag.moved < 6 && (performance.now() - drag.t0) < 400 && drag.button === 0 && drag.mode !== 'pinch';
        if (isClick) { var c = pick(e.clientX, e.clientY); if (!emitirHasta('clic', infoClic(e.clientX, e.clientY, c))) doSelect(c, true); }
        drag = null; canvas.style.cursor = S.hover ? 'pointer' : (S.mode === 'walk' ? 'crosshair' : 'grab');
      } else if (drag && drag.mode === 'pinch' && nPointers === 1) {
        var l = pointerList(); drag = { mode: 'rotate', x0: l[0].x, y0: l[0].y, t0: 0, moved: 99, button: -1 };
      }
    };
    L.pointerleave = function () { pointerPos = null; pointerDirty = true; };
    L.dblclick = function (e) {
      var c = pick(e.clientX, e.clientY);
      if (c) { doSelect(c, true); if (S.mode === 'orbit') flyTo(c.x, c.y); }
      e.preventDefault();
    };
    L.wheel = function (e) {
      cancelFlight();
      var d = e.deltaMode === 1 ? e.deltaY * 33 : (e.deltaMode === 2 ? e.deltaY * 500 : e.deltaY);
      if (S.mode === 'walk') walk.speed = clamp(walk.speed * Math.exp(clamp(d, -300, 300) * 0.002), 0.25, 40);
      else zoomBy(Math.exp(clamp(d, -300, 300) * 0.0014));
      e.preventDefault();
    };
    L.contextmenu = function (e) { e.preventDefault(); };
    L.keydown = function (e) {
      if (typeof e.key !== 'string') return;
      var k = e.key.toLowerCase();
      if (emitirHasta('tecla', k, e, true)) { e.preventDefault(); return; }
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', 'q', 'e', 'shift', '+', '-', 'escape'].indexOf(k) < 0) return;
      if (k === 'escape') { doSelect(null, true); return; }
      if (k === '+') { if (S.mode === 'orbit') zoomBy(0.8); else walk.speed = Math.min(40, walk.speed * 1.5); }
      else if (k === '-') { if (S.mode === 'orbit') zoomBy(1.25); else walk.speed = Math.max(0.25, walk.speed / 1.5); }
      else keys[k] = true;
      cancelFlight(); e.preventDefault();
    };
    L.keyup = function (e) { if (typeof e.key === 'string') { var ku = e.key.toLowerCase(); delete keys[ku]; emitir('tecla', ku, e, false); } };
    L.blur = function () { keys = {}; };
    L.visibility = function () { S.docHidden = !!document.hidden; syncLoop(); };
    L.resize = function () { resize(); };
    canvas.addEventListener('pointerdown', L.pointerdown);
    canvas.addEventListener('pointermove', L.pointermove);
    canvas.addEventListener('pointerup', L.pointerup);
    canvas.addEventListener('pointercancel', L.pointerup);
    canvas.addEventListener('pointerleave', L.pointerleave);
    canvas.addEventListener('dblclick', L.dblclick);
    canvas.addEventListener('wheel', L.wheel, { passive: false });
    canvas.addEventListener('contextmenu', L.contextmenu);
    canvas.addEventListener('keydown', L.keydown);
    canvas.addEventListener('keyup', L.keyup);
    canvas.addEventListener('blur', L.blur);
    document.addEventListener('visibilitychange', L.visibility);
    global.addEventListener('resize', L.resize);
    global.addEventListener('blur', L.blur);
    var ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(function () { resize(); }); ro.observe(container); }

    function doSelect(cell, fromUser) {
      if (cell && !(cell.x >= 0 && cell.x < N && cell.y >= 0 && cell.y < N)) cell = null;
      if (fromUser && cell && S.sel && S.sel.x === cell.x && S.sel.y === cell.y) return;
      S.sel = cell ? { x: cell.x, y: cell.y } : null;
      if (cell) setParcelGrid(true);
      refreshSelection();
      if (fromUser) onSelect(cell ? cell.x : null, cell ? cell.y : null);
    }
    function fly(to, dur) {
      var from = { theta: cam.cur.theta, phi: cam.cur.phi, radius: cam.cur.radius, target: cam.cur.target.clone() };
      var dth = to.theta - from.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
      cam.flight = { t0: performance.now(), dur: dur, from: from, to: { theta: from.theta + dth, phi: to.phi, radius: clamp(to.radius, cam.minR, cam.maxR), target: to.target.clone() } };
    }
    function flyTo(x, y) {
      if (!S.ready) { pendingFlight = { fn: flyTo, args: [x, y] }; return; }
      x = clamp(x | 0, 0, N - 1); y = clamp(y | 0, 0, N - 1);
      if (S.mode === 'walk') { var w = cellWorld(x, y), off = rotOff(0, CELL * 0.42); walk.pos.set(w.x + off.x, 0, w.z + off.z); walk.yaw = rotR + Math.PI; return; }
      fly({ theta: cam.cur.theta, phi: 0.95, radius: CELL * 5.5, target: cellWorld(x, y) }, 1200);
    }
    function cityView() {
      var tg = S.gridCenter.clone(); tg.y = S.cellH[(N >> 1) * N + (N >> 1)];
      return { theta: 0.55, phi: 0.78, radius: N * CELL * 1.05, target: tg };
    }
    /** El hito más alto: el ancla del centro cuando no hay `burj_khalifa`. */
    function tallestLandmark() {
      var best = null, i;
      for (i = 0; i < S.landmarks.length; i++) if (!best || S.landmarks[i].h > best.h) best = S.landmarks[i];
      return best;
    }
    /**
     * Vista de portada: el skyline del centro desde poco más alto que las
     * torres. Es lo PRIMERO que ve quien abre la pestaña, y por eso no puede
     * ser la vista del emirato entero: a 20 km de distancia una torre de 300 m
     * ocupa un píxel, así que la ciudad desaparecía y solo quedaban la arena y
     * la cuadrícula de parcelas.
     */
    function skylineView() {
      var l = S.lmIndex.burj_khalifa || tallestLandmark();
      var tg = l ? new THREE.Vector3(l.x, l.y, l.z) : S.gridCenter.clone();
      var r = clamp(l ? l.h * 3.1 : 2600, 1800, 4200);
      // Acimut del mundo (no del tejido de parcelas): deja el desierto delante,
      // el skyline en el centro con el Burj Khalifa recortado y el golfo al fondo.
      return { theta: 3.2, phi: 1.22, radius: r, target: tg };
    }
    /**
     * Capa de parcelas: 1024 (o 4096) casillas de color sobre el suelo. Es la
     * herramienta para comprar y mirar quién tiene qué, no el paisaje; encendida
     * siempre tapaba la ciudad con una cuadrícula y era lo único que se veía.
     * Se enciende sola al seleccionar una parcela.
     */
    function setParcelGrid(on) {
      S.gridShown = !!on;
      if (C.tiles) C.tiles.visible = S.gridShown;
      if (C.borders) C.borders.visible = S.gridShown;
      return S.gridShown;
    }
    function flyToSkyline() {
      if (!S.ready) { pendingFlight = { fn: flyToSkyline, args: [] }; return; }
      if (S.mode === 'walk') setMode('orbit');
      fly(skylineView(), 1600);
    }
    function flyToCity() {
      if (!S.ready) { pendingFlight = { fn: flyToCity, args: [] }; return; }
      if (S.mode === 'walk') setMode('orbit');
      fly(cityView(), 1400);
    }
    function flyToIsland() {
      if (!S.ready) { pendingFlight = { fn: flyToIsland, args: [] }; return; }
      if (S.mode === 'walk') setMode('orbit');
      fly({ theta: 0.35 + rotR, phi: 0.72, radius: S.L * 1.05, target: S.center.clone() }, 1600);
    }
    function flyToLandmark(id) {
      if (!S.ready) { pendingFlight = { fn: flyToLandmark, args: [id] }; return; }
      var l = S.lmIndex[id]; if (!l) return false;
      var tg = new THREE.Vector3(l.x, l.y, l.z);
      if (S.mode === 'walk') { walk.pos.set(l.x, 0, l.z + Math.max(l.w, 120)); walk.yaw = 0; walk.pitch = 0.3; return true; }
      fly({ theta: cam.cur.theta, phi: 1.05, radius: Math.max(l.h * 2.2, l.w * 3, 300), target: tg }, 1400);
      return true;
    }
    /** Cambia entre órbita y a pie: a pie arranca en la parcela seleccionada (o donde apuntaba la cámara). */
    /**
     * Aparta un punto de la huella de cualquier edificio del catastro: a pie (y
     * en VR) no se empieza DENTRO de uno, que taparía la pantalla entera. Antes
     * solo miraba los 56 hitos, así que aparecer dentro de una de las 3.124
     * torres del skyline era 56 veces más probable que lo que se evitaba.
     */
    function clearOfLandmarks(x, z) {
      var pos = { x: x, z: z };
      empujarFuera(pos, 1.6);            // 1,6 m: el jugador cabe y queda en la acera
      return { x: pos.x, z: pos.z };
    }
    function setMode(m) {
      if (m !== 'walk' && m !== 'orbit') return;
      if (S.mode === m) return;
      if (m === 'walk') {
        var start = S.sel ? cellWorld(S.sel.x, S.sel.y) : cam.cur.target.clone();
        // En la calle, justo fuera de la parcela, mirando hacia su edificio y
        // nunca dentro de un hito.
        var off = S.sel ? rotOff(0, CELL * 0.5 + 12) : { x: 0, z: 0 };
        var sp = clearOfLandmarks(start.x + off.x, start.z + off.z);
        walk.pos.set(sp.x, 0, sp.z);
        walk.yaw = S.sel ? Math.atan2(-(start.x - walk.pos.x), -(start.z - walk.pos.z)) : cam.cur.theta + Math.PI; walk.pitch = 0.08; walk.fly = 0;
        S.mode = 'walk'; canvas.style.cursor = 'crosshair';
      } else {
        // Volver a la órbita sobre donde estábamos a pie.
        cam.cur.target.copy(walk.pos); cam.goal.target.copy(walk.pos); cam.cur.theta = cam.goal.theta = walk.yaw - Math.PI;
        cam.cur.phi = cam.goal.phi = 0.95; cam.cur.radius = cam.goal.radius = CELL * 2.5;
        rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0); camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
        dropUniform.value = 0;
        S.mode = 'orbit'; canvas.style.cursor = 'grab';
      }
      emitir('modo', S.mode);
      onMode(S.mode);
    }
    /** Pose del visitante en coordenadas locales de la cuadrícula (m enteros; z = altura en dm; yaw en grados desde el norte local, horario). */
    function myPose() {
      if (!S.ready) return null;
      var wx, wz, wy, yawW;
      if (S.xr) { wx = rig.position.x; wz = rig.position.z; wy = rig.position.y; yawW = rig.rotation.y; }
      else if (S.mode === 'walk') { wx = walk.pos.x; wz = walk.pos.z; wy = walk.pos.y + walk.fly; yawW = walk.yaw; }
      else { wx = cam.cur.target.x; wz = cam.cur.target.z; wy = cam.cur.target.y; yawW = cam.cur.theta + Math.PI; }
      var l = worldToLocal(wx, wz);
      var yawLocal = ((rotR - yawW) * 180 / Math.PI) % 360; if (yawLocal < 0) yawLocal += 360;
      return { x: Math.round(l.x), y: Math.round(l.z), z: Math.round(wy * 10), yaw: Math.round(yawLocal) };
    }

    // --- Día y noche (v0.10.0): un solo modelo físico para cielo, niebla, luz y reflejos ---
    var sunC = new THREE.Color(), hemiSky = new THREE.Color(), hemiGround = new THREE.Color(), fogC = new THREE.Color();
    var moonDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
    var SAND_LIN = lin3([0.78, 0.66, 0.50]);
    function dubaiHour() {
      if (S.hour !== null && S.hour !== undefined) return S.hour;
      var now = new Date();
      return ((now.getTime() / 3600000 + 4) % 24 + 24) % 24; // UTC+4
    }
    function updateSun() {
      var h = dubaiHour(), ha = (h - 12.3) * Math.PI / 12; // ángulo horario
      var elev = Math.cos(ha) * 1.19; // ~68° al mediodía
      var y = Math.sin(elev), c = Math.cos(elev);
      sunDir.set(-Math.sin(ha) * c, y, 0.42 * c).normalize();
      var night = clamp((0.04 - sunDir.y) / 0.20, 0, 1), dusk = clamp(1 - Math.abs(sunDir.y) / 0.28, 0, 1) * (1 - night);
      S.night = night;
      // Cielo físico: sol (o luna, de noche, para que haya sombras suaves).
      skyMat.uniforms.sunPosition.value.copy(sunDir).multiplyScalar(400000);
      skyMat.uniforms.uNight.value = night;
      moonDir.set(-sunDir.x, Math.max(0.35, -sunDir.y * 0.8 + 0.2), -sunDir.z).normalize();
      lightDir.copy(sunDir.y > 0.02 ? sunDir : moonDir);
      shared.uSun.value.copy(lightDir);
      shared.uNight.value = night; shared.uDusk.value = dusk; nightUniform.value = night;
      // Luz solar directa: transmitancia atmosférica hacia el sol (cálida al atardecer).
      var tr = sunTransmittance(sunDir), strength = clamp(sunDir.y * 2.2, 0, 1);
      sunC.setRGB(tr[0], tr[1], tr[2]).multiplyScalar(1.55 * strength);
      if (night > 0) sunC.lerp(new THREE.Color().setRGB(0.08, 0.11, 0.20), night);
      shared.uSunColor.value.copy(sunC);
      // Luz de cielo y de suelo, y niebla: muestras del mismo modelo. El modelo
      // da radiancia HDR; para la luz ambiente se toma su croma con una
      // intensidad acotada (el sol directo es varias veces más fuerte que el cielo).
      var zen = skyRadiance({ x: 0.3, y: 0.95, z: 0.1 }, sunDir, night);
      var hz1 = skyRadiance({ x: -sunDir.z, y: 0.03, z: sunDir.x }, sunDir, night), hz2 = skyRadiance({ x: sunDir.z, y: 0.03, z: -sunDir.x }, sunDir, night);
      var hzA = skyRadiance({ x: -sunDir.x, y: 0.05, z: -sunDir.z }, sunDir, night);
      var fog = [(hz1[0] + hz2[0] + hzA[0]) / 3, (hz1[1] + hz2[1] + hzA[1]) / 3, (hz1[2] + hz2[2] + hzA[2]) / 3];
      var mixc = [zen[0] * 0.5 + fog[0] * 0.5, zen[1] * 0.5 + fog[1] * 0.5, zen[2] * 0.5 + fog[2] * 0.5];
      var lum = 0.2126 * mixc[0] + 0.7152 * mixc[1] + 0.0722 * mixc[2], ambI = clamp(lum, 0, 1) * 0.42 + 0.02;
      hemiSky.setRGB(mixc[0] / Math.max(lum, 1e-3) * ambI, mixc[1] / Math.max(lum, 1e-3) * ambI, mixc[2] / Math.max(lum, 1e-3) * ambI);
      // Resplandor urbano: de noche el cielo físico da casi cero y la ciudad se
      // quedaba negra. Una ciudad encendida devuelve luz cálida hacia arriba, y
      // es lo que deja leer las fachadas y la calle sin falsear el modelo.
      if (night > 0) { var gl = 0.085 * night; hemiSky.r += gl; hemiSky.g += gl * 0.74; hemiSky.b += gl * 0.50; }
      hemiGround.setRGB(SAND_LIN[0], SAND_LIN[1], SAND_LIN[2]).multiply(new THREE.Color().copy(hemiSky).multiplyScalar(0.8).add(new THREE.Color().copy(sunC).multiplyScalar(0.45 * Math.max(sunDir.y, 0))));
      shared.uSkyColor.value.copy(hemiSky); shared.uGroundColor.value.copy(hemiGround);
      hemi.color.copy(hemiSky); hemi.groundColor.copy(hemiGround); hemi.intensity = 1.0;
      sun.color.copy(sunC); sun.intensity = 1.0;
      sun.position.copy(lightDir).multiplyScalar(2500);
      renderer.toneMappingExposure = 0.72 - 0.05 * dusk + 0.16 * night;
      // La niebla se mezcla DESPUÉS del tono y la codificación: se le aplica la misma curva.
      var fe = acesSRGB(fog, renderer.toneMappingExposure);
      fogC.setRGB(fe[0], fe[1], fe[2], THREE.NoColorSpace || undefined);
      if (S.stars) S.stars.material.opacity = night * 0.9;
      if (S.sea) { S.sea.material.uniforms.uNight.value = night; S.sea.material.uniforms.uSun.value.copy(lightDir); S.sea.material.uniforms.uSunColor.value.copy(sunC); }
      scene.fog.color.copy(fogC); scene.background = fogC;
      // Reflejos: el cielo actual al mapa cúbico (solo el cielo; 6 caras de 128 px).
      envCam.update(renderer, skyScene);
      emitir('sol', { dir: sunDir, luz: lightDir, noche: night, ocaso: dusk, hora: h, colorSol: sunC, cielo: hemiSky, niebla: fogC });
    }
    function setTimeOfDay(h) { S.hour = (h === null || h === undefined || isNaN(h)) ? null : clamp(Number(h), 0, 24); updateSun(); }

    // --- Calidad -------------------------------------------------------------------------
    function setQuality(name) {
      if (!QUALITY[name]) return false;
      Q = QUALITY[name]; qualityName = name;
      renderer.setPixelRatio(Math.min(dpr, Q.pr));
      renderer.shadowMap.enabled = !!Q.shadows; sun.castShadow = !!Q.shadows;
      sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      if (S.ready) { buildTraffic(Q.traffic); buildPalms(); buildClusters(); }
      scene.traverse(function (o) { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
      buildMat.needsUpdate = true; plainMat.needsUpdate = true; terrainMat.needsUpdate = true;
      emitir('calidad', name, Q);
      resize();
      return true;
    }

    // --- Construcción del mundo tras cargar los datos ----------------------------
    function buildWorld(meta, img) {
      var geo = makeGeo(meta), field = makeHeightField(img, meta.offset || 0, meta.meters_per_pixel);
      S.geo = geo; S.field = field; S.meta = meta;
      if (meta.grid && meta.grid.anchor) applyGrid(meta.grid);
      var bedH = Math.min(meta.min_h || -60, -60) - 20;
      S.fine = buildTerrain(field, geo, 512, terrainMat, bedH);
      S.coarse = buildTerrain(field, geo, 256, terrainMat, bedH);
      S.coarse.mesh.visible = false;
      S.fine.mesh.receiveShadow = true; S.coarse.mesh.receiveShadow = true;
      scene.add(S.fine.mesh); scene.add(S.coarse.mesh);
      S.L = Math.max(geo.worldW, geo.worldH);
      S.center.set(geo.worldW / 2, 0, geo.worldH / 2);
      var seaGeo = new THREE.PlaneGeometry(S.L * 8, S.L * 8, 1, 1); seaGeo.rotateX(-Math.PI / 2);
      S.sea = new THREE.Mesh(seaGeo, makeSeaMaterial(sunDir));
      S.sea.material.uniforms.uEnv.value = envRT.texture;
      S.sea.material.uniforms.uDepth.value = makeDepthTexture(img, meta.offset || 0);
      S.sea.material.uniforms.uWorld.value.set(field.width * geo.mpp, field.height * geo.mpp);
      S.sea.position.copy(S.center); S.sea.frustumCulled = false; S.sea.renderOrder = 1;
      scene.add(S.sea);
      var bedGeo = new THREE.PlaneGeometry(S.L * 8, S.L * 8, 1, 1); bedGeo.rotateX(-Math.PI / 2);
      var bedCol = new Uint8Array(3); terrainColor(bedH, 0, 0, bedCol, 0);
      S.seabed = new THREE.Mesh(bedGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(bedCol[0] / 255, bedCol[1] / 255, bedCol[2] / 255) }));
      S.seabed.position.set(S.center.x, bedH + 5, S.center.z); S.seabed.frustumCulled = false;
      scene.add(S.seabed);
      S.sky = makeSky(1000, skyMat); scene.add(S.sky);
      S.stars = makeStars(990, 1800, 99); scene.add(S.stars);
      var ejes = ejesDelMapa(meta);
      if (ejes.length) { S.roads = buildRoads(ejes, geo); if (S.roads) scene.add(S.roads); }
      var gc = localToWorld(N / 2 * CELL, N / 2 * CELL);
      S.gridCenter.set(gc.x, 0, gc.z);
      S.cellState = new Uint8Array(N * N);
      buildTileLayer();
      buildCityMeshes();
      urbanizarTerreno(S.fine, meta.clusters, geo);
      urbanizarTerreno(S.coarse, meta.clusters, geo);
      S.catastro = catastroNuevo();
      buildLandmarks(meta);
      buildClusters(meta);
      S.trafficPaths = buildTrafficPaths(meta);
      buildTraffic(Q.traffic);
      buildPalms();
      // Etiquetas de lugares
      var top = [], low = [], towns = meta.towns || [], i;
      var STYLE = { city: [colors.labelCity, 14, 1e12, true, 0], district: [colors.labelTown, 12, S.L * 0.9, false, 2], airport: [colors.labelAirport, 12, S.L * 1.3, false, 3],
        port: [colors.labelPort, 11, S.L * 0.8, false, 4], beach: [colors.labelBeach, 11, S.L * 0.8, false, 5], island: [colors.labelIsland, 12, S.L * 1.2, false, 2], landmark: [colors.labelLandmark, 11, S.L * 0.6, false, 5], peak: [colors.labelCity, 12, S.L, false, 6] };
      for (i = 0; i < towns.length; i++) {
        var tw = towns[i], w = geo.toWorld(tw.lat, tw.lon), st = STYLE[tw.kind] || STYLE.district;
        if (w.x < 0 || w.z < 0 || w.x > geo.worldW || w.z > geo.worldH) continue;
        var pre = tw.kind === 'airport' ? '✈ ' : (tw.kind === 'port' ? '⚓ ' : (tw.kind === 'beach' ? '🏖 ' : ''));
        var hy = Math.max(surfaceH(w.x, w.z), coarseH(w.x, w.z), 0) + 8;
        (tw.kind === 'city' ? top : low).push({ x: w.x, y: hy, z: w.z, text: pre + t(tw.name), color: st[0], size: st[1], maxDist: st[2], bold: st[3], pin: true, priority: st[4] });
      }
      S.townsTop = new LabelSet(viewportUniform, false); S.townsTop.set(top); scene.add(S.townsTop.mesh);
      S.towns = new LabelSet(viewportUniform, true); S.towns.set(low); scene.add(S.towns.mesh);
      cam.maxR = S.L * 4;
      var cv = skylineView();
      cam.cur.target.copy(cv.target); cam.goal.target.copy(cv.target);
      cam.cur.radius = cam.goal.radius = clamp(cv.radius, cam.minR, cam.maxR); cam.cur.phi = cam.goal.phi = cv.phi; cam.cur.theta = cam.goal.theta = cv.theta;
      updateSun();
      S.ready = true;
      if (pending) { applyCity(pending); pending = null; }
      else if (S.city) applyCity(S.city);
      if (S.ghosts && S.ghosts.length) setGhosts(S.ghosts);
      refreshSelection();
      rebuildAvatarLabels();
      emitir('listo');
      resize();
      if (pendingFlight) { var pf = pendingFlight; pendingFlight = null; pf.fn.apply(null, pf.args); }
    }
    /** Paso de remuestreo en metros: el dataset trae tramos rectos de kilómetros. */
    var VIA_PASO = 100;
    /**
     * El ancho por clase de las vías que SÍ traen jerarquía (v0.10.13): las de
     * `meta.vias`, que salen de un extracto de OpenStreetMap pasado por
     * tools/geo/osm_roads.py (el repositorio no trae ninguna; ver el README de
     * tools/geo). Las mismas tres medidas que anchoVia más la calle de barrio.
     */
    var VIA_CLASE = {
      troncal: { calzada: 42, acera: 5 },
      arteria: { calzada: 26, acera: 4 },
      secundaria: { calzada: 15, acera: 3 },
      barrio: { calzada: 10, acera: 2.4 }
    };
    /**
     * Todos los ejes que vienen del mapa, en un solo formato: `meta.roads` (las
     * polilíneas de Natural Earth y las trazadas a mano, sin ancho: se deduce de
     * la longitud) seguidas de `meta.vias` (con nombre y clase). Cada eje es
     * { pts: [[lon, lat], ...], calzada, acera, nombre }; calzada 0 = por longitud.
     */
    function ejesDelMapa(meta) {
      var out = [], i, r = (meta && meta.roads) || [], v = (meta && meta.vias) || [];
      for (i = 0; i < r.length; i++) if (r[i] && r[i].length >= 2) out.push({ pts: r[i], calzada: 0, acera: 0, nombre: '' });
      for (i = 0; i < v.length; i++) {
        var e = v[i], cl = e && VIA_CLASE[e.clase];
        if (!cl || !e.pts || e.pts.length < 2) continue;
        out.push({ pts: e.pts, calzada: cl.calzada, acera: cl.acera, nombre: e.nombre || '' });
      }
      return out;
    }
    /** El ancho sale de la longitud: el dataset no trae jerarquía ni carriles. */
    function anchoVia(km) {
      if (km > 40) return { calzada: 42, acera: 5 };   // troncal tipo Sheikh Zayed
      if (km > 15) return { calzada: 26, acera: 4 };   // arteria
      return { calzada: 15, acera: 3 };                // secundaria
    }
    /** Remuestrea una polilínea YA en coordenadas de mundo, cada `paso` metros. */
    function remuestreaMundo(pts, paso) {
      var out = [], resto = 0, j;
      for (j = 0; j + 1 < pts.length; j++) {
        var a = pts[j], b = pts[j + 1];
        var dx = b.x - a.x, dz = b.z - a.z, L = Math.sqrt(dx * dx + dz * dz);
        if (L < 1e-3) continue;
        dx /= L; dz /= L;
        var t = resto;
        while (t < L) { out.push({ x: a.x + dx * t, z: a.z + dz * t }); t += paso; }
        resto = t - L;
      }
      if (pts.length) out.push(pts[pts.length - 1]);
      return out;
    }
    /** Remuestrea una polilínea cada `paso` metros, en coordenadas de mundo. */
    function remuestrea(line, geo, paso) {
      var pts = [], i, w;
      for (i = 0; i < line.length; i++) {
        w = geo.toWorld(line[i][1], line[i][0]);
        pts.push({ x: w.x, z: w.z });
      }
      var out = [], resto = 0, j;
      for (j = 0; j + 1 < pts.length; j++) {
        var a = pts[j], b = pts[j + 1];
        var dx = b.x - a.x, dz = b.z - a.z, L = Math.sqrt(dx * dx + dz * dz);
        if (L < 1e-3) continue;
        dx /= L; dz /= L;
        var t = resto;
        while (t < L) { out.push({ x: a.x + dx * t, z: a.z + dz * t }); t += paso; }
        resto = t - L;
      }
      if (pts.length) out.push(pts[pts.length - 1]);
      return out;
    }
    /**
     * Construye la calzada: una cinta por polilínea con perfil transversal de
     * ocho puntos —acera, bordillo con cara vertical, calzada, y lo mismo al otro
     * lado—, remuestreada para que siga el relieve. Cada vértice lleva su
     * coordenada transversal y longitudinal, que es lo que pinta las marcas.
     */
    // --- La trama de barrio -------------------------------------------------------
    // El mapa abierto solo trae las 21 vías principales de Dubái: dentro de los
    // barrios no hay nada, y sin calles no hay aceras que pisar ni portales a los
    // que llegar. Como la red de este entorno no alcanza OpenStreetMap, las calles
    // menores se DEDUCEN, que es la mitad de la solución que en cualquier caso
    // hacía falta: cada barrio recibe una retícula cuyo giro y cuyo paso salen de
    // `semillaMorfologia` de su celda, así que es la misma en todas las máquinas y
    // no cambia nunca. Si algún día entra un extracto de OpenStreetMap, sus vías
    // con nombre se añaden a esta misma lista y mandan donde existan.
    var TRAMA = {
      towers: { paso: 165, calzada: 16, acera: 3.5 },
      blocks: { paso: 150, calzada: 13, acera: 3.0 },
      villas: { paso: 120, calzada: 10, acera: 2.4 },
      warehouses: { paso: 210, calzada: 18, acera: 3.0 }
    };
    /** Retícula de un barrio: devuelve sus ejes de calle en coordenadas de mundo. */
    function tramaBarrio(c, geo) {
      var w = geo.toWorld(c.lat, c.lon), t = TRAMA[c.kind] || TRAMA.blocks;
      var sem = semillaMorfologia(Math.round(w.x / CELL), Math.round(w.z / CELL), 9);
      var ang = real01(sem) * Math.PI;            // el giro de la retícula
      var R = (c.radius_m || 600) * 0.94;
      S.tramas.push({ x: w.x, z: w.z, R: R, ang: ang, paso: t.paso,
                      medio: t.calzada * 0.5 + t.acera, radio: radioEsquina(t.calzada) });
      var cs = Math.cos(ang), sn = Math.sin(ang), lineas = [], n = Math.floor(R / t.paso), i, d, semi;
      for (i = -n; i <= n; i++) {
        d = i * t.paso;
        semi = Math.sqrt(Math.max(0, R * R - d * d));   // cuerda del círculo a esa altura
        if (semi < t.paso * 0.6) continue;              // tramos demasiado cortos: sobran
        // Familia paralela al giro, y la perpendicular.
        lineas.push({ pts: [{ x: w.x + cs * -semi - sn * d, z: w.z + sn * -semi + cs * d },
                            { x: w.x + cs * semi - sn * d, z: w.z + sn * semi + cs * d }],
                      calzada: t.calzada, acera: t.acera, familia: 0 });
        lineas.push({ pts: [{ x: w.x + cs * d - sn * -semi, z: w.z + sn * d + cs * -semi },
                            { x: w.x + cs * d - sn * semi, z: w.z + sn * d + cs * semi }],
                      calzada: t.calzada, acera: t.acera, familia: 1 });
      }
      return lineas;
    }
    /** ¿Cae el punto en una calle de barrio? Es analítico: la retícula es regular. */
    function enCalle(wx, wz, margen) {
      var i, t, dx, dz, cs, sn, lx, lz, d1, d2;
      for (i = 0; i < S.tramas.length; i++) {
        t = S.tramas[i];
        dx = wx - t.x; dz = wz - t.z;
        if (dx * dx + dz * dz > t.R * t.R) continue;
        cs = Math.cos(-t.ang); sn = Math.sin(-t.ang);
        lx = dx * cs - dz * sn; lz = dx * sn + dz * cs;
        d1 = Math.abs(lx - Math.round(lx / t.paso) * t.paso);
        d2 = Math.abs(lz - Math.round(lz / t.paso) * t.paso);
        var m = t.medio + (margen || 0);
        if (Math.min(d1, d2) < m) return true;
        // En el cruce la boca se abre con el radio de giro: ahí tampoco se
        // construye, o el edificio se comería la esquina.
        if (d1 < m + t.radio && d2 < m + t.radio) return true;
      }
      for (i = 0; i < S.glorietas.length; i++) {
        t = S.glorietas[i]; dx = wx - t.x; dz = wz - t.z;
        d1 = t.R + (margen || 0);
        if (dx * dx + dz * dz < d1 * d1) return true;
      }
      return false;
    }

    // --- Los cruces (v0.10.7) ------------------------------------------------------
    // Hasta aquí cada vía se dibujaba entera y por su cuenta. Donde dos se cruzaban
    // —y con la trama de barrio eso pasa cada ciento cincuenta metros— las dos
    // calzadas quedaban una encima de la otra: dos bordillos de dieciocho
    // centímetros atravesando el asfalto de la otra, y la acera cortándole el paso
    // a los coches. Un cruce de verdad tiene tres cosas, y ninguna estaba:
    //
    //   PRIORIDAD: una de las dos manda. El rango lo decide sin ambigüedad —las
    //     vías del mapa por encima de cualquier calle deducida, y entre iguales la
    //     más ancha; a igualdad exacta, la de menor índice, que es un orden fijo—,
    //     así que la misma pareja se resuelve igual en todas las máquinas.
    //   HUECO: la calle que cede desaparece dentro del ancho de la que manda, en
    //     vez de dibujarse por debajo.
    //   REBAJE: el bordillo de la que manda baja a la calzada en la boca de la
    //     otra, en metro y medio, que es lo que hace un vado de verdad.
    //
    // Y donde se cruzan dos arterias del mapa del mismo orden no manda ninguna:
    // ahí va una GLORIETA, con su anillo y su isla central.

    /** Longitud de arco acumulada de una polilínea ya muestreada. */
    function acumulaArco(m) {
      var s = new Float64Array(m.length), i, dx, dz;
      for (i = 1; i < m.length; i++) {
        dx = m[i].x - m[i - 1].x; dz = m[i].z - m[i - 1].z;
        s[i] = s[i - 1] + Math.sqrt(dx * dx + dz * dz);
      }
      return s;
    }
    /** El punto de la polilínea que está a distancia `d` del origen. */
    function puntoArco(m, s, d) {
      var lo = 0, hi = m.length - 1, mid;
      if (hi < 1) return { x: m[0].x, z: m[0].z };
      if (d <= 0) return { x: m[0].x, z: m[0].z };
      if (d >= s[hi]) return { x: m[hi].x, z: m[hi].z };
      while (lo + 1 < hi) { mid = (lo + hi) >> 1; if (s[mid] <= d) lo = mid; else hi = mid; }
      var t = (d - s[lo]) / Math.max(1e-6, s[lo + 1] - s[lo]);
      return { x: m[lo].x + (m[lo + 1].x - m[lo].x) * t, z: m[lo].z + (m[lo + 1].z - m[lo].z) * t };
    }
    /** Por debajo de este seno dos vías van casi paralelas: no es un cruce. */
    var CRUCE_SENO = 0.26;                        // unos 15 grados
    /** Corte de dos segmentos en planta. Devuelve null si no se cruzan. */
    function cortaSegmentos(pa, pb, qa, qb) {
      var rx = pb.x - pa.x, rz = pb.z - pa.z, sx = qb.x - qa.x, sz = qb.z - qa.z;
      var lr = Math.sqrt(rx * rx + rz * rz), ls = Math.sqrt(sx * sx + sz * sz);
      if (lr < 1e-3 || ls < 1e-3) return null;
      var den = rx * sz - rz * sx, sen = den / (lr * ls);
      if (Math.abs(sen) < CRUCE_SENO) return null;
      var dx = qa.x - pa.x, dz = qa.z - pa.z;
      var t = (dx * sz - dz * sx) / den, u = (dx * rz - dz * rx) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) return null;
      return { x: pa.x + rx * t, z: pa.z + rz * t, t: t, u: u, sen: Math.abs(sen) };
    }
    /** Funde una lista de tramos [a,b] en otra ordenada y sin solapes. */
    function fundeTramos(t) {
      if (t.length < 2) return t;
      t.sort(function (p, q) { return p[0] - q[0]; });
      var out = [t[0]], i, u;
      for (i = 1; i < t.length; i++) {
        u = out[out.length - 1];
        if (t[i][0] <= u[1]) u[1] = Math.max(u[1], t[i][1]); else out.push(t[i]);
      }
      return out;
    }
    /** Media anchura de una vía contando bordillo y acera. */
    function anchoTotal(v) { return v.calzada * 0.5 + 0.45 + v.acera; }
    /**
     * El radio de giro de la esquina, en metros. Una calle de barrio de diez
     * metros lleva cuatro; una troncal, nueve. Es lo que separa una boca por la
     * que cabe un coche girando de un ángulo recto por el que no cabe nadie.
     */
    function radioEsquina(calzada) { return clamp(calzada * 0.45, 4, 9); }
    /**
     * El ensanche de la boca a `d` metros del corte: un cuarto de circunferencia
     * de radio R que vale R justo en la boca y se muere a los R metros. Es la
     * curva exacta del bordillo de una esquina de verdad, no una aproximación.
     */
    function ensancheBoca(d, R) {
      if (!(d < R)) return 0;
      var t = R - clamp(d, 0, R);
      return R - Math.sqrt(Math.max(0, R * R - t * t));
    }
    /**
     * Cuánto se separa del eje el perfil en `s` por culpa de las esquinas. Manda
     * la boca que más abra. La medida es la distancia PERPENDICULAR al eje de la
     * otra vía menos su media calzada: en el borde de su calzada vale el radio
     * entero, y a R metros más afuera ya es cero.
     */
    function ensancheEnBocas(bocas, s) {
      var i, mejor = 0, b;
      for (i = 0; i < bocas.length; i++) {
        b = bocas[i];
        mejor = Math.max(mejor, ensancheBoca(Math.max(0, Math.abs(s - b.s) * b.sen - b.co), b.R));
      }
      return mejor;
    }
    /**
     * La cota de una sección de vía. Una sección es HORIZONTAL de lado a lado, y
     * entre dos secciones la cinta va recta. Si cada punto se pegara a su propia
     * cota, la cuerda se hundiría bajo cualquier bulto intermedio y el terreno
     * mordería la calzada a trozos. Se nivela por la cota máxima de una cruz de
     * nueve puntos (medio paso por delante y por detrás, el ancho a cada lado):
     * es lo que hace un desmonte. Devuelve la cota fina y la gruesa.
     */
    function cotaSeccion(p0, tx, tz, ancho) {
      var hF = 0, hC = 0, dt, du, qx, qz, nx = -tz, nz = tx;
      for (dt = -0.5; dt <= 0.51; dt += 0.5) for (du = -1; du <= 1; du++) {
        qx = p0.x + tx * VIA_PASO * dt + nx * ancho * du;
        qz = p0.z + tz * VIA_PASO * dt + nz * ancho * du;
        hF = Math.max(hF, surfaceH(qx, qz)); hC = Math.max(hC, coarseH(qx, qz));
      }
      return { hF: hF, hC: hC };
    }
    /**
     * La cota de un cruce (v0.10.13): el máximo de las secciones de LAS DOS vías
     * en el cruce y a un alcance a cada lado. La caja de la preferente sale
     * ensanchada por el radio de la esquina y monta sobre los primeros metros de
     * la que cede; si cada vía llevara su propio nivel, una tapaba a la otra por
     * los centímetros que las separan —y con ella el paso de peatones y la línea
     * de detención pintados encima—. Con una sola cota para toda la zona del
     * cruce las dos calzadas quedan en el mismo plano.
     */
    function cotaCruce(A, ja, sa, alA, B, jb, sb, alB) {
      var r = { hF: 0, hC: 0 }, vias = [[A, ja, sa, alA], [B, jb, sb, alB]], v, k, m, tx, tz, tl, p, c;
      for (v = 0; v < 2; v++) {
        m = vias[v][0].muestras;
        tx = m[vias[v][1] + 1].x - m[vias[v][1]].x; tz = m[vias[v][1] + 1].z - m[vias[v][1]].z;
        tl = Math.sqrt(tx * tx + tz * tz) || 1; tx /= tl; tz /= tl;
        for (k = -1; k <= 1; k++) {
          p = puntoArco(m, vias[v][0].arco, vias[v][2] + k * vias[v][3]);
          c = cotaSeccion(p, tx, tz, anchoTotal(vias[v][0]) + 9);
          r.hF = Math.max(r.hF, c.hF); r.hC = Math.max(r.hC, c.hC);
        }
      }
      return r;
    }
    /** Lo que tarda la cota propia en volver pasada la zona del cruce, en metros. */
    var NIVEL_VUELTA = 60;
    /**
     * Cuánto pesa la cota del cruce en `s` y cuál es (con el resalte de la boca):
     * uno dentro del alcance de la boca y de ahí a los sesenta metros baja suave
     * hasta cero. Con dos bocas cerca manda la que más pese. Devuelve null lejos
     * de todo cruce.
     */
    function nivelEnBocas(bocas, s) {
      var i, b, d, w, mejor = null, wm = 0;
      for (i = 0; i < bocas.length; i++) {
        b = bocas[i];
        d = Math.abs(s - b.s) * b.sen - b.alcance;
        if (d >= NIVEL_VUELTA) continue;
        w = d <= 0 ? 1 : 1 - smoothstep(d / NIVEL_VUELTA);
        if (w > wm) { wm = w; mejor = b; }
      }
      return mejor ? { w: wm, hF: mejor.nivel.hF + mejor.alza, hC: mejor.nivel.hC + mejor.alza } : null;
    }
    /**
     * Resuelve todos los cruces y deja en cada vía sus tramos de CAJA (donde manda,
     * y el bordillo se rebaja) y sus tramos de CORTE (donde cede el paso y
     * desaparece), más la lista de glorietas.
     *
     * Las parejas se buscan con una rejilla uniforme de trescientos metros: a pelo
     * serían cien millones de parejas de segmentos y el arranque se iría a minutos.
     * Cada pareja se resuelve en la casilla DONDE CAE EL CORTE, así que aunque dos
     * segmentos compartan varias casillas el cruce se cuenta una sola vez y no hace
     * falta llevar memoria de lo ya visto.
     */
    function resuelveCruces(lineas) {
      var CAJA = 300, celdas = {}, i, j, cx, cz, key, m, lista;
      for (i = 0; i < lineas.length; i++) {
        lineas[i].arco = acumulaArco(lineas[i].muestras);
        lineas[i].cajas = []; lineas[i].cortes = []; lineas[i].bocas = []; lineas[i].marcas = [];
        m = lineas[i].muestras;
        for (j = 0; j + 1 < m.length; j++) {
          var ax = Math.min(m[j].x, m[j + 1].x), bx = Math.max(m[j].x, m[j + 1].x);
          var az = Math.min(m[j].z, m[j + 1].z), bz = Math.max(m[j].z, m[j + 1].z);
          for (cx = Math.floor(ax / CAJA); cx <= Math.floor(bx / CAJA); cx++) {
            for (cz = Math.floor(az / CAJA); cz <= Math.floor(bz / CAJA); cz++) {
              key = cx + ':' + cz;
              lista = celdas[key] || (celdas[key] = []);
              lista.push(i, j);
            }
          }
        }
      }
      var glorietas = [], n = 0, a, b;
      for (key in celdas) {
        if (!Object.prototype.hasOwnProperty.call(celdas, key)) continue;
        lista = celdas[key];
        var p = key.indexOf(':'), kx = parseInt(key.slice(0, p), 10), kz = parseInt(key.slice(p + 1), 10);
        for (a = 0; a + 2 < lista.length; a += 2) {
          for (b = a + 2; b < lista.length; b += 2) {
            var ia = lista[a], ja = lista[a + 1], ib = lista[b], jb = lista[b + 1];
            if (ia === ib) continue;                 // una vía no se cruza consigo misma
            var A = lineas[ia], B = lineas[ib];
            var c = cortaSegmentos(A.muestras[ja], A.muestras[ja + 1], B.muestras[jb], B.muestras[jb + 1]);
            if (!c) continue;
            if (Math.floor(c.x / CAJA) !== kx || Math.floor(c.z / CAJA) !== kz) continue;
            var sa = A.arco[ja] + (A.arco[ja + 1] - A.arco[ja]) * c.t;
            var sb = B.arco[jb] + (B.arco[jb + 1] - B.arco[jb]) * c.u;
            var acA = anchoTotal(A), acB = anchoTotal(B);
            n++;
            if (A.rango >= 1000 && B.rango >= 1000 && Math.max(A.calzada, B.calzada) <= 26) {
              // Dos arterias del mapa del mismo orden: glorieta. Las dos se cortan
              // en la cuerda cuyos extremos caen justo sobre la circunferencia, así
              // que el anillo tapa lo que falta sin dejar mordiscos en las esquinas.
              var anc = Math.max(A.calzada, B.calzada);
              // El anillo es la calzada de un solo sentido: entre siete y catorce
              // metros. El radio exterior sale de ahí más el ancho de la vía que
              // llega, para que las bocas encajen sin morderse.
              var anillo = clamp(anc * 0.5, 7, 14);
              var Rg = Math.max(acA, acB) + anillo + 4;
              var dA = Math.sqrt(Math.max(1, Rg * Rg - acA * acA));
              var dB = Math.sqrt(Math.max(1, Rg * Rg - acB * acB));
              var rep = false, q;
              for (q = 0; q < glorietas.length; q++) {
                var ddx = glorietas[q].x - c.x, ddz = glorietas[q].z - c.z;
                if (ddx * ddx + ddz * ddz < Rg * Rg) { rep = true; break; }
              }
              // Tres vías que concurren en un punto dan tres parejas: el anillo se
              // levanta una sola vez, pero las tres se cortan.
              if (!rep) glorietas.push({ x: c.x, z: c.z, R: Rg, anillo: anillo });
              A.cortes.push([sa - dA, sa + dA]);
              B.cortes.push([sb - dB, sb + dB]);
              // Ceda el paso en las cuatro entradas, metro y pico antes del anillo.
              // Se circula por la derecha: la mitad que llega desde s menor va
              // en +s y su derecha es u positiva; la otra, al revés.
              A.marcas.push({ s: sa - dA - 1.2, lado: 1, tipo: 5 }, { s: sa + dA + 1.2, lado: -1, tipo: 5 });
              B.marcas.push({ s: sb - dB - 1.2, lado: 1, tipo: 5 }, { s: sb + dB + 1.2, lado: -1, tipo: 5 });
              // Y un paso de peatones por entrada, de 2,5 a 5 m del anillo: dos filas
              // (s y s2) que el recorrido cose en un cuadrilátero de calzada entera.
              A.marcas.push({ s: sa - dA - 5.0, s2: sa - dA - 2.5, tipo: 6 }, { s: sa + dA + 2.5, s2: sa + dA + 5.0, tipo: 6 });
              B.marcas.push({ s: sb - dB - 5.0, s2: sb - dB - 2.5, tipo: 6 }, { s: sb + dB + 2.5, s2: sb + dB + 5.0, tipo: 6 });
              continue;
            }
            var mayor = A, menor = B, sMay = sa, sMen = sb, acMay = acA;
            if (B.rango > A.rango || (B.rango === A.rango && ib < ia)) {
              mayor = B; menor = A; sMay = sb; sMen = sa; acMay = acB;
            }
            // La boca de la menor, medida a lo largo de la mayor, y el ancho de la
            // mayor medido a lo largo de la menor: los dos se estiran con el seno.
            // La caja cubre la boca ENSANCHADA de la menor, no solo su calzada:
            // si no, el bordillo curvado de la esquina acabaría montándose sobre
            // la acera de la preferente en vez de morir contra ella.
            // La caja es exactamente la calzada de la menor: el bordillo de la
            // mayor no desaparece en toda la esquina, sino que se abre con ella.
            mayor.cajas.push([sMay - menor.calzada * 0.5 / c.sen, sMay + menor.calzada * 0.5 / c.sen]);
            menor.cortes.push([sMen - acMay / c.sen, sMen + acMay / c.sen]);
            // La esquina, apuntada en LAS DOS vías. El arco es tangente al
            // bordillo de la otra, así que su medida natural es la distancia
            // PERPENDICULAR al eje ajeno menos la media calzada de esa otra:
            // vale el radio entero ahí y se muere R metros más afuera. Las dos
            // calles usan la misma fórmula, así que sus bordes recorren el mismo
            // arco y se encuentran en él en vez de cruzarse.
            var rad = radioEsquina(Math.min(mayor.calzada, menor.calzada));
            // La zona del cruce, medida perpendicular al eje ajeno: en la
            // preferente, la caja y el arco entero; en la que cede, hasta donde
            // llega la caja ensanchada de la otra (su acera más el radio). Toda la
            // zona, en las dos vías, va a la cota del cruce.
            var alMay = menor.calzada * 0.5 + rad + 0.05, alMen = acMay + rad + 0.05;
            var niv = (mayor === A) ? cotaCruce(A, ja, sa, alMay / c.sen, B, jb, sb, alMen / c.sen)
                                    : cotaCruce(B, jb, sb, alMay / c.sen, A, ja, sa, alMen / c.sen);
            // La que cede va centímetro y medio POR ENCIMA de la cota: en los
            // metros en que las dos calzadas se montan, dos planos exactamente
            // iguales parpadean (z-fighting) y las rayas de una se ven a través
            // de la otra. Con ese resalte manda la calzada de la que cede, que es
            // la que lleva pintados el paso y la línea, y la caja queda debajo.
            mayor.bocas.push({ s: sMay, sen: c.sen, co: menor.calzada * 0.5, R: rad, alcance: alMay, nivel: niv, alza: 0 });
            menor.bocas.push({ s: sMen, sen: c.sen, co: mayor.calzada * 0.5, R: rad, alcance: alMen, nivel: niv, alza: 0.015 });
            // En cada boca de la que cede, desde la acera de la preferente hacia
            // fuera: 30 cm de nada, el paso de peatones (2,5 m, calzada entera), un
            // metro, y la línea de detención, que además espera a que el arco de la
            // esquina haya terminado. La línea solo va en la mitad que llega al
            // cruce, que es la derecha de su sentido de marcha.
            var dCeb = 0.45 + mayor.acera + 0.3, dLin = Math.max(rad, dCeb + 3.5), co2 = mayor.calzada * 0.5;
            var sLin = (co2 + dLin) / c.sen, sCe1 = (co2 + dCeb) / c.sen, sCe2 = (co2 + dCeb + 2.5) / c.sen;
            menor.marcas.push({ s: sMen - sLin, lado: 1, tipo: 4 }, { s: sMen + sLin, lado: -1, tipo: 4 });
            menor.marcas.push({ s: sMen - sCe2, s2: sMen - sCe1, tipo: 6 }, { s: sMen + sCe1, s2: sMen + sCe2, tipo: 6 });
          }
        }
      }
      for (i = 0; i < lineas.length; i++) {
        lineas[i].cajas = fundeTramos(lineas[i].cajas);
        lineas[i].cortes = fundeTramos(lineas[i].cortes);
      }
      return { n: n, glorietas: glorietas };
    }
    /** ¿Está `s` dentro de alguno de los tramos? La lista viene ordenada. */
    function enTramo(tramos, s) {
      var i;
      for (i = 0; i < tramos.length; i++) {
        if (s < tramos[i][0]) return false;
        if (s <= tramos[i][1]) return true;
      }
      return false;
    }

    // --- Las calles dejan de enviarse enteras (v0.10.8) ----------------------------
    // Toda la calzada de Dubái iba en UNA malla con `frustumCulled = false`: medio
    // millón de triángulos enviados a la tarjeta cada cuadro, mires donde mires.
    // Caminando por un barrio se ve menos del dos por ciento de la ciudad, así que
    // el noventa y ocho restante era trabajo de vértice tirado.
    //
    // Ahora la calzada se reparte en teselas cuadradas y cada una es una malla con
    // su esfera envolvente: la que no entra en el cono de visión no se envía. El
    // precio son más llamadas de dibujo, y por eso la tesela es grande: con cuatro
    // kilómetros la ciudad entera cabe en unas pocas decenas de mallas, y a pie
    // solo entran dos o tres.
    //
    // Una cinta que cruza de tesela repite su última fila en la nueva y cose ahí la
    // sección: no hay ni hueco ni sección dibujada dos veces.
    var TESELA_VIA = 8000;

    /**
     * Construye TODAS las calzadas —las 21 vías del mapa y la trama deducida de
     * los 34 barrios— repartidas en teselas: cinta con perfil transversal de ocho
     * puntos, remuestreada para seguir el relieve, nivelada por tramos y con los
     * cruces resueltos por prioridad.
     */
    function buildRoads(roads, geo) {
      var r, i, k;
      var ALTO = 0.18;                            // altura del bordillo
      var RAMPA = 1.5;                            // lo que tarda el bordillo en bajar
      var MIRA = 45;                              // con cuánto se mira la tangente
      var PERFIL = 8;                             // puntos del perfil transversal
      var trozos = {}, decales = [];
      /** El trozo al que le toca un punto del mundo; se crea al vuelo. */
      function trozoDe(wx, wz) {
        var clave = Math.floor(wx / TESELA_VIA) + ':' + Math.floor(wz / TESELA_VIA);
        return trozos[clave] || (trozos[clave] = { pos: [], hcs: [], vias: [], idx: [], cose: false });
      }
      /**
       * Escribe una fila de ocho vértices y, si la anterior de este trozo pertenece
       * a la misma cinta, cose las siete caras que las unen. El devanado importa:
       * cosidas al revés, las caras miran al suelo y la GPU las descarta. Con este
       * orden la normal geométrica es +Y en la calzada y apunta hacia el eje en las
       * dos caras del bordillo.
       */
      function escribeFila(T, fila) {
        var b0 = T.pos.length / 3, a0 = b0 - PERFIL, j;
        for (j = 0; j < PERFIL; j++) {
          var v = fila[j];
          T.pos.push(v[0], v[1], v[2]); T.hcs.push(v[3]); T.vias.push(v[4], v[5], v[6]);
        }
        if (T.cose) {
          for (j = 0; j + 1 < PERFIL; j++) {
            T.idx.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
          }
        }
        T.cose = true;
      }
      /**
       * El punto de la cinta a fracción `t` entre dos filas: centro, dirección
       * transversal y medio ancho del asfalto, sacados de los vértices 3 y 4 del
       * perfil (los bordes de la calzada), que llevan ya el ensanche de la esquina.
       */
      function puntoCinta(fa, fb, t) {
        var l = fa[3], r0 = fa[4], l2 = fb[3], r2 = fb[4];
        var lx = l[0] + (l2[0] - l[0]) * t, ly = l[1] + (l2[1] - l[1]) * t, lz = l[2] + (l2[2] - l[2]) * t, lh = l[3] + (l2[3] - l[3]) * t;
        var rx = r0[0] + (r2[0] - r0[0]) * t, ry = r0[1] + (r2[1] - r0[1]) * t, rz = r0[2] + (r2[2] - r0[2]) * t, rh = r0[3] + (r2[3] - r0[3]) * t;
        var dx = rx - lx, dz = rz - lz, w = Math.sqrt(dx * dx + dz * dz) * 0.5;
        if (w < 1e-3) return null;
        return { x: (lx + rx) * 0.5, y: (ly + ry) * 0.5 + 0.015, z: (lz + rz) * 0.5, hc: (lh + rh) * 0.5 + 0.015, dx: dx / (2 * w), dz: dz / (2 * w), w: w };
      }
      /** Un vértice de marca a `u` metros del eje sobre el punto de cinta `P`. */
      function enCinta(P, u) {
        return [P.x + P.dx * u, P.y, P.z + P.dz * u, P.hc, u];
      }
      // 1) Las vías del mapa abierto (ejesDelMapa): con su ancho sacado de su
      //    longitud las que no traen clase, y con el de su clase las que sí.
      var lineas = [];
      for (r = 0; r < roads.length; r++) {
        var line = roads[r].pts;
        if (!line || line.length < 2) continue;
        var m0 = remuestrea(line, geo, VIA_PASO);
        if (m0.length < 2) continue;
        var largoKm = 0;
        for (i = 0; i + 1 < m0.length; i++) {
          largoKm += Math.sqrt(Math.pow(m0[i + 1].x - m0[i].x, 2) + Math.pow(m0[i + 1].z - m0[i].z, 2));
        }
        var an = roads[r].calzada ? roads[r] : anchoVia(largoKm / 1000);
        // Rango: cualquier vía del mapa manda sobre cualquier calle deducida.
        lineas.push({ muestras: m0, calzada: an.calzada, acera: an.acera, rango: 1000 + an.calzada });
      }
      // 2) La trama deducida de cada barrio.
      S.tramas = [];
      var cl = (S.meta && S.meta.clusters) || [];
      for (r = 0; r < cl.length; r++) {
        var tl = tramaBarrio(cl[r], geo);
        for (i = 0; i < tl.length; i++) {
          lineas.push({
            muestras: remuestreaMundo(tl[i].pts, VIA_PASO), calzada: tl[i].calzada, acera: tl[i].acera,
            // Dentro del barrio manda siempre la familia paralela al giro: así el
            // barrio entero tiene un sentido, en vez de alternar cruce a cruce.
            rango: tl[i].calzada * 2 - tl[i].familia
          });
        }
      }
      // 3) Quién manda en cada cruce.
      var cru = resuelveCruces(lineas);
      S.glorietas = cru.glorietas;
      S.nCruces = cru.n;
      S.marcas = [];
      // 4) La geometría, tesela a tesela.
      for (r = 0; r < lineas.length; r++) {
        var muestras = lineas[r].muestras, arco = lineas[r].arco;
        if (!muestras || muestras.length < 2) continue;
        var total = arco[arco.length - 1];
        var c = lineas[r].calzada * 0.5, kb = c + 0.45, ac = kb + lineas[r].acera;
        var perfilN = [[-ac, ALTO, 2], [-kb, ALTO, 2], [-kb, 0, 1], [-c, 0, 0], [c, 0, 0], [kb, 0, 1], [kb, ALTO, 2], [ac, ALTO, 2]];
        // Dentro de la caja del cruce no hay bordillo ni acera: todo es calzada al
        // mismo nivel. Las marcas siguen pintándose, que es lo que hace la vía
        // preferente de verdad: su eje cruza entero.
        var perfilL = [[-ac, 0, 0], [-kb, 0, 0], [-kb, 0, 0], [-c, 0, 0], [c, 0, 0], [kb, 0, 0], [kb, 0, 0], [ac, 0, 0]];
        // Las paradas son las muestras del remuestreo MÁS las fronteras de cada
        // tramo, para que el corte caiga exactamente donde toca y el rebaje del
        // bordillo tenga metro y medio y no cien.
        var paradas = [], cajas = lineas[r].cajas, cortes = lineas[r].cortes;
        for (i = 0; i < arco.length; i++) paradas.push(arco[i]);
        for (i = 0; i < cajas.length; i++) {
          paradas.push(cajas[i][0] - RAMPA, cajas[i][0], cajas[i][1], cajas[i][1] + RAMPA);
        }
        // La frontera del corte va ocho centímetros POR FUERA: justo encima, la
        // parada caería dentro del tramo cortado y la cinta terminaría en la
        // muestra anterior, que puede estar cien metros atrás. Eso dejaba la calle
        // menor flotando a media manzana de la mayor.
        for (i = 0; i < cortes.length; i++) paradas.push(cortes[i][0] - 0.08, cortes[i][1] + 0.08);
        // Y las paradas del ARCO DE LA ESQUINA (v0.10.9). El cuarto de
        // circunferencia se parte por ÁNGULO, no por longitud: donde la curva se
        // cierra hacen falta filas y donde va casi recta, no. Con los cortes en
        // 0, 29 %, 60 % y 100 % del recorrido la flecha del arco no llega a diez
        // centímetros; repartidos por longitud pasaba del metro y la esquina se
        // leía como un chaflán.
        var bocas = lineas[r].bocas;
        for (i = 0; i < bocas.length; i++) {
          var bq = bocas[i], paso0 = bq.co / bq.sen, pasoR = bq.R / bq.sen;
          for (k = 0; k < 4; k++) {
            var fr = [0, 0.293, 0.6, 1][k] * pasoR;
            paradas.push(bq.s - paso0 - fr, bq.s + paso0 + fr);
          }
        }
        var marcas = lineas[r].marcas;
        paradas.sort(function (p, q) { return p - q; });
        var sUlt = -1e9, sAnt = -1e9, filaAnt = null;
        for (i = 0; i < paradas.length; i++) {
          var sp = paradas[i];
          if (sp < -1e-6 || sp > total + 1e-6) continue;
          if (sp - sUlt < 0.03) continue;                            // dos paradas pegadas
          if (enTramo(cortes, sp)) { filaAnt = null; continue; }
          var p0 = puntoArco(muestras, arco, sp);
          var dentro = p0.x >= ac && p0.z >= ac && p0.x <= geo.worldW - ac && p0.z <= geo.worldH - ac
            && Math.max(surfaceH(p0.x, p0.z), 0) > 0.6;      // ni fuera del mapa ni en el agua
          if (!dentro) { filaAnt = null; continue; }          // se corta la cinta, no se cose el hueco
          // La tangente se mira a cuarenta y cinco metros por banda: a un metro
          // cada codo del dataset saldría en pico, y las paradas del cruce van a
          // metro y medio unas de otras.
          var pAnt = puntoArco(muestras, arco, Math.max(0, sp - MIRA));
          var pSig = puntoArco(muestras, arco, Math.min(total, sp + MIRA));
          var tx = pSig.x - pAnt.x, tz = pSig.z - pAnt.z, tl2 = Math.sqrt(tx * tx + tz * tz) || 1;
          tx /= tl2; tz /= tl2;
          var nx = -tz, nz = tx;
          // La cota de la sección (ver cotaSeccion) y, cerca de un cruce, la del
          // cruce: dentro de su zona manda entera y en los sesenta metros
          // siguientes la propia va volviendo.
          var cota = cotaSeccion(p0, tx, tz, ac + 9), hF = cota.hF, hC = cota.hC;
          var nb = nivelEnBocas(bocas, sp);
          if (nb) { hF += nb.w * (nb.hF - hF); hC += nb.w * (nb.hC - hC); }
          var perfil = enTramo(cajas, sp) ? perfilL : perfilN;
          // El bordillo se abre en cuarto de circunferencia al llegar a la boca:
          // todo el perfil se separa del eje lo mismo, así que la acera y la
          // calzada conservan su ancho y lo que se curva es la esquina.
          var abre = ensancheEnBocas(bocas, sp);
          var fila = [];
          for (k = 0; k < PERFIL; k++) {
            var u = perfil[k][0] + (perfil[k][0] < 0 ? -abre : abre), dy = perfil[k][1], cla = perfil[k][2];
            fila.push([p0.x + nx * u, hF + 0.22 + dy, p0.z + nz * u, hC + 0.22 + dy, u, sp, cla]);
          }
          var T = trozoDe(p0.x, p0.z);
          if (!filaAnt) { T.cose = false; }
          else if (filaAnt.T !== T) {
            // La cinta cruza de tesela: la fila anterior se repite aquí y la
            // sección que las une se cose en la tesela nueva, no en la vieja.
            T.cose = false; escribeFila(T, filaAnt.fila);
          }
          // Las marcas transversales que caigan entre la fila anterior y esta. No
          // se les da fila propia: entre dos filas la cinta es lineal, así que un
          // punto interpolado entre los bordes de asfalto de las dos filas está
          // sobre la cinta. Cada marca es un cuadrilátero suelto —cuatro vértices,
          // dos triángulos— que se escribe al final: metido entre dos filas
          // rompería el cosido de ocho vértices. Una marca que cruce una fila se
          // parte en un trozo por tramo. Centímetro y medio por encima del asfalto,
          // como la junta de la glorieta.
          if (filaAnt && sp > sAnt) for (k = 0; k < marcas.length; k++) {
            var mk = marcas[k], ma = mk.tipo === 6 ? mk.s : mk.s - 0.2, mb = mk.tipo === 6 ? mk.s2 : mk.s + 0.2;
            var pa = Math.max(ma, sAnt), pb = Math.min(mb, sp);
            if (pb - pa < 0.01) continue;
            var A = puntoCinta(filaAnt.fila, fila, (pa - sAnt) / (sp - sAnt)), B = puntoCinta(filaAnt.fila, fila, (pb - sAnt) / (sp - sAnt));
            if (!A || !B) continue;
            var wa = A.w - 0.1, wb = B.w - 0.1, va, vb, vc, vd;
            if (wa <= 0.8 || wb <= 0.8) continue;
            if (mk.tipo === 6) { va = enCinta(A, -wa); vb = enCinta(A, wa); vc = enCinta(B, -wb); vd = enCinta(B, wb); }   // la cebra cruza la calzada entera
            else { va = enCinta(A, 0.7 * mk.lado); vb = enCinta(A, wa * mk.lado); vc = enCinta(B, 0.7 * mk.lado); vd = enCinta(B, wb * mk.lado); }   // la línea, la mitad que llega al cruce
            decales.push({ T: T, tipo: mk.tipo, m: mk, v: [va, vb, vc, vd] });
          }
          escribeFila(T, fila);
          filaAnt = { T: T, fila: fila };
          sUlt = sp; sAnt = sp;
        }
      }
      // 5) Las marcas transversales de las bocas, una vez cerradas todas las cintas.
      for (r = 0; r < decales.length; r++) {
        var D = decales[r], TD = D.T, d0 = TD.pos.length / 3;
        for (k = 0; k < 4; k++) {
          var dv = D.v[k];
          TD.pos.push(dv[0], dv[1], dv[2]); TD.hcs.push(dv[3]); TD.vias.push(dv[4], 0, D.tipo);
        }
        // Mismo devanado que las filas: u creciente dentro de la fila, s creciente
        // entre filas, y la mitad de la izquierda lo invierte para seguir mirando
        // hacia arriba.
        if (D.v[1][4] > D.v[0][4]) TD.idx.push(d0, d0 + 1, d0 + 2, d0 + 1, d0 + 3, d0 + 2);
        else TD.idx.push(d0 + 1, d0, d0 + 3, d0, d0 + 2, d0 + 3);
        TD.cose = false;
        if (!D.m.reg) { D.m.reg = true; S.marcas.push({ x: (D.v[0][0] + D.v[3][0]) * 0.5, z: (D.v[0][2] + D.v[3][2]) * 0.5, tipo: D.tipo }); }
      }
      // 6) Las glorietas: anillo de asfalto sin marcas, bordillo e isla central.
      for (r = 0; r < cru.glorietas.length; r++) {
        glorieta(cru.glorietas[r], trozoDe(cru.glorietas[r].x, cru.glorietas[r].z), ALTO);
      }
      // 7) Una malla por tesela, cada una con su esfera envolvente.
      var grupo = new THREE.Group(), material = makeRoadMaterial(shared, lodUniform, noiseTex, mats), clave, n = 0;
      for (clave in trozos) {
        if (!Object.prototype.hasOwnProperty.call(trozos, clave)) continue;
        var T2 = trozos[clave];
        if (!T2.idx.length) continue;
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(T2.pos), 3));
        g.setAttribute('hc', new THREE.BufferAttribute(new Float32Array(T2.hcs), 1));
        g.setAttribute('via', new THREE.BufferAttribute(new Float32Array(T2.vias), 3));
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(T2.idx), 1));
        g.computeBoundingSphere();
        // La esfera se calcula sobre la cota fina; con el relevo al terreno basto
        // (uLod) los vértices se mueven unos metros en vertical, así que se le da
        // holgura para que una tesela no se descarte por un palmo.
        g.boundingSphere.radius += 40;
        var m = new THREE.Mesh(g, material);
        m.renderOrder = 1; m.receiveShadow = true;
        grupo.add(m); n++;
      }
      S.trozosVia = n;
      return n ? grupo : null;
    }
    /**
     * Una glorieta: corona circular de asfalto, cara de bordillo y disco de acera,
     * escrita en el trozo que le toca. Va un centímetro y medio por encima de las
     * vías que llegan —como una junta de asfalto de verdad— y se nivela por la cota
     * máxima de un disco más ancho que la cruz de nueve puntos de cualquier sección
     * que la toque, así que ninguna calzada le asoma por debajo.
     */
    function glorieta(gl, T, ALTO) {
      var N = 36, hF = 0, hC = 0, ra, aa, rr, an, qx, qz, i, cs, sn;
      var pos = T.pos, hcs = T.hcs, vias = T.vias, idx = T.idx;
      for (ra = 0; ra <= 4; ra++) {
        for (aa = 0; aa < 12; aa++) {
          rr = (gl.R + VIA_PASO) * ra / 4; an = aa * Math.PI / 6;
          qx = gl.x + Math.cos(an) * rr; qz = gl.z + Math.sin(an) * rr;
          hF = Math.max(hF, surfaceH(qx, qz)); hC = Math.max(hC, coarseH(qx, qz));
        }
      }
      var y = hF + 0.235, yc = hC + 0.235, Ri = Math.max(4, gl.R - gl.anillo), b0 = pos.length / 3;
      for (i = 0; i <= N; i++) {
        an = i * 2 * Math.PI / N; cs = Math.cos(an); sn = Math.sin(an);
        // Cuatro aros por radio: exterior del anillo, pie del bordillo, coronación
        // e isla. La clase 3 es asfalto sin marcas: una glorieta no lleva eje.
        pos.push(gl.x + cs * gl.R, y, gl.z + sn * gl.R); hcs.push(yc); vias.push(0, 0, 3);
        pos.push(gl.x + cs * Ri, y, gl.z + sn * Ri); hcs.push(yc); vias.push(0, 0, 3);
        pos.push(gl.x + cs * Ri, y + ALTO, gl.z + sn * Ri); hcs.push(yc + ALTO); vias.push(0, 0, 1);
        pos.push(gl.x + cs * Ri * 0.6, y + ALTO, gl.z + sn * Ri * 0.6); hcs.push(yc + ALTO); vias.push(0, 0, 2);
      }
      pos.push(gl.x, y + ALTO, gl.z); hcs.push(yc + ALTO); vias.push(0, 0, 2);
      var centro = pos.length / 3 - 1;
      for (i = 0; i < N; i++) {
        var a = b0 + i * 4, b = b0 + (i + 1) * 4;
        idx.push(a, a + 1, b, a + 1, b + 1, b);               // calzada del anillo
        idx.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);   // cara del bordillo
        idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);   // corona de la isla
        idx.push(a + 3, centro, b + 3);                       // abanico hasta el centro
      }
      T.cose = false;                              // el anillo no se cose con nada
    }
    function normalizeMeta(meta, img) {
      meta = meta || {};
      var out = {}, k;
      for (k in DEFAULT_META) out[k] = meta[k] !== undefined ? meta[k] : DEFAULT_META[k];
      for (k in meta) if (out[k] === undefined) out[k] = meta[k];
      if (img && (img.width !== out.width || img.height !== out.height)) {
        console.warn('city3d: el tamaño del PNG (' + img.width + 'x' + img.height + ') no coincide con el JSON (' + out.width + 'x' + out.height + '); se ajusta el mapeo.');
        var bb = out.bbox;
        out.downsample = (lonToTilePx(bb.east) - lonToTilePx(bb.west)) / img.width;
        out.origin_px = { x: lonToTilePx(bb.west), y: latToTilePx(bb.north) };
        out.meters_per_pixel = 156543.03392 * Math.cos((bb.north + bb.south) / 2 * Math.PI / 180) / 4096 * out.downsample;
        out.width = img.width; out.height = img.height;
      }
      return out;
    }
    var ready = loadJson(opts.metaUrl || '/geo/dubai.json').then(null, function (err) {
      console.warn('city3d: no se pudo cargar el JSON geográfico (' + err.message + '); se usan metadatos por defecto.');
      return null;
    }).then(function (meta) {
      return loadBinary(opts.heightUrl || '/geo/dubai.hgt.png').then(function (buf) { return decodePngGrayAsync(buf); }).then(function (r) {
        S.inflatePath = r.path;
        return [normalizeMeta(meta, r.img), r.img];
      }, function (err) {
        console.warn('city3d: no se pudo cargar el mapa de alturas (' + err.message + '); se genera una costa procedural.');
        var m = normalizeMeta(meta, null);
        if (!meta) { m.width = DEFAULT_META.width; m.height = DEFAULT_META.height; }
        return [m, proceduralHeights(m)];
      });
    }).then(function (r) {
      if (S.disposed) return;
      buildWorld(r[0], r[1]);
      syncLoop();
    });
    ready.then(null, function (err) { console.error('city3d: error construyendo la escena', err); });

    // --- Bucle de render -----------------------------------------------------------
    function syncLoop() {
      var want = S.visible && !S.docHidden && !S.disposed && !S.xr;
      if (want && !S.raf) { S.lastT = performance.now(); S.raf = requestAnimationFrame(frame); }
      else if (!want && S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    }
    var _pos = new THREE.Vector3(), _cp = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
    var labelRects = { arr: new Float32Array(4 * 512), n: 0 };
    function updateCamera(dt) {
      if (S.mode === 'walk') return updateWalk(dt);
      var c = cam.cur, g = cam.goal, f = cam.flight;
      if (f) {
        var s = smoothstep((performance.now() - f.t0) / f.dur);
        c.theta = g.theta = lerp(f.from.theta, f.to.theta, s); c.phi = g.phi = lerp(f.from.phi, f.to.phi, s);
        c.radius = g.radius = lerp(f.from.radius, f.to.radius, s);
        c.target.lerpVectors(f.from.target, f.to.target, s); g.target.copy(c.target);
        if (s >= 1) cam.flight = null;
      } else {
        var kk = 1 - Math.exp(-dt * 9);
        var sp = c.radius * 0.9 * dt, mvx = 0, mvy = 0;
        if (keys.arrowup || keys.w) mvy -= 1; if (keys.arrowdown || keys.s) mvy += 1;
        if (keys.arrowleft || keys.a) mvx -= 1; if (keys.arrowright || keys.d) mvx += 1;
        if (mvx || mvy) panBy(mvx * sp / (c.radius * 0.0016), mvy * sp / (c.radius * 0.0016));
        c.theta += (g.theta - c.theta) * kk; c.phi += (g.phi - c.phi) * kk; c.radius += (g.radius - c.radius) * kk;
        c.target.lerp(g.target, kk);
      }
      c.target.y = Math.max(surfaceH(c.target.x, c.target.z), 0);
      var sp2 = Math.sin(c.phi);
      _pos.set(c.target.x + c.radius * sp2 * Math.sin(c.theta), c.target.y + c.radius * Math.cos(c.phi), c.target.z + c.radius * sp2 * Math.cos(c.theta));
      var minY = groundH(_pos.x, _pos.z) + 12 + c.radius * 0.02;
      if (_pos.y < minY) { _pos.y = minY; if (!f) g.phi = Math.min(g.phi, c.phi - 0.01); }
      camera.position.copy(_pos);
      camera.lookAt(c.target);
      camera.near = Math.max(0.5, c.radius * 0.001); camera.far = Math.max(c.radius * 8, S.L * 8);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    }
    function updateWalk(dt) {
      // Un módulo que lleva al jugador (dentro de un edificio, en un ascensor)
      // mueve walk.pos —incluida la altura de los pies, walk.pos.y— con su propia
      // colisión, y el visor solo coloca la cámara.
      if (emitirHasta('andar', dt)) return colocaCamaraAPie();
      var sp = 6 * walk.speed * (keys.shift ? 5 : 1) * dt, mx = 0, mz = 0;
      if (keys.w || keys.arrowup) mz -= 1; if (keys.s || keys.arrowdown) mz += 1;
      if (keys.a || keys.arrowleft) mx -= 1; if (keys.d || keys.arrowright) mx += 1;
      if (keys.q) walk.fly = Math.max(0, walk.fly - sp); if (keys.e) walk.fly = Math.min(3000, walk.fly + sp);
      if (mx || mz) {
        var n = Math.sqrt(mx * mx + mz * mz); mx /= n; mz /= n;
        _fwd.set(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw)); _right.set(Math.cos(walk.yaw), 0, -Math.sin(walk.yaw));
        walk.pos.x += (_fwd.x * -mz + _right.x * mx) * sp; walk.pos.z += (_fwd.z * -mz + _right.z * mx) * sp;
        walk.pos.x = clamp(walk.pos.x, -S.L * 0.2, S.geo.worldW + S.L * 0.2); walk.pos.z = clamp(walk.pos.z, -S.L * 0.2, S.geo.worldH + S.L * 0.2);
        // Los edificios paran. Volando por encima de su altura, no: subir con E y
        // pasar por encima de una torre tiene que seguir siendo posible.
        if (walk.fly < 2) walk.choque = empujarFuera(walk.pos, 0.42);
        else { var alto = solidoBajo(walk.pos.x, walk.pos.z); walk.choque = null;
          if (!alto || walk.pos.y + walk.fly < alto.y0 + alto.h) empujarFuera(walk.pos, 0.42); }
      }
      // Lo que se mueve empuja aunque el jugador esté quieto: un coche que llega
      // por detrás no lo atraviesa. Y si el empujón lo mete en una fachada, la
      // fachada gana.
      if (walk.fly < 2) { walk.choqueMovil = empujarDeMoviles(walk.pos, 0.42); if (walk.choqueMovil) empujarFuera(walk.pos, 0.42); }
      else walk.choqueMovil = null;
      walk.pos.y = groundH(walk.pos.x, walk.pos.z);
      colocaCamaraAPie();
    }
    function colocaCamaraAPie() {
      // La capa de parcelas baja hasta rozar el suelo mientras se anda (si no,
      // flotaría a la altura de los ojos y taparía la calle).
      dropUniform.value = walk.fly < 20 ? LIFT - 0.12 : 0;
      rig.position.set(walk.pos.x, walk.pos.y + walk.fly, walk.pos.z); rig.rotation.set(0, walk.yaw, 0);
      camera.position.set(0, EYE, 0); camera.rotation.set(walk.pitch, 0, 0);
      camera.near = 0.3; camera.far = Math.max(S.L * 4, 60000);
      camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      cam.cur.target.copy(walk.pos); cam.goal.target.copy(walk.pos); cam.cur.radius = cam.goal.radius = 40;
    }
    function cullLabels() {
      var W = viewportUniform.value.x, H = viewportUniform.value.y;
      _cp.setFromMatrixPosition(camera.matrixWorld);
      labelRects.n = 0;
      S.townsTop.cull(camera, _cp, W, H, labelRects);
      C.avatarLabels.cull(camera, _cp, W, H, labelRects);
      C.ghostLabels.cull(camera, _cp, W, H, labelRects);
      if (S.lmLabels) S.lmLabels.cull(camera, _cp, W, H, labelRects);
      S.towns.cull(camera, _cp, W, H, labelRects);
      C.saleLabels.cull(camera, _cp, W, H, labelRects);
      C.ownerLabels.cull(camera, _cp, W, H, labelRects);
      for (var ie = 0; ie < extEtiquetas.length; ie++) extEtiquetas[ie].cull(camera, _cp, W, H, labelRects);
    }
    var lastSun = 0;
    function updateShadowFrame() {
      if (!Q.shadows) return;
      var tg = cam.cur.target;
      // Caja de sombra proporcional a lo que se ve: a pie, 350 m nítidos; en órbita lejana, hasta 3,5 km.
      var r = S.mode === 'walk' ? 350 : clamp(cam.cur.radius * 1.3, 350, 3500);
      var sc = sun.shadow.camera;
      if (Math.abs(sc.right - r) > 1) { sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 10; sc.far = r * 6; sc.updateProjectionMatrix(); }
      sun.position.set(tg.x + lightDir.x * r * 3, Math.max(tg.y, 0) + lightDir.y * r * 3 + 50, tg.z + lightDir.z * r * 3);
      sun.target.position.copy(tg); sun.target.updateMatrixWorld();
    }
    function frame(now) {
      S.raf = 0;
      if (S.disposed) return;
      var dt = Math.min(0.1, (now - S.lastT) / 1000) || 0.016; S.lastT = now;
      S.fpsN++;
      if (!S.fpsT) S.fpsT = now;
      else if (now - S.fpsT >= 1000) { S.fps = S.fpsN * 1000 / (now - S.fpsT); S.fpsN = 0; S.fpsT = now; }
      if (S.ready) {
        updateCamera(dt);
        if (now - lastSun > 2000) { lastSun = now; updateSun(); }
        var dist = S.mode === 'walk' ? 2000 : camera.position.distanceTo(cam.cur.target);
        scene.fog.near = dist + S.L * 0.15 * Q.far; scene.fog.far = dist + S.L * 1.6 * Q.far;
        _cp.setFromMatrixPosition(camera.matrixWorld);
        S.sky.position.copy(_cp); S.stars.position.copy(_cp);
        S.sea.material.uniforms.uTime.value = now / 1000; ghostTime.value = now / 1000;
        var far = _cp.distanceTo(S.center) > S.L;
        S.lod = far ? 1 : 0; lodUniform.value = S.lod;
        S.fine.mesh.visible = !far; S.coarse.mesh.visible = far;
        updateTraffic(dt); updateAvatars(dt); updateShadowFrame();
        emitir('cuadro', dt, now);
        cullLabels();
        if (pointerDirty) { pointerDirty = false; setHover(pointerPos && !drag ? pick(pointerPos.x, pointerPos.y) : null); }
      }
      // Un módulo puede dibujar el cuadro él mismo (el acabado de imagen pinta la
      // escena en un destino intermedio y la compone); si ninguno lo hace, se
      // dibuja como siempre.
      if (!(S.ready && emitirHasta('pintar', now))) renderer.render(scene, camera);
      if (S.ready) emitir('trasPintar', now);
      S.frame++;
      if (S.bench) benchFrame(now);
      syncLoop();
    }
    // --- Medida de fluidez (v0.10.13) ------------------------------------------------
    // Ninguna cifra de fluidez de este proyecto estaba medida en una tarjeta
    // gráfica de verdad: el entorno donde se construye dibuja por software a uno o
    // dos cuadros por segundo. La medida se hace donde hay tarjeta: en el panel del
    // usuario. Cuatro encuadres fijos —la ciudad entera, el centro, un hito de
    // cerca y a pie en un cruce—, un segundo de calentamiento y unos segundos de
    // cuenta cada uno; de cada vista se anota la media, el peor cuadro, los
    // triángulos y las llamadas de dibujo del último cuadro, y el nombre de la
    // tarjeta que da el navegador. Corre dentro del bucle normal de dibujo, así
    // que mide lo mismo que ve el usuario, y al terminar devuelve la cámara donde
    // estaba.
    function gpuName() {
      try {
        var gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      } catch (e) { return '?'; }
    }
    function ponVista(v) {
      cam.flight = null;
      cam.cur.theta = cam.goal.theta = v.theta; cam.cur.phi = cam.goal.phi = v.phi;
      cam.cur.radius = cam.goal.radius = clamp(v.radius, cam.minR, cam.maxR);
      cam.cur.target.copy(v.target); cam.goal.target.copy(v.target);
    }
    function copiaVista(v) { return { theta: v.theta, phi: v.phi, radius: v.radius, target: v.target.clone() }; }
    /** Un cruce de la trama de barrio más grande, mirando a lo largo de la calle. */
    function puntoAPie() {
      var t = null, i;
      for (i = 0; i < S.tramas.length; i++) if (!t || S.tramas[i].R > t.R) t = S.tramas[i];
      if (!t) return { x: S.gridCenter.x, z: S.gridCenter.z, yaw: 0 };
      var cs = Math.cos(t.ang), sn = Math.sin(t.ang), d = t.paso;
      // El frente a pie es (−sin yaw, −cos yaw): para mirar por (cs, sn), yaw = atan2(−cs, −sn).
      return { x: t.x + cs * d - sn * d + cs * 12, z: t.z + sn * d + cs * d + sn * 12, yaw: Math.atan2(-cs, -sn) };
    }
    function bench(opts) {
      opts = opts || {};
      if (!S.ready) return Promise.reject(new Error('la ciudad no está cargada'));
      if (S.xr) return Promise.reject(new Error('no se mide en VR'));
      if (S.bench) return S.bench.promise;
      var seg = clamp(Number(opts.segundos) || 4, 1, 20);
      var vistas = [
        { id: 'ciudad', pon: function () { setMode('orbit'); ponVista(cityView()); } },
        { id: 'centro', pon: function () { setMode('orbit'); ponVista(skylineView()); } },
        { id: 'cerca', pon: function () {
          setMode('orbit');
          var l = S.lmIndex.burj_khalifa || tallestLandmark();
          ponVista(l ? { theta: 2.6, phi: 1.05, radius: Math.max(l.h * 2.2, l.w * 3, 300), target: new THREE.Vector3(l.x, l.y, l.z) } : cityView());
        } },
        { id: 'a_pie', pon: function () {
          var p = puntoAPie();
          setMode('walk'); walk.pos.set(p.x, 0, p.z); walk.yaw = p.yaw; walk.pitch = 0.05; walk.fly = 0;
        } }
      ];
      var b = {
        vistas: vistas, i: -1, fase: 2, t0: 0, n: 0, peor: 0, ultimo: 0, res: [], seg: seg, inicio: performance.now(),
        guardado: { mode: S.mode, cur: copiaVista(cam.cur), goal: copiaVista(cam.goal), flight: cam.flight, pos: walk.pos.clone(), yaw: walk.yaw, pitch: walk.pitch, fly: walk.fly }
      };
      b.promise = new Promise(function (resolve, reject) { b.resolve = resolve; b.reject = reject; });
      S.bench = b;
      syncLoop();
      return b.promise;
    }
    /** Un cuadro de la medida: fase 0 calienta un segundo, fase 1 cuenta, fase 2 pasa a la vista siguiente. */
    function benchFrame(now) {
      var b = S.bench;
      if (b.fase === 2) {
        b.i++;
        if (b.i >= b.vistas.length) { benchFin(); return; }
        b.vistas[b.i].pon(); b.fase = 0; b.t0 = now;
        return;
      }
      if (b.fase === 0) {
        if (now - b.t0 >= 1000) { b.fase = 1; b.t0 = now; b.ultimo = now; b.n = 0; b.peor = 0; }
        return;
      }
      var ms = now - b.ultimo; b.ultimo = now; b.n++;
      if (ms > b.peor) b.peor = ms;
      if (now - b.t0 >= b.seg * 1000) {
        var el = (now - b.t0) / 1000;
        b.res.push({ vista: b.vistas[b.i].id, fps: Math.round(b.n / el * 10) / 10, fpsMin: Math.round(1000 / Math.max(b.peor, 1) * 10) / 10, cuadros: b.n,
                     triangulos: renderer.info.render.triangles, llamadas: renderer.info.render.calls });
        b.fase = 2;
      }
    }
    function benchFin() {
      var b = S.bench, g = b.guardado; S.bench = null;
      if (g.mode === 'walk') { setMode('walk'); walk.pos.copy(g.pos); walk.yaw = g.yaw; walk.pitch = g.pitch; walk.fly = g.fly; }
      else { setMode('orbit'); ponVista(g.cur); cam.goal.theta = g.goal.theta; cam.goal.phi = g.goal.phi; cam.goal.radius = g.goal.radius; cam.goal.target.copy(g.goal.target); cam.flight = g.flight; }
      b.resolve({ gpu: gpuName(), calidad: qualityName, ancho: renderer.domElement.width, alto: renderer.domElement.height, pixelRatio: renderer.getPixelRatio(),
                  segundos: b.seg, duracion: Math.round((performance.now() - b.inicio) / 100) / 10, vistas: b.res });
    }
    function resize() {
      if (S.disposed) return;
      var w = container.clientWidth || 640, h = container.clientHeight || 400;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      viewportUniform.value.set(w, h);
      emitir('tamano', w, h);
    }
    resize();
    syncLoop();

    // --- VR: WebXR con mandos (palanca para andar, giro por saltos, gatillo para teletransporte) ---
    var xr = { session: null, entering: false, saved: null, ctrl: [], snapAt: 0, lastTrig: [false, false] };
    function xrSupported() {
      if (!global.navigator || !navigator.xr || !navigator.xr.isSessionSupported) return Promise.resolve(false);
      return navigator.xr.isSessionSupported('immersive-vr').then(function (v) { return !!v; }, function () { return false; });
    }
    function vrPlacement(out) {
      if (S.mode === 'walk') { out.set(walk.pos.x, groundH(walk.pos.x, walk.pos.z) + walk.fly, walk.pos.z); return out; }
      var cell = S.sel || { x: N >> 1, y: N >> 1 }, w = cellWorld(cell.x, cell.y), off = rotOff(0, CELL * 0.42);
      var sp = clearOfLandmarks(w.x + off.x, w.z + off.z), x = sp.x, z = sp.z;
      out.set(x, groundH(x, z) + LIFT, z);
      return out;
    }
    function restoreDesktop() {
      renderer.setAnimationLoop(null);
      renderer.xr.enabled = false;
      var i;
      for (i = 0; i < xr.ctrl.length; i++) { rig.remove(xr.ctrl[i]); }
      xr.ctrl = [];
      xr.session = null; xr.entering = false;
      // Al salir, seguimos a pie donde estábamos con las gafas.
      walk.pos.set(rig.position.x, 0, rig.position.z); walk.yaw = rig.rotation.y; walk.fly = 0;
      rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
      camera.position.set(0, 0, 0); camera.quaternion.set(0, 0, 0, 1);
      if (xr.saved) { camera.near = xr.saved.near; camera.far = xr.saved.far; camera.updateProjectionMatrix(); xr.saved = null; }
      S.xr = false;
      if (S.mode !== 'walk') { S.mode = 'walk'; onMode('walk'); }
      emitir('vr', false);
      syncLoop();
    }
    var _hq = new THREE.Quaternion(), _hv = new THREE.Vector3(), _co = new THREE.Vector3(), _cd = new THREE.Vector3(), _teleHit = new THREE.Vector3();
    function xrInput(dt) {
      var session = xr.session; if (!session || !session.inputSources) return;
      var xrCam = renderer.xr.getCamera(camera);
      xrCam.getWorldQuaternion(_hq);
      _hv.set(0, 0, -1).applyQuaternion(_hq); var headYaw = Math.atan2(-_hv.x, -_hv.z);
      var i;
      for (i = 0; i < session.inputSources.length; i++) {
        var src = session.inputSources[i], gp = src.gamepad; if (!gp) continue;
        var ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] || 0, gp.axes[1] || 0];
        if (src.handedness === 'left' || session.inputSources.length === 1) {
          var mx = Math.abs(ax[0]) > 0.15 ? ax[0] : 0, mz = Math.abs(ax[1]) > 0.15 ? ax[1] : 0;
          if (mx || mz) {
            var sp = 4 * (gp.buttons[1] && gp.buttons[1].pressed ? 5 : 1) * dt;
            var fx = -Math.sin(headYaw), fz = -Math.cos(headYaw), rx = Math.cos(headYaw), rz = -Math.sin(headYaw);
            rig.position.x += (fx * -mz + rx * mx) * sp; rig.position.z += (fz * -mz + rz * mx) * sp;
          }
          if (gp.buttons[4] && gp.buttons[4].pressed) rig.position.y += 3 * dt; // X: subir
          if (gp.buttons[5] && gp.buttons[5].pressed) rig.position.y -= 3 * dt; // Y: bajar
        }
        if (src.handedness === 'right') {
          if (Math.abs(ax[0]) > 0.7 && performance.now() - xr.snapAt > 350) { rig.rotation.y -= Math.sign(ax[0]) * Math.PI / 6; xr.snapAt = performance.now(); }
          var trig = !!(gp.buttons[0] && gp.buttons[0].pressed);
          if (trig && !xr.lastTrig[i] && xr.ctrl[i]) {
            xr.ctrl[i].getWorldPosition(_co); _cd.set(0, 0, -1).applyQuaternion(xr.ctrl[i].getWorldQuaternion(_hq));
            if (rayTerrain(_co, _cd, _teleHit)) { rig.position.x = _teleHit.x; rig.position.z = _teleHit.z; }
          }
          xr.lastTrig[i] = trig;
        }
      }
      var gh = groundH(rig.position.x, rig.position.z);
      if (rig.position.y < gh) rig.position.y = gh;
      if (rig.position.y - gh < 2) empujarDeMoviles(rig.position, 0.42);
    }
    var xrLast = 0;
    function xrFrame(now) {
      var dt = Math.min(0.1, (now - xrLast) / 1000) || 0.016; xrLast = now;
      xrInput(dt);
      S.sea.material.uniforms.uTime.value = now / 1000;
      _cp.setFromMatrixPosition(camera.matrixWorld);
      S.sky.position.copy(_cp); S.stars.position.copy(_cp);
      updateTraffic(dt); updateAvatars(dt); updateShadowFrame();
      emitir('cuadro', dt, now);
      if (now - lastSun > 2000) { lastSun = now; updateSun(); }
      renderer.render(scene, camera); S.frame++;
    }
    function enterVR() {
      if (!global.navigator || !navigator.xr) return Promise.reject(new Error(t('WebXR no disponible')));
      if (xr.session || xr.entering) return Promise.resolve(xr.session);
      if (!S.ready) return Promise.reject(new Error(t('El mapa 3D aún no está listo')));
      xr.entering = true;
      return xrSupported().then(function (ok) {
        if (!ok) throw new Error(t('WebXR no disponible'));
        // Nitidez: factor de framebuffer alto (gafas 4K) y sin foveación en calidad alta.
        try { renderer.xr.setFramebufferScaleFactor(Q.vr); } catch (e0) {}
        try { renderer.xr.setFoveation(Q.vr >= 1.5 ? 0 : 0.5); } catch (e1) {}
        return navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] });
      }).then(function (session) {
        xr.session = session;
        xr.saved = { near: camera.near, far: camera.far };
        renderer.xr.enabled = true;
        try { renderer.xr.setReferenceSpaceType('local-floor'); } catch (e) {}
        camera.near = 0.1; camera.far = 200000; camera.updateProjectionMatrix();
        return renderer.xr.setSession(session).then(function () {
          vrPlacement(rig.position); rig.rotation.set(0, S.mode === 'walk' ? walk.yaw : rotR, 0);
          var i;
          for (i = 0; i < 2; i++) {
            var c = renderer.xr.getController(i);
            var line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -6)]), new THREE.LineBasicMaterial({ color: 0x7ef0c0, transparent: true, opacity: 0.6 }));
            c.add(line); rig.add(c); xr.ctrl.push(c);
          }
          S.xr = true; xr.entering = false; syncLoop(); emitir('vr', true);
          session.addEventListener('end', restoreDesktop);
          xrLast = performance.now();
          renderer.setAnimationLoop(xrFrame);
          return session;
        }, function (err) {
          try { session.end(); } catch (e2) {}
          restoreDesktop();
          throw new Error(t('No se pudo iniciar la sesión VR') + ': ' + ((err && err.message) || err));
        });
      }, function (err) { xr.entering = false; throw err; });
    }

    // --- Extensiones (v0.11.0): contexto, ganchos y arranque ------------------------------
    var ext = [], extFallos = {}, extEtiquetas = [], extPublico = {};
    function extLlama(e, gancho, args) {
      var f = e.ganchos[gancho];
      if (typeof f !== 'function') return undefined;
      try { return f.apply(e.ganchos, args); } catch (err) {
        var k = e.nombre + '.' + gancho;
        if (!extFallos[k]) { extFallos[k] = String((err && err.stack) || err); if (global.console) console.error('[city3d] ' + k + ': ' + extFallos[k]); }
        return undefined;
      }
    }
    /** Llama a `gancho` en todos los módulos. */
    function emitir(gancho) {
      if (!ext || !ext.length) return;
      var args = Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < ext.length; i++) extLlama(ext[i], gancho, args);
    }
    /** Llama a `gancho` hasta que un módulo devuelve algo verdadero (y lo devuelve). */
    function emitirHasta(gancho) {
      if (!ext || !ext.length) return false;
      var args = Array.prototype.slice.call(arguments, 1);
      for (var i = 0; i < ext.length; i++) { var r = extLlama(ext[i], gancho, args); if (r) return r; }
      return false;
    }
    /** Llama a `gancho` en todos y devuelve el último valor verdadero. */
    function emitirValor(gancho) {
      if (!ext || !ext.length) return null;
      var args = Array.prototype.slice.call(arguments, 1), out = null;
      for (var i = 0; i < ext.length; i++) { var r = extLlama(ext[i], gancho, args); if (r) out = r; }
      return out;
    }
    function rayoPantalla(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return { origen: raycaster.ray.origin.clone(), dir: raycaster.ray.direction.clone() };
    }
    function infoClic(clientX, clientY, celda) {
      var ry = rayoPantalla(clientX, clientY);
      return { clientX: clientX, clientY: clientY, origen: ry.origen, dir: ry.dir, celda: celda, modo: S.mode };
    }
    var ctx = {
      THREE: THREE, scene: scene, camera: camera, rig: rig, renderer: renderer, canvas: canvas, container: container,
      S: S, C: C, cam: cam, walk: walk, EYE: EYE, t: t, colors: colors, opts: opts,
      Q: function () { return Q; }, calidad: function () { return qualityName; },
      N: function () { return N; }, CELL: function () { return CELL; }, LIFT: function () { return LIFT; }, rotR: function () { return rotR; },
      keys: function () { return keys; }, puntero: function () { return pointerPos; },
      shared: shared, buildMat: buildMat, plainMat: plainMat, terrainMat: terrainMat, mats: mats, noiseTex: noiseTex, envRT: envRT,
      makeBuildingMaterial: makeBuildingMaterial, sun: sun, hemi: hemi, sunDir: sunDir, lightDir: lightDir,
      uniformes: { viewport: viewportUniform, lod: lodUniform, drop: dropUniform, noche: nightUniform, fantasma: ghostTime },
      util: { fnv1a: fnv1a, hash2: hash2, semillaMorfologia: semillaMorfologia, semillaRopaje: semillaRopaje, real01: real01, lcg: lcg,
        clamp: clamp, lerp: lerp, smoothstep: smoothstep, strSeed: strSeed, lin1: lin1, lin3: lin3 },
      geom: { prim: prim, newAcc: newAcc, pushPart: pushPart, pushParts: pushParts, accGeometry: accGeometry, piezas: piezas,
        cuerpoTorre: cuerpoTorre, cuerpoBloque: cuerpoBloque, cuerpoNave: cuerpoNave, cuerpoVilla: cuerpoVilla, parcelaPartes: parcelaPartes,
        edificioPartes: edificioPartes, carGeometry: carGeometry, avatarBodyGeometry: avatarBodyGeometry, avatarLimbGeometry: avatarLimbGeometry,
        palmGeometry: palmGeometry, inst: inst, place: place, finish: finish, ensureCap: ensureCap,
        colores: { GLASS: GLASS, GLASS2: GLASS2, STEEL: STEEL, WHITE: WHITE, SAND: SAND, GOLD: GOLD, DARK: DARK, GREEN: GREEN, PINK: PINK, RED: RED, ASPHALT: ASPHALT, WATER: WATER,
          PUERTA: TONO_PUERTA, VIDRIERA: TONO_VIDRIERA } },
      mundo: { surfaceH: surfaceH, coarseH: coarseH, groundH: groundH, insideMap: insideMap, cellWorld: cellWorld, cellLocal: cellLocal,
        worldToCell: worldToCell, localToWorld: localToWorld, worldToLocal: worldToLocal, latLonToCell: latLonToCell, cellLatLon: cellLatLon,
        rotOff: rotOff, gridYaw: gridYaw, districtOf: districtOf, dubaiHour: dubaiHour, parcelInfo: parcelInfo, sectorName: sectorName,
        SECTOR_ARCH: SECTOR_ARCH, SECTOR_COLORS: SECTOR_COLORS, SECTOR_NAMES: SECTOR_NAMES, ARCH_KEYS: ARCH_KEYS,
        TESELA_VIA: TESELA_VIA, TIPOS_BARRIO: TIPOS_BARRIO, fachadaBarrio: fachadaBarrio, fachadaParcela: fachadaParcela,
        FACHADA: { RETICULA: FACHADA_RETICULA, LISA: FACHADA_LISA, CORTINA: FACHADA_CORTINA, CINTA: FACHADA_CINTA } },
      catastro: { alta: function (so) { catastroAlta(S.catastro, so); }, quita: function (pred) { catastroQuita(S.catastro, pred); },
        bajo: solidoBajo, rayo: rayoSolido, empujarFuera: empujarFuera, huellaLibre: function (x, z, r) { return huellaLibre(S.catastro, x, z, r); }, aLocal: aLocal },
      pick: pick, rayoPantalla: rayoPantalla, setMode: setMode,
      rehacerBarrios: function () { buildClusters(); },
      reaplicarCiudad: function () { if (S.city) applyCity(S.city); },
      /** Registra un LabelSet del módulo para que se recorte con los demás (el módulo lo añade a la escena). */
      etiquetas: function (ls) { if (extEtiquetas.indexOf(ls) < 0) extEtiquetas.push(ls); },
      LabelSet: LabelSet,
      /** Servicios que un módulo ofrece a los demás (p. ej. `servicios.sonido`). */
      servicios: {},
      /** Fallos de los módulos (nombre.gancho → traza), para las pruebas. */
      fallos: function () { return extFallos; },
      handle: null
    };
    for (var ix = 0; ix < EXTENSIONES.length; ix++) {
      var reg = EXTENSIONES[ix], ganchos = null;
      try { ganchos = reg.fabrica(ctx) || {}; } catch (errF) {
        extFallos[reg.nombre + '.fabrica'] = String((errF && errF.stack) || errF);
        if (global.console) console.error('[city3d] ' + reg.nombre + '.fabrica: ' + extFallos[reg.nombre + '.fabrica']);
        continue;
      }
      ext.push({ nombre: reg.nombre, ganchos: ganchos });
      extPublico[reg.nombre] = ganchos.publico || {};
    }

    // --- API pública ---------------------------------------------------------------------
    var handle = {
      ready: ready,
      setCity: function (data) {
        if (!data) return;
        var h = fnv1a(JSON.stringify(data));
        if (h === S.cityHash) return;
        S.cityHash = h;
        // `datos` es la vista entera tal como llega (altura, fondo, huecos, fechas de
        // activación…): los módulos leen de ahí lo que el núcleo no necesita.
        S.city = { parcels: data.parcels || [], assets: data.assets || [], me: data.me || null, size: data.size, sectors: data.sectors || null, districts: data.districts || null, height: data.height | 0, datos: data };
        if (data.districts && data.districts.length) S.districts = data.districts;
        if (S.ready) applyCity(S.city); else pending = S.city;
      },
      select: function (x, y) { doSelect((x === null || x === undefined) ? null : { x: x | 0, y: y | 0 }, false); },
      flyTo: flyTo, flyToIsland: flyToIsland, flyToCity: flyToCity, flyToSkyline: flyToSkyline, flyToLandmark: flyToLandmark,
      setParcelGrid: setParcelGrid, parcelGrid: function () { return S.gridShown; },
      solidoEn: function (wx, wz) { return solidoBajo(wx, wz); },
      landmarks: function () { return S.landmarks.map(function (l) { return { id: l.id, name: l.name, h: l.h, lat: l.lat, lon: l.lon, shape: l.shape }; }); },
      setMode: setMode, mode: function () { return S.xr ? 'vr' : S.mode; },
      setQuality: setQuality, quality: function () { return qualityName; },
      setTimeOfDay: setTimeOfDay, timeOfDay: function () { return dubaiHour(); }, night: function () { return S.night; },
      setPresence: setPresence, myPose: myPose, setGhosts: setGhosts,
      /** A pie en una pose dada: x,y en metros locales de la cuadrícula, yaw en grados desde el norte local (horario), pitch en radianes, fly en m. */
      setPose: function (p) {
        if (!S.ready) return false;
        setMode('walk');
        var w = localToWorld(p.x || 0, p.y || 0);
        var sp = clearOfLandmarks(w.x, w.z);
        walk.pos.set(sp.x, 0, sp.z); walk.yaw = rotR - (p.yaw || 0) * Math.PI / 180; walk.pitch = clamp(p.pitch || 0, -1.4, 1.4); walk.fly = Math.max(0, p.fly || 0);
        return true;
      },
      resize: resize,
      setVisible: function (v) { S.visible = !!v; syncLoop(); },
      xrSupported: xrSupported, enterVR: enterVR,
      stats: function () {
        var env = null;
        try { var px = new Uint8Array(4 * 4 * 4); renderer.readRenderTargetPixels(envRT, 0, 0, 4, 4, px, 2); var sum = 0; for (var i = 0; i < 64; i++) sum += px[i]; env = Math.round(sum / 64); } catch (e) { env = -1; }
        var o = { fps: Math.round(S.fps), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frame: S.frame, landmarks: S.landmarks.length, skyline: S.clusterTotal, solidos: S.catastro ? S.catastro.items.length : 0, trozosBarrio: S.trozosBarrio, trozosParcela: S.trozosParcela, ocultos: S.ocultos, trozosFantasma: S.trozosFantasma, avatars: S.avatarOrder.length, quality: qualityName, mode: S.xr ? 'vr' : S.mode, env: env, ext: {} };
        emitir('estadisticas', o.ext);
        return o;
      },
      bench: bench, gpu: gpuName,
      latLonToCell: latLonToCell,
      cellLatLon: cellLatLon,
      grid: function () { return { size: N, cellMeters: CELL, anchor: anchor }; },
      districtOf: districtOf,
      sectorNames: SECTOR_NAMES, sectorColors: SECTOR_COLORS,
      cellWorld: function (x, y) { return S.ready ? cellWorld(x, y) : null; },
      cellInfo: function (x, y) {
        if (!S.ready) return null;
        var ci = (y | 0) * N + (x | 0);
        return { h: S.cellH[ci], top: S.cellTop[ci], lift: LIFT, sea: !!S.cellSea[ci], state: S.cellState[ci], district: districtOf(x | 0, y | 0) };
      },
      project: function (x, y) {
        if (!S.ready) return null;
        var v = cellWorld(x, y).project(camera), r = canvas.getBoundingClientRect();
        return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, visible: v.z < 1 };
      },
      heightAt: function (lat, lon) { if (!S.ready) return null; var w = S.geo.toWorld(lat, lon); return S.field.atWorld(w.x, w.z); },
      dispose: function () {
        if (S.disposed) return;
        emitir('soltar');
        S.disposed = true; syncLoop();
        if (S.bench) { S.bench.reject(new Error('cliente cerrado')); S.bench = null; }
        if (xr.session) { try { xr.session.end(); } catch (e) {} }
        canvas.removeEventListener('pointerdown', L.pointerdown); canvas.removeEventListener('pointermove', L.pointermove);
        canvas.removeEventListener('pointerup', L.pointerup); canvas.removeEventListener('pointercancel', L.pointerup);
        canvas.removeEventListener('pointerleave', L.pointerleave); canvas.removeEventListener('dblclick', L.dblclick);
        canvas.removeEventListener('wheel', L.wheel); canvas.removeEventListener('contextmenu', L.contextmenu);
        canvas.removeEventListener('keydown', L.keydown); canvas.removeEventListener('keyup', L.keyup);
        canvas.removeEventListener('blur', L.blur);
        document.removeEventListener('visibilitychange', L.visibility); global.removeEventListener('resize', L.resize);
        global.removeEventListener('blur', L.blur);
        if (ro) ro.disconnect();
        scene.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var i = 0; i < mats.length; i++) {
              for (var u in (mats[i].uniforms || {})) { var uv = mats[i].uniforms[u].value; if (uv && uv.isTexture) uv.dispose(); }
              mats[i].dispose();
            }
          }
          if (o.isInstancedMesh) o.dispose();
        });
        if (S.towns) S.towns.dispose();
        if (S.townsTop) S.townsTop.dispose();
        if (S.lmLabels) S.lmLabels.dispose();
        if (C.selLabel) C.selLabel.dispose();
        if (C.saleLabels) C.saleLabels.dispose();
        if (C.ownerLabels) C.ownerLabels.dispose();
        if (C.avatarLabels) C.avatarLabels.dispose();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e2) {}
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
      _debug: { scene: scene, camera: camera, renderer: renderer, state: S, meshes: C, cam: cam, walk: walk, vrPlacement: function () { return vrPlacement(new THREE.Vector3()); }, keysDown: function () { return Object.keys(keys); }, pick: pick, rayoSolido: rayoSolido, empujarFuera: empujarFuera, empujarDeMoviles: empujarDeMoviles,
        // Un paso de simulación sin dibujar, para probar la colisión sin depender del reloj.
        paso: function (dt) { if (!S.ready) return; updateCamera(dt); updateTraffic(dt); updateAvatars(dt); emitir('cuadro', dt, performance.now()); },
        ctx: ctx, extFallos: function () { return extFallos; } }
    };
    // Lo que cada módulo publica (`publico`) cuelga de handle.ext[nombre].
    handle.ext = extPublico;
    ctx.handle = handle;
    // Si el mundo ya estuviera construido (no pasa hoy: se carga asíncrono), el
    // módulo recibe su «listo» igual.
    if (S.ready) emitir('listo');
    return handle;
  }

  global.RamiCity3D = { mount: mount, extend: extend, extensiones: function () { return EXTENSIONES.map(function (e) { return e.nombre; }); }, version: '2.1.0', sectorNames: SECTOR_NAMES, sectorColors: SECTOR_COLORS, shapes: Object.keys(SHAPES), _internals: { inflate: inflate, inflateStream: inflateStream, decodePngGray: decodePngGray, decodePngGrayAsync: decodePngGrayAsync, fnv1a: fnv1a, lcg: lcg } };
})(typeof window !== 'undefined' ? window : this);
