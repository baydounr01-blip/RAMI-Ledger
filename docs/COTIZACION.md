# Cotización: lo que RAMI-Chain registra y lo que no hace

Este documento dice, con hechos, qué es la «cotización» de RAMI desde la
v0.9.0, de dónde salen sus datos, cómo se publican y qué haría falta —fuera de
este software— para que existiera una cotización con valor real. Lee antes
`NOTICE.md`: la moneda **no tiene valor monetario, no se vende y este
repositorio no ayuda a venderla**. Nada de lo que sigue lo cambia.

## 1. Qué hay (hecho)

Desde la activación de Dubái (`docs/DUBAI.md`) la cadena registra hechos en
RAMI de prueba que antes no existían:

- **Precio del protocolo:** lo que cuesta una parcela libre en cada uno de
  los 35 distritos (5 RAMI en el desierto, 300 en Palm Jumeirah; se quema) y
  lo que cuesta acuñar cada tipo de activo (1, 5 o 20 RAMI; se quema).
- **Órdenes abiertas:** parcelas y activos publicados en venta por sus
  dueños, con su precio (`Parcel.sale`, `Asset.sale`).
- **Operaciones cerradas:** las últimas 256 compras (parcela o activo,
  distrito, sector o tipo, precio, altura del bloque) en `State.trades`.
  Cada una es un pago real entre dos cuentas de la cadena.
- **Fondo de la ciudad, reparto por bloque y RAMI quemados** (parcelas,
  acuñados e importaciones).

Con eso el nodo construye un **mercado interno**: pares `PARCELA-<DISTRITO>_RAMI`
(35) y `ACTIVO-<TIPO>_RAMI` (4), cada uno con precio del protocolo, mejor
oferta, último cierre y volumen de los últimos 1440 bloques (≈ 24 h), y un
**índice** con empresas, activos, órdenes, operaciones, precio medio y último
precio de parcela, fondo, reparto, quemado y cuántos m² de parcela libre
compra 1 RAMI (del distrito más barato al más caro; una celda mide
650 × 650 m = 422 500 m²).

Es la cotización del RAMI **frente a los activos de la ciudad**, en RAMI. No
hay ningún par contra euros ni contra otra criptomoneda, ni en el panel, ni
en el nodo, ni en la web.

## 2. Dónde se ve (hecho)

- **Panel del monedero → Mercado:** fichas del índice, tabla de pares, órdenes
  abiertas (con botón «Comprar» en las de otros) y operaciones cerradas
  (`GET /api/market`).
- **`rami-node market`:** un nodo completo (sincroniza por P2P, sin monedero)
  que publica los mismos datos en HTTP de solo lectura, con CORS abierto,
  en el formato que leen los agregadores de mercados:

  | Ruta | Devuelve |
  |---|---|
  | `/api/v1/pairs` | `[{ticker_id, base, target}]` |
  | `/api/v1/tickers` | `[{ticker_id, base_currency, target_currency, last_price, base_volume, target_volume, bid, ask, high, low, protocol_price, last_height}]` |
  | `/api/v1/orderbook?ticker_id=…` | `{ticker_id, timestamp, height, bids: [], asks: [[precio, "1"], …]}` |
  | `/api/v1/historical_trades?ticker_id=…` | `[{trade_id, price, base_volume, target_volume, trade_timestamp, type, height, x, y, sector, distrito}]` |
  | `/api/v1/summary` | todo el mercado (`MarketView`) |
  | `/api/v1/index` | el índice |

  Precios como texto decimal con 8 decimales (`fmt_ram`). `bid` es siempre
  `null`: la cadena no tiene órdenes de compra, solo de venta (el comprador
  fija su máximo en la transacción). `trade_timestamp` sale del timestamp del
  bloque de cada operación.

  ```bash
  rami-node market --chain ~/.rami/chain-testnet --network testnet --port 8646 --bind 0.0.0.0
  curl -s http://127.0.0.1:8646/api/v1/index
  ```

  Es un servicio público: ponlo detrás de un proxy con TLS si lo expones y
  ten presente que es de solo lectura (no tiene claves, no acepta órdenes).

- **Web (`quantbot.army`) → Cotización:** la página lee `web/market.json`
  (lista de nodos de mercado públicos; vacía hasta que alguien publique uno)
  y muestra el índice del primero que responda. Sin nodo, dice «sin datos».

## 3. Lo que este repositorio no hace (hecho)

- No fija ni publica un precio del RAMI en euros ni en ninguna criptomoneda.
- No tiene libro de órdenes RAMI/fiat ni RAMI/cripto, ni puente a otra
  cadena, ni token envuelto.
- No emite RAMI para el mercado: todo RAMI que cambia de manos en el mercado
  fue minado, apostado o repartido por la regla de la ciudad.
- No hace publicidad de rentabilidad: el mentor y el mercado muestran
  cifras del estado actual y dicen que cambian con cada bloque.

## 4. Qué haría falta para una cotización externa (juicio, fuera del software)

Si el proyecto quisiera algún día que RAMI cotizara frente a una moneda con
valor, lo que falta no es código de este repositorio:

1. **Decisión y asesoría legal.** `NOTICE.md` dice que no se vende y que no
   existirá ningún mecanismo para comprarlo; cambiar eso es una decisión del
   proyecto con abogados. En la Unión Europea la oferta y la negociación de
   criptoactivos están reguladas (MiCA) y exigen, entre otras cosas, un
   documento informativo y proveedores autorizados. Este documento no es
   asesoría legal.
2. **Una contraparte que cree el mercado.** Un mercado centralizado que
   admita RAMI (integra el nodo y el monedero: `rami-node run`, `rami-wallet`,
   explorador) o un mercado descentralizado en otra cadena (exige un puente
   o custodia que este software no tiene).
3. **Datos públicos verificables.** Los agregadores piden una API de pares y
   operaciones (la de `rami-node market` tiene ese formato), un explorador
   público, documentación y actividad. Lo primero existe; lo segundo es un
   nodo que alguien tiene que operar.

Hasta entonces, la única cotización que existe es la interna de la §1, y es
lo único que la web, el panel y la API muestran.
