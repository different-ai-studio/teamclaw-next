use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::mcp::{self, MCPServerConfig};
use crate::process_util::CommandNoWindow;

// ─── Types ──────────────────────────────────────────────────────────────────

/// A single model entry in the team LLM configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmModelEntry {
    pub id: String,
    pub name: String,
}

/// LLM configuration stored in teamclaw.json under "llm" key.
/// Replaces the old teamclaw-team/teamclaw.yaml file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    pub model_name: String,
    /// Multiple selectable models. When present, users can switch between these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<LlmModelEntry>,
}

/// Unified team status returned by check_team_status().
/// Single source of truth for "is this workspace in team mode?"
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStatus {
    /// Whether a team mode is currently active
    pub active: bool,
    /// Which team mode: "webdav" or "git"
    pub mode: Option<String>,
    /// Team LLM configuration, if present
    pub llm: Option<LlmConfig>,
}

/// Git team configuration stored in .teamclaw/teamclaw.json under "team".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub git_url: String,
    pub enabled: bool,
    pub last_sync_at: Option<String>,
    #[serde(default = "default_shared_dir_name")]
    pub shared_dir_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fc_endpoint: Option<String>,
}

fn default_shared_dir_name() -> String {
    "teamclaw".to_string()
}

/// One untracked file surfaced by the sync precheck.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPrecheckFile {
    pub path: String,
    pub size_bytes: u64,
}

/// Result of a git operation.
///
/// `needs_confirmation` is set by `team_sync_repo` when untracked files exceed
/// thresholds and the caller did not pass `force=true`. In that case `new_files`
/// and `total_bytes` describe what would have been staged, and the sync did NOT run.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamGitResult {
    pub success: bool,
    pub message: String,
    #[serde(default)]
    pub needs_confirmation: bool,
    #[serde(default)]
    pub new_files: Vec<SyncPrecheckFile>,
    #[serde(default)]
    pub total_bytes: u64,
}

/// Team metadata stored in _meta/team.json (committed to Git)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMeta {
    pub team_id: String,
    pub team_name: String,
    /// HMAC-SHA256(team_secret, "teamclaw-verify") as hex — for join verification
    pub secret_verify: String,
    pub created_at: String,
    pub owner_node_id: String,
    /// LiteLLM/FC endpoint URL. When set, joining members register their key
    /// via this endpoint. Older team repos without this field default to no
    /// LiteLLM (joiners can still join, but won't get a cloud key issued).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fc_endpoint: Option<String>,
}

/// Result of team git create
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamGitCreateResult {
    pub team_id: String,
    pub team_secret: String,
}

/// Compute HMAC-SHA256(secret_hex, "teamclaw-verify") and return hex string.
fn compute_secret_verify(team_secret: &str) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;

    let secret_bytes = hex::decode(team_secret).map_err(|e| format!("Invalid hex secret: {e}"))?;
    let mut mac =
        HmacSha256::new_from_slice(&secret_bytes).map_err(|e| format!("HMAC init failed: {e}"))?;
    mac.update(b"teamclaw-verify");
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// Result of workspace git check
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitCheckResult {
    pub has_git: bool,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Run a git command in a given directory
fn run_git(args: &[&str], cwd: &str) -> Result<(bool, String, String), String> {
    let output = Command::new("git")
        .no_window()
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0") // Never prompt for credentials interactively
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// Run `git clone` with `--filter=blob:none` (partial clone) for speed —
/// fetches the commit graph + trees but defers blobs until a working-tree
/// file actually needs them. Keeps the per-file commit history viewer
/// working (which `--depth=1` would break) while cutting initial clone
/// time roughly in proportion to the size of historical blob churn.
///
/// If the server rejects the filter (old self-hosted GitLab/Gitea or
/// `uploadpack.allowFilter=false`), retry as a plain full clone so the
/// join flow still succeeds.
///
/// `base_args` must be the regular clone arg list, starting with "clone"
/// and ending with the target dir (the same shape each call site builds).
fn run_clone_with_partial_fallback(
    base_args: &[&str],
    cwd: &str,
) -> Result<(bool, String, String), String> {
    debug_assert_eq!(base_args.first().copied(), Some("clone"));
    let mut filtered: Vec<&str> = Vec::with_capacity(base_args.len() + 1);
    filtered.push("clone");
    filtered.push("--filter=blob:none");
    filtered.extend_from_slice(&base_args[1..]);

    let first = run_git(&filtered, cwd)?;
    if first.0 {
        return Ok(first);
    }

    let stderr_lc = first.2.to_lowercase();
    let filter_unsupported = stderr_lc.contains("filter")
        && (stderr_lc.contains("not supported")
            || stderr_lc.contains("unsupported")
            || stderr_lc.contains("uploadpack.allowfilter")
            || stderr_lc.contains("server does not support"));
    if !filter_unsupported {
        return Ok(first);
    }

    // Clean up any partial state from the failed filtered attempt before
    // retrying as a plain full clone.
    if let Some(target) = base_args.last() {
        let target_path = Path::new(cwd).join(target);
        if target_path.exists() {
            let _ = std::fs::remove_dir_all(&target_path);
        }
    }
    eprintln!("[team_git_clone] Server rejected --filter=blob:none, falling back to full clone");
    run_git(base_args, cwd)
}

/// Parse the NUL-delimited output of `git status --porcelain -z -uall`
/// and return only the paths of untracked entries (records starting with `?? `).
fn parse_untracked_paths(porcelain_bytes: &[u8]) -> Vec<String> {
    porcelain_bytes
        .split(|&b| b == 0)
        .filter_map(|record| {
            if record.len() > 3 && &record[..3] == b"?? " {
                Some(String::from_utf8_lossy(&record[3..]).to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Embed a Personal Access Token into an HTTPS git URL.
/// - `https://git.garena.com/path` → `https://oauth2:TOKEN@git.garena.com/path`
/// - SSH URLs are returned as-is (they don't use tokens).
fn embed_token_in_url(url: &str, token: &str) -> String {
    if token.is_empty() {
        return url.to_string();
    }
    // Handle https:// URLs
    if let Some(rest) = url.strip_prefix("https://") {
        // If there's already a user@ prefix, replace or inject password
        if let Some(at_pos) = rest.find('@') {
            let user_part = &rest[..at_pos];
            let host_part = &rest[at_pos + 1..];
            if user_part.contains(':') {
                // Already has user:password — replace password
                let user = user_part.split(':').next().unwrap_or("oauth2");
                format!("https://{}:{}@{}", user, token, host_part)
            } else {
                // Has user but no password — add token as password
                format!("https://{}:{}@{}", user_part, token, host_part)
            }
        } else {
            // No credentials at all — add oauth2:token
            format!("https://oauth2:{}@{}", token, rest)
        }
    } else if let Some(rest) = url.strip_prefix("http://") {
        if let Some(at_pos) = rest.find('@') {
            let user_part = &rest[..at_pos];
            let host_part = &rest[at_pos + 1..];
            let user = user_part.split(':').next().unwrap_or("oauth2");
            format!("http://{}:{}@{}", user, token, host_part)
        } else {
            format!("http://oauth2:{}@{}", token, rest)
        }
    } else {
        // SSH or other protocol — return as-is
        url.to_string()
    }
}

/// Check if a URL is an HTTPS URL
fn is_https_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Get the workspace path for the calling window. Looks up the window's label
/// in `WindowRegistry`; falls back to the current workspace for single-window flows.
pub fn get_workspace_path(
    window: &tauri::WebviewWindow,
    registry: &crate::commands::window::WindowRegistry,
) -> Result<String, String> {
    crate::commands::window::current_workspace_for_window(window, registry)
}

/// Resolve a workspace path from an explicit frontend argument when provided,
/// otherwise fall back to the calling window's registered workspace.
///
/// In multi-window mode, the frontend should always pass `workspacePath`.
/// The fallback exists so single-window flows (and frontends that haven't
/// been migrated yet) keep working.
pub fn resolve_workspace_path(
    workspace_path: Option<String>,
    window: &tauri::WebviewWindow,
    registry: &crate::commands::window::WindowRegistry,
) -> Result<String, String> {
    if let Some(path) = workspace_path.filter(|path| !path.is_empty()) {
        return Ok(path);
    }
    get_workspace_path(window, registry)
}

// Re-export TEAM_REPO_DIR from parent so existing `crate::commands::team::TEAM_REPO_DIR` paths work.
pub use super::TEAM_REPO_DIR;

/// Scaffold the teamclaw-team directory with default structure if it doesn't exist or is empty.
pub fn scaffold_team_dir(team_dir: &str) -> Result<(), String> {
    let team_path = Path::new(team_dir);

    let is_empty = !team_path.exists()
        || team_path
            .read_dir()
            .map(|mut d| d.next().is_none())
            .unwrap_or(true);

    if !is_empty {
        return Ok(());
    }

    let dirs = [
        "skills",
        ".mcp",
        "knowledge",
        "_feedback",
        "_meta",
        "_secrets",
    ];
    for d in &dirs {
        std::fs::create_dir_all(team_path.join(d))
            .map_err(|e| format!("Failed to create {}: {}", d, e))?;
    }

    let readme_path = team_path.join("README.md");
    if !readme_path.exists() {
        let readme = "# TeamClaw Team Drive\n\nShared team resources.\n\n## Structure\n\n- `skills/` - Shared agent skills\n- `.mcp/` - MCP server configurations\n- `knowledge/` - Shared knowledge base\n- `_feedback/` - Member feedback summaries (auto-synced)\n- `_meta/` - Shared team metadata and app-managed files\n";
        std::fs::write(&readme_path, readme)
            .map_err(|e| format!("Failed to write README.md: {}", e))?;
    }

    Ok(())
}

/// Ensure the .gitignore in team_dir has all rules from GITIGNORE_CONTENT.
/// Appends missing rules if the file exists, or creates it if missing.
fn ensure_gitignore_rules(team_dir: &str) {
    let gitignore_path = Path::new(team_dir).join(".gitignore");
    if !gitignore_path.exists() {
        let _ = std::fs::write(&gitignore_path, GITIGNORE_CONTENT);
        return;
    }
    let existing = match std::fs::read_to_string(&gitignore_path) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut missing = Vec::new();
    for line in GITIGNORE_CONTENT.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if !existing.lines().any(|l| l.trim() == t) {
            missing.push(t.to_string());
        }
    }
    if missing.is_empty() {
        return;
    }
    let mut content = existing;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("\n# Auto-added by TeamClaw\n");
    for line in &missing {
        content.push_str(line);
        content.push('\n');
    }
    let _ = std::fs::write(&gitignore_path, content);
}

fn get_team_repo_path(workspace_path: &str) -> String {
    let p = Path::new(workspace_path).join(TEAM_REPO_DIR);
    p.to_string_lossy().to_string()
}

/// Build an LlmConfig from optional parameters.
/// Returns None when no base_url is provided (user chose not to host LLM).
pub fn build_llm_config(
    base_url: Option<String>,
    model: Option<String>,
    model_name: Option<String>,
    models_json: Option<String>,
) -> Option<LlmConfig> {
    let url = base_url.filter(|s| !s.is_empty())?;
    let models: Vec<LlmModelEntry> = models_json
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Use first model from array as default if model/model_name not explicitly set
    let default_model = models.first();
    Some(LlmConfig {
        base_url: url,
        model: model
            .filter(|s| !s.is_empty())
            .or_else(|| default_model.map(|m| m.id.clone()))
            .unwrap_or_else(|| "default".to_string()),
        model_name: model_name
            .filter(|s| !s.is_empty())
            .or_else(|| default_model.map(|m| m.name.clone()))
            .unwrap_or_else(|| "default".to_string()),
        models,
    })
}

/// Write LLM config to teamclaw.json under "llm" key, preserving other fields.
pub fn write_llm_config(workspace_path: &str, config: Option<&LlmConfig>) -> Result<(), String> {
    let teamclaw_dir = format!("{}/{}", workspace_path, crate::commands::TEAMCLAW_DIR);
    let _ = std::fs::create_dir_all(&teamclaw_dir);
    let config_path = format!("{}/{}", teamclaw_dir, super::CONFIG_FILE_NAME);

    let mut json: serde_json::Value = if Path::new(&config_path).exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
        serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))?
    } else {
        serde_json::json!({
            "$schema": "https://opencode.ai/config.json"
        })
    };

    if let Some(llm_config) = config {
        let llm_val = serde_json::to_value(llm_config)
            .map_err(|e| format!("Failed to serialize llm config: {}", e))?;
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .insert("llm".to_string(), llm_val);
    } else {
        json.as_object_mut()
            .ok_or_else(|| format!("{} is not an object", super::CONFIG_FILE_NAME))?
            .remove("llm");
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

/// Single source of truth: check whether this workspace has an active team mode.
/// Reads .teamclaw/teamclaw.json once and returns TeamStatus with mode + LLM config.
pub fn check_team_status(workspace_path: &str) -> TeamStatus {
    let config_path = Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    let json = match std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
    {
        Some(v) => v,
        None => {
            return TeamStatus {
                active: false,
                mode: None,
                llm: None,
            }
        }
    };

    // Determine mode: explicit field first, then infer from enabled flags
    let mode = json
        .get("team_mode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            if json
                .get("webdav")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                Some("webdav".to_string())
            } else if json
                .get("team")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                == Some(true)
            {
                Some("git".to_string())
            } else {
                None
            }
        });

    // Read LLM config
    let llm = json
        .get("llm")
        .and_then(|v| serde_json::from_value::<LlmConfig>(v.clone()).ok());

    let active = mode.is_some();
    TeamStatus { active, mode, llm }
}

/// Write the team_mode field in .teamclaw/teamclaw.json.
/// Pass None to clear it (on disconnect).
pub fn write_team_mode(workspace_path: &str, mode: Option<&str>) -> Result<(), String> {
    let teamclaw_dir = Path::new(workspace_path).join(crate::commands::TEAMCLAW_DIR);
    std::fs::create_dir_all(&teamclaw_dir)
        .map_err(|e| format!("Failed to create {}: {}", super::TEAMCLAW_DIR, e))?;

    let config_path = teamclaw_dir.join(super::CONFIG_FILE_NAME);
    let mut json: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    match mode {
        Some(m) => json["team_mode"] = serde_json::Value::String(m.to_string()),
        None => {
            json.as_object_mut().map(|o| o.remove("team_mode"));
        }
    }

    let content = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

fn read_workspace_config(workspace_path: &str) -> Result<serde_json::Value, String> {
    let config_path = Path::new(workspace_path)
        .join(crate::commands::TEAMCLAW_DIR)
        .join(super::CONFIG_FILE_NAME);

    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", super::CONFIG_FILE_NAME, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", super::CONFIG_FILE_NAME, e))
}

fn write_workspace_config(workspace_path: &str, json: &serde_json::Value) -> Result<(), String> {
    let teamclaw_dir = Path::new(workspace_path).join(crate::commands::TEAMCLAW_DIR);
    std::fs::create_dir_all(&teamclaw_dir)
        .map_err(|e| format!("Failed to create {}: {}", super::TEAMCLAW_DIR, e))?;

    let config_path = teamclaw_dir.join(super::CONFIG_FILE_NAME);
    let content = serde_json::to_string_pretty(json)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    std::fs::write(&config_path, content)
        .map_err(|e| format!("Failed to write {}: {}", super::CONFIG_FILE_NAME, e))
}

#[tauri::command]
pub async fn get_team_config(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<Option<TeamConfig>, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let json = read_workspace_config(&workspace_path)?;
    json.get("team")
        .cloned()
        .map(serde_json::from_value::<TeamConfig>)
        .transpose()
        .map_err(|e| format!("Failed to parse team config: {}", e))
}

/// The whitelist .gitignore content
pub const GITIGNORE_CONTENT: &str = r#"# ============================================
# TeamClaw Team Drive — Whitelist mode
# Ignore everything by default, only allow shared layer
# ============================================

# 1. Ignore all files by default
*

# 2. Allow shared layers
!skills/
!skills/**
!.mcp/
!.mcp/**
!knowledge/
!knowledge/**
!_feedback/
!_feedback/**
!_meta/
!_meta/**
!_secrets/
!_secrets/**
!.leaderboard/
!.leaderboard/**

# 3. Allow workspace config
!.gitignore
!README.md

# 4. Explicitly ignore (never sync)
.trash/
.DS_Store
node_modules/
.git/
target/
dist/
build/
out/
.cache/
.turbo/
.next/
.nuxt/
.output/
__pycache__/
.venv/
venv/
.tox/
vendor/
.gradle/
.m2/
*.log
*.tmp
"#;

// ─── Team MCP Sync ──────────────────────────────────────────────────────────

/// Team MCP config format (Cursor / standard MCP format)
/// Each .json file in .mcp/ contains:
/// ```json
/// {
///   "mcpServers": {
///     "name": {
///       "command": "npx",
///       "args": ["@playwright/mcp@latest"],
///       "env": { "KEY": "value" }
///     }
///   }
/// }
/// ```
#[derive(Debug, Deserialize)]
struct TeamMCPFile {
    #[serde(rename = "mcpServers", default)]
    mcp_servers: HashMap<String, TeamMCPServer>,
}

#[derive(Debug, Deserialize)]
struct TeamMCPServer {
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
}

/// Scan .mcp/*.json from a directory and merge into opencode.json's mcp section (in workspace).
/// Team MCP servers are added/updated but never remove existing user-configured servers.
/// Returns the number of servers synced.
fn sync_team_mcp_configs_from_dir(
    mcp_source_dir: &str,
    workspace_path: &str,
) -> Result<usize, String> {
    let mcp_dir = Path::new(mcp_source_dir).join(".mcp");

    if !mcp_dir.exists() || !mcp_dir.is_dir() {
        return Ok(0); // No .mcp directory — nothing to sync
    }

    // Read all .json files from .mcp/
    let entries = std::fs::read_dir(&mcp_dir)
        .map_err(|e| format!("Failed to read .mcp/ directory: {}", e))?;

    let mut team_servers: IndexMap<String, MCPServerConfig> = IndexMap::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        // Only process .json files
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                println!("[Team MCP Sync] Failed to read {}: {}", path.display(), e);
                continue;
            }
        };

        let team_file: TeamMCPFile = match serde_json::from_str(&content) {
            Ok(f) => f,
            Err(e) => {
                println!("[Team MCP Sync] Failed to parse {}: {}", path.display(), e);
                continue;
            }
        };

        // Convert each team server to OpenCode MCPServerConfig
        for (name, server) in team_file.mcp_servers {
            let opencode_config = convert_team_server_to_opencode(&server);
            team_servers.insert(name, opencode_config);
        }
    }

    if team_servers.is_empty() {
        return Ok(0);
    }

    let count = team_servers.len();

    // Read existing opencode.json config (in workspace) and merge team servers into it
    let mut config = mcp::read_config(workspace_path)?;
    let mut mcp_map = config.mcp.unwrap_or_default();

    // Merge team servers — add or update, never remove existing user servers
    for (name, server_config) in team_servers {
        mcp_map.insert(name, server_config);
    }

    config.mcp = Some(mcp_map);
    mcp::write_config(workspace_path, &config)?;

    Ok(count)
}

/// Scan .mcp/*.json from the workspace and merge into opencode.json (legacy: when team repo was at workspace root).
#[allow(dead_code)]
pub fn sync_team_mcp_configs(workspace_path: &str) -> Result<usize, String> {
    sync_team_mcp_configs_from_dir(workspace_path, workspace_path)
}

/// Convert a team MCP server config to OpenCode format
fn convert_team_server_to_opencode(server: &TeamMCPServer) -> MCPServerConfig {
    // Determine if this is a local or remote server
    if server.url.is_some() {
        // Remote server
        MCPServerConfig {
            server_type: "remote".to_string(),
            enabled: Some(true),
            command: None,
            environment: None,
            url: server.url.clone(),
            headers: server
                .headers
                .as_ref()
                .map(|h| h.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            timeout: None,
        }
    } else {
        // Local server: combine command + args into a single command array
        let mut cmd: Vec<String> = Vec::new();
        if let Some(ref command) = server.command {
            cmd.push(command.clone());
        }
        if let Some(ref args) = server.args {
            cmd.extend(args.clone());
        }

        MCPServerConfig {
            server_type: "local".to_string(),
            enabled: Some(true),
            command: if cmd.is_empty() { None } else { Some(cmd) },
            environment: server
                .env
                .as_ref()
                .map(|e| e.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            url: None,
            headers: None,
            timeout: None,
        }
    }
}

// ─── Tauri Commands: Team Status ─────────────────────────────────────────────

/// Unified team status check — single source of truth for frontend.
/// Accepts an optional `workspace_path` override so the frontend can pass
/// the correct path during workspace switches.
#[tauri::command]
pub fn get_team_status(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<TeamStatus, String> {
    let ws = resolve_workspace_path(workspace_path, &window, &registry)?;
    Ok(check_team_status(&ws))
}

/// Read `teamclaw-team/_meta/team.json` from the given workspace, if present.
/// Returns `None` when the directory or file doesn't exist or can't be parsed.
/// Used by the workspace picker to detect mismatched team state before continuing.
#[tauri::command]
pub fn workspace_read_team_meta(workspace_path: String) -> Result<Option<TeamMeta>, String> {
    let meta_path = Path::new(&workspace_path)
        .join(TEAM_REPO_DIR)
        .join("_meta")
        .join("team.json");
    if !meta_path.exists() {
        return Ok(None);
    }
    let content = match std::fs::read_to_string(&meta_path) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    match serde_json::from_str::<TeamMeta>(&content) {
        Ok(meta) => Ok(Some(meta)),
        Err(_) => Ok(None),
    }
}

/// Delete the `teamclaw-team/` directory inside `workspace_path`.
/// Used when the user confirms (twice) that a workspace's stored team
/// should be discarded after a mismatch with the currently-logged-in team.
/// No-op when the directory doesn't exist.
#[tauri::command]
pub fn workspace_delete_team_repo(workspace_path: String) -> Result<(), String> {
    crate::commands::team_share::disconnect::remove_workspace_team_repo_entry(&workspace_path)
}

/// Update LLM config for an existing team.
/// Called from the "服务配置" section in team settings.
#[tauri::command]
pub fn update_team_llm_config(
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<(), String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let llm_config = build_llm_config(llm_base_url, llm_model, llm_model_name, llm_models);
    write_llm_config(&workspace_path, llm_config.as_ref())?;
    Ok(())
}

// ─── Tauri Commands: Git Operations ─────────────────────────────────────────

/// 1.2 - Check if workspace already has a .git directory
#[tauri::command]
pub async fn team_check_workspace_has_git(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<WorkspaceGitCheckResult, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let git_dir = Path::new(&workspace_path).join(".git");
    Ok(WorkspaceGitCheckResult {
        has_git: git_dir.exists(),
    })
}

/// Inputs to the team-join clone & member-registration work.
struct TeamGitJoinArgs {
    git_url: String,
    git_token: Option<String>,
    git_branch: Option<String>,
    team_id: String,
    team_secret: String,
    member_name: String,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    fc_endpoint: Option<String>,
    workspace_path: String,
}

/// Shared body for both the synchronous (`team_git_join`) and background
/// (`team_git_join_background`) commands. Looks up `SharedSecretsState` from
/// the AppHandle so it can run inside a `tokio::spawn` future.
async fn team_git_join_impl(
    app: AppHandle,
    args: TeamGitJoinArgs,
) -> Result<TeamGitResult, String> {
    let TeamGitJoinArgs {
        git_url,
        git_token,
        git_branch,
        team_id,
        team_secret,
        member_name,
        llm_base_url,
        llm_model,
        llm_model_name,
        llm_models,
        fc_endpoint,
        workspace_path,
    } = args;
    let team_dir = get_team_repo_path(&workspace_path);

    // 1. Validate team_dir doesn't exist
    if Path::new(&team_dir).exists() {
        return Err(format!(
            "{} already exists. Remove it first or disconnect the team repo to re-initialize.",
            TEAM_REPO_DIR
        ));
    }

    // 2. Clone repo (same pattern as team_git_create)
    let remote_url = match &git_token {
        Some(token) if !token.is_empty() && is_https_url(&git_url) => {
            embed_token_in_url(&git_url, token)
        }
        _ => git_url.clone(),
    };

    let clone_args: Vec<&str> = if let Some(ref branch) = git_branch {
        if !branch.is_empty() {
            vec!["clone", "-b", branch.as_str(), &remote_url, TEAM_REPO_DIR]
        } else {
            vec!["clone", &remote_url, TEAM_REPO_DIR]
        }
    } else {
        vec!["clone", &remote_url, TEAM_REPO_DIR]
    };
    let (ok, _, stderr) = run_clone_with_partial_fallback(&clone_args, &workspace_path)?;
    if !ok {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "git clone failed (check URL and authentication): {}",
            stderr.trim()
        ));
    }

    // 3. Read _meta/team.json
    let team_path = Path::new(&team_dir);
    let team_meta_path = team_path.join("_meta").join("team.json");
    let team_meta: TeamMeta = match std::fs::read_to_string(&team_meta_path) {
        Ok(content) => serde_json::from_str(&content).map_err(|e| {
            let _ = std::fs::remove_dir_all(&team_dir);
            format!("Failed to parse _meta/team.json: {}", e)
        })?,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&team_dir);
            return Err(format!(
                "Failed to read _meta/team.json: {}. Is this a valid TeamClaw team repo?",
                e
            ));
        }
    };

    // 4. Verify team_id matches
    if team_meta.team_id != team_id {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!(
            "Team ID mismatch: expected '{}' but repo has '{}'",
            team_id, team_meta.team_id
        ));
    }

    // If the caller didn't pass an fc_endpoint (e.g. manual entry without an
    // invite code), fall back to the team's persisted value from
    // _meta/team.json so the FC `/ai/add-member` block below still fires.
    // Invite-code joins already had FC called by the frontend and intentionally
    // pass None to avoid duplicate registration — that path is unaffected.
    let fc_endpoint = fc_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| team_meta.fc_endpoint.clone());

    // 5. Verify team_secret via HMAC comparison
    let computed_verify = match compute_secret_verify(&team_secret) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&team_dir);
            return Err(e);
        }
    };
    if computed_verify != team_meta.secret_verify {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err("Team Secret is incorrect".to_string());
    }

    // 6. Read _meta/members.json
    let members_path = team_path.join("_meta").join("members.json");
    let mut manifest: crate::commands::team_unified::TeamManifest = {
        let content = match std::fs::read_to_string(&members_path) {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&team_dir);
                return Err(format!("Failed to read _meta/members.json: {}", e));
            }
        };
        match serde_json::from_str(&content) {
            Ok(m) => m,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&team_dir);
                return Err(format!("Failed to parse _meta/members.json: {}", e));
            }
        }
    };

    // 7. Dedup: update existing member or add new.
    // Member identity is the daemon's actor_id (persisted in ~/.amuxd/backend.toml
    // at onboarding). The members.json wire field stays `node_id`/`nodeId` (consumed
    // by FC) but now carries the actor_id value.
    let actor_id = crate::commands::daemon_http::read_daemon_actor_id();
    if actor_id.is_empty() {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(
            "Daemon actor_id unavailable (daemon not onboarded); cannot add team member"
                .to_string(),
        );
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(existing) = manifest.members.iter_mut().find(|m| m.node_id == actor_id) {
        existing.name = member_name.clone();
        existing.platform = std::env::consts::OS.to_string();
        existing.arch = std::env::consts::ARCH.to_string();
        existing.hostname = gethostname::gethostname().to_string_lossy().to_string();
    } else {
        use crate::commands::team_unified::{MemberRole, TeamMember};
        manifest.members.push(TeamMember {
            node_id: actor_id.clone(),
            name: member_name.clone(),
            role: MemberRole::Editor,
            shortcuts_role: Vec::new(),
            label: String::new(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: gethostname::gethostname().to_string_lossy().to_string(),
            added_at: now,
        });
    }

    // 8. Write updated members.json
    let members_json = serde_json::to_string_pretty(&manifest).map_err(|e| {
        let _ = std::fs::remove_dir_all(&team_dir);
        format!("Failed to serialize members.json: {}", e)
    })?;
    if let Err(e) = std::fs::write(&members_path, members_json) {
        let _ = std::fs::remove_dir_all(&team_dir);
        return Err(format!("Failed to write members.json: {}", e));
    }

    // 9. Set git user identity for this repo (so commits show the member's name)
    let _ = run_git(&["config", "user.name", &member_name], &team_dir);
    let _ = run_git(
        &[
            "config",
            "user.email",
            &format!(
                "{}@teamclaw.local",
                actor_id.chars().take(8).collect::<String>()
            ),
        ],
        &team_dir,
    );

    // 10. Git add, commit, push
    let (ok, _, stderr) = run_git(&["add", "-A"], &team_dir)?;
    if !ok {
        println!("[Team Join] git add warning: {}", stderr.trim());
    }
    let (ok, _, stderr) = run_git(&["commit", "-m", "chore: member joined team"], &team_dir)?;
    if !ok {
        println!("[Team Join] git commit warning: {}", stderr.trim());
    }
    let branch = git_branch
        .as_deref()
        .filter(|b| !b.is_empty())
        .unwrap_or("main");
    let (ok, _, stderr) = run_git(&["push", "origin", branch], &team_dir)?;
    if !ok {
        let (ok2, head_out, _) = run_git(&["rev-parse", "--abbrev-ref", "HEAD"], &team_dir)?;
        if ok2 {
            let head_branch = head_out.trim();
            if head_branch != branch {
                let (ok3, _, stderr3) = run_git(&["push", "origin", head_branch], &team_dir)?;
                if !ok3 {
                    println!("[Team Join] git push warning: {}", stderr3.trim());
                }
            } else {
                println!("[Team Join] git push warning: {}", stderr.trim());
            }
        }
    }

    // 10. Write LLM config
    let llm_config = build_llm_config(llm_base_url, llm_model, llm_model_name, llm_models);
    write_llm_config(&workspace_path, llm_config.as_ref())?;
    println!(
        "[Team Join] Wrote LLM config to {}/{}",
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME
    );

    // 11. Save team_secret to keychain
    crate::commands::team_secret_store::save_team_secret(&workspace_path, &team_id, &team_secret)?;
    println!("[Team Join] Saved team_secret to keychain");

    // 12. Init shared secrets
    {
        let secrets_state = app.state::<crate::commands::shared_secrets::SharedSecretsState>();
        crate::commands::shared_secrets::init_shared_secrets(
            secrets_state.inner(),
            &team_secret,
            team_path,
        )?;
    }
    println!("[Team Join] Initialized shared secrets");

    // 13. Sync MCP configs
    match sync_team_mcp_configs_from_dir(&team_dir, &workspace_path) {
        Ok(count) if count > 0 => {
            println!(
                "[Team Join] Synced {} MCP server(s) from .mcp/ to opencode.json",
                count
            );
        }
        Ok(_) => {}
        Err(e) => {
            println!("[Team Join] Warning: Failed to sync MCP configs: {}", e);
        }
    }

    // Fire-and-forget: register joining member's LiteLLM key via FC.
    // Only runs for managed-Git (frontend passes fc_endpoint when managedGit=true).
    if let Some(endpoint) = fc_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let url = format!("{}/ai/add-member", endpoint.trim_end_matches('/'));
        let body = serde_json::json!({
            "teamId": team_id,
            "teamSecret": team_secret,
            // FC `/ai/add-member` wire field stays `nodeId`; value is the actor_id.
            "nodeId": actor_id,
            "memberName": member_name,
        });
        println!("[Team Join] Scheduling LiteLLM add-member via FC: {}", url);
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new());
            match client.post(&url).json(&body).send().await {
                Ok(r) => println!(
                    "[Team Join] LiteLLM via FC: add-member HTTP status={}",
                    r.status()
                ),
                Err(e) => eprintln!("[Team Join] LiteLLM via FC: add-member request failed: {e}"),
            }
        });
    }

    // 14. Return success
    Ok(TeamGitResult {
        success: true,
        message: format!("Joined team '{}' successfully", team_meta.team_name),
        ..Default::default()
    })
}

/// Join an existing team repo synchronously: clone, verify HMAC secret,
/// add self as member. Used by the slow path (manual entry without invite code).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_git_join(
    app: AppHandle,
    git_url: String,
    git_token: Option<String>,
    git_branch: Option<String>,
    team_id: String,
    team_secret: String,
    member_name: String,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    fc_endpoint: Option<String>,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<TeamGitResult, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    team_git_join_impl(
        app,
        TeamGitJoinArgs {
            git_url,
            git_token,
            git_branch,
            team_id,
            team_secret,
            member_name,
            llm_base_url,
            llm_model,
            llm_model_name,
            llm_models,
            fc_endpoint,
            workspace_path,
        },
    )
    .await
}

/// Join an existing team repo in the background. Returns immediately after
/// scheduling the work; the caller (frontend) is expected to have already
/// verified the team secret + registered its LiteLLM key out-of-band (via FC
/// `/ai/add-member`) so the user can be told "joined" before clone finishes.
///
/// Emits `team:git-join-clone-completed` (with TeamGitResult) on success and
/// `team:git-join-clone-failed` (with `{ error: String }`) on failure. On
/// failure also pushes a tray notification with the error message.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_git_join_background(
    app: AppHandle,
    git_url: String,
    git_token: Option<String>,
    git_branch: Option<String>,
    team_id: String,
    team_secret: String,
    member_name: String,
    llm_base_url: Option<String>,
    llm_model: Option<String>,
    llm_model_name: Option<String>,
    llm_models: Option<String>,
    fc_endpoint: Option<String>,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<(), String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let app_for_spawn = app.clone();
    let args = TeamGitJoinArgs {
        git_url,
        git_token,
        git_branch,
        team_id: team_id.clone(),
        team_secret,
        member_name,
        llm_base_url,
        llm_model,
        llm_model_name,
        llm_models,
        fc_endpoint,
        workspace_path,
    };
    tokio::spawn(async move {
        match team_git_join_impl(app_for_spawn.clone(), args).await {
            Ok(result) => {
                println!("[Team Join Background] completed: {}", result.message);
                let _ = app_for_spawn.emit(
                    "team:git-join-clone-completed",
                    serde_json::json!({
                        "teamId": team_id,
                        "message": result.message,
                    }),
                );
            }
            Err(err) => {
                eprintln!("[Team Join Background] failed: {err}");
                let _ = app_for_spawn.emit(
                    "team:git-join-clone-failed",
                    serde_json::json!({
                        "teamId": team_id,
                        "error": err,
                    }),
                );
                use tauri_plugin_notification::NotificationExt;
                let _ = app_for_spawn
                    .notification()
                    .builder()
                    .title("Team sync failed")
                    .body(format!("Could not finish syncing team repo: {err}"))
                    .show();
            }
        }
    });
    Ok(())
}

/// 1.4 - Ensure .gitignore in team repo dir has all required rules.
/// Creates the file if missing, or appends missing rules if it already exists.
#[tauri::command]
pub async fn team_generate_gitignore(
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<TeamGitResult, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let team_dir = get_team_repo_path(&workspace_path);
    ensure_gitignore_rules(&team_dir);
    Ok(TeamGitResult {
        success: true,
        message: ".gitignore ensured".to_string(),
        ..Default::default()
    })
}

/// Initialize shared secrets for an already-configured Git team.
/// Called on app startup when team config has a team_id.
#[tauri::command]
pub async fn init_git_team_secrets(
    team_id: String,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
    secrets_state: State<'_, crate::commands::shared_secrets::SharedSecretsState>,
) -> Result<(), String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    let team_dir = get_team_repo_path(&workspace_path);
    let team_path = Path::new(&team_dir);

    if !team_path.join("_meta").join("team.json").exists() {
        return Ok(()); // No team metadata yet, skip
    }

    let team_secret =
        crate::commands::team_secret_store::load_team_secret(&workspace_path, &team_id)
            .map_err(|e| format!("Failed to load team secret: {e}"))?;

    crate::commands::shared_secrets::init_shared_secrets(&secrets_state, &team_secret, team_path)?;

    Ok(())
}

/// Load the team secret from keychain for display in settings.
#[tauri::command]
pub async fn get_git_team_secret(
    team_id: String,
    workspace_path: Option<String>,
    window: tauri::WebviewWindow,
    registry: State<'_, crate::commands::window::WindowRegistry>,
) -> Result<String, String> {
    let workspace_path = resolve_workspace_path(workspace_path, &window, &registry)?;
    crate::commands::team_secret_store::load_team_secret(&workspace_path, &team_id)
}

// NOTE: Startup team sync is triggered from the frontend after workspace is set,
// since workspace_path is not available at Tauri setup time.
// The frontend calls team_sync_repo on startup when team config is enabled.

#[cfg(test)]
mod sync_precheck_tests {
    use super::*;

    #[test]
    fn test_parse_untracked_paths_basic() {
        let input = b"?? new.txt\x00 M modified.txt\x00?? subdir/other.bin\x00";
        let paths = parse_untracked_paths(input);
        assert_eq!(
            paths,
            vec!["new.txt".to_string(), "subdir/other.bin".to_string()]
        );
    }

    #[test]
    fn test_parse_untracked_paths_ignores_staged_modified_deleted() {
        let input = b"A  staged.txt\x00MM both.txt\x00 D gone.txt\x00?? real.txt\x00";
        let paths = parse_untracked_paths(input);
        assert_eq!(paths, vec!["real.txt".to_string()]);
    }

    #[test]
    fn test_parse_untracked_paths_empty() {
        assert!(parse_untracked_paths(b"").is_empty());
    }

    #[test]
    fn test_parse_untracked_paths_handles_spaces_in_name() {
        let input = b"?? my new file.txt\x00";
        let paths = parse_untracked_paths(input);
        assert_eq!(paths, vec!["my new file.txt".to_string()]);
    }

    #[test]
    fn team_config_accepts_legacy_team_id_but_does_not_serialize_it() {
        let config: TeamConfig = serde_json::from_value(serde_json::json!({
            "gitUrl": "https://example.com/shared.git",
            "enabled": true,
            "lastSyncAt": null,
            "sharedDirName": "teamclaw",
            "envSecret": "secret",
            "gitToken": "token",
            "gitBranch": "main",
            "teamId": "legacy-team-id"
        }))
        .unwrap();

        let value = serde_json::to_value(config).unwrap();
        assert_eq!(value["gitUrl"], "https://example.com/shared.git");
        assert_eq!(value["gitBranch"], "main");
        assert_eq!(value["gitToken"], "token");
        assert!(value.get("teamId").is_none());
    }

    // Note: `resolve_workspace_path` integration test removed. Constructing a
    // `WebviewWindow` in a unit test is impractical, and the "explicit beats
    // fallback" logic is now a trivial early-return inside the function.
}
