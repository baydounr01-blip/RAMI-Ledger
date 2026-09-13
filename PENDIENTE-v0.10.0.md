# PENDIENTE v0.10.0 (estado de la rama; borrar al publicar el release)

Identidad del jugador en la cadena (`SetProfile`, misma fecha de activación
que Dubái: **2026‑12‑01 00:00 UTC**), ficha con código de fuente, el
multiverso como ciudades paralelas y un cliente 3D con luz física
(`docs/MULTIVERSO.md`).

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde: rami-core
  (`perfil_nombre_unico_vinculo_y_quema`), rami-node
  (`identidad_multiverso.rs` con las piezas reales), rami-net, rami-wallet.
- `tools/compat/roundtrip.sh v0.7.0`, `tools/panel/check.py`,
  `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes en cuatro idiomas,
  `tools/security/inventory.sh --check`.
- Humo del panel en regtest con Dubái activo: perfil con vínculo, avatar
  verificado, directorio, ficha por nombre, multiverso y ciudad de una punta,
  reapertura de la cadena con el perfil intacto.
- Capturas del cliente 3D en Chromium sin pantalla (SwiftShader), antes y
  después, en ciudad, a pie, atardecer y noche.

## Queda por hacer

1. Probar el cliente 3D con GPU real y con gafas (Quest/Pico/SteamVR): el
   coste de las sombras a 4K y el mapa cúbico cada 2 s.
2. Oclusión ambiental de pantalla, reflejos de la propia ciudad y texturas
   fotográficas con licencia abierta (el siguiente salto de realismo).
3. Previsiones de negocio con la escala de siete términos (commit-reveal
   sobre los ingresos de una empresa) y su calibración en la ficha.
4. Hitos sobre el agua: algún hito de las islas artificiales (p. ej. Atlantis
   The Royal) cae fuera del relieve estampado y se dibuja al nivel del mar en
   vez de sobre tierra. Es del dataset (`tools/geo/build_dubai.py`), viene de
   la 0.9.0 y se arregla ampliando el estampado o dándole plataforma al hito.
5. Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
   cota de timestamp de los bloques, certificados de plataforma.
