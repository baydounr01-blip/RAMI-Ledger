## Novedades de v0.5.4 — instalar y actualizar sin terminal (para todo el mundo)

> v0.5.4 = v0.5.3 + una corrección: la copia instalada en Aplicaciones se libera de la cuarentena de descarga (como hace Sparkle) para que macOS no la ejecute «traslocada» y vuelva a proponer instalarla.

- **macOS: la app se instala sola.** Abre el `.dmg` y haz doble clic en RAMI-Chain: te propone instalarse en Aplicaciones (sustituye la versión anterior, cierra la que estuviera abierta y se reabre desde allí). Sin arrastrar, sin terminal. Si ya está abierta desde otro sitio, la pestaña Actualizar avisa y ofrece «Instalar en Aplicaciones».
- **La versión nueva toma el relevo.** Si abres una versión nueva con la anterior aún abierta, la nueva le pide que se cierre y ocupa su sitio. Antes abría el panel viejo y salía: parecía que «no se actualizaba» y el aviso volvía a salir.
- **Windows:** el instalador cierra el monedero abierto antes de sustituirlo, así «bajar el instalador nuevo y ejecutarlo» actualiza siempre.
- **Panel:** muestra desde dónde se está ejecutando la app y se recarga solo si el proceso cambia. Cada paso queda en `~/.rami/gui-launch.log`.
- **Web y README:** pasos para novatos (tres clics) y para avanzados (verificar SHA-256 e instalar desde la terminal).
- Incluye v0.5.2 (actualización de un clic con verificación SHA-256, instalación en el sitio y reapertura automática), v0.5.1 (macOS «no responde») y v0.5.0 (Ciudad RAMI 🏙️). v0.5.0+ es un cambio de reglas de la testnet (hard fork): todos los nodos deben actualizar.

## What's new in v0.5.4 — install and update without a terminal (for everyone)

> v0.5.4 = v0.5.3 + one fix: the copy installed into Applications is released from download quarantine (as Sparkle does) so macOS does not run it "translocated" and offer to install it again.

- **macOS: the app installs itself.** Open the `.dmg` and double-click RAMI-Chain: it offers to install into Applications (replacing the previous version, closing any running one, and relaunching from there). No dragging, no terminal. If it is running from elsewhere, the Update tab warns and offers "Install into Applications".
- **The new version takes over.** Opening a new version while the old one is still running now asks the old one to quit and takes its place. Previously the new one just opened the old dashboard and exited, which looked like "it didn't update".
- **Windows:** the installer closes the running wallet before replacing it, so "download the new installer and run it" always updates.
- **Dashboard:** shows where the app is running from and reloads itself if the process changes. Every step is logged to `~/.rami/gui-launch.log`.
- **Website and README:** steps for beginners (three clicks) and for advanced users (verify SHA-256 and install from the terminal).
- Includes v0.5.2 (one-click update with SHA-256 verification, in-place install and relaunch), v0.5.1 (macOS "not responding") and v0.5.0 (RAMI City 🏙️). v0.5.0+ changes the testnet rules (hard fork): all nodes must upgrade.
