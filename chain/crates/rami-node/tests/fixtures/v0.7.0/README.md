# Ficheros escritos por la v0.7.0 publicada

Todo lo que hay aquí lo escribieron los **binarios de la etiqueta `v0.7.0`**
(la última versión publicada antes de la 0.7.3), compilados con `--locked`,
sin retocar a mano. Son la «versión anterior» de la que parte cualquier
usuario que actualice, y `compat_v070.rs` comprueba que el código nuevo los
abre tal cual. Si un cambio de formato rompe uno de estos tests, ese cambio
rompe la actualización de alguien: no se arregla el test, se arregla el
formato.

Procedencia (regtest, sin valor; la contraseña y las claves son de prueba):

```
RAMI_WALLET_PASSWORD=prueba-1234
rami-wallet new --label yo --keystore wallet.json         # keystore v2 (cifrado)
rami-wallet new --label otro --keystore wallet.json
wallet-v1.json: mapa plano {"plano": <secreto hex>}      # formato anterior a la v0.4
rami-node init --chain chain-regtest --network regtest --miner $YO
rami-node mine --blocks 6 · send 3 · stake 2 · commit {"pair":"BTC","dir":"LONG","termino":"probable"}
rami-node mine --blocks 2 · reveal · mine --blocks 1 · send 1 (queda en mempool.jsonl)
rami-node run --listen 30391 (A) y --listen 30392 --connect 127.0.0.1:30391 (B), ~12 s
rami-node faucet --port 8790 · POST /claim {"address": $OTRO}
```

`esperado.json` guarda las direcciones, el txid del commit, la altura y la
identidad del par B tal como las imprimió la v0.7.0.
