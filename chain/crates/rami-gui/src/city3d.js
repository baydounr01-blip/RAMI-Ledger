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
 *   enterVR() / stats()
 *
 * Arquitectura (de abajo arriba):
 *   1. Utilidades: hash FNV-1a, inflate (zlib) propio, decodificador PNG de
 *      16 bits, proyección Web-Mercator (contrato de datos geo), rampa de color.
 *   2. Terreno: malla fina (<= 512x512 vértices) + malla gruesa (LOD lejano),
 *      colores por vértice según altura y pendiente, mar animado (shader),
 *      cúpula de cielo, niebla, carreteras y etiquetas de pueblos en un único
 *      "atlas" de texto (una sola llamada de dibujo, tamaño en píxeles fijo).
 *   3. Ciudad: cuadrícula 32x32 anclada al terreno (parche "aterrazado" bajo
 *      la ciudad), todo con InstancedMesh: baldosas libres, solares, edificios
 *      por tipo, marco de parcelas propias, activos (plantas/cajas) y anillos
 *      de alquiler. Hover/selección por raycast sobre las mallas instanciadas.
 *   4. Cámara orbital propia (sin OrbitControls), vuelos suaves, VR opcional.
 *
 * Convenciones: unidades del mundo en metros; X crece hacia el este,
 * Z hacia el sur, Y es la altura. El nivel del mar es Y = 0.
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
  // Implementación propia y compacta (estilo "tinf") para no depender de
  // DecompressionStream ni de librerías externas. Descomprime el flujo zlib
  // de los trozos IDAT de un PNG.
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

  // ---- Decodificador PNG (escala de grises 8/16 bits, sin entrelazado) ----
  /** Devuelve {width, height, depth, data: Uint16Array|Uint8Array} o lanza. */
  function decodePngGray(buf) {
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
    var bpp = depth === 16 ? 2 : 1, stride = width * bpp;
    var raw = inflate(z, height * (stride + 1));
    // Desfiltrado (None/Sub/Up/Average/Paeth)
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
  /** Crea el "geo": mapeo lat/lon <-> píxel de salida <-> metros del mundo. */
  function makeGeo(meta) {
    var ds = meta.downsample || 1, ox = meta.origin_px.x, oy = meta.origin_px.y, mpp = meta.meters_per_pixel;
    return {
      meta: meta,
      mpp: mpp,
      width: meta.width, height: meta.height,
      worldW: (meta.width - 1) * mpp, worldH: (meta.height - 1) * mpp,
      toPx: function (lat, lon) { return { x: (lonToTilePx(lon) - ox) / ds, y: (latToTilePx(lat) - oy) / ds }; },
      toWorld: function (lat, lon) { var p = this.toPx(lat, lon); return { x: p.x * mpp, z: p.y * mpp }; }
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
      atWorld: function (wx, wz) { return atPx(wx / mpp, wz / mpp); },
      /** Altura suavizada (media de 9 muestras en un radio r metros). */
      smoothWorld: function (wx, wz, r) {
        var s = 0;
        for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) s += atPx((wx + i * r) / mpp, (wz + j * r) / mpp);
        return s / 9;
      }
    };
  }

  // ---------------------------------------------------------------------
  // 2. TERRENO, MAR, CIELO, CARRETERAS Y ETIQUETAS
  // ---------------------------------------------------------------------

  /**
   * Construye una malla de terreno muestreando el campo de alturas con
   * `segs` segmentos en el eje mayor. Devuelve {mesh, grid, sx, sz, dx, dz}
   * donde `grid` son las alturas muestreadas (para consultar la superficie
   * visible exactamente, triángulo a triángulo).
   */
  function buildTerrain(field, geo, segs, material) {
    var W = geo.worldW, H = geo.worldH;
    var sx = W >= H ? segs : Math.max(8, Math.round(segs * W / H));
    var sz = W >= H ? Math.max(8, Math.round(segs * H / W)) : segs;
    sx = Math.min(sx, field.width - 1); sz = Math.min(sz, field.height - 1);
    var nx = sx + 1, nz = sz + 1, dx = W / sx, dz = H / sz;
    var grid = new Float32Array(nx * nz), i, j;
    for (j = 0; j < nz; j++) for (i = 0; i < nx; i++) {
      grid[j * nx + i] = field.atPx(i * dx / geo.mpp, j * dz / geo.mpp);
    }
    var pos = new Float32Array(nx * nz * 3), col = new Uint8Array(nx * nz * 3);
    for (j = 0; j < nz; j++) for (i = 0; i < nx; i++) {
      var k = j * nx + i, h = grid[k];
      pos[k * 3] = i * dx; pos[k * 3 + 1] = h; pos[k * 3 + 2] = j * dz;
      var hl = grid[j * nx + (i > 0 ? i - 1 : i)], hr = grid[j * nx + (i < sx ? i + 1 : i)];
      var hu = grid[(j > 0 ? j - 1 : j) * nx + i], hd = grid[(j < sz ? j + 1 : j) * nx + i];
      var gx = (hr - hl) / (2 * dx), gz = (hd - hu) / (2 * dz);
      terrainColor(h, Math.sqrt(gx * gx + gz * gz), hash2(i, j) * 2 - 1, col, k * 3);
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
    return { mesh: mesh, grid: grid, nx: nx, nz: nz, sx: sx, sz: sz, dx: dx, dz: dz };
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
        '#include <fog_pars_vertex>',
        'varying vec3 vWorld;',
        'void main(){',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vWorld = wp.xyz;',
        '  vec4 mvPosition = viewMatrix * wp;',
        '  gl_Position = projectionMatrix * mvPosition;',
        '  #include <fog_vertex>',
        '}'].join('\n'),
      fragmentShader: [
        '#include <fog_pars_fragment>',
        'uniform float uTime; uniform vec3 uSun, uDeep, uShallow, uSky;',
        'varying vec3 vWorld;',
        'void main(){',
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

  /** Cúpula de cielo con degradado (sin niebla), centrada en la cámara. */
  function makeSky(radius) {
    var mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTop: { value: new THREE.Color(0x3f7cc9) }, uHorizon: { value: new THREE.Color(0xd6e6f2) } },
      vertexShader: 'varying float vY; void main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uTop, uHorizon; varying float vY; void main(){ float t = pow(clamp(vY, 0.0, 1.0), 0.55); gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0); }'
    });
    var m = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 14), mat);
    m.frustumCulled = false; m.renderOrder = -10;
    return m;
  }

  /** Carreteras: un único LineSegments con todas las polilíneas. */
  function buildRoads(roads, geo, surfaceH) {
    var pts = [], r, i;
    for (r = 0; r < roads.length; r++) {
      var line = roads[r];
      if (!line || line.length < 2) continue;
      var prev = null;
      for (i = 0; i < line.length; i++) {
        var w = geo.toWorld(line[i][1], line[i][0]);
        if (w.x < 0 || w.z < 0 || w.x > geo.worldW || w.z > geo.worldH) { prev = null; continue; }
        var p = [w.x, Math.max(surfaceH(w.x, w.z), 0) + 4, w.z];
        if (prev) pts.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
        prev = p;
      }
    }
    if (!pts.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    var m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5a4a3c, fog: true }));
    m.frustumCulled = false;
    return m;
  }

  // ---- Etiquetas: atlas de texto en canvas + una sola malla ------------------
  // Cada etiqueta es un cuadrilátero anclado a un punto 3D cuyo tamaño se fija
  // en píxeles en el vertex shader (siempre legible, no depende de la
  // distancia). Todas las etiquetas del conjunto se dibujan en UNA llamada.
  var LABEL_VS = [
    'attribute vec2 corner; attribute vec2 lsize; attribute float lmax;',
    'uniform vec2 uViewport; varying vec2 vUv; varying float vVis;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  float d = length(mv.xyz);',
    '  vec4 clip = projectionMatrix * mv;',
    '  vVis = (d < lmax && clip.w > 0.0) ? 1.0 : 0.0;',
    '  clip.xy += corner * lsize / uViewport * 2.0 * clip.w;',
    '  gl_Position = clip; vUv = uv;',
    '}'].join('\n');
  var LABEL_FS = [
    'uniform sampler2D uMap; varying vec2 vUv; varying float vVis;',
    'void main(){ vec4 c = texture2D(uMap, vUv); if (c.a * vVis < 0.03) discard; gl_FragColor = vec4(c.rgb, c.a * vVis); }'
  ].join('\n');

  function LabelSet(viewportUniform) {
    this.viewport = viewportUniform;
    this.texture = null;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uViewport: viewportUniform },
      vertexShader: LABEL_VS, fragmentShader: LABEL_FS,
      transparent: true, depthTest: false, depthWrite: false
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 50;
    this.mesh.visible = false;
  }
  /**
   * items: [{x,y,z, text, color, size (px), maxDist, pin (bool), bold}]
   * Reconstruye el atlas y la geometría.
   */
  LabelSet.prototype.set = function (items) {
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
    }
    var n = items.length;
    var pos = new Float32Array(n * 12), corner = new Float32Array(n * 8), uv = new Float32Array(n * 8);
    var lsize = new Float32Array(n * 8), lmax = new Float32Array(n * 4), idx = new Uint16Array(n * 6);
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
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    if (this.texture) this.texture.dispose();
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.minFilter = THREE.LinearFilter; this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.material.uniforms.uMap.value = this.texture;
    this.mesh.visible = n > 0;
  };
  LabelSet.prototype.dispose = function () {
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    if (this.texture) this.texture.dispose();
    this.material.dispose();
  };

  /** Construye la geometría combinada (posiciones+colores+índices) de cuadriláteros. */
  function MeshBuilder() { this.pos = []; this.col = []; this.idx = []; this.n = 0; }
  MeshBuilder.prototype.vertex = function (x, y, z, r, g, b) {
    this.pos.push(x, y, z); this.col.push(r, g, b); return this.n++;
  };
  /** Cuadrilátero p0..p3 en orden antihorario visto desde el frente. */
  MeshBuilder.prototype.quad = function (a, b, c, d) { this.idx.push(a, b, c, a, c, d); };
  MeshBuilder.prototype.build = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 3, true));
    g.setIndex(new THREE.BufferAttribute(this.n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeVertexNormals();
    return g;
  };

  // ---------------------------------------------------------------------
  // 3. CIUDAD (cuadrícula instanciada) + 4. CÁMARA, BUCLE Y API PÚBLICA
  // ---------------------------------------------------------------------

  var KIND_KEYS = ['Empresa', 'Granja', 'Tienda', 'Oficina'];
  var DEFAULT_COLORS = {
    kinds: ['#4f8cff', '#4ccf6e', '#f2b84b', '#c77dff'],
    accent: '#7ef0c0', select: '#ffffff', hover: '#ffffff', tileFree: '#eaf3ff', lease: '#4fd8ff',
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
  /** Geometrías de edificio por tipo (0 Empresa, 1 Granja, 2 Tienda, 3 Oficina). */
  function makeBuildingGeometries(c) {
    return [
      buildingGeometry([ // Empresa: bloque de altura media con cornisa y marquesina
        { w: c * 0.62, h: 26, d: c * 0.50, s: [0.95, 0.95, 1.0] },
        { w: c * 0.66, h: 1.5, d: c * 0.54, y: 26, s: [0.45, 0.45, 0.5] },
        { w: c * 0.30, h: 1.0, d: c * 0.12, y: 5, z: c * 0.30, s: [0.6, 0.6, 0.65] }
      ]),
      buildingGeometry([ // Granja: nave baja tipo invernadero con techo verde
        { w: c * 0.78, h: 5.5, d: c * 0.62, s: [1.0, 1.0, 0.94] },
        { w: c * 0.82, h: 1.4, d: c * 0.66, y: 5.5, s: [0.55, 1.0, 0.55] },
        { w: c * 0.10, h: 3.0, d: c * 0.10, x: c * 0.30, z: c * 0.24, y: 6.9, s: [0.7, 0.7, 0.75] }
      ]),
      buildingGeometry([ // Tienda: caja pequeña con toldo y rótulo
        { w: c * 0.50, h: 8, d: c * 0.42, s: [1.0, 1.0, 1.0] },
        { w: c * 0.56, h: 0.5, d: c * 0.16, y: 4.5, z: c * 0.27, s: [1.0, 0.72, 0.42] },
        { w: c * 0.30, h: 1.6, d: 0.6, y: 8, z: c * 0.20, s: [1.0, 1.0, 0.6] }
      ]),
      buildingGeometry([ // Oficina: torre alta con coronamiento y antena
        { w: c * 0.44, h: 55, d: c * 0.44, s: [0.92, 0.95, 1.0] },
        { w: c * 0.30, h: 6, d: c * 0.30, y: 55, s: [0.7, 0.72, 0.82] },
        { w: 0.7, h: 10, d: 0.7, y: 61, s: [0.4, 0.4, 0.45] }
      ])
    ];
  }
  /** Marco cuadrado (4 listones) para resaltar parcelas. */
  function frameGeometry(size, thick, height) {
    var h = size / 2, t = thick / 2;
    return buildingGeometry([
      { w: size, h: height, d: thick, z: -h + t, s: [1, 1, 1] }, { w: size, h: height, d: thick, z: h - t, s: [1, 1, 1] },
      { w: thick, h: height, d: size - thick * 2, x: -h + t, s: [1, 1, 1] }, { w: thick, h: height, d: size - thick * 2, x: h - t, s: [1, 1, 1] }
    ]);
  }

  // ---------------------------------------------------------------------
  function mount(container, opts) {
    opts = opts || {};
    var t = typeof opts.t === 'function' ? opts.t : function (k) { return k; };
    var N = opts.gridSize || 32;
    var anchor = opts.anchor || { lat: 28.085, lon: -16.505, cellMeters: 60, rotationDeg: 0 };
    var CELL = anchor.cellMeters || 60;
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
    if (!gl) throw new Error('WebGL no disponible en este navegador/webview; se usará la vista 2D.');

    // --- Renderer, escena, cámara ----------------------------------------------
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: true, alpha: false });
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
    var terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    var patchMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

    // Estado global del visor
    var S = {
      ready: false, disposed: false, visible: true, docHidden: !!document.hidden, xr: false,
      field: null, geo: null, fine: null, coarse: null, L: 60000, center: new THREE.Vector3(),
      sea: null, sky: null, roads: null, towns: null, patch: null, outline: null,
      city: null, cityHash: null, cellH: null, gridCenter: new THREE.Vector3(),
      sel: null, hover: null, frame: 0, fps: 60, lastT: 0, raf: 0
    };
    var gridGroup = new THREE.Group(); scene.add(gridGroup);
    var sinR = 0, cosR = 1; // rotación de la cuadrícula
    var pending = null;     // ciudad recibida antes de que el terreno esté listo

    // --- Altura de la superficie visible del terreno (metros del mundo) ---------
    function surfaceH(wx, wz) { return S.fine ? meshSurfaceHeight(S.fine, wx, wz) : 0; }

    // --- Cuadrícula: coordenadas locales <-> mundo --------------------------
    function cellLocal(x, y) { return { x: (x + 0.5 - N / 2) * CELL, z: (y + 0.5 - N / 2) * CELL }; }
    function localToWorld(lx, lz) {
      return { x: gridGroup.position.x + lx * cosR + lz * sinR, z: gridGroup.position.z - lx * sinR + lz * cosR };
    }
    function cellWorld(x, y) {
      var l = cellLocal(x, y), w = localToWorld(l.x, l.z);
      return new THREE.Vector3(w.x, S.cellH ? S.cellH[y * N + x] : 0, w.z);
    }

    // --- Construcción del parche aterrazado bajo la ciudad -------------------
    function buildPatch() {
      var M = 8, i, j, x, y, tmp = new Uint8Array(3);
      var field = S.field, half = N / 2 * CELL;
      // Alturas por celda (suavizadas; nunca bajo el nivel del mar: plataforma)
      S.cellH = new Float32Array(N * N);
      for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
        var l = cellLocal(x, y), w = localToWorld(l.x, l.z);
        S.cellH[y * N + x] = Math.max(field.smoothWorld(w.x, w.z, CELL * 1.5), 1.0);
      }
      // Alturas de las esquinas del anillo exterior (mezcla suave hacia el terreno base)
      var R = N + 2 * M + 1, corner = new Float32Array(R * R);
      function cornerH(i, j) { return corner[(j + M) * R + (i + M)]; }
      for (j = -M; j <= N + M; j++) for (i = -M; i <= N + M; i++) {
        var lx = (i - N / 2) * CELL, lz = (j - N / 2) * CELL, wp = localToWorld(lx, lz);
        var dO = Math.max(0, -i, i - N, -j, j - N), wgt = smoothstep(dO / (M - 3));
        var hs = Math.max(field.smoothWorld(wp.x, wp.z, CELL * 1.5), wgt < 1 ? 1.0 : -1e9);
        corner[(j + M) * R + (i + M)] = wgt >= 1 ? surfaceH(wp.x, wp.z) : lerp(hs, surfaceH(wp.x, wp.z), wgt);
      }
      var mb = new MeshBuilder();
      function tc(h, s, n) { terrainColor(h, s, n, tmp, 0); return tmp; }
      // Anillo exterior (vértices compartidos, celdas fuera de la cuadrícula)
      var ringIdx = new Int32Array(R * R);
      for (j = -M; j <= N + M; j++) for (i = -M; i <= N + M; i++) {
        var h0 = cornerH(i, j), sl = Math.abs(cornerH(Math.min(i + 1, N + M), j) - cornerH(Math.max(i - 1, -M), j)) / (2 * CELL);
        var c0 = tc(h0, sl, hash2(i + 77, j + 33) * 2 - 1);
        ringIdx[(j + M) * R + (i + M)] = mb.vertex((i - N / 2) * CELL, h0, (j - N / 2) * CELL, c0[0], c0[1], c0[2]);
      }
      for (j = -M; j < N + M; j++) for (i = -M; i < N + M; i++) {
        if (i >= 0 && i < N && j >= 0 && j < N) continue;
        var a = ringIdx[(j + M) * R + (i + M)], b = ringIdx[(j + M + 1) * R + (i + M)];
        var c = ringIdx[(j + M + 1) * R + (i + M + 1)], d = ringIdx[(j + M) * R + (i + M + 1)];
        mb.quad(a, b, c, d);
      }
      // Faldón exterior (oculta el terreno base rebajado bajo el parche)
      var SK = 60;
      function skirt(i0, j0, i1, j1) {
        var p0 = ringIdx[(j0 + M) * R + (i0 + M)], p1 = ringIdx[(j1 + M) * R + (i1 + M)];
        var q0 = mb.vertex(mb.pos[p0 * 3], mb.pos[p0 * 3 + 1] - SK, mb.pos[p0 * 3 + 2], mb.col[p0 * 3], mb.col[p0 * 3 + 1], mb.col[p0 * 3 + 2]);
        var q1 = mb.vertex(mb.pos[p1 * 3], mb.pos[p1 * 3 + 1] - SK, mb.pos[p1 * 3 + 2], mb.col[p1 * 3], mb.col[p1 * 3 + 1], mb.col[p1 * 3 + 2]);
        mb.quad(p0, p1, q1, q0);
      }
      for (i = -M; i < N + M; i++) { skirt(i, -M, i + 1, -M); skirt(i, N + M, i + 1, N + M); }
      for (j = -M; j < N + M; j++) { skirt(-M, j, -M, j + 1); skirt(N + M, j, N + M, j + 1); }
      // Terrazas (una plataforma plana por parcela) y "muros" entre ellas
      var ground = [0.46, 0.43, 0.37];
      function cellCol(h, x, y) {
        var cc = tc(h, 0, hash2(x + 5, y + 9) * 2 - 1);
        return [lerp(cc[0], ground[0] * 255, 0.7), lerp(cc[1], ground[1] * 255, 0.7), lerp(cc[2], ground[2] * 255, 0.7)];
      }
      function riser(x0, z0, x1, z1, top, b0, b1, cl) {
        if (Math.abs(top - b0) < 0.05 && Math.abs(top - b1) < 0.05) return;
        var r = [cl[0] * 0.75, cl[1] * 0.72, cl[2] * 0.7];
        var v0 = mb.vertex(x0, top, z0, r[0], r[1], r[2]), v1 = mb.vertex(x1, top, z1, r[0], r[1], r[2]);
        var v2 = mb.vertex(x1, b1, z1, r[0], r[1], r[2]), v3 = mb.vertex(x0, b0, z0, r[0], r[1], r[2]);
        mb.quad(v0, v1, v2, v3);
      }
      for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
        var h = S.cellH[y * N + x], x0 = (x - N / 2) * CELL, x1 = x0 + CELL, z0 = (y - N / 2) * CELL, z1 = z0 + CELL;
        var cl = cellCol(h, x, y);
        var v0 = mb.vertex(x0, h, z0, cl[0], cl[1], cl[2]), v1 = mb.vertex(x0, h, z1, cl[0], cl[1], cl[2]);
        var v2 = mb.vertex(x1, h, z1, cl[0], cl[1], cl[2]), v3 = mb.vertex(x1, h, z0, cl[0], cl[1], cl[2]);
        mb.quad(v0, v1, v2, v3);
        // este
        if (x + 1 < N) { var he = S.cellH[y * N + x + 1]; riser(x1, z0, x1, z1, h, he, he, cl); }
        else riser(x1, z0, x1, z1, h, cornerH(x + 1, y), cornerH(x + 1, y + 1), cl);
        // sur
        if (y + 1 < N) { var hs2 = S.cellH[(y + 1) * N + x]; riser(x0, z1, x1, z1, h, hs2, hs2, cl); }
        else riser(x0, z1, x1, z1, h, cornerH(x, y + 1), cornerH(x + 1, y + 1), cl);
        if (x === 0) riser(x0, z0, x0, z1, h, cornerH(0, y), cornerH(0, y + 1), cl);
        if (y === 0) riser(x0, z0, x1, z0, h, cornerH(x, 0), cornerH(x + 1, 0), cl);
      }
      if (S.patch) { gridGroup.remove(S.patch); S.patch.geometry.dispose(); }
      S.patch = new THREE.Mesh(mb.build(), patchMat);
      S.patch.position.y = 1.5; S.patch.frustumCulled = false;
      gridGroup.add(S.patch);
      // Rebajar el terreno base bajo el parche (queda oculto por él y su faldón)
      var lim = half + M * CELL, meshes = [S.fine, S.coarse], m, k;
      for (m = 0; m < meshes.length; m++) {
        var tm = meshes[m], pa = tm.mesh.geometry.attributes.position, lower = lim - Math.max(tm.dx, tm.dz) * 1.05;
        if (lower <= 0) continue;
        for (k = 0; k < pa.count; k++) {
          var dxw = pa.getX(k) - gridGroup.position.x, dzw = pa.getZ(k) - gridGroup.position.z;
          var lx2 = dxw * cosR - dzw * sinR, lz2 = dxw * sinR + dzw * cosR; // rotación inversa
          if (Math.abs(lx2) < lower && Math.abs(lz2) < lower) pa.setY(k, pa.getY(k) - 25);
        }
        pa.needsUpdate = true;
      }
      // Contorno de la cuadrícula
      var op = [];
      for (i = 0; i < N; i++) op.push((i - N / 2) * CELL, cornerH(i, 0) + 1.6, -half);
      for (j = 0; j < N; j++) op.push(half, cornerH(N, j) + 1.6, (j - N / 2) * CELL);
      for (i = N; i > 0; i--) op.push((i - N / 2) * CELL, cornerH(i, N) + 1.6, half);
      for (j = N; j > 0; j--) op.push(-half, cornerH(0, j) + 1.6, (j - N / 2) * CELL);
      if (S.outline) { gridGroup.remove(S.outline); S.outline.geometry.dispose(); }
      var og = new THREE.BufferGeometry(); og.setAttribute('position', new THREE.Float32BufferAttribute(op, 3));
      S.outline = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: new THREE.Color(colors.accent), transparent: true, opacity: 0.6 }));
      S.outline.position.y = 1.5; S.outline.frustumCulled = false;
      gridGroup.add(S.outline);
    }

    // --- Mallas instanciadas de la ciudad ---------------------------------------
    var C = {}; // contenedor de mallas de la ciudad
    var dummy = new THREE.Object3D(), tmpColor = new THREE.Color();
    function inst(geometry, material, capacity, name) {
      var m = new THREE.InstancedMesh(geometry, material, capacity);
      m.count = 0; m.frustumCulled = false; m.name = name; m.userData.cells = [];
      for (var i = 0; i < capacity; i++) m.setColorAt(i, tmpColor.set(0xffffff));
      m.instanceColor.needsUpdate = true;
      gridGroup.add(m);
      return m;
    }
    function buildCityMeshes() {
      var tileGeo = new THREE.BoxGeometry(CELL * 0.92, 0.3, CELL * 0.92);
      C.tileFree = inst(tileGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(colors.tileFree), transparent: true, opacity: 0.5, depthWrite: false }), N * N, 'tileFree');
      C.tilePlot = inst(tileGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), N * N, 'tilePlot');
      var bg = makeBuildingGeometries(CELL);
      C.buildings = [];
      for (var k = 0; k < 4; k++) C.buildings.push(inst(bg[k], new THREE.MeshLambertMaterial({ vertexColors: true }), N * N, 'building' + k));
      C.own = inst(frameGeometry(CELL * 0.98, 1.6, 1.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.accent) }), N * N, 'own');
      C.assetCap = 0;
      buildAssetMeshes(256);
      var hoverGeo = new THREE.PlaneGeometry(CELL * 1.02, CELL * 1.02); hoverGeo.rotateX(-Math.PI / 2);
      C.hover = new THREE.Mesh(hoverGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.hover), transparent: true, opacity: 0.28, depthWrite: false }));
      C.hover.visible = false; C.hover.renderOrder = 5; gridGroup.add(C.hover);
      C.selFrame = new THREE.Mesh(frameGeometry(CELL * 1.04, 2.4, 2.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.select) }));
      C.selFrame.visible = false; gridGroup.add(C.selFrame);
      C.selLabel = new LabelSet(viewportUniform); scene.add(C.selLabel.mesh);
      C.pickables = [C.tileFree, C.tilePlot].concat(C.buildings);
    }
    function buildAssetMeshes(cap) {
      var old = [C.plants, C.crates, C.rings], i;
      for (i = 0; i < old.length; i++) if (old[i]) { gridGroup.remove(old[i]); old[i].geometry.dispose(); old[i].material.dispose(); old[i].dispose(); }
      var cone = new THREE.ConeGeometry(2.4, 6.5, 7); cone.translate(0, 3.25, 0);
      var crate = new THREE.BoxGeometry(3.4, 3.4, 3.4); crate.translate(0, 1.7, 0);
      var ring = new THREE.TorusGeometry(3.8, 0.3, 6, 18); ring.rotateX(Math.PI / 2); ring.translate(0, 0.35, 0);
      C.plants = inst(cone, new THREE.MeshLambertMaterial({ color: 0xffffff }), cap, 'plants');
      C.crates = inst(crate, new THREE.MeshLambertMaterial({ color: 0xffffff }), cap, 'crates');
      C.rings = inst(ring, new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.lease), transparent: true, opacity: 0.85 }), cap, 'rings');
      C.assetCap = cap;
    }
    function place(mesh, idx, lx, ly, lz, sx, sy, sz, color, cellIndex) {
      dummy.position.set(lx, ly, lz); dummy.rotation.set(0, 0, 0); dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix(); mesh.setMatrixAt(idx, dummy.matrix);
      if (color) mesh.setColorAt(idx, color);
      mesh.userData.cells[idx] = cellIndex;
    }
    function finish(mesh, count) {
      mesh.count = count; mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    var kindColors = [];
    for (var kc = 0; kc < 4; kc++) kindColors.push(new THREE.Color(colors.kinds[kc]));
    var plantColor = new THREE.Color(colors.plant), crateColor = new THREE.Color(colors.crate);

    /** Vuelca los datos de la ciudad en las mallas instanciadas (sin recrear la escena). */
    function applyCity(d) {
      var n = N, i, x, y, cnt = { free: 0, plot: 0, own: 0, b: [0, 0, 0, 0] };
      var parcelAt = new Int32Array(n * n); for (i = 0; i < n * n; i++) parcelAt[i] = -1;
      for (i = 0; i < d.parcels.length; i++) {
        var p = d.parcels[i];
        if (p.x >= 0 && p.x < n && p.y >= 0 && p.y < n) parcelAt[p.y * n + p.x] = i;
      }
      S.parcelAt = parcelAt;
      var me = d.me || null;
      for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
        var ci = y * n + x, l = cellLocal(x, y), h = S.cellH[ci], pi = parcelAt[ci];
        if (pi < 0) { place(C.tileFree, cnt.free++, l.x, h + 1.75, l.z, 1, 1, 1, null, ci); continue; }
        var pc = d.parcels[pi], kind = clamp(pc.kind | 0, 0, 3);
        tmpColor.copy(kindColors[kind]).multiplyScalar(0.55);
        place(C.tilePlot, cnt.plot++, l.x, h + 1.75, l.z, 1, 1, 1, tmpColor, ci);
        var v = 0.9 + 0.2 * hash2(x + 13, y + 29), sy = 0.85 + 0.3 * hash2(x + 3, y + 7) + Math.min(pc.assets | 0, 6) * 0.03;
        tmpColor.copy(kindColors[kind]).multiplyScalar(v);
        place(C.buildings[kind], cnt.b[kind]++, l.x, h + 1.9, l.z, 1, sy, 1, tmpColor, ci);
        if (me && pc.owner === me) place(C.own, cnt.own++, l.x, h + 1.92, l.z, 1, 1, 1, null, ci);
      }
      finish(C.tileFree, cnt.free); finish(C.tilePlot, cnt.plot); finish(C.own, cnt.own);
      for (i = 0; i < 4; i++) finish(C.buildings[i], cnt.b[i]);
      // Activos: hasta 12 huecos por parcela alrededor del edificio (rejilla 4x4 sin el centro)
      if (d.assets.length > C.assetCap) { var cap = 256; while (cap < d.assets.length) cap *= 2; buildAssetMeshes(cap); }
      var slots = new Uint8Array(n * n), np = 0, nc = 0, nr = 0, SLOT = [];
      for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) if (!((x === 1 || x === 2) && (y === 1 || y === 2))) SLOT.push([(x - 1.5) * CELL * 0.235, (y - 1.5) * CELL * 0.235]);
      for (i = 0; i < d.assets.length; i++) {
        var a = d.assets[i];
        if (!(a.x >= 0 && a.x < n && a.y >= 0 && a.y < n)) continue;
        var cj = a.y * n + a.x, lc = cellLocal(a.x, a.y), s = SLOT[slots[cj]++ % 12], hh = S.cellH[cj] + 1.9;
        var ax = lc.x + s[0], az = lc.z + s[1];
        if ((a.kind | 0) === 1) {
          tmpColor.copy(crateColor).multiplyScalar(0.85 + 0.3 * hash2(i, 11));
          place(C.crates, nc++, ax, hh, az, 1, 1, 1, tmpColor, cj);
        } else {
          var gsc = 0.8 + 0.5 * hash2(i, 5);
          tmpColor.copy(plantColor).offsetHSL(0.03 * (hash2(i, 17) - 0.5), 0, 0.1 * (hash2(i, 19) - 0.5));
          place(C.plants, np++, ax, hh, az, gsc, gsc, gsc, tmpColor, cj);
        }
        if (a.lease && a.lease.active) place(C.rings, nr++, ax, hh, az, 1, 1, 1, null, cj);
      }
      finish(C.plants, np); finish(C.crates, nc); finish(C.rings, nr);
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
      if (!S.sel) { C.selFrame.visible = false; C.selLabel.mesh.visible = false; return; }
      var x = S.sel.x, y = S.sel.y, l = cellLocal(x, y), h = S.cellH[y * N + x];
      C.selFrame.position.set(l.x, h + 1.95, l.z); C.selFrame.visible = true;
      var p = parcelInfo(x, y), txt;
      if (p) {
        txt = t(KIND_KEYS[clamp(p.kind | 0, 0, 3)]) + ' (' + x + ', ' + y + ')';
        if (p.name) txt += ' · ' + p.name;
        if (S.city && S.city.me && p.owner === S.city.me) txt += ' · ' + t('Mía');
      } else txt = t('Parcela libre') + ' (' + x + ', ' + y + ')';
      var w = cellWorld(x, y);
      C.selLabel.set([{ x: w.x, y: h + 8, z: w.z, text: txt, color: colors.select, size: 13, bold: true, pin: true }]);
      C.selLabel.mesh.visible = true;
    }
    function setHover(cell) {
      var same = (cell === null && S.hover === null) || (cell && S.hover && cell.x === S.hover.x && cell.y === S.hover.y);
      if (same) return;
      S.hover = cell;
      if (cell) {
        var l = cellLocal(cell.x, cell.y);
        C.hover.position.set(l.x, S.cellH[cell.y * N + cell.x] + 2.1, l.z); C.hover.visible = true;
        canvas.style.cursor = 'pointer';
      } else { C.hover.visible = false; canvas.style.cursor = 'grab'; }
      onHover(cell ? cell.x : null, cell ? cell.y : null);
    }
    var raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
    function pick(clientX, clientY) {
      if (!S.ready) return null;
      var r = canvas.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      var hits = raycaster.intersectObjects(C.pickables, false);
      if (!hits.length || hits[0].instanceId === undefined) return null;
      var ci = hits[0].object.userData.cells[hits[0].instanceId];
      return ci === undefined ? null : { x: ci % N, y: Math.floor(ci / N) };
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
    function panBy(dx, dy) {
      var th = cam.cur.theta, k = cam.cur.radius * 0.0016;
      var rx = Math.cos(th), rz = -Math.sin(th), fx = -Math.sin(th), fz = -Math.cos(th);
      var tg = cam.goal.target.clone();
      tg.x += (-rx * dx - fx * dy) * k; tg.z += (-rz * dx - fz * dy) * k;
      tg.x = clamp(tg.x, -S.L, S.geo ? S.geo.worldW + S.L : S.L); tg.z = clamp(tg.z, -S.L, S.geo ? S.geo.worldH + S.L : S.L);
      setGoalTarget(tg);
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
      pointerPos = { x: e.clientX, y: e.clientY }; pointerDirty = true;
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
      if (c) { // el clic previo ya seleccionó la parcela: no repetir onSelect
        if (!S.sel || S.sel.x !== c.x || S.sel.y !== c.y) doSelect(c, true);
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
      var k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', '+', '-', 'escape'].indexOf(k) < 0) return;
      if (k === 'escape') { doSelect(null, true); return; }
      if (k === '+') zoomBy(0.8); else if (k === '-') zoomBy(1.25); else keys[k] = true;
      cancelFlight(); e.preventDefault();
    };
    L.keyup = function (e) { delete keys[e.key.toLowerCase()]; };
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
    document.addEventListener('visibilitychange', L.visibility);
    global.addEventListener('resize', L.resize);
    var ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(function () { resize(); }); ro.observe(container); }

    function doSelect(cell, fromUser) {
      if (cell && !(cell.x >= 0 && cell.x < N && cell.y >= 0 && cell.y < N)) cell = null;
      S.sel = cell ? { x: cell.x, y: cell.y } : null;
      refreshSelection();
      if (fromUser) onSelect(cell ? cell.x : null, cell ? cell.y : null);
    }
    /** Vuelo suave de la cámara hacia un estado objetivo. */
    function fly(to, dur) {
      var from = { theta: cam.cur.theta, phi: cam.cur.phi, radius: cam.cur.radius, target: cam.cur.target.clone() };
      var dth = to.theta - from.theta; dth = Math.atan2(Math.sin(dth), Math.cos(dth)); // camino más corto
      cam.flight = { t0: performance.now(), dur: dur, from: from, to: { theta: from.theta + dth, phi: to.phi, radius: to.radius, target: to.target.clone() } };
    }
    function flyTo(x, y) {
      if (!S.ready) return;
      x = clamp(x | 0, 0, N - 1); y = clamp(y | 0, 0, N - 1);
      fly({ theta: cam.cur.theta, phi: 0.95, radius: CELL * 5.5, target: cellWorld(x, y) }, 1200);
    }
    function flyToCity() {
      if (!S.ready) return;
      var tg = S.gridCenter.clone(); tg.y = S.cellH[(N >> 1) * N + (N >> 1)];
      fly({ theta: 0.55, phi: 0.78, radius: N * CELL * 1.5, target: tg }, 1400);
    }
    function flyToIsland() {
      if (!S.ready) return;
      fly({ theta: 0.35, phi: 0.72, radius: S.L * 1.15, target: S.center.clone() }, 1600);
    }

    // --- Construcción del mundo tras cargar los datos ----------------------------
    function buildWorld(meta, img) {
      var geo = makeGeo(meta), field = makeHeightField(img, meta.offset || 0, meta.meters_per_pixel);
      S.geo = geo; S.field = field;
      S.fine = buildTerrain(field, geo, 512, terrainMat);
      S.coarse = buildTerrain(field, geo, 128, terrainMat);
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
      var bedCol = new Uint8Array(3); terrainColor(Math.min(meta.min_h || -1000, -1000) - 50, 0, 0, bedCol, 0);
      S.seabed = new THREE.Mesh(bedGeo, new THREE.MeshLambertMaterial({ color: new THREE.Color(bedCol[0] / 255, bedCol[1] / 255, bedCol[2] / 255) }));
      S.seabed.position.set(S.center.x, Math.min(meta.min_h || -1000, -1000) - 40, S.center.z); S.seabed.frustumCulled = false;
      scene.add(S.seabed);
      S.sky = makeSky(camera.far * 0.8); scene.add(S.sky);
      if (meta.roads && meta.roads.length) { S.roads = buildRoads(meta.roads, geo, surfaceH); if (S.roads) { S.roads.material.color.set(colors.road); scene.add(S.roads); } }
      // Cuadrícula anclada
      var g = geo.toWorld(anchor.lat, anchor.lon);
      var rot = -(anchor.rotationDeg || 0) * Math.PI / 180;
      gridGroup.position.set(g.x, 0, g.z); gridGroup.rotation.y = rot;
      sinR = Math.sin(rot); cosR = Math.cos(rot);
      S.gridCenter.set(g.x, 0, g.z);
      buildPatch();
      buildCityMeshes();
      // Etiquetas de pueblos + etiqueta de la ciudad (una sola llamada de dibujo)
      var items = [], towns = meta.towns || [], i;
      var STYLE = { city: [colors.labelCity, 14, 1e12, true], town: [colors.labelTown, 12, S.L * 3, false], airport: [colors.labelAirport, 12, S.L * 3, false],
        peak: [colors.labelPeak, 13, 1e12, true], beach: [colors.labelBeach, 11, S.L * 1.6, false], port: [colors.labelPort, 11, S.L * 1.6, false] };
      for (i = 0; i < towns.length; i++) {
        var tw = towns[i], w = geo.toWorld(tw.lat, tw.lon), st = STYLE[tw.kind] || STYLE.town;
        if (w.x < 0 || w.z < 0 || w.x > geo.worldW || w.z > geo.worldH) continue;
        var pre = tw.kind === 'peak' ? '▲ ' : (tw.kind === 'airport' ? '✈ ' : '');
        items.push({ x: w.x, y: Math.max(surfaceH(w.x, w.z), 0) + 3, z: w.z, text: pre + t(tw.name), color: st[0], size: st[1], maxDist: st[2], bold: st[3], pin: true });
      }
      var gc = S.gridCenter;
      items.push({ x: gc.x, y: S.cellH[(N >> 1) * N + (N >> 1)] + 40, z: gc.z, text: t('Ciudad RAMI'), color: colors.cityLabel, size: 15, maxDist: 1e12, bold: true, pin: false });
      S.towns = new LabelSet(viewportUniform); S.towns.set(items); scene.add(S.towns.mesh);
      // Cámara inicial: vista de la ciudad
      var tg = gc.clone(); tg.y = S.cellH[(N >> 1) * N + (N >> 1)];
      cam.cur.target.copy(tg); cam.goal.target.copy(tg);
      cam.cur.radius = cam.goal.radius = N * CELL * 1.5; cam.cur.phi = cam.goal.phi = 0.78; cam.cur.theta = cam.goal.theta = 0.55;
      cam.maxR = S.L * 4;
      S.ready = true;
      if (pending) { applyCity(pending); pending = null; }
      else if (S.city) applyCity(S.city);
      refreshSelection();
      resize();
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
      return loadBinary(opts.heightUrl || '/geo/tenerife.hgt.png').then(function (buf) { return decodePngGray(buf); }).then(function (img) {
        return [normalizeMeta(meta, img), img];
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
    var _pos = new THREE.Vector3();
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
        var sp = c.radius * 0.9 * dt, mv = { x: 0, y: 0 };
        if (keys.arrowup || keys.w) mv.y -= 1; if (keys.arrowdown || keys.s) mv.y += 1;
        if (keys.arrowleft || keys.a) mv.x -= 1; if (keys.arrowright || keys.d) mv.x += 1;
        if (mv.x || mv.y) panBy(mv.x * sp / (c.radius * 0.0016), mv.y * sp / (c.radius * 0.0016));
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
      camera.near = clamp(c.radius * 0.002, 1.5, 2000); camera.far = Math.max(c.radius * 8, S.L * 8);
      camera.updateProjectionMatrix();
    }
    function frame(now) {
      S.raf = 0;
      if (S.disposed) return;
      var dt = Math.min(0.1, (now - S.lastT) / 1000) || 0.016; S.lastT = now;
      if (dt > 0) S.fps = S.fps * 0.9 + (1 / dt) * 0.1;
      if (S.ready) {
        updateCamera(dt);
        var dist = camera.position.distanceTo(cam.cur.target);
        scene.fog.near = dist + S.L * 0.15; scene.fog.far = dist + S.L * 1.6;
        S.sky.position.copy(camera.position);
        S.sea.material.uniforms.uTime.value = now / 1000;
        var far = camera.position.distanceTo(S.center) > S.L * 2.5;
        S.fine.mesh.visible = !far; S.coarse.mesh.visible = far;
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
    var xrSessionRef = null;
    function xrSupported() {
      if (!global.navigator || !navigator.xr || !navigator.xr.isSessionSupported) return Promise.resolve(false);
      return navigator.xr.isSessionSupported('immersive-vr').then(function (v) { return !!v; }, function () { return false; });
    }
    function enterVR() {
      if (!navigator.xr) return Promise.reject(new Error('WebXR no disponible'));
      var floor = true;
      return navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] }).then(function (session) {
        xrSessionRef = session;
        renderer.xr.enabled = true;
        try { renderer.xr.setReferenceSpaceType('local-floor'); } catch (e) { floor = false; }
        return renderer.xr.setSession(session).then(function () { return session; });
      }).then(function (session) {
        // Coloca al visitante a altura humana en la parcela seleccionada (o el centro)
        var cell = S.sel || { x: N >> 1, y: N >> 1 }, w = cellWorld(cell.x, cell.y);
        rig.position.set(w.x, w.y + 0.5 + (floor ? 0 : 1.6), w.z + CELL * 0.35);
        rig.rotation.set(0, 0, 0);
        S.xr = true; syncLoop();
        renderer.setAnimationLoop(function (now) {
          S.sea.material.uniforms.uTime.value = now / 1000; S.sky.position.copy(rig.position);
          renderer.render(scene, camera); S.frame++;
        });
        session.addEventListener('end', function () {
          renderer.setAnimationLoop(null);
          renderer.xr.enabled = false; xrSessionRef = null;
          rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
          camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
          S.xr = false; syncLoop();
        });
      });
    }

    // --- API pública ---------------------------------------------------------------------
    var handle = {
      ready: ready,
      setCity: function (data) {
        if (!data || !data.parcels) return;
        var h = fnv1a(JSON.stringify(data));
        if (h === S.cityHash) return;
        S.cityHash = h; S.city = data;
        if (data.size && data.size !== N) console.warn('city3d: el tamaño de la ciudad (' + data.size + ') no coincide con gridSize (' + N + ')');
        if (S.ready) applyCity(data); else pending = data;
      },
      select: function (x, y) { doSelect((x === null || x === undefined) ? null : { x: x | 0, y: y | 0 }, false); },
      flyTo: flyTo, flyToIsland: flyToIsland, flyToCity: flyToCity,
      resize: resize,
      setVisible: function (v) { S.visible = !!v; syncLoop(); },
      xrSupported: xrSupported, enterVR: enterVR,
      stats: function () { return { fps: Math.round(S.fps), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frame: S.frame }; },
      /** Utilidades (pruebas / integración) */
      cellWorld: function (x, y) { return S.ready ? cellWorld(x, y) : null; },
      project: function (x, y) {
        if (!S.ready) return null;
        var v = cellWorld(x, y).project(camera), r = canvas.getBoundingClientRect();
        return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, visible: v.z < 1 };
      },
      heightAt: function (lat, lon) { if (!S.ready) return null; var w = S.geo.toWorld(lat, lon); return S.field.atWorld(w.x, w.z); },
      dispose: function () {
        if (S.disposed) return;
        S.disposed = true; syncLoop();
        if (xrSessionRef) { try { xrSessionRef.end(); } catch (e) {} }
        canvas.removeEventListener('pointerdown', L.pointerdown); canvas.removeEventListener('pointermove', L.pointermove);
        canvas.removeEventListener('pointerup', L.pointerup); canvas.removeEventListener('pointercancel', L.pointerup);
        canvas.removeEventListener('pointerleave', L.pointerleave); canvas.removeEventListener('dblclick', L.dblclick);
        canvas.removeEventListener('wheel', L.wheel); canvas.removeEventListener('contextmenu', L.contextmenu);
        canvas.removeEventListener('keydown', L.keydown); canvas.removeEventListener('keyup', L.keyup);
        document.removeEventListener('visibilitychange', L.visibility); global.removeEventListener('resize', L.resize);
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
        if (C.selLabel) C.selLabel.dispose();
        renderer.dispose();
        try { renderer.forceContextLoss(); } catch (e2) {}
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
      _debug: { scene: scene, camera: camera, renderer: renderer, state: S, meshes: C }
    };
    return handle;
  }

  global.RamiCity3D = { mount: mount, version: '1.0.0', _internals: { inflate: inflate, decodePngGray: decodePngGray, fnv1a: fnv1a } };
})(typeof window !== 'undefined' ? window : this);
