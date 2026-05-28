//! Smoke test for `team_share::create_team` (Task 5).
//!
//! Verifies that the slim create command:
//!   1. POSTs `{ name }` to `/v1/teams` against the configured FC endpoint.
//!   2. Returns `{ team_id, team_slug }`.
//!   3. Does NOT write any OSS-mode fields (`oss_team_id`, `team_mode`,
//!      `oss_team_slug`, `ai_gateway_endpoint`, `litellm_key`) into the
//!      workspace `teamclaw.json`.
//!
//! Secret persistence is intentionally NOT asserted here — `team_secret_store`
//! talks to the OS keychain / a host-wide env blob, which is not safely
//! isolatable inside a `cargo test` run. Task 6 (which actually generates
//! and stores secrets) will exercise that path under its own harness.

use serde_json::json;
use teamclaw_lib::commands::team_share;
use tempfile::TempDir;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Construct a workspace dir + write `.teamclaw/teamclaw.json` pointing at
/// the mock FC endpoint, with a fake supabase_jwt.
fn seed_workspace(tmp: &TempDir, fc_endpoint: &str) -> String {
    let workspace = tmp.path().to_path_buf();
    // Mirror `commands::TEAMCLAW_DIR` (`.teamclaw`) / `CONFIG_FILE_NAME`
    // (`teamclaw.json`) using the APP_SHORT_NAME compiled into the lib.
    let cfg_dir = workspace.join(".teamclaw");
    std::fs::create_dir_all(&cfg_dir).expect("mkdir .teamclaw");
    let cfg = json!({
        "fc_endpoint": fc_endpoint,
        "supabase_jwt": "test-jwt",
    });
    std::fs::write(
        cfg_dir.join("teamclaw.json"),
        serde_json::to_string_pretty(&cfg).unwrap(),
    )
    .expect("write teamclaw.json");
    workspace.to_string_lossy().into_owned()
}

fn read_cfg(workspace_path: &str) -> serde_json::Value {
    let p = std::path::Path::new(workspace_path)
        .join(".teamclaw")
        .join("teamclaw.json");
    let s = std::fs::read_to_string(p).expect("read teamclaw.json");
    serde_json::from_str(&s).expect("parse teamclaw.json")
}

#[tokio::test]
async fn create_team_slim_only_calls_v1_teams_and_returns_id_slug() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/teams"))
        .and(header("authorization", "Bearer test-jwt"))
        .and(body_partial_json(json!({ "name": "alpha" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "t1",
            "name": "alpha",
            "slug": "alpha",
            "aiGatewayEndpoint": null,
            "litellmKey": null,
        })))
        .mount(&server)
        .await;

    let tmp = TempDir::new().expect("tempdir");
    let workspace = seed_workspace(&tmp, &server.uri());

    let result = team_share::create_team("alpha".to_string(), workspace.clone())
        .await
        .expect("create_team should succeed");

    assert_eq!(result.team_id, "t1");
    assert_eq!(result.team_slug, "alpha");

    // The slim command must NOT have written any onboarding/share fields
    // into the workspace config. Only the pre-seeded keys should remain.
    let cfg = read_cfg(&workspace);
    let obj = cfg.as_object().expect("config is object");
    for forbidden in [
        "team_mode",
        "oss_team_id",
        "oss_team_slug",
        "ai_gateway_endpoint",
        "litellm_key",
        "share_mode",
    ] {
        assert!(
            !obj.contains_key(forbidden),
            "team_share::create_team must not write `{forbidden}` (Task 5 is slim)",
        );
    }
    // Pre-seeded keys preserved.
    assert_eq!(obj.get("supabase_jwt").and_then(|v| v.as_str()), Some("test-jwt"));
    assert_eq!(obj.get("fc_endpoint").and_then(|v| v.as_str()), Some(server.uri().as_str()));
}
