# La escritura de vivienda: tu piso en el libro mayor (cambio de consenso, v0.11.0)

Este documento describe el tercer cambio de consenso de RAMI-Chain (la
Entrega 8 de `docs/METAVERSO.md`): qué defecto arregla, qué reglas trae, por
qué cada decisión es la que es, cómo se activa sin partir la red, qué ve cada
versión antes y después y cómo se ha comprobado. Misma disciplina que
`docs/CONSENSO-V2.md` y `docs/DUBAI.md`: **hechos** (lo que el código hace y lo
que las pruebas ejecutaron) separados de **juicios**, y sin palabras de la
lista prohibida (`docs/PALABRA-EXACTA.md`).

Testnet experimental: los RAMI no tienen valor monetario, no se venden y no
son una inversión (`NOTICE.md`). Lo que aquí se llama «precio», «venta» o
«compra» es RAMI de prueba movido por una regla pública. Una vivienda no cobra
nada de nadie: es la escritura de un piso de una ciudad de prueba.

## 1. El defecto (hecho)

Hasta la v0.10.16, `MintAsset` exige que el firmante sea el dueño de la
**parcela entera** (`state.rs`, «solo el dueño de la parcela puede acuñar en
ella»). Una parcela es una celda de 650 × 650 m: para «tener tu piso» había que
comprar la manzana. No era una carencia del cliente (el cliente ya enseña el
edificio y, desde la Entrega 5, su interior): era el consenso.

## 2. La regla (hecho)

Desde la activación, una parcela se puede **dividir en viviendas**. Cuatro
transacciones nuevas, variantes nuevas del mismo `enum Tx` con etiquetas
nuevas al final (`0x40`–`0x43`); ninguna codificación ni ningún txid anterior
cambia (lo fija `ninguna_codificacion_ni_txid_anterior_cambia`, con las
huellas de los 17 tipos anteriores sacadas del commit `44754ec` antes de tocar
nada):

| Transacción | Etiqueta | Campos | Quién | Coste |
|---|---|---|---|---|
| `DivideParcel` | `0x40` | `who, x, y, unidades: u16` | el dueño de la parcela | comisión |
| `TransferUnit` | `0x41` | `from, x, y, n: u16, to` | el dueño de la vivienda `n` | comisión |
| `SellUnit` | `0x42` | `who, x, y, n, price` (0 retira) | el dueño de la vivienda `n` | comisión |
| `BuyUnit` | `0x43` | `who, x, y, n, max_price` | cualquiera salvo el dueño | precio + comisión |

Codificación binaria (`tx::encode_body`), el mismo convenio que el resto:
etiqueta de un byte, direcciones de 32 bytes tal cual, coordenadas y números
pequeños (`x`, `y`, `unidades`, `n`) como `u64` little-endian, importes y
comisión y nonce como `u64`. Una `DivideParcel` ocupa 73 bytes de cuerpo, una
`TransferUnit` 105 y una `SellUnit`/`BuyUnit` 81 (más 64 de firma).
El JSON (`serde`) es el del resto de variantes: `{"DivideParcel": {...}}`, con
la firma en base64.

El estado (`state.rs`) gana:

- en `Parcel`, `unidades: u16` (0 = sin dividir) y `units: Vec<Unidad>`, el
  registro: `units[n - 1]` es la vivienda `n`, con `owner` y `sale`;
- en `State`, `viviendas_ajenas: BTreeMap<AccountId, u16>`, el contador del tope
  por cuenta (§3), que las pruebas comparan con su definición recontada desde
  las parcelas (`viviendas_ajenas_recontadas`) tras cada bloque.

El estado no se guarda en disco ni se hashea en ninguna cabecera: cada nodo lo
reconstruye aplicando los bloques de `chain.jsonl` (`store.rs`), así que los
campos nuevos no cambian el formato de ningún fichero.

Y `MintAsset`, **desde la activación**, lo firma el dueño de la parcela **o el
de cualquier vivienda de esa parcela**. Antes, exactamente como siempre (lo
prueba el mismo bloque aplicado con y sin la regla sobre un estado con
viviendas: sin ella, «solo el dueño de la parcela puede acuñar en ella»).

## 3. Los dos topes y por qué (decisión)

Su verificador los consideró imprescindibles antes de escribir la regla.

**Por parcela: `MAX_UNIDADES_POR_PARCELA = 64`.** La torre de una parcela
mide unos 220 m desde la v0.10.16: unas 62 plantas de 3,5 m. 64 es una vivienda
por planta, redondeado a potencia de dos. Además acota el estado: 64 × 64
celdas × 64 = **262 144 viviendas** como máximo en toda la ciudad, unos 48 bytes
cada una en memoria (dueño y venta), unos 12,6 MB por estado de punta en el peor
caso, y el `/api/city` de ese peor caso llevaría 262 144 `UnitView`. Llegar ahí
exige reclamar las 4096 celdas (su precio se quema) y dividirlas todas.

**Por cuenta: `MAX_UNIDADES_POR_CUENTA = 16` viviendas en parcelas de OTROS.**
Las de una parcela propia no cuentan: el promotor que divide su parcela en 64
tiene 64 viviendas suyas y puede recomprar las que vendió. Con 16, hace falta un
mínimo de cuatro cuentas para quedarse con todas las viviendas ajenas de un
edificio de 64, y una cuenta puede tener vivienda en 16 edificios distintos.

El tope es **por cuenta, no por persona**: crear cuentas no cuesta nada, así
que quien abra varias multiplica su tope (cada una necesita RAMI para las
comisiones y los precios). Es el límite de cualquier regla por cuenta en una
cadena sin identidad, y se dice aquí en vez de esconderlo. El tope por parcela
no depende de cuántas cuentas haya.

## 4. Las decisiones, una a una (hecho, con su porqué)

- **Numeración.** Las viviendas van de la 1 a la `unidades`; la 0 no existe.
- **Dividir: solo el dueño, una vez, de 1 a 64, no en venta, todas del dueño.**
  Una vez: redividir cambiaría los números de viviendas que ya tienen otros
  dueños. No en venta: lo que compra quien vio la parcela publicada no cambia
  por debajo de él. Todas del dueño: el suelo es suyo.
- **Dividir solo cuesta la comisión.** El suelo ya se pagó (y se quemó) al
  reclamar la parcela; dividirla no crea suelo nuevo.
- **Las viviendas del dueño de una parcela en venta van con ella.** Mientras
  dure la venta de la parcela, las viviendas que son de su dueño no se
  transfieren, no se ponen en venta y no se compran sueltas (retirar la venta
  de una vivienda sí se puede siempre). Así el comprador de la parcela recibe
  las que había al publicarse. Límite conocido: el vendedor puede retirar la
  venta de la parcela, mover viviendas y volver a publicarla al mismo precio;
  `BuyParcel` no lleva el número de viviendas esperado (cambiar su formato no
  es una opción) y el comprador solo está protegido en el precio, igual que hoy
  ante un cambio de nombre o de sector de la empresa en venta.
- **`BuyParcel` de una parcela dividida.** El comprador recibe las viviendas
  que eran del vendedor (y salen de la venta); las de terceros siguen siendo
  suyas. **El tope por cuenta no bloquea esta compra**, y no es una puerta
  trasera: todo lo que recibe el comprador es de su propia parcela, que el tope
  no cuenta; las viviendas que ya tenía en ella dejan de ser «ajenas»; y si
  después vende la parcela, todas sus viviendas de ella se van con la parcela.
  El invariante es «nadie tiene más de 16 viviendas en parcelas de otros»; la
  prueba `vivienda_topes_por_parcela_y_por_cuenta_sin_puerta_trasera` lo
  comprueba tras cada bloque de una secuencia que lo intenta: 16 ajenas,
  compra de la parcela donde las tiene, 16 ajenas más en otra parcela, sacar
  viviendas a otra cuenta (que tiene su propio tope) y volver a vender.
- **`TransferUnit` a uno mismo se rechaza** («la vivienda ya es tuya»); una
  vivienda en venta no se transfiere (primero se retira la venta).
- **`BuyUnit` usa exactamente la política de `BuyAsset` y `BuyParcel`:** el
  comprador paga el precio entero al vendedor y la comisión al minero (por la
  cota de la coinbase); no se quema nada; pago y cambio de dueño van en la
  misma transacción; `max_price` protege al comprador si el vendedor cambia el
  precio antes de que se mine. La operación se apunta en `State.trades`
  (`ciudad::Trade`) con `kind: 2` (0 parcela, 1 activo, 2 vivienda) y el sector
  de la parcela.
- **Una vivienda no cobra del fondo de la ciudad.** El reparto de cada bloque
  (`ciudad::tick`) sigue yendo a la empresa, el dueño de la parcela. Una
  vivienda es la escritura de un piso, no una parte del negocio.
- **Todo o nada.** Las cuatro transacciones comprueban nonce, saldo, reglas y
  topes **antes** de tocar el estado; un rechazo no consume el nonce ni cobra
  la comisión. Importa fuera del bloque: el mempool y el candidato del minero
  las prueban sobre una copia que siguen usando para las siguientes
  (`vivienda_un_rechazo_no_deja_nada_a_medias`).
- **Aritmética entera con `checked_*`** en todo lo nuevo: un desbordamiento es
  un rechazo, nunca un pánico ni una vuelta a cero. Ni floats ni reloj: dos
  nodos con el mismo estado llegan al mismo resultado.

## 5. Cómo se activa (hecho)

Como la firma v2 y Dubái, la fija **la fecha del bloque** frente a la de los
parámetros de la red:

| Red | `Params.vivienda_desde` | Regla para un bloque con timestamp `t` |
|---|---|---|
| testnet | `1 803 859 200` = **2027‑03‑01 00:00:00 UTC** (`VIVIENDA_DESDE_TESTNET`, fijado por `fechas_de_activacion_de_la_testnet`) | `t < desde` → sin vivienda; `t ≥ desde` → con ella |
| regtest | ninguna (salvo `--vivienda-desde <unix>`) | nunca |

- **La vivienda implica Dubái.** `FirmaCtx` gana el bit `vivienda` y
  `con_vivienda()`, pero todas las comprobaciones preguntan a
  `FirmaCtx::vivienda_rige()` = `dubai && vivienda`. Una red con fecha de
  vivienda y sin Dubái no la tiene; en regtest hay que pasar las dos fechas.
- **No retrocede dentro de una rama.** Cada bloque del árbol guarda si en él
  rige (`BlockNode.vivienda`): sí, si rige Dubái en él y además su timestamp
  alcanza la fecha **o ya regía en su padre** (`BlockTree::vivienda_sobre`).
  Probado con un hijo de timestamp una hora anterior a la fecha que sigue
  admitiendo una venta de vivienda, y con una rama hermana anterior a la fecha
  que NO hereda la activación de la otra rama.
- **Sin periodo mixto.** Antes de la fecha, un bloque con cualquiera de las
  cuatro es inválido («transacción de vivienda antes de su activación»);
  desde la fecha, valen. Un bit por bloque.
- **Número de regla.** `FirmaCtx::numero()` pasa a 4 con la vivienda (1 firma
  v1, 2 firma v2, 3 Dubái con perfiles). Es la regla **vigente** que enseña el
  panel. La regla que un binario **anuncia** en `Status.rule` es otra escala:
  `REGLA_SOPORTADA` pasa de 4 (perfiles, v0.10.0) a **5** (vivienda, v0.11.0),
  y `REGLA_PERFIL = 4` queda para contar a los pares que se quedarán en el
  primer bloque con una transacción de vivienda. `PROTO_VERSION` no cambia.
- **Quien no se actualice** (un binario v0.10.x) admite todos los bloques hasta
  el primero con una transacción de vivienda; ese le parece inválido y los
  siguientes son huérfanos: se queda en esa altura sin caerse
  (`activacion_vivienda.rs`, árbol con Dubái y sin vivienda frente a los mismos
  bloques). Su minero deja fuera las transacciones de vivienda (no verifican
  bajo su regla). Cada par que anuncie una regla menor que 5 lleva en Red el
  motivo «anuncia la regla N sin vivienda (binario anterior a v0.11.0)».

## 6. Los errores (hecho)

Forma (`verify_tx_con`, antes de mirar el estado; el mempool los devuelve tal
cual):

- `transacción de vivienda antes de su activación` (o sin Dubái);
- `parcela fuera de la ciudad`;
- `número de viviendas fuera de rango (de 1 a 64)` (`DivideParcel`);
- `número de vivienda fuera de rango (de 1 a 64)` (las otras tres);
- `el precio máximo de compra debe ser mayor que cero` (`BuyUnit`).

Estado (`apply_tx`):

- `la escritura de vivienda no rige todavía` (si se llamara sin la regla);
- `la parcela no tiene dueño`; `solo el dueño de la parcela puede dividirla`;
  `la parcela ya está dividida en N viviendas`; `la parcela está en venta:
  retira la venta antes de dividirla`;
- `la parcela no está dividida en viviendas`; `la parcela tiene N viviendas:
  no existe la M`; `no eres el dueño de esa vivienda`; `la vivienda ya es tuya`;
  `la vivienda está en venta: retira la venta antes de transferirla`;
- `la parcela está en venta y sus viviendas del dueño van con ella: retira
  antes la venta de la parcela`;
- `la vivienda no está en venta`; `ya es tuya`; `el precio (P) supera tu
  máximo (M)`;
- `tope de viviendas por cuenta: ya tiene 16 en parcelas de otros`;
- `nonce … (anti-replay)` y `saldo insuficiente`, como en el resto;
- `solo el dueño de la parcela o de una de sus viviendas puede acuñar en ella`
  (`MintAsset` desde la activación).

## 7. Ficheros y compatibilidad (hecho, probado)

Ningún fichero cambia de formato: `chain.jsonl` sigue siendo un bloque JSON por
línea, y un bloque con transacciones de vivienda es un bloque con variantes
nuevas del mismo `enum Tx`. El monedero, el mempool, los pares, las
identidades y los grados no se tocan.

- **La versión nueva abre todo lo anterior** (pasos 1–4 de
  `tools/compat/roundtrip.sh`, sin cambios).
- **Por red, un binario antiguo nunca guarda un bloque de vivienda**: no sabe
  deserializarlo, así que ni lo admite ni lo escribe; se queda en su altura
  (paso 5, con un nodo v0.7.0 conectado a uno nuevo que tiene los bloques).
- **Volver atrás de versión sobre el mismo directorio.** Hasta la v0.10.16 el
  cargador (`ChainDir::load_blocks`) aborta en una línea que no sabe leer si
  está en medio del fichero, y un bloque de vivienda seguido de otro lo está.
  La v0.7.0 que abre ese directorio falla con «línea N: bloque JSON inválido»,
  sin pánico y sin tocar el fichero (paso 5 lo comprueba con la suma SHA-256);
  la salida es volver a la v0.11.0. Es el mismo caso que `docs/DUBAI.md` §6
  describe para las transacciones de mercado; no se puede arreglar hacia atrás
  porque el binario antiguo ya está publicado.
- **Desde la v0.11.0 ya no pasa hacia delante.** `load_blocks` distingue un
  bloque **bien formado** (JSON con una cabecera que se lee como
  `BlockHeader` y una lista `txs`) que trae un tipo de transacción desconocido
  —lo escribió una versión posterior— de la basura: lo salta, avisa («… con
  transacciones que esta versión no conoce (los escribió una versión
  posterior); se ignoran»), sus descendientes quedan huérfanos y el nodo se
  queda en la altura anterior, lo mismo que por red. La basura en medio sigue
  abortando. Probado en `store.rs`
  (`bloque_de_una_version_posterior_se_salta_sin_abortar`) y en el paso 5, con
  el binario real, sobre una copia con la división renombrada como si viniera
  de una versión futura.

## 8. Nodo, cartera y panel (hecho)

**Nodo (`rami-node`).** Contrato fijo para el cliente 3D (interiores):

- `ParcelView` gana `unidades: u16` y `units: Vec<UnitView>` con **todas** las
  viviendas: `UnitView { n, owner, handle, sale }` (`handle` = nombre único del
  dueño si tiene perfil, vacío si no; `sale` en unidades base de RAMI).
- `CityView` gana `vivienda: bool`, `vivienda_desde: Option<u64>` y
  `vivienda_faltan_segundos: u64`.
- `PendingView` con `op` `"divide"`, `"unit_transfer"`, `"unit_sell"` y
  `"unit_buy"`, y campos nuevos `n`, `unidades` y `to`.
- `TxView` del explorador: `divide_parcel`, `transfer_unit`, `sell_unit`,
  `buy_unit`.
- Mercado (`/api/market`, `rami-node market`): un par `VIVIENDA_RAMI` (sin
  precio de protocolo: dividir no quema nada), las viviendas en venta como
  órdenes `kind: "unit"` (el número de vivienda en `asset`) y las operaciones
  cerradas como `kind: "unit"`.
- `ConsensoInfo` gana `vivienda_desde`, `vivienda_vigente`,
  `vivienda_faltan_segundos` y `pares_vivienda`.
- Mempool y candidato: `verify_tx_con` y `apply_tx` con el mismo `FirmaCtx`
  que el bloque (`try_apply` recibe el contexto entero, no un bit).

**Cartera (`rami-wallet`).** `build_divide_parcel`, `build_transfer_unit`,
`build_sell_unit`, `build_buy_unit`, y la CLI `claim`, `divide`,
`unit-transfer`, `unit-sell` (`--price 0` retira) y `unit-buy`; comprueban la
transacción contra el estado de la cabeza con el mempool aplicado antes de
escribirla, y dicen el motivo si no aplica.

**Panel (`rami-gui`).** `POST /api/city/divide {x, y, unidades}`,
`/api/city/unit_transfer {x, y, n, to}`, `/api/city/unit_sell {x, y, n,
price}` y `/api/city/unit_buy {x, y, n, max_price}`, con las mismas defensas
que `/api/city/sell` y `/api/city/buy_asset` (host y origen locales, JSON,
token de sesión, forma acotada; las reglas, en el nodo). En la ficha de la
parcela, la sección «Viviendas»: antes de la activación, una línea con la
fecha y lo que falta; después, dividir (si es tuya y no está en venta), la
lista de viviendas (número, dueño —nombre o dirección corta—, precio en RAMI
si está en venta) y las acciones de quien mira: vender, retirar y transferir
las suyas, comprar una en venta. Precios siempre en RAMI y sin símbolo de
moneda. `--vivienda-desde <unix>` en `rami-gui`, `rami-node` y `rami-wallet`
(regtest), como `--dubai-desde`.

## 9. Cómo se ha comprobado (hecho)

- `rami-core`: `fechas_de_activacion_de_la_testnet`;
  `ninguna_codificacion_ni_txid_anterior_cambia`;
  `las_tx_de_vivienda_solo_valen_con_su_regla_y_con_dubai`;
  `codificacion_de_vivienda_de_ida_y_vuelta`;
  `vivienda_dividir_transferir_vender_comprar_y_acunar`;
  `vivienda_topes_por_parcela_y_por_cuenta_sin_puerta_trasera`;
  `vivienda_antes_de_la_activacion_el_bloque_es_invalido`;
  `vivienda_un_rechazo_no_deja_nada_a_medias`;
  `vivienda_se_activa_por_fecha_solo_con_dubai_y_no_retrocede_en_la_rama`;
  `bloque_de_una_version_posterior_se_salta_sin_abortar`.
- `rami-node/tests/activacion_vivienda.rs`: génesis regtest real, monedero
  real, `build_block`; el árbol sin vivienda admite hasta la parcela y se
  queda en la división sin romperse; venta, compra y transferencia en un
  bloque; un local acuñado por la dueña de una vivienda; gemelo con la misma
  cabeza y el mismo estado; la regla que no retrocede; y sin fecha (o sin
  Dubái) la división no entra en ningún bloque.
- `tools/compat/roundtrip.sh v0.7.0`, paso 5, con los binarios reales.
- Extremo a extremo en regtest con el monedero de escritorio (dos carteras en
  dos carpetas personales, conectadas por el Túnel RAMI): ver
  `notas/escritura.md`.

## 10. Lo que no se sabe y lo que falta

- **Juicio:** 64 y 16 son un primer ajuste con la razón de §3; no hay datos
  de uso. Cambiarlos es otro cambio de consenso con su fecha.
- El tope por cuenta no detiene a quien reparta sus compras entre muchas
  cuentas (§3).
- El comprador de una parcela dividida está protegido en el precio, no en el
  número de viviendas que recibe (§4).
- El cliente 3D todavía no dibuja a quién pertenece cada vivienda: el
  contrato (`units`) está publicado para la Entrega 5.

## 11. Lista para operadores

1. Actualiza a la v0.11.0 antes del **1 de marzo de 2027, 00:00 UTC**.
2. En Red, cada par que no anuncie la regla 5 lleva su motivo.
3. Regtest: `--dubai-desde <unix>` **y** `--vivienda-desde <unix>` en
   `rami-node`, `rami-wallet` y `rami-gui` (los tres, con los mismos valores).
