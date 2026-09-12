## Novedades de v0.9.0 — Dubái RAMI: el metaverso como reglas de consenso, con fecha de activación

**Actualiza antes del 1 de diciembre de 2026 (00:00 UTC).** Hasta esa fecha
nada cambia: la 0.9.0 se habla con la 0.8.0, firma igual (la regla v2 sigue
activándose el 20 de octubre), mina igual y abre los mismos archivos. Desde
esa fecha rigen las reglas de Dubái y los nodos anteriores se quedan en su
altura sin romperse.

- **La Ciudad RAMI se traslada a Dubái.** 64×64 parcelas de 650 m sobre una
  réplica hecha con datos abiertos (relieve de Mapzen/AWS Terrain Tiles;
  Palm Jumeirah, The World, Bluewaters, el Creek y los canales dibujados a
  mano y documentados como tales), 56 hitos modelados uno a uno, skylines por
  barrio, tráfico por las grandes vías, ciclo de día y noche con las ventanas
  encendidas. Tus parcelas conservan sus coordenadas (x, y).
- **Reglas de consenso nuevas** (`docs/DUBAI.md`): 35 distritos con precio de
  parcela propio (se quema), 30 sectores que se necesitan unos a otros, fondo
  de la ciudad con el 20 % de la emisión de cada bloque y reparto del 1 % del
  fondo por bloque según demanda, distrito, afinidad e insumos; el 40 % de
  cada ingreso paga a los proveedores más cercanos y lo que nadie ofrece se
  importa y se quema. La recompensa del minero baja al 80 % de la emisión;
  las comisiones siguen enteras. Activación por fecha sin periodo mixto y sin
  retroceso dentro de una rama; `Status.rule` anuncia 3.
- **Mercado en RAMI.** Parcelas y activos (planta, objeto, vehículo —solo lo
  acuña un concesionario— y local) se ponen en venta y se compran en una sola
  transacción con precio máximo. Las últimas 256 operaciones quedan en el
  estado y alimentan la **cotización interna**: pares parcela/RAMI por
  distrito y activo/RAMI, órdenes abiertas, cierres, fondo, quemado e índice.
  Pestaña **Mercado** en el panel, `rami-node market` (API pública de solo
  lectura en formato de agregador) y pestaña **Cotización** en la web, que
  lee los nodos de `web/market.json`. RAMI no cotiza en euros ni en otras
  criptomonedas; `docs/COTIZACION.md` dice qué haría falta fuera del
  software.
- **El mentor y la escuela de negocios.** Una regla pública (no una persona)
  calcula con las mismas funciones del reparto qué cobraría hoy cada sector
  en la parcela elegida, qué insumos faltan en la ciudad, cuántos
  competidores hay y en cuántos bloques se recupera la entrada; responde a
  preguntas escritas y ofrece ocho lecciones cortas. Cifras del estado
  actual, no promesas.
- **Personas en la ciudad.** Avatares y chat entre los visitantes conectados,
  por el túnel RAMI, firmados con la identidad del nodo y acotados en ritmo,
  tamaño y memoria; nada se guarda ni entra en el consenso. Modo **a pie**
  (WASD, mirar arrastrando, Q/E para volar) y **gafas VR** con mandos
  (palanca para andar, giro por saltos, gatillo para teletransporte) y factor
  de framebuffer alto en calidad «ultra» para pantallas 4K; presets de
  calidad y hora del día en la barra de la ciudad.
- **Compatibilidad.** El protocolo sigue siendo el v2 y ningún fichero
  existente cambia de formato; `tools/compat/roundtrip.sh` sigue en verde
  con los binarios de la v0.7.0 y la v0.7.3. Un binario v0.8.0 que abra un
  `chain.jsonl` escrito por la 0.9.0 con transacciones de mercado no lo lee
  (por red nunca las recibe): la salida es volver a la 0.9.0.

## What's new in v0.9.0 — RAMI Dubai: the metaverse as consensus rules, with an activation date

**Update before 1 December 2026 (00:00 UTC).** Until that date nothing
changes: 0.9.0 talks to 0.8.0, signs the same way (rule v2 still activates on
20 October), mines the same way and opens the same files. From that date on
the Dubai rules apply and older nodes stay at their height without breaking.

- **RAMI City moves to Dubai.** 64×64 parcels of 650 m on a replica built
  from open data (Mapzen/AWS Terrain Tiles relief; Palm Jumeirah, The World,
  Bluewaters, the Creek and the canals drawn by hand and documented as
  such), 56 landmarks modelled one by one, skylines per district, traffic on
  the main roads, a day/night cycle with lit windows. Your parcels keep their
  (x, y) coordinates.
- **New consensus rules** (`docs/DUBAI.md`): 35 districts with their own
  parcel price (burned), 30 sectors that need one another, a city fund fed
  with 20 % of every block's issuance and a payout of 1 % of the fund per
  block by demand, district, affinity and inputs; 40 % of every income pays
  the nearest suppliers and whatever nobody offers is imported and burned.
  The miner reward drops to 80 % of the issuance; fees stay whole. Activation
  by date, no mixed period, never going back within a branch; `Status.rule`
  announces 3.
- **A market in RAMI.** Parcels and assets (plant, object, vehicle — minted
  only by a car dealership — and premises) are listed and bought in a single
  transaction with a maximum price. The last 256 trades stay in the state and
  feed the **internal quotation**: parcel/RAMI pairs per district and
  asset/RAMI pairs, open asks, fills, fund, burned and an index. A **Market**
  tab in the dashboard, `rami-node market` (a public read-only API in
  aggregator format) and a **Quotation** tab on the website, which reads the
  nodes listed in `web/market.json`. RAMI is not quoted in euros or in any other
  cryptocurrency; `docs/COTIZACION.md` states what it would take outside the
  software.
- **The mentor and the business school.** A public rule (not a person)
  computes, with the same payout functions, what each sector would earn today
  on the chosen parcel, which inputs the city lacks, how many competitors
  there are and in how many blocks the entry price is recovered; it answers
  typed questions and offers eight short lessons. Figures of the current
  state, not promises.
- **People in the city.** Avatars and chat among connected visitors, over
  the RAMI tunnel, signed with the node identity and bounded in rate, size
  and memory; nothing is stored and nothing enters consensus. **Walk** mode
  (WASD, drag to look, Q/E to fly) and **VR headsets** with controllers
  (stick to walk, snap turn, trigger to teleport) and a high framebuffer
  scale in "ultra" quality for 4K displays; quality presets and time of day
  in the city toolbar.
- **Compatibility.** The protocol is still v2 and no existing file changes
  format; `tools/compat/roundtrip.sh` stays green with the v0.7.0 and v0.7.3
  binaries. A v0.8.0 binary that opens a `chain.jsonl` written by 0.9.0 with
  market transactions does not read it (over the network it never receives
  them): the way out is to go back to 0.9.0.

## Novedades de v0.8.0 — la firma ligada a la red: primer cambio de consenso, con fecha de activación

**Actualiza antes del 20 de octubre de 2026 (00:00 UTC).** Hasta esa fecha
nada cambia: la 0.8.0 se habla con la 0.7.0 y la 0.7.3, firma igual, mina
igual y abre los mismos archivos (probado con los binarios reales, ver abajo).
Desde esa fecha, la firma de cada transacción lleva dentro el identificador de
la red y los nodos anteriores dejan de seguir la cadena: no se rompen, se
quedan en su altura hasta que se actualizan.

- **La regla v2.** El mensaje firmado pasa de `"RAMI-CHAIN/tx/v1" || cuerpo`
  a `"RAMI-CHAIN/tx/v2" || network‑id || cuerpo`. Una transacción firmada
  para la testnet no vale en regtest ni en ninguna otra red (era el pendiente
  documentado en `SECURITY.md` desde la 0.7.1). El txid no cambia de fórmula.
- **Activación por fecha, sin periodo mixto.** La regla la fija el timestamp
  del bloque frente a la fecha de los parámetros de la red: antes, v1 y solo
  v1; desde, v2 y solo v2. Y **no retrocede dentro de una rama**: una vez que
  un bloque exige v2, todos sus descendientes la exigen, lleven el timestamp
  que lleven (así nadie cuela firmas v1 tras la fecha). Regtest no tiene
  fecha salvo que la fuerces con `--firma-v2-desde <unix>` en `rami-node`,
  `rami-wallet` y `rami-gui`.
- **Mempool y monedero.** El nodo admite cada transacción bajo la regla que
  rige ahora, el minero solo incluye lo que vale para el timestamp del bloque
  y, al cruzar la fecha, poda lo que quedó firmado con v1 (su nonce sigue
  libre: hay que **volver a enviar** lo que estuviera pendiente justo
  entonces). Las carteras firman con el contexto que les da el nodo.
- **Lo que ve la red, en el panel.** `Status` anuncia la regla que entiende
  cada nodo (campo nuevo `rule`, que las versiones anteriores ignoran; el
  protocolo sigue siendo el v2). Red → «📜 Regla de firma» enseña los hechos:
  regla vigente, fecha y cuenta atrás, pares que anuncian v2, pendientes
  fuera de regla; y un juicio aparte («todos los pares conectados anuncian
  v2…»). Cada par que no anuncie v2 lleva el motivo en su código de fuente.
- **Lo que se dice entero.** La cadena no acota el timestamp de los bloques
  (pendiente anterior, ahora escrito en `SECURITY.md`): un minero puede
  adelantar la activación para su rama con un timestamp futuro; no puede
  retrasarla. Detalle, pruebas y lista para operadores en
  `docs/CONSENSO-V2.md`.
- **Compatibilidad probada con los binarios reales.** `tools/compat/roundtrip.sh`
  (CI) añade un cuarto paso: la nueva fuerza la activación en regtest, envía
  una tx v1 y otra v2 y mina; la misma versión sin la fecha no admite esos
  bloques; la **v0.7.0** abre el directorio, avisa de los bloques que no
  entiende, lee el saldo, mina su rama y arranca el nodo sin caerse; y la
  nueva vuelve a abrir lo que la v0.7.0 escribió. El mismo recorrido se
  ejecuta contra la **v0.7.3**. `tests/compat_v070.rs` sigue en verde y
  `activacion_v2.rs` prueba la activación con las piezas reales.

## Novedades de v0.7.3 — la palabra exacta: fuentes graduadas, hechos junto a los juicios, predicciones con término

Esta versión no cambia el consenso, no cambia el protocolo (la v0.7.0 y la
0.7.3 se hablan) y **no cambia el formato de ningún archivo**: lo nuevo son dos
archivos nuevos que las versiones anteriores ignoran. Si vienes de la v0.7.0
(la última publicada; la 0.7.1 y la 0.7.2 nunca se publicaron), tu monedero,
tu cadena, tus pares y tus reveals se abren tal cual — y se ha probado con los
binarios reales de la v0.7.0, en las dos direcciones (ver abajo).

- **Los pares, graduados como fuentes (código Admiralty).** En Red → Pares,
  cada par lleva un código como «B2»: una **letra por su historial** (bloques
  suyos válidos e inválidos; A, fiable con historial largo … F, sin historial;
  un cambio de identidad pone tope en C) y un **número por esta sesión** (1,
  una punta suya está en tu árbol y la anuncia otro par … 6, sin nada
  todavía). Pasa el ratón para ver los motivos. Describe, no decide: cada
  bloque se revalida igual venga de quien venga. El historial vive en
  `peer-grades.json` (archivo nuevo, tope 256 pares).
- **«Sincronizado» ya no va solo.** Al lado, el hecho: tu altura, la mejor
  altura de los pares y cuántos bloques faltan. La autoauditoría separa
  también *juicio* (✓/✗ y nombre) de *hecho* (lo observado, con su duración).
- **Predicciones con la palabra exacta.** Al comprometer una predicción
  puedes decir con qué probabilidad la afirmas con la escala de siete
  términos (ICD 203): «probable (55–80 %)», nunca un porcentaje suelto ni 0 ni
  100. El término va dentro del payload (bytes opacos: ninguna regla cambia).
  Un **libro local** (`predicciones-libro.json`, archivo nuevo) apunta cada
  predicción con término; cuando sepas el desenlace, márcalo, y el libro te
  dice si tus «probable» ocurren entre el 55 y el 80 % de las veces (Brier y
  tabla por término). Mide si tus palabras significan lo que dicen; no mide
  acierto ni rentabilidad. Nada sale de tu ordenador.
- **Léxico vigilado en cinco idiomas.** `tools/panel/lexico.py` recorre el
  panel (español, inglés, chino, ruso, suajili), la web, el README y estas
  notas, y el CI falla si aparece «podría», «quizá», «might», «likely»,
  «可能», «возможно», «labda»… Se permite un término de la escala con su
  rango. Una frase del panel que decía «tus claves podrían seguir dentro»
  ahora dice lo que es: «tus claves siguen dentro y este programa no las
  toca».
- **La web es un mapa, no una lista.** Un mapa orbital con el génesis en el
  centro y las piezas alrededor (consenso, cuentas, commit-reveal, universo
  de ramas, UBR, colapso, túnel, nodo, monedero, panel, actualizador,
  autoauditoría, Ciudad, faucet, y las dos novedades) con las líneas de
  «quién alimenta a quién»; cada nodo abre su apartado sin recorrer la página
  entera. Los enlaces guardados (#descargas, #teoria…) siguen funcionando;
  a menos de 640 px el mapa degrada a una rejilla con una lista textual.
- **Enlaces a pestañas del panel:** `…/#red`, `…/#predicciones` abren esa
  pestaña.
- **Compatibilidad probada con los binarios de verdad.** Un test carga
  ficheros escritos por la v0.7.0 (keystore cifrado y plano, cadena regtest,
  mempool, reveals, pares, identidades, `node.key`, faucet) y el CI ejecuta
  `tools/compat/roundtrip.sh`: la v0.7.0 escribe, la 0.7.3 abre y escribe
  encima, y la v0.7.0 vuelve a abrir lo que dejó la 0.7.3 (verifica la
  cadena, lee el saldo, revela un commit hecho por la nueva y arranca su
  nodo). Si un cambio de formato rompiera la actualización —o la vuelta
  atrás—, el CI se pone en rojo.

## What's new in v0.8.0 — the signature bound to the network: first consensus change, with an activation date

**Update before 20 October 2026 (00:00 UTC).** Until that date nothing
changes: 0.8.0 talks to 0.7.0 and 0.7.3, signs the same way, mines the same
way and opens the same files (tested with the real binaries, see below). From
that date on, every transaction signature carries the network identifier
inside it and older nodes stop following the chain: they do not break, they
stay at their height until they update.

- **Rule v2.** The signed message goes from `"RAMI-CHAIN/tx/v1" || body` to
  `"RAMI-CHAIN/tx/v2" || network‑id || body`. A transaction signed for the
  testnet is worthless on regtest or any other network (the open item
  documented in `SECURITY.md` since 0.7.1). The txid formula does not change.
- **Activation by date, no mixed period.** The rule is set by the block's
  timestamp against the network parameters' date: before it, v1 and only v1;
  from it, v2 and only v2. And **it never goes back within a branch**: once a
  block requires v2, every descendant requires it whatever its timestamp
  (so nobody slips v1 signatures in after the date). Regtest has no date
  unless you force one with `--firma-v2-desde <unix>` on `rami-node`,
  `rami-wallet` and `rami-gui`.
- **Mempool and wallet.** The node admits each transaction under the rule in
  force now, the miner only includes what is valid for the block's timestamp
  and, when the date is crossed, prunes what was left signed with v1 (its
  nonce stays free: whatever was pending right then must be **sent again**).
  Wallets sign with the context the node gives them.
- **What the network sees, on the dashboard.** `Status` announces the rule
  each node understands (new `rule` field, ignored by older versions; the
  protocol is still v2). Network → "📜 Signature rule" shows the facts: rule
  in force, date and countdown, peers announcing v2, pending outside the
  rule; and a separate judgement ("every connected peer announces v2…").
  Every peer that does not announce v2 carries the reason in its source code.
- **Said in full.** The chain does not bound block timestamps (an older open
  item, now written down in `SECURITY.md`): a miner can bring activation
  forward for its branch with a future timestamp; it cannot push it back.
  Details, tests and the operator checklist are in `docs/CONSENSO-V2.md`.
- **Compatibility tested with the real binaries.** `tools/compat/roundtrip.sh`
  (CI) gains a fourth step: the new version forces activation on regtest,
  sends a v1 and a v2 transaction and mines; the same version without the
  date does not admit those blocks; **v0.7.0** opens the directory, reports
  the blocks it does not understand, reads the balance, mines its own branch
  and starts its node without crashing; and the new version reopens what
  v0.7.0 wrote. The same run is executed against **v0.7.3**.
  `tests/compat_v070.rs` stays green and `activacion_v2.rs` tests activation
  with the real pieces.

## What's new in v0.7.3 — the exact word: graded sources, facts next to judgements, predictions with a term

This release does not change consensus, does not change the protocol (v0.7.0
and 0.7.3 talk to each other) and **does not change the format of any file**:
what is new are two new files that older versions ignore. If you come from
v0.7.0 (the last published version; 0.7.1 and 0.7.2 were never published), your
wallet, your chain, your peers and your reveals open as they are — and it has
been tested with the real v0.7.0 binaries, in both directions (see below).

- **Peers graded as sources (Admiralty code).** In Network → Peers, every
  peer carries a code such as "B2": a **letter for its history** (its valid
  and invalid blocks; A, reliable with a long record … F, no history; an
  identity change caps it at C) and a **number for this session** (1, one of
  its tips is in your tree and another peer announces it too … 6, nothing
  yet). Hover to see the reasons. It describes, it does not decide: every
  block is re-validated the same way whoever it comes from. The history lives
  in `peer-grades.json` (new file, 256-peer cap).
- **"Synced" no longer stands alone.** Next to it, the fact: your height,
  the best peer height and how many blocks are missing. The self-audit also
  separates *judgement* (✓/✗ and name) from *fact* (what was observed, with
  its duration).
- **Predictions with the exact word.** When you commit a prediction you can
  say how probable it is with the seven-term scale (ICD 203): "probable
  (55–80 %)", never a bare percentage and never 0 or 100. The term travels
  inside the payload (opaque bytes: no rule changes). A **local ledger**
  (`predicciones-libro.json`, new file) records every prediction with a term;
  when you know the outcome, mark it, and the ledger tells you whether your
  "probable" happens between 55 and 80 % of the time (Brier and a per-term
  table). It measures whether your words mean what they say; it does not
  measure hit rate or returns. Nothing leaves your computer.
- **Lexicon watched in five languages.** `tools/panel/lexico.py` walks the
  dashboard (Spanish, English, Chinese, Russian, Swahili), the website, the
  README and these notes, and CI fails if "podría", "quizá", "might",
  "likely", "可能", "возможно", "labda"… appear. A scale term with its range
  is allowed. One dashboard sentence that said "your keys may still be inside"
  now says what it is: "your keys are still inside and this program does not
  touch them".
- **The website is a map, not a list.** An orbital map with the genesis at
  the centre and the pieces around it (consensus, accounts, commit-reveal,
  branch universe, UBR, collapse, tunnel, node, wallet, dashboard, updater,
  self-audit, City, faucet, and the two new pieces) with the lines of "which
  feeds which"; each node opens its section without scrolling the whole page.
  Saved links (#descargas, #teoria…) keep working; below 640 px the map
  degrades to a grid with a textual list.
- **Links to dashboard tabs:** `…/#red`, `…/#predicciones` open that tab.
- **Compatibility tested with the real binaries.** A test loads files written
  by v0.7.0 (encrypted and plain keystore, regtest chain, mempool, reveals,
  peers, identities, `node.key`, faucet) and CI runs
  `tools/compat/roundtrip.sh`: v0.7.0 writes, 0.7.3 opens and writes over it,
  and v0.7.0 reopens what 0.7.3 left (verifies the chain, reads the balance,
  reveals a commit made by the new version and starts its node). If a format
  change broke the update — or the way back — CI goes red.

## Novedades de v0.7.2 — arreglo urgente: el panel dejaba fuera a quien lo tenía abierto al actualizar

Si actualizaste a la v0.7.1 con el panel abierto en el navegador, al recargarse
te decía «sesión no autorizada» y, peor todavía, te enseñaba el cuadro de
**crear contraseña** encima de un monedero que estaba intacto. No se perdió nada
—ni claves, ni saldo, ni cadena—, pero no había forma de entrar desde esa
pestaña. Esto lo arregla y lo deja arreglado:

- **La llave de sesión ya no cambia en cada arranque.** El monedero reutiliza
  la que guarda en `~/.rami/panel-<puerto>.token` (permisos 0600, solo tu
  usuario) y solo crea una nueva si falta o está corrupta. Antes se generaba
  una llave nueva cada vez, así que la pestaña que ya estaba abierta mandaba la
  vieja. Rotarla en cada arranque tiene sentido cuando el cliente puede leer un
  archivo (el `.cookie` de Bitcoin Core); aquí el cliente es un **navegador**, y
  un navegador no puede.
- **El panel recuerda la llave del navegador, no de la pestaña.** Se guarda en
  `localStorage` por puerto, así que un marcador, una pestaña reabierta o el
  navegador reiniciado siguen funcionando. Las pestañas que vengan de la v0.7.1
  se migran solas.
- **Nunca más «crea una contraseña» encima de un monedero que existe.** Sin
  llave, `/api/status` solo devuelve versión, pid y red; el panel ahora lo
  detecta en vez de leerlo como «aquí no hay monedero».
- **Si aun así te quedas sin llave, el panel te lo explica y te saca:** una
  pantalla te dice que tu dinero está intacto, que lo fácil es abrir RAMI-Chain
  desde su icono, y te deja pegar el contenido del archivo del token si
  prefieres arreglar esa misma pestaña. En los cinco idiomas.
- **Tres tests de regresión** (`token_survives_a_restart`,
  `corrupt_token_file_is_replaced`, `reused_token_file_stays_private`) para que
  no vuelva a pasar: la llave sobrevive a los reinicios, un archivo corrupto se
  sustituye sin dejarte fuera, y reutilizarla no relaja los permisos.

Si estás bloqueado ahora mismo, sin actualizar: cierra la pestaña y abre
RAMI-Chain desde su icono (la app siempre abre el panel con la llave puesta).

## What's new in v0.7.2 — hotfix: the dashboard locked out anyone who had it open while updating

If you updated to v0.7.1 with the dashboard open in your browser, the reload
said "unauthorised session" and, worse, showed the **create a password** box on
top of a wallet that was perfectly intact. Nothing was lost — not keys, not
balance, not chain — but there was no way back in from that tab. This fixes it
and keeps it fixed:

- **The session key no longer changes on every start.** The wallet reuses the
  one stored in `~/.rami/panel-<port>.token` (mode 0600, your user only) and
  only mints a new one when it is missing or corrupt. Rotating per start makes
  sense when the client can read a file (Bitcoin Core's `.cookie`); here the
  client is a **browser**, and a browser cannot.
- **The dashboard remembers the key per browser, not per tab.** It is stored in
  `localStorage` keyed by port, so a bookmark, a reopened tab or a restarted
  browser keep working. Tabs coming from v0.7.1 migrate themselves.
- **Never again "create a password" on top of a wallet that exists.** Without a
  key, `/api/status` returns only version, pid and network; the dashboard now
  recognises that instead of reading it as "there is no wallet here".
- **And if you do end up without a key, the dashboard explains it and gets you
  out:** a screen tells you your money is intact, that the easy way is to open
  RAMI-Chain from its icon, and lets you paste the token file's contents if you
  would rather fix that very tab. In all five languages.
- **Three regression tests** (`token_survives_a_restart`,
  `corrupt_token_file_is_replaced`, `reused_token_file_stays_private`) so it
  cannot come back: the key survives restarts, a corrupt file is replaced
  without locking you out, and reusing it does not relax permissions.

If you are locked out right now, before updating: close the tab and open
RAMI-Chain from its icon (the app always opens the dashboard with the key).

## Novedades de v0.7.1 — auditoría de seguridad y autoauditoría con nuestra tecnología

- **Revisión completa del código** tras un aviso externo. Sin puertas traseras: el inventario de todo lo que el programa contacta o ejecuta está en `SECURITY-INVENTORY.txt` y el CI falla si aparece algo nuevo. Hallazgos y correcciones, con detalle, en `docs/AUDITORIA-2026-09.md`.
- **Panel local blindado:** `Host` exacto (adiós al DNS rebinding con `localhost.evil.com`), `Origin`/`Referer` comprobados, **token de sesión** como el `.cookie` de Bitcoin Core (otro usuario o proceso de tu máquina no puede dar órdenes al monedero), servidor HTTP con límites y timeouts. La app abre el panel con la llave; si abres una pestaña a mano, te lo dirá.
- **Actualizador anclado a GitHub:** las sumas SHA-256 ya no pueden venir del espejo web; si GitHub no responde, no se instala nada. Preparada la **firma Ed25519 de release** (`SHA256SUMS.sig`, la misma criptografía de la cadena): se activa cuando el mantenedor genere su clave (`rami-wallet release-keygen`).
- **Consenso y red:** topes por bloque (4096 tx, 2 MiB) y de mempool; keystore con escritura atómica; el cierre forzado de una instancia vieja solo actúa sobre `rami-gui`.
- **🛡️ Autoauditoría:** en Red → «Ejecutar autoauditoría», el monedero se conecta a su propio nodo como si fuera un par malicioso (saludo antiguo, identidad sin prueba de trabajo, firma manipulada, trama sin autenticar, trama gigante, avalancha de puntas falsas) y comprueba que todo se rechaza; también revisa permisos de claves, token y el hash del ejecutable frente al publicado. Desde la terminal: `rami-node audit --peer IP:30301 --network testnet`.
- Pendiente y dicho claramente: firma de transacción ligada a la red (cambio de consenso v0.8) y certificados de plataforma. Testnet experimental, sin valor monetario.

## What's new in v0.7.1 — security audit and self-audit with our own technology

- **Full code review** after an external warning. No backdoors: the inventory of everything the program contacts or executes lives in `SECURITY-INVENTORY.txt` and CI fails if anything new appears. Findings and fixes, in detail, in `docs/AUDITORIA-2026-09.md`.
- **Hardened local dashboard:** exact `Host` (no more DNS rebinding via `localhost.evil.com`), `Origin`/`Referer` checked, a **session token** like Bitcoin Core's `.cookie` (another user or process on your machine cannot give orders to the wallet), HTTP server with limits and timeouts. The app opens the dashboard with the key; a tab opened by hand will tell you.
- **Updater anchored to GitHub:** SHA-256 sums can no longer come from the web mirror; if GitHub does not answer, nothing is installed. **Ed25519 release signature** ready (`SHA256SUMS.sig`, the chain's own cryptography): it activates once the maintainer generates a key (`rami-wallet release-keygen`).
- **Consensus and network:** per-block caps (4096 tx, 2 MiB) and mempool caps; atomic keystore writes; force-closing an old instance only acts on `rami-gui`.
- **🛡️ Self-audit:** in Network → "Run self-audit", the wallet connects to its own node as a malicious peer (old handshake, identity without proof of work, tampered signature, unauthenticated frame, giant frame, flood of fake tips) and checks that everything is rejected; it also reviews key permissions, the token and the executable hash against the published one. From the terminal: `rami-node audit --peer IP:30301 --network testnet`.
- Pending, stated plainly: network-bound transaction signatures (consensus change in v0.8) and platform certificates. Experimental testnet, no monetary value.
