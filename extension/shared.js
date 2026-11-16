// Shared by background.js, content.js and options.js.
//
// A topic (stored in browser.storage.local "topics"):
// {
//   id, name, enabled, color,
//   description,         // aliases, e.g. "GTA 6, Grand Theft Auto VI"
//   kind,                // what sort of thing it is, e.g. "video game" (sharpens topic matching)
//   keywords: [],        // always count as this topic; blurred instantly
//   hints: [],           // blurred instantly, but the classifier must agree it's on-topic
//   suppress: [],        // reasons to hide: "spoilers", "leaks", ... (empty = hide everything on-topic)
//   show: [],            // reasons that are fine to see: "news", "trailer", ...
//   matchThreshold,      // P(on-topic) needed when no keyword matched
//   suppressThreshold,   // sum of P(suppress reasons) needed to hide
// }

var Sup = (() => {
  const slug = (label) =>
    String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "x";

  const titleCase = (s) => String(s).replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

  const PALETTE = ["#ff5c8a", "#7c5cff", "#21b8a6", "#ff9f1c", "#3d9bff", "#e64980", "#2fbf71", "#c77dff"];

  function newTopic(existing = []) {
    return {
      id: "t" + Math.random().toString(36).slice(2, 9),
      name: "New topic",
      enabled: true,
      color: PALETTE[existing.length % PALETTE.length],
      description: "",
      kind: "",
      keywords: [],
      hints: [],
      suppress: ["spoilers"],
      show: ["news"],
      matchThreshold: 0.5,
      suppressThreshold: 0.4,
    };
  }

  // Topic (labels) -> server definition (meaningful keys + short descriptions for Laya).
  function resolveTopic(topic, library) {
    const categories = {};
    for (const label of [...(topic.suppress || []), ...(topic.show || [])]) {
      const key = slug(label);
      if (key === "other") continue;
      categories[key] = library[label.trim().toLowerCase()] || label.trim();
    }
    return {
      id: topic.id,
      name: topic.name.trim(),
      description: (topic.description || "").trim(),
      kind: (topic.kind || "").trim(),
      categories,
    };
  }

  // "GTA 6" -> /\bgta\s*[-_]?\s*6\b/i ; "/regex/" -> used as-is.
  function phraseRegex(phrase) {
    const p = String(phrase).trim();
    if (!p) return null;
    const m = p.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i"); } catch { return null; }
    }
    const body = p
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*[-_]?\\s*");
    const pre = /^\w/.test(p) ? "\\b" : "";
    const post = /\w$/.test(p) ? "\\b" : "";
    return new RegExp(pre + body + post, "i");
  }

  function compileTopic(topic) {
    return {
      ...topic,
      kw: (topic.keywords || []).map(phraseRegex).filter(Boolean),
      hn: (topic.hints || []).map(phraseRegex).filter(Boolean),
    };
  }

  const firstHit = (res, text) => {
    for (const re of res) {
      const m = text.match(re);
      if (m) return m[0];
    }
    return null;
  };

  /**
   * Decide what to do with `text` for one compiled topic.
   * r: {match, cats} from the classifier, or undefined (not classified yet / failed).
   * Returns null (not affected), {pending: true, ...} or {hide: true, reasons, ...}.
   */
  function decide(t, text, r, offline = false) {
    const keyword = firstHit(t.kw, text);
    const hint = keyword ? null : firstHit(t.hn, text);
    if (!r) {
      if (!keyword && !hint) return null;
      if (offline) {
        return { hide: true, topic: t, keyword: keyword || hint, offline: true,
                 reasons: [{ label: "keyword match", p: null }], score: null, match: null, shows: [] };
      }
      return { pending: true, topic: t, keyword: keyword || hint };
    }
    const onTopic =
      !!keyword || r.match >= t.matchThreshold || (!!hint && r.match >= t.matchThreshold - 0.2);
    if (!onTopic) return null;

    const sup = (t.suppress || []).map((l) => ({ label: l, p: r.cats[slug(l)] || 0 }));
    const shows = (t.show || []).map((l) => ({ label: l, p: r.cats[slug(l)] || 0 }));
    const score = sup.reduce((a, b) => a + b.p, 0);
    if (sup.length && score < t.suppressThreshold) return null;

    sup.sort((a, b) => b.p - a.p);
    shows.sort((a, b) => b.p - a.p);
    let reasons = sup.filter((x) => x.p >= 0.08);
    if (!reasons.length) reasons = sup.length ? sup.slice(0, 1) : [{ label: "everything", p: null }];
    return { hide: true, topic: t, keyword: keyword || hint, match: r.match, score, reasons, all: sup, shows };
  }

  // ---- classifier server ----------------------------------------------------

  const DEFAULT_SERVER = "http://127.0.0.1:8765";
  const SLOW_MS_PER_TITLE = 100;

  // "http://localhost:9000/" -> "http://localhost:9000"; anything that isn't a
  // local http address (the host permissions only cover these) -> null.
  function normalizeServer(input) {
    const m = String(input || "").trim().match(/^http:\/\/(127\.0\.0\.1|localhost)(?::(\d{1,5}))?\/?$/i);
    if (!m) return null;
    if (m[2] && (+m[2] < 1 || +m[2] > 65535)) return null;
    return `http://${m[1].toLowerCase()}${m[2] ? ":" + +m[2] : ""}`;
  }

  // /health response -> {ok, slow, text}. Newer servers add backend/ms_per_title/version.
  function describeHealth(r) {
    if (!r || !r.ok) return { ok: false, slow: false, text: "Classifier offline" };
    const ms = Number(r.ms_per_title);
    const known = r.ms_per_title != null && Number.isFinite(ms) && ms > 0;
    const parts = [r.device || "?"];
    if (known) parts.push(`~${Math.round(ms)} ms/title`);
    const slow = known && ms > SLOW_MS_PER_TITLE;
    const detail = parts.join(", ");
    return { ok: true, slow, detail, text: `Classifier running (${detail})` + (slow ? " · slow" : "") };
  }

  return { slug, titleCase, newTopic, resolveTopic, compileTopic, phraseRegex, decide, PALETTE,
           DEFAULT_SERVER, normalizeServer, describeHealth };
})();
