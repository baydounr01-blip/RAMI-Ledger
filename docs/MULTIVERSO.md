# Identidad y multiverso: el jugador en la cadena y las ramas como ciudades (v0.10.0)

Este documento describe qué añade la v0.10.0 al metaverso de Dubái, qué parte
es consenso, qué parte es solo observación del nodo y qué parte es el cliente
gráfico. Misma disciplina que `docs/DUBAI.md`: **hechos** (lo que el código
hace y lo que las pruebas ejecutaron) separados de **juicios**, sin palabras
de la lista prohibida. Testnet experimental: los RAMI no tienen valor
monetario (`NOTICE.md`).

## 1. El perfil del jugador (consenso, hecho)

Una transacción nueva, `Tx::SetProfile` (byte de dominio `0x30`), crea o
actualiza el perfil de una cuenta. Solo vale desde la activación de Dubái
(`FirmaCtx.dubai`, 1 de diciembre de 2026 en la testnet): la misma fecha, sin
periodo mixto y sin retroceso dentro de una rama.

| Campo | Regla |
|---|---|
| `handle` (nombre) | de 3 a 20 bytes, solo `a-z`, `0-9` y `_`; **único en toda la cadena** (`State.handles`). Nada de normalización Unicode: el consenso no depende de tablas que cambian |
| `display` (alias) | UTF-8, ≤ 32 bytes |
| `bio` | UTF-8, ≤ 160 bytes |
| `avatar`, `color` | 0..15 cada uno (el cliente dibuja 4 estilos de cuerpo y 16 colores) |
| `node_pk`, `node_sig` | opcional: la **identidad del nodo** (la que firma presencia y chat) firma `"RAMI-CITY/vinculo/v1" ‖ cuenta`. El consenso verifica esa firma Ed25519 (`verify_strict`). Un nodo solo puede estar vinculado a una cuenta (`State.nodes`). Sin vínculo, `node_pk` y `node_sig` van a cero |
| Precio | registrar un nombre nuevo (o cambiarlo) **quema 2 RAMI** (`ciudad::PRECIO_NOMBRE`); actualizar alias, bio, avatar, color o vínculo con el mismo nombre solo paga la comisión |
| Al cambiar de nombre | el anterior queda libre; al soltar el vínculo, el nodo queda libre |

El estado guarda `State.profiles` (cuenta → perfil, con la altura del primer
perfil y de la última actualización). Empresas, activos y saldo no se
duplican: se derivan del estado.

**Por qué el vínculo.** Sin él, cualquiera se pasea por la ciudad
diciendo llamarse como otro. Con él, un avatar «es» una cuenta solo si el
nodo que firma su presencia firmó también, en la cadena, el vínculo con esa
cuenta; el panel lo marca con ✓ y muestra el nombre y las empresas del
perfil, no el nombre declarado. Junto al ✓ va siempre el **nombre único**
(`handle`), nunca el alias: el alias es texto libre y no es único, así que
rotular con él dejaría pasar avatares «✓ rami» que no son @rami. Un atacante sin la clave del nodo no puede
producir esa firma, y sin la clave de la cuenta no puede publicar el perfil.

**Qué pasa con la 0.9.0.** Anuncia la regla 3; la 0.10.0 anuncia la 4
(`REGLA_SOPORTADA`). Antes del 1 de diciembre son idénticas para la red. Desde
esa fecha, un binario 0.9.0 no entiende `SetProfile`: en el primer bloque que
lleve un perfil se queda en su altura sin romperse (igual que un 0.8.0 con
las transacciones de mercado). El panel señala a esos pares en Red con el
motivo. La salida es actualizar.

## 2. La ficha del jugador (observación del nodo, hecho)

`GET /api/city/profile[?pk=|handle=]` y `GET /api/city/players` devuelven,
por cuenta, lo que la cadena sabe (perfil, empresas con sus cuentas, activos,
saldo, ingresos, ventas) y lo que **este nodo** observa ahora (si su avatar
está en la ciudad). Con eso el nodo calcula un **código de fuente** como el de
los pares (`docs/PALABRA-EXACTA.md`): describe, no decide nada, y sus umbrales
son enteros y públicos (`rami_node::grado_jugador`).

| Letra (hechos de la cadena) | Umbral |
|---|---|
| A | ≥ 3 empresas con ingresos y ventas a otras, y ≥ 10 080 bloques desde el primer perfil (~1 semana) |
| B | ≥ 2 empresas con ingresos y ≥ 1440 bloques (~1 día) |
| C | al menos una empresa que ya cobra del fondo |
| D | empresa sin ingresos todavía |
| E | perfil sin empresa |
| F | sin perfil |

| Número (esta sesión) | Significado |
|---|---|
| 1 | su avatar está en la ciudad ahora y el vínculo con ese nodo está en la cadena |
| 2 | un avatar con su nombre está en la ciudad ahora, sin vínculo verificado |
| 3 | vinculó su nodo; no está en la ciudad ahora |
| 4 | sin vínculo con ningún nodo |
| 6 | sin perfil |

## 3. El multiverso (observación del nodo, hecho)

RAMI-Chain conserva **todas** las ramas válidas y observa la de más trabajo
(`docs/CONSENSO-V2.md`, teoría del Universo de Bloques Ramificados). El árbol
guarda el estado de cada punta (`BlockTree::tip_state_of`); desde la v0.10.0
ese estado se lee como lo que es: **otra ciudad**. `GET /api/city/multiverse`
devuelve, para las 12 puntas más pesadas, altura, trabajo, último bloque
común con la cabeza, bloques propios desde entonces, empresas, fondo, quemado
y sus **diferencias** frente a la ciudad observada (hasta 256 por punta):

- `solo_alli`: la parcela existe en esa rama y no en la cabeza;
- `distinta`: existe en ambas con otro dueño, nombre o sector;
- `solo_aqui`: existe en la cabeza y no en esa rama (desaparecería si esa
  rama ganara).

`GET /api/city?tip=<hash>` devuelve la ciudad entera tal como es en esa
punta. Nada de esto toca el consenso ni la red: es una vista sobre lo que el
nodo ya tenía en memoria.

En el cliente 3D, las parcelas `solo_alli` y `distinta` se dibujan como
edificios **en superposición** (translúcidos, con brillo de borde y su rama
en la etiqueta). Cuando el consenso colapsa hacia una rama, desaparecen o se
vuelven sólidos: es la decoherencia de la teoría, visible en la ciudad. El
panel permite **visitar** cualquier rama; las acciones (reclamar, vender,
comprar) siguen aplicándose a la rama observada, porque es la única en la que
el nodo mina y a la que manda transacciones.

## 4. El cliente gráfico (juicio y hecho)

Hecho, lo que hace el código de `city3d.js`:

- canal de color físico: colores sRGB a lineal al entrar, luz en lineal,
  mapeo tonal ACES y sRGB al salir;
- cielo por **dispersión atmosférica** (Rayleigh y Mie, turbidez alta para la
  calima de Dubái) con disco solar; las mismas fórmulas, en JS, dan el color
  de la niebla y de la luz ambiente, para que horizonte, suelo y edificios
  casen sin costura;
- el cielo se renderiza a un **mapa cúbico** cada ~2 s; edificios y mar lo
  reflejan con Fresnel (cristal según el color de la fachada);
- **sombras reales** del sol (y de la luna de noche): terreno, edificios,
  hitos, coches, palmeras y avatares las proyectan y las reciben, con un
  encuadre que sigue a la cámara (350 m a pie, hasta 3,5 km en órbita);
- fachadas con forjados, retícula de ventanas, oclusión de contacto en la
  base y ventanas que se encienden al anochecer;
- mar con olas de varias frecuencias, brillo del sol, **profundidad leída del
  relieve** (turquesa en la orilla, azul en alta mar) y espuma en la costa;
- terreno con relieve fino de arena a partir de un ruido generado al
  arrancar; palmeras en la costa y por la ciudad baja; coches con
  habitáculo, ruedas y faros;
- avatares **articulados** en cinco piezas (tronco y cabeza, brazos y
  piernas) que andan y respiran, con cuatro estilos (casual, kandura y gutra,
  abaya, traje) y 16 colores; el nombre lleva ✓ cuando el vínculo está en la
  cadena.

Juicio: es más realista que la 0.9.0 en cada uno de esos puntos, y sigue
lejos de un motor comercial (sin oclusión ambiental de pantalla, sin
reflejos de la propia ciudad, sin texturas fotográficas). Lo siguiente en la
lista está en `PENDIENTE-v0.10.14.md`.

## 5. Cómo se ha comprobado (hecho)

- `rami-core`: `perfil_nombre_unico_vinculo_y_quema` (forma, activación,
  nombre único, vínculo firmado y ajeno, quema solo al registrar, cambio de
  nombre y liberación, binario sin Dubái que no admite el bloque).
- `rami-node`: `identidad_multiverso.rs` con las piezas reales (génesis,
  bloques minados, transacciones del monedero): perfil con vínculo, ficha
  `C1`/`C2`/`C3`/`F6`, dos puntas con dos ciudades y sus fantasmas.
- `cargo test --workspace --release --locked`, `tools/compat/roundtrip.sh`
  con v0.7.0, `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py`
  sin faltantes.
- Cliente 3D: capturas en Chromium sin pantalla (SwiftShader) antes y después
  del cambio, en vista de ciudad, a pie, al atardecer y de noche; y una sonda
  que traza rayos desde la cámara para saber qué objeto tapa la vista (así se
  encontró que a pie se aparecía dentro de un hito).

## 6. Lista para operadores

1. Actualiza a la 0.10.0 antes del 1 de diciembre de 2026.
2. Si quieres cara en la ciudad: panel → Dubái → «Mi perfil de jugador»,
   elige un nombre (2 RAMI quemados) y deja marcado «vincular a este nodo».
3. Si mueves el monedero a otro ordenador, el vínculo apunta al nodo
   antiguo: vuelve a guardar el perfil desde el nuevo (solo comisión).
4. `rami-wallet profile --handle NOMBRE …` desde la terminal crea o actualiza
   el perfil sin vínculo.
