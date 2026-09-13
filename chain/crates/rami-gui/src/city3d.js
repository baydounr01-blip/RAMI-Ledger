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
 *   flyToIsland() [vista general de Dubái] / flyToLandmark(id) / landmarks() /
 *   setMode('orbit'|'walk') / mode() / setQuality('baja'|'media'|'alta'|'ultra') /
 *   setTimeOfDay(horas|null) / setPresence(lista) / myPose() /
 *   resize() / setVisible(bool) / dispose() / xrSupported() / enterVR() /
 *   stats() / latLonToCell(lat,lon) / cellLatLon(x,y) / cellWorld(x,y) /
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
 *      skylines por barrio con InstancedMesh; tráfico ambiente por las vías;
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
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide
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
    'varying vec3 vNormalW; varying vec3 vWorld; varying float vLocalY;',
    'void main(){',
    '  #include <color_vertex>',
    '  vec3 on = normal;',
    '  #ifdef USE_INSTANCING', '  on = mat3(instanceMatrix) * on;', '  #endif',
    '  vec3 transformedNormal = normalMatrix * on;',
    '  vNormalW = normalize(mat3(modelMatrix) * on);',
    '  vec4 wp = vec4(position, 1.0);',
    '  #ifdef USE_INSTANCING', '  wp = instanceMatrix * wp;', '  #endif',
    '  vec4 worldPosition = modelMatrix * wp; vWorld = worldPosition.xyz; vLocalY = position.y;',
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
    'varying vec3 vNormalW; varying vec3 vWorld; varying float vLocalY;',
    'float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec3 base = vec3(0.8);',
    '  #if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)', '  base = vColor.rgb;', '  #endif',
    '  vec3 n = normalize(vNormalW);',
    '  vec3 v = normalize(cameraPosition - vWorld);',
    '  float shadow = getShadowMask();',
    '  float ndl = max(dot(n, uSun), 0.0) * shadow;',
    '  float glassy = smoothstep(0.02, 0.16, base.b - base.r) * uWindows;',
    '  float facade = clamp(1.0 - abs(n.y) * 1.2, 0.0, 1.0);',
    '  vec2 uvw = vec2(dot(vWorld.xz, vec2(n.z, -n.x)), vWorld.y);',
    '  vec2 cellSz = vec2(4.5, 3.6);',
    '  vec2 cell = floor(uvw / cellSz); vec2 f = fract(uvw / cellSz);',
    '  float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.86);',
    '  float glass = win * facade * step(5.0, vLocalY) * uWindows;',
    '  float slab = (1.0 - smoothstep(0.0, 0.07, f.y)) * facade * uWindows * step(5.0, vLocalY);',
    '  float rnd = hash21(cell + floor(vWorld.xz * 0.002));',
    '  float lit = step(0.55, rnd);',
    '  float ao = mix(0.6, 1.0, smoothstep(0.0, 16.0, vLocalY));',
    '  vec3 amb = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y) * ao;',
    '  vec3 albedo = base;',
    '  albedo = mix(albedo, albedo * 0.45 + vec3(0.015, 0.04, 0.07), glass * 0.65);',
    '  albedo *= 1.0 - slab * 0.4;',
    '  albedo *= mix(1.0, 0.82, step(0.9, n.y) * uWindows);',
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
    '  col += vec3(1.0, 0.72, 0.42) * glass * on * (0.22 + 0.25 * rnd);',
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
    'uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor; uniform float uNight; uniform sampler2D uNoise;',
    'varying vec3 vNormalW; varying vec3 vWorld;',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec3 base = vec3(0.6);',
    '  #ifdef USE_COLOR', '  base = vColor.rgb;', '  #endif',
    '  float shadow = getShadowMask();',
    '  float dist = length(cameraPosition - vWorld);',
    '  float n1 = texture2D(uNoise, vWorld.xz / 90.0).r, n2 = texture2D(uNoise, vWorld.xz / 760.0 + 0.37).r, n3 = texture2D(uNoise, vWorld.xz / 7.0).r;',
    '  float near = 1.0 - smoothstep(60.0, 900.0, dist);',
    '  float detail = 0.84 + 0.20 * n1 + 0.12 * (n2 - 0.5) + 0.08 * (n3 - 0.5) * near;',
    '  vec3 n = normalize(vNormalW);',
    '  float ex = texture2D(uNoise, (vWorld.xz + vec2(2.0, 0.0)) / 90.0).r - n1, ez = texture2D(uNoise, (vWorld.xz + vec2(0.0, 2.0)) / 90.0).r - n1;',
    '  n = normalize(n + vec3(-ex, 0.0, -ez) * 3.0 * (1.0 - smoothstep(400.0, 4000.0, dist)));',
    '  float ndl = max(dot(n, uSun), 0.0) * shadow;',
    '  vec3 amb = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y);',
    '  vec3 col = base * detail * (amb * 0.9 + uSunColor * ndl * 1.2);',
    '  col = mix(col, col * 0.2 + vec3(0.004, 0.006, 0.012), uNight);',
    '  gl_FragColor = vec4(col, 1.0);',
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '  #include <fog_fragment>',
    '}'].join('\n');
  function makeTerrainMaterial(shared, noise) {
    var u = THREE.UniformsUtils.merge([THREE.UniformsLib.lights, THREE.UniformsLib.fog]);
    u.uSun = shared.uSun; u.uSunColor = shared.uSunColor; u.uSkyColor = shared.uSkyColor; u.uGroundColor = shared.uGroundColor; u.uNight = shared.uNight;
    u.uNoise = { value: noise };
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: TERR_VS, fragmentShader: TERR_FS, vertexColors: true, fog: true, lights: true });
  }
  /** Ruido de valor con 4 octavas, 256×256, repetible: relieve de la arena y variación del suelo. */
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
        parts.push({ g: 'sphere', sx: R * 0.09, sy: R * 0.09, sz: R * 0.12, x: Math.cos(a) * R, y: cy + Math.sin(a) * R, c: GLASS });
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

  /**
   * Arquetipos de edificio por sector, escalados con la celda (huella ~0.28·CELL,
   * alturas acotadas a [8, 400] m) y con una «cimentación» que baja bajo el suelo
   * para no flotar en laderas. Devuelven piezas en blanco: el color lo pone la
   * instancia (color del sector).
   */
  function archetypeParts(key, c) {
    var f = c * 0.28, fd = clamp(c * 0.12, 3, 400), i, parts;
    var H = function (k, lo, hi) { return clamp(c * k, lo || 8, hi || 400); };
    switch (key) {
      case 'torre': return [{ sx: f * 0.6, sy: H(0.18) + fd, sz: f * 0.6, y: -fd, c: WHITE }, { sx: f * 0.42, sy: H(0.18) * 0.08, sz: f * 0.42, y: H(0.18), c: [0.7, 0.7, 0.72] }, { g: 'cyl', a: 6, sx: f * 0.03, sy: H(0.18) * 0.15, sz: f * 0.03, y: H(0.18) * 1.08, c: [0.6, 0.6, 0.62] }];
      case 'hotel': return [{ sx: f * 1.1, sy: H(0.14) + fd, sz: f * 0.45, y: -fd, c: WHITE }, { sx: f * 1.16, sy: H(0.14) * 0.06, sz: f * 0.5, y: H(0.14), c: [0.9, 0.8, 0.55] }, { sx: f * 0.5, sy: 1.2, sz: f * 0.3, z: f * 0.5, c: WATER }, { sx: f * 1.2, sy: 0.6, sz: f * 1.3, z: f * 0.3, c: [0.95, 0.9, 0.75] }];
      case 'comercio': return [{ sx: f * 0.9, sy: H(0.05) + fd, sz: f * 0.7, y: -fd, c: WHITE }, { sx: f * 1.0, sy: H(0.05) * 0.12, sz: f * 0.25, y: H(0.05) * 0.5, z: f * 0.45, c: [1, 1, 1] }, { sx: f * 0.6, sy: H(0.05) * 0.3, sz: f * 0.04, y: H(0.05), z: f * 0.3, c: [1, 1, 0.85] }];
      case 'concesionario':
        parts = [{ sx: f * 1.0, sy: H(0.045) + fd, sz: f * 0.6, y: -fd, c: [0.8, 0.9, 1] }, { sx: f * 1.3, sy: 0.5, sz: f * 1.2, z: f * 0.35, c: ASPHALT }, { sx: f * 0.9, sy: H(0.045) * 0.25, sz: f * 0.04, y: H(0.045), z: f * 0.3, c: [1, 0.35, 0.3] }];
        for (i = 0; i < 6; i++) parts.push({ sx: f * 0.09, sy: 1.6, sz: f * 0.045, x: -f * 0.45 + i * f * 0.18, z: f * 0.7, c: [0.9, 0.9, 0.95] });
        return parts;
      case 'industria': return [{ sx: f * 1.2, sy: H(0.04) + fd, sz: f * 0.8, y: -fd, c: [0.85, 0.85, 0.85] }, { g: 'halfcyl', sx: f * 0.8, sy: f * 1.2, sz: H(0.04) * 0.5, x: f * 0.6, y: H(0.04), rz: Math.PI / 2, c: [0.6, 0.6, 0.62] }, { g: 'cyl', a: 10, sx: f * 0.14, sy: H(0.09), sz: f * 0.14, x: f * 0.75, z: -f * 0.3, c: [0.7, 0.7, 0.72] }, { sx: f * 0.05, sy: H(0.12), sz: f * 0.05, x: -f * 0.7, z: f * 0.4, c: [0.9, 0.55, 0.2] }, { sx: f * 0.9, sy: f * 0.04, sz: f * 0.04, x: -f * 0.35, y: H(0.12), z: f * 0.4, c: [0.9, 0.55, 0.2] }];
      case 'solar':
        parts = [{ sx: f * 0.4, sy: H(0.02) + fd, sz: f * 0.3, y: -fd, z: -f * 0.6, c: WHITE }];
        for (i = 0; i < 24; i++) parts.push({ g: 'slab', sx: f * 0.22, sy: 0.4, sz: f * 0.12, x: -f * 0.6 + (i % 6) * f * 0.24, y: 3, z: -f * 0.25 + Math.floor(i / 6) * f * 0.2, rx: -0.45, c: [0.12, 0.18, 0.45] });
        return parts;
      case 'agua':
        parts = [{ sx: f * 0.7, sy: H(0.03) + fd, sz: f * 0.5, y: -fd, c: WHITE }];
        for (i = 0; i < 4; i++) parts.push({ g: 'cyl', a: 14, sx: f * 0.22, sy: H(0.05), sz: f * 0.22, x: -f * 0.45 + i * f * 0.3, z: f * 0.45, c: [0.8, 0.9, 0.95] });
        parts.push({ g: 'cyl', a: 8, sx: f * 0.05, sy: f * 1.2, sz: f * 0.05, x: 0, y: H(0.05) * 0.5, z: f * 0.45, rz: Math.PI / 2, c: [0.3, 0.6, 0.75] });
        return parts;
      case 'granja': return [{ sx: f * 1.2, sy: H(0.035) + fd, sz: f, y: -fd, c: [1, 1, 0.94] }, { sx: f * 1.26, sy: H(0.035) * 0.25, sz: f * 1.06, y: H(0.035), c: [0.55, 1, 0.55] }, { g: 'cyl', a: 12, sx: f * 0.16, sy: H(0.035) * 0.6, sz: f * 0.16, x: f * 0.5, z: f * 0.4, y: H(0.035) * 1.2, c: [0.7, 0.7, 0.75] }];
      case 'clinica': return [{ sx: f * 0.9, sy: H(0.09) + fd, sz: f * 0.6, y: -fd, c: WHITE }, { sx: f * 0.12, sy: f * 0.36, sz: f * 0.03, y: H(0.09) * 0.5, z: f * 0.31, c: RED }, { sx: f * 0.36, sy: f * 0.12, sz: f * 0.03, y: H(0.09) * 0.5 + f * 0.12, z: f * 0.31, c: RED }, { g: 'ring', sx: f * 0.4, sy: 1, sz: f * 0.4, x: f * 0.7, y: H(0.09) + 0.5, c: RED }];
      case 'escuela': return [{ sx: f * 1.1, sy: H(0.07) + fd, sz: f * 0.3, y: -fd, z: -f * 0.35, c: [0.95, 0.9, 0.8] }, { sx: f * 0.3, sy: H(0.07) + fd, sz: f * 0.7, y: -fd, x: -f * 0.4, c: [0.95, 0.9, 0.8] }, { sx: f * 0.3, sy: H(0.07) + fd, sz: f * 0.7, y: -fd, x: f * 0.4, c: [0.95, 0.9, 0.8] }, { g: 'hemi', sx: f * 0.3, sy: H(0.07) * 0.4, sz: f * 0.3, y: H(0.07), z: -f * 0.35, c: [0.6, 0.5, 0.9] }, { sx: f * 0.5, sy: 0.5, sz: f * 0.4, z: f * 0.1, c: GREEN }];
      case 'gimnasio': return [{ sx: f * 0.9, sy: H(0.05) + fd, sz: f * 0.7, y: -fd, c: [0.9, 0.9, 0.9] }, { g: 'halfcyl', sx: f * 0.7, sy: f * 0.9, sz: H(0.05) * 0.6, x: f * 0.45, y: H(0.05), rz: Math.PI / 2, c: [0.65, 0.9, 0.3] }, { sx: f * 0.6, sy: 0.4, sz: f * 0.35, z: f * 0.55, c: [0.85, 0.5, 0.3] }];
      case 'turismo': return [{ sx: f * 0.5, sy: H(0.04) + fd, sz: f * 0.5, y: -fd, c: WHITE }, { g: 'cone', a: 8, sx: f * 0.7, sy: H(0.04) * 0.5, sz: f * 0.7, y: H(0.04), c: [0.2, 0.8, 0.85] }, { g: 'cyl', a: 8, sx: f * 0.03, sy: H(0.1), sz: f * 0.03, x: f * 0.4, c: [0.7, 0.7, 0.72] }, { g: 'slab', sx: f * 0.25, sy: f * 0.15, sz: 0.5, x: f * 0.52, y: H(0.1) * 0.92, c: [0.9, 0.2, 0.2] }];
      case 'taxi':
        parts = [{ sx: f * 0.5, sy: H(0.035) + fd, sz: f * 0.4, y: -fd, z: -f * 0.5, c: WHITE }, { sx: f * 1.3, sy: 0.5, sz: f * 1.0, z: f * 0.2, c: ASPHALT }];
        for (i = 0; i < 8; i++) parts.push({ sx: f * 0.08, sy: 1.5, sz: f * 0.04, x: -f * 0.5 + (i % 4) * f * 0.3, z: -f * 0.05 + Math.floor(i / 4) * f * 0.35, c: [1, 0.85, 0.2] });
        return parts;
      case 'seguridad': return [{ sx: f * 0.5, sy: H(0.06) + fd, sz: f * 0.5, y: -fd, c: [0.55, 0.6, 0.68] }, { g: 'cyl', a: 8, sx: f * 0.04, sy: H(0.2), sz: f * 0.04, x: f * 0.3, z: -f * 0.3, c: [0.75, 0.75, 0.78] }, { g: 'sphere', sx: f * 0.1, sy: f * 0.1, sz: f * 0.1, x: f * 0.3, y: H(0.2), z: -f * 0.3, c: [0.95, 0.3, 0.3] }, { sx: f * 1.1, sy: 3, sz: 1, z: f * 0.55, c: [0.6, 0.6, 0.64] }];
    }
    return [{ sx: f, sy: H(0.1) + fd, sz: f * 0.8, y: -fd, c: WHITE }];
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
  /** Palmera datilera (metros): tronco ligeramente inclinado y ocho hojas caídas; color por instancia para el verde. */
  function palmGeometry(seed) {
    var out = newAcc(), parts = [{ g: 'tcyl', a: 8, sx: 0.36, sy: 7.5, sz: 0.36, rz: 0.05 + 0.05 * seed, c: [0.36, 0.28, 0.2] }], k;
    for (k = 0; k < 8; k++) {
      var a = k * Math.PI / 4 + seed * 0.7;
      parts.push({ g: 'slab', sx: 0.5, sy: 0.08, sz: 3.2, x: Math.sin(a) * 1.4, y: 7.6, z: Math.cos(a) * 1.4, ry: a, rx: 0.62, c: [1, 1, 1] });
    }
    parts.push({ g: 'sphere', sx: 0.5, sy: 0.4, sz: 0.5, y: 7.5, c: [0.55, 0.42, 0.18] });
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
    '  vC = vec3(1.0);', '  #ifdef USE_INSTANCING_COLOR', '  vC = instanceColor;', '  #endif',
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
    return new THREE.ShaderMaterial({ uniforms: { uTime: timeUniform }, vertexShader: GHOST_VS, fragmentShader: GHOST_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  }

  /** Mueve la etiqueta i-ésima de un conjunto sin reconstruir el atlas. */
  LabelSet.prototype.move = function (i, x, y, z) {
    var p = this.mesh.geometry.attributes.position; if (!p) return;
    var a = p.array, k;
    for (k = 0; k < 4; k++) { a[(i * 4 + k) * 3] = x; a[(i * 4 + k) * 3 + 1] = y; a[(i * 4 + k) * 3 + 2] = z; }
    p.needsUpdate = true;
    this.items[i].x = x; this.items[i].y = y; this.items[i].z = z;
  };

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
    media: { pr: 1.0, vr: 1.2, shadows: false, shadowMap: 1024, traffic: 120, clusters: 1, far: 1, palms: 900 },
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
    // Uniformes compartidos por edificios, terreno y mar (sol, cielo, noche, entorno).
    var shared = {
      uSun: { value: sunDir.clone() }, uSunColor: { value: new THREE.Color(0xfff1d6) },
      uSkyColor: { value: new THREE.Color(0xdcecff) }, uGroundColor: { value: new THREE.Color(0x9a7f60) }, uNight: { value: 0 }, uDusk: { value: 0 },
      uEnv: { value: envRT.texture }
    };
    var buildMat = makeBuildingMaterial(shared, true), plainMat = makeBuildingMaterial(shared, false);
    var terrainMat = makeTerrainMaterial(shared, noiseTex);

    // Estado global del visor
    var S = {
      ready: false, disposed: false, visible: true, docHidden: !!document.hidden, xr: false, lod: 0,
      field: null, geo: null, meta: null, fine: null, coarse: null, L: 60000, center: new THREE.Vector3(),
      sea: null, seabed: null, sky: null, stars: null, roads: null, towns: null, townsTop: null, lmLabels: null,
      city: null, cityHash: null, cellH: null, cellTop: null, cellSea: null, cellState: null, parcelAt: null, districts: null,
      gridCenter: new THREE.Vector3(), counts: null, inflatePath: null,
      sel: null, hover: null, frame: 0, fps: 0, fpsN: 0, fpsT: 0, lastT: 0, raf: 0,
      mode: 'orbit', hour: null, night: 0, landmarks: [], lmIndex: {}, clusterTotal: 0,
      avatars: {}, avatarOrder: [], traffic: null
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
      C.tiles.frustumCulled = false; C.tiles.renderOrder = 2;
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
      C.borders.frustumCulled = false; C.borders.renderOrder = 3;
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
    var ARCH_GEO = {};
    var ghostTime = { value: 0 }, ghostMat = makeGhostMaterial(ghostTime);
    function buildCityMeshes() {
      var k;
      for (k = 0; k < ARCH_KEYS.length; k++) {
        var acc = newAcc(); pushParts(acc, archetypeParts(ARCH_KEYS[k], CELL)); ARCH_GEO[ARCH_KEYS[k]] = accGeometry(acc);
        ensureCap('arch_' + ARCH_KEYS[k], ARCH_GEO[ARCH_KEYS[k]], buildMat, 64, true);
      }
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
      C.palms0 = inst(palmGeometry(0), plainMat, 64, 'palms0', true); C.palms1 = inst(palmGeometry(1), plainMat, 64, 'palms1', true);
      var gk;
      for (gk = 0; gk < ARCH_KEYS.length; gk++) C['ghost_' + ARCH_KEYS[gk]] = inst(ARCH_GEO[ARCH_KEYS[gk]], ghostMat, 8, 'ghost_' + ARCH_KEYS[gk]);
      C.ghostLabels = new LabelSet(viewportUniform, false); scene.add(C.ghostLabels.mesh);
      C.selLabel = new LabelSet(viewportUniform, false); scene.add(C.selLabel.mesh);
      C.saleLabels = new LabelSet(viewportUniform, true); scene.add(C.saleLabels.mesh);
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
      var perArch = {}, k;
      for (k = 0; k < ARCH_KEYS.length; k++) perArch[ARCH_KEYS[k]] = [];
      var saleItems = [];
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
        var v = 0.9 + 0.2 * hash2(x + 13, y + 29), sy = (pend ? 0.3 : 1) * (0.85 + 0.3 * hash2(x + 3, y + 7) + Math.min(pc.assets | 0, 6) * 0.03);
        var arch = SECTOR_ARCH[kind] || 'torre';
        perArch[arch].push({ x: w.x, y: S.cellH[ci] + 0.5, z: w.z, sy: sy, c: tmpColor.clone().copy(sectorColors[kind]).multiplyScalar(v) });
        if (pc.sale) {
          saleItems.push({ x: w.x, y: w.y + LIFT * 2 + clamp(CELL * 0.2, 20, 160), z: w.z, text: '💰 ' + (pc.sale / 1e8).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' RAMI', color: colors.sale, size: 12, bold: true, pin: true, maxDist: S.L * 0.6, priority: 4 });
          cnt.sale++;
        }
      }
      C.tiles.geometry.attributes.cellColor.needsUpdate = true;
      for (k = 0; k < ARCH_KEYS.length; k++) {
        var list = perArch[ARCH_KEYS[k]], m = ensureCap('arch_' + ARCH_KEYS[k], ARCH_GEO[ARCH_KEYS[k]], buildMat, list.length, true);
        for (i = 0; i < list.length; i++) place(m, i, list[i].x, list[i].y, list[i].z, 1, list[i].sy, 1, list[i].c);
        finish(m, list.length);
        cnt.arch[ARCH_KEYS[k]] = list.length;
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
      S.counts = cnt;
      refreshSelection();
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
        var entry = { id: l.id, name: l.name, x: w.x, y: hy, z: w.z, h: dims.h, w: dims.w, lat: l.lat, lon: l.lon, shape: l.shape };
        S.landmarks.push(entry); S.lmIndex[l.id] = entry;
        labels.push({ x: w.x, y: hy + dims.h + 12, z: w.z, text: l.name, color: colors.labelLandmark, size: 12, maxDist: S.L * 0.55, bold: false, pin: true, priority: 3 });
      }
      if (acc.pos.length) {
        C.landmarks = new THREE.Mesh(accGeometry(acc), buildMat);
        C.landmarks.castShadow = true; C.landmarks.receiveShadow = true; C.landmarks.frustumCulled = false;
        scene.add(C.landmarks);
      }
      S.lmLabels = new LabelSet(viewportUniform, true); S.lmLabels.set(labels); scene.add(S.lmLabels.mesh);
    }
    var CLUSTER_GEO = {};
    function buildClusters(meta) {
      var cl = meta.clusters || [], kinds = ['towers', 'blocks', 'villas', 'warehouses'], per = { towers: [], blocks: [], villas: [], warehouses: [] }, i, j;
      for (i = 0; i < cl.length; i++) {
        var c = cl[i], rnd = lcg(c.seed || (i + 1) * 7919), cw = S.geo.toWorld(c.lat, c.lon);
        var list = per[c.kind] || per.blocks, tries = 0;
        for (j = 0; j < c.count && tries < c.count * 4; tries++) {
          var ang = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * c.radius_m;
          var x = cw.x + Math.cos(ang) * rr, z = cw.z + Math.sin(ang) * rr;
          if (!insideMap(x, z)) continue;
          var hg = surfaceH(x, z);
          if (hg <= 0.3) continue; // en el agua no
          var h = c.hmin + (c.hmax - c.hmin) * Math.pow(rnd(), 1.6);
          var fw = c.kind === 'towers' ? 22 + rnd() * 20 : (c.kind === 'blocks' ? 26 + rnd() * 24 : (c.kind === 'villas' ? 12 + rnd() * 8 : 40 + rnd() * 60));
          var fd = c.kind === 'warehouses' ? 25 + rnd() * 30 : fw * (0.8 + rnd() * 0.5);
          list.push({ x: x, y: hg - 1, z: z, h: h + 1, w: fw, d: fd, yaw: rnd() * Math.PI, tone: rnd() });
          j++;
        }
      }
      var unit = new THREE.BoxGeometry(1, 1, 1); unit.translate(0, 0.5, 0);
      var villa = newAcc(); pushParts(villa, [{ sx: 1, sy: 1, sz: 1, c: [1, 1, 1] }, { sx: 1.1, sy: 0.08, sz: 1.1, y: 1, c: [0.9, 0.85, 0.78] }]); var villaGeo = accGeometry(villa);
      var TONES = { towers: [[0.62, 0.74, 0.86], [0.55, 0.62, 0.72], [0.82, 0.78, 0.7], [0.7, 0.8, 0.9]], blocks: [[0.88, 0.84, 0.76], [0.8, 0.8, 0.82], [0.9, 0.87, 0.8]], villas: [[0.95, 0.92, 0.85], [0.9, 0.84, 0.72]], warehouses: [[0.85, 0.85, 0.86], [0.75, 0.75, 0.78], [0.9, 0.9, 0.9]] };
      S.clusterTotal = 0;
      for (i = 0; i < kinds.length; i++) {
        var k = kinds[i], items = per[k];
        if (!items.length) continue;
        var m = new THREE.InstancedMesh(k === 'villas' ? villaGeo : unit, buildMat, items.length);
        m.frustumCulled = false; m.castShadow = k !== 'villas'; m.receiveShadow = true; m.name = 'cluster_' + k;
        for (j = 0; j < items.length; j++) {
          var it = items[j], tone = TONES[k][Math.floor(it.tone * TONES[k].length)];
          dummy.position.set(it.x, it.y, it.z); dummy.rotation.set(0, it.yaw, 0); dummy.scale.set(it.w, it.h, it.d); dummy.updateMatrix();
          m.setMatrixAt(j, dummy.matrix);
          var tl = lin3(tone);
          m.setColorAt(j, tmpColor.setRGB(tl[0], tl[1], tl[2]).multiplyScalar(0.9 + 0.2 * hash2(j, i)));
        }
        m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
        m.userData.total = items.length; m.count = Math.round(items.length * Q.clusters);
        scene.add(m); CLUSTER_GEO[k] = m; S.clusterTotal += items.length;
      }
    }
    function applyClusterFraction(f) { for (var k in CLUSTER_GEO) { var m = CLUSTER_GEO[k]; m.count = Math.round(m.userData.total * f); } }

    // --- Tráfico ambiente por las vías -------------------------------------------
    /**
     * Palmeras: en las celdas de costa (tierra con mar al lado) y, con menos
     * densidad, por la ciudad baja. Fijas: no dependen de la cadena.
     */
    function buildPalms() {
      var lists = [[], []], rnd = lcg(77), x, y, k, cap = Q.palms || 0;
      if (!cap) { finish(C.palms0, 0); finish(C.palms1, 0); return; }
      for (y = 0; y < N && lists[0].length + lists[1].length < cap; y++) for (x = 0; x < N; x++) {
        var ci = y * N + x; if (S.cellSea[ci]) continue;
        var coast = (x > 0 && S.cellSea[ci - 1]) || (x < N - 1 && S.cellSea[ci + 1]) || (y > 0 && S.cellSea[ci - N]) || (y < N - 1 && S.cellSea[ci + N]);
        var n = coast ? 7 : (S.cellH[ci] < 25 && rnd() < 0.35 ? 2 : 0);
        for (k = 0; k < n; k++) {
          var l = { x: (x + 0.08 + rnd() * 0.84) * CELL, z: (y + 0.08 + rnd() * 0.84) * CELL };
          var w = localToWorld(l.x, l.z), h = surfaceH(w.x, w.z);
          if (h < 0.4 || h > 60) continue;
          lists[k % 2].push({ x: w.x, y: h + 0.1, z: w.z, s: 0.8 + rnd() * 0.5, yaw: rnd() * Math.PI * 2, g: 0.28 + rnd() * 0.16 });
        }
      }
      var i, j;
      for (j = 0; j < 2; j++) {
        var m = ensureCap('palms' + j, C['palms' + j].geometry, C['palms' + j].material, Math.max(lists[j].length, 1), true);
        for (i = 0; i < lists[j].length; i++) { var p = lists[j][i]; tmpColor.setRGB(0.12 + p.g * 0.3, p.g + 0.12, 0.08 + p.g * 0.25); place(m, i, p.x, p.y, p.z, p.s, p.s, p.s, tmpColor, p.yaw); }
        finish(m, lists[j].length);
      }
    }
    function buildTrafficPaths(meta) {
      var roads = meta.roads || [], paths = [], r, i;
      for (r = 0; r < roads.length; r++) {
        var line = roads[r]; if (!line || line.length < 2) continue;
        var pts = [], cum = [0], len = 0, prev = null;
        for (i = 0; i < line.length; i++) {
          var w = S.geo.toWorld(line[i][1], line[i][0]);
          if (!insideMap(w.x, w.z)) { prev = null; continue; }
          var p = new THREE.Vector3(w.x, groundH(w.x, w.z) + 0.6, w.z);
          if (prev) { len += prev.distanceTo(p); cum.push(len); }
          pts.push(p); prev = p;
        }
        if (pts.length >= 2 && len > 2000) paths.push({ pts: pts, cum: cum, len: len });
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
        cars.push({ path: paths[pi], t: rnd() * paths[pi].len, v: 22 + rnd() * 14, dir: rnd() < 0.5 ? 1 : -1, hue: rnd() });
      }
      var m = new THREE.InstancedMesh(C.cars.geometry, plainMat, cars.length); m.frustumCulled = false; m.receiveShadow = true; m.name = 'traffic';
      for (i = 0; i < cars.length; i++) m.setColorAt(i, tmpColor.setHSL(cars[i].hue, cars[i].hue < 0.3 ? 0.1 : 0.6, 0.55));
      m.instanceColor.needsUpdate = true;
      scene.add(m);
      S.traffic = { cars: cars, mesh: m };
    }
    var _tp = new THREE.Vector3(), _tq = new THREE.Vector3();
    function updateTraffic(dt) {
      var tr = S.traffic; if (!tr || !tr.mesh) return;
      var i, j;
      for (i = 0; i < tr.cars.length; i++) {
        var c = tr.cars[i], P = c.path;
        c.t += c.v * dt * c.dir;
        if (c.t > P.len) c.t -= P.len; else if (c.t < 0) c.t += P.len;
        for (j = 1; j < P.cum.length && P.cum[j] < c.t; j++) {}
        j = Math.min(j, P.pts.length - 1);
        var a = P.pts[j - 1], b = P.pts[j], segLen = P.cum[j] - P.cum[j - 1] || 1, u = (c.t - P.cum[j - 1]) / segLen;
        _tp.lerpVectors(a, b, u); _tq.subVectors(b, a).normalize();
        var yaw = Math.atan2(-_tq.z, _tq.x) + (c.dir < 0 ? Math.PI : 0);
        // carril: a la derecha del sentido de marcha (4,5 m)
        var side = c.dir * 4.5;
        _tp.x += -_tq.z * side; _tp.z += _tq.x * side;
        _tp.y = groundH(_tp.x, _tp.z) + 0.4;
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
      var per = {}, k, i, labels = [];
      for (k = 0; k < ARCH_KEYS.length; k++) per[ARCH_KEYS[k]] = [];
      for (i = 0; i < S.ghosts.length; i++) {
        var g = S.ghosts[i];
        if (!(g.x >= 0 && g.x < N && g.y >= 0 && g.y < N) || g.estado === 'solo_aqui') continue;
        var kind = clamp(g.kind | 0, 0, SECTOR_COLORS.length - 1), arch = SECTOR_ARCH[kind] || 'torre', w = cellWorld(g.x, g.y), ci = g.y * N + g.x;
        var sy = 0.85 + 0.3 * hash2(g.x + 3, g.y + 7);
        per[arch].push({ x: w.x, y: S.cellH[ci] + 0.5, z: w.z, sy: sy, c: g.estado === 'distinta' ? [1.0, 0.45, 0.9] : [0.25, 0.9, 1.0] });
        labels.push({ x: w.x, y: S.cellH[ci] + LIFT * 2 + clamp(CELL * 0.22, 20, 180), z: w.z, text: '⟂ ' + (g.name || '') + (g.tip ? ' · ' + g.tip : ''), color: g.estado === 'distinta' ? '#ffb3ec' : '#9df3ff', size: 11, bold: true, pin: true, maxDist: S.L * 0.7, priority: 3 });
      }
      for (k = 0; k < ARCH_KEYS.length; k++) {
        var lst = per[ARCH_KEYS[k]], m = ensureCap('ghost_' + ARCH_KEYS[k], ARCH_GEO[ARCH_KEYS[k]], ghostMat, Math.max(lst.length, 1));
        for (i = 0; i < lst.length; i++) { tmpColor.setRGB(lst[i].c[0], lst[i].c[1], lst[i].c[2]); place(m, i, lst[i].x, lst[i].y, lst[i].z, 1.02, lst[i].sy, 1.02, tmpColor); }
        finish(m, lst.length);
      }
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
      var same = (cell === null && S.hover === null) || (cell && S.hover && cell.x === S.hover.x && cell.y === S.hover.y);
      if (same) return;
      S.hover = cell;
      if (cell) {
        fillCell(C.hover, cell.x, cell.y, LIFT * 0.3); C.hover.visible = true;
        canvas.style.cursor = 'pointer';
      } else { C.hover.visible = false; canvas.style.cursor = S.mode === 'walk' ? 'crosshair' : 'grab'; }
      onHover(cell ? cell.x : null, cell ? cell.y : null);
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
    function pick(clientX, clientY) {
      if (!S.ready) return null;
      var r = canvas.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!rayTerrain(raycaster.ray.origin, raycaster.ray.direction, _hit)) return null;
      return worldToCell(_hit.x, _hit.z);
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
        if (isClick) { var c = pick(e.clientX, e.clientY); doSelect(c, true); }
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
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', 'q', 'e', 'shift', '+', '-', 'escape'].indexOf(k) < 0) return;
      if (k === 'escape') { doSelect(null, true); return; }
      if (k === '+') { if (S.mode === 'orbit') zoomBy(0.8); else walk.speed = Math.min(40, walk.speed * 1.5); }
      else if (k === '-') { if (S.mode === 'orbit') zoomBy(1.25); else walk.speed = Math.max(0.25, walk.speed / 1.5); }
      else keys[k] = true;
      cancelFlight(); e.preventDefault();
    };
    L.keyup = function (e) { if (typeof e.key === 'string') delete keys[e.key.toLowerCase()]; };
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
     * Aparta un punto de la huella de los hitos: a pie (y en VR) no se empieza
     * DENTRO de un edificio modelado, que taparía la pantalla entera.
     */
    function clearOfLandmarks(x, z) {
      var pass, i, moved;
      for (pass = 0; pass < 4; pass++) {
        moved = false;
        for (i = 0; i < S.landmarks.length; i++) {
          var l = S.landmarks[i], r = (l.w || 60) * 0.75 + 14;
          var dx = x - l.x, dz = z - l.z, d = Math.sqrt(dx * dx + dz * dz);
          if (d < r) {
            if (d < 1e-3) { dx = 1; dz = 0; d = 1; }
            x = l.x + dx / d * r; z = l.z + dz / d * r; moved = true;
          }
        }
        if (!moved) break;
      }
      return { x: x, z: z };
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
      hemiGround.setRGB(SAND_LIN[0], SAND_LIN[1], SAND_LIN[2]).multiply(new THREE.Color().copy(hemiSky).multiplyScalar(0.8).add(new THREE.Color().copy(sunC).multiplyScalar(0.45 * Math.max(sunDir.y, 0))));
      shared.uSkyColor.value.copy(hemiSky); shared.uGroundColor.value.copy(hemiGround);
      hemi.color.copy(hemiSky); hemi.groundColor.copy(hemiGround); hemi.intensity = 1.0;
      sun.color.copy(sunC); sun.intensity = 1.0;
      sun.position.copy(lightDir).multiplyScalar(2500);
      renderer.toneMappingExposure = 0.72 - 0.05 * dusk - 0.14 * night;
      // La niebla se mezcla DESPUÉS del tono y la codificación: se le aplica la misma curva.
      var fe = acesSRGB(fog, renderer.toneMappingExposure);
      fogC.setRGB(fe[0], fe[1], fe[2], THREE.NoColorSpace || undefined);
      if (S.stars) S.stars.material.opacity = night * 0.9;
      if (S.sea) { S.sea.material.uniforms.uNight.value = night; S.sea.material.uniforms.uSun.value.copy(lightDir); S.sea.material.uniforms.uSunColor.value.copy(sunC); }
      scene.fog.color.copy(fogC); scene.background = fogC;
      // Reflejos: el cielo actual al mapa cúbico (solo el cielo; 6 caras de 128 px).
      envCam.update(renderer, skyScene);
    }
    function setTimeOfDay(h) { S.hour = (h === null || h === undefined || isNaN(h)) ? null : clamp(Number(h), 0, 24); updateSun(); }

    // --- Calidad -------------------------------------------------------------------------
    function setQuality(name) {
      if (!QUALITY[name]) return false;
      Q = QUALITY[name]; qualityName = name;
      renderer.setPixelRatio(Math.min(dpr, Q.pr));
      renderer.shadowMap.enabled = !!Q.shadows; sun.castShadow = !!Q.shadows;
      sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      applyClusterFraction(Q.clusters);
      if (S.ready) { buildTraffic(Q.traffic); buildPalms(); }
      scene.traverse(function (o) { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
      buildMat.needsUpdate = true; plainMat.needsUpdate = true; terrainMat.needsUpdate = true;
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
      if (meta.roads && meta.roads.length) { S.roads = buildRoads(meta.roads, geo); if (S.roads) scene.add(S.roads); }
      var gc = localToWorld(N / 2 * CELL, N / 2 * CELL);
      S.gridCenter.set(gc.x, 0, gc.z);
      S.cellState = new Uint8Array(N * N);
      buildTileLayer();
      buildCityMeshes();
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
      var cv = cityView();
      cam.cur.target.copy(cv.target); cam.goal.target.copy(cv.target);
      cam.cur.radius = cam.goal.radius = clamp(cv.radius, cam.minR, cam.maxR); cam.cur.phi = cam.goal.phi = cv.phi; cam.cur.theta = cam.goal.theta = cv.theta;
      updateSun();
      S.ready = true;
      if (pending) { applyCity(pending); pending = null; }
      else if (S.city) applyCity(S.city);
      if (S.ghosts && S.ghosts.length) setGhosts(S.ghosts);
      refreshSelection();
      rebuildAvatarLabels();
      resize();
      if (pendingFlight) { var pf = pendingFlight; pendingFlight = null; pf.fn.apply(null, pf.args); }
    }
    function buildRoads(roads, geo) {
      var pts = [], hcs = [], r, i;
      for (r = 0; r < roads.length; r++) {
        var line = roads[r];
        if (!line || line.length < 2) continue;
        var prev = null;
        for (i = 0; i < line.length; i++) {
          var w = geo.toWorld(line[i][1], line[i][0]);
          if (w.x < 0 || w.z < 0 || w.x > geo.worldW || w.z > geo.worldH) { prev = null; continue; }
          var p = [w.x, Math.max(surfaceH(w.x, w.z), 0) + 3, w.z, Math.max(coarseH(w.x, w.z), 0) + 3];
          if (prev) { pts.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]); hcs.push(prev[3], p[3]); }
          prev = p;
        }
      }
      if (!pts.length) return null;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      g.setAttribute('hc', new THREE.BufferAttribute(new Float32Array(hcs), 1));
      var m = new THREE.LineSegments(g, makeDrapeMaterial(lodUniform, colors.road, 1, false));
      m.frustumCulled = false; m.renderOrder = 2;
      return m;
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
      var sp = 6 * walk.speed * (keys.shift ? 5 : 1) * dt, mx = 0, mz = 0;
      if (keys.w || keys.arrowup) mz -= 1; if (keys.s || keys.arrowdown) mz += 1;
      if (keys.a || keys.arrowleft) mx -= 1; if (keys.d || keys.arrowright) mx += 1;
      if (keys.q) walk.fly = Math.max(0, walk.fly - sp); if (keys.e) walk.fly = Math.min(3000, walk.fly + sp);
      if (mx || mz) {
        var n = Math.sqrt(mx * mx + mz * mz); mx /= n; mz /= n;
        _fwd.set(-Math.sin(walk.yaw), 0, -Math.cos(walk.yaw)); _right.set(Math.cos(walk.yaw), 0, -Math.sin(walk.yaw));
        walk.pos.x += (_fwd.x * -mz + _right.x * mx) * sp; walk.pos.z += (_fwd.z * -mz + _right.z * mx) * sp;
        walk.pos.x = clamp(walk.pos.x, -S.L * 0.2, S.geo.worldW + S.L * 0.2); walk.pos.z = clamp(walk.pos.z, -S.L * 0.2, S.geo.worldH + S.L * 0.2);
      }
      walk.pos.y = groundH(walk.pos.x, walk.pos.z);
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
        cullLabels();
        if (pointerDirty) { pointerDirty = false; setHover(pointerPos && !drag ? pick(pointerPos.x, pointerPos.y) : null); }
      }
      renderer.render(scene, camera);
      S.frame++;
      syncLoop();
    }
    function resize() {
      if (S.disposed) return;
      var w = container.clientWidth || 640, h = container.clientHeight || 400;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      viewportUniform.value.set(w, h);
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
    }
    var xrLast = 0;
    function xrFrame(now) {
      var dt = Math.min(0.1, (now - xrLast) / 1000) || 0.016; xrLast = now;
      xrInput(dt);
      S.sea.material.uniforms.uTime.value = now / 1000;
      _cp.setFromMatrixPosition(camera.matrixWorld);
      S.sky.position.copy(_cp); S.stars.position.copy(_cp);
      updateTraffic(dt); updateAvatars(dt); updateShadowFrame();
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
          S.xr = true; xr.entering = false; syncLoop();
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

    // --- API pública ---------------------------------------------------------------------
    var handle = {
      ready: ready,
      setCity: function (data) {
        if (!data) return;
        var h = fnv1a(JSON.stringify(data));
        if (h === S.cityHash) return;
        S.cityHash = h;
        S.city = { parcels: data.parcels || [], assets: data.assets || [], me: data.me || null, size: data.size, sectors: data.sectors || null, districts: data.districts || null };
        if (data.districts && data.districts.length) S.districts = data.districts;
        if (S.ready) applyCity(S.city); else pending = S.city;
      },
      select: function (x, y) { doSelect((x === null || x === undefined) ? null : { x: x | 0, y: y | 0 }, false); },
      flyTo: flyTo, flyToIsland: flyToIsland, flyToCity: flyToCity, flyToLandmark: flyToLandmark,
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
        return { fps: Math.round(S.fps), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frame: S.frame, landmarks: S.landmarks.length, skyline: S.clusterTotal, avatars: S.avatarOrder.length, quality: qualityName, mode: S.xr ? 'vr' : S.mode, env: env };
      },
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
        S.disposed = true; syncLoop();
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
        if (C.avatarLabels) C.avatarLabels.dispose();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e2) {}
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
      _debug: { scene: scene, camera: camera, renderer: renderer, state: S, meshes: C, cam: cam, walk: walk, vrPlacement: function () { return vrPlacement(new THREE.Vector3()); }, keysDown: function () { return Object.keys(keys); } }
    };
    return handle;
  }

  global.RamiCity3D = { mount: mount, version: '2.0.0', sectorNames: SECTOR_NAMES, sectorColors: SECTOR_COLORS, shapes: Object.keys(SHAPES), _internals: { inflate: inflate, inflateStream: inflateStream, decodePngGray: decodePngGray, decodePngGrayAsync: decodePngGrayAsync, fnv1a: fnv1a, lcg: lcg } };
})(typeof window !== 'undefined' ? window : this);
