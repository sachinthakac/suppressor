// Options page: edit topics, their keywords and their hide/show reasons.
// State lives in browser.storage.local ("topics"); every edit saves (debounced).

const $ = (id) => document.getElementById(id);
let topics = [];
let library = {};
let lastSaved = "";

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "style") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function svg(d) {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  s.append(p);
  return s;
}
const ICON_X = "M6 6l12 12M18 6L6 18";
const ICON_CHEVRON = "M6 9l6 6 6-6";
const ICON_EXPORT = "M12 4v11M7 10l5 5 5-5M5 20h14";
const ICON_TRASH = "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3";

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const save = debounce(async () => {
  lastSaved = JSON.stringify(topics);
  await browser.storage.local.set({ topics });
}, 300);

// ---- chip input ------------------------------------------------------------

function chipField({ values, onChange, placeholder, suggestions, cls }) {
  const input = h("input", { type: "text", placeholder, "aria-label": placeholder });
  const box = h("div", { class: "chips", onclick: () => input.focus() });
  const sug = h("div", { class: "suggest" });

  function add(raw) {
    for (const part of String(raw).split(",")) {
      const v = part.trim();
      if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) values.push(v);
    }
    paint();
    onChange();
  }

  function paint() {
    box.replaceChildren(
      ...values.map((v, i) =>
        h("span", { class: "chip" }, v,
          h("button", {
            type: "button", "aria-label": `Remove ${v}`,
            onclick: (e) => { e.stopPropagation(); values.splice(i, 1); paint(); onChange(); },
          }, svg(ICON_X)))),
      input);
    if (suggestions) {
      const opts = suggestions().filter((s) => !values.some((v) => v.toLowerCase() === s)).slice(0, 14);
      sug.replaceChildren(...opts.map((s) =>
        h("button", { type: "button", title: library[s] || "", onclick: () => add(s) }, "+ " + s)));
    }
  }

  input.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === ",") && input.value.trim()) {
      e.preventDefault();
      add(input.value);
      input.value = "";
    } else if (e.key === "Backspace" && !input.value && values.length) {
      values.pop();
      paint();
      onChange();
    }
  });
  input.addEventListener("blur", () => { if (input.value.trim()) { add(input.value); input.value = ""; } });

  paint();
  const wrap = h("div", { class: cls || "" }, box, suggestions ? sug : null);
  wrap.repaint = paint;
  return wrap;
}

// ---- collapsed cards (per-browser convenience, so localStorage is fine) -------

const COLLAPSED_KEY = "sup-collapsed";
function collapsedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]")); } catch { return new Set(); }
}
function setCollapsed(id, on) {
  const ids = collapsedIds();
  if (on) ids.add(id); else ids.delete(id);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids])); } catch {}
}

function summaryText(t) {
  const list = (a) => (a.length > 4 ? a.slice(0, 4).join(", ") + ` +${a.length - 4}` : a.join(", "));
  const hide = t.suppress.length ? `Hides ${list(t.suppress)}` : "Hides everything";
  return t.show.length ? `${hide} · Shows ${list(t.show)}` : hide;
}

// ---- topic card --------------------------------------------------------------

function field(label, control, hint, full) {
  return h("div", { class: "field" + (full ? " full" : "") },
    h("div", { class: "flabel" }, label), control, hint ? h("small", {}, hint) : null);
}

function slider(t, key, label, hint) {
  const out = h("output", {}, Math.round(t[key] * 100) + "%");
  const input = h("input", {
    type: "range", min: "0.2", max: "0.9", step: "0.05", value: String(t[key]), "aria-label": label,
    oninput: (e) => { t[key] = Number(e.target.value); out.value = Math.round(t[key] * 100) + "%"; save(); },
  });
  return field(label, h("div", { class: "slider" }, input, out), hint);
}

function topicCard(t) {
  const card = h("section", { class: "topic" + (t.enabled === false ? " off" : "") });
  card.style.setProperty("--accent", t.color);
  const bodyId = `body-${t.id}`;
  const summary = h("div", { class: "summary" });
  const updateSummary = () => { summary.textContent = summaryText(t); summary.title = summary.textContent; };
  updateSummary();
  const warn = h("div", { class: "warn", role: "status" });

  const validate = debounce(async () => {
    const r = await browser.runtime.sendMessage({ type: "validate", topic: t });
    warn.textContent = r && r.ok === false && !/NetworkError|fetch/i.test(r.error || "")
      ? `The classifier can't use this topic yet: ${r.error}. Try fewer or shorter reasons.`
      : "";
  }, 700);
  const changed = () => { save(); validate(); };

  const allLabels = () => Object.keys(library);
  const hideField = chipField({
    values: t.suppress, onChange: () => { changed(); showField.repaint(); updateSummary(); }, cls: "hide",
    placeholder: "Add a reason to hide…",
    suggestions: () => allLabels().filter((l) => !t.show.includes(l)),
  });
  const showField = chipField({
    values: t.show, onChange: () => { changed(); hideField.repaint(); updateSummary(); }, cls: "show",
    placeholder: "Add a reason to show…",
    suggestions: () => allLabels().filter((l) => !t.suppress.includes(l)),
  });

  // test box
  const testInput = h("input", { class: "text", type: "text", placeholder: "Try a title, e.g. “GTA 6 ending explained”" });
  const result = h("div", { class: "result", "aria-live": "polite" });
  const runTest = async () => {
    const text = testInput.value.trim();
    if (!text) return;
    result.textContent = "Checking…";
    const res = await browser.runtime.sendMessage({ type: "classify", texts: [text], topic: t });
    const r = res && res.results && res.results[0] && res.results[0][t.id];
    if (!r) {
      result.textContent = (res && res.errors && res.errors[t.id]) || (res && res.error) || "No answer from the classifier.";
      return;
    }
    const d = Sup.decide(Sup.compileTopic(t), text, r);
    const bars = [];
    const row = (label, p, cls) => bars.push(
      h("span", {}, label),
      h("span", { class: "track" }, h("span", { class: "fill " + cls, style: { display: "block", width: Math.max(2, p * 100) + "%" } })),
      h("span", { class: "pct" }, Math.round(p * 100) + "%"));
    row(`About ${t.name}`, r.match, "m");
    const cats = [...t.suppress.map((l) => [l, "h"]), ...t.show.map((l) => [l, "s"])]
      .map(([l, c]) => [l, r.cats[Sup.slug(l)] || 0, c]).sort((a, b) => b[1] - a[1]);
    for (const [l, p, c] of cats) row(Sup.titleCase(l), p, c);
    if (r.cats.other != null) row("Other", r.cats.other, "");
    result.replaceChildren(
      d && d.hide
        ? h("span", { class: "verdict hidden" }, "Hidden · " + d.reasons.map((x) => Sup.titleCase(x.label)).join(", "))
        : h("span", { class: "verdict shown" }, "Shown"),
      h("div", { class: "bars" }, bars));
  };
  testInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runTest(); });

  card.append(
    h("div", { class: "topic-head" },
      h("label", { class: "swatch", title: "Colour" },
        h("input", {
          type: "color", value: t.color, "aria-label": "Topic colour",
          oninput: (e) => { t.color = e.target.value; card.style.setProperty("--accent", t.color); save(); },
        })),
      h("div", { class: "title" },
        h("input", {
          class: "name", value: t.name, "aria-label": "Topic name",
          oninput: (e) => { t.name = e.target.value; changed(); },
        }),
        summary),
      h("label", { class: "toggle", title: "Enable this topic" },
        h("input", {
          type: "checkbox", checked: t.enabled !== false,
          onchange: (e) => { t.enabled = e.target.checked; card.classList.toggle("off", !t.enabled); save(); },
        }),
        h("span"), "On"),
      h("button", {
        class: "icon-btn", title: "Export this topic", "aria-label": `Export ${t.name}`,
        onclick: () => download(`suppressor-${Sup.slug(t.name)}.json`, exportData([t], false)),
      }, svg(ICON_EXPORT)),
      h("button", {
        class: "icon-btn", title: "Delete topic", "aria-label": `Delete ${t.name}`,
        onclick: () => {
          if (!confirm(`Delete “${t.name}”?`)) return;
          topics = topics.filter((x) => x !== t);
          card.remove();
          save();
        },
      }, svg(ICON_TRASH)),
      h("button", {
        class: "icon-btn chev-btn", title: "Collapse", "aria-label": `Collapse ${t.name}`,
        "aria-expanded": "true", "aria-controls": bodyId,
        onclick: () => setOpen(card.classList.contains("collapsed")),
      }, svg(ICON_CHEVRON))),
    h("div", { class: "collapse", id: bodyId }, h("div", { class: "collapse-inner" }, h("div", { class: "topic-body" },
      field("Also known as",
        h("input", { class: "text", value: t.description || "", placeholder: "e.g. GTA 6, Grand Theft Auto VI",
          oninput: (e) => { t.description = e.target.value; changed(); } }),
        "Other names the classifier should recognise."),
      field("Kind of thing",
        h("input", { class: "text", value: t.kind || "", list: "kinds", placeholder: "e.g. video game, TV show",
          oninput: (e) => { t.kind = e.target.value; changed(); } }),
        "Helps tell it apart from similar things (other games, other shows)."),
      field("Keywords", chipField({ values: t.keywords, onChange: save, placeholder: "Add a keyword…" }),
        "Always count as this topic. Blurred instantly."),
      field("Hints", chipField({ values: t.hints, onChange: save, placeholder: "Add a hint…" }),
        "Blurred instantly, but only kept hidden if the classifier agrees."),
      field("Hide when it's about", hideField,
        "Leave empty to hide everything about this topic.", true),
      field("Always show", showField,
        "Things that are fine to see. These also help the classifier tell them apart from the reasons to hide.", true),
      slider(t, "matchThreshold", "Topic match needed", "How sure the classifier must be when no keyword matched."),
      slider(t, "suppressThreshold", "Hide when reasons reach", "Lower hides more. Higher shows more."),
      h("div", { class: "field full" },
        h("div", { class: "flabel" }, "Test it"),
        h("div", { class: "test" },
          h("div", { class: "test-row" }, testInput, h("button", { class: "btn", type: "button", onclick: runTest }, "Check")),
          result)),
      h("div", { class: "full" }, warn)))));

  const chevBtn = card.querySelector(".chev-btn");
  const inner = card.querySelector(".collapse-inner");
  function setOpen(open) {
    card.classList.toggle("collapsed", !open);
    inner.inert = !open;
    chevBtn.setAttribute("aria-expanded", String(open));
    chevBtn.title = open ? "Collapse" : "Expand";
    chevBtn.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${t.name}`);
    setCollapsed(t.id, !open);
  }
  // Clicking empty space in the header toggles too (not the name, switch or buttons).
  card.querySelector(".topic-head").addEventListener("click", (e) => {
    if (e.target.closest("input, button, label")) return;
    setOpen(card.classList.contains("collapsed"));
  });
  setOpen(!collapsedIds().has(t.id));

  validate();
  return card;
}

function renderAll() {
  $("topics").replaceChildren(...topics.map(topicCard));
}

// ---- export / import ---------------------------------------------------------

function toast(msg, error) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast show" + (error ? " error" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = "toast" + (error ? " error" : "")), 4000);
}

function exportData(list, withSettings) {
  const data = { app: "suppressor", version: 1, exported: new Date().toISOString(), topics: list };
  if (withSettings) data.settings = { enabled: $("enabled").checked, paranoid: $("paranoid").checked };
  return JSON.stringify(data, null, 2);
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Accepts a full export, a bare array of topics, or a single topic. Untrusted: clean every field.
function parseImport(text) {
  const data = JSON.parse(text);
  const raw = Array.isArray(data) ? data : Array.isArray(data.topics) ? data.topics : data && data.name ? [data] : null;
  if (!raw) throw new Error("No topics found in this file.");
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const list = (v) => (Array.isArray(v) ? v : [])
    .filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 80)).slice(0, 50);
  const num = (v, d) => (typeof v === "number" && v >= 0 && v <= 1 ? v : d);
  const out = raw.map((t, i) => {
    if (!t || typeof t !== "object" || !str(t.name, 120)) return null;
    const base = Sup.newTopic();
    return {
      id: typeof t.id === "string" && /^[\w-]{1,40}$/.test(t.id) ? t.id : base.id,
      name: str(t.name, 120),
      enabled: t.enabled !== false,
      color: typeof t.color === "string" && /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : Sup.PALETTE[(topics.length + i) % Sup.PALETTE.length],
      description: str(t.description, 300),
      kind: str(t.kind, 60),
      keywords: list(t.keywords),
      hints: list(t.hints),
      suppress: list(t.suppress),
      show: list(t.show),
      matchThreshold: num(t.matchThreshold, base.matchThreshold),
      suppressThreshold: num(t.suppressThreshold, base.suppressThreshold),
    };
  }).filter(Boolean);
  if (!out.length) throw new Error("No valid topics found in this file.");
  const settings = data && typeof data.settings === "object" && data.settings ? data.settings : null;
  return { topics: out, settings };
}

$("export").addEventListener("click", () => {
  const day = new Date().toISOString().slice(0, 10);
  download(`suppressor-settings-${day}.json`, exportData(topics, true));
  toast(`Exported ${topics.length} topic${topics.length === 1 ? "" : "s"}.`);
});

$("import").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let parsed;
  try {
    if (file.size > 1_000_000) throw new Error("File is too large.");
    parsed = parseImport(await file.text());
  } catch (err) {
    toast(`Couldn't import: ${err.message}`, true);
    return;
  }
  const replacing = parsed.topics.filter((t) => topics.some((x) => x.id === t.id));
  const adding = parsed.topics.length - replacing.length;
  const parts = [];
  if (adding) parts.push(`add ${adding} new topic${adding === 1 ? "" : "s"}`);
  if (replacing.length) parts.push(`replace ${replacing.map((t) => `“${t.name}”`).join(", ")}`);
  if (!confirm(`Import from ${file.name}?\n\nThis will ${parts.join(" and ")}. Other topics are kept.`)) return;

  const merged = topics.map((x) => parsed.topics.find((t) => t.id === x.id) || x);
  for (const t of parsed.topics) if (!merged.some((x) => x.id === t.id)) merged.push(t);
  const update = { topics: merged };
  if (parsed.settings) {
    if (typeof parsed.settings.enabled === "boolean") update.enabled = parsed.settings.enabled;
    if (typeof parsed.settings.paranoid === "boolean") update.paranoid = parsed.settings.paranoid;
  }
  await browser.storage.local.set(update);
  await load();
  toast(`Imported ${parsed.topics.length} topic${parsed.topics.length === 1 ? "" : "s"}.`);
});

// ---- boot ------------------------------------------------------------------

async function load() {
  const d = await browser.runtime.sendMessage({ type: "defaults" });
  library = (d && d.categories) || {};
  const s = await browser.storage.local.get({ enabled: true, paranoid: false, topics: [] });
  topics = s.topics.map((t) => ({ keywords: [], hints: [], suppress: [], show: [], ...t }));
  lastSaved = JSON.stringify(topics);
  $("enabled").checked = s.enabled;
  $("paranoid").checked = s.paranoid;
  renderAll();
}

$("enabled").addEventListener("change", (e) => browser.storage.local.set({ enabled: e.target.checked }));
$("paranoid").addEventListener("change", (e) => browser.storage.local.set({ paranoid: e.target.checked }));
$("add").addEventListener("click", () => {
  const t = Sup.newTopic(topics);
  topics.push(t);
  const card = topicCard(t);
  $("topics").append(card);
  card.querySelector(".name").select();
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  save();
});

// Changes made elsewhere (popup toggles) - reload unless they're our own save.
browser.storage.onChanged.addListener((changes) => {
  if (changes.topics && JSON.stringify(changes.topics.newValue) !== lastSaved) load();
  if (changes.enabled) $("enabled").checked = changes.enabled.newValue;
  if (changes.paranoid) $("paranoid").checked = changes.paranoid.newValue;
});

// ---- classifier status + address (Advanced) ----------------------------------

const health = (server) =>
  browser.runtime.sendMessage(server == null ? { type: "health" } : { type: "health", server }).catch((e) => ({ ok: false, error: String(e) }));

function showStatus(r) {
  const s = $("status");
  const hs = Sup.describeHealth(r);
  s.className = "status " + (hs.ok ? (hs.slow ? "ok slow" : "ok") : "bad");
  s.querySelector("span").textContent = hs.text;
  s.title = hs.slow ? "Classification is slow on this machine. Only items near the screen are checked." : "";
}
const refreshStatus = () => health().then(showStatus);

const serverInput = $("server");
function serverValue() {
  const raw = serverInput.value.trim();
  return raw ? Sup.normalizeServer(raw) : Sup.DEFAULT_SERVER;
}
function markServer() {
  const ok = !!serverValue();
  serverInput.classList.toggle("invalid", !ok);
  serverInput.setAttribute("aria-invalid", String(!ok));
  return ok;
}
function serverResult(cls, label, detail) {
  $("serverResult").replaceChildren(
    h("span", { class: "conn " + cls }, label),
    detail ? h("span", { class: "conn-detail" }, detail) : null);
}

async function saveServer() {
  if (!markServer()) {
    serverResult("bad", "Not saved", "Use http://127.0.0.1 or http://localhost, optionally with a port, e.g. http://127.0.0.1:8765");
    return;
  }
  const value = serverValue();
  const { server } = await browser.storage.local.get({ server: Sup.DEFAULT_SERVER });
  if (serverInput.value.trim()) serverInput.value = value;
  if (server === value) return;
  if (value === Sup.DEFAULT_SERVER) await browser.storage.local.remove("server");
  else await browser.storage.local.set({ server: value });
  toast(`Classifier address set to ${value}`);
  refreshStatus();
}

serverInput.addEventListener("input", () => { markServer(); $("serverResult").replaceChildren(); });
serverInput.addEventListener("change", saveServer);
serverInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveServer(); } });

$("testServer").addEventListener("click", async () => {
  const value = serverValue();
  if (!markServer()) {
    serverResult("bad", "Invalid address", "Use http://127.0.0.1 or http://localhost, optionally with a port.");
    return;
  }
  const btn = $("testServer");
  btn.disabled = true;
  serverResult("", "Testing…");
  const r = await health(value);
  btn.disabled = false;
  const hs = Sup.describeHealth(r);
  if (hs.ok) {
    const extra = [r.backend && `backend ${r.backend}`, r.version && `server ${r.version}`].filter(Boolean).join(" · ");
    serverResult(hs.slow ? "slow" : "ok", hs.text.replace("Classifier running", "Connected"),
      [`${value}/health`, extra, hs.slow ? "Slow: only items near the screen are classified." : ""].filter(Boolean).join(" · "));
  } else {
    serverResult("bad", "No classifier at " + value,
      r && r.error ? r.error.replace(/^\w*Error:\s*/, "") : "Is the server running? See the setup guide.");
  }
});

browser.storage.local.get({ server: Sup.DEFAULT_SERVER }).then(({ server }) => {
  serverInput.value = Sup.normalizeServer(server) || Sup.DEFAULT_SERVER;
  if (serverInput.value !== Sup.DEFAULT_SERVER) $("advanced").open = true;
});
refreshStatus();
// Topic cards render asynchronously; jump to #advanced (welcome page link) once they're in.
load().then(() => {
  if (location.hash !== "#advanced") return;
  $("advanced").open = true;
  $("advanced").scrollIntoView({ block: "start" });
});
