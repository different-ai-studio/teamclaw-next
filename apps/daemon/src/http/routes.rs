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
        // Workspace control-plane APIs (Phase B/C)
        .route(
            "/v1/workspaces/:id/providers",
            get(workspaces::get_providers),
        )
        .route(
            "/v1/workspaces/:id/providers/:provider_id/auth",
            post(workspaces::put_provider_auth)
                .delete(workspaces::delete_provider_auth),
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
            "/v1/workspaces/:id/runtime",
            get(workspaces::get_runtime),
        )
        .route(
            "/v1/workspaces/:id/runtime/reload",
            post(workspaces::reload_runtime),
        )
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
