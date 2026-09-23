# Frente «vida» — entrega 6: la vida de la calle (v0.11.0)

Rama `feat/vida`, desde la base 44754ec. Sin cambios de consenso, de red, de
nodo ni de formato: todo está en `chain/crates/rami-gui/src/city3d.js` (tráfico,
calles, catastro, avatares) y en el módulo `chain/crates/rami-gui/src/city/vida.js`
(los peatones). Ningún texto visible nuevo: los peatones no llevan rótulo
(`i18n-src/frag_vida.json` va vacío a propósito).

## Qué se hizo

1. **Carriles reales.** Los coches van por los carriles pintados: el sombreador
   de la calzada pinta el eje doble a 0,42 m y una línea cada 3,5 m, y cada hueco
   de 2,9 m o más es un carril (`carrilesDe`). Troncal de 42 m: seis por sentido;
   arteria de 26: tres; secundaria de 15 y calles de barrio de 13, 16 y 18 m: dos;
   calle de 10 m: uno. El carril de cada coche sale de la serie del tráfico y no
   cambia; solo se aparta para esquivar al jugador. Velocidad de crucero por
   ancho: 30, 21, 15 y 11 m/s.
2. **Tráfico por todas las calles, no solo por las 21 del mapa.** Cada tramo vivo
   de cada vía (las del mapa y las 756 de la trama) es una ruta: 895 rutas (852
   antes de quitar los tramos montados sobre otra vía, ronda 1). Al final de una
   ruta el coche da la vuelta por un semicírculo de su carril al mismo carril del
   otro sentido (ronda 1; antes reaparecía en el otro extremo de la vía y, en la
   primera entrega, cruzaba en diagonal todos los carriles).
3. **Cesión de paso.** `resuelveCruces` apunta cada cruce en `S.cruces`; sobre
   cada ruta quedan los cruces con otra ruta (3.905 con ruta a los dos lados) y
   si cede o manda. Desde la ronda 1 la cesión se decide coche a coche con sus
   carriles (`geoCruce`): dónde se corta el carril de uno con el del otro, que en
   un cruce oblicuo cae lejos del centro. El que cede se para en su línea de
   detención (o antes de la calzada ajena por su carril, si llega antes) si
   alguien de la preferente pisa ya su carril o lo pisará antes de que él haya
   dejado atrás el suyo, contando lo que tarda desde donde está y a la velocidad
   que lleva, más 0,8 s. La glorieta se recorre por el anillo, con la isla a la izquierda, y se
   cede al que va por él y pasará por la entrada; dentro del anillo cada coche
   guarda la distancia con el que lleva delante, sea de la vía que sea. Una ruta
   no acaba dentro de una glorieta: el coche da la vuelta antes de la entrada.
   Frenado con el perfil de deceleración constante que ya existía.
4. **Sin bloqueos.** Un coche no entra en un cruce si el de delante está parado
   justo al otro lado (`cajaTapada`) o si el paso de peatones de la salida está
   ocupado (`salidaTapada`), y no se para dentro de un cruce ni encima de un paso
   si le da para pararse antes (ronda 1); la preferente no entra en el carril de
   quien ya está cruzando; un coche PARADO en la preferente fuera del carril del
   otro no cuenta como que llega. La válvula: tras 30 s parado en la línea, el
   coche se mete si todos los que vienen por la preferente pueden pararse antes
   de su carril; desde los 20 s, la preferente le deja hueco por cortesía si
   puede pararse con la deceleración normal (ronda 1). Y una red de seguridad: un
   coche que lleva 40 s parado en un ciclo de esperas hace que el más lejano del
   ciclo a la cámara se recoloque. Cada coche apunta en `causa` el coche que lo
   frena (tablas abajo).
5. **Pasos de peatones.** Los coches se paran ante un paso ocupado si les da
   para parar (`S.cebraOcupada`, que marca el módulo de los peatones). En los
   cruces de dos calles de barrio el paso va ahora también en la preferente: sin
   él no había por dónde cruzarla. 15.296 pasos dibujados (7.908 antes).
6. **Peatones** (`city/vida.js`): función pura del tiempo de Dubái. Casa en el
   portal de una villa o de un bloque; trabajo en las empresas de las parcelas
   (plantilla por sector, ingresos y activos; peso por cercanía en celdas) o, sin
   parcelas, en las torres (tres de cada cuatro) o naves del barrio de oficinas
   más cercano; horario por semilla; camino por las aceras de la retícula,
   doblando las esquinas por su curva y cruzando solo por los pasos pintados;
   1,2–1,6 m/s. Radio andable: 1.200 m por la retícula; más lejos, metro o taxi:
   desde la ronda 1, aparece y desaparece en el bordillo de una parada del
   barrio o en el de delante de su portal (ver abajo). La población se rehace
   por trozos cuando cambian las parcelas, sin congelar el visor (ronda 1).
7. **Dibujo**: mallas instanciadas con `avatarBodyGeometry`/`avatarLimbGeometry`
   en su variante ligera, cuatro estilos, colores por semilla, balanceo al andar,
   quietos mientras esperan su turno en el bordillo. Tope y radio por calidad:
   baja 0; media 300 a 260 m; alta 800 a 420 m; ultra 1.500 a 650 m. Brazos y
   piernas solo a menos de 80 m. Sin sombras en baja y media. Sin rótulos.
8. **Colisión**: el jugador no atraviesa a los peatones (gancho `empujar`,
   círculo de 0,35 m).
9. **Pendientes de la calle**: (a) la ruta de los coches se corta donde se corta
   la cinta; (b) las aceras de barrio existían desde la v0.10.6 (con bordillo,
   el mismo perfil de ocho puntos que las vías del mapa), así que no cuestan
   ningún triángulo nuevo; lo que faltaba era pisarlas (ver «Arreglos»); (c) el avatar ajeno que se solapa con el
   jugador se aparta (solo al dibujarlo) hasta 0,9 m.

### Arreglos del núcleo que salieron por el camino

- **El catastro giraba las cajas al revés.** `aLocal`, `empujarFuera` y
  `cortaCaja` rotaban por el ángulo contrario al de three.js: la caja de choque
  de un edificio girado era la de su reflejo. En 200 edificios alargados y
  girados, las esquinas dibujadas (0,9·medio ancho, 0,9·medio fondo) caían dentro
  de la caja en 40 de 200 antes y en 200 de 200 después. Afecta a la colisión a
  pie, al rayo de pantalla y a todo lo que use `ctx.catastro`. Venía de la
  v0.10.3. Lo destapó el grafo de las aceras: con la caja reflejada, 594 portales
  tenían acceso a la acera; con la buena, 2.066.
- **El jugador andaba bajo la acera.** La cinta se nivela por la cota máxima de
  su sección y en ladera va hasta 2 m por encima del terreno; el jugador pisaba
  el terreno y veía la arena bajo la calzada. `sueloCalle(x, z)` (rejilla de
  64 m con los tramos de las vías y las siete glorietas) da la cota de la
  calzada o de la acera, y `updateWalk` y la VR la usan.
- **El coche que esquivaba hacia la acera.** El desvío de la v0.10.13 elegía
  pasar «por la izquierda del jugador» aunque el jugador estuviera en la acera a
  11 m: el coche se echaba encima. Ahora solo esquiva si el jugador está en su
  trayectoria (a menos de 3,9 m de su línea), y nunca más allá del bordillo.
- **La cámara a pie en un paso sin dibujo** tiene la matriz del cuadro anterior
  (cuelga del rig y solo el render refresca la cadena): el tráfico y los
  peatones refrescan la cadena antes de leerla.

## Cómo está hecho, para quien lo toque después

### Núcleo (`city3d.js`)

- **`buildRoads`** deja en cada vía de `S.vias` sus tramos vivos (`vivos`: donde
  hay cinta; se corta en el agua y fuera del mapa, NO en los cortes del cruce) y
  la cota de la calzada por fila (`filasS`, `filasY`; `cotaVia(v, s)` la
  interpola). Construye `S.cebras` (los pasos dibujados, con su vía, su `s`, su
  centro, su sentido y `aw`, la media distancia de acera a acera por la línea de
  andar) y `S.cebraOcupada`. El orden de las comprobaciones de cada fila cambió
  (primero «dentro», luego el corte) sin cambiar la geometría.
- **`resuelveCruces`** devuelve `cruces`: `{may, men, sMay, sMen, sen, lin, caja,
  cajaMay}` o `{a, b, sa, sb, gl, dA, dB}` en las glorietas; y pone el paso de la
  preferente en los cruces de trama con trama (misma medida que el de la que
  cede, desde la acera de la otra).
- **`buildTrafficPaths`**: una ruta por tramo vivo de 120 m o más, menos los
  tramos «tapados» (`tapadosDe`, ronda 1: montados a menos de 30° sobre otra vía
  de más rango, a menos de lo que ocupan los carriles de las dos; 11.485 m de
  1.550 km, casi todos de trama sobre vías del mapa; el dibujo no cambia);
  `conf` (los cruces ordenados por `t`: `cede` con su línea, `manda`, `gl`; los
  de dos calles llevan su marco `sab`/`cos`, `par` —el mismo cruce visto desde la
  otra— y `alc`, lo que ocupa a lo largo de la ruta), `cebras`, `anillos`,
  `carriles`, `vmax`, los centros de la vuelta `tc0`/`tc1` (`centrosVuelta`) y
  `S.rutaCeldas`, rejilla de 400 m para colocar coches cerca de la cámara.
- **`buildTraffic`**: `R_VIVO = 1000·√(coches/240)` (1.000 m en media, 1.414 en
  alta, 1.826 en ultra: la misma densidad en todas); `colocaCoche` sortea ruta
  (peso = largo × carriles), punto, sentido y carril con la serie `lcg(4242)`,
  nunca a menos de 15,6 m de un centro de vuelta, dentro de un cruce ni a menos
  de su distancia de frenado (y 15 m) antes de uno, ni encima de otro coche de
  su carril; al recolocar, además, a más de 0,5·R_VIVO de la cámara (ronda 1).
  Carrocería ligera (`carGeometry(true)`, 260 triángulos).
- **`updateTraffic`**: recoloca por turnos los coches a más de 1,3·R_VIVO del
  foco; `ordenaColas` da el de delante por ruta, sentido y carril (y las listas
  por ruta y por glorieta; el que da la vuelta va en las dos filas de su carril);
  por coche: el jugador (esquivar o frenar), todos los cruces a la vista (manda
  la parada más corta: en un cruce oblicuo el carril de uno más lejano puede
  llegar antes), los pasos ocupados, no pararse dentro de un cruce ni encima de
  un paso (`_cajas`), el final de la ruta; `c.motivo` guarda lo que más lo frena
  y `c.causa` el coche que lo frena (el de delante, el que tiene preferencia, el
  que ocupa la caja o el que va delante en el anillo), o null si es un peatón,
  el jugador o nada.
  `poseCoche` da la posición con la misma tangente suavizada a 45 m que la cinta
  (el carril cae en el pintado también en los codos) y, dentro de la cuerda de
  una glorieta, por el anillo (en sentido contrario a las agujas del reloj con
  el norte arriba —el ángulo atan2(z, x) decrece—, la isla a la izquierda; el radio se
  funde con el del carril en los extremos; la velocidad por la ruta se escala por
  cuerda/arco para que por el anillo vaya a su velocidad). Se dibujan los coches
  a menos de 1,4·R_VIVO de la cámara (`mesh.count`).
- **`geoCruce(c, cf, y)`** (ronda 1): con el cruce como recta y las tangentes
  suavizadas, el carril de `c` a u_c del eje y el de `y` a u_y se cortan en
  s_c = (u_y − u_c·cos)/sab y s_y = (u_c − u_y·cos)/(−sab); cada uno pisa el
  carril del otro a menos de h = medio largo + (medio ancho·|cos| + medio ancho
  + 0,6 m)/|sab| de ese punto. En metros «de marcha» (crecen en el sentido del
  coche, cero en el centro): `xc`, [a0, a1] y `xy`, [b0, b1]. **`bandaCruce`**:
  la calzada ajena entera por el carril de `c`, con la misma holgura, [x0, x1];
  con ella la línea de detención de cada carril (`paradaCede`: la pintada o
  x0 − 1, lo que llegue antes). Seno mínimo 0,2.
- **`debeCeder`** (coche a coche, con el tiempo de `c` hasta dejar atrás el
  carril del otro, `tiempoHasta`), **`valvulaSegura`**, **`ocupaCarril`** (quién
  obliga a parar: el que pisa el carril; si `c` manda, también el que ya ha
  pasado su línea, el forzado, el que no puede pararse y, por cortesía, el que
  lleva 20 s esperando en su línea sin salida tapada —la cortesía para antes de
  la calzada ajena entera y se mantiene una vez decidida—),
  **`debeCederAnillo`**, **`cajaTapada`**, **`salidaTapada`**,
  **`delanteEnAnillo`**. La válvula y la cortesía solo valen para el primero
  de la fila (`primeroEnFila`); la espera solo vuelve a cero cuando el coche se
  mueve. `CEDE_PACIENCIA` = 30 s, `CORTESIA_ANTES` = 10 s, `ATASCO_S` = 40 s (el
  desatasco, al final de `updateTraffic`).
- **No pararse dentro de un cruce ni encima de un paso**: `_cajas` guarda, por
  coche, los tramos de los cruces y de los pasos que tiene por delante; si la
  parada que le toca cae dentro de uno, se retrasa al borde (repetido hasta
  cuatro veces), solo si le da para pararse y si el sitio nuevo no está encima de
  ningún paso, tampoco del que ya pisa. En la preferente, «no entrar en un cruce
  que no podría dejar libre» se decide antes de su propio paso de peatones; si
  ya no le da para pararse antes de él, sigue.
- **La vuelta** (`centrosVuelta`, `vGiro`, `poseCoche` con `c.vu` ≥ 0): el centro
  de la vuelta está a √((carril exterior + 1)² + 2,3²) + 1 m del extremo (8 a 23
  m) y se retrasa hasta que la zona de la vuelta no pisa ningún cruce ni paso;
  el coche del carril k recorre el semicírculo de radio `off` a
  √(3·r) m/s (entre 2 y 4) y sale por el carril k del otro sentido. En
  `ordenaColas` va como líder de los que llegan (el de detrás entra cuando él
  lleva 7,6 m de arco) y como seguidor de los que ya salieron.
- **Rutas y glorietas**: `buildTrafficPaths` recorta el tramo vivo que acaba o
  empieza dentro de la cuerda de una glorieta a 2 m de su entrada. Antes, el
  coche que llegaba al final de la ruta dentro del anillo daba la vuelta y
  `poseCoche` lo llevaba de un salto a la otra mitad del anillo, encima de quien
  estuviera allí (4 de 64 encuentros de prueba). Con el recorte, las glorietas
  que solo tocan el final de una vía no tienen tráfico por el anillo: de las
  siete, dos tienen dos vías que las atraviesan.
- **Avatares ajenos**: `empujarDeMoviles` decide cuánto se aparta el ajeno
  (`apTx`, `apTz`, hasta 0,9 m) y choca contra ese sitio; `updateAvatars` lo
  dibuja ahí con suavizado. Solo si hace falta más de 0,9 m se empuja al jugador.
- **`sueloCalle(x, z)`**, en `ctx.mundo`.

### Módulo (`city/vida.js`)

- **Zona**: un barrio con trama (34). `zonaDeTrama` saca de `S.tramas` y de
  `S.vias` (`barrio`, `familia`, `k`) la retícula en su marco local.
  **`construyeGrafo`**: por cruce (k, j) y esquina, dos nodos (A en la acera de
  la calle j, donde empieza la curva de la esquina; B en la de la calle k);
  aristas de lado de manzana, de vuelta a la esquina (por las dos curvas de acera,
  que se separan del eje con el mismo `ensancheBoca` que el bordillo y se
  cortan en `q`) y de paso de peatones (solo si el núcleo lo ha pintado:
  `cebraEn` busca el paso de esa vía a menos de 2,5 m del centro esperado). Cada
  arista se densifica y se comprueba cada 2,5 m: ni agua (cota ≤ 0,6), ni
  edificio (`ctx.catastro.bajo`), ni calzada de otra calle (`enAsfalto`, rejilla
  de 64 m sobre `S.vias` que respeta cortes y tramos vivos); el tramo del paso
  solo puede pisar la calzada que cruza. 38.468 aristas.
- **Acceso** de un portal: la manzana en la que cae, el lado más cercano cuya
  arista exista, y un camino recto de la puerta a la acera libre de edificios
  con 0,8 m de holgura a cada lado, de agua y de calzada. Los edificios son los
  alineados con una trama (la primera que los contiene, como `orientaEnTrama`).
- **Caminos**: Dijkstra con pesos enteros (centímetros) y desempate por índice
  de nodo: en una retícula hay muchos caminos igual de largos y con distancias
  de coma flotante dos máquinas elegirían distinto. Un árbol por acceso de
  origen (`arbolDe`, en `Int32Array`), guardados hasta 800; caminos por viaje
  hasta 8.000 (se recalculan igual). `monta` aparta la polilínea a la derecha
  del sentido de marcha (inglete en los vértices; en los portales, no) y mide
  los pasos entre sus dos puntos marcados.
- **Personas**: `construye` recorre las casas en orden (zona, barrio, edificio) y
  los vecinos con `lcg(mezcla(semillaMorfologia(x, z, 21), k))`: villa 2–4,
  bloque 6–70 según plantas y huella. `agenda` pone los viajes con hora de
  salida en segundos enteros: ida, llegada, salida y vuelta (metro o taxi) o ida
  y vuelta a pie; comida (55 % de los que trabajan); recados (quien no trabaja:
  uno de 9:00 a 14:00, otro de 15:00 a 20:30);
  paseo de noche (12 %); madrugada (2 %). Los destinos que dependen del grafo (la
  parada, el sitio de la comida) se guardan como un sorteo entero o una marca y
  se resuelven al pedir el camino.
- **Metro o taxi** (ronda 1): si el trabajo no está en la misma trama o queda a
  más de 1.200 m por la retícula (Manhattan en metros enteros), el peatón sale
  de casa hacia la parada de su barrio más cercana por la acera (centímetros
  enteros, a igualdad la de índice menor) y desaparece en su bordillo; tras
  15–40 min aparece en el bordillo de la parada más cercana a su trabajo y llega
  andando. Las paradas (`paradasDe`) son, en cada una de las ocho direcciones
  enteras, el nodo con acera más alejado del centro del barrio: de 7 a 8 por
  barrio, en el borde. Si no hay ninguna a menos de 600 m (`PARADA_MAX`), el
  taxi para en el bordillo de delante del portal (`acceso` guarda ese punto,
  `C`) y el camino es portal → acera → bordillo (`caminoTaxi`). El bordillo está
  a 0,35 m del borde, en la acera (`nodoLocal`, `bordilloDe`). Una parcela fuera de toda
  trama se alcanza desde la puerta del taxi, de 40 a 70 m delante del portal
  (lo más lejos que esté libre) o en el bordillo de la calle que tenga delante;
  si la fachada principal no tiene salida, por los costados y por detrás, con el
  portal en esa fachada. Una parcela sin salida por ninguna (en el agua de la
  ría o de la costa: las celdas de tierra del consenso no miran el relieve fino)
  no entra en el sorteo de los puestos de trabajo.
- **Sin parcelas nadie va andando al trabajo**: las torres y naves de oficinas
  están en barrios de otro tipo que las villas y los bloques, y cada barrio es un
  grafo aparte (no hay aceras entre barrios), así que todos los que trabajan van
  en metro o taxi y andan los dos extremos. Con parcelas, andan de puerta a
  puerta los que trabajan en una empresa de su propio barrio.
- **Turnos de los pasos**: cada paso tiene un ciclo de 90 s desfasado por paso
  (`mezcla(id, 97) % 90`) y en sus primeros 12 s se empieza a cruzar; quien llega
  fuera de turno espera en el bordillo. Es una función del tiempo (la llegada al
  paso lo es), así que la espera también. Sin esto, en hora punta un paso
  concurrido tenía gente encima minutos seguidos y los coches no pasaban.
  `horario` deja en cada camino las esperas y cuándo se pisa y se deja cada paso;
  un paso cuenta como ocupado desde 4 s antes de pisarlo.
- **Reloj**: el de Dubái (UTC+4) en segundos del día; con la hora fijada en el
  visor corre desde esa hora; `fijaReloj(T)` para las pruebas.
- **Construcción por trozos** (ronda 1): `trabajoNuevo`/`trabajoPaso`/
  `trabajoFin`. Seis fases (índices, grafo por columnas de cruces, portales,
  parcelas, vecinos, índice de horas) que avanzan hasta un plazo; mientras,
  `V` apunta al estado nuevo y las funciones de siempre escriben ahí. En cada
  cuadro, un cuarto de lo que dura el cuadro (entre 6 y 200 ms). Al acabar se
  cambian de una vez los campos de `CAMPOS`. `listo` y el cambio de calidad
  construyen de una vez; `ciudad` (parcelas nuevas o distintas), por trozos.
- **Caminos con plazo** (ronda 1): en cada cuadro, los caminos nuevos se
  calculan hasta un 15 % de lo que dura el cuadro (entre 3 y 60 ms), de la zona
  más cercana a la más lejana; los que no caben esperan al cuadro siguiente sin
  dibujarse ni marcar pasos. `posicion` no tiene plazo. Los caminos guardados se
  podan quitando los que no se han usado en 120 cuadros (`poda`), en vez de
  borrarlos todos.
- **Cada cuadro**: las zonas a menos de 1.600 m del foco + su radio; por zona,
  búsqueda binaria de los viajes que salieron en los últimos `DMAX` segundos
  (2.500 + 1.200 de esperas); los que están en la calle marcan sus pasos y, si
  están a menos del radio de la calidad de la cámara, se dibujan los más
  cercanos hasta el tope.
- **Reconstrucción**: en `listo`, y en `ciudad` solo si cambia la firma (sitio,
  sector y plantilla de cada parcela, y los edificios ocultos); los ingresos
  crecen cada bloque y no entran en la firma; un activo más sí (la plantilla
  sube), y por eso desde la ronda 1 esa reconstrucción va por trozos. En calidad baja no hay peatones y
  el grafo no se hace (el catastro de baja tiene el 40 % de los edificios).

## Ronda de corrección 1

La revisión adversarial encontró tres fallos importantes y cinco menores. Todos
están arreglados o contestados; las cifras de «antes» son las de la revisión y
las de «después», de las mismas pruebas con el código nuevo (tablas de abajo).

| Hallazgo | Antes | Después |
|---|---|---|
| Cruces oblicuos: la caja medida por el eje no veía dónde se cortan los carriles, ni el ancho del coche (ultra, torres, 10 min) | 295 muestras de solape, 161 parejas | 0 en dos ejecuciones; 0 en 504 encuentros forzados en los cruces más oblicuos que quedan (`geoCruce`, `bandaCruce`, `ocupaCarril`, válvula segura) |
| La vuelta al final de la ruta cruzaba en diagonal todos los carriles (media, bloques, 10 min) | 62 muestras de solape, 30 parejas | 0 (semicírculos concéntricos, `centrosVuelta`); 0 en 120 coches dando la vuelta en fila en los ocho extremos de prueba |
| La población se rehacía de una vez en el hilo principal al cambiar una parcela | 1.434–2.288 ms congelado; `setCity` con un activo más, 1.610 ms | por trozos: `setCity` con un activo más, 77 ms; trozo más largo, 16,7–26,6 ms; paso más largo mientras se reconstruye, 24,7–67 ms; 0 diferencias con la construcción de una vez |
| Tirones por caminos calculados de golpe (ultra, 10 min) | 19 pasos de más de 50 ms; 372 ms el primero | de 0 a 4 pasos de más de 50 ms por ejecución, el más largo de 88 ms en ultra (caminos con plazo, poda en vez de borrado) |
| Coches que aparecen de golpe cerca del foco (ultra, 10 min) | 50 | 0 en las ocho ejecuciones (`POP_MIN`) |
| Comentario y notas del sentido de la glorieta | «horario» | corregido: contrario a las agujas del reloj con el norte arriba (el código no cambia) |
| Coches sobre la arena en el cruce oblicuo; puntos de carril fuera de la calle | 2.684 de 2.576.100 (0,1 %) | 421 de 2.530.600 (0,017 %); el triángulo de arena de los cruces oblicuos sigue (pendiente) |
| `ctx.catastro.aLocal` cambia de sentido | — | comprobado en las ramas de los otros cuatro frentes: ningún módulo llama a `aLocal`; `extras` usa `empujarFuera` y `bajo` sin compensar el giro, así que el arreglo solo corrige su colisión |
| Metro o taxi: aparecían y desaparecían en mitad de la acera | nodo sorteado a 120–450 m | en el bordillo de una parada del barrio (11.524 de 16.445 extremos) o en el de delante del portal (4.921); 0 en la calzada |

### La reconstrucción por trozos (`r1_async.mjs`)

Ciudad sintética con 12 parcelas junto a los bloques de la zona 11; tras
`setCity`, pasos de 1/60 s (un cuadro a 60 por segundo) hasta que acaba.

| Cambio | `setCity` | Trozos | Trozo más largo | Paso más largo | Pasos de más de 50 ms | Trabajo total |
|---|---|---|---|---|---|---|
| Doce parcelas nuevas (edificios nuevos) | 691 ms (la mayor parte, la ciudad del núcleo) | 211 | 26,6 ms (grafo) | 67 ms | 1 | 1.408 ms |
| Un activo más en una parcela | 77 ms | 192 | 16,7 ms | 24,7 ms | 0 | 1.259 ms |

Por fases (un activo más): índice de calzada 50 ms, grafo de aceras 1.078,
portales 30, parcelas 1, vecinos 55, índice de horas 46. La población de antes
sigue en la calle hasta el cambio.

## Cifras medidas

Panel real (binario base de la v0.10.16 + proxy con este JavaScript), Chromium
sin pantalla con SwiftShader, calidad media salvo donde se dice. Los scripts
de prueba están fuera del repositorio (arnés de /tmp); sus resultados, en
`/tmp/ramiverif/vida_*.json`.

### Lo que se construye

| | cifra |
|---|---|
| Rutas de tráfico (tramos vivos de 120 m o más) | 895 (antes 21 vías; 852 en la primera entrega, antes de quitar los tramos tapados) |
| Tramos tapados (montados sobre otra vía casi paralela, sin tráfico) | 11.485 m de 1.550 km (9.825 de trama, 1.660 del mapa), en 78 vías |
| Rutas por calzada y carriles por sentido | 42 m: 9 con 6 · 26 m: 17 con 3 · 15/16/18 m: 319 con 2 · 13 m: 287 con 2 · 10 m: 220 con 1 |
| Cruces resueltos por `resuelveCruces` | 4.505 (4.495 de dos calles y 10 parejas en 7 glorietas) |
| Cruces con ruta a los dos lados (cede/manda) | 3.905 (4.049 antes de quitar los tramos tapados); el más oblicuo, a 32° (seno 0,53) |
| Glorietas con tráfico por el anillo (dos vías que la atraviesan) | 2 de 7 |
| Pasos de peatones dibujados | 15.296 (7.908 antes); 15.206 sobre una ruta |
| Grafo de aceras | 34 barrios, 38.468 aristas, 1.802 portales con acceso |
| Población (sin parcelas) | 28.470 personas, 130.792 viajes al día |
| Construcción de la población | 1.554–2.238 ms de una vez al cargar; al cambiar las parcelas, por trozos (abajo) |
| Paradas de metro o autobús | 255 en los 34 barrios (7 u 8 por barrio) |
| Coste de un paso de simulación (tráfico + peatones, hora punta, media) | 2,73 ms (1,29 en la primera entrega: ahora se miran todos los cruces a la vista, coche a coche) |

### Pruebas deterministas (`handle._debug.paso(dt)`)

| Prueba | Resultado |
|---|---|
| Ceder: X por la que cede a 90 m de su línea, Y por la preferente a 100 m del cruce, los dos a 11 m/s (ruta 43 cede a la 48, calzadas de 16 m) | X se para con el morro a 0,47 m de la línea a los 8,8 s; arranca a los 9,5 s, cuando Y ha dejado atrás su carril (Y sale de la caja entera a los 10,1 s), y cruza. Nunca pasa la línea antes. |
| Cruces oblicuos (ronda 1): los tres más oblicuos que quedan con una preferente de tres carriles (32°, seno 0,53) y uno recto; todas las parejas de carril y sentido, 7 desfases de −3 a +3 s (`r1_oblicuo.mjs`) | 168 + 168 + 168 + 112 encuentros; 0 con las cajas de 4,6 × 2,0 m solapadas (ejes separadores); en todos pasan los dos; X cede en 102, 102, 102 y 76; espera máxima 7,4 s. |
| La vuelta (ronda 1): cuatro coches por carril en fila y uno por carril saliendo, en los dos extremos de una troncal (6 carriles), una arteria (3), una calle de 15 m (2) y una de 10 (1) (`r1_vuelta.mjs`) | 0 solapes en los 8 casos; hasta 18 coches dando la vuelta a la vez en la troncal; todos han dado la vuelta a los 17–28 s. |
| Peatón en un paso: coche hacia el paso 808 (calzada 16 m) mientras lo cruza el peatón 26.677 | Se para con el morro a 1,47 m del borde del paso; el paso queda libre a los 13,3 s y arranca a los 13,5 s; el morro nunca pisa el paso ocupado. |
| Glorietas: 88 encuentros (X entra, Y va por el anillo, cuatro sentidos, 11 desfases) | X cede en 42; ninguna caja (4,5 × 1,9 m, ejes separadores) se monta en otra; separación mínima 9,6 m; X sale siempre; espera máxima 5 s. |
| Anillo con un coche parado y otro de la otra vía que entra detrás: 32 casos | El de detrás frena por el de delante en 20 (en los demás no se cruzan); 0 solapes. |
| Mismo peatón en el mismo T: 1.200 posiciones (400 por instante a las 8:15, 12:40:30,5 y 18:05:07,25) | Iguales al bit tras borrar cachés, tras reconstruir la población entera y en otro Chromium. |
| Por trozos frente a de una vez (ronda 1): 1.218 posiciones en tres instantes tras una reconstrucción por trozos y otra de una vez | 0 diferencias. |
| Suelo: cada 5 min de 5:00 a 24:00, todos los peatones en la calle (131.628 muestras) | 0 en el agua, 0 dentro de un edificio (`ctx.catastro.bajo`), 0 en la calzada fuera de un paso; 8.502 en un paso, a 0,7 m como mucho de su eje; 30.198 esperando turno en el bordillo. |
| Paradas y taxis (ronda 1): el extremo del camino de uno de cada cinco viajes de metro o taxi (16.445) | 11.524 en el bordillo de una parada y 4.921 en el de delante de su portal; 0 en la calzada, 0 en el agua, 0 en un edificio; 7 a más de 1,2 m de la calzada (en una esquina de parada). Mediana del camino a pie, 292 m (p90, 546). |
| Coches fuera de la calle (ronda 1): puntos de carril cada 3 m entre los dos centros de vuelta, y los semicírculos | 421 de 2.530.600 donde `sueloCalle` no encuentra calle (0,017 %; la revisión contó 2.684 de 2.576.100, el 0,1 %, casi todos en el arranque de una ruta o junto a un corte): 185 en un cruce, 54 cerca de un extremo, 182 en otros sitios. En los semicírculos, 102 de 78.184 (0,13 %). |
| Agua (pendiente a): ejes de las rutas cada 10 m | 24 de 154.015 puntos sobre el agua (8 rutas, en el borde de un corte, entre dos filas de la cinta); con las vías del mapa de punta a punta, 1.201 de 46.553. 123 vías cortadas por el agua. |
| Choque con un peatón (jugador de 0,42 m encima de uno) | Sale empujado por `peaton` a 0,77 m (0,42 + 0,35). |
| Avatar ajeno encima del jugador (pendiente c) | Aparece a 0,60 m; se dibuja apartado 0,22 m, a 0,82 m del jugador; el jugador no se mueve; su posición de red no cambia. |
| Economía: 12 parcelas sintéticas junto a barrios de viviendas | 19.996 de 27.700 personas trabajan en ellas; 2.105 andan de puerta a puerta, 17.891 en metro o taxi; los caminos acaban a 0,002 m del portal de su parcela; todas las parcelas con salida reciben su llegada. |

### Choques y atascos: 10 minutos simulados, `paso(0,1)` × 6.000 (ronda 1, `r1_solapes.mjs`)

La prueba de la revisión, ampliada: cada 0,5 s, las cajas de 4,6 × 2,0 m de
todos los coches a menos de 700 m del foco, dos a dos (ejes separadores); los
peatones a menos de 500 m contra las cajas de los coches (con 0,35 m); en cada
paso, los ciclos de coches parados siguiendo `causa`; los coches parados más de
60 s; los que aparecen a menos de 250 m del foco sin haber estado a menos de
700 m medio segundo antes; y lo que tarda cada paso. A las 8:15 salvo donde se
dice; «g0» es la glorieta 0.

| Sitio, calidad (coches) | Muestras de solape | Contactos con peatones | Ciclo más largo | Parados > 60 s | Máximo parado | Aparecen cerca | Válvulas | Desatascos | Pasos > 50 ms | ms por paso |
|---|---|---|---|---|---|---|---|---|---|---|
| Bloques (zona 11), media (240) | 0 | 0 | — | 0 | 25,2 s | 0 | 0 | 0 | 0 | 2,50 |
| Torres (zona 6), media (240) | 0 | 0 | 0,1 s | 0 | 43,1 s | 0 | 13 | 0 | 1 | 2,91 |
| g0, media (240) | 0 | 0 | 0,1 s | 0 | 38,6 s | 0 | 2 | 0 | 0 | 2,39 |
| Torres, ultra (800) | 0 | 0 | 0,1 s | 0 | 45,0 s | 0 | 49 | 0 | 2 | 7,10 |
| Torres, ultra (800), otra vez | 0 | 0 | 0,1 s | 0 | 34,7 s | 0 | 32 | 0 | 0 | 7,07 |
| Bloques, ultra, 17:54 (800) | 0 | 0 | 0,1 s | 0 | 49,4 s | 0 | 14 | 0 | 1 | 6,79 |
| g0, ultra (800) | 0 | 0 | 0,1 s | 0 | 51,9 s | 0 | 52 | 0 | 4 | 6,50 |
| g0, ultra (800), otra vez | 0 | 0 | 0,1 s | 0 | 54,0 s | 0 | 87 | 0 | 0 | 7,11 |

Antes de la ronda 1 (la revisión, mismas medidas): 62 muestras de solape en
bloques en media (44 en la vuelta del final de una ruta), 295 en torres en ultra
(161 parejas, casi todas en el cruce oblicuo de la troncal), 50 coches que
aparecían cerca, 19 pasos de más de 50 ms (372 ms el primero). Por el camino de
esta ronda salieron y se arreglaron también: 38 solapes junto a la glorieta 0
por la calle de trama montada sobre la troncal (los tramos tapados); coches que
aparecían a veinte metros de un cruce que otro ya estaba cruzando (ahora no se
recoloca a nadie a menos de su distancia de frenado de un cruce); preferentes
parados sobre su propio paso de peatones y gente que se les metía debajo (8 a
20 contactos en diez minutos); y un bloqueo de verdad, una vez en siete
ejecuciones de ultra, que motivó la regla de no pararse dentro de un cruce y el
desatasco. El «ciclo más largo» de 0,1 s es un artefacto de la actualización
en orden: el que cede ve un cuadro al preferente que ya se estaba parando por
cortesía, y al siguiente ya no.

### Presupuesto

A pie junto al paso de las capturas, a las 8:18 (hora punta), por calidad
(ronda 1, `r1_presupuesto.mjs`):

| Calidad | Triángulos | Llamadas | Peatones dibujados (en la calle cerca) | Sus triángulos | Coches (vivos) |
|---|---|---|---|---|---|
| baja | 797.354 | 12 | 0 (0: sin grafo) | 0 | 0 |
| media | 987.034 | 24 | 64 (271) | 17.624 | 240 |
| alta | 1.051.252 | 24 | 71 (271) | 19.234 | 480 |
| ultra | 1.140.384 | 24 | 97 (271) | 25.166 | 800 |

Un peatón cuesta de 259 a 275 triángulos en estas capturas (los que están a
menos de 80 m llevan brazos y piernas); un coche, 260. Las siete mallas de los peatones son siete
llamadas cuando hay alguien a la vista y ninguna cuando no (`visible = false`
con cero instancias; three.js cuenta la llamada igual si no). Un paso de
simulación (tráfico y peatones, media, hora punta) cuesta 2,73 ms.

A/B de los encuadres fijos (a las 11:00, `ab.mjs`, ronda 1) contra la
referencia de la v0.10.16:

| Encuadre | v0.10.16 | vida | Diferencia |
|---|---|---|---|
| torres_cerca | 920.678 · 21 | 894.678 · 21 | −26.000 · 0 |
| bloques_manzana | 790.042 · 17 | 799.420 · 24 | +9.378 · +7 |
| villas | 959.508 · 15 | 967.430 · 16 | +7.922 · +1 |
| naves | 1.014.414 · 21 | 1.025.414 · 21 | +11.000 · 0 |
| a_pie_manzana | 952.544 · 28 | 964.796 · 31 | +12.252 · +3 |
| a_pie_torre | 802.440 · 17 | 803.128 · 17 | +688 · 0 |
| ciudad_entera | 1.748.908 · 86 | 1.720.858 · 85 | −28.050 · −1 |
| centro | 1.532.854 · 42 | 1.493.396 · 41 | −39.458 · −1 |

Los coches se reparten ahora alrededor de quien mira y se dibujan a menos de
1,4·R_VIVO de la cámara: en los encuadres de la ciudad entera y del centro no
se dibuja ninguno (antes, de los 120 coches de 484 triángulos repartidos por
las autovías, los que cayeran a la vista), y en los de barrio van 240 de 260
triángulos (62.400, frente a 58.080 de los 120 de antes). La llamada de más en villas y las siete en
bloques_manzana son las mallas de los peatones.

## Capturas

Ronda 1 (todas miradas):

- `/tmp/ramiverif/vida_r1_f_cruce_a_pie.png`: a pie en la acera a las 8:18; un
  coche parado ante el paso y un grupo de peatones cruzándolo.
- `/tmp/ramiverif/vida_r1_f_cruce_orbita.png`: el mismo cruce en órbita cercana
  (40 m): el coche parado en su carril ante el paso, la gente en el paso.
- `/tmp/ramiverif/vida_r1_f_cruce_a_pie_2.png`: a pie en la calzada, junto al paso.
- `/tmp/ramiverif/vida_r1_vuelta_troncal.png`: el final de una troncal cortada
  por el agua, con 18 coches de los seis carriles dando la vuelta a la vez por
  sus semicírculos, sin tocarse.
- `/tmp/ramiverif/vida_r1_cruce_oblicuo.png`: el cruce más oblicuo que queda
  con una preferente de tres carriles (32°), con tráfico a las 8:20.
- `/tmp/ramiverif/vida_r1_revision_oblicuo.png`: el sitio de la captura de la
  revisión (38510, 20810): las calles de trama que cruzaban la troncal a 23° ya
  no llevan tráfico junto a ella (tramos tapados); el triángulo de arena del
  corte perpendicular sigue ahí (pendiente).
- `/tmp/ramiverif/vida_r1_parada_a_pie.png` y `vida_r1_parada_orbita.png`: una
  parada a las 17:40, con gente en el bordillo de la esquina.
- `/tmp/ramiverif/vida_r1_pr_a_pie_{baja,media,alta,ultra}.png`: el presupuesto.
- `/tmp/ramiverif/vida_r1_ab_*.png`: los encuadres fijos.

## Lo que queda

- **Las rutas no se enlazan entre sí.** Al final de cada una el coche da la
  vuelta por el semicírculo de su carril (ronda 1: sin cruzar a nadie, pero en
  el borde de cada barrio y del mapa se ve dar la vuelta a filas enteras). En 5
  de las 7 glorietas las vías del mapa llegan partidas en dos y los coches dan
  la vuelta antes de la entrada, sin pasar por el anillo. Enlazarlas es un grafo
  de rutas con giros en los cruces.
- **Tramos tapados**: 11.485 m (9.825 de trama y 1.660 de vías del mapa) van montados sobre otra
  vía casi paralela. Desde la ronda 1 no llevan tráfico, pero se siguen
  dibujando encima de la otra calzada: arreglarlo es cortar la cinta de la trama
  en `tramaBarrio`/`buildRoads`, que cambia el dibujo de 78 vías.
- **Cruces oblicuos**: la cinta de la calle que cede se corta en perpendicular a
  su eje, así que entre el corte y el borde oblicuo de la preferente queda un
  triángulo de arena por el que pasan algunos carriles (de los 2.530.600 puntos de carril, 185 caen fuera de la calle en un cruce). Los coches ya no se
  paran ahí (la línea de detención de cada carril y la regla de no pararse
  dentro de un cruce), pero lo cruzan.
- **Los coches no son deterministas** (ni lo eran): cada máquina ve su tráfico.
  Los peatones sí lo son. Tampoco la simulación de coches de una misma máquina es
  repetible de una ejecución a otra: el plazo de los caminos de los peatones
  depende del reloj, y con él qué pasos se marcan.
- **Recolocar y desatascar son saltos**: un coche recolocado aparece a más de
  0,5·R_VIVO de la cámara (500 m en media, 913 en ultra), todavía dentro del
  radio de dibujo; el desatasco quita el coche del ciclo más lejano a la cámara,
  que desaparece.
- **Sin parcelas nadie va andando al trabajo** (ver «Metro o taxi»): andan de
  casa a la parada y de la parada a la oficina. Tampoco hay aceras entre barrios
  ni a lo largo de las vías del mapa: los peatones solo existen en los 34 barrios
  con trama. No hay parada dibujada: es un sitio del bordillo.
- De los portales de los edificios de barrio, 522 no encuentran un camino recto
  libre a la acera (145 sin lado de manzana con arista, 252 con un edificio en
  medio, 105 a más de 120 m, 13 por agua, 7 por calzada): esos edificios no tienen
  vecinos que salgan a la calle.
- El 1,2 % de los viajes (230 de 18.806 en la muestra) se quedan sin camino (la comida o el recado sin un portal
  entre 80 y 450 m, o sin parada ni bordillo a mano) y ese día no se ven.
- La primera construcción de la población (al cargar) sigue siendo de una vez:
  de 1.554 a 2.238 ms dentro de la carga del visor.
- El semáforo no existe: la cesión es de ceda el paso en todos los cruces, con
  la cortesía y la válvula de 30 s. En ultra, unas 50 válvulas en 10 minutos en el
  barrio de torres (445 antes de la ronda 1: la cortesía abre el hueco antes).
- Probado solo en Chromium con SwiftShader; sin cifras de fluidez de una
  tarjeta real.
