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
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { onOpenUrl, getCurrent as getCurrentDeepLinks } from "@tauri-apps/plugin-deep-link";
import YamlEditor from "./YamlEditor";
import TerminalPanel, { type ShellTarget } from "./TerminalPanel";
import StatusView from "./StatusView";
import logoUrl from "./assets/svg/app-icon.svg";
import lookUrl from "./assets/svg/pigeon-search.svg";
import puzzledUrl from "./assets/svg/pigeon-thinking.svg";
import flyingUrl from "./assets/svg/pigeon-flying.svg";
// The "share" mark — our pigeon-on-a-rocket mascot: launching = sending =
// sharing. Recognisable down to ~22px, and on-brand where a copy glyph read
// like the clipboard.
import rocketUrl from "./assets/svg/pigeon-rocket.svg";
// "my permissions" mark — pigeon guarding a padlocked shield = access rights.
import shieldUrl from "./assets/svg/pigeon-shield.svg";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

// "ResizeObserver loop completed with undelivered notifications" is a benign
// browser warning (an observer callback reflowed within the same frame) that
// zoom makes easy to trigger. It changes nothing at runtime, but the dev
// error overlay treats it as fatal — swallow just that one message.
if (typeof window !== "undefined") {
  const isRoLoop = (m?: string) => !!m && m.includes("ResizeObserver loop");
  window.addEventListener(
    "error",
    (e) => {
      if (isRoLoop(e.message)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );
}

interface ContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  is_current: boolean;
  source: string;
  /// The cluster's API server URL — the same for everyone who can reach the
  /// cluster, so a deep link can match by it regardless of the local name.
  server: string;
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
  /// The row search (`/`) in effect, kept so switching clusters and coming
  /// back restores the filter instead of dropping it.
  filter: string;
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

interface Revision {
  revision: number;
  name: string;
  images: string[];
  created: string | null;
  current: boolean;
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

/// Seconds encoded in a kubectl-style age string ("13s", "5m", "3h5m",
/// "2d3h", "8d", "1y23d"). Null if it isn't one, so the raw cell is shown.
function parseAgeSeconds(s: string): number | null {
  const t = s.trim();
  const m = t.match(/^(?:(\d+)y)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || m[0] === "") return null;
  const n = (x?: string) => (x ? parseInt(x, 10) : 0);
  return ((((n(m[1]) * 365 + n(m[2])) * 24 + n(m[3])) * 60 + n(m[4])) * 60) + n(m[5]);
}

/// Format an age from a second count, matching the server's short style
/// for the sub-hour range we tick live.
function fmtAgeSeconds(s: number): string {
  if (s < 0) s = 0;
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

/// Deterministic hue (0-359) for a context name, so each cluster keeps a
/// stable identity color across its tab and the active-tab card — you can
/// tell prod from staging at a glance, not just by reading the text.
function ctxHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/// Compare two dotted versions ("0.0.6", "v0.1.0"). Leading "v" and any
/// pre-release suffix are ignored; missing components count as 0. Returns
/// >0 when a is newer, <0 when older, 0 when equal.
function cmpSemver(a: string, b: string): number {
  const parts = (s: string) =>
    s
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
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
  // percentages (%CPU, %MEM columns)
  const pctm = s.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (pctm) return +pctm[1];
  // "5 (3h ago)" — the RESTARTS column on modern kube. Sort by the count.
  const paren = s.match(/^(\d+)\s+\(.*\)$/);
  if (paren) return +paren[1];
  // IPv4 → a single ordered number so 10.x sorts after 9.x, not before.
  const ip = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip && ip.slice(1).every((o) => +o <= 255))
    return ((+ip[1] * 256 + +ip[2]) * 256 + +ip[3]) * 256 + +ip[4];
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

/// A cell with no real value — sorts to the bottom in either direction.
function isBlankCell(s: string): boolean {
  const t = s.trim();
  return t === "" || t === "-" || t === "n/a" || t === "<none>";
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
  // In-app update: current build version vs. the latest GitHub release.
  const [appVersion, setAppVersion] = createSignal("");
  const [latestVersion, setLatestVersion] = createSignal("");
  const [upgrading, setUpgrading] = createSignal(false);
  const [upgradeDone, setUpgradeDone] = createSignal(false);
  const [upgradeErr, setUpgradeErr] = createSignal("");
  // Version history / rollback: the machine's arch (for the right asset) plus
  // the list of released versions, fetched on demand when the panel opens.
  const [appArch, setAppArch] = createSignal("");
  const [releases, setReleases] = createSignal<string[]>([]);
  const [versionsOpen, setVersionsOpen] = createSignal(false);
  const [releasesLoading, setReleasesLoading] = createSignal(false);
  // The list request failed (offline, or GitHub's 60/hr unauthenticated API
  // limit is exhausted). The releases page fallback works regardless.
  const [releasesErr, setReleasesErr] = createSignal(false);
  const RELEASES_PAGE = "https://github.com/tackish/pigeoneye/releases";
  async function loadReleases() {
    if (releases().length || releasesLoading()) return;
    setReleasesLoading(true);
    setReleasesErr(false);
    try {
      const res = await fetch(
        "https://api.github.com/repos/tackish/pigeoneye/releases?per_page=30",
        { headers: { Accept: "application/vnd.github+json" } },
      );
      const list = res.ok ? await res.json() : null;
      if (Array.isArray(list) && list.length) {
        setReleases(
          list
            .map((r) => String(r?.tag_name ?? "").replace(/^v/, ""))
            .filter(Boolean),
        );
      } else {
        // rate-limited / error responses come back as a JSON object, not a list
        setReleasesErr(true);
      }
    } catch {
      setReleasesErr(true);
    }
    setReleasesLoading(false);
  }
  /// The macOS tarball for a given version and this machine's arch. Opening it
  /// downloads the build; the user extracts it and moves PigeonEye.app into
  /// Applications to roll back (no self-replacing installer — that can't be
  /// verified safely and could brick an install).
  const rollbackUrl = (version: string) =>
    `https://github.com/tackish/pigeoneye/releases/download/v${version}/PigeonEye-darwin-${appArch() || "arm64"}.tar.gz`;
  // Context tabs collapse into a ▾ dropdown when they can't all fit, so a
  // context scrolled off the edge is never silently hidden.
  const [tabsOverflow, setTabsOverflow] = createSignal(false);
  const [tabsMenuOpen, setTabsMenuOpen] = createSignal(false);
  let tabsStripRef: HTMLDivElement | undefined;
  let tabsRO: ResizeObserver | undefined;
  const measureTabs = () => {
    const el = tabsStripRef;
    if (el) setTabsOverflow(el.scrollWidth > el.clientWidth + 1);
  };
  const updateAvailable = createMemo(
    () =>
      !!appVersion() &&
      !!latestVersion() &&
      cmpSemver(latestVersion(), appVersion()) > 0,
  );
  async function runSelfUpgrade() {
    if (upgrading()) return;
    setUpgrading(true);
    setUpgradeErr("");
    try {
      await invoke<string>("self_upgrade");
      // The new bundle is on disk. Flip the label to "restarting…", then
      // relaunch so the running (old) process is replaced by it.
      setUpgradeDone(true);
      setUpgrading(false);
      window.setTimeout(() => void invoke("restart_app").catch(() => {}), 700);
    } catch (e) {
      setUpgradeErr(String(e));
      setUpgrading(false);
    }
  }
  // Ticks once a second so the AGE column counts up live instead of
  // sitting at whatever the server last printed. Only visible age cells
  // read it (virtual scroll + a ternary that skips non-age cells), so a
  // 24k-row list costs nothing per tick. Paused while the window is
  // hidden — liveAge derives from real elapsed time, so it catches up on
  // return without accumulating skipped ticks.
  const [nowTick, setNowTick] = createSignal(Date.now());
  onMount(() => {
    let id: number | undefined;
    const start = () => {
      if (id == null)
        id = window.setInterval(() => setNowTick(Date.now()), 1000);
    };
    const stop = () => {
      if (id != null) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVis = () => {
      if (document.hidden) stop();
      else {
        setNowTick(Date.now());
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    onCleanup(() => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    });
  });
  // Per-row anchor: the age (seconds) a row showed and when we first saw
  // it, so live age = base + elapsed. Only rows under an hour are ticked;
  // older ones keep the server's string (which may be compound, "2d3h").
  const ageAnchor = new WeakMap<
    TableRow,
    { atMs: number; baseSec: number } | null
  >();
  function liveAge(row: TableRow, raw: string): string {
    let a = ageAnchor.get(row);
    if (a === undefined) {
      const base = parseAgeSeconds(raw);
      a = base !== null && base < 3600 ? { atMs: nowTick(), baseSec: base } : null;
      ageAnchor.set(row, a);
    }
    if (!a) return raw;
    return fmtAgeSeconds(a.baseSec + Math.floor((nowTick() - a.atMs) / 1000));
  }
  const [pickerQ, setPickerQ] = createSignal("");
  const [pickerIdx, setPickerIdx] = createSignal(0);
  // The top bar's context picker. Declared with the launcher's because
  // ctxAddSections below reads them, and a memo runs once the moment it is made.
  const [ctxOpen, setCtxOpen] = createSignal(false);
  const [ctxQuery, setCtxQuery] = createSignal("");
  const [ctxIdx, setCtxIdx] = createSignal(0);
  const lastSession: string[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}").tabs ?? [];
    } catch {
      return [];
    }
  })();

  // Collapsed-group state, persisted. Groups are entirely user-made (see
  // ctxGroupOf below) — there is no auto grouping and no built-in favorites.
  const loadSet = (key: string): Set<string> => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]");
      return new Set(
        Array.isArray(v) ? v.filter((x) => typeof x === "string") : [],
      );
    } catch {
      return new Set();
    }
  };
  const [ctxCollapsed, setCtxCollapsedRaw] = createSignal<Set<string>>(
    loadSet("pigeoneye.ctxgroups"),
  );
  const persistSet = (key: string, s: Set<string>) =>
    localStorage.setItem(key, JSON.stringify([...s]));
  const toggleCtxGroup = (g: string) => {
    const s = new Set(ctxCollapsed());
    if (s.has(g)) s.delete(g);
    else s.add(g);
    setCtxCollapsedRaw(s);
    persistSet("pigeoneye.ctxgroups", s);
    // Collapsing shrinks the flat list; keep the keyboard cursor in range.
    setPickerIdx(0);
    setCtxIdx(0);
  };
  // Custom context groups: a context is ungrouped until the user puts it in a
  // named group (like pinning to a group in the left panel). No auto grouping
  // by name prefix and no built-in favorites — the flat list is the default,
  // groups are entirely user-made. Persisted.
  const [ctxGroupOf, setCtxGroupOfRaw] = createSignal<Record<string, string>>(
    (() => {
      try {
        const v = JSON.parse(
          localStorage.getItem("pigeoneye.ctxgroupof") ?? "{}",
        );
        return v && typeof v === "object" ? v : {};
      } catch {
        return {};
      }
    })(),
  );
  /// A context's group, or "" when it is ungrouped (the default).
  const groupKeyOf = (name: string) => ctxGroupOf()[name] || "";
  const persistCtxGroupOf = (m: Record<string, string>) => {
    setCtxGroupOfRaw(m);
    localStorage.setItem("pigeoneye.ctxgroupof", JSON.stringify(m));
  };
  const setCtxGroup = (name: string, group: string) => {
    const m = { ...ctxGroupOf() };
    const g = group.trim();
    if (!g) delete m[name]; // ungrouped
    else m[name] = g;
    persistCtxGroupOf(m);
  };
  /// Rename a group by moving every context filed under it to the new name.
  /// Walk the assignment map itself (not the loaded context list) so a
  /// context that is grouped but absent from the current kubeconfig still
  /// moves, and carry the collapsed state over so the group doesn't spring
  /// open on rename.
  const renameCtxGroup = (from: string, to: string) => {
    const t = to.trim();
    if (!t || t === from) return;
    const m = { ...ctxGroupOf() };
    for (const k of Object.keys(m)) {
      if (m[k] === from) m[k] = t;
    }
    persistCtxGroupOf(m);
    const cc = ctxCollapsed();
    if (cc.has(from)) {
      const s = new Set(cc);
      s.delete(from);
      s.add(t);
      setCtxCollapsedRaw(s);
      persistSet("pigeoneye.ctxgroups", s);
    }
  };
  const [renamingCtxGroup, setRenamingCtxGroup] = createSignal<string | null>(
    null,
  );
  /// Connect to every context in a group at once — the point of a group is
  /// to treat those clusters as one set. Skips any already open.
  ///
  /// A context with an un-run pre-connect command opens a login terminal
  /// (one `loginTarget` at a time), so we can only kick off the FIRST such
  /// context — starting a second would silently overwrite the first's pending
  /// login. The rest are left for the user to connect individually; everything
  /// that connects without interaction opens immediately.
  function openGroup(group: string) {
    setCtxOpen(false);
    let startedPre = false;
    for (const c of contexts()) {
      if (groupKeyOf(c.name) !== group || tabs().includes(c.name)) continue;
      const needsPre = !!preCmds()[c.name] && !preRan.has(c.name);
      if (needsPre) {
        if (startedPre) continue;
        startedPre = true;
      }
      void openContext(c.name);
    }
  }
  // The ★ group-picker popover. A context's star opens this picker to choose
  // which group to file the context under (an existing group, or a new one
  // typed inline), like the left panel's pin-to-group flow. A context is
  // either in one named group or ungrouped.
  const [ctxNewGroup, setCtxNewGroup] = createSignal("");
  const [ctxPinFor, setCtxPinFor] = createSignal<string | null>(null);
  const [ctxPinAt, setCtxPinAt] = createSignal<{ x: number; y: number } | null>(
    null,
  );
  const ctxGroupNames = () =>
    [...new Set(contexts().map((c) => groupKeyOf(c.name)))]
      .filter((g) => !!g)
      .sort();
  /// A context is "pinned" when it is filed into a group — its star fills.
  const isCtxPinned = (name: string) => !!groupKeyOf(name);
  /// Open the ★ group picker anchored under the clicked star.
  const openCtxPin = (name: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setCtxNewGroup("");
    setCtxPinAt({ x: r.left, y: r.bottom + 6 });
    setCtxPinFor(ctxPinFor() === name ? null : name);
  };
  /// The star button for a context row — opens the group picker anchored to it.
  const ctxStar = (name: string) => (
    <button
      class="ctx-star"
      classList={{ on: isCtxPinned(name) }}
      title="file under a group"
      onClick={(e) => {
        e.stopPropagation();
        openCtxPin(name, e.currentTarget);
      }}
    >
      {isCtxPinned(name) ? "★" : "☆"}
    </button>
  );
  /// The ★ group picker, rendered once at the app root (fixed-positioned to
  /// the clicked star). Mirrors the left panel's pin-to-group popover.
  function ctxPinPicker() {
    const name = () => ctxPinFor();
    return (
      <Show when={name()}>
        <div class="col-menu-backdrop" onClick={() => setCtxPinFor(null)} />
        <div
          class="col-menu pin-pick"
          style={{
            left: `${ctxPinAt()?.x ?? 0}px`,
            top: `${ctxPinAt()?.y ?? 0}px`,
          }}
        >
          <div class="col-menu-head">
            file <b>{name()}</b> under…
          </div>
          <div class="col-menu-list">
            <Show
              when={ctxGroupNames().length}
              fallback={
                <div class="ctx-pin-empty">
                  no groups yet — name one below
                </div>
              }
            >
              <For each={ctxGroupNames()}>
                {(g) => (
                  <button
                    class="ns-item"
                    classList={{ on: groupKeyOf(name()!) === g }}
                    onClick={() => {
                      setCtxGroup(name()!, g);
                      setCtxPinFor(null);
                    }}
                  >
                    {g}
                  </button>
                )}
              </For>
            </Show>
            <Show when={isCtxPinned(name()!)}>
              <button
                class="ns-item ctx-pin-remove"
                onClick={() => {
                  setCtxGroup(name()!, "");
                  setCtxPinFor(null);
                }}
              >
                ✕ remove from {groupKeyOf(name()!)}
              </button>
            </Show>
          </div>
          <div class="pin-pick-new">
            <input
              class="search"
              placeholder="new group…"
              value={ctxNewGroup()}
              ref={(el) => setTimeout(() => el.focus())}
              onInput={(e) => setCtxNewGroup(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && ctxNewGroup().trim()) {
                  setCtxGroup(name()!, ctxNewGroup().trim());
                  setCtxPinFor(null);
                } else if (e.key === "Escape") setCtxPinFor(null);
              }}
            />
            <button
              class="btn sm"
              disabled={!ctxNewGroup().trim()}
              onClick={() => {
                setCtxGroup(name()!, ctxNewGroup().trim());
                setCtxPinFor(null);
              }}
            >
              add
            </button>
          </div>
        </div>
      </Show>
    );
  }
  /// A collapsible group header, shared by the pickers: click toggles,
  /// double-click on the name renames the whole group.
  function GroupHeader(props: {
    sec: { group: string; collapsed: boolean; items: unknown[] };
  }) {
    const sec = () => props.sec;
    const renaming = () => renamingCtxGroup() === sec().group;
    return (
      <div
        class="ctx-group-head"
        classList={{ renaming: renaming() }}
        title={
          renaming()
            ? ""
            : (sec().collapsed ? "expand" : "collapse") +
              " · double-click to rename"
        }
        onClick={() => {
          if (!renaming()) toggleCtxGroup(sec().group);
        }}
      >
        <span class="ctx-chev">{sec().collapsed ? "▸" : "▾"}</span>
        <Show
          when={renaming()}
          fallback={
            <span
              class="ctx-group-name"
              onDblClick={(e) => {
                e.stopPropagation();
                setRenamingCtxGroup(sec().group);
              }}
            >
              {sec().group}
            </span>
          }
        >
          <input
            class="ctx-group-rename"
            value={sec().group}
            ref={(el) =>
              setTimeout(() => {
                el.focus();
                el.select();
              })
            }
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                renameCtxGroup(sec().group, e.currentTarget.value);
                setRenamingCtxGroup(null);
              } else if (e.key === "Escape") setRenamingCtxGroup(null);
            }}
            onBlur={(e) => {
              renameCtxGroup(sec().group, e.currentTarget.value);
              setRenamingCtxGroup(null);
            }}
          />
        </Show>
        <span class="dim">{sec().items.length}</span>
        <Show when={!renaming()}>
          <button
            class="ctx-group-open"
            title={`connect to all ${sec().items.length} contexts in this group`}
            onClick={(e) => {
              e.stopPropagation();
              openGroup(sec().group);
            }}
          >
            connect all
          </button>
        </Show>
      </div>
    );
  }

  /// Contexts for the launcher: one collapsible section per custom group,
  /// then the ungrouped contexts as a flat headerless tail. A search query
  /// flattens it to a single ranked list (recent/current first) for fast find.
  type CtxSection = { group: string; collapsed: boolean; items: ContextInfo[] };
  const ctxSections = createMemo<CtxSection[]>(() => {
    const q = pickerQ().toLowerCase().trim();
    const all = contexts().filter(
      (c) => !q || c.name.toLowerCase().includes(q),
    );
    const byName = (a: ContextInfo, b: ContextInfo) =>
      a.name.localeCompare(b.name);
    if (q) {
      const rank = (c: ContextInfo) =>
        (lastSession.includes(c.name) ? 0 : 1) + (c.is_current ? -0.5 : 0);
      const items = [...all].sort((a, b) => rank(a) - rank(b) || byName(a, b));
      return [{ group: "", collapsed: false, items }];
    }
    const gmap = new Map<string, ContextInfo[]>();
    const loose: ContextInfo[] = [];
    for (const c of all) {
      const g = groupKeyOf(c.name);
      if (!g) {
        loose.push(c);
        continue;
      }
      if (!gmap.has(g)) gmap.set(g, []);
      gmap.get(g)!.push(c);
    }
    const sections: CtxSection[] = [];
    for (const g of [...gmap.keys()].sort())
      sections.push({
        group: g,
        collapsed: ctxCollapsed().has(g),
        items: gmap.get(g)!.sort(byName),
      });
    // Ungrouped contexts trail the groups as one headerless, flat section.
    if (loose.length)
      sections.push({ group: "", collapsed: false, items: loose.sort(byName) });
    return sections;
  });
  /// Flat selectable list (collapsed groups contribute nothing) — the
  /// keyboard cursor (pickerIdx) indexes into this.
  const pickerList = createMemo(() =>
    ctxSections().flatMap((s) => (s.collapsed ? [] : s.items)),
  );
  const pickerIndexOf = createMemo(
    () => new Map(pickerList().map((c, i) => [c.name, i])),
  );
  /// The top bar's picker: same list minus what is already open.
  /// The "+ add context" picker: same grouping as the launcher, minus what
  /// is already open. Flat list + index map drive its keyboard cursor.
  const ctxAddSections = createMemo<CtxSection[]>(() => {
    const q = ctxQuery().toLowerCase().trim();
    // Open contexts stay in the list (marked "open") rather than vanishing —
    // clicking one just switches to its tab. Dropping them made contexts look
    // like they disappeared when connected.
    const all = contexts().filter((c) => !q || c.name.toLowerCase().includes(q));
    const byName = (a: ContextInfo, b: ContextInfo) =>
      a.name.localeCompare(b.name);
    if (q) {
      const rank = (c: ContextInfo) => (c.is_current ? -0.5 : 0);
      return [
        {
          group: "",
          collapsed: false,
          items: [...all].sort((a, b) => rank(a) - rank(b) || byName(a, b)),
        },
      ];
    }
    const gmap = new Map<string, ContextInfo[]>();
    const loose: ContextInfo[] = [];
    for (const c of all) {
      const g = groupKeyOf(c.name);
      if (!g) {
        loose.push(c);
        continue;
      }
      if (!gmap.has(g)) gmap.set(g, []);
      gmap.get(g)!.push(c);
    }
    const sections: CtxSection[] = [];
    for (const g of [...gmap.keys()].sort())
      sections.push({
        group: g,
        collapsed: ctxCollapsed().has(g),
        items: gmap.get(g)!.sort(byName),
      });
    if (loose.length)
      sections.push({ group: "", collapsed: false, items: loose.sort(byName) });
    return sections;
  });
  const ctxAddFlat = createMemo(() =>
    ctxAddSections().flatMap((s) => (s.collapsed ? [] : s.items)),
  );
  const ctxAddIndexOf = createMemo(
    () => new Map(ctxAddFlat().map((c, i) => [c.name, i])),
  );

  // Keep the keyboard-selected context in view as the cursor moves.
  createEffect(() => {
    if (tabs().length) return;
    const i = pickerIdx();
    queueMicrotask(() =>
      document
        .querySelectorAll(".launcher-item")
        [i]?.scrollIntoView?.({ block: "nearest" }),
    );
  });
  const [newPath, setNewPath] = createSignal("");
  const [theme, setTheme] = createSignal<"dark" | "light">(
    (localStorage.getItem("pigeoneye.theme") as "dark" | "light") ?? "dark",
  );
  // Browser-style UI zoom (⌘/Ctrl +/−, ⌘/Ctrl 0 resets). Native webview
  // zoom scales everything — including popover positions — cleanly, and
  // the factor is restored on launch.
  const [zoom, setZoomRaw] = createSignal(
    parseFloat(localStorage.getItem("pigeoneye.zoom") ?? "1") || 1,
  );
  function setZoom(next: number) {
    const z = Math.min(2.5, Math.max(0.5, Math.round(next * 100) / 100));
    setZoomRaw(z);
    localStorage.setItem("pigeoneye.zoom", String(z));
    void getCurrentWebview().setZoom(z).catch(() => {});
  }
  onMount(() => {
    if (zoom() !== 1) void getCurrentWebview().setZoom(zoom()).catch(() => {});
  });
  const [nsOpen, setNsOpen] = createSignal(false);
  const [nsQuery, setNsQuery] = createSignal("");
  const [tabs, setTabs] = createSignal<string[]>([]);
  const [active, setActive] = createSignal<string | null>(null);
  /// The open tabs, grouped the same way for the topbar ▾ overflow menu:
  /// one header per custom group, then the ungrouped tabs. (Declared here,
  /// after `tabs`, so the eager memo doesn't read it in its TDZ.)
  const tabSections = createMemo<{ group: string; items: string[] }[]>(() => {
    const names = tabs();
    const gmap = new Map<string, string[]>();
    const loose: string[] = [];
    for (const n of names) {
      const g = groupKeyOf(n);
      if (!g) {
        loose.push(n);
        continue;
      }
      if (!gmap.has(g)) gmap.set(g, []);
      gmap.get(g)!.push(n);
    }
    const out: { group: string; items: string[] }[] = [];
    for (const g of [...gmap.keys()].sort())
      out.push({ group: g, items: gmap.get(g)!.sort() });
    if (loose.length) out.push({ group: "", items: loose.sort() });
    return out;
  });
  // The strip's ResizeObserver is attached in its ref callback (below) —
  // the topbar lives behind <Show when={tabs().length}>, so at the
  // component's onMount the strip may not exist yet; attaching on mount
  // there would silently no-op forever. A window resize listener is the
  // belt-and-suspenders trigger, and the effect re-measures on tab changes.
  onMount(() => {
    const onResize = () => requestAnimationFrame(measureTabs);
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });
  createEffect(() => {
    tabs();
    requestAnimationFrame(measureTabs);
  });
  // Keep the active tab in view within the strip (it may be scrolled off).
  createEffect(() => {
    const a = active();
    if (!a) return;
    requestAnimationFrame(() =>
      tabsStripRef
        ?.querySelector<HTMLElement>(".tab.active")
        ?.scrollIntoView?.({ inline: "nearest", block: "nearest" }),
    );
  });
  // Every connection in flight, not just one: a cluster behind a dead
  // endpoint takes its whole timeout to fail, and blocking the picker for
  // it means one unreachable cluster holds up the entire app.
  const [connecting, setConnecting] = createSignal<string[]>([]);
  const isConnecting = (name: string) => connecting().includes(name);
  // Attempts the user gave up on. The invoke still settles — it just has
  // nothing left to say, and an error from a cancelled attempt is noise.
  const abandoned = new Set<string>();

  function cancelConnect(name: string) {
    abandoned.add(name);
    endConnect(name);
    void invoke("cancel_connect", { context: name }).catch(() => {});
  }
  const beginConnect = (name: string) =>
    setConnecting([...connecting().filter((n) => n !== name), name]);
  const endConnect = (name: string) =>
    setConnecting(connecting().filter((n) => n !== name));
  // True from launch while last session's tabs reconnect, so the launcher
  // (context picker) doesn't flash before the restored tabs appear. We know
  // synchronously whether there's anything to restore from the saved tabs.
  const [restoring, setRestoring] = createSignal(lastSession.length > 0);
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

  function flushWatch(seq: number) {
    if (watchFlushTimer != null) {
      window.clearTimeout(watchFlushTimer);
      watchFlushTimer = undefined;
    }
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
  }

  function scheduleWatchFlush(seq: number) {
    if (watchFlushTimer != null) return;
    watchFlushTimer = window.setTimeout(() => {
      watchFlushTimer = undefined;
      flushWatch(seq);
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
      const del = ev.type === "DELETED";
      for (const r of incoming) watchBuf.set(rowKeyOf(r), { del, row: r });
      // A vanished row (Node gone NotReady/deleted) should leave the list
      // at once — don't let it sit behind the 700ms coalescing window.
      if (del) flushWatch(seq);
      else scheduleWatchFlush(seq);
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
  // termFocused: the xterm itself has focus (drives its hint + Esc-leave).
  // termDockFocused: focus is anywhere in the dock — the xterm OR the log
  // toolbar — so the level indicator stays on the terminal when you tab up
  // to the toolbar instead of jumping to the table.
  const [termFocused, setTermFocused] = createSignal(false);
  const [termDockFocused, setTermDockFocused] = createSignal(false);
  // Log/shell dock height in px, drag- and keyboard-resizable. 0 = use the
  // default (42% of the viewport). Clamped to a sane range and persisted.
  // winH tracks the viewport so the dock height re-clamps on window resize.
  const TERM_MIN_H = 140;
  const [winH, setWinH] = createSignal(window.innerHeight);
  onMount(() => {
    const on = () => setWinH(window.innerHeight);
    window.addEventListener("resize", on);
    onCleanup(() => window.removeEventListener("resize", on));
  });
  const [termHeightRaw, setTermHeightRaw] = createSignal(
    parseInt(localStorage.getItem("pigeoneye.termheight") ?? "0", 10) || 0,
  );
  const termHeight = () => {
    const max = Math.max(TERM_MIN_H, winH() - 120);
    const px = termHeightRaw() || Math.round(winH() * 0.42);
    return Math.max(TERM_MIN_H, Math.min(px, max));
  };
  let termFitRaf = 0;
  function setTermHeight(px: number) {
    const max = Math.max(TERM_MIN_H, window.innerHeight - 120);
    const h = Math.max(TERM_MIN_H, Math.min(Math.round(px), max));
    setTermHeightRaw(h);
    localStorage.setItem("pigeoneye.termheight", String(h));
    // xterm only refits on window resize / becoming active — nudge it once
    // per frame so a drag stays smooth.
    if (!termFitRaf)
      termFitRaf = requestAnimationFrame(() => {
        termFitRaf = 0;
        window.dispatchEvent(new Event("resize"));
      });
  }
  function startTermResize(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const move = (ev: PointerEvent) => setTermHeight(window.innerHeight - ev.clientY);
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
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

  // Global pin list: an ordered set of typeKeys (`group/kind`) the user
  // dragged/starred to the top. Global across clusters — a pinned CRD
  // that a given cluster doesn't have simply doesn't render, but stays
  // pinned for the clusters that do. Persisted so it survives restarts.
  // Pinned kinds, organised into named groups the user can create. Global
  // across clusters — a pinned CRD a cluster doesn't have simply doesn't
  // render, but stays pinned for the clusters that do.
  const readPinGroups = (): { name: string; keys: string[] }[] => {
    try {
      const raw = localStorage.getItem("pigeoneye.pingroups");
      if (raw) {
        const v = JSON.parse(raw);
        if (Array.isArray(v))
          return v.filter(
            (g) =>
              g && typeof g.name === "string" && Array.isArray(g.keys),
          );
      }
      // migrate the old flat pin list into a single "Pinned" group
      const old = JSON.parse(localStorage.getItem("pigeoneye.pins") ?? "[]");
      const keys = Array.isArray(old)
        ? old.filter((x: unknown) => typeof x === "string")
        : [];
      return [{ name: "Pinned", keys }];
    } catch {
      return [{ name: "Pinned", keys: [] }];
    }
  };
  const [pinGroups, setPinGroupsRaw] = createSignal<
    { name: string; keys: string[] }[]
  >(readPinGroups());
  const setPinGroups = (next: { name: string; keys: string[] }[]) => {
    setPinGroupsRaw(next);
    localStorage.setItem("pigeoneye.pingroups", JSON.stringify(next));
  };
  // The ★ group-picker popover: which kind(s) are being pinned and where.
  // `types` is one kind for a kind's own star, or every kind under a CRD
  // group when its group header is pinned as a whole.
  const [pinPick, setPinPick] = createSignal<{
    types: ResourceType[];
    label: string;
  } | null>(null);
  const [pinPickAt, setPinPickAt] = createSignal<{ x: number; y: number } | null>(
    null,
  );
  const [newGroupName, setNewGroupName] = createSignal("");
  const [renamingGroup, setRenamingGroup] = createSignal<string | null>(null);
  const [renameText, setRenameText] = createSignal("");

  let nextShellKey = 1;
  const [failed, setFailed] = createSignal<{ name: string; error: string }[]>([]);
  const failedTabs: { name: string; error: string }[] = [];
  const [authHint, setAuthHint] = createSignal<{
    context: string;
    kind: string;
    message: string;
    command: string | null;
    can_login: boolean;
    /// The context's own credential command, verbatim from its exec block.
    exec_command: string | null;
  } | null>(null);

  /// On an auth failure, ask the backend how this context logs in and
  /// offer to do it — an expired SSO session is a browser click away.
  async function offerLogin(name: string) {
    try {
      const hint = await invoke<{
        kind: string;
        message: string;
        command: string | null;
        can_login: boolean;
        exec_command: string | null;
      }>("auth_hint", { context: name, path: sourceOf(name) || null });
      setAuthHint({ context: name, ...hint });
    } catch {
      /* no hint available; the error banner still shows the raw cause */
    }
  }

  /// The login CLI runs in a terminal of its own rather than off-screen:
  /// `tsh login` and friends ask for an OTP or a password, and they only
  /// ask when a tty is on the other end. The window is where the user
  /// reads what it wants and types the answer back.
  const [loginTarget, setLoginTarget] = createSignal<ShellTarget | null>(null);
  let shellApi: { focus: () => void; send: (text: string) => void } | undefined;

  // What a context needs before it can be connected to at all: `tsh login`
  // for a Teleport cluster, an ssh tunnel to a bastion, a VPN. None of it
  // is expressible in a kubeconfig — an `exec` block holds one command and
  // has no "run this first" — and it is per-machine anyway, so it lives
  // here rather than in a file the team shares.
  const PRE_KEY = "pigeoneye.preconnect";
  const [preCmds, setPreCmds] = createSignal<Record<string, string>>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(PRE_KEY) ?? "{}");
      } catch {
        return {};
      }
    })(),
  );
  // Once per launch is the useful frequency: enough that opening a cluster
  // just works, few enough that a second tab doesn't re-prompt.
  const preRan = new Set<string>();
  const [preEdit, setPreEdit] = createSignal<string | null>(null);
  const [preText, setPreText] = createSignal("");

  function savePreCmd(context: string, cmd: string) {
    const next = { ...preCmds() };
    if (cmd.trim()) next[context] = cmd.trim();
    else delete next[context];
    setPreCmds(next);
    localStorage.setItem(PRE_KEY, JSON.stringify(next));
    setPreEdit(null);
  }

  function editPreCmd(context: string) {
    setPreText(preCmds()[context] ?? "");
    setPreEdit(preEdit() === context ? null : context);
  }

  const preConnectEditor = (name: string) => (
    <Show when={preEdit() === name}>
      <div class="launcher-pre-edit">
        {/* A login line runs long — proxy, auth method, user — and a
            single-line input shows whichever end you are not looking at.
            This wraps, so the whole command is on screen while you edit
            it. */}
        <textarea
          class="pre-cmd"
          rows={2}
          spellcheck={false}
          placeholder="tsh status >/dev/null || tsh login --proxy=…"
          value={preText()}
          ref={(el) => setTimeout(() => el.focus())}
          onInput={(e) => setPreText(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            // ⇧↵ for a second line — chaining two commands is fair game.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              savePreCmd(name, preText());
            }
            if (e.key === "Escape") setPreEdit(null);
          }}
        />
        <div class="pre-cmd-actions">
          <span class="dim">runs before connecting · ↵ save · esc cancel</span>
          <Show when={preCmds()[name]}>
            <button class="btn sm" onClick={() => savePreCmd(name, "")}>
              clear
            </button>
          </Show>
          <button class="btn sm" onClick={() => savePreCmd(name, preText())}>
            save
          </button>
        </div>
      </div>
    </Show>
  );

  /// One shell, in a window, that the buttons type into.
  ///
  /// Not a process per button: fixing a cluster is rarely one command —
  /// `tsh login` and then the token, a tunnel left running, a second try
  /// with a different flag. Running the command as a line in a live shell
  /// keeps all of that in one transcript, lets the user edit it before it
  /// runs, and means a login no longer replaces a shell they were using.
  function runInShell(context: string, command?: string) {
    setError(null);
    const api = shellApi;
    if (loginTarget() && api) {
      if (command) api.send(command + "\n");
      else api.focus();
      return;
    }
    setLoginTarget({
      kind: "local",
      context,
      name: "local shell",
      initialCommand: command,
    });
  }

  function runLogin() {
    const h = authHint();
    if (!h) return;
    runInShell(h.context, h.command ?? undefined);
  }

  /// The command the cluster itself names, rather than one we inferred —
  /// the only one that is right when the kubeconfig points at a wrapper
  /// that does its own login first.
  function runCredentialCommand() {
    const h = authHint();
    if (!h?.exec_command) return;
    runInShell(h.context, h.exec_command);
  }

  function openLocalShell(context = "") {
    runInShell(context);
  }

  /// Closing unmounts the terminal, which stops the session and kills the
  /// shell — so this is also how a login is cancelled.
  /// `cancelled` means the user closed the window rather than the process
  /// ending on its own.
  function closeLogin(cancelled = false) {
    const t = loginTarget();
    setLoginTarget(null);
    shellApi = undefined;
    if (!t) return;
    // A pre-connect step the user walked out of has not happened, so
    // connecting anyway would just spend the timeout and put up a banner
    // for something they chose not to do.
    if (cancelled && t.oneShot) return;
    // No context behind it means it came from the picker, where the useful
    // thing afterwards is re-reading the kubeconfig: `tsh kube login` and
    // `aws eks update-kubeconfig` both write new contexts, and a stale list
    // would hide the cluster the user just went and got.
    if (!t.context) {
      void loadContexts(false);
      return;
    }
    // The shell says nothing about whether credentials got fixed, so
    // closing it always retries — a failed retry just puts back the banner
    // that was already there.
    setAuthHint(null);
    void reconnect(t.context);
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
    // kube-rs says "failed to load current context: <name>" when the name
    // isn't in the kubeconfig at all. That is what a restored tab hits
    // after the tool that wrote the entry took it back out — `tsh logout`
    // strips its kube contexts, and a rotated kubeconfig loses them too.
    if (/failed to load (?:the cluster of )?(?:current )?context/i.test(msg))
      return "this context is no longer in your kubeconfig — re-run the login that created it (tsh kube login, aws eks update-kubeconfig, gcloud container clusters get-credentials), then reconnect.";
    // kube-rs reports "failed to parse auth exec output" when the plugin
    // printed no ExecCredential — because it errored, or asked something
    // it could not ask, and wrote that to stderr instead.
    if (/parse auth exec output|auth exec/i.test(msg))
      return "this cluster's credential command produced no credentials — run it below to see what it wanted.";
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
    /401|403|Unauthorized|Forbidden|credential|token|expired|exec plugin|auth exec|exec output|no such host|refused|timed out|certificate/i.test(
      msg,
    );

  /// Drop the cached client and reconnect — the fix for an expired SSO
  /// token, since kubeconfig exec credentials are re-run on connect.
  async function reconnect(name: string) {
    beginConnect(name);
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
      if (abandoned.delete(name)) return;
      setError(`could not connect to ${name}: ${msg}`);
      if (isAuthError(msg)) void offerLogin(name);
    } finally {
      endConnect(name);
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
  // Pod-stat columns (CPU/%…/MEM/%…) splice into the MIDDLE of the column
  // list when metrics load, which would shift a positional sort onto the
  // wrong column. Reset the sort on that one layout change (a rare click
  // in the first second beats silently mis-sorting).
  let hadPodStats = false;
  createEffect(() => {
    const has = podStats() !== null;
    if (has !== hadPodStats) {
      hadPodStats = has;
      if (sortCol() !== null) setSortCol(null);
    }
  });
  const [colsOpen, setColsOpen] = createSignal(false);
  const [hiddenCols, setHiddenCols] = createSignal<Record<string, string[]>>(
    JSON.parse(localStorage.getItem("pigeoneye.cols") ?? "{}"),
  );

  // Per-kind column order (visible column names, in the user's drag
  // order). Persisted; columns not listed — new server columns, or ones
  // just un-hidden — append at the end in their original order.
  const [colOrder, setColOrderRaw] = createSignal<Record<string, string[]>>(
    JSON.parse(localStorage.getItem("pigeoneye.colorder") ?? "{}"),
  );
  const setColOrder = (next: Record<string, string[]>) => {
    setColOrderRaw(next);
    localStorage.setItem("pigeoneye.colorder", JSON.stringify(next));
  };
  const applyColOrder = (shown: string[]): string[] => {
    const ord = colOrder()[colKey()];
    if (!ord || !ord.length) return shown;
    const set = new Set(shown);
    const front = ord.filter((c) => set.has(c));
    const seen = new Set(front);
    return [...front, ...shown.filter((c) => !seen.has(c))];
  };
  // The column being dragged / the row we'd drop before. Pointer-based
  // (not HTML5 drag) because WKWebView barely fires drag events.
  const [dragCol, setDragCol] = createSignal<string | null>(null);
  const [dropCol, setDropCol] = createSignal<string | null>(null);
  // True while an actual drag is in progress, so the row's click handler
  // knows not to also toggle the column's visibility.
  let colDragActive = false;
  // Move `from` so it lands just before `target` in the full column order.
  function moveColumn(from: string, target: string) {
    if (from === target) return;
    const next = allColsOrdered().filter((c) => c !== from);
    const i = next.indexOf(target);
    next.splice(i < 0 ? next.length : i, 0, from);
    setColOrder({ ...colOrder(), [colKey()]: next });
    setSortCol(null);
  }
  // Begin a pointer drag on a column row (in the columns menu). Only
  // becomes a drag after the pointer moves a few px, so a plain click
  // still toggles show/hide.
  function startColDrag(e: PointerEvent, col: string) {
    if (e.button !== 0) return;
    const startY = e.clientY;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientY - startY) > 4) {
        active = true;
        colDragActive = true;
        setDragCol(col);
      }
      if (active) {
        const el = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest("[data-colname]");
        setDropCol(el?.getAttribute("data-colname") ?? null);
      }
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      const from = dragCol();
      const to = dropCol();
      if (active && from && to && from !== to) moveColumn(from, to);
      setDragCol(null);
      setDropCol(null);
      // let the click handler see the drag, then clear on the next tick
      if (active) setTimeout(() => (colDragActive = false), 0);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

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
    // also drop any custom drag order for this kind
    const ord = { ...colOrder() };
    delete ord[colKey()];
    setColOrder(ord);
    setSortCol(null);
  }
  // Whether every column is currently shown, and a one-click toggle to
  // show or hide them all (the columns-menu "select all" checkbox).
  const allColsShown = () =>
    allColsOrdered().every((c) => !hiddenFor().has(c));
  function toggleAllCols() {
    const all = allColsOrdered();
    const next = {
      ...hiddenCols(),
      [colKey()]: allColsShown() ? all.slice() : [],
    };
    setHiddenCols(next);
    localStorage.setItem("pigeoneye.cols", JSON.stringify(next));
    setSortCol(null);
  }

  // ── Custom columns (kubectl JSONPath) ───────────────────
  // Per-kind user columns: { name = header, path = JSONPath }. The values
  // are evaluated by the backend against the full objects (only fetched
  // when a kind actually has custom columns) and merged in as ordinary
  // columns, so sort/filter/hide/reorder all apply.
  const [customCols, setCustomColsRaw] = createSignal<
    Record<string, { name: string; path: string }[]>
  >(JSON.parse(localStorage.getItem("pigeoneye.customcols") ?? "{}"));
  const setCustomCols = (
    next: Record<string, { name: string; path: string }[]>,
  ) => {
    setCustomColsRaw(next);
    localStorage.setItem("pigeoneye.customcols", JSON.stringify(next));
  };
  // A stable empty array for the (common) no-custom-columns case, so the
  // baseRows display cache — keyed partly on this reference — isn't busted
  // on every recompute, which would rebuild all 24k rows per keystroke.
  const NO_CUSTOM_COLS: { name: string; path: string }[] = [];
  const myCustomCols = () => customCols()[colKey()] ?? NO_CUSTOM_COLS;
  function addCustomCol(name: string, path: string) {
    let n = name.trim();
    const p = path.trim();
    if (!n || !p) return;
    // Column lookups (sort, width, filters) are keyed by name, so a name
    // that collides with a built-in or existing column would act on the
    // wrong one. Suffix duplicates to keep every header unique.
    const taken = new Set(allColsOrdered());
    if (taken.has(n)) {
      let i = 2;
      while (taken.has(`${n}_${i}`)) i++;
      n = `${n}_${i}`;
    }
    setCustomCols({
      ...customCols(),
      [colKey()]: [...myCustomCols(), { name: n, path: p }],
    });
  }
  function removeCustomCol(i: number) {
    const cur = myCustomCols().slice();
    cur.splice(i, 1);
    const next = { ...customCols() };
    if (cur.length) next[colKey()] = cur;
    else delete next[colKey()];
    setCustomCols(next);
  }
  // rowKey (`ns/name`) → { path: value } for the NON-label custom columns
  // (those need the backend). Label columns are read straight from the
  // rows' own labels, no fetch.
  const [customData, setCustomData] = createSignal<
    Map<string, Record<string, string>>
  >(new Map());
  // If a path is just `.metadata.labels['key']` (or `.metadata.labels.key`)
  // return the key — those columns are free to evaluate client-side from
  // the labels already in every row, so huge lists don't trigger a full
  // re-download of every object.
  const labelPathKey = (path: string): string | null => {
    const m =
      path.match(/^\.metadata\.labels\['([^']+)'\]$/) ??
      path.match(/^\.metadata\.labels\.([A-Za-z0-9_./-]+)$/);
    return m ? m[1] : null;
  };
  const [customErr, setCustomErr] = createSignal<string>("");
  const [newColName, setNewColName] = createSignal("");
  const [newColPath, setNewColPath] = createSignal("");
  // One-click starters that also teach the syntax (label / annotation /
  // spec field / condition filter). Clicking fills both inputs.
  const CC_EXAMPLES: { label: string; name: string; path: string }[] = [
    {
      label: "a label",
      name: "INSTANCE-TYPE",
      path: ".metadata.labels['node.kubernetes.io/instance-type']",
    },
    { label: "a spec field", name: "INSTANCE-ID", path: ".spec.providerID" },
    {
      label: "a status condition",
      name: "READY",
      path: '.status.conditions[?(@.type=="Ready")].status',
    },
  ];
  function submitCustomCol() {
    addCustomCol(newColName(), newColPath());
    setNewColName("");
    setNewColPath("");
  }
  // The slim list already carries every row's labels, so the set of label
  // keys is free to collect client-side — no extra fetch. Pick one and it
  // becomes a column without typing any JSONPath.
  const [labelQuery, setLabelQuery] = createSignal("");
  // label key → a representative (first non-empty) value across the rows,
  // so the picker can preview a value and skip labels that are all-empty.
  const labelEntries = createMemo(() => {
    const m = new Map<string, string>();
    for (const r of table()?.rows ?? []) {
      for (const [k, v] of Object.entries(r.labels ?? {})) {
        if (v && !m.has(k)) m.set(k, v);
      }
    }
    return m;
  });
  const labelShort = (key: string) => (key.split("/").pop() ?? key).toUpperCase();
  // [path, sample value] from real objects (backend) — the non-label side
  // of the picker. Lazily fetched when the columns menu opens, cached per
  // kind so it isn't re-fetched.
  const [fieldEntries, setFieldEntries] = createSignal<[string, string][]>([]);
  const fieldCache = new Map<string, [string, string][]>();
  createEffect(() => {
    if (!colsOpen()) return;
    const rt = selected();
    const ctx = active();
    if (!rt || !ctx) return;
    const key = colKey();
    const cached = fieldCache.get(key);
    if (cached) {
      setFieldEntries(cached);
      return;
    }
    const ns = rt.namespaced ? namespace() : "";
    invoke<[string, string][]>("sample_fields", {
      context: ctx,
      resource: rt,
      namespace: ns || null,
    })
      .then((entries) => {
        fieldCache.set(key, entries);
        if (colKey() === key && colsOpen()) {
          setFieldEntries(entries);
          setCustomErr("");
        }
      })
      .catch((e) => {
        if (colKey() === key && colsOpen())
          setCustomErr(`could not load fields: ${String(e)}`);
      });
  });
  // A readable column name from a path: the discriminator of a filter
  // (`Ready`, `InternalIP`) if present, plus the trailing field when that
  // adds meaning (so `env[?name=="X"].value` and `…fieldRef.fieldPath`
  // don't both collapse to just `X`); else the last key segment.
  const pathShort = (p: string) => {
    const filt = [...p.matchAll(/=="([^"]+)"/g)];
    const disc = filt.length ? filt[filt.length - 1][1] : "";
    const tail =
      p
        .replace(/\[[^\]]*\]/g, "")
        .split(".")
        .filter(Boolean)
        .pop() ?? p;
    if (disc) {
      // the "obvious" leaf of a filtered array needs no suffix
      if (["value", "address", "status", "name"].includes(tail.toLowerCase()))
        return disc.toUpperCase();
      return `${disc}_${tail}`.toUpperCase();
    }
    return tail.toUpperCase();
  };
  // Everything you can click to add: labels (client-side) + sampled
  // fields (backend), each with a suggested name, its JSONPath, and a
  // sample value. Only non-empty ones — an all-blank column is pointless.
  const pickables = createMemo<
    { name: string; path: string; kind: "label" | "field"; val: string }[]
  >(() => {
    const out: {
      name: string;
      path: string;
      kind: "label" | "field";
      val: string;
    }[] = [];
    for (const [k, v] of [...labelEntries()].sort((a, z) =>
      a[0].localeCompare(z[0]),
    ))
      out.push({
        name: labelShort(k),
        path: `.metadata.labels['${k}']`,
        kind: "label",
        val: v,
      });
    for (const [p, v] of fieldEntries())
      out.push({ name: pathShort(p), path: p, kind: "field", val: v });
    return out;
  });

  // Re-evaluate whenever the kind, its custom columns, the namespace or
  // the cluster change. Not tied to the row stream, so a watch flush
  // doesn't refetch every object; reselect the kind to refresh new rows.
  createEffect(() => {
    const rt = selected();
    const ctx = active();
    const cols = myCustomCols();
    const ns = rt?.namespaced ? namespace() : "";
    // Only the non-label paths need the (heavy) full-object fetch; label
    // columns are evaluated from the rows we already have.
    const backendPaths = cols
      .map((c) => c.path)
      .filter((p) => !labelPathKey(p));
    if (!rt || !ctx || backendPaths.length === 0) {
      setCustomData(new Map());
      setCustomErr("");
      return;
    }
    const want = colKey();
    invoke<[string, string[]][]>("custom_columns", {
      context: ctx,
      resource: rt,
      namespace: ns || null,
      fieldSelector: null,
      paths: backendPaths,
    })
      .then((pairs) => {
        if (colKey() !== want) return;
        const m = new Map<string, Record<string, string>>();
        for (const [rowKey, vals] of pairs) {
          const rec: Record<string, string> = {};
          backendPaths.forEach((p, i) => (rec[p] = vals[i] ?? ""));
          m.set(rowKey, rec);
        }
        setCustomData(m);
        setCustomErr("");
      })
      .catch((e) => {
        if (colKey() !== want) return;
        setCustomErr(String(e));
        setCustomData(new Map());
      });
  });
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

  // True while space is down. Nothing reports a held key on later events,
  // so it is tracked, and released on keyup or when the window loses focus
  // — a keyup that arrives elsewhere would otherwise leave it stuck on.
  let spaceHeld = false;
  const sweepFrom = () => {
    if (!spaceHeld) return;
    const vr = view().rows[cursor()];
    if (vr) markRow(vr.row);
  };
  const sweepTo = sweepFrom;

  /// Add to the selection without toggling — what a range extension needs,
  /// since sweeping back over a row must not unmark it.
  function markRow(r: TableRow) {
    const k = rowKeyOf(r);
    if (marked().has(k)) return;
    setMarked(new Set(marked()).add(k));
  }

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
  // Which level the keyboard is driving right now, so it can be outlined —
  // a keyboard user always sees where they are (sidebar → table → detail →
  // terminal). Terminal focus and an open detail take precedence over pane.
  const activePane = (): "sidebar" | "table" | "detail" | "terminal" =>
    termDockFocused() && shells().length > 0 && !termMin()
      ? "terminal"
      : detailKey()
        ? "detail"
        : pane();
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
  // Pre-authorize a force apply from the editor bar, so Apply shows only its
  // one warning and skips the follow-up conflict/"changed on server" prompt.
  const [forceApply, setForceApply] = createSignal(false);
  const [dryRun, setDryRun] = createSignal<{ ok: boolean; text: string } | null>(
    null,
  );
  function runDryRun() {
    const rt = selected();
    const d = detail();
    const ctx = active();
    if (!rt || !d || !ctx) return;
    setActionBusy("dryrun");
    void invoke<string>("dry_run_apply", {
      context: ctx,
      resource: rt,
      namespace: d.namespace,
      name: d.name,
      yaml: yamlText(),
    })
      .then((text) => {
        setActionBusy(null);
        setDryRun({ ok: true, text });
      })
      .catch((e) => {
        setActionBusy(null);
        setDryRun({ ok: false, text: prettyError(String(e)) });
      });
  }

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
  // Per-event copy feedback (which event just showed "✓").
  const [copiedEv, setCopiedEv] = createSignal<EventInfo | null>(null);
  // "copy all" (events) and per-secret-value copy feedback.
  const [copiedAll, setCopiedAll] = createSignal(false);
  const [copiedSecret, setCopiedSecret] = createSignal<string | null>(null);
  // Pods running on the open node, shown inline so you don't have to
  // navigate away to see what a node is carrying.
  const [nodePods, setNodePods] = createSignal<ResourceTable | null>(null);
  const [nodePodsLoading, setNodePodsLoading] = createSignal(false);
  const [nodePodsErr, setNodePodsErr] = createSignal("");
  // The default (priority 0) printer columns, paired with their cell
  // index — same set the main list shows, minus the wide extras.
  const nodePodCols = createMemo(() => {
    const t = nodePods();
    if (!t) return [] as { c: ColumnDef; i: number }[];
    return t.columns
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.priority === 0);
  });

  /// One event as a self-contained block. Events don't name the object
  /// they belong to — a node's events read as bare "reason: message" —
  /// so we prepend the open resource's identity, otherwise a pasted
  /// event says nothing about *which* node/pod it came from.
  function eventText(ev: EventInfo): string {
    const when = ev.last ? `${age(ev.last)} ago` : "";
    const meta = [when, ev.count > 1 ? `${ev.count}×` : "", ev.source]
      .filter(Boolean)
      .join(" · ");
    return `[${ev.type_}] ${ev.reason} — ${ev.message}${meta ? `  (${meta})` : ""}`;
  }
  async function copyEvent(ev: EventInfo) {
    const who = detail() ? `${selected()?.kind ?? ""}/${detail()!.name}\n` : "";
    try {
      await navigator.clipboard.writeText(who + eventText(ev));
      setCopiedEv(ev);
      setTimeout(() => setCopiedEv((c) => (c === ev ? null : c)), 1200);
    } catch (e) {
      setActionErr(`could not copy: ${String(e)}`);
    }
  }
  async function copyAllEvents() {
    const who = detail() ? `${selected()?.kind ?? ""}/${detail()!.name}\n` : "";
    try {
      await navigator.clipboard.writeText(who + events().map(eventText).join("\n"));
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1200);
    } catch (e) {
      setActionErr(`could not copy: ${String(e)}`);
    }
  }
  /// Copy one decoded Secret value, with per-row "copied ✓" feedback.
  async function copySecret(k: string, v: string) {
    try {
      await navigator.clipboard.writeText(v);
      setCopiedSecret(k);
      setTimeout(() => setCopiedSecret((c) => (c === k ? null : c)), 1200);
    } catch (e) {
      setActionErr(`could not copy: ${String(e)}`);
    }
  }

  /// Which section of the open detail panel the keyboard is on.
  const [panelSec, setPanelSec] = createSignal<string>("meta");
  const [actionIdx, setActionIdx] = createSignal(0);
  // In a content section (not a button row), -1 = the section header is
  // focused (Enter toggles / opens), 0+ = one of its aux buttons (copy) is
  // focused via →, so those buttons are keyboard-reachable too.
  const [secBtn, setSecBtn] = createSignal(-1);

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
    const isNodeKind = selected()?.group === "" && selected()?.kind === "Node";
    return [
      // The header's "share view" sits above everything — ↑ from the actions
      // row reaches it, matching where it is on screen.
      "share",
      "actions",
      ...(isNodeKind && (nodePods()?.rows.length ?? 0) > 0 ? ["nodepods"] : []),
      ...(d.containers?.length ? ["containers"] : []),
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
    share: ".drawer-head .share-btn",
    actions: ".drawer .actions",
    containers: ".drawer .ctr-list",
    apply: ".drawer .yaml-actions",
  };

  // Aux buttons inside a *content* section (copy / copy all) — reachable
  // with → even though the section's Enter still does its primary action
  // (toggle the fold / open the editor).
  const SECTION_BUTTONS: Record<string, string> = {
    events: ".drawer [data-sec='events'] .ev-copyall",
    yaml: ".drawer [data-sec='yaml'] .copy-btn",
  };
  function sectionButtons(sec: string): HTMLElement[] {
    const sel = SECTION_BUTTONS[sec];
    if (!sel) return [];
    return [...document.querySelectorAll<HTMLElement>(`${sel}:not(:disabled)`)];
  }
  function paintSecBtn(sec: string, idx: number) {
    document
      .querySelectorAll(".btn-cursor")
      .forEach((el) => el.classList.remove("btn-cursor"));
    const el = sectionButtons(sec)[idx];
    if (el) {
      el.classList.add("btn-cursor");
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }

  function rowItems(sec: string): HTMLElement[] {
    const sel = BUTTON_ROWS[sec];
    if (!sel) return [];
    // Checkboxes (the Apply row's "force") are navigable too; click()
    // toggles them just like Enter/Space on a button.
    // Match buttons INSIDE the selector (an action bar) *and* the selector
    // itself when it is the button (the header's lone "share view"). A Set
    // keeps order and de-dupes.
    const q = 'button, input[type="checkbox"]';
    return [
      ...new Set<HTMLElement>([
        ...document.querySelectorAll<HTMLElement>(`${sel}:is(${q}):not(:disabled)`),
        ...document.querySelectorAll<HTMLElement>(`${sel} :is(${q}):not(:disabled)`),
      ]),
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
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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
    setSecBtn(-1); // new section → land on its header, not an aux button
    // Always bring the section into view first — Apply/Reset are
    // disabled until the manifest changes, so a cursor-only scroll
    // would leave the row off-screen.
    document
      .querySelector(`.psec[data-sec="${sec}"]`)
      ?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
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
  // Whether the "all namespaces" option is shown, and the full ordered
  // list of selectable values (""=all) the keyboard cursor walks.
  const nsShowAll = () => {
    const q = nsQuery().toLowerCase().trim();
    return !q || "all namespaces".includes(q);
  };
  const nsItems = createMemo<string[]>(() => [
    ...(nsShowAll() ? [""] : []),
    ...nsFiltered(),
  ]);
  const [nsIdx, setNsIdx] = createSignal(0);
  const scrollNsCursor = () =>
    requestAnimationFrame(() =>
      document
        .querySelector(`.ns-item[data-nsi="${nsIdx()}"]`)
        ?.scrollIntoView?.({ block: "nearest" }),
    );

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
      filter: "",
    });
  }

  function activate(name: string) {
    // Remember the outgoing tab's row filter so it comes back on return.
    const cur = active();
    if (cur && cur !== name) {
      const cst = tabCache.get(cur);
      if (cst) cst.filter = rowFilter();
    }
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
    if (sel) {
      // Restore this tab's filter and re-apply it once the list loads
      // (select() keeps rowFilter when told to).
      setRowFilter(st.filter);
      void select(sel, undefined, true);
    }
    persist();
  }

  async function openContext(name: string) {
    if (tabCache.has(name)) {
      if (!tabs().includes(name)) setTabs([...tabs(), name]);
      activate(name);
      return;
    }
    // Do the prerequisite first, in the open, rather than letting the
    // connection hang on a credential that was never going to work. The
    // panel connects on its own once the command exits clean.
    const pre = preCmds()[name];
    if (pre && !preRan.has(name)) {
      setError(null);
      setLoginTarget({
        kind: "local",
        context: name,
        name: "pre-connect",
        initialCommand: pre,
        oneShot: true,
      });
      return;
    }
    beginConnect(name);
    setError(null);
    try {
      await setupContext(name);
      setTabs([...tabs(), name]);
      activate(name);
    } catch (e) {
      const msg = String(e);
      if (abandoned.delete(name)) return;
      setError(`could not connect to ${name}: ${msg}`);
      setFailed([...failed().filter((f) => f.name !== name), { name, error: msg }]);
      // The pre-connect command ran and we still could not connect, so it
      // did not do the job — let the next attempt run it again rather than
      // silently skipping the one step that might fix things.
      preRan.delete(name);
      if (isAuthError(msg)) void offerLogin(name);
    } finally {
      endConnect(name);
    }
  }

  // ── deep links (peye://) ───────────────────────────────
  // Share the exact view — context, kind, namespace, filter, open resource —
  // as a peye:// link. Opening it drives the same navigation on the other
  // side (as long as they have that context in their kubeconfig). No secrets
  // travel in the URL; each side authenticates with its own kubeconfig.
  const [sharedCopied, setSharedCopied] = createSignal(false);
  const serverHost = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };
  function currentViewLink(): string | null {
    const ctx = active();
    if (!ctx) return null;
    const p = new URLSearchParams();
    p.set("ctx", ctx);
    // The cluster's server host identifies the cluster independently of the
    // local context name, so the recipient can match it even if they named
    // the same cluster differently.
    const host = serverHost(contexts().find((c) => c.name === ctx)?.server ?? "");
    if (host) p.set("cluster", host);
    const s = selected();
    if (s) p.set("k", typeKey(s));
    const d = detail();
    // Address by the resource's OWN namespace when a detail is open — the
    // view's namespace filter is empty in the all-namespaces list, but the
    // resource still lives in one, and a link with a name but no namespace
    // can't open a namespaced resource. Fall back to the view's namespace.
    const ns = d?.namespace || namespace();
    if (ns) p.set("ns", ns);
    const fs = activeFieldSel();
    if (fs) p.set("fs", fs);
    const q = rowFilter().trim();
    if (q) p.set("q", q);
    if (d) p.set("name", d.name);
    return `peye://open?${p.toString()}`;
  }
  async function copyShareLink() {
    const link = currentViewLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setSharedCopied(true);
      setTimeout(() => setSharedCopied(false), 1400);
    } catch (e) {
      setError(`could not copy link: ${String(e)}`);
    }
  }

  // A link that arrives before the app is ready (a cold-started peye:// link
  // fires getCurrent() before the context list loads and the previous
  // session restores). Held here and retried by the effect below once both
  // are done — applying early would bypass host-matching, misread the
  // kubeconfig source, and get clobbered by the session restore.
  let pendingLink: string | null = null;
  // A deep link whose cluster/context isn't in this kubeconfig — surfaced as
  // a modal so it's unmissable, with an "add this cluster" hint.
  const [deepLinkMiss, setDeepLinkMiss] = createSignal<{
    ctx: string;
    host: string;
  } | null>(null);
  /// Guess the cluster's provider from its API-server host and give the
  /// command that adds it. EKS/AKS encode region (and AKS the name) in the
  /// host so those are exact; GKE/DigitalOcean can't be fully derived (GKE
  /// endpoints are bare IPs), so they get a template with placeholders.
  /// Anything unrecognised (native/on-prem) returns no command.
  function clusterAddHint(
    host: string,
    ctx: string,
  ): { provider: string; cmd: string | null } {
    const name = ctx || "<cluster-name>";
    let m = host.match(/\.([a-z]{2}-[a-z]+-\d)\.eks\.amazonaws\.com$/i);
    if (m)
      return {
        provider: "EKS",
        cmd: `aws eks update-kubeconfig --name ${name} --region ${m[1]} --alias ${name}`,
      };
    // AKS: <name>-<hash>.hcp.<region>.azmk8s.io — name & region parseable.
    m = host.match(/^([a-z0-9-]+?)-[a-z0-9]+\.hcp\.([a-z0-9]+)\.azmk8s\.io$/i);
    if (m)
      return {
        provider: "AKS",
        cmd: `az aks get-credentials --resource-group <resource-group> --name ${m[1]}`,
      };
    if (/\.k8s\.ondigitalocean\.com$/i.test(host))
      return {
        provider: "DigitalOcean",
        cmd: `doctl kubernetes cluster kubeconfig save ${name}`,
      };
    if (/\.gke\.goog$/i.test(host) || /\bgoogleapis\.com$/i.test(host))
      return {
        provider: "GKE",
        cmd: `gcloud container clusters get-credentials ${name} --location <region-or-zone> --project <project>`,
      };
    return { provider: "", cmd: null };
  }
  const [dlCopied, setDlCopied] = createSignal(false);
  async function copyDlCmd(cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      setDlCopied(true);
      setTimeout(() => setDlCopied(false), 1400);
    } catch {
      /* ignore */
    }
  }
  createEffect(() => {
    const ready = contexts().length > 0 && !restoring();
    active(); // also retry when a connection lands (post-login/pre-connect)
    if (ready && pendingLink) {
      const u = pendingLink;
      pendingLink = null;
      void applyDeepLink(u);
    }
  });

  /// Drive navigation from a peye://open?… link. Best-effort: a step that
  /// can't be satisfied (context not in this kubeconfig, kind not served)
  /// stops the chain with an error rather than throwing.
  async function applyDeepLink(url: string) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== "peye:" || u.hostname !== "open") return;
    // Not ready yet (cold start): hold the link and let the effect retry it.
    if (contexts().length === 0 || restoring()) {
      pendingLink = url;
      return;
    }
    const p = u.searchParams;
    // Prefer matching the cluster by its server host (name-independent);
    // fall back to the literal context name the link was made with.
    const wantHost = p.get("cluster");
    const named = p.get("ctx");
    const byHost = wantHost
      ? contexts().find((c) => serverHost(c.server) === wantHost)?.name
      : undefined;
    const byName =
      named && contexts().some((c) => c.name === named) ? named : undefined;
    const ctx = byHost ?? byName;
    if (!ctx) {
      // Neither the cluster (by server host) nor the named context exists in
      // this kubeconfig — pop the "add this cluster" modal.
      if (named || wantHost)
        setDeepLinkMiss({ ctx: named ?? "", host: wantHost ?? "" });
      return;
    }
    await openContext(ctx);
    if (active() !== ctx) {
      // A login or pre-connect step is up (openContext returns before
      // connecting): hold the link and re-apply once the tab connects,
      // rather than dropping the target view. Otherwise openContext already
      // surfaced its own auth/connect error.
      if (loginTarget() || authHint()?.context === ctx) pendingLink = url;
      return;
    }
    const k = p.get("k");
    if (!k) return;
    const t = types().find((x) => typeKey(x).toLowerCase() === k.toLowerCase());
    if (!t) {
      setError(`${k} is not served by ${ctx}`);
      return;
    }
    const ns = p.get("ns");
    if (ns && t.namespaced) {
      const st = tabCache.get(active()!);
      if (st) st.namespace = ns;
      setNamespace(ns);
    }
    await select(t, p.get("fs") || undefined);
    const q = p.get("q");
    if (q) onRowFilterInput(q);
    const name = p.get("name");
    if (name) {
      if (t.namespaced && !ns) {
        // A namespaced resource can't be opened without a namespace — an
        // older/partial link. Locate it in the list instead of erroring.
        onRowFilterInput(name);
      } else {
        await showDetail(t.namespaced ? ns : null, name);
      }
    }
    revealInSidebar(t);
  }

  // Register both entry points: onOpenUrl for a link opened while running,
  // getCurrent for the URL that cold-started the app.
  onMount(() => {
    void onOpenUrl((urls) => {
      if (urls[0]) void applyDeepLink(urls[0]);
    }).catch(() => {});
    void getCurrentDeepLinks()
      .then((urls) => {
        if (urls && urls[0]) void applyDeepLink(urls[0]);
      })
      .catch(() => {});
  });

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
        stopWatch(); // no view left to feed — don't leak the watch
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
      setRestoring(false);
    }
  }

  // Previous session: all saved tabs reconnect in parallel, the last
  // active tab wins focus back.
  function restoreSession(cs: ContextInfo[]) {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      setRestoring(false);
      return;
    }
    const saved = JSON.parse(raw) as { tabs: string[]; active: string | null };
    const known = new Set(cs.map((c) => c.name));
    const wanted = (saved.tabs ?? []).filter((t) => known.has(t));
    if (!wanted.length) {
      setRestoring(false);
      return;
    }
    wanted.forEach(beginConnect);
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
      .finally(() => {
        wanted.forEach(endConnect);
        setRestoring(false);
      });
  }

  // On launch, reconnect every cluster tab from last session (the
  // launcher only shows when there's nothing to restore).
  void loadContexts(true);

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
  // Reactive mirror of `indexed`: false until the current list's full-text
  // index is built. While a filter is active and this is false, the count
  // is provisional (deep-field matches haven't been scanned yet), so the
  // badge shows "searching…" instead of a misleading "0".
  const [deepReady, setDeepReady] = createSignal(false);

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
          setIndexing(true);
          if (!indexPromise) {
            const buildSeq = listSeq;
            indexPromise = invoke("ensure_index").finally(() => {
              // A resource switch during the build bumps listSeq and
              // resets these flags; don't let this stale build mark the
              // new list as indexed.
              if (buildSeq !== listSeq) return;
              indexed = true;
              setDeepReady(true);
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
        // Index build failed (offline, etc.): settle the UI on whatever the
        // seed matched rather than spinning "searching…" forever.
        setIndexing(false);
        setDeepReady(true);
      }
    }, 80);
  }

  async function select(
    rt: ResourceType,
    fieldSelector?: string,
    keepFilter = false,
  ) {
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
    // Changing kind drops the filter (it's column/kind-specific); a tab
    // restore passes keepFilter so the caller's restored filter survives.
    if (!keepFilter) setRowFilter("");
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
    setDeepReady(false);
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
          const buildSeq = listSeq;
          setIndexing(true);
          indexPromise = invoke("ensure_index")
            .then(() => {
              if (active() === ctx && selected() === rt) void loadPodStats(ctx, ns);
            })
            .finally(() => {
              if (buildSeq !== listSeq) return; // superseded by a switch
              indexed = true;
              setDeepReady(true);
              indexPromise = null;
              setIndexing(false);
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
      // Re-apply a restored filter against the cached rows (the full-fetch
      // path does the same once its first page lands).
      else if (active() === ctx && selected() === rt && rowFilter().trim())
        onRowFilterInput(rowFilter());
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
        const hasReq = stats.some((s) => s.cpu_r || s.cpu_l || s.mem_r || s.mem_l);
        // Set on the first pass (live CPU/MEM) and once requests/limits
        // land; skip the noisy intermediate re-sets that would rebuild all
        // 24k display rows just for jittering live values.
        if (attempt === 0 || hasReq) {
          setPodStats(new Map(stats.map((s) => [s.key, s])));
        }
        if (hasReq) return;
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

  /// The return trip for `jumpToPodsOnNode`: switch back to Nodes (which
  /// drops the spec.nodeName filter) and reopen the node we came from.
  async function backToNode(name: string) {
    const t = types().find((x) => x.group === "" && x.kind === "Node");
    if (!t) return;
    await select(t);
    await showDetail(null, name);
  }

  /// The pods on a node, fetched for the inline list in the node panel.
  /// `key` guards against a stale response landing after the user has
  /// opened a different node. `silent` refreshes in place (no spinner, no
  /// blanking) — used by the drain poll so the list updates without a
  /// flash every couple of seconds.
  async function loadNodePods(nodeName: string, key: string, silent = false) {
    const pod = types().find((x) => x.group === "" && x.kind === "Pod");
    if (!pod) return;
    if (!silent) {
      setNodePods(null);
      setNodePodsErr("");
      setNodePodsLoading(true);
    }
    try {
      const t = await invoke<ResourceTable>("list_snapshot", {
        context: active(),
        resource: pod,
        namespace: null,
        fieldSelector: `spec.nodeName=${nodeName}`,
      });
      if (detailKey() === key) setNodePods(t);
    } catch (e) {
      if (!silent && detailKey() === key) setNodePodsErr(String(e));
    } finally {
      if (!silent && detailKey() === key) setNodePodsLoading(false);
    }
  }

  // Live drain progress. drain_node only *issues* evictions and returns, so
  // pods then terminate over their grace period — polling the node's pod
  // list is how you actually watch them go. Three terminal states: draining
  // (in flight), done (only DaemonSet/mirror pods left = a complete drain),
  // stalled (something refuses to leave, almost always a PDB).
  const [draining, setDraining] = createSignal<string | null>(null);
  const [drainDone, setDrainDone] = createSignal<string | null>(null);
  const [drainStalled, setDrainStalled] = createSignal<string | null>(null);
  let drainPollId: number | undefined;
  const drainRemaining = createMemo(() => {
    const t = nodePods();
    if (!t) return null;
    // Evictable = what drain won't skip. DaemonSet pods are skipped (the
    // DaemonSet controller re-places them, so drain leaves them); mirror
    // pods are rare and not distinguishable from a row, so this is a
    // close-enough "still to go" count.
    const evictable = t.rows.filter((r) => r.owner_kind !== "DaemonSet").length;
    return { total: t.rows.length, evictable };
  });
  function resetDrainState() {
    setDrainDone(null);
    setDrainStalled(null);
  }
  function stopDrainPoll() {
    if (drainPollId != null) window.clearInterval(drainPollId);
    drainPollId = undefined;
    setDraining(null);
  }
  function startDrainPoll(node: string) {
    stopDrainPoll();
    resetDrainState();
    setDraining(node);
    const key = `/${node}`; // nodes are cluster-scoped: showDetail key is "/<name>"
    const started = Date.now();
    let prev = -1;
    let stall = 0;
    const tick = async () => {
      // Only meaningful while looking at this node; give up after 5 min.
      if (detailKey() !== key || Date.now() - started > 5 * 60 * 1000) {
        stopDrainPoll();
        return;
      }
      await loadNodePods(node, key, true);
      if (detailKey() !== key) return;
      // Only judge off a real pod list — a null list (load failed) must not
      // read as "0 evictable".
      const rem = drainRemaining();
      if (!rem) return;
      if (rem.evictable === 0) {
        // Only DaemonSet/mirror pods left: that IS a complete drain (kubectl
        // drain --ignore-daemonsets stops here too). Node is ready to remove.
        setDrainDone(node);
        stopDrainPoll();
        return;
      }
      // No progress for ~20s → something is refusing to be evicted, almost
      // always a PodDisruptionBudget. Stop spinning and say what's stuck.
      if (rem.evictable === prev) {
        if (++stall >= 8) {
          setDrainStalled(node);
          stopDrainPoll();
        }
      } else {
        stall = 0;
        prev = rem.evictable;
      }
    };
    drainPollId = window.setInterval(() => void tick(), 2500);
    void tick();
  }
  onCleanup(stopDrainPoll);

  /// Drill from a pod in the node's inline list into that pod's own
  /// detail — landing on the pods-on-node view so the "← node" trail back
  /// is still there.
  async function openPodFromNode(nodeName: string, ns: string | null, podName: string) {
    const pod = types().find((x) => x.group === "" && x.kind === "Pod");
    if (!pod) return;
    if (ns) {
      const st = tabCache.get(active()!);
      if (st) st.namespace = ns;
      setNamespace(ns);
    }
    await select(pod, `spec.nodeName=${nodeName}`);
    await showDetail(ns, podName);
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
    setForceApply(false); // force is opt-in per resource, never sticky
    setEvents([]);
    setActionMsg(null);
    setActionErr(null);
    setScaleInput("");
    setFindQ("");
    setPanelSec("actions");
    setActionIdx(0);
    setSecBtn(-1);
    setNodePods(null);
    setNodePodsErr("");
    resetDrainState(); // the "drained/stalled" chip belongs to one node view
    setDetailLoading(true);
    // Events (and, for a node, its pod list) don't depend on the detail
    // fetch, so fire them in parallel instead of after it. Gating them
    // behind the heavier manifest/status pull is what made node events
    // feel laggy — they only started once fetchDetail had resolved.
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
    if (selected()?.group === "" && selected()?.kind === "Node") {
      void loadNodePods(name, key);
    }
    try {
      const d = await fetchDetail(namespace, name);
      if (detailKey() !== key) return; // user moved on
      if (d) {
        setDetail(d);
        setYamlText(d.yaml);
      }
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

  // The user's pins, resolved against what discovery found. A pinned CRD
  // that this cluster doesn't have is skipped here but kept in pinGroups(),
  // so it comes back on a cluster that does have it.
  const favKeys = createMemo(
    () => new Set(pinGroups().flatMap((g) => g.keys)),
  );
  // Each pin group with its present kinds resolved, in the group's order.
  const groupTypes = createMemo<{ name: string; types: ResourceType[] }[]>(
    () => {
      const byKey = new Map(types().map((t) => [typeKey(t), t]));
      return pinGroups().map((g) => ({
        name: g.name,
        types: g.keys
          .map((k) => byKey.get(k))
          .filter((t): t is ResourceType => !!t),
      }));
    },
  );
  const favTypes = createMemo<ResourceType[]>(() =>
    groupTypes().flatMap((g) => g.types),
  );

  // Essential panel: curated categories resolved against discovery, minus
  // anything the user pinned (a pin is promoted into ★ Pinned above, not
  // shown twice).
  const pinned = createMemo(() => {
    const byKey = new Map(types().map((t) => [typeKey(t), t]));
    const fk = favKeys();
    return CATEGORIES.map(([name, kinds]) => ({
      name,
      types: kinds
        .map(([g, k]) => byKey.get(`${g}/${k}`))
        .filter((t): t is ResourceType => !!t && !fk.has(typeKey(t))),
    })).filter((c) => c.types.length > 0);
  });

  // Everything already shown above the CRD/More groups: curated pins plus
  // user pins. Those groups exclude these so nothing shows twice.
  const shownKeys = createMemo(
    () =>
      new Set([
        ...pinned().flatMap((c) => c.types.map(typeKey)),
        ...favKeys(),
      ]),
  );

  // Every non-builtin group is someone's CRD — surface them all, always,
  // except a kind already shown above (curated or pinned) so it doesn't
  // also show under its raw group.
  const customGroups = createMemo(() => {
    const sk = shownKeys();
    const byGroup = new Map<string, ResourceType[]>();
    for (const t of types()) {
      if (isBuiltinGroup(t.group) || sk.has(typeKey(t))) continue;
      if (!byGroup.has(t.group)) byGroup.set(t.group, []);
      byGroup.get(t.group)!.push(t);
    }
    return [...byGroup.entries()];
  });

  // Builtins that didn't make the pinned cut, tucked under "More".
  const restGroups = createMemo(() => {
    const sk = shownKeys();
    const byGroup = new Map<string, ResourceType[]>();
    for (const t of types()) {
      if (!isBuiltinGroup(t.group) || sk.has(typeKey(t))) continue;
      const key = t.group || "core";
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(t);
    }
    return [...byGroup.entries()];
  });

  const isFav = (t: ResourceType) => favKeys().has(typeKey(t));
  // Pin one or more kinds into a named group (creating it if needed),
  // removing them from any other group first so a kind lives in exactly
  // one group. Pinning a whole CRD group passes all its kinds at once.
  function pinTypesToGroup(list: ResourceType[], groupName: string) {
    const keys = new Set(list.map(typeKey));
    let groups = pinGroups();
    if (!groups.some((g) => g.name === groupName))
      groups = [...groups, { name: groupName, keys: [] }];
    setPinGroups(
      groups.map((g) => {
        if (g.name === groupName) {
          const merged = [...g.keys];
          for (const k of keys) if (!merged.includes(k)) merged.push(k);
          return { ...g, keys: merged };
        }
        return { ...g, keys: g.keys.filter((x) => !keys.has(x)) };
      }),
    );
    setPinPick(null);
  }
  const pinToGroup = (t: ResourceType, groupName: string) =>
    pinTypesToGroup([t], groupName);
  function unpin(t: ResourceType) {
    const k = typeKey(t);
    setPinGroups(
      pinGroups().map((g) => ({ ...g, keys: g.keys.filter((x) => x !== k) })),
    );
  }
  function renameGroup(oldName: string, next: string) {
    const n = next.trim();
    if (!n || pinGroups().some((g) => g.name === n)) return;
    setPinGroups(
      pinGroups().map((g) => (g.name === oldName ? { ...g, name: n } : g)),
    );
  }
  function deleteGroup(name: string) {
    const next = pinGroups().filter((g) => g.name !== name);
    setPinGroups(next.length ? next : [{ name: "Pinned", keys: [] }]);
  }

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
    const out = [...favTypes(), ...pinned().flatMap((c) => c.types)];
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
      ?.scrollIntoView?.({ block: "nearest" });
  }

  function enterSidebarItem() {
    const t = sidebarItems()[sideIdx()];
    if (!t) return;
    setPane("table");
    void select(t);
  }

  /// Surface a kind in the sidebar: open the panel, clear any kind
  /// filter, expand the CRD/More group that holds it, then scroll to it
  /// and land the cursor there. Used after the `:` palette selects a kind
  /// so you can pin it straight away.
  function revealInSidebar(t: ResourceType) {
    const k = typeKey(t);
    if (!sidebarOpen()) {
      setSidebarOpen(true);
      localStorage.setItem("pigeoneye.sidebar", "open");
    }
    setFilter("");
    const custom = customGroups().find(([, ts]) =>
      ts.some((x) => typeKey(x) === k),
    );
    if (custom) {
      if (!groupOpen(custom[0])) toggleGroup(custom[0]);
    } else if (
      restGroups().some(([, ts]) => ts.some((x) => typeKey(x) === k))
    ) {
      if (!groupOpen("__more")) toggleGroup("__more");
    }
    // group expansion changes sidebarItems(); wait a frame for it to
    // settle before locating the row. Scroll it into view and position the
    // sidebar cursor there, but DON'T steal keyboard focus — after a `:`
    // pick the keyboard belongs to the table rows; the sidebar just
    // highlights the picked kind (via its `active` state).
    requestAnimationFrame(() => {
      const idx = sidebarItems().findIndex((x) => typeKey(x) === k);
      if (idx < 0) return;
      setSideIdx(idx);
      document
        .querySelector(`.kind[data-sk="${idx}"]`)
        ?.scrollIntoView?.({ block: "center" });
    });
  }

  /// Display cells for every row, built once per list — not per
  /// keystroke. On a 24k-pod cluster rebuilding this while typing was
  /// what made search collapse.
  // TableRow → its built DisplayRow, so unchanged rows skip rebuilding.
  let dispCache = new Map<TableRow, DisplayRow>();
  let dispCacheStats: Map<string, PodStat> | Map<string, NodeStat> | null = null;
  let dispCacheCustom: Map<string, Record<string, string>> | null = null;
  let dispCacheCcols: { name: string; path: string }[] | null = null;
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
    // User-defined columns, appended last. Label columns read straight
    // from the row's labels; other paths come from the backend eval.
    const ccols = myCustomCols();
    if (ccols.length) cols = [...cols, ...ccols.map((c) => c.name)];
    const ccolKeys = ccols.map((c) => labelPathKey(c.path));
    const needBackend = ccolKeys.some((k) => k === null);
    const cdata = needBackend ? customData() : null;
    // One object identifies "the stats in play" for the row cache.
    const activeStats = stats ?? nstats;

    // Reuse the display row for any TableRow object that hasn't
    // changed identity — a watch flush replaces only touched rows, so
    // this rebuilds a handful instead of all 24k.
    const prev =
      dispCacheStats === activeStats &&
      dispCacheCustom === cdata &&
      dispCacheCcols === ccols
        ? dispCache
        : null;
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
      if (ccols.length) {
        const rec = needBackend
          ? cdata?.get(`${r.namespace ?? ""}/${r.name}`)
          : undefined;
        cells = [
          ...cells,
          ...ccols.map((c, i) => {
            const lk = ccolKeys[i];
            if (lk !== null) return r.labels?.[lk] ?? "";
            return rec?.[c.path] ?? "";
          }),
        ];
      }
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
    dispCacheCustom = cdata;
    dispCacheCcols = ccols;
    return { cols, rows };
  });

  /// Column widths follow the data, but sampling the first rows is
  /// enough — scanning 24k rows on every change is not.
  // Display column order: base columns minus hidden, then the user's drag
  // order. Independent of the row filter so headers/widths don't rebuild
  // on every keystroke. The header, widths and view() all read this so
  // they can never disagree on order.
  const displayCols = createMemo(() => {
    const b = baseRows();
    const hide = hiddenFor();
    return applyColOrder(
      hide.size ? b.cols.filter((c) => !hide.has(c)) : b.cols,
    );
  });

  // Every column (visible + hidden) in the user's drag order — what the
  // columns menu lists so you can reorder by dragging its rows.
  const allColsOrdered = createMemo(() => applyColOrder(baseRows().cols));

  const colWidths = createMemo(() => {
    const b = baseRows();
    const idxOf = new Map(b.cols.map((c, i) => [c, i] as const));
    const sample = b.rows.slice(0, 600);
    return displayCols().map((c) => {
      const bi = idxOf.get(c) ?? -1;
      let max = c.length + 2;
      for (const r of sample) {
        const len = bi >= 0 ? (r.cells[bi]?.length ?? 0) : 0;
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

    // The sort index comes from the DISPLAYED columns (thead iterates
    // view().cols), but cells here are still the full base set — map the
    // displayed index back to the base-cells index by column name, or
    // hiding/reordering a column would sort a different one.
    const shownCols = displayCols();
    const sc = sortCol();
    const sortIdx =
      sc !== null && sc >= 0 && sc < shownCols.length
        ? b.cols.indexOf(shownCols[sc])
        : -1;
    if (sortIdx >= 0) {
      const dir = sortDir();
      out = [...out].sort((x, y) => {
        const av = x.cells[sortIdx] ?? "";
        const bv = y.cells[sortIdx] ?? "";
        // Blanks (n/a, -, <none>, empty) always sink, so a descending
        // sort doesn't float the not-yet-loaded / metric-less rows to top.
        const ab = isBlankCell(av);
        const bb = isBlankCell(bv);
        if (ab || bb) return ab && bb ? 0 : ab ? 1 : -1;
        return cmpCells(av, bv) * dir;
      });
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

    // Fast path: nothing hidden and order unchanged → ship base cells.
    const identity =
      shownCols.length === b.cols.length &&
      shownCols.every((c, i) => c === b.cols[i]);
    if (identity) return { cols: b.cols, allCols: b.cols, rows: out };
    const keepIdx = shownCols.map((c) => b.cols.indexOf(c));
    return {
      cols: shownCols,
      allCols: b.cols,
      rows: out.map((r) => ({ ...r, cells: keepIdx.map((i) => r.cells[i]) })),
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
  // Row height drives the virtual window's arithmetic *and* the cells'
  // CSS, and the two must agree exactly or rows drift as you scroll. One
  // signal owns it; the stylesheet reads it back through a custom
  // property. Kept apart from zoom: zoom scales everything, this decides
  // how much air a table row gets at whatever scale you are at.
  const ROW_H_MIN = 18;
  const ROW_H_MAX = 40;
  const [rowH, setRowH] = createSignal(
    Math.min(
      ROW_H_MAX,
      Math.max(ROW_H_MIN, Number(localStorage.getItem("pigeoneye.rowh")) || 26),
    ),
  );
  createEffect(() => {
    document.documentElement.style.setProperty("--row-h", `${rowH()}px`);
    localStorage.setItem("pigeoneye.rowh", String(rowH()));
  });
  const nudgeRowH = (d: number) =>
    setRowH(Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, rowH() + d)));
  const HEADER_H = 30;
  const OVERSCAN = 8;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);

  const windowRange = createMemo(() => {
    const total = view().rows.length;
    const first = Math.max(0, Math.floor(scrollTop() / rowH()) - OVERSCAN);
    const visible = Math.ceil(viewH() / rowH()) + OVERSCAN * 2;
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
    const top = idx * rowH();
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH() > el.scrollTop + el.clientHeight - HEADER_H) {
      el.scrollTop = top + rowH() - el.clientHeight + HEADER_H;
    }
  }

  function scrollColIntoView(i: number) {
    document
      .querySelector(`th[data-col="${i}"]`)
      ?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
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
  // The list scrolls, so there is no reason to hold much back: a machine
  // with hundreds of contexts should see them all. This is only a backstop
  // against rendering a pathological list in one frame — and when it does
  // bite, `moreRow` says so rather than letting the list look complete.
  const CMD_LIST_MAX = 1000;

  // fn+↑/↓ on a Mac arrives as PageUp/PageDown, so nothing needs to know
  // about fn — the lists just have to answer the key. The table already
  // did; the pickers didn't, which made them the slow ones to get down.
  const pageDir = (e: KeyboardEvent) =>
    e.key === "PageDown" ? 1 : e.key === "PageUp" ? -1 : 0;
  const clamp = (i: number, n: number) => Math.min(Math.max(i, 0), n - 1);

  /// A page is what you can see, the way k9s does it — not a fixed number
  /// of rows. It follows the window size and the row-height setting, and
  /// keeps one row of overlap so you can tell where you landed.
  const pageOf = (containerSel: string, itemSel: string, fallback = 20) => {
    const c = document.querySelector(containerSel) as HTMLElement | null;
    const item = c?.querySelector(itemSel) as HTMLElement | null;
    const h = item?.offsetHeight ?? 0;
    if (!c || !h) return fallback;
    return Math.max(1, Math.floor(c.clientHeight / h) - 1);
  };

  /// The table's page comes from the numbers it already keeps for the
  /// virtual window, so it stays right as either changes.
  const tablePage = () => Math.max(1, Math.floor(viewH() / rowH()) - 1);

  /// Keep the highlighted row in the scrollport. The list scrolls with the
  /// mouse, but arrow keys moved the cursor without taking the view along,
  /// so it walked off the bottom and out of sight.
  const scrollCmdCursor = () =>
    requestAnimationFrame(() =>
      document
        .querySelector(`.cmd-item[data-cmdi="${cmdIdx()}"]`)
        ?.scrollIntoView?.({ block: "nearest" }),
    );

  const moreRow = (shown: number, total: number): CmdItem[] =>
    total > shown
      ? [
          {
            label: `…and ${total - shown} more`,
            hint: "keep typing to narrow",
            run: () => {},
          },
        ]
      : [];
  interface CmdItem {
    label: string;
    hint: string;
    run: () => void;
    /// Leave the palette open — used by the cross-cluster search, whose
    /// results replace the item list in place.
    keepOpen?: boolean;
    /// Context this row came from, for the colour dot in the results.
    context?: string;
    /// Marks the row that leaves this cluster — it does something the
    /// rows around it don't, and has to look like it.
    search?: boolean;
    /// Work still in flight behind this row.
    busy?: boolean;
    /// What tab writes into the input. Picking a kind is usually the first
    /// half of a thought — the argument follows — so completing beats
    /// running, and the typed argument survives the swap.
    complete?: string;
  }

  // ── searching every open cluster at once ───────────────
  //
  // Only from here. The `/` row filter and a kind's own view stay bound to
  // the cluster you are looking at — a pod from somewhere else appearing
  // in that list would be genuinely confusing. This is the one place you
  // ask a question of every cluster at once, and every answer says which
  // cluster it came from.
  type SearchHit = { context: string; namespace: string | null; name: string };
  const [xSearch, setXSearch] = createSignal<{
    rt: ResourceType;
    query: string;
  } | null>(null);
  const [xHits, setXHits] = createSignal<SearchHit[]>([]);
  const [xTotal, setXTotal] = createSignal(0);
  const [xPending, setXPending] = createSignal<string[]>([]);
  const [xAge, setXAge] = createSignal<Record<string, number>>({});
  const [xErrors, setXErrors] = createSignal<Record<string, string>>({});

  function clearXSearch() {
    setXSearch(null);
    setXHits([]);
    setXTotal(0);
    setXPending([]);
    setXAge({});
    setXErrors({});
  }

  /// Ask every open cluster for one kind, and take the answers as they
  /// arrive. `refresh` skips the name index, which is what makes a second
  /// look at a churning kind honest.
  function runXSearch(rt: ResourceType, query: string, refresh = false) {
    const targets = tabs();
    if (!targets.length) return;
    setXSearch({ rt, query });
    setXHits([]);
    setXTotal(0);
    setXAge({});
    setXErrors({});
    setXPending(targets);
    const chan = new Channel<{
      context: string;
      hits: SearchHit[];
      total: number;
      age_ms: number;
      error: string | null;
    }>();
    chan.onmessage = (b) => {
      setXPending(xPending().filter((c) => c !== b.context));
      if (b.error) {
        setXErrors({ ...xErrors(), [b.context]: b.error });
        return;
      }
      setXAge({ ...xAge(), [b.context]: b.age_ms });
      setXTotal(xTotal() + b.total);
      // Contexts answer out of order; keep them in tab order so the list
      // does not reshuffle as it fills.
      const order = new Map(targets.map((t, i) => [t, i]));
      setXHits(
        [...xHits(), ...b.hits].sort(
          (a, z) =>
            (order.get(a.context) ?? 0) - (order.get(z.context) ?? 0) ||
            a.name.localeCompare(z.name),
        ),
      );
    };
    void invoke("search_contexts", {
      contexts: targets,
      resource: rt,
      query,
      refresh,
      channel: chan,
    }).catch((e) => setXErrors({ ...xErrors(), all: String(e) }));
  }

  /// A row to put the cursor on once its list arrives.
  let pendingJump: { context: string; kind: string; name: string } | null = null;

  /// Land on a hit: its cluster, its namespace, its kind, cursor on the
  /// row. Deliberately not the row filter — that runs the full-text search
  /// (and builds the deep index) to find something we already know the
  /// name of, which is both slow and alarming to watch.
  function gotoHit(hit: SearchHit, rt: ResourceType) {
    clearXSearch();
    setCmdOpen(false);
    setCmdText("");
    if (active() !== hit.context) activate(hit.context);
    if (hit.namespace) {
      setNamespace(hit.namespace);
      const st = tabCache.get(hit.context);
      if (st) st.namespace = hit.namespace;
    }
    pendingJump = { context: hit.context, kind: rt.kind, name: hit.name };
    gotoKind(rt);
  }

  // The list arrives asynchronously, so the jump waits for it rather than
  // guessing when it is ready.
  createEffect(() => {
    const rows = view().rows;
    const j = pendingJump;
    // Kind as well as context: a jump that never resolved would otherwise
    // lie in wait and grab a same-named row in some other list.
    if (!j || !rows.length) return;
    if (active() !== j.context || selected()?.kind !== j.kind) return;
    const i = rows.findIndex((vr) => vr.row.name === j.name);
    if (i < 0) return;
    pendingJump = null;
    setCursor(i);
    scrollRowIntoView(i);
  });

  /// Match a resource kind the way the `:` palette does: exact alias
  /// first, then prefix, then substring on kind or group.
  function resolveKinds(token: string): ResourceType[] {
    if (!token) return [];
    const byKey = new Map(types().map((t) => [typeKey(t).toLowerCase(), t]));
    const hits: ResourceType[] = [];
    const alias = KIND_ALIASES[token];
    if (alias) {
      const t = byKey.get(alias.toLowerCase());
      if (t) hits.push(t);
    }
    for (const t of types())
      if (!hits.includes(t) && t.kind.toLowerCase().startsWith(token)) hits.push(t);
    for (const t of types())
      if (
        !hits.includes(t) &&
        (t.kind.toLowerCase().includes(token) || t.group.includes(token))
      )
        hits.push(t);
    return hits;
  }

  /// Open a kind and land the cursor in the table.
  function gotoKind(t: ResourceType) {
    void select(t);
    revealInSidebar(t);
    requestAnimationFrame(() => tableFocusRef?.focus());
  }

  /// One palette row for a kind, honoring a k9s-style modifier arg:
  ///   :pod kube-system  → namespace     :pod /nginx     → name filter
  ///   :pod app=web,e=d  → label selector :pod @prod      → context
  /// No arg just opens the kind.
  function kindItem(t: ResourceType, rest: string): CmdItem {
    // Completing means handing back what the row resolved to, so the next
    // tab has something new to say. Echoing the letters just typed is
    // what made tab look broken after the kind was filled in.
    const done = (arg?: string) => `${t.kind} ${arg ?? ""}`.trimEnd() + " ";
    if (!rest)
      return {
        label: t.kind,
        hint: t.group || "core",
        complete: done(),
        run: () => gotoKind(t),
      };
    if (rest.startsWith("@")) {
      const arg = rest.slice(1);
      const ctx = contexts().find((c) =>
        c.name.toLowerCase().includes(arg.toLowerCase()),
      );
      const name = ctx?.name ?? arg;
      return {
        label: `${t.kind} @ ${name}`,
        hint: "kind in context",
        complete: done(`@${name}`),
        run: () =>
          void (async () => {
            await openContext(name);
            // types() now belongs to the new context — re-resolve there.
            const nt = resolveKinds(t.kind.toLowerCase())[0];
            if (nt) gotoKind(nt);
          })(),
      };
    }
    if (rest.startsWith("/")) {
      const f = rest.slice(1);
      return {
        label: `${t.kind} /${f}`,
        hint: "filter by name",
        complete: done(`/${f}`),
        run: () =>
          void (async () => {
            await select(t);
            revealInSidebar(t);
            onRowFilterInput(f);
          })(),
      };
    }
    if (rest.includes("=")) {
      return {
        label: `${t.kind} ${rest}`,
        hint: "label selector",
        complete: done(rest),
        run: () => {
          void select(t, `label:${rest}`);
          revealInSidebar(t);
          requestAnimationFrame(() => tableFocusRef?.focus());
        },
      };
    }
    // A bare word is a namespace (k9s: `:pod ns-x`). Resolve it against the
    // known list so a prefix works, but keep the raw value as a fallback.
    if (!t.namespaced)
      return {
        label: `${t.kind} · ${rest}`,
        hint: "cluster-scoped — ns ignored",
        complete: done(rest),
        run: () => gotoKind(t),
      };
    // Exact, then prefix, then anywhere. Without the prefix step a
    // single letter lands on whichever namespace happens to contain it —
    // "c" resolved to action-runner-job-exporter — so typing more letters
    // appeared to change nothing.
    const ns =
      namespaces().find((n) => n === rest) ??
      namespaces().find((n) => n.startsWith(rest)) ??
      namespaces().find((n) => n.includes(rest)) ??
      rest;
    return {
      label: `${t.kind} · ${ns}`,
      hint: "in namespace",
      complete: done(ns),
      run: () => {
        setNamespace(ns);
        const st = tabCache.get(active()!);
        if (st) st.namespace = ns;
        gotoKind(t);
      },
    };
  }

  const cmdItems = createMemo<CmdItem[]>(() => {
    const xs = xSearch();
    if (xs) {
      const ages = xAge();
      const stale = Object.values(ages).some((a) => a > 1000);
      const errs = Object.entries(xErrors());
      return [
        {
          label:
            xTotal() > xHits().length
              ? `${xs.rt.kind} matching "${xs.query}" · showing ${xHits().length} of ${xTotal()}`
              : `${xs.rt.kind} matching "${xs.query}" · ${xHits().length} found`,
          hint: xPending().length
            ? // Name them: "2 more" says nothing about whether the one you
              // care about has answered yet.
              `searching ${xPending().slice(0, 2).join(", ")}${
                xPending().length > 2 ? ` +${xPending().length - 2}` : ""
              }…`
            : stale
              ? "from the last look — ↵ to re-read"
              : "just read",
          busy: xPending().length > 0,
          keepOpen: true,
          run: () => runXSearch(xs.rt, xs.query, true),
        },
        ...errs.map(([ctx, e]) => ({
          label: `${ctx}: ${prettyError(e)}`,
          hint: "not searched",
          keepOpen: true,
          run: () => {},
        })),
        ...xHits()
          .slice(0, CMD_LIST_MAX)
          .map((h) => ({
            label: h.namespace ? `${h.namespace}/${h.name}` : h.name,
            hint: h.context,
            context: h.context,
            run: () => gotoHit(h, xs.rt),
          })),
        ...moreRow(Math.min(xHits().length, CMD_LIST_MAX), xHits().length),
      ];
    }
    const raw = cmdText().trim();
    const q = raw.toLowerCase();
    if (q === "0") {
      return [
        { label: "all namespaces", hint: "0", run: () => pickNamespace("") },
      ];
    }
    if (q.startsWith("ns")) {
      const arg = q.slice(2).trim();
      const list = arg
        ? namespaces().filter((n) => n.includes(arg))
        : namespaces();
      return [
        ...(arg ? [] : [{ label: "ns (all)", hint: "clear namespace filter", run: () => pickNamespace("") }]),
        ...list.slice(0, CMD_LIST_MAX).map((n) => ({
          label: `ns ${n}`,
          hint: "switch namespace",
          complete: `ns ${n}`,
          run: () => pickNamespace(n),
        })),
        ...moreRow(Math.min(list.length, CMD_LIST_MAX), list.length),
      ];
    }
    if (q.startsWith("ctx")) {
      const arg = q.slice(3).trim();
      // Sorted, and open tabs first. The list arrives in kubeconfig order,
      // so a context added later sat at the bottom — and the cap below cut
      // it off, which read as "it isn't there" for a cluster that was.
      const hits = contexts()
        .filter((c) => !arg || c.name.toLowerCase().includes(arg))
        .slice()
        .sort(
          (a, b) =>
            Number(tabs().includes(b.name)) - Number(tabs().includes(a.name)) ||
            a.name.localeCompare(b.name),
        );
      return [
        ...hits.slice(0, CMD_LIST_MAX).map((c) => ({
          label: `ctx ${c.name}`,
          hint: tabs().includes(c.name) ? "switch tab" : "connect",
          complete: `ctx ${c.name}`,
          run: () => void openContext(c.name),
        })),
        ...moreRow(Math.min(hits.length, CMD_LIST_MAX), hits.length),
      ];
    }
    if (!q) {
      return [
        { label: "pods · deploy · svc · no …", hint: "type a resource kind", run: () => {} },
        { label: "kind ns · /name · k=v · @ctx", hint: "narrow a kind inline", run: () => {} },
        { label: "ns <name>", hint: "switch namespace (0 = all)", run: () => setCmdText("ns ") },
        { label: "0", hint: "all namespaces", run: () => pickNamespace("") },
        { label: "ctx <name>", hint: "switch cluster", run: () => setCmdText("ctx ") },
      ];
    }
    // Resource kind, optionally with a k9s-style modifier (namespace,
    // /name filter, k=v label selector, or @ctx). The first whitespace
    // splits the kind from its argument.
    const parts = raw.split(/\s+/);
    const head = (parts[0] ?? "").toLowerCase();
    const rest = parts.slice(1).join(" ").trim();
    const kinds = resolveKinds(head);
    const items = [
      ...kinds.slice(0, CMD_LIST_MAX).map((t) => kindItem(t, rest)),
      ...moreRow(Math.min(kinds.length, CMD_LIST_MAX), kinds.length),
    ];
    // A bare word after a kind means a namespace here (k9s), which is
    // still right when it names one. When it doesn't, the likely question
    // is "where is this thing?" — so lead with the search, but never take
    // the other reading away.
    const first = kinds[0];
    if (first && rest && !rest.startsWith("@") && !rest.includes("=") && tabs().length > 1) {
      const known = namespaces().some((n) => n.includes(rest));
      const search: CmdItem = {
        label: `⌕ search every cluster · ${first.kind} "${rest.replace(/^\//, "")}"`,
        hint: `${tabs().length} open`,
        keepOpen: true,
        search: true,
        run: () => runXSearch(first, rest.replace(/^\//, "")),
      };
      return known ? [...items, search] : [search, ...items];
    }
    return items;
  });

  function runCmd(item: CmdItem | undefined) {
    if (!item) return;
    if (!item.keepOpen) {
      setCmdOpen(false);
      setCmdText("");
    }
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
      body: "The node will be cordoned, then every pod except DaemonSets and mirror pods will be evicted (PodDisruptionBudgets respected). DaemonSet and mirror pods are left in place by design — once only those remain, the drain is complete.",
      label: "Drain node",
      danger: true,
      run: () => {
        void runAction("drain", () =>
          invoke<string>("drain_node", { context: active(), name: d.name }),
        );
        // Watch the pods drain in the node panel (if it's the open node).
        if (detailKey() === `/${d.name}`) startDrainPoll(d.name);
      },
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

  const [access, setAccess] = createSignal<[string, boolean][] | null>(null);
  function openAccess() {
    const rt = selected();
    const ctx = active();
    if (!rt || !ctx) return;
    setAccess([]);
    void invoke<[string, boolean][]>("can_i", {
      context: ctx,
      group: rt.group,
      resource: rt.plural,
      namespace: rt.namespaced ? namespace() || null : null,
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
    })
      .then((r) => setAccess(r))
      .catch((e) => {
        setAccess(null);
        setError(prettyError(String(e)));
      });
  }
  const [history, setHistory] = createSignal<Revision[] | null>(null);
  function openHistory(target?: Target) {
    const d = target ?? currentTarget();
    if (!d || !kindIs("apps", "Deployment")) return;
    void invoke<Revision[]>("rollout_history", {
      context: active(),
      namespace: d.namespace,
      name: d.name,
    })
      .then((r) => setHistory(r))
      .catch((e) => setActionErr(prettyError(String(e))));
  }
  function rollbackTo(rev: Revision) {
    const d = currentTarget();
    if (!d) return;
    setHistory(null);
    setDlgIdx(1);
    setConfirm({
      title: `Roll back to revision ${rev.revision}?`,
      body: `Sets ${d.name}'s pod template to revision ${rev.revision} (${rev.images.join(", ")}).`,
      label: "Roll back",
      danger: true,
      run: () =>
        void runAction("rollback", () =>
          invoke("rollout_undo", {
            context: active(),
            namespace: d.namespace,
            name: d.name,
            rsName: rev.name,
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
    // What "delete node" actually does hinges on the node's finalizers,
    // not on the client — a Karpenter node (karpenter.sh/termination) gets
    // cordoned, drained, and its EC2 instance terminated before the Node
    // object goes; a plain node just loses its API record and its kubelet
    // re-registers it. Detect Karpenter from the open manifest so the
    // warning tells the truth for this specific node.
    const node = isNode();
    let body: string;
    if (node) {
      const km = detail()?.yaml?.includes("karpenter.sh/termination");
      const base =
        km === true
          ? `${t.name} carries Karpenter's termination finalizer, so deleting it hands control to Karpenter: the node is cordoned, its pods are drained, and the underlying EC2 instance is terminated before the Node object is finally removed. This is the graceful way to retire a Karpenter node.`
          : km === false
            ? `Removes the Node object ${t.name} from ${active()}'s API server only. The machine is NOT terminated and a running kubelet will re-register it; pods are not evicted. For a real removal, drain the node, then terminate the instance (or let Karpenter / the autoscaler reclaim it).`
            : `Deletes the Node object ${t.name}. What follows depends on its finalizers: a Karpenter-managed node (karpenter.sh/termination) gets drained and its EC2 instance terminated; a plain node just loses its API record and its kubelet re-registers it — the machine keeps running.`;
      const forceNote =
        km === true
          ? ` Force (grace 0) gives pods no graceful shutdown window, but Karpenter's finalizer still gates deletion until the instance is drained and terminated.`
          : ` Force uses grace period 0 — the object is removed immediately.`;
      body = base + (force ? forceNote : "") + ` This cannot be undone.`;
    } else {
      body = force
        ? `Grace period 0 — ${t.name} is removed immediately, without waiting for a graceful shutdown. This cannot be undone.`
        : `${t.name}${t.namespace ? ` in ${t.namespace}` : ""} is deleted from ${active()} with the default grace period. This cannot be undone.`;
    }
    setConfirm({
      title: `${force ? "Force delete" : "Delete"} ${selected()?.kind}/${t.name}?`,
      body,
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

  /// One level up out of the table. Esc and ← share it so the two keys
  /// can never drift apart.
  function leaveTableForSidebar() {
    setPane("sidebar");
    const i = sidebarItems().findIndex((t) => t === selected());
    if (i >= 0) setSideIdx(i);
  }

  function onGlobalKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    // Anything inside the terminal dock (the log toolbar's buttons too, not
    // just its inputs) owns the keyboard — global table shortcuts must not
    // fire, or arrow keys in the log toolbar would also walk the table.
    const typing = el?.closest(
      "input, textarea, select, [contenteditable], .cm-editor, .xterm, .term-panel",
    );
    // Browser-style zoom — ⌘/Ctrl +/− adjusts, ⌘/Ctrl 0 resets. First thing,
    // so it works anywhere (launcher, while typing) like a browser. ⌘0 is
    // zoom-reset; plain 0 still jumps to all namespaces.
    if (e.metaKey || e.ctrlKey) {
      if (e.code === "Equal" || e.code === "NumpadAdd" || e.key === "+") {
        e.preventDefault();
        setZoom(zoom() + 0.1);
        return;
      }
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        setZoom(zoom() - 0.1);
        return;
      }
      if (e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        setZoom(1);
        return;
      }
    }
    // ⌘⇧S opens a shell on this machine, from anywhere — including the
    // launcher, where the whole point is to fix credentials *before*
    // spending a connection timeout finding out they were stale. Not ⌘⇧T:
    // off-Mac that is already the terminal dock's own toggle.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (!loginTarget()) openLocalShell();
      return;
    }
    // ⌘/Ctrl+⇧+↑/↓ resizes the open log/shell dock. While the terminal has
    // focus its own key handler forwards these (see TerminalPanel), so this
    // path is for when focus is elsewhere — hence the !termFocused guard.
    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      shells().length > 0 &&
      !termMin() &&
      !termFocused()
    ) {
      e.preventDefault();
      setTermHeight(termHeight() + (e.key === "ArrowUp" ? 48 : -48));
      return;
    }
    // Launcher screen: arrows/Enter drive the context list no matter
    // where focus sits, so it's fully keyboard-first. Letters still fall
    // through to the search box (which filters via onInput).
    if (tabs().length === 0) {
      if (settingsOpen() || preEdit()) return;
      const list = pickerList();
      if (pageDir(e)) {
        e.preventDefault();
        const step = pageDir(e) * pageOf(".launcher-list", ".launcher-row");
        setPickerIdx(clamp(pickerIdx() + step, list.length));
      } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
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
        if (!c) return;
        if (e.altKey) editPreCmd(c.name);
        else void openContext(c.name);
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
      // The login terminal handles its own Esc when it has focus; this is
      // for when focus sits on the dialog's close button instead.
      if (loginTarget()) {
        closeLogin(true);
        return;
      }
      if (newOpen()) {
        // The editor's own Esc keymap blurred it and set nav mode; don't
        // also close on the same event.
        if (e.defaultPrevented) return;
        if (newNsOpen()) setNewNsOpen(false);
        else setNewOpen(false);
        return;
      }
      if (dryRun()) setDryRun(null);
      else if (access()) setAccess(null);
      else if (history()) setHistory(null);
      else if (colMenu()) setColMenu(null);
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
        leaveTableForSidebar();
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
    // The help sheet owns the keyboard while open, but "?" should toggle
    // it shut (it's the same key that opened it) — Escape closes it too,
    // handled in the Escape chain above.
    if (helpOpen()) {
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(false);
      }
      return;
    }
    // Any open popup owns the keyboard: keys must never reach the table
    // behind it (else ⌘D would delete the row under a column menu). Every
    // overlay that doesn't run its own nav belongs here.
    if (
      scaleOpen() ||
      pfOpen() ||
      colsOpen() ||
      settingsOpen() ||
      dryRun() ||
      access() ||
      history() ||
      nsOpen() ||
      cmdOpen() ||
      loginTarget()
    )
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
    // ⌥ +/−/0 sets how tall a table row is — the neighbouring question to
    // ⌘ +/−/0, which scales the whole app. Below the typing guard, unlike
    // zoom: on a Mac ⌥+ is "±", ⌥− an en dash and ⌥0 "º", so above it
    // these would eat characters out of the YAML editor and the search
    // boxes.
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        nudgeRowH(2);
        return;
      }
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        nudgeRowH(-2);
        return;
      }
      if (e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        setRowH(26);
        return;
      }
    }
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
    // Plain `0` jumps to all namespaces, k9s-style (⌘/Ctrl 0 is zoom-reset,
    // handled above). Only acts on a namespaced kind.
    if (
      e.code === "Digit0" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      const rt = selected();
      if (!rt || rt.namespaced) {
        e.preventDefault();
        pickNamespace("");
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      setSettingsOpen(!settingsOpen());
      return;
    }
    // ⌘K / Ctrl+K focuses the sidebar kind filter from anywhere (`/` is
    // the row search). ⌘⇧K does the same, since some keyboards/apps eat
    // ⌘K — give it a second, always-available binding.
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
      e.preventDefault();
      setSidebarOpen(true);
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
      if (pageDir(e)) {
        e.preventDefault();
        moveSidebar(pageDir(e) * pageOf(".tree", ".kind"));
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
      // `p` pins the kind under the cursor into the first group (or
      // unpins it) — a keyboard shortcut that pairs with the `:` palette
      // revealing a CRD here.
      if (e.key === "p") {
        const t = sidebarItems()[sideIdx()];
        if (t) {
          e.preventDefault();
          if (isFav(t)) unpin(t);
          else pinToGroup(t, pinGroups()[0]?.name ?? "Pinned");
        }
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
        else if (secBtn() >= 0) sectionButtons(panelSec())[secBtn()]?.click();
        else activatePanelSection();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (BUTTON_ROWS[panelSec()]) {
          e.preventDefault();
          // The left edge of the row is the end of the line, so ← keeps
          // meaning "step up" there instead of dying against the clamp —
          // the same thing it does from a section header.
          if (e.key === "ArrowLeft" && actionIdx() <= 0) closeDetail();
          else moveWithinRow(e.key === "ArrowRight" ? 1 : -1);
          return;
        }
        // Content sections: → steps onto their copy button(s); ← steps
        // back to the header, then (a second ←) closes the detail.
        const btns = sectionButtons(panelSec());
        if (btns.length && e.key === "ArrowRight" && secBtn() < btns.length - 1) {
          e.preventDefault();
          const n = secBtn() + 1;
          setSecBtn(n);
          paintSecBtn(panelSec(), n);
          return;
        }
        if (e.key === "ArrowLeft" && secBtn() >= 0) {
          e.preventDefault();
          const n = secBtn() - 1;
          setSecBtn(n);
          if (n >= 0) paintSecBtn(panelSec(), n);
          else
            document
              .querySelectorAll(".btn-cursor")
              .forEach((el) => el.classList.remove("btn-cursor"));
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
      sweepFrom();
      moveCursor(1);
      sweepTo();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      // Past the top row, step up into the header: focus the search box
      // (Tab from there reaches + New) — the list's parent level.
      if (cursor() <= 0) rowSearchRef?.focus();
      else {
        sweepFrom();
        moveCursor(-1);
        sweepTo();
      }
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
      // Panned fully left there is nothing more to give, so ← steps up to
      // the sidebar rather than doing nothing — same level Esc leaves for.
      if (e.key === "ArrowLeft" && (tableFocusRef?.scrollLeft ?? 0) <= 0)
        leaveTableForSidebar();
      else
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
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      // Was a flat 15 rows, which barely moved on a tall window.
      e.preventDefault();
      moveCursor(pageDir(e) * tablePage());
    } else if (e.key === "g") {
      moveCursor(-view().rows.length);
    } else if (e.key === "G") {
      moveCursor(view().rows.length);
    } else if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // Held, space becomes a sweep: the movement keys mark what they
      // pass over, so a run of rows costs one gesture instead of a press
      // per row. A tap is unchanged — it still toggles the row under the
      // cursor. The repeat guard matters: holding a key fires keydown
      // over and over, and without it the row would flicker in and out of
      // the selection.
      spaceHeld = true;
      if (e.repeat) return;
      const vr = view().rows[cursor()];
      if (vr) toggleMark(vr.row);
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

  // Ask GitHub for the latest release tag. Best-effort: any failure
  // (offline, rate-limited, private) just leaves the version chip plain.
  let lastReleaseCheck = 0;
  async function checkLatestRelease(): Promise<boolean> {
    lastReleaseCheck = Date.now();
    try {
      const res = await fetch(
        "https://api.github.com/repos/tackish/pigeoneye/releases/latest",
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!res.ok) return false;
      const tag = (await res.json())?.tag_name;
      if (typeof tag === "string") {
        setLatestVersion(tag);
        return true;
      }
      return false;
    } catch {
      /* offline / rate-limited — chip stays plain */
      return false;
    }
  }

  // Clicking the plain version chip forces a check right now, with visible
  // feedback — the automatic 15-min/focus checks can silently fail (GitHub
  // rate limit, offline), which is why "no update button after a release"
  // happens. If a newer release turns up, updateAvailable() flips and the
  // chip becomes the upgrade button on its own.
  const [checkingUpdate, setCheckingUpdate] = createSignal(false);
  const [checkNote, setCheckNote] = createSignal("");
  async function manualUpdateCheck() {
    if (checkingUpdate() || updateAvailable()) return;
    setCheckingUpdate(true);
    setCheckNote("");
    const ok = await checkLatestRelease();
    setCheckingUpdate(false);
    if (!ok) setCheckNote("check failed");
    else if (!updateAvailable()) setCheckNote("up to date");
    if (checkNote()) window.setTimeout(() => setCheckNote(""), 2500);
  }

  // Check at startup, then keep checking so a release cut while the app is
  // open lights up the update chip on its own: every 15 min, and whenever
  // the window regains focus if the last check was over 2 min ago. (The
  // focus path alone misses continuous use, where focus never re-fires, so
  // the interval is what actually catches it.)
  onMount(() => {
    void (async () => {
      try {
        setAppVersion(await getVersion());
      } catch {
        return;
      }
      void invoke<string>("app_arch").then(setAppArch).catch(() => {});
      void checkLatestRelease();
    })();
    const id = window.setInterval(
      () => void checkLatestRelease(),
      15 * 60 * 1000,
    );
    const recheck = () => {
      if (Date.now() - lastReleaseCheck > 2 * 60 * 1000)
        void checkLatestRelease();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    onCleanup(() => {
      window.clearInterval(id);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    });
  });

  const onGlobalKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") spaceHeld = false;
  };
  const dropHeldKeys = () => (spaceHeld = false);
  onMount(() => {
    document.addEventListener("keydown", onGlobalKey);
    document.addEventListener("keyup", onGlobalKeyUp);
    window.addEventListener("blur", dropHeldKeys);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onGlobalKey);
    document.removeEventListener("keyup", onGlobalKeyUp);
    window.removeEventListener("blur", dropHeldKeys);
    stopWatch();
  });

  const kindButton = (t: ResourceType) => (
    <button
      class="kind"
      data-sk={sidebarItems().indexOf(t)}
      classList={{
        active: selected() === t,
        cursor: pane() === "sidebar" && sidebarItems()[sideIdx()] === t,
        fav: isFav(t),
      }}
      onClick={() => {
        setPane("table");
        setSideIdx(Math.max(sidebarItems().indexOf(t), 0));
        select(t);
      }}
    >
      <span class="kname">{t.kind}</span>
      <Show when={!t.namespaced}>
        <span class="scope" title="cluster-scoped (not namespaced)">
          C
        </span>
      </Show>
      <span
        class="pin"
        title={isFav(t) ? "unpin" : "pin to a group"}
        onClick={(e) => {
          e.stopPropagation();
          if (isFav(t)) {
            unpin(t);
          } else {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setNewGroupName("");
            setPinPickAt({ x: r.right, y: r.bottom + 4 });
            setPinPick({ types: [t], label: t.kind });
          }
        }}
      >
        ★
      </span>
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
            <span class="meta-key">table row height</span>
            <span class="row-h-set">
              <button class="btn sm" onClick={() => nudgeRowH(-2)}>−</button>
              <span class="row-h-val">{rowH()}px</span>
              <button class="btn sm" onClick={() => nudgeRowH(2)}>+</button>
              <button class="btn sm" onClick={() => setRowH(26)}>reset</button>
              <span class="dim">⌥ + / − / 0 · zoom (⌘) is separate</span>
            </span>
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
          <div class="settings-ver">
            <span>
              PigeonEye <b>v{appVersion() || "…"}</b>
            </span>
            <Show
              when={updateAvailable()}
              fallback={
                <Show when={!!latestVersion()}>
                  <span class="dim">up to date</span>
                </Show>
              }
            >
              <span class="dim">
                update to v{latestVersion().replace(/^v/, "")} available in the
                top bar
              </span>
            </Show>
          </div>
          <div class="ver-history">
            <button
              class="ver-hist-toggle"
              onClick={() => {
                const opening = !versionsOpen();
                setVersionsOpen(opening);
                if (opening) void loadReleases();
              }}
            >
              {versionsOpen() ? "▾" : "▸"} version history · roll back
            </button>
            <Show when={versionsOpen()}>
              <p class="settings-note dim">
                Download an older build, then quit PigeonEye and move the
                extracted <b>PigeonEye.app</b> into Applications to roll back.
                {appArch() ? ` (this Mac: ${appArch()})` : ""}
              </p>
              <Show when={releasesLoading()}>
                <p class="dim ver-loading">loading releases…</p>
              </Show>
              <Show when={!releasesLoading() && !releases().length}>
                <p class="dim ver-loading">
                  {releasesErr()
                    ? "couldn't load the release list (offline, or GitHub's API rate limit is hit — resets within an hour)."
                    : "no releases found."}{" "}
                  <button
                    class="ver-link"
                    onClick={() => void openUrl(RELEASES_PAGE)}
                  >
                    open releases page ↗
                  </button>
                </p>
              </Show>
              <Show when={releases().length}>
                <div class="ver-list">
                  <For each={releases()}>
                    {(v) => (
                      <div class="ver-row">
                        <span class="ver-tag">v{v}</span>
                        <Show
                          when={v !== appVersion()}
                          fallback={<span class="dim">installed</span>}
                        >
                          <button
                            class="btn sm"
                            title={`download PigeonEye v${v} for ${appArch() || "arm64"}`}
                            onClick={() => void openUrl(rollbackUrl(v))}
                          >
                            {cmpSemver(v, appVersion()) > 0
                              ? "download (newer)"
                              : "download"}
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <button
                  class="ver-link ver-all"
                  onClick={() => void openUrl(RELEASES_PAGE)}
                >
                  all releases on GitHub ↗
                </button>
              </Show>
            </Show>
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
                onClick={() => void runLogin()}
              >
                {authHint()!.kind === "aws-sso"
                  ? `Log in with SSO${authHint()!.context ? ` (${authHint()!.context})` : ""}`
                  : `Log in${authHint()!.context ? ` (${authHint()!.context})` : ""}`}
              </button>
              <Show when={authHint()!.command}>
                <code class="auth-cmd">{authHint()!.command}</code>
              </Show>
            </div>
          </Show>
          <div class="auth-actions">
            <Show when={authHint()?.exec_command}>
              <button
                class="btn sm"
                title={`run ${authHint()!.exec_command} with a terminal attached`}
                onClick={() => runCredentialCommand()}
              >
                run credential command
              </button>
            </Show>
            <button
              class="btn sm"
              title="run tsh login, aws sso login, a VPN — whatever this cluster needs"
              onClick={() => openLocalShell(authHint()?.context ?? "")}
            >
              local shell
            </button>
          </div>
          <details class="error-detail">
            <summary>show details</summary>
            <pre>{error()}</pre>
          </details>
        </div>
      </Show>
      {loginPanel()}
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
        <For each={ctxSections()}>
          {(sec, i) => (
            <>
              {/* A search flattens to one headerless section; otherwise each
                  custom group gets a collapsible header, and the ungrouped
                  tail (group "") renders headerless — with a divider above it
                  when groups precede it, so grouped and loose contexts read
                  apart. */}
              <Show when={sec.group}>
                <GroupHeader sec={sec} />
              </Show>
              <Show when={!sec.group && i() > 0}>
                <div class="ctx-loose-sep">ungrouped</div>
              </Show>
              <Show when={!sec.collapsed}>
                <For each={sec.items}>
                  {(c) => {
                    const gi = () => pickerIndexOf().get(c.name) ?? -1;
                    return (
                      <>
                        <div
                          class="launcher-row"
                          classList={{
                            active: pickerIdx() === gi(),
                            grouped: !!sec.group,
                          }}
                          onMouseEnter={() => setPickerIdx(gi())}
                        >
                          {ctxStar(c.name)}
                          {/* The row body opens the pre-connect editor —
                              whatever this cluster needs first belongs next to
                              the cluster. Connecting is the button on the
                              right. (Keyboard: ↵ connects, ⌥↵ edits.) */}
                          <button
                            class="launcher-item"
                            classList={{ "pre-set": !!preCmds()[c.name] }}
                            title="edit what runs before connecting"
                            onClick={() => editPreCmd(c.name)}
                          >
                            <span class="launcher-name">{c.name}</span>
                            <span class="dim">
                              {[
                                c.is_current ? "current" : "",
                                lastSession.includes(c.name) ? "recent" : "",
                                preCmds()[c.name] ? "pre-connect" : "",
                                c.source ? basename(c.source) : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </button>
                          <button
                            class="launcher-connect"
                            disabled={isConnecting(c.name)}
                            title={`connect to ${c.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void openContext(c.name);
                            }}
                          >
                            {isConnecting(c.name) ? "connecting…" : "connect"}
                          </button>
                        </div>
                        {preConnectEditor(c.name)}
                      </>
                    );
                  }}
                </For>
              </Show>
            </>
          )}
        </For>
        <Show when={ctxSections().every((s) => s.items.length === 0)}>
          <p class="dim">no contexts found in your kubeconfig</p>
        </Show>
      </div>
      <div class="launcher-tools">
        <button class="btn" onClick={() => setSettingsOpen(true)}>
          ⚙ kubeconfig files
        </button>
        {/* Here rather than only on the error banner: the credentials a
            cluster needs are usually knowable before you pick it, and
            finding out by waiting for a connection to time out is a bad
            way to spend a minute. */}
        <button
          class="btn"
          title="run tsh login, aws sso login, a VPN — whatever a cluster needs (⌘⇧S)"
          onClick={() => openLocalShell()}
        >
          ▸ local shell
        </button>
      </div>
      <Show when={settingsOpen()}>{settingsPanel()}</Show>
    </div>
  );

  // Shown at launch while last session's tabs reconnect — a calm splash so
  // the launcher's context picker never flashes before the tabs appear.
  const restoreSplash = () => (
    <div class="launcher">
      <img class="mascot" src={flyingUrl} alt="" />
      <h1>PigeonEye</h1>
      <p class="dim">reconnecting your clusters…</p>
      <div class="restore-ctxs">
        <For each={lastSession}>
          {(name) => (
            <span class="restore-ctx" style={{ "--ctx-hue": ctxHue(name) }}>
              <span class="ctx-dot" />
              {name}
            </span>
          )}
        </For>
      </div>
    </div>
  );

  // Under the error banner rather than over everything: what the shell is
  // there to fix is written directly above it, and a window that covers
  // the message while you answer it is the wrong shape. Rendered on both
  // screens, but only one of them is ever mounted.
  const loginPanel = () => (
    <Show when={loginTarget()} keyed>
      <div class="shell-panel">
        <div class="shell-panel-head">
          <span class="shell-panel-title">
            {loginTarget()!.context
              ? `shell — ${loginTarget()!.context}`
              : "shell on this machine"}
          </span>
          <span class="dim">
            answer whatever it asks · the buttons above type into it
            {loginTarget()!.context ? " · closing retries the connection" : ""}
          </span>
          <button
            class="close"
            title="close (esc) — ends the shell"
            onClick={() => closeLogin(true)}
          >
            ✕
          </button>
        </div>
        <div class="shell-panel-body">
          <TerminalPanel
            target={loginTarget()!}
            theme={theme()}
            active={true}
            // A pre-connect run holds the screen after it finishes: on
            // success just long enough to read the verdict before the
            // connection takes over, and on failure until the user has
            // read why and closed it. A shell the user typed `exit` into
            // needs neither.
            onExit={(ok) => {
              const t = loginTarget();
              if (!t?.oneShot) return closeLogin();
              if (!ok) return;
              // Only a run that worked counts as done. Marking it earlier
              // would mean a login the user got wrong could never be
              // retried — picking the context again would skip straight to
              // the connection that is going to fail.
              if (t.context) preRan.add(t.context);
              setTimeout(() => closeLogin(), 900);
            }}
            onLeave={() => closeLogin(true)}
            onMinimize={() => {}}
            onFocusChange={() => {}}
            onCycleTab={() => {}}
            onCloseTab={() => closeLogin(true)}
            api={(a) => (shellApi = a)}
          />
        </div>
      </div>
    </Show>
  );

  return (
    <>
    {/* The ★ group picker lives at the fragment root so it renders over both
        the launcher (no tabs) and the main view. */}
    {ctxPinPicker()}
    <Show
      when={tabs().length > 0}
      fallback={restoring() ? restoreSplash() : launcher()}
    >
    <div class="shell">
      <header class="topbar">
        <img class="logo-img" src={logoUrl} alt="PigeonEye" />
        <span class="logo">PigeonEye</span>
        <Show when={appVersion()}>
          <Show
            when={updateAvailable()}
            fallback={
              <button
                class="app-ver check"
                disabled={checkingUpdate()}
                title="installed version — click to check for updates"
                onClick={() => void manualUpdateCheck()}
              >
                {checkingUpdate()
                  ? "checking…"
                  : checkNote()
                    ? `v${appVersion()} · ${checkNote()}`
                    : `v${appVersion()}`}
              </button>
            }
          >
            <button
              class="app-ver update"
              classList={{ err: !!upgradeErr() }}
              disabled={upgrading() || upgradeDone()}
              title={
                upgradeErr()
                  ? `update failed: ${upgradeErr()} — click to retry`
                  : `update to v${latestVersion().replace(/^v/, "")} and restart`
              }
              onClick={() => void runSelfUpgrade()}
            >
              {upgrading() ? (
                "updating…"
              ) : upgradeDone() ? (
                "restarting…"
              ) : upgradeErr() ? (
                "update failed — retry"
              ) : (
                <>
                  v{appVersion()} <span class="arr">→</span> v
                  {latestVersion().replace(/^v/, "")}
                </>
              )}
            </button>
          </Show>
        </Show>
        <div class="tabs-area">
          <div
            class="tabs"
            ref={(el) => {
              // Attach the overflow observer here, not in onMount — this
              // runs whenever the strip actually mounts (the topbar is
              // behind a <Show>), so resizing the window re-measures.
              tabsStripRef = el;
              tabsRO?.disconnect();
              tabsRO = new ResizeObserver(() =>
                requestAnimationFrame(measureTabs),
              );
              tabsRO.observe(el);
              requestAnimationFrame(measureTabs);
            }}
          >
            {/* A cluster that failed to connect keeps a tab too. It used
                to vanish, with the only trace in an error banner that can
                be dismissed — so a context you asked for disappeared and
                left nothing to click. */}
            <For
              each={failed().filter(
                (f) => !tabs().includes(f.name) && !isConnecting(f.name),
              )}
            >
              {(f) => (
                <div
                  class="tab failed"
                  style={{ "--ctx-hue": ctxHue(f.name) }}
                  title={`${prettyError(f.error)} — click to try again`}
                  onClick={() => void reconnect(f.name)}
                >
                  <span class="ctx-dot" />
                  <span class="tab-name">{f.name}</span>
                  <button
                    class="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFailed(failed().filter((x) => x.name !== f.name));
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
            {/* A connection in progress gets a tab of its own, so you can
                see which cluster is taking its time — and start another
                while it does. It becomes a real tab when it lands. */}
            <For each={connecting().filter((n) => !tabs().includes(n))}>
              {(name) => (
                <div
                  class="tab pending"
                  style={{ "--ctx-hue": ctxHue(name) }}
                  title={`connecting to ${name}…`}
                >
                  <span class="tab-spin" />
                  <span class="tab-name">{name}</span>
                  <span class="tab-connecting">connecting…</span>
                  <button
                    class="tab-close"
                    title="stop trying"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelConnect(name);
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
            <For each={tabs()}>
              {(name) => (
                <div
                  class="tab"
                  classList={{ active: active() === name, pending: isConnecting(name) }}
                  style={{ "--ctx-hue": ctxHue(name) }}
                  onClick={() => active() !== name && activate(name)}
                >
                  <span class="ctx-dot" />
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
          <Show when={tabsOverflow()}>
            <button
              class="tabs-more"
              classList={{ open: tabsMenuOpen() }}
              title="all connected clusters"
              onClick={() => setTabsMenuOpen(!tabsMenuOpen())}
            >
              ▾ {tabs().length}
            </button>
            <Show when={tabsMenuOpen()}>
              <div class="tabs-backdrop" onClick={() => setTabsMenuOpen(false)} />
              <div class="tabs-pop">
                <For each={tabSections()}>
                  {(sec) => (
                    <>
                      <Show when={sec.group}>
                        <div class="tabs-pop-head">
                          <span class="ctx-group-name">{sec.group}</span>
                          <span class="dim">{sec.items.length}</span>
                        </div>
                      </Show>
                      <For each={sec.items}>
                        {(name) => (
                          <div
                            class="tabs-pop-row"
                            classList={{ active: active() === name }}
                            style={{ "--ctx-hue": ctxHue(name) }}
                            onClick={() => {
                              setTabsMenuOpen(false);
                              if (active() !== name) activate(name);
                            }}
                          >
                            <span class="ctx-dot" />
                            <span class="tabs-pop-name">{name}</span>
                            <button
                              class="ctx-star sm"
                              classList={{ on: isCtxPinned(name) }}
                              title="file under a group"
                              onClick={(e) => {
                                e.stopPropagation();
                                openCtxPin(name, e.currentTarget);
                              }}
                            >
                              {isCtxPinned(name) ? "★" : "☆"}
                            </button>
                            <button
                              class="tab-close"
                              title="close context"
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
                    </>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
        {/* A native select can't be searched, and can't hold the
            pre-connect control — and a list of every cluster you have is
            exactly the list you want to type into. */}
        <div class="ns-picker">
          <button
            class="ctx ns-btn"
            onClick={() => {
              setCtxOpen(!ctxOpen());
              setCtxQuery("");
              setCtxIdx(0);
            }}
          >
            + add context{" "}
            <span class="dim">▾</span>
          </button>
          <Show when={ctxOpen()}>
            <div class="ns-backdrop" onClick={() => setCtxOpen(false)} />
            <div class="ns-pop ctx-pop">
              <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                class="search"
                placeholder="search contexts…"
                ref={(el) => setTimeout(() => el.focus())}
                value={ctxQuery()}
                onInput={(e) => {
                  setCtxQuery(e.currentTarget.value);
                  setCtxIdx(0);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  const items = ctxAddFlat();
                  if (e.key === "Escape") setCtxOpen(false);
                  else if (pageDir(e)) {
                    e.preventDefault();
                    const step =
                      pageDir(e) * pageOf(".ctx-pop .ns-list", ".launcher-row");
                    setCtxIdx(clamp(ctxIdx() + step, items.length));
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCtxIdx(Math.min(ctxIdx() + 1, items.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCtxIdx(Math.max(ctxIdx() - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const c = items[ctxIdx()];
                    if (!c) return;
                    if (e.altKey) editPreCmd(c.name);
                    else {
                      setCtxOpen(false);
                      void openContext(c.name);
                    }
                  }
                }}
              />
              <div class="ns-list">
                <For each={ctxAddSections()}>
                  {(sec, i) => (
                    <>
                      <Show when={sec.group}>
                        <GroupHeader sec={sec} />
                      </Show>
                      <Show when={!sec.group && i() > 0}>
                        <div class="ctx-loose-sep">ungrouped</div>
                      </Show>
                      <Show when={!sec.collapsed}>
                        <For each={sec.items}>
                          {(c) => {
                            const gi = () => ctxAddIndexOf().get(c.name) ?? -1;
                            return (
                              <>
                                <div
                                  class="launcher-row"
                                  classList={{
                                    active: ctxIdx() === gi(),
                                    grouped: !!sec.group,
                                  }}
                                  onMouseEnter={() => setCtxIdx(gi())}
                                >
                                  {ctxStar(c.name)}
                                  <button
                                    class="launcher-item"
                                    classList={{ "pre-set": !!preCmds()[c.name] }}
                                    title="edit what runs before connecting"
                                    onClick={() => editPreCmd(c.name)}
                                  >
                                    <span class="launcher-name">{c.name}</span>
                                    <span class="dim">
                                      {[
                                        tabs().includes(c.name) ? "open" : "",
                                        c.is_current ? "current" : "",
                                        preCmds()[c.name] ? "pre-connect" : "",
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </span>
                                  </button>
                                  <button
                                    class="launcher-connect"
                                    classList={{ open: tabs().includes(c.name) }}
                                    disabled={isConnecting(c.name)}
                                    title={
                                      tabs().includes(c.name)
                                        ? `switch to ${c.name}`
                                        : `connect to ${c.name}`
                                    }
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setCtxOpen(false);
                                      // Already open → just switch to its tab;
                                      // openContext activates a live tab too,
                                      // but be explicit here.
                                      if (tabs().includes(c.name)) activate(c.name);
                                      else void openContext(c.name);
                                    }}
                                  >
                                    {isConnecting(c.name)
                                      ? "connecting…"
                                      : tabs().includes(c.name)
                                        ? "go to ›"
                                        : "connect"}
                                  </button>
                                </div>
                                {preConnectEditor(c.name)}
                              </>
                            );
                          }}
                        </For>
                      </Show>
                    </>
                  )}
                </For>
                <Show when={ctxAddSections().every((s) => s.items.length === 0)}>
                  <p class="dim ctx-empty">no matching context</p>
                </Show>
              </div>
            </div>
          </Show>
        </div>
        <Show when={active()}>
          <div class="ns-picker">
            <button
              class="ctx ns-btn"
              title={
                namespace()
                  ? "press 0 to show all namespaces"
                  : "filter by namespace"
              }
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
                  onInput={(e) => {
                    setNsQuery(e.currentTarget.value);
                    setNsIdx(0);
                  }}
                  onKeyDown={(e) => {
                    const items = nsItems();
                    if (e.key === "Escape") setNsOpen(false);
                    else if (pageDir(e)) {
                      e.preventDefault();
                      const step = pageDir(e) * pageOf(".ns-list", ".ns-item");
                      setNsIdx(clamp(nsIdx() + step, items.length));
                      scrollNsCursor();
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setNsIdx(Math.min(nsIdx() + 1, items.length - 1));
                      scrollNsCursor();
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setNsIdx(Math.max(nsIdx() - 1, 0));
                      scrollNsCursor();
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const v = items[nsIdx()];
                      if (v !== undefined) pickNamespace(v);
                    }
                  }}
                />
                <div class="ns-list">
                  <Show when={nsShowAll()}>
                    <button
                      class="ns-item"
                      data-nsi={0}
                      classList={{
                        active: namespace() === "",
                        cursor: nsIdx() === 0,
                      }}
                      onClick={() => pickNamespace("")}
                    >
                      all namespaces
                    </button>
                  </Show>
                  <For each={nsFiltered()}>
                    {(n, i) => (
                      <button
                        class="ns-item"
                        data-nsi={(nsShowAll() ? 1 : 0) + i()}
                        classList={{
                          active: namespace() === n,
                          cursor: nsIdx() === (nsShowAll() ? 1 : 0) + i(),
                        }}
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
          <Show when={namespace()}>
            <span class="ns-hint" title="press 0 to show all namespaces">
              press <b>0</b> for all
            </span>
          </Show>
        </Show>
        <span class="badge">
          <Show when={active()}>{types().length} kinds</Show>
        </span>
        {/* Always here, not only on an error banner: the moment you need
            it most is while a connection is still hanging on a stale
            credential, and that moment has no banner yet. */}
        <button
          class="icon-btn term-btn"
          title="shell on this machine — tsh login, aws sso login, a VPN (⌘⇧S)"
          onClick={() => openLocalShell()}
        >
          {">_"}
        </button>
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
                    onClick={() => void runLogin()}
                >
                  {authHint()!.kind === "aws-sso" ? "Log in with SSO" : "Log in"}
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
                  disabled={isConnecting(name)}
                  onClick={() => void reconnect(name)}
                >
                  {isConnecting(name) ? "reconnecting…" : `reconnect ${name}`}
                </button>
              )}
            </For>
            {/* Offered on every error, not just the ones we can name a
                login for: the cluster whose credentials need a step the
                kubeconfig never mentions is exactly the one we cannot
                help with a derived command. */}
            {/* The command the cluster itself names, rather than one we
                inferred — the only one that is right when the kubeconfig
                points at a wrapper doing its own login. */}
            <Show when={authHint()?.exec_command}>
              <button
                class="btn sm"
                title={`run ${authHint()!.exec_command} with a terminal attached`}
                onClick={() => runCredentialCommand()}
              >
                run credential command
              </button>
            </Show>
            <button
              class="btn sm"
              title="run tsh login, aws sso login, a VPN — whatever this cluster needs"
              onClick={() =>
                openLocalShell(failed()[0]?.name ?? active() ?? "")
              }
            >
              local shell
            </button>
            <button class="close" onClick={() => setError(null)}>
              ✕
            </button>
          </div>
        </div>
      </Show>

      {loginPanel()}

      {/* Hidden rather than unmounted while settings is open: the table
          keeps its watch, its scroll position and its cursor. */}
      <div class="body" classList={{ hidden: settingsOpen() }}>
        <aside
          class="sidebar"
          classList={{
            collapsed: !sidebarOpen(),
            "pane-active": activePane() === "sidebar",
          }}
        >
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
                  // ↓ / Enter drops the cursor into the filtered list so
                  // arrows keep working from where the search landed.
                  if (
                    e.key === "ArrowDown" ||
                    e.key === "Enter" ||
                    (e.key === "Tab" && !e.shiftKey)
                  ) {
                    e.preventDefault();
                    e.currentTarget.blur();
                    setPane("sidebar");
                    setSideIdx(0);
                    requestAnimationFrame(() =>
                      document
                        .querySelector(`.kind[data-sk="0"]`)
                        ?.scrollIntoView?.({ block: "nearest" }),
                    );
                  } else if (e.key === "Escape") {
                    e.currentTarget.blur();
                  }
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
              <For each={groupTypes()}>
                {(g) => (
                  <Show when={g.types.length > 0}>
                    <div class="group pin-group">
                      <div class="group-name pin-group-head">
                        <span class="pin-star">★</span>
                        <Show
                          when={renamingGroup() === g.name}
                          fallback={
                            <span
                              class="pin-group-name"
                              title="double-click to rename"
                              onDblClick={() => {
                                setRenameText(g.name);
                                setRenamingGroup(g.name);
                              }}
                            >
                              {g.name}
                            </span>
                          }
                        >
                          <input
                            class="search pin-rename"
                            value={renameText()}
                            ref={(el) => setTimeout(() => el.focus())}
                            onInput={(e) => setRenameText(e.currentTarget.value)}
                            onBlur={() => {
                              renameGroup(g.name, renameText());
                              setRenamingGroup(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") setRenamingGroup(null);
                            }}
                          />
                        </Show>
                        <button
                          class="pin-group-del"
                          title="delete this group (unpins its kinds)"
                          onClick={() => deleteGroup(g.name)}
                        >
                          ✕
                        </button>
                      </div>
                      <For each={g.types}>{kindButton}</For>
                    </div>
                  </Show>
                )}
              </For>
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
                      <div class="crd-grp-head">
                        <button
                          class="group-name sub grp-toggle"
                          onClick={() => toggleGroup(group)}
                        >
                          {group}
                          <span class="grp-count">{ts.length}</span>
                        </button>
                        <span
                          class="pin grp-pin"
                          title="pin this whole group to a favorites group"
                          onClick={(e) => {
                            e.stopPropagation();
                            const r = (
                              e.currentTarget as HTMLElement
                            ).getBoundingClientRect();
                            setNewGroupName(group);
                            setPinPickAt({ x: r.right, y: r.bottom + 4 });
                            setPinPick({ types: ts, label: group });
                          }}
                        >
                          ★
                        </span>
                      </div>
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
                        <div class="crd-grp-head">
                          <div class="group-name sub">{group}</div>
                          <span
                            class="pin grp-pin"
                            title="pin this whole group to a favorites group"
                            onClick={(e) => {
                              e.stopPropagation();
                              const r = (
                                e.currentTarget as HTMLElement
                              ).getBoundingClientRect();
                              setNewGroupName(group);
                              setPinPickAt({ x: r.right, y: r.bottom + 4 });
                              setPinPick({ types: ts, label: group });
                            }}
                          >
                            ★
                          </span>
                        </div>
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
                {(() => {
                  const node = () =>
                    activeFieldSel()!.match(/^spec\.nodeName=(.+)$/)?.[1];
                  return (
                    <span class="fieldsel" title={activeFieldSel() ?? ""}>
                      <Show
                        when={node()}
                        fallback={activeFieldSel()!.replace(/^label:/, "")}
                      >
                        <button
                          class="fieldsel-back"
                          title={`back to node ${node()}`}
                          onClick={() => void backToNode(node()!)}
                        >
                          ← node {node()}
                        </button>
                      </Show>
                      <button
                        class="tab-close"
                        title="clear this filter"
                        onClick={() => void select(selected()!)}
                      >
                        ✕
                      </button>
                    </span>
                  );
                })()}
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
              <Show when={selected()}>
                <button
                  class="btn sm share-btn"
                  title="copy a peye:// link to this exact view — anyone with this cluster opens the same place"
                  onClick={() => void copyShareLink()}
                >
                  {sharedCopied() ? (
                    "link copied ✓"
                  ) : (
                    <>
                      <img class="share-ico" src={rocketUrl} alt="" /> share view
                    </>
                  )}
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
                    title="show, hide, reorder and add columns"
                    onClick={() => setColsOpen(!colsOpen())}
                  >
                    ⚙ Edit columns
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
                      <button
                        class="ns-item col-all"
                        title="show or hide every column"
                        onClick={toggleAllCols}
                      >
                        <span class="col-grip" style={{ visibility: "hidden" }}>
                          ⠿
                        </span>
                        <span
                          class="mark-box"
                          classList={{ on: allColsShown() }}
                        />
                        {allColsShown() ? "Deselect all" : "Select all"}
                      </button>
                      <For each={allColsOrdered()}>
                        {(c) => (
                          <button
                            class="ns-item col-row"
                            data-colname={c}
                            classList={{
                              coldrag: dragCol() === c,
                              coldrop: dropCol() === c && dragCol() !== c,
                            }}
                            title="drag to reorder · click to show/hide"
                            onPointerDown={(e) => startColDrag(e, c)}
                            onClick={() => {
                              if (!colDragActive) toggleCol(c);
                            }}
                          >
                            <span class="col-grip" title="drag to reorder">
                              ⠿
                            </span>
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
                      <div class="cols-custom">
                        <div class="section-title sub">Custom columns</div>
                        <p class="cc-blurb">
                          Like <code>kubectl get -o custom-columns</code>, but
                          click instead of type: search a field or label below
                          and add it as a column.
                        </p>
                        <Show when={myCustomCols().length > 0}>
                          <div class="cc-list">
                            <For each={myCustomCols()}>
                              {(cc, i) => (
                                <div class="cc-row">
                                  <span class="cc-name">{cc.name}</span>
                                  <code class="cc-path" title={cc.path}>
                                    {cc.path}
                                  </code>
                                  <button
                                    class="cc-del"
                                    title="remove column"
                                    onClick={() => removeCustomCol(i())}
                                  >
                                    ✕
                                  </button>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show when={pickables().length > 0}>
                          <div class="cc-picker">
                            <label class="cc-lab">Add a column</label>
                            <input
                              class="search cc-in"
                              placeholder={`search ${pickables().length} fields & labels…`}
                              value={labelQuery()}
                              onInput={(e) => setLabelQuery(e.currentTarget.value)}
                            />
                            <div class="cc-labels">
                              <For
                                each={pickables()
                                  .filter((p) =>
                                    `${p.name} ${p.path}`
                                      .toLowerCase()
                                      .includes(labelQuery().toLowerCase()),
                                  )
                                  .slice(0, 80)}
                              >
                                {(p) => (
                                  <button
                                    class="ns-item cc-labelitem"
                                    title={`${p.path}  →  column "${p.name}"`}
                                    onClick={() => {
                                      addCustomCol(p.name, p.path);
                                      setLabelQuery("");
                                    }}
                                  >
                                    <span class="cc-lbl-head">
                                      <span class="cc-lbl-name">{p.name}</span>
                                      <span class="cc-lbl-tag">{p.kind}</span>
                                      <span class="cc-lbl-val">{p.val}</span>
                                    </span>
                                    <Show when={labelQuery().trim()}>
                                      <span class="cc-lbl-key">{p.path}</span>
                                    </Show>
                                  </button>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                        <details class="cc-adv">
                          <summary>
                            <span class="cc-chev">▸</span>
                            <span>Advanced: write a JSONPath by hand</span>
                          </summary>
                        <div class="cc-form">
                          <label class="cc-lab">1. Column name</label>
                          <input
                            class="search cc-in"
                            placeholder="e.g. INSTANCE-TYPE"
                            value={newColName()}
                            onInput={(e) => setNewColName(e.currentTarget.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && submitCustomCol()
                            }
                          />
                          <label class="cc-lab">
                            2. Field path{" "}
                            <span class="cc-lab-dim">(kubectl JSONPath)</span>
                          </label>
                          <input
                            class="search cc-in"
                            placeholder="e.g. .metadata.labels.group"
                            value={newColPath()}
                            onInput={(e) => setNewColPath(e.currentTarget.value)}
                            onKeyDown={(e) =>
                              e.key === "Enter" && submitCustomCol()
                            }
                          />
                          <div class="cc-examples">
                            <span class="cc-ex-lab">examples:</span>
                            <For each={CC_EXAMPLES}>
                              {(ex) => (
                                <button
                                  class="cc-ex"
                                  title={ex.path}
                                  onClick={() => {
                                    setNewColName(ex.name);
                                    setNewColPath(ex.path);
                                  }}
                                >
                                  {ex.label}
                                </button>
                              )}
                            </For>
                          </div>
                          <button
                            class="btn sm cc-addbtn"
                            disabled={
                              !newColName().trim() || !newColPath().trim()
                            }
                            onClick={submitCustomCol}
                          >
                            + Add column
                          </button>
                        </div>
                        </details>
                        <Show when={customErr()}>
                          <div class="cc-err">{customErr()}</div>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>
                {/* Permissions is a "check now and then" thing, not a primary
                    action — tucked into the right corner as an icon so it's
                    out of the way of the search/send controls. */}
                <Show when={selected()}>
                  <button
                    class="btn sm perm-btn"
                    title="what you're allowed to do on this kind (kubectl auth can-i)"
                    onClick={openAccess}
                  >
                    <img class="perm-ico" src={shieldUrl} alt="" /> permissions
                  </button>
                </Show>
                {/* Stable count first so its position never moves; the
                    volatile indexing / loading indicators trail after it
                    and grow into empty space instead of shoving it. */}
                <span class="badge">
                  {/* While filtering, the count is provisional until the
                      full-text index is built — deep-field matches haven't
                      been scanned yet. Show "searching…" instead of a
                      misleading "0" that looks like a re-index. */}
                  <Show
                    when={rowFilter().trim() && !deepReady()}
                    fallback={
                      <>
                        {rowCount()} {selected()?.plural ?? "items"}
                        <Show when={dsCount() > 0}>
                          <span class="dim" title="DaemonSet pods (one per node) are sorted to the bottom">
                            {" · "}
                            {dsCount()} daemonset
                          </span>
                        </Show>
                        <Show when={live()}>
                          <span class="live-dot" title="live: updates arrive as they happen" />
                        </Show>
                        <Show when={indexing()}>
                          <span class="dim"> · indexing…</span>
                        </Show>
                      </>
                    }
                  >
                    <span class="badge-spin" />
                    <span class="dim"> searching {selected()?.plural ?? "items"}…</span>
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
                <span class="mark-hint">space marks · hold + move sweeps · ⌘A all · esc clear</span>
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
                    when={rowFilter().trim() && !deepReady()}
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
                  class="table-frame"
                  classList={{ "pane-active": activePane() === "table" }}
                  style={{
                    // Shrink the frame to end at the terminal's top so the
                    // bottom rows (and the boundary) aren't hidden behind the
                    // dock — the ResizeObserver below refits the window to it.
                    "margin-bottom":
                      shells().length > 0 && !termMin()
                        ? `${termHeight()}px`
                        : "",
                  }}
                >
                <div
                  class="table-wrap"
                  tabindex="-1"
                  ref={(el) => {
                    tableFocusRef = el;
                    setViewH(el.clientHeight || 600);
                    tableRO?.disconnect();
                    tableRO = new ResizeObserver(() => {
                      // Defer to the next frame: measuring + updating state
                      // synchronously inside the callback can re-trigger the
                      // observer in the same frame (the benign "ResizeObserver
                      // loop" warning), which zoom made easy to hit.
                      requestAnimationFrame(() => {
                        // a detached element reports 0; ignore it or the
                        // window collapses to the overscan size
                        const h = el.clientHeight;
                        if (h > 0) setViewH(h);
                      });
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
                              draggable={true}
                              data-col={i()}
                              classList={{
                                sorted: sortCol() === i(),
                                coldrag: dragCol() === c,
                                coldrop: !!dragCol() && dragCol() !== c,
                              }}
                              onDragStart={(e) => {
                                setDragCol(c);
                                e.dataTransfer?.setData("text/plain", c);
                                if (e.dataTransfer)
                                  e.dataTransfer.effectAllowed = "move";
                              }}
                              onDragEnd={() => setDragCol(null)}
                              onDragOver={(e) =>
                                dragCol() && dragCol() !== c && e.preventDefault()
                              }
                              onDrop={(e) => {
                                const from = dragCol();
                                if (from) {
                                  e.preventDefault();
                                  moveColumn(from, c);
                                }
                              }}
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
                          style={{ height: `${windowRange().first * rowH()}px` }}
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
                                    fallback={
                                      <>
                                        {view().cols[i()]?.toLowerCase() ===
                                        "age"
                                          ? liveAge(vr.row, cell)
                                          : cell}
                                      </>
                                    }
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
                            height: `${(windowRange().total - windowRange().last) * rowH()}px`,
                          }}
                        />
                      </Show>
                    </tbody>
                  </table>
                </div>
                </div>
              </Show>
            </Show>
          </Show>

          <Show when={detailKey()}>
            <div
              class="drawer"
              classList={{ "pane-active": activePane() === "detail" }}
              onClick={(e) => e.stopPropagation()}
            >
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
                <button
                  class="btn sm share-btn drawer-share"
                  title="copy a peye:// link straight to this resource — opens the same place for anyone with the cluster"
                  onClick={() => void copyShareLink()}
                >
                  {sharedCopied() ? (
                    "link copied ✓"
                  ) : (
                    <>
                      <img class="share-ico" src={rocketUrl} alt="" /> share view
                    </>
                  )}
                </button>
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
                    {actionBtn("debug", () =>
                      openShell({
                        kind: "debug",
                        context: active()!,
                        namespace: detail()!.namespace ?? "default",
                        name: detail()!.name,
                      }),
                    )}
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
                  <Show when={kindIs("apps", "Deployment")}>
                    {actionBtn("history", () => openHistory())}
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
                  <Show when={isNode()}>
                    <div
                      class="psec"
                      data-sec="nodepods"
                      classList={{ cur: panelSec() === "nodepods" }}
                    >
                      <div class="psec-title">
                        pods on this node
                        <Show when={nodePods()}>
                          <span class="dim"> ({nodePods()!.rows.length})</span>
                        </Show>
                        <Show when={draining() === detail()?.name}>
                          <span class="drain-badge">
                            <span class="badge-spin" />
                            draining — {drainRemaining()?.evictable ?? 0} to evict
                          </span>
                        </Show>
                        <Show when={drainDone() === detail()?.name}>
                          <span
                            class="drain-badge done"
                            title="only DaemonSet/mirror pods remain — a complete drain. The node can now be removed."
                          >
                            ✓ drained — DaemonSet/mirror pods remain
                          </span>
                        </Show>
                        <Show when={drainStalled() === detail()?.name}>
                          <span
                            class="drain-badge stalled"
                            title="eviction made no progress — usually a PodDisruptionBudget refusing it"
                          >
                            {drainRemaining()?.evictable ?? 0} won't evict — PodDisruptionBudget?
                          </span>
                        </Show>
                      </div>
                      <Show
                        when={!nodePodsLoading()}
                        fallback={<div class="dim np-note">loading pods…</div>}
                      >
                        <Show
                          when={!nodePodsErr()}
                          fallback={<div class="np-note bad">{nodePodsErr()}</div>}
                        >
                          <Show
                            when={(nodePods()?.rows.length ?? 0) > 0}
                            fallback={<div class="dim np-note">no pods scheduled here</div>}
                          >
                            <div class="np-wrap">
                              <table class="np">
                                <thead>
                                  <tr>
                                    <th>Namespace</th>
                                    <th>Controller</th>
                                    <For each={nodePodCols()}>
                                      {(col) => <th>{col.c.name}</th>}
                                    </For>
                                  </tr>
                                </thead>
                                <tbody>
                                  <For each={nodePods()!.rows}>
                                    {(r) => (
                                      <tr
                                        onClick={() =>
                                          void openPodFromNode(
                                            detail()!.name,
                                            r.namespace,
                                            r.name,
                                          )
                                        }
                                      >
                                        <td class="dim">{r.namespace}</td>
                                        {/* Controller as its own column so
                                            DaemonSet pods (the ones drain
                                            leaves behind) are unmistakable and
                                            never clipped by a long pod name. */}
                                        <td
                                          classList={{
                                            "np-ds": r.owner_kind === "DaemonSet",
                                            dim: r.owner_kind !== "DaemonSet",
                                          }}
                                          title={
                                            r.owner_kind === "DaemonSet"
                                              ? "DaemonSet pod — drain leaves these in place"
                                              : undefined
                                          }
                                        >
                                          {r.owner_kind ?? "—"}
                                        </td>
                                        <For each={nodePodCols()}>
                                          {(col) => (
                                            <td
                                              classList={{
                                                bad:
                                                  col.c.name === "STATUS" &&
                                                  !/^(Running|Completed|Succeeded)$/.test(
                                                    String(r.cells[col.i] ?? ""),
                                                  ),
                                              }}
                                            >
                                              {String(r.cells[col.i] ?? "")}
                                            </td>
                                          )}
                                        </For>
                                      </tr>
                                    )}
                                  </For>
                                </tbody>
                              </table>
                            </div>
                          </Show>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                  <Show when={detail()!.containers?.length}>
                    <div
                      class="psec"
                      data-sec="containers"
                      classList={{ cur: panelSec() === "containers" }}
                    >
                      <div class="psec-title">
                        containers ({detail()!.containers.length})
                      </div>
                      <div class="ctr-list">
                        <For each={detail()!.containers}>
                          {(c) => (
                            <div class="ctr-row">
                              <span class="ctr-name" title={c}>
                                {c}
                              </span>
                              <button
                                class="btn sm"
                                title={`logs — ${c}`}
                                onClick={() => openPodSession("logs", c)}
                              >
                                logs
                              </button>
                              <button
                                class="btn sm"
                                title={`shell into ${c}`}
                                onClick={() => openPodSession("pod", c)}
                              >
                                shell
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
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
                                onClick={() => void copySecret(k, v)}
                              >
                                {copiedSecret() === k ? "copied ✓" : "copy"}
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
                      {/* Events start open every time — they're usually why
                          the panel was opened. `true` is a constant (no
                          reactive dep), so it only sets the initial state;
                          the user can still collapse it with v / Enter / click. */}
                      <details
                        class="fold"
                        ref={(el) => (eventFoldRef = el)}
                        open={true}
                      >
                        <summary class="section-title">
                          Events ({events().length})
                          <Show when={events().some((e) => e.type_ === "Warning")}>
                            <span class="ev-warnbadge">
                              {events().filter((e) => e.type_ === "Warning").length}{" "}
                              warning
                            </span>
                          </Show>
                          <button
                            class="btn sm copy-btn ev-copyall"
                            title="copy every event to the clipboard"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void copyAllEvents();
                            }}
                          >
                            {copiedAll() ? "copied ✓" : "copy all"}
                          </button>
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
                                  <button
                                    class="ev-copy"
                                    title="copy this event"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void copyEvent(ev);
                                    }}
                                  >
                                    {copiedEv() === ev ? "✓" : "copy"}
                                  </button>
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
                        const f = forceApply();
                        setDlgIdx(1);
                        setConfirm({
                          title: f ? "Force-apply changes?" : "Apply changes?",
                          body:
                            `Patches ${selected()?.kind}/${detail()!.name}${detail()!.namespace ? ` in ${detail()!.namespace}` : ""} on ${active()} via server-side apply.` +
                            (f
                              ? "\n\nForce is ON: PigeonEye takes ownership of any conflicting fields and overwrites changes made on the server since load — no further prompt."
                              : ""),
                          label: f ? "Force apply" : "Apply to cluster",
                          danger: f,
                          run: () => applyYaml(f),
                        });
                      }}
                    >
                      {actionBusy() === "apply" ? "applying…" : "Apply"}
                    </button>
                    <label
                      class="force-apply"
                      title="take ownership of conflicting fields and skip the conflict prompt"
                    >
                      <input
                        type="checkbox"
                        checked={forceApply()}
                        onChange={(e) => setForceApply(e.currentTarget.checked)}
                      />
                      force
                    </label>
                    <button
                      class="btn"
                      title="server dry-run: validate without persisting"
                      disabled={actionBusy() !== null}
                      onClick={() => {
                        setDlgIdx(1);
                        setConfirm({
                          title: "Run a server dry-run?",
                          body: "This only CHECKS — nothing is applied or persisted. The manifest is sent to the API server, which runs full validation (schema, admission webhooks like Kyverno/OPA, defaulting, quota, RBAC) and returns the result, then discards it.",
                          label: "Run check",
                          danger: false,
                          run: () => runDryRun(),
                        });
                      }}
                    >
                      {actionBusy() === "dryrun" ? "checking…" : "dry-run"}
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
              classList={{
                focused: termDockFocused(),
                "pane-active": activePane() === "terminal",
              }}
              style={{ height: `${termHeight()}px` }}
              onClick={(e) => e.stopPropagation()}
              onFocusIn={() => setTermDockFocused(true)}
              onFocusOut={(e) => {
                // Still in the dock (xterm ↔ toolbar) → stay active; only
                // drop when focus actually leaves the terminal panel.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setTermDockFocused(false);
              }}
            >
              <div
                class="term-resize"
                title="drag to resize · ⌘⇧↑/↓"
                onPointerDown={startTermResize}
              />
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
                    ? "esc leave · ⌘←/→ or ⇧tab switch · ⌘⇧↑/↓ resize · ⇧⌘W close · ⌘T hide"
                    : "⌘T or click to type · drag top or ⌘⇧↑/↓ to resize"}
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
                      onResize={(d) => setTermHeight(termHeight() + d * 48)}
                      api={(a) => termApis.set(sh.k, a)}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={cmdOpen()}>
            <div
              class="modal-backdrop top"
              onClick={() => {
                clearXSearch();
                setCmdOpen(false);
              }}
            >
              <div class="cmd" onClick={(e) => e.stopPropagation()}>
                <input autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck={false}
                  class="cmd-input"
                  placeholder=":pods · deploy api · ns kube-system · ctx dev"
                  ref={(el) => setTimeout(() => el.focus())}
                  value={cmdText()}
                  onInput={(e) => {
                    // A new question replaces the old answers — but only
                    // real input does. Doing this on keydown threw the
                    // results away on shift, ⌘, or a stray arrow.
                    if (xSearch()) clearXSearch();
                    setCmdText(e.currentTarget.value);
                    setCmdIdx(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      runCmd(cmdItems()[cmdIdx()] ?? cmdItems()[0]);
                    else if (e.key === "Tab") {
                      // Complete rather than run: after the kind comes the
                      // namespace, the name, the selector. Enter is still
                      // there for when the highlighted row is the answer.
                      e.preventDefault();
                      const item = cmdItems()[cmdIdx()] ?? cmdItems()[0];
                      if (item?.complete) {
                        setCmdText(item.complete);
                        setCmdIdx(0);
                      }
                    }
                    else if (pageDir(e)) {
                      e.preventDefault();
                      const step = pageDir(e) * pageOf(".cmd-list", ".cmd-item");
                      setCmdIdx(clamp(cmdIdx() + step, cmdItems().length));
                      scrollCmdCursor();
                    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const n = cmdItems().length;
                      if (!n) return;
                      const step = e.key === "ArrowDown" ? 1 : -1;
                      // Wraps, unlike the sidebar and the table. Those
                      // are places you navigate, where running off an end
                      // should stop; this is a short menu you are picking
                      // from, and its last row is one key up from the top.
                      setCmdIdx((cmdIdx() + step + n) % n);
                      scrollCmdCursor();
                    } else if (e.key === "Escape") {
                      // Results first, palette second — one esc should not
                      // throw away both the search and the query.
                      if (xSearch()) {
                        clearXSearch();
                        setCmdIdx(0);
                      } else setCmdOpen(false);
                    }
                  }}
                />
                <div class="cmd-list">
                  <For each={cmdItems()}>
                    {(item, i) => (
                      <button
                        class="cmd-item"
                        data-cmdi={i()}
                        classList={{
                          active: cmdIdx() === i(),
                          search: !!item.search,
                        }}
                        onMouseEnter={() => setCmdIdx(i())}
                        onClick={() => runCmd(item)}
                      >
                        <Show when={item.busy}>
                          <span class="cmd-spin" />
                        </Show>
                        <Show when={item.context}>
                          <span
                            class="ctx-dot"
                            style={{ "--ctx-hue": ctxHue(item.context!) }}
                          />
                        </Show>
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

          <Show when={deepLinkMiss()} keyed>
            {(miss) => (
              <div
                class="modal-backdrop"
                onClick={() => setDeepLinkMiss(null)}
              >
                <div class="modal" onClick={(e) => e.stopPropagation()}>
                  <h3>Cluster not in your kubeconfig</h3>
                  <p>
                    This link opens{" "}
                    <Show when={miss.ctx} fallback={<>a cluster</>}>
                      <b>{miss.ctx}</b>
                    </Show>
                    , but no context here points to it
                    <Show when={miss.host}>
                      {" "}
                      (<code>{miss.host}</code>)
                    </Show>
                    . Add the cluster to your kubeconfig, then reopen the link.
                  </p>
                  {(() => {
                    const hint = clusterAddHint(miss.host, miss.ctx);
                    return (
                      <>
                        <Show when={hint.provider}>
                          <p class="dim">Looks like a {hint.provider} cluster.</p>
                        </Show>
                        <Show
                          when={hint.cmd}
                          fallback={
                            <p class="dim">
                              Couldn't identify the provider from the endpoint —
                              add the context with your provider's CLI (GKE:{" "}
                              <code>
                                gcloud container clusters get-credentials …
                              </code>
                              , or merge the kubeconfig you were given), then
                              reopen the link.
                            </p>
                          }
                        >
                          <div class="dl-cmd">
                            <code>{hint.cmd!}</code>
                            <button
                              class="btn sm"
                              onClick={() => void copyDlCmd(hint.cmd!)}
                            >
                              {dlCopied() ? "copied ✓" : "copy"}
                            </button>
                          </div>
                          <Show
                            when={
                              hint.provider === "GKE" ||
                              hint.provider === "AKS"
                            }
                          >
                            <p class="dim dl-note">
                              Fill in the &lt;placeholders&gt; first.
                            </p>
                          </Show>
                        </Show>
                      </>
                    );
                  })()}
                  <div class="modal-actions">
                    <button
                      class="btn primary"
                      onClick={() => setDeepLinkMiss(null)}
                    >
                      Got it
                    </button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <Show when={helpOpen()}>
            <div class="modal-backdrop" onClick={() => setHelpOpen(false)}>
              <div class="modal help" onClick={(e) => e.stopPropagation()}>
                <h3>Keyboard shortcuts</h3>
                <div class="help-grid">
                  <b class="help-sec">table</b>
                  <b>:</b><span>palette — kind · kind ns · kind /name · kind k=v · kind @ctx · ns · ctx</span>
                  <b>/</b><span>search rows (any field value)</span>
                  <b>esc</b><span>step up: detail → table → sidebar</span>
                  <b>j k ↑ ↓</b><span>move cursor · g/G first/last</span>
                  <b>enter · →</b><span>from the sidebar: open that kind</span>
                  <b>← →</b><span>pan wide tables · ← at the left edge steps up to the sidebar · Home/End first/last column</span>
                  <b>Enter</b><span>open detail — on a namespace, scope to it and list its pods</span>
                  <b>n</b><span>new resource (creatable kinds) · ⇧↑ on top row → search</span>
                  <b>f</b><span>filter the sorted column (values or &gt;/&lt; for numbers)</span>
                  <b>⌘F</b><span>focus the row search / find in the open detail</span>
                  <b>: kind name</b><span>search that kind by name across every open cluster — ↵ on the header re-reads</span>
                  <b>tab (in :)</b><span>complete to the highlighted kind and keep typing</span>
                  <b>s</b><span>shell (pod / node)</span>
                  <b>l</b><span>logs (pod / workload aggregate)</span>
                  <b>e / y</b><span>edit manifest (YAML) of cursor row</span>
                  <b>⌘C</b><span>copy the manifest (detail open, nothing selected)</span>
                  <b>space</b><span>mark a row · ⌘A all · esc clears</span>
                  <b>space + ↑↓</b><span>hold space and move to sweep a range of rows</span>
                  <b>⌘/ctrl D</b><span>delete marked rows, or the cursor row (⇧ adds force)</span>
                  <b>⌘/ctrl R</b><span>rollout restart of cursor row</span>
                  <b>c · ⇧D</b><span>cordon · drain the cursor node</span>
                  <b>d</b><span>delete (detail open)</span>
                  <b>⇧← ⇧→</b><span>pick the sort column</span>
                  <b>⇧↑ ⇧↓</b><span>sort ascending / descending</span>
                  <b>Shift A/N/S/R/T/C/M/I/O</b>
                  <span>sort by age · name · status · ready · restarts · cpu · mem · ip · node</span>
                  <b>Esc</b><span>close → clear filter → view history back</span>
                  <b class="help-sec">detail panel</b>
                  <b>↑ ↓ · j k</b><span>move between sections (↑ to the top reaches share view)</span>
                  <b>← →</b><span>reach a section's buttons — actions, copy / copy all, Apply</span>
                  <b>Enter</b><span>open the focused section (folds · editor) or press its button</span>
                  <b>← h</b><span>back to the table — from a section header, or from the first button of a row</span>
                  <b>⇞ ⇟ · g G</b><span>scroll · first / last section</span>
                  <b>fn ↑↓ (⇞⇟)</b><span>page through any list — table, sidebar, palette, pickers</span>
                  <b>⇧J ⇧K</b><span>previous / next resource, panel follows</span>
                  <b>a · t · v</b><span>toggle annotations · status · events</span>
                  <b>c · ⇧D</b><span>cordon/uncordon · drain (nodes)</span>
                  <b>r · n</b><span>rollout restart · scale input</span>
                  <b>p</b><span>node ↔ its pods</span>
                  <b>⇧F</b><span>port-forward input (pods)</span>
                  <b>⇧X</b><span>force delete (pods / nodes)</span>
                  <b class="help-sec">app</b>
                  <b>⌘B · ⌘K</b><span>sidebar collapse · focus kind filter</span>
                  <b>0</b><span>back to all namespaces</span>
                  <b>⌘ + / − / 0</b><span>zoom in / out / reset</span>
                  <b>⌥ + / − / 0</b><span>table row height — tighter / roomier / reset</span>
                  <b>⌘,</b><span>settings (kubeconfig, shell)</span>
                  <b>tab · ⇧tab</b><span>next / previous cluster tab</span>
                  <b>ctrl+1-9</b><span>jump straight to a cluster tab</span>
                  <b>⌘T</b><span>show / hide the terminal dock</span>
                  <b>⌘⇧S</b><span>a shell on this machine — tsh login, aws sso login, a VPN</span>
                  <b>⌘⇧↑ / ↓</b><span>resize the log / shell dock (or drag its top edge)</span>
                  <b>in logs: j/k ↑↓ · g/G · /</b><span>scroll · top / bottom · find</span>
                  <b>tab (in logs)</b><span>enter the log toolbar → ←/→ move · ↵ press · esc back</span>
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

          <Show when={access()}>
            <div class="modal-backdrop" onClick={() => setAccess(null)}>
              <div class="modal" onClick={(e) => e.stopPropagation()}>
                <h3>
                  My permissions · {selected()?.plural}
                  <span class="dim gv">
                    {selected()?.namespaced ? namespace() || "all ns" : "cluster"}
                  </span>
                </h3>
                <Show
                  when={access()!.length}
                  fallback={<p class="dim">checking…</p>}
                >
                  <div class="access-grid">
                    <For each={access()}>
                      {([verb, ok]) => (
                        <>
                          <span class="access-verb">{verb}</span>
                          <span classList={{ "access-y": ok, "access-n": !ok }}>
                            {ok ? "✓ allowed" : "✗ denied"}
                          </span>
                        </>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="modal-actions">
                  <button class="btn primary" onClick={() => setAccess(null)}>
                    close
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={history()}>
            <div class="modal-backdrop" onClick={() => setHistory(null)}>
              <div class="modal new-modal" onClick={(e) => e.stopPropagation()}>
                <h3>Rollout history</h3>
                <div class="rev-list">
                  <For each={history()}>
                    {(r) => (
                      <div class="rev-row" classList={{ cur: r.current }}>
                        <span class="rev-num">#{r.revision}</span>
                        <span class="rev-imgs">{r.images.join(", ")}</span>
                        <Show
                          when={!r.current}
                          fallback={<span class="dim">current</span>}
                        >
                          <button class="btn sm" onClick={() => rollbackTo(r)}>
                            roll back
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={history()!.length === 0}>
                    <p class="dim" style={{ padding: "8px" }}>
                      no ReplicaSet revisions found
                    </p>
                  </Show>
                </div>
                <div class="modal-actions">
                  <button class="btn" onClick={() => setHistory(null)}>
                    close
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={dryRun()}>
            <div class="modal-backdrop" onClick={() => setDryRun(null)}>
              <div
                class="modal new-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <h3>
                  {!dryRun()!.ok
                    ? "dry-run failed"
                    : dryRun()!.text.startsWith("# previewed with force")
                      ? "✓ dry-run passed — with force"
                      : "✓ dry-run passed"}
                  <span class="dim gv">server-side, not persisted</span>
                </h3>
                <Show
                  when={dryRun()!.ok}
                  fallback={<div class="new-err">{dryRun()!.text}</div>}
                >
                  <p class="dim new-hint">
                    The API server accepted the manifest. Below is the object
                    it would produce (defaults and admission applied):
                  </p>
                  <pre class="dryrun-out">{dryRun()!.text}</pre>
                </Show>
                <div class="modal-actions">
                  <button class="btn primary" onClick={() => setDryRun(null)}>
                    close
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <Show when={pinPick()}>
            <div class="col-menu-backdrop" onClick={() => setPinPick(null)} />
            <div
              class="col-menu pin-pick"
              style={{
                left: `${pinPickAt()?.x ?? 0}px`,
                top: `${pinPickAt()?.y ?? 0}px`,
              }}
            >
              <div class="col-menu-head">
                pin <b>{pinPick()!.label}</b>
                <Show when={pinPick()!.types.length > 1}>
                  {" "}
                  <span class="dim">({pinPick()!.types.length} kinds)</span>
                </Show>{" "}
                to…
              </div>
              <div class="col-menu-list">
                <For each={pinGroups()}>
                  {(g) => (
                    <button
                      class="ns-item"
                      onClick={() => pinTypesToGroup(pinPick()!.types, g.name)}
                    >
                      ★ {g.name}
                    </button>
                  )}
                </For>
              </div>
              <div class="pin-pick-new">
                <input
                  class="search"
                  placeholder="new group…"
                  value={newGroupName()}
                  ref={(el) => setTimeout(() => el.focus())}
                  onInput={(e) => setNewGroupName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newGroupName().trim())
                      pinTypesToGroup(pinPick()!.types, newGroupName().trim());
                    if (e.key === "Escape") setPinPick(null);
                  }}
                />
                <button
                  class="btn sm"
                  disabled={!newGroupName().trim()}
                  onClick={() =>
                    pinTypesToGroup(pinPick()!.types, newGroupName().trim())
                  }
                >
                  add
                </button>
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
    </>
  );
}

export default App;
