/**
 * What each late column costs the main thread when its data lands (jsdom).
 *
 * A pod list paints first; then, one by one, the Recent event warnings, the
 * live metrics, the node types and the restart reasons arrive, and each one
 * rebuilds every display row. On a big list that rebuild is the hitch you
 * feel after the list is already up. This holds each source back, releases
 * them one at a time, and reports the longest main-thread block per arrival.
 * Run: node scripts/perf-arrivals.mjs [rows]   (DIST=dir to measure another build)
 */
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";

const N = Number(process.argv[2] || 20000);
const DIST = path.resolve(process.env.DIST || "dist");
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
// Labels the way real pods carry them: a handful, some of them long.
const labelsOf = (i) => ({
  app: `svc-${i % 100}`,
  "app.kubernetes.io/name": `svc-${i % 100}`,
  "app.kubernetes.io/instance": `svc-${i % 100}-prod`,
  "app.kubernetes.io/managed-by": "Helm",
  "helm.sh/chart": `svc-${i % 100}-1.4.2`,
  "pod-template-hash": `7d9f${i % 1000}c4b`,
});
const table = {
  columns: [...["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })), { name: "IP", priority: 1 }, { name: "Node", priority: 1 }],
  rows: Array.from({ length: N }, (_, i) => ({
    name: `pod-${String(i).padStart(6, "0")}`, namespace: `ns-${i % 50}`, labels: labelsOf(i),
    cells: [`pod-${String(i).padStart(6, "0")}`, "1/1", "Running", i % 50 ? "0" : "2 (3h ago)", "3h", `10.0.${i % 250}.${i % 200}`, `ip-${i % 300}`],
  })),
  truncated: false, resource_version: "1", include: "Metadata",
};
const keyOf = (r) => `${r.namespace}/${r.name}`;
const events = table.rows.filter((_, i) => i % 40 === 0).map((r) => ({ key: keyOf(r), reason: "Unhealthy", message: "probe failed", count: 3, last: new Date().toISOString() }));
const stats = table.rows.map((r) => ({ key: keyOf(r), cpu: 12, mem: 340 * 2 ** 20, cpu_r: 100, cpu_l: 200, mem_r: 512 * 2 ** 20, mem_l: 1024 * 2 ** 20 }));
const exits = table.rows.filter((_, i) => i % 50 === 0).map((r) => ({ key: keyOf(r), reason: "OOMKilled", code: 137, at: "2026-11-09T01:00:00Z", container: "app" }));
const types = Array.from({ length: 300 }, (_, i) => ({ name: `ip-${i}`, instance: "m6i.xlarge", capacity: i % 3 ? "spot" : "on-demand", zone: "ap-northeast-2a", pool: "default" }));

const gate = () => { let open; const p = new Promise((r) => (open = r)); return { p, open }; };
const held = { events: gate(), stats: gate(), types: gate() };
let exitsReady = false;

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["ns-0"]);
      case "list_resources": return Promise.resolve(table);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_events": return held.events.p.then(() => events); // builds before the feed
      case "pod_events_watch":
        held.events.p.then(() => args.channel.onmessage({ type: "SNAPSHOT", events }));
        return Promise.resolve(7);
      case "pod_stats": return held.stats.p.then(() => stats);
      case "node_types": return held.types.p.then(() => types);
      case "pod_exits": return Promise.resolve(exitsReady ? exits : null);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync(`${DIST}/assets`).find((f) => f.endsWith(".js"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];
const header = (re) => q("th").some((h) => re.test((h.textContent || "").trim()));

const SAMPLE = 5;
const byPhase = {};
let phase = "startup", last = performance.now();
const sampler = setInterval(() => {
  const n = performance.now(); const g = n - last; last = n;
  (byPhase[phase] ||= []).push(g);
}, SAMPLE);
const mark = (p) => { last = performance.now(); phase = p; };
const worst = (p) => { const a = byPhase[p] || []; return a.length ? Math.max(...a) - SAMPLE : 0; };

await import(`${DIST}/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(600);
mark("listing");
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
for (let i = 0; i < 300 && !q("tr.row").length; i++) await wait(20);
await wait(1500);

const out = {};
async function arrival(name, release, re) {
  mark(name);
  release();
  let landed = false;
  for (let i = 0; i < 150; i++) { await wait(20); if (header(re)) { landed = true; break; } }
  await wait(300);
  mark("between");
  await wait(300);
  out[name] = landed ? Math.round(worst(name)) : null;
}
await arrival("events", () => held.events.open(), /^recent event/i);
await arrival("metrics", () => held.stats.open(), /^%CPU\/R/i);
await arrival("node types", () => held.types.open(), /^node type/i);
await arrival("restart reasons", () => { exitsReady = true; }, /^restart reason/i);
clearInterval(sampler);

console.log(`rows: ${N}   longest main-thread block when each column's data lands:`);
for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(16)} ${v === null ? "  —  (not in this build)" : `${String(v).padStart(4)} ms`}`);
if (process.env.JSON) console.log(JSON.stringify(out));
// Before the row cache these were ~100ms apiece for events and metrics; a
// new column that lands heavier than that is a regression worth stopping.
const slow = Object.entries(out).filter(([, v]) => v === null || v > 150);
if (slow.length) { console.error("PERF-ARRIVALS FAILED — " + slow.map(([k, v]) => `${k}: ${v ?? "never landed"}`).join(", ")); process.exit(1); }
console.log("perf-arrivals ok");
process.exit(0);
