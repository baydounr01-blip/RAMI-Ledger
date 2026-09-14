# PENDIENTE v0.10.2 (estado de la rama; borrar al publicar el release)

Entrega 0 del plan del metaverso (`docs/METAVERSO.md`): la deuda de rendimiento
que todas las arquitecturas estudiadas daban por pagada y ninguna pagaba. Sin
cambios de consenso, de red ni de formato de fichero respecto a la 0.10.1.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Medición antes y después con el panel real servido por `rami-gui` y manejado
  en Chromium sin pantalla: inventario objeto a objeto de la escena
  (`renderer.info` más un recorrido del grafo), captura de la ciudad y captura
  de una palmera de cerca para comprobar que la dieta no se nota.

## Queda por hacer

El plan completo está en `docs/METAVERSO.md`. Lo inmediato:

1. **Entrega 1: el plano inmutable, la colisión y la selección** (6-8 sesiones).
   Sin esto no hay puerta que cruzar ni coche al que subir, y hoy se atraviesan
   los edificios. Es prerrequisito de todo lo demás.
2. **Entrega 2: el suelo** (6-8 sesiones). Cierra el defecto que este proyecto
   lleva dos versiones arrastrando: a pie el suelo sigue siendo arena lisa.
   Incluye la primera medición honesta de coste por fragmento y el experimento
   de quitar el buffer de profundidad logarítmico.
3. **Entrega 3: el atlas CC0** (3-4 sesiones). 3-4 MB de texturas de dominio
   público con su atribución en NOTICE.md.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.** En esta
  máquina solo hay rasterizado por software: los triángulos y las llamadas de
  dibujo de esta versión son exactos, los milisegundos no existen. Falta probar
  con GPU y con gafas (Quest/Pico/SteamVR).
- **Sonido: no hay nada**, ni una llamada a `AudioContext` en todo el cliente, y
  no está en ninguna entrega. Es la única dimensión donde no hacen falta assets.
- **El día uno de un jugador nuevo sigue sin diseñarse**: hoy abre la pestaña,
  ve arena preciosa, no posee nada y no puede comprar nada hasta diciembre.
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0
  (`tools/geo/build_dubai.py`).
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
