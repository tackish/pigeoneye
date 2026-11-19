/**
 * E2E for something made after the app connected showing up (jsdom).
 *
 * The namespace list was read once, when the cluster connected: a namespace
 * created afterwards — with kubectl, or from this app's own New dialog —
 * never reached the namespace picker, `:ns`, or the New dialog until the
 * app reconnected. And creating from the second pane re-listed the first
 * pane instead, so without a watch the new object never came. Kinds had
 * the same problem: a CRD installed after connect was in neither the
 * sidebar nor `:`. Drives the server changing underneath and asserts each
 * place catches up.
 * Run: node scripts/smoke-fresh-lists.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

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
dom.window.HTMLElement.prototype.scrollBy = function () {};
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
dom.window.document.elementFromPoint = () => null;

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const rt = (kind, plural, namespaced, group = "", short_names) => ({ group, version: "v1", kind, plural, namespaced, deletable: true, editable: true, ...(short_names ? { short_names } : {}) });
// The cluster, as the server sees it.
const server = {
  ns: ["default", "web"],
  cms: ["cm-a"],
  crds: [],
  types: [
    rt("Pod", "pods", true), rt("ConfigMap", "configmaps", true), rt("Namespace", "namespaces", false),
    rt("CustomResourceDefinition", "customresourcedefinitions", false, "apiextensions.k8s.io", ["crd"]),
  ],
};
let nsReads = 0;
let discovers = 0;
// The app's throttles read Date.now(); let the test move it on.
let skew = 0;
const realNow = Date.now.bind(Date);
dom.window.Date.now = Date.now = () => realNow() + skew;
const watches = [];
const table = (names, cols, ns) => ({
  columns: cols.map((name) => ({ name, priority: 0 })),
  rows: names.map((n) => ({ name: n, namespace: ns, labels: {}, cells: [n, ...cols.slice(1).map(() => "x")] })),
  truncated: false, resource_version: "1", include: "None",
});
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args = {}) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      // A fresh copy every time, as the real thing sends.
      case "discover": {
        discovers++;
        const copy = JSON.parse(JSON.stringify(server.types));
        return new Promise((r) => setTimeout(() => r(copy), 40));
      }
      case "list_namespaces": nsReads++; return Promise.resolve([...server.ns]);
      case "list_resources": {
        const k = args.resource?.kind;
        if (k === "Namespace") return Promise.resolve(table(server.ns, ["Name", "Status"], null));
        if (k === "ConfigMap") return Promise.resolve(table(server.cms, ["Name", "Data"], "default"));
        if (k === "CustomResourceDefinition") return Promise.resolve(table(server.crds, ["Name", "Created At"], null));
        return Promise.resolve(table([], ["Name"], null));
      }
      case "cached_list": return Promise.resolve(null);
      case "watch_start": watches.push({ kind: args.resource.kind, ch: args.channel }); return Promise.resolve(watches.length);
      case "aggregate_issues": return Promise.resolve(null);
      case "create_resource": server.cms.push("made-here"); return Promise.resolve("made-here");
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
const key = (k, el = document.body) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
const kindBtn = (k) => q("button.kind").find((b) => b.textContent?.trim().startsWith(k));
const topNsBtn = () => q("button.ns-btn").find((b) => !b.closest(".new-ns") && /namespaces|^default|^web/.test(b.textContent.trim()));
const pickerItems = () => q(".ns-pop .ns-item").map((b) => b.textContent.trim());
const palette = async (text) => {
  if (!q(".cmd-input").length) { key(":"); await wait(50); }
  const input = q(".cmd-input")[0];
  input.value = text;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await wait(30);
  return q(".cmd-item").map((b) => b.textContent.replace(/\s+/g, " ").trim());
};
const closePalette = async () => { if (q(".cmd-input").length) { key("Escape", q(".cmd-input")[0]); await wait(30); } };

await import(`../dist/assets/${bundle}`);
await wait(600);
if (!kindBtn("Pod")) { q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click(); await wait(500); }
kindBtn("Pod")?.click();
await wait(300);

console.log("a namespace made elsewhere (kubectl)");
const atConnect = nsReads;
server.ns.push("fresh");
topNsBtn()?.click();
await wait(80);
ok("opening the picker reads them again", nsReads === atConnect + 1, `${nsReads - atConnect} reads`);
ok("and the new one is there", pickerItems().includes("fresh"), pickerItems().join(","));
topNsBtn()?.click();
await wait(30);

server.ns.push("fresher");
let items = await palette("ns fresher");
ok(":ns knows it", items.some((t) => t === "ns fresher switch namespace" || t.startsWith("ns fresher")), items.join(" | "));
await closePalette();
const afterPalette = nsReads;
await palette("ns");
await closePalette();
ok("the palette doesn't re-read every time it opens", nsReads === afterPalette, `${nsReads - afterPalette} more`);

console.log("the Namespace list on screen");
kindBtn("Namespace")?.click();
await wait(300);
const nsWatch = watches.filter((w) => w.kind === "Namespace").at(-1);
ok("is watched", !!nsWatch);
const readsBefore = nsReads;
nsWatch?.ch.onmessage({ type: "ADDED", rows: [{ name: "watched", namespace: null, labels: {}, cells: ["watched", "Active"] }] });
await wait(900);
ok("a namespace it sees made shows in the list", q("tbody tr.row").some((r) => r.textContent.includes("watched")));
items = await palette("ns watched");
ok("and in :ns, with nothing asked", items.some((t) => t.startsWith("ns watched")) && nsReads === readsBefore, `${items.join(" | ")} · ${nsReads - readsBefore} reads`);
await closePalette();
nsWatch?.ch.onmessage({ type: "DELETED", rows: [{ name: "watched", namespace: null, labels: {}, cells: [] }] });
await wait(100);
items = await palette("ns watched");
ok("one it sees deleted leaves :ns", !items.some((t) => t.startsWith("ns watched")), items.join(" | "));
await closePalette();

console.log("the New dialog");
kindBtn("ConfigMap")?.click();
await wait(300);
server.ns.push("later");
const beforeNew = nsReads;
q("button").find((b) => b.textContent.trim() === "+ New")?.click();
await wait(80);
ok("opening it reads them again", nsReads === beforeNew + 1, `${nsReads - beforeNew} reads`);
q(".new-ns button.ns-btn")[0]?.click();
await wait(50);
const newItems = q(".new-ns .ns-item").map((b) => b.textContent.trim());
ok("so its namespace list has the new one", newItems.includes("later"), newItems.join(","));
key("Escape", q(".new-ns input.search")[0] ?? document.body);
await wait(30);
key("Escape");
await wait(50);
q(".modal-actions button").find((b) => b.textContent.trim() === "Cancel")?.click();
await wait(50);

console.log("making one from the second pane");
q("button.split-toggle")[0]?.click();
await wait(500);
let panes = q(".primary-pane");
ok("split open on ConfigMaps", panes.length === 2 && q("tr.row", panes[1]).some((r) => r.textContent.includes("cm-a")), `${panes.length} panes`);
panes[1]?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
await wait(50);
q("button", panes[1]).find((b) => b.textContent.trim() === "+ New")?.click();
await wait(80);
q(".modal-actions button.primary")[0]?.click();
await wait(300);
panes = q(".primary-pane");
ok("the pane it was made from shows it", q("tr.row", panes[1]).some((r) => r.textContent.includes("made-here")), q("tr.row", panes[1]).map((r) => r.textContent.slice(0, 20)).join(","));
q("button.split-toggle")[0]?.click();
await wait(300);

console.log("a CRD installed after connect");
const sideKinds = () => q("button.kind").map((b) => b.textContent.trim().match(/^[A-Za-z]+/)?.[0]).filter(Boolean);
kindBtn("Pod")?.click();
await wait(300);
const atStart = discovers;
server.types.push(rt("Rollout", "rollouts", true, "argoproj.io", ["ro"]));
server.crds.push("rollouts.argoproj.io");
items = await palette("rollout");
ok("isn't there yet, and the palette says so", items[0]?.startsWith('no kind "rollout"'), items.join(" | "));
await wait(120);
items = q(".cmd-item").map((b) => b.textContent.replace(/\s+/g, " ").trim());
ok("looking for it asks the cluster", discovers === atStart + 1, `${discovers - atStart} asks`);
ok("and then it is there", items[0]?.startsWith("Rollout"), items.join(" | "));
items = await palette("ro");
ok("by its short name too", items[0]?.startsWith("Rollout"), items.join(" | "));
ok("and in the sidebar", sideKinds().includes("Rollout"), sideKinds().join(","));
ok("the kind on screen is still the one selected", q("button.kind.active").some((b) => b.textContent.trim().startsWith("Pod")) && q("tbody tr.row").length >= 0);
items = await palette("nosuchkind");
await wait(50);
ok("another miss right away doesn't ask again", discovers === atStart + 1, `${discovers - atStart} asks`);
ok("but says there is none", q(".cmd-item")[0]?.textContent.includes('no kind "nosuchkind"'), q(".cmd-item")[0]?.textContent);
key("Enter", q(".cmd-input")[0]);
await wait(120);
ok("enter on it asks anyway", discovers === atStart + 2, `${discovers - atStart} asks`);
await closePalette();

skew += 20_000;
server.types.push(rt("Certificate", "certificates", true, "cert-manager.io", ["cert"]));
const filterBox = q("input.search").find((i) => i.placeholder?.startsWith("filter kinds"));
filterBox.value = "cert";
filterBox.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await wait(150);
ok("the sidebar's filter finding nothing asks too", sideKinds().includes("Certificate"), sideKinds().join(","));
filterBox.value = "";
filterBox.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await wait(50);

server.types.push(rt("Issuer", "issuers", true, "cert-manager.io"));
server.crds.push("certificates.cert-manager.io", "issuers.cert-manager.io");
const beforeCrd = discovers;
kindBtn("CustomResourceDefinition")?.click();
await wait(400);
ok("the CRD list naming one not served asks once", discovers === beforeCrd + 1, `${discovers - beforeCrd} asks`);
const seenCrd = discovers;
items = await palette("issuer");
ok("so it can be opened", items[0]?.startsWith("Issuer") && discovers === seenCrd, `${items.join(" | ")} · ${discovers - seenCrd} asks`);
await closePalette();
const crdWatch = watches.filter((w) => w.kind === "CustomResourceDefinition").at(-1);
server.types = server.types.filter((t) => t.kind !== "Issuer");
server.crds = server.crds.filter((n) => n !== "issuers.cert-manager.io");
crdWatch?.ch.onmessage({ type: "DELETED", rows: [{ name: "issuers.cert-manager.io", namespace: null, labels: {}, cells: [] }] });
await wait(200);
items = await palette("issuer");
ok("one deleted takes its kind away", items[0]?.startsWith('no kind "issuer"'), items.join(" | "));
await closePalette();
const settled = discovers;
crdWatch?.ch.onmessage({ type: "MODIFIED", rows: [{ name: "rollouts.argoproj.io", namespace: null, labels: {}, cells: ["rollouts.argoproj.io", "x"] }] });
await wait(900);
ok("a CRD merely changing asks nothing", discovers === settled, `${discovers - settled} asks`);
ok("no crash", !crash, crash ?? "");

if (failed) { console.error(`FRESH-LISTS SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log("fresh-lists smoke ok");
process.exit(0);
