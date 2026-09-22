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
| `espejismo.js` | Entrega 7: oclusión ambiental, resplandor, curva de color y cascadas de sombra (los interiores por paralaje van en el sombreador de edificios del núcleo) |
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
| `estadisticas(o)` | En `handle.stats()`: añadir campos a `o` (acaba en `stats().ext`) | — |
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
- **Materiales y luz**: `shared` (uniformes compartidos: `uSun`, `uSunColor`,
  `uSkyColor`, `uGroundColor`, `uNight`, `uDusk`, `uEnv`), `buildMat`,
  `plainMat`, `terrainMat`, `makeBuildingMaterial(shared, ventanas)`, `mats`
  (las cuatro texturas), `noiseTex`, `envRT`, `sun`, `hemi`, `sunDir`,
  `lightDir`, `uniformes` (`viewport`, `lod`, `drop`, `noche`, `fantasma`).
- **Genotipo** (`ctx.util`): `semillaMorfologia(x, y, canal)`,
  `semillaRopaje(x, y, dueno, desde)`, `real01`, `lcg`, `hash2`, `fnv1a`,
  `strSeed`, `clamp`, `lerp`, `smoothstep`, `lin1`, `lin3`. **Solo enteros para
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
  recolocados, rutas y pasos de peatones.
- `handle._debug.trafico`: `estado()`, `rutas()`, `vivo(bool)` (recolocar los
  coches lejanos), `paciencia(s)` (la válvula; `Infinity` la quita),
  `escenario([{ ruta, t, dir, carril, vel, vmax }, …])` (deja solo esos coches)
  y `normal()`; `pose(c)` y `puntoCarril(R, t, lateral)`.
- Cada coche lleva `motivo`: lo que más lo frena en el cuadro (`fila`, `cede`,
  `cajaOcupada`, `cajaTapada`, `salidaTapada`, `glorieta`, `peaton`,
  `jugador`).
- `handle.ext.vida` (los peatones): `reloj()`, `fijaReloj(T)`, `posicion(i, T)`
  (función pura de los datos, `i` y `T`), `enLaCalle(T, x, z, radio)`,
  `persona(i)`, `viaje(id)`, `ruta(id)`, `pasosDe(id)`, `zona(i)`,
  `dibujados()`, `limpia()`, `reconstruye()`, `enCalzada(x, z)`,
  `diagnostico()`; `stats().ext.vida` con las cifras.
