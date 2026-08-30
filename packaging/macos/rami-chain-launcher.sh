#!/bin/bash
# Lanzador de la app de macOS: abre el monedero de escritorio (que a su vez abre
# el panel en el navegador). Se ejecuta al hacer doble clic en RAMI-Chain.app.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/rami-gui" --network testnet
