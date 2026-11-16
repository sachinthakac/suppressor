# Suppressor

A Firefox extension that blurs spoilers on YouTube, Reddit and X. It starts with **GTA VI**.
Text is classified locally by [Laya](https://github.com/NandhaKishorM/laya), a small
on-device classifier. Nothing leaves your machine.

```
 YouTube page ──► content.js ──► background.js ──► 127.0.0.1:8765 (server.py + Laya)
   cards, comments,   keyword pre-filter       cache        "is this about GTA 6?"
   the watched video  + blur / reveal                       "story / gameplay / trailer / news / music / meme?"
```

## How a card is judged

1. Its title, channel name or comment text is extracted (`extension/sites.js`).
2. **Keyword pre-filter** (`extension/topics.js`). On a match the card is blurred *instantly*, so a
   spoiler never flashes on screen. If the server is down, these cards stay blurred (fail closed).
   - *strong* keywords (`GTA 6`, `GTA VI`, `Grand Theft Auto VI`) always count as on-topic.
   - *ambiguous* ones (`Lucia`, `Vice City`, `Leonida`) need Laya to agree.
3. **Laya** scores every snippet, including ones with no keyword, so oblique titles like
   "the saddest death in the new Rockstar game" are also caught. One batched call per page.
4. Modes (set in the popup):
   - **only story / gameplay** (default): hide plot spoilers and gameplay footage, walkthroughs,
     guides and leaks. Trailers, trailer reactions, news, music and memes stay visible.
   - **everything about it**: hide anything on-topic.
5. Clicking a blurred card reveals it. On a watch page, the player is blacked out and paused
   until you click it.

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

## Accuracy

`python server/eval_topics.py` runs the questions on 44 hand-labelled titles:

| question | threshold | accuracy |
|---|---|---|
| on-topic (GTA VI vs other) | 0.5 | 95% (42/44) |
| story/gameplay vs trailer/news/music/meme (GTA VI titles only) | 0.4 | 93% (28/30) |

Remaining misses include "Leonida full map leaked!" and "GTA 6: all 12 heists ranked" (spoilers
scored as news/trailer). Explicit "GTA 6" titles that Laya scores low on topic are covered by the
strong-keyword rule. The set is small, so **add real titles from your feed to `DATA` in
`eval_topics.py`** and tune the thresholds in the popup.

Note: Laya reads the option *keys* as well as their descriptions, so keep keys meaningful
(`story_spoiler`, not `a`).

## Adding a topic

Add an entry to `server/topics.py` (`TOPICS`) and a matching keyword set in `extension/topics.js`
with the same key.

## Performance

Use a CUDA build of PyTorch (see above). The default Windows wheel is CPU-only, which manages
about 0.5 s per title, too slow for a busy YouTube page. The extension sends one request per tab
at a time and never re-sends a title that is already waiting. The server re-checks its cache after
waiting for the model, so several tabs don't classify the same titles twice.
