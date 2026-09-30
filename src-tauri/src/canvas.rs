// Native side of the Agent surface's canvas mode: a whole-window capture (the canvas iframe is
// cross-origin, so the page cannot read its pixels) and a detached python server for a
// design-local root.
use crate::applog::log_line;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const PORT_MIN: u16 = 1024;

pub fn validate_server_args(dir: &Path, port: u16) -> Result<PathBuf, String> {
    if port < PORT_MIN {
        return Err(format!("port {port} is below {PORT_MIN}"));
    }
    let real = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut tail = real
        .components()
        .rev()
        .map(|c| c.as_os_str().to_string_lossy().to_string());
    // only ever serve a design-local root, never an arbitrary folder
    if tail.next().as_deref() != Some("design") || tail.next().as_deref() != Some(".superpowers") {
        return Err(format!("{} is not a .superpowers/design folder", real.display()));
    }
    Ok(real)
}

#[tauri::command]
pub fn start_canvas_server(dir: String, port: u16) -> Result<(), String> {
    let result = spawn_canvas_server(&dir, port);
    if let Err(e) = &result {
        log_line(&format!("[canvas-server] {dir} on {port}: {e}"));
    }
    result
}

fn spawn_canvas_server(dir: &str, port: u16) -> Result<(), String> {
    let real = validate_server_args(Path::new(dir), port)?;
    let mut cmd = std::process::Command::new("python");
    cmd.args(["-m", "http.server", &port.to_string(), "--bind", "127.0.0.1", "--directory"])
        .arg(&real)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // detached so the server outlives Arc like one the agent started itself, with no console window
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("starting python: {e}"))
}

#[cfg(windows)]
#[tauri::command]
pub async fn capture_webview(window: tauri::WebviewWindow) -> Result<tauri::ipc::Response, String> {
    let result = capture_png(&window).await;
    if let Err(e) = &result {
        log_line(&format!("[capture] {e}"));
    }
    result.map(tauri::ipc::Response::new)
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn capture_webview(_window: tauri::WebviewWindow) -> Result<tauri::ipc::Response, String> {
    Err("window capture is Windows-only".to_string())
}

#[cfg(windows)]
async fn capture_png(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    use std::cell::RefCell;
    use std::rc::Rc;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |wv| unsafe {
            // runs on the main thread; CapturePreview completes asynchronously into the stream,
            // so the sender is shared between the setup-error path and the completion handler
            let tx = Rc::new(RefCell::new(Some(tx)));
            let send = {
                let tx = tx.clone();
                move |out: Result<Vec<u8>, String>| {
                    if let Some(tx) = tx.borrow_mut().take() {
                        let _ = tx.send(out);
                    }
                }
            };
            let done = send.clone();
            let setup = (|| -> Result<(), String> {
                let core = wv.controller().CoreWebView2().map_err(|e| e.to_string())?;
                let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true).map_err(|e| e.to_string())?;
                let keep = stream.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
                    done(res.map_err(|e| e.to_string()).and_then(|_| read_all(&keep)));
                    Ok(())
                }));
                core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
                    .map_err(|e| e.to_string())
            })();
            if let Err(e) = setup {
                send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "capture was dropped".to_string())?
}

#[cfg(windows)]
unsafe fn read_all(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    const CHUNK: usize = 64 * 1024;

    stream.Seek(0, STREAM_SEEK_SET, None).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let mut read = 0u32;
        stream
            .Read(buf.as_mut_ptr().cast(), CHUNK as u32, Some(&mut read))
            .ok()
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Ok(out);
        }
        out.extend_from_slice(&buf[..read as usize]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arc-canvas-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_privileged_and_zero_ports() {
        let root = temp_dir("ports");
        let design = root.join(".superpowers").join("design");
        fs::create_dir_all(&design).unwrap();
        assert!(validate_server_args(&design, 80).is_err());
        assert!(validate_server_args(&design, 0).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_missing_dir() {
        let root = temp_dir("missing");
        let design = root.join(".superpowers").join("design");
        assert!(validate_server_args(&design, 8766).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_dir_not_named_superpowers_design() {
        let root = temp_dir("other");
        assert!(validate_server_args(&root, 8766).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_a_superpowers_design_dir() {
        let root = temp_dir("accept");
        let design = root.join(".superpowers").join("design");
        fs::create_dir_all(&design).unwrap();
        let real = validate_server_args(&design, 8766).unwrap();
        assert!(real.ends_with(Path::new(".superpowers").join("design")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_path_that_climbs_out_of_design() {
        let root = temp_dir("climb");
        let design = root.join(".superpowers").join("design");
        fs::create_dir_all(&design).unwrap();
        fs::create_dir_all(root.join(".superpowers").join("x")).unwrap();
        assert!(validate_server_args(&design.join("..").join("x"), 8766).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
