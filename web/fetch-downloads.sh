#!/usr/bin/env bash
# Baja los binarios del ÚLTIMO release de RAMI-Chain a web/descargas/ con nombres
# estables (sin versión), para que la web los sirva desde su propio dominio.
# Se ejecuta en el build de Netlify. Requiere curl y jq (ambos vienen en Netlify).
set -euo pipefail

REPO="baydounr01-blip/RAMI-Ledger"
OUT="web/descargas"
mkdir -p "$OUT"

AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

echo "→ consultando el último release de $REPO"
json="$(curl -fsSL "${AUTH[@]}" "https://api.github.com/repos/${REPO}/releases/latest")"
tag="$(printf '%s' "$json" | jq -r '.tag_name')"
echo "  release: ${tag}"

# sufijo del asset -> nombre estable servido en la web (instaladores de un archivo)
map_suffix=(
  "x86_64.AppImage:rami-chain-linux.AppImage"
  "macos-arm64.dmg:rami-chain-macos-arm64.dmg"
  "macos-x64.dmg:rami-chain-macos-intel.dmg"
  "-setup.exe:rami-chain-windows-setup.exe"
  "SHA256SUMS.txt:SHA256SUMS.txt"
)

# $URL la pone Netlify: dominio canónico del sitio (para URLs absolutas en el
# espejo latest.json que consulta el auto-actualizador del monedero).
SITE="${URL:-}"
assets="[]"

for pair in "${map_suffix[@]}"; do
  suffix="${pair%%:*}"
  dest="${pair##*:}"
  url="$(printf '%s' "$json" | jq -r --arg s "$suffix" '.assets[] | select(.name | endswith($s)) | .browser_download_url' | head -1)"
  name="$(printf '%s' "$json" | jq -r --arg s "$suffix" '.assets[] | select(.name | endswith($s)) | .name' | head -1)"
  if [ -z "$url" ] || [ "$url" = "null" ]; then
    echo "  !! no se encontró un asset que termine en ${suffix}" >&2
    exit 1
  fi
  echo "  ↓ ${dest}"
  curl -fsSL "${AUTH[@]}" -o "${OUT}/${dest}" "$url"
  # Entrada del espejo: nombre ORIGINAL del asset (para que el monedero pueda
  # casarlo con SHA256SUMS.txt) + URL servida desde ESTE dominio.
  assets="$(jq -cn --argjson a "$assets" --arg n "$name" --arg u "${SITE}/descargas/${dest}" \
    '$a + [{name:$n, browser_download_url:$u}]')"
done

printf '{"version":"%s"}\n' "$tag" > "${OUT}/version.json"
# Espejo del release con la MISMA forma que la API de GitHub (subconjunto):
# el auto-actualizador del monedero lo parsea igual que el release oficial.
jq -n --arg tag "$tag" --arg site "$SITE" --argjson assets "$assets" \
  '{tag_name:$tag, html_url:($site + "/#descargas"), assets:$assets}' > "${OUT}/latest.json"
echo "✓ descargas listas en ${OUT} (release ${tag}; espejo latest.json para el auto-actualizador)"
