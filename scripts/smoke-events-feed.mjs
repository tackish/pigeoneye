/**
 * E2E for the Recent event feed's life cycle (jsdom).
 *
 * The column used to poll one page of events every 20s. It now holds one
 * watch per pane on that pane's pod list scope: the backend sends the whole
 * list once (SNAPSHOT), then batches of what changed (DELTA). This asserts
 * the column follows both, that nothing polls, that a feed is stopped the
 * moment its pane stops showing that list (another kind, another namespace,
 * the split closed), that each pane of a split runs its own, and that only a
 * broken credential — not any error — parks the cluster.
 * Run: node scripts/smoke-events-feed.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
const SPEED = 100; // the 20s tick and 60s sweep, 100x faster
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

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const svcType = { group: "", version: "v1", kind: "Service", plural: "services", namespaced: true, deletable: true, editable: true };
const podTable = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: ["web-1", "web-2", "db-1"].map((n) => ({ name: n, namespace: "sre", cells: [n, "1/1", "Running", "0", "3h"], labels: {} })),
  truncated: false, resource_version: "1", include: "Metadata",
};
const svcTable = { ...podTable, rows: [{ name: "svc-a", namespace: "sre", cells: ["svc-a", "ClusterIP"], labels: {} }], columns: ["Name", "Type"].map((name) => ({ name, priority: 0 })) };
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ev = (pod, reason, count, msAgo = 30_000) => ({ key: `sre/${pod}`, reason, message: `${reason} on ${pod}`, count, last: ago(msAgo), series: false });
const EXPIRED = "ServiceError: auth exec command 'aws-vault exec prod -- aws eks get-token' failed with status exit status: 1";

const feeds = []; // every pod_events_watch: { id, ns, chan, stopped }
const sweeps = []; // aggregate_issues calls
let nextId = 100;

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType, svcType]);
      case "list_namespaces": return Promise.resolve(["sre", "web"]);
      case "list_resources": return Promise.resolve(args.resource?.kind === "Service" ? svcTable : podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(nextId++);
      case "pod_events_watch": {
        const f = { id: nextId++, ns: args.namespace ?? null, chan: args.channel, stopped: false };
        feeds.push(f);
        return Promise.resolve(f.id);
      }
      case "watch_stop":
        for (const f of feeds) if (f.id === args.id) f.stopped = true;
        return Promise.resolve(null);
      case "aggregate_issues": {
        sweeps.push([...(args.contexts ?? [])]);
        setTimeout(() => { for (const c of args.contexts ?? []) try { args.channel.onmessage({ context: c, issues: [], error: null }); } catch { /* */ } }, 0);
        return Promise.resolve(null);
      }
      case "pod_stats": return Promise.reject(new Error("metrics API unavailable"));
      case "pod_exits": return Promise.resolve(null);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];
const key = (k, mods = {}) => document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const live = () => feeds.filter((f) => !f.stopped);
const send = async (f, msg) => { f.chan.onmessage(msg); await wait(150); };
const headers = (p = root()) => q("thead th", p).map((h) => h.textContent.replace(/[^\w%/]/g, "").toUpperCase());
const cell = (pod, p = root()) => {
  const i = headers(p).indexOf("RECENTEVENT");
  const tr = q("tbody tr.row", p).find((r) => r.textContent.includes(pod));
  return i < 0 || !tr ? null : q("td", tr)[i]?.textContent.trim();
};
// The namespace picker (not the context one, which shares the class).
const nsButton = () => q("button.ns-btn").find((b) => /namespaces|^sre|^web/.test(b.textContent?.trim() ?? ""));
const kind = async (k) => { q("button.kind").find((b) => b.textContent?.trim().startsWith(k))?.click(); await wait(700); };

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
await kind("Pod");

console.log("the feed");
ok("opening the pod list starts one feed", feeds.length === 1 && live().length === 1, JSON.stringify(feeds.map((f) => f.id)));
ok("over the list's scope (all namespaces)", feeds[0]?.ns === null, String(feeds[0]?.ns));
const f1 = feeds[0];
await send(f1, { type: "SNAPSHOT", events: [ev("web-1", "FailedScheduling", 107696), ev("db-1", "BackOff", 3)] });
ok("the snapshot fills the column", /^FailedScheduling ×107696 · \d+s$/.test(cell("web-1") ?? ""), cell("web-1"));
ok("a pod without warnings stays empty", cell("web-2") === "", cell("web-2"));
await send(f1, { type: "DELTA", events: [ev("web-2", "Unhealthy", 1), ev("db-1", "BackOff", 9)], removed: ["sre/web-1"] });
ok("a batch adds a newly failing pod", /^Unhealthy\b/.test(cell("web-2") ?? ""), cell("web-2"));
ok("updates a count that went up", /^BackOff ×9\b/.test(cell("db-1") ?? ""), cell("db-1"));
ok("and clears one whose warnings expired", cell("web-1") === "", cell("web-1"));

console.log("nothing polls");
await wait(ticks(4));
ok("four ticks later it is still the one feed", feeds.length === 1 && live().length === 1, `${feeds.length} started, ${live().length} live`);

console.log("it stops when the list goes away");
await kind("Service");
ok("leaving pods stops the feed", f1.stopped, JSON.stringify(feeds.map((f) => [f.id, f.stopped])));
ok("and starts none for services", live().length === 0, `${live().length} live`);
await kind("Pod");
ok("coming back starts a fresh one", live().length === 1 && feeds.length === 2, `${feeds.length} started`);
const f2 = live()[0];
await send(f2, { type: "SNAPSHOT", events: [ev("db-1", "BackOff", 12)] });
ok("which fills the column again", /^BackOff ×12\b/.test(cell("db-1") ?? ""), cell("db-1"));
ok("a late message from the stopped feed is ignored", (f1.chan.onmessage({ type: "SNAPSHOT", events: [ev("db-1", "OOMKilled", 1)] }), true));
await wait(150);
ok("…and does not overwrite the live one", /^BackOff ×12\b/.test(cell("db-1") ?? ""), cell("db-1"));

console.log("it follows the namespace");
nsButton()?.click();
await wait(200);
q(".ns-list button").find((b) => b.textContent?.trim() === "sre")?.click();
await wait(800);
const fNs = live().find((f) => f !== f2);
ok("picking a namespace stops the all-namespaces feed", f2.stopped, JSON.stringify(feeds.map((f) => [f.id, f.ns, f.stopped])));
ok("and starts one scoped to it", fNs?.ns === "sre" && live().length === 1, JSON.stringify(live().map((f) => f.ns)));
await send(fNs, { type: "SNAPSHOT", events: [ev("db-1", "BackOff", 12)] });
nsButton()?.click();
await wait(200);
q(".ns-list button").find((b) => /all namespaces/.test(b.textContent ?? ""))?.click();
await wait(800);
ok("and back to all of them", fNs.stopped && live().length === 1 && live()[0].ns === null, JSON.stringify(feeds.map((f) => [f.id, f.ns, f.stopped])));
const f3 = live()[0];
await send(f3, { type: "SNAPSHOT", events: [ev("db-1", "BackOff", 12)] });

console.log("a split runs one per pane");
q("button.split-toggle")[0]?.click();
await wait(900);
const panes = q(".primary-pane");
ok("the split opened with pods in both", panes.length === 2 && headers(panes[1]).length > 0, `${panes.length} panes`);
ok("the second pane started its own feed", live().length === 2, `${live().length} live`);
const fPane2 = live().find((f) => f !== f3);
await send(fPane2, { type: "SNAPSHOT", events: [ev("web-2", "FailedMount", 2)] });
ok("each pane shows its own feed", /^FailedMount ×2\b/.test(cell("web-2", panes[1]) ?? "") && cell("web-2", panes[0]) === "", `${cell("web-2", panes[0])} | ${cell("web-2", panes[1])}`);
q("button.split-toggle")[0]?.click();
await wait(700);
ok("closing the split stops the second pane's feed", fPane2.stopped && !f3.stopped, JSON.stringify(feeds.map((f) => [f.id, f.stopped])));

console.log("errors");
const sweepsBefore = sweeps.length;
await send(f3, { type: "ERROR", error: 'ApiError: events is forbidden: User "dev" cannot watch resource "events" (ErrorResponse { code: 403 })' });
await wait(ticks(2) + simSweep());
ok("a Forbidden does not park the cluster", sweeps.length > sweepsBefore && !f3.stopped, `${sweeps.length - sweepsBefore} sweeps after`);
await send(f3, { type: "ERROR", error: EXPIRED });
await wait(150);
const sweepsAtCred = sweeps.length;
const feedsAtCred = feeds.length;
await wait(ticks(4) + simSweep());
ok("a broken credential parks it: no more Issues sweeps of it", sweeps.slice(sweepsAtCred).every((t) => !t.includes("smoke")), JSON.stringify(sweeps.slice(sweepsAtCred)));
ok("and the feed is not restarted", feeds.length === feedsAtCred, `${feeds.length - feedsAtCred} restarted`);
ok("no crash", !crash, crash ?? "");

function simSweep() { return 60_000 / SPEED + 50; }

if (failed) { console.error(`EVENTS-FEED SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log("events-feed smoke ok");
process.exit(0);
