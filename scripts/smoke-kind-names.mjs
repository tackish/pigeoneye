/**
 * E2E for typing a kind the way kubectl takes it (jsdom).
 *
 * `:svc` opened Services, but `:svc api` on a single open cluster offered
 * only "Service · api — in namespace", and api is not a namespace: the list
 * came up empty. The search row was kept for two or more clusters. And
 * only a fixed table of aliases was known — a server's own short names
 * (`ep`, `quota`, a CRD's `vs`) and plurals were not, nor were any of them
 * in the sidebar's kind filter.
 * Run: node scripts/smoke-kind-names.mjs   (TABS=2 for two open clusters)
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const TABS = Number(process.env.TABS || 1);
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
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

const NAMES = ["one", "two"].slice(0, TABS);
const ctxInfo = (name) => ({ name, cluster: name, user: "u", namespace: null, is_current: name === "one", source: "", server: `https://${name}:6443` });
const rt = (group, kind, plural, namespaced, short_names) => ({ group, version: "v1", kind, plural, namespaced, deletable: true, editable: true, ...(short_names ? { short_names } : {}) });
const TYPES = [
  rt("", "Pod", "pods", true, ["po"]),
  rt("", "Service", "services", true, ["svc"]),
  rt("", "ServiceAccount", "serviceaccounts", true, ["sa"]),
  rt("", "Endpoints", "endpoints", true), // no short names: an older server
  rt("", "ResourceQuota", "resourcequotas", true, ["quota"]),
  rt("", "Namespace", "namespaces", false, ["ns"]),
  rt("networking.istio.io", "VirtualService", "virtualservices", true, ["vs"]),
  rt("argoproj.io", "Rollout", "rollouts", true, ["ro"]),
];
const searches = [];
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: NAMES, active: "one" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve(NAMES.map(ctxInfo));
      case "discover": return Promise.resolve(TYPES);
      case "list_namespaces": return Promise.resolve(["default", "kube-system", "web"]);
      case "list_resources": return Promise.resolve({ columns: [{ name: "Name", priority: 0 }], rows: [], truncated: false, resource_version: "1", include: "None" });
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "aggregate_issues": return Promise.resolve(null);
      case "search_contexts": {
        searches.push({ kind: args.resource.kind, query: args.query, contexts: args.contexts });
        setTimeout(() => {
          for (const c of args.contexts)
            args.channel.onmessage({ context: c, hits: [{ context: c, namespace: "web", name: "api-gateway" }], total: 1, age_ms: 0, error: null });
        }, 0);
        return Promise.resolve(null);
      }
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
let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const type = (el, v) => {
  el.value = v;
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const openPalette = async () => {
  if (!q(".cmd-input").length) {
    document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: ":", bubbles: true }));
    await wait(50);
  }
  return q(".cmd-input")[0];
};
const palette = async (text) => {
  const input = await openPalette();
  type(input, text);
  await wait(30);
  return q(".cmd-item").map((b) => b.textContent.replace(/\s+/g, " ").trim());
};

await import(`../dist/assets/${bundle}`);
await wait(600);
if (!q("button.kind").length) {
  q("button.launcher-item").find((b) => b.textContent?.includes("one"))?.click();
  await wait(500);
}

console.log(`the palette, with ${TABS} open cluster${TABS > 1 ? "s" : ""}`);
let items = await palette("svc");
ok("svc opens Services", items[0]?.startsWith("Service"), items[0]);
items = await palette("services");
ok("so does the plural", items[0]?.startsWith("Service"), items[0]);
items = await palette("vs");
ok("a CRD's short name, from the server", items[0]?.startsWith("VirtualService"), items[0]);
items = await palette("ro");
ok("another one", items[0]?.startsWith("Rollout"), items[0]);
items = await palette("ep");
ok("kubectl's own, on a server that doesn't say it", items[0]?.startsWith("Endpoints"), items[0]);
items = await palette("quota");
ok("quota", items[0]?.startsWith("ResourceQuota"), items[0]);
items = await palette("po");
ok("po still opens Pods first", items[0]?.startsWith("Pod"), items[0]);

items = await palette("svc api");
ok("svc <name> leads with finding it", items[0]?.includes("search") && items[0]?.includes('Service "api"'), items.join(" | "));
ok(TABS > 1 ? "across every cluster" : "in this cluster", TABS > 1 ? items[0]?.includes("every cluster") : items[0]?.includes("this cluster"), items[0]);
ok("the namespace reading is still offered", items.some((t) => t.startsWith("Service · api")), items.join(" | "));
document.querySelector(".cmd-input").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await wait(80);
ok("enter searches Services for it", searches.at(-1)?.kind === "Service" && searches.at(-1)?.query === "api", JSON.stringify(searches.at(-1)));
ok("on every open cluster", searches.at(-1)?.contexts?.length === TABS, JSON.stringify(searches.at(-1)?.contexts));
items = q(".cmd-item").map((b) => b.textContent.replace(/\s+/g, " ").trim());
ok("and lists what it found", items.some((t) => t.includes("web/api-gateway")), items.join(" | "));
document.querySelector(".cmd-input").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(30);

items = await palette("svc kube");
ok("a word that is a namespace still means it first", items[0]?.startsWith("Service · kube-system"), items.join(" | "));
items = await palette("svc @one");
ok("@ctx is untouched", items[0]?.startsWith("Service @ one") && !items.some((t) => t.includes("search")), items.join(" | "));
items = await palette("svc app=web");
ok("a label selector is untouched", items[0]?.startsWith("Service app=web") && !items.some((t) => t.includes("search")), items.join(" | "));
document.querySelector(".cmd-input")?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(30);

console.log("the sidebar's kind filter");
const filter = q("input.search").find((i) => i.placeholder?.startsWith("filter kinds"));
const shown = async (v) => {
  type(filter, v);
  await wait(30);
  return q("button.kind").map((b) => b.textContent.trim().match(/^[A-Za-z]+/)?.[0]).filter(Boolean);
};
let kinds = await shown("svc");
ok("svc finds Service", kinds.includes("Service"), kinds.join(","));
kinds = await shown("vs");
ok("vs finds VirtualService", kinds.includes("VirtualService"), kinds.join(","));
kinds = await shown("serv");
ok("a part of the name still finds every kind with it", ["Service", "ServiceAccount", "VirtualService"].every((k) => kinds.includes(k)), kinds.join(","));
kinds = await shown("istio");
ok("and the group still works", kinds.includes("VirtualService") && !kinds.includes("Pod"), kinds.join(","));
ok("no crash", !crash, crash ?? "");

if (failed) { console.error(`KIND-NAMES SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log("kind-names smoke ok");
process.exit(0);
