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
# que ningún texto visible sugiere revalorización, rentabilidad, rendimiento,
# ganancia ni recuperación del capital.
INVERSION = {
    "es": [
        (palabra(r"revaloriz\w*"), "RAMI no tiene valor monetario: sin revalorización"),
        (palabra(r"rentab\w*"), "RAMI no tiene valor monetario: sin rentabilidad"),
        (palabra(r"rendimientos?"), "«fluidez», «coste» o la cifra medida (triángulos, cuadros por segundo)"),
        (palabra(r"ganancias?"), "RAMI no tiene valor monetario"),
        (palabra(r"oportunidad(?:es)? de inversi[oó]n"), "RAMI no es una inversión"),
        (palabra(r"invert(?:ir|ido|imos) en|inviert[ae]n? en"), "RAMI no es una inversión"),
        (palabra(r"inversi[oó]n(?:es)?|inversor(?:es|as?)?"), "RAMI no es una inversión"),
        (palabra(r"retorno de (?:la )?inversi[oó]n|ROI"), "RAMI no es una inversión"),
        # El vocabulario del retorno del capital (el mentor de la v0.9 lo usaba).
        (palabra(r"flujos? de caja|capital de entrada|plazo de recuperaci[oó]n|recuperaci[oó]n (?:[^\W\d_]+ ){0,3}(?:capital|inversi[oó]n)|recuper(?:a|as|an|ar) (?:el|tu|su) capital"),
         "lo que cuesta la parcela y lo que reparte el fondo por bloque, en RAMI de prueba"),
        (palabra(r"cu[aá]nto gan(?:o|as|a|an|aré|arás)"), "«cuánto reparte», en RAMI de prueba"),
    ],
    "en": [
        (palabra(r"appreciation|appreciates? in value"), "RAMI has no monetary value"),
        (palabra(r"investment opportunit(?:y|ies)|invest(?:ing|ed)? in|investments?|investors?"), "RAMI is not an investment"),
        # «returns» muerde solo, salvo cuando es el verbo: «the road returns to the
        # lane», «the level returns smoothly», «`/api/status` returns only…» (lo que
        # usan las notas). Como verbo lo sigue una de estas palabras; como
        # sustantivo, cualquier otra («Earn returns every block», «returns of 12 %»).
        (palabra(r"returns(?! (?:to|smoothly|only|home|back|immediately|the|a|an|its|their|his|her|it|them|when|after|once|null|true|false|nothing)(?![^\W\d_]))"),
         "RAMI has no monetary value"),
        (palabra(r"profit(?:s|able|ability)?"), "RAMI has no monetary value"),
        (palabra(r"ROI"), "RAMI is not an investment"),
        # «yield» también es ceder el paso (la calzada de la v0.10.4): solo el
        # rendimiento, con su adjetivo o con la cifra («yield 12%», «yields of 5 %»).
        (palabra(r"payback|pay back (?:the|your) capital|cash flows?|earnings|(?:annual|guaranteed|expected|high) yields?|yields? (?:on|of)|yields?(?= ?\d)"),
         "what the parcel costs and what the fund pays out per block, in test RAMI"),
        (palabra(r"how much (?:do|will|can) (?:i|you) earn"), "“how much does it pay out”, in test RAMI"),
    ],
    "zh": [
        (re.compile(r"升值|投资回报|回报率|收益|投资机会|盈利|投资|利润|回本|现金流|赚"), "RAMI 没有货币价值，不是投资"),
    ],
    "ru": [
        (palabra(r"доходност\w*|прибыл\w*|инвестиц\w*|рентабельн\w*|рост стоимости|окупаем\w*|окупа(?:ется|ются|ть)|денежн\w* пото\w*|заработа\w*"),
         "RAMI не имеет денежной стоимости и не является инвестицией"),
    ],
    "sw": [
        (palabra(r"faida|uwekezaji|kuwekeza|fursa ya uwekezaji|kupanda kwa thamani|urejeshaji(?: wa mtaji)?|kurejesha mtaji|mtiririko wa fedha"),
         "RAMI haina thamani ya kifedha na si uwekezaji"),
    ],
}

# Se permite la NEGACIÓN que el proyecto usa para decirlo, y solo esa: el término
# vale si lo niega una construcción de esta lista PEGADA a él —entre la negación
# y el término, como mucho un artículo, o el primer miembro de una enumeración
# negada («no mide acierto ni rentabilidad», «si uwekezaji wala faida»)—. Una
# negación suelta más atrás en la frase no niega el término y no vale: «No te
# pierdas esta oportunidad de inversión», «¿Por qué no invertir en Dubái?»,
# «Sin comisiones y con rentabilidad garantizada», «Don't miss this investment
# opportunity», «不要错过升值机会», «Не упустите доходность» muerden.
_VERBOS_ES = r"es|son|será|serán|fue|mide|miden|promete|prometen|ofrece|ofrecen|garantiza|garantizan|da|dan|genera|generan|busca|buscan|hay"
_VERBOS_EN = r"promise|promises|offer|offers|guarantee|guarantees|measure|measures|pay|pays|give|gives|generate|generates|seek|seeks"
_VERBOS_RU = r"является|являются|измеряет|измеряют|обещает|обещают|гарантирует|гарантируют|приносит|приносят|даёт|дает|дают"
NIEGA = {
    "es": (r"(?:no|ni|nunca) (?:%s)|ni|sin|ning[uú]n|ninguna" % _VERBOS_ES,
           r"un|una|el|la|los|las", r"ni|o"),
    "en": (r"(?:is|are|was|be|it's)(?: not|n't)|isn't|aren't|not|never|without|"
           r"(?:does|do|did|will|can|cannot)(?: not|n't)? (?:%s)|(?:nor|neither) (?:does|do|is|are) it(?: (?:%s))?" % (_VERBOS_EN, _VERBOS_EN),
           r"a|an|the|any", r"or|nor"),
    "ru": (r"не (?:%s)|не|ни|нет|без" % _VERBOS_RU, r"", r"или|ни"),
    "sw": (r"si|sio|siyo|wala|bila|hakuna|haina|hakipimi|hapimi|haiahidi|haitoi", r"", r"wala|au"),
}
_PAL = r"[^\W\d_]+"
NEGADO = {}
for _idioma, (_neg, _det, _conj) in NIEGA.items():
    _d = r"(?:(?:%s)\s+)?" % _det if _det else ""
    NEGADO[_idioma] = re.compile(
        r"(?<![^\W\d_'])(?:%s)\s+%s(?:(?:%s\s+){1,3}(?:%s)\s+%s)?$" % (_neg, _d, _PAL, _conj, _d), re.IGNORECASE)
# En chino, sin espacios: la negación pegada, o «不衡量命中率或收益».
NEGADO["zh"] = re.compile(r"(?:不是|并非|没有|无|不衡量|不承诺|不保证|不提供|不带来)(?:[\u4e00-\u9fff]{1,6}(?:或|和|、|也不))?$")
CLAUSULA = re.compile(r"[,;:.!?¿¡，；：。！？]")


def negado(idioma, texto, inicio):
    """¿Niega el término una construcción de NIEGA pegada a él, en su cláusula?"""
    antes = CLAUSULA.split(texto[:inicio])[-1]
    antes = re.sub(r"[*_`>]+", " ", antes)            # el Markdown (**no es**, > cita) no separa
    antes = re.sub(r"\s+", " ", antes)
    if idioma == "zh":
        return bool(NEGADO["zh"].search(antes.replace(" ", "")))
    patron = NEGADO.get(idioma)
    return bool(patron and patron.search(antes if antes.endswith(" ") or not antes else antes + " "))


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
# También la moneda escrita con palabras detrás de la cifra, en los cinco idiomas:
# «12 euros», «12 dólares», «12 dollars», «12 美元», «12 рублей», «shilingi 12».
MONEDA_PALABRA = (r"euros?|d[oó]lar(?:es)?|dollars?|dirhams?|d[ií]rhams?|libras?|pounds? sterling|yuan(?:es)?|"
                  r"rublos?|rubles?|евро|доллар\w*|рубл\w*|дирхам\w*|юан\w*|dola|yuro|shilingi")
MONEDA = re.compile(r"[€$£¥₽]\s?\d|\d\s?[€$£¥₽]|\b(?:US\$|USD|EUR|AED|GBP)\s?\d|\d\s?(?:USD|EUR|AED|GBP)\b|RAMI\s*[€$£¥₽]|[€$£¥₽]\s*RAMI|د\.إ|"
                    r"\d\s?(?i:" + MONEDA_PALABRA + r")(?![^\W\d_])|\d\s?(?:美元|欧元|人民币|迪拉姆|卢布|英镑)|(?i:dola|shilingi|yuro)\s\d")


def buscar_moneda(fichero, lineas):
    return ["%s:%d «%s» → el precio en RAMI, sin símbolo de moneda" % (fichero, linea, texto.strip()[:100])
            for linea, texto in lineas if MONEDA.search(texto)]


def literales_codigo(codigo, linea0=1):
    """Las cadenas de un JavaScript, sin comentarios: todo lo que puede acabar a la
    vista. En el visor no basta con los literales de t('…'): la guía de
    city/memoria.js pasa sus textos como datos (`t(P.titulo)`), y los de los otros
    módulos pueden ir igual. Las cadenas de código ('rami.memoria.guia',
    'position') no llevan léxico de estas listas; recorrer todas las del visor da
    cero falsos positivos (medido en la v0.11.0 sobre 1.943 cadenas)."""
    out = []
    sin = re.sub(r"/\*[\s\S]*?\*/", lambda x: re.sub(r"[^\n]", " ", x.group(0)), codigo)
    sin = re.sub(r"(^|[^:\\])//[^\n]*", lambda x: x.group(1), sin)
    for lit in re.finditer(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"", sin):
        texto = lit.group(1) if lit.group(1) is not None else lit.group(2)
        if len(texto) < 4:
            continue
        out.append((linea0 + sin[: lit.start()].count("\n"), texto))
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
        out += literales_codigo(m.group(1), codigo[: m.start()].count("\n") + 1)
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


def fuentes_cliente():
    """Todo lo que puede pedir un texto traducido: el panel, el visor y sus
    módulos, y el Rust (nombres de distritos y mensajes que llegan por la API)."""
    trozos = []
    for base, _, ficheros in os.walk(os.path.join(RAIZ, "chain", "crates")):
        if os.sep + "target" in base or os.sep + "vendor" in base:
            continue
        for f in ficheros:
            if f.endswith((".rs", ".js", ".html")) and f != "i18n.js":
                trozos.append(leer(os.path.join(base, f)))
    return "\n".join(trozos)


def viva(clave, fuentes):
    """¿Pide alguna fuente la clave entera? Como literal ("…" o '…', también
    escapada) o como texto de un elemento HTML (>…<). Una palabra suelta en un
    comentario de Rust no la mantiene viva."""
    for pre in ("@ph:", "@title:"):
        if clave.startswith(pre):
            clave = clave[len(pre):]
    formas = set([clave, clave.replace('"', '\\"'), clave.replace("'", "\\'"),
                  clave.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")])
    for f in formas:
        if re.search(r"""["'>]\s*""" + re.escape(f) + r"""\s*["'<]""", fuentes):
            return True
    return False


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
    # El visor 3D y sus módulos (v0.11.0): todas sus cadenas, no solo las de t().
    src = os.path.join(GUI, "src")
    visor = [os.path.join(src, "city3d.js")] + sorted(
        os.path.join(src, "city", f) for f in os.listdir(os.path.join(src, "city")) if f.endswith(".js"))
    for p in visor:
        if os.path.exists(p):
            rel = os.path.relpath(p, GUI)
            lineas = literales_codigo(leer(p))
            hallazgos += todo(rel, "es", lineas)
            monedas += buscar_moneda(rel, lineas)
    # Los diccionarios. Una traducción cuya clave española ya no aparece en
    # ninguna fuente del cliente es texto retirado: ningún t() la pide y no la
    # lee nadie. Se avisa (el integrador la poda de allkeys.json y lang_*.json)
    # pero no se rechaza; así un frente puede reescribir un texto sin tocar los
    # diccionarios compartidos.
    fuentes = fuentes_cliente()
    retiradas = set()
    for lang in ("en", "ru", "zh", "sw"):
        p = os.path.join(GUI, "i18n-src", "lang_%s.json" % lang)
        if not os.path.exists(p):
            continue
        d = json.load(open(p, encoding="utf-8"))
        rel = "i18n-src/lang_%s.json" % lang
        for i, (clave, v) in enumerate(d.items()):
            if not isinstance(v, str):
                continue
            h = todo(rel, lang, [(i + 1, v)]) + buscar_moneda(rel, [(i + 1, v)])
            if h and not viva(clave, fuentes):
                retiradas.add(clave)
                continue
            hallazgos += h
    # Fragmentos de traducción de cada frente (frag_*.json: {"es": {"en": …, …}})
    # antes de que el integrador los funda en lang_*.json. Un fragmento con otra
    # forma es un fallo con diagnóstico, no una traza.
    i18n = os.path.join(GUI, "i18n-src")
    for f in sorted(os.listdir(i18n)):
        if not (f.startswith("frag_") and f.endswith(".json")):
            continue
        try:
            d = json.load(open(os.path.join(i18n, f), encoding="utf-8"))
        except ValueError as e:
            hallazgos.append("i18n-src/%s: no es JSON válido (%s)" % (f, e))
            continue
        if not isinstance(d, dict):
            hallazgos.append("i18n-src/%s: se espera {\"texto en español\": {\"en\": …, \"zh\": …, \"ru\": …, \"sw\": …}}" % f)
            continue
        for i, (es, tr) in enumerate(d.items(), 1):
            hallazgos += todo("i18n-src/" + f, "es", [(i, es)])
            monedas += buscar_moneda("i18n-src/" + f, [(i, es)])
            if not isinstance(tr, dict):
                hallazgos.append("i18n-src/%s:%d «%s» → las traducciones van en un objeto {\"en\": …, \"zh\": …, \"ru\": …, \"sw\": …}" % (f, i, es[:60]))
                continue
            for lang, v in tr.items():
                if isinstance(v, str):
                    hallazgos += todo("i18n-src/%s[%s]" % (f, lang), lang, [(i, v)])
                    monedas += buscar_moneda("i18n-src/" + f, [(i, v)])
    for rel, lang in (("web/index.html", "es"), ("web/en/index.html", "en")):
        p = os.path.join(RAIZ, rel)
        if os.path.exists(p):
            lineas = visible_html(leer(p))
            hallazgos += todo(rel, lang, lineas)
            monedas += buscar_moneda(rel, lineas)
    for rel in ("README.md", "RELEASE_NOTES.md"):
        p = os.path.join(RAIZ, rel)
        if not os.path.exists(p):
            continue
        crudas = leer(p).split("\n")
        lineas = [(i + 1, l) for i, l in enumerate(crudas)]
        previas = [""] + crudas[:-1]
        for idioma in ("es", "en"):
            hallazgos += buscar(rel, idioma, lineas) + buscar_inversion(rel, idioma, lineas, previas)
        monedas += buscar_moneda(rel, lineas)
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
    for idioma, frase in (("es", "No te pierdas esta oportunidad de inversión"), ("es", "¿Por qué no invertir en Dubái?"),
                          ("es", "Sin comisiones y con rentabilidad garantizada"), ("en", "Don't miss this investment opportunity"),
                          ("en", "No fees and great returns on your parcel"), ("zh", "不要错过升值机会"), ("ru", "Не упустите доходность"),
                          ("es", "La recuperación es el capital dividido por el ingreso"), ("es", "1 · El capital de entrada"),
                          ("en", "payback in 300 blocks"), ("zh", "回本需要"), ("ru", "окупаемость через"), ("sw", "Pata faida kubwa")):
        assert buscar_inversion("x", idioma, [(1, frase)]), "una negación que no niega el término no vale: " + frase
    for idioma, frase in (("es", "no mide acierto ni rentabilidad"), ("en", "is never sold and is not an investment"),
                          ("ru", "она не измеряет меткость или доходность"), ("ru", "это не инвестиция"),
                          ("zh", "不衡量命中率或收益"), ("zh", "也不是投资"), ("sw", "hakipimi usahihi wala faida"),
                          ("es", "No es\n una inversión"), ("es", "La cartera tiene una pantalla de recuperación")):
        assert not buscar_inversion("x", idioma, [(1, frase)]), "la negación del proyecto se permite: " + frase
    # Ronda 2 de la memoria: la clase de letra de «recuperación … capital», el
    # «returns» y el «yield» sustantivos, la moneda con palabras y las cadenas del
    # visor que no pasan por t('…') directamente.
    for idioma, frase in (("es", "La recuperación del capital llega en 300 bloques"), ("es", "Recuperación de tu capital: 20 días"),
                          ("en", "Earn returns every block"), ("en", "returns of 12 %"), ("en", "yield 12%")):
        assert buscar_inversion("x", idioma, [(1, frase)]), "muerde: " + frase
    for idioma, frase in (("en", "the level returns smoothly"), ("en", "`/api/status` returns only version"), ("en", "cars yield to the tram")):
        assert not buscar_inversion("x", idioma, [(1, frase)]), "el verbo se permite: " + frase
    for frase in ("12 euros", "12 Dólares", "12 dollars", "12 美元", "12 рублей", "shilingi 12"):
        assert buscar_moneda("x", [(1, frase)]), "la moneda con palabras muerde: " + frase
    assert not buscar_moneda("x", [(1, "$ rami-node show --network regtest 10")]), "el indicador del intérprete no es un precio"
    assert buscar_inversion("x", "es", literales_codigo("var P = [{ titulo: 'Mira la rentabilidad de la ciudad' }]; // rentabilidad")), \
        "las cadenas del visor que llegan a t() como datos se revisan"
    assert not literales_codigo("/* 'rentabilidad' */ var a = 1; // 'rentabilidad'"), "los comentarios no cuentan"
    assert viva("Esta moneda", fuentes) and not viva("Clave retirada que no pide nadie 7f3a", fuentes), "la clave viva se encuentra"
    hallazgos += monedas
    if retiradas:
        print("Aviso: %d traducciones con léxico de la zona de inversión cuya clave ya no está en ninguna fuente "
              "(texto retirado; el integrador las poda de allkeys.json y lang_*.json):" % len(retiradas))
        for c in sorted(retiradas):
            print("  «%s»" % c[:100])
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
