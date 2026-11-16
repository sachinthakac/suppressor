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

## Running it

```powershell
# one-time: project venv with CUDA PyTorch (pick the cuXXX matching your driver)
python -m venv server/.venv
server/.venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cu130
server/.venv/Scripts/python -m pip install -r server/requirements.txt

./server/start.ps1          # first run without HF_HUB_OFFLINE=1 downloads the model (~2.3 GB)
```

Firefox: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick
`extension/manifest.json`. For a persistent install use `npx web-ext run -s extension` while
developing, or sign it via AMO (unlisted) for permanent use.

### Start the server automatically

```powershell
./server/install-autostart.ps1      # registers a logon task; starts it now
./server/uninstall-autostart.ps1    # removes it
```

This adds a Task Scheduler task, **Suppressor server**, for your user. No admin rights are needed.
It runs `server/.venv/Scripts/pythonw.exe` (no console window) at logon and restarts it if it
crashes. Output goes to `server/server.log`. To stop it for now: `Stop-ScheduledTask "Suppressor server"`.
Don't run `start.ps1` at the same time; both use port 8765.

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

Use a CUDA build of PyTorch (see above). The default Windows wheel is CPU-only, which manages
about 0.5 s per title, too slow for a busy YouTube page. The extension sends one request per tab
at a time and never re-sends a title that is already waiting. The server re-checks its cache after
waiting for the model, so several tabs don't classify the same titles twice.
