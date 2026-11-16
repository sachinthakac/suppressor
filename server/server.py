"""Local Laya classification sidecar for the Suppressor Firefox extension.

Runs on 127.0.0.1 only. The extension POSTs batches of short text snippets
(video titles, channel names, comment text) and gets back, per snippet, the
probability that it is about the watched topic and that it spoils it.

    python server/server.py            # http://127.0.0.1:8765
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import threading
import time
from collections import OrderedDict

os.environ.setdefault("USE_TF", "0")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import laya  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from topics import TOPICS, build_questions, summarise  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("SUPPRESSOR_PORT", "8765"))
MODEL_ID = os.environ.get("SUPPRESSOR_MODEL", "convaiinnovations/laya")
CACHE_SIZE = 20_000

log = logging.getLogger("suppressor")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class ClassifyRequest(BaseModel):
    topic: str = "gta6"
    texts: list[str] = Field(default_factory=list, max_length=200)


class LRU(OrderedDict):
    def __init__(self, size: int):
        super().__init__()
        self.size = size

    def get_(self, key):
        if key in self:
            self.move_to_end(key)
            return self[key]
        return None

    def put(self, key, value):
        self[key] = value
        self.move_to_end(key)
        while len(self) > self.size:
            self.popitem(last=False)


app = FastAPI(title="suppressor")
# Extension pages have a moz-extension:// origin; content scripts proxy via the
# background script, so only extension origins need CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^moz-extension://.*$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

lock = threading.Lock()
cache = LRU(CACHE_SIZE)
agent = None


def _key(topic: str, text: str) -> str:
    return hashlib.sha1(f"{topic}\x00{text}".encode()).hexdigest()


@app.on_event("startup")
def _load() -> None:
    global agent
    t = time.time()
    log.info("loading %s ...", MODEL_ID)
    agent = laya.load(MODEL_ID)
    # Warm up so the first real page isn't slow.
    agent.predict_batch(["GTA 6 trailer breakdown", "cat video"], build_questions("gta6"))
    log.info("model ready in %.1fs on %s", time.time() - t, getattr(agent, "device", "?"))


@app.get("/health")
def health():
    return {"ok": agent is not None, "topics": list(TOPICS)}


@app.post("/classify")
def classify(req: ClassifyRequest):
    if req.topic not in TOPICS:
        return {"error": f"unknown topic {req.topic!r}", "results": []}
    texts = [t.strip()[:600] for t in req.texts]
    results: list[dict | None] = [None] * len(texts)
    todo_idx, todo_txt = [], []
    for i, t in enumerate(texts):
        if not t:
            results[i] = {"about": 0.0, "spoiler": 0.0}
            continue
        hit = cache.get_(_key(req.topic, t))
        if hit is not None:
            results[i] = hit
        else:
            todo_idx.append(i)
            todo_txt.append(t)

    if todo_txt:
        t0 = time.time()
        with lock:
            out = agent.predict_batch(todo_txt, build_questions(req.topic), batch_size=32)
        for i, t, r in zip(todo_idx, todo_txt, out):
            s = summarise(r["answers"])
            cache.put(_key(req.topic, t), s)
            results[i] = s
        log.info("classified %d new (%d cached) in %.0f ms",
                 len(todo_txt), len(texts) - len(todo_txt), (time.time() - t0) * 1000)

    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
