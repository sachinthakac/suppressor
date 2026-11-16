# Starts the local Laya classifier on http://127.0.0.1:8765
# Uses server/.venv (CUDA PyTorch) when present, otherwise the global python.
$env:USE_TF = "0"
if (-not $env:HF_HUB_OFFLINE) { $env:HF_HUB_OFFLINE = "1" }  # model is cached after first run; set to 0 to download
Set-Location $PSScriptRoot
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
& $py -I server.py
