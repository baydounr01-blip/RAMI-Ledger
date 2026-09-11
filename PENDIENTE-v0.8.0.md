# PENDIENTE v0.8.0 (estado del PR; borrar al publicar el release)

Primer cambio de consenso: firma de transacción ligada a la red, activación
el **2026‑10‑20 00:00 UTC** (`docs/CONSENSO-V2.md`). Antes de esa fecha la
0.8.0 es indistinguible de la 0.7.3 para la red y para los archivos.

## Verificado en esta sesión (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde (rami-core 53 con las
  pruebas de regla v1/v2 y de red ajena; rami-net con `Status.rule` en las dos
  direcciones; rami-node `activacion_v2` con las piezas reales; `compat_v070`
  intacto).
- `tools/compat/roundtrip.sh v0.7.0` y `tools/compat/roundtrip.sh 3c2c4bf`
  (v0.7.3): OK, incluido el paso 4 (activación forzada en regtest; la antigua
  abre, avisa de los bloques que no entiende, lee saldo, mina su rama y
  arranca; la nueva vuelve a abrir lo que la antigua escribió).
- `tools/panel/check.py`, `gen_i18n.py` (sin traducciones que falten en 4
  idiomas) y `tools/panel/lexico.py` limpios.

## Queda por hacer

1. Publicar la v0.8.0 con margen antes del 20 de octubre y avisar en la web y
   en el panel (el actualizador la ofrecerá solo).
2. El día de la activación: mirar en Red → «Regla de firma» cuántos pares
   anuncian v2 y reenviar lo que quedara pendiente.
3. Cota de timestamp de los bloques (otro cambio de consenso; `SECURITY.md`).
4. Los puntos que siguen de la v0.7.3: prueba en navegador con ratón, cross-check
   macOS/Windows, release por `workflow_dispatch`, claves de release,
   acciones de GitHub fijadas por SHA, certificados de plataforma.
