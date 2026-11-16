# Suppressor

A Firefox extension that blurs spoilers on YouTube, Reddit and X. It starts with **GTA VI**.
Text is classified locally by [Laya](https://github.com/NandhaKishorM/laya), a small
on-device classifier. Nothing leaves your machine.

```
 YouTube page ──► content.js ──► background.js ──► 127.0.0.1:8765 (server.py + Laya)
   cards, comments,   keyword pre-filter       cache        "is this about GTA 6?"
   the watched video  + blur / reveal                       "story/gameplay or business news?"
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
   - **everything about it** (default): hide anything on-topic.
   - **only story / gameplay**: let release dates, prices and sales news through.
5. Clicking a blurred card reveals it. On a watch page, the player is blacked out and paused
   until you click it.

## Running it

```powershell
pip install -r server/requirements.txt
./server/start.ps1          # first run without HF_HUB_OFFLINE=1 downloads the model (~2.3 GB)
```

Firefox: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick
`extension/manifest.json`. For a persistent install use `npx web-ext run -s extension` while
developing, or sign it via AMO (unlisted) for permanent use.

## Accuracy

`python server/eval_topics.py` runs the questions on 28 hand-labelled titles:

| question | threshold | accuracy |
|---|---|---|
| on-topic (GTA VI vs other) | 0.5 | 93% (26/28) |
| story/gameplay vs business news (GTA VI titles only) | 0.5 | 100% (15/15) |

Laya alone misses some explicit titles, for example "GTA 6 ENDING EXPLAINED" scored 0.39. The
strong-keyword rule covers those. The set is tiny, so **add real titles from your feed to `DATA`
in `eval_topics.py`** and tune the thresholds in the popup.

## Adding a topic

Add an entry to `server/topics.py` (`TOPICS`) and a matching keyword set in `extension/topics.js`
with the same key.

## Performance

Laya runs on CPU with the default PyTorch wheel, at about 375 ms per title on this machine.
Results are cached, and blurring is instant for keyword hits, so the delay only affects untagged
cards. A CUDA build of PyTorch should cut this to a few ms per title on a GPU.
