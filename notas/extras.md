# Frente «extras» (v0.11.0): sonido, modo foto, tormenta de arena, metro elevado y barcos

Todo en `chain/crates/rami-gui/src/city/extras.js` (un módulo del visor, ES5),
más las cadenas en `chain/crates/rami-gui/i18n-src/frag_extras.json` y cinco
líneas en `docs/EXTENSIONES-3D.md` (el servicio `servicios.sonido`). **No toca
el núcleo** (`city3d.js`), ni `dashboard.html`, ni el consenso, la red o el nodo.
La interfaz la crea el propio módulo: una barra flotante abajo a la derecha del
visor con 🔇/🔊 (y su volumen), 📷 y 🌪.

## Qué hace

1. **Sonido sintetizado** (§6 del plan). Ni un fichero de audio.
   - El `AudioContext` se crea en el clic del botón 🔊 (apagado por defecto), o
     en el primer gesto sobre la página si la preferencia guardada
     (`localStorage['rami.sonido']`, con try/catch) dice que estaba encendido.
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
2. **Modo foto** (§7). Botón 📷: oculta todo lo que cuelga del contenedor salvo
   el lienzo y su propia barra (pistas, avisos, barras de otros módulos), las
   etiquetas (`material.visible = false` en cada `LabelSet` de la escena,
   también las de los módulos) y la selección y el cursor de casilla. Focal de
   14 a 200 mm en escala logarítmica (fov vertical = `2·atan(12/f)`), horizonte
   nivelado con **desplazamiento de la ventana de proyección** (la cámara no se
   inclina y el encuadre se conserva con `setViewOffset`: las verticales de los
   rascacielos quedan verticales), travelling lento (órbita a 1,2°/s o lateral a
   pie a 1,2 m/s) y «cámara libre» (a pie volando a 40 m, WASD, Q/E y arrastrar).
   «Guardar» copia el lienzo en el gancho `trasPintar` —justo después de dibujar:
   el lienzo no tiene `preserveDrawingBuffer`— en un lienzo 2D, le pone el pie
   «Dubái RAMI · red de pruebas, sin valor monetario» (§8: una foto que circule
   fuera del panel sigue diciendo lo que es) y lo descarga como
   `dubai-rami-AAAAMMDD-HHMMSS.png`. Salir (botón o Escape) lo restaura todo.
3. **Tormenta de arena** (§7). Botón 🌪 (tormenta a mano) y un calendario igual
   para todos: el día de Dubái (UTC+4) es un entero `d`; hay tormenta si
   `semillaMorfologia(d, 0x7a11, 41) % 17 === 0`; empieza a las 14, 15 o 16 h
   (bits 8–9 módulo 3) y dura 2, 3 o 4 h (bits 12–13 módulo 3), con media hora de
   subida y media de bajada; el viento sopla hacia el rumbo de los bits 16–24.
   En diez años (3.650 días desde hoy) salen 214 días: **1 de cada 17,1**. La
   próxima: 25-09-2026 de 16:00 a 18:00. El título del botón la dice.
   En el gancho `cuadro`, **después** de la niebla del visor: niebla de arena
   (lejos a 380 m a pie; en órbita, distancia al objetivo + 380 m), fondo y
   niebla del color de la arena, cielo y estrellas ocultos, sol a un 20 % y cielo
   y suelo teñidos, `camera.far` recortado al final de la niebla (×1,03), y 900
   granos de arena (300 en «baja», 1.500 en «alta», 2.000 en «ultra») en una caja
   de 60 m alrededor de la cámara que se mueven en el sombreador (cero trabajo de
   CPU por cuadro). Y **el terreno se recorta**: es una sola malla de toda la
   ciudad (513.024 triángulos la fina) sin descarte posible; su índice va por
   filas, así que durante la tormenta un `drawRange` deja solo las filas dentro
   de `camera.far`. Todo se deshace al acabar.
4. **Metro elevado y barcos** (§7).
   - El viaducto va sobre la troncal (≥ 40 km dentro del mapa) que pasa más
     cerca del Burj Khalifa: la E11 Sheikh Zayed Road trazada a mano
     (`meta.roads[12]`, 50,6 km; la E311 mide 50,5 y queda a varios km del
     Burj, por eso no se elige por longitud a secas). Si algún día el mapa trae
     una vía `troncal` con «Zayed» en el nombre, manda esa.
   - Perfil barrido de artesa con dos petos (8 lados) cada 30 m, con las
     esquinas del trazado redondeadas (Bézier de tangente `600·tan(θ/2)`), cuatro
     carriles, un pilar con cabezal en cada muestra y 35 estaciones (una cada
     ~1,5 km, terminales metidas 70 m) con andenes, bóveda dorada, mamparas de
     vidrio y torre de acceso. Cota: el suelo más alto a ±12 m del eje en ±90 m
     más 10,5 m de gálibo, suavizada y nunca a menos de 8,5 m del suelo. Una
     malla por tesela de `TESELA_VIA` (10 teselas) con su esfera envolvente,
     material `plainMat` (ningún programa nuevo).
   - Trenes de 5 coches en los dos sentidos, **función del reloj**: horario
     sacado del trazado (trapecio de 80 km/h y 1 m/s², 30 s por parada, 3 min en
     las terminales); ciclo 8.396 s dividido en 23 trenes (intervalo 365 s); el
     tren k está en `τ = (t − k·intervalo) mod ciclo`. Una malla instanciada con
     el descarte hecho a mano (solo se escriben los trenes cuya esfera de 50 m
     entra en la pirámide de visión y a menos de 12 km).
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
5. **Calidad**: en «baja» no se mueven ni dibujan trenes ni barcos (el viaducto
   sí); la arena escala con la calidad. `handle.stats().ext.extras` trae metro,
   barcos, tormenta, foto, sonido y los **triángulos y llamadas que el módulo
   envió en el último cuadro** (medidos en `trasPintar` con la misma prueba de
   esfera contra pirámide que usa three).

## Cómo está hecho, para quien lo toque después

- **Orden en `cuadro`**: `cuadroTormenta` (niebla, luz, `camera.far`, terreno) →
  `cuadroFoto` (fov, nivel, travelling) → `actualizaFrustum` (con
  `camera.updateWorldMatrix(true, false)`: a pie el rig se movió y su matriz de
  mundo todavía es la del cuadro anterior) → `cuadroMetro` → `cuadroBarcos` →
  `actualizaSonido`. El núcleo recalcula niebla y `camera.far` en cada cuadro,
  así que la tormenta no tiene nada que deshacer ahí.
- **La luz de la tormenta**: el gancho `sol` guarda los valores recién
  calculados (`guardaBaseSol`); cada cuadro de tormenta escribe `base × factor`,
  nunca acumula. Al acabar, `restauraTormenta` copia la base de vuelta, pone
  `scene.background` al objeto de niebla del visor, enseña cielo y estrellas y
  deja el `drawRange` del terreno en `(0, Infinity)`.
- **El recorte del terreno** (`recorteTerreno`) toca la geometría de `S.fine` y
  `S.coarse` del núcleo: es el único estado ajeno que el módulo cambia, y solo
  mientras dura la tormenta. `buildTerrain` indexa por filas de `sx` casillas
  (6 índices cada una), de ahí `start = j0·sx·6`. El núcleo no hace rayos contra
  esa malla (la altura sale de `meshSurfaceHeight`), así que nada más lo nota.
- **Genotipo**: el trazado del metro sale de `meta.roads` (dato del mapa); el
  horario, del trazado y del reloj; los barcos, de las rutas fijas de
  `RUTAS` y del reloj; el calendario, de `semillaMorfologia`; el ruido del
  sonido, de `lcg(20260922)`. No hay `Math.random` en el módulo.
- **Pruebas**: `handle.ext.extras` publica `reloj(ms, congelado)` (desplaza o
  congela el reloj del módulo), `tormenta(true|false|null)`, `calendario(n)`,
  `tormentaDelDia(d)`, `metro()`, `tren(k, t)`, `estacion(i)`, `barcos(t)`,
  `rutas()`, `foto.{entra, sale, focal, nivel, travelling, guardar, estado}`,
  `sonido()` y `gasto()`.
- **Estilo**: cajas del catálogo (`G.pushParts`, centradas en x y z, base en
  y = 0), coches, barcos y trenes con +X hacia delante y `yaw = atan2(−tz, tx)`
  como los coches del núcleo; `setColorAt` en blanco para compartir el programa
  de la malla del tráfico.

## Cifras medidas (panel real, Chromium por software, 1280 × 800, visor 644 × 560)

**Lo que hay:**

| | |
|---|---|
| Metro | 50,6 km, 1.688 muestras, 1.666 pilares, 35 estaciones, 86.212 triángulos en 10 teselas, 23 trenes, intervalo 365 s, ciclo 8.396 s, 60 triángulos por coche |
| Barcos | 7 rutas, 0 descartadas, 22 barcos, 9.759 muestras comprobadas al cargar, 0 en tierra |
| Barcos en el tiempo | 400 instantes en 3 h × 22 barcos = 8.800 posiciones: 0 sobre tierra, la más alta a −0,8 m |
| Trenes en el tiempo | 200 instantes × 23 trenes = 4.600 posiciones: 0 fuera de la línea |
| Calendario | 214 días de tormenta en 3.650 (1 de cada 17,1); 30 en los próximos 365; inicio a las 14 h (14), 15 h (9), 16 h (7) |
| Calidad baja | 0 coches de tren y 0 barcos dibujados |

**A/B sin tormenta** (los ocho encuadres fijos, binario base con el
`dashboard.html` de la rama; referencia v0.10.16 → esta rama; los trenes y los
barcos se mueven con el reloj, así que en los encuadres donde asoman la cifra
depende del instante):

| Encuadre | Triángulos v0.10.16 | esta rama | Δ | Llamadas | Δ |
|---|---|---|---|---|---|
| Torres de cerca | 920.678 | 937.022 | +16.344 (+1,8 %) | 21 → 23 | +2 |
| Manzana de bloques | 790.042 | 790.170 | +128 (+0,0 %) | 17 → 18 | +1 |
| Villas | 959.508 | 959.636 | +128 (+0,0 %) | 15 → 16 | +1 |
| Naves | 1.014.414 | 1.047.458 | +33.044 (+3,3 %) | 21 → 24 | +3 |
| A pie en la manzana | 952.544 | 968.284 | +15.740 (+1,7 %) | 28 → 30 | +2 |
| A pie ante una torre | 802.440 | 818.616 | +16.176 (+2,0 %) | 17 → 18 | +1 |
| Ciudad entera | 1.748.908 | 1.835.120 | +86.212 (+4,9 %) | 86 → 96 | +10 |
| Centro | 1.532.854 | 1.574.026 | +41.172 (+2,7 %) | 42 → 46 | +4 |

Toda la diferencia es del módulo: en cada encuadre coincide con los triángulos que el propio módulo anota en `stats().ext.extras.triangulos` (p. ej. naves +33.044 = 33.044; ciudad entera +86.212 = el viaducto entero). Los 128 triángulos de «manzana de bloques» y «villas» son un barco (una abra lejana del Creek).

**Tormenta** (mismos encuadres, sin → con tormenta a mano):

| Encuadre | Triángulos sin | con | Llamadas sin | con | camera.far con |
|---|---|---|---|---|---|
| Torres de cerca | 937.106 | 440.240 (−53 %) | 23 | 20 | 1.318 m |
| Manzana de bloques | 790.170 | 288.810 (−63 %) | 18 | 16 | 824 m |
| Villas | 959.636 | 455.204 (−53 %) | 16 | 14 | 618 m |
| Naves | 1.047.458 | 526.066 (−50 %) | 24 | 21 | 783 m |
| A pie en la manzana | 968.584 | 288.438 (−70 %) | 31 | 17 | 392 m |
| A pie ante una torre | 818.616 | 307.512 (−62 %) | 18 | 16 | 391 m |
| Ciudad entera | 1.835.120 | 1.739.734 (−5 %) | 96 | 78 | 76.680 m |
| Centro | 1.573.726 | 673.616 (−57 %) | 46 | 21 | 3.035 m |

Sin el recorte del terreno (primera medida, solo con `camera.far`) la tormenta
ahorraba un 0,4–2 % en seis de los ocho encuadres: las teselas de 8 km que
contienen la cámara se envían enteras y el terreno es una malla única. Lo que
compra la tormenta es el terreno (−500.000 triángulos) y las llamadas de las
teselas lejanas. En la ciudad entera casi no ahorra: vista desde 74 km, la
niebla termina a 74 km.

**Restauración de la tormenta** (tres pasos de simulación con ella y tres sin
ella): dentro, `drawRange` del terreno 138.240 índices, cielo oculto,
`camera.far` 3.035 m, color del sol de (1,36; 1,15; 0,81) a (0,27; 0,23; 0,16) y
el fondo es la niebla; fuera, `drawRange` `Infinity`, cielo visible y el color
del sol exactamente el de antes.

**Sonido**: antes del clic no hay `AudioContext` (`sonido().estado === null`);
tras el clic de ratón en 🔊, `running`, 22 nodos en el grafo, preferencia
`'1'` guardada, `play('timbre'|'puerta'|'clic'|'paso')` → `true` sin lanzar,
`play('no-existe')` → `false`; 12 m a pie en 20 pasos de simulación de 0,1 s
dan 10 pasos. **No se ha oído**: el entorno no tiene salida de audio; lo
comprobado es que el grafo existe y funciona sin errores.

**Modo foto**: dentro, lo único visible del contenedor es la barra del modo foto
y las 8 etiquetas de la escena están ocultas; a 85 mm el fov es 16,1°; la
descarga llega por `page.waitForEvent('download')` como
`dubai-rami-20260922-214931.png` (644 × 560, 211.532 B) y es el mismo cuadro con
el pie; al salir, fov 50°, sin desplazamiento de ventana, 0 etiquetas ocultas y
la barra de vuelta.

## Capturas (en /tmp/ramiverif)

- Metro: `extras_metro_tren_marcha.png` (tren de 5 coches en marcha sobre el
  viaducto), `extras_metro_estacion_tren.png` (estación con bóveda dorada),
  `extras_metro_cenital.png` (la estación exactamente sobre el eje de la
  calzada; distancia al eje 0 m), `extras_metro_viaducto.png`,
  `extras_metro_a_pie.png` y `extras_metro_a_pie_tren.png` (a pie bajo el
  viaducto con el tren encima), `extras_metro_orbita_lejos.png`.
- Barcos: `extras_barcos_creek_abra.png`, `extras_barcos_creek_dhow.png`,
  `extras_barcos_marina_yate.png` (dos yates en el canal),
  `extras_barcos_costa_dhow.png`.
- Tormenta: `extras_tormenta_a_pie_manzana_sin.png` / `_con.png`,
  `extras_tormenta_torres_cerca_sin.png` / `_con.png` (primera medida),
  `extras_tormenta_boton_a_pie.png` (con el botón, subiendo, con granos).
- Foto: `extras_foto_modo_pantalla.png` (sin interfaz, 85 mm, nivelado),
  `extras_foto_descargada.png` (el PNG descargado), `extras_foto_tras_salir.png`.
- A/B: `extras_*.png` de `ab.mjs` y `/tmp/ramiverif/extras_ab.json`;
  tormenta en `/tmp/ramiverif/extras_tormenta_ab.json`.

## Lo que queda

1. **Edificios de barrio sobre la Sheikh Zayed Road.** No es del módulo: el
   planificador de barrios (`planificarBarrios` → `enCalle`) solo evita las
   calles de barrio y las glorietas, no las vías del mapa. Medido: 35 sólidos
   del catastro tienen el centro a menos de 21 m + media huella del eje de la
   E11 (entre ellos el hito `difc_gate`), y el viaducto atraviesa 12 de ellos
   (16 muestras; `stats().ext.extras.metro.choques` y `choqueIds`). Se arregla
   en el núcleo haciendo que `planificarBarrios` rechace también la calzada de
   `ejesDelMapa`.
2. **El Creek no llega al mar en el agua visible**: la malla fina de 138 m
   cierra la boca norte, igual que el codo del canal de la Marina. Por eso los
   dhows del Creek no salen al mar y los yates de la Marina solo recorren el
   tramo sur (2,5 km). Si se afina la malla o el estampado del canal, las rutas
   se alargan sin tocar nada más.
3. **La tormenta a mano sube en 3 s de reloj de simulación**: con el paso de
   cuadro limitado a 0,1 s por el núcleo, a 1 cuadro por segundo (software) son
   30 cuadros. En una tarjeta de verdad son 3 s.
4. **El sonido no se ha escuchado** en ninguna máquina: aquí no hay salida de
   audio. Los niveles están elegidos a mano y falta oírlos.
5. **Sin horario de servicio**: el metro circula las 24 h (el de Dubái cierra de
   madrugada). Ligarlo a la hora real es una línea en `posTren`, pero entonces
   de madrugada nadie ve trenes aunque ponga la escena a mediodía.
6. **Las etiquetas no llevan niebla**: en la tormenta los nombres de lugares
   siguen viéndose a través de la arena.
7. **El pase de sombras** no se reduce en la tormenta (el sol a un 20 % sigue
   proyectando): cambiar `castShadow` recompila todos los materiales.
