// Owns the topic config and talks to the local Laya server on behalf of
// content scripts and the options page (content scripts cannot fetch
// 127.0.0.1 cross-origin under MV3).

const CACHE_MAX = 8000;
const cache = new Map(); // `${sig}\0${text}` -> {match, cats}
let defaultsPromise = null;

function defaults() {
  if (!defaultsPromise) {
    defaultsPromise = fetch(browser.runtime.getURL("defaults.json")).then((r) => r.json());
  }
  return defaultsPromise;
}

async function seed() {
  const { topics } = await browser.storage.local.get("topics");
  if (!Array.isArray(topics)) {
    const d = await defaults();
    await browser.storage.local.set({
      topics: d.topics.map((t, i) => ({ color: Sup.PALETTE[i % Sup.PALETTE.length], ...t })),
    });
  }
}
browser.runtime.onInstalled.addListener((details) => {
  seed();
  if (details.reason === "install") browser.tabs.create({ url: browser.runtime.getURL("welcome.html") });
});
browser.runtime.onStartup.addListener(seed);
seed();

async function serverUrl() {
  const { server } = await browser.storage.local.get({ server: Sup.DEFAULT_SERVER });
  return Sup.normalizeServer(server) || Sup.DEFAULT_SERVER;
}

// msg.server lets the options page test an address before saving it.
async function health(server) {
  const base = server == null ? await serverUrl() : Sup.normalizeServer(server);
  if (!base) return { ok: false, error: "Use http://127.0.0.1 or http://localhost, with an optional port" };
  const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000), cache: "no-store" });
  if (!r.ok) return { ok: false, error: `server ${r.status}` };
  return await r.json();
}

async function post(path, body) {
  const resp = await fetch(`${await serverUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`server ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

async function enabledDefs(onlyTopic) {
  const d = await defaults();
  let topics;
  if (onlyTopic) topics = [onlyTopic];
  else ({ topics = [] } = await browser.storage.local.get("topics"));
  return topics
    .filter((t) => onlyTopic || t.enabled !== false)
    .filter((t) => t.name && t.name.trim())
    .map((t) => Sup.resolveTopic(t, d.categories));
}

const sigOf = (def) => JSON.stringify([def.name, def.description, def.kind, def.categories]);

// -> {results: [{topicId: {match, cats}}], errors: {topicId: msg}}
async function classify(texts, onlyTopic) {
  const defs = await enabledDefs(onlyTopic);
  const results = texts.map(() => ({}));
  const errors = {};
  const need = []; // [def, [textIdx...]]
  for (const def of defs) {
    const sig = sigOf(def);
    const missing = [];
    texts.forEach((t, i) => {
      const hit = cache.get(`${sig}\0${t}`);
      if (hit) results[i][def.id] = hit;
      else missing.push(i);
    });
    if (missing.length) need.push([def, missing]);
  }
  if (need.length) {
    // One request: every topic that has misses, over the union of missing texts.
    const idx = [...new Set(need.flatMap(([, m]) => m))].sort((a, b) => a - b);
    const data = await post("/classify", { topics: need.map(([d]) => d), texts: idx.map((i) => texts[i]) });
    Object.assign(errors, data.errors || {});
    idx.forEach((i, j) => {
      for (const [def] of need) {
        const r = data.results[j][def.id];
        if (!r) continue;
        results[i][def.id] = r;
        cache.set(`${sigOf(def)}\0${texts[i]}`, r);
      }
    });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return { results, errors };
}

browser.runtime.onMessage.addListener(async (msg) => {
  try {
    switch (msg.type) {
      case "classify":
        return await classify(msg.texts, msg.topic);
      case "health":
        return await health(msg.server);
      case "validate": {
        const [def] = await enabledDefs(msg.topic);
        return await post("/validate", { topic: def });
      }
      case "defaults":
        return await defaults();
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
