import { For, Show, createMemo, createSignal, type JSX } from "solid-js";

/// Render a resource's `status` the way an operator reads it — not as
/// a JSON tree. Conditions become a table, quantities a key/value
/// grid, lists of objects compact tables. Anything genuinely nested
/// falls back to an indented list, still without braces and brackets.

function relAge(ts: unknown): string {
  if (typeof ts !== "string") return "";
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

function label(k: string): string {
  // camelCase → "camel case", so keys read like prose
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\b(Ip|Id)\b/g, (w) => w.toUpperCase()); // "ip" alone reads "IP"
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

const isTimeKey = (k: string) => /^(.*Time|.*Timestamp|startedAt|finishedAt)$/.test(k);

/// A value shown in full — wrapped, never cut — with a copy button on hover.
/// The full text is what gets copied, not the relative age shown beside it.
function Val(props: { k: string; v: unknown }) {
  const [done, setDone] = createSignal(false);
  const text = () => fmt(props.v);
  const shown = () =>
    isTimeKey(props.k) && relAge(props.v) ? `${relAge(props.v)} ago · ${text()}` : text();
  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text());
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      /* clipboard refused: nothing to do */
    }
  };
  return (
    <span class="st-val">
      {shown()}
      <Show when={props.v !== null && props.v !== undefined && text() !== ""}>
        <button class="st-copy" title="copy" onClick={copy}>
          {done() ? "✓" : "copy"}
        </button>
      </Show>
    </span>
  );
}

/// True/False/Unknown → the same colours the tables use.
function condClass(status: unknown, type: string): string {
  const s = String(status);
  // "Ready: True" is good, but "MemoryPressure: True" is not
  const inverted = /Pressure|Unavailable|Failed|Deprecated/i.test(type);
  if (s === "Unknown") return "warn";
  if (s === "True") return inverted ? "bad" : "good";
  if (s === "False") return inverted ? "good" : "warn";
  return "";
}

function Conditions(props: { rows: Record<string, unknown>[] }) {
  return (
    <table class="st-table">
      <thead>
        <tr>
          <th>Condition</th>
          <th>Status</th>
          <th>Reason</th>
          <th>Age</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(c) => (
            <tr>
              <td>{fmt(c.type)}</td>
              <td class={condClass(c.status, String(c.type ?? ""))}>
                {fmt(c.status)}
              </td>
              <td class="st-wrap">
                {fmt(c.reason ?? "")}
                <Show when={c.message}>
                  <span class="st-msg"> — {fmt(c.message)}</span>
                </Show>
              </td>
              <td class="dim">
                {relAge(c.lastTransitionTime ?? c.lastUpdateTime ?? c.lastProbeTime)}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

/// The key that names an object in a list, if it has one.
const TITLE_KEYS = ["name", "type"];

/// A list of same-shaped objects (container statuses, addresses, IPs…).
/// A short list reads one card per object, every value whole and copyable —
/// a table in a panel this narrow cut image and container IDs to "ghcr.io/…".
/// A one-field list (host IPs) is a single line; a long one (a node's
/// images) stays a table, or the panel would be all cards.
function ObjectList(props: { rows: Record<string, unknown>[] }) {
  const keys = createMemo(() => {
    const seen: string[] = [];
    for (const r of props.rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    return seen;
  });
  const single = createMemo(() => {
    const k = keys();
    return k.length === 1 && props.rows.every((r) => isScalar(r[k[0]])) ? k[0] : null;
  });
  return (
    <Show
      when={single() === null}
      fallback={
        <div class="st-grid">
          <For each={props.rows}>
            {(r) => (
              <>
                <span class="st-key">{label(single()!)}</span>
                <Val k={single()!} v={r[single()!]} />
              </>
            )}
          </For>
        </div>
      }
    >
      <Show when={props.rows.length <= 12} fallback={<ObjectTable rows={props.rows} />}>
        <For each={props.rows}>
          {(r) => {
            const titleKey = TITLE_KEYS.find((k) => isScalar(r[k]) && r[k] !== "");
            const scalars = Object.entries(r).filter(([k, v]) => k !== titleKey && isScalar(v));
            const nested = Object.entries(r).filter(([, v]) => !isScalar(v));
            return (
              <div class="st-card">
                <Show when={titleKey}>
                  <div class="st-card-title">{fmt(r[titleKey!])}</div>
                </Show>
                <Show when={scalars.length}>
                  <div class="st-grid">
                    <For each={scalars}>
                      {([k, v]) => (
                        <>
                          <span class="st-key">{label(k)}</span>
                          <Val k={k} v={v} />
                        </>
                      )}
                    </For>
                  </div>
                </Show>
                <For each={nested}>
                  {([k, v]) => (
                    <details class="st-sub">
                      <summary>{label(k)}</summary>
                      <StatusView value={v} />
                    </details>
                  )}
                </For>
              </div>
            );
          }}
        </For>
      </Show>
    </Show>
  );
}

/// A long list of same-shaped objects, as a table.
function ObjectTable(props: { rows: Record<string, unknown>[] }) {
  const cols = createMemo(() => {
    const seen: string[] = [];
    for (const r of props.rows) {
      for (const k of Object.keys(r)) {
        if (!seen.includes(k) && isScalar(r[k])) seen.push(k);
      }
    }
    return seen.slice(0, 6);
  });
  const nested = createMemo(() =>
    props.rows.some((r) => Object.values(r).some((v) => !isScalar(v))),
  );
  return (
    <>
      <table class="st-table">
        <thead>
          <tr>
            <For each={cols()}>{(c) => <th>{label(c)}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(r) => (
              <tr>
                <For each={cols()}>
                  {(c) => (
                    <td title={fmt(r[c])}>
                      {/^(.*Time|.*Timestamp)$/.test(c)
                        ? relAge(r[c]) || fmt(r[c])
                        : fmt(r[c])}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={nested()}>
        <For each={props.rows}>
          {(r) => (
            <For each={Object.entries(r).filter(([, v]) => !isScalar(v))}>
              {([k, v]) => (
                <details class="st-sub">
                  <summary>
                    {fmt(r.name ?? r.type ?? "")} · {label(k)}
                  </summary>
                  <StatusView value={v} />
                </details>
              )}
            </For>
          )}
        </For>
      </Show>
    </>
  );
}

export default function StatusView(props: { value: unknown }): JSX.Element {
  const v = () => props.value;

  const scalars = createMemo(() =>
    isObj(v()) ? Object.entries(v()!).filter(([, x]) => isScalar(x)) : [],
  );
  const groups = createMemo(() =>
    isObj(v()) ? Object.entries(v()!).filter(([, x]) => !isScalar(x)) : [],
  );

  return (
    <Show
      when={isObj(v())}
      fallback={<div class="st-plain">{fmt(v())}</div>}
    >
      <div class="st">
        <Show when={scalars().length > 0}>
          <div class="st-grid">
            <For each={scalars()}>
              {([k, val]) => (
                <>
                  <span class="st-key">{label(k)}</span>
                  <Val k={k} v={val} />
                </>
              )}
            </For>
          </div>
        </Show>

        <For each={groups()}>
          {([k, val]) => (
            <div class="st-group">
              <div class="st-title">{label(k)}</div>
              <Show
                when={Array.isArray(val)}
                fallback={<StatusView value={val} />}
              >
                <Show
                  when={(val as unknown[]).length > 0}
                  fallback={<div class="st-plain dim">none</div>}
                >
                  <Show
                    when={(val as unknown[]).every(isObj)}
                    fallback={
                      <div class="st-plain">
                        {(val as unknown[]).map(fmt).join(", ")}
                      </div>
                    }
                  >
                    <Show
                      when={k === "conditions"}
                      fallback={
                        <ObjectList rows={val as Record<string, unknown>[]} />
                      }
                    >
                      <Conditions rows={val as Record<string, unknown>[]} />
                    </Show>
                  </Show>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
