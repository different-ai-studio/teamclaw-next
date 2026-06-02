//! FC client + shared team-sync infrastructure.
//!
//! Plan B Task 8: the desktop OSS sync ENGINE has been deleted — the daemon
//! owns all team sync now (pull/push/conflict/version). What remains here is the
//! shared FC HTTP client and helpers that team-share onboarding and LiteLLM
//! provisioning still depend on:
//!
//!   fc_client.rs      — reqwest FC client with JWT injection and error mapping
//!   error.rs          — SyncError unified error type
//!   path_validator.rs — client-side mirror of FC validateSyncPath (referenced
//!                       by error.rs's From impl)
//!   get_fc_endpoint_and_jwt() — reads teamclaw.json for FC endpoint + JWT
//!
//! The deleted engine submodules were: engine, scanner, state, manifest,
//! conflict, crypto — plus the blob-transfer/version methods on FcClient and
//! the `oss_sync_*` Tauri command surface, which now live in
//! `crate::commands::team_sync_proxy` as thin daemon proxies.

pub mod error;
pub mod fc_client;
pub mod path_validator;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

pub(crate) fn get_fc_endpoint_and_jwt(workspace_path: &str) -> Result<(String, String), String> {
    // Read teamclaw.json to get fc_endpoint (falls back to default production URL).
    let config_path = std::path::Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(crate::commands::CONFIG_FILE_NAME);

    let json: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let base_url = json
        .get("fc_endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("https://cloud.ucar.cc")
        .trim_end_matches('/')
        .to_string();

    // JWT is the Supabase session token stored in env_blob.
    let jwt = json
        .get("supabase_jwt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| std::env::var("SUPABASE_JWT").ok())
        .ok_or_else(|| "supabase_jwt not found — user not logged in".to_string())?;

    Ok((base_url, jwt))
}
