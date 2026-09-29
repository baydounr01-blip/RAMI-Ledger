# Auditoría de seguridad — 29 de septiembre de 2026 (tras la v0.11.0)

Alcance: los tres repositorios del proyecto tal como quedaron tras las
últimas integraciones — **RAMI-Ledger v0.11.0** (la escritura de vivienda, el
visor 3D y sus cinco módulos), **quantumbot547** (la clave maestra, licencias
y descarga de La Mesa, la web orbital) y **universal-timeline** (Cronochat con
el puente de email). Revisión de código con los ficheros delante, línea a
línea en las superficies que reciben datos de fuera (red P2P, consenso, panel,
funciones de Netlify, webhooks), más las pruebas de cada repositorio.

Método y límites, dichos claros:

- Se leyó el código; **no** se ejecutó ninguna prueba de intrusión contra un
  despliegue real. Cada hallazgo cita el fichero y la línea donde está.
- Las suites de referencia se pasaron antes de tocar nada: quantumbot547
  619/619; universal-timeline 27/27 (Node) y la batería de Python en verde;
  RAMI-Chain 74/74 en `rami-core` y 30/31 en `rami-net` (el que falla es el
  hallazgo R7). `rami-node` y `rami-wallet` no llegaron a correr porque cargo
  se detiene en el primer crate con fallo.
- Los parches de esta entrega **no se compilaron en la sesión que los
  escribió** (el entorno de esa sesión perdió la terminal a mitad de
  trabajo). Los verifica el CI del repositorio; hasta que esté en verde, la
  columna «Estado» de cada hallazgo dice «parche propuesto», no «corregido».

## Resumen

| Repositorio | Alto | Medio | Bajo | Info/endurecimiento |
|---|---|---|---|---|
| RAMI-Ledger | 2 (R1, R2) | 1 (R3) | 4 (R4–R7) | 4 (R8–R11) |
| quantumbot547 | 1 (Q1) | 1 (Q2) | 2 (Q3, Q4) | 3 (Q5–Q7) |
| universal-timeline | 0 | 2 (U1, U2) | 2 (U3, U4) | 2 (U5, U6) |

Puertas traseras: **ninguna** en los tres (destinos de red, programas
ejecutados y variables de entorno coinciden con lo declarado; en RAMI-Ledger
el inventario `SECURITY-INVENTORY.txt` sigue siendo exacto).

Lo que se revisó y quedó **correcto sin cambios**: la escritura de vivienda
(las cuatro transacciones comprueban nonce, saldo, dueño, topes y congelación
antes de mutar; toda la aritmética es `checked_*`; el comprador de una parcela
recibe solo las viviendas del vendedor), el handshake del Túnel RAMI
(transcripción con las dos identidades y las dos efímeras, claves distintas
por sentido, contador implícito, rechazo del todo‑ceros), el keystore (PBKDF2
600 000 iteraciones, sal y nonce aleatorios, AAD = clave pública), la guardia
del panel (Host exacto, Origin/Referer, token en tiempo constante, JSON
obligatorio), todos los `innerHTML` del panel que muestran datos de otros
(pares, bloques, transacciones, perfiles, mercado: pasan por `esc()`), el
webhook de Stripe de quantumbot547 (HMAC sobre el cuerpo crudo, tolerancia de
5 min, idempotencia por libro de pagos), las sesiones (HMAC-SHA256,
comparación en tiempo constante) y las licencias Ed25519 de La Mesa, la lista
blanca de destinatarios del puente de email de Cronochat (no es un repetidor
abierto) y la cápsula RSW de `timelock.py` (módulo de 2048 bits, Miller–Rabin
40 rondas, `secrets.SystemRandom`, etiqueta HMAC comparada en tiempo
constante).

## RAMI-Ledger

| # | Sev. | Dónde | Problema | Estado |
|---|---|---|---|---|
| R1 | **Alta** | `chain/crates/rami-net/src/lib.rs` (`Internal::Inbound`, `spawn_conn`) | Sin tope de conexiones entrantes en fase de saludo: cada TCP aceptado lanzaba un hilo con 5 s de espera. Unas 200 conexiones vacías por segundo mantenían ~1000 sockets abiertos y agotaban los descriptores del proceso entero (el panel local deja de responder, `chain.jsonl` no se escribe). Además `thread::spawn` entra en pánico si el sistema no da más hilos, y ese pánico ocurría **dentro del hilo central de la red**: el nodo se quedaba sin P2P hasta reiniciar, minando solo. | Parche propuesto: `MAX_PENDING_INBOUND = 64` (el exceso se cierra sin leer ni contestar), `thread::Builder::spawn` con el error registrado, y la plaza se libera en cuanto termina el saludo. Test `inbound_flood_does_not_kill_the_network` |
| R2 | **Alta** | `chain/crates/rami-node/src/lib.rs` (`Frame::Peers`), `rami-net/src/lib.rs` (`spawn_dialer`, `Cmd::Dial`) | Cada `Peers` recibido lanzaba hasta 8 marcados salientes (hilo + resolución DNS bloqueante + 5 s de conexión) sin ritmo, sin deduplicar y sin comprobar la dirección. Un par conectado podía mandar cientos de `Peers` por segundo: miles de hilos, `thread::spawn` en pánico en el hilo central (mismo efecto que R1), y el nodo abriendo conexiones a cualquier `host:puerto` que el par eligiera (nombres a resolver incluidos). | Parche propuesto, en el transporte: `MAX_DIALS_IN_FLIGHT = 32`; una misma dirección no se marca más de una vez cada 10 s (`DIAL_MEMORY`); forma de la dirección comprobada en `Network::dial` antes de gastar un hilo; `Builder::spawn`. Con eso un par hostil obtiene como mucho ~6 marcados por segundo en todo el proceso. Pendiente en el nodo: un `Peers` por par cada 30 s y solo `IP:puerto` literales (sin nombres que resolver). Test `dial_addr_shape_is_checked_before_spawning` |
| R3 | Media | `rami-node/src/lib.rs` (`on_presence`, `on_chat`) | El ritmo mínimo por identidad (400 ms / 1,5 s) se comprueba **después** de verificar la firma Ed25519 (~50 µs) y la prueba de trabajo. Un par conectado fuerza una verificación por frame: a 20 000 frames/s satura un núcleo del nodo. | Pendiente (cambio pequeño: comprobar `seq` y el ritmo antes de `ed_verify`). No se incluye en esta entrega para no tocar el metaverso sin poder correr su batería |
| R4 | Baja | `chain/crates/rami-node/src/http.rs` (`serve`) | Un hilo por conexión sin tope para el panel. Solo escucha en loopback: lo explota otro proceso local, no la red. | Endurecimiento pendiente (mismo tope que R1) |
| R5 | Baja | `rami-node/src/http.rs` (`write_response`) | El panel no manda `X-Frame-Options` ni `Content-Security-Policy`. La guardia de Host/Origin/token impide dar órdenes desde otra web, pero una web puede enmarcar `http://127.0.0.1:8645/` (el navegador no lo bloquea por defecto) y superponer su interfaz. | Endurecimiento pendiente: `X-Frame-Options: DENY` y `frame-ancestors 'none'` en toda respuesta |
| R6 | Baja | `.github/workflows/release.yml` (paso «Publicar Release») | `TAG="${{ github.event.inputs.tag \|\| github.ref_name }}"` se interpola en el `run:`; un nombre de etiqueta o una entrada de `workflow_dispatch` con `$(…)` ejecutaría en el runner con `contents: write`. Solo lo puede disparar quien ya tiene permiso de escritura, así que no es una escalada; es la forma que GitHub documenta como inyección de script. | Endurecimiento pendiente: pasar el valor por `env:` (como ya hace el paso de empaquetado) |
| R7 | Baja | `rami-net/src/identity.rs` (test `file_roundtrip_and_creation_time`) | El test exige crear la identidad en < 20 s; la búsqueda del nonce es geométrica (media 2^20 hashes, sin tope) y en el perfil `test` corrió en 20,3 s: falla en máquinas cargadas y bloquea el resto de la suite (`rami-node` y `rami-wallet` no llegan a ejecutarse). | Parche propuesto: 60 s, con la explicación en el test |
| R8 | Info | `chain/.rami/gui-launch.log`, `chain/gui3.log`, `chain/c3/` | Ficheros de una sesión local de regtest en git (rutas de la máquina del desarrollador, un `chain.jsonl` de pruebas). Sin secretos. | Higiene pendiente: `git rm` y añadir `chain/.rami/`, `chain/*.log`, `chain/c3/` a `.gitignore` |
| R9 | Info (conocido) | `rami-node/src/update.rs` | `RELEASE_PUBKEY_HEX` sigue vacía: la firma Ed25519 de release no se exige todavía; la actualización descansa en TLS + `SHA256SUMS.txt` desde GitHub. | Documentado en `SECURITY.md`; activar con `rami-wallet release-keygen` |
| R10 | Info (conocido) | `rami-core/src/blocktree.rs` (`insert`) | Un bloque hermano sobre un bloque antiguo reproduce el estado del padre desde el génesis (coste O(altura)); con dificultad mínima sale barato. | Documentado («bloques baratos»); trabajo mínimo relativo a la cabeza pendiente |
| R11 | Endurecimiento | `netlify.toml` (web), `rami-wallet/src/lib.rs` (keystore) | La web pública sin `Content-Security-Policy` (tiene `X-Frame-Options`, `nosniff` y `Referrer-Policy`); el keystore con PBKDF2 en vez de Argon2id (exige dependencia nueva y regenerar `Cargo.lock`). | Pendiente |

### Lo que se buscó en la escritura de vivienda y no apareció

Creación de dinero (todos los pagos son transferencias exactas con
`checked_add`/`checked_sub`; nada se quema salvo donde se dice); estado a
medias (las cuatro transacciones y `apply_tx_sin_rastro` reponen cuenta y
`quemado` en un rechazo); saltarse el tope de 16 viviendas ajenas (se
comprueba antes de mutar en `TransferUnit` y `BuyUnit`, y `BuyParcel` resta
las que pasan a ser propias); vender una vivienda congelada por la venta de la
parcela; comprarse a uno mismo; precio 0 como compra gratis (retira la venta);
desbordamiento en `Rent` (`term ≤ 525 600`), `Harvest` y `spend`; orden de
iteración no determinista (`BTreeMap` donde se recorre); tamaño por
transacción (4 KiB) y por bloque (4096 tx, 2 MiB) antes de firmar o hashear.

## quantumbot547

| # | Sev. | Dónde | Problema | Estado |
|---|---|---|---|---|
| Q1 | **Alta** | `netlify/functions/_lib/access-config.mjs:28` (`DEFAULT_MASTER_KEY = 'SSS777'`) | Una clave maestra de **6 caracteres escrita en el repositorio público** abre el panel de señales (`/api/access` → identidad `master-key`, producto `signals`) en todo despliegue que no configure `QUANTUM_MASTER_KEY`. No hace falta adivinarla: está en el código; el limitador de intentos no protege de eso. El propio fichero lo llama «una decisión del propietario tomada a sabiendas» y La Mesa sí está protegida (`masterKeyIsPrivate` deja `masterKey = null` en `/api/licence` y `/api/desk-download`). Aun así es una puerta pública a un producto de pago y un valor que no caduca ni se revoca. Los comentarios de cabecera de `access.mts` (líneas 13‑15 y 53‑55) seguían diciendo que «no hay respaldo escrito en el código», lo contrario de lo que hace el sistema. | Decisión del propietario. Recomendación: quitar el respaldo y que `check:access-config` genere e imprima UNA maestra aleatoria en el log del build cuando falte la variable (sigue sin 503 y sin valor público). Esta entrega corrige los comentarios de `access.mts` para que digan la verdad |
| Q2 | Media | `script.js:1263` (`link.href = item.link \|\| '#'`) | El enlace de cada titular sale tal cual del RSS de terceros. Un feed comprometido, o un intermediario en su TLS, entrega `javascript:` y el clic ejecuta código en el origen de la web, que no tenía CSP (ver Q3). | Parche de una línea en el informe de ese repositorio (`docs/auditoria-2026-09-29.md`), para aplicarlo con el fichero delante: solo `http(s)://`; lo demás va a `#` |
| Q3 | Baja | `netlify.toml` | Sin `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` ni HSTS. La página no carga scripts externos (lo fija `tests/web-orbital.test.mts`): una CSP estricta es viable. | Parche propuesto: cabeceras para `/*` (`script-src 'self'`, `connect-src 'self'`, fuentes de Google en `style-src`/`font-src`, `frame-ancestors 'none'`, `object-src 'none'`) |
| Q4 | Baja | `desk/config.mts` (`nodeConfigIo.writeText`) | Los ficheros de configuración de La Mesa se escriben con el `umask` por defecto (legibles por otros usuarios de la máquina). Hoy no llevan el secreto de la API (se pasa por opciones), pero llevan la política y los techos de riesgo del comprador. | Parche propuesto: `mode 0o600` en el fichero y `0o700` en la carpeta (sin efecto en Windows) |
| Q5 | Info | `netlify/functions/access.mts`, `licence.mts`, `desk-download.mts` (`requestIp`) | El limitador toma la IP de `x-nf-client-connection-ip` y, si falta, de `x-forwarded-for`. En Netlify la primera la pone la plataforma; en cualquier otro alojamiento la segunda la escribe el cliente y el límite por IP se salta. | Documentar; en Netlify no aplica |
| Q6 | Info | `access-session.mts` | Sesión de 30 días sin revocación (testigo firmado sin estado). El fichero lo declara como «límite honesto». | Conocido |
| Q7 | Info | `server.js` (servidor local/Vercel) | `PATCH /api/payments/:id` cambia el estado a `customer_reported` sin autenticación: es el diseño (el cliente avisa de que pagó; la confirmación bancaria es aparte). | Sin cambio |

## universal-timeline

| # | Sev. | Dónde | Problema | Estado |
|---|---|---|---|---|
| U1 | Media | `netlify/functions/cronochat.mjs` (`POST`) | Sin límite de ritmo ni de salas: cualquiera crea salas sin fin (nombre de 1‑40 caracteres), cada una con hasta 500 mensajes de 2 KB y 20 anclas de hasta 256 códigos × 200 caracteres. Coste en Netlify Blobs y en el cartero (U2) sin tope. | Pendiente: límite persistente por IP como el de quantumbot547 y tope global de salas |
| U2 | Media | `netlify/functions/correo-programado.mjs` | Cada minuto lista **todos** los blobs y lee cada mensaje para ver si debe salir. Con N mensajes son N lecturas por minuto para siempre; unido a U1, el coste lo fija quien llene salas. | Pendiente: índice de mensajes con correo pendiente (`_pendientes/<id>`) |
| U3 | Baja | `netlify/functions/correo-entrante.mjs` | La clave del webhook viaja en la URL (`?clave=`): queda en los registros del proveedor de correo, de Netlify y de cualquier proxy. Comparación en tiempo constante correcta. | Parche propuesto: se acepta también `Authorization: Bearer …` y la documentación lo recomienda |
| U4 | Baja | `_lib/cronologia.mjs` (`vistaDe`), `docs/CRONOCHAT.md` §2 | Los mensajes «sellados» al futuro se guardan **en claro** en el almacén; el sello lo aplica el servidor al servirlos. Quien administre el sitio o el almacén los lee antes de hora. El compromiso SHA‑256 (nonce de 72 bits oculto hasta la apertura) sí protege la integridad. | Parche propuesto: decirlo en la documentación. Cifrar en reposo con la cápsula RSW del propio repositorio es la siguiente entrega |
| U5 | Info | `correo-entrante.mjs` | Cualquiera que envíe un email a `sala@dominio` publica en esa sala con el nombre del remitente (falsificable). Coherente con que las salas son públicas y sin cuenta. | Diseño; documentado |
| U6 | Info | `web/app.js`, `netlify.toml` | Todo el texto se pinta con `textContent`; CSP con `frame-ancestors 'none'` presente. | Correcto |

## Cambios de esta entrega

RAMI-Ledger:

- `chain/crates/rami-net/src/lib.rs`: R1 y R2 (topes, memoria de marcados,
  `Builder::spawn`, `dial_addr_ok`) y dos tests nuevos.
- `chain/crates/rami-net/src/identity.rs`: R7.
- `chain/crates/rami-net/src/sharami.rs` y `docs/SHARAMI.md`: el cifrado
  SHARAMI v1 con su batería (nueve tests). No toca consenso ni protocolo.
- `SECURITY.md`: esta auditoría en el modelo de amenazas y en los pendientes.

quantumbot547: Q1 (comentarios), Q3, Q4; Q2 queda como parche de una línea
en el informe de ese repositorio (`docs/auditoria-2026-09-29.md`), para
aplicarlo con el fichero delante. universal-timeline: U3 (con test), U4.

## Pendiente (por orden)

1. Compilar y pasar `cargo test --release --locked` sobre esta entrega (el
   CI lo hace en cada push); R3, R4, R5, R6 y R8, y la parte del nodo de R2,
   en la siguiente.
2. quantumbot547: decidir sobre Q1 (la maestra de respaldo). Mientras exista,
   `STRICT_ACCESS_CONFIG=true` en producción es la única forma de que un
   despliegue sin variables no arranque con ella.
3. universal-timeline: U1 y U2 antes de anunciar Cronochat a más gente.
4. SHARAMI: integración en la red (`docs/SHARAMI.md` §8) y el modo híbrido
   post-cuántico cuando `ml-kem` esté en `Cargo.lock`.
