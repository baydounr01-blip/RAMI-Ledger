# PENDIENTE v0.10.10 (estado de la rama; borrar al publicar el release)

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`): las palmeras
dejan de enviarse enteras. Sin cambios de consenso, de red ni de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: 916 palmeras en 17 teselas de ocho
  kilómetros, cero errores de sombreador, y capturas de una palmera de cerca, de
  una celda de costa con varias, andando entre ellas y de la ciudad entera.
- Presupuesto medido, con los mismos encuadres que la v0.10.9:

  | Encuadre | v0.10.9 | v0.10.10 | Llamadas |
  |---|---|---|---|
  | A pie en un cruce | 914.196 | **740.308** (−19 %) | 18 → 17 |
  | Barrio en oblicuo | 914.196 | **756.740** (−17 %) | 18 |
  | Glorieta de cerca | 1.052.124 | 904.444 (−14 %) | 18 |
  | Palmeras de cerca | 1.142.494 | 1.014.574 (−11 %) | 19 → 21 |
  | Andando por el cruce | 989.866 | 824.714 (−17 %) | 24 → 25 |
  | Andando entre palmeras | 1.129.404 | 977.980 (−13 %) | 34 → 35 |
  | Sobre una frontera de tesela | 950.358 | 797.270 (−16 %) | 18 |
  | Ciudad entera, cenital (peor caso) | 1.799.556 | 1.797.684 | 50 → 65 |

- La barrida de tamaños, medida con el mismo arnés y los mismos encuadres:

  | Tesela | Teselas | Triángulos de palmeras a pie en el cruce | Llamadas, ciudad entera |
  |---|---|---|---|
  | 2 km | 138 | 12.480 | 186 |
  | 4 km | 46 | 18.512 | 94 |
  | 6 km | 26 | 30.160 | 74 |
  | **8 km** | 17 | 18.512 | **65** |

  La diferencia en triángulos es de un 2 % de la escena; la de llamadas, de tres
  veces. Se queda la de ocho, la misma que la calzada.

- Cómo se midió: `renderer.info.render`, que cuenta todas las pasadas del cuadro.
  Ocultando las palmeras la escena se queda en 721.796 triángulos, que es
  exactamente 914.196 menos 925 × 208; apagando la pasada de sombra no cambia ni
  un triángulo en estos encuadres. Las cifras son, por tanto, de la pasada de
  cámara, y la nota de la v0.10.9 que daba a las palmeras el 44 % contaba una
  pasada de sombra que no las dibuja: eran el 21 %.

## Queda por hacer

1. **No hay líneas de detención ni ceda el paso.** La calle que cede llega al
   cruce con sus marcas de carril y se acaba. Pintarlas pide un cuarto valor en
   el atributo `via` o cuatro vértices sueltos por boca.
2. **La mitad real de las calles.** El plan elegido era OSM filtrado más
   deducción. La red de este entorno rechaza Overpass, Nominatim, Geofabrik y
   los teselados de OpenStreetMap, así que la mitad real no se puede traer desde
   aquí. Para desbloquearla basta con dejar un extracto de Dubái en el
   repositorio: sus vías con nombre entran en la misma lista de ejes y mandan
   donde existan, porque el rango ya está escrito para eso.
3. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. No se
   puede medir aquí: hace falta una tarjeta gráfica de verdad.
4. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto: GLSL no
   deja elegir un sampler con un ternario). Se resuelve con textura en array.
5. **Colisión con lo que se mueve.** Coches y avatares se siguen atravesando.
6. **La pasada de sombra, en una tarjeta de verdad.** Aquí no dibuja nada, así
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
