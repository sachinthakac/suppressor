# Registers the Firefox helper that lets the extension start, stop and restart the server.
# Per user, no admin rights. Run again after moving the folder. setup.ps1 runs this for you.
param([string]$VenvPath = "")

$ErrorActionPreference = "Stop"
$Here = $PSScriptRoot
$ServerDir = Split-Path $Here -Parent
if (-not $VenvPath) { $VenvPath = Join-Path $ServerDir ".venv" }
$py = Join-Path (Resolve-Path $VenvPath) "Scripts\python.exe"
if (-not (Test-Path $py)) { throw "No venv python at $py. Run setup.ps1 first." }

$name = "suppressor"
$launcher = Join-Path $Here "suppressor-host.bat"
$manifest = Join-Path $Here "$name.json"
$hostPy = Join-Path $Here "native_host.py"

# Firefox on Windows can only launch .exe or .bat hosts.
Set-Content -Path $launcher -Encoding ascii -Value "@echo off`r`n`"$py`" -I `"$hostPy`" %*"

$json = [ordered]@{
    name               = $name
    description        = "Starts, stops and restarts the Suppressor classifier server"
    path               = $launcher
    type               = "stdio"
    allowed_extensions = @("suppressor@local")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $json, (New-Object Text.UTF8Encoding $false))

$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$name"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host "Registered the Firefox helper ($manifest). Reload the extension's settings page to use it."
