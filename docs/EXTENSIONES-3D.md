# Extensiones del visor 3D (v0.11.0)

El cliente 3D de Dubái RAMI (`chain/crates/rami-gui/src/city3d.js`) llegó a la
v0.10.16 con casi cinco mil líneas en un solo fichero. Desde la v0.11.0 las
piezas nuevas del metaverso van en **módulos aparte**, en
`chain/crates/rami-gui/src/city/`, que el binario empotra y sirve igual que el
visor (`/city/<nombre>.js`) y que el panel carga, en orden, entre `city3d.js` y
el montaje del visor:

| Módulo | Qué es |
|---|---|
| `umbral.js` | Entrega 5: el portal, el zaguán, el ascensor y el apartamento |
| `vida.js` | Entrega 6: peatones con destino económico (los carriles y la cesión de paso de los coches van en el núcleo) |
| `espejismo.js` | Entrega 7: oclusión ambiental, resplandor y curva de color con el gancho `pintar` (los interiores por paralaje van en el sombreador de edificios del núcleo, y las cascadas de sombra en `updateShadowFrame`) |
| `extras.js` | Secciones 6–7 del plan: sonido sintetizado, modo foto, tormenta de arena, metro elevado y barcos |
| `memoria.js` | Secciones 6–8 del plan: la ciudad que recuerda (placa y pátina), los encargos de la economía, el día uno y el aviso siempre a la vista |

Un módulo que falla no tumba el visor: su gancho se salta y el error se anota
una vez en la consola y en `handle._debug.extFallos()`. Un módulo que no carga
(404, error de sintaxis) no impide que se carguen los demás.

## Registro

```js
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('nombre', function (ctx) {
    // se llama UNA vez, al montar el visor, antes de que el mundo esté cargado
    return {
      listo: function () { /* el mundo está construido: S.ready === true */ },
      cuadro: function (dt, now) { /* cada cuadro, antes de dibujar */ },
      publico: { /* lo que cuelga de handle.ext.nombre (pruebas, panel) */ }
    };
  });
})(typeof window !== 'undefined' ? window : this);
```

`RamiCity3D.extend(nombre, fabrica)` registra o sustituye; tiene que llamarse
antes de `RamiCity3D.mount`. `RamiCity3D.extensiones()` lista los registrados.

## Ganchos

Todos son opcionales. Los que «consumen» paran en el primer módulo que devuelve
algo verdadero; el orden es el de carga.

| Gancho | Cuándo | Devuelve |
|---|---|---|
| `listo()` | Al terminar de construir el mundo (tras aplicar la ciudad pendiente) | — |
| `ciudad(d)` | Tras cada `applyCity`: `d` es `S.city` (`parcels`, `assets`, `me`, `sectors`, `districts`, `height` y `datos`, la vista entera de `/api/city` tal como llegó) | — |
| `cuadro(dt, now)` | Cada cuadro con el mundo listo (también en VR y en `_debug.paso`) | — |
| `andar(dt)` | Al principio de cada paso a pie | `true` = el módulo movió a `walk.pos` (incluida la cota de los pies `walk.pos.y`) con su propia colisión; el visor solo coloca la cámara. **Consume** |
| `tecla(k, e, abajo)` | `keydown` (`abajo = true`) y `keyup` (`false`); `k` en minúsculas | `true` en `keydown` = consumida (el visor no la usa). **Consume** |
| `clic(info)` | Clic sin arrastre; `info = { clientX, clientY, origen, dir, celda, modo }` | `true` = consumido (no se selecciona la parcela). **Consume** |
| `pintar(now)` | En vez de `renderer.render(scene, camera)` (fuera de VR) | `true` = el módulo dibujó el cuadro. **Consume** |
| `trasPintar(now)` | Justo después de dibujar (captura de pantalla) | — |
| `calidad(nombre, Q)` | Tras cambiar la calidad | — |
| `modo(m)` | Tras pasar a `'walk'` u `'orbit'` | — |
| `sol(info)` | Tras recalcular el sol (cada ~2 s): `{ dir, luz, noche, ocaso, hora, colorSol, cielo, niebla }` | — |
| `tamano(w, h)` | Tras redimensionar el lienzo | — |
| `empujar(pos, r)` | En la colisión con lo que se mueve: sacar el círculo `(pos, r)` de lo del módulo | una etiqueta (`'peaton'`) si lo empujó |
| `estadisticas(o)` | En `handle.stats()` y al terminar `bench()`: añadir campos a `o` (acaba en `stats().ext`). Si el módulo pone `o.<nombre>.efectos` (una lista de textos en español), el núcleo los añade a `stats().efectos` y a `bench().efectos` | — |
| `vr(activo)` | Al entrar y salir de las gafas | — |
| `soltar()` | Al desmontar el visor | — |

## El contexto (`ctx`)

Lo que cambia con la cuadrícula o la calidad se lee con una función.

- **Escena**: `THREE`, `scene`, `camera`, `rig` (el grupo que lleva la cámara a
  pie y en VR), `renderer`, `canvas`, `container`.
- **Estado**: `S` (el estado del visor: `S.ready`, `S.mode`, `S.xr`, `S.city`,
  `S.meta`, `S.geo`, `S.edificios`, `S.tramas`, `S.traffic`, `S.catastro`…),
  y desde la v0.11.0 las calles tal como se levantaron: `S.vias` (cada vía con
  `muestras`, `arco`, `calzada`, `acera`, `rango`, `cortes`, `cajas`, `bocas`,
  `vivos` —los tramos con cinta, que se corta en el agua—, `filasS`/`filasY` —la
  cota de la calzada por fila— y, en las de la trama, `barrio`, `familia` y `k`),
  `S.cruces` (cada cruce resuelto: quién manda, `lin` —la línea de detención—,
  las cajas, o la glorieta), `S.cebras` (los pasos de peatones dibujados: `via`,
  `s`, `x`, `z`, `tx`, `tz`, `w` —media calzada—, `aw` —media distancia de acera a
  acera por la línea por la que se anda—, `y`), **`S.cebraOcupada`**
  (`Uint8Array`, uno por paso: el módulo que tenga peatones pone 1 en los pasos
  que alguien pisa o va a pisar; los coches se paran ante ellos) y
  `S.trafficPaths` (las rutas de los coches). `S.tramas[i]` lleva además
  `calzada`, `acera` y `kind`.
  `C` (mallas instanciadas y conjuntos de etiquetas), `cam` (órbita), `walk`
  (`pos`, `yaw`, `pitch`, `fly`, `speed`), `EYE` (1,7 m), `keys()`,
  `puntero()`, `Q()`, `calidad()`, `N()`, `CELL()`, `LIFT()`, `rotR()`.
  Desde la v0.11.0 el plano de los barrios (`S.edificios`) no pisa las vías
  del mapa: `planificarBarrios` rechaza, además de las calles de la trama, las
  posiciones cuya huella entra en la calzada o la acera de `ejesDelMapa`
  (`enViaDelMapa`); `S.rechazadosPorVia` cuenta los rechazos. El rechazo va
  después de sacar `yawLibre` y `tono`, y el rechazado que habría entrado queda
  como fantasma (ocupa su sitio para los intentos siguientes y conserva su
  número): el plano es el de antes menos los edificios que pisaban una vía,
  y los demás conservan sitio, `id` (`kind:i:j`) y matiz. Lo que un módulo
  levante sobre una vía del mapa (el viaducto de `extras`) no se encuentra un
  edificio de barrio dentro.
  El módulo `extras` escribe en dos sitios del estado del núcleo: da de alta en
  el catastro los pilares del viaducto y las torres de las estaciones (tipo
  `'hito'`, `id` `metro:pilar:<i>` y `metro:estacion:<i>`, `nombre` «Metro de
  Dubái»: a pie se choca con ellos y el panel los nombra al señalarlos), y cada
  cuadro sube `desvMin` de los coches de la troncal del metro para que su
  centro no pase a menos de 1,9 m del eje (el núcleo deja 1,2 m al adelantar
  y ahí el coche atravesaba el pilar). Quien recorra el catastro buscando
  hitos del catálogo, que salte los `metro:`.
- **Materiales y luz**: `shared` (uniformes compartidos: `uSun`, `uSunColor`,
  `uSkyColor`, `uGroundColor`, `uNight`, `uDusk`, `uEnv`, `uInterior`), `buildMat`,
  `plainMat`, `terrainMat`, `makeBuildingMaterial(shared, ventanas)`, `mats`
  (las cuatro texturas), `noiseTex`, `envRT`, `sun`, `hemi`, `sunDir`,
  `lightDir`, `uniformes` (`viewport`, `lod`, `drop`, `noche`, `fantasma`).
- **Profundidad y sombras** (v0.11.0): `profundidad()` devuelve `'log'` (el
  búfer logarítmico, por defecto) o `'lineal'` (el experimento: se pide con
  `localStorage['rami.profundidad'] = 'lineal'` antes de montar). Con `'lineal'`
  el núcleo ajusta `camera.near` y `camera.far` cada cuadro
  (`planosProfundidad`); quien lea la profundidad los toma de la cámara en ese
  cuadro. El cercano sale de la holgura de la cámara (terreno, sólidos del
  catastro, avatares): 0,5 m a pie con `walk.fly < 2`; volando y en órbita, la
  mitad de la holgura, hasta 500 m. Un módulo que lleve al jugador en alto
  (un piso, un ascensor) lo deja con `walk.fly = 0` y tiene 0,5 m; si dibuja
  geometría propia fuera de cualquier huella del catastro y lejos del suelo,
  que la meta en el catastro o no la verá de cerca con el lineal.
  `cascadas()` son las luces de sombra que hay además del sol (dos en
  alta y ultra, ninguna en baja y media); tienen intensidad cero y no hay que
  moverlas: `updateShadowFrame` las coloca. Los materiales propios que usan
  `getShadowMask()` ya leen las tres; un material de three (Lambert, Phong,
  Standard) solo aplica a cada luz su propio mapa, y el del sol es la caja
  cercana (150 m a pie): pasadlo por `ctx.util.sombraEnCascadas(material)`
  antes de su primer dibujo para que lea las tres.
- **Edificios** (v0.11.0): `aflags` lleva la fachada (0–3) más 4·(1 + id);
  quien lo lea para saber la fachada, que tome `aflags % 4`. Quien funda
  edificios con `buildMat` y quiera interiores con paleta por edificio, que
  escriba `ctx.util.flagsEdificio(fachada, x, z)`; con la fachada sola (id 0)
  la paleta sale de la tesela de 500 m.
- **Genotipo** (`ctx.util`): `semillaMorfologia(x, y, canal)`,
  `semillaRopaje(x, y, dueno, desde)`, `real01`, `lcg`, `hash2`, `fnv1a`,
  `strSeed`, `clamp`, `lerp`, `smoothstep`, `lin1`, `lin3`, y dos de la
  v0.11.0: `sombraEnCascadas`, `flagsEdificio`. **Solo enteros para
  decidir**: la forma, el sitio y el horario de algo salen de aquí, nunca de
  `Math.random`, para que dos máquinas vean lo mismo.
- **Geometría** (`ctx.geom`): `prim`, `newAcc`, `pushPart(s)`, `accGeometry`, el
  catálogo de cuerpos (`piezas`, `cuerpoTorre`, `cuerpoBloque`, `cuerpoNave`,
  `cuerpoVilla`, `parcelaPartes`, `edificioPartes`), `carGeometry(ligero)`,
  `avatarBodyGeometry(estilo, ligero)`, `avatarLimbGeometry(tipo, estilo,
  ligero)`, `palmGeometry`, las mallas instanciadas (`inst`, `place`, `finish`,
  `ensureCap`) y la paleta (`colores`). Con `ligero` (v0.11.0) el coche pasa de
  484 a 260 triángulos y el cuerpo de un avatar de unos mil a unos doscientos
  (cabeza icosaédrica, media esfera `hemiL` de 70, brazos de seis caras).
  En `colores` están también los tonos con los que el catálogo marca dos piezas
  del portal, `PUERTA` (la caja de la puerta) y `VIDRIERA` (el cristal del
  vestíbulo): el módulo «umbral» encuentra con ellos la puerta de cada edificio
  en la lista de piezas, así que cambiar un tono en el núcleo no deja la ciudad
  sin portales.
- **Mundo** (`ctx.mundo`): `surfaceH`, `groundH`, `coarseH`, `insideMap`, la
  cuadrícula (`cellWorld`, `cellLocal`, `worldToCell`, `localToWorld`,
  `worldToLocal`, `latLonToCell`, `cellLatLon`, `rotOff`, `gridYaw`),
  `districtOf`, `dubaiHour`, `parcelInfo`, `sectorName`, las tablas de sectores
  (`SECTOR_ARCH`, `SECTOR_COLORS`, `SECTOR_NAMES`, `ARCH_KEYS`), `TESELA_VIA`,
  `TIPOS_BARRIO`, `fachadaBarrio`, `fachadaParcela`, `FACHADA`, y desde la
  v0.11.0 `cotaVia(via, s)` (la cota de la calzada de una vía de `S.vias`),
  `sueloCalle(x, z)` (la de la calzada o la acera bajo un punto, o −Infinity: la
  cinta va nivelada y en ladera queda hasta dos metros por encima del terreno;
  el jugador ya anda por ella), `ensancheBoca(d, R)` y `enTramo(tramos, s)`.
- **Catastro** (`ctx.catastro`): `alta(solido)`, `quita(pred)`, `bajo(x, z)`,
  `rayo(o, dir, maxT)`, `empujarFuera(pos, r)`, `huellaLibre(x, z, r)`,
  `aLocal(solido, x, z, out)`. El `yaw` de un sólido es el `rotation.y` de three
  con el que se dibuja: el +x local va a (cos, −sen) y el +z local a (sen, cos).
  Hasta la v0.10.16 `aLocal`, `empujarFuera` y el rayo giraban al revés y la caja
  de un edificio girado era la de su reflejo; corregido en la v0.11.0.
- **Entrada**: `pick(clientX, clientY)`, `rayoPantalla(clientX, clientY)`,
  `setMode(m)`.
- **Reconstrucción**: `rehacerBarrios()`, `reaplicarCiudad()`.
- **Etiquetas**: `LabelSet` y `etiquetas(ls)` para que un conjunto del módulo se
  recorte con los del visor (el módulo lo añade a la escena).
- **Entre módulos**: `servicios` (un objeto compartido: p. ej. `extras` pone
  `servicios.sonido` y `umbral` lo usa si está). `handle` (la API pública,
  disponible tras el montaje).
- **`servicios.sonido`** (lo pone `extras`): `play(nombre)` con `'timbre'`
  (ascensor), `'puerta'` (corredera), `'clic'` y `'paso'`; devuelve `false` sin
  lanzar si el sonido está apagado o el nombre no existe. `activo()` dice si
  suena. Todo sintetizado; el AudioContext solo existe tras un gesto del
  usuario, así que un módulo no puede encenderlo por su cuenta.

## Servicios y opciones que usa hoy algún módulo

- **`servicios.patina(altura, desde, rgb)`** (lo pone `memoria`): el núcleo lo
  llama en `applyCity` con el color sRGB del cuerpo de cada edificio de parcela
  (no pendiente), la altura de la cabeza y el `since` de la parcela, y usa el
  color que devuelve. Sin el módulo, el color es el de la v0.10.16. Es el único
  punto del núcleo que toca `memoria` (dos líneas en la línea del color).
- **`opts.irA(destino)`**: el panel lo pasa a `RamiCity3D.mount`; un módulo lo
  llama para llevar al jugador a otra vista del panel (`'minar'`, `'recibir'`,
  cualquier vista de `views`) o a la tarjeta del perfil (`'perfil'`). Lo usa la
  guía del día uno.
- **`handle.ext.memoria.jugador({ perfil, saldo })`**: el panel cuenta al módulo
  lo que el visor no ve (si hay perfil en la cadena y el saldo), cada 2,5 s con
  la pestaña de la ciudad abierta.
- **`window.RamiMemoria`**: `memoria.js` publica sus funciones puras
  (`nivelPatina`, `patina`, `encargos`) aunque no haya visor, para las pruebas.
- **Etiquetas de los módulos**: `ctx.etiquetas(ls)` recorta los conjuntos de
  los módulos los últimos, detrás de los rótulos de barrio, de hito y de venta:
  la etiqueta que chocaría con uno de ellos no se dibuja. Los encargos de
  `memoria` se registran así; para que choquen poco se anclan en una empresa
  del distrito (no en su centro, donde cae el rótulo del barrio) y llevan un
  texto corto. Como en la vista general casi todas ceden, `memoria` pone
  además una lista en la vista 3D y un clic en una fila vuela a la etiqueta de
  ese distrito (`vuela()`: `ctx.cam.flight` con la forma de `fly()` del
  núcleo, mirando a la etiqueta y no al suelo, para que los rótulos del suelo
  queden por debajo). Un conjunto registrado y oculto (`mesh.visible = false`)
  sigue pasando por el recorte, pero como va el último no le quita sitio a
  nadie.

## Dibujar a un destino intermedio (el gancho `pintar`)

Quien dibuja la escena en un `WebGLRenderTarget` en vez de en el lienzo tiene
que saber cinco cosas de three r150 y de los materiales del visor. Con las
cinco, el pase neutro de `espejismo.js` (los efectos a cero) da los mismos
bytes que el dibujo directo (diferencia máxima 0, medido con `readPixels`).

1. Fuera del lienzo three compila los materiales con salida lineal, y los del
   visor mezclan la niebla **después** del tono y de la codificación sRGB, con
   un color de niebla ya pasado por esa curva (`updateSun`). Un destino normal
   da una escena oscura y una niebla desplazada. `espejismo.js` marca su destino
   con `isXRRenderTarget = true`, textura en `sRGBEncoding` y
   `internalFormat: 'RGBA8'`: los materiales compilan el mismo programa que para
   el lienzo y el destino guarda los bytes que habría recibido el lienzo.
2. El color de la niebla (`scene.fog.color`) y el del fondo
   (`scene.background`) three los convierte de lineal a sRGB al subirlos
   **solo** cuando dibuja al lienzo (`getRenderTarget() === null`); a un
   destino, aunque sea de XR, los sube tal cual. Hay que hacer esa conversión a
   mano mientras se dibuja la escena y devolver los colores después
   (`convertLinearToSRGB()` sobre una copia guardada, como en `pintar` de
   `espejismo.js`). Sin esto la calima del horizonte sale hasta 12 niveles más
   oscura.
3. `renderer.info` se reinicia en cada `render()`. Para que `stats()` y
   `bench()` cuenten la escena y además las pasadas propias, se dibuja la escena
   con `autoReset` como esté y las pasadas con `autoReset = false`, y se deja
   como estaba.
4. La profundidad se lee con `DepthTexture` (sin filtro). Un pase a media
   resolución que la lea en el centro de SUS píxeles cae en la arista entre dos
   texels, y el redondeo cambia de fila en fila: hay que llevar la coordenada al
   centro de un texel de la profundidad antes de leer (`espejismo.js`, `AO_FS`).
   Con el búfer logarítmico la distancia es `2^(d · log2(lejano + 1)) − 1`; con
   el lineal (`ctx.profundidad() === 'lineal'`), la perspectiva con los planos
   **del cuadro**, que cambian con la cámara: se leen en cada `pintar`.
5. Los destinos se sueltan en `tamano` y en `calidad` y se rehacen en el
   siguiente `pintar`. En VR no hay `pintar` que valga: `xrFrame` dibuja directo.

## Reglas de la casa

- **Genotipo en enteros, fenotipo en coma flotante** (`docs/METAVERSO.md` §1).
  Lo que tiene que coincidir entre máquinas se decide con las semillas; la
  malla puede diferir en el último bit.
- **Nada de assets con licencia sin verificar** (`NOTICE.md`): la geometría se
  fabrica, el sonido se sintetiza, las texturas son las cuatro de
  `tools/textures/make_materials.py`.
- **Textos**: `ctx.t('texto en español')`, con su traducción en
  `chain/crates/rami-gui/i18n-src/`. Sin léxico estimativo (`tools/panel/lexico.py`).
- **Presupuesto**: cada módulo anota lo que cuesta (triángulos, llamadas de
  dibujo) en `estadisticas`, y las notas de versión lo miden con los mismos
  encuadres antes y después.

## El tráfico y los peatones (v0.11.0)

- `handle.stats().trafico`: coches, dibujados, cuántos ceden y cuántos esperan
  ante un paso este cuadro, activaciones de la válvula de paciencia,
  recolocados, desatascos (coches de un ciclo de esperas recolocados), saltos
  (veces que el foco saltó y se recolocaron todos a su alrededor),
  `saltadosLod` (coches lejanos que este cuadro no se actualizaron: la
  simulación por cercanía), cuántos están dando la vuelta, rutas y pasos de
  peatones.
- `handle._debug.trafico`: `estado()`, `rutas()`, `vivo(bool)` (recolocar los
  coches lejanos), `paciencia(s)` (la válvula; `Infinity` la quita), `lod(bool)`
  (la simulación por cercanía: con `false` se actualizan todos los coches en
  cada paso),
  `escenario([{ ruta, t, dir, carril, vel, vmax }, …])` (deja solo esos coches)
  y `normal()`; `pose(c)`, `puntoCarril(R, t, lateral)`, `geo(c, cf, y)` (dónde
  se cortan los carriles de dos coches en un cruce) y `banda(c, cf)` (la calzada
  ajena por el carril de un coche y su parada).
- Cada coche lleva `motivo`: lo que más lo frena en el cuadro (`fila`, `cede`,
  `cajaOcupada`, `cajaTapada`, `salidaTapada`, `glorieta`, `anillo`, `peaton`,
  `jugador`), y `causa`: el coche que lo frena, si lo frena un coche. Un
  bloqueo mutuo sería un ciclo de coches parados siguiendo `causa`. Mientras
  da la vuelta al final de su ruta, `vu` ≥ 0 son los metros de arco recorridos
  del semicírculo (−1 si no la está dando); los centros de la vuelta de cada
  ruta son `tc0` y `tc1` (metros desde su principio).
- Cada cruce de una ruta (`R.conf`, tipo `cede` o `manda`) lleva su marco:
  `sab` (la tangente propia por la normal de la otra ruta: ± el seno del
  ángulo) y `cos`; con ellos el núcleo calcula dónde se cortan de verdad los
  carriles de dos coches (en un cruce oblicuo, lejos del centro). `alc` es lo
  que ocupa el cruce a lo largo de la ruta y `par` el mismo cruce visto desde
  la otra.
- `handle.ext.vida` (los peatones): `reloj()`, `fijaReloj(T)`, `posicion(i, T)`
  (función pura de los datos, `i` y `T`), `enLaCalle(T, x, z, radio)`,
  `persona(i)`, `viaje(id)`, `ruta(id)`, `pasosDe(id)`, `zona(i)`,
  `paradas(i)` (las paradas del barrio i, con su bordillo), `dibujados()`,
  `limpia()`, `reconstruye(porTrozos)` (de una vez, o por trozos como al
  cambiar las parcelas), `reconstruyendo()`, `enCalzada(x, z)`,
  `diagnostico()`, `empleo()` (cuántos trabajan en las parcelas, cuántos puestos
  suman sus plantillas y cuántos van a las oficinas de cada barrio) y
  `huella(dx, dz)` (la prueba de márgenes del genotipo: reconstruye con los
  puntos desplazados y devuelve la huella por partes); `stats().ext.vida` con
  las cifras (entre ellas `construccionMs`, `trozos`, `trozoMaxMs`, `fasesMs`
  de la última construcción, `calentados` —caminos precalculados antes del
  cambio de población—, `caminos` y `podas` de la caché y `aplazados`, los
  caminos que este cuadro dejó para el siguiente).
