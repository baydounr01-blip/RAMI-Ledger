# Auditoría de seguridad de RAMI-Chain — septiembre de 2026 (v0.7.0 → v0.7.1)

Motivo: un equipo externo de desarrollo indicó, tras mirar el repositorio,
que «hay muchos problemas de seguridad». No aportó detalles, así que se hizo
una revisión completa con el código público delante, buscando tanto fallos
como cualquier **puerta trasera** (telemetría, control remoto, exfiltración
de claves). Todo lo que sigue es verificable en el código.

## Resumen

- **Puertas traseras: ninguna.** Inventario completo de destinos de red,
  programas ejecutados, variables de entorno y sockets en
  `SECURITY-INVENTORY.txt`; ahora el CI falla si aparece uno nuevo.
- **Hallazgos corregidos en v0.7.1:** 2 altos, 6 medios, 4 bajos.
- **Pendientes documentados:** 2 (cambio de consenso planeado y certificados
  de plataforma). *Actualización v0.8.0:* el cambio de consenso está hecho
  (activación 2026‑10‑20); entra como pendiente la cota de timestamp.

## Hallazgos y correcciones

| # | Sev. | Dónde | Problema | Corrección |
|---|---|---|---|---|
| 1 | **Alta** | `rami-gui/main.rs` (guardia del panel) | La comprobación de `Host` usaba `starts_with("localhost")`/`starts_with("127.0.0.1")`: un dominio `localhost.evil.com` o `127.0.0.1.evil.com` resolviendo a 127.0.0.1 (DNS rebinding) pasaba la guardia y una web podía dar órdenes al monedero (enviar fondos si estaba desbloqueado, cerrar, instalar). | `Host` exacto con puerto; `Origin`/`Referer` deben ser el panel; **token de sesión** obligatorio en `/api/*` |
| 2 | **Alta** | `rami-node/update.rs` | El espejo web (`quantbot.army/descargas/latest.json`) anunciaba a la vez el instalador y la URL de `SHA256SUMS.txt`: un espejo comprometido podía servir un binario y «su» hash, y la verificación no probaba nada. | Las sumas (y su firma) se leen **siempre de GitHub** por la etiqueta del release; si GitHub no responde, no se instala nada. Firma Ed25519 de release (`SHA256SUMS.sig`) lista para activarse |
| 3 | Media | `rami-wallet/lib.rs` | El keystore se escribía con `fs::write` (no atómico): un corte a mitad dejaba un archivo truncado que la regla «nunca sobrescribir un keystore ilegible» convertía en un monedero inaccesible. | Escritura atómica: temporal 0600 + `fsync` + `rename` + `fsync` del directorio |
| 4 | Media | `rami-node/http.rs` | Sin timeouts ni límite de longitud de línea/cabeceras: un proceso local podía agotar hilos (slowloris) o memoria con una cabecera sin fin. | Líneas ≤ 8 KiB, ≤ 100 cabeceras, cuerpo ≤ 1 MiB, timeouts de 15 s, 413/400 explícitos |
| 5 | Media | `rami-core/state.rs` | Sin tope de transacciones ni bytes por bloque: un minero podía obligar a toda la red a validar y guardar bloques de hasta 16 MiB (el tope de trama). | Consenso: ≤ 4096 tx y ≤ 2 MiB por bloque, comprobado antes de hashear o verificar firmas |
| 6 | Media | `rami-node/lib.rs` | Mempool sin tope global ni por firmante. | 5000 tx en total, 64 por firmante, memoria de txids vistos acotada |
| 7 | Media | `rami-gui/main.rs` (`force_kill`) | Al tomar el relevo de otra instancia se mataba el `pid` que declaraba un `/api/status` ajeno: un proceso local malicioso escuchando en el puerto podía hacer que el monedero matara otro programa del usuario. | Solo se fuerza el cierre si el proceso se llama `rami-gui` (`/proc`, `ps`, `tasklist`) |
| 8 | Media | `rami-gui/main.rs` (`/api/status`) | Cualquier proceso local leía dirección, saldo y pares sin autenticación. | Sin token solo se devuelve versión, pid y network-id (lo que necesita la instancia única) |
| 9 | Baja | `rami-node/update.rs` | El nombre del instalador venía de una fuente remota y se usaba como nombre de archivo. | Saneado: letras, números, `.`, `-`, `_`; sin nombres ocultos |
| 10 | Baja | `rami-node/update.rs` (Windows) | La carpeta de instalación se interpolaba en PowerShell sin escapar comillas simples. | Escapado con la misma función que las rutas |
| 11 | Baja | `.github/workflows` | Acciones de terceros referenciadas por etiqueta (`@v4`) y sin `cargo audit`. | Nuevo `security.yml`: `cargo audit` semanal, inventario, secretos, tests. (Fijar por SHA: pendiente de hacerlo con acceso a la API) |
| 12 | Baja | panel | Sin `X-Content-Type-Options`/`Referrer-Policy`. | Añadidas en toda respuesta |

Verificado como **correcto** (sin cambios): TLS con rustls y certificados
del sistema en todas las descargas; sin `danger_accept_invalid`; PBKDF2
600 000 iteraciones con sal de 16 bytes y nonce aleatorio de 12 bytes con
AAD = clave pública; `verify_strict` de Ed25519 (rechaza claves de orden
pequeño); txid cubre la firma (anti-maleabilidad); coinbase acotada por
emisión + comisiones; PoW y bits LWMA comprobados antes de la transición de
estado; `unsafe` limitado al FFI de Cocoa (firmas exactas de `objc_msgSend`)
y a `_exit`; diálogos `osascript` con escapado de `\` y `"`; `three.min.js`
r150 sin código añadido (SHA-256
`72c8a8302444fb39cb8e04be1f556b2fdca798e606a99b4b37c8cfe3e3ee3272`); ningún
secreto en el repositorio; `Cargo.lock` con `--locked`.

## Inventario de red y procesos (puertas traseras: ninguna)

Todo lo que el software contacta o ejecuta, sacado del código (ver
`SECURITY-INVENTORY.txt`, comprobado en cada push):

- **Red saliente:** `api.github.com` y `github.com` (releases y sumas),
  `quantbot.army` (espejo de descargas y semillas), `seed.quantbot.army:30301`
  (semilla DNS), `nominatim.openstreetmap.org` (geocodificación, solo a
  petición del usuario), pares P2P que el usuario o el descubrimiento añaden,
  el router (NAT-PMP/UPnP, solo red local).
- **Escucha:** panel en `127.0.0.1:8645` (token), P2P en `0.0.0.0:30301`,
  descubrimiento UDP 30303.
- **Programas ejecutados:** navegador (`open`/`cmd start`/`$BROWSER`,
  `xdg-open`…), `osascript` y `defaults` (diálogos e idioma en macOS),
  `hdiutil`/`ditto`/`codesign`/`xattr` (instalar la actualización en macOS),
  `powershell.exe` (instalar en Windows), `/bin/sh` (relanzador), `kill`/`ps`
  y `taskkill`/`tasklist` (cerrar una instancia antigua **solo si es
  rami-gui**), `route` (puerta de enlace para el mapeo de puerto).
- **Variables de entorno:** `HOME`/`USERPROFILE`, `BROWSER`, `APPIMAGE`,
  `RAMI_WALLET_PASSWORD` (CLI), `RAMI_WEB_URL`, `RAMI_UPDATE_*` (pruebas),
  `RAMI_RELEASE_SEED` (firma de release en CI).
- **Sin telemetría, sin análisis, sin envío de claves ni direcciones a ningún
  servidor.** La única información que sale es la propia del protocolo P2P y
  las consultas descritas.

## Autoauditoría (nuevo en v0.7.1)

`rami_net::selftest` ataca un nodo real con nuestra propia tecnología y exige
que cada intento sea rechazado: saludo en claro, versión antigua, otra red,
identidad sin prueba de trabajo, firma manipulada, trama sin autenticar,
trama gigante, avalancha de puntas falsas. Disponible en el panel (Red →
Autoauditoría), en la terminal (`rami-node audit --peer …`) y en el CI.

## Pendiente

1. **Firma de transacción ligada a la red** — hecho en v0.8.0 (cambio de
   consenso con activación el 2026‑10‑20 00:00 UTC; `docs/CONSENSO-V2.md`).
   Queda abierto lo que salió al hacerlo: la cadena no acota el timestamp de
   los bloques (ver `SECURITY.md`).
2. **Certificados de plataforma** (Apple Developer ID / Authenticode) para
   instalar sin avisos; la firma Ed25519 de release se activa poniendo la
   clave pública en `RELEASE_PUBKEY_HEX` y la semilla en el secreto
   `RAMI_RELEASE_SEED` (`rami-wallet release-keygen`).
3. Fijar las acciones de GitHub por SHA de commit.
4. Trabajo mínimo relativo a la cabeza / puntos de control contra hermanos
   baratos.
