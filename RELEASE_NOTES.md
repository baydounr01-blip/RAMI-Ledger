## Novedades de v0.10.16 — el catálogo de fachadas, y la entrega 4 cerrada

Termina la entrega 4 del plan del metaverso (`docs/METAVERSO.md`, «TRAMA: la
manzana y la fachada»). **No toca el consenso, la red, el nodo ni el formato de
los ficheros**: todo el cambio está en el cliente 3D.

- **El catálogo de fachadas.** Cuatro fachadas en el sombreador de edificios:
  la **retícula** de oficina (huecos de 4,5 por 3,6 m, la única que había), la
  **lisa** sin ventanas (villas, naves, granjas, depósitos, paneles, taxis), el
  **muro cortina** (paños de cristal de 1,5 m con montantes finos, forjado
  apenas marcado, más reflejo) y la **ventana corrida** (una cinta de cristal
  de fachada a fachada por planta). Cuál lleva cada edificio sale de su
  morfología —el tercer sorteo del canal 11 en los barrios, el canal 15 de la
  celda en las parcelas—, así que dos máquinas ven la misma fachada. En Dubái:
  285 torres de muro cortina, 271 de retícula y 131 de cinta; 532 bloques de
  retícula y 283 de cinta; 830 villas y 720 naves lisas. En las parcelas, la
  torre es cortina o retícula, el hotel y la clínica cinta o retícula, el
  concesionario siempre cortina, el comercio y el gimnasio cinta o liso.
- **El plano de los barrios ya conoce las parcelas.** Se hacía al cargar el
  mapa, antes de la ciudad, y un edificio de barrio podía quedar dentro del de
  una parcela comprada. Ahora cada edificio de barrio sabe en qué celda cae, y
  cuando llega la ciudad los que se montan sobre el edificio de una parcela se
  ocultan —y salen del catastro— mientras esa parcela tenga edificio; si la
  parcela desaparece, vuelven. Las mallas solo se rehacen cuando cambia
  alguno. Probado con tres parcelas puestas en las tres celdas con más
  edificios de barrio (33, 27 y 25): se ocultan 6, los que chocan, y no queda
  ninguno montado; sin las parcelas, los 3.052 de vuelta.
- **La torre de la parcela es esbelta.** Pasa de 109 m de lado y 133 de alto a
  69 m de lado y unos 220 m de alto (esbeltez 3,1), sin mover el resto de los
  sectores. El rótulo y el catastro siguen la nueva altura.
- **Los fantasmas del multiverso** tienen la planta que tendría el edificio
  real de esa celda (los mismos canales 13 y 14) y van en una malla por tesela
  del color de su estado; las catorce mallas instanciadas de arquetipo
  desaparecen del todo. El rótulo «⟂» cuelga sobre su coronación.

**Lo que cuesta.** Medido con los mismos encuadres en el binario de la v0.10.15
y en este: los ocho encuadres —torres de cerca, manzana de bloques, villas, naves, a pie en la manzana, ante una torre, la ciudad entera y el centro— dan exactamente los mismos triángulos y las mismas llamadas (920.678, 790.042, 959.508, 1.014.414, 952.544, 802.440, 1.748.908 y 1.532.854): la ciudad real no tiene parcelas y los barrios no cambian. El catálogo de fachadas es un cambio de sombreador: ningún
triángulo más.

**Cómo se ha comprobado.** Panel real en Chromium sin pantalla, cero errores:
recuento de fachadas por tipo de barrio; tres parcelas sobre las celdas con más
edificios de barrio (6 ocultos, 0 montados, catastro con exactamente los
dibujados en «baja» —1.220— y en «media» —3.046—, y los 3.052 de vuelta al
quitarlas); tres fantasmas, uno de ellos `solo_aqui` que no se dibuja (una
malla, 228 triángulos, color del estado en los vértices, dos rótulos); la torre
esbelta (221 m, media huella 34,6 m) junto al hotel; y fotos a pie, de frente y
a 38 m, de una torre de muro cortina, otra de retícula y un bloque de cinta.
`cargo test` (137), compatibilidad v0.7.0, inventario, i18n, panel y léxico.

**Con esto se cierra la entrega 4** (planta, fachada, coronación, portal y
rótulo). Lo que sigue es la entrega 5, «el umbral y el apartamento»: cruzar el
portal sin pantalla de carga.

## Novedades de v0.10.15 — los edificios de las parcelas, y ninguno sobre otro

Sigue la entrega 4 del plan del metaverso (`docs/METAVERSO.md`, «TRAMA: la
manzana y la fachada»). **No toca el consenso, la red, el nodo ni el formato de
los ficheros**: todo el cambio está en el cliente 3D.

- **Los edificios de las parcelas —los del jugador— salen del mismo catálogo
  que los de los barrios.** Hasta ahora eran catorce arquetipos por sector,
  cajas instanciadas y estiradas con la esbeltez; ahora la torre del sector
  financiero es lámina, podio y torre, escalonada, en L o gemelas; el hotel, la
  clínica, el comercio y el concesionario son bloques con planta; la nave
  industrial lleva bóveda o casetones y muelle; y todos tienen coronación —peto,
  cuarto de máquinas, antena en las torres de más de 150 m— y **portal hacia el
  frente de la parcela** (el lado +y de la cuadrícula, por donde se llega a pie).
  Cuál le toca a cada parcela sale **solo de su celda** (`semillaMorfologia`,
  canales 13 y 14): dos máquinas deducen el mismo edificio. Cada sector conserva
  sus piezas propias —la piscina del hotel, la chimenea y la grúa, los paneles,
  los depósitos, el silo, la cruz, la cúpula, el cono y la bandera, los taxis,
  el mástil—, que ya no se tiñen del color del sector: solo el cuerpo lo lleva.
  Se escriben en metros en una malla por tesela de ocho kilómetros, como los de
  los barrios, con la cota del pie y el atributo «sin ventanas» para naves,
  granjas, depósitos, paneles y taxis. El catastro los tiene como sólidos de tipo
  `parcela` con el nombre de la empresa: al pasar el ratón por encima o chocar
  con ellos a pie se sabe cuál es.
- **Ningún edificio de barrio se planta sobre otro ni sobre un hito.** La
  colocación dentro del barrio rechazaba solo la calle; ahora rechaza también
  las huellas ya ocupadas (`huellaLibre`: dos círculos envolventes que se montan
  más de un quinto). Cada edificio aceptado se da de alta en el catastro al
  momento, así que el siguiente ya lo ve. En Dubái son 695 posiciones
  rechazadas y 54 edificios menos (3.106 → 3.052): los barrios que agotan sus
  intentos se quedan con menos. Quedan **cero** solapes con ese criterio. Como
  la serie del barrio sigue tras cada rechazo —igual que hacía ya con la
  calle—, los edificios posteriores a un rechazo dentro del mismo barrio cambian
  de sitio respecto a la v0.10.14.
- **La calidad «baja» ya no choca con lo que no se ve.** El catastro se rehace
  con exactamente los edificios dibujados: 1.221 edificios y 1.221 sólidos de
  barrio en «baja», 3.052 y 3.052 en «media». Venía de la v0.10.3.

**Lo que cuesta.** Medido con los mismos encuadres en el binario de la v0.10.14
y en este: torres de cerca 925.438 → 920.678; manzana de bloques 789.410 →
790.042; naves 1.014.894 → 1.014.414; a pie en la manzana 952.312 → 952.544;
ante una torre 806.004 → 802.440; villas 926.780 → 959.508 (una tesela más
entra en el encuadre: 14 → 15 llamadas); la ciudad entera 1.753.464 →
1.748.908 con las mismas 86 llamadas, y el centro 1.533.338 → 1.532.854. Las
mallas de los barrios suman 328.388 triángulos (332.944 en la v0.10.14);
treinta parcelas sintéticas, 5.044 triángulos en dos teselas.

**Cómo se ha comprobado.** Panel real en Chromium sin pantalla, cero errores:
recuento de barrios con los solapes que quedan (cero), rechazos por huella y
teselas; el catastro en «baja» y de vuelta en «media»; una ciudad sintética de
treinta parcelas, una por sector, en dos filas: dos teselas, treinta sólidos de
tipo `parcela`, el sondeo del suelo bajo la torre devuelve «Empresa 0» con su
altura, los dos rótulos a 148 y 121 m; fotos de la fila entera, de la torre,
del hotel con su piscina, de una nave con chimenea y grúa, de la escuela y la
clínica, y a pie ante el portal de la torre (vidriera, puerta y marquesina) y
mirando arriba por su fachada. `cargo test` (137), compatibilidad v0.7.0,
inventario, i18n, panel (191 ids) y léxico.

**Lo que sigue faltando** de esta entrega: el portal no se abre (entrega 5); un
edificio de barrio puede caer dentro de una parcela comprada, porque el plano
de los barrios se hace antes de conocer las parcelas; los fantasmas del
multiverso siguen con la morfología neutra de su sector; y las proporciones del
edificio de la parcela —la torre es tan ancha como alta— son las heredadas de
los arquetipos: la celda mide 650 m y el edificio, el 28 % de ella.

## Novedades de v0.10.14 — la manzana y la fachada

Empieza la entrega 4 del plan del metaverso (`docs/METAVERSO.md`, «TRAMA: la
manzana y la fachada»). **No toca el consenso, la red ni el formato de los
ficheros**; la vista de la ciudad que sirve el nodo gana un campo.

Las 3.106 cajas anónimas del skyline pasan a ser edificios:

- **Planta.** Cada edificio sale de un catálogo según su tipo de barrio: las
  torres son lámina, podio y torre, escalonada, en L o gemelas sobre podio; los
  bloques, barra, en L, en U con el patio a la calle o con ático retranqueado;
  las villas, casa con losa de tejado y tapia con cancela; las naves, con bóveda
  o planas con casetones en la cubierta. Cuál le toca a cada uno sale **solo de
  su posición** (`semillaMorfologia`, canal 11): dos máquinas deducen el mismo
  edificio. La posición, la altura y la huella siguen saliendo de la misma serie
  que en la v0.10.6, así que el skyline no se mueve.
- **Coronación.** Peto que sobresale, cuarto de máquinas y, en las torres de
  más de 150 m, antena.
- **Portal hacia la calle.** Dentro de una trama de barrio la fachada se pone
  **paralela a la calle más cercana** y el portal —vidriera del vestíbulo,
  puerta y marquesina— mira a ella; 2.344 de los 3.106 quedan así alineados y
  las manzanas se leen como manzanas. Las naves llevan muelle de carga con dos
  portones. Villas y naves ya no llevan la retícula de ventanas de oficina.
- **Cómo se dibuja.** Ya no son mallas instanciadas de una caja escalada: un
  portal de tres metros no puede escalar con la torre. Cada edificio se escribe
  en metros en la malla de su tesela de ocho kilómetros (19 teselas), con esfera
  envolvente, como la calzada y las palmeras; el sombreador de edificios recibe
  la cota del pie de cada uno para contar las ventanas desde su planta baja.
- **El rótulo.** El nodo añade a cada parcela el **nombre único de su dueño**
  (`handle`, el de `SetProfile`; vacío sin perfil), la ficha del panel lo
  muestra y el cliente 3D lo cuelga sobre la coronación del edificio de la
  parcela, en el color de acento si es el tuyo. Sin perfil no hay rótulo: una
  dirección en hexadecimal no es un nombre.

**Lo que cuesta.** Medido con los mismos encuadres en el binario publicado de la
v0.10.13 y en este: de cerca y a pie, entre −1,5 % y +4,7 % de triángulos
(torres de cerca 897.962 → 925.438; a pie en una manzana 928.100 → 952.312; ante
una torre 805.296 → 806.004); la ciudad entera de golpe, +19,5 % (1.467.752 →
1.753.464) y 15 llamadas más, una por tesela. Las mallas de los barrios suman
332.944 triángulos frente a los 37.000 de las cajas.

**Cómo se ha comprobado.** Panel real en Chromium sin pantalla, cero errores:
recuento por tipo y por planta (720 torres, 837 bloques, 830 villas, 720 naves,
las cinco variantes repartidas), fotos desde arriba de las plantas, ante el
portal de una torre, de un bloque en L, de una villa y del muelle de una nave, y
una ciudad sintética de tres parcelas: dos rótulos («@rami_dxb» en blanco a
176 m, «@karim» en el color de acento por ser del jugador) y ninguno para la
parcela sin perfil. `cargo test` (137), compatibilidad v0.7.0, inventario, i18n,
panel y léxico.

**Lo que sigue faltando** de esta entrega: el portal no se abre (eso es la
entrega 5); los edificios de las parcelas —los del jugador— siguen siendo los
arquetipos por sector, sin planta ni portal deducidos; y la calidad «baja» sigue
dibujando el 40 % de los edificios mientras el catastro los tiene todos.

## Novedades de v0.10.13 — pasos de peatones, coches que esquivan y la medida de fluidez

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`). **No toca el
consenso, la red ni el formato de los ficheros.**

Los tres pendientes de la v0.10.12, en orden:

- **Pasos de peatones.** Uno en cada boca que cede el paso y en cada entrada de
  glorieta: 7.908. Bandas de 50 cm a lo ancho de la calzada entera, 2,5 m de
  fondo, a 30 cm de la acera de la preferente (de 2,5 a 5 m del anillo en las
  glorietas); la línea de detención se retrasa un metro por detrás. Las marcas
  ya no piden fila propia en la cinta: cada una se interpola entre las dos filas
  que la encierran y se escribe como cuadrilátero suelto, así que la malla de
  vías se queda en 1.014.134 triángulos (con fila propia subía a 1.309.284).
- **Una sola cota por cruce.** Al pintar el paso apareció un fallo que ya
  estaba: la caja de la vía preferente sale ensanchada por el radio de la
  esquina y monta sobre los primeros metros de la que cede, y como cada vía
  llevaba su propio nivel, en el cruce de trama que sirve de prueba la caja
  tapaba a la otra entre ocho y diecisiete centímetros —y con ella la línea de
  detención y el paso—. Ahora toda la zona del cruce, en las dos vías, va a la
  cota máxima de las secciones de ambas; la propia vuelve suave en los sesenta
  metros siguientes, y la que cede va centímetro y medio por encima para que
  dos planos iguales no parpadeen. El paso queda 3 cm sobre la caja y se ve
  cenital, oblicuo y a pie; las esquinas salen iguales que en la v0.10.11.
- **Los coches esquivan.** Un jugador parado en el carril paraba la fila entera.
  Ahora el coche que lo ve por delante, dentro de su distancia de frenado, se
  aparta y le pasa a 2,4 m por el lado que menos lo saque del carril —hacia el
  eje hasta quedarse a 1,2 m de él, hacia fuera hasta 1,2 m del bordillo—, a
  2,5 m/s de lado y girando el morro lo que dicta esa velocidad; el lado se
  elige una vez y se mantiene mientras quepa (reelegido cada cuadro, con el
  jugador en el centro los dos lados empatan y el coche se quedaba dudando sin
  moverse); al pasar, vuelve al carril. Solo frena si no le da tiempo a quitarse
  antes de llegar o no cabe por ningún lado. Las colas quedan como estaban.
- **La medida de fluidez, en el panel.** Ninguna cifra de cuadros por segundo
  del proyecto estaba medida en una tarjeta gráfica de verdad, y desde donde se
  construye no se puede: aquí se dibuja por software a uno o dos cuadros por
  segundo. El botón «⏱ Fluidez» de la pestaña Dubái mide cuatro vistas fijas
  —la ciudad entera, el centro, un hito de cerca y a pie en un cruce—, un
  segundo de calentamiento y cuatro de cuenta cada una, dentro del bucle normal
  de dibujo, y deja en una línea la tarjeta gráfica que declara el navegador,
  la calidad, el tamaño del lienzo y, por vista, la media, el peor cuadro, los
  triángulos y las llamadas de dibujo. Al terminar devuelve la cámara donde
  estaba. La cifra la mide quien tiene tarjeta; en este entorno sale
  «SwiftShader», de 0,2 a 1,7 fps.
- **La mitad real de las calles, enchufable.** La red de aquí no alcanza
  OpenStreetMap y el repositorio no distribuye sus datos (ODbL).
  `tools/geo/osm_roads.py` convierte un extracto que aporte quien lo ejecute
  —JSON de Overpass o GeoJSON— en la clave `vias` del dataset: clasifica por
  `highway`, encadena los tramos de una misma avenida, simplifica a 5 m y
  descarta lo corto; el cliente lee `vias` con el ancho de su clase y las pone
  por delante de las calles deducidas en cada cruce. La consulta de Overpass y
  la nota de licencia están en `tools/geo/README.md`. Probado con un extracto
  sintético de dos vías, que salió con cinta, tráfico con su calzada y un cruce
  con paso y línea de detención; después se quitó del dataset.

**Cómo se ha comprobado.** Con pasos de 1/60 s (`_debug.paso`): en una vía de
15 m, el jugador en el centro del carril a 80 m → el coche pasa por la
izquierda a 2,40 m sin bajar de 21,9 m/s y vuelve al carril en 4,7 s; 2 m a la
izquierda → pasa por la derecha a 2,40 m; en una arteria, lo mismo; de sopetón
a 12 m → frena a 14,5 m/s y pasa rozando (le empuja 25 cm); la cola de dos
coches guarda sus 12,3 m sin desvío. Las marcas: 7.908 pasos, 7.776 líneas de
detención y 23 cedas en 43 teselas. Fotos a pie y desde arriba de un coche
desviándose, y del paso en el cruce de trama. El botón de fluidez, pulsado en
el panel real: abre el 3D, mide y vuelve a habilitarse.

**Lo que cuesta.** Nada en triángulos: la malla de vías mide lo mismo que sin
pasos y sin cota común. Al construir, dos secciones más de nueve puntos por vía
y cruce; por cuadro, una comparación más por coche.

**Lo que sigue faltando:** los avatares ajenos no se apartan; donde la cinta se
corta por el agua (Ras Al Khor) los coches siguen su vía por encima, sin
puente; y la mitad real de las calles espera un extracto que aporte quien la
quiera.

## Novedades de v0.10.12 — la colisión con lo que se mueve

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`). **No toca el
consenso, la red ni el formato de los ficheros.**

El jugador chocaba con las fachadas y con nada más: los coches lo atravesaban y
él atravesaba a los demás avatares. Ahora:

- **Los coches son sólidos.** Cada coche es una caja orientada por su sentido de
  marcha —2,3 m de medio largo y 1 m de medio ancho, lo que mide la carrocería
  con faros y ruedas— y el jugador sale de ella con el mismo empuje por la normal
  que ya usaba con los edificios. El empuje se aplica **cada cuadro**, no solo al
  pulsar una tecla: un coche que llega por detrás no atraviesa a un jugador
  quieto. Y si el empujón lo mete en una fachada, la fachada gana.
- **Los avatares ajenos también.** Círculos de 35 cm; contra el jugador, de 42,
  la distancia mínima queda en 77 cm.
- **Los coches frenan.** Por el que llevan delante en su misma vía y sentido, y
  por el jugador si pisa su carril: se paran a siete metros del obstáculo con el
  perfil de una deceleración constante de 6 m/s² —un coche a 22 m/s empieza a
  frenar a 40 m; a 36 m/s, a 108— y arrancan otra vez cuando el hueco se abre.
  En cola, el de atrás se ajusta a la velocidad del de delante y guarda hueco.
- **En VR, lo mismo**: el mismo empuje sobre el rig cuando va a ras de suelo.

**Cómo se ha comprobado.** Con un paso de simulación sin dibujar, expuesto en
`_debug.paso(dt)`, que hace las pruebas deterministas: a 2 cuadros por segundo
en el navegador sin pantalla un segundo de reloj es una décima de simulación, y
las pruebas de la primera pasada ni llegaron a ejecutar un cuadro. Con 900 pasos
de 1/60 s: un coche a 22,6 m/s se para a 7,0 m del centro (4,7 del morro) del
jugador en 4,2 s sin moverlo un milímetro, y arranca 1,7 s después de que se
aparte; un jugador plantado dentro de un coche sale de la caja en un paso; contra
un avatar la distancia mínima es 0,77 m exactos; en cola, el de atrás baja de
22,6 a los 8 m/s del de delante y se queda a 12,3 m.

**Lo que cuesta.** Ninguna geometría nueva: el mismo presupuesto de triángulos y
llamadas de dibujo. Por cuadro, ordenar los coches por vía y sentido y mirar los
que están a menos de cuatro metros del jugador.

**Lo que sigue faltando:** los avatares ajenos van donde dice su cliente, así que
solo se empuja al jugador local; los coches no esquivan, solo frenan; no hay
pasos de peatones; y sigue sin haber ni una cifra de fluidez medida en una
tarjeta gráfica de verdad.

## Novedades de v0.10.11 — las líneas de detención y el ceda el paso

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`). **No toca el
consenso, la red ni el formato de los ficheros.**

La calle que cedía llegaba al cruce con sus marcas de carril y se acababa: ni
una raya que dijera dónde parar. Ahora las bocas van pintadas:

- **Una línea de detención en cada boca de la calle que cede**, 7.876 en los
  4.505 cruces: banda continua de 40 cm, de la línea de eje al bordillo, solo en
  la **mitad que llega al cruce** —la derecha de su sentido de marcha, que aquí se
  circula por la derecha—. Va donde el arco de la esquina ya ha terminado y, como
  poco, un metro por detrás de la acera de la preferente, que es por donde cruza
  la gente.
- **Ceda el paso en las entradas de las glorietas**, 23 en las siete: línea
  discontinua —60 cm pintados, 30 de hueco— metro y pico antes del anillo, en la
  misma mitad.
- **Son cuadriláteros sueltos, no filas de la cinta.** Cada marca son cuatro
  vértices y dos triángulos escritos en la tesela de su calle, con la misma cota
  basta para el relevo de nivel y centímetro y medio por encima del asfalto, como
  la junta de la glorieta. Metidas entre dos filas de la cinta habrían roto el
  cosido de ocho vértices. Dos clases nuevas en el mismo sombreador: pintura
  continua y pintura discontinua por la coordenada transversal, con el mismo
  desvanecido de lejos que las demás marcas.

**Lo que cuesta.** La malla de calzada pasa de 964.208 a 983.240 triángulos
(15.798 de las marcas, el resto de las filas que hubo que añadir donde no había
una). A pie en un cruce, de 740.308 a 741.322: un 0,14 %. La ciudad entera, de
1.797.684 a 1.816.716 en las mismas 65 llamadas de dibujo. Ninguna llamada nueva:
las marcas van dentro de las mallas de la calzada.

**Lo que sigue faltando:** los coches y los avatares se siguen atravesando; no hay
pasos de peatones; y sigue sin haber ni una cifra de fluidez medida en una tarjeta
gráfica de verdad.

## Novedades de v0.10.10 — las palmeras dejan de enviarse enteras

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`). **No toca el
consenso, la red ni el formato de los ficheros.**

Las palmeras eran el último bulto de la escena que se enviaba entero: 925
palmeras en dos mallas instanciadas marcadas «no las descartes nunca», 192.400
triángulos a la tarjeta cada cuadro estuvieras donde estuvieras, el 21 % de lo
que se ve a pie en un cruce. Ahora van repartidas en **17 teselas de ocho
kilómetros** —la misma tesela que la calzada desde la v0.10.8—, cada una con su
malla instanciada y su esfera envolvente, y la que no entra en el cono de visión
no se envía:

| Encuadre | v0.10.9 | v0.10.10 | Llamadas |
|---|---|---|---|
| A pie en un cruce | 914.196 | **740.308** (−19 %) | 18 → 17 |
| Barrio en oblicuo | 914.196 | **756.740** (−17 %) | 18 |
| Glorieta de cerca | 1.052.124 | 904.444 (−14 %) | 18 |
| Palmeras de cerca | 1.142.494 | 1.014.574 (−11 %) | 19 → 21 |
| Andando por el cruce | 989.866 | 824.714 (−17 %) | 24 → 25 |
| Andando entre palmeras | 1.129.404 | 977.980 (−13 %) | 34 → 35 |
| Sobre una frontera de tesela | 950.358 | 797.270 (−16 %) | 18 |
| Ciudad entera, cenital (peor caso) | 1.799.556 | 1.797.684 | 50 → 65 |

- **Una sola geometría.** Había dos palmeras distintas —tronco inclinado tres o
  seis grados— en dos mallas, y la inclinación era de la geometría: el tronco se
  inclinaba y la copa se quedaba en su sitio, hasta 75 cm separada de él. Ahora
  la geometría es una, recta, y la inclinación —de uno a siete grados, distinta
  en cada palmera y hacia un lado distinto— va en la matriz de la instancia,
  con la escala y el giro. La palmera entera se inclina con su copa, y hay una
  malla por tesela en vez de dos.
- **La esfera se le da hecha.** Three r150 no sabe calcular la esfera
  envolvente de una malla instanciada: la haría sobre la palmera suelta, en el
  origen, y descartaría la tesela entera en cuanto ese punto saliera de
  pantalla. Cada tesela lleva una copia de la geometría con su esfera —centro y
  radio de los pies, más trece metros de palmera—, porque la esfera es de la
  geometría y no de la malla.
- **El tamaño salió de medir cuatro.** Con dos kilómetros son 138 teselas y 186
  llamadas de dibujo en el peor caso; con cuatro, 46 y 94; con seis, 26 y 74;
  con ocho, 17 y 65. La diferencia en triángulos entre tamaños es de un 2 % de
  la escena; la de llamadas, de tres veces. Ocho: la misma que la calzada.

**Lo que cuesta.** El peor caso —la ciudad entera de golpe— paga 15 llamadas de
dibujo más, de 50 a 65, cuando una palmera mide menos de un píxel. Y hay nueve
palmeras menos, 916 en vez de 925: al sortear una inclinación por palmera cambia
la secuencia y nueve caen donde no crecen.

**Una cifra corregida.** Las notas de la v0.10.9 decían que las palmeras eran el
44 % de los triángulos. Ese número daba por hecho que la pasada de sombra las
dibujaba otra vez; medido apagándola, en los encuadres de la tabla esa pasada no
dibuja nada. Ocultando las palmeras la escena se queda en 721.796 triángulos,
que es exactamente 914.196 menos 925 × 208: eran el 21 %.

**Lo que sigue faltando:** no hay líneas de detención ni ceda el paso pintados, y
sigue sin haber ni una cifra de fluidez medida en una tarjeta gráfica de verdad:
aquí todo se mide en triángulos enviados y llamadas de dibujo.

## Novedades de v0.10.9 — el radio de giro de las esquinas

Cierra la entrega 5 del plan del metaverso (`docs/METAVERSO.md`). **No toca el
consenso, la red ni el formato de los ficheros.**

La v0.10.7 resolvió los cruces: prioridad, hueco y rebaje de bordillo. Pero la
calle que cede llegaba a la preferente **en ángulo recto**, y la acera de la
preferente se cortaba en escuadra sobre la boca. Por un cruce así no gira un
coche: es una escuadra, no una esquina.

Ahora los **4.505 cruces** tienen radio de giro de verdad, de cuatro a nueve
metros según el ancho de la calle más estrecha de las dos.

- **El bordillo describe un cuarto de circunferencia** tangente al bordillo de
  la otra calle. No es un chaflán ni un redondeo aproximado: es el arco exacto
  que separa las dos calzadas, y **las dos calles usan la misma fórmula**, así
  que sus bordes recorren el mismo arco y se encuentran en él en vez de
  cruzarse. Los cuatro rincones de cada cruce quedan iguales.
- **La medida natural del arco no es la distancia al corte, sino la distancia
  perpendicular al eje de la otra vía**: el arco vale el radio entero en el
  borde de su calzada y se muere R metros más afuera. Partir de donde termina la
  cinta —que fue el primer intento— abría las bocas ocho metros en vez de uno y
  medio, y dejaba picos donde los dos ensanches se cruzaban.
- **El arco se parte por ángulo, no por longitud.** Cuatro cortes en el 0, el
  29, el 60 y el 100 por ciento del recorrido dejan la flecha del arco por
  debajo de diez centímetros. Repartidos por longitud pasaba del metro y la
  esquina volvía a leerse como un chaflán, con las mismas filas.
- **Y los edificios lo saben:** la boca ensanchada también ocupa terreno, así
  que nadie construye dentro de ella, igual que ya pasaba con las calles y con
  las glorietas.

**Lo que cuesta, y dónde.** La malla de calzada sube de 524.860 a 964.208
triángulos. Pero desde la v0.10.8 esa malla va repartida en teselas que se
descartan solas, así que **a pie el gasto sube un 3,7 %** —de 881.408 a 914.196
triángulos enviados, en las mismas 18 llamadas de dibujo—, que es justo donde se
ve la esquina. El peor caso, la ciudad entera de golpe, pasa de 1.360.208 a
1.799.556 en las mismas 50 llamadas; ahí una esquina mide medio píxel. Ese es
exactamente el presupuesto que liberó la v0.10.8.

**Lo que sigue faltando:** no hay líneas de detención ni ceda el paso pintados, y
las palmeras —el 44 % de los triángulos de la escena— siguen en dos mallas
instanciadas enteras, sin descarte por frustum.

## Novedades de v0.10.8 — las calles dejan de enviarse enteras

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`). **No toca el
consenso, la red ni el formato de los ficheros.**

Los cruces de la v0.10.7 subieron la escena de 1.063.212 a 1.367.614 triángulos,
y toda la calzada iba en **una** malla marcada como «no la descartes nunca»:
medio millón de triángulos a la tarjeta cada cuadro, mires donde mires.
Caminando por un barrio se ve menos del dos por ciento de la ciudad, así que el
resto era trabajo tirado.

Ahora la calzada va repartida en **43 teselas de ocho kilómetros**, cada una con
su malla y su esfera envolvente, y la que no entra en el cono de visión no se
envía:

| Encuadre | Antes | Ahora |
|---|---|---|
| A pie en un cruce | 1.367.614 tri · 17 llamadas | **881.408** tri · 18 llamadas |
| Barrio en oblicuo | 1.367.614 tri · 17 llamadas | **881.408** tri · 18 llamadas |
| Glorieta de cerca | 1.367.614 tri · 17 llamadas | **949.966** tri · 18 llamadas |
| Sobre una frontera de tesela | 1.367.614 tri · 17 llamadas | **894.806** tri · 18 llamadas |
| Ciudad entera, cenital | 1.367.614 tri · 17 llamadas | 1.360.208 tri · **50** llamadas |

A ras de calle se envía **un tercio menos de escena por una llamada de dibujo
más**. El peor caso —toda la ciudad de golpe, que es justo cuando la calzada
mide un píxel— paga 33 llamadas de más.

**El tamaño de tesela no es un número a ojo: se midieron cuatro.** Con 4 km el
peor caso eran 106 llamadas; con 6 km, 66; con 12 km se colaban 130.000
triángulos de más a pie. Ocho es donde el ahorro a ras de calle ya está completo
y el peor caso todavía es barato.

**Sin costuras.** Una cinta que cruza de tesela repite su última fila en la
nueva y cose allí la sección, así que no hay ni hueco ni sección dibujada dos
veces. Comprobado con una captura tomada justo encima de una frontera.

**Lo que no está medido, y hay que decirlo.** El ahorro está en triángulos
enviados y llamadas de dibujo, **no en milisegundos**: en el entorno donde se
construye este proyecto no hay tarjeta gráfica con la que cronometrarlo, así que
nadie ha comprobado todavía que las 33 llamadas extra del peor caso cuesten
menos que los 480.000 triángulos que se ahorran a pie.

**Lo que sigue faltando:** las palmeras —el 44 % de los triángulos de la
escena— siguen en dos mallas instanciadas que tampoco se descartan. Esa es la
siguiente.

**Y un test que tumbó un release.** El de la v0.10.7 falló al primer intento por
`rami-net::tests::oversized_frame_disconnects_peer`, que leía el contador de
pares en el instante exacto en que recibía el evento de desconexión. Ese contador
es una instantánea que se refresca un paso después, así que con la máquina
cargada el test caía dentro de la ventana. No era un fallo del producto: la tabla
de pares siempre fue correcta. Ahora los asserts que van detrás de un evento
esperan al contador en vez de leerlo una vez. Solo cambian los tests.

## Novedades de v0.10.7 — los cruces

Entrega 5 del plan del metaverso (`docs/METAVERSO.md`). **No toca el consenso,
la red ni el formato de los ficheros.**

La v0.10.6 puso calles en los barrios, pero cada calle se dibujaba entera y por
su cuenta. Donde dos se cruzaban —y con la trama de barrio eso pasa cada ciento
cincuenta metros— las dos calzadas quedaban una encima de la otra: dos bordillos
de dieciocho centímetros atravesando el asfalto de la otra, y la acera
cortándole el paso a los coches. Eso ya no pasa: **4.505 cruces resueltos** en
toda la ciudad, y siete glorietas.

- **Prioridad.** En cada cruce manda una de las dos. El rango lo decide sin
  ambigüedad: las vías del mapa abierto por encima de cualquier calle deducida,
  y entre iguales la más ancha; a igualdad exacta, la de menor índice, que es un
  orden fijo. La misma pareja se resuelve igual en todas las máquinas.
- **Hueco.** La calle que cede desaparece dentro del ancho de la que manda, en
  vez de dibujarse por debajo. La cinta termina justo en el borde exterior de la
  otra, no un remuestreo antes.
- **Rebaje.** El bordillo de la vía preferente baja a la calzada en la boca de
  la otra, en metro y medio, que es lo que hace un vado de verdad. Su eje y sus
  carriles siguen pintados a través del cruce; los de la que cede, no.
- **Glorietas.** Donde se cruzan dos arterias del mapa del mismo orden no manda
  ninguna: va un anillo de asfalto sin marcas —de siete a catorce metros, la
  calzada de un solo sentido— con su bordillo y su isla central de acera. Las
  dos vías se cortan en la cuerda cuyos extremos caen sobre la circunferencia,
  así que las bocas encajan sin morder ni solaparse. El anillo va centímetro y
  medio por encima, como una junta de asfalto de verdad, y se nivela por un
  disco más ancho que la nivelación de cualquier sección que lo toque: ninguna
  calzada le asoma por debajo.
- **Y los edificios lo saben.** Una glorieta ocupa terreno: ningún edificio se
  planta dentro, igual que ya pasaba con las calles.

**Lo que cuesta.** Los cruces suben la escena de 1.063.212 a 1.367.614
triángulos con calidad media, en las mismas 17 llamadas de dibujo. Toda esa
geometría está en la malla de calzada, que no proyecta sombra —solo la recibe—,
así que se dibuja una vez por cuadro y no dos.

**Lo que sigue faltando:** las esquinas no tienen radio de giro, no hay líneas
de detención ni ceda el paso pintados, y la mitad real de las calles sigue
esperando un extracto de OpenStreetMap en el repositorio.

## Novedades de v0.10.6 — las calles de barrio, y las manzanas

Entrega 4 del plan del metaverso (`docs/METAVERSO.md`). **No toca el consenso,
la red ni el formato de los ficheros.**

Hasta ahora Dubái tenía 21 autopistas y, dentro de los barrios, arena: las
torres estaban repartidas al azar sobre el desierto. Ahora hay **trama urbana**.

- **Cada barrio tiene su retícula de calles**, con su giro y su paso propios. No
  vienen de ningún fichero: se **deducen** con la misma aritmética entera que el
  resto de la ciudad, a partir de la celda donde está el barrio. Eso significa
  que son idénticas en todas las máquinas y que no cambian nunca. 34 barrios,
  cada uno con su trama, y el paso y el ancho dependen de qué se construye allí:
  165 m entre calles de 16 m en los de torres, 120 m entre calles de 10 m en los
  de villas, 210 m entre calles de 18 m en los polígonos.
- **Las manzanas salen solas.** Un edificio ya no se planta en mitad de la
  calle: si la posición que le tocaba pisa la trama, busca otra. Así los
  edificios se agrupan en los huecos que deja la retícula, que es exactamente
  como crece una ciudad. De 3.124 torres, solo 18 no encontraron sitio.
- **La cinta se corta donde debe.** Una calle que llega al agua o al borde del
  mapa deja de dibujarse en vez de coser el hueco de un salto.

**Lo que falta, y por qué.** El plan elegido era mezclar calles reales de
OpenStreetMap con las deducidas. La red del entorno donde se construye este
proyecto **no alcanza OpenStreetMap**: rechaza Overpass, Nominatim, Geofabrik y
los teselados. Así que esta versión trae la mitad deducida —que hacía falta en
cualquier caso— y la mitad real queda enchufable: en cuanto haya un extracto de
Dubái en el repositorio, sus vías con nombre se añaden a la misma lista y mandan
donde existan.

## Novedades de v0.10.5 — el suelo deja de ser color liso

Entrega 3 del plan del metaverso (`docs/METAVERSO.md`). **No toca el consenso,
la red ni el formato de los ficheros.**

Hasta ahora todas las superficies eran un color plano con un poco de ruido
encima: a dos metros del suelo, el asfalto y la acera eran el mismo gris con
distinto brillo. Ahora hay **materiales de verdad**.

- **Cuatro texturas teselables**, de 512×512 cada una: asfalto con árido, poros
  y grietas; hormigón con poros y veladuras; arena con grano fino y rizos de
  viento; y losas de acera de 60 cm con junta rehundida y **tono propio por
  losa**, que es lo que delata un pavimento de verdad frente a una superficie
  lisa. En cada fichero, el color va en el RGB y **la altura en el alfa**: un
  solo PNG por material en vez de color más normal, la mitad de descarga.
- **No son de nadie.** Las fabrica
  `tools/textures/make_materials.py` con la biblioteca estándar de Python, de
  forma determinista, y no arrastran licencia ajena. La descarga sube 1,6 MB.
- **El color va codificado en sRGB**, como debe ser: el cliente tiene canal de
  color físico desde la v0.10.0 y lo pasa a lineal antes de iluminar. Guardarlo
  en crudo habría dejado el asfalto diez veces más oscuro.
- **La arena tiene relieve.** La normal del terreno sale de derivar la altura de
  la textura, así que los rizos del desierto se iluminan de verdad con el sol
  rasante en vez de ser un dibujo plano.

**Por qué generadas y no fotográficas:** el entorno donde se construye este
proyecto no alcanza las fuentes de dominio público —la red las rechaza—, y meter
arte con una licencia sin verificar no es una opción. Si algún día entra un
juego fotográfico CC0, se sustituyen esos cuatro ficheros y ya está: el
sombreador no cambia.

## Novedades de v0.10.4 — la calzada

Entrega 2 del plan del metaverso (`docs/METAVERSO.md`). **No toca el consenso,
la red ni el formato de los ficheros.**

Las 21 vías del mapa se dibujaban como líneas de **un píxel** flotando tres
metros sobre el suelo: de lejos parecían carreteras, de cerca eran un alambre.
Ahora son geometría de verdad.

- **Cinta con perfil.** Cada vía se remuestrea cada 100 metros y se levanta con
  un perfil de ocho puntos: acera, bordillo con cara vertical, calzada, y lo
  mismo al otro lado. El ancho sale de su longitud, porque el mapa abierto no
  trae jerarquía: 42 metros las troncales, 26 las arterias, 15 las secundarias.
  602 kilómetros de vía, 65.268 triángulos, **ni una llamada de dibujo más**
  (la línea de antes gastaba dos por ser transparente a doble cara; la calzada
  gasta una por ser opaca).
- **Marcas viales analíticas.** La línea de eje, las de carril y las
  discontinuas no son una textura: salen de la coordenada transversal —metros
  desde el eje— y de la longitudinal —metros recorridos—, que cada vértice
  lleva consigo. Cuestan cuatro instrucciones y **cero bytes de descarga**, y se
  apagan solas en la distancia para no centellear.
- **La rasante se nivela.** Una sección de carretera es horizontal de lado a
  lado y recta entre secciones; si cada punto se pegara a su propia cota, la
  cuerda de 100 metros se hundiría bajo cualquier bulto y el terreno mordería
  la calzada a trozos. Se nivela por la cota máxima de una cruz de nueve
  puntos, que es justo lo que hace un desmonte de verdad.

**Lo que esto NO trae:** el mapa abierto solo tiene las 21 vías principales de
Dubái. Dentro de los barrios **sigue sin haber calles**: el centro se cruza por
arena entre los edificios. Las calles de ciudad son otro trabajo y otro dato.

## Novedades de v0.10.3 — los edificios dejan de ser humo

Entrega 1 del plan del metaverso (`docs/METAVERSO.md`). **No toca el consenso,
la red ni el formato de los ficheros.**

Hasta ahora la ciudad no existía para nadie más que para los ojos: se
atravesaban las torres andando, y señalar con el ratón solo decía en qué casilla
de 650 metros estabas, nunca qué edificio tenías delante. Sin esas dos cosas no
puede haber portales que cruzar, coches a los que subir ni escaparates que
mirar, así que era el primer ladrillo de todo lo demás.

- **El catastro de sólidos.** Los 56 hitos y las 3.124 torres del skyline pasan
  a tener huella —centro, medidas, giro y altura— en una rejilla espacial de
  256 metros. Una sola estructura que resuelve las dos cosas: **3.180
  edificios** consultables en tiempo constante.
- **Los edificios paran.** A pie ya no se atraviesan. Andando contra la cara sur
  del Burj Khalifa te quedas a 75 metros exactos de su centro, que es donde
  acaba su fachada. Volando por encima de su altura, se pasa.
- **Señalar dice qué es.** El rayo del ratón topa antes con el edificio que con
  el suelo, así que la línea de estado dice «🏢 Burj Khalifa · 829 m» en vez de
  solo la parcela. En los edificios genéricos, el tipo y el barrio.
- **Aparecer a pie ya no te mete dentro de una torre.** El apartado que evitaba
  esto solo miraba los 56 hitos; ahora mira los 3.180 edificios, y aparecer
  dentro de una de las 3.124 torres del skyline era 56 veces más probable que lo
  que se evitaba.
- **El contrato de semillas.** Se fija en el código la frontera que ordena todo
  lo que viene: la **forma** de un edificio sale solo de datos que no cambian
  —su posición en la rejilla— y su **ropa** (tono, rótulo, luces) sale de lo que
  la cadena mueve: dueño y antigüedad. Así una torre no se rehace entera cuando
  alguien vende un piso, pero dos torres iguales de dueños distintos no se ven
  idénticas. Ambas son aritmética entera: dan el mismo número en cualquier
  máquina.

## Novedades de v0.10.2 — la ciudad va suelta, y el plan de lo que viene

Versión de cimientos. **No toca el consenso, la red ni el formato de los
ficheros**, y a simple vista la ciudad se ve exactamente igual: lo que cambia es
lo que cuesta dibujarla.

| | Antes | Después |
|---|---|---|
| Triángulos por fotograma (calidad media) | 1.184.610 | 842.970 (−28,8 %) |
| Llamadas de dibujo | 18 | 17 |
| Programas de sombreado | 17 | 16 |
| Binario descargable | 7.104.616 B | 6.551.976 B (−7,8 %) |

- **Las palmeras eran el 44 % de la escena.** Y el 77 % de cada palmera era el
  racimo de dátiles: una esfera de 440 triángulos a siete metros de altura, que
  a esa distancia nadie distingue de una de 80. La capa de palmeras baja de
  525.400 a 192.400 triángulos. Como además eran el 89 % del pase de sombras,
  ese pase —que no sale en las estadísticas porque se dibuja antes de reiniciar
  el contador— cae casi a la mitad. Las 24 cabinas de la noria, lo mismo.
- **El manto y los bordes se dibujaban dos veces.** three.js reserva dos pasadas
  para todo material transparente a doble cara salvo que se le diga que no hacen
  falta; aquí no hacen falta, porque el manto va pegado al suelo y nunca se ve
  por dentro.
- **Los símbolos de depuración salen del binario.** Nadie los usa en una
  descarga, y se pagaban en cada actualización.
- **`docs/METAVERSO.md`**: el plan del metaverso, con las ocho entregas que
  vienen, lo que cuesta cada una, lo que se descarta y por qué, y lo que este
  plan no arregla. Sale de seis arquitecturas diseñadas por separado y sometidas
  cada una a un verificador cuyo encargo era refutarla con el código delante.

## Novedades de v0.10.1 — al abrir Dubái se ve Dubái

Arreglo del cliente 3D. **No toca el consenso, la red ni el formato de los
ficheros**: la 0.10.1 y la 0.10.0 son la misma cadena, y sigue valiendo la
fecha de activación del 1 de diciembre de 2026 (00:00 UTC).

Quien abría la pestaña Dubái se encontraba una cuadrícula de parcelas sobre
arena vacía, y de noche una pantalla negra. La ciudad estaba construida —los 56
hitos y las 3.124 torres—, pero no se veía. Por qué, y qué se ha hecho:

- **La vista de entrada era el emirato entero.** La cámara arrancaba a más de
  20 km, así que una torre de 300 m ocupaba un píxel y de Dubái solo quedaban la
  arena, las carreteras y la cuadrícula. Ahora se entra por el **skyline del
  centro**, con el Burj Khalifa recortado contra el cielo. Los tres encuadres
  están en la botonera: «🌇 Centro», «🌆 Dubái» (el emirato) y «▦ Parcelas».
- **Las ventanas solo salían en los 56 hitos.** Las torres instanciadas se
  levantan de una caja unidad escalada a su altura, y el sombreador miraba la
  coordenada local sin escalar: nunca pasaba de 1, así que la condición que
  enciende ventanas, forjados y cristal («por encima de 5 m») era falsa en
  **todas** ellas y se dibujaban como cajas lisas. Ahora se mide la altura sobre
  la base del edificio: toda la ciudad tiene fachada, de día y de noche.
- **La noche era negra.** El cielo físico da casi cero al ponerse el sol y la
  exposición además se cerraba. Ahora las ventanas encendidas mandan, hay
  **resplandor urbano** cálido de luz ambiente y la exposición se abre de noche,
  como el ojo. Con la hora real de Dubái, a las 22:00 se ve una ciudad
  encendida.
- **La cuadrícula de parcelas tapaba la ciudad.** Son 1.024 casillas de color
  sobre el suelo: es la herramienta para comprar, no el paisaje. Ahora está
  **apagada** y la enciende «▦ Parcelas» o un clic en cualquier parcela.
- **Suelo de ciudad.** Los datos de elevación no saben de asfalto, así que las
  torres se levantaban sobre un desierto liso; ahora el suelo de cada barrio
  construido va teñido de ciudad (y de verde en los de villas).
- **Sombras en calidad media**, que es la que trae de fábrica: era lo que más
  se notaba y estaba reservado a «alta».
- **Se dice cómo se maneja.** La primera vez sale una línea sobre el visor:
  arrastrar para girar, rueda para acercarse, clic en una parcela, «🚶 A pie»
  con WASD y «🥽 Gafas VR». En cinco idiomas, y no vuelve a salir.

## Novedades de v0.10.0 — identidad en la cadena, el multiverso como ciudades y un Dubái más real

**Actualiza antes del 1 de diciembre de 2026 (00:00 UTC).** La 0.10.0 se
habla con la 0.9.0 y la 0.8.0 hasta esa fecha; desde ella rigen las reglas de
Dubái (`docs/DUBAI.md`) más el perfil del jugador. Un binario 0.9.0 se queda
en su altura, sin romperse, en el primer bloque que lleve un perfil.

- **Perfil del jugador en la cadena** (`docs/MULTIVERSO.md`, §1). Una
  transacción nueva, `SetProfile`, registra un **nombre único** (3–20
  caracteres `a-z`, `0-9`, `_`; 2 RAMI quemados al registrarlo o cambiarlo),
  alias, presentación, estilo de avatar y color. Opcionalmente **vincula la
  identidad de tu nodo** —la que firma tu presencia y tu chat— con tu cuenta,
  y el consenso verifica esa firma: tu avatar lleva tu nombre con ✓ y nadie
  puede pasearse con él. `Status.rule` anuncia 4.
- **Ficha del jugador y código de fuente.** Panel → Dubái → «Mi perfil de
  jugador» y «Jugadores»: empresas con sus cuentas, activos, saldo, ingresos,
  y un código como el de los pares («C1»): una letra por los hechos de la
  cadena (empresas, ingresos, antigüedad) y un número por lo que este nodo
  observa ahora (avatar presente, con o sin vínculo). Describe; no decide.
  `rami-wallet profile` desde la terminal.
- **El multiverso.** Cada punta del árbol es una ciudad completa
  (`GET /api/city/multiverse`, `GET /api/city?tip=`). Lo que existe en otra
  rama y no en la observada se dibuja **en superposición** (edificios
  translúcidos con su rama en la etiqueta) hasta que el consenso colapsa hacia
  una; puedes visitar cualquier rama desde el panel. Nada de esto toca el
  consenso ni la red.
- **Gráficos.** Canal de color físico (lineal + ACES + sRGB); cielo por
  **dispersión atmosférica** con calima y disco solar, y las mismas fórmulas
  para niebla y luz ambiente; reflejos del cielo en cristal y agua (mapa
  cúbico); **sombras reales** de sol y luna sobre terreno y edificios;
  fachadas con forjados y ventanas que se encienden al anochecer; mar con
  profundidad leída del relieve y espuma en la costa; arena con relieve fino;
  palmeras; coches con habitáculo y faros; **avatares articulados** que andan,
  con cuatro estilos (casual, kandura y gutra, abaya, traje) y 16 colores. A
  pie se empieza en la calle, delante de la parcela.
- **Revisión y arreglos.** Una revisión por subsistemas de este mismo cambio
  dejó cinco defectos confirmados, ya corregidos aquí: junto al ✓ va el
  **nombre único** y no el alias (el alias es libre y no es único, así que
  servía para imitar a otro jugador); `rami-wallet` comprueba **toda** tx con
  las reglas del consenso antes de escribirla en el mempool (antes anunciaba
  «enviada» una tx que nunca entraría en un bloque) y valida `--avatar`,
  `--color`, `--display` y `--bio`; el panel ya no rebaja a 0–3 un estilo de
  avatar 4–15 guardado desde la terminal; los edificios, hitos, coches,
  palmeras y avatares **reciben** sombra (antes solo la proyectaban); y los
  tonos del skyline por barrio se linealizan como el resto de la paleta.
- **Compatibilidad.** Ningún fichero existente cambia de formato;
  `tools/compat/roundtrip.sh` sigue en verde con la v0.7.0. Un binario 0.9.0
  que abra un `chain.jsonl` con perfiles no lo lee: la salida es actualizar.

## Novedades de v0.9.0 — Dubái RAMI: el metaverso como reglas de consenso, con fecha de activación

**Actualiza antes del 1 de diciembre de 2026 (00:00 UTC).** Hasta esa fecha
nada cambia: la 0.9.0 se habla con la 0.8.0, firma igual (la regla v2 sigue
activándose el 20 de octubre), mina igual y abre los mismos archivos. Desde
esa fecha rigen las reglas de Dubái y los nodos anteriores se quedan en su
altura sin romperse.

- **La Ciudad RAMI se traslada a Dubái.** 64×64 parcelas de 650 m sobre una
  réplica hecha con datos abiertos (relieve de Mapzen/AWS Terrain Tiles;
  Palm Jumeirah, The World, Bluewaters, el Creek y los canales dibujados a
  mano y documentados como tales), 56 hitos modelados uno a uno, skylines por
  barrio, tráfico por las grandes vías, ciclo de día y noche con las ventanas
  encendidas. Tus parcelas conservan sus coordenadas (x, y).
- **Reglas de consenso nuevas** (`docs/DUBAI.md`): 35 distritos con precio de
  parcela propio (se quema), 30 sectores que se necesitan unos a otros, fondo
  de la ciudad con el 20 % de la emisión de cada bloque y reparto del 1 % del
  fondo por bloque según demanda, distrito, afinidad e insumos; el 40 % de
  cada ingreso paga a los proveedores más cercanos y lo que nadie ofrece se
  importa y se quema. La recompensa del minero baja al 80 % de la emisión;
  las comisiones siguen enteras. Activación por fecha sin periodo mixto y sin
  retroceso dentro de una rama; `Status.rule` anuncia 3.
- **Mercado en RAMI.** Parcelas y activos (planta, objeto, vehículo —solo lo
  acuña un concesionario— y local) se ponen en venta y se compran en una sola
  transacción con precio máximo. Las últimas 256 operaciones quedan en el
  estado y alimentan la **cotización interna**: pares parcela/RAMI por
  distrito y activo/RAMI, órdenes abiertas, cierres, fondo, quemado e índice.
  Pestaña **Mercado** en el panel, `rami-node market` (API pública de solo
  lectura en formato de agregador) y pestaña **Cotización** en la web, que
  lee los nodos de `web/market.json`. RAMI no cotiza en euros ni en otras
  criptomonedas; `docs/COTIZACION.md` dice qué haría falta fuera del
  software.
- **El mentor y la escuela de negocios.** Una regla pública (no una persona)
  calcula con las mismas funciones del reparto qué cobraría hoy cada sector
  en la parcela elegida, qué insumos faltan en la ciudad, cuántos
  competidores hay y en cuántos bloques se recupera la entrada; responde a
  preguntas escritas y ofrece ocho lecciones cortas. Cifras del estado
  actual, no promesas.
- **Personas en la ciudad.** Avatares y chat entre los visitantes conectados,
  por el túnel RAMI, firmados con la identidad del nodo y acotados en ritmo,
  tamaño y memoria; nada se guarda ni entra en el consenso. Modo **a pie**
  (WASD, mirar arrastrando, Q/E para volar) y **gafas VR** con mandos
  (palanca para andar, giro por saltos, gatillo para teletransporte) y factor
  de framebuffer alto en calidad «ultra» para pantallas 4K; presets de
  calidad y hora del día en la barra de la ciudad.
- **Compatibilidad.** El protocolo sigue siendo el v2 y ningún fichero
  existente cambia de formato; `tools/compat/roundtrip.sh` sigue en verde
  con los binarios de la v0.7.0 y la v0.7.3. Un binario v0.8.0 que abra un
  `chain.jsonl` escrito por la 0.9.0 con transacciones de mercado no lo lee
  (por red nunca las recibe): la salida es volver a la 0.9.0.

## What's new in v0.10.14 — the block and the facade

Delivery 4 of the metaverse plan begins (`docs/METAVERSO.md`, "TRAMA: the block
and the facade"). **It does not touch consensus, the network or the file
formats**; the city view served by the node gains one field.

The 3,106 anonymous skyline boxes become buildings:

- **Floor plan.** Each building comes from a catalogue by neighbourhood kind:
  towers are a slab, podium and tower, stepped, L-shaped or twin towers on a
  podium; blocks are a bar, L-shaped, U-shaped with the courtyard to the street,
  or with a set-back attic; villas are a house with a roof slab and a walled
  compound with a gate; warehouses are vaulted or flat with rooftop units. Which
  one each gets comes **only from its position** (`semillaMorfologia`, channel
  11): two machines deduce the same building. Position, height and footprint
  still come from the same series as in v0.10.6, so the skyline does not move.
- **Crown.** A projecting parapet, a plant room and, on towers above 150 m, an
  antenna.
- **Entrance facing the street.** Inside a neighbourhood grid the facade is set
  **parallel to the nearest street** and the entrance — lobby glazing, door and
  canopy — faces it; 2,344 of the 3,106 are aligned this way and the blocks read
  as blocks. Warehouses get a loading dock with two gates. Villas and warehouses
  no longer carry the office window grid.
- **How it is drawn.** No longer instanced meshes of one scaled box: a
  three-metre entrance cannot scale with the tower. Each building is written in
  metres into the mesh of its eight-kilometre tile (19 tiles), with a bounding
  sphere, like the roads and the palms; the building shader receives each
  building's base height so windows count from its ground floor.
- **The name sign.** The node adds to each parcel its **owner's unique name**
  (`handle`, the one from `SetProfile`; empty without a profile), the panel card
  shows it and the 3D client hangs it above the crown of the parcel's building,
  in the accent colour when it is yours. No profile, no sign: a hexadecimal
  address is not a name.

**What it costs.** Measured with the same framings on the published v0.10.13
binary and on this one: up close and on foot, between −1.5 % and +4.7 %
triangles (towers up close 897,962 → 925,438; on foot in a block 928,100 →
952,312; in front of a tower 805,296 → 806,004); the whole city at once, +19.5 %
(1,467,752 → 1,753,464) and 15 more draw calls, one per tile. The neighbourhood
meshes total 332,944 triangles against the boxes' 37,000.

**How it was checked.** Real dashboard in headless Chromium, zero errors: counts
by kind and by plan (720 towers, 837 blocks, 830 villas, 720 warehouses, the five
variants evenly spread), photos from above of the plans, in front of a tower's
entrance, an L-shaped block, a villa and a warehouse dock, and a synthetic city
of three parcels: two signs ("@rami_dxb" in white at 176 m, "@karim" in the
accent colour as the player's own) and none for the parcel without a profile.
`cargo test` (137), v0.7.0 compatibility, inventory, i18n, panel and lexicon.

**Still missing** from this delivery: the entrance does not open (that is
delivery 5); the parcel buildings — the players' — are still the per-sector
archetypes, with no deduced plan or entrance; and "low" quality still draws 40 %
of the buildings while the cadastre holds them all.

## What's new in v0.10.13 — zebra crossings, cars that swerve and the frame-rate measure

Continues delivery 5 of the metaverse plan (`docs/METAVERSO.md`). **It does not
touch consensus, the network or the file formats.**

The three items left pending by v0.10.12, in order:

- **Zebra crossings.** One at every mouth that gives way and at every
  roundabout entry: 7,908. Bands of 50 cm across the whole carriageway, 2.5 m
  deep, 30 cm from the priority road's pavement (2.5 to 5 m from the ring at
  roundabouts); the stop line moves one metre back behind it. Markings no
  longer need a row of their own in the ribbon: each one is interpolated
  between the two rows that enclose it and written as a loose quad, so the road
  mesh stays at 1,014,134 triangles (with their own rows it rose to 1,309,284).
- **One level per junction.** Painting the crossing exposed a defect that was
  already there: the priority road's junction box is flared by the corner
  radius and rides over the first metres of the yielding road, and since each
  road carried its own level, at the grid junction used for testing the box
  covered the other road by eight to seventeen centimetres — and with it the
  stop line and the crossing. Now the whole junction area, on both roads, sits
  at the maximum of both roads' sections; the road's own level returns smoothly
  over the next sixty metres, and the yielding road sits a centimetre and a
  half above so that two identical planes do not flicker. The crossing ends up
  3 cm above the box and shows top-down, oblique and on foot; the corners come
  out the same as in v0.10.11.
- **Cars swerve.** A player standing in the lane stopped the whole queue. Now
  a car that sees the player ahead, within its braking distance, moves aside
  and passes 2.4 m away on the side that takes it least out of its lane —
  towards the axis until it is 1.2 m from it, outwards until it is 1.2 m from
  the kerb — at 2.5 m/s sideways, turning its nose by what that speed dictates;
  the side is chosen once and kept while it fits (re-chosen every frame, with
  the player at the lane centre both sides tie and the car dithered without
  moving); once past, it returns to the lane. It brakes only if it cannot get
  clear before reaching the player or does not fit on either side. Queues
  behave as before.
- **The frame-rate measure, in the dashboard.** No frames-per-second figure in
  this project had been measured on a real graphics card, and it cannot be
  done where the project is built: here everything is drawn in software at
  one or two frames per second. The «⏱ Frame rate» button on the Dubai tab
  measures four fixed views — the whole city, downtown, a landmark up close
  and on foot at a junction — one second of warm-up and four of counting each,
  inside the normal draw loop, and leaves one line with the graphics card the
  browser declares, the quality, the canvas size and, per view, the average,
  the worst frame, the triangles and the draw calls. When done it puts the
  camera back. The figure is measured by whoever has a card; in this
  environment it reads "SwiftShader", 0.2 to 1.7 fps.
- **The real half of the streets, pluggable.** The network here does not reach
  OpenStreetMap and the repository does not distribute its data (ODbL).
  `tools/geo/osm_roads.py` converts an extract supplied by whoever runs it —
  Overpass JSON or GeoJSON — into the dataset's `vias` key: it classifies by
  `highway`, chains the pieces of one avenue, simplifies to 5 m and drops the
  short ones; the client reads `vias` with the width of their class and puts
  them ahead of the deduced streets at every junction. The Overpass query and
  the licence note are in `tools/geo/README.md`. Tested with a synthetic
  two-road extract, which came out with ribbon, traffic with its carriageway
  and a junction with crossing and stop line; then removed from the dataset.

**How it was checked.** With 1/60 s steps (`_debug.paso`): on a 15 m road, the
player at the lane centre 80 m ahead → the car passes on the left at 2.40 m
without dropping below 21.9 m/s and returns to the lane in 4.7 s; 2 m to the
left → it passes on the right at 2.40 m; on an arterial, the same; suddenly at
12 m → it brakes to 14.5 m/s and brushes past (pushing the player 25 cm); the
two-car queue keeps its 12.3 m with no deviation. Markings: 7,908 crossings,
7,776 stop lines and 23 give-way lines in 43 tiles. Photos on foot and from
above of a car swerving, and of the crossing at the grid junction. The frame
rate button, pressed in the real dashboard: opens the 3D, measures and is
enabled again.

**What it costs.** Nothing in triangles: the road mesh measures the same as
without crossings and without the shared level. At build time, two more
nine-point sections per road and junction; per frame, one more comparison per
car.

**What is still missing:** other players' avatars do not step aside; where the
ribbon is cut by water (Ras Al Khor) cars keep following their road above it,
with no bridge; and the real half of the streets waits for an extract supplied
by whoever wants it.

## What's new in v0.10.12 — collision with what moves

Continues delivery 5 of the metaverse plan (`docs/METAVERSO.md`). **It does not
touch consensus, the network or the file formats.**

The player collided with façades and with nothing else: cars drove through them
and they walked through other avatars. Now:

- **Cars are solid.** Each car is a box oriented along its direction of travel
  — 2.3 m half-length and 1 m half-width, what the body measures with lights
  and wheels — and the player is pushed out of it by the same normal push already
  used for buildings. The push runs **every frame**, not only on a key press: a
  car arriving from behind does not pass through a standing player. And if the
  shove puts them into a façade, the façade wins.
- **Other avatars too.** 35 cm circles; against the player's 42, the minimum
  distance is 77 cm.
- **Cars brake.** For the car ahead on the same road and direction, and for the
  player standing in their lane: they stop seven metres from the obstacle
  following the profile of a constant 6 m/s² deceleration — a car at 22 m/s
  starts braking at 40 m; at 36 m/s, at 108 — and pull away again when the gap
  opens. In a queue the rear car settles at the speed of the one ahead and keeps
  its distance.
- **In VR, the same**: the same push on the rig when it is at ground level.

**How it was checked.** With a simulation step that draws nothing, exposed as
`_debug.paso(dt)`, which makes the tests deterministic: at 2 frames per second
in the headless browser one second of clock is a tenth of a second of
simulation, and the first pass of tests never got to run a frame. With 900 steps
of 1/60 s: a car at 22.6 m/s stops 7.0 m from the player's centre (4.7 from the
bumper) in 4.2 s without moving them a millimetre, and pulls away 1.7 s after
they step aside; a player planted inside a car leaves the box in one step;
against an avatar the minimum distance is exactly 0.77 m; in a queue the rear
car drops from 22.6 to the 8 m/s of the one ahead and settles 12.3 m behind.

**What it costs.** No new geometry: the same triangle and draw-call budget. Per
frame, sorting the cars by road and direction and checking those within four
metres of the player.

**What is still missing:** other avatars go where their own client says, so only
the local player is pushed; cars do not swerve, they only brake; there are no
pedestrian crossings; and there is still not one frame-rate figure measured on
real graphics hardware.

## What's new in v0.10.11 — the stop lines and the give-way lines

Continues delivery 5 of the metaverse plan (`docs/METAVERSO.md`). **It does not
touch consensus, the network or the file formats.**

The street that gave way reached the junction with its lane markings and just
ended: not one stripe saying where to stop. The mouths are now painted:

- **A stop line at every mouth of the street that gives way**, 7,876 across the
  4,505 junctions: a solid 40 cm band from the centre line to the kerb, only on
  the **half that arrives at the junction** — the right-hand half of its
  direction of travel; traffic here keeps right. It sits where the corner arc has
  already ended and at least one metre behind the priority road's pavement, which
  is where people cross.
- **Give-way lines at the roundabout entries**, 23 across the seven: a broken
  line — 60 cm painted, 30 cm gap — a metre and a bit before the ring, on the
  same half.
- **They are loose quads, not ribbon rows.** Each marking is four vertices and
  two triangles written into its street's tile, with the same coarse height for
  the level relay and one and a half centimetres above the asphalt, like the
  roundabout's joint. Slipped between two ribbon rows they would have broken the
  eight-vertex stitching. Two new classes in the same shader: solid paint and
  paint broken along the transverse coordinate, with the same distance fade as
  the other markings.

**What it costs.** The roadway mesh goes from 964,208 to 983,240 triangles
(15,798 from the markings, the rest from the rows that had to be added where
none existed). On foot at a junction, from 740,308 to 741,322: 0.14 %. The whole
city, from 1,797,684 to 1,816,716 in the same 65 draw calls. No new call: the
markings live inside the roadway meshes.

**What is still missing:** cars and avatars still pass through each other; there
are no pedestrian crossings; and there is still not one frame-rate figure
measured on real graphics hardware.

## What's new in v0.10.10 — the palms stop being sent whole

Continues delivery 5 of the metaverse plan (`docs/METAVERSO.md`). **It does not
touch consensus, the network or the file formats.**

The palms were the last lump of the scene still sent whole: 925 palms in two
instanced meshes marked "never cull", 192,400 triangles to the card every frame
wherever you stood, 21 % of what is seen on foot at a junction. They now go in
**17 tiles of eight kilometres** — the same tile as the roadway since v0.10.8 —
each with its own instanced mesh and bounding sphere, and the one that does not
enter the view frustum is not sent:

| Framing | v0.10.9 | v0.10.10 | Draw calls |
|---|---|---|---|
| On foot at a junction | 914,196 | **740,308** (−19 %) | 18 → 17 |
| Neighbourhood, oblique | 914,196 | **756,740** (−17 %) | 18 |
| Roundabout, close | 1,052,124 | 904,444 (−14 %) | 18 |
| Palms, close | 1,142,494 | 1,014,574 (−11 %) | 19 → 21 |
| Walking through the junction | 989,866 | 824,714 (−17 %) | 24 → 25 |
| Walking among palms | 1,129,404 | 977,980 (−13 %) | 34 → 35 |
| Over a tile border | 950,358 | 797,270 (−16 %) | 18 |
| Whole city, top-down (worst case) | 1,799,556 | 1,797,684 | 50 → 65 |

- **One geometry.** There were two different palms — trunk leaning three or six
  degrees — in two meshes, and the lean belonged to the geometry: the trunk
  leaned and the crown stayed put, up to 75 cm away from it. Now there is one
  upright geometry, and the lean — one to seven degrees, different for every
  palm and in a different direction — goes in the instance matrix, with the
  scale and the yaw. The whole palm leans with its crown, and there is one mesh
  per tile instead of two.
- **The sphere is handed over ready-made.** Three r150 cannot compute the
  bounding sphere of an instanced mesh: it would compute it on the lone palm at
  the origin, and cull the whole tile the moment that point left the screen.
  Every tile carries a copy of the geometry with its sphere — centre and radius
  of the palm feet, plus thirteen metres of palm — because the sphere belongs to
  the geometry, not to the mesh.
- **The size came from measuring four.** Two kilometres give 138 tiles and 186
  draw calls in the worst case; four give 46 and 94; six give 26 and 74; eight
  give 17 and 65. The difference in triangles between sizes is 2 % of the
  scene; the difference in draw calls is threefold. Eight: the same as the
  roadway.

**What it costs.** The worst case — the whole city at once — pays 15 more draw
calls, 50 to 65, when a palm is under a pixel wide. And there are nine fewer
palms, 916 instead of 925: drawing a lean per palm shifts the sequence and nine
land where they do not grow.

**A corrected figure.** The v0.10.9 notes said the palms were 44 % of the
triangles. That number assumed the shadow pass drew them a second time; measured
by switching it off, in the framings of the table that pass draws nothing.
Hiding the palms leaves the scene at 721,796 triangles, which is exactly 914,196
minus 925 × 208: they were 21 %.

**What is still missing:** there are no stop or give-way lines painted, and there
is still not one frame-rate figure measured on real graphics hardware: here
everything is measured in submitted triangles and draw calls.

## What's new in v0.10.9 — the turning radius of the corners

Closes delivery 5 of the metaverse plan (`docs/METAVERSO.md`). **It does not
touch consensus, the network or the file formats.**

v0.10.7 resolved the junctions: priority, gap and dropped kerb. But the street
that gives way met the priority road **at a right angle**, and the priority
road's pavement was cut square across the mouth. No car turns through a junction
like that: it is a set square, not a corner.

Now all **4,505 junctions** have a real turning radius, four to nine metres
depending on the width of the narrower of the two streets.

- **The kerb describes a quarter circle** tangent to the other street's kerb.
  Not a chamfer, not an approximate rounding: the exact arc that separates the
  two roadways, and **both streets use the same formula**, so their edges travel
  the same arc and meet on it instead of crossing. All four corners of every
  junction come out alike.
- **The arc's natural measure is not the distance to the cut but the
  perpendicular distance to the other road's axis**: it is worth the full radius
  at the edge of that road's carriageway and dies R metres further out. Starting
  from where the ribbon ends — the first attempt — opened the mouths by eight
  metres instead of one and a half, and left spikes where the two flares crossed.
- **The arc is divided by angle, not by length.** Four cuts at 0, 29, 60 and
  100 per cent of the run keep the arc's sagitta under ten centimetres. Divided
  by length it was over a metre and the corner read as a chamfer again, with the
  same number of rows.
- **And the buildings know:** the widened mouth takes up ground too, so nobody
  builds inside it, just as was already true of the streets and the roundabouts.

**What it costs, and where.** The roadway mesh goes from 524,860 to 964,208
triangles. But since v0.10.8 that mesh is split across tiles that cull
themselves, so **on foot the cost rises by 3.7 %** — from 881,408 to 914,196
submitted triangles, in the same 18 draw calls — which is exactly where the
corner is seen. The worst case, the whole city at once, goes from 1,360,208 to
1,799,556 in the same 50 calls; there a corner is half a pixel wide. That is
precisely the budget v0.10.8 freed up.

**What is still missing:** there are no stop or give-way lines painted, and the
palms — 44 % of the scene's triangles — are still two instanced meshes that are
not culled.

## What's new in v0.10.8 — the streets stop being sent whole

Continues delivery 5 of the metaverse plan (`docs/METAVERSO.md`). **It does not
touch consensus, the network or the file formats.**

The junctions in v0.10.7 took the scene from 1,063,212 to 1,367,614 triangles,
and the entire roadway lived in **one** mesh marked "never cull this": half a
million triangles going to the card every frame, wherever you look. Walking
through a neighbourhood you see less than two per cent of the city, so the rest
was wasted work.

The roadway is now split across **43 tiles of eight kilometres**, each with its
own mesh and bounding sphere, and whatever falls outside the view frustum is not
sent:

| View | Before | Now |
|---|---|---|
| On foot at a junction | 1,367,614 tri · 17 calls | **881,408** tri · 18 calls |
| Neighbourhood, oblique | 1,367,614 tri · 17 calls | **881,408** tri · 18 calls |
| Roundabout, close up | 1,367,614 tri · 17 calls | **949,966** tri · 18 calls |
| On top of a tile boundary | 1,367,614 tri · 17 calls | **894,806** tri · 18 calls |
| Whole city, top down | 1,367,614 tri · 17 calls | 1,360,208 tri · **50** calls |

At street level **a third less scene is submitted for one extra draw call**. The
worst case — the whole city at once, which is exactly when the roadway is a
pixel wide — pays 33 extra calls.

**The tile size is not a number picked by eye: four of them were measured.** At
4 km the worst case was 106 calls; at 6 km, 66; at 12 km an extra 130,000
triangles slipped through on foot. Eight is where the street-level saving is
already complete and the worst case is still cheap.

**No seams.** A ribbon crossing a tile boundary repeats its last row in the new
tile and stitches the section there, so there is neither a gap nor a section
drawn twice. Checked with a screenshot taken right on top of a boundary.

**What is not measured, and must be said.** The saving is in submitted triangles
and draw calls, **not in milliseconds**: the environment this project is built
in has no graphics card to time it on, so nobody has yet checked that the 33
extra calls of the worst case cost less than the 480,000 triangles saved on foot.

**What is still missing:** the palms — 44 % of the scene's triangles — are still
two instanced meshes that are not culled either. That one is next.

**And a test that brought down a release.** The v0.10.7 release failed on its
first attempt because of `rami-net::tests::oversized_frame_disconnects_peer`,
which read the peer counter at the exact moment it received the disconnection
event. That counter is a snapshot refreshed one step later, so under load the
test fell inside the window. It was not a product bug: the peer table was always
correct. The assertions that follow an event now wait for the counter instead of
reading it once. Only the tests change.

## What's new in v0.10.7 — the junctions

Delivery 5 of the metaverse plan (`docs/METAVERSO.md`). **It does not touch
consensus, the network or the file formats.**

v0.10.6 put streets inside the neighbourhoods, but every street was drawn whole
and on its own. Where two of them crossed — and with a neighbourhood grid that
happens every hundred and fifty metres — the two roadways sat one on top of the
other: two eighteen-centimetre kerbs cutting across each other's asphalt, and
the pavement blocking the cars. That is over: **4,505 junctions resolved** across
the city, and seven roundabouts.

- **Priority.** One of the two is in charge at every junction. Rank decides it
  with no ambiguity: open-map roads outrank any deduced street, and among equals
  the wider one wins; on an exact tie, the lower index, which is a fixed order.
  The same pair is resolved the same way on every machine.
- **The gap.** The street that gives way disappears inside the width of the one
  in charge, instead of being drawn underneath it. The ribbon ends right at the
  other's outer edge, not one resampling step earlier.
- **The dropped kerb.** The kerb of the priority road comes down to the roadway
  at the mouth of the other one, over a metre and a half, which is what a real
  dropped kerb does. Its centre line and lane markings stay painted through the
  junction; those of the street that gives way do not.
- **Roundabouts.** Where two open-map arteries of the same order cross, neither
  is in charge: there goes a ring of unmarked asphalt — seven to fourteen metres,
  the roadway of a single direction — with its kerb and its pavement island. The
  two roads are cut on the chord whose ends fall on the circle, so the mouths fit
  without biting or overlapping. The ring sits a centimetre and a half higher,
  like a real asphalt joint, and is levelled over a disc wider than the levelling
  of any section that touches it: no roadway pokes out from under it.
- **And the buildings know.** A roundabout takes up ground: nothing is built
  inside one, just as was already true of the streets.

**What it costs.** The junctions take the scene from 1,063,212 to 1,367,614
triangles at medium quality, in the same 17 draw calls. All of that geometry is
in the roadway mesh, which does not cast shadows — it only receives them — so it
is drawn once per frame, not twice.

**What is still missing:** the corners have no turning radius, there are no stop
or give-way lines painted, and the real half of the streets is still waiting for
an OpenStreetMap extract in the repository.

## What's new in v0.10.6 — neighbourhood streets, and city blocks

Delivery 4 of the metaverse plan (`docs/METAVERSO.md`). **It touches neither
consensus, nor the network, nor the file format.**

Until now Dubai had 21 motorways and, inside the districts, sand: the towers
were scattered at random over the desert. Now there is **urban fabric**.

- **Every district has its own street grid**, with its own rotation and spacing.
  It comes from no file: it is **deduced** with the same integer arithmetic as
  the rest of the city, from the cell the district sits in. That means it is
  identical on every machine and never changes. 34 districts, each with its
  grid, and the spacing and width depend on what is built there: 165 m between
  16 m streets in tower districts, 120 m between 10 m streets among the villas,
  210 m between 18 m streets in the industrial estates.
- **The blocks emerge on their own.** A building is no longer planted in the
  middle of the street: if the spot it drew falls on the grid, it looks for
  another. So buildings gather in the gaps the grid leaves, which is exactly how
  a city grows. Of 3,124 towers, only 18 found nowhere to go.
- **The ribbon is cut where it should be.** A street that reaches water or the
  edge of the map stops being drawn instead of stitching across the gap.

**What is missing, and why.** The chosen plan was to mix real OpenStreetMap
streets with deduced ones. The network of the environment this project is built
in **cannot reach OpenStreetMap**: it refuses Overpass, Nominatim, Geofabrik and
the tile servers. So this version brings the deduced half — which was needed
either way — and the real half stays pluggable: as soon as a Dubai extract is in
the repository, its named roads join the same list and win where they exist.

## What's new in v0.10.5 — the ground stops being flat colour

Delivery 3 of the metaverse plan (`docs/METAVERSO.md`). **It touches neither
consensus, nor the network, nor the file format.**

Until now every surface was a flat colour with a little noise on top: two metres
from the ground, asphalt and pavement were the same grey at different
brightness. Now there are **real materials**.

- **Four tileable textures**, 512×512 each: asphalt with aggregate, pores and
  cracks; concrete with pores and staining; sand with fine grain and wind
  ripples; and 60 cm pavement slabs with a recessed joint and **a tone of their
  own per slab**, which is what gives away real paving against a smooth surface.
  In each file the colour is in the RGB and **the height in the alpha**: one PNG
  per material instead of colour plus normal, half the download.
- **They belong to nobody.** `tools/textures/make_materials.py` makes them with
  the Python standard library, deterministically, and they carry no third-party
  licence. The download grows by 1.6 MB.
- **The colour is sRGB-encoded**, as it should be: the client has had a physical
  colour channel since v0.10.0 and converts to linear before lighting. Storing
  it raw would have left the asphalt ten times too dark.
- **The sand has relief.** The terrain normal comes from differentiating the
  texture's height, so the desert ripples really catch a low sun instead of
  being a flat drawing.

**Why generated and not photographic:** the environment this project is built in
cannot reach the public-domain sources — the network refuses them — and putting
art with an unverified licence into the repository is not an option. If a CC0
photographic set ever arrives, those four files are replaced and that is all:
the shader does not change.

## What's new in v0.10.4 — the roadway

Delivery 2 of the metaverse plan (`docs/METAVERSO.md`). **It touches neither
consensus, nor the network, nor the file format.**

The map's 21 roads were drawn as **one-pixel** lines floating three metres above
the ground: from far away they looked like roads, from close up they were a
wire. Now they are real geometry.

- **A ribbon with a profile.** Each road is resampled every 100 metres and
  raised with an eight-point cross-section: sidewalk, kerb with a vertical face,
  roadway, and the same on the other side. The width comes from its length,
  because the open map carries no hierarchy: 42 metres for trunk roads, 26 for
  arterials, 15 for secondary. 602 kilometres of road, 65,268 triangles, **not
  one extra draw call** (the old line spent two, being double-sided and
  transparent; the roadway spends one, being opaque).
- **Analytic lane markings.** The centre line, the lane lines and the dashes are
  not a texture: they come from the across-track coordinate — metres from the
  centre line — and the along-track one — metres travelled — which every vertex
  carries. They cost four instructions and **zero bytes of download**, and they
  fade out with distance so they do not shimmer.
- **The grade is levelled.** A road section is horizontal from side to side and
  straight between sections; if every point hugged its own height, the 100-metre
  chord would sink below any bump and the terrain would bite the roadway into
  pieces. It is levelled to the highest ground in a nine-point cross, which is
  exactly what a real cutting does.

**What this does NOT bring:** the open map only has Dubai's 21 main roads.
Inside the districts there are **still no streets**: downtown is crossed on sand
between the buildings. City streets are another job and another dataset.

## What's new in v0.10.3 — buildings stop being smoke

Delivery 1 of the metaverse plan (`docs/METAVERSO.md`). **It touches neither
consensus, nor the network, nor the file format.**

Until now the city existed for the eyes only: you walked straight through the
towers, and pointing at something only told you which 650-metre parcel you were
over, never which building was in front of you. Without those two things there
can be no doors to cross, no cars to get into and no shop windows to look at, so
it was the first brick of everything else.

- **The solid register.** The 56 landmarks and the 3,124 skyline towers now have
  a footprint — centre, size, rotation and height — in a 256-metre spatial grid.
  One structure that solves both problems: **3,180 buildings** queryable in
  constant time.
- **Buildings stop you.** On foot you no longer walk through them. Walking into
  the south face of the Burj Khalifa leaves you exactly 75 metres from its
  centre, which is where its facade ends. Flying above its height, you pass.
- **Pointing says what it is.** The mouse ray now hits the building before the
  ground, so the status line reads «🏢 Burj Khalifa · 829 m» instead of just the
  parcel. On generic buildings, the type and the district.
- **Arriving on foot no longer drops you inside a tower.** The code that avoided
  this only looked at the 56 landmarks; it now looks at all 3,180, and landing
  inside one of the 3,124 skyline towers was 56 times likelier than what was
  being avoided.
- **The seed contract.** The boundary that orders everything ahead is now in the
  code: a building's **shape** comes only from data that never changes — its
  position on the grid — and its **clothing** (tone, sign, lights) comes from
  what the chain moves: owner and age. So a tower is not rebuilt whole when
  someone sells a flat, but two identical towers with different owners do not
  look the same. Both are integer arithmetic: the same number on any machine.

## What's new in v0.10.2 — the city runs loose, and the plan for what comes next

A foundations release. **It touches neither consensus, nor the network, nor the
file format**, and the city looks exactly the same: what changes is what it
costs to draw it.

| | Before | After |
|---|---|---|
| Triangles per frame (medium quality) | 1,184,610 | 842,970 (−28.8%) |
| Draw calls | 18 | 17 |
| Shader programs | 17 | 16 |
| Downloadable binary | 7,104,616 B | 6,551,976 B (−7.8%) |

- **The palm trees were 44% of the scene.** And 77% of each palm was the bunch
  of dates: a 440-triangle sphere seven metres up, which at that distance nobody
  tells apart from an 80-triangle one. The palm layer drops from 525,400 to
  192,400 triangles. Since they were also 89% of the shadow pass, that pass —
  which never shows in the stats because it is drawn before the counter resets —
  falls by almost half. The 24 cabins of the observation wheel, the same.
- **The ground drape and the parcel borders were drawn twice.** three.js
  reserves two passes for every double-sided transparent material unless told
  they are not needed; here they are not, because the drape hugs the ground and
  is never seen from inside.
- **Debug symbols leave the binary.** Nobody uses them in a download, and they
  were paid for on every update.
- **`docs/METAVERSO.md`**: the metaverse plan — the eight deliveries ahead, what
  each costs, what is dropped and why, and what the plan does not fix. It comes
  out of six architectures designed independently, each one then handed to a
  verifier whose job was to refute it with the code in front of them.

## What's new in v0.10.1 — opening Dubai now shows Dubai

A fix to the 3D client. **It touches neither consensus, nor the network, nor
the file format**: 0.10.1 and 0.10.0 are the same chain, and the activation
date of 1 December 2026 (00:00 UTC) still stands.

Opening the Dubai tab showed a grid of parcels over empty sand, and a black
screen at night. The city was built — the 56 landmarks and the 3,124 towers —
but it was not visible. Why, and what was done:

- **The opening shot was the whole emirate.** The camera started more than
  20 km out, so a 300 m tower covered one pixel and all that was left of Dubai
  was sand, roads and the grid. It now opens on the **downtown skyline**, with
  the Burj Khalifa against the sky. The three framings are in the toolbar:
  «🌇 Downtown», «🌆 Dubai» (the emirate) and «▦ Parcels».
- **Windows only appeared on the 56 landmarks.** Instanced towers are built
  from a unit box scaled to their height, and the shader read the unscaled
  local coordinate: it never went above 1, so the test that turns on windows,
  floor slabs and glass («above 5 m») was false on **all** of them and they
  drew as plain boxes. It now measures the height above the building's base:
  the whole city has a facade, by day and by night.
- **Night was black.** The physical sky gives almost zero once the sun sets,
  and the exposure closed down on top of that. Lit windows now lead, there is a
  warm **city glow** in the ambient light and the exposure opens at night, the
  way an eye does. On real Dubai time, at 22:00 you see a lit city.
- **The parcel grid covered the city.** Those 1,024 coloured squares on the
  ground are the tool for buying, not the landscape. They are now **off**, and
  «▦ Parcels» or a click on any parcel turns them on.
- **City ground.** Elevation data knows nothing about asphalt, so the towers
  stood on smooth desert; the ground of every built-up district is now tinted
  city (and green in the villa ones).
- **Shadows at medium quality**, the one that ships by default: it was the
  most noticeable feature and it was reserved for «high».
- **The controls are spelled out.** The first time, a line appears over the
  viewer: drag to turn, wheel to zoom, click a parcel, «🚶 On foot» with WASD
  and «🥽 VR headset». In five languages, and it does not come back.

## What's new in v0.10.0 — identity on the chain, the multiverse as cities and a more real Dubai

**Update before 1 December 2026 (00:00 UTC).** 0.10.0 talks to 0.9.0 and
0.8.0 until that date; from then on the Dubai rules (`docs/DUBAI.md`) apply
plus the player profile. A 0.9.0 binary stays at its height, without
breaking, at the first block that carries a profile.

- **Player profile on the chain** (`docs/MULTIVERSO.md`, §1). A new
  transaction, `SetProfile`, registers a **unique name** (3–20 characters
  `a-z`, `0-9`, `_`; 2 RAMI burned when registering or changing it), a display
  name, an introduction, an avatar style and a colour. Optionally it **binds
  your node identity** — the one that signs your presence and chat — to your
  account, and consensus verifies that signature: your avatar carries your
  name with ✓ and nobody can walk around with it. `Status.rule` announces 4.
- **Player card and source code.** Dashboard → Dubai → "My player profile"
  and "Players": companies with their accounts, assets, balance, income, and
  a code like the peers' ("C1"): a letter for the chain's facts (companies,
  income, age) and a number for what this node observes now (avatar present,
  with or without a link). It describes; it does not decide. `rami-wallet
  profile` from the terminal.
- **The multiverse.** Every tip of the tree is a complete city
  (`GET /api/city/multiverse`, `GET /api/city?tip=`). Whatever exists in
  another branch and not in the observed one is drawn **in superposition**
  (translucent buildings with their branch in the label) until consensus
  collapses towards one; you can visit any branch from the dashboard. None of
  this touches consensus or the network.
- **Graphics.** Physical colour pipeline (linear + ACES + sRGB); sky by
  **atmospheric scattering** with haze and a sun disc, and the same formulas
  for fog and ambient light; sky reflections on glass and water (cube map);
  **real shadows** from sun and moon on terrain and buildings; facades with
  floor slabs and windows that light up at dusk; sea with depth read from the
  relief and foam on the shore; sand with fine relief; palm trees; cars with
  a cabin and headlights; **articulated avatars** that walk, with four styles
  (casual, kandura and ghutra, abaya, suit) and 16 colours. On foot you start
  on the street, in front of the parcel.
- **Review and fixes.** A per-subsystem review of this very change left five
  confirmed defects, fixed here: the ✓ now carries the **unique name** and not
  the display name (free text, not unique: it served to imitate another
  player); `rami-wallet` checks **every** transaction against
  the consensus rules before writing it to the mempool (it used to announce
  "sent" for a transaction that would never enter a block) and validates
  `--avatar`, `--color`, `--display` and `--bio`; the dashboard no longer
  downgrades an avatar style of 4–15 set from the terminal to 0–3; buildings,
  landmarks, cars, palm trees and avatars now **receive** shadows (they only
  cast them before); and the per-district skyline tones are linearised like
  the rest of the palette.
- **Compatibility.** No existing file changes format;
  `tools/compat/roundtrip.sh` stays green with v0.7.0. A 0.9.0 binary that
  opens a `chain.jsonl` with profiles does not read it: the way out is to
  update.

## What's new in v0.9.0 — RAMI Dubai: the metaverse as consensus rules, with an activation date

**Update before 1 December 2026 (00:00 UTC).** Until that date nothing
changes: 0.9.0 talks to 0.8.0, signs the same way (rule v2 still activates on
20 October), mines the same way and opens the same files. From that date on
the Dubai rules apply and older nodes stay at their height without breaking.

- **RAMI City moves to Dubai.** 64×64 parcels of 650 m on a replica built
  from open data (Mapzen/AWS Terrain Tiles relief; Palm Jumeirah, The World,
  Bluewaters, the Creek and the canals drawn by hand and documented as
  such), 56 landmarks modelled one by one, skylines per district, traffic on
  the main roads, a day/night cycle with lit windows. Your parcels keep their
  (x, y) coordinates.
- **New consensus rules** (`docs/DUBAI.md`): 35 districts with their own
  parcel price (burned), 30 sectors that need one another, a city fund fed
  with 20 % of every block's issuance and a payout of 1 % of the fund per
  block by demand, district, affinity and inputs; 40 % of every income pays
  the nearest suppliers and whatever nobody offers is imported and burned.
  The miner reward drops to 80 % of the issuance; fees stay whole. Activation
  by date, no mixed period, never going back within a branch; `Status.rule`
  announces 3.
- **A market in RAMI.** Parcels and assets (plant, object, vehicle — minted
  only by a car dealership — and premises) are listed and bought in a single
  transaction with a maximum price. The last 256 trades stay in the state and
  feed the **internal quotation**: parcel/RAMI pairs per district and
  asset/RAMI pairs, open asks, fills, fund, burned and an index. A **Market**
  tab in the dashboard, `rami-node market` (a public read-only API in
  aggregator format) and a **Quotation** tab on the website, which reads the
  nodes listed in `web/market.json`. RAMI is not quoted in euros or in any other
  cryptocurrency; `docs/COTIZACION.md` states what it would take outside the
  software.
- **The mentor and the business school.** A public rule (not a person)
  computes, with the same payout functions, what each sector would earn today
  on the chosen parcel, which inputs the city lacks, how many competitors
  there are and in how many blocks the entry price is recovered; it answers
  typed questions and offers eight short lessons. Figures of the current
  state, not promises.
- **People in the city.** Avatars and chat among connected visitors, over
  the RAMI tunnel, signed with the node identity and bounded in rate, size
  and memory; nothing is stored and nothing enters consensus. **Walk** mode
  (WASD, drag to look, Q/E to fly) and **VR headsets** with controllers
  (stick to walk, snap turn, trigger to teleport) and a high framebuffer
  scale in "ultra" quality for 4K displays; quality presets and time of day
  in the city toolbar.
- **Compatibility.** The protocol is still v2 and no existing file changes
  format; `tools/compat/roundtrip.sh` stays green with the v0.7.0 and v0.7.3
  binaries. A v0.8.0 binary that opens a `chain.jsonl` written by 0.9.0 with
  market transactions does not read it (over the network it never receives
  them): the way out is to go back to 0.9.0.

## Novedades de v0.8.0 — la firma ligada a la red: primer cambio de consenso, con fecha de activación

**Actualiza antes del 20 de octubre de 2026 (00:00 UTC).** Hasta esa fecha
nada cambia: la 0.8.0 se habla con la 0.7.0 y la 0.7.3, firma igual, mina
igual y abre los mismos archivos (probado con los binarios reales, ver abajo).
Desde esa fecha, la firma de cada transacción lleva dentro el identificador de
la red y los nodos anteriores dejan de seguir la cadena: no se rompen, se
quedan en su altura hasta que se actualizan.

- **La regla v2.** El mensaje firmado pasa de `"RAMI-CHAIN/tx/v1" || cuerpo`
  a `"RAMI-CHAIN/tx/v2" || network‑id || cuerpo`. Una transacción firmada
  para la testnet no vale en regtest ni en ninguna otra red (era el pendiente
  documentado en `SECURITY.md` desde la 0.7.1). El txid no cambia de fórmula.
- **Activación por fecha, sin periodo mixto.** La regla la fija el timestamp
  del bloque frente a la fecha de los parámetros de la red: antes, v1 y solo
  v1; desde, v2 y solo v2. Y **no retrocede dentro de una rama**: una vez que
  un bloque exige v2, todos sus descendientes la exigen, lleven el timestamp
  que lleven (así nadie cuela firmas v1 tras la fecha). Regtest no tiene
  fecha salvo que la fuerces con `--firma-v2-desde <unix>` en `rami-node`,
  `rami-wallet` y `rami-gui`.
- **Mempool y monedero.** El nodo admite cada transacción bajo la regla que
  rige ahora, el minero solo incluye lo que vale para el timestamp del bloque
  y, al cruzar la fecha, poda lo que quedó firmado con v1 (su nonce sigue
  libre: hay que **volver a enviar** lo que estuviera pendiente justo
  entonces). Las carteras firman con el contexto que les da el nodo.
- **Lo que ve la red, en el panel.** `Status` anuncia la regla que entiende
  cada nodo (campo nuevo `rule`, que las versiones anteriores ignoran; el
  protocolo sigue siendo el v2). Red → «📜 Regla de firma» enseña los hechos:
  regla vigente, fecha y cuenta atrás, pares que anuncian v2, pendientes
  fuera de regla; y un juicio aparte («todos los pares conectados anuncian
  v2…»). Cada par que no anuncie v2 lleva el motivo en su código de fuente.
- **Lo que se dice entero.** La cadena no acota el timestamp de los bloques
  (pendiente anterior, ahora escrito en `SECURITY.md`): un minero puede
  adelantar la activación para su rama con un timestamp futuro; no puede
  retrasarla. Detalle, pruebas y lista para operadores en
  `docs/CONSENSO-V2.md`.
- **Compatibilidad probada con los binarios reales.** `tools/compat/roundtrip.sh`
  (CI) añade un cuarto paso: la nueva fuerza la activación en regtest, envía
  una tx v1 y otra v2 y mina; la misma versión sin la fecha no admite esos
  bloques; la **v0.7.0** abre el directorio, avisa de los bloques que no
  entiende, lee el saldo, mina su rama y arranca el nodo sin caerse; y la
  nueva vuelve a abrir lo que la v0.7.0 escribió. El mismo recorrido se
  ejecuta contra la **v0.7.3**. `tests/compat_v070.rs` sigue en verde y
  `activacion_v2.rs` prueba la activación con las piezas reales.

## Novedades de v0.7.3 — la palabra exacta: fuentes graduadas, hechos junto a los juicios, predicciones con término

Esta versión no cambia el consenso, no cambia el protocolo (la v0.7.0 y la
0.7.3 se hablan) y **no cambia el formato de ningún archivo**: lo nuevo son dos
archivos nuevos que las versiones anteriores ignoran. Si vienes de la v0.7.0
(la última publicada; la 0.7.1 y la 0.7.2 nunca se publicaron), tu monedero,
tu cadena, tus pares y tus reveals se abren tal cual — y se ha probado con los
binarios reales de la v0.7.0, en las dos direcciones (ver abajo).

- **Los pares, graduados como fuentes (código Admiralty).** En Red → Pares,
  cada par lleva un código como «B2»: una **letra por su historial** (bloques
  suyos válidos e inválidos; A, fiable con historial largo … F, sin historial;
  un cambio de identidad pone tope en C) y un **número por esta sesión** (1,
  una punta suya está en tu árbol y la anuncia otro par … 6, sin nada
  todavía). Pasa el ratón para ver los motivos. Describe, no decide: cada
  bloque se revalida igual venga de quien venga. El historial vive en
  `peer-grades.json` (archivo nuevo, tope 256 pares).
- **«Sincronizado» ya no va solo.** Al lado, el hecho: tu altura, la mejor
  altura de los pares y cuántos bloques faltan. La autoauditoría separa
  también *juicio* (✓/✗ y nombre) de *hecho* (lo observado, con su duración).
- **Predicciones con la palabra exacta.** Al comprometer una predicción
  puedes decir con qué probabilidad la afirmas con la escala de siete
  términos (ICD 203): «probable (55–80 %)», nunca un porcentaje suelto ni 0 ni
  100. El término va dentro del payload (bytes opacos: ninguna regla cambia).
  Un **libro local** (`predicciones-libro.json`, archivo nuevo) apunta cada
  predicción con término; cuando sepas el desenlace, márcalo, y el libro te
  dice si tus «probable» ocurren entre el 55 y el 80 % de las veces (Brier y
  tabla por término). Mide si tus palabras significan lo que dicen; no mide
  acierto ni rentabilidad. Nada sale de tu ordenador.
- **Léxico vigilado en cinco idiomas.** `tools/panel/lexico.py` recorre el
  panel (español, inglés, chino, ruso, suajili), la web, el README y estas
  notas, y el CI falla si aparece «podría», «quizá», «might», «likely»,
  «可能», «возможно», «labda»… Se permite un término de la escala con su
  rango. Una frase del panel que decía «tus claves podrían seguir dentro»
  ahora dice lo que es: «tus claves siguen dentro y este programa no las
  toca».
- **La web es un mapa, no una lista.** Un mapa orbital con el génesis en el
  centro y las piezas alrededor (consenso, cuentas, commit-reveal, universo
  de ramas, UBR, colapso, túnel, nodo, monedero, panel, actualizador,
  autoauditoría, Ciudad, faucet, y las dos novedades) con las líneas de
  «quién alimenta a quién»; cada nodo abre su apartado sin recorrer la página
  entera. Los enlaces guardados (#descargas, #teoria…) siguen funcionando;
  a menos de 640 px el mapa degrada a una rejilla con una lista textual.
- **Enlaces a pestañas del panel:** `…/#red`, `…/#predicciones` abren esa
  pestaña.
- **Compatibilidad probada con los binarios de verdad.** Un test carga
  ficheros escritos por la v0.7.0 (keystore cifrado y plano, cadena regtest,
  mempool, reveals, pares, identidades, `node.key`, faucet) y el CI ejecuta
  `tools/compat/roundtrip.sh`: la v0.7.0 escribe, la 0.7.3 abre y escribe
  encima, y la v0.7.0 vuelve a abrir lo que dejó la 0.7.3 (verifica la
  cadena, lee el saldo, revela un commit hecho por la nueva y arranca su
  nodo). Si un cambio de formato rompiera la actualización —o la vuelta
  atrás—, el CI se pone en rojo.

## What's new in v0.8.0 — the signature bound to the network: first consensus change, with an activation date

**Update before 20 October 2026 (00:00 UTC).** Until that date nothing
changes: 0.8.0 talks to 0.7.0 and 0.7.3, signs the same way, mines the same
way and opens the same files (tested with the real binaries, see below). From
that date on, every transaction signature carries the network identifier
inside it and older nodes stop following the chain: they do not break, they
stay at their height until they update.

- **Rule v2.** The signed message goes from `"RAMI-CHAIN/tx/v1" || body` to
  `"RAMI-CHAIN/tx/v2" || network‑id || body`. A transaction signed for the
  testnet is worthless on regtest or any other network (the open item
  documented in `SECURITY.md` since 0.7.1). The txid formula does not change.
- **Activation by date, no mixed period.** The rule is set by the block's
  timestamp against the network parameters' date: before it, v1 and only v1;
  from it, v2 and only v2. And **it never goes back within a branch**: once a
  block requires v2, every descendant requires it whatever its timestamp
  (so nobody slips v1 signatures in after the date). Regtest has no date
  unless you force one with `--firma-v2-desde <unix>` on `rami-node`,
  `rami-wallet` and `rami-gui`.
- **Mempool and wallet.** The node admits each transaction under the rule in
  force now, the miner only includes what is valid for the block's timestamp
  and, when the date is crossed, prunes what was left signed with v1 (its
  nonce stays free: whatever was pending right then must be **sent again**).
  Wallets sign with the context the node gives them.
- **What the network sees, on the dashboard.** `Status` announces the rule
  each node understands (new `rule` field, ignored by older versions; the
  protocol is still v2). Network → "📜 Signature rule" shows the facts: rule
  in force, date and countdown, peers announcing v2, pending outside the
  rule; and a separate judgement ("every connected peer announces v2…").
  Every peer that does not announce v2 carries the reason in its source code.
- **Said in full.** The chain does not bound block timestamps (an older open
  item, now written down in `SECURITY.md`): a miner can bring activation
  forward for its branch with a future timestamp; it cannot push it back.
  Details, tests and the operator checklist are in `docs/CONSENSO-V2.md`.
- **Compatibility tested with the real binaries.** `tools/compat/roundtrip.sh`
  (CI) gains a fourth step: the new version forces activation on regtest,
  sends a v1 and a v2 transaction and mines; the same version without the
  date does not admit those blocks; **v0.7.0** opens the directory, reports
  the blocks it does not understand, reads the balance, mines its own branch
  and starts its node without crashing; and the new version reopens what
  v0.7.0 wrote. The same run is executed against **v0.7.3**.
  `tests/compat_v070.rs` stays green and `activacion_v2.rs` tests activation
  with the real pieces.

## What's new in v0.7.3 — the exact word: graded sources, facts next to judgements, predictions with a term

This release does not change consensus, does not change the protocol (v0.7.0
and 0.7.3 talk to each other) and **does not change the format of any file**:
what is new are two new files that older versions ignore. If you come from
v0.7.0 (the last published version; 0.7.1 and 0.7.2 were never published), your
wallet, your chain, your peers and your reveals open as they are — and it has
been tested with the real v0.7.0 binaries, in both directions (see below).

- **Peers graded as sources (Admiralty code).** In Network → Peers, every
  peer carries a code such as "B2": a **letter for its history** (its valid
  and invalid blocks; A, reliable with a long record … F, no history; an
  identity change caps it at C) and a **number for this session** (1, one of
  its tips is in your tree and another peer announces it too … 6, nothing
  yet). Hover to see the reasons. It describes, it does not decide: every
  block is re-validated the same way whoever it comes from. The history lives
  in `peer-grades.json` (new file, 256-peer cap).
- **"Synced" no longer stands alone.** Next to it, the fact: your height,
  the best peer height and how many blocks are missing. The self-audit also
  separates *judgement* (✓/✗ and name) from *fact* (what was observed, with
  its duration).
- **Predictions with the exact word.** When you commit a prediction you can
  say how probable it is with the seven-term scale (ICD 203): "probable
  (55–80 %)", never a bare percentage and never 0 or 100. The term travels
  inside the payload (opaque bytes: no rule changes). A **local ledger**
  (`predicciones-libro.json`, new file) records every prediction with a term;
  when you know the outcome, mark it, and the ledger tells you whether your
  "probable" happens between 55 and 80 % of the time (Brier and a per-term
  table). It measures whether your words mean what they say; it does not
  measure hit rate or returns. Nothing leaves your computer.
- **Lexicon watched in five languages.** `tools/panel/lexico.py` walks the
  dashboard (Spanish, English, Chinese, Russian, Swahili), the website, the
  README and these notes, and CI fails if "podría", "quizá", "might",
  "likely", "可能", "возможно", "labda"… appear. A scale term with its range
  is allowed. One dashboard sentence that said "your keys may still be inside"
  now says what it is: "your keys are still inside and this program does not
  touch them".
- **The website is a map, not a list.** An orbital map with the genesis at
  the centre and the pieces around it (consensus, accounts, commit-reveal,
  branch universe, UBR, collapse, tunnel, node, wallet, dashboard, updater,
  self-audit, City, faucet, and the two new pieces) with the lines of "which
  feeds which"; each node opens its section without scrolling the whole page.
  Saved links (#descargas, #teoria…) keep working; below 640 px the map
  degrades to a grid with a textual list.
- **Links to dashboard tabs:** `…/#red`, `…/#predicciones` open that tab.
- **Compatibility tested with the real binaries.** A test loads files written
  by v0.7.0 (encrypted and plain keystore, regtest chain, mempool, reveals,
  peers, identities, `node.key`, faucet) and CI runs
  `tools/compat/roundtrip.sh`: v0.7.0 writes, 0.7.3 opens and writes over it,
  and v0.7.0 reopens what 0.7.3 left (verifies the chain, reads the balance,
  reveals a commit made by the new version and starts its node). If a format
  change broke the update — or the way back — CI goes red.

## Novedades de v0.7.2 — arreglo urgente: el panel dejaba fuera a quien lo tenía abierto al actualizar

Si actualizaste a la v0.7.1 con el panel abierto en el navegador, al recargarse
te decía «sesión no autorizada» y, peor todavía, te enseñaba el cuadro de
**crear contraseña** encima de un monedero que estaba intacto. No se perdió nada
—ni claves, ni saldo, ni cadena—, pero no había forma de entrar desde esa
pestaña. Esto lo arregla y lo deja arreglado:

- **La llave de sesión ya no cambia en cada arranque.** El monedero reutiliza
  la que guarda en `~/.rami/panel-<puerto>.token` (permisos 0600, solo tu
  usuario) y solo crea una nueva si falta o está corrupta. Antes se generaba
  una llave nueva cada vez, así que la pestaña que ya estaba abierta mandaba la
  vieja. Rotarla en cada arranque tiene sentido cuando el cliente puede leer un
  archivo (el `.cookie` de Bitcoin Core); aquí el cliente es un **navegador**, y
  un navegador no puede.
- **El panel recuerda la llave del navegador, no de la pestaña.** Se guarda en
  `localStorage` por puerto, así que un marcador, una pestaña reabierta o el
  navegador reiniciado siguen funcionando. Las pestañas que vengan de la v0.7.1
  se migran solas.
- **Nunca más «crea una contraseña» encima de un monedero que existe.** Sin
  llave, `/api/status` solo devuelve versión, pid y red; el panel ahora lo
  detecta en vez de leerlo como «aquí no hay monedero».
- **Si aun así te quedas sin llave, el panel te lo explica y te saca:** una
  pantalla te dice que tu dinero está intacto, que lo fácil es abrir RAMI-Chain
  desde su icono, y te deja pegar el contenido del archivo del token si
  prefieres arreglar esa misma pestaña. En los cinco idiomas.
- **Tres tests de regresión** (`token_survives_a_restart`,
  `corrupt_token_file_is_replaced`, `reused_token_file_stays_private`) para que
  no vuelva a pasar: la llave sobrevive a los reinicios, un archivo corrupto se
  sustituye sin dejarte fuera, y reutilizarla no relaja los permisos.

Si estás bloqueado ahora mismo, sin actualizar: cierra la pestaña y abre
RAMI-Chain desde su icono (la app siempre abre el panel con la llave puesta).

## What's new in v0.7.2 — hotfix: the dashboard locked out anyone who had it open while updating

If you updated to v0.7.1 with the dashboard open in your browser, the reload
said "unauthorised session" and, worse, showed the **create a password** box on
top of a wallet that was perfectly intact. Nothing was lost — not keys, not
balance, not chain — but there was no way back in from that tab. This fixes it
and keeps it fixed:

- **The session key no longer changes on every start.** The wallet reuses the
  one stored in `~/.rami/panel-<port>.token` (mode 0600, your user only) and
  only mints a new one when it is missing or corrupt. Rotating per start makes
  sense when the client can read a file (Bitcoin Core's `.cookie`); here the
  client is a **browser**, and a browser cannot.
- **The dashboard remembers the key per browser, not per tab.** It is stored in
  `localStorage` keyed by port, so a bookmark, a reopened tab or a restarted
  browser keep working. Tabs coming from v0.7.1 migrate themselves.
- **Never again "create a password" on top of a wallet that exists.** Without a
  key, `/api/status` returns only version, pid and network; the dashboard now
  recognises that instead of reading it as "there is no wallet here".
- **And if you do end up without a key, the dashboard explains it and gets you
  out:** a screen tells you your money is intact, that the easy way is to open
  RAMI-Chain from its icon, and lets you paste the token file's contents if you
  would rather fix that very tab. In all five languages.
- **Three regression tests** (`token_survives_a_restart`,
  `corrupt_token_file_is_replaced`, `reused_token_file_stays_private`) so it
  cannot come back: the key survives restarts, a corrupt file is replaced
  without locking you out, and reusing it does not relax permissions.

If you are locked out right now, before updating: close the tab and open
RAMI-Chain from its icon (the app always opens the dashboard with the key).

## Novedades de v0.7.1 — auditoría de seguridad y autoauditoría con nuestra tecnología

- **Revisión completa del código** tras un aviso externo. Sin puertas traseras: el inventario de todo lo que el programa contacta o ejecuta está en `SECURITY-INVENTORY.txt` y el CI falla si aparece algo nuevo. Hallazgos y correcciones, con detalle, en `docs/AUDITORIA-2026-09.md`.
- **Panel local blindado:** `Host` exacto (adiós al DNS rebinding con `localhost.evil.com`), `Origin`/`Referer` comprobados, **token de sesión** como el `.cookie` de Bitcoin Core (otro usuario o proceso de tu máquina no puede dar órdenes al monedero), servidor HTTP con límites y timeouts. La app abre el panel con la llave; si abres una pestaña a mano, te lo dirá.
- **Actualizador anclado a GitHub:** las sumas SHA-256 ya no pueden venir del espejo web; si GitHub no responde, no se instala nada. Preparada la **firma Ed25519 de release** (`SHA256SUMS.sig`, la misma criptografía de la cadena): se activa cuando el mantenedor genere su clave (`rami-wallet release-keygen`).
- **Consenso y red:** topes por bloque (4096 tx, 2 MiB) y de mempool; keystore con escritura atómica; el cierre forzado de una instancia vieja solo actúa sobre `rami-gui`.
- **🛡️ Autoauditoría:** en Red → «Ejecutar autoauditoría», el monedero se conecta a su propio nodo como si fuera un par malicioso (saludo antiguo, identidad sin prueba de trabajo, firma manipulada, trama sin autenticar, trama gigante, avalancha de puntas falsas) y comprueba que todo se rechaza; también revisa permisos de claves, token y el hash del ejecutable frente al publicado. Desde la terminal: `rami-node audit --peer IP:30301 --network testnet`.
- Pendiente y dicho claramente: firma de transacción ligada a la red (cambio de consenso v0.8) y certificados de plataforma. Testnet experimental, sin valor monetario.

## What's new in v0.7.1 — security audit and self-audit with our own technology

- **Full code review** after an external warning. No backdoors: the inventory of everything the program contacts or executes lives in `SECURITY-INVENTORY.txt` and CI fails if anything new appears. Findings and fixes, in detail, in `docs/AUDITORIA-2026-09.md`.
- **Hardened local dashboard:** exact `Host` (no more DNS rebinding via `localhost.evil.com`), `Origin`/`Referer` checked, a **session token** like Bitcoin Core's `.cookie` (another user or process on your machine cannot give orders to the wallet), HTTP server with limits and timeouts. The app opens the dashboard with the key; a tab opened by hand will tell you.
- **Updater anchored to GitHub:** SHA-256 sums can no longer come from the web mirror; if GitHub does not answer, nothing is installed. **Ed25519 release signature** ready (`SHA256SUMS.sig`, the chain's own cryptography): it activates once the maintainer generates a key (`rami-wallet release-keygen`).
- **Consensus and network:** per-block caps (4096 tx, 2 MiB) and mempool caps; atomic keystore writes; force-closing an old instance only acts on `rami-gui`.
- **🛡️ Self-audit:** in Network → "Run self-audit", the wallet connects to its own node as a malicious peer (old handshake, identity without proof of work, tampered signature, unauthenticated frame, giant frame, flood of fake tips) and checks that everything is rejected; it also reviews key permissions, the token and the executable hash against the published one. From the terminal: `rami-node audit --peer IP:30301 --network testnet`.
- Pending, stated plainly: network-bound transaction signatures (consensus change in v0.8) and platform certificates. Experimental testnet, no monetary value.
