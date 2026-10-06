/**
 * Split-view cost (jsdom). Two panes each carry their own table, watch and
 * memos, so the question is whether the second one doubles the bill or just
 * adds to it. Loads a large list in both panes and measures a watch burst and
 * the idle floor. Run: node scripts/perf-split.mjs [rows]
 */
import { JSDOM } from "jsdom";
import fs from "fs";
const N = Number(process.argv[2] || 20000);
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
Object.assign(global, {
  window: dom.window, document: dom.window.document,
  Window: dom.window.Window || dom.window.constructor,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle, customElements: dom.window.customElements,
  localStorage: dom.window.localStorage,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  MutationObserver: dom.window.MutationObserver,
});
global.ResizeObserver = class { observe() {} disconnect() {} };
dom.window.Element.prototype.scrollIntoView = function () {};

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const AGES = ["5s", "1m", "12m", "2h", "3d"];
const row = (i, st = "Running") => ({
  name: `pod-${String(i).padStart(6, "0")}`, namespace: `ns-${i % 50}`,
  cells: [`pod-${String(i).padStart(6, "0")}`, "1/1", st, "0", AGES[i % AGES.length]],
  labels: { app: `svc-${i % 100}` },
});
const table = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: Array.from({ length: N }, (_, i) => row(i)),
  truncated: false, resource_version: "1", include: "Metadata",
};
const chans = [];
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["ns-0"]);
      case "list_resources": return Promise.resolve(table);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": chans.push(args?.channel); return Promise.resolve(chans.length);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};
const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];
const SAMPLE = 20; const byPhase = {}; let phase = "s", last = performance.now();
const sampler = setInterval(() => { const n = performance.now(); (byPhase[phase] ||= []).push(n - last); last = n; }, SAMPLE);
const mark = (p) => { last = performance.now(); phase = p; };
const worst = (p) => { const a = byPhase[p] || []; return a.length ? Math.max(...a) - SAMPLE : 0; };

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(600);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(2500);

// single-pane baseline
mark("one-burst");
chans[0]?.onmessage({ type: "MODIFIED", rows: Array.from({ length: 500 }, (_, i) => row(i, "Terminating")) });
await wait(1400);
mark("one-idle"); await wait(2500);
const onePanes = q(".primary-pane").length;

// split, and give the second pane the same list
mark("split-open");
q("button.split-toggle")[0]?.click();
await wait(2500);
const twoPanes = q(".primary-pane").length;

mark("two-burst");
for (const ch of chans) ch?.onmessage({ type: "MODIFIED", rows: Array.from({ length: 500 }, (_, i) => row(i, "Pending")) });
await wait(1400);
mark("two-idle"); await wait(2500);
clearInterval(sampler);

console.log(`rows per pane: ${N}   panes: ${onePanes} -> ${twoPanes}`);
console.log(`  watch burst  single ${worst("one-burst").toFixed(0)} ms   split ${worst("two-burst").toFixed(0)} ms`);
console.log(`  idle floor   single ${worst("one-idle").toFixed(0)} ms   split ${worst("two-idle").toFixed(0)} ms`);
console.log(`  opening the split (loads a second ${N}-row list): ${worst("split-open").toFixed(0)} ms`);
if (twoPanes !== 2) { console.error("PERF-SPLIT FAILED — the split did not open"); process.exit(1); }
if (worst("two-idle") > 100) { console.error(`PERF-SPLIT FAILED — split idles at ${worst("two-idle").toFixed(0)}ms`); process.exit(1); }
console.log("perf-split ok");
process.exit(0);
