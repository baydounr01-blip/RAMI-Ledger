# PENDIENTE v0.10.9 (estado de la rama; borrar al publicar el release)

Cierra la entrega 5 del plan del metaverso (`docs/METAVERSO.md`): el radio de
giro de las esquinas. Sin cambios de consenso, de red ni de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: 4.505 cruces resueltos, 7 glorietas, cero
  errores de sombreador, y capturas cenital, oblicua y de detalle donde se ve la
  calle menor terminando en el borde de la mayor, el rebaje del bordillo en la
  boca y la glorieta con su isla.
- Presupuesto medido, con las esquinas redondeadas y la calzada en 43 teselas:

  | Encuadre | v0.10.8 | v0.10.9 | Llamadas |
  |---|---|---|---|
  | A pie en un cruce | 881.408 | **914.196** | 18 |
  | Barrio en oblicuo | 881.408 | **914.196** | 18 |
  | Glorieta de cerca | 949.966 | 1.052.124 | 18 |
  | Sobre una frontera de tesela | 894.806 | 950.358 | 18 |
  | Ciudad entera, cenital (peor caso) | 1.360.208 | 1.799.556 | 50 |

  La malla de calzada entera sube de 524.860 a 964.208 triángulos, pero como va
  repartida en teselas que se descartan solas, **a pie eso son 33.000 triángulos
  más: un 3,7 %**. No proyecta sombra, solo la recibe: se dibuja una vez por
  cuadro.
- Capturas: cenital y oblicua de un cruce con las cuatro esquinas redondeadas,
  detalle, glorieta, ciudad entera y una **justo encima de una frontera de
  tesela**, donde las calles cruzan sin costura.

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
4. **Las palmeras no se reparten.** La calzada ya va por teselas, pero las
   palmeras —el 44 % de los triángulos de la escena— siguen en dos mallas
   instanciadas enteras. Repartirlas por teselas es la misma técnica y el
   siguiente recorte grande. Y el ahorro de la calzada está medido en triángulos
   enviados y llamadas de dibujo, **no en milisegundos**: aquí no hay tarjeta
   gráfica con la que cronometrarlo.
5. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto: GLSL no
   deja elegir un sampler con un ternario). Se resuelve con textura en array.
6. **Colisión con lo que se mueve.** Coches y avatares se siguen atravesando.

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

Arreglado en esta rama con un ayudante de test, `espera_pares`, que espera a que
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
