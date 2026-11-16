// Suppressor content script.
//
// For every item (video card, post, comment) and for the page's own video:
//   1. extract a short text snippet (sites.js)
//   2. keyword/hint match for any topic -> veiled instantly ("pending")
//   3. once the item is near the viewport (the watched video: immediately),
//      the snippet is batched to the background script -> local Laya server,
//      which scores it against every enabled topic and its suppress/show reasons
//   4. Sup.decide() per topic -> veiled with reasons ("hidden") or released
// YouTube recycles DOM nodes, so each element remembers the text it was judged
// on (data-sup-sig) and is re-judged whenever that changes.
(() => {
  "use strict";

  const site = SUPPRESSOR_SITES.find((s) => s.match.test(location.hostname));
  if (!site) return;

  let enabled = true;
  let paranoid = false;
  let topics = []; // compiled, enabled only

  const verdicts = new Map(); // text -> {r: {topicId: {match, cats}}, errors} | "error"
  const queue = new Set();
  const inflight = new Set();
  let flushTimer = null;
  let scanTimer = null;
  let busy = false;

  const VEILED = "[data-sup-state='hidden'],[data-sup-state='pending']";

  // Visible-first: an item's text is only sent to the classifier once the item
  // is within NEAR_PX of the viewport, so a slow (CPU) classifier isn't asked
  // to judge an entire infinite feed. Keyword/hint veils don't wait for this.
  const NEAR_PX = 1500;
  const near = new WeakSet();     // items currently within NEAR_PX of the viewport
  const watched = new WeakSet();  // items handed to the observer
  const nearObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        let added = false;
        for (const e of entries) {
          if (e.isIntersecting) { if (!near.has(e.target)) { near.add(e.target); added = true; } }
          else near.delete(e.target);
        }
        if (added) scheduleScan();
      }, { rootMargin: `${NEAR_PX}px 0px ${NEAR_PX}px 0px` })
    : null;

  function isNear(el) {
    if (!nearObserver) return true;
    if (!watched.has(el)) { watched.add(el); nearObserver.observe(el); }
    return near.has(el);
  }

  // ---- decisions ---------------------------------------------------------

  function evaluate(text) {
    const v = verdicts.get(text);
    const hits = [];
    const pend = [];
    for (const t of topics) {
      const r = v && v !== "error" ? v.r[t.id] : undefined;
      const offline = v === "error" || !!(v && v.errors && v.errors[t.id]);
      const d = Sup.decide(t, text, r, offline);
      if (!d) continue;
      (d.pending ? pend : hits).push(d);
    }
    if (hits.length) return { state: "hidden", hits };
    if (pend.length || (paranoid && v === undefined && topics.length)) return { state: "pending", hits: pend };
    return null;
  }

  // ---- DOM state ---------------------------------------------------------

  function apply(el, ev, kind) {
    if (el.dataset.supRevealed === "1") ev = null;
    const cur = el.dataset.supState;
    if (!ev) {
      if (cur === "hidden" || cur === "pending") {
        el.dataset.supState = "shown";
        delete el.dataset.supRender;
        SupVeil.remove(el, true);
      }
      return;
    }
    const sig = ev.state + "|" + ev.hits.map((d) =>
      d.topic.id + ":" + (d.reasons || []).map((r) => r.label + (r.p == null ? "" : r.p.toFixed(2))).join(",")).join(";");
    const present = SupVeil.hostOf(el) || el.dataset.supFallback === "1";
    if (cur === ev.state && el.dataset.supRender === sig && present) return;
    el.dataset.supState = ev.state;
    el.dataset.supRender = sig;
    SupVeil.render(el, { ...ev, kind });
    pauseMediaIn(el);
  }

  function pauseMediaIn(el) {
    el.querySelectorAll("video, audio").forEach((m) => { if (!m.paused) m.pause(); });
  }

  function textOf(el) {
    return (site.text(el) || "").replace(/\s+/g, " ").trim();
  }

  function need(text) {
    if (topics.length && !verdicts.has(text) && !queue.has(text) && !inflight.has(text)) enqueue(text);
  }

  function judge(el) {
    // Nested matches (e.g. a lockup inside a rich-item): judge only the outermost.
    if (el.parentElement && el.parentElement.closest(site.items)) return;
    const text = textOf(el);
    if (!text) return;
    if (el.dataset.supSig !== text) {
      el.dataset.supSig = text;
      delete el.dataset.supRevealed;
    }
    // Classify only near the viewport; evaluate() still veils keyword/hint
    // matches right away ("pending" until the classifier has answered).
    if (isNear(el)) need(text);
    apply(el, evaluate(text), "card");
  }

  // ---- page-level (the video being watched) -------------------------------

  let pageSig = "";
  function judgePage() {
    if (!site.pageTitle) return;
    const title = site.pageTitle();
    const player = site.player && document.querySelector(site.player);
    if (!title || !player) return;
    const extras = site.pageExtras ? [...document.querySelectorAll(site.pageExtras)] : [];
    if (title !== pageSig) {
      pageSig = title;
      for (const x of [player, ...extras]) delete x.dataset.supRevealed;
    }
    need(title);
    const ev = evaluate(title);
    apply(player, ev, "player");
    for (const x of extras) apply(x, ev, "mini");
  }

  function reveal(el) {
    el.dataset.supRevealed = "1";
    apply(el, null);
    if (site.player && el.matches(site.player) && site.pageExtras) {
      document.querySelectorAll(site.pageExtras).forEach((x) => { x.dataset.supRevealed = "1"; apply(x, null); });
    }
  }

  // ---- classification ----------------------------------------------------

  function enqueue(text) {
    queue.add(text);
    if (!flushTimer && !busy) flushTimer = setTimeout(flush, 80);
  }

  async function flush() {
    flushTimer = null;
    if (busy || !queue.size) return;
    busy = true;
    const texts = [...queue].slice(0, 64);
    texts.forEach((t) => { queue.delete(t); inflight.add(t); });
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "classify", texts });
    } catch (e) {
      res = { error: String(e) };
    }
    const ok = res && Array.isArray(res.results);
    texts.forEach((t, i) => {
      inflight.delete(t);
      verdicts.set(t, ok ? { r: res.results[i] || {}, errors: res.errors || {} } : "error");
    });
    busy = false;
    if (!ok) {
      // Server down: keyword hits stay veiled ("classifier offline"); retry later.
      setTimeout(() => {
        for (const [t, v] of verdicts) if (v === "error") verdicts.delete(t);
        scheduleScan();
      }, 15000);
    }
    if (queue.size) flushTimer = setTimeout(flush, 0);
    scheduleScan();
  }

  // ---- scanning ----------------------------------------------------------

  function scan() {
    scanTimer = null;
    if (!enabled) return;
    document.querySelectorAll(site.items).forEach(judge);
    judgePage();
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 50);
  }

  function resetAll() {
    document.querySelectorAll("[data-sup-state],[data-sup-revealed],[data-sup-fallback]").forEach((el) => {
      SupVeil.remove(el, false);
      for (const k of ["supState", "supRender", "supRevealed", "supFallback", "supLabel"]) delete el.dataset[k];
    });
  }

  // ---- interaction -------------------------------------------------------

  // Clicks anywhere on a veiled card never reach the page (no navigation).
  // Buttons inside the veil carry data-act; composedPath() sees into its open shadow root.
  document.addEventListener("click", (e) => {
    const path = e.composedPath();
    const card = path.find((n) => n instanceof Element && (n.dataset.supState === "hidden" || n.dataset.supState === "pending"));
    // Clicking anywhere else closes open detail panels.
    document.querySelectorAll("." + SupVeil.HOST_CLASS + "[data-open]").forEach((v) => {
      if (v.parentElement !== card) SupVeil.toggle(v.parentElement, false);
    });
    if (!card) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (card.dataset.supFallback === "1") {
      if (card.dataset.supState === "hidden") reveal(card);
      return;
    }
    const actEl = path.find((n) => n instanceof Element && n.dataset && n.dataset.act);
    const act = actEl ? actEl.dataset.act : "toggle";
    if (act === "reveal") reveal(card);
    else SupVeil.toggle(card);
  }, true);

  // No autoplay under a veil: swallow hover events over veiled items (YouTube's
  // inline preview starts on hover) and pause anything that plays inside one.
  let hoveringVeiled = false;
  for (const type of ["mouseover", "mouseenter", "mousemove", "pointerover", "pointerenter", "pointermove", "focusin"]) {
    window.addEventListener(type, (e) => {
      const veiled = e.target instanceof Element && e.target.closest(VEILED);
      if (type === "mouseover" || type === "pointerover") hoveringVeiled = !!veiled;
      if (veiled) e.stopImmediatePropagation();
    }, true);
  }
  document.addEventListener("play", (e) => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement)) return;
    const preview = hoveringVeiled && m.closest("#video-preview, ytd-video-preview, #inline-preview-player");
    if (m.closest(VEILED) || preview) m.pause();
  }, true);

  // ---- wiring ------------------------------------------------------------

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["title", "aria-label", "post-title"],
  });
  document.addEventListener("yt-navigate-finish", scheduleScan);

  function load(s) {
    enabled = s.enabled !== false;
    paranoid = !!s.paranoid;
    topics = (s.topics || []).filter((t) => t.enabled !== false && t.name).map(Sup.compileTopic);
  }

  browser.storage.local.get({ enabled: true, paranoid: false, topics: [] }).then((s) => {
    load(s);
    scheduleScan();
  });
  browser.storage.onChanged.addListener(async (changes) => {
    const s = await browser.storage.local.get({ enabled: true, paranoid: false, topics: [] });
    load(s);
    if (changes.topics) verdicts.clear();
    resetAll();
    scheduleScan();
  });
  scheduleScan();
})();
