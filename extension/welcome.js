// First-run page: polls the classifier until it answers, then turns green.

const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
let timer = null;

function show(r) {
  const hs = Sup.describeHealth(r);
  const live = $("live");
  live.className = "live " + (hs.ok ? (hs.slow ? "slow" : "ok") : "waiting");
  document.body.classList.toggle("ready", hs.ok);
  if (hs.ok) {
    $("liveTitle").textContent = hs.slow ? "Classifier running, but slowly" : "Classifier running. You're all set.";
    $("liveDetail").textContent = hs.slow
      ? `Running on ${hs.detail}. Items are only checked as they come near the screen; a GPU makes this much faster.`
      : `Running on ${hs.detail}. Open a YouTube, Reddit or X page to see it work.`;
  }
  return hs.ok;
}

async function poll() {
  timer = null;
  let r = null;
  try {
    r = await browser.runtime.sendMessage({ type: "health" });
  } catch {
    r = null;
  }
  if (!show(r) && !document.hidden) timer = setTimeout(poll, POLL_MS);
}

// Don't poll from a background tab; resume when it's visible again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !timer && !document.body.classList.contains("ready")) poll();
});

$("options").addEventListener("click", () => browser.runtime.openOptionsPage());

browser.storage.local.get({ server: Sup.DEFAULT_SERVER }).then(({ server }) => {
  $("addr").textContent = Sup.normalizeServer(server) || Sup.DEFAULT_SERVER;
});

// Re-check straight away when the address is changed on the options page.
browser.storage.onChanged.addListener((changes) => {
  if (!changes.server) return;
  $("addr").textContent = Sup.normalizeServer(changes.server.newValue) || Sup.DEFAULT_SERVER;
  clearTimeout(timer);
  poll();
});

browser.runtime.getPlatformInfo().then(({ os }) => {
  const mine = os === "win" ? "os-win" : "os-unix";
  $(mine).classList.add("mine");
  if (mine === "os-unix") $("os-unix").after($("os-win"));
}).catch(() => {});

poll();
