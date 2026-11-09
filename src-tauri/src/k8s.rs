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
    /// Arc so the background page-streamer can cache the completed list
    /// once every page is in.
    pub lists: std::sync::Arc<RwLock<Vec<(String, CachedList)>>>,
    /// One per connection attempt in flight. Dropping the sender cancels
    /// the attempt: a cluster behind a dead endpoint, or an SSO login the
    /// user gave up on, otherwise holds a spinner until the client's own
    /// timeout — with nothing the user can do about it.
    pub cancels: RwLock<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    /// Names seen per (context, kind), for searching every open cluster at
    /// once. Kept apart from `lists`: that cache holds six whole tables and
    /// evicts, and a search across five contexts would flush every view the
    /// user had open. This holds names only — a few hundred KB for a
    /// cluster whose pod list is 6.8MB — so it can just stay.
    pub names: RwLock<std::collections::HashMap<String, NameIndex>>,
    /// The Issues sweep currently out for each context. A sweep that finds
    /// one still running joins it rather than sending its own: while a
    /// credential helper sits at a login page every request queues behind
    /// it, and kube runs the helper once more per queued request when it
    /// fails — a browser tab apiece, one a minute, for as long as the page
    /// is left open.
    pub issue_sweeps: tokio::sync::Mutex<std::collections::HashMap<String, IssueSweep>>,
    /// Allocatable (cpu, memory, pods) per node, per context, as the node
    /// list's metrics pass last read it — so the free-room columns that open
    /// alongside don't fetch every node a second time.
    pub node_alloc: RwLock<std::collections::HashMap<String, NodeAllocRead>>,
    /// One per context: what the app asks on its own takes turns here.
    pub gates: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<CredGate>>>,
}

/// Where a cluster's background requests — the ones nobody clicked for —
/// take their turn, one at a time.
///
/// kube re-runs the credential helper for every request that finds the token
/// expired, each in turn, and remembers no failure. So while a helper waits
/// at a login page, every poller that fires queues another run behind it: a
/// browser tab apiece, long after the user walked away. Here they wait
/// outside kube instead, and once one of them finds the credential broken
/// the rest are answered with that failure without being sent. A reconnect
/// (the user signed in) starts a fresh gate. What the user does by hand
/// doesn't come through here: they are at the keyboard, and a login page is
/// the right answer to a click.
#[derive(Default)]
pub struct CredGate {
    turn: tokio::sync::Mutex<()>,
    broken: std::sync::Mutex<Option<String>>,
}

impl CredGate {
    async fn enter(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        let turn = self.turn.lock().await;
        if let Some(e) = self.broken.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            return Err(e);
        }
        Ok(turn)
    }
    fn saw<T>(&self, r: &Result<T, String>) {
        if let Err(e) = r {
            if is_credential_failure(e) {
                *self.broken.lock().unwrap_or_else(|p| p.into_inner()) = Some(e.clone());
            }
        }
    }
}

fn cred_gate(state: &AppState, ctx: &str) -> std::sync::Arc<CredGate> {
    state
        .gates
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(ctx.to_string())
        .or_default()
        .clone()
}

/// A background request, through its cluster's gate.
async fn in_background<T>(
    gate: std::sync::Arc<CredGate>,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let _turn = gate.enter().await?;
    let r = work.await;
    gate.saw(&r);
    r
}

#[derive(Clone)]
pub struct NodeAllocRead {
    pub at: std::time::Instant,
    pub nodes: std::collections::HashMap<String, (i64, i64, i64)>,
}

pub type IssueSweep =
    futures::future::Shared<futures::future::BoxFuture<'static, Result<Vec<Issue>, String>>>;

#[derive(Clone)]
pub struct NameIndex {
    pub rows: Vec<(Option<String>, String)>,
    pub at: std::time::Instant,
}

pub struct ExecSession {
    /// None for read-only sessions (log streaming).
    stdin: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
    resize: Option<Resizer>,
    aborts: Vec<tokio::task::AbortHandle>,
    /// (context, namespace, pod) to delete when the session ends —
    /// used by node shells to reap their helper pod.
    cleanup: Option<(String, String, String)>,
    /// Local pty sessions only: the child to kill when the session ends.
    /// A remote exec dies with its aborted tasks, but a local process
    /// would outlive them and keep holding the tty.
    kill: Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

/// Where a session's window size goes. A remote exec forwards it to the
/// API server over its own channel; a local pty is resized in place by
/// the thread that owns the master, so both look the same to the UI.
#[derive(Clone)]
enum Resizer {
    Remote(futures::channel::mpsc::Sender<TerminalSize>),
    Pty(tokio::sync::mpsc::Sender<(u16, u16)>),
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
    /// Pod lists only, from the same pass: the node each pod runs on, whether
    /// it has finished, and how its last container exit went.
    pub pod_extra: std::collections::HashMap<String, PodExtra>,
    /// Requests summed per node, from the last whole-cluster pod index of
    /// each context. Unlike everything above this survives a list change:
    /// it is what lets the node list show free room without fetching every
    /// pod again, and only a pod list over all namespaces can refresh it.
    pub node_req: std::collections::HashMap<String, NodeReqHarvest>,
}

#[derive(Clone, Default)]
pub struct PodExtra {
    pub node: String,
    /// Succeeded or Failed: the pod holds no requests on its node any more.
    pub done: bool,
    pub exit: Option<PodExit>,
}

/// A pod's newest container termination — why it last restarted.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PodExit {
    pub key: String,
    pub reason: String,
    pub code: i64,
    pub at: Option<String>,
    pub container: String,
}

#[derive(Clone)]
pub struct NodeReqHarvest {
    pub at: std::time::Instant,
    pub nodes: std::collections::HashMap<String, NodeReq>,
}

#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct NodeReq {
    pub cpu_r: i64,
    pub mem_r: i64,
    pub pods: u32,
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
    /// The cluster's API server URL. This is the same across everyone who
    /// can reach the cluster, no matter what they named the context — so a
    /// shared deep link can match by it instead of the local name.
    pub server: String,
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
    /// The label selector (as a query string) for those pods, so the
    /// "pods →" jump lists exactly the owned pods instead of guessing
    /// from the name. None when the object selects nothing.
    pub pod_selector: Option<String>,
    /// Secret only: each data key with its base64-decoded value (UTF-8;
    /// non-text values are noted), so the UI can reveal them without the
    /// user hand-decoding base64.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_data: Vec<(String, String)>,
    /// Scalable workloads: desired and currently ready replicas.
    pub replicas: Option<i64>,
    pub ready_replicas: Option<i64>,
    /// metadata.generation, compared against status.observedGeneration to
    /// tell "spec changed, controller hasn't acted yet" apart from a settled
    /// object — the "applying" vs "synced" distinction for a rollout badge.
    pub generation: Option<i64>,
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
        // Resolve each context's cluster to its API server URL, so the UI
        // can identify a cluster independently of the local context name.
        let servers: std::collections::HashMap<String, String> = kc
            .clusters
            .iter()
            .filter_map(|nc| {
                let s = nc.cluster.as_ref()?.server.clone()?;
                Some((nc.name.clone(), s))
            })
            .collect();
        for nc in &kc.contexts {
            let ctx = nc.context.clone().unwrap_or_default();
            let server = servers.get(&ctx.cluster).cloned().unwrap_or_default();
            out.push(ContextInfo {
                name: nc.name.clone(),
                cluster: ctx.cluster,
                user: ctx.user.unwrap_or_default(),
                namespace: ctx.namespace,
                is_current: nc.name == current,
                source: src.clone(),
                server,
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
    /// The context's own credential command, verbatim from its exec block.
    /// Unlike `command` this is nothing we guessed — it is what the cluster
    /// says produces its credentials, and it is what we can offer to run in
    /// a terminal when it turns out to want an answer from a human.
    pub exec_command: Option<String>,
}

/// The login command that fixes a given context's credentials, derived
/// from its kubeconfig exec block — never from arbitrary error text.
/// We only recognise commands we can run safely and that open their own
/// browser flow: `aws sso login` and `gcloud auth login`.
fn login_plan(exec_command: &str, args: &[String], env: &[(String, String)]) -> AuthHint {
    let base = exec_command.rsplit('/').next().unwrap_or(exec_command);
    let profile = env
        .iter()
        .find(|(k, _)| k == "AWS_PROFILE")
        .map(|(_, v)| v.clone())
        .or_else(|| {
            args.windows(2)
                .find(|w| w[0] == "--profile")
                .map(|w| w[1].clone())
        })
        // aws-vault carries the profile as the first positional after
        // `exec` (e.g. `aws-vault exec daangn/prod -- aws eks get-token`),
        // not as --profile or $AWS_PROFILE. Without it we'd emit a bare
        // `aws sso login`, which errors out (exit 253) with no profile.
        .or_else(|| {
            if base == "aws-vault" {
                args.iter()
                    .skip_while(|a| *a != "exec")
                    .skip(1)
                    .find(|a| !a.starts_with('-'))
                    .cloned()
            } else {
                None
            }
        });

    // The aws CLI's own SSO is a SEPARATE login from the get-token call:
    // `aws eks get-token` does NOT open a browser on its own when the SSO
    // token is stale, so a plain re-run in a tty can't fix it — it needs
    // `aws sso login`. (Only the *direct* `aws` exec belongs here. An
    // `aws-vault exec … -- aws … eks get-token` command has base `aws-vault`
    // and is handled by the generic exec-in-a-tty path below, which triggers
    // aws-vault's own browser login — no special case needed.)
    if base == "aws" {
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
            exec_command: None,
        };
    }
    if base == "gke-gcloud-auth-plugin" || base == "gcloud" {
        return AuthHint {
            kind: "gcloud".into(),
            message: "Google Cloud credentials have expired. Logging in opens your browser.".into(),
            command: Some("gcloud auth login".into()),
            can_login: true,
            exec_command: None,
        };
    }
    // Teleport: the exec command is usually the absolute path to `tsh`.
    if base == "tsh" {
        return AuthHint {
            kind: "teleport".into(),
            message: "Teleport session expired. Logging in opens your browser to re-authenticate.".into(),
            command: Some("tsh login".into()),
            can_login: true,
            exec_command: None,
        };
    }
    if base == "az" {
        return AuthHint {
            kind: "azure".into(),
            message: "Azure credentials have expired. Logging in opens your browser.".into(),
            command: Some("az login".into()),
            can_login: true,
            exec_command: None,
        };
    }
    // kubelogin / oidc-login (kubectl OIDC): re-running fetches a token via
    // the browser device flow.
    if base == "kubelogin" || base == "oidc-login" || base == "kubectl-oidc_login" {
        return AuthHint {
            kind: "oidc".into(),
            message: "OIDC token expired. Logging in opens your browser to re-authenticate.".into(),
            command: Some(format!("{exec_command} {}", args.join(" ")).trim().to_string()),
            can_login: true,
            exec_command: None,
        };
    }
    if base == "doctl" {
        return AuthHint {
            kind: "doctl".into(),
            message: "DigitalOcean credentials expired. Re-run `doctl auth init`.".into(),
            command: Some("doctl auth init".into()),
            can_login: true,
            exec_command: None,
        };
    }
    // Any other exec plugin (aws-vault, kubelogin, oidc-login, a custom
    // script…): we don't hardcode a login per binary. The universal fix is to
    // re-run the context's OWN credential command with a tty attached — which
    // `auth_hint` promotes to the primary action (see there). Device-flow
    // plugins open their browser / prompt only when they see a terminal, then
    // emit the token, so this covers new binaries with no special case.
    AuthHint {
        kind: "exec".into(),
        message: format!(
            "This cluster authenticates with `{base}`. Running its credential command here — with a terminal attached — lets it prompt or open its browser, then reconnects."
        ),
        command: None,
        can_login: false,
        exec_command: None,
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
    // A context that isn't in the file at all is a different problem from
    // one with no exec block, and answering "static credentials" for it
    // would be a plain lie. A restored tab lands here whenever the tool
    // that wrote the entry took it back out — `tsh logout` strips its kube
    // contexts, a rotated kubeconfig drops them — and there is nothing to
    // log into, because we no longer know how this cluster authenticated.
    let Some(nc) = kc.contexts.iter().find(|c| c.name == context) else {
        return Ok(AuthHint {
            kind: "missing".into(),
            message: format!(
                "`{context}` is no longer in your kubeconfig. Re-run the login that created it, then reconnect."
            ),
            command: None,
            can_login: false,
            exec_command: None,
        });
    };
    let user = nc.context.as_ref().and_then(|c| c.user.clone());
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
            exec_command: None,
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
    let mut hint = login_plan(
        exec.command.as_deref().unwrap_or(""),
        exec.args.as_deref().unwrap_or(&[]),
        &env,
    );
    // What the cluster itself says produces credentials, as a line the
    // user can run: the plugin's own env in front, since the kubeconfig
    // sets it and a shell would not, and the credential redirected away —
    // it is a bearer token, and the prompts we care about are on stderr.
    let mut line = String::new();
    for (k, v) in &env {
        line.push_str(&format!("{k}={} ", shell_quote(v)));
    }
    line.push_str(
        &std::iter::once(exec.command.clone().unwrap_or_default())
            .chain(exec.args.clone().unwrap_or_default())
            .map(|a| shell_quote(&a))
            .collect::<Vec<_>>()
            .join(" "),
    );
    line.push_str(" >/dev/null");
    if hint.command.is_none() {
        // No tailored login for this plugin (login_plan left command empty).
        // The login IS the context's own credential command, run with a tty
        // attached — how aws-vault, kubelogin and other device-flow plugins
        // open their browser / prompt. Promote it to the primary action so
        // every exec-based cluster gets a working login button without a
        // per-binary special case in login_plan. (No separate "run credential
        // command" button — it would run the identical line.)
        hint.command = Some(line);
        hint.can_login = true;
    } else {
        // A tailored login (aws sso login, tsh login, …) is the primary action;
        // still offer the raw credential command as a fallback, since the real
        // fix is occasionally a re-run rather than a fresh browser login.
        hint.exec_command = Some(line);
    }
    Ok(hint)
}

/// Run a local program under a pseudo-terminal and hand it to the webview
/// as an ordinary session, so it lands in a terminal the user can read and
/// type into.
///
/// A tty is the whole point. These CLIs ask things — an OTP, a password,
/// "tap your key" — and they only ask when they believe a human is on the
/// other end: they call isatty() or open /dev/tty outright, so a plain
/// pipe gets them to give up (or, worse, to echo a password). Spawned
/// straight from a GUI the way login used to be, stdin is /dev/null and
/// anything interactive hangs forever with the prompt going nowhere.
/// Run the user's login shell under a pseudo-terminal and hand it to the
/// webview as an ordinary session.
///
/// A tty is the whole point. The CLIs this exists for ask things — an OTP,
/// a password, "tap your key" — and they only ask when they believe a
/// human is on the other end: they call isatty() or open /dev/tty
/// outright, so a plain pipe gets them to give up (or, worse, to echo a
/// password). Spawned straight from a GUI, stdin is /dev/null and anything
/// interactive hangs forever with the prompt going nowhere.
///
/// A shell rather than each command on its own, because the fix for a
/// cluster is rarely one command: `tsh login` then the token, a tunnel
/// left running, a second try with a different flag. The buttons type
/// into this; the user can type anything else.
/// Which shell the in-app terminal runs.
///
/// Unix answers with $SHELL. Windows has no such variable, so pick
/// PowerShell: pwsh if the user installed PowerShell 7 (that is the one
/// whose profile a developer actually maintains), otherwise the Windows
/// PowerShell every install ships with. Not cmd.exe — a kubeconfig `exec`
/// login that wants to print a prompt and read an answer needs a shell
/// that can.
fn login_shell() -> String {
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
    #[cfg(windows)]
    {
        let on_path = |exe: &str| {
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
                .unwrap_or(false)
        };
        if on_path("pwsh.exe") {
            "pwsh.exe".to_string()
        } else {
            "powershell.exe".to_string()
        }
    }
}

pub async fn local_shell_start(
    state: &AppState,
    command: Option<String>,
    channel: Channel<String>,
) -> Result<u32, String> {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::io::{Read, Write};

    let shell = login_shell();
    let command = command.filter(|c| !c.trim().is_empty());
    let had_command = command.is_some();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;
    let mut builder = CommandBuilder::new(&shell);
    // An INTERACTIVE login shell (-i), so it reads the same profile the
    // user's terminal does — the one that puts tsh, aws-vault and the rest
    // on PATH. The -i matters: zsh (the macOS default) only sources .zshrc
    // when interactive, and that is where AWS_PROFILE / AWS_CONFIG_FILE, a
    // version-managed `aws` (mise/asdf/brew), and granted/aws-vault shell
    // functions usually live. A plain -lc login shell skips .zshrc, so
    // `aws sso login` here would run in a DIFFERENT AWS context than the
    // get-token exec (whose env is hydrated by the -ilc probe in lib.rs) —
    // it would refresh the wrong sso_session and the reconnect would still
    // report "SSO session expired". Keep these flags in step with that probe.
    // Given a command it runs that and exits, which is what makes its exit
    // status worth something: the caller can connect on a zero and stay put
    // on anything else.
    #[cfg(not(windows))]
    match &command {
        Some(c) => builder.args(["-ilc", c]),
        None => builder.args(["-il"]),
    }
    // PowerShell loads the user's profile unless told not to, which is the
    // point — that is where PATH edits, AWS_PROFILE and any `aws`/`tsh`
    // shim live, the same reason the unix side insists on an interactive
    // login shell. `exit $LASTEXITCODE` is what makes a one-command run
    // report the native program's status instead of PowerShell's own.
    #[cfg(windows)]
    match &command {
        Some(c) => builder.args(["-NoLogo", "-Command", &format!("{c}; exit $LASTEXITCODE")]),
        None => builder.args(["-NoLogo"]),
    }
    // A GUI launch inherits no TERM, and a shell that cannot identify the
    // terminal drops to dumb output.
    builder.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        builder.cwd(home);
    }
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("could not run `{shell}`: {e}"))?;
    // Our copy of the slave has to go, or the master never sees EOF when
    // the child exits and the reader below waits on it forever.
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let mut writer = pair.master.take_writer().map_err(err)?;

    // The master lives in the resize thread and dies with it: the session
    // going away drops the sender, which ends the loop, which drops the
    // pty. Nothing else needs to own it.
    let (rtx, mut rrx) = tokio::sync::mpsc::channel::<(u16, u16)>(8);
    let master = pair.master;
    std::thread::spawn(move || {
        while let Some((cols, rows)) = rrx.blocking_recv() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    });

    // pty reads and writes are blocking, so they get threads rather than
    // tasks — an async runtime worker parked on a tty helps nobody.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        while let Some(b) = rx.blocking_recv() {
            if writer.write_all(&b).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = channel.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                }
            }
        }
        // Reap only after the output is drained, so the verdict prints last.
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        // Only a one-command run has a verdict worth stating; a shell the
        // user typed `exit` into does not.
        if had_command {
            let _ = channel.send(if ok {
                "\r\n\u{1b}[32m[done — connecting]\u{1b}[0m\r\n".to_string()
            } else {
                "\r\n\u{1b}[31m[exited without finishing — not connecting]\u{1b}[0m\r\n"
                    .to_string()
            });
        }
        let _ = channel.send(if ok { "\u{0}exit:0" } else { "\u{0}exit" }.to_string());
    });

    let id = state
        .next_exec
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.exec.write().await.insert(
        id,
        ExecSession {
            stdin: Some(tx),
            resize: Some(Resizer::Pty(rtx)),
            aborts: Vec::new(),
            cleanup: None,
            kill: Some(killer),
        },
    );
    Ok(id)
}

/// Quote for a shell only when the value would otherwise break — an
/// unquoted kubeconfig is the common case and reads better bare.
fn shell_quote(v: &str) -> String {
    if !v.is_empty()
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@+,".contains(c))
    {
        return v.to_string();
    }
    format!("'{}'", v.replace('\'', r"'\''"))
}

/// The user's home directory. Unix states it in $HOME; Windows has no $HOME
/// of its own, so fall back to %USERPROFILE%. $HOME still wins when it is
/// set, because a unix-ish shell on Windows (Git Bash, MSYS) puts its
/// dotfiles — and its kubeconfig — under that one.
pub fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(std::path::PathBuf::from)
}

fn shellexpand_home(p: &str) -> String {
    // `~\` as well as `~/`: a path typed on Windows uses backslashes.
    let rest = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\"));
    if let Some(rest) = rest {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
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
    // Race the attempt against a cancel. Dropping the future drops the
    // request with it, so giving up actually stops the work rather than
    // just looking away from it.
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    state.cancels.write().await.insert(context.clone(), tx);
    let out = tokio::select! {
        r = connect_inner(state, &context, path) => r,
        _ = rx => Err("cancelled".to_string()),
    };
    state.cancels.write().await.remove(&context);
    out
}

/// Cancel an attempt started by `connect`. Unknown contexts are fine —
/// the attempt may have just finished on its own.
pub async fn cancel_connect(state: &AppState, context: String) {
    state.cancels.write().await.remove(&context);
}

async fn connect_inner(
    state: &AppState,
    context: &str,
    path: Option<String>,
) -> Result<String, String> {
    let context = context.to_string();
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
    // Reap this context's sessions BEFORE dropping the client — otherwise
    // a node shell's privileged helper pod lingers until its 4h deadline.
    let mut reap: Vec<(String, String)> = Vec::new();
    {
        let mut exec = state.exec.write().await;
        let ids: Vec<u32> = exec
            .iter()
            .filter(|(_, s)| {
                s.cleanup.as_ref().map(|(c, _, _)| c == &context).unwrap_or(false)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some(s) = exec.remove(&id) {
                for a in &s.aborts {
                    a.abort();
                }
                if let Some((_, ns, pod)) = s.cleanup {
                    reap.push((ns, pod));
                }
            }
        }
    }
    // Abort this context's port-forwards (they hold their own client).
    {
        let mut fw = state.forwards.write().await;
        let ids: Vec<u32> = fw
            .iter()
            .filter(|(_, s)| s.info.context == context)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some(s) = fw.remove(&id) {
                s.abort.abort();
                for c in s.conns.lock().unwrap().drain(..) {
                    c.abort();
                }
            }
        }
    }
    if let Ok(client) = client(state, &context).await {
        for (ns, pod) in reap {
            let pods: Api<K8sPod> = Api::namespaced(client.clone(), &ns);
            let _ = pods.delete(&pod, &DeleteParams::default().grace_period(0)).await;
        }
    }
    state.clients.write().await.remove(&context);
    // A sweep still out on the old client — stuck at a login page, say — is
    // not one the reconnected cluster should wait on or share an answer with.
    state.issue_sweeps.lock().await.remove(&context);
    state.gates.lock().unwrap_or_else(|p| p.into_inner()).remove(&context);
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
/// Safety cap on how many rows the background streamer will pull for one
/// list. Beyond this the list is served partial (and left uncached) with
/// a terminal done-marker so the UI stops spinning. Set above real
/// clusters — 24k pods, ~170k+ events — so they finish and cache.
const MAX_STREAM_ROWS: usize = 300_000;

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
    // With includeObject=None the printer's first cell is the name — but some
    // printers DECORATE it: the default StorageClass prints "<name> (default)".
    // Taken literally that lands in a request path and fails to build as a URI.
    // An object name can never contain a space (RFC 1123 subdomain), so cutting
    // at the first one strips any such suffix while leaving names that do carry
    // punctuation intact — `system:controller:deployment-controller` and the
    // like.
    let fallback_name = cells
        .first()
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .split(' ')
        .next()
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
    fetch_table_page(client, rt, namespace, include_object, field_selector, None, None).await
}

async fn fetch_table_page(
    client: &Client,
    rt: &ResourceType,
    namespace: Option<&str>,
    include_object: &str,
    field_selector: Option<&str>,
    continue_token: Option<&str>,
    limit_override: Option<u32>,
) -> Result<serde_json::Value, String> {
    let limit = limit_override.unwrap_or(if include_object == "None" {
        PAGE_LIMIT_CELLS
    } else {
        PAGE_LIMIT_META
    });
    let mut url = format!(
        "{}?limit={}&includeObject={}",
        resource_url(rt, namespace),
        limit,
        include_object
    );
    if let Some(fs) = field_selector.filter(|f| !f.is_empty()) {
        // A "label:" prefix routes to labelSelector; otherwise it's a
        // fieldSelector. This lets one selector param thread through the
        // whole list/watch/cache path for both kinds of narrowing.
        if let Some(ls) = fs.strip_prefix("label:") {
            url.push_str("&labelSelector=");
            url.push_str(&urlencode(ls));
        } else {
            url.push_str("&fieldSelector=");
            url.push_str(&urlencode(fs));
        }
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

/// Tell the frontend the stream is finished (clears its "loading…"
/// spinner). Sent on completion, the safety cap, or a mid-stream error —
/// never leave the UI spinning.
fn send_stream_done(chan: &Channel<serde_json::Value>, generation: u64, still_current: bool) {
    if !still_current {
        return; // the view moved on; nobody's listening
    }
    let end = serde_json::to_value(RowPage {
        generation,
        rows: Vec::new(),
        done: true,
    })
    .unwrap_or_default();
    let _ = chan.send(end);
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
    s.pod_extra.clear();
    s.indexed = false;
    s.source = Some((
        context.to_string(),
        rt.clone(),
        namespace,
        field_selector,
    ));
    s.generation
}

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub context: String,
    pub namespace: Option<String>,
    pub name: String,
}

const SEARCH_HITS_MAX: usize = 200;

#[derive(Serialize, Clone)]
pub struct SearchBatch {
    pub context: String,
    pub hits: Vec<SearchHit>,
    /// Total matches, which is more than `hits` holds when a query is
    /// broad. Shown rather than dropped: a silently cut list reads as a
    /// complete answer.
    pub total: usize,
    /// How old the names behind these hits are. 0 means just fetched.
    pub age_ms: u64,
    pub error: Option<String>,
}

fn name_key(context: &str, rt: &ResourceType) -> String {
    format!("{context}|{}/{}", rt.group, rt.kind)
}

/// Names of one kind in one context, from the index when it holds them and
/// from the cluster otherwise.
async fn names_for(
    state: &AppState,
    context: &str,
    rt: &ResourceType,
    refresh: bool,
) -> Result<(Vec<(Option<String>, String)>, u64), String> {
    let key = name_key(context, rt);
    if !refresh {
        if let Some(idx) = state.names.read().await.get(&key) {
            return Ok((idx.rows.clone(), idx.at.elapsed().as_millis() as u64));
        }
    }
    let client = client(state, context).await?;
    // Same reasoning as list_resources: the printer's first cell is the
    // name, but a list spanning namespaces needs the object to know which
    // namespace each row is in.
    let include = if rt.namespaced { "Metadata" } else { "None" };
    // Page to the end. A single fetch stops at the server page limit —
    // 500 rows with object metadata — and an index that quietly holds the
    // first 500 pods of a cluster is worse than no index at all: the
    // search would answer "not here" about things that are.
    let mut rows: Vec<(Option<String>, String)> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        // Bigger pages than a live view uses. That limit exists so rows
        // reach the screen early; nothing here is streamed, so a 24k-pod
        // kind costs 12 requests instead of 48.
        let page =
            fetch_table_page(&client, rt, None, include, None, token.as_deref(), Some(2000))
                .await?;
        if let Some(list) = page.get("rows").and_then(|r| r.as_array()) {
            rows.extend(list.iter().filter_map(|r| {
                let cells = r
                    .get("cells")
                    .and_then(|c| c.as_array())
                    .cloned()
                    .unwrap_or_default();
                let obj = r.get("object").cloned().unwrap_or(serde_json::Value::Null);
                let row = row_from_object(&obj, cells);
                (!row.name.is_empty()).then_some((row.namespace, row.name))
            }));
        }
        token = continue_token(&page);
        // A ceiling on the walk, so one enormous kind cannot pull the app
        // through hundreds of pages. Names are ~60 bytes each, so this is
        // a few MB — far past any list a human searches by name.
        if token.is_none() || rows.len() >= 50_000 {
            break;
        }
    }
    store_names(state, key, rows.clone()).await;
    Ok((rows, 0))
}

/// Search one kind by name across several contexts, one batch per context
/// as it lands. Nothing here writes the list cache — see `names`.
pub async fn search_contexts(
    state: &AppState,
    contexts: Vec<String>,
    rt: ResourceType,
    query: String,
    refresh: bool,
    channel: Channel<SearchBatch>,
) -> Result<(), String> {
    use futures::StreamExt;
    let q = query.trim().to_lowercase();
    let hits_from = |rows: Vec<(Option<String>, String)>, context: &str| -> (Vec<SearchHit>, usize) {
        let matched: Vec<SearchHit> = rows
            .into_iter()
            .filter(|(_, n)| q.is_empty() || n.to_lowercase().contains(&q))
            .map(|(namespace, name)| SearchHit {
                context: context.to_string(),
                namespace,
                name,
            })
            .collect();
        let total = matched.len();
        (matched.into_iter().take(SEARCH_HITS_MAX).collect(), total)
    };
    // Contexts in parallel so the wait is one round trip rather than the
    // sum of them, but only a few at a time: each uncached one pulls a
    // whole kind, and four of those at once is already a lot of memory in
    // flight. Each reports on its own, so the list fills as answers land.
    futures::stream::iter(contexts.into_iter().map(|ctx| {
        let rt = rt.clone();
        let channel = channel.clone();
        async move {
            let batch = match names_for(state, &ctx, &rt, refresh).await {
                Ok((rows, age_ms)) => {
                    let (hits, total) = hits_from(rows, &ctx);
                    SearchBatch {
                        hits,
                        total,
                        context: ctx,
                        age_ms,
                        error: None,
                    }
                }
                Err(e) => SearchBatch {
                    context: ctx,
                    hits: Vec::new(),
                    total: 0,
                    age_ms: 0,
                    error: Some(e),
                },
            };
            let _ = channel.send(batch);
        }
    }))
    .buffer_unordered(4)
    .collect::<Vec<()>>()
    .await;
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct Issue {
    pub context: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub status: String,
}
#[derive(Serialize)]
pub struct IssueBatch {
    pub context: String,
    pub issues: Vec<Issue>,
    pub error: Option<String>,
}

/// A pod's server-computed status (the kubectl STATUS column) that means it
/// needs attention — everything but the healthy/transient-normal states.
fn is_pod_issue(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    const OK: &[&str] = &[
        "Running",
        "Completed",
        "Succeeded",
        "ContainerCreating",
        "Terminating",
        "PodInitializing",
    ];
    if OK.contains(&s) {
        return false;
    }
    // "Init:0/3" is normal init progress; "Init:Error"/"Init:CrashLoop…" is not.
    if s.starts_with("Init:")
        && !s.contains("Error")
        && !s.contains("CrashLoop")
        && !s.contains("BackOff")
    {
        return false;
    }
    true
}
fn is_node_issue(s: &str) -> bool {
    s.contains("NotReady") || s == "Unknown"
}

/// Index of the "Status" printer column, so we can read the computed status
/// cell without re-deriving it.
fn status_col_index(table: &serde_json::Value) -> Option<usize> {
    table["columnDefinitions"].as_array().and_then(|a| {
        a.iter().position(|c| {
            c["name"]
                .as_str()
                .map(|n| n.eq_ignore_ascii_case("status"))
                .unwrap_or(false)
        })
    })
}

/// Whether a request failed because the credential itself is broken — the
/// helper could not produce a token, or the server rejected the one it had.
/// Retrying either runs the helper again, which can open a browser.
/// Forbidden is not here: the token worked, the account just may not list
/// that, and a cluster-scoped list being off limits is ordinary.
fn is_credential_failure(msg: &str) -> bool {
    msg.contains("auth exec") || msg.contains("exec auth") || msg.contains("Unauthorized")
}

async fn issues_with(client: Client, ctx: String) -> Result<Vec<Issue>, String> {
    let ctx = ctx.as_str();
    let mut out = vec![];
    let core = |kind: &str, plural: &str, namespaced: bool| ResourceType {
        group: String::new(),
        version: "v1".into(),
        kind: kind.into(),
        plural: plural.into(),
        namespaced,
        deletable: true,
        editable: true,
    };
    // Pods across every namespace, filtered to problem statuses.
    let pod_rt = core("Pod", "pods", true);
    let pods = fetch_table_page(&client, &pod_rt, None, "Metadata", None, None, None).await;
    // A broken credential is the one failure the caller must hear about: it
    // is what parks the cluster out of the sweep. Swallowing it, as this
    // once did, re-ran the helper on every sweep forever — and asking for
    // nodes as well would run it a second time.
    if let Err(e) = &pods {
        if is_credential_failure(e) {
            return Err(e.clone());
        }
    }
    if let Ok(table) = pods {
        if let Some(si) = status_col_index(&table) {
            for r in rows_from_page(&table, None) {
                let s = r.cells.get(si).and_then(|c| c.as_str()).unwrap_or("");
                if is_pod_issue(s) {
                    out.push(Issue {
                        context: ctx.into(),
                        kind: "Pod".into(),
                        namespace: r.namespace.clone(),
                        name: r.name.clone(),
                        status: s.to_string(),
                    });
                }
            }
        }
    }
    // Nodes that aren't Ready.
    let node_rt = core("Node", "nodes", false);
    let nodes = fetch_table_page(&client, &node_rt, None, "Metadata", None, None, None).await;
    if let Err(e) = &nodes {
        if is_credential_failure(e) {
            return Err(e.clone());
        }
    }
    if let Ok(table) = nodes {
        if let Some(si) = status_col_index(&table) {
            for r in rows_from_page(&table, None) {
                let s = r.cells.get(si).and_then(|c| c.as_str()).unwrap_or("");
                if is_node_issue(s) {
                    out.push(Issue {
                        context: ctx.into(),
                        kind: "Node".into(),
                        namespace: None,
                        name: r.name.clone(),
                        status: s.to_string(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Fan out across every open cluster and stream back the problem resources
/// (failing/pending pods, NotReady nodes) per cluster as each lands — the
/// "what needs attention right now" glance. Modeled on `search_contexts`.
pub async fn aggregate_issues(
    state: &AppState,
    contexts: Vec<String>,
    channel: Channel<IssueBatch>,
) -> Result<(), String> {
    use futures::StreamExt;
    futures::stream::iter(contexts.into_iter().map(|ctx| {
        let channel = channel.clone();
        async move {
            let batch = match issues_once(state, &ctx).await {
                Ok(issues) => IssueBatch {
                    context: ctx,
                    issues,
                    error: None,
                },
                Err(e) => IssueBatch {
                    context: ctx,
                    issues: vec![],
                    error: Some(e),
                },
            };
            let _ = channel.send(batch);
        }
    }))
    .buffer_unordered(4)
    .collect::<Vec<()>>()
    .await;
    Ok(())
}

/// One Issues sweep per context at a time — see `AppState::issue_sweeps`.
/// Every caller gets the same answer, so a sweep that overlaps the one before
/// it costs nothing extra, and when a stuck helper finally fails the newest
/// sweep hears it too and can park the cluster.
async fn issues_once(state: &AppState, ctx: &str) -> Result<Vec<Issue>, String> {
    use futures::FutureExt;
    let client = client(state, ctx).await?;
    let gate = cred_gate(state, ctx);
    let sweep = {
        let mut sweeps = state.issue_sweeps.lock().await;
        sweeps
            .entry(ctx.to_string())
            .or_insert_with(|| {
                in_background(gate, issues_with(client, ctx.to_string())).boxed().shared()
            })
            .clone()
    };
    let out = sweep.clone().await;
    // Finished: the next sweep asks afresh. Only if the entry is still this
    // one — a disconnect drops it, and a reconnect may have started another.
    let mut sweeps = state.issue_sweeps.lock().await;
    if sweeps.get(ctx).is_some_and(|s| s.ptr_eq(&sweep)) {
        sweeps.remove(ctx);
    }
    out
}

/// Fold a list the user already loaded into the name index — the rows are
/// in hand, so the contexts they visit index themselves for free.
/// Kinds worth remembering names for. Events are the exception that
/// matters: tens of thousands of rows whose names are hashes nobody
/// searches for, rewritten constantly.
fn indexable(rt: &ResourceType) -> bool {
    !(rt.group.is_empty() && rt.kind == "Event") && rt.kind != "Event"
}

/// One index entry per (context, kind) would grow without end across a
/// long session; keep the most recent ones.
const NAME_INDEX_MAX: usize = 40;

async fn store_names(state: &AppState, key: String, rows: Vec<(Option<String>, String)>) {
    let mut idx = state.names.write().await;
    if idx.len() >= NAME_INDEX_MAX && !idx.contains_key(&key) {
        if let Some(oldest) = idx
            .iter()
            .min_by_key(|(_, v)| v.at)
            .map(|(k, _)| k.clone())
        {
            idx.remove(&oldest);
        }
    }
    idx.insert(
        key,
        NameIndex {
            rows,
            at: std::time::Instant::now(),
        },
    );
}

pub async fn harvest_names(state: &AppState, context: &str, rt: &ResourceType, rows: &[TableRow]) {
    if !indexable(rt) {
        return;
    }
    // Only a list of everything describes the whole kind; a namespaced or
    // filtered view would index a slice and look complete.
    store_names(
        state,
        name_key(context, rt),
        rows.iter()
            .map(|r| (r.namespace.clone(), r.name.clone()))
            .collect(),
    )
    .await;
}

async fn store_cached(
    lists: &RwLock<Vec<(String, CachedList)>>,
    key: String,
    entry: CachedList,
) {
    let mut c = lists.write().await;
    c.retain(|(k, _)| k != &key);
    c.push((key, entry));
    let over = c.len().saturating_sub(LIST_CACHE_MAX);
    if over > 0 {
        c.drain(0..over);
    }
}

async fn cache_list(state: &AppState, key: String, entry: CachedList) {
    store_cached(&state.lists, key, entry).await;
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

/// One-shot list for an embedded mini-view — e.g. the pods running on a
/// node, shown inside the node detail panel without leaving it. A single
/// Metadata page (so each row carries its own namespace across a
/// cluster-wide query), the same server-side printer columns as the main
/// list, and no watch / cache / search index. A node holds at most ~110
/// pods, so one page is the whole answer.
pub async fn list_snapshot(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
) -> Result<ResourceTable, String> {
    let client = client(state, &context).await?;
    let table = fetch_table_page(
        &client,
        &rt,
        namespace.as_deref(),
        "Metadata",
        field_selector.as_deref(),
        None,
        None,
    )
    .await?;
    let columns: Vec<ColumnDef> = table["columnDefinitions"]
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
    let rows = rows_from_page(&table, namespace.as_deref());
    Ok(ResourceTable {
        columns,
        rows,
        truncated: continue_token(&table).is_some(),
        resource_version: None,
        include: "Metadata".into(),
    })
}

pub async fn list_resources(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
    channel: Channel<serde_json::Value>,
    background: bool,
) -> Result<ResourceTable, String> {
    let client = client(state, &context).await?;
    // A re-list nobody asked for (the server closed the watch) waits its turn
    // and stands down if the credential is already known broken. Only the
    // first page: once that answered, the token is good.
    let gate = background.then(|| cred_gate(state, &context));
    let turn = match &gate {
        Some(g) => Some(g.enter().await?),
        None => None,
    };
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
        Err(e) => {
            if let Some(g) = &gate {
                g.saw::<()>(&Err(e.clone()));
            }
            return Err(e);
        }
    };
    drop(turn);

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
        s.pod_extra.clear();
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
        // Everything the completed list needs to be cached, so returning
        // to it later resumes the watch instead of re-streaming.
        let lists = state.lists.clone();
        let cache_key = list_key(&context, &rt, namespace.as_deref(), field_selector.as_deref());
        let cache_cols = columns.clone();
        let cache_inc = include.to_string();
        let cache_rv = table
            .pointer("/metadata/resourceVersion")
            .and_then(|r| r.as_str())
            .map(String::from);
        let mut all_rows = rows.clone();
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
                    fetch_table_page(&c, &r, n.as_deref(), &inc, f.as_deref(), Some(&tok), None).await
                })
            };
            let mut in_flight = first_token.map(spawn_fetch);
            // Once the user navigates away this drops to false: we stop
            // feeding the (now-defunct) view and search cache, but keep
            // pulling pages so the completed list still lands in the cache
            // — a later visit then finds it whole instead of re-streaming
            // from page one.
            let mut still_current = true;
            while let Some(handle) = in_flight.take() {
                // Cap on rows, not pages: a page holds 500 (Metadata) or
                // 2000 (cells) rows, so a page cap silently truncated
                // Metadata lists (all-namespace pods) at ~20k — the list
                // never completed and so never cached. This lets a 24k-pod
                // cluster finish and be cached.
                if all_rows.len() > MAX_STREAM_ROWS {
                    // Safety cap hit: the list is partial and won't be
                    // cached, but tell the UI we're done so the "loading…"
                    // spinner clears instead of spinning forever.
                    send_stream_done(&chan, generation, still_current);
                    return;
                }
                let Ok(Ok(page)) = handle.await else {
                    // A page fetch failed mid-stream (e.g. a `continue`
                    // token expired → 410). Tell the UI we're done so the
                    // spinner clears; the list stays uncached (partial).
                    send_stream_done(&chan, generation, still_current);
                    return;
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
                    send_stream_done(&chan, generation, still_current);
                    return;
                };
                if still_current {
                    let mut sc = search.write().await;
                    if sc.generation != generation {
                        still_current = false; // superseded — cache only now
                    } else {
                        sc.keys.extend(keys);
                        sc.blobs.extend(blobs);
                        // new rows are not in the full-text index yet
                        sc.indexed = false;
                    }
                }
                let done = token.is_none();
                all_rows.extend(rows.iter().cloned());
                if still_current {
                    let payload = serde_json::to_value(RowPage {
                        generation,
                        rows: std::mem::take(&mut rows),
                        done,
                    })
                    .unwrap_or_default();
                    if chan.send(payload).is_err() {
                        still_current = false; // the view is gone
                    }
                }
                if done {
                    // Whole list is in — cache the complete snapshot + its
                    // resourceVersion so revisiting resumes the watch from
                    // here instead of re-streaming everything.
                    store_cached(
                        &lists,
                        cache_key,
                        CachedList {
                            columns: cache_cols,
                            rows: all_rows,
                            resource_version: cache_rv,
                            include: cache_inc,
                        },
                    )
                    .await;
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
    // A list of the whole kind is exactly what the name index wants, and
    // it is already in hand — so browsing indexes the contexts you visit
    // at no cost. A namespaced or filtered view is a slice and would look
    // complete, so those are left alone.
    if namespace.is_none() && field_selector.is_none() && !truncated {
        harvest_names(state, &context, &rt, &rows).await;
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
        if let Some(ls) = fs.strip_prefix("label:") {
            url.push_str("&labelSelector=");
            url.push_str(&urlencode(ls));
        } else {
            url.push_str("&fieldSelector=");
            url.push_str(&urlencode(&fs));
        }
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
            let mut rows = rows;
            if rows.is_empty() {
                // A Table-format DELETE can arrive with no printed rows (or
                // as the bare object). Recover the identity from the
                // object's own metadata so the row is still removed instead
                // of lingering until the next full resync. (A list Table's
                // top-level metadata has no `name`, so this only fires for a
                // real object.)
                if kind == "DELETED" {
                    if let Some(name) = obj
                        .pointer("/metadata/name")
                        .and_then(|v| v.as_str())
                    {
                        rows.push(TableRow {
                            name: name.to_string(),
                            namespace: obj
                                .pointer("/metadata/namespace")
                                .and_then(|v| v.as_str())
                                .map(String::from)
                                .or_else(|| ns_for_rows.clone()),
                            cells: Vec::new(),
                            labels: Default::default(),
                            owner_kind: None,
                        });
                    }
                }
                if rows.is_empty() {
                    continue;
                }
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
    let mut pod_extra: std::collections::HashMap<String, PodExtra> =
        std::collections::HashMap::new();
    // Page the object projection until the server's `continue` is
    // exhausted, so the index and pod requests/limits cover the WHOLE
    // list. (Previously this stopped at a snapshot of keys.len() taken
    // before the row streamer had finished, leaving %CPU/MEM per-pod
    // request/limit columns as n/a for everything past the first page.)
    let mut token: Option<String> = None;
    loop {
        let page = fetch_table_page(
            client,
            rt,
            namespace,
            "Object",
            field_selector,
            token.as_deref(),
            None,
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
                let mut out: Vec<(String, String, Option<(PodRes, PodExtra)>)> =
                    Vec::with_capacity(part.len());
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
                    let res = is_pod.then(|| (pod_resources(obj), pod_extra_of(obj, &key)));
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
                if let Some((r, x)) = res {
                    pod_res.insert(key.clone(), r);
                    pod_extra.insert(key.clone(), x);
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
        if token.is_none() || search.read().await.generation != generation {
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
        // Only a pass over every pod can say what each node has committed.
        let whole = namespace.filter(|n| !n.is_empty()).is_none()
            && field_selector.filter(|f| !f.is_empty()).is_none();
        if whole {
            if let Some((ctx, ..)) = s.source.clone() {
                let nodes = node_requests(&pod_res, &pod_extra);
                s.node_req.insert(ctx, NodeReqHarvest { at: std::time::Instant::now(), nodes });
            }
        }
        s.pod_res = pod_res;
        s.pod_extra = pod_extra;
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

/// Below this row count a single-threaded scan already runs in well under
/// a millisecond, so spinning up worker threads would cost more than it
/// saves. Above it, the full-text blobs (every field of tens of thousands
/// of objects) make the parallel split worthwhile.
const PARALLEL_FILTER_MIN: usize = 4000;

pub async fn filter_rows(state: &AppState, query: String) -> Result<Vec<String>, String> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let s = state.search.read().await;
    let n = s.blobs.len();
    // Return the matched rows' keys (namespace/name), not positional
    // indices: the frontend list is reordered by the watch informer
    // independently of this cache, so an index would point at the wrong
    // row. A key stays correct no matter how the list is spliced.
    if n < PARALLEL_FILTER_MIN {
        return Ok(s
            .blobs
            .iter()
            .enumerate()
            .filter(|(_, b)| terms.iter().all(|t| b.contains(t.as_str())))
            .filter_map(|(i, _)| s.keys.get(i).cloned())
            .collect());
    }
    // Big list: split the scan across cores. Scoped threads borrow the
    // blobs/keys under the read guard, so nothing is cloned; the guard only
    // holds off a re-index for the few milliseconds the scan takes. Chunks
    // are appended in order, so results stay in blob order like the plain
    // path above.
    let workers = std::thread::available_parallelism()
        .map(|c| c.get().min(8))
        .unwrap_or(4);
    let chunk = n.div_ceil(workers);
    let blobs = &s.blobs;
    let keys = &s.keys;
    let terms = &terms;
    let mut out: Vec<String> = Vec::new();
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let start = w * chunk;
                let end = ((w + 1) * chunk).min(n);
                scope.spawn(move || {
                    let mut local = Vec::new();
                    for i in start..end {
                        if terms.iter().all(|t| blobs[i].contains(t.as_str())) {
                            if let Some(k) = keys.get(i) {
                                local.push(k.clone());
                            }
                        }
                    }
                    local
                })
            })
            .collect();
        for h in handles {
            out.extend(h.join().unwrap_or_default());
        }
    });
    Ok(out)
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
        generation: meta.get("generation").and_then(|g| g.as_i64()),
        links: related_links(&v, &rt.kind),
        has_pod_selector: v.pointer("/spec/selector").is_some()
            && rt.kind != "PersistentVolumeClaim",
        pod_selector: (v.pointer("/spec/selector").is_some()
            && rt.kind != "PersistentVolumeClaim")
        .then(|| label_selector_string(&v))
        .filter(|s| !s.is_empty()),
        secret_data: if rt.group.is_empty() && rt.kind == "Secret" {
            decode_secret_data(&v)
        } else {
            Vec::new()
        },
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
        "RoleBinding" | "ClusterRoleBinding" => {
            // the role it grants…
            let role_kind = v.pointer("/roleRef/kind").and_then(|k| k.as_str());
            push(
                role_kind,
                v.pointer("/roleRef/name").and_then(|n| n.as_str()),
                // a RoleBinding's Role is namespaced; a ClusterRole isn't
                if role_kind == Some("Role") { ns.clone() } else { None },
            );
            // …and the subjects it grants it to
            for s in v
                .pointer("/subjects")
                .and_then(|s| s.as_array())
                .into_iter()
                .flatten()
            {
                push(
                    s.get("kind").and_then(|k| k.as_str()),
                    s.get("name").and_then(|n| n.as_str()),
                    s.get("namespace")
                        .and_then(|n| n.as_str())
                        .map(String::from)
                        .or_else(|| ns.clone()),
                );
            }
        }
        "ServiceAccount" => {
            for sec in v.pointer("/secrets").and_then(|s| s.as_array()).into_iter().flatten() {
                push(
                    Some("Secret"),
                    sec.get("name").and_then(|n| n.as_str()),
                    ns.clone(),
                );
            }
            for sec in v
                .pointer("/imagePullSecrets")
                .and_then(|s| s.as_array())
                .into_iter()
                .flatten()
            {
                push(
                    Some("Secret"),
                    sec.get("name").and_then(|n| n.as_str()),
                    ns.clone(),
                );
            }
        }
        _ => {}
    }

    // Cross-cutting links added regardless of the match above.
    if kind == "Ingress" {
        push(
            Some("IngressClass"),
            v.pointer("/spec/ingressClassName").and_then(|n| n.as_str()),
            None,
        );
    }
    if kind == "PersistentVolumeClaim" || kind == "PersistentVolume" {
        push(
            Some("StorageClass"),
            v.pointer("/spec/storageClassName").and_then(|n| n.as_str()),
            None,
        );
    }

    // Everything above is one kind's rules, written by hand. That does not
    // scale to a cluster's CRDs — a Certificate points at a Secret and an
    // Issuer, a HelmRelease at a HelmRepository, and none of them are known
    // here. So finish with a pass that finds references by *shape* instead:
    // Kubernetes has a strong convention for them, and the UI drops any
    // candidate whose kind the cluster does not actually serve, which is
    // what makes guessing safe.
    scan_refs(v, "", &ns, &mut out);

    // de-duplicate while keeping order
    let mut seen = std::collections::HashSet::new();
    out.retain(|l| seen.insert((l.kind.clone(), l.name.clone())));
    out.truncate(RELATED_MAX);
    out
}

#[derive(Deserialize)]
pub struct RefCheck {
    pub resource: ResourceType,
    pub namespace: Option<String>,
    pub name: String,
}

/// Which of these references actually exist.
///
/// The link scan guesses by shape, so it can name something that is not
/// there — and a manifest can outlive what it points at. Rather than
/// showing dead links, the UI asks. Three things keep this from costing
/// anything the user would feel:
///
///   * the name index answers for free when it already holds the kind, so
///     a cluster you have browsed needs no requests at all;
///   * a miss costs one metadata-only GET — the smallest reply the API
///     server can send — and they run together;
///   * only a definite "not found" counts as missing. A forbidden or
///     unreachable answer leaves the link alone, because hiding it would
///     be claiming something we do not know.
pub async fn refs_exist(
    state: &AppState,
    context: String,
    refs: Vec<RefCheck>,
) -> Result<Vec<bool>, String> {
    use futures::StreamExt;
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let client = client(state, &context).await?;
    let known = state.names.read().await;
    let cached: Vec<Option<bool>> = refs
        .iter()
        .map(|r| {
            known
                .get(&name_key(&context, &r.resource))
                .map(|idx| idx.rows.iter().any(|(_, n)| n == &r.name))
                // Only a hit is trusted: the index can lag behind something
                // created a moment ago, and a stale miss would hide a link
                // that is really there.
                .filter(|hit| *hit)
        })
        .collect();
    drop(known);

    let total = refs.len();
    // Each future owns what it needs: borrowing from `refs` here makes the
    // closure too specific for the executor to accept.
    let checks = refs
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let client = client.clone();
            let cached = cached[i];
            async move {
                if let Some(hit) = cached {
                    return (i, hit);
                }
                let ar = api_resource(&r.resource);
                let api: Api<DynamicObject> = match (&r.namespace, r.resource.namespaced) {
                    (Some(ns), true) if !ns.is_empty() => {
                        Api::namespaced_with(client, ns, &ar)
                    }
                    _ => Api::all_with(client, &ar),
                };
                match api.get_metadata(&r.name).await {
                    Ok(_) => (i, true),
                    Err(kube::Error::Api(e)) if e.code == 404 => (i, false),
                    Err(_) => (i, true),
                }
            }
        })
        .collect::<Vec<_>>();
    let mut out = vec![true; total];
    let mut stream = futures::stream::iter(checks).buffer_unordered(8);
    while let Some((i, ok)) = stream.next().await {
        out[i] = ok;
    }
    Ok(out)
}

/// How many links one object may offer. A runaway manifest should not turn
/// the detail panel into a wall of guesses.
const RELATED_MAX: usize = 24;

/// Field names whose kind the convention does not spell out.
///
/// This is the whole vocabulary the scan trusts by name. An earlier version
/// also derived a kind from any key holding a `name` — which turned
/// `spec.containers`, `env` and `metadata` into "Containers", "Env" and
/// "Metadata". Those are dropped later for not being served, but they were
/// filling the link budget first and crowding out the real ones.
fn alias_kind(key: &str) -> Option<&'static str> {
    Some(match key {
        "secret" | "secretRef" | "secretKeyRef" | "secretName" | "tlsSecretName" => "Secret",
        "configMap" | "configMapRef" | "configMapKeyRef" | "configMapName" => "ConfigMap",
        "persistentVolumeClaim" | "claimName" | "persistentVolumeClaimName" => {
            "PersistentVolumeClaim"
        }
        "volumeName" | "persistentVolumeName" => "PersistentVolume",
        "serviceAccount" | "serviceAccountName" => "ServiceAccount",
        "service" | "serviceName" | "backendService" => "Service",
        "nodeName" => "Node",
        "priorityClassName" => "PriorityClass",
        "runtimeClassName" => "RuntimeClass",
        "ingressClassName" => "IngressClass",
        "storageClassName" => "StorageClass",
        "className" => "IngressClass",
        _ => return None,
    })
}

/// "secretRef" → Secret, "issuerRef" → Issuer, "configMap" → ConfigMap.
/// camelCase to PascalCase, with the reference suffix removed.
fn kind_from_key(key: &str) -> Option<String> {
    let base = key
        .strip_suffix("Reference")
        .or_else(|| key.strip_suffix("Ref"))
        .unwrap_or(key);
    if base.is_empty() || !base.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let mut cs = base.chars();
    let first = cs.next()?.to_ascii_uppercase();
    let derived: String = std::iter::once(first).chain(cs).collect();
    // A qualified name still points at the plain kind: cert-manager's
    // `passwordSecretRef` is a Secret, not a "PasswordSecret".
    for k in [
        "ServiceAccount",
        "ConfigMap",
        "Secret",
        "Service",
        "Namespace",
        "Node",
    ] {
        if derived.len() > k.len() && derived.ends_with(k) {
            return Some(k.to_string());
        }
    }
    Some(derived)
}

/// Walk a manifest for reference-shaped fields.
///
/// Two shapes carry almost every reference in the ecosystem:
///   * an object holding `name` (often with `kind`/`namespace`), reached
///     through a key that names what it points at — `secretRef`,
///     `issuerRef`, `configMap`, `scaleTargetRef`;
///   * a string field ending in `Name` — `secretName`, `serviceAccountName`.
///
/// Guessing wide is deliberate: an unserved kind is dropped by the caller,
/// so the cost of a wrong guess is nothing, while the cost of a missing
/// rule is a CRD nobody can navigate.
fn scan_refs(
    v: &serde_json::Value,
    key: &str,
    ns: &Option<String>,
    out: &mut Vec<InvolvedRef>,
) {
    if out.len() >= RELATED_MAX {
        return;
    }
    match v {
        serde_json::Value::Object(map) => {
            // Bookkeeping, not references — and managedFields is enormous.
            if matches!(key, "managedFields" | "labels" | "annotations" | "matchLabels") {
                return;
            }
            if let Some(name) = map.get("name").and_then(|n| n.as_str()) {
                // A reference either says what it points at, or is named
                // like one. Anything else holding a `name` is just an
                // object with a name.
                let kind = map
                    .get("kind")
                    .and_then(|k| k.as_str())
                    .filter(|k| !k.is_empty())
                    .map(String::from)
                    .or_else(|| alias_kind(key).map(String::from))
                    .or_else(|| {
                        (key.ends_with("Ref") || key.ends_with("Reference"))
                            .then(|| kind_from_key(key))
                            .flatten()
                    });
                if let Some(kind) = kind {
                    if !name.is_empty() && !kind.is_empty() {
                        out.push(InvolvedRef {
                            kind,
                            name: name.to_string(),
                            namespace: map
                                .get("namespace")
                                .and_then(|n| n.as_str())
                                .map(String::from)
                                .or_else(|| ns.clone()),
                        });
                    }
                }
            }
            for (k, child) in map {
                scan_refs(child, k, ns, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                scan_refs(item, key, ns, out);
            }
        }
        serde_json::Value::String(name) if !name.is_empty() => {
            // Only the known `*Name` fields. Deriving a kind from any of
            // them turns `generateName` into "Generate" and `hostName`
            // into "Host".
            if let Some(kind) = alias_kind(key).map(String::from) {
                out.push(InvolvedRef {
                    kind,
                    name: name.clone(),
                    namespace: ns.clone(),
                });
            }
        }
        _ => {}
    }
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

/// Server-side dry-run apply: runs the manifest through the API server
/// (validation, admission webhooks, defaulting, immutability, quota)
/// WITHOUT persisting, and returns the resulting object as YAML — the
/// GUI equivalent of `kubectl apply --dry-run=server`.
pub async fn dry_run_apply(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    name: String,
    yaml: String,
) -> Result<String, String> {
    require_namespace(&rt, &namespace)?;
    let value: serde_json::Value = serde_yaml::from_str(&yaml).map_err(err)?;
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, namespace.as_deref());
    let pp = |force: bool| PatchParams {
        dry_run: true,
        force,
        field_manager: Some("pigeoneye".into()),
        ..Default::default()
    };
    // Unforced first, because a field-ownership conflict is worth knowing
    // about: the real apply would hit it too. But refusing to preview at
    // all is the wrong answer — anything under a GitOps controller owns
    // fields, and those are exactly the objects worth previewing. So on a
    // conflict, force the dry run (nothing is written either way) and
    // carry the conflict into the preview instead of losing it.
    let (result, conflict): (DynamicObject, Option<String>) =
        match api.patch(&name, &pp(false), &Patch::Apply(&value)).await {
            Ok(r) => (r, None),
            Err(e) => {
                let msg = err(&e);
                if !msg.to_lowercase().contains("conflict") {
                    return Err(msg);
                }
                let forced = api
                    .patch(&name, &pp(true), &Patch::Apply(&value))
                    .await
                    .map_err(err)?;
                (forced, Some(msg))
            }
        };
    let mut v = serde_json::to_value(&result).map_err(err)?;
    // Trim the noise so the returned manifest reads like a desired state.
    if let Some(m) = v.pointer_mut("/metadata").and_then(|m| m.as_object_mut()) {
        for k in SERVER_MANAGED_META {
            m.remove(k);
        }
    }
    v.as_object_mut().map(|o| o.remove("status"));
    let yaml = serde_yaml::to_string(&v).map_err(err)?;
    Ok(match conflict {
        // A comment, so the body below is still the manifest the server
        // would produce — and still copyable as YAML.
        Some(c) => format!(
            "# previewed with force: another field manager owns some of\n             # these fields, so applying for real needs force too.\n             # {}\n\n{yaml}",
            c.replace('\n', " ").trim()
        ),
        None => yaml,
    })
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

fn pod_extra_of(obj: &serde_json::Value, key: &str) -> PodExtra {
    let phase = obj.pointer("/status/phase").and_then(|v| v.as_str()).unwrap_or("");
    PodExtra {
        node: obj
            .pointer("/spec/nodeName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        done: phase == "Succeeded" || phase == "Failed",
        exit: last_exit(obj, key),
    }
}

/// The newest container termination a pod records. `lastState.terminated`
/// stays until the next restart, so it still says why long after the event
/// that reported it has expired. Restartable init containers (sidecars)
/// count: they restart like any other.
fn last_exit(obj: &serde_json::Value, key: &str) -> Option<PodExit> {
    let mut best: Option<PodExit> = None;
    for list in ["/status/containerStatuses", "/status/initContainerStatuses"] {
        for c in obj.pointer(list).and_then(|v| v.as_array()).into_iter().flatten() {
            let Some(t) = c.pointer("/lastState/terminated") else {
                continue;
            };
            let at = t.get("finishedAt").and_then(|v| v.as_str()).map(String::from);
            // RFC 3339 in UTC sorts as text; an undated exit never beats a dated one.
            let newer = match (&best, &at) {
                (None, _) => true,
                (Some(b), Some(a)) => b.at.as_deref().is_none_or(|bt| a.as_str() > bt),
                (Some(_), None) => false,
            };
            if newer {
                best = Some(PodExit {
                    key: key.to_string(),
                    reason: t.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    code: t.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(0),
                    at,
                    container: c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                });
            }
        }
    }
    best
}

/// What each node has committed to the pods still running on it.
fn node_requests(
    res: &std::collections::HashMap<String, PodRes>,
    extra: &std::collections::HashMap<String, PodExtra>,
) -> std::collections::HashMap<String, NodeReq> {
    let mut out: std::collections::HashMap<String, NodeReq> = std::collections::HashMap::new();
    for (key, x) in extra {
        if x.done || x.node.is_empty() {
            continue; // finished, or not scheduled anywhere yet
        }
        let r = res.get(key).copied().unwrap_or_default();
        let n = out.entry(x.node.clone()).or_default();
        n.cpu_r += r.cpu_r;
        n.mem_r += r.mem_r;
        n.pods += 1;
    }
    out
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
    let selector = format!("involvedObject.name={name},involvedObject.kind={kind}");
    // Events for a cluster-scoped object (Node, PV, ClusterRole, a CRD…)
    // are created in the "default" namespace by convention — the event
    // recorder falls back to "default" when the involved object has no
    // namespace. So scope there instead of listing events cluster-wide,
    // which is what made a Node's events crawl (all-namespace event lists
    // are the slow case, cache or not). Namespaced objects keep their own ns.
    let base = match namespace.as_deref() {
        Some(ns) if !ns.is_empty() => format!("/api/v1/namespaces/{ns}/events"),
        _ => "/api/v1/namespaces/default/events".to_string(),
    };
    // resourceVersion=0 serves from the API server's watch cache instead of
    // a quorum read out of etcd; the events tail doesn't need to be
    // perfectly fresh.
    let url = format!(
        "{base}?fieldSelector={}&limit=100&resourceVersion=0",
        urlencode(&selector),
    );
    let req = http::Request::get(&url)
        .header(http::header::ACCEPT, "application/json")
        .body(Vec::new())
        .map_err(err)?;
    let list: serde_json::Value = client.request(req).await.map_err(err)?;
    let mut out: Vec<EventInfo> = list["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|v| {
                    let last = v["lastTimestamp"]
                        .as_str()
                        .or_else(|| v["eventTime"].as_str())
                        .or_else(|| {
                            v.pointer("/metadata/creationTimestamp").and_then(|t| t.as_str())
                        })
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
                .collect()
        })
        .unwrap_or_default();
    // newest first
    out.sort_by(|a, b| b.last.cmp(&a.last));
    Ok(out)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PodEvent {
    /// "namespace/name" of the pod the event is about.
    pub key: String,
    pub reason: String,
    pub message: String,
    /// Every time this reason was recorded against the pod, across all the
    /// event objects that carry it (see `PodEventIndex::summary`).
    pub count: i64,
    pub last: Option<String>,
    /// Written by the events.k8s.io recorder (the scheduler, among others),
    /// which records the first repeat at once but every later one only in a
    /// batch every 30 minutes — so its count and time can lag that long.
    pub series: bool,
}

/// One warning event object, reduced to what the column needs.
#[derive(Clone, Debug)]
struct EvRec {
    /// The event object's own ns/name — the tie-breaker between equal times.
    id: String,
    pod: String,
    reason: String,
    message: String,
    count: i64,
    last: Option<String>,
    series: bool,
}

fn ev_rec(id: String, v: &serde_json::Value) -> Option<EvRec> {
    let obj = &v["involvedObject"];
    let name = obj["name"].as_str().unwrap_or_default();
    if name.is_empty() {
        return None;
    }
    let ns = obj["namespace"]
        .as_str()
        .or_else(|| v.pointer("/metadata/namespace").and_then(|n| n.as_str()))
        .unwrap_or_default();
    // core/v1 Events count repeats in `count` and `lastTimestamp`. The
    // events.k8s.io recorder leaves both empty and keeps them in `series`
    // instead, with `eventTime` the FIRST occurrence.
    let series = v.get("series").filter(|s| s.is_object());
    Some(EvRec {
        id,
        pod: format!("{ns}/{name}"),
        reason: v["reason"].as_str().unwrap_or_default().to_string(),
        message: v["message"].as_str().unwrap_or_default().to_string(),
        count: series
            .and_then(|s| s["count"].as_i64())
            .or_else(|| v["count"].as_i64())
            .unwrap_or(1),
        last: series
            .and_then(|s| s["lastObservedTime"].as_str())
            .or_else(|| v["lastTimestamp"].as_str())
            .or_else(|| v["eventTime"].as_str())
            .or_else(|| v.pointer("/metadata/creationTimestamp").and_then(|t| t.as_str()))
            .map(String::from),
        series: series.is_some(),
    })
}

fn event_id(v: &serde_json::Value) -> Option<String> {
    let name = v.pointer("/metadata/name").and_then(|n| n.as_str())?;
    let ns = v.pointer("/metadata/namespace").and_then(|n| n.as_str()).unwrap_or_default();
    Some(format!("{ns}/{name}"))
}

/// Every live warning event object, and what each pod's adds up to.
///
/// Kubernetes splits one pod's repeats of a reason across several event
/// objects — a new object, counting from one again, whenever the message
/// changes even slightly ("0/50 nodes are available" becoming "0/51"). So a
/// pod that failed to schedule a hundred thousand times can have its newest
/// object at ×7. The summary takes the reason from the newest object and the
/// count from all of that reason's objects together.
#[derive(Default)]
pub struct PodEventIndex {
    recs: std::collections::HashMap<String, EvRec>,
    by_pod: std::collections::HashMap<String, std::collections::BTreeSet<String>>,
}

impl PodEventIndex {
    /// Add or replace an event object; returns the pod(s) whose summary may
    /// have changed.
    fn upsert(&mut self, id: String, v: &serde_json::Value) -> Vec<String> {
        let mut touched = Vec::new();
        if let Some(old) = self.recs.remove(&id) {
            self.unlink(&old);
            touched.push(old.pod);
        }
        if let Some(rec) = ev_rec(id.clone(), v) {
            self.by_pod.entry(rec.pod.clone()).or_default().insert(id.clone());
            if touched.first() != Some(&rec.pod) {
                touched.push(rec.pod.clone());
            }
            self.recs.insert(id, rec);
        }
        touched
    }

    fn remove(&mut self, id: &str) -> Option<String> {
        let old = self.recs.remove(id)?;
        self.unlink(&old);
        Some(old.pod)
    }

    fn unlink(&mut self, rec: &EvRec) {
        if let Some(set) = self.by_pod.get_mut(&rec.pod) {
            set.remove(&rec.id);
            if set.is_empty() {
                self.by_pod.remove(&rec.pod);
            }
        }
    }

    fn summary(&self, pod: &str) -> Option<PodEvent> {
        let recs: Vec<&EvRec> = self.by_pod.get(pod)?.iter().filter_map(|id| self.recs.get(id)).collect();
        // Timestamps are RFC 3339 in UTC, so they compare as strings; an
        // undated event loses to any dated one (None < Some).
        let newest = recs.iter().max_by(|a, b| a.last.cmp(&b.last).then_with(|| a.id.cmp(&b.id)))?;
        let same = recs.iter().filter(|r| r.reason == newest.reason);
        let (count, series) = same.fold((0, false), |(c, s), r| (c + r.count, s || r.series));
        Some(PodEvent {
            key: pod.to_string(),
            reason: newest.reason.clone(),
            message: newest.message.clone(),
            count,
            last: newest.last.clone(),
            series,
        })
    }

    fn snapshot(&self) -> Vec<PodEvent> {
        let mut out: Vec<PodEvent> = self.by_pod.keys().filter_map(|p| self.summary(p)).collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }
}

/// One summary per pod out of a raw event list.
#[cfg(test)]
fn newest_per_pod(items: &[serde_json::Value]) -> Vec<PodEvent> {
    let mut idx = PodEventIndex::default();
    for (i, v) in items.iter().enumerate() {
        idx.upsert(event_id(v).unwrap_or_else(|| format!("#{i}")), v);
    }
    idx.snapshot()
}

/// How the Recent event watch paces itself; tests run it faster.
#[derive(Clone, Copy)]
pub struct EvWatchTiming {
    /// At most one batch of changes to the screen this often: each one
    /// rebuilds the display rows, and on a busy cluster something changes
    /// every second.
    pub flush: std::time::Duration,
    /// Changes that arrive together go out together.
    pub debounce: std::time::Duration,
    pub backoff_min: std::time::Duration,
    pub backoff_max: std::time::Duration,
    /// How long the server holds each watch before it is re-opened.
    pub watch_secs: u32,
}

pub const EV_TIMING: EvWatchTiming = EvWatchTiming {
    flush: std::time::Duration::from_secs(10),
    debounce: std::time::Duration::from_millis(500),
    backoff_min: std::time::Duration::from_secs(5),
    backoff_max: std::time::Duration::from_secs(60),
    watch_secs: 290,
};

/// The selector the whole feature rests on. Only warnings, for two reasons.
/// Events expire after an hour by default, so the Normal ones (Scheduled,
/// Pulled, Started) are gone from every pod that has been up a while — a
/// column of them would be blank for most of the list anyway, and
/// arbitrarily so. And the column is for the pod that did NOT come up:
/// FailedScheduling, FailedMount, Unhealthy, BackOff. An empty cell then
/// means "nothing is wrong", which is what makes it worth scanning.
const POD_WARNINGS: &str = "involvedObject.kind=Pod,type=Warning";

fn events_base(namespace: Option<&str>) -> String {
    match namespace {
        Some(ns) if !ns.is_empty() => format!("/api/v1/namespaces/{ns}/events"),
        _ => "/api/v1/events".to_string(),
    }
}

/// Every warning event, page by page. A single page of 500 was what this
/// once read, and on a cluster with a few thousand warnings that left most
/// pods' warnings out — alphabetically by namespace, so whole teams saw none.
/// resourceVersion=0 serves the first page from the API server's watch cache
/// rather than a quorum read out of etcd.
async fn list_pod_warnings(
    client: &Client,
    base: &str,
) -> Result<(Vec<serde_json::Value>, String), String> {
    let fields = urlencode(POD_WARNINGS);
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    let mut rv = String::new();
    loop {
        let url = match &token {
            None => format!("{base}?fieldSelector={fields}&limit=500&resourceVersion=0"),
            Some(t) => format!("{base}?fieldSelector={fields}&limit=500&continue={}", urlencode(t)),
        };
        let req = http::Request::get(&url)
            .header(http::header::ACCEPT, "application/json")
            .body(Vec::new())
            .map_err(err)?;
        let mut page: serde_json::Value = client.request(req).await.map_err(err)?;
        if let Some(a) = page.get_mut("items").and_then(|a| a.as_array_mut()) {
            items.append(a);
        }
        if let Some(v) = page.pointer("/metadata/resourceVersion").and_then(|v| v.as_str()) {
            rv = v.to_string();
        }
        token = page
            .pointer("/metadata/continue")
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
            .map(String::from);
        if token.is_none() || items.len() > 500_000 {
            break;
        }
    }
    Ok((items, rv))
}

/// What changed since the last batch, as the screen wants it.
fn ev_flush(
    idx: &PodEventIndex,
    sent: &mut std::collections::HashMap<String, PodEvent>,
    dirty: &mut std::collections::HashSet<String>,
) -> Option<serde_json::Value> {
    let mut events = Vec::new();
    let mut removed = Vec::new();
    for pod in dirty.drain() {
        match idx.summary(&pod) {
            Some(s) if sent.get(&pod) != Some(&s) => {
                sent.insert(pod, s.clone());
                events.push(s);
            }
            Some(_) => {}
            None => {
                if sent.remove(&pod).is_some() {
                    removed.push(pod);
                }
            }
        }
    }
    if events.is_empty() && removed.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "type": "DELTA", "events": events, "removed": removed }))
}

/// The Recent event column's feed for one pod list: the whole warning list
/// once, then only what changes, for as long as the list is open.
///
/// Sends SNAPSHOT (everything, replacing what was there), DELTA (changed and
/// removed pods) and ERROR. Everything it asks of the API server goes through
/// the cluster's gate, and a broken credential ends it: re-opening the watch
/// would run the credential helper again, which can open a browser.
async fn run_pod_events_watch(
    client: Client,
    gate: std::sync::Arc<CredGate>,
    namespace: Option<String>,
    t: EvWatchTiming,
    out: impl Fn(serde_json::Value) -> bool,
) {
    use futures::AsyncBufReadExt;
    use futures::StreamExt;
    let base = events_base(namespace.as_deref());
    let fields = urlencode(POD_WARNINGS);
    let mut backoff = t.backoff_min;
    // Says so and reports whether to carry on: never after a broken
    // credential, nor once nobody is listening.
    let failed = |e: String| -> bool {
        let cred = is_credential_failure(&e);
        out(serde_json::json!({ "type": "ERROR", "error": e })) && !cred
    };
    'relist: loop {
        let (items, mut rv) = match in_background(gate.clone(), list_pod_warnings(&client, &base)).await {
            Ok(x) => x,
            Err(e) => {
                if !failed(e) {
                    return;
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(t.backoff_max);
                continue 'relist;
            }
        };
        let mut idx = PodEventIndex::default();
        for (i, v) in items.iter().enumerate() {
            idx.upsert(event_id(v).unwrap_or_else(|| format!("#{i}")), v);
        }
        drop(items);
        let snapshot = idx.snapshot();
        let mut sent: std::collections::HashMap<String, PodEvent> =
            snapshot.iter().map(|e| (e.key.clone(), e.clone())).collect();
        if !out(serde_json::json!({ "type": "SNAPSHOT", "events": snapshot })) {
            return;
        }
        backoff = t.backoff_min;
        let mut dirty: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut dirty_since: Option<tokio::time::Instant> = None;
        let mut last_flush = tokio::time::Instant::now();
        loop {
            let url = format!(
                "{base}?watch=1&fieldSelector={fields}&resourceVersion={}&timeoutSeconds={}&allowWatchBookmarks=true",
                urlencode(&rv),
                t.watch_secs
            );
            let req = match http::Request::get(&url)
                .header(http::header::ACCEPT, "application/json")
                .body(Vec::new())
            {
                Ok(r) => r,
                Err(e) => {
                    failed(err(e));
                    return;
                }
            };
            let stream = match in_background(gate.clone(), async { client.request_stream(req).await.map_err(err) }).await {
                Ok(s) => s,
                Err(e) => {
                    if !failed(e) {
                        return;
                    }
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(t.backoff_max);
                    continue 'relist;
                }
            };
            let mut lines = Box::pin(stream).lines();
            loop {
                let deadline = dirty_since.map(|d| (d + t.debounce).max(last_flush + t.flush));
                tokio::select! {
                    line = lines.next() => {
                        let Some(Ok(line)) = line else { break }; // closed: re-open from rv
                        let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                        let obj = &ev["object"];
                        if let Some(v) = obj.pointer("/metadata/resourceVersion").and_then(|v| v.as_str()) {
                            if !v.is_empty() {
                                rv = v.to_string();
                            }
                        }
                        let touched = match ev["type"].as_str().unwrap_or_default() {
                            "ADDED" | "MODIFIED" => match event_id(obj) {
                                Some(id) => idx.upsert(id, obj),
                                None => Vec::new(),
                            },
                            "DELETED" => event_id(obj).and_then(|id| idx.remove(&id)).into_iter().collect(),
                            // Usually 410 Gone: too far behind to resume. Start over;
                            // the fresh SNAPSHOT replaces whatever was shown.
                            "ERROR" => continue 'relist,
                            _ => Vec::new(), // BOOKMARK: only the version moves
                        };
                        if !touched.is_empty() {
                            dirty.extend(touched);
                            dirty_since.get_or_insert_with(tokio::time::Instant::now);
                        }
                    }
                    _ = tokio::time::sleep_until(deadline.unwrap_or_else(tokio::time::Instant::now)), if deadline.is_some() => {
                        if let Some(msg) = ev_flush(&idx, &mut sent, &mut dirty) {
                            if !out(msg) {
                                return;
                            }
                        }
                        dirty_since = None;
                        last_flush = tokio::time::Instant::now();
                    }
                }
            }
        }
    }
}

/// Start the Recent event feed for a pod list; stop it with watch_stop.
pub async fn pod_events_watch(
    state: &AppState,
    context: String,
    namespace: Option<String>,
    channel: Channel<serde_json::Value>,
) -> Result<u32, String> {
    let client = client(state, &context).await?;
    let gate = cred_gate(state, &context);
    let ns = namespace.filter(|n| !n.is_empty());
    let task = tokio::spawn(run_pod_events_watch(client, gate, ns, EV_TIMING, move |v| {
        channel.send(v).is_ok()
    }));
    let id = state.next_exec.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.watches.write().await.insert(id, task.abort_handle());
    Ok(id)
}

#[cfg(test)]
mod pod_event_tests {
    use super::newest_per_pod;
    use serde_json::json;

    fn ev(ns: &str, name: &str, reason: &str, last: Option<&str>) -> serde_json::Value {
        let mut v = json!({
            "involvedObject": {"kind": "Pod", "name": name, "namespace": ns},
            "reason": reason,
            "message": format!("{reason} happened"),
            "count": 1,
        });
        if let Some(t) = last {
            v["lastTimestamp"] = json!(t);
        }
        v
    }

    fn obj(name: &str, pod: &str, reason: &str, message: &str, count: i64, last: &str) -> serde_json::Value {
        json!({
            "metadata": {"name": name, "namespace": "sre"},
            "involvedObject": {"kind": "Pod", "name": pod, "namespace": "sre"},
            "reason": reason, "message": message, "count": count, "lastTimestamp": last,
        })
    }

    /// Seen on a real cluster: one pod, one reason, a dozen objects — a new
    /// one whenever the message changes — each counting from one again.
    #[test]
    fn a_reason_split_across_objects_counts_them_all() {
        let out = newest_per_pod(&[
            obj("e1", "a", "FailedScheduling", "0/50 nodes are available", 95_553, "2026-11-09T02:00:00Z"),
            obj("e2", "a", "FailedScheduling", "0/51 nodes are available", 11_642, "2026-11-09T02:58:00Z"),
            obj("e3", "a", "FailedScheduling", "0/52 nodes are available", 7, "2026-11-09T02:57:00Z"),
            obj("e4", "a", "FailedMount", "volume not attached", 3, "2026-11-09T01:00:00Z"),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reason, "FailedScheduling");
        assert_eq!(out[0].count, 95_553 + 11_642 + 7, "not the newest object's own count");
        assert_eq!(out[0].message, "0/51 nodes are available", "the newest object's message");
        assert_eq!(out[0].last.as_deref(), Some("2026-11-09T02:58:00Z"));
    }

    #[test]
    fn the_newest_reason_decides_and_only_its_count_counts() {
        let out = newest_per_pod(&[
            obj("e1", "a", "FailedScheduling", "m", 500, "2026-11-09T01:00:00Z"),
            obj("e2", "a", "BackOff", "m", 4, "2026-11-09T02:00:00Z"),
        ]);
        assert_eq!((out[0].reason.as_str(), out[0].count), ("BackOff", 4));
    }

    #[test]
    fn the_index_follows_changes_and_removals() {
        let mut idx = super::PodEventIndex::default();
        let e1 = obj("e1", "a", "Unhealthy", "probe", 3, "2026-11-09T01:00:00Z");
        assert_eq!(idx.upsert("sre/e1".into(), &e1), vec!["sre/a".to_string()]);
        let e1b = obj("e1", "a", "Unhealthy", "probe", 9, "2026-11-09T01:05:00Z");
        idx.upsert("sre/e1".into(), &e1b);
        assert_eq!(idx.summary("sre/a").unwrap().count, 9, "a MODIFIED replaces, it does not add");
        assert_eq!(idx.remove("sre/e1"), Some("sre/a".to_string()));
        assert!(idx.summary("sre/a").is_none());
        assert!(idx.snapshot().is_empty());
    }

    /// What the scheduler writes for a pod it keeps failing to place.
    fn series_ev(ns: &str, name: &str, first: &str, count: i64, last: &str) -> serde_json::Value {
        json!({
            "involvedObject": {"kind": "Pod", "name": name, "namespace": ns},
            "reason": "FailedScheduling",
            "message": "0/50 nodes are available: insufficient cpu.",
            "eventTime": first,
            "series": {"count": count, "lastObservedTime": last},
        })
    }

    #[test]
    fn a_series_reads_its_count_and_latest_time() {
        let out = newest_per_pod(&[series_ev(
            "sre", "a", "2026-11-09T01:00:00.000000Z", 14, "2026-11-09T02:30:00.000000Z",
        )]);
        assert_eq!(out[0].count, 14, "not the 1 the empty `count` field implies");
        assert_eq!(out[0].last.as_deref(), Some("2026-11-09T02:30:00.000000Z"), "not when it first happened");
        assert!(out[0].series);
    }

    #[test]
    fn a_new_style_event_that_happened_once_is_still_one() {
        let mut v = series_ev("sre", "a", "2026-11-09T01:00:00.000000Z", 0, "");
        v.as_object_mut().unwrap().remove("series");
        let out = newest_per_pod(&[v]);
        assert_eq!((out[0].count, out[0].series), (1, false));
        assert_eq!(out[0].last.as_deref(), Some("2026-11-09T01:00:00.000000Z"));
    }

    #[test]
    fn a_series_competes_by_its_latest_time() {
        // First seen long ago, still going: newer than a one-off from in between.
        let out = newest_per_pod(&[
            series_ev("sre", "a", "2026-11-09T00:00:00.000000Z", 30, "2026-11-09T03:00:00.000000Z"),
            ev("sre", "a", "FailedMount", Some("2026-11-09T01:00:00Z")),
        ]);
        assert_eq!(out[0].reason, "FailedScheduling");
    }

    #[test]
    fn keeps_the_newest_per_pod() {
        let out = newest_per_pod(&[
            ev("sre", "a", "FailedScheduling", Some("2026-10-27T01:00:00Z")),
            ev("sre", "a", "Preempted", Some("2026-10-27T01:05:00Z")),
            ev("sre", "a", "FailedMount", Some("2026-10-27T00:10:00Z")),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].reason, "Preempted");
        assert_eq!(out[0].key, "sre/a");
    }

    #[test]
    fn arrival_order_does_not_decide() {
        let newest = Some("2026-10-27T09:00:00Z");
        let older = Some("2026-10-27T08:00:00Z");
        for pair in [[newest, older], [older, newest]] {
            let out = newest_per_pod(&[
                ev("sre", "a", "New", pair[0]),
                ev("sre", "a", "Old", pair[1]),
            ]);
            let want = if pair[0] == newest { "New" } else { "Old" };
            assert_eq!(out[0].reason, want);
        }
    }

    #[test]
    fn separates_same_name_in_different_namespaces() {
        let out = newest_per_pod(&[
            ev("one", "a", "FailedScheduling", Some("2026-10-27T01:00:00Z")),
            ev("two", "a", "Unhealthy", Some("2026-10-27T01:00:00Z")),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].key, "one/a");
        assert_eq!(out[1].key, "two/a");
    }

    #[test]
    fn a_timestamped_event_beats_an_undated_one() {
        let out = newest_per_pod(&[
            ev("sre", "a", "Undated", None),
            ev("sre", "a", "Dated", Some("2026-10-27T01:00:00Z")),
        ]);
        assert_eq!(out[0].reason, "Dated");
    }

    #[test]
    fn falls_back_to_event_time() {
        let mut v = ev("sre", "a", "Newer", None);
        v["eventTime"] = json!("2026-10-27T02:00:00Z");
        let out = newest_per_pod(&[ev("sre", "a", "Older", Some("2026-10-27T01:00:00Z")), v]);
        assert_eq!(out[0].reason, "Newer");
    }

    #[test]
    fn skips_an_event_with_no_involved_pod() {
        assert!(newest_per_pod(&[ev("sre", "", "Orphan", Some("2026-10-27T01:00:00Z"))]).is_empty());
    }
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

#[derive(Serialize, Clone)]
pub struct NodeStat {
    pub name: String,
    pub cpu: i64, // millicores used
    pub mem: i64, // bytes used
    pub cpu_pct: i64, // % of allocatable
    pub mem_pct: i64,
}

/// `kubectl top nodes`: live per-node CPU/MEM usage from
/// metrics.k8s.io, plus % of each node's allocatable.
pub async fn node_stats(state: &AppState, context: String) -> Result<Vec<NodeStat>, String> {
    let client = client(state, &context).await?;
    // Allocatable per node (for the %).
    let node_ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("", "v1", "Node"));
    let nodes: Api<DynamicObject> = Api::all_with(client.clone(), &node_ar);
    let mut alloc: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    if let Ok(list) = nodes.list(&ListParams::default()).await {
        let mut read = std::collections::HashMap::new();
        for n in &list.items {
            let name = n.metadata.name.clone().unwrap_or_default();
            let v = serde_json::to_value(n).unwrap_or_default();
            let (ca, ma, pa) = allocatable_of(&v);
            alloc.insert(name.clone(), (ca, ma));
            read.insert(name, (ca, ma, pa));
        }
        state.node_alloc.write().await.insert(
            context.clone(),
            NodeAllocRead { at: std::time::Instant::now(), nodes: read },
        );
    }
    let nm_ar = KubeApiResource {
        group: "metrics.k8s.io".into(),
        version: "v1beta1".into(),
        api_version: "metrics.k8s.io/v1beta1".into(),
        kind: "NodeMetrics".into(),
        plural: "nodes".into(),
    };
    let api: Api<DynamicObject> = Api::all_with(client, &nm_ar);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| format!("metrics API unavailable: {e}"))?;
    Ok(list
        .items
        .iter()
        .map(|m| {
            let name = m.metadata.name.clone().unwrap_or_default();
            let v = serde_json::to_value(m).unwrap_or_default();
            let cpu = parse_cpu(v.pointer("/usage/cpu").and_then(|x| x.as_str()).unwrap_or(""));
            let mem = parse_mem(v.pointer("/usage/memory").and_then(|x| x.as_str()).unwrap_or(""));
            let (ca, ma) = alloc.get(&name).copied().unwrap_or((0, 0));
            NodeStat {
                name,
                cpu,
                mem,
                cpu_pct: if ca > 0 { cpu * 100 / ca } else { 0 },
                mem_pct: if ma > 0 { mem * 100 / ma } else { 0 },
            }
        })
        .collect())
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

fn allocatable_of(node: &serde_json::Value) -> (i64, i64, i64) {
    let q = |k: &str| {
        node.pointer(&format!("/status/allocatable/{k}"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
    };
    (parse_cpu(q("cpu")), parse_mem(q("memory")), q("pods").parse().unwrap_or(0))
}

/// The pod list's restart reasons, straight from the background index — no
/// request of its own. None until that index has finished for this list.
pub async fn pod_exits(
    state: &AppState,
    context: String,
    namespace: Option<String>,
) -> Result<Option<Vec<PodExit>>, String> {
    let s = state.search.read().await;
    let Some((ctx, rt, ns, _)) = &s.source else {
        return Ok(None);
    };
    let norm = |n: &Option<String>| n.clone().filter(|x| !x.is_empty());
    let same = ctx == &context && rt.group.is_empty() && rt.kind == "Pod" && norm(ns) == norm(&namespace);
    if !same || !s.indexed {
        return Ok(None);
    }
    Ok(Some(s.pod_extra.values().filter_map(|x| x.exit.clone()).collect()))
}

/// Re-read just the pods whose restart count went up since the index saw
/// them — one GET each, a handful at a time. Stops at the first broken
/// credential: every further GET would run the helper again.
pub async fn pod_exits_refresh(
    state: &AppState,
    context: String,
    keys: Vec<String>,
) -> Result<Vec<PodExit>, String> {
    let client = client(state, &context).await?;
    in_background(cred_gate(state, &context), refresh_exits(state, client, context, keys)).await
}

async fn refresh_exits(
    state: &AppState,
    client: Client,
    context: String,
    keys: Vec<String>,
) -> Result<Vec<PodExit>, String> {
    let mut out = Vec::new();
    for key in keys.into_iter().take(20) {
        let Some((ns, name)) = key.split_once('/') else {
            continue;
        };
        let api: Api<K8sPod> = Api::namespaced(client.clone(), ns);
        match api.get_opt(name).await {
            Ok(Some(p)) => {
                let v = serde_json::to_value(&p).map_err(err)?;
                let exit = last_exit(&v, &key);
                // Keep the index in step, so the next read of it agrees.
                let mut s = state.search.write().await;
                if s.source.as_ref().is_some_and(|src| src.0 == context) {
                    if let Some(x) = s.pod_extra.get_mut(&key) {
                        x.exit = exit.clone();
                    }
                }
                drop(s);
                out.extend(exit);
            }
            Ok(None) => {} // gone since; the list will drop it
            Err(e) => {
                let msg = err(e);
                if is_credential_failure(&msg) {
                    return Err(msg);
                }
            }
        }
    }
    Ok(out)
}

/// What kind of machine a node is, from the labels the cloud and the
/// autoscaler put on it. Empty fields where a cluster sets none.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct NodeType {
    pub name: String,
    pub instance: String,
    /// "spot", "on-demand", … — one spelling whichever label carried it.
    pub capacity: String,
    pub zone: String,
    pub pool: String,
}

fn node_type(name: &str, labels: &std::collections::BTreeMap<String, String>) -> NodeType {
    let first = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| labels.get(*k).filter(|v| !v.is_empty()))
            .cloned()
            .unwrap_or_default()
    };
    let is = |k: &str, v: &str| labels.get(k).is_some_and(|x| x.eq_ignore_ascii_case(v));
    let capacity = if let Some(c) = labels.get("karpenter.sh/capacity-type") {
        c.clone()
    } else if let Some(c) = labels.get("eks.amazonaws.com/capacityType") {
        c.to_ascii_lowercase().replace('_', "-") // SPOT, ON_DEMAND
    } else if is("cloud.google.com/gke-spot", "true") || is("kubernetes.azure.com/scalesetpriority", "spot") {
        "spot".into()
    } else if is("cloud.google.com/gke-preemptible", "true") {
        "preemptible".into()
    } else {
        String::new()
    };
    NodeType {
        name: name.to_string(),
        instance: first(&["node.kubernetes.io/instance-type", "beta.kubernetes.io/instance-type"]),
        capacity,
        zone: first(&["topology.kubernetes.io/zone", "failure-domain.beta.kubernetes.io/zone"]),
        pool: first(&[
            "karpenter.sh/nodepool",
            "karpenter.sh/provisioner-name",
            "eks.amazonaws.com/nodegroup",
            "cloud.google.com/gke-nodepool",
            "kubernetes.azure.com/agentpool",
            "agentpool",
        ]),
    }
}

/// Every node's type, for the pod list. Metadata only — labels are all this
/// needs, and they are a small fraction of a node object.
pub async fn node_types(state: &AppState, context: String) -> Result<Vec<NodeType>, String> {
    let client = client(state, &context).await?;
    let api: Api<k8s_openapi::api::core::v1::Node> = Api::all(client);
    let list = in_background(cred_gate(state, &context), async {
        api.list_metadata(&ListParams::default()).await.map_err(err)
    })
    .await?;
    Ok(list
        .items
        .iter()
        .map(|n| {
            let labels = n.metadata.labels.clone().unwrap_or_default();
            node_type(&n.metadata.name.clone().unwrap_or_default(), &labels)
        })
        .collect())
}

#[derive(Serialize)]
pub struct NodeRoom {
    pub name: String,
    pub cpu_alloc: i64,
    pub mem_alloc: i64,
    pub pods_alloc: i64,
    pub cpu_r: i64,
    pub mem_r: i64,
    pub pods: u32,
}

#[derive(Serialize)]
pub struct NodeRooms {
    /// How old the pod pass behind the sums is.
    pub age_secs: u64,
    pub nodes: Vec<NodeRoom>,
}

/// Requested vs allocatable per node, for the node list. The requests come
/// from the last whole-cluster pod index rather than a fetch of their own —
/// summing them fresh would mean pulling every pod object, which on a large
/// cluster is the one request this app exists to avoid. None when there is
/// no such index yet, and then not a single request is made.
pub async fn node_rooms(state: &AppState, context: String) -> Result<Option<NodeRooms>, String> {
    let Some(h) = state.search.read().await.node_req.get(&context).cloned() else {
        return Ok(None);
    };
    let fresh = state
        .node_alloc
        .read()
        .await
        .get(&context)
        .filter(|r| r.at.elapsed().as_secs() < 300)
        .cloned();
    let alloc = match fresh {
        Some(r) => r.nodes,
        None => {
            let client = client(state, &context).await?;
            let api: Api<k8s_openapi::api::core::v1::Node> = Api::all(client);
            let list = in_background(cred_gate(state, &context), async {
                api.list(&ListParams::default()).await.map_err(err)
            })
            .await?;
            let mut read = std::collections::HashMap::new();
            for n in &list.items {
                let v = serde_json::to_value(n).unwrap_or_default();
                read.insert(n.metadata.name.clone().unwrap_or_default(), allocatable_of(&v));
            }
            state.node_alloc.write().await.insert(
                context.clone(),
                NodeAllocRead { at: std::time::Instant::now(), nodes: read.clone() },
            );
            read
        }
    };
    let nodes = alloc
        .iter()
        .map(|(name, &(cpu_alloc, mem_alloc, pods_alloc))| {
            let r = h.nodes.get(name).copied().unwrap_or_default();
            NodeRoom {
                name: name.clone(),
                cpu_alloc,
                mem_alloc,
                pods_alloc,
                cpu_r: r.cpu_r,
                mem_r: r.mem_r,
                pods: r.pods,
            }
        })
        .collect();
    Ok(Some(NodeRooms { age_secs: h.at.elapsed().as_secs(), nodes }))
}

#[derive(Serialize)]
pub struct NodeAllocated {
    pub cpu_alloc: i64,
    pub mem_alloc: i64,
    pub pods_alloc: i64,
    pub cpu_r: i64,
    pub cpu_l: i64,
    pub mem_r: i64,
    pub mem_l: i64,
    pub pods: u32,
}

/// `kubectl describe node`'s "Allocated resources", for one node: its pods
/// only, so it is exact and current at the cost of one small list.
pub async fn node_allocated(
    state: &AppState,
    context: String,
    node: String,
) -> Result<NodeAllocated, String> {
    let client = client(state, &context).await?;
    let nodes: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let n = nodes.get(&node).await.map_err(err)?;
    let (cpu_alloc, mem_alloc, pods_alloc) =
        allocatable_of(&serde_json::to_value(&n).unwrap_or_default());
    let pods: Api<K8sPod> = Api::all(client);
    let lp = ListParams::default().fields(&format!(
        "spec.nodeName={node},status.phase!=Succeeded,status.phase!=Failed"
    ));
    let list = pods.list(&lp).await.map_err(err)?;
    let mut out = NodeAllocated {
        cpu_alloc,
        mem_alloc,
        pods_alloc,
        cpu_r: 0,
        cpu_l: 0,
        mem_r: 0,
        mem_l: 0,
        pods: 0,
    };
    for p in &list.items {
        let r = pod_resources(&serde_json::to_value(p).unwrap_or_default());
        out.cpu_r += r.cpu_r;
        out.cpu_l += r.cpu_l;
        out.mem_r += r.mem_r;
        out.mem_l += r.mem_l;
        out.pods += 1;
    }
    Ok(out)
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

#[derive(Serialize)]
pub struct Revision {
    pub revision: i64,
    pub name: String,
    pub images: Vec<String>,
    pub created: Option<String>,
    pub current: bool,
}

/// Revision history of a Deployment (from its ReplicaSets), newest
/// first — like `kubectl rollout history`.
pub async fn rollout_history(
    state: &AppState,
    context: String,
    namespace: Option<String>,
    name: String,
) -> Result<Vec<Revision>, String> {
    let ns = namespace.filter(|n| !n.is_empty()).ok_or("needs a namespace")?;
    let client = client(state, &context).await?;
    let dep_ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("apps", "v1", "Deployment"));
    let dep = Api::<DynamicObject>::namespaced_with(client.clone(), &ns, &dep_ar)
        .get(&name)
        .await
        .map_err(err)?;
    let dv = serde_json::to_value(&dep).map_err(err)?;
    let cur_rev = dv
        .pointer("/metadata/annotations/deployment.kubernetes.io~1revision")
        .and_then(|r| r.as_str())
        .and_then(|s| s.parse::<i64>().ok());
    let rs_ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("apps", "v1", "ReplicaSet"));
    let rs_list = Api::<DynamicObject>::namespaced_with(client, &ns, &rs_ar)
        .list(&ListParams::default())
        .await
        .map_err(err)?;
    let mut out: Vec<Revision> = rs_list
        .items
        .iter()
        .filter(|rs| {
            rs.metadata
                .owner_references
                .as_ref()
                .map(|o| o.iter().any(|r| r.kind == "Deployment" && r.name == name))
                .unwrap_or(false)
        })
        .filter_map(|rs| {
            let v = serde_json::to_value(rs).ok()?;
            let revision = v
                .pointer("/metadata/annotations/deployment.kubernetes.io~1revision")
                .and_then(|r| r.as_str())
                .and_then(|s| s.parse::<i64>().ok())?;
            let images = v
                .pointer("/spec/template/spec/containers")
                .and_then(|c| c.as_array())
                .map(|cs| {
                    cs.iter()
                        .filter_map(|c| c.get("image").and_then(|i| i.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Some(Revision {
                revision,
                name: rs.metadata.name.clone().unwrap_or_default(),
                images,
                created: v
                    .pointer("/metadata/creationTimestamp")
                    .and_then(|t| t.as_str())
                    .map(String::from),
                current: Some(revision) == cur_rev,
            })
        })
        .collect();
    out.sort_by(|a, b| b.revision.cmp(&a.revision));
    Ok(out)
}

/// Roll a Deployment back to a prior revision's pod template — like
/// `kubectl rollout undo`. Patches spec.template from the target
/// ReplicaSet (the pod-template-hash label stripped so the controller
/// recomputes it).
pub async fn rollout_undo(
    state: &AppState,
    context: String,
    namespace: Option<String>,
    name: String,
    rs_name: String,
) -> Result<(), String> {
    let ns = namespace.filter(|n| !n.is_empty()).ok_or("needs a namespace")?;
    let client = client(state, &context).await?;
    let rs_ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("apps", "v1", "ReplicaSet"));
    let rs = Api::<DynamicObject>::namespaced_with(client.clone(), &ns, &rs_ar)
        .get(&rs_name)
        .await
        .map_err(err)?;
    let rv = serde_json::to_value(&rs).map_err(err)?;
    let mut template = rv
        .pointer("/spec/template")
        .cloned()
        .ok_or("that revision has no pod template")?;
    if let Some(labels) = template
        .pointer_mut("/metadata/labels")
        .and_then(|l| l.as_object_mut())
    {
        labels.remove("pod-template-hash");
    }
    let patch = serde_json::json!({ "spec": { "template": template } });
    let dep_ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("apps", "v1", "Deployment"));
    // Strategic merge (kubectl's mechanism) so fields the current template
    // added since the target revision are reconciled away, not left behind
    // as a JSON merge-patch would.
    Api::<DynamicObject>::namespaced_with(client, &ns, &dep_ar)
        .patch(&name, &PatchParams::default(), &Patch::Strategic(patch))
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

/// `kubectl auth can-i` for a set of verbs on one resource kind, via
/// SelfSubjectAccessReview. Returns (verb, allowed) for each.
pub async fn can_i(
    state: &AppState,
    context: String,
    group: String,
    resource: String,
    namespace: Option<String>,
    verbs: Vec<String>,
) -> Result<Vec<(String, bool)>, String> {
    let client = client(state, &context).await?;
    let ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk(
        "authorization.k8s.io",
        "v1",
        "SelfSubjectAccessReview",
    ));
    let api: Api<DynamicObject> = Api::all_with(client, &ar);
    let mut out = Vec::new();
    for verb in verbs {
        let mut ra = serde_json::json!({
            "group": group, "resource": resource, "verb": verb,
        });
        if let Some(ns) = namespace.as_deref().filter(|n| !n.is_empty()) {
            ra["namespace"] = ns.into();
        }
        let review = serde_json::json!({
            "apiVersion": "authorization.k8s.io/v1",
            "kind": "SelfSubjectAccessReview",
            "spec": { "resourceAttributes": ra },
        });
        let obj: DynamicObject = serde_json::from_value(review).map_err(err)?;
        let created = api.create(&PostParams::default(), &obj).await.map_err(err)?;
        let allowed = serde_json::to_value(&created)
            .ok()
            .and_then(|v| v.pointer("/status/allowed").and_then(|a| a.as_bool()))
            .unwrap_or(false);
        out.push((verb, allowed));
    }
    Ok(out)
}

/// Generic merge-patch — drives suspend/resume (spec.suspend), Argo
/// Rollout restart (spec.restartAt), and similar one-field edits.
pub async fn patch_resource(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    name: String,
    patch: serde_json::Value,
) -> Result<(), String> {
    require_namespace(&rt, &namespace)?;
    let client = client(state, &context).await?;
    let api = dyn_api(client, &rt, namespace.as_deref());
    api.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map_err(err)?;
    Ok(())
}

/// `kubectl create job --from=cronjob/<name>`: instantiate a one-off Job
/// from a CronJob's jobTemplate, right now. Returns the new Job's name.
pub async fn trigger_cronjob(
    state: &AppState,
    context: String,
    namespace: String,
    name: String,
) -> Result<String, String> {
    if namespace.is_empty() {
        return Err("CronJob needs a namespace".into());
    }
    let client = client(state, &context).await?;
    let cj_ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("batch", "v1", "CronJob"));
    let cj = Api::<DynamicObject>::namespaced_with(client.clone(), &namespace, &cj_ar)
        .get(&name)
        .await
        .map_err(err)?;
    let v = serde_json::to_value(&cj).map_err(err)?;
    let spec = v
        .pointer("/spec/jobTemplate/spec")
        .cloned()
        .ok_or("CronJob has no jobTemplate.spec")?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Job names are capped at 63 chars; leave room for the suffix.
    let base: String = name.chars().take(40).collect();
    let job_name = format!("{base}-manual-{:x}", nanos & 0xffff);
    let mut meta = serde_json::json!({
        "name": job_name,
        "namespace": namespace,
        "annotations": { "cronjob.kubernetes.io/instantiate": "manual" },
    });
    if let Some(uid) = v.pointer("/metadata/uid").and_then(|u| u.as_str()) {
        meta["ownerReferences"] = serde_json::json!([{
            "apiVersion": "batch/v1", "kind": "CronJob", "name": name, "uid": uid,
            "controller": true, "blockOwnerDeletion": true
        }]);
    }
    let job_json = serde_json::json!({
        "apiVersion": "batch/v1", "kind": "Job", "metadata": meta, "spec": spec,
    });
    let job: DynamicObject = serde_json::from_value(job_json).map_err(err)?;
    let job_ar = KubeApiResource::from_gvk(&GroupVersionKind::gvk("batch", "v1", "Job"));
    Api::<DynamicObject>::namespaced_with(client, &namespace, &job_ar)
        .create(&PostParams::default(), &job)
        .await
        .map_err(err)?;
    Ok(job_name)
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
            resize: resize.map(Resizer::Remote),
            aborts: vec![writer.abort_handle(), reader.abort_handle()],
            cleanup,
            kill: None,
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

/// `kubectl debug`: attach an ephemeral debug container (a full toolbox
/// image) to a running pod without restarting it, then exec into it —
/// the way to get a shell into a distroless/crashed pod that has none.
pub async fn debug_start(
    state: &AppState,
    context: String,
    namespace: String,
    pod: String,
    image: Option<String>,
    target: Option<String>,
    channel: Channel<String>,
) -> Result<u32, String> {
    if namespace.is_empty() {
        return Err("debug needs a namespace".into());
    }
    let client = client(state, &context).await?;
    let pods: Api<K8sPod> = Api::namespaced(client.clone(), &namespace);
    let img = image
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "busybox:1.36".to_string());
    // Read the target pod's security posture so the debug container fits
    // the same admission policy (PodSecurity restricted, Kyverno, etc.) —
    // otherwise a pod with runAsNonRoot rejects a root busybox.
    let pv = pods
        .get(&pod)
        .await
        .map_err(err)
        .and_then(|p| serde_json::to_value(&p).map_err(err))?;
    let field = |p: &str| -> Option<serde_json::Value> {
        pv.pointer(&format!("/spec/securityContext/{p}"))
            .or_else(|| pv.pointer(&format!("/spec/containers/0/securityContext/{p}")))
            .cloned()
    };
    let nonroot = field("runAsNonRoot")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let run_as_user = field("runAsUser").and_then(|v| v.as_i64());
    let mut sc = serde_json::json!({
        // Baseline the restricted PodSecurity profile requires; harmless
        // in permissive namespaces.
        "allowPrivilegeEscalation": false,
        "capabilities": { "drop": ["ALL"] },
        "seccompProfile": field("seccompProfile")
            .unwrap_or_else(|| serde_json::json!({ "type": "RuntimeDefault" })),
    });
    if nonroot || run_as_user.is_some() {
        sc["runAsNonRoot"] = true.into();
        // A root busybox violates runAsNonRoot, so pin a non-zero UID —
        // the pod's own if it set one, else 1000.
        sc["runAsUser"] = run_as_user.filter(|u| *u != 0).unwrap_or(1000).into();
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ec_name = format!("debugger-{:x}", nanos & 0xffff);
    let mut ec = serde_json::json!({
        "name": ec_name, "image": img, "stdin": true, "tty": true, "command": ["sh"],
        "securityContext": sc,
    });
    if let Some(t) = target.filter(|s| !s.is_empty()) {
        ec["targetContainerName"] = t.into();
    }
    let patch = serde_json::json!({ "spec": { "ephemeralContainers": [ec] } });
    pods.patch_subresource(
        "ephemeralcontainers",
        &pod,
        &PatchParams::default(),
        &Patch::Strategic(patch),
    )
    .await
    .map_err(err)?;
    // Wait for the ephemeral container to start (image pull included).
    let mut ready = false;
    for _ in 0..120 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Ok(p) = pods.get(&pod).await {
            let v = serde_json::to_value(&p).unwrap_or_default();
            if let Some(sts) = v
                .pointer("/status/ephemeralContainerStatuses")
                .and_then(|s| s.as_array())
            {
                for s in sts {
                    if s.get("name").and_then(|n| n.as_str()) == Some(ec_name.as_str()) {
                        if s.pointer("/state/running").is_some() {
                            ready = true;
                        } else if let Some(term) = s.pointer("/state/terminated") {
                            let reason = term
                                .get("reason")
                                .and_then(|r| r.as_str())
                                .unwrap_or("terminated");
                            return Err(format!("debug container {reason}"));
                        }
                    }
                }
            }
        }
        if ready {
            break;
        }
    }
    if !ready {
        return Err("debug container did not start within 60s".into());
    }
    start_exec_session(
        state,
        client,
        &namespace,
        &pod,
        Some(ec_name),
        vec!["sh".into()],
        channel,
        None,
    )
    .await
}

/// Follow a pod's logs into the same session plumbing the shells use —
/// read-only (no stdin), \n normalized to \r\n for xterm.
#[allow(clippy::too_many_arguments)]
pub async fn log_start(
    state: &AppState,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    tail: Option<i64>,
    previous: Option<bool>,
    since_seconds: Option<i64>,
    timestamps: Option<bool>,
    follow: Option<bool>,
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
        follow: follow.unwrap_or(true),
        tail_lines: Some(tail.unwrap_or(500)),
        container,
        previous: previous.unwrap_or(false),
        since_seconds: since_seconds.filter(|s| *s > 0),
        timestamps: timestamps.unwrap_or(false),
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
            kill: None,
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
    let selector = label_selector_string(&v);
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
            kill: None,
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
    // Consecutive upstream failures. Every new connection re-runs the
    // kubeconfig exec, and that helper can open a BROWSER (`aws-vault exec`,
    // oidc-login) — so a forward whose credentials died must not pay a
    // credential call, and a browser tab, for each incoming connection. A
    // client that retries (an auto-refreshing page, a health check) would
    // otherwise drive that without limit. Three strikes and the listener
    // closes; the forward is dead anyway.
    let fails = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let fails2 = fails.clone();
    let task = tokio::spawn(async move {
        loop {
            if fails2.load(std::sync::atomic::Ordering::Relaxed) >= 3 {
                break;
            }
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            let pods = pods2.clone();
            let pod = podname.clone();
            let f = fails2.clone();
            let h = tokio::spawn(async move {
                match pods.portforward(&pod, &[port]).await {
                    Ok(mut pf) => {
                        f.store(0, std::sync::atomic::Ordering::Relaxed);
                        if let Some(mut upstream) = pf.take_stream(port) {
                            let _ =
                                tokio::io::copy_bidirectional(&mut sock, &mut upstream).await;
                        }
                    }
                    Err(e) => {
                        // Only a CREDENTIAL failure counts toward the strike
                        // limit — that is the one whose retry re-runs the exec
                        // helper and can open a browser. A transient upstream
                        // failure (a pod restarting mid-forward) must not tear
                        // down an otherwise healthy forward.
                        let m = e.to_string().to_lowercase();
                        if m.contains("401")
                            || m.contains("403")
                            || m.contains("unauthorized")
                            || m.contains("forbidden")
                            || m.contains("credential")
                            || m.contains("exec plugin")
                            || m.contains("auth exec")
                        {
                            f.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
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

/// Decode a Secret's `data` map (base64) into (key, value) pairs, sorted
/// by key. Binary values that aren't valid UTF-8 are shown as a size
/// note rather than mojibake.
fn decode_secret_data(v: &serde_json::Value) -> Vec<(String, String)> {
    use base64::Engine;
    let Some(map) = v.pointer("/data").and_then(|d| d.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = map
        .iter()
        .map(|(k, val)| {
            let decoded = val
                .as_str()
                .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
                .map(|bytes| match String::from_utf8(bytes) {
                    Ok(s) => s,
                    Err(e) => format!("<{} bytes of binary data>", e.into_bytes().len()),
                })
                .unwrap_or_else(|| "<invalid base64>".to_string());
            (k.clone(), decoded)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Build a Kubernetes label-selector string from an object's
/// `spec.selector`. Handles a plain label map (Services) and
/// matchLabels + matchExpressions (workloads). Empty if there's none.
fn label_selector_string(v: &serde_json::Value) -> String {
    let mut parts: Vec<String> = Vec::new();
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
    parts.join(",")
}

/// Sanitize a user string into a DNS-1123 label prefix: lowercase,
/// alphanumeric or '-', no leading/trailing '-', capped so the suffix fits.
fn dns_label(s: &str) -> String {
    let mut out: String = s
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(40).collect()
}

/// Node shell via a privileged hostPID helper pod
/// pinned to the node, then nsenter into the host's namespaces. The
/// helper pod is deleted when the session closes. Image, namespace and
/// resource limits are user-configurable.
pub async fn node_shell_start(
    state: &AppState,
    context: String,
    node: String,
    name: Option<String>,
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
    // A user-given name becomes the prefix (sanitized to DNS-1123); a
    // short unique suffix is always appended so repeated shells and
    // concurrent ones never collide.
    let prefix = name
        .as_deref()
        .map(dns_label)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "pigeoneye-node-shell".to_string());
    let name = format!("{prefix}-{:x}", nanos & 0xffff_ffff);
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
        // A dropped receiver means the shell already exited; that's not a
        // command failure, so don't surface it (it would reject the invoke
        // as "channel closed"). exec_resize already ignores its send.
        let _ = tx.send(data.into_bytes()).await;
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
    match resize {
        Some(Resizer::Remote(mut tx)) => {
            let _ = tx.try_send(TerminalSize {
                width: cols,
                height: rows,
            });
        }
        Some(Resizer::Pty(tx)) => {
            let _ = tx.try_send((cols, rows));
        }
        None => {}
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
    // A local login CLI sits in its own process group waiting on the tty;
    // dropping our end is not enough to end it.
    if let Some(mut kill) = session.kill {
        let _ = kill.kill();
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
/// Translate a kubectl-style JSONPath into the RFC 9535 syntax
/// `serde_json_path` parses:
///   - kubectl paths start with `.`; JSONPath wants a `$` root.
///   - kubectl filters read `[?(@.type=="Ready")]`; RFC 9535 has no
///     inner parens: `[?@.type=="Ready"]`.
/// Bracket-quoted keys (`['node.kubernetes.io/instance-type']`) already
/// match, so dotted label keys work when written that way.
fn parse_kubectl_path(p: &str) -> Result<serde_json_path::JsonPath, String> {
    let mut s = p.trim().to_string();
    if s.starts_with('.') {
        s.insert(0, '$');
    } else if !s.starts_with('$') {
        s.insert_str(0, "$.");
    }
    s = s.replace("[?(", "[?").replace(")]", "]");
    serde_json_path::JsonPath::parse(&s).map_err(|e| format!("bad path `{p}`: {e}"))
}

/// Render every match of one path against one object as a single cell.
fn eval_cell(obj: &serde_json::Value, path: &serde_json_path::JsonPath) -> String {
    let nodes = path.query(obj).all();
    nodes
        .iter()
        .map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Null => String::new(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Evaluate user-defined custom columns against the full objects of a
/// list. Runs its own paged includeObject=Object fetch — only called when
/// a kind actually has custom columns, so the slim default path pays
/// nothing. Returns key(`ns/name`) → one cell per column, in order.
pub async fn custom_columns(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<(String, Vec<String>)>, String> {
    let compiled: Vec<serde_json_path::JsonPath> = paths
        .iter()
        .map(|p| parse_kubectl_path(p))
        .collect::<Result<_, _>>()?;
    let client = client(state, &context).await?;
    let ns = namespace.filter(|n| !n.is_empty());
    let fs = field_selector.filter(|f| !f.is_empty());
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = fetch_table_page(
            &client,
            &rt,
            ns.as_deref(),
            "Object",
            fs.as_deref(),
            token.as_deref(),
            None,
        )
        .await?;
        if let Some(rows) = page["rows"].as_array() {
            for r in rows {
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
                let cells = compiled.iter().map(|p| eval_cell(obj, p)).collect();
                out.push((key, cells));
            }
        }
        token = page
            .pointer("/metadata/continue")
            .and_then(|c| c.as_str())
            .filter(|c| !c.is_empty())
            .map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(out)
}

/// Walk one object into pickable kubectl-JSONPath leaf paths. Arrays of
/// objects that share a discriminator (`type`/`name`) become filter paths
/// (`conditions[?(@.type=="Ready")].status`) so conditions/addresses come
/// out exactly like a `kubectl -o custom-columns` query; other arrays use
/// `[0]`. Skips the noisy bits (managedFields, labels — labels have their
/// own picker).
fn flatten_paths(
    v: &serde_json::Value,
    prefix: &str,
    depth: u32,
    arr_depth: u32,
    out: &mut std::collections::BTreeMap<String, String>,
) {
    // Go deep and wide — flattening a handful of sample objects is cheap
    // (never on the hot path), and the UI only renders a filtered slice.
    if depth > 12 || out.len() > 2000 {
        return;
    }
    match v {
        serde_json::Value::Object(m) => {
            for (k, val) in m {
                if k == "managedFields" {
                    continue;
                }
                // labels have their own picker; annotations are noisy and
                // often huge — both are better reached via Advanced.
                if prefix == ".metadata" && (k == "labels" || k == "annotations") {
                    continue;
                }
                flatten_paths(val, &format!("{prefix}.{k}"), depth + 1, arr_depth, out);
            }
        }
        serde_json::Value::Array(a) => {
            // Expand an array by its type/name discriminator down to two
            // array levels (containers[] → env[]), so deep fields are
            // reachable; below that, collapse to [0] so a pathological
            // array-of-arrays can't blow up.
            let disc = if arr_depth < 2 {
                ["type", "name", "key"].into_iter().find(|d| {
                    !a.is_empty()
                        && a.iter().all(|e| e.get(d).and_then(|x| x.as_str()).is_some())
                })
            } else {
                None
            };
            if let Some(d) = disc {
                let mut seen = std::collections::BTreeSet::new();
                for e in a {
                    if seen.len() >= 12 {
                        break; // cap distinct values so a big array can't explode
                    }
                    if let Some(val) = e.get(d).and_then(|x| x.as_str()) {
                        if seen.insert(val.to_string()) {
                            flatten_paths(
                                e,
                                &format!("{prefix}[?(@.{d}==\"{val}\")]"),
                                depth + 1,
                                arr_depth + 1,
                                out,
                            );
                        }
                    }
                }
            } else if let Some(first) = a.first() {
                flatten_paths(first, &format!("{prefix}[0]"), depth + 1, arr_depth + 1, out);
            }
        }
        serde_json::Value::Null => {}
        _ => {
            // A leaf with an actual value — skip empties so the picker
            // never offers a column that would render blank.
            if prefix.is_empty() {
                return;
            }
            let s = match v {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if s.trim().is_empty() {
                return;
            }
            out.entry(prefix.to_string()).or_insert(s);
        }
    }
}

/// Sample a few full objects and return the union of their pickable field
/// paths, each with a representative value, so the UI can offer a
/// searchable field list (with a preview) instead of making the user
/// hand-write JSONPath. Paths with no value anywhere in the sample are
/// omitted.
pub async fn sample_fields(
    state: &AppState,
    context: String,
    rt: ResourceType,
    namespace: Option<String>,
) -> Result<Vec<(String, String)>, String> {
    let client = client(state, &context).await?;
    let ns = namespace.filter(|n| !n.is_empty());
    // A handful of objects is plenty to sample field paths — don't pull
    // the whole 500-object / ~18 MB page just to read 8.
    let page = fetch_table_page(&client, &rt, ns.as_deref(), "Object", None, None, Some(12)).await?;
    let mut map = std::collections::BTreeMap::new();
    if let Some(rows) = page["rows"].as_array() {
        for r in rows.iter().take(8) {
            flatten_paths(&r["object"], "", 0, 0, &mut map);
        }
    }
    Ok(map.into_iter().collect())
}

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

#[cfg(test)]
mod row_name_tests {
    use super::row_from_object;
    fn cells(first: &str) -> Vec<serde_json::Value> {
        vec![first.into(), "ebs.csi.aws.com".into(), "Delete".into()]
    }
    /// With includeObject=Metadata the object carries the real name and the
    /// decorated cell is irrelevant.
    #[test]
    fn prefers_the_object_name() {
        let obj = serde_json::json!({"metadata": {"name": "aws-ebs-gp3"}});
        assert_eq!(row_from_object(&obj, cells("aws-ebs-gp3 (default)")).name, "aws-ebs-gp3");
    }
    /// With includeObject=None there is no object, so the cell is all we have —
    /// and kubectl marks the default StorageClass right there in it. Keeping the
    /// suffix put a space and parens in the request path, which failed to build
    /// as a URI, so only the default class could not be opened.
    #[test]
    fn strips_a_decorated_cell() {
        let none = serde_json::json!({});
        assert_eq!(row_from_object(&none, cells("aws-ebs-gp3 (default)")).name, "aws-ebs-gp3");
        assert_eq!(row_from_object(&none, cells("aws-ebs-gp2")).name, "aws-ebs-gp2");
    }
    /// Names may carry punctuation; only a space means "this is not the name".
    #[test]
    fn keeps_punctuated_names() {
        let none = serde_json::json!({});
        for n in ["system:controller:deployment-controller", "kube-root-ca.crt", "a.b-c.d"] {
            assert_eq!(row_from_object(&none, cells(n)).name, n);
        }
    }
}

#[cfg(test)]
mod cc_tests {
    use super::{eval_cell, parse_kubectl_path};
    fn node() -> serde_json::Value {
        serde_json::json!({
            "metadata": {"name":"n1","labels":{"node.kubernetes.io/instance-type":"m5.large","group":"gpu"},"creationTimestamp":"2026-01-01T00:00:00Z"},
            "spec": {"providerID":"aws:///x/i-123","unschedulable": true},
            "status": {
                "addresses":[{"type":"Hostname","address":"n1.local"},{"type":"InternalIP","address":"10.0.0.5"}],
                "conditions":[{"type":"MemoryPressure","status":"False"},{"type":"Ready","status":"True"}]
            }
        })
    }
    fn ev(p: &str) -> String { eval_cell(&node(), &parse_kubectl_path(p).unwrap()) }
    #[test]
    fn paths() {
        assert_eq!(ev(".status.addresses[?(@.type==\"InternalIP\")].address"), "10.0.0.5");
        assert_eq!(ev(".status.conditions[?(@.type==\"Ready\")].status"), "True");
        assert_eq!(ev(".spec.providerID"), "aws:///x/i-123");
        assert_eq!(ev(".spec.unschedulable"), "true");
        assert_eq!(ev(".metadata.labels['node.kubernetes.io/instance-type']"), "m5.large");
        assert_eq!(ev(".metadata.creationTimestamp"), "2026-01-01T00:00:00Z");
    }
}

/// The proxy features are build-time flags, so nothing in this file changes
/// when they are on or off — what changes is whether a kubeconfig `proxy-url:`
/// works or refuses to build a client at all. These tests stand a real proxy
/// in front of a real `kube::Client` and read the bytes it is sent, so the
/// flags are verified end to end rather than merely compiled.
#[cfg(test)]
mod proxy_tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A kube client aimed at `host`, routed through `proxy`.
    fn client_through(proxy: &str, host: &str) -> kube::Client {
        let mut cfg = kube::Config::new(format!("https://{host}").parse().unwrap());
        cfg.proxy_url = Some(proxy.parse().unwrap());
        kube::Client::try_from(cfg).expect("the proxy feature must be built in")
    }

    /// Speaks just enough SOCKS5 to report what it was asked to connect to.
    async fn socks5_target(listener: TcpListener) -> String {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut greet = [0u8; 3];
        s.read_exact(&mut greet).await.unwrap();
        assert_eq!(greet[0], 0x05, "not a SOCKS5 greeting");
        s.write_all(&[0x05, 0x00]).await.unwrap(); // no auth
        let mut head = [0u8; 4]; // VER CMD RSV ATYP
        s.read_exact(&mut head).await.unwrap();
        assert_eq!(head[1], 0x01, "expected CONNECT");
        let host = match head[3] {
            0x01 => {
                let mut a = [0u8; 4];
                s.read_exact(&mut a).await.unwrap();
                format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
            }
            0x03 => {
                let mut len = [0u8; 1];
                s.read_exact(&mut len).await.unwrap();
                let mut d = vec![0u8; len[0] as usize];
                s.read_exact(&mut d).await.unwrap();
                String::from_utf8_lossy(&d).into_owned()
            }
            other => panic!("unexpected address type {other}"),
        };
        let mut port = [0u8; 2];
        s.read_exact(&mut port).await.unwrap();
        format!("{host}:{}", u16::from_be_bytes(port))
    }

    /// Reads the CONNECT request line an HTTP proxy is sent.
    async fn http_connect_target(listener: TcpListener) -> String {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n") {
            if s.read_exact(&mut byte).await.is_err() {
                break;
            }
            buf.push(byte[0]);
        }
        String::from_utf8_lossy(&buf).trim().to_string()
    }

    /// The whole point of the socks5 feature: a `proxy-url:` of that scheme
    /// routes the API server connection instead of refusing to build.
    #[tokio::test]
    async fn socks5_carries_the_api_server_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = tokio::spawn(socks5_target(listener));

        let client = client_through(&format!("socks5://{addr}"), "127.0.0.1:6443");
        // The handshake is all we need; there is no server behind the proxy,
        // so the request itself is expected to fail afterwards.
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.apiserver_version(),
        )
        .await;

        let target = tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the client never reached the proxy")
            .unwrap();
        assert_eq!(target, "127.0.0.1:6443");
    }

    /// Same for an HTTP proxy, which tunnels with CONNECT because the API
    /// server is always https.
    #[tokio::test]
    async fn an_http_proxy_tunnels_with_connect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = tokio::spawn(http_connect_target(listener));

        let client = client_through(&format!("http://{addr}"), "127.0.0.1:6443");
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.apiserver_version(),
        )
        .await;

        let line = tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("the client never reached the proxy")
            .unwrap();
        assert!(
            line.starts_with("CONNECT 127.0.0.1:6443"),
            "expected a CONNECT tunnel, got {line:?}"
        );
    }

    /// Which end resolves DNS. It decides whether a kubeconfig may name the
    /// cluster by hostname: if the proxy resolves, the name never has to work
    /// on this machine; if we resolve, it does. kube has no `socks5h` scheme
    /// to pick with, so the answer is whatever the connector does -- pinned
    /// here because a kubeconfig is written against it.
    #[tokio::test]
    async fn socks5_leaves_dns_to_the_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = tokio::spawn(socks5_target(listener));

        // .invalid is reserved by RFC 2606 and never resolves anywhere.
        let client = client_through(&format!("socks5://{addr}"), "not-in-dns.invalid:6443");
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.apiserver_version(),
        )
        .await;

        let target = tokio::time::timeout(std::time::Duration::from_secs(5), seen)
            .await
            .expect("a name that does not resolve never reached the proxy")
            .unwrap();
        assert_eq!(target, "not-in-dns.invalid:6443");
    }

    /// Nothing is routed when no proxy is configured — the feature must be
    /// inert for every cluster that does not ask for one.
    #[tokio::test]
    async fn no_proxy_url_means_no_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = tokio::spawn(socks5_target(listener));

        let cfg = kube::Config::new("https://127.0.0.1:6443".parse().unwrap());
        let client = kube::Client::try_from(cfg).unwrap();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.apiserver_version(),
        )
        .await;

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), seen)
                .await
                .is_err(),
            "a client with no proxy_url still went to {addr}"
        );
    }
}

#[cfg(test)]
mod extras_tests {
    use super::*;
    use serde_json::json;

    fn exited(name: &str, reason: &str, code: i64, at: &str) -> serde_json::Value {
        json!({"name": name, "lastState": {"terminated": {"reason": reason, "exitCode": code, "finishedAt": at}}})
    }

    #[test]
    fn the_newest_exit_wins_across_containers() {
        let pod = json!({"status": {"containerStatuses": [
            exited("app", "Error", 1, "2026-11-09T01:00:00Z"),
            exited("proxy", "OOMKilled", 137, "2026-11-09T02:00:00Z"),
            {"name": "quiet", "lastState": {}},
        ]}});
        let e = last_exit(&pod, "ns/p").unwrap();
        assert_eq!((e.reason.as_str(), e.code, e.container.as_str()), ("OOMKilled", 137, "proxy"));
        assert_eq!(e.key, "ns/p");
    }

    #[test]
    fn a_sidecar_restart_counts() {
        let pod = json!({"status": {
            "containerStatuses": [exited("app", "Error", 2, "2026-11-09T01:00:00Z")],
            "initContainerStatuses": [exited("istio-proxy", "OOMKilled", 137, "2026-11-09T03:00:00Z")],
        }});
        assert_eq!(last_exit(&pod, "k").unwrap().container, "istio-proxy");
    }

    #[test]
    fn a_pod_that_never_restarted_has_none() {
        let pod = json!({"status": {"containerStatuses": [{"name": "app", "lastState": {}}]}});
        assert_eq!(last_exit(&pod, "k"), None);
        assert_eq!(last_exit(&json!({}), "k"), None);
    }

    #[test]
    fn an_undated_exit_never_beats_a_dated_one() {
        let pod = json!({"status": {"containerStatuses": [
            exited("a", "Error", 1, "2026-11-09T01:00:00Z"),
            {"name": "b", "lastState": {"terminated": {"reason": "Unknown", "exitCode": 255}}},
        ]}});
        assert_eq!(last_exit(&pod, "k").unwrap().container, "a");
    }

    fn labels(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn karpenter_nodes_read_as_they_are_labelled() {
        let t = node_type("n", &labels(&[
            ("node.kubernetes.io/instance-type", "m6i.xlarge"),
            ("karpenter.sh/capacity-type", "spot"),
            ("karpenter.sh/nodepool", "default"),
            ("topology.kubernetes.io/zone", "ap-northeast-2a"),
        ]));
        assert_eq!(
            (t.instance.as_str(), t.capacity.as_str(), t.pool.as_str(), t.zone.as_str()),
            ("m6i.xlarge", "spot", "default", "ap-northeast-2a")
        );
    }

    #[test]
    fn managed_node_groups_speak_the_same_capacity() {
        let t = node_type("n", &labels(&[
            ("eks.amazonaws.com/capacityType", "ON_DEMAND"),
            ("eks.amazonaws.com/nodegroup", "ng-1"),
        ]));
        assert_eq!((t.capacity.as_str(), t.pool.as_str()), ("on-demand", "ng-1"));
        let gke = node_type("n", &labels(&[("cloud.google.com/gke-spot", "true")]));
        assert_eq!(gke.capacity, "spot");
        let aks = node_type("n", &labels(&[("kubernetes.azure.com/scalesetpriority", "spot")]));
        assert_eq!(aks.capacity, "spot");
    }

    #[test]
    fn a_bare_node_has_no_type() {
        let t = node_type("kind-control-plane", &labels(&[("kubernetes.io/hostname", "kind")]));
        assert_eq!(t, NodeType { name: "kind-control-plane".into(), ..Default::default() });
    }

    #[test]
    fn finished_and_unscheduled_pods_hold_nothing() {
        let mut res = std::collections::HashMap::new();
        let mut extra = std::collections::HashMap::new();
        let mut add = |k: &str, node: &str, done: bool, cpu: i64, mem: i64| {
            res.insert(k.to_string(), PodRes { cpu_r: cpu, mem_r: mem, ..Default::default() });
            extra.insert(k.to_string(), PodExtra { node: node.into(), done, exit: None });
        };
        add("a/1", "n1", false, 500, 1 << 30);
        add("a/2", "n1", false, 250, 1 << 29);
        add("a/3", "n1", true, 4000, 1 << 33); // Completed job: frees its requests
        add("a/4", "", false, 1000, 1 << 30); // Pending, no node yet
        add("a/5", "n2", false, 100, 0);
        let n = node_requests(&res, &extra);
        assert_eq!(n["n1"], NodeReq { cpu_r: 750, mem_r: (1 << 30) + (1 << 29), pods: 2 });
        assert_eq!(n["n2"], NodeReq { cpu_r: 100, mem_r: 0, pods: 1 });
        assert_eq!(n.len(), 2);
    }
}

#[cfg(test)]
mod events_feed_tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const FAST: EvWatchTiming = EvWatchTiming {
        flush: std::time::Duration::from_millis(200),
        debounce: std::time::Duration::from_millis(50),
        backoff_min: std::time::Duration::from_millis(50),
        backoff_max: std::time::Duration::from_millis(200),
        watch_secs: 5,
    };

    fn ev(name: &str, pod: &str, reason: &str, count: i64, last: &str, rv: &str) -> serde_json::Value {
        json!({
            "metadata": {"name": name, "namespace": "sre", "resourceVersion": rv},
            "involvedObject": {"kind": "Pod", "name": pod, "namespace": "sre"},
            "reason": reason, "message": format!("{reason} on {pod}"), "count": count,
            "lastTimestamp": last, "type": "Warning",
        })
    }

    /// One watch answer: the lines it streams, then whether it closes.
    struct Watch {
        lines: Vec<serde_json::Value>,
        close: bool,
    }

    /// Answers event lists page by page (continue tokens "p1", "p2", …) and
    /// event watches from a script. Logs every request path.
    async fn fake_api(pages: Vec<Vec<serde_json::Value>>, watches: Vec<Watch>) -> (String, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let pages = Arc::new(pages);
        let watches = Arc::new(Mutex::new(watches.into_iter()));
        let lg = log.clone();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let (pages, watches, lg) = (pages.clone(), watches.clone(), lg.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut b = [0u8; 4096];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(n) = s.read(&mut b).await else { return };
                        if n == 0 { return; }
                        buf.extend_from_slice(&b[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf).to_string();
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                    lg.lock().unwrap().push(path.clone());
                    if path.contains("watch=1") {
                        let next = watches.lock().unwrap().next();
                        let Some(w) = next else { return };
                        let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n").await;
                        for line in w.lines {
                            let data = format!("{line}\n");
                            let _ = s.write_all(format!("{:x}\r\n{data}\r\n", data.len()).as_bytes()).await;
                            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        }
                        if w.close {
                            let _ = s.write_all(b"0\r\n\r\n").await;
                        } else {
                            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        }
                        return;
                    }
                    let page = path.split("continue=p").nth(1).and_then(|r| r.split('&').next()).and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
                    let next = if page + 1 < pages.len() { format!("p{}", page + 1) } else { String::new() };
                    let body = json!({"kind": "EventList", "metadata": {"resourceVersion": "100", "continue": next}, "items": pages.get(page).cloned().unwrap_or_default()}).to_string();
                    let _ = s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
                });
            }
        });
        (format!("http://{addr}"), log)
    }

    /// Run the feed against `server` for `for_ms`, returning what it sent.
    async fn run_feed(server: &str, for_ms: u64) -> Vec<serde_json::Value> {
        let client = kube::Client::try_from(kube::Config::new(server.parse().unwrap())).unwrap();
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let run = run_pod_events_watch(client, Arc::new(CredGate::default()), None, FAST, move |v| {
            g.lock().unwrap().push(v);
            true
        });
        let _ = tokio::time::timeout(std::time::Duration::from_millis(for_ms), run).await;
        let out = got.lock().unwrap().clone();
        out
    }

    fn keep_open() -> Vec<Watch> {
        (0..3).map(|_| Watch { lines: vec![], close: false }).collect()
    }

    /// Against a real cluster, by hand: the feed exactly as the app runs it.
    /// PEYE_LIVE_CONTEXT=<kube context> [PEYE_LIVE_SECS=45]
    /// cargo test --lib live_feed -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore]
    async fn live_feed() {
        let Ok(ctx) = std::env::var("PEYE_LIVE_CONTEXT") else { return };
        let secs: u64 = std::env::var("PEYE_LIVE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(45);
        let opts = kube::config::KubeConfigOptions { context: Some(ctx.clone()), ..Default::default() };
        let client = kube::Client::try_from(kube::Config::from_kubeconfig(&opts).await.unwrap()).unwrap();
        let t0 = std::time::Instant::now();
        let got: Arc<Mutex<Vec<(f64, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let run = run_pod_events_watch(client, Arc::new(CredGate::default()), None, EV_TIMING, move |v| {
            g.lock().unwrap().push((t0.elapsed().as_secs_f64(), v));
            true
        });
        let _ = tokio::time::timeout(std::time::Duration::from_secs(secs), run).await;
        let got = got.lock().unwrap().clone();
        for (at, m) in &got {
            let n = m["events"].as_array().map(|a| a.len()).unwrap_or(0);
            let r = m["removed"].as_array().map(|a| a.len()).unwrap_or(0);
            eprintln!("{at:6.1}s  {:8}  pods {n:5}  removed {r:3}  {}", m["type"].as_str().unwrap_or(""), m["error"].as_str().unwrap_or(""));
        }
        if let Some((_, snap)) = got.iter().find(|(_, m)| m["type"] == "SNAPSHOT") {
            let mut evs: Vec<&serde_json::Value> = snap["events"].as_array().unwrap().iter().collect();
            evs.sort_by_key(|e| -e["count"].as_i64().unwrap_or(0));
            for e in evs.iter().take(5) {
                eprintln!("  top: {:60} {:18} x{}", e["key"].as_str().unwrap(), e["reason"].as_str().unwrap(), e["count"]);
            }
            std::fs::write(std::env::temp_dir().join(format!("peye-live-{ctx}.json")), snap.to_string()).unwrap();
        }
    }

    /// The bug this replaces: one page of 500 left most pods out.
    #[tokio::test]
    async fn the_first_answer_covers_every_page() {
        let pages: Vec<Vec<serde_json::Value>> = [500, 500, 200]
            .iter()
            .enumerate()
            .map(|(p, n)| (0..*n).map(|i| ev(&format!("e{p}-{i}"), &format!("pod-{p}-{i}"), "Unhealthy", 1, "2026-11-09T01:00:00Z", "1")).collect())
            .collect();
        let (server, log) = fake_api(pages, keep_open()).await;
        let got = run_feed(&server, 800).await;
        assert_eq!(got[0]["type"], "SNAPSHOT");
        assert_eq!(got[0]["events"].as_array().unwrap().len(), 1200, "every pod from every page");
        let log = log.lock().unwrap().clone();
        assert!(log[0].contains("resourceVersion=0") && log[0].contains("limit=500"), "{log:?}");
        assert!(log[1].contains("continue=p1") && log[2].contains("continue=p2"), "{log:?}");
        assert!(log[3].contains("watch=1") && log[3].contains("resourceVersion=100"), "watch from the list's version: {log:?}");
    }

    /// While the list sits open only what changed is sent, in one batch.
    #[tokio::test]
    async fn changes_arrive_together_and_only_what_changed() {
        let page = vec![
            ev("e1", "a", "Unhealthy", 1, "2026-11-09T01:00:00Z", "1"),
            ev("e3", "c", "FailedMount", 2, "2026-11-09T01:00:00Z", "1"),
            ev("e4", "d", "BackOff", 9, "2026-11-09T01:00:00Z", "1"),
        ];
        let watch = Watch {
            lines: vec![
                json!({"type": "MODIFIED", "object": ev("e1", "a", "Unhealthy", 5, "2026-11-09T01:01:00Z", "101")}),
                json!({"type": "ADDED", "object": ev("e2", "b", "FailedScheduling", 1, "2026-11-09T01:02:00Z", "102")}),
                json!({"type": "DELETED", "object": ev("e3", "c", "FailedMount", 2, "2026-11-09T01:00:00Z", "103")}),
                json!({"type": "MODIFIED", "object": ev("e1", "a", "Unhealthy", 6, "2026-11-09T01:03:00Z", "104")}),
                // a resend of what is already shown: nothing to send for d
                json!({"type": "MODIFIED", "object": ev("e4", "d", "BackOff", 9, "2026-11-09T01:00:00Z", "105")}),
            ],
            close: false,
        };
        let (server, _) = fake_api(vec![page], vec![watch]).await;
        let got = run_feed(&server, 1500).await;
        assert_eq!(got.len(), 2, "one snapshot, then one batch: {got:#?}");
        let d = &got[1];
        assert_eq!(d["type"], "DELTA");
        let mut keys: Vec<(String, i64)> = d["events"].as_array().unwrap().iter()
            .map(|e| (e["key"].as_str().unwrap().to_string(), e["count"].as_i64().unwrap())).collect();
        keys.sort();
        assert_eq!(keys, vec![("sre/a".to_string(), 6), ("sre/b".to_string(), 1)]);
        assert_eq!(d["removed"], json!(["sre/c"]));
    }

    /// The server closes every watch after a while; it re-opens from where it
    /// was, without fetching the whole list again.
    #[tokio::test]
    async fn a_closed_watch_reopens_where_it_left_off() {
        let page = vec![ev("e1", "a", "Unhealthy", 1, "2026-11-09T01:00:00Z", "1")];
        let watches = vec![
            Watch { lines: vec![json!({"type": "BOOKMARK", "object": {"metadata": {"resourceVersion": "150"}}})], close: true },
            Watch { lines: vec![], close: false },
        ];
        let (server, log) = fake_api(vec![page], watches).await;
        let got = run_feed(&server, 800).await;
        let log = log.lock().unwrap().clone();
        assert_eq!(log.iter().filter(|p| !p.contains("watch=1")).count(), 1, "listed once: {log:?}");
        let w: Vec<&String> = log.iter().filter(|p| p.contains("watch=1")).collect();
        assert!(w.len() >= 2 && w[1].contains("resourceVersion=150"), "{log:?}");
        assert_eq!(got.len(), 1, "nothing new to send: {got:?}");
    }

    /// Too far behind to resume (410 Gone): start over with a fresh list.
    #[tokio::test]
    async fn gone_starts_over() {
        let page = vec![ev("e1", "a", "Unhealthy", 1, "2026-11-09T01:00:00Z", "1")];
        let watches = vec![
            Watch { lines: vec![json!({"type": "ERROR", "object": {"kind": "Status", "code": 410, "reason": "Expired"}})], close: true },
            Watch { lines: vec![], close: false },
        ];
        let (server, log) = fake_api(vec![page], watches).await;
        let got = run_feed(&server, 800).await;
        let log = log.lock().unwrap().clone();
        assert_eq!(log.iter().filter(|p| !p.contains("watch=1")).count(), 2, "listed again: {log:?}");
        assert_eq!(got.iter().filter(|m| m["type"] == "SNAPSHOT").count(), 2);
    }
}

/// What an expired SSO session does to the cluster's credential command.
///
/// A kubeconfig exec helper like `aws-vault exec … -- aws eks get-token` opens
/// a BROWSER each time it runs without a live session, so every run counted
/// here is a browser tab the user did not ask for. These stand a real kube
/// client on a stand-in helper that counts its runs.
#[cfg(all(test, unix))]
mod cred_storm_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A client whose helper hands out one token already inside kube's 60s
    /// refresh window, then fails every later run after `hang` seconds — the
    /// way it does once it has sent the user to a login page they never
    /// finish. Returns the client and a count of the helper runs since it
    /// was built.
    async fn expiring_client(hang: &str) -> (kube::Client, impl Fn() -> u32) {
        let dir = std::env::temp_dir().join(format!(
            "peye-cred-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("helper.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
n=$(cat "$DIR/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$DIR/count"
if [ "$n" = 1 ]; then
  printf '{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"token":"t","expirationTimestamp":"%s"}}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 0
fi
sleep "$HANG"
echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2
exit 1
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let yaml = format!(
            r#"apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://127.0.0.1:1
    insecure-skip-tls-verify: true
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: {script}
      env:
      - name: DIR
        value: {dir}
      - name: HANG
        value: "{hang}"
contexts:
- name: x
  context: {{cluster: c, user: u}}
current-context: x
"#,
            script = script.display(),
            dir = dir.display(),
        );
        let kc = kube::config::Kubeconfig::from_yaml(&yaml).unwrap();
        let cfg = kube::Config::from_custom_kubeconfig(kc, &Default::default())
            .await
            .unwrap();
        let client = kube::Client::try_from(cfg).unwrap();
        let read = move || {
            std::fs::read_to_string(dir.join("count"))
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
                .unwrap_or(0)
        };
        // Building the client runs the helper itself; count from here.
        let built = read();
        (client, move || read() - built)
    }

    async fn state_with(client: kube::Client) -> AppState {
        let state = AppState::default();
        state.clients.write().await.insert("x".into(), client);
        state
    }

    /// The premise, measured: requests that queue while the helper is out at
    /// a login page each run it again once it fails. kube does nothing to
    /// stop a pile-up; the caller has to not build one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn kube_reruns_a_failing_helper_once_per_queued_request() {
        let (client, runs) = expiring_client("0.3").await;
        let reqs = (0..5).map(|_| {
            let c = client.clone();
            async move {
                let req = http::Request::get("/api").body(Vec::new()).unwrap();
                c.request::<serde_json::Value>(req).await
            }
        });
        let res = futures::future::join_all(reqs).await;
        assert!(res.iter().all(|r| r.is_err()));
        assert_eq!(runs(), 5, "one helper run per queued request");
    }

    /// The sweep used to swallow this and answer "no issues", so nothing ever
    /// parked the cluster and every sweep — one a minute — ran the helper
    /// twice (pods, then nodes).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_sweep_reports_a_broken_credential_and_stops_there() {
        let (client, runs) = expiring_client("0").await;
        let state = state_with(client).await;
        let r = issues_once(&state, "x").await;
        let e = r.map(|v| v.len()).expect_err("a broken credential must reach the caller, which parks on it");
        assert!(e.contains("auth exec"), "{e}");
        assert_eq!(runs(), 1, "nodes must not be asked once the pods request failed on the credential");
    }

    /// Sweeps that overlap a stuck helper join the one already out instead of
    /// queueing their own behind it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn overlapping_sweeps_share_one_helper_run() {
        let (client, runs) = expiring_client("0.5").await;
        let state = state_with(client).await;
        let sweeps = (0..4).map(|_| issues_once(&state, "x"));
        let res = futures::future::join_all(sweeps).await;
        assert!(res.iter().all(|r| r.is_err()), "every sweep hears the failure");
        assert_eq!(runs(), 1, "four overlapping sweeps, one helper run");
        assert!(state.issue_sweeps.lock().await.is_empty(), "a finished sweep is not kept");
    }

    /// A plain client (no helper) on whatever `server` answers.
    fn plain_client(server: &str) -> kube::Client {
        kube::Client::try_from(kube::Config::new(server.parse().unwrap())).unwrap()
    }

    /// Answers every request with `status` and a Kubernetes Status body.
    async fn answering(status: u16, reason: &'static str) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let body = format!(
                        r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"{reason}","reason":"{reason}","code":{status}}}"#
                    );
                    let resp = format!(
                        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = s.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// What must NOT change: a cluster the account may not list cluster-wide,
    /// or one that is unreachable, still sweeps to an empty answer. Reporting
    /// those would park a cluster whose credentials are fine.
    #[tokio::test]
    async fn forbidden_and_unreachable_still_sweep_quietly() {
        let state = state_with(plain_client(&answering(403, "Forbidden").await)).await;
        assert_eq!(issues_once(&state, "x").await.map(|v| v.len()), Ok(0), "403");
        let state = state_with(plain_client("http://127.0.0.1:1")).await;
        assert_eq!(issues_once(&state, "x").await.map(|v| v.len()), Ok(0), "refused");
    }

    /// A rejected token is a broken credential too.
    #[tokio::test]
    async fn unauthorized_is_reported() {
        let state = state_with(plain_client(&answering(401, "Unauthorized").await)).await;
        let e = issues_once(&state, "x").await.map(|v| v.len()).expect_err("401 must reach the caller");
        assert!(e.contains("Unauthorized"), "{e}");
    }

    fn pods() -> ResourceType {
        ResourceType {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
            plural: "pods".into(),
            namespaced: true,
            deletable: true,
            editable: true,
        }
    }

    fn quiet_channel() -> Channel<serde_json::Value> {
        Channel::new(|_| Ok(()))
    }

    pub(super) const FAST: EvWatchTiming = EvWatchTiming {
        flush: std::time::Duration::from_millis(200),
        debounce: std::time::Duration::from_millis(50),
        backoff_min: std::time::Duration::from_millis(50),
        backoff_max: std::time::Duration::from_millis(200),
        watch_secs: 5,
    };

    /// Run the Recent event feed until it stops — a broken credential ends
    /// it — or a few seconds pass, and return what it sent.
    async fn feed(state: &AppState, ns: Option<String>) -> Vec<serde_json::Value> {
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let g = got.clone();
        let client = client(state, "x").await.unwrap();
        let run = run_pod_events_watch(client, cred_gate(state, "x"), ns, FAST, move |v| {
            g.lock().unwrap().push(v);
            true
        });
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), run).await;
        let out = got.lock().unwrap().clone();
        out
    }

    /// Everything the app asks on its own, all at once, while the helper is
    /// out at a login page: one helper run between them, not one each — and
    /// nothing at all once the failure is known.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn background_requests_share_one_helper_run() {
        let (client, runs) = expiring_client("0.5").await;
        let state = state_with(client).await;
        let (a, b, c, d, e, f) = tokio::join!(
            feed(&state, None),
            feed(&state, Some("app".into())),
            issues_once(&state, "x"),
            node_types(&state, "x".into()),
            pod_exits_refresh(&state, "x".into(), vec!["app/p".into()]),
            list_resources(&state, "x".into(), pods(), None, None, quiet_channel(), true),
        );
        for f in [&a, &b] {
            assert_eq!(f.len(), 1, "the feed reports once and stops: {f:?}");
            assert_eq!(f[0]["type"], "ERROR");
            assert!(f[0]["error"].as_str().unwrap().contains("auth exec"));
        }
        assert!(c.is_err() && d.is_err() && e.is_err() && f.is_err());
        assert_eq!(runs(), 1, "six background requests, one helper run");

        // Known broken now: a new feed is answered without anything sent.
        let later = feed(&state, None).await;
        assert!(later[0]["error"].as_str().unwrap().contains("auth exec"));
        let relist = list_resources(&state, "x".into(), pods(), None, None, quiet_channel(), true).await;
        assert!(relist.is_err());
        assert_eq!(runs(), 1, "nothing sent once the failure is known");

        // A click still goes through: the user is there to answer the login.
        let by_hand = list_resources(&state, "x".into(), pods(), None, None, quiet_channel(), false).await;
        assert!(by_hand.is_err());
        assert_eq!(runs(), 2, "what the user does is not held back");
    }

    /// Signing in again (a reconnect) opens the gate.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reconnect_opens_the_gate_again() {
        let (client, _) = expiring_client("0").await;
        let state = state_with(client).await;
        assert!(node_types(&state, "x".into()).await.is_err());
        disconnect(&state, "x".into()).await.unwrap();
        let (fresh, runs) = expiring_client("0").await;
        state.clients.write().await.insert("x".into(), fresh);
        assert!(node_types(&state, "x".into()).await.is_err());
        assert_eq!(runs(), 1, "the new client was asked, not answered from the old failure");
    }

    /// What must not change: a healthy cluster's background requests all go
    /// out — the gate takes turns, it never turns one away.
    #[tokio::test]
    async fn a_healthy_cluster_is_never_turned_away() {
        let state = state_with(plain_client(&answering(403, "Forbidden").await)).await;
        for _ in 0..3 {
            assert_eq!(issues_once(&state, "x").await.map(|v| v.len()), Ok(0));
        }
        // a Forbidden is not a broken credential: nothing latched
        let e = node_types(&state, "x".into()).await.err().unwrap();
        assert!(e.contains("Forbidden"), "{e}");
        let e2 = node_types(&state, "x".into()).await.err().unwrap();
        assert!(e2.contains("Forbidden"), "it was sent again, not answered from a latch: {e2}");
    }

    /// After a reconnect the new client answers for itself: a sweep stuck on
    /// the old one is dropped with it, not joined.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reconnect_does_not_wait_on_the_old_sweep() {
        let (client, _) = expiring_client("3").await;
        let state = std::sync::Arc::new(state_with(client).await);
        let s2 = state.clone();
        let stuck = tokio::spawn(async move { issues_once(&s2, "x").await });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        disconnect(&state, "x".into()).await.unwrap();
        state
            .clients
            .write()
            .await
            .insert("x".into(), plain_client(&answering(403, "Forbidden").await));
        let t = std::time::Instant::now();
        let fresh = issues_once(&state, "x").await;
        assert_eq!(fresh.map(|v| v.len()), Ok(0));
        assert!(t.elapsed().as_secs_f32() < 1.5, "joined the stuck sweep: {:?}", t.elapsed());
        stuck.abort();
    }
}
