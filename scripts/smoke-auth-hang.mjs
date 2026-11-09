/**
 * E2E guard for the credential breaker when the helper HANGS (jsdom).
 *
 * smoke:auth covers a helper that fails at once. The worse case is one that
 * opens a login page and waits for it — `aws-vault exec` with an expired SSO
 * session sits there for minutes. Nothing has failed yet, so nothing is
 * parked, and anything that fires meanwhile queues another request behind
 * the helper. kube runs the helper once per queued request once it does
 * fail (measured in cred_storm_tests), so each one is a browser tab.
 *
 * The Recent event column used to poll on a 20s tick and queued one request
 * per tick. It is a watch now: the backend holds one feed per pane and is
 * the one that re-opens it (through the cluster's gate). This holds that
 * feed silent at a login page for a simulated five minutes, then fails it,
 * and asserts the app never starts a second feed meanwhile and never
 * restarts one after a broken credential.
 * Run: node scripts/smoke-auth-hang.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

// The poll is on a 20s tick and the Issues sweep on 60s. Run every timer of
// 5s or more 100x faster, so minutes of wall time take seconds here. The
// app reads these off `window`, so patch them before the bundle loads.
const SPEED = 100;
for (const name of ["setInterval", "setTimeout"]) {
  const orig = dom.window[name].bind(dom.window);
  dom.window[name] = (fn, ms, ...rest) => orig(fn, ms >= 5000 ? ms / SPEED : ms, ...rest);
}
const simMinutes = (m) => (m * 60_000) / SPEED;

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

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://smoke.example:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const podTable = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: [{ name: "pod-0", namespace: "default", cells: ["pod-0", "1/1", "Running", "0", "5m"], labels: {} }],
  truncated: false, resource_version: "1", include: "Metadata",
};
// What kube hands back once the helper gives up (from cred_storm_tests).
const EXPIRED =
  "ServiceError: auth exec command 'aws-vault exec prod -- aws eks get-token' failed with status exit status: 1: " +
  'Output { status: ExitStatus(unix_wait_status(256)), stdout: "", stderr: "Error when retrieving token from sso: Token has expired and refresh failed\\n" }';

let broken = false; // the SSO session is gone; the helper is out at a login page
let feed = null; // the backend's feed for the pane — silent while its helper waits
let eventCalls = 0;
let eventCallsWhileBroken = 0;

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["default"]);
      case "list_resources": return Promise.resolve(podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_events_watch":
        eventCalls++;
        if (broken) eventCallsWhileBroken++;
        feed = args.channel;
        setTimeout(() => feed.onmessage({ type: "SNAPSHOT", events: [] }), 0);
        return Promise.resolve(eventCalls);
      case "aggregate_issues": {
        const ch = args?.channel;
        setTimeout(() => {
          for (const c of args?.contexts ?? [])
            try { ch.onmessage({ context: c, issues: [], error: null }); } catch { /* ignore */ }
        }, 0);
        return Promise.resolve(null);
      }
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

console.log("credential helper stuck at a login page");

// Healthy first: one feed for the pod list, and no polling on top of it.
await wait(simMinutes(1));
ok("the pod list runs one Recent-event feed", eventCalls === 1, `${eventCalls} started`);

// The session expires; the backend's feed sits at the login page, silent.
broken = true;
await wait(simMinutes(5));
ok(
  "while the helper waits, the app starts no second feed",
  eventCallsWhileBroken === 0,
  `${eventCallsWhileBroken} started — each would queue behind the helper and open a browser tab`,
);

// The user never finishes the login page; the helper gives up.
feed.onmessage({ type: "ERROR", error: EXPIRED });
await wait(50);
const atFailure = eventCalls;
await wait(simMinutes(5));
ok(
  "once the failure lands it is never restarted",
  eventCalls === atFailure,
  `${eventCalls - atFailure} restarted after the failure`,
);
ok("no crash", !crash, crash ?? "");

if (failed) { console.error(`AUTH-HANG SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log(
  `auth-hang smoke ok — no feed started while the helper waited five simulated minutes, ` +
  `and none after it failed`,
);
process.exit(0);
