# PENDIENTE v0.10.6 (estado de la rama; borrar al publicar el release)

Entrega 4 del plan del metaverso (`docs/METAVERSO.md`): la trama de barrio
deducida y las manzanas. Sin cambios de consenso, de red ni de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: 34 retículas dadas de alta, cero errores
  de sombreador, y capturas cenital y de barrio donde se ven las calles y los
  edificios agrupados en las manzanas.
- Presupuesto medido: 1.063.212 triángulos con calidad media (908.238 antes de
  la trama), 17 llamadas de dibujo, descarga sin cambios.

## Queda por hacer

1. **La mitad real de las calles.** El plan elegido era OSM filtrado más
   deducción. La red de este entorno rechaza Overpass, Nominatim, Geofabrik y
   los teselados de OpenStreetMap, así que la mitad real no se puede traer
   desde aquí. Para desbloquearla basta con dejar un extracto de Dubái en el
   repositorio: sus vías con nombre entran en la misma lista de ejes.
2. **Los cruces.** La trama de barrio y las vías principales se solapan sin
   resolverse: las dos calzadas se dibujan encima. Faltan prioridad, glorietas
   y quitar el trozo de la calle menor dentro de la mayor.
3. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. No se
   puede medir aquí: hace falta una tarjeta gráfica de verdad.
4. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto: GLSL no
   deja elegir un sampler con un ternario). Se resuelve con textura en array.
5. **Colisión con lo que se mueve.** Coches y avatares se siguen atravesando.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.**
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
