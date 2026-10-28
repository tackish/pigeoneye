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

/// A rejected promise is not a dead app. Most of them are a request that
/// lost its connection — a tunnel dropping, an API server closing a stream —
/// and the window behind them is still perfectly usable. Wiping it for one
/// of those is the worst possible answer: it throws away the view, the
/// search, the open detail and every other cluster over something that would
/// have resolved itself on the next poll.
///
/// So once App is up it reports them where errors belong, in the app's own
/// error line. Only a rejection that lands BEFORE that — a failure to start
/// at all — still gets the screen, because then there is nothing else to
/// show.
window.addEventListener("unhandledrejection", (e) => {
  const report = (window as unknown as { __peyeError?: (m: string) => void })
    .__peyeError;
  if (!report) {
    showFatal(`unhandled rejection: ${String(e.reason)}`);
    return;
  }
  e.preventDefault();
  console.error("unhandled rejection", e.reason);
  report(String(e.reason));
});

try {
  render(() => <App />, document.getElementById("root") as HTMLElement);
} catch (e) {
  showFatal(String((e as Error)?.stack ?? e));
}
