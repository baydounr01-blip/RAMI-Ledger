#!/usr/bin/env python3
"""
build_dubai.py - construye el dataset de terreno ABIERTO de Dubái para el
monedero RAMI-Chain (crate `rami-gui`).

Sólo usa la biblioteca estándar de Python 3 (urllib, zlib, struct, json, math):
decodifica y codifica PNG a mano (filtros 0-4, sin entrelazado).

Fuentes (todas abiertas; ver README.md de esta carpeta):
  * Elevación: Mapzen/AWS Terrain Tiles, formato "terrarium", zoom 12.
      https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/{x}/{y}.png
      h = R*256 + G + B/256 - 32768   (metros)
      A zoom >= 11 el mar viene enmascarado a 0 m exactos; la batimetría
      (ETOPO1) sólo está en zoom <= 10, así que además se bajan las teselas de
      zoom 10 y se rellena con ellas (interpolación bilineal, limitada a <= 0)
      todo píxel que en zoom 12 valga exactamente 0.
  * Carreteras: Natural Earth 1:10m roads (dominio público) + trazados a mano
      de las grandes vías (E11, E311, E44, D94...), ver HAND_ROADS.
      https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson
  * Islas artificiales y canales: SRTM es del año 2000 y NO contiene ninguna de
    las islas ganadas al mar de Dubái (Palm Jumeirah, The World, Bluewaters...)
    ni el Canal de Dubái. Se ESTAMPAN A MANO como polígonos aproximados
    (mesetas de +3 m para las islas, -3 m para los canales) sobre el mosaico
    nativo, después del relleno de batimetría y antes del downsample. No
    proceden de ningún dataset; ver `stamp_features`.

Salidas (contrato GEO, ver docstring de `write_outputs`):
  chain/crates/rami-gui/src/geo/dubai.hgt.png   PNG gris 16 bit, v = clamp(round(h)+1000, 0, 65535)
  chain/crates/rami-gui/src/geo/dubai.json      metadatos (origen, escala, lugares, hitos, carreteras...)
  tools/geo/preview.png                         hillshade 8 bit (sólo para inspección)

Notas del contrato que conviene tener presentes:
  * Con offset = 1000 el PNG NO puede representar profundidades por debajo de
    -1000 m. En el golfo Pérsico frente a Dubái el fondo no baja de ~-100 m, así
    que aquí no se recorta nada; `min_h`/`max_h` del JSON se calculan de todas
    formas sobre los valores YA codificados y describen exactamente el PNG.
  * h == 0 es MAR por diseño (contrato: mar = h <= 0). El relleno de batimetría
    deja en 0 m exactos los píxeles enmascarados en zoom 12 cuyo vecino grueso
    de zoom 10 es tierra (>= 0): una franja fina pegada a la costa. Además, la
    llanura costera de Dubái está a 0-5 m y SRTM (ruido de ±3 m, sabkhas algo
    por debajo del nivel del mar) da a mucha tierra valores de 0 m exactos o
    negativos (-1..-3 m) que por contrato serían mar: sin más, la ciudad quedaría
    salpicada de "charcas" y hasta de "lagos" de varios km² (Meydan, Al Quoz,
    Barsha Heights, Zabeel...). Por eso, antes de estampar, el constructor
    (1) sube a LOW_LAND_H todo píxel de zoom 12 con h < 0 —a ese zoom el mar
    está enmascarado a 0.0 exactos, así que un valor negativo es siempre una
    medida de tierra— (`raise_negative_land`) y (2) tras el relleno de
    batimetría sube a LOW_LAND_H toda componente 8-conexa de h <= 0 que no sea
    el mar abierto (`reclassify_inland_water`). El agua interior de la ciudad
    (Creek, Ras Al Khor, canales, lagos) se excava después a mano. El cliente
    debe seguir usando `h <= 0` como mar.
  * El recorte empieza en (floor(x0), floor(y0)) píxeles nativos de zoom 12 y
    mide width*downsample x height*downsample píxeles nativos, redondeado HACIA
    ARRIBA a múltiplo de `downsample`: cubre la bbox entera con hasta
    `downsample` px nativos de sobra por el este/sur; no coincide exactamente
    con la bbox del JSON.

El script es idempotente: cachea cada tesela y el GeoJSON en tools/geo/cache/ y
puede relanzarse tantas veces como se quiera.

Uso:  python3 tools/geo/build_dubai.py [--no-preview]
"""

import collections
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
OUT_PNG = os.path.join(OUT_DIR, "dubai.hgt.png")
OUT_JSON = os.path.join(OUT_DIR, "dubai.json")
OUT_PREVIEW = os.path.join(HERE, "preview.png")
GITIGNORE = os.path.join(REPO, ".gitignore")

ZOOM = 12
BATHY_ZOOM = 10   # último zoom en el que las teselas terrarium traen batimetría
TILE = 256
DOWNSAMPLE = 2
OFFSET = 1000
USER_AGENT = "rami-ledger-geo-builder/1.0 (+https://github.com/rami-ledger)"

# De Jebel Ali (suroeste) a la frontera con Sharjah (noreste) y ~25 km hacia el interior.
BBOX = {"west": 54.90, "south": 24.78, "east": 55.60, "north": 25.40}

TERRAIN_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png"
ROADS_URL = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
             "master/geojson/ne_10m_roads.geojson")

ATTRIBUTION = ("Terrain: Mapzen/AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1 and other "
               "public sources) · Roads: Natural Earth (public domain)")

# Ya no hay montaña: `peak` pasa a ser el píxel más alto del recorte (alguna duna
# del interior), medido sobre el dataset final.
PEAK_NAME = "Punto más alto del recorte"

# Alturas de las mesetas que se estampan (metros).
ISLAND_H = 3.0       # islas ganadas al mar (sólo sobre píxeles que ahora son mar, h <= 0)
CHANNEL_H = -3.0     # canales y lagunas (sólo donde h >= CHANNEL_H; nunca ahonda el mar)
MIN_HALF_PX = 0.75   # semianchura mínima de una franja, en px nativos, para que no quede rota
LOW_LAND_H = 1.0     # altura que se da a la tierra baja que SRTM deja en h <= 0 (raise_negative_land, reclassify_inland_water)

# Cuadrícula de parcelas del cliente 3D: 64x64 celdas de 650 m, eje x a lo largo
# de la costa hacia el noreste y eje y hacia el interior. Se copia tal cual.
GRID = {"anchor": {"lat": 25.064, "lon": 54.994}, "cellMeters": 650, "rotationDeg": -48, "size": 64}

# Lista curada de lugares (nombre, lat, lon, tipo). Tipos permitidos: city,
# district, airport, port, beach, island, landmark, peak.
TOWNS = [
    ("Dubái centro", 25.197, 55.274, "city"),
    ("Deira", 25.270, 55.312, "city"),
    ("Bur Dubái", 25.256, 55.298, "district"),
    ("Dubai Marina", 25.080, 55.140, "district"),
    ("JBR", 25.078, 55.133, "beach"),
    ("JLT", 25.071, 55.145, "district"),
    ("Palm Jumeirah", 25.112, 55.138, "island"),
    ("Bluewaters", 25.079, 55.121, "island"),
    ("The World", 25.223, 55.170, "island"),
    ("Deira Islands", 25.297, 55.308, "island"),
    ("Jumeirah", 25.205, 55.240, "district"),
    ("Umm Suqeim", 25.155, 55.205, "district"),
    ("Al Barsha", 25.112, 55.195, "district"),
    ("Al Quoz", 25.135, 55.230, "district"),
    ("Al Sufouh / Internet City", 25.098, 55.160, "district"),
    ("Business Bay", 25.185, 55.265, "district"),
    ("DIFC", 25.211, 55.280, "district"),
    ("Zabeel", 25.226, 55.304, "district"),
    ("Karama", 25.245, 55.305, "district"),
    ("Satwa", 25.228, 55.275, "district"),
    ("Dubai Hills", 25.110, 55.245, "district"),
    ("Dubai Creek Harbour", 25.205, 55.345, "district"),
    ("Festival City", 25.221, 55.352, "district"),
    ("Al Jaddaf", 25.220, 55.330, "district"),
    ("Meydan", 25.158, 55.302, "district"),
    ("Nad Al Sheba", 25.165, 55.330, "district"),
    ("Dubai Design District", 25.187, 55.295, "district"),
    ("Silicon Oasis", 25.120, 55.380, "district"),
    ("Academic City", 25.120, 55.410, "district"),
    ("International City", 25.165, 55.405, "district"),
    ("Mirdif", 25.222, 55.420, "district"),
    ("Dubailand", 25.080, 55.280, "district"),
    ("Global Village", 25.069, 55.307, "landmark"),
    ("Motor City", 25.047, 55.238, "district"),
    ("Sports City", 25.040, 55.220, "district"),
    ("Arabian Ranches", 25.055, 55.270, "district"),
    ("Al Furjan", 25.030, 55.150, "district"),
    ("Discovery Gardens", 25.040, 55.145, "district"),
    ("Dubai Investments Park", 25.000, 55.170, "district"),
    ("Jebel Ali Free Zone", 24.985, 55.115, "district"),
    ("Puerto de Jebel Ali", 25.011, 55.060, "port"),
    ("Expo City", 24.965, 55.152, "district"),
    ("Al Qudra", 24.980, 55.300, "district"),
    ("Aeropuerto DXB", 25.2528, 55.3644, "airport"),
    ("Aeropuerto Al Maktoum DWC", 24.886, 55.161, "airport"),
    ("Port Rashid", 25.265, 55.275, "port"),
    ("Dubai Harbour", 25.091, 55.135, "port"),
    ("Kite Beach", 25.174, 55.217, "beach"),
    ("La Mer", 25.232, 55.260, "beach"),
    ("Zoco del Oro", 25.2713, 55.2977, "landmark"),
    ("Al Fahidi", 25.2637, 55.2986, "landmark"),
    ("Ras Al Khor", 25.188, 55.330, "landmark"),
]

# Hitos que el cliente 3D modela uno a uno:
# (id, nombre, lat, lon, forma, alto, ancho, fondo, rotación horaria desde el norte).
# Los identificadores de forma los consume el cliente; no cambiarlos.
LANDMARKS = [
    ("burj_khalifa", "Burj Khalifa", 25.1972, 55.2744, "burj_khalifa", 828, 150, 150, 0),
    ("dubai_mall", "Dubai Mall", 25.1975, 55.2796, "mall", 40, 700, 450, 0),
    ("address_downtown", "Address Downtown", 25.1946, 55.2764, "tower", 302, 60, 60, 0),
    ("dubai_opera", "Dubai Opera", 25.1938, 55.2717, "dhow", 45, 200, 90, 60),
    ("address_skyview", "Address Sky View", 25.1960, 55.2790, "twin_bridge", 260, 120, 50, 0),
    ("jw_marriott_marquis", "JW Marriott Marquis", 25.1860, 55.2586, "twin", 355, 120, 60, 0),
    ("emirates_towers", "Emirates Towers", 25.2176, 55.2822, "twin_prism", 355, 160, 80, 42),
    ("museum_future", "Museo del Futuro", 25.2191, 55.2814, "torus", 77, 70, 30, 42),
    ("difc_gate", "The Gate (DIFC)", 25.2114, 55.2800, "gate", 100, 120, 60, 42),
    ("one_zaabeel", "One Za'abeel", 25.2255, 55.2966, "link", 305, 230, 60, 42),
    ("wtc", "Dubai World Trade Centre", 25.2251, 55.2872, "tower", 149, 45, 45, 0),
    ("rose_rayhaan", "Rose Rayhaan", 25.2220, 55.2810, "tower", 333, 40, 40, 0),
    ("burj_al_salam", "Burj Al Salam", 25.2224, 55.2843, "tower", 252, 50, 50, 0),
    ("dubai_frame", "Dubai Frame", 25.2355, 55.3003, "frame", 150, 93, 20, 42),
    ("wafi", "Wafi", 25.2290, 55.3200, "pyramid", 60, 90, 90, 0),
    ("raffles", "Raffles Dubai", 25.2287, 55.3180, "pyramid", 120, 80, 80, 0),
    ("etisalat_deira", "Torre Etisalat", 25.2636, 55.3230, "globe", 160, 40, 40, 0),
    ("deira_clocktower", "Torre del Reloj de Deira", 25.2620, 55.3197, "clock", 30, 12, 12, 0),
    ("gold_souk", "Zoco del Oro", 25.2713, 55.2977, "souk", 10, 220, 90, 30),
    ("al_fahidi_fort", "Fuerte Al Fahidi", 25.2633, 55.2972, "fort", 15, 60, 60, 0),
    ("al_fahidi_windtowers", "Al Fahidi (torres de viento)", 25.2637, 55.2986, "windtowers", 14, 200, 150, 0),
    ("jumeirah_mosque", "Mezquita de Jumeirah", 25.2340, 55.2656, "mosque", 40, 70, 60, 0),
    ("etihad_museum", "Museo Etihad", 25.2404, 55.2745, "pavilion", 20, 120, 80, 0),
    ("zabeel_palace", "Palacio de Zabeel", 25.2260, 55.3040, "palace", 25, 200, 160, 0),
    ("burj_al_arab", "Burj Al Arab", 25.1412, 55.1853, "sail", 321, 100, 80, 15),
    ("jumeirah_beach_hotel", "Jumeirah Beach Hotel", 25.1414, 55.1915, "wave", 93, 280, 60, 45),
    ("madinat_jumeirah", "Madinat Jumeirah", 25.1330, 55.1850, "windtowers", 20, 500, 400, 0),
    ("mall_emirates", "Mall of the Emirates", 25.1181, 55.2004, "mall", 30, 600, 400, 42),
    ("ski_dubai", "Ski Dubai", 25.1175, 55.1975, "ski", 85, 400, 80, 42),
    ("atlantis", "Atlantis The Palm", 25.1304, 55.1171, "arch", 93, 260, 60, 45),
    ("atlantis_royal", "Atlantis The Royal", 25.1366, 55.1165, "blocks", 178, 220, 60, 45),
    ("palm_tower", "Palm Tower", 25.1130, 55.1385, "tower", 240, 50, 50, 0),
    ("ain_dubai", "Ain Dubai", 25.0790, 55.1211, "wheel", 250, 250, 30, 45),
    ("cayan", "Cayan Tower", 25.0861, 55.1436, "twist", 306, 45, 45, 0),
    ("princess_tower", "Princess Tower", 25.0889, 55.1469, "tower", 413, 45, 45, 0),
    ("marina_101", "Marina 101", 25.0914, 55.1480, "tower", 425, 40, 40, 0),
    ("elite_residence", "Elite Residence", 25.0899, 55.1465, "tower", 380, 45, 45, 0),
    ("marina_23", "23 Marina", 25.0873, 55.1460, "tower", 392, 40, 40, 0),
    ("ocean_heights", "Ocean Heights", 25.0865, 55.1445, "twist", 310, 45, 45, 0),
    ("almas", "Almas Tower", 25.0693, 55.1437, "tower", 360, 60, 40, 0),
    ("marina_mall", "Dubai Marina Mall", 25.0768, 55.1399, "mall", 30, 250, 150, 0),
    ("ibn_battuta", "Ibn Battuta Mall", 25.0440, 55.1190, "mall", 25, 900, 250, 42),
    ("meydan", "Hipódromo de Meydan", 25.1580, 55.3020, "grandstand", 60, 1600, 80, 100),
    ("dxb_t3", "Aeropuerto DXB (T3)", 25.2528, 55.3644, "terminal", 30, 1200, 200, 30),
    ("al_wasl", "Cúpula Al Wasl (Expo City)", 24.9650, 55.1520, "dome", 67, 130, 130, 0),
    ("autodrome", "Dubai Autodrome", 25.0470, 55.2380, "track", 12, 1200, 700, 0),
    ("global_village", "Global Village", 25.0690, 55.3070, "village", 15, 800, 600, 0),
    ("miracle_garden", "Miracle Garden", 25.0600, 55.2440, "garden", 6, 400, 300, 0),
    ("festival_city", "Festival City Mall", 25.2210, 55.3520, "mall", 30, 500, 300, 0),
    ("creek_harbour", "Dubai Creek Harbour", 25.2050, 55.3450, "blocks", 200, 300, 200, 0),
    ("jebel_ali_cranes", "Puerto de Jebel Ali (grúas)", 25.0110, 55.0600, "cranes", 80, 2500, 120, 42),
    ("port_rashid", "Port Rashid", 25.2650, 55.2750, "ship", 60, 290, 40, 60),
    ("expo_pavilions", "Expo City", 24.9670, 55.1560, "blocks", 40, 600, 400, 0),
    ("bluewaters_res", "Bluewaters", 25.0800, 55.1200, "blocks", 70, 500, 300, 45),
    ("jumeirah_bay", "Jumeirah Bay (Bulgari)", 25.2130, 55.2430, "blocks", 30, 300, 200, 30),
    ("d3", "Dubai Design District", 25.1870, 55.2950, "blocks", 45, 500, 300, 0),
]

# Skylines genéricos que el cliente instancia por procedimiento:
# (nombre, lat, lon, radio_m, nº edificios, alto mín, alto máx, tipo).
# Tipos: towers (rascacielos esbeltos), blocks (media altura), villas (casas
# bajas), warehouses (naves anchas y planas). La semilla se deriva del nombre.
CLUSTERS = [
    ("Dubai Marina", 25.080, 55.140, 1200, 180, 90, 380, "towers"),
    ("JLT", 25.070, 55.145, 700, 70, 100, 250, "towers"),
    ("JBR", 25.078, 55.133, 500, 40, 120, 200, "towers"),
    ("Emaar Beachfront", 25.088, 55.137, 300, 20, 100, 200, "towers"),
    ("Downtown", 25.196, 55.276, 900, 90, 80, 300, "towers"),
    ("Business Bay", 25.185, 55.265, 1200, 140, 80, 260, "towers"),
    ("DIFC", 25.215, 55.282, 800, 60, 100, 330, "towers"),
    ("Sheikh Zayed Road", 25.205, 55.270, 600, 40, 100, 300, "towers"),
    ("Barsha Heights", 25.097, 55.175, 600, 50, 60, 200, "towers"),
    ("Dubai Creek Harbour", 25.205, 55.345, 700, 30, 100, 300, "towers"),
    ("Al Jaddaf", 25.222, 55.330, 500, 25, 60, 150, "blocks"),
    ("Deira", 25.268, 55.310, 1200, 120, 30, 120, "blocks"),
    ("Bur Dubai", 25.255, 55.300, 900, 90, 25, 100, "blocks"),
    ("Karama", 25.245, 55.305, 700, 80, 20, 40, "blocks"),
    ("Satwa", 25.228, 55.275, 600, 60, 10, 25, "blocks"),
    ("Al Barsha", 25.113, 55.198, 1000, 60, 20, 80, "blocks"),
    ("Silicon Oasis", 25.120, 55.380, 900, 40, 20, 80, "blocks"),
    ("International City", 25.165, 55.405, 900, 80, 15, 25, "blocks"),
    ("Festival City", 25.221, 55.352, 600, 30, 30, 120, "blocks"),
    ("Sports City", 25.040, 55.220, 700, 30, 30, 120, "blocks"),
    ("Discovery Gardens", 25.040, 55.145, 800, 100, 15, 25, "blocks"),
    ("Motor City", 25.047, 55.238, 700, 30, 20, 60, "blocks"),
    ("Dubai Hills", 25.110, 55.245, 1200, 40, 20, 100, "blocks"),
    ("Expo City", 24.965, 55.152, 800, 30, 20, 60, "blocks"),
    ("Palm trunk", 25.112, 55.138, 300, 40, 20, 60, "blocks"),
    ("Jumeirah villas", 25.205, 55.240, 1500, 250, 8, 15, "villas"),
    ("Umm Suqeim villas", 25.155, 55.205, 1300, 200, 8, 14, "villas"),
    ("Mirdif villas", 25.222, 55.420, 1200, 150, 8, 14, "villas"),
    ("Arabian Ranches", 25.055, 55.270, 1200, 150, 8, 14, "villas"),
    ("Meydan villas", 25.165, 55.330, 900, 80, 8, 14, "villas"),
    ("Al Quoz", 25.135, 55.230, 1500, 200, 8, 15, "warehouses"),
    ("JAFZA", 24.985, 55.115, 2000, 300, 8, 16, "warehouses"),
    ("Dubai Investments Park", 25.000, 55.170, 1500, 100, 8, 15, "warehouses"),
    ("Al Qusais/Airport industrial", 25.270, 55.380, 1200, 120, 8, 15, "warehouses"),
]

# Recintos portuarios (polígonos aproximados, vértices (lat, lon)) dentro de los
# cuales los valores NEGATIVOS de SRTM se respetan como agua: son dársenas dragadas
# reales (existen desde los años 70) que las teselas de zoom 12 no enmascaran. Fuera
# de ellos, un valor negativo a ese zoom es tierra baja (ver raise_negative_land).
HARBOURS = [
    ("Puerto de Jebel Ali", [(25.030, 55.030), (25.030, 55.070), (25.000, 55.070), (24.970, 55.065),
                             (24.970, 55.045), (24.995, 55.030)]),
    ("Port Rashid", [(25.279, 55.268), (25.279, 55.287), (25.256, 55.279), (25.256, 55.265)]),
]

# Grandes vías trazadas a mano (nombre, vértices (lat, lon)). Natural Earth 1:10m
# es muy generalizado en la zona; estas polilíneas se AÑADEN a las suyas en `roads`
# (mismo formato: lista de [lon, lat]).
HAND_ROADS = [
    ("E11 Sheikh Zayed Road", [(24.960, 55.020), (25.010, 55.085), (25.060, 55.150), (25.100, 55.190),
                               (25.150, 55.240), (25.200, 55.270), (25.230, 55.295), (25.260, 55.330),
                               (25.290, 55.360)]),
    ("E311 Emirates Road", [(24.930, 55.080), (25.000, 55.200), (25.060, 55.260), (25.120, 55.320),
                            (25.190, 55.380), (25.250, 55.430)]),
    ("E44 Al Khail Road", [(25.010, 55.140), (25.080, 55.215), (25.140, 55.260), (25.190, 55.300),
                           (25.230, 55.340)]),
    ("D94 Jumeirah Road", [(25.070, 55.130), (25.120, 55.185), (25.160, 55.215), (25.210, 55.250),
                           (25.235, 55.270), (25.255, 55.285)]),
    ("Al Khaleej Road", [(25.262, 55.290), (25.285, 55.320), (25.295, 55.350)]),
    ("Airport Road", [(25.240, 55.330), (25.253, 55.364)]),
    ("E66 Al Ain Road", [(25.230, 55.320), (25.170, 55.360), (25.100, 55.420)]),
    ("E77 Al Qudra Road", [(25.070, 55.230), (25.010, 55.290), (24.960, 55.330)]),
    ("Palm Jumeirah (tronco)", [(25.100, 55.153), (25.121, 55.128), (25.130, 55.117)]),
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
    # recorte en píxeles enteros, redondeado HACIA ARRIBA a múltiplo de DOWNSAMPLE
    # para que la imagen cubra la bbox completa.
    px0, py0 = int(math.floor(x0f)), int(math.floor(y0f))
    px1, py1 = int(math.ceil(x1f)), int(math.ceil(y1f))
    W = -(-(px1 - px0) // DOWNSAMPLE) * DOWNSAMPLE
    H = -(-(py1 - py0) // DOWNSAMPLE) * DOWNSAMPLE
    px1, py1 = px0 + W, py0 + H
    assert px0 <= x0f and py0 <= y0f and px1 >= x1f and py1 >= y1f
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
    neg, kept = raise_negative_land(heights, (px0, py0))
    print("  píxeles de tierra por debajo del nivel del mar (h < 0 en zoom %d) subidos a %.0f m: %d ; "
          "respetados como agua dentro de los recintos portuarios: %d" % (ZOOM, LOW_LAND_H, neg, kept))
    filled = fill_ocean_from_bathymetry(heights, (px0, py0))
    print("  píxeles de mar enmascarado rellenados con batimetría z%d: %d" % (BATHY_ZOOM, filled))
    return heights, (px0, py0)


def raise_negative_land(heights, origin_px):
    """A zoom >= 11 las teselas terrarium enmascaran el mar a 0.0 exactos, así que un
    valor NEGATIVO en el mosaico de zoom 12 es casi siempre una medida de TIERRA: SRTM
    da -1..-3 m por ruido en la llanura costera de Dubái (Marina, Al Sufouh, Barsha,
    Deira, Jumeirah...) y en sus sabkhas, que sí están algo por debajo del nivel del
    mar. Por contrato (mar = h <= 0) esas zonas se renderizarían como lagos de varios
    km², así que se suben a LOW_LAND_H. La excepción son las dársenas dragadas de los
    puertos (HARBOURS): agua real que las teselas tampoco enmascaran y que sí conviene
    conservar con su forma; dentro de esos polígonos los negativos se dejan tal cual
    (si no conectan con el mar, `reclassify_inland_water` los subirá igualmente).
    Debe llamarse ANTES del relleno de batimetría, que sí introduce valores negativos
    legítimos. Devuelve (píxeles subidos, píxeles respetados en los puertos)."""
    polys = []
    for _name, pts in HARBOURS:
        f = Frame(origin_px, pts[0][0])
        poly = [f.pt(*p) for p in pts]
        bbox = (min(p[0] for p in poly), min(p[1] for p in poly),
                max(p[0] for p in poly), max(p[1] for p in poly))
        polys.append((bbox, poly))

    def in_harbour(x, y):
        for (x0, y0, x1, y1), poly in polys:
            if x0 <= x <= x1 and y0 <= y <= y1 and point_in_polygon(x, y, poly):
                return True
        return False
    n = kept = 0
    for y, row in enumerate(heights):
        for x, h in enumerate(row):
            if h < 0.0:
                if in_harbour(x + 0.5, y + 0.5):
                    kept += 1
                else:
                    row[x] = LOW_LAND_H
                    n += 1
    return n, kept


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


def reclassify_inland_water(heights):
    """Tras el relleno de batimetría, etiqueta las componentes 8-conexas de h <= 0 del
    mosaico nativo y sube a LOW_LAND_H todas menos la mayor: el mar abierto, con todo
    lo que conecta con él (dársenas de Jebel Ali y Port Rashid, boca del Creek). Lo
    que se sube es tierra baja que SRTM da como 0 m exactos (playas, sabkha, solares
    de Deira, Bur Dubái o Jumeirah), que la máscara de zoom 12 no distingue del mar y
    que el relleno de batimetría acaba de "hundir" con la interpolación del ETOPO1
    grueso (hasta -50 m en pleno Zabeel): miles de charcas de uno o dos píxeles y
    algunos "lagos" de varios km². El agua interior real que interesa (Creek, Ras Al
    Khor, canales, lagos) se excava después a mano en `stamp_features`, así que esta
    pasada nunca afecta a lo dibujado. Devuelve (componentes subidas, píxeles
    subidos, píxeles del mar abierto)."""
    H, W = len(heights), len(heights[0])
    label = [[0] * W for _ in range(H)]
    sizes = {}
    nid = 0
    for y0 in range(H):
        row0 = heights[y0]
        lab0 = label[y0]
        for x0 in range(W):
            if row0[x0] > 0.0 or lab0[x0]:
                continue
            nid += 1
            lab0[x0] = nid
            queue = collections.deque([(x0, y0)])
            n = 0
            while queue:
                x, y = queue.popleft()
                n += 1
                for ny in (y - 1, y, y + 1):
                    if ny < 0 or ny >= H:
                        continue
                    lrow, hrow = label[ny], heights[ny]
                    for nx in (x - 1, x, x + 1):
                        if 0 <= nx < W and not lrow[nx] and hrow[nx] <= 0.0:
                            lrow[nx] = nid
                            queue.append((nx, ny))
            sizes[nid] = n
    sea_id = max(sizes, key=sizes.get)
    changed = 0
    for y in range(H):
        lrow, hrow = label[y], heights[y]
        for x in range(W):
            if lrow[x] and lrow[x] != sea_id:
                hrow[x] = LOW_LAND_H
                changed += 1
    return len(sizes) - 1, changed, sizes[sea_id]


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


def hillshade(heights, mpp, az_deg=315.0, alt_deg=45.0, z_factor=1.0):
    """Hillshade estándar (Horn) -> filas de bytes 8 bit. El mar se pinta gris plano.
    `z_factor` exagera el relieve (Dubái es casi plano: sin él no se ven ni las dunas
    ni los canales)."""
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
            dzdx = z_factor * (heights[y][xp] - heights[y][xm]) / (2.0 * mpp)
            dzdy = z_factor * (heights[yp][x] - heights[ym][x]) / (2.0 * mpp)
            slope = math.atan(math.hypot(dzdx, dzdy))
            aspect = math.atan2(dzdy, -dzdx)
            v = (math.sin(alt) * math.cos(slope)
                 + math.cos(alt) * math.sin(slope) * math.cos(az - math.pi / 2 - aspect))
            line[x] = max(0, min(255, int(round(255 * max(0.0, v)))))
        rows.append(bytes(line))
    return rows


# ---------------------------------------------------------------------------
# Geometría en metros sobre la rejilla de píxeles nativos (para estampar a mano)
# ---------------------------------------------------------------------------
class Frame:
    """Marco métrico local sobre la rejilla de píxeles nativos de ZOOM (antes del
    downsample), con origen en la esquina superior izquierda del recorte.
    Web-Mercator es conforme: las direcciones se conservan (norte = -y, este = +x,
    rumbos horarios desde el norte) y la escala local m/px sólo depende de la
    latitud, así que se toma la de `lat_ref` (el centro del elemento) para todo el
    elemento; en un elemento de pocos km el error es < 0,1 % (1 px nativo ≈ 35 m)."""

    def __init__(self, origin_px, lat_ref):
        self.ox, self.oy = origin_px
        self.mpp = meters_per_pixel(lat_ref, ZOOM, 1)

    def pt(self, lat, lon):
        """(lat, lon) -> (x, y) en píxeles nativos relativos al recorte."""
        x, y = lonlat_to_px(lon, lat)
        return x - self.ox, y - self.oy

    def px(self, metres):
        """Metros -> píxeles nativos."""
        return metres / self.mpp


def bearing_vec(deg):
    """Vector unitario en píxeles (x este, y sur) de un rumbo en grados horarios desde el norte."""
    r = math.radians(deg)
    return math.sin(r), -math.cos(r)


def bearing_of(dx, dy):
    """Rumbo [0, 360) horario desde el norte del vector (dx, dy) en píxeles (y hacia el sur)."""
    return math.degrees(math.atan2(dx, -dy)) % 360.0


def ang_diff(a, b):
    """Diferencia angular mínima entre dos rumbos, en grados [0, 180]."""
    d = (a - b) % 360.0
    return min(d, 360.0 - d)


def dist_to_segment(x, y, ax, ay, bx, by):
    """Distancia del punto (x, y) al segmento [a, b]."""
    vx, vy = bx - ax, by - ay
    l2 = vx * vx + vy * vy
    if l2 == 0.0:
        return math.hypot(x - ax, y - ay)
    t = ((x - ax) * vx + (y - ay) * vy) / l2
    t = max(0.0, min(1.0, t))
    return math.hypot(x - ax - t * vx, y - ay - t * vy)


def point_in_polygon(x, y, poly):
    """Prueba par-impar (ray casting) para un polígono simple [(x, y), ...]."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            if x < xj + (y - yj) * (xi - xj) / (yi - yj):
                inside = not inside
        j = i
    return inside


def paint_land(h):
    """Isla: sólo sube píxeles que ahora son mar (h <= 0); nunca baja tierra existente."""
    return ISLAND_H if h <= 0.0 else h


def paint_water(depth):
    """Canal/laguna: sólo ahonda hasta `depth` lo que esté más alto; nunca ahonda el mar abierto."""
    return lambda h: depth if h > depth else h


def stamp(heights, bbox, inside, paint):
    """Aplica paint(h) a los píxeles del recorte cuyo CENTRO cumple inside(x, y).
    `bbox` = (x0, y0, x1, y1) en píxeles nativos acota la búsqueda. Devuelve cuántos
    píxeles cambiaron."""
    H, W = len(heights), len(heights[0])
    x0 = max(0, int(math.floor(bbox[0])))
    y0 = max(0, int(math.floor(bbox[1])))
    x1 = min(W - 1, int(math.ceil(bbox[2])))
    y1 = min(H - 1, int(math.ceil(bbox[3])))
    n = 0
    for y in range(y0, y1 + 1):
        row = heights[y]
        cy = y + 0.5
        for x in range(x0, x1 + 1):
            if inside(x + 0.5, cy):
                h = row[x]
                nh = paint(h)
                if nh != h:
                    row[x] = nh
                    n += 1
    return n


def stamp_disc(heights, c, r, paint):
    cx, cy = c
    r2 = r * r
    return stamp(heights, (cx - r, cy - r, cx + r, cy + r),
                 lambda x, y: (x - cx) ** 2 + (y - cy) ** 2 <= r2, paint)


def stamp_capsule(heights, a, b, half, paint):
    """Franja de semianchura `half` (px) alrededor del segmento [a, b], extremos redondeados."""
    (ax, ay), (bx, by) = a, b
    half = max(half, MIN_HALF_PX)
    bbox = (min(ax, bx) - half, min(ay, by) - half, max(ax, bx) + half, max(ay, by) + half)
    return stamp(heights, bbox, lambda x, y: dist_to_segment(x, y, ax, ay, bx, by) <= half, paint)


def stamp_polyline(heights, pts, half, paint):
    n = 0
    for a, b in zip(pts, pts[1:]):
        n += stamp_capsule(heights, a, b, half, paint)
    return n


def stamp_rect(heights, base, bearing, length, width, paint):
    """Rectángulo que parte del punto medio de su lado corto `base` y avanza `length`
    px con rumbo `bearing`; `width` px de ancho centrado en el eje."""
    ux, uy = bearing_vec(bearing)
    nx, ny = -uy, ux                                    # perpendicular (rumbo + 90°)
    bx, by = base
    hw = width / 2.0
    corners = [(bx + nx * hw, by + ny * hw), (bx - nx * hw, by - ny * hw),
               (bx + ux * length + nx * hw, by + uy * length + ny * hw),
               (bx + ux * length - nx * hw, by + uy * length - ny * hw)]
    bbox = (min(c[0] for c in corners), min(c[1] for c in corners),
            max(c[0] for c in corners), max(c[1] for c in corners))

    def inside(x, y):
        dx, dy = x - bx, y - by
        s = dx * ux + dy * uy
        t = dx * nx + dy * ny
        return 0.0 <= s <= length and abs(t) <= hw
    return stamp(heights, bbox, inside, paint)


def stamp_ellipse(heights, c, semi_a, semi_b, axis_bearing, paint):
    """Elipse centrada en `c` con semieje `semi_a` a lo largo del rumbo `axis_bearing`
    y `semi_b` perpendicular (px)."""
    ux, uy = bearing_vec(axis_bearing)
    nx, ny = -uy, ux
    cx, cy = c
    R = max(semi_a, semi_b)

    def inside(x, y):
        dx, dy = x - cx, y - cy
        s = (dx * ux + dy * uy) / semi_a
        t = (dx * nx + dy * ny) / semi_b
        return s * s + t * t <= 1.0
    return stamp(heights, (cx - R, cy - R, cx + R, cy + R), inside, paint)


def stamp_arc(heights, c, r, half, b_from, b_to, gaps, gap_half_deg, paint):
    """Anillo de radio `r` y semianchura `half` (px) entre los rumbos `b_from` y `b_to`
    (en sentido horario), con huecos de ±`gap_half_deg` alrededor de cada rumbo de `gaps`."""
    cx, cy = c
    span = (b_to - b_from) % 360.0
    rlo, rhi = r - half, r + half

    def inside(x, y):
        dx, dy = x - cx, y - cy
        d = math.hypot(dx, dy)
        if d < rlo or d > rhi:
            return False
        b = bearing_of(dx, dy)
        if (b - b_from) % 360.0 > span:
            return False
        return not any(ang_diff(b, g) <= gap_half_deg for g in gaps)
    return stamp(heights, (cx - rhi, cy - rhi, cx + rhi, cy + rhi), inside, paint)


def stamp_polygon(heights, pts, paint):
    bbox = (min(p[0] for p in pts), min(p[1] for p in pts),
            max(p[0] for p in pts), max(p[1] for p in pts))
    return stamp(heights, bbox, lambda x, y: point_in_polygon(x, y, pts), paint)


class LCG:
    """Generador congruencial lineal (Numerical Recipes, módulo 2^32): determinista y
    portable, para que The World salga idéntico en cada construcción."""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def random(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0

    def uniform(self, a, b):
        return a + (b - a) * self.random()


# ---------------------------------------------------------------------------
# Islas ganadas al mar y canales (dibujados a mano; SRTM 2000 no los tiene)
# ---------------------------------------------------------------------------
def stamp_palm(heights, origin, base, bearing, trunk_len, trunk_w, frond_start, frond_step,
               frond_len, frond_w, crescent_c, crescent_r, crescent_w, arc_from, arc_to,
               gaps, gap_len, n_fronds=8, frond_turn=115.0):
    """Generador de "palmera": tronco rectangular desde la orilla `base` con rumbo
    `bearing`; `n_fronds` pares de frondas (franjas rectas) que salen de los lados
    del tronco cada `frond_step` m a partir de `frond_start` m, con dirección = eje
    del tronco girado ±`frond_turn`° (apuntan hacia atrás, hacia la orilla, como las
    hojas de una palmera); y una media luna = arco de radio `crescent_r` centrado en
    `crescent_c` entre los rumbos `arc_from`..`arc_to` con huecos de `gap_len` m en
    los rumbos `gaps`. Todo en metros; sólo sube píxeles de mar."""
    f = Frame(origin, crescent_c[0])
    n = 0
    B = f.pt(*base)
    n += stamp_rect(heights, B, bearing, f.px(trunk_len), f.px(trunk_w), paint_land)
    ux, uy = bearing_vec(bearing)
    nx, ny = -uy, ux
    half_w = f.px(trunk_w / 2.0)
    for i in range(n_fronds):
        s = f.px(frond_start + i * frond_step)
        for side in (+1, -1):
            sx = B[0] + ux * s + side * nx * half_w
            sy = B[1] + uy * s + side * ny * half_w
            dx, dy = bearing_vec(bearing + side * frond_turn)
            end = (sx + dx * f.px(frond_len), sy + dy * f.px(frond_len))
            n += stamp_capsule(heights, (sx, sy), end, f.px(frond_w / 2.0), paint_land)
    C = f.pt(*crescent_c)
    gap_half_deg = math.degrees((gap_len / 2.0) / crescent_r)
    n += stamp_arc(heights, C, f.px(crescent_r), f.px(crescent_w / 2.0), arc_from, arc_to,
                   gaps, gap_half_deg, paint_land)
    return n


def stamp_the_world(heights, origin, centre, semi_ew, semi_ns, n_islets, r_min, r_max, seed,
                    ring_w, n_gaps, gap_len, margin=350.0, min_gap=60.0):
    """The World: ~`n_islets` islotes circulares pseudoaleatorios (LCG con `seed`,
    radios r_min..r_max m, sin solapes, separación mínima `min_gap` m) dentro de una
    elipse E-O x N-S, más un rompeolas de `ring_w` m de ancho sobre el borde de la
    elipse con `n_gaps` huecos de `gap_len` m. Devuelve (píxeles cambiados, nº islotes)."""
    f = Frame(origin, centre[0])
    C = f.pt(*centre)
    rng = LCG(seed)
    islets = []                                        # (este_m, norte_m, r_m) respecto al centro
    tries = 0
    while len(islets) < n_islets and tries < 200000:
        tries += 1
        u, v = rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0)
        if u * u + v * v > 1.0:
            continue
        r = rng.uniform(r_min, r_max)
        ex, ey = u * (semi_ew - margin - r), v * (semi_ns - margin - r)
        if any(math.hypot(ex - ox, ey - oy) < r + orad + min_gap for (ox, oy, orad) in islets):
            continue
        islets.append((ex, ey, r))
    n = 0
    for ex, ey, r in islets:
        n += stamp_disc(heights, (C[0] + f.px(ex), C[1] - f.px(ey)), f.px(r), paint_land)
    # rompeolas: polilínea fina sobre la elipse, con huecos medidos en longitud de arco
    steps = 720
    pts = [(semi_ew * math.cos(2 * math.pi * k / steps), semi_ns * math.sin(2 * math.pi * k / steps))
           for k in range(steps + 1)]
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    perim = cum[-1]
    gap_centres = [perim * (k + 0.5) / n_gaps for k in range(n_gaps)]
    half = f.px(ring_w / 2.0)
    for k in range(steps):
        mid = (cum[k] + cum[k + 1]) / 2.0
        if any(abs(mid - g) <= gap_len / 2.0 for g in gap_centres):
            continue
        a = (C[0] + f.px(pts[k][0]), C[1] - f.px(pts[k][1]))
        b = (C[0] + f.px(pts[k + 1][0]), C[1] - f.px(pts[k + 1][1]))
        n += stamp_capsule(heights, a, b, half, paint_land)
    return n, len(islets)


def stamp_features(heights, origin):
    """Estampa sobre el mosaico nativo (tras la batimetría, antes del downsample) las
    islas artificiales (+ISLAND_H m, sólo sobre mar) y después los canales/lagunas
    (CHANNEL_H m, sólo donde el terreno esté más alto), de modo que un canal que
    cruce una isla la corta. Todas las geometrías son polígonos APROXIMADOS
    dibujados a mano, no proceden de ningún dataset. Devuelve (islands, water, stats)
    con las listas de documentación para el JSON."""
    islands, water, stats = [], [], {}

    def island(name, kind, n):
        islands.append({"name": name, "kind": kind})
        print("  isla  %-22s %-12s %6d px nativos" % (name, kind, n))

    def channel(name, kind, n):
        water.append({"name": name, "kind": kind})
        print("  agua  %-22s %-12s %6d px nativos" % (name, kind, n))

    def F(lat):
        return Frame(origin, lat)

    # --- Islas -------------------------------------------------------------
    island("Palm Jumeirah", "palm", stamp_palm(
        heights, origin, base=(25.1005, 55.1525), bearing=320.0, trunk_len=2000.0, trunk_w=550.0,
        frond_start=350.0, frond_step=220.0, frond_len=1500.0, frond_w=110.0,
        crescent_c=(25.112, 55.137), crescent_r=2850.0, crescent_w=250.0,
        arc_from=230.0, arc_to=55.0, gaps=(260.0, 10.0), gap_len=250.0))
    # misma generatriz escalada x1.6; huecos en las mismas posiciones relativas del arco
    island("Palm Jebel Ali", "palm", stamp_palm(
        heights, origin, base=(24.992, 55.033), bearing=315.0, trunk_len=3200.0, trunk_w=900.0,
        frond_start=560.0, frond_step=352.0, frond_len=2400.0, frond_w=176.0,
        crescent_c=(25.005, 54.990), crescent_r=4600.0, crescent_w=350.0,
        arc_from=240.0, arc_to=50.0, gaps=(270.0, 20.0), gap_len=400.0))

    f = F(25.079)
    n = stamp_disc(heights, f.pt(25.0790, 55.1211), f.px(450.0), paint_land)
    n += stamp_capsule(heights, f.pt(25.0790, 55.1211), f.pt(25.0755, 55.1275), f.px(30.0), paint_land)
    island("Bluewaters Island", "island", n)

    n, n_islets = stamp_the_world(heights, origin, centre=(25.2230, 55.1700), semi_ew=4300.0,
                                  semi_ns=3000.0, n_islets=240, r_min=60.0, r_max=130.0,
                                  seed=20250901, ring_w=80.0, n_gaps=6, gap_len=300.0)
    stats["world_islets"] = n_islets
    island("The World (%d islotes)" % n_islets, "archipelago", n)

    f = F(25.30)
    poly = [f.pt(*p) for p in [(25.2880, 55.2900), (25.3060, 55.2960), (25.3130, 55.3180),
                               (25.3020, 55.3320), (25.2900, 55.3220), (25.2850, 55.3060)]]
    island("Deira Islands", "island", stamp_polygon(heights, poly, paint_land))

    f = F(25.213)
    # `rot` como en los hitos: rumbo horario desde el norte del eje mayor
    n = stamp_ellipse(heights, f.pt(25.2130, 55.2430), f.px(310.0), f.px(190.0), 30.0, paint_land)
    n += stamp_capsule(heights, f.pt(25.2130, 55.2430), f.pt(25.2075, 55.2455), f.px(30.0), paint_land)
    island("Jumeirah Bay Island", "island", n)

    f = F(25.087)
    island("Dubai Harbour", "reclamation",
           stamp_rect(heights, f.pt(25.0870, 55.1400), 325.0, f.px(1200.0), f.px(600.0), paint_land))

    f = F(25.141)
    n = stamp_disc(heights, f.pt(25.1412, 55.1853), f.px(130.0), paint_land)
    n += stamp_capsule(heights, f.pt(25.1412, 55.1853), f.pt(25.1398, 55.1872), f.px(20.0), paint_land)
    island("Burj Al Arab", "island", n)

    f = F(25.268)
    island("Dubai Maritime City", "reclamation",
           stamp_rect(heights, f.pt(25.2680, 55.2760), 300.0, f.px(1400.0), f.px(800.0), paint_land))

    # --- Agua ----------------------------------------------------------------
    carve = paint_water(CHANNEL_H)
    f = F(25.24)
    creek = [f.pt(*p) for p in [(25.2745, 55.2830), (25.2700, 55.2950), (25.2600, 55.3100),
                                (25.2440, 55.3260), (25.2300, 55.3310), (25.2130, 55.3320),
                                (25.1990, 55.3300)]]
    channel("Dubai Creek", "creek", stamp_polyline(heights, creek, f.px(210.0), carve))
    lagoon = [f.pt(*p) for p in [(25.1990, 55.3200), (25.2080, 55.3380), (25.1920, 55.3450),
                                 (25.1830, 55.3300)]]
    channel("Ras Al Khor", "lagoon", stamp_polygon(heights, lagoon, carve))

    f = F(25.19)
    bb = [f.pt(*p) for p in [(25.1990, 55.3300), (25.1880, 55.3080), (25.1845, 55.2820), (25.1830, 55.2690)]]
    channel("Business Bay canal", "canal", stamp_polyline(heights, bb, f.px(110.0), carve))
    channel("Business Bay lake", "lake", stamp_disc(heights, f.pt(25.1835, 55.2680), f.px(250.0), carve))
    dwc = [f.pt(*p) for p in [(25.1830, 55.2690), (25.1900, 55.2560), (25.1990, 55.2410), (25.2005, 55.2385)]]
    channel("Dubai Water Canal", "canal", stamp_polyline(heights, dwc, f.px(60.0), carve))

    f = F(25.085)
    marina = [f.pt(*p) for p in [(25.0720, 55.1330), (25.0790, 55.1400), (25.0870, 55.1465),
                                 (25.0930, 55.1450), (25.0950, 55.1380)]]
    channel("Dubai Marina canal", "canal", stamp_polyline(heights, marina, f.px(75.0), carve))

    f = F(25.197)
    lake = [f.pt(*p) for p in [(25.1955, 55.2740), (25.1985, 55.2755), (25.1990, 55.2790), (25.1960, 55.2795)]]
    channel("Burj Khalifa lake", "lake", stamp_polygon(heights, lake, paint_water(-2.0)))
    return islands, water, stats


# ---------------------------------------------------------------------------
# Carreteras (Natural Earth + trazados a mano)
# ---------------------------------------------------------------------------
def _bbox_intersects_line(coords):
    w, s, e, n = BBOX["west"], BBOX["south"], BBOX["east"], BBOX["north"]
    return any(w <= lon <= e and s <= lat <= n for lon, lat in coords)


def load_roads():
    """Devuelve (carreteras Natural Earth dentro de la bbox, trazados a mano), ambas
    como listas de polilíneas [[lon, lat], ...]."""
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
    hand = [[[round(lon, 5), round(lat, 5)] for (lat, lon) in pts] for (_name, pts) in HAND_ROADS]
    return roads, hand


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


def encode_heights(heights):
    """Codifica las alturas al contrato del PNG: v = clamp(round(h) + OFFSET, 0, 65535).
    Devuelve (rows, stats) con rows = filas ya empaquetadas big-endian y stats un dict
    con el mínimo/máximo codificados (en metros) y cuántos píxeles se recortaron por
    abajo (v == 0, h <= -1000 m) y por arriba (v == 65535)."""
    W = len(heights[0])
    rows = []
    vmin, vmax = 65535, 0
    clamp_lo = clamp_hi = 0
    for r in heights:
        vals = [0] * W
        for x, h in enumerate(r):
            v = int(round(h)) + OFFSET
            if v <= 0:
                clamp_lo += v < 0
                v = 0
            elif v >= 65535:
                clamp_hi += v > 65535
                v = 65535
            vals[x] = v
        rows.append(struct.pack(">%dH" % W, *vals))
        vmin = min(vmin, min(vals))
        vmax = max(vmax, max(vals))
    stats = {"min_h": float(vmin - OFFSET), "max_h": float(vmax - OFFSET),
             "clamped_low": clamp_lo, "clamped_high": clamp_hi}
    return rows, stats


def find_peak(heights, origin_px):
    """Píxel más alto del dataset (ya reducido). Devuelve (dict `peak`, (x, y))."""
    best = (-1e9, 0, 0)
    for y, r in enumerate(heights):
        m = max(r)
        if m > best[0]:
            best = (m, r.index(m), y)
    mh, mx, my = best
    lon, lat = px_to_lonlat(origin_px[0] + (mx + 0.5) * DOWNSAMPLE,
                            origin_px[1] + (my + 0.5) * DOWNSAMPLE)
    return {"name": PEAK_NAME, "lat": round(lat, 4), "lon": round(lon, 4), "h": round(mh, 1)}, (mx, my)


def write_outputs(heights, origin_px, roads, hand_roads, islands, water, make_preview=True):
    """Escribe el PNG de 16 bits y el JSON del contrato GEO. Claves heredadas de
    Tenerife: name, attribution, zoom, downsample, width, height, origin_px,
    meters_per_pixel, offset, min_h, max_h, bbox, peak, towns, roads. Claves nuevas
    de Dubái: grid (cuadrícula de parcelas), landmarks (hitos modelados uno a uno),
    clusters (skylines genéricos), islands y water (documentación de lo estampado a
    mano). `min_h`/`max_h` son el mínimo y máximo de los valores YA codificados
    (tras el recorte a [0, 65535]), es decir, exactamente lo que un lector del PNG
    obtendrá con h = v - offset. `roads` = Natural Earth + HAND_ROADS."""
    H, W = len(heights), len(heights[0])
    rows, stats = encode_heights(heights)
    min_h, max_h = stats["min_h"], stats["max_h"]
    raw_min = min(min(r) for r in heights)
    raw_max = max(max(r) for r in heights)
    print("Codificación PNG: min bruto %.1f m -> codificado %.0f m ; max bruto %.1f m -> %.0f m ; "
          "recortados por abajo (h < -%d m): %d ; por arriba: %d"
          % (raw_min, min_h, raw_max, max_h, OFFSET, stats["clamped_low"], stats["clamped_high"]))
    png = encode_png_gray(W, H, rows, 16)
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_PNG, "wb") as f:
        f.write(png)

    peak, _ = find_peak(heights, origin_px)
    center_lat = (BBOX["north"] + BBOX["south"]) / 2.0
    meta = {
        "name": "Dubái",
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
        "peak": peak,
        "grid": GRID,
        "towns": [{"name": n, "lat": la, "lon": lo, "kind": k} for (n, la, lo, k) in TOWNS],
        "landmarks": [{"id": i, "name": n, "lat": la, "lon": lo, "shape": s,
                       "h": h, "w": w, "d": d, "rot": r}
                      for (i, n, la, lo, s, h, w, d, r) in LANDMARKS],
        "clusters": [{"name": n, "lat": la, "lon": lo, "radius_m": rm, "count": c,
                      "hmin": h0, "hmax": h1, "seed": zlib.crc32(n.encode("utf-8")) & 0xFFFF,
                      "kind": k}
                     for (n, la, lo, rm, c, h0, h1, k) in CLUSTERS],
        "islands": islands,
        "water": water,
        "roads": roads + hand_roads,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
        f.write("\n")

    if make_preview:
        shade = hillshade(heights, meta["meters_per_pixel"], z_factor=3.0)
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


def verify(heights, meta, stats):
    ok = True
    H, W = len(heights), len(heights[0])
    checks = []

    def check(label, cond, detail):
        nonlocal ok
        ok &= bool(cond)
        print("  %s: %s  [%s]" % (label, detail, "OK" if cond else "FALLO"))

    def at(name, lat, lon):
        X, Y, h = sample(heights, meta, lon, lat)
        return X, Y, h, "%s (%.4f,%.4f): px (%.1f,%.1f) h=%.1f m" % (name, lat, lon, X, Y, h)

    print("VERIFICACION")
    # máximo del recorte == peak del JSON
    peak, (mx, my) = find_peak(heights, (meta["origin_px"]["x"], meta["origin_px"]["y"]))
    mh = heights[my][mx]
    check("max h", peak["h"] == meta["peak"]["h"] and mh > 0,
          "%.1f m en px (%d,%d) lat=%.4f lon=%.4f == peak del JSON" % (mh, mx, my, peak["lat"], peak["lon"]))
    X, Y, h, d = at("Downtown / Burj Khalifa", 25.1972, 55.2744)
    check("tierra baja", 0 < h < 60, d)
    Xd, Yd, h, d = at("Deira", 25.270, 55.312)
    check("tierra", h > 0, d)
    X, Y, h, d = at("Puerto de Jebel Ali", 25.011, 55.060)
    check("tierra", h > 0, d)
    X, Y, h, d = at("mar abierto", 25.30, 55.10)
    check("mar", h < 0, d)
    X, Y, h, d = at("Atlantis (ápice media luna)", 25.1304, 55.1171)
    check("isla estampada", h > 0, d)
    X, Y, h, d = at("Burj Al Arab", 25.1412, 55.1853)
    check("isla estampada", h > 0, d)
    X, Y, h, d = at("Dubai Creek", 25.2440, 55.3260)
    check("agua", h < 0, d)
    # The World: islotes dentro de la elipse (tierra rodeada de mar)
    fw = Frame((meta["origin_px"]["x"], meta["origin_px"]["y"]), 25.2230)
    cx, cy = fw.pt(25.2230, 55.1700)
    a, b = fw.px(4300.0) / DOWNSAMPLE, fw.px(3000.0) / DOWNSAMPLE
    cx, cy = cx / DOWNSAMPLE, cy / DOWNSAMPLE
    land = sea = 0
    for y in range(int(cy - b), int(cy + b) + 1):
        for x in range(int(cx - a), int(cx + a) + 1):
            if ((x + 0.5 - cx) / a) ** 2 + ((y + 0.5 - cy) / b) ** 2 <= 0.8:
                if heights[y][x] > 0:
                    land += 1
                else:
                    sea += 1
    check("The World", stats.get("world_islets", 0) >= 200 and land > 50 and sea > land,
          "%d islotes colocados ; dentro de la elipse %d px de tierra y %d de mar"
          % (stats.get("world_islets", 0), land, sea))
    for name, pts in HARBOURS:
        fh = Frame((meta["origin_px"]["x"], meta["origin_px"]["y"]), pts[0][0])
        poly = [tuple(v / DOWNSAMPLE for v in fh.pt(*p)) for p in pts]
        xs, ys = [p[0] for p in poly], [p[1] for p in poly]
        n_in = n_wet = 0
        for y in range(int(min(ys)), int(max(ys)) + 1):
            for x in range(int(min(xs)), int(max(xs)) + 1):
                if 0 <= x < W and 0 <= y < H and point_in_polygon(x + 0.5, y + 0.5, poly):
                    n_in += 1
                    n_wet += heights[y][x] <= 0
        check("dársenas", n_wet >= 20, "%s: %d px de agua de %d dentro del recinto (%.0f%%)"
              % (name, n_wet, n_in, 100.0 * n_wet / max(1, n_in)))
    Xm, Ym, hm, d = at("Dubai Marina", 25.080, 55.140)
    check("orientación", Xd > Xm and Yd < Ym, d + " ; Deira a la derecha y arriba")
    print("  imagen %dx%d ; min_h=%.1f max_h=%.1f ; m/px=%.3f ; carreteras=%d ; lugares=%d ; "
          "hitos=%d ; clusters=%d ; islas=%d ; agua=%d"
          % (W, H, meta["min_h"], meta["max_h"], meta["meters_per_pixel"], len(meta["roads"]),
             len(meta["towns"]), len(meta["landmarks"]), len(meta["clusters"]),
             len(meta["islands"]), len(meta["water"])))
    for path in (OUT_PNG, OUT_JSON, OUT_PREVIEW):
        if os.path.exists(path):
            size = os.path.getsize(path)
            print("  %s : %d bytes (%.2f MB)" % (os.path.relpath(path, REPO), size, size / 1e6))
    check("tamaño hgt.png <= 2.5 MB", os.path.getsize(OUT_PNG) <= 2.5e6,
          "%.2f MB" % (os.path.getsize(OUT_PNG) / 1e6))
    # comprobación de ida y vuelta del PNG escrito
    with open(OUT_PNG, "rb") as f:
        w2, h2, ch2, bd2, rows2 = decode_png(f.read())
    v = struct.unpack(">H", rows2[my][mx * 2:mx * 2 + 2])[0]
    check("relectura PNG", (w2, h2, ch2, bd2) == (W, H, 1, 16) and abs((v - OFFSET) - mh) <= 0.5,
          "%dx%d ch=%d bd=%d, v(máximo)=%d -> %.0f m" % (w2, h2, ch2, bd2, v, v - OFFSET))
    # el JSON debe describir el PNG tal cual se codificó
    vmin, vmax = 65535, 0
    n_v0 = n_vmax = n_v_off = 0
    for r in rows2:
        vals = struct.unpack(">%dH" % w2, r)
        vmin = min(vmin, min(vals))
        vmax = max(vmax, max(vals))
        n_v0 += vals.count(0)
        n_vmax += vals.count(65535)
        n_v_off += vals.count(OFFSET)
    total = w2 * h2
    check("PNG decodificado == JSON",
          vmin - OFFSET == meta["min_h"] and vmax - OFFSET == meta["max_h"] and meta["min_h"] >= -OFFSET,
          "min v=%d (%.0f m) max v=%d (%.0f m) ; JSON min_h=%.1f max_h=%.1f"
          % (vmin, vmin - OFFSET, vmax, vmax - OFFSET, meta["min_h"], meta["max_h"]))
    print("  píxeles recortados al suelo v=0 (h <= -%d m): %d de %d (%.1f%%) ; al techo v=65535: %d"
          % (OFFSET, n_v0, total, 100.0 * n_v0 / total, n_vmax))
    n_zero = sum(r.count(0.0) for r in heights)
    n_sea = sum(1 for r in heights for h in r if h <= 0)
    print("  píxeles con h == 0: %d exactos en el array, %d con v == %d en el PNG (|h| < 0.5) ; "
          "son MAR por contrato (h <= 0) ; mar total: %d (%.1f%%)"
          % (n_zero, n_v_off, OFFSET, n_sea, 100.0 * n_sea / total))
    # charcas: componentes 8-conexas de mar (h <= 0) en la imagen final aparte del mar abierto
    seen = [[False] * W for _ in range(H)]
    comps = []
    for y0 in range(H):
        for x0 in range(W):
            if heights[y0][x0] > 0 or seen[y0][x0]:
                continue
            seen[y0][x0] = True
            queue = collections.deque([(x0, y0)])
            n = 0
            while queue:
                x, y = queue.popleft()
                n += 1
                for ny in range(max(0, y - 1), min(H, y + 2)):
                    for nx in range(max(0, x - 1), min(W, x + 2)):
                        if not seen[ny][nx] and heights[ny][nx] <= 0:
                            seen[ny][nx] = True
                            queue.append((nx, ny))
            comps.append(n)
    comps.sort(reverse=True)
    print("  masas de agua en la imagen final: mar abierto %d px + %d interiores (%d de 1-2 px, %d de >= 10 px)"
          % (comps[0], len(comps) - 1, sum(1 for n in comps[1:] if n <= 2), sum(1 for n in comps[1:] if n >= 10)))
    # la imagen debe cubrir la bbox entera (redondeo hacia arriba del recorte)
    ds = meta["downsample"]
    x0f, y0f = lonlat_to_px(BBOX["west"], BBOX["north"])
    x1f, y1f = lonlat_to_px(BBOX["east"], BBOX["south"])
    ox, oy = meta["origin_px"]["x"], meta["origin_px"]["y"]
    ex, ey = ox + W * ds, oy + H * ds
    lon_e, lat_s = px_to_lonlat(ex, ey)
    check("cobertura bbox", ox <= x0f and oy <= y0f and ex >= x1f and ey >= y1f,
          "px [%.0f..%.0f) x [%.0f..%.0f) contiene [%.2f..%.2f] x [%.2f..%.2f] ; "
          "esquina inferior derecha lon=%.5f lat=%.5f" % (ox, ex, oy, ey, x0f, x1f, y0f, y1f, lon_e, lat_s))
    print("RESULTADO: %s" % ("TODO OK" if ok else "HAY FALLOS"))
    return ok


def main(argv):
    make_preview = "--no-preview" not in argv
    ensure_gitignore()
    t0 = time.time()
    heights, origin = build_mosaic()
    print("Mosaico nativo %dx%d en %.1fs" % (len(heights[0]), len(heights), time.time() - t0))
    n_comp, n_px, n_sea = reclassify_inland_water(heights)
    print("Tierra baja a 0 m sin salida al mar: %d componentes (%d px nativos) subidas a %.0f m ; mar abierto: %d px nativos"
          % (n_comp, n_px, LOW_LAND_H, n_sea))
    print("Estampando islas artificiales y canales (a mano, +%.0f m / %.0f m):" % (ISLAND_H, CHANNEL_H))
    islands, water, stats = stamp_features(heights, origin)
    heights = downsample_box(heights, DOWNSAMPLE)
    print("Downsample x%d -> %dx%d" % (DOWNSAMPLE, len(heights[0]), len(heights)))
    roads, hand_roads = load_roads()
    print("Carreteras Natural Earth dentro de la bbox: %d (+ %d trazadas a mano)" % (len(roads), len(hand_roads)))
    meta = write_outputs(heights, origin, roads, hand_roads, islands, water, make_preview)
    print("Escrito %s y %s (%.1fs)" % (os.path.relpath(OUT_PNG, REPO),
                                       os.path.relpath(OUT_JSON, REPO), time.time() - t0))
    return 0 if verify(heights, meta, stats) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
