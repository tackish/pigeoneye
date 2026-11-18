/**
 * E2E for the detail panel's Status (live) section (jsdom).
 *
 * A list of objects used to be a table, and in a panel this narrow it cut
 * the values people come for — image, image ID, container ID — to
 * "ghcr.io/kedacore/keda-m…", readable only by hover and not copyable. A
 * short list now reads one card per object with every value whole and a
 * copy button; a one-field list (host IPs) is one line; a long list stays a
 * table. A condition's message wraps instead of being cut.
 * Run: node scripts/smoke-status-view.mjs
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
let clip = null;
const clipboard = { writeText: (t) => { clip = t; return Promise.resolve(); } };
Object.defineProperty(globalThis.navigator, "clipboard", { value: clipboard, configurable: true });
Object.defineProperty(dom.window.navigator, "clipboard", { value: clipboard, configurable: true });

const IMAGE = "ghcr.io/kedacore/keda-metrics-apiserver:2.16.1";
const IMAGE_ID = "ghcr.io/kedacore/keda-metrics-apiserver@sha256:3c9a4f3b1e0d2a7c5b8e6f4a2d1c0b9e8f7a6d5c4b3a2918f7e6d5c4b3a29180";
const CTR_ID = "containerd://848872a7d0c3e9f1b2a4d6c8e0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8";
const STARTED = "2026-11-15T17:04:13Z";
const ctr = (name, extra = {}) => ({
  containerID: CTR_ID, image: IMAGE, imageID: IMAGE_ID, name, ready: true, restartCount: 0, started: true,
  state: { running: { startedAt: STARTED } },
  lastState: {},
  ...extra,
});
const status = {
  hostIP: "10.210.77.79", phase: "Running", podIP: "10.210.72.207", qosClass: "Burstable", startTime: STARTED,
  conditions: [
    { type: "Ready", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [keda-operator-metrics-apiserver sidecar-with-a-long-name]", lastTransitionTime: STARTED },
    { type: "PodScheduled", status: "True", lastTransitionTime: STARTED },
  ],
  containerStatuses: [ctr("keda-operator-metrics-apiserver"), ctr("sidecar", { restartCount: 3 })],
  hostIPs: [{ ip: "10.210.77.79" }],
  podIPs: [{ ip: "10.210.72.207" }, { ip: "fd00::7" }],
  // A long list of objects (a node's images, say) stays a table.
  images: Array.from({ length: 15 }, (_, i) => ({ name: `img-${i}`, sizeBytes: 1000 + i })),
};

const ctx = { name: "smoke", cluster: "c", user: "u", namespace: null, is_current: true, source: "", server: "https://s:6443" };
const podType = { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true };
const col = (name) => ({ name, priority: 0 });
const podTable = {
  columns: [col("Name"), col("Ready"), col("Status"), col("Restarts"), col("Age")],
  rows: [{ name: "keda-1", namespace: "keda", labels: {}, cells: ["keda-1", "1/1", "Running", "0", "2d"] }],
  truncated: false, resource_version: "1", include: "Metadata",
};
const detail = (name) => ({
  name, namespace: "keda", created: STARTED, labels: {}, annotations: {}, status,
  unschedulable: null, node_name: "ip-a", ports: [], containers: ["keda-operator-metrics-apiserver", "sidecar"],
  resource_version: "9", involved: null, links: [], has_pod_selector: false, pod_selector: null,
  secret_data: [], replicas: null, ready_replicas: null, generation: null, yaml: "kind: Pod\n",
});

dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["keda"]);
      case "list_resources": return Promise.resolve(podTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": return Promise.resolve(1);
      case "pod_events_watch": return Promise.resolve(7);
      case "aggregate_issues": return Promise.resolve(null);
      case "pod_stats": return Promise.reject(new Error("metrics API unavailable"));
      case "pod_exits": return Promise.resolve([]);
      case "node_types": return Promise.resolve([]);
      case "get_resource": return Promise.resolve(detail(args?.name));
      case "get_events": return Promise.resolve([]);
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
const sec = () => q(".drawer [data-sec='status']")[0];
const group = (title) => (sec() ? q(".st-group", sec()).find((g) => g.querySelector(":scope > .st-title")?.textContent === title) : null);
/// The value shown beside `key` in a grid, without its copy button.
const valOf = (el, key) => {
  const k = el ? q(".st-key", el).find((x) => x.textContent === key) : null;
  const v = k?.nextElementSibling;
  return v ? [...v.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("") : null;
};
const copyOf = (el, key) => q(".st-key", el).find((x) => x.textContent === key)?.nextElementSibling?.querySelector(".st-copy");

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(800);
q("tbody tr.row").find((r) => r.textContent.includes("keda-1"))?.click();
await wait(500);
sec()?.querySelector("details.fold > summary")?.click();
await wait(100);

console.log("container statuses");
const cs = group("Container Statuses");
const cards = cs ? q(".st-card", cs) : [];
ok("one card per container, not a table", cards.length === 2 && !cs.querySelector("table"), `${cards.length} cards`);
ok("each card is titled with its container", cards.map((c) => c.querySelector(".st-card-title")?.textContent).join(",") === "keda-operator-metrics-apiserver,sidecar", cards.map((c) => c.querySelector(".st-card-title")?.textContent).join(","));
ok("the image is shown whole", valOf(cards[0], "Image") === IMAGE, valOf(cards[0], "Image"));
ok("so is the image ID", valOf(cards[0], "Image ID") === IMAGE_ID, valOf(cards[0], "Image ID"));
ok("and the container ID", valOf(cards[0], "Container ID") === CTR_ID, valOf(cards[0], "Container ID"));
ok("the name isn't repeated as a row", valOf(cards[0], "Name") === null);
ok("the second container's own numbers", valOf(cards[1], "Restart Count") === "3", valOf(cards[1], "Restart Count"));
copyOf(cards[0], "Image ID")?.click();
await wait(50);
ok("copy puts the whole value on the clipboard", clip === IMAGE_ID, String(clip));
ok("and says so", copyOf(cards[0], "Image ID")?.textContent === "✓", copyOf(cards[0], "Image ID")?.textContent);
const sub = cards[0] ? q("details.st-sub > summary", cards[0]).map((s) => s.textContent) : [];
ok("state and last state fold inside the card", sub.includes("State") && sub.includes("Last State"), sub.join(","));

console.log("one-field lists");
const hip = group("Host I Ps") ?? group("Host IPs");
ok("host IPs are a line, not a table", !!hip && !hip.querySelector("table") && valOf(hip, "IP") === "10.210.77.79", hip?.textContent);
const pip = group("Pod I Ps") ?? group("Pod IPs");
ok("pod IPs list each address", !!pip && q(".st-val", pip).length === 2, pip?.textContent);

console.log("the rest");
ok("a top-level value can be copied too", !!copyOf(sec(), "Host IP"));
copyOf(sec(), "Start Time")?.click();
await wait(50);
ok("a time copies as the timestamp, not '2d ago'", clip === STARTED, String(clip));
const msg = group("Conditions")?.querySelector("td.st-wrap");
ok("a condition's message wraps instead of being cut", !!msg && msg.textContent.includes("sidecar-with-a-long-name"), msg?.outerHTML.slice(0, 120));
ok("a long list stays a table", !!group("Images")?.querySelector("table"), group("Images")?.innerHTML.slice(0, 80));
ok("no crash", !crash, crash ?? "");

if (failed) { console.error(`STATUS-VIEW SMOKE FAILED — ${failed} check(s)`); process.exit(1); }
console.log("status-view smoke ok");
process.exit(0);
