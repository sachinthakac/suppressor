"""Firefox native-messaging helper: lets the extension start, stop and restart the server.

Firefox runs this (through the launcher that install-native-host writes) for each
browser.runtime.sendNativeMessage("suppressor", {cmd, port}) call. It reads one
length-prefixed JSON message from stdin, answers on stdout and exits.

Commands: status | start | stop | restart.
If the server is installed as an auto-start service (Windows Task Scheduler task,
macOS LaunchAgent, Linux systemd user unit) the helper drives that service, so the
service keeps owning the process. Otherwise it launches server.py itself, detached,
and stops it through the server's /shutdown endpoint.
"""

import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(HERE)
SERVER_PY = os.path.join(SERVER_DIR, "server.py")
LOG_FILE = os.path.join(SERVER_DIR, "server.log")

TASK = "Suppressor server"
LABEL = "com.suppressor.server"
PLIST = os.path.expanduser(f"~/Library/LaunchAgents/{LABEL}.plist")
UNIT = "suppressor.service"
UNIT_FILE = os.path.expanduser(f"~/.config/systemd/user/{UNIT}")

WIN = sys.platform == "win32"
MAC = sys.platform == "darwin"
NO_WINDOW = 0x08000000 if WIN else 0  # CREATE_NO_WINDOW


# ---- native messaging framing ------------------------------------------------

def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("=I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


# ---- helpers -------------------------------------------------------------------

def run(argv):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as r:
            return json.loads(r.read()).get("ok") is True
    except Exception:
        return False


def listening(port):
    """True while anything answers HTTP on the port (even a server still loading the model)."""
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def service():
    if os.environ.get("SUPPRESSOR_NATIVE_SERVICE") == "none":  # tests: ignore any installed service
        return None
    if WIN:
        return "task" if run(["schtasks", "/Query", "/TN", TASK])[0] == 0 else None
    if MAC:
        return "launchd" if os.path.exists(PLIST) else None
    return "systemd" if os.path.exists(UNIT_FILE) else None


def http_shutdown(port):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/shutdown", data=b"{}", method="POST",
                                 headers={"X-Suppressor": "shutdown", "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=3)
        return True
    except Exception:
        return False


def spawn(port):
    """Launch server.py detached from Firefox, so it outlives this helper.

    Its output goes to server.log, never to our stdout: an inherited stdout pipe
    would keep Firefox waiting for this helper's reply to end.
    """
    env = dict(os.environ, SUPPRESSOR_PORT=str(port))
    log = open(LOG_FILE, "ab")
    io = dict(cwd=SERVER_DIR, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, close_fds=True)
    if WIN:
        pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        exe = pyw if os.path.exists(pyw) else sys.executable
        flags = 0x00000008 | 0x00000200 | NO_WINDOW  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        try:  # leave Firefox's job object, or the server dies with the helper
            subprocess.Popen([exe, "-I", SERVER_PY], creationflags=flags | 0x01000000, **io)  # CREATE_BREAKAWAY_FROM_JOB
        except OSError:
            subprocess.Popen([exe, "-I", SERVER_PY], creationflags=flags, **io)
    else:
        subprocess.Popen([sys.executable, "-I", SERVER_PY], start_new_session=True, **io)
    log.close()


# ---- commands ------------------------------------------------------------------

def start(port, svc):
    if listening(port):
        return {"ok": True, "note": "already running"}
    if svc == "task":
        code, out = run(["schtasks", "/Run", "/TN", TASK])
    elif svc == "launchd":
        uid = os.getuid()
        code, out = run(["launchctl", "kickstart", f"gui/{uid}/{LABEL}"])
        if code != 0:  # not loaded (e.g. after a stop): load it, which also starts it
            code, out = run(["launchctl", "bootstrap", f"gui/{uid}", PLIST])
    elif svc == "systemd":
        code, out = run(["systemctl", "--user", "start", UNIT])
    else:
        spawn(port)
        code, out = 0, ""
    return {"ok": code == 0, "error": out if code else None}


def stop(port, svc):
    errors = []
    if svc == "task":
        code, out = run(["schtasks", "/End", "/TN", TASK])
        if code: errors.append(out)
    elif svc == "launchd":
        # bootout, not kill: the agent has KeepAlive and would come straight back.
        run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"])
    elif svc == "systemd":
        code, out = run(["systemctl", "--user", "stop", UNIT])
        if code: errors.append(out)
    # A server started some other way (start.ps1, an older helper) is stopped over HTTP.
    deadline = time.time() + 2
    while time.time() < deadline and listening(port):
        time.sleep(0.25)
    if listening(port):
        http_shutdown(port)
    deadline = time.time() + 10
    while time.time() < deadline and listening(port):
        time.sleep(0.25)
    if listening(port):
        return {"ok": False, "error": "; ".join(errors) or "the server did not stop"}
    return {"ok": True}


def handle(msg):
    cmd = (msg or {}).get("cmd")
    try:
        port = int((msg or {}).get("port") or 8765)
    except (TypeError, ValueError):
        port = 8765
    svc = service()
    if cmd == "status":
        r = {"ok": True}
    elif cmd == "start":
        r = start(port, svc)
    elif cmd == "stop":
        r = stop(port, svc)
    elif cmd == "restart":
        r = stop(port, svc)
        if r["ok"]:
            r = start(port, svc)
    else:
        r = {"ok": False, "error": f"unknown command {cmd!r}"}
    r.update(service=svc, running=healthy(port), port=port)
    return {k: v for k, v in r.items() if v is not None}


def main():
    if WIN:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    msg = read_message()
    try:
        send_message(handle(msg))
    except Exception as e:  # always answer, or Firefox reports a vague disconnect
        send_message({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
