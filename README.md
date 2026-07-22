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

- **Every resource, zero config.** Kinds come from the Discovery API, so
  **every CRD and aggregated API shows up automatically** with the exact
  columns `kubectl get` prints — nothing is hardcoded.
- **Search that actually finds things.** Full-text over *every* field
  (labels, annotations, env, image, IP…), plus **regex** and **`!`negation**
  tokens, **per-column value filters**, and **numeric comparisons**
  (`> 500` on cpu/mem/%) — high-cardinality columns fall back to sort.
- **A real log viewer.** Follow, **previous (prior container)** for
  crashes, **since** windows, timestamps, **in-view search**, **copy** and
  **download** — plus combined logs across all pods of a workload/Service.
- **Shells & debugging that fit your policies.** Pod exec (container picker),
  a **node shell** (privileged `nsenter` helper, fully transparent in
  settings), and **ephemeral debug containers** for distroless/crashed pods —
  the debug container mirrors the pod's security context so it passes
  restricted PodSecurity / Kyverno.
- **Safe edits.** In-app YAML editor → **server-side apply** with
  conflict handling, a **server dry-run** to validate before applying, and
  **create-from-template** (`+ New`) for common kinds incl. Argo Rollout.
- **Operate.** Scale, rollout **restart / history / undo**, cordon / drain,
  CronJob **trigger / suspend**, Job suspend, secret **decode & reveal**,
  **port-forward** manager, live **pod & node metrics** (`top`), and
  **`kubectl auth can-i`** ("my permissions").
- **Keyboard-first**, multi-cluster tabs, light/dark, and **one-click
  SSO/gcloud re-login** when a token expires.

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
| Auth auto-login (AWS SSO / gcloud) | ✅ | — | — |
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

## Browsing resources

- The sidebar pins the essentials — **Cluster** (Node, Namespace, Event, CRD),
  **Workloads**, **Network**, **Config**, **Storage**, **Access Control** —
  and lists your cluster's CRD groups under *Custom Resources* (groups under
  `*.k8s.io` live in *More*, alongside the remaining built-ins).
  Everything else is under *More*, and the filter box searches all of it.
- Tables show the **server-side printer columns** — the same READY / STATUS /
  RESTARTS / IP / NODE columns kubectl shows, including
  `additionalPrinterColumns` of CRDs. Node views add an **AZ** column.
  Status values are color-coded (`Running` green, `Pending` yellow,
  `CrashLoopBackOff` red). Wide-only columns are hidden by default — the
  **columns** button lets you pick per resource kind, and remembers it.
- The **search box matches any field of the object** — name, labels,
  annotations, image, nodeName, IP, anything. Multiple words are ANDed
  (`nginx 10.210`); a token with regex metacharacters is a **regex**, and
  **`!term`** excludes.
- **Per-column filters:** the funnel on any column header opens its distinct
  values (searchable, multi-select) — or, for numeric columns (cpu, mem, %,
  restarts), a **comparison** (`>`, `≥`, `<`, `≤`, `=`). Press `f` to filter
  the sorted column by keyboard. High-cardinality columns (IP, Node) fall
  back to sorting instead of an endless value list.
- **Create** with **`+ New`** (or `n`): a starter manifest for the kind with
  the fields you need to change flagged, and a namespace picker.
- The namespace selector narrows every namespaced view.
- Large clusters stream: the first page renders immediately and the rest
  arrives in the background, so a 15k-pod list is fully searchable without
  making you wait for it.
- Open lists stay **live** — a watch feeds row-level changes as they happen
  (green dot next to the item count), instead of re-fetching.

## Inspecting & editing

Click a row to open the detail panel (click anywhere outside to close):

- Summary: namespace, age, labels; annotations, live **status** and the
  object's **Events** (`kubectl describe`'s tail — warnings open by default)
  are one fold away.
- **Manifest** shows the *desired state* — server-managed fields
  (`status`, `uid`, `resourceVersion`, `managedFields`, last-applied) are
  stripped, so what you see is what you'd `kubectl apply`.
- Edit it in place (YAML highlighting, auto-indent) and hit **Apply**.
  Changes go through server-side apply after a confirmation dialog. If another
  manager owns a field you changed — an HPA's `replicas`, an operator's
  template — the conflict is shown and taking ownership is your call. An
  editor left open cannot overwrite a newer change without being told.

## Actions

The detail panel shows actions fitting the resource:
| Resource | Actions |
|---|---|
| Node | **shell**, **cordon / uncordon**, **drain**, delete, force delete |
| Pod | **shell**, **debug** (ephemeral container), **logs**, **port-forward**, delete, **force delete** (grace 0) |
| Deployment | **logs** (combined), **scale**, **rollout restart**, **history / undo**, delete |
| StatefulSet | logs (combined), scale, rollout restart, delete |
| Argo Rollout | logs (combined), **scale**, **restart** (`spec.restartAt`), delete |
| ReplicaSet | logs (combined), scale, delete |
| DaemonSet | logs (combined), rollout restart, delete |
| Job | logs (combined), **suspend / resume**, delete |
| CronJob | **trigger now**, **suspend / resume**, delete |
| Secret | **decode & reveal** values, edit, delete |
| everything else | edit, delete |

Every kind also gets **my permissions** (`kubectl auth can-i` for the common
verbs) in the header, and every editable kind a **dry-run** button that
validates the manifest server-side before you apply.

Actions follow what the API server advertises — delete and edit only appear
on resources whose verbs allow them, and Events are always read-only.
Related objects are one click away, in both directions. Forward: a pod links
to its node, owner, ServiceAccount and PVCs; a PVC to its volume; an Ingress
to its services; an HPA to its target; an Event to the object it describes.
Reverse: a ServiceAccount or Node lists the pods using it (an exact
server-side query), a ConfigMap/Secret/PVC the pods mounting it, a
StorageClass its PVCs and PVs, an IngressClass its ingresses, a Role its
bindings, and a CRD its instances.

Destructive actions always ask for confirmation. Drain follows kubectl rules:
cordon first, evict everything except DaemonSet and mirror pods, respecting
PodDisruptionBudgets.

**Shells and logs** open as tabs in a bottom terminal panel — run several at
once. On a pod with more than one container you pick which one to attach to
(arrows and Enter), and the tab is labelled `pod:container`. Pod shells exec
into the pod (bash, falling back to sh).

**Log viewer.** Logs stream live with a toolbar: **find** in the buffer,
**previous (prior container)** for the crashed instance before the last
restart (`kubectl logs --previous`), a **since** window (5m…24h),
**timestamps**, **copy** the whole buffer, and **download** it to a file
(200k-line scrollback). Workloads and Services stream **combined logs across
all their pods**, color-coded by pod.

**Debug containers.** For a distroless or crashed pod that has no shell,
**debug** attaches an ephemeral toolbox container (`kubectl debug`) and drops
you into it. It inherits the pod's security context (runAsNonRoot / user /
seccomp, drops all capabilities) so it's accepted under restricted
PodSecurity and Kyverno.

**Node shells** launch a temporary privileged helper pod on that node
(default `busybox:1.36` in `kube-system`) and `nsenter` into the host — the
helper pod is deleted automatically when its tab closes. Its **name, image,
namespace, resource limits and the pod shell command are configurable in
⚙ settings**, which also shows exactly what the node shell runs (its
permissions and the literal `nsenter` command), so a hardened in-house image
works too.

**Port-forward** lives in the pod detail panel: pick a port (container ports
are pre-filled) and PigeonEye opens a local listener, then opens your browser
right away. Active forwards are listed in a **Port forwards** section at the
top of the sidebar — click one to reopen it in the browser, ✕ to stop it, or
"stop all" to drop them at once.

## Keyboard

Fully keyboard-drivable:
| Key | Action |
|---|---|
| `:` | command palette — `pods`, `deploy`, any CRD kind, `ns <name>`, `ctx <name>` |
| `/` | search — rows in the table, or inside the open detail panel (Enter/Esc returns) |
| `n` | new resource from a template (creatable kinds) |
| `f` | filter the sorted column (values, or `>`/`<` for numbers) |
| `↑↓` / `j` `k` | move the cursor — in the sidebar it walks kinds, in the table it walks rows |
| `Enter` / `→` | from the sidebar: open that kind |
| `←` `→` | pan wide tables sideways (`Home`/`End` for the first/last column) |
| `Enter` | open the detail panel — on a **Namespace** row it scopes the app to that namespace and lists its pods |
| `Space` | mark the cursor row · `⌘A` marks all · `Esc` clears |
| `s` | shell into the cursor row (pods and nodes) |
| `⌘D` / `Ctrl+D` | delete the marked rows, or the cursor row — add `Shift` for force delete; both confirm first |
| `⌘R` / `Ctrl+R` | rollout restart of the cursor row |
| `c` / `Shift+D` | cordon / drain the cursor node |
| `l` | logs — pod logs, or aggregated pod logs on workloads (Deploy/STS/DS/RS/Job/Svc) |
| `e` / `y` | open the manifest (YAML) editor for the cursor row |
| `d` | delete, with the detail panel open |
| `Shift+A/N/S/R/T/C/M/I/O` | sort by Age · Name · Status · Ready · Restarts · CPU · MEM · IP · Node |
| `?` | shortcut help |
| `Esc` | leave a focused terminal — programs needing a real ESC get one from `Ctrl+[` |
| `⌘T` | jump into the terminal; press it again there to hide the dock (sessions keep running) |
| **in the detail panel** | |
| `↑` `↓` / `j` `k` | move between panel sections (labels, annotations, status, manifest) |
| `Enter` | open the focused section — toggle a fold, enter the YAML editor, press the focused button |
| `←` `→` | move along the action row (shell · logs · scale · delete · Apply / Reset) |
| `h` | back to the table |
| `Shift+J` / `Shift+K` | previous / next resource, panel follows |
| `a` / `t` / `v` | toggle annotations / status / events |
| `c` / `Shift+D` | cordon-uncordon / drain (nodes) |
| `r` / `n` | rollout restart / focus scale input |
| `p` | node ↔ its pods, and an Event → the object it describes |
| `Shift+F` / `Shift+X` | port-forward input / force delete |
| **app** | |
| `⌘B` / `⌘K` | collapse sidebar / focus kind filter |
| `⌘,` | settings (kubeconfig, shell) |
| `Tab` / `Shift+Tab` | next / previous cluster tab |
| `Ctrl+1-9` / `Alt+1-9` | jump to a cluster tab / terminal tab |
| `Shift+Tab` (in a shell) | next shell session |
| `⌘W` | close what's in front — focused shell, else the detail panel, else the cluster tab (the window never closes) |
| `Shift+⌘W` | close the current shell session (`Ctrl+D` also ends the shell itself) |
| `Esc` | step up the hierarchy: detail → table → sidebar → previous view |

When metrics-server is installed, **Pods show live CPU/MEM** (and % of
requests/limits) and **Nodes show live CPU/MEM** (and % of allocatable) as
columns — `kubectl top` inline. Every column header sorts on click.

## Roadmap

Time-series metric charts → an owner **xray** tree view → Helm releases.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and any
noncommercial use. **Commercial use is not permitted.**
