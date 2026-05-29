//! Task 7 — custom Git SSH + HTTPS credential bridge.
//!
//! Provides a clean API for:
//!   - `store_credential`: persists a Git credential under
//!     `_git_credential.{ref}` in the local encrypted env_blob.
//!   - `load_credential`: reads the credential back. Used both internally
//!     by [`build_clone_command`] (for SSH key paths) and externally by the
//!     `teamclaw-askpass` sidecar binary (for HTTPS tokens).
//!   - `build_clone_command`: factored so tests can inspect the configured
//!     `Command` without spawning git.
//!   - `clone_or_init`: actually invokes `git clone`, with a defensive
//!     fallback to `git init` if the remote is empty / unreachable.
//!
//! Credential shape on disk (one entry per ref):
//!
//! ```json
//! "_git_credential.custom_git:t1": {
//!   "authKind": "https_token" | "ssh_key",
//!   "credential": "<token-or-key-path>"
//! }
//! ```
//!
//! For `https_token`, the credential is the literal token. For `ssh_key`,
//! the credential is a filesystem path to the private key.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;

use crate::commands::env_vars;

const KEY_PREFIX: &str = "_git_credential.";

fn key_for(credential_ref: &str) -> String {
    format!("{}{}", KEY_PREFIX, credential_ref)
}

/// Persist a Git credential under `_git_credential.{ref}` in env_blob.
///
/// `kind` must be `"ssh_key"` or `"https_token"`. For `ssh_key`, `value`
/// is the absolute path to the private key file. For `https_token`,
/// `value` is the literal token.
pub fn store_credential(
    workspace_path: &str,
    credential_ref: &str,
    kind: &str,
    value: &str,
) -> Result<(), String> {
    if kind != "ssh_key" && kind != "https_token" {
        return Err(format!(
            "invalid credential kind `{}`; expected `ssh_key` or `https_token`",
            kind
        ));
    }
    let mut blob = env_vars::read_env_blob(workspace_path)?;
    blob.insert(
        key_for(credential_ref),
        json!({
            "authKind": kind,
            "credential": value,
        }),
    );
    env_vars::write_env_blob(&blob)
}

/// Load a Git credential, returning `(kind, value)`.
pub fn load_credential(
    workspace_path: &str,
    credential_ref: &str,
) -> Result<(String, String), String> {
    let blob = env_vars::read_env_blob(workspace_path)?;
    let entry = blob
        .get(&key_for(credential_ref))
        .ok_or_else(|| format!("git credential not found: {credential_ref}"))?;
    let kind = entry
        .get("authKind")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("git credential `{credential_ref}` missing authKind"))?
        .to_string();
    let value = entry
        .get("credential")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("git credential `{credential_ref}` missing credential"))?
        .to_string();
    Ok((kind, value))
}

/// Best-effort lookup for the `teamclaw-askpass` sidecar.
///
/// Resolution order:
///   1. `TEAMCLAW_ASKPASS` env var (test / dev override).
///   2. Sibling of the current executable.
///   3. `apps/desktop/binaries/teamclaw-askpass.sh` relative to CWD (dev).
fn default_askpass_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("TEAMCLAW_ASKPASS") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Direct siblings (dev/CI, and Linux/Windows bundles).
            for candidate in [
                "teamclaw-askpass",
                "teamclaw-askpass.sh",
                "teamclaw-askpass-aarch64-apple-darwin",
                "teamclaw-askpass-x86_64-apple-darwin",
            ] {
                let p = dir.join(candidate);
                if p.exists() {
                    return Some(p);
                }
            }
            // macOS app bundle: exe lives in `Contents/MacOS/`, and
            // tauri.conf.json `bundle.resources` are dropped into
            // `Contents/Resources/`. Walk up one and check there.
            if let Some(contents) = dir.parent() {
                for candidate in [
                    contents.join("Resources/teamclaw-askpass.sh"),
                    contents.join("Resources/binaries/teamclaw-askpass.sh"),
                ] {
                    if candidate.exists() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    let dev = PathBuf::from("apps/desktop/binaries/teamclaw-askpass.sh");
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Build (but do not spawn) the `git clone` command, wired with the proper
/// credentials for `auth_kind`. Factored out for testability — tests can
/// inspect the configured env on the returned `Command`.
///
/// `askpass_override` lets tests inject a stub askpass without requiring
/// the sidecar binary to be built.
pub fn build_clone_command(
    dest: &Path,
    remote_url: &str,
    workspace_path: &str,
    credential_ref: &str,
    auth_kind: &str,
    askpass_override: Option<PathBuf>,
) -> Result<Command, String> {
    // Windows guard: the askpass helper is a POSIX shell script and won't
    // execute in a Windows environment. Refuse HTTPS clones here rather than
    // silently falling back to `git init` and leaving the user confused.
    #[cfg(windows)]
    {
        if auth_kind == "https_token" {
            return Err("HTTPS custom_git clones via askpass are not yet supported on Windows. Use SSH auth_kind instead, or open the team in a managed-git mode.".into());
        }
    }

    let mut cmd = Command::new("git");
    cmd.arg("clone")
        .arg(remote_url)
        .arg(dest)
        .env("GIT_TERMINAL_PROMPT", "0");

    match auth_kind {
        "https_token" => {
            let askpass = askpass_override
                .or_else(default_askpass_path)
                .ok_or_else(|| {
                    "teamclaw-askpass helper not found; set TEAMCLAW_ASKPASS or build the sidecar"
                        .to_string()
                })?;
            cmd.env("GIT_ASKPASS", &askpass)
                .env("TEAMCLAW_WORKSPACE", workspace_path)
                .env("TEAMCLAW_CREDENTIAL_REF", credential_ref);
        }
        "ssh_key" => {
            let (_kind, key_path) = load_credential(workspace_path, credential_ref)?;
            let ssh_cmd = format!(
                "ssh -i {} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
                shell_quote(&key_path)
            );
            cmd.env("GIT_SSH_COMMAND", ssh_cmd);
        }
        other => {
            return Err(format!(
                "invalid auth_kind `{}`; expected `ssh_key` or `https_token`",
                other
            ));
        }
    }

    Ok(cmd)
}

fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Outcome of [`clone_or_init`]. Distinguishes a real clone from the
/// defensive `git init` fallback so callers can surface a warning to the
/// user instead of silently pretending the remote was reachable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloneOutcome {
    /// `git clone` succeeded.
    Cloned,
    /// `git clone` failed; we fell back to `git init` + `remote add`.
    /// `reason` is the first non-empty trimmed line of the clone stderr
    /// (or a synthetic reason if stderr was empty / capture failed).
    InitFallback { reason: String },
}

// TODO(team-shared-git unification): apps/desktop/src/commands/team_shared_git.rs
// has a parallel clone-or-init path that embeds tokens in the remote URL
// (token persists in .git/config — security regression that this askpass-based
// path was designed to fix). Migrate team_shared_git::setup_shared_git_repo to
// delegate here in a follow-up PR.

/// Clone `remote_url` into `dest` using the stored credential. Falls back
/// to `git init` if the clone fails (defensive — handles empty/unreachable
/// remotes that the user can push to later). The fallback case is reported
/// via [`CloneOutcome::InitFallback`] so callers can warn the user.
pub fn clone_or_init(
    dest: &Path,
    remote_url: &str,
    workspace_path: &str,
    credential_ref: &str,
    auth_kind: &str,
    askpass_override: Option<PathBuf>,
) -> Result<CloneOutcome, String> {
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut cmd = build_clone_command(
        dest,
        remote_url,
        workspace_path,
        credential_ref,
        auth_kind,
        askpass_override,
    )?;
    let clone_result = cmd.output();

    let clone_ok =
        matches!(&clone_result, Ok(out) if out.status.success()) && dest.join(".git").exists();

    if clone_ok {
        return Ok(CloneOutcome::Cloned);
    }

    // Capture a human-readable reason from the failed clone for the warning.
    let reason = match &clone_result {
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            stderr
                .lines()
                .map(|l| l.trim())
                .find(|l| !l.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("git clone exited with status {}", out.status))
        }
        Err(e) => format!("git clone could not be spawned: {e}"),
    };

    // Defensive fallback: `git init` + set remote so user can pull/push
    // once the remote is reachable.
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("create_dir_all({}) failed: {e}", dest.display()))?;
    let init = Command::new("git")
        .arg("init")
        .current_dir(dest)
        .output()
        .map_err(|e| format!("git init failed: {e}"))?;
    if !init.status.success() {
        return Err(format!(
            "git init failed: {}",
            String::from_utf8_lossy(&init.stderr)
        ));
    }
    let _ = Command::new("git")
        .arg("remote")
        .arg("add")
        .arg("origin")
        .arg(remote_url)
        .current_dir(dest)
        .output();
    Ok(CloneOutcome::InitFallback { reason })
}
