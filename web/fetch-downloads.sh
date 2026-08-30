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

for pair in "${map_suffix[@]}"; do
  suffix="${pair%%:*}"
  dest="${pair##*:}"
  url="$(printf '%s' "$json" | jq -r --arg s "$suffix" '.assets[] | select(.name | endswith($s)) | .browser_download_url' | head -1)"
  if [ -z "$url" ] || [ "$url" = "null" ]; then
    echo "  !! no se encontró un asset que termine en ${suffix}" >&2
    exit 1
  fi
  echo "  ↓ ${dest}"
  curl -fsSL "${AUTH[@]}" -o "${OUT}/${dest}" "$url"
done

printf '{"version":"%s"}\n' "$tag" > "${OUT}/version.json"
echo "✓ descargas listas en ${OUT} (release ${tag})"
