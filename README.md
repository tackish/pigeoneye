<p align="center">
  <img src="src/assets/svg/logo-horizontal.svg" width="360" alt="PigeonEye — Observe. Navigate. Control." />
</p>

<p align="center"><b>A bird's-eye view of your clusters. Faster than anything.</b></p>

<p align="center">
  <img src="src/assets/svg/pigeon-search.svg" width="150" alt="" />
</p>

<p align="center">English | <a href="README.ko.md">한국어</a></p>

PigeonEye is a fast, native Kubernetes GUI. Every resource type your cluster
serves — including every CRD — shows up automatically, with the same columns
`kubectl get` prints.

## Why it's fast

Measured on a production cluster with **23,770 pods and 171,267 events**:

| | PigeonEye | Full-object list (what informer clients sync on connect) |
|---|---|---|
| First pod screen | **~0.35s / 350 KB** | 60s+ and 136 MB, still incomplete |
| Discovery on connect | **0.18s**, one request | one round-trip per API group |

The table renders only the rows on screen (virtual scroll), so filtering a
24k-row list stays at **~0.5ms per keystroke**. Open lists then stay **live**
over a watch, and revisiting a view **resumes the watch from cache** — no
re-list — so only what changed since arrives.

**Where the speed comes from:** server-side printer columns (the Table API,
one request per view — no full-object sync), streaming pagination, virtual
scrolling, a lazily-built full-text index, watch-based incremental updates
coalesced into batches, and a view cache that resumes the watch on return.

## Highlights

- **Every resource, zero config** — kinds come from the Discovery API, so
  every CRD shows up automatically with the columns `kubectl get` prints.
- **Columns your way** — hide, drag-reorder, and add **custom columns from
  any field or label** (`kubectl -o custom-columns`, but click instead of
  type). **Pin** frequently-used kinds into your own **groups**.
- **Search that finds things** — full-text over *every* field, plus regex,
  `!`negation, per-column value filters, and numeric comparisons (`> 500`).
- **Search every open cluster at once** — `: pod api-server` asks all of
  them and says which cluster each answer came from; picking one switches
  tab, kind and namespace and lands the cursor on the row. Costs nothing
  until you ask, and the clusters you have browsed answer from memory.
- **A real log viewer** — follow, previous (crashed) container, since
  windows, timestamps, in-view search, copy/download, and combined
  workload logs.
- **Shells & debugging** — pod exec, a transparent privileged **node
  shell**, and **ephemeral debug containers** that mirror the pod's
  security context (pass restricted PodSecurity / Kyverno).
- **Safe edits & operating** — YAML **server-side apply** with dry-run,
  create-from-template, scale, rollout restart / history / undo, drain,
  CronJob trigger, secret reveal, **port-forward** manager, live **`top`**
  metrics, and **`auth can-i`**.
- **Logins that can ask you things** — an expired token re-logs in from a
  terminal inside the app (AWS SSO, gcloud, Teleport, Azure, OIDC), so a
  CLI that wants an OTP or a passphrase has somewhere to ask. A kubeconfig
  `exec` block holds one command and has no "run this first" hook, so each
  context can also carry a **pre-connect command** of its own — `tsh
  login`, a bastion tunnel, a VPN — run before connecting and kept on your
  machine rather than in a shared kubeconfig.
- **Keyboard-first**, color-coded multi-cluster tabs, light/dark, and
  **in-app updates** — the top bar flags a new release and upgrades in
  place, no `brew` needed.

## vs. k9s & Lens

|  | PigeonEye | k9s | Lens/OpenLens |
|---|---|---|---|
| Native GUI | ✅ | terminal | Electron |
| Cold-start on a 24k-pod cluster | **~0.35s first screen** | fast | slow (full sync) |
| All CRDs / aggregated APIs, no config | ✅ | ✅ | ✅ |
| Regex / negation / numeric / per-column filters | ✅ | regex/`!` | basic |
| Logs: previous · since · search · download | ✅ | ✅ | ✅ (Lens only) |
| Combined workload/Service logs | ✅ | ✅ | partial |
| Ephemeral **debug** containers (policy-safe) | ✅ | — | — |
| **Node shell** (nsenter) | ✅ | opt-in | ✅ |
| Secret decode / reveal | ✅ | ✅ | ✅ |
| Server **dry-run** before apply | ✅ | — | — |
| Create from templates | ✅ | blank YAML | ✅ |
| Rollout history / undo | ✅ | ✅ | ✅ |
| CronJob trigger / suspend | ✅ | ✅ | — |
| Node & pod **metrics columns** (metrics-server) | ✅ | ✅ | needs Prometheus |
| `auth can-i` / permissions | ✅ | reverse-lookup | RBAC views |
| Search by name across every open cluster | ✅ | — | — |
| Auth re-login, including CLIs that prompt (OTP) | ✅ | — | — |
| Per-context pre-connect command (tunnel / `tsh login`) | ✅ | — | — |
| Time-series metric charts | — | — | ✅ (Prometheus) |
| Helm / extensions / xray tree / linters | — | xray/popeye/plugins | Helm/extensions |

Metric graphs, Helm, an owner **xray tree**, and cluster linters are the
main things PigeonEye doesn't (yet) do; navigation between owners/children
is one click via related-object jumps.

## Platform support
| Platform | Status |
|---|---|
| macOS (Apple Silicon / Intel) | ✅ Supported |
| Linux (x86_64) | ✅ Supported |
| Windows | ❌ Not supported |

## Install

**macOS — Homebrew**

```sh
brew tap tackish/pigeoneye
brew trust tackish/pigeoneye   # third-party taps need a one-time trust
brew install --cask peye
```

Then launch it from anywhere — Spotlight, or just type `peye` in a terminal:

```sh
peye
```

**Linux** — download the `.deb` / `.rpm` / `.AppImage` from
[Releases](https://github.com/tackish/pigeoneye/releases).

**Build from source** (Rust stable + Node 20+):

```sh
npm install
npm run tauri build   # installers in src-tauri/target/release/bundle/
npm run tauri dev     # or run directly
```

## Getting started

1. **Launch.** PigeonEye reads your default kubeconfig chain (`$KUBECONFIG`,
   falling back to `~/.kube/config`). No other setup.
2. **Connect a cluster** with the **“+ add context”** dropdown in the top bar.
   Each cluster opens as a **tab** — open as many as you want; requests to
   different clusters run in parallel. Tabs and the last active cluster are
   restored on next launch.
3. **More kubeconfig files?** Open **⚙ settings** and add file paths
   (e.g. `~/.kube/staging-config`). All files are merged into the context
   list, and each context remembers which file it came from.
4. **Cluster needs something first?** Some clusters are only reachable
   after a login or a tunnel that the kubeconfig cannot express. Hit **⋯**
   next to a context in either picker and give it a command — it runs in a
   terminal before the connection, so anything it asks you, you can answer:

   ```
   tsh status >/dev/null 2>&1 || tsh login --proxy=teleport.example.com:443
   ```

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and any
noncommercial use. **Commercial use is not permitted.**
