/**
 * Hot-path performance audit (jsdom).
 *
 * "Faster than anything" is the point of the app, so the paths you hit while
 * actually working a big cluster have to stay off the main thread's back. This
 * loads a large pod list and measures the longest the main thread is blocked
 * by each of them — listing, a watch burst, live metrics landing, and typing
 * in the search box. Run: node scripts/perf-hotpaths.mjs [rows]
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

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const AGES = ["5s", "17s", "45s", "1m", "3m", "12m", "59m", "2h", "3d"];
const row = (i, status = "Running") => ({
  name: `pod-${String(i).padStart(6, "0")}`, namespace: `ns-${i % 50}`,
  cells: [`pod-${String(i).padStart(6, "0")}`, "1/1", status, "0", AGES[i % AGES.length]],
  labels: { app: `svc-${i % 100}`, tier: i % 2 ? "web" : "batch" },
});
const table = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: Array.from({ length: N }, (_, i) => row(i)),
  truncated: false, resource_version: "1", include: "Metadata",
};
const stats = table.rows.map((r) => ({
  key: `${r.namespace}/${r.name}`, cpu: 12, mem: 340, cpu_r: 100, cpu_l: 200, mem_r: 512, mem_l: 1024,
}));

let watchChan = null;
let releaseStats; const statsGate = new Promise((r) => (releaseStats = r));
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["ns-0"]);
      case "list_resources": return Promise.resolve(table);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": watchChan = args?.channel; return Promise.resolve(1);
      case "pod_stats": return statsGate.then(() => stats); // released on cue
      case "filter_rows": return Promise.resolve([]);
      case "ensure_index": return Promise.resolve(null);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];

// Continuous event-loop sampler, attributed to whatever phase is current.
const SAMPLE = 20;
const byPhase = {};
let phase = "startup", last = performance.now();
const sampler = setInterval(() => {
  const n = performance.now(); const g = n - last; last = n;
  (byPhase[phase] ||= []).push(g);
}, SAMPLE);
const mark = (p) => { last = performance.now(); phase = p; };
const worst = (p) => {
  const a = byPhase[p] || [];
  return a.length ? Math.max(...a) - SAMPLE : 0; // minus the sampler's own cadence
};

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(600);

// 1. Listing: click the kind, wait for rows.
mark("listing");
const tList = performance.now();
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
for (let i = 0; i < 300 && !q("tr.row").length; i++) await wait(20);
const listMs = performance.now() - tList;
await wait(400);
if (!q("tr.row").length) { clearInterval(sampler); console.error("PERF FAILED — list never rendered"); process.exit(1); }

// 2. Live metrics landing: the stats map is replaced, which rebuilds display rows.
mark("metrics");
const tStats = performance.now();
releaseStats();
for (let i = 0; i < 200; i++) { await wait(20); if (q("th").some((h) => /CPU/i.test(h.textContent || ""))) break; }
const statsMs = performance.now() - tStats;
await wait(500);

// 3. Watch burst: a rollout's worth of changes through the 700ms coalescing window.
mark("watch");
const burst = Array.from({ length: 500 }, (_, i) => row(i, "Terminating"));
const tWatch = performance.now();
watchChan?.onmessage({ type: "MODIFIED", rows: burst });
await wait(1400); // debounce + apply
const watchMs = performance.now() - tWatch;

// 4. Typing in the row search.
mark("search");
const box = q("input.search.wide")[0] || q("input.search")[0];
let searchMs = 0;
if (box) {
  const tS = performance.now();
  for (const s of ["p", "po", "pod-0001", "pod-00012"]) {
    box.value = s;
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await wait(120);
  }
  searchMs = performance.now() - tS;
}

mark("settle"); await wait(600);
clearInterval(sampler);

const line = (n, wall, p) => `  ${n.padEnd(22)} wall ${wall.toFixed(0).padStart(5)} ms   longest main-thread block ${worst(p).toFixed(0).padStart(4)} ms`;
console.log(`rows: ${N}`);
console.log(line("listing (first paint)", listMs, "listing"));
console.log(line("live metrics landing", statsMs, "metrics"));
console.log(line("watch burst (500 rows)", watchMs, "watch"));
console.log(line("search typing (4 keys)", searchMs, "search"));
console.log(line("idle after", 0, "settle"));

const bad = [];
for (const [name, p, limit] of [
  ["listing", "listing", 400],
  ["live metrics", "metrics", 400],
  ["watch burst", "watch", 250],
  ["search", "search", 250],
  ["idle", "settle", 100],
]) if (worst(p) > limit) bad.push(`${name}: ${worst(p).toFixed(0)}ms > ${limit}ms`);
if (bad.length) { console.error("PERF HOTPATH FAILED — " + bad.join("; ")); process.exit(1); }
console.log("perf-hotpaths ok");
process.exit(0);
