#!/usr/bin/env bash
# Registers the Firefox helper that lets the extension start, stop and restart the server.
# Per user. Run again after moving the folder. setup.sh runs this for you.
#   usage: install-native-host.sh [--venv PATH] [--uninstall]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$HERE")"
VENV="$SERVER_DIR/.venv"
UNINSTALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --venv) VENV="${2:?--venv needs a path}"; shift 2 ;;
        --uninstall) UNINSTALL=1; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

case "$(uname -s)" in
    Darwin) DEST="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
    Linux)  DEST="$HOME/.mozilla/native-messaging-hosts" ;;
    *) echo "Unsupported OS; on Windows use install-native-host.ps1" >&2; exit 1 ;;
esac
NAME="suppressor"
LAUNCHER="$HERE/suppressor-host.sh"

if [ "$UNINSTALL" = 1 ]; then
    rm -f "$DEST/$NAME.json" "$LAUNCHER"
    echo "Removed the Firefox helper registration."
    exit 0
fi

PY="$(cd "$VENV" && pwd)/bin/python"
[ -x "$PY" ] || { echo "No venv python at $PY. Run setup.sh first." >&2; exit 1; }

cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$PY" -I "$HERE/native_host.py" "\$@"
EOF
chmod +x "$LAUNCHER"

mkdir -p "$DEST"
cat > "$DEST/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Starts, stops and restarts the Suppressor classifier server",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["suppressor@local"]
}
EOF
echo "Registered the Firefox helper ($DEST/$NAME.json). Reload the extension's settings page to use it."
