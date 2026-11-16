# Removes the Firefox helper registration made by install-native-host.ps1.
$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\suppressor"
if (Test-Path $key) { Remove-Item -Path $key -Force; Write-Host "Removed the Firefox helper registration." }
else { Write-Host "The Firefox helper is not registered." }
foreach ($f in "suppressor-host.bat", "suppressor.json") {
    $p = Join-Path $PSScriptRoot $f
    if (Test-Path $p) { Remove-Item $p -Force }
}
