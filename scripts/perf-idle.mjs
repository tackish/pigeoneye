/**
 * Steady-state performance check (jsdom).
 *
 * The app runs several periodic jobs — the per-second AGE tick, a 20s live
 * metrics refresh, a 60s cross-cluster issue sweep. None of them may stall the
 * main thread while a big list just sits there. This parks a large pod list,
 * sorted by AGE, and samples the event loop long enough to cover the 1s and
 * 20s timers. Run: node scripts/perf-idle.mjs [rows] [seconds]
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const N = Number(process.argv[2] || 20000);
const SECS = Number(process.argv[3] || 25);
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

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const AGES = ["5s", "17s", "45s", "1m", "3m", "12m", "59m", "2h", "3d"];
const table = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: Array.from({ length: N }, (_, i) => ({
    name: `pod-${String(i).padStart(6, "0")}`, namespace: `ns-${i % 50}`,
    cells: [`pod-${String(i).padStart(6, "0")}`, "1/1", "Running", "0", AGES[i % AGES.length]],
    labels: { app: `svc-${i % 100}` },
  })),
  truncated: false, resource_version: "1", include: "Metadata",
};
// Live metrics for every pod, so the stats map is in play like it is in anger.
const stats = table.rows.map((r) => ({
  key: `${r.namespace}/${r.name}`, cpu: 12, mem: 340,
  cpu_r: 100, cpu_l: 200, mem_r: 512, mem_l: 1024,
}));

let podStatsCalls = 0, issueSweeps = 0;
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["ns-0"]);
      case "list_resources": return Promise.resolve(table);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_stats": podStatsCalls++; return Promise.resolve(stats);
      case "aggregate_issues": issueSweeps++; return Promise.resolve(null);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];
const fail = (m) => { console.error("PERF-IDLE FAILED — " + m); process.exit(1); };

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(600);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(3000);
if (!q("tr.row").length) fail("the list never rendered");
const ageTh = q("th").find((h) => /^age/i.test((h.textContent || "").trim()));
ageTh?.querySelector(".th-text")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await wait(500);

const statsAtStart = podStatsCalls, sweepsAtStart = issueSweeps;
const gaps = [];
let last = performance.now();
const id = setInterval(() => { const n = performance.now(); gaps.push(n - last); last = n; }, 50);
await wait(SECS * 1000);
clearInterval(id);

gaps.sort((a, b) => a - b);
const p = (x) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * x))];
const over = (ms) => gaps.filter((g) => g > ms).length;
console.log(`rows: ${N}, idle window: ${SECS}s, samples: ${gaps.length}`);
console.log(`  event-loop gap  p50 ${p(0.5).toFixed(0)}ms  p95 ${p(0.95).toFixed(0)}ms  p99 ${p(0.99).toFixed(0)}ms  max ${gaps[gaps.length - 1].toFixed(0)}ms`);
console.log(`  gaps >100ms: ${over(100)}   >250ms: ${over(250)}`);
console.log(`  background fetches while idle — pod_stats: ${podStatsCalls - statsAtStart}, issue sweeps: ${issueSweeps - sweepsAtStart}`);

if (over(250) > 0) fail(`${over(250)} stall(s) over 250ms while idle — a periodic job is doing heavy work`);
console.log("perf-idle ok");
process.exit(0);
