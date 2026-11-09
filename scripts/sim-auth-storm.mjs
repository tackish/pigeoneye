/**
 * The whole app, left open for an hour after an SSO session expires (jsdom).
 *
 * Unlike the focused smokes, everything runs at once: two clusters sharing
 * the expired session (one on screen with its pod list split across both
 * panes, one a background tab), a third that stays healthy, the Issues
 * sweep, the Recent-event / restart / node-type ticks, and the watch resync
 * every ten minutes. Timers run SPEED times faster.
 *
 * The backend is modelled the way cred_storm_tests measured the real one:
 * one lock per cluster, every request that finds the token expired runs the
 * credential helper once, in turn, and the helper waits HANG minutes at a
 * login page nobody finishes before it fails. Each helper run is a browser
 * tab. BACKEND=new adds what the backend now does: background requests take
 * turns at a per-cluster gate and, once one finds the credential broken, the
 * rest are answered without being sent; the Issues sweep is shared and
 * reports the failure. BACKEND=old models the sweep before the fix (two
 * requests per sweep, failures swallowed, no gate) so an older bundle can be
 * measured too.
 *
 * Run: ASSERT=1 node scripts/sim-auth-storm.mjs   (HANG=10 BACKEND=new DIST=dist)
 */
import { JSDOM } from "jsdom";
import fs from "fs";
import path from "path";

const SPEED = 200;
const HANG = Number(process.env.HANG ?? 10); // simulated minutes at the login page
const BACKEND = process.env.BACKEND ?? "new";
const DIST = path.resolve(process.env.DIST ?? "dist");
const HOUR = 60;
const simMs = (min) => (min * 60_000) / SPEED;

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
for (const name of ["setInterval", "setTimeout"]) {
  const orig = dom.window[name].bind(dom.window);
  dom.window[name] = (fn, ms, ...rest) => orig(fn, ms >= 5000 ? ms / SPEED : ms, ...rest);
}
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

const t0 = Date.now();
const simNow = () => ((Date.now() - t0) * SPEED) / 60_000; // simulated minutes since start

const ctxInfo = (name) => ({ name, cluster: name, user: "u", namespace: null, is_current: name === "prod", source: "", server: `https://${name}:6443` });
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const nodeKind = { group: "", version: "v1", kind: "Node", plural: "nodes", namespaced: false, deletable: true, editable: true };
const podTable = {
  columns: [...["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })), { name: "Node", priority: 1 }],
  rows: Array.from({ length: 30 }, (_, i) => ({
    name: `pod-${i}`, namespace: "app", labels: {},
    cells: [`pod-${i}`, "1/1", "Running", i % 7 ? "0" : "1 (2h ago)", "3h", `ip-${i % 3}`],
  })),
  truncated: false, resource_version: "1", include: "Metadata",
};
const EXPIRED =
  "ServiceError: auth exec command 'aws-vault exec prod -- aws eks get-token' failed with status exit status: 1: " +
  'Output { status: ExitStatus(unix_wait_status(256)), stdout: "", stderr: "Error when retrieving token from sso: Token has expired and refresh failed\\n" }';

// ---- the modelled backend --------------------------------------------------
const clusters = {};
for (const n of ["prod", "stage", "dev"]) clusters[n] = { broken: false, queue: Promise.resolve(), runs: [], sweeps: [] };
/** A request on `ctx`: straight through while the token is good; once it
 *  is not, wait for kube's lock and run the helper (a browser tab), which
 *  sits HANG minutes at the login page and then fails. */
function request(ctx, answer) {
  const c = clusters[ctx];
  if (!c?.broken) return Promise.resolve().then(answer);
  const turn = c.queue.then(
    () => new Promise((done) => { c.runs.push(simNow()); setTimeout(done, simMs(HANG)); }),
  );
  c.queue = turn;
  return turn.then(() => { throw EXPIRED; });
}
const gates = {};
/** BACKEND=new: a request the app made on its own, through the cluster's gate. */
function background(ctx, answer) {
  if (BACKEND === "old") return request(ctx, answer);
  const g = (gates[ctx] ??= { tail: Promise.resolve(), broken: null });
  const run = g.tail.then(() => {
    if (g.broken) throw g.broken;
    return request(ctx, answer).catch((e) => {
      if (/auth exec/.test(String(e))) g.broken = e;
      throw e;
    });
  });
  g.tail = run.catch(() => {});
  return run;
}
const BACKGROUND = new Set(["node_types", "pod_exits_refresh", "node_rooms"]);
/** The Recent event feed, as the backend runs it: a list through the gate,
 *  then the watch re-opened (through the gate) each time the server closes
 *  it — every 290s — until a broken credential ends it or it is stopped.
 *  BACKEND=old has no feed; the bundle it pairs with polls pod_events. */
const feeds = new Map();
let feedIds = 5000;
function startFeed(ctx, ch) {
  const id = feedIds++;
  const f = { stopped: false };
  feeds.set(id, f);
  (async () => {
    try {
      await background(ctx, () => []);
    } catch (e) {
      if (!f.stopped) ch.onmessage({ type: "ERROR", error: String(e) });
      return;
    }
    if (f.stopped) return;
    ch.onmessage({ type: "SNAPSHOT", events: [] });
    for (;;) {
      await new Promise((r) => setTimeout(r, simMs(290 / 60)));
      if (f.stopped) return;
      try {
        await background(ctx, () => null);
      } catch (e) {
        if (!f.stopped) ch.onmessage({ type: "ERROR", error: String(e) });
        return;
      }
    }
  })();
  return id;
}
const sweepsOut = {}; // BACKEND=new: one sweep per cluster at a time, shared
function sweepOne(ctx) {
  clusters[ctx].sweeps.push(simNow());
  if (BACKEND === "old") {
    // pods, then nodes, each a request; any failure swallowed as "no issues"
    return request(ctx, () => [])
      .catch(() => null)
      .then(() => request(ctx, () => []).catch(() => null))
      .then(() => ({ context: ctx, issues: [], error: null }));
  }
  sweepsOut[ctx] ??= background(ctx, () => [])
    .then(() => ({ context: ctx, issues: [], error: null }), (e) => ({ context: ctx, issues: [], error: String(e) }))
    .finally(() => delete sweepsOut[ctx]);
  return sweepsOut[ctx];
}
const LOCAL = new Set(["list_contexts", "cached_list", "pod_exits", "auth_hint", "pf_list", "filter_rows", "watch_stop", "ensure_index"]);
const watches = [];

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["prod", "stage", "dev"], active: "prod" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    if (cmd === "list_contexts") return Promise.resolve(["prod", "stage", "dev"].map(ctxInfo));
    if (cmd === "aggregate_issues") {
      const ch = args.channel;
      return Promise.all(
        (args.contexts ?? []).map((c) => sweepOne(c).then((b) => { try { ch.onmessage(b); } catch { /* */ } })),
      ).then(() => null);
    }
    if (cmd === "pod_events_watch") return Promise.resolve(startFeed(args.context, args.channel));
    if (cmd === "watch_stop" && feeds.has(args.id)) {
      feeds.get(args.id).stopped = true;
      return Promise.resolve(null);
    }
    if (cmd === "pod_events") return background(args.context, () => []); // the old bundle's poll
    if (cmd === "watch_start") {
      watches.push(args.channel);
      return Promise.resolve(watches.length);
    }
    if (LOCAL.has(cmd) || !args.context) {
      if (cmd === "pod_exits") return Promise.resolve([]);
      return Promise.resolve(cmd === "cached_list" ? null : []);
    }
    const send = BACKGROUND.has(cmd) || (cmd === "list_resources" && args.background) ? background : request;
    return send(args.context, () => {
      switch (cmd) {
        case "discover": return [podType, nodeKind];
        case "list_namespaces": return ["app"];
        case "list_resources": return podTable;
        case "pod_stats": throw "metrics API unavailable";
        case "node_types": return [0, 1, 2].map((i) => ({ name: `ip-${i}`, instance: "m6i.xlarge", capacity: "spot", zone: "a", pool: "p" }));
        default: return [];
      }
    });
  },
  transformCallback: (f) => f,
  convertFileSrc: (s) => s,
};
// The API server closes every watch after ten minutes; the app re-lists.
setInterval(() => { for (const ch of watches) try { ch.onmessage({ type: "RESYNC" }); } catch { /* */ } }, simMs(10));

const bundle = fs.readdirSync(`${DIST}/assets`).find((f) => f.endsWith(".js"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => [...document.getElementById("root").querySelectorAll(sel)];

await import(`${DIST}/assets/${bundle}`);
await wait(600);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(800);
q("button.split-toggle")[0]?.click();
await wait(800);
const panes = q(".primary-pane").length;
const rows = q("tr.row").length;

// A healthy minute, then the shared SSO session expires.
await wait(simMs(1));
const broke = simNow();
clusters.prod.broken = clusters.stage.broken = true;
const devSweepsBefore = clusters.dev.sweeps.length;
await wait(simMs(HOUR));

const after = (c) => c.runs.filter((m) => m >= broke);
const bucket = (c) =>
  Array.from({ length: 6 }, (_, i) => after(c).filter((m) => m - broke >= i * 10 && m - broke < (i + 1) * 10).length);
const report = {
  build: process.env.LABEL ?? BACKEND,
  hang: HANG,
  panes, rows,
  prod: after(clusters.prod).length, prodPer10m: bucket(clusters.prod),
  stage: after(clusters.stage).length, stagePer10m: bucket(clusters.stage),
  devSwept: clusters.dev.sweeps.length - devSweepsBefore,
};
console.log(JSON.stringify(report));

if (process.env.ASSERT) {
  const fails = [];
  if (panes !== 2 || !rows) fails.push(`setup: ${panes} panes, ${rows} rows`);
  for (const n of ["prod", "stage"]) {
    const tabs = after(clusters[n]).length;
    const late = after(clusters[n]).filter((m) => m - broke >= 30).length;
    // One helper run when the session lapses — the one that finds out — and none after.
    if (tabs > 1) fails.push(`${n}: ${tabs} browser tabs in the hour`);
    if (late) fails.push(`${n}: still opening tabs ${late}x in the second half hour`);
  }
  if (report.devSwept < HOUR - 5) fails.push(`dev (healthy) swept only ${report.devSwept}x — over-paused`);
  if (fails.length) { console.error("AUTH-STORM SIM FAILED — " + fails.join("; ")); process.exit(1); }
  console.log("auth-storm sim ok");
}
process.exit(0);
