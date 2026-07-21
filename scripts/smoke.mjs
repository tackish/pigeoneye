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
        return Promise.resolve([]);
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

console.log(`smoke ok — table rendered ${rowsRendered} windowed rows`);
process.exit(0); // the app keeps timers alive; we are done
