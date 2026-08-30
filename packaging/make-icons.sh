#!/usr/bin/env bash
# Rasteriza el SVG de marca a los formatos que necesita cada plataforma:
#   - rami-<N>.png (varios tamaños)  -> AppImage/Linux
#   - rami.ico (multi-tamaño)        -> Windows
#   - icon.iconset/ (nombres Apple)  -> macOS (iconutil lo convierte a .icns)
# Se ejecuta en el runner Linux del CI (necesita librsvg2-bin e imagemagick).
set -euo pipefail

SVG="packaging/icon/rami.svg"
OUT="packaging/out"
mkdir -p "$OUT" "$OUT/icon.iconset"

for s in 16 24 32 48 64 128 256 512 1024; do
  rsvg-convert -w "$s" -h "$s" "$SVG" -o "$OUT/rami-$s.png"
done

# Windows .ico (varios tamaños en un archivo)
convert "$OUT/rami-16.png" "$OUT/rami-24.png" "$OUT/rami-32.png" "$OUT/rami-48.png" \
        "$OUT/rami-64.png" "$OUT/rami-128.png" "$OUT/rami-256.png" "$OUT/rami.ico"

# macOS iconset con los nombres que espera iconutil
cp "$OUT/rami-16.png"   "$OUT/icon.iconset/icon_16x16.png"
cp "$OUT/rami-32.png"   "$OUT/icon.iconset/icon_16x16@2x.png"
cp "$OUT/rami-32.png"   "$OUT/icon.iconset/icon_32x32.png"
cp "$OUT/rami-64.png"   "$OUT/icon.iconset/icon_32x32@2x.png"
cp "$OUT/rami-128.png"  "$OUT/icon.iconset/icon_128x128.png"
cp "$OUT/rami-256.png"  "$OUT/icon.iconset/icon_128x128@2x.png"
cp "$OUT/rami-256.png"  "$OUT/icon.iconset/icon_256x256.png"
cp "$OUT/rami-512.png"  "$OUT/icon.iconset/icon_256x256@2x.png"
cp "$OUT/rami-512.png"  "$OUT/icon.iconset/icon_512x512.png"
cp "$OUT/rami-1024.png" "$OUT/icon.iconset/icon_512x512@2x.png"

echo "✓ iconos generados en $OUT"
ls -1 "$OUT"
