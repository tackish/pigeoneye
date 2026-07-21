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
over a watch, and revisiting a view paints instantly from cache.

## Platform support
| Platform | Status |
|---|---|
| macOS (Apple Silicon / Intel) | ✅ Supported |
| Linux (x86_64) | ✅ Supported |
| Windows | ❌ Not supported |

## Install

**macOS — Homebrew**

```sh
brew tap tackish/pigeoneye https://github.com/tackish/pigeoneye
brew install --cask pigeoneye
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
  annotations, image, nodeName, IP, anything. Multiple words are ANDed:
  `nginx 10.210` finds nginx pods on matching addresses.
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
| Pod | **shell**, **logs** (follow), **port-forward**, delete, **force delete** (grace 0) |
| Deployment / StatefulSet | **logs** (all pods, combined), **scale**, **rollout restart**, delete |
| ReplicaSet / Job / Service | logs (all pods, combined), delete — ReplicaSet also scales |
| ReplicaSet | scale, delete |
| DaemonSet | rollout restart, delete |
| everything else | delete |

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
(arrows and Enter), and the tab is labelled `pod:container`. Pod shells exec into the pod (bash, falling back to sh). **Node shells**
launch a temporary privileged helper pod on that node (default
`busybox:1.36` in `kube-system`) and `nsenter` into the host — the helper pod
is deleted automatically when its tab closes. The helper **image, namespace,
resource limits and the pod shell command are configurable in ⚙ settings**,
so a hardened in-house shell image works too.

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

Pods also show live metric columns (CPU, %CPU/R, %CPU/L, MEM,
%MEM/R, %MEM/L) when metrics-server is installed, and every column header
sorts on click.

## Roadmap

Live watch updates (informer) → following log tails across restarts →
Helm releases.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal and any
noncommercial use. **Commercial use is not permitted.**
