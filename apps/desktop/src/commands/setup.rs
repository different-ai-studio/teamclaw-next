use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Tauri event name carrying `SetupProgress` to the first-run wizard UI.
const SETUP_PROGRESS_EVENT: &str = "setup-progress";
/// Per-user amuxd state directory (under the home dir).
const AMUXD_DIR: &str = ".amuxd";

/// One installable/checkable prerequisite shown in the first-run wizard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementStatus {
    pub id: String,
    pub title: String,
    pub optional: bool,
    pub present: bool,
    pub version: Option<String>,
}

/// True if `~/.amuxd/bin/<name>` (or the .exe variant on Windows) exists under `home`.
fn bin_present(home: &Path, name_unix: &str, name_win: &str) -> bool {
    let name = if cfg!(windows) { name_win } else { name_unix };
    home.join(AMUXD_DIR).join("bin").join(name).exists()
}

/// Rust target triple for the current host (matches the sidecar naming convention).
fn target_triple() -> String {
    let arch = std::env::consts::ARCH;
    match std::env::consts::OS {
        "macos" => format!("{arch}-apple-darwin"),
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        other => format!("{arch}-unknown-{other}"),
    }
}

/// `git --version` first line, or None if git is unavailable.
fn detect_git() -> Option<String> {
    let out = std::process::Command::new("git")
        .args(["--version"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Resolve an executable path, trying a `.exe` suffix on Windows. Mirrors opencode.rs.
fn resolve_exe(path: PathBuf) -> Option<PathBuf> {
    if path.exists() {
        return Some(path);
    }
    if cfg!(windows) {
        let mut with_exe = path.into_os_string();
        with_exe.push(".exe");
        let with_exe = PathBuf::from(with_exe);
        if with_exe.exists() {
            return Some(with_exe);
        }
    }
    None
}

/// Locate the amuxd binary bundled with the app (dev: apps/desktop/binaries; prod: next to exe).
fn locate_bundled_amuxd() -> Option<PathBuf> {
    let triple = target_triple();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("amuxd-{triple}"));
    if let Some(p) = resolve_exe(dev) {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for cand in [format!("amuxd-{triple}"), "amuxd".to_string()] {
        if let Some(p) = resolve_exe(dir.join(cand)) {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
pub async fn setup_list_requirements<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<RequirementStatus>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;

    let git_version = detect_git();
    let amuxd_present = bin_present(&home, "amuxd", "amuxd.exe");
    let opencode_present = bin_present(&home, "opencode", "opencode.exe");

    Ok(vec![
        RequirementStatus {
            id: "amuxd".into(),
            title: "Agent daemon (amuxd)".into(),
            optional: false,
            present: amuxd_present,
            version: None,
        },
        RequirementStatus {
            id: "opencode".into(),
            title: "OpenCode runtime".into(),
            optional: false,
            present: opencode_present,
            version: None,
        },
        RequirementStatus {
            id: "git".into(),
            title: "Git".into(),
            optional: true,
            present: git_version.is_some(),
            version: git_version,
        },
    ])
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub id: String,
    /// "started" | "running" | "done" | "failed"
    pub status: String,
    pub line: Option<String>,
    pub error: Option<String>,
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, p: SetupProgress) {
    let _ = app.emit(SETUP_PROGRESS_EVENT, p);
}

/// Copy the bundled amuxd binary into ~/.amuxd/bin/amuxd (install only — no service/start).
fn install_amuxd<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(app, SetupProgress { id: "amuxd".into(), status: "started".into(), line: None, error: None });
    let src = locate_bundled_amuxd().ok_or_else(|| "bundled amuxd binary not found".to_string())?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let bin_dir = home.join(AMUXD_DIR).join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let dest = bin_dir.join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" });
    std::fs::copy(&src, &dest).map_err(|e| format!("copy amuxd failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }
    emit_progress(app, SetupProgress { id: "amuxd".into(), status: "done".into(), line: None, error: None });
    Ok(())
}

/// Run the bundled `amuxd install-opencode` sidecar, streaming its JSON progress lines.
async fn install_opencode<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    emit_progress(app, SetupProgress { id: "opencode".into(), status: "started".into(), line: None, error: None });
    // `_child_guard` must stay alive until `rx` is fully drained: dropping the
    // CommandChild early can terminate the sidecar before install finishes.
    let (mut rx, _child_guard) = app
        .shell()
        .sidecar("amuxd")
        .map_err(|e| format!("sidecar amuxd: {e}"))?
        .args(["install-opencode"])
        .spawn()
        .map_err(|e| format!("spawn amuxd: {e}"))?;

    // Note: we record failure in `last_err` and only act on it after the event
    // loop ends — Terminated is not guaranteed to be the final event, so we keep
    // draining stdout/stderr after it before deciding success/failure.
    let mut last_err: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit_progress(app, SetupProgress { id: "opencode".into(), status: "running".into(), line: Some(line), error: None });
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    emit_progress(app, SetupProgress { id: "opencode".into(), status: "running".into(), line: Some(line), error: None });
                }
            }
            CommandEvent::Terminated(payload) if payload.code.unwrap_or(-1) != 0 => {
                last_err = Some(format!("amuxd install-opencode exited with code {:?}", payload.code));
            }
            _ => {}
        }
    }
    if let Some(e) = last_err {
        emit_progress(app, SetupProgress { id: "opencode".into(), status: "failed".into(), line: None, error: Some(e.clone()) });
        return Err(e);
    }
    emit_progress(app, SetupProgress { id: "opencode".into(), status: "done".into(), line: None, error: None });
    Ok(())
}

/// Best-effort git install guidance. macOS triggers the Xcode CLT installer; other
/// platforms return an error so the UI shows manual instructions (git is optional).
///
/// On macOS this returns Ok as soon as the Xcode CLT dialog is spawned — git is
/// not actually present yet, and `xcode-select --install` exits non-zero when the
/// tools are already installed (we intentionally don't treat that as an error).
/// The caller should re-poll `setup_list_requirements` to confirm git presence.
fn install_git<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    emit_progress(app, SetupProgress { id: "git".into(), status: "started".into(), line: None, error: None });
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("xcode-select")
            .arg("--install")
            .status()
            .map_err(|e| format!("xcode-select: {e}"))?;
        emit_progress(app, SetupProgress { id: "git".into(), status: "running".into(), line: Some("Follow the macOS installer dialog to install Command Line Tools.".into()), error: None });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Please install git from https://git-scm.com/downloads and re-check.".into())
    }
}

#[tauri::command]
pub async fn setup_install<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    match id.as_str() {
        "amuxd" => install_amuxd(&app),
        "opencode" => install_opencode(&app).await,
        "git" => install_git(&app),
        other => Err(format!("unknown requirement: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_bin_present_and_absent() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert!(!bin_present(home, "amuxd", "amuxd.exe"));
        let bin = home.join(".amuxd").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let name = if cfg!(windows) { "amuxd.exe" } else { "amuxd" };
        std::fs::write(bin.join(name), b"x").unwrap();
        assert!(bin_present(home, "amuxd", "amuxd.exe"));
    }

    #[test]
    fn target_triple_has_dash() {
        assert!(target_triple().contains('-'));
    }

    #[test]
    fn resolve_exe_finds_plain_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("amuxd-some-triple");
        assert!(resolve_exe(p.clone()).is_none());
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(resolve_exe(p.clone()), Some(p));
    }
}
