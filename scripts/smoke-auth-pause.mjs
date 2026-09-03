/**
 * E2E guard for the credential circuit breaker (jsdom).
 *
 * A kubeconfig exec can be a helper that opens a BROWSER every time it runs
 * (`aws-vault exec …`, oidc-login). The Issues sweep runs every 60s across all
 * open clusters, so a context whose SSO expired used to be re-hit forever —
 * one browser tab per cluster per minute, unattended, until a security team
 * blocks the account. This asserts that once a sweep reports an auth failure
 * for a context, that context is NEVER swept again until the user signs in.
 * Run: node scripts/smoke-auth-pause.mjs
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

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://smoke.example:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const podTable = {
  columns: ["Name", "Ready", "Status", "Restarts", "Age"].map((name) => ({ name, priority: 0 })),
  rows: [{ name: "pod-0", namespace: "default", cells: ["pod-0", "1/1", "Running", "0", "5m"], labels: {} }],
  truncated: false, resource_version: "1", include: "Metadata",
};

// The exact shape of an expired-SSO exec failure, which isAuthError matches.
const AUTH_ERR =
  'auth exec command failed: The SSO session associated with this profile has expired';

const sweeps = []; // one entry per aggregate_issues call: the contexts asked for

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
      case "aggregate_issues": {
        sweeps.push([...(args?.contexts ?? [])]);
        const ch = args?.channel;
        // Every cluster answers with an expired-credential failure.
        setTimeout(() => {
          for (const c of args?.contexts ?? []) {
            try { ch.onmessage({ context: c, issues: [], error: AUTH_ERR }); } catch { /* ignore */ }
          }
        }, 0);
        return Promise.resolve(null);
      }
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
const fail = (why, d) => { console.error(`AUTH-PAUSE SMOKE FAILED — ${why}`); if (d) console.error(String(d).slice(0, 700)); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
// the warm timer (500ms after the tabs settle) fires the first sweep
await wait(1200);
if (crash) fail("crash during the first sweep", crash);

if (sweeps.length < 1) fail("the background sweep never ran — test cannot prove anything");
if (!sweeps[0].includes("smoke")) fail(`first sweep did not target the cluster: ${JSON.stringify(sweeps[0])}`);
const afterFirst = sweeps.length;

// Opening Issues would kick another sweep; the paused context must keep it
// from ever reaching the credential exec again.
q("button").find((b) => /issues/i.test(b.textContent || ""))?.click();
await wait(600);
if (crash) fail("crash after opening Issues", crash);

const extra = sweeps.slice(afterFirst);
const reSwept = extra.filter((t) => t.includes("smoke"));
if (reSwept.length)
  fail(
    `BROWSER-STORM REGRESSION: the auth-failed cluster was swept again ${reSwept.length}x ` +
    `after reporting expired credentials — each of those re-runs the exec (aws-vault opens a browser). ` +
    `sweeps=${JSON.stringify(sweeps)}`,
  );

// and the user still sees why it stopped, rather than it silently vanishing
const shown = root().textContent || "";
if (!/sign-in needed|paused|unreachable/i.test(shown))
  fail("the paused cluster is invisible — the user gets no hint that it needs a sign-in", shown.slice(0, 300));

console.log(
  `auth-pause smoke ok — cluster swept ${afterFirst}x, reported expired credentials, ` +
  `then was never swept again (${sweeps.length} total calls) and stays visible as needing sign-in`,
);
process.exit(0);
