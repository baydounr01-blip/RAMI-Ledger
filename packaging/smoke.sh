#!/usr/bin/env bash
# Prueba de humo del monedero de escritorio, en CI, sobre el binario/app que se
# va a publicar. Un release NO se publica si falla. Comprueba lo que un usuario
# ve al hacer doble clic:
#   1) la app arranca y el panel responde en < 20 s;
#   2) (macOS) la app atiende los eventos del sistema: un AppleEvent «reopen»
#      con timeout de 10 s debe volver (si el hilo principal no procesa
#      eventos, macOS la marcaría como «no responde» y esto expira);
#   3) «Salir» cierra el proceso en < 5 s (una salida colgada dejaba un proceso
#      zombi «no responde» tras cada actualización);
#   4) el proceso no deja nada corriendo.
#
# Uso: packaging/smoke.sh <linux|macos> <binario rami-gui | RAMI-Chain.app>
set -euo pipefail
KIND="$1"; TARGET="$2"
PORT=8655
TMP="$(mktemp -d)"
ARGS=(--no-open --network regtest --port "$PORT" --listen 30355 --chain "$TMP/chain" --keystore "$TMP/ks" --no-portmap --no-lan --no-seeds)
export HOME="$TMP/home"; mkdir -p "$HOME"

fail() { echo "SMOKE FALLÓ: $*" >&2; echo "--- gui-launch.log ---"; cat "$HOME/.rami/gui-launch.log" 2>/dev/null || true; exit 1; }
wait_status() {
  for i in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

case "$KIND" in
  linux)
    "$TARGET" "${ARGS[@]}" >"$TMP/out.log" 2>&1 &
    PID=$!
    ;;
  macos)
    # Como el usuario: a través de LaunchServices (stdin no es TTY => bucle Cocoa).
    open -n "$TARGET" --args "${ARGS[@]}"
    for i in $(seq 1 20); do PID="$(pgrep -x rami-gui | head -1 || true)"; [ -n "$PID" ] && break; sleep 0.5; done
    [ -n "${PID:-}" ] || fail "el proceso rami-gui no apareció tras open"
    ;;
  *) echo "uso: smoke.sh <linux|macos> <objetivo>"; exit 2;;
esac

wait_status || fail "el panel no respondió en 20 s"
echo "✓ panel responde"
curl -fsS "http://127.0.0.1:$PORT/api/status" | head -c 200; echo

if [ "$KIND" = macos ]; then
  # 2) ¿atiende eventos? «reopen» con timeout: si el hilo principal está ocupado, expira.
  if osascript -e 'with timeout of 10 seconds' -e 'tell application "RAMI-Chain" to reopen' -e 'end timeout' >/dev/null 2>&1; then
    echo "✓ atiende eventos del sistema (reopen)"
  else
    fail "la app NO atiende eventos del sistema (reopen expiró): macOS la marcaría como «no responde»"
  fi
fi

# 3) Salir debe terminar el proceso en < 5 s.
curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/quit" >/dev/null || fail "quit no respondió"
for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then echo "✓ «Salir» cierra el proceso"; break; fi
  sleep 0.5
  [ "$i" = 10 ] && fail "el proceso $PID sigue vivo 5 s después de «Salir» (salida colgada)"
done

# 4) nada queda corriendo
sleep 0.5
if pgrep -x rami-gui >/dev/null 2>&1; then fail "queda un rami-gui corriendo"; fi
echo "✓ prueba de humo ($KIND) superada"
