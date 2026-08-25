/**
 * E2E for the split-view "open Issues in which view?" chooser (jsdom).
 * Reproduces the reported bug: with the split open, pressing Enter on the
 * Issues button did NOT ask which view — it just opened issues in place.
 * Drives: connect → Pod → split → focus sidebar → ↑ to the Issues button →
 * Enter → assert the left/right chooser appears titled "Issues" → keyboard
 * pick "right" → assert pane 2 shows the issues view while pane 1 stays Pod.
 * Run: node scripts/smoke-issue-chooser.mjs
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
const types = [podType, nodeType];
const mkTable = (prefix, cols, n) => ({
  columns: cols.map((name) => ({ name, priority: 0 })),
  rows: Array.from({ length: n }, (_, i) => ({
    name: `${prefix}-${i}`, namespace: prefix === "pod" ? `ns-${i % 5}` : null,
    cells: cols.map((c, ci) => (ci === 0 ? `${prefix}-${i}` : "Running")), labels: {},
  })),
  truncated: false, resource_version: "1", include: "None",
});
const podTable = mkTable("pod", ["Name", "Status"], 120);
const nodeTable = mkTable("node", ["Name", "Status"], 30);

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
      case "list_resources": return Promise.resolve(args?.resource?.kind === "Node" ? nodeTable : podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "aggregate_issues": return Promise.resolve(null);
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
const fail = (why, d) => { console.error(`ISSUE-CHOOSER SMOKE FAILED — ${why}`); if (d) console.error(String(d).slice(0, 900)); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];
const md = (el) => el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
const key = (k) => document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

await import(`../dist/assets/${bundle}`);
await wait(400);

// launcher → connect → Pod → split
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(400);
if (crash) fail("crash before split", crash);
q("button.split-toggle")[0]?.click();
await wait(500);
if (crash) fail("crash on split", crash);
let panes = q(".primary-pane");
if (panes.length !== 2) fail(`expected 2 panes, got ${panes.length}`);

// focus the sidebar (Esc), then walk UP to the Issues button (sideIdx -1)
key("Escape");
await wait(80);
key("ArrowUp"); key("ArrowUp"); key("ArrowUp"); // lands on -1 and stays there
await wait(80);
if (crash) fail("crash navigating to Issues button", crash);
// the Issues button carries the keyboard cursor when sideIdx === -1
const issuesCur = q(".kbd-cur").some((el) => /issue/i.test(el.textContent || ""));
if (!issuesCur) fail("Issues button did not take the keyboard cursor after ↑");

// Enter on the Issues button MUST raise the left/right chooser (the bug:
// it opened issues in place instead)
key("Enter");
await wait(120);
if (crash) fail("crash opening chooser", crash);
const chooser = q(".kind-chooser")[0];
if (!chooser) fail("no chooser popup after Enter on Issues — the bug is present (opened in place)", root().innerHTML.replace(/<[^>]+>/g, " ").slice(0, 400));
if (!/issues/i.test(chooser.textContent || "")) fail(`chooser is not titled "Issues" → "${(chooser.textContent || "").replace(/\s+/g, " ").slice(0, 80)}"`);
// it must offer both views
if (q(".kc-view", chooser).length !== 2) fail(`chooser should offer 2 views, got ${q(".kc-view", chooser).length}`);

// keyboard-pick the RIGHT view and confirm
key("ArrowRight");
await wait(40);
key("Enter");
await wait(300);
if (crash) fail("crash confirming chooser", crash);
if (q(".kind-chooser").length) fail("chooser did not close after confirm");

panes = q(".primary-pane");
if (panes.length !== 2) fail(`lost a pane after confirm, got ${panes.length}`);
// pane 2 shows the issues view; pane 1 stays on the Pod table (independence)
const hasIssues = (p) => q(".iss-body", p).length > 0;
const paneKind = (p) => q(".content-head h2", p)[0]?.textContent?.replace(/\s+/g, " ").trim() || "";
if (!hasIssues(panes[1])) fail("pane 2 did not switch to the issues view", panes[1].innerHTML.replace(/<[^>]+>/g, " ").slice(0, 300));
if (hasIssues(panes[0])) fail("LEAK: pane 1 also switched to issues (should stay Pod)");
if (!paneKind(panes[0]).includes("Pod")) fail(`pane 1 left Pod after opening issues in pane 2 → "${paneKind(panes[0])}"`);

console.log("issue-chooser smoke ok — Enter on Issues raised the left/right chooser (titled Issues); picking right opened issues in pane 2 while pane 1 stayed Pod");
process.exit(0);
