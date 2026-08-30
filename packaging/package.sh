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
  cp "$REL/rami-gui" "$REL/rami-node" "$REL/rami-wallet" "$APP/Contents/MacOS/"
  cp packaging/macos/rami-chain-launcher.sh "$APP/Contents/MacOS/rami-chain"
  chmod +x "$APP/Contents/MacOS/rami-chain" "$APP/Contents/MacOS/rami-gui"
  sed "s/__VERSION__/${TAG#v}/g" packaging/macos/Info.plist > "$APP/Contents/Info.plist"
  iconutil -c icns "$ICON/icon.iconset" -o "$APP/Contents/Resources/rami.icns"

  # Firma de código (opcional, si hay certificado Developer ID en el entorno).
  if [ -n "${MACOS_CERT_P12_BASE64:-}" ]; then
    echo "· firmando la app con Developer ID…"
    echo "$MACOS_CERT_P12_BASE64" | base64 --decode > /tmp/rami-cert.p12
    security create-keychain -p ci build.keychain
    security default-keychain -s build.keychain
    security unlock-keychain -p ci build.keychain
    security import /tmp/rami-cert.p12 -k build.keychain -P "${MACOS_CERT_PASSWORD:-}" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -s -k ci build.keychain >/dev/null
    codesign --deep --force --options runtime --timestamp --sign "${MACOS_SIGN_IDENTITY}" "$APP"
  else
    echo "· sin certificado de Apple: la app irá SIN FIRMAR (ver SIGNING.md)"
  fi

  DMG="dist/RAMI-Chain-$TAG-macos-${ARCH:-universal}.dmg"
  mkdir -p stage/dmg; cp -R "$APP" stage/dmg/; ln -s /Applications stage/dmg/Applications
  hdiutil create -volname "RAMI-Chain" -srcfolder stage/dmg -ov -format UDZO "$DMG"

  # Notarización (opcional, requiere credenciales de Apple).
  if [ -n "${APPLE_ID:-}" ] && [ -n "${MACOS_CERT_P12_BASE64:-}" ]; then
    echo "· notarizando el DMG con Apple…"
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "${APPLE_TEAM_ID}" --password "${APPLE_APP_PASSWORD}" --wait
    xcrun stapler staple "$DMG"
  else
    echo "· sin credenciales de notarización: el DMG no queda notarizado (ver SIGNING.md)"
  fi

  rm -rf stage/dmg
  tarball tar.gz "$REL/rami-gui" "$REL/rami-node" "$REL/rami-wallet"
  ;;

windows)
  mkdir -p stage/win
  cp "$REL/rami-gui.exe" "$REL/rami-node.exe" "$REL/rami-wallet.exe" stage/win/
  cp packaging/windows/installer.nsi "$ICON/rami.ico" stage/win/
  cp README.md NOTICE.md stage/win/ 2>/dev/null || true
  ( cd stage/win && makensis "-DVERSION=${TAG#v}" installer.nsi )
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
