# PENDIENTE v0.10.16 (estado de la rama; borrar al publicar el release)

Cierra la entrega 4 del plan del metaverso (`docs/METAVERSO.md`, «TRAMA: la
manzana y la fachada»): el catálogo de fachadas en el sombreador, el plano de
los barrios que oculta lo que queda debajo del edificio de una parcela, la torre
de parcela esbelta y los fantasmas del multiverso con la planta de su celda. Sin
cambios de consenso, de red, de nodo ni de formato: todo en `city3d.js`.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde (137).
- `tools/panel/check.py` (191 ids), `tools/panel/lexico.py`, `gen_i18n.py` sin
  cambios, `tools/security/inventory.sh --check`,
  `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla, cero errores:

  | Prueba | Resultado |
  |---|---|
  | Fachadas de barrio | Torres: 285 muro cortina, 271 retícula, 131 cinta; bloques: 532 retícula, 283 cinta; 830 villas y 720 naves lisas; 2.825 edificios saben su celda (227 caen fuera de la cuadrícula) |
  | Tres parcelas sobre las celdas con más edificios de barrio (33, 27, 25) | 6 ocultos (los que chocan), 0 montados; catastro «media» 3.046 = dibujados, «baja» 1.220 = dibujados; sin las parcelas, 3.052 de vuelta y 0 ocultos |
  | Fantasmas (tres, uno `solo_aqui`) | 1 malla, 228 triángulos, color del estado en los vértices, rótulos «⟂ Otra rama · #4412» a 243 m y «⟂ Hotel ajeno» a 122 m |
  | Torre de parcela | 221,3 m de alto, media huella 34,6 m (esbeltez 3,1) |
  | Mismos encuadres, binario v0.10.15 → este | Los ocho encuadres idénticos en triángulos y llamadas (920.678, 790.042, 959.508, 1.014.414, 952.544, 802.440, 1.748.908 con 86 llamadas, 1.532.854): sin parcelas en la ciudad real, nada cambia |
  | Fotos | La torre entre las villas que la rodean, sin ninguna dentro; el fantasma rosa con su rótulo; la torre esbelta junto al hotel; a pie ante un muro cortina (gemelas sobre podio), una retícula y una ventana corrida |

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
- **Los fantasmas del multiverso** (`setGhosts`) usan `parcelaPartes` con la
  morfología de la celda (canales 13 y 14) y van en una malla por tesela con
  `ghostMat` (`vertexColors: true`; el color del estado se escribe en los
  vértices después de `pushParts`, sin linealizar, para conservar el tono de
  antes). No queda ninguna malla instanciada de arquetipo.
- **El catálogo de fachadas** (`FACHADA_*`, `fachadaBarrio`, `fachadaParcela`)
  viaja en `aflags`: 0 retícula, 1 lisa, 2 muro cortina, 3 cinta. El sombreador
  saca tres máscaras (`lisa`, `cortina`, `cinta`) con `step` y mezcla los tres
  patrones de hueco; la celda del sorteo de luces encendidas es siempre la de
  4,5 × 3,6 m para que el muro cortina no parpadee paño a paño.
- **Los ocultos**: cada edificio de barrio lleva `celda` (índice de la
  cuadrícula o −1) desde el plano; `applyCity` mira el sólido de parcela de esa
  celda y marca `oculto` con el criterio de `huellaLibre`; si algún estado
  cambió, `buildClusters()` rehace las mallas saltándose los ocultos y el
  catastro se queda con los dibujados. `S.ocultos` está en `stats()`.
- **`huellaLibre(cat, x, z, r)`** mira las celdas vecinas del catastro (256 m)
  y rechaza si dos círculos envolventes se montan más de un quinto de la suma
  de radios. `planificarBarrios` da de alta cada edificio aceptado al momento;
  `buildClusters` quita después los de barrio (`catastroQuita`) y vuelve a dar
  de alta solo los dibujados. `applyCity` hace lo mismo con los de tipo
  `parcela` en cada ciudad nueva.

## Queda por hacer

1. **El portal no se abre**: es la entrega 5 («el umbral y el apartamento»),
   la siguiente del plan.
2. **Los avatares ajenos no se apartan.** Van donde dice su cliente; solo se
   empuja al jugador local.
3. **Los coches cruzan el agua.** Donde el terreno baja de 0,6 m la cinta se
   corta (Ras Al Khor, la costa) y la ruta de tráfico sigue.
4. **La mitad real de las calles** espera un extracto de OpenStreetMap que
   aporte quien la quiera (`tools/geo/osm_roads.py`).
5. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. Con
   el botón de fluidez ya se puede medir antes y después en una tarjeta de
   verdad.
6. **Relieve por texel en bordillo y acera**, **la pasada de sombra en una
   tarjeta de verdad** y **cifras de fluidez de una tarjeta real**: el botón
   existe; falta que alguien lo pulse en una máquina con tarjeta.
7. **Los 227 edificios de barrio fuera de la cuadrícula** (celda −1) no pueden
   quedar bajo ninguna parcela, así que no hay nada que ocultar; se anota para
   que nadie lo tome por un fallo.

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
