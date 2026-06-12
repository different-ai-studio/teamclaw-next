//! opencode discovery + install for amuxd.
//!
//! Policy (decided 2026-06-02): prefer the machine's opencode. opencode is
//! installed via its OFFICIAL installer into its own default dir `~/.opencode/bin`
//! (NOT into ~/.amuxd). `opencode.lock.json` records the MINIMUM version amuxd
//! requires; if the machine's opencode is older we upgrade, otherwise we leave it.
//!
//! amuxd resolves opencode by absolute path (`~/.opencode/bin/opencode`) so a
//! background launchd/systemd service finds it without a login PATH.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct OpencodeLock {
    pub version: String,
}

impl OpencodeLock {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(s)?)
    }
}

/// Embedded at compile time from apps/daemon/opencode.lock.json
pub const LOCK_JSON: &str = include_str!("../../opencode.lock.json");

/// The minimum opencode version this build requires (lock version, without a leading `v`).
pub fn required_version() -> String {
    OpencodeLock::parse(LOCK_JSON)
        .map(|l| l.version.trim().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

/// opencode's official installer always installs to `~/.opencode/bin` (hardcoded upstream).
pub fn opencode_default_bin() -> Option<PathBuf> {
    let name = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    dirs::home_dir().map(|h| h.join(".opencode").join("bin").join(name))
}

/// Resolve the opencode binary amuxd should run. Order:
///   explicit daemon.toml config -> ~/.opencode/bin/opencode (absolute) -> "opencode" (PATH).
/// The absolute step matters for a background service whose PATH excludes ~/.opencode/bin.
fn resolve_binary_with(configured: Option<&str>, default_bin: Option<PathBuf>) -> String {
    if let Some(b) = configured {
        // AgentBackendConfig.binary serde default is the shared "claude"; when
        // [agents.opencode] exists but omits `binary`, treat that as "not configured".
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    if let Some(p) = default_bin {
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "opencode".to_string()
}

pub fn resolve_binary(configured: Option<&str>) -> String {
    resolve_binary_with(configured, opencode_default_bin())
}

/// Parse a dotted version ("1.15.13" / "v1.15.13" / "1.15.13-beta") into (major, minor, patch).
pub fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches('v');
    let core = s
        .split(|c: char| c == '-' || c == '+' || c.is_whitespace())
        .next()
        .unwrap_or("");
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().unwrap_or("0").parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// True if `have` >= `want` by semver. Unparseable `have` -> false (treat as needs-install).
pub fn version_ge(have: &str, want: &str) -> bool {
    match (parse_semver(have), parse_semver(want)) {
        (Some(h), Some(w)) => h >= w,
        _ => false,
    }
}

/// `<bin> --version`, returning the first token that looks like a version.
fn opencode_version_of(bin: &str) -> Option<String> {
    let out = std::process::Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next().unwrap_or("").trim();
    line.split_whitespace()
        .find(|tok| parse_semver(tok).is_some())
        .map(|t| t.to_string())
        .or_else(|| (!line.is_empty()).then(|| line.to_string()))
}

/// Detect the opencode amuxd would run + its reported version.
pub fn detect_opencode() -> Option<(String, String)> {
    let bin = resolve_binary(None);
    let version = opencode_version_of(&bin)?;
    Some((bin, version))
}

fn progress(event: &str, message: &str) {
    println!("{}", serde_json::json!({ "event": event, "message": message }));
}

/// Official opencode release asset for a Windows arch (std::env::consts::ARCH names).
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_zip_asset(arch: &str) -> Option<&'static str> {
    match arch {
        "x86_64" => Some("opencode-windows-x64.zip"),
        "aarch64" => Some("opencode-windows-arm64.zip"),
        _ => None,
    }
}

/// Download URL for a Windows asset. `base_override` comes from the
/// OPENCODE_DOWNLOAD_BASE env var (mirror escape hatch for slow networks).
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_download_url(base_override: Option<&str>, asset: &str) -> String {
    let base = base_override
        .unwrap_or("https://github.com/sst/opencode/releases/latest/download")
        .trim_end_matches('/');
    format!("{base}/{asset}")
}

/// Minimal system PATH for subprocesses spawned from a GUI/sidecar context.
/// Dock-launched apps (and their sidecars) often inherit an empty PATH; the
/// official opencode install script calls `mkdir`, `curl`, `unzip`, etc. by name.
#[cfg(not(windows))]
fn minimal_system_path() -> &'static str {
    if cfg!(target_os = "macos") {
        "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
    } else if cfg!(target_os = "linux") {
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    } else {
        ""
    }
}

#[cfg(not(windows))]
fn install_command_path() -> String {
    let base = minimal_system_path();
    match std::env::var("PATH") {
        Ok(existing) if !existing.trim().is_empty() => format!("{existing}:{base}"),
        _ => base.to_string(),
    }
}

/// Install or upgrade opencode to satisfy the required version using opencode's
/// OFFICIAL installer (installs latest into ~/.opencode/bin). Latest always
/// satisfies our minimum. On Windows the official path is a package manager, so
/// we return guidance instead of running a curl|bash that doesn't exist there.
pub fn run_install(force: bool) -> anyhow::Result<()> {
    let want = required_version();

    if !force {
        if let Some((path, have)) = detect_opencode() {
            if version_ge(&have, &want) {
                progress("ok", &format!("opencode {have} already satisfies >= {want} ({path})"));
                return Ok(());
            }
            progress("upgrade", &format!("opencode {have} is older than required {want}; upgrading"));
        } else {
            progress("install", &format!("installing opencode (require >= {want})"));
        }
    }

    #[cfg(windows)]
    {
        let asset = windows_zip_asset(std::env::consts::ARCH).ok_or_else(|| {
            anyhow::anyhow!("unsupported Windows arch: {}", std::env::consts::ARCH)
        })?;
        let base = std::env::var("OPENCODE_DOWNLOAD_BASE").ok();
        let url = windows_download_url(base.as_deref(), asset);
        progress("download", &format!("downloading {url}"));
        let bytes = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(async {
                let resp = reqwest::get(&url).await?.error_for_status()?;
                Ok::<_, anyhow::Error>(resp.bytes().await?)
            })?;

        progress("unpack", "unpacking opencode.exe");
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_ref()))?;
        // The exe may sit at the zip root or under a directory; match by suffix.
        let entry_name = zip
            .file_names()
            .find(|n| n.ends_with("opencode.exe"))
            .map(|n| n.to_string())
            .ok_or_else(|| anyhow::anyhow!("opencode.exe not found in {asset}"))?;
        let dest = opencode_default_bin().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = dest.with_extension("exe.tmp");
        {
            let mut entry = zip.by_name(&entry_name)?;
            let mut out = std::fs::File::create(&tmp)?;
            std::io::copy(&mut entry, &mut out)?;
        }
        if dest.exists() {
            // A running opencode locks its exe against overwrite; renaming a
            // running exe is allowed on Windows, so move it aside first.
            let old = dest.with_extension("exe.old");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(&dest, &old);
        }
        std::fs::rename(&tmp, &dest)?;
        progress("ok", &format!("opencode installed/upgraded (require >= {want})"));
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg("curl -fsSL https://opencode.ai/install | bash")
            .env("PATH", install_command_path())
            .output()
            .map_err(|e| anyhow::anyhow!("failed to run opencode installer: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("opencode installer exited with {}", output.status)
            };
            anyhow::bail!("{detail}");
        }
        progress("ok", &format!("opencode installed/upgraded (require >= {want})"));
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub required_version: String,
    pub satisfied: bool,
}

#[derive(Debug, Serialize)]
pub struct ComponentStatus {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmuxdStatus {
    /// A daemon binary is installed at ~/.amuxd/bin/amuxd.
    pub present: bool,
    /// Version of the installed binary (`amuxd --version`), if present.
    pub installed_version: Option<String>,
    /// Version bundled with THIS app build (the doctor binary is the bundled one).
    pub bundled_version: String,
    pub path: Option<String>,
    /// present AND installed_version >= bundled_version (no update needed).
    pub satisfied: bool,
}

#[derive(Debug, Serialize)]
pub struct DoctorReport {
    pub opencode: OpencodeStatus,
    pub git: ComponentStatus,
    pub amuxd: AmuxdStatus,
}

/// `<amuxd> --version` -> the first version-like token (clap prints "amuxd X.Y.Z").
fn amuxd_installed_version(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .find(|t| parse_semver(t).is_some())
        .map(|t| t.to_string())
}

fn probe_version(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    Some(s.lines().next().unwrap_or("").trim().to_string())
}

pub fn doctor() -> DoctorReport {
    let want = required_version();
    let detected = detect_opencode();
    let (present, version, path) = match &detected {
        Some((p, v)) => (true, Some(v.clone()), Some(p.clone())),
        None => (false, None, None),
    };
    let satisfied = version.as_deref().map(|v| version_ge(v, &want)).unwrap_or(false);
    let opencode = OpencodeStatus {
        present,
        version,
        path,
        required_version: want,
        satisfied,
    };

    let git_version = probe_version("git", &["--version"]);
    let git = ComponentStatus {
        present: git_version.is_some(),
        version: git_version,
        path: None,
    };

    let amuxd_path = crate::config::DaemonConfig::config_dir()
        .join("bin")
        .join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" });
    let amuxd_present = amuxd_path.exists();
    let bundled_version = env!("CARGO_PKG_VERSION").to_string();
    let installed_version = if amuxd_present {
        amuxd_installed_version(&amuxd_path)
    } else {
        None
    };
    let amuxd_satisfied = installed_version
        .as_deref()
        .map(|v| version_ge(v, &bundled_version))
        .unwrap_or(false);
    let amuxd = AmuxdStatus {
        present: amuxd_present,
        installed_version,
        bundled_version,
        path: amuxd_present.then(|| amuxd_path.to_string_lossy().to_string()),
        satisfied: amuxd_satisfied,
    };

    DoctorReport { opencode, git, amuxd }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_parses_version() {
        let lock = OpencodeLock::parse(r#"{"version":"v1.15.13"}"#).unwrap();
        assert_eq!(lock.version, "v1.15.13");
    }

    #[test]
    fn required_version_strips_leading_v() {
        // Uses the real embedded lock; just assert it has no leading 'v' and parses.
        let v = required_version();
        assert!(!v.starts_with('v'), "got {v}");
        assert!(parse_semver(&v).is_some(), "required version not semver: {v}");
    }

    #[test]
    fn parse_semver_cases() {
        assert_eq!(parse_semver("1.15.13"), Some((1, 15, 13)));
        assert_eq!(parse_semver("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_semver("1.15.13-beta"), Some((1, 15, 13)));
        assert_eq!(parse_semver("garbage"), None);
    }

    #[test]
    fn version_ge_cases() {
        assert!(version_ge("1.15.13", "1.15.13"));
        assert!(version_ge("1.16.0", "1.15.13"));
        assert!(version_ge("2.0.0", "1.9.9"));
        assert!(!version_ge("1.15.12", "1.15.13"));
        assert!(!version_ge("garbage", "1.0.0"));
    }

    #[test]
    fn resolve_binary_precedence() {
        // explicit config (non-"claude") wins
        assert_eq!(resolve_binary_with(Some("/opt/oc"), None), "/opt/oc");
        // shared "claude" default is treated as unconfigured -> falls through
        assert_eq!(resolve_binary_with(Some("claude"), None), "opencode");
        // no config, no default-dir binary -> PATH fallback
        assert_eq!(resolve_binary_with(None, None), "opencode");
        // no config, default-dir binary exists -> its absolute path
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("opencode");
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(resolve_binary_with(None, Some(p.clone())), p.to_string_lossy().to_string());
    }

    #[cfg(not(windows))]
    #[test]
    fn install_command_path_includes_system_dirs_when_empty() {
        let prev = std::env::var("PATH").ok();
        std::env::remove_var("PATH");
        let p = install_command_path();
        assert!(p.contains("/usr/bin"), "got {p}");
        assert!(p.contains("/bin"), "got {p}");
        match prev {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
    }

    #[test]
    fn windows_zip_asset_matches_supported_arches() {
        assert_eq!(windows_zip_asset("x86_64"), Some("opencode-windows-x64.zip"));
        assert_eq!(windows_zip_asset("aarch64"), Some("opencode-windows-arm64.zip"));
        assert_eq!(windows_zip_asset("riscv64"), None);
    }

    #[test]
    fn windows_download_url_honors_base_override() {
        assert_eq!(
            windows_download_url(None, "opencode-windows-x64.zip"),
            "https://github.com/sst/opencode/releases/latest/download/opencode-windows-x64.zip"
        );
        assert_eq!(
            windows_download_url(Some("https://mirror.example/oc/"), "opencode-windows-x64.zip"),
            "https://mirror.example/oc/opencode-windows-x64.zip"
        );
    }

    #[test]
    fn doctor_report_serializes() {
        let report = DoctorReport {
            opencode: OpencodeStatus {
                present: true,
                version: Some("1.15.13".into()),
                path: Some("/x".into()),
                required_version: "1.15.13".into(),
                satisfied: true,
            },
            git: ComponentStatus { present: false, version: None, path: None },
            amuxd: AmuxdStatus {
                present: true,
                installed_version: Some("0.1.0".into()),
                bundled_version: "0.1.0".into(),
                path: Some("/a".into()),
                satisfied: true,
            },
        };
        let v: serde_json::Value = serde_json::to_value(&report).unwrap();
        assert_eq!(v["opencode"]["satisfied"], serde_json::json!(true));
        assert_eq!(v["opencode"]["requiredVersion"], serde_json::json!("1.15.13"));
        assert_eq!(v["git"]["present"], serde_json::json!(false));
        assert_eq!(v["amuxd"]["installedVersion"], serde_json::json!("0.1.0"));
        assert_eq!(v["amuxd"]["satisfied"], serde_json::json!(true));
    }
}
