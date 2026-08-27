/**
 * E2E for the workload rollout/sync badge (jsdom). Opens a Deployment that is
 * mid-rollout, asserts the detail shows a "Rolling out" badge with the replica
 * note, then lets the background poll re-fetch (get_resource flips to a settled
 * status) and asserts the badge turns into "Synced" on its own — verifying both
 * the status derivation and the auto-refresh-while-progressing loop.
 * Run: node scripts/smoke-rollout.mjs
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
const deployType = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true, deletable: true, editable: true };
const deployTable = {
  columns: ["Name", "Ready", "Up-to-date", "Available", "Age"].map((name) => ({ name, priority: 0 })),
  rows: [
    // rolling: UP-TO-DATE 1 < DESIRED 3 → new pods still spreading
    { name: "web", namespace: "default", cells: ["web", "1/3", "1", "1", "5m"], labels: { app: "web" } },
    // fully rolled out (UP-TO-DATE 3 == 3) but 1 pod not ready → NOT rolling,
    // a health state — must show NO dot (this is the DaemonSet 116/118 case)
    { name: "api", namespace: "default", cells: ["api", "2/3", "3", "2", "9d"], labels: { app: "api" } },
  ],
  truncated: false, resource_version: "1", include: "Metadata",
};

const baseDetail = (name, ready) => ({
  name, namespace: "default", created: "2026-08-27T00:00:00Z", labels: { app: name }, annotations: {},
  unschedulable: null, node_name: null, ports: [], containers: [name], resource_version: "100",
  involved: null, links: [], has_pod_selector: true, pod_selector: `app%3D${name}`, secret_data: [],
  replicas: 3, ready_replicas: ready, generation: 5, yaml: `kind: Deployment\nmetadata:\n  name: ${name}\n`,
});
const statusRolling = { observedGeneration: 5, replicas: 3, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1, unavailableReplicas: 2,
  conditions: [{ type: "Progressing", status: "True", reason: "ReplicaSetUpdated" }, { type: "Available", status: "False" }] };
const statusSynced = { observedGeneration: 5, replicas: 3, updatedReplicas: 3, readyReplicas: 3, availableReplicas: 3, unavailableReplicas: 0,
  conditions: [{ type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" }, { type: "Available", status: "True" }] };
// fully updated (updated 3/3) but 1 pod unavailable → "Not fully available", NOT "Rolling out"
const statusPartial = { observedGeneration: 5, replicas: 3, updatedReplicas: 3, readyReplicas: 2, availableReplicas: 2, unavailableReplicas: 1,
  conditions: [{ type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" }, { type: "Available", status: "False" }] };

// "web" get_resource flips rolling → settled after the first call so the poll
// (2.5s) picks it up; "api" is always the partial (updated-but-degraded) case.
let getResourceCalls = 0;

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));

dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([deployType]);
      case "list_namespaces": return Promise.resolve(["default"]);
      case "list_resources": return Promise.resolve(deployTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "get_resource": {
        const nm = args?.name;
        if (nm === "api") return Promise.resolve({ ...baseDetail("api", 2), status: statusPartial });
        getResourceCalls++;
        return Promise.resolve({ ...baseDetail("web", getResourceCalls < 2 ? 1 : 3), status: getResourceCalls < 2 ? statusRolling : statusSynced });
      }
      case "get_events": return Promise.resolve([]);
      case "pod_stats": return Promise.resolve([]);
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
const fail = (why, d) => { console.error(`ROLLOUT SMOKE FAILED — ${why}`); if (d) console.error(String(d).slice(0, 900)); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];

await import(`../dist/assets/${bundle}`);
await wait(400);

// connect → Deployment kind → click the row to open its detail
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Deployment"))?.click();
await wait(400);
if (crash) fail("crash before opening detail", crash);
const rows = q("tr.row");
if (rows.length < 2) fail(`expected 2 deployment rows, got ${rows.length}`);
// Only the actively-rolling row (web: UP-TO-DATE 1 < 3) gets a dot. The fully
// rolled-out-but-degraded row (api: UP-TO-DATE 3 == 3, 1 pod not ready) must
// NOT — that's the DaemonSet 116/118 false positive we must avoid.
if (q(".row-rollout-dot", rows[0]).length !== 1)
  fail("mid-rollout row (web) is missing its rollout dot", rows[0].textContent);
if (q(".row-rollout-dot", rows[1]).length !== 0)
  fail("FALSE POSITIVE: fully-updated-but-degraded row (api) shows a rollout dot", rows[1].textContent);
if (q(".row-rollout-dot").length !== 1)
  fail(`expected exactly 1 rollout dot in the list, got ${q(".row-rollout-dot").length}`);
const row = rows[0];
row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await wait(400);
if (crash) fail("crash opening detail", crash);

// mid-rollout → the badge must say "Rolling out" and carry the replica note
let bar = q(".rollout-bar")[0];
if (!bar) fail("no rollout badge on a mid-rollout Deployment", root().innerHTML.replace(/<[^>]+>/g, " ").slice(0, 400));
if (!bar.classList.contains("progressing")) fail(`badge not 'progressing' → class="${bar.className}"`);
if (!/rolling out/i.test(bar.textContent || "")) fail(`badge text not 'Rolling out' → "${(bar.textContent || "").trim()}"`);
if (!/updated 1\/3/.test(bar.textContent || "")) fail(`badge note missing 'updated 1/3' → "${(bar.textContent || "").trim()}"`);

// the auto-refresh poll (2.5s) re-fetches; get_resource now returns settled →
// the badge should flip to Synced with no user action
await wait(3200);
if (crash) fail("crash during rollout poll", crash);
if (getResourceCalls < 2) fail(`auto-refresh never re-fetched (get_resource called ${getResourceCalls}x)`);
bar = q(".rollout-bar")[0];
if (!bar) fail("rollout badge vanished after settle");
if (!bar.classList.contains("synced")) fail(`badge did not flip to 'synced' → class="${bar.className}", text="${(bar.textContent || "").trim()}"`);
if (!/synced/i.test(bar.textContent || "")) fail(`badge text not 'Synced' → "${(bar.textContent || "").trim()}"`);

// open the fully-updated-but-degraded workload (api): the detail badge must be
// "Not fully available" (partial), never "Rolling out" — updated 3/3 but 2/3
// available is a health state, not a rollout.
q("tr.row")[1]?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await wait(400);
if (crash) fail("crash opening the partial workload", crash);
bar = q(".rollout-bar")[0];
if (!bar) fail("no rollout badge on the fully-updated-but-degraded workload");
if (bar.classList.contains("progressing"))
  fail(`FALSE POSITIVE: updated-but-degraded workload labeled 'Rolling out' → "${(bar.textContent || "").trim()}"`);
if (!bar.classList.contains("partial") || !/not fully available/i.test(bar.textContent || ""))
  fail(`updated-but-degraded badge should be 'Not fully available' → class="${bar.className}", text="${(bar.textContent || "").trim()}"`);

console.log(`rollout smoke ok — list dotted only the actively-rolling row; detail showed "Rolling out" (updated 1/3) → auto-refreshed to "Synced"; and a fully-updated-but-degraded workload read "Not fully available", not rolling`);
process.exit(0);
