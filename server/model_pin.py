"""The Laya model revision Suppressor downloads and loads.

setup.sh and setup.ps1 download one fixed commit of the model, and the Hugging Face
cache stores it under that commit id. The server and the setup smoke test run with
HF_HUB_OFFLINE=1, so if laya.load() is not told which revision to use it asks for
"main", cannot resolve that without the network, and fails. Setting LAYA_REVISION
to the same commit makes the offline load find the cached copy.

The commit lives in model_revision.txt so the setup scripts and the server read
one value and cannot drift apart.
"""
from __future__ import annotations

import os

DEFAULT_MODEL = "convaiinnovations/laya"
REVISION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_revision.txt")


def pinned_revision() -> str:
    with open(REVISION_FILE, encoding="utf-8") as f:
        return f.read().strip()


def pin_revision(model_id: str) -> None:
    """Set LAYA_REVISION for the default model, unless the caller already set one.

    A different SUPPRESSOR_MODEL is left alone: the pinned commit belongs to the default repo.
    """
    if model_id.lower() == DEFAULT_MODEL and not os.environ.get("LAYA_REVISION", "").strip():
        os.environ["LAYA_REVISION"] = pinned_revision()
