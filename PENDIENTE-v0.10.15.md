# PENDIENTE v0.10.15 (estado de la rama; borrar al publicar el release)

Sigue la entrega 4 del plan del metaverso (`docs/METAVERSO.md`, «TRAMA: la
manzana y la fachada»): los edificios de las parcelas —los del jugador— salen
del mismo catálogo que los de los barrios, ningún edificio de barrio se planta
sobre otro ni sobre un hito, y la calidad «baja» choca solo con lo que dibuja.
Sin cambios de consenso, de red, de nodo ni de formato: todo en `city3d.js`.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde (137).
- `tools/panel/check.py` (191 ids), `tools/panel/lexico.py`, `gen_i18n.py` sin
  cambios, `tools/security/inventory.sh --check`,
  `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla, cero errores:

  | Prueba | Resultado |
  |---|---|
  | Barrios | 3.052 edificios en 19 teselas (3.106 en la v0.10.14): 695 posiciones rechazadas por huella ocupada, cero solapes con el criterio de `huellaLibre`; 328.388 triángulos de barrio |
  | Calidad | «baja»: 1.221 dibujados y 1.221 sólidos de barrio en el catastro; «media»: 3.052 y 3.052; los 56 hitos siempre |
  | Ciudad sintética de 30 parcelas (una por sector, dos filas) | 2 teselas, 5.044 triángulos, 30 sólidos `parcela`; `solidoEn` bajo la torre devuelve «Empresa 0» (132,8 m, media huella 54,6 m) y bajo el hotel «Empresa 5»; rótulos «@rami_dxb» a 148 m y «@karim» a 121 m |
  | Mismos encuadres, binario v0.10.14 → este | Torres de cerca 925.438 → 920.678; manzana de bloques 789.410 → 790.042; naves 1.014.894 → 1.014.414; a pie en la manzana 952.312 → 952.544; ante una torre 806.004 → 802.440; villas 926.780 → 959.508 (una tesela más en el encuadre: 14 → 15 llamadas); ciudad entera 1.753.464 → 1.748.908 (las mismas 86 llamadas); centro 1.533.338 → 1.532.854 |
  | Fotos | La fila de los treinta sectores; la torre con ventanas, coronación y rótulo; el hotel con la piscina y la banda dorada; la nave con chimenea y grúa; escuela y clínica; a pie ante el portal de la torre (vidriera, puerta, marquesina) y mirando arriba por la fachada |

- Para fotografiar una ciudad sintética hay que bloquear el `setCity` del panel,
  que sondea `/api/city` y vuelve a poner la ciudad real (vacía) a los pocos
  segundos: `h.setCity = d => d.__prueba && orig(d)`.

## Cómo está hecho, para quien lo toque después

- **`planificarBarrios(meta)`** recorre los 34 barrios con la MISMA serie
  (`lcg(c.seed)`) y los mismos sorteos en el mismo orden que la v0.10.6 —ángulo,
  radio, altura, huella, giro libre, tono—, así que posiciones, alturas y huellas
  no cambian. Lo nuevo sale de un segundo generador por edificio,
  `lcg(semillaMorfologia(round(x), round(z), 11))`: la variante de planta (`v`)
  y el descentrado de la torre sobre el podio (`v2`).
- **`orientaEnTrama(x, z, yawLibre)`**: dentro de una trama, la distancia con
  signo a la línea de calle más cercana de cada familia (`ex`, `ez`) decide hacia
  dónde mira el +z local del edificio (el portal); el yaw es `atan2` del vector
  de mundo. Fuera de toda trama se conserva el giro libre. Los 762 no alineados
  son los de barrios sin trama alrededor (fuera del radio) o en su borde.
- **`edificioPartes(e)`** devuelve las piezas en el marco local: origen en el
  centro de la huella, un metro bajo el suelo (`y = hg − 1`, la caja va hundida
  para que ninguna pendiente deje hueco), x a lo largo de la calle, +z hacia
  ella; el suelo local está en `y = 1`. `peto`, `corona` y `portal` son ayudantes
  compartidos por las variantes.
- **Mallas por tesela**: `pushParts` con la matriz del edificio (`_m4b`, no `_m4`,
  que `pushPart` sobrescribe) y dos atributos por vértice: `abase` (la cota del
  pie, para que el sombreador cuente las ventanas desde la planta baja y no
  desde el nivel del mar) y `aflags` (1 = sin ventanas: villas y naves). Las
  mallas instanciadas y los hitos no llevan los atributos y leen 0: como antes.
- **La calidad** rehace las mallas (`buildClusters()` sin `meta`) con la fracción
  `Q.clusters`; el plano y el catastro se hacen una vez.
- **El rótulo**: `ParcelView.handle` en el nodo (búsqueda en `st.profiles` por
  dueño); en el cliente, `C.ownerLabels` (LabelSet con prueba de profundidad),
  un rótulo por parcela con `handle`, a `ARCH_TOP[arquetipo] · sy + 10` m sobre
  la celda, en el color de acento si `owner === me`.

- **El catálogo de cuerpos** (`piezas`, `cuerpoTorre`, `cuerpoBloque`,
  `cuerpoNave`, `cuerpoVilla`) está fuera del cierre del cliente, a nivel de
  módulo, y lo comparten `edificioPartes(e)` (barrios; suelo local en `y = 1`)
  y `parcelaPartes(key, c, e)` (parcelas; suelo local en `y = suelo`, con
  `suelo = clamp(0,02·celda, 3, 20)` para que la caja baje bajo la cota de la
  celda en las laderas). `parcelaPartes` devuelve `{ p, top, hw, hd, suelo }`:
  el rótulo cuelga a `top + 10` y el catastro recibe `hw`, `hd`.
- **La parcela mira a +y de la cuadrícula**: el edificio se gira `rotR`
  (`−rotationDeg`), que es el mismo giro que la cuadrícula; su +z local cae en
  la dirección `rotOff(0, +)`, por donde arranca el paseo a pie.
- **Los fantasmas del multiverso** (`ghost_*`) usan `parcelaPartes` con una
  morfología neutra (`v = 0,1`, `v2 = 0,5`, `sy = 1`) y siguen instanciados.
  Las mallas instanciadas `arch_*` han desaparecido.
- **`huellaLibre(cat, x, z, r)`** mira las celdas vecinas del catastro (256 m)
  y rechaza si dos círculos envolventes se montan más de un quinto de la suma
  de radios. `planificarBarrios` da de alta cada edificio aceptado al momento;
  `buildClusters` quita después los de barrio (`catastroQuita`) y vuelve a dar
  de alta solo los dibujados. `applyCity` hace lo mismo con los de tipo
  `parcela` en cada ciudad nueva.

## Queda por hacer

1. **El plano de los barrios no conoce las parcelas compradas**: se hace al
   cargar el mapa, antes de la ciudad, así que un edificio de barrio puede caer
   dentro de una parcela con edificio. Rechazar también las celdas con parcela
   cuando llegue la ciudad, o replanificar el barrio afectado.
2. **Las proporciones del edificio de la parcela** son las heredadas de los
   arquetipos: la torre es tan ancha como alta (109 × 133 m con la celda de
   650 m). Dar a la torre una huella menor y más altura sin mover el resto.
3. **Los fantasmas del multiverso** siguen con la morfología neutra de su
   sector, no con la deducida de la celda.
4. **Los avatares ajenos no se apartan.** Van donde dice su cliente; solo se
   empuja al jugador local.
5. **Los coches cruzan el agua.** Donde el terreno baja de 0,6 m la cinta se
   corta (Ras Al Khor, la costa) y la ruta de tráfico sigue.
6. **La mitad real de las calles** espera un extracto de OpenStreetMap que
   aporte quien la quiera (`tools/geo/osm_roads.py`).
7. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. Con
   el botón de fluidez ya se puede medir antes y después en una tarjeta de
   verdad.
8. **Relieve por texel en bordillo y acera**, **la pasada de sombra en una
   tarjeta de verdad** y **cifras de fluidez de una tarjeta real**: el botón
   existe; falta que alguien lo pulse en una máquina con tarjeta.

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
  la v0.10.13 el panel la mide; falta la máquina.
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
