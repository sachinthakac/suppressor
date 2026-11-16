<#
.SYNOPSIS
    One-command install of the Suppressor server (Windows).

.DESCRIPTION
    Creates a Python venv, installs PyTorch (CUDA if an NVIDIA GPU is found, otherwise CPU),
    installs the pinned server dependencies, downloads the Laya model, runs a smoke test and
    optionally registers auto-start at logon. Safe to rerun: it updates what is there.

    powershell -ExecutionPolicy Bypass -File setup.ps1
    powershell -ExecutionPolicy Bypass -File setup.ps1 -DryRun               # show decisions only
    powershell -ExecutionPolicy Bypass -File setup.ps1 -Device cpu -NoAutostart

.PARAMETER Device
    auto (default): CUDA build if nvidia-smi finds a GPU, else CPU. cuda / cpu force one.
.PARAMETER VenvPath
    Where to create the venv. Default: server\.venv
.PARAMETER Autostart
    Install auto-start without asking.
.PARAMETER NoAutostart
    Don't install auto-start and don't ask.
.PARAMETER DryRun
    Print every decision without installing or changing anything.
#>
[CmdletBinding()]
param(
    [ValidateSet("auto", "cuda", "cpu")]
    [string]$Device = "auto",
    [string]$VenvPath = "",
    [switch]$Autostart,
    [switch]$NoAutostart,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ---- constants ---------------------------------------------------------------
$MinPython = @(3, 12)          # the pinned deps (numpy 2.5, fastapi 0.163, ...) need 3.12+
$TorchVersion = "2.14.1"       # known-good; falls back to the newest on the index if missing
$Model = "convaiinnovations/laya"
$ModelRevision = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851"   # laya 0.4.35's pinned revision
# Only the English model's files (~850 MB). The full repo (2.4 GB) also holds
# multilingual/ and typed-decisions/ variants that the server doesn't use.
$ModelFiles = @("model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json")
$ModelPatterns = "model.safetensors,rl_agent_config.json,encoder/*,tokenizer/*"
# CUDA wheel indexes, newest first, with the minimum driver CUDA version each needs.
$CudaBuilds = @(
    @{ Tag = "cu130"; Min = [version]"13.0" },
    @{ Tag = "cu128"; Min = [version]"12.8" },
    @{ Tag = "cu126"; Min = [version]"12.6" }
)

$Root = $PSScriptRoot
$ServerDir = Join-Path $Root "server"
$Requirements = Join-Path $ServerDir "requirements.txt"
if (-not $VenvPath) { $VenvPath = Join-Path $ServerDir ".venv" }
elseif (-not [IO.Path]::IsPathRooted($VenvPath)) { $VenvPath = Join-Path (Get-Location).Path $VenvPath }
$VenvPath = [IO.Path]::GetFullPath($VenvPath)
$VenvPy = Join-Path $VenvPath "Scripts\python.exe"

function Say([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Info([string]$msg) { Write-Host "    $msg" }
function Warn([string]$msg) { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }
function Plan([string]$msg) { Write-Host "    [dry-run] would $msg" -ForegroundColor DarkYellow }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Runs a native command, hiding stderr, and returns stdout lines (or $null on failure).
# Windows PowerShell 5.1 turns redirected stderr into errors, so relax the preference here.
function Invoke-Probe([string]$exe, [string[]]$argv) {
    $ErrorActionPreference = "Continue"
    try {
        $out = & $exe @argv 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return $out
    } catch { return $null }
}

# Runs a native command with visible output and stops the script if it fails.
function Invoke-Checked([string]$what, [string]$exe, [string[]]$argv) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)." }
}

# Runs a python snippet (fed on stdin, so no quoting trouble) with extra env vars.
function Invoke-PySnippet([string]$what, [string]$py, [string]$code, [hashtable]$envVars) {
    $saved = @{}
    foreach ($k in $envVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envVars[$k]) }
    try {
        $code | & $py -I -
        $code_ = $LASTEXITCODE
    } finally {
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
    if ($code_ -ne 0) { Fail "$what failed (exit $code_)." }
}

function Get-HubCache {
    if ($env:HF_HUB_CACHE) { return $env:HF_HUB_CACHE }
    if ($env:HF_HOME) { return (Join-Path $env:HF_HOME "hub") }
    return (Join-Path $env:USERPROFILE ".cache\huggingface\hub")
}

if ($Autostart -and $NoAutostart) { Fail "Use either -Autostart or -NoAutostart, not both." }
if ($DryRun) { Write-Host "DRY RUN: nothing will be installed or changed." -ForegroundColor DarkYellow }

# ---- 1. Python -----------------------------------------------------------------
Say "Looking for Python $($MinPython -join '.')+"
$probe = "import sys;print(sys.executable);print(sys.version_info[0]*100+sys.version_info[1])"
$minNum = $MinPython[0] * 100 + $MinPython[1]
$candidates = @(
    @{ Exe = "py"; Args = @("-3") },
    @{ Exe = "python"; Args = @() },
    @{ Exe = "python3"; Args = @() }
)
$BasePy = $null
foreach ($c in $candidates) {
    if (-not (Get-Command $c.Exe -ErrorAction SilentlyContinue)) { continue }
    $out = Invoke-Probe $c.Exe ($c.Args + @("-c", $probe))
    if (-not $out -or @($out).Count -lt 2) { continue }   # e.g. the Microsoft Store "python" stub
    $exe = @($out)[0].Trim(); $num = [int]@($out)[1].Trim()
    $ver = "{0}.{1}" -f [math]::Floor($num / 100), ($num % 100)
    if ($num -ge $minNum) { $BasePy = $exe; Info "Using Python $ver at $exe"; break }
    Info "Skipping Python $ver at $exe (too old)"
}
if (-not $BasePy) {
    Fail ("Python $($MinPython -join '.') or newer was not found.`n" +
        "  Install it with:  winget install Python.Python.3.13`n" +
        "  or from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then rerun this script.")
}

# ---- 2. venv -------------------------------------------------------------------
Say "Virtual environment: $VenvPath"
$venvOk = $false
if (Test-Path $VenvPy) {
    $out = Invoke-Probe $VenvPy @("-c", $probe)
    if ($out -and [int]@($out)[1].Trim() -ge $minNum) { $venvOk = $true }
    elseif ($out) { Fail "The existing venv at $VenvPath uses an older Python. Delete that folder and rerun." }
    else { Fail "The existing venv at $VenvPath is broken (its python.exe doesn't run). Delete that folder and rerun." }
}
if ($venvOk) { Info "Exists; reusing it (packages will be updated)." }
elseif ($DryRun) { Plan "create it with: `"$BasePy`" -m venv `"$VenvPath`"" }
else {
    Invoke-Checked "Creating the venv" $BasePy @("-m", "venv", $VenvPath)
    Info "Created."
}
if (-not $DryRun) {
    Invoke-Checked "Upgrading pip" $VenvPy @("-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--upgrade", "pip")
}

# ---- 3. PyTorch build ----------------------------------------------------------
Say "Choosing a PyTorch build (-Device $Device)"
$driverCuda = $null
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
    $header = Invoke-Probe $smi.Source @()
    if ($header) {
        $m = [regex]::Match(($header -join "`n"), "CUDA[^:\r\n]*Version\s*:\s*(\d+)\.(\d+)")
        if ($m.Success) { $driverCuda = [version]("{0}.{1}" -f $m.Groups[1].Value, $m.Groups[2].Value) }
        $gpu = Invoke-Probe $smi.Source @("--query-gpu=name,driver_version", "--format=csv,noheader")
        if ($gpu) { Info "NVIDIA GPU: $(@($gpu)[0])" }
    }
}
if ($driverCuda) { Info "Driver supports CUDA up to $driverCuda (from the nvidia-smi header)" }
elseif ($smi) { Info "nvidia-smi is present but reported no GPU / CUDA version" }
else { Info "nvidia-smi not found (no NVIDIA GPU or driver)" }

$torchTag = "cpu"
if ($Device -ne "cpu" -and $driverCuda) {
    $pick = $CudaBuilds | Where-Object { $driverCuda -ge $_.Min } | Select-Object -First 1
    if ($pick) { $torchTag = $pick.Tag }
    else {
        $msg = "Driver CUDA $driverCuda is older than 12.6, the oldest build offered. Update the NVIDIA driver for GPU speed."
        if ($Device -eq "cuda") { Fail $msg }
        Warn "$msg Using CPU."
    }
} elseif ($Device -eq "cuda") {
    Fail "-Device cuda was requested but no NVIDIA driver was detected (nvidia-smi missing or failing)."
}
$torchIndex = "https://download.pytorch.org/whl/$torchTag"
Info "Decision: torch $TorchVersion+$torchTag from $torchIndex"
if ($torchTag -eq "cpu") { Info "(CPU works but is slow: about 0.5 s per title. A CUDA GPU makes it ~20x faster.)" }

# ---- 4. install torch ----------------------------------------------------------
Say "Installing PyTorch"
$installed = $null
if (Test-Path $VenvPy) { $installed = Invoke-Probe $VenvPy @("-c", "import torch;print(torch.__version__)") }
if ($installed) { $installed = @($installed)[0].Trim(); Info "Installed now: torch $installed" } else { Info "Installed now: none" }
$haveTag = if ($installed -and $installed.Contains("+")) { $installed.Split("+")[1] } else { "" }
$haveVer = if ($installed) { $installed.Split("+")[0] } else { "" }
if ($installed -and $haveTag -eq $torchTag -and $haveVer -eq $TorchVersion) {
    Info "Already the right build; skipping."
} elseif ($DryRun) {
    if ($installed -and $haveTag -ne $torchTag) { Plan "uninstall torch $installed (wrong build)" }
    Plan "pip install torch==$TorchVersion --index-url $torchIndex  (falls back to the newest torch on that index)"
} else {
    if ($installed -and $haveTag -ne $torchTag) {
        Info "Replacing the $(if ($haveTag) { $haveTag } else { 'default' }) build with $torchTag"
        Invoke-Checked "Uninstalling the old torch" $VenvPy @("-m", "pip", "uninstall", "--yes", "torch")
    }
    & $VenvPy -m pip install --disable-pip-version-check "torch==$TorchVersion" --index-url $torchIndex
    if ($LASTEXITCODE -ne 0) {
        Warn "torch $TorchVersion is not on $torchIndex; installing the newest available there."
        Invoke-Checked "Installing torch" $VenvPy @("-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "torch", "--index-url", $torchIndex)
    }
}

# ---- 5. server dependencies ----------------------------------------------------
Say "Installing pinned server dependencies ($Requirements)"
if ($DryRun) { Plan "pip install -r `"$Requirements`"" }
else { Invoke-Checked "Installing requirements" $VenvPy @("-m", "pip", "install", "--disable-pip-version-check", "-r", $Requirements) }

# ---- 6. model ------------------------------------------------------------------
Say "Model $Model"
$hub = Get-HubCache
$snap = Join-Path $hub ("models--" + $Model.Replace("/", "--") + "\snapshots\" + $ModelRevision)
$missing = @($ModelFiles | Where-Object { -not (Test-Path (Join-Path $snap $_)) })
if ($missing.Count -eq 0) {
    Info "Already cached in $snap; skipping download."
} elseif ($DryRun) {
    Plan "download ~850 MB into $hub (missing: $($missing -join ', '))"
} else {
    Write-Host ""
    Write-Host "    Downloading the Laya model (~850 MB) into $hub" -ForegroundColor Yellow
    Write-Host "    This happens once and can take several minutes." -ForegroundColor Yellow
    $code = @'
import os
from huggingface_hub import snapshot_download
path = snapshot_download(os.environ['SUP_MODEL'], revision=os.environ['SUP_REV'],
                         allow_patterns=os.environ['SUP_PATTERNS'].split(','))
print('    saved to', path)
'@
    Invoke-PySnippet "Downloading the model" $VenvPy $code @{ SUP_MODEL = $Model; SUP_REV = $ModelRevision; SUP_PATTERNS = $ModelPatterns; HF_HUB_OFFLINE = "0" }
}

# ---- 7. smoke test -------------------------------------------------------------
Say "Smoke test (load Laya, classify one title)"
$smoke = @'
import os, time, warnings
warnings.filterwarnings('ignore', category=RuntimeWarning)  # laya's calibration notice
import laya
t = time.perf_counter()
agent = laya.load(os.environ['SUP_MODEL'])
load_s = time.perf_counter() - t
q = {'subject': {'type': 'choice', 'instructions': 'What is this video title about?',
                 'criteria': {'topic': 'GTA VI (GTA 6, Grand Theft Auto VI)',
                              'similar': 'another video game', 'other': 'something that is not a video game'}}}
title = 'GTA 6 trailer breakdown'
agent.predict(title, q)  # warm-up
n = 5
t = time.perf_counter()
for _ in range(n):
    out = agent.predict(title, q)
ms = (time.perf_counter() - t) * 1000 / n
p = float(out['answers']['subject']['probabilities']['topic'])
print('    device: %s' % getattr(agent, 'device', '?'))
print('    loaded in %.1f s, %.0f ms per call, P(topic | %r) = %.2f' % (load_s, ms, title, p))
'@
if ($DryRun) { Plan "run a one-shot laya.load + predict with $VenvPy (expects device $(if ($torchTag -eq 'cpu') { 'cpu' } else { 'cuda' }))" }
else { Invoke-PySnippet "Smoke test" $VenvPy $smoke @{ SUP_MODEL = $Model; HF_HUB_OFFLINE = "1"; USE_TF = "0" } }

# ---- 8. auto-start -------------------------------------------------------------
Say "Auto-start at logon"
$autoScript = Join-Path $ServerDir "autostart\install-autostart.ps1"
$doAuto = $false
if ($Autostart) { $doAuto = $true; Info "-Autostart given." }
elseif ($NoAutostart) { Info "-NoAutostart given; skipping." }
elseif ($DryRun) { Info "Would ask whether to install it (pass -Autostart / -NoAutostart to decide up front)." }
elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    $ans = Read-Host "    Start the server automatically when you log in? [y/N]"
    $doAuto = $ans -match "^(y|yes)$"
} else { Info "Not interactive; skipping (pass -Autostart to install it)." }

if ($doAuto) {
    if ($DryRun) { Plan "run $autoScript -VenvPath `"$VenvPath`" (Task Scheduler task 'Suppressor server')" }
    else { & $autoScript -VenvPath $VenvPath }
}

# ---- done ----------------------------------------------------------------------
Write-Host ""
if ($DryRun) { Write-Host "Dry run finished. Rerun without -DryRun to install." -ForegroundColor Green; exit 0 }
Write-Host "Suppressor server is installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
if ($doAuto) {
    Write-Host "  1. The server is starting in the background (check: Invoke-RestMethod http://127.0.0.1:8765/health)."
} else {
    Write-Host "  1. Start the server:  cd `"$ServerDir`"; & `"$VenvPy`" -I server.py"
    Write-Host "     (or later: powershell -ExecutionPolicy Bypass -File `"$autoScript`" -VenvPath `"$VenvPath`" to start it at logon)"
}
Write-Host "  2. Install the extension in Firefox: about:addons -> gear icon -> Install Add-on From File..."
Write-Host "     and pick the Suppressor .xpi. (For development: about:debugging -> This Firefox ->"
Write-Host "     Load Temporary Add-on -> extension\manifest.json.)"
Write-Host "  3. Open YouTube in Firefox; the popup shows whether the server is connected."
if ($doAuto) { Write-Host "  To remove auto-start: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $ServerDir 'autostart\uninstall-autostart.ps1')`"" }
