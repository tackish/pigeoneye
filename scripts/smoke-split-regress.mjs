/**
 * The split view runs a SECOND copy of the row builder and of every key
 * handler, so anything added to the pod list has to be added twice and can
 * silently work in one pane only. This drives both panes and asserts the two
 * things this release adds reach the secondary pane as well:
 *
 *   - the Event column (its own map, its own row cache, per pane)
 *   - `l` from the sidebar, which in a split drives whichever pane has focus
 *
 * Run: node scripts/smoke-split-regress.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
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
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.scrollTo = function () {};

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const table = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: [
    { name: "pod-a", namespace: "ns", cells: ["pod-a", "2/2", "Running", "0", "5m"], labels: {} },
    { name: "pod-b", namespace: "ns", cells: ["pod-b", "0/2", "Pending", "0", "6m"], labels: {} },
  ],
  truncated: false, resource_version: "1", include: "Metadata",
};
const detail = (name) => ({
  name, namespace: "ns", created: "2026-10-01T00:00:00Z", labels: {}, annotations: {},
  unschedulable: null, node_name: "n1", ports: [], containers: ["app", "sidecar"],
  resource_version: "9", involved: null, links: [], has_pod_selector: false,
  pod_selector: null, secret_data: [], replicas: null, ready_replicas: null,
  generation: null, yaml: "kind: Pod\n",
});
const warn = {
  key: "ns/pod-b", reason: "FailedScheduling",
  message: "0/50 nodes are available: insufficient cpu.", count: 3,
  last: new Date(Date.now() - 45_000).toISOString(), // recent, so it reads as live
};

let fetched = [];
let eventSweeps = 0;
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["ns"]);
      case "list_resources": return Promise.resolve(table);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "get_resource": fetched.push(args?.name); return Promise.resolve(detail(args?.name));
      case "pod_events": eventSweeps++; return Promise.resolve([warn]);
      case "pod_stats": return Promise.reject(new Error("no metrics"));
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
dom.window.addEventListener("unhandledrejection", (e) => (crash = String(e.reason)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];
const key = (k, mods = {}) => document.body.dispatchEvent(
  new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }),
);

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const headers = (p) => q("thead th", p).map((h) => h.textContent.replace(/[^\w%/]/g, "").toUpperCase());
const cellsOf = (p, name) => {
  const tr = q("tbody tr.row", p).find((r) => r.textContent.includes(name));
  return tr ? q("td", tr).map((td) => td.textContent.trim()) : null;
};

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(700);

console.log("split regressions");
q("button.split-toggle")[0]?.click();
await wait(800);

let panes = q(".primary-pane");
ok("the split opened", panes.length === 2, `${panes.length} panes`);
ok("both panes have rows", q("tr.row", panes[0]).length === 2 && q("tr.row", panes[1]).length === 2);

// --- the Event column, in BOTH panes ---
for (const [i, p] of panes.entries()) {
  const hs = headers(p);
  const ev = hs.indexOf("RECENTEVENT");
  ok(`pane ${i}: the Event column is present`, ev >= 0, hs.join(","));
  ok(`pane ${i}: it sits after STATUS`, ev === hs.indexOf("STATUS") + 1, hs.join(","));
  ok(`pane ${i}: the warning shows with its count`, /^FailedScheduling ×3\b/.test(cellsOf(p, "pod-b")?.[ev] ?? ""), JSON.stringify(cellsOf(p, "pod-b")));
  ok(`pane ${i}: and how long ago it happened`, / · \d+s$/.test(cellsOf(p, "pod-b")?.[ev] ?? ""), JSON.stringify(cellsOf(p, "pod-b")?.[ev]));
  ok(`pane ${i}: a healthy pod stays empty`, cellsOf(p, "pod-a")?.[ev] === "", JSON.stringify(cellsOf(p, "pod-a")));
}
ok("each pane sweeps for itself", eventSweeps >= 2, `${eventSweeps} sweeps`);

// --- `l` from the sidebar, with focus on the SECOND pane ---
key("ArrowRight", { metaKey: true }); // focus pane 2
await wait(300);
key("Escape"); await wait(250);       // table -> sidebar, pane 2 still focused
ok("focus is on the sidebar", q("button.kind.cursor").length > 0);

const before = fetched.length;
key("l");
await wait(400);
ok(
  "l from the sidebar opens logs for the focused (second) pane",
  fetched.length === before + 1,
  `${JSON.stringify(fetched)}`,
);
ok("both panes survive it", q(".primary-pane").length === 2);

ok("no crash", !crash, crash);
console.log(failed ? `\nFAILED (${failed})` : "\nPASS");
process.exit(failed ? 1 : 0);
