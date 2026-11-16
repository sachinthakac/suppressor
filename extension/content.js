// Suppressor content script.
//
// Pipeline per item (video card, post, comment):
//   1. extract a short text snippet
//   2. keyword hit  -> blur immediately (fail closed: stays blurred if the server is down)
//      no hit       -> visible, unless "paranoid" mode blurs everything until judged
//   3. snippet is batched to the background script -> local Laya server
//   4. verdict decides final state: blurred or revealed
// YouTube recycles DOM nodes, so each element remembers the text it was judged on
// (data-sup-sig) and is re-judged whenever that changes.
(() => {
  "use strict";

  const site = SUPPRESSOR_SITES.find((s) => s.match.test(location.hostname));
  if (!site) return;

  const DEFAULTS = {
    enabled: true,
    topic: "gta6",
    mode: "all",        // "all": hide anything about the topic; "spoilers": only story/gameplay content
    aboutThreshold: 0.55,
    spoilerThreshold: 0.5,
    paranoid: false,    // blur every item until the classifier has cleared it
  };
  let cfg = { ...DEFAULTS };
  let topic = SUPPRESSOR_TOPICS[cfg.topic];

  const verdicts = new Map();  // text -> {about, spoiler} | "error"
  const queue = new Set();     // texts awaiting classification
  let flushTimer = null;
  let scanTimer = null;

  // ---- decisions ---------------------------------------------------------

  const strongHit = (t) => topic.strong.some((re) => re.test(t));
  const ambiguousHit = (t) => topic.ambiguous.some((re) => re.test(t));

  function shouldHide(text, v) {
    const strong = strongHit(text);
    // No verdict yet, or the server is unreachable: fail closed on any keyword.
    if (v === "error" || v === undefined) return strong || ambiguousHit(text) || cfg.paranoid;
    const about =
      strong ||
      v.about >= cfg.aboutThreshold ||
      (ambiguousHit(text) && v.about >= cfg.aboutThreshold - 0.15);
    if (!about) return false;
    return cfg.mode === "all" || v.spoiler >= cfg.spoilerThreshold;
  }

  // ---- DOM state ---------------------------------------------------------

  function setState(el, state, reason) {
    if (el.dataset.supRevealed === "1") state = "shown";
    if (el.dataset.supState === state) return;
    el.dataset.supState = state;          // "hidden" | "pending" | "shown"
    if (reason) el.dataset.supReason = reason;
    else delete el.dataset.supReason;
  }

  function judge(el) {
    // Nested matches (e.g. a lockup inside a rich-item): judge only the outermost.
    if (el.parentElement && el.parentElement.closest(site.items)) return;
    const text = (site.text(el) || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    if (el.dataset.supSig !== text) {
      el.dataset.supSig = text;
      delete el.dataset.supRevealed;
    }
    const v = verdicts.get(text);
    if (v === undefined) {
      if (!queue.has(text)) enqueue(text);
      setState(el, shouldHide(text, undefined) ? "pending" : "shown", `${topic.name} (checking…)`);
      return;
    }
    if (shouldHide(text, v)) {
      setState(el, "hidden", v === "error" ? `${topic.name} keyword` : label(v));
    } else {
      setState(el, "shown");
    }
  }

  const label = (v) =>
    `${topic.name} · ${Math.round(v.about * 100)}% topic · ${Math.round(v.spoiler * 100)}% spoiler`;

  // ---- page-level (the video being watched) -------------------------------

  let pageSig = "";
  function judgePage() {
    if (!site.pageTitle) return;
    const title = site.pageTitle();
    const player = site.player && document.querySelector(site.player);
    if (!title || !player) return;
    if (title !== pageSig) {
      pageSig = title;
      delete player.dataset.supRevealed;
      if (site.pageExtras) document.querySelectorAll(site.pageExtras).forEach((x) => delete x.dataset.supRevealed);
    }
    const v = verdicts.get(title);
    if (v === undefined && !queue.has(title)) enqueue(title);
    const hide = shouldHide(title, v);
    const targets = [player, ...(site.pageExtras ? document.querySelectorAll(site.pageExtras) : [])];
    for (const t of targets) {
      if (t === player && player.dataset.supRevealed === "1") { setState(t, "shown"); continue; }
      setState(t, hide ? (v === undefined ? "pending" : "hidden") : "shown",
        hide ? (v && v !== "error" ? label(v) : `${topic.name}`) : null);
    }
    if (hide && player.dataset.supRevealed !== "1") {
      const video = player.querySelector("video");
      if (video && !video.paused) video.pause();
    }
  }

  // ---- classification ----------------------------------------------------

  function enqueue(text) {
    queue.add(text);
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  }

  async function flush() {
    flushTimer = null;
    const texts = [...queue].slice(0, 64);
    texts.forEach((t) => queue.delete(t));
    if (queue.size) flushTimer = setTimeout(flush, 0);
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "classify", topic: cfg.topic, texts });
    } catch (e) {
      res = { error: String(e) };
    }
    texts.forEach((t, i) => {
      const r = res && res.results && res.results[i];
      verdicts.set(t, r || "error");
    });
    scheduleScan();
  }

  // ---- scanning ----------------------------------------------------------

  function scan() {
    scanTimer = null;
    if (!cfg.enabled) return;
    document.querySelectorAll(site.items).forEach(judge);
    judgePage();
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 60);
  }

  function clearAll() {
    document.querySelectorAll("[data-sup-state]").forEach((el) => {
      delete el.dataset.supState;
      delete el.dataset.supReason;
    });
  }

  // Click on a hidden item reveals it instead of following the link.
  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("[data-sup-state='hidden'],[data-sup-state='pending']");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    el.dataset.supRevealed = "1";
    setState(el, "shown");
    if (site.pageExtras && el.matches(site.player)) {
      document.querySelectorAll(site.pageExtras).forEach((x) => { x.dataset.supRevealed = "1"; setState(x, "shown"); });
    }
  }, true);

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "aria-label", "post-title"],
  });
  document.addEventListener("yt-navigate-finish", scheduleScan);

  browser.storage.local.get(DEFAULTS).then((s) => {
    cfg = { ...DEFAULTS, ...s };
    topic = SUPPRESSOR_TOPICS[cfg.topic] || SUPPRESSOR_TOPICS.gta6;
    scheduleScan();
  });
  browser.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) cfg[k] = newValue;
    topic = SUPPRESSOR_TOPICS[cfg.topic] || SUPPRESSOR_TOPICS.gta6;
    if (changes.topic) verdicts.clear();
    clearAll();
    document.querySelectorAll("[data-sup-revealed]").forEach((el) => delete el.dataset.supRevealed);
    scheduleScan();
  });
  scheduleScan();
})();
