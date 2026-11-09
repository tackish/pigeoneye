/**
 * E2E for the pod list's Restart reason and Node type columns, and the node
 * list's free-room columns and allocated line (jsdom).
 *
 * Beyond what each shows, this holds the cost contract: a settled list
 * re-reads nothing; a pod whose restart count goes up is re-read, alone; a
 * pod landing on an unknown node refetches the node types once, and a node
 * that still can't be typed is not asked about again. A Forbidden must not
 * park the cluster; a broken credential must.
 * Run: node scripts/smoke-pod-extras.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
// The pod tick is 20s; run timers of 5s or more 100x faster.
const SPEED = 100;
for (const name of ["setInterval", "setTimeout"]) {
  const orig = dom.window[name].bind(dom.window);
  dom.window[name] = (fn, ms, ...rest) => orig(fn, ms >= 5000 ? ms / SPEED : ms, ...rest);
}
const ticks = (n) => (n * 20_000) / SPEED + 60;

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
// The manifest editor measures text; jsdom lays nothing out.
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const nodeType = { group: "", version: "v1", kind: "Node", plural: "nodes", namespaced: false, deletable: true, editable: true };
const col = (name, priority = 0) => ({ name, priority });
const pod = (name, restarts, node) => ({
  name, namespace: "sre", labels: {},
  cells: [name, "1/1", "Running", restarts, "3h", "10.0.0.1", node],
});
const podTable = {
  columns: [col("Name"), col("Ready"), col("Status"), col("Restarts"), col("Age"), col("IP", 1), col("Node", 1)],
  rows: [pod("api-1", "3 (5m ago)", "ip-a"), pod("api-2", "1 (2h ago)", "ip-b"), pod("web-1", "0", "ip-a")],
  truncated: false, resource_version: "1", include: "Metadata",
};
const nodeTable = {
  columns: [col("Name"), col("Status"), col("Roles"), col("Age"), col("Version")],
  rows: ["ip-a", "ip-b"].map((n) => ({
    name: n, namespace: null, cells: [n, "Ready", "<none>", "9d", "v1.31"],
    labels: { "topology.kubernetes.io/zone": "ap-northeast-2a" },
  })),
  truncated: false, resource_version: "1", include: "Metadata",
};
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const exits = [
  { key: "sre/api-1", reason: "OOMKilled", code: 137, at: ago(5 * 60_000), container: "app" },
  { key: "sre/api-2", reason: "Error", code: 1, at: ago(2 * 3600_000), container: "app" },
];
const types = [
  { name: "ip-a", instance: "m6i.xlarge", capacity: "spot", zone: "ap-northeast-2a", pool: "default" },
  { name: "ip-b", instance: "c6i.2xlarge", capacity: "on-demand", zone: "ap-northeast-2c", pool: "batch" },
];
const GiB = 2 ** 30;
const nodeDetail = (name) => ({
  name, namespace: null, created: "2026-10-01T00:00:00Z", labels: {}, annotations: {},
  unschedulable: false, node_name: null, ports: [], containers: [],
  resource_version: "9", involved: null, links: [], has_pod_selector: false,
  pod_selector: null, secret_data: [], replicas: null, ready_replicas: null,
  generation: null, yaml: "kind: Node\n",
});
const EXPIRED = "ServiceError: auth exec command 'aws-vault exec prod -- aws eks get-token' failed with status exit status: 1";

const calls = { pod_exits: 0, pod_exits_refresh: [], node_types: 0, sweeps: 0, node_allocated: 0 };
let exitsReady = false;
let refreshFails = false;
let typesForbidden = false;
let watchChan = null;

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType, nodeType]);
      case "list_namespaces": return Promise.resolve(["sre"]);
      case "list_resources":
        return Promise.resolve(args?.resource?.kind === "Node" ? nodeTable : podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start":
        if (args?.resource?.kind === "Pod") watchChan = args.channel;
        return Promise.resolve(1);
      case "pod_events_watch": return Promise.resolve(7);
      case "aggregate_issues": {
        // A swept cluster is a live one; a parked cluster is never swept.
        if ((args.contexts ?? []).includes("smoke")) calls.sweeps++;
        setTimeout(() => { for (const c of args.contexts ?? []) try { args.channel.onmessage({ context: c, issues: [], error: null }); } catch { /* */ } }, 0);
        return Promise.resolve(null);
      }
      case "pod_stats": return Promise.reject(new Error("metrics API unavailable"));
      case "node_stats": return Promise.reject(new Error("metrics API unavailable"));
      case "pod_exits":
        calls.pod_exits++;
        // The background index is still building on the first ask.
        if (!exitsReady) { exitsReady = true; return Promise.resolve(null); }
        return Promise.resolve(exits);
      case "pod_exits_refresh":
        calls.pod_exits_refresh.push([...args.keys]);
        if (refreshFails) return Promise.reject(EXPIRED);
        return Promise.resolve(
          args.keys.includes("sre/web-1")
            ? [{ key: "sre/web-1", reason: "Error", code: 137, at: ago(10_000), container: "web" }]
            : [],
        );
      case "node_types":
        calls.node_types++;
        if (typesForbidden)
          return Promise.reject('ApiError: nodes is forbidden: User "dev" cannot list resource "nodes" (ErrorResponse { code: 403 })');
        return Promise.resolve(types);
      case "node_rooms":
        return Promise.resolve({
          age_secs: 120,
          nodes: [
            { name: "ip-a", cpu_alloc: 8000, mem_alloc: 32 * GiB, pods_alloc: 110, cpu_r: 6000, mem_r: 8 * GiB, pods: 30 },
          ],
        });
      case "node_allocated":
        calls.node_allocated++;
        return Promise.resolve({
          cpu_alloc: 8000, mem_alloc: 32 * GiB, pods_alloc: 110,
          cpu_r: 7500, cpu_l: 9000, mem_r: 8 * GiB, mem_l: 12 * GiB, pods: 30,
        });
      case "get_resource": return Promise.resolve(nodeDetail(args?.name));
      case "list_snapshot": return Promise.resolve({ ...podTable, rows: podTable.rows.slice(0, 2) });
      case "get_events": return Promise.resolve([]);
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const headers = () => q("thead th").map((h) => h.textContent.replace(/[^\w%/]/g, "").toUpperCase());
const rowTds = (name) => {
  const tr = q("tbody tr.row").find((r) => r.textContent.includes(name));
  return tr ? q("td", tr) : [];
};
const cellAt = (name, i) => rowTds(name)[i];
const watch = async (rows) => { watchChan.onmessage({ type: "MODIFIED", rows }); await wait(800); };

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(1800); // the first pod_exits answers "not yet"; the second, a second later, has them

console.log("restart reason");
let hs = headers();
const exIdx = hs.indexOf("RESTARTREASON");
ok("the column sits right after RESTARTS", exIdx > 0 && exIdx === hs.indexOf("RESTARTS") + 1, hs.join(","));
ok("it waited for the index rather than giving up", calls.pod_exits >= 2, `${calls.pod_exits} reads`);
ok("an OOM kill reads as OOMKilled", cellAt("api-1", exIdx)?.textContent.trim() === "OOMKilled", cellAt("api-1", exIdx)?.textContent);
ok("five minutes ago is still live: red", cellAt("api-1", exIdx)?.className === "cell bad", cellAt("api-1", exIdx)?.className);
ok(
  "the tooltip names the container, the code and when",
  /^app: OOMKilled \(exit 137\) · 5m ago$/.test(cellAt("api-1", exIdx)?.getAttribute("title") ?? ""),
  cellAt("api-1", exIdx)?.getAttribute("title"),
);
ok("an Error carries its exit code", cellAt("api-2", exIdx)?.textContent.trim() === "Error 1", cellAt("api-2", exIdx)?.textContent);
ok("two hours ago is history: muted", cellAt("api-2", exIdx)?.className === "cell stale", cellAt("api-2", exIdx)?.className);
ok("a pod that never restarted is empty", cellAt("web-1", exIdx)?.textContent.trim() === "", cellAt("web-1", exIdx)?.textContent);

console.log("node type");
// Node is a wide column, hidden by default; Node type is placed after it all the same.
const ntIdx = hs.indexOf("NODETYPE");
ok("the column is there", ntIdx > 0, hs.join(","));
ok("a spot node reads with its type", cellAt("api-1", ntIdx)?.textContent.trim() === "m6i.xlarge · spot", cellAt("api-1", ntIdx)?.textContent);
ok("an on-demand one too", cellAt("api-2", ntIdx)?.textContent.trim() === "c6i.2xlarge · on-demand", cellAt("api-2", ntIdx)?.textContent);
ok(
  "zone and pool ride in the tooltip",
  cellAt("api-1", ntIdx)?.getAttribute("title") === "ap-northeast-2a · pool default",
  cellAt("api-1", ntIdx)?.getAttribute("title"),
);

console.log("search reaches the new columns");
const box = q("input.search.wide")[0] || q("input.search")[0];
const search = async (text) => {
  box.value = text;
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await wait(250);
  return q("tbody tr.row").map((r) => q("td", r)[0]?.textContent.trim());
};
ok("the search box is there", !!box);
let hits = await search("oomkilled");
ok("a restart reason is searchable", JSON.stringify(hits) === JSON.stringify(["api-1"]), JSON.stringify(hits));
hits = await search("c6i");
ok("so is a node type", JSON.stringify(hits) === JSON.stringify(["api-2"]), JSON.stringify(hits));
hits = await search("!spot");
ok("and a negation over it", JSON.stringify(hits) === JSON.stringify(["api-2"]), JSON.stringify(hits));
hits = await search("sre");
ok("the row's own text still matches", hits.length === 3, JSON.stringify(hits));
await search("");

console.log("cost while settled");
const typesAtStart = calls.node_types;
await wait(ticks(3));
ok("a settled list re-reads no pod", calls.pod_exits_refresh.length === 0, JSON.stringify(calls.pod_exits_refresh));
ok("nor the node types", calls.node_types === typesAtStart, `${calls.node_types - typesAtStart} more`);
ok("nor polls the index again once it had it", calls.pod_exits === 2, `${calls.pod_exits} reads`);

console.log("a pod restarts");
await watch([pod("web-1", "1 (10s ago)", "ip-a")]);
await wait(ticks(1));
ok("only that pod is re-read", JSON.stringify(calls.pod_exits_refresh) === JSON.stringify([["sre/web-1"]]), JSON.stringify(calls.pod_exits_refresh));
hs = headers();
ok("and its reason shows", cellAt("web-1", hs.indexOf("RESTARTREASON"))?.textContent.trim() === "Error 137", cellAt("web-1", hs.indexOf("RESTARTREASON"))?.textContent);
await watch([pod("api-1", "3 (6m ago)", "ip-a")]); // a change that is not a restart
await wait(ticks(2));
ok("a change that isn't a restart re-reads nothing", calls.pod_exits_refresh.length === 1, JSON.stringify(calls.pod_exits_refresh));

console.log("a pod lands on a node it hasn't seen");
typesForbidden = true; // and the account turns out not to be allowed to list nodes
const before = calls.node_types;
await watch([pod("api-2", "1 (2h ago)", "ip-new")]);
await wait(ticks(1));
ok("the node types are fetched again", calls.node_types === before + 1, `${calls.node_types - before} fetches`);
const eventsBefore = calls.sweeps;
await wait(ticks(3));
ok("and not again for the same unknown node", calls.node_types === before + 1, `${calls.node_types - before} fetches`);
ok("a Forbidden does not park the cluster", calls.sweeps > eventsBefore, `${calls.sweeps - eventsBefore} sweeps after`);

console.log("free room on the node list");
q("button.kind").find((b) => b.textContent?.trim().startsWith("Node"))?.click();
await wait(800);
hs = headers();
const cpuFree = hs.indexOf("CPUFREE");
const memFree = hs.indexOf("MEMFREE");
ok("CPU free and MEM free are there", cpuFree > 0 && memFree === cpuFree + 1, hs.join(","));
ok("free CPU is allocatable minus requested, in millicores", cellAt("ip-a", cpuFree)?.textContent.trim() === "2000", cellAt("ip-a", cpuFree)?.textContent);
ok("free memory in Mi", cellAt("ip-a", memFree)?.textContent.trim() === String(24 * 1024), cellAt("ip-a", memFree)?.textContent);
ok("a node the pod pass didn't cover shows a dash", cellAt("ip-b", cpuFree)?.textContent.trim() === "-", cellAt("ip-b", cpuFree)?.textContent);
ok(
  "the tooltip says how full, and how old the numbers are",
  /^6 of 8 cores requested \(75%\) · 8 of 32 GiB \(25%\) · 30 of 110 pods — summed from the pod list as indexed 2m ago$/.test(
    cellAt("ip-a", cpuFree)?.getAttribute("title") ?? "",
  ),
  cellAt("ip-a", cpuFree)?.getAttribute("title"),
);

console.log("allocated on the open node");
q("tbody tr.row").find((r) => r.textContent.includes("ip-a"))?.click();
await wait(600);
const alloc = q(".np-alloc")[0];
const parts = alloc ? q("span", alloc).map((s) => s.textContent.replace(/\s+/g, " ").trim()) : [];
ok("the line is under pods on this node", !!alloc, root().textContent.slice(0, 200));
ok("CPU requested and free", parts[0] === "CPU 7.5 of 8 requested · 0.5 free", parts[0]);
ok("memory requested and free", parts[1] === "memory 8 of 32 GiB requested · 24 GiB free", parts[1]);
ok("pods against the node's limit", parts[2] === "30 of 110 pods", parts[2]);
ok("over 90% requested is flagged", alloc?.querySelector("span")?.classList.contains("warn"), alloc?.innerHTML);
ok("one request for it", calls.node_allocated === 1, `${calls.node_allocated}`);

console.log("a broken credential while re-reading");
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(1800);
refreshFails = true;
const refreshesBefore = calls.pod_exits_refresh.length;
await watch([pod("api-1", "4 (5s ago)", "ip-a")]);
await wait(ticks(1));
ok("the restart is re-read", calls.pod_exits_refresh.length === refreshesBefore + 1, JSON.stringify(calls.pod_exits_refresh.slice(refreshesBefore)));
const evAtFail = calls.sweeps;
const refreshAtFail = calls.pod_exits_refresh.length;
await wait(ticks(3));
ok("the failure parks the cluster: no more re-reads", calls.pod_exits_refresh.length === refreshAtFail, `${calls.pod_exits_refresh.length - refreshAtFail} more`);
ok("nor is it swept for Issues", calls.sweeps === evAtFail, `${calls.sweeps - evAtFail} more`);
ok("no crash", !crash, crash ?? "");

if (failed) { console.error(`POD-EXTRAS SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log("pod-extras smoke ok");
process.exit(0);
