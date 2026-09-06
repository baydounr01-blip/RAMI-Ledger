#!/usr/bin/env bash
# Prepara web/descargas/ en el build de Netlify: los instaladores del ÚLTIMO
# release con nombres estables (sin versión), el espejo latest.json que
# consulta el auto-actualizador del monedero, version.json y seeds.json.
#
# Diseñado para NO depender de la API de GitHub (que devuelve 403 a las IPs
# compartidas de Netlify por límite de peticiones sin token):
#   1) la etiqueta del último release sale de la redirección 302 de
#      github.com/<repo>/releases/latest (sin límite de API);
#   2) los archivos se bajan por sus nombres deterministas desde
#      github.com/<repo>/releases/download/<tag>/… y se VERIFICAN con el
#      SHA256SUMS.txt publicado (nunca se sirve un archivo que no cuadre);
#   3) las notas («Novedades») salen de RELEASE_NOTES.md del repositorio (es
#      el mismo texto que release.yml pone en el release); la API solo se usa,
#      si responde, para completar la fecha de publicación.
# Si un instalador no se pudiera bajar, la web NO se rompe: el enlace se
# redirige (302) al archivo del release en GitHub. Requiere curl, jq y
# sha256sum (todos vienen en Netlify).
set -euo pipefail

REPO="baydounr01-blip/RAMI-Ledger"
OUT="web/descargas"
mkdir -p "$OUT"
UA=(-H "User-Agent: rami-chain-web-build")
AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi
# $URL la pone Netlify: dominio canónico del sitio (URLs absolutas del espejo).
SITE="${URL:-}"

# ---- 1) etiqueta del último release, por la redirección (sin API) ----
echo "→ último release de $REPO (redirección de releases/latest)"
tag="${RAMI_TAG:-}"
loc=""
[ -n "$tag" ] || loc="$(curl -sSI "${UA[@]}" -o /dev/null -w '%{redirect_url}' "https://github.com/${REPO}/releases/latest" || true)"
[ -n "$tag" ] || tag="${loc##*/tag/}"
if [ -z "$tag" ] || [ "$tag" = "$loc" ]; then
  echo "  (sin redirección; pruebo la API)"
  tag="$(curl -fsSL "${UA[@]}" "${AUTH[@]}" "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | jq -r '.tag_name // empty' || true)"
fi
if [ -z "$tag" ]; then
  echo "!! no se pudo determinar el último release" >&2
  exit 1
fi
echo "  release: ${tag}"
DL="https://github.com/${REPO}/releases/download/${tag}"

# ---- 2) instaladores por nombre determinista + verificación SHA-256 ----
# nombre en el release -> nombre estable servido en la web
map=(
  "RAMI-Chain-${tag}-x86_64.AppImage:rami-chain-linux.AppImage"
  "RAMI-Chain-${tag}-macos-arm64.dmg:rami-chain-macos-arm64.dmg"
  "RAMI-Chain-${tag}-macos-x64.dmg:rami-chain-macos-intel.dmg"
  "RAMI-Chain-${tag}-setup.exe:rami-chain-windows-setup.exe"
)
echo "  ↓ SHA256SUMS.txt"
curl -fsSL "${UA[@]}" -o "${OUT}/SHA256SUMS.txt" "${DL}/SHA256SUMS.txt"
assets="[]"
missing=()
for pair in "${map[@]}"; do
  name="${pair%%:*}"
  dest="${pair##*:}"
  expected="$(awk -v n="$name" '$2 == n || $2 == "*" n {print $1}' "${OUT}/SHA256SUMS.txt" | head -1)"
  ok=0
  if [ -n "$expected" ] && curl -fsSL "${UA[@]}" -o "${OUT}/${dest}" "${DL}/${name}"; then
    got="$(sha256sum "${OUT}/${dest}" | awk '{print $1}')"
    if [ "$got" = "$expected" ]; then
      ok=1
      echo "  ✓ ${dest} (SHA-256 verificado)"
    else
      echo "  !! ${dest}: SHA-256 NO coincide; se descarta" >&2
      rm -f "${OUT}/${dest}"
    fi
  else
    echo "  !! ${dest}: no se pudo bajar ${name}" >&2
    rm -f "${OUT}/${dest}"
  fi
  if [ "$ok" = 1 ]; then
    url="${SITE}/descargas/${dest}"
  else
    # La web no se rompe: el enlace local redirige al archivo del release.
    url="${DL}/${name}"
    missing+=("/descargas/${dest} ${url} 302")
  fi
  # Entrada del espejo: nombre ORIGINAL del asset (el monedero lo casa con
  # SHA256SUMS.txt) + URL desde la que se sirve.
  assets="$(jq -cn --argjson a "$assets" --arg n "$name" --arg u "$url" '$a + [{name:$n, browser_download_url:$u}]')"
done
assets="$(jq -cn --argjson a "$assets" --arg u "${SITE}/descargas/SHA256SUMS.txt" '$a + [{name:"SHA256SUMS.txt", browser_download_url:$u}]')"

# Redirecciones generadas (solo si faltó algún archivo): se añaden a
# web/_redirects sin tocar las reglas escritas a mano.
sed -i '/^# --- generado por fetch-downloads.sh ---$/,$d' web/_redirects 2>/dev/null || true
if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo "# --- generado por fetch-downloads.sh ---"
    printf '%s\n' "${missing[@]}"
  } >> web/_redirects
  echo "  (${#missing[@]} archivo(s) no disponibles localmente: redirigidos al release)"
fi

# ---- 3) notas, fecha, versión, semillas ----
body=""
if [ -f RELEASE_NOTES.md ]; then body="$(cat RELEASE_NOTES.md)"; fi
published="$(curl -fsSL --max-time 8 "${UA[@]}" "${AUTH[@]}" "https://api.github.com/repos/${REPO}/releases/tags/${tag}" 2>/dev/null | jq -r '.published_at // empty' || true)"
[ -n "$published" ] || published="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cp web/seeds.json "${OUT}/seeds.json"
cp web/SEEDS-README.txt "${OUT}/SEEDS-README.txt"
printf '{"version":"%s"}\n' "$tag" > "${OUT}/version.json"
# Espejo del release con la MISMA forma que la API de GitHub (subconjunto):
# el auto-actualizador del monedero lo parsea igual que el release oficial.
jq -n --arg tag "$tag" --arg site "$SITE" --arg body "$body" --arg published "$published" --argjson assets "$assets" \
  '{tag_name:$tag, html_url:($site + "/#descargas"), body:$body, published_at:$published, assets:$assets}' > "${OUT}/latest.json"
echo "✓ descargas listas en ${OUT} (release ${tag}; espejo latest.json para el auto-actualizador)"
