# PENDIENTE v0.10.14 (estado de la rama; borrar al publicar el release)

Empieza la entrega 4 del plan del metaverso (`docs/METAVERSO.md`, «TRAMA: la
manzana y la fachada»): las cajas del skyline pasan a ser edificios con planta,
coronación y portal, y las parcelas llevan el nombre de su dueño. Sin cambios de
consenso, de red ni de formato; la vista `/api/city` gana el campo `handle` en
cada parcela.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde (137).
- `tools/panel/check.py` (191 ids), `tools/panel/lexico.py`, `gen_i18n.py` sin
  cambios, `tools/security/inventory.sh --check`,
  `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla, cero errores:

  | Prueba | Resultado |
  |---|---|
  | Recuento | 3.106 edificios en 19 teselas: 720 torres, 837 bloques, 830 villas, 720 naves; 2.344 alineados con su calle; 332.944 triángulos de barrio |
  | Plantas | Las cinco variantes de cada tipo repartidas entre 130 y 182 edificios cada una |
  | Mismos encuadres, binario v0.10.13 → este | Torres de cerca 897.962 → 925.438; manzana de bloques 801.322 → 789.410; a pie en la manzana 928.100 → 952.312; ante una torre 805.296 → 806.004; ciudad entera 1.467.752 → 1.753.464 (71 → 86 llamadas); centro 1.398.354 → 1.533.338 |
  | Fotos | Plantas desde arriba (escalonada, en L, podio y torre); portal de torre (vidriera, puerta, marquesina); bloque en L con el portal en el rincón; villa con tapia; muelle de nave con dos portones; corona con antena y pasarela de gemelas |
  | Rótulo (ciudad sintética de tres parcelas) | «@rami_dxb» blanco a 176 m sobre la torre, «@karim» en el color de acento (parcela del jugador) a 61 m sobre el comercio, ninguno para la parcela sin perfil; las tres instancias de arquetipo colocadas |

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

## Queda por hacer

1. **Los edificios de las parcelas** (los del jugador) siguen siendo los
   arquetipos por sector, sin planta ni portal deducidos; el rótulo ya está.
2. **Calidad «baja»**: dibuja el 40 % de los edificios y el catastro tiene el
   100 %: se choca con edificios que no se ven. Viene de la v0.10.3.
3. **Un edificio puede pisar a otro**: la colocación dentro del barrio es
   aleatoria y solo rechaza la calle; dos edificios cercanos se montan. Rechazar
   también las huellas ya ocupadas.
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
