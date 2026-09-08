# Seguridad de RAMI-Chain

RAMI-Chain es una **red de pruebas experimental**: la moneda no tiene valor
monetario, no es una inversión y nunca se vende. Aun así el código se trata
como si protegiera algo de valor, porque es la única forma de que un día lo
haga. Este documento resume el modelo de amenazas, lo que se comprueba y cómo
reportar un fallo.

## Reportar un fallo

Escribe a la dirección de contacto del repositorio o abre un *issue* marcado
como «seguridad» **sin** detalles explotables; se responderá con un canal
privado. No se paga recompensa (testnet sin valor), pero se acredita a quien
lo encuentre en `docs/AUDITORIA-2026-09.md`.

## Modelo de amenazas (qué defendemos y de quién)

| Superficie | Atacante | Defensa |
|---|---|---|
| **Panel local** (`127.0.0.1:8645`) | cualquier web abierta en tu navegador (CSRF, DNS rebinding), otro usuario/proceso de la máquina | solo escucha en loopback; `Host` **exacto** (`127.0.0.1:puerto`, `localhost:puerto`, `[::1]:puerto`); `Origin`/`Referer` deben ser el panel; todo POST en `application/json`; **token de sesión** (`~/.rami/panel-<puerto>.token`, 0600, como el `.cookie` de Bitcoin Core) en `X-Rami-Token` para toda orden `/api/*`; líneas, cabeceras y cuerpo acotados; timeouts; `X-Content-Type-Options`, `Referrer-Policy` |
| **Red P2P** (`0.0.0.0:30301`) | cualquier par de Internet | Túnel RAMI: identidad Ed25519 con **prueba de trabajo**, saludo firmado por ambas partes, X25519 efímero, HKDF-SHA256, ChaCha20-Poly1305 con contador; frames ≤ 16 MiB comprobados antes de reservar memoria; ≤ 4 peticiones de rama en vuelo por par, rondas por (par, punta), expulsión por cola llena; **topes de consenso** (≤ 4096 tx y ≤ 2 MiB por bloque) y de mempool (5000 tx, 64 por firmante); TOFU de identidades |
| **Actualizador** | quien controle la red (MITM) o el espejo web, pero no GitHub | HTTPS con rustls; `SHA256SUMS.txt` **solo desde GitHub** (el espejo solo sirve bytes); nombres de archivo saneados; nunca se instala nada con hash distinto; sin *downgrade*; **firma Ed25519 de release** (`SHA256SUMS.sig`) exigida en cuanto el monedero lleva la clave pública del mantenedor |
| **Claves** | robo del disco, corte de luz a mitad de escritura | keystore cifrado con PBKDF2-HMAC-SHA256 (600 000 iteraciones) + ChaCha20-Poly1305 con AAD; `node.key` y token con permisos 0600; escritura **atómica** (temporal + fsync + rename) |
| **Cadena de suministro** | dependencia con vulnerabilidad, acción de CI alterada, «puerta trasera» en un cambio | `Cargo.lock` con `--locked`; `cargo audit` semanal; **inventario de red y procesos** (`tools/security/inventory.py`) comparado con `SECURITY-INVENTORY.txt` en cada push: cualquier host, comando o variable nueva rompe el CI hasta revisarse; guardián de `process::exit`; escaneo de secretos |

## Autoauditoría con nuestra propia tecnología

El monedero incluye un «pentest» del Túnel RAMI (`rami_net::selftest`):
se conecta a su propio nodo comportándose como un par malicioso (saludo en
claro de v0.6.x, versión antigua, otra red, identidad sin prueba de trabajo,
firma manipulada, trama sin autenticar, trama gigante y avalancha de 256
puntas falsas) y comprueba que **cada intento es rechazado**. Además revisa
permisos de claves y token, que el panel solo escuche en local y el hash del
ejecutable frente a `BINARIES-SHA256.txt` del release.

- Panel: pestaña **Red → 🛡️ Autoauditoría de seguridad → Ejecutar**.
- Terminal, contra cualquier nodo: `rami-node audit --peer IP:30301 --network testnet`.
- CI: la misma batería corre en `cargo test` contra un nodo real
  (`selftest_passes_against_a_real_node`).

## Lo que NO está resuelto (honestidad)

- **Firmas de transacción no ligadas a la red.** El mensaje firmado es
  `"RAMI-CHAIN/tx/v1" || cuerpo`; una tx de regtest podría repetirse en
  testnet con la misma clave y nonce. Arreglo planeado (v0.8, cambio de
  consenso con activación por fecha): `"RAMI-CHAIN/tx/v2" || network_id || cuerpo`.
- **Bloques baratos a dificultad mínima.** Como toda cadena de trabajo joven,
  un atacante con CPU puede minar hermanos sobre bloques antiguos y hacer
  crecer el árbol (todo se conserva). Mitigación futura: trabajo mínimo
  relativo a la cabeza y puntos de control.
- **Instaladores sin firma de plataforma** hasta que existan los certificados
  de Apple/Microsoft (ver `SIGNING.md`). La firma Ed25519 de release cubre la
  integridad de la actualización automática, no los avisos del sistema.
- **Secretos en memoria:** las claves privadas se borran al soltar
  (`ed25519-dalek` implementa `ZeroizeOnDrop`), pero las copias temporales de
  32 bytes no se borran explícitamente.

Detalle de hallazgos y correcciones: [`docs/AUDITORIA-2026-09.md`](docs/AUDITORIA-2026-09.md).
Bytes del protocolo: [`chain/crates/rami-net/PROTOCOL.md`](chain/crates/rami-net/PROTOCOL.md).
