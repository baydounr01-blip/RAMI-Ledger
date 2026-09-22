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
  precio de una parcela libre del distrito en RAMI; un clic lleva a la celda).
  Antes de la activación de Dubái la tarjeta lo explica y da la cuenta atrás
  (`dubai_faltan_segundos`).
- **El día uno.** Guía «📖 Primeros pasos» en el visor, seis pasos con casilla y
  barra de progreso, abierta la primera vez; se cierra con ✕ y se reabre con el
  botón de la barrita: mirar la ciudad, bajar a pie, entrar en un edificio,
  crear el nombre único, conseguir RAMI de prueba (botones a «Minar» y
  «Recibir»), y lo que llega (Dubái el 1 de diciembre de 2026 y la escritura de
  vivienda el 1 de marzo de 2027, con cuenta atrás al minuto). Debajo, «Por qué
  vuelves mañana»: cuántos encargos hay hoy, la hora real de Dubái y el nivel de
  pátina de tu edificio con los días de cadena que faltan para el siguiente.
- **El aviso.** Una línea fija justo encima del mapa, la misma para 2D y 3D:
  «⚠️ Simulación en una red de pruebas: RAMI no tiene valor monetario, no se
  vende y no es una inversión», con enlace a `NOTICE.md`. La guía la repite al
  pie.
- **El léxico.** `lexico.py` rechaza además la zona de inversión en los cinco
  idiomas y los símbolos de moneda junto a un precio, y mira también los textos
  del visor 3D (`t('…')` de `city3d.js` y `city/*.js`) y los fragmentos
  `i18n-src/frag_*.json`.

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
  de `huecos` (comprobado: 13 huecos, iguales uno a uno). Las etiquetas van en
  un `LabelSet` sobre el centroide de las empresas afectadas de cada distrito.
  **No se registran con `ctx.etiquetas`**: el núcleo recorta los conjuntos de
  los módulos los últimos y en la vista de la ciudad los rótulos de barrio, que
  caen en los mismos distritos, los tapaban todos (primera captura). Se
  recortan solo entre sí en `cuadro` y se dibujan encima (`renderOrder` 51);
  el botón 📋 los quita y lo recuerda en `localStorage`.
- **La guía** (`PASOS`, `pintaGuia`, `marca`, `cadaSegundo`). Progreso en
  `localStorage['rami.memoria.guia'] = { h: { paso: 1 }, c: cerrada }`, con
  try/catch: sin almacenamiento, dura la sesión. Qué marca cada paso solo:
  «mirar», un arrastre de más de 40 px o la rueda sobre el lienzo en órbita;
  «a pie», el gancho `modo('walk')`; «entrar», `handle.ext.umbral.estado().dentro`
  cada segundo si el módulo «umbral» lo publica (si no, la casilla a mano; no
  bloquea nada); «nombre» y «RAMI», lo que el panel cuenta con
  `handle.ext.memoria.jugador({ perfil, saldo })` cada 2,5 s; «lo que llega»,
  el botón «Entendido». Cada segundo solo se repintan la cuenta atrás y la hora
  (repintar la guía entera se comería un clic). Las fechas salen de
  `dubai_desde` y `vivienda_desde` de `/api/city`, y si no vienen, de las del
  plan (1796083200 y 1803859200).
- **El panel** (`dashboard.html`): la línea `#cyAviso` encima de `#city3d`, la
  tarjeta `#cityEncargos` antes de la Plaza, `renderEncargos()` en `loadCity`,
  la opción `irA(destino)` de `mount` (`'minar'`, `'recibir'`, `'perfil'`) y
  `avisaMemoria()` en el sondeo de la ciudad. `renderCityPanel` no se toca.
- **Traducciones**: `chain/crates/rami-gui/i18n-src/frag_memoria.json`, 44
  cadenas nuevas en inglés, chino, ruso y suajili. Las frases con cifras llevan
  marcadores (`{n}`, `{d}`, `{t}`, `{h}`) y se traducen enteras.
- **El léxico** (`INVERSION`, `NEGACION`, `negado`, `buscar_inversion`,
  `MONEDA`, `buscar_moneda`, `literales_t`). La excepción de la negación es
  explícita: el término vale si en su misma cláusula (sin cruzar `, ; : . ! ?`)
  lo precede a seis palabras como mucho (doce caracteres en chino) una negación
  de la lista del idioma. En Markdown la negación puede quedar al final de la
  línea anterior (`README.md:529–530`). «returns» solo cuenta en sentido
  financiero («returns on», «high returns»…): el inglés de las notas lo usa como
  verbo («the road returns to the lane»). Las autopruebas del final de `main`
  comprueban que muerden la afirmación y el símbolo, y que no muerden la
  negación ni el verbo.

## Cifras medidas

Panel real (binario base v0.10.16 + proxy de esta rama), Chromium con
SwiftShader, calidad media, 1280 × 800.

| Prueba | Resultado |
|---|---|
| A/B, ocho encuadres fijos (ciudad real, sin parcelas) | Idénticos a la referencia v0.10.16 en triángulos y llamadas: 920.678/21, 790.042/17, 959.508/15, 1.014.414/21, 952.544/28, 802.440/17, 1.748.908/86, 1.532.854/42 |
| Placa, a pie a 3,2 m (ciudad sintética) | +192 triángulos y +1 llamada (862.562/21 → 862.754/22); de lejos, 0 placas y nada enviado |
| Etiquetas de encargos, vista de la ciudad | +8 triángulos y +1 llamada (1.799.386/55 → 1.799.394/56) |
| Pátina | Cero triángulos y cero llamadas: es el color de vértice que ya se escribía |
| Ciudad sintética: 8 parcelas en 5 distritos | 13 huecos → 22 encargos en 4 distritos; suma por distritos = `huecos`; niveles de pátina 12, 0, 3, 3, 5, 1, 7, 2, los esperados por `since` |
| Guía | «A pie» desde su botón marca el paso 2; ✕ cierra y el botón reabre; la casilla del paso 6 marca; `jugador({ perfil: true, saldo: 12,5 })` marca 4 y 5; tras recargar, `localStorage` conserva `{a_pie, nombre, rami}` |
| Errores de consola | 0 en las seis sesiones (ciudad real, tres sintéticas, A/B y la de humo final con todos los módulos) |
| `node --check`, `check.py`, `lexico.py` | En verde; `lexico.py` falla (salida 1) con «Tu parcela tendrá una gran revalorización.» puesta en la tarjeta |

## Capturas

- `/tmp/ramiverif/memoria_placa_a_pie.png` — la placa de «Banco del Zoco»,
  «Bloque #42.635», `@rami_dxb`, junto a la vidriera, a 3,2 m.
- `/tmp/ramiverif/memoria_placa_portal_14m.png` — la misma a 14 m: un rectángulo
  junto al portal.
- `/tmp/ramiverif/memoria_patina_lado_a_lado.png` — las dos torres de banco:
  la de fondo (nivel 12, 144 días) más apagada y verdosa; la de delante nueva.
- `/tmp/ramiverif/memoria_patina_nueva_antes.png` y `…_despues.png` — el mismo
  edificio con 0 y 144 días de cadena: el turquesa pasa a un verde gris.
- `/tmp/ramiverif/memoria_encargos_3d_ciudad.png` — Deira, Downtown y Al
  Barsha con sus encargos en la vista de la ciudad.
- `/tmp/ramiverif/memoria_tarjeta_encargos.png` — la tarjeta con los 22 encargos.
- `/tmp/ramiverif/memoria_guia_3d.png` — la guía abierta la primera vez.
- `/tmp/ramiverif/memoria_aviso_2d_pagina.png` — el aviso encima del mapa 2D y
  la tarjeta antes de Dubái con la cuenta atrás.

## Lo que queda

1. **«Entrar en un edificio» no se ha probado con el módulo «umbral» real**: en
   esta rama es el esqueleto. La guía lee `handle.ext.umbral.estado().dentro`,
   que es lo que publica la rama `feat/umbral` hoy; si cambia de nombre, el paso
   se marca a mano.
2. **La placa queda donde el relieve la pone**: delante de algunos portales el
   relieve está por encima de la planta baja del edificio (1,3 m en la celda de
   prueba), y la puerta queda medio enterrada. Viene del núcleo (la planta baja
   es `cellH + 0,5`), no de la placa.
3. **Las etiquetas de encargos se montan sobre los rótulos de barrio** en la
   vista de la ciudad, porque se dibujan siempre que 📋 está encendido.
4. **El mentor de la ficha de la parcela** (`renderMentor`, junto a
   `renderCityPanel`, que no era de este frente) dice «Un proveedor gana con la
   demanda propia…» y «La recuperación es el capital dividido por el ingreso
   total por bloque»: lenguaje de retorno de capital que `lexico.py` no rechaza
   (no son sus términos) y que conviene reescribir en la fusión.
5. Las fechas de la guía van con el formato del navegador (`toLocaleDateString`).
