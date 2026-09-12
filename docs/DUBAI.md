# Dubái RAMI: el metaverso como reglas de consenso (cambio de consenso, v0.9.0)

Este documento describe el segundo cambio de consenso de RAMI-Chain, cómo se
activa sin partir la red, qué reglas trae, qué ve cada versión antes y después
y cómo se ha comprobado. Misma disciplina que `docs/CONSENSO-V2.md`: **hechos**
(lo que el código hace y lo que las pruebas ejecutaron) separados de
**juicios**, y sin palabras de la lista prohibida (`docs/PALABRA-EXACTA.md`).

Testnet experimental: los RAMI no tienen valor monetario (`NOTICE.md`). Lo que
aquí se llama «ingreso», «precio» o «venta» es RAMI de prueba movido por una
regla pública.

## 1. Qué cambia (hecho)

Hasta la v0.8.0 la Ciudad RAMI (fase 0) era una cuadrícula de 32×32 parcelas
con cuatro tipos, un precio fijo de 10 RAMI que se quema, activos (planta u
objeto), alquileres y cosechas. Desde la activación de Dubái rigen las reglas
de `rami-core/src/ciudad.rs`:

| Regla | Antes | Desde Dubái |
|---|---|---|
| Cuadrícula | 32×32 | **64×64** celdas de 650 m sobre una réplica abierta de Dubái (`geo/dubai.json`, `grid`) |
| Sectores de empresa | 4 (empresa, granja, tienda, oficina) | **30** (`SECTORES`): los cuatro de antes conservan su número; concesionario, hotel, restaurante, inmobiliaria, constructora, energía solar, desaladora, logística y puerto, telecomunicaciones, banco, marketing, software, taller, aseguradora, bufete, clínica, escuela de negocios, joyería, supermercado, gimnasio, turismo, taxi, cafetería, moda, seguridad, materiales |
| Grafo de insumos | — | cada sector **necesita** de 2 a 6 sectores (`Sector.insumos`); todo sector es insumo de alguien (el grafo es cerrado; lo comprueba una prueba) |
| Distritos | — | **35** (`DISTRITOS` + The World, Golfo, Desierto): rectángulo de la cuadrícula, precio de parcela y «actividad» |
| Precio de una parcela libre | 10 RAMI, se quema | **el del distrito** (5 RAMI en el desierto … 300 en Palm Jumeirah), se quema |
| Tipos de activo | planta, objeto (1 RAMI) | + **vehículo** (5 RAMI, solo lo acuña un concesionario) y **local** (20 RAMI); todo se quema |
| Fondo de la ciudad | — | el **20 %** de la emisión de cada bloque (`CITY_SHARE_BPS`) entra en `State.city_fund`; la coinbase ya no puede cobrarlo. El bloque 0 queda fuera. Las comisiones siguen enteras para el minero |
| Reparto | — | cada bloque se reparte el **1 %** del fondo (`PAYOUT_BPS`) entre las empresas, proporcional a su puntuación (§2) |
| Insumos | — | de cada ingreso, el **40 %** (`SUPPLY_BPS`) se divide a partes iguales entre los insumos del sector; cada parte va al **proveedor más cercano** (distancia Manhattan; a igual distancia, el primero en el orden de la cuadrícula); si un insumo no existe en la ciudad, esa parte **se quema** (importación) |
| Mercado | — | `SellParcel`/`BuyParcel` y `SellAsset`/`BuyAsset`: precio en RAMI, el comprador fija un máximo, **pago y cambio de dueño en la misma transacción**; las últimas 256 operaciones quedan en `State.trades` |
| Contadores | — | `State.quemado` (parcelas, acuñados, importaciones) y, por parcela, ingresos, último ingreso, ventas, insumos pagados e importado |

Lo que **no** cambia: la emisión total (~21 M), el halving, las firmas (regla
v2 desde el 20 de octubre), el PoW, el LWMA, el fork-choice, el commit-reveal,
los alquileres y las cosechas, el formato de bloque y de transacción existente
(las transacciones nuevas son variantes nuevas del mismo `enum Tx`, con
bytes de dominio `0x20`–`0x23`), el protocolo P2P (`PROTO_VERSION` sigue en 2).

## 2. La regla del reparto (hecho)

Para cada empresa `E` de sector `s` en la celda `(x, y)` del distrito `d`:

```
cobertura(E)   = 1000 · (insumos de s con al menos un proveedor en la ciudad, sin contar E) / |insumos de s|   (permil)
puntuación(E)  = demanda(s) · actividad(d) · afinidad(d, s) · (1000 + cobertura(E))
pago_bloque    = fondo · 100 / 10 000
ingreso(E)     = pago_bloque · puntuación(E) / Σ puntuación             (división entera)
bolsa(E)       = ingreso(E) · 4000 / 10 000
por_insumo(E)  = bolsa(E) / |insumos de s|
```

Por cada insumo: si hay proveedor, `por_insumo` va al saldo de su dueño (y a
`ventas` de esa parcela); si no, `por_insumo` se suma a `quemado`. El dueño de
`E` cobra `ingreso − Σ por_insumo` (los restos de las divisiones enteras se
quedan con él). Lo que no se reparte por redondeo queda en el fondo. Todo es
aritmética entera en `u128` y recorre `BTreeMap`s: dos nodos con el mismo
estado obtienen el mismo resultado byte a byte (`ciudad::tick`, probado en
`el_reparto_es_determinista_conserva_el_total_y_paga_a_proveedores`).

`afinidad(d, s)` es una tabla de permiles (1000 = neutra) que sitúa cada
actividad donde está en el Dubái real: el puerto en Jebel Ali (×3), el oro en
Deira (×3), los bancos en DIFC (×3), los talleres y concesionarios en Al Quoz,
las placas solares en el desierto (×3), las escuelas en Academic City… La
lista completa está en `AFINIDAD`; lo que no aparece vale 1000.

El **mentor** del panel (`ciudad::evaluar`, `oportunidades`, `huecos`) usa
exactamente estas funciones para decir qué haría la regla con el estado
actual si se montara un sector en una parcela: ingreso del fondo, ventas a
las empresas que hoy importan ese sector, insumos cubiertos y sin cubrir,
competidores, capital de entrada y bloques hasta recuperarlo. No es consenso
(no toca el estado) y son cifras del ahora: cambian con cada bloque y con
cada empresa nueva. El panel lo dice en cada respuesta.

## 3. Cómo se activa (hecho)

La regla la fija **la fecha del bloque** frente a la fecha de activación de
los parámetros de la red, igual que la firma v2:

| Red | `Params.dubai_desde` | Regla para un bloque con timestamp `t` |
|---|---|---|
| testnet | `1 796 083 200` = **2026‑12‑01 00:00:00 UTC** | `t < desde` → fase 0; `t ≥ desde` → Dubái |
| regtest | ninguna (salvo `--dubai-desde <unix>`) | siempre fase 0 |

`FirmaCtx` (el contexto de reglas que ya llevaba la regla de firma y la red)
gana un bit `dubai`. Cada bloque del árbol guarda si en él rige Dubái
(`BlockNode.dubai`): sí, si su timestamp alcanza la fecha **o si ya regía en
su padre**. La regla **no retrocede dentro de una rama** (`BlockTree::dubai_sobre`);
`activacion_dubai.rs` lo prueba con un bloque de timestamp una hora anterior a
la fecha, hijo de un bloque Dubái, que sigue admitiendo una transacción de
mercado. El coste es el mismo que en la v2 y se dice entero: la cadena no acota
el timestamp de los bloques (`SECURITY.md`), así que un minero puede adelantar
la activación para su rama; no puede retrasarla.

Antes de la fecha, un bloque con una transacción de mercado, con un sector
mayor que 3, con una parcela fuera de 32×32, con un vehículo o un local, o con
una coinbase por encima de la cota antigua… es un bloque de la fase 0 y se
juzga con sus reglas (esa transacción lo hace inválido). Desde la fecha, una
coinbase que cobre la emisión entera es inválida («recompensa coinbase > cota»).
No hay periodo mixto.

## 4. Mempool, minero y carteras (hecho)

- **Admisión.** `verify_tx_con` recibe el contexto con el bit `dubai`: la
  cuadrícula, el sector máximo y el tipo de activo máximo dependen de él, y las
  cuatro transacciones de mercado se rechazan antes de la activación
  («transacción de Dubái antes de su activación»). `apply_tx` recibe el mismo
  bit para los precios por distrito, el fondo y el mercado.
- **Candidato.** `build_candidate` calcula la recompensa del minero como
  `emisión − parte_ciudad + comisiones` cuando rige Dubái; antes, como siempre.
- **Carteras.** `rami-wallet` tiene `build_sell_parcel`, `build_buy_parcel`,
  `build_sell_asset` y `build_buy_asset`; el panel (`rami-gui`) los expone en
  `/api/city/sell`, `/buy`, `/sell_asset`, `/buy_asset`. El mensaje firmado
  no cambia con el bit: la firma de una transacción es la misma con o sin
  Dubái; lo que cambia es qué transacciones valen.
- **Regtest.** Nada cambia salvo que pases `--dubai-desde <unix>` a
  `rami-node`, `rami-wallet` y `rami-gui` (los tres, con el mismo valor).

## 5. Lo que ve la red (hecho)

`Status.rule` pasa a anunciar **3** (`REGLA_SOPORTADA`): firma v2 más Dubái.
Un nodo v0.8.0 lo lee como «≥ 2» y no cambia nada. Un nodo v0.9.0 cuenta
aparte los pares que anuncian 3 (`ConsensoInfo.pares_dubai`) y a cada par que
anuncia 2 le añade el motivo «anuncia la regla 2 sin Dubái (binario anterior
a v0.9.0): quedará fuera al activarse Dubái». `PROTO_VERSION` no cambia.

Dos frames nuevos, `Presence` y `Chat`, llevan la presencia efímera del
metaverso (avatar y chat). No son consenso, no se guardan, un binario anterior
los ignora (frame desconocido, probado en `protocol.rs`) y solo se retransmiten
a pares que anuncian la regla 3. Cada uno va firmado con la identidad Ed25519
del nodo emisor (la del Túnel RAMI, con su prueba de trabajo) y acotado en
tamaño, ritmo por identidad, saltos y memoria (`rami-node/src/lib.rs`,
constantes `PRESENCE_*` y `CHAT_*`).

## 6. Qué pasa con quien no se actualice (hecho, probado)

Un binario v0.8.0 sigue abriendo todos sus ficheros. Desde la activación:

- Los bloques que solo llevan la coinbase (con la nueva cota, por debajo de
  la antigua) los admite. El primero con una parcela de 64×64, un sector
  nuevo o una transacción de mercado le parece inválido y desde ahí los demás
  son huérfanos: se queda en esa altura sin caerse. Probado en
  `activacion_dubai.rs` (árbol sin fecha frente a los mismos bloques).
- Puede seguir minando su rama; cuando actualice, la rama de la red gana por
  trabajo.
- **Un caso que la v2 no tenía:** si un binario v0.8.0 abre un `chain.jsonl`
  que la v0.9.0 escribió con transacciones de mercado, no sabe deserializar
  esas líneas (`enum Tx` sin esas variantes) y `load_blocks` falla en esa
  línea. Por red no ocurre nunca (no recibe esos bloques), solo al compartir
  el directorio y volver atrás de versión. La salida es volver a la v0.9.0.
  `tools/compat/roundtrip.sh` sigue en verde porque no ejercita Dubái; se
  dice aquí en vez de esconderlo.

## 7. Cómo se ha comprobado (hecho)

- `rami-core`: distritos sobre lugares reales y regla del mar; grafo de
  insumos cerrado y sin auto-referencias; reparto determinista que conserva
  el total, paga a proveedores y quema importaciones; mentor con la misma
  regla; transacciones de Dubái rechazadas sin la regla y admitidas con ella;
  cuadrícula 64 frente a 32; `dubai_fondo_reparto_y_mercado` de punta a punta
  (cota de la coinbase, fondo, parcela cara rechazada, reparto en el mismo
  bloque, venta y compra atómicas de parcela y de local, vehículo rechazado
  fuera de un concesionario, precio máximo respetado).
- `rami-node/tests/activacion_dubai.rs`: génesis regtest real, siete bloques
  llenando el fondo (40 RAMI al minero, 10 al fondo), coinbase avara
  rechazada, hotel en Downtown con el monedero real, árbol viejo que rechaza
  y no se rompe, gemelo con la misma cabeza y el mismo saldo, venta y compra,
  local acuñado y vendido, y la regla que no retrocede.
- `rami-net`: `Presence` y `Chat` van y vuelven; la forma de la v0.8.0 no los
  parsea (y el transporte ignora lo que no parsea).
- `tools/compat/roundtrip.sh` (CI) con los binarios reales de la v0.7.0 y la
  v0.7.3 sigue igual: la v0.9.0 no cambia el formato de ningún fichero
  existente ni el protocolo.

## 8. Lo que esperamos (juicio) y lo que no sabemos

- **Juicio:** las constantes económicas (20 % del subsidio, 1 % del fondo por
  bloque, 40 % a insumos, precios por distrito) son un primer ajuste. Con
  ellas, en régimen estable el fondo reparte lo que entra (10 RAMI por bloque
  mientras la emisión sea 50). **Confianza moderada** en que sean las
  adecuadas: no hay datos de uso todavía. Cambiarlas es otro cambio de
  consenso con su fecha.
- **La recompensa del minero baja un 20 %** desde la activación. Es un hecho
  y se dice: la emisión total no cambia, cambia a quién va.
- **No sabemos** cuántas empresas habrá ni si el grafo de insumos lleva a
  la ciudad a cubrirse sola. El mentor enseña los huecos; nada más.
- **No se afirma** ninguna ventaja económica. La testnet sigue sin valor.

## 9. Lista para operadores

1. Actualiza a v0.9.0 antes del **1 de diciembre de 2026, 00:00 UTC**.
2. En Red, comprueba cuántos pares anuncian la regla 3.
3. Si mantienes un nodo público de mercado (`rami-node market`), arráncalo
   con la v0.9.0: antes de la fecha publica pares sin operaciones.
4. Regtest: `--dubai-desde <unix>` en `rami-node`, `rami-wallet` y `rami-gui`.
