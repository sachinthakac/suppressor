"""Local Laya classification sidecar for the Suppressor Firefox extension.

Runs on 127.0.0.1 only. The extension POSTs batches of short text snippets
(video titles, channel names, comment text) and gets back, per snippet, the
probability that it is about each configured topic and for each reason.

    python server/server.py            # http://127.0.0.1:8765

Under pythonw.exe (no console, e.g. the autostart task) all output goes to
server/server.log.
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import threading
import time
from collections import OrderedDict
from contextlib import asynccontextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(HERE, "server.log")

# pythonw.exe has no stdout/stderr; anything that prints (logging, uvicorn,
# download progress bars) would crash. Send it all to a log file instead.
if sys.stdout is None or sys.stderr is None:
    if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 5_000_000:
        os.replace(LOG_FILE, LOG_FILE + ".1")
    _log = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log


def _model_cached(model_id: str) -> bool:
    hub = os.environ.get("HF_HUB_CACHE") or os.path.join(
        os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface"), "hub")
    return os.path.isdir(os.path.join(hub, "models--" + model_id.replace("/", "--")))


os.environ.setdefault("USE_TF", "0")
# Skip Hugging Face network checks once the model is downloaded (faster, works offline).
if "HF_HUB_OFFLINE" not in os.environ and _model_cached(os.environ.get("SUPPRESSOR_MODEL", "convaiinnovations/laya")):
    os.environ["HF_HUB_OFFLINE"] = "1"
sys.path.insert(0, HERE)

import laya  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from topics import build_questions, signature, summarise  # noqa: E402

SERVER_VERSION = "0.4.0"
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


WARMUP = TopicDef(id="warmup", name="GTA VI", description="GTA 6", kind="video game",
                  categories={"spoilers": "reveals the plot", "news": "news"})
# Short feed-style titles timed at startup to report ms_per_title on /health.
BENCH_TITLES = [
    "GTA 6 ending explained", "GTA 6 trailer 3 breakdown", "Lucia's betrayal changes everything",
    "GTA 6 delayed again - new release date", "Leonida full map leaked!", "GTA 6 gameplay - first 2 hours",
    "Reacting to the GTA 6 trailer!!", "GTA VI soundtrack: every licensed song so far",
    "GTA 5 speedrun world record", "How to make sourdough bread at home", "iPhone 18 review",
    "Elden Ring final boss guide", "Lofi hip hop radio - beats to relax/study to",
    "Minecraft but every block is TNT", "Florida man arrested after alligator chase", "cat video",
]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global agent, device_name, ms_per_title
    t = time.time()
    log.info("loading %s ...", MODEL_ID)
    agent = laya.load(MODEL_ID, device=os.environ.get("SUPPRESSOR_DEVICE") or None)
    device_name = str(getattr(agent, "device", "?"))
    q = build_questions(WARMUP.model_dump())
    # Warm up so the first real page isn't slow.
    agent.predict_batch(["GTA 6 trailer breakdown", "cat video"], q)
    t1 = time.perf_counter()
    agent.predict_batch(BENCH_TITLES, q, batch_size=32)
    ms_per_title = round((time.perf_counter() - t1) * 1000 / len(BENCH_TITLES), 1)
    log.info("model ready in %.1fs on %s (%.1f ms/title)", time.time() - t, device_name, ms_per_title)
    yield


app = FastAPI(title="suppressor", lifespan=lifespan)
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
device_name = "?"
ms_per_title = 0.0


def _key(sig: str, text: str) -> str:
    return hashlib.sha1(f"{sig}\x00{text}".encode()).hexdigest()


@app.get("/health")
def health():
    return {"ok": agent is not None, "device": device_name, "backend": "torch",
            "ms_per_title": ms_per_title, "version": SERVER_VERSION}


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


# log_config=None: keep uvicorn on our logging setup (and the log file under pythonw).
_server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=PORT, log_level="warning", log_config=None))


@app.post("/shutdown")
def shutdown(request: Request):
    """Used by the Firefox helper (server/native) to stop a server it can't stop otherwise.

    The custom header forces a CORS preflight, which only extension origins pass, so
    ordinary web pages can't shut the server down with a simple cross-site POST.
    """
    origin = request.headers.get("origin")
    if request.headers.get("x-suppressor") != "shutdown" or (origin and not origin.startswith("moz-extension://")):
        raise HTTPException(status_code=403, detail="forbidden")
    log.info("shutdown requested")
    _server.should_exit = True
    return {"ok": True}


if __name__ == "__main__":
    _server.run()
