//! `/v1/workspaces/:id/*` route handlers for workspace control-plane APIs.
//!
//! These handlers own the HTTP surface for all workspace-scoped settings:
//! providers, permissions, allowlist, and runtime status. They delegate
//! all reads/writes to `HttpState::workspace_control` so they never touch
//! `opencode.json` or the allowlist file directly.
//!
//! When `workspace_control` is `None` (no store configured) every handler
//! returns 404 with code `not_found`. This lets focused session/runtime
//! tests run without a workspace store.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Serialize;
use std::sync::Arc;

use crate::config::workspace_control::{
    AllowlistRule, ApplyOutcome, ManagedSkillDto, McpServerConfig, PermissionConfig,
    ProviderAuthRequest, ProviderInfo, RoleRecordDto, RolesSkillsStateDto, RuntimeStatus,
    WorkspaceControlError, WorkspaceControlStore,
};
use std::collections::HashMap;

use super::auth::{require_scope, Principal};
use super::errors::HttpError;
use super::state::HttpState;

// ── Helpers ──────────────────────────────────────────────────────────────────

fn resolve_store(
    state: &HttpState,
) -> Result<&Arc<dyn WorkspaceControlStore>, HttpError> {
    state
        .workspace_control
        .as_ref()
        .ok_or_else(|| HttpError::not_found("workspace control not configured"))
}

fn map_control_err(e: WorkspaceControlError) -> HttpError {
    match e {
        WorkspaceControlError::WorkspaceNotFound(id) => {
            HttpError::not_found(format!("workspace {id} not found"))
        }
        WorkspaceControlError::Io(e) => HttpError::internal(format!("io error: {e}")),
        WorkspaceControlError::Parse(e) => HttpError::internal(format!("parse error: {e}")),
    }
}

// ── Shared response wrapper ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ApplyResponse {
    pub outcome: ApplyOutcome,
}

fn apply_ok(outcome: ApplyOutcome) -> Json<ApplyResponse> {
    Json(ApplyResponse { outcome })
}

// ── Provider handlers ─────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/providers`
pub async fn get_providers(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ProviderInfo>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let providers = store
        .get_providers(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(providers))
}

/// `POST /v1/workspaces/:id/providers/:provider_id/auth`
///
/// Creates or replaces the authentication credentials for a provider entry.
pub async fn put_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(body): Json<ProviderAuthRequest>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.api_key.trim().is_empty() {
        return Err(HttpError::validation("api_key must not be empty"));
    }
    let store = resolve_store(&state)?;
    let outcome = store
        .put_provider_auth(&workspace_id, &provider_id, body)
        .map_err(map_control_err)?;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

/// `DELETE /v1/workspaces/:id/providers/:provider_id/auth`
pub async fn delete_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .delete_provider_auth(&workspace_id, &provider_id)
        .map_err(map_control_err)?;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

// ── Permission handlers ───────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/permissions`
pub async fn get_permissions(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<PermissionConfig>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let config = store
        .get_permissions(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(config))
}

/// `PUT /v1/workspaces/:id/permissions`
pub async fn put_permissions(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<PermissionConfig>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_permissions(&workspace_id, body)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── Allowlist handlers ────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/permission-allowlist`
pub async fn get_allowlist(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<AllowlistRule>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let rules = store
        .get_allowlist(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(rules))
}

/// `PUT /v1/workspaces/:id/permission-allowlist`
pub async fn put_allowlist(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<Vec<AllowlistRule>>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .put_allowlist(&workspace_id, body)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── MCP handlers ─────────────────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/mcp`
pub async fn get_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<HashMap<String, McpServerConfig>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let servers = store.get_mcp(&workspace_id).map_err(map_control_err)?;
    Ok(Json(servers))
}

/// `PUT /v1/workspaces/:id/mcp`
///
/// Replaces the entire MCP server map for a workspace. Callers should
/// fetch the current map with GET, apply their change, and PUT the full map.
pub async fn put_mcp(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<HashMap<String, McpServerConfig>>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store.put_mcp(&workspace_id, body).map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── Roles & skills handlers ───────────────────────────────────────────────────
pub async fn get_roles_skills(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<RolesSkillsStateDto>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let payload = store
        .get_roles_skills_state(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(payload))
}

/// `GET /v1/workspaces/:id/skills`
pub async fn get_skills(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<ManagedSkillDto>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let skills = store.get_skills(&workspace_id).map_err(map_control_err)?;
    Ok(Json(skills))
}

/// `GET /v1/workspaces/:id/roles`
pub async fn get_roles(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Vec<RoleRecordDto>>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let roles = store.get_roles(&workspace_id).map_err(map_control_err)?;
    Ok(Json(roles))
}

// ── Runtime status handlers ───────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/runtime`
pub async fn get_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<RuntimeStatus>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    let status = store
        .get_runtime_status(&workspace_id)
        .map_err(map_control_err)?;
    Ok(Json(status))
}

/// `POST /v1/workspaces/:id/runtime/reload`
pub async fn reload_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .reload_runtime(&workspace_id)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}
