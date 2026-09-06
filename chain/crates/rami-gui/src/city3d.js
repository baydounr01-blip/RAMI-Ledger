/*
 * city3d.js — Cliente 3D de "Ciudad RAMI" (metaverso de pruebas, sin valor monetario)
 * para el monedero de escritorio RAMI-Chain.
 *
 * Script ES5 sin módulos ni paso de compilación. Requiere el global THREE
 * (three.min.js r150) cargado ANTES de este fichero. No usa ninguna otra
 * dependencia y sólo accede a la red para leer las dos URL geográficas que
 * recibe en `opts` (heightUrl y metaUrl).
 *
 * API pública: window.RamiCity3D.mount(container, opts) -> handle
 *   handle.setCity(city) / select(x,y|null) / flyTo(x,y) / flyToIsland() /
 *   flyToCity() / resize() / setVisible(bool) / dispose() / xrSupported() /
 *   enterVR() / stats() / latLonToCell(lat,lon) / cellLatLon(x,y) /
 *   cellWorld(x,y) / project(x,y) / heightAt(lat,lon) / ready (Promise)
 *
 * Arquitectura (de abajo arriba):
 *   1. Utilidades: hash FNV-1a, inflate (zlib) propio (respaldo de
 *      DecompressionStream), decodificador PNG de 16 bits, proyección
 *      Web-Mercator (contrato de datos geo), rampa de color.
 *   2. Terreno: malla fina (<= 512x512 vértices) + malla gruesa (LOD lejano),
 *      colores por vértice según altura y pendiente, mar animado (shader),
 *      cúpula de cielo centrada en la cámara, niebla, carreteras y etiquetas
 *      de pueblos en atlas de texto (dos llamadas de dibujo, tamaño en píxeles
 *      fijo, rechazo de solapes en pantalla).
 *   3. Ciudad: cuadrícula NxN "drapeada" sobre el terreno (una sola geometría
 *      con colores por celda; setCity sólo toca el atributo de color), bordes
 *      de celda, hover/selección drapeados, edificios-hito e inventario con
 *      InstancedMesh. Selección por raycast contra el TERRENO (no contra la
 *      capa) e inversa de la transformación de la cuadrícula.
 *   4. Cámara orbital propia (sin OrbitControls), vuelos suaves, VR opcional.
 *
 * Convenciones: unidades del mundo en metros; X crece hacia el este,
 * Z hacia el sur, Y es la altura. El nivel del mar es Y = 0.
 *
 * Anclaje de la cuadrícula: `anchor` es la esquina NOROESTE de la celda (0,0);
 * x crece hacia el este e y hacia el sur; `rotationDeg` gira la cuadrícula en
 * sentido horario (vista desde arriba) pivotando sobre el anclaje. La
 * correspondencia lat/lon <-> celda usa la MISMA aproximación equirectangular
 * que el panel 2D (dx = Δlon·111320·cos(lat0), dy = -Δlat·110574) para que
 * ambas vistas coincidan siempre; la proyección Mercator sólo interviene al
 * situar un punto lat/lon sobre el mapa de alturas.
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
    [-4000, 0.01, 0.05, 0.18],  // mar profundo
    [-600, 0.02, 0.12, 0.32],
    [-60, 0.08, 0.40, 0.52],    // mar somero
    [-1, 0.30, 0.62, 0.62],
    [0, 0.84, 0.77, 0.56],      // arena
    [10, 0.82, 0.74, 0.50],
    [60, 0.46, 0.60, 0.30],     // llanuras verdes
    [350, 0.42, 0.55, 0.27],
    [700, 0.56, 0.55, 0.32],    // matorral seco
    [900, 0.20, 0.38, 0.19],    // pinar
    [1900, 0.17, 0.33, 0.17],
    [2200, 0.35, 0.28, 0.24],   // roca volcánica
    [3100, 0.24, 0.20, 0.19],
    [3300, 0.55, 0.52, 0.52],
    [3450, 0.94, 0.94, 0.97],   // nieve / cumbre clara del Teide
    [5000, 0.98, 0.98, 1.0]
  ];
  var ROCK = [0.42, 0.36, 0.31];
  /** Color (0..1) para altura h, pendiente s (|grad|) y ruido n (-1..1). Escribe en out[o..o+2]. */
  function terrainColor(h, s, n, out, o) {
    var i = 0;
    while (i < RAMP.length - 2 && h > RAMP[i + 1][0]) i++;
    var a = RAMP[i], b = RAMP[i + 1], t = clamp((h - a[0]) / (b[0] - a[0]), 0, 1);
    var r = lerp(a[1], b[1], t), g = lerp(a[2], b[2], t), bl = lerp(a[3], b[3], t);
    if (h > 0 && h < 3300) { // laderas empinadas -> roca desnuda
      var k = smoothstep((s - 0.35) / 0.55) * 0.85;
      r = lerp(r, ROCK[0], k); g = lerp(g, ROCK[1], k); bl = lerp(bl, ROCK[2], k);
    }
    var v = 1 + n * 0.06;
    out[o] = clamp(r * v, 0, 1) * 255; out[o + 1] = clamp(g * v, 0, 1) * 255; out[o + 2] = clamp(bl * v, 0, 1) * 255;
  }

  // ---- Isla procedural de respaldo -------------------------------------------
  // Se usa sólo si el PNG (o el JSON) no se puede cargar, para que la escena
  // siga funcionando mientras se generan los datos reales.
  var DEFAULT_META = {
    name: 'Tenerife', attribution: 'procedural fallback', zoom: 12, downsample: 9.6689, width: 256, height: 219,
    origin_px: { x: lonToTilePx(-16.95), y: latToTilePx(28.62) },
    meters_per_pixel: 156543.03392 * Math.cos(28.3 * Math.PI / 180) / 4096 * 9.6689,
    offset: 1000, min_h: -3000, max_h: 3715,
    bbox: { west: -16.95, south: 27.98, east: -16.10, north: 28.62 },
    peak: { name: 'Teide', lat: 28.2724, lon: -16.6425, h: 3715 },
    towns: [
      { name: 'Santa Cruz de Tenerife', lat: 28.4636, lon: -16.2518, kind: 'city' },
      { name: 'San Cristóbal de La Laguna', lat: 28.4874, lon: -16.3159, kind: 'city' },
      { name: 'Puerto de la Cruz', lat: 28.4142, lon: -16.5448, kind: 'town' },
      { name: 'Los Cristianos', lat: 28.0510, lon: -16.7180, kind: 'beach' },
      { name: 'Granadilla de Abona', lat: 28.1180, lon: -16.5750, kind: 'town' },
      { name: 'Aeropuerto Tenerife Sur', lat: 28.0445, lon: -16.5725, kind: 'airport' },
      { name: 'Teide', lat: 28.2724, lon: -16.6425, kind: 'peak' }
    ],
    roads: []
  };
  function proceduralHeights(meta) {
    var w = meta.width, h = meta.height, geo = makeGeo(meta), data = new Uint16Array(w * h);
    var peak = geo.toPx(meta.peak.lat, meta.peak.lon), mpp = meta.meters_per_pixel;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var dx = (x - peak.x) * mpp, dy = (y - peak.y) * mpp;
      var ang = Math.atan2(dy, dx), r = Math.sqrt(dx * dx + dy * dy);
      // Silueta triangular (tres "brazos") + ruido de crestas
      var lobe = 1 + 0.45 * Math.cos(3 * ang + 0.6) + 0.15 * Math.cos(7 * ang + 2.0);
      var radius = 30000 * lobe;
      var t = 1 - r / radius;
      var alt = t > 0 ? 3715 * Math.pow(t, 1.5) : -2500 * Math.min(1, (r - radius) / 25000);
      alt += 120 * Math.sin(x * 0.35 + y * 0.21) * Math.sin(y * 0.27 - x * 0.13) * (alt > 50 ? 1 : 0.2);
      var v = Math.round(alt + meta.offset);
      data[y * w + x] = clamp(v, 0, 65535);
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
      uDeep: { value: new THREE.Color(0x0b3d63) },
      uShallow: { value: new THREE.Color(0x1f7f95) },
      uSky: { value: new THREE.Color(0xbfd9ee) }
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
        'uniform float uTime; uniform vec3 uSun, uDeep, uShallow, uSky;',
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
      uniforms: { uTop: { value: new THREE.Color(0x3f7cc9) }, uHorizon: { value: new THREE.Color(horizonColor) } },
      vertexShader: 'varying float vY; void main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uTop, uHorizon; varying float vY; void main(){ float t = pow(clamp(vY, 0.0, 1.0), 0.55); gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0); }'
    });
    var m = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
    m.frustumCulled = false; m.renderOrder = -1000;
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
  // 3. CIUDAD (capa drapeada + instancias) + 4. CÁMARA, BUCLE Y API PÚBLICA
  // ---------------------------------------------------------------------

  var KIND_KEYS = ['Empresa', 'Granja', 'Tienda', 'Oficina'];
  var DEFAULT_COLORS = {
    kinds: ['#4f8cff', '#4ccf6e', '#f2b84b', '#c77dff'],
    accent: '#7ef0c0', select: '#7ef0c0', hover: '#ffffff', tileFree: '#eaf3ff', tileSea: '#d2ebff', border: '#0c1a26', lease: '#4fd8ff',
    sky: '#a9cdea', fog: '#b9d3e6', plant: '#3fa34d', crate: '#a8783f', road: '#5a4a3c',
    labelCity: '#ffffff', labelTown: '#ffe9b0', labelPeak: '#ffffff', labelAirport: '#bfe6ff',
    labelBeach: '#ffd9a8', labelPort: '#c9f0ff', cityLabel: '#7ef0c0'
  };

  /** Une varias BoxGeometry (no indexadas) con un "tono" por pieza en el atributo color. */
  function buildingGeometry(parts) {
    var pos = [], nor = [], col = [], p, i;
    for (p = 0; p < parts.length; p++) {
      var q = parts[p];
      var g = new THREE.BoxGeometry(q.w, q.h, q.d).toNonIndexed();
      g.translate(q.x || 0, (q.y || 0) + q.h / 2, q.z || 0);
      var pa = g.attributes.position.array, na = g.attributes.normal.array;
      for (i = 0; i < pa.length; i++) { pos.push(pa[i]); nor.push(na[i]); }
      for (i = 0; i < pa.length / 3; i++) col.push(q.s[0], q.s[1], q.s[2]);
      g.dispose();
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.computeBoundingSphere();
    return out;
  }
  /**
   * Geometrías de edificio-hito por tipo (0 Empresa, 1 Granja, 2 Tienda, 3 Oficina),
   * escaladas con la celda: huella ~0.28·CELL, alturas 0.10/0.035/0.06/0.18·CELL
   * (acotadas a [8, 600] m) y una "cimentación" que baja bajo el suelo para no
   * flotar en laderas.
   */
  function makeBuildingGeometries(c) {
    var f = c * 0.28, fd = clamp(c * 0.12, 3, 400);
    var hE = clamp(c * 0.10, 8, 600), hG = clamp(c * 0.035, 8, 600), hT = clamp(c * 0.06, 8, 600), hO = clamp(c * 0.18, 8, 600);
    return [
      buildingGeometry([ // Empresa: bloque de altura media con cornisa y marquesina
        { w: f, h: hE + fd, d: f * 0.8, y: -fd, s: [0.95, 0.95, 1.0] },
        { w: f * 1.06, h: hE * 0.06, d: f * 0.86, y: hE, s: [0.45, 0.45, 0.5] },
        { w: f * 0.5, h: hE * 0.04, d: f * 0.2, y: hE * 0.2, z: f * 0.48, s: [0.6, 0.6, 0.65] }
      ]),
      buildingGeometry([ // Granja: nave baja tipo invernadero con techo verde y silo
        { w: f * 1.2, h: hG + fd, d: f, y: -fd, s: [1.0, 1.0, 0.94] },
        { w: f * 1.26, h: hG * 0.25, d: f * 1.06, y: hG, s: [0.55, 1.0, 0.55] },
        { w: f * 0.16, h: hG * 0.55, d: f * 0.16, x: f * 0.5, z: f * 0.4, y: hG * 1.2, s: [0.7, 0.7, 0.75] }
      ]),
      buildingGeometry([ // Tienda: caja con toldo y rótulo
        { w: f * 0.8, h: hT + fd, d: f * 0.7, y: -fd, s: [1.0, 1.0, 1.0] },
        { w: f * 0.9, h: hT * 0.06, d: f * 0.25, y: hT * 0.55, z: f * 0.45, s: [1.0, 0.72, 0.42] },
        { w: f * 0.5, h: hT * 0.2, d: f * 0.03, y: hT, z: f * 0.3, s: [1.0, 1.0, 0.6] }
      ]),
      buildingGeometry([ // Oficina: torre alta con coronamiento y antena
        { w: f * 0.7, h: hO + fd, d: f * 0.7, y: -fd, s: [0.92, 0.95, 1.0] },
        { w: f * 0.48, h: hO * 0.1, d: f * 0.48, y: hO, s: [0.7, 0.72, 0.82] },
        { w: f * 0.03, h: hO * 0.18, d: f * 0.03, y: hO * 1.1, s: [0.4, 0.4, 0.45] }
      ])
    ];
  }

  // ---------------------------------------------------------------------
  function mount(container, opts) {
    opts = opts || {};
    var t = typeof opts.t === 'function' ? opts.t : function (k) { return k; };
    var N = opts.gridSize || 32;
    var anchor = opts.anchor || { lat: 28.085, lon: -16.505, cellMeters: 60, rotationDeg: 0 };
    var CELL = anchor.cellMeters || 60;
    var SUB = CELL >= 500 ? 6 : 1;                 // subdivisión de cada celda en la capa drapeada
    var VPC = (SUB + 1) * (SUB + 1);               // vértices por celda
    var LIFT = clamp(CELL * 0.01, 1.5, 40);        // elevación de la capa sobre el terreno (m)
    var ASSET = clamp(CELL * 0.04, 1.2, 250);      // tamaño de los activos (m)
    // Aproximación equirectangular compartida con el panel 2D
    var MX = 111320 * Math.cos(anchor.lat * Math.PI / 180), MY = 110574;
    var rotR = -(anchor.rotationDeg || 0) * Math.PI / 180; // horario visto desde arriba
    var sinR = Math.sin(rotR), cosR = Math.cos(rotR);
    var colors = {}, key;
    for (key in DEFAULT_COLORS) colors[key] = DEFAULT_COLORS[key];
    if (opts.theme && opts.theme.colors) for (key in opts.theme.colors) colors[key] = opts.theme.colors[key];
    var onSelect = opts.onSelect || function () {}, onHover = opts.onHover || function () {};

    // --- Comprobación de WebGL ANTES de tocar el DOM ------------------------
    var canvas = document.createElement('canvas'), gl = null;
    var glAttrs = { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false };
    try {
      gl = canvas.getContext('webgl2', glAttrs) || canvas.getContext('webgl', glAttrs) || canvas.getContext('experimental-webgl', glAttrs);
    } catch (e) { gl = null; }
    if (!gl) throw new Error(t('WebGL no disponible en este navegador/webview; se usará la vista 2D.'));

    // --- Renderer, escena, cámara ----------------------------------------------
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: true, alpha: false, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 1.5));
    renderer.info.autoReset = true;
    canvas.style.display = 'block'; canvas.style.width = '100%'; canvas.style.height = '100%';
    canvas.style.touchAction = 'none'; canvas.style.outline = 'none'; canvas.style.cursor = 'grab';
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', t('Ciudad RAMI'));
    container.appendChild(canvas);

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(colors.sky);
    scene.fog = new THREE.Fog(new THREE.Color(colors.fog), 1000, 100000);
    var camera = new THREE.PerspectiveCamera(50, 1, 2, 900000);
    var rig = new THREE.Group(); rig.add(camera); scene.add(rig);
    var sunDir = new THREE.Vector3(-0.55, 0.75, 0.35).normalize();
    var hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b5a48, 0.62); scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xfff1d6, 1.15); sun.position.copy(sunDir).multiplyScalar(1000); scene.add(sun);
    var viewportUniform = { value: new THREE.Vector2(1, 1) };
    var lodUniform = { value: 0 }; // 0 = malla fina, 1 = malla gruesa (compartido por todo lo drapeado)
    var terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });

    // Estado global del visor
    var S = {
      ready: false, disposed: false, visible: true, docHidden: !!document.hidden, xr: false, lod: 0,
      field: null, geo: null, fine: null, coarse: null, L: 60000, center: new THREE.Vector3(),
      sea: null, seabed: null, sky: null, roads: null, towns: null, townsTop: null,
      city: null, cityHash: null, cellH: null, cellTop: null, cellSea: null, cellState: null, parcelAt: null,
      gridCenter: new THREE.Vector3(), lift: LIFT, sub: SUB, counts: null, inflatePath: null,
      sel: null, hover: null, frame: 0, fps: 0, fpsN: 0, fpsT: 0, lastT: 0, raf: 0
    };
    var gridGroup = new THREE.Group(); scene.add(gridGroup);
    var pending = null;        // ciudad recibida antes de que el terreno esté listo
    var pendingFlight = null;  // vuelo solicitado antes de que el terreno esté listo

    // --- Alturas de la superficie visible del terreno (metros del mundo) --------
    function surfaceH(wx, wz) { return S.fine ? meshSurfaceHeight(S.fine, wx, wz) : 0; }
    function coarseH(wx, wz) { return S.coarse ? meshSurfaceHeight(S.coarse, wx, wz) : 0; }
    function insideMap(wx, wz) { return S.geo && wx >= 0 && wz >= 0 && wx <= S.geo.worldW && wz <= S.geo.worldH; }

    // --- Cuadrícula: celda <-> local (m desde el anclaje) <-> lat/lon <-> mundo ---
    function cellLocal(x, y) { return { x: (x + 0.5) * CELL, z: (y + 0.5) * CELL }; }
    /** Local (este/sur de la cuadrícula girada) -> lat/lon (equirectangular, como el panel 2D). */
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
    /** Centro de la celda en el mundo; y = altura del terreno (>= 0) + elevación de la capa. */
    function cellWorld(x, y) {
      var l = cellLocal(x, y), w = localToWorld(l.x, l.z);
      return new THREE.Vector3(w.x, (S.cellH ? S.cellH[y * N + x] : 0) + LIFT, w.z);
    }
    /** Desplazamiento local (m) -> desplazamiento en el mundo (giro de la cuadrícula). */
    function rotOff(dlx, dlz) { return { x: dlx * cosR + dlz * sinR, z: -dlx * sinR + dlz * cosR }; }

    // --- Capa drapeada de la cuadrícula ------------------------------------------
    var C = {}; // mallas de la ciudad
    function drapedH(hf) { return Math.max(hf, 0) + LIFT; } // sobre el mar la capa flota en la superficie
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
      // Bordes de celda (LineSegments drapeados, un poco por encima de las baldosas)
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
      C.borders = new THREE.LineSegments(bg, makeDrapeMaterial(lodUniform, colors.border, 0.38, false));
      C.borders.frustumCulled = false; C.borders.renderOrder = 3;
      gridGroup.add(C.borders);
      // Hover / selección: una celda cada uno, reconstruidos (sin reservar memoria) al cambiar
      C.hover = cellMesh(colors.hover, 0.3, 4); C.hover.renderOrder = 4;
      C.selFill = cellMesh(colors.select, 0.22, 5); C.selFill.renderOrder = 5;
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
    /** Copia los vértices de la celda (x,y) de la capa a una malla de una celda, elevados `extra` m. */
    function fillCell(mesh, x, y, extra) {
      var tp = C.tiles.geometry.attributes.position.array, th = C.tiles.geometry.attributes.hc.array, base = (y * N + x) * VPC;
      var p = mesh.geometry.attributes.position, h = mesh.geometry.attributes.hc, pa = p.array, ha = h.array, k;
      for (k = 0; k < VPC; k++) {
        pa[k * 3] = tp[(base + k) * 3]; pa[k * 3 + 1] = tp[(base + k) * 3 + 1] + extra; pa[k * 3 + 2] = tp[(base + k) * 3 + 2];
        ha[k] = th[base + k] + extra;
      }
      p.needsUpdate = true; h.needsUpdate = true;
    }
    /** Contorno (LineLoop) de la celda (x,y) a partir de los vértices de la capa. */
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

    // --- Mallas instanciadas (edificios-hito e inventario) -------------------------
    var dummy = new THREE.Object3D(), tmpColor = new THREE.Color();
    function inst(geometry, material, capacity, name) {
      var m = new THREE.InstancedMesh(geometry, material, capacity);
      m.count = 0; m.frustumCulled = false; m.name = name;
      for (var i = 0; i < capacity; i++) m.setColorAt(i, tmpColor.set(0xffffff));
      m.instanceColor.needsUpdate = true;
      gridGroup.add(m);
      return m;
    }
    function buildCityMeshes() {
      var bg = makeBuildingGeometries(CELL);
      C.buildings = [];
      for (var k = 0; k < 4; k++) C.buildings.push(inst(bg[k], new THREE.MeshLambertMaterial({ vertexColors: true }), N * N, 'building' + k));
      C.assetCap = 0;
      buildAssetMeshes(256);
      C.selLabel = new LabelSet(viewportUniform, false); scene.add(C.selLabel.mesh);
    }
    function buildAssetMeshes(cap) {
      var old = [C.plants, C.crates, C.rings], i;
      for (i = 0; i < old.length; i++) if (old[i]) { gridGroup.remove(old[i]); old[i].geometry.dispose(); old[i].material.dispose(); old[i].dispose(); }
      var a = ASSET;
      var cone = new THREE.ConeGeometry(a * 0.45, a * 1.3, 7); cone.translate(0, a * 0.65, 0);
      var crate = new THREE.BoxGeometry(a * 0.7, a * 0.7, a * 0.7); crate.translate(0, a * 0.35, 0);
      var ring = new THREE.TorusGeometry(a * 0.8, a * 0.06, 6, 20); ring.rotateX(Math.PI / 2); ring.translate(0, a * 0.08, 0);
      C.plants = inst(cone, new THREE.MeshLambertMaterial({ color: 0xffffff }), cap, 'plants');
      C.crates = inst(crate, new THREE.MeshLambertMaterial({ color: 0xffffff }), cap, 'crates');
      C.rings = inst(ring, new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.lease), transparent: true, opacity: 0.85 }), cap, 'rings');
      C.assetCap = cap;
    }
    function place(mesh, idx, wx, wy, wz, sx, sy, sz, color) {
      dummy.position.set(wx, wy, wz); dummy.rotation.set(0, rotR, 0); dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix(); mesh.setMatrixAt(idx, dummy.matrix);
      if (color) mesh.setColorAt(idx, color);
    }
    function finish(mesh, count) {
      mesh.count = count; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    var kindColors = [], kindRGB = [], ownRGB = [];
    var accentC = new THREE.Color(colors.accent), freeC = new THREE.Color(colors.tileFree), seaC = new THREE.Color(colors.tileSea);
    for (var kc = 0; kc < 4; kc++) {
      kindColors.push(new THREE.Color(colors.kinds[kc]));
      kindRGB.push([kindColors[kc].r * 255, kindColors[kc].g * 255, kindColors[kc].b * 255]);
      tmpColor.copy(kindColors[kc]).lerp(accentC, 0.35).multiplyScalar(1.15);
      ownRGB.push([clamp(tmpColor.r, 0, 1) * 255, clamp(tmpColor.g, 0, 1) * 255, clamp(tmpColor.b, 0, 1) * 255]);
    }
    var plantColor = new THREE.Color(colors.plant), crateColor = new THREE.Color(colors.crate);
    var FREE_RGBA = [freeC.r * 255, freeC.g * 255, freeC.b * 255, 46], SEA_RGBA = [seaC.r * 255, seaC.g * 255, seaC.b * 255, 10];
    function paintCell(col, ci, rgb, a) {
      var o = ci * VPC * 4;
      for (var k = 0; k < VPC; k++) { col[o] = rgb[0]; col[o + 1] = rgb[1]; col[o + 2] = rgb[2]; col[o + 3] = a; o += 4; }
    }

    /** Vuelca los datos de la ciudad: colores de la capa (sin reconstruir geometría) + instancias. */
    function applyCity(d) {
      var parcels = d.parcels || [], assets = d.assets || [];
      var n = N, i, x, y, cnt = { free: 0, sea: 0, plot: 0, own: 0, b: [0, 0, 0, 0], plants: 0, crates: 0, rings: 0 };
      var parcelAt = new Int32Array(n * n); for (i = 0; i < n * n; i++) parcelAt[i] = -1;
      for (i = 0; i < parcels.length; i++) {
        var p = parcels[i];
        if (p.x >= 0 && p.x < n && p.y >= 0 && p.y < n) parcelAt[p.y * n + p.x] = i;
      }
      S.parcelAt = parcelAt;
      var me = d.me || null, col = C.tiles.geometry.attributes.cellColor.array, state = S.cellState;
      for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
        var ci = y * n + x, pi = parcelAt[ci];
        if (pi < 0) {
          if (S.cellSea[ci]) { paintCell(col, ci, SEA_RGBA, SEA_RGBA[3]); cnt.sea++; state[ci] = 1; }
          else { paintCell(col, ci, FREE_RGBA, FREE_RGBA[3]); cnt.free++; state[ci] = 0; }
          continue;
        }
        var pc = parcels[pi], kind = clamp(pc.kind | 0, 0, 3), own = !!(me && pc.owner === me);
        paintCell(col, ci, own ? ownRGB[kind] : kindRGB[kind], own ? 215 : 165);
        state[ci] = own ? 3 : 2; cnt.plot++; if (own) cnt.own++;
        var w = cellWorld(x, y);
        var v = 0.9 + 0.2 * hash2(x + 13, y + 29), sy = 0.85 + 0.3 * hash2(x + 3, y + 7) + Math.min(pc.assets | 0, 6) * 0.03;
        tmpColor.copy(kindColors[kind]).multiplyScalar(v);
        place(C.buildings[kind], cnt.b[kind]++, w.x, S.cellH[ci] + LIFT * 0.6, w.z, 1, sy, 1, tmpColor);
      }
      C.tiles.geometry.attributes.cellColor.needsUpdate = true;
      for (i = 0; i < 4; i++) finish(C.buildings[i], cnt.b[i]);
      // Activos: anillos de 12 huecos alrededor del edificio (radio ~0.36·CELL; el 2º anillo más afuera)
      if (assets.length > C.assetCap) { var cap = 256; while (cap < assets.length) cap *= 2; buildAssetMeshes(cap); }
      var slots = new Uint16Array(n * n);
      for (i = 0; i < assets.length; i++) {
        var a = assets[i];
        if (!(a.x >= 0 && a.x < n && a.y >= 0 && a.y < n)) continue;
        var cj = a.y * n + a.x, si = slots[cj]++, ringI = (si / 12) | 0, ang = (si % 12) / 12 * Math.PI * 2 + ringI * 0.26;
        var rad = CELL * (0.34 + 0.08 * (ringI % 2)), off = rotOff(Math.cos(ang) * rad, Math.sin(ang) * rad);
        var wcen = cellWorld(a.x, a.y), ax = wcen.x + off.x, az = wcen.z + off.z;
        var hh = drapedH(surfaceH(ax, az)) + LIFT * 0.1; // cada activo sigue el relieve local
        if ((a.kind | 0) === 1) {
          tmpColor.copy(crateColor).multiplyScalar(0.85 + 0.3 * hash2(i, 11));
          place(C.crates, cnt.crates++, ax, hh, az, 1, 1, 1, tmpColor);
        } else {
          var gsc = 0.8 + 0.5 * hash2(i, 5);
          tmpColor.copy(plantColor).offsetHSL(0.03 * (hash2(i, 17) - 0.5), 0, 0.1 * (hash2(i, 19) - 0.5));
          place(C.plants, cnt.plants++, ax, hh, az, gsc, gsc, gsc, tmpColor);
        }
        if (a.lease && a.lease.active) place(C.rings, cnt.rings++, ax, hh, az, 1, 1, 1, null);
      }
      finish(C.plants, cnt.plants); finish(C.crates, cnt.crates); finish(C.rings, cnt.rings);
      S.counts = cnt;
      refreshSelection();
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
      var p = parcelInfo(x, y), txt;
      if (p) {
        txt = t(KIND_KEYS[clamp(p.kind | 0, 0, 3)]) + ' (' + x + ', ' + y + ')';
        if (p.name) txt += ' · ' + p.name;
        if (S.city && S.city.me && p.owner === S.city.me) txt += ' · ' + t('Mía');
      } else txt = t(S.cellSea[y * N + x] ? 'Parcela libre (mar)' : 'Parcela libre') + ' (' + x + ', ' + y + ')';
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
      } else { C.hover.visible = false; canvas.style.cursor = 'grab'; }
      onHover(cell ? cell.x : null, cell ? cell.y : null);
    }
    // Selección por rayo contra el TERRENO visible (marcha sobre la triangulación
    // real del LOD activo + bisección). Fuera del mapa de alturas la superficie es
    // el mar (y = 0); sobre el mar dentro del mapa también se usa la superficie del
    // agua (la capa flota sobre ella). Las celdas ocultas tras una cresta no son
    // seleccionables a través del terreno.
    var raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), _hit = new THREE.Vector3();
    function pickSurf(wx, wz, tr) { return insideMap(wx, wz) ? Math.max(meshSurfaceHeight(tr, wx, wz), 0) : 0; }
    function rayTerrain(o, d, out) {
      var tr = S.lod ? S.coarse : S.fine, step = Math.min(tr.dx, tr.dz) * 0.6, maxH = Math.max(tr.maxH, 0);
      var tt = 0, tEnd, i;
      if (o.y > maxH) { if (d.y >= 0) return false; tt = (o.y - maxH) / -d.y; }
      tEnd = d.y < 0 ? o.y / -d.y + step : S.L * 12;
      if (o.y + d.y * tt < pickSurf(o.x + d.x * tt, o.z + d.z * tt, tr)) return false; // se parte bajo la superficie
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

    // --- Cámara orbital propia --------------------------------------------------
    var cam = {
      cur: { theta: 0.4, phi: 0.85, radius: 1000, target: new THREE.Vector3() },
      goal: { theta: 0.4, phi: 0.85, radius: 1000, target: new THREE.Vector3() },
      minR: 30, maxR: 300000, minPhi: 0.06, maxPhi: 1.45, flight: null
    };
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
    var L = {}; // listeners (para poder quitarlos en dispose)
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
        drag = null; canvas.style.cursor = S.hover ? 'pointer' : 'grab';
      } else if (drag && drag.mode === 'pinch' && nPointers === 1) {
        var l = pointerList(); drag = { mode: 'rotate', x0: l[0].x, y0: l[0].y, t0: 0, moved: 99, button: -1 };
      }
    };
    L.pointerleave = function () { pointerPos = null; pointerDirty = true; };
    L.dblclick = function (e) {
      var c = pick(e.clientX, e.clientY);
      if (c) { // los clics previos ya seleccionaron la parcela (doSelect no repite onSelect)
        doSelect(c, true);
        flyTo(c.x, c.y);
      }
      e.preventDefault();
    };
    L.wheel = function (e) {
      cancelFlight();
      var d = e.deltaMode === 1 ? e.deltaY * 33 : (e.deltaMode === 2 ? e.deltaY * 500 : e.deltaY);
      zoomBy(Math.exp(clamp(d, -300, 300) * 0.0014));
      e.preventDefault();
    };
    L.contextmenu = function (e) { e.preventDefault(); };
    L.keydown = function (e) {
      if (typeof e.key !== 'string') return;
      var k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', '+', '-', 'escape'].indexOf(k) < 0) return;
      if (k === 'escape') { doSelect(null, true); return; }
      if (k === '+') zoomBy(0.8); else if (k === '-') zoomBy(1.25); else keys[k] = true;
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
      // Repetir la selección de la misma parcela (2º clic de un doble clic) no vuelve a avisar
      if (fromUser && cell && S.sel && S.sel.x === cell.x && S.sel.y === cell.y) return;
      S.sel = cell ? { x: cell.x, y: cell.y } : null;
      refreshSelection();
      if (fromUser) onSelect(cell ? cell.x : null, cell ? cell.y : null);
    }
    /** Vuelo suave de la cámara hacia un estado objetivo. */
    function fly(to, dur) {
      var from = { theta: cam.cur.theta, phi: cam.cur.phi, radius: cam.cur.radius, target: cam.cur.target.clone() };
      var dth = to.theta - from.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth)); // camino más corto
      cam.flight = { t0: performance.now(), dur: dur, from: from, to: { theta: from.theta + dth, phi: to.phi, radius: clamp(to.radius, cam.minR, cam.maxR), target: to.target.clone() } };
    }
    function flyTo(x, y) {
      if (!S.ready) { pendingFlight = { fn: flyTo, args: [x, y] }; return; }
      x = clamp(x | 0, 0, N - 1); y = clamp(y | 0, 0, N - 1);
      fly({ theta: cam.cur.theta, phi: 0.95, radius: CELL * 5.5, target: cellWorld(x, y) }, 1200);
    }
    function cityView() {
      var tg = S.gridCenter.clone(); tg.y = S.cellH[(N >> 1) * N + (N >> 1)];
      return { theta: 0.55, phi: 0.78, radius: N * CELL * 1.5, target: tg };
    }
    function flyToCity() {
      if (!S.ready) { pendingFlight = { fn: flyToCity, args: [] }; return; }
      fly(cityView(), 1400);
    }
    function flyToIsland() {
      if (!S.ready) { pendingFlight = { fn: flyToIsland, args: [] }; return; }
      fly({ theta: 0.35, phi: 0.72, radius: S.L * 1.15, target: S.center.clone() }, 1600);
    }

    // --- Construcción del mundo tras cargar los datos ----------------------------
    function buildWorld(meta, img) {
      var geo = makeGeo(meta), field = makeHeightField(img, meta.offset || 0, meta.meters_per_pixel);
      S.geo = geo; S.field = field;
      var bedH = Math.min(meta.min_h || -1000, -1000) - 50;
      S.fine = buildTerrain(field, geo, 512, terrainMat, bedH);
      S.coarse = buildTerrain(field, geo, 256, terrainMat, bedH);
      S.coarse.mesh.visible = false;
      scene.add(S.fine.mesh); scene.add(S.coarse.mesh);
      S.L = Math.max(geo.worldW, geo.worldH);
      S.center.set(geo.worldW / 2, 0, geo.worldH / 2);
      // Mar (plano grande a Y = 0, animado en el shader)
      var seaGeo = new THREE.PlaneGeometry(S.L * 8, S.L * 8, 1, 1); seaGeo.rotateX(-Math.PI / 2);
      S.sea = new THREE.Mesh(seaGeo, makeSeaMaterial(sunDir));
      S.sea.position.copy(S.center); S.sea.frustumCulled = false; S.sea.renderOrder = 1;
      scene.add(S.sea);
      // Fondo marino uniforme bajo todo el mar (evita que se vea el borde del mapa de alturas)
      var bedGeo = new THREE.PlaneGeometry(S.L * 8, S.L * 8, 1, 1); bedGeo.rotateX(-Math.PI / 2);
      var bedCol = new Uint8Array(3); terrainColor(bedH, 0, 0, bedCol, 0);
      S.seabed = new THREE.Mesh(bedGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(bedCol[0] / 255, bedCol[1] / 255, bedCol[2] / 255) }));
      S.seabed.position.set(S.center.x, bedH + 10, S.center.z); S.seabed.frustumCulled = false;
      scene.add(S.seabed);
      S.sky = makeSky(1000, colors.fog); scene.add(S.sky);
      if (meta.roads && meta.roads.length) { S.roads = buildRoads(meta.roads, geo); if (S.roads) scene.add(S.roads); }
      // Cuadrícula anclada (esquina NO en el anclaje) y su centro
      var gc = localToWorld(N / 2 * CELL, N / 2 * CELL);
      S.gridCenter.set(gc.x, 0, gc.z);
      S.cellState = new Uint8Array(N * N);
      buildTileLayer();
      buildCityMeshes();
      // Etiquetas: ciudades y cumbre siempre encima (sin test de profundidad); el resto
      // con test de profundidad y menor alcance. Dos llamadas de dibujo.
      var top = [], low = [], towns = meta.towns || [], i;
      var STYLE = { city: [colors.labelCity, 14, 1e12, true, 0], peak: [colors.labelPeak, 13, 1e12, true, 1],
        town: [colors.labelTown, 12, S.L * 1.3, false, 2], airport: [colors.labelAirport, 12, S.L * 1.3, false, 3],
        port: [colors.labelPort, 11, S.L * 0.8, false, 4], beach: [colors.labelBeach, 11, S.L * 0.8, false, 5] };
      for (i = 0; i < towns.length; i++) {
        var tw = towns[i], w = geo.toWorld(tw.lat, tw.lon), st = STYLE[tw.kind] || STYLE.town;
        if (w.x < 0 || w.z < 0 || w.x > geo.worldW || w.z > geo.worldH) continue;
        var pre = tw.kind === 'peak' ? '▲ ' : (tw.kind === 'airport' ? '✈ ' : '');
        var hy = Math.max(surfaceH(w.x, w.z), coarseH(w.x, w.z), 0) + 6;
        (tw.kind === 'city' || tw.kind === 'peak' ? top : low).push({ x: w.x, y: hy, z: w.z, text: pre + t(tw.name), color: st[0], size: st[1], maxDist: st[2], bold: st[3], pin: true, priority: st[4] });
      }
      if (N * CELL < S.L * 0.5) { // sólo si la ciudad es un "barrio" y no cubre la isla entera
        top.push({ x: gc.x, y: S.cellH[(N >> 1) * N + (N >> 1)] + LIFT + 40, z: gc.z, text: t('Ciudad RAMI'), color: colors.cityLabel, size: 15, maxDist: 1e12, bold: true, pin: false, priority: 0 });
      }
      S.townsTop = new LabelSet(viewportUniform, false); S.townsTop.set(top); scene.add(S.townsTop.mesh);
      S.towns = new LabelSet(viewportUniform, true); S.towns.set(low); scene.add(S.towns.mesh);
      // Cámara inicial: vista de la ciudad
      cam.maxR = S.L * 4;
      var cv = cityView();
      cam.cur.target.copy(cv.target); cam.goal.target.copy(cv.target);
      cam.cur.radius = cam.goal.radius = clamp(cv.radius, cam.minR, cam.maxR); cam.cur.phi = cam.goal.phi = cv.phi; cam.cur.theta = cam.goal.theta = cv.theta;
      S.ready = true;
      if (pending) { applyCity(pending); pending = null; }
      else if (S.city) applyCity(S.city);
      refreshSelection();
      resize();
      if (pendingFlight) { var pf = pendingFlight; pendingFlight = null; pf.fn.apply(null, pf.args); }
    }
    /** Carreteras: un único LineSegments drapeado con todas las polilíneas. */
    function buildRoads(roads, geo) {
      var pts = [], hcs = [], r, i;
      for (r = 0; r < roads.length; r++) {
        var line = roads[r];
        if (!line || line.length < 2) continue;
        var prev = null;
        for (i = 0; i < line.length; i++) {
          var w = geo.toWorld(line[i][1], line[i][0]);
          if (w.x < 0 || w.z < 0 || w.x > geo.worldW || w.z > geo.worldH) { prev = null; continue; }
          var p = [w.x, Math.max(surfaceH(w.x, w.z), 0) + 4, w.z, Math.max(coarseH(w.x, w.z), 0) + 4];
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
    var ready = loadJson(opts.metaUrl || '/geo/tenerife.json').then(null, function (err) {
      console.warn('city3d: no se pudo cargar el JSON geográfico (' + err.message + '); se usan metadatos por defecto.');
      return null;
    }).then(function (meta) {
      return loadBinary(opts.heightUrl || '/geo/tenerife.hgt.png').then(function (buf) { return decodePngGrayAsync(buf); }).then(function (r) {
        S.inflatePath = r.path;
        return [normalizeMeta(meta, r.img), r.img];
      }, function (err) {
        console.warn('city3d: no se pudo cargar el mapa de alturas (' + err.message + '); se genera una isla procedural.');
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
    var _pos = new THREE.Vector3(), _cp = new THREE.Vector3();
    var labelRects = { arr: new Float32Array(4 * 256), n: 0 };
    function updateCamera(dt) {
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
      // Nunca bajo el terreno
      var minY = Math.max(S.field ? S.field.atWorld(_pos.x, _pos.z) : 0, 0) + 12 + c.radius * 0.02;
      if (_pos.y < minY) { _pos.y = minY; if (!f) g.phi = Math.min(g.phi, c.phi - 0.01); }
      camera.position.copy(_pos);
      camera.lookAt(c.target);
      camera.near = Math.max(0.5, c.radius * 0.001); camera.far = Math.max(c.radius * 8, S.L * 8);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    }
    function cullLabels() {
      var W = viewportUniform.value.x, H = viewportUniform.value.y;
      _cp.setFromMatrixPosition(camera.matrixWorld);
      labelRects.n = 0;
      S.townsTop.cull(camera, _cp, W, H, labelRects);
      S.towns.cull(camera, _cp, W, H, labelRects);
    }
    function frame(now) {
      S.raf = 0;
      if (S.disposed) return;
      var dt = Math.min(0.1, (now - S.lastT) / 1000) || 0.016; S.lastT = now;
      // fps reales: fotogramas contados en una ventana de 1 s
      S.fpsN++;
      if (!S.fpsT) S.fpsT = now;
      else if (now - S.fpsT >= 1000) { S.fps = S.fpsN * 1000 / (now - S.fpsT); S.fpsN = 0; S.fpsT = now; }
      if (S.ready) {
        updateCamera(dt);
        var dist = camera.position.distanceTo(cam.cur.target);
        scene.fog.near = dist + S.L * 0.15; scene.fog.far = dist + S.L * 1.6;
        S.sky.position.copy(camera.position);
        S.sea.material.uniforms.uTime.value = now / 1000;
        var far = camera.position.distanceTo(S.center) > S.L;
        S.lod = far ? 1 : 0; lodUniform.value = S.lod;
        S.fine.mesh.visible = !far; S.coarse.mesh.visible = far;
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

    // --- VR ---------------------------------------------------------------------------
    var xr = { session: null, entering: false, saved: null };
    function xrSupported() {
      if (!global.navigator || !navigator.xr || !navigator.xr.isSessionSupported) return Promise.resolve(false);
      return navigator.xr.isSessionSupported('immersive-vr').then(function (v) { return !!v; }, function () { return false; });
    }
    /** Posición del visitante: de pie sobre la parcela seleccionada (o la central), mirando al edificio. */
    function vrPlacement(out) {
      var cell = S.sel || { x: N >> 1, y: N >> 1 }, w = cellWorld(cell.x, cell.y), off = rotOff(0, CELL * 0.42);
      var x = w.x + off.x, z = w.z + off.z;
      out.set(x, Math.max(surfaceH(x, z), 0) + LIFT + 1.6, z);
      return out;
    }
    function restoreDesktop() {
      renderer.setAnimationLoop(null);
      renderer.xr.enabled = false;
      xr.session = null; xr.entering = false;
      rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
      camera.position.set(0, 0, 0); camera.quaternion.set(0, 0, 0, 1);
      if (xr.saved) { camera.near = xr.saved.near; camera.far = xr.saved.far; camera.updateProjectionMatrix(); xr.saved = null; }
      S.xr = false; syncLoop();
    }
    function xrFrame(now) {
      S.sea.material.uniforms.uTime.value = now / 1000;
      S.sky.position.setFromMatrixPosition(camera.matrixWorld);
      renderer.render(scene, camera); S.frame++;
    }
    function enterVR() {
      if (!global.navigator || !navigator.xr) return Promise.reject(new Error(t('WebXR no disponible')));
      if (xr.session || xr.entering) return Promise.resolve(xr.session); // sesión ya activa (o iniciándose): ignorar
      if (!S.ready) return Promise.reject(new Error(t('El mapa 3D aún no está listo')));
      xr.entering = true;
      return xrSupported().then(function (ok) {
        if (!ok) throw new Error(t('WebXR no disponible'));
        return navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
      }).then(function (session) {
        xr.session = session;
        xr.saved = { near: camera.near, far: camera.far };
        renderer.xr.enabled = true;
        try { renderer.xr.setReferenceSpaceType('local'); } catch (e) {}
        camera.near = 0.1; camera.far = 200000; camera.updateProjectionMatrix();
        return renderer.xr.setSession(session).then(function () {
          vrPlacement(rig.position); rig.rotation.set(0, rotR, 0); // la cámara mira a -Z local = norte de la cuadrícula: hacia el centro de la parcela
          S.xr = true; xr.entering = false; syncLoop();
          session.addEventListener('end', restoreDesktop);
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
        S.cityHash = h; S.city = { parcels: data.parcels || [], assets: data.assets || [], me: data.me || null, size: data.size };
        if (data.size && data.size !== N) console.warn('city3d: el tamaño de la ciudad (' + data.size + ') no coincide con gridSize (' + N + ')');
        if (S.ready) applyCity(S.city); else pending = S.city;
      },
      select: function (x, y) { doSelect((x === null || x === undefined) ? null : { x: x | 0, y: y | 0 }, false); },
      flyTo: flyTo, flyToIsland: flyToIsland, flyToCity: flyToCity,
      resize: resize,
      setVisible: function (v) { S.visible = !!v; syncLoop(); },
      xrSupported: xrSupported, enterVR: enterVR,
      stats: function () { return { fps: Math.round(S.fps), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frame: S.frame }; },
      /** Correspondencia lat/lon <-> celda (misma fórmula que el panel 2D; no necesita los datos geo). */
      latLonToCell: latLonToCell,
      cellLatLon: cellLatLon,
      /** Utilidades (pruebas / integración) */
      cellWorld: function (x, y) { return S.ready ? cellWorld(x, y) : null; },
      cellInfo: function (x, y) {
        if (!S.ready) return null;
        var ci = (y | 0) * N + (x | 0);
        return { h: S.cellH[ci], top: S.cellTop[ci], lift: LIFT, sea: !!S.cellSea[ci], state: S.cellState[ci] };
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
        if (C.selLabel) C.selLabel.dispose();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e2) {}
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
      _debug: { scene: scene, camera: camera, renderer: renderer, state: S, meshes: C, cam: cam, vrPlacement: function () { return vrPlacement(new THREE.Vector3()); }, keysDown: function () { return Object.keys(keys); } }
    };
    return handle;
  }

  global.RamiCity3D = { mount: mount, version: '1.1.0', _internals: { inflate: inflate, inflateStream: inflateStream, decodePngGray: decodePngGray, decodePngGrayAsync: decodePngGrayAsync, fnv1a: fnv1a } };
})(typeof window !== 'undefined' ? window : this);
