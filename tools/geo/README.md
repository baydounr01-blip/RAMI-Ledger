# Terreno abierto de Dubái (`tools/geo`)

Esta carpeta contiene el constructor del **dataset de terreno de Dubái** que usa
el monedero de escritorio RAMI-Chain (crate `rami-gui`) para dibujar la ciudad
en 3D. Todo el relieve se genera a partir de **datos abiertos**; no se usa ningún
dato de Google Maps / Google Earth ni de OpenStreetMap (ver "Qué NO se usa").
Las islas artificiales y los canales, que no existen en ningún dataset abierto de
elevación (SRTM es del año 2000), se **estampan a mano** como polígonos
aproximados (ver "Islas artificiales y canales dibujados a mano").

## Ficheros generados

| Fichero | Descripción |
|---|---|
| `chain/crates/rami-gui/src/geo/dubai.hgt.png` | Mapa de alturas: PNG **gris de 16 bits** (color type 0, sin entrelazado, muestras big-endian). Valor `v` → altura `h = v - 1000` metros. Fila 0 = NORTE, columna 0 = OESTE. El mar es `h <= 0` (el dataset incluye la batimetría del golfo, aquí entre 0 y -44 m, así que la línea de costa sale sola de los datos; ver "Límites del contrato"). |
| `chain/crates/rami-gui/src/geo/dubai.json` | Metadatos. Claves heredadas de Tenerife: `origin_px` (esquina superior izquierda del recorte en píxeles de tesela Web-Mercator a zoom 12, antes del downsample), `meters_per_pixel`, `offset`, `min_h`/`max_h`, `bbox`, `peak` (píxel más alto del recorte), `towns` (lugares) y `roads` (polilíneas `[lon,lat]`). Claves nuevas para el cliente 3D: `grid` (cuadrícula de parcelas), `landmarks` (hitos modelados uno a uno), `clusters` (skylines genéricos), `islands` y `water` (documentación de lo estampado a mano). Ver "Claves del JSON". |
| `tools/geo/preview.png` | Hillshade de 8 bits con el relieve exagerado ×3 (Dubái es casi plano), sólo para inspección visual (no lo usa la app). |

Conversión lat/lon → píxel de salida (la misma que usa el renderizador):

```
X = ((lon+180)/360 * 2^12 * 256 - origin_px.x) / downsample
Y = ((1 - ln(tan(lat) + 1/cos(lat)) / π) / 2 * 2^12 * 256 - origin_px.y) / downsample
worldX = X * meters_per_pixel ; worldZ = Y * meters_per_pixel (crece hacia el sur) ; worldY = h
```

### Límites del contrato (léase antes de consumir el dataset)

* **Suelo a -1000 m.** Con `offset = 1000` una muestra de 16 bits sin signo no
  puede representar profundidades por debajo de `h = -1000 m`; todo lo más hondo
  se recortaría a `v = 0`. En Dubái no ocurre: el golfo Pérsico dentro de la bbox
  no baja de -44 m, así que ningún píxel se recorta (el script lo cuenta e
  imprime). De todas formas **`min_h`/`max_h` se calculan sobre los valores ya
  codificados**, de modo que describen el PNG tal cual (`max_h` queda redondeado
  al metro).
* **`h == 0` es mar.** El contrato define mar como `h <= 0`, no `h < 0`. El
  relleno de batimetría deja en `0 m` exactos los píxeles enmascarados en zoom
  12 cuyo vecino grueso de zoom 10 es tierra (≥ 0): una franja fina pegada a la
  costa (≈ 180 píxeles exactos en el array final, ≈ 4,3 k con `v == 1000` en el
  PNG contando los que redondean a 0). Un renderizador que pruebe `h < 0`
  verá un anillo de 0 m alrededor de la costa; el de `rami-gui` debe usar
  `h <= 0`.
* **Tierra baja que SRTM deja en `h <= 0` ("charcas" y "lagos").** La llanura
  costera de Dubái está a 0-5 m y SRTM (error de ±3 m, sabkhas algo por debajo
  del nivel del mar) da a mucha tierra valores de **0 m exactos o negativos**
  (-1..-3 m) que por contrato serían mar. Sin corregirlo, la imagen final tenía
  ≈ 3 400 charcas de uno o dos píxeles y "lagos" de varios km² en pleno Meydan,
  Al Quoz, Barsha Heights o Zabeel (con "profundidades" de hasta -50 m heredadas
  de la interpolación del ETOPO1 grueso), y 38 de los 142 lugares/hitos/skylines
  del JSON caían en el agua. Por eso el constructor, **antes de estampar nada**,
  aplica dos reglas y las imprime:
  1. `raise_negative_land`: a zoom 12 el mar está enmascarado a `0.0` exactos,
     así que todo píxel **negativo** del mosaico crudo es una medida de tierra y
     se sube a `+1 m` (97,5 k píxeles nativos, 2,4 % de la imagen). Excepción:
     dentro de dos polígonos aproximados dibujados a mano (`HARBOURS`: puerto de
     Jebel Ali y Port Rashid) los negativos se respetan, porque ahí son dársenas
     dragadas reales que las teselas tampoco enmascaran (5 k píxeles).
  2. `reclassify_inland_water`: tras el relleno de batimetría, etiqueta las
     componentes 8-conexas de `h <= 0` y sube a `+1 m` **todas menos la mayor**
     (el mar abierto con lo que conecta con él: dársenas, boca del Creek):
     12,7 k componentes, 36 k píxeles nativos.

  El agua interior que sí interesa (Creek, Ras Al Khor, canales, lagos) se
  excava **después** a mano, así que estas reglas nunca la afectan. Resultado:
  en la imagen final quedan 48 masas de agua aparte del mar (las 7 dibujadas a
  mano, las dársenas de los dos puertos y restos de 1-2 píxeles en la costa), y
  los 19 lugares del JSON que siguen "en el agua" lo están porque sus
  coordenadas caen en agua dibujada a propósito (marina, canal de Business Bay,
  Creek, lago del Burj Khalifa) o justo fuera de la media luna de Palm Jumeirah
  (Atlantis The Royal). La costa puede quedar 1-2 px más adentro o más afuera
  que la real allí donde SRTM midió agua sin enmascarar o tierra a 0 m exactos.
* **La imagen no coincide exactamente con la bbox.** El recorte empieza en
  `origin_px = (floor(x0), floor(y0))` píxeles nativos de zoom 12 y mide
  `width*downsample × height*downsample` píxeles nativos, redondeado **hacia
  arriba** a múltiplo de `downsample`. Cubre la bbox del JSON completa (el
  script lo comprueba) con hasta `downsample` px nativos de sobra por el este y
  el sur; la esquina inferior derecha real está en lon 55.60009, lat 24.77957.
  Para convertir coordenadas hay que usar `origin_px`, nunca la bbox.
* **Las islas y los canales son aproximados.** Son polígonos dibujados a mano
  a partir de coordenadas redondeadas; la forma general es reconocible (tronco,
  frondas y media luna de las palmeras, elipse de The World...) pero ni las
  posiciones ni las medidas son las reales al metro. Están pensados para el
  render, no como referencia geográfica.

## Fuentes y licencias

### Elevación: Mapzen / AWS Terrain Tiles (formato *terrarium*)

* URL: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
* Codificación: `h = R*256 + G + B/256 - 32768` metros.
* Es un mosaico de fuentes públicas: **SRTM** (NASA), **GMTED2010** (USGS),
  **ETOPO1** (NOAA, batimetría) y otras. Los datos son de dominio público /
  licencias abiertas; el conjunto se distribuye a través del programa
  *AWS Open Data* con la atribución que exige Mapzen/Tilezen:
  *"Terrain: Mapzen/AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1 and other public
  sources)"*. Esa cadena (más la de Natural Earth) se guarda en `attribution`
  dentro del JSON, exactamente igual que en el dataset de Tenerife, y la app la
  muestra. Las islas y canales dibujados a mano no necesitan atribución; se
  documentan en `islands` / `water` y en este README.
* Detalle importante: a partir de zoom 11 las teselas *terrarium* enmascaran el
  mar a `0 m` exactos; la batimetría de ETOPO1 sólo aparece hasta zoom 10.
  Por eso el constructor descarga el terreno a **zoom 12** (≈ 34,6 m/px en
  Dubái) y además las teselas de **zoom 10**, que interpola bilinealmente y usa
  únicamente para rellenar los píxeles que en zoom 12 valen exactamente `0.0`
  (limitado a `<= 0`, nunca añade tierra). El resultado se reduce 2× por media
  de caja → ≈ 69,2 m/px.
* SRTM se tomó en febrero de 2000: **no contiene** Palm Jumeirah, Palm Jebel
  Ali, The World, Bluewaters, Deira Islands, Dubai Harbour, Maritime City, el
  Canal de Dubái ni la marina. Sí contiene el puerto de Jebel Ali, Port Rashid,
  el Creek natural (cortado en los puentes) y la isla del Burj Al Arab.

### Carreteras: Natural Earth 1:10m `ne_10m_roads` + trazados a mano

* URL: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson`
* Licencia: **dominio público** (Natural Earth no exige atribución, se incluye
  por cortesía). Se conservan sólo las (Multi)LineStrings con algún vértice
  dentro de la bbox de Dubái (12 tramos, tipo *Major Highway* o *Unknown*, sin
  nombre). Es una capa muy generalizada; sirve de referencia, no de callejero.
* A continuación de ellas, en el mismo array `roads` y con el mismo formato,
  van **9 polilíneas trazadas a mano** (`HAND_ROADS` en el script) con las
  grandes vías: E11 Sheikh Zayed Road, E311 Emirates Road, E44 Al Khail Road,
  D94 Jumeirah Road, Al Khaleej Road (corniche de Deira), Airport Road, E66
  Al Ain Road, E77 Al Qudra Road y el tronco de Palm Jumeirah. Son vértices
  aproximados, redondeados a 3 decimales; no proceden de ningún servicio.

### Lugares, hitos y skylines (`towns`, `landmarks`, `clusters`)

Listas curadas a mano en el propio script (52 lugares, 56 hitos y 34 skylines)
con coordenadas aproximadas del centro de cada elemento y medidas redondeadas
(alturas de los edificios de dominio público). No proceden de ningún servicio
de terceros.

## Islas artificiales y canales dibujados a mano

Como SRTM (2000) es anterior a las islas ganadas al mar, el constructor las
**estampa** sobre el mosaico nativo de zoom 12 (1 px ≈ 35 m) después del relleno
de batimetría y de la limpieza de tierra baja, y antes del downsample:

* **Islas**: mesetas de **+3,0 m**. Sólo se suben píxeles que en ese momento son
  mar (`h <= 0`); nunca se baja tierra existente, así que donde una isla toca la
  costa el terreno real se respeta.
* **Agua**: canales y lagunas se **excavan a -3,0 m** (el lago del Burj Khalifa
  a -2 m), sólo donde el terreno está más alto; nunca se ahonda el mar abierto.
  Se estampan **después** de las islas, de modo que un canal que cruza una isla
  la corta (p. ej. la salida norte del canal de la marina junto a Dubai Harbour).

Toda la geometría son **polígonos aproximados dibujados a mano**; no procede de
ningún dataset. Lo mismo vale para los dos recintos portuarios de `HARBOURS`
(puerto de Jebel Ali y Port Rashid), que no estampan nada: sólo delimitan dónde
se respetan como agua los valores negativos de SRTM (ver "Límites del
contrato"). La lista de lo estampado se guarda en el JSON, sólo como
documentación, en `islands` (`{name, kind}`) y `water` (`{name, kind}`). Los
cálculos se hacen en metros sobre la rejilla de píxeles Web-Mercator (proyección
conforme: los rumbos se conservan y la escala local sólo depende de la latitud,
que se toma en el centro de cada elemento) con ayudantes de punto-en-polígono,
distancia a segmento (franjas con extremos redondeados), rectángulo orientado,
elipse, disco y arco con huecos. Toda franja tiene una semianchura mínima de
0,75 px nativos (~26 m) para que no quede rota en la rejilla.

| Elemento | Tipo | Geometría aproximada |
|---|---|---|
| Palm Jumeirah | `palm` | Tronco 2,0 × 0,55 km desde la orilla (25.1005, 55.1525) rumbo 320°; 8 pares de frondas rectas de 1,5 km × 110 m que salen de los lados del tronco cada 220 m a partir de 350 m de la base, con dirección = eje del tronco girado ±115° (apuntan hacia atrás, a la orilla, como las hojas de una palmera); media luna = arco de radio 2,85 km centrado en (25.112, 55.137), 250 m de ancho, de rumbo 230° por el noroeste hasta 55°, con dos huecos de 250 m en los rumbos 260° y 10°. El ápice del arco (Atlantis, 25.1304, 55.1171) queda en tierra (comprobado). |
| Palm Jebel Ali | `palm` | La misma generatriz escalada ×1,6: tronco 3,2 × 0,9 km desde (24.992, 55.033) rumbo 315°, frondas de 2,4 km × 176 m cada 352 m a partir de 560 m; media luna de radio 4,6 km centrada en (25.005, 54.990), 350 m de ancho, de 240° a 50°, con dos huecos de 400 m en los rumbos 270° y 20° (las mismas posiciones relativas del arco que en Jumeirah). |
| Bluewaters Island | `island` | Círculo r = 450 m en (25.0790, 55.1211) más una pasarela de 60 m de ancho desde el centro de la isla hasta la orilla en (25.0755, 55.1275) (≈ 750 m; la parte dentro del círculo es redundante). |
| The World | `archipelago` | Dentro de una elipse centrada en (25.2230, 55.1700) de semiejes 4,3 km (E-O) × 3,0 km (N-S), 240 islotes circulares de radio 60–130 m colocados con un generador congruencial lineal determinista (semilla 20250901), sin solapes (separación mínima 60 m) y a ≥ 350 m del borde; más un rompeolas de 80 m de ancho sobre el borde de la elipse con 6 huecos de 300 m repartidos por longitud de arco. Siempre sale idéntico. |
| Deira Islands | `island` | Polígono (25.2880, 55.2900) → (25.3060, 55.2960) → (25.3130, 55.3180) → (25.3020, 55.3320) → (25.2900, 55.3220) → (25.2850, 55.3060). |
| Jumeirah Bay Island | `island` | Elipse de 620 × 380 m en (25.2130, 55.2430) con el eje mayor a rumbo 30° (misma convención `rot` que los hitos: grados horarios desde el norte), más pasarela de 60 m hasta la orilla en (25.2075, 55.2455). |
| Dubai Harbour | `reclamation` | Rectángulo 1,2 × 0,6 km desde la orilla (25.0870, 55.1400) rumbo 325°. |
| Burj Al Arab | `island` | Círculo r = 130 m en (25.1412, 55.1853) más pasarela de 40 m hasta (25.1398, 55.1872). (SRTM ya tenía parte de la isla; el estampado sólo completa el mar de alrededor.) |
| Dubai Maritime City | `reclamation` | Rectángulo 1,4 × 0,8 km desde (25.2680, 55.2760) rumbo 300°. |
| Dubai Creek | `creek` | Polilínea (25.2745, 55.2830) → (25.2700, 55.2950) → (25.2600, 55.3100) → (25.2440, 55.3260) → (25.2300, 55.3310) → (25.2130, 55.3320) → (25.1990, 55.3300), 420 m de ancho (es natural y ya aparece en SRTM, pero cortado en los puentes; se re-excava para que sea continuo). |
| Ras Al Khor | `lagoon` | Polígono (25.1990, 55.3200) → (25.2080, 55.3380) → (25.1920, 55.3450) → (25.1830, 55.3300). |
| Business Bay canal | `canal` | Polilínea (25.1990, 55.3300) → (25.1880, 55.3080) → (25.1845, 55.2820) → (25.1830, 55.2690), 220 m de ancho. |
| Business Bay lake | `lake` | Disco de 500 m de diámetro en (25.1835, 55.2680). |
| Dubai Water Canal | `canal` | Polilínea (25.1830, 55.2690) → (25.1900, 55.2560) → (25.1990, 55.2410) → (25.2005, 55.2385) [mar], 120 m de ancho. |
| Dubai Marina canal | `canal` | Polilínea (25.0720, 55.1330) → (25.0790, 55.1400) → (25.0870, 55.1465) → (25.0930, 55.1450) → (25.0950, 55.1380) [mar], 150 m de ancho. |
| Burj Khalifa lake | `lake` | Polígono (25.1955, 55.2740) → (25.1985, 55.2755) → (25.1990, 55.2790) → (25.1960, 55.2795), a -2 m. |

Al reducir 2× por media de caja, los bordes de cada meseta se promedian con el
mar vecino: las frondas (110 m ≈ 3 px nativos) quedan de 1–2 px de salida y las
pasarelas de 40–60 m prácticamente desaparecen; el punto central de cada isla
sí conserva los +3 m. El script comprueba que Atlantis, el Burj Al Arab y el
centro de The World quedan en tierra y que el Creek queda bajo el agua.

## Claves del JSON

Además de las heredadas (`name`, `attribution`, `zoom`, `downsample`, `width`,
`height`, `origin_px`, `meters_per_pixel`, `offset`, `min_h`, `max_h`, `bbox`,
`peak`, `towns`, `roads`), el JSON de Dubái lleva:

* `peak`: ya no es una montaña sino el **píxel más alto del recorte**, medido
  sobre el dataset final (`{"name": "Punto más alto del recorte", lat, lon, h}`;
  actualmente 258,2 m en una duna de la esquina sureste, 24.8023 N 55.5963 E).
* `grid`: `{"anchor": {"lat": 25.064, "lon": 54.994}, "cellMeters": 650,
  "rotationDeg": -48, "size": 64}` — cuadrícula de parcelas de 64 × 64 celdas de
  650 m, eje x a lo largo de la costa hacia el noreste y eje y hacia el interior.
  Se copia tal cual desde el script.
* `towns`: `{name, lat, lon, kind}` con `kind` ∈ `city`, `district`, `airport`,
  `port`, `beach`, `island`, `landmark`, `peak`.
* `landmarks`: `{id, name, lat, lon, shape, h, w, d, rot}` — hitos que el
  cliente modela uno a uno; `h/w/d` en metros, `rot` en grados horarios desde el
  norte (0 si no se indica). Los identificadores de `shape` (`burj_khalifa`,
  `tower`, `twin`, `sail`, `wheel`, `frame`, `mall`, ...) los consume el
  cliente y no deben cambiarse.
* `clusters`: `{name, lat, lon, radius_m, count, hmin, hmax, seed, kind}` —
  skylines genéricos que el cliente instancia por procedimiento; `kind` ∈
  `towers`, `blocks`, `villas`, `warehouses`; `seed` es el CRC-32 del nombre
  (16 bits), estable entre construcciones.
* `islands` y `water`: `{name, kind}` de cada elemento estampado a mano (ver
  tabla anterior). Sólo documentación: el relieve ya está en el PNG.
* `roads`: los 12 tramos de Natural Earth seguidos de las 9 polilíneas a mano.

## Qué NO se usa

**No se usa Google Maps ni Google Earth** (ni sus teselas de terreno, ni
geocodificación, ni etiquetas, ni imágenes de satélite para calcar las islas).
Sus condiciones de servicio prohíben expresamente la extracción, el
almacenamiento y la redistribución de sus datos ("scraping", copias en caché
fuera de lo permitido, uso sin mostrar el mapa de Google, etc.), lo que es
incompatible con un monedero de código abierto que empaqueta el terreno dentro
del binario. Tampoco se usan datos de OpenStreetMap en esta versión (ni para
las islas ni para el callejero) para no arrastrar la obligación ODbL de
*share-alike* sobre la base de datos derivada; por eso las islas, los canales y
las grandes vías están dibujados a mano.

## Cómo regenerar

Requisitos: sólo **Python 3** (biblioteca estándar; el script decodifica y
codifica los PNG por sí mismo, no necesita numpy ni PIL) y acceso HTTPS a
`s3.amazonaws.com` y `raw.githubusercontent.com`.

```sh
python3 tools/geo/build_dubai.py            # con hillshade de previsualización
python3 tools/geo/build_dubai.py --no-preview
```

El script:

1. Descarga (con `User-Agent`, 3 reintentos) las 72 teselas de zoom 12 y las
   9 de zoom 10 que cubren la bbox `[54.90, 24.78, 55.60, 25.40]`, y el GeoJSON
   de carreteras (≈ 50 MB). Todo se cachea en `tools/geo/cache/` (ignorado por
   git, ≈ 51 MB), así que relanzarlo es rápido (≈ 15 s) e **idempotente**.
2. Monta el mosaico en espacio de píxeles de tesela (2040 × 1996 nativos),
   recorta a la bbox (redondeado hacia arriba a múltiplo de 2 para cubrirla
   entera) y rellena el mar enmascarado con batimetría.
3. Sube a +1 m la tierra baja que SRTM deja en `h <= 0` (valores negativos del
   mosaico crudo salvo dentro de los recintos portuarios, y toda componente de
   `h <= 0` sin salida al mar), estampa las islas (+3 m, sólo sobre mar) y
   después los canales y lagunas (-3 m), y reduce 2× por media de caja →
   1020 × 998.
4. Escribe el PNG de 16 bits (`v = clamp(round(h)+1000, 0, 65535)`, filtro
   None/Up/Paeth elegido por fila, zlib nivel 9; ≈ 0,48 MB), el JSON (con
   `min_h`/`max_h` tomados de los valores ya codificados, el `peak` medido y
   las listas de lugares, hitos, skylines, islas, agua y carreteras) y el
   hillshade.
5. Verifica e imprime: máximo del recorte (igual al `peak` del JSON), altura en
   el centro (Burj Khalifa, 0–60 m), Deira y el puerto de Jebel Ali en tierra,
   mar abierto (< 0), Atlantis y el Burj Al Arab en tierra tras el estampado,
   islotes de The World dentro de su elipse, el Creek bajo el agua, agua en las
   dársenas de Jebel Ali y Port Rashid (≥ 20 px cada una), orientación (Deira a
   la derecha y por encima de Dubai Marina), tamaños (PNG ≤ 2,5 MB),
   una relectura **completa** del PNG escrito (dimensiones, valor del máximo, y
   que el mínimo/máximo decodificados coincidan con `min_h`/`max_h` del JSON),
   recuento de píxeles recortados a `v = 0` / `v = 65535`, de píxeles con
   `h == 0` y de masas de agua interiores, y que la imagen cubre la bbox
   completa. Devuelve código de salida 1 si algo falla.

Salida de referencia de la última construcción:

```
  píxeles de tierra por debajo del nivel del mar (h < 0 en zoom 12) subidos a 1 m: 97485 ; respetados como agua dentro de los recintos portuarios: 5028
  píxeles de mar enmascarado rellenados con batimetría z10: 1305611
Tierra baja a 0 m sin salida al mar: 12746 componentes (35922 px nativos) subidas a 1 m ; mar abierto: 1274717 px nativos
  isla  Palm Jumeirah          palm           3624 px nativos
  isla  Palm Jebel Ali         palm           8808 px nativos
  isla  Bluewaters Island      island          329 px nativos
  isla  The World (240 islotes) archipelago    6862 px nativos
  isla  Deira Islands          island         5812 px nativos
  isla  Jumeirah Bay Island    island           17 px nativos
  isla  Dubai Harbour          reclamation     211 px nativos
  isla  Burj Al Arab           island            3 px nativos
  isla  Dubai Maritime City    reclamation     657 px nativos
  agua  Dubai Creek            creek          3872 px nativos
  agua  Ras Al Khor            lagoon         2925 px nativos
  agua  Business Bay canal     canal          1050 px nativos
  agua  Business Bay lake      lake            117 px nativos
  agua  Dubai Water Canal      canal           326 px nativos
  agua  Dubai Marina canal     canal           462 px nativos
  agua  Burj Khalifa lake      lake            124 px nativos
Carreteras Natural Earth dentro de la bbox: 12 (+ 9 trazadas a mano)
Codificación PNG: min bruto -43.6 m -> codificado -44 m ; max bruto 258.2 m -> 258 m ; recortados por abajo (h < -1000 m): 0 ; por arriba: 0
VERIFICACION
  max h: 258.2 m en px (1014,961) lat=24.8023 lon=55.5963 == peak del JSON  [OK]
  tierra baja: Downtown / Burj Khalifa (25.1972,55.2744): px (545.7,327.0) h=6.8 m  [OK]
  tierra: Deira (25.2700,55.3120): px (600.4,209.8) h=4.0 m  [OK]
  tierra: Puerto de Jebel Ali (25.0110,55.0600): px (233.4,626.4) h=7.0 m  [OK]
  mar: mar abierto (25.3000,55.1000): px (291.7,161.4) h=-21.1 m  [OK]
  isla estampada: Atlantis (ápice media luna) (25.1304,55.1171): px (316.6,434.4) h=3.0 m  [OK]
  isla estampada: Burj Al Arab (25.1412,55.1853): px (415.9,417.1) h=0.5 m  [OK]
  agua: Dubai Creek (25.2440,55.3260): px (620.8,251.6) h=-3.0 m  [OK]
  The World: 240 islotes colocados ; dentro de la elipse 798 px de tierra y 5975 de mar  [OK]
  dársenas: Puerto de Jebel Ali: 1172 px de agua de 4973 dentro del recinto (24%)  [OK]
  dársenas: Port Rashid: 318 px de agua de 892 dentro del recinto (36%)  [OK]
  orientación: Dubai Marina (25.0800,55.1400): px (349.9,515.5) h=0.0 m ; Deira a la derecha y arriba  [OK]
  imagen 1020x998 ; min_h=-44.0 max_h=258.0 ; m/px=69.225 ; carreteras=21 ; lugares=52 ; hitos=56 ; clusters=34 ; islas=9 ; agua=7
  chain/crates/rami-gui/src/geo/dubai.hgt.png : 477438 bytes (0.48 MB)
  chain/crates/rami-gui/src/geo/dubai.json : 27618 bytes (0.03 MB)
  tools/geo/preview.png : 571810 bytes (0.57 MB)
  tamaño hgt.png <= 2.5 MB: 0.48 MB  [OK]
  relectura PNG: 1020x998 ch=1 bd=16, v(máximo)=1258 -> 258 m  [OK]
  PNG decodificado == JSON: min v=956 (-44 m) max v=1258 (258 m) ; JSON min_h=-44.0 max_h=258.0  [OK]
  píxeles recortados al suelo v=0 (h <= -1000 m): 0 de 1017960 (0.0%) ; al techo v=65535: 0
  píxeles con h == 0: 176 exactos en el array, 4297 con v == 1000 en el PNG (|h| < 0.5) ; son MAR por contrato (h <= 0) ; mar total: 316093 (31.1%)
  masas de agua en la imagen final: mar abierto 313006 px + 48 interiores (14 de 1-2 px, 17 de >= 10 px)
  cobertura bbox: px [684195..686235) x [447755..449751) contiene [684195.84..686234.74] x [447755.56..449749.61] ; esquina inferior derecha lon=55.60009 lat=24.77957  [OK]
RESULTADO: TODO OK
```

(La altura de Dubai Marina, 0,0 m, sale del canal de la marina excavado a mano
a -3 m promediado en el downsample con tierra a +3 m del muelle; es mar por
contrato, como corresponde al punto central de la marina.)

Si se cambia la bbox, el zoom o el `downsample`, hay que actualizar en paralelo
el renderizador de `rami-gui` (lee todos esos valores del JSON, pero el contrato
de codificación —16 bits, offset 1000, norte arriba— es fijo). Si se cambian las
islas o los canales basta con relanzar el script: el PNG y las listas `islands`
/ `water` del JSON se regeneran juntos.
