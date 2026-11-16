# Stops the Suppressor server task and removes it from startup.
#   ./server/autostart/uninstall-autostart.ps1
$TaskName = "Suppressor server"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed '$TaskName'."
} else {
    Write-Host "'$TaskName' is not installed."
}
