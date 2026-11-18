/**
 * E2E for the pod detail's env section (jsdom).
 *
 * Holds the Secret contract: opening a pod never reads a Secret; values come
 * only after reveal, and hide drops them at once and re-reads without them.
 * Also: per-container picker (init containers too), filter by name, and a
 * forbidden reference saying so instead of showing nothing.
 *
 * And its place in the panel: events first, env folded below the ways into
 * the pod, opened once and then open from pod to pod; the Source column can
 * be hidden to give long names (.NET's Logging__LogLevel__…) their width.
 * Both choices survive a restart: PHASE=restart starts with them saved.
 * Run: node scripts/smoke-pod-env.mjs && PHASE=restart node scripts/smoke-pod-env.mjs
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
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.HTMLElement.prototype.scrollTo = function () {};
dom.window.HTMLElement.prototype.scrollBy = function () {};
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const col = (name, priority = 0) => ({ name, priority });
const pod = (name) => ({ name, namespace: "sre", labels: {}, cells: [name, "1/1", "Running", "0", "3h"] });
const podTable = {
  columns: [col("Name"), col("Ready"), col("Status"), col("Restarts"), col("Age")],
  rows: [pod("api-1"), pod("api-2")],
  truncated: false, resource_version: "1", include: "Metadata",
};
const RESTART = process.env.PHASE === "restart";
const LONG = "Logging__LogLevel__Microsoft.AspNetCore.Hosting.Diagnostics"; // 58 chars
const podDetail = (name) => ({
  name, namespace: "sre", created: "2026-10-01T00:00:00Z", labels: { app: "api" }, annotations: {},
  status: null, unschedulable: null, node_name: "ip-a", ports: [], containers: ["app"],
  resource_version: "9", involved: null, links: [], has_pod_selector: false,
  pod_selector: null, secret_data: [], replicas: null, ready_replicas: null,
  generation: null, yaml: "kind: Pod\n",
});

const v = (name, value, source = "value", extra = {}) => ({
  name, value, source, from: null, secret: false, note: null, overrides: null, ...extra,
});
const env = (reveal) => ({
  revealed: reveal,
  containers: [
    { name: "migrate", init: true, vars: [v("MIGRATE_ONLY", "1")], pending: [] },
    {
      name: "app",
      init: false,
      vars: [
        v("MODE", "prod"),
        v(LONG, "Warning", "configmap", { from: "dotnet/log", overrides: "envFrom cm dotnet" }),
        v("LEVEL", "debug", "configmap", { from: "cfg/level" }),
        v("PASS", reveal ? "hunter2" : null, "secret", { from: "db/pw", secret: true }),
        v("OTHER", null, "secret", {
          from: "locked/k", secret: true,
          note: reveal ? "forbidden — no access to Secret locked" : null,
        }),
        ...(reveal ? [v("TOKEN", "tok-xyz", "secret", { from: "bulk/TOKEN", secret: true })] : []),
      ],
      pending: reveal ? [] : [{ kind: "secret", name: "bulk", prefix: null, note: null }],
    },
  ],
});

const calls = [];
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
if (RESTART) {
  // What a user who wants both left behind: env open, Source shown.
  dom.window.localStorage.setItem("pigeoneye.envopen", "1");
  dom.window.localStorage.setItem("pigeoneye.envsrc", "1");
}
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["sre"]);
      case "list_resources": return Promise.resolve(podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_events_watch": return Promise.resolve(7);
      case "aggregate_issues": return Promise.resolve(null);
      case "pod_stats": return Promise.reject(new Error("metrics API unavailable"));
      case "pod_exits": return Promise.resolve([]);
      case "node_types": return Promise.resolve([]);
      case "get_resource": return Promise.resolve(podDetail(args?.name));
      case "get_events":
        return Promise.resolve([{ type_: "Warning", reason: "BackOff", message: "Back-off restarting", count: 2, last: "2026-11-18T00:00:00Z", source: "kubelet", involved: null }]);
      case "pod_env":
        calls.push({ name: args.name, reveal: args.reveal });
        return Promise.resolve(env(args.reveal));
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
const sec = () => q(".drawer [data-sec='env']")[0];
const rows = () => (sec() ? q(".env-row", sec()) : []);
const row = (name) => rows().find((r) => r.querySelector(".env-key")?.textContent === name);
const val = (name) => row(name)?.querySelector(".env-val")?.textContent;
const btn = (label) => (sec() ? q("button", sec()).find((b) => b.textContent.trim() === label) : null);
const key = (k) => document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const fold = () => sec()?.querySelector("details.fold");
const isOpen = () => !!fold()?.open;
const keyW = () => sec()?.querySelector(".env-list")?.style.getPropertyValue("--env-key-w") ?? "";
const srcCells = () => (sec() ? q(".env-src", sec()).length : -1);
const openPod = async (name) => {
  q("tbody tr.row").find((r) => r.textContent.includes(name))?.click();
  await wait(500);
};

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(800);

if (RESTART) {
  console.log("after a restart");
  await openPod("api-1");
  ok("env is open, as it was left", isOpen());
  ok("so the pod's env is read on opening it", calls.length === 1 && calls[0].reveal === false, JSON.stringify(calls));
  ok("and the Source column is shown, as it was left", srcCells() > 0 && keyW() === "", `${srcCells()} cells, ${keyW()}`);
  ok("no crash", !crash, crash ?? "");
  if (failed) { console.error(`POD-ENV SMOKE (restart) FAILED — ${failed} check(s)`); process.exit(1); }
  console.log("pod-env smoke (restart) ok");
  process.exit(0);
}

console.log("opening a pod");
await openPod("api-1");
ok("the env section is there", !!sec(), root().textContent.slice(0, 200));
ok("folded", fold() && !isOpen(), String(fold()?.open));
ok("and nothing is read while it is", calls.length === 0, JSON.stringify(calls));
fold().querySelector("summary").click();
await wait(300);
ok("opening it reads env once, without Secrets", JSON.stringify(calls) === JSON.stringify([{ name: "api-1", reveal: false }]), JSON.stringify(calls));
ok("the app container is shown first, not the init one", !!row("MODE") && !row("MIGRATE_ONLY"));
ok("a literal shows its value", val("MODE") === "prod", val("MODE"));
ok("a ConfigMap value shows, with where it came from on the name", val("LEVEL") === "debug" && /cm cfg\/level/.test(row("LEVEL")?.querySelector(".env-key")?.getAttribute("title") ?? ""), row("LEVEL")?.querySelector(".env-key")?.getAttribute("title"));
ok("a Secret value is masked", val("PASS") === "••••••••", val("PASS"));
ok("an envFrom Secret is listed as pending", /every key of Secret bulk — reveal to list/.test(sec()?.textContent ?? ""), sec()?.textContent);
ok("a masked value can't be copied", row("PASS")?.querySelector("button")?.disabled === true);
ok("the footnote says what isn't listed", /image's own ENV/.test(sec()?.textContent ?? ""));

console.log("reveal");
btn("reveal")?.click();
await wait(300);
ok("reveal reads Secrets", calls.at(-1)?.reveal === true, JSON.stringify(calls));
ok("the Secret value shows", val("PASS") === "hunter2", val("PASS"));
ok("envFrom keys are listed", val("TOKEN") === "tok-xyz", val("TOKEN"));
ok("a forbidden Secret says so", /^forbidden/.test(val("OTHER") ?? ""), val("OTHER"));
ok("the button now hides", !!btn("hide"));

console.log("filter and containers");
const box = sec()?.querySelector("input.env-filter");
box.value = "pa";
box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await wait(100);
ok("the filter keeps only matching names", rows().length === 1 && !!row("PASS"), rows().map((r) => r.textContent).join(" | "));
box.value = "";
box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await wait(100);
btn("init:migrate")?.click();
await wait(100);
ok("the init container can be picked", !!row("MIGRATE_ONLY") && !row("MODE"));
btn("app")?.click();
await wait(100);

console.log("hide");
const before = calls.length;
btn("hide")?.click();
ok("values are gone at once", !sec()?.textContent.includes("hunter2"), val("PASS"));
await wait(300);
ok("and re-read without Secrets", calls.length === before + 1 && calls.at(-1).reveal === false, JSON.stringify(calls));
ok("nothing secret is left on screen", !/hunter2|tok-xyz/.test(sec()?.textContent ?? ""));

console.log("another pod starts hidden");
btn("reveal")?.click();
await wait(300);
await openPod("api-2");
ok("its env is read without Secrets", calls.at(-1)?.name === "api-2" && calls.at(-1)?.reveal === false, JSON.stringify(calls.at(-1)));
ok("and masked", val("PASS") === "••••••••", val("PASS"));
console.log("where env sits");
const order = q(".drawer .drawer-body > .psec, .drawer .drawer-body .psec[data-sec]")
  .map((e) => e.getAttribute("data-sec"))
  .filter((x, i, a) => x && a.indexOf(x) === i);
const want = ["events", "meta", "containers", "env", "labels", "yaml"];
ok("events first, then where it runs, the way in, env, then reference", JSON.stringify(order.filter((x) => want.includes(x))) === JSON.stringify(want), order.join(","));
ok("the fold says how many there are", /^Env \(\d+( · \w+)?\)/.test(fold()?.querySelector("summary")?.textContent.trim() ?? ""), fold()?.querySelector("summary")?.textContent);
await openPod("api-1");
ok("it stays open on the next pod", isOpen(), String(fold()?.open));
ok("the choice is saved", localStorage.getItem("pigeoneye.envopen") === "1");

console.log("the Source column");
ok("hidden by default", srcCells() === 0, `${srcCells()} cells`);
ok("names get what the longest needs, up to 60%", keyW() === `min(${LONG.length + 1}ch, 60%)`, keyW());
ok("where a value came from is on the name's tooltip", /cm dotnet\/log — overrides envFrom cm dotnet/.test(row(LONG)?.querySelector(".env-key")?.getAttribute("title") ?? ""), row(LONG)?.querySelector(".env-key")?.getAttribute("title"));
ok("copy is there", !!row("MODE")?.querySelector("button"));
btn("source")?.click();
await wait(100);
ok("shown on a click", srcCells() > 0 && keyW() === "", `${srcCells()} cells, ${keyW()}`);
ok("names go back to their share beside it", getComputedStyle(row(LONG).querySelector(".env-key")).flexBasis !== `min(${LONG.length + 1}ch, 60%)`);
btn("init:migrate")?.click();
await wait(100);
ok("still shown on another container", srcCells() > 0 && !!row("MIGRATE_ONLY"));
btn("app")?.click();
await openPod("api-2");
await wait(200);
ok("and on another pod", srcCells() > 0 && !!row("MODE"), `${srcCells()} cells`);
ok("the choice is saved", localStorage.getItem("pigeoneye.envsrc") === "1");
btn("source")?.click();
await wait(100);
ok("a second click hides it again", srcCells() === 0, `${srcCells()} cells`);
ok("and that is saved too", localStorage.getItem("pigeoneye.envsrc") === "0");

console.log("from the keyboard");
const cur = () => q(".drawer .psec.cur")[0]?.getAttribute("data-sec");
for (let i = 0; i < 12 && cur() !== "env"; i++) { key("ArrowDown"); await wait(30); }
ok("↓ reaches env", cur() === "env", String(cur()));
key("Enter");
await wait(100);
ok("Enter folds it", !isOpen());
key("ArrowRight");
await wait(50);
ok("→ finds no hidden button while folded", !q(".drawer [data-sec='env'] .btn-cursor").length);
key("/");
await wait(100);
ok("/ opens it and goes to the filter", isOpen() && document.activeElement?.classList.contains("env-filter"), `${isOpen()} ${document.activeElement?.className}`);
document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
await wait(50);
key("Enter");
await wait(100);
key("Enter");
await wait(100);
ok("Enter opens it again", isOpen());
ok("no crash", !crash, crash ?? "");

if (failed) { console.error(`POD-ENV SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log("pod-env smoke ok");
process.exit(0);
