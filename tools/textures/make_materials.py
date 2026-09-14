#!/usr/bin/env python3
"""Fabrica el juego de materiales de la ciudad: cuatro texturas teselables que
se empotran en el binario del monedero.

    python3 tools/textures/make_materials.py

Salida (chain/crates/rami-gui/src/tex/):

    asfalto.png    calzada: árido, poros, grietas y manchas de aceite
    hormigon.png   bordillos y peto: hormigón con poros y veladuras
    arena.png      desierto: grano fino con rizos de viento
    acera.png      losas de 60 cm con junta y tono propio por losa

Cada PNG es RGBA de 512x512: el RGB es el color base (albedo) y **el alfa es la
altura**, de la que el sombreador saca la normal derivándola. Un solo fichero
por material en vez de color + normal: la mitad de descarga y de memoria.

Por qué generadas y no fotográficas: el entorno donde se construye este proyecto
no alcanza las fuentes de dominio público (la red las rechaza), y meter arte con
una licencia sin verificar en el repositorio no es una opción. Estas texturas
son obra de este script, así que no arrastran licencia de nadie. Si algún día
entra un juego fotográfico CC0, sustituye estos cuatro ficheros y ya está: el
sombreador no cambia.

Sólo biblioteca estándar (zlib, struct, math, random), como el resto de
herramientas del proyecto. Tarda del orden de un minuto.

Todo es determinista: misma semilla, mismos bytes. Si el PNG cambia sin que
cambie este fichero, algo va mal.
"""
import math
import os
import struct
import zlib

ANCHO = 512
RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SALIDA = os.path.join(RAIZ, "chain", "crates", "rami-gui", "src", "tex")


# ---------------------------------------------------------------- ruido -----
def lcg(semilla):
    """El mismo generador entero que usa el cliente 3D: reproducible en todas
    partes y sin depender de la implementación de random de cada versión."""
    estado = [semilla & 0xFFFFFFFF or 1]

    def siguiente():
        estado[0] = (estado[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return estado[0] / 4294967296.0

    return siguiente


def lattice(n, semilla):
    """Rejilla n x n de valores en [0,1), que se lee de forma PERIÓDICA: es lo
    que hace que la textura empalme consigo misma sin costura."""
    r = lcg(semilla)
    return [[r() for _ in range(n)] for _ in range(n)]


def suave(t):
    return t * t * (3.0 - 2.0 * t)


def muestrea(rej, n, x, y):
    """Valor interpolado en (x,y), con x,y en celdas de la rejilla."""
    x0 = int(math.floor(x)) % n
    y0 = int(math.floor(y)) % n
    x1 = (x0 + 1) % n
    y1 = (y0 + 1) % n
    fx = suave(x - math.floor(x))
    fy = suave(y - math.floor(y))
    a = rej[y0][x0] + (rej[y0][x1] - rej[y0][x0]) * fx
    b = rej[y1][x0] + (rej[y1][x1] - rej[y1][x0]) * fx
    return a + (b - a) * fy


def fbm(semilla, octavas, base, persistencia=0.5):
    """Campo de ruido fractal de ANCHO x ANCHO, teselable. Devuelve una lista
    plana de flotantes en [0,1]."""
    campo = [0.0] * (ANCHO * ANCHO)
    amp = 1.0
    total = 0.0
    for o in range(octavas):
        n = base * (2 ** o)
        if n > ANCHO:
            break
        rej = lattice(n, semilla + o * 7919)
        esc = n / float(ANCHO)
        for y in range(ANCHO):
            fy = y * esc
            fila = y * ANCHO
            for x in range(ANCHO):
                campo[fila + x] += muestrea(rej, n, x * esc, fy) * amp
        total += amp
        amp *= persistencia
    inv = 1.0 / total if total else 1.0
    return [v * inv for v in campo]


def mezcla(a, b, t):
    return a + (b - a) * t


def recorta(v, lo=0.0, hi=1.0):
    return lo if v < lo else (hi if v > hi else v)


# ------------------------------------------------------------------ PNG -----
def trozo(tag, cuerpo):
    return (struct.pack(">I", len(cuerpo)) + tag + cuerpo
            + struct.pack(">I", zlib.crc32(tag + cuerpo) & 0xFFFFFFFF))


def escribe_rgba(ruta, pixeles):
    """PNG RGBA de 8 bits con filtro por fila elegido por suma de diferencias
    absolutas (el mismo criterio que usa la mayoría de codificadores)."""
    crudo = bytearray()
    ancho4 = ANCHO * 4
    anterior = bytearray(ancho4)
    for y in range(ANCHO):
        fila = pixeles[y * ancho4:(y + 1) * ancho4]
        mejor, mejor_suma, mejor_tipo = None, None, 0
        for tipo in (0, 1, 2, 3, 4):
            cand = bytearray(ancho4)
            for i in range(ancho4):
                izq = fila[i - 4] if i >= 4 else 0
                arr = anterior[i]
                dia = anterior[i - 4] if i >= 4 else 0
                if tipo == 0:
                    p = 0
                elif tipo == 1:
                    p = izq
                elif tipo == 2:
                    p = arr
                elif tipo == 3:
                    p = (izq + arr) >> 1
                else:
                    pp = izq + arr - dia
                    pa, pb, pc = abs(pp - izq), abs(pp - arr), abs(pp - dia)
                    p = izq if (pa <= pb and pa <= pc) else (arr if pb <= pc else dia)
                cand[i] = (fila[i] - p) & 0xFF
            suma = sum(v if v < 128 else 256 - v for v in cand)
            if mejor_suma is None or suma < mejor_suma:
                mejor, mejor_suma, mejor_tipo = cand, suma, tipo
        crudo.append(mejor_tipo)
        crudo.extend(mejor)
        anterior = fila
    ihdr = struct.pack(">IIBBBBB", ANCHO, ANCHO, 8, 6, 0, 0, 0)
    datos = zlib.compress(bytes(crudo), 9)
    with open(ruta, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + trozo(b"IHDR", ihdr)
                + trozo(b"IDAT", datos) + trozo(b"IEND", b""))
    return os.path.getsize(ruta)


def a_srgb(c):
    """Curva de transferencia sRGB. El cliente tiene canal de color físico desde
    la v0.10.0: lee las texturas como sRGB y las pasa a lineal para iluminarlas.
    Guardar aquí el valor lineal en crudo dejaría el asfalto diez veces más
    oscuro de lo que toca."""
    c = recorta(c)
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1.0 / 2.4)) - 0.055


def empaqueta(fn):
    """fn(x, y) -> (r, g, b, altura) en lineal [0,1]. El color sale codificado en
    sRGB; la altura NO, porque es un dato y no un color."""
    px = bytearray(ANCHO * ANCHO * 4)
    i = 0
    for y in range(ANCHO):
        for x in range(ANCHO):
            r, g, b, h = fn(x, y)
            px[i] = int(a_srgb(r) * 255 + 0.5)
            px[i + 1] = int(a_srgb(g) * 255 + 0.5)
            px[i + 2] = int(a_srgb(b) * 255 + 0.5)
            px[i + 3] = int(recorta(h) * 255 + 0.5)
            i += 4
    return px


# ------------------------------------------------------------ materiales ----
def asfalto():
    """Aglomerado: árido visible, poros, veladuras de rodadura y alguna grieta.
    El asfalto real no es gris liso: es piedra pegada con betún."""
    arido = fbm(1301, 5, 64)          # los granos
    poro = fbm(2711, 4, 128)          # el picado fino
    mancha = fbm(4099, 3, 8)          # veladuras grandes de aceite y desgaste
    grieta = fbm(5507, 3, 6)

    def pixel(x, y):
        i = y * ANCHO + x
        a, p, m, g = arido[i], poro[i], mancha[i], grieta[i]
        # Los granos: los valores altos del ruido fino son piedra clara.
        piedra = recorta((a - 0.56) * 5.0)
        base = mezcla(0.055, 0.135, piedra)
        base *= mezcla(0.82, 1.12, m)          # zonas más y menos desgastadas
        base *= mezcla(1.0, 0.86, recorta((p - 0.6) * 3.0))
        # Grietas: la cresta del ruido, estrecha y oscura.
        cr = 1.0 - recorta(abs(g - 0.5) * 14.0)
        base *= mezcla(1.0, 0.45, cr * cr)
        # Un punto de color: el betún tira a azulado, el árido a cálido.
        r = base * mezcla(0.97, 1.06, piedra)
        gr = base * 1.0
        b = base * mezcla(1.08, 0.97, piedra)
        alt = recorta(0.45 + (a - 0.5) * 0.7 + (p - 0.5) * 0.25 - cr * 0.35)
        return (r, gr, b, alt)

    return pixel


def hormigon():
    """Hormigón visto: pasta clara, poros de aire y veladuras de escorrentía."""
    pasta = fbm(911, 5, 48)
    poro = fbm(1733, 3, 160)
    velo = fbm(3271, 3, 5)

    def pixel(x, y):
        i = y * ANCHO + x
        pa, po, ve = pasta[i], poro[i], velo[i]
        base = mezcla(0.52, 0.68, pa)
        base *= mezcla(0.88, 1.06, ve)
        hueco = recorta((po - 0.72) * 6.0)      # burbujas de aire
        base *= mezcla(1.0, 0.68, hueco)
        r = base * 1.02
        g = base * 1.0
        b = base * 0.955                        # el cemento tira a cálido
        alt = recorta(0.6 + (pa - 0.5) * 0.4 - hueco * 0.55)
        return (r, g, b, alt)

    return pixel


def arena():
    """Desierto: grano fino y rizos de viento, que es lo que da la escala."""
    grano = fbm(6151, 5, 96)
    rizo = fbm(7477, 2, 12)
    duna = fbm(8599, 2, 4)

    def pixel(x, y):
        i = y * ANCHO + x
        gr, ri, du = grano[i], rizo[i], duna[i]
        # Rizos: onda a lo largo de una dirección, modulada por ruido.
        onda = 0.5 + 0.5 * math.sin((x * 0.14 + ri * 9.0) + du * 3.0)
        base = mezcla(0.62, 0.80, gr)
        base *= mezcla(0.93, 1.05, onda)
        base *= mezcla(0.96, 1.04, du)
        r = base * 1.06
        g = base * 0.96
        b = base * 0.74                         # arena cálida
        alt = recorta(0.5 + (onda - 0.5) * 0.5 + (gr - 0.5) * 0.35)
        return (r, g, b, alt)

    return pixel


def acera():
    """Losas de 60 cm: junta rehundida y cada losa con su tono, que es lo que
    delata una acera de verdad frente a una superficie lisa."""
    fino = fbm(4421, 4, 128)
    sucio = fbm(5839, 3, 7)
    LOSA = ANCHO // 8                           # 8 losas por lado

    def pixel(x, y):
        i = y * ANCHO + x
        fi, su = fino[i], sucio[i]
        # Junta: franja oscura y rehundida en los bordes de cada losa.
        dx = min(x % LOSA, LOSA - 1 - (x % LOSA))
        dy = min(y % LOSA, LOSA - 1 - (y % LOSA))
        borde = min(dx, dy)
        junta = 1.0 - recorta(borde / 3.0)
        # Tono propio de cada losa, estable: depende solo de su índice.
        ix, iy = x // LOSA, y // LOSA
        h = (ix * 73856093) ^ (iy * 19349663)
        tono = ((h * 2654435761) & 0xFFFF) / 65535.0
        base = mezcla(0.58, 0.74, fi) * mezcla(0.94, 1.06, tono)
        base *= mezcla(1.0, 0.88, recorta((su - 0.55) * 2.5))
        base *= mezcla(1.0, 0.55, junta)
        r = base * 1.01
        g = base * 1.0
        b = base * 0.965
        alt = recorta(0.72 + (fi - 0.5) * 0.18 - junta * 0.7)
        return (r, g, b, alt)

    return pixel


def main():
    os.makedirs(SALIDA, exist_ok=True)
    total = 0
    for nombre, fabrica in (("asfalto", asfalto), ("hormigon", hormigon),
                            ("arena", arena), ("acera", acera)):
        print("generando", nombre, "…", flush=True)
        px = empaqueta(fabrica())
        ruta = os.path.join(SALIDA, nombre + ".png")
        n = escribe_rgba(ruta, px)
        total += n
        print("  %s  %d x %d RGBA  %.0f KB" % (nombre + ".png", ANCHO, ANCHO, n / 1024.0))
    print("total %.2f MB en %s" % (total / 1048576.0, os.path.relpath(SALIDA, RAIZ)))


if __name__ == "__main__":
    main()
