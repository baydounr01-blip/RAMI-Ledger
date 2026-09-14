# PENDIENTE v0.10.7 (estado de la rama; borrar al publicar el release)

Entrega 5 del plan del metaverso (`docs/METAVERSO.md`): los cruces. Sin cambios
de consenso, de red ni de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: 4.505 cruces resueltos, 7 glorietas, cero
  errores de sombreador, y capturas cenital, oblicua y de detalle donde se ve la
  calle menor terminando en el borde de la mayor, el rebaje del bordillo en la
  boca y la glorieta con su isla.
- Presupuesto medido: 1.367.614 triángulos con calidad media (1.063.212 antes de
  los cruces), 17 llamadas de dibujo, descarga sin cambios. La malla de calzada
  —524.860 triángulos— no proyecta sombra, solo la recibe: se dibuja una vez por
  cuadro.

## Queda por hacer

1. **Las esquinas de los cruces no tienen radio de giro.** Hoy la calle menor
   termina en ángulo recto contra la mayor. Falta el cuarto de círculo de acera
   y bordillo que hace la esquina de verdad.
2. **No hay líneas de detención ni ceda el paso.** La calle que cede llega al
   cruce con sus marcas de carril y se acaba. Pintarlas pide un cuarto valor en
   el atributo `via` o cuatro vértices sueltos por boca.
3. **La mitad real de las calles.** El plan elegido era OSM filtrado más
   deducción. La red de este entorno rechaza Overpass, Nominatim, Geofabrik y
   los teselados de OpenStreetMap, así que la mitad real no se puede traer desde
   aquí. Para desbloquearla basta con dejar un extracto de Dubái en el
   repositorio: sus vías con nombre entran en la misma lista de ejes y mandan
   donde existan, porque el rango ya está escrito para eso.
4. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. No se
   puede medir aquí: hace falta una tarjeta gráfica de verdad.
5. **Nada se descarta por frustum.** La malla de calzada lleva
   `frustumCulled = false` y son ya 524.860 triángulos que se envían cada cuadro
   mires donde mires. Partirla por barrios bajaría el vértice enviado a costa de
   más llamadas de dibujo; hace falta medirlo en una tarjeta real para saber si
   compensa.
6. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto: GLSL no
   deja elegir un sampler con un ternario). Se resuelve con textura en array.
7. **Colisión con lo que se mueve.** Coches y avatares se siguen atravesando.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.**
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
