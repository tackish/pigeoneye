/**
 * Issues view performance (jsdom).
 * Opens the cross-cluster Issues view with a given number of issues and
 * measures how long the main thread is blocked rendering it.
 * Run: node scripts/perf-issues.mjs [issues]
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const N = Number(process.argv[2] || 1000);
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
const podTable = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: [{ name: "p", namespace: "d", cells: ["p", "1/1", "Running", "0", "1m"], labels: {} }],
  truncated: false, resource_version: "1", include: "Metadata",
};
const STATES = ["CrashLoopBackOff", "ImagePullBackOff", "Pending", "Error", "OOMKilled"];
const issues = Array.from({ length: N }, (_, i) => ({
  context: "smoke", kind: "Pod", namespace: `ns-${i % 40}`,
  name: `bad-pod-${String(i).padStart(5, "0")}`, status: STATES[i % STATES.length],
}));

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["d"]);
      case "list_resources": return Promise.resolve(podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "aggregate_issues": {
        const ch = args?.channel;
        setTimeout(() => { try { ch.onmessage({ context: "smoke", issues, error: null }); } catch {} }, 0);
        return Promise.resolve(null);
      }
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];

const SAMPLE = 20;
const byPhase = {}; let phase = "startup", last = performance.now();
const sampler = setInterval(() => { const n = performance.now(); (byPhase[phase] ||= []).push(n - last); last = n; }, SAMPLE);
const mark = (p) => { last = performance.now(); phase = p; };
const worst = (p) => { const a = byPhase[p] || []; return a.length ? Math.max(...a) - SAMPLE : 0; };

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(1500); // let the warm sweep deliver the issues

mark("open");
const t0 = performance.now();
q("button").find((b) => /issues/i.test(b.textContent || ""))?.click();
for (let i = 0; i < 400; i++) { await wait(20); if (q(".iss-row").length) break; }
const openMs = performance.now() - t0;
await wait(600);
const rendered = q(".iss-row").length;
mark("settle"); await wait(400);
clearInterval(sampler);

console.log(`issues: ${N}   rows rendered in the DOM: ${rendered}`);
console.log(`  open Issues view : wall ${openMs.toFixed(0)} ms   longest main-thread block ${worst("open").toFixed(0)} ms`);
console.log(`  idle after       : longest block ${worst("settle").toFixed(0)} ms`);

// The list is windowed, so what reaches the DOM must not track the issue
// count — that is the whole point, and it is what regresses silently.
const CAP = 200;
if (rendered > CAP) {
  console.error(
    `PERF-ISSUES FAILED — ${rendered} rows reached the DOM for ${N} issues. ` +
    `The list is supposed to be windowed, so this should stay near a screenful ` +
    `however many issues there are.`,
  );
  process.exit(1);
}
if (worst("open") > 120) {
  console.error(`PERF-ISSUES FAILED — opening the view blocked ${worst("open").toFixed(0)}ms`);
  process.exit(1);
}
console.log("perf-issues ok");
process.exit(0);
