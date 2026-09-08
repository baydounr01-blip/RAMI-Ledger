#!/usr/bin/env bash
# Envoltorio de tools/security/inventory.py (ver ahí la explicación).
#   tools/security/inventory.sh            # imprime el inventario
#   tools/security/inventory.sh --check    # falla si difiere de SECURITY-INVENTORY.txt
set -euo pipefail
exec python3 "$(dirname "$0")/inventory.py" "$@"
