#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod estart;
mod init;
mod commands;
mod paths;

use init::InitState;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;
use uuid::Uuid;

// Holds the spawned wavesrv so we can kill it on app exit. Without this the backend orphans when
// the window closes (Windows doesn't kill a child on parent exit) and the stale wavesrv keeps
// holding wave.lock + its own exe open — blocking the next launch and even reinstalls.
struct WavesrvChild(Mutex<Option<Child>>);

fn spawn_wavesrv(auth_key: String, app_path: PathBuf, data_base: PathBuf, state: tauri::State<InitState>) -> Child {
    // Packaged: app_path = resource_dir(); dev: app_path = src-tauri/../dist (paths::resolve_app_path).
    // wavesrv + wsh both live under {app_path}/bin; wavesrv discovers wsh via WAVETERM_APP_PATH.
    let exe = app_path.join("bin").join("wavesrv.x64.exe");
    let (data_home, config_home) = paths::data_home_dirs(&data_base);
    let _ = std::fs::create_dir_all(&data_home);
    let _ = std::fs::create_dir_all(&config_home);
    let mut cmd = Command::new(&exe);
    cmd.env("WAVETERM_AUTH_KEY", &auth_key)
        .env("WAVETERM_APP_PATH", &app_path)
        .env("WAVETERM_DATA_HOME", &data_home)
        .env("WAVETERM_CONFIG_HOME", &config_home)
        // wavesrv logs to stderr (which we parse); discard stdout so an unread pipe can't
        // fill and deadlock it.
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // wavesrv is a console-subsystem exe. A GUI (no-console) parent spawning it without this
    // flag makes Windows pop a separate console window for it — and closing that window sends
    // CTRL_CLOSE_EVENT, killing wavesrv and the whole backend. Run it with no console.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn wavesrv at {:?}: {}", exe, e));

    let stderr = child.stderr.take().unwrap();
    let state_data = state.0.clone();
    let ready = state.1.clone();
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
                drop(d); // release before waking get_init so it doesn't re-block on the lock
                ready.notify_all();
            } else {
                println!("[wavesrv] {}", line);
            }
        }
    });

    child
}

fn main() {
    let context = tauri::generate_context!();
    // WebView2 reads these env vars before the webview is created, so they must be set here in
    // main (before the Tauri builder), not in the setup hook. Dev-only: compiled out of packaged.
    #[cfg(debug_assertions)]
    {
        // expose WebView2's Chrome DevTools Protocol on :9222 for visual verification.
        if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9222");
        }
        // Isolate dev's WebView2 profile from a co-installed packaged build (same identifier =>
        // same default EBWebView profile). Sharing it lets a dev launch kill the running packaged
        // app's window+wavesrv. See paths::dev_webview_data_dir.
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                let app_local_data = PathBuf::from(local).join(&context.config().identifier);
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", paths::dev_webview_data_dir(&app_local_data));
            }
        }
    }
    let auth_key = Uuid::new_v4().to_string();
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(InitState::default())
        .manage(WavesrvChild(Mutex::new(None)))
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
            let data_base = paths::data_base_for(&app.path().app_local_data_dir()?, is_dev);
            let child = spawn_wavesrv(auth_key.clone(), app_path, data_base, app.state::<InitState>());
            app.state::<WavesrvChild>().0.lock().unwrap().replace(child);
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill wavesrv when the app exits so it doesn't orphan and hold wave.lock + its exe.
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app_handle.state::<WavesrvChild>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
