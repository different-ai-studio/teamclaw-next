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
//!   get_fc_endpoint() — reads teamclaw.json for the FC endpoint (callers
//!                       supply their own fresh user JWT; see Design 2)
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

/// Read the FC endpoint from the workspace's `teamclaw.json` (falling back to
/// the production URL).
///
/// The FC JWT is **not** read here anymore. Each Tauri command receives the
/// caller's own fresh user session token (from the frontend `getSession()`,
/// which is kept current by the session-store auto-refresh) and passes it to
/// `FcClient`. The previous behaviour read a `supabase_jwt` cached in
/// `teamclaw.json` that nothing refreshed after the daemon-owns-team-sync
/// refactor (#296) gutted the JWT bridge — so it went stale and FC returned
/// 401. Tauri uses its own token; the daemon uses its own; neither crosses.
pub(crate) fn get_fc_endpoint(workspace_path: &str) -> String {
    // Read teamclaw.json to get fc_endpoint (falls back to default production URL).
    let config_path = std::path::Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(crate::commands::CONFIG_FILE_NAME);

    let json: serde_json::Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    json.get("fc_endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("https://cloud.ucar.cc")
        .trim_end_matches('/')
        .to_string()
}
