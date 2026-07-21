/**
 * Render the built bundle in jsdom and fail if the app crashes.
 * A render-time crash shows up as an empty webview with no message,
 * so this catches it in the terminal instead: `npm run smoke`.
 *
 * It drives the app past the launcher into a connected cluster with a
 * populated table, so the table/search/virtual-scroll paths — where
 * most render crashes hide — actually run.
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.Window = dom.window.Window || dom.window.constructor;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLInputElement = dom.window.HTMLInputElement;
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.customElements = dom.window.customElements;
global.localStorage = dom.window.localStorage;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.MutationObserver = dom.window.MutationObserver;
// jsdom has no ResizeObserver; the virtual table observes its viewport
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

// A cluster with a real table, so selecting a kind exercises the view.
const ctx = {
  name: "smoke",
  cluster: "c",
  user: "u",
  namespace: null,
  is_current: true,
  source: "",
};
const types = [
  { group: "", version: "v1", kind: "Pod", plural: "pods", namespaced: true, deletable: true, editable: true },
];
const table = {
  columns: [
    { name: "Name", priority: 0 },
    { name: "Ready", priority: 0 },
    { name: "Status", priority: 0 },
    { name: "Nominated Node", priority: 1 },
  ],
  rows: Array.from({ length: 1200 }, (_, i) => ({
    name: `pod-${i}`,
    namespace: `ns-${i % 20}`,
    cells: [`pod-${i}`, "1/1", "Running", "<none>"],
    labels: { app: `svc-${i % 5}` },
  })),
  truncated: false,
  resource_version: "1",
  include: "None",
};

// Pre-open the smoke context so the app connects on boot instead of
// showing the launcher.
dom.window.localStorage.setItem(
  "pigeoneye.session",
  JSON.stringify({ tabs: ["smoke"], active: "smoke" }),
);

dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd) => {
    switch (cmd) {
      case "list_contexts":
        return Promise.resolve([ctx]);
      case "discover":
        return Promise.resolve(types);
      case "list_namespaces":
        return Promise.resolve(["ns-0", "ns-1", "ns-2"]);
      case "list_resources":
        return Promise.resolve(table);
      case "cached_list":
        return Promise.resolve(null);
      case "pod_stats":
        return Promise.resolve([]);
      case "filter_rows":
        // A deep-field-only hit (name doesn't contain the query) keyed by
        // namespace/name — the frontend must union it by key, not index.
        return Promise.resolve(["ns-5/pod-5"]);
      case "ensure_index":
        return Promise.resolve(null);
      case "create_resource":
        return Promise.resolve("my-pod");
      default:
        return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f,
  convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) {
  console.error("no bundle in dist/assets — run `npm run build` first");
  process.exit(1);
}

const fail = (why, detail) => {
  console.error(`SMOKE FAILED — ${why}:\n`);
  if (detail) console.error(detail.slice(0, 2000));
  process.exit(1);
};

// A render crash surfaces as index.tsx's <pre> or as an uncaught error.
let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
dom.window.addEventListener(
  "unhandledrejection",
  (e) => (crash = String(e.reason)),
);

await import(`../dist/assets/${bundle}`);
await new Promise((r) => setTimeout(r, 400));

const root = document.getElementById("root");
// launcher → connect the context
const launch = [...root.querySelectorAll("button.launcher-item")].find((b) =>
  b.textContent?.includes("smoke"),
);
launch?.click();
await new Promise((r) => setTimeout(r, 500));
// sidebar → select the Pod kind so the table renders
const pickKind = () =>
  [...root.querySelectorAll("button.kind")].find((b) =>
    b.textContent?.trim().startsWith("Pod"),
  );
pickKind()?.click();
await new Promise((r) => setTimeout(r, 500));

const html = root.innerHTML;
if (crash) fail("uncaught error", crash);
if (!html || html.startsWith("<pre")) fail("did not render", html.replace(/<[^>]+>/g, ""));

const rowsRendered = root.querySelectorAll("tr.row").length;
if (rowsRendered === 0) {
  // the table container exists but produced no rows — the view path broke
  const hasTable = !!root.querySelector(".table-wrap");
  fail(
    hasTable ? "table rendered no rows" : "never reached the table",
    html.replace(/<[^>]+>/g, ""),
  );
}

// Search: a name match (pod-777) plus a deep-only backend hit (ns-5/pod-5).
// The result must contain BOTH — proving the backend hit unions by key —
// with the name match ranked above the deep-only one.
const search = root.querySelector("input.search.wide");
if (!search) fail("no search box", html.replace(/<[^>]+>/g, ""));
search.value = "pod-777";
search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 300));
if (crash) fail("crash while searching", crash);
const names = () =>
  [...root.querySelectorAll("tr.row")].map((tr) => tr.textContent || "");
const after = names();
const isP5 = (t) => /pod-5(?!\d)/.test(t); // pod-5, not pod-50/500
const has777 = after.some((t) => t.includes("pod-777"));
const has5 = after.some(isP5);
if (!has777) fail("search dropped the name match pod-777", after.join(" | "));
if (!has5) fail("search dropped the deep/keyed hit pod-5", after.join(" | "));
const i777 = after.findIndex((t) => t.includes("pod-777"));
const i5 = after.findIndex(isP5);
if (i5 < i777)
  fail("deep-only hit outranked the name match", after.join(" | "));

// New (create) flow: the "+ New" button opens a modal seeded with the
// Pod starter manifest.
const newBtn = [...root.querySelectorAll("button")].find(
  (b) => b.textContent?.trim() === "+ New",
);
if (!newBtn) fail("no + New button for a kind with a template", html.replace(/<[^>]+>/g, ""));
newBtn.click();
await new Promise((r) => setTimeout(r, 200));
if (crash) fail("crash opening New modal", crash);
const modal = root.querySelector(".new-modal");
if (!modal) fail("New modal did not open", root.innerHTML.replace(/<[^>]+>/g, "").slice(0, 400));
if (!modal.textContent?.includes("New Pod"))
  fail("New modal missing kind title", modal.textContent || "");

console.log(`smoke ok — table rendered ${rowsRendered} windowed rows, search ranked name over deep hit, New modal opens`);
process.exit(0); // the app keeps timers alive; we are done
