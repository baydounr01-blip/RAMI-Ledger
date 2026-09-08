# PENDIENTE v0.7.1 (borrar antes de publicar el release)

## Lo que se verificó de verdad

En la sesión que escribió este código (Linux, Rust 1.94), con el árbol de
trabajo completo delante:

- `cargo check --workspace --all-targets`: sin errores.
- `cargo test --workspace`: **99 tests en verde** (unidad + integración real
  por TCP, incluida la autoauditoría contra un nodo en ejecución).
- `cargo metadata --locked`: `Cargo.lock` coherente con 0.7.1.
- `gen_i18n.py`: `i18n.js` regenerado, 0 claves sin traducir en en/zh/ru/sw.
- `tools/security/inventory.sh --check`: idéntico a `SECURITY-INVENTORY.txt`.
- Guardia de `process::exit` y escaneo de secretos: limpios.
- `packaging/smoke.sh linux`: arranque, `/api/status` y «Salir» correctos.
- E2E con un `rami-gui` real: token de 64 hex con permisos 0600; `/api/status`
  sin token devuelve solo versión, pid y network-id; `/?t=…` abre el panel;
  `rami-node audit --peer` contra el nodo del monedero funciona.
  - La primera pasada marcó 2 de 9 comprobaciones como fallidas («trama sin
    autenticar» y «trama gigante»). Era un fallo de la propia autoauditoría:
    leía las puntas legítimas que un nodo real envía nada más terminar el
    saludo y las tomaba por «el nodo siguió». Corregido en `wait_closed`
    (`rami-net/src/selftest.rs`): ahora ignora el tráfico legítimo y solo
    cuenta que la conexión acabe cerrada.

## Lo que NO se ha podido verificar en la rama

La sesión perdió el acceso a la terminal (git y cargo bloqueados) antes de
poder empujar, así que los archivos se subieron **uno a uno por la API de
GitHub, transcritos desde el árbol de trabajo**. El código Rust lo revalida
el CI al compilar y pasar los tests; `dashboard.html` no lo comprueba nadie
automáticamente. Antes de publicar el release hay que:

1. **Abrir el panel en un navegador** y comprobar a mano:
   - la app lo abre con `?t=<token>` y las órdenes funcionan;
   - una pestaña abierta a mano (sin `?t=`) muestra el aviso 🔑 y no puede
     dar órdenes;
   - Red → «Ejecutar autoauditoría» devuelve 9/9 ✓ más las locales;
   - las cinco lenguas siguen cambiando bien.
2. `cargo test --release --locked` en local (el CI ya lo hace en cada push).
3. Repetir el E2E: `rami-node audit --peer 127.0.0.1:<P2P> --chain DIR` →
   9/9 ✓; `POST /api/audit` con `Content-Type: application/json` y
   `X-Rami-Token`; sin token, o con `Host: localhost.evil.com:<puerto>`, la
   respuesta debe ser `{"ok":false,…}`.

## Correcciones conocidas antes de publicar

- `chain/crates/rami-node/src/update.rs`, rama `#[cfg(target_os = "windows")]`
  de `apply_windows`: el mensaje dice `Ejìútalo`; debe decir `Ejécutalo`.
  Solo afecta al texto que ve un usuario de Windows al descargar sin
  relanzar; no compila en Linux, así que el CI no lo detecta.

## Archivos que quedaron fuera de la rama

Estos cambios existieron solo en el contenedor efímero de aquella sesión y
**no están en el PR**. Ninguno impide compilar ni publicar, pero conviene
rehacerlos:

- `chain/crates/rami-gui/src/i18n.js` y `chain/crates/rami-gui/i18n-src/*`:
  las 10 claves nuevas del panel (tarjeta de autoauditoría, aviso de la llave
  de sesión). Sin ellas el panel funciona, pero esos textos salen en español
  en inglés, chino, ruso y suajili. Para rehacerlo: añadir las claves a
  `i18n-src/allkeys.json` y a los cuatro `lang_*.json`, y ejecutar
  `python3 chain/crates/rami-gui/i18n-src/gen_i18n.py`.
- `README.md`: entrada de la v0.7.1 en la hoja de ruta.
- `web/index.html` y `web/en/index.html`: tarjeta «VERIFICABLE».

## Después de fusionar

1. Release v0.7.1 por `workflow_dispatch` de `release.yml`; comprobar que el
   release publica `BINARIES-SHA256.txt` y que `security.yml` pasa
   (cargo audit, inventario, secretos, tests).
2. Mantenedor: `rami-wallet release-keygen`, guardar la semilla como secreto
   `RAMI_RELEASE_SEED`, poner la clave pública en `RELEASE_PUBKEY_HEX`
   (`update.rs`) y en `SIGNING.md`. Desde la versión siguiente, una
   actualización sin firma válida se rechaza.
3. Documentado para más adelante: firma de tx ligada a la red (cambio de
   consenso v0.8), acciones de GitHub fijadas por SHA, certificados de
   plataforma (Apple / Authenticode).
