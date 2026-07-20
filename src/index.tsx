/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";

// A crash during render leaves an empty webview with no clue why; put
// the reason on screen instead of a black window.
function showFatal(msg: string) {
  const root = document.getElementById("root");
  if (root)
    root.innerHTML =
      '<pre style="padding:20px;color:#f2a5a5;font:12px ui-monospace,monospace;white-space:pre-wrap">' +
      msg.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;")) +
      "</pre>";
}

window.addEventListener("error", (e) =>
  showFatal(`${e.message}\n${e.error?.stack ?? ""}`),
);
window.addEventListener("unhandledrejection", (e) =>
  showFatal(`unhandled rejection: ${String(e.reason)}`),
);

try {
  render(() => <App />, document.getElementById("root") as HTMLElement);
} catch (e) {
  showFatal(String((e as Error)?.stack ?? e));
}
