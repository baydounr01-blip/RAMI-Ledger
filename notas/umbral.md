# Umbral — entrega 5: el portal, el zaguán, el ascensor y el apartamento

Todo en `chain/crates/rami-gui/src/city/umbral.js` (módulo del visor) y las
cadenas en `chain/crates/rami-gui/i18n-src/frag_umbral.json`. Del núcleo
(`city3d.js`) solo toca **una línea**: `ctx.geom.colores` publica también
`PUERTA` y `VIDRIERA` (los tonos con los que el catálogo marca esas dos piezas
del portal), documentado en `docs/EXTENSIONES-3D.md`. Ni el panel, ni el nodo,
ni el consenso. Usa los ganchos de la v0.11.0 tal como están (`listo`,
`ciudad`, `calidad`, `andar`, `cuadro`, `tecla`, `clic`, `modo`, `vr`,
`estadisticas`, `soltar`) y, de lo que publica el núcleo, además de la
geometría: `ctx.catastro.empujarFuera` (al salir sin andar) y
`ctx.mundo.sueloCalle` (la cota de la acera, de «vida», si está).

Desde la ronda de corrección 2 el frente trabaja **sobre la integración**
(`80067fa`, los seis frentes juntos): todas las cifras y capturas `umbral_r2_*`
son de ese núcleo, con el binario de la integración.

## Qué hace

- **Cada edificio tiene portal que se abre**: los 3.048 de barrio de la integración (3.052 en la v0.10.16) y los de las
  parcelas. A pie (`S.mode === 'walk'`, `walk.fly < 2`, fuera de VR), a menos de
  3 m del punto de llegada del portal (1,35 m delante de la puerta) y mirándolo
  (±70°), aparece abajo en el lienzo «F · Entrar» con el nombre (tipo y barrio,
  o empresa y `@handle`; sin nombre, el del sector, traducido). F o un clic en la
  puerta entra.
- **Los patios se andan**: en los 416 edificios de barrio en L o en U de la
  integración (418 en la v0.10.16) la puerta está al fondo del patio, que el
  catastro del núcleo tiene por macizo. El módulo lleva al jugador dentro del
  patio (gancho `andar`, con las alas, la fachada del fondo y la caja de la
  puerta como sólidos) y el aviso sale a 3 m de la puerta, no en la boca. Q/E
  suben y bajan como en el visor; a partir de 2 m se vuela y el patio lo lleva
  el visor.
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
  cuenta que el núcleo, `hash2(i, 23)`; hasta 12), o 3–6 de muestra si no tiene
  ninguno; peanas a 6 m en la fila y filas a 6,2 m, sin solaparse, y la sala se
  alarga (de 20 m a 23 m con 12 coches) para dejar libres la entrada y la mesa
  del vendedor; el letrero dice «Coches expuestos: n» (sin plural que concordar
  en ruso).
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
- **Lo que se toca se ve**: F y el clic solo alcanzan lámparas, muebles,
  ascensor y puerta sin una pared en medio (una lámpara del cuarto de al lado
  no se enciende a través del tabique).
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
- **De quién es**: con el contrato de la escritura (`docs/VIVIENDA.md` §8:
  `unidades` de 0 a 64 y `units = [{ n, owner, handle, sale }]`, que el nodo de
  la integración publica en `/api/city`). Las viviendas ocupan las plantas
  libres de abajo arriba; el ático (última planta, a todo lo ancho) es del dueño
  de la parcela mientras las viviendas no lleguen a él. Dueño con el ático libre
  → su ático; si no, su vivienda de número más bajo; si no → piso de muestra
  (fuera del ático). Una vivienda que no cabe en el edificio (una parcela
  pendiente, baja, dividida en 64) lleva al piso de muestra y el aviso dice «Tu
  vivienda no tiene planta en este edificio: unidad n». El aviso dice la planta,
  de quién es (`@handle` o dirección corta `1a2b3c…9f0c`) y, si está en venta,
  el precio en RAMI (sin símbolos, con los decimales de `ramShort` del panel).
  Un buzón por vivienda, hasta 64.
- **El modo foto** de «extras» oculta el aviso entero (va en una capa propia,
  `.umbralCapa`, que el módulo nunca enciende ni apaga), y su Escape cierra la
  foto sin sacar del edificio.
- **Salir**: cruzando de nuevo la puerta del zaguán (recorrido guiado hasta
  quedar 1,2 m delante del punto de llegada, mirando a la calle; en un patio, se
  sigue andando por él hasta la calle), F o Escape en el zaguán (igual,
  andando), Escape en un piso (directamente delante del portal), pasar a órbita
  o a VR (delante del portal; en VR también el `rig`). Sin andar, el sitio de
  llegada se aparta con `ctx.catastro.empujarFuera` de cualquier sólido (salvo
  en el patio del propio edificio) y los pies van a la cota de la acera.
- **Si el edificio cambia con el jugador dentro** (la parcela gana activos o
  queda pendiente, y con ello cambia su altura): se rehace el interior con el
  plan nuevo y el jugador sigue dentro (en su piso nuevo si estaba arriba, en el
  mismo sitio si estaba abajo). Si cambia de arquetipo o de cota, sale delante
  del portal. Si solo cambian dueño, venta o unidades, el aviso y el piso que
  toca se ponen al día sin rehacer nada. Si cambia el número de viviendas (la
  parcela se divide), se rehace como con la altura.

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
cuenta (hoy 0 de 3.048). La vidriera, por su tono `VIDRIERA` y su sitio (misma
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
  (con la vidriera) y la caja de la puerta, en subpasos de 0,3 m
  (`SUBPASO_PATIO`: con mayúsculas el visor da 3 m por cuadro de 0,1 s), y pone
  los pies en `sueloEn` (el terreno o la acera, como el visor). Q/E cambian
  `walk.fly` con la misma cuenta que el visor; con `walk.fly ≥ 2` el gancho
  devuelve `false` y vuela el visor. Al salir del rectángulo el visor vuelve a
  llevarlo. **El margen fuera de la huella es de 0,6 m** (`MARGEN_PATIO`): lo
  justo para que el sitio donde el visor para al jugador (a 0,42 m de la huella)
  caiga dentro. Hasta la ronda 1 era de 1,5 m porque el catastro de la v0.10.16
  giraba las huellas al revés que las mallas; la integración trae la corrección
  de «vida» (`aLocal` con `cos(yaw), sin(yaw)`) y el margen se estrecha: en esa
  franja el módulo no empuja coches ni avatares (`empujarDeMoviles` no está en el
  contexto), y en el patio, dentro de la huella, no circula el tráfico.
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
  En Dubái (los 3.052 de barrio de la v0.10.16; la integración, en «Cifras»): 1.357 torres y bloques con plantas libres
  (30.997 plantas), 145 sin ninguna (van como casa en planta baja, junto a las
  830 villas: 975 casas) y 720 naves. Con las cuatro parcelas sintéticas de la
  prueba de coste: 31.035 plantas y 50.317 unidades. Planificarlos todos:
  29,6–31,6 ms (el primero, 569 ms con el compilador en frío).
- **Unidades por planta** (`unidadesPorPlanta`) = ⌊(ancho del tramo − 1 m) /
  11 m⌋, de 1 a 4. Si la parcela está dividida en más viviendas de las que
  caben así (plantas × esas), los pisos se estrechan hasta ⌈unidades / plantas⌉
  por planta, sin bajar de 7,4 m de fachada cada uno (`MIN_HUECO_UNIDAD`; el
  piso más estrecho mide 7 m). La vivienda n (desde 1) está en la planta libre
  ⌊(n − 1) / upp⌋ (contando desde la más baja) y en el hueco (n − 1) mod upp
  (`sitioUnidad`; `numeroUnidad` es la inversa, y el aviso usa las dos, así
  que el número del titular es siempre el de ese hueco); el hueco s ocupa el
  s-ésimo trozo del tramo. Lo que ni así cabe no tiene piso (`sitioUnidad` →
  null). Hasta la ronda 1, la vivienda n de más se aplastaba en la última
  planta, en el hueco de otra, y el titular enseñaba el dueño de esa otra. El
  ático es la última planta mientras ⌈unidades / upp⌉ < plantas. El piso de
  muestra: planta y hueco del canal 42, fuera del ático de una parcela.
- Alzado: fachada interior `zI = B1.z1 − 0,35` (muro de 0,3 m), piso de fondo
  `D = clamp(fondo de B1 − 6, 6,5, 10,5)`, rellano de 2,4 m detrás, cabina de
  1,9 × 1,9 m detrás del rellano en `ex` (x del portal dentro del tramo). El
  zaguán va de la fachada del portal hasta el ascensor (al menos 7,5 m; hotel
  12; concesionario lo que pida `planExpo`, 20 m como poco) y a lo ancho del
  portal y del ascensor.
- **Sala de exposición** (`planExpo`, `exposicion`): peanas de 5,6 m de
  diámetro a 6 m entre centros, ⌊ancho / 6 m⌋ por fila, filas a 6,2 m desde
  0,4 m de la pared del fondo, y la sala tan honda como pidan las filas más
  4,6 m libres delante (la entrada y la mesa del vendedor): 10,6 + 6,2 ×
  (filas − 1) m, al menos 20. Con 12 coches en 34 m: 5 + 5 + 2 y 23 m de fondo.
  Hasta la ronda 1 eran dos filas fijas con paso ancho / coches (5 m con 12) y
  las peanas se metían unas en otras.

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
`walk.pos.y` = cota del suelo del espacio. **El movimiento va en subpasos de
0,1 m como mucho** (`SUBPASO`): cada subpaso deja el círculo a 0,3 m de la
pared, así que el centro nunca entra en ella. Con el paso entero (0,41 m con
mayúsculas y el tope de 0,1 s del visor) el centro caía 0,11 m dentro de un
muro de 0,2 m, el borde más cercano era el de detrás y se salía al otro lado:
entre el rellano y el piso, donde nada tapa la ciudad (hallazgo importante de la
revisión 2). Pasar el plano de la puerta de la
calle dentro del hueco lanza la salida.

**Mirar y tocar sin atravesar paredes.** `pared()` apunta cada trozo de pared,
con su altura, en `E.muros`; `cortaMuro(E, o, d, tmax)` da el primer corte de un
segmento con ellos (láminas en 3D, marco del edificio). `objetivo()` (la F)
descarta lo que tenga una pared entre el ojo y el objeto; `tocado()` (el clic)
empieza con el rayo acortado hasta la primera pared. Así, pegado al tabique del
salón, la lámpara de la mesilla del dormitorio no se enciende ni la cama se
selecciona; lo que está en el salón delante del tabique (la tele), sí. Los recorridos guiados (`corre`,
`pasoAndar`, `pasoPuertas`, `pasoViaje`, `pasoFn`) son una lista de pasos que
avanza `andar`, así que `_debug.paso(dt)` los reproduce sin dibujar.

## Cifras medidas

Ronda de corrección 2, sobre la integración (`80067fa`, binario
`rami-gui-integ` + proxy con esta rama), Chromium por software, calidad media,
1280 × 800. Máquina compartida con otros cinco paneles. «Envía» es lo que
dibujó la tarjeta en el último cuadro (`stats()`: triángulos / llamadas),
ciudad incluida; en la integración dos cuadros seguidos en la misma pose dan
cifras distintas (316.254 y 827.230 mirando a la misma pared), así que van
como intervalo. Guiones y datos: `/tmp/ramiwt/umbral/r2/t1…t6.mjs` y `.json`.

| Medida | Resultado |
|---|---|
| Ocho encuadres fijos, integración sin tocar → esta rama | La integración no repite cifras entre cargas (tráfico, peatones, metro y barcos van con el reloj real): la propia `80067fa` sin cambios, medida dos veces, da hasta 7.540 triángulos y 1 llamada de diferencia (`referencia_integ_ab.json` frente a `umbral_r2_abbase_ab.json`); esta rama, del mismo orden (hasta 8.060 y 1: `umbral_r2_ab_ab.json`). Lo que prueba que fuera no cambia nada es la sonda de `t5`: en los seis encuadres fijos con cámara propia, 0 objetos del módulo en la escena (ni el grupo `umbral` ni mallas con su material), `stats().ext.umbral` = 0 mallas y 0 triángulos, plano cercano el del visor (0,9 / 0,5 / 0,5 / 0,5 / 0,3 / 0,3) |
| Tras entrar, subir, bajar y salir | 0 objetos del módulo en la escena (geometrías 97 y texturas 16 en `renderer.info`; las fugas en ciclos repetidos las midió la revisión 2: estables) |
| Portales indexados | 3.048 de barrio (la integración tiene 4 edificios menos que la v0.10.16), 0 sin puerta, 416 con patio; más los de parcela |
| Índice de barrio, una vez en `listo` | 28,8–75,9 ms en seis cargas de esta ronda (75,9 / 61,5 / 51,8 / 51,7 / 33,0 y 28,8 tras recargar); la revisión midió 92,5 ms en otra |
| Búsqueda del portal cercano (cada 0,1 s) | 3.281 búsquedas en `t5`: media 0,006 ms, máximo 1,7 ms (una) |
| Construir el interior al entrar | 1,5–10,8 ms |
| Diagnóstico de los 3.048 | 1.353 torres y bloques con plantas (30.426 plantas, 49.646 unidades), 975 casas (145 torres sin planta libre), 720 naves, 0 fallos, 143 ms |
| Colisión dentro, subpasos | 0,1 m como mucho; con mayúsculas y dt 0,1, 5 subpasos por cuadro; el salto máximo por cuadro en 256 recorridos es 0,409 m (la velocidad, sin atravesar nada) |
| Zaguán de torre / planta / cabina | 1.742 triángulos y 7 mallas / 3.592 y 7 / 308 y 3 (sin cambios) |
| Envía, zaguán mirando al fondo (lejano ciego) | 263.752 / 31 – 818.668 / 30; antes de pasar la prueba del hueco al marco local, 1.704.754 / 68 (lejano del visor) |
| Envía, zaguán mirando a la pared lateral | 821.480 / 27 (lejano ciego) |
| Envía, zaguán mirando a la puerta | 950.356 / 43 – 989.452 / 42 (lejano del visor: hay hueco a la vista) |
| Envía, cabina a media subida | 313.278 / 27 (lejano ciego) |
| Envía, piso mirando a la pared | 316.254 / 28 – 827.302 / 28 (lejano ciego) |
| Envía, piso por la ventana | 986.956 / 44 – 992.124 / 42 |
| Poses con el lejano ciego en un piso | 185 de 288 (6 × 6 puntos del piso × 8 direcciones) |
| Concesionario con 13 activos coche | 12 coches, 5 + 5 + 2, distancia mínima entre peanas 6 m (diámetro 5,6), 0 fuera de la sala; sala de 34 × 23 m; 680.964 / 30 enviados |
| Patios de la revisión (40, andando desde 6 m fuera de la boca) | 40 de 40 con aviso (39,9 cuadros de 0,1 s de media); al salir andando, 40 de 40 llegan a la calle fuera de todo sólido |
| Parcelas de los 12 sectores (andando desde 10 m) | 12 de 12 con aviso a 2,8 m de la llegada; `salir()` las deja a las 12 fuera de todo sólido |

Ronda 1 (base v0.10.16, para comparar): los ocho encuadres fijos idénticos a la
referencia de la v0.10.16; índice 18–29 ms; mirando a la pared del piso,
803.020 / 20; por la ventana, 938.018 / 30.

Lo que queda mirando a una pared son las mallas que el visor no descarta por
distancia (`frustumCulled = false`: hitos, terreno, mar, cielo) y la tesela del
propio edificio.

## Capturas (miradas una a una)

En `/tmp/ramiverif/`. Ronda de corrección 2, sobre la integración
(`umbral_r2_*`):

- `umbral_r2_tunel_rellano.png`: la reproducción del túnel de la revisión
  (rellano, mayúsculas, cuadros de 0,1 s, 50 cuadros hacia la pared lateral):
  el jugador se queda en el rellano, junto a la puerta del piso, y se ve el
  salón por ella; antes acababa en el hueco entre el rellano y el piso, viendo
  la arena y la calle.
- `umbral_r2_tabique_mesilla.png`: pegado al tabique del salón, mirando a la
  lámpara de la mesilla del otro lado: pared, y el aviso sin «F · Encender».
- `umbral_r2_hotel_aviso.png` («F · Entrar · Hotel · @h5» andando hasta la
  puerta del hotel sintético), `umbral_r2_hotel_dentro.png` (la recepción tras
  pulsar F de verdad), `umbral_r2_concesionario_aviso.png`,
  `umbral_r2_concesionario13.png` (12 coches sobre peanas que no se tocan,
  «Sala de exposición · Coches expuestos: 12»), `umbral_r2_buzones64.png` (64
  buzones de la parcela dividida en 64; «Tu piso · unidad 7 · planta 3»).
- Lo básico, sobre la integración: `umbral_r2_zaguan.png` y
  `umbral_r2_zaguan_fondo.png` (zaguán con ascensor y escalera),
  `umbral_r2_zaguan_salida.png` (la puerta de la calle desde dentro, cerrada),
  `umbral_r2_piso.png`, `umbral_r2_ventana_dia.png` (la ciudad por la ventana,
  con la noria), `umbral_r2_pared_dia.png` (pared), `umbral_r2_ventana_noche.png`
  (las ventanas de la ciudad encendidas), `umbral_r2_lampara_apagada.png` /
  `umbral_r2_lampara_encendida.png` (F real, de noche),
  `umbral_r2_mueble_recargado.png` (el sofá movido, tras recargar la página),
  `umbral_r2_modo_foto_dentro.png` (modo foto de «extras» dentro del zaguán: sin
  aviso ni mira, con la barra de la foto), `umbral_r2_fuera.png` (fuera, delante
  del portal, tras salir andando).
- `umbral_r2_ab_*.png` y `umbral_r2_abbase_*.png`: los ocho encuadres fijos con
  esta rama y con la integración sin tocar.

Ronda de corrección 1 (`umbral_r1_*`, sobre la base v0.10.16):

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
automática mientras se dibuja una captura), `medidas()`, `diagnostico()`,
`viviendas()` (desde la ronda 2: dónde cae cada vivienda del edificio en el que
se está, `{ unidades, plantas, porPlanta, tramo, atico, lista: [{ n, planta,
hueco }] }`, con `planta: null` si no cabe). `estado()` da además, desde la
ronda 2, `peanas` y `sala` (concesionario) y `cuartos` (piso). En
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
de la malla caen fuera de su propio sólido. La rama «vida» lo corrige y la
integración lo trae; desde la ronda 2 el margen del patio es de 0,6 m.

## Ronda de corrección 2: qué dijo la revisión y qué se hizo

Esta ronda trabaja sobre la integración (`80067fa`), que ya trae la corrección
del catastro de «vida»; el módulo no toca el núcleo.

| Hallazgo | Arreglo | Prueba |
|---|---|---|
| **Importante**: con mayúsculas y un cuadro de 0,1 s se atravesaban las paredes de 0,2 m del rellano (y los tabiques de 0,12 m) y se veía la ciudad desde el hueco entre rellano y piso | Subpasos de 0,1 m en `andaDentro` (y de 0,3 m en `andaPatio`) | La reproducción exacta (rellano, mayúsculas, dt 0,1, 50 cuadros): se queda en el rellano (x = −7,321 y −3,649, sus dos paredes) con dt 0,05, 0,1 y 0,25; 256 recorridos de 25 cuadros con mayúsculas por el piso sin salir de él; 12 patios de frente contra la fachada con mayúsculas: ninguno pasa del límite (zo + 0,42); captura `tunel_rellano` |
| **Importante**: hotel y concesionario no se entraban a pie en la rama sola (catastro de la base) y `salir()` dejaba dentro del sólido | La integración trae la corrección de «vida». Además, `salirYa` aparta el sitio de llegada con `ctx.catastro.empujarFuera` (salvo en el patio propio) y pone los pies en la acera | 12 de 12 sectores con aviso a 2,8 m andando desde 10 m y `salir()` fuera de todo sólido en los 12; hotel y concesionario con F real (26 cuadros hasta dentro) y salida andando (28 cuadros, fuera de sólido); 40 de 40 patios con aviso y 40 de 40 salidas hasta la calle fuera de sólido; capturas `hotel_aviso`, `hotel_dentro`, `concesionario_aviso` |
| F y el clic alcanzaban lámparas y muebles al otro lado de un tabique | `E.muros` y `cortaMuro` en `objetivo()` y `tocado()` | Desde el salón, a 0,4 m del tabique, hacia la mesilla: objetivo null en 3 poses; desde el dormitorio, `lampara:3` en 3. Clic real con el ratón: la cama no se selecciona desde el salón (se selecciona la tele, que está delante del tabique) y sí desde el dormitorio; la lámpara de la mesilla no se enciende desde el salón y sí desde el dormitorio |
| En el patio no funcionaban Q/E y el margen de 1,5 m quitaba al visor la franja de fuera | Q/E con la cuenta del visor y vuelo por encima de 2 m; margen de 0,6 m | E: `fly` 0 → 3,6 (el visor sigue) → 21,6; Q: vuelta a 0 y el patio otra vez con el módulo |
| Con 7 coches o más por fila las peanas se solapaban | `planExpo`: 6 m entre centros, filas a 6,2 m, sala más honda | 12 coches: distancia mínima 6 m, 0 fuera de la sala; captura `concesionario13` |
| Unidades por encima de la capacidad: la n se aplastaba en el hueco de otra y el titular enseñaba otro dueño; buzones cortados en 48 | `unidadesPorPlanta`, `sitioUnidad`, `numeroUnidad`; ático solo si las viviendas no llegan; hasta 64 buzones | Cuatro parcelas sintéticas (`viviendas()`): 64 en 15 plantas de 4 → 60 con sitio, 4 sin planta, 0 duplicadas, «Tu piso · unidad 7 · planta 3 / Unidad 7 · @yo / Unidad en venta: 2,5 RAMI»; 64 en 1 planta de 5 (dueño) → su unidad 1; 4 viviendas en 8 plantas (dueño) → su ático, planta 52; 10 en 15 plantas → unidad 7 en la planta 3, hueco 2, y el titular con la 7; captura `buzones64` |
| Escape en el modo foto de «extras» sacaría del edificio | No pasa: «extras» escucha Escape en el documento en la fase de captura y corta la propagación antes del lienzo. Lo que sí pasaba es que el aviso podía volver a aparecer en la foto: ahora va en una capa propia que solo oculta el modo foto | Escape real con el modo foto abierto: se cierra la foto y se sigue dentro (planta); segundo Escape: fuera. Con la foto abierta, cambiar lo que dice el aviso no enseña la capa; captura `modo_foto_dentro` |
| Índice en frío más lento de lo anotado; puerta de la calle opaca desde dentro | Anotado: 28,8–75,9 ms en seis cargas (la revisión, 92,5); la puerta desde dentro sigue en «Lo que queda» | — |

Encontrado al medir: la prueba del lejano ciego envolvía la caja de cada hueco
girada con otra alineada con el mundo; en un edificio girado 40° la de la
vidriera llegaba a 1,2 m dentro del zaguán y, con la cámara dentro de ella, el
lejano ciego no se aplicaba mirando al fondo (1.704.754 / 68 enviados). Ahora
el tronco se lleva al marco del edificio y las cajas van alineadas con sus ejes
(263.752 / 31 – 818.668 / 30 en la misma pose; 185 de 288 poses de un piso con
el lejano ciego).

## Lo que queda

- **Arrastrar muebles con el ratón** no está: en modo a pie el arrastre gira la
  vista en el núcleo y el gancho `clic` solo recibe clics sin arrastre. Se
  mueven con las flechas en rejilla de 0,25 m.
- **VR**: el gancho `vr(true)` saca al jugador delante del portal y coloca el
  `rig`; no probado con gafas (el entorno no tiene WebXR). Dentro de VR no se
  puede entrar (el aviso no aparece).
- **Sonido**: con el servicio real de «extras» (integración) se llama en orden
  `puerta, puerta, timbre, puerta, puerta` en un viaje (espiado); el entorno no
  tiene salida de audio, así que no se ha oído.
- **Por la ventana** se sigue enviando la ciudad entera (986.956 / 44 –
  992.124 / 42); mirando a una pared ya no, pero lo que el visor no descarta por
  distancia sigue ahí.
- **Viviendas**: en la testnet la regla rige desde el 1 de marzo de 2027 y la
  cadena del arnés no tiene parcelas (`/api/city` llega con 0), así que
  `unidades` y `units` del nodo no se han visto llegar al visor: el reparto se
  ha probado con ciudades sintéticas con la forma de `docs/VIVIENDA.md` §8.
- **Una vivienda que no cabe** (parcela baja dividida en muchas) no tiene piso:
  lleva al de muestra con el aviso «Tu vivienda no tiene planta en este
  edificio». Cuántas caben depende de la altura del edificio, que crece con los
  activos de la parcela.
- En la franja de 0,6 m del patio fuera de la huella, el módulo no empuja
  coches ni avatares ajenos (`empujarDeMoviles` no está en el contexto de los
  módulos); dentro del patio no circula el tráfico.
- 145 torres y bloques no tienen ninguna planta con la fachada libre (su cuerpo
  alto queda tapado por delante en todas las alturas): se entra a una casa en
  planta baja, sin ascensor.
- **Desde dentro, la puerta de la calle** con las hojas abiertas deja ver la
  cara interior de la caja de la puerta del catálogo (negra), no la calle; la
  vidriera se ve como cristal esmerilado (captura `umbral_r2_zaguan_salida`). La
  vista por la puerta es solo de fuera hacia dentro. Para ver la calle hace
  falta que el material de los edificios del núcleo descarte un hueco (un
  uniforme con la caja de la puerta en la que se está): es un cambio del núcleo
  que esta ronda no hace.
- **Vista por la puerta sin profundidad por fragmento** (WebGL 1 sin
  `EXT_frag_depth`): no hay vista; el interior aparece al cruzar el umbral. No
  probado en un navegador así.
- El margen del patio (0,6 m) cuenta con la corrección del catastro de «vida»:
  con el catastro de la v0.10.16 (huellas giradas al revés) hacía falta 1,5 m.
