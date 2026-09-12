# PENDIENTE v0.9.0 (estado de la rama; borrar al publicar el release)

Segundo cambio de consenso: **Dubái RAMI** (`docs/DUBAI.md`), activación el
**2026‑12‑01 00:00 UTC**. Antes de esa fecha la 0.9.0 es indistinguible de la
0.8.0 para la red y para los archivos; la firma v2 sigue activándose el 20 de
octubre (`docs/CONSENSO-V2.md`). Cotización interna y API de mercado en
`docs/COTIZACION.md`.

## Verificado en esta rama (Linux, Rust estable)

- `cargo test --workspace --release --locked` en verde: rami-core (distritos,
  grafo de insumos, reparto determinista, mentor, mercado y activación),
  rami-net (`Presence`/`Chat` y su forma antigua), rami-node
  (`activacion_dubai` con las piezas reales; `activacion_v2`, `compat_v070`,
  `sync`, `update_e2e` intactos).
- `tools/geo/build_dubai.py`: «TODO OK» (Downtown, Deira, Jebel Ali, mar
  abierto, Atlantis y Burj Al Arab sobre tierra estampada, Creek excavado,
  orientación, relectura del PNG, cobertura de la bbox, ≤ 2,5 MB).
- `tools/panel/check.py`, `tools/panel/lexico.py`, `gen_i18n.py` sin
  traducciones que falten en cuatro idiomas, `tools/security/inventory.sh
  --check` sin cambios.

## Queda por hacer

1. Publicar la v0.8.0 (firma v2, 20 de octubre) y la v0.9.0 (Dubái, 1 de
   diciembre) con margen; avisar en la web y en el panel.
2. Operar al menos un nodo público de mercado (`rami-node market`) y
   apuntarlo en `web/market.json` para que la web muestre la cotización.
3. Probar el cliente 3D con gafas reales (Quest/Pico/SteamVR): mandos,
   teletransporte y factor de framebuffer en «ultra».
4. Cota de timestamp de los bloques (otro cambio de consenso; `SECURITY.md`).
5. Los puntos que siguen de versiones anteriores: cross-check macOS/Windows,
   claves de release, acciones de GitHub fijadas por SHA, certificados de
   plataforma.
