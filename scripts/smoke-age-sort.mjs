/**
 * E2E for sorting the AGE column (jsdom).
 *
 * The AGE cell holds whatever the server printed when the row arrived, but the
 * column DISPLAYS a live age that ticks up from there. Sorting the raw cell
 * therefore ordered rows by "how old they were when we first saw them", which
 * drifts away from what is on screen as new rows keep arriving — on a rollout
 * the column visibly stops being sorted (1m above 10s).
 *
 * Rows seeded at t0 are left to age, then more arrive over the watch, so the
 * two orderings disagree; the test asserts the screen is sorted by what it
 * shows. Run: node scripts/smoke-age-sort.mjs
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost/", pretendToBeVisual: true,
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
const COLS = ["Name", "Ready", "Status", "Restarts", "Age"];
const mkRow = (name, age) => ({
  name, namespace: "default", cells: [name, "1/1", "Running", "0", age], labels: {},
});
// Seeded now; by the time the late rows land these will have ticked past them.
const firstTable = {
  columns: COLS.map((name) => ({ name, priority: 0 })),
  rows: [mkRow("seeded-10s", "10s"), mkRow("seeded-20s", "20s")],
  truncated: false, resource_version: "1", include: "Metadata",
};
const LATE = [mkRow("late-12s", "12s"), mkRow("late-22s", "22s")];

let watchChan = null;
dom.window.localStorage.setItem("pigeoneye.session", JSON.stringify({ tabs: ["smoke"], active: "smoke" }));
dom.window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    switch (cmd) {
      case "list_contexts": return Promise.resolve([ctx]);
      case "discover": return Promise.resolve([podType]);
      case "list_namespaces": return Promise.resolve(["default"]);
      case "list_resources": return Promise.resolve(firstTable);
      case "cached_list": return Promise.resolve(null);
      case "watch_start": watchChan = args?.channel; return Promise.resolve(1);
      case "pod_stats": return Promise.resolve([]);
      case "aggregate_issues": return Promise.resolve(null);
      default: return Promise.resolve([]);
    }
  },
  transformCallback: (f) => f, convertFileSrc: (s) => s,
};

const bundle = fs.readdirSync("dist/assets").find((f) => f.endsWith(".js"));
if (!bundle) { console.error("run `npm run build` first"); process.exit(1); }
let crash = null;
dom.window.addEventListener("error", (e) => (crash = e.message));
dom.window.addEventListener("unhandledrejection", (e) => (crash = String(e.reason)));
const fail = (why, d) => { console.error(`AGE-SORT SMOKE FAILED — ${why}`); if (d) console.error(String(d).slice(0, 800)); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => document.getElementById("root");
const q = (sel, el = root()) => [...el.querySelectorAll(sel)];
const secs = (s) => {
  const m = String(s).trim().match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !m[0]) return null;
  const n = (x) => (x ? +x : 0);
  return ((n(m[1]) * 24 + n(m[2])) * 60 + n(m[3])) * 60 + n(m[4]);
};

await import(`../dist/assets/${bundle}`);
await wait(400);
q("button.launcher-item").find((b) => b.textContent?.includes("smoke"))?.click();
await wait(500);
q("button.kind").find((b) => b.textContent?.trim().startsWith("Pod"))?.click();
await wait(500);
if (crash) fail("crash loading the list", crash);
if (q("tr.row").length !== 2) fail(`expected the 2 seeded rows, got ${q("tr.row").length}`);

// Let the seeded rows age past the ages the late rows will arrive with.
await wait(4000);
if (!watchChan) fail("the watch never started, so no rows can arrive late");
watchChan.onmessage({ type: "ADDED", rows: LATE });
await wait(1200); // the watch flush is debounced
if (crash) fail("crash taking the watched rows", crash);
if (q("tr.row").length !== 4) fail(`expected 4 rows after the watch, got ${q("tr.row").length}`);

// Sort by AGE, ascending.
const headers = q("th");
const ageTh = headers.find((h) => /^\s*age/i.test(h.textContent || ""));
if (!ageTh) fail(`no AGE header among: ${headers.map((h) => (h.textContent || "").trim()).join(", ")}`);
for (let i = 0; i < 3; i++) {
  ageTh.querySelector(".th-text")?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await wait(200);
  if ((ageTh.textContent || "").includes("▲")) break;
}
if (!(ageTh.textContent || "").includes("▲")) fail("could not get the AGE column into ascending order");
if (crash) fail("crash sorting", crash);

const ageIdx = headers.indexOf(ageTh);
const rows = q("tr.row").map((r) => ({
  name: (r.querySelectorAll("td")[0]?.textContent || "").trim(),
  age: (r.querySelectorAll("td")[ageIdx]?.textContent || "").trim(),
}));
const shown = rows.map((r) => secs(r.age));
if (shown.some((v) => v === null)) fail(`unparsable AGE cells: ${JSON.stringify(rows)}`);

for (let i = 1; i < shown.length; i++) {
  if (shown[i] < shown[i - 1])
    fail(
      `the AGE column is not sorted by what it shows: ` +
      rows.map((r) => `${r.name}=${r.age}`).join(" → ") +
      ` (sorting the raw cell instead of the live age puts an older row above a newer one)`,
    );
}
// The seeded rows have ticked past the late ones, so a live-age sort must
// interleave them — raw-cell order would start with seeded-10s.
if (rows[0].name !== "late-12s")
  fail(`expected the youngest SHOWN row (late-12s) first, got ${rows[0].name} — ` +
       `order was ${rows.map((r) => `${r.name}=${r.age}`).join(" → ")}`);

console.log(
  `age-sort smoke ok — seeded rows aged past the watched ones and the column still ` +
  `reads in order: ${rows.map((r) => `${r.name}=${r.age}`).join(" → ")}`,
);
process.exit(0);
