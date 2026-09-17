#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
osm_roads.py - convierte un extracto de OpenStreetMap en la lista `vias` que lee
el cliente 3D del monedero (chain/crates/rami-gui/src/city3d.js, v0.10.13).

Sólo biblioteca estándar de Python 3. NO descarga nada: el extracto lo aporta
quien lo ejecuta (la red del entorno donde se construye el proyecto no alcanza
OpenStreetMap, y el repositorio no trae ningún dato de OSM; ver el README de
esta carpeta y su nota sobre la ODbL).

Entrada (se reconoce sola):
  * JSON de Overpass (`[out:json]; ... out geom;`): elementos `way` con `tags`
    y `geometry: [{lat, lon}, ...]`.
  * GeoJSON: FeatureCollection con LineString / MultiLineString y `properties`
    (`highway`, `name`), como el que exporta overpass-turbo o QGIS.

La consulta de Overpass que produce el extracto de Dubái está en el README.

Salida: un JSON `{"attribution": ..., "vias": [{"nombre", "clase", "pts"}, ...]}`
con `pts` = [[lon, lat], ...] redondeados a 5 decimales. Con `--merge FICHERO`
se escribe además dentro de un dubai.json (clave `vias`, y la atribución de OSM
se añade a `attribution`).

Qué hace con las vías:
  1. Clasifica por `highway`: motorway/trunk (+ _link) → troncal; primary →
     arteria; secondary/tertiary → secundaria; residential/unclassified/
     living_street → barrio (sólo con --barrio). Lo demás se descarta.
  2. Recorta a la bbox del dataset (la de build_dubai.py) y descarta lo que
     quede fuera del todo.
  3. Encadena los tramos: OSM parte cada calle en muchos `way` cortos (en cada
     cruce y en cada cambio de etiqueta). Dos tramos de la misma clase que
     comparten un extremo en el que no confluye ningún otro se unen; así una
     avenida sale como una sola polilínea y el tráfico ambiente, que sólo circula
     por vías de más de 2 km, la usa.
  4. Simplifica cada polilínea (Douglas-Peucker, 5 m) y descarta las de menos de
     200 m.

Uso:
  python3 tools/geo/osm_roads.py extracto.json -o vias.json
  python3 tools/geo/osm_roads.py extracto.json --merge chain/crates/rami-gui/src/geo/dubai.json
  python3 tools/geo/osm_roads.py --selftest
"""
import argparse
import json
import math
import sys

BBOX = {"west": 54.90, "south": 24.78, "east": 55.60, "north": 25.40}
ATTRIBUTION_OSM = "Roads (vias): © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)"

CLASE = {
    "motorway": "troncal", "motorway_link": "troncal", "trunk": "troncal", "trunk_link": "troncal",
    "primary": "arteria", "primary_link": "arteria",
    "secondary": "secundaria", "secondary_link": "secundaria", "tertiary": "secundaria", "tertiary_link": "secundaria",
    "residential": "barrio", "unclassified": "barrio", "living_street": "barrio",
}
TOLERANCIA_M = 5.0
LARGO_MINIMO_M = 200.0


# ---------------------------------------------------------------------------
# Geometría (metros locales: la ciudad mide 70 km, la equirectangular basta)
# ---------------------------------------------------------------------------
def _metros(p, lat0):
    return (p[0] * 111320.0 * math.cos(math.radians(lat0)), p[1] * 110574.0)


def largo_m(pts, lat0):
    total = 0.0
    for a, b in zip(pts, pts[1:]):
        (ax, ay), (bx, by) = _metros(a, lat0), _metros(b, lat0)
        total += math.hypot(bx - ax, by - ay)
    return total


def _dist_segmento(p, a, b):
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplifica(pts, tol_m, lat0):
    """Douglas-Peucker sobre metros locales; devuelve los [lon, lat] que quedan."""
    if len(pts) < 3:
        return list(pts)
    m = [_metros(p, lat0) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    pila = [(0, len(pts) - 1)]
    while pila:
        i, j = pila.pop()
        if j <= i + 1:
            continue
        peor, k_peor = -1.0, -1
        for k in range(i + 1, j):
            d = _dist_segmento(m[k], m[i], m[j])
            if d > peor:
                peor, k_peor = d, k
        if peor > tol_m:
            keep[k_peor] = True
            pila.append((i, k_peor))
            pila.append((k_peor, j))
    return [p for p, k in zip(pts, keep) if k]


def en_bbox(p):
    return BBOX["west"] <= p[0] <= BBOX["east"] and BBOX["south"] <= p[1] <= BBOX["north"]


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------
def lee_tramos(doc):
    """Devuelve [(clase, nombre, [[lon, lat], ...]), ...] de un JSON de Overpass
    o de un GeoJSON. Los `way` de Overpass sin `geometry` (sin `out geom`) se
    resuelven con los nodos del propio extracto si vienen."""
    tramos = []
    if isinstance(doc, dict) and doc.get("type") == "FeatureCollection":
        for f in doc.get("features", []):
            props = f.get("properties") or {}
            clase = CLASE.get(props.get("highway"))
            if not clase:
                continue
            geom = f.get("geometry") or {}
            if geom.get("type") == "LineString":
                lineas = [geom["coordinates"]]
            elif geom.get("type") == "MultiLineString":
                lineas = geom["coordinates"]
            else:
                continue
            for ln in lineas:
                tramos.append((clase, props.get("name") or "", [[float(p[0]), float(p[1])] for p in ln]))
        return tramos
    elementos = doc.get("elements", []) if isinstance(doc, dict) else []
    nodos = {e["id"]: (float(e["lon"]), float(e["lat"])) for e in elementos if e.get("type") == "node" and "lat" in e}
    for e in elementos:
        if e.get("type") != "way":
            continue
        tags = e.get("tags") or {}
        clase = CLASE.get(tags.get("highway"))
        if not clase:
            continue
        if e.get("geometry"):
            pts = [[float(p["lon"]), float(p["lat"])] for p in e["geometry"]]
        else:
            pts = [list(nodos[n]) for n in e.get("nodes", []) if n in nodos]
        if len(pts) >= 2:
            tramos.append((clase, tags.get("name") or "", pts))
    return tramos


# ---------------------------------------------------------------------------
# Encadenado
# ---------------------------------------------------------------------------
def _clave(p):
    return (round(p[0], 6), round(p[1], 6))


def encadena(tramos):
    """Une tramos de la misma clase por los extremos en los que sólo confluyen
    ellos dos (grado 2 dentro de su clase). Es un recorrido voraz: cada tramo
    se usa una vez, y una polilínea crece por sus dos extremos hasta topar con
    un cruce (grado ≠ 2) o con un tramo ya usado."""
    por_clase = {}
    for idx, (clase, nombre, pts) in enumerate(tramos):
        por_clase.setdefault(clase, []).append(idx)
    salida = []
    for clase, indices in por_clase.items():
        extremos = {}
        for idx in indices:
            pts = tramos[idx][2]
            for k in (_clave(pts[0]), _clave(pts[-1])):
                extremos.setdefault(k, []).append(idx)
        usado = set()
        for idx in indices:
            if idx in usado:
                continue
            usado.add(idx)
            nombre = tramos[idx][1]
            cadena = list(tramos[idx][2])
            for lado in (1, -1):
                while True:
                    fin = cadena[-1] if lado == 1 else cadena[0]
                    vecinos = [j for j in extremos.get(_clave(fin), []) if j not in usado]
                    if len(extremos.get(_clave(fin), [])) != 2 or len(vecinos) != 1:
                        break
                    j = vecinos[0]
                    usado.add(j)
                    otro = list(tramos[j][2])
                    if _clave(otro[0]) != _clave(fin):
                        otro.reverse()
                    # `otro` va de `fin` hacia fuera: detrás se añade tal cual y
                    # delante, al revés.
                    if lado == 1:
                        cadena.extend(otro[1:])
                    else:
                        cadena = list(reversed(otro[1:])) + cadena
                    if not nombre:
                        nombre = tramos[j][1]
            salida.append((clase, nombre, cadena))
    return salida


def convierte(doc, con_barrio=False):
    lat0 = (BBOX["south"] + BBOX["north"]) * 0.5
    tramos = [t for t in lee_tramos(doc) if con_barrio or t[0] != "barrio"]
    tramos = [t for t in tramos if any(en_bbox(p) for p in t[2])]
    vias = []
    for clase, nombre, pts in encadena(tramos):
        pts = simplifica(pts, TOLERANCIA_M, lat0)
        if len(pts) < 2 or largo_m(pts, lat0) < LARGO_MINIMO_M:
            continue
        vias.append({"nombre": nombre, "clase": clase, "pts": [[round(p[0], 5), round(p[1], 5)] for p in pts]})
    orden = {"troncal": 0, "arteria": 1, "secundaria": 2, "barrio": 3}
    vias.sort(key=lambda v: (orden[v["clase"]], v["nombre"], v["pts"][0]))
    return vias


# ---------------------------------------------------------------------------
# Autoprueba: un extracto sintético de seis tramos
# ---------------------------------------------------------------------------
def _sintetico():
    # Una troncal partida en tres `way` consecutivos (2,8 km), una arteria que la
    # cruza (los extremos coinciden con el nodo central: grado 3, no se encadena
    # con ella), un tramo residencial y un tramo fuera de la bbox.
    def way(i, hw, name, pts):
        return {"type": "way", "id": i, "tags": {"highway": hw, "name": name}, "geometry": [{"lat": la, "lon": lo} for lo, la in pts]}
    return {"elements": [
        way(1, "motorway", "E11", [[55.100, 25.100], [55.105, 25.104], [55.110, 25.108]]),
        way(2, "motorway", "E11", [[55.110, 25.108], [55.115, 25.112], [55.120, 25.116]]),
        way(3, "motorway", "", [[55.120, 25.116], [55.125, 25.120]]),
        way(4, "primary", "Al Wasl", [[55.110, 25.108], [55.104, 25.114], [55.098, 25.120]]),
        way(5, "residential", "Calle corta", [[55.130, 25.130], [55.131, 25.1303]]),
        way(6, "trunk", "Fuera", [[56.000, 26.000], [56.010, 26.010]]),
    ]}


def selftest():
    vias = convierte(_sintetico())
    assert [v["clase"] for v in vias] == ["troncal", "arteria"], vias
    e11 = vias[0]
    assert e11["nombre"] == "E11" and e11["pts"][0] == [55.1, 25.1] and e11["pts"][-1] == [55.125, 25.12], e11
    assert len(e11["pts"]) == 2, e11          # recta: Douglas-Peucker deja los dos extremos
    assert vias[1]["nombre"] == "Al Wasl" and len(vias[1]["pts"]) == 2, vias[1]
    con = convierte(_sintetico(), con_barrio=True)
    assert [v["clase"] for v in con] == ["troncal", "arteria"], con   # la residencial mide 110 m: fuera
    # GeoJSON con la misma troncal en dos LineString encadenables
    gj = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"highway": "trunk", "name": "E44"}, "geometry": {"type": "LineString", "coordinates": [[55.2, 25.2], [55.21, 25.21]]}},
        {"type": "Feature", "properties": {"highway": "trunk", "name": "E44"}, "geometry": {"type": "LineString", "coordinates": [[55.22, 25.22], [55.21, 25.21]]}},
    ]}
    v2 = convierte(gj)
    assert len(v2) == 1 and v2[0]["pts"] == [[55.2, 25.2], [55.22, 25.22]], v2
    # Overpass sin `out geom`: los nodos van aparte
    ov = {"elements": [
        {"type": "node", "id": 1, "lat": 25.3, "lon": 55.3}, {"type": "node", "id": 2, "lat": 25.31, "lon": 55.31},
        {"type": "way", "id": 9, "tags": {"highway": "secondary"}, "nodes": [1, 2]},
    ]}
    v3 = convierte(ov)
    assert len(v3) == 1 and v3[0]["clase"] == "secundaria" and v3[0]["nombre"] == "", v3
    print("✓ osm_roads: autoprueba correcta (%d + %d + %d vías)" % (len(vias), len(v2), len(v3)))


def main():
    ap = argparse.ArgumentParser(description="Extracto de OpenStreetMap → `vias` del cliente 3D")
    ap.add_argument("extracto", nargs="?", help="JSON de Overpass o GeoJSON")
    ap.add_argument("-o", "--out", help="fichero JSON de salida (por defecto, la salida estándar)")
    ap.add_argument("--merge", help="dubai.json en el que escribir la clave `vias` (se reescribe en sitio)")
    ap.add_argument("--barrio", action="store_true", help="incluir también residential/unclassified/living_street")
    ap.add_argument("--selftest", action="store_true", help="ejecutar la autoprueba y salir")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return 0
    if not args.extracto:
        ap.error("hace falta el extracto (o --selftest)")
    with open(args.extracto, encoding="utf-8") as f:
        doc = json.load(f)
    vias = convierte(doc, con_barrio=args.barrio)
    resumen = {}
    for v in vias:
        resumen[v["clase"]] = resumen.get(v["clase"], 0) + 1
    print("vías: %d (%s)" % (len(vias), ", ".join("%s %d" % kv for kv in sorted(resumen.items()))), file=sys.stderr)
    salida = {"attribution": ATTRIBUTION_OSM, "vias": vias}
    if args.merge:
        with open(args.merge, encoding="utf-8") as f:
            meta = json.load(f)
        meta["vias"] = vias
        atrib = meta.get("attribution") or ""
        if "OpenStreetMap" not in atrib:
            meta["attribution"] = (atrib + " · " if atrib else "") + ATTRIBUTION_OSM
        with open(args.merge, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print("escrito en %s (clave `vias`, atribución de OSM añadida)" % args.merge, file=sys.stderr)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(salida, f, ensure_ascii=False, indent=1)
            f.write("\n")
    elif not args.merge:
        json.dump(salida, sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
