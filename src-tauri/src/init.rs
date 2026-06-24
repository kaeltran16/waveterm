use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitData {
    pub ws_endpoint: String,
    pub web_endpoint: String,
    pub auth_key: String,
    pub version: String,
    pub build_time: i64,
    pub platform: String,
    pub is_dev: bool,
    pub user_name: String,
    pub host_name: String,
}

#[derive(Default)]
pub struct InitState(pub Arc<Mutex<InitData>>);

#[tauri::command]
pub fn get_init(state: tauri::State<InitState>) -> InitData {
    state.0.lock().unwrap().clone()
}

// backs both getApi().sendLog and the harness's hlog. Renamed from harness_log:
// the WebView2 console isn't observable from the dev loop, so logs land in the Rust console.
#[tauri::command]
pub fn fe_log(msg: String) {
    println!("[fe-log] {}", msg);
}
