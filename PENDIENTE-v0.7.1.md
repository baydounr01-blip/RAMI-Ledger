# PENDIENTE v0.7.1 (estado del PR; borrar al publicar el release)

Hecho y verificado en la sesión que preparó este PR (Linux, Rust 1.94):

- `cargo check --workspace --all-targets`: sin errores.
- `cargo test --workspace`: 99 tests en verde (unidad + integración real por
  TCP, incluida la autoauditoría contra un nodo real).
- `cargo metadata --locked`: `Cargo.lock` coherente con 0.7.1.
- `gen_i18n.py`: `i18n.js` regenerado; 0 claves sin traducir en en/zh/ru/sw.
- `tools/security/inventory.sh --check`: igual a `SECURITY-INVENTORY.txt`
  (regenerado con el script; los tests de integración `crates/*/tests/` ya
  no se inventarían porque no entran en los binarios).
- Guardia de `process::exit` y escaneo de secretos: limpios.
- `packaging/smoke.sh linux`: arranque, `/api/status` y «Salir» correctos.
- E2E con `rami-gui` real: token de 64 hex con permisos 0600; `/api/status`
  sin token devuelve solo versión, pid y network-id; `/?t=…` abre el panel;
  `rami-node audit --peer` contra el nodo del monedero funciona.
  - La primera pasada marcó 2 de 9 comprobaciones como fallidas («trama sin
    autenticar» y «trama gigante»). Era un fallo de la propia autoauditoría:
    leía las puntas legítimas que un nodo real manda nada más terminar el
    saludo y las tomaba por «el nodo siguió». Corregido en `wait_closed`
    (`selftest.rs`): ahora ignora el tráfico legítimo y solo cuenta que la
    conexión acabe cerrada. La corrección quedó sin volver a ejecutar contra
    el binario porque la sesión perdió el acceso a la terminal; el CI
    (`security.yml`, `selftest_passes_against_a_real_node`) la compila y el
    paso 1 de abajo la verifica a mano.

Queda por hacer (tras fusionar, con terminal):

1. Repetir el E2E: arrancar `rami-gui`, `rami-node audit --peer 127.0.0.1:<P2P>
   --chain DIR` → 9/9 ✓; `POST /api/audit` con `Content-Type: application/json`
   y `X-Rami-Token` → todo ✓; sin token o con `Host: localhost.evil.com:puerto`
   la respuesta debe ser `{"ok":false,…}`.
2. `cargo audit --file chain/Cargo.lock` (lo corre `security.yml`).
3. Cross-check darwin (`ps` de macOS en `process_is_rami`) y Playwright del
   botón «Ejecutar autoauditoría» en los cinco idiomas.
4. Release v0.7.1 por `workflow_dispatch`; verificar `BINARIES-SHA256.txt` en
   el release y que `security.yml` pasa (cargo audit, inventario, secretos,
   tests).
5. Mantenedor: `rami-wallet release-keygen`, secreto `RAMI_RELEASE_SEED`,
   `RELEASE_PUBKEY_HEX` en `update.rs` y la clave pública en `SIGNING.md`.
6. Documentado para más adelante: firma de tx ligada a la red (v0.8),
   acciones de GitHub fijadas por SHA, certificados de plataforma.
