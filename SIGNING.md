# Firma y notarización de las descargas

> **REGLA DE PUBLICACIÓN:** las builds **sin firmar no son para público
> general**. Hasta que existan los certificados, la web las presenta como
> *builds de prueba para usuarios avanzados* (que verifican SHA-256), y a los
> usuarios no técnicos se les pide **esperar a la versión firmada**. Nunca se
> instruye a un usuario inexperto a saltarse un aviso de seguridad.

Para que **macOS** y **Windows** verifiquen la app y la dejen abrir **sin avisos
de seguridad** (el filtro de malware de Apple —notarización— y la reputación de
SmartScreen), los ejecutables deben ir **firmados con un certificado** emitido a
tu nombre. Eso es un requisito de Apple y de Microsoft: **no se puede simular ni
desactivar** desde el código, y esos certificados son **tuyos** (van ligados a
tu identidad y tienen coste).

El CI ya trae **toda la maquinaria montada**: en cuanto añadas los certificados
como *secrets* del repositorio, cada release sale **firmada (y notarizada en
macOS)** de forma automática — y en ese momento las descargas pasan a ser aptas
para cualquier usuario. Si no hay certificados, las descargas se publican **sin
firmar** y solo deben usarlas usuarios avanzados que verifiquen `SHA256SUMS.txt`.

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

## Mientras no haya certificados (SOLO usuarios avanzados)

Si no eres un usuario técnico: **espera a la versión firmada.** Si lo eres y
decides usar una build de prueba, el orden importa:

1. **Verifica SIEMPRE primero** el hash de tu descarga contra `SHA256SUMS.txt`:
   `shasum -a 256 -c SHA256SUMS.txt` (macOS/Linux) o
   `certutil -hashfile <archivo> SHA256` (Windows). Si no coincide, bórrala.
2. Abre de forma consciente, con el método soportado por cada sistema —
   macOS: clic derecho → **Abrir** (o **Ajustes → Privacidad y seguridad →
   «Abrir de todas formas»**); Windows: **Más información → Ejecutar de todas
   formas** — sabiendo que la verificación que haría la plataforma la asumes tú.

> RAMI-Chain es una **testnet experimental sin valor monetario**. Verifica
> siempre lo que ejecutas.
