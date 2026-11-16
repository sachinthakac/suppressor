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

from topics import build_questions, signature, summarise  # noqa: E402

HOST = "127.0.0.1"
PORT = int(os.environ.get("SUPPRESSOR_PORT", "8765"))
MODEL_ID = os.environ.get("SUPPRESSOR_MODEL", "convaiinnovations/laya")
CACHE_SIZE = 20_000

log = logging.getLogger("suppressor")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class TopicDef(BaseModel):
    id: str
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=300)
    kind: str = Field("", max_length=60)
    categories: dict[str, str] = Field(default_factory=dict, max_length=24)


class ClassifyRequest(BaseModel):
    topics: list[TopicDef] = Field(default_factory=list, max_length=16)
    texts: list[str] = Field(default_factory=list, max_length=200)


class ValidateRequest(BaseModel):
    topic: TopicDef


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


def _key(sig: str, text: str) -> str:
    return hashlib.sha1(f"{sig}\x00{text}".encode()).hexdigest()


WARMUP = TopicDef(id="warmup", name="GTA VI", description="GTA 6", kind="video game",
                  categories={"spoilers": "reveals the plot", "news": "news"})


@app.on_event("startup")
def _load() -> None:
    global agent
    t = time.time()
    log.info("loading %s ...", MODEL_ID)
    agent = laya.load(MODEL_ID, device=os.environ.get("SUPPRESSOR_DEVICE"))
    # Warm up so the first real page isn't slow.
    agent.predict_batch(["GTA 6 trailer breakdown", "cat video"], build_questions(WARMUP.model_dump()))
    log.info("model ready in %.1fs on %s", time.time() - t, getattr(agent, "device", "?"))


@app.get("/health")
def health():
    return {"ok": agent is not None, "device": str(getattr(agent, "device", "?"))}


def _classify_topic(defn: dict, texts: list[str]) -> list[dict]:
    """Classify texts against one topic, using and filling the cache. Caller holds no lock."""
    sig = signature(defn)
    results: list[dict | None] = [None] * len(texts)
    todo = [i for i, t in enumerate(texts) if cache.get_(_key(sig, t)) is None]
    for i, t in enumerate(texts):
        if i not in todo:
            results[i] = cache.get_(_key(sig, t))
    if todo:
        with lock:
            # Another request may have classified some of these while we waited.
            still = [i for i in todo if cache.get_(_key(sig, texts[i])) is None]
            for i in todo:
                if i not in still:
                    results[i] = cache.get_(_key(sig, texts[i]))
            if still:
                out = agent.predict_batch([texts[i] for i in still], build_questions(defn), batch_size=32)
                for i, r in zip(still, out):
                    s = summarise(r["answers"])
                    cache.put(_key(sig, texts[i]), s)
                    results[i] = s
    return results


@app.post("/classify")
def classify(req: ClassifyRequest):
    """-> {"results": [{topic_id: {"match": p, "cats": {cat: p}}}], "errors": {topic_id: msg}}"""
    t0 = time.time()
    texts = [(t or " ").strip()[:600] or " " for t in req.texts]
    results: list[dict] = [{} for _ in texts]
    errors: dict[str, str] = {}
    for topic in req.topics:
        try:
            per = _classify_topic(topic.model_dump(), texts)
        except ValueError as e:  # e.g. options exceed Laya's head_max_len
            errors[topic.id] = str(e)
            continue
        for i, r in enumerate(per):
            results[i][topic.id] = r
    log.info("classified %d texts x %d topics in %.0f ms", len(texts), len(req.topics), (time.time() - t0) * 1000)
    return {"results": results, "errors": errors}


@app.post("/validate")
def validate(req: ValidateRequest):
    """Check a topic definition fits Laya's limits before saving it."""
    try:
        with lock:
            agent.predict_batch(["test"], build_questions(req.topic.model_dump()))
        return {"ok": True}
    except ValueError as e:
        return {"ok": False, "error": str(e)}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
