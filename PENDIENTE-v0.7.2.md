# PENDIENTE v0.7.2 (estado del PR; borrar al publicar el release)

## Verificado en esta sesión (Linux, Rust 1.94.1, Node 22)

- `cargo test --workspace --locked`: **102 tests en verde** (49 rami-core,
  29 rami-net —incluida la autoauditoría real por TCP contra un nodo—,
  13 rami-node lib, 5 sync, 1 update_e2e, 5 rami-wallet). Los 3 nuevos son los
  de regresión del token del panel.
- `cargo check -p rami-gui --locked`: sin errores (el `Cargo.lock` cuadra con
  0.7.2, por eso `--locked` no se queja).
- `node --check` sobre los dos bloques `<script>` de `dashboard.html` y sobre
  `i18n.js`: sintaxis correcta; `i18n.js` carga y da 375/377/377/377 claves
  (en/ru/sw/zh; en tiene 2 menos porque «Error: » y «Hash:» no se traducen).
- Cobertura de i18n de la pantalla nueva: los 7 textos del overlay pasan por el
  diccionario en los cuatro idiomas (solo queda sin traducir la ruta del
  archivo, que la reescribe el JS según el sistema).
- `tools/security/inventory.sh --check`: igual a `SECURITY-INVENTORY.txt`.
- Guardia de `process::exit` fuera de `hard_exit`: limpia.

## Corregido de la v0.7.1 en este PR

- El texto del instalador de Windows decía `Ejìútalo`; ahora `Ejecútalo`
  (`update.rs`, rama `#[cfg(target_os = "windows")]`).
- `i18n.js` no llegó a subirse con la v0.7.1: las cadenas nuevas del panel
  (autoauditoría, etc.) se veían en español en en/ru/sw/zh. Va en este PR.
- `README.md` y `web/index.html` / `web/en/index.html` tampoco llevaban la
  entrada de la v0.7.1. Van aquí, con la de la v0.7.2.
- Dos comentarios de sección intercambiados en `dashboard.html`
  («Autoauditoría» / «Añadir par»).

## Queda por hacer

1. **Comprobación en navegador de verdad** de la pantalla de recuperación:
   con el panel abierto, borrar `localStorage` → debe salir el overlay (no el
   de crear contraseña); pegar el contenido de `~/.rami/panel-<puerto>.token`
   → debe entrar. Repetir en los cinco idiomas.
2. **Prueba de la actualización en caliente**, que es el caso que rompió:
   abrir el panel con la v0.7.1, actualizar a la v0.7.2 y comprobar que la
   recarga automática entra sin pedir nada. (Los usuarios que vengan de la
   v0.7.1 se benefician del arreglo a partir de su *siguiente* actualización;
   los que estén bloqueados ahora deben reabrir desde el icono de la app.)
3. `cargo audit --file chain/Cargo.lock` (lo corre `security.yml`).
4. Cross-check en macOS (`ps` de macOS en `process_is_rami`) y en Windows (la
   rama `#[cfg(target_os = "windows")]` de `update.rs` no la compila el CI de
   Linux: convendría añadir un `cargo check --target x86_64-pc-windows-msvc`).
5. Release v0.7.2 por `workflow_dispatch`; verificar `BINARIES-SHA256.txt` en
   el release y que `security.yml` pasa entero.
6. Mantenedor: `rami-wallet release-keygen`, secreto `RAMI_RELEASE_SEED`,
   `RELEASE_PUBKEY_HEX` en `update.rs` y la clave pública en `SIGNING.md`.
7. Documentado para más adelante: firma de tx ligada a la red (v0.8), acciones
   de GitHub fijadas por SHA, certificados de plataforma.
