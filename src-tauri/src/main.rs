#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod estart;
mod init;
mod commands;

use init::InitState;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::Manager;
use uuid::Uuid;

fn spawn_wavesrv(auth_key: String, state: tauri::State<InitState>) {
    // Phase 0: spawn the dev-built binary by path (sidecar bundling is Phase 4).
    // CARGO_MANIFEST_DIR is the compile-time absolute path to src-tauri/, so this is robust
    // to the runtime cwd (cargo runs the binary with cwd = manifest dir, not the project root).
    let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/bin/wavesrv.x64.exe");
    // Isolated data/config home in temp. wavesrv hard-requires both vars (wavebase.CacheAndRemoveEnvVars)
    // and resolves its DB/socket/lock from the data home — pointing them here keeps the spike's backend
    // fully sandboxed from the real Wave app's default data dir.
    let spike_home = std::env::temp_dir().join("wave-tauri-spike");
    let data_home = spike_home.join("data");
    let config_home = spike_home.join("config");
    let _ = std::fs::create_dir_all(&data_home);
    let _ = std::fs::create_dir_all(&config_home);
    let mut child = Command::new(&exe)
        .env("WAVETERM_AUTH_KEY", &auth_key)
        .env("WAVETERM_DATA_HOME", &data_home)
        .env("WAVETERM_CONFIG_HOME", &config_home)
        // inherit stdout (we only read stderr) so an unread stdout pipe can't fill and deadlock wavesrv.
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn wavesrv at {:?}: {}", exe, e));

    let stderr = child.stderr.take().unwrap();
    let state_data = state.0.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if line.starts_with("WAVESRV-EVENT:") {
                continue; // same stream carries event JSON; ignore for the spike
            }
            if let Some(info) = estart::parse_estart(&line) {
                let mut d = state_data.lock().unwrap();
                d.ws_endpoint = info.ws;
                d.web_endpoint = info.web;
                d.version = info.version;
                d.build_time = info.buildtime;
                println!("[tauri] wavesrv ready: {:?}", *d);
            } else {
                println!("[wavesrv] {}", line);
            }
        }
    });
}

fn main() {
    let auth_key = Uuid::new_v4().to_string();
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(InitState::default())
        .invoke_handler(tauri::generate_handler![
            init::get_init,
            init::fe_log,
            commands::set_window_init_status,
            commands::set_is_active,
            commands::open_external,
            commands::increment_term_commands
        ])
        .setup(move |app| {
            // seed the static identity fields before wavesrv parsing fills in the endpoints.
            {
                let state = app.state::<InitState>();
                let mut d = state.0.lock().unwrap();
                d.auth_key = auth_key.clone();
                d.platform = "win32".to_string();
                d.is_dev = cfg!(debug_assertions);
                d.user_name = std::env::var("USERNAME").unwrap_or_default();
                d.host_name = std::env::var("COMPUTERNAME").unwrap_or_default();
            }
            spawn_wavesrv(auth_key.clone(), app.state::<InitState>());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
