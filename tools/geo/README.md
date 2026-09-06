# Terreno abierto de Tenerife (`tools/geo`)

Esta carpeta contiene el constructor del **dataset de terreno de Tenerife** que
usa el monedero de escritorio RAMI-Chain (crate `rami-gui`) para dibujar la isla
en 3D. Todo el dataset se genera a partir de **datos abiertos**; no se usa ningún
dato de Google Maps / Google Earth (ver "Qué NO se usa").

## Ficheros generados

| Fichero | Descripción |
|---|---|
| `chain/crates/rami-gui/src/geo/tenerife.hgt.png` | Mapa de alturas: PNG **gris de 16 bits** (color type 0, sin entrelazado, muestras big-endian). Valor `v` → altura `h = v - 1000` metros. Fila 0 = NORTE, columna 0 = OESTE. El mar es `h <= 0` (el dataset incluye batimetría **hasta -1000 m**, así que la línea de costa sale sola de los datos; ver "Límites del contrato"). |
| `chain/crates/rami-gui/src/geo/tenerife.json` | Metadatos: `origin_px` (esquina superior izquierda del recorte en píxeles de tesela Web-Mercator a zoom 12, antes del downsample), `meters_per_pixel`, `offset`, `min_h`/`max_h`, `bbox`, `peak` (Teide medido en el dataset), `towns` (lista curada de lugares) y `roads` (polilíneas `[lon,lat]`). |
| `tools/geo/preview.png` | Hillshade de 8 bits, sólo para inspección visual (no lo usa la app). |

Conversión lat/lon → píxel de salida (la misma que usa el renderizador):

```
X = ((lon+180)/360 * 2^12 * 256 - origin_px.x) / downsample
Y = ((1 - ln(tan(lat) + 1/cos(lat)) / π) / 2 * 2^12 * 256 - origin_px.y) / downsample
worldX = X * meters_per_pixel ; worldZ = Y * meters_per_pixel (crece hacia el sur) ; worldY = h
```

### Límites del contrato (léase antes de consumir el dataset)

* **Suelo a -1000 m.** Con `offset = 1000` una muestra de 16 bits sin signo no
  puede representar profundidades por debajo de `h = -1000 m`: todo lo más hondo
  se recorta a `v = 0`. En la construcción actual eso afecta al 39,7 % de los
  píxeles (≈ 521 k de 1 312 k; el mar abierto alrededor de la isla es un
  plateau plano a -1000 m). Por eso `min_h` del JSON es exactamente `-1000.0`:
  **`min_h`/`max_h` se calculan sobre los valores ya codificados**, de modo que
  describen el PNG tal cual (`max_h` también queda redondeado al metro). Quien
  necesite la batimetría real debe leer las teselas de zoom 10 de la fuente.
* **`h == 0` es mar.** El contrato define mar como `h <= 0`, no `h < 0`. El
  relleno de batimetría deja en `0 m` exactos los píxeles enmascarados en zoom
  12 cuyo vecino grueso de zoom 10 es tierra (≥ 0): una franja fina pegada a la
  costa (≈ 43 k píxeles exactos en el array, ≈ 56 k con `v == 1000` en el PNG
  contando los que redondean a 0). Un renderizador que pruebe `h < 0` verá un
  anillo de 0 m alrededor de la isla; el de `rami-gui` debe usar `h <= 0`.
* **La imagen no coincide exactamente con la bbox.** El recorte empieza en
  `origin_px = (floor(x0), floor(y0))` píxeles nativos de zoom 12 y mide
  `width*downsample × height*downsample` píxeles nativos, redondeado **hacia
  arriba** a múltiplo de `downsample`. Cubre la bbox del JSON completa (el
  script lo comprueba) con hasta `downsample` px nativos de sobra por el este y
  el sur; la esquina inferior derecha real está en lon −16.09943, lat 27.97985.
  Para convertir coordenadas hay que usar `origin_px`, nunca la bbox.

## Fuentes y licencias

### Elevación: Mapzen / AWS Terrain Tiles (formato *terrarium*)

* URL: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
* Codificación: `h = R*256 + G + B/256 - 32768` metros.
* Es un mosaico de fuentes públicas: **SRTM** (NASA), **GMTED2010** (USGS),
  **ETOPO1** (NOAA, batimetría) y otras. Los datos son de dominio público /
  licencias abiertas; el conjunto se distribuye a través del programa
  *AWS Open Data* con la atribución que exige Mapzen/Tilezen:
  *"Terrain: Mapzen/AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1 and other public
  sources)"*. Esa cadena se guarda en `attribution` dentro del JSON y la app la
  muestra.
* Detalle importante: a partir de zoom 11 las teselas *terrarium* enmascaran el
  océano a `0 m` exactos; la batimetría de ETOPO1 sólo aparece hasta zoom 10.
  Por eso el constructor descarga el terreno a **zoom 12** (≈ 38 m/px en
  Tenerife) y además las teselas de **zoom 10**, que interpola bilinealmente
  y usa únicamente para rellenar los píxeles que en zoom 12 valen exactamente
  `0.0` (limitado a `<= 0`, nunca añade tierra). El resultado se reduce 2× por
  media de caja → ≈ 67 m/px.

### Carreteras: Natural Earth 1:10m `ne_10m_roads`

* URL: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson`
* Licencia: **dominio público** (Natural Earth no exige atribución, se incluye
  por cortesía). Se conservan sólo las (Multi)LineStrings con algún vértice
  dentro de la bbox de Tenerife (3 tramos). Es una capa muy generalizada; sirve
  de referencia, no de callejero.

### Lugares (`towns`)

Lista curada a mano (25 entradas: ciudades, pueblos, aeropuertos, playas,
puertos y el pico) con coordenadas aproximadas del centro de cada lugar. No
procede de ningún servicio de terceros.

## Qué NO se usa

**No se usa Google Maps ni Google Earth** (ni sus teselas de terreno, ni
geocodificación, ni etiquetas). Sus condiciones de servicio prohíben
expresamente la extracción, el almacenamiento y la redistribución de sus datos
("scraping", copias en caché fuera de lo permitido, uso sin mostrar el mapa de
Google, etc.), lo que es incompatible con un monedero de código abierto que
empaqueta el terreno dentro del binario. Tampoco se usan datos de OpenStreetMap
en esta versión para no arrastrar la obligación ODbL de *share-alike* sobre la
base de datos derivada.

## Cómo regenerar

Requisitos: sólo **Python 3** (biblioteca estándar; el script decodifica y
codifica los PNG por sí mismo, no necesita numpy ni PIL) y acceso HTTPS a
`s3.amazonaws.com` y `raw.githubusercontent.com`.

```sh
python3 tools/geo/build_tenerife.py            # con hillshade de previsualización
python3 tools/geo/build_tenerife.py --no-preview
```

El script:

1. Descarga (con `User-Agent`, 3 reintentos) las 100 teselas de zoom 12 y las
   16 de zoom 10 que cubren la bbox `[-16.95, 27.98, -16.10, 28.62]`, y el
   GeoJSON de carreteras. Todo se cachea en `tools/geo/cache/` (ignorado por
   git, ≈ 55 MB), así que relanzarlo es rápido e **idempotente**.
2. Monta el mosaico en espacio de píxeles de tesela, recorta a la bbox
   (redondeado hacia arriba a múltiplo de 2 para cubrirla entera), rellena el
   océano enmascarado con batimetría y reduce 2× por media de caja.
3. Escribe el PNG de 16 bits (`v = clamp(round(h)+1000, 0, 65535)`, filtro
   None/Up/Paeth elegido por fila, zlib nivel 9; ≈ 0.5 MB), el JSON (con
   `min_h`/`max_h` tomados de los valores ya recortados) y el hillshade.
4. Verifica e imprime: máximo (debe ser 3600–3760 m a < 1,5 km del Teide),
   altura en Santa Cruz (0–150 m), altura en mar abierto (< 0), orientación
   (Santa Cruz a la derecha y por encima de Los Cristianos), tamaños, una
   relectura **completa** del PNG escrito (dimensiones, valor del pico, y que
   el mínimo/máximo decodificados coincidan con `min_h`/`max_h` del JSON),
   recuento de píxeles recortados a `v = 0` / `v = 65535` y de píxeles con
   `h == 0`, y que la imagen cubre la bbox completa. Devuelve código de salida
   1 si algo falla.

Salida de referencia de la última construcción:

```
max h = 3677.4 m en px (448,575) lat=28.2726 lon=-16.6422 ; a 0.04 km del Teide  [OK]
Santa Cruz (28.4636,-16.2518): px (1017.1,259.4) h=19.5 m  [OK]
mar abierto (28.00,-16.20): px (1092.5,1025.8) h=-2502.5 m  [OK]
Los Cristianos: px (341.5,941.5) h=15.2 ; Santa Cruz a la derecha y arriba  [OK]
imagen 1239x1059 ; min_h=-1000.0 max_h=3677.0 ; m/px=67.301 ; carreteras=3 ; pueblos=25
relectura PNG: 1239x1059 ch=1 bd=16, v(pico)=4677 -> 3677 m  [OK]
PNG decodificado: min v=0 (-1000 m) max v=4677 (3677 m) == JSON min_h=-1000.0 max_h=3677.0  [OK]
píxeles recortados al suelo v=0 (h <= -1000 m): 521081 de 1312101 (39.7%) ; al techo v=65535: 0
píxeles con h == 0: 42595 exactos en el array, 55838 con v == 1000 en el PNG (|h| < 0.5) ; son MAR por contrato (h <= 0)
cobertura bbox: px [474917..477395) x [437226..439344) contiene [474917.55..477393.35] x [437226.30..439343.50]  [OK]
```

(La altura "mar abierto = -2502.5 m" es la del array en coma flotante antes de
codificar; en el PNG ese píxel vale `v = 0`, es decir, -1000 m.)

Si se cambia la bbox, el zoom o el `downsample`, hay que actualizar en paralelo
el renderizador de `rami-gui` (lee todos esos valores del JSON, pero el contrato
de codificación —16 bits, offset 1000, norte arriba— es fijo).
