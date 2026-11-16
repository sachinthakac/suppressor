# Starts the local Laya classifier on http://127.0.0.1:8765
$env:USE_TF = "0"
$env:HF_HUB_OFFLINE = if ($env:HF_HUB_OFFLINE) { $env:HF_HUB_OFFLINE } else { "1" }  # model is cached after first run; set to 0 to download
Set-Location $PSScriptRoot
python -I server.py
