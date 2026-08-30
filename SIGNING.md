# Firma y notarización de las descargas

Para que **macOS** y **Windows** dejen abrir el monedero **sin avisos de
seguridad** ("desarrollador no identificado" / SmartScreen), los ejecutables
deben ir **firmados con un certificado** emitido a tu nombre. Eso es un requisito
de Apple y de Microsoft: **no se puede simular ni desactivar** desde el código, y
esos certificados son **tuyos** (van ligados a tu identidad y tienen coste).

El CI ya trae **toda la maquinaria montada**: en cuanto añadas los certificados
como *secrets* del repositorio, cada release sale **firmada (y notarizada en
macOS)** de forma automática. Si no hay certificados, las descargas se publican
**sin firmar** y se pueden verificar con `SHA256SUMS.txt` (integridad
criptográfica, aunque el SO siga mostrando su aviso la primera vez).

## macOS — firma Developer ID + notarización

Necesitas una **cuenta de Apple Developer** (99 USD/año). Con ella:

1. Crea un certificado **"Developer ID Application"** y expórtalo a `.p12`.
2. Crea una **contraseña específica de app** para notarización (appleid.apple.com).
3. Añade estos *secrets* en el repo (Settings → Secrets and variables → Actions):

| Secret | Qué es |
|---|---|
| `MACOS_CERT_P12_BASE64` | tu `.p12` en base64 (`base64 -i cert.p12 \| pbcopy`) |
| `MACOS_CERT_PASSWORD` | contraseña del `.p12` |
| `MACOS_SIGN_IDENTITY` | p. ej. `Developer ID Application: Tu Nombre (TEAMID)` |
| `APPLE_ID` | tu Apple ID (correo) |
| `APPLE_TEAM_ID` | tu Team ID de 10 caracteres |
| `APPLE_APP_PASSWORD` | la contraseña específica de app |

El CI firmará `RAMI-Chain.app` con *hardened runtime* y notarizará el `.dmg`.

## Windows — firma Authenticode

Necesitas un **certificado de firma de código** de una CA (DigiCert, Sectigo…).
Un certificado **OV** funciona pero SmartScreen tarda en ganar reputación; uno
**EV** da confianza inmediata. Exporta el certificado a `.pfx` y añade:

| Secret | Qué es |
|---|---|
| `WINDOWS_CERT_PFX_BASE64` | tu `.pfx` en base64 |
| `WINDOWS_CERT_PASSWORD` | contraseña del `.pfx` |

El CI firmará `RAMI-Chain-Setup.exe` con `signtool` y sello de tiempo SHA-256.

## Mientras no haya certificados: cómo abrir las descargas

- **macOS:** clic derecho sobre la app → **Abrir** → **Abrir** (una sola vez). Si no
  aparece la opción, ve a **Ajustes del Sistema → Privacidad y seguridad** y pulsa
  **«Abrir de todas formas»**. (El mensaje "Apple no pudo verificar…" es el aviso de
  notarización: solo desaparece notarizando, ver arriba.)
- **Windows:** en el aviso de SmartScreen, **Más información** → **Ejecutar de
  todas formas**.
- **Siempre:** verifica el hash de tu descarga contra `SHA256SUMS.txt` antes de
  ejecutar. En Linux/macOS: `shasum -a 256 -c SHA256SUMS.txt`.

> RAMI-Chain es una **testnet experimental sin valor monetario**. Verifica
> siempre lo que ejecutas.
