# La ciudad deducida: plan del metaverso de RAMI-Chain

Este documento fija el camino que sigue el metaverso de Dubái a partir de la
v0.10.2, por qué es ese y no otro, y qué cuesta de verdad cada tramo. No
describe lo que ya está hecho (eso es `docs/DUBAI.md` y `docs/MULTIVERSO.md`):
describe lo que viene y las decisiones que lo cierran.

Sigue valiendo lo de siempre: RAMI es una **testnet experimental**, la moneda
**no tiene valor monetario**, no es una inversión ni un valor negociable y **no
se vende** (`NOTICE.md`). Nada de lo que hay aquí cambia eso, y el punto 8 de
este plan existe precisamente para que siga siendo evidente cuando la ciudad
empiece a parecer creíble.

## 1. Qué se decidió

De seis arquitecturas estudiadas y sometidas cada una a un verificador cuyo
encargo era tumbarla, se eligen **dos**, más una decisión de materiales y una
de consenso:

| | Qué es | Estado |
|---|---|---|
| **TRAMA** | La ciudad no se descarga: se **deduce** de la cadena con aritmética entera. Cada manzana, bordillo, torre, planta, apartamento, mueble, coche y peatón nace de una semilla obtenida de datos que ya son consenso. | Elegida |
| **ESPEJISMO** (recortado) | El acabado de imagen: interiores por paralaje en las ventanas, oclusión ambiental, resplandor y curva de color de cine. Se descartan las piezas que su propio verificador tumbó. | Elegida, recortada |
| **Atlas CC0** | Se levanta la regla de «cero assets»: entran 3–4 MB de texturas de dominio público con su atribución. | Decidido |
| **Escritura de vivienda** | «Comprar tu apartamento» está **roto** hoy en el consenso; se arregla como regla de consenso con activación propia, no como apaño de cliente. | Decidido, 2027 |

### Por qué TRAMA es el eje y no un adorno

Un metaverso convencional guarda la ciudad en un servidor y te la envía. Eso
exige servidores, artistas y gigabytes. Aquí no hay ninguna de las tres cosas, y
además hay algo que los demás no tienen: **un estado de consenso que todos los
participantes ya comparten bit a bit**.

TRAMA cambia el reparto. La cadena dice *de quién es y cuánto vale*; el binario
dice *cómo se deduce*; y **nadie dice cómo se ve, porque nadie lo guarda**. Dos
ordenadores que sigan la misma rama generan exactamente la misma calle, el mismo
portal y el mismo sofá, sin intercambiar un solo byte de mundo.

La clave técnica es separar dos capas:

- **Genotipo** — solo enteros (`Math.imul`, `|0`, `>>>0`) a partir de datos de
  consenso: `(x,y)` de la parcela, `kind` del sector, `owner`, `since`, el
  `txid` del activo, el distrito y el hash de la cabeza. Idéntico en cualquier
  máquina y cualquier navegador.
- **Fenotipo** — la malla en metros, con coma flotante. Puede diferir en el
  último bit entre dos GPU y **da igual**, porque es pintura y no entra en
  consenso.

Confundir las dos capas es el error que hundió a otras propuestas. Aquí la
frontera es explícita y comprobable: el genotipo se puede volcar como números y
compararse entre máquinas.

## 2. Las cuatro decisiones que la combinación obliga a tomar

Elegir TRAMA **y** ESPEJISMO fuerza cuatro resoluciones que ninguna de las dos
tomaba por su cuenta. Quedan fijadas aquí.

**(a) Un solo suelo, no cuatro.** Cuatro propuestas distintas respondían a la
misma pregunta —qué es el suelo de la calle— con cuatro respuestas incompatibles.
Se elige una: **calzada como geometría real** (cinta con bordillo de cara
vertical) generada del grafo viario, texturada con el atlas. Se descarta la
calzada analítica por campo de distancia en el sombreador: con texturas reales
ya no compra nada y complica el presupuesto por fragmento.

**(b) La Fragua muere.** La síntesis procedural de texturas en la GPU al
arrancar existía solo para no descargar imágenes. Con el atlas CC0 decidido,
sobra: se ahorran 4–5 sesiones y el arranque no se alarga.

**(c) Colisión y selección son prerrequisito, no extra.** Cuatro de las seis
propuestas escribían en su propio apartado de limitaciones que se seguiría
atravesando edificios, coches y avatares, y ninguna lo presupuestaba. Hoy
`pick()` solo intersecta el terreno y devuelve una casilla: no se puede pinchar
una puerta, un coche ni un escaparate. Sin eso no hay portal que cruzar ni coche
al que subir. Va en la Entrega 1, antes que nada de lo demás.

**(d) El calendario manda.** Dubái se activa el **1 de diciembre de 2026**.
Hasta esa fecha no hay ni una parcela, ni un activo, ni un RAMI del fondo de la
ciudad: lo que se haga antes tiene que verse **sin** consenso de ciudad. Y una
segunda regla encima (la escritura de vivienda) necesita su propia fecha de
activación no retroactiva, o sea **2027**. Todo lo que sea cliente se ve este
año; todo lo que sea consenso, no.

## 3. Lo que se descarta, y por qué

- **Calzada analítica por campo de distancia** — redundante con el atlas (2a).
- **Síntesis procedural de texturas** — redundante con el atlas (2b).
- **Niebla volumétrica de 16 pasos** — su verificador la midió en ~10 ms por
  fotograma en gráfica integrada. Se sustituye por niebla de profundidad y, para
  el efecto de calima, por la tormenta de arena del punto 7, que es más barata y
  se parece más a Dubái.
- **Reflejos en espacio de pantalla** — coste alto, ganancia pequeña sobre un
  mapa cúbico que ya existe.
- **Reparto económico espejado en JavaScript** — el producto `u128` del reparto
  de la ciudad no cabe en un `double` por seis órdenes de magnitud. Si el
  cliente necesita esa cifra, la publica el **nodo** en una ruta nueva y el
  cliente la dibuja; no se reimplementa el consenso en el navegador.
- **Coordinador rotatorio por celda para el multijugador** — es un proyecto
  aparte, no un apéndice. La mejora de presencia que sí entra es local y sin
  protocolo nuevo.

## 4. La ruta, por entregas

Cada entrega deja el árbol compilando y es publicable por sí sola. Los costes
son los **corregidos por los verificadores**, no los que estimó cada propuesta:
la inflación media de las estimaciones originales fue de ×2,5, siempre a la baja.

### Entrega 0 — la deuda común · **hecha en la v0.10.2**

Cuatro cosas que todas las propuestas daban por hechas y ninguna pagaba. Medido
con el panel real:

| | Antes | Después |
|---|---|---|
| Triángulos por fotograma (calidad media) | 1.184.610 | 842.970 (−28,8 %) |
| Llamadas de dibujo | 18 | 17 |
| Programas de sombreado | 17 | 16 |
| Binario descargable | 7.104.616 B | 6.551.976 B (−7,8 %) |

El grueso viene de un sitio inesperado: **las palmeras eran el 44 % de la
escena**, y el 77 % de cada palmera era el racimo de dátiles, que era una esfera
de 440 triángulos a siete metros de altura. Con una esfera de 80 el racimo se ve
igual y la capa de palmeras baja de 525.400 a 192.400 triángulos. Como las
palmeras eran además el 89 % del pase de sombras, ese pase —que no aparece en
las estadísticas porque three.js lo dibuja antes de reiniciar el contador— cae
casi a la mitad.

Lo demás: las 24 cabinas de la noria con la misma dieta; el manto y los bordes
dejan de dibujarse dos veces (three.js reserva dos pasadas para todo material
transparente a doble cara salvo que se le diga que no hacen falta); y los
símbolos de depuración salen del binario.

### Entrega 1 — el plano inmutable, la colisión y la selección · **hecha en la v0.10.3**

La base de todo lo que viene. Sin esto, TRAMA siembra la ciudad con datos que
**cambian** (`owner`, `since`, `kind` se mueven en cada compra) y un edificio se
reconstruiría entero cada vez que alguien vende un piso.

- **Reparto morfología/ropaje.** Se fija qué parte del mundo es inmutable
  (`(x,y)`, distrito, sector geográfico, relieve → la forma del edificio) y qué
  parte es mutable (`owner`, `since`, activos → el rótulo, el color, las luces).
  La forma no se mueve cuando cambia el dueño.
- **Índice espacial.** Hoy `buildClusters` tira la lista de instancias y solo
  deja matrices: no hay forma de saber qué torre hay bajo una puerta. Se
  conserva, ~75 KB de memoria.
- **Colisión.** Paredes, hitos y coches dejan de atravesarse.
- **Selección de objetos.** `pick()` pasa de devolver una casilla a devolver
  *qué* hay ahí: puerta, coche, escaparate, portal.

Entregado: **3.180 sólidos** (56 hitos + 3.124 torres) en una rejilla de 256 m;
colisión a pie con salida por la cara más cercana; rayo de pantalla que topa
antes con el edificio que con el suelo; y el contrato de semillas
(`semillaMorfologia` / `semillaRopaje`) ya en uso, no como texto muerto: el tono
y la esbeltez de cada edificio salen de canales de morfología, y una variación
fina del tono sale del ropaje, así que dos torres iguales de dueños distintos no
se ven idénticas.

Comprobado con el panel real: el jugador andando contra la cara sur del Burj
Khalifa se detiene a 75 m exactos del centro (su media huella); un rayo vertical
lo toca a 830 m de altura y uno lateral a 825 m de distancia; en pleno desierto
no hay nada. Queda fuera de esta entrega **la colisión con los coches y con
otros avatares**, que son objetos que se mueven y necesitan otra estructura.

### Entrega 2 — el suelo · **la calzada, hecha en la v0.10.4; las aceras de barrio, en la v0.10.6**

Cierra el defecto que el propio
proyecto arrastra desde la 0.9.0 como pendiente número uno: *a pie el suelo sigue siendo
arena lisa*.

Calzada con bordillo, aceras, marcas viales y aparcamientos, generados del grafo
viario (21 polilíneas, 145 vértices, 602 km ya en el dataset) y texturados con
el atlas.

**Hecho en la v0.10.4:** las 21 vías son ya cinta con perfil de ocho puntos
—acera, bordillo de cara vertical, calzada— remuestreada cada 100 m y nivelada
por la cota máxima de su entorno, con marcas viales analíticas sacadas de las
coordenadas transversal y longitudinal de cada vértice. 65.268 triángulos y
ninguna llamada de dibujo más.

**Hecho en la v0.10.6:** las calles de barrio. Cada uno de los 34 barrios recibe
una retícula cuyo giro y cuyo paso se **deducen** de la celda donde está, con la
misma aritmética entera que el resto de la ciudad; y un edificio cuya posición
pisa la trama busca otra, así que **las manzanas salen solas**.

**Cambio sobre el plan.** Se eligió mezclar calles reales de OpenStreetMap con
las deducidas. La red del entorno donde se construye el proyecto **no alcanza
OpenStreetMap**: rechaza Overpass, Nominatim, Geofabrik y los teselados, igual
que rechazaba las fuentes de textura. La mitad deducida está hecha; la mitad
real queda **enchufable**: en cuanto haya un extracto de Dubái en el
repositorio, sus vías con nombre entran en la misma lista de ejes y mandan donde
existan. Nada del código que hay que escribir para eso cambia lo ya hecho.

**Hecho en la v0.10.7:** los cruces. 4.505 en toda la ciudad, resueltos por
prioridad —las vías del mapa por encima de las deducidas, y entre iguales la más
ancha; a igualdad exacta, la de menor índice, que es un orden fijo y por tanto
la misma decisión en todas las máquinas—. La que cede desaparece dentro del
ancho de la que manda, y a la que manda se le rebaja el bordillo en la boca de
la otra, en metro y medio. Donde se cruzan dos arterias del mismo orden va una
glorieta: anillo de asfalto sin marcas, bordillo e isla central, con las dos
vías cortadas en la cuerda que encaja con la circunferencia. Siete glorietas.

**Hecho en la v0.10.8:** la calzada deja de ir en una sola malla inmune al
descarte. Va repartida en 43 teselas de ocho kilómetros, cada una con su esfera
envolvente, y a ras de calle se envía un tercio menos de escena (881.408
triángulos frente a 1.367.614) por una llamada de dibujo más. El tamaño salió de
medir cuatro. El peor caso —toda la ciudad de golpe— paga 33 llamadas de más,
que es justo cuando la calzada mide un píxel.

**Hecho en la v0.10.9:** el radio de giro de las esquinas. Los 4.505 cruces
llevan un cuarto de circunferencia de cuatro a nueve metros tangente al bordillo
de la otra calle, con las dos vías usando la misma fórmula, así que sus bordes se
encuentran sobre el arco. A pie cuesta un 3,7 % más de escena enviada, que es
justo el presupuesto que liberó la v0.10.8.

**Hecho en la v0.10.10:** las palmeras dejan de enviarse enteras. Las 916
palmeras van en 17 teselas de ocho kilómetros —la misma tesela que la calzada—,
cada una con su malla instanciada y su esfera envolvente dada a mano, porque
three r150 no sabe calcularla. A pie se envía un 19 % menos de escena (740.308
triángulos frente a 914.196) por una llamada de dibujo menos; el peor caso paga
15 llamadas más. Las palmeras eran el 21 % de la escena, no el 44 % que decía la
nota anterior: ese número contaba una pasada de sombra que no las dibuja.

**Hecho en la v0.10.11:** las líneas de detención y el ceda el paso. Cada boca de
la calle que cede lleva una banda continua de 40 cm en la mitad que llega al
cruce (7.876 en los 4.505 cruces), y cada entrada de glorieta una discontinua
(23 en las siete). Son cuadriláteros sueltos dentro de las mallas de la calzada,
con dos clases nuevas de pintura en el mismo sombreador: a pie cuestan un 0,14 %
y ninguna llamada de dibujo.

**Hecho en la v0.10.12:** la colisión con lo que se mueve. Los coches son cajas
orientadas por su sentido de marcha y los avatares ajenos círculos; el jugador
sale de los dos cada cuadro con el mismo empuje que ya usaba con las fachadas, y
los coches frenan por el de delante y por el jugador en su carril con el perfil
de una deceleración constante. Probado con un paso de simulación determinista.

**Hecho en la v0.10.13:** los pasos de peatones (7.908, cuadriláteros sueltos
interpolados entre filas, sin fila propia), una sola cota por cruce en las dos
vías (la caja ensanchada de la preferente tapaba a la que cede y a sus marcas),
los coches que esquivan al jugador antes que frenar, la **medida de fluidez en
el panel** (cuatro vistas fijas, tarjeta gráfica, media y peor cuadro: la cifra
que faltaba la mide quien tiene tarjeta) y la mitad real de las calles
**enchufable**: `tools/geo/osm_roads.py` convierte un extracto de OpenStreetMap
en la clave `vias` que el cliente lee con el ancho de su clase. El repositorio
sigue sin distribuir datos de OSM.

**Comprobado en la v0.11.0:** las calles de la trama llevan acera y bordillo
desde la v0.10.6 —el mismo perfil de ocho puntos que las del mapa, con 3,5 m de
acera en los barrios de torres, 3 en los de bloques y naves y 2,4 en los de
villas—; lo que faltaba era pisarla: la cinta se nivela por la cota máxima de
su sección y en ladera queda hasta dos metros por encima del terreno, y el
jugador andaba por el terreno, con los ojos bajo la acera. Ahora anda por la
cinta (`sueloCalle`).

**Pendiente de esta entrega:** queda el experimento que decide el presupuesto de
todo lo demás:
**quitar el buffer de profundidad logarítmico**, que hoy obliga a todos los
sombreadores a escribir profundidad y anula el descarte temprano de píxeles en
la escena entera. Es el número más grande que nadie ha medido.

**Montado en la v0.11.0, con la entrega 7:** `localStorage['rami.profundidad']
= 'lineal'` abre el visor sin el búfer logarítmico, con los planos de cada
cuadro sacados de la holgura de la cámara (la distancia a lo más cercano que el
visor conoce: terreno, catastro, avatares). Sigue sin medirse: lo que se gana es
un efecto de la tarjeta que el rasterizado por software no reproduce, así que
el logarítmico se queda por defecto hasta que alguien mida los dos con el botón
de fluidez en una tarjeta real.

### Entrega 3 — los materiales · **hecha en la v0.10.5**

Es lo que separa «color plano a dos metros» de una superficie creíble.

**Cambio sobre el plan:** el entorno donde se construye el proyecto **no alcanza
las fuentes de dominio público** —la red rechaza ambientCG y Poly Haven con un
403 en la pasarela—, y meter arte con una licencia sin verificar en el
repositorio no es una opción. Así que los materiales se **fabrican**:
`tools/textures/make_materials.py` genera cuatro texturas teselables de 512×512
(asfalto, hormigón, arena, losas de acera) con la biblioteca estándar de Python,
de forma determinista, con el color en sRGB y la altura en el alfa. No arrastran
licencia de nadie y la descarga sube 1,6 MB, no 3–4. Si algún día entra un juego
fotográfico CC0, se sustituyen esos cuatro ficheros: el sombreador no cambia.

### Entrega 4 — TRAMA: la manzana y la fachada · 6–8 sesiones · **hecha en las v0.10.14–16**

El genotipo entero y el catálogo de fachadas. Las 3.124 cajas anónimas del
skyline pasan a ser edificios con planta, coronación, entrada y **rótulo con el
nombre del jugador** que compró esa parcela: `SetProfile` ya garantiza que un
nombre es único en toda la cadena, y las etiquetas ya se fabrican con `canvas`
en tiempo de ejecución, así que el rótulo no cuesta un solo byte de descarga.

**Hecho en la v0.10.14:** las 3.106 cajas del skyline son edificios con planta
(cinco por tipo de barrio: lámina, podio y torre, escalonada, en L, gemelas;
barra, L, U, ático; villa con tapia; nave con bóveda o plana), coronación (peto,
cuarto de máquinas, antena) y portal hacia la calle más cercana, con la fachada
paralela a ella en 2.344 de ellos. La forma sale solo de la posición
(`semillaMorfologia`); la serie que da posición, altura y huella no cambia. Van
en una malla por tesela de ocho kilómetros, no instanciadas: a pie cuestan entre
−1,5 % y +4,7 % de escena y la ciudad entera un 19,5 % más. El nodo añade a cada
parcela el nombre único de su dueño y el cliente lo cuelga sobre su edificio.
Quedaban de esta entrega los edificios de las parcelas.

**Hecho en la v0.10.15:** los edificios de las parcelas —los del jugador— salen
del mismo catálogo: planta por celda (`semillaMorfologia`, canales 13 y 14),
coronación y portal hacia el frente de la parcela, con las piezas propias de
cada sector (piscina, chimenea y grúa, paneles, depósitos, silo, cruz, cúpula,
cono y bandera, taxis, mástil) sin teñir; en una malla por tesela y en el
catastro con el nombre de la empresa. Ningún edificio de barrio se planta ya
sobre otro ni sobre un hito (3.106 → 3.052 edificios, cero solapes), y la
calidad «baja» choca solo con lo que dibuja. Quedaba que el plano de los barrios
no conocía las parcelas compradas.

**Hecho en la v0.10.16, y con ello la entrega:** el catálogo de fachadas
—retícula, lisa, muro cortina y ventana corrida— en el sombreador, elegida por
la morfología de cada edificio y de cada celda; el plano de los barrios oculta
(y saca del catastro) los edificios que se montan sobre el de una parcela
comprada, y los devuelve si la parcela desaparece; la torre de la parcela es
esbelta (69 × 220 m); y los fantasmas del multiverso tienen la planta del
edificio real de su celda, en una malla por tesela. Lo que la entrega no ha
tocado, y no estaba en ella: el portal sigue cerrado (entrega 5).

### Entrega 5 — el umbral y el apartamento · 8–10 sesiones · **hecha en la v0.11.0**

Cruzar la puerta sin pantalla de carga y sin salir del mismo Dubái: el edificio
en el que entras es el único hueco de la ciudad. Zaguán con buzones y escalera,
ascensor, apartamento amueblado, y **por la ventana se ve la ciudad de verdad,
porque es la de verdad**. Interacción con muebles y luces. Hotel y
concesionario con el mismo mecanismo.

**Hecho en la v0.11.0** (`city/umbral.js`; del núcleo, una línea que publica
los tonos de la puerta y de la vidriera): cada edificio, de barrio o de
parcela, tiene un portal que se abre, y la puerta se encuentra por su tono entre
las piezas que devuelve el catálogo, así que el portal sigue al catálogo; en los
416 edificios en L o en U el patio se anda hasta ella. Se entra andando, sin
fundido: el interior se construye en el mismo cuadro (1,5–10,8 ms) y se ve por
la puerta antes de cruzarla. Zaguán con buzones (uno por vivienda) y escalera,
ascensor de 2,5–6 s y apartamento con salón, cocina, dormitorio y baño pegado a
la fachada, con ventanas que son huecos: el interior se dibuja en dos pasadas
—la envolvente solo en profundidad, después el color— y donde tiene hueco queda
la ciudad que el visor ya había dibujado, a la altura real del piso. Lámparas
que alumbran solo su habitación, muebles que se mueven en rejilla y se guardan
en el navegador; recepción en el hotel, un coche por activo en el
concesionario, y la villa y la nave con el mismo mecanismo. Cada piso es de
quien dicen las `units` de la entrega 8, el ático del dueño de la parcela y el
piso de muestra de quien no tiene nada; todo sale del genotipo del edificio.
Lo que la entrega no ha tocado: los muebles no se arrastran con el ratón;
desde dentro, la puerta de la calle no deja ver la calle (hace falta que el
material de los edificios del núcleo descarte ese hueco); en VR no se entra; y
por la ventana se sigue enviando la ciudad entera.

### Entrega 6 — la vida · 6–8 sesiones · **hecha en la v0.11.0**

Coches por carriles reales con cesión de paso y frenado; peatones con un
**destino que sale de la economía**: van a trabajar a la empresa que existe en
esa parcela. Un bot no es una entidad de red sino una función del tiempo, así
que cuesta cero bytes de protocolo y todos los jugadores ven al mismo peatón
cruzando por el mismo sitio.

**Hecho en la v0.11.0:** los coches van por los carriles pintados (seis por
sentido en una troncal, tres en una arteria, dos en una secundaria y en las
calles de barrio de 13 a 18 m, uno en las de 10), por todas las calles —las del
mapa y las de la trama—, ceden en los 3.905 cruces con ruta a los dos lados
según quién manda en resuelveCruces, mirando dónde se cortan de verdad sus
carriles (en un cruce oblicuo, lejos del centro), dan la vuelta a las glorietas
por el anillo, se paran ante los pasos de peatones ocupados, no se paran dentro
de un cruce y, al final de su calle, dan la vuelta por un semicírculo de su
carril; la ruta se corta donde se corta la cinta. Los peatones (`city/vida.js`) son una función pura del
tiempo de Dubái: 29.527 personas con casa en las villas y los bloques, trabajo
en las empresas de las parcelas (cada una contrata su plantilla entre quienes
viven más cerca) o, el resto, en las torres y naves de un barrio de oficinas
sorteado por gravedad (plantas / (1 + km)²), horario por semilla y camino por las aceras
cruzando solo por los pasos; quien viene de lejos aparece en el bordillo de una
parada del barrio o en el de delante de su portal; misma posición en dos
navegadores para el mismo instante. Por el camino se arregló el catastro, que
giraba las cajas de choque al revés que las mallas desde la v0.10.3. Lo que la
entrega no ha tocado: las rutas no se enlazan entre sí (al final de cada una el
coche da la vuelta, y en 5 de las 7 glorietas antes de la entrada), no hay
semáforos, los coches no son deterministas (los peatones sí) y no hay aceras
entre barrios ni a lo largo de las vías del mapa. Las cifras, en las notas de la
versión.

### Entrega 7 — ESPEJISMO recortado · 8–10 sesiones · **hecha en la v0.11.0**

Solo lo que sobrevivió: **interiores por paralaje** (treinta líneas de sombreado
que ponen una habitación dentro de cada ventana, aprovechando que el material de
fachada ya construye el marco y ya tiene un hash por celda), oclusión ambiental
de pantalla, resplandor corto y curva de color. Más las **cascadas de sombras**
resueltas con tres luces direccionales, que es mucho más barato que sustituir
`getShadowMask()` en cuatro materiales a la vez.

**Hecho en la v0.11.0:** los interiores por paralaje en el sombreador de
edificios, desde la calidad media: una sala de 4,5 × 3,6 × 5,6 m detrás de cada
hueco de vidrio, la del mismo sorteo de luces encendidas, con la paleta de cada
edificio (su id viaja en el atributo de la fachada) y ningún triángulo más. La
oclusión ambiental (alta y ultra), el resplandor con un umbral de día y otro de
noche y la curva de color van en `city/espejismo.js`, con el gancho `pintar`;
con los tres efectos a cero, la imagen es idéntica byte a byte a la del dibujo
directo. Las cascadas, como estaba previsto, son el sol y dos luces de
intensidad cero con cajas de 150 m, 800 m y 3,5 km, en alta y ultra; los
materiales de three que no usan `getShadowMask()` se pasan por
`sombraEnCascadas` para leer las tres. Es donde se paga: la pasada de sombra
lleva 3,4–3,8 veces los triángulos. El experimento de la profundidad de la
entrega 2 va montado con ella, apagado. Lo que la entrega no ha tocado: ninguna
de sus cifras de fluidez está medida en una tarjeta real; el posproceso no se
dibuja en las gafas; y con posproceso se mantiene el multimuestreo del lienzo,
que es el que heredan las gafas (66 MB sin uso a 1.920 × 1.080, calculado).

### Entrega 8 — la escritura de vivienda · 6–7 sesiones, activación 2027 · **hecha en la v0.11.0, rige el 1 de marzo de 2027**

Hoy, para comprar tu piso, primero tienes que comprar la manzana entera de
650 metros: `MintAsset` exige que el firmante sea dueño de la parcela completa.
Es un defecto real del consenso, no una carencia del cliente.

Se arregla con una transacción nueva que divide la parcela en unidades, con su
**fecha de activación propia y no retroactiva**, la misma disciplina de siempre:
bit por bloque, sin periodo mixto. Antes de escribirla hacen falta los dos topes
de seguridad que su verificador considera imprescindibles (tope por cuenta y por
parcela) y una vuelta completa de compatibilidad de ficheros.

**Mientras tanto, y desde la Entrega 5, tu apartamento se ve, se entra y se
amuebla**; lo que llega en 2027 es la escritura ante el libro mayor.

**Hecho en la v0.11.0** (`docs/VIVIENDA.md`): cuatro transacciones nuevas
—`DivideParcel` (de 1 a 64 viviendas, una sola vez, solo por la comisión),
`TransferUnit`, `SellUnit` y `BuyUnit`— y `MintAsset` firmado también por el
dueño de cualquier vivienda de la parcela. Los dos topes: 64 viviendas por
parcela y 16 por cuenta en parcelas de otros. Fecha propia y no retroactiva, el
1 de marzo de 2027 a las 00:00 UTC, solo donde rige Dubái, con un bit por bloque
que no retrocede y sin periodo mixto; ninguna codificación ni ningún txid
anterior cambia. La vuelta de compatibilidad de ficheros se hizo
(`tools/compat/roundtrip.sh`, paso 5) y dejó un arreglo hacia delante: desde la
v0.11.0, un bloque de una versión posterior se salta con un aviso en vez de
abortar la carga. Lo que la entrega no ha tocado: el tope es por cuenta, no por
persona; el comprador de una parcela dividida está protegido en el precio, no en
el número de viviendas que recibe; y `/api/city` con la ciudad entera dividida
en 64 pesaría unos 29 MB.

## 5. Lo que se ve en cada momento

- **Ahora (v0.10.2):** la ciudad va suelta. Mismo aspecto, un tercio menos de
  trabajo por fotograma y medio megabyte menos de descarga.
- **Entregas 1–3 (antes de diciembre):** calles de verdad con bordillo y
  marcas, superficies con textura, y dejas de atravesar los edificios.
  **Hecho en las v0.10.3–v0.10.13.**
- **Entregas 4–6:** rótulos con nombres de jugadores, portales, apartamentos,
  hoteles, concesionarios, tráfico por carriles y gente que va a algún sitio.
  **Hecho en las v0.10.14–v0.11.0.**
- **Entrega 7:** el acabado. Cada ventana con una habitación dentro. **Hecho en
  la v0.11.0**, desde la calidad media.
- **Entrega 8 (2027):** tu piso, en el libro mayor. **La regla va en la
  v0.11.0 y rige desde el 1 de marzo de 2027.**
- **Secciones 6 a 8 (v0.11.0):** el sonido, el modo foto, la tormenta de arena,
  el metro y los barcos, la placa y la pátina, los encargos, la guía del día
  uno y el aviso de `NOTICE.md` siempre a la vista.

## 6. Lo que este plan NO arregla

Dicho sin adornos, porque las seis propuestas originales lo escondían al final:

- **Ninguna cifra de fluidez de este plan está medida en una tarjeta gráfica
  real.** Todo el desarrollo se hace con rasterizado por software. Los
  triángulos y las llamadas de dibujo son exactos; los milisegundos no existen.
  La Entrega 2 incluye la primera medición de verdad y puede obligar a
  replantear el resto.
  **Sigue igual en la v0.11.0.** Desde la v0.10.13 el panel mide la fluidez
  con un botón, y desde la v0.11.0 anota qué efectos estaban activos, pero
  nadie la ha medido en una tarjeta. Lo que más urge medir es lo que añade esta
  versión: la pasada de sombra de las cascadas (3,4–3,8 veces los triángulos
  en alta) y los dos modos de profundidad.
- **Las estimaciones de este documento son las corregidas, y aun así son
  estimaciones.** El historial del proyecto dice que las originales se
  equivocaron por ×2,5 y siempre en la misma dirección.
- **Sonido: no hay nada.** Ni una llamada a `AudioContext` en todo el cliente.
  Es la única dimensión donde «cero assets» es natural en vez de ser un
  handicap —el viento, un motor, unos pasos y el timbre de un ascensor se
  sintetizan con osciladores y ruido en unas decenas de líneas— y no está en
  ninguna entrega. Debería.
  **Hecho en la v0.11.0** (`city/extras.js`): viento, tráfico, metro, pasos y
  grillos sintetizados, y el timbre y la puerta del ascensor como servicio para
  los demás módulos; apagado por defecto, con el `AudioContext` creado en un
  gesto del usuario. Nadie lo ha oído todavía: donde se construye no hay
  salida de audio, y los niveles están elegidos a mano.
- **El día uno de un jugador nuevo sigue sin diseñarse.** Hoy abre la pestaña,
  ve arena preciosa, no posee nada y no puede comprar nada hasta diciembre.
  Ninguna entrega describe qué hace una persona en sus primeros quince minutos
  ni por qué vuelve mañana.
  **Diseñado en la v0.11.0** (`city/memoria.js`): la guía «Primeros pasos» del
  visor, seis pasos que se marcan solos —mirar la ciudad, bajar a pie, entrar
  en un edificio, crear el nombre único, conseguir RAMI de prueba y lo que
  llega, con la fecha y la cuenta atrás de Dubái y de la escritura de
  vivienda—, y debajo «Por qué vuelves mañana»: los encargos de hoy, la hora de
  Dubái y la pátina de tu edificio. Hasta diciembre sigue sin poder comprarse
  nada; lo que cambia es que los primeros quince minutos tienen un camino.

## 7. Ideas que no entraron y merecen entrar

Salieron de la crítica final y son baratas comparadas con lo que dan.
**Las cinco entraron en la v0.11.0**, en los módulos `extras` y `memoria` del
visor; debajo de cada una, lo hecho.

- **Que la ciudad recuerde.** La cadena es orden total y permanente, y eso no lo
  tiene ningún otro metaverso. Una placa en tu edificio con la altura del bloque
  en que lo compraste; una pátina que envejece con los bloques transcurridos.
  Se usa la cadena como **memoria**, no solo como semilla.
  **Hecho:** una placa de latón junto al portal de cada edificio de parcela
  («Bloque #» con la altura en que se fundó, la empresa y el `@nombre` del
  dueño), legible a pie a tres metros; y la pátina, en aritmética entera: un
  nivel más el día 1, 4, 9… de cadena desde la fundación, hasta el 12 el día
  144. La pátina no cuesta ningún triángulo (es el color de vértice que ya se
  escribía), y la placa, 192 y solo a menos de 70 m.
- **Modo foto.** El dueño pidió «como si fuera una película» y la respuesta
  técnica fue más triángulos. Una película es encuadre, distancia focal, un
  travelling lento y la hora correcta. Ocultar la interfaz, cámara libre, focal
  ajustable y horizonte nivelado cuesta muy poco. Hoy ni siquiera se puede
  guardar una captura: el lienzo se crea sin `preserveDrawingBuffer`.
  **Hecho:** pantalla completa sin interfaz, focal de 14 a 200 mm, horizonte
  nivelado desplazando la ventana de proyección (las verticales quedan
  verticales), travelling lento y cámara libre. La captura se copia justo
  después de dibujar, sin tocar `preserveDrawingBuffer`, y el PNG lleva el pie
  «red de pruebas, sin valor monetario».
- **Tormenta de arena.** El único truco del menú que hace la escena **más bonita
  y más barata a la vez**: con la visibilidad a 300 metros se puede dejar de
  dibujar media ciudad.
  **Hecho:** un calendario igual para todos (1 de cada 17,1 días, de 2 a 4 h
  por la tarde) y un botón para ponerla o quitarla en el propio equipo. Con la
  visibilidad a 380 m a pie y el terreno recortado a lo que se ve, los
  encuadres cercanos envían de un 48 a un 69 % menos de triángulos; solo con el
  plano lejano, el ahorro era del 0,4 al 2 %.
- **Metro elevado y barcos.** Las dos siluetas que dicen «Dubái» tan rápido como
  el Burj Khalifa, y las dos son geometría baratísima: un viaducto es el mismo
  perfil barrido que la calzada y un barco es un coche sobre agua.
  **Hecho:** el viaducto va por la mediana de la E11 (50,6 km, 1.619 pilares,
  35 estaciones, 23 trenes que son una función del reloj), con el material que
  ya existía y 85.504 triángulos en diez teselas; los barcos son 22 en 7 rutas
  fijas sobre el agua visible, en mallas instanciadas como los coches.
- **Encargos que la cadena ya genera.** Cada bloque, el consenso calcula qué
  empresa necesita qué insumo y quema como importación lo que nadie ofrece. Eso
  **ya es** una lista pública de encargos —«a este distrito le falta una
  desaladora»— y nadie la enchufa al jugador.
  **Hecho:** una lista por distrito en el visor, etiquetas sobre los distritos y
  la tarjeta «Encargos» del panel, que por distritos suman exactamente los
  `huecos` del consenso. En la vista general las etiquetas ceden ante los
  rótulos del núcleo; lo que se ve siempre es la lista, y un clic en una fila
  vuela al distrito.

## 8. El riesgo que crece con cada entrega

Cuanto más creíble sea la ciudad, más se va a parecer a una inversión, y el
plan entero está lleno de «comprar tu apartamento», «comprar coches», «hoteles»,
carteles de venta y precios. Ninguna de las seis propuestas dedicaba una sola
sesión a esto.

Por eso se reserva una: los precios de la ciudad se muestran siempre con la
unidad RAMI y nunca junto a un símbolo de moneda; ningún texto del cliente
sugiere revalorización ni rendimiento; el aviso de `NOTICE.md` se mantiene
visible en la pestaña de la ciudad; y `tools/panel/lexico.py`, que ya rechaza el
léxico estimativo en cinco idiomas, se amplía con los términos de esta zona.

**Hecho en la v0.11.0** (la sesión reservada, en el frente `memoria`). Los
precios de venta de la ciudad van en RAMI y junto a 🏷️, no a 💰: carteles y
ficha del 3D, y las fichas del panel de parcela, activo y vivienda. El aviso de
`NOTICE.md` es una línea fija encima del mapa, en 2D y en 3D, con el enlace, y
la guía del día uno lo repite al pie; la foto guardada lleva el suyo. El léxico
rechaza, en los cinco idiomas, los términos de esta zona —también el
vocabulario con el que el mentor de la v0.9.0 contaba en cuántos bloques se
cubría la parcela— y un precio junto a un símbolo o a un nombre de moneda; solo vale la negación
pegada al término («no es una inversión»), y además del panel, la web, el
README y las notas de versión mira todas las cadenas del visor 3D y los
fragmentos de traducción. El mentor habla de lo que cuesta la parcela y de lo
que reparte el fondo por bloque. Lo que no ha tocado: el léxico no recorre los
documentos de `docs/`.

## 9. De dónde sale todo esto

Seis arquitecturas independientes, cada una diseñada desde un ángulo distinto y
cada una sometida después a un verificador cuyo encargo explícito era **refutarla
con el código delante**, más una crítica final sobre el conjunto. De los seis
veredictos, tres fueron «viable» y tres «no viable» tal como estaban escritas;
de las tres tumbadas se conservan aquí las piezas que resistieron. Las
estimaciones de este documento son las de los verificadores, no las de los
autores.
