const DEFAULTS = {
  enabled: true,
  topic: "gta6",
  mode: "spoilers",
  aboutThreshold: 0.5,
  spoilerThreshold: 0.4,
  paranoid: false,
};

const $ = (id) => document.getElementById(id);

for (const [key, t] of Object.entries(SUPPRESSOR_TOPICS)) {
  $("topic").add(new Option(t.name, key));
}

browser.storage.local.get(DEFAULTS).then((cfg) => {
  for (const [k, v] of Object.entries(cfg)) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
    const out = document.querySelector(`output[for=${k}]`);
    if (out) out.value = v;
  }
});

document.querySelectorAll("input, select").forEach((el) => {
  el.addEventListener("change", () => {
    const v = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
    browser.storage.local.set({ [el.id]: v });
  });
  if (el.type === "range") {
    el.addEventListener("input", () => (document.querySelector(`output[for=${el.id}]`).value = el.value));
  }
});

browser.runtime.sendMessage({ type: "health" }).then((h) => {
  const s = $("status");
  if (h && h.ok) {
    s.textContent = "Laya server running";
    s.className = "status ok";
  } else {
    s.textContent = "Server not reachable: only keyword matches are hidden. Run server/start.ps1";
    s.className = "status bad";
  }
});
