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

### Entrega 2 — el suelo · **la calzada, hecha en la v0.10.4; las aceras de barrio, pendientes**

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

**Pendiente de esta entrega:** las esquinas de los cruces no tienen radio de
giro y no hay líneas de detención ni ceda el paso pintados. Y queda el
experimento que decide el presupuesto de todo lo demás:
**quitar el buffer de profundidad logarítmico**, que hoy obliga a todos los
sombreadores a escribir profundidad y anula el descarte temprano de píxeles en
la escena entera. Es el número más grande que nadie ha medido.

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

### Entrega 4 — TRAMA: la manzana y la fachada · 6–8 sesiones

El genotipo entero y el catálogo de fachadas. Las 3.124 cajas anónimas del
skyline pasan a ser edificios con planta, coronación, entrada y **rótulo con el
nombre del jugador** que compró esa parcela: `SetProfile` ya garantiza que un
nombre es único en toda la cadena, y las etiquetas ya se fabrican con `canvas`
en tiempo de ejecución, así que el rótulo no cuesta un solo byte de descarga.

### Entrega 5 — el umbral y el apartamento · 8–10 sesiones

Cruzar la puerta sin pantalla de carga y sin salir del mismo Dubái: el edificio
en el que entras es el único hueco de la ciudad. Zaguán con buzones y escalera,
ascensor, apartamento amueblado, y **por la ventana se ve la ciudad de verdad,
porque es la de verdad**. Interacción con muebles y luces. Hotel y
concesionario con el mismo mecanismo.

### Entrega 6 — la vida · 6–8 sesiones

Coches por carriles reales con cesión de paso y frenado; peatones con un
**destino que sale de la economía**: van a trabajar a la empresa que existe en
esa parcela. Un bot no es una entidad de red sino una función del tiempo, así
que cuesta cero bytes de protocolo y todos los jugadores ven al mismo peatón
cruzando por el mismo sitio.

### Entrega 7 — ESPEJISMO recortado · 8–10 sesiones

Solo lo que sobrevivió: **interiores por paralaje** (treinta líneas de sombreado
que ponen una habitación dentro de cada ventana, aprovechando que el material de
fachada ya construye el marco y ya tiene un hash por celda), oclusión ambiental
de pantalla, resplandor corto y curva de color. Más las **cascadas de sombras**
resueltas con tres luces direccionales, que es mucho más barato que sustituir
`getShadowMask()` en cuatro materiales a la vez.

### Entrega 8 — la escritura de vivienda · 6–7 sesiones, activación 2027

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

## 5. Lo que se ve en cada momento

- **Ahora (v0.10.2):** la ciudad va suelta. Mismo aspecto, un tercio menos de
  trabajo por fotograma y medio megabyte menos de descarga.
- **Entregas 1–3 (antes de diciembre):** calles de verdad con bordillo y
  marcas, superficies con textura, y dejas de atravesar los edificios.
- **Entregas 4–6:** rótulos con nombres de jugadores, portales, apartamentos,
  hoteles, concesionarios, tráfico por carriles y gente que va a algún sitio.
- **Entrega 7:** el acabado. Cada ventana con una habitación dentro.
- **Entrega 8 (2027):** tu piso, en el libro mayor.

## 6. Lo que este plan NO arregla

Dicho sin adornos, porque las seis propuestas originales lo escondían al final:

- **Ninguna cifra de fluidez de este plan está medida en una tarjeta gráfica
  real.** Todo el desarrollo se hace con rasterizado por software. Los
  triángulos y las llamadas de dibujo son exactos; los milisegundos no existen.
  La Entrega 2 incluye la primera medición de verdad y puede obligar a
  replantear el resto.
- **Las estimaciones de este documento son las corregidas, y aun así son
  estimaciones.** El historial del proyecto dice que las originales se
  equivocaron por ×2,5 y siempre en la misma dirección.
- **Sonido: no hay nada.** Ni una llamada a `AudioContext` en todo el cliente.
  Es la única dimensión donde «cero assets» es natural en vez de ser un
  handicap —el viento, un motor, unos pasos y el timbre de un ascensor se
  sintetizan con osciladores y ruido en unas decenas de líneas— y no está en
  ninguna entrega. Debería.
- **El día uno de un jugador nuevo sigue sin diseñarse.** Hoy abre la pestaña,
  ve arena preciosa, no posee nada y no puede comprar nada hasta diciembre.
  Ninguna entrega describe qué hace una persona en sus primeros quince minutos
  ni por qué vuelve mañana.

## 7. Ideas que no entraron y merecen entrar

Salieron de la crítica final y son baratas comparadas con lo que dan:

- **Que la ciudad recuerde.** La cadena es orden total y permanente, y eso no lo
  tiene ningún otro metaverso. Una placa en tu edificio con la altura del bloque
  en que lo compraste; una pátina que envejece con los bloques transcurridos.
  Se usa la cadena como **memoria**, no solo como semilla.
- **Modo foto.** El dueño pidió «como si fuera una película» y la respuesta
  técnica fue más triángulos. Una película es encuadre, distancia focal, un
  travelling lento y la hora correcta. Ocultar la interfaz, cámara libre, focal
  ajustable y horizonte nivelado cuesta muy poco. Hoy ni siquiera se puede
  guardar una captura: el lienzo se crea sin `preserveDrawingBuffer`.
- **Tormenta de arena.** El único truco del menú que hace la escena **más bonita
  y más barata a la vez**: con la visibilidad a 300 metros se puede dejar de
  dibujar media ciudad.
- **Metro elevado y barcos.** Las dos siluetas que dicen «Dubái» tan rápido como
  el Burj Khalifa, y las dos son geometría baratísima: un viaducto es el mismo
  perfil barrido que la calzada y un barco es un coche sobre agua.
- **Encargos que la cadena ya genera.** Cada bloque, el consenso calcula qué
  empresa necesita qué insumo y quema como importación lo que nadie ofrece. Eso
  **ya es** una lista pública de encargos —«a este distrito le falta una
  desaladora»— y nadie la enchufa al jugador.

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

## 9. De dónde sale todo esto

Seis arquitecturas independientes, cada una diseñada desde un ángulo distinto y
cada una sometida después a un verificador cuyo encargo explícito era **refutarla
con el código delante**, más una crítica final sobre el conjunto. De los seis
veredictos, tres fueron «viable» y tres «no viable» tal como estaban escritas;
de las tres tumbadas se conservan aquí las piezas que resistieron. Las
estimaciones de este documento son las de los verificadores, no las de los
autores.
