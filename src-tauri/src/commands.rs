use tauri::{AppHandle, Emitter};

// Phase 1 minimal wave-init payload — proves the Rust→FE event round-trip.
// The real WaveInitOpts (tabId/clientId/windowId from window/workspace state) is
// assembled in Phase 5 when the real boot path comes online.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveInitOpts {
    pub tab_id: String,
    pub client_id: String,
    pub window_id: String,
    pub activate: bool,
}

#[tauri::command]
pub fn set_window_init_status(app: AppHandle, status: String) {
    println!("[init-status] {}", status);
    if status == "ready" {
        let opts = WaveInitOpts {
            tab_id: String::new(),
            client_id: String::new(),
            window_id: String::new(),
            activate: true,
        };
        if let Err(e) = app.emit("wave-init", opts) {
            eprintln!("[init-status] emit wave-init failed: {}", e);
        }
    }
}

#[tauri::command]
pub fn set_is_active() {
    // Phase 1: acknowledge only (Electron sets an internal wasActive flag).
}

#[tauri::command]
pub fn open_external(url: String) {
    if let Err(e) = open::that(&url) {
        eprintln!("[open-external] failed to open {}: {}", url, e);
    }
}

#[tauri::command]
pub fn increment_term_commands() {
    // Phase 1: telemetry sink no-op (Electron increments command counters).
}
