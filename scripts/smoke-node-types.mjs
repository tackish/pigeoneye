/**
 * E2E for when the pod list's Node type column comes, not what it shows
 * (smoke-pod-extras covers that) — jsdom.
 *
 * On a big cluster node_types queued behind the Recent event list at the
 * cluster's gate for up to 16s (measured, prod-kr-a). Switching tabs inside
 * that window dropped the new cluster's request — one was already out for
 * the pane — and the old answer was then thrown away: the column never came.
 * A failed read was not tried again either. This holds one cluster's answer
 * back, moves to another meanwhile, and asserts each gets its own types; a
 * read that fails is tried again on the tick, and a Forbidden is not.
 * Run: node scripts/smoke-node-types.mjs   (DIST=dir to run another build)
 */
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";

const DIST = path.resolve(process.env.DIST || "dist");
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
// The pod tick is 20s; run timers of 5s or more 100x faster.
const SPEED = 100;
for (const name of ["setInterval", "setTimeout"]) {
  const orig = dom.window[name].bind(dom.window);
  dom.window[name] = (fn, ms, ...rest) => orig(fn, ms >= 5000 ? ms / SPEED : ms, ...rest);
}
// The app's once-a-minute retry reads Date.now(); move it at the same pace.
const realNow = Date.now.bind(Date);
const start = realNow();
dom.window.Date.now = Date.now = () => start + (realNow() - start) * SPEED;
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

const NAMES = ["slow", "next", "flaky", "denied", "big"];
const ctxInfo = (name) => ({ name, cluster: name, user: "u", namespace: null, is_current: name === "slow", source: "", server: `https://${name}:6443` });
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const cmType = { group: "", version: "v1", kind: "ConfigMap", plural: "configmaps", namespaced: true, deletable: true, editable: true };
const col = (name, priority = 0) => ({ name, priority });
const cmTable = { columns: [col("Name"), col("Age")], rows: [{ name: "cm", namespace: "app", labels: {}, cells: ["cm", "3h"] }], truncated: false, resource_version: "1", include: "Metadata" };
const podTable = (ctx) => ({
  columns: [col("Name"), col("Ready"), col("Status"), col("Restarts"), col("Age"), col("Node", 1)],
  rows: [{ name: `${ctx}-pod`, namespace: "app", labels: {}, cells: [`${ctx}-pod`, "1/1", "Running", "0", "3h", `${ctx}-node`] }],
  truncated: false, resource_version: "1", include: "Metadata",
});
const typesOf = (ctx) => [{ name: `${ctx}-node`, instance: `${ctx}.xlarge`, capacity: "spot", zone: "a", pool: "p" }];

const calls = Object.fromEntries(NAMES.map((n) => [n, 0]));
const flakyAsks = []; // simulated ms of each ask
let releaseSlow;
const slowHeld = new Promise((r) => (releaseSlow = r));
let flakyFails = 1;
// "big": a pod list that takes a while, as on a 20k-pod cluster.
let releaseBig;
let bigHeld = new Promise((r) => (releaseBig = r));
const order = [];

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: NAMES, active: "slow" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve(NAMES.map(ctxInfo));
      case "discover": return Promise.resolve([podType, cmType]);
      case "list_namespaces": return Promise.resolve(["app"]);
      case "list_resources":
        if (args.resource?.kind === "ConfigMap") return Promise.resolve(cmTable);
        if (args.context === "big") {
          order.push("list asked");
          return bigHeld.then(() => { order.push("list answered"); return podTable("big"); });
        }
        return Promise.resolve(podTable(args.context));
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_events_watch": return Promise.resolve(7);
      case "pod_exits": return Promise.resolve([]);
      case "aggregate_issues": {
        setTimeout(() => { for (const c of args.contexts ?? []) try { args.channel.onmessage({ context: c, issues: [], error: null }); } catch { /* */ } }, 0);
        return Promise.resolve(null);
      }
      case "pod_stats": case "node_stats": return Promise.reject(new Error("metrics API unavailable"));
      case "node_types": {
        const c = args.context;
        calls[c]++;
        if (c === "big") order.push("types asked");
        if (c === "flaky") flakyAsks.push(Date.now());
        // Queued behind the event list at the gate, as on prod-kr-a.
        if (c === "slow") return slowHeld.then(() => typesOf(c));
        if (c === "flaky" && flakyFails-- > 0) return Promise.reject("HyperError: error sending request for url (https://flaky:6443/api/v1/nodes)");
        if (c === "denied") return Promise.reject('ApiError: nodes is forbidden: User "dev" cannot list resource "nodes" (ErrorResponse { code: 403 })');
        return Promise.resolve(typesOf(c));
      }
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync(`${DIST}/assets`).find((f) => f.endsWith(".js"));
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
/// The Node type cell of the one pod on screen, or null with no column.
const typeCell = () => {
  const i = headers().indexOf("NODETYPE");
  const tr = q("tbody tr.row")[0];
  return i < 0 || !tr ? null : q("td", tr)[i]?.textContent.trim();
};
const tab = async (name) => {
  q(".tab").find((t) => t.querySelector(".tab-name")?.textContent === name)?.click();
  await wait(600);
  if (!q("tbody tr.row").length || !q("tbody tr.row")[0].textContent.includes(`${name}-pod`)) {
    q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
    await wait(800);
  }
};
const until = async (cond, ms) => {
  for (let t = 0; t < ms && !cond(); t += 20) await wait(20);
  return cond();
};

await import(`${DIST}/assets/${bundle}`);
await wait(600);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(800);

console.log("moving to another cluster while the first one's answer is still out");
ok("the first cluster asked", calls.slow === 1, `${calls.slow}`);
await tab("next");
ok("the cluster moved to asks for its own", calls.next >= 1, `${calls.next} asks`);
ok("and its column comes", await until(() => typeCell() === "next.xlarge · spot", 1500), String(typeCell()));
releaseSlow();
await wait(300);
ok("the late answer for the cluster left is not shown here", typeCell() === "next.xlarge · spot", String(typeCell()));
await tab("slow");
ok("going back shows that cluster's own", await until(() => typeCell() === "slow.xlarge · spot", ticks(2)), String(typeCell()));

console.log("a read that fails");
await tab("flaky");
ok("is tried again", await until(() => typeCell() === "flaky.xlarge · spot", ticks(6)), `${calls.flaky} asks, cell ${typeCell()}`);
const gap = flakyAsks.length >= 2 ? (flakyAsks[1] - flakyAsks[0]) / 1000 : 0;
ok("but not before a minute has passed", flakyAsks.length === 2 && gap >= 60 && gap < 100, `${flakyAsks.length} asks, ${gap.toFixed(0)}s apart`);
const settled = calls.flaky;
await wait(ticks(4));
ok("and once it has them, asks no more", calls.flaky === settled, `${calls.flaky - settled} more`);

console.log("with the pod list, not after it");
q(".tab").find((t) => t.querySelector(".tab-name")?.textContent === "big")?.click();
await wait(600);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(300);
ok("the node types are asked while the pod list is still out", order.indexOf("types asked") >= 0 && !order.includes("list answered"), order.join(" → "));
releaseBig();
await until(() => q("tbody tr.row").some((r) => r.textContent.includes("big-pod")), 2000);
ok("the first rows painted already carry them", typeCell() === "big.xlarge · spot", String(typeCell()));
q("button.kind").find((b) => b.textContent?.trim().startsWith("ConfigMap"))?.click();
await wait(600);
const asksBefore = calls.big;
bigHeld = new Promise((r) => (releaseBig = r));
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(50);
releaseBig();
await until(() => q("tbody tr.row").some((r) => r.textContent.includes("big-pod")), 2000);
ok("opened again, the first rows carry them from what was read before", typeCell() === "big.xlarge · spot", String(typeCell()));
ok("at most one read to keep them fresh", calls.big - asksBefore <= 1, `${calls.big - asksBefore} reads`);

console.log("an account that may not list nodes");
await tab("denied");
const deniedAt = calls.denied;
ok("asked once", deniedAt === 1, `${deniedAt}`);
await wait(ticks(8));
ok("is never asked again", calls.denied === deniedAt, `${calls.denied - deniedAt} more`);
ok("and has no column", typeCell() === null, String(typeCell()));
ok("no crash", !crash, crash ?? "");

if (failed) { console.error(`NODE-TYPES SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log("node-types smoke ok");
process.exit(0);
