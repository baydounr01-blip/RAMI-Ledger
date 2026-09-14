# PENDIENTE v0.10.5 (estado de la rama; borrar al publicar el release)

Entrega 3 del plan del metaverso (`docs/METAVERSO.md`): los materiales de la
ciudad. Sin cambios de consenso, de red ni de formato de fichero.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: cero errores de compilación de sombreador
  y capturas a ras de suelo donde se distinguen el árido del asfalto, la junta
  de las losas de acera y el grano de la arena.
- Las texturas son deterministas: volver a ejecutar el generador produce los
  mismos bytes.

## Queda por hacer

1. **Calles de barrio** (decidido: OSM filtrado + deducción). El mapa abierto
   solo trae las 21 vías principales; dentro de los barrios no hay calles.
   Hacen falta dos generadores que casen en los cruces. 9-12 sesiones.
2. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`, que
   anula el descarte temprano de píxeles en la escena entera. No se puede medir
   aquí: hace falta una tarjeta gráfica de verdad.
3. **Relieve por texel en bordillo y acera.** Hoy solo lo tiene el asfalto:
   GLSL no deja elegir un sampler con un ternario y muestrear los tres
   materiales costaría seis lecturas más por fragmento. Se resuelve con una
   textura en array (WebGL2 lo permite) cuando haya con qué medir el coste.
4. **Colisión con lo que se mueve.** Coches y avatares se siguen atravesando.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.**
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
