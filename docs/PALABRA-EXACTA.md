# La palabra exacta en RAMI-Chain (v0.7.3)

> Doctrina de las agencias de análisis —ICD 203 (probabilidad y confianza
> como ejes separados, escala de siete términos, léxico prohibido), ICD 206
> (descripción y graduación de fuentes) y el código Admiralty (letra y número
> evaluados por separado)— aplicada a lo que RAMI-Chain dice en su panel, en
> su web y en sus notas. Misma doctrina que en el motor de señales del
> proyecto hermano; aquí, adaptada a una cadena de bloques.

## 0 · Principio

Nada de esto toca el **consenso**. Un par graduado «A1» sigue sin ser fuente
de confianza: `accept_block` revalida cada bloque con las mismas reglas. Un
término de la escala dentro de una predicción son bytes bajo un hash. El
formato de ningún archivo existente cambia; lo nuevo son **archivos nuevos**
que las versiones anteriores ignoran (`peer-grades.json`,
`predicciones-libro.json`). La graduación y el libro **describen**; no deciden.

## 1 · Fuentes: los pares, graduados

Cada par es una fuente y recibe un código Admiralty en `PeerView.fuente`
(`rami-node/src/grado.rs`):

| Eje | Qué mide | De dónde sale | Dónde vive |
|---|---|---|---|
| **Letra** (fiabilidad) | el historial del par | bloques suyos admitidos vs. rechazados por inválidos, y cambios de identidad en su dirección | `peer-grades.json` (por clave pública, tope 256) |
| **Número** (credibilidad) | lo observado en esta sesión | puntas anunciadas, bloques válidos/inválidos, retraso frente al mejor par, corroboración por otro par | memoria; nace con cada conexión |

Letra: `F` con menos de 3 bloques juzgados; `A` con ≥ 50 y ninguno inválido;
`B` ≤ 2 % inválidos con ≥ 10; `C` ≤ 10 %; `D` ≤ 30 %; `E` el resto. Un cambio
de identidad (aviso TOFU) pone tope en `C`. Proporciones en milésimas enteras.

Número, de peor a mejor y gana la primera condición: `6` sin nada aún; `5`
más de 100 bloques por detrás del mejor par (dato viejo); `3` ha enviado un
bloque inválido en esta sesión (contradicho); `4` anuncia puntas que aún no
tenemos en el árbol (sin verificar); `1` una punta suya está en nuestro árbol
**y** la anuncia otro par (corroborado); `2` está en nuestro árbol pero nadie
más la corrobora.

Los `motivos` acompañan al código en el panel (Red → tabla de pares). La
última rama recibida dice también de qué fuente vino (`last_sync_fuente`).

## 2 · Hechos y juicios

- **«Sincronizado»** es un juicio. El hecho va al lado: `sync.mi_altura`,
  `sync.mejor_altura_pares`, `sync.pares_a_mi_altura`, `sync.atras`. El panel
  enseña «altura 1 234 · mejor par 1 240 · faltan 6».
- **Autoauditoría**: cada comprobación se muestra como *juicio* (el nombre y
  ✓/✗) y *hecho* (lo observado, con su duración).

## 3 · Predicciones con término (commit/reveal)

Al comprometer, el panel ofrece la escala de siete términos ICD 203; el
término y su rango viajan **dentro del payload** (`termino`, `rango`). Nunca
un porcentaje suelto; nunca 0 ni 100.

| Término | Rango | Punto medio |
|---|---|---|
| remoto | 1–5 % | 3 |
| muy improbable | 5–20 % | 12 |
| improbable | 20–45 % | 32 |
| posibilidad aproximadamente igual | 45–55 % | 50 |
| probable | 55–80 % | 67 |
| muy probable | 80–95 % | 87 |
| casi seguro | 95–99 % | 97 |

El libro local (`predicciones-libro.json`, junto a `wallet_reveals.json`)
apunta cada predicción con término; el usuario marca «ocurrió / no ocurrió»
(`POST /api/predicciones/resultado`). `GET /api/predicciones` devuelve el
libro y el resumen (`rami-wallet/src/calibracion.rs`): Brier en diezmilésimas
enteras, y por banda casos, ocurridos, frecuencia, desvío (punto medio dicho −
frecuencia) y veredicto `dentro` / `exceso` / `defecto` / `insuficiente`
(menos de 5 casos). La lectura termina siempre en «no mide acierto ni
rentabilidad». Nada de esto sale del ordenador del usuario.

## 4 · Léxico

`tools/panel/lexico.py` recorre el panel (español y los cuatro diccionarios),
la web (es/en), el README y las notas, y falla si aparece el léxico prohibido
de ICD 203 §2.6 en cinco idiomas: «podría», «quizá», «es posible», «sugiere
que», «no se descarta»; «might», «likely», «possibly», «suggests that»;
«возможно», «может быть»; «可能», «也许»; «labda», «pengine». Se permite un
término de la escala con su rango y un término citado entre comillas. El CI
lo ejecuta en cada push. Vocabulario fijo: *fiabilidad* es la letra,
*credibilidad* es el número; «confianza» no se usa para ninguno de los dos.

## 5 · Lo que NO cambia

- Ninguna regla de consenso, ningún formato de archivo existente, ningún
  mensaje del protocolo (`PROTO_VERSION` sigue en 2: la v0.7.0 y la 0.7.3
  hablan entre sí).
- Ninguna cifra de rendimiento: el libro de predicciones mide calibración
  de las palabras del usuario, no acierto; la graduación de pares mide lo que
  el nodo verificó, no «confianza».
- La compatibilidad se prueba con los binarios reales de la versión
  publicada: `tools/compat/roundtrip.sh` (CI) y
  `rami-node/tests/compat_v070.rs` sobre ficheros escritos por la v0.7.0.
