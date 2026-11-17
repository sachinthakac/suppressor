#!/usr/bin/env bash
# One-command install of the Suppressor server (macOS and Linux).
#
# Creates a Python venv, installs PyTorch (CUDA if an NVIDIA GPU is found, the default
# wheel with Apple MPS on macOS, otherwise CPU), installs the pinned server dependencies,
# downloads the Laya model, runs a smoke test and optionally sets up auto-start at login.
# Safe to rerun: it updates what is there.
#
#   ./setup.sh                              # interactive
#   ./setup.sh --dry-run                    # show every decision, change nothing
#   ./setup.sh --device cpu --no-autostart  # non-interactive
#
# Options:
#   --device auto|cuda|cpu   PyTorch build (default auto)
#   --venv PATH              venv location (default server/.venv)
#   --autostart              install auto-start without asking
#   --no-autostart           don't install auto-start and don't ask
#   --dry-run                print decisions without installing anything
#
# On Windows use setup.ps1 instead.
set -euo pipefail

# ---- constants ---------------------------------------------------------------
MIN_PY_MAJOR=3; MIN_PY_MINOR=12     # the pinned deps (numpy 2.5, fastapi 0.163, ...) need 3.12+
TORCH_VERSION="2.14.1"              # known-good; falls back to the newest on the index if missing
MODEL="convaiinnovations/laya"
# The model commit to download and load lives in server/model_revision.txt (laya 0.4.35's
# pinned revision), so the server reads the same value. Read below, once ROOT is known.
# Only the English model's files (~850 MB). The full repo (2.4 GB) also holds
# multilingual/ and typed-decisions/ variants that the server doesn't use.
MODEL_FILES="model.safetensors rl_agent_config.json encoder/config.json tokenizer/tokenizer.json tokenizer/tokenizer_config.json"
MODEL_PATTERNS="model.safetensors,rl_agent_config.json,encoder/*,tokenizer/*"
# CUDA wheel indexes, newest first, with the minimum driver CUDA version (x100) each needs.
CUDA_BUILDS="cu130:1300 cu128:1208 cu126:1206"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
REQUIREMENTS="$SERVER_DIR/requirements.txt"
MODEL_REVISION="$(tr -d ' \r\n' < "$SERVER_DIR/model_revision.txt")"
[ -n "$MODEL_REVISION" ] || { echo "ERROR: $SERVER_DIR/model_revision.txt is empty" >&2; exit 1; }

DEVICE="auto"; VENV=""; AUTOSTART=""; DRY_RUN=0

say()  { printf '\033[36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    WARNING: %s\033[0m\n' "$*"; }
plan() { printf '\033[33m    [dry-run] would %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --device) DEVICE="${2:?--device needs auto, cuda or cpu}"; shift 2 ;;
        --device=*) DEVICE="${1#--device=}"; shift ;;
        --venv) VENV="${2:?--venv needs a path}"; shift 2 ;;
        --venv=*) VENV="${1#--venv=}"; shift ;;
        --autostart) [ "$AUTOSTART" = no ] && fail "Use either --autostart or --no-autostart, not both."; AUTOSTART=yes; shift ;;
        --no-autostart) [ "$AUTOSTART" = yes ] && fail "Use either --autostart or --no-autostart, not both."; AUTOSTART=no; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
        *) fail "Unknown option: $1 (see --help)" ;;
    esac
done
case "$DEVICE" in auto|cuda|cpu) ;; *) fail "--device must be auto, cuda or cpu (got '$DEVICE')." ;; esac

OS="$(uname -s)"
case "$OS" in
    Darwin|Linux) ;;
    MINGW*|MSYS*|CYGWIN*)
        echo "This is Windows. Use setup.ps1 instead, from PowerShell:"
        echo "    powershell -ExecutionPolicy Bypass -File setup.ps1"
        exit 1 ;;
    *) fail "Unsupported system '$OS'. This script supports macOS and Linux (Windows: setup.ps1)." ;;
esac

if [ -z "$VENV" ]; then VENV="$SERVER_DIR/.venv"
else case "$VENV" in /*) ;; *) VENV="$PWD/$VENV" ;; esac
fi
VENV_PY="$VENV/bin/python"

[ "$DRY_RUN" = 1 ] && printf '\033[33mDRY RUN: nothing will be installed or changed.\033[0m\n'

# ---- 1. Python -----------------------------------------------------------------
say "Looking for Python $MIN_PY_MAJOR.$MIN_PY_MINOR+"
PROBE='import sys;print(sys.executable);print(sys.version_info[0]*100+sys.version_info[1])'
MIN_NUM=$((MIN_PY_MAJOR * 100 + MIN_PY_MINOR))
BASE_PY=""
for cand in python3.14 python3.13 python3.12 python3 python; do
    command -v "$cand" >/dev/null 2>&1 || continue
    out="$("$cand" -c "$PROBE" 2>/dev/null)" || continue
    exe="$(printf '%s\n' "$out" | sed -n 1p)"; num="$(printf '%s\n' "$out" | sed -n 2p)"
    ver="$((num / 100)).$((num % 100))"
    if [ "$num" -ge "$MIN_NUM" ]; then BASE_PY="$exe"; info "Using Python $ver at $exe"; break; fi
    info "Skipping Python $ver at $exe (too old)"
done
if [ -z "$BASE_PY" ]; then
    if [ "$OS" = Darwin ]; then hint="brew install python@3.13   (or https://www.python.org/downloads/macos/)"
    elif command -v apt-get >/dev/null 2>&1; then hint="sudo apt install python3 python3-venv   (Ubuntu 24.04+ / Debian 13+ ship 3.12+)"
    elif command -v dnf >/dev/null 2>&1; then hint="sudo dnf install python3"
    elif command -v pacman >/dev/null 2>&1; then hint="sudo pacman -S python"
    else hint="see https://www.python.org/downloads/"; fi
    fail "Python $MIN_PY_MAJOR.$MIN_PY_MINOR or newer was not found.
  Install it with:  $hint
  then rerun this script."
fi

# ---- 2. venv -------------------------------------------------------------------
say "Virtual environment: $VENV"
if [ -x "$VENV_PY" ]; then
    out="$("$VENV_PY" -c "$PROBE" 2>/dev/null)" || fail "The existing venv at $VENV is broken. Delete that folder and rerun."
    [ "$(printf '%s\n' "$out" | sed -n 2p)" -ge "$MIN_NUM" ] || fail "The existing venv at $VENV uses an older Python. Delete that folder and rerun."
    info "Exists; reusing it (packages will be updated)."
elif [ "$DRY_RUN" = 1 ]; then
    plan "create it with: $BASE_PY -m venv $VENV"
else
    if ! "$BASE_PY" -m venv "$VENV"; then
        fail "Creating the venv failed. On Debian/Ubuntu install the venv module: sudo apt install python3-venv"
    fi
    info "Created."
fi
if [ "$DRY_RUN" = 0 ]; then
    "$VENV_PY" -m pip install --quiet --disable-pip-version-check --upgrade pip || fail "Upgrading pip failed."
fi

# ---- 3. PyTorch build ----------------------------------------------------------
say "Choosing a PyTorch build (--device $DEVICE)"
TORCH_TAG="cpu"; TORCH_INDEX="https://download.pytorch.org/whl/cpu"
if [ "$OS" = Darwin ]; then
    if [ "$(uname -m)" != arm64 ]; then
        if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
            fail "This shell runs under Rosetta (x86_64). Use a native arm64 Terminal and arm64 Python."
        fi
        fail "PyTorch no longer ships wheels for Intel Macs, so the server can't be installed here."
    fi
    [ "$DEVICE" = cuda ] && fail "--device cuda isn't possible on macOS (no NVIDIA/CUDA)."
    TORCH_TAG=""; TORCH_INDEX="https://pypi.org/simple"
    info "macOS on Apple Silicon: default PyPI wheel (uses the GPU via Apple MPS)."
    [ "$DEVICE" = cpu ] && info "(--device cpu: the macOS wheel is the same; set SUPPRESSOR_DEVICE=cpu to keep the server off MPS.)"
else
    DRIVER_CUDA=""   # x100, e.g. 1303 for 13.3
    if command -v nvidia-smi >/dev/null 2>&1; then
        header="$(nvidia-smi 2>/dev/null || true)"
        cv="$(printf '%s\n' "$header" | sed -n 's/.*CUDA[^:]*Version[[:space:]]*:[[:space:]]*\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p' | head -n 1)"
        if [ -n "$cv" ]; then
            cmaj="${cv% *}"; cmin="${cv#* }"
            DRIVER_CUDA=$((cmaj * 100 + cmin))
            gpu="$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -n 1 || true)"
            [ -n "$gpu" ] && info "NVIDIA GPU: $gpu"
            info "Driver supports CUDA up to $cmaj.$cmin (from the nvidia-smi header)"
        else
            info "nvidia-smi is present but reported no GPU / CUDA version"
        fi
    else
        info "nvidia-smi not found (no NVIDIA GPU or driver)"
    fi
    if [ "$DEVICE" != cpu ] && [ -n "$DRIVER_CUDA" ]; then
        for b in $CUDA_BUILDS; do
            if [ "$DRIVER_CUDA" -ge "${b#*:}" ]; then TORCH_TAG="${b%%:*}"; break; fi
        done
        if [ "$TORCH_TAG" = cpu ]; then
            msg="The driver's CUDA version is older than 12.6, the oldest build offered. Update the NVIDIA driver for GPU speed."
            [ "$DEVICE" = cuda ] && fail "$msg"
            warn "$msg Using CPU."
        fi
    elif [ "$DEVICE" = cuda ]; then
        fail "--device cuda was requested but no NVIDIA driver was detected (nvidia-smi missing or failing)."
    fi
    TORCH_INDEX="https://download.pytorch.org/whl/$TORCH_TAG"
fi
info "Decision: torch $TORCH_VERSION${TORCH_TAG:++$TORCH_TAG} from $TORCH_INDEX"
[ "$TORCH_TAG" = cpu ] && info "(CPU works but is slow: about 0.5 s per title. A CUDA GPU makes it ~20x faster.)"

# ---- 4. install torch ----------------------------------------------------------
say "Installing PyTorch"
installed=""
[ -x "$VENV_PY" ] && installed="$("$VENV_PY" -c 'import torch;print(torch.__version__)' 2>/dev/null || true)"
info "Installed now: torch ${installed:-none}"
have_ver="${installed%%+*}"
have_tag=""; case "$installed" in *+*) have_tag="${installed#*+}" ;; esac
if [ -n "$installed" ] && [ "$have_tag" = "$TORCH_TAG" ] && [ "$have_ver" = "$TORCH_VERSION" ]; then
    info "Already the right build; skipping."
elif [ "$DRY_RUN" = 1 ]; then
    [ -n "$installed" ] && [ "$have_tag" != "$TORCH_TAG" ] && plan "uninstall torch $installed (wrong build)"
    plan "pip install torch==$TORCH_VERSION --index-url $TORCH_INDEX  (falls back to the newest torch on that index)"
else
    if [ -n "$installed" ] && [ "$have_tag" != "$TORCH_TAG" ]; then
        info "Replacing the ${have_tag:-default} build with ${TORCH_TAG:-the default build}"
        "$VENV_PY" -m pip uninstall --yes torch || fail "Uninstalling the old torch failed."
    fi
    if ! "$VENV_PY" -m pip install --disable-pip-version-check "torch==$TORCH_VERSION" --index-url "$TORCH_INDEX"; then
        warn "torch $TORCH_VERSION is not on $TORCH_INDEX; installing the newest available there."
        "$VENV_PY" -m pip install --disable-pip-version-check --upgrade torch --index-url "$TORCH_INDEX" || fail "Installing torch failed."
    fi
fi

# ---- 5. server dependencies ----------------------------------------------------
say "Installing pinned server dependencies ($REQUIREMENTS)"
if [ "$DRY_RUN" = 1 ]; then plan "pip install -r $REQUIREMENTS"
else "$VENV_PY" -m pip install --disable-pip-version-check -r "$REQUIREMENTS" || fail "Installing requirements failed."
fi

# ---- 6. model ------------------------------------------------------------------
say "Model $MODEL"
if [ -n "${HF_HUB_CACHE:-}" ]; then HUB="$HF_HUB_CACHE"
elif [ -n "${HF_HOME:-}" ]; then HUB="$HF_HOME/hub"
else HUB="${XDG_CACHE_HOME:-$HOME/.cache}/huggingface/hub"; fi
SNAP="$HUB/models--${MODEL//\//--}/snapshots/$MODEL_REVISION"
missing=""
for f in $MODEL_FILES; do [ -f "$SNAP/$f" ] || missing="$missing $f"; done
if [ -z "$missing" ]; then
    info "Already cached in $SNAP; skipping download."
elif [ "$DRY_RUN" = 1 ]; then
    plan "download ~850 MB into $HUB (missing:$missing)"
else
    echo
    printf '\033[33m    Downloading the Laya model (~850 MB) into %s\n    This happens once and can take several minutes.\033[0m\n' "$HUB"
    SUP_MODEL="$MODEL" SUP_REV="$MODEL_REVISION" SUP_PATTERNS="$MODEL_PATTERNS" HF_HUB_OFFLINE=0 \
        "$VENV_PY" -I - <<'PY' || fail "Downloading the model failed."
import os
from huggingface_hub import snapshot_download
path = snapshot_download(os.environ['SUP_MODEL'], revision=os.environ['SUP_REV'],
                         allow_patterns=os.environ['SUP_PATTERNS'].split(','))
print('    saved to', path)
PY
fi

# ---- 7. smoke test -------------------------------------------------------------
say "Smoke test (load Laya, classify one title)"
if [ "$DRY_RUN" = 1 ]; then
    case "$TORCH_TAG" in cu*) expect=cuda ;; "") expect=mps ;; *) expect=cpu ;; esac
    plan "run a one-shot laya.load + predict with $VENV_PY (expects device $expect)"
else
    # LAYA_REVISION: offline, laya can only find the cached copy by the commit we downloaded.
    SUP_MODEL="$MODEL" LAYA_REVISION="$MODEL_REVISION" HF_HUB_OFFLINE=1 USE_TF=0 "$VENV_PY" -I - <<'PY' || fail "Smoke test failed."
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
PY
fi

# ---- 8. auto-start -------------------------------------------------------------
say "Auto-start at login"
AUTO_SCRIPT="$SERVER_DIR/autostart/install.sh"
do_auto=0
if [ "$AUTOSTART" = yes ]; then do_auto=1; info "--autostart given."
elif [ "$AUTOSTART" = no ]; then info "--no-autostart given; skipping."
elif [ "$DRY_RUN" = 1 ]; then info "Would ask whether to install it (pass --autostart / --no-autostart to decide up front)."
elif [ -t 0 ]; then
    if [ "$OS" = Darwin ]; then what="a launchd LaunchAgent"; else what="a systemd user service"; fi
    read -r -p "    Start the server automatically when you log in ($what)? [y/N] " ans || ans=""
    case "$ans" in [yY]|[yY][eE][sS]) do_auto=1 ;; esac
else info "Not interactive; skipping (pass --autostart to install it)."
fi
if [ "$do_auto" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then bash "$AUTO_SCRIPT" --venv "$VENV" --dry-run
    else bash "$AUTO_SCRIPT" --venv "$VENV" || fail "Installing auto-start failed."
    fi
fi

# ---- 9. Firefox helper ---------------------------------------------------------
say "Firefox helper (start/stop/restart from the extension's settings)"
NATIVE_SCRIPT="$SERVER_DIR/native/install-native-host.sh"
if [ "$DRY_RUN" = 1 ]; then plan "run $NATIVE_SCRIPT --venv $VENV"
else bash "$NATIVE_SCRIPT" --venv "$VENV" || warn "Could not register the Firefox helper."
fi

# ---- done ----------------------------------------------------------------------
echo
if [ "$DRY_RUN" = 1 ]; then printf '\033[32mDry run finished. Rerun without --dry-run to install.\033[0m\n'; exit 0; fi
printf '\033[32mSuppressor server is installed.\033[0m\n\n'
echo "Next steps:"
if [ "$do_auto" = 1 ]; then
    echo "  1. The server is starting in the background (check: curl http://127.0.0.1:8765/health)."
else
    echo "  1. Start the server:  cd \"$SERVER_DIR\" && \"$VENV_PY\" -I server.py"
    echo "     (or later: bash \"$AUTO_SCRIPT\" --venv \"$VENV\" to start it at login)"
fi
echo "  2. Install the extension in Firefox: about:addons -> gear icon -> Install Add-on From File..."
echo "     and pick the Suppressor .xpi. (For development: about:debugging -> This Firefox ->"
echo "     Load Temporary Add-on -> extension/manifest.json.)"
echo "  3. Open YouTube in Firefox; the popup shows whether the server is connected."
[ "$do_auto" = 1 ] && echo "  To remove auto-start: bash \"$SERVER_DIR/autostart/uninstall.sh\""
exit 0
