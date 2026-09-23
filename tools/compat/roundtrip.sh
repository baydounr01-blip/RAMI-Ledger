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
#   4. Activación de la regla de firma v2 (v0.8.0), forzada en regtest: la
#      nueva mina bloques con firmas ligadas a la red y la antigua vuelve a
#      abrir el directorio sin romperse (se queda en su altura, como pasará
#      en la testnet con quien no se actualice).
#   5. Activación de la escritura de vivienda (v0.11.0), forzada en regtest
#      con Dubái: la nueva reclama, divide, vende y compra viviendas y mina;
#      sin las fechas (o con Dubái y sin vivienda) la MISMA versión se queda
#      en el bloque anterior; un nodo antiguo conectado a uno nuevo se queda
#      en su altura sin caerse; la antigua vuelve a abrir el directorio y
#      falla limpia en la línea que no entiende (un tipo de transacción que no
#      conoce: ver docs/VIVIENDA.md, §7) sin tocar el fichero; y la nueva, ante
#      un bloque de una versión POSTERIOR en medio del fichero, lo salta y
#      sigue abriendo.
#
# Uso: tools/compat/roundtrip.sh [OLD_TAG]   (desde la raíz del repositorio)
# CARGO_TARGET_DIR, si está definida, vale para la versión nueva; la antigua
# se compila siempre en su propio árbol (no pisa los binarios nuevos).
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
# `orden | contiene PATRÓN`: lee TODA la salida y después busca. Con
# `set -o pipefail`, `orden | grep -q` falla aunque el patrón esté: grep sale
# en la primera coincidencia, la orden vuelve a escribir en el tubo cerrado,
# el println! de Rust entra en pánico (Broken pipe, salida 101) y pipefail lo
# cuenta como fallo. `rami-node mine` escribe una línea por bloque y un
# resumen al final: con grep -q fallaban 23 de 30 ejecuciones.
contiene() { local salida; salida=$(cat); grep -q -- "$1" <<<"$salida"; }

log "compilando la versión nueva (este árbol)"
cargo build --release --locked --manifest-path "$ROOT/chain/Cargo.toml" -p rami-wallet -p rami-node >/dev/null
NEW="${CARGO_TARGET_DIR:-$ROOT/chain/target}/release"

log "compilando la versión publicada $OLD_TAG"
if [ ! -d "$OLD_SRC" ]; then
  git -C "$ROOT" fetch --no-tags origin "tag" "$OLD_TAG" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree add -f "$OLD_SRC" "$OLD_TAG" >/dev/null
fi
CARGO_TARGET_DIR="$OLD_SRC/chain/target" cargo build --release --locked --manifest-path "$OLD_SRC/chain/Cargo.toml" -p rami-wallet -p rami-node >/dev/null
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

# ── 4. Activación de la regla de firma v2 (v0.8.0) sobre lo que escribió la antigua ──
# En regtest la activación se fuerza con --firma-v2-desde. La versión nueva
# firma y mina bajo la regla v2; la ANTIGUA vuelve a abrir el mismo
# directorio: no se rompe (abre, lee saldo, arranca), pero se queda en su
# altura porque no entiende los bloques con firmas v2. Es exactamente lo que
# pasará en la testnet el día de la activación con quien no se actualice.
log "activación v2: la nueva mina con firmas ligadas a la red; $OLD_TAG vuelve a abrir"
D="$WORK/activacion"; rm -rf "$D"; cp -r "$C" "$D"
DESDE=$(( $(date +%s) - 1 ))
ALTURA_ANTES=$("$NEW/rami-node" status --chain "$D" --network regtest | awk '/altura/{print $3}')
# Una tx firmada bajo v1 (sin el flag) NO puede entrar en un bloque v2: se queda fuera, sin romper nada.
"$NEW/rami-wallet" send --chain "$D" --network regtest --to "$OTRO" --amount 1 --fee 1 --label yo --keystore "$KS" >/dev/null
"$NEW/rami-wallet" send --chain "$D" --network regtest --firma-v2-desde "$DESDE" --to "$OTRO" --amount 1 --fee 1 --label yo --keystore "$KS" >/dev/null
"$NEW/rami-node" mine --chain "$D" --network regtest --firma-v2-desde "$DESDE" --address "$YO" --blocks 2 >/dev/null
"$NEW/rami-node" verify --chain "$D" --network regtest --firma-v2-desde "$DESDE" | grep -q "íntegra" || falla "verify de la nueva con la regla v2 activada"
ALTURA_V2=$("$NEW/rami-node" status --chain "$D" --network regtest --firma-v2-desde "$DESDE" | awk '/altura/{print $3}')
[ "$ALTURA_V2" = "$((ALTURA_ANTES + 2))" ] || falla "la nueva con v2 no avanzó 2 bloques ($ALTURA_ANTES → $ALTURA_V2)"
# El primer bloque v2 lleva la tx firmada v2 (la v1 quedó fuera): sin el flag, la MISMA versión nueva
# aplica la regla v1 y no admite esos bloques. La regla depende de los parámetros, no del binario.
ALTURA_SIN=$("$NEW/rami-node" status --chain "$D" --network regtest 2>/dev/null | awk '/altura/{print $3}')
[ "$ALTURA_SIN" = "$ALTURA_ANTES" ] || falla "sin activación se admitieron bloques v2 ($ALTURA_ANTES → $ALTURA_SIN): la tx v2 no estaba en el primer bloque o la regla no se aplicó"
# La ANTIGUA abre el directorio con bloques v2: no rompe, no avanza.
"$OLD/rami-node" verify --chain "$D" --network regtest 2>"$WORK/old-verify-v2.err" | grep -q "íntegra" || falla "la antigua no abre el directorio con bloques v2"
grep -q "no se re-admitieron" "$WORK/old-verify-v2.err" || falla "la antigua no informó de los bloques que no entiende"
ALTURA_OLD_V2=$("$OLD/rami-node" status --chain "$D" --network regtest 2>/dev/null | awk '/altura/{print $3}')
[ "$ALTURA_OLD_V2" = "$ALTURA_ANTES" ] || falla "la antigua debería quedarse en $ALTURA_ANTES y está en $ALTURA_OLD_V2"
"$OLD/rami-wallet" balance --chain "$D" --network regtest --label yo --keystore "$KS" >/dev/null || falla "saldo con la antigua tras la activación"
"$OLD/rami-node" mine --chain "$D" --network regtest --address "$YO" --blocks 1 >/dev/null || falla "la antigua no puede minar su rama tras la activación"
timeout 6 "$OLD/rami-node" run --chain "$D" --network regtest --listen 30494 --no-lan --no-portmap >"$WORK/old-node-v2.log" 2>&1 || true
grep -qi "panic" "$WORK/old-node-v2.log" && falla "el nodo antiguo cayó al abrir un directorio con bloques v2: $(head -3 "$WORK/old-node-v2.log")"
# Y la nueva (con la regla) sigue abriendo lo que la antigua acaba de escribir: la rama v2 sigue siendo la cabeza.
"$NEW/rami-node" verify --chain "$D" --network regtest --firma-v2-desde "$DESDE" | grep -q "íntegra" || falla "la nueva no abre lo que la antigua escribió tras la activación"
ALTURA_FIN=$("$NEW/rami-node" status --chain "$D" --network regtest --firma-v2-desde "$DESDE" | awk '/altura/{print $3}')
[ "$ALTURA_FIN" = "$ALTURA_V2" ] || falla "la cabeza v2 cambió tras minar la antigua ($ALTURA_V2 → $ALTURA_FIN)"
echo "activación: antes $ALTURA_ANTES · nueva con v2 $ALTURA_V2 · antigua se queda en $ALTURA_OLD_V2 · sin la fecha $ALTURA_SIN"

# ── 5. Escritura de vivienda (v0.11.0), forzada en regtest con Dubái ──
log "escritura de vivienda: la nueva divide, vende y compra; sin la fecha no avanza; $OLD_TAG vuelve a abrir"
V="$WORK/vivienda"; rm -rf "$V"; cp -r "$C" "$V"; rm -f "$V/mempool.jsonl"
DESDE_V=$(( $(date +%s) - 1 ))
VIV="--dubai-desde $DESDE_V --vivienda-desde $DESDE_V"
# shellcheck disable=SC2086
nuevo() { "$NEW/rami-node" "$1" --chain "$V" --network regtest $VIV "${@:2}"; }
# shellcheck disable=SC2086
cartera() { "$NEW/rami-wallet" "$1" --chain "$V" --network regtest $VIV --keystore "$KS" "${@:2}"; }
ALTURA_V0=$(nuevo status | awk '/altura/{print $3}')
# (21,45): desierto, 5 RAMI; fuera de la cuadrícula de 32×32 de antes de Dubái.
cartera claim --x 21 --y 45 --name Residencial --kind 7 --label yo >/dev/null || falla "claim con la nueva"
nuevo mine --address "$YO" --blocks 1 | contiene "2 tx" || falla "el bloque de la parcela no lleva la reclamación"
cartera divide --x 21 --y 45 --unidades 4 --label yo >/dev/null || falla "divide con la nueva"
nuevo mine --address "$YO" --blocks 1 | contiene "2 tx" || falla "el bloque de la división no la lleva"
cartera divide --x 21 --y 45 --unidades 8 --label yo >/dev/null 2>"$WORK/viv-dos-veces.err" && falla "se dividió dos veces"
grep -q "ya está dividida" "$WORK/viv-dos-veces.err" || falla "la segunda división no dio el motivo: $(cat "$WORK/viv-dos-veces.err")"
cartera unit-sell --x 21 --y 45 --n 2 --price 1 --label yo >/dev/null || falla "unit-sell"
cartera unit-buy --x 21 --y 45 --n 2 --max-price 1 --label otro >/dev/null || falla "unit-buy desde la otra cuenta"
cartera unit-transfer --x 21 --y 45 --n 3 --to "$OTRO" --label yo >/dev/null || falla "unit-transfer"
nuevo mine --address "$YO" --blocks 1 | contiene "4 tx" || falla "el bloque de venta, compra y transferencia no las lleva"
cartera unit-buy --x 21 --y 45 --n 2 --max-price 1 --label otro >/dev/null 2>"$WORK/viv-ya.err" && falla "se compró una vivienda que ya era suya"
grep -q "no está en venta" "$WORK/viv-ya.err" || falla "la compra repetida no dio el motivo: $(cat "$WORK/viv-ya.err")"
nuevo verify | contiene "íntegra" || falla "verify de la nueva con la vivienda activada"
ALTURA_VIV=$(nuevo status | awk '/altura/{print $3}')
[ "$ALTURA_VIV" = "$((ALTURA_V0 + 3))" ] || falla "la nueva con vivienda no avanzó 3 bloques ($ALTURA_V0 → $ALTURA_VIV)"
# La regla depende de los parámetros: sin fechas no pasa de la parcela de
# 64×64; con Dubái y sin vivienda, no pasa de la división.
ALTURA_SIN=$("$NEW/rami-node" status --chain "$V" --network regtest 2>/dev/null | awk '/altura/{print $3}')
[ "$ALTURA_SIN" = "$ALTURA_V0" ] || falla "sin fechas se admitieron bloques de Dubái ($ALTURA_V0 → $ALTURA_SIN)"
ALTURA_SOLO_DUBAI=$("$NEW/rami-node" status --chain "$V" --network regtest --dubai-desde "$DESDE_V" 2>/dev/null | awk '/altura/{print $3}')
[ "$ALTURA_SOLO_DUBAI" = "$((ALTURA_V0 + 1))" ] || falla "con Dubái y sin vivienda debería quedarse en $((ALTURA_V0 + 1)) y está en $ALTURA_SOLO_DUBAI"
# Por red: un nodo ANTIGUO (sobre el directorio anterior) conectado a uno
# nuevo con los bloques de vivienda se queda en su altura y no se cae.
VN="$WORK/vivienda-red"; rm -rf "$VN"; cp -r "$C" "$VN"; rm -f "$VN/node.key" "$VN/peers.json" "$VN/known-identities.json" "$VN/peer-grades.json" "$VN/mempool.jsonl"
# shellcheck disable=SC2086
timeout 16 "$NEW/rami-node" run --chain "$V" --network regtest $VIV --listen 30495 --no-lan --no-portmap >"$WORK/viv-new-node.log" 2>&1 &
NUEVO_PID=$!
sleep 2
timeout 10 "$OLD/rami-node" run --chain "$VN" --network regtest --listen 30496 --connect 127.0.0.1:30495 --no-lan --no-portmap >"$WORK/viv-old-node.log" 2>&1 || true
wait "$NUEVO_PID" 2>/dev/null || true
grep -qi "panic" "$WORK/viv-old-node.log" && falla "el nodo antiguo cayó frente a un nodo con vivienda: $(head -3 "$WORK/viv-old-node.log")"
grep -q 30495 "$VN/peers.json" || falla "el nodo antiguo no llegó a hablar con el nuevo (¿protocolo?)"
ALTURA_OLD_RED=$("$OLD/rami-node" status --chain "$VN" --network regtest 2>/dev/null | awk '/altura/{print $3}')
[ "$ALTURA_OLD_RED" = "$ALTURA_V0" ] || falla "el nodo antiguo debería quedarse en $ALTURA_V0 y está en $ALTURA_OLD_RED"
# La ANTIGUA abre el directorio escrito por la nueva: la línea de la división
# trae un tipo de transacción que no conoce y está en MEDIO del fichero; su
# cargador (igual hasta la v0.10.16) aborta con un error limpio, sin pánico y
# sin tocar el fichero. Es la vuelta atrás de versión sobre el mismo
# directorio; por red no ocurre (el nodo antiguo ni siquiera lee esos bloques).
SUMA_V=$(sha256sum "$V/chain.jsonl" | cut -d' ' -f1)
if "$OLD/rami-node" verify --chain "$V" --network regtest >"$WORK/old-verify-viv.out" 2>"$WORK/old-verify-viv.err"; then
  falla "la antigua leyó un chain.jsonl con transacciones de vivienda (¿no se escribió la división?)"
fi
grep -q "bloque JSON inválido" "$WORK/old-verify-viv.err" || falla "la antigua no dio el motivo esperado: $(cat "$WORK/old-verify-viv.err")"
grep -qi "panic" "$WORK/old-verify-viv.err" && falla "la antigua entró en pánico"
[ "$(sha256sum "$V/chain.jsonl" | cut -d' ' -f1)" = "$SUMA_V" ] || falla "la antigua modificó chain.jsonl"
"$OLD/rami-wallet" address --label yo --keystore "$KS" | tail -1 | grep -q "$YO" || falla "la antigua no lee el monedero tras la vivienda"
# Y la nueva sigue abriendo lo mismo.
[ "$(nuevo status | awk '/altura/{print $3}')" = "$ALTURA_VIV" ] || falla "la nueva no reabre tras la antigua"
# Desde la v0.11.0 la vuelta atrás ya no rompe: ante un bloque bien formado
# con un tipo de transacción que no conoce (aquí, la división renombrada como
# si viniera de una versión posterior), la nueva lo salta, avisa, y se queda en
# la altura anterior, igual que un nodo sin actualizar por red.
F="$WORK/vivienda-futura"; rm -rf "$F"; cp -r "$V" "$F"
sed -i 's/"DivideParcel"/"TxDeUnaVersionPosterior"/' "$F/chain.jsonl"
grep -q TxDeUnaVersionPosterior "$F/chain.jsonl" || falla "no se pudo simular el bloque de una versión posterior"
# shellcheck disable=SC2086
"$NEW/rami-node" verify --chain "$F" --network regtest $VIV 2>"$WORK/new-verify-futuro.err" | contiene "íntegra" || falla "la nueva no abre un directorio con un bloque de una versión posterior: $(cat "$WORK/new-verify-futuro.err")"
grep -q "versión posterior" "$WORK/new-verify-futuro.err" || falla "la nueva no avisó del bloque que no entiende"
# shellcheck disable=SC2086
ALTURA_FUT=$("$NEW/rami-node" status --chain "$F" --network regtest $VIV 2>/dev/null | awk '/altura/{print $3}')
[ "$ALTURA_FUT" = "$((ALTURA_V0 + 1))" ] || falla "con el bloque desconocido debería quedarse en $((ALTURA_V0 + 1)) y está en $ALTURA_FUT"
echo "vivienda: antes $ALTURA_V0 · nueva con vivienda $ALTURA_VIV · sin fechas $ALTURA_SIN · solo Dubái $ALTURA_SOLO_DUBAI · antigua por red $ALTURA_OLD_RED · bloque de versión posterior $ALTURA_FUT"

log "OK: ida y vuelta $OLD_TAG ⇄ versión nueva sin pérdidas, activaciones v2 y de vivienda incluidas (directorio: $WORK)"
