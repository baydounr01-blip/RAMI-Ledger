# Protocolo P2P de RAMI-Chain, versión 2 (v0.7.0)

Dos piezas: la **sincronización del universo de ramas** (qué se dice) y el
**Túnel RAMI** (cómo viaja: autenticado y cifrado). Nada de esto toca el
consenso: los bloques, las reglas y la elección de rama son los de siempre;
el nodo revalida todo lo que recibe. Testnet experimental, sin valor monetario.

## 1. Túnel RAMI (transporte)

Primitivas, todas de RustCrypto/dalek (nunca criptografía casera):
Ed25519 (identidad), SHA-256d (prueba de trabajo, la misma `pow_hash` del
minado), X25519 (acuerdo de claves efímeras), HKDF-SHA256 (RFC 5869),
ChaCha20-Poly1305 (cifrado autenticado).

### Identidad con prueba de trabajo (`identity.rs`)

- Cada nodo guarda una semilla Ed25519 en `<cadena>/node.key`
  (`{"seed":hex32,"pow_nonce":u64}`, permisos 0600 en Unix). Nunca se
  sobrescribe un archivo ilegible.
- La clave pública debe ir acompañada de `pow_nonce` tal que
  `SHA-256d(pubkey || pow_nonce_le64)` tenga ≥ `IDENTITY_POW_BITS` = 20 bits a
  cero (≈ 2^20 hashes, del orden de un segundo una sola vez). Crear muchas
  identidades cuesta CPU real: frena los ataques Sybil baratos.
- `node_id` = 8 primeros bytes (LE) de `SHA-256d(pubkey)`.
- Huella = 16 primeros hex de `SHA-256d(pubkey)` como `xxxx-xxxx-xxxx-xxxx`
  (se muestra en el panel; compárala por otro canal, como con SSH).

### Handshake (3 mensajes, `secure.rs`)

`net` = network-id (hash del génesis, 32 bytes). `ver` = 2.

1. iniciador → respondedor, en claro, una línea JSON (≤ 4096 bytes):
   `{"RamiHello1":{"net":hex32,"ver":2,"pub":hex32,"pow_nonce":u64,"eph":hex32,"nonce":hex16,"port":u16}}`
2. respondedor → iniciador, en claro:
   `{"RamiHello2":{…mismos campos del respondedor…,"sig":hex64}}`
   con `sig` = Ed25519 del respondedor sobre la transcripción `T`.
3. iniciador → respondedor, **cifrado** con `k_i2r` (contador n = 0):
   `{"RamiHello3":{"sig":hex64}}`, firma Ed25519 del iniciador sobre `T`.

Transcripción (203 bytes, disposición fija):

```
T = "RAMI-P2P-v2" || net(32) || init.pub(32) || init.eph(32) || init.nonce(16)
                  || resp.pub(32) || resp.eph(32) || resp.nonce(16)
```

Cada lado comprueba, en este orden: mismo `net`, `ver` == 2, prueba de
trabajo de la identidad (barato, antes de cualquier operación de curva),
`node_id` ≠ el propio, y la firma sobre `T`. Un `{"Hello":…}` en claro
(v0.6.x) se rechaza con el aviso «par con protocolo antiguo; que actualice».

Claves de sesión:

```
shared = X25519(eph_propio, eph_ajeno)          (todo-ceros ⇒ rechazo)
prk    = HKDF-Extract(salt = net, ikm = shared)
k_i2r  = HKDF-Expand(prk, "rami i2r" || T, 32)
k_r2i  = HKDF-Expand(prk, "rami r2i" || T, 32)
```

Las claves efímeras dan secreto hacia delante: una `node.key` robada no
descifra sesiones pasadas. Las firmas de ambos sobre `T` (que incluye las dos
identidades y las dos efímeras) impiden el intermediario y el intercambio de
identidad; los nonces impiden repetir un handshake.

### Framing

Tras el handshake, cada sentido lleva un contador `n` de 64 bits desde 0:

```
frame = len (u32 BE, longitud del cifrado, 16 ≤ len ≤ 16 MiB)
     || ChaCha20-Poly1305(k_sentido, nonce = 0x00000000 || n_le64, aad = "", texto = JSON del Frame sin '\n')
```

El contador no viaja: un frame repetido, reordenado o manipulado no
autentica y **cierra la conexión**. La longitud se comprueba antes de reservar
memoria. La cola de salida por par está acotada (128 frames): un par que no
lee se expulsa en vez de acumular memoria.

### TOFU

`<cadena>/known-identities.json` recuerda la clave pública vista en cada
dirección marcada. Si cambia, el nodo lo registra y el panel avisa
(`netinfo.identity_warnings`); en testnet no se corta la conexión.

## 2. Sincronización del universo de ramas

Frames (JSON, etiquetado externo, cifrados por el túnel):

| Frame | Campos | Para qué |
|---|---|---|
| `Status` | `height, best, work` | cabeza actual (al conectar) |
| `Tips` | `tips: [{hash, height, work}], partial` | anuncio de puntas: todas al conectar y cada 30 s, solo las nuevas (`partial`) al aceptar un bloque; ordenadas por trabajo, ≤ 256 |
| `GetBranch` | `tip, known: [hash], max` | «dame la rama que acaba en `tip`; ya tengo `known`» |
| `Branch` | `tip, blocks, more` | segmento en orden ascendente, truncado por el extremo antiguo; `more` si falta |
| `NewBlock`, `NewTx`, `GetPeers`, `Peers`, `Ping`, `Pong` | | gossip y mantenimiento |

`known` es el **localizador**: los últimos 8 bloques de la cadena del
observador, luego huecos que se doblan (9, 13, 21, 37, …), el génesis y las
64 puntas más pesadas. Si el punto de bifurcación cae entre dos muestras
lejanas, el primer lote puede ser todo conocido: el receptor avanza un
**cursor** (último bloque del lote que ya está en su árbol) y vuelve a pedir
con `known = localizador + [cursor]`, así que la petición siempre progresa.

Topes frente a pares hostiles: ≤ 4 `GetBranch` en vuelo por par (el resto de
puntas espera en cola por trabajo), rondas contadas por (par, punta) con
expulsión del par tras 8 puntas agotadas, ≤ 128 `GetBranch` servidos por par
cada 10 s y ≤ 4 MB por `Branch`, bloques inválidos recordados para no
revalidarlos, y todos los vectores recibidos acotados.

Propiedad que se comprueba en `rami-node/tests/sync.rs`: dos nodos que minan
aislados y luego se conectan acaban con **los dos árboles idénticos** (todas
las ramas, mismas puntas, misma cabeza); una rama lateral llega a un nodo a
dos saltos solo por `Tips`; una bifurcación a 700 bloques de profundidad se
sincroniza por el cursor; 256 puntas falsas producen como mucho 4 peticiones.
