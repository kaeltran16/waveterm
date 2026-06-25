#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod estart;
mod init;
mod commands;
mod paths;

use init::InitState;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::Manager;
use uuid::Uuid;

fn spawn_wavesrv(auth_key: String, app_path: PathBuf, data_base: PathBuf, state: tauri::State<InitState>) {
    // Packaged: app_path = resource_dir(); dev: app_path = src-tauri/../dist (paths::resolve_app_path).
    // wavesrv + wsh both live under {app_path}/bin; wavesrv discovers wsh via WAVETERM_APP_PATH.
    let exe = app_path.join("bin").join("wavesrv.x64.exe");
    let (data_home, config_home) = paths::data_home_dirs(&data_base);
    let _ = std::fs::create_dir_all(&data_home);
    let _ = std::fs::create_dir_all(&config_home);
    let mut child = Command::new(&exe)
        .env("WAVETERM_AUTH_KEY", &auth_key)
        .env("WAVETERM_APP_PATH", &app_path)
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
    // dev-only: expose WebView2's Chrome DevTools Protocol on :9222 for visual verification.
    // WebView2 reads extra Chromium args from this env var before the webview is created.
    #[cfg(debug_assertions)]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9222");
    }
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
            let is_dev = cfg!(debug_assertions);
            let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            // resource_dir() only matters when packaged; avoid calling it in dev.
            let resource_dir = if is_dev { PathBuf::new() } else { app.path().resource_dir()? };
            let app_path = paths::resolve_app_path(is_dev, manifest_dir, &resource_dir);
            let data_base = app.path().app_local_data_dir()?;
            spawn_wavesrv(auth_key.clone(), app_path, data_base, app.state::<InitState>());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
