# PENDIENTE v0.11.0 (estado de la rama; borrar al publicar el release)

Cierra las entregas 5, 6, 7 y 8 del plan del metaverso (`docs/METAVERSO.md`) y
sus secciones 6 a 8. Un cambio de consenso con fecha propia, la escritura de
vivienda (`docs/VIVIENDA.md`, rige el 1 de marzo de 2027 a las 00:00 UTC); todo
lo demás es cliente 3D: cinco módulos del visor en
`chain/crates/rami-gui/src/city/` sobre los ganchos de `RamiCity3D.extend`
(`docs/EXTENSIONES-3D.md`) y lo que tenía que ir en `city3d.js`. El detalle de
cada frente —qué hace, cómo, cifras, capturas y sus tres rondas de revisión—
está en `notas/<frente>.md`: `escritura`, `umbral`, `vida`, `espejismo`,
`extras` y `memoria`.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde (155; 137 en la
  v0.10.16).
- `tools/compat/roundtrip.sh` en verde con la v0.7.0 y la v0.7.3 (`3c2c4bf`),
  pasos 1–5 (el 5 es el de la vivienda).
- `tools/panel/check.py` (192 ids), `tools/panel/lexico.py`,
  `tools/security/inventory.sh --check` y `node --check` de `city3d.js` y de
  los cinco módulos, en verde sobre el árbol con los arreglos de la última
  ronda.
- Panel real en Chromium sin pantalla (SwiftShader, calidad media, 1280 × 800):

  | Prueba | Resultado |
  |---|---|
  | Los seis frentes juntos, binario final con los recursos embebidos (iguales byte a byte al árbol) | 0 errores de consola |
  | Ocho encuadres fijos, binario final (triángulos/llamadas) | torres_cerca 945.460/30, bloques_manzana 797.650/27, villas 965.982/24, naves 1.054.528/30, a_pie_manzana 979.856/43, a_pie_torre 825.378/24, ciudad_entera 1.795.544/102, centro 1.536.006/52 (v0.10.16: 920.678/21, 790.042/17, 959.508/15, 1.014.414/21, 952.544/28, 802.440/17, 1.748.908/86, 1.532.854/42) |
  | Escritura, extremo a extremo en regtest | Dos carteras por el Túnel RAMI: parcela dividida en 6, tres viviendas compradas (3; 2,5; 1,5 RAMI, la última desde el panel), una transferida, un objeto acuñado en parcela ajena; misma altura y mismo registro |
  | Umbral | 40 de 40 patios con aviso y salida a la calle; 12 de 12 sectores; 256 recorridos a la carrera sin salir del piso; fuera de los edificios, 0 objetos del módulo en la escena |
  | Vida | 10 simulaciones de 10 min, y otra en ultra tras la última ronda: 0 solapes, 0 contactos con peatones, ningún coche más de 60 s parado; con el jugador sobre una ruta de la troncal, 0 solapes al esquivar (antes 67 muestras); 1.200 posiciones de peatones iguales al bit en dos Chromium; 128.791 muestras: 0 en el agua, en un edificio o en la calzada fuera de un paso |
  | Espejismo | Pase neutro idéntico byte a byte en 12 encuadres; con la profundidad lineal, a 7,5 m de Princess Tower, plano cercano de 4 m y la torre entera |
  | Extras | 0 solapes coche-pilar en 400 s; barcos: 0 muestras en tierra, mínima entre rutas 34,5 m; plano de barrios: los 2.952 edificios comunes, idénticos |
  | Memoria | Autopruebas del léxico; con la ciudad sintética y el binario final, un clic en cada una de las 7 filas de la lista deja su etiqueta a la vista, a entre 0,3 y 1,2 celdas (7 de 7) |

- Para fotografiar una ciudad sintética hay que bloquear el `setCity` del panel,
  que sondea `/api/city` y vuelve a poner la ciudad real a los pocos segundos:
  `h.setCity = d => d.__prueba && orig(d)`. Los guiones de prueba de cada frente
  están fuera del repositorio; las notas de cada frente dicen cuál mide qué.

## Cómo está hecho, para quien lo toque después

- **Módulos del visor.** Cada uno se registra con `RamiCity3D.extend(nombre,
  fabrica)` antes del montaje y el panel los carga en este orden: `umbral`,
  `vida`, `espejismo`, `extras`, `memoria`. El orden importa: los ganchos que
  consumen (`andar`, `tecla`, `clic`, `pintar`) paran en el primero que
  devuelve verdadero, y `vida` construye su grafo en `listo` antes de que
  `extras` dé de alta los pilares. Un gancho que falla se salta y se anota en
  la consola y en `handle._debug.extFallos()`. Entre módulos, `ctx.servicios`
  (`sonido` lo pone `extras`, `patina` lo pone `memoria`).
- **Escritura** (`rami-core`): toda comprobación pregunta a
  `FirmaCtx::vivienda_rige()` = `dubai && vivienda`; `apply_tx_sin_rastro`
  repone firmante y quemado si una tx falla (lo usan el nodo y el monedero);
  `tipos_de_otra_version` decide en `load_blocks` qué es un bloque de una
  versión posterior; `HUELLAS_V0_10_16` fija las codificaciones anteriores. En
  `rami-node`, `build_candidate` respeta `MAX_BLOCK_TXS` y `MAX_BLOCK_BYTES`, y
  el mempool, `MEMPOOL_TX_MAX_BYTES` (64 KiB).
- **Umbral**: `puertaDe` encuentra la puerta por `ctx.geom.colores.PUERTA` en
  las piezas del catálogo; `planifica` saca plantas libres, pisos y ático;
  `sitioUnidad`/`numeroUnidad` llevan de vivienda a planta y hueco. El interior
  va en dos pasadas (`mats().fondo` solo profundidad, luego color) como
  transparente sin mezcla; `camaraDentro` pone el cercano a 5 cm y el lejano a
  90 m sin hueco a la vista. Andar dentro va en subpasos de 0,1 m. Genotipo:
  canales 41–43 de `semillaMorfologia`.
- **Vida, núcleo** (`city3d.js`): `buildRoads` (tramos `vivos`, cota por fila),
  `resuelveCruces`, `buildTrafficPaths` (rutas, `conf`, `tapadosDe`,
  `centrosVuelta`), `updateTraffic` (simulación por cercanía a más de 400 m,
  recolocación fuera de la vista, tope de 0,35 rad del morro), `limitesDesvio`
  (al esquivar al jugador, el coche no sale de su carril si al lado hay otro
  de su sentido), `geoCruce`/`bandaCruce` para la cesión y `sueloCalle` en
  `ctx.mundo`. **Módulo** (`city/vida.js`): grafo de aceras (`cruceGrafo`),
  Dijkstra en centímetros enteros, `recluta` (plantillas), `agenda`, `V.dur` y
  `suelta` para la caché de caminos, construcción por trozos en nueve fases.
- **Espejismo**: `interiorSala` en `BUILD_FS`, con el id del edificio en
  `aflags` (`flagsEdificio`); el destino del posproceso con
  `isXRRenderTarget`, `sRGBEncoding` y `RGBA8`, y la niebla y el fondo pasados
  a sRGB mientras se dibuja; `montaCascadas` solo al montar y al cambiar de
  calidad (el número de luces con sombra recompila todos los materiales);
  `sombraEnCascadas` para los materiales de three; `planosProfundidad` y
  `holguraCamara` para el lineal.
- **Extras**: orden en `cuadro` (tormenta → foto → pirámide → metro → mediana
  de los coches → barcos → sonido); `recorteTerreno` toca el `drawRange` de la
  malla del terreno solo mientras dura la tormenta; `planificarBarrios` rechaza
  las huellas sobre una vía del mapa después de sacar `yawLibre` y `tono`, con
  el rechazado como fantasma, para no desplazar la serie. Si se toca una ruta
  del Creek, volver a elegir las fases con `handle.ext.extras.fasesAbras()` y
  comprobar `rutas().cruces === 0`.
- **Memoria**: `servicios.patina` es la única línea del núcleo (`applyCity`);
  `nivelPatina` es entera; las placas van en una malla con un atlas de 16
  huecos; las etiquetas se registran con `ctx.etiquetas` y la enfocada prueba
  `ALTURAS` = 0,9; 1,2; 0,55 y 0,3 celdas (tope 800 m); `firmaCiudad` evita
  rehacer todo en cada sondeo. En `lexico.py`, `INVERSION`, `NIEGA`,
  `MONEDA` y `literales_codigo`.

## Queda por hacer

### 1. Medir lo que aquí no se puede

1. **La fluidez en una tarjeta gráfica real**, con el botón del panel: alta con
   y sin cascadas (la pasada de sombra lleva 3,4–3,8 veces los triángulos) y
   los dos modos de profundidad. El lineal no pasa a ser el de por defecto
   hasta entonces.
2. **Oír el sonido** y ajustar los niveles, que están elegidos a mano.
3. **VR con gafas**: en ellas no se entra en los edificios (el visor saca al
   jugador delante del portal); los planos del lineal en VR (0,3 m y 40 km),
   las cascadas alrededor del jugador y el recorte del terreno en la tormenta
   solo se han revisado leyendo el código.
4. **Las viviendas del nodo en el visor**: la cadena del arnés no tiene
   parcelas, así que `unidades` y `units` no se han visto llegar al visor; el
   reparto de pisos se ha probado con ciudades sintéticas. Hace falta una
   regtest con `--dubai-desde` y `--vivienda-desde` y una parcela dividida.
5. **La vista por la puerta sin profundidad por fragmento** (WebGL 1 sin
   `EXT_frag_depth`) y **el determinismo en otro motor** que Chromium: la
   prueba de márgenes cubre los peatones, pero la geometría de la ciudad del
   núcleo también sale de `Math.sin` y `Math.cos` y no está medida fuera.

### 2. Red y consenso

1. **Una transacción que deja de valer sin gastar su nonce no caduca**: ocupa
   sitio en el mempool hasta que se mina otra con su nonce. Hace falta
   caducidad o una forma de cancelarla. Anterior a esta versión.
2. `/api/city` con la ciudad entera dividida en 64 pesa unos 29 MB (peor caso).
3. Límites de diseño de la escritura, dichos en `docs/VIVIENDA.md` §10: el tope
   es por cuenta, no por persona; el comprador de una parcela dividida está
   protegido en el precio, no en el número de viviendas. Cambiarlos es otro
   cambio de consenso con su fecha.
4. Una v0.7.0–v0.10.16 no abre un directorio con bloques de vivienda (falla
   limpio); no se puede arreglar hacia atrás.

### 3. La calle

1. **Las rutas no se enlazan**: al final de cada una el coche da la vuelta, en
   el borde de cada barrio se ve dar la vuelta a filas enteras, y en 5 de las 7
   glorietas antes de la entrada. Hace falta un grafo de rutas con giros.
2. **Tramos tapados**: 11.485 m de calle montados sobre otra vía casi paralela
   no llevan tráfico, pero se siguen dibujando; cortarlos es trabajo de
   `tramaBarrio`/`buildRoads` y cambia el dibujo de 78 vías. En los cruces
   oblicuos, la cinta de la que cede deja un triángulo de arena.
3. **No hay semáforos**: en una calle que cede a la troncal la cola avanza por
   la válvula de 30 s (hasta 456 válvulas en 10 min en ultra). Recolocar y
   desatascar siguen siendo saltos, ahora fuera de la vista.
4. **Los coches no son deterministas** (los peatones sí): cada máquina ve su
   tráfico.
5. **Peatones**: en hora punta, 1.100–1.400 en la calle de 29.527; no hay
   aceras entre barrios ni a lo largo de las vías del mapa; la zona 24 no tiene
   ningún portal con acera; 522 portales no encuentran un camino recto a la
   acera; el 0,6 % de los viajes se queda sin camino; la parada no se dibuja;
   la primera construcción, al cargar, es de una vez (1,4–2,5 s).
6. **El primer grafo de aceras no ve los pilares del metro** (`vida` lo
   construye antes de que `extras` los dé de alta); los que rehace después, sí.
   No medido si cambia algo.
7. **La mediana de la E11 va en `extras`** (`medianaCoches`); si el núcleo
   gana una mediana por vía, sobra. Un pilar se quita donde cruza otra calle
   con coches: si el núcleo abre tráfico en un tramo hoy tapado, ese pilar no
   se quita hasta recargar. Una parcela bajo el viaducto se cuenta, pero ni el
   viaducto ni sus pilares se rehacen.
8. En la franja de 0,6 m del patio fuera de la huella, `umbral` no empuja
   coches ni avatares (`empujarDeMoviles` no está en el contexto).

### 4. Datos del mapa

1. **The Gate está sobre la E11**: la huella del hito entra en la calzada (510
   de 5.529 muestras de coches de la E11 cayeron dentro) y el viaducto pasa por
   ella. Hay que mover el hito o el trazado en el dataset.
2. **El Creek no llega al mar en el agua visible** (la malla fina de 138 m
   cierra la boca norte, igual que el codo de la Marina): los dhows no salen y
   los yates solo recorren el tramo sur.
3. **La mitad real de las calles** espera un extracto de OpenStreetMap
   (`tools/geo/osm_roads.py`).

### 5. Interiores

1. **Desde dentro, la puerta de la calle no deja ver la calle**: se ve la cara
   interior de la caja de la puerta (negra). Hace falta que el material de los
   edificios del núcleo descarte ese hueco (un uniforme con la caja de la
   puerta en la que se está).
2. **Arrastrar muebles con el ratón**: a pie el arrastre gira la vista y el
   gancho `clic` solo recibe clics sin arrastre.
3. Por la ventana se sigue enviando la ciudad entera (986.956–992.124
   triángulos).
4. 145 torres y bloques no tienen ninguna planta con la fachada libre: se entra
   a una casa en planta baja, sin ascensor. Una vivienda que no cabe en su
   edificio lleva al piso de muestra.

### 6. Imagen y tormenta

1. **El resplandor de día** solo deja pasar los reflejos del sol: la arena y
   los brillos del vidrio a contraluz están en el mismo intervalo (0,80–0,85) y
   con un umbral por luminancia no se separan.
2. **El multimuestreo doble** con posproceso (66 MB sin uso a 1.920 × 1.080,
   calculado) se queda hasta que la capa de las gafas se cree fuera de three.
3. Con la profundidad lineal, lo que un módulo dibuje en alto fuera de toda
   huella del catastro (un avión, un dron) se recorta si queda más cerca que el
   plano cercano (hasta 500 m).
4. En la tormenta, las etiquetas no llevan niebla, el pase de sombras no se
   reduce (cambiar `castShadow` recompila todo), los reflejos usan un color
   fijo, y la tormenta a mano sube en 3 s de simulación (30 cuadros).
5. El metro circula las 24 h, sin horario de servicio.

### 7. Memoria y panel

1. **Las etiquetas de encargos ceden ante los rótulos del núcleo** en la vista
   general; para que la enfocada gane sin moverse, el núcleo tendría que
   recortar un conjunto de módulo antes que sus rótulos.
2. **La placa queda donde la pone el relieve**: delante de algunos portales el
   terreno está por encima de la planta baja (1,3 m en la celda de prueba) y la
   puerta queda medio enterrada. Viene del núcleo (la planta baja es
   `cellH + 0,5`).
3. El paso «Entra en un edificio» de la guía se marca con
   `handle.ext.umbral.estado().dentro`; si `umbral` cambia ese nombre, se marca
   a mano.
4. La hora de la guía tarda hasta cinco segundos en reflejar un cambio del
   selector con el dibujo por software, y la cuenta atrás de la ciudad
   (`#cityCountdown`) da la fecha en hora local; la tarjeta y la guía, en UTC.

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
  la v0.10.13 el panel la mide y desde la v0.11.0 anota los efectos activos;
  falta la máquina.
- **El sonido existe y nadie lo ha oído.** El día uno ya tiene guía.
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- **Los edificios de barrio fuera de la cuadrícula** (celda −1; 227 en la
  v0.10.16) no pueden quedar bajo ninguna parcela, así que no hay nada que
  ocultar; se anota para que nadie lo tome por un fallo.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
