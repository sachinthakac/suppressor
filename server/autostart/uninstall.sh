#!/usr/bin/env bash
# Stops the Suppressor server and removes it from login startup (macOS / Linux).
#   server/autostart/uninstall.sh
set -euo pipefail

LABEL="com.suppressor.server"
UNIT="suppressor.service"

case "$(uname -s)" in
    Darwin)
        DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
        launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$DEST" 2>/dev/null || true
        if [ -f "$DEST" ]; then rm -f "$DEST"; echo "Removed LaunchAgent '$LABEL'."
        else echo "LaunchAgent '$LABEL' is not installed."; fi
        ;;
    Linux)
        DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
        if [ -f "$DEST" ]; then
            systemctl --user disable --now "$UNIT" 2>/dev/null || true
            rm -f "$DEST"
            systemctl --user daemon-reload 2>/dev/null || true
            echo "Removed systemd user unit '$UNIT'."
        else
            echo "systemd user unit '$UNIT' is not installed."
        fi
        ;;
    *)
        echo "On Windows use server/autostart/uninstall-autostart.ps1." >&2
        exit 1
        ;;
esac
