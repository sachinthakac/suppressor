"""Quick accuracy check of the topic questions on hand-labelled titles.

    python server/eval_topics.py

Labels: (text, is_about_gta6, is_spoiler). Extend this list with real titles
you see in your feed - it is the cheapest way to improve the questions.
"""
import os
import sys
import time

os.environ.setdefault("USE_TF", "0")
sys.path.insert(0, os.path.dirname(__file__))

import laya  # noqa: E402
from topics import build_questions, summarise  # noqa: E402

DATA = [
    # about GTA6, spoilery
    ("GTA 6 ENDING EXPLAINED - What happens to Lucia and Jason", 1, 1),
    ("I beat GTA 6 in 40 hours - full story recap", 1, 1),
    ("GTA VI Final Mission Walkthrough (No Commentary)", 1, 1),
    ("Lucia's betrayal changes everything", 1, 1),
    ("Every secret in Vice City's map | GTA 6", 1, 1),
    ("GTA 6 Trailer 3 breakdown: every detail you missed", 1, 1),
    ("The saddest death in Grand Theft Auto VI", 1, 1),
    ("Leonida full map leaked!", 1, 1),
    ("GTA 6 gameplay - first 2 hours", 1, 1),
    ("Jason dies?? GTA 6 theory confirmed", 1, 1),
    # about GTA6, not spoilery
    ("GTA 6 delayed again - new release date", 1, 0),
    ("GTA 6 price confirmed at $80", 1, 0),
    ("Rockstar says GTA 6 sold 25 million copies on day one", 1, 0),
    ("Should you preorder GTA VI?", 1, 0),
    ("Take-Two earnings call: GTA 6 still on track", 1, 0),
    # not about GTA6
    ("GTA 5 speedrun world record", 0, 0),
    ("GTA San Andreas ending - Grove Street forever", 0, 1),
    ("Red Dead Redemption 2 ending made me cry", 0, 1),
    ("Elden Ring final boss guide", 0, 1),
    ("How to make sourdough bread at home", 0, 0),
    ("Lofi hip hop radio - beats to relax/study to", 0, 0),
    ("iPhone 18 review: one month later", 0, 0),
    ("Miami Vice opening theme (1984)", 0, 0),
    ("Florida man arrested after alligator chase", 0, 0),
    ("Cyberpunk 2077 Phantom Liberty all endings", 0, 1),
    ("Minecraft but every block is TNT", 0, 0),
    ("The Last of Us Part 2 story explained", 0, 1),
    ("Rockstar Games history documentary", 0, 0),
]


def main():
    t = time.time()
    agent = laya.load("convaiinnovations/laya")
    print(f"loaded in {time.time()-t:.1f}s")
    q = build_questions("gta6")
    texts = [d[0] for d in DATA]
    agent.predict_batch(texts[:2], q)
    t = time.time()
    out = agent.predict_batch(texts, q, batch_size=32)
    dt = (time.time() - t) * 1000
    print(f"{len(texts)} titles in {dt:.0f} ms ({dt/len(texts):.1f} ms/title)\n")

    print(f"{'about':>6} {'spoil':>6}  lbl  title")
    for (text, a, s), r in zip(DATA, out):
        sm = summarise(r["answers"])
        pa, ps = sm["about"], sm["spoiler"]
        mark = "" if (pa >= 0.7) == bool(a) else "  <-- about wrong"
        print(f"{pa:6.2f} {ps:6.2f}  {a}{s}   {text[:60]}{mark}")

    for name, idx in (("about", 1), ("spoiler", 2)):
        rows = DATA if name == "about" else [d for d in DATA if d[1]]
        outs = out if name == "about" else [o for d, o in zip(DATA, out) if d[1]]
        key = "about" if name == "about" else "spoiler"
        for thr in (0.5, 0.6, 0.7):
            acc = sum((summarise(o["answers"])[key] >= thr) == bool(d[idx]) for d, o in zip(rows, outs)) / len(rows)
            print(f"{name:8s} thr={thr}: acc {acc:.0%} (n={len(rows)})")


if __name__ == "__main__":
    main()
