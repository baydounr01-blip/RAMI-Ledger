# PENDIENTE v0.10.8 (estado de la rama; borrar al publicar el release)

Sigue la entrega 5 del plan del metaverso (`docs/METAVERSO.md`): la calzada deja
de ir en una sola malla inmune al descarte. Sin cambios de consenso, de red ni
de formato.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde.
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin faltantes,
  `tools/security/inventory.sh --check`, `tools/compat/roundtrip.sh v0.7.0`.
- Panel real en Chromium sin pantalla: 4.505 cruces resueltos, 7 glorietas, cero
  errores de sombreador, y capturas cenital, oblicua y de detalle donde se ve la
  calle menor terminando en el borde de la mayor, el rebaje del bordillo en la
  boca y la glorieta con su isla.
- Presupuesto medido, con la calzada repartida en 43 teselas de 8 km:

  | Encuadre | Triángulos enviados | Llamadas |
  |---|---|---|
  | A pie en un cruce | 881.408 | 18 |
  | Barrio en oblicuo | 881.408 | 18 |
  | Glorieta de cerca | 949.966 | 18 |
  | Sobre una frontera de tesela | 894.806 | 18 |
  | Ciudad entera, cenital (peor caso) | 1.360.208 | 50 |

  En la v0.10.7, sin repartir, eran 1.367.614 triángulos y 17 llamadas en
  cualquier encuadre. El tamaño de tesela salió de medir cuatro (4, 6, 8 y
  12 km). La malla de calzada —524.860 triángulos en total— no proyecta sombra,
  solo la recibe: se dibuja una vez por cuadro.
- Capturas: cenital, oblicua, detalle de cruce, glorieta, ciudad entera y una
  **justo encima de una frontera de tesela**, donde las calles cruzan sin
  costura.

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
5. **Las palmeras no se descartan.** La calzada ya va por teselas, pero las
   palmeras —el 44 % de los triángulos de la escena— siguen en dos mallas
   instanciadas enteras. Repartirlas por teselas es la misma técnica y el
   siguiente recorte grande. Y el ahorro de la calzada está medido en triángulos
   enviados y llamadas de dibujo, **no en milisegundos**: aquí no hay tarjeta
   gráfica con la que cronometrarlo.
6. **Relieve por texel en bordillo y acera** (hoy solo en el asfalto: GLSL no
   deja elegir un sampler con un ternario). Se resuelve con textura en array.
7. **Colisión con lo que se mueve.** Coches y avatares se siguen atravesando.

## Un test que se cae bajo carga (no es de esta rama)

`rami-net::tests::oversized_frame_disconnects_peer` falló 2 de 4 ejecuciones de
`cargo test --workspace --release --locked` en un contenedor de 2 vCPU, y pasó
siempre aislado y siempre en CI. La causa no es del producto: el test lee
`peer_count()` —un `AtomicUsize` que se actualiza en `refresh(&peers)`, después
de mandar el evento— en el instante en que recibe `Disconnected`, y hay una
ventana en la que todavía dice 1. La tabla de pares sí es correcta. El arreglo
es esperar al contador en vez de leerlo una vez, y toca `rami-net`, que esta
rama no abre; queda apuntado para hacerlo aparte.

## Deudas que este plan reconoce y no resuelve

- **Ninguna cifra de fluidez está medida en una tarjeta gráfica real.**
- **Sonido: no hay nada** en todo el cliente, y no está en ninguna entrega.
- **El día uno de un jugador nuevo sigue sin diseñarse.**
- **Hitos sobre el agua**: algún hito de las islas artificiales cae fuera del
  relieve estampado y se dibuja al nivel del mar. Viene de la 0.9.0.
- Los pendientes de la 0.9.0: nodo público de mercado en `web/market.json`,
  cota de timestamp de los bloques, certificados de plataforma.
