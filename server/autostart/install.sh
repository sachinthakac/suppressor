#!/usr/bin/env bash
# Starts the Suppressor server automatically when you log in (macOS / Linux).
#   macOS: a launchd LaunchAgent  ~/Library/LaunchAgents/com.suppressor.server.plist
#   Linux: a systemd user unit     ~/.config/systemd/user/suppressor.service
# No root needed. Rerunning updates the installed agent/unit and restarts it.
#
#   server/autostart/install.sh [--venv PATH] [--dry-run]
#   server/autostart/uninstall.sh
#
# Logs: server/server.log
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$HERE")"
VENV="$SERVER_DIR/.venv"
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --venv) VENV="${2:?--venv needs a path}"; shift 2 ;;
        --venv=*) VENV="${1#--venv=}"; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

PYTHON="$VENV/bin/python"
LOG="$SERVER_DIR/server.log"
LABEL="com.suppressor.server"
DONE="Installed "; [ "$DRY_RUN" = 1 ] && DONE="Dry run: would install "
UNIT="suppressor.service"

run() {  # run a command, or just show it in --dry-run
    if [ "$DRY_RUN" = 1 ]; then echo "    [dry-run] would run: $*"; else "$@"; fi
}

# Fill @PYTHON@ / @SERVER_DIR@ / @LOG@ in a template. $2 = xml to escape for a plist.
render() {
    local text py dir log
    text="$(cat "$1")"
    py="$PYTHON"; dir="$SERVER_DIR"; log="$LOG"
    if [ "${2:-}" = xml ]; then
        py="$(xml_escape "$py")"; dir="$(xml_escape "$dir")"; log="$(xml_escape "$log")"
    fi
    shopt -u patsub_replacement 2>/dev/null || true   # bash 5.2: '&' in replacement is literal
    text="${text//@PYTHON@/$py}"
    text="${text//@SERVER_DIR@/$dir}"
    text="${text//@LOG@/$log}"
    printf '%s\n' "$text"
}

xml_escape() {
    local s="$1"
    shopt -u patsub_replacement 2>/dev/null || true
    s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
    printf '%s' "$s"
}

write_file() {  # write_file DEST < content
    if [ "$DRY_RUN" = 1 ]; then
        echo "    [dry-run] would write $1:"
        sed 's/^/        /'
    else
        mkdir -p "$(dirname "$1")"
        cat > "$1"
        echo "    wrote $1"
    fi
}

if [ ! -x "$PYTHON" ]; then
    if [ "$DRY_RUN" = 1 ]; then
        echo "    note: $PYTHON does not exist yet (fine in a dry run)"
    else
        echo "ERROR: $PYTHON not found. Run setup.sh first (or pass --venv PATH)." >&2
        exit 1
    fi
fi

case "$(uname -s)" in
    Darwin)
        DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
        DOMAIN="gui/$(id -u)"
        render "$HERE/$LABEL.plist.template" xml | write_file "$DEST"
        if [ "$DRY_RUN" = 1 ]; then
            run launchctl bootout "$DOMAIN/$LABEL"
            run launchctl bootstrap "$DOMAIN" "$DEST"
        else
            # unload the old copy (if any) so changes take effect, then load it
            launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$DEST" 2>/dev/null || true
            if ! launchctl bootstrap "$DOMAIN" "$DEST" 2>/dev/null; then
                launchctl load -w "$DEST"
            fi
        fi
        echo "${DONE}LaunchAgent '$LABEL'. It starts at login and is starting now."
        echo "Check:  curl http://127.0.0.1:8765/health   (ready after ~10 s)"
        echo "Logs:   $LOG"
        echo "Stop for now: launchctl bootout $DOMAIN/$LABEL"
        ;;
    Linux)
        if [ "$DRY_RUN" = 1 ] && ! command -v systemctl >/dev/null 2>&1; then
            echo "    note: systemctl not found here; a real run would stop with an error"
        elif ! command -v systemctl >/dev/null 2>&1; then
            echo "ERROR: systemctl not found; this system doesn't use systemd." >&2
            echo "Start the server another way: cd '$SERVER_DIR' && '$PYTHON' -I server.py" >&2
            exit 1
        fi
        if [ "$DRY_RUN" = 0 ] && ! systemctl --user show-environment >/dev/null 2>&1; then
            echo "ERROR: the systemd user manager isn't reachable (systemctl --user)." >&2
            echo "Log in to a normal desktop/SSH session (not 'su'/'sudo') and rerun." >&2
            exit 1
        fi
        DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
        render "$HERE/$UNIT.template" | write_file "$DEST"
        run systemctl --user daemon-reload
        run systemctl --user enable "$UNIT"
        run systemctl --user restart "$UNIT"
        echo "${DONE}systemd user unit '$UNIT'. It starts at login and is starting now."
        echo "Check:  curl http://127.0.0.1:8765/health   (ready after ~10 s)"
        echo "Status: systemctl --user status $UNIT     Logs: $LOG"
        echo "To keep it running while you're logged out: loginctl enable-linger \"\$USER\""
        ;;
    *)
        echo "ERROR: auto-start is supported on macOS and Linux here; on Windows use server/autostart/install-autostart.ps1." >&2
        exit 1
        ;;
esac
echo "Remove: $HERE/uninstall.sh"
