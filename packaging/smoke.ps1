# Prueba de humo del monedero en Windows (CI): arranca el .exe empaquetado,
# el panel debe responder en < 20 s y «Salir» debe cerrar el proceso en < 5 s.
param([Parameter(Mandatory=$true)][string]$Exe)
$ErrorActionPreference = "Stop"
$port = 8655
$tmp = Join-Path $env:TEMP ("rami-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:USERPROFILE = Join-Path $tmp "home"; New-Item -ItemType Directory -Path $env:USERPROFILE | Out-Null
$args = @("--no-open","--network","regtest","--port","$port","--listen","30355","--chain",(Join-Path $tmp "chain"),"--keystore",(Join-Path $tmp "ks"),"--no-portmap","--no-lan","--no-seeds")
$p = Start-Process -FilePath $Exe -ArgumentList $args -PassThru
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/status" -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ok) { Get-Content (Join-Path $env:USERPROFILE ".rami\gui-launch.log") -ErrorAction SilentlyContinue; throw "SMOKE FALLÓ: el panel no respondió en 20 s" }
Write-Host "✓ panel responde"
Invoke-WebRequest -UseBasicParsing -Method Post -ContentType "application/json" -Body "{}" "http://127.0.0.1:$port/api/quit" | Out-Null
$gone = $false
for ($i = 0; $i -lt 10; $i++) { if ($p.HasExited) { $gone = $true; break }; Start-Sleep -Milliseconds 500 }
if (-not $gone) { Stop-Process -Id $p.Id -Force; throw "SMOKE FALLÓ: el proceso sigue vivo 5 s después de «Salir»" }
Write-Host "✓ «Salir» cierra el proceso"
Write-Host "✓ prueba de humo (windows) superada"
