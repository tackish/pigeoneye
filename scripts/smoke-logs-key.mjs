/**
 * E2E for `l` meaning logs wherever you are (jsdom).
 *
 * The bug this guards: the sidebar bound `l` as a vim motion ("move right"),
 * so with the pod list fully on screen but focus still on the sidebar — right
 * after Esc, or at launch — `l` silently moved focus and opened nothing. It
 * read as "l sometimes doesn't work" and cost a keystroke to find out.
 *
 * Opening a terminal needs xterm, which jsdom cannot run, so these pods carry
 * two containers: `l` then stops at the container picker, one step short of
 * the terminal, and the get_resource it must fetch first is the signal.
 * Run: node scripts/smoke-logs-key.mjs
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
    { name: "pod-b", namespace: "ns", cells: ["pod-b", "2/2", "Running", "0", "6m"], labels: {} },
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

let fetched = [];
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
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];
const key = (k) => document.body.dispatchEvent(
  new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
);

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(700);

console.log("logs key");
ok("the pod list is up", q("tbody tr.row").length === 2);

// 1. the case that always worked: focus in the table.
key("l");
await wait(400);
ok("l from the table opens logs", fetched.join() === "pod-a", JSON.stringify(fetched));

// 2. step back out to the sidebar — the list stays on screen the whole time.
key("Escape"); await wait(150);   // leave the container picker
key("j"); await wait(100);        // cursor to pod-b
key("Escape"); await wait(200);   // table -> sidebar
ok("focus is on the sidebar", q("button.kind.cursor").length > 0);
ok("the list is still on screen", q("tbody tr.row").length === 2);

// 3. the regression: l must open logs from here too, in ONE press.
const before = fetched.length;
key("l");
await wait(400);
ok(
  "l from the sidebar opens logs in one press",
  fetched.length === before + 1 && fetched.at(-1) === "pod-b",
  JSON.stringify(fetched),
);
ok("and it stepped into the list", q("button.kind.cursor").length === 0);

// 4. plain → must still only move focus, so arrowing around opens nothing.
key("Escape"); await wait(150);
key("Escape"); await wait(200);
ok("back on the sidebar", q("button.kind.cursor").length > 0);
const beforeArrow = fetched.length;
key("ArrowRight");
await wait(300);
ok("→ only moves focus", fetched.length === beforeArrow, JSON.stringify(fetched));
ok("but it did move", q("button.kind.cursor").length === 0);

ok("no crash", !crash, crash);
console.log(failed ? `\nFAILED (${failed})` : "\nPASS");
process.exit(failed ? 1 : 0);
