#!/usr/bin/env python3
"""
build_tenerife.py - construye el dataset de terreno ABIERTO de Tenerife para el
monedero RAMI-Chain (crate `rami-gui`).

Sólo usa la biblioteca estándar de Python 3 (urllib, zlib, struct, json, math):
decodifica y codifica PNG a mano (filtros 0-4, sin entrelazado).

Fuentes (todas abiertas; ver README.md de esta carpeta):
  * Elevación: Mapzen/AWS Terrain Tiles, formato "terrarium", zoom 12.
      https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/{x}/{y}.png
      h = R*256 + G + B/256 - 32768   (metros)
      A zoom >= 11 el océano viene enmascarado a 0 m exactos; la batimetría
      (ETOPO1) sólo está en zoom <= 10, así que además se bajan las teselas de
      zoom 10 y se rellena con ellas (interpolación bilineal, limitada a <= 0)
      todo píxel que en zoom 12 valga exactamente 0.
  * Carreteras: Natural Earth 1:10m roads (dominio público).
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson

Salidas (contrato GEO, ver docstring de `write_outputs`):
  chain/crates/rami-gui/src/geo/tenerife.hgt.png   PNG gris 16 bit, v = clamp(round(h)+1000, 0, 65535)
  chain/crates/rami-gui/src/geo/tenerife.json      metadatos (origen, escala, pueblos, carreteras...)
  tools/geo/preview.png                            hillshade 8 bit (sólo para inspección)

El script es idempotente: cachea cada tesela y el GeoJSON en tools/geo/cache/ y
puede relanzarse tantas veces como se quiera.

Uso:  python3 tools/geo/build_tenerife.py [--no-preview]
"""

import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
CACHE_DIR = os.path.join(HERE, "cache")
OUT_DIR = os.path.join(REPO, "chain", "crates", "rami-gui", "src", "geo")
OUT_PNG = os.path.join(OUT_DIR, "tenerife.hgt.png")
OUT_JSON = os.path.join(OUT_DIR, "tenerife.json")
OUT_PREVIEW = os.path.join(HERE, "preview.png")
GITIGNORE = os.path.join(REPO, ".gitignore")

ZOOM = 12
BATHY_ZOOM = 10   # último zoom en el que las teselas terrarium traen batimetría
TILE = 256
DOWNSAMPLE = 2
OFFSET = 1000
USER_AGENT = "rami-ledger-geo-builder/1.0 (+https://github.com/rami-ledger)"

BBOX = {"west": -16.95, "south": 27.98, "east": -16.10, "north": 28.62}

TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png"
ROADS_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
             "master/geojson/ne_10m_roads.geojson")

ATTRIBUTION = ("Terrain: Mapzen/AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1 and other "
               "public sources) · Roads: Natural Earth (public domain)")

PEAK = {"name": "Teide", "lat": 28.2724, "lon": -16.6425}

# Lista curada de lugares (nombre, lat, lon, tipo).
TOWNS = [
    ("Santa Cruz de Tenerife", 28.4636, -16.2518, "city"),
    ("San Cristóbal de La Laguna", 28.4853, -16.3200, "city"),
    ("Puerto de la Cruz", 28.4142, -16.5448, "town"),
    ("La Orotava", 28.3908, -16.5231, "town"),
    ("Adeje", 28.1227, -16.7260, "town"),
    ("Arona", 28.0996, -16.6810, "town"),
    ("Los Cristianos", 28.0511, -16.7157, "port"),
    ("Playa de las Américas", 28.0625, -16.7284, "beach"),
    ("Granadilla de Abona", 28.1189, -16.5750, "town"),
    ("El Médano", 28.0450, -16.5364, "beach"),
    ("Candelaria", 28.3550, -16.3717, "town"),
    ("Güímar", 28.3125, -16.4115, "town"),
    ("Icod de los Vinos", 28.3670, -16.7113, "town"),
    ("Garachico", 28.3730, -16.7640, "town"),
    ("Los Realejos", 28.3820, -16.5850, "town"),
    ("Tacoronte", 28.4780, -16.4110, "town"),
    ("Santiago del Teide", 28.2970, -16.8150, "town"),
    ("Los Gigantes", 28.2450, -16.8410, "port"),
    ("Aeropuerto Tenerife Sur", 28.0445, -16.5725, "airport"),
    ("Aeropuerto Tenerife Norte", 28.4827, -16.3415, "airport"),
    ("Teide", 28.2724, -16.6425, "peak"),
    ("Punta de Teno", 28.3425, -16.9210, "beach"),
    ("Anaga (Taganana)", 28.5610, -16.2160, "town"),
    ("Vilaflor", 28.1560, -16.6360, "town"),
    ("Buenavista del Norte", 28.3710, -16.8520, "town"),
]


# ---------------------------------------------------------------------------
# Proyección Web-Mercator (píxeles de tesela a zoom Z, teselas de 256 px)
# ---------------------------------------------------------------------------
def lonlat_to_px(lon, lat, zoom=ZOOM):
    """Devuelve (x, y) en píxeles globales de tesela a `zoom` (antes del downsample)."""
    n = (1 << zoom) * TILE
    x = (lon + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n
    return x, y


def px_to_lonlat(x, y, zoom=ZOOM):
    n = (1 << zoom) * TILE
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    return lon, lat


def meters_per_pixel(lat, zoom=ZOOM, downsample=DOWNSAMPLE):
    return 156543.03392 * math.cos(math.radians(lat)) / (1 << zoom) * downsample


# ---------------------------------------------------------------------------
# Descarga con caché y reintentos
# ---------------------------------------------------------------------------
def fetch(url, cache_path, retries=3, timeout=60):
    """Descarga `url` a `cache_path` (si no existe ya) con hasta `retries` intentos."""
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        with open(cache_path, "rb") as f:
            return f.read()
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            tmp = cache_path + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, cache_path)
            return data
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last = e
            print("  aviso: intento %d/%d fallido para %s: %s" % (attempt, retries, url, e))
            time.sleep(1.5 * attempt)
    raise RuntimeError("no se pudo descargar %s: %s" % (url, last))


# ---------------------------------------------------------------------------
# Decodificador PNG (sólo lo necesario: 8 bits, no entrelazado, filtros 0-4)
# ---------------------------------------------------------------------------
def _paeth(a, b, c):
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter(ftype, cur, prev, bpp):
    """Deshace el filtro PNG `ftype` de una fila (`cur` bytearray, se modifica in-situ)."""
    n = len(cur)
    if ftype == 0:
        return cur
    if ftype == 1:  # Sub
        for i in range(bpp, n):
            cur[i] = (cur[i] + cur[i - bpp]) & 0xFF
    elif ftype == 2:  # Up
        for i in range(n):
            cur[i] = (cur[i] + prev[i]) & 0xFF
    elif ftype == 3:  # Average
        for i in range(n):
            a = cur[i - bpp] if i >= bpp else 0
            cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xFF
    elif ftype == 4:  # Paeth
        for i in range(n):
            a = cur[i - bpp] if i >= bpp else 0
            c = prev[i - bpp] if i >= bpp else 0
            cur[i] = (cur[i] + _paeth(a, prev[i], c)) & 0xFF
    else:
        raise ValueError("filtro PNG desconocido: %d" % ftype)
    return cur


def decode_png(data):
    """Devuelve (width, height, channels, bitdepth, rows) con rows = lista de bytes por fila."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("no es un PNG")
    pos = 8
    width = height = None
    idat = []
    bitdepth = ctype = None
    while pos < len(data):
        length, = struct.unpack(">I", data[pos:pos + 4])
        ctag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctag == b"IHDR":
            width, height, bitdepth, ctype, comp, filt, interlace = struct.unpack(">IIBBBBB", body)
            if interlace != 0:
                raise ValueError("PNG entrelazado no soportado")
            if bitdepth not in (8, 16):
                raise ValueError("profundidad de bit no soportada: %d" % bitdepth)
        elif ctag == b"PLTE":
            raise ValueError("PNG con paleta no soportado")
        elif ctag == b"IDAT":
            idat.append(body)
        elif ctag == b"IEND":
            break
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    bpp = max(1, channels * bitdepth // 8)
    stride = width * channels * bitdepth // 8
    raw = zlib.decompress(b"".join(idat))
    rows = []
    prev = bytearray(stride)
    p = 0
    for _ in range(height):
        ftype = raw[p]
        cur = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        _unfilter(ftype, cur, prev, bpp)
        rows.append(bytes(cur))
        prev = cur
    return width, height, channels, bitdepth, rows


# ---------------------------------------------------------------------------
# Codificador PNG (gris 8/16 bit, filtros 0 y Paeth elegidos por fila)
# ---------------------------------------------------------------------------
def _chunk(tag, body):
    return (struct.pack(">I", len(body)) + tag + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))


def _filter_paeth(cur, prev, bpp):
    out = bytearray(len(cur))
    for i in range(len(cur)):
        a = cur[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        out[i] = (cur[i] - _paeth(a, b, c)) & 0xFF
    return out


def _filter_up(cur, prev):
    return bytearray((cur[i] - prev[i]) & 0xFF for i in range(len(cur)))


def encode_png_gray(width, height, rows, bitdepth):
    """`rows`: lista de bytes (fila ya empaquetada, big-endian si 16 bit). Elige por fila
    entre filtro 0 (None), 2 (Up) y 4 (Paeth) con la heurística de suma de |residuos|."""
    bpp = bitdepth // 8
    stride = width * bpp
    out = bytearray()
    prev = bytes(stride)
    for cur in rows:
        assert len(cur) == stride
        cands = [(0, cur), (2, _filter_up(cur, prev)), (4, _filter_paeth(cur, prev, bpp))]
        best = None
        best_cost = None
        for ftype, fr in cands:
            cost = sum(v if v < 128 else 256 - v for v in fr)
            if best_cost is None or cost < best_cost:
                best_cost = cost
                best = (ftype, fr)
        out.append(best[0])
        out += best[1]
        prev = cur
    ihdr = struct.pack(">IIBBBBB", width, height, bitdepth, 0, 0, 0, 0)
    comp = zlib.compress(bytes(out), 9)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", comp) + _chunk(b"IEND", b""))


# ---------------------------------------------------------------------------
# Terreno
# ---------------------------------------------------------------------------
def terrarium_tile_heights(png_bytes):
    """Decodifica una tesela terrarium y devuelve lista de 256 filas de 256 floats (metros)."""
    w, h, ch, bd, rows = decode_png(png_bytes)
    if (w, h) != (TILE, TILE) or bd != 8 or ch < 3:
        raise ValueError("tesela inesperada %dx%d ch=%d bd=%d" % (w, h, ch, bd))
    out = []
    for r in rows:
        line = [0.0] * TILE
        for x in range(TILE):
            i = x * ch
            line[x] = r[i] * 256.0 + r[i + 1] + r[i + 2] / 256.0 - 32768.0
        out.append(line)
    return out


def build_mosaic():
    """Descarga las teselas que cubren BBOX y devuelve (heights, origin_px) ya recortado
    a la bbox (en resolución nativa de zoom 12)."""
    x0f, y0f = lonlat_to_px(BBOX["west"], BBOX["north"])
    x1f, y1f = lonlat_to_px(BBOX["east"], BBOX["south"])
    # recorte en píxeles enteros; lo redondeamos a múltiplo de DOWNSAMPLE
    px0, py0 = int(math.floor(x0f)), int(math.floor(y0f))
    px1, py1 = int(math.ceil(x1f)), int(math.ceil(y1f))
    W = (px1 - px0) // DOWNSAMPLE * DOWNSAMPLE
    H = (py1 - py0) // DOWNSAMPLE * DOWNSAMPLE
    px1, py1 = px0 + W, py0 + H
    tx0, tx1 = px0 // TILE, (px1 - 1) // TILE
    ty0, ty1 = py0 // TILE, (py1 - 1) // TILE
    ntiles = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    print("Recorte: px [%d..%d) x [%d..%d) -> %dx%d ; teselas x %d..%d y %d..%d (%d)"
          % (px0, px1, py0, py1, W, H, tx0, tx1, ty0, ty1, ntiles))

    heights = [[0.0] * W for _ in range(H)]
    done = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            url = TERRAIN_URL % (ZOOM, tx, ty)
            cache = os.path.join(CACHE_DIR, "terrarium", str(ZOOM), str(tx), "%d.png" % ty)
            tile = terrarium_tile_heights(fetch(url, cache))
            # intersección de la tesela con el recorte
            ox, oy = tx * TILE, ty * TILE
            cx0, cx1 = max(px0, ox), min(px1, ox + TILE)
            cy0, cy1 = max(py0, oy), min(py1, oy + TILE)
            for gy in range(cy0, cy1):
                src = tile[gy - oy]
                dst = heights[gy - py0]
                dst[cx0 - px0:cx1 - px0] = src[cx0 - ox:cx1 - ox]
            done += 1
            if done % 10 == 0 or done == ntiles:
                print("  teselas %d/%d" % (done, ntiles))
    filled = fill_ocean_from_bathymetry(heights, (px0, py0))
    print("  píxeles de océano enmascarado rellenados con batimetría z%d: %d" % (BATHY_ZOOM, filled))
    return heights, (px0, py0)


def fill_ocean_from_bathymetry(heights, origin_px):
    """Las teselas terrarium de zoom >= 11 enmascaran el mar a 0.0 m exactos. Descarga
    las teselas de BATHY_ZOOM (que sí incluyen ETOPO1) que cubren el recorte, las
    interpola bilinealmente a la rejilla de ZOOM y sustituye cada píxel que valga
    exactamente 0.0 por min(batimetría, 0). Nunca añade tierra (h > 0)."""
    H, W = len(heights), len(heights[0])
    px0, py0 = origin_px
    f = 1 << (ZOOM - BATHY_ZOOM)                      # factor de escala (4)
    # rango de teselas de zoom BATHY_ZOOM (con 1 px de margen para la interpolación)
    bx0, by0 = (px0 - f) // (TILE * f), (py0 - f) // (TILE * f)
    bx1, by1 = (px0 + W + f) // (TILE * f), (py0 + H + f) // (TILE * f)
    BW, BH = (bx1 - bx0 + 1) * TILE, (by1 - by0 + 1) * TILE
    bathy = [[0.0] * BW for _ in range(BH)]
    for ty in range(by0, by1 + 1):
        for tx in range(bx0, bx1 + 1):
            url = TERRAIN_URL % (BATHY_ZOOM, tx, ty)
            cache = os.path.join(CACHE_DIR, "terrarium", str(BATHY_ZOOM), str(tx), "%d.png" % ty)
            tile = terrarium_tile_heights(fetch(url, cache))
            for r in range(TILE):
                dst = bathy[(ty - by0) * TILE + r]
                dst[(tx - bx0) * TILE:(tx - bx0 + 1) * TILE] = tile[r]
    ox, oy = bx0 * TILE, by0 * TILE                    # origen del mosaico grueso (px z10)
    # índices/pesos horizontales precalculados (centro del píxel fino -> coord gruesa)
    xs = []
    for x in range(W):
        u = (px0 + x + 0.5) / f - 0.5 - ox
        i = int(math.floor(u))
        i = max(0, min(BW - 2, i))
        xs.append((i, u - i))
    filled = 0
    for y in range(H):
        row = heights[y]
        v = (py0 + y + 0.5) / f - 0.5 - oy
        j = max(0, min(BH - 2, int(math.floor(v))))
        fy = v - j
        r0, r1 = bathy[j], bathy[j + 1]
        for x in range(W):
            if row[x] != 0.0:
                continue
            i, fx = xs[x]
            b = ((r0[i] * (1 - fx) + r0[i + 1] * fx) * (1 - fy)
                 + (r1[i] * (1 - fx) + r1[i + 1] * fx) * fy)
            row[x] = min(b, 0.0)
            filled += 1
    return filled


def downsample_box(heights, k):
    H, W = len(heights), len(heights[0])
    h2, w2 = H // k, W // k
    inv = 1.0 / (k * k)
    out = []
    for y in range(h2):
        rows = heights[y * k:(y + 1) * k]
        line = [0.0] * w2
        for x in range(w2):
            s = 0.0
            for r in rows:
                s += sum(r[x * k:(x + 1) * k])
            line[x] = s * inv
        out.append(line)
    return out


def hillshade(heights, mpp, az_deg=315.0, alt_deg=45.0):
    """Hillshade estándar (Horn) -> filas de bytes 8 bit. El mar se pinta gris plano."""
    H, W = len(heights), len(heights[0])
    az = math.radians(az_deg)
    alt = math.radians(alt_deg)
    rows = []
    for y in range(H):
        ym, yp = max(0, y - 1), min(H - 1, y + 1)
        line = bytearray(W)
        for x in range(W):
            xm, xp = max(0, x - 1), min(W - 1, x + 1)
            if heights[y][x] <= 0:
                line[x] = 60
                continue
            dzdx = (heights[y][xp] - heights[y][xm]) / (2.0 * mpp)
            dzdy = (heights[yp][x] - heights[ym][x]) / (2.0 * mpp)
            slope = math.atan(math.hypot(dzdx, dzdy))
            aspect = math.atan2(dzdy, -dzdx)
            v = (math.sin(alt) * math.cos(slope)
                 + math.cos(alt) * math.sin(slope) * math.cos(az - math.pi / 2 - aspect))
            line[x] = max(0, min(255, int(round(255 * max(0.0, v)))))
        rows.append(bytes(line))
    return rows


# ---------------------------------------------------------------------------
# Carreteras (Natural Earth)
# ---------------------------------------------------------------------------
def _bbox_intersects_line(coords):
    w, s, e, n = BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]
    return any(w <= lon <= e and s <= lat <= n for lon, lat in coords)


def load_roads():
    data = fetch(ROADS_URL, os.path.join(CACHE_DIR, "ne_10m_roads.geojson"))
    gj = json.loads(data.decode("utf-8"))
    roads = []
    for feat in gj.get("features", []):
        geom = feat.get("geometry") or {}
        t = geom.get("type")
        if t == "LineString":
            lines = [geom["coordinates"]]
        elif t == "MultiLineString":
            lines = geom["coordinates"]
        else:
            continue
        for line in lines:
            pts = [[round(float(p[0]), 5), round(float(p[1]), 5)] for p in line]
            if _bbox_intersects_line(pts):
                roads.append(pts)
    return roads


# ---------------------------------------------------------------------------
# Salidas
# ---------------------------------------------------------------------------
def ensure_gitignore():
    line = "tools/geo/cache/"
    try:
        with open(GITIGNORE, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        content = ""
    if line in content.splitlines():
        return
    with open(GITIGNORE, "a", encoding="utf-8") as f:
        if content and not content.endswith("\n"):
            f.write("\n")
        f.write("# caché de teselas de elevación / GeoJSON del builder de terreno (tools/geo)\n")
        f.write(line + "\n")
    print("Añadido %s a .gitignore" % line)


def write_outputs(heights, origin_px, roads, make_preview=True):
    H, W = len(heights), len(heights[0])
    min_h = min(min(r) for r in heights)
    max_h = max(max(r) for r in heights)
    rows = []
    for r in heights:
        vals = [max(0, min(65535, int(round(h)) + OFFSET)) for h in r]
        rows.append(struct.pack(">%dH" % W, *vals))
    png = encode_png_gray(W, H, rows, 16)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PNG, "wb") as f:
        f.write(png)

    # medimos el pico del Teide con lo que hay en el dataset
    px, py = lonlat_to_px(PEAK["lon"], PEAK["lat"])
    X = (px - origin_px[0]) / DOWNSAMPLE
    Y = (py - origin_px[1]) / DOWNSAMPLE
    peak_h = heights[int(Y)][int(X)]

    center_lat = (BBOX["north"] + BBOX["south"]) / 2.0
    meta = {
        "name": "Tenerife",
        "attribution": ATTRIBUTION,
        "zoom": ZOOM,
        "downsample": DOWNSAMPLE,
        "width": W,
        "height": H,
        "origin_px": {"x": float(origin_px[0]), "y": float(origin_px[1])},
        "meters_per_pixel": round(meters_per_pixel(center_lat), 4),
        "offset": OFFSET,
        "min_h": round(min_h, 2),
        "max_h": round(max_h, 2),
        "bbox": dict(BBOX),
        "peak": {"name": PEAK["name"], "lat": PEAK["lat"], "lon": PEAK["lon"],
                 "h": round(peak_h, 1)},
        "towns": [{"name": n, "lat": la, "lon": lo, "kind": k} for (n, la, lo, k) in TOWNS],
        "roads": roads,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
        f.write("\n")

    if make_preview:
        shade = hillshade(heights, meta["meters_per_pixel"])
        with open(OUT_PREVIEW, "wb") as f:
            f.write(encode_png_gray(W, H, shade, 8))
    return meta


# ---------------------------------------------------------------------------
# Verificación
# ---------------------------------------------------------------------------
def sample(heights, meta, lon, lat):
    px, py = lonlat_to_px(lon, lat)
    X = (px - meta["origin_px"]["x"]) / meta["downsample"]
    Y = (py - meta["origin_px"]["y"]) / meta["downsample"]
    return X, Y, heights[int(Y)][int(X)]


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def verify(heights, meta):
    ok = True
    H, W = len(heights), len(heights[0])
    # máximo
    best = (-1e9, 0, 0)
    for y in range(H):
        r = heights[y]
        m = max(r)
        if m > best[0]:
            best = (m, r.index(m), y)
    mh, mx, my = best
    lon, lat = px_to_lonlat(meta["origin_px"]["x"] + (mx + 0.5) * meta["downsample"],
                            meta["origin_px"]["y"] + (my + 0.5) * meta["downsample"])
    d = haversine_km(lat, lon, PEAK["lat"], PEAK["lon"])
    c1 = 3600 <= mh <= 3760 and d <= 1.5
    ok &= c1
    print("VERIFICACION")
    print("  max h = %.1f m en px (%d,%d) lat=%.4f lon=%.4f ; a %.2f km del Teide  [%s]"
          % (mh, mx, my, lat, lon, d, "OK" if c1 else "FALLO"))
    Xs, Ys, hs = sample(heights, meta, -16.2518, 28.4636)
    c2 = 0 < hs < 150
    ok &= c2
    print("  Santa Cruz (28.4636,-16.2518): px (%.1f,%.1f) h=%.1f m  [%s]" % (Xs, Ys, hs, "OK" if c2 else "FALLO"))
    Xo, Yo, ho = sample(heights, meta, -16.20, 28.00)
    c3 = ho < 0
    ok &= c3
    print("  mar abierto (28.00,-16.20): px (%.1f,%.1f) h=%.1f m  [%s]" % (Xo, Yo, ho, "OK" if c3 else "FALLO"))
    Xc, Yc, hc = sample(heights, meta, -16.7157, 28.0511)
    c4 = Xs > Xc and Ys < Yc
    ok &= c4
    print("  Los Cristianos: px (%.1f,%.1f) h=%.1f ; Santa Cruz a la derecha y arriba  [%s]"
          % (Xc, Yc, hc, "OK" if c4 else "FALLO"))
    print("  imagen %dx%d ; min_h=%.1f max_h=%.1f ; m/px=%.3f ; carreteras=%d ; pueblos=%d"
          % (W, H, meta["min_h"], meta["max_h"], meta["meters_per_pixel"],
             len(meta["roads"]), len(meta["towns"])))
    for path in (OUT_PNG, OUT_JSON, OUT_PREVIEW):
        if os.path.exists(path):
            size = os.path.getsize(path)
            print("  %s : %d bytes (%.2f MB)" % (os.path.relpath(path, REPO), size, size / 1e6))
    c5 = os.path.getsize(OUT_PNG) <= 2.5e6
    ok &= c5
    print("  tamaño hgt.png <= 2.5 MB  [%s]" % ("OK" if c5 else "FALLO"))
    # comprobación de ida y vuelta del PNG escrito
    with open(OUT_PNG, "rb") as f:
        w2, h2, ch2, bd2, rows2 = decode_png(f.read())
    v = struct.unpack(">H", rows2[my][mx * 2:mx * 2 + 2])[0]
    c6 = (w2, h2, ch2, bd2) == (W, H, 1, 16) and abs((v - OFFSET) - mh) <= 0.5
    ok &= c6
    print("  relectura PNG: %dx%d ch=%d bd=%d, v(pico)=%d -> %.0f m  [%s]"
          % (w2, h2, ch2, bd2, v, v - OFFSET, "OK" if c6 else "FALLO"))
    print("RESULTADO: %s" % ("TODO OK" if ok else "HAY FALLOS"))
    return ok


def main(argv):
    make_preview = "--no-preview" not in argv
    ensure_gitignore()
    t0 = time.time()
    heights, origin = build_mosaic()
    print("Mosaico nativo %dx%d en %.1fs" % (len(heights[0]), len(heights), time.time() - t0))
    heights = downsample_box(heights, DOWNSAMPLE)
    print("Downsample x%d -> %dx%d" % (DOWNSAMPLE, len(heights[0]), len(heights)))
    roads = load_roads()
    print("Carreteras Natural Earth dentro de la bbox: %d" % len(roads))
    meta = write_outputs(heights, origin, roads, make_preview)
    print("Escrito %s y %s (%.1fs)" % (os.path.relpath(OUT_PNG, REPO),
                                       os.path.relpath(OUT_JSON, REPO), time.time() - t0))
    return 0 if verify(heights, meta) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
