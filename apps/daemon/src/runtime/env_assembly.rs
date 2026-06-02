use std::path::Path;

use tracing::warn;

use crate::team_shared_env;

use super::SpawnRuntimeEnv;
use super::supervisor::prepare_workspace;

/// Assemble personal + team + system env and resolve `${KEY}` placeholders in
/// `opencode.json` before attaching an ACP host.
pub fn assemble_spawn_runtime_env(
    workspace_root: &Path,
    team_id: Option<&str>,
    device_id: &str,
    device_name: &str,
) -> anyhow::Result<SpawnRuntimeEnv> {
    let team_env = team_shared_env::load_team_env_for_workspace(workspace_root, team_id);
    let bundle = teamclaw_runtime_env::assemble_runtime_env(
        workspace_root,
        team_env,
        teamclaw_runtime_env::SystemEnvContext {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
        },
    )?;
    Ok(SpawnRuntimeEnv {
        extra_env: bundle.extra_env,
        force_env_override: true,
        opencode_json_original: bundle.opencode_json_original,
    })
}

/// Bootstrap a worktree (when requested) and assemble runtime env for gateway/cron spawns.
pub fn prepare_and_assemble_spawn_runtime_env(
    worktree: &Path,
    team_id: Option<&str>,
    device_id: &str,
    device_name: &str,
    skip_workspace_prepare: bool,
) -> SpawnRuntimeEnv {
    if !skip_workspace_prepare {
        if let Err(err) = prepare_workspace(worktree) {
            warn!(
                worktree = %worktree.display(),
                error = %err,
                "prepare_workspace failed before gateway runtime env assembly"
            );
        }
    }

    match assemble_spawn_runtime_env(worktree, team_id, device_id, device_name) {
        Ok(env) => env,
        Err(err) => {
            warn!(
                worktree = %worktree.display(),
                error = %err,
                "assemble_spawn_runtime_env failed for gateway runtime; using empty env"
            );
            SpawnRuntimeEnv::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::Path;

    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use rand::RngCore;
    use serde::{Deserialize, Serialize};

    use super::*;
    use crate::config::global_team_store::TEST_HOME_LOCK;
    use crate::runtime::supervisor::prepare_workspace;

    struct HomeGuard {
        previous: Option<String>,
    }

    impl HomeGuard {
        fn set(home: &Path) -> Self {
            let previous = std::env::var("HOME").ok();
            unsafe {
                std::env::set_var("HOME", home);
            }
            Self { previous }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => unsafe {
                    std::env::set_var("HOME", value);
                },
                None => unsafe {
                    std::env::remove_var("HOME");
                },
            }
        }
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SecretEntry {
        key_id: String,
        key: String,
    }

    #[derive(Serialize, Deserialize)]
    struct EncryptedEnvelope {
        v: u32,
        nonce: String,
        ciphertext: String,
    }

    fn encrypted_team_secret_file(env_secret: &str, key_id: &str, key_value: &str) -> String {
        let key = crate::team_shared_env::derive_key(env_secret).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = [7_u8; 12];
        let secret = SecretEntry {
            key_id: key_id.to_string(),
            key: key_value.to_string(),
        };
        let plaintext = serde_json::to_vec(&secret).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .unwrap();
        serde_json::to_string(&EncryptedEnvelope {
            v: 1,
            nonce: B64.encode(nonce),
            ciphertext: B64.encode(ciphertext),
        })
        .unwrap()
    }

    #[derive(Serialize, Deserialize)]
    struct EncryptedBlobFile {
        nonce_b64: String,
        ciphertext_b64: String,
    }

    fn write_personal_secret(home: &Path, key: &str, value: &str) {
        let secrets_dir = home.join(".teamclaw/secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        let master_key_path = secrets_dir.join("master.key");
        let blob_path = secrets_dir.join("personal-secrets.json.enc");

        let mut key_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key_bytes);
        std::fs::write(&master_key_path, key_bytes).unwrap();

        let cipher = Aes256Gcm::new_from_slice(&key_bytes).unwrap();
        let mut map = serde_json::Map::new();
        map.insert(key.into(), serde_json::Value::String(value.into()));
        let plaintext = serde_json::to_vec(&map).unwrap();
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
            .unwrap();
        let file = EncryptedBlobFile {
            nonce_b64: B64.encode(nonce_bytes),
            ciphertext_b64: B64.encode(ciphertext),
        };
        std::fs::File::create(&blob_path)
            .unwrap()
            .write_all(&serde_json::to_vec_pretty(&file).unwrap())
            .unwrap();
    }

    fn write_team_secret(workspace: &Path, env_secret: &str, key_id: &str, value: &str) {
        let config_dir = workspace.join(".teamclaw");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclaw.json"),
            serde_json::json!({
                "team": { "envSecret": env_secret }
            })
            .to_string(),
        )
        .unwrap();
        let secrets_dir = workspace.join("teamclaw").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(
            secrets_dir.join(format!("{key_id}.enc.json")),
            encrypted_team_secret_file(env_secret, key_id, value),
        )
        .unwrap();
    }

    #[test]
    fn assemble_spawn_runtime_env_injects_device_context() {
        let _lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let _home = HomeGuard::set(home.path());
        let worktree = tempfile::tempdir().unwrap();
        prepare_workspace(worktree.path()).unwrap();

        let env =
            assemble_spawn_runtime_env(worktree.path(), None, "dev-abc", "My Device").unwrap();

        assert!(env.force_env_override);
        assert_eq!(env.extra_env.get("device_id"), Some(&"dev-abc".to_string()));
        assert_eq!(env.extra_env.get("device_name"), Some(&"My Device".to_string()));
        assert!(
            env.extra_env
                .get("tc_api_key")
                .unwrap()
                .starts_with("sk-tc-dev-abc")
        );
    }

    #[test]
    fn assemble_spawn_runtime_env_merges_personal_and_team_secrets() {
        let _lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let _home = HomeGuard::set(home.path());
        write_personal_secret(home.path(), "PERSONAL_KEY", "from-personal");

        let worktree = tempfile::tempdir().unwrap();
        prepare_workspace(worktree.path()).unwrap();
        let env_secret = "55".repeat(32);
        write_team_secret(worktree.path(), &env_secret, "TEAM_KEY", "from-team");

        let env = assemble_spawn_runtime_env(worktree.path(), None, "dev-1", "Device").unwrap();

        assert_eq!(env.extra_env.get("PERSONAL_KEY"), Some(&"from-personal".to_string()));
        assert_eq!(env.extra_env.get("TEAM_KEY"), Some(&"from-team".to_string()));
    }

    #[test]
    fn assemble_spawn_runtime_env_resolves_opencode_placeholders() {
        let _lock = TEST_HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        let _home = HomeGuard::set(home.path());
        write_personal_secret(home.path(), "QWEN_API_KEY", "resolved-qwen-key");

        let worktree = tempfile::tempdir().unwrap();
        prepare_workspace(worktree.path()).unwrap();

        let env = assemble_spawn_runtime_env(worktree.path(), None, "dev-1", "Device").unwrap();

        assert!(env.opencode_json_original.is_some());
        let on_disk =
            std::fs::read_to_string(worktree.path().join("opencode.json")).unwrap();
        assert!(on_disk.contains("resolved-qwen-key"));
        assert!(!on_disk.contains("${QWEN_API_KEY}"));
    }

    #[test]
    fn prepare_and_assemble_skips_workspace_bootstrap_for_gateway_scratch() {
        let scratch = tempfile::tempdir().unwrap();
        let env = prepare_and_assemble_spawn_runtime_env(
            scratch.path(),
            None,
            "gateway-dev",
            "Gateway",
            true,
        );

        assert!(
            !scratch
                .path()
                .join(".teamclaw/skills/create-role/SKILL.md")
                .exists()
        );
        assert_eq!(
            env.extra_env.get("device_id"),
            Some(&"gateway-dev".to_string())
        );
        assert!(env.force_env_override);
    }

    #[test]
    fn prepare_and_assemble_bootstraps_workspace_when_not_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let env = prepare_and_assemble_spawn_runtime_env(dir.path(), None, "dev-2", "Device", false);

        assert!(
            dir.path()
                .join(".teamclaw/skills/create-role/SKILL.md")
                .is_file()
        );
        assert_eq!(env.extra_env.get("device_id"), Some(&"dev-2".to_string()));
    }
}
