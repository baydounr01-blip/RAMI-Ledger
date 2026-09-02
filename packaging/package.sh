#!/usr/bin/env bash
# Empaqueta el monedero en UN SOLO archivo por plataforma, con icono:
#   linux   -> RAMI-Chain-<tag>-x86_64.AppImage   (+ tarball para avanzados)
#   macos   -> RAMI-Chain-<tag>-macos-<arch>.dmg  (+ tarball)
#   windows -> RAMI-Chain-<tag>-setup.exe (NSIS)  (+ zip)
#
# Firma/notariza SOLO si el CI tiene los certificados en el entorno (ver
# SIGNING.md); si no, empaqueta sin firmar y lo dice. Nunca desactiva la
# seguridad del sistema operativo.
#
# Uso: package.sh <linux|macos|windows> <target-triple> [arch]
set -euo pipefail

KIND="$1"; TARGET="$2"; ARCH="${3:-}"
TAG="${TAG:-v0.0.0}"
REL="chain/target/$TARGET/release"
ICON="packaging/out"
mkdir -p dist stage

tarball() {
  local name="rami-chain-$TAG-$TARGET" ext="$1"; shift
  mkdir -p "stage/$name"
  cp "$@" "stage/$name/" 2>/dev/null || true
  cp README.md NOTICE.md LICENSE "stage/$name/" 2>/dev/null || true
  if [ "$ext" = "zip" ]; then
    ( cd stage && 7z a "../dist/$name.zip" "$name" >/dev/null )
  else
    tar -C stage -czf "dist/$name.tar.gz" "$name"
  fi
}

case "$KIND" in
linux)
  APPDIR="stage/RAMI-Chain.AppDir"
  mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/icons/hicolor/256x256/apps"
  cp "$REL/rami-gui" "$REL/rami-node" "$REL/rami-wallet" "$APPDIR/usr/bin/"
  cp packaging/linux/AppRun "$APPDIR/AppRun"; chmod +x "$APPDIR/AppRun"
  cp packaging/linux/rami-chain.desktop "$APPDIR/rami-chain.desktop"
  cp "$ICON/rami-256.png" "$APPDIR/rami-chain.png"
  cp "$ICON/rami-256.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/rami-chain.png"
  curl -fsSL -o stage/appimagetool "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x stage/appimagetool
  ARCH=x86_64 ./stage/appimagetool --appimage-extract-and-run "$APPDIR" "dist/RAMI-Chain-$TAG-x86_64.AppImage"
  tarball tar.gz "$REL/rami-gui" "$REL/rami-node" "$REL/rami-wallet"
  ;;

macos)
  APP="stage/RAMI-Chain.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  # El ejecutable principal es un Mach-O REAL (rami-gui), no un script: es lo que
  # exige la notarización de Apple. rami-gui sin argumentos arranca la testnet y
  # abre el panel, así que el doble clic en Finder funciona directamente.
  cp "$REL/rami-gui" "$REL/rami-node" "$REL/rami-wallet" "$APP/Contents/MacOS/"
  chmod +x "$APP/Contents/MacOS/rami-gui" "$APP/Contents/MacOS/rami-node" "$APP/Contents/MacOS/rami-wallet"
  sed "s/__VERSION__/${TAG#v}/g" packaging/macos/Info.plist > "$APP/Contents/Info.plist"
  iconutil -c icns "$ICON/icon.iconset" -o "$APP/Contents/Resources/rami.icns"

  if [ -n "${MACOS_CERT_P12_BASE64:-}" ] && [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
    # Firma Developer ID + hardened runtime (requisito de notarización).
    echo "· firmando la app con Developer ID…"
    echo "$MACOS_CERT_P12_BASE64" | base64 --decode > /tmp/rami-cert.p12
    security create-keychain -p ci build.keychain
    security default-keychain -s build.keychain
    security unlock-keychain -p ci build.keychain
    security import /tmp/rami-cert.p12 -k build.keychain -P "${MACOS_CERT_PASSWORD:-}" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -s -k ci build.keychain >/dev/null
    for b in rami-node rami-wallet rami-gui; do
      codesign --force --options runtime --timestamp --sign "${MACOS_SIGN_IDENTITY}" "$APP/Contents/MacOS/$b"
    done
    codesign --force --options runtime --timestamp --sign "${MACOS_SIGN_IDENTITY}" "$APP"
    SIGNED=1
  else
    # Sin certificado: firma AD-HOC. No quita el aviso de Gatekeeper (eso solo lo
    # hace la notarización), pero deja la app válida y ejecutable (evita el error
    # "está dañada" en Apple Silicon). Ver SIGNING.md.
    # Por binario y SIN tragarse errores: en Apple Silicon un arm64 con firma
    # inválida es matado por el kernel al arrancar («la app no abre», sin
    # mensaje) — si codesign falla, el build DEBE fallar.
    echo "· sin certificado de Apple: firma ad-hoc (no notarizada; ver SIGNING.md)"
    for b in rami-node rami-wallet rami-gui; do
      codesign --force --sign - "$APP/Contents/MacOS/$b"
    done
    codesign --force --sign - "$APP"
    SIGNED=0
  fi

  # La firma del bundle debe quedar VÁLIDA sí o sí (ad-hoc o Developer ID).
  codesign --verify --deep --strict "$APP"
  echo "· firma del bundle verificada"

  DMG="dist/RAMI-Chain-$TAG-macos-${ARCH:-universal}.dmg"
  mkdir -p stage/dmg; cp -R "$APP" stage/dmg/; ln -s /Applications stage/dmg/Applications
  cp "packaging/macos/COMO-ABRIR.txt" "stage/dmg/CÓMO ABRIR - LÉEME.txt"
  hdiutil create -volname "RAMI-Chain" -srcfolder stage/dmg -ov -format UDZO "$DMG"

  if [ "$SIGNED" = "1" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    echo "· notarizando el DMG con Apple…"
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "${APPLE_TEAM_ID}" --password "${APPLE_APP_PASSWORD}" --wait
    xcrun stapler staple "$DMG"
  else
    echo "· DMG NO notarizado (faltan credenciales de Apple; ver SIGNING.md)"
  fi

  rm -rf stage/dmg
  tarball tar.gz "$REL/rami-gui" "$REL/rami-node" "$REL/rami-wallet"
  ;;

windows)
  mkdir -p stage/win
  cp "$REL/rami-gui.exe" "$REL/rami-node.exe" "$REL/rami-wallet.exe" stage/win/
  cp packaging/windows/installer.nsi "$ICON/rami.ico" stage/win/
  cp packaging/windows/COMO-ABRIR.txt stage/win/
  cp README.md NOTICE.md stage/win/ 2>/dev/null || true
  # choco instala NSIS pero no siempre lo deja en el PATH de git-bash, y la
  # ubicación cambia entre versiones (NSIS 3.10+ lo pone en Bin\; choco puede
  # dejarlo bajo ProgramData). Búsqueda real en vez de rutas fijas.
  MAKENSIS="$(command -v makensis 2>/dev/null || true)"
  if [ -z "$MAKENSIS" ]; then
    for root in "/c/Program Files (x86)/NSIS" "/c/Program Files/NSIS" \
                "/c/ProgramData/chocolatey/lib/nsis" "/c/ProgramData/chocolatey/bin"; do
      [ -d "$root" ] || continue
      f="$(find "$root" -iname 'makensis.exe' 2>/dev/null | head -1)"
      [ -n "$f" ] && MAKENSIS="$f" && break
    done
  fi
  if [ -z "$MAKENSIS" ]; then
    echo "✗ makensis no encontrado (¿falló 'choco install nsis'?)" >&2
    exit 1
  fi
  echo "· makensis: $MAKENSIS"
  ( cd stage/win && "$MAKENSIS" "-DVERSION=${TAG#v}" installer.nsi )
  SETUP="dist/RAMI-Chain-$TAG-setup.exe"
  mv "stage/win/RAMI-Chain-Setup.exe" "$SETUP"

  # Firma Authenticode (opcional, si hay certificado en el entorno).
  if [ -n "${WINDOWS_CERT_PFX_BASE64:-}" ]; then
    echo "· firmando el instalador con Authenticode…"
    echo "$WINDOWS_CERT_PFX_BASE64" | base64 --decode > /tmp/rami-cert.pfx
    MSYS2_ARG_CONV_EXCL='*' signtool sign //f /tmp/rami-cert.pfx //p "${WINDOWS_CERT_PASSWORD:-}" \
      //tr http://timestamp.digicert.com //td sha256 //fd sha256 "$SETUP"
  else
    echo "· sin certificado de firma: el instalador irá SIN FIRMAR (ver SIGNING.md)"
  fi

  tarball zip "$REL/rami-gui.exe" "$REL/rami-node.exe" "$REL/rami-wallet.exe"
  ;;
*)
  echo "kind desconocido: $KIND" >&2; exit 1 ;;
esac

echo "✓ paquetes en dist/:"; ls -la dist/
