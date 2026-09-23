# Frente «extras» (v0.11.0): sonido, modo foto, tormenta de arena, metro elevado y barcos

Casi todo en `chain/crates/rami-gui/src/city/extras.js` (un módulo del visor,
ES5), más las cadenas en `chain/crates/rami-gui/i18n-src/frag_extras.json` y
unas líneas en `docs/EXTENSIONES-3D.md` (el servicio `servicios.sonido` y la
regla nueva del plano de los barrios). **Del núcleo solo toca
`planificarBarrios`** (`city3d.js`, dos funciones nuevas justo encima:
`franjasDelMapa` y `enViaDelMapa`; ver «Núcleo» más abajo). Ni
`dashboard.html`, ni el consenso, la red o el nodo.
La interfaz la crea el propio módulo: una barra flotante abajo a la derecha del
visor con 🔇/🔊 (y su volumen), 📷 y 🌪.

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
   `dubai-rami-AAAAMMDD-HHMMSS.png`. Salir (botón ✕ o Escape) lo restaura todo:
   fov, ventana, etiquetas, interfaz **y la pose** (modo, posición a pie, `fly`,
   órbita de `cur` y `goal`, vuelo de cámara), que `entraFoto` guarda entera en
   `foto.guardado`. Escape se escucha en el documento (en captura) mientras
   dura el modo foto: al pulsar 📷 el botón desaparece, el foco pasa al `body` y
   el gancho `tecla`, que escucha en el lienzo, no lo recibe.
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
   niebla del color de la arena, cielo y estrellas ocultos, sol a un 20 % y cielo
   y suelo teñidos, `camera.far` recortado al final de la niebla (×1,03), y 1.500
   granos de arena (600 en «baja», 2.500 en «alta», 3.500 en «ultra») en una caja
   de 30 m alrededor de la cámara que se mueven en el sombreador (cero trabajo de
   CPU por cuadro), más claros que la niebla. La primera versión llevaba 900 en
   60 m del color de la niebla y a pie se veían 2 o 3 por cuadro; ahora la
   densidad es 13 veces mayor y se ven unos 30 (captura
   `extras_r1_tormenta_granos.png`). Y **el terreno se recorta**: es una sola malla de toda la
   ciudad (513.024 triángulos la fina) sin descarte posible; su índice va por
   filas, así que durante la tormenta un `drawRange` deja solo las filas dentro
   de `camera.far`. Todo se deshace al acabar. En VR no se recorta (las gafas
   llevan su proyección): si se entra con la tormenta puesta, el `drawRange` se
   devuelve entero en el primer cuadro con `S.xr`.
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
     vidrio y torre de acceso con **pasarela cubierta**. `sitioEstacion` mueve
     cada estación lo mínimo (pasos de 60 m, hasta ±480 m, sin acercarse a
     menos de 600 m de la anterior) para que el andén caiga en tierra (5 puntos
     a ±60 m del eje con el campo ≥ 0,5 m y la malla > 0,3 m) y la torre, a
     `medioVia + 4,5 m` del eje (30,95 m en la E11: fuera de los 21 m de
     calzada y de la acera), en tierra y sin edificio del plano de los barrios
     ni hito (`sitioLibre`; las parcelas no cuentan porque cambian con la
     cadena y la estación decide el horario). Antes la torre iba a 13,5 m del
     eje, dentro de la calzada, y la estación 30 caía sobre el agua (campo
     −3 m). Ahora: 2 estaciones movidas, 0 sin acceso, 0 sobre el agua. Cota: el suelo más alto a ±12 m del eje en ±90 m
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
- **Núcleo (ronda 1)**: `planificarBarrios` rechaza también las posiciones
  cuya huella entra en una vía del mapa. `franjasDelMapa(meta)` trocea cada eje
  de `ejesDelMapa` cada 20 m con su medio ancho total (`anchoTotal` del ancho de
  `buildRoads`: por clase, o por la longitud remuestreada a `VIA_PASO`) en una
  rejilla de 256 m; `enViaDelMapa(F, x, z, margen)` mira las 3 × 3 celdas
  vecinas con la distancia al segmento. El margen es el mismo que el de
  `enCalle`, `max(fw, fd)/2`. El rechazo va justo después de `enCalle`, antes
  de sacar `yawLibre` y `tono`, así que la serie del barrio consume los mismos
  números que con un rechazo de calle: los edificios que no pisaban nada
  quedan donde estaban (cambia su índice `j` dentro del barrio, y con él el
  `id` y el matiz `hash2(j, i)`). Medido antes: 100 de 3.052 edificios de
  barrio pisaban una vía del mapa (60 con el centro en la calzada; 35 en la
  E11) y el viaducto atravesaba 12 (16 muestras). Después: 128 rechazos, 3.048
  edificios (4 menos: un barrio que agota sus `count·4` intentos se queda
  corto), **0 sobre una vía** y
  **0 choques del viaducto**. Cambia el plano de la ciudad para todos (es
  determinista: todas las máquinas ven el mismo), pero en los ocho encuadres
  fijos la diferencia es de −492 a +24 triángulos (tabla de abajo). Los coches
  de esas vías tampoco atraviesan ya esos edificios.
- **Choques tras cada `ciudad`**: `recuentaChoques` vuelve a contar los
  sólidos que corta el viaducto en `listo` y tras cada `applyCity` (gancho
  `ciudad`): una parcela comprada puede levantar su edificio bajo el viaducto
  después de construirlo. Es un aviso en `stats().ext.extras.metro.choques`;
  los pilares no se rehacen.
- **Genotipo**: el trazado del metro sale de `meta.roads` (dato del mapa); el
  horario, del trazado y del reloj; los barcos, de las rutas fijas de
  `RUTAS` y del reloj; el calendario, de `semillaMorfologia`; el ruido del
  sonido, de `lcg(20260922)`. No hay `Math.random` en el módulo.
- **Pruebas**: `handle.ext.extras` publica `reloj(ms, congelado)` (desplaza o
  congela el reloj del módulo), `tormenta(true|false|null)`, `calendario(n)`,
  `tormentaDelDia(d)`, `metro()`, `tren(k, t)`, `estacion(i)` (con `torre`:
  sitio, lado, suelo y lo que hay debajo), `barcos(t)`,
  `rutas()`, `foto.{entra, sale, focal, nivel, travelling, guardar, estado}`,
  `sonido()` y `gasto()`.
- **Estilo**: cajas del catálogo (`G.pushParts`, centradas en x y z, base en
  y = 0), coches, barcos y trenes con +X hacia delante y `yaw = atan2(−tz, tx)`
  como los coches del núcleo; `setColorAt` en blanco para compartir el programa
  de la malla del tráfico.

## Cifras medidas (panel real, Chromium por software, 1280 × 800, visor 644 × 560)

**Lo que hay** (ronda 1):

| | |
|---|---|
| Plano de los barrios | 3.048 edificios (antes 3.052), 128 rechazos por vía del mapa, 0 sobre una vía (antes 100, 60 con el centro en la calzada) |
| Metro | 50,6 km, 1.688 muestras, 1.688 pilares (antes 1.666: 22 se saltaban por tener un sólido debajo), 0 choques (antes 16 muestras en 12 edificios), 35 estaciones (2 movidas, 0 sin acceso, 0 sobre el agua), 87.160 triángulos en 10 teselas (+948 de las pasarelas), 23 trenes, intervalo 365 s, ciclo 8.396 s, 60 triángulos por coche |
| Barcos | 7 rutas, 0 descartadas, 22 barcos, 9.759 muestras comprobadas al cargar, 0 en tierra |
| Barcos en el tiempo | 400 instantes en 3 h × 22 barcos = 8.800 posiciones: 0 sobre tierra, la más alta a −0,8 m (primera ronda; las rutas no han cambiado) |
| Trenes en el tiempo | 200 instantes × 23 trenes = 4.600 posiciones: 0 fuera de la línea (primera ronda; el eje no ha cambiado) |
| Calendario | 214 días de tormenta en 3.650 (1 de cada 17,1); 30 en los próximos 365; inicio a las 14 h (14), 15 h (9), 16 h (7) |
| Calidad baja | 0 coches de tren y 0 barcos dibujados |

**A/B sin tormenta** (`ab.mjs`, los ocho encuadres fijos, binario base con los
ficheros de la rama → `/tmp/ramiverif/extras_r1_ab.json`; «módulo» son los
triángulos que el propio módulo anota en `stats().ext.extras.triangulos` en el
mismo cuadro, de la pasada «sin» de `extras_r1_tormenta_ab.json`, y
«plano» es lo que queda: el efecto de sacar los edificios de las vías. Los
trenes y los barcos se mueven con el reloj, así que la cifra del módulo depende
del instante):

| Encuadre | v0.10.16 | esta rama | Δ | módulo | plano | Llamadas |
|---|---|---|---|---|---|---|
| Torres de cerca | 920.678 | 936.926 | +16.248 (+1,8 %) | 16.620 | −288 | 21 → 23 |
| Manzana de bloques | 790.042 | 790.194 | +152 (+0,0 %) | 128 | +24 | 17 → 18 |
| Villas | 959.508 | 959.540 | +32 (+0,0 %) | 128 | −96 | 15 → 16 |
| Naves | 1.014.414 | 1.047.506 | +33.092 (+3,3 %) | 33.584 | −492 | 21 → 25 |
| A pie en la manzana | 952.544 | 968.464 | +15.920 (+1,7 %) | 15.896 | +24 | 28 → 30 |
| A pie ante una torre | 802.440 | 818.676 | +16.236 (+2,0 %) | 16.368 | −132 | 17 → 18 |
| Ciudad entera | 1.748.908 | 1.835.716 | +86.808 (+5,0 %) | 87.160 | −352 | 86 → 96 |
| Centro | 1.532.854 | 1.574.218 | +41.364 (+2,7 %) | 41.808 | −444 | 42 → 46 |

Los 128 triángulos de «manzana de bloques» y «villas» son un barco (una abra
lejana del Creek). Las llamadas extra son las teselas del viaducto que entran
en el encuadre, más una por malla instanciada con algo que dibujar (trenes,
cada tipo de barco).

**Tormenta** (mismos encuadres, sin → con tormenta a mano;
`/tmp/ramiverif/extras_r1_tormenta_ab.json`):

| Encuadre | Triángulos sin | con | Llamadas sin | con | camera.far con |
|---|---|---|---|---|---|
| Torres de cerca | 937.010 | 440.144 (−53 %) | 23 | 20 | 1.318 m |
| Manzana de bloques | 790.194 | 288.834 (−63 %) | 18 | 16 | 824 m |
| Villas | 959.540 | 455.108 (−53 %) | 16 | 14 | 618 m |
| Naves | 1.047.506 | 526.114 (−50 %) | 24 | 21 | 783 m |
| A pie en la manzana | 968.464 | 288.618 (−70 %) | 30 | 17 | 391 m |
| A pie ante una torre | 818.676 | 307.572 (−62 %) | 18 | 16 | 391 m |
| Ciudad entera | 1.835.716 | 1.740.102 (−5 %) | 96 | 78 | 76.680 m |
| Centro | 1.574.218 | 674.564 (−57 %) | 46 | 22 | 3.035 m |

Sin el recorte del terreno (primera medida, solo con `camera.far`) la tormenta
ahorraba un 0,4–2 % en seis de los ocho encuadres: las teselas de 8 km que
contienen la cámara se envían enteras y el terreno es una malla única. Lo que
compra la tormenta es el terreno (−500.000 triángulos) y las llamadas de las
teselas lejanas. En la ciudad entera casi no ahorra: vista desde 74 km, la
niebla termina a 74 km. Los granos de arena son una llamada más (ya contada) y
1.500 puntos.

**Restauración de la tormenta** (tres pasos de simulación con ella y tres sin
ella): dentro, `drawRange` del terreno 138.240 índices, cielo oculto,
`camera.far` 3.035 m, color del sol de (1,36; 1,15; 0,81) a (0,27; 0,23; 0,16) y
el fondo es la niebla; fuera, `drawRange` `Infinity`, cielo visible y el color
del sol exactamente el de antes.

**Sonido**: antes del clic no hay `AudioContext` (`sonido().estado === null`);
tras el clic de ratón en 🔊, `running`, 22 nodos en el grafo, preferencia
`'1'` guardada, `play('timbre'|'puerta'|'clic'|'paso')` → `true` sin lanzar,
`play('no-existe')` → `false`; 12 m a pie en 20 pasos de simulación de 0,1 s
dan 10 pasos. Con la preferencia `'1'` y la página recargada sin ningún gesto
(ronda 1, `sonido.mjs`, navegación con clics sintéticos): antes del gesto
`null` y 🔇; el primer gesto es el clic de ratón en 🔇 → `running`, 🔊 y
preferencia `'1'` (antes quedaba apagado y `'0'`); el segundo clic apaga
(`suspended`, `'0'`); y con el primer gesto en el lienzo, enciende. **No se ha
oído**: el entorno no tiene salida de audio; lo comprobado es que el grafo
existe y funciona sin errores.

**Modo foto** (ronda 1, `verifica.mjs` y `foto.mjs`): clic de ratón en 📷
(el foco queda en `BODY`) y `keyboard.press('Escape')` → sale (antes seguía
dentro). Desde la órbita, 🕊 con el ratón, 85 mm, nivel y travelling: dentro,
a pie a 40 m, fov 16,1°, con desplazamiento de ventana; la descarga llega por
`page.waitForEvent('download')` como `dubai-rami-20260923-124109.png`
(136.607 B, mirado: el cuadro nivelado con el pie); al salir con ✕ o con
Escape, **órbita, `fly` 0, fov 50°, sin ventana desplazada, `theta` 0,7,
radio 500 y el mismo objetivo** que antes de entrar (antes quedaba a pie a
40 m). Desde a pie, con 🕊 y travelling 2 s: dentro vuela a 40 m y se ha
desplazado 2,4 m; fuera, la misma posición, `yaw` y `fly` 0.

**Tormenta del calendario y el botón** (reloj congelado el 25-09-2026 a las
17:00 de Dubái): intensidad 1; primer clic en 🌪 → 0, título «la del
calendario, quitada en este equipo hasta 18:00»; segundo clic → 1, botón
marcado, título «la del calendario, hasta 18:00 · pulsa para quitarla».

## Capturas (en /tmp/ramiverif, miradas)

- Ronda 1: `extras_r1_estacion_torre.png` (estación de Business Bay con la
  torre de acceso fuera de la calzada y su pasarela), `extras_r1_estacion_a_pie.png`
  (a pie en la acera junto a la torre: pasarela, andén y pilares sobre la
  E11), `extras_r1_viaducto_business_bay.png` (el viaducto entre las torres de
  Business Bay sin cortar ninguna), `extras_r1_tormenta_granos.png` (tormenta
  del calendario a pie: los granos se ven), `extras_r1_foto_modo_pantalla.png`
  (sin interfaz, 85 mm, cámara libre), `extras_r1_foto_descargada.png` (el PNG
  descargado), `extras_r1_foto_tras_salir.png` (vuelta a la órbita de antes).
- Primera ronda: metro `extras_metro_tren_marcha.png`,
  `extras_metro_estacion_tren.png`, `extras_metro_cenital.png`,
  `extras_metro_viaducto.png`, `extras_metro_a_pie.png`,
  `extras_metro_a_pie_tren.png`, `extras_metro_orbita_lejos.png`; barcos
  `extras_barcos_creek_abra.png`, `extras_barcos_creek_dhow.png`,
  `extras_barcos_marina_yate.png`, `extras_barcos_costa_dhow.png`; tormenta
  `extras_tormenta_a_pie_manzana_sin.png` / `_con.png`; foto
  `extras_foto_modo_pantalla.png`, `extras_foto_descargada.png`.
- A/B: `extras_r1_*.png` de `ab.mjs`, `/tmp/ramiverif/extras_r1_ab.json` y
  `/tmp/ramiverif/extras_r1_tormenta_ab.json`. Scripts de la ronda 1 en
  `/tmp/ramiwt/extras/r1/` (`verifica.mjs`, `sonido.mjs`, `foto.mjs`,
  `tormenta_ab.mjs`, `mide_vias.mjs`) con sus `.log`.

## Lo que queda

1. **El Creek no llega al mar en el agua visible**: la malla fina de 138 m
   cierra la boca norte, igual que el codo del canal de la Marina. Por eso los
   dhows del Creek no salen al mar y los yates de la Marina solo recorren el
   tramo sur (2,5 km). Si se afina la malla o el estampado del canal, las rutas
   se alargan sin tocar nada más.
2. **Coches que adelantan por dentro y pilares**: el núcleo deja que un coche
   se desvíe hasta 1,2 m del eje de la vía (`desvMin`) para adelantar, y el
   pilar mide 1,8 m de ancho sobre el eje: en ese desvío el coche lo roza. Los
   carriles los rehace el frente «vida» en el núcleo; al integrar, `desvMin`
   de las vías con metro tiene que dejar 0,9 m más la media anchura del coche.
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
8. **La barra del visor del panel** (Centro, A pie, calidad, hora…) está fuera
   de `#city3d`, encima del lienzo, y el modo foto no la oculta: el módulo no
   toca el DOM del panel fuera de su contenedor (`dashboard.html` es de otros).
   No tapa el encuadre y el PNG sale limpio.
9. **Una parcela bajo el viaducto**: si una parcela comprada levanta su
   edificio bajo el viaducto, `recuentaChoques` lo cuenta, pero ni el
   viaducto ni sus pilares se rehacen.
10. **Los hitos no se mueven**: el filtro nuevo es del plano de los barrios; un
    hito del catálogo cerca de una vía (la primera ronda midió `difc_gate` a
    menos de medio ancho de la E11) sigue donde está. El viaducto no corta
    ninguno (0 choques).
