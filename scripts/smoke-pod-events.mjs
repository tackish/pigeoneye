/**
 * E2E for the Event column on the pod list (jsdom). Asserts the column shows
 * the newest WARNING event per pod next to STATUS, that a healthy pod's cell
 * is empty (empty == nothing wrong is the whole reading), that the message
 * rides along as the cell's tooltip, that a warning arriving later lands
 * without the pod list changing, and — the perf contract — that an unchanged
 * sweep does NOT swap the map and so rebuilds no display rows.
 * Run: node scripts/smoke-pod-events.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";
import { podEventSignature, shouldPublishEvents } from "../src/podevents.ts";

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
const podTable = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: [
    { name: "healthy-1", namespace: "sre", cells: ["healthy-1", "1/1", "Running", "0", "5h"], labels: {} },
    { name: "stuck-1", namespace: "sre", cells: ["stuck-1", "0/1", "Pending", "0", "2m"], labels: {} },
    { name: "flappy-1", namespace: "sre", cells: ["flappy-1", "0/1", "Running", "7", "9m"], labels: {} },
  ],
  truncated: false, resource_version: "1", include: "Metadata",
};

// Sweep 1: two warnings. Sweep 2+: identical (the steady state we must not
// rebuild on). A later sweep adds a warning for the pod that had none.
let eventCalls = 0;
let addLate = false;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
// still going on (40s) vs long over (52m) — the column has to tell them apart
const warnStuck = { key: "sre/stuck-1", reason: "FailedScheduling", message: "0/50 nodes are available: insufficient cpu.", count: 1, last: ago(40_000) };
const warnFlappy = { key: "sre/flappy-1", reason: "Unhealthy", message: "Readiness probe failed: connection refused", count: 12, last: ago(52 * 60_000) };
const warnLate = { key: "sre/healthy-1", reason: "NodeNotReady", message: "Node ip-10-200-145-211 status is now: NodeNotReady", count: 1, last: ago(10_000) };

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["sre"]);
      case "list_resources": return Promise.resolve(podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_events":
        eventCalls++;
        return Promise.resolve(addLate ? [warnStuck, warnFlappy, warnLate] : [warnStuck, warnFlappy]);
      case "get_events": return Promise.resolve([]);
      case "pod_stats": return Promise.reject(new Error("metrics API unavailable"));
      case "node_stats": return Promise.resolve([]);
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];

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
await wait(800);

console.log("pod event column");

const headers = () =>
  q("thead th").map((h) => h.textContent.replace(/[^\w%/]/g, "").toUpperCase());
const rowCells = (name) => {
  const tr = q("tbody tr.row").find((r) => r.textContent.includes(name));
  return tr ? q("td", tr).map((td) => td.textContent.trim()) : null;
};
const rowTds = (name) => {
  const tr = q("tbody tr.row").find((r) => r.textContent.includes(name));
  return tr ? q("td", tr) : [];
};

const hs = headers();
const evIdx = hs.indexOf("RECENTEVENT");
ok("the Event column is present", evIdx >= 0, hs.join(","));
ok("it sits right after STATUS", evIdx === hs.indexOf("STATUS") + 1, hs.join(","));

const stuck = rowCells("stuck-1");
ok("an unschedulable pod shows its reason", /^FailedScheduling\b/.test(stuck?.[evIdx] ?? ""), JSON.stringify(stuck));
ok("with how long ago it happened", / · \d+s$/.test(stuck?.[evIdx] ?? ""), JSON.stringify(stuck?.[evIdx]));

const flappy = rowCells("flappy-1");
ok("a repeating warning carries its count", /^Unhealthy ×12\b/.test(flappy?.[evIdx] ?? ""), JSON.stringify(flappy));
ok("an old warning shows its age too", / · 52m$/.test(flappy?.[evIdx] ?? ""), JSON.stringify(flappy?.[evIdx]));

const healthy = rowCells("healthy-1");
ok("a healthy pod's cell is empty", healthy?.[evIdx] === "", JSON.stringify(healthy));

ok(
  "the message is the tooltip",
  rowTds("stuck-1")[evIdx]?.getAttribute("title") === warnStuck.message,
  rowTds("stuck-1")[evIdx]?.getAttribute("title"),
);
ok(
  "a healthy pod gets no tooltip",
  !rowTds("healthy-1")[evIdx]?.getAttribute("title"),
);
ok(
  "a warning that may still be happening is red",
  rowTds("stuck-1")[evIdx]?.className.includes("bad"),
  rowTds("stuck-1")[evIdx]?.className,
);
ok(
  "one that is long over is muted instead",
  rowTds("flappy-1")[evIdx]?.className.includes("stale"),
  rowTds("flappy-1")[evIdx]?.className,
);
ok(
  "and it is not also red",
  !rowTds("flappy-1")[evIdx]?.className.includes("bad"),
  rowTds("flappy-1")[evIdx]?.className,
);
ok(
  "an empty cell is neither",
  !/bad|stale/.test(rowTds("healthy-1")[evIdx]?.className ?? ""),
  rowTds("healthy-1")[evIdx]?.className,
);

// The column must not disturb the ones it was inserted between.
ok("STATUS still reads correctly", rowCells("stuck-1")?.[hs.indexOf("STATUS")] === "Pending");
ok("RESTARTS still reads correctly", rowCells("flappy-1")?.[hs.indexOf("RESTARTS")] === "7");
ok("AGE still reads correctly", rowCells("healthy-1")?.[hs.indexOf("AGE")] === "5h");

// The perf contract: an unchanged sweep must not swap the map, because that
// would rebuild every display row — the row cache keys on the map's identity.
const sweeps = eventCalls;
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(600);
ok("re-opening the list sweeps again", eventCalls > sweeps, `${eventCalls} vs ${sweeps}`);

// Unchanged warnings must not republish the map, whatever order the API
// server hands them back in.
const sigA = podEventSignature([warnStuck, warnFlappy]);
const sigB = podEventSignature([warnFlappy, warnStuck]);
ok("the signature ignores the order events arrive in", sigA === sigB, `${sigA} vs ${sigB}`);
ok("an unchanged sweep does not republish", !shouldPublishEvents(sigA, sigB, true));
ok(
  "a changed count does republish",
  shouldPublishEvents(sigA, podEventSignature([warnStuck, { ...warnFlappy, count: 13 }]), true),
);
ok(
  "a changed reason does republish",
  shouldPublishEvents(sigA, podEventSignature([warnStuck, { ...warnFlappy, reason: "BackOff" }]), true),
);
ok("a cleared warning does republish", shouldPublishEvents(sigA, podEventSignature([warnStuck]), true));
ok(
  "an all-clear cluster still publishes its first sweep",
  shouldPublishEvents(undefined, podEventSignature([]), false),
);
ok(
  "and does not publish the ones after it",
  !shouldPublishEvents(podEventSignature([]), podEventSignature([]), true),
);

// A warning that shows up later must land on its own, with the pod list
// itself unchanged — that is the case the column exists for.
addLate = true;
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(600);
const hs2 = headers();
ok(
  "a new warning reaches a previously clean pod",
  /^NodeNotReady\b/.test(rowCells("healthy-1")?.[hs2.indexOf("RECENTEVENT")] ?? ""),
  JSON.stringify(rowCells("healthy-1")),
);
ok(
  "the pods that were already warning keep theirs",
  /^FailedScheduling\b/.test(rowCells("stuck-1")?.[hs2.indexOf("RECENTEVENT")] ?? ""),
  JSON.stringify(rowCells("stuck-1")),
);

ok("no crash", !crash, crash);
console.log(failed ? `\nFAILED (${failed})` : "\nPASS");
process.exit(failed ? 1 : 0);
