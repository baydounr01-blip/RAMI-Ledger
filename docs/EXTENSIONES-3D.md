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
  `C` (mallas instanciadas y conjuntos de etiquetas), `cam` (órbita), `walk`
  (`pos`, `yaw`, `pitch`, `fly`, `speed`), `EYE` (1,7 m), `keys()`,
  `puntero()`, `Q()`, `calidad()`, `N()`, `CELL()`, `LIFT()`, `rotR()`.
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
  `cuerpoVilla`, `parcelaPartes`, `edificioPartes`), `carGeometry`,
  `avatarBodyGeometry`, `avatarLimbGeometry`, `palmGeometry`, las mallas
  instanciadas (`inst`, `place`, `finish`, `ensureCap`) y la paleta (`colores`).
- **Mundo** (`ctx.mundo`): `surfaceH`, `groundH`, `coarseH`, `insideMap`, la
  cuadrícula (`cellWorld`, `cellLocal`, `worldToCell`, `localToWorld`,
  `worldToLocal`, `latLonToCell`, `cellLatLon`, `rotOff`, `gridYaw`),
  `districtOf`, `dubaiHour`, `parcelInfo`, `sectorName`, las tablas de sectores
  (`SECTOR_ARCH`, `SECTOR_COLORS`, `SECTOR_NAMES`, `ARCH_KEYS`), `TESELA_VIA`,
  `TIPOS_BARRIO`, `fachadaBarrio`, `fachadaParcela`, `FACHADA`.
- **Catastro** (`ctx.catastro`): `alta(solido)`, `quita(pred)`, `bajo(x, z)`,
  `rayo(o, dir, maxT)`, `empujarFuera(pos, r)`, `huellaLibre(x, z, r)`,
  `aLocal(solido, x, z, out)`.
- **Entrada**: `pick(clientX, clientY)`, `rayoPantalla(clientX, clientY)`,
  `setMode(m)`.
- **Reconstrucción**: `rehacerBarrios()`, `reaplicarCiudad()`.
- **Etiquetas**: `LabelSet` y `etiquetas(ls)` para que un conjunto del módulo se
  recorte con los del visor (el módulo lo añade a la escena).
- **Entre módulos**: `servicios` (un objeto compartido: p. ej. `extras` pone
  `servicios.sonido` y `umbral` lo usa si está). `handle` (la API pública,
  disponible tras el montaje).

### Dibujar a un destino intermedio (el gancho `pintar`)

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
