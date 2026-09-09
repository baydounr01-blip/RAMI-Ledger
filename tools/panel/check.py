#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Comprobaciones del panel del monedero (dashboard.html + i18n.js).

Por qué existe: el panel es un archivo HTML con JavaScript dentro que ningún
test de Rust mira. Un paréntesis de más o un `getElementById` a un id que ya no
existe no rompen la compilación, pero dejan el monedero MUDO en el navegador —
que es exactamente el fallo que se vivió al pasar de la v0.7.1 a la v0.7.2. Esto
lo comprueba en cada push:

  1) sintaxis de todo el JavaScript (los bloques <script> y el diccionario);
  2) todo `getElementById("x")` apunta a un `id="x"` que existe de verdad;
  3) informe (no bloqueante) de textos visibles sin traducir en en/ru/sw/zh.

Uso: python3 tools/panel/check.py [--strict-i18n]
"""

import json
import os
import re
import subprocess
import sys
import tempfile

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PANEL = os.path.join(RAIZ, "chain", "crates", "rami-gui", "src", "dashboard.html")
I18N = os.path.join(RAIZ, "chain", "crates", "rami-gui", "src", "i18n.js")

fallos = []


def leer(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def node_check(nombre, codigo):
    """`node --check`: sintaxis, sin ejecutar nada."""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(codigo)
        tmp = f.name
    try:
        r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        if r.returncode != 0:
            fallos.append("sintaxis JavaScript en %s:\n%s" % (nombre, r.stderr.strip()))
            return False
        return True
    finally:
        os.unlink(tmp)


def main():
    estricto = "--strict-i18n" in sys.argv
    html = leer(PANEL)
    i18n_js = leer(I18N)

    # 1) Sintaxis.
    bloques = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S)
    if not bloques:
        fallos.append("no encontré ningún bloque <script> en dashboard.html")
    for i, b in enumerate(bloques):
        node_check("dashboard.html <script> #%d" % (i + 1), b)
    node_check("i18n.js", i18n_js)

    # 2) Cada getElementById apunta a un id real.
    ids = set(re.findall(r'\bid="([^"]+)"', html))
    pedidos = set(re.findall(r'getElementById\(\s*"([^"]+)"\s*\)', html))
    huerfanos = sorted(pedidos - ids)
    if huerfanos:
        fallos.append("getElementById a ids que no existen: " + ", ".join(huerfanos))

    # 3) Traducciones. Clave = texto original en español, con los espacios
    #    normalizados igual que hace applyLang() en el panel.
    dicts = {}
    for lang in re.findall(r'^"([a-z]{2})": \{$', i18n_js, re.M):
        cuerpo = re.search(r'^"%s": \{\n(.*?)\n\},?\n' % lang, i18n_js, re.S | re.M).group(1)
        dicts[lang] = json.loads("{" + cuerpo + "}")

    cuerpo_html = re.sub(r"<style[^>]*>.*?</style>", " ", html.split("<script")[0], flags=re.S)
    # Ni rutas, ni URLs, ni identificadores de código: solo lo que lee una persona.
    ruido = re.compile(r"^(?:[./#]|https?:|[A-Za-z0-9_.-]+\.(?:js|css|html|json|png|svg)$)")
    textos = set()
    for trozo in re.split(r"<[^>]+>", cuerpo_html):
        t = re.sub(r"\s+", " ", trozo).strip()
        if len(t) < 4 or not re.search(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3}", t):
            continue
        if ruido.match(t) or "{" in t:
            continue
        textos.add(t)
    # `t("…")` de verdad, no el final de `jget("…")` ni de `showStatus(...)`.
    literales = {}
    for lit in re.findall(r'(?<![A-Za-z0-9_$.])t\(\s*"((?:[^"\\]|\\.)*)"', html):
        crudo = json.loads('"%s"' % lit)
        t = re.sub(r"\s+", " ", crudo).strip()
        if len(t) >= 4 and re.search(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3}", t) and not ruido.match(t):
            # El JS pasa la cadena TAL CUAL, así que la clave buena puede llevar
            # espacios al final («Error: »); se admiten las dos formas.
            literales[t] = crudo
            textos.add(t)

    def sin_traducir(t, d):
        return t not in d and literales.get(t, t) not in d

    faltan = {l: sorted(t for t in textos if sin_traducir(t, d)) for l, d in dicts.items()}
    total = sum(len(v) for v in faltan.values())
    if total:
        print("Textos sin traducir (se verán en español):")
        for l, v in faltan.items():
            if v:
                print("  %s: %d" % (l, len(v)))
                for t in v[:12]:
                    print("      · " + (t[:100] + ("…" if len(t) > 100 else "")))
        if estricto:
            fallos.append("%d textos sin traducir (--strict-i18n)" % total)
    else:
        print("i18n: todos los textos visibles del panel están traducidos en %s" % ", ".join(sorted(dicts)))

    if fallos:
        for f in fallos:
            print("::error::" + f, file=sys.stderr)
        return 1
    print("✓ panel: sintaxis correcta, %d ids referenciados existen" % len(pedidos))
    return 0


if __name__ == "__main__":
    sys.exit(main())
