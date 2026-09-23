# v0.11.0 — frente «memoria» (secciones 6 a 8 del plan del metaverso)

La ciudad que recuerda (placa y pátina), los encargos de la economía, el día uno
de un jugador nuevo, el aviso de `NOTICE.md` siempre a la vista y la zona de
inversión en `tools/panel/lexico.py`. **No toca el consenso, la red, el nodo ni
el formato de los ficheros.**

## Qué se hizo

- **La placa.** Cada edificio de parcela lleva junto al portal, a 1,5 m del
  suelo que pisa quien la lee, una placa de latón de 1,1 × 0,55 m con
  «Bloque #<since>», el nombre de la empresa y, si el dueño tiene perfil,
  `@nombre`. A pie se lee a tres metros; a más de 70 m no existe.
- **La pátina.** El color del cuerpo de cada edificio de parcela se templa y se
  apaga con los días de cadena transcurridos desde `since` (`S.city.height −
  since`, 1.440 bloques por día): nivel 1 el día 1, nivel 2 el día 4, nivel 3
  el día 9… y el tope, nivel 12, el día 144. Se nota la primera semana y no se
  ensucia nunca.
- **Los encargos.** Los `huecos` de `/api/city` (lo que nadie ofrece y cuántas
  empresas lo importan) repartidos por el distrito de las empresas que lo
  necesitan: etiquetas naranjas sobre los distritos en 3D, con un botón
  «📋 Encargos (n)» en la barrita del módulo, y una tarjeta «📋 Encargos» en la
  pestaña de la ciudad (sector que falta, distrito, empresas que lo necesitan,
  precio de una parcela libre del distrito en RAMI; un clic abre la ficha de una
  empresa del distrito que lo necesita).
  Antes de la activación de Dubái la tarjeta lo explica y da la cuenta atrás
  (`dubai_faltan_segundos`).
- **El día uno.** Guía «📖 Primeros pasos» en el visor, seis pasos con casilla y
  barra de progreso. La primera vez se abre sola si el visor mide 760 px o más;
  en uno más estrecho (el del panel a 1280 × 800 mide 644 px) el botón 📖 se
  resalta en verde hasta que se abre. Se cierra con ✕ y se reabre con el botón
  de la barrita: mirar la ciudad, bajar a pie, entrar en un edificio,
  crear el nombre único, conseguir RAMI de prueba (botones a «Minar» y
  «Recibir»), y lo que llega (Dubái el 1 de diciembre de 2026 y la escritura de
  vivienda el 1 de marzo de 2027, con cuenta atrás al minuto). Debajo, «Por qué
  vuelves mañana»: cuántos encargos hay hoy, la hora real de Dubái (y a qué hora
  está fijada la luz si se eligió otra en el selector) y el nivel de pátina de
  tu edificio con los días de cadena que faltan para el siguiente.
- **El aviso.** Una línea fija justo encima del mapa, la misma para 2D y 3D:
  «⚠️ Simulación en una red de pruebas: RAMI no tiene valor monetario, no se
  vende y no es una inversión», con enlace a `NOTICE.md`. La guía la repite al
  pie.
- **El léxico.** `lexico.py` rechaza además la zona de inversión en los cinco
  idiomas (también el vocabulario del retorno del capital: flujo de caja,
  capital de entrada, recuperación del capital, payback, 回本, окупаемость,
  urejeshaji…) y los símbolos de moneda junto a un precio, y mira también los
  textos del visor 3D (`t('…')` de `city3d.js` y `city/*.js`) y los fragmentos
  `i18n-src/frag_*.json`.
- **El mentor de la ciudad** (`LESSONS`, `evalLine`, `mentorAnswer`,
  `renderMentor` en `dashboard.html`, fuera de `renderCityPanel`) deja de hablar
  de capital y de recuperación: «1 · Lo que cuesta la parcela», «5 · El reparto
  por bloque», «un proveedor recibe su parte del reparto», «en esta parcela
  recibe del reparto X RAMI/bloque», «La parcela cuesta X RAMI (se quema)».
  Desaparece el dato `bloques_recuperacion` de la pantalla (el nodo lo sigue
  sirviendo). El README cambia la frase equivalente del mentor.

## Cómo está hecho, para quien lo toque después

- **Todo el código nuevo del visor está en `city/memoria.js`.** Del núcleo
  (`city3d.js`) solo cambia la línea del color del edificio de parcela en
  `applyCity`: si hay `ctx.servicios.patina`, el color sRGB del cuerpo
  (`TP0`) pasa por ella con `d.height` y `pc.since` (las parcelas pendientes no).
  Se eligió la línea del color y no un atributo o uniforme porque `applyCity`
  ya rehace las mallas de las parcelas con cada ciudad nueva, y la altura
  cambia con cada bloque: no hay nada que mantener aparte y ningún sombreador
  cambia.
- **`nivelPatina(altura, desde)`** es entera: días = `floor(edad / 1440)`, nivel
  = el mayor `n ≤ 12` con `n² ≤ días`. Dos máquinas en la misma cabeza deducen
  el mismo nivel. **`patina(altura, desde, rgb)`** es el fenotipo: con
  `k = nivel / 12`, hasta un 28 % hacia el gris de su propia luminancia, rojo
  +2 %, verde −4 %, azul −12 % y un 10 % menos de luz. Tabla con el azul de
  referencia (0,25; 0,55; 0,95):

  | Días de cadena | Nivel | Color |
  |---|---|---|
  | 0 | 0 | 0,250 0,550 0,950 |
  | 1 | 1 | 0,254 0,543 0,923 |
  | 9 | 3 | 0,263 0,529 0,870 |
  | 36 | 6 | 0,275 0,508 0,794 |
  | 81 | 9 | 0,287 0,487 0,723 |
  | 144 o más | 12 | 0,298 0,467 0,656 |

- **La placa** (`calculaPlacas`, `actualizaPlacas`, `pintaPlaca`,
  `escribeHueco`). Con cada ciudad se deduce dónde va cada placa llamando a
  `ctx.geom.parcelaPartes` con los mismos sorteos que `applyCity` (canales 13,
  14 y 2) y buscando en las piezas la vidriera del portal (`sy 4,4 × sz 0,4`):
  la placa va a su derecha, a 30 cm. Las naves no tienen vidriera: va a la
  izquierda de la puerta de la oficina (`2 × 2,6 × 0,5`). La de «seguridad» va
  en la valla, que taparía el portal. La cota es `max(planta baja,
  groundH(x, z)) + 1,5 m`: delante del portal el relieve puede quedar por
  encima de la planta baja (en la prueba, 1,3 m). Se dibujan en **una malla**
  con 16 huecos (un atlas `canvas` de 2048 × 1024, 512 × 256 por placa,
  `MeshLambertMaterial` con el atlas también de emisivo al 23 % para que de
  noche se lea algo). Cada 0,25 s los huecos se reparten entre las placas a
  menos de 70 m de la cámara; una placa que sigue cerca conserva su hueco y
  solo se repinta el hueco que cambia. Sin placa cerca, la malla no se envía.
- **Los encargos** (`encargos(d)`, y su espejo `encargosDe(d)` en
  `dashboard.html`). Una empresa necesita el hueco `h` si `h` está entre los
  insumos de su sector; se cuenta en el `distrito` que el nodo pone en cada
  parcela. Como el consenso no cuenta la propia parcela como proveedora y ningún
  sector es insumo de sí mismo, la suma por distritos de cada hueco es la cifra
  de `huecos` (comprobado: 14 huecos, iguales uno a uno). Cada distrito se
  ancla en **una de sus empresas afectadas**, la más cercana a su centroide (a
  igualdad, menor y, luego menor x): el centroide redondeado caía en celdas
  libres o en otro distrito, y el clic de la tarjeta abría la ficha de una
  parcela libre. Las etiquetas van en un `LabelSet` **registrado con
  `ctx.etiquetas`**, como manda el contrato: el núcleo las recorta después de
  sus rótulos y la que chocaría con uno no se dibuja (ya no se montan encima).
  Para que choquen poco van a 0,9 celdas de altura (585 m, tope 700; los
  rótulos del núcleo van a 8 m del suelo) con un texto corto (el primer insumo
  y «+n»); medido en la vista de la ciudad: a 0,3 celdas no pasaba ninguna, a
  0,9 pasa la de Downtown sin tocar ningún rótulo. La lista entera está en la
  tarjeta. El botón 📋 las quita y lo recuerda en `localStorage`.
- **La guía** (`PASOS`, `pintaGuia`, `refrescaGuia`, `marca`, `cadaSegundo`).
  Progreso en `localStorage['rami.memoria.guia'] = { h: { paso: 1 }, c: cerrada,
  v: vista }`, con
  try/catch: sin almacenamiento, dura la sesión. Qué marca cada paso solo:
  «mirar», un arrastre de más de 40 px o la rueda sobre el lienzo en órbita;
  «a pie», el gancho `modo('walk')`; «entrar», `handle.ext.umbral.estado().dentro`
  cada segundo si el módulo «umbral» lo publica (si no, la casilla a mano; no
  bloquea nada); «nombre» y «RAMI», lo que el panel cuenta con
  `handle.ext.memoria.jugador({ perfil, saldo })` cada 2,5 s; «lo que llega»,
  el botón «Entendido». Cada segundo de reloj de pared (no de `dt`, que el
  núcleo recorta a 0,1 s y con dibujo por software tardaría medio minuto) y con
  cada ciudad nueva solo se repintan las partes vivas (`refrescaGuia`: fechas,
  cuenta atrás, hora, encargos, pátina); repintar la guía entera se comería un
  clic o el foco de una casilla. **El gancho `ciudad`** rehace placas y
  etiquetas solo si cambia su firma (`firmaCiudad`: parcelas con sitio, sector,
  fundación, nombres y dueño; huecos; distritos; `me`): antes de Dubái
  `/api/city` cambia en cada sondeo por la cuenta atrás y todo se rehacía cada
  ~5 s. La fecha de Dubái es `dubai_desde` de `/api/city`; con datos y sin
  `dubai_desde` (regtest sin `--dubai-desde`) la guía dice lo mismo que la
  tarjeta, «Esta red no tiene fecha de activación de Dubái»; solo sin datos
  todavía usa la del plan (1796083200). La de vivienda, `vivienda_desde` si
  viene y si no la del plan (1803859200). La hora real de Dubái sale del reloj
  (UTC+4), no de `M.dubaiHour()`, que devuelve la hora fijada con el selector.
  El ancho es `62 %` con `max-width: 300px` (sin `min()`, que los webviews
  viejos no entienden).
- **El panel** (`dashboard.html`): la línea `#cyAviso` encima de `#city3d`, la
  tarjeta `#cityEncargos` antes de la Plaza, `renderEncargos()` en `loadCity`,
  la opción `irA(destino)` de `mount` (`'minar'`, `'recibir'`, `'perfil'`) y
  `avisaMemoria()` en el sondeo de la ciudad. `renderCityPanel` no se toca.
- **Traducciones**: `chain/crates/rami-gui/i18n-src/frag_memoria.json`, 58
  cadenas nuevas en inglés, chino, ruso y suajili (las 44 de la primera entrega
  menos una reescrita, y 15 de esta ronda: el mentor, las fechas, la hora fijada,
  «🏷️ En venta» de la leyenda). Las frases con cifras llevan
  marcadores (`{n}`, `{d}`, `{t}`, `{h}`) y se traducen enteras.
- **El léxico** (`INVERSION`, `NIEGA`, `NEGADO`, `negado`, `buscar_inversion`,
  `MONEDA`, `buscar_moneda`, `literales_t`, `fuentes_cliente`, `viva`). La
  excepción de la negación es explícita y estrecha: el término vale solo si lo
  niega una construcción de `NIEGA` **pegada a él** («no es (una)», «ni
  promete», «sin», «is not (an)», «nor does it promise», «не является», «не»,
  «不是», «没有», «si», «wala»…), con como mucho un artículo en medio o el primer
  miembro de una enumeración negada («no mide acierto ni rentabilidad», «si
  uwekezaji wala faida», «不衡量命中率或收益»). Una negación suelta más atrás no
  vale: «No te pierdas esta oportunidad de inversión», «¿Por qué no invertir en
  Dubái?», «Sin comisiones y con rentabilidad garantizada», «Don't miss this
  investment opportunity», «No fees and great returns on your parcel»,
  «不要错过升值机会» y «Не упустите доходность» se rechazan (autopruebas). En
  Markdown la negación puede quedar al final de la línea anterior
  (`README.md:529–530`) y el marcado (`**`, `>`) no la separa. **Las
  traducciones retiradas**: una entrada de `lang_*.json` con léxico de la zona
  cuya clave ya no pide ninguna fuente (literal `"…"`/`'…'` o texto `>…<` en
  `chain/crates/**/*.{rs,js,html}` salvo `i18n.js`) se avisa y no se rechaza:
  así un frente reescribe un texto sin tocar los diccionarios compartidos; el
  integrador poda la clave. Un `frag_*.json` con otra forma da un diagnóstico y
  salida 1, no una traza. «returns» solo cuenta en sentido
  financiero («returns on», «high returns»…): el inglés de las notas lo usa como
  verbo («the road returns to the lane»). Las autopruebas del final de `main`
  comprueban que muerden la afirmación y el símbolo, y que no muerden la
  negación ni el verbo.

## Cifras medidas

Panel real (binario base v0.10.16 + proxy de esta rama), Chromium con
SwiftShader, calidad media, 1280 × 800 salvo donde se dice.

| Prueba | Resultado |
|---|---|
| A/B, ocho encuadres fijos (ciudad real, sin parcelas), repetido en la ronda 1 | Idénticos a la referencia v0.10.16 en triángulos y llamadas: 920.678/21, 790.042/17, 959.508/15, 1.014.414/21, 952.544/28, 802.440/17, 1.748.908/86, 1.532.854/42 (`/tmp/ramiverif/memoria_r1_ab.json`) |
| Placa, a pie a 3,2 m (ciudad sintética) | +192 triángulos y +1 llamada (862.562/21 → 862.754/22); de lejos, 0 placas y nada enviado. Ronda 1: 1 placa visible, 192 triángulos, guía cerrada |
| Etiquetas de encargos, vista de la ciudad (ronda 1, con `ctx.etiquetas`) | +12 triángulos y +1 llamada (1.827.638/49 → 1.827.650/50); de 6 etiquetas pasa el recorte 1 (Downtown), sin tocar ningún rótulo |
| Etiquetas de encargos, órbita sobre cada distrito a 900 y 2.500 m (a 0,3 celdas de altura) | Pasaban 0 de 6 en Downtown y DIFC; a 0,9 celdas pasa la de Downtown a 900 y 2.500 m |
| Pátina | Cero triángulos y cero llamadas: es el color de vértice que ya se escribía |
| Ciudad sintética de la ronda 1: 10 parcelas en 6 distritos (dos en Downtown, en (45,17) y (47,17)) | 14 huecos → 24 encargos en 6 distritos; suma por distritos = `huecos`; las 6 anclas son empresas del distrito; el clic en las filas de Downtown abre la ficha de (45,17), «Empresa 0 · Hotel» |
| Sondeo de la ciudad antes de Dubái con la guía abierta, 12 s | La casilla y el título de la guía son los mismos nodos del DOM antes y después (no se repinta entera); la cuenta atrás avanza |
| Hora fijada | Con `setTimeOfDay(11)` la guía dice «En Dubái son las 16:17; la luz de la escena está fijada a las 11:00…»; con la hora real, «ahora son las 16:07» (el reloj de UTC+4 marcaba 16:07) |
| Sin `dubai_desde` (respuesta de `/api/city` con `null`) | La guía y la tarjeta dicen lo mismo: «Esta red no tiene fecha de activación de Dubái (regtest sin --dubai-desde).» |
| Guía la primera vez | Visor de 644 px (ventana de 1280): cerrada y 📖 resaltado; al abrirla, 300 px (47 %). Visor de 764 px (ventana de 1700): se abre sola, 300 px (39 %) |
| Mentor con `/api/city/mentor` simulado (Dubái en vigor) | «… · parcel 250 RAMI (burned)», «… en esta parcela recibe del reparto 0,4 RAMI/block …», «La parcela cuesta 250 RAMI»; ni «entrada» ni «recuperación» |
| `lexico.py` | Salida 0. Las siete frases del revisor se rechazan; «Tu parcela tendrá una gran revalorización.» en la tarjeta: salida 1; un valor de `lang_en.json` con clave viva cambiado a «…great returns on your capital»: salida 1; `frag_x.json` = `{"a": "b"}`: diagnóstico y salida 1, sin traza. Avisa de 4 traducciones retiradas (las claves viejas del mentor) |
| Errores de consola | 0 en todas las sesiones de la ronda 1 (ciudad real, sintética, sin fecha, exploración de etiquetas y A/B), con los cinco módulos cargados y `extFallos()` vacío |
| `node --check`, `check.py`, `lexico.py` | En verde |

## Capturas

Primera entrega:

- `/tmp/ramiverif/memoria_placa_a_pie.png` — la placa de «Banco del Zoco»,
  «Bloque #42.635», `@rami_dxb`, junto a la vidriera, a 3,2 m.
- `/tmp/ramiverif/memoria_placa_portal_14m.png` — la misma a 14 m: un rectángulo
  junto al portal.
- `/tmp/ramiverif/memoria_patina_lado_a_lado.png` — las dos torres de banco:
  la de fondo (nivel 12, 144 días) más apagada y verdosa; la de delante nueva.
- `/tmp/ramiverif/memoria_patina_nueva_antes.png` y `…_despues.png` — el mismo
  edificio con 0 y 144 días de cadena: el turquesa pasa a un verde gris.
- `/tmp/ramiverif/memoria_aviso_3d_pagina.png` — el aviso encima del lienzo 3D y
  la tarjeta antes de Dubái con la cuenta atrás.

Ronda de corrección 1:

- `/tmp/ramiverif/memoria_r1_encargos_ciudad.png` — vista de la ciudad: la
  etiqueta «📋 Downtown Dubái: falta Security ×2, +4» en un hueco libre, sin
  montarse sobre ningún rótulo.
- `/tmp/ramiverif/memoria_r1_explora_skyline_09.png` — lo mismo sin selección.
- `/tmp/ramiverif/memoria_r1_encargos_marina_900.png` — Dubai Marina a 900 m.
- `/tmp/ramiverif/memoria_r1_tarjeta.png` — la tarjeta de encargos con precios
  en RAMI.
- `/tmp/ramiverif/memoria_r1_tarjeta_sin_fecha.png` — la tarjeta sin
  `dubai_desde`.
- `/tmp/ramiverif/memoria_r1_guia_abierta_real.png` — la guía abierta a mano en
  el visor de 644 px: 300 px.
- `/tmp/ramiverif/memoria_r1_guia_abierta_sin_fecha.png` — la guía abierta sola
  en el visor de 764 px.
- `/tmp/ramiverif/memoria_r1_placa_a_pie.png` — «Block #112.000 / Empresa 1 ·
  Banco / @memoria_dxb» a 3,2 m, con la guía cerrada (estado por defecto).
- `/tmp/ramiverif/memoria_r1_mentor.png` — las lecciones nuevas del mentor.
- `/tmp/ramiverif/memoria_r1_aviso_2d.png` — el aviso en la vista 2D.

## Ronda de corrección 1 (revisión adversarial)

1. **Negación del léxico demasiado amplia** → `NIEGA`/`NEGADO`: solo la
   negación pegada al término (arriba, «El léxico»).
2. **Lenguaje de retorno del capital en el mentor** → reescrito (LESSONS 1, 4 y
   5, `evalLine`, `mentorAnswer`, el marcador de la pregunta y la ayuda) y
   `lexico.py` conoce ahora flujo de caja, capital de entrada, recuperación del
   capital, «cuánto gano», payback, cash flow, earnings, yield financiero, 回本,
   现金流, 赚, окупаемость, денежный поток, заработать, urejeshaji, kurejesha
   mtaji, mtiririko wa fedha. README: la frase del mentor.
3. **Hora forzada** → la hora real sale del reloj; si la luz está fijada, lo dice.
4. **Clic en la tarjeta a una celda libre** → ancla en una empresa del distrito.
5. **El gancho `ciudad` lo rehacía todo cada sondeo** → `firmaCiudad` y
   `refrescaGuia`.
6. **Etiquetas fuera de `ctx.etiquetas`** → registradas; más altas y más cortas.
7. **La guía tapaba el visor y usaba `min()`** → 62 % / 300 px, sin `min()`, y
   no se abre sola en un visor de menos de 760 px.
8. **Guía y tarjeta contradictorias sin `dubai_desde`** → el mismo texto.
9. **💰 junto a los precios y «faltan» → «missing»** → la leyenda del panel pasa
   a «🏷️ En venta» y la tarjeta usa una frase entera, «Dubái se activa el {f};
   quedan {t}.». Los otros cuatro 💰 de la ciudad no son de este frente (ver
   «Lo que queda»).
10. **«Los encargos cambian con cada bloque»** → «cambian cuando se funda una
    empresa o una cambia de sector» (`ciudad::huecos` solo depende de las
    parcelas; `SetParcel` sobre una parcela propia cambia el sector).
11. **`frag_*.json` con otra forma rompía el CI** → diagnóstico.

## Lo que queda

1. **«Entrar en un edificio» no se ha probado con el módulo «umbral» real**: en
   esta rama es el esqueleto. La guía lee `handle.ext.umbral.estado().dentro`,
   que es lo que publica la rama `feat/umbral` hoy; si cambia de nombre, el paso
   se marca a mano.
2. **La placa queda donde el relieve la pone**: delante de algunos portales el
   relieve está por encima de la planta baja del edificio (1,3 m en la celda de
   prueba), y la puerta queda medio enterrada. Viene del núcleo (la planta baja
   es `cellH + 0,5`), no de la placa.
3. **Las etiquetas de encargos ceden ante los rótulos del núcleo**: en la vista
   de la ciudad de la prueba pasa 1 de 6 (Downtown); las demás se ven al
   acercarse a su distrito o en la tarjeta. Es el contrato de `ctx.etiquetas`.
4. **Para el integrador, fuera de este frente**: el 💰 junto al precio de venta
   sigue en `city3d.js` (carteles de venta de `applyCity`, línea ~2277, y el
   texto de la ficha 3D, ~3080) y en `renderCityPanel` (`dashboard.html`,
   «💰 En venta por…» y «· 💰 en venta por…»). No es un símbolo de moneda, pero
   asocia el precio a dinero: propuesta, «🏷️». Además, al fusionar hay que podar
   de `allkeys.json` y `lang_*.json` las cuatro claves retiradas del mentor
   («recuperación», «recuperación en» y los dos textos con «cuánto gano»), que
   `lexico.py` avisa y no rechaza; las lecciones 2, 3, 6, 7 y 8 del mentor nunca
   tuvieron traducción (las 1, 4 y 5 la tienen ahora en `frag_memoria.json`).
5. **La hora de la guía se actualiza con el primer cuadro después de cada
   segundo**: con el dibujo por software a 0,2 cuadros por segundo tarda hasta
   cinco segundos en reflejar un cambio del selector.
6. Las fechas de la guía van con el formato del navegador (`toLocaleDateString`).
