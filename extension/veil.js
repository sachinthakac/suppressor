// The veil: a frosted-glass overlay with an expandable pill, injected into a
// hidden card. Lives in its own (open) shadow root so page CSS can't touch it.
// Clicks are handled by content.js via event.composedPath() and data-act.
//
// Hosts that render children through shadow-DOM slots (e.g. Reddit's
// <shreddit-post>) never show an injected child; for those we fall back to
// CSS pseudo-elements (see content.css, [data-sup-fallback]).

var SupVeil = (() => {
  const HOST_CLASS = "sup-veil";

  // No innerHTML anywhere: YouTube enforces Trusted Types, so build nodes directly.
  const PATH_EYE_OFF =
    "M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5.1-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2";
  const PATH_CHEVRON = "M6 9l6 6 6-6";

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "style") Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
    return el;
  }

  function icon(d) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    for (const [k, v] of Object.entries({ d, fill: "none", stroke: "currentColor", "stroke-width": "2.2",
      "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(k, v);
    svg.append(path);
    return svg;
  }

  const CSS = `
  :host {
    all: initial;
    position: absolute !important;
    inset: 0 !important;
    z-index: 2147483000 !important;
    display: block !important;
    pointer-events: auto !important;
    cursor: default;
    --accent: #ff5c8a;
    --fg: #f6f6f8;
    --fg-dim: rgba(246, 246, 248, 0.66);
    --fg-faint: rgba(246, 246, 248, 0.42);
    --panel: rgba(20, 20, 24, 0.74);
    --line: rgba(255, 255, 255, 0.13);
    --feather: 10px;
    font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--fg);
    transition: opacity 320ms ease;
  }
  :host([data-leaving]) { opacity: 0; pointer-events: none !important; }

  /* --- glass: one surface over the whole card, edges feathered into the page --- */
  .glass {
    position: absolute;
    inset: calc(var(--feather) * -1);
    border-radius: calc(16px + var(--feather));
    backdrop-filter: blur(11px) saturate(1.15) brightness(0.5);
    background:
      linear-gradient(110deg, transparent 35%, rgba(255,255,255,0.10) 50%, transparent 65%) 200% 0 / 250% 100% no-repeat,
      radial-gradient(120% 140% at 50% 50%, rgba(10,10,14,0.10), rgba(10,10,14,0.35));
    mask-image:
      linear-gradient(to right, transparent, #000 var(--feather), #000 calc(100% - var(--feather)), transparent),
      linear-gradient(to bottom, transparent, #000 var(--feather), #000 calc(100% - var(--feather)), transparent);
    mask-composite: intersect;
  }
  :host([data-kind="player"]) .glass {
    inset: 0; border-radius: 0; mask-image: none;
    backdrop-filter: blur(18px) brightness(0.35);
    background: rgba(8, 8, 10, 0.6);
  }
  :host([data-state="pending"]) .glass { animation: sheen 1.8s ease-in-out infinite; }
  @keyframes sheen {
    from { background-position: 200% 0, 0 0; }
    to   { background-position: -100% 0, 0 0; }
  }

  /* --- panel: a pill that expands into a card --- */
  .panel {
    position: absolute;
    left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: max-content;
    max-width: calc(100% - 20px);
    max-height: calc(100% - 16px);
    display: flex; flex-direction: column;
    background: var(--panel);
    backdrop-filter: blur(16px) saturate(1.4);
    border: 1px solid var(--line);
    border-radius: 26px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06);
    overflow: hidden;
    transition: border-radius 220ms ease, width 220ms ease;
  }
  :host([data-kind="mini"]) .panel { display: none; }
  :host([data-open]) .panel { border-radius: 18px; width: min(340px, calc(100% - 20px)); max-height: none; }

  .head {
    all: unset;
    box-sizing: border-box;
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px 8px 8px;
    min-width: 0;
    cursor: pointer;
    border-radius: inherit;
  }
  .head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  :host([data-state="pending"]) .head { cursor: default; padding-right: 16px; }

  .badge {
    flex: none;
    width: 30px; height: 30px; border-radius: 50%;
    display: grid; place-items: center;
    color: #fff;
    background: linear-gradient(140deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #000));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .badge svg { width: 17px; height: 17px; }
  :host([data-state="pending"]) .badge {
    background: none; box-shadow: none;
    border: 2.5px solid color-mix(in srgb, var(--accent) 25%, transparent);
    border-top-color: var(--accent);
    width: 22px; height: 22px; margin: 4px;
    animation: spin 0.8s linear infinite;
  }
  :host([data-state="pending"]) .badge svg { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .topic { font-weight: 650; font-size: 14px; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topic small { font-weight: 500; color: var(--fg-faint); font-size: 12px; margin-left: 4px; }
  .reasons { color: var(--fg-dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chev { flex: none; width: 18px; height: 18px; color: var(--fg-dim); margin-left: 2px; transition: transform 220ms ease; }
  :host([data-open]) .chev { transform: rotate(180deg); }
  :host([data-state="pending"]) .chev { display: none; }

  /* --- expandable body --- */
  .body { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 240ms ease; }
  :host([data-open]) .body { grid-template-rows: 1fr; }
  /* width:0 + min-width:100% keeps the (hidden) details from widening the collapsed pill. */
  .inner { min-height: 0; overflow: auto; width: 0; min-width: 100%; }
  .content { padding: 4px 14px 14px; border-top: 1px solid var(--line); margin-top: 2px; }

  .section { margin-top: 10px; }
  .label { font-size: 10.5px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-faint); margin-bottom: 6px; }
  .topicrow { margin-top: 10px; }
  .bar { display: grid; grid-template-columns: minmax(70px, auto) 1fr 34px; align-items: center; gap: 8px; margin: 5px 0; font-size: 12.5px; }
  .bar .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .track { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.09); overflow: hidden; }
  .bar .fill { height: 100%; border-radius: 3px; background: var(--accent); }
  .bar.ok .fill { background: #3ccf8e; }
  .bar .pct { text-align: right; color: var(--fg-dim); font-variant-numeric: tabular-nums; }
  .note { font-size: 12px; color: var(--fg-dim); margin-top: 8px; }
  .note b { color: var(--fg); font-weight: 600; }

  /* Side by side when there's room; each button takes a full row when there isn't. */
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .btn {
    all: unset; box-sizing: border-box; cursor: pointer;
    flex: 1 1 auto; text-align: center; white-space: nowrap;
    padding: 7px 14px; border-radius: 999px; font-weight: 600; font-size: 12.5px;
    border: 1px solid var(--line); color: var(--fg);
  }
  .btn.primary { background: var(--fg); color: #111; border-color: transparent; }
  .btn:hover { filter: brightness(1.1); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    :host, .panel, .body, .chev { transition: none; }
    :host([data-state="pending"]) .glass { animation: none; }
    :host([data-state="pending"]) .badge { animation-duration: 2.4s; }
  }`;

  const pct = (p) => (p == null ? "" : `${Math.round(p * 100)}%`);
  const nice = (l) => Sup.titleCase(l);

  function hostOf(el) {
    for (const c of el.children) if (c.classList && c.classList.contains(HOST_CLASS)) return c;
    return null;
  }

  function ensure(el, kind) {
    let host = hostOf(el);
    if (host) {
      host.removeAttribute("data-leaving");
      clearTimeout(host.supTimer);
      return host;
    }
    if (el.dataset.supFallback === "1") return null;
    host = document.createElement("div");
    host.className = HOST_CLASS;
    host.dataset.kind = kind || "card";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(
      style,
      h("div", { class: "glass" }),
      h("div", { class: "panel", role: "group" },
        h("button", { class: "head", "data-act": "toggle", "aria-expanded": "false" },
          h("span", { class: "badge" }, icon(PATH_EYE_OFF)),
          h("span", { class: "txt" }, h("span", { class: "topic" }), h("span", { class: "reasons" })),
          h("span", { class: "chev" }, icon(PATH_CHEVRON))),
        h("div", { class: "body" }, h("div", { class: "inner" }, h("div", { class: "content" })))));
    el.appendChild(host);
    // Not rendered (slotted shadow host)? Use the CSS fallback instead.
    if (!host.getClientRects().length && el.getClientRects().length) {
      host.remove();
      el.dataset.supFallback = "1";
      return null;
    }
    return host;
  }

  // model: {state: "pending"|"hidden", hits: [decision...], kind}
  function render(el, model) {
    const first = model.hits[0];
    const topicName = first ? first.topic.name : "Suppressor";
    const reasons = model.state === "pending"
      ? "Checking…"
      : uniq(model.hits.flatMap((h) => h.reasons.map((r) => nice(r.label)))).join(" · ");
    el.dataset.supLabel = `${topicName}\n${reasons}`;
    const host = ensure(el, model.kind);
    if (!host) return;
    const root = host.shadowRoot;
    host.dataset.state = model.state;
    host.style.setProperty("--accent", (first && first.topic.color) || "#ff5c8a");
    root.querySelector(".topic").replaceChildren(
      topicName, model.hits.length > 1 ? h("small", {}, `+${model.hits.length - 1}`) : "");
    root.querySelector(".reasons").textContent = reasons;
    root.querySelector(".head").setAttribute("aria-label",
      model.state === "pending" ? `Checking ${topicName}` : `Hidden: ${topicName}, ${reasons}. Show details`);
    root.querySelector(".content").replaceChildren(...(model.state === "pending" ? [] : details(model.hits)));
  }

  function details(hits) {
    const blocks = hits.map((hit, i) => {
      const bars = (hit.all && hit.all.length ? hit.all : hit.reasons)
        .filter((r, j) => j < 5 && (r.p == null || r.p >= 0.02))
        .map((r) => bar(r.label, r.p));
      const ok = (hit.shows || []).filter((r, j) => j < 3 && r.p >= 0.02).map((r) => bar(r.label, r.p, true));
      const why = hit.offline
        ? ["Classifier offline. Hidden because it mentions ", h("b", {}, hit.keyword), "."]
        : hit.keyword
          ? ["Mentions ", h("b", {}, hit.keyword), ` · topic match ${pct(hit.match)}`]
          : [`Topic match ${pct(hit.match)}`];
      return h("div", { class: i ? "topicrow" : null },
        hits.length > 1 ? h("div", { class: "label", style: { color: hit.topic.color || "" } }, hit.topic.name) : null,
        bars.length ? h("div", { class: "section" }, h("div", { class: "label" }, "Hidden for"), bars) : null,
        ok.length ? h("div", { class: "section" }, h("div", { class: "label" }, "Allowed"), ok) : null,
        h("div", { class: "note" }, why));
    });
    return [...blocks,
      h("div", { class: "actions" },
        h("button", { class: "btn primary", "data-act": "reveal" }, "Show anyway"),
        h("button", { class: "btn", "data-act": "toggle" }, "Keep hidden"))];
  }

  function bar(label, p, ok) {
    const w = p == null ? 100 : Math.max(2, Math.round(p * 100));
    return h("div", { class: ok ? "bar ok" : "bar" },
      h("span", { class: "name" }, nice(label)),
      h("span", { class: "track" }, h("span", { class: "fill", style: { display: "block", width: `${w}%` } })),
      h("span", { class: "pct" }, pct(p)));
  }

  const uniq = (a) => [...new Set(a)];

  function toggle(el, force) {
    const host = hostOf(el);
    if (!host || host.dataset.state === "pending") return;
    const open = force ?? !host.hasAttribute("data-open");
    host.toggleAttribute("data-open", open);
    // An open panel may be taller than its card: lift the card above its neighbours.
    el.style.zIndex = open ? "2147483001" : "";
    host.shadowRoot.querySelector(".head").setAttribute("aria-expanded", String(open));
  }

  function remove(el, animate) {
    delete el.dataset.supLabel;
    const host = hostOf(el);
    if (!host) return;
    el.style.zIndex = "";
    if (!animate) { host.remove(); return; }
    host.setAttribute("data-leaving", "");
    clearTimeout(host.supTimer);
    host.supTimer = setTimeout(() => host.isConnected && host.hasAttribute("data-leaving") && host.remove(), 340);
  }

  return { ensure, render, toggle, remove, hostOf, HOST_CLASS };
})();
