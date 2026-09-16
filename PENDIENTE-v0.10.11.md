# PENDIENTE v0.10.11 (estado de la rama; borrar al publicar el release)

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`): las líneas de
detención y el ceda el paso. Sin cambios de consenso, de red ni de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: 7.899 marcas —7.876 líneas de detención
  en los 4.505 cruces y 23 ceda el paso en las siete glorietas—, cero errores de
  sombreador, y capturas cenital, oblicua y a pie de una línea de detención y de
  un ceda el paso a la entrada de una glorieta. En la cenital de la glorieta se
  ve que los trazos caen en la mitad derecha del que entra, que es la prueba del
  convenio de lados que usan también las de detención.
- Presupuesto medido, con los mismos encuadres que la v0.10.10:

  | Encuadre | v0.10.10 | v0.10.11 | Llamadas |
  |---|---|---|---|
  | A pie en un cruce | 740.308 | 741.322 (+0,14 %) | 17 |
  | Ciudad entera, cenital (peor caso) | 1.797.684 | 1.816.716 (+1,1 %) | 65 |

  La malla de calzada pasa de 964.208 a 983.240 triángulos: 15.798 de los 7.899
  cuadriláteros y 3.234 de las 231 filas que hubo que añadir donde la marca no
  coincidía con una parada existente.

## Cómo están hechas, para quien las toque después

- **Dónde se pone la línea de detención**: a `max(R, 0,45 + acera de la mayor + 1)`
  metros del borde de la calzada preferente, medido en perpendicular a su eje. A
  esa distancia el arco de la esquina ya vale cero, así que la calzada tiene su
  ancho nominal y la banda va de `u = 0,7` (fuera del eje doble) a `u = c − 0,1`.
- **El lado**: `u > 0` es la derecha del sentido +s (la normal es `(−tz, tx)`).
  La boca de `s` menor la alcanza quien va en +s, así que su mitad de llegada es
  `u > 0`; la de `s` mayor, `u < 0`. La glorieta usa el mismo convenio.
- **Por qué no son filas de la cinta**: `escribeFila` cose cada fila con los
  ocho vértices anteriores del trozo; cuatro vértices metidos entre dos filas
  romperían el cosido. Los cuadriláteros se apuntan durante el recorrido y se
  escriben al final, con `T.cose = false`, igual que el anillo de la glorieta.
- **Las 23 de 28 entradas de glorieta**: las cinco que faltan caen dentro del
  corte de otro cruce o fuera del mapa, y su fila no se emite.

## Queda por hacer

1. **La mitad real de las calles.** El plan elegido era OSM filtrado más
   deducción. La red de este entorno rechaza Overpass, Nominatim, Geofabrik y
   los teselados de OpenStreetMap, así que la mitad real no se puede traer desde
   aquí. Para desbloquearla basta con dejar un extracto de Dubái en el
   repositorio: sus vías con nombre entran en la misma lista de ejes y mandan
   donde existan, porque el rango ya está escrito para eso.
2. **El experimento de la profundidad.** Quitar `logarithmicDepthBuffer`. No se
   puede medir aquí: hace falta una tarjeta gráfica de verdad.
3. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto: GLSL no
   deja elegir un sampler con un ternario). Se resuelve con textura en array.
4. **Colisión con lo que se mueve.** Coches y avatares se siguen atravesando.
   Es lo siguiente.
5. **Pasos de peatones.** Las bocas llevan línea de detención pero nadie ha
   pintado por dónde cruza la gente. Misma técnica que las marcas: cuadriláteros
   con una clase de pintura a rayas por la coordenada longitudinal.
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
