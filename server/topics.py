"""Turn a topic definition (sent by the extension) into Laya questions.

A topic definition looks like:

    {
      "id": "gta6",
      "name": "GTA VI",
      "description": "GTA 6, Grand Theft Auto VI",                # optional aliases
      "kind": "video game",                                      # optional: what sort of thing it is
      "categories": {"spoilers": "reveals the plot ...", "news": "...", ...}
    }

`categories` is the union of the topic's suppress and show reasons. The server
does not know which are which; it returns a probability per category and the
extension decides. Two questions per text, both "what does this say" rather
than "should this be hidden" (Laya handles the former much better):

  subject - choice: this topic / another <kind> / something that is not a <kind>
            (without a kind: this topic / something else). The kind-based
            contrast scored 95% on the GTA eval set vs 84-93% for generic wording.
  kind    - choice over the categories (+ "other" as a catch-all)

Option keys are read by the model too, so they must be meaningful words.
"""
from __future__ import annotations

import json
import re


def slug(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
    return s or "x"


def resolve_topic(topic: dict, library: dict) -> dict:
    """Extension-side topic (labels) -> server-side definition (keys + descriptions)."""
    cats = {}
    for label in list(topic.get("suppress", [])) + list(topic.get("show", [])):
        cats[slug(label)] = library.get(label.lower().strip(), label)
    return {
        "id": topic["id"],
        "name": topic["name"],
        "description": topic.get("description", ""),
        "kind": topic.get("kind", ""),
        "categories": cats,
    }


def signature(defn: dict) -> str:
    keys = ("name", "description", "kind", "categories")
    return json.dumps({k: defn.get(k) for k in keys}, sort_keys=True)


def build_questions(defn: dict) -> dict:
    name = defn["name"].strip()
    desc = (defn.get("description") or "").strip()
    kind = (defn.get("kind") or "").strip()
    subject = {"topic": f"{name} ({desc})" if desc else name}
    if kind:
        article = "an" if kind[0].lower() in "aeiou" else "a"
        subject["similar"] = f"another {kind}"
        subject["other"] = f"something that is not {article} {kind}"
        subject_q = "What is this video title about?"
    else:
        subject["other"] = "something else"
        subject_q = "What is this text about?"

    kinds = dict(defn.get("categories") or {})
    kinds.setdefault("other", "something else")

    return {
        "subject": {"type": "choice", "instructions": subject_q, "criteria": subject},
        "kind": {"type": "choice", "instructions": "What kind of content is this?", "criteria": kinds},
    }


def summarise(answers: dict) -> dict:
    return {
        "match": round(float(answers["subject"]["probabilities"]["topic"]), 4),
        "cats": {k: round(float(p), 4) for k, p in answers["kind"]["probabilities"].items()},
    }
