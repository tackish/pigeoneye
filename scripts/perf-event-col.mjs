/**
 * What the Recent event column costs, measured against the same list without
 * it. The column adds three things that could show up on a big list: a cell
 * per row, a per-second age on every VISIBLE cell, and a 20s sweep. This runs
 * the worst case — every one of 20k pods carrying a warning, so every visible
 * cell has an age ticking — and the same list with the column off.
 *
 *   EVENTS=off node scripts/perf-event-col.mjs    # column absent (baseline)
 *   EVENTS=all node scripts/perf-event-col.mjs    # every row warns
 *
 * Run: node scripts/perf-event-col.mjs [rows] [idle seconds]
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const N = Number(process.argv[2] || 20000);
const SECS = Number(process.argv[3] || 20);
// off = column absent · few = a realistic handful warn · all = every pod warns
const MODE = process.env.EVENTS || "all";
// The sweep is a network round trip, so resolving it instantly would fold its
// cost into the first paint and measure something that cannot happen.
const RTT = Number(process.env.RTT || 40);

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
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.scrollTo = function () {};

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const AGES = ["5s", "17s", "45s", "1m", "3m", "12m", "59m", "2h", "3d"];
const rows = Array.from({ length: N }, (_, i) => ({
  name: `pod-${i}`, namespace: `ns-${i % 40}`,
  cells: [`pod-${i}`, "1/1", "Running", "0", AGES[i % AGES.length]],
  labels: { app: `app-${i % 50}` },
}));
const table = { columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })), rows, truncated: false, resource_version: "1", include: "Metadata" };

// Worst case: EVERY pod warns, each with a distinct recent timestamp, so every
// visible cell has an age that has to be recomputed on each tick.
const events = rows.map((r, i) => ({
  key: `${r.namespace}/${r.name}`,
  reason: i % 3 === 0 ? "FailedScheduling" : i % 3 === 1 ? "Unhealthy" : "BackOff",
  message: "0/50 nodes are available: insufficient cpu.",
  count: (i % 9) + 1,
  last: new Date(Date.now() - ((i % 120) + 1) * 1000).toISOString(),
}));

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
      case "pod_events":
        if (MODE === "off") return Promise.reject(new Error("events not listable"));
        return new Promise((r) =>
          setTimeout(() => r(MODE === "few" ? events.slice(0, 50) : events), RTT),
        );
      case "pod_stats": return Promise.reject(new Error("no metrics"));
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];
const fail = (m) => { console.error("PERF-EVENT-COL FAILED — " + m); process.exit(1); };
let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
dom.window.addEventListener("unhandledrejection", (e) => (crash = String(e.reason)));

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(600);

// (a) how long the list takes to appear
const t0 = performance.now();
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
for (let i = 0; i < 200 && !q("tr.row").length; i++) await wait(25);
const firstPaint = performance.now() - t0;
await wait(1200);
if (!q("tr.row").length) fail("the list never rendered");

const hasCol = q("th").some((h) => /^recent event/i.test((h.textContent || "").trim()));
if (MODE === "off" && hasCol) fail("baseline run still has the column");
if (MODE === "all" && !hasCol) fail("the column never appeared");

// (b) sorting rebuilds every display row — the per-row cost shows up here
const ageTh = q("th").find((h) => /^age/i.test((h.textContent || "").trim()));
const s0 = performance.now();
ageTh?.querySelector(".th-text")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await wait(0);
const sortMs = performance.now() - s0;
await wait(400);

// (c) the main thread while the list just sits there, with the 1s age tick
const gaps = [];
let last = performance.now();
const id = setInterval(() => { const n = performance.now(); gaps.push(n - last); last = n; }, 50);
await wait(SECS * 1000);
clearInterval(id);
gaps.sort((a, b) => a - b);
const p = (x) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * x))];
const over = (ms) => gaps.filter((g) => g > ms).length;

console.log(`mode: ${MODE.padEnd(3)}  rows: ${N}  warnings: ${MODE === "off" ? 0 : MODE === "few" ? 50 : N}  column: ${hasCol ? "on" : "off"}`);
console.log(`  first paint   ${firstPaint.toFixed(0)}ms`);
console.log(`  sort rebuild  ${sortMs.toFixed(0)}ms`);
console.log(`  idle gap      p50 ${p(0.5).toFixed(0)}ms  p95 ${p(0.95).toFixed(0)}ms  p99 ${p(0.99).toFixed(0)}ms  max ${gaps[gaps.length - 1].toFixed(0)}ms`);
console.log(`  gaps >100ms ${over(100)}   >250ms ${over(250)}`);
console.log(`  rendered rows ${q("tr.row").length}`);
if (crash) fail(crash);
if (over(250) > 0) fail(`${over(250)} stall(s) over 250ms`);
// The window must stay a window whatever the column holds.
if (q("tr.row").length > 200) fail(`${q("tr.row").length} rows rendered — the list stopped windowing`);
// Measured at 20k rows: ~31ms with the column off, ~35ms with a realistic
// handful of warnings, ~47ms with every single pod warning. The bound is
// there to catch a change that makes the column cost per ROW rather than
// per warning, which is what a regression here would look like.
if (sortMs > 150) fail(`sort rebuild took ${sortMs.toFixed(0)}ms`);
if (firstPaint > 400) fail(`first paint took ${firstPaint.toFixed(0)}ms`);
console.log("perf-event-col ok");
process.exit(0);
