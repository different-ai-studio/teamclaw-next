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
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::config::provider_auth::{
    builtin_provider_auth_methods, ProviderAuthMethodsResponse,
};
use crate::opencode_settings::LiveProviderCatalog;
use crate::opencode_settings::OpenCodeSettingsError;
use crate::config::workspace_control::{
    decode_workspace_path, AllowlistRule, ApplyOutcome, ManagedSkillDto, McpServerConfig,
    PermissionConfig, ProviderAuthRequest, ProviderInfo, RoleRecordDto, RolesSkillsStateDto,
    RuntimeStatus, UpsertRoleRequest, UpsertSkillRequest, WorkspaceControlError,
    WorkspaceControlStore,
};
use crate::proto::amux;
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
        WorkspaceControlError::NotFound(msg) => HttpError::not_found(msg),
        WorkspaceControlError::Io(e) => HttpError::internal(format!("io error: {e}")),
        WorkspaceControlError::Parse(e) => HttpError::internal(format!("parse error: {e}")),
        WorkspaceControlError::InvalidInput(msg) => HttpError::validation(msg),
    }
}

fn resolve_opencode_settings(
    state: &HttpState,
) -> Result<&Arc<crate::opencode_settings::OpenCodeSettingsService>, HttpError> {
    state
        .opencode_settings
        .as_ref()
        .ok_or_else(|| HttpError::runtime_unavailable("opencode settings service not configured"))
}

fn map_settings_err(e: OpenCodeSettingsError) -> HttpError {
    match e {
        OpenCodeSettingsError::OpencodeBinaryMissing(_)
        | OpenCodeSettingsError::SpawnFailed(_)
        | OpenCodeSettingsError::StartTimeout => HttpError::runtime_unavailable(e.to_string()),
        OpenCodeSettingsError::Api { status, detail } if (400..500).contains(&status) => {
            HttpError::validation(format!("opencode: {detail}"))
        }
        OpenCodeSettingsError::Api { status, detail } => {
            HttpError::internal(format!("opencode settings api {status}: {detail}"))
        }
        OpenCodeSettingsError::Http(msg) => HttpError::internal(msg),
    }
}

async fn workspace_path_or_404(workspace_id: &str) -> Result<std::path::PathBuf, HttpError> {
    let wpath = decode_workspace_path(workspace_id).map_err(map_control_err)?;
    if !wpath.is_dir() {
        return Err(HttpError::not_found(format!("workspace {workspace_id} not found")));
    }
    Ok(wpath)
}

/// Reload workspace runtimes so ACP picks up provider credential changes (OAuth / apiKey).
async fn reload_runtime_after_provider_auth(
    state: &HttpState,
    workspace_id: &str,
    workspace_path: &std::path::Path,
) -> ApplyOutcome {
    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        match supervisor
            .reload_workspace(workspace_id, workspace_path)
            .await
        {
            Ok(outcome) => return outcome,
            Err(e) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    error = %e,
                    "runtime reload after provider auth failed"
                );
            }
        }
    }
    ApplyOutcome::ReloadRequired
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
    let mut providers = store
        .get_providers(&workspace_id)
        .map_err(map_control_err)?;
    if let Some(settings) = state.opencode_settings.as_ref() {
        if let Ok(wpath) = workspace_path_or_404(&workspace_id).await {
            if let Ok(catalog) = settings.provider_catalog(&wpath).await {
                merge_live_provider_catalog(&mut providers, &catalog);
            } else if let Ok(connected) = settings.connected_provider_ids(&wpath).await {
                for provider in &mut providers {
                    if connected.iter().any(|id| id == &provider.id) {
                        provider.authenticated = true;
                    }
                }
            }
        }
    }
    Ok(Json(providers))
}

fn merge_live_provider_catalog(
    providers: &mut Vec<ProviderInfo>,
    catalog: &LiveProviderCatalog,
) {
    for connected_id in &catalog.connected {
        if let Some(live) = catalog.providers.get(connected_id) {
            if let Some(existing) = providers.iter_mut().find(|p| p.id == *connected_id) {
                existing.authenticated = true;
                if existing.models.is_empty() {
                    existing.models = live.model_ids.clone();
                }
                if existing.display_name == existing.id {
                    existing.display_name = live.display_name.clone();
                }
            } else {
                providers.push(ProviderInfo {
                    id: live.id.clone(),
                    display_name: live.display_name.clone(),
                    authenticated: true,
                    base_url: None,
                    models: live.model_ids.clone(),
                });
            }
        } else if let Some(existing) = providers.iter_mut().find(|p| p.id == *connected_id) {
            existing.authenticated = true;
        } else {
            providers.push(ProviderInfo {
                id: connected_id.clone(),
                display_name: connected_id.clone(),
                authenticated: true,
                base_url: None,
                models: Vec::new(),
            });
        }
    }
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
    let _file_outcome = store
        .put_provider_auth(&workspace_id, &provider_id, body)
        .map_err(map_control_err)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome =
        reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

/// `GET /v1/workspaces/:id/provider-auth-methods`
///
/// Auth methods per provider: live OpenCode `GET /provider/auth` merged with
/// built-in OAuth fallbacks when the settings server is unavailable.
pub async fn get_provider_auth_methods(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ProviderAuthMethodsResponse>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let _store = resolve_store(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    if let Some(settings) = state.opencode_settings.as_ref() {
        match settings.provider_auth_methods(&wpath).await {
            Ok(methods) => return Ok(Json(methods)),
            Err(
                e @ (OpenCodeSettingsError::OpencodeBinaryMissing(_)
                | OpenCodeSettingsError::SpawnFailed(_)
                | OpenCodeSettingsError::StartTimeout),
            ) => {
                tracing::warn!(error = %e, "opencode settings unavailable; using builtin auth catalog");
            }
            Err(e) => return Err(map_settings_err(e)),
        }
    }
    Ok(Json(builtin_provider_auth_methods()))
}

#[derive(Debug, Deserialize)]
pub struct ProviderOAuthAuthorizeRequest {
    #[serde(default)]
    pub method_index: u32,
    #[serde(default)]
    pub inputs: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct ProviderOAuthAuthorizeResponse {
    pub url: String,
    pub method: String,
    pub instructions: String,
}

/// `POST /v1/workspaces/:id/providers/:provider_id/oauth/authorize`
pub async fn post_provider_oauth_authorize(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(body): Json<ProviderOAuthAuthorizeRequest>,
) -> Result<Json<ProviderOAuthAuthorizeResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let _store = resolve_store(&state)?;
    let settings = resolve_opencode_settings(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let result = settings
        .oauth_authorize(&wpath, &provider_id, body.method_index, &body.inputs)
        .await
        .map_err(map_settings_err)?;
    Ok(Json(ProviderOAuthAuthorizeResponse {
        url: result.url,
        method: result.method,
        instructions: result.instructions,
    }))
}

#[derive(Debug, Deserialize)]
pub struct ProviderOAuthCallbackRequest {
    #[serde(default)]
    pub method_index: u32,
    pub code: Option<String>,
}

/// `POST /v1/workspaces/:id/providers/:provider_id/oauth/callback`
pub async fn post_provider_oauth_callback(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
    Json(body): Json<ProviderOAuthCallbackRequest>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let _store = resolve_store(&state)?;
    let settings = resolve_opencode_settings(&state)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    settings
        .oauth_callback(
            &wpath,
            &provider_id,
            body.method_index,
            body.code.as_deref(),
        )
        .await
        .map_err(map_settings_err)?;
    let outcome =
        reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok(apply_ok(outcome))
}

/// `DELETE /v1/workspaces/:id/providers/:provider_id/auth`
pub async fn delete_provider_auth(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, provider_id)): Path<(String, String)>,
) -> Result<(StatusCode, Json<ApplyResponse>), HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    if let Some(settings) = state.opencode_settings.as_ref() {
        if let Ok(wpath) = workspace_path_or_404(&workspace_id).await {
            if let Err(e) = settings.remove_provider_auth(&wpath, &provider_id).await {
                tracing::warn!(
                    provider_id = %provider_id,
                    error = %e,
                    "opencode remove auth failed; continuing with workspace store delete"
                );
            }
        }
    }
    let _file_outcome = store
        .delete_provider_auth(&workspace_id, &provider_id)
        .map_err(map_control_err)?;
    let wpath = workspace_path_or_404(&workspace_id).await?;
    let outcome =
        reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
    Ok((StatusCode::OK, apply_ok(outcome)))
}

// ── Model catalog ─────────────────────────────────────────────────────────────
//
// `GET /v1/workspaces/:id/model-catalog` returns the workspace's available
// models grouped by the agent backend that would actually run them. This is the
// single source of truth for the cron job dialog (and future automation
// settings), replacing the old behavior of showing only OpenCode providers
// regardless of which backend the daemon runs.
//
// Per-backend model sources:
//   - opencode: workspace `opencode.json` providers (via WorkspaceControlStore)
//   - claude:   the runtime's static Claude model table
//   - codex:    the runtime's static Codex model table (empty today)

/// A single selectable model within a backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogModel {
    /// Stable reference stored as the cron payload model string. Always
    /// `"<providerSegment>/<modelId>"` so the existing `provider/model` wire
    /// format (parsed by `parse_model_preference`) keeps working:
    /// - opencode: `"<provider>/<modelId>"` (the ACP model id)
    /// - claude: `"claude-code/<modelId>"` (provider segment is a marker;
    ///   `resolve_initial_model` ignores it for ClaudeCode)
    /// - codex: `"codex/<modelId>"`
    #[serde(rename = "ref")]
    pub model_ref: String,
    pub model_id: String,
    pub display_name: String,
}

/// Models available under one agent backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BackendCatalog {
    /// Backend id as reported by the daemon: `"opencode" | "claude" | "codex"`.
    pub backend: String,
    /// Human-readable label for the backend group header.
    pub label: String,
    pub models: Vec<CatalogModel>,
}

/// Full per-backend model catalog for a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelCatalog {
    /// Backend a cron job runs on when it doesn't specify one — mirrors the
    /// daemon's `default_agent_type` precedence (opencode → claude → codex).
    /// `None` when no backend is configured.
    pub automation_default_backend: Option<String>,
    pub backends: Vec<BackendCatalog>,
}

fn backend_label(backend: &str) -> &'static str {
    match backend {
        "opencode" => "OpenCode",
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => "Agent",
    }
}

/// Build the catalog from the configured backend list and the workspace's
/// OpenCode providers. Pure (no I/O) so it is unit-testable; the handler does
/// the `get_providers` read and passes the result in.
pub fn build_model_catalog(
    configured_agent_types: &[String],
    opencode_providers: &[ProviderInfo],
) -> ModelCatalog {
    let mut backends = Vec::new();

    for backend in configured_agent_types {
        let models: Vec<CatalogModel> = match backend.as_str() {
            "opencode" => opencode_providers
                .iter()
                .flat_map(|p| {
                    p.models.iter().map(move |model_id| CatalogModel {
                        model_ref: format!("{}/{}", p.id, model_id),
                        model_id: model_id.clone(),
                        display_name: model_id.clone(),
                    })
                })
                .collect(),
            "claude" => crate::runtime::models::available_models_for(amux::AgentType::ClaudeCode)
                .into_iter()
                .map(|m| CatalogModel {
                    model_ref: format!("claude-code/{}", m.id),
                    model_id: m.id,
                    display_name: m.display_name,
                })
                .collect(),
            "codex" => crate::runtime::models::available_models_for(amux::AgentType::Codex)
                .into_iter()
                .map(|m| CatalogModel {
                    model_ref: format!("codex/{}", m.id),
                    model_id: m.id,
                    display_name: m.display_name,
                })
                .collect(),
            _ => Vec::new(),
        };
        backends.push(BackendCatalog {
            backend: backend.clone(),
            label: backend_label(backend).to_string(),
            models,
        });
    }

    // Mirror RuntimeManager::default_agent_type precedence.
    let automation_default_backend = ["opencode", "claude", "codex"]
        .iter()
        .find(|b| configured_agent_types.iter().any(|c| c == *b))
        .map(|s| s.to_string());

    ModelCatalog {
        automation_default_backend,
        backends,
    }
}

/// `GET /v1/workspaces/:id/model-catalog`
pub async fn get_model_catalog(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ModelCatalog>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let store = resolve_store(&state)?;
    // Always read providers; build_model_catalog only uses them when the
    // opencode backend is configured.
    let providers = store
        .get_providers(&workspace_id)
        .map_err(map_control_err)?;
    let catalog = build_model_catalog(&state.meta.configured_agent_types, &providers);
    Ok(Json(catalog))
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

#[derive(serde::Deserialize)]
pub struct DeleteSkillQuery {
    #[serde(default, rename = "dirPath")]
    dir_path: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct DeleteRoleQuery {
    #[serde(default, rename = "filePath")]
    file_path: Option<String>,
}

/// `PUT /v1/workspaces/:id/skills/:slug`
pub async fn put_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Json(body): Json<UpsertSkillRequest>,
) -> Result<Json<ManagedSkillDto>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.content.trim().is_empty() {
        return Err(HttpError::validation("content must not be empty"));
    }
    let store = resolve_store(&state)?;
    let skill = store
        .put_skill(&workspace_id, &slug, body)
        .map_err(map_control_err)?;
    Ok(Json(skill))
}

/// `DELETE /v1/workspaces/:id/skills/:slug`
pub async fn delete_skill(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Query(query): Query<DeleteSkillQuery>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .delete_skill(
            &workspace_id,
            &slug,
            query.dir_path.as_deref(),
        )
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

/// `PUT /v1/workspaces/:id/roles/:slug`
pub async fn put_role(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Json(body): Json<UpsertRoleRequest>,
) -> Result<Json<RoleRecordDto>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    if body.raw_markdown.trim().is_empty() {
        return Err(HttpError::validation("raw_markdown must not be empty"));
    }
    let store = resolve_store(&state)?;
    let role = store
        .put_role(&workspace_id, &slug, body)
        .map_err(map_control_err)?;
    Ok(Json(role))
}

/// `DELETE /v1/workspaces/:id/roles/:slug`
pub async fn delete_role(
    principal: Principal,
    State(state): State<HttpState>,
    Path((workspace_id, slug)): Path<(String, String)>,
    Query(query): Query<DeleteRoleQuery>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let store = resolve_store(&state)?;
    let outcome = store
        .delete_role(
            &workspace_id,
            &slug,
            query.file_path.as_deref(),
        )
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

// ── Runtime status handlers ───────────────────────────────────────────────────

/// `GET /v1/workspaces/:id/runtime`
pub async fn get_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<RuntimeStatus>, HttpError> {
    require_scope(&principal, "workspace:read")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let status = supervisor
            .runtime_status(&workspace_id, &workspace_path)
            .await
            .map_err(map_control_err)?;
        return Ok(Json(status));
    }

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
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let outcome = supervisor
            .reload_workspace(&workspace_id, &workspace_path)
            .await
            .map_err(map_control_err)?;
        return Ok(apply_ok(outcome));
    }

    let store = resolve_store(&state)?;
    let outcome = store
        .reload_runtime(&workspace_id)
        .map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str, models: &[&str]) -> ProviderInfo {
        ProviderInfo {
            id: id.to_string(),
            display_name: id.to_string(),
            authenticated: true,
            base_url: None,
            models: models.iter().map(|m| m.to_string()).collect(),
        }
    }

    #[test]
    fn opencode_models_use_provider_prefixed_ref() {
        let providers = vec![provider("scnet", &["MiniMax-M2.5"])];
        let catalog = build_model_catalog(&["opencode".to_string()], &providers);

        assert_eq!(catalog.automation_default_backend.as_deref(), Some("opencode"));
        assert_eq!(catalog.backends.len(), 1);
        let oc = &catalog.backends[0];
        assert_eq!(oc.backend, "opencode");
        assert_eq!(oc.label, "OpenCode");
        assert_eq!(oc.models.len(), 1);
        // Ref must keep the provider segment so it matches the ACP model id.
        assert_eq!(oc.models[0].model_ref, "scnet/MiniMax-M2.5");
        assert_eq!(oc.models[0].model_id, "MiniMax-M2.5");
    }

    #[test]
    fn claude_models_use_static_table_with_claude_code_prefix() {
        let catalog = build_model_catalog(&["claude".to_string()], &[]);

        assert_eq!(catalog.automation_default_backend.as_deref(), Some("claude"));
        let claude = &catalog.backends[0];
        assert_eq!(claude.backend, "claude");
        assert_eq!(claude.label, "Claude Code");
        assert!(!claude.models.is_empty(), "claude has a static model table");
        // Every ref is "claude-code/<id>" so parse_model_preference yields a
        // ("claude-code", <id>) pair; resolve_initial_model ignores the
        // provider segment for ClaudeCode.
        for m in &claude.models {
            assert_eq!(m.model_ref, format!("claude-code/{}", m.model_id));
        }
        assert!(claude.models.iter().any(|m| m.model_id == "claude-sonnet-4-6"));
    }

    #[test]
    fn multiple_backends_preserve_order_and_default_precedence() {
        // Configured in a non-precedence order; default must still be opencode.
        let catalog =
            build_model_catalog(&["claude".to_string(), "opencode".to_string()], &[]);
        assert_eq!(catalog.automation_default_backend.as_deref(), Some("opencode"));
        // Backends keep the configured order (claude first here).
        assert_eq!(catalog.backends[0].backend, "claude");
        assert_eq!(catalog.backends[1].backend, "opencode");
    }

    #[test]
    fn empty_config_yields_no_default_and_no_backends() {
        let catalog = build_model_catalog(&[], &[]);
        assert!(catalog.automation_default_backend.is_none());
        assert!(catalog.backends.is_empty());
    }

    #[test]
    fn codex_backend_is_present_even_when_model_table_empty() {
        let catalog = build_model_catalog(&["codex".to_string()], &[]);
        assert_eq!(catalog.automation_default_backend.as_deref(), Some("codex"));
        assert_eq!(catalog.backends[0].backend, "codex");
        // Static codex table is empty today; the group still appears so the UI
        // can show a "no models" hint rather than hiding the backend.
        assert!(catalog.backends[0].models.is_empty());
    }
}
