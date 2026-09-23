#!/usr/bin/env bash
# Las notas de las versiones más recientes de RELEASE_NOTES.md, enteras por
# secciones («## Novedades de …») y sin pasar de MAX bytes (100.000 por
# defecto); si faltan secciones, cierra con dónde están las demás.
#
# Lo usan release.yml (cuerpo del release) y web/fetch-downloads.sh (espejo
# latest.json). El fichero entero ya no cabe en ninguno de los dos sitios:
# GitHub rechaza el cuerpo de un release de más de 125.000 caracteres, y
# Linux no pasa a `jq --arg` un argumento de más de 128 KiB. Con la v0.11.0
# RELEASE_NOTES.md llegó a 137.052 bytes y la web dejó de construirse. El
# monedero solo muestra el principio (MAX_NOTES_CHARS en update.rs): la
# versión nueva va siempre entera y primera.
#
# Uso: tools/release/notas-recientes.sh [FICHERO] [MAX]
set -euo pipefail
F="${1:-RELEASE_NOTES.md}"
MAX="${2:-100000}"
[ -f "$F" ] || exit 0
# Bytes, no caracteres (LC_ALL=C): cuenta de más con los acentos, que es el
# lado seguro para los dos límites.
LC_ALL=C awk -v max="$MAX" '
  function suelta() {
    if (sec == "") return
    if (nsec > 0 && tot + length(sec) > max) { corta = 1; return }
    printf "%s", sec; tot += length(sec); nsec++
  }
  /^## Novedades de / { suelta(); sec = ""; if (corta) exit }
  { sec = sec $0 "\n" }
  END {
    if (!corta) suelta()
    if (corta) printf "\n---\n\nLas notas de las versiones anteriores están en `RELEASE_NOTES.md`, en el repositorio.\n"
  }
' "$F"
