#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""La palabra exacta: el léxico prohibido no entra en lo que lee una persona.

Por qué existe: «podría», «quizá», «es posible», «sugiere que», «no se
descarta» —y sus equivalentes en inglés, chino, ruso y suajili— trasladan al
lector la carga de estimar y no se pueden refutar nunca. Este proyecto habla
con hechos («altura 1234, mejor par 1240») y con juicios explícitos («fuente
B2»), no con adverbios. Se recorre todo lo visible: el panel del monedero
(HTML y los cinco diccionarios), la web (es/en), el README y las notas de
versión. Los comentarios de código quedan fuera; las páginas legales también.

Uso: python3 tools/panel/lexico.py   (sale 1 si encuentra algo)
"""
import json
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GUI = os.path.join(RAIZ, "chain", "crates", "rami-gui")

# Frontera de palabra Unicode: \b en `re` es ASCII salvo con str, pero «quizá»
# acaba en «á» y hay que decirlo explícitamente.
NI_ANTES = r"(?<![^\W\d_])"
NI_DESPUES = r"(?![^\W\d_])"


def palabra(cuerpo):
    return re.compile(NI_ANTES + "(?:" + cuerpo + ")" + NI_DESPUES, re.IGNORECASE)


PROHIBIDO = {
    "es": [
        (palabra(r"podr[ií]a(?:n|s|mos)?"), "un término de la escala con su rango"),
        (palabra(r"es posible"), "un término de la escala con su rango"),
        (palabra(r"posiblemente"), "un término de la escala con su rango"),
        (palabra(r"quiz[áa]s?"), "un término de la escala con su rango"),
        (palabra(r"tal vez"), "un término de la escala con su rango"),
        (palabra(r"probablemente"), "el término y rango que salgan del cálculo"),
        (palabra(r"seguramente"), "el término y rango que salgan del cálculo"),
        (palabra(r"pueden? que"), "el término y rango que salgan del cálculo"),
        (palabra(r"parece que"), "el término y rango que salgan del cálculo"),
        (palabra(r"sugieren? que"), "«indica, con fuente X, que…»"),
        (palabra(r"no se descartan?"), "«improbable (20–45 %)»"),
        (palabra(r"fuentes indican"), "la fuente descrita y graduada"),
        (palabra(r"algunos analistas"), "la alternativa nombrada y su base"),
    ],
    "en": [
        # «could not» no es estimativo y se permite; «could be/happen» sí lo es.
        (palabra(r"could (?:happen|occur|be|rise|fall|reach|still)"), "a term from the scale with its range"),
        (palabra(r"might"), "a term from the scale with its range"),
        (palabra(r"possibly"), "a term from the scale with its range"),
        (palabra(r"perhaps"), "a term from the scale with its range"),
        (palabra(r"probably"), "the term and range from the calculation"),
        (palabra(r"likely"), "the term and range from the calculation"),
        (palabra(r"it is possible that"), "a term from the scale with its range"),
        (palabra(r"suggests? that"), "“indicates, with source X, that…”"),
        (palabra(r"cannot be ruled out"), "“unlikely (20–45 %)”"),
        (palabra(r"sources indicate"), "the source, described and graded"),
    ],
    "ru": [
        (palabra(r"возможно|может быть|вероятно|пожалуй|нельзя исключать|скорее всего"), "термин шкалы с диапазоном"),
    ],
    "zh": [
        (re.compile(r"可能|也许|或许|大概|不排除|恐怕"), "量表术语及其区间"),
    ],
    "sw": [
        # «huenda» también es «va» (hu-enda) y «yawezekana» es el término de la escala: fuera.
        (palabra(r"labda|pengine|yamkini"), "neno la kipimo na masafa yake"),
    ],
}


def visible_html(html):
    """Texto entre etiquetas y atributos legibles, por línea; comentarios fuera."""
    sin = re.sub(r"<!--[\s\S]*?-->", lambda m: re.sub(r"[^\n]", " ", m.group(0)), html)
    sin = re.sub(r"<script[\s\S]*?</script>", lambda m: re.sub(r"[^\n]", " ", m.group(0)), sin)
    sin = re.sub(r"<style[\s\S]*?</style>", lambda m: re.sub(r"[^\n]", " ", m.group(0)), sin)
    out = []
    for i, raw in enumerate(sin.split("\n"), 1):
        atributos = re.findall(r'\b(?:aria-label|title|placeholder|content|alt)="([^"]*)"', raw)
        texto = re.sub(r"<[^>]*>", " ", raw)
        junto = " ".join([texto] + atributos)
        if junto.strip():
            out.append((i, junto))
    return out


def literales_js(codigo):
    """Cadenas de los bloques <script> del panel (lo que escribe el JS)."""
    out = []
    for m in re.finditer(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", codigo):
        bloque = m.group(1)
        linea0 = codigo[: m.start()].count("\n") + 1
        sin = re.sub(r"/\*[\s\S]*?\*/", lambda x: re.sub(r"[^\n]", " ", x.group(0)), bloque)
        sin = re.sub(r"(^|[^:\\])//[^\n]*", lambda x: x.group(1), sin)
        for lit in re.finditer(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"", sin):
            texto = lit.group(1) if lit.group(1) is not None else lit.group(2)
            if len(texto) < 4:
                continue
            out.append((linea0 + sin[: lit.start()].count("\n"), texto))
    return out


# Lo que SÍ se permite, en cualquier idioma: un término de la escala con su
# rango («probable (55–80 %)», «很可能 (55–80 %)») y un término citado entre
# comillas (la doctrina se explica citando sus propias palabras). Se borran
# antes de buscar, para que «可能» dentro de «很可能 (55–80 %)» no cuente.
PERMITIDO = [
    re.compile(r"[^\s()«»“”\"]{1,40}\s*\(\d+[–-]\d+\s*%\)"),
    re.compile(r"[«“\"][^«»“”\"]{1,60}[»”\"]"),
]


def sin_permitidos(texto):
    for patron in PERMITIDO:
        texto = patron.sub(" ", texto)
    return texto


def buscar(fichero, idioma, lineas):
    hallazgos = []
    for linea, texto in lineas:
        texto = sin_permitidos(texto)
        for patron, sustituto in PROHIBIDO.get(idioma, []):
            if patron.search(texto):
                hallazgos.append("%s:%d [%s] «%s» → %s" % (fichero, linea, idioma, texto.strip()[:100], sustituto))
    return hallazgos


def leer(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def main():
    hallazgos = []
    panel = os.path.join(GUI, "src", "dashboard.html")
    html = leer(panel)
    hallazgos += buscar("dashboard.html", "es", visible_html(html))
    hallazgos += buscar("dashboard.html", "es", literales_js(html))
    for lang in ("en", "ru", "zh", "sw"):
        p = os.path.join(GUI, "i18n-src", "lang_%s.json" % lang)
        if not os.path.exists(p):
            continue
        d = json.load(open(p, encoding="utf-8"))
        lineas = [(i + 1, v) for i, v in enumerate(d.values()) if isinstance(v, str)]
        hallazgos += buscar("i18n-src/lang_%s.json" % lang, lang, lineas)
    for rel, lang in (("web/index.html", "es"), ("web/en/index.html", "en")):
        p = os.path.join(RAIZ, rel)
        if os.path.exists(p):
            hallazgos += buscar(rel, lang, visible_html(leer(p)))
    for rel in ("README.md", "RELEASE_NOTES.md"):
        p = os.path.join(RAIZ, rel)
        if not os.path.exists(p):
            continue
        lineas = [(i + 1, l) for i, l in enumerate(leer(p).split("\n"))]
        hallazgos += buscar(rel, "es", lineas)
        hallazgos += buscar(rel, "en", lineas)
    # El auditor se vigila a sí mismo: si dejara de ver texto, pasaría en silencio.
    prueba = visible_html('<p title="Quizá mañana">Es <b>probable</b></p>\n<!-- podría no -->')
    assert buscar("x", "es", prueba), "los patrones no muerden"
    assert not buscar("x", "en", [(1, "The download could not be started")]), "«could not» no es estimativo"
    assert not buscar("x", "es", [(1, "improbable (20–45 %)")]), "los términos de la escala se permiten"
    assert not buscar("x", "zh", [(1, "很可能 (55–80 %)")]), "el término chino con rango se permite"
    assert not buscar("x", "ru", [(1, "ваше «вероятно» в 55–80 % случаев")]), "el término citado se permite"
    assert buscar("x", "zh", [(1, "明天可能下雨")]), "el adverbio suelto sí muerde"
    if hallazgos:
        print("Léxico prohibido (ICD 203 §2.6) en la copia visible:")
        for h in hallazgos:
            print("  " + h)
        print("\nReescribe con la palabra exacta: hechos con números, o un término de la escala con su rango.")
        sys.exit(1)
    print("OK: sin léxico prohibido en el panel (5 idiomas), la web, el README ni las notas.")


if __name__ == "__main__":
    main()
