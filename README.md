# Suppressor

A Firefox extension that blurs content about topics you choose (GTA VI out of the box) on YouTube,
Reddit and X, **for the reasons you choose**. For example, hide GTA VI *spoilers, leaks, gameplay,
endings* but keep *news, trailers, music* visible. Text is classified locally by
[Laya](https://github.com/NandhaKishorM/laya), a small on-device classifier. Nothing leaves your machine.

```
 YouTube page ──► content.js ──► background.js ──► 127.0.0.1:8765 (server.py + Laya)
   cards, comments,   keywords, veil UI   topics, cache    per topic: "is this about it?"
   the watched video                                        + "which of your reasons fits?"
```

## Topics

Edit topics on the options page (popup → **Manage topics**). Each topic has:

| field | example | what it does |
|---|---|---|
| name / also known as | `GTA VI` / `GTA 6, Grand Theft Auto VI` | what the classifier looks for |
| kind of thing | `video game` | contrasts with "another video game" and "not a video game", which noticeably improves matching |
| keywords | `GTA 6`, `GTA VI` | always count as the topic; blurred instantly |
| hints | `Lucia`, `Vice City` | blurred instantly, kept hidden only if the classifier agrees |
| hide when it's about | `spoilers, ending, gameplay, leaks, explanation, nudity` | reasons to hide (empty = hide everything on-topic) |
| always show | `news, trailer, music, meme` | reasons that are fine; they also give the classifier somewhere else to put such items |
| thresholds | topic match 50%, hide at 40% | sensitivity |

Reasons from the built-in library (`extension/defaults.json`) come with short descriptions for
the classifier. Any other word you type works too and is used as its own description. Each topic
has a **Test it** box: type a title and see the scores and verdict.

## How an item is judged

1. Its title, channel name or comment text is extracted (`extension/sites.js`).
2. A keyword or hint match veils it instantly with a "Checking…" spinner, so nothing flashes on
   screen. If the server is down, keyword matches stay hidden (fail closed).
3. Laya scores every item against every enabled topic in one batched request: P(on-topic) plus a
   probability for each hide/show reason.
4. It's hidden when it's on-topic and its hide reasons add up past the threshold.
5. The veil shows the topic and the top reasons. The chevron expands it into the scores, the
   matched keyword and a **Show anyway** button. Hovering a veiled card doesn't start YouTube's
   preview, and nothing under a veil can play. On a watch page, the player itself is veiled.

## Installing

### 1. The classifier server

You need Python 3.12 or newer. From the repo (or the server bundle attached to a GitHub release):

```powershell
./setup.ps1                 # Windows
```
```bash
./setup.sh                  # macOS / Linux
```

The script:
- creates `server/.venv`;
- picks PyTorch for the machine: CUDA if `nvidia-smi` finds an NVIDIA GPU, the standard build on
  macOS (Apple GPU via MPS), otherwise CPU;
- installs the pinned dependencies from `server/requirements.txt`;
- downloads the model (about 850 MB, once);
- runs a quick test that prints the device and the time per call;
- offers to start the server automatically at login.

It's safe to run again; it updates rather than breaks. Options: `-Device auto|cuda|cpu`,
`-VenvPath`, `-Autostart` / `-NoAutostart`, `-DryRun` (prints what it would do). The bash
versions are `--device`, `--venv`, `--autostart` / `--no-autostart`, `--dry-run`.

To run the server by hand instead: `./server/start.ps1` on Windows, or
`server/.venv/bin/python -I server/server.py` on macOS/Linux.

### 2. The extension

Regular Firefox only keeps **signed** extensions installed. Release builds attach a signed `.xpi`
once signing is set up (see below); open it in Firefox to install. Until then, for development:
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `extension/manifest.json`,
or `npm install && npm start`, which launches a Firefox profile with the extension loaded.

On first install the extension opens a welcome page that turns green once it can reach the
server. If the server runs on another port, set it under **Options → Advanced**.

### Start the server automatically

`setup` offers this. To manage it yourself:

| OS | install | remove |
|---|---|---|
| Windows | `server/autostart/install-autostart.ps1` | `server/autostart/uninstall-autostart.ps1` |
| macOS (launchd) / Linux (systemd --user) | `server/autostart/install.sh` | `server/autostart/uninstall.sh` |

On Windows this is a Task Scheduler task, **Suppressor server**, that runs `pythonw.exe` (no
window) at logon and restarts it if it crashes. No admin rights are needed. On macOS it's a
LaunchAgent and on Linux a systemd user service, both restarted on failure. Logs go to
`server/server.log`. Don't also run `start.ps1`, because both use port 8765. The macOS and Linux
installers have only been tested with simulated systems so far.

### Start, stop and restart from Firefox

**Options → Advanced → Classifier server** has Start, Stop and Restart buttons. Clicking the
status in the page header jumps there. They work through a small helper that Firefox is
allowed to run (`server/native/native_host.py`, via native messaging). `setup` registers it
for your user. To register it by hand: `server/native/install-native-host.ps1` on Windows, or
`server/native/install-native-host.sh` on macOS/Linux. If the server is installed as an auto-start
service, the helper starts and stops that service. Otherwise it launches `server.py` in the
background and stops it through the server's `/shutdown` endpoint. Only the helper and the
extension can call that endpoint.

## Releasing

```bash
npm install
npm run lint && npm run build        # -> web-ext-artifacts/suppressor-<version>.zip
WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=... npm run sign   # signed .xpi (unlisted on AMO)
```

Pushing a tag `v<version>` (it must match `extension/manifest.json`) runs
`.github/workflows/release.yml`. That workflow lints, builds, signs if the repo secrets
`AMO_JWT_ISSUER` / `AMO_JWT_SECRET` are set (from addons.mozilla.org → Developer Hub → Manage
API Keys), and publishes a GitHub release with the `.xpi` and a server bundle. `ci.yml` lints
every push and pull request to `main`.

## Backing up and sharing topics

On the options page, **Export** downloads all topics and settings as JSON, and **Import** loads
one. Importing merges: topics with the same id are replaced, new ones are added, others are kept.
Each topic card also has its own export button, for sharing a single topic. Imported files are
treated as untrusted, and any unexpected fields are dropped.

## Accuracy

`server/.venv/Scripts/python -I server/eval_topics.py` runs the default GTA VI topic over 44
hand-labelled titles:

| question | threshold | accuracy |
|---|---|---|
| on-topic (GTA VI vs other) | 0.5 | 91% (40/44) |
| hide vs show (GTA VI titles only) | 0.4 | 90% (27/30) |

The classifier alone scores some explicit titles low ("GTA 6 ENDING EXPLAINED" got 0.32 on topic
match). Keywords cover those. Older GTA games sometimes match GTA VI (San Andreas 0.64). The set is
small, so **add real titles from your feed to `DATA` in `eval_topics.py`**.

Laya reads option *keys* as well as their descriptions, so reasons should be meaningful words.

## Performance

On a GPU each title takes a few ms (about 7 ms on an RTX 4060). On a CPU it's about 0.75 s, so
the extension only classifies items within about 1500px of the screen. Keyword matches are still
blurred instantly everywhere, and the popup shows "slow" when the server reports more than
100 ms per title. ONNX was measured as an alternative for CPUs (`server/bench_backends.py`):
same answers, but about 0.63x the speed of PyTorch, so it isn't used. The extension sends one
request per tab at a time and never re-sends a title that's already waiting. The server re-checks
its cache after waiting for the model, so several tabs don't classify the same titles twice.

## Credits

Icon: the see-no-evil monkey emoji from [OpenMoji](https://openmoji.org/) (CC BY-SA 4.0). See `extension/icons/ATTRIBUTION.md`.
