/**
 * Render the built bundle in jsdom and fail if the app crashes.
 * A render-time crash shows up as an empty webview with no message,
 * so this catches it in the terminal instead: `npm run smoke`.
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
global.customElements = dom.window.customElements;
global.localStorage = dom.window.localStorage;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.MutationObserver = dom.window.MutationObserver;
// jsdom has no ResizeObserver; the virtual table observes its viewport
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
// Minimal Tauri shim: every command resolves to an empty list.
dom.window.__TAURI_INTERNALS__ = {
  invoke: () => Promise.resolve([]),
  transformCallback: (f) => f,
  convertFileSrc: (s) => s,
};

const bundle = fs
  .readdirSync("dist/assets")
  .find((f) => f.endsWith(".js"));
if (!bundle) {
  console.error("no bundle in dist/assets — run `npm run build` first");
  process.exit(1);
}

await import(`../dist/assets/${bundle}`);
await new Promise((r) => setTimeout(r, 800));

const html = document.getElementById("root").innerHTML;
if (!html || html.startsWith("<pre")) {
  console.error("SMOKE FAILED — the app did not render:\n");
  console.error(html.replace(/<[^>]+>/g, "").slice(0, 2000));
  process.exit(1);
}
console.log(`smoke ok — rendered ${html.length} bytes`);
