# Umbral — entrega 5: el portal, el zaguán, el ascensor y el apartamento

Todo en `chain/crates/rami-gui/src/city/umbral.js` (módulo del visor) y las
cadenas en `chain/crates/rami-gui/i18n-src/frag_umbral.json`. **No toca el
núcleo** (`city3d.js`), ni el panel, ni el nodo, ni el consenso: usa los ganchos
y el contexto de la v0.11.0 tal como están (`listo`, `ciudad`, `calidad`,
`andar`, `cuadro`, `tecla`, `clic`, `modo`, `vr`, `estadisticas`, `soltar`).

## Qué hace

- **Cada edificio tiene portal que se abre**: los 3.052 de barrio y los de las
  parcelas. A pie (`S.mode === 'walk'`, `walk.fly < 2`, fuera de VR), a menos de
  3 m del punto de llegada del portal y mirándolo (±70°), aparece abajo en el
  lienzo «F · Entrar» con el nombre (tipo y barrio, o empresa y `@handle`). F o
  un clic en la puerta entra.
- **Se cruza la puerta andando**, sin fundido: un recorrido guiado de ~1 s lleva
  al jugador desde donde está, por la boca del patio si el portal está en una L
  o una U, a través de la puerta, hasta 1,6 m dentro del zaguán. El interior se
  construye en ese mismo cuadro (2–11 ms medidos) y se hace visible cuando la
  cámara está ya en el hueco.
- **Zaguán** (torres y bloques): suelo de piedra, buzones numerados (uno por
  unidad de la torre, hasta 48; textura de lienzo con los números), escalera con
  pasamanos, puerta del ascensor con cerco y botonera, tres plafones encendidos,
  una planta y una alfombra. **Hotel** (sector 5): recepción con mostrador,
  timbre, libro y casillero de llaves, sofá y alfombra roja. **Concesionario**
  (sector 4): sala de exposición de 34 m con un coche sobre peana por cada activo
  coche de la parcela (`S.city.assets`, `kind` 2, en su celda; color con la misma
  cuenta que el núcleo, `hash2(i, 23)`), o 3–6 de muestra si no tiene ninguno.
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
  quedar 1,2 m delante del punto de llegada, mirando a la calle), F o Escape en
  el zaguán (igual, andando), Escape en un piso (directamente delante del
  portal), pasar a órbita o a VR (delante del portal; en VR también el `rig`).

## Cómo está hecho (para quien lo toque después)

### El portal sale del catálogo, no de una copia de sus fórmulas

`puertaDe(piezas)` recorre las piezas que devuelve el propio catálogo del núcleo
(`ctx.geom.edificioPartes(e)` para los barrios; `parcelaPartes(arch, CELL, {v,
v2, sy})` con las mismas cuentas que `applyCity` para las parcelas,
`edificioParcela(pc)`) y busca **la puerta por su firma**: una caja sin
primitiva especial con `TONO_PUERTA = [0.06, 0.07, 0.09]` y un hueco de persona
(≤ 3,5 × 3,3 m). Eso separa la puerta del portal (3,4 × 3,2 m, caja de 0,6 m que
sale de la fachada), la de la villa (2,4 × 2,6) y la de la oficina de la nave
(2 × 2,6) de los portones del muelle (4,5 × 4,5). De la pieza salen el centro
del hueco `px`, el plano de la fachada `zf` y el ancho. Así cada variante
(lámina, podio, escalonada, L, U, gemelas, villa, nave, cada sector) pone el
portal exactamente donde lo dibuja, y si alguien cambia el catálogo el portal
lo sigue solo.

- `completaPortal(po)`: el punto de llegada `A`. Si la puerta está dentro de la
  huella del catastro (el patio de una L o de una U) la llegada es la boca del
  patio (`hd + 0,75`), porque el catastro no deja acercarse más; si no, 1,35 m
  delante de la fachada. `po.m` es el marco local del edificio (mundo = O +
  R_y(yaw)·local, el mismo `compose` que el núcleo).
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
ventana del otro. Mientras se cruza la puerta el interior aparece solo con la
cámara ya dentro de la caja de la puerta (`visibilidadTransito`): la envolvente
con prueba «siempre», vista desde la calle, se vería a través de la fachada.

### El material del interior

`VS`/`FS` en el módulo: color por vértice, `aLamp` (índice + 1 de la lámpara a
la que pertenece la pantalla, que brilla si está encendida), `aDesliza` (−1/+1
en las hojas del ascensor, que se abren con el uniforme `uAbre`). Ocho lámparas
en uniformes (`uLampPos`, `uLampOn`, `uLampCol`; 0–5 las del piso, 6 el
rellano, 7 la cabina). La luz del día entra por el plano de la fachada del
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

`andar(dt)` devuelve `true` mientras hay casa: mueve `walk.pos` con WASD (y
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
calidad media, 1280 × 800. Máquina compartida (carga 16–19 durante las pruebas).

| Medida | Resultado |
|---|---|
| Ocho encuadres fijos, base v0.10.16 → esta rama | **Idénticos**: 920.678 / 21, 790.042 / 17, 959.508 / 15, 1.014.414 / 21, 952.544 / 28, 802.440 / 17, 1.748.908 / 86, 1.532.854 / 42 (`/tmp/ramiverif/umbral_ab_ab.json`) |
| Fuera, en `stats().ext.umbral` | 0 mallas, 0 triángulos: nada del interior existe |
| Portales indexados | 3.052 de barrio (15–29 ms una vez, en `listo`) + los de parcela |
| Búsqueda del portal cercano (cada 0,1 s) | media 0,015 ms (carga 16) y 0,13 ms (carga 19, 3 muestras tras recargar); máximo 0,8 ms la primera. Repartida en los cuadros de 0,1 s: por debajo de 0,1 ms por cuadro |
| Construir el interior al entrar | 2–11 ms (un caso de 96 ms, la primera villa de la sesión) |
| Zaguán de torre | 1.574 triángulos, 7 mallas (con la cabina) |
| Planta (rellano + piso + cabina) | 3.520–4.160 triángulos, 7 mallas |
| Villa | 2.936 triángulos, 4 mallas |
| Nave | 2.224–2.260 triángulos, 3 mallas |
| Recepción del hotel | 2.124 triángulos, 6 mallas |
| Sala del concesionario (3 coches) | 3.056 triángulos, 6 mallas |
| Viaje del ascensor a la planta 4 | 10,5 s de pasos (puertas, entrar, subir, puertas, salir) |

Lo que cuesta de verdad estar dentro no es el interior sino **la ciudad que se
sigue dibujando detrás**: mirando a una pared del salón se envían 1.717.338
triángulos y 52 llamadas (la ciudad entera cae en el cono de visión), mirando
por la ventana 1.071.148 y 41, en el zaguán 804.014 y 24.

## Capturas (miradas una a una)

En `/tmp/ramiverif/`:

- `umbral_aviso.png` (ante la torre de Dubai Marina: «F · Entrar · Torre ·
  Dubai Marina»), `umbral_aviso_hotel.png` (el hotel en U, desde la boca del
  patio: «Hotel Palmera · @hotelero»).
- `umbral_zaguan.png` (buzones, escalera con pasamanos, ascensor al fondo),
  `umbral_buzones.png` (48 buzones numerados), `umbral_cabina.png` (dentro de la
  cabina, «Ascensor · planta 4 · 92 %»), `umbral_rellano.png` (la puerta del
  piso desde el rellano).
- `umbral_piso.png`, `umbral_dormitorio.png`: el piso amueblado.
- `umbral_ventana_dia.png` y `umbral_ventana_noche.png`: por la ventana de la
  planta 4 las torres de Dubai Marina, de día y con las ventanas encendidas de
  noche. `umbral_pared_dia.png` y `umbral_pared_noche.png`: mirando a la pared,
  no se ve nada a través.
- `umbral_lampara_apagada.png` / `umbral_lampara_encendida.png` (de noche, F).
- `umbral_mueble_movido.png` (el sofá seleccionado, movido y girado) y
  `umbral_mueble_recargado.png` (tras recargar la página y volver a entrar: el
  sofá en 9,24 / 5,5 con giro 0, igual que antes; `recuperado: true`).
- `umbral_fuera.png`: tras salir andando, delante del portal mirando a la calle.
- `umbral_hotel_recepcion.png`, `umbral_hotel_ventana.png`,
  `umbral_concesionario.png` (3 coches, uno por activo), `umbral_atico.png` y
  `umbral_atico_ventana.png` (el ático del dueño en la planta 52),
  `umbral_unidad.png` («Tu piso · unidad 3 · planta 4»), `umbral_villa.png`,
  `umbral_nave.png`.
- `umbral_ab_*.png`: los ocho encuadres fijos.

Comprobado además, sin captura: la unidad 1 de otra vecina en venta sale como
«Piso de muestra · planta 3 / Unidad 1 · @vecina / Unidad en venta: 25 RAMI»;
el clic en la puerta del hotel entra andando; Escape en un piso deja al jugador
fuera; `setMode('orbit')` dentro lo saca (`dentro: false`); por el patio de un
bloque en L/U el recorrido cruza el patio y entra (66 pasos de 0,1 s); cero
errores de consola y `extFallos()` vacío en todas las pasadas.

## Lo público (`handle.ext.umbral`)

`entrar({ id, inmediato, planta })`, `salir(andando)`, `estado()`,
`portalCercano()`, `buscar()`, `portales(x, z, r, filtro)`, `total()`,
`irAPlanta(n, inmediato)` (0 = zaguán), `colocar(x, z, yawLocal, pitch)`,
`mirar('ventana'|'pared'|'salon'|'dormitorio'|'lampara'|'buzones'|'ascensor'|
'salida'|'zaguan'|'recepcion'|'coches')`, `accion()` (la F), `luz(i, on)`,
`seleccionar(id)`, `mover(adelante, derecha)`, `girar()`, `restaurar()`,
`medidas()`, `diagnostico()`. En `stats().ext.umbral`: portales, dentro,
espacio, mallas, triángulos y los tiempos de búsqueda, índice y construcción.

## Lo que queda

- **Arrastrar muebles con el ratón** no está: en modo a pie el arrastre gira la
  vista en el núcleo y el gancho `clic` solo recibe clics sin arrastre. Se
  mueven con las flechas en rejilla de 0,25 m.
- **VR**: el gancho `vr(true)` saca al jugador delante del portal y coloca el
  `rig`; no probado con gafas (el entorno no tiene WebXR). Dentro de VR no se
  puede entrar (el aviso no aparece).
- **Sonido**: probado con un servicio falso; el módulo `extras` de esta rama
  aún no pone `servicios.sonido`, así que con él de verdad no se ha oído.
- **La ciudad sigue dibujándose entera detrás del interior** (ver cifras): dejar
  de enviar lo que no cae en una ventana está por hacer.
- **Unidades**: el contrato `units = [{ n, owner, handle, sale }]` con n desde 1
  se ha probado con una ciudad sintética; hoy el nodo no lo manda y el código
  funciona igual (todo son pisos de muestra o el ático del dueño).
- 145 torres y bloques no tienen ninguna planta con la fachada libre (su cuerpo
  alto queda tapado por delante en todas las alturas): se entra a una casa en
  planta baja, sin ascensor.
- El portal por fuera sigue siendo el del catálogo (vidriera, puerta y
  marquesina): desde dentro del zaguán la puerta se ve cerrada (la cara interior
  de la caja de la puerta), y la vidriera como cristal esmerilado.
