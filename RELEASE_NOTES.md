## Novedades de v0.6.2 — «la aplicación no responde», resuelto de raíz

- **Por qué pasaba tras cada actualización:** al actualizar (o pulsar «Salir»), la app pedía salir desde un hilo secundario con `exit()`; en macOS esa llamada espera al hilo principal (que estaba en el bucle de eventos) y el proceso se quedaba colgado sin morir. La versión nueva esperaba a que muriera y nunca se abría; el siguiente clic en el icono encontraba un proceso «no responde».
- **Arreglo permanente:** toda salida es inmediata (`_exit`), en macOS el hilo principal atiende los eventos del sistema desde el primer instante y todo el arranque va en otro hilo, la reapertura mata la instancia vieja si no muere en 10 s, y al arrancar se fuerza el cierre de una instancia antigua colgada.
- **Garantía para el futuro:** cada release pasa una prueba de humo en CI sobre el instalador real (arranque real en macOS, respuesta a eventos con timeout, «Salir» cierra en < 5 s). Si falla, no se publica.
- **Una sola vez, al pasar de v0.6.1 a esta versión:** la v0.6.1 que tienes abierta puede quedarse colgada al salir. Si tras «Actualizar ahora» no se abre sola en un minuto, ciérrala desde Monitor de Actividad (rami-gui → Salir) y abre RAMI-Chain: ya será la nueva.
- Incluye v0.6.1 (la red se encuentra sola) y v0.6.0 (Tenerife en 3D). Sin cambios de consenso. Testnet experimental, sin valor monetario.

## What's new in v0.6.2 — "the app is not responding", fixed at the root

- **Why it happened after every update:** when updating (or pressing "Quit"), the app requested exit from a secondary thread with `exit()`; on macOS that call waits for the main thread (which was inside the event loop) and the process hung without dying. The new version waited for it and never opened; the next click on the icon found a "not responding" process.
- **Permanent fix:** every exit is immediate (`_exit`), on macOS the main thread serves system events from the very first instant and the whole startup runs on another thread, the relauncher kills the old instance if it does not die within 10 s, and on startup a hung old instance is force-closed.
- **Guarantee for the future:** every release runs a smoke test in CI on the real installer (real launch on macOS, event responsiveness with a timeout, "Quit" exits in < 5 s). If it fails, nothing is published.
- **Once, when going from v0.6.1 to this version:** the v0.6.1 you have open may hang on exit. If it does not relaunch itself within a minute after "Update now", quit it from Activity Monitor (rami-gui → Quit) and open RAMI-Chain: it will already be the new one.
- Includes v0.6.1 (the network finds itself) and v0.6.0 (Tenerife in 3D). No consensus changes. Experimental testnet, no monetary value.
