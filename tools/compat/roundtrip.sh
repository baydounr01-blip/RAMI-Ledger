#!/usr/bin/env bash
# Ida y vuelta entre la versión PUBLICADA (etiqueta $OLD_TAG, por defecto
# v0.7.0) y la versión de este árbol, con los binarios reales de las dos:
#
#   1. La versión antigua crea un monedero y una cadena regtest con
#      transacciones, commit/reveal, mempool pendiente y pares.
#   2. La versión nueva abre TODO eso: verifica la cadena, lee el saldo con
#      la contraseña, envía, compromete y ejecuta el nodo unos segundos
#      (escribe peers.json, known-identities.json, peer-grades.json).
#   3. La versión ANTIGUA vuelve a abrir el directorio que la nueva acaba de
#      escribir: verify, status, saldo, y un nodo antiguo se conecta a un
#      nodo nuevo (mismo protocolo). Si algo de esto falla, actualizar —o
#      volver atrás— rompe el archivo de alguien, y el CI se pone en rojo.
#
# Uso: tools/compat/roundtrip.sh [OLD_TAG]   (desde la raíz del repositorio)
set -euo pipefail

OLD_TAG="${1:-v0.7.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${COMPAT_WORK:-$(mktemp -d)}"
OLD_SRC="$WORK/old-src"
# No se toca HOME: rustup busca su toolchain en ~/.rustup (en el runner del
# CI no hay «default» fuera de él). Todo va con --keystore y --chain explícitos.
RAMI_HOME="$WORK/home"
export RAMI_WALLET_PASSWORD=compat-1234
mkdir -p "$RAMI_HOME/.rami"

log() { printf '\n== %s\n' "$*"; }
falla() { printf '✗ %s\n' "$*" >&2; exit 1; }

log "compilando la versión nueva (este árbol)"
cargo build --release --locked --manifest-path "$ROOT/chain/Cargo.toml" -p rami-wallet -p rami-node >/dev/null
NEW="$ROOT/chain/target/release"

log "compilando la versión publicada $OLD_TAG"
if [ ! -d "$OLD_SRC" ]; then
  git -C "$ROOT" fetch --no-tags origin "tag" "$OLD_TAG" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree add -f "$OLD_SRC" "$OLD_TAG" >/dev/null
fi
cargo build --release --locked --manifest-path "$OLD_SRC/chain/Cargo.toml" -p rami-wallet -p rami-node >/dev/null
OLD="$OLD_SRC/chain/target/release"

KS="$RAMI_HOME/.rami/wallet.json"
C="$RAMI_HOME/.rami/chain-regtest"

# ── 1. La versión antigua escribe ──────────────────────────────────────
log "$OLD_TAG escribe monedero y cadena"
"$OLD/rami-wallet" new --label yo --keystore "$KS" >/dev/null
"$OLD/rami-wallet" new --label otro --keystore "$KS" >/dev/null
YO=$("$OLD/rami-wallet" address --label yo --keystore "$KS" | tail -1)
OTRO=$("$OLD/rami-wallet" address --label otro --keystore "$KS" | tail -1)
"$OLD/rami-node" init --chain "$C" --network regtest --miner "$YO" >/dev/null
"$OLD/rami-node" mine --chain "$C" --network regtest --address "$YO" --blocks 4 >/dev/null
"$OLD/rami-wallet" send --chain "$C" --network regtest --to "$OTRO" --amount 3 --fee 1 --label yo --keystore "$KS" >/dev/null
COMMIT=$("$OLD/rami-wallet" commit --chain "$C" --network regtest --payload '{"termino":"probable"}' --fee 1 --label yo --keystore "$KS" | grep -oE '[0-9a-f]{64}' | tail -1)
"$OLD/rami-node" mine --chain "$C" --network regtest --address "$YO" --blocks 2 >/dev/null
"$OLD/rami-wallet" reveal --chain "$C" --network regtest --commit "$COMMIT" --fee 1 --label yo --keystore "$KS" >/dev/null
"$OLD/rami-node" mine --chain "$C" --network regtest --address "$YO" --blocks 1 >/dev/null
"$OLD/rami-wallet" send --chain "$C" --network regtest --to "$OTRO" --amount 1 --fee 1 --label yo --keystore "$KS" >/dev/null
ALTURA_OLD=$("$OLD/rami-node" status --chain "$C" --network regtest | awk '/altura/{print $3}')
SALDO_OLD=$("$OLD/rami-wallet" balance --chain "$C" --network regtest --label yo --keystore "$KS" | grep -i saldo | head -1)
echo "altura $ALTURA_OLD · saldo yo: $SALDO_OLD"

# ── 2. La versión nueva abre y escribe encima ──────────────────────────
log "la versión nueva abre lo que escribió $OLD_TAG"
"$NEW/rami-node" verify --chain "$C" --network regtest | grep -q "íntegra" || falla "verify de la nueva sobre la cadena antigua"
[ "$("$NEW/rami-wallet" address --label yo --keystore "$KS" | tail -1)" = "$YO" ] || falla "la nueva lee otra dirección del keystore antiguo"
SALDO_NEW=$("$NEW/rami-wallet" balance --chain "$C" --network regtest --label yo --keystore "$KS" | grep -i saldo | head -1)
[ "$SALDO_NEW" = "$SALDO_OLD" ] || falla "saldo distinto: antigua «$SALDO_OLD», nueva «$SALDO_NEW»"
"$NEW/rami-wallet" send --chain "$C" --network regtest --to "$OTRO" --amount 1 --fee 1 --label yo --keystore "$KS" >/dev/null
"$NEW/rami-node" mine --chain "$C" --network regtest --address "$YO" --blocks 2 >/dev/null
COMMIT2=$("$NEW/rami-wallet" commit --chain "$C" --network regtest --payload '{"termino":"improbable"}' --fee 1 --label yo --keystore "$KS" | grep -oE '[0-9a-f]{64}' | tail -1)
"$NEW/rami-node" mine --chain "$C" --network regtest --address "$YO" --blocks 1 >/dev/null
# El nodo nuevo, unos segundos, con un par antiguo delante: mismo protocolo.
B="$WORK/nodeB"; rm -rf "$B"; cp -r "$C" "$B"; rm -f "$B/node.key" "$B/peers.json" "$B/known-identities.json"
timeout 14 "$OLD/rami-node" run --chain "$B" --network regtest --listen 30491 --no-lan --no-portmap >"$WORK/old-node.log" 2>&1 &
sleep 2
timeout 10 "$NEW/rami-node" run --chain "$C" --network regtest --listen 30492 --connect 127.0.0.1:30491 --no-lan --no-portmap >"$WORK/new-node.log" 2>&1 || true
sleep 3
grep -q 30491 "$C/peers.json" || falla "el nodo nuevo no recordó al par antiguo (¿protocolo?)"
[ -f "$C/known-identities.json" ] || falla "el nodo nuevo no fijó la identidad del par antiguo"
[ -f "$C/peer-grades.json" ] || falla "el nodo nuevo no escribió peer-grades.json"
echo "la nueva escribió: $(ls "$C" | tr '\n' ' ')"

# ── 3. La versión antigua vuelve a abrir lo que escribió la nueva ──────
log "$OLD_TAG vuelve a abrir el directorio escrito por la versión nueva"
"$OLD/rami-node" verify --chain "$C" --network regtest | grep -q "íntegra" || falla "verify de la antigua sobre la cadena escrita por la nueva"
"$OLD/rami-node" status --chain "$C" --network regtest >/dev/null || falla "status antiguo"
[ "$("$OLD/rami-wallet" address --label yo --keystore "$KS" | tail -1)" = "$YO" ] || falla "la antigua lee otra dirección del keystore tras la nueva"
"$OLD/rami-wallet" balance --chain "$C" --network regtest --label yo --keystore "$KS" >/dev/null || falla "saldo con la antigua"
"$OLD/rami-wallet" reveal --chain "$C" --network regtest --commit "$COMMIT2" --fee 1 --label yo --keystore "$KS" >/dev/null || falla "la antigua no puede revelar un commit hecho por la nueva"
"$OLD/rami-node" mine --chain "$C" --network regtest --address "$YO" --blocks 1 >/dev/null
# Y el nodo antiguo arranca sobre el directorio (con peers.json, identidades y peer-grades.json escritos por la nueva).
timeout 6 "$OLD/rami-node" run --chain "$C" --network regtest --listen 30493 --no-lan --no-portmap >"$WORK/old-node-2.log" 2>&1 || true
grep -qi "panic\|error" "$WORK/old-node-2.log" && falla "el nodo antiguo se quejó al abrir el directorio: $(head -3 "$WORK/old-node-2.log")"
"$OLD/rami-node" verify --chain "$C" --network regtest | grep -q "íntegra" || falla "cadena no íntegra tras la ida y vuelta"
log "OK: ida y vuelta $OLD_TAG ⇄ versión nueva sin pérdidas (directorio: $WORK)"
