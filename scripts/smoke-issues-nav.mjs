/**
 * Locks the Issues view's keyboard behaviour (jsdom).
 *
 * Written BEFORE virtualising the list, so the refactor has to keep every one
 * of these true. The dangerous one is Enter: it opens a real resource, so the
 * row under the cursor and the resource that opens must never disagree.
 * Run: node scripts/smoke-issues-nav.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const N = 60;
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
// jsdom has no layout, so these are no-ops here; the app calls them while moving
// the cursor and would otherwise throw.
dom.window.Element.prototype.scrollIntoView = function () {};
dom.window.Element.prototype.scrollTo = function () {};

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const STATES = ["CrashLoopBackOff", "ImagePullBackOff", "Pending", "Error", "OOMKilled"];
// Two clusters' worth of grouping is what makes the flat index non-obvious.
const issues = Array.from({ length: N }, (_, i) => ({
  context: "smoke", kind: "Pod", namespace: `ns-${i % 4}`,
  name: `bad-${String(i).padStart(3, "0")}`, status: STATES[i % STATES.length],
}));
const podTable = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: issues.map((i) => ({ name: i.name, namespace: i.namespace, cells: [i.name, "0/1", i.status, "0", "1m"], labels: {} })),
  truncated: false, resource_version: "1", include: "Metadata",
};
const detailFor = (name, ns) => ({
  name, namespace: ns, created: "2026-01-01T00:00:00Z", labels: {}, annotations: {},
  status: { phase: "Pending" }, unschedulable: null, node_name: null, ports: [], containers: ["c"],
  resource_version: "1", involved: null, links: [], has_pod_selector: false, pod_selector: null,
  secret_data: [], replicas: null, ready_replicas: null, generation: null, yaml: "kind: Pod\n",
});

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["ns-0", "ns-1", "ns-2", "ns-3"]);
      case "list_resources": return Promise.resolve(podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "get_resource": return Promise.resolve(detailFor(args?.name, args?.namespace));
      case "get_events": return Promise.resolve([]);
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
let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
dom.window.addEventListener("unhandledrejection", (e) => (crash = String(e.reason)));
const fail = (why, d) => { console.error(`ISSUES-NAV SMOKE FAILED — ${why}`); if (d) console.error(String(d).slice(0, 600)); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];
const key = (k) => document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const openIssues = async () => {
  q("button").find((b) => /issues/i.test(b.textContent || ""))?.click();
  await wait(400);
};
// The row the user sees as selected, and the issue index it claims to be.
const cursor = () => {
  const r = q(".iss-row.cursor")[0];
  if (!r) return null;
  return { ii: Number(r.getAttribute("data-ii")), name: (r.querySelector(".iss-name")?.textContent || "").trim() };
};

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(1500);
await openIssues();
if (crash) fail("crash opening Issues", crash);
if (!q(".iss-row").length) fail("no issue rows rendered");

// 1. the cursor starts on the first issue
let c = cursor();
if (!c) fail("no row carries the cursor when the view opens");
if (c.ii !== 0 || c.name !== issues[0].name)
  fail(`cursor should start on issue 0 (${issues[0].name}), got ii=${c.ii} name=${c.name}`);

// 2. j/↓ walks one issue at a time, and the marked row matches the index
for (const [i, k] of [[1, "j"], [2, "ArrowDown"], [3, "j"]]) {
  key(k); await wait(80);
  c = cursor();
  if (!c) fail(`cursor disappeared after ${k}`);
  if (c.ii !== i || c.name !== issues[i].name)
    fail(`after ${i} step(s) expected issue ${i} (${issues[i].name}), got ii=${c.ii} name=${c.name}`);
}
// 3. k/↑ walks back
key("k"); await wait(80);
c = cursor();
if (c.ii !== 2) fail(`↑ should step back to 2, got ${c.ii}`);

// 4. THE CRITICAL ONE: Enter opens exactly the resource under the cursor
const target = issues[c.ii];
key("Enter");
await wait(900);
if (crash) fail("crash on Enter", crash);
const title = (q(".drawer-head h3")[0]?.textContent || "").trim();
if (!title.includes(target.name))
  fail(`Enter opened the wrong resource: cursor was on ${target.name}, drawer shows "${title}"`);

// 5. paging moves by more than one and stays consistent
await openIssues();
await wait(200);
const before = cursor();
key("PageDown"); await wait(150);
const after = cursor();
if (!after) fail("cursor lost after PageDown");
if (after.ii <= before.ii) fail(`PageDown did not advance: ${before.ii} -> ${after.ii}`);
if (after.name !== issues[after.ii].name)
  fail(`after PageDown the marked row and its index disagree: ii=${after.ii} shows ${after.name}, expected ${issues[after.ii].name}`);

// 6. the end is clamped, not wrapped or overrun
for (let i = 0; i < N + 10; i++) key("j");
await wait(200);
c = cursor();
if (c.ii !== N - 1 || c.name !== issues[N - 1].name)
  fail(`cursor should clamp at the last issue (${N - 1}), got ii=${c.ii} name=${c.name}`);

// 7. clamps at the start too
for (let i = 0; i < N + 10; i++) key("k");
await wait(200);
c = cursor();
if (c.ii !== 0 || c.name !== issues[0].name)
  fail(`cursor should clamp at the first issue, got ii=${c.ii} name=${c.name}`);

// 8. THE VIRTUALISATION RISK: drive the cursor deep into the list. Whatever is
//    rendered, the cursored row must still exist in the DOM and still agree
//    with its index — a windowed list has to follow the cursor.
const deep = N - 5;
for (let i = 0; i < deep; i++) key("j");
await wait(250);
c = cursor();
if (!c) fail(`the cursored row vanished from the DOM at issue ${deep} — a windowed list must scroll to follow the cursor`);
if (c.ii !== deep || c.name !== issues[deep].name)
  fail(`deep in the list the marked row and its index disagree: ii=${c.ii} shows ${c.name}, expected ${issues[deep].name}`);

// 9. clicking a row deep in the list opens that row's resource, not another
const deepRow = q(".iss-row.cursor")[0];
const deepName = (deepRow.querySelector(".iss-name")?.textContent || "").trim();
deepRow.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await wait(900);
if (crash) fail("crash clicking a row", crash);
const deepTitle = (q(".drawer-head h3")[0]?.textContent || "").trim();
if (!deepTitle.includes(deepName))
  fail(`clicking a row opened the wrong resource: clicked ${deepName}, drawer shows "${deepTitle}"`);

// 10. grouping survives: a header per cluster, carrying that cluster's count
await openIssues();
await wait(300);
const heads = q(".iss-group-head");
if (heads.length < 1) fail("the cluster group header is gone");
const headText = (heads[0].textContent || "").replace(/\s+/g, " ").trim();
if (!headText.includes("smoke")) fail(`group header lost its cluster name: "${headText}"`);
if (!headText.includes(String(N))) fail(`group header lost its count (expected ${N}): "${headText}"`);

// 11. row content: the status badge and the name are both rendered, and a
//     hard-failure status is marked critical while a soft one is not
const anyRow = q(".iss-row")[0];
if (!anyRow.querySelector(".iss-name")) fail("rows lost their name");
if (!anyRow.querySelector(".iss-badge")) fail("rows lost their status badge");
const badges = q(".iss-row .iss-badge");
if (!badges.some((b) => b.classList.contains("crit")))
  fail("no status is marked critical — CrashLoopBackOff/Error should be");
if (!badges.some((b) => !b.classList.contains("crit")))
  fail("every status is marked critical — Pending should not be");

// 12. the summary count stays honest
const summary = (q(".iss-summary")[0]?.textContent || "").replace(/\s+/g, " ");
if (!summary.includes(String(N))) fail(`summary should report ${N} issues, shows "${summary}"`);

// 13. ⌥ +/- resizes table rows, and the Issues rows ride the same --row-h.
//     The windowing arithmetic is built on that number, so a change must not
//     empty the list or lose the cursor.
const rowHOf = () =>
  Number((document.documentElement.style.getPropertyValue("--row-h") || "0").replace("px", ""));
const h0 = rowHOf();
if (!h0) fail("--row-h is not set, so Issues rows have no height to follow");
const alt = (code) =>
  document.body.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { code, altKey: true, bubbles: true, cancelable: true }),
  );
const curBefore = cursor();
if (!curBefore) fail("no cursor before the row height changes");
alt("Equal"); await wait(150);
const hUp = rowHOf();
if (hUp <= h0) fail(`⌥+ did not grow the row height: ${h0} -> ${hUp}`);
if (!q(".iss-row").length) fail("the Issues list emptied when the row height changed");
c = cursor();
if (!c || c.ii !== curBefore.ii || c.name !== curBefore.name)
  fail(`the cursor moved when the row height grew: ${curBefore.ii}/${curBefore.name} -> ${c && c.ii}/${c && c.name}`);
alt("Minus"); alt("Minus"); await wait(150);
const hDown = rowHOf();
if (hDown >= hUp) fail(`⌥- did not shrink the row height: ${hUp} -> ${hDown}`);
if (!q(".iss-row").length) fail("the Issues list emptied when the row height shrank");
if (!cursor()) fail("cursor lost when the row height shrank");

console.log(
  `issues-nav smoke ok — cursor starts at 0 and clamps both ends, j/k step, PageDown pages, ` +
  `the cursor stays in the DOM deep in the list (issue ${deep}), click and Enter both open exactly ` +
  `the cursored resource, grouping/badges/summary intact, and ⌥ +/- still resizes these rows`,
);
process.exit(0);
