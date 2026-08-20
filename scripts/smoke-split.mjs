/**
 * E2E for the split (2-pane) view in jsdom. Drives: connect → select Pod →
 * split → give pane 2 a DIFFERENT kind (Node) → assert the two panes hold
 * independent data, independent search, and per-pane share/context.
 *
 * Catches the class of bug where the per-pane render leaks the focused
 * pane's state into the other pane. Run: node scripts/smoke-split.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
Object.assign(global, {
  window: dom.window,
  document: dom.window.document,
  Window: dom.window.Window || dom.window.constructor,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle,
  customElements: dom.window.customElements,
  localStorage: dom.window.localStorage,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  MutationObserver: dom.window.MutationObserver,
});
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const ctx = {
  name: "smoke",
  cluster: "c",
  user: "u",
  namespace: null,
  is_current: true,
  source: "",
  server: "https://smoke.example:6443",
};
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const nodeType = { group: "", version: "v1", kind: "Node", plural: "nodes", namespaced: false, deletable: true, editable: true };
const types = [podType, nodeType];

const mkTable = (prefix, cols, n) => ({
  columns: cols.map((name) => ({ name, priority: 0 })),
  rows: Array.from({ length: n }, (_, i) => ({
    name: `${prefix}-${i}`,
    namespace: prefix === "pod" ? `ns-${i % 5}` : null,
    cells: cols.map((c, ci) => (ci === 0 ? `${prefix}-${i}` : c === "Status" ? "Running" : "x")),
    labels: { app: `svc-${i % 3}` },
  })),
  truncated: false,
  resource_version: "1",
  include: "None",
});
const podTable = mkTable("pod", ["Name", "Ready", "Status"], 300);
const nodeTable = mkTable("node", ["Name", "Status", "Roles"], 40);

dom.window.localStorage.setItem(
  "pigeoneye.session",
  JSON.stringify({ tabs: ["smoke"], active: "smoke" }),
);

dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve(types);
      case "list_namespaces": return Promise.resolve(["ns-0", "ns-1"]);
      case "list_resources":
        return Promise.resolve(args?.resource?.kind === "Node" ? nodeTable : podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_stats": return Promise.resolve([]);
      case "node_stats": return Promise.resolve([]);
      case "ensure_index": return Promise.resolve(null);
      case "filter_rows": return Promise.resolve([]);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f,
  convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }

let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
dom.window.addEventListener("unhandledrejection", (e) => (crash = String(e.reason)));

const fail = (why, detail) => {
  console.error(`SPLIT SMOKE FAILED — ${why}`);
  if (detail) console.error(String(detail).slice(0, 1500));
  process.exit(1);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];
const md = (el) => el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));

await import(`../dist/assets/${bundle}`);
await wait(400);

// launcher → connect
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
// sidebar → Pod
const pickKind = (kind) => q("button.kind").find((b) => b.textContent?.trim().startsWith(kind));
pickKind("Pod")?.click();
await wait(400);
if (crash) fail("crash before split", crash);

let panes = q(".primary-pane");
if (panes.length !== 1) fail(`expected 1 pane before split, got ${panes.length}`);

// click the split button
const splitBtn = q("button.split-toggle")[0];
if (!splitBtn) fail("no split button");
splitBtn.click();
await wait(500);
if (crash) fail("crash on split", crash);

panes = q(".primary-pane");
if (panes.length !== 2) fail(`expected 2 panes after split, got ${panes.length}`, root().innerHTML.replace(/<[^>]+>/g, "").slice(0, 400));

// both panes should render a Pod table (pane 2 cloned pane 1)
const paneKind = (p) => q(".content-head h2", p)[0]?.textContent?.replace(/\s+/g, " ").trim() || "";
const paneRows = (p) => q("tr.row", p).length;
if (!paneKind(panes[0]).includes("Pod")) fail(`pane 0 not Pod after split: "${paneKind(panes[0])}"`);
if (!paneKind(panes[1]).includes("Pod")) fail(`pane 1 not Pod after split: "${paneKind(panes[1])}"`);
if (paneRows(panes[0]) === 0) fail("pane 0 has no rows after split");
if (paneRows(panes[1]) === 0) fail("pane 1 has no rows after split");

// focus pane 2 and switch it to Node — pane 1 must stay Pod (independence)
md(panes[1]);
await wait(50);
pickKind("Node")?.click();
await wait(500);
if (crash) fail("crash switching pane 2 to Node", crash);
panes = q(".primary-pane");
const k0 = paneKind(panes[0]);
const k1 = paneKind(panes[1]);
if (!k0.includes("Pod")) fail(`INDEPENDENCE BROKEN: pane 0 changed away from Pod → "${k0}"`);
if (!k1.includes("Node")) fail(`pane 2 did not switch to Node → "${k1}"`);
// pane 0 must still show pod rows, pane 2 node rows
const rowText = (p) => q("tr.row", p).map((r) => r.textContent || "").join(" ");
if (!/pod-\d/.test(rowText(panes[0]))) fail("pane 0 lost its pod rows (data leak)");
if (!/node-\d/.test(rowText(panes[1]))) fail("pane 2 has no node rows");
if (/node-\d/.test(rowText(panes[0]))) fail("DATA LEAK: pane 0 shows node rows from pane 2");
if (/pod-\d/.test(rowText(panes[1]))) fail("DATA LEAK: pane 2 shows pod rows from pane 1");

// per-pane search independence: search in pane 0, pane 2 unaffected
md(panes[0]);
await wait(50);
const search0 = q("input.search.wide", panes[0])[0];
if (!search0) fail("pane 0 has no search box");
search0.value = "pod-77";
search0.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await wait(300);
if (crash) fail("crash searching pane 0", crash);
panes = q(".primary-pane");
const p0rows = paneRows(panes[0]);
const p1rows = paneRows(panes[1]);
if (p0rows === 0) fail("pane 0 search matched nothing (should match pod-77)");
if (p0rows >= 300) fail(`pane 0 search did not filter (still ${p0rows} rows)`);
if (p1rows < 40) fail(`SEARCH LEAK: pane 2 rows dropped to ${p1rows} when searching pane 0`);

// per-pane context badge + share buttons render per pane
const badges = q(".pane-ctx");
if (badges.length < 2) fail(`expected a context badge per pane, got ${badges.length}`);
const shareBtns = q("button.share-btn");
if (shareBtns.length < 2) fail(`expected a share button per pane, got ${shareBtns.length}`);

console.log(
  `split smoke ok — 2 panes, independent kinds (pane0=${k0.split(" ")[0]} pane1=${k1.split(" ")[0]}), ` +
  `pane0 search→${p0rows} rows while pane2 held ${p1rows}, badges+share per pane`,
);
process.exit(0);
