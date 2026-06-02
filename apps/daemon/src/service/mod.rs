use std::path::Path;

pub const LAUNCHD_LABEL: &str = "cc.ucar.amuxd";

pub fn launchd_plist(exe: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        exe = exe.display(),
    )
}

pub fn systemd_unit(exe: &Path) -> String {
    format!(
        r#"[Unit]
Description=amuxd (TeamClaw agent daemon)
After=network-online.target

[Service]
ExecStart="{exe}" start
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
"#,
        exe = exe.display(),
    )
}

use crate::config::DaemonConfig;

fn amuxd_exe_path() -> std::path::PathBuf {
    DaemonConfig::config_dir()
        .join("bin")
        .join(if cfg!(windows) { "amuxd.exe" } else { "amuxd" })
}

#[cfg(target_os = "macos")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    anyhow::ensure!(exe.exists(), "amuxd binary not found at {}", exe.display());
    let plist_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join("Library/LaunchAgents");
    std::fs::create_dir_all(&plist_dir)?;
    let plist_path = plist_dir.join(format!("{LAUNCHD_LABEL}.plist"));
    std::fs::write(&plist_path, launchd_plist(&exe))?;
    let uid = nix_uid();
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .status();
    let status = std::process::Command::new("launchctl")
        .args(["bootstrap", &format!("gui/{uid}")])
        .arg(&plist_path)
        .status()?;
    anyhow::ensure!(status.success(), "launchctl bootstrap failed");
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let uid = nix_uid();
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", &format!("gui/{uid}/{LAUNCHD_LABEL}")])
        .status();
    let plist_path = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"));
    let _ = std::fs::remove_file(plist_path);
    Ok(())
}

#[cfg(target_os = "macos")]
fn nix_uid() -> u32 {
    // SAFETY: getuid() is always safe to call.
    unsafe { libc::getuid() }
}

#[cfg(target_os = "linux")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    anyhow::ensure!(exe.exists(), "amuxd binary not found at {}", exe.display());
    let unit_dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir)?;
    std::fs::write(unit_dir.join("amuxd.service"), systemd_unit(&exe))?;
    // Best-effort: keep the user manager running after logout so the service
    // survives across login sessions (no-op / may fail on headless setups).
    let _ = std::process::Command::new("loginctl")
        .args(["enable-linger"])
        .status();
    let status = std::process::Command::new("systemctl")
        .args(["--user", "enable", "--now", "amuxd.service"])
        .status()?;
    anyhow::ensure!(status.success(), "systemctl --user enable --now failed");
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", "amuxd.service"])
        .status();
    let unit = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".config/systemd/user/amuxd.service");
    let _ = std::fs::remove_file(unit);
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn install_service() -> anyhow::Result<()> {
    let exe = amuxd_exe_path();
    anyhow::ensure!(exe.exists(), "amuxd binary not found at {}", exe.display());
    // schtasks /TR wants a bare command line; quote only the exe path (it may
    // contain spaces), not the whole "<exe> start" string.
    let status = std::process::Command::new("schtasks")
        .args(["/Create", "/F", "/SC", "ONLOGON", "/TN", "amuxd", "/TR"])
        .arg(format!("\"{}\" start", exe.display()))
        .status()?;
    anyhow::ensure!(status.success(), "schtasks /Create failed");
    let _ = std::process::Command::new("schtasks")
        .args(["/Run", "/TN", "amuxd"])
        .status();
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn uninstall_service() -> anyhow::Result<()> {
    let _ = std::process::Command::new("schtasks")
        .args(["/Delete", "/F", "/TN", "amuxd"])
        .status();
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn install_service() -> anyhow::Result<()> {
    anyhow::bail!("amuxd service registration is not supported on this platform")
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn uninstall_service() -> anyhow::Result<()> {
    anyhow::bail!("amuxd service registration is not supported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn launchd_plist_contains_exec_and_label() {
        let p = launchd_plist(Path::new("/Users/x/.amuxd/bin/amuxd"));
        assert!(p.contains("<string>cc.ucar.amuxd</string>"));
        assert!(p.contains("<string>/Users/x/.amuxd/bin/amuxd</string>"));
        assert!(p.contains("<string>start</string>"));
        assert!(p.contains("<key>RunAtLoad</key>"));
        assert!(p.contains("<key>KeepAlive</key>"));
    }

    #[test]
    fn systemd_unit_contains_execstart_and_restart() {
        let u = systemd_unit(Path::new("/home/x/.amuxd/bin/amuxd"));
        assert!(u.contains("ExecStart=\"/home/x/.amuxd/bin/amuxd\" start"));
        assert!(u.contains("Restart=always"));
        assert!(u.contains("[Install]"));
        assert!(u.contains("WantedBy=default.target"));
    }
}
