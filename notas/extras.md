# Frente «extras» (v0.11.0): sonido, modo foto, tormenta de arena, metro elevado y barcos

Casi todo en `chain/crates/rami-gui/src/city/extras.js` (un módulo del visor,
ES5), más las cadenas en `chain/crates/rami-gui/i18n-src/frag_extras.json` y
unas líneas en `docs/EXTENSIONES-3D.md` (el servicio `servicios.sonido`, la
regla nueva del plano de los barrios y lo que el módulo escribe en el estado
del núcleo). **Del núcleo solo toca `planificarBarrios`** (`city3d.js`, dos
funciones nuevas justo encima: `franjasDelMapa` y `enViaDelMapa`; ver
«Núcleo» más abajo). Ni `dashboard.html`, ni el consenso, la red o el nodo.
La interfaz la crea el propio módulo: una barra flotante abajo a la derecha del
visor con 🔇/🔊 (y su volumen), 📷 y 🌪.

La ronda 2 se hizo sobre la integración (80067fa, binario
`rami-gui-integ`); lo que cambió está resumido en «Ronda 2», y las cifras de
las tablas son de esta ronda salvo donde se dice otra cosa.

## Qué hace

1. **Sonido sintetizado** (§6 del plan). Ni un fichero de audio.
   - El `AudioContext` se crea en el clic del botón 🔊 (apagado por defecto), o
     en el primer gesto sobre la página si la preferencia guardada
     (`localStorage['rami.sonido']`, con try/catch) dice que estaba encendido.
     Si ese primer gesto es el propio botón 🔇, `primerGesto` no hace nada y lo
     resuelve el clic (ronda 1: antes lo encendía el `pointerdown` y el clic lo
     apagaba al momento, guardando `'0'`).
   - Viento: ruido blanco por un paso banda (380 Hz) que un seno de 0,11 Hz mueve
     ±160 Hz (las rachas); ganancia `0,035 + 0,20·altura/400 m + 0,42·tormenta`.
   - Tráfico: los coches de `S.traffic.cars` a menos de 120 m, con peso
     `1/(1+(d/12)²)`; dos dientes de sierra por un paso bajo de 320 Hz cuyo tono
     es `38 + 1,9·v̄` Hz (v̄ = velocidad media ponderada), más el rodar del
     neumático (ruido por paso bajo de 600 Hz).
   - Metro: retumbo grave (ruido por paso bajo de 170 Hz) según la distancia al
     coche de tren más cercano.
   - Pasos: uno cada 0,75 m andando (1,6 m por encima de 12 m/s), golpe de ruido
     filtrado más un seno de 85–110 Hz; la variación de cada paso sale de
     `semillaMorfologia(n, 7, 43)`, no de `Math.random`.
   - Noche: grillos (seno de 4,3 kHz cortado por un cuadrado de 24 Hz) a
     `0,014·noche`, que callan en la tormenta y en lo alto.
   - Volumen maestro con compresor; se suspende con la pestaña oculta
     (`visibilitychange`) y se silencia solo si el visor deja de dibujar más de
     1,5 s (vista 2D, otra sección).
   - Servicio para los demás módulos: `ctx.servicios.sonido = { play(nombre),
     activo() }` con `'timbre'` (mi6 y do6 del ascensor), `'puerta'` (soplido de
     corredera y tope), `'clic'` y `'paso'`. Con el sonido apagado o un nombre
     desconocido devuelve `false` y no lanza.
2. **Modo foto** (§7). Botón 📷: pone el visor **a pantalla completa** (ronda 2:
   `position: fixed` y `z-index` alto en el estilo del propio contenedor, así
   que tapa también la barra del visor del panel —Centro, Dubái, Parcelas, 2D,
   A pie, calidad, hora—, que está fuera de `#city3d`; el núcleo redimensiona
   el lienzo con su `ResizeObserver`), oculta todo lo que cuelga del contenedor
   salvo el lienzo y su propia barra (pistas, avisos, barras de otros
   módulos), las etiquetas (`material.visible = false` en cada `LabelSet` de la
   escena, también las de los módulos) y la selección y el cursor de casilla.
   Focal de 14 a 200 mm en escala logarítmica (fov vertical = `2·atan(12/f)`),
   horizonte nivelado con **desplazamiento de la ventana de proyección** (la
   cámara no se inclina y el encuadre se conserva con `setViewOffset`: las
   verticales de los rascacielos quedan verticales), travelling lento (órbita
   a 1,2°/s o lateral a pie a 1,2 m/s) y «cámara libre» (a pie volando a 40 m,
   WASD, Q/E y arrastrar). «Guardar» copia el lienzo en el gancho
   `trasPintar` —justo después de dibujar: el lienzo no tiene
   `preserveDrawingBuffer`— en un lienzo 2D, le pone el pie «Dubái RAMI · red
   de pruebas, sin valor monetario» (§8: una foto que circule fuera del panel
   sigue diciendo lo que es) y lo descarga como
   `dubai-rami-AAAAMMDD-HHMMSS.png`, del tamaño de la pantalla. Salir (botón ✕
   o Escape) lo restaura todo: el atributo `style` del contenedor tal cual
   estaba y el desplazamiento de la página, fov, ventana, etiquetas, interfaz
   **y la pose** (modo, posición a pie, `fly`, órbita de `cur` y `goal`, vuelo
   de cámara), que `entraFoto` guarda entera en `foto.guardado`. Escape se
   escucha en el documento (en captura) mientras dura el modo foto: al pulsar
   📷 el botón desaparece, el foco pasa al `body` y el gancho `tecla`, que
   escucha en el lienzo, no lo recibe.
3. **Tormenta de arena** (§7). Botón 🌪 (tormenta a mano) y un calendario igual
   para todos: el día de Dubái (UTC+4) es un entero `d`; hay tormenta si
   `semillaMorfologia(d, 0x7a11, 41) % 17 === 0`; empieza a las 14, 15 o 16 h
   (bits 8–9 módulo 3) y dura 2, 3 o 4 h (bits 12–13 módulo 3), con media hora de
   subida y media de bajada; el viento sopla hacia el rumbo de los bits 16–24.
   En diez años (3.650 días desde hoy) salen 214 días: **1 de cada 17,1**. La
   próxima: 25-09-2026 de 16:00 a 18:00. El título del botón la dice.
   El botón 🌪 (`botonTormenta`): sin tormenta del calendario, la pone y la quita
   a mano; con una soplando, la quita **en este equipo** hasta que acabe
   (`tormenta.quitadaHasta`; el calendario sigue siendo el mismo para todos,
   verla o no es cosa de cada uno) y la devuelve si se vuelve a pulsar. El
   título dice en cuál de los tres estados está.
   En el gancho `cuadro`, **después** de la niebla del visor: niebla de arena
   (lejos a 380 m a pie; en órbita, distancia al objetivo + 380 m), fondo y
   niebla del color de la arena, cielo y estrellas ocultos, sol a un 20 %
   (ronda 2: también la copia del mar, `S.sea.material.uniforms.uSunColor`,
   que `updateSun` copia aparte; sin ella el agua seguía con el brillo
   especular entero), cielo y suelo teñidos, el mapa cúbico de reflejos
   (`envRT`, edificios y mar) borrado al color de la arena desde k = 0,35
   (ronda 2: `envTormenta`, seis caras de 128 px con una `CubeCamera` propia
   sobre una escena vacía; el núcleo lo rehace con el cielo cada ~2 s justo
   antes del gancho `sol`, que lo vuelve a teñir, y al acabar la tormenta el
   del cielo vuelve en ≤ 2 s), `camera.far` recortado al final de la niebla
   (×1,03), y 1.500 granos de arena (600 en «baja», 2.500 en «alta», 3.500 en
   «ultra») en una caja de 30 m alrededor de la cámara que se mueven en el
   sombreador (cero trabajo de CPU por cuadro), más claros que la niebla. Y
   **el terreno se recorta**: es una sola malla de toda la ciudad (513.024
   triángulos la fina) sin descarte posible; su índice va por filas, así que
   durante la tormenta un `drawRange` deja solo las filas dentro de
   `camera.far`. Todo se deshace al acabar. En VR no se recorta (las gafas
   llevan su proyección): si se entra con la tormenta puesta, el `drawRange` se
   devuelve entero en el primer cuadro con `S.xr`.
4. **Metro elevado y barcos** (§7).
   - El viaducto va sobre la troncal (≥ 40 km dentro del mapa) que pasa más
     cerca del Burj Khalifa: la E11 Sheikh Zayed Road trazada a mano
     (`meta.roads[12]`, 50,6 km, `S.vias[12]` en el núcleo; la E311 mide 50,5 y
     queda a varios km del Burj, por eso no se elige por longitud a secas). Si
     algún día el mapa trae una vía `troncal` con «Zayed» en el nombre, manda
     esa.
   - **Por la mediana** (ronda 2). La E11 tiene siete vértices dentro del mapa
     (el más cerrado, 13,7°). La esquina se redondea con una Bézier de
     tangente `min(600·tan(θ/2), 2·0,25/sen(θ/2))`: la curva se aparta de la
     polilínea `Lt·sen(θ/2)/2`, así que como mucho 0,25 m. Con el radio de
     600 m de la ronda 1 se apartaba 4,3 m y los pilares caían en el primer
     carril.
   - Perfil barrido de artesa con dos petos (8 lados) cada 30 m, cuatro
     carriles, un pilar con cabezal en cada muestra y 35 estaciones (una cada
     ~1,5 km, terminales metidas 70 m) con andenes, bóveda dorada, mamparas de
     vidrio y torre de acceso con **pasarela cubierta**. El pilar mide 2,4 m a
     lo largo del eje por **1 m de ancho** (antes 1,8 × 1,8): el primer carril
     de la E11 va a 1,96 m del eje y el coche mide 2 m de ancho, así que
     quedan 0,21 m de aire con la curva a 0,25 m.
   - **Dónde no va un pilar** (ronda 2): sobre un sólido; a menos de media
     calzada + 1,5 m de otra calle **con coches** (53: los cruces al mismo
     nivel con la trama de los barrios y uno con la vía 8; ahí el vano pasa a
     60 o 90 m); a menos de 24 m del centro de una **vuelta de los coches** de
     la E11 (14: los semicírculos de sus seis carriles cruzan el eje hasta
     19,25 m más allá del centro); y a menos de 5 m de un paso de peatones de
     la E11 (no hay ninguno).
   - `sitioEstacion` mueve cada estación lo mínimo (pasos de 60 m, hasta
     ±480 m, sin acercarse a menos de 600 m de la anterior) para que el andén
     caiga en tierra (5 puntos a ±60 m del eje con el campo ≥ 0,5 m y la malla
     > 0,3 m) y **fuera de todo sólido fijo** (ronda 2, `enSolidoFijo`: 27
     puntos del andén y la bóveda, ±60 m y ±9,5 m, contra el plano de los
     barrios y los hitos; la estación de DIFC caía dentro de The Gate), y la
     torre, a `medioVia + 4,5 m` del eje (30,95 m en la E11: fuera de los 21 m
     de calzada y de la acera), en tierra y sin edificio del plano de los
     barrios ni hito ni **calle o acera de otra vía** (`sitioLibre` con
     `otraVia`; ronda 2: la torre de la estación 10 caía a 3,6 m del eje de la
     vía 8). Las parcelas no cuentan: cambian con la cadena y la estación
     decide el horario. Cota: el suelo más alto a ±12 m del eje en ±90 m más
     10,5 m de gálibo, suavizada y nunca a menos de 8,5 m del suelo. Una malla
     por tesela de `TESELA_VIA` (10 teselas) con su esfera envolvente, material
     `plainMat` (ningún programa nuevo).
   - **Pilares y torres en el catastro** (ronda 2): 1.619 pilares y 35 torres
     dados de alta con `ctx.catastro.alta`, tipo `'hito'`, `id`
     `metro:pilar:<i>` / `metro:estacion:<i>` y nombre «Metro de Dubái» (el
     panel lo nombra al señalarlo). A pie se choca con ellos; el plano cercano
     de la profundidad lineal los ve. `recuentaChoques`, `sitioLibre` y
     `estacion(i)` saltan los `metro:`.
   - **Los coches de la E11 no bajan de 1,9 m del eje** (ronda 2,
     `medianaCoches`): el núcleo deja que un coche se desvíe hasta 1,2 m del
     eje para adelantar (`desvMin = 1,2 − off`) y ahí atravesaba el pilar; cada
     cuadro el módulo lo sube a `1,9 − off` para los coches cuya ruta es de la
     troncal.
   - Trenes de 5 coches en los dos sentidos, **función del reloj**: horario
     sacado del trazado (trapecio de 80 km/h y 1 m/s², 30 s por parada, 3 min en
     las terminales); ciclo 8.396 s dividido en 23 trenes (intervalo 365 s); el
     tren k está en `τ = (t − k·intervalo) mod ciclo`. Una malla instanciada con
     el descarte hecho a mano (solo se escriben los trenes cuya esfera de 50 m
     entra en la pirámide de visión y a menos de 12 km). En las terminales
     (ronda 2) el tren llega por su vía, espera ahí y sale por la otra por una
     **bretelle** de 150 m (`carrilTren`); antes saltaba 4,4 m de vía al
     empezar la espera.
   - Barcos: 7 rutas fijas (Marina: 5 yates; el Creek: 6 dhows de crucero y 4
     cruces de abras con 2 cada uno; la costa de Jumeirah: 3 dhows), 22 barcos,
     cada uno en un lazo (carril a la derecha, semicírculo, vuelta por el otro)
     con `s = (v·t + (i/n + desfase)·L) mod L`. Las rutas se sacaron del relieve
     del repositorio con una A* sobre el **agua visible** (máximo entre el campo
     de alturas y la malla fina de 138 m) exigiendo distancia a la orilla, y el
     cliente las **vuelve a comprobar al cargar** (`validaRuta`: cada 5 m, el
     punto y 8 direcciones a la holgura de la ruta tienen que estar bajo −0,3 m);
     una ruta que toque tierra no se usa y se cuenta. Tres mallas instanciadas
     (abra, yate, dhow) con el mismo descarte a mano (6 km).
   - **Las abras no se cruzan con los dhows** (ronda 2, `sincronizaAbras`):
     los 6 dhows del Creek, iguales y equiespaciados, repiten su
     configuración cada `P = L/(n·v)` = 953 s; la velocidad de cada abra se
     ajusta al número entero k de sus propios periodos dentro de P más
     cercano a 2,8 m/s (k = 10, 8, 8 y 8; de 2,72 a 2,97 m/s), así que todo el
     Creek se repite cada P; y el desfase de cada abra (`fase`, en 64avos de
     su lazo, fijado en `RUTAS`: 18, 12, 10 y 12) es el que deja más lejos a
     los demás barcos entre todos los posibles (`publico.fasesAbras()` los
     recorre; con el peor, la abra 3 pasaba a 0,6 m de un dhow). La media
     eslora de un dhow más la de un abra es 17,5 m; `crucesBarcos` comprueba
     al cargar, segundo a segundo durante un periodo, que ningún par de
     barcos de rutas distintas se acerca a menos de 20 m.
5. **Calidad**: en «baja» no se mueven ni dibujan trenes ni barcos (el viaducto
   sí); la arena escala con la calidad. `handle.stats().ext.extras` trae metro,
   barcos, tormenta, foto, sonido y los **triángulos y llamadas que el módulo
   envió en el último cuadro** (medidos en `trasPintar` con la misma prueba de
   esfera contra pirámide que usa three).

### Ronda 2 (sobre la integración), en una lista

- El plano de los barrios hace lo que se anunciaba: solo faltan los 100
  edificios que pisaban una vía; los 2.952 restantes conservan sitio, `id` y
  matiz (en la ronda 1 cambiaban 384).
- El metro va por la mediana: 0 coches solapados con un pilar en 400 s
  simulados; los pilares y las torres están en el catastro.
- La estación 10 ya no está en la vía 8, ni la de DIFC dentro de The Gate.
- Bretelle en las terminales; abras sincronizadas con los dhows (distancia
  mínima entre barcos de rutas distintas 34,5 m); mar y reflejos atenuados en
  la tormenta; modo foto a pantalla completa.
- Dos traducciones corregidas en `frag_extras.json` (zh «迪拜下一场» para
  «próxima en Dubái» y sw «Kiwango cha sauti» para «Volumen»: estas dos
  claves ya están en los diccionarios y el fragmento trae su valor nuevo) y
  una cadena nueva, «Metro de Dubái».

## Cómo está hecho, para quien lo toque después

- **Orden en `cuadro`**: `cuadroTormenta` (niebla, luz, mar, reflejos,
  `camera.far`, terreno) → `cuadroFoto` (fov, nivel, travelling) →
  `actualizaFrustum` (con `camera.updateWorldMatrix(true, false)`: a pie el
  rig se movió y su matriz de mundo todavía es la del cuadro anterior) →
  `cuadroMetro` → `medianaCoches` → `cuadroBarcos` → `actualizaSonido`. El
  núcleo recalcula niebla y `camera.far` en cada cuadro, así que la tormenta no
  tiene nada que deshacer ahí.
- **La luz de la tormenta**: el gancho `sol` guarda los valores recién
  calculados (`guardaBaseSol`); cada cuadro de tormenta escribe `base × factor`,
  nunca acumula. Al acabar, `restauraTormenta` copia la base de vuelta (también
  al mar), pone `scene.background` al objeto de niebla del visor, enseña cielo
  y estrellas y deja el `drawRange` del terreno en `(0, Infinity)`.
- **El recorte del terreno** (`recorteTerreno`) toca la geometría de `S.fine` y
  `S.coarse` del núcleo, solo mientras dura la tormenta. `buildTerrain` indexa
  por filas de `sx` casillas (6 índices cada una), de ahí `start = j0·sx·6`. El
  núcleo no hace rayos contra esa malla (la altura sale de
  `meshSurfaceHeight`), así que nada más lo nota.
- **Núcleo**: `planificarBarrios` rechaza también las posiciones cuya huella
  entra en una vía del mapa. `franjasDelMapa(meta)` trocea cada eje de
  `ejesDelMapa` cada 20 m con su medio ancho total (`anchoTotal` del ancho de
  `buildRoads`: por clase, o por la longitud remuestreada a `VIA_PASO`) en una
  rejilla de 256 m; `enViaDelMapa(F, x, z, margen)` mira las 3 × 3 celdas
  vecinas con la distancia al segmento. El margen es el mismo que el de
  `enCalle`, `max(fw, fd)/2`. **Ronda 2**: la comprobación va después de
  sacar `yawLibre` y `tono`, donde el intento consume de la serie del barrio
  lo mismo que sin la regla (en la ronda 1 iba antes y desplazaba dos puestos
  todo lo que venía detrás; la revisión midió 384 edificios distintos, en 24
  de los 34 barrios). El rechazado cuya huella estaba libre —el que sin la
  regla habría entrado— se da de alta en un catastro aparte (`fantasmas`,
  que se mira con `huellaLibre` junto al de verdad), suma uno a `sv`, y el
  bucle cuenta `j + sv` contra `c.count`; el edificio j se numera `j + sv`
  (`id` `kind:i:(j+sv)`, matiz `hash2(j + sv, i)`). Así cada intento se
  resuelve igual que sin la regla y solo faltan los que pisan una vía, sin
  sustitutos.
- **Choques tras cada `ciudad`**: `recuentaChoques` vuelve a contar los
  sólidos ajenos que corta el viaducto en `listo` y tras cada `applyCity`
  (gancho `ciudad`): una parcela comprada puede levantar su edificio bajo el
  viaducto después de construirlo. Es un aviso en
  `stats().ext.extras.metro.choques`; los pilares no se rehacen.
- **El metro frente a las demás calles**: `indiceViaNucleo(tr)` encuentra la
  troncal en `S.vias` (la vía del mapa cuya primera muestra es el primer punto
  de su línea); `indiceVias(vi)` trocea las demás por sus muestras en una
  rejilla de 256 m con su media calzada, su medio ancho total y si pasan
  coches (el trozo cae en una ruta de `S.trafficPaths`); `otraVia(F, x, z, r,
  soloCalzada)` responde con la vía que toca o −1. Los tramos «tapados» (una
  vía montada sobre otra casi paralela) no tienen coches en el núcleo: por eso
  siguen en pie los 18 pilares que la revisión encontró en la calzada de la
  vía 8 junto al nudo de Ibn Battuta, donde la vía 8 va sobre la E11 y el
  núcleo le quita el tráfico; los coches que pasan por ahí son los de la E11,
  por sus carriles (`final.mjs`: 18 pilares dentro de la calzada de otra vía
  del mapa, los 18 en la vía 8 y en tramos tapados, 0 en un tramo con
  coches).
- **La mediana va en el módulo** (`medianaCoches`) y no en el núcleo para no
  tocar la circulación, que es del frente «vida»: un coche recolocado recibe
  el `desvMin` por defecto y el cuadro siguiente lo corrige (el desvío cambia
  a `DESVIO_V·dt` por paso, así que en un paso no llega al pilar). Si «vida»
  añade una mediana por vía al núcleo, esta función sobra.
- **La bretelle**: `carrilTren(s, dir)` da el desplazamiento lateral de cada
  coche. El de ida va por +2,2 m salvo a menos de 44 m (medio tren) de la
  primera parada, donde está en −2,2 m, con una curva en S (`smoothstep`) de
  150 m entre las dos; el de vuelta, al revés en la última. La espera de la
  terminal cuenta ya con el sentido nuevo, así que el tren espera en la vía
  por la que llegó y sale por la otra. El giro de cada coche suma la
  pendiente de la S (`du/ds`). Los coches son simétricos: girar 180° al
  cambiar de sentido no se ve.
- **Las abras**: si se toca una ruta del Creek, hay que volver a elegir las
  `fase` con `handle.ext.extras.fasesAbras()` (devuelve, por abra, la
  distancia mínima a los demás barcos con cada fase posible) y comprobar
  `rutas().cruces === 0`.
- **Modo foto a pantalla completa**: solo cambia el estilo del contenedor
  (guardado como atributo entero); si el panel cambiara el estilo en línea de
  `#city3d` mientras dura el modo foto, al salir se pierde ese cambio.
- **Genotipo**: el trazado del metro sale de `meta.roads` (dato del mapa); el
  horario, del trazado y del reloj; los pilares que faltan, de las calles y
  rutas del núcleo (deterministas); los barcos, de las rutas fijas de `RUTAS`
  (con sus `fase`) y del reloj; el calendario, de `semillaMorfologia`; el
  ruido del sonido, de `lcg(20260922)`. No hay `Math.random` en el módulo.
- **Pruebas**: `handle.ext.extras` publica `reloj(ms, congelado)` (desplaza o
  congela el reloj del módulo), `tormenta(true|false|null)`, `calendario(n)`,
  `tormentaDelDia(d)`, `metro()` (con `pilaresSinPoner` y
  `solidosEnCatastro`), `tren(k, t)` (con `coches`: s, carril y posición de
  cada coche), `estacion(i)` (con `torre`: sitio, lado, suelo, el sólido
  ajeno que la toca, el suyo y la otra vía que pisa), `barcos(t)`, `rutas()`
  (con `periodo`, `distanciaMinima` y `cruces`), `fasesAbras()`,
  `foto.{entra, sale, focal, nivel, travelling, guardar, estado}`, `sonido()`
  y `gasto()`.
- **Estilo**: cajas del catálogo (`G.pushParts`, centradas en x y z, base en
  y = 0), coches, barcos y trenes con +X hacia delante y `yaw = atan2(−tz, tx)`
  como los coches del núcleo; `setColorAt` en blanco para compartir el programa
  de la malla del tráfico.

## Cifras medidas (panel real, Chromium por software, 1280 × 800, visor 644 × 560)

Ronda 2, binario de la integración, scripts en `/tmp/ramiwt/extras/r2/`.

| | |
|---|---|
| Plano de los barrios (`plano.mjs`, 80067fa sin la regla frente a la rama) | 3.052 → 2.952 edificios; **2.952 comunes con el mismo sitio, altura, ancho, `id` y matiz**; 100 solo en la base (los que pisaban una vía), 0 solo en la rama; 122 rechazos por vía (22 habrían chocado con otra huella de todos modos). Ronda 1: 3.048, con 384 distintos |
| Metro | 50,6 km, 1.688 muestras, **1.619 pilares** (sin poner: 53 en cruces con otra calle con coches, 14 junto a una vuelta de la E11, 0 en pasos de peatones, 2 sobre The Gate), 1.654 sólidos en el catastro (1.619 + 35 torres), 35 estaciones (4 movidas, 0 sin acceso, 0 sobre el agua, **0 torres a menos de 35 m de otra vía del mapa**; la 10 a 64,3 m de la vía 8), 85.504 triángulos en 10 teselas, 23 trenes, intervalo 365 s, ciclo 8.396 s, 60 triángulos por coche |
| Coches y pilares (`datos.mjs`, 400 s simulados con `_debug.paso(0,25)`) | 6.900 muestras de coches de la E11, 205.059 comprobaciones coche-pilar cercanas, **0 solapes** (cajas orientadas: coche 4,6 × 2 m); el coche de la E11 más cerca del eje fuera de una vuelta, a 1,96 m. La revisión contó 40 muestras a menos de 1,8 m del eje |
| A pie | 50 de 50 pilares y 35 de 35 torres sacan al jugador (`empujarFuera`); andando 3 s contra el pilar 405 se para a 0,92 m de su centro (0,5 + 0,42) con `walk.choque` = `metro:pilar:405` |
| Trenes en las terminales | salto lateral máximo de un coche en 1 s: **0,78 m** (en la bretelle; antes 4,4 m de golpe); desplazamiento máximo en 1 s: 22,4 m (80 km/h) |
| Trenes y sólidos | 300 instantes × 23 trenes = 6.900 posiciones: 6 dentro de un sólido ajeno, las 6 en `difc_gate` (ver «Lo que queda») |
| Barcos | 7 rutas, 0 descartadas, 22 barcos, 9.759 muestras comprobadas al cargar, 0 en tierra; periodo del Creek 953 s; en un periodo, segundo a segundo, distancia mínima entre barcos de rutas distintas **34,5 m** y 0 muestras a menos de 20 m |
| Barcos en el tiempo | 1.200 instantes cada 3 s (1 h) × 22 barcos: 0 en tierra (la más alta a −0,80 m), **0 cruces a menos de 10 m** (antes 4, uno a 4,2 m) y 0 a menos de 20 m; mínima 34,5 m |
| Calendario | 214 días de tormenta en 3.650 (1 de cada 17,1); 30 en los próximos 365; inicio a las 14 h (14), 15 h (9), 16 h (7) (ronda 1; sin cambios) |
| Calidad baja | 0 coches de tren y 0 barcos dibujados (ronda 1 y revisión 2; sin cambios en ese código) |

**A/B sin tormenta** frente a la referencia de la integración
(`/tmp/ramiharness/referencia_integ_ab.json`, medida sobre 80067fa, que ya
lleva el módulo de la ronda 1) → `/tmp/ramiverif/extras_r2_ab.json`.
«Módulo» son los triángulos que el propio módulo anota en
`stats().ext.extras.triangulos` en el mismo encuadre (de la pasada «sin» de
`extras_r2_tormenta_ab.json`; trenes y barcos se mueven con el reloj):

| Encuadre | referencia | esta rama | Δ | módulo | Llamadas |
|---|---|---|---|---|---|
| Torres de cerca | 909.372 | 908.540 | −832 | 16.392 | 29 → 29 |
| Manzana de bloques | 798.932 | 787.750 | −11.182 | 128 | 28 → 31 |
| Villas | 966.820 | 961.804 | −5.016 | 128 | 22 → 23 |
| Naves | 1.058.812 | 1.054.868 | −3.944 | 32.912 | 32 → 31 |
| A pie en la manzana | 978.500 | 971.102 | −7.398 | 15.680 | 39 → 40 |
| A pie ante una torre | 819.110 | 818.098 | −1.012 | 16.224 | 24 → 24 |
| Ciudad entera | 1.807.624 | 1.795.544 | −12.080 | 85.504 | 101 → 101 |
| Centro | 1.534.718 | 1.525.866 | −8.852 | 40.308 | 51 → 52 |

Lo que baja son los 96 edificios de barrio que ya no están (3.048 en la
integración, 2.952 ahora) y 1.608 triángulos del viaducto (67 pilares menos);
en la ciudad entera, que no depende del reloj (las dos pasadas dan
1.795.544), −12.080 = −1.608 del viaducto y −10.472 del resto. En los
encuadres cercanos lo que se mueve pesa más que eso: en «manzana de bloques»
la pasada del A/B dio 787.750 triángulos y 31 llamadas, y la «sin» de la
tormenta, minutos después y en el mismo encuadre, 756.756 y 24 (peatones y
coches de la integración). Las llamadas de más (+1 a +3) están dentro de esa
variación.

**Tormenta** (mismos encuadres, sin → con tormenta a mano;
`/tmp/ramiverif/extras_r2_tormenta_ab.json`):

| Encuadre | Triángulos sin | con | Llamadas sin | con | camera.far con |
|---|---|---|---|---|---|
| Torres de cerca | 889.560 | 413.838 (−53 %) | 29 | 26 | 1.318 m |
| Manzana de bloques | 756.756 | 296.790 (−61 %) | 24 | 29 | 824 m |
| Villas | 936.844 | 458.152 (−51 %) | 23 | 21 | 618 m |
| Naves | 1.025.408 | 532.876 (−48 %) | 30 | 27 | 783 m |
| A pie en la manzana | 968.722 | 295.870 (−69 %) | 39 | 26 | 392 m |
| A pie ante una torre | 788.978 | 306.994 (−61 %) | 24 | 22 | 391 m |
| Ciudad entera | 1.795.544 | 1.699.168 (−5 %) | 101 | 83 | 76.680 m |
| Centro | 1.525.866 | 619.534 (−59 %) | 51 | 26 | 3.035 m |

Las llamadas de «manzana de bloques» suben con la tormenta (24 → 29): la
arena es una, y el resto es la variación de peatones y coches entre las dos
pasadas (el A/B, sin tormenta, dio 31 en ese encuadre). Sin el recorte del
terreno (primera medida, solo con `camera.far`) la tormenta ahorraba un
0,4–2 %: lo que compra es el terreno (−500.000 triángulos) y las teselas
lejanas. En la ciudad entera casi no ahorra: vista desde 74 km, la niebla
termina a 74 km.

**El mar en la tormenta** (`visual.mjs`, a las 16:30): con la tormenta, el
color del sol del mar pasa de (1,219; 0,896; 0,465) a (0,244; 0,179; 0,093),
igual que el compartido; al acabar vuelve a (1,219; 0,896; 0,465).

**Modo foto** (`foto2.mjs`, con clics de ratón de verdad): antes, contenedor
644 × 560, lienzo 644 × 560, la barra del panel visible, desplazamiento
408 px. Dentro, contenedor y lienzo **1.280 × 800**, el punto central del
botón «Centro» del panel cae en el lienzo (tapado), el foco en `BODY`, 50 mm
(fov 27°). La descarga llega por `page.waitForEvent('download')`:
`dubai-rami-20260923-181406.png`, 1.894.138 B, 1.280 × 800, con el pie
(mirado). Escape: modo foto apagado, estilo `display: block;` como antes,
644 × 560, desplazamiento 408, órbita con `theta` 0,7, radio 900 y fov 50.

**Sonido** (código sin cambios en la ronda 2; `sonido.mjs` sobre la
integración): antes del clic no hay `AudioContext` (`estado` null); tras un
clic de ratón en 🔇, `running`, 22 nodos, preferencia `'1'`,
`play('timbre'|'puerta'|'clic'|'paso')` → `true` y `play('nada')` → `false`
sin lanzar. Con la preferencia `'1'` y la página recargada: antes del gesto
`null` y 🔇; el primer gesto es el clic en 🔇 → `running`, 🔊 y `'1'`; el
segundo clic apaga (`suspended`, `'0'`); con el primer gesto en el lienzo,
enciende. 0 errores de consola. **No se ha oído**: el entorno no tiene salida
de audio.

## Capturas (en /tmp/ramiverif, miradas)

- Ronda 2: `extras_r2_cruce_sin_pilar.png` (un cruce de la trama con la E11:
  el vano salta el cruce), `extras_r2_estacion10_orbita.png` (la estación 10
  con la torre fuera de las dos vías), `extras_r2_bretelle_terminal.png` (un
  tren en la bretelle de la terminal: los coches pasan de una vía a la otra
  en diagonal), `extras_r2_pilar_a_pie.png` (a pie contra un pilar, parado a
  su lado), `extras_r2_gate_viaducto.png` (The Gate sobre la E11, con la
  estación de DIFC ya fuera), `extras_r2_creek_abra_dhow.png` (un abra y un
  dhow en su paso más cercano, 52,8 m), `extras_r2_mar_sin_tormenta.png` /
  `extras_r2_mar_con_tormenta.png` (la Marina a las 16:30),
  `extras_r2_foto_pantalla.png` (el modo foto tapa la página entera),
  `extras_r2_foto_descargada.png` (el PNG), `extras_r2_foto_tras_salir.png`
  (el panel como estaba), `extras_r2_gate_orbita.png` (The Gate antes de
  mover la estación).
- Ronda 1: `extras_r1_estacion_torre.png`, `extras_r1_estacion_a_pie.png`,
  `extras_r1_viaducto_business_bay.png`, `extras_r1_tormenta_granos.png`,
  `extras_r1_foto_modo_pantalla.png`, `extras_r1_foto_descargada.png`,
  `extras_r1_foto_tras_salir.png`.
- Primera ronda: metro `extras_metro_tren_marcha.png`,
  `extras_metro_a_pie_tren.png`; barcos `extras_barcos_creek_abra.png`,
  `extras_barcos_creek_dhow.png`, `extras_barcos_marina_yate.png`,
  `extras_barcos_costa_dhow.png`; tormenta
  `extras_tormenta_a_pie_manzana_sin.png` / `_con.png`.
- A/B: `extras_r2_*.png` de `ab.mjs` y de `tormenta_ab.mjs`,
  `/tmp/ramiverif/extras_r2_ab.json`, `/tmp/ramiverif/extras_r2_tormenta_ab.json`.
  Scripts y registros de la ronda 2 en `/tmp/ramiwt/extras/r2/` (`plano.mjs`,
  `mide.mjs`, `fases.mjs`, `datos.mjs`, `visual.mjs`, `gate2.mjs`,
  `foto2.mjs`, `sonido.mjs`, `tormenta_ab.mjs`, `*.log`).

## Lo que queda

1. **The Gate está sobre la E11**. El hito `difc_gate` (120 × 60 m, 101 m de
   alto) tiene el centro a 40,3 m del eje de la E11 trazada a mano, y su
   huella entra en la calzada: en 400 s con la cámara allí, 510 de 5.529
   muestras de coches de la E11 cayeron dentro de su huella, y el viaducto la
   corta en 2 muestras (en 6.900 posiciones de tren, 6 dentro). Antes de la
   integración no se detectaba porque el catastro giraba las huellas al revés.
   Es un choque entre dos datos del mapa (la posición del hito y el trazado de
   la E11); el módulo ya no pone ahí estación ni pilar, pero el viaducto,
   como la calzada, pasa por la huella. Hay que mover el hito o el trazado
   en el dataset.
2. **El Creek no llega al mar en el agua visible**: la malla fina de 138 m
   cierra la boca norte, igual que el codo del canal de la Marina. Por eso los
   dhows del Creek no salen al mar y los yates de la Marina solo recorren el
   tramo sur (2,5 km).
3. **Los peatones de «vida» y los pilares**: «vida» construye su grafo en su
   `listo`, antes que el de `extras` (orden de carga), así que el primer grafo
   no ve los pilares ni las torres; los que rehace tras un cambio de la
   ciudad, sí. Los pilares están en la mediana (sin pasos de peatones en la
   E11) y las torres a 1 m de la acera; no he medido si el grafo cambia.
4. **La tormenta a mano sube en 3 s de reloj de simulación**: a 1 cuadro por
   segundo (software) son 30 cuadros.
5. **El sonido no se ha escuchado** en ninguna máquina: aquí no hay salida de
   audio. Los niveles están elegidos a mano y falta oírlos.
6. **Sin horario de servicio**: el metro circula las 24 h.
7. **Las etiquetas no llevan niebla**: en la tormenta los nombres de lugares
   siguen viéndose a través de la arena.
8. **El pase de sombras** no se reduce en la tormenta: cambiar `castShadow`
   recompila todos los materiales.
9. **Una parcela bajo el viaducto**: `recuentaChoques` la cuenta, pero ni el
   viaducto ni sus pilares se rehacen.
10. **Los reflejos de la tormenta** usan un color fijo (el de la arena por la
    luz del día), no el cielo teñido; al acabar la tormenta el cielo vuelve al
    mapa cúbico en la siguiente actualización del sol (≤ 2 s).
11. **VR sin probar**: no hay gafas; el `drawRange` y el mapa cúbico en VR solo
    se han revisado leyendo el código.
12. **Los coches ajenos a la E11 que cruzan por donde no hay ruta**: un pilar
    se quita donde otra calle **con coches** cruza; si el núcleo abre tráfico
    en un tramo hoy «tapado», ese pilar no se quita hasta recargar.
