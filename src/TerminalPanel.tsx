import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Channel, invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
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
  kind: "pod" | "node" | "logs" | "wlogs" | "debug";
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
  onResize?: (delta: number) => void;
  api?: (a: { focus: () => void }) => void;
}) {
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let findInputRef: HTMLInputElement | undefined;
  let logBarRef: HTMLDivElement | undefined;
  // Move focus between the log toolbar's controls with ←/→ (roving focus),
  // so the whole bar is reachable and clickable from the keyboard.
  function moveLogBar(e: KeyboardEvent, dir: 1 | -1) {
    const bar = logBarRef;
    if (!bar) return;
    const target = e.target as HTMLElement;
    // In the find box, ←/→ move the caret until it's at the edge, then
    // they step out of the input like any other control.
    if (target instanceof HTMLInputElement && target.type !== "checkbox") {
      const atEdge = dir === 1 ? target.selectionStart === target.value.length : target.selectionStart === 0;
      if (!atEdge || target.selectionStart !== target.selectionEnd) return;
    }
    const items = [...bar.querySelectorAll<HTMLElement>("input, button, select")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = Math.min(Math.max(i + dir, 0), items.length - 1);
    items[next]?.focus();
  }
  let sessionId: number | null = null;
  const isLogs = props.target.kind === "logs" || props.target.kind === "wlogs";
  // Buffer the streamed log text (for copy/download). Capped so a
  // long-lived followed log can't grow the buffer without bound, and
  // ANSI colour codes (the wlogs per-pod prefix) are stripped so the
  // saved file / clipboard is plain text.
  let logBuf = "";
  const LOG_BUF_MAX = 8_000_000; // ~8 MB retained
  const pushLog = (d: string) => {
    logBuf += d.replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;]*m/g, "");
    if (logBuf.length > LOG_BUF_MAX)
      logBuf = logBuf.slice(logBuf.length - LOG_BUF_MAX);
  };

  // Give plain pod logs a little colour: dim the leading timestamp and
  // klog file:line, tint the severity/level words. wlogs already carry a
  // per-pod colour from the backend, so only kind "logs" is colourised.
  const A = {
    dim: "\x1b[90m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    off: "\x1b[0m",
  };
  const levelColor = (lvl: string): string | null => {
    const l = lvl.toLowerCase();
    if (/^(err|error|fatal|panic|crit|emerg|alert)/.test(l)) return A.red;
    if (/^warn/.test(l)) return A.yellow;
    if (/^(info|notice)/.test(l)) return A.green;
    if (/^(debug|trace|verbose)/.test(l)) return A.dim;
    return null;
  };
  // Tint the timestamp and level wherever they appear — logfmt (level=info,
  // time="…"), JSON ("level":"info","ts":"…"), and bare uppercase words.
  const colorizeInline = (s: string): string =>
    s
      // logfmt: level=info · lvl=warn · severity=error
      .replace(/\b(level|lvl|severity)=("?)([A-Za-z]+)\2/gi, (m, k, q, v) => {
        const c = levelColor(v);
        return c ? `${k}=${q}${c}${v}${A.off}${q}` : m;
      })
      // JSON: "level":"info"
      .replace(
        /("(?:level|lvl|severity)"\s*:\s*")([A-Za-z]+)(")/gi,
        (m, pre, v, post) => {
          const c = levelColor(v);
          return c ? `${pre}${c}${v}${A.off}${post}` : m;
        },
      )
      // logfmt timestamps: time="…" · ts=…
      .replace(
        /\b(time|ts|timestamp)=("?)([^"\s]+)\2/gi,
        (_m, k, q, v) => `${k}=${q}${A.dim}${v}${A.off}${q}`,
      )
      // JSON timestamps: "ts":"…" · "time":"…"
      .replace(
        /("(?:ts|time|timestamp|@timestamp)"\s*:\s*")([^"]+)(")/gi,
        (_m, pre, v, post) => `${pre}${A.dim}${v}${A.off}${post}`,
      )
      // bare uppercase level words
      .replace(/\b(ERROR|FATAL|PANIC|FAIL(?:ED)?)\b/g, A.red + "$1" + A.off)
      .replace(/\b(WARN(?:ING)?|Warning)\b/g, A.yellow + "$1" + A.off)
      .replace(/\b(INFO|NOTICE)\b/g, A.green + "$1" + A.off)
      .replace(/\b(DEBUG|TRACE)\b/g, A.dim + "$1" + A.off);
  function colorizeLine(line: string): string {
    // klog: "I0723 04:27:34.014636   1 warnings.go:110] msg"
    let m = line.match(/^([IWEF])(\d{4} [\d:.]+)(\s+\d+\s+\S+?\])(.*)$/);
    if (m) {
      const sev = m[1] === "E" || m[1] === "F" ? A.red : m[1] === "W" ? A.yellow : A.cyan;
      return sev + m[1] + A.dim + m[2] + m[3] + A.off + colorizeInline(m[4]);
    }
    // bare leading RFC3339 timestamp (kubectl --timestamps)
    m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)(\s+)(.*)$/);
    if (m) return A.dim + m[1] + A.off + m[2] + colorizeInline(m[3]);
    return colorizeInline(line);
  }
  // Chunks can split a line, so buffer until a newline before colourising.
  let colorBuf = "";
  function writeLog(d: string) {
    if (isLogs) pushLog(d);
    if (props.target.kind !== "logs") {
      term?.write(d);
      return;
    }
    colorBuf += d;
    let out = "";
    let nl: number;
    while ((nl = colorBuf.indexOf("\n")) >= 0) {
      out += colorizeLine(colorBuf.slice(0, nl).replace(/\r$/, "")) + "\r\n";
      colorBuf = colorBuf.slice(nl + 1);
    }
    if (out) term?.write(out);
  }

  // Highlight every match (not just the current one) as you type.
  const SEARCH_OPTS = {
    incremental: true,
    decorations: {
      matchBackground: "#6b5300",
      activeMatchBackground: "#cc9a00",
      matchOverviewRuler: "#cc9a00",
      activeMatchColorOverviewRuler: "#ffcc33",
    },
  };
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
      // Deep scrollback for logs so search/scroll reaches far back.
      scrollback: isLogs ? 200000 : 2000,
      // The search addon's match-highlight decorations use a proposed API.
      allowProposedApi: true,
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
      // ⌘←/⌘→ (Ctrl+Shift+←/→ off-Mac) also walk the tabs: plain arrows
      // belong to the shell (history/cursor), so the app-mod carves out
      // an arrow-key path that doesn't collide with what you're typing.
      if (appMod && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
        ev.preventDefault();
        props.onCycleTab(ev.key === "ArrowRight" ? 1 : -1);
        return false;
      }
      // ⌘⇧↑/↓ resizes the dock (plain ⌘↑ still leaves the terminal below).
      if (appMod && ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
        ev.preventDefault();
        props.onResize?.(ev.key === "ArrowUp" ? 1 : -1);
        return false;
      }
      // Logs are read-only — there's no shell to type into — so the
      // navigation keys scroll the viewport (vim j/k/g/G too) and `/`
      // jumps to the find box, matching the rest of the app.
      if (isLogs && term && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const b = term;
        switch (ev.key) {
          case "ArrowDown":
          case "j":
            ev.preventDefault(); b.scrollLines(1); return false;
          case "ArrowUp":
          case "k":
            ev.preventDefault(); b.scrollLines(-1); return false;
          case "PageDown":
            ev.preventDefault(); b.scrollPages(1); return false;
          case "PageUp":
            ev.preventDefault(); b.scrollPages(-1); return false;
          case "End":
          case "G":
            ev.preventDefault(); b.scrollToBottom(); return false;
          case "Home":
          case "g":
            ev.preventDefault(); b.scrollToTop(); return false;
          case "/":
            ev.preventDefault(); findInputRef?.focus(); return false;
          // Tab enters the log toolbar; ←/→ then walk it, esc comes back.
          case "Tab":
            ev.preventDefault();
            (logBarRef?.querySelector("input, button, select") as HTMLElement)?.focus();
            return false;
        }
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
    if (t.kind === "debug") {
      term.write(
        `\x1b[90mattaching ephemeral debug container to ${t.name}… (pulling ${t.image ?? "busybox:1.36"}, up to 60s)\x1b[0m\r\n`,
      );
    }
    if (t.kind === "logs") term.write(logHeaderLine());
    const chan = new Channel<string>();
    chan.onmessage = (d) => {
      if (d === "\u0000exit") {
        props.onExit();
        return;
      }
      writeLog(d);
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
          : t.kind === "debug"
            ? await invoke<number>("debug_start", {
                context: t.context,
                namespace: t.namespace,
                pod: t.name,
                image: t.image ?? null,
                target: t.container ?? null,
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
      // Fire-and-forget stdin/resize: once the shell exits the backend
      // channel is gone, so a late keystroke/resize would reject with
      // "channel closed" and hit the global unhandled-rejection overlay.
      // Swallow it — the session is already dead.
      void invoke("exec_resize", {
        id: sessionId,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
      term.onData(
        (d) =>
          sessionId != null &&
          void invoke("exec_stdin", { id: sessionId, data: d }).catch(
            () => {},
          ),
      );
      term.onResize(
        ({ cols, rows }) =>
          sessionId != null &&
          void invoke("exec_resize", { id: sessionId, cols, rows }).catch(
            () => {},
          ),
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

  // A banner at the top of the stream so it's unmistakable which
  // instance you're reading — the running container or its dead one.
  const logHeaderLine = () => {
    const c = props.target.container
      ? `container "${props.target.container}"`
      : "the container";
    return logPrev()
      ? `\x1b[30;43m PREVIOUS \x1b[0m \x1b[33mdead instance of ${c} — the crash right before the last restart (only the most recent one)\x1b[0m\r\n`
      : `\x1b[30;42m CURRENT \x1b[0m \x1b[90mrunning instance of ${c}\x1b[0m\r\n`;
  };

  // Re-open a pod-log stream with the current toolbar options.
  async function reloadLogs() {
    if (props.target.kind !== "logs" || !term) return;
    if (sessionId != null) {
      void invoke("exec_stop", { id: sessionId });
      sessionId = null;
    }
    term.clear();
    logBuf = "";
    colorBuf = "";
    term.write(logHeaderLine());
    const chan = new Channel<string>();
    chan.onmessage = (d) => {
      if (d === "\u0000exit") return;
      writeLog(d);
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
    if (back) search.findPrevious(q, SEARCH_OPTS);
    else search.findNext(q, SEARCH_OPTS);
  };

  const [saved, setSaved] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  async function downloadLogs() {
    // The webview ignores <a download>; save through the native dialog.
    const path = await save({
      defaultPath: `${props.target.name}.log`,
      filters: [{ name: "log", extensions: ["log", "txt"] }],
    });
    if (!path) return;
    try {
      await invoke("write_file", { path, content: logBuf });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      term?.write(`\r\n\x1b[31mcould not save: ${String(e)}\x1b[0m\r\n`);
    }
  }
  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logBuf);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div
      class="term-wrap"
      style={{ display: props.active ? "flex" : "none" }}
    >
      <Show when={isLogs}>
        <div
          class="log-bar"
          ref={(el) => (logBarRef = el)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") moveLogBar(e, 1);
            else if (e.key === "ArrowLeft") moveLogBar(e, -1);
            else if (e.key === "Escape") term?.focus();
          }}
        >
          <input
            class="search log-find"
            placeholder="find in logs…  ( / )"
            ref={(el) => (findInputRef = el)}
            value={findQ()}
            onInput={(e) => {
              setFindQ(e.currentTarget.value);
              search?.findNext(e.currentTarget.value, SEARCH_OPTS);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") doFind(e.shiftKey);
              // Esc hands focus back to the log so the arrows scroll again.
              if (e.key === "Escape") {
                e.currentTarget.blur();
                term?.focus();
              }
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
            <span
              class="log-seg"
              title="current = the running container. previous = its last terminated instance only (kubectl logs --previous), i.e. the crash right before the last restart — not older restarts."
            >
              <button
                classList={{ active: !logPrev() }}
                onClick={() => {
                  if (logPrev()) {
                    setLogPrev(false);
                    void reloadLogs();
                  }
                }}
              >
                current
              </button>
              <button
                classList={{ active: logPrev() }}
                onClick={() => {
                  if (!logPrev()) {
                    setLogPrev(true);
                    void reloadLogs();
                  }
                }}
              >
                previous (dead)
              </button>
            </span>
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
          <button class="btn sm" title="copy the whole buffer to the clipboard" onClick={copyLogs}>
            {copied() ? "copied ✓" : "copy"}
          </button>
          <button class="btn sm" title="save the whole buffer to a file" onClick={downloadLogs}>
            {saved() ? "saved ✓" : "download"}
          </button>
        </div>
      </Show>
      <div class="term-host" ref={host} />
    </div>
  );
}
