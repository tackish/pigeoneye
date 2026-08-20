/**
 * E2E: a split session is restored on the next launch. Seeds localStorage
 * with a saved split (pane 2 = Node), boots, and asserts two panes come back
 * with pane 2 on Node. Run: node scripts/smoke-persist.mjs
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

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://smoke.example:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const nodeType = { group: "", version: "v1", kind: "Node", plural: "nodes", namespaced: false, deletable: true, editable: true };
const mkTable = (prefix, cols, n) => ({
  columns: cols.map((name) => ({ name, priority: 0 })),
  rows: Array.from({ length: n }, (_, i) => ({
    name: `${prefix}-${i}`, namespace: prefix === "pod" ? `ns-${i % 3}` : null,
    cells: cols.map((c, ci) => (ci === 0 ? `${prefix}-${i}` : "Running")), labels: {},
  })),
  truncated: false, resource_version: "1", include: "None",
});
const podTable = mkTable("pod", ["Name", "Status"], 120);
const nodeTable = mkTable("node", ["Name", "Status"], 30);

// Seed a saved SPLIT session: primary on smoke, pane 2 = Node in smoke.
dom.window.localStorage.setItem(
  "pigeoneye.session",
  JSON.stringify({
    tabs: ["smoke"],
    active: "smoke",
    split: { ctx: "smoke", kind: "/Node", ns: "", width: 50 },
  }),
);

dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "connect": return Promise.resolve(null);
      case "discover": return Promise.resolve([podType, nodeType]);
      case "list_namespaces": return Promise.resolve(["ns-0", "ns-1"]);
      case "list_resources": return Promise.resolve(args?.resource?.kind === "Node" ? nodeTable : podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
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
const fail = (why, d) => { console.error(`PERSIST SMOKE FAILED — ${why}`); if (d) console.error(String(d).slice(0, 800)); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];

await import(`../dist/assets/${bundle}`);
// restore reconnects clusters + re-establishes the split asynchronously
await wait(1200);
if (crash) fail("crash during restore", crash);

const panes = q(".primary-pane");
if (panes.length !== 2) fail(`split not restored — expected 2 panes, got ${panes.length}`, document.getElementById("root").innerHTML.replace(/<[^>]+>/g, "").slice(0, 300));
const kindOf = (p) => [...p.querySelectorAll(".content-head h2")][0]?.textContent?.replace(/\s+/g, " ").trim() || "";
const k1 = kindOf(panes[1]);
if (!k1.includes("Node")) fail(`restored pane 2 is not Node → "${k1}"`);
const p1rows = q(".primary-pane")[1].querySelectorAll("tr.row").length;
if (p1rows === 0) fail("restored pane 2 has no node rows");

console.log(`persist smoke ok — split restored: 2 panes, pane 2 = Node with ${p1rows} rows`);
process.exit(0);
