use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::path::Path;
use tracing::warn;

#[derive(Debug, Deserialize, Serialize)]
struct EncryptedEnvelope {
    v: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretEntry {
    key_id: String,
    key: String,
}

pub fn derive_key(env_secret: &str) -> anyhow::Result<[u8; 32]> {
    let ikm = hex::decode(env_secret)?;
    if ikm.len() != 32 {
        anyhow::bail!("env_secret must be 32 bytes (64 hex chars)");
    }
    let hk = Hkdf::<Sha256>::new(Some(b"teamclaw-secrets-v1"), &ikm);
    let mut okm = [0_u8; 32];
    hk.expand(b"aes-256-gcm", &mut okm)
        .map_err(|_| anyhow::anyhow!("HKDF expand failed"))?;
    Ok(okm)
}

fn decrypt_secret(envelope: &EncryptedEnvelope, key: &[u8; 32]) -> anyhow::Result<SecretEntry> {
    if envelope.v != 1 {
        anyhow::bail!("unsupported envelope version {}", envelope.v);
    }
    let nonce_bytes = BASE64.decode(&envelope.nonce)?;
    if nonce_bytes.len() != 12 {
        anyhow::bail!("nonce must be 12 bytes");
    }
    let ciphertext = BASE64.decode(&envelope.ciphertext)?;
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| anyhow::anyhow!("AES-GCM decrypt failed"))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

pub fn normalize_env_map(input: HashMap<String, String>) -> HashMap<String, String> {
    let mut out = input;
    let additions: Vec<(String, String)> = out
        .iter()
        .filter_map(|(key, value)| {
            let upper = key.to_ascii_uppercase();
            if key == &upper || out.contains_key(&upper) {
                None
            } else {
                Some((upper, value.clone()))
            }
        })
        .collect();
    for (key, value) in additions {
        out.insert(key, value);
    }
    out
}

pub fn load_team_env(
    workspace_root: &Path,
    shared_dir_name: &str,
    env_secret: &str,
) -> anyhow::Result<HashMap<String, String>> {
    let secrets_dir =
        crate::team_shared_git::shared_dir_path(workspace_root, shared_dir_name)?.join("_secrets");
    if !secrets_dir.exists() {
        return Ok(HashMap::new());
    }

    let key = derive_key(env_secret)?;
    let mut env = HashMap::new();
    for entry in std::fs::read_dir(&secrets_dir)? {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(e) => {
                warn!("failed to read team secret directory entry: {e}");
                continue;
            }
        };
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".enc.json") {
            continue;
        }
        let body = match std::fs::read_to_string(&path) {
            Ok(body) => body,
            Err(e) => {
                warn!(path = %path.display(), "failed to read team secret file: {e}");
                continue;
            }
        };
        let envelope: EncryptedEnvelope = match serde_json::from_str(&body) {
            Ok(envelope) => envelope,
            Err(e) => {
                warn!(path = %path.display(), "failed to parse team secret file: {e}");
                continue;
            }
        };
        let secret = match decrypt_secret(&envelope, &key) {
            Ok(secret) => secret,
            Err(e) => {
                warn!(path = %path.display(), "failed to decrypt team secret file: {e}");
                continue;
            }
        };
        env.insert(secret.key_id, secret.key);
    }
    Ok(normalize_env_map(env))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    fn encrypted_secret_file(env_secret: &str, key_id: &str, key_value: &str) -> String {
        let key = derive_key(env_secret).unwrap();
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
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        })
        .unwrap()
    }

    #[test]
    fn normalize_env_adds_uppercase_alias_for_lowercase_key() {
        let mut input = HashMap::new();
        input.insert("tc_api_key".to_string(), "secret".to_string());

        let out = normalize_env_map(input);

        assert_eq!(out.get("tc_api_key").unwrap(), "secret");
        assert_eq!(out.get("TC_API_KEY").unwrap(), "secret");
    }

    #[test]
    fn normalize_env_does_not_override_existing_uppercase_key() {
        let mut input = HashMap::new();
        input.insert("tc_api_key".to_string(), "lower".to_string());
        input.insert("TC_API_KEY".to_string(), "upper".to_string());

        let out = normalize_env_map(input);

        assert_eq!(out.get("TC_API_KEY").unwrap(), "upper");
    }

    #[test]
    fn missing_secrets_dir_returns_empty_env() {
        let tmp = tempfile::tempdir().unwrap();
        let env = load_team_env(tmp.path(), "teamclaw", &"00".repeat(32)).unwrap();
        assert!(env.is_empty());
    }

    #[test]
    fn unsafe_shared_dir_name_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let err = load_team_env(tmp.path(), "../outside", &"00".repeat(32)).unwrap_err();
        assert!(err.to_string().contains("shared_dir_name"));
    }

    #[test]
    fn malformed_secret_files_do_not_suppress_valid_env() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets_dir = tmp.path().join("teamclaw").join("_secrets");
        std::fs::create_dir_all(&secrets_dir).unwrap();
        std::fs::write(secrets_dir.join("bad.enc.json"), "{not json").unwrap();

        let env_secret = "11".repeat(32);
        std::fs::write(
            secrets_dir.join("good.enc.json"),
            encrypted_secret_file(&env_secret, "tc_api_key", "secret"),
        )
        .unwrap();

        let env = load_team_env(tmp.path(), "teamclaw", &env_secret).unwrap();
        assert_eq!(env.get("tc_api_key").unwrap(), "secret");
        assert_eq!(env.get("TC_API_KEY").unwrap(), "secret");
    }
}
