# RAMI-Chain

Una cadena de bloques que toma en serio el **Universo de Bloques Ramificados**:
el pasado, el presente y el futuro coexisten como el árbol completo de bloques, y
la «realidad» de cada nodo es la rama que el consenso fija por *decoherencia*
(fork-choice). Escrita en Rust, verificable byte a byte, con commit-reveal nativo,
una capa de red neuronal asesora y un desempate basado en matemática no probada.

> ## ⚠ Antes de nada — lee [`NOTICE.md`](NOTICE.md)
> **RAMI-Chain es una red de pruebas EXPERIMENTAL.** Su moneda **no tiene valor
> monetario**, no es una inversión ni un valor negociable, y **no se vende**: se
> obtiene gratis minando, haciendo staking o por el faucet. No hay premine.
> Software sin garantía. Cualquier web que te pida cripto o dinero por monedas de
> RAMI-Chain es fraudulenta.

## Qué es (y qué lo hace distinto)

En Bitcoin solo sobrevive la cadena de más trabajo; los bloques huérfanos se
descartan. En RAMI-Chain **todo bloque válido se conserva para siempre**: las
*ramas hermanas* (mismo padre, realidades distintas) coexisten y son auditables.
El fork-choice elige la rama del observador de forma determinista:

1. **mayor trabajo acumulado** (la regla segura, libre de conjeturas), y
2. si dos ramas empatan **exactamente** en trabajo → **desempate de Collatz**
   («colapso de coherencia»), acotado para no depender de que la conjetura sea
   cierta.

Un mismo saldo puede existir en dos ramas hermanas (son realidades distintas);
el doble gasto solo se impide **dentro** de la rama observada, que es justo lo
que la teoría afirma.

## Arquitectura

Workspace de Rust en [`chain/`](chain), con dependencias mínimas
(`sha2`, `ed25519-dalek`, `serde`, `serde_json`, `hex`):

| Módulo (`rami-core`) | Postulado | Qué hace |
|---|---|---|
| `canon` | — | JSON canónico (paridad byte a byte con la referencia Python) |
| `hashing` / `crypto` | P2 | SHA-256d, Merkle, firmas Ed25519, direcciones |
| `block` | P1/P2 | Cabecera hasheada sobre bytes fijos big-endian (nunca floats) |
| `tx` | P7 | Transacciones (Coinbase/Transfer/Stake/Unstake/**Commit/Reveal**), encoding binario determinista |
| `state` | P7/P9 | Cuentas, emisión con halving, anti-doble-gasto, regla anti-look-ahead |
| `pow` | P5 | PoW SHA-256d, objetivo compacto, retarget LWMA por bloque |
| `blocktree` | P3/P4 | Árbol ramificado (todo se conserva) + fork-choice (decoherencia) |
| `tiebreak` | P4 | **Matemática NO probada** (Collatz) como desempate, contenida |
| `nn` | P3 | MLP entero bit-exacto de invarianza de rama (UBR) — **solo asesor** |
| `ledger` | P6 | Capa commit-reveal RAMI (puerto de la referencia Python) |

Binarios: [`rami-node`](chain/crates/rami-node) (génesis, minería, estado,
verificación) y [`rami-wallet`](chain/crates/rami-wallet) (claves, saldo, envío,
staking, commit/reveal).

## La dificultad de génesis, calculada

Para una testnet minada por CPUs, con un tiempo de bloque objetivo **T = 60 s**:

- Un minero CPU hace del orden de **1×10⁶ SHA-256d/s**.
- Hashes esperados por bloque = `H0 · T = 1e6 · 60 =` **60 000 000** → esta es la
  dificultad de génesis `d0`.
- Objetivo de génesis = `(2²⁵⁶−1) / d0`; codificado en formato compacto →
  **nBits = `0x1d479531`** (round-trip verificado en los tests).
- Retarget **LWMA-1** (ventana 60 bloques, clamps [1, 6T] por solvetime y ±4×
  por bloque) que devuelve la dificultad hacia los 60 s en pocos bloques, sin el
  «death-spiral» clásico de las monedas nuevas.

`seconds/block` según hashrate agregado: 1 CPU → 60 s, 10 CPUs → 6 s, 50 → 1,2 s
(el LWMA los reconduce hacia 60 s).

## Emisión

Estilo Bitcoin, entera y determinista: **50 RAMI** de recompensa inicial,
**halving cada 210 000 bloques**, tope geométrico **~21 000 000 RAMI**
(1 RAMI = 10⁸ unidades base). **Sin premine.** El faucet se financia **minando**,
como cualquiera — no hay excepción a la cota de emisión.

## Empezar en 2 minutos

```bash
# 1) compilar (Rust estable, rustup.rs)
cd chain && cargo build --release        # binarios en target/release/

# 2) monedero
rami-wallet new --label yo
ADDR=$(rami-wallet address --label yo)

# 3) red local instantánea (regtest, dificultad 1) y minería
rami-node init --chain ./midato --network regtest --miner $ADDR
rami-node mine --chain ./midato --network regtest --address $ADDR --blocks 5
rami-node status --chain ./midato --network regtest

# 4) enviar, apostar, anclar una predicción y verificar
rami-wallet send   --chain ./midato --network regtest --to <PUBKEY> --amount 10 --label yo
rami-wallet stake  --chain ./midato --network regtest --amount 50 --label yo
rami-wallet commit --chain ./midato --network regtest --payload '{"pair":"BTC","dir":"LONG"}' --label yo
rami-node   mine   --chain ./midato --network regtest --address $ADDR   # incluye la tx
rami-node   verify --chain ./midato --network regtest
```

`regtest` mina al instante; `--network testnet` usa la dificultad real (60 s).

## Los dos componentes experimentales (y por qué son seguros)

- **Desempate de Collatz** (`tiebreak.rs`): usa la conjetura 3n+1, **abierta**. Se
  ejecuta *solo* entre ramas de trabajo idéntico y está acotado por un tope de
  1024 pasos: si la conjetura fuera falsa, degrada a orden lexicográfico. **Nunca**
  toca el trabajo, la validez, la emisión ni ningún saldo.
- **Red neuronal** (`nn.rs`): MLP entero bit-exacto (Q16.16) que puntúa la
  invarianza de rama (UBR). Es **estrictamente asesor**: no decide validez, PoW
  ni fork-choice. Se recomputa desde los bytes acordados; no se guarda en la
  cabecera; ningún bloque se rechaza jamás por su salida.

Ambos van etiquetados como EXPERIMENTAL en el código y no pueden dividir el
consenso ni crear monedas aunque fallen.

## Pruebas

```bash
cd chain && cargo test          # núcleo: decenas de tests (consenso, emisión,
                                # commit/reveal, doble-gasto, fork-choice, Collatz, NN)
```

`rami-node verify` reconstruye la cadena desde `chain.jsonl` re-admitiendo cada
bloque con todas las reglas (enlace + PoW + bits-LWMA + transición de estado).

## Estado y hoja de ruta

- **v0.1 (esto):** consenso completo, minería, monedero, commit/reveal, emisión,
  persistencia y verificación en una sola máquina. Sitio web honesto ([`web/`](web))
  para Netlify.
- **v0.2:** gossip P2P (TCP JSON-lines, id de red = hash del génesis), génesis
  público canónico fijo, faucet como Netlify Function (monedero automatizado,
  nunca una excepción de consenso), explorador sobre instantáneas re-verificables.

## Referencia

La capa commit-reveal reproduce byte a byte [`reference/rami_ledger.py`](reference/rami_ledger.py).
La teoría está en el artículo del Universo de Bloques Ramificados y su
implementación de falsación (repo `universal-timeline`, paquete `bbu`).

## Licencia

MIT — ver [`LICENSE`](LICENSE) y [`NOTICE.md`](NOTICE.md).
