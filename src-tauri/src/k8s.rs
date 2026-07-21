use futures::future::join_all;
use k8s_openapi::api::core::v1::Pod as K8sPod;
use kube::api::{
    Api, AttachParams, DeleteParams, DynamicObject, EvictParams, ListParams, Patch, PatchParams,
    PostParams, TerminalSize,
};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::core::{ApiResource as KubeApiResource, GroupVersionKind};
use kube::discovery::{verbs, Discovery, Scope};
use kube::{Client, Config};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::RwLock;

#[derive(Default)]
pub struct AppState {
    /// One client per connected context: every open cluster tab keeps
    /// its own connection, so requests to different clusters run in
    /// parallel and switching tabs never re-handshakes.
    pub clients: RwLock<std::collections::HashMap<String, Client>>,
    /// Full-text blobs for the currently listed rows. They stay on the
    /// Rust side — the webview only ever sees matching row indices —
    /// because shipping ~18MB of flattened objects over IPC per list is
    /// what "slow" feels like.
    pub search: std::sync::Arc<RwLock<SearchCache>>,
    /// Live exec sessions (pod shells, node shells, log streams).
    pub exec: RwLock<std::collections::HashMap<u32, ExecSession>>,
    pub next_exec: std::sync::atomic::AtomicU32,
    /// Active port-forwards (local listener → pod port).
    pub forwards: RwLock<std::collections::HashMap<u32, PfSession>>,
    /// Live watches feeding incremental table updates.
    pub watches: RwLock<std::collections::HashMap<u32, tokio::task::AbortHandle>>,
    /// Recently viewed lists, so going back to a view paints from
    /// memory instead of refetching (an Events list can be 20k rows).
    pub lists: RwLock<Vec<(String, CachedList)>>,
}

pub struct ExecSession {
    /// None for read-only sessions (log streaming).
    stdin: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
    resize: Option<futures::channel::mpsc::Sender<TerminalSize>>,
    aborts: Vec<tokio::task::AbortHandle>,
    /// (context, namespace, pod) to delete when the session ends —
    /// used by node shells to reap their helper pod.
    cleanup: Option<(String, String, String)>,
}

pub struct PfSession {
    pub abort: tokio::task::AbortHandle,
    /// Per-connection tunnels; stopping the listener alone would leave
    /// established streams copying bytes to the pod forever.
    pub conns: std::sync::Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
    pub info: PfInfo,
}

#[derive(Serialize, Clone)]
pub struct PfInfo {
    pub id: u32,
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub remote: u16,
    pub local: u16,
}

#[derive(Clone)]
pub struct CachedList {
    pub columns: Vec<ColumnDef>,
    pub rows: Vec<TableRow>,
    pub resource_version: Option<String>,
    pub include: String,
}

/// How many past views to keep. Each one is rows only — no open
/// connections — so the cost is memory, not sockets.
const LIST_CACHE_MAX: usize = 6;

#[derive(Default)]
pub struct SearchCache {
    pub generation: u64,
    /// What the current rows came from, so the full-text index can be
    /// built later without the UI re-sending it.
    pub source: Option<(String, ResourceType, Option<String>, Option<String>)>,
    /// Whether blobs hold full objects (true) or just the cheap seed.
    pub indexed: bool,
    /// ns/name key per row, same order as the rows sent to the UI.
    pub keys: Vec<String>,
    pub blobs: Vec<String>,
    /// Pod lists only: per-pod summed container requests/limits,
    /// harvested from the same background full-object fetch that
    /// builds the search index. Joined with live PodMetrics by
    /// pod_stats for the live CPU/MEM columns.
    pub pod_res: std::collections::HashMap<String, PodRes>,
}

#[derive(Default, Clone, Copy)]
pub struct PodRes {
    pub cpu_r: i64,
    pub cpu_l: i64,
    pub mem_r: i64,
    pub mem_l: i64,
}

#[derive(Serialize)]
pub struct ContextInfo {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub is_current: bool,
    /// Which kubeconfig file this context came from ("" = default chain).
    pub source: String,
}

/// One listable resource type, straight from API discovery.
/// Nothing is hardcoded: every built-in, aggregated API and CRD the
/// cluster serves shows up here — VolumeAttachment, CSIDriver,
/// EndpointSlice, Cilium/Istio CRDs, all of it.
#[derive(Serialize, Deserialize, Clone)]
pub struct ResourceType {
    pub group: String,
    pub version: String,
    pub kind: String,
    pub plural: String,
    pub namespaced: bool,
    /// Verbs the API server advertises — the UI only offers actions
    /// the cluster actually accepts (defaults true for hand-built refs).
    #[serde(default = "yes")]
    pub deletable: bool,
    #[serde(default = "yes")]
    pub editable: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Clone)]
pub struct ColumnDef {
    pub name: String,
    pub priority: i64,
}

#[derive(Serialize, Clone)]
pub struct TableRow {
    pub name: String,
    pub namespace: Option<String>,
    /// Server-side printer cells, same as `kubectl get` columns.
    pub cells: Vec<serde_json::Value>,
    pub labels: std::collections::BTreeMap<String, String>,
    /// Controller kind from the first ownerReference (e.g. "DaemonSet",
    /// "ReplicaSet", "StatefulSet", "Job"). Only populated when the list
    /// carries object metadata; the UI uses it to sink DaemonSet pods to
    /// the bottom of an all-namespaces pod list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_kind: Option<String>,
}

#[derive(Serialize)]
pub struct ResourceTable {
    pub columns: Vec<ColumnDef>,
    pub rows: Vec<TableRow>,
    pub truncated: bool,
    /// Where a watch should resume from to receive only changes.
    pub resource_version: Option<String>,
    /// The projection the list used; a watch must match it or the
    /// incoming rows would have different columns.
    pub include: String,
}

#[derive(Serialize)]
pub struct ResourceDetail {
    pub name: String,
    pub namespace: Option<String>,
    pub created: Option<String>,
    pub labels: std::collections::BTreeMap<String, String>,
    pub annotations: std::collections::BTreeMap<String, String>,
    pub status: Option<serde_json::Value>,
    /// Node only: current spec.unschedulable, drives Cordon/Uncordon.
    pub unschedulable: Option<bool>,
    /// Pod only: spec.nodeName, drives the jump-to-node action.
    pub node_name: Option<String>,
    /// Pod only: declared containerPorts, prefill for port-forward.
    pub ports: Vec<u16>,
    /// Pod only: container names, so shell/logs can offer a choice.
    pub containers: Vec<String>,
    /// The version the editor loaded, used as an apply precondition so
    /// a stale buffer cannot clobber someone else's change.
    pub resource_version: Option<String>,
    /// Event only: the object the event is about, so the UI can jump.
    pub involved: Option<InvolvedRef>,
    /// Owners and referenced objects worth jumping to.
    pub links: Vec<InvolvedRef>,
    /// True when the object selects pods (workloads, services).
    pub has_pod_selector: bool,
    /// Scalable workloads: desired and currently ready replicas.
    pub replicas: Option<i64>,
    pub ready_replicas: Option<i64>,
    /// Desired manifest as YAML: status and server-managed metadata
    /// stripped, i.e. what you would `kubectl apply`.
    pub yaml: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Enumerate contexts. With no explicit paths the default chain
/// ($KUBECONFIG / ~/.kube/config) is used; otherwise every given file
/// is read and merged, each context remembering its source file.
pub async fn list_contexts(paths: Vec<String>) -> Result<Vec<ContextInfo>, String> {
    let mut sources: Vec<(String, Kubeconfig)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    // The default chain is always read; extra files add to it rather
    // than replace it, which is what the settings panel promises.
    match Kubeconfig::read() {
        Ok(kc) => sources.push((String::new(), kc)),
        Err(e) if paths.is_empty() => errors.push(e.to_string()),
        Err(_) => {}
    }
    for p in &paths {
        let expanded = shellexpand_home(p);
        match Kubeconfig::read_from(&expanded) {
            Ok(kc) => sources.push((p.clone(), kc)),
            Err(e) => errors.push(format!("{p}: {e}")),
        }
    }
    if sources.is_empty() {
        return Err(errors.join("\n"));
    }
    let mut out = Vec::new();
    for (src, kc) in sources {
        let current = kc.current_context.clone().unwrap_or_default();
        for nc in &kc.contexts {
            let ctx = nc.context.clone().unwrap_or_default();
            out.push(ContextInfo {
                name: nc.name.clone(),
                cluster: ctx.cluster,
                user: ctx.user.unwrap_or_default(),
                namespace: ctx.namespace,
                is_current: nc.name == current,
                source: src.clone(),
            });
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct AuthHint {
    /// Machine tag: aws-sso | aws | gcloud | exec | none
    pub kind: String,
    /// One line telling the user what's wrong and what will happen.
    pub message: String,
    /// The login command we would run (shown before running).
    pub command: Option<String>,
    /// True when we know how to run it and re-authenticate in place.
    pub can_login: bool,
}

/// The login command that fixes a given context's credentials, derived
/// from its kubeconfig exec block — never from arbitrary error text.
/// We only recognise commands we can run safely and that open their own
/// browser flow: `aws sso login` and `gcloud auth login`.
fn login_plan(exec_command: &str, args: &[String], env: &[(String, String)]) -> AuthHint {
    let profile = env
        .iter()
        .find(|(k, _)| k == "AWS_PROFILE")
        .map(|(_, v)| v.clone())
        .or_else(|| {
            args.windows(2)
                .find(|w| w[0] == "--profile")
                .map(|w| w[1].clone())
        });
    let base = exec_command.rsplit('/').next().unwrap_or(exec_command);

    if base == "aws" || args.iter().any(|a| a == "eks") {
        let cmd = match &profile {
            Some(p) => format!("aws sso login --profile {p}"),
            None => "aws sso login".to_string(),
        };
        return AuthHint {
            kind: "aws-sso".into(),
            message: format!(
                "AWS credentials for this cluster have expired.{} Logging in opens your browser to renew the SSO session.",
                profile
                    .as_ref()
                    .map(|p| format!(" (profile {p})"))
                    .unwrap_or_default()
            ),
            command: Some(cmd),
            can_login: true,
        };
    }
    if base == "gke-gcloud-auth-plugin" || base == "gcloud" {
        return AuthHint {
            kind: "gcloud".into(),
            message: "Google Cloud credentials have expired. Logging in opens your browser.".into(),
            command: Some("gcloud auth login".into()),
            can_login: true,
        };
    }
    // an exec plugin we don't recognise: tell the user how it authenticates
    AuthHint {
        kind: "exec".into(),
        message: format!(
            "This cluster authenticates with `{}`. Re-run its login, then reconnect.",
            exec_command
        ),
        command: None,
        can_login: false,
    }
}

/// Inspect a context's kubeconfig to explain an auth failure and, when
/// possible, offer a one-click login.
pub async fn auth_hint(
    context: String,
    path: Option<String>,
) -> Result<AuthHint, String> {
    let kc = match path.filter(|p| !p.is_empty()) {
        Some(p) => Kubeconfig::read_from(shellexpand_home(&p)).map_err(err)?,
        None => Kubeconfig::read().map_err(err)?,
    };
    let user = kc
        .contexts
        .iter()
        .find(|c| c.name == context)
        .and_then(|c| c.context.as_ref())
        .and_then(|c| c.user.clone());
    let auth = user.and_then(|u| {
        kc.auth_infos
            .iter()
            .find(|a| a.name == u)
            .and_then(|a| a.auth_info.as_ref())
    });
    let Some(exec) = auth.and_then(|a| a.exec.as_ref()) else {
        return Ok(AuthHint {
            kind: "none".into(),
            message: "This cluster uses static credentials — nothing to refresh here.".into(),
            command: None,
            can_login: false,
        });
    };
    let env: Vec<(String, String)> = exec
        .env
        .as_ref()
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    Some((m.get("name")?.clone(), m.get("value")?.clone()))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(login_plan(
        exec.command.as_deref().unwrap_or(""),
        exec.args.as_deref().unwrap_or(&[]),
        &env,
    ))
}

/// Run the login command from a hint and wait for it. It opens its own
/// browser window; we just report when it finishes so the UI can
/// reconnect.
pub async fn auth_login(context: String, path: Option<String>) -> Result<(), String> {
    let hint = auth_hint(context, path).await?;
    let Some(cmd) = hint.command.filter(|_| hint.can_login) else {
        return Err("no automatic login is available for this cluster".into());
    };
    // We built this string ourselves from a fixed template, so a plain
    // shell split is safe here.
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    let program = parts.first().ok_or("empty login command")?.to_string();
    let rest: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();
    let cmd2 = cmd.clone();
    // the login CLI blocks while the browser flow runs; keep it off the
    // async runtime
    tokio::task::spawn_blocking(move || {
        let status = std::process::Command::new(&program)
            .args(&rest)
            .status()
            .map_err(|e| format!("could not run `{cmd2}`: {e}"))?;
        if !status.success() {
            return Err(format!("`{cmd2}` exited with {status}"));
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(err)??;
    Ok(())
}

fn shellexpand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return format!("{}/{rest}", home.to_string_lossy());
        }
    }
    p.to_string()
}

pub async fn connect(
    state: &AppState,
    context: String,
    path: Option<String>,
) -> Result<String, String> {
    if state.clients.read().await.contains_key(&context) {
        return Ok(context);
    }
    let opts = KubeConfigOptions {
        context: Some(context.clone()),
        ..Default::default()
    };
    let config = match path.filter(|p| !p.is_empty()) {
        Some(p) => {
            let kc = Kubeconfig::read_from(shellexpand_home(&p)).map_err(err)?;
            Config::from_custom_kubeconfig(kc, &opts).await.map_err(err)?
        }
        None => Config::from_kubeconfig(&opts).await.map_err(err)?,
    };
    let client = Client::try_from(config).map_err(err)?;
    // Fail fast with a readable message instead of on first resource click.
    client.apiserver_version().await.map_err(err)?;
    state.clients.write().await.insert(context.clone(), client);
    Ok(context)
}

pub async fn disconnect(state: &AppState, context: String) -> Result<(), String> {
    state.clients.write().await.remove(&context);
    Ok(())
}

async fn client(state: &AppState, context: &str) -> Result<Client, String> {
    state
        .clients
        .read()
        .await
        .get(context)
        .cloned()
        .ok_or_else(|| format!("not connected to context {context}"))
}

/// Aggregated discovery (apidiscovery.k8s.io/v2): the whole API surface
/// in one request. Classic discovery costs one round trip per group —
/// 73 on this cluster — which is most of the connect time.
async fn discover_aggregated(client: &Client) -> Result<Vec<ResourceType>, String> {
    const ACCEPT: &str =
        "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList";
    let mut out = Vec::new();
    for path in ["/api", "/apis"] {
        let req = http::Request::get(path)
            .header(http::header::ACCEPT, ACCEPT)
            .body(Vec::new())
            .map_err(err)?;
        let body: serde_json::Value = client.request(req).await.map_err(err)?;
        if body["kind"].as_str() != Some("APIGroupDiscoveryList") {
            return Err("server does not serve aggregated discovery".into());
        }
        for group in body["items"].as_array().into_iter().flatten() {
            let gname = group
                .pointer("/metadata/name")
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string();
            // the first version listed is the preferred one
            let Some(ver) = group["versions"].as_array().and_then(|v| v.first()) else {
                continue;
            };
            let version = ver["version"].as_str().unwrap_or_default().to_string();
            for r in ver["resources"].as_array().into_iter().flatten() {
                let verbs: Vec<&str> = r["verbs"]
                    .as_array()
                    .map(|v| v.iter().filter_map(|x| x.as_str()).collect())
                    .unwrap_or_default();
                if !verbs.contains(&"list") {
                    continue;
                }
                out.push(ResourceType {
                    group: gname.clone(),
                    version: version.clone(),
                    kind: r
                        .pointer("/responseKind/kind")
                        .and_then(|k| k.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    plural: r["resource"].as_str().unwrap_or_default().to_string(),
                    namespaced: r["scope"].as_str() == Some("Namespaced"),
                    deletable: verbs.contains(&"delete"),
                    editable: verbs.contains(&"patch") || verbs.contains(&"update"),
                });
            }
        }
    }
    if out.is_empty() {
        return Err("aggregated discovery returned nothing".into());
    }
    Ok(out)
}

/// Enumerate every listable resource type the API server knows about.
pub async fn discover(state: &AppState, context: String) -> Result<Vec<ResourceType>, String> {
    let client = client(state, &context).await?;
    // One request when the server supports it (1.30+), otherwise the
    // per-group walk.
    if let Ok(mut fast) = discover_aggregated(&client).await {
        fast.retain(|r| !r.kind.is_empty() && !r.plural.contains('/'));
        fast.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));
        fast.dedup_by(|a, b| a.group == b.group && a.kind == b.kind);
        return Ok(fast);
    }
    let discovery = Discovery::new(client).run().await.map_err(err)?;
    let mut out = Vec::new();
    for group in discovery.groups() {
        for (ar, caps) in group.recommended_resources() {
            if !caps.supports_operation(verbs::LIST) {
                continue;
            }
            out.push(ResourceType {
                group: ar.group.clone(),
                version: ar.version.clone(),
                kind: ar.kind.clone(),
                plural: ar.plural.clone(),
                namespaced: matches!(caps.scope, Scope::Namespaced),
                deletable: caps.supports_operation(verbs::DELETE),
                editable: caps.supports_operation(verbs::PATCH)
                    || caps.supports_operation(verbs::UPDATE),
            });
        }
    }
    out.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));
    Ok(out)
}

/// How many rows to pull per view. The cells-only projection is cheap
/// (2000 rows ≈ 0.7MB / 0.3s measured) and the table virtualizes, so it
/// can afford a big page; the metadata projection carries annotations
/// and costs 15MB at 1000 rows, so it stays small.
const PAGE_LIMIT_CELLS: u32 = 2000;
const PAGE_LIMIT_META: u32 = 500;

fn api_resource(rt: &ResourceType) -> KubeApiResource {
    KubeApiResource {
        group: rt.group.clone(),
        version: rt.version.clone(),
        api_version: if rt.group.is_empty() {
            rt.version.clone()
        } else {
            format!("{}/{}", rt.group, rt.version)
        },
        kind: rt.kind.clone(),
        plural: rt.plural.clone(),
    }
}

/// Append every key and scalar value in `v` to `out`, lowercased.
fn flatten_for_search(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, val) in m {
                if k == "managedFields" {
                    continue;
                }
                out.push_str(&k.to_lowercase());
                out.push(' ');
                flatten_for_search(val, out);
            }
        }
        serde_json::Value::Array(a) => {
            for val in a {
                flatten_for_search(val, out);
            }
        }
        serde_json::Value::String(s) => {
            out.push_str(&s.to_lowercase());
            out.push(' ');
        }
        serde_json::Value::Null => {}
        other => {
            out.push_str(&other.to_string());
            out.push(' ');
        }
    }
}

/// Percent-encode the characters a field selector can contain.
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn resource_url(rt: &ResourceType, namespace: Option<&str>) -> String {
    let prefix = if rt.group.is_empty() {
        format!("/api/{}", rt.version)
    } else {
        format!("/apis/{}/{}", rt.group, rt.version)
    };
    match (rt.namespaced, namespace) {
        (true, Some(ns)) => format!("{prefix}/namespaces/{ns}/{}", rt.plural),
        _ => format!("{prefix}/{}", rt.plural),
    }
}

fn dyn_api(client: Client, rt: &ResourceType, namespace: Option<&str>) -> Api<DynamicObject> {
    let ar = api_resource(rt);
    match (rt.namespaced, namespace.filter(|n| !n.is_empty())) {
        (true, Some(ns)) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    }
}

/// Addressing one object by name needs its namespace; without it the
/// request goes to the cluster-scoped path and 404s with a message
/// that says nothing useful.
fn require_namespace(rt: &ResourceType, namespace: &Option<String>) -> Result<(), String> {
    if rt.namespaced && namespace.as_deref().unwrap_or("").is_empty() {
        return Err(format!(
            "{} is namespaced — this row has no namespace, so it cannot be addressed",
            rt.kind
        ));
    }
    Ok(())
}

fn row_from_object(obj: &serde_json::Value, cells: Vec<serde_json::Value>) -> TableRow {
    // With includeObject=None the printer's first cell is the name.
    let fallback_name = cells
        .first()
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();
    TableRow {
        name: obj
            .pointer("/metadata/name")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or(fallback_name),
        namespace: obj
            .pointer("/metadata/namespace")
            .and_then(|v| v.as_str())
            .map(String::from),
        cells,
        labels: obj
            .pointer("/metadata/labels")
            .and_then(|l| serde_json::from_value(l.clone()).ok())
            .unwrap_or_default(),
        owner_kind: obj
            .pointer("/metadata/ownerReferences/0/kind")
            .and_then(|v| v.as_str())
            .map(String::from),
    }
}

/// Turn one Table page into rows. Pure CPU — callers run it on a
/// blocking worker so a 15MB page never stalls the async runtime.
fn rows_from_page(page: &serde_json::Value, ns: Option<&str>) -> Vec<TableRow> {
    page["rows"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|r| {
                    let mut row = row_from_object(
                        &r["object"],
                        r["cells"].as_array().cloned().unwrap_or_default(),
                    );
                    if row.namespace.is_none() {
                        row.namespace = ns.map(String::from);
                    }
                    row
                })
                .collect()
        })
        .unwrap_or_default()
}

fn continue_token(page: &serde_json::Value) -> Option<String> {
    page.pointer("/metadata/continue")
        .and_then(|c| c.as_str())
        .filter(|c| !c.is_empty())
        .map(String::from)
}

fn row_key(row: &TableRow) -> String {
    format!("{}/{}", row.namespace.as_deref().unwrap_or(""), row.name)
}

/// Instantly searchable subset while the full objects stream in behind:
/// name, namespace, labels and the printed cells.
fn basic_blob(row: &TableRow) -> String {
    let mut s = String::new();
    s.push_str(&row.name.to_lowercase());
    s.push(' ');
    if let Some(ns) = &row.namespace {
        s.push_str(&ns.to_lowercase());
        s.push(' ');
    }
    for (k, v) in &row.labels {
        s.push_str(&k.to_lowercase());
        s.push('=');
        s.push_str(&v.to_lowercase());
        s.push(' ');
    }
    for c in &row.cells {
        match c {
            serde_json::Value::String(v) => {
                s.push_str(&v.to_lowercase());
                s.push(' ');
            }
            serde_json::Value::Null => {}
            other => {
                s.push_str(&other.to_string());
                s.push(' ');
            }
        }
    }
    s
}

fn rough_age(created: Option<&str>) -> String {
    let Some(ts) = created.and_then(|c| chrono_parse(c)) else {
        return "-".into();
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let s = (now - ts).max(0);
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m", s / 60),
        3600..=86399 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86400),
    }
}

/// RFC3339 → unix seconds without pulling chrono in directly.
fn chrono_parse(s: &str) -> Option<i64> {
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    serde_json::from_value::<Time>(serde_json::Value::String(s.to_string()))
        .ok()
        .map(|t| t.0.timestamp())
}

async fn fetch_table(
    client: &Client,
    rt: &ResourceType,
    namespace: Option<&str>,
    include_object: &str,
    field_selector: Option<&str>,
) -> Result<serde_json::Value, String> {
    fetch_table_page(client, rt, namespace, include_object, field_selector, None).await
}

async fn fetch_table_page(
    client: &Client,
    rt: &ResourceType,
    namespace: Option<&str>,
    include_object: &str,
    field_selector: Option<&str>,
    continue_token: Option<&str>,
) -> Result<serde_json::Value, String> {
    let limit = if include_object == "None" {
        PAGE_LIMIT_CELLS
    } else {
        PAGE_LIMIT_META
    };
    let mut url = format!(
        "{}?limit={}&includeObject={}",
        resource_url(rt, namespace),
        limit,
        include_object
    );
    if let Some(fs) = field_selector.filter(|f| !f.is_empty()) {
        url.push_str("&fieldSelector=");
        url.push_str(&urlencode(fs));
    }
    if let Some(tok) = continue_token.filter(|t| !t.is_empty()) {
        url.push_str("&continue=");
        url.push_str(&urlencode(tok));
    }
    let req = http::Request::get(&url)
        .header(
            http::header::ACCEPT,
            "application/json;as=Table;v=v1;g=meta.k8s.io, application/json",
        )
        .body(Vec::new())
        .map_err(err)?;
    client.request(req).await.map_err(err)
}

/// List through the server-side printer (Table API) — the same columns
/// kubectl renders, including CRD additionalPrinterColumns, with
/// zero client-side hardcoding.
///
/// Two-phase for speed (measured on a real cluster, 500 pods):
/// `includeObject=Object` is 18.6MB / ~0.5s just at the API server;
/// `includeObject=Metadata` is ~0.14s, and the slim rows the UI needs
/// are ~0.26MB. So the metadata pass renders immediately, and a
/// background task fetches the full objects to upgrade the search
/// index from name/labels/cells to every field value.
#[derive(Serialize)]
pub struct RowPage {
    pub generation: u64,
    pub rows: Vec<TableRow>,
    pub done: bool,
}

fn list_key(
    context: &str,
    rt: &ResourceType,
    namespace: Option<&str>,
    field_selector: Option<&str>,
) -> String {
    format!(
        "{context}|{}/{}|{}|{}",
        rt.group,
        rt.kind,
        namespace.unwrap_or(""),
        field_selector.unwrap_or("")
    )
}

/// Seed the search index straight from cached rows — name, namespace,
/// labels and printed cells are all we need for an instant filter; the
/// full-text pass still happens lazily on first search.
async fn seed_search_from_rows(
    state: &AppState,
    rows: &[TableRow],
    context: &str,
    rt: &ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
) -> u64 {
    let mut s = state.search.write().await;
    s.generation += 1;
    s.keys = rows.iter().map(row_key).collect();
    s.blobs = rows.iter().map(basic_blob).collect();
    s.pod_res.clear();
    s.indexed = false;
    s.source = Some((
        context.to_string(),
        rt.clone(),
        namespace,
        field_selector,
    ));
    s.generation
}

async fn cache_list(state: &AppState, key: String, entry: CachedList) {
    let mut c = state.lists.write().await;
    c.retain(|(k, _)| k != &key);
    c.push((key, entry));
    let over = c.len().saturating_sub(LIST_CACHE_MAX);
    if over > 0 {
        c.drain(0..over);
    }
}

/// Rows already seen for this view, if any.
pub async fn cached_list(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
) -> Result<Option<ResourceTable>, String> {
    let key = list_key(&context, &rt, namespace.as_deref(), field_selector.as_deref());
    let hit = {
        let c = state.lists.read().await;
        c.iter().find(|(k, _)| k == &key).map(|(_, v)| v.clone())
    };
    let Some(entry) = hit else {
        return Ok(None);
    };
    seed_search_from_rows(
        state,
        &entry.rows,
        &context,
        &rt,
        namespace.clone(),
        field_selector.clone(),
    )
    .await;
    Ok(Some(ResourceTable {
        columns: entry.columns,
        rows: entry.rows,
        truncated: false,
        resource_version: entry.resource_version,
        include: entry.include,
    }))
}

pub async fn list_resources(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
    channel: Channel<serde_json::Value>,
) -> Result<ResourceTable, String> {
    let client = client(state, &context).await?;
    // Measured on a 3.6k-pod cluster: cells-only is 167KB/0.16s while
    // Metadata is 6.8MB/1.1s. We only need the object when the view
    // shows data the printer doesn't carry: the namespace column for
    // all-namespace lists, or labels (node AZ).
    // The cells-only projection assumes the printer's first column is
    // the name. That holds everywhere except Event, whose table starts
    // with "Last Seen" — so it needs the object.
    let needs_object = (rt.namespaced && namespace.is_none())
        || rt.kind == "Node"
        || rt.kind == "Event";
    let include = if needs_object { "Metadata" } else { "None" };
    let mut field_selector = field_selector;
    let table = match fetch_table(
        &client,
        &rt,
        namespace.as_deref(),
        include,
        field_selector.as_deref(),
    )
    .await
    {
        Ok(t) => t,
        // Only a *rejected* selector may be dropped. Retrying on any
        // error would silently widen the query — the user would think
        // they were looking at one node's pods and act on all of them.
        Err(e) if field_selector.is_some() && e.contains("not a known field selector") => {
            field_selector = None;
            fetch_table(&client, &rt, namespace.as_deref(), include, None)
                .await
                .map_err(|e2| format!("{e2} (after field selector was rejected: {e})"))?
        }
        Err(e) => return Err(e),
    };

    let truncated = table
        .pointer("/metadata/continue")
        .and_then(|c| c.as_str())
        .is_some_and(|c| !c.is_empty());

    let is_table = table["kind"].as_str() == Some("Table");
    let (columns, rows): (Vec<ColumnDef>, Vec<TableRow>) =
        if is_table {
            let columns = table["columnDefinitions"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|c| ColumnDef {
                            name: c["name"].as_str().unwrap_or_default().to_string(),
                            priority: c["priority"].as_i64().unwrap_or(0),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let rows = table["rows"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|r| {
                            let mut row = row_from_object(
                                &r["object"],
                                r["cells"].as_array().cloned().unwrap_or_default(),
                            );
                            if row.namespace.is_none() {
                                row.namespace = namespace.clone();
                            }
                            row
                        })
                        .collect()
                })
                .unwrap_or_default();
            (columns, rows)
        } else {
            // Rare aggregated API server without Table support: plain list.
            let rows = table["items"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|o| {
                            let name = o
                                .pointer("/metadata/name")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let age = rough_age(
                                o.pointer("/metadata/creationTimestamp")
                                    .and_then(|v| v.as_str()),
                            );
                            row_from_object(o, vec![name.into(), age.into()])
                        })
                        .collect()
                })
                .unwrap_or_default();
            (
                vec![
                    ColumnDef { name: "Name".into(), priority: 0 },
                    ColumnDef { name: "Age".into(), priority: 0 },
                ],
                rows,
            )
        };

    // Seed the search index with what we already have, then upgrade it
    // in the background with the full objects. The plain-list fallback
    // already carries full objects, so it indexes in place instead.
    let blobs = if is_table {
        rows.iter().map(basic_blob).collect()
    } else {
        table["items"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|o| {
                        let mut blob = String::new();
                        flatten_for_search(o, &mut blob);
                        blob
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let generation = {
        let mut s = state.search.write().await;
        s.generation += 1;
        s.keys = rows.iter().map(row_key).collect();
        s.blobs = blobs;
        s.pod_res.clear();
        s.indexed = !is_table; // the plain-list fallback is already full
        s.source = Some((
            context.clone(),
            rt.clone(),
            namespace.clone(),
            field_selector.clone(),
        ));
        s.generation
    };
    // A big cluster does not fit in one page. Serve the first page
    // now and stream the rest: first paint stays ~0.3s while the list
    // (and therefore search) becomes complete a few seconds later.
    if truncated {
        let chan = channel;
        let client2 = client.clone();
        let rt2 = rt.clone();
        let ns2 = namespace.clone();
        let fs2 = field_selector.clone();
        let search = state.search.clone();
        let first_token = table
            .pointer("/metadata/continue")
            .and_then(|c| c.as_str())
            .map(String::from);
        tokio::spawn(async move {
            // `continue` paging is sequential by API contract — a page
            // token only exists once the previous page arrived. What
            // can overlap is the work: the next request goes out
            // immediately while the page in hand is parsed on a
            // worker thread.
            let spawn_fetch = |tok: String| {
                let (c, r, n, f) = (client2.clone(), rt2.clone(), ns2.clone(), fs2.clone());
                let inc = include.to_string();
                tokio::spawn(async move {
                    fetch_table_page(&c, &r, n.as_deref(), &inc, f.as_deref(), Some(&tok)).await
                })
            };
            let mut in_flight = first_token.map(spawn_fetch);
            let mut guard = 0;
            while let Some(handle) = in_flight.take() {
                guard += 1;
                if guard > 40 {
                    break; // hard stop: ~80k rows
                }
                let Ok(Ok(page)) = handle.await else {
                    break;
                };
                let token = continue_token(&page);
                // fire the next request before parsing this one
                in_flight = token.clone().map(&spawn_fetch);
                let ns_for_rows = ns2.clone();
                let Ok((mut rows, keys, blobs)) =
                    tokio::task::spawn_blocking(move || {
                        let rows = rows_from_page(&page, ns_for_rows.as_deref());
                        let keys: Vec<String> = rows.iter().map(row_key).collect();
                        let blobs: Vec<String> = rows.iter().map(basic_blob).collect();
                        (rows, keys, blobs)
                    })
                    .await
                else {
                    break;
                };
                {
                    let mut sc = search.write().await;
                    if sc.generation != generation {
                        return; // the user moved on
                    }
                    sc.keys.extend(keys);
                    sc.blobs.extend(blobs);
                    // new rows are not in the full-text index yet
                    sc.indexed = false;
                }
                let payload = serde_json::to_value(RowPage {
                    generation,
                    rows: std::mem::take(&mut rows),
                    done: token.is_none(),
                })
                .unwrap_or_default();
                if chan.send(payload).is_err() {
                    return;
                }
            }
        });
    }

    // Cache before the background warm-up moves `rt` into it.
    if !truncated {
        cache_list(
            state,
            list_key(&context, &rt, namespace.as_deref(), field_selector.as_deref()),
            CachedList {
                columns: columns.clone(),
                rows: rows.clone(),
                resource_version: table
                    .pointer("/metadata/resourceVersion")
                    .and_then(|r| r.as_str())
                    .map(String::from),
                include: include.to_string(),
            },
        )
        .await;
    }

    // Pods show live CPU/MEM, which needs requests/limits — that one
    // still warms in the background; everything else indexes lazily.
    if is_table && rt.group.is_empty() && rt.kind == "Pod" {
        let search = state.search.clone();
        let fs = field_selector.clone();
        let rt_bg = rt.clone();
        let ns_bg = namespace.clone();
        tokio::spawn(async move {
            let _ = build_index(
                &client,
                &rt_bg,
                ns_bg.as_deref(),
                fs.as_deref(),
                &search,
                generation,
            )
            .await;
        });
    }
    Ok(ResourceTable {
        columns,
        rows,
        truncated,
        resource_version: table
            .pointer("/metadata/resourceVersion")
            .and_then(|r| r.as_str())
            .map(String::from),
        include: include.to_string(),
    })
}

/// Watch one resource and stream only what changed.
///
/// The events come back in the same Table projection the list used, so
/// a changed row arrives already printed with the server's columns —
/// no second rendering path, and no re-listing on every change.
pub async fn watch_start(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
    resource_version: String,
    include: String,
    channel: Channel<serde_json::Value>,
) -> Result<u32, String> {
    let client = client(state, &context).await?;
    let mut url = format!(
        "{}?watch=1&includeObject={}&resourceVersion={}&timeoutSeconds=600&allowWatchBookmarks=true",
        resource_url(&rt, namespace.as_deref()),
        include,
        urlencode(&resource_version)
    );
    if let Some(fs) = field_selector.filter(|f| !f.is_empty()) {
        url.push_str("&fieldSelector=");
        url.push_str(&urlencode(&fs));
    }
    let req = http::Request::get(&url)
        .header(
            http::header::ACCEPT,
            "application/json;as=Table;v=v1;g=meta.k8s.io, application/json",
        )
        .body(Vec::new())
        .map_err(err)?;
    let stream = client.request_stream(req).await.map_err(err)?;

    let ns_for_rows = namespace.clone();
    let task = tokio::spawn(async move {
        // kube returns a futures AsyncBufRead, not a tokio one
        use futures::AsyncBufReadExt;
        use futures::StreamExt;
        let mut lines = Box::pin(stream).lines();
        while let Some(Ok(line)) = lines.next().await {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let kind = ev["type"].as_str().unwrap_or_default().to_string();
            if kind == "BOOKMARK" {
                continue;
            }
            if kind == "ERROR" {
                // usually 410 Gone: the version is too old to resume
                let _ = channel.send(serde_json::json!({ "type": "RESYNC" }));
                return;
            }
            let obj = &ev["object"];
            let rows: Vec<TableRow> = obj["rows"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|r| {
                            let mut row = row_from_object(
                                &r["object"],
                                r["cells"].as_array().cloned().unwrap_or_default(),
                            );
                            if row.namespace.is_none() {
                                row.namespace = ns_for_rows.clone();
                            }
                            row
                        })
                        .collect()
                })
                .unwrap_or_default();
            if rows.is_empty() {
                continue;
            }
            let payload = serde_json::json!({ "type": kind, "rows": rows });
            if channel.send(payload).is_err() {
                return;
            }
        }
        // the server closes a watch periodically; ask for a fresh one
        let _ = channel.send(serde_json::json!({ "type": "RESYNC" }));
    });

    let id = state
        .next_exec
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.watches.write().await.insert(id, task.abort_handle());
    Ok(id)
}

pub async fn watch_stop(state: &AppState, id: u32) -> Result<(), String> {
    if let Some(h) = state.watches.write().await.remove(&id) {
        h.abort();
    }
    Ok(())
}


/// Fetch full objects and upgrade the row blobs to a full-text index
/// (and, for pods, harvest requests/limits).
async fn build_index(
    client: &Client,
    rt: &ResourceType,
    namespace: Option<&str>,
    field_selector: Option<&str>,
    search: &std::sync::Arc<RwLock<SearchCache>>,
    generation: u64,
) -> Result<(), String> {
    let is_pod = rt.group.is_empty() && rt.kind == "Pod";
    let mut by_key: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut pod_res: std::collections::HashMap<String, PodRes> = std::collections::HashMap::new();
    // The object projection pages at PAGE_LIMIT_META while the table
    // holds up to PAGE_LIMIT_CELLS rows, so follow `continue` until
    // every listed row is covered — otherwise search silently misses
    // everything past the first page.
    let target = { search.read().await.keys.len() };
    let mut token: Option<String> = None;
    loop {
        let page = fetch_table_page(
            client,
            rt,
            namespace,
            "Object",
            field_selector,
            token.as_deref(),
        )
        .await?;
        // Flattening every field of a few thousand objects is the
        // heaviest CPU in the app: split the page across workers
        // instead of walking it on the runtime thread.
        let rows_json: Vec<serde_json::Value> =
            page["rows"].as_array().cloned().unwrap_or_default();
        let workers = std::thread::available_parallelism()
            .map(|n| n.get().min(8))
            .unwrap_or(4);
        let chunk = rows_json.len().div_ceil(workers).max(1);
        let mut tasks = Vec::new();
        for part in rows_json.chunks(chunk) {
            let part: Vec<serde_json::Value> = part.to_vec();
            tasks.push(tokio::task::spawn_blocking(move || {
                let mut out: Vec<(String, String, Option<PodRes>)> = Vec::with_capacity(part.len());
                for r in &part {
                    let obj = &r["object"];
                    let key = format!(
                        "{}/{}",
                        obj.pointer("/metadata/namespace")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                        obj.pointer("/metadata/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                    );
                    let res = if is_pod { Some(pod_resources(obj)) } else { None };
                    let mut blob = String::new();
                    flatten_for_search(obj, &mut blob);
                    out.push((key, blob, res));
                }
                out
            }));
        }
        for t in tasks {
            let Ok(part) = t.await else { continue };
            for (key, blob, res) in part {
                if let Some(r) = res {
                    pod_res.insert(key.clone(), r);
                }
                by_key.insert(key, blob);
            }
        }
        // stop when the cache is covered, the server is done, or the
        // generation moved on under us
        token = page
            .pointer("/metadata/continue")
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
            .map(String::from);
        if token.is_none()
            || by_key.len() >= target
            || search.read().await.generation != generation
        {
            break;
        }
    }

    let mut s = search.write().await;
    if s.generation != generation {
        return Ok(()); // user has moved on; drop the stale index
    }
    let keys = std::mem::take(&mut s.keys);
    for (i, key) in keys.iter().enumerate() {
        if let Some(blob) = by_key.remove(key) {
            s.blobs[i] = blob;
        }
    }
    s.keys = keys;
    if is_pod {
        s.pod_res = pod_res;
    }
    s.indexed = true;
    Ok(())
}

/// Build the full-text index for the current list if it isn't ready.
/// Called the first time the user searches, so a plain list never pays
/// for the 18MB full-object fetch.
pub async fn ensure_index(state: &AppState) -> Result<(), String> {
    let (source, generation, indexed) = {
        let s = state.search.read().await;
        (s.source.clone(), s.generation, s.indexed)
    };
    if indexed {
        return Ok(());
    }
    let Some((context, rt, namespace, fs)) = source else {
        return Ok(());
    };
    let client = client(state, &context).await?;
    build_index(
        &client,
        &rt,
        namespace.as_deref(),
        fs.as_deref(),
        &state.search,
        generation,
    )
    .await
}

pub async fn filter_rows(state: &AppState, query: String) -> Result<Vec<String>, String> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    let s = state.search.read().await;
    // Return the matched rows' keys (namespace/name), not positional
    // indices: the frontend list is reordered by the watch informer
    // independently of this cache, so an index would point at the wrong
    // row. A key stays correct no matter how the list is spliced.
    Ok(s.blobs
        .iter()
        .enumerate()
        .filter(|(_, b)| terms.iter().all(|t| b.contains(t.as_str())))
        .filter_map(|(i, _)| s.keys.get(i).cloned())
        .collect())
}

const SERVER_MANAGED_META: [&str; 7] = [
    "managedFields",
    "resourceVersion",
    "uid",
    "generation",
    "creationTimestamp",
    "selfLink",
    "ownerReferences",
];

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Detail pane payload: a light summary plus the desired manifest —
/// status and server-managed metadata stripped, i.e. what you would
/// hand back to `kubectl apply`.
pub async fn get_resource(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    name: String,
) -> Result<ResourceDetail, String> {
    require_namespace(&rt, &namespace)?;
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, namespace.as_deref());
    let obj = api.get(&name).await.map_err(err)?;
    let v = serde_json::to_value(&obj).map_err(err)?;

    let meta = v.get("metadata").cloned().unwrap_or_default();
    let mut annotations: std::collections::BTreeMap<String, String> = meta
        .get("annotations")
        .and_then(|a| serde_json::from_value(a.clone()).ok())
        .unwrap_or_default();
    annotations.remove(LAST_APPLIED);

    let mut manifest = v.clone();
    if let Some(o) = manifest.as_object_mut() {
        o.remove("status");
    }
    if let Some(m) = manifest.get_mut("metadata").and_then(|m| m.as_object_mut()) {
        for k in SERVER_MANAGED_META {
            m.remove(k);
        }
        if let Some(a) = m.get_mut("annotations").and_then(|a| a.as_object_mut()) {
            a.remove(LAST_APPLIED);
            if a.is_empty() {
                m.remove("annotations");
            }
        }
    }

    Ok(ResourceDetail {
        name: meta
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        namespace: meta
            .get("namespace")
            .and_then(|v| v.as_str())
            .map(String::from),
        created: meta
            .get("creationTimestamp")
            .and_then(|v| v.as_str())
            .map(String::from),
        labels: meta
            .get("labels")
            .and_then(|l| serde_json::from_value(l.clone()).ok())
            .unwrap_or_default(),
        annotations,
        status: v.get("status").cloned(),
        unschedulable: v.pointer("/spec/unschedulable").and_then(|b| b.as_bool()),
        node_name: v
            .pointer("/spec/nodeName")
            .and_then(|n| n.as_str())
            .map(String::from),
        involved: v.get("involvedObject").and_then(|io| {
            let kind = io.get("kind")?.as_str()?.to_string();
            let name = io.get("name")?.as_str()?.to_string();
            Some(InvolvedRef {
                kind,
                name,
                namespace: io.get("namespace").and_then(|n| n.as_str()).map(String::from),
            })
        }),
        resource_version: meta
            .get("resourceVersion")
            .and_then(|r| r.as_str())
            .map(String::from),
        containers: v
            .pointer("/spec/containers")
            .and_then(|c| c.as_array())
            .map(|cs| {
                cs.iter()
                    .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        replicas: v.pointer("/spec/replicas").and_then(|r| r.as_i64()),
        ready_replicas: v
            .pointer("/status/readyReplicas")
            .or_else(|| v.pointer("/status/availableReplicas"))
            .or_else(|| v.pointer("/status/numberReady"))
            .and_then(|r| r.as_i64()),
        links: related_links(&v, &rt.kind),
        has_pod_selector: v.pointer("/spec/selector").is_some()
            && rt.kind != "PersistentVolumeClaim",
        ports: v
            .pointer("/spec/containers")
            .and_then(|c| c.as_array())
            .map(|cs| {
                cs.iter()
                    .flat_map(|c| {
                        c.pointer("/ports")
                            .and_then(|p| p.as_array())
                            .into_iter()
                            .flatten()
                            .filter_map(|p| {
                                p.pointer("/containerPort")
                                    .and_then(|n| n.as_u64())
                                    .map(|n| n as u16)
                            })
                            .collect::<Vec<_>>()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        yaml: serde_yaml::to_string(&manifest).map_err(err)?,
    })
}

/// Objects this one points at: owners first, then kind-specific
/// references (a PVC's volume, an ingress backend, an HPA target…).
/// Everything is read out of the manifest — no hardcoded topology.
fn related_links(v: &serde_json::Value, kind: &str) -> Vec<InvolvedRef> {
    let ns = v
        .pointer("/metadata/namespace")
        .and_then(|n| n.as_str())
        .map(String::from);
    let mut out: Vec<InvolvedRef> = Vec::new();
    let mut push = |k: Option<&str>, n: Option<&str>, namespace: Option<String>| {
        if let (Some(k), Some(n)) = (k, n) {
            if !k.is_empty() && !n.is_empty() {
                out.push(InvolvedRef {
                    kind: k.to_string(),
                    name: n.to_string(),
                    namespace,
                });
            }
        }
    };

    for o in v
        .pointer("/metadata/ownerReferences")
        .and_then(|o| o.as_array())
        .into_iter()
        .flatten()
    {
        push(
            o.get("kind").and_then(|k| k.as_str()),
            o.get("name").and_then(|n| n.as_str()),
            ns.clone(),
        );
    }

    match kind {
        "Pod" => {
            push(
                Some("Node"),
                v.pointer("/spec/nodeName").and_then(|n| n.as_str()),
                None,
            );
            push(
                Some("ServiceAccount"),
                v.pointer("/spec/serviceAccountName").and_then(|n| n.as_str()),
                ns.clone(),
            );
            for vol in v
                .pointer("/spec/volumes")
                .and_then(|x| x.as_array())
                .into_iter()
                .flatten()
            {
                push(
                    Some("PersistentVolumeClaim"),
                    vol.pointer("/persistentVolumeClaim/claimName")
                        .and_then(|n| n.as_str()),
                    ns.clone(),
                );
            }
        }
        "PersistentVolumeClaim" => push(
            Some("PersistentVolume"),
            v.pointer("/spec/volumeName").and_then(|n| n.as_str()),
            None,
        ),
        "PersistentVolume" => push(
            Some("PersistentVolumeClaim"),
            v.pointer("/spec/claimRef/name").and_then(|n| n.as_str()),
            v.pointer("/spec/claimRef/namespace")
                .and_then(|n| n.as_str())
                .map(String::from),
        ),
        "Ingress" => {
            for rule in v
                .pointer("/spec/rules")
                .and_then(|r| r.as_array())
                .into_iter()
                .flatten()
            {
                for path in rule
                    .pointer("/http/paths")
                    .and_then(|p| p.as_array())
                    .into_iter()
                    .flatten()
                {
                    push(
                        Some("Service"),
                        path.pointer("/backend/service/name")
                            .and_then(|n| n.as_str()),
                        ns.clone(),
                    );
                }
            }
        }
        "HorizontalPodAutoscaler" => push(
            v.pointer("/spec/scaleTargetRef/kind").and_then(|k| k.as_str()),
            v.pointer("/spec/scaleTargetRef/name").and_then(|n| n.as_str()),
            ns.clone(),
        ),
        "EndpointSlice" => push(
            Some("Service"),
            v.pointer("/metadata/labels/kubernetes.io~1service-name")
                .and_then(|n| n.as_str()),
            ns.clone(),
        ),
        _ => {}
    }

    // de-duplicate while keeping order
    let mut seen = std::collections::HashSet::new();
    out.retain(|l| seen.insert((l.kind.clone(), l.name.clone())));
    out
}

/// Server-side apply of an edited manifest.
///
/// Force is *not* the default: taking ownership of fields another
/// controller manages (an HPA's `replicas`, say) should be a decision
/// the user makes after seeing the conflict, not a side effect of
/// saving. `resource_version` is sent as a precondition so an editor
/// left open cannot overwrite a newer change.
pub async fn apply_resource(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    name: String,
    yaml: String,
    resource_version: Option<String>,
    force: bool,
) -> Result<(), String> {
    require_namespace(&rt, &namespace)?;
    let mut value: serde_json::Value = serde_yaml::from_str(&yaml).map_err(err)?;
    if let Some(rv) = resource_version.filter(|r| !r.is_empty()) {
        if let Some(m) = value.get_mut("metadata").and_then(|m| m.as_object_mut()) {
            m.insert("resourceVersion".into(), rv.into());
        }
    }
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, namespace.as_deref());
    let mut pp = PatchParams::apply("pigeoneye");
    if force {
        pp = pp.force();
    }
    api.patch(&name, &pp, &Patch::Apply(&value))
        .await
        .map_err(err)?;
    Ok(())
}

/// Create a brand-new object from a manifest (the "New" flow). A plain
/// POST, so the API server rejects it if the name is already taken —
/// exactly what you want for create, versus apply's upsert. Returns the
/// created object's name for the success message.
pub async fn create_resource(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    yaml: String,
) -> Result<String, String> {
    let value: serde_json::Value = serde_yaml::from_str(&yaml)
        .map_err(|e| format!("The manifest isn't valid YAML: {e}"))?;
    // The manifest's own namespace wins; fall back to the picker's.
    let ns = value
        .pointer("/metadata/namespace")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(namespace)
        .filter(|n| !n.is_empty());
    require_namespace(&rt, &ns)?;
    let name = value
        .pointer("/metadata/name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return Err("metadata.name is required — fill it in before creating.".into());
    }
    let obj: DynamicObject = serde_json::from_value(value)
        .map_err(|e| format!("The manifest isn't a valid object: {e}"))?;
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, ns.as_deref());
    api.create(&PostParams::default(), &obj).await.map_err(err)?;
    Ok(name)
}

/// Namespace names only. Fetching the objects costs 2.4MB on a cluster
/// with ~950 namespaces; the printer's cells are 117KB.
pub async fn list_namespaces(state: &AppState, context: String) -> Result<Vec<String>, String> {
    let client = client(state, &context).await?;
    let req = http::Request::get("/api/v1/namespaces?includeObject=None")
        .header(
            http::header::ACCEPT,
            "application/json;as=Table;v=v1;g=meta.k8s.io, application/json",
        )
        .body(Vec::new())
        .map_err(err)?;
    let body: serde_json::Value = client.request(req).await.map_err(err)?;
    if body["kind"].as_str() == Some("Table") {
        return Ok(body["rows"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| r["cells"][0].as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default());
    }
    Ok(body["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|o| {
                    o.pointer("/metadata/name").and_then(|n| n.as_str()).map(String::from)
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Kubernetes quantity → millicores ("250m" → 250, "1" → 1000,
/// "12345678n" → 12).
fn parse_cpu(s: &str) -> i64 {
    if s.is_empty() {
        return 0;
    }
    if let Some(n) = s.strip_suffix('n') {
        return n.parse::<i64>().unwrap_or(0) / 1_000_000;
    }
    if let Some(u) = s.strip_suffix('u') {
        return u.parse::<i64>().unwrap_or(0) / 1_000;
    }
    if let Some(m) = s.strip_suffix('m') {
        return m.parse::<i64>().unwrap_or(0);
    }
    (s.parse::<f64>().unwrap_or(0.0) * 1000.0) as i64
}

/// Kubernetes quantity → bytes ("128Mi", "1Gi", "500M", plain bytes).
fn parse_mem(s: &str) -> i64 {
    const UNITS: [(&str, f64); 11] = [
        ("Ki", 1024.0),
        ("Mi", 1_048_576.0),
        ("Gi", 1_073_741_824.0),
        ("Ti", 1_099_511_627_776.0),
        ("Pi", 1_125_899_906_842_624.0),
        ("k", 1e3),
        ("K", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("m", 1e-3),
    ];
    for (suffix, mul) in UNITS {
        if let Some(v) = s.strip_suffix(suffix) {
            return (v.parse::<f64>().unwrap_or(0.0) * mul) as i64;
        }
    }
    s.parse::<f64>().unwrap_or(0.0) as i64
}

fn pod_resources(obj: &serde_json::Value) -> PodRes {
    let mut r = PodRes::default();
    for c in obj
        .pointer("/spec/containers")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let q = |path: &str| c.pointer(path).and_then(|x| x.as_str()).unwrap_or("");
        r.cpu_r += parse_cpu(q("/resources/requests/cpu"));
        r.cpu_l += parse_cpu(q("/resources/limits/cpu"));
        r.mem_r += parse_mem(q("/resources/requests/memory"));
        r.mem_l += parse_mem(q("/resources/limits/memory"));
    }
    r
}

#[derive(Serialize, Clone)]
pub struct InvolvedRef {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
}

#[derive(Serialize)]
pub struct EventInfo {
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
    pub last: Option<String>,
    pub source: String,
}

/// Events the API server has recorded against one object — the tail of
/// `kubectl describe`, which is usually why you opened the detail.
pub async fn get_events(
    state: &AppState,
    context: String,
    namespace: Option<String>,
    name: String,
    kind: String,
) -> Result<Vec<EventInfo>, String> {
    let client = client(state, &context).await?;
    let ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("", "v1", "Event"));
    let api: Api<DynamicObject> = match namespace.as_deref() {
        Some(ns) if !ns.is_empty() => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    };
    let selector = format!("involvedObject.name={name},involvedObject.kind={kind}");
    let list = api
        .list(&ListParams::default().fields(&selector).limit(100))
        .await
        .map_err(err)?;
    let mut out: Vec<EventInfo> = list
        .items
        .iter()
        .map(|o| {
            let v = serde_json::to_value(o).unwrap_or_default();
            let last = v["lastTimestamp"]
                .as_str()
                .or_else(|| v["eventTime"].as_str())
                .or_else(|| v.pointer("/metadata/creationTimestamp").and_then(|t| t.as_str()))
                .map(String::from);
            EventInfo {
                type_: v["type"].as_str().unwrap_or("Normal").to_string(),
                reason: v["reason"].as_str().unwrap_or_default().to_string(),
                message: v["message"].as_str().unwrap_or_default().to_string(),
                count: v["count"].as_i64().unwrap_or(1),
                last,
                source: v
                    .pointer("/source/component")
                    .and_then(|c| c.as_str())
                    .or_else(|| v.pointer("/reportingComponent").and_then(|c| c.as_str()))
                    .unwrap_or_default()
                    .to_string(),
            }
        })
        .collect();
    // newest first
    out.sort_by(|a, b| b.last.cmp(&a.last));
    Ok(out)
}

#[derive(Serialize)]
pub struct PodStat {
    pub key: String,
    pub cpu: i64,
    pub mem: i64,
    pub cpu_r: i64,
    pub cpu_l: i64,
    pub mem_r: i64,
    pub mem_l: i64,
}

/// Live usage from metrics.k8s.io joined with the requests/limits the
/// background indexer collected — feeds the live CPU / %CPU/R /
/// %CPU/L / MEM / %MEM/R / %MEM/L pod columns.
pub async fn pod_stats(
    state: &AppState,
    context: String,
    namespace: Option<String>,
) -> Result<Vec<PodStat>, String> {
    let client = client(state, &context).await?;
    let ar = KubeApiResource {
        group: "metrics.k8s.io".into(),
        version: "v1beta1".into(),
        api_version: "metrics.k8s.io/v1beta1".into(),
        kind: "PodMetrics".into(),
        plural: "pods".into(),
    };
    let api: Api<DynamicObject> = match namespace.filter(|n| !n.is_empty()) {
        Some(ns) => Api::namespaced_with(client, &ns, &ar),
        None => Api::all_with(client, &ar),
    };
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("metrics API unavailable: {e}"))?;
    let res_map = state.search.read().await.pod_res.clone();
    Ok(list
        .items
        .iter()
        .map(|m| {
            let key = format!(
                "{}/{}",
                m.metadata.namespace.clone().unwrap_or_default(),
                m.metadata.name.clone().unwrap_or_default()
            );
            let v = serde_json::to_value(m).unwrap_or_default();
            let (mut cpu, mut mem) = (0i64, 0i64);
            for c in v["containers"].as_array().into_iter().flatten() {
                cpu += parse_cpu(c.pointer("/usage/cpu").and_then(|x| x.as_str()).unwrap_or(""));
                mem += parse_mem(
                    c.pointer("/usage/memory").and_then(|x| x.as_str()).unwrap_or(""),
                );
            }
            let r = res_map.get(&key).copied().unwrap_or_default();
            PodStat {
                key,
                cpu,
                mem,
                cpu_r: r.cpu_r,
                cpu_l: r.cpu_l,
                mem_r: r.mem_r,
                mem_l: r.mem_l,
            }
        })
        .collect())
}

pub async fn delete_resource(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    name: String,
    force: bool,
) -> Result<(), String> {
    require_namespace(&rt, &namespace)?;
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, namespace.as_deref());
    let mut dp = DeleteParams::default();
    if force {
        dp = dp.grace_period(0);
    }
    api.delete(&name, &dp).await.map_err(err)?;
    Ok(())
}

pub async fn cordon_node(
    state: &AppState,
    context: String,
    name: String,
    on: bool,
) -> Result<(), String> {
    let client = client(state, &context).await?;
    let ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("", "v1", "Node"));
    let api: Api<DynamicObject> = Api::all_with(client, &ar);
    let patch = serde_json::json!({ "spec": { "unschedulable": on } });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(err)?;
    Ok(())
}

/// Cordon, then evict every pod on the node except DaemonSet-owned and
/// mirror pods — the same rules `kubectl drain
/// --ignore-daemonsets --delete-emptydir-data` applies. Evictions
/// respect PodDisruptionBudgets; blocked ones are reported, not forced.
pub async fn drain_node(
    state: &AppState,
    context: String,
    name: String,
) -> Result<String, String> {
    cordon_node(state, context.clone(), name.clone(), true).await?;
    let client = client(state, &context).await?;
    let pods: Api<K8sPod> = Api::all(client.clone());
    let lp = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let list = pods.list(&lp).await.map_err(err)?;
    let (mut evicted, mut skipped, mut failed) = (0u32, 0u32, 0u32);
    let mut failures: Vec<String> = Vec::new();
    for p in list.items {
        let meta = &p.metadata;
        let pname = meta.name.clone().unwrap_or_default();
        let pns = meta.namespace.clone().unwrap_or_default();
        let daemonset = meta
            .owner_references
            .as_ref()
            .is_some_and(|os| os.iter().any(|o| o.kind == "DaemonSet"));
        let mirror = meta
            .annotations
            .as_ref()
            .is_some_and(|a| a.contains_key("kubernetes.io/config.mirror"));
        if daemonset || mirror {
            skipped += 1;
            continue;
        }
        let papi: Api<K8sPod> = Api::namespaced(client.clone(), &pns);
        match papi.evict(&pname, &EvictParams::default()).await {
            Ok(_) => evicted += 1,
            Err(e) => {
                failed += 1;
                if failures.len() < 3 {
                    failures.push(format!("{pns}/{pname}: {e}"));
                }
            }
        }
    }
    let msg = format!("cordoned; evicted {evicted}, skipped {skipped} (daemonset/mirror)");
    if failed > 0 {
        // usually a PodDisruptionBudget refusing the eviction — the
        // node is only half drained, so this is not a success
        return Err(format!(
            "{msg}; {failed} eviction(s) refused — {} (retry drain once the budget allows)",
            failures.join("; ")
        ));
    }
    Ok(msg)
}

pub async fn scale_resource(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    name: String,
    replicas: i64,
) -> Result<(), String> {
    require_namespace(&rt, &namespace)?;
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, namespace.as_deref());
    let patch = serde_json::json!({ "spec": { "replicas": replicas } });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(err)?;
    Ok(())
}

/// Same mechanism as `kubectl rollout restart`: bump the pod template's
/// restartedAt annotation and let the controller roll.
pub async fn restart_rollout(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    name: String,
) -> Result<(), String> {
    require_namespace(&rt, &namespace)?;
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, namespace.as_deref());
    let now = k8s_openapi::chrono::Utc::now().to_rfc3339();
    let patch = serde_json::json!({
        "spec": { "template": { "metadata": { "annotations": {
            "kubectl.kubernetes.io/restartedAt": now
        }}}}
    });
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(err)?;
    Ok(())
}

// ── shells ──────────────────────────────────────────────────────────

/// Wire an attached TTY to the webview: stdout bytes stream out over a
/// Tauri channel, stdin/resize come back in via exec_stdin/exec_resize.
async fn start_exec_session(
    state: &AppState,
    client: Client,
    namespace: &str,
    pod: &str,
    container: Option<String>,
    command: Vec<String>,
    channel: Channel<String>,
    cleanup: Option<(String, String, String)>,
) -> Result<u32, String> {
    let pods: Api<K8sPod> = Api::namespaced(client, namespace);
    let mut ap = AttachParams::interactive_tty();
    if let Some(c) = container {
        ap = ap.container(c);
    }
    let mut attached = pods.exec(pod, command, &ap).await.map_err(err)?;
    let mut stdout = attached.stdout().ok_or("no stdout stream")?;
    let mut stdin_w = attached.stdin().ok_or("no stdin stream")?;
    let resize = attached.terminal_size();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let writer = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(b) = rx.recv().await {
            if stdin_w.write_all(&b).await.is_err() {
                break;
            }
            let _ = stdin_w.flush().await;
        }
    });
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 8192];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = channel.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                }
            }
        }
        let _ = channel.send("\r\n\u{1b}[90m[session closed]\u{1b}[0m\r\n".into());
        // Out-of-band exit marker so the UI can flag the tab as dead.
        let _ = channel.send("\u{0}exit".into());
    });

    let id = state
        .next_exec
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.exec.write().await.insert(
        id,
        ExecSession {
            stdin: Some(tx),
            resize,
            aborts: vec![writer.abort_handle(), reader.abort_handle()],
            cleanup,
        },
    );
    Ok(id)
}

const SHELL_CMD: &str = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";

pub async fn exec_start(
    state: &AppState,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Option<String>,
    channel: Channel<String>,
) -> Result<u32, String> {
    if namespace.is_empty() {
        return Err("exec needs a namespace".into());
    }
    let client = client(state, &context).await?;
    let cmd = command
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| SHELL_CMD.to_string());
    // A multi-container pod rejects exec without a container name
    // ("400 Bad Request" on the upgrade), so resolve it the way
    // kubectl does: the default-container annotation, else the first.
    let container = match container {
        Some(c) if !c.is_empty() => Some(c),
        _ => {
            let pods: Api<K8sPod> = Api::namespaced(client.clone(), &namespace);
            let p = pods.get(&pod).await.map_err(err)?;
            let annotated = p
                .metadata
                .annotations
                .as_ref()
                .and_then(|a| a.get("kubectl.kubernetes.io/default-container").cloned());
            let names: Vec<String> = p
                .spec
                .as_ref()
                .map(|sp| sp.containers.iter().map(|c| c.name.clone()).collect())
                .unwrap_or_default();
            annotated
                .filter(|c| names.contains(c))
                .or_else(|| if names.len() > 1 { names.first().cloned() } else { None })
        }
    };
    start_exec_session(
        state,
        client,
        &namespace,
        &pod,
        container,
        vec!["/bin/sh".into(), "-c".into(), cmd],
        channel,
        None,
    )
    .await
}

/// Follow a pod's logs into the same session plumbing the shells use —
/// read-only (no stdin), \n normalized to \r\n for xterm.
pub async fn log_start(
    state: &AppState,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    tail: Option<i64>,
    channel: Channel<String>,
) -> Result<u32, String> {
    if namespace.is_empty() {
        return Err("pod logs need a namespace".into());
    }
    let client = client(state, &context).await?;
    let pods: Api<K8sPod> = Api::namespaced(client, &namespace);
    // Multi-container pods need an explicit container; fall back to
    // the first one when the caller didn't pick.
    let container = match container.filter(|c| !c.is_empty()) {
        Some(c) => Some(c),
        None => {
            let p = pods.get(&pod).await.map_err(err)?;
            p.spec.and_then(|sp| {
                if sp.containers.len() > 1 {
                    sp.containers.first().map(|c| c.name.clone())
                } else {
                    None
                }
            })
        }
    };
    let lp = kube::api::LogParams {
        follow: true,
        tail_lines: Some(tail.unwrap_or(500)),
        container,
        ..Default::default()
    };
    let stream = pods.log_stream(&pod, &lp).await.map_err(err)?;
    let reader = tokio::spawn(async move {
        use futures::AsyncReadExt;
        let mut stream = Box::pin(stream);
        let mut buf = [0u8; 8192];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).replace('\n', "\r\n");
                    let _ = channel.send(text);
                }
            }
        }
        let _ = channel.send("\r\n\u{1b}[90m[log stream closed]\u{1b}[0m\r\n".into());
        let _ = channel.send("\u{0}exit".into());
    });
    let id = state
        .next_exec
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.exec.write().await.insert(
        id,
        ExecSession {
            stdin: None,
            resize: None,
            aborts: vec![reader.abort_handle()],
            cleanup: None,
        },
    );
    Ok(id)
}

const LOG_COLORS: [&str; 8] = ["36", "33", "35", "32", "34", "95", "96", "93"];

/// Aggregate logs of every pod a workload selects (Deployment,
/// StatefulSet, DaemonSet, ReplicaSet, Job, Service) into one stream,
/// each line prefixed with a color-coded pod name.
pub async fn logs_selector_start(
    state: &AppState,
    context: String,
    resource: ResourceType,
    namespace: String,
    name: String,
    channel: Channel<String>,
) -> Result<u32, String> {
    require_namespace(&resource, &Some(namespace.clone()))?;
    let client = client(state, &context).await?;
    let api = dyn_api(client.clone(), &resource, Some(&namespace));
    let obj = api.get(&name).await.map_err(err)?;
    let v = serde_json::to_value(&obj).map_err(err)?;
    let mut parts: Vec<String> = Vec::new();
    // Services carry a plain label map; workloads use matchLabels and
    // may add matchExpressions. Ignoring the latter would stream logs
    // from pods the workload does not own.
    let label_map = v
        .pointer("/spec/selector/matchLabels")
        .or_else(|| v.pointer("/spec/selector"))
        .and_then(|m| m.as_object());
    if let Some(m) = label_map {
        for (k, val) in m {
            if let Some(sv) = val.as_str() {
                parts.push(format!("{k}={sv}"));
            }
        }
    }
    for expr in v
        .pointer("/spec/selector/matchExpressions")
        .and_then(|e| e.as_array())
        .into_iter()
        .flatten()
    {
        let key = expr["key"].as_str().unwrap_or_default();
        let op = expr["operator"].as_str().unwrap_or_default();
        let vals: Vec<&str> = expr["values"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        match op {
            "In" if !vals.is_empty() => parts.push(format!("{key} in ({})", vals.join(","))),
            "NotIn" if !vals.is_empty() => {
                parts.push(format!("{key} notin ({})", vals.join(",")))
            }
            "Exists" => parts.push(key.to_string()),
            "DoesNotExist" => parts.push(format!("!{key}")),
            _ => {}
        }
    }
    let selector = parts.join(",");
    if selector.is_empty() {
        return Err("resource has no usable pod selector".into());
    }

    let pods: Api<K8sPod> = Api::namespaced(client, &namespace);
    let list = pods
        .list(&ListParams::default().labels(&selector))
        .await
        .map_err(err)?;
    if list.items.is_empty() {
        return Err(format!("no pods match selector {selector}"));
    }

    let mut aborts = Vec::new();
    let mut handles = Vec::new();
    for (i, p) in list.items.iter().enumerate() {
        let pod_name = p.metadata.name.clone().unwrap_or_default();
        let multi = p
            .spec
            .as_ref()
            .is_some_and(|s| s.containers.len() > 1)
            .then(|| p.spec.as_ref().unwrap().containers[0].name.clone());
        let lp = kube::api::LogParams {
            follow: true,
            tail_lines: Some(100),
            container: multi,
            ..Default::default()
        };
        let color = LOG_COLORS[i % LOG_COLORS.len()];
        let prefix = format!("\u{1b}[{color}m[{pod_name}]\u{1b}[0m ");
        let pods = pods.clone();
        let channel = channel.clone();
        let handle = tokio::spawn(async move {
            let Ok(stream) = pods.log_stream(&pod_name, &lp).await else {
                let _ = channel.send(format!("{prefix}\u{1b}[31m<log stream failed>\u{1b}[0m\r\n"));
                return;
            };
            use futures::AsyncReadExt;
            let mut stream = Box::pin(stream);
            let mut buf = [0u8; 8192];
            let mut acc = String::new();
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                        while let Some(pos) = acc.find('\n') {
                            let line: String = acc.drain(..=pos).collect();
                            let _ = channel.send(format!(
                                "{prefix}{}\r\n",
                                line.trim_end_matches(['\n', '\r'])
                            ));
                        }
                    }
                }
            }
            if !acc.is_empty() {
                let _ = channel.send(format!("{prefix}{acc}\r\n"));
            }
        });
        aborts.push(handle.abort_handle());
        handles.push(handle);
    }
    // When every stream ends, flag the tab as done.
    let done_channel = channel.clone();
    let watcher = tokio::spawn(async move {
        for h in handles {
            let _ = h.await;
        }
        let _ = done_channel.send("\r\n\u{1b}[90m[log streams closed]\u{1b}[0m\r\n".into());
        let _ = done_channel.send("\u{0}exit".into());
    });
    aborts.push(watcher.abort_handle());

    let id = state
        .next_exec
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.exec.write().await.insert(
        id,
        ExecSession {
            stdin: None,
            resize: None,
            aborts,
            cleanup: None,
        },
    );
    Ok(id)
}

/// Open a local listener that tunnels every connection to a pod port —
/// what `kubectl port-forward` does, one forward stream per connection.
pub async fn pf_start(
    state: &AppState,
    context: String,
    namespace: String,
    pod: String,
    port: u16,
) -> Result<PfInfo, String> {
    if namespace.is_empty() {
        return Err("port-forward needs a namespace".into());
    }
    if port == 0 {
        return Err("pick a container port to forward".into());
    }
    let client = client(state, &context).await?;
    let pods: Api<K8sPod> = Api::namespaced(client, &namespace);
    // Fail fast (pod missing, port refused) before claiming a local port.
    drop(pods.portforward(&pod, &[port]).await.map_err(err)?);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(err)?;
    let local = listener.local_addr().map_err(err)?.port();
    let id = state
        .next_exec
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let pods2 = pods.clone();
    let podname = pod.clone();
    let conns: std::sync::Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let conns2 = conns.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let pods = pods2.clone();
            let pod = podname.clone();
            let h = tokio::spawn(async move {
                if let Ok(mut pf) = pods.portforward(&pod, &[port]).await {
                    if let Some(mut upstream) = pf.take_stream(port) {
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
                    }
                }
            });
            if let Ok(mut v) = conns2.lock() {
                v.retain(|a| !a.is_finished());
                v.push(h.abort_handle());
            }
        }
    });
    let info = PfInfo {
        id,
        context,
        namespace,
        pod,
        remote: port,
        local,
    };
    state.forwards.write().await.insert(
        id,
        PfSession {
            abort: task.abort_handle(),
            conns,
            info: info.clone(),
        },
    );
    Ok(info)
}

pub async fn pf_list(state: &AppState) -> Result<Vec<PfInfo>, String> {
    let mut out: Vec<PfInfo> = state
        .forwards
        .read()
        .await
        .values()
        .map(|s| s.info.clone())
        .collect();
    out.sort_by_key(|i| i.id);
    Ok(out)
}

pub async fn pf_stop(state: &AppState, id: u32) -> Result<(), String> {
    if let Some(s) = state.forwards.write().await.remove(&id) {
        s.abort.abort();
        if let Ok(v) = s.conns.lock() {
            for h in v.iter() {
                h.abort();
            }
        }
    }
    Ok(())
}

/// Node shell via a privileged hostPID helper pod
/// pinned to the node, then nsenter into the host's namespaces. The
/// helper pod is deleted when the session closes. Image, namespace and
/// resource limits are user-configurable.
pub async fn node_shell_start(
    state: &AppState,
    context: String,
    node: String,
    image: Option<String>,
    shell_namespace: Option<String>,
    cpu_limit: Option<String>,
    memory_limit: Option<String>,
    channel: Channel<String>,
) -> Result<u32, String> {
    let client = client(state, &context).await?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!("pigeoneye-node-shell-{:x}", nanos & 0xffff_ffff);
    let image = image
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "busybox:1.36".to_string());
    let ns = shell_namespace
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "kube-system".to_string());
    let mut limits = serde_json::Map::new();
    if let Some(cpu) = cpu_limit.filter(|s| !s.trim().is_empty()) {
        limits.insert("cpu".into(), cpu.into());
    }
    if let Some(mem) = memory_limit.filter(|s| !s.trim().is_empty()) {
        limits.insert("memory".into(), mem.into());
    }
    let mut container = serde_json::json!({
        "name": "shell",
        "image": image,
        "command": ["sleep", "14400"],
        "securityContext": { "privileged": true },
        "stdin": true,
        "tty": true
    });
    if !limits.is_empty() {
        container["resources"] = serde_json::json!({ "limits": limits });
    }
    let pod_json = serde_json::json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": ns,
            "labels": { "app.kubernetes.io/managed-by": "pigeoneye" }
        },
        "spec": {
            "nodeName": node,
            "hostPID": true,
            "hostIPC": true,
            "hostNetwork": true,
            "restartPolicy": "Never",
            // backstop: if PigeonEye dies before reaping, the API
            // server ends the pod on its own
            "activeDeadlineSeconds": 14400,
            "tolerations": [{ "operator": "Exists" }],
            "containers": [container]
        }
    });
    let pod: K8sPod = serde_json::from_value(pod_json).map_err(err)?;
    let pods: Api<K8sPod> = Api::namespaced(client.clone(), &ns);
    pods.create(&PostParams::default(), &pod).await.map_err(err)?;

    let mut running = false;
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(p) = pods.get(&name).await {
            if p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running") {
                running = true;
                break;
            }
        }
    }
    if !running {
        let _ = pods.delete(&name, &DeleteParams::default().grace_period(0)).await;
        return Err("node shell helper pod did not reach Running within 30s".into());
    }

    let nsenter = [
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh", "-c", SHELL_CMD,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let started = start_exec_session(
        state,
        client,
        &ns,
        &name,
        None,
        nsenter,
        channel,
        Some((context, ns.clone(), name.clone())),
    )
    .await;
    if started.is_err() {
        // exec failed after the pod was created (RBAC, crash, timeout):
        // reap it here or a privileged hostPID pod sits on the node.
        let _ = pods
            .delete(&name, &DeleteParams::default().grace_period(0))
            .await;
    }
    started
}

pub async fn exec_stdin(state: &AppState, id: u32, data: String) -> Result<(), String> {
    let tx = state
        .exec
        .read()
        .await
        .get(&id)
        .and_then(|s| s.stdin.clone());
    if let Some(tx) = tx {
        tx.send(data.into_bytes()).await.map_err(err)?;
    }
    Ok(())
}

pub async fn exec_resize(state: &AppState, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let resize = state
        .exec
        .read()
        .await
        .get(&id)
        .and_then(|s| s.resize.clone());
    if let Some(mut tx) = resize {
        let _ = tx.try_send(TerminalSize {
            width: cols,
            height: rows,
        });
    }
    Ok(())
}

pub async fn exec_stop(state: &AppState, id: u32) -> Result<(), String> {
    let Some(session) = state.exec.write().await.remove(&id) else {
        return Ok(());
    };
    for a in &session.aborts {
        a.abort();
    }
    if let Some((ctx, ns, pod)) = session.cleanup {
        if let Ok(client) = client(state, &ctx).await {
            let pods: Api<K8sPod> = Api::namespaced(client, &ns);
            let _ = pods
                .delete(&pod, &DeleteParams::default().grace_period(0))
                .await;
        }
    }
    Ok(())
}

/// Row counts for many resource types at once (sidebar badges).
/// Fired concurrently so a sidebar full of hundreds of types still
/// resolves in roughly one round-trip.
pub async fn count_resources(
    state: &AppState,
    context: String,
    types: Vec<ResourceType>,
) -> Result<Vec<(String, usize)>, String> {
    let client = client(state, &context).await?;
    let tasks = types.into_iter().map(|rt| {
        let client = client.clone();
        async move {
            let ar = api_resource(&rt);
            let api: Api<DynamicObject> = Api::all_with(client, &ar);
            let key = format!("{}/{}/{}", rt.group, rt.version, rt.kind);
            match api.list(&ListParams::default().limit(1)).await {
                Ok(l) => {
                    let n = l
                        .metadata
                        .remaining_item_count
                        .map(|r| r as usize + l.items.len())
                        .unwrap_or(l.items.len());
                    (key, n)
                }
                Err(_) => (key, 0),
            }
        }
    });
    Ok(join_all(tasks).await)
}
