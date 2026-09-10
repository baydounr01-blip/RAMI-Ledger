#!/usr/bin/env python3
"""Genera chain/crates/rami-gui/src/i18n.js a partir de las fuentes de esta
carpeta: allkeys.json (lista de textos originales en español que el panel
traduce) y lang_<idioma>.json (diccionarios). Uso:

    python3 chain/crates/rami-gui/i18n-src/gen_i18n.py

Los valores idénticos a la clave no se emiten. Las claves con prefijo
`@ph:`/`@title:` son placeholders/títulos de atributos HTML.
"""
import json
import os
import pathlib

BASE = pathlib.Path(__file__).resolve().parent
OUT = BASE.parent / "src" / "i18n.js"

keys = json.load(open(BASE / "allkeys.json", encoding="utf-8"))
out = {}
for lang in ["en", "zh", "ru", "sw"]:
    p = BASE / f"lang_{lang}.json"
    if not p.exists():
        print("falta", lang)
        continue
    d = json.load(open(p, encoding="utf-8"))
    missing = [k for k in keys if k not in d]
    extra = [k for k in d if k not in keys]
    fixed = {}
    for k, v in d.items():
        if k not in keys or not isinstance(v, str):
            continue
        for pre in ("@ph:", "@title:"):
            if k.startswith(pre) and v.startswith(pre):
                v = v[len(pre):]
        if v != k and v:
            fixed[k] = v
    out[lang] = fixed
    print(lang, len(fixed), "missing", len(missing), "extra", len(extra))
    for k in missing:
        print("   falta traducción:", k[:70])
js = (
    "// Diccionarios del panel de RAMI-Chain. Clave = texto original en español.\n"
    "// Generado desde i18n-src/lang_*.json (revisable a mano). Testnet sin valor monetario.\n"
    "window.RAMI_I18N = " + json.dumps(out, ensure_ascii=False, indent=0, sort_keys=True) + ";\n"
)
OUT.write_text(js, encoding="utf-8")
print("i18n.js", len(js), "bytes")
