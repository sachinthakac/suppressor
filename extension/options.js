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
    values: t.suppress, onChange: () => { changed(); showField.repaint(); }, cls: "hide",
    placeholder: "Add a reason to hide…",
    suggestions: () => allLabels().filter((l) => !t.show.includes(l)),
  });
  const showField = chipField({
    values: t.show, onChange: () => { changed(); hideField.repaint(); }, cls: "show",
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
      h("input", {
        class: "name", value: t.name, "aria-label": "Topic name",
        oninput: (e) => { t.name = e.target.value; changed(); },
      }),
      h("label", { class: "toggle", title: "Enable this topic" },
        h("input", {
          type: "checkbox", checked: t.enabled !== false,
          onchange: (e) => { t.enabled = e.target.checked; card.classList.toggle("off", !t.enabled); save(); },
        }),
        h("span"), "On"),
      h("button", {
        class: "icon-btn", title: "Delete topic", "aria-label": `Delete ${t.name}`,
        onclick: () => {
          if (!confirm(`Delete “${t.name}”?`)) return;
          topics = topics.filter((x) => x !== t);
          card.remove();
          save();
        },
      }, svg(ICON_TRASH))),
    h("div", { class: "topic-body" },
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
      h("div", { class: "full" }, warn)));
  validate();
  return card;
}

function renderAll() {
  $("topics").replaceChildren(...topics.map(topicCard));
}

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

browser.runtime.sendMessage({ type: "health" }).then((r) => {
  const s = $("status");
  s.className = "status " + (r && r.ok ? "ok" : "bad");
  s.lastChild.textContent = r && r.ok ? `Classifier running (${r.device || "?"})` : "Classifier offline";
});

load();
