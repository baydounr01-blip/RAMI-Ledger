# PENDIENTE v0.10.13 (estado de la rama; borrar al publicar el release)

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`): los tres
pendientes de la v0.10.12 —pasos de peatones, coches que esquivan y lo que «no
se podía pagar desde aquí»: la cifra de fluidez y la mitad real de las calles—.
Sin cambios de consenso, de red ni de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py` (191 ids), `tools/panel/lexico.py`, `gen_i18n.py` sin
  faltantes, `tools/security/inventory.sh --check`,
  `tools/compat/roundtrip.sh v0.7.0`, `tools/geo/osm_roads.py --selftest`.
- Panel real en Chromium sin pantalla, cero errores:

  | Prueba | Resultado |
  |---|---|
  | Marcas de las bocas | 7.908 pasos, 7.776 líneas de detención, 23 cedas; 1.014.134 triángulos de vía en 43 teselas |
  | El paso del cruce de trama | 3 cm sobre la caja de la preferente (antes, de 8 a 17 cm por debajo, invisible); visible cenital, oblicuo y a pie |
  | Vía de 15 m, jugador en el centro del carril a 80 m (pasos de 1/60 s) | Pasa por la izquierda a 2,40 m sin bajar de 21,9 m/s; vuelve al carril en 4,7 s |
  | Jugador 2 m a la izquierda del carril | Pasa por la derecha a 2,40 m |
  | Arteria, jugador en el centro | Pasa a 2,40 m sin bajar de 22,1 m/s |
  | De sopetón a 12 m | Frena a 14,5 m/s y pasa rozando (empuja al jugador 25 cm) |
  | Cola de dos coches | 12,3 m de hueco, desvío cero |
  | `bench({segundos: 2})` | Cuatro vistas, cámara restaurada; SwiftShader de 0,2 a 1,7 fps |
  | Botón «⏱ Fluidez» del panel, sin haber abierto el 3D | Abre el 3D, mide, escribe la línea y se vuelve a habilitar |
  | Extracto OSM sintético de dos vías (`--merge`, luego retirado) | Cinta en las dos, rutas de tráfico con calzada 26 y 15, cruce con paso y línea de detención, atribución de OSM en `attribution` |

- Fotos: el paso en el cruce de trama (cenital y oblicuo), un coche desviándose
  a pie y desde arriba.

## Cómo está hecho, para quien lo toque después

- **Las marcas se interpolan entre filas** (`puntoCinta`): entre dos filas la
  cinta es lineal, así que un punto interpolado entre los vértices 3 y 4 del
  perfil (los bordes del asfalto, con el ensanche de la esquina ya aplicado)
  está sobre la cinta. Una marca que cruza una fila se parte por tramos. Darle
  fila propia a cada marca subía la malla un tercio.
- **La cota del cruce** (`cotaCruce`): el máximo de las secciones de nueve
  puntos de las dos vías en el cruce y a un alcance a cada lado. En la
  preferente el alcance es la caja más el radio; en la que cede, la acera de la
  preferente más el radio, que es hasta donde llega la caja ensanchada. Dentro
  del alcance la fila va a esa cota; de ahí a los sesenta metros la propia
  vuelve con `smoothstep`. La que cede lleva 1,5 cm de resalte (`alza`): dos
  planos exactamente iguales parpadean y las rayas de uno se ven a través del
  otro.
- **El desvío** (`c.desvio`, `c.lado`): `lp = la + desvio` es dónde está el
  jugador respecto al centro del carril; pasar por su izquierda es ir a
  `lp − 2,4` y por su derecha a `lp + 2,4`, si cabe en `[desvMin, desvMax]` de
  la vía. Frena solo si `|la| < 2,4` y `al < 7 + v·tLibre`, con `tLibre` lo que
  tarda en llegar al desvío elegido a 2,5 m/s. El giro del morro sale de la
  velocidad lateral del cuadro: `yaw −= atan2(lateral, v)`.
- **La medida** (`bench`, `benchFrame`) corre dentro de `frame()`: fase 0
  calienta un segundo, fase 1 cuenta cuadros y el peor intervalo, fase 2 pasa a
  la vista siguiente. `renderer.info.render` se lee tras `renderer.render`, así
  que los triángulos y llamadas son los del último cuadro de cada vista.
- **`meta.vias`**: `ejesDelMapa(meta)` junta `roads` (ancho por longitud) y
  `vias` (ancho por clase, `VIA_CLASE`) en un formato; `buildRoads` y
  `buildTrafficPaths` leen esa lista. Rango `1000 + calzada`, como las del
  mapa.

## Queda por hacer

1. **Los avatares ajenos no se apartan.** Van donde dice su cliente; solo se
   empuja al jugador local.
2. **Los coches cruzan el agua.** Donde el terreno baja de 0,6 m la cinta se
   corta (Ras Al Khor, la costa) y la ruta de tráfico sigue: hay coches que van
   por encima del agua sin puente. Encontrado en la vía 3 del dataset, 350 m
   sin cinta. Puentes o cortar las rutas donde se corta la cinta.
3. **La mitad real de las calles** espera un extracto de OpenStreetMap que
   aporte quien la quiera (`tools/geo/osm_roads.py`); el repositorio no
   distribuye datos de OSM.
4. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. Con
   el botón de fluidez ya se puede medir antes y después en una tarjeta de
   verdad.
5. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto).
6. **La pasada de sombra, en una tarjeta de verdad.** Aquí no dibuja nada.
7. **Cifras de fluidez de una tarjeta real.** El botón existe; falta que alguien
   lo pulse en una máquina con tarjeta y deje la línea en las notas.

## El arco de la esquina, para quien lo toque después

Dos cosas que costaron una vuelta cada una y conviene no volver a descubrir:

1. **El arco se mide desde el eje de la otra calle, no desde donde termina la
   cinta.** La cinta de la que cede se corta en el borde exterior de la
   preferente, que ya está bien dentro del arco. Partir de ahí abría las bocas
   ocho metros en vez de uno y medio.
2. **Las dos calles tienen que usar la misma fórmula.** Con dos ensanches
   distintos —uno medido desde el corte y otro desde la caja— los dos bordes se
   cruzan y dejan un pico en cada rincón. Con la misma, se encuentran sobre el
   arco.

Y una tercera de reparto: el cuarto de circunferencia se corta **por ángulo**.
Por longitud, con las mismas filas, la flecha pasa del metro.

## Un test que se caía bajo carga, y que tumbó un release

`rami-net::tests::oversized_frame_disconnects_peer` fallaba de vez en cuando —2
de 4 ejecuciones de `cargo test --workspace --release --locked` en un contenedor
de 2 vCPU— y siempre pasaba aislado. El 14 de septiembre de 2026 **tumbó el
release de la v0.10.7**: `lib.rs:746`, `left: 1, right: 0`.

La causa no es del producto: `peer_count()` es una instantánea que se refresca en
`refresh(&peers)`, y ese refresco corre DESPUÉS de mandar `Connected` o
`Disconnected` por el canal. El test leía el contador una sola vez, en el
instante en que recibía el evento, y con la máquina cargada caía dentro de esa
ventana. La tabla de pares siempre fue correcta; lo que no es instantáneo es el
número.

Arreglado en la v0.10.8 con un ayudante de test, `espera_pares`, que espera a que
el contador llegue al valor esperado (hasta dos segundos) en vez de leerlo una
vez. Se aplica a los seis asserts que van justo detrás de un evento. Los que
comprueban que **nada** se registró se quedan como estaban: ahí no hay evento al
que seguirle los pasos. Ningún cambio fuera de los tests.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.** Desde
  esta versión el panel la mide; falta la máquina.
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
