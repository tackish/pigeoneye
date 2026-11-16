//! A pod's environment, resolved from its spec.
//!
//! This reads what the kubelet reads — `envFrom`, then `env`, with
//! ConfigMap/Secret keys, `fieldRef`, `resourceFieldRef` and `$(VAR)`
//! expansion — instead of running `env` inside the container. That keeps it
//! working on distroless images and on pods that never started, and it needs
//! `get` on the referenced objects rather than `pods/exec`.
//!
//! What the spec cannot tell us is said, not guessed: variables baked into
//! the image and the service variables the kubelet injects are absent, and a
//! limit left unset (which the kubelet fills from node allocatable) has no
//! value here.
//!
//! Secrets are read only when the caller asks to reveal them. Until then a
//! Secret-sourced variable carries its name and reference but no value, and
//! an `envFrom` Secret — whose keys are unknown without reading it — is
//! listed as pending.

use std::collections::{BTreeMap, HashMap};

use futures::future::join_all;
use k8s_openapi::api::core::v1::{ConfigMap, Pod, Secret};
use kube::{Api, Client};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct EnvVar {
    pub name: String,
    /// None when the value is not shown: a Secret not revealed, a reference
    /// that could not be read, or a value only the node knows.
    pub value: Option<String>,
    /// "value" | "configmap" | "secret" | "field" | "resource"
    pub source: &'static str,
    /// Where it came from: `cm-name/key`, `metadata.name`, `limits.cpu`.
    pub from: Option<String>,
    /// The value is, or was expanded from, Secret data.
    pub secret: bool,
    /// Why the value is missing, or a caveat about it.
    pub note: Option<String>,
    /// An earlier definition of the same name this one replaces.
    pub overrides: Option<String>,
}

/// An `envFrom` source whose keys are not listed — a Secret not revealed,
/// or a source that could not be read.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct EnvPending {
    pub kind: &'static str,
    pub name: String,
    pub prefix: Option<String>,
    pub note: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ContainerEnv {
    pub name: String,
    pub init: bool,
    pub vars: Vec<EnvVar>,
    pub pending: Vec<EnvPending>,
}

#[derive(Serialize, Debug)]
pub struct PodEnv {
    pub containers: Vec<ContainerEnv>,
    /// Secrets were read for this answer.
    pub revealed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum RefKind {
    ConfigMap,
    Secret,
}

#[derive(Debug, Clone)]
pub enum Fetched {
    Data(BTreeMap<String, String>),
    NotFound,
    Forbidden,
    Failed(String),
}

/// What was read for the referenced objects. A Secret absent from the map
/// was not read (not revealed).
pub type Sources = HashMap<(RefKind, String), Fetched>;

pub async fn load(
    client: Client,
    namespace: &str,
    name: &str,
    reveal: bool,
) -> Result<PodEnv, String> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = pods.get(name).await.map_err(|e| e.to_string())?;
    let pod = serde_json::to_value(&pod).map_err(|e| e.to_string())?;

    let wanted: Vec<(RefKind, String)> = referenced(&pod)
        .into_iter()
        .filter(|(k, _)| reveal || *k == RefKind::ConfigMap)
        .collect();
    let cms: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
    let secrets: Api<Secret> = Api::namespaced(client, namespace);
    let fetched = join_all(wanted.into_iter().map(|(kind, n)| {
        let cms = cms.clone();
        let secrets = secrets.clone();
        async move {
            let got = match kind {
                RefKind::ConfigMap => cms
                    .get(&n)
                    .await
                    .map(|cm| cm.data.unwrap_or_default()),
                RefKind::Secret => secrets.get(&n).await.map(|s| {
                    s.data
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(k, v)| (k, String::from_utf8_lossy(&v.0).into_owned()))
                        .collect()
                }),
            };
            let f = match got {
                Ok(d) => Fetched::Data(d),
                Err(kube::Error::Api(e)) if e.code == 404 => Fetched::NotFound,
                Err(kube::Error::Api(e)) if e.code == 403 => Fetched::Forbidden,
                Err(e) => Fetched::Failed(e.to_string()),
            };
            ((kind, n), f)
        }
    }))
    .await;
    let sources: Sources = fetched.into_iter().collect();
    Ok(PodEnv {
        containers: resolve(&pod, &sources),
        revealed: reveal,
    })
}

fn containers(pod: &Value) -> impl Iterator<Item = (&Value, bool)> {
    let list = |p: &'static str, init: bool| {
        pod.pointer(p)
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .map(move |c| (c, init))
    };
    list("/spec/initContainers", true).chain(list("/spec/containers", false))
}

/// Every ConfigMap and Secret the pod's env reads, de-duplicated.
pub fn referenced(pod: &Value) -> Vec<(RefKind, String)> {
    let mut out: Vec<(RefKind, String)> = Vec::new();
    let mut add = |k: RefKind, n: Option<&str>| {
        if let Some(n) = n.filter(|n| !n.is_empty()) {
            if !out.iter().any(|(k2, n2)| *k2 == k && n2 == n) {
                out.push((k, n.to_string()));
            }
        }
    };
    let s = |v: &Value, p: &str| v.pointer(p).and_then(|x| x.as_str()).map(str::to_owned);
    for (c, _) in containers(pod) {
        for ef in arr(c, "/envFrom") {
            add(RefKind::ConfigMap, s(ef, "/configMapRef/name").as_deref());
            add(RefKind::Secret, s(ef, "/secretRef/name").as_deref());
        }
        for e in arr(c, "/env") {
            add(RefKind::ConfigMap, s(e, "/valueFrom/configMapKeyRef/name").as_deref());
            add(RefKind::Secret, s(e, "/valueFrom/secretKeyRef/name").as_deref());
        }
    }
    out
}

fn arr<'a>(v: &'a Value, p: &str) -> impl Iterator<Item = &'a Value> {
    v.pointer(p).and_then(|a| a.as_array()).into_iter().flatten()
}

fn str_at<'a>(v: &'a Value, p: &str) -> Option<&'a str> {
    v.pointer(p).and_then(|x| x.as_str())
}

fn fetch_note(f: &Fetched, kind: RefKind, name: &str) -> String {
    let k = match kind {
        RefKind::ConfigMap => "ConfigMap",
        RefKind::Secret => "Secret",
    };
    match f {
        Fetched::NotFound => format!("{k} {name} not found"),
        Fetched::Forbidden => format!("forbidden — no access to {k} {name}"),
        Fetched::Failed(e) => format!("could not read {k} {name}: {e}"),
        Fetched::Data(_) => String::new(),
    }
}

fn source_label(v: &EnvVar) -> String {
    match &v.from {
        Some(f) => format!("{} {f}", v.source),
        None => v.source.to_string(),
    }
}

/// Resolve every container's environment, in the order the kubelet builds
/// it: all `envFrom` sources, then `env` entries, a later name replacing an
/// earlier one.
pub fn resolve(pod: &Value, sources: &Sources) -> Vec<ContainerEnv> {
    containers(pod)
        .map(|(c, init)| resolve_container(pod, c, init, sources))
        .collect()
}

fn resolve_container(pod: &Value, c: &Value, init: bool, sources: &Sources) -> ContainerEnv {
    let mut vars: Vec<EnvVar> = Vec::new();
    let mut pending: Vec<EnvPending> = Vec::new();
    let put = |vars: &mut Vec<EnvVar>, mut v: EnvVar| {
        if let Some(i) = vars.iter().position(|o| o.name == v.name) {
            let old = vars.remove(i);
            v.overrides = Some(source_label(&old));
        }
        vars.push(v);
    };

    for ef in arr(c, "/envFrom") {
        let prefix = str_at(ef, "/prefix").filter(|p| !p.is_empty());
        let (kind, name, optional) = if let Some(n) = str_at(ef, "/configMapRef/name") {
            (RefKind::ConfigMap, n, ef.pointer("/configMapRef/optional"))
        } else if let Some(n) = str_at(ef, "/secretRef/name") {
            (RefKind::Secret, n, ef.pointer("/secretRef/optional"))
        } else {
            continue;
        };
        let optional = optional.and_then(|o| o.as_bool()).unwrap_or(false);
        let kind_s = match kind {
            RefKind::ConfigMap => "configmap",
            RefKind::Secret => "secret",
        };
        match sources.get(&(kind, name.to_string())) {
            Some(Fetched::Data(data)) => {
                for (k, val) in data {
                    put(
                        &mut vars,
                        EnvVar {
                            name: format!("{}{k}", prefix.unwrap_or("")),
                            value: Some(val.clone()),
                            source: kind_s,
                            from: Some(format!("{name}/{k}")),
                            secret: kind == RefKind::Secret,
                            note: None,
                            overrides: None,
                        },
                    );
                }
            }
            Some(Fetched::NotFound) if optional => pending.push(EnvPending {
                kind: kind_s,
                name: name.to_string(),
                prefix: prefix.map(String::from),
                note: Some("optional — not present, nothing set".into()),
            }),
            Some(f) => pending.push(EnvPending {
                kind: kind_s,
                name: name.to_string(),
                prefix: prefix.map(String::from),
                note: Some(fetch_note(f, kind, name)),
            }),
            None => pending.push(EnvPending {
                kind: kind_s,
                name: name.to_string(),
                prefix: prefix.map(String::from),
                note: None,
            }),
        }
    }

    for e in arr(c, "/env") {
        let Some(name) = str_at(e, "/name") else { continue };
        let mut v = EnvVar {
            name: name.to_string(),
            value: None,
            source: "value",
            from: None,
            secret: false,
            note: None,
            overrides: None,
        };
        let literal = str_at(e, "/value").unwrap_or("");
        if !literal.is_empty() || e.pointer("/valueFrom").is_none() {
            // Expansion reads what is defined so far, exactly as the kubelet
            // does: a reference to a later variable stays literal.
            let (out, secret, blocked) = expand(literal, &vars);
            v.secret = secret;
            if blocked {
                v.note = Some("built from a Secret value that is not shown".into());
            } else {
                v.value = Some(out);
            }
        } else if let Some(r) = e.pointer("/valueFrom/configMapKeyRef") {
            if !key_ref(&mut v, r, RefKind::ConfigMap, sources) {
                continue; // optional and absent: the kubelet sets nothing
            }
        } else if let Some(r) = e.pointer("/valueFrom/secretKeyRef") {
            if !key_ref(&mut v, r, RefKind::Secret, sources) {
                continue;
            }
        } else if let Some(r) = e.pointer("/valueFrom/fieldRef") {
            let path = str_at(r, "/fieldPath").unwrap_or("");
            v.source = "field";
            v.from = Some(path.to_string());
            match field_value(pod, path) {
                Ok(val) => v.value = Some(val),
                Err(note) => v.note = Some(note),
            }
        } else if let Some(r) = e.pointer("/valueFrom/resourceFieldRef") {
            let res = str_at(r, "/resource").unwrap_or("");
            v.source = "resource";
            let target = str_at(r, "/containerName").filter(|n| !n.is_empty());
            v.from = Some(match target {
                Some(t) => format!("{t}/{res}"),
                None => res.to_string(),
            });
            let owner = target
                .and_then(|t| containers(pod).map(|(c, _)| c).find(|c| str_at(c, "/name") == Some(t)))
                .unwrap_or(c);
            let divisor = str_at(r, "/divisor").unwrap_or("1");
            match resource_value(owner, res, divisor) {
                Ok(val) => v.value = Some(val),
                Err(note) => v.note = Some(note),
            }
        } else {
            v.source = "field";
            v.note = Some("set from a source this view does not read".into());
        }
        put(&mut vars, v);
    }

    ContainerEnv {
        name: str_at(c, "/name").unwrap_or_default().to_string(),
        init,
        vars,
        pending,
    }
}

/// Fill `v` from a ConfigMap/Secret key. False when the reference is
/// optional and absent, meaning the kubelet does not set the variable.
fn key_ref(v: &mut EnvVar, r: &Value, kind: RefKind, sources: &Sources) -> bool {
    let name = str_at(r, "/name").unwrap_or("");
    let key = str_at(r, "/key").unwrap_or("");
    let optional = r.pointer("/optional").and_then(|o| o.as_bool()).unwrap_or(false);
    v.source = match kind {
        RefKind::ConfigMap => "configmap",
        RefKind::Secret => "secret",
    };
    v.secret = kind == RefKind::Secret;
    v.from = Some(format!("{name}/{key}"));
    match sources.get(&(kind, name.to_string())) {
        None => {} // a Secret not revealed: name and reference only
        Some(Fetched::Data(d)) => match d.get(key) {
            Some(val) => v.value = Some(val.clone()),
            None if optional => return false,
            None => v.note = Some(format!("key {key} not in {name}")),
        },
        Some(Fetched::NotFound) if optional => return false,
        Some(f) => v.note = Some(fetch_note(f, kind, name)),
    }
    true
}

/// `$(VAR)` expansion with the kubelet's rules: `$$` is a literal `$`, an
/// unknown name is left as written. Returns the text, whether a Secret
/// value went into it, and whether it needed a Secret value not revealed.
fn expand(input: &str, defined: &[EnvVar]) -> (String, bool, bool) {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let (mut secret, mut blocked) = (false, false);
    let mut i = 0;
    let mut start = 0;
    while i < b.len() {
        if b[i] == b'$' && i + 1 < b.len() {
            out.push_str(&input[start..i]);
            match b[i + 1] {
                b'$' => {
                    out.push('$');
                    i += 2;
                }
                b'(' => match input[i + 2..].find(')') {
                    Some(end) => {
                        let name = &input[i + 2..i + 2 + end];
                        match defined.iter().find(|v| v.name == name) {
                            Some(v) => {
                                secret |= v.secret;
                                match &v.value {
                                    Some(val) => out.push_str(val),
                                    None => {
                                        blocked |= v.secret;
                                        out.push_str(&format!("$({name})"));
                                    }
                                }
                            }
                            None => out.push_str(&format!("$({name})")),
                        }
                        i += 3 + end;
                    }
                    None => {
                        out.push_str("$(");
                        i += 2;
                    }
                },
                c => {
                    out.push('$');
                    out.push(c as char);
                    i += 2;
                }
            }
            start = i;
        } else {
            i += 1;
        }
    }
    if start < b.len() {
        out.push_str(&input[start..]);
    }
    (out, secret, blocked)
}

/// The downward-API fields an env var may read.
fn field_value(pod: &Value, path: &str) -> Result<String, String> {
    let s = |p: &str| str_at(pod, p).unwrap_or_default().to_string();
    let ips = |p: &str| {
        arr(pod, p)
            .filter_map(|x| str_at(x, "/ip"))
            .collect::<Vec<_>>()
            .join(",")
    };
    let keyed = |map: &str, rest: &str| -> Option<String> {
        let key = rest.strip_prefix("['")?.strip_suffix("']")?;
        Some(
            pod.pointer(&format!("/metadata/{map}"))
                .and_then(|m| m.get(key))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
        )
    };
    let v = match path {
        "metadata.name" => s("/metadata/name"),
        "metadata.namespace" => s("/metadata/namespace"),
        "metadata.uid" => s("/metadata/uid"),
        "spec.nodeName" => s("/spec/nodeName"),
        "spec.serviceAccountName" => s("/spec/serviceAccountName"),
        "status.hostIP" => s("/status/hostIP"),
        "status.hostIPs" => ips("/status/hostIPs"),
        "status.podIP" => s("/status/podIP"),
        "status.podIPs" => ips("/status/podIPs"),
        p => {
            if let Some(v) = p.strip_prefix("metadata.labels").and_then(|r| keyed("labels", r)) {
                v
            } else if let Some(v) =
                p.strip_prefix("metadata.annotations").and_then(|r| keyed("annotations", r))
            {
                v
            } else {
                return Err(format!("field {p} is not read by this view"));
            }
        }
    };
    if v.is_empty() && path.starts_with("status.") {
        return Err("not assigned yet".into());
    }
    Ok(v)
}

/// A container's request or limit as the kubelet hands it over: divided by
/// the divisor and rounded up.
fn resource_value(c: &Value, res: &str, divisor: &str) -> Result<String, String> {
    let Some((bucket, name)) = res.split_once('.') else {
        return Err(format!("unknown resource {res}"));
    };
    if bucket != "limits" && bucket != "requests" {
        return Err(format!("unknown resource {res}"));
    }
    let q = c
        .pointer(&format!("/resources/{bucket}"))
        .and_then(|m| m.get(name))
        .and_then(|v| v.as_str());
    let Some(q) = q else {
        return if bucket == "limits" {
            Err("no limit set — the node's allocatable is used".into())
        } else {
            Ok("0".into())
        };
    };
    let (n, d) = if name == "cpu" {
        (
            crate::k8s::parse_cpu(q) as i128,
            crate::k8s::parse_cpu(divisor) as i128,
        )
    } else {
        (
            crate::k8s::parse_mem(q) as i128,
            crate::k8s::parse_mem(divisor) as i128,
        )
    };
    if d <= 0 {
        return Err(format!("divisor {divisor} is not usable"));
    }
    Ok(((n + d - 1) / d).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data(pairs: &[(&str, &str)]) -> Fetched {
        Fetched::Data(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    fn pod(container: Value) -> Value {
        json!({
            "metadata": {"name": "api-1", "namespace": "prod", "labels": {"app": "api"}},
            "spec": {"nodeName": "n1", "containers": [container]},
            "status": {"podIP": "10.0.0.5"}
        })
    }

    fn var<'a>(c: &'a ContainerEnv, n: &str) -> &'a EnvVar {
        c.vars.iter().find(|v| v.name == n).unwrap()
    }

    #[test]
    fn literal_field_and_configmap() {
        let p = pod(json!({
            "name": "app",
            "env": [
                {"name": "MODE", "value": "prod"},
                {"name": "POD", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}},
                {"name": "APP", "valueFrom": {"fieldRef": {"fieldPath": "metadata.labels['app']"}}},
                {"name": "IP", "valueFrom": {"fieldRef": {"fieldPath": "status.podIP"}}},
                {"name": "LVL", "valueFrom": {"configMapKeyRef": {"name": "cfg", "key": "level"}}}
            ]
        }));
        let mut s = Sources::new();
        s.insert((RefKind::ConfigMap, "cfg".into()), data(&[("level", "debug")]));
        let c = &resolve(&p, &s)[0];
        assert_eq!(var(c, "MODE").value.as_deref(), Some("prod"));
        assert_eq!(var(c, "POD").value.as_deref(), Some("api-1"));
        assert_eq!(var(c, "APP").value.as_deref(), Some("api"));
        assert_eq!(var(c, "IP").value.as_deref(), Some("10.0.0.5"));
        assert_eq!(var(c, "LVL").value.as_deref(), Some("debug"));
        assert_eq!(var(c, "LVL").from.as_deref(), Some("cfg/level"));
    }

    #[test]
    fn secrets_stay_hidden_until_read() {
        let p = pod(json!({
            "name": "app",
            "envFrom": [{"secretRef": {"name": "bulk"}}],
            "env": [
                {"name": "PASS", "valueFrom": {"secretKeyRef": {"name": "db", "key": "pw"}}},
                {"name": "URL", "value": "pg://u:$(PASS)@h"}
            ]
        }));
        let hidden = &resolve(&p, &Sources::new())[0];
        let pass = var(hidden, "PASS");
        assert!(pass.secret && pass.value.is_none() && pass.note.is_none());
        // A value built from a hidden Secret is hidden with it.
        let url = var(hidden, "URL");
        assert!(url.secret && url.value.is_none());
        assert_eq!(hidden.pending.len(), 1);
        assert_eq!(hidden.pending[0].name, "bulk");

        let mut s = Sources::new();
        s.insert((RefKind::Secret, "db".into()), data(&[("pw", "hunter2")]));
        s.insert((RefKind::Secret, "bulk".into()), data(&[("TOKEN", "t")]));
        let shown = &resolve(&p, &s)[0];
        assert_eq!(var(shown, "URL").value.as_deref(), Some("pg://u:hunter2@h"));
        assert!(var(shown, "URL").secret);
        assert!(var(shown, "TOKEN").secret);
        assert!(shown.pending.is_empty());
    }

    #[test]
    fn forbidden_and_missing_are_said() {
        let p = pod(json!({
            "name": "app",
            "env": [
                {"name": "A", "valueFrom": {"secretKeyRef": {"name": "s", "key": "k"}}},
                {"name": "B", "valueFrom": {"configMapKeyRef": {"name": "gone", "key": "k"}}},
                {"name": "C", "valueFrom": {"configMapKeyRef": {"name": "gone", "key": "k", "optional": true}}},
                {"name": "D", "valueFrom": {"configMapKeyRef": {"name": "cfg", "key": "nope"}}}
            ]
        }));
        let mut s = Sources::new();
        s.insert((RefKind::Secret, "s".into()), Fetched::Forbidden);
        s.insert((RefKind::ConfigMap, "gone".into()), Fetched::NotFound);
        s.insert((RefKind::ConfigMap, "cfg".into()), data(&[]));
        let c = &resolve(&p, &s)[0];
        assert!(var(c, "A").note.as_deref().unwrap().starts_with("forbidden"));
        assert!(var(c, "B").note.as_deref().unwrap().contains("not found"));
        assert!(c.vars.iter().all(|v| v.name != "C"), "optional + absent sets nothing");
        assert!(var(c, "D").note.as_deref().unwrap().contains("key nope"));
    }

    #[test]
    fn env_overrides_envfrom_and_prefix_applies() {
        let p = pod(json!({
            "name": "app",
            "envFrom": [{"configMapRef": {"name": "cfg"}, "prefix": "APP_"}],
            "env": [{"name": "APP_LEVEL", "value": "warn"}]
        }));
        let mut s = Sources::new();
        s.insert((RefKind::ConfigMap, "cfg".into()), data(&[("LEVEL", "debug"), ("PORT", "80")]));
        let c = &resolve(&p, &s)[0];
        assert_eq!(var(c, "APP_PORT").value.as_deref(), Some("80"));
        let lvl = var(c, "APP_LEVEL");
        assert_eq!(lvl.value.as_deref(), Some("warn"));
        assert_eq!(lvl.overrides.as_deref(), Some("configmap cfg/LEVEL"));
        assert_eq!(c.vars.iter().filter(|v| v.name == "APP_LEVEL").count(), 1);
    }

    #[test]
    fn expansion_follows_kubelet_rules() {
        let def = |n: &str, v: &str| EnvVar {
            name: n.into(),
            value: Some(v.into()),
            source: "value",
            from: None,
            secret: false,
            note: None,
            overrides: None,
        };
        let vars = vec![def("A", "x")];
        assert_eq!(expand("$(A)-$(B)", &vars).0, "x-$(B)");
        assert_eq!(expand("$$(A)", &vars).0, "$(A)");
        assert_eq!(expand("cost $5 $(A", &vars).0, "cost $5 $(A");
        assert_eq!(expand("end$", &vars).0, "end$");
    }

    #[test]
    fn resources_round_up_by_divisor() {
        let c = json!({"resources": {"limits": {"cpu": "500m", "memory": "1Gi"}, "requests": {}}});
        assert_eq!(resource_value(&c, "limits.cpu", "1").unwrap(), "1");
        assert_eq!(resource_value(&c, "limits.cpu", "1m").unwrap(), "500");
        assert_eq!(resource_value(&c, "limits.memory", "1Mi").unwrap(), "1024");
        assert_eq!(resource_value(&c, "requests.memory", "1").unwrap(), "0");
        assert!(resource_value(&c, "limits.ephemeral-storage", "1").is_err());
    }

    #[test]
    fn init_containers_come_first() {
        let p = json!({
            "metadata": {"name": "p"},
            "spec": {
                "initContainers": [{"name": "migrate", "env": [{"name": "X", "value": "1"}]}],
                "containers": [{"name": "app"}]
            }
        });
        let r = resolve(&p, &Sources::new());
        assert_eq!(r[0].name, "migrate");
        assert!(r[0].init);
        assert_eq!(r[1].name, "app");
    }
}
