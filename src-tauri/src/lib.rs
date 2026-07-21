mod k8s;

use k8s::{AppState, ContextInfo, ResourceDetail, ResourceTable, ResourceType};
use tauri::ipc::Channel;
use tauri::State;

#[tauri::command]
async fn list_contexts(paths: Option<Vec<String>>) -> Result<Vec<ContextInfo>, String> {
    k8s::list_contexts(paths.unwrap_or_default()).await
}

#[tauri::command]
async fn connect(
    state: State<'_, AppState>,
    context: String,
    path: Option<String>,
) -> Result<String, String> {
    k8s::connect(&state, context, path).await
}

#[tauri::command]
async fn auth_hint(context: String, path: Option<String>) -> Result<k8s::AuthHint, String> {
    k8s::auth_hint(context, path).await
}

#[tauri::command]
async fn auth_login(context: String, path: Option<String>) -> Result<(), String> {
    k8s::auth_login(context, path).await
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, context: String) -> Result<(), String> {
    k8s::disconnect(&state, context).await
}

#[tauri::command]
async fn discover(
    state: State<'_, AppState>,
    context: String,
) -> Result<Vec<ResourceType>, String> {
    k8s::discover(&state, context).await
}

#[tauri::command]
async fn list_resources(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
    channel: Channel<serde_json::Value>,
) -> Result<ResourceTable, String> {
    k8s::list_resources(&state, context, resource, namespace, field_selector, channel).await
}

#[tauri::command]
async fn cached_list(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
) -> Result<Option<ResourceTable>, String> {
    k8s::cached_list(&state, context, resource, namespace, field_selector).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn watch_start(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    field_selector: Option<String>,
    resource_version: String,
    include: String,
    channel: Channel<serde_json::Value>,
) -> Result<u32, String> {
    k8s::watch_start(
        &state,
        context,
        resource,
        namespace,
        field_selector,
        resource_version,
        include,
        channel,
    )
    .await
}

#[tauri::command]
async fn watch_stop(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    k8s::watch_stop(&state, id).await
}

#[tauri::command]
async fn get_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    name: String,
) -> Result<ResourceDetail, String> {
    k8s::get_resource(&state, context, resource, namespace, name).await
}

#[tauri::command]
async fn apply_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    name: String,
    yaml: String,
    resource_version: Option<String>,
    force: bool,
) -> Result<(), String> {
    k8s::apply_resource(
        &state,
        context,
        resource,
        namespace,
        name,
        yaml,
        resource_version,
        force,
    )
    .await
}

#[tauri::command]
async fn create_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    yaml: String,
) -> Result<String, String> {
    k8s::create_resource(&state, context, resource, namespace, yaml).await
}

#[tauri::command]
async fn delete_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    name: String,
    force: bool,
) -> Result<(), String> {
    k8s::delete_resource(&state, context, resource, namespace, name, force).await
}

#[tauri::command]
async fn cordon_node(
    state: State<'_, AppState>,
    context: String,
    name: String,
    on: bool,
) -> Result<(), String> {
    k8s::cordon_node(&state, context, name, on).await
}

#[tauri::command]
async fn drain_node(
    state: State<'_, AppState>,
    context: String,
    name: String,
) -> Result<String, String> {
    k8s::drain_node(&state, context, name).await
}

#[tauri::command]
async fn scale_resource(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    name: String,
    replicas: i64,
) -> Result<(), String> {
    k8s::scale_resource(&state, context, resource, namespace, name, replicas).await
}

#[tauri::command]
async fn restart_rollout(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: Option<String>,
    name: String,
) -> Result<(), String> {
    k8s::restart_rollout(&state, context, resource, namespace, name).await
}

#[tauri::command]
async fn exec_start(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    command: Option<String>,
    channel: Channel<String>,
) -> Result<u32, String> {
    k8s::exec_start(&state, context, namespace, pod, container, command, channel).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn node_shell_start(
    state: State<'_, AppState>,
    context: String,
    node: String,
    name: Option<String>,
    image: Option<String>,
    shell_namespace: Option<String>,
    cpu_limit: Option<String>,
    memory_limit: Option<String>,
    channel: Channel<String>,
) -> Result<u32, String> {
    k8s::node_shell_start(
        &state,
        context,
        node,
        name,
        image,
        shell_namespace,
        cpu_limit,
        memory_limit,
        channel,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn log_start(
    state: State<'_, AppState>,
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
    k8s::log_start(
        &state, context, namespace, pod, container, tail, previous, since_seconds, timestamps,
        follow, channel,
    )
    .await
}

#[tauri::command]
async fn logs_selector_start(
    state: State<'_, AppState>,
    context: String,
    resource: ResourceType,
    namespace: String,
    name: String,
    channel: Channel<String>,
) -> Result<u32, String> {
    k8s::logs_selector_start(&state, context, resource, namespace, name, channel).await
}

#[tauri::command]
async fn pf_start(
    state: State<'_, AppState>,
    context: String,
    namespace: String,
    pod: String,
    port: u16,
) -> Result<k8s::PfInfo, String> {
    k8s::pf_start(&state, context, namespace, pod, port).await
}

#[tauri::command]
async fn pf_list(state: State<'_, AppState>) -> Result<Vec<k8s::PfInfo>, String> {
    k8s::pf_list(&state).await
}

#[tauri::command]
async fn pf_stop(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    k8s::pf_stop(&state, id).await
}

#[tauri::command]
async fn exec_stdin(state: State<'_, AppState>, id: u32, data: String) -> Result<(), String> {
    k8s::exec_stdin(&state, id, data).await
}

#[tauri::command]
async fn exec_resize(
    state: State<'_, AppState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    k8s::exec_resize(&state, id, cols, rows).await
}

#[tauri::command]
async fn exec_stop(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    k8s::exec_stop(&state, id).await
}

#[tauri::command]
async fn get_events(
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
    name: String,
    kind: String,
) -> Result<Vec<k8s::EventInfo>, String> {
    k8s::get_events(&state, context, namespace, name, kind).await
}

#[tauri::command]
async fn pod_stats(
    state: State<'_, AppState>,
    context: String,
    namespace: Option<String>,
) -> Result<Vec<k8s::PodStat>, String> {
    k8s::pod_stats(&state, context, namespace).await
}

#[tauri::command]
async fn ensure_index(state: State<'_, AppState>) -> Result<(), String> {
    k8s::ensure_index(&state).await
}

#[tauri::command]
async fn filter_rows(state: State<'_, AppState>, query: String) -> Result<Vec<String>, String> {
    k8s::filter_rows(&state, query).await
}

#[tauri::command]
async fn list_namespaces(
    state: State<'_, AppState>,
    context: String,
) -> Result<Vec<String>, String> {
    k8s::list_namespaces(&state, context).await
}

#[tauri::command]
async fn count_resources(
    state: State<'_, AppState>,
    context: String,
    types: Vec<ResourceType>,
) -> Result<Vec<(String, usize)>, String> {
    k8s::count_resources(&state, context, types).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // The default macOS menu binds ⌘W to "Close Window", which
            // would throw away every open cluster tab. Build the menu
            // without it so ⌘W reaches the app and closes just the
            // thing you are looking at. Edit stays for terminal copy
            // and paste.
            use tauri::menu::{MenuBuilder, SubmenuBuilder};
            let app_menu = SubmenuBuilder::new(app, "PigeonEye")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window = SubmenuBuilder::new(app, "Window")
                .minimize()
                .fullscreen()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit, &window])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            connect,
            disconnect,
            auth_hint,
            auth_login,
            discover,
            list_resources,
            cached_list,
            watch_start,
            watch_stop,
            get_resource,
            apply_resource,
            create_resource,
            delete_resource,
            cordon_node,
            drain_node,
            scale_resource,
            restart_rollout,
            exec_start,
            node_shell_start,
            log_start,
            logs_selector_start,
            pf_start,
            pf_list,
            pf_stop,
            exec_stdin,
            exec_resize,
            exec_stop,
            get_events,
            pod_stats,
            ensure_index,
            filter_rows,
            list_namespaces,
            count_resources
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
