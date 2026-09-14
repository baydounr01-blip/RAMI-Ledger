# PENDIENTE v0.10.3 (estado de la rama; borrar al publicar el release)

Entrega 1 del plan del metaverso (`docs/METAVERSO.md`): el catastro de sólidos,
la colisión a pie, la selección de objetos y el contrato de semillas. Sin
cambios de consenso, de red ni de formato de fichero.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes en
  cuatro idiomas, `tools/security/inventory.sh --check`,
  `tools/compat/roundtrip.sh v0.7.0`.
- Banco de pruebas sobre el panel real servido por `rami-gui` y manejado en
  Chromium sin pantalla, con doce comprobaciones en verde: alta de los 3.180
  edificios, consulta puntual dentro y fuera de la huella, salida forzada desde
  cinco puntos interiores, rayo vertical y lateral contra el Burj Khalifa con
  sus distancias, marcha real con teclado contra la torre, y la línea de estado
  del panel nombrando el edificio señalado.

## Queda por hacer

1. **Entrega 2: el suelo** (6-8 sesiones). Calzada con bordillo, aceras y
   marcas viales del grafo viario. Cierra el defecto que este proyecto arrastra
   desde la 0.9.0: a pie el suelo sigue siendo arena lisa. Incluye la primera
   medición honesta de coste por fragmento y el experimento de quitar el buffer
   de profundidad logarítmico.
2. **Entrega 3: el atlas CC0** (3-4 sesiones).
3. **Colisión con lo que se mueve.** Esta entrega para al jugador contra los
   edificios, pero los coches y los demás avatares se siguen atravesando: son
   objetos móviles y necesitan otra estructura (rejilla que se repuebla cada
   fotograma, no índice fijo).

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.** En esta
  máquina solo hay rasterizado por software. Falta probar con GPU y con gafas.
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
