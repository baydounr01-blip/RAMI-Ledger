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

Crates de red y aplicación (v0.2):

- [`rami-net`](chain/crates/rami-net) — gossip P2P sobre TCP JSON-lines, **sin
  servidor central**: handshake con `network-id` (hash del génesis), sincronización
  por lotes y retransmisión de bloques/tx. Solo transporte; el nodo revalida todo.
- [`rami-node`](chain/crates/rami-node) — nodo: `init`, `run` (demonio P2P que
  escucha, sincroniza y mina), `mine`, `status`, `verify`, `show`. También es
  biblioteca del runtime que usa el monedero de escritorio.
- [`rami-wallet`](chain/crates/rami-wallet) — CLI del monedero (claves, saldo,
  envío, staking, commit/reveal) y biblioteca de firma compartida.
- [`rami-gui`](chain/crates/rami-gui) — **monedero de escritorio**: un binario que
  arranca tu nodo P2P (minería opcional) y sirve un panel local en el navegador
  para hacerlo todo desde ahí. La red neuronal sigue siendo solo asesora.

## La dificultad de génesis, calculada

Para una testnet minada por CPUs, con un tiempo de bloque objetivo **T = 60 s**:

- Un minero CPU hace del orden de **1×10⁶ SHA-256d/s**.
- Hashes esperados por bloque en régimen estable = `H0 · T = 1e6 · 60 =`
  **60 000 000** → esta es la dificultad de equilibrio a la que converge el LWMA
  con ~1 CPU. Con más hashrate sube; con menos, baja (siempre hacia 60 s/bloque).
- **Arranque de la testnet:** el génesis es fijo y canónico (mismo bloque en
  todas las máquinas → mismo `network-id`) con una **dificultad de arranque baja**
  (`crate::genesis`), para que la red pueda nacer con poco hashrate. El LWMA la
  reconduce hacia el equilibrio en pocos bloques, sin el «death-spiral» de las
  monedas nuevas ni un número mágico grabado.
- Retarget **LWMA-1** (ventana 60 bloques, clamps por solvetime y ±4× por bloque).

Es decir, la dificultad **se calcula sola** a partir del hashrate real: no se fija
a mano. La cifra de 60 M es el punto de equilibrio calculado para 1 CPU a 1e6 H/s;
se verificó de extremo a extremo (un nodo minando llevó la dificultad de 4096
hacia ~1e6 en decenas de bloques mientras un segundo nodo sincronizaba por P2P).

## Emisión

Estilo Bitcoin, entera y determinista: **50 RAMI** de recompensa inicial,
**halving cada 210 000 bloques**, tope geométrico **~21 000 000 RAMI**
(1 RAMI = 10⁸ unidades base). **Sin premine.** El faucet se financia **minando**,
como cualquiera — no hay excepción a la cota de emisión.

## Lo más fácil: el monedero de escritorio

**Sin terminal (para cualquier persona).** Descarga el instalador de tu sistema
en [quantbot.army](https://quantbot.army/#descargas) (o en las
[releases](https://github.com/baydounr01-blip/RAMI-Ledger/releases/latest)):

- **macOS:** abre el `.dmg` y haz doble clic en RAMI-Chain. La app **se instala
  sola en Aplicaciones** (sustituyendo la versión anterior) y se abre desde
  allí. Apple Silicon (M1–M4) → `macos-arm64`; Intel → `macos-x64`.
- **Windows:** ejecuta el instalador `-setup.exe` (cierra el monedero si está
  abierto y lo sustituye).
- **Linux:** da permiso de ejecución al `.AppImage` y ábrelo.

**Actualizar:** el panel avisa cuando hay versión nueva → «Actualizar ahora».
La app descarga el instalador oficial, **verifica su SHA-256** contra
`SHA256SUMS.txt`, instala la versión nueva encima, **se cierra y se vuelve a
abrir sola**; el panel se recarga. A mano: descarga el archivo nuevo y ábrelo
igual que la primera vez; si la versión anterior sigue abierta, la nueva le
pide que se cierre y ocupa su sitio. Cada paso queda en
`~/.rami/gui-launch.log`.

**Estado de la firma:** hasta que el proyecto tenga certificados Developer ID /
Authenticode (ver `SIGNING.md`; el pipeline ya está listo), macOS y Windows
muestran un aviso en la **primera** apertura de una build descargada con el
navegador. Nunca pedimos saltarse un aviso: verifica el SHA-256 y abre de forma
consciente (clic derecho → Abrir). Las actualizaciones hechas desde la app no
vuelven a pasar por ese aviso.

**Desde el código:**

```bash
cd chain && cargo build --release        # o descarga el binario de las releases
./target/release/rami-gui --network testnet
# abre el panel en http://127.0.0.1:8645 — minar (un clic), enviar, recibir,
# apostar y anclar predicciones, todo desde ahí. Para unirte a un par:
./target/release/rami-gui --network testnet --connect IP_DEL_PAR:30301
```

## En la terminal (usuarios avanzados)

```bash
# 1) monedero (CIFRADO por defecto; la contraseña también puede ir en
#    RAMI_WALLET_PASSWORD). La dirección se lee sin contraseña, para minar.
rami-wallet new --label yo --password TU_CONTRASEÑA
ADDR=$(rami-wallet address --label yo)   # sin contraseña

# 2a) demonio P2P de testnet: escucha, sincroniza y mina hacia tu dirección
#     (recuerda los pares en peers.json y los re-marca al arrancar; --connect
#      acepta también hostnames DNS)
rami-node run --network testnet --listen 30301 --connect IP_DEL_PAR:30301 --miner $ADDR --mine

# 2b) faucet de operador (opcional): reparte monedas de TU monedero con goteo
#     y espera por dirección; nunca pide pago ni toca el consenso
rami-node faucet --network testnet --chain ./midato --label yo --drip 10 --cooldown 3600

# 2c) o una red local instantánea (regtest, dificultad 1)
rami-node init --chain ./midato --network regtest --miner $ADDR
rami-node mine --chain ./midato --network regtest --address $ADDR --blocks 5
rami-node status --chain ./midato --network regtest

# 3) enviar, apostar, anclar una predicción y verificar (regtest). Firmar exige
#    la contraseña (--password o RAMI_WALLET_PASSWORD); consultar saldo no.
export RAMI_WALLET_PASSWORD=TU_CONTRASEÑA
rami-wallet send   --chain ./midato --network regtest --to <PUBKEY> --amount 10 --label yo
rami-wallet stake  --chain ./midato --network regtest --amount 50 --label yo
rami-wallet commit --chain ./midato --network regtest --payload '{"pair":"BTC","dir":"LONG"}' --label yo
rami-node   mine   --chain ./midato --network regtest --address $ADDR   # incluye la tx
rami-node   verify --chain ./midato --network regtest
```

`regtest` mina al instante; `--network testnet` usa el génesis canónico y la
dificultad real (arranca baja y el LWMA la reconduce hacia 60 s/bloque).

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
                                # commit/reveal, doble-gasto, fork-choice, Collatz, NN),
                                # protocolo P2P y una prueba de integración de dos
                                # nodos reales que comparten génesis y sincronizan.
```

`rami-node verify` reconstruye la cadena desde `chain.jsonl` re-admitiendo cada
bloque con todas las reglas (enlace + PoW + bits-LWMA + transición de estado).

## Estado y hoja de ruta

- **v0.1:** consenso completo, minería, monedero CLI, commit/reveal, emisión,
  persistencia y verificación en una sola máquina.
- **v0.2:** **gossip P2P** (TCP JSON-lines, `network-id` = hash del génesis;
  sincronización y retransmisión, sin servidor central), **génesis canónico
  fijo**, demonio `rami-node run`, y un **monedero de escritorio** (`rami-gui`)
  que hace de nodo + minero + panel local. Instaladores multiplataforma de un
  archivo con icono (.dmg / setup.exe / AppImage) publicados por CI con `SHA256SUMS`.
- **v0.3 (esto):**
  - **Descubrimiento persistente de pares:** el nodo recuerda los pares
    remarcables (`peers.json`, IP + puerto anunciado en el handshake) y los
    re-marca al arrancar; el intercambio `GetPeers` solo comparte direcciones
    remarcables. `--connect` acepta hostnames (DNS) además de IPs.
  - **Explorador** integrado en el panel del monedero: lista de bloques y
    detalle de cada bloque con sus transacciones (`/api/block`).
  - **Faucet de operador** (`rami-node faucet`): reparte monedas del monedero
    del PROPIO operador (financiado minando) con goteo y espera por dirección.
    Es un monedero normal — **jamás** una excepción de consenso — y nunca pide
    pago. La espera se indexa por la clave canónica de la dirección (mismo pubkey
    en mayúsculas/minúsculas o con prefijo `rami1` = una sola espera), y solo se
    registra si el goteo se encoló de verdad. *Nota:* el faucet y el nodo
    comparten `mempool.jsonl`; si el nodo lo reescribe justo al encolarse un
    goteo, ese goteo puede perderse y bastará re-pedirlo — el IPC dedicado
    faucet↔nodo llega en v0.4.
- **v0.4 (esto):**
  - **Monedero cifrado con contraseña por defecto** (`rami-wallet`): formato v2
    con **PBKDF2-HMAC-SHA256 (600k) + ChaCha20-Poly1305** (RustCrypto, nunca
    criptografía casera). La clave pública se guarda en claro para **minar y ver
    saldo con el monedero bloqueado**; el secreto solo se descifra al firmar. Los
    almacenes v1 en texto plano se migran con `rami-wallet passwd`.
  - **Apartado Staking** en el panel (apostar / retirar / saldo apostado) y
    estados de monedero en la GUI (crear contraseña / desbloquear / bloquear).
  - **Aviso de "actualización disponible"** en el panel: compara la versión en
    ejecución con el último release publicado y avisa si hay una nueva.
- **v0.4.1 (esto):**
  - **Auto-actualizador desde la propia app.** El aviso ya no solo enlaza a la
    descarga: con **«Actualizar ahora»** el monedero descarga el instalador
    oficial del release, **verifica su SHA-256** contra `SHA256SUMS.txt` **antes
    de tocar nada** y solo entonces lo aplica. Nunca ejecuta ni sobrescribe nada
    cuyo hash no coincida. En Linux (AppImage) sustituye su propio ejecutable de
    forma atómica (basta reiniciar); en macOS/Windows guarda el instalador
    **verificado** y lo abre para que el instalador firmado del sistema termine
    (y siga pasando el filtro de Gatekeeper/SmartScreen — no nos saltamos ningún
    aviso de seguridad). Endpoints locales `GET /api/update` y
    `POST /api/update/apply`.
- **v0.4.2 (esto):** arranque robusto («la app no responde» arreglado de raíz) y
  actualización anclada a la web.
  - **Instancia única, como Bitcoin Core:** si ya hay un monedero abierto en la
    máquina, el segundo lanzamiento abre el navegador hacia ese panel en vez de
    morir en silencio. Si el puerto del panel lo ocupa otro programa, se prueban
    los siguientes automáticamente.
  - **macOS: cada clic en el icono responde.** El `.app` marca `LSUIElement`
    (la interfaz es el navegador: sin exigencia de event loop, se acabó el
    «no responde» de Forzar salida) y el binario entra en modo lanzadera al
    abrirse desde el Finder: el proceso del clic delega en un hijo
    independiente y sale, así que relanzar la app siempre ejecuta código —
    si el monedero ya corre, reabre su panel en el navegador.
  - **Abrir el navegador ya no es fe ciega:** en Linux se prueban `$BROWSER`,
    `xdg-open` y varias alternativas comprobando el resultado (un entorno sin
    `xdg-utils` dejaba el panel vivo pero invisible).
  - **P2P sin puerto no es P2P cojo:** si el 30301 está ocupado, se escucha en
    un puerto efímero (anunciado a los pares) en vez de quedar solo-salientes.
  - **Windows autosuficiente:** el binario se enlaza con CRT estático — en un
    PC sin el runtime de Visual C++ la app ni siquiera arrancaba, sin mensaje.
  - **La cadena ya no se «brickea»:** un cierre forzado o un apagón a mitad de
    escritura dejaba `chain.jsonl` con la última línea truncada y la app no
    volvía a abrir nunca. Ahora el arranque se recupera solo (ignora la línea
    interrumpida y los bloques que no re-admiten; la red re-provee lo perdido) y
    nunca modifica el archivo.
  - **El panel abre AL INSTANTE:** el nodo revalida la cadena en segundo plano
    mientras el panel muestra «cargando la cadena…» (antes, con una cadena
    grande, la app parecía colgada minutos). Las llamadas del panel al nodo
    llevan timeout: un nodo ocupado ya no congela la interfaz.
  - **Errores de arranque VISIBLES:** en macOS/Windows la app se lanza sin
    consola, así que cualquier fallo fatal ahora se muestra como página en el
    navegador en lugar de desaparecer sin explicación. En Windows ya no se abre
    ventana de consola (`windows_subsystem = "windows"`).
  - **Botón «⏻ Salir» en el panel** (`POST /api/quit`): cierra nodo y app del
    todo. En macOS la app no tiene ventana propia; sin esto quedaba corriendo
    invisible y el siguiente clic en el icono parecía no responder.
  - **Keystore ilegible = intocable:** si el archivo del monedero existe pero no
    se puede leer, JAMÁS se sobrescribe con uno nuevo (CLI y panel lo rechazan y
    lo explican). Antes, un keystore corrupto podía acabar reemplazado.
  - **Windows sin `HOME`:** la cadena y las claves van siempre a `USERPROFILE`
    (antes podían caer al directorio de trabajo, distinto según cómo lanzaras la
    app — el monedero «desaparecía»).
  - **Panel local blindado frente a webs maliciosas:** se exige `Host` local
    (anti DNS-rebinding) y `Content-Type: application/json` en todo POST (un
    formulario cross-origin ya no puede dar órdenes al nodo).
  - **Actualizar desde la app en macOS/Windows cierra el monedero** tras abrir
    el instalador verificado (con la app viva, el instalador no podía reemplazar
    el ejecutable en uso).
  - **Actualización conectada a la página web (quantbot.army):** la web publica
    en `descargas/latest.json` un espejo del release (mismos archivos y hashes,
    servidos desde su propio dominio); si la API de GitHub no responde, el
    auto-actualizador usa ese espejo, y el enlace manual del aviso lleva a la
    web. La web además muestra un aviso cuando se publica una versión más nueva
    que la que sirven sus descargas.
- **v0.4.3 (esto):** un fallo de arranque ya no puede ser invisible.
  - **Caja negra** (`~/.rami/gui-launch.log`): cada paso del arranque y todo
    error o panic quedan registrados en disco. Si tras un fallo el archivo ni
    existe, el sistema nunca llegó a ejecutar el binario (p. ej. `.dmg` del
    chip equivocado) — eso también es diagnóstico.
  - **Diálogo NATIVO de macOS** (osascript) ante cualquier error fatal, además
    de la página en el navegador: visible incluso si el navegador no abre.
  - **La lanzadera VERIFICA el arranque:** tras delegar en el hijo comprueba
    que el panel llega a estar accesible; si el hijo muere o no abre el panel
    en 12 s, lo dice con diálogo + página de error y el código de salida. Si ni
    siquiera puede relanzarse, continúa en primer plano en vez de morir.
  - **Panic ≠ colgado:** un panic al cargar la cadena pasa el panel a estado
    de error visible (antes se quedaba en «cargando…» para siempre).
  - Web y LÉEME: guía del chip (M1–M4 = Apple Silicon, Intel = Intel — con el
    `.dmg` equivocado la app no abre), arrastrar a Aplicaciones antes de abrir,
    y cómo ver el error en directo desde Terminal.
- **v0.4.4 (esto):** la actualización deja de ser invisible cuando estás al día.
  - **Sección «Actualizar» permanente en el panel** (y la versión de la barra
    superior es clicable): versión instalada, última publicada, botón «Buscar
    actualizaciones» que muestra el resultado (o el error de conexión) y, si
    hay versión nueva, «Actualizar ahora». Antes solo existía el aviso
    automático, que por diseño no aparece si ya tienes la última versión — y
    parecía que «no había opción de actualizar».
- **v0.5.0 (esto): Ciudad RAMI — fase 0 del metaverso, en la testnet.**
  Parcelas, empresas y activos como **reglas nativas de consenso** en Rust
  (sin máquina virtual): seis transacciones nuevas.
  - `ClaimParcel`: reclama una parcela de la cuadrícula 32×32 y «monta la
    empresa» (nombre + tipo). Una parcela libre cuesta 10 RAMI que se
    **queman** (sumidero anti-spam; nadie los cobra). Reclamar una propia la
    renombra por solo la comisión.
  - `MintAsset`: acuña un activo (planta u objeto; NFT nativo, id = txid) en
    una parcela propia (1 RAMI quemado). `TransferAsset`: lo cede (no si está
    alquilado).
  - `ListLease` / `Rent`: el dueño publica un activo en alquiler (precio +
    plazo en bloques, máx. ~1 año); otro lo alquila pagando el precio al dueño
    y queda arrendatario hasta `altura + plazo` (vencimiento implícito, sin
    limpieza).
  - `Harvest` («cosecha»): el dueño de la parcela reparte un total **de su
    propio saldo** a partes iguales entre los arrendatarios activos de las
    plantas de esa parcela. Es el mecanismo real de una empresa distribuyendo
    ingresos, simulado con RAMI de testnet — nunca dinero de la nada.
  - **Panel «🏙️ Ciudad»**: ciudad isométrica (canvas, sin dependencias) para
    elegir parcela, montar la empresa con un clic, acuñar plantas, publicar y
    alquilar, y repartir cosechas. Incluye la **granja demo de cannabis
    medicinal** como ejemplo del modelo. Endpoints `GET /api/city` y
    `POST /api/city/{claim,mint,transfer,list,rent,harvest}`.
  - **Mempool con las reglas reales**: el mempool y el bloque candidato usan
    ahora `apply_tx` (la misma función que valida bloques). Antes una tx
    «válida de forma» pero inválida de estado (p. ej. un reveal de un commit
    inexistente) podía colarse en el candidato, invalidar el bloque minado y
    dejar al minero atascado.
  - Marco: es una **simulación** en una testnet **sin valor monetario**. No es
    una inversión ni una oferta de valores. Tokenizar participaciones reales
    en beneficios exige una entidad autorizada (fase 2 de la hoja de ruta:
    plataforma ECSP/valores tokenizados con KYB/KYC y auditor) — ver la
    sección «Hoja de ruta del metaverso».
- **v0.5.1 (esto): macOS — la app deja de «no responder».** macOS mostraba
  «La aplicación RAMI-Chain no responde» al hacer clic en el icono con la app
  ya abierta: el proceso (un binario de consola) nunca atendía los eventos del
  sistema, aunque el nodo funcionara. Ahora, lanzada desde el Finder, la app
  corre un **bucle de eventos Cocoa real** en el hilo principal (runtime de
  Objective‑C vía FFI, sin dependencias) con un delegado que, al reabrir la
  app (clic en el icono), **abre el panel en el navegador**. El servidor del
  panel pasa a un hilo. Desde una terminal se comporta como siempre. Se retira
  la lanzadera de v0.4.2 (ya innecesaria).
- **v0.5.2 (esto): actualización de UN clic, para expertos y novatos.** Hasta
  ahora, en macOS y Windows «Actualizar ahora» solo descargaba el instalador
  verificado, lo abría y cerraba la app: si el usuario no arrastraba la app a
  Aplicaciones (o no terminaba el instalador), **seguía con la versión vieja**
  — por eso la Ciudad RAMI «no aparecía» tras actualizar. Ahora el monedero
  descarga, **verifica el SHA-256**, **instala la versión nueva en el sitio de
  la actual** (macOS: monta el .dmg sin ventana y copia la app con `ditto`
  sobre el bundle instalado, con verificación de firma y vuelta atrás si
  falla; Windows: instalador oficial en modo silencioso sobre la misma
  carpeta; Linux: AppImage sustituido de forma atómica), **se cierra y se
  vuelve a abrir sola**; la pestaña del panel espera y **se recarga** con la
  versión nueva (también si estaba abierta de antes: al detectar otra versión
  se recarga sola). La pestaña Actualizar muestra las **Novedades** del
  release y enlaza al release de GitHub y a la web. Cada paso queda en la caja
  negra `~/.rami/gui-launch.log`. No se salta ninguna comprobación del
  sistema: es el esquema habitual de los actualizadores de escritorio
  (verificación criptográfica y sustitución de una app ya instalada por el
  usuario). Las notas del release salen de `RELEASE_NOTES.md`.
- **v0.5.2: actualización de un clic.** «Actualizar ahora» descarga, verifica
  el SHA-256, instala la versión nueva en el sitio de la actual (macOS: copia
  con `ditto` y verificación de firma; Windows: instalador oficial en
  silencio; Linux: AppImage atómico), se cierra y **se vuelve a abrir sola**.
  El panel espera y se recarga; pestaña Actualizar con «Novedades». Antes, en
  macOS/Windows solo se abría el instalador y había que terminar a mano.
- **v0.5.3–v0.5.4 (esto): instalación sin terminal, como Bitcoin Core.** La app de
  macOS, abierta desde el `.dmg` (o Descargas), **se instala sola en
  Aplicaciones** con un diálogo nativo, cierra la versión anterior y se reabre
  desde allí (`/api/install` y aviso en la pestaña Actualizar si no está
  instalada). Una versión nueva que encuentra a la anterior abierta **le pide
  que se cierre y ocupa su sitio** (antes abría el panel viejo y salía:
  parecía que «no se actualizaba»). El instalador de Windows cierra el
  monedero abierto antes de sustituirlo. `/api/status` incluye `pid` y desde
  dónde corre la app; el panel se recarga si el proceso cambia. Web/README
  con los pasos para novatos y para avanzados (terminal). v0.5.4: la copia
  instalada se libera de la cuarentena de descarga (como hace Sparkle: es la
  misma app que el usuario ya abrió y cuya firma se verifica) para que macOS
  no la ejecute «traslocada» y vuelva a pedir instalarla; la reapertura tras
  instalarse lleva `--no-install`.
- **v0.5.5 (esto): panel en cinco idiomas.** Selector de idioma en la barra
  superior del monedero: **español, inglés, chino (simplificado), ruso y
  suajili**. Las claves son el texto original en español (estilo gettext): el
  panel se traduce recorriendo los nodos de texto, placeholders y tooltips, y
  lo que genera el JS pasa por `t()`. Diccionarios en
  `crates/rami-gui/src/i18n.js` (servido en `/i18n.js`), fáciles de corregir
  o ampliar (añadir un idioma = añadir un diccionario). La elección se
  recuerda en el navegador y se guarda en `~/.rami/lang` (`POST /api/lang`)
  para que los diálogos nativos de macOS salgan en el mismo idioma; sin
  elección previa se usa el idioma del sistema.
- **v0.6.0 (esto): Tenerife en 3D, el metaverso sobre la isla real.** La
  Ciudad RAMI pasa de un tablero isométrico a un **mapa 3D de Tenerife** hecho
  con **datos abiertos** (relieve de Mapzen/AWS Terrain Tiles a ~67 m/píxel:
  costa, Teide, barrancos; pueblos, aeropuertos y carreteras principales de
  Natural Earth), embebido en el binario (`tools/geo/build_tenerife.py`
  reconstruye el dataset; ver `tools/geo/README.md`). La cuadrícula de
  consenso 32×32 se proyecta sobre TODA la isla (celda de 2,6 km): cada
  parcela corresponde a un lugar real y **«Localizar mi empresa»** geocodifica
  una dirección (OpenStreetMap Nominatim, solo a petición) y la lleva a su
  parcela. Renderer Three.js (r150, MIT, empaquetado) con todo instanciado,
  LOD de terreno, cámara orbital propia, vista Isla/Ciudad, etiquetas y
  **WebXR** («🥽 Gafas VR»: Quest/Pico/SteamVR con navegador WebXR). Vista 2D
  como respaldo si no hay WebGL; el panel no repinta nada si la ciudad no
  cambió. **Sin cambios de consenso** (no hay hard fork). Marco legal: no se
  usa Google Maps/Earth (sus condiciones prohíben extraer sus datos) y
  RAMI-Chain **no verifica** la existencia ni la legalidad de ninguna empresa:
  el panel enlaza al Registro Mercantil y al BORME para que cada uno lo
  compruebe. Testnet sin valor monetario.
- **v0.6.x (siguiente):** instantáneas de cadena re-verificables para el explorador
  web, seeds comunitarios, endurecimiento P2P (puntuación de pares, límites por
  IP) y IPC dedicado faucet↔nodo.

## Referencia

La capa commit-reveal reproduce byte a byte [`reference/rami_ledger.py`](reference/rami_ledger.py).
La teoría está en el artículo del Universo de Bloques Ramificados y su
implementación de falsación (repo `universal-timeline`, paquete `bbu`).

## Licencia

MIT — ver [`LICENSE`](LICENSE) y [`NOTICE.md`](NOTICE.md).
