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
}

#[derive(Default)]
pub struct InitState(pub Arc<Mutex<InitData>>);

#[tauri::command]
pub fn get_init(state: tauri::State<InitState>) -> InitData {
    state.0.lock().unwrap().clone()
}

// bridge: the harness routes its console/milestones here so they land in the Rust console
// (the WebView2 console isn't observable from the dev loop).
#[tauri::command]
pub fn harness_log(msg: String) {
    println!("[harness] {}", msg);
}
