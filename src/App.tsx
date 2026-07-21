import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import YamlEditor from "./YamlEditor";
import TerminalPanel, { type ShellTarget } from "./TerminalPanel";
import StatusView from "./StatusView";
import logoUrl from "./assets/svg/app-icon.svg";
import lookUrl from "./assets/svg/pigeon-search.svg";
import puzzledUrl from "./assets/svg/pigeon-thinking.svg";
import flyingUrl from "./assets/svg/pigeon-flying.svg";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  is_current: boolean;
  source: string;
}

interface ResourceType {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  deletable: boolean;
  editable: boolean;
}

interface RefLink {
  kind: string;
  name: string;
  namespace: string | null;
}

interface ColumnDef {
  name: string;
  priority: number;
}

interface TableRow {
  name: string;
  namespace: string | null;
  cells: (string | number | null)[];
  labels: Record<string, string>;
  owner_kind?: string | null;
}

interface ResourceTable {
  columns: ColumnDef[];
  rows: TableRow[];
  truncated: boolean;
  resource_version: string | null;
  include: string;
}

interface ResourceDetail {
  name: string;
  namespace: string | null;
  created: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  status: unknown;
  unschedulable: boolean | null;
  node_name: string | null;
  ports: number[];
  containers: string[];
  resource_version: string | null;
  involved: RefLink | null;
  links: RefLink[];
  has_pod_selector: boolean;
  pod_selector: string | null;
  secret_data?: [string, string][];
  replicas: number | null;
  ready_replicas: number | null;
  yaml: string;
}

interface TabState {
  types: ResourceType[];
  namespaces: string[];
  namespace: string;
  selectedKey: string | null;
  source: string;
}

interface DisplayRow {
  row: TableRow;
  cells: string[];
  /// lowercase text of everything visible, precomputed for filtering
  hay: string;
}

interface PodStat {
  key: string;
  cpu: number;
  mem: number;
  cpu_r: number;
  cpu_l: number;
  mem_r: number;
  mem_l: number;
}

interface NodeStat {
  name: string;
  cpu: number;
  mem: number;
  cpu_pct: number;
  mem_pct: number;
}

interface EventInfo {
  type_: string;
  reason: string;
  message: string;
  count: number;
  last: string | null;
  source: string;
}

interface PfInfo {
  id: number;
  context: string;
  namespace: string;
  pod: string;
  remote: number;
  local: number;
}

interface ShellCfg {
  podCommand?: string;
  nodeName?: string;
  nodeImage?: string;
  nodeNamespace?: string;
  nodeCpu?: string;
  nodeMem?: string;
}

interface ConfirmState {
  title: string;
  body: string;
  label: string;
  danger: boolean;
  run: () => void;
}

/// Curated operator's view: which discovered types get pinned into which
/// category. Purely a UI arrangement — the list itself still comes from
/// API discovery, so a type missing from the cluster simply doesn't render.
const CATEGORIES: [string, [string, string][]][] = [
  [
    "Cluster",
    [
      ["", "Node"],
      ["", "Namespace"],
      ["", "Event"],
      ["apiextensions.k8s.io", "CustomResourceDefinition"],
    ],
  ],
  [
    "Workloads",
    [
      ["", "Pod"],
      // Argo Rollouts is a progressive-delivery replacement for
      // Deployment; where it's installed teams often reach for it more
      // than Deployment, so pin it right up top. Only renders if the
      // argoproj.io CRD is present in the cluster.
      ["argoproj.io", "Rollout"],
      ["apps", "Deployment"],
      ["apps", "ReplicaSet"],
      ["apps", "StatefulSet"],
      ["apps", "DaemonSet"],
      ["batch", "Job"],
      ["batch", "CronJob"],
    ],
  ],
  [
    "Network",
    [
      ["", "Service"],
      ["networking.k8s.io", "Ingress"],
      ["networking.k8s.io", "IngressClass"],
      ["discovery.k8s.io", "EndpointSlice"],
      ["networking.k8s.io", "NetworkPolicy"],
    ],
  ],
  [
    "Config",
    [
      ["", "ConfigMap"],
      ["", "Secret"],
      ["", "ResourceQuota"],
      ["", "LimitRange"],
      ["autoscaling", "HorizontalPodAutoscaler"],
      ["policy", "PodDisruptionBudget"],
    ],
  ],
  [
    "Storage",
    [
      ["", "PersistentVolumeClaim"],
      ["", "PersistentVolume"],
      ["storage.k8s.io", "StorageClass"],
      ["storage.k8s.io", "VolumeAttachment"],
      ["storage.k8s.io", "CSIDriver"],
      ["storage.k8s.io", "CSINode"],
    ],
  ],
  [
    "Access Control",
    [
      ["", "ServiceAccount"],
      ["rbac.authorization.k8s.io", "Role"],
      ["rbac.authorization.k8s.io", "RoleBinding"],
      ["rbac.authorization.k8s.io", "ClusterRole"],
      ["rbac.authorization.k8s.io", "ClusterRoleBinding"],
    ],
  ],
];

/// Starter manifests for the "New" flow, keyed by `${group}/${kind}`.
/// Deliberately minimal — just enough to be valid — with `# 👈` comments
/// marking the handful of fields you actually need to change. Namespace
/// is left out on purpose: the New dialog's picker supplies it, so
/// there's nothing to keep in sync here. Only kinds people routinely
/// hand-create are covered; everything else simply has no New button.
const NEW_TEMPLATES: Record<string, string> = {
  "/Pod": `apiVersion: v1
kind: Pod
metadata:
  name: my-pod            # 👈 name
  labels:
    app: my-pod
spec:
  containers:
    - name: app
      image: nginx:latest # 👈 image
      ports:
        - containerPort: 80   # 👈 port
`,
  "apps/Deployment": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app            # 👈 name
  labels:
    app: my-app
spec:
  replicas: 1             # 👈 replicas
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:latest   # 👈 image
          ports:
            - containerPort: 80 # 👈 port
`,
  "apps/StatefulSet": `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-set            # 👈 name
spec:
  serviceName: my-set     # 👈 headless service name
  replicas: 1             # 👈 replicas
  selector:
    matchLabels:
      app: my-set
  template:
    metadata:
      labels:
        app: my-set
    spec:
      containers:
        - name: app
          image: nginx:latest   # 👈 image
          ports:
            - containerPort: 80
          volumeMounts:
            - name: data
              mountPath: /data    # 👈 where the volume mounts
  # A PVC is created automatically per replica from this template — you
  # don't pre-create one. Drop this whole block for a stateless set.
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        # storageClassName: gp3    # 👈 uncomment to pin a StorageClass
        resources:
          requests:
            storage: 1Gi          # 👈 size per replica
`,
  "/Service": `apiVersion: v1
kind: Service
metadata:
  name: my-svc            # 👈 name
spec:
  type: ClusterIP         # 👈 ClusterIP | NodePort | LoadBalancer
  selector:
    app: my-app           # 👈 pods to target (match their labels)
  ports:
    - port: 80            # 👈 service port
      targetPort: 80      # 👈 container port
`,
  "networking.k8s.io/Ingress": `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress        # 👈 name
spec:
  rules:
    - host: example.com   # 👈 host
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-svc   # 👈 target service
                port:
                  number: 80   # 👈 service port
`,
  "/ConfigMap": `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config         # 👈 name
data:
  key: value              # 👈 your key/values
`,
  "/Secret": `apiVersion: v1
kind: Secret
metadata:
  name: my-secret         # 👈 name
type: Opaque
stringData:
  key: value              # 👈 plaintext key/values (encoded for you)
`,
  "batch/Job": `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job            # 👈 name
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36        # 👈 image
          command: ["sh", "-c", "echo hello"]  # 👈 command
`,
  "batch/CronJob": `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob        # 👈 name
spec:
  schedule: "*/5 * * * *"  # 👈 cron schedule
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: job
              image: busybox:1.36    # 👈 image
              command: ["sh", "-c", "date"]   # 👈 command
`,
  "/Namespace": `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace      # 👈 name
`,
  "/PersistentVolumeClaim": `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc            # 👈 name
spec:
  accessModes:
    - ReadWriteOnce       # 👈 access mode
  resources:
    requests:
      storage: 1Gi        # 👈 size
`,
  "autoscaling/HorizontalPodAutoscaler": `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-hpa            # 👈 name
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app          # 👈 target workload
  minReplicas: 1          # 👈 min
  maxReplicas: 10         # 👈 max
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80   # 👈 target CPU %
`,
  "argoproj.io/Rollout": `apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-rollout        # 👈 name
spec:
  replicas: 1             # 👈 replicas
  selector:
    matchLabels:
      app: my-rollout
  template:
    metadata:
      labels:
        app: my-rollout
    spec:
      containers:
        - name: app
          image: nginx:latest   # 👈 image
          ports:
            - containerPort: 80
  strategy:
    canary:                # 👈 rollout strategy (canary | blueGreen)
      steps:
        - setWeight: 20
        - pause: {}
`,
};

const BUILTIN_GROUPS = new Set(["", "apps", "batch", "autoscaling", "policy"]);

function isBuiltinGroup(group: string): boolean {
  return BUILTIN_GROUPS.has(group) || group.endsWith(".k8s.io");
}

const CELL_GOOD =
  /^(Running|Ready|True|Active|Available|Bound|Completed|Succeeded|Healthy|Established|Approved|Normal)$/;
const CELL_WARN =
  /^(Pending|ContainerCreating|PodInitializing|Terminating|Progressing|Released|Unknown|Warning|SchedulingDisabled|Ready,SchedulingDisabled|Init:.*)$/;
const CELL_BAD =
  /^(Error|Failed|CrashLoopBackOff|ImagePullBackOff|ErrImagePull|Evicted|NotReady|OOMKilled|BackOff|CreateContainerConfigError|Unschedulable|Lost|False)$/;

function cellClass(v: string | number | null): string {
  const s = String(v ?? "");
  if (CELL_BAD.test(s)) return "cell bad";
  if (CELL_WARN.test(s)) return "cell warn";
  if (CELL_GOOD.test(s)) return "cell good";
  const ready = s.match(/^(\d+)\/(\d+)$/);
  if (ready) return ready[1] === ready[2] ? "cell good" : "cell warn";
  return "cell";
}

function age(created: string | null): string {
  if (!created) return "-";
  const ms = Date.now() - new Date(created).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function zoneOf(labels: Record<string, string>): string {
  return (
    labels["topology.kubernetes.io/zone"] ??
    labels["failure-domain.beta.kubernetes.io/zone"] ??
    "-"
  );
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

const fmtCpu = (m: number) => String(m);
const fmtMem = (b: number) => String(Math.round(b / 1048576));
const pct = (used: number, base: number) =>
  base > 0 ? String(Math.round((used / base) * 100)) : "n/a";

/// Numeric sort key for a cell, or null when it's not number-like.
/// Understands plain numbers, x/y READY, k8s durations (2d12h) and
/// quantities (128Mi).
function sortVal(v: string): number | null {
  const s = v.trim();
  if (!s || s === "-" || s === "<none>" || s === "n/a") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  const ready = s.match(/^(\d+)\/(\d+)$/);
  if (ready) return +ready[1] + +ready[2] / 1e6;
  const dur = s.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (dur && (dur[1] || dur[2] || dur[3] || dur[4]))
    return (
      +(dur[1] ?? 0) * 86400 + +(dur[2] ?? 0) * 3600 + +(dur[3] ?? 0) * 60 + +(dur[4] ?? 0)
    );
  const qty = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|K|M|G|T)$/);
  if (qty) {
    const mul: Record<string, number> = {
      Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
      k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
    };
    return +qty[1] * mul[qty[2]];
  }
  return null;
}

/// Split a search query into plain substrings, regexes, and negations.
/// `!term` excludes; a token with regex metacharacters is a (case-
/// insensitive, since the haystack is lowercased) regex; else substring.
function parseQuery(raw: string): {
  poss: string[];
  res: RegExp[];
  negs: string[];
} {
  const poss: string[] = [];
  const negs: string[] = [];
  const res: RegExp[] = [];
  for (const t of raw.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t.startsWith("!") && t.length > 1) negs.push(t.slice(1));
    else if (/[.*+?^${}()|[\]\\]/.test(t)) {
      try {
        res.push(new RegExp(t));
      } catch {
        poss.push(t);
      }
    } else poss.push(t);
  }
  return { poss, res, negs };
}

function cmpCells(a: string, b: string): number {
  const ka = sortVal(a);
  const kb = sortVal(b);
  if (ka !== null && kb !== null) return ka - kb;
  if (ka !== null) return -1;
  if (kb !== null) return 1;
  return a.localeCompare(b);
}

const POD_STAT_COLS = ["CPU", "%CPU/R", "%CPU/L", "MEM", "%MEM/R", "%MEM/L"];
const NODE_STAT_COLS = ["CPU", "%CPU", "MEM", "%MEM"];

/// Resource aliases for the `:` command.
const KIND_ALIASES: Record<string, string> = {
  po: "/Pod", pod: "/Pod", pods: "/Pod",
  dp: "apps/Deployment", deploy: "apps/Deployment", deployment: "apps/Deployment", deployments: "apps/Deployment",
  rs: "apps/ReplicaSet", sts: "apps/StatefulSet", ds: "apps/DaemonSet",
  job: "batch/Job", jobs: "batch/Job", cj: "batch/CronJob", cronjob: "batch/CronJob",
  svc: "/Service", service: "/Service", services: "/Service",
  ing: "networking.k8s.io/Ingress", ingress: "networking.k8s.io/Ingress",
  netpol: "networking.k8s.io/NetworkPolicy",
  cm: "/ConfigMap", configmap: "/ConfigMap", sec: "/Secret", secret: "/Secret", secrets: "/Secret",
  no: "/Node", node: "/Node", nodes: "/Node",
  ns: "/Namespace", namespace: "/Namespace", namespaces: "/Namespace",
  ev: "/Event", event: "/Event", events: "/Event",
  pvc: "/PersistentVolumeClaim", pv: "/PersistentVolume",
  sc: "storage.k8s.io/StorageClass",
  sa: "/ServiceAccount",
  crd: "apiextensions.k8s.io/CustomResourceDefinition", crds: "apiextensions.k8s.io/CustomResourceDefinition",
  hpa: "autoscaling/HorizontalPodAutoscaler",
  pdb: "policy/PodDisruptionBudget",
};

const SESSION_KEY = "pigeoneye.session";
const KUBECONFIG_KEY = "pigeoneye.kubeconfigs";

function subtreeMatches(v: unknown, q: string): boolean {
  if (!q) return false;
  try {
    return JSON.stringify(v).toLowerCase().includes(q);
  } catch {
    return false;
  }
}

function App() {
  const [contexts, setContexts] = createSignal<ContextInfo[]>([]);
  const [kubeconfigs, setKubeconfigs] = createSignal<string[]>(
    JSON.parse(localStorage.getItem(KUBECONFIG_KEY) ?? "[]"),
  );
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [pickerQ, setPickerQ] = createSignal("");
  const [pickerIdx, setPickerIdx] = createSignal(0);
  const lastSession: string[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}").tabs ?? [];
    } catch {
      return [];
    }
  })();

  /// Startup list: previously-open contexts first, then the rest.
  const pickerList = createMemo(() => {
    const q = pickerQ().toLowerCase().trim();
    const rank = (c: ContextInfo) =>
      (lastSession.includes(c.name) ? 0 : 1) + (c.is_current ? -0.5 : 0);
    return contexts()
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  });
  // Keep the keyboard-selected context in view as the cursor moves.
  createEffect(() => {
    if (tabs().length) return;
    const i = pickerIdx();
    queueMicrotask(() =>
      document
        .querySelectorAll(".launcher-item")
        [i]?.scrollIntoView({ block: "nearest" }),
    );
  });
  const [newPath, setNewPath] = createSignal("");
  const [theme, setTheme] = createSignal<"dark" | "light">(
    (localStorage.getItem("pigeoneye.theme") as "dark" | "light") ?? "dark",
  );
  const [nsOpen, setNsOpen] = createSignal(false);
  const [nsQuery, setNsQuery] = createSignal("");
  const [tabs, setTabs] = createSignal<string[]>([]);
  const [active, setActive] = createSignal<string | null>(null);
  const [connecting, setConnecting] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [types, setTypes] = createSignal<ResourceType[]>([]);
  const [namespaces, setNamespaces] = createSignal<string[]>([]);
  const [namespace, setNamespace] = createSignal<string>("");
  const [selected, setSelected] = createSignal<ResourceType | null>(null);
  const [table, setTable] = createSignal<ResourceTable | null>(null);
  const [streaming, setStreaming] = createSignal(false);
  const [live, setLive] = createSignal(false);
  let listSeq = 0;
  let watchId: number | null = null;

  // Pending watch changes, keyed so repeated updates to one row
  // collapse. Flushed on a timer, not per event.
  const watchBuf = new Map<string, { del: boolean; row: TableRow }>();
  let watchFlushTimer: number | undefined;

  function scheduleWatchFlush(seq: number) {
    if (watchFlushTimer != null) return;
    watchFlushTimer = window.setTimeout(() => {
      watchFlushTimer = undefined;
      if (seq !== listSeq || !watchBuf.size) {
        watchBuf.clear();
        return;
      }
      const pending = new Map(watchBuf);
      watchBuf.clear();
      setTable((prev) => {
        if (!prev) return prev;
        // one index pass, then O(1) updates
        const idx = new Map<string, number>();
        for (let i = 0; i < prev.rows.length; i++) idx.set(rowKeyOf(prev.rows[i]), i);
        let rows = prev.rows;
        let copied = false;
        const ensure = () => {
          if (!copied) {
            rows = prev.rows.slice();
            copied = true;
          }
        };
        const dels: number[] = [];
        for (const [k, ch] of pending) {
          const i = idx.get(k);
          if (ch.del) {
            if (i !== undefined) dels.push(i);
          } else if (i !== undefined) {
            ensure();
            rows[i] = ch.row;
          } else {
            ensure();
            rows.push(ch.row);
          }
        }
        if (dels.length) {
          ensure();
          dels.sort((a, b) => b - a);
          for (const i of dels) rows.splice(i, 1);
        }
        return copied ? { ...prev, rows } : prev;
      });
    }, 700);
  }

  function stopWatch() {
    if (watchFlushTimer != null) {
      window.clearTimeout(watchFlushTimer);
      watchFlushTimer = undefined;
    }
    watchBuf.clear();
    if (watchId != null) void invoke("watch_stop", { id: watchId }).catch(() => {});
    watchId = null;
    setLive(false);
  }

  /// Keep the open list current by receiving only what changed. The
  /// events arrive in the same projection the list used, so a changed
  /// row is already printed with the server's columns.
  /// Returns true if the watch started (or was superseded by a newer
  /// navigation), false only if the server refused it — the caller uses
  /// that to decide whether cached rows still need a full revalidation.
  async function startWatch(
    ctx: string,
    rt: ResourceType,
    ns: string | null,
    fieldSelector: string | null,
    rv: string | null,
    include: string,
  ): Promise<boolean> {
    stopWatch();
    if (!rv) return false;
    const seq = listSeq;
    const chan = new Channel<{ type: string; rows?: TableRow[] }>();
    chan.onmessage = (ev) => {
      if (seq !== listSeq) return;
      if (ev.type === "RESYNC") {
        // the watch expired or the server closed it: re-list, which
        // starts a fresh watch from the new resourceVersion
        const cur = selected();
        if (cur === rt && active() === ctx) void refreshList();
        return;
      }
      const incoming = ev.rows ?? [];
      if (!incoming.length) return;
      for (const r of incoming) watchBuf.set(rowKeyOf(r), { del: ev.type === "DELETED", row: r });
      scheduleWatchFlush(seq);
    };
    try {
      const id = await invoke<number>("watch_start", {
        context: ctx,
        resource: rt,
        namespace: ns,
        fieldSelector,
        resourceVersion: rv,
        include,
        channel: chan,
      });
      if (seq !== listSeq) {
        void invoke("watch_stop", { id }).catch(() => {});
        return true; // superseded, not failed
      }
      watchId = id;
      setLive(true);
      return true;
    } catch {
      setLive(false); // watch permission missing: the list still works
      return false;
    }
  }
  // A server-side narrowing (e.g. pods of one node). Field selectors
  // are per-kind — "spec.nodeName" is a 400 on anything but pods — so
  // the owning kind travels with it.
  const [fieldSel, setFieldSel] = createSignal<{
    key: string;
    selector: string;
  } | null>(null);

  /// The selector, but only if it belongs to the kind on screen.
  const activeFieldSel = () => {
    const f = fieldSel();
    const s = selected();
    return f && s && f.key === typeKey(s) ? f.selector : null;
  };
  const [loading, setLoading] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [rowFilter, setRowFilter] = createSignal("");
  // Backend full-text hits, as row keys (namespace/name). Keys survive
  // the watch informer reordering the list; positional indices would not.
  const [matched, setMatched] = createSignal<Set<string> | null>(null);
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null);
  // 0 = Cancel, 1 = the action. Confirm dialogs open on the action so
  // Enter still means "yes", but ← makes backing out one keypress.
  const [dlgIdx, setDlgIdx] = createSignal(1);
  const [shells, setShells] = createSignal<{ k: number; target: ShellTarget }[]>([]);
  const [shellStatus, setShellStatus] = createSignal<Map<number, "running" | "exited">>(new Map());
  const [activeShell, setActiveShell] = createSignal<number | null>(null);
  const [termMin, setTermMin] = createSignal(false);
  const [termFocused, setTermFocused] = createSignal(false);
  const termApis = new Map<number, { focus: () => void }>();

  function focusTerminal() {
    const k = activeShell();
    if (k != null) termApis.get(k)?.focus();
  }

  function cycleShell(delta: number) {
    const list = shells();
    if (list.length < 2) return;
    const i = list.findIndex((s) => s.k === activeShell());
    const next = list[(i + delta + list.length) % list.length];
    setActiveShell(next.k);
    requestAnimationFrame(focusTerminal);
  }
  const [sidebarOpen, setSidebarOpen] = createSignal(
    localStorage.getItem("pigeoneye.sidebar") !== "closed",
  );

  function toggleSidebar() {
    const v = !sidebarOpen();
    setSidebarOpen(v);
    localStorage.setItem("pigeoneye.sidebar", v ? "open" : "closed");
  }
  let nextShellKey = 1;
  const [failed, setFailed] = createSignal<{ name: string; error: string }[]>([]);
  const failedTabs: { name: string; error: string }[] = [];
  const [authHint, setAuthHint] = createSignal<{
    context: string;
    kind: string;
    message: string;
    command: string | null;
    can_login: boolean;
  } | null>(null);
  const [loggingIn, setLoggingIn] = createSignal(false);

  /// On an auth failure, ask the backend how this context logs in and
  /// offer to do it — an expired SSO session is a browser click away.
  async function offerLogin(name: string) {
    try {
      const hint = await invoke<{
        kind: string;
        message: string;
        command: string | null;
        can_login: boolean;
      }>("auth_hint", { context: name, path: sourceOf(name) || null });
      setAuthHint({ context: name, ...hint });
    } catch {
      /* no hint available; the error banner still shows the raw cause */
    }
  }

  /// Run the login flow (opens the browser), then reconnect.
  async function runLogin() {
    const h = authHint();
    if (!h) return;
    setLoggingIn(true);
    setError(null);
    try {
      await invoke("auth_login", {
        context: h.context,
        path: sourceOf(h.context) || null,
      });
      setAuthHint(null);
      await reconnect(h.context);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoggingIn(false);
    }
  }
  /// Turn a raw kube/exec error into one readable line. The exec
  /// failure dumps the whole get-token command and a Rust Output{...}
  /// struct; the part that matters is the plugin's stderr.
  function prettyError(msg: string): string {
    // pull the exec plugin's own stderr out of the Output{…} dump
    const stderr = msg.match(/stderr:\s*"((?:\\.|[^"\\])*)"/);
    if (stderr) {
      const text = stderr[1].replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
      if (/SSO Token|sso/i.test(text)) return "AWS SSO session expired — log in to renew it.";
      if (text) return text;
    }
    if (/exit status: 255|get-token/i.test(msg))
      return "the cluster's auth command failed — your credentials have likely expired.";
    if (/401|Unauthorized/i.test(msg)) return "unauthorized — the token was rejected.";
    if (/403|Forbidden/i.test(msg)) return "forbidden — this account lacks access.";
    if (/no such host|dns/i.test(msg)) return "cannot resolve the API server address.";
    if (/refused|timed out|timeout/i.test(msg))
      return "cannot reach the API server (connection refused or timed out).";
    if (/certificate|x509/i.test(msg)) return "the server certificate could not be verified.";
    // collapse a long single-line dump
    return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
  }

  const isAuthError = (msg: string) =>
    /401|403|Unauthorized|Forbidden|credential|token|expired|exec plugin|no such host|refused|timed out|certificate/i.test(
      msg,
    );

  /// Drop the cached client and reconnect — the fix for an expired SSO
  /// token, since kubeconfig exec credentials are re-run on connect.
  async function reconnect(name: string) {
    setConnecting(name);
    setError(null);
    try {
      await invoke("disconnect", { context: name });
      tabCache.delete(name);
      await setupContext(name);
      if (!tabs().includes(name)) setTabs([...tabs(), name]);
      setFailed(failed().filter((f) => f.name !== name));
      setAuthHint(null);
      activate(name);
    } catch (e) {
      const msg = String(e);
      setError(`could not connect to ${name}: ${msg}`);
      if (isAuthError(msg)) void offerLogin(name);
    } finally {
      setConnecting(null);
    }
  }

  const [forwards, setForwards] = createSignal<PfInfo[]>([]);
  const [pfPort, setPfPort] = createSignal("");
  const [pfOpen, setPfOpen] = createSignal(false);
  const [scaleOpen, setScaleOpen] = createSignal(false);
  // Multi-container pods ask which container before a shell or logs.
  const [pickMode, setPickMode] = createSignal<"pod" | "logs" | null>(null);
  const [pickIdx, setPickIdx] = createSignal(0);
  const [pickList, setPickList] = createSignal<string[]>([]);
  const [pickTarget, setPickTarget] = createSignal<Target | null>(null);

  /// Open a shell or logs on a pod, asking which container when there
  /// is a choice. Every entry point — detail panel or table row —
  /// comes through here, so the prompt never gets skipped.
  function startPodSession(
    mode: "pod" | "logs",
    target: Target,
    containers: string[],
    container?: string,
  ) {
    if (!container && containers.length > 1) {
      setPickTarget(target);
      setPickList(containers);
      setPickIdx(0);
      setPickMode(mode);
      return;
    }
    setPickMode(null);
    openShell({
      kind: mode,
      context: active()!,
      namespace: target.namespace ?? "default",
      name: target.name,
      container,
    });
  }

  function openPodSession(mode: "pod" | "logs", container?: string) {
    const d = detail();
    if (!d) return;
    startPodSession(
      mode,
      { namespace: d.namespace, name: d.name },
      d.containers,
      container,
    );
  }

  /// From the table there is no manifest yet: fetch the pod first so
  /// the container list is known before the session opens.
  async function openPodSessionForRow(mode: "pod" | "logs", row: TableRow) {
    const target = { namespace: row.namespace, name: row.name };
    try {
      const d = await fetchDetail(row.namespace, row.name);
      startPodSession(mode, target, d?.containers ?? []);
    } catch (e) {
      setError(String(e));
    }
  }

  function openScale() {
    const d = detail();
    if (!d) return;
    setScaleInput(String(d.replicas ?? 0));
    setScaleOpen(true);
  }

  function applyScale() {
    const d = detail();
    const n = parseInt(scaleInput(), 10);
    if (!d || Number.isNaN(n) || n < 0) return;
    setScaleOpen(false);
    void runAction("scale", () =>
      invoke("scale_resource", {
        context: active(),
        resource: selected(),
        namespace: d.namespace,
        name: d.name,
        replicas: n,
      }),
    );
  }
  const [shellCfg, setShellCfg] = createSignal<ShellCfg>(
    JSON.parse(localStorage.getItem("pigeoneye.shell") ?? "{}"),
  );

  function saveShellCfg(patch: Partial<ShellCfg>) {
    const v = { ...shellCfg(), ...patch };
    setShellCfg(v);
    localStorage.setItem("pigeoneye.shell", JSON.stringify(v));
  }

  async function pfStart(port: number) {
    const d = detail();
    const ctx = active();
    if (!d || !ctx || !port) return;
    setActionBusy("forward");
    setActionErr(null);
    try {
      const info = await invoke<PfInfo>("pf_start", {
        context: ctx,
        namespace: d.namespace ?? "default",
        pod: d.name,
        port,
      });
      setForwards([...forwards(), info]);
      setActionMsg(
        `forwarding localhost:${info.local} → :${info.remote} (see sidebar)`,
      );
      void openUrl(`http://localhost:${info.local}`);
    } catch (e) {
      setActionErr(String(e));
    } finally {
      setActionBusy(null);
    }
  }

  function pfStop(id: number) {
    void invoke("pf_stop", { id }).catch(() => {});
    setForwards(forwards().filter((f) => f.id !== id));
  }

  void invoke<PfInfo[]>("pf_list")
    .then(setForwards)
    .catch(() => {});
  const [podStats, setPodStats] = createSignal<Map<string, PodStat> | null>(null);
  const [nodeStats, setNodeStats] = createSignal<Map<string, NodeStat> | null>(
    null,
  );
  async function loadNodeStats(ctx: string) {
    try {
      const stats = await invoke<NodeStat[]>("node_stats", { context: ctx });
      if (active() === ctx && kindIs("", "Node")) {
        setNodeStats(new Map(stats.map((s) => [s.name, s])));
      }
    } catch {
      /* metrics API not installed — columns just show "-" */
    }
  }
  const [sortCol, setSortCol] = createSignal<number | null>(null);
  const [colsOpen, setColsOpen] = createSignal(false);
  const [hiddenCols, setHiddenCols] = createSignal<Record<string, string[]>>(
    JSON.parse(localStorage.getItem("pigeoneye.cols") ?? "{}"),
  );

  const colKey = () => (selected() ? typeKey(selected()!) : "");

  /// Columns the API server marks as wide-only (priority > 0) — the
  /// ones `kubectl` hides unless you ask for -o wide.
  const widePriority = createMemo(() => {
    const t = table();
    const m = new Set<string>();
    for (const c of t?.columns ?? []) if (c.priority > 0) m.add(c.name);
    return m;
  });

  /// Columns hidden for this kind: the user's choice if they made one,
  /// otherwise the server's own "wide only" marking (priority > 0).
  const hiddenFor = createMemo(() => {
    const saved = hiddenCols()[colKey()];
    if (saved) return new Set(saved);
    const t = table();
    if (!t) return new Set<string>();
    return new Set(t.columns.filter((c) => c.priority > 0).map((c) => c.name));
  });

  function toggleCol(name: string) {
    const next = new Set(hiddenFor());
    next.has(name) ? next.delete(name) : next.add(name);
    setHiddenCols({ ...hiddenCols(), [colKey()]: [...next] });
    localStorage.setItem(
      "pigeoneye.cols",
      JSON.stringify({ ...hiddenCols(), [colKey()]: [...next] }),
    );
    setSortCol(null);
  }

  function resetCols() {
    const next = { ...hiddenCols() };
    delete next[colKey()];
    setHiddenCols(next);
    localStorage.setItem("pigeoneye.cols", JSON.stringify(next));
    setSortCol(null);
  }
  const [sortDir, setSortDir] = createSignal<1 | -1>(1);
  // Per-column value filters (spreadsheet-style), keyed by column name so
  // they survive re-sorting. colMenu is the column whose value list is open.
  const [colFilters, setColFilters] = createSignal<Record<string, Set<string>>>(
    {},
  );
  const [colMenu, setColMenu] = createSignal<string | null>(null);
  const [colMenuQ, setColMenuQ] = createSignal("");
  const [colMenuAt, setColMenuAt] = createSignal<{ x: number; y: number } | null>(
    null,
  );
  const [colMenuIdx, setColMenuIdx] = createSignal(-1); // keyboard cursor in the value list
  // Distinct values (+counts) of the open column, filtered by the search.
  // High-cardinality columns (IP, NODE — nearly every row unique) would
  // build and render tens of thousands of entries and freeze, so the
  // scan stops once it passes a cap and reports `overflow` instead; those
  // columns offer sorting only, not a value list.
  const COL_VALUE_CAP = 200;
  const colMenuData = createMemo<{
    values: [string, number][];
    overflow: boolean;
  }>(() => {
    const name = colMenu();
    if (!name) return { values: [], overflow: false };
    const b = baseRows();
    const ci = b.cols.indexOf(name);
    if (ci < 0) return { values: [], overflow: false };
    const counts = new Map<string, number>();
    let overflow = false;
    for (const r of b.rows) {
      const v = r.cells[ci] ?? "";
      const cur = counts.get(v);
      if (cur === undefined) {
        if (counts.size >= COL_VALUE_CAP) {
          overflow = true;
          break; // too many distinct — bail before it freezes
        }
        counts.set(v, 1);
      } else counts.set(v, cur + 1);
    }
    if (overflow) return { values: [], overflow: true };
    const q = colMenuQ().toLowerCase().trim();
    return {
      values: [...counts.entries()]
        .filter(([v]) => !q || v.toLowerCase().includes(q))
        .sort((a, z) => cmpCells(a[0], z[0])),
      overflow: false,
    };
  });
  const colMenuValues = () => colMenuData().values;
  function toggleColValue(name: string, val: string) {
    const cur = colFilters();
    const set = new Set(cur[name] ?? []);
    if (set.has(val)) set.delete(val);
    else set.add(val);
    const next = { ...cur };
    if (set.size) next[name] = set;
    else delete next[name];
    setColFilters(next);
  }
  // Numeric column filters: a comparison instead of a value list, since
  // listing every distinct number (cpu, mem, %, restarts) is useless.
  type NumOp = ">" | ">=" | "<" | "<=" | "=";
  const [colNumFilters, setColNumFilters] = createSignal<
    Record<string, { op: NumOp; val: number }>
  >({});
  /// Leading number in a cell ("91%"→91, "9 (27d ago)"→9, "n/a"→null).
  const cellNum = (v: string): number | null => {
    const m = v.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0]);
    return Number.isFinite(n) ? n : null;
  };
  /// A column is "numeric" if most non-blank sampled cells are plain
  /// numbers (optionally a trailing %). Durations like "53d"/"4h20m" are
  /// deliberately NOT numeric — comparing 4(h) vs 53(d) would be wrong.
  const colIsNumeric = (name: string): boolean => {
    const b = baseRows();
    const ci = b.cols.indexOf(name);
    if (ci < 0) return false;
    let num = 0;
    let tot = 0;
    for (const r of b.rows.slice(0, 400)) {
      const v = (r.cells[ci] ?? "").trim();
      if (!v || v === "n/a" || v === "-" || v === "<none>") continue;
      tot++;
      if (/^-?\d+(?:\.\d+)?%?$/.test(v)) num++;
    }
    return tot >= 3 && num / tot >= 0.7;
  };
  function setColNum(name: string, op: NumOp, val: string) {
    const next = { ...colNumFilters() };
    const n = parseFloat(val);
    if (val.trim() === "" || !Number.isFinite(n)) delete next[name];
    else next[name] = { op, val: n };
    setColNumFilters(next);
  }
  function clearColFilter(name: string) {
    const next = { ...colFilters() };
    delete next[name];
    setColFilters(next);
    const nn = { ...colNumFilters() };
    delete nn[name];
    setColNumFilters(nn);
  }
  /// Whether a column has any active filter (value-set or numeric).
  const colHasFilter = (name: string) =>
    (colFilters()[name]?.size ?? 0) > 0 || !!colNumFilters()[name];
  const [cmdOpen, setCmdOpen] = createSignal(false);
  const [cmdText, setCmdText] = createSignal("");
  const [cmdIdx, setCmdIdx] = createSignal(0);
  const [cursor, setCursor] = createSignal(0);
  // Space-marked rows, keyed ns/name so they survive re-sorting.
  const [marked, setMarked] = createSignal<Set<string>>(new Set());
  const rowKeyOf = (r: TableRow) => `${r.namespace ?? ""}/${r.name}`;

  function toggleMark(r: TableRow) {
    const next = new Set(marked());
    const k = rowKeyOf(r);
    next.has(k) ? next.delete(k) : next.add(k);
    setMarked(next);
  }

  /// Marked rows in the order they appear, as action targets.
  const markedTargets = createMemo<Target[]>(() => {
    const keys = marked();
    if (!keys.size) return [];
    return view()
      .rows.map((vr) => vr.row)
      .filter((r) => keys.has(rowKeyOf(r)))
      .map((r) => ({ namespace: r.namespace, name: r.name }));
  });
  /// Focus hierarchy: the sidebar is the top level, the table sits
  /// under it, and the detail panel under that. Esc walks back up.
  const [pane, setPane] = createSignal<"sidebar" | "table">("sidebar");
  const [sideIdx, setSideIdx] = createSignal(0);
  const [openGroups, setOpenGroups] = createSignal<Set<string>>(new Set());

  const groupOpen = (g: string) => openGroups().has(g);

  function toggleGroup(g: string) {
    const next = new Set(openGroups());
    next.has(g) ? next.delete(g) : next.add(g);
    setOpenGroups(next);
  }
  const [helpOpen, setHelpOpen] = createSignal(false);
  let rowSearchRef: HTMLInputElement | undefined;
  let findInputRef: HTMLInputElement | undefined;
  let tableFocusRef: HTMLDivElement | undefined;
  let tableRO: ResizeObserver | undefined;
  let drawerBodyRef: HTMLDivElement | undefined;
  let kindFilterRef: HTMLInputElement | undefined;
  let annoFoldRef: HTMLDetailsElement | undefined;
  let statusFoldRef: HTMLDetailsElement | undefined;
  let eventFoldRef: HTMLDetailsElement | undefined;

  const [detail, setDetail] = createSignal<ResourceDetail | null>(null);
  const [detailKey, setDetailKey] = createSignal<string | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [yamlText, setYamlText] = createSignal("");
  // "New" (create) dialog state.
  const [newOpen, setNewOpen] = createSignal(false);
  const [newYaml, setNewYaml] = createSignal("");
  const [newNs, setNewNs] = createSignal("");
  const [newBusy, setNewBusy] = createSignal(false);
  const [newErr, setNewErr] = createSignal<string | null>(null);
  const [newNsOpen, setNewNsOpen] = createSignal(false);
  const [newNsQuery, setNewNsQuery] = createSignal("");
  // Which part of the New dialog the keyboard owns: the manifest editor
  // or the Create/Cancel actions. Esc steps editor → actions → close.
  // Vertical keyboard sections of the New dialog, top → bottom.
  const [newSec, setNewSec] = createSignal<"namespace" | "editor" | "actions">(
    "editor",
  );
  const [newDlgIdx, setNewDlgIdx] = createSignal(1); // 0=Cancel, 1=Create
  let newEditorApi: { next: () => void; focus: () => void } | undefined;
  // Sections present for this kind (namespace only for namespaced kinds).
  const newSections = (): ("namespace" | "editor" | "actions")[] =>
    selected()?.namespaced
      ? ["namespace", "editor", "actions"]
      : ["editor", "actions"];
  const newNsFiltered = createMemo(() => {
    const q = newNsQuery().toLowerCase().trim();
    return namespaces().filter((n) => !q || n.toLowerCase().includes(q));
  });
  const [actionBusy, setActionBusy] = createSignal<string | null>(null);
  const [actionMsg, setActionMsg] = createSignal<string | null>(null);
  const [actionErr, setActionErr] = createSignal<string | null>(null);
  const [scaleInput, setScaleInput] = createSignal("");
  // find-in-resource: highlights across manifest, labels, annotations, status
  const [findQ, setFindQ] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  const [secretShown, setSecretShown] = createSignal(false);

  /// Copy the manifest as shown, so it can be pasted into a file or a
  /// PR without going through the editor's selection.
  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(yamlText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      setActionErr(`could not copy: ${String(e)}`);
    }
  }
  const [events, setEvents] = createSignal<EventInfo[]>([]);
  /// Which section of the open detail panel the keyboard is on.
  const [panelSec, setPanelSec] = createSignal<string>("meta");
  const [actionIdx, setActionIdx] = createSignal(0);

  /// Forwards belonging to the resource in the open panel.
  const podForwards = createMemo(() => {
    const d = detail();
    if (!d) return [] as PfInfo[];
    return forwards().filter(
      (f) => f.pod === d.name && f.namespace === (d.namespace ?? ""),
    );
  });

  const panelSections = createMemo(() => {
    const d = detail();
    if (!d) return [] as string[];
    return [
      "actions",
      "meta",
      ...(Object.keys(d.labels).length ? ["labels"] : []),
      ...(Object.keys(d.annotations).length ? ["anno"] : []),
      ...(d.status != null ? ["status"] : []),
      ...(events().length ? ["events"] : []),
      "yaml",
      ...(canEdit() ? ["apply"] : []),
    ];
  });

  /// Rows of real buttons (action bar, Apply/Reset) are driven by
  /// native focus so Enter/Space activate them without extra wiring.
  const BUTTON_ROWS: Record<string, string> = {
    actions: ".drawer .actions",
    apply: ".drawer .yaml-actions",
  };

  function rowItems(sec: string): HTMLElement[] {
    const sel = BUTTON_ROWS[sec];
    if (!sel) return [];
    return [
      ...document.querySelectorAll<HTMLElement>(`${sel} button:not(:disabled)`),
    ];
  }

  /// Highlight is ours, not the browser's: WebKit won't give buttons
  /// focus rings by default, so a class carries the cursor.
  function paintRowCursor(sec: string, idx: number) {
    document
      .querySelectorAll(".btn-cursor")
      .forEach((el) => el.classList.remove("btn-cursor"));
    const items = rowItems(sec);
    const el = items[idx];
    if (el) {
      el.classList.add("btn-cursor");
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function focusRowButton(sec: string, idx = 0) {
    const items = rowItems(sec);
    if (!items.length) return false;
    const i = Math.min(Math.max(idx, 0), items.length - 1);
    setActionIdx(i);
    paintRowCursor(sec, i);
    return true;
  }

  function moveWithinRow(step: number) {
    const items = rowItems(panelSec());
    if (!items.length) return;
    const next = Math.min(Math.max(actionIdx() + step, 0), items.length - 1);
    setActionIdx(next);
    paintRowCursor(panelSec(), next);
  }

  function pressRowButton() {
    const items = rowItems(panelSec());
    items[Math.min(actionIdx(), items.length - 1)]?.click();
  }

  function movePanel(delta: number) {
    const secs = panelSections();
    if (!secs.length) return;
    const i = Math.max(0, secs.indexOf(panelSec()));
    const next = Math.min(Math.max(i + delta, 0), secs.length - 1);
    const sec = secs[next];
    setPanelSec(sec);
    // Always bring the section into view first — Apply/Reset are
    // disabled until the manifest changes, so a cursor-only scroll
    // would leave the row off-screen.
    document
      .querySelector(`.psec[data-sec="${sec}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (BUTTON_ROWS[sec]) {
      requestAnimationFrame(() => focusRowButton(sec, 0));
      return;
    }
    document
      .querySelectorAll(".btn-cursor")
      .forEach((el) => el.classList.remove("btn-cursor"));
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  /// Enter on the focused section: open folds, enter the editor.
  /// Focus the panel's find box, wherever focus currently sits.
  function focusFind() {
    setPanelSec("meta");
    requestAnimationFrame(() => {
      findInputRef?.focus();
      findInputRef?.select();
    });
  }

  function activatePanelSection() {
    const sec = panelSec();
    if (BUTTON_ROWS[sec]) return; // the focused button handles Enter
    if (sec === "anno" && annoFoldRef) annoFoldRef.open = !annoFoldRef.open;
    else if (sec === "events" && eventFoldRef)
      eventFoldRef.open = !eventFoldRef.open;
    else if (sec === "status" && statusFoldRef)
      statusFoldRef.open = !statusFoldRef.open;
    else if (sec === "yaml") void openYaml();
  }
  let yamlFind: { next: () => void; focus: () => void } | undefined;
  const findMatches = (text: string) => {
    const q = findQ().toLowerCase().trim();
    return q !== "" && text.toLowerCase().includes(q);
  };

  const tabCache = new Map<string, TabState>();
  const typeKey = (t: ResourceType) => `${t.group}/${t.kind}`;

  createEffect(() => {
    document.documentElement.dataset.theme = theme();
    localStorage.setItem("pigeoneye.theme", theme());
  });

  // ── shell tabs ─────────────────────────────────────────
  const shellKey = (t: ShellTarget) =>
    `${t.kind}:${t.resource?.kind ?? ""}:${t.context}:${t.namespace ?? ""}:${t.name}:${t.container ?? ""}`;

  /// Which rows already have a session, so the table can show it.
  const openSessions = createMemo(() => {
    const m = new Map<string, ShellTarget["kind"][]>();
    for (const sh of shells()) {
      if (shellStatus().get(sh.k) === "exited") continue;
      const k = `${sh.target.namespace ?? ""}/${sh.target.name}`;
      m.set(k, [...(m.get(k) ?? []), sh.target.kind]);
    }
    return m;
  });

  function openShell(target: ShellTarget) {
    const cfg = shellCfg();
    if (target.kind === "pod" && cfg.podCommand?.trim()) {
      target.command = cfg.podCommand.trim();
    }
    if (target.kind === "node") {
      target.podName = cfg.nodeName?.trim() || undefined;
      target.image = cfg.nodeImage?.trim() || undefined;
      target.shellNamespace = cfg.nodeNamespace?.trim() || undefined;
      target.cpuLimit = cfg.nodeCpu?.trim() || undefined;
      target.memoryLimit = cfg.nodeMem?.trim() || undefined;
    }
    // Reuse a live session for the same target instead of opening a
    // second shell into the same container.
    const existing = shells().find(
      (s) =>
        shellKey(s.target) === shellKey(target) &&
        shellStatus().get(s.k) !== "exited",
    );
    if (existing) {
      closeDetail();
      setTermMin(false);
      setActiveShell(existing.k);
      requestAnimationFrame(focusTerminal);
      return;
    }
    closeDetail();
    setTermMin(false);
    const k = nextShellKey++;
    setShells([...shells(), { k, target }]);
    setShellStatus(new Map(shellStatus()).set(k, "running"));
    setActiveShell(k);
  }

  function closeShell(k: number) {
    termApis.delete(k);
    if (activeShell() === k) setTermFocused(false);
    const rest = shells().filter((s) => s.k !== k);
    setShells(rest);
    const st = new Map(shellStatus());
    st.delete(k);
    setShellStatus(st);
    if (activeShell() === k) {
      setActiveShell(rest.length ? rest[rest.length - 1].k : null);
    }
  }

  /// Hand focus back to the table so global keys work again.
  function leaveTerminal() {
    setTermFocused(false);
    (document.activeElement as HTMLElement | null)?.blur?.();
    tableFocusRef?.focus();
  }

  function markShellExited(k: number) {
    setShellStatus(new Map(shellStatus()).set(k, "exited"));
  }

  // ── view history: Esc walks back through views ─────────
  const navHistory: { t: ResourceType; ns: string; filter: string }[] = [];
  let navigating = false;

  function pushHistory() {
    const s = selected();
    if (!s) return;
    navHistory.push({ t: s, ns: namespace(), filter: rowFilter() });
    if (navHistory.length > 50) navHistory.shift();
  }

  function popHistory() {
    const prev = navHistory.pop();
    if (!prev) return;
    navigating = true;
    setNamespace(prev.ns);
    void select(prev.t)
      .then(() => {
        if (prev.filter) onRowFilterInput(prev.filter);
      })
      .finally(() => {
        navigating = false;
      });
  }

  const nsFiltered = createMemo(() => {
    const q = nsQuery().toLowerCase().trim();
    if (!q) return namespaces();
    return namespaces().filter((n) => n.includes(q));
  });

  function pickNamespace(ns: string) {
    setNamespace(ns);
    const st = tabCache.get(active()!);
    if (st) st.namespace = ns;
    setNsOpen(false);
    const s = selected();
    if (s) void select(s);
  }

  function persist() {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ tabs: tabs(), active: active() }),
    );
  }

  function sourceOf(name: string): string {
    return contexts().find((c) => c.name === name)?.source ?? "";
  }

  async function setupContext(name: string): Promise<void> {
    const source = sourceOf(name);
    await invoke("connect", { context: name, path: source || null });
    const [ts, ns] = await Promise.all([
      invoke<ResourceType[]>("discover", { context: name }),
      invoke<string[]>("list_namespaces", { context: name }),
    ]);
    tabCache.set(name, {
      types: ts,
      namespaces: ns.sort(),
      namespace: "",
      selectedKey: null,
      source,
    });
  }

  function activate(name: string) {
    const st = tabCache.get(name);
    if (!st) return;
    setActive(name);
    setTypes(st.types);
    setNamespaces(st.namespaces);
    setNamespace(st.namespace);
    setTable(null);
    setRowFilter("");
    setMatched(null);
    filterSeq++;
    closeDetail();
    const sel = st.selectedKey
      ? st.types.find((t) => typeKey(t) === st.selectedKey) ?? null
      : null;
    setSelected(sel);
    setPane(sel ? "table" : "sidebar");
    setSideIdx(sel ? Math.max(sidebarItems().indexOf(sel), 0) : 0);
    if (sel) void select(sel);
    persist();
  }

  async function openContext(name: string) {
    if (tabCache.has(name)) {
      if (!tabs().includes(name)) setTabs([...tabs(), name]);
      activate(name);
      return;
    }
    setConnecting(name);
    setError(null);
    try {
      await setupContext(name);
      setTabs([...tabs(), name]);
      activate(name);
    } catch (e) {
      const msg = String(e);
      setError(`could not connect to ${name}: ${msg}`);
      setFailed([...failed().filter((f) => f.name !== name), { name, error: msg }]);
      if (isAuthError(msg)) void offerLogin(name);
    } finally {
      setConnecting(null);
    }
  }

  function closeTab(name: string) {
    void invoke("disconnect", { context: name }).catch(() => {});
    tabCache.delete(name);
    const rest = tabs().filter((t) => t !== name);
    setTabs(rest);
    if (active() === name) {
      if (rest.length) {
        activate(rest[rest.length - 1]);
      } else {
        setActive(null);
        setTypes([]);
        setNamespaces([]);
        setSelected(null);
        setTable(null);
        closeDetail();
      }
    }
    persist();
  }

  async function loadContexts(restore: boolean) {
    try {
      const cs = await invoke<ContextInfo[]>("list_contexts", {
        paths: kubeconfigs(),
      });
      setContexts(cs);
      if (restore) restoreSession(cs);
    } catch (e) {
      setContexts([]);
      setError(String(e));
    }
  }

  // Previous session: all saved tabs reconnect in parallel, the last
  // active tab wins focus back.
  function restoreSession(cs: ContextInfo[]) {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { tabs: string[]; active: string | null };
    const known = new Set(cs.map((c) => c.name));
    const wanted = (saved.tabs ?? []).filter((t) => known.has(t));
    if (!wanted.length) return;
    setConnecting(wanted.join(", "));
    void Promise.all(
      wanted.map((name) =>
        setupContext(name)
          .then(() => name)
          .catch((e) => {
            failedTabs.push({ name, error: String(e) });
            return null;
          }),
      ),
    )
      .then((results) => {
        const opened = results.filter((n): n is string => n !== null);
        if (failedTabs.length) {
          setError(
            failedTabs
              .map((f) => `could not connect to ${f.name}: ${f.error}`)
              .join("\n"),
          );
          setFailed([...failedTabs]);
          const authFail = failedTabs.find((f) => isAuthError(f.error));
          if (authFail) void offerLogin(authFail.name);
          failedTabs.length = 0;
        }
        setTabs(opened);
        const act =
          saved.active && opened.includes(saved.active)
            ? saved.active
            : opened[0];
        if (act) activate(act);
      })
      .finally(() => setConnecting(null));
  }

  void loadContexts(false);

  function saveKubeconfigs(paths: string[]) {
    setKubeconfigs(paths);
    localStorage.setItem(KUBECONFIG_KEY, JSON.stringify(paths));
    void loadContexts(false);
  }

  let filterTimer: number | undefined;
  let filterSeq = 0;
  let indexed = false;
  let indexPromise: Promise<unknown> | null = null;
  const [indexing, setIndexing] = createSignal(false);

  function onRowFilterInput(value: string) {
    setRowFilter(value);
    window.clearTimeout(filterTimer);
    const seq = ++filterSeq;
    if (!value.trim()) {
      setMatched(null);
      return;
    }
    // Only the plain substring terms go to the backend deep index;
    // regex/negation are applied on the visible haystack in view().
    const backendQ = parseQuery(value).poss.join(" ");
    filterTimer = window.setTimeout(async () => {
      try {
        if (!backendQ) {
          if (seq === filterSeq) setMatched(new Set<string>());
          return;
        }
        // Seeded matches (name/labels/cells) land instantly…
        const quick = await invoke<string[]>("filter_rows", { query: backendQ });
        if (seq === filterSeq) setMatched(new Set(quick));
        // …then the full-object index is built once per list, so a
        // plain browse never pays for it.
        // Keystrokes during the build share one request and re-filter
        // with whatever is typed by the time it lands.
        if (!indexed) {
          if (!indexPromise) {
            setIndexing(true);
            indexPromise = invoke("ensure_index").finally(() => {
              indexed = true;
              indexPromise = null;
              setIndexing(false);
            });
          }
          await indexPromise;
          const latest = parseQuery(rowFilter()).poss.join(" ");
          if (latest) {
            setMatched(new Set(await invoke<string[]>("filter_rows", { query: latest })));
          }
        }
      } catch {
        setIndexing(false);
      }
    }, 80);
  }

  async function select(rt: ResourceType, fieldSelector?: string) {
    const ctx = active();
    if (!ctx) return;
    setPane("table");
    setFieldSel(
      fieldSelector ? { key: typeKey(rt), selector: fieldSelector } : null,
    );
    if (!navigating && selected() && selected() !== rt) pushHistory();
    const st = tabCache.get(ctx);
    if (st) st.selectedKey = typeKey(rt);
    setSelected(rt);
    setRowFilter("");
    setMatched(null);
    stopWatch();
    setPodStats(null);
    setNodeStats(null);
    setSortCol(null);
    // Column filters are per-kind (columns differ), so clear on switch.
    setColFilters({});
    setColNumFilters({});
    setColMenu(null);
    setCursor(0);
    setMarked(new Set<string>());
    if (tableFocusRef) tableFocusRef.scrollTop = 0;
    setScrollTop(0);
    indexed = false;
    indexPromise = null;
    filterSeq++;
    closeDetail();
    setError(null);
    const ns = rt.namespaced && namespace() ? namespace() : null;
    // Coming back to a view should not refetch 20k rows. Paint the cached
    // rows, then — instead of re-listing everything — resume the watch
    // from the cached snapshot's resourceVersion so only what changed
    // since arrives (an informer catch-up).
    let cached: ResourceTable | null = null;
    try {
      cached = await invoke<ResourceTable | null>("cached_list", {
        context: ctx,
        resource: rt,
        namespace: ns,
        fieldSelector: fieldSelector ?? null,
      });
    } catch {
      /* no cache is fine */
    }
    if (
      cached &&
      cached.resource_version &&
      active() === ctx &&
      selected() === rt
    ) {
      setTable(cached);
      setLoading(false);
      setStreaming(false);
      // Bump the sequence so any prior stream is ignored, then resume the
      // watch. If the version is too old the server RESYNCs and the watch
      // handler does a full refreshList().
      listSeq++;
      if (rt.group === "" && rt.kind === "Pod") {
        void loadPodStats(ctx, ns);
        // cached_list re-seeds the search cache and clears pod_res, so the
        // %request/%limit columns would read n/a. Rebuild the index in the
        // background (non-blocking), then refresh stats so they fill in
        // without needing a search.
        if (!indexed && !indexPromise) {
          indexPromise = invoke("ensure_index")
            .then(() => {
              if (active() === ctx && selected() === rt) void loadPodStats(ctx, ns);
            })
            .finally(() => {
              indexed = true;
              indexPromise = null;
            });
        }
      }
      if (rt.group === "" && rt.kind === "Node") void loadNodeStats(ctx);
      const started = await startWatch(
        ctx,
        rt,
        ns,
        fieldSelector ?? null,
        cached.resource_version,
        cached.include,
      );
      // No watch (server refused it): cached rows would never revalidate,
      // so fall back to a full fetch.
      if (!started && active() === ctx && selected() === rt) void refreshList();
      return;
    }
    setLoading(true);
    try {
      // Big clusters do not fit in one page: the first page renders
      // immediately and the rest arrives on this channel, so search
      // eventually covers everything without blocking first paint.
      const seq = ++listSeq;
      const chan = new Channel<{ rows: TableRow[]; done: boolean }>();
      chan.onmessage = (page) => {
        if (seq !== listSeq) return;
        setTable((prev) =>
          prev ? { ...prev, rows: [...prev.rows, ...page.rows] } : prev,
        );
        setStreaming(!page.done);
      };
      const t = await invoke<ResourceTable>("list_resources", {
        context: ctx,
        resource: rt,
        namespace: ns,
        fieldSelector: fieldSelector ?? null,
        channel: chan,
      });
      if (active() === ctx && selected() === rt) {
        setStreaming(t.truncated);
        setTable(t);
        if (rt.group === "" && rt.kind === "Pod") void loadPodStats(ctx, ns);
        if (rt.group === "" && rt.kind === "Node") void loadNodeStats(ctx);
        void startWatch(
          ctx,
          rt,
          ns,
          fieldSelector ?? null,
          t.resource_version,
          t.include,
        );
      }
    } catch (e) {
      if (active() === ctx) {
        const msg = String(e);
        setError(`${rt.kind}: ${msg}`);
        // An expired token invalidates the whole tab, not just this list.
        if (isAuthError(msg)) {
          setFailed([{ name: ctx, error: msg }]);
          void offerLogin(ctx);
        }
        setTable(null);
      }
    } finally {
      if (active() === ctx) setLoading(false);
    }
  }

  /// Metrics join the table asynchronously: the first fetch lands as
  /// soon as metrics.k8s.io answers, then retries pick up the
  /// requests/limits once the background indexer has them.
  async function loadPodStats(ctx: string, ns: string | null) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const stats = await invoke<PodStat[]>("pod_stats", {
          context: ctx,
          namespace: ns,
        });
        if (active() !== ctx || !isPod()) return;
        setPodStats(new Map(stats.map((s) => [s.key, s])));
        if (stats.some((s) => s.cpu_r || s.cpu_l || s.mem_r || s.mem_l)) return;
      } catch {
        return; // metrics-server not installed — columns just stay off
      }
      await new Promise((r) => setTimeout(r, 800));
      if (active() !== ctx || !isPod()) return;
    }
  }

  async function jumpToNode(node: string) {
    const t = types().find((x) => x.group === "" && x.kind === "Node");
    if (!t) return;
    await select(t);
    await showDetail(null, node);
  }

  /// Enter on a namespace scopes the app to it and shows its pods —
  /// the manifest is still one `e`/`y` away.
  async function enterNamespace(name: string) {
    const st = tabCache.get(active()!);
    if (st) st.namespace = name;
    setNamespace(name);
    const pod = types().find((t) => t.group === "" && t.kind === "Pod");
    if (pod) await select(pod);
  }

  async function jumpToRef(inv: RefLink) {
    const t = types().find((x) => x.kind === inv.kind);
    if (!t) {
      setError(`${inv.kind} is not served by this cluster`);
      return;
    }
    if (inv.namespace) {
      const st = tabCache.get(active()!);
      if (st) st.namespace = inv.namespace;
      setNamespace(inv.namespace);
    }
    await select(t);
    await showDetail(inv.namespace, inv.name);
  }

  const jumpToInvolved = () => {
    const inv = detail()?.involved;
    if (inv) return jumpToRef(inv);
  };

  /// Show the pods a workload or service selects, using the same label
  /// selector the controller uses.
  async function jumpToSelectedPods() {
    const d = detail();
    if (!d) return;
    const pod = types().find((t) => t.group === "" && t.kind === "Pod");
    if (!pod) return;
    if (d.namespace) {
      const st = tabCache.get(active()!);
      if (st) st.namespace = d.namespace;
      setNamespace(d.namespace);
    }
    // Use the real label selector when the object has one (Services,
    // workloads) — a name text-filter over-matches (any pod whose name
    // contains this one's) and misses Services entirely (pods don't carry
    // the Service name). Fall back to the name filter only if there's no
    // selector.
    if (d.pod_selector) {
      await select(pod, `label:${d.pod_selector}`);
    } else {
      await select(pod);
      onRowFilterInput(d.name);
    }
  }

  /// Reverse links: who *uses* the open resource. Forward references
  /// live in the manifest, but "which pods mount this Secret" only
  /// exists as a search — and the full-text index makes it exact.
  const USED_BY: Record<
    string,
    { kind: string; label: string; field?: (name: string) => string }[]
  > = {
    ServiceAccount: [
      {
        kind: "Pod",
        label: "pods →",
        field: (n) => `spec.serviceAccountName=${n}`,
      },
    ],
    ConfigMap: [{ kind: "Pod", label: "pods →" }],
    Secret: [{ kind: "Pod", label: "pods →" }],
    PersistentVolumeClaim: [{ kind: "Pod", label: "pods →" }],
    PriorityClass: [{ kind: "Pod", label: "pods →" }],
    StorageClass: [
      { kind: "PersistentVolumeClaim", label: "pvcs →" },
      { kind: "PersistentVolume", label: "pvs →" },
    ],
    IngressClass: [{ kind: "Ingress", label: "ingresses →" }],
    RuntimeClass: [{ kind: "Pod", label: "pods →" }],
    Role: [{ kind: "RoleBinding", label: "bindings →" }],
    ClusterRole: [{ kind: "ClusterRoleBinding", label: "bindings →" }],
    Service: [{ kind: "EndpointSlice", label: "endpoints →" }],
  };

  /// Open another kind filtered to whatever references `term`.
  async function jumpToKindFiltered(
    kind: string,
    term: string,
    ns?: string | null,
    fieldSelector?: string,
  ) {
    const t = types().find((x) => x.kind === kind);
    if (!t) {
      setError(`${kind} is not served by this cluster`);
      return;
    }
    if (ns) {
      const st = tabCache.get(active()!);
      if (st) st.namespace = ns;
      setNamespace(ns);
    }
    await select(t, fieldSelector);
    // No exact query available for this pair: fall back to full-text.
    if (!fieldSelector) onRowFilterInput(term);
  }

  /// Pods on a node — an exact server-side query, not a text match.
  async function jumpToPodsOnNode(node: string) {
    const t = types().find((x) => x.group === "" && x.kind === "Pod");
    if (!t) return;
    await select(t, `spec.nodeName=${node}`);
  }

  async function refreshList() {
    const rt = selected();
    const ctx = active();
    if (!rt || !ctx) return;
    try {
      const ns = rt.namespaced && namespace() ? namespace() : null;
      const seq = ++listSeq;
      const chan = new Channel<{ rows: TableRow[]; done: boolean }>();
      chan.onmessage = (page) => {
        if (seq !== listSeq) return;
        setTable((prev) =>
          prev ? { ...prev, rows: [...prev.rows, ...page.rows] } : prev,
        );
        setStreaming(!page.done);
      };
      const t = await invoke<ResourceTable>("list_resources", {
        context: ctx,
        resource: rt,
        namespace: ns,
        fieldSelector: activeFieldSel(),
        channel: chan,
      });
      setStreaming(t.truncated);
      if (active() === ctx && selected() === rt) {
        setTable(t);
        void startWatch(
          ctx,
          rt,
          ns,
          activeFieldSel(),
          t.resource_version,
          t.include,
        );
        // indices into the old rows are meaningless now
        setMatched(null);
        if (rowFilter().trim()) onRowFilterInput(rowFilter());
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function fetchDetail(namespaceArg: string | null, name: string) {
    const rt = selected();
    const ctx = active();
    if (!rt || !ctx) return null;
    return invoke<ResourceDetail>("get_resource", {
      context: ctx,
      resource: rt,
      namespace: namespaceArg,
      name,
    });
  }

  // The action row only exists once the detail has loaded; paint the
  // cursor when it does.
  createEffect(() => {
    if (detail() && panelSec() === "actions") {
      const i = actionIdx();
      requestAnimationFrame(() => paintRowCursor("actions", i));
    }
  });

  /// The one way a detail panel opens — table click, keyboard, or a
  /// jump from another resource — so events and state never diverge.
  async function showDetail(namespace: string | null, name: string) {
    if (!selected() || !active()) return;
    const key = `${namespace ?? ""}/${name}`;
    setDetailKey(key);
    setDetail(null);
    setSecretShown(false); // secrets start hidden on every open
    setEvents([]);
    setActionMsg(null);
    setActionErr(null);
    setScaleInput("");
    setFindQ("");
    setPanelSec("actions");
    setActionIdx(0);
    setDetailLoading(true);
    try {
      const d = await fetchDetail(namespace, name);
      if (detailKey() !== key) return; // user moved on
      if (d) {
        setDetail(d);
        setYamlText(d.yaml);
      }
      // Events answer "why is this thing unhappy" — fetch them
      // alongside, but never let them block the panel.
      void invoke<EventInfo[]>("get_events", {
        context: active(),
        namespace,
        name,
        kind: selected()?.kind,
      })
        .then((ev) => {
          if (detailKey() === key) setEvents(ev);
        })
        .catch(() => {});
    } catch (e) {
      setError(String(e));
      closeDetail();
    } finally {
      if (detailKey() === key) setDetailLoading(false);
    }
  }

  const openDetail = (row: TableRow) => showDetail(row.namespace, row.name);

  async function reloadDetail() {
    const d = detail();
    if (!d) return;
    const key = `${d.namespace ?? ""}/${d.name}`;
    try {
      const nd = await fetchDetail(d.namespace, d.name);
      if (detailKey() !== key) return;
      if (nd) {
        setDetail(nd);
        setYamlText(nd.yaml);
      }
    } catch {
      /* object may be gone after delete */
    }
  }

  /// `e` / `y`: land straight in the manifest editor, opening the
  /// detail panel first when the user is still on the table.
  async function openYaml(row?: TableRow) {
    if (row && detailKey() !== `${row.namespace ?? ""}/${row.name}`) {
      await openDetail(row);
    }
    if (!detail()) return;
    // let the editor mount before focusing it
    setTimeout(() => yamlFind?.focus(), 0);
  }

  function closeDetail() {
    setDetail(null);
    setDetailKey(null);
    setActionMsg(null);
    setActionErr(null);
    setConfirm(null);
  }

  /// Apply one action across every marked row, reporting how it went
  /// rather than stopping at the first failure.
  async function runBatch(
    label: string,
    fn: (t: Target) => Promise<unknown>,
  ) {
    const targets = markedTargets();
    if (!targets.length) return;
    setActionBusy(label);
    setActionMsg(null);
    setActionErr(null);
    let ok = 0;
    const failed: string[] = [];
    for (const t of targets) {
      try {
        await fn(t);
        ok++;
      } catch (e) {
        failed.push(`${t.name}: ${String(e)}`);
      }
    }
    setActionBusy(null);
    setActionMsg(`${label}: ${ok} of ${targets.length} ✓`);
    if (failed.length) setActionErr(failed.slice(0, 5).join("\n"));
    setMarked(new Set<string>());
    await refreshList();
  }

  function confirmBatch(
    label: string,
    body: string,
    fn: (t: Target) => Promise<unknown>,
  ) {
    const n = markedTargets().length;
    if (!n) return;
    const names = markedTargets()
      .slice(0, 5)
      .map((t) => t.name)
      .join(", ");
    setDlgIdx(1);
    setConfirm({
      title: `${label} ${n} ${selected()?.kind}${n > 1 ? "s" : ""}?`,
      body: `${names}${n > 5 ? ` and ${n - 5} more` : ""}. ${body}`,
      label,
      danger: true,
      run: () => void runBatch(label.toLowerCase(), fn),
    });
  }

  /// Shared runner for every drawer action: busy state, error surface,
  /// list refresh, and either close (deletes) or detail reload.
  async function runAction(
    label: string,
    fn: () => Promise<unknown>,
    opts: { close?: boolean } = {},
  ) {
    setActionBusy(label);
    setActionMsg(null);
    setActionErr(null);
    try {
      const r = await fn();
      setActionMsg(typeof r === "string" && r ? r : `${label} ✓`);
      if (opts.close) {
        closeDetail();
        setActionMsg(null);
      } else {
        await reloadDetail();
      }
      await refreshList();
    } catch (e) {
      setActionErr(String(e));
    } finally {
      setActionBusy(null);
    }
  }

  /// Apply without force first. A conflict means another manager owns
  /// a field you changed (an HPA's replicas, a controller's template) —
  /// the user should decide to take it over, not discover it later.
  /// The starter manifest for a kind, or null if we don't offer create
  /// for it (no New button in that case).
  const templateFor = (rt: ResourceType | null) =>
    rt ? (NEW_TEMPLATES[typeKey(rt)] ?? null) : null;

  function openNew() {
    const rt = selected();
    const tpl = templateFor(rt);
    if (!rt || !tpl) return;
    setNewErr(null);
    setNewYaml(tpl);
    // Seed the namespace from the current filter, else "default".
    setNewNs(rt.namespaced ? namespace() || "default" : "");
    setNewSec("editor");
    setNewDlgIdx(1);
    setNewNsOpen(false);
    setNewOpen(true);
  }

  function createResource() {
    const rt = selected();
    const ctx = active();
    if (!rt || !ctx || newBusy()) return;
    setNewBusy(true);
    setNewErr(null);
    void invoke<string>("create_resource", {
      context: ctx,
      resource: rt,
      namespace: rt.namespaced ? newNs() || null : null,
      yaml: newYaml(),
    })
      .then(async (name) => {
        setNewBusy(false);
        setNewOpen(false);
        setActionMsg(`created ${rt.kind}/${name} ✓`);
        await refreshList();
      })
      .catch((e) => {
        setNewBusy(false);
        setNewErr(prettyError(String(e)));
      });
  }

  function applyYaml(force = false) {
    const rt = selected();
    const d = detail();
    const ctx = active();
    if (!rt || !d || !ctx) return;
    setActionBusy("apply");
    setActionMsg(null);
    setActionErr(null);
    void invoke("apply_resource", {
      context: ctx,
      resource: rt,
      namespace: d.namespace,
      name: d.name,
      yaml: yamlText(),
      resourceVersion: force ? null : d.resource_version,
      force,
    })
      .then(async () => {
        setActionBusy(null);
        setActionMsg("applied ✓");
        await reloadDetail();
        await refreshList();
      })
      .catch((e) => {
        setActionBusy(null);
        const msg = String(e);
        if (/conflict|409/i.test(msg) && !force) {
          setDlgIdx(0);
          setConfirm({
            title: "Another manager owns these fields",
            body: `${msg}\n\nApplying with force makes PigeonEye the owner of the conflicting fields. If a controller (an HPA, an operator) manages them, it may fight back or stop reconciling.`,
            label: "Force apply",
            danger: true,
            run: () => applyYaml(true),
          });
          return;
        }
        if (/modified|resourceVersion/i.test(msg) && !force) {
          setDlgIdx(0);
          setConfirm({
            title: "Changed on the server",
            body: `${msg}\n\nThis resource changed since the editor loaded it. Reload to see the current manifest, or force-apply to overwrite that change.`,
            label: "Force apply",
            danger: true,
            run: () => applyYaml(true),
          });
          return;
        }
        setActionErr(msg);
      });
  }

  const kindIs = (group: string, kind: string) => {
    const s = selected();
    return s?.group === group && s?.kind === kind;
  };
  const isNode = () => kindIs("", "Node");
  const isPod = () => kindIs("", "Pod");
  /// Events are an immutable log the API server writes — editing or
  /// deleting one is meaningless, so the panel is read-only for them.
  const isEvent = () => kindIs("", "Event");
  /// Events are an append-only log; everything else follows what the
  /// API server says it supports.
  const canEdit = () => !isEvent() && !!selected()?.editable;
  const scalable = () =>
    kindIs("apps", "Deployment") ||
    kindIs("apps", "StatefulSet") ||
    kindIs("apps", "ReplicaSet") ||
    // Argo Rollout has spec.replicas; the generic scale patch works.
    kindIs("argoproj.io", "Rollout");
  const restartable = () =>
    kindIs("apps", "Deployment") ||
    kindIs("apps", "StatefulSet") ||
    kindIs("apps", "DaemonSet");
  /// Kinds whose pods can be aggregated by selector for combined logs.
  const hasWorkloadLogs = () =>
    kindIs("apps", "Deployment") ||
    kindIs("apps", "StatefulSet") ||
    kindIs("apps", "DaemonSet") ||
    kindIs("apps", "ReplicaSet") ||
    kindIs("batch", "Job") ||
    kindIs("argoproj.io", "Rollout") ||
    kindIs("", "Service");

  function openWorkloadLogs(namespaceArg: string | null, name: string) {
    openShell({
      kind: "wlogs",
      context: active()!,
      namespace: namespaceArg ?? "default",
      name,
      resource: selected()!,
    });
  }

  // Essential panel: pinned categories resolved against what discovery found.
  const pinned = createMemo(() => {
    const byKey = new Map(types().map((t) => [typeKey(t), t]));
    return CATEGORIES.map(([name, kinds]) => ({
      name,
      types: kinds
        .map(([g, k]) => byKey.get(`${g}/${k}`))
        .filter((t): t is ResourceType => !!t),
    })).filter((c) => c.types.length > 0);
  });

  const pinnedKeys = createMemo(
    () => new Set(pinned().flatMap((c) => c.types.map(typeKey))),
  );

  // Every non-builtin group is someone's CRD — surface them all, always,
  // except a CRD we've pinned into a category above (e.g. Argo Rollout in
  // Workloads), so it doesn't also show under its raw group.
  const customGroups = createMemo(() => {
    const pk = pinnedKeys();
    const byGroup = new Map<string, ResourceType[]>();
    for (const t of types()) {
      if (isBuiltinGroup(t.group) || pk.has(typeKey(t))) continue;
      if (!byGroup.has(t.group)) byGroup.set(t.group, []);
      byGroup.get(t.group)!.push(t);
    }
    return [...byGroup.entries()];
  });

  // Builtins that didn't make the pinned cut, tucked under "More".
  const restGroups = createMemo(() => {
    const pk = pinnedKeys();
    const byGroup = new Map<string, ResourceType[]>();
    for (const t of types()) {
      if (!isBuiltinGroup(t.group) || pk.has(typeKey(t))) continue;
      const key = t.group || "core";
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(t);
    }
    return [...byGroup.entries()];
  });

  // Typing in the kind filter searches everything discovery returned.
  const filteredGroups = createMemo(() => {
    const f = filter().toLowerCase();
    const byGroup = new Map<string, ResourceType[]>();
    for (const t of types()) {
      if (f && !t.kind.toLowerCase().includes(f) && !t.group.includes(f))
        continue;
      const key = t.group || "core";
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(t);
    }
    return [...byGroup.entries()];
  });

  /// Exactly the kinds the sidebar is showing, in visual order, so the
  /// keyboard cursor and the rendering can never disagree.
  const sidebarItems = createMemo<ResourceType[]>(() => {
    if (filter()) return filteredGroups().flatMap(([, ts]) => ts);
    const out = pinned().flatMap((c) => c.types);
    for (const [group, ts] of customGroups()) {
      if (groupOpen(group)) out.push(...ts);
    }
    if (groupOpen("__more")) out.push(...restGroups().flatMap(([, ts]) => ts));
    return out;
  });

  function moveSidebar(delta: number) {
    const items = sidebarItems();
    if (!items.length) return;
    const next = Math.min(Math.max(sideIdx() + delta, 0), items.length - 1);
    setSideIdx(next);
    document
      .querySelector(`.kind[data-sk="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function enterSidebarItem() {
    const t = sidebarItems()[sideIdx()];
    if (!t) return;
    setPane("table");
    void select(t);
  }

  /// Display cells for every row, built once per list — not per
  /// keystroke. On a 24k-pod cluster rebuilding this while typing was
  /// what made search collapse.
  // TableRow → its built DisplayRow, so unchanged rows skip rebuilding.
  let dispCache = new Map<TableRow, DisplayRow>();
  let dispCacheStats: Map<string, PodStat> | Map<string, NodeStat> | null = null;
  const baseRows = createMemo(() => {
    const t = table();
    const rt = selected();
    if (!t || !rt) return { cols: [] as string[], rows: [] as DisplayRow[] };
    let cols = t.columns.map((c) => c.name);
    if (rt.namespaced) cols = [cols[0], "Namespace", ...cols.slice(1)];
    const stats = rt.group === "" && rt.kind === "Pod" ? podStats() : null;
    let statAt = -1;
    if (stats) {
      const ri = cols.findIndex((c) => /^restarts$/i.test(c));
      statAt = ri >= 0 ? ri + 1 : cols.length;
      cols = [...cols.slice(0, statAt), ...POD_STAT_COLS, ...cols.slice(statAt)];
    }
    const nodeView = rt.group === "" && rt.kind === "Node";
    const nstats = nodeView ? nodeStats() : null;
    if (nstats) cols = [...cols, ...NODE_STAT_COLS];
    if (nodeView) cols = [...cols, "AZ"];
    // One object identifies "the stats in play" for the row cache.
    const activeStats = stats ?? nstats;

    // Reuse the display row for any TableRow object that hasn't
    // changed identity — a watch flush replaces only touched rows, so
    // this rebuilds a handful instead of all 24k.
    const prev = dispCacheStats === activeStats ? dispCache : null;
    const rows: DisplayRow[] = t.rows.map((r) => {
      const hit = prev?.get(r);
      if (hit) return hit;
      let cells = r.cells.map((c) => String(c ?? ""));
      if (rt.namespaced) cells = [cells[0], r.namespace ?? "", ...cells.slice(1)];
      if (stats) {
        const st = stats.get(`${r.namespace ?? ""}/${r.name}`);
        const six = st
          ? [
              fmtCpu(st.cpu),
              pct(st.cpu, st.cpu_r),
              pct(st.cpu, st.cpu_l),
              fmtMem(st.mem),
              pct(st.mem, st.mem_r),
              pct(st.mem, st.mem_l),
            ]
          : ["-", "-", "-", "-", "-", "-"];
        cells = [...cells.slice(0, statAt), ...six, ...cells.slice(statAt)];
      }
      if (nstats) {
        const ns = nstats.get(r.name);
        cells = [
          ...cells,
          ns ? fmtCpu(ns.cpu) : "-",
          ns ? `${ns.cpu_pct}%` : "-",
          ns ? fmtMem(ns.mem) : "-",
          ns ? `${ns.mem_pct}%` : "-",
        ];
      }
      if (nodeView) cells = [...cells, zoneOf(r.labels)];
      const hay = (
        cells.join(" ") +
        " " +
        Object.entries(r.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      ).toLowerCase();
      return { row: r, cells, hay };
    });
    const next = new Map<TableRow, DisplayRow>();
    for (const d of rows) next.set(d.row, d);
    dispCache = next;
    dispCacheStats = activeStats;
    return { cols, rows };
  });

  /// Column widths follow the data, but sampling the first rows is
  /// enough — scanning 24k rows on every change is not.
  const colWidths = createMemo(() => {
    const b = baseRows();
    const sample = b.rows.slice(0, 600);
    return b.cols.map((c, i) => {
      let max = c.length + 2;
      for (const r of sample) {
        const len = r.cells[i]?.length ?? 0;
        if (len > max) max = len;
      }
      return Math.min(Math.max(max * 7.4 + 28, 76), 460);
    });
  });

  /// Filter, then sort, then drop hidden columns. Only this part runs
  /// per keystroke, and it works on already-built rows.
  const view = createMemo(() => {
    const b = baseRows();
    if (!b.rows.length && !b.cols.length)
      return {
        cols: [] as string[],
        allCols: [] as string[],
        rows: [] as DisplayRow[],
      };

    const raw = rowFilter().trim();
    let out: DisplayRow[];
    if (!raw) {
      out = b.rows;
    } else {
      // Query supports plain substrings, /regex/ tokens, and !negation.
      // A row survives if it matches on visible fields (name/namespace/
      // cells/labels) OR the backend full-text index (deep fields), then
      // must satisfy every regex and no negation. Backend hits arrive
      // keyed by namespace/name so they stay aligned through reordering.
      const { poss, res, negs } = parseQuery(raw);
      const extra = matched();
      const passExtra = (h: string) =>
        res.every((re) => re.test(h)) && !negs.some((n) => h.includes(n));
      const nameHit = (r: DisplayRow) =>
        poss.every((x) => r.row.name.toLowerCase().includes(x));
      const visibleHit = (r: DisplayRow) =>
        poss.every((x) => r.hay.includes(x)) && passExtra(r.hay);
      const deepHit = (r: DisplayRow) =>
        (extra?.has(rowKeyOf(r.row)) ?? false) && passExtra(r.hay);
      out = b.rows.filter((r) => visibleHit(r) || deepHit(r));
      // Rank by why it matched: name first, then other visible fields,
      // then deep-field-only hits (which the user can't see, so they'd
      // otherwise look like noise flooding out the real matches).
      const sc0 = sortCol();
      if (sc0 === null) {
        const rankOf = (r: DisplayRow) =>
          nameHit(r) ? 0 : visibleHit(r) ? 1 : 2;
        out = out
          .map((r, i) => [r, rankOf(r), i] as const)
          .sort((a, z) => a[1] - z[1] || a[2] - z[2])
          .map(([r]) => r);
      }
    }

    // Per-column value filters (AND across columns). Keyed by column
    // name; map to the cell index in the full (pre-hide) column list.
    const cfs = colFilters();
    const activeCF = Object.entries(cfs)
      .filter(([, s]) => s.size > 0)
      .map(([name, set]) => [b.cols.indexOf(name), set] as const)
      .filter(([ci]) => ci >= 0);
    if (activeCF.length) {
      out = out.filter((r) =>
        activeCF.every(([ci, set]) => set.has(r.cells[ci] ?? "")),
      );
    }
    // Numeric comparison filters (>, ≥, <, ≤, =). A cell with no number
    // (n/a, -) never satisfies a numeric filter.
    const activeNF = Object.entries(colNumFilters())
      .map(([name, f]) => [b.cols.indexOf(name), f] as const)
      .filter(([ci]) => ci >= 0);
    if (activeNF.length) {
      out = out.filter((r) =>
        activeNF.every(([ci, f]) => {
          const n = cellNum(r.cells[ci] ?? "");
          if (n === null) return false;
          return f.op === ">"
            ? n > f.val
            : f.op === ">="
              ? n >= f.val
              : f.op === "<"
                ? n < f.val
                : f.op === "<="
                  ? n <= f.val
                  : n === f.val;
        }),
      );
    }

    const sc = sortCol();
    if (sc !== null && sc >= 0 && sc < b.cols.length) {
      const dir = sortDir();
      out = [...out].sort(
        (x, y) => cmpCells(x.cells[sc] ?? "", y.cells[sc] ?? "") * dir,
      );
    } else if (isPod() && !namespace()) {
      // Default order for an all-namespaces pod list: sink DaemonSet pods
      // (ebs-csi-node, kube-proxy, log/metrics agents — one per node, so
      // thousands of them) to the bottom so the workloads you actually
      // care about sit on top. A real column sort overrides this.
      out = out
        .map((r, i) => [r, r.row.owner_kind === "DaemonSet" ? 1 : 0, i] as const)
        .sort((a, z) => a[1] - z[1] || a[2] - z[2])
        .map(([r]) => r);
    }

    const hide = hiddenFor();
    if (!hide.size) return { cols: b.cols, allCols: b.cols, rows: out };
    const keep = b.cols.map((c, i) => [c, i] as const).filter(([c]) => !hide.has(c));
    return {
      cols: keep.map(([c]) => c),
      allCols: b.cols,
      rows: out.map((r) => ({ ...r, cells: keep.map(([, i]) => r.cells[i]) })),
    };
  });

  /// Row count for the header badge — the filtered set lives in view().
  const rowCount = createMemo(() => view().rows.length);
  // DaemonSet pods in an all-namespaces pod list — shown in the badge so
  // it's clear why the count is huge and where those rows went (bottom).
  const dsCount = createMemo(() => {
    if (!isPod() || namespace()) return 0;
    let n = 0;
    for (const r of view().rows) if (r.row.owner_kind === "DaemonSet") n++;
    return n;
  });

  /// Final display model: server columns + injected Namespace, live
  /// metric columns for pods, AZ for nodes — then column sorting.
  // ── virtual table ──────────────────────────────────────
  // Rows are a fixed height so the window can be computed instead of
  // measured, and only what fits on screen is ever put in the DOM.
  const ROW_H = 26;
  const HEADER_H = 30;
  const OVERSCAN = 8;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);

  const windowRange = createMemo(() => {
    const total = view().rows.length;
    const first = Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
    const visible = Math.ceil(viewH() / ROW_H) + OVERSCAN * 2;
    return { first, last: Math.min(total, first + visible), total };
  });

  const windowRows = createMemo(() => {
    const { first, last } = windowRange();
    return view().rows.slice(first, last);
  });

  /// Keep the cursor row inside the viewport without needing it to be
  /// in the DOM.
  function scrollRowIntoView(idx: number) {
    const el = tableFocusRef;
    if (!el) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight - HEADER_H) {
      el.scrollTop = top + ROW_H - el.clientHeight + HEADER_H;
    }
  }

  function scrollColIntoView(i: number) {
    document
      .querySelector(`th[data-col="${i}"]`)
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  function moveCursor(delta: number) {
    const n = view().rows.length;
    if (!n) return;
    const next = Math.min(Math.max(cursor() + delta, 0), n - 1);
    setCursor(next);
    scrollRowIntoView(next);
  }

  function clickSort(i: number) {
    if (sortCol() === i) {
      if (sortDir() === 1) setSortDir(-1);
      else {
        setSortCol(null);
        setSortDir(1);
      }
    } else {
      setSortCol(i);
      setSortDir(1);
    }
  }

  // ── `:` command palette ────────────────────────────────
  interface CmdItem {
    label: string;
    hint: string;
    run: () => void;
  }

  const cmdItems = createMemo<CmdItem[]>(() => {
    const q = cmdText().trim().toLowerCase();
    if (q.startsWith("ns")) {
      const arg = q.slice(2).trim();
      const list = arg
        ? namespaces().filter((n) => n.includes(arg))
        : namespaces();
      return [
        ...(arg ? [] : [{ label: "ns (all)", hint: "clear namespace filter", run: () => pickNamespace("") }]),
        ...list.slice(0, 12).map((n) => ({
          label: `ns ${n}`,
          hint: "switch namespace",
          run: () => pickNamespace(n),
        })),
      ];
    }
    if (q.startsWith("ctx")) {
      const arg = q.slice(3).trim();
      return contexts()
        .filter((c) => !arg || c.name.toLowerCase().includes(arg))
        .slice(0, 12)
        .map((c) => ({
          label: `ctx ${c.name}`,
          hint: tabs().includes(c.name) ? "switch tab" : "connect",
          run: () => void openContext(c.name),
        }));
    }
    if (!q) {
      return [
        { label: "pods · deploy · svc · no …", hint: "type a resource kind", run: () => {} },
        { label: "ns <name>", hint: "switch namespace", run: () => setCmdText("ns ") },
        { label: "ctx <name>", hint: "switch cluster", run: () => setCmdText("ctx ") },
      ];
    }
    const byKey = new Map(types().map((t) => [typeKey(t).toLowerCase(), t]));
    const hits: ResourceType[] = [];
    const alias = KIND_ALIASES[q];
    if (alias) {
      const t = byKey.get(alias.toLowerCase());
      if (t) hits.push(t);
    }
    for (const t of types()) {
      if (hits.includes(t)) continue;
      if (t.kind.toLowerCase().startsWith(q)) hits.push(t);
    }
    for (const t of types()) {
      if (hits.includes(t)) continue;
      if (t.kind.toLowerCase().includes(q) || t.group.includes(q)) hits.push(t);
    }
    return hits.slice(0, 12).map((t) => ({
      label: t.kind,
      hint: t.group || "core",
      run: () => void select(t),
    }));
  });

  function runCmd(item: CmdItem | undefined) {
    if (!item) return;
    setCmdOpen(false);
    setCmdText("");
    item.run();
  }

  /// Shift-<letter> column sorting: A=age, N=name, S=status…
  const SORT_KEYS: Record<string, string[]> = {
    N: ["NAME"],
    A: ["AGE"],
    S: ["STATUS"],
    R: ["READY"],
    T: ["RESTARTS"],
    C: ["CPU"],
    M: ["MEM"],
    I: ["IP", "INTERNAL-IP"],
    O: ["NODE"],
  };

  function doCordon(target?: Target, unschedulable?: boolean) {
    const d = target ?? currentTarget();
    if (!d || !isNode()) return;
    const on = !(unschedulable ?? detail()?.unschedulable ?? false);
    void runAction(on ? "cordon" : "uncordon", () =>
      invoke("cordon_node", { context: active(), name: d.name, on }),
    );
  }

  function requestDrain(target?: Target) {
    const d = target ?? currentTarget();
    if (!d || !isNode()) return;
    setDlgIdx(1);
    setConfirm({
      title: `Drain node ${d.name}?`,
      body: "The node is cordoned, then every pod except DaemonSets and mirror pods is evicted (PodDisruptionBudgets respected).",
      label: "Drain node",
      danger: true,
      run: () =>
        void runAction("drain", () =>
          invoke<string>("drain_node", { context: active(), name: d.name }),
        ),
    });
  }

  function requestRestart(target?: Target) {
    const d = target ?? currentTarget();
    if (!d || !restartable()) return;
    setDlgIdx(1);
    setConfirm({
      title: `Restart rollout of ${d.name}?`,
      body: "Pods are replaced gradually, same as kubectl rollout restart.",
      label: "Restart",
      danger: false,
      run: () =>
        void runAction("restart", () =>
          invoke("restart_rollout", {
            context: active(),
            resource: selected(),
            namespace: d.namespace,
            name: d.name,
          }),
        ),
    });
  }

  const isCronJob = () => kindIs("batch", "CronJob");
  const isJob = () => kindIs("batch", "Job");
  const isArgoRollout = () => kindIs("argoproj.io", "Rollout");
  const suspendable = () => isCronJob() || isJob();

  function triggerCronJob(target?: Target) {
    const d = target ?? currentTarget();
    if (!d || !isCronJob()) return;
    setDlgIdx(1);
    setConfirm({
      title: `Trigger ${d.name} now?`,
      body: "Creates a one-off Job from the CronJob's template — like kubectl create job --from=cronjob.",
      label: "Trigger",
      danger: false,
      run: () =>
        void runAction("trigger", async () => {
          const jn = await invoke<string>("trigger_cronjob", {
            context: active(),
            namespace: d.namespace,
            name: d.name,
          });
          setActionMsg(`created ${jn} ✓`);
        }),
    });
  }

  function setSuspend(suspend: boolean, target?: Target) {
    const d = target ?? currentTarget();
    if (!d || !suspendable()) return;
    void runAction(suspend ? "suspend" : "resume", () =>
      invoke("patch_resource", {
        context: active(),
        resource: selected(),
        namespace: d.namespace,
        name: d.name,
        patch: { spec: { suspend } },
      }),
    );
  }

  function restartArgoRollout(target?: Target) {
    const d = target ?? currentTarget();
    if (!d || !isArgoRollout()) return;
    setDlgIdx(1);
    setConfirm({
      title: `Restart rollout ${d.name}?`,
      body: "Sets spec.restartAt so Argo Rollouts restarts every pod.",
      label: "Restart",
      danger: false,
      run: () =>
        void runAction("restart", () =>
          invoke("patch_resource", {
            context: active(),
            resource: selected(),
            namespace: d.namespace,
            name: d.name,
            patch: { spec: { restartAt: new Date().toISOString() } },
          }),
        ),
    });
  }

  interface Target {
    namespace: string | null;
    name: string;
  }

  /// The resource a command applies to: the open panel, or the row
  /// under the cursor when there is no panel.
  function currentTarget(): Target | null {
    const d = detail();
    if (d) return { namespace: d.namespace, name: d.name };
    const vr = view().rows[cursor()];
    return vr ? { namespace: vr.row.namespace, name: vr.row.name } : null;
  }

  function deleteMarked(force: boolean) {
    confirmBatch(
      force ? "Force delete" : "Delete",
      force
        ? "Grace period 0 — removed immediately. This cannot be undone."
        : "This cannot be undone.",
      (t) =>
        invoke("delete_resource", {
          context: active(),
          resource: selected(),
          namespace: t.namespace,
          name: t.name,
          force,
        }),
    );
  }

  function requestDelete(force: boolean, target?: Target) {
    const t = target ?? currentTarget();
    if (!t || !selected()) return;
    setDlgIdx(1);
    setConfirm({
      title: `${force ? "Force delete" : "Delete"} ${selected()?.kind}/${t.name}?`,
      body: force
        ? `Grace period 0 — ${t.name} is removed immediately, without waiting for a graceful shutdown. This cannot be undone.`
        : `${t.name}${t.namespace ? ` in ${t.namespace}` : ""} is deleted from ${active()} with the default grace period. This cannot be undone.`,
      label: force ? "Force delete" : "Delete",
      danger: true,
      run: () =>
        void runAction(
          force ? "force delete" : "delete",
          () =>
            invoke("delete_resource", {
              context: active(),
              resource: selected(),
              namespace: t.namespace,
              name: t.name,
              force,
            }),
          { close: true },
        ),
    });
  }

  function onGlobalKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    const typing = el?.closest("input, textarea, select, [contenteditable], .cm-editor, .xterm");
    // Launcher screen: arrows/Enter drive the context list no matter
    // where focus sits, so it's fully keyboard-first. Letters still fall
    // through to the search box (which filters via onInput).
    if (tabs().length === 0) {
      if (settingsOpen()) return;
      const list = pickerList();
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
        e.preventDefault();
        setPickerIdx(Math.min(pickerIdx() + 1, list.length - 1));
      } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
        e.preventDefault();
        setPickerIdx(Math.max(pickerIdx() - 1, 0));
      } else if (e.key === "Home") {
        e.preventDefault();
        setPickerIdx(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setPickerIdx(list.length - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const c = list[pickerIdx()];
        if (c) void openContext(c.name);
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    // Same escapes as inside xterm, for when focus sits elsewhere.
    if ((e.ctrlKey && e.key === "]") || (e.metaKey && e.key === "ArrowUp")) {
      e.preventDefault();
      leaveTerminal();
      return;
    }
    if (e.key === "Escape") {
      if (newOpen()) {
        // The editor's own Esc keymap blurred it and set nav mode; don't
        // also close on the same event.
        if (e.defaultPrevented) return;
        if (newNsOpen()) setNewNsOpen(false);
        else setNewOpen(false);
        return;
      }
      if (colMenu()) setColMenu(null);
      else if (colsOpen()) setColsOpen(false);
      else if (settingsOpen()) setSettingsOpen(false);
      else if (pickMode()) setPickMode(null);
      else if (scaleOpen()) setScaleOpen(false);
      else if (pfOpen()) setPfOpen(false);
      else if (helpOpen()) setHelpOpen(false);
      else if (cmdOpen()) setCmdOpen(false);
      else if (nsOpen()) setNsOpen(false);
      else if (confirm()) setConfirm(null);
      else if (typing) return;
      else if (marked().size) setMarked(new Set<string>());
      else if (detailKey()) closeDetail();
      else if (rowFilter().trim()) {
        setRowFilter("");
        setMatched(null);
      } else if (pane() === "table") {
        // one level up: the sidebar owns the arrow keys again
        setPane("sidebar");
        const i = sidebarItems().findIndex((t) => t === selected());
        if (i >= 0) setSideIdx(i);
      } else popHistory();
      return;
    }
    // The New dialog owns the keyboard while open. ⌘/Ctrl+↵ always
    // creates. The manifest editor and namespace search handle their own
    // keys (typing is true there); everything else is section navigation.
    if (newOpen()) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        createResource();
        return;
      }
      // While the namespace dropdown or the editor holds focus, leave the
      // keys to them.
      if (newNsOpen() || typing) return;
      // Nav mode: ↑/↓ move between namespace → editor → actions.
      const secs = newSections();
      const i = secs.indexOf(newSec());
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        if (i > 0) setNewSec(secs[i - 1]);
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        if (i < secs.length - 1) setNewSec(secs[i + 1]);
      } else if (
        newSec() === "actions" &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        setNewDlgIdx(e.key === "ArrowLeft" ? 0 : 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Activate the focused section.
        if (newSec() === "namespace") {
          setNewNsQuery("");
          setNewNsOpen(true);
        } else if (newSec() === "editor") {
          newEditorApi?.focus();
        } else if (newDlgIdx() === 1) createResource();
        else setNewOpen(false);
      }
      return;
    }
    // Any open dialog owns the keyboard completely: keys must never
    // reach the table behind it (pressing `c` behind a drain confirm
    // used to cordon a node with no prompt).
    if (pickMode()) {
      const list = pickList();
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setPickIdx(Math.min(pickIdx() + 1, list.length - 1));
        return;
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setPickIdx(Math.max(pickIdx() - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const c = list[pickIdx()];
        if (c) startPodSession(pickMode()!, pickTarget()!, list, c);
      }
      return;
    }
    // Any open popup owns the keyboard: keys must never reach the table
    // behind it (else ⌘D would delete the row under a column menu).
    if (helpOpen() || scaleOpen() || pfOpen() || colsOpen() || settingsOpen())
      return;
    // The per-column filter menu has its own keyboard nav below; block the
    // table only for keys it doesn't handle. Numeric columns use their own
    // focused input, so only categorical (value-list) columns navigate here.
    if (colMenu()) {
      if (colIsNumeric(colMenu()!)) return;
      const vals = colMenuValues();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = vals.length;
        if (n) {
          const cur = colMenuIdx();
          setColMenuIdx(
            e.key === "ArrowDown"
              ? cur < 0
                ? 0
                : Math.min(cur + 1, n - 1)
              : Math.max((cur < 0 ? 0 : cur) - 1, 0),
          );
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const v = vals[colMenuIdx()];
        if (v) toggleColValue(colMenu()!, v[0]);
      }
      return;
    }

    // An open dialog owns the keyboard: arrows pick a button, Enter
    // runs the picked one.
    if (confirm()) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setDlgIdx(e.key === "ArrowRight" ? 1 : 0);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setDlgIdx(dlgIdx() === 1 ? 0 : 1);
        return;
      }
      if (e.key === "Enter" && !typing) {
        e.preventDefault();
        const c = confirm()!;
        setConfirm(null);
        if (dlgIdx() === 1) c.run();
      }
      return; // nothing else may act while a confirm is up
    }
    if (typing) return;
    if (e.key === "?") {
      e.preventDefault();
      setHelpOpen(!helpOpen());
      return;
    }
    // ⌘W closes whatever is in front: the focused shell, else the
    // open detail, else the current cluster tab. ⇧⌘W always targets
    // the shell. The window itself never closes on ⌘W — the menu
    // entry is removed in Rust — so tabs are never lost by accident.
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyW") {
      e.preventDefault();
      const k = activeShell();
      if (e.shiftKey) {
        if (k != null) closeShell(k);
      } else if (termFocused() && k != null) {
        closeShell(k);
      } else if (detailKey()) {
        closeDetail();
      } else if (active()) {
        closeTab(active()!);
      }
      return;
    }
    // ⌘T / Ctrl+T: show/hide the terminal dock, sessions keep running.
    if ((e.metaKey || e.ctrlKey) && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      if (shells().length) {
        if (termMin()) {
          setTermMin(false);
          requestAnimationFrame(focusTerminal);
        } else if (!termFocused()) {
          focusTerminal();
        } else {
          setTermMin(true);
          leaveTerminal();
        }
      }
      return;
    }
    // Tab / Shift+Tab cycle cluster tabs — nothing else in the app
    // wants Tab once focus is out of a text field.
    if (e.key === "Tab") {
      // Always swallow it: letting the browser walk focus drops the
      // cursor onto a sidebar kind, which then reacts to Enter.
      e.preventDefault();
      const list = tabs();
      if (list.length > 1) {
        const i = list.indexOf(active() ?? "");
        const next = (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
        activate(list[next]);
      }
      return;
    }
    // Ctrl+1..9: switch cluster tab. Alt+1..9: switch terminal tab.
    if ((e.ctrlKey || e.altKey) && /^Digit[1-9]$/.test(e.code)) {
      const i = Number(e.code.slice(5)) - 1;
      if (e.altKey) {
        const sh = shells()[i];
        if (sh) {
          e.preventDefault();
          setTermMin(false);
          setActiveShell(sh.k);
        }
      } else {
        const t = tabs()[i];
        if (t) {
          e.preventDefault();
          activate(t);
        }
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      if (detailKey()) focusFind();
      else rowSearchRef?.focus();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.code === "Digit0") {
      e.preventDefault();
      pickNamespace("");
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      setSettingsOpen(!settingsOpen());
      return;
    }
    // Shift+/ focuses the sidebar kind filter (/ is the row search).
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
      e.preventDefault();
      kindFilterRef?.focus();
      return;
    }
    // The sidebar is the top of the hierarchy: when it has focus the
    // arrows walk kinds and Enter drops into the table.
    if (pane() === "sidebar" && !detailKey()) {
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveSidebar(1);
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSidebar(-1);
        return;
      }
      if (e.key === "g") {
        e.preventDefault();
        moveSidebar(-sidebarItems().length);
        return;
      }
      if (e.key === "G") {
        e.preventDefault();
        moveSidebar(sidebarItems().length);
        return;
      }
      if (e.key === "Enter" || e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        enterSidebarItem();
        return;
      }
      // typing a kind name is the fastest way through a long sidebar
      if (e.key === "/") {
        e.preventDefault();
        kindFilterRef?.focus();
        return;
      }
    }

    // With a detail open, keys drive the panel: scrolling, folds and
    // every action button. Shift+J/K steps rows without leaving it.
    if (detailKey() && detail()) {
      const d = detail()!;
      const body = drawerBodyRef;
      const scroll = (dy: number) => body?.scrollBy({ top: dy, behavior: "auto" });
      if (!e.shiftKey && (e.key === "j" || e.key === "ArrowDown")) {
        e.preventDefault();
        movePanel(1);
        return;
      }
      if (!e.shiftKey && (e.key === "k" || e.key === "ArrowUp")) {
        e.preventDefault();
        movePanel(-1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (BUTTON_ROWS[panelSec()]) pressRowButton();
        else activatePanelSection();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (BUTTON_ROWS[panelSec()]) {
          e.preventDefault();
          moveWithinRow(e.key === "ArrowRight" ? 1 : -1);
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          closeDetail();
          return;
        }
      }
      if (e.key === "h") {
        e.preventDefault();
        closeDetail();
        return;
      }
      if (e.key === "PageDown" || (e.ctrlKey && e.key === "d")) {
        e.preventDefault();
        scroll((body?.clientHeight ?? 400) * 0.9);
        return;
      }
      if (e.key === "PageUp" || (e.ctrlKey && e.key === "u")) {
        e.preventDefault();
        scroll(-(body?.clientHeight ?? 400) * 0.9);
        return;
      }
      if (e.key === "g") {
        e.preventDefault();
        movePanel(-panelSections().length);
        body?.scrollTo({ top: 0 });
        return;
      }
      if (e.key === "G") {
        e.preventDefault();
        movePanel(panelSections().length);
        return;
      }
      // Step through rows with the panel following along.
      if (e.key === "J" || e.key === "K") {
        e.preventDefault();
        moveCursor(e.key === "J" ? 1 : -1);
        const vr = view().rows[cursor()];
        if (vr) void openDetail(vr.row);
        return;
      }
      if (e.key === "a" && Object.keys(d.annotations).length) {
        e.preventDefault();
        if (annoFoldRef) annoFoldRef.open = !annoFoldRef.open;
        return;
      }
      if (e.key === "v" && events().length) {
        e.preventDefault();
        if (eventFoldRef) eventFoldRef.open = !eventFoldRef.open;
        return;
      }
      if (e.key === "t" && d.status != null) {
        e.preventDefault();
        if (statusFoldRef) statusFoldRef.open = !statusFoldRef.open;
        return;
      }
      if (e.key === "c" && isNode()) {
        e.preventDefault();
        doCordon();
        return;
      }
      if (e.key === "D" && isNode()) {
        e.preventDefault();
        requestDrain();
        return;
      }
      if (e.key === "r" && restartable()) {
        e.preventDefault();
        requestRestart();
        return;
      }
      if (e.key === "X" && (isPod() || isNode())) {
        e.preventDefault();
        requestDelete(true);
        return;
      }
      if (e.key === "p") {
        // pod: jump to its node; node: list its pods
        if (isNode()) {
          e.preventDefault();
          void jumpToPodsOnNode(d.name);
          return;
        }
        if (isPod() && d.node_name) {
          e.preventDefault();
          void jumpToNode(d.node_name);
          return;
        }
      }
      if (e.key === "F" && isPod()) {
        e.preventDefault();
        setPfPort(String(d.ports[0] ?? ""));
        setPfOpen(true);
        return;
      }
      if (e.key === "n" && scalable()) {
        e.preventDefault();
        openScale();
        return;
      }
      if (e.key === "s" && (isPod() || isNode())) {
        e.preventDefault();
        if (isPod()) openPodSession("pod");
        else openShell({ kind: "node", context: active()!, name: d.name });
        return;
      }
      if (e.key === "l" && (isPod() || hasWorkloadLogs())) {
        e.preventDefault();
        if (isPod()) openPodSession("logs");
        else openWorkloadLogs(d.namespace, d.name);
        return;
      }
      if (e.key === "d" && !isEvent() && selected()!.deletable) {
        e.preventDefault();
        requestDelete(false);
        return;
      }
      if (e.key === "p" && isEvent() && d.involved) {
        e.preventDefault();
        void jumpToInvolved();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        focusFind();
        return;
      }
      if (e.key === "e" || e.key === "y") {
        e.preventDefault();
        void openYaml();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyC") {
        // only when the user has not selected text themselves
        if (!window.getSelection()?.toString()) {
          e.preventDefault();
          void copyManifest();
        }
        return;
      }
    }
    // Shift+←/→ walks the column cursor, Shift+↑/↓ sets the direction.
    if (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const n = view().cols.length;
      if (n) {
        e.preventDefault();
        const cur = sortCol();
        const step = e.key === "ArrowRight" ? 1 : -1;
        const next = cur === null ? (step > 0 ? 0 : n - 1) : (cur + step + n) % n;
        setSortCol(next);
        scrollColIntoView(next);
      }
      return;
    }
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (sortCol() === null && view().cols.length) setSortCol(0);
      if (sortCol() !== null) {
        e.preventDefault();
        setSortDir(e.key === "ArrowUp" ? 1 : -1);
        scrollColIntoView(sortCol()!);
      }
      return;
    }
    // Shift-letter sorting on whatever columns the current view has.
    if (SORT_KEYS[e.key]) {
      const wanted = SORT_KEYS[e.key];
      const idx = view().cols.findIndex((c) => wanted.includes(c.toUpperCase()));
      if (idx >= 0) {
        e.preventDefault();
        clickSort(idx);
        return;
      }
    }
    // A focused button/link (e.g. the + New button reached by Tab)
    // activates on Enter/Space itself — don't let the table hijack those
    // to open a row detail or toggle a mark.
    if (
      (e.key === "Enter" || e.key === " ") &&
      el?.closest("button, a, [role=button]")
    ) {
      return;
    }
    if (e.key === ":") {
      e.preventDefault();
      setCmdText("");
      setCmdIdx(0);
      setCmdOpen(true);
    } else if (e.key === "/") {
      e.preventDefault();
      rowSearchRef?.focus();
    } else if (e.key === "n" && templateFor(selected())) {
      // `n` = New, from the list, when this kind is creatable.
      e.preventDefault();
      openNew();
    } else if (e.key === "f" && view().cols.length) {
      // `f` = filter the sorted column (or the first column) by keyboard.
      e.preventDefault();
      const ci = sortCol() ?? 0;
      const name = view().cols[ci];
      if (name) {
        const th = tableFocusRef?.querySelector(`th[data-col="${ci}"]`);
        const r = th?.getBoundingClientRect();
        setColMenuAt(r ? { x: r.left, y: r.bottom + 4 } : { x: 220, y: 130 });
        setColMenuQ("");
        setColMenuIdx(-1);
        setColMenu(name);
      }
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      moveCursor(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      // Past the top row, step up into the header: focus the search box
      // (Tab from there reaches + New) — the list's parent level.
      if (cursor() <= 0) rowSearchRef?.focus();
      else moveCursor(-1);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
      // Destructive commands work straight off the list; both variants
      // go through the confirmation dialog.
      if (!selected()?.deletable || isEvent()) return;
      e.preventDefault();
      if (marked().size) {
        deleteMarked(e.shiftKey);
        return;
      }
      const vr = view().rows[cursor()];
      if (vr) {
        requestDelete(e.shiftKey, {
          namespace: vr.row.namespace,
          name: vr.row.name,
        });
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) {
      const vr = view().rows[cursor()];
      if (vr && restartable()) {
        e.preventDefault();
        requestRestart({ namespace: vr.row.namespace, name: vr.row.name });
      }
    } else if (e.key === "c" && isNode()) {
      const vr = view().rows[cursor()];
      if (vr) {
        e.preventDefault();
        // cells carry "Ready,SchedulingDisabled" when cordoned
        const cordoned = vr.cells.some((c) => c.includes("SchedulingDisabled"));
        doCordon({ namespace: null, name: vr.row.name }, cordoned);
      }
    } else if (e.key === "D" && isNode()) {
      const vr = view().rows[cursor()];
      if (vr) {
        e.preventDefault();
        requestDrain({ namespace: null, name: vr.row.name });
      }
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // wide tables get cut off; pan them without a mouse
      e.preventDefault();
      tableFocusRef?.scrollBy({
        left: e.key === "ArrowRight" ? 260 : -260,
        behavior: "auto",
      });
    } else if (e.key === "Home") {
      e.preventDefault();
      tableFocusRef?.scrollTo({ left: 0 });
    } else if (e.key === "End") {
      e.preventDefault();
      tableFocusRef?.scrollTo({ left: tableFocusRef.scrollWidth });
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveCursor(15);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveCursor(-15);
    } else if (e.key === "g") {
      moveCursor(-view().rows.length);
    } else if (e.key === "G") {
      moveCursor(view().rows.length);
    } else if (e.key === " ") {
      const vr = view().rows[cursor()];
      if (vr) {
        e.preventDefault();
        toggleMark(vr.row);
      }
    } else if ((e.metaKey || e.ctrlKey) && e.code === "KeyA") {
      e.preventDefault();
      setMarked(new Set(view().rows.map((vr) => rowKeyOf(vr.row))));
    } else if (e.key === "Enter") {
      const vr = view().rows[cursor()];
      if (vr) {
        e.preventDefault();
        if (kindIs("", "Namespace")) void enterNamespace(vr.row.name);
        else void openDetail(vr.row);
      }
    } else if (e.key === "l") {
      const vr = view().rows[cursor()];
      if (!vr) return;
      if (isPod()) void openPodSessionForRow("logs", vr.row);
      else if (hasWorkloadLogs())
        openWorkloadLogs(vr.row.namespace, vr.row.name);
    } else if (e.key === "e" || e.key === "y") {
      const vr = view().rows[cursor()];
      if (vr) {
        e.preventDefault();
        void openYaml(vr.row);
      }
    } else if (e.key === "s") {
      const vr = view().rows[cursor()];
      if (vr && isPod()) void openPodSessionForRow("pod", vr.row);
      else if (vr && isNode())
        openShell({ kind: "node", context: active()!, name: vr.row.name });
    }
  }

  // WebKit shows an inline prediction / autofill bubble over text
  // inputs; the attribute that disables it isn't in Solid's JSX types,
  // so stamp it on every input as it appears.
  let suggestObserver: MutationObserver | undefined;
  onMount(() => {
    const mark = (el: Element) => {
      el.setAttribute("writingsuggestions", "false");
      el.setAttribute("autocomplete", "off");
    };
    document.querySelectorAll("input, textarea").forEach(mark);
    // Only look at nodes that were actually added — a full-document
    // scan on every mutation runs continuously while a log streams.
    suggestObserver = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement)
            mark(n);
          else n.querySelectorAll?.("input, textarea").forEach(mark);
        }
      }
    });
    suggestObserver.observe(document.body, { childList: true, subtree: true });
  });
  onCleanup(() => suggestObserver?.disconnect());

  onMount(() => document.addEventListener("keydown", onGlobalKey));
  onCleanup(() => {
    document.removeEventListener("keydown", onGlobalKey);
    stopWatch();
  });

  const kindButton = (t: ResourceType) => (
    <button
      class="kind"
      data-sk={sidebarItems().indexOf(t)}
      classList={{
        active: selected() === t,
        cursor: pane() === "sidebar" && sidebarItems()[sideIdx()] === t,
      }}
      onClick={() => {
        setPane("table");
        setSideIdx(Math.max(sidebarItems().indexOf(t), 0));
        select(t);
      }}
    >
      {t.kind}
      <Show when={!t.namespaced}>
        <span class="scope" title="cluster-scoped (not namespaced)">
          C
        </span>
      </Show>
    </button>
  );

  const actionBtn = (
    label: string,
    onClick: () => void,
    opts: { danger?: boolean } = {},
  ) => (
    <button
      class="btn sm"
      classList={{ danger: !!opts.danger }}
      disabled={actionBusy() !== null}
      onClick={onClick}
    >
      {actionBusy() === label ? `${label}…` : label}
    </button>
  );

  const settingsPanel = () => (
        <div class="settings">
          <div class="settings-head">
            <span class="section-title">Kubeconfig files</span>
            <button class="close" onClick={() => setSettingsOpen(false)}>
              ✕
            </button>
          </div>
          <p class="settings-note">
            No entries = default chain ($KUBECONFIG or ~/.kube/config).
            Added files are merged; contexts remember their source file.
          </p>
          <For each={kubeconfigs()}>
            {(p) => (
              <div class="settings-row">
                <span class="meta-val">{p}</span>
                <button
                  class="tab-close"
                  onClick={() =>
                    saveKubeconfigs(kubeconfigs().filter((x) => x !== p))
                  }
                >
                  ✕
                </button>
              </div>
            )}
          </For>
          <div class="section-title" style={{ "margin-top": "14px" }}>
            Shell
          </div>
          <p class="settings-note">
            Pod shell defaults to kubectl-exec with bash→sh fallback.
          </p>
          <div class="settings-grid">
            <span class="meta-key">pod shell command</span>
            <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
              class="search grow"
              placeholder="command -v bash >/dev/null && exec bash || exec sh"
              value={shellCfg().podCommand ?? ""}
              onInput={(e) => saveShellCfg({ podCommand: e.currentTarget.value })}
            />
            <span class="meta-key">node shell name</span>
            <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
              class="search grow"
              placeholder="pigeoneye-node-shell (a unique suffix is added)"
              value={shellCfg().nodeName ?? ""}
              onInput={(e) => saveShellCfg({ nodeName: e.currentTarget.value })}
            />
            <span class="meta-key">node shell image</span>
            <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
              class="search grow"
              placeholder="busybox:1.36"
              value={shellCfg().nodeImage ?? ""}
              onInput={(e) => saveShellCfg({ nodeImage: e.currentTarget.value })}
            />
            <span class="meta-key">node shell namespace</span>
            <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
              class="search grow"
              placeholder="kube-system"
              value={shellCfg().nodeNamespace ?? ""}
              onInput={(e) =>
                saveShellCfg({ nodeNamespace: e.currentTarget.value })
              }
            />
            <span class="meta-key">cpu / memory limits</span>
            <span>
              <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                class="search scale"
                placeholder="200m"
                value={shellCfg().nodeCpu ?? ""}
                onInput={(e) => saveShellCfg({ nodeCpu: e.currentTarget.value })}
              />{" "}
              <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                class="search scale"
                placeholder="300Mi"
                value={shellCfg().nodeMem ?? ""}
                onInput={(e) => saveShellCfg({ nodeMem: e.currentTarget.value })}
              />
            </span>
          </div>
          {/* Transparency: exactly what a node shell does. */}
          <div class="node-shell-info">
            <div class="nsi-title">What “node shell” runs</div>
            <p>
              Creates a Pod{" "}
              <code>{(shellCfg().nodeName?.trim() || "pigeoneye-node-shell") + "-⟨id⟩"}</code>{" "}
              in <code>{shellCfg().nodeNamespace?.trim() || "kube-system"}</code>,
              pinned to the node, image{" "}
              <code>{shellCfg().nodeImage?.trim() || "busybox:1.36"}</code>.
            </p>
            <div class="nsi-perms">
              <span class="nsi-tag">privileged</span>
              <span class="nsi-tag">hostPID</span>
              <span class="nsi-tag">hostIPC</span>
              <span class="nsi-tag">hostNetwork</span>
              <span class="nsi-tag">tolerations: all</span>
              <span class="nsi-tag">auto-delete 4h</span>
            </div>
            <p>Then execs into the host's namespaces (PID 1):</p>
            <code class="nsi-cmd">
              nsenter -t 1 -m -u -i -n -p -- sh -c "bash || sh"
            </code>
            <p class="dim">
              The helper Pod is deleted when you close the session. It needs
              privileged + hostPID; if your cluster forbids that (PSA/OPA),
              the shell won't start.
            </p>
          </div>
          <div class="section-title" style={{ "margin-top": "14px" }}>
            Add kubeconfig
          </div>
          <div class="settings-add">
            <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
              class="search grow"
              placeholder="~/.kube/other-config"
              value={newPath()}
              onInput={(e) => setNewPath(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newPath().trim()) {
                  saveKubeconfigs([...kubeconfigs(), newPath().trim()]);
                  setNewPath("");
                }
              }}
            />
            <button
              class="btn"
              disabled={!newPath().trim()}
              onClick={() => {
                saveKubeconfigs([...kubeconfigs(), newPath().trim()]);
                setNewPath("");
              }}
            >
              Add
            </button>
            <button
              class="btn"
              onClick={async () => {
                const f = await openFileDialog({
                  multiple: false,
                  title: "Select kubeconfig file",
                });
                if (typeof f === "string" && !kubeconfigs().includes(f)) {
                  saveKubeconfigs([...kubeconfigs(), f]);
                }
              }}
            >
              Browse…
            </button>
          </div>
        </div>
  );

  const launcher = () => (
    <div class="launcher">
      <img class="mascot" src={lookUrl} alt="" />
      <h1>PigeonEye</h1>
      <p class="dim">pick a cluster context to connect</p>
      <Show when={error()}>
        <div class="launcher-error">
          <p class="empty-error">{prettyError(error()!)}</p>
          <Show when={authHint()?.can_login}>
            <div class="auth-actions">
              <button
                class="btn primary"
                disabled={loggingIn()}
                onClick={() => void runLogin()}
              >
                {loggingIn()
                  ? "logging in…"
                  : authHint()!.kind === "aws-sso"
                    ? `Log in with SSO${authHint()!.context ? ` (${authHint()!.context})` : ""}`
                    : "Log in"}
              </button>
              <Show when={authHint()!.command}>
                <code class="auth-cmd">{authHint()!.command}</code>
              </Show>
            </div>
          </Show>
          <details class="error-detail">
            <summary>show details</summary>
            <pre>{error()}</pre>
          </details>
        </div>
      </Show>
      <input
        class="search launcher-search"
        placeholder="search contexts…"
        ref={(el) => setTimeout(() => el.focus())}
        value={pickerQ()}
        onInput={(e) => {
          setPickerQ(e.currentTarget.value);
          setPickerIdx(0);
        }}
      />
      <div class="launcher-list">
        <For each={pickerList()}>
          {(c, i) => (
            <button
              class="launcher-item"
              classList={{ active: pickerIdx() === i() }}
              disabled={connecting() !== null}
              onMouseEnter={() => setPickerIdx(i())}
              onClick={() => void openContext(c.name)}
            >
              <span class="launcher-name">{c.name}</span>
              <span class="dim">
                {connecting() === c.name
                  ? "connecting…"
                  : [
                      c.is_current ? "current" : "",
                      lastSession.includes(c.name) ? "recent" : "",
                      c.source ? basename(c.source) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
            </button>
          )}
        </For>
        <Show when={pickerList().length === 0}>
          <p class="dim">no contexts found in your kubeconfig</p>
        </Show>
      </div>
      <button class="btn" onClick={() => setSettingsOpen(true)}>
        ⚙ kubeconfig files
      </button>
      <Show when={settingsOpen()}>{settingsPanel()}</Show>
    </div>
  );

  return (
    <Show when={tabs().length > 0} fallback={launcher()}>
    <div class="shell">
      <header class="topbar">
        <img class="logo-img" src={logoUrl} alt="PigeonEye" />
        <span class="logo">PigeonEye</span>
        <div class="tabs">
          <For each={tabs()}>
            {(name) => (
              <div
                class="tab"
                classList={{ active: active() === name }}
                onClick={() => active() !== name && activate(name)}
              >
                <span class="tab-name">{name}</span>
                <button
                  class="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(name);
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
        <select
          class="ctx"
          disabled={connecting() !== null}
          value=""
          onChange={(e) => {
            const v = e.currentTarget.value;
            e.currentTarget.value = "";
            if (v) void openContext(v);
          }}
        >
          <option value="">
            {connecting() ? `connecting ${connecting()}…` : "+ add context"}
          </option>
          <For each={contexts().filter((c) => !tabs().includes(c.name))}>
            {(c) => (
              <option value={c.name}>
                {c.name}
                {c.is_current ? " (current)" : ""}
                {c.source ? ` — ${basename(c.source)}` : ""}
              </option>
            )}
          </For>
        </select>
        <Show when={active()}>
          <div class="ns-picker">
            <button
              class="ctx ns-btn"
              onClick={() => {
                setNsOpen(!nsOpen());
                setNsQuery("");
              }}
            >
              {namespace() || "all namespaces"} <span class="dim">▾</span>
            </button>
            <Show when={nsOpen()}>
              <div class="ns-backdrop" onClick={() => setNsOpen(false)} />
              <div class="ns-pop">
                <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                  class="search"
                  placeholder="search namespaces…"
                  ref={(el) => setTimeout(() => el.focus())}
                  value={nsQuery()}
                  onInput={(e) => setNsQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setNsOpen(false);
                    if (e.key === "Enter") {
                      const q = nsQuery().toLowerCase().trim();
                      const list = nsFiltered();
                      // "all" is a real choice, so it wins when typed
                      if (q && "all namespaces".startsWith(q)) pickNamespace("");
                      else if (list.length) pickNamespace(list[0]);
                      else if (!q) pickNamespace("");
                    }
                  }}
                />
                <div class="ns-list">
                  <Show
                    when={
                      !nsQuery().trim() ||
                      "all namespaces".includes(nsQuery().toLowerCase().trim())
                    }
                  >
                    <button
                      class="ns-item"
                      classList={{ active: namespace() === "" }}
                      onClick={() => pickNamespace("")}
                    >
                      all namespaces
                    </button>
                  </Show>
                  <For each={nsFiltered()}>
                    {(n) => (
                      <button
                        class="ns-item"
                        classList={{ active: namespace() === n }}
                        onClick={() => pickNamespace(n)}
                      >
                        {n}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Show>
        <span class="badge">
          <Show when={active()}>{types().length} kinds</Show>
        </span>
        <button
          class="icon-btn"
          title="toggle theme"
          onClick={() => setTheme(theme() === "dark" ? "light" : "dark")}
        >
          {theme() === "dark" ? "☀" : "🌙"}
        </button>
        <button
          class="icon-btn"
          title="settings"
          onClick={() => setSettingsOpen(!settingsOpen())}
        >
          ⚙
        </button>
      </header>

      <Show when={settingsOpen()}>{settingsPanel()}</Show>

      <Show when={error()}>
        <div class="error">
          <div class="error-body">
            <Show
              when={authHint()?.can_login}
              fallback={
                <details class="error-detail">
                  <summary>{prettyError(error()!)}</summary>
                  <pre>{error()}</pre>
                </details>
              }
            >
              {/* the login card below carries the explanation */}
              <span>{authHint()!.message}</span>
            </Show>
          </div>
          <Show when={authHint()?.can_login}>
            <div class="auth-login">
              <div class="auth-actions">
                <button
                  class="btn primary"
                  disabled={loggingIn()}
                  onClick={() => void runLogin()}
                >
                  {loggingIn()
                    ? "logging in…"
                    : authHint()!.kind === "aws-sso"
                      ? "Log in with SSO"
                      : "Log in"}
                </button>
                <Show when={authHint()!.command}>
                  <code class="auth-cmd" title="the command that runs">
                    {authHint()!.command}
                  </code>
                </Show>
              </div>
            </div>
          </Show>
          <div class="error-actions">
            <For each={failed().length ? failed().map((f) => f.name) : active() ? [active()!] : []}>
              {(name) => (
                <button
                  class="btn sm"
                  disabled={connecting() !== null}
                  onClick={() => void reconnect(name)}
                >
                  {connecting() === name ? "reconnecting…" : `reconnect ${name}`}
                </button>
              )}
            </For>
            <button class="close" onClick={() => setError(null)}>
              ✕
            </button>
          </div>
        </div>
      </Show>

      <div class="body">
        <aside class="sidebar" classList={{ collapsed: !sidebarOpen() }}>
          <div class="sidebar-head">
            <button
              class="collapse-btn"
              title={sidebarOpen() ? "collapse sidebar (⌘B)" : "expand sidebar (⌘B)"}
              onClick={toggleSidebar}
            >
              {sidebarOpen() ? "◀" : "▶"}
            </button>
            <Show when={sidebarOpen()}>
              <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                class="search"
                placeholder="filter kinds…  ⌘K"
                ref={(el) => (kindFilterRef = el)}
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape")
                    e.currentTarget.blur();
                }}
              />
            </Show>
          </div>
          <div class="tree">
            <Show when={forwards().length > 0}>
              <div class="group pf-group">
                <div class="group-name section pf-head">
                  Port forwards ({forwards().length})
                  <button
                    class="pf-stop-all"
                    title="stop all forwards"
                    onClick={() => forwards().forEach((f) => pfStop(f.id))}
                  >
                    stop all
                  </button>
                </div>
                <For each={forwards()}>
                  {(f) => (
                    <div class="pf-row">
                      <button
                        class="pf-link"
                        title={`open http://localhost:${f.local} — ${f.context}`}
                        onClick={() => void openUrl(`http://localhost:${f.local}`)}
                      >
                        <span class="pf-dot" />
                        <span class="pf-local">:{f.local}</span>
                        <span class="pf-target">
                          {f.pod}:{f.remote}
                        </span>
                      </button>
                      <button
                        class="tab-close"
                        title="stop this forward"
                        onClick={() => pfStop(f.id)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show
              when={!filter()}
              fallback={
                <For each={filteredGroups()}>
                  {([group, ts]) => (
                    <div class="group">
                      <div class="group-name">{group}</div>
                      <For each={ts}>{kindButton}</For>
                    </div>
                  )}
                </For>
              }
            >
              <For each={pinned()}>
                {(cat) => (
                  <div class="group">
                    <div class="group-name">{cat.name}</div>
                    <For each={cat.types}>{kindButton}</For>
                  </div>
                )}
              </For>
              <Show when={customGroups().length > 0}>
                <div class="group-name section">
                  Custom Resources (
                  {customGroups().reduce((n, [, ts]) => n + ts.length, 0)})
                </div>
                <For each={customGroups()}>
                  {([group, ts]) => (
                    <div class="crd-group" classList={{ open: groupOpen(group) }}>
                      <button
                        class="group-name sub grp-toggle"
                        onClick={() => toggleGroup(group)}
                      >
                        {group}
                        <span class="grp-count">{ts.length}</span>
                      </button>
                      <Show when={groupOpen(group)}>
                        <For each={ts}>{kindButton}</For>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
              <div class="crd-group" classList={{ open: groupOpen("__more") }}>
                <button
                  class="group-name section grp-toggle"
                  onClick={() => toggleGroup("__more")}
                >
                  More ({restGroups().reduce((n, [, ts]) => n + ts.length, 0)})
                </button>
                <Show when={groupOpen("__more")}>
                  <For each={restGroups()}>
                    {([group, ts]) => (
                      <div class="group">
                        <div class="group-name sub">{group}</div>
                        <For each={ts}>{kindButton}</For>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
        </aside>

        <main
          class="content"
          onClick={() => detailKey() && closeDetail()}
        >
          <Show
            when={selected()}
            fallback={
              <div class="empty">
                <img class="mascot" src={lookUrl} alt="" />
                <Show when={error() && !active()}>
                  <p class="empty-error">{error()}</p>
                </Show>
                <Show
                  when={contexts().length > 0}
                  fallback={
                    <>
                      <p>no kubeconfig contexts found</p>
                      <button
                        class="btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSettingsOpen(true);
                        }}
                      >
                        Add kubeconfig file
                      </button>
                    </>
                  }
                >
                  <p>
                    {active()
                      ? "pick a resource type from the sidebar"
                      : "add a cluster context to get started"}
                  </p>
                </Show>
              </div>
            }
          >
            <div class="content-head">
              <h2>
                {selected()!.kind}
                <span class="gv">
                  {selected()!.group || "core"}/{selected()!.version}
                </span>
              </h2>
              <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                class="search wide"
                placeholder="search name, labels, any field value…  ( / )"
                ref={(el) => (rowSearchRef = el)}
                value={rowFilter()}
                onClick={(e) => e.stopPropagation()}
                onInput={(e) => onRowFilterInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape")
                    e.currentTarget.blur();
                  // ArrowDown drops focus back into the list — the search
                  // box is the header level above the rows.
                  else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    e.currentTarget.blur();
                    tableFocusRef?.focus();
                    setCursor(0);
                  }
                }}
              />
              <Show when={activeFieldSel()}>
                <span class="fieldsel" title={activeFieldSel() ?? ""}>
                  {activeFieldSel()!.replace(/^label:/, "")}
                  <button
                    class="tab-close"
                    title="clear this filter"
                    onClick={() => void select(selected()!)}
                  >
                    ✕
                  </button>
                </span>
              </Show>
              <Show when={templateFor(selected())}>
                <button
                  class="btn sm primary"
                  title="create a new resource from a starter manifest"
                  onClick={openNew}
                >
                  + New
                </button>
              </Show>
              <Show when={table()}>
                <Show when={kindIs("", "Namespace") && namespace()}>
                  <button
                    class="btn sm"
                    title="show every namespace again (⌘0)"
                    onClick={() => pickNamespace("")}
                  >
                    all namespaces
                  </button>
                </Show>
                <div class="cols-picker">
                  <button
                    class="btn sm"
                    title="choose columns"
                    onClick={() => setColsOpen(!colsOpen())}
                  >
                    columns
                    <Show when={hiddenFor().size > 0}>
                      <span class="dim"> −{hiddenFor().size}</span>
                    </Show>
                  </button>
                  <Show when={colsOpen()}>
                    <div class="ns-backdrop" onClick={() => setColsOpen(false)} />
                    <div class="cols-pop">
                      <div class="cols-head">
                        <span class="section-title">Columns</span>
                        <button class="btn sm" onClick={resetCols}>
                          reset
                        </button>
                      </div>
                      <For each={view().allCols}>
                        {(c) => (
                          <button class="ns-item" onClick={() => toggleCol(c)}>
                            <span
                              class="mark-box"
                              classList={{ on: !hiddenFor().has(c) }}
                            />
                            {c}
                            <Show when={widePriority().has(c)}>
                              <span
                                class="wide-tag"
                                title="the API marks this wide-only: it is empty for most objects"
                              >
                                wide
                              </span>
                            </Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <span class="badge">
                  <Show when={indexing()}>
                    <span class="dim">indexing… </span>
                  </Show>
                  <Show when={live()}>
                    <span class="live-dot" title="live: updates arrive as they happen" />
                  </Show>
                  {rowCount()} {selected()?.plural ?? "items"}
                  <Show when={dsCount() > 0}>
                    <span class="dim" title="DaemonSet pods (one per node) are sorted to the bottom">
                      {" · "}
                      {dsCount()} daemonset
                    </span>
                  </Show>
                  <Show when={streaming()}>
                    <span class="dim loading-more">
                      <span class="badge-spin" />
                      loading {selected()?.plural ?? "more"}…
                    </span>
                  </Show>
                </span>
              </Show>
            </div>
            <Show when={marked().size > 0}>
              <div class="mark-bar">
                <span class="mark-count">
                  {markedTargets().length} selected
                  <Show when={markedTargets().length !== marked().size}>
                    <span class="dim"> ({marked().size} marked, rest filtered out)</span>
                  </Show>
                </span>
                <Show when={selected()!.deletable && !isEvent()}>
                  <button
                    class="btn sm danger"
                    disabled={actionBusy() !== null}
                    onClick={() => deleteMarked(false)}
                  >
                    delete
                  </button>
                  <Show when={isPod() || isNode()}>
                    <button
                      class="btn sm danger"
                      disabled={actionBusy() !== null}
                      onClick={() => deleteMarked(true)}
                    >
                      force delete
                    </button>
                  </Show>
                </Show>
                <Show when={restartable()}>
                  <button
                    class="btn sm"
                    disabled={actionBusy() !== null}
                    onClick={() =>
                      confirmBatch("Restart", "Pods are replaced gradually.", (t) =>
                        invoke("restart_rollout", {
                          context: active(),
                          resource: selected(),
                          namespace: t.namespace,
                          name: t.name,
                        }),
                      )
                    }
                  >
                    restart
                  </button>
                </Show>
                <Show when={isNode()}>
                  <button
                    class="btn sm"
                    disabled={actionBusy() !== null}
                    onClick={() =>
                      confirmBatch("Cordon", "New pods stop scheduling here.", (t) =>
                        invoke("cordon_node", {
                          context: active(),
                          name: t.name,
                          on: true,
                        }),
                      )
                    }
                  >
                    cordon
                  </button>
                  <button
                    class="btn sm danger"
                    disabled={actionBusy() !== null}
                    onClick={() =>
                      confirmBatch(
                        "Drain",
                        "Each node is cordoned and its pods evicted.",
                        (t) => invoke("drain_node", { context: active(), name: t.name }),
                      )
                    }
                  >
                    drain
                  </button>
                </Show>
                <span class="mark-hint">space marks · ⌘A all · esc clear</span>
                <Show when={actionBusy()}>
                  <span class="dim">{actionBusy()}…</span>
                </Show>
                <Show when={actionMsg()}>
                  <span class="apply-ok">{actionMsg()}</span>
                </Show>
                <button
                  class="tab-close"
                  onClick={() => setMarked(new Set<string>())}
                >
                  ✕
                </button>
              </div>
            </Show>
            <Show
              when={!loading()}
              fallback={
                <div class="empty">
                  <img class="mascot sm loading-bird" src={flyingUrl} alt="" />
                  <span class="ring-spinner" />
                  <p>loading…</p>
                </div>
              }
            >
              <Show
                when={rowCount() > 0}
                fallback={
                  <Show
                    when={indexing() && rowFilter().trim()}
                    fallback={
                      <div class="empty">
                        <img class="mascot tilt" src={puzzledUrl} alt="" />
                        <p>
                          No resources found.
                          <Show when={rowFilter().trim()}>
                            {" "}
                            Try a different filter.
                          </Show>
                        </p>
                      </div>
                    }
                  >
                    {/* Still building the deep index (annotations, env,
                        spec): we haven't finished looking, so this is
                        "searching", not "empty". */}
                    <div class="empty">
                      <img class="mascot sm loading-bird" src={lookUrl} alt="" />
                      <span class="ring-spinner" />
                      <p>Searching every field for “{rowFilter().trim()}”…</p>
                    </div>
                  </Show>
                }
              >
                <div
                  class="table-wrap"
                  tabindex="-1"
                  ref={(el) => {
                    tableFocusRef = el;
                    setViewH(el.clientHeight || 600);
                    tableRO?.disconnect();
                    tableRO = new ResizeObserver(() => {
                      // a detached element reports 0; ignore it or the
                      // window collapses to the overscan size
                      const h = el.clientHeight;
                      if (h > 0) setViewH(h);
                    });
                    tableRO.observe(el);
                  }}
                  onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                >
                  <table>
                    <colgroup>
                      <For each={colWidths()}>
                        {(w) => <col style={{ width: `${w}px` }} />}
                      </For>
                    </colgroup>
                    <thead>
                      <tr>
                        <For each={view().cols}>
                          {(c, i) => (
                            <th
                              class="sortable"
                              data-col={i()}
                              classList={{ sorted: sortCol() === i() }}
                            >
                              <span
                                class="th-text"
                                onClick={() => clickSort(i())}
                              >
                                {c}
                              </span>
                              <span
                                class="sort-ind"
                                onClick={() => clickSort(i())}
                              >
                                {sortCol() === i()
                                  ? sortDir() === 1
                                    ? "▲"
                                    : "▼"
                                  : ""}
                              </span>
                              <button
                                class="col-filt-btn"
                                classList={{ on: colHasFilter(c) }}
                                title="filter this column"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (colMenu() === c) {
                                    setColMenu(null);
                                    return;
                                  }
                                  const r =
                                    e.currentTarget.getBoundingClientRect();
                                  setColMenuAt({ x: r.left, y: r.bottom + 4 });
                                  setColMenuQ("");
                                  setColMenuIdx(-1);
                                  setColMenu(c);
                                }}
                              >
                                ⏷
                              </button>
                            </th>
                          )}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      {/* spacers stand in for the rows above and below
                          the window, so the scrollbar stays honest */}
                      <Show when={windowRange().first > 0}>
                        <tr
                          class="spacer"
                          style={{ height: `${windowRange().first * ROW_H}px` }}
                        />
                      </Show>
                      <For each={windowRows()}>
                        {(vr, k) => (
                          <tr
                            class="row"
                            data-idx={windowRange().first + k()}
                            classList={{
                              cursor: cursor() === windowRange().first + k(),
                              marked: marked().has(rowKeyOf(vr.row)),
                              selected:
                                detailKey() ===
                                `${vr.row.namespace ?? ""}/${vr.row.name}`,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setCursor(windowRange().first + k());
                              if (kindIs("", "Namespace"))
                                void enterNamespace(vr.row.name);
                              else void openDetail(vr.row);
                            }}
                          >
                            <For each={vr.cells}>
                              {(cell, i) => (
                                <td
                                  class={
                                    i() === 0 ? "cell name" : cellClass(cell)
                                  }
                                >
                                  <Show when={i() === 0}>
                                    <span
                                      class="mark-box"
                                      classList={{
                                        on: marked().has(rowKeyOf(vr.row)),
                                      }}
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        toggleMark(vr.row);
                                      }}
                                    />
                                    <For
                                      each={
                                        openSessions().get(
                                          `${vr.row.namespace ?? ""}/${vr.row.name}`,
                                        ) ?? []
                                      }
                                    >
                                      {(kind) => (
                                        <span
                                          class="sess-dot"
                                          classList={{ logs: kind !== "pod" && kind !== "node" }}
                                          title={
                                            kind === "logs" || kind === "wlogs"
                                              ? "log stream open"
                                              : "shell open"
                                          }
                                        />
                                      )}
                                    </For>
                                  </Show>
                                  <Show
                                    when={
                                      isPod() &&
                                      view().cols[i()] === "Node" &&
                                      cell &&
                                      cell !== "<none>"
                                    }
                                    fallback={cell}
                                  >
                                    <button
                                      class="cell-link"
                                      title="go to node"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void jumpToNode(cell);
                                      }}
                                    >
                                      {cell}
                                    </button>
                                  </Show>
                                </td>
                              )}
                            </For>
                          </tr>
                        )}
                      </For>
                      <Show when={windowRange().last < windowRange().total}>
                        <tr
                          class="spacer"
                          style={{
                            height: `${(windowRange().total - windowRange().last) * ROW_H}px`,
                          }}
                        />
                      </Show>
                    </tbody>
                  </table>
                </div>
              </Show>
            </Show>
          </Show>

          <Show when={detailKey()}>
            <div class="drawer" onClick={(e) => e.stopPropagation()}>
              <div class="drawer-head">
                <h3>
                  <span class="gv">{selected()?.kind}</span>{" "}
                  {detail()?.name ?? detailKey()?.split("/").pop()}
                  <Show when={detail()?.unschedulable}>
                    <span class="chip warn-chip">cordoned</span>
                  </Show>
                </h3>
                <span class="drawer-hint">
                  <kbd class="key">?</kbd> shortcuts
                </span>
                <button class="close" onClick={closeDetail}>
                  ✕
                </button>
              </div>
              <Show
                when={!detailLoading() && detail()}
                fallback={<div class="empty">loading…</div>}
              >
                <div class="actions psec" data-sec="actions" classList={{ cur: panelSec() === "actions" }}>
                  <Show when={isPod()}>
                    {actionBtn("shell", () => openPodSession("pod"))}
                    {actionBtn("logs", () => openPodSession("logs"))}
                    {actionBtn("forward", () => {
                      setPfPort(String(detail()!.ports[0] ?? ""));
                      setPfOpen(true);
                    })}
                    <For each={podForwards()}>
                      {(f) => (
                        <span class="pf-chip-inline">
                          <button
                            class="cell-link"
                            title="open in browser"
                            onClick={() =>
                              void openUrl(`http://localhost:${f.local}`)
                            }
                          >
                            :{f.local}→{f.remote}
                          </button>
                          <button
                            class="tab-close"
                            title="stop this forward"
                            onClick={() => pfStop(f.id)}
                          >
                            ✕
                          </button>
                        </span>
                      )}
                    </For>
                  </Show>
                  <Show when={isNode()}>
                    {actionBtn("pods →", () =>
                      void jumpToPodsOnNode(detail()!.name),
                    )}
                    {actionBtn("shell", () =>
                      openShell({
                        kind: "node",
                        context: active()!,
                        name: detail()!.name,
                      }),
                    )}
                    {actionBtn(
                      detail()!.unschedulable ? "uncordon" : "cordon",
                      () => doCordon(),
                    )}
                    {actionBtn("drain", () => requestDrain(), { danger: true })}
                  </Show>
                  <Show when={hasWorkloadLogs() && !isPod()}>
                    {actionBtn("logs", () =>
                      openWorkloadLogs(detail()!.namespace, detail()!.name),
                    )}
                  </Show>
                  <Show when={scalable()}>
                    {actionBtn("scale", () => openScale())}
                  </Show>
                  <Show when={restartable()}>
                    {actionBtn("restart", () => requestRestart())}
                  </Show>
                  <Show when={isArgoRollout()}>
                    {actionBtn("restart", () => restartArgoRollout())}
                  </Show>
                  <Show when={isCronJob()}>
                    {actionBtn("trigger", () => triggerCronJob())}
                  </Show>
                  <Show when={suspendable()}>
                    {actionBtn("suspend", () => setSuspend(true))}
                    {actionBtn("resume", () => setSuspend(false))}
                  </Show>
                  <Show when={isEvent() && detail()!.involved}>
                    {actionBtn(
                      `${detail()!.involved!.kind.toLowerCase()} →`,
                      () => void jumpToInvolved(),
                    )}
                  </Show>
                  <span class="act-group links">
                  <Show when={detail()!.has_pod_selector && !isPod()}>
                    {actionBtn("pods →", () => void jumpToSelectedPods())}
                  </Show>
                  <For each={USED_BY[selected()!.kind] ?? []}>
                    {(u) => (
                      <Show when={types().some((t) => t.kind === u.kind)}>
                        {actionBtn(u.label, () =>
                          void jumpToKindFiltered(
                            u.kind,
                            detail()!.name,
                            detail()!.namespace,
                            u.field?.(detail()!.name),
                          ),
                        )}
                      </Show>
                    )}
                  </For>
                  </span>
                  <span class="act-group danger-group">
                  <Show when={kindIs("apiextensions.k8s.io", "CustomResourceDefinition")}>
                    {actionBtn("instances →", () => {
                      // "widgets.example.com" → the Widget list
                      const [plural, ...rest] = detail()!.name.split(".");
                      const group = rest.join(".");
                      const t = types().find(
                        (x) => x.plural === plural && x.group === group,
                      );
                      if (t) void select(t);
                      else setError(`no served resource for ${detail()!.name}`);
                    })}
                  </Show>
                  <For each={detail()!.links}>
                    {(l) => (
                      <Show when={types().some((t) => t.kind === l.kind)}>
                        {actionBtn(`${l.kind.toLowerCase()} →`, () =>
                          void jumpToRef(l),
                        )}
                      </Show>
                    )}
                  </For>
                  <Show when={!isEvent() && selected()!.deletable}>
                  {actionBtn(
                    "delete",
                    () =>
                      setConfirm({
                        title: `Delete ${selected()?.kind}/${detail()!.name}?`,
                        body: `Deleted from ${active()} with default grace period. This cannot be undone.`,
                        label: "Delete",
                        danger: true,
                        run: () =>
                          void runAction(
                            "delete",
                            () =>
                              invoke("delete_resource", {
                                context: active(),
                                resource: selected(),
                                namespace: detail()!.namespace,
                                name: detail()!.name,
                                force: false,
                              }),
                            { close: true },
                          ),
                      }),
                    { danger: true },
                  )}
                  </Show>
                  <Show when={(isPod() || isNode()) && selected()!.deletable}>
                    {actionBtn(
                      "force delete",
                      () =>
                        setConfirm({
                          title: `Force delete ${selected()?.kind}/${detail()!.name}?`,
                          body: "Grace period 0 — the object is removed immediately without waiting for graceful shutdown.",
                          label: "Force delete",
                          danger: true,
                          run: () =>
                            void runAction(
                              "force delete",
                              () =>
                                invoke("delete_resource", {
                                  context: active(),
                                  resource: selected(),
                                  namespace: detail()!.namespace,
                                  name: detail()!.name,
                                  force: true,
                                }),
                              { close: true },
                            ),
                        }),
                      { danger: true },
                    )}
                  </Show>
                  </span>
                  <Show when={actionMsg()}>
                    <span class="apply-ok">{actionMsg()}</span>
                  </Show>
                </div>
                <Show when={actionErr()}>
                  <div class="apply-err">{actionErr()}</div>
                </Show>
                <div class="drawer-body" ref={(el) => (drawerBodyRef = el)}>
                  <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                    class="search drawer-find"
                    placeholder="find…"
                    ref={(el) => (findInputRef = el)}
                    value={findQ()}
                    onInput={(e) => setFindQ(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") yamlFind?.next();
                      if (e.key === "Escape") {
                        setFindQ("");
                        e.currentTarget.blur();
                      }
                    }}
                  />
                  <div class="psec" data-sec="meta" classList={{ cur: panelSec() === "meta" }}>
                  <div class="meta-grid">
                    <Show when={detail()!.namespace}>
                      <span class="meta-key">namespace</span>
                      <span class="meta-val">{detail()!.namespace}</span>
                    </Show>
                    <span class="meta-key">age</span>
                    <span class="meta-val">
                      {age(detail()!.created)}
                      <span class="dim"> · {detail()!.created}</span>
                    </span>
                  </div>
                  </div>

                  <Show when={(detail()!.secret_data?.length ?? 0) > 0}>
                    <div class="psec">
                      <div class="section-title">
                        Data
                        <button
                          class="btn sm"
                          onClick={() => setSecretShown(!secretShown())}
                        >
                          {secretShown() ? "hide" : "reveal"}
                        </button>
                        <span class="dim"> — base64-decoded</span>
                      </div>
                      <div class="secret-data">
                        <For each={detail()!.secret_data}>
                          {([k, v]) => (
                            <div class="secret-row">
                              <span class="secret-key">{k}</span>
                              <span class="secret-val">
                                {secretShown() ? v : "•".repeat(Math.min(v.length, 24))}
                              </span>
                              <button
                                class="btn sm"
                                title="copy the decoded value"
                                onClick={() =>
                                  void navigator.clipboard.writeText(v)
                                }
                              >
                                copy
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <Show when={Object.keys(detail()!.labels).length > 0}>
                    <div class="psec" data-sec="labels" classList={{ cur: panelSec() === "labels" }}>
                    <div class="section-title">Labels</div>
                    <div class="chips">
                      <For each={Object.entries(detail()!.labels)}>
                        {([k, v]) => (
                          <span
                            class="chip"
                            classList={{ hl: findMatches(`${k}=${v}`) }}
                          >
                            {k}={v}
                          </span>
                        )}
                      </For>
                    </div>
                    </div>
                  </Show>

                  <Show when={Object.keys(detail()!.annotations).length > 0}>
                    <div class="psec" data-sec="anno" classList={{ cur: panelSec() === "anno" }}>
                    <details
                      class="fold"
                      ref={(el) => (annoFoldRef = el)}
                      open={findMatches(
                        Object.entries(detail()!.annotations)
                          .map(([k, v]) => `${k}=${v}`)
                          .join("\n"),
                      )}
                    >
                      <summary class="section-title">
                        Annotations ({Object.keys(detail()!.annotations).length})
                      </summary>
                      <div class="anno-list">
                        <For each={Object.entries(detail()!.annotations)}>
                          {([k, v]) => (
                            <div
                              class="anno"
                              classList={{ hl: findMatches(`${k}=${v}`) }}
                            >
                              <span class="meta-key">{k}</span>
                              <span class="meta-val">{v}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                    </div>
                  </Show>

                  <Show when={detail()!.status != null}>
                    <div class="psec" data-sec="status" classList={{ cur: panelSec() === "status" }}>
                    <details
                      class="fold"
                      ref={(el) => (statusFoldRef = el)}
                      open={
                        !!findQ().trim() &&
                        subtreeMatches(detail()!.status, findQ().toLowerCase().trim())
                      }
                    >
                      <summary class="section-title">
                        Status (live)
                      </summary>
                      <StatusView value={detail()!.status} />
                    </details>
                    </div>
                  </Show>

                  <Show when={events().length > 0}>
                    <div
                      class="psec"
                      data-sec="events"
                      classList={{ cur: panelSec() === "events" }}
                    >
                      <details
                        class="fold"
                        ref={(el) => (eventFoldRef = el)}
                        open={
                          events().some((e) => e.type_ === "Warning") ||
                          findMatches(
                            events().map((e) => `${e.reason} ${e.message}`).join("\n"),
                          )
                        }
                      >
                        <summary class="section-title">
                          Events ({events().length})
                          <Show when={events().some((e) => e.type_ === "Warning")}>
                            <span class="ev-warnbadge">
                              {events().filter((e) => e.type_ === "Warning").length}{" "}
                              warning
                            </span>
                          </Show>
                        </summary>
                        <div class="ev-list">
                          <For each={events()}>
                            {(ev) => (
                              <div
                                class="ev"
                                classList={{
                                  warn: ev.type_ === "Warning",
                                  hl: findMatches(`${ev.reason} ${ev.message}`),
                                }}
                              >
                                <div class="ev-head">
                                  <span class="ev-reason">{ev.reason}</span>
                                  <span
                                    class="dim"
                                    title={
                                      ev.count > 1
                                        ? `seen ${ev.count} times, last ${age(ev.last)} ago`
                                        : undefined
                                    }
                                  >
                                    {age(ev.last)}
                                    {ev.count > 1 ? ` · ${ev.count} times` : ""}
                                    {ev.source ? ` · ${ev.source}` : ""}
                                  </span>
                                </div>
                                <div class="ev-msg">{ev.message}</div>
                              </div>
                            )}
                          </For>
                        </div>
                      </details>
                    </div>
                  </Show>

                  <div class="psec" data-sec="yaml" classList={{ cur: panelSec() === "yaml" }}>
                  <div class="section-title yaml-head">
                    Manifest
                    <button
                      class="btn sm copy-btn"
                      title="copy the manifest to the clipboard"
                      onClick={() => copyManifest()}
                    >
                      {copied() ? "copied ✓" : "copy"}
                    </button>
                    <span class="dim">
                      {canEdit()
                        ? " — desired state, editable"
                        : isEvent()
                          ? " — read-only record"
                          : " — read-only"}
                    </span>
                  </div>
                  <YamlEditor
                    value={yamlText()}
                    theme={theme()}
                    query={findQ()}
                    api={(a) => (yamlFind = a)}
                    readOnly={!canEdit()}
                    onChange={setYamlText}
                    onLeave={() => setPanelSec("yaml")}
                    onFind={focusFind}
                  />
                  <Show when={canEdit()}>
                  <div class="yaml-actions psec" data-sec="apply" classList={{ cur: panelSec() === "apply" }}>
                    <button
                      class="btn primary"
                      disabled={
                        actionBusy() !== null || yamlText() === detail()!.yaml
                      }
                      onClick={() => {
                        setDlgIdx(1);
                        setConfirm({
                          title: "Apply changes?",
                          body: `Patches ${selected()?.kind}/${detail()!.name}${detail()!.namespace ? ` in ${detail()!.namespace}` : ""} on ${active()} via server-side apply.`,
                          label: "Apply to cluster",
                          danger: false,
                          run: () => applyYaml(),
                        });
                      }}
                    >
                      {actionBusy() === "apply" ? "applying…" : "Apply"}
                    </button>
                    <button
                      class="btn"
                      disabled={
                        actionBusy() !== null || yamlText() === detail()!.yaml
                      }
                      onClick={() => setYamlText(detail()!.yaml)}
                    >
                      Reset
                    </button>
                  </div>
                  </Show>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          <Show when={shells().length > 0 && !termMin()}>
            <div
              class="term-panel"
              classList={{ focused: termFocused() }}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="term-head">
                <div class="term-tabs">
                  <For each={shells()}>
                    {(sh) => (
                      <div
                        class="term-tab"
                        classList={{
                          active: activeShell() === sh.k,
                          exited: shellStatus().get(sh.k) === "exited",
                        }}
                        onClick={() => setActiveShell(sh.k)}
                      >
                        <span class="term-dot" />
                        <span class="term-tab-name">
                          {sh.target.kind === "node" ? "node:" : ""}
                          {sh.target.name}
                          {sh.target.container ? `:${sh.target.container}` : ""}
                        </span>
                        <button
                          class="tab-close"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeShell(sh.k);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </For>
                </div>
                <span class="term-hint">
                  {termFocused()
                    ? "esc leave · ⇧tab next · ⇧⌘W close · ⌘T hide"
                    : "⌘T or click to type here"}
                </span>
                <button
                  class="btn sm"
                  title="back to the resource table"
                  onClick={leaveTerminal}
                >
                  ↩ table
                </button>
                <button
                  class="close"
                  title="minimize — sessions stay open"
                  onClick={() => {
                    setTermMin(true);
                    leaveTerminal();
                  }}
                >
                  ▾
                </button>
              </div>
              <div class="term-bodies">
                <For each={shells()}>
                  {(sh) => (
                    <TerminalPanel
                      target={sh.target}
                      theme={theme()}
                      active={activeShell() === sh.k}
                      onExit={() => markShellExited(sh.k)}
                      onLeave={leaveTerminal}
                      onMinimize={() => {
                        setTermMin(true);
                        leaveTerminal();
                      }}
                      onFocusChange={(f) =>
                        activeShell() === sh.k && setTermFocused(f)
                      }
                      onCycleTab={cycleShell}
                      onCloseTab={() => closeShell(sh.k)}
                      api={(a) => termApis.set(sh.k, a)}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={cmdOpen()}>
            <div class="modal-backdrop top" onClick={() => setCmdOpen(false)}>
              <div class="cmd" onClick={(e) => e.stopPropagation()}>
                <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                  class="cmd-input"
                  placeholder=":pods · deploy · rollout · ns kube-system · ctx dev"
                  ref={(el) => setTimeout(() => el.focus())}
                  value={cmdText()}
                  onInput={(e) => {
                    setCmdText(e.currentTarget.value);
                    setCmdIdx(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      runCmd(cmdItems()[cmdIdx()] ?? cmdItems()[0]);
                    else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setCmdIdx(Math.min(cmdIdx() + 1, cmdItems().length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setCmdIdx(Math.max(cmdIdx() - 1, 0));
                    } else if (e.key === "Escape") setCmdOpen(false);
                  }}
                />
                <div class="cmd-list">
                  <For each={cmdItems()}>
                    {(item, i) => (
                      <button
                        class="cmd-item"
                        classList={{ active: cmdIdx() === i() }}
                        onMouseEnter={() => setCmdIdx(i())}
                        onClick={() => runCmd(item)}
                      >
                        <span>{item.label}</span>
                        <span class="dim">{item.hint}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Show>

          <Show when={shells().length > 0 && termMin()}>
            <button
              class="term-restore"
              onClick={(e) => {
                e.stopPropagation();
                setTermMin(false);
              }}
            >
              ▴ terminals
              <span class="term-restore-count">{shells().length}</span>
              <span class="dim">
                {shells()
                  .map((sh) => sh.target.name)
                  .join(", ")
                  .slice(0, 60)}
              </span>
            </button>
          </Show>

          <Show when={pickMode()}>
            <div class="modal-backdrop" onClick={() => setPickMode(null)}>
              <div class="modal" onClick={(e) => e.stopPropagation()}>
                <h3>
                  {pickMode() === "logs" ? "Logs" : "Shell"} —{" "}
                  {pickTarget()?.name}
                </h3>
                <p>This pod runs several containers. Pick one.</p>
                <div class="pick-list">
                  <For each={pickList()}>
                    {(c, i) => (
                      <button
                        class="pick-item"
                        classList={{ active: pickIdx() === i() }}
                        onMouseEnter={() => setPickIdx(i())}
                        onClick={() =>
                          startPodSession(
                            pickMode()!,
                            pickTarget()!,
                            pickList(),
                            c,
                          )
                        }
                      >
                        {c}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Show>

          <Show when={scaleOpen()}>
            <div class="modal-backdrop" onClick={() => setScaleOpen(false)}>
              <div class="modal" onClick={(e) => e.stopPropagation()}>
                <h3>Scale {detail()?.name}</h3>
                <p>
                  Currently <b>{detail()?.replicas ?? 0}</b> desired
                  <Show when={detail()?.ready_replicas != null}>
                    , <b>{detail()!.ready_replicas}</b> ready
                  </Show>
                  . The controller adds or removes pods to match.
                </p>
                <div class="scale-row">
                  <button
                    class="btn"
                    onClick={() =>
                      setScaleInput(
                        String(Math.max(0, (parseInt(scaleInput(), 10) || 0) - 1)),
                      )
                    }
                  >
                    −
                  </button>
                  <input
                    class="search pf-input scale-input"
                    type="number"
                    min="0"
                    ref={(el) => setTimeout(() => el.select())}
                    value={scaleInput()}
                    onInput={(e) => setScaleInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setScaleOpen(false);
                      if (e.key === "Enter") applyScale();
                    }}
                  />
                  <button
                    class="btn"
                    onClick={() =>
                      setScaleInput(String((parseInt(scaleInput(), 10) || 0) + 1))
                    }
                  >
                    +
                  </button>
                </div>
                <div class="modal-actions">
                  <button class="btn" onClick={() => setScaleOpen(false)}>
                    Cancel
                  </button>
                  <button
                    class="btn primary"
                    disabled={
                      !(parseInt(scaleInput(), 10) >= 0) ||
                      parseInt(scaleInput(), 10) === (detail()?.replicas ?? -1)
                    }
                    onClick={applyScale}
                  >
                    Scale to {parseInt(scaleInput(), 10) || 0}
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={pfOpen()}>
            <div class="modal-backdrop" onClick={() => setPfOpen(false)}>
              <div class="modal" onClick={(e) => e.stopPropagation()}>
                <h3>Port-forward {detail()?.name}</h3>
                <p>
                  A local port is opened and your browser follows.
                  <Show when={detail()?.ports.length}>
                    {" "}
                    Container ports: {detail()!.ports.join(", ")}.
                  </Show>
                </p>
                <input
                  class="search grow pf-input"
                  type="number"
                  min="1"
                  max="65535"
                  placeholder="container port"
                  ref={(el) => setTimeout(() => el.focus())}
                  value={pfPort()}
                  onInput={(e) => setPfPort(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPfOpen(false);
                    if (e.key === "Enter") {
                      const port = parseInt(pfPort(), 10);
                      if (port > 0) {
                        setPfOpen(false);
                        void pfStart(port);
                      }
                    }
                  }}
                />
                <div class="modal-actions">
                  <button class="btn" onClick={() => setPfOpen(false)}>
                    Cancel
                  </button>
                  <button
                    class="btn primary"
                    disabled={!(parseInt(pfPort(), 10) > 0)}
                    onClick={() => {
                      setPfOpen(false);
                      void pfStart(parseInt(pfPort(), 10));
                    }}
                  >
                    Forward
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={helpOpen()}>
            <div class="modal-backdrop" onClick={() => setHelpOpen(false)}>
              <div class="modal help" onClick={(e) => e.stopPropagation()}>
                <h3>Keyboard shortcuts</h3>
                <div class="help-grid">
                  <b class="help-sec">table</b><span />
                  <b>:</b><span>command palette (kinds · ns · ctx)</span>
                  <b>/</b><span>search rows (any field value)</span>
                  <b>esc</b><span>step up: detail → table → sidebar</span>
                  <b>j k ↑ ↓</b><span>move cursor · g/G first/last</span>
                  <b>enter · →</b><span>from the sidebar: open that kind</span>
                  <b>← →</b><span>pan wide tables · Home/End first/last column</span>
                  <b>Enter</b><span>open detail — on a namespace, scope to it and list its pods</span>
                  <b>n</b><span>new resource (creatable kinds) · ⇧↑ on top row → search</span>
                  <b>f</b><span>filter the sorted column (values or &gt;/&lt; for numbers)</span>
                  <b>⌘F</b><span>focus the row search / find in the open detail</span>
                  <b>s</b><span>shell (pod / node)</span>
                  <b>l</b><span>logs (pod / workload aggregate)</span>
                  <b>e</b> / <b>y</b><span>edit manifest (YAML) of cursor row</span>
                  <b>⌘C</b><span>copy the manifest (detail open, nothing selected)</span>
                  <b>space</b><span>mark a row · ⌘A all · esc clears</span>
                  <b>⌘/ctrl D</b><span>delete marked rows, or the cursor row (⇧ adds force)</span>
                  <b>⌘/ctrl R</b><span>rollout restart of cursor row</span>
                  <b>c · ⇧D</b><span>cordon · drain the cursor node</span>
                  <b>d</b><span>delete (detail open)</span>
                  <b>⇧← ⇧→</b><span>pick the sort column</span>
                  <b>⇧↑ ⇧↓</b><span>sort ascending / descending</span>
                  <b>Shift A/N/S/R/T/C/M/I/O</b>
                  <span>sort by age · name · status · ready · restarts · cpu · mem · ip · node</span>
                  <b>Esc</b><span>close → clear filter → view history back</span>
                  <b class="help-sec">detail panel</b><span />
                  <b>↑ ↓ · j k</b><span>move between sections</span>
                  <b>Enter</b><span>open the focused section (folds · editor)</span>
                  <b>← h</b><span>back to the table</span>
                  <b>⇞ ⇟ · g G</b><span>scroll · first / last section</span>
                  <b>⇧J ⇧K</b><span>previous / next resource, panel follows</span>
                  <b>a · t · v</b><span>toggle annotations · status · events</span>
                  <b>c · ⇧D</b><span>cordon/uncordon · drain (nodes)</span>
                  <b>r · n</b><span>rollout restart · scale input</span>
                  <b>p</b><span>node ↔ its pods</span>
                  <b>⇧F</b><span>port-forward input (pods)</span>
                  <b>⇧X</b><span>force delete (pods / nodes)</span>
                  <b class="help-sec">app</b><span />
                  <b>⌘B · ⌘K</b><span>sidebar collapse · focus kind filter</span>
                  <b>⌘0</b><span>back to all namespaces</span>
                  <b>⌘,</b><span>settings (kubeconfig, shell)</span>
                  <b>tab · ⇧tab</b><span>next / previous cluster tab</span>
                  <b>ctrl+1-9</b><span>jump straight to a cluster tab</span>
                  <b>⌘T</b><span>show / hide the terminal dock</span>
                  <b>alt+1-9 · ⇧tab</b><span>switch terminal tabs (⇧tab works inside the shell)</span>
                  <b>⌘W</b><span>close what's in front: shell → detail → cluster tab</span>
                  <b>⇧⌘W</b><span>close the current shell session</span>
                  <b>esc</b><span>leave a focused terminal (ctrl+[ sends a real ESC)</span>
                  <b>?</b><span>this help</span>
                </div>
              </div>
            </div>
          </Show>

          <Show when={confirm()}>
            <div class="modal-backdrop" onClick={() => setConfirm(null)}>
              <div class="modal" onClick={(e) => e.stopPropagation()}>
                <h3>{confirm()!.title}</h3>
                <p>{confirm()!.body}</p>
                <div class="modal-actions">
                  <button
                    class="btn"
                    classList={{ "btn-cursor": dlgIdx() === 0 }}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </button>
                  <button
                    class="btn"
                    classList={{
                      primary: !confirm()!.danger,
                      "danger-solid": confirm()!.danger,
                      "btn-cursor": dlgIdx() === 1,
                    }}
                    onClick={() => {
                      const c = confirm()!;
                      setConfirm(null);
                      c.run();
                    }}
                  >
                    {confirm()!.label}
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={newOpen()}>
            <div class="modal-backdrop" onClick={() => setNewOpen(false)}>
              <div
                class="modal new-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <h3>
                  New {selected()?.kind}
                  <span class="gv">
                    {selected()?.group || "core"}/{selected()?.version}
                  </span>
                </h3>
                <p class="dim new-hint">
                  Edit the fields marked <span class="chg">👈</span>, then
                  create. This is a plain create — it fails if the name is
                  already taken.
                </p>
                <Show when={selected()?.namespaced}>
                  <div class="new-ns" classList={{ cur: newSec() === "namespace" }}>
                    <span class="meta-key">namespace</span>
                    <div class="ns-picker new-ns-picker">
                      <button
                        class="ctx ns-btn"
                        classList={{ "btn-cursor": newSec() === "namespace" }}
                        onClick={() => {
                          setNewSec("namespace");
                          setNewNsOpen(!newNsOpen());
                          setNewNsQuery("");
                        }}
                      >
                        {newNs() || "(pick namespace)"}{" "}
                        <span class="dim">▾</span>
                      </button>
                      <Show when={newNsOpen()}>
                        <div
                          class="ns-backdrop"
                          onClick={() => setNewNsOpen(false)}
                        />
                        <div class="ns-pop">
                          <input
                            autocomplete="off"
                            autocorrect="off"
                            autocapitalize="off"
                            spellcheck={false}
                            class="search"
                            placeholder="search namespaces…"
                            ref={(el) => setTimeout(() => el.focus())}
                            value={newNsQuery()}
                            onInput={(e) => setNewNsQuery(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                setNewNsOpen(false);
                              }
                              if (e.key === "Enter") {
                                e.stopPropagation();
                                const first = newNsFiltered()[0];
                                if (first) setNewNs(first);
                                setNewNsOpen(false);
                                // step down to the manifest next
                                setNewSec("editor");
                                newEditorApi?.focus();
                              }
                            }}
                          />
                          <div class="ns-list">
                            <For each={newNsFiltered()}>
                              {(n) => (
                                <button
                                  class="ns-item"
                                  classList={{ active: newNs() === n }}
                                  onClick={() => {
                                    setNewNs(n);
                                    setNewNsOpen(false);
                                  }}
                                >
                                  {n}
                                </button>
                              )}
                            </For>
                            <Show when={newNsFiltered().length === 0}>
                              <p class="dim" style={{ padding: "8px 10px" }}>
                                no match — type an exact name to use it
                              </p>
                            </Show>
                          </div>
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>
                <div
                  class="new-editor"
                  classList={{ cur: newSec() === "editor" }}
                  onClick={() => setNewSec("editor")}
                >
                  <YamlEditor
                    value={newYaml()}
                    theme={theme()}
                    readOnly={false}
                    autofocus
                    api={(a) => (newEditorApi = a)}
                    onChange={setNewYaml}
                    onLeave={() => {
                      // Esc blurs the editor into nav mode (still on the
                      // editor section); ↑/↓ then move to namespace/actions.
                      setNewSec("editor");
                    }}
                  />
                </div>
                <Show when={newErr()}>
                  <div class="new-err">{newErr()}</div>
                </Show>
                <div
                  class="modal-actions"
                  classList={{ cur: newSec() === "actions" }}
                >
                  <button
                    class="btn"
                    classList={{ "btn-cursor": newSec() === "actions" && newDlgIdx() === 0 }}
                    onClick={() => setNewOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    class="btn primary"
                    classList={{ "btn-cursor": newSec() === "actions" && newDlgIdx() === 1 }}
                    disabled={newBusy()}
                    onClick={createResource}
                  >
                    {newBusy() ? "creating…" : "Create"}
                  </button>
                </div>
                <p class="dim new-foot">
                  <b>↑↓</b> section · <b>↵</b> {newSec() === "editor" ? "edit" : newSec() === "namespace" ? "pick ns" : "run"} · <b>esc</b> {newNsOpen() ? "close list" : "close"} · <b>⌘↵</b> create
                </p>
              </div>
            </div>
          </Show>

          <Show when={colMenu()}>
            <div class="col-menu-backdrop" onClick={() => setColMenu(null)} />
            <div
              class="col-menu"
              style={{
                left: `${colMenuAt()?.x ?? 0}px`,
                top: `${colMenuAt()?.y ?? 0}px`,
              }}
            >
              <div class="col-menu-head">
                filter <b>{colMenu()}</b>
              </div>
              <Show
                when={colIsNumeric(colMenu()!)}
                fallback={
                  <Show
                    when={!colMenuData().overflow}
                    fallback={
                      <p class="dim col-num-hint">
                        Too many distinct values to list ({COL_VALUE_CAP}+).
                        Click the header to sort, or use the search box above
                        to narrow the rows.
                      </p>
                    }
                  >
                    <input
                      autocomplete="off"
                      autocorrect="off"
                      autocapitalize="off"
                      spellcheck={false}
                      class="search"
                      placeholder="filter values…"
                      ref={(el) => setTimeout(() => el.focus())}
                      value={colMenuQ()}
                      onInput={(e) => {
                        setColMenuQ(e.currentTarget.value);
                        setColMenuIdx(-1);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setColMenu(null);
                      }}
                    />
                    <div class="col-menu-list">
                      <For each={colMenuValues()}>
                        {([val, count], vi) => (
                          <button
                            class="ns-item col-val"
                            classList={{ "kb-cursor": colMenuIdx() === vi() }}
                            onClick={() => toggleColValue(colMenu()!, val)}
                          >
                            <span
                              class="mark-box"
                              classList={{
                                on:
                                  colFilters()[colMenu()!]?.has(val) ?? false,
                              }}
                            />
                            <span class="col-val-txt">{val || "∅ (empty)"}</span>
                            <span class="dim col-val-n">{count}</span>
                          </button>
                        )}
                      </For>
                      <Show when={colMenuValues().length === 0}>
                        <p class="dim" style={{ padding: "8px 12px" }}>
                          no values
                        </p>
                      </Show>
                    </div>
                  </Show>
                }
              >
                {/* Numeric column: compare instead of listing every number. */}
                <div class="col-num">
                  <select
                    class="col-num-op"
                    value={colNumFilters()[colMenu()!]?.op ?? ">"}
                    onChange={(e) =>
                      setColNum(
                        colMenu()!,
                        e.currentTarget.value as NumOp,
                        String(colNumFilters()[colMenu()!]?.val ?? ""),
                      )
                    }
                  >
                    <option value=">">&gt;</option>
                    <option value=">=">&ge;</option>
                    <option value="<">&lt;</option>
                    <option value="<=">&le;</option>
                    <option value="=">=</option>
                  </select>
                  <input
                    type="number"
                    class="search col-num-val"
                    placeholder="value"
                    ref={(el) => setTimeout(() => el.focus())}
                    value={String(colNumFilters()[colMenu()!]?.val ?? "")}
                    onInput={(e) =>
                      setColNum(
                        colMenu()!,
                        colNumFilters()[colMenu()!]?.op ?? ">",
                        e.currentTarget.value,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Escape" || e.key === "Enter")
                        setColMenu(null);
                    }}
                  />
                </div>
                <p class="dim col-num-hint">
                  rows where {colMenu()}{" "}
                  {colNumFilters()[colMenu()!]?.op ?? ">"} value
                </p>
              </Show>
              <div class="col-menu-foot">
                <Show when={colHasFilter(colMenu()!)}>
                  <button
                    class="btn sm"
                    onClick={() => clearColFilter(colMenu()!)}
                  >
                    clear
                  </button>
                </Show>
                <button class="btn sm" onClick={() => setColMenu(null)}>
                  done
                </button>
              </div>
            </div>
          </Show>
        </main>
      </div>
    </div>
    </Show>
  );
}

export default App;
