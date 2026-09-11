# Regla de firma v2: la firma ligada a la red (cambio de consenso, v0.8.0)

Este documento describe el primer cambio de consenso de RAMI-Chain, cómo se
activa sin partir la red, qué ve cada versión antes y después, y cómo se ha
comprobado. Sigue la misma disciplina que el resto del proyecto: **hechos**
(lo que el código hace y lo que las pruebas ejecutaron) separados de
**juicios** (lo que esperamos que pase), y sin palabras de la lista prohibida
(`docs/PALABRA-EXACTA.md`).

## 1. El problema (hecho)

Hasta la v0.7.3 el mensaje que firma una transacción es

    "RAMI-CHAIN/tx/v1" || cuerpo(tx)

El cuerpo no lleva la red. Una transacción firmada en regtest con una clave y
un nonce dados es válida byte a byte en testnet para la misma clave y el mismo
nonce (`SECURITY.md`, «Lo que NO está resuelto», desde la v0.7.1). No se
conoce ningún caso real de repetición; el fallo está en el diseño, no en un
incidente.

## 2. La regla nueva (hecho)

Desde la activación, el mensaje firmado es

    "RAMI-CHAIN/tx/v2" || network_id || cuerpo(tx)

donde `network_id` es el hash del bloque génesis de la red (32 bytes), el
mismo que se anuncia en el saludo del Túnel RAMI. Una firma hecha para una red
no verifica en ninguna otra: cambia la etiqueta y cambian 32 bytes del
mensaje. El **txid no cambia de fórmula** (`sha256d(cuerpo || firma)`): la
regla decide qué firma es válida, no cómo se identifica la transacción.

Código: `rami-core/src/tx.rs` — `DS_TAG_V2`, `signing_message_v2`, `Regla`,
`regla_para`, `FirmaCtx`, `verify_tx_con`. `verify_tx` (sin contexto) sigue
siendo la regla v1 y sigue existiendo para que nada de la v0.7.x cambie de
significado.

## 3. Cómo se activa (hecho)

La regla la fija **la fecha del bloque** frente a la fecha de activación de los
parámetros de la red:

| Red | `Params.firma_v2_desde` | Regla para un bloque con timestamp `t` |
|---|---|---|
| testnet | `1 792 454 400` = **2026‑10‑20 00:00:00 UTC** | `t < desde` → v1; `t ≥ desde` → v2 |
| regtest | ninguna (salvo `--firma-v2-desde <unix>`) | siempre v1 |

`regla_para(v2_desde, timestamp)` es una función pura: dos nodos con los
mismos parámetros dan el mismo veredicto al mismo bloque, que es lo que evita
la bifurcación entre nodos actualizados. Antes de la fecha, v1 y **solo** v1;
desde la fecha, v2 y **solo** v2. No hay periodo en el que valgan las dos: un
bloque con una firma de la regla equivocada es inválido y se descarta, como
cualquier otro bloque inválido (no se castiga al par que lo trae más que por
el bloque inválido en sí).

**La regla no retrocede dentro de una rama.** Cada bloque del árbol guarda si
en él rige v2 (`BlockNode.firma_v2`): sí, si su timestamp alcanza la fecha
**o si ya regía en su padre**. El árbol (`rami-core/src/blocktree.rs`) usa ese
bit al insertar, al reproducir el estado y para decir qué rige «ahora» sobre
la cabeza (`BlockTree::firma_ctx`, `firma_v2_sobre`).

### Por fecha y no por altura, y por qué la regla no retrocede

Se eligió la fecha porque la altura de la testnet no se puede observar desde
todos los entornos en que se construye y prueba el proyecto, y porque la fecha
es la misma para un nodo que lleva un mes apagado: al volver, cada bloque que
descargue se juzga igual.

El coste es conocido y se dice entero: **el timestamp lo pone el minero y la
cadena no lo acota** (no hay regla de mediana de tiempo pasado ni de deriva
futura máxima; es un pendiente anterior a esta versión, ver `SECURITY.md`).
Sin el bit «no retrocede», un minero podría, tras la activación, poner a su
bloque un timestamp anterior a la fecha y colar firmas v1 (repetidas de otra
red): exactamente el agujero que la v2 cierra. Con el bit, una vez que un
bloque de la rama exige v2, todos sus descendientes la exigen, lleven el
timestamp que lleven (`activacion_v2.rs` lo prueba con un bloque de timestamp
una hora anterior a la fecha, hijo de un bloque v2).

En la otra dirección, un minero puede poner a su bloque un timestamp futuro
(≥ fecha) antes del 20 de octubre: para los nodos v0.8.0 ese bloque y sus
descendientes exigen v2; para los v0.7.x es inválido. Es la misma separación
que trae la fecha, adelantada por quien lo haga, y cuesta un bloque de
trabajo. No se afirma que no vaya a pasar; se afirma que no rompe nada más
que lo que la fecha rompe. La cota de timestamp queda como pendiente porque
es, en sí misma, otro cambio de consenso.

## 4. Mempool, minero y carteras (hecho)

- **Admisión.** El nodo verifica cada transacción nueva bajo la regla que
  rige *ahora* (`Node::accept_tx`). Si no vale, la rechaza con el motivo y la
  regla vigente («rige la regla v2»).
- **Candidato.** `build_candidate` solo incluye lo que verifica bajo la regla
  del timestamp del bloque candidato. Una transacción firmada con v1 que
  siga en el mempool al cruzar la fecha no entra en ningún bloque.
- **Poda.** En cada latido, desde la activación, el nodo retira del mempool
  lo que ya no vale (`podar_mempool_por_regla`) y lo persiste. El nonce de
  esas transacciones no se consumió: **hay que volver a enviarlas** (el
  monedero las firmará con v2). Es el único efecto visible para un usuario que
  tuviera algo pendiente justo en la activación.
- **Carteras.** `rami-wallet` firma siempre con un `FirmaCtx`: la CLI lo saca
  del árbol (`load_tree(params).firma_ctx(ahora)`), el panel de
  `NodeHandle::firma()`, el faucet igual que la CLI. Todas las funciones
  `build_*` llevan el contexto como primer parámetro. Al contar las
  pendientes para el siguiente nonce solo cuentan las que aún valen bajo la
  regla vigente.
- **Ventana de frontera.** Una transacción firmada un segundo antes de la
  activación con v1 y minada un segundo después queda fuera del bloque (y se
  poda). Se documenta en lugar de esconderse: es un reenvío, no una pérdida.

## 5. Lo que ve la red (hecho)

`Frame::Status` lleva un campo nuevo `rule` con la regla más alta que
entiende el emisor (`REGLA_SOPORTADA = 2`). Está marcado `#[serde(default)]`:

- Un nodo v0.7.x recibe un `Status` con `rule` y lo ignora (serde descarta
  campos desconocidos; probado en `protocol.rs`, «status_rule_es_opcional_en_ambos_sentidos»).
- Un nodo v0.8.0 recibe un `Status` sin `rule` y lee 0: «no anuncia».

`PROTO_VERSION` no cambia: v0.7.0, v0.7.3 y v0.8.0 se hablan. Con el campo, el
panel enseña **cuántos pares anuncian v2** (Red → «Regla de firma») y cada par
que no la anuncie lleva un motivo más en su graduación de fuente: «no anuncia
regla de firma (binario anterior a v0.8.0): quedará fuera al activarse la
regla v2». Es descriptivo: el código Admiralty no cambia por ello y el
consenso no lo mira.

## 6. Qué pasa con quien no se actualice (hecho, probado)

Un binario v0.7.x **abre todos sus ficheros** igual que antes: monedero,
cadena, mempool, reveals, pares, identidades y grados. El formato no cambia.
Desde la activación:

- Los bloques que solo llevan la coinbase los admite (no hay firma que
  juzgar). El primero con una transacción firmada v2 le parece inválido
  («firma inválida») y desde ahí los demás son huérfanos para él: se queda
  en esa altura. Su `verify` sigue diciendo «cadena íntegra» y avisa de los
  bloques que no re-admitió («… no se re-admitieron»).
- Puede seguir minando sobre su última altura: crea una rama con menos
  trabajo que la red. Cuando se actualice, la rama de la red gana por trabajo
  y sus bloques desde entonces quedan como rama perdedora (se conservan, como
  todo bloque válido en el universo de ramas; sus monedas no cuentan).
- No se cae, no corrompe nada y no bloquea a los demás.

Es la misma situación que cualquier cambio de consenso en cualquier cadena de
trabajo: el que no actualiza deja de seguir la cadena. Aquí, además, sus
ficheros siguen sirviendo tal cual el día que actualiza.

## 7. Cómo se ha comprobado (hecho)

- `rami-core`: regla por fecha inclusive; una firma v1 no pasa bajo v2 ni al
  revés; una firma v2 de otra red no pasa; el cuerpo del mensaje es el mismo
  en las dos reglas; `verify_tx` sigue siendo v1.
- `rami-node/tests/activacion_v2.rs`: génesis regtest real, monedero firmando
  con el contexto del árbol, `build_block` dejando fuera la tx v1 e
  incluyendo la v2, un árbol con la regla v1 rechazando el bloque **sin
  romperse** (se queda en el génesis) y un árbol gemelo con los mismos
  parámetros llegando a la misma cabeza. Y sin fecha, todo igual que en v0.7.
- `rami-net`: `Status` con y sin `rule` en las dos direcciones.
- `tools/compat/roundtrip.sh v0.7.0` (CI, con los **binarios reales** de la
  v0.7.0), paso 4: la nueva fuerza la activación en regtest
  (`--firma-v2-desde`), envía una tx v1 y una v2 y mina dos bloques; el primero
  lleva solo la v2. La misma versión **sin** la fecha no admite esos bloques
  (la regla depende de los parámetros, no del binario). La v0.7.0 abre el
  directorio: verifica, avisa de los bloques que no entiende, lee el saldo,
  mina su rama y arranca el nodo sin caerse; la nueva vuelve a abrir lo que la
  v0.7.0 escribió y la cabeza sigue siendo la rama v2.
- `tests/compat_v070.rs` sigue abriendo los ficheros escritos por la v0.7.0.

## 8. Lo que esperamos (juicio) y lo que no sabemos

- **Juicio:** con la fecha a más de un mes de la publicación de la v0.8.0 y el
  actualizador verificado del panel, la mayor parte de los nodos de la
  testnet estará actualizada el 20 de octubre. **Confianza moderada**: la
  testnet es pequeña y no hay telemetría; el único dato observable es el
  recuento de pares que anuncian v2 en cada panel.
- **No sabemos** cuántos nodos hay apagados con ficheros antiguos. No importa
  para la seguridad: al volver, actualizados, siguen la cadena; sin
  actualizar, se quedan en su altura.
- **No se afirma** ninguna ventaja económica ni ninguna propiedad que no esté
  en las pruebas de arriba. La testnet sigue sin valor.

## 9. Lista para operadores

1. Actualiza a v0.8.0 antes del **20 de octubre de 2026, 00:00 UTC**.
2. En Red → «Regla de firma», comprueba: regla vigente v1 hasta esa fecha,
   cuenta atrás, pares que anuncian v2.
3. Si el día de la activación tenías algo pendiente sin minar, vuelve a
   enviarlo.
4. Regtest: nada cambia salvo que pases `--firma-v2-desde <unix>` a
   `rami-node`, `rami-wallet` y `rami-gui` (los tres, con el mismo valor).
