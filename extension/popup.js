const $ = (id) => document.getElementById(id);

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

async function render() {
  const s = await browser.storage.local.get({ enabled: true, paranoid: false, topics: [] });
  $("enabled").checked = s.enabled;
  $("paranoid").checked = s.paranoid;
  const list = $("topics");
  list.replaceChildren();
  if (!s.topics.length) list.append(h("div", { class: "empty" }, "No topics yet."));
  s.topics.forEach((t, i) => {
    const summary = t.suppress && t.suppress.length ? "Hides " + t.suppress.join(", ") : "Hides everything";
    list.append(h("div", { class: "row" },
      h("span", { class: "dot", style: { background: t.color || Sup.PALETTE[i % Sup.PALETTE.length] } }),
      h("span", { class: "name" }, h("b", {}, t.name), h("span", { title: summary }, summary)),
      h("label", { class: "switch", title: `Enable ${t.name}` },
        h("input", {
          type: "checkbox", checked: t.enabled !== false,
          onchange: async (e) => {
            const cur = (await browser.storage.local.get({ topics: [] })).topics;
            const x = cur.find((y) => y.id === t.id);
            if (x) x.enabled = e.target.checked;
            browser.storage.local.set({ topics: cur });
          },
        }),
        h("span"))));
  });
}

$("enabled").addEventListener("change", (e) => browser.storage.local.set({ enabled: e.target.checked }));
$("paranoid").addEventListener("change", (e) => browser.storage.local.set({ paranoid: e.target.checked }));
$("manage").addEventListener("click", () => { browser.runtime.openOptionsPage(); window.close(); });

$("setup").addEventListener("click", (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL("welcome.html") });
  window.close();
});

browser.runtime.sendMessage({ type: "health" }).catch(() => null).then((r) => {
  const s = $("status");
  const hs = Sup.describeHealth(r);
  s.className = "status " + (hs.ok ? (hs.slow ? "ok slow" : "ok") : "bad");
  s.querySelector("span").textContent = hs.ok ? hs.text : "Classifier offline — keyword matches only.";
  if (hs.slow) s.title = "Classification is slow on this machine. Only items near the screen are checked.";
  $("setup").hidden = hs.ok;
});

render();
