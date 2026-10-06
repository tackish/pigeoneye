/**
 * Performance check for the AGE-column sort (jsdom).
 *
 * The fix makes an AGE sort compare the age the column SHOWS rather than the
 * raw cell. That must not cost anything noticeable: this measures an AGE sort
 * against a plain string sort on the same list, and watches the event loop
 * while the list sits sorted to prove nothing re-sorts on the per-second tick.
 * Run: node scripts/perf-age-sort.mjs [rows]
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const N = Number(process.argv[2] || 20000);
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost/", pretendToBeVisual: true,
});
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
const COLS = ["Name", "Ready", "Status", "Restarts", "Age"];
// A spread of ages across the live-ticked range and beyond it.
const AGES = ["5s", "17s", "45s", "1m", "3m", "12m", "59m", "2h", "5h", "3d", "2d7h"];
const table = {
  columns: COLS.map((name) => ({ name, priority: 0 })),
  rows: Array.from({ length: N }, (_, i) => ({
    name: `pod-${String(i).padStart(6, "0")}`,
    namespace: `ns-${i % 50}`,
    cells: [`pod-${String(i).padStart(6, "0")}`, "1/1", "Running", "0", AGES[i % AGES.length]],
    labels: { app: `svc-${i % 100}` },
  })),
  truncated: false, resource_version: "1", include: "Metadata",
};

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
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];
const fail = (m) => { console.error("PERF FAILED — " + m); process.exit(1); };

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(600);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(2500);
if (!q("tr.row").length) fail("the list never rendered");

const headers = q("th");
const thFor = (re) => headers.find((h) => re.test((h.textContent || "").trim()));
const clickSort = (th) => {
  const t0 = performance.now();
  th.querySelector(".th-text")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  return performance.now() - t0; // Solid recomputes synchronously on the signal write
};

const nameTh = thFor(/^name/i), ageTh = thFor(/^age/i);
if (!nameTh || !ageTh) fail("could not find the NAME / AGE headers");

// Warm both paths once so neither pays first-run JIT on its measured pass.
clickSort(nameTh); await wait(150);
clickSort(ageTh);  await wait(150);

const name = [], age = [];
for (let i = 0; i < 5; i++) { name.push(clickSort(nameTh)); await wait(120); }
for (let i = 0; i < 5; i++) { age.push(clickSort(ageTh));  await wait(120); }
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const mName = med(name), mAge = med(age);

// With the list sitting sorted by AGE, the per-second tick must not re-sort it.
// Sample the event loop: a re-sort of this list would show up as a long gap.
clickSort(ageTh); await wait(200);
const gaps = [];
let last = performance.now();
const id = setInterval(() => { const n = performance.now(); gaps.push(n - last); last = n; }, 50);
await wait(3200);
clearInterval(id);
const maxGap = Math.max(...gaps);

console.log(`rows: ${N}`);
console.log(`  sort by NAME (string) : ${mName.toFixed(1)} ms  [${name.map((v) => v.toFixed(0)).join(", ")}]`);
console.log(`  sort by AGE  (live)   : ${mAge.toFixed(1)} ms  [${age.map((v) => v.toFixed(0)).join(", ")}]`);
console.log(`  overhead vs string    : ${(mAge - mName).toFixed(1)} ms (${((mAge / Math.max(mName, 0.01) - 1) * 100).toFixed(0)}%)`);
console.log(`  idle max event-loop gap while AGE-sorted: ${maxGap.toFixed(0)} ms over 3.2s`);

// An AGE sort doing per-row work must stay in the same class as a string sort,
// and nothing may re-sort on the tick.
if (mAge > mName * 2 + 25) fail(`AGE sort is disproportionately slow: ${mAge.toFixed(1)}ms vs ${mName.toFixed(1)}ms`);
if (maxGap > 250) fail(`the main thread stalled ${maxGap.toFixed(0)}ms while idle — something is re-sorting on the tick`);
console.log("perf ok");
process.exit(0);
