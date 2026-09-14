# PENDIENTE v0.10.4 (estado de la rama; borrar al publicar el release)

Entrega 2 del plan del metaverso (`docs/METAVERSO.md`), primera mitad: la
calzada. Sin cambios de consenso, de red ni de formato de fichero.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: sin un solo error de compilación de
  sombreador, inventario objeto a objeto de la escena y capturas cenital,
  oblicua y a ras de suelo sobre una vía.

## Queda por hacer

1. **Calles de barrio.** El mapa abierto solo trae las 21 vías principales de
   Dubái (602 km). Dentro de los barrios no hay calles: el centro se cruza por
   arena entre los edificios. Hace falta o bien otro dato abierto (huellas de
   calzada de OpenStreetMap) o bien deducir una trama viaria de los clusters.
2. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`, que
   obliga a todos los sombreadores a escribir profundidad y anula el descarte
   temprano de píxeles en la escena entera. Es el coste más grande que nadie ha
   medido, y no se puede medir aquí: hace falta una tarjeta gráfica de verdad.
3. **Entrega 3: el atlas CC0** (3-4 sesiones). El asfalto, el hormigón y la
   arena siguen siendo color liso con ruido.
4. **Colisión con lo que se mueve.** Los coches y los demás avatares se siguen
   atravesando: son objetos móviles y necesitan otra estructura.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.** En esta
  máquina solo hay rasterizado por software: los triángulos y las llamadas de
  dibujo son exactos, los milisegundos no existen.
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
