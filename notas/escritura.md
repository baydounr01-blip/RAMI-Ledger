# Notas del frente «escritura» (v0.11.0): la escritura de vivienda

Entrega 8 de `docs/METAVERSO.md`. La regla completa, sus decisiones y su
porqué están en `docs/VIVIENDA.md`; esto es lo que el integrador necesita para
las notas de versión y quien toque el código después.

## Qué se hizo

- **Consenso nuevo con fecha propia.** Una parcela se divide en viviendas
  (`DivideParcel`, de 1 a 64) que se transfieren (`TransferUnit`), se ponen en
  venta (`SellUnit`, precio 0 retira) y se compran (`BuyUnit`). El dueño de
  cualquier vivienda acuña activos en su parcela (`MintAsset`). Rige desde el
  **1 de marzo de 2027 00:00:00 UTC** (`VIVIENDA_DESDE_TESTNET = 1 803 859 200`)
  y solo donde rige Dubái; en regtest, `--vivienda-desde <unix>` (con
  `--dubai-desde`) en `rami-node`, `rami-wallet` y `rami-gui`.
- **Los dos topes:** 64 viviendas por parcela y 16 por cuenta en parcelas de
  otros (las de la parcela propia no cuentan).
- **Nodo, cartera, panel:** vistas nuevas (contrato fijo para interiores),
  constructores y CLI, cuatro rutas POST y la sección «Viviendas» de la ficha
  de la parcela; el mercado sabe de viviendas.
- **Compatibilidad de ficheros:** el cargador de `chain.jsonl` salta un bloque
  bien formado de una versión posterior en vez de abortar; `roundtrip.sh`
  gana el paso 5.
- **Arreglo de paso en el panel (no era de este frente, pero lo usa):** los
  botones de compra mandaban el precio máximo con `ramFmt`, que formatea en
  es-ES («2,5», «1.000»): el nodo lo leía como «importe inválido» o, con
  miles, como 1 RAMI. Ahora mandan `ramExacto` («2.50000000»). Afecta a
  comprar parcela (`cyBuy`), activo (`cyBuyA`), y a los botones del mercado
  (`mkBuy`). Lo destapó la compra de una vivienda a 2,5 RAMI desde el panel.

## Cómo está hecho (para quien lo toque)

### rami-core

- `params.rs`: `VIVIENDA_DESDE_TESTNET`, `Params.vivienda_desde`,
  `con_vivienda_desde()`; test `fechas_de_activacion_de_la_testnet` (las tres
  fechas contra su calendario).
- `tx.rs`: variantes nuevas al final del `enum Tx`, etiquetas `0x40`–`0x43`,
  mismo convenio de codificación (u16 como u64 LE). `MAX_UNIDADES_POR_PARCELA`
  (64) y `MAX_UNIDADES_POR_CUENTA` (16). `es_tx_vivienda`. `FirmaCtx` gana
  `vivienda`, `con_vivienda()`, `vivienda_para()` y **`vivienda_rige()` =
  `dubai && vivienda`**: toda comprobación pregunta aquí, así la vivienda
  nunca rige sin Dubái aunque alguien construya el contexto a mano.
  `numero()` = 4 con vivienda. `verify_tx_con`: «transacción de vivienda antes
  de su activación» y la forma (rango, parcela en la ciudad, `max_price > 0`).
  Las huellas (txid y SHA-256 del JSON) de los 17 tipos anteriores, sacadas
  del commit `44754ec` ejecutando el mismo test ANTES de añadir nada, quedan
  en `HUELLAS_V0_10_16`.
- `state.rs`: `Parcel.unidades` + `Parcel.units: Vec<Unidad>` (`units[n-1]`),
  `State.viviendas_ajenas` (contador del tope) y
  `viviendas_ajenas_recontadas()` (su definición, para las pruebas).
  `apply_tx` recibe ahora `&FirmaCtx` en vez de `dubai: bool` (el único
  llamante externo es `rami_node::try_apply`). Ayudantes
  `comprobar_nonce`/`comprobar_saldo`/`consumir`: las cuatro transacciones
  nuevas comprueban TODO antes de mutar (un rechazo no deja el nonce ni la
  comisión consumidos en la copia del mempool). `comprobar_no_congelada`:
  las viviendas del dueño de una parcela en venta van con ella. `BuyParcel`
  mueve al comprador las viviendas del vendedor y descuenta del contador las
  que el comprador ya tenía en esa parcela (el tope no bloquea la compra; el
  porqué, en `docs/VIVIENDA.md` §4). `BuyUnit` replica la política de
  `BuyAsset`: precio al vendedor, comisión al minero, nada quemado, `Trade`
  con `kind: 2`.
- `blocktree.rs`: `BlockNode.vivienda`, `vivienda_sobre()`; la regla se decide
  como Dubái (fecha o padre) y además exige Dubái en el mismo bloque.
- `store.rs`: `es_bloque_de_otra_version()` y el salto con aviso en
  `load_blocks`.

### rami-node

- `ParcelView.unidades`, `ParcelView.units: Vec<UnitView { n, owner, handle,
  sale }>` (todas); `CityView.vivienda`, `vivienda_desde`,
  `vivienda_faltan_segundos`; `PendingView` con `op` `divide`,
  `unit_transfer`, `unit_sell`, `unit_buy` y campos `n`, `unidades`, `to`;
  `TxView` `divide_parcel`, `transfer_unit`, `sell_unit`, `buy_unit`.
- Mercado: par `VIVIENDA_RAMI` (solo si rige), órdenes `kind: "unit"` (el
  número en `asset`), operaciones `kind: "unit"`.
- `REGLA_SOPORTADA` 4 → 5, `REGLA_PERFIL = 4`; `ConsensoInfo` con
  `vivienda_desde`, `vivienda_vigente`, `vivienda_faltan_segundos`,
  `pares_vivienda`, y el motivo «anuncia la regla N sin vivienda» en Red.
- `try_apply(sim, tx, height, &FirmaCtx)`.
- Test `tests/activacion_vivienda.rs` (dos casos).

### rami-wallet

- `build_divide_parcel`, `build_transfer_unit`, `build_sell_unit`,
  `build_buy_unit`.
- CLI: `claim`, `divide`, `unit-transfer`, `unit-sell`, `unit-buy`
  (`enviar_ciudad`: simulan sobre el estado de la cabeza con el mempool
  aplicado y dicen el motivo si no aplica, antes de escribir en el mempool).
  `claim` no existía y hacía falta para el paso 5 de `roundtrip.sh`.

### rami-gui

- `main.rs`: rutas `/api/city/divide`, `/unit_transfer`, `/unit_sell`,
  `/unit_buy` por `signed_submit`, con `unidad_num()` para la forma;
  `--vivienda-desde`.
- `dashboard.html`: en `renderCityPanel` una línea, `h +=
  viviendasHtml(p, me, d, pend)`; el resto va aparte, justo después
  (`viviendasHtml`, `viviendaDueno`, `viviendasAjenas`, `vivGuardaEstado`,
  `vivValor` y su propio `addEventListener("click")` sobre `#cityActions`).
  Una línea por vivienda (hasta 64 en una caja con desplazamiento); las
  acciones propias, plegadas en «Gestionar». Como el panel se repinta con
  cada bloque, lo abierto y lo tecleado en la sección se guarda y se repone
  (clave `x,y,n`). El precio tecleado admite coma decimal (`ramTecleado`).
  Fuera de `renderCityPanel`, cambios de una línea en: `buildCityIndex`
  (parcela pendiente con `unidades:0, units:[]`), `tickerLabel`
  (`VIVIENDA_RAMI`), la tabla de órdenes del mercado y su botón de compra
  (`kind: "unit"` → `/api/city/unit_buy`), y `ramExacto` en `cyBuy`/`cyBuyA`/
  `mkBuy` (arreglo de arriba).
- Textos: 23 cadenas nuevas en `chain/crates/rami-gui/i18n-src/frag_escritura.json`
  (en, zh, ru, sw), pasadas por los patrones de `tools/panel/lexico.py` en los
  cinco idiomas: limpias.

### tools/compat/roundtrip.sh

- Respeta `CARGO_TARGET_DIR` para la versión nueva y compila la antigua en su
  propio árbol (antes, con `CARGO_TARGET_DIR` definida, la antigua pisaba los
  binarios nuevos). Sin la variable, igual que antes.
- Paso 5 (vivienda): ver la tabla de abajo.

## Cifras medidas

| Qué | Cifra |
|---|---|
| `cargo test --workspace --release --locked` | **149 en verde** (137 antes + 12 nuevas: 1 params, 3 tx, 4 state, 1 blocktree, 1 store, 2 nodo) |
| Cuerpo codificado | `DivideParcel` 73 B · `TransferUnit` 105 B · `SellUnit`/`BuyUnit` 81 B (+64 de firma) |
| Tope por parcela | 64 → 262 144 viviendas como máximo en la ciudad; 48 B por vivienda en memoria → 12,6 MB por estado de punta en el peor caso |
| `UnitView` en `/api/city` (medido) | 106–113 B de JSON cada una → ~7,1 KB una parcela de 64; ~29 MB el peor caso de toda la ciudad |
| `ParcelView` (medido) | 386 B sin dividir → 1 058 B dividida en 6 |
| `roundtrip.sh v0.7.0`, paso 5 (alturas) | antes 11 · nueva con vivienda 14 · la misma sin fechas 11 · con Dubái y sin vivienda 12 · v0.7.0 conectada por red 11 · con un bloque «de una versión posterior» 12 |
| v0.7.0 abriendo el directorio con vivienda | falla limpia: «línea 14: bloque JSON inválido: unknown variant `DivideParcel`…», sin pánico, `chain.jsonl` con la misma SHA-256 |
| Extremo a extremo regtest (dos carteras, dos HOME, Túnel RAMI) | 3 viviendas compradas por B (3; 2,5; 1,5 RAMI), 1 transferida, 1 objeto acuñado por B en la parcela de A, `handle` «beatriz» en `units` tras `SetProfile`; A y B con la misma altura y el mismo registro |
| Binario `rami-gui` | 8 297 880 → 8 428 200 B (+130 320 B, +1,6 %) |
| Escena 3D (`ab.mjs`, 8 encuadres fijos, este binario y este panel) | **idéntica a la referencia v0.10.16 en los 8**: torres_cerca 920 678/21 · bloques_manzana 790 042/17 · villas 959 508/15 · naves 1 014 414/21 · a_pie_manzana 952 544/28 · a_pie_torre 802 440/17 · ciudad_entera 1 748 908/86 · centro 1 532 854/42 (triángulos/llamadas); 0 errores de consola. `city3d.js` y los módulos no se tocan |

## Pruebas y capturas

- `cargo test --workspace --release --locked` con
  `CARGO_TARGET_DIR=/tmp/ramiwt/escritura/target`: 149/149 (pasado dos veces;
  la segunda, con el código final).
- `COMPAT_WORK=/tmp/ramiwt/escritura/compat tools/compat/roundtrip.sh v0.7.0`:
  verde, pasos 1–5.
- `tools/security/inventory.sh --check`: sin cambios.
- `python3 tools/panel/check.py`, `python3 tools/panel/lexico.py`: en verde.
- Extremo a extremo: `/tmp/ramiwt/escritura/e2e.sh` (fuera del repo): A
  reclama (21,45), divide en 6 (vista antes como pendiente `divide`), pone la
  2 a la venta; B (otro HOME, conectada a A) sincroniza, recibe 20 RAMI, se
  le rechaza un máximo de 2 frente a un precio de 3 y dividir una parcela
  ajena, compra la 2 por 3 RAMI (la tx viaja a A por la red y A la mina),
  acuña un objeto en la parcela; explorador y mercado con los tipos nuevos.
  Después, desde el panel (Playwright, `viviendas.mjs`): A pone la 6 a la
  venta tecleando «1,5»; B la ve y la compra con el botón.
- Capturas (miradas una a una):
  - `/tmp/ramiverif/escritura_viviendas_duena.png` — la dueña: 6 viviendas,
    «Gestionar» abierto en la 6 tras repintar, en venta por 1,5 RAMI.
  - `/tmp/ramiverif/escritura_viviendas_compradora.png` — la compradora ve
    «Comprar por 1,5 RAMI» en la 6.
  - `/tmp/ramiverif/escritura_viviendas_comprada.png` — tras minarse: la 6 es
    suya, «Tienes 4/16».
  - `/tmp/ramiverif/escritura_viviendas_handle.png` — dueños por su nombre
    único (`@beatriz`).
  - `/tmp/ramiverif/escritura_dividir.png` — parcela propia sin dividir con el
    formulario.
  - `/tmp/ramiverif/escritura_antes_activacion.png` — la línea de antes de la
    activación con la fecha de la testnet («1 de marzo de 2027 00:00 UTC ·
    faltan 159 d …»), con `/api/city` interceptado para poner la fecha real.
  - `/tmp/ramiverif/escritura_mercado.png` — operaciones cerradas «Vivienda».
  - `/tmp/ramiverif/escritura_humo_ciudad.png` — el panel real (testnet, este
    binario, `lanza.sh` + `humo.mjs`) con todo el 3D y los cinco módulos
    cargados: 0 errores de consola, 0 ganchos fallidos.
  - `/tmp/ramiverif/escritura_ab.json` y `escritura_<encuadre>.png` — los
    ocho encuadres A/B (mirada `escritura_a_pie_torre.png`).
  - `/tmp/ramiverif/escritura_mapa2d.png` — el mapa 2D de regtest con las dos
    parcelas de la prueba (21,45) y (22,45).

## Lo que queda

- **Las traducciones** están en `frag_escritura.json`; hasta que el
  integrador las fusione en `allkeys.json`/`lang_*.json`, el panel enseña
  esas 23 cadenas en español en los otros idiomas (`check.py` lo lista, no
  bloquea).
- **El cliente 3D no dibuja las viviendas** ni sus dueños: el contrato
  (`units`) está publicado para la Entrega 5 (umbral/interiores).
- **Límites de diseño dichos en `docs/VIVIENDA.md` §10:** el tope es por
  cuenta, no por persona; el comprador de una parcela dividida está protegido
  en el precio, no en el número de viviendas (retirar, mover y volver a
  publicar en el mismo bloque).
- **La v0.7.0–v0.10.16 no abre un directorio con bloques de vivienda** tras
  volver atrás de versión (error limpio, fichero intacto). No se puede
  arreglar hacia atrás; desde la v0.11.0 ya no pasa hacia delante.
- **Hallazgo fuera de este frente (sin arreglar):** `build_candidate`
  (`rami-node/src/lib.rs`) simula el mempool sobre UNA copia y la sigue usando
  aunque `try_apply` falle, y `apply_tx` de los tipos anteriores (p. ej.
  `BuyAsset`) consume el nonce antes de rechazar. Si una compra deja de valer
  (el vendedor subió el precio) y el mismo firmante tiene otra pendiente con
  el nonce siguiente, el candidato incluye la segunda sin la primera y el
  bloque minado es inválido para el propio árbol, una y otra vez. Deducido
  del código, no reproducido. Las cuatro transacciones de vivienda no lo
  provocan (comprueban antes de mutar). Arreglo propuesto: `try_apply`
  transaccional o comprobar-antes-de-mutar en todos los tipos.
