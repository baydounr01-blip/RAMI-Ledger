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
   cada ruta quedan los cruces con otra ruta (4.049 con ruta a los dos lados) y
   si cede o manda. El que cede se para con el morro en la línea de detención si
   por la preferente viene alguien que alcanzaría la calzada antes de que él la
   haya dejado atrás desde parado (la ventana: √(2·d/3 m/s²) + 0,8 s, con d de la
   línea al otro lado de la calzada con el coche entero), o si hay alguien en la
   caja. La glorieta se recorre por el anillo, con la isla a la izquierda, y se
   cede al que va por él y pasará por la entrada; dentro del anillo cada coche
   guarda la distancia con el que lleva delante, sea de la vía que sea. Una ruta
   no acaba dentro de una glorieta: el coche da la vuelta antes de la entrada.
   Frenado con el perfil de deceleración constante que ya existía.
4. **Sin bloqueos.** Tres reglas y una válvula: un coche no entra en una caja si
   el de delante está parado justo al otro lado (`cajaTapada`) o si el paso de
   peatones de la salida está ocupado (`salidaTapada`); la preferente no entra en
   una caja ocupada; un coche PARADO en la preferente fuera de la caja no cuenta
   como que llega. La válvula: tras 30 s parado ante el mismo cruce, el coche se
   mete (la preferente frena por él). Cada coche apunta en `causa` el coche que
   lo frena; en 72.000 pasos de simulación con hasta 800 coches, con y sin
   válvula, no apareció ni un ciclo de esperas (tabla abajo).
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
  los pasos ocupados, el final de la ruta; `c.motivo` guarda lo que más lo frena
  y `c.causa` el coche que lo frena (el de delante, el que tiene preferencia, el
  que ocupa la caja o el que va delante en el anillo), o null si es un peatón,
  el jugador o nada.
  `poseCoche` da la posición con la misma tangente suavizada a 45 m que la cinta
  (el carril cae en el pintado también en los codos) y, dentro de la cuerda de
  una glorieta, por el anillo (sentido horario visto desde arriba; el radio se
  funde con el del carril en los extremos; la velocidad por la ruta se escala por
  cuerda/arco para que por el anillo vaya a su velocidad). Se dibujan los coches
  a menos de 1,4·R_VIVO de la cámara (`mesh.count`).
- **`debeCeder`**, **`debeCederAnillo`**, **`cajaTapada`** (devuelven el coche
  que obliga, o null), **`salidaTapada`**, **`delanteEnAnillo`**: las reglas de
  arriba. La ventana se precalcula por cruce. `CEDE_PACIENCIA` = 30 s.
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
  calle del metro, el sitio de la comida) se guardan como un sorteo entero y se
  resuelven al pedir el camino.
- **Metro o taxi**: si el trabajo no está en la misma trama o queda a más de
  1.200 m por la retícula (Manhattan en metros enteros), el peatón sale de casa
  hacia un nodo a 150–450 m por la acera y desaparece; tras 15–40 min aparece en
  un nodo a 120–400 m de su trabajo y llega andando. Una parcela fuera de toda
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
sin pantalla con SwiftShader, calidad media salvo donde se dice. Los scripts
de prueba están fuera del repositorio (arnés de /tmp); sus resultados, en
`/tmp/ramiverif/vida_*.json`.

### Lo que se construye

| | cifra |
|---|---|
| Rutas de tráfico (tramos vivos de 120 m o más) | 852 (antes 21 vías) |
| Rutas por calzada y carriles por sentido | 42 m: 9 con 6 · 26 m: 17 con 3 · 15/16/18 m: 319 con 2 · 13 m: 287 con 2 · 10 m: 220 con 1 |
| Cruces resueltos por `resuelveCruces` | 4.505 (4.495 de dos calles y 10 parejas en 7 glorietas) |
| Cruces con ruta a los dos lados (cede/manda) | 4.049 |
| Glorietas con tráfico por el anillo (dos vías que la atraviesan) | 2 de 7 |
| Pasos de peatones dibujados | 15.296 (7.908 antes); 15.206 sobre una ruta |
| Grafo de aceras | 34 barrios, 38.468 aristas, 1.802 portales con acceso |
| Población (sin parcelas) | 28.470 personas, 130.792 viajes al día |
| Construcción de la población | 920–1.740 ms (una vez, al cargar y al cambiar las parcelas) |
| Coste de un paso de simulación (tráfico + peatones, hora punta, media) | 1,29 ms |

### Pruebas deterministas (`handle._debug.paso(dt)`)

| Prueba | Resultado |
|---|---|
| Ceder: X por la que cede a 90 m de su línea, Y por la preferente a 100 m del cruce, los dos a 11 m/s (ruta 39 cede a la 44, calzadas de 16 m, ventana 5,15 s) | X se para con el morro a 0,47 m de la línea a los 8,8 s; Y cruza a los 10,1 s; X arranca a los 10,4 s y cruza. Nunca pasa la línea antes. |
| Peatón en un paso: coche hacia el paso 834 (calzada 16 m) mientras lo cruza el peatón 24.142 | Se para con el morro a 1,47 m del borde del paso; el paso queda libre a los 17,7 s y arranca a los 17,9 s; el morro nunca pisa el paso ocupado. |
| Glorietas: 88 encuentros (X entra, Y va por el anillo, cuatro sentidos, 11 desfases) | X cede en 42; ninguna caja (4,5 × 1,9 m, ejes separadores) se monta en otra; X sale siempre; espera máxima 4,4 s. |
| Anillo con un coche parado y otro de la otra vía que entra detrás: 32 casos | El de detrás frena por el de delante en 20 (en los demás no se cruzan); 0 solapes (antes del recorte de rutas en las glorietas: 4 de 64, por el salto de la vuelta dentro del anillo). |
| Mismo peatón en el mismo T: 1.200 posiciones (400 por instante a las 8:15, 12:40:30,5 y 18:05:07,25) | Iguales al bit tras borrar cachés, tras reconstruir la población entera y en otro Chromium. |
| Suelo: cada 5 min de 5:00 a 24:00, todos los peatones en la calle (141.291 muestras) | 0 en el agua, 0 dentro de un edificio (`ctx.catastro.bajo`), 0 en la calzada fuera de un paso; 8.554 en un paso, a 0,7 m como mucho de su eje; 29.833 esperando turno en el bordillo. |
| Agua (pendiente a): ejes de las rutas cada 10 m | 24 de 155.149 puntos sobre el agua (8 rutas, en el borde de un corte, entre dos filas de la cinta); con las vías del mapa de punta a punta, 1.201 de 46.553. 123 vías cortadas por el agua. |
| Choque con un peatón (jugador de 0,42 m encima de uno) | Sale empujado por `peaton` a 0,77 m (0,42 + 0,35). |
| Avatar ajeno encima del jugador (pendiente c) | Aparece a 0,10 m; se dibuja apartado 0,72 m, a 0,82 m del jugador; el jugador no se mueve; su posición de red no cambia. |
| Economía: 12 parcelas sintéticas junto a barrios de viviendas | 19.996 de 27.700 personas trabajan en ellas; 2.105 andan de puerta a puerta, 17.891 en metro o taxi; los caminos acaban a 0,002 m del portal de su parcela; todas las parcelas con salida reciben su llegada (antes de buscar la puerta del taxi por las cuatro fachadas, 8.006 de 9.164 trabajadores de parcelas sueltas no llegaban). |

### Atascos: 10 minutos simulados a las 8:15 (hora punta), `paso(0,1)` × 6.000

Cada coche apunta en `causa` el coche que lo frena. Un bloqueo mutuo es un
ciclo de coches parados siguiendo `causa`; la prueba lo busca en cada paso.

| Sitio, calidad (coches) | Válvula | Parados más de 60 s | Máximo parado | Ciclos de espera | Válvulas | Parados más de 120 s al final |
|---|---|---|---|---|---|---|
| Barrio de torres, media (240) | sin | 16 | 109,8 s | 0 | 0 | 0 |
| Barrio de torres, ultra (800) | sin | 113 | 212,2 s | 0 | 0 | 0 |
| Glorieta 0, media (240) | sin | 0 | 48,7 s | 0 | 0 | 0 |
| Glorieta 0, ultra (800) | sin | 82 | 170,8 s | 0 | 0 | 0 |
| Barrio de torres, media (240) | 30 s | 0 | 49,5 s | 0 | 89 | 0 |
| Barrio de torres, ultra (800) | 30 s | 0 | 45,8 s | 0 | 445 | 0 |
| Glorieta 0, media (240) | 30 s | 0 | 44,7 s | 0 | 29 | 0 |
| Glorieta 0, ultra (800) | 30 s | 0 | 51,6 s | 0 | 353 | 0 |

Sin válvula, de los coches que pasan de un minuto parados, la cadena de
`causa` acaba en un coche en marcha en 208 de 211 (y en un peatón en 3):
esperan un hueco en una preferente con tráfico continuo, no a otro parado.
Con 45 s de válvula quedaban 2 coches de más de 60 s en el barrio en ultra; con
30 s, ninguno en los cuatro casos.

### Presupuesto

A pie junto al paso de las capturas, a las 8:18 (hora punta), por calidad:

| Calidad | Triángulos | Llamadas | Peatones dibujados (en la calle cerca) | Sus triángulos | Coches (vivos) |
|---|---|---|---|---|---|
| baja | 797.354 | 12 | 0 (0: sin grafo) | 0 | 0 |
| media | 980.824 | 24 | 43 (239) | 11.414 | 240 |
| alta | 1.048.008 | 24 | 63 (240) | 15.990 | 480 |
| ultra | 1.137.344 | 24 | 89 (239) | 22.126 | 800 |

Un peatón cuesta de 249 a 265 triángulos en estas capturas (los que están a
menos de 80 m llevan brazos y piernas); un coche, 260. Las siete mallas de los peatones son siete
llamadas cuando hay alguien a la vista y ninguna cuando no (`visible = false`
con cero instancias; three.js cuenta la llamada igual si no).

A/B de los encuadres fijos (a las 11:00, `ab.mjs`) contra la referencia de la
v0.10.16:

| Encuadre | v0.10.16 | vida | Diferencia | Peatones / coches dibujados |
|---|---|---|---|---|
| torres_cerca | 920.678 · 21 | 896.498 · 21 | −24.180 · 0 | 0 / 88 |
| bloques_manzana | 790.042 · 17 | 783.040 · 24 | −7.002 · +7 | 7 / 240 |
| villas | 959.508 · 15 | 970.810 · 16 | +11.302 · +1 | 1 / 240 |
| naves | 1.014.414 · 21 | 1.025.414 · 21 | +11.000 · 0 | 0 / 240 |
| a_pie_manzana | 952.544 · 28 | 961.416 · 31 | +8.872 · +3 | 5 / 240 |
| a_pie_torre | 802.440 · 17 | 810.408 · 17 | +7.968 · 0 | 0 / 240 |
| ciudad_entera | 1.748.908 · 86 | 1.720.858 · 85 | −28.050 · −1 | 0 / 0 |
| centro | 1.532.854 · 42 | 1.493.396 · 41 | −39.458 · −1 | 0 / 0 |

Los coches se reparten ahora alrededor de quien mira y se dibujan a menos de
1,4·R_VIVO de la cámara: en los encuadres de la ciudad entera y del centro no
se dibuja ninguno (antes, de los 120 coches de 484 triángulos repartidos por
las autovías, los que cayeran a la vista), y en los de barrio van 240 de 260
triángulos (62.400, frente a 58.080 de los 120 de antes). La llamada de más en villas y las siete en
bloques_manzana son las mallas de los peatones.

## Capturas

- `/tmp/ramiverif/vida_f_cruce_a_pie.png`: a pie en la acera, a las 8:18; dos
  coches parados ante el paso y dos peatones cruzándolo.
- `/tmp/ramiverif/vida_f_cruce_orbita.png`: el mismo cruce en órbita cercana
  (40 m): los coches parados en sus carriles ante el paso, peatones en los pasos
  y en las aceras.
- `/tmp/ramiverif/vida_f_cruce_a_pie_2.png`: a pie en la calzada junto a los
  coches parados.
- `/tmp/ramiverif/vida_pr_a_pie_{baja,media,alta,ultra}.png`: el presupuesto.
- `/tmp/ramiverif/vida_ab_*.png`: los encuadres fijos.

## Lo que queda

- **Las rutas no se enlazan entre sí.** Al final de cada una el coche da la
  vuelta en el sitio (frena a 3,5 m/s y cruza al carril simétrico); en el borde
  de cada barrio y del mapa se ve. En 5 de las 7 glorietas las vías del mapa
  llegan partidas en dos y los coches dan la vuelta antes de la entrada, sin
  pasar por el anillo. Enlazarlas es un grafo de rutas con giros en los cruces.
- **Los coches no son deterministas** (ni lo eran): cada máquina ve su tráfico.
  Los peatones sí lo son.
- **Sin parcelas nadie va andando al trabajo** (ver «Metro o taxi»); tampoco hay
  aceras entre barrios ni a lo largo de las vías del mapa: los peatones solo
  existen en los 34 barrios con trama.
- De los portales de los edificios de barrio, 522 no encuentran un camino recto
  libre a la acera (145 sin lado de manzana con arista, 252 con un edificio en
  medio, 105 a más de 120 m, 13 por agua, 7 por calzada): esos edificios no tienen
  vecinos que salgan a la calle.
- Un 1,2 % de los viajes se queda sin camino (en la muestra, 230 de 18.806: la
  comida o el recado sin un portal entre 80 y 450 m, o el nodo del metro sin
  nada a mano) y ese día no se ve.
- 24 puntos de ruta sobre el agua en el borde de 8 cortes (arriba).
- El semáforo no existe: la cesión es de ceda el paso en todos los cruces, con
  la válvula de 30 s. En ultra, 445 válvulas en 10 minutos en el barrio de
  torres: el coche que se mete obliga a frenar a la preferente.
- Probado solo en Chromium con SwiftShader; sin cifras de fluidez de una
  tarjeta real.
