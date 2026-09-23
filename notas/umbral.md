# Umbral — entrega 5: el portal, el zaguán, el ascensor y el apartamento

Todo en `chain/crates/rami-gui/src/city/umbral.js` (módulo del visor) y las
cadenas en `chain/crates/rami-gui/i18n-src/frag_umbral.json`. Del núcleo
(`city3d.js`) solo toca **una línea**: `ctx.geom.colores` publica también
`PUERTA` y `VIDRIERA` (los tonos con los que el catálogo marca esas dos piezas
del portal), documentado en `docs/EXTENSIONES-3D.md`. Ni el panel, ni el nodo,
ni el consenso. Usa los ganchos de la v0.11.0 tal como están (`listo`,
`ciudad`, `calidad`, `andar`, `cuadro`, `tecla`, `clic`, `modo`, `vr`,
`estadisticas`, `soltar`).

## Qué hace

- **Cada edificio tiene portal que se abre**: los 3.052 de barrio y los de las
  parcelas. A pie (`S.mode === 'walk'`, `walk.fly < 2`, fuera de VR), a menos de
  3 m del punto de llegada del portal (1,35 m delante de la puerta) y mirándolo
  (±70°), aparece abajo en el lienzo «F · Entrar» con el nombre (tipo y barrio,
  o empresa y `@handle`; sin nombre, el del sector, traducido). F o un clic en la
  puerta entra.
- **Los patios se andan**: en los 418 edificios de barrio en L o en U la puerta
  está al fondo del patio, que el catastro del núcleo tiene por macizo. El
  módulo lleva al jugador dentro del patio (gancho `andar`, con las alas, la
  fachada del fondo y la caja de la puerta como sólidos) y el aviso sale a 3 m
  de la puerta, no en la boca.
- **La puerta se abre y se cruza andando**, sin fundido: al pulsar F el zaguán
  aparece iluminado detrás de la puerta y de la vidriera del portal (la «vista
  por la puerta»), las dos hojas de vidrio se abren hacia los lados y un
  recorrido guiado de ~1 s lleva al jugador a través del hueco, hasta 1,6 m
  dentro. El interior se construye en ese mismo cuadro (6–17 ms medidos en esta
  ronda). Mientras se cruza, el aviso solo dice el nombre del edificio. Por
  dentro, las hojas se abren solas al acercarse a la puerta.
- **Zaguán** (torres y bloques): suelo de piedra, buzones numerados (uno por
  vivienda: las `unidades` de consenso si la parcela está dividida, si no
  plantas × unidades por planta; hasta 48; textura de lienzo con los números), escalera con
  pasamanos, puerta del ascensor con cerco y botonera, tres plafones encendidos,
  una planta y una alfombra. **Hotel** (sector 5): recepción con mostrador,
  timbre, libro y casillero de llaves, sofá y alfombra roja. **Concesionario**
  (sector 4): sala de exposición de 34 m con un coche sobre peana por cada activo
  coche de la parcela (`S.city.assets`, `kind` 2, en su celda; color con la misma
  cuenta que el núcleo, `hash2(i, 23)`), o 3–6 de muestra si no tiene ninguno; el
  letrero dice «Coches expuestos: n» (sin plural que concordar en ruso).
  **Villa**: la casa en planta baja, la puerta de la calle da al salón, sin
  ascensor. **Nave** (naves de barrio; industria, solar, desalinizadora, granja y
  taxis): sala diáfana con estanterías, cajas, palés y focos.
- **Ascensor**: F mirando su puerta → se abren las hojas, se entra, se cierran,
  la cabina sube (2,5–6 s según la altura, con la cámara dentro y solo la cabina
  dibujada), timbre, se abren y se sale al rellano mirando a la puerta del piso.
  F en el rellano baja al zaguán. Suena `servicios.sonido.play('puerta')` en cada
  puerta y `'timbre'` al llegar si el servicio existe (probado con un servicio
  falso: puerta, puerta, timbre, puerta, puerta por viaje); si no, en silencio.
- **Apartamento en su planta, pegado a la fachada del frente**: salón (sofá,
  mesa baja, alfombra, tele, estantería, 1–3 plantas, lámpara de pie), cocina
  abierta (nevera, encimera con placa y fregadero, muebles altos), dormitorio
  (cama, mesilla con lámpara, armario) y baño (lavabo con espejo, inodoro,
  ducha); rellano con la puerta del piso. **Ventanas**: huecos reales en el muro
  de fachada con carpintería (cerco, montante, travesaño, vierteaguas); por
  ellas se ve la ciudad que ya dibuja el visor, a la altura real del piso.
- **Luces**: F o clic sobre una lámpara la enciende o apaga (pie, techo del
  salón, cocina, mesilla, baño, dormitorio; el rellano y la cabina siempre
  encendidos; los plafones del zaguán y los focos de la nave, encendidos y
  conmutables). Sin luces de three.js: uniformes del material del interior.
  **Cada lámpara alumbra solo su zona**: salón, cocina y recibidor (un espacio
  abierto), dormitorio, baño, rellano, cabina, zaguán, nave.
- **Muebles**: clic en uno lo selecciona (caja verde), flechas lo mueven 0,25 m
  en la rejilla (relativas a donde se mira, redondeadas al eje del edificio), R
  lo gira 90°, Escape/Supr lo suelta. Se queda dentro de su habitación. Se
  guarda en `localStorage['rami.piso.' + id]` (siempre con try/catch) junto con
  las lámparas; el botón «Restaurar muebles» del aviso lo borra y vuelve a la
  distribución del genotipo.
- **De quién es**: dueño de la parcela → su ático (última planta libre, a todo
  lo ancho del tramo); parcela dividida (`unidades > 0`, `units = [{ n, owner,
  handle, sale }]`) y `me` tiene la unidad n → su piso; si no → piso de muestra.
  El aviso dice la planta, de quién es (`@handle` o dirección corta
  `1a2b3c…9f0c`) y, si está en venta, el precio en RAMI (sin símbolos).
- **Salir**: cruzando de nuevo la puerta del zaguán (recorrido guiado hasta
  quedar 1,2 m delante del punto de llegada, mirando a la calle; en un patio, se
  sigue andando por él hasta la calle), F o Escape en el zaguán (igual,
  andando), Escape en un piso (directamente delante del portal), pasar a órbita
  o a VR (delante del portal; en VR también el `rig`).
- **Si el edificio cambia con el jugador dentro** (la parcela gana activos o
  queda pendiente, y con ello cambia su altura): se rehace el interior con el
  plan nuevo y el jugador sigue dentro (en su piso nuevo si estaba arriba, en el
  mismo sitio si estaba abajo). Si cambia de arquetipo o de cota, sale delante
  del portal. Si solo cambian dueño, venta o unidades, el aviso y el piso que
  toca se ponen al día sin rehacer nada.

## Cómo está hecho (para quien lo toque después)

### El portal sale del catálogo, no de una copia de sus fórmulas

`puertaDe(piezas)` recorre las piezas que devuelve el propio catálogo del núcleo
(`ctx.geom.edificioPartes(e)` para los barrios; `parcelaPartes(arch, CELL, {v,
v2, sy})` con las mismas cuentas que `applyCity` para las parcelas,
`edificioParcela(pc)`) y busca **la puerta por su firma**: una caja sin
primitiva especial con el tono `ctx.geom.colores.PUERTA` que publica el núcleo
(la copia literal `[0.06, 0.07, 0.09]` queda solo para un núcleo que no lo
publique) y un hueco de persona (≤ 3,5 × 3,3 m). Si en los barrios no aparece
ninguna puerta, `console.warn` lo dice y `diagnostico().barriosSinPuerta` lo
cuenta (hoy 0 de 3.052). La vidriera, por su tono `VIDRIERA` y su sitio (misma
x que la puerta, centrada en la fachada). Eso separa la puerta del portal (3,4 × 3,2 m, caja de 0,6 m que
sale de la fachada), la de la villa (2,4 × 2,6) y la de la oficina de la nave
(2 × 2,6) de los portones del muelle (4,5 × 4,5). De la pieza salen el centro
del hueco `px`, el plano de la fachada `zf` y el ancho. Así cada variante
(lámina, podio, escalonada, L, U, gemelas, villa, nave, cada sector) pone el
portal exactamente donde lo dibuja, y si alguien cambia el catálogo el portal
lo sigue solo.

- `completaPortal(po, piezas)`: el punto de llegada `A`, 1,35 m delante de la
  puerta, y `zo`, la cara de fuera de su caja. Si la puerta está dentro de la
  huella (el patio de una L o de una U), `po.pat`: el rectángulo local entre las
  alas (los cuerpos que llegan más allá de la fachada de la puerta; un lado sin
  ala, el de la L, queda abierto hasta 1,5 m fuera de la huella) desde la puerta
  hasta 1,5 m fuera de la boca. `po.m` es el marco local del edificio (mundo = O
  + R_y(yaw)·local, el mismo `compose` que el núcleo).
- **Patios** (`indicePatio`, `patioEn`, `andaPatio`): cada patio va en todas las
  celdas de 64 m que toca su rectángulo; el gancho `andar`, fuera de un
  edificio, mira una sola celda por cuadro (casi siempre vacía). Dentro del
  rectángulo, el módulo mueve al jugador con las mismas teclas y la misma
  velocidad que el visor (6 m/s × `walk.speed`, ×5 con mayúsculas), empuja un
  círculo de 0,42 m (el radio del visor) contra las alas, la fachada del fondo
  (con la vidriera) y la caja de la puerta, y pone `walk.pos.y = groundH`, como
  el visor. Al salir del rectángulo el visor vuelve a llevarlo. El margen de
  1,5 m fuera de la huella hace falta porque el catastro de la base gira las
  huellas al revés que las mallas (medido con `solidoEn`: las esquinas de 7 de 8
  edificios girados quedan fuera de su propio sólido; en una L girada 91° el
  visor paraba al jugador a 0,57 m de la huella en vez de a 0,42); la rama
  «vida» lo corrige en el núcleo (`aLocal` del catastro con `cos(yaw), sin(yaw)`).
- Índice: rejilla de 64 m sobre `A` (`indice`, `claveRejilla`). `buscaCercano()`
  mira las nueve celdas alrededor del jugador, cada `PASO_BUSCA = 0,1 s`, y se
  salta lo que no se dibuja (`dibujado(po)`: ocultos bajo una parcela y la
  fracción de calidad `Q.clusters`). Los de barrio se indexan una vez en `listo`;
  los de parcela, en cada `ciudad`.

### El plan de un edificio (`planifica(po)`)

- Cuerpos: cajas que arrancan en el suelo y miden ≥ 5 × 6 × 5 m. `B0` es el que
  tiene la puerta en su cara frontal; `B1`, el más alto (a igualdad, el más
  cercano al portal en x): ahí van los pisos.
- **Plantas libres**: de 3,6 en 3,6 m sobre el suelo (el mismo paso que las
  ventanas del sombreador), por debajo del peto y por encima del techo del
  zaguán. Para cada planta, `tramoLibre(yb)` recorta el frente de `B1` con lo que
  tape por delante a esa altura (podio, cuerpos escalonados, alas de la L o de
  la U, marquesina, vidriera, peto); si algo tapa justo delante del portal, la
  planta no vale. Un solo tramo para todas (`fx0..fx1`, la intersección; si
  queda por debajo de 7,5 m, las plantas que contienen el tramo de la más alta).
  En Dubái (los 3.052 de barrio): 1.357 torres y bloques con plantas libres
  (30.997 plantas), 145 sin ninguna (van como casa en planta baja, junto a las
  830 villas: 975 casas) y 720 naves. Con las cuatro parcelas sintéticas de la
  prueba de coste: 31.035 plantas y 50.317 unidades. Planificarlos todos:
  29,6–31,6 ms (el primero, 569 ms con el compilador en frío).
- **Unidades por planta** = ⌊(ancho del tramo − 1 m) / 11 m⌋, de 1 a 4. La
  unidad n (desde 1) está en la planta libre ⌊(n − 1) / upp⌋ (contando desde la
  más baja) y en el hueco (n − 1) mod upp; el hueco s ocupa el s-ésimo trozo del
  tramo. El piso de muestra: planta y hueco del canal 42.
- Alzado: fachada interior `zI = B1.z1 − 0,35` (muro de 0,3 m), piso de fondo
  `D = clamp(fondo de B1 − 6, 6,5, 10,5)`, rellano de 2,4 m detrás, cabina de
  1,9 × 1,9 m detrás del rellano en `ex` (x del portal dentro del tramo). El
  zaguán va de la fachada del portal hasta el ascensor (al menos 7,5 m; hotel
  12, concesionario 20) y a lo ancho del portal y del ascensor.

### Dibujar el interior dentro de la ciudad sin pantalla de carga

La malla de los edificios es de caras frontales: desde dentro no se ve. Pero
dentro del volumen del interior se cuelan otras caras (la torre dentro de su
podio, la del vecino, el mar). Solución en dos pasadas con el mismo sombreador
de vértices (misma profundidad al bit):

1. `mats().fondo` (`renderOrder` 1000): solo profundidad, `depthFunc = Always`,
   `colorWrite = false`, con la envolvente (suelo, techo y paredes).
2. `mats().env`, `dec` y los muebles (`renderOrder` 1001): color con la prueba
   normal.

Donde la envolvente tiene hueco (ventana, puerta) la primera pasada no escribe
y queda lo que el visor ya había dibujado: la ciudad real. Los materiales van
en la lista de **transparentes sin mezcla** (`transparent: true, blending:
NoBlending`) para dibujarse después de todo: el mar es transparente y, dibujado
detrás, se colaba por encima del interior bajo la línea del horizonte, y las
estrellas (sin prueba de profundidad) por encima de todo; comprobado ocultando el
mar y con la captura de la pared de noche antes y después.

Solo se dibuja **el espacio donde está la cámara** (`ponVisible`): zaguán, o
cabina sola durante el viaje, o planta (rellano + piso); la cabina, además, en
el zaguán y en la planta. Si hubiera dos a la vez, uno se proyectaría por la
ventana del otro.

**Cada cuadro con el interior en la escena** (`camaraDentro`, gancho `cuadro`,
que corre después de colocar la cámara y antes de dibujar):

- **Plano cercano a 5 cm** (`CERCA_DENTRO`). El visor lo pone a 0,3 m a pie, lo
  mismo que el radio del jugador dentro: pegado a una pared y mirando en
  diagonal, el trozo de pared más cercano quedaba delante del plano cercano, se
  recortaba y por el recorte se veía lo que el visor había dibujado detrás (el
  mar, la ciudad desde arriba). Con 5 cm, recortar una pared a 0,3 m exigiría un
  campo de visión de más de 160°. El búfer de profundidad del visor es
  logarítmico: su precisión depende del plano lejano, no del cercano. El visor
  vuelve a poner los suyos en cada cuadro, así que al salir no hay nada que
  restaurar (comprobado: 0,3 a pie y 1,6 en órbita tras salir).
- **Plano lejano a 90 m** (`LEJOS_CIEGO`) cuando ningún hueco a la ciudad cae en
  el tronco de la cámara (`huecoALaVista`: la caja de cada ventana, puerta o
  vidriera del espacio, 0,3 m más ancha, contra un tronco hecho con la misma
  pose que usará el visor): mirando a una pared o dentro de la cabina, lo que
  queda más allá de 90 m no se envía. Con un hueco a la vista, el lejano del
  visor, y por la ventana se ve la ciudad entera.
- **La vista por la puerta.** Mientras se entra o se sale y el ojo está fuera
  de la cara de la caja de la puerta, `uPuerta = 1` y la pasada de solo
  profundidad no se dibuja. Cada fragmento del interior se queda solo si el rayo
  de la cámara hasta él cruza el rectángulo de la puerta (su cara de fuera) o el
  de la vidriera (cortado a 3,75 m, bajo la marquesina), y escribe como
  profundidad la del punto de cruce, entre un 1 % y un 0,05 % más cerca según
  su distancia real (`0,99 + 0,0095·(1 − e^(−d/10 m))`), que conserva el orden
  entre sus piezas: tapa la caja negra de la puerta y el cristal, que están en
  ese plano, y no tapa lo que haya delante (una farola, un peatón). Todo en el
  marco local del edificio (`vL`, `uCamL` en doble precisión) y con
  `modelViewMatrix`: con coordenadas de mundo (decenas de km) la profundidad
  temblaba milímetros entre fragmentos y las piezas vecinas se peleaban en
  puntos (primera captura de esta ronda). Hace falta profundidad por fragmento
  (la del búfer logarítmico); sin ella, el interior aparece al cruzar el umbral.
- **Las hojas de la calle** (`hojasCalle`: dos de vidrio tintado con cerco,
  tirador y `aDesliza` ∓1, en el grueso del muro del zaguán, de la villa o de
  la nave) se abren con el `uAbre` del material del decorado: al entrar y al
  salir, y por dentro al acercarse a menos de 2,6 m del hueco, a 2 m/s.

### El material del interior

`VS`/`FS` en el módulo: color por vértice, `aLamp` (índice + 1 de la lámpara a
la que pertenece la pantalla, que brilla si está encendida), `aDesliza` (−1/+1
en las hojas del ascensor y de la calle, que se abren con el uniforme `uAbre`).
Ocho lámparas en uniformes (`uLampPos`, `uLampOn`, `uLampCol`; 0–5 las del piso,
6 el rellano, 7 la cabina) y **su zona** (`uLampRect`, rectángulo local; un
fragmento fuera de la zona no recibe esa lámpara). Las zonas acaban en el eje de
cada tabique (4 cm de margen), así que la cara de un tabique que da a una
habitación recibe la luz de esa y no la de la de al lado: antes la del rellano,
siempre encendida, alumbraba de noche la pared del salón con todas las del piso
apagadas. La de la cabina no alcanza la cara de fuera de su frente (la que da
al zaguán). `uDespY` sube el marco local con la cabina. La luz del día entra por el plano de la fachada del
espacio visible (`uVenN`, `uVenD`, `uVentanas`): el cielo y el sol del visor
(`uSkyColor`, `uSunColor`, `uSun`), más fuerte cerca de la ventana (e^(−0,3·d)) y
en las caras que la miran, apagada con `uNight`; de noche queda un resplandor
tenue de la ciudad. `uK` = 0 en la cabina (sin ventana).

### Genotipo

Todo lo que decide sale de `semillaMorfologia` del edificio (barrio: posición
redondeada; parcela: celda) con canales nuevos: **41** distribución y colores
del piso (más `planta·16 + hueco + 2` mezclado con `Math.imul`), zaguán (extra
7), villa (1), nave (3); **42** planta y hueco del piso de muestra; **43** coches
de muestra del concesionario. Los muebles se sortean con `lcg` en orden fijo.
Ningún `Math.random`.

### Andar dentro

`andar(dt)` devuelve `true` mientras hay casa (y en un patio, `andaPatio`): mueve `walk.pos` con WASD (y
flechas si no hay mueble seleccionado) a 2,4 m/s (×1,7 con mayúsculas), en el
marco local, con colisión propia (`empuja`: círculo de 0,3 m contra
rectángulos: paredes y antepechos que llegan al suelo, cocina, baño, escalera,
mostrador, estanterías, peanas, muebles salvo la alfombra, la cabina) y
`walk.pos.y` = cota del suelo del espacio. Pasar el plano de la puerta de la
calle dentro del hueco lanza la salida. Los recorridos guiados (`corre`,
`pasoAndar`, `pasoPuertas`, `pasoViaje`, `pasoFn`) son una lista de pasos que
avanza `andar`, así que `_debug.paso(dt)` los reproduce sin dibujar.

## Cifras medidas

Panel real (binario base v0.11.0 + proxy con esta rama), Chromium por software,
calidad media, 1280 × 800. Máquina compartida con otros cinco paneles. «Envía»
es lo que dibuja la tarjeta en ese cuadro (`stats()`: triángulos / llamadas),
ciudad incluida.

| Medida | Resultado |
|---|---|
| Ocho encuadres fijos, base v0.10.16 → esta rama (ronda 1) | **Idénticos**: 920.678 / 21, 790.042 / 17, 959.508 / 15, 1.014.414 / 21, 952.544 / 28, 802.440 / 17, 1.748.908 / 86, 1.532.854 / 42 (`/tmp/ramiverif/umbral_r1_ab_ab.json`) |
| Fuera, en `stats().ext.umbral` | 0 mallas, 0 triángulos: nada del interior existe; plano cercano y lejano, los del visor |
| Portales indexados | 3.052 de barrio (18–29 ms una vez, en `listo`), 0 sin puerta, 418 con patio; más los de parcela |
| Búsqueda del portal cercano (cada 0,1 s) | media 0,003–0,006 ms en esta ronda (máximo 0,2 ms); ronda anterior: media 0,015–0,13 ms, máximo 0,8 ms la primera |
| Patio (una celda del índice por cuadro, solo a pie y fuera) | no medido por separado: `patioEn` es una consulta a una celda de 64 m, casi siempre vacía; 492 pasos de `andaPatio` en las pruebas |
| Construir el interior al entrar | 6–17 ms en esta ronda (2–11 ms y un caso de 96 ms en la anterior) |
| Zaguán de torre (dentro) | 1.742 triángulos, 7 mallas (con la cabina y las hojas de la calle) |
| Zaguán en la vista por la puerta | 1.466 triángulos, 5 mallas (sin la pasada de solo profundidad) |
| Planta (rellano + piso + cabina) | 3.592 triángulos, 7 mallas |
| Cabina en el viaje | 308 triángulos, 3 mallas |
| Recepción del hotel / sala del concesionario / villa / nave | como en la ronda anterior (2.124 / 6; 3.056 / 6 con 3 coches; 2.936 / 4; 2.224–2.260 / 3), más las hojas de la calle |
| Envía, mirando a una pared del piso (lejano a 90 m) | **803.020 / 20** (ronda anterior 1.717.338 / 52) |
| Envía, pegado a la pared del dormitorio en diagonal | 801.520 / 19 y 920.052 / 25 (la revisión midió 1.517.682 / 55) |
| Envía, en el zaguán mirando a la pared | 801.168 / 19 – 801.476 / 22 (antes 804.014 / 24) |
| Envía, en la cabina durante el viaje | 800.044 / 19 |
| Envía, por la ventana (lejano del visor) | 938.018 / 30 |
| Envía, desde la calle con la vista por la puerta | 1.673.072 / 52 (la ciudad entera, como fuera) |
| Viaje del ascensor a la planta 17 | 57 pasos de 0,1 s hasta media subida, 54 más hasta salir al rellano |

Lo que queda por debajo de ~800.000 triángulos mirando a una pared son las
mallas que el visor no descarta por distancia (`frustumCulled = false`: hitos,
terreno, mar, cielo) y la tesela del propio edificio.

## Capturas (miradas una a una)

En `/tmp/ramiverif/`. Ronda de corrección 1 (`umbral_r1_*`):

- `umbral_r1_pared_piso_45.png` y `umbral_r1_pared_piso_m45.png`: pegado a la
  pared del dormitorio, mirando ±0,8 rad (la reproducción de la revisión, que
  veía el mar y la ciudad): pared maciza. `umbral_r1_pared_diagonal.png`: lo
  mismo en el zaguán, 43° hacia la calle: pared.
- `umbral_r1_puerta_vista.png`: desde la calle, a 1,8 m, con F pulsada: el
  zaguán iluminado detrás de la puerta, las hojas de vidrio a medio abrir con
  sus tiradores. `umbral_r1_puerta_umbral.png`: 0,7 m más cerca, las hojas
  abiertas y el zaguán por la puerta.
- `umbral_r1_patio_aviso.png`: dentro del patio de una L (b:25175:35005), a
  3,9 m de la puerta: «F · Entrar · Torre · Dubai Marina», la caja de la puerta,
  la vidriera y la marquesina. `umbral_r1_patio_cruzando.png`: cruzando, con el
  aviso reducido al nombre del edificio y el zaguán por la puerta.
- `umbral_r1_ventana_dia.png`, `umbral_r1_pared_dia.png`,
  `umbral_r1_ventana_noche.png`: la ciudad por la ventana (con el lejano del
  visor) y la pared (con el de 90 m).
- De noche: `umbral_r1_pared_noche_apagadas.png` (todas las del piso apagadas,
  el rellano encendido: la pared del salón queda oscura; la revisión la veía
  parda y alumbrada), `umbral_r1_lampara_apagada.png` /
  `umbral_r1_lampara_encendida.png` (F en la de pie), `umbral_r1_dormitorio_noche.png`
  (con la de pie del salón encendida, el dormitorio sigue a oscuras),
  `umbral_r1_rellano_noche.png` (el rellano, con su luz).
- `umbral_r1_cabina_viaje.png` (la cabina congelada a media subida, «Ascensor ·
  planta 9 · 52 %», alumbrada por su lámpara), `umbral_r1_villa_puerta.png` (la
  puerta de la calle de una villa desde dentro, con sus dos hojas).
- `umbral_r1_hotel.png` (recepción), `umbral_r1_concesionario.png` («Coches
  expuestos: 2 · Car dealership · @concesion» con el panel en inglés),
  `umbral_r1_atico_reabierto.png` («Tu ático · planta 72» después de que la
  parcela ganara activos con el jugador dentro).
- `umbral_r1_ab_*.png`: los ocho encuadres fijos.

De la entrega (siguen valiendo; el código que las produce no ha cambiado salvo
lo dicho): `umbral_zaguan.png`, `umbral_buzones.png`, `umbral_rellano.png`,
`umbral_piso.png`, `umbral_dormitorio.png`, `umbral_mueble_movido.png`,
`umbral_mueble_recargado.png`, `umbral_fuera.png`, `umbral_hotel_ventana.png`,
`umbral_atico.png`, `umbral_atico_ventana.png`, `umbral_unidad.png`,
`umbral_villa.png`, `umbral_nave.png`.

Comprobado además en esta ronda, sin captura (`/tmp/ramiwt/umbral/r1/t*.json`):
andando con W desde fuera de la boca del patio, el aviso sale a 2,77 m de la
llegada (4,1 m de la puerta) y F entra en 19 pasos; saliendo con W por la
puerta del zaguán se cruza el patio y se llega a la calle fuera de todo sólido;
la parcela dividida con `unidades: 6` tiene 6 buzones; el concesionario sin
nombre se llama «Car dealership» en inglés y «Concesionario de coches» en
español; ático de la planta 63 → 72 al pasar de 1 a 6 activos, y 18 (3
plantas) al quedar pendiente, sin salir; el sofá movido y girado se recupera
tras recargar (`recuperado: true`, −4,87 / 3,25 giro 0) y «restaurar» lo
devuelve (−4,25 / 3,05 giro 3); clic en la puerta de otra torre → dentro en 18
pasos; `setMode('orbit')` dentro → fuera, plano cercano 1,6 en órbita y 0,3 al
volver a pie; cero errores de consola y `extFallos()` vacío en las siete pasadas
y en `humo.mjs` con los cinco módulos.

## Lo público (`handle.ext.umbral`)

`entrar({ id, inmediato, planta })`, `salir(andando)`, `estado()`,
`portalCercano()`, `buscar()`, `portales(x, z, r, filtro)` (con `origen` y
`local`: puerta, huella y patio en el marco del edificio), `total()`,
`irAPlanta(n, inmediato)` (0 = zaguán), `colocar(x, z, yawLocal, pitch)`,
`mirar('ventana'|'pared'|'salon'|'dormitorio'|'lampara'|'buzones'|'ascensor'|
'salida'|'zaguan'|'recepcion'|'coches')`, `accion()` (la F), `luz(i, on)`,
`seleccionar(id)`, `mover(adelante, derecha)`, `girar()`, `restaurar()`,
`congelar(si)` (para las pruebas: para el recorrido guiado y la puerta
automática mientras se dibuja una captura), `medidas()`, `diagnostico()`. En
`stats().ext.umbral`: portales, patios, dentro, espacio, mallas y triángulos
del interior, `vistaPorLaPuerta`, `lejosCiego`, `cerca`, `pasosPatio`,
`reaperturas` y los tiempos de búsqueda, índice y construcción.

## Ronda de corrección 1: qué dijo la revisión y qué se hizo

| Hallazgo | Arreglo | Prueba |
|---|---|---|
| **Importante**: pegado a una pared y mirando en diagonal se veía la ciudad (plano cercano 0,3 = radio del jugador) | Plano cercano a 5 cm con el interior en la escena (`camaraDentro`) | Las tres capturas de la reproducción: pared maciza |
| Aviso del patio en la boca, a 18–48 m de la puerta | Los patios se andan (`andaPatio`); la llegada es la de siempre, 1,35 m delante de la puerta | Aviso a 4,1 m de la puerta, captura dentro del patio |
| HUD «Zaguán» cruzando el patio; la puerta, una caja negra que no se abre | Mientras se cruza, solo el nombre; vista por la puerta y hojas automáticas | `patio_cruzando`, `puerta_vista`, `puerta_umbral` |
| Nombre de sector sin traducir | `po.nombre` guarda solo el nombre propio; el del sector pasa por `t()` | «Car dealership» en inglés |
| Las lámparas alumbraban a través de las paredes | Zona por lámpara (`uLampRect`) | `pared_noche_apagadas`, `dormitorio_noche` |
| 48 buzones con 6 unidades de consenso | Uno por `unidades` si la parcela está dividida | `buzones: 6` |
| Tono de la puerta copiado del núcleo | El núcleo lo publica (`ctx.geom.colores.PUERTA`, `VIDRIERA`); aviso y cuenta si no se encuentra ninguna | `barriosSinPuerta: 0` |
| Cambio de altura con el jugador dentro: plan viejo | `reabre(po)` cuando cambia la cota de la azotea | 63 → 72 → 18 sin salir |
| Plural ruso de «coches» | «Coches expuestos: n», sin concordancia | frag sin «coche»/«coches» |
| La ciudad entera se envía estando dentro | Lejano a 90 m sin hueco a la vista | 1.717.338 / 52 → 803.020 / 20 mirando a la pared |

Encontrado de paso, fuera de este frente: **el catastro de la base gira las
huellas al revés que las mallas** (`aLocal` del catastro usa `cos(−yaw),
sin(−yaw)` para el giro directo): en 7 de 8 edificios de muestra, las esquinas
de la malla caen fuera de su propio sólido. La rama «vida» ya lo corrige; el
patio funciona con las dos versiones gracias al margen de 1,5 m.

## Lo que queda

- **Arrastrar muebles con el ratón** no está: en modo a pie el arrastre gira la
  vista en el núcleo y el gancho `clic` solo recibe clics sin arrastre. Se
  mueven con las flechas en rejilla de 0,25 m.
- **VR**: el gancho `vr(true)` saca al jugador delante del portal y coloca el
  `rig`; no probado con gafas (el entorno no tiene WebXR). Dentro de VR no se
  puede entrar (el aviso no aparece).
- **Sonido**: probado con un servicio falso (esta ronda: «puerta, puerta» antes
  de subir); el módulo `extras` de esta rama aún no pone `servicios.sonido`, así
  que con él de verdad no se ha oído.
- **Por la ventana** se sigue enviando la ciudad entera (938.018 / 30 en la
  captura); mirando a una pared ya no, pero lo que el visor no descarta por
  distancia (~800.000 triángulos) sigue ahí.
- **Unidades**: el contrato `units = [{ n, owner, handle, sale }]` con n desde 1
  se ha probado con una ciudad sintética; hoy el nodo no lo manda y el código
  funciona igual (todo son pisos de muestra o el ático del dueño).
- 145 torres y bloques no tienen ninguna planta con la fachada libre (su cuerpo
  alto queda tapado por delante en todas las alturas): se entra a una casa en
  planta baja, sin ascensor.
- **Desde dentro, la puerta de la calle** con las hojas abiertas deja ver la
  cara interior de la caja de la puerta del catálogo (negra), no la calle; la
  vidriera se ve como cristal esmerilado. La vista por la puerta es solo de
  fuera hacia dentro.
- **Vista por la puerta sin profundidad por fragmento** (WebGL 1 sin
  `EXT_frag_depth`): no hay vista; el interior aparece al cruzar el umbral. No
  probado en un navegador así.
- **Patios en la base sin la corrección del catastro de «vida»**: en edificios
  muy girados la huella del catastro invade el patio y, al salir de él, el
  visor puede empujar al jugador hacia un lado. Probado solo en una L con el
  giro casi recto (91°).
