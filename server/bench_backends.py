"""Compare the torch and ONNX Runtime backends on CPU.

    server/.venv/Scripts/python -I server/bench_backends.py

Runs the default GTA VI topic over the 44 labelled titles in eval_topics.py with
both backends forced onto the CPU, and prints per-title latency (one batch of 44
and single-title calls) and how closely the derived scores agree:
match = P(subject=topic), suppress = sum of the topic's suppress categories.
laya ships an ONNX runtime but no exported graph, so the model is exported once
to server/.onnx-cache/ (~1.7 GB) and reused on later runs.
"""
from __future__ import annotations

import hashlib
import logging
import os
import statistics
import sys
import time
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import laya  # noqa: E402

from eval_topics import DATA, load_topic, scores  # noqa: E402
from topics import build_questions  # noqa: E402

MODEL_ID = os.environ.get("SUPPRESSOR_MODEL", "convaiinnovations/laya")
SINGLE_REPEATS = 3
ONNX_CACHE = os.path.join(HERE, ".onnx-cache")
log = logging.getLogger("bench")


def _model_dir(model_id: str) -> str:
    if os.path.isdir(model_id):
        return model_id
    from huggingface_hub import snapshot_download
    return snapshot_download(model_id, allow_patterns=["rl_agent_config.json", "model.safetensors"])


def onnx_cache_path(model_id: str) -> str:
    """Where the ONNX export of this checkpoint (and this laya version) is cached."""
    weights = os.path.join(_model_dir(model_id), "model.safetensors")
    st = os.stat(weights)
    key = f"{model_id}|{st.st_size}|{st.st_mtime_ns}|laya {getattr(laya, '__version__', '?')}"
    return os.path.join(ONNX_CACHE, "laya-" + hashlib.sha1(key.encode()).hexdigest()[:16] + ".onnx")


def export_onnx(model_id: str, cpu_agent=None) -> str:
    """Return the path of a cached ONNX export of `model_id`, exporting it first if needed.

    laya ships an ONNX runtime (`laya.load(backend="onnx")`) but no exported graph, so it is
    traced here from the torch model on the CPU. Takes ~30 s and ~1.7 GB on disk, once.
    """
    path = onnx_cache_path(model_id)
    if os.path.exists(path):
        return path
    import torch

    os.makedirs(ONNX_CACHE, exist_ok=True)
    log.info("exporting %s to ONNX (one-off) ...", model_id)
    t = time.time()
    agent = cpu_agent if cpu_agent is not None else laya.load(model_id, device="cpu")
    model = agent.model.eval()
    if next(model.parameters()).device.type != "cpu":
        raise RuntimeError("export_onnx needs a CPU-loaded agent")
    rows, tokens, markers = 4, 200, 3  # tokens > ModernBERT's 128-token local window
    args = (
        torch.full((rows, tokens), agent.tok.cls_token_id or 0, dtype=torch.long),
        torch.ones((rows, tokens), dtype=torch.long),
        torch.arange(1, markers + 1, dtype=torch.long).repeat(rows, 1),
        torch.ones((rows, markers), dtype=torch.bool),
        torch.zeros(rows, dtype=torch.long),
    )
    names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
    dyn = {"input_ids": {0: "n", 1: "L"}, "attention_mask": {0: "n", 1: "L"},
           "marker_pos": {0: "n", 1: "k"}, "marker_mask": {0: "n", 1: "k"}, "qtype": {0: "n"},
           "logits": {0: "n", 1: "k"}, "act_logits": {0: "n"}}
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        # Grad stays enabled on purpose: under no_grad PyTorch swaps nn.TransformerEncoderLayer
        # for a fused kernel (aten::_transformer_encoder_layer_fwd) that ONNX cannot express.
        with torch.enable_grad(), warnings.catch_warnings():
            warnings.simplefilter("ignore")
            torch.onnx.export(model, args, tmp, input_names=names, output_names=["logits", "act_logits"],
                              dynamic_axes=dyn, opset_version=17, dynamo=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    log.info("ONNX export done in %.0fs: %s", time.time() - t, path)
    return path


def bench(agent, texts, q):
    agent.predict_batch(texts[:4], q, batch_size=32)  # warm-up
    batch_ms = []
    out = None
    for _ in range(3):
        t = time.perf_counter()
        out = agent.predict_batch(texts, q, batch_size=32)
        batch_ms.append((time.perf_counter() - t) * 1000 / len(texts))
    single_ms = []
    for _ in range(SINGLE_REPEATS):
        for text in texts:
            t = time.perf_counter()
            agent.predict_batch([text], q)
            single_ms.append((time.perf_counter() - t) * 1000)
    return out, min(batch_ms), statistics.median(single_ms)


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    topic, defn = load_topic()
    q = build_questions(defn)
    texts = [d[0] for d in DATA]
    mt, st = topic["matchThreshold"], topic["suppressThreshold"]

    t = time.time()
    torch_agent = laya.load(MODEL_ID, device="cpu")
    print(f"torch load {time.time() - t:.1f}s")
    t = time.time()
    onnx_path = export_onnx(MODEL_ID, torch_agent)
    print(f"onnx model {onnx_path} ready in {time.time() - t:.1f}s")
    t = time.time()
    onnx_agent = laya.load(MODEL_ID, backend="onnx", onnx_path=onnx_path)
    print(f"onnx load {time.time() - t:.1f}s, providers {onnx_agent.session.get_providers()}")

    rows = []
    results = {}
    for name, agent in (("torch-cpu", torch_agent), ("onnx-cpu", onnx_agent)):
        out, b, s = bench(agent, texts, q)
        results[name] = [scores(topic, r["answers"])[:2] for r in out]
        rows.append((name, b, s))

    print(f"\n{'backend':10s} {'batch44 ms/title':>17s} {'single ms/title':>16s}")
    for name, b, s in rows:
        print(f"{name:10s} {b:17.1f} {s:16.1f}")
    (_, tb, ts), (_, ob, os_) = rows
    print(f"{'speed-up':10s} {tb / ob:16.2f}x {ts / os_:15.2f}x")

    a, b = results["torch-cpu"], results["onnx-cpu"]
    dm = max(abs(x[0] - y[0]) for x, y in zip(a, b))
    ds = max(abs(x[1] - y[1]) for x, y in zip(a, b))
    agree_m = sum((x[0] >= mt) == (y[0] >= mt) for x, y in zip(a, b)) / len(a)
    agree_s = sum((x[1] >= st) == (y[1] >= st) for x, y in zip(a, b)) / len(a)
    hide = lambda r: r[0] >= mt and r[1] >= st  # noqa: E731
    agree_h = sum(hide(x) == hide(y) for x, y in zip(a, b)) / len(a)
    print(f"\nmax |diff| match {dm:.4f}, suppress {ds:.4f}")
    print(f"decision agreement: match@{mt} {agree_m:.1%}, suppress@{st} {agree_s:.1%}, hide {agree_h:.1%}"
          f" (n={len(a)})")


if __name__ == "__main__":
    main()
