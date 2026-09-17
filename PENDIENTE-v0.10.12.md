# PENDIENTE v0.10.12 (estado de la rama; borrar al publicar el release)

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`): la colisión con
lo que se mueve. Sin cambios de consenso, de red ni de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla, con 120 coches en 20 vías (calidad
  media) y cero errores. Las pruebas van sobre `_debug.paso(dt)`, un paso de
  simulación sin dibujar, porque a 2 cuadros por segundo un segundo de reloj es
  una décima de simulación y la primera pasada ni llegó a ejecutar un cuadro:

  | Prueba (pasos de 1/60 s) | Resultado |
  |---|---|
  | Coche a 22,6 m/s contra el jugador quieto en su carril | Se para a 7,0 m del centro (4,7 del morro) en 4,2 s; el jugador no se mueve |
  | El jugador se aparta 6 m | El coche arranca a los 1,7 s |
  | Jugador plantado dentro de la caja de un coche parado | Sale en un paso, a 1,42 m del eje (1 + 0,42) |
  | Jugador andando contra un avatar ajeno, lejos de las vías | Distancia mínima 0,77 m exactos (0,42 + 0,35) |
  | Cola: el de detrás a 22,6 m/s, el de delante a 8 | El de detrás baja a 8 y guarda 12,3 m |

- Dos capturas: un coche parado ante el jugador, a pie, y una cola de dos coches
  desde arriba.
- Coste: ninguna geometría nueva; mismo presupuesto de triángulos y llamadas.

## Cómo está hecho, para quien lo toque después

- **Marco del coche**: `(fx, fz)` es el sentido de marcha (tangente de la vía
  por `dir`) y la derecha es `(−fz, fx)`. `al = d·f`, `la = d·derecha`. La caja
  es `COCHE_HL = 2,3` por `COCHE_HW = 1,0`; el empuje sale del mismo cálculo de
  cara más cercana que `empujarFuera`.
- **La pose se guarda** en el coche (`c.x, c.z, c.fx, c.fz`) al final de
  `updateTraffic`; `updateWalk` corre antes en el cuadro, así que usa la pose del
  cuadro anterior: a 60 cuadros y 36 m/s son 60 cm de desfase, que el empuje
  resuelve en el cuadro siguiente.
- **Perfil de frenado**: `meta = v·√((hueco − 7) / D)` con `D = v² / 2a` y
  `a = 6 m/s²`; la velocidad real sigue a `meta` con tope de 9 m/s² al frenar y
  3 al acelerar. Un primer intento con rampa lineal y 18 m de vista no llegaba:
  a 22 m/s hacen falta 28 m para pararse a 9 m/s², y el coche «veía» el obstáculo
  a 25.
- **Las colas** se ordenan cada cuadro por vía (`path.id`) y sentido; el hueco
  es la distancia por la vía hasta el siguiente en el orden de `t`, con vuelta.
- **El jugador en el carril**: `al > −2,3`, `|la| < 2,4` y `al < hueco`; a la
  altura del coche (`al` negativo) el hueco es cero y el coche espera.

## Queda por hacer

1. **Los avatares ajenos no se apartan.** Van donde dice su cliente; solo se
   empuja al jugador local. Que dos clientes se empujen mutuamente pide que cada
   uno aplique el empuje a su propia posición antes de publicarla.
2. **Los coches no esquivan**, solo frenan. Un jugador parado en el carril para
   la fila entera.
3. **La mitad real de las calles.** El plan elegido era OSM filtrado más
   deducción. La red de este entorno rechaza Overpass, Nominatim, Geofabrik y
   los teselados de OpenStreetMap, así que la mitad real no se puede traer desde
   aquí. Para desbloquearla basta con dejar un extracto de Dubái en el
   repositorio: sus vías con nombre entran en la misma lista de ejes y mandan
   donde existan, porque el rango ya está escrito para eso.
4. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. No se
   puede medir aquí: hace falta una tarjeta gráfica de verdad.
5. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto: GLSL no
   deja elegir un sampler con un ternario). Se resuelve con textura en array.
6. **Pasos de peatones.** Las bocas llevan línea de detención pero nadie ha
   pintado por dónde cruza la gente. Misma técnica que las marcas: cuadriláteros
   con una clase de pintura a rayas por la coordenada longitudinal.
7. **La pasada de sombra, en una tarjeta de verdad.** Aquí no dibuja nada, así
   que su coste está sin medir. Cuando dibuje, su caja mide 350 m a pie y hasta
   3,5 km en órbita, y con teselas de ocho kilómetros toca de una a cuatro.

## El arco de la esquina, para quien lo toque después

Dos cosas que costaron una vuelta cada una y conviene no volver a descubrir:

1. **El arco se mide desde el eje de la otra calle, no desde donde termina la
   cinta.** La cinta de la que cede se corta en el borde exterior de la
   preferente, que ya está bien dentro del arco. Partir de ahí abría las bocas
   ocho metros en vez de uno y medio.
2. **Las dos calles tienen que usar la misma fórmula.** Con dos ensanches
   distintos —uno medido desde el corte y otro desde la caja— los dos bordes se
   cruzan y dejan un pico en cada rincón. Con la misma, se encuentran sobre el
   arco.

Y una tercera de reparto: el cuarto de circunferencia se corta **por ángulo**.
Por longitud, con las mismas filas, la flecha pasa del metro.

## Un test que se caía bajo carga, y que tumbó un release

`rami-net::tests::oversized_frame_disconnects_peer` fallaba de vez en cuando —2
de 4 ejecuciones de `cargo test --workspace --release --locked` en un contenedor
de 2 vCPU— y siempre pasaba aislado. El 14 de septiembre de 2026 **tumbó el
release de la v0.10.7**: `lib.rs:746`, `left: 1, right: 0`.

La causa no es del producto: `peer_count()` es una instantánea que se refresca en
`refresh(&peers)`, y ese refresco corre DESPUÉS de mandar `Connected` o
`Disconnected` por el canal. El test leía el contador una sola vez, en el
instante en que recibía el evento, y con la máquina cargada caía dentro de esa
ventana. La tabla de pares siempre fue correcta; lo que no es instantáneo es el
número.

Arreglado en la v0.10.8 con un ayudante de test, `espera_pares`, que espera a que
el contador llegue al valor esperado (hasta dos segundos) en vez de leerlo una
vez. Se aplica a los seis asserts que van justo detrás de un evento. Los que
comprueban que **nada** se registró se quedan como estaban: ahí no hay evento al
que seguirle los pasos. Ningún cambio fuera de los tests.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.**
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
