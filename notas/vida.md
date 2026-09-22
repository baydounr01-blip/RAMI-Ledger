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
   de cada vía (las del mapa y las 756 de la trama) es una ruta: 852 rutas. Al
   final de una ruta el coche frena a 3,5 m/s y da la vuelta al carril simétrico
   (antes reaparecía en el otro extremo de la vía).
3. **Cesión de paso.** `resuelveCruces` apunta cada cruce en `S.cruces`; sobre
   cada ruta quedan los cruces con otra ruta (4.052 con ruta a los dos lados) y
   si cede o manda. El que cede se para con el morro en la línea de detención si
   por la preferente viene alguien que alcanzaría la calzada antes de que él la
   haya dejado atrás desde parado (la ventana: √(2·d/3 m/s²) + 0,8 s, con d de la
   línea al otro lado de la calzada con el coche entero), o si hay alguien en la
   caja. La glorieta se recorre por el anillo, con la isla a la izquierda, y se
   cede al que va por él y pasará por la entrada. Frenado con el perfil de
   deceleración constante que ya existía.
4. **Sin bloqueos.** Tres reglas y una válvula: un coche no entra en una caja si
   el de delante está parado justo al otro lado (`cajaTapada`) o si el paso de
   peatones de la salida está ocupado (`salidaTapada`); la preferente no entra en
   una caja ocupada; un coche PARADO en la preferente fuera de la caja no cuenta
   como que llega. La válvula: tras 45 s parado ante el mismo cruce, el coche se
   mete (la preferente frena por él). Pruebas abajo, con y sin válvula.
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
   1,2–1,6 m/s. Radio andable: 1.200 m por la retícula; más lejos, metro o taxi
   (ver abajo).
7. **Dibujo**: mallas instanciadas con `avatarBodyGeometry`/`avatarLimbGeometry`
   en su variante ligera, cuatro estilos, colores por semilla, balanceo al andar,
   quietos mientras esperan su turno en el bordillo. Tope y radio por calidad:
   baja 0; media 300 a 260 m; alta 800 a 420 m; ultra 1.500 a 650 m. Brazos y
   piernas solo a menos de 80 m. Sin sombras en baja y media. Sin rótulos.
8. **Colisión**: el jugador no atraviesa a los peatones (gancho `empujar`,
   círculo de 0,35 m).
9. **Pendientes de la calle**: (a) la ruta de los coches se corta donde se corta
   la cinta; (b) las aceras de barrio existían desde la v0.10.6, lo que faltaba
   era pisarlas (ver «Arreglos»); (c) el avatar ajeno que se solapa con el
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
- **`buildTrafficPaths`**: una ruta por tramo vivo de 120 m o más; `conf` (los
  cruces ordenados por `t`: `cede` con su línea y su ventana, `manda` con su caja,
  `gl`), `cebras`, `anillos`, `carriles`, `vmax`; y `S.rutaCeldas`, rejilla de
  400 m para colocar coches cerca de la cámara.
- **`buildTraffic`**: `R_VIVO = 1000·√(coches/240)` (1.000 m en media, 1.414 en
  alta, 1.826 en ultra: la misma densidad en todas); `colocaCoche` sortea ruta
  (peso = largo × carriles), punto, sentido y carril con la serie `lcg(4242)`.
  Carrocería ligera (`carGeometry(true)`, 260 triángulos).
- **`updateTraffic`**: recoloca por turnos los coches a más de 1,3·R_VIVO del
  foco; `ordenaColas` da el de delante por ruta, sentido y carril (y las listas
  por ruta y por glorieta); por coche: el jugador (esquivar o frenar), los cruces
  por delante en orden (el primero en que haya que pararse corta la búsqueda),
  los pasos ocupados, el final de la ruta; `c.motivo` guarda lo que más lo frena.
  `poseCoche` da la posición con la misma tangente suavizada a 45 m que la cinta
  (el carril cae en el pintado también en los codos) y, dentro de la cuerda de
  una glorieta, por el anillo (sentido horario visto desde arriba; el radio se
  funde con el del carril en los extremos; la velocidad por la ruta se escala por
  cuerda/arco para que por el anillo vaya a su velocidad). Se dibujan los coches
  a menos de 1,4·R_VIVO de la cámara (`mesh.count`).
- **`debeCeder`**, **`debeCederAnillo`**, **`cajaTapada`**, **`salidaTapada`**:
  las reglas de arriba. La ventana se precalcula por cruce.
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
  y vuelta a pie; comida (55 % de los que trabajan); recados (quien no trabaja);
  paseo de noche (12 %); madrugada (2 %). Los destinos que dependen del grafo (la
  calle del metro, el sitio de la comida) se guardan como un sorteo entero y se
  resuelven al pedir el camino.
- **Metro o taxi**: si el trabajo no está en la misma trama o queda a más de
  1.200 m por la retícula (Manhattan en metros enteros), el peatón sale de casa
  hacia un nodo a 150–450 m por la acera y desaparece; tras 15–40 min aparece en
  un nodo a 120–400 m de su trabajo y llega andando. Una parcela fuera de toda
  trama se alcanza desde la puerta del taxi, de 40 a 70 m delante del portal
  (lo más lejos que esté libre).
- **Turnos de los pasos**: cada paso tiene un ciclo de 60 s desfasado por paso
  (`mezcla(id, 97) % 60`) y en sus primeros 15 s se empieza a cruzar; quien llega
  fuera de turno espera en el bordillo. Es una función del tiempo (la llegada al
  paso lo es), así que la espera también. Sin esto, en hora punta un paso
  concurrido tenía gente encima minutos seguidos y los coches no pasaban.
  `horario` deja en cada camino las esperas y cuándo se pisa y se deja cada paso;
  un paso cuenta como ocupado desde 4 s antes de pisarlo.
- **Reloj**: el de Dubái (UTC+4) en segundos del día; con la hora fijada en el
  visor corre desde esa hora; `fijaReloj(T)` para las pruebas.
- **Cada cuadro**: las zonas a menos de 1.600 m del foco + su radio; por zona,
  búsqueda binaria de los viajes que salieron en los últimos `DMAX` segundos
  (2.500 + 1.200 de esperas); los que están en la calle marcan sus pasos y, si
  están a menos del radio de la calidad de la cámara, se dibujan los más
  cercanos hasta el tope.
- **Reconstrucción**: en `listo`, y en `ciudad` solo si cambia la firma (sitio,
  sector y plantilla de cada parcela, y los edificios ocultos); los ingresos
  crecen cada bloque y no entran en la firma. En calidad baja no hay peatones y
  el grafo no se hace (el catastro de baja tiene el 40 % de los edificios).

## Cifras medidas

Panel real (binario base de la v0.10.16 + proxy con este JavaScript), Chromium
sin pantalla con SwiftShader, calidad media salvo donde se dice.

(las tablas, más abajo)
