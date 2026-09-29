# Auditoría de seguridad — 29 de septiembre de 2026 (v0.11.0)

Alcance: RAMI-Ledger tal como quedó tras las integraciones de la v0.11.0 (la
escritura de vivienda, el visor 3D y sus cinco módulos, el multiverso y el
mercado). Revisión de código con los ficheros delante, línea a línea en las
superficies que reciben datos de fuera: la red P2P (Túnel RAMI y los frames
del nodo), el consenso (`rami-core`), el panel local y su HTML, el keystore,
el actualizador y la cadena de suministro (workflows y ficheros del
repositorio).

Método y límites, dichos claros:

- Se leyó el código; **no** se ejecutó ninguna prueba de intrusión contra un
  nodo real ajeno. Cada hallazgo cita el fichero y la función donde está.
- La suite de referencia se pasó antes de tocar nada: 74/74 en `rami-core` y
  30/31 en `rami-net` (el que falla es el hallazgo R7). `rami-node` y
  `rami-wallet` no llegaron a correr porque cargo se detiene en el primer
  crate con fallo.
- Los parches se escribieron desde una sesión sin terminal. Los compiló y
  probó el CI del PR que los trae (`security.yml`: `cargo test --release
  --locked`), que pasó la suite completa en la cabeza `22aaac7`; el primer
  intento falló por una `á` dentro de un literal de bytes y se corrigió.

## Resumen

| Alto | Medio | Bajo | Info/endurecimiento |
|---|---|---|---|
| 2 (R1, R2) | 1 (R3) | 4 (R4–R7) | 4 (R8–R11) |

Puertas traseras: **ninguna**. Destinos de red, programas ejecutados y
variables de entorno coinciden con `SECURITY-INVENTORY.txt`, que el CI sigue
comprobando en cada push.

Lo que se revisó y quedó **correcto sin cambios**: la escritura de vivienda
(las cuatro transacciones comprueban nonce, saldo, dueño, topes y congelación
antes de mutar; toda la aritmética es `checked_*`; el comprador de una parcela
recibe solo las viviendas del vendedor), el handshake del Túnel RAMI
(transcripción con las dos identidades y las dos efímeras, claves distintas
por sentido, contador implícito, rechazo del todo‑ceros), el keystore (PBKDF2
600 000 iteraciones, sal y nonce aleatorios, AAD = clave pública), la guardia
del panel (Host exacto, Origin/Referer, token en tiempo constante, JSON
obligatorio) y todos los `innerHTML` del panel que muestran datos de otros
(pares, bloques, transacciones, perfiles, mercado: pasan por `esc()`).

## Hallazgos

| # | Sev. | Dónde | Problema | Estado |
|---|---|---|---|---|
| R1 | **Alta** | `chain/crates/rami-net/src/lib.rs` (`Internal::Inbound`, `spawn_conn`) | Sin tope de conexiones entrantes en fase de saludo: cada TCP aceptado lanzaba un hilo con 5 s de espera. Unas 200 conexiones vacías por segundo mantenían ~1000 sockets abiertos y agotaban los descriptores del proceso entero (el panel local deja de responder, `chain.jsonl` no se escribe). Además `thread::spawn` entra en pánico si el sistema no da más hilos, y ese pánico ocurría **dentro del hilo central de la red**: el nodo se quedaba sin P2P hasta reiniciar, minando solo. | **Corregido**: `MAX_PENDING_INBOUND = 64` (el exceso se cierra sin leer ni contestar), `thread::Builder::spawn` con el error registrado, y la plaza se libera en cuanto termina el saludo. Test `inbound_flood_does_not_kill_the_network` |
| R2 | **Alta** | `chain/crates/rami-node/src/lib.rs` (`Frame::Peers`), `rami-net/src/lib.rs` (`spawn_dialer`, `Cmd::Dial`) | Cada `Peers` recibido lanzaba hasta 8 marcados salientes (hilo + resolución DNS bloqueante + 5 s de conexión) sin ritmo, sin deduplicar y sin comprobar la dirección. Un par conectado podía mandar cientos de `Peers` por segundo: miles de hilos, `thread::spawn` en pánico en el hilo central (mismo efecto que R1), y el nodo abriendo conexiones a cualquier `host:puerto` que el par eligiera (nombres a resolver incluidos). | **Corregido en el transporte**: `MAX_DIALS_IN_FLIGHT = 32`; una misma dirección no se marca más de una vez cada 10 s (`DIAL_MEMORY`); forma de la dirección comprobada en `Network::dial` antes de gastar un hilo; `Builder::spawn`. Con eso un par hostil obtiene como mucho ~6 marcados por segundo en todo el proceso. **Pendiente en el nodo**: un `Peers` por par cada 30 s y solo `IP:puerto` literales (sin nombres que resolver). Test `dial_addr_shape_is_checked_before_spawning` |
| R3 | Media | `rami-node/src/lib.rs` (`on_presence`, `on_chat`) | El ritmo mínimo por identidad (400 ms / 1,5 s) se comprueba **después** de verificar la firma Ed25519 (~50 µs) y la prueba de trabajo. Un par conectado fuerza una verificación por frame: a 20 000 frames/s satura un núcleo del nodo. | Pendiente (cambio pequeño: comprobar `seq` y el ritmo antes de `ed_verify`). No entra en esta entrega para no tocar `rami-node/src/lib.rs` sin poder correr su batería en local |
| R4 | Baja | `chain/crates/rami-node/src/http.rs` (`serve`) | Un hilo por conexión sin tope para el panel. Solo escucha en loopback: lo explota otro proceso local, no la red. | Endurecimiento pendiente (mismo tope que R1) |
| R5 | Baja | `rami-node/src/http.rs` (`write_response`) | El panel no mandaba `X-Frame-Options` ni `Content-Security-Policy`. La guardia de Host/Origin/token impide dar órdenes desde otra web, pero una web podía enmarcar `http://127.0.0.1:8645/` (el navegador no lo bloquea por defecto) y superponer su interfaz para engañar con clics. | **Corregido**: `X-Frame-Options: DENY` y `Content-Security-Policy: frame-ancestors 'none'` en toda respuesta (`response_head`). Test `every_response_refuses_framing` |
| R6 | Baja | `.github/workflows/release.yml` (paso «Publicar Release») | `TAG="${{ github.event.inputs.tag \|\| github.ref_name }}"` se interpolaba en el `run:`; un nombre de etiqueta o una entrada de `workflow_dispatch` con `$(…)` ejecutaría en el runner con `contents: write`. Solo lo puede disparar quien ya tiene permiso de escritura, así que no es una escalada; es la forma que GitHub documenta como inyección de script. | **Corregido**: la etiqueta entra por `env:` (como ya hacía el paso de empaquetado) |
| R7 | Baja | `rami-net/src/identity.rs` (test `file_roundtrip_and_creation_time`) | El test exigía crear la identidad en < 20 s; la búsqueda del nonce es geométrica (media 2^20 hashes, sin tope) y en el perfil `test` corrió en 20,3 s: fallaba en máquinas cargadas y bloqueaba el resto de la suite (`rami-node` y `rami-wallet` no llegaban a ejecutarse). | **Corregido**: 60 s, con la explicación en el test |
| R8 | Info | `chain/.rami/gui-launch.log`, `chain/gui3.log`, `chain/c3/` | Ficheros de una sesión local de regtest en git (rutas de la máquina del desarrollador, un `chain.jsonl` de pruebas). Sin secretos. | **Corregido**: fuera de git, y `chain/.rami/`, `chain/*.log` y `chain/c3/` en `.gitignore` |
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

### Lo que se buscó en el Túnel RAMI y no apareció

Confusión de claves entre sentidos (`k_i2r`/`k_r2i` distintas, contador
propio por sentido); repetición o reordenación de frames (el contador no
viaja y un frame que no autentica corta); intermediario (la transcripción
firmada lleva las dos identidades y las dos efímeras); puntos de orden pequeño
(el todo‑ceros se rechaza); coste antes de autenticar (la prueba de trabajo de
la identidad se comprueba antes de cualquier operación de curva); frames
mayores de 16 MiB (se cortan antes de reservar memoria).

## Cambios de esta entrega

- `chain/crates/rami-net/src/lib.rs`: R1 y R2 (topes, memoria de marcados,
  `Builder::spawn`, `dial_addr_ok`) y dos tests nuevos.
- `chain/crates/rami-net/src/identity.rs`: R7.
- `chain/crates/rami-node/src/http.rs`: R5, con test.
- `.github/workflows/release.yml`: R6.
- `.gitignore` y los ficheros retirados: R8.
- `chain/crates/rami-net/src/sharami.rs` y `docs/SHARAMI.md`: el cifrado
  SHARAMI v1 con su batería (nueve tests). No toca consenso ni protocolo.
- `SECURITY.md`: esta auditoría en el modelo de amenazas y en los pendientes.

## Pendiente (por orden)

1. R3 y la parte del nodo de R2 (los dos en `rami-node/src/lib.rs`), R4.
2. SHARAMI: integración en la red (`docs/SHARAMI.md` §8: frame, lote por
   ventana, relé, panel) y el modo híbrido post-cuántico cuando `ml-kem` esté
   en `Cargo.lock`.
3. R11: CSP en la web pública; Argon2id en el keystore.
