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
    out[o] = clamp(r * v, 0, 1) * 255; out[o + 1] = clamp(g * v, 0, 1) * 255; out[o + 2] = clamp(bl * v, 0, 1) * 255;
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
  function makeSeaMaterial(sunDir) {
    var uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uSun: { value: sunDir.clone() },
      uDeep: { value: new THREE.Color(0x0e4f78) },
      uShallow: { value: new THREE.Color(0x2fb3b8) },
      uSky: { value: new THREE.Color(0xd8ecf6) },
      uNight: { value: 0 }
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
        '#include <fog_pars_fragment>',
        '#include <logdepthbuf_pars_fragment>',
        'uniform float uTime, uNight; uniform vec3 uSun, uDeep, uShallow, uSky;',
        'varying vec3 vWorld;',
        'void main(){',
        '  #include <logdepthbuf_fragment>',
        '  float t = uTime;',
        '  vec2 p = vWorld.xz;',
        '  float att = 1.0 / (1.0 + length(cameraPosition - vWorld) / 12000.0);',
        '  float w1 = sin(p.x * 0.020 + t * 1.10) + sin(p.y * 0.017 - t * 0.90);',
        '  float w2 = sin((p.x + p.y) * 0.061 + t * 1.70) + sin((p.x - p.y) * 0.053 - t * 1.30);',
        '  vec3 n = normalize(vec3((w1 * 0.06 + w2 * 0.03) * att, 1.0, (w1 * 0.05 - w2 * 0.035) * att));',
        '  vec3 v = normalize(cameraPosition - vWorld);',
        '  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);',
        '  float spec = pow(max(dot(reflect(-uSun, n), v), 0.0), 60.0);',
        '  float diff = 0.7 + 0.3 * max(dot(n, uSun), 0.0);',
        '  vec3 col = mix(uDeep, uShallow, 0.35 + 0.15 * w2 * att) * diff;',
        '  col = mix(col, uSky, fres * 0.55) + vec3(1.0, 0.95, 0.8) * spec * 0.5;',
        '  col = mix(col, col * 0.18 + vec3(0.02, 0.03, 0.06), uNight);',
        '  gl_FragColor = vec4(col, 0.82);',
        '  #include <fog_fragment>',
        '}'].join('\n')
    });
    return mat;
  }

  /**
   * Cúpula de cielo con degradado (sin niebla). El color del horizonte es el de
   * la niebla, así el mar lejano se funde con el cielo sin costura. Se dibuja SIEMPRE de fondo:
   * sin test ni escritura de profundidad, renderOrder muy bajo y recentrada en
   * la cámara cada fotograma, así nunca queda recortada por near/far.
   */
  function makeSky(radius, horizonColor) {
    var mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x2f6fc4) }, uHorizon: { value: new THREE.Color(horizonColor) },
        uNight: { value: 0 }, uSun: { value: new THREE.Vector3(0, 1, 0) }
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform vec3 uTop, uHorizon, uSun; uniform float uNight; varying vec3 vDir;',
        'void main(){',
        '  float t = pow(clamp(vDir.y, 0.0, 1.0), 0.55);',
        '  vec3 day = mix(uHorizon, uTop, t);',
        '  vec3 night = mix(vec3(0.05, 0.06, 0.10), vec3(0.01, 0.015, 0.04), t);',
        '  vec3 col = mix(day, night, uNight);',
        '  float s = max(dot(vDir, uSun), 0.0);',
        '  col += vec3(1.0, 0.85, 0.6) * pow(s, 180.0) * (1.0 - uNight) * 1.5;', // disco solar
        '  col += vec3(1.0, 0.55, 0.3) * pow(s, 6.0) * 0.25 * (1.0 - uNight) * (1.0 - t);', // arrebol
        '  gl_FragColor = vec4(col, 1.0);',
        '}'].join('\n')
    });
    var m = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
    m.frustumCulled = false; m.renderOrder = -1000;
    return m;
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
    'attribute float hc; uniform float uLod;',
    '#ifdef CELL_COLOR', 'attribute vec4 cellColor; varying vec4 vColor;', '#endif',
    'void main(){',
    '  vec3 p = position; p.y = mix(position.y, hc, uLod);',
    '  #ifdef CELL_COLOR', '  vColor = cellColor;', '  #endif',
    '  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '  #include <fog_vertex>',
    '}'].join('\n');
  var DRAPE_FS = [
    '#include <fog_pars_fragment>',
    '#include <logdepthbuf_pars_fragment>',
    'uniform vec4 uColor;',
    '#ifdef CELL_COLOR', 'varying vec4 vColor;', '#endif',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec4 c = uColor;',
    '  #ifdef CELL_COLOR', '  c *= vColor;', '  #endif',
    '  if (c.a < 0.004) discard;',
    '  gl_FragColor = c;',
    '  #include <fog_fragment>',
    '}'].join('\n');
  function makeDrapeMaterial(lodUniform, color, alpha, cellColor) {
    var u = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    u.uLod = lodUniform;
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
    var pa = g.attributes.position.array, na = g.attributes.normal.array, c = p.c || [0.82, 0.82, 0.84], i;
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

  // ---- Material de edificios: luz hemisférica + sol, ventanas que se encienden de noche ----
  // Sirve para geometrías con color por vértice y para InstancedMesh con color
  // por instancia (THREE define USE_INSTANCING / USE_INSTANCING_COLOR solo).
  var BUILD_VS = [
    '#include <common>',
    '#include <color_pars_vertex>',
    '#include <fog_pars_vertex>',
    '#include <logdepthbuf_pars_vertex>',
    'varying vec3 vNormalW; varying vec3 vWorld; varying float vLocalY;',
    'void main(){',
    '  #include <color_vertex>',
    '  vec3 on = normal;',
    '  #ifdef USE_INSTANCING', '  on = mat3(instanceMatrix) * on;', '  #endif',
    '  vNormalW = normalize(mat3(modelMatrix) * on);',
    '  vec4 wp = vec4(position, 1.0);',
    '  #ifdef USE_INSTANCING', '  wp = instanceMatrix * wp;', '  #endif',
    '  wp = modelMatrix * wp; vWorld = wp.xyz; vLocalY = position.y;',
    '  vec4 mvPosition = viewMatrix * wp;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '  #include <fog_vertex>',
    '}'].join('\n');
  var BUILD_FS = [
    '#include <common>',
    '#include <color_pars_fragment>',
    '#include <fog_pars_fragment>',
    '#include <logdepthbuf_pars_fragment>',
    'uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor; uniform float uNight, uWindows;',
    'varying vec3 vNormalW; varying vec3 vWorld; varying float vLocalY;',
    'float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'void main(){',
    '  #include <logdepthbuf_fragment>',
    '  vec3 base = vec3(0.8);',
    '  #if defined(USE_COLOR) || defined(USE_INSTANCING_COLOR)', '  base = vColor.rgb;', '  #endif',
    '  vec3 n = normalize(vNormalW);',
    '  float ndl = max(dot(n, uSun), 0.0);',
    '  vec3 amb = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y);',
    '  vec3 col = base * (amb * 0.6 + uSunColor * ndl * 0.85);',
    '  float facade = clamp(1.0 - abs(n.y) * 1.2, 0.0, 1.0);',
    '  vec2 uvw = vec2(dot(vWorld.xz, vec2(n.z, -n.x)), vWorld.y);',
    '  vec2 cell = floor(uvw / vec2(4.5, 3.6));',
    '  vec2 f = fract(uvw / vec2(4.5, 3.6));',
    '  float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.86);',
    '  float glass = win * facade * step(5.0, vLocalY) * uWindows;',
    '  float lit = step(0.52, hash21(cell + floor(vWorld.xz * 0.002)));',
    '  col = mix(col, col * 0.7 + vec3(0.02, 0.05, 0.09), glass * 0.55);',
    '  col = mix(col, col * 0.30 + vec3(0.01, 0.012, 0.02), uNight);',
    '  col += vec3(1.0, 0.86, 0.58) * glass * lit * uNight * 1.15;',
    '  gl_FragColor = vec4(col, 1.0);',
    '  #include <fog_fragment>',
    '}'].join('\n');
  function makeBuildingMaterial(shared, windows) {
    var u = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    u.uSun = shared.uSun; u.uSunColor = shared.uSunColor; u.uSkyColor = shared.uSkyColor; u.uGroundColor = shared.uGroundColor; u.uNight = shared.uNight;
    u.uWindows = { value: windows ? 1 : 0 };
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: BUILD_VS, fragmentShader: BUILD_FS, vertexColors: true, fog: true });
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
    var out = newAcc();
    pushParts(out, [{ sx: 4.4, sy: 0.9, sz: 1.9, y: 0.35, c: [1, 1, 1] }, { sx: 2.3, sy: 0.75, sz: 1.7, x: -0.2, y: 1.25, c: [0.75, 0.8, 0.9] },
      { g: 'cyl', a: 10, sx: 0.65, sy: 0.3, sz: 0.65, x: 1.4, y: 0.32, z: 0.95, rx: Math.PI / 2, c: [0.1, 0.1, 0.1] }, { g: 'cyl', a: 10, sx: 0.65, sy: 0.3, sz: 0.65, x: -1.4, y: 0.32, z: 0.95, rx: Math.PI / 2, c: [0.1, 0.1, 0.1] },
      { g: 'cyl', a: 10, sx: 0.65, sy: 0.3, sz: 0.65, x: 1.4, y: 0.32, z: -0.95, rx: Math.PI / 2, c: [0.1, 0.1, 0.1] }, { g: 'cyl', a: 10, sx: 0.65, sy: 0.3, sz: 0.65, x: -1.4, y: 0.32, z: -0.95, rx: Math.PI / 2, c: [0.1, 0.1, 0.1] }]);
    return accGeometry(out);
  }
  /** Avatar (metros reales): cuerpo, cabeza y visera; color por instancia. */
  function avatarGeometry() {
    var out = newAcc();
    pushParts(out, [{ g: 'cyl', a: 12, sx: 0.42, sy: 1.15, sz: 0.3, y: 0.05, c: [1, 1, 1] }, { g: 'sphere', sx: 0.3, sy: 0.32, sz: 0.3, y: 1.42, c: [0.95, 0.85, 0.75] },
      { g: 'slab', sx: 0.34, sy: 0.12, sz: 0.1, y: 1.44, z: -0.14, c: [0.15, 0.15, 0.2] }, { g: 'cyl', a: 8, sx: 0.12, sy: 0.7, sz: 0.12, x: -0.3, y: 0.5, c: [1, 1, 1] }, { g: 'cyl', a: 8, sx: 0.12, sy: 0.7, sz: 0.12, x: 0.3, y: 0.5, c: [1, 1, 1] }]);
    return accGeometry(out);
  }
  var AVATAR_COLORS = ['#7ef0c0', '#6ea8fe', '#ffd166', '#ff6b6b', '#c77dff', '#4ccf6e', '#f2b84b', '#3ad1e0'];

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
    baja: { pr: 0.75, vr: 1.0, shadows: false, shadowMap: 1024, traffic: 0, clusters: 0.4, far: 0.6 },
    media: { pr: 1.0, vr: 1.2, shadows: false, shadowMap: 1024, traffic: 120, clusters: 1, far: 1 },
    alta: { pr: 2, vr: 1.5, shadows: true, shadowMap: 2048, traffic: 240, clusters: 1, far: 1 },
    ultra: { pr: 3, vr: 2.0, shadows: true, shadowMap: 4096, traffic: 400, clusters: 1, far: 1 }
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
      LIFT = clamp(CELL * 0.01, 1.5, 40); ASSET = clamp(CELL * 0.04, 1.2, 250);
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
    sun.shadow.camera.near = 50; sun.shadow.camera.far = 6000; sun.shadow.bias = -0.0005;
    sun.shadow.camera.left = -1400; sun.shadow.camera.right = 1400; sun.shadow.camera.top = 1400; sun.shadow.camera.bottom = -1400;
    var viewportUniform = { value: new THREE.Vector2(1, 1) };
    var lodUniform = { value: 0 };
    // Uniformes compartidos por el material de edificios (sol, cielo, noche).
    var shared = {
      uSun: { value: sunDir.clone() }, uSunColor: { value: new THREE.Color(0xfff1d6) },
      uSkyColor: { value: new THREE.Color(0xdcecff) }, uGroundColor: { value: new THREE.Color(0x9a7f60) }, uNight: { value: 0 }
    };
    var buildMat = makeBuildingMaterial(shared, true), plainMat = makeBuildingMaterial(shared, false);
    var terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });

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
    function groundH(wx, wz) { return Math.max(S.field ? S.field.atWorld(wx, wz) : 0, 0); }

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
      C.borders = new THREE.LineSegments(bg, makeDrapeMaterial(lodUniform, colors.border, 0.32, false));
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
      C.avatars = inst(avatarGeometry(), plainMat, 64, 'avatars', true);
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
    var FREE_RGBA = [freeC.r * 255, freeC.g * 255, freeC.b * 255, 34], SEA_RGBA = [seaC.r * 255, seaC.g * 255, seaC.b * 255, 8];
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
        paintCell(col, ci, own ? ownRGB[kind] : sectorRGB[kind], pend ? 90 : (own ? 215 : 165));
        state[ci] = own ? 3 : 2; cnt.plot++; if (own) cnt.own++;
        var w = cellWorld(x, y);
        var v = 0.9 + 0.2 * hash2(x + 13, y + 29), sy = (pend ? 0.3 : 1) * (0.85 + 0.3 * hash2(x + 3, y + 7) + Math.min(pc.assets | 0, 6) * 0.03);
        var arch = SECTOR_ARCH[kind] || 'torre';
        perArch[arch].push({ x: w.x, y: S.cellH[ci] + LIFT * 0.6, z: w.z, sy: sy, c: tmpColor.clone().copy(sectorColors[kind]).multiplyScalar(v) });
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
        C.landmarks.castShadow = true; C.landmarks.frustumCulled = false;
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
        m.frustumCulled = false; m.castShadow = k !== 'villas'; m.name = 'cluster_' + k;
        for (j = 0; j < items.length; j++) {
          var it = items[j], tone = TONES[k][Math.floor(it.tone * TONES[k].length)];
          dummy.position.set(it.x, it.y, it.z); dummy.rotation.set(0, it.yaw, 0); dummy.scale.set(it.w, it.h, it.d); dummy.updateMatrix();
          m.setMatrixAt(j, dummy.matrix);
          m.setColorAt(j, tmpColor.setRGB(tone[0], tone[1], tone[2]).multiplyScalar(0.9 + 0.2 * hash2(j, i)));
        }
        m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true;
        m.userData.total = items.length; m.count = Math.round(items.length * Q.clusters);
        scene.add(m); CLUSTER_GEO[k] = m; S.clusterTotal += items.length;
      }
    }
    function applyClusterFraction(f) { for (var k in CLUSTER_GEO) { var m = CLUSTER_GEO[k]; m.count = Math.round(m.userData.total * f); } }

    // --- Tráfico ambiente por las vías -------------------------------------------
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
      var m = new THREE.InstancedMesh(C.cars.geometry, plainMat, cars.length); m.frustumCulled = false; m.name = 'traffic';
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
        if (!e) {
          e = S.avatars[a.pk] = { name: a.name || '', color: new THREE.Color(AVATAR_COLORS[(a.avatar | 0) % AVATAR_COLORS.length]), cur: new THREE.Vector3(w.x, ty, w.z), tgt: new THREE.Vector3(w.x, ty, w.z), yaw: (a.yaw || 0) * Math.PI / 180, yawT: (a.yaw || 0) * Math.PI / 180 };
          S.avatarOrder.push(a.pk); changed = true;
        } else {
          if (e.name !== (a.name || '')) { e.name = a.name || ''; changed = true; }
          e.tgt.set(w.x, ty, w.z); e.yawT = (a.yaw || 0) * Math.PI / 180;
          e.color.set(AVATAR_COLORS[(a.avatar | 0) % AVATAR_COLORS.length]);
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
        items.push({ x: e.cur.x, y: e.cur.y + 2.3, z: e.cur.z, text: '🧑 ' + (e.name || t('visitante')), color: '#' + e.color.getHexString(), size: 12, bold: true, pin: false, maxDist: 4000, priority: 1 });
      }
      C.avatarLabels.set(items);
    }
    function updateAvatars(dt) {
      var n = S.avatarOrder.length, i, k = 1 - Math.exp(-dt * 4);
      var m = ensureCap('avatars', C.avatars.geometry, C.avatars.material, Math.max(n, 1), true);
      for (i = 0; i < n; i++) {
        var e = S.avatars[S.avatarOrder[i]];
        e.cur.lerp(e.tgt, k);
        var dy = e.yawT - e.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); e.yaw += dy * k;
        // guiñada de la cuadrícula: 0 = norte local (−z local)
        place(m, i, e.cur.x, e.cur.y, e.cur.z, 1, 1, 1, e.color, rotR - e.yaw);
        if (C.avatarLabels.items.length > i) C.avatarLabels.move(i, e.cur.x, e.cur.y + 2.3, e.cur.z);
      }
      finish(m, n);
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
    function setMode(m) {
      if (m !== 'walk' && m !== 'orbit') return;
      if (S.mode === m) return;
      if (m === 'walk') {
        var start = S.sel ? cellWorld(S.sel.x, S.sel.y) : cam.cur.target.clone();
        var off = S.sel ? rotOff(0, CELL * 0.42) : { x: 0, z: 0 };
        walk.pos.set(start.x + off.x, 0, start.z + off.z); walk.yaw = cam.cur.theta + Math.PI; walk.pitch = -0.05; walk.fly = 0;
        S.mode = 'walk'; canvas.style.cursor = 'crosshair';
      } else {
        // Volver a la órbita sobre donde estábamos a pie.
        cam.cur.target.copy(walk.pos); cam.goal.target.copy(walk.pos); cam.cur.theta = cam.goal.theta = walk.yaw - Math.PI;
        cam.cur.phi = cam.goal.phi = 0.95; cam.cur.radius = cam.goal.radius = CELL * 2.5;
        rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0); camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
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

    // --- Día y noche --------------------------------------------------------------------
    var skyTop = new THREE.Color(), fogC = new THREE.Color(), sunC = new THREE.Color(), hemiSky = new THREE.Color(), hemiGround = new THREE.Color();
    var C_DAY_TOP = new THREE.Color(0x2f6fc4), C_DUSK_TOP = new THREE.Color(0x5a4a86), C_DAY_HZ = new THREE.Color(colors.fog), C_DUSK_HZ = new THREE.Color(0xe0a070), C_NIGHT_HZ = new THREE.Color(0x10131c);
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
      var night = clamp((0.06 - sunDir.y) / 0.24, 0, 1), dusk = clamp(1 - Math.abs(sunDir.y) / 0.25, 0, 1) * (1 - night);
      S.night = night;
      shared.uSun.value.copy(sunDir.y > 0.02 ? sunDir : new THREE.Vector3(sunDir.x, 0.02, sunDir.z).normalize());
      shared.uNight.value = night;
      sunC.set(0xfff1d6).lerp(new THREE.Color(0xff9a52), dusk).multiplyScalar(1 - night * 0.9);
      shared.uSunColor.value.copy(sunC);
      hemiSky.set(0xdcecff).lerp(new THREE.Color(0x24304a), night); hemiGround.set(0x9a7f60).lerp(new THREE.Color(0x101418), night);
      shared.uSkyColor.value.copy(hemiSky); shared.uGroundColor.value.copy(hemiGround);
      hemi.color.copy(hemiSky); hemi.groundColor.copy(hemiGround); hemi.intensity = 0.65 - 0.45 * night;
      sun.color.copy(sunC); sun.intensity = 1.2 * Math.max(sunDir.y, 0) * (1 - night) + 0.05;
      skyTop.copy(C_DAY_TOP).lerp(C_DUSK_TOP, dusk); fogC.copy(C_DAY_HZ).lerp(C_DUSK_HZ, dusk * 0.7).lerp(C_NIGHT_HZ, night);
      if (S.sky) { S.sky.material.uniforms.uTop.value.copy(skyTop); S.sky.material.uniforms.uHorizon.value.copy(fogC); S.sky.material.uniforms.uNight.value = night; S.sky.material.uniforms.uSun.value.copy(sunDir); }
      if (S.stars) S.stars.material.opacity = night * 0.9;
      if (S.sea) { S.sea.material.uniforms.uNight.value = night; S.sea.material.uniforms.uSun.value.copy(shared.uSun.value); }
      scene.fog.color.copy(fogC); scene.background = fogC;
      var mats = [terrainMat]; for (var i = 0; i < mats.length; i++) { mats[i].color.setScalar(1 - night * 0.72); }
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
      if (S.ready) buildTraffic(Q.traffic);
      scene.traverse(function (o) { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
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
      S.sea.position.copy(S.center); S.sea.frustumCulled = false; S.sea.renderOrder = 1;
      scene.add(S.sea);
      var bedGeo = new THREE.PlaneGeometry(S.L * 8, S.L * 8, 1, 1); bedGeo.rotateX(-Math.PI / 2);
      var bedCol = new Uint8Array(3); terrainColor(bedH, 0, 0, bedCol, 0);
      S.seabed = new THREE.Mesh(bedGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(bedCol[0] / 255, bedCol[1] / 255, bedCol[2] / 255) }));
      S.seabed.position.set(S.center.x, bedH + 5, S.center.z); S.seabed.frustumCulled = false;
      scene.add(S.seabed);
      S.sky = makeSky(1000, colors.fog); scene.add(S.sky);
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
      if (S.lmLabels) S.lmLabels.cull(camera, _cp, W, H, labelRects);
      S.towns.cull(camera, _cp, W, H, labelRects);
      C.saleLabels.cull(camera, _cp, W, H, labelRects);
    }
    var lastSun = 0;
    function updateShadowFrame() {
      if (!Q.shadows) return;
      var tg = cam.cur.target;
      sun.position.set(tg.x + sunDir.x * 2500, Math.max(tg.y, 0) + sunDir.y * 2500 + 50, tg.z + sunDir.z * 2500);
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
        S.sea.material.uniforms.uTime.value = now / 1000;
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
      var x = w.x + off.x, z = w.z + off.z;
      out.set(x, Math.max(surfaceH(x, z), 0) + LIFT, z);
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
      setPresence: setPresence, myPose: myPose,
      resize: resize,
      setVisible: function (v) { S.visible = !!v; syncLoop(); },
      xrSupported: xrSupported, enterVR: enterVR,
      stats: function () { return { fps: Math.round(S.fps), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frame: S.frame, landmarks: S.landmarks.length, skyline: S.clusterTotal, avatars: S.avatarOrder.length, quality: qualityName, mode: S.xr ? 'vr' : S.mode }; },
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
