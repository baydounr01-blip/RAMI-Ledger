# Espejismo — entrega 7 del plan (acabado de imagen) y el experimento de la profundidad

Rama `feat/espejismo`, desde `44754ec`. Sin cambios de consenso, de red, de nodo
ni de formato: todo en el cliente 3D (`city3d.js`, `city/espejismo.js`) y una
línea del panel.

## Qué se hizo

1. **Interiores por paralaje** en el sombreador de edificios (`BUILD_FS`,
   función `interiorSala`): detrás de cada hueco de vidrio de la retícula, el
   muro cortina y la cinta hay una habitación que no existe como geometría.
   Desde la calidad media. De noche, las salas encendidas se ven por dentro con
   su color; de día manda el reflejo del cielo y la sala se intuye.
2. **Posproceso** en el módulo `city/espejismo.js` (gancho `pintar`): la escena a
   un destino intermedio con multimuestreo y textura de profundidad, oclusión
   ambiental de pantalla (SSAO), resplandor corto y curva de color de cine. Con
   los tres efectos a cero la imagen es **idéntica byte a byte** a la directa.
3. **Cascadas de sombra** en alta y ultra: el sol y dos luces direccionales de
   intensidad cero que solo proyectan sombra, con cajas de 150 m, 800 m y 3,5 km.
4. **La tabla `QUALITY`** dice qué efectos lleva cada nivel; `stats()` y
   `bench()` anotan los activos, y la línea del botón de fluidez del panel los
   muestra.
5. **El experimento de la profundidad**: `localStorage['rami.profundidad'] =
   'lineal'` monta el visor sin `logarithmicDepthBuffer`, con planos cercano y
   lejano por cuadro. El valor por defecto sigue siendo el logarítmico.

## Cómo está hecho, para quien lo toque después

### Interiores por paralaje (`city3d.js`, `BUILD_VS`/`BUILD_FS`)

- **El marco de la sala.** La sala mide 4,5 m a lo largo de la fachada, 3,6 m de
  planta a planta y 5,6 m de fondo (1,24 veces el ancho): es la celda del sorteo
  de luces encendidas (`cell`, siempre 4,5 × 3,6 aunque el muro cortina tenga
  paños de 1,5 m), así que la sala que se ve encendida es la del sorteo de
  siempre. `interiorSala(q, v, nh, hb, hs, lamp)` recibe la coordenada de
  fachada en celdas (`uvw / (4.5, 3.6)`), la dirección a la cámara y la normal
  horizontal; lleva el rayo al marco (tangente `T = (nh.z, 0, −nh.x)`, que es el
  mismo eje que `uvw.x`; vertical; fondo), lo corta con la caja por el método de
  las tres losas (el primer plano que toca: paredes, suelo o techo, o el fondo) y
  pinta cada cara. Un mueble (un plano a media profundidad, de pie en el suelo) y,
  en una de cada tres salas, una persiana bajada.
- **Los dos sorteos.** `hb`, por edificio (oficina fría o vivienda cálida), y
  `hs`, por sala (de `cell` y del edificio). El edificio se reconoce por su id,
  que viaja en `aflags`: `flagsEdificio(fachada, x, z)` escribe `fachada + 4·(1 +
  id)`, con `id = semillaMorfologia(round(x), round(z), 21) & 1023` —un entero
  de la posición del edificio, el mismo en toda máquina—, y el sombreador lee
  `tipo = mod(aflags, 4)` e `idE = floor(aflags / 4)`. Lo escriben los barrios
  (`buildClusters`), las parcelas (`applyCity`, una línea) y los hitos
  (`buildLandmarks`, que antes no llevaban el atributo y ahora llevan uno con la
  retícula de siempre). Lo que llega sin id (mallas de módulos) sortea como en
  la primera vuelta, por tesela de 500 m y cota del pie. Antes todo sorteaba
  así, y una fachada que cruzaba x o z = 500·k cambiaba de paleta a media
  anchura (revisión 1). Guardar el id en `aflags` no cuesta memoria; un atributo
  aparte serían 4 bytes por vértice en unos cuatro millones de vértices. Los
  colores que salen del sorteo (`hash21` en el sombreador) son fenotipo, como el
  sorteo de luces encendidas que ya existía.
- **`vBase`** es la cota del pie del edificio: `abase` en las mallas por tesela,
  `instanceMatrix[3].y` en las instanciadas (que no llevan el atributo y leían 0).
- **Solo en vidrio.** Todo va dentro de `if (uInterior > 0.5 && glass > 0.01)`:
  la fachada lisa y `uWindows = 0` tienen `glass = 0` y no entran. De día la sala
  recibe luz de cielo (`amb`) atenuada con el fondo y teñida por el vidrio, y
  encima va el reflejo con su Fresnel de siempre; de noche, la luz cálida de
  siempre se multiplica por el color de la sala y por `lamp` (cuánto alumbra la
  lámpara esa cara), así que cada ventana encendida enseña su techo, sus paredes
  y su mueble.
- **`uInterior`** es un uniforme compartido (`shared.uInterior`), 1 desde media;
  cambiarlo no recompila nada.

### Posproceso (`city/espejismo.js`, gancho `pintar`)

- **El destino.** `asegura()` crea, al tamaño del búfer de dibujo, un
  `WebGLRenderTarget` con `samples = 4` (WebGL2), `DepthTexture` de 24 bits,
  textura en `sRGBEncoding`, `internalFormat: 'RGBA8'` e `isXRRenderTarget =
  true`. **Por qué así**: three r150 compila los materiales, para un destino que
  no es el lienzo, con salida lineal; los del visor mezclan la niebla después del
  tono y de la codificación, con un color de niebla ya pasado por esa curva
  (`updateSun`, `acesSRGB`). Con el destino marcado como de XR three toma la
  codificación de su textura, así que cada material compila **el mismo programa**
  que para el lienzo (ni siquiera se recompila nada al activar o quitar el
  posproceso), y con `RGBA8` el hardware no vuelve a codificar al escribir: el
  destino guarda los bytes que habría recibido el lienzo. Queda una diferencia:
  three pasa el color de la niebla y el de fondo de lineal a sRGB al subirlos
  solo cuando dibuja al lienzo; `pintar()` aplica esa misma conversión
  (`convertLinearToSRGB`) a `scene.fog.color` y `scene.background` mientras
  dibuja la escena y los devuelve después. Resultado: el pase neutro es idéntico
  byte a byte al directo (tabla de abajo).
- **La profundidad.** `distVista(d)` invierte la del búfer: con el logarítmico de
  three r150, `gl_FragDepth = log2(1 + w) / log2(lejano + 1)` (w, la distancia a
  lo largo de la vista), así que `w = 2^(d · log2(lejano + 1)) − 1`; con el lineal,
  `w = cerca · lejos / (lejos − d · (lejos − cerca))`, con los planos del cuadro.
  El módulo pregunta el modo con `ctx.profundidad()`.
- **SSAO** (`AO_FS`): a media resolución (entera en ultra), 12 muestras en alta y
  16 en ultra de un núcleo fijo (espiral de ángulo áureo subida a la semiesfera;
  nada de `Math.random`, el mismo en todas las máquinas y en cada cuadro), girado
  por píxel con ruido de gradiente entrelazado. Posición de vista reconstruida con
  la profundidad y la proyección; la normal, de la profundidad, con el vecino más
  parecido en cada eje para no torcerla en los bordes. Radio de 1,5 m en la acera a
  30 m como mucho (`1,5 + 0,015 · z`); margen contra la autooclusión que crece con
  la distancia. Desenfoque bilateral en dos pasadas de 7 lecturas que no cruza
  saltos de profundidad. La oclusión se apaga con la niebla (ya mezclada en el
  color) y en el cielo.
- **La raya del suelo.** La primera versión dejaba una raya de lado a lado sobre
  el suelo liso, siempre en las mismas filas de pantalla (en dos sitios distintos
  y en los dos modos de profundidad), un 25 % más oscura. Causa: el centro de un
  píxel de media resolución cae en la arista entre dos texels de la profundidad
  entera, y la lectura sin filtro redondea a uno u otro según la fila; donde el
  píxel y su vecino caían en el mismo texel, la normal salía nula. Se lee siempre
  en el centro de un texel (`uv0`). Con la oclusión a resolución entera la raya
  no aparecía: así se localizó.
- **Resplandor**: umbral suave en lineal de pantalla (el máximo de los tres
  canales, tras el tono) sobre 4 lecturas bilineales a media resolución, sin el
  cielo (se reconoce porque no escribe profundidad: con la calima de Dubái es
  casi blanco y velaría el cuadro), y 3 (media) o 4 (alta, ultra) niveles de
  reducción y ampliación con el filtro dual (5 y 8 lecturas por píxel), sumando
  cada nivel sobre el anterior. **El umbral va de día a noche con `uNight`**:
  0,92 con rodilla 0,05 de día (empieza en 0,87) y 0,64 con rodilla 0,12 de noche
  (empieza en 0,52). La primera vuelta usaba 0,70 con rodilla 0,2 (empezaba en
  0,50) a todas horas, y de día la arena al sol velaba el desierto entero
  (revisión 1). Cifras de dónde sale (`umbral.mjs`: máximo de canal en lineal de
  lo que no es cielo, alta):

  | Encuadre | > 0,70 | > 0,80 | > 0,85 | > 0,90 |
  |---|---|---|---|---|
  | ciudad entera, 11 h | 52,2 % | 38,5 % | 9,5 % | 0,18 % |
  | muro cortina, 11 h | 6,84 % | 0,33 % | 0,03 % | 0,01 % |
  | calle, 11 h | 1,71 % | 0,00 % | 0,00 % | 0,00 % |
  | calle, 22 h | 9,01 % | 4,40 % | 2,23 % | 0,00 % |
  | muro cortina, 22 h | 2,24 % | 0,17 % | 0,01 % | 0,01 % |

  De día lo que pasa de 0,87 son los reflejos del sol en el vidrio; la arena y
  la calima se quedan entre 0,70 y 0,85. De noche las ventanas encendidas y las
  farolas están entre 0,52 y 0,85 y nada pasa de 0,90: un umbral fijo que sirva
  de día las apagaría.
- **Curva de color** en el pase final, en sRGB: una S de contraste al 22 %, un
  10 % más de saturación, sombras hacia el azul y luces hacia el ámbar (±1,6 %
  como mucho) y un tramado de medio escalón contra las bandas del cielo. Con los
  tres efectos a 0 el pase final es la identidad (sRGB → lineal → sRGB, sin
  pérdida en 8 bits: medido).
- **La cuenta.** `renderer.info` se reinicia en cada `render()`: la escena se
  dibuja con `autoReset` como esté (los triángulos y llamadas de la escena son
  los de siempre) y las pasadas propias con `autoReset = false`, que se suman
  encima; `estadisticas` publica las del módulo en `stats().ext.espejismo`.
- **Tamaño y calidad**: los ganchos `tamano` y `calidad` sueltan los destinos y
  `asegura()` los rehace en el siguiente `pintar`; también los rehace si el búfer
  de dibujo cambió sin pasar por `resize` (la salida de las gafas).
- **VR**: `activo()` es falso con `S.xr`; `xrFrame` dibuja directo, como antes.
  Sin WebGL2 tampoco hay posproceso (no hay multimuestreo en el destino).
- **El multimuestreo del lienzo se queda** (`antialias: true` al crear el
  contexto), aunque con posproceso no sirva: la escena va al destino con MSAA 4
  y al lienzo solo llega el triángulo del pase final. Tres motivos, por orden:
  en three r150 la capa de las gafas (`XRWebGLLayer`) toma el `antialias` de los
  atributos de ESTE contexto (`getContextAttributes()` en `WebXRManager`), y en VR
  se dibuja directo: apagarlo deja la VR sin antialiasing; la calidad baja no
  lleva posproceso y la calidad cambia en caliente, pero los atributos del
  contexto se fijan al crearlo; y si el módulo falla, el núcleo dibuja al lienzo.
  Lo que cuesta, calculado (en SwiftShader no hay memoria de vídeo que medir):
  las cuatro muestras de color RGBA8 y de profundidad de 24 bits del lienzo son
  32 bytes por píxel del búfer de dibujo, sin uso mientras hay posproceso.

  | Búfer de dibujo | MSAA del lienzo (sin uso con posproceso) | Destino del posproceso (MSAA 4 + texturas resueltas, 40 B/px) |
  |---|---|---|
  | 644 × 560 (las pruebas) | 11,5 MB | 14,4 MB |
  | 1.920 × 1.080 | 66 MB | 83 MB |
  | 2.560 × 1.440 | 118 MB | 147 MB |
  | 3.840 × 2.160 | 265 MB | 332 MB |

  Los destinos de la oclusión y del resplandor suman 2 y 1,3 bytes por píxel
  (media resolución y niveles). Separar el antialiasing de las gafas del del
  lienzo pide crear la capa XR a mano en lugar de la de three: queda anotado.
- **Para las pruebas**: `handle.ext.espejismo.ajusta({ ao, resplandor, curva,
  verAO, activo })` multiplica las intensidades (sin argumento, todo de vuelta),
  `pinta()` dibuja un cuadro por el camino del posproceso sin avanzar la
  simulación y `estado()` dice qué hay.

### Cascadas de sombra (`city3d.js`: `montaCascadas`, `cajaSombra`, `updateShadowFrame`)

- `montaCascadas()` pone, en alta y ultra (`Q.cascadas`, el lado de cada mapa),
  dos `DirectionalLight` de intensidad cero con `castShadow` (nombres
  `cascada1` y `cascada2`) además del sol; en baja y media las quita y el sol
  vuelve a su caja única de siempre. Se llama al montar y en `setQuality`, nunca
  por cuadro: el número de luces con sombra entra en la clave del programa de
  cada material (`NUM_DIR_LIGHT_SHADOWS`) y cambiarlo recompila todos.
- `getShadowMask()` de three multiplica todas las luces con sombra: los cuatro
  materiales propios (edificios, calzada, terreno, mar) la usan y leen las tres
  sin tocar su código. Como cada mapa devuelve 1 fuera de su caja, la cercana
  solo cuenta donde llega; la lejana sigue dando la sombra de las torres a
  kilómetros.
- **Los materiales de three no.** En r150, `lights_fragment_begin` aplica a cada
  luz direccional solo SU mapa, y las cascadas no tienen color: un
  `MeshLambertMaterial` (plantas, cajas, lecho marino) solo veía el mapa del sol,
  que en alta es la caja cercana (150 m a pie, `0,5R` en órbita), cuando en media
  tenía 350 m (la primera vuelta de estas notas decía lo contrario; revisión 1).
  `sombraEnCascadas(material)` cambia, en `onBeforeCompile`, esa línea por
  `getShadowMask()` (añadiendo `shadowmask_pars_fragment`): con una sola luz con
  sombra el resultado es el de siempre, y con tres el sol recibe el producto. Si
  una versión de three cambia la línea, el material se queda como estaba. Lo
  llevan plantas, cajas y lecho marino, y está en `ctx.util` para los módulos.
  Medido (`lambert.mjs`: el terreno cambiado por un Lambert, volando a 150 m y
  mirando abajo, el mismo cuadro sin y con `sombraEnCascadas`): en alta, 5.652
  píxeles más oscuros (hasta 95 niveles), que son las sombras de las torres
  entre 150 y 800 m que sin él faltaban; en media, diferencia 0 (una sola luz
  con sombra: el mismo resultado). Los dos programas llevan la máscara
  (`programasConMascara: 2`).
- `cajaSombra(luz, cx, cy, cz, r, dist)`: caja de lado 2r centrada en el punto,
  con el centro llevado a la rejilla de texels en el plano de la luz (sin eso,
  cada paso desplaza la rejilla una fracción de texel y los bordes tiemblan), la
  luz retirada `max(3r, 2000)` m hacia el sol (tiene que alcanzar la coronación
  de la torre más alta que haga sombra dentro) y el sesgo proporcional al texel
  de SU cascada. Radios: a pie 150 / 800 / 3.500 m, con la caja adelantada media
  caja en la dirección de la mirada; en órbita, proporcionales a la distancia
  (`0,5R` entre 150 y 1.750 m, `1,3R` entre 800 y 3.500, `3R` entre 3.500 y
  7.000). En VR, alrededor del jugador.

### Calidad (`QUALITY`)

| Nivel | Interiores | Posproceso | Cascadas |
|---|---|---|---|
| baja | no | no | no (sin sombras, como antes) |
| media | sí | curva de color y resplandor (3 niveles), MSAA 4 | no (una luz, caja de 350 m a pie) |
| alta | sí | + SSAO de 12 muestras a media resolución, resplandor de 4 niveles | 2.048 / 2.048 / 1.024 |
| ultra | sí | SSAO de 16 muestras a resolución entera | 4.096 / 2.048 / 2.048 |

Los interiores entran desde media porque son un cambio de sombreador sin
geometría ni pasadas (medido abajo: no se distinguen del ruido de la medida). La
media es la calidad por defecto del panel.

`efectosActivos()` junta los del núcleo (interiores, cascadas, profundidad
lineal) con los que cada módulo pone en `o.<nombre>.efectos` desde su
`estadisticas`; salen en `stats().efectos` y en `bench().efectos`, y el panel
los escribe traducidos en la línea del botón de fluidez («efectos: …»).

### Profundidad lineal (`city3d.js`: al crear el renderer, `planosProfundidad`)

- Se lee al montar: `opts.profundidad` o `localStorage['rami.profundidad'] ===
  'lineal'`; cambiarlo pide volver a abrir el visor (el búfer logarítmico es un
  parámetro del `WebGLRenderer`). `ctx.profundidad()` lo dice a los módulos y
  `stats().profundidad` a las pruebas.
- `planosProfundidad()`, cada cuadro después de colocar la cámara: con 24 bits
  el error a la distancia z es de unos z² / (cercano · 2²⁴) m, así que manda el
  plano cercano; pero lo que quede más cerca que él no se dibuja, así que no
  puede pasar de lo que la cámara tiene al lado. La primera vuelta lo sacaba de
  la altura sobre el TERRENO, y volando con E pegado a una fachada (o en la
  planta de una torre, que es como `umbral` lleva al jugador) recortaba la
  torre entera: a 120 m de altura y 7,5 m de Princess Tower, cercano 36,5 m y la
  torre desaparecía (revisión 1). Ahora:
  - A pie sin volar (`walk.fly < 2`, que es también como un módulo lleva al
    jugador por dentro de un edificio): 0,5 m fijos (la calle a 1 km con 12 cm
    de error; el logarítmico usa 0,3 m).
  - Volando y en órbita: la mitad de la **holgura** (`holguraCamara(p, 1000)`),
    entre 0,5 y 500 m, en escalones de 2^¼ hacia abajo por debajo del tope (el
    plano no cambia a cada paso). La holgura es la distancia a lo más cercano
    que el visor sabe dónde está: el terreno bajo la cámara menos 30 m (palmeras,
    farolas, coches, gente, marquesinas), la caja de cada sólido del catastro con
    15 m de más por arriba (rótulos y remates) en las celdas que alcanza, y los
    avatares (3 m). Recorre como mucho 81 celdas de 256 m, sin reservar memoria.
  - El lejano llega a donde la niebla ya lo tapó todo (`distancia al centro +
    1,7 L`, entre 4 y 900 km). En VR no se toca (`enterVR` pone 0,3 m y 40 km con
    el lineal; sin probar en unas gafas).
  - Lo que un módulo dibuje en alto fuera de cualquier huella del catastro (un
    avión, un dron) no entra en la holgura: con el lineal, si queda más cerca
    de la cámara que el plano cercano de ese cuadro (hasta 500 m), se recorta.
    Está escrito en `docs/EXTENSIONES-3D.md`.
- **El valor por defecto sigue siendo el logarítmico** hasta que alguien mida los
  dos en una tarjeta gráfica real con el botón de fluidez: la razón para quitarlo
  (que todos los sombreadores escriban `gl_FragDepth` anula el descarte temprano
  de fragmentos) es un efecto de la tarjeta que SwiftShader no reproduce.

## Cifras medidas

Todo en Chromium sin pantalla con SwiftShader (rasterizado por software), lienzo
de 644 × 560, el panel real con los cinco módulos cargados y la cadena de la
testnet. Los triángulos y las llamadas son exactos; los milisegundos, una
indicación relativa (ver el último apartado).

### Triángulos y llamadas en los encuadres fijos (`ab.mjs`)

Calidad media (la de por defecto), frente a la referencia de la v0.10.16:

| Encuadre | v0.10.16 | Esta rama | Diferencia |
|---|---|---|---|
| torres de cerca | 920.678 · 21 | 920.684 · 27 | +6 · +6 |
| manzana de bloques | 790.042 · 17 | 790.048 · 23 | +6 · +6 |
| villas | 959.508 · 15 | 959.514 · 21 | +6 · +6 |
| naves | 1.014.414 · 21 | 1.014.420 · 27 | +6 · +6 |
| a pie en la manzana | 952.544 · 28 | 952.550 · 34 | +6 · +6 |
| a pie ante una torre | 802.440 · 17 | 802.446 · 23 | +6 · +6 |
| la ciudad entera | 1.748.908 · 86 | 1.748.914 · 92 | +6 · +6 |
| el centro | 1.532.854 · 42 | 1.532.860 · 48 | +6 · +6 |

Calidad alta, binario base con el JavaScript de la v0.10.16 frente a esta rama:
los ocho encuadres, +11 triángulos y +11 llamadas cada uno (p. ej. el centro
1.643.558 · 45 → 1.643.569 · 56; la ciudad entera 1.875.212 · 90 →
1.875.223 · 101). **La escena no cambia**: lo que se suma son las pasadas del
posproceso, un triángulo cada una.

| Pasadas del posproceso | media | alta / ultra |
|---|---|---|
| final (curva, composición) | 1 | 1 |
| resplandor: umbral + reducción + ampliación | 1 + 2 + 2 = 5 | 1 + 3 + 3 = 7 |
| SSAO + desenfoque en dos pasadas | — | 3 |
| **total** | **6** | **11** |

### La pasada de sombra (contada envolviendo `shadowMap.render`)

| Encuadre, calidad alta | Una luz (v0.10.16) | Tres cascadas |
|---|---|---|
| a pie en una calle con torres | 5 llamadas · 113.966 triángulos | 20 · 432.778 (×3,8) |
| el centro | 8 · 236.710 | 32 · 794.206 (×3,4) |

Es el coste grande de esta entrega, y solo en alta y ultra.

### Recompilar al cambiar el número de luces con sombra

Quitar las dos cascadas de la escena con los materiales marcados
(`recompila.mjs`, a pie, alta): 20 → 31 programas, el cuadro que compila tarda
2.381 ms frente a 1.918 ms el siguiente (unos 460 ms de compilar 11 programas en
SwiftShader); volver a ponerlas no compila nada (los programas quedan en la
caché de three: 33, y 2.292 ms frente a 2.303). Pasar de media a alta con el
selector: 27 → 35 programas. En una tarjeta real compilar cuesta de otra manera
(el controlador, no el rasterizador): por eso el número de luces se fija al
montar y al cambiar de calidad, nunca por cuadro.

### El pase neutro: posproceso con los tres efectos a cero frente al directo

El mismo cuadro congelado, dibujado directo al lienzo y por el posproceso con
`ajusta({ ao: 0, resplandor: 0, curva: 0 })`; se leen los dos con `readPixels`
y se comparan los 360.640 píxeles.

| Encuadre | Hora | Calidad · profundidad | Diferencia máxima |
|---|---|---|---|
| a pie ante una torre, en la calle | 11 | alta · log | **0** |
| órbita cercana a torres de muro cortina | 11 | alta · log | **0** |
| la ciudad entera | 11 | alta · log | **0** |
| a pie ante una torre | 22 | alta · log | **0** |
| muro cortina | 22 | alta · log | **0** |
| la ciudad entera | 22 | alta · log | **0** |
| a pie ante una torre, entre torres, el centro, la ciudad entera | 11 | alta · lineal | **0** (los cuatro) |
| a pie ante una torre, muro cortina | 11 | media · log | **0** (los dos) |

Idéntico byte a byte en los 12 encuadres. (Antes de convertir el color de la
niebla y del fondo como lo hace three en el lienzo, la diferencia llegaba a 12
niveles en la calima del horizonte del centro.) Repetido tras la revisión 1,
con el código final (`final.mjs`, `espejismo_r1_*`): los mismos 12 encuadres
(alta · log a las 11 h y a las 22 h: calle, muro cortina y ciudad entera; alta ·
lineal a las 11 h: calle, entre torres, centro y ciudad entera; media · log a las
11 h: calle y muro cortina), diferencia máxima **0** en los 12.

### Lo que cambia cada efecto (mismo cuadro, frente al directo)

Diferencia por píxel en niveles de 0 a 255 (máxima · media · píxeles con más de
8), calidad alta.

Con el código final (revisión 1: umbral del resplandor de día y de noche,
sorteo de salas por edificio):

| Encuadre | Interiores | SSAO | Resplandor | Curva | Todo |
|---|---|---|---|---|---|
| calle, 11 h | 37 · 5,93 · 103.212 | 21 · 1,19 · 16.225 | 0 | 8 · 4,08 · 0 | 17 · 4,29 · 13.030 |
| muro cortina, 11 h | 40 · 11,3 · 145.585 | 34 · 0,90 · 13.405 | 0 | 16 · 4,23 · 98 | 34 · 4,32 · 9.777 |
| ciudad entera, 11 h | 22 · 0,006 · 60 | 0 | 0 | 16 · 8,07 · 92.455 | 16 · 8,07 · 92.455 |
| calle, 22 h | 66 · 4,77 · 42.941 | 21 · 0,43 · 2.984 | 56 · 3,57 · 53.181 | 10 · 5,14 · 21.234 | 50 · 6,11 · 68.743 |
| muro cortina, 22 h | 176 · 14,1 · 68.538 | 45 · 0,34 · 3.157 | 22 · 0,47 · 1.353 | 16 · 5,68 · 29.816 | 38 · 5,61 · 37.059 |
| ciudad entera, 22 h | 78 · 0,011 · 156 | 0 | 9 · 0,004 · 1 | 9 · 5,06 · 2 | 9 · 5,06 · 2 |

En la primera vuelta, con el umbral fijo de 0,70: resplandor de la ciudad
entera a las 11 h, 41 · 5,30 · 103.120 (la arena al sol velaba el desierto) y
«todo» 34 · 11,74 · 262.396; muro cortina a las 11 h, 17 · 0,56 · 730; calle a las
22 h, 38 · 2,75 · 36.986. Ahora de día el resplandor no toca ningún píxel en
estos tres encuadres (solo pasan los reflejos del sol, y aquí no hay ninguno
por encima de 0,87) y de noche es algo más fuerte que antes en las ventanas
(el umbral de noche empieza en 0,52 y la rodilla es más corta). («Interiores»
compara el directo con y sin `uInterior`; los demás, cada efecto solo por el
posproceso.) La oclusión no hace nada en la ciudad entera: con un radio de 30 m
como mucho y la niebla encima, a 30 km no llega a un píxel.

### Profundidad lineal frente a logarítmica (parpadeo de profundidad)

El mismo cuadro dos veces (idénticos: `repetible`) y otra con la cámara 5 cm
hacia delante; se cuentan los píxeles que saltan más de 24 niveles y, de esos,
los que forman manchas (tres vecinos o más también cambiados). Una silueta que
se desplaza deja líneas; el parpadeo de profundidad deja manchas.

Primera vuelta (el cercano del lineal salía de la altura; `parpadeo.mjs`):

| Encuadre (alta, 11 h) | Logarítmica: cercano · saltos · manchas | Lineal: cercano · saltos · manchas |
|---|---|---|
| la ciudad entera | 74 m · 124 · 0 | 500 m · 373 · 4 |
| el centro | 2,6 m · 1.125 · 31 | 87,7 m · 1.084 · 28 |
| a pie, entre torres | 0,3 m · 17.544 · 10.386 | 0,51 m · 17.555 · 10.405 |
| a pie, la calle a lo lejos | 0,3 m · 2.792 · 691 | 0,51 m · 2.769 · 689 |

Tras la revisión 1 (cercano por holgura; `planos.mjs`, alta, 11 h):

| Encuadre | Logarítmica: cercano · saltos · manchas | Lineal: cercano · saltos · manchas |
|---|---|---|
| volando a 120 m, a 7,5 m de la cara este de Princess Tower | 0,3 m · 0 · 0 | 4 m · 0 · 0 (antes: 36,5 m y la torre no se dibujaba) |
| volando a 400 m, la misma fachada | 0,3 m · 0 · 0 | 4 m · 2 · 0 |
| volando a 900 m, mirando abajo | 0,3 m · 654 · 14 | 256 m · 602 · 14 |
| órbita pegada a torres (radio 300 m) | 0,5 m · 824 · 109 | 22,6 m · 719 · 119 |
| a pie, la calle a lo lejos | 0,3 m · 2.793 · 713 | 0,5 m · 2.780 · 697 |
| la ciudad entera | 74 m · 120 · 0 | 500 m · 379 · 4 |

Con el lineal la torre del primer encuadre sale entera y la captura coincide
con la del logarítmico. En la ciudad entera, un primer intento con escalones
de 2^¼ también en el tope dejaba el cercano en 430 m y subía a 631 saltos y 16
manchas; por eso el tope de 500 m se queda sin escalón.

Las mismas cifras en los dos modos (a pie, el paralaje de 5 cm con la fachada a
pocos metros es casi todo el recuento). Ni en las capturas de la ciudad entera,
el centro, entre torres y a pie en la calle se ve parpadeo en la calzada sobre
el terreno ni en las torres sobre la arena. El SSAO funciona igual en los dos
modos (máscaras de abajo).

### Fluidez relativa en SwiftShader (indicación, no cifra de tarjeta)

`costes2.mjs`: en la misma página y el mismo cuadro congelado, seis vueltas
intercaladas de cada variante; la cifra es la mediana, vuelta a vuelta, del
tiempo de cada variante dividido por el de «como antes» (sin interiores y sin
cascadas). El ruido de la máquina compartida, medido con dos variantes que en
media son la misma escena, es de ±10 %.

| Variante | alta, calle | alta, centro | media, calle | media, centro |
|---|---|---|---|---|
| como antes | 1,00 | 1,00 | 1,00 | 1,00 |
| + interiores | 1,02 | 1,00 | 1,17 | 0,92 |
| + cascadas (alta: directo) | 1,75 | 1,62 | — | — |
| posproceso neutro | 1,75 | 1,63 | 1,11 | 0,97 |
| todo | 1,83 | 1,35 | 1,20 | 0,91 |

Lectura: en SwiftShader las cascadas son lo único que se separa del ruido
(+60–75 %, la pasada de sombra con 3,4–3,8 veces los triángulos); interiores y
posproceso quedan dentro del ruido. En una tarjeta de verdad el reparto es otro
(el SSAO y el resplandor son trabajo por píxel que una GPU hace en paralelo; la
pasada de sombra, geometría): el botón de fluidez del panel anota ahora qué
efectos estaban activos para que esa medida se pueda comparar.

### El botón de fluidez del panel (calidad media, por defecto)

`ANGLE (… SwiftShader …) · calidad media · 644×560 · efectos: interiores por
paralaje, curva de color, resplandor · la ciudad entera 0,4 fps · el centro
0,1 fps · un hito de cerca 0,2 fps · a pie en un cruce 0,1 fps` (con sus
triángulos y llamadas), cero errores de consola, los cinco módulos cargados
(`umbral`, `vida`, `espejismo`, `extras`, `memoria`) y ningún gancho fallido.

### Tamaño y calidad sobre la marcha (`tamano.mjs`)

Ventana de 1.280 × 800 a 1.000 × 700: lienzo y destino pasan juntos de
644 × 560 a 364 × 560. Alta → media: 11 → 6 pasadas; → baja: sin destino y 0
pasadas (se dibuja directo); → ultra: destino otra vez y 11 pasadas. Cero
errores, ningún gancho fallido.

## Revisión 1: los hallazgos y qué se hizo

| Hallazgo | Qué se hizo | Cómo se comprobó |
|---|---|---|
| (importante) Profundidad lineal: el cercano salía de la altura sobre el terreno y, volando o en un piso alto, recortaba la torre de al lado | Cercano por holgura (`holguraCamara`: terreno, catastro, avatares); 0,5 m a pie con `walk.fly < 2` | `planos.mjs`: la escena del revisor (120 m, a 7,5 m de Princess Tower) con cercano 4 m y la torre entera, igual que con el logarítmico; tabla de parpadeo de arriba |
| (menor) Las notas decían que los materiales estándar leen las tres cascadas | Era falso: `sombraEnCascadas` para plantas, cajas y lecho marino (y en `ctx.util`); notas y comentario corregidos | `lambert.mjs`: alta 5.652 píxeles de sombra más; media 0 |
| (menor) El umbral del resplandor dejaba pasar la arena al sol | Umbral de día 0,92 / rodilla 0,05 y de noche 0,64 / 0,12, mezclado con `uNight`, con las cifras de `umbral.mjs` | Ciudad entera a las 11 h: resplandor de 41 · 5,30 · 103.120 a 0; a las 22 h sigue en las ventanas |
| (menor) `EXTENSIONES-3D.md` anunciaba «dos cosas», enumeraba tres y omitía la conversión de la niebla y el fondo | La sección tiene ahora cinco puntos, con la conversión (punto 2) y los planos del lineal | Lectura; el pase neutro sigue en 0 |
| (menor) El sorteo de salas «por edificio» cambiaba de paleta en x o z = 500·k | Id del edificio en `aflags` (`flagsEdificio`), leído en `BUILD_FS` | `paleta2.mjs`: `hb` pintado en gris; en la torre que cruza z = 34.500, antes dos valores en la misma cara (134 y 206), ahora uno (180) en las dos caras |
| (menor) `antialias: true` con posproceso: dos búferes multimuestra | **Se queda**, por la VR (la capa `XRWebGLLayer` de r150 hereda el `antialias` del contexto), la calidad baja en caliente y el caso de que el módulo falle; el coste, calculado y escrito en el código y aquí | La tabla del apartado del posproceso |

## Capturas (en `/tmp/ramiverif/`, miradas una a una)

- `espejismo_v2_comp_dia_calle.png`: a pie en una calle ante una torre, 11 h —
  directo | máscara de oclusión | todo. La oclusión bajo la marquesina de la
  entrada y bajo la cornisa del podio, y el bordillo.
- `espejismo_v2_comp_noche_interiores.png`: la misma calle a las 22 h, sin y con
  interiores (con todo el posproceso): cada ventana encendida enseña techo,
  paredes, fondo de color y mueble, y cambian con el punto de vista.
- `espejismo_v2_comp_cortina_noche.png`: órbita cercana a torres de muro cortina,
  22 h, sin y con interiores.
- `espejismo_v2_comp_base_vs_alta_dia.png`: la calle a las 11 h en la v0.10.16
  (una luz de sombra) y en esta rama en alta (cascadas, interiores, posproceso):
  la sombra de la marquesina sale recortada y la cornisa del podio proyecta su
  sombra sobre la fachada.
- `espejismo_casc_11_{todas,solo_cercana,solo_media,solo_lejana}.png`: cada
  cascada por separado en el mismo cuadro.
- Por encuadre y modo, `espejismo_v2_<calidad>_<log|lineal>_<hora>_<encuadre>_<modo>.png`
  con encuadre `a_pie_torre`, `cortina`, `ciudad_entera`, `entre_torres`,
  `centro` y modo `directo`, `sin_interiores`, `neutro`, `mascara`, `ao`,
  `resplandor`, `curva`, `todo`; y las cifras en
  `espejismo_v2_<calidad>_<prof>_<hora>_campana.json`.
- Profundidad: `espejismo_v2_alta_lineal_11_*` (las máscaras de oclusión en
  lineal: `…a_pie_torre_mascara.png`, `…centro_mascara.png`),
  `espejismo_parpadeo_{log,lineal}_*.png` y `espejismo_zoom_centro_ria_log_vs_lineal.png`.
- La raya del suelo antes del arreglo: `espejismo_final_alta_log_11_entre_torres_mascara.png`
  (filas 428 y 460); después: `espejismo_v2_alta_lineal_11_entre_torres_mascara.png`.
- Revisión 1:
  - `espejismo_r1_planos_{lineal,log}_vuelo_fachada.png`: volando a 120 m ante
    Princess Tower; con el lineal la fachada (con sus salas) sale igual que con
    el logarítmico. `…_orbita_pegada.png`, `…_vuelo_alto.png`,
    `…_ciudad_entera.png`, `…_a_pie_calle_lejos.png`: sin parpadeo de
    profundidad a la vista.
  - `espejismo_r1_lambert_alta_{sin,con}.png`: las sombras de las torres
    lejanas sobre un Lambert, que solo salen con `sombraEnCascadas`.
  - `espejismo_r1_hb_{antes,despues}_<i>_<lado>.png` y sus versiones en color
    falso `espejismo_r1_hbcolor_…`: el sorteo por edificio en tres torres que
    cruzan una línea de 500 m.
  - `espejismo_r1_alta_log_11_ciudad_entera_todo.png`: la ciudad entera con
    todo, sin el velo de la arena; `espejismo_r1_alta_log_22_a_pie_torre_todo.png`:
    el resplandor de noche en las ventanas.
  - Por encuadre y modo, `espejismo_r1_<calidad>_<log|lineal>_<hora>_<encuadre>_<modo>.png`
    y `…_campana.json` (la campaña repetida con el código final).

## Lo que queda

- **Ninguna cifra de fluidez de esta entrega está medida en una tarjeta real.**
  Lo que hay que medir allí, con el botón de fluidez: alta con y sin cascadas
  (la pasada de sombra), y los dos modos de profundidad. El lineal no pasa a ser
  el de por defecto hasta entonces.
- **VR**: el posproceso no se dibuja en las gafas (a propósito) y los planos de
  la profundidad lineal en VR (0,3 m y 40 km) no están probados en unas gafas.
- **Cascadas en VR**: se colocan alrededor del jugador; sin probar en unas gafas.
- **Los interiores de día** se leen como vidrio más oscuro con el techo y las
  paredes apenas marcados, que es lo que pedía el plan («se intuye»); de noche
  es donde se ven.
- **Profundidad lineal y geometría de módulos**: la holgura solo conoce el
  terreno, el catastro y los avatares. Lo que un módulo dibuje en alto fuera de
  cualquier huella (un avión, un dron) se recorta con el lineal si queda más
  cerca que el plano cercano (hasta 500 m). El logarítmico, que es el de por
  defecto, no tiene ese límite.
- **El multimuestreo doble** con posproceso (de 11,5 MB en las pruebas a 265 MB
  en 4K, calculado) se queda hasta que la capa de las gafas se cree fuera de
  three; sin medir en una tarjeta.
- **El resplandor de día** no toca ningún píxel en los encuadres de prueba: el
  umbral de día deja pasar solo los reflejos del sol por encima de 0,87, y en
  esos encuadres no hay ninguno. La arena y los brillos del vidrio a contraluz
  están en el mismo intervalo (0,80–0,85): con un umbral por luminancia no se
  separan.
- **Traducciones**: las ocho cadenas nuevas están en
  `chain/crates/rami-gui/i18n-src/frag_espejismo.json`; hasta que se fusionen,
  el panel escribe los nombres de los efectos en español (`check.py` lista
  «efectos» y «ninguno» entre los textos sin traducir).
- **Cambios en el núcleo que el integrador tiene que fusionar**: `BUILD_VS`/
  `BUILD_FS` (`vBase`, `interiorSala`, `uInterior`), `makeBuildingMaterial`
  (`uInterior`), `QUALITY`, la creación del renderer (`profundidad`),
  `montaCascadas`/`cajaSombra`/`updateShadowFrame`, `planosProfundidad` (y su
  llamada en `frame`), `setQuality`, `enterVR` (planos con lineal),
  `efectosActivos`/`benchFin`/`stats()`, y en el contexto `profundidad()`,
  `cascadas()` y `shared.uInterior`. En el panel, la línea del botón de fluidez.
  De la revisión 1: `flagsEdificio` y `sombraEnCascadas` (junto a
  `makeBuildingMaterial`, y en `ctx.util`), `BUILD_FS` (tipo e id desde
  `aflags`), una línea en `buildClusters`, una en `applyCity` (el `aflags` de la
  parcela; zona de «memoria») y el atributo `aflags` de los hitos en
  `buildLandmarks`; `holguraCamara` y `planosProfundidad`; `sombraEnCascadas` en
  los tres `MeshLambertMaterial` (plantas y cajas en `buildCityMeshes`, lecho
  marino); el comentario de `glAttrs`.
