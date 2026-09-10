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
