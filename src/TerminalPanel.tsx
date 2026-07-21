import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";

export interface ResourceTypeRef {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
}

export interface ShellTarget {
  kind: "pod" | "node" | "logs" | "wlogs";
  context: string;
  namespace?: string;
  name: string;
  /// wlogs: the workload resource whose pods to aggregate
  resource?: ResourceTypeRef;
  /// pod shells and logs: which container to attach to
  container?: string;
  /// logs: initial options (also settable from the log toolbar)
  logPrevious?: boolean;
  logSince?: number; // seconds; 0/undef = from tail
  logTimestamps?: boolean;
  /// pod shells: override shell command ("bash || sh" by default)
  command?: string;
  /// node shells: helper-pod customization
  podName?: string;
  image?: string;
  shellNamespace?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

const TERM_THEMES = {
  dark: {
    background: "#0b0e13",
    foreground: "#dbe2ea",
    cursor: "#aeb6c6",
    selectionBackground: "#3a4354",
  },
  light: {
    background: "#ffffff",
    foreground: "#2d3748",
    cursor: "#4a5568",
    selectionBackground: "#cbd5e0",
  },
};

/// One live shell session bound to one xterm instance. The surrounding
/// tab bar lives in App; this component only owns the terminal and the
/// exec session lifecycle (cleanup stops the session and, for node
/// shells, reaps the helper pod).
export default function TerminalPanel(props: {
  target: ShellTarget;
  theme: "dark" | "light";
  active: boolean;
  onExit: () => void;
  onLeave: () => void;
  onMinimize: () => void;
  onFocusChange: (focused: boolean) => void;
  onCycleTab: (delta: number) => void;
  onCloseTab: () => void;
  api?: (a: { focus: () => void }) => void;
}) {
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let sessionId: number | null = null;
  const isLogs = props.target.kind === "logs" || props.target.kind === "wlogs";
  // Buffer the streamed log text so it can be downloaded.
  let logBuf = "";
  const [logPrev, setLogPrev] = createSignal(!!props.target.logPrevious);
  const [logTs, setLogTs] = createSignal(!!props.target.logTimestamps);
  const [logSince, setLogSince] = createSignal(props.target.logSince ?? 0);
  const [findQ, setFindQ] = createSignal("");

  const onWinResize = () => props.active && fit?.fit();

  createEffect(() => {
    if (term) term.options.theme = TERM_THEMES[props.theme];
  });

  createEffect(() => {
    if (props.active) {
      setTimeout(() => {
        fit?.fit();
        term?.focus();
      });
    }
  });

  onMount(async () => {
    term = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: TERM_THEMES[props.theme],
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    if (isLogs) {
      search = new SearchAddon();
      term.loadAddon(search);
    }
    term.open(host);
    fit.fit();
    term.focus();
    window.addEventListener("resize", onWinResize);
    // Esc means different things inside and outside the terminal, so
    // the app has to know where focus actually is.
    term.textarea?.addEventListener("focus", () => props.onFocusChange(true));
    term.textarea?.addEventListener("blur", () => props.onFocusChange(false));
    props.api?.({ focus: () => term?.focus() });

    // xterm swallows every key, so carve out ways back to the app.
    // Esc leaves the panel — programs that need a real ESC still get
    // one from Ctrl+[, which every terminal treats as ESC, so nothing
    // is lost and the key means the same thing as everywhere else.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const appMod = IS_MAC ? ev.metaKey : ev.ctrlKey && ev.shiftKey;
      if (appMod && (ev.key === "t" || ev.key === "T")) {
        ev.preventDefault();
        props.onMinimize();
        return false;
      }
      // ⌘W (and ⇧⌘W) close this session. Ctrl+D is left alone: it is
      // the shell's own EOF, which ends the session anyway.
      if (appMod && ev.code === "KeyW") {
        ev.preventDefault();
        props.onCloseTab();
        return false;
      }
      // Plain Tab belongs to the shell (completion); Shift+Tab walks
      // the session tabs, matching the cluster tabs outside.
      if (ev.key === "Tab" && ev.shiftKey) {
        ev.preventDefault();
        props.onCycleTab(ev.ctrlKey ? -1 : 1);
        return false;
      }
      if (
        ev.key === "Escape" ||
        (ev.metaKey && ev.key === "ArrowUp") ||
        (ev.ctrlKey && ev.key === "]")
      ) {
        ev.preventDefault();
        props.onLeave();
        return false;
      }
      return true;
    });

    const t = props.target;
    if (t.kind === "node") {
      term.write(
        `\x1b[90mstarting privileged helper pod on ${t.name}… (up to 30s)\x1b[0m\r\n`,
      );
    }
    const chan = new Channel<string>();
    chan.onmessage = (d) => {
      if (d === "\u0000exit") {
        props.onExit();
        return;
      }
      if (isLogs) logBuf += d.replace(/\r\n/g, "\n");
      term?.write(d);
    };
    try {
      sessionId =
        t.kind === "pod"
          ? await invoke<number>("exec_start", {
              context: t.context,
              namespace: t.namespace,
              pod: t.name,
              container: t.container ?? null,
              command: t.command ?? null,
              channel: chan,
            })
          : t.kind === "logs"
            ? await invoke<number>("log_start", {
                context: t.context,
                namespace: t.namespace,
                pod: t.name,
                container: t.container ?? null,
                tail: 500,
                previous: logPrev(),
                sinceSeconds: logSince() > 0 ? logSince() : null,
                timestamps: logTs(),
                follow: true,
                channel: chan,
              })
            : t.kind === "wlogs"
              ? await invoke<number>("logs_selector_start", {
                  context: t.context,
                  resource: t.resource,
                  namespace: t.namespace,
                  name: t.name,
                  channel: chan,
                })
              : await invoke<number>("node_shell_start", {
                context: t.context,
                node: t.name,
                name: t.podName ?? null,
                image: t.image ?? null,
                shellNamespace: t.shellNamespace ?? null,
                cpuLimit: t.cpuLimit ?? null,
                memoryLimit: t.memoryLimit ?? null,
                channel: chan,
              });
      if (t.kind === "logs" || t.kind === "wlogs") return; // read-only
      void invoke("exec_resize", {
        id: sessionId,
        cols: term.cols,
        rows: term.rows,
      });
      term.onData(
        (d) =>
          sessionId != null &&
          void invoke("exec_stdin", { id: sessionId, data: d }),
      );
      term.onResize(
        ({ cols, rows }) =>
          sessionId != null &&
          void invoke("exec_resize", { id: sessionId, cols, rows }),
      );
    } catch (e) {
      term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
      props.onExit();
    }
  });

  onCleanup(() => {
    window.removeEventListener("resize", onWinResize);
    if (sessionId != null) void invoke("exec_stop", { id: sessionId });
    term?.dispose();
  });

  // Re-open a pod-log stream with the current toolbar options.
  async function reloadLogs() {
    if (props.target.kind !== "logs" || !term) return;
    if (sessionId != null) {
      void invoke("exec_stop", { id: sessionId });
      sessionId = null;
    }
    term.clear();
    logBuf = "";
    const chan = new Channel<string>();
    chan.onmessage = (d) => {
      if (d === "\u0000exit") return;
      logBuf += d.replace(/\r\n/g, "\n");
      term?.write(d);
    };
    try {
      sessionId = await invoke<number>("log_start", {
        context: props.target.context,
        namespace: props.target.namespace,
        pod: props.target.name,
        container: props.target.container ?? null,
        tail: 500,
        previous: logPrev(),
        sinceSeconds: logSince() > 0 ? logSince() : null,
        timestamps: logTs(),
        follow: true,
        channel: chan,
      });
    } catch (e) {
      term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
    }
  }

  const doFind = (back = false) => {
    const q = findQ();
    if (!q || !search) return;
    if (back) search.findPrevious(q);
    else search.findNext(q);
  };

  function downloadLogs() {
    const blob = new Blob([logBuf], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${props.target.name}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div
      class="term-wrap"
      style={{ display: props.active ? "flex" : "none" }}
    >
      <Show when={isLogs}>
        <div class="log-bar">
          <input
            class="search log-find"
            placeholder="find in logs…"
            value={findQ()}
            onInput={(e) => {
              setFindQ(e.currentTarget.value);
              search?.findNext(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") doFind(e.shiftKey);
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
          <button class="btn sm" title="next match (↵)" onClick={() => doFind()}>
            ↓
          </button>
          <button class="btn sm" title="previous match (⇧↵)" onClick={() => doFind(true)}>
            ↑
          </button>
          <Show when={props.target.kind === "logs"}>
            <span class="log-sep" />
            <button
              class="btn sm"
              classList={{ primary: logPrev() }}
              title="show the previous (crashed) container's logs"
              onClick={() => {
                setLogPrev(!logPrev());
                void reloadLogs();
              }}
            >
              previous
            </button>
            <button
              class="btn sm"
              classList={{ primary: logTs() }}
              title="prefix each line with a timestamp"
              onClick={() => {
                setLogTs(!logTs());
                void reloadLogs();
              }}
            >
              timestamps
            </button>
            <select
              class="log-since"
              title="only logs newer than…"
              value={String(logSince())}
              onChange={(e) => {
                setLogSince(Number(e.currentTarget.value));
                void reloadLogs();
              }}
            >
              <option value="0">tail 500</option>
              <option value="300">last 5m</option>
              <option value="900">last 15m</option>
              <option value="3600">last 1h</option>
              <option value="86400">last 24h</option>
            </select>
          </Show>
          <span class="log-sep" />
          <button class="btn sm" title="download the buffered logs" onClick={downloadLogs}>
            download
          </button>
        </div>
      </Show>
      <div class="term-host" ref={host} />
    </div>
  );
}
