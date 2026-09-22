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


# La zona de inversión (docs/METAVERSO.md §8): cuanto más creíble es la ciudad,
# más se parece a una inversión. RAMI no tiene valor monetario (NOTICE.md), así
# que ningún texto visible sugiere revalorización, rentabilidad, rendimiento ni
# ganancia. Se permite la NEGACIÓN que el proyecto usa para decirlo: el término
# vale si en su misma frase (sin cruzar «, ; : . ! ?») lo precede, a seis
# palabras como mucho (doce caracteres en chino), una negación: «no es una
# inversión», «ni promete rentabilidad», «not an investment», «nor does it
# promise returns», «не является инвестицией», «不是投资», «si uwekezaji».
INVERSION = {
    "es": [
        (palabra(r"revaloriz\w*"), "RAMI no tiene valor monetario: sin revalorización"),
        (palabra(r"rentab\w*"), "RAMI no tiene valor monetario: sin rentabilidad"),
        (palabra(r"rendimientos?"), "«fluidez», «coste» o la cifra medida (triángulos, cuadros por segundo)"),
        (palabra(r"ganancias? (?:asegurad|garantizad)\w*"), "RAMI no tiene valor monetario"),
        (palabra(r"oportunidad(?:es)? de inversi[oó]n"), "RAMI no es una inversión"),
        (palabra(r"invert(?:ir|ido|imos) en|inviert[ae]n? en"), "RAMI no es una inversión"),
        (palabra(r"inversi[oó]n(?:es)?|inversor(?:es|as?)?"), "RAMI no es una inversión"),
        (palabra(r"retorno de (?:la )?inversi[oó]n|ROI"), "RAMI no es una inversión"),
    ],
    "en": [
        (palabra(r"appreciation|appreciates? in value"), "RAMI has no monetary value"),
        (palabra(r"investment opportunit(?:y|ies)|invest(?:ing|ed)? in|investments?|investors?"), "RAMI is not an investment"),
        # «returns» también es un verbo («the road returns to the lane»): solo en su sentido financiero.
        (palabra(r"(?:financial|investment|guaranteed|expected|high|higher|annual|promised?|big|good|positive|future) returns|returns on"), "RAMI has no monetary value"),
        (palabra(r"profit(?:s|able|ability)?"), "RAMI has no monetary value"),
        (palabra(r"ROI"), "RAMI is not an investment"),
    ],
    "zh": [
        (re.compile(r"升值|投资回报|回报率|收益|投资机会|盈利|投资|利润"), "RAMI 没有货币价值，不是投资"),
    ],
    "ru": [
        (palabra(r"доходност\w*|прибыл\w*|инвестиц\w*|рентабельн\w*|рост стоимости"), "RAMI не имеет денежной стоимости и не является инвестицией"),
    ],
    "sw": [
        (palabra(r"faida|uwekezaji|kuwekeza|fursa ya uwekezaji|kupanda kwa thamani"), "RAMI haina thamani ya kifedha na si uwekezaji"),
    ],
}
NEGACION = {
    "es": palabra(r"no|ni|sin|nunca|jam[aá]s|ning[uú]n[oa]?|nada"),
    "en": palabra(r"not|no|nor|never|without|neither|none|cannot|n't"),
    "ru": palabra(r"не|ни|нет|без|никогда"),
    "zh": re.compile(r"不|没有|无|非|并非|绝不|从不"),
    "sw": palabra(r"si|sio|siyo|wala|bila|hakuna|kamwe|haina|hakipimi|hapimi"),
}
CLAUSULA = re.compile(r"[,;:.!?，；：。！？]")


def negado(idioma, texto, inicio):
    """¿Hay una negación antes del término, en su misma cláusula y cerca?"""
    antes = CLAUSULA.split(texto[:inicio])[-1]
    if idioma == "zh":
        return bool(NEGACION["zh"].search(antes[-12:]))
    palabras = re.findall(r"[^\W\d_]+(?:'[^\W\d_]+)?", antes)[-6:]
    return any(NEGACION[idioma].fullmatch(p) or (idioma == "en" and p.lower().endswith("n't")) for p in palabras)


def buscar_inversion(fichero, idioma, lineas, previas=None):
    """`previas[i]`: la línea anterior de un texto partido (Markdown), para que la
    negación que queda al final de una línea cuente para el término de la siguiente."""
    hallazgos = []
    for n, (linea, texto) in enumerate(lineas):
        antes = (previas[n] + " ") if previas else ""
        for patron, sustituto in INVERSION.get(idioma, []):
            for m in patron.finditer(texto):
                if not negado(idioma, antes + texto, len(antes) + m.start()):
                    hallazgos.append("%s:%d [%s] «%s» → %s" % (fichero, linea, idioma, texto.strip()[:100], sustituto))
                    break
    return hallazgos


# Un precio de la ciudad va en RAMI y nunca junto a un símbolo de moneda.
MONEDA = re.compile(r"[€$£¥₽]\s?\d|\d\s?[€$£¥₽]|\b(?:US\$|USD|EUR|AED|GBP)\s?\d|\d\s?(?:USD|EUR|AED|GBP)\b|RAMI\s*[€$£¥₽]|[€$£¥₽]\s*RAMI|د\.إ")


def buscar_moneda(fichero, lineas):
    return ["%s:%d «%s» → el precio en RAMI, sin símbolo de moneda" % (fichero, linea, texto.strip()[:100])
            for linea, texto in lineas if MONEDA.search(texto)]


def literales_t(codigo):
    """Textos del visor 3D: las cadenas que pasan por t('…') / ctx.t('…')."""
    out = []
    for m in re.finditer(r"(?<![A-Za-z0-9_$])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\")", codigo):
        texto = m.group(1) if m.group(1) is not None else m.group(2)
        out.append((codigo[: m.start()].count("\n") + 1, texto))
    return out


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


def todo(fichero, idioma, lineas):
    """Léxico estimativo, zona de inversión y símbolos de moneda."""
    return buscar(fichero, idioma, lineas) + buscar_inversion(fichero, idioma, lineas)


def main():
    hallazgos, monedas = [], []
    panel = os.path.join(GUI, "src", "dashboard.html")
    html = leer(panel)
    for lineas in (visible_html(html), literales_js(html)):
        hallazgos += todo("dashboard.html", "es", lineas)
        monedas += buscar_moneda("dashboard.html", lineas)
    # El visor 3D y sus módulos (v0.11.0): lo que pasa por t().
    src = os.path.join(GUI, "src")
    visor = [os.path.join(src, "city3d.js")] + sorted(
        os.path.join(src, "city", f) for f in os.listdir(os.path.join(src, "city")) if f.endswith(".js"))
    for p in visor:
        if os.path.exists(p):
            rel = os.path.relpath(p, GUI)
            lineas = literales_t(leer(p))
            hallazgos += todo(rel, "es", lineas)
            monedas += buscar_moneda(rel, lineas)
    for lang in ("en", "ru", "zh", "sw"):
        p = os.path.join(GUI, "i18n-src", "lang_%s.json" % lang)
        if not os.path.exists(p):
            continue
        d = json.load(open(p, encoding="utf-8"))
        lineas = [(i + 1, v) for i, v in enumerate(d.values()) if isinstance(v, str)]
        hallazgos += todo("i18n-src/lang_%s.json" % lang, lang, lineas)
        monedas += buscar_moneda("i18n-src/lang_%s.json" % lang, lineas)
    # Fragmentos de traducción de cada frente (frag_*.json: {"es": {"en": …, …}})
    # antes de que el integrador los funda en lang_*.json.
    i18n = os.path.join(GUI, "i18n-src")
    for f in sorted(os.listdir(i18n)):
        if not (f.startswith("frag_") and f.endswith(".json")):
            continue
        d = json.load(open(os.path.join(i18n, f), encoding="utf-8"))
        for i, (es, tr) in enumerate(d.items(), 1):
            hallazgos += todo("i18n-src/" + f, "es", [(i, es)])
            monedas += buscar_moneda("i18n-src/" + f, [(i, es)])
            for lang, v in (tr or {}).items():
                if isinstance(v, str):
                    hallazgos += todo("i18n-src/%s[%s]" % (f, lang), lang, [(i, v)])
                    monedas += buscar_moneda("i18n-src/" + f, [(i, v)])
    for rel, lang in (("web/index.html", "es"), ("web/en/index.html", "en")):
        p = os.path.join(RAIZ, rel)
        if os.path.exists(p):
            hallazgos += todo(rel, lang, visible_html(leer(p)))
    for rel in ("README.md", "RELEASE_NOTES.md"):
        p = os.path.join(RAIZ, rel)
        if not os.path.exists(p):
            continue
        crudas = leer(p).split("\n")
        lineas = [(i + 1, l) for i, l in enumerate(crudas)]
        previas = [""] + crudas[:-1]
        for idioma in ("es", "en"):
            hallazgos += buscar(rel, idioma, lineas) + buscar_inversion(rel, idioma, lineas, previas)
    # El auditor se vigila a sí mismo: si dejara de ver texto, pasaría en silencio.
    prueba = visible_html('<p title="Quizá mañana">Es <b>probable</b></p>\n<!-- podría no -->')
    assert buscar("x", "es", prueba), "los patrones no muerden"
    assert not buscar("x", "en", [(1, "The download could not be started")]), "«could not» no es estimativo"
    assert not buscar("x", "es", [(1, "improbable (20–45 %)")]), "los términos de la escala se permiten"
    assert not buscar("x", "zh", [(1, "很可能 (55–80 %)")]), "el término chino con rango se permite"
    assert not buscar("x", "ru", [(1, "ваше «вероятно» в 55–80 % случаев")]), "el término citado se permite"
    assert buscar("x", "zh", [(1, "明天可能下雨")]), "el adverbio suelto sí muerde"
    # La zona de inversión: la afirmación muerde, la negación del proyecto no.
    assert buscar_inversion("x", "es", [(1, "Tu parcela tendrá una gran revalorización")]), "«revalorización» muerde"
    assert buscar_inversion("x", "es", [(1, "Una oportunidad de inversión en Dubái")]), "«oportunidad de inversión» muerde"
    assert buscar_inversion("x", "en", [(1, "Great returns on your parcel")]), "«returns on» muerde"
    assert buscar_inversion("x", "zh", [(1, "你的地块会升值")]), "«升值» muerde"
    assert buscar_inversion("x", "ru", [(1, "Высокая доходность участка")]), "«доходность» muerde"
    assert buscar_inversion("x", "sw", [(1, "Pata faida kubwa")]), "«faida» muerde"
    for idioma, frase in (("es", "no es una inversión ni promete rentabilidad"), ("en", "It is not an investment nor does it promise returns"),
                          ("ru", "не является инвестицией"), ("zh", "不是投资"), ("sw", "si uwekezaji wala faida"),
                          ("en", "the road returns to the lane")):
        assert not buscar_inversion("x", idioma, [(1, frase)]), "la negación y el verbo se permiten: " + frase
    assert buscar_inversion("x", "es", [(1, "No lo dudes, la rentabilidad es alta")]), "una negación en otra cláusula no vale"
    assert buscar_moneda("x", [(1, "Parcela: 80 €")]) and buscar_moneda("x", [(1, "$25 RAMI")]), "el símbolo junto al precio muerde"
    assert not buscar_moneda("x", [(1, "Parcela libre: 80 RAMI")]), "el precio en RAMI se permite"
    hallazgos += monedas
    if hallazgos:
        print("Léxico prohibido (ICD 203 §2.6, zona de inversión o símbolo de moneda) en la copia visible:")
        for h in hallazgos:
            print("  " + h)
        print("\nReescribe con la palabra exacta: hechos con números, o un término de la escala con su rango;"
              "\nRAMI no tiene valor monetario ni es una inversión, y sus precios van en RAMI.")
        sys.exit(1)
    print("OK: sin léxico prohibido ni zona de inversión en el panel (5 idiomas), el visor 3D, la web, el README ni las notas.")


if __name__ == "__main__":
    main()
