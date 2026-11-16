// Proxies classification requests from content scripts to the local Laya server
// (content scripts cannot fetch 127.0.0.1 cross-origin under MV3) and keeps a
// small in-memory cache so revisiting a page costs nothing.

const DEFAULT_SERVER = "http://127.0.0.1:8765";
const cache = new Map(); // `${topic}\0${text}` -> result
const CACHE_MAX = 5000;

async function serverUrl() {
  const { server } = await browser.storage.local.get({ server: DEFAULT_SERVER });
  return server.replace(/\/$/, "");
}

async function classify(topic, texts) {
  const results = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => {
    const hit = cache.get(`${topic}\0${t}`);
    if (hit) results[i] = hit;
    else missing.push(i);
  });
  if (missing.length) {
    const resp = await fetch(`${await serverUrl()}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, texts: missing.map((i) => texts[i]) }),
    });
    if (!resp.ok) throw new Error(`server ${resp.status}`);
    const data = await resp.json();
    if (!data.results) throw new Error(data.error || "bad response");
    missing.forEach((i, j) => {
      results[i] = data.results[j];
      cache.set(`${topic}\0${texts[i]}`, data.results[j]);
    });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return results;
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "classify") {
    try {
      return { results: await classify(msg.topic, msg.texts) };
    } catch (e) {
      return { error: String(e) };
    }
  }
  if (msg.type === "health") {
    try {
      const r = await fetch(`${await serverUrl()}/health`);
      return await r.json();
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (msg.type === "clearCache") {
    cache.clear();
    return { ok: true };
  }
});
