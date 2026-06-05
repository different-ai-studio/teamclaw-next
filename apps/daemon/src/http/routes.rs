//! Public route table for the browser-facing HTTP API.
//!
//! PR1 ships the floor: `/v1/healthz` and `/v1/info`. Later PRs add
//! `/v1/auth/*`, `/v1/sessions/*`, `/v1/sessions/:id/stream`, etc.

use axum::{
    extract::State,
    middleware,
    routing::{delete, get, post, put, MethodRouter},
    Json, Router,
};

use super::auth;
use super::limit::{body_limit_layer, rate_limit_layer};
use super::observ::request_id_layer;
use super::sessions;
use super::state::HttpState;
use super::team;
use super::team_sync;
use super::workspaces;

pub fn build(state: HttpState) -> Router {
    let body_cap = state.config.max_body_bytes;
    Router::new()
        .route("/v1/healthz", healthz_route())
        .route("/v1/info", info_route())
        .route("/v1/auth/exchange", post(auth::exchange_handler))
        .route("/v1/auth/revoke", post(auth::revoke_handler))
        .route("/v1/auth/tokens", get(auth::list_tokens_handler))
        .route(
            "/v1/sessions",
            post(sessions::create_session).get(sessions::list_sessions),
        )
        .route(
            "/v1/sessions/:id",
            get(sessions::get_session).merge(delete(sessions::delete_session)),
        )
        .route("/v1/sessions/:id/prompt", post(sessions::send_prompt))
        .route("/v1/sessions/:id/cancel", post(sessions::cancel))
        .route("/v1/sessions/:id/model", post(sessions::set_model))
        .route(
            "/v1/sessions/:id/permissions/:request_id",
            post(sessions::reply_permission),
        )
        .route("/v1/sessions/:id/restart", post(sessions::restart))
        .route("/v1/sessions/:id/events", get(sessions::replay_events))
        .route("/v1/sessions/:id/stream", get(sessions::stream))
        // Register a workspace into the local registry + cloud (idempotent).
        // Used by the desktop on first launch to ensure its default team
        // workspace (`~/.amuxd/teams/<teamId>`) exists in both registries.
        .route("/v1/workspaces", post(workspaces::register_workspace))
        // Workspace control-plane APIs (Phase B/C)
        .route(
            "/v1/workspaces/:id/providers",
            get(workspaces::get_providers),
        )
        .route(
            "/v1/workspaces/:id/providers/:provider_id/auth",
            post(workspaces::put_provider_auth).delete(workspaces::delete_provider_auth),
        )
        .route(
            "/v1/workspaces/:id/provider-auth-methods",
            get(workspaces::get_provider_auth_methods),
        )
        .route(
            "/v1/workspaces/:id/providers/:provider_id/oauth/authorize",
            post(workspaces::post_provider_oauth_authorize),
        )
        .route(
            "/v1/workspaces/:id/providers/:provider_id/oauth/callback",
            post(workspaces::post_provider_oauth_callback),
        )
        .route(
            "/v1/workspaces/:id/model-catalog",
            get(workspaces::get_model_catalog),
        )
        .route(
            "/v1/workspaces/:id/permissions",
            get(workspaces::get_permissions).put(workspaces::put_permissions),
        )
        .route(
            "/v1/workspaces/:id/permission-allowlist",
            get(workspaces::get_allowlist).put(workspaces::put_allowlist),
        )
        .route(
            "/v1/workspaces/:id/mcp",
            get(workspaces::get_mcp).put(workspaces::put_mcp),
        )
        .route(
            "/v1/workspaces/:id/roles-skills",
            get(workspaces::get_roles_skills),
        )
        .route("/v1/workspaces/:id/skills", get(workspaces::get_skills))
        .route(
            "/v1/workspaces/:id/skills/:slug",
            put(workspaces::put_skill).delete(workspaces::delete_skill),
        )
        .route("/v1/workspaces/:id/roles", get(workspaces::get_roles))
        .route(
            "/v1/workspaces/:id/roles/:slug",
            put(workspaces::put_role).delete(workspaces::delete_role),
        )
        .route("/v1/workspaces/:id/runtime", get(workspaces::get_runtime))
        .route(
            "/v1/workspaces/:id/runtime/reload",
            post(workspaces::reload_runtime),
        )
        // Team-share: materialize the global dir + workspace symlink on demand
        // (called by the app right after enabling/joining team-share).
        .route("/v1/team/link", post(team::link_team_workspace))
        .route("/v1/team/unlink", post(team::unlink_team_workspace))
        // Daemon-owned team sync: desktop triggers sync + reads status over loopback.
        .route("/v1/team/sync", post(team_sync::sync_now))
        .route("/v1/team/sync/status", get(team_sync::sync_status))
        .route("/v1/team/secrets", post(team_sync::set_secrets))
        .route("/v1/team/conflicts", get(team_sync::list_conflicts))
        .route(
            "/v1/team/conflicts/resolve",
            post(team_sync::resolve_conflict),
        )
        .route("/v1/team/versions", get(team_sync::list_versions))
        .route(
            "/v1/team/versions/restore",
            post(team_sync::restore_version),
        )
        .route("/v1/team/file", get(team_sync::get_file))
        .route("/v1/team/changed", get(team_sync::list_changed))
        .layer(body_limit_layer(body_cap))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit_layer,
        ))
        .layer(middleware::from_fn(request_id_layer))
        .with_state(state)
}

fn healthz_route() -> MethodRouter<HttpState> {
    get(|| async { Json(serde_json::json!({ "status": "ok" })) })
}

fn info_route() -> MethodRouter<HttpState> {
    get(info_handler)
}

#[derive(serde::Serialize)]
struct InfoBody {
    version: &'static str,
    started_at: chrono::DateTime<chrono::Utc>,
    uptime_seconds: i64,
    actor_id: String,
    backend_kind: String,
}

async fn info_handler(State(state): State<HttpState>) -> Json<InfoBody> {
    let uptime = chrono::Utc::now()
        .signed_duration_since(state.meta.started_at)
        .num_seconds();
    Json(InfoBody {
        version: state.meta.version,
        started_at: state.meta.started_at,
        uptime_seconds: uptime,
        actor_id: state.meta.actor_id.clone(),
        backend_kind: state.meta.backend_kind.clone(),
    })
}
