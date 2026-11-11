use crate::applog::log_line;
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
    log_line(&format!("[init-status] {}", status));
    if status == "ready" {
        let opts = WaveInitOpts {
            tab_id: String::new(),
            client_id: String::new(),
            window_id: String::new(),
            activate: true,
        };
        if let Err(e) = app.emit("wave-init", opts) {
            log_line(&format!("[init-status] emit wave-init failed: {}", e));
        }
    }
}

// The webview renders model-controlled markdown; the OS opener (ShellExecute "open" on Windows)
// launches executables and file:// paths, so only schemes the model can legitimately want are
// allowed. Anything else is rejected and logged rather than handed to the opener. A well-formed
// URL percent-encodes quotes, whitespace and control characters, so a raw one is refused too: it
// can only be an attempt to break out of an argument.
fn is_allowed_external_url(url: &str) -> bool {
    if url.chars().any(|c| c == '"' || c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some(scheme) = url.split_once(':').map(|(s, _)| s.to_ascii_lowercase()) else {
        return false;
    };
    matches!(scheme.as_str(), "http" | "https" | "mailto")
}

#[tauri::command]
pub fn open_external(url: String) {
    if !is_allowed_external_url(&url) {
        log_line(&format!(
            "[open-external] rejected URL with non-allowlisted scheme: {}",
            url
        ));
        return;
    }
    // that_detached with shellexecute-on-windows hands the URL to ShellExecuteExW as one string;
    // open::that runs `cmd /c start` with it, where the shell parses it
    if let Err(e) = open::that_detached(&url) {
        log_line(&format!("[open-external] failed to open {}: {}", url, e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_http_https_mailto() {
        assert!(is_allowed_external_url("https://example.com/page"));
        assert!(is_allowed_external_url("http://localhost:3000"));
        assert!(is_allowed_external_url("mailto:dev@example.com"));
    }

    #[test]
    fn scheme_match_is_case_insensitive() {
        assert!(is_allowed_external_url("HTTPS://example.com"));
        assert!(is_allowed_external_url("MailTo:dev@example.com"));
    }

    #[test]
    fn rejects_other_schemes_and_schemeless_urls() {
        // ShellExecute would launch executables via file:// or a bare path
        assert!(!is_allowed_external_url(
            "file:///C:/Windows/System32/notepad.exe"
        ));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
        assert!(!is_allowed_external_url("C:\\Windows\\notepad.exe"));
        assert!(!is_allowed_external_url("\\\\.\\pipe\\x"));
        assert!(!is_allowed_external_url("example.com/page"));
        assert!(!is_allowed_external_url(""));
    }

    #[test]
    fn rejects_urls_that_could_break_out_of_an_argument() {
        // a raw quote closed `cmd /c start "" "<url>"` and ran what followed it
        assert!(!is_allowed_external_url("https://example.com/\"&calc.exe&\""));
        assert!(!is_allowed_external_url("https://example.com/a b"));
        assert!(!is_allowed_external_url("https://example.com/
x"));
        assert!(!is_allowed_external_url("https://example.com/	x"));
    }

    #[test]
    fn accepts_encoded_and_query_urls() {
        assert!(is_allowed_external_url("https://example.com/%22&calc.exe&%22"));
        assert!(is_allowed_external_url("https://example.com/a%20b?x=1&y=2#frag"));
        assert!(is_allowed_external_url("mailto:dev@example.com?subject=hi%20there"));
    }
}
