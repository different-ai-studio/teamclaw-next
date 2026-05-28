#![allow(clippy::await_holding_lock)]
//! Smoke tests for `team_share::custom_git` (Task 7).
//!
//! Covers:
//!   - `store_credential` / `load_credential` round-trip via env_blob.
//!   - `build_clone_command` configures `GIT_ASKPASS` + env vars for HTTPS.
//!   - `build_clone_command` configures `GIT_SSH_COMMAND` for SSH.
//!   - `clone_or_init` against a local bare repo over `file://` succeeds.
//!   - `clone_or_init` falls back to `git init` if clone fails (defensive).

use serde_json::json;
use std::path::PathBuf;
use std::process::Command;
use teamclaw_lib::commands::team_share::custom_git;
use tempfile::TempDir;

#[allow(deprecated)]
fn isolate_home(tmp: &TempDir) {
    std::env::set_var("HOME", tmp.path());
    let fallback_dir = tmp.path().join(".teamclaw");
    std::fs::create_dir_all(&fallback_dir).expect("mkdir ~/.teamclaw");
    std::fs::write(
        fallback_dir.join("env-blob.json"),
        r#"{"_test_isolation_marker":"1"}"#,
    )
    .expect("write disk fallback env-blob.json");
}

static HOME_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn seed_workspace(tmp: &TempDir) -> String {
    let workspace = tmp.path().to_path_buf();
    let cfg_dir = workspace.join(".teamclaw");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir .teamclaw");
    std::fs::write(
        cfg_dir.join("teamclaw.json"),
        serde_json::to_string_pretty(&json!({})).unwrap(),
    )
    .expect("write teamclaw.json");
    workspace.to_string_lossy().into_owned()
}

fn make_bare_repo(tmp: &TempDir, name: &str) -> PathBuf {
    let bare = tmp.path().join(name);
    std::fs::create_dir_all(&bare).expect("mkdir bare");
    let out = Command::new("git")
        .arg("init")
        .arg("--bare")
        .arg(&bare)
        .output()
        .expect("git init --bare");
    assert!(out.status.success(), "git init --bare failed: {:?}", out);
    bare
}

#[test]
fn store_then_load_https_token_roundtrip() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    custom_git::store_credential(&workspace, "custom_git:t1", "https_token", "ghp_abc123")
        .expect("store_credential");

    let (kind, value) =
        custom_git::load_credential(&workspace, "custom_git:t1").expect("load_credential");
    assert_eq!(kind, "https_token");
    assert_eq!(value, "ghp_abc123");
}

#[test]
fn build_clone_command_https_sets_askpass_env() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    custom_git::store_credential(&workspace, "custom_git:t1", "https_token", "ghp_abc")
        .expect("store_credential");

    let dest = tmp.path().join("dest");
    let askpass_stub = tmp.path().join("askpass.sh");
    std::fs::write(&askpass_stub, "#!/bin/sh\necho stub\n").unwrap();

    let cmd = custom_git::build_clone_command(
        &dest,
        "https://example.com/foo.git",
        &workspace,
        "custom_git:t1",
        "https_token",
        Some(askpass_stub.clone()),
    )
    .expect("build_clone_command");

    let envs: Vec<(String, String)> = cmd
        .get_envs()
        .filter_map(|(k, v)| v.map(|vv| (k.to_string_lossy().into(), vv.to_string_lossy().into())))
        .collect();

    let find = |k: &str| envs.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone());

    assert_eq!(
        find("GIT_ASKPASS"),
        Some(askpass_stub.to_string_lossy().into())
    );
    assert_eq!(find("TEAMCLAW_WORKSPACE"), Some(workspace.clone()));
    assert_eq!(
        find("TEAMCLAW_CREDENTIAL_REF"),
        Some("custom_git:t1".into())
    );
    assert_eq!(find("GIT_TERMINAL_PROMPT"), Some("0".into()));
}

#[test]
fn build_clone_command_ssh_sets_git_ssh_command() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    let key_path = tmp.path().join("id_ed25519").to_string_lossy().into_owned();
    custom_git::store_credential(&workspace, "custom_git:t2", "ssh_key", &key_path)
        .expect("store_credential");

    let dest = tmp.path().join("dest");
    let cmd = custom_git::build_clone_command(
        &dest,
        "git@example.com:foo/bar.git",
        &workspace,
        "custom_git:t2",
        "ssh_key",
        None,
    )
    .expect("build_clone_command");

    let envs: Vec<(String, String)> = cmd
        .get_envs()
        .filter_map(|(k, v)| v.map(|vv| (k.to_string_lossy().into(), vv.to_string_lossy().into())))
        .collect();
    let ssh_cmd = envs
        .iter()
        .find(|(k, _)| k == "GIT_SSH_COMMAND")
        .map(|(_, v)| v.clone())
        .expect("GIT_SSH_COMMAND should be set");
    assert!(
        ssh_cmd.contains(&key_path),
        "GIT_SSH_COMMAND should reference key path: {ssh_cmd}"
    );
    assert!(
        ssh_cmd.contains("IdentitiesOnly=yes"),
        "GIT_SSH_COMMAND should set IdentitiesOnly=yes: {ssh_cmd}"
    );
}

#[test]
fn clone_or_init_https_file_url_succeeds() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    custom_git::store_credential(&workspace, "custom_git:t1", "https_token", "unused")
        .expect("store_credential");
    let bare = make_bare_repo(&tmp, "remote.git");
    let remote_url = format!("file://{}", bare.display());

    let dest = tmp.path().join("checkout");
    let askpass = tmp.path().join("askpass.sh");
    std::fs::write(&askpass, "#!/bin/sh\necho stub\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&askpass).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&askpass, perms).unwrap();
    }
    let outcome = custom_git::clone_or_init(
        &dest,
        &remote_url,
        &workspace,
        "custom_git:t1",
        "https_token",
        Some(askpass),
    )
    .expect("clone_or_init");

    assert_eq!(outcome, custom_git::CloneOutcome::Cloned);
    assert!(
        dest.join(".git").exists(),
        ".git should exist after clone_or_init"
    );
}

#[test]
fn clone_or_init_falls_back_to_init_when_clone_fails() {
    let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().expect("tempdir");
    isolate_home(&tmp);
    let workspace = seed_workspace(&tmp);

    custom_git::store_credential(&workspace, "custom_git:t1", "https_token", "x")
        .expect("store_credential");

    // Bogus URL that cannot be cloned.
    let dest = tmp.path().join("init-fallback");
    let askpass = tmp.path().join("askpass.sh");
    std::fs::write(&askpass, "#!/bin/sh\necho stub\n").unwrap();
    let outcome = custom_git::clone_or_init(
        &dest,
        "file:///nonexistent/path/that/does/not/exist.git",
        &workspace,
        "custom_git:t1",
        "https_token",
        Some(askpass),
    )
    .expect("clone_or_init should fall back to git init");

    match outcome {
        custom_git::CloneOutcome::InitFallback { reason } => {
            assert!(
                !reason.is_empty(),
                "InitFallback should carry a non-empty reason"
            );
        }
        other => panic!("expected InitFallback, got {:?}", other),
    }

    assert!(
        dest.join(".git").exists(),
        ".git should exist after init fallback"
    );
}
