# PENDIENTE v0.7.3 (estado del PR; borrar al publicar el release)

La 0.7.1 y la 0.7.2 nunca se publicaron (no hay etiqueta ni release): la
última publicada es la **v0.7.0**. Esta rama acumula 0.7.1 + 0.7.2 + 0.7.3, y la
compatibilidad se ha probado contra la v0.7.0, que es de donde vienen los
usuarios.

## Verificado en esta sesión (Linux, Rust 1.94.1)

- `cargo test --workspace --locked` en verde (incluidos los 6 tests de
  `compat_v070`, 5 de `grado`, 5 de `calibracion`).
- `tools/compat/roundtrip.sh v0.7.0`: OK en las dos direcciones con los
  binarios reales (v0.7.0 escribe → 0.7.3 abre y escribe → v0.7.0 reabre,
  verifica, lee saldo, revela un commit de la nueva, arranca el nodo).
- `tools/panel/check.py`: sintaxis y 145 ids correctos; `gen_i18n.py` sin
  traducciones que falten; `tools/panel/lexico.py`: limpio en 5 idiomas.
- Panel ejecutado de verdad (`rami-gui --network regtest --label yo` contra
  un `rami-node` v0.7.0): Red muestra «F2» con motivos, «sincronizado ·
  altura 9 · mejor par 9», y el libro de predicciones apunta y resuelve.
- Web: sin desplazamiento horizontal de 360 a 1400 px; el mapa, las pestañas
  y los enlaces antiguos funcionan.

## Queda por hacer

1. Comprobación en navegador de verdad con ratón: motivos al pasar por el
   código de fuente, botones «Ocurrió / No ocurrió», selector de término.
2. Repetir la prueba en caliente de la 0.7.2 (panel abierto al actualizar).
3. `cargo audit --file chain/Cargo.lock` (lo corre `security.yml`).
4. Cross-check macOS/Windows (`cargo check --target x86_64-pc-windows-msvc`).
5. Release por `workflow_dispatch`; verificar `BINARIES-SHA256.txt`.
6. Mantenedor: `rami-wallet release-keygen`, `RAMI_RELEASE_SEED`,
   `RELEASE_PUBKEY_HEX`, clave pública en `SIGNING.md`.
7. Para más adelante: firma de tx ligada a la red (v0.8, cambio de
   consenso), acciones de GitHub fijadas por SHA, certificados de plataforma.
