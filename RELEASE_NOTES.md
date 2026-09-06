## Novedades de v0.6.1 — la red se encuentra sola

- **Los nodos de la misma casa se conectan solos** (descubrimiento en red local por UDP), sin escribir ninguna IP.
- **Apertura automática del puerto** en el router (NAT-PMP y UPnP, como Bitcoin Core) para que otras casas puedan conectarse; `--no-portmap` lo desactiva.
- **Semillas publicadas en la web** (`quantbot.army/descargas/seeds.json`) y semilla DNS `seed.quantbot.army`: un monedero recién instalado encuentra la red sin configurar nada.
- **Pestaña Red:** IP local, IP pública, estado del puerto y un **código de conexión** para compartir. Explica por qué minar sin estar conectado crea una rama aparte cuyas monedas no cuentan.
- **Ciudad:** las operaciones aún sin minar se ven como **pendientes** al instante (panel, 2D y 3D), con sondeo rápido tras cada acción y aviso si nadie está minando.
- Incluye v0.6.0 (Tenerife en 3D). Sin cambios de consenso. Testnet experimental, sin valor monetario.

## What's new in v0.6.1 — the network finds itself

- **Nodes in the same home connect on their own** (LAN discovery over UDP), no IP typing.
- **Automatic router port opening** (NAT-PMP and UPnP, like Bitcoin Core) so other homes can connect; `--no-portmap` disables it.
- **Seeds published on the website** (`quantbot.army/descargas/seeds.json`) and the DNS seed `seed.quantbot.army`: a fresh wallet finds the network with zero configuration.
- **Network tab:** local IP, public IP, port status and a **connection code** to share. Explains why mining while disconnected creates a separate branch whose coins do not count.
- **City:** operations not yet mined show as **pending** immediately (panel, 2D and 3D), with fast polling after each action and a warning if nobody is mining.
- Includes v0.6.0 (Tenerife in 3D). No consensus changes. Experimental testnet, no monetary value.
