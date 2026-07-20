import { For, Show, createMemo, type JSX } from "solid-js";

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
    .replace(/^./, (c) => c.toUpperCase());
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
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
              <td title={fmt(c.message)}>
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

/// A list of same-shaped objects (container statuses, addresses…)
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
                  <span class="st-val">
                    {/^(.*Time|.*Timestamp)$/.test(k) && relAge(val)
                      ? `${relAge(val)} ago · ${fmt(val)}`
                      : fmt(val)}
                  </span>
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
                        <ObjectTable rows={val as Record<string, unknown>[]} />
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
