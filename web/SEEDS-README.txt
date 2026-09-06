seeds.json — nodos semilla de la testnet de RAMI-Chain
=======================================================
El monedero consulta https://quantbot.army/descargas/seeds.json al arrancar y
cada 15 minutos, y marca (conecta) a cada "host:puerto" de la lista. Sirve
para publicar nodos siempre encendidos SIN sacar una versión nueva de la app.

Formato: {"seeds": ["1.2.3.4:30301", "seed.midominio.org:30301"]}

Cómo tener un nodo semilla (VPS barato, Linux):
  1) descarga rami-chain-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz del release,
  2) abre el puerto 30301/TCP en el cortafuegos,
  3) ejecuta:  ./rami-node run --network testnet --listen 30301 --chain ./datos
  4) añade "IP:30301" a esta lista (o apunta el DNS seed.quantbot.army a esa IP).
Testnet experimental, sin valor monetario.
