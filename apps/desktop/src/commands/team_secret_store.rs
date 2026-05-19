use tracing::info;

const KEYRING_SERVICE: &str = concat!(env!("APP_SHORT_NAME"), "-team");

fn team_secret_blob_key(team_id: &str) -> String {
    format!("_team_secret.{}", team_id)
}

pub fn save_team_secret(workspace_path: &str, team_id: &str, secret: &str) -> Result<(), String> {
    let mut blob = super::env_vars::read_env_blob(workspace_path)?;
    blob.insert(
        team_secret_blob_key(team_id),
        serde_json::Value::String(secret.to_string()),
    );
    super::env_vars::write_env_blob(&blob)
}

pub fn load_team_secret(workspace_path: &str, team_id: &str) -> Result<String, String> {
    let blob = super::env_vars::read_env_blob(workspace_path)?;
    let key = team_secret_blob_key(team_id);
    if let Some(value) = blob.get(&key).and_then(|v| v.as_str()) {
        return Ok(value.to_string());
    }

    let legacy_entry = keyring::Entry::new(KEYRING_SERVICE, team_id)
        .map_err(|e| format!("Failed to create keyring entry: {e}"))?;
    match legacy_entry.get_password() {
        Ok(secret) => {
            let mut blob = blob;
            blob.insert(key, serde_json::Value::String(secret.clone()));
            let _ = super::env_vars::write_env_blob(&blob);
            let _ = legacy_entry.delete_credential();
            info!(
                "Migrated team secret for {} from legacy keyring to env blob",
                team_id
            );
            Ok(secret)
        }
        Err(_) => Err(format!("Team secret not found for team {team_id}")),
    }
}

pub fn delete_team_secret(workspace_path: &str, team_id: &str) -> Result<(), String> {
    let mut blob = super::env_vars::read_env_blob(workspace_path)?;
    blob.remove(&team_secret_blob_key(team_id));
    super::env_vars::write_env_blob(&blob)?;
    if let Ok(legacy_entry) = keyring::Entry::new(KEYRING_SERVICE, team_id) {
        let _ = legacy_entry.delete_credential();
    }
    Ok(())
}
