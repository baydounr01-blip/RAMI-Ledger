# Frente «vida» — entrega 6: la vida de la calle (v0.11.0)

Rama `feat/vida`. Las rondas 0 y 1 salieron de la base 44754ec; la ronda de
corrección 2 va sobre la integración 80067fa (los seis frentes juntos) y se mide
con su binario (`rami-gui-integ`). Sin cambios de consenso, de red, de nodo ni
de formato: todo está en `chain/crates/rami-gui/src/city3d.js` (tráfico, calles,
catastro, avatares) y en el módulo `chain/crates/rami-gui/src/city/vida.js` (los
peatones). Ningún texto visible nuevo: los peatones no llevan rótulo y no hay
`i18n-src/frag_vida.json` (no hay cadenas que traducir).

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
   otro sentido (ronda 1), nunca sobre el agua (ronda 2).
3. **Cesión de paso.** `resuelveCruces` apunta cada cruce en `S.cruces`; sobre
   cada ruta quedan los cruces con otra ruta (3.905 con ruta a los dos lados) y
   si cede o manda. Desde la ronda 1 la cesión se decide coche a coche con sus
   carriles (`geoCruce`): dónde se corta el carril de uno con el del otro, que en
   un cruce oblicuo cae lejos del centro. El que cede se para en su línea de
   detención (o antes de la calzada ajena por su carril, si llega antes) si
   alguien de la preferente pisa ya su carril o lo pisará antes de que él haya
   dejado atrás el suyo, contando lo que tarda desde donde está y a la velocidad
   que lleva, más 0,8 s; y (ronda 2) si la preferente está parada ante ese cruce
   porque otro de su calle le cruza el carril en marcha. La glorieta se recorre
   por el anillo, con la isla a la izquierda, y se cede al que va por él y pasará
   por la entrada; dentro del anillo cada coche guarda la distancia con el que
   lleva delante, sea de la vía que sea. Una ruta no acaba dentro de una
   glorieta: el coche da la vuelta antes de la entrada. Frenado con el perfil de
   deceleración constante que ya existía.
4. **Sin bloqueos.** Un coche no entra en un cruce si el de delante está parado
   justo al otro lado (`cajaTapada`) o si el paso de peatones de la salida está
   ocupado (`salidaTapada`), y no se para dentro de un cruce ni encima de un paso
   si le da para pararse antes (ronda 1); si ya tiene el coche encima de un paso,
   no se para hasta dejarlo libre (ronda 2); la preferente no entra en el carril
   de quien ya está cruzando; un coche PARADO en la preferente fuera del carril
   del otro no cuenta como que llega, salvo el que espera ante ese mismo cruce a
   que se vacíe su carril (ronda 2). La válvula: tras 30 s parado en la línea, el
   coche se mete si todos los que vienen por la preferente pueden pararse antes
   de su carril; desde los 20 s, la preferente le deja hueco por cortesía si
   puede pararse con la deceleración normal (ronda 1). Y una red de seguridad: un
   coche que lleva 40 s parado en un ciclo de esperas hace que el del ciclo que
   no se ve (o el más lejano) se recoloque. Cada coche apunta en `causa` el coche
   que lo frena (tablas abajo).
5. **Pasos de peatones.** Los coches se paran ante un paso ocupado si les da
   para parar (`S.cebraOcupada`, que marca el módulo de los peatones). En los
   cruces de dos calles de barrio el paso va ahora también en la preferente: sin
   él no había por dónde cruzarla. 15.296 pasos dibujados (7.908 antes). Desde la
   ronda 2 los turnos de los pasos de un cruce van coordinados, como un semáforo
   de peatones (ver «Turnos de los pasos»).
6. **Peatones** (`city/vida.js`): función pura del tiempo de Dubái. Casa en el
   portal de una villa o de un bloque. Trabajo (ronda 2): cada empresa de las
   parcelas contrata exactamente su plantilla (por sector, ingresos y activos)
   entre los trabajadores que viven más cerca de su parcela; los demás —y todos
   mientras no haya parcelas— van a las torres (tres de cada cuatro) o naves de
   un barrio de oficinas sorteado por gravedad, plantas / (1 + km)². Horario por
   semilla; camino por las aceras de la retícula, doblando las esquinas por su
   curva y cruzando solo por los pasos pintados; 1,2–1,6 m/s. Radio andable:
   1.200 m por la retícula; más lejos, metro o taxi: aparece y desaparece en el
   bordillo de una parada del barrio o en el de delante de su portal (ronda 1).
   La población se rehace por trozos cuando cambian las parcelas, sin congelar
   el visor (ronda 1), y con los caminos de quien estará en la calle ya
   calculados antes del cambio (ronda 2).
7. **Dibujo**: mallas instanciadas con `avatarBodyGeometry`/`avatarLimbGeometry`
   en su variante ligera, cuatro estilos, colores por semilla, balanceo al andar,
   quietos mientras esperan su turno en el bordillo. Tope y radio por calidad:
   baja 0; media 300 a 260 m; alta 800 a 420 m; ultra 1.500 a 650 m. Brazos y
   piernas solo a menos de 80 m. Sin sombras en baja y media. Sin rótulos. Los
   coches se dibujan a menos de 1,4·R_VIVO de la cámara o, más lejos, mientras
   su largo ocupe 1,5 píxeles (ronda 2).
8. **Colisión**: el jugador no atraviesa a los peatones (gancho `empujar`,
   círculo de 0,35 m).
9. **Pendientes de la calle**: (a) la ruta de los coches se corta donde se corta
   la cinta, y la vuelta del final no pisa el agua (ronda 2); (b) las aceras de
   barrio existían desde la v0.10.6 (con bordillo, el mismo perfil de ocho puntos
   que las vías del mapa), así que no cuestan ningún triángulo nuevo; lo que
   faltaba era pisarlas (ver «Arreglos»); (c) el avatar ajeno que se solapa con
   el jugador se aparta (solo al dibujarlo) hasta 0,9 m.

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
  su carril. Al recolocar, además, a más de `POP_MIN`·R_VIVO de la cámara (ronda
  1) y fuera de la vista (ronda 2, `aLaVista`: la esfera del punto del eje con el
  radio de la calzada, contra el campo de la cámara del paso, hasta
  `limiteDibujo()`). Carrocería ligera (`carGeometry(true)`, 260 triángulos).
- **`updateTraffic`**: calcula el campo de la cámara (`_frus`); si el foco ha
  saltado más de `SALTO`·R_VIVO desde el paso anterior (ir a pie a otro barrio,
  un vuelo con cuadros de segundos), recoloca a todos alrededor del foco nuevo
  como al montar el tráfico (`tr.saltos`); si no, recoloca por turnos los coches
  a más de 1,3·R_VIVO del foco. `ordenaColas` da el de delante por ruta, sentido
  y carril (y las listas por ruta y por glorieta; el que da la vuelta va en las
  dos filas de su carril). Por coche: el jugador (esquivar o frenar), todos los
  cruces a la vista (manda la parada más corta: en un cruce oblicuo el carril de
  uno más lejano puede llegar antes), los pasos ocupados, no pararse dentro de
  un cruce ni encima de un paso (`_cajas`), el final de la ruta; `c.motivo`
  guarda lo que más lo frena y `c.causa` el coche que lo frena (el de delante, el
  que tiene preferencia, el que ocupa la caja o el que va delante en el anillo),
  o null si es un peatón, el jugador o nada. **Simulación por cercanía** (ronda
  2): con dt ≤ 1/30 s, el coche a más de `LOD_R` = 400 m de la cámara se actualiza
  uno de cada `LOD_CADA` = 3 pasos con el tiempo acumulado (`c.dtLod`, `dtc`);
  con pasos más largos (las pruebas de 0,1 s, un equipo lento) se actualizan
  todos. `_debug.trafico.lod(false)` la quita. Se dibujan los coches a menos de
  `limiteDibujo()` de la cámara: 1,4·R_VIVO o, si es más, la distancia a la que
  un coche de 4,6 m ocupa `DIBUJO_PX` = 1,5 píxeles (unos 2,4 km con 800 píxeles
  de alto).
  `poseCoche` da la posición con la misma tangente suavizada a 45 m que la cinta
  (el carril cae en el pintado también en los codos) y, dentro de la cuerda de
  una glorieta, por el anillo (en sentido contrario a las agujas del reloj con
  el norte arriba —el ángulo atan2(z, x) decrece—, la isla a la izquierda; el radio se
  funde con el del carril en los extremos; la velocidad por la ruta se escala por
  cuerda/arco para que por el anillo vaya a su velocidad).
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
  carril del otro, `tiempoHasta`; ronda 2: también ante la preferente parada
  por `cajaOcupada` en ese cruce si quien la para es otro coche en marcha o
  forzado —no `c`, no uno quieto al que la preferente da paso por cortesía—),
  **`valvulaSegura`**, **`ocupaCarril`** (quién obliga a parar: el que pisa el
  carril; si `c` manda, también el que ya ha pasado su línea, el forzado, el que
  no puede pararse y, por cortesía, el que lleva 20 s esperando en su línea sin
  salida tapada —la cortesía para antes de la calzada ajena entera y se mantiene
  una vez decidida—), **`debeCederAnillo`**, **`cajaTapada`**,
  **`salidaTapada`**, **`delanteEnAnillo`**. La válvula y la cortesía solo valen
  para el primero de la fila (`primeroEnFila`); la espera solo vuelve a cero
  cuando el coche se mueve. `CEDE_PACIENCIA` = 30 s, `CORTESIA_ANTES` = 10 s,
  `ATASCO_S` = 40 s (el desatasco, al final de `updateTraffic`).
- **No pararse dentro de un cruce ni encima de un paso**: `_cajas` guarda, por
  coche, los tramos de los cruces y de los pasos que tiene por delante; si la
  parada que le toca cae dentro de uno, se retrasa al borde (repetido hasta
  cuatro veces), solo si le da para pararse y si el sitio nuevo no está encima de
  ningún paso, tampoco del que ya pisa. En la preferente, «no entrar en un cruce
  que no puede dejar libre» se decide antes de su propio paso de peatones; si
  ya no le da para pararse antes de él, sigue; y si ya tiene el coche encima del
  paso (ronda 2), la parada es donde la cola lo deja libre (`sobre`), aunque
  pise el borde del cruce.
- **La vuelta** (`centrosVuelta`, `vueltaEnAgua`, `vGiro`, `poseCoche` con
  `c.vu` ≥ 0): el centro de la vuelta está a √((carril exterior + 1)² + 2,3²)
  + 1 m del extremo (8 a 23 m) y se retrasa hasta que la zona de la vuelta no
  pisa ningún cruce ni paso y (ronda 2) hasta que su semicírculo exterior, con
  medio coche, no pisa el agua (13 puntos, de 5 en 5 m; `R.vueltaAgua` cuenta los
  retrasos); el coche del carril k recorre el semicírculo de radio `off` a
  √(3·r) m/s (entre 2 y 4) y sale por el carril k del otro sentido. En
  `ordenaColas` va como líder de los que llegan (el de detrás entra cuando él
  lleva 7,6 m de arco) y como seguidor de los que ya salieron.
- **Rutas y glorietas**: `buildTrafficPaths` recorta el tramo vivo que acaba o
  empieza dentro de la cuerda de una glorieta a 2 m de su entrada. Con el
  recorte, las glorietas que solo tocan el final de una vía no tienen tráfico
  por el anillo: de las siete, dos tienen dos vías que las atraviesan.
- **Avatares ajenos**: `empujarDeMoviles` decide cuánto se aparta el ajeno
  (`apTx`, `apTz`, hasta 0,9 m) y choca contra ese sitio; `updateAvatars` lo
  dibuja ahí con suavizado. Solo si hace falta más de 0,9 m se empuja al jugador.
- **`sueloCalle(x, z)`**, en `ctx.mundo`.

### Módulo (`city/vida.js`)

- **Zona**: un barrio con trama (34). `zonaDeTrama` saca de `S.tramas` y de
  `S.vias` (`barrio`, `familia`, `k`) la retícula en su marco local.
  **`cruceGrafo`**: por cruce (k, j) y esquina, dos nodos (A en la acera de
  la calle j, donde empieza la curva de la esquina; B en la de la calle k);
  aristas de lado de manzana, de vuelta a la esquina (por las dos curvas de acera,
  que se separan del eje con el mismo `ensancheBoca` que el bordillo y se
  cortan en `q`) y de paso de peatones (solo si el núcleo lo ha pintado:
  `cebraEn` busca el paso de esa vía a menos de 2,5 m del centro esperado). Cada
  arista se densifica y se comprueba cada 2,5 m: ni agua (cota ≤ 0,6), ni
  edificio (`ctx.catastro.bajo`), ni calzada de otra calle (`enAsfalto`, rejilla
  de 64 m sobre `S.vias` que respeta cortes y tramos vivos); el tramo del paso
  solo puede pisar la calzada que cruza. 38.471 aristas.
- **Acceso** de un portal: la manzana en la que cae, el lado más cercano cuya
  arista exista, y un camino recto de la puerta a la acera libre de edificios
  con 0,8 m de holgura a cada lado, de agua y de calzada. Los edificios son los
  alineados con una trama (la primera que los contiene, como `orientaEnTrama`).
- **Caminos**: Dijkstra con pesos enteros (centímetros) y desempate por índice
  de nodo: en una retícula hay muchos caminos igual de largos y con distancias
  de coma flotante dos máquinas eligen distinto si un empate cae en el último
  bit. Un árbol por acceso de origen (`arbolDe`, en `Int32Array`), guardados
  hasta 800. `monta` aparta la polilínea a la derecha del sentido de marcha
  (inglete en los vértices; en los portales, no) y mide los pasos entre sus dos
  puntos marcados; desde la ronda 2, un vértice apartado que caería en la
  calzada de otra calle fuera de un paso se queda en la línea de la acera.
- **Personas** (`vecinos`): la construcción recorre las casas en orden (zona,
  barrio, edificio) y los vecinos con `lcg(mezcla(semillaMorfologia(x, z, 21),
  k))`: villa 2–4, bloque 6–70 según plantas y huella; de esa serie salen si
  trabaja (72 %), velocidad, estilo, color, lado y fase. El resto del día sale de
  otra serie, `lcg(mezcla(semilla, 0x5eed))` (`destino`, `agenda`).
- **Quién trabaja dónde** (ronda 2): `recluta(J, E, ie)` —una empresa por
  vuelta, en el orden de sus parcelas (fila, columna)— reparte a los trabajadores
  aún sin trabajo en anillos de celdas de la cuadrícula alrededor de su parcela
  (distancia de Chebyshev en celdas de 650 m, enteros) y toma los de los anillos
  más cercanos; dentro del anillo que no cabe entero, por `mezcla(semilla,
  índice de la empresa + 1)` y, a igualdad, por índice. Cada empresa contrata
  exactamente su plantilla o todos los que queden. Los demás, en `destino`:
  torres (a < 0,75) o naves; el barrio con `gravedad` —pesos enteros
  ⌊plantas·10.000 / (1 + km)²⌋ con km = ⌊Manhattan en metros enteros / 1.000⌋
  entre el centro del barrio de la casa y el de oficinas—; el edificio del
  barrio, por sus plantas. Siempre tres sorteos antes de la agenda, para que la
  serie de la agenda no dependa de la rama. `empleo()` da los recuentos.
- **`agenda`** pone los viajes con hora de salida en segundos enteros: ida,
  llegada, salida y vuelta (metro o taxi) o ida y vuelta a pie; comida (55 % de
  los que trabajan); recados (quien no trabaja: uno de 9:00 a 14:00, otro de
  15:00 a 20:30); paseo de noche (12 %); madrugada (2 %). Los destinos que
  dependen del grafo (la parada, el sitio de la comida) se guardan como un
  sorteo entero o una marca y se resuelven al pedir el camino.
- **Metro o taxi** (ronda 1): si el trabajo no está en la misma trama o queda a
  más de 1.200 m por la retícula (Manhattan en metros enteros), el peatón sale
  de casa hacia la parada de su barrio más cercana por la acera (centímetros
  enteros, a igualdad la de índice menor) y desaparece en su bordillo; tras
  15–40 min aparece en el bordillo de la parada más cercana a su trabajo y llega
  andando. Las paradas (`paradasDe`) son, en cada una de las ocho direcciones
  enteras, el nodo con acera más alejado del centro del barrio: de 7 a 8 por
  barrio, en el borde. Si no hay ninguna a menos de 600 m (`PARADA_MAX`), el
  taxi para en el bordillo de delante del portal (`acceso` guarda ese punto,
  `C`) y el camino es portal → acera → bordillo (`caminoTaxi`). Una parcela
  fuera de toda trama se alcanza desde la puerta del taxi, de 40 a 70 m delante
  del portal (lo más lejos que esté libre) o en el bordillo de la calle que tenga
  delante; si la fachada principal no tiene salida, por los costados y por
  detrás. Una parcela sin salida por ninguna (en el agua de la ría o de la
  costa) no contrata a nadie.
- **Sin parcelas nadie va andando al trabajo**: las torres y naves de oficinas
  están en barrios de otro tipo que las villas y los bloques, y cada barrio es un
  grafo aparte (no hay aceras entre barrios), así que todos los que trabajan van
  en metro o taxi y andan los dos extremos. Con parcelas, andan de puerta a
  puerta los que trabajan en una empresa de su propio barrio a menos de 1.200 m.
- **Turnos de los pasos**: un ciclo de 90 s en cuyos primeros 12 s se empieza a
  cruzar; quien llega fuera de turno espera en el bordillo. Desde la ronda 2 el
  turno es del cruce (`faseCruce`: `mezcla(mezcla(zona + 1, k + 4096), j + 4096)
  % 90`, enteros, guardado por paso en `faseCebra` al construir el grafo): los
  dos pasos que cruzan la calle k comparten turno y los que cruzan la calle j van
  45 s después, como un semáforo de peatones. Así un coche espera como mucho un
  turno para su paso de entrada y el de salida juntos. Los pasos fuera de un
  cruce del grafo siguen con su turno propio (`mezcla(id, 97) % 90`). `horario`
  deja en cada camino las esperas y cuándo se pisa y se deja cada paso; un paso
  cuenta como ocupado desde 4 s antes de pisarlo.
- **Reloj**: el de Dubái (UTC+4) en segundos del día; con la hora fijada en el
  visor corre desde esa hora; `fijaReloj(T)` para las pruebas.
- **Construcción por trozos** (ronda 1): `trabajoNuevo`/`trabajoPaso`/
  `trabajoFin`. Nueve fases (ronda 2): 0 índices de calzada, 1 grafo cruce a
  cruce, 2 portales, 3 empresas de las parcelas, 4 vecinos, 5 contratación de
  cada empresa, 6 oficinas y agenda, 7 índice de horas y la tabla `dur` y, solo
  por trozos, 8 precalentado. Mientras, `V` apunta al estado nuevo y las
  funciones de siempre escriben ahí. En cada cuadro, un cuarto de lo que dura el
  cuadro (entre 6 y 200 ms). Al acabar se cambian de una vez los campos de
  `CAMPOS`. `listo` y el cambio de calidad construyen de una vez; `ciudad`
  (parcelas nuevas o distintas), por trozos.
- **Caminos y su caché** (ronda 2): `V.dur` (`Float64Array` por viaje; NaN sin
  calcular, −1 sin camino) guarda la duración de cada viaje en cuanto se
  calcula su camino, y no se poda. `transcurrido` mira primero `V.dur`: un viaje
  acabado no pide su camino, y el camino de un viaje acabado se suelta de la
  caché (`suelta`). La caché guarda así solo a quien está en la calle cerca del
  foco (de 180 a 350 caminos en las pruebas, antes hasta 8.000). `poda` quita los
  no usados en `PODA_CUADROS` = 120 cuadros y ya no vacía nunca la caché entera.
  Los caminos nuevos se calculan en un 15 % del cuadro (entre 3 y 60 ms), de la
  zona más cercana a la más lejana; los que no caben esperan al cuadro siguiente
  sin dibujarse ni marcar pasos. `posicion` no tiene plazo. **Precalentado**
  (fase 8): antes de cambiar de población, los caminos de los viajes de las zonas
  cercanas al foco que salieron en los últimos `DMAX` s o saldrán en los próximos
  `CALIENTA_ANTES` = 60 s (`aCalentar`, `enVentana`); lo calentado cuenta como
  usado en el cuadro del cambio.
- **Cada cuadro**: las zonas a menos de 1.600 m del foco + su radio
  (`zonasCerca`); por zona, búsqueda binaria de los viajes que salieron en los
  últimos `DMAX` segundos (2.500 + 1.500 de esperas); los que están en la calle
  marcan sus pasos y, si están a menos del radio de la calidad de la cámara, se
  dibujan los más cercanos hasta el tope.
- **Reconstrucción**: en `listo`, y en `ciudad` solo si cambia la firma (sitio,
  sector y plantilla de cada parcela, y los edificios ocultos); los ingresos
  crecen cada bloque y no entran en la firma; un activo más sí (la plantilla
  sube). En calidad baja no hay peatones y el grafo no se hace (el catastro de
  baja tiene el 40 % de los edificios).
- **Márgenes del genotipo** (ronda 2, `huella(dx, dz)` y `SONDA`): reconstruye
  con todos los puntos que se comprueban desplazados y devuelve la huella por
  partes (grafo, pesos en cm, accesos, sitio del acceso en cm, trabajos, viajes).
  Resultados en «Ronda de corrección 2».

## Ronda de corrección 2

La revisión adversarial encontró tres fallos importantes y cinco menores. Todos
están arreglados o contestados con pruebas. «Antes» son las cifras de la
revisión (sobre 2b6b2ce) o de la base de la integración (80067fa, el mismo
código que la revisión más los otros frentes); «después», las de las mismas
pruebas con el código de esta ronda.

| Hallazgo | Antes | Después |
|---|---|---|
| 1. Con parcelas, la caché de caminos se vaciaba entera en hora punta y la gente parpadeaba; tras un cambio de la economía no se veía a nadie durante decenas de cuadros | 28 vaciados en 60 s; dibujados 0, 111, 3, 24, 0…; hasta 9.118 aplazados; 0 dibujados en los 40 cuadros tras el cambio | 0 podas y 0 caídas de más del 30 % de los dibujados de un cuadro al siguiente en 3 × 60 s a 60 cps (llegada, cambio de 6 parcelas y el minuto siguiente); caché de 179 a 352 caminos; 0 aplazados en las muestras cada 5 s; 3.234 caminos precalculados antes del cambio (250 ms, por trozos) y, en los 40 cuadros que lo siguen, de 2 a 7 dibujados en cada uno según la prueba, ningún cuadro vacío (`V.dur`, `suelta`, `poda`, fase 8) |
| 2. La plantilla no ponía tope: todos los trabajadores iban a las parcelas | 8 parcelas: todos los que trabajan (unos 20.000) en ellas, con plantillas que suman unas 2.150; 12 parcelas: 19.996 | cada empresa contrata exactamente su plantilla: 6 parcelas de la prueba de la caché, 1.415 puestos y 1.415 contratados; 12 parcelas, 2.820 contratados (de 140 a 900 por empresa) y 1.842 de ellos van andando; el resto, a las oficinas (`recluta`) |
| 3. Sin parcelas, el centro y otros dos barrios de oficinas no tenían a nadie en todo el día; en hora punta, 1.207 en la calle | zonas 0, 4 y 31: 0 viajes; zona 6: 23.156 viajes | los 12 barrios de oficinas con portales reciben trabajadores (de 376 a 3.586; el centro, 2.754) y viajes (zona 0: 8.452; zona 6: 11.096); a las 8:24, 1.117 en la calle y solo la zona 24 vacía (5 edificios, ningún portal con acera). Las zonas 2 y 3, sin portales, tienen gente de paso (de 0 a 3) |
| 4. (menor) El tráfico pesa en la CPU en ultra y las notas no lo separaban | 4,93 ms solo coches (la revisión); base 80067fa medida igual: coches 4,74 ms, peatones 1,17 | por partes, abajo («Coste de un paso»): en ultra a 60 cps, coches 3,38 ms (−29 %: la simulación por cercanía) y peatones 0,65 (−44 %: `V.dur` evita mirar la caché de cada viaje de la ventana) |
| 5. (menor) La vuelta de la ruta 138, junto a la costa, pasaba por el agua | 5 de 96.000 muestras | 0 de 243.300 puntos de los semicírculos de todas las rutas (con el coche entero); 7 rutas retrasan su vuelta (`vueltaEnAgua`) |
| 6. (menor) Recolocados que aparecen a la vista; al llegar a un barrio, ningún coche en un minuto; en la ciudad entera y el centro, ningún coche dibujado | 136 apariciones a 500–900 m (media); 0 coches a menos de 1 km tras llegar | 0 apariciones dentro del campo de la cámara y de lo dibujado en 9 simulaciones de 10 min (de 0 a 358 recolocados por ejecución); el salto del foco recoloca a todos de una vez; se dibujan los coches mientras ocupen 1,5 píxeles (A/B abajo) |
| 7. (menor) El genotipo del grafo depende de Math.sin/Math.cos y de umbrales en coma flotante | sin prueba | prueba de márgenes: con ±1 nm todo igual; con ±1 µm, el grafo, los pesos, los accesos, los trabajos y los viajes iguales y solo cambia el redondeo a cm del sitio de un acceso (margen mínimo de esos redondeos, 1,5 µm). Un último bit distinto en Math.sin mueve un punto unos 7·10⁻¹² m |
| 8. (menor) un condicional estimativo en las notas (lo rechaza `lexico.py` si pasa a las notas de versión) | 1 en las notas, 3 en comentarios del núcleo y 1 en el módulo | ninguno (`lexico.py` en verde) |

### Qué cambió y por qué

- **Hallazgo 1.** El fallo era de diseño: para saber si un viaje seguía en la
  calle hacía falta su camino, y la ventana de `DMAX` (4.000 s) metía en la
  caché todo lo que salió en la última hora. Ahora la duración vive aparte
  (`V.dur`) y la caché solo guarda a quien está en la calle; la poda ya no vacía.
  La población nueva se precalienta en la construcción por trozos (fase 8), con
  su propio plazo, antes del cambio.
- **Hallazgos 2 y 3.** La contratación por anillos es determinista (enteros,
  orden fijo) y respeta la plantilla. La gravedad reparte por todos los barrios
  de oficinas en vez de mandar cada barrio de viviendas entero al más cercano.
- **Atascos que salieron al medir.** Sobre la integración, con las reglas de
  cesión de la ronda 1 (y la primera versión de la recolocación de esta ronda),
  una simulación de ultra junto a la glorieta 0 dio 6 coches más de un minuto
  parados (72 s): una preferente esperaba a que se vaciara su carril mientras la
  que cede pasaba en fila sin hueco (la base de la integración, en la misma
  prueba, llegó a 56,7 s). De ahí la excepción de
  `debeCeder`. La primera versión (ceder a cualquier preferente parada por
  `cajaOcupada`) cerró ciclos de dos y cuatro coches con la cortesía; la final
  solo cede si quien para a la preferente está en marcha o forzado, y en 9
  simulaciones no hay ciclos de más de 0,1 s. También salió un coche parado 62 s
  por la suma de dos turnos de paso sin relación (entrada y salida del mismo
  cruce): de ahí los turnos por cruce. Y 10 muestras de contacto con peatones de
  un coche parado con la cola sobre su paso: de ahí `sobre`.
- **Recolocar fuera de la vista.** Probé primero solo «fuera del campo y a más
  de 120 m»: los recolocados caían detrás de la cámara, junto al foco, y el
  tráfico se apretaba alrededor de quien mira (en el barrio de torres, con lo
  demás igual, 5 coches más de un minuto parados y 331 válvulas; con la
  distancia de la ronda 1 además, ninguno y 238). Por eso quedan las dos reglas.

## Ronda de corrección 1

| Hallazgo | Antes | Después |
|---|---|---|
| Cruces oblicuos: la caja medida por el eje no veía dónde se cortan los carriles, ni el ancho del coche (ultra, torres, 10 min) | 295 muestras de solape, 161 parejas | 0 en dos ejecuciones; 0 en 504 encuentros forzados en los cruces más oblicuos que quedan (`geoCruce`, `bandaCruce`, `ocupaCarril`, válvula segura) |
| La vuelta al final de la ruta cruzaba en diagonal todos los carriles (media, bloques, 10 min) | 62 muestras de solape, 30 parejas | 0 (semicírculos concéntricos, `centrosVuelta`); 0 en 120 coches dando la vuelta en fila en los ocho extremos de prueba |
| La población se rehacía de una vez en el hilo principal al cambiar una parcela | 1.434–2.288 ms congelado; `setCity` con un activo más, 1.610 ms | por trozos: `setCity` con un activo más, 77 ms; trozo más largo, 16,7–26,6 ms; 0 diferencias con la construcción de una vez |
| Tirones por caminos calculados de golpe (ultra, 10 min) | 19 pasos de más de 50 ms; 372 ms el primero | de 0 a 4 por ejecución (caminos con plazo) |
| Coches que aparecen de golpe cerca del foco (ultra, 10 min) | 50 | 0 (`POP_MIN`) |
| Comentario y notas del sentido de la glorieta | «horario» | contrario a las agujas del reloj con el norte arriba |
| Puntos de carril fuera de la calle | 2.684 de 2.576.100 (0,1 %) | 421 de 2.530.600 (0,017 %) |
| `ctx.catastro.aLocal` cambia de sentido | — | ningún otro módulo lo usa |
| Metro o taxi: aparecían en mitad de la acera | nodo sorteado a 120–450 m | en el bordillo de una parada o en el de delante del portal |

## Cifras medidas

Panel real (binario de la integración `rami-gui-integ` + proxy con este
JavaScript), Chromium sin pantalla con SwiftShader, calidad media salvo donde se
dice. Los scripts de prueba están fuera del repositorio (arnés de /tmp); sus
resultados, en `/tmp/ramiverif/vida_r2_*.json`.

### Lo que se construye

| | cifra |
|---|---|
| Rutas de tráfico (tramos vivos de 120 m o más) | 895 |
| Tramos tapados (montados sobre otra vía casi paralela, sin tráfico) | 11.485 m de 1.550 km (9.825 de trama, 1.660 del mapa), en 78 vías |
| Rutas por calzada y carriles por sentido | 42 m: 9 con 6 · 26 m: 17 con 3 · 15/16/18 m: 319 con 2 · 13 m: 287 con 2 · 10 m: 220 con 1 |
| Cruces resueltos por `resuelveCruces` | 4.505 (4.495 de dos calles y 10 parejas en 7 glorietas) |
| Cruces con ruta a los dos lados (cede/manda) | 3.905; el más oblicuo, a 32° (seno 0,53) |
| Glorietas con tráfico por el anillo | 2 de 7 |
| Vueltas retrasadas por el agua (ronda 2) | 7 rutas |
| Pasos de peatones dibujados | 15.296; 15.206 sobre una ruta |
| Grafo de aceras | 34 barrios, 38.471 aristas, 1.860 portales con acceso |
| Población (sin parcelas) | 29.527 personas, 135.820 viajes al día; 21.303 trabajan (en 12 barrios de oficinas) |
| Construcción de la población | 1.435–2.477 ms de una vez al cargar; al cambiar las parcelas, por trozos |
| Paradas de metro o autobús | 255 en los 34 barrios (7 u 8 por barrio) |

### Pruebas deterministas (`handle._debug.paso(dt)`), ronda 2

| Prueba | Resultado |
|---|---|
| Ceder: X por la que cede a 90 m de su línea, Y por la preferente a 100 m del cruce, los dos a 11 m/s (ruta 43 cede a la 48) | X se para con el morro a 0,47 m de la línea a los 8,8 s; arranca a los 9,5 s, cuando Y ha dejado atrás su carril (Y sale de la caja a los 10,1 s). Nunca pasa la línea antes. |
| Peatón en un paso: coche hacia el paso 274 (calzada 16 m) mientras lo cruza el peatón 1.302 | Se para con el morro a 1,47 m del borde del paso; el paso queda libre a los 15,2 s y arranca a los 15,4 s; el morro nunca pisa el paso ocupado. |
| Cruces oblicuos: los tres más oblicuos (32°) y uno recto, todas las parejas de carril y sentido, 7 desfases | 168 + 168 + 168 + 112 encuentros, 0 con solape; en todos pasan los dos; espera máxima 7,4 s. |
| Cesión en 240 encuentros forzados en 60 cruces «cede» (la prueba de la revisión, `cede.mjs`) | 0 solapes; el que cede se para en los 240 y ninguno pisa la línea; pasan los dos siempre; espera máxima 1,7 s. |
| La vuelta: troncal, arteria, calle de 15 m y de 10 m, los dos extremos, coches en fila | 0 solapes; hasta 18 girando a la vez; todos dada la vuelta a los 17–28 s. |
| Glorietas: 88 encuentros, y 32 con un coche parado en el anillo | 0 solapes; separación mínima 9,6 m; espera máxima 5 s. |
| Mismo peatón en el mismo T: 1.200 posiciones (400 por instante a las 8:15, 12:40:30,5 y 18:05:07,25) | Iguales al bit tras borrar cachés (también `V.dur`), tras reconstruir y en otro Chromium. |
| Por trozos frente a de una vez: 1.209 posiciones tras una reconstrucción por trozos y otra de una vez | 0 diferencias. |
| Suelo: cada 5 min de 5:00 a 24:00, todos los peatones en la calle (128.791 muestras) | 0 en el agua, 0 dentro de un edificio, 0 en la calzada fuera de un paso (2 antes del arreglo de `monta`); 8.922 en un paso, a 0,7 m como mucho de su eje; 27.690 esperando turno (21,5 %; en la ronda 1, 22,9 %). Espera media por viaje, 61,6 s (p90, 142 s). |
| Paradas y taxis: el extremo de uno de cada cinco viajes de metro o taxi (17.139) | 11.041 en el bordillo de una parada y 6.098 en el de delante del portal; 0 en la calzada, en el agua o en un edificio; 4 a más de 1,2 m de la calzada. Mediana del camino, 274 m (p90, 526). |
| Márgenes del genotipo (`huella`, seis reconstrucciones) | ±1 nm en x y z: huella igual; +1 µm en x, ±1 µm en z: igual; −1 µm en x: solo cambia el sitio en cm de un acceso. Margen mínimo de los redondeos a cm, 1,5 µm; del de km de la gravedad, 55 µm. |
| Economía con 12 parcelas sintéticas | 2.820 contratados (lo que suman sus plantillas con salida), 1.842 andando de puerta a puerta, 978 en metro o taxi; caminos que acaban a 0,002 m del portal. |
| Choque con un peatón / avatar ajeno encima | Empujado por `peaton` a 0,77 m / dibujado a 0,82 m, el jugador no se mueve. |
| Coches sobre el agua | Semicírculos de la vuelta: 0 de 243.300 puntos. Puntos de carril con `surfaceH` ≤ 0,6 entre los centros de vuelta: 451 de 3.795.512, todos sobre la cinta dibujada (`sueloCalle` da calzada; es donde la calle pasa por terreno bajo). Por eso las simulaciones de la zona 11 cuentan «agua» en la ruta 304: el coche va por la cinta. |

### Choques y atascos: 10 minutos simulados (ronda 2, `r2_solapes.mjs`)

Cada 0,5 s, las cajas de 4,6 × 2,0 m de todos los coches a menos de 700 m del
foco, dos a dos (ejes separadores); los peatones a menos de 500 m contra las
cajas (con 0,35 m); en cada paso, los ciclos de coches parados siguiendo
`causa`; los coches parados más de 60 s; y los coches que aparecen (se mueven
más de 40 m en un paso) dentro del campo de la cámara y de lo que se dibuja.
Paso de 0,1 s o de 1/30 s (con la simulación por cercanía). En órbita a 300 m
salvo «a pie». «g0» es la glorieta 0. Código final.

| Sitio, calidad, paso | Solapes | Contactos con peatones | Ciclo más largo | Parados > 60 s | Máximo parado | Aparecen a la vista (recolocados) | Válvulas | Desatascos |
|---|---|---|---|---|---|---|---|---|
| Bloques (zona 11), media, 0,1 | 0 | 0 | — | 0 | 22,5 s | 0 (4) | 0 | 0 |
| Torres (zona 6), media, 0,1 | 0 | 0 | 0,1 s | 0 | 40,8 s | 0 (125) | 8 | 0 |
| Naves (zona 33), media, 17:54, 0,1 | 0 | 0 | 0,1 s | 0 | 26,7 s | 0 (0) | 0 | 0 |
| Torres, ultra, 0,1 | 0 | 0 | 0,1 s | 0 | 41,5 s | 0 (351) | 218 | 0 |
| Torres, ultra, 0,1, otra vez | 0 | 0 | 0,1 s | 0 | 57,1 s | 0 (358) | 269 | 0 |
| g0, ultra, 0,1 | 0 | 0 | 0,1 s | 0 | 48,3 s | 0 (209) | 67 | 2 |
| Torres, ultra, 1/30 | 0 | 0 | 0,1 s | 0 | 50,4 s | 0 (341) | 456 | 0 |
| g0, ultra, 1/30 | 0 | 0 | 0,1 s | 0 | 49,4 s | 0 (213) | 61 | 0 |
| Bloques, ultra, 17:54, a pie, 1/30 | 0 | 0 | 0,1 s | 0 | 32,7 s | 0 (154) | 14 | 0 |
| Torres, ultra, 1/30, sin simulación por cercanía | 0 | 0 | 0,03 s | 0 | 39,9 s | 0 (358) | 325 | 0 |

Base de la integración (80067fa, reglas de la ronda 1), mismas pruebas en
ultra con paso de 0,1: torres, 0 solapes y 39,0 s de máximo parado, 60 válvulas;
g0, 0 solapes y 56,7 s, 101 válvulas. Las válvulas de esta ronda son más en el
barrio de torres (de 218 a 456): ahí la calle 213 cede a la troncal de seis
carriles por sentido y la cola avanza por la válvula; no hay ciclos (el más
largo, 0,1 s, es el artefacto de la actualización en orden) ni nadie pasa del
minuto. Los 2 desatascos de g0 son la red de seguridad: un ciclo que se cerró
con un coche ya parado 40 s.

### Coste de un paso (`coste.mjs`, ultra, órbita sobre la zona 6, 8:24, 30 s simulados)

| | dt = 1/60 (con simulación por cercanía) | dt = 1/29 (sin ella) |
|---|---|---|
| Todo | 4,62 ms | 5,76 ms |
| Solo peatones (sin coches) | 0,65 ms | 0,71 ms |
| Solo coches (3:30, sin peatones) | 3,38 ms (431 de 800 coches saltados por paso) | 4,64 ms |
| Nada (3:30, sin coches) | 0,13 ms | 0,18 ms |

A pie en el barrio de bloques (zona 11), 8:24, con dt = 1/60 y dt = 1/29, frente
a la base de la integración (80067fa) medida igual:

| | ultra, 1/60 | ultra, 1/29 | media, 1/60 | media, 1/29 | base, ultra, torres, 1/60 | base, media, bloques, 1/60 |
|---|---|---|---|---|---|---|
| Todo | 4,34 ms | 7,20 ms | 1,99 ms | 2,32 ms | 5,16 ms | 2,90 ms |
| Solo peatones | 0,62 ms | 0,60 ms | 0,54 ms | 0,52 ms | 1,17 ms | 0,91 ms |
| Solo coches | 4,03 ms (469 saltados por paso) | 5,30 ms | 1,24 ms (129 saltados) | 1,54 ms | 4,74 ms | 1,56 ms |

Máquina compartida (carga de 7 a 9 durante las medidas): las cifras varían en un
10–20 % de una ejecución a otra; la proporción entre columnas se mantiene.

### Presupuesto

A pie junto al paso 2463 (zona 6), a las 8:18, por calidad (`fotos.mjs`,
`vida_r2_pr_a_pie_*.png`; mismo método que en la ronda 1, en otro paso):

| Calidad | Triángulos | Llamadas | Peatones dibujados (en la calle cerca) | Sus triángulos | Coches vivos |
|---|---|---|---|---|---|
| baja | 747.060 | 12 | 0 (sin grafo) | 0 | 0 |
| media | 888.470 | 30 | 34 (223) | 8.648 | 240 |
| alta | 954.421 | 34 | 49 (223) | 12.194 | 480 |
| ultra | 1.039.861 | 34 | 59 (223) | 14.434 | 800 |

Un peatón cuesta de 245 a 254 triángulos (los que están a menos de 80 m llevan
brazos y piernas); un coche, 260. Las siete mallas de los peatones son siete
llamadas cuando hay alguien a menos del radio y ninguna cuando no.

A/B de los encuadres fijos (a las 11:00, `ab.mjs`) contra la referencia de la
integración (`referencia_integ_ab.json`, 80067fa):

| Encuadre | Integración 80067fa | vida ronda 2 | Diferencia |
|---|---|---|---|
| torres_cerca | 909.372 · 29 | 947.332 · 29 | +37.960 · 0 |
| bloques_manzana | 798.932 · 28 | 798.544 · 28 | −388 · 0 |
| villas | 966.820 · 22 | 971.126 · 24 | +4.306 · +2 |
| naves | 1.058.812 · 32 | 1.059.072 · 31 | +260 · −1 |
| a_pie_manzana | 978.500 · 39 | 981.330 · 39 | +2.830 · 0 |
| a_pie_torre | 819.110 · 24 | 826.650 · 24 | +7.540 · 0 |
| ciudad_entera | 1.807.624 · 101 | 1.807.624 · 101 | 0 · 0 |
| centro | 1.534.718 · 51 | 1.542.258 · 52 | +7.540 · +1 |

La diferencia es casi toda de coches: con el límite de 1,5 píxeles se dibujan
todos los coches vivos cuando la cámara está a menos de unos 2,4 km de ellos.
Contados aparte (`abvida.mjs`, mismos encuadres, la base de la integración y
esta ronda): torres_cerca, 27 → 240 coches; villas, 108 → 240; naves, 96 →
240; a_pie_torre, 111 → 240; centro, 0 → 35; ciudad entera, 0 → 0 (ningún coche
llega a 1,5 píxeles). Cada coche son 260 triángulos en la misma llamada. Los
peatones apenas cuentan en estos encuadres de las 11:00: en villas, 2 dibujados
(496 triángulos; la base, 1); en los demás, ninguno. Las llamadas de más o de
menos (villas +2, naves −1, centro +1) cambian de una ejecución a otra con la
hora de cada foto y lo que hay a la vista.

## Capturas

Ronda 2 (todas miradas):

- `/tmp/ramiverif/vida_r2_cruce_orbita.png`: órbita a 40 m sobre el paso 2336
  (zona 6, 8:18): dos coches parados en su carril antes del paso y un peatón
  terminando de cruzar.
- `/tmp/ramiverif/vida_r2_cruce_a_pie.png`: a pie en la acera junto al mismo
  paso: los dos coches parados ante él y un peatón en el borde derecho. (Al pasar
  de la órbita a pie se apunta el foco nuevo en el tráfico para que la prueba no
  cuente como un salto y no recoloque a todos.)
- `/tmp/ramiverif/vida_r2_centro_a_pie_1245.png` y `vida_r2_centro_a_pie_0830.png`:
  el centro (zona 0), a pie, donde más gente hay a las 12:45 y a las 8:30: gente
  por la acera (en la ronda 1, nadie en todo el día).
- `/tmp/ramiverif/vida_r2_vuelta_ruta138.png`: a pie junto al final de la ruta
  138, con la costa a la derecha: los coches llegan a la vuelta por la calzada;
  la vuelta está retrasada 5 m y su semicírculo exterior pisa suelo de 0,61 a
  1,00 m (antes, agua).
- `/tmp/ramiverif/vida_r2_pr_a_pie_{baja,media,alta,ultra}.png`: el presupuesto.
- `/tmp/ramiverif/vida_r2_ab_*.png`: los encuadres fijos (en torres_cerca y en
  el centro, los coches son puntos sobre las calles).

Ronda 1: `/tmp/ramiverif/vida_r1_*.png` (cruce, vuelta en la troncal, cruce
oblicuo, paradas, presupuesto y encuadres fijos).

## Lo que queda

- **Las rutas no se enlazan entre sí.** Al final de cada una el coche da la
  vuelta por el semicírculo de su carril; en el borde de cada barrio y del mapa
  se ve dar la vuelta a filas enteras. En 5 de las 7 glorietas las vías del mapa
  llegan partidas en dos y los coches dan la vuelta antes de la entrada, sin
  pasar por el anillo. Enlazarlas es un grafo de rutas con giros en los cruces.
- **Tramos tapados**: 11.485 m van montados sobre otra vía casi paralela; no
  llevan tráfico, pero se siguen dibujando encima de la otra calzada: cortarlos
  es trabajo de `tramaBarrio`/`buildRoads` y cambia el dibujo de 78 vías.
- **Cruces oblicuos**: la cinta de la calle que cede se corta en perpendicular y
  queda un triángulo de arena por el que pasan algunos carriles.
- **Los coches no son deterministas** (ni lo eran): cada máquina ve su tráfico.
  Los peatones sí lo son. La simulación de coches tampoco es repetible de una
  ejecución a otra en la misma máquina (el plazo de los caminos depende del
  reloj): por eso las cifras de las tablas varían entre ejecuciones.
- **Recolocar y desatascar siguen siendo saltos**, ahora fuera de la vista; el
  desatasco quita del sitio al coche del ciclo que no se ve (o al más lejano).
- **El determinismo entre motores** está probado solo en Chromium; la prueba de
  márgenes dice que un último bit distinto en Math.sin o Math.cos no cambia el
  genotipo de los peatones, pero la geometría de la ciudad del núcleo (edificios,
  calles, relieve) también sale de Math.sin y Math.cos y no está medida en otro
  motor.
- **Densidad**: en hora punta hay unas 1.100–1.400 personas en la calle en toda
  la ciudad (de 29.527) y en muchos encuadres a pie nadie a menos de 150 m (en
  los de `ab.mjs`, a las 11:00, ninguno). La calle se llena alrededor de las
  paradas, de los pasos y de los barrios de oficinas a la entrada, a la comida y
  a la salida.
- **Sin parcelas nadie va andando al trabajo** (ver «Metro o taxi»). No hay
  aceras entre barrios ni a lo largo de las vías del mapa: los peatones solo
  existen en los 34 barrios con trama; la zona 24 (5 edificios) no tiene ningún
  portal con acera. No hay parada dibujada: es un sitio del bordillo.
- De los portales de los edificios de barrio, 522 no encuentran un camino recto
  libre a la acera: esos edificios no tienen vecinos que salgan a la calle.
- El 0,6 % de los viajes (108 de 19.340 en la muestra) se quedan sin camino y
  ese día no se ven.
- La primera construcción de la población (al cargar) sigue siendo de una vez:
  de 1,4 a 2,5 s dentro de la carga del visor, sin precalentado (los caminos se
  llenan con el plazo de cada cuadro).
- El semáforo no existe: la cesión es de ceda el paso en todos los cruces, con
  la cortesía y la válvula de 30 s; en una calle que cede a la troncal, la cola
  avanza por la válvula (hasta 456 válvulas en 10 min en ultra).
- Probado solo en Chromium con SwiftShader; sin cifras de fluidez de una
  tarjeta real. Con cuatro CPU compartidas, los pasos de más de 50 ms de las
  simulaciones dependen de la carga de la máquina: en 10 min de ultra (torres,
paso de 0,1 s, carga 9), 9 pasos de más de 50 ms, el más largo de 203 ms; con
tres simulaciones a la vez, hasta 342.
