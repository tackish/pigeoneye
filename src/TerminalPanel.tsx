import { createEffect, onCleanup, onMount } from "solid-js";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
  /// pod shells: override shell command ("bash || sh" by default)
  command?: string;
  /// node shells: helper-pod customization
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
  let sessionId: number | null = null;

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

  return (
    <div
      class="term-host"
      style={{ display: props.active ? "block" : "none" }}
      ref={host}
    />
  );
}
