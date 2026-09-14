# PENDIENTE v0.10.1 (estado de la rama; borrar al publicar el release)

Arreglo del cliente 3D de Dubái: la pestaña abría en una cuadrícula sobre
arena y de noche en negro. Sin cambios de consenso, de red ni de formato de
fichero respecto a la 0.10.0 (misma cadena, misma activación del
**2026‑12‑01 00:00 UTC**).

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py` (189 ids), `tools/panel/lexico.py`, `gen_i18n.py` sin
  faltantes en cuatro idiomas, `tools/security/inventory.sh --check`.
- El panel real servido por `rami-gui`, manejado en Chromium sin pantalla
  (SwiftShader): entrada a la pestaña, las tres cámaras, la capa de parcelas
  encendida y apagada por su botón, el modo a pie, y capturas a mediodía, al
  atardecer, de noche y con la hora real de Dubái.

## Queda por hacer

1. **Suelo a pie.** Desde la calle el suelo sigue siendo arena lisa: faltan
   calzada, aceras y aparcamientos. El tinte urbano de esta versión se ve
   desde el aire, no desde los ojos de un peatón.
2. **Variedad de las torres.** Las instanciadas comparten cuatro tonos por
   tipo; con más familias de fachada (cristal espejo, piedra, torres con
   coronación) el skyline dejaría de parecer repetido.
3. Probar con GPU real y con gafas (Quest/Pico/SteamVR): el coste de las
   sombras a 4K y el mapa cúbico cada 2 s. En esta máquina solo hay
   rasterizado por software, así que las cifras de fluidez no valen.
4. Oclusión ambiental de pantalla, reflejos de la propia ciudad y texturas
   fotográficas con licencia abierta (el siguiente salto de realismo).
5. Previsiones de negocio con la escala de siete términos (commit-reveal
   sobre los ingresos de una empresa) y su calibración en la ficha.
6. Hitos sobre el agua: algún hito de las islas artificiales (p. ej. Atlantis
   The Royal) cae fuera del relieve estampado y se dibuja al nivel del mar en
   vez de sobre tierra. Es del dataset (`tools/geo/build_dubai.py`), viene de
   la 0.9.0 y se arregla ampliando el estampado o dándole plataforma al hito.
7. Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
   cota de timestamp de los bloques, certificados de plataforma.
