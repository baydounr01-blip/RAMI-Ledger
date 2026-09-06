#!/usr/bin/env bash
# Prueba de humo del monedero de escritorio, en CI, sobre el binario/app que se
# va a publicar. Un release NO se publica si falla. Comprueba lo que un usuario
# ve al hacer doble clic:
#   1) la app arranca y el panel responde en < 20 s;
#   2) (macOS) la app atiende los eventos del sistema DESDE EL PRIMER INSTANTE:
#      un AppleEvent «reopen» con timeout de 10 s debe volver nada más
#      aparecer el proceso (antes de que el panel esté listo) y también
#      después. Si el hilo principal no procesa eventos, macOS marcaría la app
#      como «no responde» y el evento expira (-1712);
#   3) «Salir» cierra el proceso en < 5 s (una salida colgada dejaba un proceso
#      zombi «no responde» tras cada actualización) y el registro confirma que
#      la salida fue inmediata;
#   4) el proceso no deja nada corriendo.
#
# Uso: packaging/smoke.sh <linux|macos> <binario rami-gui | RAMI-Chain.app>
set -euo pipefail
KIND="$1"; TARGET="$2"
PORT=8655
BUNDLE_ID="chain.rami.wallet"
TMP="$(mktemp -d)"
ARGS=(--no-open --no-install --network regtest --port "$PORT" --listen 30355 --chain "$TMP/chain" --keystore "$TMP/ks" --no-portmap --no-lan --no-seeds)
SMOKE_HOME="$TMP/home"; mkdir -p "$SMOKE_HOME"
REAL_HOME="$HOME"
PID=""

cleanup() { pkill -x rami-gui 2>/dev/null || true; }
trap cleanup EXIT
logs() {
  echo "--- gui-launch.log (home de la prueba) ---"; cat "$SMOKE_HOME/.rami/gui-launch.log" 2>/dev/null || echo "(no existe)"
  echo "--- gui-launch.log (home real) ---"; tail -40 "$REAL_HOME/.rami/gui-launch.log" 2>/dev/null || echo "(no existe)"
  echo "--- salida del proceso ---"; cat "$TMP/out.log" "$TMP/err.log" 2>/dev/null || true
}
fail() { echo "SMOKE FALLÓ: $*" >&2; logs; exit 1; }
wait_status() {
  for i in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}
# Sonda de eventos (macOS): «reopen» por id de bundle, SIN lanzar nada si no
# está corriendo; solo «timed out» (-1712) significa hilo principal ocupado.
reopen_probe() {
  local err
  if err=$(osascript \
      -e "if application id \"$BUNDLE_ID\" is running then" \
      -e 'with timeout of 10 seconds' \
      -e "tell application id \"$BUNDLE_ID\" to reopen" \
      -e 'end timeout' \
      -e 'else' \
      -e 'error "RAMI-Chain no está corriendo" number 9001' \
      -e 'end if' 2>&1 >/dev/null); then
    return 0
  fi
  echo "osascript: $err" >&2
  case "$err" in
    *"timed out"*|*"-1712"*) return 1;;                 # hilo principal sin atender eventos
    *"-1743"*|*"Not authorized"*|*"not allowed"*) return 2;;  # TCC del runner
    *) return 3;;
  esac
}

if pgrep -x rami-gui >/dev/null 2>&1; then fail "ya había un rami-gui corriendo antes de la prueba"; fi

case "$KIND" in
  linux)
    HOME="$SMOKE_HOME" "$TARGET" "${ARGS[@]}" >"$TMP/out.log" 2>"$TMP/err.log" &
    PID=$!
    ;;
  macos)
    # Como el usuario: a través de LaunchServices (stdin no es TTY => bucle Cocoa).
    # `open` no hereda el entorno del shell: HOME se pasa con --env.
    open -n --env HOME="$SMOKE_HOME" --stdout "$TMP/out.log" --stderr "$TMP/err.log" "$TARGET" --args "${ARGS[@]}"
    for i in $(seq 1 40); do PID="$(pgrep -x rami-gui | head -1 || true)"; [ -n "$PID" ] && break; sleep 0.25; done
    [ -n "$PID" ] || fail "el proceso rami-gui no apareció tras open"
    # 2a) atiende eventos YA, antes de que el panel exista.
    if reopen_probe; then echo "✓ atiende eventos del sistema al instante (reopen antes del panel)"; else
      rc=$?; [ "$rc" = 1 ] && fail "la app NO atiende eventos nada más arrancar (reopen expiró): macOS la marcaría como «no responde»"
      echo "(sonda de eventos no concluyente al arrancar, código $rc; se repite tras el panel)"
    fi
    ;;
  *) echo "uso: smoke.sh <linux|macos> <objetivo>"; exit 2;;
esac

wait_status || fail "el panel no respondió en 20 s"
echo "✓ panel responde"
curl -fsS "http://127.0.0.1:$PORT/api/status" | head -c 160; echo

if [ "$KIND" = macos ]; then
  if reopen_probe; then echo "✓ atiende eventos del sistema (reopen con el panel listo)"; else
    rc=$?
    case "$rc" in
      1) fail "la app NO atiende eventos del sistema (reopen expiró): macOS la marcaría como «no responde»";;
      2) fail "el runner no autoriza AppleEvents (TCC): la sonda no se pudo ejecutar";;
      *) fail "la sonda de eventos falló por otra causa (ver arriba)";;
    esac
  fi
fi

# 3) Salir debe terminar el proceso en < 5 s.
curl -fsS -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/quit" >/dev/null || fail "quit no respondió"
gone=0
for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then gone=1; break; fi
  sleep 0.5
done
[ "$gone" = 1 ] || fail "el proceso $PID sigue vivo 5 s después de «Salir» (salida colgada)"
echo "✓ «Salir» cierra el proceso"
grep -q "salida inmediata del proceso" "$SMOKE_HOME/.rami/gui-launch.log" 2>/dev/null \
  || fail "el registro no confirma la salida inmediata (¿se usó exit() en vez de _exit()?)"
echo "✓ salida inmediata registrada"

# 4) nada queda corriendo
sleep 0.5
if pgrep -x rami-gui >/dev/null 2>&1; then fail "queda un rami-gui corriendo"; fi
echo "✓ prueba de humo ($KIND) superada"
