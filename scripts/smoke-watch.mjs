/**
 * E2E for the watch delta in jsdom: the path that folds streamed ADDED /
 * MODIFIED / DELETED events into the listed table.
 *
 * Nothing else drives watch events, so the whole apply-a-batch path — the
 * one that decides which rows change, appear and vanish while a cluster is
 * live — had no coverage at all. Drives real events through the Tauri
 * channel and asserts the exact row set after each batch, on both panes:
 * the secondary keeps its own watch and used to fold batches with its own
 * copy of the code.
 *
 * Run: node scripts/smoke-watch.mjs
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
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "" };
const types = [
  { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true },
  { group: "", version: "v1", kind: "Node", plural: "nodes", namespaced: false, deletable: true, editable: true },
];
// owner_kind is pinned off DaemonSet: an all-namespace pod list sinks those
// to the bottom, which would reorder the rows these assertions read.
const pod = (n, status = "Running") => ({
  name: `pod-${n}`,
  namespace: `ns-${n % 3}`,
  cells: [`pod-${n}`, "1/1", status],
  labels: { app: "svc" },
  owner_kind: "ReplicaSet",
});
// Cluster-scoped rows carry namespace: null, which the delta has to treat
// as the same bucket as "". A node dropping out of the list is exactly the
// case the coalescing window is bypassed for, so it gets its own pass.
const node = (n, status = "Ready") => ({
  name: `node-${n}`,
  namespace: null,
  cells: [`node-${n}`, status],
  labels: {},
  owner_kind: null,
});
const NODE_COUNT = 5;
const mkNodeTable = () => ({
  columns: [
    { name: "Name", priority: 0 },
    { name: "Status", priority: 0 },
  ],
  rows: Array.from({ length: NODE_COUNT }, (_, i) => node(i)),
  truncated: false,
  resource_version: "1",
  include: "None",
});

const COUNT = 12;
const mkTable = () => ({
  columns: [
    { name: "Name", priority: 0 },
    { name: "Ready", priority: 0 },
    { name: "Status", priority: 0 },
  ],
  rows: Array.from({ length: COUNT }, (_, i) => pod(i)),
  truncated: false,
  resource_version: "1",
  include: "None",
});

dom.window.localStorage.setItem(
  "pigeoneye.session",
  JSON.stringify({ tabs: ["smoke"], active: "smoke" }),
);

// Every watch_start hands us its channel; pane 0's is the first, the
// secondary pane's is whatever the split opens after it.
const chans = [];
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve(types);
      case "list_namespaces": return Promise.resolve(["ns-0", "ns-1", "ns-2"]);
      case "list_resources":
        return Promise.resolve(args.resource?.kind === "Node" ? mkNodeTable() : mkTable());
      case "cached_list": return Promise.resolve(null);
      case "pod_stats": return Promise.resolve([]);
      case "filter_rows": return Promise.resolve([]);
      case "ensure_index": return Promise.resolve(null);
      case "watch_start": chans.push(args.channel); return Promise.resolve(chans.length);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f,
  convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) {
  console.error("no bundle in dist/assets — run `npm run build` first");
  process.exit(1);
}

let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
dom.window.addEventListener("unhandledrejection", (e) => (crash = String(e.reason)));

const fail = (why, detail) => {
  console.error(`WATCH SMOKE FAILED — ${why}`);
  if (detail) console.error(String(detail).slice(0, 1500));
  process.exit(1);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];

await import(`../dist/assets/${bundle}`);
await wait(400);

q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(600);
if (crash) fail("crash before any watch event", crash);

const namesIn = (el) =>
  q("tr.row", el).map((r) => (r.textContent || "").match(/pod-\d+/)?.[0] ?? "?");
const statusOf = (name, el = root()) => {
  const tr = q("tr.row", el).find((r) => (r.textContent || "").includes(name + " ") || namesIn(el).includes(name) && (r.textContent || "").match(/pod-\d+/)?.[0] === name);
  return tr ? [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim()) : null;
};
const expect = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}\n  expected ${b}\n  got      ${a}`);
};

if (!chans.length) fail("the list never started a watch — nothing to drive");
const primary = chans[0];
// The watch coalesces non-delete events behind a 700ms window; deletes get
// their own shorter one. Settle past both before reading the table.
const send = async (chan, type, rows, settle = 950) => {
  chan.onmessage({ type, rows });
  await wait(settle);
  if (crash) fail(`crash applying ${type}`, crash);
};

const base = Array.from({ length: COUNT }, (_, i) => `pod-${i}`);
expect("baseline row set", namesIn(root()), base);

// 1. MODIFIED replaces a row in place: same set, same order, new cells.
await send(primary, "MODIFIED", [pod(3, "CrashLoopBackOff")]);
expect("MODIFIED kept the row set", namesIn(root()), base);
const cells3 = statusOf("pod-3");
if (!cells3 || !cells3.some((c) => c === "CrashLoopBackOff"))
  fail("MODIFIED did not update the row's cells", JSON.stringify(cells3));

// 2. A row the list has never seen is appended.
await send(primary, "ADDED", [pod(99)]);
expect("ADDED appended the new row", namesIn(root()), [...base, "pod-99"]);

// 3. DELETED drops rows — including the first and the last, where an
//    index-shifting removal is easiest to get wrong.
await send(primary, "DELETED", [pod(0)]);
await send(primary, "DELETED", [pod(99)]);
expect("DELETED dropped first and last", namesIn(root()), base.slice(1));

// 4. A burst, the rollout case: many deletes landing at once.
const burst = [2, 4, 5, 7, 9, 10];
for (const n of burst) primary.onmessage({ type: "DELETED", rows: [pod(n)] });
await wait(1200);
if (crash) fail("crash applying a delete burst", crash);
const afterBurst = base.slice(1).filter((n) => !burst.includes(Number(n.split("-")[1])));
expect("delete burst dropped exactly the right rows", namesIn(root()), afterBurst);

// 5. A delete for something the list doesn't hold must change nothing.
await send(primary, "DELETED", [pod(777)]);
expect("delete of an unlisted row changed the table", namesIn(root()), afterBurst);

// 6. Cluster-scoped rows (namespace: null). A node going away is the case
//    the delete path exists for, and null must not be treated as a
//    namespace distinct from "".
q("button.kind").find((b) => b.textContent?.trim().startsWith("Node"))?.click();
await wait(700);
if (crash) fail("crash selecting Node", crash);
const nodeChan = chans[chans.length - 1];
const nodeBase = Array.from({ length: NODE_COUNT }, (_, i) => `node-${i}`);
const nodeNames = (el) =>
  q("tr.row", el).map((r) => (r.textContent || "").match(/node-\d+/)?.[0] ?? "?");
expect("cluster-scoped baseline", nodeNames(root()), nodeBase);

await send(nodeChan, "MODIFIED", [node(2, "NotReady")]);
expect("cluster-scoped MODIFIED kept the row set", nodeNames(root()), nodeBase);
const trNode2 = q("tr.row").find((r) => (r.textContent || "").match(/node-\d+/)?.[0] === "node-2");
if (!trNode2 || !trNode2.textContent?.includes("NotReady"))
  fail("cluster-scoped MODIFIED did not update the row", trNode2?.textContent || "(row gone)");

await send(nodeChan, "DELETED", [node(0)]);
expect("cluster-scoped DELETED dropped the row", nodeNames(root()), nodeBase.slice(1));

// back to Pod so the split below clones a pod list
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(700);
if (crash) fail("crash returning to Pod", crash);

// 7. The secondary pane keeps its own watch; folding a batch there must
//    hit pane 2 and leave pane 1 alone.
const splitBtn = q("button.split-toggle")[0];
if (!splitBtn) fail("no split button — cannot reach the secondary watch");
const before = chans.length;
splitBtn.click();
await wait(700);
if (crash) fail("crash opening the split", crash);
const panes = q(".primary-pane");
if (panes.length !== 2) fail(`expected 2 panes after split, got ${panes.length}`);
if (chans.length <= before) fail("the secondary pane never started its own watch");
const secondary = chans[chans.length - 1];

const pane2Base = namesIn(panes[1]);
if (!pane2Base.length) fail("secondary pane rendered no rows");
const pane1Before = namesIn(panes[0]);

await send(secondary, "DELETED", [pod(1)]);
const panes2 = q(".primary-pane");
expect(
  "secondary watch dropped the row in pane 2",
  namesIn(panes2[1]),
  pane2Base.filter((n) => n !== "pod-1"),
);
expect("secondary watch leaked into pane 1", namesIn(panes2[0]), pane1Before);

console.log(
  `watch smoke ok — MODIFIED/ADDED/DELETED, a ${burst.length}-row delete burst, ` +
    `a delete for an unlisted row, cluster-scoped (null-namespace) rows, and the ` +
    `secondary pane's own watch all fold correctly`,
);
process.exit(0);
