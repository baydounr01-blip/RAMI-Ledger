# SHARAMI — cifrado «de dos cúbits» de RAMI-Chain

`chain/crates/rami-net/src/sharami.rs` · v1 · 2026‑09‑29

SHARAMI es la capa de cifrado propia de RAMI-Chain para mensajes entre
identidades de la red (nodos y cuentas). Toma la imagen de la teoría del
Universo de Bloques Ramificados y la lleva a la criptografía con primitivas
auditadas, sin inventar ninguna: **un mensaje son dos cúbits de información
que coexisten a la vez en espacios distintos**, ninguno dice nada por
separado, y las parejas de todos viajan mezcladas en un mismo lote, como en
un CoinJoin.

Testnet experimental, sin valor monetario. Este documento dice exactamente
qué protege SHARAMI, cómo, y qué no protege.

## 1. La idea, en una tabla

| Imagen de la teoría | Lo que hace SHARAMI |
|---|---|
| Dos cúbits entrelazados: cada uno solo es ruido; juntos son información | El mensaje `M` se parte en dos **mitades** `S0 = R` (máscara aleatoria) y `S1 = M' ⊕ R`. Cada mitad, sola, es uniforme: no filtra ni un bit |
| Coexisten en el mismo instante en espacios distintos | Cada mitad va en su propia **celda**, sellada con una clave efímera distinta, y se envía por una ruta distinta (dos pares, dos lotes, dos momentos) |
| Aleatoriamente | Máscara, claves efímeras e identificador de pareja son nuevos en cada mensaje; el orden del lote se baraja (Fisher–Yates con el RNG del sistema) |
| Estilo CoinJoin | Todas las celdas de la red tienen el **mismo tamaño** (581 bytes) y se mezclan en lotes; nadie de fuera sabe qué dos celdas forman pareja ni para quién son |
| Colapso al observar | Solo el destinatario, probando a abrir cada celda con su clave, reconoce las suyas y las junta |

## 2. Primitivas (nunca criptografía casera)

Las mismas del Túnel RAMI (`PROTOCOL.md`), todas de RustCrypto/dalek y ya en
`Cargo.lock`:

- **X25519** con clave **efímera por celda** (curve25519-dalek 4.1.3).
- **HKDF-SHA256** (RFC 5869; la implementación de `secure.rs`, con el vector
  de prueba del RFC).
- **ChaCha20-Poly1305** (chacha20poly1305 0.10.1) con la cabecera como AAD.
- **Ed25519** (ed25519-dalek 2.2.0) para el sobre firmado.
- **SHA-512** (sha2 0.10.9) para derivar el secreto X25519 de una semilla
  Ed25519.

## 3. Claves: nadie necesita una clave nueva

El destinatario se identifica por su **clave pública Ed25519** (la identidad
del nodo del Túnel RAMI o una cuenta del monedero). SHARAMI la convierte a
X25519 por el mapa birracional estándar (Edwards → Montgomery, el mismo que
libsodium en `crypto_sign_ed25519_pk_to_curve25519`):

- pública: `X = to_montgomery(decompress(A))`, rechazando lo que no
  decodifica y los puntos de orden pequeño;
- privada: `x = SHA-512(semilla)[0..32]`, que X25519 recorta («clamping»)
  exactamente igual que Ed25519 al firmar.

El test `claves_ed25519_y_x25519_coinciden` fija que las dos rutas llegan al
mismo par: `x25519_public(x) == X`.

## 4. Formato de una celda (581 bytes, siempre)

```
cabecera (34 bytes, en claro, autenticada como AAD)
  ver(1) = 1 || kem(1) = 1 || eph(32)   clave X25519 efímera de ESTA celda

cuerpo (531 bytes, cifrado)
  pair(16) || idx(1) || len(2 BE) || share(512)

etiqueta Poly1305 (16 bytes)
```

- `pair`: identificador aleatorio de la pareja. Solo se ve tras descifrar:
  es lo único que une las dos mitades, y solo lo ve quien puede abrirlas.
- `idx`: 0 (máscara `R`) o 1 (`M' ⊕ R`).
- `len`: bytes reales del mensaje (`M'` es `M` rellenado con ceros hasta 512).
- `share`: la mitad.

Derivación por celda:

```
ss    = X25519(eph_secreto, X_destinatario)        (todo ceros ⇒ rechazo)
prk   = HKDF-Extract(salt = "SHARAMI-v1", ikm = ss)
okm   = HKDF-Expand(prk, "sharami cell" || cabecera || X_destinatario, 44)
clave = okm[0..32]     nonce = okm[32..44]
```

La clave efímera es nueva en cada celda, así que el nonce nunca se repite
bajo una misma clave. Ligar `X_destinatario` a la derivación hace que una
celda solo abra con la clave para la que se selló.

## 5. Sellar, mezclar, abrir (API)

```rust
use rami_net::sharami::*;

// Claves del destinatario (de su identidad Ed25519).
let x_pub = recipient_key(&id.pubkey)?;          // quien envía solo necesita esto
let x_sec = secret_key(&id.seed());              // quien recibe

// Sellar: dos celdas. Cada una sola es ruido.
let [c0, c1] = seal(&x_pub, b"hola Dubái")?;

// Mezclar el lote de todos (CoinJoin): mismo tamaño, sin orden.
let mut lote = vec![/* celdas de muchos remitentes */];
shuffle(&mut lote);

// Abrir: solo lo mío, solo lo completo.
for m in open_batch(&x_sec, &lote) { /* m.plaintext */ }
```

Con **sobre firmado** (el destinatario sabe quién escribe; nadie más):

```rust
let cells = seal_signed(&x_pub, b"texto", &yo.pubkey, |m| yo.sign(m))?;
let firmado = open_signed(&x_pub, &open_batch(&x_sec, &cells)[0])?;  // .from, .text
```

La firma cubre `"SHARAMI-v1/sobre" || X_destinatario || pair || texto`:
un sobre no sirve para otro destinatario ni se reutiliza en otra pareja.
Texto máximo con sobre: 416 bytes; sin sobre: 512.

## 6. Lo que prueba la batería (`cargo test -p rami-net sharami`)

| Test | Qué fija |
|---|---|
| `claves_ed25519_y_x25519_coinciden` | La conversión pública y la privada llegan al mismo par X25519; el punto de orden pequeño se rechaza |
| `ida_y_vuelta_dos_celdas` | Mensaje vacío, corto y de 512 bytes; celdas de 581 bytes; el orden no importa; 513 bytes se rechazan |
| `una_celda_sola_no_dice_nada` | Dos sellados del mismo texto dan celdas y mitades distintas; ninguna mitad contiene el texto; una mitad no es un mensaje; dos mitades de parejas distintas no se juntan |
| `otro_destinatario_no_abre_nada` | Con otra clave no autentica ninguna celda |
| `celda_manipulada_no_autentica` | Un bit del cifrado, de la cabecera o del `kem` y la celda no abre; tamaño, versión y `kem` se comprueban antes de tocar la curva |
| `mezcla_conserva_los_mensajes_de_cada_uno` | 5 destinatarios × 3 mensajes en un lote barajado: cada uno recupera exactamente lo suyo |
| `mitad_repetida_no_pierde_la_pareja` | Una mitad duplicada en el lote no hace perder la de verdad |
| `sobre_firmado_dice_quien_escribe_y_rechaza_al_impostor` | Firma correcta, impostor que declara otra clave, sobre para otro destinatario y mensaje sin sobre |
| `derivacion_determinista_y_ligada_a_la_cabecera` | Misma entrada, misma clave; otra efímera u otro destinatario, otra clave y otro nonce; tamaños fijos (531/581/416) |

## 7. Lo que SHARAMI NO hace (honestidad)

- **No oculta que alguien envía celdas**, solo qué dicen, a quién van y
  cuáles van juntas. El anonimato del lote crece con el número de remitentes
  que lo comparten: un lote de dos celdas es una pareja evidente.
- **No protege contra el destinatario**: quien abre un mensaje lo tiene en
  claro y lo reenvía si quiere.
- **v1 no resiste un ordenador cuántico.** X25519 cae ante el algoritmo de
  Shor. El byte `kem` de la cabecera reserva el modo híbrido `kem = 2`
  (X25519 + ML-KEM-768, FIPS 203) con `ikm = ss_x25519 || ss_mlkem`: entra
  en cuanto la dependencia `ml-kem` de RustCrypto esté en `Cargo.lock`
  (`cargo add ml-kem` y regenerar el lock con la herramienta; ver §9). Una
  celda con `kem = 2` la rechaza hoy todo binario v1, así que el cambio de
  formato no confunde a nadie.
- **No borra secretos de la memoria** (las claves efímeras de 32 bytes se
  sueltan sin sobrescribir), igual que el resto del monedero (`SECURITY.md`).
- **No entra en el consenso.** Ninguna celda se guarda en la cadena; es una
  capa de mensajería sobre la red. Meter celdas en bloques sería un cambio de
  consenso con fecha, como los tres anteriores.

## 8. Integración en la red (siguiente entrega)

1. Frame `Sharami { cells: Vec<String> }` (hex de celdas) en `protocol.rs`.
   Un binario v0.11.0 lo ignora (frame desconocido), como con `Presence`.
2. En el nodo, un **lote por ventana de tiempo** (p. ej. 10 s): las celdas
   propias y las recibidas se juntan, se barajan y se retransmiten a los pares
   que anuncien la regla; cada mitad de un mensaje propio sale por un par
   distinto cuando hay más de uno. Topes iguales a los del chat: ritmo por
   identidad, tamaño fijo, memoria acotada, sin persistencia.
3. Panel: «Mensajes» en la ciudad, con el sobre firmado y el ✓ del perfil
   vinculado (`SetProfile`), y `rami-wallet sharami send|inbox`.
4. `kem = 2` híbrido cuando el lock lleve `ml-kem`.

## 9. Por qué esta entrega no trae ya el modo post-cuántico

Añadir `ml-kem` cambia `Cargo.lock`, que el CI exige con `--locked`; ese
fichero lo regenera `cargo`, no una persona, y esta entrega se hizo sin
poder ejecutarlo. El formato ya deja el sitio (`kem`) y la derivación ya
concatena secretos: el cambio será añadir 1.088 bytes de encapsulado a la
cabecera y una rama en `derive`.
