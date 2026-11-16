# Registers a scheduled task that starts the Suppressor server hidden (no console
# window) when you log in, and restarts it if it crashes. No admin rights needed.
#
#   ./server/install-autostart.ps1          # install and start now
#   ./server/uninstall-autostart.ps1        # remove
#
# Logs: server/server.log

$ErrorActionPreference = "Stop"
$TaskName = "Suppressor server"
$here = $PSScriptRoot

$pythonw = Join-Path $here ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $pythonw)) {
    $py = (Get-Command pythonw.exe -ErrorAction SilentlyContinue)
    if (-not $py) { throw "pythonw.exe not found. Create server/.venv first (see README)." }
    $pythonw = $py.Source
    Write-Warning "server/.venv not found; using $pythonw (probably CPU-only PyTorch)."
}

$action = New-ScheduledTaskAction -Execute $pythonw -Argument "-I server.py" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "Local Laya classifier for the Suppressor Firefox extension (127.0.0.1:8765)" -Force | Out-Null

if (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue) {
    Write-Warning "Something is already listening on port 8765 (a server from start.ps1?). Close it, then run: Start-ScheduledTask '$TaskName'"
} else {
    Start-ScheduledTask -TaskName $TaskName
}
Write-Host "Installed '$TaskName'. It starts at logon and is starting now."
Write-Host "Check: Invoke-RestMethod http://127.0.0.1:8765/health   (ready after ~10 s)"
Write-Host "Logs:  $here\server.log"
