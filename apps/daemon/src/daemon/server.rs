use rumqttc::{Event, Packet};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use teamclaw_transport::MessagePublisher;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::backend::{
    credential_in_proactive_refresh_window, proactive_reconnect_delay, AgentRuntimeUpsert, Backend,
    WorkspaceUpsert,
};
use crate::channels::{AmuxdAcpHandle, AmuxdChannelStore, ChannelManager};
use crate::collab::{AuthManager, AuthResult, PeerState, PeerTracker, PermissionManager};
use crate::config::{DaemonConfig, SessionStore, StoredSession, WorkspaceStore};
use crate::daemon::binding_target::parse_binding_to_target;
use crate::daemon::prompt_await::parse_prompt_await_payload;
use crate::daemon::runtime_cursor::{
    compute_effective_cursor_from_messages, last_unanswered_mention_idx,
    messages_strictly_after_cursor, slice_has_actionable_inbound,
};
use crate::daemon::runtime_resolution::{
    agent_type_from_name, resolve_requested_agent_type, runtime_start_initial_model_override,
    session_message_model_override, supported_agent_type_names,
};
use crate::daemon::session_events::{
    format_idea_prompt, message_attachment_urls, parse_mention_actor_ids, resolve_mention_actor_ids,
};
use crate::daemon::session_resume::resolve_backend_session_id;

#[path = "collab_runtime_ensure.rs"]
mod collab_runtime_ensure;
#[path = "runtime_env.rs"]
mod runtime_env;
use crate::history::EventHistory;
use crate::mqtt::{publisher::Publisher, subscriber, MqttClient};
use crate::proto::amux;
use crate::provider_config::ProviderConfig;
use crate::runtime::{apply_workspace_system_instructions, AgentLaunchConfig, RuntimeManager};
use crate::team_shared_git::TeamSharedGitConfig;
use teamclaw_gateway::{AcpHandle, ChannelStore};

/// Outcome of apply_start_runtime. Success path returns the allocated
/// runtime_id + the session_id (echoed from request or freshly created).
/// Failure path returns a (error_code, error_message, failed_stage) tuple
/// — the caller formats this into whatever wire envelope it emits
/// (legacy AgentStartResult or new RuntimeStartResult).
struct StartRuntimeOutcome {
    runtime_id: String,
    session_id: String,
}

struct StartRuntimeError {
    #[allow(dead_code)]
    error_code: String,
    error_message: String,
    failed_stage: String,
}

fn load_team_runtime_env(workspace_root: &Path, team_id: Option<&str>) -> HashMap<String, String> {
    crate::team_shared_env::load_team_env_for_workspace(workspace_root, team_id)
}

fn sync_team_shared_dir_for_workspace(workspace_root: &Path, config: &TeamSharedGitConfig) {
    match crate::team_shared_git::setup_or_sync_shared_dir(workspace_root, config) {
        Ok(status) => {
            if status.synced {
                info!(
                    shared_dir = %status.shared_dir_path.display(),
                    "team shared directory synced"
                );
            }
        }
        Err(e) => {
            warn!(
                workspace = %workspace_root.display(),
                shared_dir_name = %config.shared_dir_name,
                error = %e,
                "team shared directory sync failed"
            );
        }
    }
}

fn load_team_shared_config_for_workspace(workspace_root: &Path) -> Option<TeamSharedGitConfig> {
    crate::team_shared_git::read_git_team_config(workspace_root)
}

pub(crate) use crate::config::workspace_path::is_linkable_workspace_path;

/// Group registered workspaces by their `team_id`. Workspaces without a
/// team_id, or with a non-linkable path (root / inside `~/.amuxd`), are
/// skipped. Returns `(team_id, Vec<workspace_path>)` pairs so the sweep syncs
/// each team's global dir once, then links every member workspace.
pub(crate) fn group_workspaces_by_team(
    workspaces: &[crate::config::StoredWorkspace],
) -> Vec<(String, Vec<String>)> {
    use std::collections::BTreeMap;
    let mut by_team: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for w in workspaces {
        if w.path.trim().is_empty() || !is_linkable_workspace_path(w.path.trim()) {
            continue;
        }
        if let Some(team_id) = w.team_id.as_deref().filter(|t| !t.trim().is_empty()) {
            by_team
                .entry(team_id.to_string())
                .or_default()
                .push(w.path.clone());
        }
    }
    by_team.into_iter().collect()
}

/// Idempotently materialize a team's global shared dir and a workspace's
/// `teamclaw-team` symlink. See [`crate::team_link::ensure_team_link`].
pub(crate) use crate::team_link::ensure_team_link;

/// Pure policy for which team_id (if any) to stamp on a freshly-added
/// workspace: an existing team_id always wins; otherwise inherit the daemon's
/// team. An empty/whitespace daemon team yields none.
pub(crate) fn team_id_to_stamp(
    existing: Option<&str>,
    daemon_team: Option<&str>,
) -> Option<String> {
    if existing.is_some() {
        return None;
    }
    daemon_team
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
}

/// Per-session plan emitted by
/// [`DaemonServer::plan_auto_restart_offline_sessions`]. Sessions that pass
/// every filter (have a prior runtime, have unread from someone other than
/// this daemon, no live runtime currently serving them) end up in the
/// returned `Vec`.
pub(crate) struct OfflineRestartPlan {
    pub session_id: String,
    pub backend: amux::AgentType,
    pub local_workspace_id: String,
    pub unread_count: usize,
}

pub struct DaemonServer {
    config: DaemonConfig,
    /// Path the daemon's `daemon.toml` was loaded from. Stashed so
    /// `channel-reload` (over `amuxd.sock`) can re-read the latest config
    /// without callers having to thread the path through every helper.
    config_path: PathBuf,
    mqtt: MqttClient,
    /// Set when running on the NATS transport (`config.transport.kind = "nats"`).
    /// Mutually exclusive with the MQTT event loop in `mqtt`. On the MQTT path
    /// this stays `None` and `mqtt` is the live backend.
    nats: Option<crate::nats::NatsBackend>,
    /// Unified publisher handle. Set to `mqtt.client` on the MQTT path and
    /// to `nats.client` on the NATS path during connect. All publishing
    /// downstream (Publisher::new_from_handle, teamclaw, channels) reads
    /// this so the same handler code works for both backends.
    publisher_handle: Arc<dyn MessagePublisher>,
    /// Mirror of the active backend's `Topics`. Updated alongside
    /// `publisher_handle` during connect/reconnect.
    topics: crate::mqtt::Topics,
    agents: Arc<AsyncMutex<RuntimeManager>>,
    auth: AuthManager,
    peers: PeerTracker,
    permissions: PermissionManager,
    workspaces: WorkspaceStore,
    workspaces_path: PathBuf,
    /// Daemon-owned per-team sync engine (git/OSS). The 300s autonomous timer
    /// and the HTTP `/v1/team/sync` trigger both run through this dispatcher.
    sync_dispatcher: crate::sync::dispatch::SyncDispatcher,
    sessions: SessionStore,
    sessions_path: PathBuf,
    history: EventHistory,
    teamclaw: Option<crate::teamclaw::SessionManager>,
    backend: Arc<dyn Backend>,
    actor_id: String,
    /// Channel manager (Discord/WeCom/Feishu/Kook/WeChat/Email gateways).
    /// `None` until `start_channels()` runs; held as `Option` so `shutdown(self)`
    /// can be `.take()`n on graceful exit.
    channel_mgr: Option<ChannelManager>,
    /// Maps cron's logical `session_key` (e.g. `"cron/<job_id>/<run_id>"`) to
    /// the acp_session_id of a live agent spawned for that key. With the
    /// current "per-run new session" cron semantics, every prompt-await call
    /// hits the "absent → create" branch, but the lookup-first shape stays
    /// so future code can adopt session reuse without changing the handler.
    cron_sessions: std::collections::HashMap<String, String>,
    refresh_watch_registry:
        Option<std::sync::Arc<crate::runtime::refresh::refresh_watch::RefreshWatchRegistry>>,
    refresh_coordinator: Option<Arc<crate::runtime::refresh::RuntimeRefreshCoordinator>>,
}

/// Single control command parsed off `amuxd.sock`. Variants correspond to the
/// `cmd` strings written by `cli::process::send_control`.
#[derive(Debug)]
enum SockCommand {
    /// Tear down the running channel manager and rebuild from the latest
    /// `daemon.toml`. One-way (no reply).
    ChannelReload,
    /// Reply with a JSON `[{platform, enabled, connected, last_error}, ...]`
    /// snapshot of the six supported channels. `reply_tx` carries the JSON
    /// body back to the listener task so it can write it to the sock client.
    ChannelStatus {
        reply_tx: oneshot::Sender<String>,
    },
    /// Replace `daemon_config.channels.<platform>` with the JSON in `config_json`,
    /// persist to `daemon.toml`, and reload the channel manager so the change
    /// takes effect. One-way (no reply).
    ChannelSave {
        platform: String,
        config_json: String,
    },
    /// Proactive send request from the `amuxd mcp-server` bridge running
    /// as a child of an ACP agent. `payload` is the raw JSON envelope the
    /// bridge wrote to the sock; the daemon parses out binding + channel
    /// + target overrides + content. `reply_tx` receives a single line of
    ///   JSON (`{ "ok": true, "result": ... }` or
    ///   `{ "ok": false, "error": ... }`) the listener writes back.
    McpSend {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Drive one ACP turn to completion for a cron-style logical session.
    /// `payload` is the raw JSON envelope; `handle_prompt_await` parses it
    /// and runs the turn against the local primary agent. `reply_tx`
    /// receives a single line of JSON (`{ "ok": true, "result": { "text": ..., "acp_session_id": ... }}` or
    /// `{ "ok": false, "error": ... }`).
    PromptAwait {
        payload: serde_json::Value,
        reply_tx: oneshot::Sender<String>,
    },
    /// Fetch a fresh WeChat (iLink) bot QR code. One-shot HTTP call to the
    /// ilink backend via `teamclaw_gateway::wechat::fetch_qr_code`. Reply is
    /// `{ok, result?, error?}` where result is the raw `WeChatQrLoginResponse`.
    WechatQrStart {
        reply_tx: oneshot::Sender<String>,
    },
    /// Poll the status of a previously-started WeChat QR code.
    /// Reply shape: `{ok, result?, error?}` with `WeChatQrStatusResponse`.
    WechatQrPoll {
        qrcode: String,
        reply_tx: oneshot::Sender<String>,
    },
    /// Generate a WeCom QR auth start payload (scode + auth_url).
    /// Reply shape: `{ok, result?, error?}` with `WeComQrAuthStart`.
    WecomQrStart {
        reply_tx: oneshot::Sender<String>,
    },
    /// Poll the status of a WeCom QR auth scode.
    /// Reply shape: `{ok, result?, error?}` with `WeComQrAuthPollResult`.
    WecomQrPoll {
        scode: String,
        reply_tx: oneshot::Sender<String>,
    },
    /// Register a workspace into the local registry + cloud, idempotently.
    /// Fed by the HTTP control plane (`POST /v1/workspaces`) via the
    /// register-workspace bridge — the actor owns the `WorkspaceStore`, so the
    /// HTTP task cannot mutate it without racing. Reply is a single JSON line
    /// (`{ok, result?, error?}`) with `{workspace_id, path, display_name}`.
    AddWorkspace {
        path: String,
        reply_tx: oneshot::Sender<String>,
    },
    Unknown(String),
}

fn load_provider_config_from_default_paths() -> crate::error::Result<ProviderConfig> {
    let backend_path = ProviderConfig::default_path()
        .map_err(|e| crate::error::AmuxError::Config(format!("backend config path failed: {e}")))?;

    ProviderConfig::load_from_path(&backend_path)
        .map_err(|e| crate::error::AmuxError::Config(format!("backend config init failed: {e}")))
}

fn backend_from_provider_config(config: ProviderConfig) -> crate::error::Result<Arc<dyn Backend>> {
    match config {
        ProviderConfig::CloudApi(config) => {
            // Rotated refresh tokens are written back to the same backend.toml
            // we loaded from, so the daemon survives restarts.
            let persist_path = ProviderConfig::default_path().map_err(|e| {
                crate::error::AmuxError::Config(format!("backend config path failed: {e}"))
            })?;
            Ok(Arc::new(
                crate::backend::cloud_api::CloudApiBackend::with_persist_path(config, persist_path),
            ))
        }
    }
}

/// Resolve the MQTT broker from `/v1/config/bootstrap`. The Cloud API is the
/// authoritative source: a fetched value wins (so operators can rotate the
/// broker without redeploying daemons), and falls back only to an explicit
/// invite `?broker=` override already present in `config`. If neither yields a
/// broker URL, startup fails — there is no hardcoded default.
async fn apply_bootstrap_overrides(
    backend: &Arc<dyn Backend>,
    config: &mut DaemonConfig,
) -> crate::error::Result<()> {
    match backend.fetch_bootstrap_mqtt().await {
        Ok(Some(mqtt)) => {
            let previous = config.mqtt.broker_url.clone();
            config.mqtt.broker_url = mqtt.url;
            if mqtt.username.is_some() {
                config.mqtt.username = mqtt.username;
            }
            if mqtt.password.is_some() {
                config.mqtt.password = mqtt.password;
            }
            info!(
                previous_broker = %previous,
                broker = %config.mqtt.broker_url,
                "applied bootstrap mqtt override from cloud api"
            );
        }
        Ok(None) => {
            // Keep the invite `?broker=` override if one was supplied at init.
        }
        Err(e) => {
            // Keep the invite override (if any); the empty-check below decides.
            tracing::warn!(error = %e, "bootstrap mqtt fetch failed; relying on invite broker override if present");
        }
    }

    if config.mqtt.broker_url.trim().is_empty() {
        return Err(crate::error::AmuxError::Config(
            "Cloud API did not provision an MQTT broker (/v1/config/bootstrap returned no mqtt) \
             and no invite `?broker=` override was supplied; cannot start"
                .to_string(),
        ));
    }
    Ok(())
}

impl DaemonServer {
    pub async fn new(
        mut config: DaemonConfig,
        config_path: &std::path::Path,
    ) -> crate::error::Result<Self> {
        let provider_config = load_provider_config_from_default_paths()?;
        let provider_kind = provider_config.kind();
        let backend = backend_from_provider_config(provider_config)?;

        info!(
            backend_kind = ?provider_kind,
            actor_id = %backend.actor_id(),
            team_id  = %backend.team_id(),
            "backend client initialised"
        );

        let actor_id = backend.actor_id().to_string();

        // Fetch first token — fails fast if CloudApi is unreachable at startup.
        // Idea 5's outer loop handles retries on every subsequent reconnect.
        let token = backend.auth_token().await.map_err(|e| {
            crate::error::AmuxError::Config(format!("initial token fetch failed: {e}"))
        })?;

        // Authoritative: resolve the MQTT broker from /v1/config/bootstrap.
        // There is no hardcoded fallback — if the Cloud API delivers no broker
        // and the invite carried no `?broker=` override, this fails fast with a
        // clear error rather than connecting to a stale/empty broker.
        apply_bootstrap_overrides(&backend, &mut config).await?;

        let mqtt = MqttClient::new(&config, &actor_id, &token)?;

        let mut launch_configs = RuntimeManager::default_launch_configs();
        if let Some(claude) = config.agents.claude_code.as_ref() {
            launch_configs.insert(
                amux::AgentType::ClaudeCode,
                AgentLaunchConfig::new(
                    claude.binary.clone(),
                    claude.default_flags.clone(),
                    "claude",
                ),
            );
        }
        if let Some(opencode) = config.agents.opencode.as_ref() {
            launch_configs.insert(
                amux::AgentType::Opencode,
                AgentLaunchConfig::new(
                    opencode.binary.clone(),
                    opencode.default_flags.clone(),
                    "opencode",
                ),
            );
        }
        if let Some(codex) = config.agents.codex.as_ref() {
            launch_configs.insert(
                amux::AgentType::Codex,
                AgentLaunchConfig::new(codex.binary.clone(), codex.default_flags.clone(), "codex"),
            );
        }

        let members_path = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("members.toml");
        let auth = AuthManager::new(members_path)?;
        let peers = PeerTracker::new();
        let permissions = PermissionManager::new();

        let workspaces_path = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("workspaces.toml");
        let workspaces = WorkspaceStore::load(&workspaces_path)?;

        let sessions_path = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("sessions.toml");
        let sessions = SessionStore::load(&sessions_path)?;

        let history_dir = config_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("history");
        let history = EventHistory::new(&history_dir);

        let agents = Arc::new(AsyncMutex::new(RuntimeManager::new(
            launch_configs,
            Some(backend.clone()),
        )));

        let publisher_handle: Arc<dyn MessagePublisher> = Arc::new(mqtt.client.clone());
        let topics = mqtt.topics.clone();

        let teamclaw = if let Some(team_id) = &config.team_id {
            Some(crate::teamclaw::SessionManager::new(
                publisher_handle.clone(),
                team_id,
                &config.actor.id,
                Some(actor_id.clone()),
                crate::config::DaemonConfig::config_dir(),
            )?)
        } else {
            None
        };

        Ok(Self {
            config,
            config_path: config_path.to_path_buf(),
            mqtt,
            nats: None,
            publisher_handle,
            topics,
            agents,
            auth,
            peers,
            permissions,
            workspaces,
            workspaces_path,
            sync_dispatcher: crate::sync::dispatch::SyncDispatcher::new(
                crate::sync::secret_store::SecretStore::new(),
                Some(backend.clone()),
            ),
            sessions,
            sessions_path,
            history,
            teamclaw,
            backend,
            actor_id,
            channel_mgr: None,
            cron_sessions: std::collections::HashMap::new(),
            refresh_watch_registry: None,
            refresh_coordinator: None,
        })
    }

    fn suppress_internal_opencode_writes(&self, worktree: &str) {
        if let Some(ref refresh) = self.refresh_coordinator {
            crate::runtime::refresh::refresh_watch::suppress_for_workspace_path(
                refresh,
                Path::new(worktree),
                &crate::runtime::refresh::INTERNAL_OPENCODE_KINDS,
                crate::runtime::refresh::INTERNAL_WRITE_SUPPRESS,
            );
        }
    }

    /// Build a `ChannelManager` from the given config and call
    /// `start_enabled()`. Returns `None` when the daemon has no `team_id`
    /// yet (not onboarded) — caller logs and skips. Per-channel start
    /// failures are logged inside `start_enabled` and do NOT abort the
    /// whole boot.
    async fn build_and_start_channel_manager(&self, cfg: DaemonConfig) -> Option<ChannelManager> {
        let Some(team_id) = cfg.team_id.clone() else {
            info!("channels: daemon has no team_id (run `amuxd init`); skipping channel start");
            return None;
        };

        // The daemon's own actor_id (persisted in backend.toml during `init`)
        // is the agent participant the gateway-port channels speak as. Admin
        // owners are looked up from agent_member_access so they appear in
        // session_participants and can see gateway-originated DMs via RLS.
        let primary_agent_actor_id = self.actor_id.clone();
        let agent_owner_actor_ids: Vec<String> = match self
            .backend
            .list_agent_admin_member_actor_ids(&primary_agent_actor_id)
            .await
        {
            Ok(ids) => {
                tracing::info!(
                    "channel manager: {} admin owner(s) found for agent {}",
                    ids.len(),
                    primary_agent_actor_id
                );
                ids
            }
            Err(e) => {
                tracing::error!(
                    "channel manager: failed to resolve agent owners: {:?}; continuing with empty owner list",
                    e
                );
                Vec::new()
            }
        };

        // Resolve the daemon agent's own configured defaults so gateway
        // (WeCom/etc.) sessions spawn on its default agent type + default
        // workspace instead of the daemon-wide fallback type and a /tmp scratch
        // dir. Best-effort: a fetch failure or unset defaults degrades to the
        // prior behavior rather than blocking channel startup.
        let (default_agent_type, default_workspace_dir) = match self
            .backend
            .get_agent_defaults(&primary_agent_actor_id)
            .await
        {
            Ok(defaults) => {
                let agent_type = defaults
                    .default_agent_type
                    .as_deref()
                    .and_then(agent_type_from_name);
                let workspace_dir = defaults.default_workspace_id.as_deref().and_then(|id| {
                    let path = self.workspaces.find_by_id(id).map(|w| w.path.clone());
                    if path.is_none() {
                        warn!(
                            workspace_id = %id,
                            "channel manager: agent default workspace not synced locally; \
                             gateway sessions fall back to a scratch dir"
                        );
                    }
                    path
                });
                info!(
                    ?agent_type,
                    workspace_dir = ?workspace_dir,
                    "channel manager: resolved gateway agent defaults"
                );
                (agent_type, workspace_dir)
            }
            Err(e) => {
                warn!(
                    "channel manager: failed to fetch agent defaults: {e:?}; \
                     gateway sessions use daemon-wide defaults"
                );
                (None, None)
            }
        };

        let acp_handle: Arc<dyn AcpHandle> = Arc::new(AmuxdAcpHandle {
            manager: self.agents.clone(),
            logical_to_acp: Arc::new(AsyncMutex::new(HashMap::new())),
            team_id: team_id.clone(),
            model_override: Arc::new(AsyncMutex::new(HashMap::new())),
            backend: self.backend.clone(),
            default_agent_type,
            default_workspace_dir,
            agent_type_override: Arc::new(AsyncMutex::new(HashMap::new())),
            workspaces_path: self.workspaces_path.clone(),
            workspace_override: Arc::new(AsyncMutex::new(HashMap::new())),
            // Per-bot runtime registry — populated by a later wiring task that
            // reads `WeComChannel::resolved_bots()`; empty here so all bots
            // fall back to the daemon-wide defaults.
            bot_configs: Arc::new(HashMap::new()),
        });
        let store: Arc<dyn ChannelStore> = Arc::new(AmuxdChannelStore {
            client: self.backend.clone(),
        });

        let mgr = ChannelManager::new(
            cfg,
            acp_handle,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
        );
        match mgr.start_enabled().await {
            Ok(()) => info!("channel manager: start_enabled() completed"),
            Err(e) => warn!("channel manager: start_enabled() failed: {e:?}"),
        }
        Some(mgr)
    }

    /// Construct the channel manager from `[channels.*]` entries in
    /// `daemon.toml` and call `start_enabled()` so every gateway whose
    /// section has `enabled = true` boots alongside the daemon. Best-effort:
    /// missing team_id (daemon not yet onboarded) or per-channel start
    /// failures are logged but do NOT abort daemon startup.
    async fn start_channels(&mut self) {
        let cfg = self.config.clone();
        self.channel_mgr = self.build_and_start_channel_manager(cfg).await;
    }

    /// Re-read `daemon.toml` from disk, tear down the running channel
    /// manager (if any), and bring up a fresh one. Used by the
    /// `channel-reload` control command. Failures are logged but never
    /// crash the daemon — partial reloads (e.g. config parsed but one
    /// channel fails to start) are acceptable.
    async fn reload_channels(&mut self) {
        let fresh_cfg = match DaemonConfig::load(&self.config_path) {
            Ok(c) => c,
            Err(e) => {
                error!("channel-reload: failed to read config: {e:?}");
                return;
            }
        };

        if let Some(mgr) = self.channel_mgr.take() {
            info!("channel-reload: shutting down current channel manager");
            mgr.shutdown().await;
        }

        // Update the in-memory copy so subsequent paths that read
        // `self.config` see the new values.
        self.config = fresh_cfg.clone();
        self.channel_mgr = self.build_and_start_channel_manager(fresh_cfg).await;
        info!("channel-reload: ok");
    }

    /// Build the JSON response payload for the `channel-status` sock command.
    /// Walks the six known channel platforms and reports each one's
    /// `enabled` (from `daemon.toml`) and `connected` (running gateway slot
    /// is `Some(_)`). `last_error` is always `None` for now — richer per-
    /// channel error tracking is intentionally out of scope here.
    async fn channel_status_payload(&self) -> String {
        #[derive(serde::Serialize)]
        struct ChannelStatus {
            platform: &'static str,
            enabled: bool,
            connected: bool,
            last_error: Option<String>,
        }

        let cfg = &self.config.channels;
        let enabled_flag = |platform: &str| -> bool {
            match platform {
                "discord" => cfg.discord.as_ref().map(|c| c.enabled).unwrap_or(false),
                "wecom" => cfg.wecom.as_ref().map(|c| c.enabled).unwrap_or(false),
                "feishu" => cfg.feishu.as_ref().map(|c| c.enabled).unwrap_or(false),
                "kook" => cfg.kook.as_ref().map(|c| c.enabled).unwrap_or(false),
                "wechat" => cfg.wechat.as_ref().map(|c| c.enabled).unwrap_or(false),
                "email" => cfg.email.as_ref().map(|c| c.enabled).unwrap_or(false),
                _ => false,
            }
        };

        let connected: Vec<(&'static str, bool, Option<String>)> = match self.channel_mgr.as_ref() {
            Some(mgr) => mgr.status_snapshot().await,
            None => vec![
                ("discord", false, None),
                ("wecom", false, None),
                ("feishu", false, None),
                ("kook", false, None),
                ("wechat", false, None),
                ("email", false, None),
            ],
        };

        let statuses: Vec<ChannelStatus> = connected
            .into_iter()
            .map(|(platform, connected, last_error)| ChannelStatus {
                platform,
                enabled: enabled_flag(platform),
                connected,
                last_error,
            })
            .collect();

        serde_json::to_string(&statuses).unwrap_or_else(|_| "[]".to_string())
    }

    /// Handle a `mcp-send` JSON envelope from the `amuxd mcp-server` bridge.
    /// Parses the binding URI (e.g. `wecom://{corp}/{agent}/{kind}/{id}`) to
    /// derive the default channel + target, applies any explicit overrides,
    /// then routes the send through `ChannelManager::dispatch_send`. Returns
    /// a JSON-friendly success/error value (the listener serializes it).
    async fn handle_mcp_send(
        &self,
        payload: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let binding = payload
            .get("binding")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("mcp-send: missing 'binding'"))?;
        let message = payload.get("message").and_then(|v| v.as_str());
        let file_path = payload.get("file_path").and_then(|v| v.as_str());
        let target_override = payload.get("target_override").and_then(|v| v.as_str());
        let channel_override = payload.get("channel_override").and_then(|v| v.as_str());

        if message.map(|s| s.is_empty()).unwrap_or(true) && file_path.is_none() {
            anyhow::bail!("mcp-send: at least one of 'message' or 'file_path' is required");
        }

        let (default_channel, default_target) = parse_binding_to_target(binding)?;
        let channel = channel_override.unwrap_or(default_channel);
        let target_owned: String;
        let target = match target_override {
            Some(t) => t,
            None => match default_target {
                Some(t) => {
                    target_owned = t;
                    target_owned.as_str()
                }
                None => anyhow::bail!(
                    "mcp-send: binding '{binding}' has no default target — pass an explicit 'target' override"
                ),
            },
        };

        let mgr = self
            .channel_mgr
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("channel manager not running"))?;
        mgr.dispatch_send(channel, target, message, file_path)
            .await?;

        Ok(serde_json::json!({
            "channel": channel,
            "target": target,
            "message_sent": message.map(|s| !s.is_empty()).unwrap_or(false),
            "file_sent": file_path.is_some(),
        }))
    }

    /// Drive one ACP turn to completion for a cron-style session_key.
    ///
    /// On first hit for a session_key the daemon creates a real cloud
    /// `sessions` row (so AgentReply messages land somewhere the desktop UI's
    /// "view session" button can resolve), adds the daemon's primary agent +
    /// admin members as `session_participants`, then spawns the ACP runtime
    /// bound to that cloud session id. `cron_sessions` caches a
    /// `(remote_session_id, acp_session_id)` pair so subsequent turns reuse
    /// the same chat thread AND reach the same agent process.
    ///
    /// Returns `{text, session_id}` where `session_id` is the cloud session UUID —
    /// the client (cron scheduler) stores it in `CronRunRecord.session_id` so
    /// the desktop UI's "view session" button resolves to a real chat session.
    async fn handle_prompt_await(
        &mut self,
        payload: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let parsed = parse_prompt_await_payload(payload)?;

        let working_directory = match parsed.working_directory.filter(|s| !s.is_empty()) {
            Some(dir) => dir.to_string(),
            None => self
                .workspaces
                .default_workspace_path()
                .map(str::to_string)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "no working directory: configure a default workspace in Daemon > Workspace settings"
                    )
                })?,
        };

        // The daemon must have been onboarded (team_id present) before any
        // cron prompt can be honored — the gateway-session model expects a
        // team. Surface a clean error rather than panicking inside the
        // RuntimeManager call.
        let team_id = self
            .config
            .team_id
            .clone()
            .ok_or_else(|| anyhow::anyhow!("daemon has no team_id; run `amuxd init` first"))?;

        // Look up or create the per-session_key binding. We cache the
        // (remote_session_id, acp_session_id) pair encoded as a single map
        // value `"<sb>|<acp>"` so the existing HashMap<String, String> shape
        // is preserved — sb is what we return to the client and stamp into
        // cron records; acp is what RuntimeManager needs to drive the turn.
        let (remote_session_id, acp_sid): (String, String) =
            if let Some(existing) = self.cron_sessions.get(parsed.session_key) {
                let (sb, acp) = existing.split_once('|').ok_or_else(|| {
                    anyhow::anyhow!("cron_sessions entry malformed for {}", parsed.session_key)
                })?;
                (sb.to_string(), acp.to_string())
            } else {
                // Confirm we have a local primary agent runtime.
                let runtime_count = self.agents.lock().await.agent_count();
                if runtime_count == 0 {
                    anyhow::bail!("no local agent runtime");
                }

                let primary_agent_actor_id = self.actor_id.clone();
                let title = match parsed.job_name {
                    Some(n) if !n.is_empty() => {
                        format!("Cron: {}", n.chars().take(60).collect::<String>())
                    }
                    _ => "Cron job".to_string(),
                };

                let sb_sid = self
                    .backend
                    .create_cron_session(&team_id, &primary_agent_actor_id, &title)
                    .await
                    .map_err(|e| anyhow::anyhow!("create_cron_session: {e}"))?;

                // Resolve the job's pinned backend (if any) against the
                // daemon's configured agents. `None` (no agent_type on the
                // wire) keeps the "auto" behavior: RuntimeManager falls back to
                // default_agent_type. An explicit-but-unconfigured backend is
                // rerouted by resolve_requested_agent_type rather than failing.
                let agent_type_override = parsed
                    .agent_type
                    .and_then(agent_type_from_name)
                    .map(|requested| resolve_requested_agent_type(&self.config, requested));

                let mut mgr = self.agents.lock().await;
                let acp_sid = mgr
                    .create_gateway_session_with_model(
                        &team_id,
                        parsed.session_key,                        // logical id
                        &format!("cron://{}", parsed.session_key), // binding
                        "cron",                                    // title (display only)
                        parsed.model_override.clone(),
                        Some(&sb_sid), // bind AgentReply to the cloud session
                        Some(working_directory.as_str()),
                        agent_type_override,
                    )
                    .await
                    .map_err(|e| anyhow::anyhow!("spawn failed: {e}"))?;
                drop(mgr);

                tracing::debug!(
                    session_key = %parsed.session_key,
                    remote_session_id = %sb_sid,
                    acp_session_id = %acp_sid,
                    "cron: created cloud session + spawned ACP runtime"
                );

                self.cron_sessions.insert(
                    parsed.session_key.to_string(),
                    format!("{sb_sid}|{acp_sid}"),
                );
                (sb_sid, acp_sid)
            };

        // Drive the turn through the ACP runtime.
        let turn_result = {
            let mut mgr = self.agents.lock().await;
            mgr.send_prompt_and_await_reply(
                &acp_sid,
                parsed.message,
                Duration::from_secs(parsed.timeout_secs),
            )
            .await
        };

        // Always return the cloud session_id so the desktop can stamp it into
        // the run record even when the turn itself fails (ACP timeout, etc.).
        // On success: { "text": "...", "session_id": "..." }
        // On failure: { "session_id": "...", "agent_error": "..." }
        // The caller wraps this in  { "ok": true/false, "result": ... }
        // — the desktop amuxd_client reads "session_id" and optional "agent_error".
        match turn_result {
            Ok(reply) => {
                // `send_prompt_and_await_reply` drains the ACP channel directly,
                // bypassing `forward_agent_event`, so we must persist the finalized
                // AgentReply here — same path as collab chat (TOML + live + cloud).
                if !reply.content.is_empty() {
                    if let Some(tc) = self.teamclaw.as_ref() {
                        let actor_id = self.actor_id.clone();
                        let (model, seq) = {
                            let mut mgr = self.agents.lock().await;
                            let agent_id =
                                mgr.agent_id_by_acp_session(&acp_sid).unwrap_or_default();
                            let model = mgr.current_model(&agent_id).cloned().unwrap_or_default();
                            let seq = mgr
                                .get_handle_mut(&agent_id)
                                .map(|h| h.next_sequence())
                                .unwrap_or(0);
                            (model, seq)
                        };
                        tc.emit_agent_message(
                            &remote_session_id,
                            &actor_id,
                            crate::proto::teamclaw::MessageKind::AgentReply,
                            &reply.content,
                            &reply.metadata_json,
                            &model,
                            &reply.turn_id,
                            seq,
                            true,
                            Some(&self.backend),
                        )
                        .await;
                        info!(
                            session_id = %remote_session_id,
                            turn_id = %reply.turn_id,
                            bytes = reply.content.len(),
                            "cron: persisted AgentReply to session/live and cloud"
                        );
                    } else {
                        warn!(
                            session_id = %remote_session_id,
                            "cron: teamclaw SessionManager unavailable; AgentReply not persisted"
                        );
                    }
                }
                Ok(serde_json::json!({
                    "text": reply.content,
                    "session_id": remote_session_id,
                }))
            }
            Err(e) => Ok(serde_json::json!({
                "session_id": remote_session_id,
                "agent_error": e.to_string(),
            })),
        }
    }

    /// Persist a new per-platform channel config (parsed from the second line
    /// of a `channel-save` sock message) into `daemon.toml`, update the
    /// in-memory `self.config`, and reload the channel manager so the change
    /// takes effect immediately. Errors are logged but never crash the daemon.
    async fn save_channel_config(&mut self, platform: &str, config_json: &str) {
        let parsed: Result<(), String> = (|| -> Result<(), String> {
            match platform {
                "discord" => {
                    let v: crate::config::DiscordChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse discord: {e}"))?;
                    self.config.channels.discord = Some(v);
                }
                "wecom" => {
                    let v: crate::config::WeComChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse wecom: {e}"))?;
                    self.config.channels.wecom = Some(v);
                }
                "feishu" => {
                    let v: crate::config::FeishuChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse feishu: {e}"))?;
                    self.config.channels.feishu = Some(v);
                }
                "kook" => {
                    let v: crate::config::KookChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse kook: {e}"))?;
                    self.config.channels.kook = Some(v);
                }
                "wechat" => {
                    let v: crate::config::WeChatChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse wechat: {e}"))?;
                    self.config.channels.wechat = Some(v);
                }
                "email" => {
                    let v: crate::config::EmailChannel = serde_json::from_str(config_json)
                        .map_err(|e| format!("parse email: {e}"))?;
                    self.config.channels.email = Some(v);
                }
                other => {
                    return Err(format!("unknown platform '{other}'"));
                }
            }
            Ok(())
        })();

        if let Err(e) = parsed {
            error!("channel-save: {e}");
            return;
        }

        if let Err(e) = self.config.save(&self.config_path) {
            error!("channel-save: failed to persist daemon.toml: {e:?}");
            return;
        }

        info!("channel-save: persisted {platform}, reloading channel manager");
        self.reload_channels().await;
    }

    /// Tear down any running channels. Idempotent — safe to call when
    /// `channel_mgr` is `None`.
    async fn shutdown_channels(&mut self) {
        if let Some(mgr) = self.channel_mgr.take() {
            info!("shutting down channels...");
            mgr.shutdown().await;
        }
    }

    async fn sync_team_shared_dirs_for_known_workspaces(&self) {
        let grouped = group_workspaces_by_team(&self.workspaces.workspaces);
        for (team_id, workspace_paths) in grouped {
            let gate = crate::team_link::team_share_gate(self.backend.as_ref(), &team_id).await;
            for ws_path in &workspace_paths {
                crate::team_link::materialize_or_teardown(gate, &team_id, ws_path);
            }
        }
    }

    /// Run the daemon. When `shutdown` resolves, the inner loop exits
    /// gracefully — channels are shut down (consuming `shutdown(self)`) and
    /// `Ok(())` is returned. Without a shutdown signal the daemon runs
    /// forever; callers that want signal-based exit should pass
    /// `tokio::signal`-derived futures.
    pub async fn run<F>(mut self, shutdown: F) -> crate::error::Result<()>
    where
        F: Future<Output = ()>,
    {
        info!("amuxd v0.1.0 starting");

        // Start channel gateways. Best-effort: missing team_id (daemon not yet
        // onboarded) or per-channel boot failures are logged but do not abort
        // daemon startup. This runs before the MQTT loop so a misconfigured
        // channel doesn't delay collab connectivity.
        self.start_channels().await;
        self.sync_team_shared_dirs_for_known_workspaces().await;
        {
            let grouped = group_workspaces_by_team(&self.workspaces.workspaces);
            crate::sync::timer::spawn(self.sync_dispatcher.clone(), grouped);
        }
        self.register_startup_workspace_at(std::env::current_dir())
            .await;

        {
            let mut mgr = self.agents.lock().await;
            mgr.prewarm_acp_hosts().await;
        }

        // Browser-facing HTTP+SSE listener. Desktop TeamClaw requires this
        // control plane; when `[http]` is absent from daemon.toml we still
        // bind loopback with `HttpConfig::default()`. Failure to bind is
        // logged but does NOT abort the daemon — the Unix socket path remains
        // usable for legacy clients.
        let http_cfg = self.config.http.clone().unwrap_or_default();
        // Bridge: `POST /v1/workspaces` (HTTP) → the actor command loop, which
        // owns the `WorkspaceStore`. The HTTP handler sends a
        // `RegisterWorkspaceRequest`; the forwarder task below (spawned once the
        // sock command channel exists) re-publishes it as
        // `SockCommand::AddWorkspace` so the existing main-loop handler runs it.
        let (register_workspace_tx, mut register_workspace_rx) =
            mpsc::channel::<crate::http::state::RegisterWorkspaceRequest>(16);
        let _http_handle = {
            let mut meta = crate::http::server::metadata(self.actor_id.clone(), "amuxd");
            // Expose configured backends so the model-catalog endpoint can
            // group models per backend (opencode providers vs claude/codex
            // static tables).
            meta.configured_agent_types = supported_agent_type_names(&self.config);
            // The HTTP workspace runtime endpoints share this supervisor's
            // refresh coordinator for status + apply-intent semantics.
            let runtime_supervisor = crate::runtime::RuntimeSupervisor::new(self.agents.clone());
            let refresh_coordinator = runtime_supervisor.refresh_coordinator();
            self.refresh_coordinator = Some(refresh_coordinator.clone());
            {
                let mut manager = self.agents.lock().await;
                manager.attach_refresh_coordinator(refresh_coordinator.clone());
            }
            let runtime: Arc<dyn crate::http::runtime_adapter::RuntimeAdapter> =
                crate::http::runtime_adapter::RuntimeManagerAdapter::new(
                    self.agents.clone(),
                    http_cfg.max_event_backlog,
                    Some(refresh_coordinator),
                );
            let refresh_watch_registry =
                crate::runtime::refresh::refresh_watch::start_refresh_watchers(
                    runtime_supervisor.refresh_coordinator(),
                    self.workspaces
                        .workspaces
                        .iter()
                        .map(
                            |workspace| crate::runtime::refresh::refresh_watch::WatchedWorkspace {
                                workspace_id:
                                    crate::runtime::refresh::refresh_watch::workspace_runtime_id(
                                        Path::new(&workspace.path),
                                    ),
                                workspace_path: PathBuf::from(&workspace.path),
                            },
                        )
                        .collect(),
                    dirs::home_dir(),
                );
            self.refresh_watch_registry = Some(refresh_watch_registry);
            let workspace_control: Option<
                std::sync::Arc<dyn crate::config::WorkspaceControlStore>,
            > = Some(std::sync::Arc::new(
                crate::config::OpenCodeCompatStore::new(),
            ));
            let opencode_binary = crate::opencode_install::resolve_binary(
                self.config
                    .agents
                    .opencode
                    .as_ref()
                    .map(|c| c.binary.as_str()),
            );
            let opencode_settings = Some(std::sync::Arc::new(
                crate::opencode_settings::OpenCodeSettingsService::new(opencode_binary),
            ));
            match crate::http::spawn(
                http_cfg,
                meta,
                runtime,
                workspace_control,
                Some(runtime_supervisor),
                opencode_settings,
                self.sync_dispatcher.clone(),
                Some(register_workspace_tx),
            )
            .await
            {
                Ok(h) => {
                    info!(addr = %h.local_addr, "http listener bound");
                    Some(h)
                }
                Err(e) => {
                    warn!("http listener failed to start: {e}");
                    None
                }
            }
        };

        // Bind the control socket and spawn a listener that funnels parsed
        // commands into the main loop via mpsc. Done after channel start so
        // any error in `start_channels` surfaces first; failure to bind the
        // sock is logged but does NOT abort the daemon — operators can still
        // use SIGTERM / signal handlers to stop it.
        let (sock_tx, mut sock_rx) = mpsc::channel::<SockCommand>(16);
        let sock_path = DaemonConfig::sock_path();
        spawn_sock_listener(sock_path.clone(), sock_tx.clone());

        // Forward HTTP register-workspace requests into the command loop. Runs
        // for the lifetime of the daemon; exits if either channel closes.
        {
            let bridge_tx = sock_tx.clone();
            tokio::spawn(async move {
                while let Some(req) = register_workspace_rx.recv().await {
                    if bridge_tx
                        .send(SockCommand::AddWorkspace {
                            path: req.path,
                            reply_tx: req.reply_tx,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }

        // One-time setup before the reconnect loop.
        // Heartbeat runs independently of MQTT session.
        {
            let sb = self.backend.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    if let Err(e) = sb.heartbeat().await {
                        warn!("cloud heartbeat error: {e}");
                    }
                }
            });
        }

        // Idle ACP runtime sweeper. Opt-in via DaemonConfig.idle_runtime_timeout_secs.
        // The sweeper holds an `Arc<AsyncMutex<RuntimeManager>>` clone and calls
        // `evict_idle` once a minute. The terminal MQTT publish is done by the
        // main event loop draining `mgr.drain_evicted()` per tick (see Task 7).
        if let Some(threshold_secs) = self.config.idle_runtime_timeout_secs {
            let mgr = self.agents.clone();
            info!(threshold_secs, "idle ACP eviction enabled");
            let threshold = i64::try_from(threshold_secs).unwrap_or(i64::MAX);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(60));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tick.tick().await;
                    let _evicted = mgr.lock().await.evict_idle(threshold).await;
                    // No publish here — main loop drains mgr.evicted_pending_publish.
                }
            });
        } else {
            info!("idle_runtime_timeout_secs unset; idle ACP eviction disabled");
        }

        // Advertise supported agent backend types on the cloud `agents` row
        // once (background). Routing identity is the actor_id; no separate
        // device-id upsert.
        {
            let sb = self.backend.clone();
            let supported_agent_types = supported_agent_type_names(&self.config);
            let default_agent_type = supported_agent_types
                .first()
                .cloned()
                .unwrap_or_else(|| "claude".to_string());
            tokio::spawn(async move {
                if let Err(e) = sb
                    .ensure_agent_types(&supported_agent_types, &default_agent_type)
                    .await
                {
                    warn!("cloud agents.agent_types advertise failed: {e}");
                }
            });
        }

        // Report daemon client version once at startup (ops telemetry; non-fatal).
        {
            let sb = self.backend.clone();
            let device_id = crate::device_id::daemon_device_id();
            tokio::spawn(async move {
                if let Err(e) = sb.report_client_version(&device_id).await {
                    warn!("failed to report daemon client version: {e}");
                }
            });
        }

        // Dispatch to the NATS transport when the operator opted in via
        // `[transport] kind = "nats"`. The MQTT path below is unchanged.
        if matches!(
            self.config.transport.as_ref().map(|t| t.kind),
            Some(crate::config::TransportKind::Nats)
        ) {
            return self.run_nats(shutdown, sock_rx, sock_path).await;
        }

        tokio::pin!(shutdown);
        let mut first_connect = true;

        'outer: loop {
            // ── 1. Get fresh access_token (retry indefinitely on cloud backend errors) ──
            let token = loop {
                match self.backend.auth_token().await {
                    Ok(t) => break t,
                    Err(e) => {
                        warn!("token fetch failed: {e}, retrying in 30s");
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                }
            };
            if credential_in_proactive_refresh_window(self.backend.cached_credential_expiry()) {
                info!(
                    "cached JWT within proactive refresh window, forcing token refresh before MQTT connect"
                );
                self.backend.invalidate_cached_credential();
                continue 'outer;
            }

            // ── 2. Rebuild MqttClient ──
            let credential_mode =
                if self.config.mqtt.username.is_some() && self.config.mqtt.password.is_some() {
                    "configured"
                } else {
                    "backend_token"
                };
            info!(
                actor_id = %self.actor_id,
                broker   = %self.config.mqtt.broker_url,
                credential_mode,
                "MQTT connecting"
            );
            self.mqtt = match MqttClient::new(&self.config, &self.actor_id, &token) {
                Ok(c) => c,
                Err(e) => {
                    warn!("MqttClient build failed: {e}, retrying in 5s");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue 'outer;
                }
            };

            // ── 3. Rebuild teamclaw with new AsyncClient ──
            if let Some(team_id) = self.config.team_id.clone() {
                self.publisher_handle = Arc::new(self.mqtt.client.clone());
                self.topics = self.mqtt.topics.clone();
                self.teamclaw = match crate::teamclaw::SessionManager::new(
                    self.publisher_handle.clone(),
                    &team_id,
                    &self.config.actor.id,
                    Some(self.actor_id.clone()),
                    crate::config::DaemonConfig::config_dir(),
                ) {
                    Ok(tc) => Some(tc),
                    Err(e) => {
                        warn!("teamclaw rebuild failed: {e}");
                        None
                    }
                };
            }

            // ── 4. Wait for CONNACK ──
            loop {
                match self.mqtt.eventloop.poll().await {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        info!("MQTT CONNACK received");
                        break;
                    }
                    Ok(_) => {}
                    Err(rumqttc::ConnectionError::ConnectionRefused(code)) => {
                        warn!(
                            reason = ?code,
                            "MQTT connection refused during connect, refreshing token"
                        );
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        continue 'outer;
                    }
                    Err(e) => {
                        warn!("MQTT connect error: {e}, retrying...");
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
            }

            // ── 5. Subscribe and announce ──
            if let Err(e) = self.mqtt.subscribe_all().await {
                warn!("subscribe_all failed after CONNACK: {e}, reconnecting");
                continue 'outer;
            }
            if let Some(tc) = &mut self.teamclaw {
                if let Err(e) = tc.subscribe_all().await {
                    warn!("teamclaw subscribe failed: {e}, reconnecting");
                    continue 'outer;
                }
            }
            {
                let publisher =
                    Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
                if let Err(e) = publisher
                    .publish_actor_presence(&crate::proto::amux::ActorPresence {
                        online: true,
                        display_name: self.config.actor.name.clone(),
                        timestamp: chrono::Utc::now().timestamp(),
                    })
                    .await
                {
                    warn!("publish_actor_presence failed after CONNACK: {e}, reconnecting");
                    continue 'outer;
                }
            }
            self.publish_all_agent_states().await;
            info!(actor_id = %self.config.actor.id, "MQTT connected, listening for commands");

            if first_connect {
                // Drain messages that landed in the cloud backend while the daemon
                // process was down. MQTT lives are dropped by the broker
                // when clean_session=true clients are offline, so anything
                // posted by desktop/iOS/expo between daemon stop and start
                // exists only in the `messages` table and would otherwise
                // never reach any agent.
                self.auto_restart_offline_sessions().await;
                first_connect = false;
            }

            // ── 6. Proactive reconnect timer ──
            //
            // Compute when to break the inner loop so we can fetch a fresh
            // access_token and re-CONNECT before the current JWT expires.
            // EMQX silently rejects PUB/SUB on a connection whose JWT exp
            // has passed (it doesn't always disconnect), so waiting for a
            // reactive ConnectionRefused leaves stale-ACL windows where
            // the daemon thinks everything's fine but messages are dropped.
            // Fire 5 min before the cached expiry; conservative 50 min
            // fallback if expiry isn't cached yet.
            let proactive_reconnect_in =
                proactive_reconnect_delay(self.backend.cached_credential_expiry());
            info!(
                reconnect_in_secs = proactive_reconnect_in.as_secs(),
                "scheduled proactive MQTT reconnect before token expiry"
            );
            let proactive_sleep = tokio::time::sleep(proactive_reconnect_in);
            tokio::pin!(proactive_sleep);

            // ── 7. Event loop ──
            //
            // We must NEVER preempt `eventloop.poll()` with a timeout. rumqttc's
            // poll() drives TLS handshake / TCP reconnect / packet IO inside one
            // future; if we drop the future mid-flight (which timeout() does),
            // the in-progress connection state is dropped, the underlying socket
            // is closed (broker sees `ssl_closed`), and the next poll() starts a
            // fresh reconnect — leading to a self-takeover loop where the
            // daemon opens 4-5 sockets per ~50 ms timeout cycle and broker
            // discards them. Use `tokio::select!` instead so the agent-event
            // pump runs alongside poll() without cancelling it.
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        info!("shutdown signal received, draining channels");
                        self.shutdown_channels().await;
                        let _ = std::fs::remove_file(&sock_path);
                        return Ok(());
                    }
                    sock_cmd = sock_rx.recv() => {
                        match sock_cmd {
                            Some(SockCommand::ChannelReload) => {
                                self.reload_channels().await;
                            }
                            Some(SockCommand::ChannelStatus { reply_tx }) => {
                                let body = self.channel_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::ChannelSave { platform, config_json }) => {
                                self.save_channel_config(&platform, &config_json).await;
                            }
                            Some(SockCommand::McpSend { payload, reply_tx }) => {
                                let resp = match self.handle_mcp_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::PromptAwait { payload, reply_tx }) => {
                                let resp = match self.handle_prompt_await(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrStart { reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::fetch_qr_code(&base_url).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrPoll { qrcode, reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::poll_qr_status(&base_url, &qrcode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrStart { reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::fetch_wecom_qr_code().await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrPoll { scode, reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::poll_wecom_qr_result(&scode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::AddWorkspace { path, reply_tx }) => {
                                let body = self.handle_add_workspace_sock(&path).await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::Unknown(line)) => {
                                warn!("amuxd.sock: unknown control command: {line:?}");
                            }
                            None => {
                                // Sender dropped — listener task died. Log and
                                // keep running; we just lose the sock control
                                // path until next restart.
                                warn!("amuxd.sock: listener channel closed; control commands unavailable until restart");
                            }
                        }
                    }
                    poll_result = self.mqtt.eventloop.poll() => {
                        match poll_result {
                            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                                // Network blip — rumqttc reconnected automatically.
                                info!("MQTT reconnected (network blip), re-publishing state");
                                let _ = self.mqtt.subscribe_all().await;
                                if let Some(tc) = &mut self.teamclaw {
                                    let _ = tc.subscribe_all().await;
                                }
                                let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
                                let _ = publisher.publish_actor_presence(&crate::proto::amux::ActorPresence {
                                    online: true,
                                    display_name: self.config.actor.name.clone(),
                                    timestamp: chrono::Utc::now().timestamp(),
                                }).await;
                                self.publish_all_agent_states().await;
                            }
                            Ok(Event::Incoming(Packet::Publish(publish))) => {
                                if let Some(msg) = subscriber::parse_incoming(&publish) {
                                    self.handle_incoming(msg).await;
                                }
                            }
                            // EMQX rejected connection (JWT expired).
                            Err(rumqttc::ConnectionError::ConnectionRefused(code)) => {
                                warn!(reason = ?code, "MQTT connection refused (token expired), reconnecting");
                                break; // outer loop gets fresh token
                            }
                            Err(e) => {
                                warn!("MQTT transient error: {e}, will retry (rumqttc auto-reconnects)");
                                tokio::time::sleep(Duration::from_secs(5)).await;
                            }
                            Ok(_) => {} // other events (Outgoing(...), PingResp, etc.)
                        }
                    }
                    _ = &mut proactive_sleep => {
                        info!(
                            expiry = ?self.backend.cached_credential_expiry(),
                            "JWT nearing expiry, proactively reconnecting MQTT before broker silently denies ACL"
                        );
                        self.backend.invalidate_cached_credential();
                        // Queue a graceful DISCONNECT so the broker sees an
                        // intentional close (no LWT blip) before we drop the
                        // eventloop. The drain loop below gives rumqttc a
                        // bounded chance to write the packet.
                        let _ = self.mqtt.client.disconnect().await;
                        for _ in 0..3 {
                            match tokio::time::timeout(
                                Duration::from_millis(50),
                                self.mqtt.eventloop.poll(),
                            ).await {
                                Ok(Err(_)) | Err(_) => break,
                                Ok(Ok(_)) => {}
                            }
                        }
                        break; // outer loop fetches fresh token + reconnects
                    }
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {
                        // Drain queued runtime events without preempting poll().
                        let (agent_events, evicted_runtime_ids): (Vec<_>, Vec<String>) = {
                            let mut mgr = self.agents.lock().await;
                            (mgr.poll_events(), mgr.drain_evicted())
                        };
                        for runtime_id in evicted_runtime_ids {
                            self.publish_runtime_stopped(&runtime_id).await;
                        }
                        for (agent_id, acp_event) in agent_events {
                            self.forward_agent_event(&agent_id, acp_event).await;
                        }
                    }
                }
            }
            // loop exited → outer: get fresh token and reconnect
        }
    }

    /// NATS transport main loop. Parallel to the MQTT path in `run()` above —
    /// same token-refresh outer cadence, but the inner loop polls the NATS
    /// inbound channel (mpsc Receiver fed by per-subscription tasks inside
    /// `teamclaw_transport::nats::NatsClient`).
    ///
    /// Differences vs MQTT:
    /// - No CONNACK wait: async_nats returns from `connect` only after the
    ///   server has accepted the connection.
    /// - No LWT: graceful offline state is written to JetStream KV during
    ///   shutdown / reconnect; ungraceful disconnects are detected by the
    ///   server-side auth callout.
    /// - No `eventloop.poll()` to cancel — async_nats reconnects internally
    ///   on transport-level errors, so the proactive-reconnect path just
    ///   builds a fresh `NatsBackend` rather than draining a half-closed
    ///   socket.
    async fn run_nats<F>(
        mut self,
        shutdown: F,
        mut sock_rx: mpsc::Receiver<SockCommand>,
        sock_path: PathBuf,
    ) -> crate::error::Result<()>
    where
        F: Future<Output = ()>,
    {
        use teamclaw_transport::DeliveryGuarantee;
        tokio::pin!(shutdown);

        let url = self
            .config
            .transport
            .as_ref()
            .map(|t| t.url.clone())
            .ok_or_else(|| {
                crate::error::AmuxError::Config(
                    "[transport] section requires `url` when kind = nats".into(),
                )
            })?;

        let mut first_connect = true;

        'outer: loop {
            // 1. Fresh backend access_token; same retry cadence as MQTT path.
            let token = loop {
                match self.backend.auth_token().await {
                    Ok(t) => break t,
                    Err(e) => {
                        warn!("token fetch failed: {e}, retrying in 30s");
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                }
            };
            if credential_in_proactive_refresh_window(self.backend.cached_credential_expiry()) {
                info!(
                    "cached JWT within proactive refresh window, forcing token refresh before NATS connect"
                );
                self.backend.invalidate_cached_credential();
                continue 'outer;
            }

            // 2. Connect.
            info!(
                actor_id = %self.actor_id,
                %url,
                "NATS connecting with access_token"
            );
            let backend = match crate::nats::NatsBackend::connect(&self.config, &url, &token).await
            {
                Ok(b) => b,
                Err(e) => {
                    warn!("NATS connect failed: {e}, retrying in 5s");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue 'outer;
                }
            };

            // 3. Re-wire publisher_handle + topics so all downstream
            //    Publisher::new_from_handle / SessionManager publishes route
            //    through the NATS backend instead of the MQTT one.
            self.publisher_handle = Arc::new(backend.client.clone());
            self.topics = backend.topics.clone();
            if let Some(team_id) = self.config.team_id.clone() {
                self.teamclaw = match crate::teamclaw::SessionManager::new(
                    self.publisher_handle.clone(),
                    &team_id,
                    &self.config.actor.id,
                    Some(self.actor_id.clone()),
                    crate::config::DaemonConfig::config_dir(),
                ) {
                    Ok(tc) => Some(tc),
                    Err(e) => {
                        warn!("teamclaw rebuild on NATS failed: {e}");
                        None
                    }
                };
            }
            self.nats = Some(backend);

            // 4. Subscribe + announce online.
            if let Err(e) = self.nats.as_ref().unwrap().subscribe_all().await {
                warn!("nats subscribe_all failed: {e}, reconnecting");
                continue 'outer;
            }
            if let Some(tc) = &mut self.teamclaw {
                if let Err(e) = tc.subscribe_all().await {
                    warn!("teamclaw subscribe failed on NATS: {e}, reconnecting");
                    continue 'outer;
                }
            }
            if let Err(e) = self
                .nats
                .as_ref()
                .unwrap()
                .announce_online(&self.config.actor.name)
                .await
            {
                warn!("nats announce_online failed: {e}, reconnecting");
                continue 'outer;
            }
            self.publish_all_agent_states().await;
            info!(actor_id = %self.config.actor.id, "NATS connected, listening for runtime commands");

            if first_connect {
                self.auto_restart_offline_sessions().await;
                first_connect = false;
            }

            // 5. Proactive reconnect timer (mirrors MQTT path: refresh ~5min
            //    before cached JWT expiry). On NATS this means tearing down
            //    the current client and reconnecting with the new token —
            //    async_nats keeps the auth token only at connect time, so an
            //    in-place refresh isn't possible without a fresh connection.
            let proactive_reconnect_in =
                proactive_reconnect_delay(self.backend.cached_credential_expiry());
            info!(
                reconnect_in_secs = proactive_reconnect_in.as_secs(),
                "scheduled proactive NATS reconnect before token expiry"
            );
            let proactive_sleep = tokio::time::sleep(proactive_reconnect_in);
            tokio::pin!(proactive_sleep);

            // 6. Inner select loop — three arms: shutdown, sock command,
            //    inbound NATS frame. The inbound receiver is moved out of
            //    `self.nats` once for the duration of this select cycle and
            //    re-attached on reconnect.
            //
            //    We can't borrow `&mut self.nats.inbound` *and* call
            //    `&mut self` methods inside the same select arm, so the
            //    receiver is owned locally and the backend reference goes
            //    along with it. SessionManager and Publisher reads happen
            //    via the cloned `publisher_handle`, which doesn't touch
            //    `self.nats`.
            let mut inbound = self.nats.as_mut().unwrap().inbound_take();
            loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown => {
                        info!("shutdown signal received, draining channels");
                        if let Some(nats) = &self.nats {
                            let _ = nats.announce_offline(&self.config.actor.name).await;
                        }
                        self.shutdown_channels().await;
                        let _ = std::fs::remove_file(&sock_path);
                        return Ok(());
                    }
                    sock_cmd = sock_rx.recv() => {
                        match sock_cmd {
                            Some(SockCommand::ChannelReload) => self.reload_channels().await,
                            Some(SockCommand::ChannelStatus { reply_tx }) => {
                                let body = self.channel_status_payload().await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::ChannelSave { platform, config_json }) => {
                                self.save_channel_config(&platform, &config_json).await;
                            }
                            Some(SockCommand::McpSend { payload, reply_tx }) => {
                                let resp = match self.handle_mcp_send(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::PromptAwait { payload, reply_tx }) => {
                                let resp = match self.handle_prompt_await(&payload).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrStart { reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::fetch_qr_code(&base_url).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WechatQrPoll { qrcode, reply_tx }) => {
                                let base_url = teamclaw_gateway::wechat_config::default_ilink_base_url();
                                let resp = match teamclaw_gateway::wechat::poll_qr_status(&base_url, &qrcode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrStart { reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::fetch_wecom_qr_code().await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::WecomQrPoll { scode, reply_tx }) => {
                                let resp = match teamclaw_gateway::wecom::poll_wecom_qr_result(&scode).await {
                                    Ok(v) => serde_json::json!({ "ok": true, "result": v }),
                                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                                };
                                let _ = reply_tx.send(resp.to_string());
                            }
                            Some(SockCommand::AddWorkspace { path, reply_tx }) => {
                                let body = self.handle_add_workspace_sock(&path).await;
                                let _ = reply_tx.send(body);
                            }
                            Some(SockCommand::Unknown(line)) => warn!("amuxd.sock: unknown control command: {line:?}"),
                            None => warn!("amuxd.sock: listener channel closed; control commands unavailable until restart"),
                        }
                    }
                    frame = inbound.recv() => {
                        match frame {
                            Some(f) => {
                                if let Some(msg) = crate::mqtt::subscriber::parse_frame(&f) {
                                    self.handle_incoming(msg).await;
                                }
                            }
                            None => {
                                warn!("NATS inbound channel closed, reconnecting");
                                break;
                            }
                        }
                    }
                    _ = &mut proactive_sleep => {
                        info!(
                            expiry = ?self.backend.cached_credential_expiry(),
                            "JWT nearing expiry, proactively reconnecting NATS"
                        );
                        self.backend.invalidate_cached_credential();
                        // Mark offline before tearing down so subscribers see
                        // the presence change immediately rather than waiting
                        // for the next online publish.
                        if let Some(nats) = &self.nats {
                            let _ = nats.announce_offline(&self.config.actor.name).await;
                        }
                        break;
                    }
                }
            }
            // Put the inbound receiver back so the next reconnect can take it.
            self.nats.as_mut().unwrap().inbound_put_back(inbound);
            // loop exited → outer: get fresh token and reconnect
            let _ = DeliveryGuarantee::AtLeastOnce; // touch import so it stays
        }
    }

    async fn register_startup_workspace_at(
        &mut self,
        current_dir: std::io::Result<std::path::PathBuf>,
    ) {
        if !self.workspaces.workspaces.is_empty() {
            return;
        }

        let current_dir = match current_dir {
            Ok(path) => path,
            Err(e) => {
                warn!(
                    "workspace auto-registration skipped: current_dir failed: {}",
                    e
                );
                return;
            }
        };

        let startup_path = current_dir.to_string_lossy().to_string();
        match self.workspaces.add(&startup_path) {
            Ok(outcome) => {
                let mut workspace = outcome.workspace;
                let mut should_save = outcome.inserted;

                if self.stamp_daemon_team(&mut workspace) {
                    should_save = true;
                }

                if self.sync_workspace_to_cloud(&mut workspace).await {
                    should_save = true;
                }

                if let Some(existing) = self
                    .workspaces
                    .workspaces
                    .iter_mut()
                    .find(|w| w.workspace_id == workspace.workspace_id)
                {
                    *existing = workspace.clone();
                }

                if outcome.inserted && !workspace.remote_workspace_id.is_empty() {
                    if let Err(e) = self
                        .backend
                        .set_agent_default_workspace(&workspace.remote_workspace_id)
                        .await
                    {
                        warn!(
                            workspace_id = %workspace.remote_workspace_id,
                            path = %workspace.path,
                            "startup default workspace update failed: {}",
                            e
                        );
                    } else {
                        self.workspaces
                            .set_default_workspace_id(&workspace.workspace_id);
                        should_save = true;
                        info!(
                            workspace_id = %workspace.remote_workspace_id,
                            path = %workspace.path,
                            "startup default workspace set"
                        );
                    }
                }

                if !should_save {
                    return;
                }

                if let Err(e) = self.workspaces.save(&self.workspaces_path) {
                    warn!(path = %startup_path, "workspace auto-registration save failed: {}", e);
                    return;
                }

                // The startup sweep runs *before* this fresh-machine
                // registration, so link the just-stamped workspace here too.
                if let Some(team_id) = workspace.team_id.clone() {
                    let gate =
                        crate::team_link::team_share_gate(self.backend.as_ref(), &team_id).await;
                    crate::team_link::materialize_or_teardown(gate, &team_id, &workspace.path);
                }

                info!(
                    workspace_id = %workspace.workspace_id,
                    path = %workspace.path,
                    "startup workspace registered"
                );
            }
            Err(e) => {
                warn!(path = %startup_path, "workspace auto-registration failed: {}", e);
            }
        }
    }

    /// Re-engage with sessions that had a runtime before the daemon was
    /// last shut down so we can replay messages that landed in the cloud backend
    /// while the daemon was offline.
    ///
    /// Daemon-owned runtimes are subprocesses; they die when the daemon
    /// process exits. MQTT live publishes against those sessions are
    /// dropped by the broker (clean_session=true), so the only record of
    /// those messages is the `messages` table. The user-facing symptom is
    /// "messages I sent while the daemon was off never get a reply"
    /// (mentions go unanswered, silent messages never enter the runtime's
    /// pending_silent queue).
    ///
    /// Strategy: for each session this daemon is a member of, look up the
    /// most recent `agent_runtimes` row owned by this daemon. If the row
    /// has unread messages strictly after the row's
    /// `last_processed_message_id` cursor, spawn the runtime (reusing the
    /// row's `workspace_id` + `backend_type`). The existing
    /// `catchup_runtime` path then routes those messages through
    /// `route_session_message`, which sends `[Context]` prefixes for
    /// un-mentioned rows and a real prompt for mentions.
    ///
    /// Self-authored rows are filtered out — they are the daemon's own
    /// prior agent replies, not user input that needs processing.
    async fn auto_restart_offline_sessions(&mut self) {
        let plan = self.plan_auto_restart_offline_sessions().await;
        if plan.is_empty() {
            return;
        }
        info!(
            count = plan.len(),
            "auto_restart_offline_sessions: spawning {} runtime(s) for sessions with offline messages",
            plan.len()
        );
        for entry in plan {
            info!(
                session_id = %entry.session_id,
                workspace_id = %entry.local_workspace_id,
                backend = ?entry.backend,
                unread = entry.unread_count,
                "auto_restart_offline_sessions: spawning runtime to drain offline messages"
            );
            match self
                .apply_start_runtime(
                    entry.backend,
                    &entry.local_workspace_id,
                    "",
                    &entry.session_id,
                    "",
                    None,
                )
                .await
            {
                Ok(outcome) => {
                    info!(
                        session_id = %entry.session_id,
                        runtime_id = %outcome.runtime_id,
                        "auto_restart_offline_sessions: runtime spawned, catchup_runtime engaged"
                    );
                }
                Err(err) => {
                    warn!(
                        session_id = %entry.session_id,
                        error = %err.error_message,
                        stage = %err.failed_stage,
                        "auto_restart_offline_sessions: apply_start_runtime failed"
                    );
                }
            }
        }
    }

    /// Pure-decision half of [`auto_restart_offline_sessions`]: walks
    /// membership sessions, queries the cloud backend, and returns the subset that
    /// should be re-spawned. Extracted so unit tests can drive the
    /// branching logic (no prior row → skip, only self-authored unread →
    /// skip, already-running runtime → skip, etc.) without booting a real
    /// ACP backend.
    pub(crate) async fn plan_auto_restart_offline_sessions(&self) -> Vec<OfflineRestartPlan> {
        let session_ids: Vec<String> = match self.teamclaw.as_ref() {
            Some(tc) => tc.membership_session_ids(),
            None => return Vec::new(),
        };
        if session_ids.is_empty() {
            return Vec::new();
        }
        info!(
            count = session_ids.len(),
            "plan_auto_restart_offline_sessions: scanning membership sessions for offline messages"
        );

        let mut plan = Vec::new();
        let my_actor = self.actor_id.clone();
        for session_id in session_ids {
            let prior = match self
                .backend
                .fetch_latest_runtime_for_session(&my_actor, &session_id)
                .await
            {
                Ok(Some(row)) => row,
                Ok(None) => continue,
                Err(e) => {
                    warn!(
                        ?e,
                        session_id = %session_id,
                        "plan_auto_restart_offline_sessions: fetch_latest_runtime_for_session failed"
                    );
                    continue;
                }
            };

            // If a live runtime is already serving this session (e.g. a
            // network blip rather than a full daemon restart), skip — the
            // live MQTT path will deliver the messages directly.
            let already_running = !self
                .agents
                .lock()
                .await
                .runtime_ids_for_session(&session_id)
                .is_empty();
            if already_running {
                continue;
            }

            let cursor = prior
                .last_processed_message_id
                .as_deref()
                .filter(|s| !s.is_empty());
            let messages = match self
                .backend
                .messages_after_cursor(&session_id, cursor)
                .await
            {
                Ok(m) => m,
                Err(e) => {
                    warn!(
                        ?e,
                        session_id = %session_id,
                        "plan_auto_restart_offline_sessions: messages_after_cursor failed"
                    );
                    continue;
                }
            };

            if !slice_has_actionable_inbound(&messages, &my_actor) {
                continue;
            }

            let unread_count = messages
                .iter()
                .filter(|m| m.sender_actor_id != my_actor)
                .count();

            let backend_requested = match prior.backend_type.as_str() {
                "claude" | "claude_code" => amux::AgentType::ClaudeCode,
                "opencode" => amux::AgentType::Opencode,
                "codex" => amux::AgentType::Codex,
                _ => amux::AgentType::Unknown,
            };
            let backend = resolve_requested_agent_type(&self.config, backend_requested);

            // Translate the cloud workspace id into a local workspace id
            // by matching on `remote_workspace_id`. If we can't find a
            // local mapping (workspace was archived locally, daemon
            // reinstalled, etc.) leave it empty so apply_start_runtime
            // falls back to the registered workspace lookup or current dir.
            let local_workspace_id = prior
                .workspace_id
                .as_ref()
                .and_then(|sb_ws| {
                    self.workspaces
                        .workspaces
                        .iter()
                        .find(|w| w.remote_workspace_id.as_str() == sb_ws.as_str())
                        .map(|w| w.workspace_id.clone())
                })
                .unwrap_or_default();

            plan.push(OfflineRestartPlan {
                session_id,
                backend,
                local_workspace_id,
                unread_count,
            });
        }
        plan
    }

    async fn sync_workspace_to_cloud(
        &self,
        workspace: &mut crate::config::StoredWorkspace,
    ) -> bool {
        let sb = &self.backend;

        let row = WorkspaceUpsert {
            team_id: sb.team_id(),
            agent_id: sb.actor_id(),
            name: &workspace.display_name,
            path: if workspace.path.is_empty() {
                None
            } else {
                Some(workspace.path.as_str())
            },
            archived: false,
        };

        match sb.upsert_workspace(&row).await {
            Ok(remote) => {
                if workspace.remote_workspace_id == remote.id {
                    return false;
                }
                workspace.remote_workspace_id = remote.id;
                true
            }
            Err(e) => {
                warn!(path = %workspace.path, "workspace cloud sync failed: {}", e);
                false
            }
        }
    }

    /// Build merged agent list: active agents + historical (non-active) sessions.
    /// Now only used by `publish_all_agent_states` to iterate startup/reconnect state.
    /// Per-agent updates should go through `publish_runtime_state_by_id`.
    async fn merged_agent_list(&self) -> amux::AgentList {
        let mut agent_list = self.agents.lock().await.to_proto_agent_list();
        let active_ids: std::collections::HashSet<String> = agent_list
            .runtimes
            .iter()
            .map(|a| a.runtime_id.clone())
            .collect();
        for session_info in self.sessions.to_proto_agent_list() {
            if !active_ids.contains(&session_info.runtime_id) {
                agent_list.runtimes.push(session_info);
            }
        }
        agent_list
    }

    /// Look up a single agent's current RuntimeInfo — live adapter first, then
    /// the historical session store. Returns `None` if unknown.
    async fn agent_info_by_id(&self, agent_id: &str) -> Option<amux::RuntimeInfo> {
        match self.agents.lock().await.to_proto_info(agent_id) {
            Some(info) => Some(info),
            None => self.sessions.to_proto_agent_info(agent_id),
        }
    }

    /// Publish retained RuntimeInfo for a single agent on its per-agent state
    /// topic. Swallows errors (same convention as other publish helpers).
    async fn publish_runtime_state_by_id(&self, agent_id: &str) {
        if let Some(info) = self.agent_info_by_id(agent_id).await {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_runtime_state(agent_id, &info).await;
        }
    }

    /// Publish every known agent (active + historical) individually. Used on
    /// startup and after MQTT reconnect so clients subscribing to the wildcard
    /// `agent/+/state` topic receive one retained message per agent — keeping
    /// each publish small instead of relying on a large broker packet limit,
    /// which the old single-list publish would blow past once the session
    /// count grew.
    async fn publish_all_agent_states(&self) {
        let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
        for info in self.merged_agent_list().await.runtimes {
            let _ = publisher
                .publish_runtime_state(&info.runtime_id, &info)
                .await;
        }
    }

    /// Returns the single collab session_id this runtime should publish
    /// ACP events to. Each runtime is bound at spawn time to one session
    /// via `RuntimeHandle.session_id` (set from
    /// `apply_start_runtime`'s remote_session_id), so fanout has to be
    /// scoped to that one session.
    ///
    /// Earlier versions of this function unioned in
    /// `teamclaw.sessions_for_agent(daemon_actor_id)` — the set of
    /// sessions where the daemon (as agent participant) lives. That set
    /// is "all collab sessions this daemon serves," not "the session
    /// this turn belongs to," so every agent event got fanned out to
    /// every session — bug observed 2026-04-27 where one user message
    /// in session A produced agent reply copies in 8 unrelated sessions
    /// (and 9× the broker traffic on every turn). The runtime's own
    /// `session_id` is the only correct destination.
    ///
    /// Returns an empty vec for ambient/bare-agent spawns where
    /// `session_id` was never set; callers fall back to the
    /// legacy per-runtime events topic in that case.
    ///
    /// Gateway-spawned runtimes never reach `apply_start_runtime` and
    /// therefore have no entry in the local SessionStore. They carry the
    /// cloud session UUID on their in-memory `RuntimeHandle` instead,
    /// so when the persisted lookup misses we fall back to RuntimeManager.
    async fn target_sessions(&self, agent_id: &str) -> Vec<String> {
        if let Some(sid) = self
            .sessions
            .find_by_id(agent_id)
            .map(|s| s.session_id.clone())
            .filter(|s| !s.is_empty())
        {
            return vec![sid];
        }
        let live = self
            .agents
            .lock()
            .await
            .get_handle(agent_id)
            .map(|h| h.session_id.clone())
            .unwrap_or_default();
        if live.is_empty() {
            Vec::new()
        } else {
            vec![live]
        }
    }

    async fn forward_agent_event(&mut self, agent_id: &str, mut acp_event: amux::AcpEvent) {
        // Stamp the current model on agent-reply events (Output, Thinking) so iOS
        // bubbles can show which model produced the response. Other event types
        // (status changes, tool calls, permission requests, raw control messages)
        // are not model-attributable and stay empty. Safe to read current_model
        // here for the same reason as the collab publish path: the daemon event
        // loop is single-threaded, so no SetModel can interleave between the
        // agent's reply and this lookup.
        if matches!(
            acp_event.event,
            Some(amux::acp_event::Event::Output(_)) | Some(amux::acp_event::Event::Thinking(_))
        ) {
            if let Some(model) = self.agents.lock().await.current_model(agent_id).cloned() {
                acp_event.model = model;
            }
        }

        // Register permission requests for later resolution
        if let Some(amux::acp_event::Event::PermissionRequest(ref pr)) = acp_event.event {
            self.permissions.register_pending(&pr.request_id);
        }

        if let Some(amux::acp_event::Event::Error(ref err)) = acp_event.event {
            let message = if err.message.is_empty() {
                "ACP runtime error".to_string()
            } else {
                err.message.clone()
            };
            let details = if err.details.is_empty() {
                message.clone()
            } else {
                err.details.clone()
            };
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.status = amux::AgentStatus::Error;
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.status = amux::AgentStatus::Error as i32;
                let _ = self.sessions.save(&self.sessions_path);
            }
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher
                .publish_runtime_failed(agent_id, "ACP_ERROR", &details, "acp")
                .await;
        }

        // Handle internal RawJson events (session_title, tool_title_update)
        if let Some(amux::acp_event::Event::Raw(ref raw)) = acp_event.event {
            if raw.method == "session_title" {
                let title = String::from_utf8_lossy(&raw.json_payload).to_string();
                let updated = {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(agent_id) {
                        handle.session_title = title;
                        true
                    } else {
                        false
                    }
                };
                if updated {
                    self.publish_runtime_state_by_id(agent_id).await;
                }
                return;
            }
            if raw.method == "tool_title_update" {
                // Format: "tool_id|new_title"
                let payload = String::from_utf8_lossy(&raw.json_payload);
                if let Some((_tool_id, _new_title)) = payload.split_once('|') {
                    // Forward as a ToolUse event so iOS updates the tool name
                    let update_event = amux::AcpEvent {
                        event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                            method: "tool_title_update".into(),
                            json_payload: raw.json_payload.clone(),
                        })),
                        model: String::new(),
                    };
                    let (seq, turn_id) = {
                        let mut agents = self.agents.lock().await;
                        let seq = agents
                            .get_handle_mut(agent_id)
                            .map(|h| h.next_sequence())
                            .unwrap_or(0);
                        let turn_id = agents
                            .aggregator(agent_id)
                            .and_then(|a| a.current_turn_id())
                            .unwrap_or("")
                            .to_string();
                        (seq, turn_id)
                    };
                    let envelope = amux::Envelope {
                        runtime_id: agent_id.into(),
                        actor_id: self.config.actor.id.clone(),
                        source_peer_id: String::new(),
                        timestamp: chrono::Utc::now().timestamp(),
                        sequence: seq,
                        turn_id,
                        payload: Some(amux::envelope::Payload::AcpEvent(update_event)),
                    };
                    self.history.append(agent_id, &envelope);
                    self.publish_envelope_to_sessions(agent_id, &envelope).await;
                }
                return;
            }
        }

        // Update agent status if this is a status change event
        if let Some(amux::acp_event::Event::StatusChange(ref sc)) = acp_event.event {
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.status = amux::AgentStatus::try_from(sc.new_status)
                        .unwrap_or(amux::AgentStatus::Unknown);
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.status = sc.new_status;
                let _ = self.sessions.save(&self.sessions_path);
            }
            self.publish_runtime_state_by_id(agent_id).await;

            // Upsert agent_runtimes on status transitions
            {
                let sb = &self.backend;
                let new_status = amux::AgentStatus::try_from(sc.new_status)
                    .unwrap_or(amux::AgentStatus::Unknown);
                let cloud_status: &'static str = match new_status {
                    amux::AgentStatus::Active => "running",
                    amux::AgentStatus::Idle => "idle",
                    amux::AgentStatus::Stopped => "stopped",
                    _ => "unknown",
                };
                let (acp_sid, session_id, ws_id, current_model, backend_type) = {
                    let agents = self.agents.lock().await;
                    let h = agents.get_handle(agent_id);
                    (
                        h.map(|h| h.acp_session_id.clone()).unwrap_or_default(),
                        h.map(|h| h.session_id.clone()).unwrap_or_default(),
                        h.map(|h| h.workspace_id.clone()).unwrap_or_default(),
                        agents.current_model(agent_id).cloned(),
                        h.map(|h| agents.launch_config_for(h.agent_type).backend_type)
                            .unwrap_or("claude"),
                    )
                };
                let remote_workspace_id = self.workspaces.find_by_id(&ws_id).and_then(|w| {
                    (!w.remote_workspace_id.is_empty()).then_some(w.remote_workspace_id.clone())
                });
                let team_id = sb.team_id().to_string();
                let actor_id = sb.actor_id().to_string();
                let runtime_id_owned = agent_id.to_string();
                let sb_clone = sb.clone();
                let now = chrono::Utc::now();
                tokio::spawn(async move {
                    let row = AgentRuntimeUpsert {
                        team_id: &team_id,
                        agent_id: &actor_id,
                        session_id: (!session_id.is_empty()).then_some(session_id.as_str()),
                        workspace_id: remote_workspace_id.as_deref(),
                        backend_type,
                        backend_session_id: if acp_sid.is_empty() {
                            None
                        } else {
                            Some(acp_sid.as_str())
                        },
                        runtime_id: Some(runtime_id_owned.as_str()),
                        status: cloud_status,
                        current_model: current_model.as_deref(),
                        last_seen_at: now,
                    };
                    if let Err(e) = sb_clone.upsert_agent_runtime(&row).await {
                        warn!("agent_runtimes upsert ({cloud_status}): {e}");
                    }
                });
            }
        }

        // Update session on tool use
        if let Some(amux::acp_event::Event::ToolUse(_)) = acp_event.event {
            {
                let mut agents = self.agents.lock().await;
                if let Some(handle) = agents.get_handle_mut(agent_id) {
                    handle.tool_use_count += 1;
                }
            }
            if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                session.tool_use_count += 1;
                let _ = self.sessions.save(&self.sessions_path);
            }
        }

        // Drive the per-agent TurnAggregator. Emitted logical messages are
        // appended to local TOML, published to session/live as
        // `message.created`, and (for AGENT_REPLY only) persisted to
        // cloud `messages`. ACP `acp.event` envelopes still flow through
        // the unchanged publish path below for streaming UI.
        let collab_sessions = self.target_sessions(agent_id).await;
        // Allocate the envelope sequence up front so it can also stamp
        // emitted messages (cloud `messages.sequence`). The envelope
        // append below uses the same value, keeping a 1:1 link between an
        // ACP event boundary and the messages that flowed from it.
        let (emitted, turn_id, seq) = {
            let mut agents = self.agents.lock().await;
            let seq = agents
                .get_handle_mut(agent_id)
                .map(|h| h.next_sequence())
                .unwrap_or(0);
            match agents.aggregator_mut(agent_id) {
                Some(agg) => {
                    // ingest may transition Active→Idle, which clears
                    // current_turn_id. Read AFTER ingest so the envelope for
                    // the final status-change carries an empty turn_id (the
                    // turn just ended); deltas / completions within an active
                    // turn capture the still-Some id.
                    let emitted = agg.ingest(&acp_event);
                    let turn_id = agg.current_turn_id().unwrap_or("").to_string();
                    (emitted, turn_id, seq)
                }
                None => (Vec::new(), String::new(), seq),
            }
        };
        if !collab_sessions.is_empty() && !emitted.is_empty() {
            if let Some(tc) = self.teamclaw.as_ref() {
                let actor_id = self.actor_id.clone();
                let model = self
                    .agents
                    .lock()
                    .await
                    .current_model(agent_id)
                    .cloned()
                    .unwrap_or_default();
                for msg in emitted {
                    let persist =
                        crate::runtime::turn_aggregator::TurnAggregator::cloud_persistent(&msg);
                    // Non-persistent kinds (AgentThinking / AgentToolCall /
                    // AgentToolResult) are already fully covered by the
                    // acp.event stream below — re-publishing them as
                    // message.created on session/live just makes iOS
                    // render the same content twice (folded thinking card
                    // + plain bubble via handleIncomingChatMessage). Only
                    // AgentReply needs message.created, since that is the
                    // turn-finalized form persisted to the cloud backend and used
                    // by historical replay / other collaborators.
                    if !persist {
                        continue;
                    }
                    let kind = msg.kind;
                    let content = msg.content;
                    let metadata_json = msg.metadata_json;
                    let turn_id = msg.turn_id;
                    for sid in &collab_sessions {
                        tc.emit_agent_message(
                            sid,
                            &actor_id,
                            kind,
                            &content,
                            &metadata_json,
                            &model,
                            &turn_id,
                            seq,
                            persist,
                            Some(&self.backend),
                        )
                        .await;
                    }
                }
            }
        }

        // Ambient state variants (replaced wholesale on each push) should not
        // be persisted into the history buffer — replaying stale lists on
        // reconnect wastes bandwidth and contradicts the "in-memory only"
        // contract iOS assumes.
        let is_ambient = matches!(
            acp_event.event,
            Some(amux::acp_event::Event::AvailableCommands(_))
        );

        // Keep publishes under a conservative 10 KB budget. Claude Code's
        // AvailableCommands list with full descriptions routinely lands at
        // ~12 KB, which can trip broker packet limits and knock the daemon's
        // MQTT session offline mid-session-start. Trim descriptions (and as a
        // last resort commands themselves) in-place until the envelope fits.
        if let Some(amux::acp_event::Event::AvailableCommands(ref mut ac)) = acp_event.event {
            fit_available_commands_in_budget(ac);
            // Cache the trimmed list so the retained `runtime/{id}/state`
            // publish carries the same commands a fresh subscriber would
            // otherwise miss (events stream is not retained). Republish
            // immediately — ACP's AvailableCommandsUpdate fires after spawn
            // but typically before any status transition, so without this
            // bump the retained state would stay empty until the next
            // unrelated transition.
            self.agents
                .lock()
                .await
                .set_available_commands(agent_id, ac.commands.clone());
            self.publish_runtime_state_by_id(agent_id).await;
        }

        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            actor_id: self.config.actor.id.clone(),
            source_peer_id: String::new(), // agent-initiated
            timestamp: chrono::Utc::now().timestamp(),
            sequence: seq,
            turn_id,
            payload: Some(amux::envelope::Payload::AcpEvent(acp_event)),
        };

        if !is_ambient {
            self.history.append(agent_id, &envelope);
        }
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    /// Enforce the one-live-runtime-per-session invariant at message-routing
    /// time. If multiple handles leaked into memory (race, stale resume, etc.),
    /// keep the newest and stop the rest before fanning out a prompt.
    async fn coalesce_session_runtimes(&mut self, session_id: &str) -> Vec<String> {
        let ids = self.agents.lock().await.runtime_ids_for_session(session_id);
        if ids.len() <= 1 {
            return ids;
        }
        let keep = self
            .agents
            .lock()
            .await
            .newest_runtime_id_for_session(session_id);
        let Some(keep) = keep else {
            return ids;
        };
        let superseded: Vec<String> = ids.into_iter().filter(|id| id != &keep).collect();
        warn!(
            session_id = %session_id,
            keep = %keep,
            superseded = ?superseded,
            "coalesce_session_runtimes: stopping duplicate live runtimes before fanout"
        );
        for rid in &superseded {
            self.agents.lock().await.stop_agent(rid).await;
            if let Some(s) = self.sessions.find_by_id_mut(rid) {
                s.status = amux::AgentStatus::Stopped as i32;
            }
        }
        if !superseded.is_empty() {
            let _ = self.sessions.save(&self.sessions_path);
        }
        vec![keep]
    }

    /// Route an inbound `message.created` from `session/{sid}/live` to the
    /// appropriate runtimes: mentioned runtimes receive a real prompt (which
    /// flushes any queued silent context first); un-mentioned runtimes have
    /// the message appended to `pending_silent` for delivery on next mention.
    ///
    /// Self-authored messages (i.e. sent by this daemon's own actor_id) are
    /// silently dropped to prevent feedback loops.
    async fn route_session_message(
        &mut self,
        session_id: &str,
        message: &crate::proto::teamclaw::Message,
        mention_actor_ids: &[String],
    ) {
        // Skip messages this daemon authored — those are the agent reply we
        // just emitted; routing them back into our own runtimes would loop.
        if message.sender_actor_id == self.actor_id {
            return;
        }

        let runtime_ids = self.coalesce_session_runtimes(session_id).await;
        if runtime_ids.is_empty() {
            if self
                .resume_historical_runtimes_for_session(session_id)
                .await
            {
                return;
            }

            let runtime_ids = self.coalesce_session_runtimes(session_id).await;
            if !runtime_ids.is_empty() {
                self.route_session_message_to_runtimes(
                    session_id,
                    message,
                    mention_actor_ids,
                    runtime_ids,
                )
                .await;
                return;
            }

            // We're subscribed to session/{sid}/live but have no runtime
            // for it and no resumable historical runtime on disk. The daemon
            // cannot infer worktree/backend session details from the live
            // message alone, so this message cannot be routed locally.
            warn!(
                session_id = %session_id,
                message_id = %message.message_id,
                sender_actor_id = %message.sender_actor_id,
                "route_session_message: no runtime for session; dropping message"
            );
            return;
        }

        self.route_session_message_to_runtimes(session_id, message, mention_actor_ids, runtime_ids)
            .await;
    }

    async fn route_session_message_to_runtimes(
        &mut self,
        session_id: &str,
        message: &crate::proto::teamclaw::Message,
        mention_actor_ids: &[String],
        runtime_ids: Vec<String>,
    ) {
        use crate::runtime::PendingMessage;

        if message.sender_actor_id == self.actor_id {
            return;
        }

        // Single dedup gate for ALL ingestion paths. A freshly-sent message
        // reaches the daemon twice — once via live MQTT `message.created` and
        // once via the runtimeStart→catchup replay (it is already persisted by
        // the time the client fires runtimeStart). Both funnel through this
        // sink, so deduping here (keyed by message_id) guarantees each message
        // is prompted/queued exactly once regardless of which path wins the
        // race. Cross-restart dedup relies on `last_processed_message_id` and
        // catchup reconcile (see `reconcile_runtime_cursor`), not this cache.
        if !message.message_id.is_empty() {
            if let Some(tc) = self.teamclaw.as_mut() {
                if !tc.should_process_message(session_id, &message.message_id) {
                    debug!(
                        session_id = %session_id,
                        message_id = %message.message_id,
                        "route_session_message: already processed; skipping (dedup gate)"
                    );
                    return;
                }
            }
        }

        let sender_display = self
            .display_name_for_actor(&message.sender_actor_id)
            .unwrap_or_else(|| message.sender_actor_id.chars().take(8).collect());

        // Each runtime in this list belongs to this daemon, so a mention of
        // this daemon's actor engages the runtime. The handle's `agent_id`
        // is the 8-char runtime key (per CLAUDE.md glossary), NOT the actor
        // id that mention_actor_ids encodes — matching against it would
        // never hit and every message would fall through to silent queue.
        let mentioned_actor = mention_actor_ids.iter().any(|m| m == &self.actor_id);
        if mention_actor_ids.is_empty() {
            warn!(
                message_id = %message.message_id,
                daemon_actor_id = %self.actor_id,
                "route_session_message: empty mention_actor_ids; message will be silent-queued"
            );
        } else if !mentioned_actor {
            debug!(
                message_id = %message.message_id,
                daemon_actor_id = %self.actor_id,
                mention_actor_ids = ?mention_actor_ids,
                "route_session_message: mention_actor_ids present but not this daemon; silent-queued"
            );
        }
        let attachment_urls = message_attachment_urls(message);
        for runtime_id in runtime_ids {
            if self.agents.lock().await.agent_id_of(&runtime_id).is_none() {
                continue;
            }
            let mentioned = mentioned_actor;

            if mentioned {
                let prompt_body = message.content.trim();
                if prompt_body.is_empty() && attachment_urls.is_empty() {
                    warn!(
                        runtime_id = %runtime_id,
                        message_id = %message.message_id,
                        "route_session_message: mentioned but empty content; skipping send_prompt"
                    );
                    continue;
                }
                info!(
                    runtime_id = %runtime_id,
                    message_id = %message.message_id,
                    mention_actor_ids = ?mention_actor_ids,
                    "route_session_message: @ mention matched; sending prompt"
                );
                // Real prompt — flush_pending_silent inside send_prompt does the prefix work.
                info!(
                    runtime_id = %runtime_id,
                    message_id = %message.message_id,
                    session_id = %session_id,
                    "route_session_message: delivering mentioned prompt to runtime"
                );
                if let Some(desired_model) = session_message_model_override(message) {
                    let current_model = self
                        .agents
                        .lock()
                        .await
                        .current_model(&runtime_id)
                        .cloned()
                        .unwrap_or_default();
                    if desired_model != current_model {
                        let mut agents = self.agents.lock().await;
                        match agents.send_set_model(&runtime_id, &desired_model).await {
                            Ok(()) => {
                                agents.set_current_model(&runtime_id, &desired_model);
                            }
                            Err(e) => {
                                warn!(
                                    runtime_id = %runtime_id,
                                    message_id = %message.message_id,
                                    model_id = %desired_model,
                                    err = %e,
                                    "route_session_message: send_set_model failed"
                                );
                            }
                        }
                    }
                }
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(
                        &runtime_id,
                        message.content.as_str(),
                        attachment_urls.clone(),
                    )
                    .await;
                let _drained = match send_res {
                    Ok(d) => {
                        info!(
                            runtime_id = %runtime_id,
                            message_id = %message.message_id,
                            drained_silent = d.len(),
                            "route_session_message: send_prompt ok"
                        );
                        d
                    }
                    Err(e) => {
                        warn!(runtime_id = %runtime_id, err = ?e, "send_prompt failed");
                        continue;
                    }
                };

                self.persist_runtime_cursor(&runtime_id, &message.message_id)
                    .await;
            } else {
                // Silent: queue for next real prompt.
                {
                    let mut agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle_mut(&runtime_id) {
                        handle.pending_silent.push(PendingMessage {
                            message_id: message.message_id.clone(),
                            sender_display: sender_display.clone(),
                            content: message.content.clone(),
                            created_at: message.created_at,
                        });
                    }
                }
                self.persist_runtime_cursor(&runtime_id, &message.message_id)
                    .await;
            }
        }
    }

    /// Advance in-memory cursor immediately; persist to Cloud in the background.
    async fn persist_runtime_cursor(&self, runtime_id: &str, message_id: &str) {
        if message_id.is_empty() {
            return;
        }
        {
            let mut agents = self.agents.lock().await;
            agents.advance_message_cursor(runtime_id, message_id);
        }
        let row_id = self.agents.lock().await.backend_runtime_row_id(runtime_id);
        if let Some(row_id) = row_id {
            let backend = self.backend.clone();
            let message_id = message_id.to_string();
            let runtime_id = runtime_id.to_string();
            tokio::spawn(async move {
                if let Err(e) = backend.update_runtime_cursor(&row_id, &message_id).await {
                    warn!(?e, runtime_id, "update_runtime_cursor failed");
                }
            });
        }
    }

    /// Align in-memory and persisted cursor with messages that already have an
    /// agent reply, so catchup does not re-prompt completed @mentions.
    ///
    /// Returns the full session message list when fetch succeeds so
    /// [`Self::catchup_runtime`] can slice locally instead of refetching.
    async fn reconcile_runtime_cursor(
        &mut self,
        runtime_id: &str,
    ) -> Option<Vec<crate::backend::StoredMessage>> {
        let (session_id, floor) = {
            let agents = self.agents.lock().await;
            let h = agents.get_handle(runtime_id)?;
            (h.session_id.clone(), h.last_processed_message_id.clone())
        };
        if session_id.is_empty() {
            return None;
        }

        let messages = match self.backend.messages_after_cursor(&session_id, None).await {
            Ok(m) => m,
            Err(e) => {
                warn!(
                    ?e,
                    runtime_id, "reconcile_runtime_cursor: messages fetch failed"
                );
                return None;
            }
        };
        if messages.is_empty() {
            return None;
        }

        let floor = floor.as_deref().filter(|s| !s.is_empty());
        let effective = compute_effective_cursor_from_messages(&messages, &self.actor_id, floor);
        if let Some(id) = effective {
            info!(
                runtime_id,
                cursor = %id,
                "reconcile_runtime_cursor: advanced from message history"
            );
            self.persist_runtime_cursor(runtime_id, &id).await;
        }
        Some(messages)
    }

    fn mark_superseded_runtime_rows_stopped(&mut self, superseded: &[String]) {
        for runtime_id in superseded {
            if let Some(s) = self.sessions.find_by_id_mut(runtime_id) {
                s.status = amux::AgentStatus::Stopped as i32;
            }
        }
        if !superseded.is_empty() {
            let _ = self.sessions.save(&self.sessions_path);
        }
    }

    /// Replay any session messages that arrived before this runtime was spawned.
    ///
    /// Fetches all messages after the runtime's `last_processed_message_id`
    /// cursor (None → fetch all) and routes each through the no-resume message
    /// router so live and catchup share identical semantics (mentioned → real
    /// prompt, un-mentioned → pending_silent queue).
    ///
    /// **Stale-mention compaction** (offline-replay-specific): when the
    /// daemon comes back online after missing N messages, only the *last*
    /// `@daemon` mention in the replay slice triggers a fresh turn — earlier
    /// `@daemon` rows are compacted into `pending_silent` even though they
    /// nominally mention us.
    pub async fn catchup_runtime(&mut self, runtime_id: &str) -> bool {
        let session_id = {
            let agents = self.agents.lock().await;
            let Some(h) = agents.get_handle(runtime_id) else {
                return false;
            };
            h.session_id.clone()
        };
        if session_id.is_empty() {
            return false;
        }

        let reconciled_all = self.reconcile_runtime_cursor(runtime_id).await;

        let last_processed_message_id = self
            .agents
            .lock()
            .await
            .get_handle(runtime_id)
            .and_then(|h| h.last_processed_message_id.clone());

        let messages = if let Some(all) = reconciled_all {
            messages_strictly_after_cursor(&all, last_processed_message_id.as_deref())
        } else {
            match self
                .backend
                .messages_after_cursor(&session_id, last_processed_message_id.as_deref())
                .await
            {
                Ok(m) => m,
                Err(e) => {
                    warn!(?e, runtime_id, "catchup messages_after_cursor failed");
                    return false;
                }
            }
        };
        if messages.is_empty() {
            return false;
        }

        let my_actor = self.actor_id.clone();
        if !slice_has_actionable_inbound(&messages, &my_actor) {
            debug!(
                runtime_id,
                session_id = %session_id,
                "catchup_runtime: no actionable inbound messages after reconcile"
            );
            return false;
        }

        // Only the last *unanswered* @mention triggers a real prompt; earlier
        // @-mentions (including already-answered ones) are silent context.
        let last_mention_idx = last_unanswered_mention_idx(&messages, &my_actor);

        info!(
            runtime_id,
            count = messages.len(),
            last_mention_idx,
            "catching up runtime"
        );

        for (idx, m) in messages.iter().enumerate() {
            if self.agents.lock().await.get_handle(runtime_id).is_none() {
                warn!(
                    runtime_id,
                    session_id, "catchup found no runtime after resume"
                );
                return false;
            }
            let mention_ids = parse_mention_actor_ids(&m.metadata_json);
            let proto = crate::proto::teamclaw::Message {
                message_id: m.id.clone(),
                session_id: m.session_id.clone(),
                sender_actor_id: m.sender_actor_id.clone(),
                kind: 0,
                content: m.content.clone(),
                created_at: m.created_at,
                ..Default::default()
            };
            let effective_mentions: &[String] = if Some(idx) == last_mention_idx {
                &mention_ids
            } else {
                &[]
            };
            self.route_session_message_to_runtimes(
                &session_id,
                &proto,
                effective_mentions,
                vec![runtime_id.to_string()],
            )
            .await;
        }
        true
    }

    /// Look up a display name for an actor_id from the in-memory peer tracker.
    /// Returns `None` if the actor is unknown; the caller falls back to the
    /// first 8 chars of the actor_id.
    fn display_name_for_actor(&self, actor_id: &str) -> Option<String> {
        // PeerTracker is keyed by peer_id (session-scoped), not actor_id.
        // Search linearly for a matching member_id / peer entry.
        // If no match is found, return None and let the caller use the fallback.
        self.peers
            .get_peer(actor_id)
            .map(|p| p.display_name.clone())
    }

    /// Single sink for agent-originated envelopes. Fans out to
    /// `session/{sid}/live` for every session the agent is bound to.
    /// Returns silently when the agent has no session — every iOS
    /// session is session-backed today, so a bound-less agent is a
    /// legacy bare-runtime spawn whose `runtime/{rid}/events` topic
    /// has no subscriber. Logs a warn so it shows up if regression
    /// reintroduces session-less spawns.
    async fn publish_envelope_to_sessions(&self, agent_id: &str, envelope: &amux::Envelope) {
        let Some(tc) = self.teamclaw.as_ref() else {
            warn!(agent_id, "no teamclaw client; dropping envelope");
            return;
        };
        let sessions = self.target_sessions(agent_id).await;
        if sessions.is_empty() {
            warn!(agent_id, "agent has no bound session; dropping envelope");
            return;
        }
        let actor_id = self.actor_id.clone();
        for sid in &sessions {
            tc.publish_agent_acp_event(sid, &actor_id, envelope).await;
        }
    }

    /// Returns the primary (first running) agent ID for this daemon.
    /// Used to stamp new sessions with the host's agent without passing
    /// RuntimeManager into SessionManager.
    async fn primary_agent_id(&self) -> Option<String> {
        self.agents.lock().await.first_running_agent_id()
    }

    async fn runtime_id_for_agent_actor_in_session(
        &self,
        agent_actor_id: &str,
        session_id: &str,
    ) -> Option<String> {
        let agents = self.agents.lock().await;
        if agents.get_handle(agent_actor_id).is_some() {
            return Some(agent_actor_id.to_string());
        }
        if agent_actor_id == self.backend.actor_id() {
            return agents.running_agent_id_for_collab_session(session_id);
        }
        None
    }

    /// Server-level RPC dispatch. Decodes the wire payload, matches on Method,
    /// delegates session/idea methods to SessionManager, and handles non-session
    /// methods locally. Publishes the response to the sender's rpc/res topic.
    async fn handle_rpc_request(&mut self, topic: &str, payload: &[u8]) {
        use crate::proto::teamclaw::{rpc_request::Method, RpcRequest, RpcResponse};
        use prost::Message as ProstMessage;

        let request = match RpcRequest::decode(payload) {
            Ok(r) => r,
            Err(e) => {
                warn!(%topic, "failed to decode RpcRequest: {}", e);
                return;
            }
        };

        let response: RpcResponse = match &request.method {
            // ─── Session/idea methods — delegate to SessionManager ───
            Some(Method::CreateSession(_))
            | Some(Method::FetchSession(_))
            | Some(Method::FetchSessionMessages(_))
            | Some(Method::JoinSession(_))
            | Some(Method::AddParticipant(_))
            | Some(Method::RemoveParticipant(_))
            | Some(Method::CreateIdea(_))
            | Some(Method::ClaimIdea(_))
            | Some(Method::SubmitIdea(_))
            | Some(Method::UpdateIdea(_)) => {
                // Pre-compute primary before the mutable borrow of self.teamclaw.
                let primary = self.primary_agent_id().await;
                if let Some(tc) = self.teamclaw.as_mut() {
                    tc.handle_rpc_method(request.clone(), primary).await
                } else {
                    not_yet_implemented(&request, "session_manager not initialized")
                }
            }
            // ─── Non-session methods — handle locally ───
            // Phase 1b Ideas 3-9 replace these stubs with real handlers.
            Some(Method::FetchPeers(_)) => self.handle_fetch_peers(&request).await,
            Some(Method::FetchWorkspaces(_)) => self.handle_fetch_workspaces(&request).await,
            Some(Method::AnnouncePeer(ann)) => self.handle_announce_peer(&request, ann).await,
            Some(Method::DisconnectPeer(d)) => self.handle_disconnect_peer(&request, d).await,
            Some(Method::AddWorkspace(a)) => self.handle_add_workspace(&request, a).await,
            Some(Method::RemoveWorkspace(r)) => self.handle_remove_workspace(&request, r).await,
            Some(Method::RemoveMember(r)) => self.handle_remove_member(&request, r).await,
            Some(Method::RuntimeStop(s)) => self.handle_stop_runtime(&request, s).await,
            Some(Method::RuntimeStart(s)) => self.handle_start_runtime(&request, s).await,
            Some(Method::SetModel(s)) => self.handle_set_model(&request, s).await,
            None => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: "no method".to_string(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: None,
            },
        };

        // Publish response on the requester's rpc/res topic (mirrors
        // RpcServer::respond). The requester subscribes on its own actor
        // namespace `amux/{team}/{actor}/rpc/res`.
        let res_topic = self.topics.rpc_res_for(&request.requester_actor_id);
        let bytes = response.encode_to_vec();
        info!(
            request_id = %request.request_id,
            res_topic = %res_topic,
            success = response.success,
            "publishing RpcResponse"
        );
        if let Err(e) = self
            .mqtt
            .client
            .publish(res_topic, rumqttc::QoS::AtLeastOnce, false, bytes)
            .await
        {
            warn!("failed to publish RpcResponse: {}", e);
        }
    }

    fn session_title_for_log(&self, session_id: &str) -> String {
        self.teamclaw
            .as_ref()
            .and_then(|tc| tc.sessions.find_by_id(session_id))
            .map(|session| session.title.trim())
            .filter(|title| !title.is_empty())
            .unwrap_or("<unknown>")
            .to_string()
    }

    async fn handle_incoming(&mut self, msg: subscriber::IncomingMessage) {
        use prost::Message as ProstMessage;
        match msg {
            subscriber::IncomingMessage::RuntimeCommand {
                runtime_id,
                envelope,
            } => {
                self.handle_agent_command(&runtime_id, envelope).await;
            }
            subscriber::IncomingMessage::TeamclawRpc { topic, payload } => {
                self.handle_rpc_request(&topic, &payload).await;
            }
            subscriber::IncomingMessage::TeamclawSessionLive {
                session_id,
                payload,
            } => {
                let session_title = self.session_title_for_log(&session_id);
                let daemon_config_actor_id = self.config.actor.id.as_str();
                let daemon_actor_id = self.actor_id.as_str();
                let daemon_team_id = self.config.team_id.as_deref().unwrap_or("<none>");
                info!(
                    session_id = %session_id,
                    session_title = %session_title,
                    daemon_config_actor_id = %daemon_config_actor_id,
                    daemon_actor_id = %daemon_actor_id,
                    daemon_team_id = %daemon_team_id,
                    payload_bytes = payload.len(),
                    "session/live message received"
                );
                let envelope_res =
                    crate::proto::teamclaw::LiveEventEnvelope::decode(payload.as_slice());
                if let Err(e) = &envelope_res {
                    warn!(
                        session_id = %session_id,
                        session_title = %session_title,
                        daemon_config_actor_id = %daemon_config_actor_id,
                        daemon_actor_id = %daemon_actor_id,
                        daemon_team_id = %daemon_team_id,
                        err = %e,
                        "LiveEventEnvelope decode FAILED"
                    );
                }
                if let Ok(envelope) = envelope_res {
                    info!(
                        session_id = %session_id,
                        session_title = %session_title,
                        daemon_config_actor_id = %daemon_config_actor_id,
                        daemon_actor_id = %daemon_actor_id,
                        daemon_team_id = %daemon_team_id,
                        event_type = %envelope.event_type,
                        event_id = %envelope.event_id,
                        body_bytes = envelope.body.len(),
                        "LiveEventEnvelope decoded"
                    );
                    match envelope.event_type.as_str() {
                        "message.created" => {
                            let env = match crate::proto::teamclaw::SessionMessageEnvelope::decode(
                                envelope.body.as_slice(),
                            ) {
                                Ok(e) => e,
                                Err(e) => {
                                    warn!(
                                        session_id = %session_id,
                                        session_title = %session_title,
                                        daemon_config_actor_id = %daemon_config_actor_id,
                                        daemon_actor_id = %daemon_actor_id,
                                        daemon_team_id = %daemon_team_id,
                                        err = %e,
                                        "SessionMessageEnvelope decode failed"
                                    );
                                    return;
                                }
                            };
                            let Some(msg) = env.message.as_ref() else {
                                warn!(
                                    session_id = %session_id,
                                    session_title = %session_title,
                                    daemon_config_actor_id = %daemon_config_actor_id,
                                    daemon_actor_id = %daemon_actor_id,
                                    daemon_team_id = %daemon_team_id,
                                    "SessionMessageEnvelope without inner message; dropping"
                                );
                                return;
                            };
                            // Dedup is enforced centrally in
                            // `route_session_message_to_runtimes` (the single
                            // routing sink) so the live path and the
                            // catchup-replay path share one message_id gate and
                            // a freshly-sent message can't be prompted twice.
                            self.route_session_message(
                                &session_id,
                                msg,
                                &resolve_mention_actor_ids(
                                    &env.mention_actor_ids,
                                    &msg.metadata_json,
                                ),
                            )
                            .await;
                        }
                        "idea.created" | "idea.updated" => {
                            if let Ok(event) =
                                crate::proto::teamclaw::IdeaEvent::decode(envelope.body.as_slice())
                            {
                                if let Some(tc) = &mut self.teamclaw {
                                    if !tc.should_process_idea_event(&session_id, &event) {
                                        return;
                                    }
                                }
                                if let Some(tc) = &self.teamclaw {
                                    let activated =
                                        tc.agents_to_activate_for_idea(&session_id, &event);
                                    for agent_actor_id in activated {
                                        if let Some(runtime_id) = self
                                            .runtime_id_for_agent_actor_in_session(
                                                &agent_actor_id,
                                                &session_id,
                                            )
                                            .await
                                        {
                                            let prompt = format_idea_prompt(&session_id, &event);
                                            if !prompt.is_empty() {
                                                let send_res = self
                                                    .agents
                                                    .lock()
                                                    .await
                                                    .send_prompt(&runtime_id, &prompt, vec![])
                                                    .await;
                                                if let Err(e) = send_res {
                                                    warn!(
                                                        "Failed to route live idea to agent {} runtime {}: {}",
                                                        agent_actor_id, runtime_id, e
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            subscriber::IncomingMessage::TeamclawNotify { actor_id, payload } => {
                match crate::proto::teamclaw::Notify::decode(payload.as_slice()) {
                    Ok(n) => {
                        if n.event_type == "membership.refresh" && !n.refresh_hint.is_empty() {
                            match self
                                .backend
                                .fetch_session_with_participants(&n.refresh_hint)
                                .await
                            {
                                Ok(snap) => {
                                    if let Some(tc) = &mut self.teamclaw {
                                        if let Err(err) = tc
                                            .insert_session_from_backend(
                                                &snap.session,
                                                &snap.participants,
                                            )
                                            .await
                                        {
                                            warn!(
                                                ?err,
                                                actor_id = %actor_id,
                                                session_id = %n.refresh_hint,
                                                "failed to ingest cloud session after membership.refresh notify"
                                            );
                                        }
                                    }
                                }
                                Err(err) => {
                                    warn!(
                                        ?err,
                                        actor_id = %actor_id,
                                        session_id = %n.refresh_hint,
                                        "failed to fetch cloud session after membership.refresh notify"
                                    );
                                }
                            }
                        }
                    }
                    Err(err) => {
                        warn!(?err, "failed to decode actor notify payload as Notify");
                    }
                }
            }
        }
    }

    /// Derive the caller's MemberRole via a cloud `agent_member_access`
    /// lookup keyed on (our own agent actor id, envelope's sender_actor_id).
    /// the cloud backend is the sole source of truth — on any failure (RPC error,
    /// missing sender_actor_id) the caller is denied (`Member` is the safe
    /// no-op level). Previous versions fell back to a `peer_id` token-prefix
    /// scrape against members.toml, which let anyone who guessed a 6-char
    /// prefix masquerade as a member during a cloud backend outage; that path
    /// is gone.
    async fn resolve_role(&mut self, sender_actor_id: &str, _peer_id: &str) -> amux::MemberRole {
        if sender_actor_id.is_empty() {
            warn!("resolve_role: empty sender_actor_id, denying as Member");
            return amux::MemberRole::Member;
        }
        let sb = &self.backend;
        let my_agent_id = sb.actor_id().to_string();
        match sb
            .check_agent_permission(&my_agent_id, sender_actor_id)
            .await
        {
            Ok(Some(level)) => match level.as_str() {
                "admin" => amux::MemberRole::Owner,
                _ => amux::MemberRole::Member,
            },
            Ok(None) => {
                warn!(actor_id = %sender_actor_id, "no agent_member_access grant");
                amux::MemberRole::Member
            }
            Err(e) => {
                warn!(%e, actor_id = %sender_actor_id, "cloud permission check failed; denying");
                amux::MemberRole::Member
            }
        }
    }

    async fn handle_agent_command(
        &mut self,
        agent_id: &str,
        envelope: amux::RuntimeCommandEnvelope,
    ) {
        let peer_id = envelope.peer_id.clone();
        let command_id = envelope.command_id.clone();
        let sender_actor_id = envelope.sender_actor_id.clone();
        let reply_actor_id = if envelope.reply_to_actor_id.is_empty() {
            envelope.actor_id.clone()
        } else {
            envelope.reply_to_actor_id.clone()
        };

        let acp_command = match envelope.acp_command {
            Some(c) => c,
            None => return,
        };
        let cmd = match acp_command.command {
            Some(c) => c,
            None => return,
        };

        // Permission check.
        // Preferred path: iOS sets `sender_actor_id` on the envelope, daemon
        // looks up `agent_member_access.permission_level` via the cloud backend and
        // reduces that to a MemberRole. Legacy path: fall back to the
        // peer's MQTT-era role when the cloud backend lookup is unavailable.
        let role = self.resolve_role(&sender_actor_id, &peer_id).await;

        if let Err(reason) = self.permissions.check_command_permission(role, &cmd) {
            warn!(
                peer_id,
                reply_actor_id = %reply_actor_id,
                command_id = %command_id,
                %reason,
                "command rejected; legacy collab NACK no longer published"
            );
            return;
        }

        match cmd {
            amux::acp_command::Command::StartAgent(start) => {
                let requested =
                    amux::AgentType::try_from(start.agent_type).unwrap_or(amux::AgentType::Unknown);
                let at = resolve_requested_agent_type(&self.config, requested);

                info!(
                    workspace_id = %start.workspace_id,
                    worktree = %start.worktree,
                    peer_id,
                    "received startAgent envelope"
                );

                let outcome = self
                    .apply_start_runtime(
                        at,
                        &start.workspace_id,
                        &start.worktree,
                        &start.session_id,
                        &start.initial_prompt,
                        None,
                    )
                    .await;

                match outcome {
                    Ok(res) => {
                        info!(
                            agent_id = %res.runtime_id,
                            peer_id,
                            reply_actor_id = %reply_actor_id,
                            command_id = %command_id,
                            session_id = %res.session_id,
                            "agent started; legacy collab AgentStartResult no longer published"
                        );
                    }
                    Err(err) => {
                        let reason = err.error_message.clone();
                        error!(
                            peer_id,
                            reply_actor_id = %reply_actor_id,
                            command_id = %command_id,
                            session_id = %start.session_id,
                            "startAgent failed: {}; legacy collab AgentStartResult no longer published",
                            reason
                        );
                    }
                }
            }

            amux::acp_command::Command::StopAgent(_) => {
                let stopped = self
                    .agents
                    .lock()
                    .await
                    .stop_agent(agent_id)
                    .await
                    .is_some();
                if stopped {
                    if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                        session.status = amux::AgentStatus::Stopped as i32;
                        let _ = self.sessions.save(&self.sessions_path);
                    }
                    self.publish_runtime_state_by_id(agent_id).await;
                    info!(agent_id, peer_id, "agent stopped");
                }
            }

            amux::acp_command::Command::SendPrompt(prompt) => {
                // Lazy resume: if agent is not live but exists in session store,
                // spawn a new ACP process and resume the session.
                let needs_resume = self.agents.lock().await.get_handle(agent_id).is_none();
                if needs_resume {
                    if let Some(stored) = self.sessions.find_by_id(agent_id) {
                        let at = amux::AgentType::try_from(stored.agent_type)
                            .unwrap_or(amux::AgentType::ClaudeCode);
                        let worktree = stored.worktree.clone();
                        let ws_id = stored.workspace_id.clone();
                        let acp_sid = stored.acp_session_id.clone();
                        let session_id = stored.session_id.clone();
                        info!(agent_id, "lazy-resuming historical session");
                        let remote_workspace_id =
                            self.workspaces.find_by_id(&ws_id).and_then(|w| {
                                (!w.remote_workspace_id.is_empty())
                                    .then_some(w.remote_workspace_id.clone())
                            });
                        self.suppress_internal_opencode_writes(&worktree);
                        let runtime_env = match self
                            .assemble_spawn_runtime_env_for_worktree(&worktree, &ws_id)
                        {
                            Ok(env) => env,
                            Err(e) => {
                                warn!(
                                    agent_id,
                                    worktree = %worktree,
                                    error = %e,
                                    "lazy-resume: assemble runtime env failed; continuing with empty env"
                                );
                                crate::runtime::SpawnRuntimeEnv::default()
                            }
                        };
                        let resume_res = self
                            .agents
                            .lock()
                            .await
                            .resume_agent(
                                agent_id,
                                &acp_sid,
                                at,
                                &worktree,
                                &ws_id,
                                remote_workspace_id.as_deref(),
                                (!session_id.is_empty()).then_some(session_id.as_str()),
                                &prompt.text,
                                runtime_env,
                            )
                            .await;
                        match resume_res {
                            Ok(new_acp_sid) => {
                                // Forward model_id if the client requested one
                                let desired_model = prompt.model_id.clone();
                                if !desired_model.is_empty() {
                                    let mut agents = self.agents.lock().await;
                                    match agents.send_set_model(agent_id, &desired_model).await {
                                        Ok(()) => {
                                            agents.set_current_model(agent_id, &desired_model);
                                        }
                                        Err(e) => {
                                            warn!(agent_id, model_id = %desired_model, "set_model after resume failed: {}", e);
                                        }
                                    }
                                }
                                // Update stored session with potentially new acp_session_id
                                if let Some(s) = self.sessions.find_by_id_mut(agent_id) {
                                    s.acp_session_id = new_acp_sid;
                                    s.session_id = session_id.clone();
                                    s.status = amux::AgentStatus::Active as i32;
                                    s.last_prompt = prompt.text.clone();
                                }
                                let _ = self.sessions.save(&self.sessions_path);
                                info!(agent_id, peer_id, "session resumed, prompt sent");
                                self.publish_session_event(
                                    agent_id,
                                    amux::SessionEvent {
                                        event: Some(amux::session_event::Event::PromptAccepted(
                                            amux::PromptAccepted { command_id },
                                        )),
                                    },
                                )
                                .await;
                                self.publish_runtime_state_by_id(agent_id).await;
                            }
                            Err(e) => {
                                warn!(agent_id, "lazy resume failed: {}", e);
                                self.publish_session_event(
                                    agent_id,
                                    amux::SessionEvent {
                                        event: Some(amux::session_event::Event::PromptRejected(
                                            amux::PromptRejected {
                                                command_id,
                                                reason: format!("session resume failed: {}", e),
                                            },
                                        )),
                                    },
                                )
                                .await;
                            }
                        }
                        return;
                    }
                }

                // Check busy
                let busy_reject: Option<String> = {
                    let agents = self.agents.lock().await;
                    if let Some(handle) = agents.get_handle(agent_id) {
                        self.permissions.check_agent_busy(handle.status).err()
                    } else {
                        None
                    }
                };
                if let Some(reason) = busy_reject {
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PromptRejected(
                                amux::PromptRejected { command_id, reason },
                            )),
                        },
                    )
                    .await;
                    return;
                }

                // If the client requested a specific model and it differs from
                // the one we last applied, forward a SetModel command before
                // the prompt so the new turn runs on the requested model.
                let desired_model = prompt.model_id.clone();
                let mut model_changed = false;
                if !desired_model.is_empty() {
                    let current = self
                        .agents
                        .lock()
                        .await
                        .current_model(agent_id)
                        .cloned()
                        .unwrap_or_default();
                    if desired_model != current {
                        let mut agents = self.agents.lock().await;
                        match agents.send_set_model(agent_id, &desired_model).await {
                            Ok(()) => {
                                agents.set_current_model(agent_id, &desired_model);
                                model_changed = true;
                            }
                            Err(e) => {
                                warn!(agent_id, model_id = %desired_model, "send_set_model failed: {}", e);
                            }
                        }
                    }
                }
                if model_changed {
                    self.publish_runtime_state_by_id(agent_id).await;
                }

                // Send prompt to agent (respawns if process exited)
                let send_res = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(agent_id, &prompt.text, prompt.attachment_urls.clone())
                    .await;
                match send_res {
                    Ok(_drained) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Active;
                                handle.current_prompt = prompt.text.clone();
                            }
                        }
                        if let Some(session) = self.sessions.find_by_id_mut(agent_id) {
                            session.last_prompt = prompt.text.clone();
                            let _ = self.sessions.save(&self.sessions_path);
                        }
                        info!(agent_id, peer_id, "prompt sent to agent");
                        self.publish_session_event(
                            agent_id,
                            amux::SessionEvent {
                                event: Some(amux::session_event::Event::PromptAccepted(
                                    amux::PromptAccepted { command_id },
                                )),
                            },
                        )
                        .await;
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to send prompt: {}", e);
                        self.publish_session_event(
                            agent_id,
                            amux::SessionEvent {
                                event: Some(amux::session_event::Event::PromptRejected(
                                    amux::PromptRejected {
                                        command_id,
                                        reason: format!("failed to send prompt: {}", e),
                                    },
                                )),
                            },
                        )
                        .await;
                    }
                }
            }

            amux::acp_command::Command::Cancel(_) => {
                let cancel_res = self.agents.lock().await.cancel_agent(agent_id).await;
                match cancel_res {
                    Ok(()) => {
                        {
                            let mut agents = self.agents.lock().await;
                            if let Some(handle) = agents.get_handle_mut(agent_id) {
                                handle.status = amux::AgentStatus::Idle;
                            }
                        }
                        info!(agent_id, peer_id, "agent cancelled via ACP");
                        self.publish_runtime_state_by_id(agent_id).await;
                    }
                    Err(e) => {
                        warn!(agent_id, "failed to cancel agent: {}", e);
                    }
                }
            }

            amux::acp_command::Command::GrantPermission(grant) => {
                let grant_option_id =
                    (!grant.option_id.is_empty()).then(|| grant.option_id.clone());
                if self.permissions.try_resolve_permission(&grant.request_id) {
                    // Resolve via ACP permission response
                    match self
                        .agents
                        .lock()
                        .await
                        .resolve_permission_for_topic(
                            agent_id,
                            &grant.request_id,
                            true,
                            grant_option_id,
                        )
                        .await
                    {
                        Ok(()) => {
                            info!(request_id = %grant.request_id, peer_id, agent_id, "permission granted via ACP");
                        }
                        Err(e) => {
                            warn!(
                                request_id = %grant.request_id,
                                peer_id,
                                agent_id,
                                error = %e,
                                "resolve_permission failed after grant; ACP may stay blocked"
                            );
                        }
                    }
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: grant.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: true,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::DenyPermission(deny) => {
                if self.permissions.try_resolve_permission(&deny.request_id) {
                    // Resolve via ACP permission response
                    match self
                        .agents
                        .lock()
                        .await
                        .resolve_permission_for_topic(agent_id, &deny.request_id, false, None)
                        .await
                    {
                        Ok(()) => {
                            info!(request_id = %deny.request_id, peer_id, agent_id, "permission denied via ACP");
                        }
                        Err(e) => {
                            warn!(
                                request_id = %deny.request_id,
                                peer_id,
                                agent_id,
                                error = %e,
                                "resolve_permission failed after deny"
                            );
                        }
                    }
                    self.publish_session_event(
                        agent_id,
                        amux::SessionEvent {
                            event: Some(amux::session_event::Event::PermissionResolved(
                                amux::PermissionResolved {
                                    request_id: deny.request_id,
                                    resolved_by_peer_id: peer_id,
                                    granted: false,
                                },
                            )),
                        },
                    )
                    .await;
                }
            }

            amux::acp_command::Command::RequestHistory(req) => {
                use prost::Message;
                let page_size = if req.page_size == 0 {
                    50
                } else {
                    req.page_size
                };
                let (mut events, mut has_more) =
                    self.history
                        .read_page(agent_id, req.after_sequence, page_size);

                // Keep history replies under a conservative 10 KB publish
                // budget. Trim the batch by estimated encoded length so we never
                // produce a publish the broker will reject (which otherwise
                // forces the daemon's MQTT client to reconnect and knocks
                // every iOS peer offline in a loop).
                const HISTORY_BATCH_BUDGET: usize = 9500;
                while events.len() > 1 {
                    let estimate: usize = events
                        .iter()
                        .map(|e| {
                            let n = e.encoded_len();
                            1 + prost::encoding::encoded_len_varint(n as u64) + n
                        })
                        .sum::<usize>()
                        + req.request_id.len()
                        + 32;
                    if estimate < HISTORY_BATCH_BUDGET {
                        break;
                    }
                    events.pop();
                    has_more = true;
                }

                let next_seq = events
                    .last()
                    .map(|e| e.sequence)
                    .unwrap_or(req.after_sequence);
                info!(
                    agent_id,
                    peer_id,
                    after_seq = req.after_sequence,
                    count = events.len(),
                    has_more,
                    "history requested"
                );
                let batch = amux::HistoryBatch {
                    request_id: req.request_id,
                    events,
                    has_more,
                    next_after_sequence: next_seq,
                };
                self.publish_session_event(
                    agent_id,
                    amux::SessionEvent {
                        event: Some(amux::session_event::Event::HistoryBatch(batch)),
                    },
                )
                .await;
            }

            amux::acp_command::Command::RequestTurnHistory(req) => {
                use prost::Message;
                let mut events = self.history.read_turn(agent_id, &req.turn_id);
                let mut has_more = false;

                // Same 10 KB publish budget as RequestHistory. Turns are
                // usually small (tens of events) so a single batch covers
                // them. If a turn ever grows past the budget, trim the tail
                // and set has_more — iOS sees a partial turn and the local
                // streaming cache fills the gap until we add per-turn
                // pagination.
                const HISTORY_BATCH_BUDGET: usize = 9500;
                while events.len() > 1 {
                    let estimate: usize = events
                        .iter()
                        .map(|e| {
                            let n = e.encoded_len();
                            1 + prost::encoding::encoded_len_varint(n as u64) + n
                        })
                        .sum::<usize>()
                        + req.request_id.len()
                        + 32;
                    if estimate < HISTORY_BATCH_BUDGET {
                        break;
                    }
                    events.pop();
                    has_more = true;
                }

                info!(
                    agent_id,
                    peer_id,
                    turn_id = %req.turn_id,
                    count = events.len(),
                    has_more,
                    "turn history requested"
                );
                let batch = amux::HistoryBatch {
                    request_id: req.request_id,
                    events,
                    has_more,
                    next_after_sequence: 0,
                };
                self.publish_session_event(
                    agent_id,
                    amux::SessionEvent {
                        event: Some(amux::session_event::Event::HistoryBatch(batch)),
                    },
                )
                .await;
            }
        }
    }

    /// Publish a session event (e.g. HistoryBatch reply) onto the same
    /// canonical sink as agent-originated envelopes. Reuses
    /// `publish_envelope_to_sessions` so HistoryBatch responses land on
    /// `session/{sid}/live` next to the streaming output that triggered
    /// them — iOS subscribes there exclusively.
    async fn publish_session_event(&self, agent_id: &str, event: amux::SessionEvent) {
        // Session-level events (HistoryBatch reply, etc.) are not part of an
        // ACP turn; leave turn_id empty. iOS does not dedupe session events
        // by turn anyway.
        let envelope = amux::Envelope {
            runtime_id: agent_id.into(),
            actor_id: self.config.actor.id.clone(),
            source_peer_id: String::new(),
            timestamp: chrono::Utc::now().timestamp(),
            sequence: 0,
            turn_id: String::new(),
            payload: Some(amux::envelope::Payload::SessionEvent(event)),
        };
        self.publish_envelope_to_sessions(agent_id, &envelope).await;
    }

    // ─── Non-session RPC handlers ───

    async fn handle_fetch_peers(
        &self,
        request: &crate::proto::teamclaw::RpcRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, FetchPeersResult, RpcResponse};

        let peers = self.peers.to_proto_peer_list().peers;
        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::FetchPeersResult(FetchPeersResult {
                peers,
            })),
        }
    }

    async fn handle_fetch_workspaces(
        &self,
        request: &crate::proto::teamclaw::RpcRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, FetchWorkspacesResult, RpcResponse};

        let workspaces = self.workspaces.to_proto_list().workspaces;
        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::FetchWorkspacesResult(
                FetchWorkspacesResult { workspaces },
            )),
        }
    }

    // ─── Peer mutation helpers (shared by legacy collab path + RPC handlers) ───

    /// Authenticates and adds a peer. Returns (accepted, error_text, assigned_role).
    /// Does NOT publish anything — the caller is responsible for any broadcasts
    /// (legacy collab arm republishes peer_list + workspace_list; RPC handler
    /// publishes Notify "peers.changed").
    async fn apply_peer_announce(
        &mut self,
        announce: &amux::PeerAnnounce,
    ) -> (bool, String, amux::MemberRole) {
        match self.auth.authenticate(&announce.auth_token) {
            AuthResult::Accepted { member } => {
                let role = if member.is_owner() {
                    amux::MemberRole::Owner
                } else {
                    amux::MemberRole::Member
                };
                let pi = announce.peer.as_ref();
                let peer_id_str = pi.map(|p| p.peer_id.clone()).unwrap_or_default();
                info!(peer_id = %peer_id_str, member_id = %member.member_id, "peer authenticated");
                self.peers.add_peer(PeerState {
                    peer_id: peer_id_str,
                    member_id: member.member_id.clone(),
                    display_name: member.display_name.clone(),
                    device_type: pi.map(|p| p.device_type.clone()).unwrap_or_default(),
                    role,
                    connected_at: chrono::Utc::now().timestamp(),
                });
                (true, String::new(), role)
            }
            AuthResult::Rejected { reason } => {
                warn!(%reason, "peer rejected");
                (false, reason, amux::MemberRole::Member)
            }
        }
    }

    /// Removes a peer by peer_id. Returns (accepted, error_text).
    /// Does NOT publish anything — the caller is responsible for any broadcasts.
    async fn apply_peer_disconnect(&mut self, peer_id: &str) -> (bool, String) {
        if self.peers.remove_peer(peer_id).is_some() {
            info!(peer_id, "peer disconnected");
            (true, String::new())
        } else {
            (false, format!("unknown peer_id: {}", peer_id))
        }
    }

    // ─── AnnouncePeer / DisconnectPeer RPC handlers ───

    async fn handle_announce_peer(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        announce: &crate::proto::teamclaw::AnnouncePeerRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, AnnouncePeerResult, RpcResponse};

        // Construct amux::PeerAnnounce that apply_peer_announce expects.
        let amux_announce = amux::PeerAnnounce {
            peer: announce.peer.clone(),
            auth_token: announce.auth_token.clone(),
        };
        let (accepted, error, assigned_role) = self.apply_peer_announce(&amux_announce).await;

        // Hint subscribers to re-fetch peers.
        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("peers.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::AnnouncePeerResult(
                AnnouncePeerResult {
                    accepted,
                    error,
                    assigned_role: assigned_role as i32,
                },
            )),
        }
    }

    async fn handle_disconnect_peer(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        disconnect: &crate::proto::teamclaw::DisconnectPeerRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, DisconnectPeerResult, RpcResponse};

        let (accepted, error) = self.apply_peer_disconnect(&disconnect.peer_id).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("peers.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::DisconnectPeerResult(
                DisconnectPeerResult { accepted, error },
            )),
        }
    }

    /// Stamp the daemon's team onto a freshly-added workspace so the
    /// team-share sweep can group + link it. `AddWorkspace` carries no
    /// team_id, so the daemon-level team is authoritative. Returns true if a
    /// team_id was set (caller should persist).
    fn stamp_daemon_team(&self, ws: &mut crate::config::StoredWorkspace) -> bool {
        match team_id_to_stamp(ws.team_id.as_deref(), self.config.team_id.as_deref()) {
            Some(team_id) => {
                ws.team_id = Some(team_id);
                true
            }
            None => false,
        }
    }

    /// Applies a workspace add. Returns (success, error_text, resulting_workspace_if_any).
    /// Caller publishes any collab event or Notify hint.
    async fn apply_add_workspace(
        &mut self,
        add: &amux::AddWorkspace,
    ) -> (bool, String, Option<amux::WorkspaceInfo>) {
        match self.workspaces.add(&add.path) {
            Ok(outcome) => {
                let mut ws = outcome.workspace;
                let mut should_save = outcome.inserted;
                if self.stamp_daemon_team(&mut ws) {
                    should_save = true;
                }
                if self.sync_workspace_to_cloud(&mut ws).await {
                    should_save = true;
                }
                if let Some(existing) = self
                    .workspaces
                    .workspaces
                    .iter_mut()
                    .find(|w| w.workspace_id == ws.workspace_id)
                {
                    *existing = ws.clone();
                }
                // Set as cloud + local default when:
                //   (a) newly inserted — always promote first workspace on
                //       a fresh daemon; OR
                //   (b) no local default is stored yet — covers the case
                //       where the user clicked "Set default" in the UI on an
                //       existing workspace; the UI calls addWorkspace to
                //       re-register the path, so we use the absence of a
                //       local default as the signal to persist it now.
                let needs_default =
                    outcome.inserted || self.workspaces.default_workspace_id.is_none();
                if needs_default && !ws.remote_workspace_id.is_empty() {
                    if let Err(e) = self
                        .backend
                        .set_agent_default_workspace(&ws.remote_workspace_id)
                        .await
                    {
                        warn!(
                            workspace_id = %ws.remote_workspace_id,
                            path = %ws.path,
                            "workspace default update failed: {}",
                            e
                        );
                    } else {
                        self.workspaces.set_default_workspace_id(&ws.workspace_id);
                        should_save = true;
                        info!(
                            workspace_id = %ws.remote_workspace_id,
                            path = %ws.path,
                            "workspace default set"
                        );
                    }
                }
                if should_save {
                    let _ = self.workspaces.save(&self.workspaces_path);
                }
                // On-demand link: a workspace bound to a team after the startup
                // sweep (the normal app flow) must materialize the global dir +
                // symlink now, not wait for the next daemon restart.
                if let Some(team_id) = ws.team_id.clone() {
                    let gate =
                        crate::team_link::team_share_gate(self.backend.as_ref(), &team_id).await;
                    crate::team_link::materialize_or_teardown(gate, &team_id, &ws.path);
                }
                if let Some(registry) = self.refresh_watch_registry.as_ref() {
                    registry
                        .upsert_workspace(
                            crate::runtime::refresh::refresh_watch::WatchedWorkspace {
                                workspace_id:
                                    crate::runtime::refresh::refresh_watch::workspace_runtime_id(
                                        Path::new(&ws.path),
                                    ),
                                workspace_path: PathBuf::from(&ws.path),
                            },
                        )
                        .await;
                }
                info!(workspace_id = %ws.workspace_id, path = %ws.path, "workspace added");
                let info = amux::WorkspaceInfo {
                    workspace_id: ws.workspace_id,
                    path: ws.path,
                    display_name: ws.display_name,
                };
                (true, String::new(), Some(info))
            }
            Err(e) => {
                warn!(path = %add.path, "add workspace failed: {}", e);
                (false, e.to_string(), None)
            }
        }
    }

    /// Register a workspace from the HTTP control plane (`POST /v1/workspaces`).
    /// Wraps `apply_add_workspace` (local registry + cloud upsert + default +
    /// team link, all idempotent) and publishes the same `workspaces.changed`
    /// notify as the MQTT/RPC path. Returns a JSON line for the reply channel.
    async fn handle_add_workspace_sock(&mut self, path: &str) -> String {
        let amux_add = amux::AddWorkspace {
            path: path.to_string(),
        };
        let (accepted, error, workspace) = self.apply_add_workspace(&amux_add).await;
        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
            serde_json::json!({
                "ok": true,
                "result": workspace.map(|w| serde_json::json!({
                    "workspace_id": w.workspace_id,
                    "path": w.path,
                    "display_name": w.display_name,
                })),
            })
            .to_string()
        } else {
            serde_json::json!({ "ok": false, "error": error }).to_string()
        }
    }

    /// Applies a workspace remove. Returns (success, error_text).
    async fn apply_remove_workspace(&mut self, remove: &amux::RemoveWorkspace) -> (bool, String) {
        let workspace_path = self
            .workspaces
            .find_by_id(&remove.workspace_id)
            .map(|workspace| PathBuf::from(&workspace.path));
        if self.workspaces.remove(&remove.workspace_id) {
            if let (Some(registry), Some(workspace_path)) = (
                self.refresh_watch_registry.as_ref(),
                workspace_path.as_deref(),
            ) {
                registry.remove_workspace_path(workspace_path).await;
            }
            let _ = self.workspaces.save(&self.workspaces_path);
            info!(workspace_id = %remove.workspace_id, "workspace removed");
            (true, String::new())
        } else {
            (
                false,
                format!("unknown workspace_id: {}", remove.workspace_id),
            )
        }
    }

    async fn handle_add_workspace(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        add: &crate::proto::teamclaw::AddWorkspaceRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, AddWorkspaceResult, RpcResponse};

        let amux_add = amux::AddWorkspace {
            path: add.path.clone(),
        };
        let (accepted, error, workspace) = self.apply_add_workspace(&amux_add).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::AddWorkspaceResult(
                AddWorkspaceResult {
                    accepted,
                    error,
                    workspace,
                },
            )),
        }
    }

    async fn handle_remove_workspace(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        remove: &crate::proto::teamclaw::RemoveWorkspaceRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RemoveWorkspaceResult, RpcResponse};

        let amux_remove = amux::RemoveWorkspace {
            workspace_id: remove.workspace_id.clone(),
        };
        let (accepted, error) = self.apply_remove_workspace(&amux_remove).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("workspaces.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RemoveWorkspaceResult(
                RemoveWorkspaceResult { accepted, error },
            )),
        }
    }

    /// Applies a member removal. Returns (success, error_text).
    /// Caller passes `requester_is_owner` because the two callers have
    /// different ways to establish it: legacy collab path looks up the
    /// peer's role via PeerTracker; RPC path looks up the requester_actor_id
    /// through AuthManager::is_owner.
    async fn apply_remove_member(
        &mut self,
        remove: &amux::RemoveMember,
        requester_is_owner: bool,
    ) -> (bool, String) {
        if !requester_is_owner {
            warn!(member_id = %remove.member_id, "remove rejected: not owner");
            return (false, "not owner".to_string());
        }
        match self.auth.remove_member(&remove.member_id) {
            Ok(true) => {
                let kicked = self.peers.remove_by_member_id(&remove.member_id);
                for p in &kicked {
                    info!(peer_id = %p.peer_id, "peer kicked");
                }
                (true, String::new())
            }
            Ok(false) => (false, format!("member not found: {}", remove.member_id)),
            Err(e) => (false, e.to_string()),
        }
    }

    async fn handle_remove_member(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        remove: &crate::proto::teamclaw::RemoveMemberRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RemoveMemberResult, RpcResponse};

        let amux_remove = amux::RemoveMember {
            member_id: remove.member_id.clone(),
        };
        // RPC carries requester identity in payload; resolve is_owner via
        // AuthManager, which is the source of truth for member roles.
        let is_owner = self.auth.is_owner(&request.requester_actor_id);
        let (accepted, error) = self.apply_remove_member(&amux_remove, is_owner).await;

        if accepted {
            let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
            let _ = publisher.publish_notify("members.changed", "").await;
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success: accepted,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RemoveMemberResult(
                RemoveMemberResult { accepted, error },
            )),
        }
    }

    /// Spawns a Claude Code subprocess and publishes lifecycle state
    /// transitions on the retained runtime state topic. Shared by legacy
    /// AcpCommand::StartAgent and RPC RuntimeStart handlers.
    ///
    /// Lifecycle publishes:
    ///   - STARTING (stage "spawning_process") published retained right after
    ///     spawn_agent returns the new runtime_id, before StoredSession upsert.
    ///   - ACTIVE published retained via publish_runtime_state_by_id after
    ///     StoredSession upsert (that call reads the now-populated RuntimeHandle).
    ///   - No FAILED publish here — spawn_agent error path returns before any
    ///     runtime_id is allocated, so there is no retained topic to write to.
    ///     Callers may surface the error via their wire envelope.
    ///
    /// Load a collab session + participants from the backend, cache them in
    /// the teamclaw session manager, and subscribe to `session/{sid}/live`.
    /// Idempotent — safe on every RuntimeStart, including dedup reuse.
    async fn ensure_collab_session_registered(
        &mut self,
        session_id: &str,
    ) -> Result<(), StartRuntimeError> {
        if session_id.is_empty() {
            return Ok(());
        }
        match self
            .backend
            .fetch_session_with_participants(session_id)
            .await
        {
            Ok(snap) => {
                if let Some(tc) = self.teamclaw.as_mut() {
                    if let Err(e) = tc
                        .insert_session_from_backend(&snap.session, &snap.participants)
                        .await
                    {
                        return Err(StartRuntimeError {
                            error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                            error_message: format!("insert_session_from_backend failed: {}", e),
                            failed_stage: "session_subscribe".to_string(),
                        });
                    }
                } else {
                    return Err(StartRuntimeError {
                        error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                        error_message:
                            "teamclaw session manager is not available for session runtime"
                                .to_string(),
                        failed_stage: "session_subscribe".to_string(),
                    });
                }
            }
            Err(e) => {
                return Err(StartRuntimeError {
                    error_code: "SESSION_LOOKUP_FAILED".to_string(),
                    error_message: format!("fetch_session_with_participants failed: {}", e),
                    failed_stage: "session_lookup".to_string(),
                });
            }
        }
        Ok(())
    }

    async fn apply_start_runtime(
        &mut self,
        agent_type: amux::AgentType,
        workspace_id: &str,
        worktree: &str,
        session_id: &str,
        initial_prompt: &str,
        initial_model_override: Option<String>,
    ) -> Result<StartRuntimeOutcome, StartRuntimeError> {
        info!(workspace_id, worktree, session_id, "apply_start_runtime");

        // Resolve workspace + worktree. Same 4-branch logic as the legacy
        // AcpCommand::StartAgent arm (see server.rs ~800-836 pre-refactor).
        let (mut resolved_worktree, mut ws_id, mut remote_workspace_id_owned): (
            String,
            String,
            Option<String>,
        ) = if !workspace_id.is_empty() {
            if let Some(ws) = self.workspaces.find_by_id(workspace_id) {
                (
                    ws.path.clone(),
                    ws.workspace_id.clone(),
                    (!ws.remote_workspace_id.is_empty()).then_some(ws.remote_workspace_id.clone()),
                )
            } else if !worktree.is_empty() {
                (
                    worktree.to_string(),
                    String::new(),
                    Some(workspace_id.to_string()),
                )
            } else {
                return Err(StartRuntimeError {
                    error_code: "WORKSPACE_NOT_FOUND".to_string(),
                    error_message: format!(
                        "workspace {} not found and no worktree path provided",
                        workspace_id
                    ),
                    failed_stage: "validation".to_string(),
                });
            }
        } else {
            // Bare-agent spawn: empty workspace_id. Use worktree if
            // provided, else "." (today's legacy default).
            let wt = if worktree.is_empty() {
                ".".to_string()
            } else {
                worktree.to_string()
            };
            (wt, String::new(), None)
        };

        // Fallback: when ws_id stayed empty (bare-agent spawn or
        // workspace_id-not-found-with-worktree branch), try to match
        // resolved_worktree against a registered workspace path so the
        // runtime row, persisted session, and downstream agent_runtimes
        // upsert all carry the right workspace_id instead of stomping it
        // null on idle transitions.
        if ws_id.is_empty() {
            if let Some(ws) = self
                .workspaces
                .workspaces
                .iter()
                .find(|w| w.path == resolved_worktree)
            {
                ws_id = ws.workspace_id.clone();
                if remote_workspace_id_owned.is_none() && !ws.remote_workspace_id.is_empty() {
                    remote_workspace_id_owned = Some(ws.remote_workspace_id.clone());
                }
                resolved_worktree = ws.path.clone();
            }
        }

        let remote_workspace_id = remote_workspace_id_owned.as_deref();

        // Invariant: a conversation has at most one live runtime *on this
        // daemon*. The daemon is a single actor/participant in the session, so
        // it must answer an @mention exactly once. Historically each desktop
        // session-start / model-switch / workspace-change spawned a fresh
        // runtime_id keyed by (session_id, agent_type, workspace_id); several
        // could end up live at the same time (e.g. one resumed-on-restart in
        // workspace A plus one freshly started in workspace B) and *each* then
        // replied to the same prompt — the duplicate-reply bug.
        //
        // Collapse to one: among this session's live runtimes, reuse the one
        // that exactly matches the requested (agent_type, workspace_id) and
        // supersede (stop) every other one so the latest client intent wins
        // and only a single runtime remains to answer. Also protects against
        // misbehaving clients that fire RuntimeStart twice (picker + inline
        // mention race on the desktop client pre-4210aad8).
        let (existing_runtime, superseded): (Option<String>, Vec<String>) = if session_id.is_empty()
        {
            (None, Vec::new())
        } else {
            let agents = self.agents.lock().await;
            let mut reuse: Option<String> = None;
            let mut stale: Vec<String> = Vec::new();
            for rid in agents.runtime_ids_for_session(session_id) {
                match agents.get_handle(&rid) {
                    Some(h)
                        if reuse.is_none()
                            && h.agent_type == agent_type
                            && h.workspace_id == ws_id =>
                    {
                        reuse = Some(rid);
                    }
                    _ => stale.push(rid),
                }
            }
            (reuse, stale)
        };

        if !superseded.is_empty() {
            for rid in &superseded {
                self.agents.lock().await.stop_agent(rid).await;
                if let Some(s) = self.sessions.find_by_id_mut(rid) {
                    s.status = amux::AgentStatus::Stopped as i32;
                }
            }
            let _ = self.sessions.save(&self.sessions_path);
            info!(
                session_id,
                superseded = ?superseded,
                "apply_start_runtime: superseded stale runtimes for session (one live runtime per session)"
            );
        }

        if let Some(existing) = existing_runtime {
            info!(
                session_id,
                workspace_id = %ws_id,
                runtime_id = %existing,
                "apply_start_runtime: dedup hit; reusing existing runtime"
            );
            // TODO(perf-runtime-start-throttle): See the same id on the client
            // (`ensureAgentRuntimesForSession` in packages/app). Dedup still runs
            // ensure_collab_session_registered, refresh_membership MQTT, reconcile
            // (full `messages_after_cursor`), and catchup — costly on large sessions.
            // Do NOT implement unless the user explicitly asks — ignore routinely.
            // 无用户明确指令时不要实现本 TODO，日常开发请忽略。
            // Still register the session + subscribe to session/live. The
            // spawn path does this before returning; skipping it on dedup left
            // runtimes that were reused without a live subscription, so
            // @-mention prompts published to MQTT never reached send_prompt.
            self.ensure_collab_session_registered(session_id).await?;
            if let Some(desired_model) = initial_model_override
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty())
            {
                let current = self
                    .agents
                    .lock()
                    .await
                    .current_model(&existing)
                    .cloned()
                    .unwrap_or_default();
                if desired_model != current {
                    let mut agents = self.agents.lock().await;
                    match agents.send_set_model(&existing, desired_model).await {
                        Ok(()) => {
                            agents.set_current_model(&existing, desired_model);
                        }
                        Err(e) => {
                            warn!(
                                runtime_id = %existing,
                                session_id,
                                model_id = %desired_model,
                                err = %e,
                                "apply_start_runtime: dedup reuse send_set_model failed"
                            );
                        }
                    }
                }
            }
            if !initial_prompt.trim().is_empty() {
                if let Err(e) = self
                    .agents
                    .lock()
                    .await
                    .send_prompt(&existing, initial_prompt, vec![])
                    .await
                {
                    warn!(
                        runtime_id = %existing,
                        session_id,
                        err = %e,
                        "apply_start_runtime: dedup reuse send_prompt failed"
                    );
                } else {
                    info!(
                        runtime_id = %existing,
                        session_id,
                        "apply_start_runtime: dedup reuse delivered initial_prompt"
                    );
                }
            }
            // Re-publish retained RuntimeInfo so clients that missed the
            // original retain (late subscribe, reconnect) still populate the
            // model picker without spawning a duplicate process.
            self.publish_runtime_state_by_id(&existing).await;
            if !session_id.is_empty() {
                if let Some(tc) = self.teamclaw.as_mut() {
                    if let Err(e) = tc.ensure_session_live_subscription(session_id).await {
                        warn!(
                            session_id,
                            err = %e,
                            "apply_start_runtime: ensure_session_live_subscription failed (dedup)"
                        );
                    }
                }
            }
            // Live MQTT can miss messages that landed in the backend after the
            // initial attach catchup (e.g. client dedup runtimeStart on send).
            // Replay from the cursor so @-mentioned rows still reach send_prompt.
            self.catchup_runtime(&existing).await;
            return Ok(StartRuntimeOutcome {
                runtime_id: existing,
                session_id: session_id.to_string(),
            });
        }

        // If iOS handed us a cloud session_id, pull the row + participants
        // so we (a) populate the teamclaw cache that `agents_to_activate`
        // reads, and (b) subscribe to `session/{sid}/live` so inbound
        // `message.created` events from iOS actually reach us.
        // iOS creates these sessions directly in the cloud backend, so this is the
        // only place the daemon learns about them.
        if !session_id.is_empty() {
            match self
                .backend
                .fetch_session_with_participants(session_id)
                .await
            {
                Ok(mut snap) => {
                    if !snap
                        .participants
                        .iter()
                        .any(|p| p.actor_id == self.actor_id)
                    {
                        snap.participants
                            .push(crate::backend::BackendParticipantRow {
                                session_id: session_id.to_string(),
                                actor_id: self.actor_id.clone(),
                                role: Some("agent".to_string()),
                                joined_at: chrono::Utc::now(),
                            });
                    }
                    if let Some(tc) = self.teamclaw.as_mut() {
                        if let Err(e) = tc
                            .insert_session_from_backend(&snap.session, &snap.participants)
                            .await
                        {
                            return Err(StartRuntimeError {
                                error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                                error_message: format!("insert_session_from_backend failed: {}", e),
                                failed_stage: "session_subscribe".to_string(),
                            });
                        }
                        if let Err(e) = tc.ensure_session_live_subscription(session_id).await {
                            warn!(
                                session_id,
                                err = %e,
                                "apply_start_runtime: ensure_session_live_subscription failed"
                            );
                        }
                    } else {
                        return Err(StartRuntimeError {
                            error_code: "SESSION_SUBSCRIBE_FAILED".to_string(),
                            error_message:
                                "teamclaw session manager is not available for session runtime"
                                    .to_string(),
                            failed_stage: "session_subscribe".to_string(),
                        });
                    }
                }
                Err(e) => {
                    return Err(StartRuntimeError {
                        error_code: "SESSION_LOOKUP_FAILED".to_string(),
                        error_message: format!("fetch_session_with_participants failed: {}", e),
                        failed_stage: "session_lookup".to_string(),
                    });
                }
            }
        }

        if !session_id.is_empty() && !ws_id.is_empty() {
            if let Some(outcome) = self
                .try_resume_runtime_for_start(
                    session_id,
                    agent_type,
                    &ws_id,
                    initial_prompt,
                    initial_model_override.as_deref(),
                )
                .await
            {
                return Ok(outcome);
            }
        }

        let session_id_opt = (!session_id.is_empty()).then_some(session_id);
        let resume_acp_session_id = if !session_id.is_empty() && !ws_id.is_empty() {
            resolve_backend_session_id(
                &self.backend,
                &self.actor_id,
                session_id,
                &self.sessions,
                agent_type,
                &ws_id,
            )
            .await
        } else {
            None
        };
        if let Some(ref sid) = resume_acp_session_id {
            info!(
                session_id,
                workspace_id = %ws_id,
                backend_session_id = %sid,
                "apply_start_runtime: spawning with ACP resume (no matching stored runtime row)"
            );
        }

        let workspace_team_id = self.resolve_workspace_team_id(&resolved_worktree, &ws_id);

        if let Some(ref team_id) = workspace_team_id {
            let gate = crate::team_link::team_share_gate(self.backend.as_ref(), team_id).await;
            crate::team_link::materialize_or_teardown(gate, team_id, &resolved_worktree);
        }

        if let Some(config) = load_team_shared_config_for_workspace(Path::new(&resolved_worktree)) {
            sync_team_shared_dir_for_workspace(Path::new(&resolved_worktree), &config);
        }

        self.suppress_internal_opencode_writes(&resolved_worktree);
        let runtime_env = self
            .assemble_spawn_runtime_env_for_worktree(&resolved_worktree, &ws_id)
            .map_err(|e| StartRuntimeError {
                error_code: "ENV_ASSEMBLE_FAILED".to_string(),
                error_message: format!("assemble_runtime_env failed: {e}"),
                failed_stage: "env_setup".to_string(),
            })?;
        // Spawn.
        let spawn_res = self
            .agents
            .lock()
            .await
            .spawn_agent_with_model(
                agent_type,
                &resolved_worktree,
                initial_prompt,
                &ws_id,
                remote_workspace_id,
                session_id_opt,
                initial_model_override,
                None,
                resume_acp_session_id,
                runtime_env,
            )
            .await;
        let new_id = match spawn_res {
            Ok(id) => id,
            Err(e) => {
                error!("spawn_agent failed: {}", e);
                // We never allocated a retained topic (spawn_agent failed before
                // returning an id), so there's no retain to publish FAILED to.
                // The caller formats the error into its wire envelope; no state
                // topic is involved.
                return Err(StartRuntimeError {
                    error_code: "SPAWN_FAILED".to_string(),
                    error_message: format!("spawn_agent failed: {}", e),
                    failed_stage: "spawning_process".to_string(),
                });
            }
        };

        {
            let mut agents = self.agents.lock().await;
            if let Err(e) = apply_workspace_system_instructions(
                &mut agents,
                &new_id,
                Path::new(&resolved_worktree),
                agent_type,
            ) {
                warn!(
                    runtime_id = %new_id,
                    session_id,
                    err = %e,
                    "apply_start_runtime: workspace system instructions failed"
                );
            }
        }

        // STARTING retain — fleeting but observable by mid-spawn reconnects.
        let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
        let starting_info = amux::RuntimeInfo {
            runtime_id: new_id.clone(),
            agent_type: agent_type as i32,
            worktree: resolved_worktree.clone(),
            workspace_id: ws_id.clone(),
            state: amux::RuntimeLifecycle::Starting as i32,
            stage: "spawning_process".to_string(),
            started_at: chrono::Utc::now().timestamp(),
            ..Default::default()
        };
        let _ = publisher
            .publish_runtime_state(&new_id, &starting_info)
            .await;

        // Persist session + transition to ACTIVE.
        let acp_sid = self
            .agents
            .lock()
            .await
            .get_handle(&new_id)
            .map(|h| h.acp_session_id.clone())
            .unwrap_or_default();
        let stored = StoredSession {
            runtime_id: new_id.clone(),
            acp_session_id: acp_sid,
            session_id: session_id.to_string(),
            agent_type: agent_type as i32,
            workspace_id: ws_id,
            worktree: resolved_worktree,
            status: amux::AgentStatus::Active as i32,
            created_at: chrono::Utc::now().timestamp(),
            last_prompt: initial_prompt.to_string(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        };
        self.sessions.upsert(stored);
        let _ = self.sessions.save(&self.sessions_path);

        // ACTIVE — publish_runtime_state_by_id reads the live RuntimeHandle and
        // dual-publishes to agent/{id}/state + runtime/{id}/state. The handle
        // today encodes state=ACTIVE (Phase 1a Idea 4).
        self.publish_runtime_state_by_id(&new_id).await;

        // Replay any messages the runtime missed before it was spawned.
        // Uses Option B (event loop hook is not needed here because
        // apply_start_runtime already has `&mut self` access and runs
        // synchronously after spawn_agent returns). This is the cleanest
        // insertion point — the handle is fully populated (session_id,
        // backend_runtime_row_id) and state is ACTIVE.
        self.catchup_runtime(&new_id).await;

        Ok(StartRuntimeOutcome {
            runtime_id: new_id,
            session_id: session_id.to_string(),
        })
    }

    async fn handle_stop_runtime(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        stop: &crate::proto::teamclaw::RuntimeStopRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStopResult};

        let runtime_id = stop.runtime_id.clone();
        if runtime_id.is_empty() {
            return reject_stop(request, "runtime_id required");
        }

        // Reject if runtime is not known.
        if self.agents.lock().await.get_handle(&runtime_id).is_none() {
            return reject_stop(request, &format!("unknown runtime_id: {}", runtime_id));
        }

        // Terminate via RuntimeManager (same path as AcpCommand::StopAgent).
        if self
            .agents
            .lock()
            .await
            .stop_agent(&runtime_id)
            .await
            .is_none()
        {
            return reject_stop(
                request,
                &format!("stop failed for runtime_id: {}", runtime_id),
            );
        }

        self.publish_runtime_stopped(&runtime_id).await;

        RpcResponse {
            request_id: request.request_id.clone(),
            success: true,
            error: String::new(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::RuntimeStopResult(RuntimeStopResult {
                accepted: true,
                rejected_reason: String::new(),
            })),
        }
    }

    /// Publish terminal `runtime/{id}/state`, clear the retained topic, and
    /// flip the persisted session row to Stopped. Idempotent — calling
    /// twice on the same `runtime_id` is safe (the second clear is a no-op
    /// against an already-empty retain).
    async fn publish_runtime_stopped(&mut self, runtime_id: &str) {
        if let Some(session) = self.sessions.find_by_id_mut(runtime_id) {
            session.status = amux::AgentStatus::Stopped as i32;
            let _ = self.sessions.save(&self.sessions_path);
        }
        let stopped_info = amux::RuntimeInfo {
            runtime_id: runtime_id.to_string(),
            state: amux::RuntimeLifecycle::Stopped as i32,
            ..Default::default()
        };
        let publisher = Publisher::new_from_handle(self.publisher_handle.clone(), &self.topics);
        let _ = publisher
            .publish_runtime_state(runtime_id, &stopped_info)
            .await;
        let _ = publisher.clear_runtime_state(runtime_id).await;
    }

    async fn handle_start_runtime(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        start: &crate::proto::teamclaw::RuntimeStartRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStartResult};

        let requested =
            amux::AgentType::try_from(start.agent_type).unwrap_or(amux::AgentType::ClaudeCode);
        let at = resolve_requested_agent_type(&self.config, requested);
        if at != requested {
            info!(requested = ?requested, resolved = ?at, "runtimeStart agent_type overridden by daemon config");
        }

        let initial_model_override = runtime_start_initial_model_override(start);
        let outcome = self
            .apply_start_runtime(
                at,
                &start.workspace_id,
                &start.worktree,
                &start.session_id,
                &start.initial_prompt,
                initial_model_override,
            )
            .await;

        match outcome {
            Ok(res) => RpcResponse {
                request_id: request.request_id.clone(),
                success: true,
                error: String::new(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: true,
                        runtime_id: res.runtime_id,
                        session_id: res.session_id,
                        rejected_reason: String::new(),
                    },
                )),
            },
            Err(err) => RpcResponse {
                request_id: request.request_id.clone(),
                success: false,
                error: err.error_message.clone(),
                requester_client_id: request.requester_client_id.clone(),
                requester_actor_id: request.requester_actor_id.clone(),
                result: Some(rpc_response::Result::RuntimeStartResult(
                    RuntimeStartResult {
                        accepted: false,
                        runtime_id: String::new(),
                        session_id: String::new(),
                        rejected_reason: err.error_message,
                    },
                )),
            },
        }
    }

    /// Forward a SetModel request to the matching runtime via ACP. On success
    /// the daemon's `current_model_per_agent` is bumped synchronously inside
    /// `RuntimeManager::set_model`, so we re-publish the runtime's retained
    /// state to fan the new `current_model` out to every subscriber.
    async fn handle_set_model(
        &mut self,
        request: &crate::proto::teamclaw::RpcRequest,
        set: &crate::proto::teamclaw::SetModelRequest,
    ) -> crate::proto::teamclaw::RpcResponse {
        use crate::proto::teamclaw::{rpc_response, RpcResponse, SetModelResult};

        let runtime_id = set.runtime_id.clone();
        let model_id = set.model_id.clone();
        if runtime_id.is_empty() {
            return reject_set_model(request, "runtime_id required");
        }
        if model_id.is_empty() {
            return reject_set_model(request, "model_id required");
        }

        let result = self
            .agents
            .lock()
            .await
            .set_model(&runtime_id, &model_id)
            .await;
        let (success, error) = match result {
            Ok(()) => (true, String::new()),
            Err(e) => (false, e.to_string()),
        };

        // On success, fan the new current_model out via the retained per-runtime
        // state topic so iOS subscribers see the change immediately. Also
        // upsert agent_runtimes.current_model so clients that read the cloud backend
        // (e.g. when MQTT delivery is flaky) see the change — without this,
        // iOS picks up the stale current_model and the row label snaps back
        // to the previous model after refreshMemberSheet runs.
        if success {
            self.publish_runtime_state_by_id(&runtime_id).await;

            let sb = &self.backend;
            let agents = self.agents.lock().await;
            let handle = agents.get_handle(&runtime_id);
            let (acp_sid, session_id, ws_id, backend_type) = (
                handle.map(|h| h.acp_session_id.clone()).unwrap_or_default(),
                handle.map(|h| h.session_id.clone()).unwrap_or_default(),
                handle.map(|h| h.workspace_id.clone()).unwrap_or_default(),
                handle
                    .map(|h| agents.launch_config_for(h.agent_type).backend_type)
                    .unwrap_or("claude"),
            );
            let status_str: &'static str = handle
                .map(|h| match amux::AgentStatus::try_from(h.status as i32) {
                    Ok(amux::AgentStatus::Active) => "running",
                    Ok(amux::AgentStatus::Idle) => "idle",
                    Ok(amux::AgentStatus::Stopped) => "stopped",
                    _ => "starting",
                })
                .unwrap_or("starting");
            drop(agents);

            let remote_workspace_id = self.workspaces.find_by_id(&ws_id).and_then(|w| {
                (!w.remote_workspace_id.is_empty()).then_some(w.remote_workspace_id.clone())
            });
            let team_id = sb.team_id().to_string();
            let actor_id = sb.actor_id().to_string();
            let sb_clone = sb.clone();
            let runtime_id_owned = runtime_id.clone();
            let model_id_owned = model_id.clone();
            tokio::spawn(async move {
                let row = AgentRuntimeUpsert {
                    team_id: &team_id,
                    agent_id: &actor_id,
                    session_id: (!session_id.is_empty()).then_some(session_id.as_str()),
                    workspace_id: remote_workspace_id.as_deref(),
                    backend_type,
                    backend_session_id: if acp_sid.is_empty() {
                        None
                    } else {
                        Some(acp_sid.as_str())
                    },
                    runtime_id: Some(runtime_id_owned.as_str()),
                    status: status_str,
                    current_model: Some(model_id_owned.as_str()),
                    last_seen_at: chrono::Utc::now(),
                };
                if let Err(e) = sb_clone.upsert_agent_runtime(&row).await {
                    warn!("agent_runtimes upsert (set_model): {e}");
                }
            });
        }

        RpcResponse {
            request_id: request.request_id.clone(),
            success,
            error: error.clone(),
            requester_client_id: request.requester_client_id.clone(),
            requester_actor_id: request.requester_actor_id.clone(),
            result: Some(rpc_response::Result::SetModelResult(SetModelResult {
                success,
                error,
            })),
        }
    }
}

fn reject_stop(
    request: &crate::proto::teamclaw::RpcRequest,
    reason: &str,
) -> crate::proto::teamclaw::RpcResponse {
    use crate::proto::teamclaw::{rpc_response, RpcResponse, RuntimeStopResult};
    RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: reason.to_string(),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: Some(rpc_response::Result::RuntimeStopResult(RuntimeStopResult {
            accepted: false,
            rejected_reason: reason.to_string(),
        })),
    }
}

fn reject_set_model(
    request: &crate::proto::teamclaw::RpcRequest,
    reason: &str,
) -> crate::proto::teamclaw::RpcResponse {
    use crate::proto::teamclaw::{rpc_response, RpcResponse, SetModelResult};
    RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: reason.to_string(),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: Some(rpc_response::Result::SetModelResult(SetModelResult {
            success: false,
            error: reason.to_string(),
        })),
    }
}

/// Shrinks an `AcpAvailableCommands` list in place so the serialized message
/// stays under the broker's per-packet cap. Strategy: walk the description
/// length down (80 → 40 → 20 → 0) until the encoded size fits; if stripping
/// descriptions is still not enough, drop commands from the tail.
///
/// The budget is deliberately well under the 10 240-byte broker limit to
/// leave headroom for the envelope wrapper (actor_id, agent_id, sequence,
/// etc.) and the MQTT topic name / fixed header.
fn fit_available_commands_in_budget(ac: &mut crate::proto::amux::AcpAvailableCommands) {
    use prost::Message;
    const BUDGET: usize = 8_500;

    if ac.encoded_len() <= BUDGET {
        return;
    }

    for &limit in &[80usize, 40, 20, 0] {
        for cmd in &mut ac.commands {
            if cmd.description.chars().count() > limit {
                cmd.description = cmd.description.chars().take(limit).collect();
            }
        }
        if ac.encoded_len() <= BUDGET {
            return;
        }
    }

    while ac.encoded_len() > BUDGET && !ac.commands.is_empty() {
        ac.commands.pop();
    }
}

/// Bind `amuxd.sock` and spawn a task that accepts connections, reads a
/// single newline-terminated control command per connection, and forwards
/// the parsed `SockCommand` to the daemon's main loop via `tx`. Stale
/// socket files left over from a crashed previous run are removed before
/// bind. Errors are logged and swallowed — the daemon must keep running
/// even if the sock can't be set up (operators can still kill it via
/// SIGTERM).
fn spawn_sock_listener(sock_path: PathBuf, tx: mpsc::Sender<SockCommand>) {
    // Make sure the parent directory exists (e.g. on first run).
    if let Some(parent) = sock_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!(
                "amuxd.sock: failed to create parent dir {}: {e}",
                parent.display()
            );
            return;
        }
    }
    // Remove a stale socket left by an earlier crash; `bind` returns
    // AddrInUse otherwise.
    let _ = std::fs::remove_file(&sock_path);

    let listener = match UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(e) => {
            error!("amuxd.sock: bind {} failed: {e}", sock_path.display());
            return;
        }
    };
    info!("amuxd.sock: listening on {}", sock_path.display());

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        let mut reader = BufReader::new(stream);
                        let mut first_line = String::new();
                        match reader.read_line(&mut first_line).await {
                            Ok(0) => {}
                            Ok(_) => {
                                let head = first_line.trim();

                                // JSON envelopes (currently just `mcp-send`)
                                // are framed differently from the legacy
                                // line-based control protocol — sniff the
                                // first byte and branch.
                                if head.starts_with('{') {
                                    let parsed: Result<serde_json::Value, _> =
                                        serde_json::from_str(head);
                                    match parsed {
                                        Ok(v) => {
                                            let cmd =
                                                v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
                                            if cmd == "mcp-send" {
                                                let (reply_tx, reply_rx) = oneshot::channel();
                                                if tx
                                                    .send(SockCommand::McpSend {
                                                        payload: v,
                                                        reply_tx,
                                                    })
                                                    .await
                                                    .is_err()
                                                {
                                                    return;
                                                }
                                                match reply_rx.await {
                                                    Ok(body) => {
                                                        let mut stream = reader.into_inner();
                                                        if let Err(e) =
                                                            stream.write_all(body.as_bytes()).await
                                                        {
                                                            warn!(
                                                                "amuxd.sock: mcp-send write failed: {e}"
                                                            );
                                                            return;
                                                        }
                                                        let _ = stream.write_all(b"\n").await;
                                                        let _ = stream.shutdown().await;
                                                    }
                                                    Err(_) => {
                                                        warn!("amuxd.sock: mcp-send reply dropped");
                                                    }
                                                }
                                            } else if cmd == "prompt-await" {
                                                let (reply_tx, reply_rx) = oneshot::channel();
                                                if tx
                                                    .send(SockCommand::PromptAwait {
                                                        payload: v,
                                                        reply_tx,
                                                    })
                                                    .await
                                                    .is_err()
                                                {
                                                    return;
                                                }
                                                match reply_rx.await {
                                                    Ok(body) => {
                                                        let mut stream = reader.into_inner();
                                                        if let Err(e) =
                                                            stream.write_all(body.as_bytes()).await
                                                        {
                                                            warn!(
                                                                "amuxd.sock: prompt-await write failed: {e}"
                                                            );
                                                            return;
                                                        }
                                                        let _ = stream.write_all(b"\n").await;
                                                        let _ = stream.shutdown().await;
                                                    }
                                                    Err(_) => {
                                                        warn!(
                                                            "amuxd.sock: prompt-await reply dropped"
                                                        );
                                                    }
                                                }
                                            } else {
                                                warn!("amuxd.sock: unknown JSON cmd: {cmd:?}");
                                            }
                                        }
                                        Err(e) => {
                                            warn!("amuxd.sock: JSON parse failed: {e}");
                                        }
                                    }
                                    return;
                                }

                                match head {
                                    "channel-reload" => {
                                        let _ = tx.send(SockCommand::ChannelReload).await;
                                    }
                                    "channel-status" => {
                                        // Round-trip: ask the main loop to build a
                                        // status snapshot, then write the JSON body
                                        // back to the connected client.
                                        let (reply_tx, reply_rx) = oneshot::channel();
                                        if tx
                                            .send(SockCommand::ChannelStatus { reply_tx })
                                            .await
                                            .is_err()
                                        {
                                            return;
                                        }
                                        match reply_rx.await {
                                            Ok(body) => {
                                                let mut stream = reader.into_inner();
                                                if let Err(e) =
                                                    stream.write_all(body.as_bytes()).await
                                                {
                                                    warn!(
                                                        "amuxd.sock: channel-status write failed: {e}"
                                                    );
                                                    return;
                                                }
                                                let _ = stream.write_all(b"\n").await;
                                                let _ = stream.shutdown().await;
                                            }
                                            Err(_) => {
                                                warn!("amuxd.sock: channel-status reply dropped");
                                            }
                                        }
                                    }
                                    "wechat-qr-start" => {
                                        let (reply_tx, reply_rx) = oneshot::channel();
                                        if tx
                                            .send(SockCommand::WechatQrStart { reply_tx })
                                            .await
                                            .is_err()
                                        {
                                            return;
                                        }
                                        if let Ok(body) = reply_rx.await {
                                            let mut stream = reader.into_inner();
                                            let _ = stream.write_all(body.as_bytes()).await;
                                            let _ = stream.write_all(b"\n").await;
                                            let _ = stream.shutdown().await;
                                        }
                                    }
                                    "wechat-qr-poll" => {
                                        let mut qrcode = String::new();
                                        if reader.read_line(&mut qrcode).await.is_err() {
                                            warn!("amuxd.sock: wechat-qr-poll missing qrcode");
                                            return;
                                        }
                                        let (reply_tx, reply_rx) = oneshot::channel();
                                        if tx
                                            .send(SockCommand::WechatQrPoll {
                                                qrcode: qrcode.trim().to_string(),
                                                reply_tx,
                                            })
                                            .await
                                            .is_err()
                                        {
                                            return;
                                        }
                                        if let Ok(body) = reply_rx.await {
                                            let mut stream = reader.into_inner();
                                            let _ = stream.write_all(body.as_bytes()).await;
                                            let _ = stream.write_all(b"\n").await;
                                            let _ = stream.shutdown().await;
                                        }
                                    }
                                    "wecom-qr-start" => {
                                        let (reply_tx, reply_rx) = oneshot::channel();
                                        if tx
                                            .send(SockCommand::WecomQrStart { reply_tx })
                                            .await
                                            .is_err()
                                        {
                                            return;
                                        }
                                        if let Ok(body) = reply_rx.await {
                                            let mut stream = reader.into_inner();
                                            let _ = stream.write_all(body.as_bytes()).await;
                                            let _ = stream.write_all(b"\n").await;
                                            let _ = stream.shutdown().await;
                                        }
                                    }
                                    "wecom-qr-poll" => {
                                        let mut scode = String::new();
                                        if reader.read_line(&mut scode).await.is_err() {
                                            warn!("amuxd.sock: wecom-qr-poll missing scode");
                                            return;
                                        }
                                        let (reply_tx, reply_rx) = oneshot::channel();
                                        if tx
                                            .send(SockCommand::WecomQrPoll {
                                                scode: scode.trim().to_string(),
                                                reply_tx,
                                            })
                                            .await
                                            .is_err()
                                        {
                                            return;
                                        }
                                        if let Ok(body) = reply_rx.await {
                                            let mut stream = reader.into_inner();
                                            let _ = stream.write_all(body.as_bytes()).await;
                                            let _ = stream.write_all(b"\n").await;
                                            let _ = stream.shutdown().await;
                                        }
                                    }
                                    "channel-save" => {
                                        // Wire format: line 1 = "channel-save",
                                        // line 2 = platform, line 3+ = JSON
                                        // (single line — JSON has no embedded \n
                                        // after `to_string()` serialization).
                                        let mut platform = String::new();
                                        if reader.read_line(&mut platform).await.is_err() {
                                            warn!("amuxd.sock: channel-save missing platform");
                                            return;
                                        }
                                        let mut config_json = String::new();
                                        if reader.read_line(&mut config_json).await.is_err() {
                                            warn!("amuxd.sock: channel-save missing config json");
                                            return;
                                        }
                                        let _ = tx
                                            .send(SockCommand::ChannelSave {
                                                platform: platform.trim().to_string(),
                                                config_json: config_json.trim().to_string(),
                                            })
                                            .await;
                                    }
                                    other => {
                                        let _ =
                                            tx.send(SockCommand::Unknown(other.to_string())).await;
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("amuxd.sock: read_line failed: {e}");
                            }
                        }
                    });
                }
                Err(e) => {
                    warn!("amuxd.sock: accept error: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    });
}

fn not_yet_implemented(
    request: &crate::proto::teamclaw::RpcRequest,
    method_name: &str,
) -> crate::proto::teamclaw::RpcResponse {
    crate::proto::teamclaw::RpcResponse {
        request_id: request.request_id.clone(),
        success: false,
        error: format!("{} not yet implemented", method_name),
        requester_client_id: request.requester_client_id.clone(),
        requester_actor_id: request.requester_actor_id.clone(),
        result: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rumqttc::{AsyncClient, MqttOptions};
    use std::io;
    use tempfile::TempDir;

    #[test]
    fn group_workspaces_by_team_dedups_and_skips_unteamed() {
        use crate::config::StoredWorkspace;
        let mk = |path: &str, team: Option<&str>| StoredWorkspace {
            workspace_id: "id".into(),
            remote_workspace_id: String::new(),
            path: path.into(),
            display_name: "ws".into(),
            team_id: team.map(|t| t.to_string()),
        };
        let ws = vec![
            mk("/a", Some("team-1")),
            mk("/b", Some("team-1")),
            mk("/c", Some("team-2")),
            mk("/d", None),
            mk("", Some("team-1")),
        ];
        let grouped = group_workspaces_by_team(&ws);
        assert_eq!(grouped.len(), 2);
        let t1 = grouped.iter().find(|(t, _)| t == "team-1").unwrap();
        assert_eq!(t1.1, vec!["/a".to_string(), "/b".to_string()]);
        let t2 = grouped.iter().find(|(t, _)| t == "team-2").unwrap();
        assert_eq!(t2.1, vec!["/c".to_string()]);
    }

    #[test]
    fn team_id_to_stamp_inherits_daemon_team_only_when_unset() {
        // Existing team always wins → no stamp.
        assert_eq!(team_id_to_stamp(Some("team-x"), Some("team-d")), None);
        // No existing → inherit daemon team.
        assert_eq!(
            team_id_to_stamp(None, Some("team-d")),
            Some("team-d".to_string())
        );
        // No daemon team → nothing to stamp.
        assert_eq!(team_id_to_stamp(None, None), None);
        // Empty/whitespace daemon team → nothing to stamp.
        assert_eq!(team_id_to_stamp(None, Some("   ")), None);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_team_link_creates_global_dir_and_workspace_symlink() {
        // Serializes with other HOME-mutating tests (config_dir reads $HOME).
        let _guard = crate::config::global_team_store::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        let ws = tempfile::tempdir().unwrap();
        let ws_path = ws.path().to_str().unwrap();

        ensure_team_link("team-ondemand", ws_path);

        // Global dir + scaffold created under ~/.amuxd/teams/<id>/teamclaw-team.
        let global = crate::config::global_team_store::global_team_dir("team-ondemand");
        assert!(global.is_dir(), "global team dir should be created");
        assert!(global.join("skills").is_dir());

        // Workspace exposes it via a teamclaw-team symlink to that global dir.
        let link = ws.path().join("teamclaw-team");
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "workspace entry should be a symlink"
        );
        assert_eq!(std::fs::read_link(&link).unwrap(), global);

        // Idempotent: a second call must not error or change the target.
        ensure_team_link("team-ondemand", ws_path);
        assert_eq!(std::fs::read_link(&link).unwrap(), global);

        // Empty team_id is a no-op (no stray dir/link).
        let ws2 = tempfile::tempdir().unwrap();
        ensure_team_link("", ws2.path().to_str().unwrap());
        assert!(std::fs::symlink_metadata(ws2.path().join("teamclaw-team")).is_err());
    }

    struct TestServer {
        server: DaemonServer,
        _tmp: TempDir,
    }

    #[derive(Clone, Default)]
    struct LogCapture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    struct CapturedLogWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
        type Writer = CapturedLogWriter;

        fn make_writer(&'a self) -> Self::Writer {
            CapturedLogWriter(self.0.clone())
        }
    }

    impl io::Write for CapturedLogWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl LogCapture {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn test_config() -> DaemonConfig {
        DaemonConfig {
            actor: crate::config::ActorConfig {
                id: "actor-config-test".to_string(),
                name: "test-host".to_string(),
            },
            mqtt: crate::config::MqttConfig {
                broker_url: "mqtt://localhost:1883".to_string(),
                username: None,
                password: None,
            },
            agents: crate::config::AgentsConfig::default(),
            transport: None,
            team_id: Some("team-test".to_string()),
            channels: crate::config::ChannelsConfig::default(),
            idle_runtime_timeout_secs: None,
            http: None,
        }
    }

    fn test_cloud_api() -> Arc<dyn Backend> {
        test_cloud_api_with_url("http://localhost".to_string())
    }

    fn test_cloud_api_with_url(url: String) -> Arc<dyn Backend> {
        Arc::new(crate::backend::cloud_api::CloudApiBackend::new(
            crate::provider_config::CloudApiConfig {
                url,
                refresh_token: "refresh".to_string(),
                team_id: "team-test".to_string(),
                actor_id: "agent-actor".to_string(),
            },
        ))
    }

    #[test]
    fn backend_from_provider_config_initializes_cloud_api_backend() {
        let config = crate::provider_config::ProviderConfig::CloudApi(
            crate::provider_config::CloudApiConfig {
                url: "http://localhost".to_string(),
                refresh_token: "refresh".to_string(),
                team_id: "team-test".to_string(),
                actor_id: "agent-actor".to_string(),
            },
        );

        let backend = backend_from_provider_config(config).unwrap();

        assert_eq!(backend.team_id(), "team-test");
        assert_eq!(backend.actor_id(), "agent-actor");
    }

    fn test_mqtt(actor_id: &str) -> MqttClient {
        let mut opts = MqttOptions::new("daemon-server-test", "localhost", 1883);
        opts.set_clean_session(true);
        let (client, eventloop) = AsyncClient::new(opts, 10);
        MqttClient {
            client,
            eventloop,
            topics: crate::mqtt::Topics::new("team-test", actor_id),
        }
    }

    fn test_server() -> TestServer {
        test_server_with_cloud_api(test_cloud_api())
    }

    fn test_server_with_cloud_api(backend: Arc<dyn Backend>) -> TestServer {
        let tmp = TempDir::new().unwrap();
        let config = test_config();
        let mqtt = test_mqtt(&config.actor.id);
        let teamclaw = crate::teamclaw::SessionManager::new(
            Arc::new(mqtt.client.clone()) as Arc<dyn MessagePublisher>,
            "team-test",
            &config.actor.id,
            Some("agent-actor".to_string()),
            tmp.path().to_path_buf(),
        )
        .unwrap();

        let mut agents = RuntimeManager::new(RuntimeManager::default_launch_configs(), None);
        agents.add_test_runtime("rt1", "runtime-agent", "session-1");

        let publisher_handle: Arc<dyn MessagePublisher> = Arc::new(mqtt.client.clone());
        let topics = mqtt.topics.clone();
        TestServer {
            server: DaemonServer {
                config,
                config_path: tmp.path().join("daemon.toml"),
                mqtt,
                nats: None,
                publisher_handle,
                topics,
                agents: Arc::new(AsyncMutex::new(agents)),
                auth: AuthManager::new(tmp.path().join("members.toml")).unwrap(),
                peers: PeerTracker::new(),
                permissions: PermissionManager::new(),
                workspaces: WorkspaceStore::load(&tmp.path().join("workspaces.toml")).unwrap(),
                workspaces_path: tmp.path().join("workspaces.toml"),
                sync_dispatcher: crate::sync::dispatch::SyncDispatcher::new(
                    crate::sync::secret_store::SecretStore::new(),
                    None,
                ),
                sessions: SessionStore::default(),
                sessions_path: tmp.path().join("sessions.toml"),
                history: EventHistory::new(&tmp.path().join("history")),
                teamclaw: Some(teamclaw),
                backend,
                actor_id: "agent-actor".to_string(),
                channel_mgr: None,
                cron_sessions: HashMap::new(),
                refresh_watch_registry: None,
                refresh_coordinator: None,
            },
            _tmp: tmp,
        }
    }

    fn live_message(
        session_id: &str,
        message_id: &str,
        content: &str,
    ) -> subscriber::IncomingMessage {
        let msg = crate::proto::teamclaw::Message {
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            sender_actor_id: "human-actor".to_string(),
            kind: 0,
            content: content.to_string(),
            created_at: 1,
            ..Default::default()
        };
        let msg_env = crate::proto::teamclaw::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec!["agent-actor".to_string()],
            ..Default::default()
        };
        let live = crate::proto::teamclaw::LiveEventEnvelope {
            event_id: format!("event-{message_id}-{content}"),
            event_type: "message.created".to_string(),
            session_id: session_id.to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: msg_env.encode_to_vec(),
        };
        subscriber::IncomingMessage::TeamclawSessionLive {
            session_id: session_id.to_string(),
            payload: live.encode_to_vec(),
        }
    }

    #[test]
    fn loads_team_shared_config_from_workspace_file() {
        let tmp = TempDir::new().unwrap();
        let config_dir = tmp.path().join(".teamclaw");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("teamclaw.json"),
            serde_json::json!({
                "team": {
                    "gitUrl": "https://example.com/shared.git",
                    "gitBranch": "main",
                    "gitToken": "token",
                    "sharedDirName": "teamclaw",
                    "envSecret": "secret",
                    "enabled": true
                }
            })
            .to_string(),
        )
        .unwrap();

        let config = load_team_shared_config_for_workspace(tmp.path()).unwrap();

        assert_eq!(
            config.git_url.as_deref(),
            Some("https://example.com/shared.git")
        );
        assert_eq!(config.git_branch.as_deref(), Some("main"));
        assert_eq!(config.git_token.as_deref(), Some("token"));
        assert_eq!(config.shared_dir_name, "teamclaw");
        assert_eq!(config.env_secret.as_deref(), Some("secret"));
        assert!(config.enabled);
    }

    #[test]
    fn ignores_disabled_or_unconfigured_team_shared_config() {
        for team in [
            serde_json::json!({
                "gitUrl": "https://example.com/shared.git",
                "enabled": false
            }),
            serde_json::json!({
                "gitUrl": "",
                "enabled": true
            }),
            serde_json::json!({
                "enabled": true
            }),
        ] {
            let tmp = TempDir::new().unwrap();
            let config_dir = tmp.path().join(".teamclaw");
            std::fs::create_dir_all(&config_dir).unwrap();
            std::fs::write(
                config_dir.join("teamclaw.json"),
                serde_json::json!({ "team": team }).to_string(),
            )
            .unwrap();

            assert!(load_team_shared_config_for_workspace(tmp.path()).is_none());
        }
    }

    fn seed_teamclaw_session(server: &mut DaemonServer, session_id: &str, title: &str) {
        let session = crate::teamclaw::StoredSession {
            session_id: session_id.to_string(),
            team_id: "team-test".to_string(),
            title: title.to_string(),
            created_by: "human-actor".to_string(),
            created_at: chrono::Utc::now(),
            summary: String::new(),
            idea_id: String::new(),
            participants: vec![],
            primary_agent_id: String::new(),
        };
        server.teamclaw.as_mut().unwrap().sessions.upsert(session);
    }

    #[tokio::test]
    async fn incoming_live_event_log_includes_cached_session_and_daemon_info() {
        let mut fixture = test_server();
        seed_teamclaw_session(&mut fixture.server, "session-title-test", "Launch Plan");

        let live = crate::proto::teamclaw::LiveEventEnvelope {
            event_id: "event-session-title".to_string(),
            event_type: "unknown.test".to_string(),
            session_id: "session-title-test".to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: vec![],
        };
        let capture = LogCapture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_writer(capture.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        fixture
            .server
            .handle_incoming(subscriber::IncomingMessage::TeamclawSessionLive {
                session_id: "session-title-test".to_string(),
                payload: live.encode_to_vec(),
            })
            .await;

        let logs = capture.text();
        assert!(logs.contains("LiveEventEnvelope decoded"), "{logs}");
        assert!(logs.contains("session_title=Launch Plan"), "{logs}");
        assert!(
            logs.contains("daemon_config_actor_id=actor-config-test"),
            "{logs}"
        );
        assert!(logs.contains("daemon_actor_id=agent-actor"), "{logs}");
        assert!(logs.contains("daemon_team_id=team-test"), "{logs}");
    }

    #[tokio::test]
    async fn auto_restart_offline_sessions_is_noop_without_membership() {
        // The default test fixture has no teamclaw memberships (no
        // sessions.toml entries the actor is a participant in), so the
        // method must return early before touching the Cloud API. A real
        // request would fail because `test_cloud_api()` points at
        // http://localhost with no server running, so a successful return
        // here implies the early-exit guard fired.
        let mut fixture = test_server();
        fixture.server.auto_restart_offline_sessions().await;
        // No runtimes added beyond the fixture's seeded "rt1".
        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.get_handle("rt1").is_some(),
            "fixture runtime should be untouched"
        );
    }

    #[tokio::test]
    async fn runtime_start_with_session_id_fails_when_cloud_api_lookup_fails() {
        let mut fixture =
            test_server_with_cloud_api(test_cloud_api_with_url("http://127.0.0.1:1".into()));

        let result = fixture
            .server
            .apply_start_runtime(
                amux::AgentType::ClaudeCode,
                "",
                ".",
                "session-missing",
                "",
                None,
            )
            .await;
        let err = match result {
            Ok(_) => panic!("session-bound RuntimeStart must fail before spawning"),
            Err(err) => err,
        };

        assert_eq!(err.error_code, "SESSION_LOOKUP_FAILED");
        assert_eq!(err.failed_stage, "session_lookup");
    }

    // ── plan_auto_restart_offline_sessions branch coverage ─────────────────
    //
    // The pure-decision half of `auto_restart_offline_sessions` is exposed
    // as `plan_auto_restart_offline_sessions` so we can verify every
    // skip/keep branch without actually booting an ACP backend. The tests
    // below cover:
    //
    //   - membership session has no prior agent_runtimes row → skip
    //   - prior row exists, but no messages newer than cursor → skip
    //   - prior row exists, unread messages are all self-authored → skip
    //   - prior row exists, unread from someone else, no live runtime →
    //     keep with backend/workspace_id resolved from the prior row
    //   - prior row exists, but a live runtime is already serving → skip
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Cloud API `/v1/auth/refresh` mock — every test calls
    /// `access_token()` before any business request.
    async fn auth_token_mock(srv: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/v1/auth/refresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "accessToken": "at",
                "refreshToken": "rt",
                "expiresAt": 9999999999_i64
            })))
            .mount(srv)
            .await;
    }

    /// `fetch_latest_runtime_for_session` hits
    /// `GET /v1/agents/runtimes/latest?agentId=...&sessionId=...` and expects
    /// a single object (404 → None). Map the legacy PostgREST signature
    /// onto the cloud_api shape.
    async fn mock_agent_runtime_row(
        srv: &MockServer,
        session_id: &str,
        last_processed_message_id: Option<&str>,
        _workspace_id: Option<&str>,
        _backend_type: &str,
    ) {
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .and(query_param("sessionId", session_id))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": format!("row-{session_id}"),
                "backendSessionId": format!("acp-{session_id}"),
                "lastProcessedMessageId": last_processed_message_id,
            })))
            .mount(srv)
            .await;
    }

    /// `messages_after_cursor` hits `GET /v1/sessions/{id}/messages`. The
    /// legacy PostgREST mocks returned a top-level array of rows in
    /// snake_case; convert each row to the cloud_api camelCase envelope.
    async fn mock_messages_response(srv: &MockServer, session_id: &str, rows: serde_json::Value) {
        let items: Vec<serde_json::Value> = rows
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(to_cloud_message)
            .collect();
        Mock::given(method("GET"))
            .and(path(format!("/v1/sessions/{session_id}/messages")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": items,
                "nextCursor": null,
            })))
            .mount(srv)
            .await;
    }

    fn to_cloud_message(row: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": row.get("id").cloned().unwrap_or_default(),
            "sessionId": row.get("session_id").cloned().unwrap_or_default(),
            "senderActorId": row.get("sender_actor_id").cloned().unwrap_or_default(),
            "kind": row.get("kind").cloned().unwrap_or(serde_json::json!("text")),
            "content": row.get("content").cloned().unwrap_or_default(),
            "metadata": row.get("metadata").cloned().unwrap_or(serde_json::json!({})),
            "createdAt": row.get("created_at").cloned().unwrap_or_default(),
        })
    }

    async fn add_membership(fixture: &mut TestServer, session_id: &str) {
        let tc = fixture.server.teamclaw.as_mut().expect("teamclaw set");
        tc.insert_session_from_backend_for_test(
            session_id,
            "team-test",
            None,
            &[("agent-actor", "owner")],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn plan_skips_session_with_no_prior_runtime_row() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // No prior row — Cloud API returns 404 for the "latest" lookup.
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "no runtime row" }
            })))
            .mount(&srv)
            .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-no-row").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(plan.is_empty(), "no prior row should produce empty plan");
    }

    #[tokio::test]
    async fn plan_skips_when_no_unread_messages_after_cursor() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-empty", Some("msg-9"), None, "claude").await;
        // Cloud API honours `messages_after_cursor` by returning an empty
        // list (the drain-through-cursor logic happens client-side, but
        // here we simulate "no messages newer than the cursor").
        mock_messages_response(&srv, "sess-empty", serde_json::json!([])).await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-empty").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "no unread messages should produce empty plan"
        );
    }

    #[tokio::test]
    async fn plan_skips_when_unread_messages_are_all_self_authored() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-self", None, None, "claude").await;
        // Two messages, both sent by the daemon's own actor (e.g. prior
        // agent replies we already emitted). Auto-restart must NOT fire
        // for these — there is no user input to process.
        mock_messages_response(
            &srv,
            "sess-self",
            serde_json::json!([
                {
                    "id": "msg-1",
                    "session_id": "sess-self",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "ok",
                    "metadata": {},
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-self").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "self-authored unread should not trigger restart"
        );
    }

    #[tokio::test]
    async fn plan_keeps_session_with_unread_from_someone_else() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(
            &srv,
            "sess-mention",
            Some("msg-9"),
            Some("ws-cloud-uuid"),
            "claude_code",
        )
        .await;
        // Cloud API's `messages_after_cursor` trims past `after_id`
        // client-side, so include msg-9 (the cursor) at the head of the
        // response. After trimming: msg-10 (self-authored, filtered) +
        // msg-11 (human, kept).
        mock_messages_response(
            &srv,
            "sess-mention",
            serde_json::json!([
                {
                    "id": "msg-9",
                    "session_id": "sess-mention",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "cursor row",
                    "metadata": {},
                    "created_at": "2025-05-22T00:29:00Z"
                },
                {
                    "id": "msg-10",
                    "session_id": "sess-mention",
                    "sender_actor_id": "agent-actor",
                    "kind": "agent_reply",
                    "content": "prior reply",
                    "metadata": {},
                    "created_at": "2025-05-22T00:30:00Z"
                },
                {
                    "id": "msg-11",
                    "session_id": "sess-mention",
                    "sender_actor_id": "human-actor",
                    "kind": "text",
                    "content": "are you there?",
                    "metadata": { "mention_actor_ids": ["agent-actor"] },
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-mention").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert_eq!(plan.len(), 1, "one session should need restart");
        assert_eq!(plan[0].session_id, "sess-mention");
        assert_eq!(plan[0].unread_count, 1, "self-authored msg-10 was filtered");
        // No local workspace is registered for "ws-cloud-uuid", so the
        // helper falls back to empty (apply_start_runtime will then
        // resolve via the registered workspace lookup or current dir).
        assert!(plan[0].local_workspace_id.is_empty());
    }

    #[tokio::test]
    async fn plan_skips_session_with_live_runtime_already_running() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // The fixture seeds a runtime "rt1" bound to session_id
        // "session-1" via add_test_runtime. Make that the membership
        // session and confirm the planner refuses to schedule a second
        // spawn for the same session.
        mock_agent_runtime_row(&srv, "session-1", None, None, "claude").await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                {
                    "id": "msg-50",
                    "session_id": "session-1",
                    "sender_actor_id": "human-actor",
                    "kind": "text",
                    "content": "hi",
                    "metadata": {},
                    "created_at": "2025-05-22T01:00:00Z"
                }
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "session-1").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "existing live runtime should suppress auto-restart for the same session"
        );
    }

    // ── catchup_runtime stale-mention compaction ──────────────────────────
    //
    // When the daemon comes back online and replays the cursor → now slice
    // through catchup_runtime, only the most recent `@daemon` mention should
    // trigger a real ACP prompt. Earlier @-mentions are demoted to silent
    // context (pending_silent prefix on the eventual prompt) because the
    // conversation already moved past them — firing a fresh turn on those
    // stale mentions would emit out-of-date replies.

    fn make_message_row(
        id: &str,
        session_id: &str,
        sender_actor_id: &str,
        mentions: &[&str],
        content: &str,
        created_at: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "session_id": session_id,
            "sender_actor_id": sender_actor_id,
            "kind": "text",
            "content": content,
            "metadata": { "mention_actor_ids": mentions },
            "created_at": created_at,
        })
    }

    #[tokio::test]
    async fn catchup_runtime_prompts_only_on_last_mention_compacting_stale_ones() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        // 3-message replay: @daemon, @daemon, plain. The latest @daemon is
        // msg-b; msg-a is stale (a later @daemon came in). msg-c is a
        // non-mention follow-up and should also land as silent context.
        // Expected outcome:
        //   - send_prompt fires exactly once, carrying "ask B" (the last
        //     @-mention's content)
        //   - the silent queue holds msg-a only (msg-b is consumed by the
        //     real prompt; msg-c never @-mentions us, hence silent)
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-a",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "ask A",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-b",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "ask B",
                    "2025-05-22T01:00:02Z",
                ),
                make_message_row(
                    "msg-c",
                    "session-1",
                    "human-2",
                    &[],
                    "drive-by chatter",
                    "2025-05-22T01:00:03Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("rt1").await;

        // `send_prompt` (not raw) auto-drains the silent queue via
        // `flush_pending_silent`, so by the time msg-b's prompt fires the
        // stale msg-a is woven into a `[Context — …]` prefix. msg-c is
        // routed AFTER msg-b, so it stays in the silent queue waiting for
        // the next real prompt.
        let agents = fixture.server.agents.lock().await;
        let last = agents
            .last_sent_to("rt1")
            .expect("the last @-mention should trigger send_prompt");
        assert!(
            last.contains("ask B"),
            "send_prompt body should carry the latest @-mention content; got: {last}"
        );
        assert!(
            last.contains("ask A"),
            "the stale @-mention should be folded into the [Context …] prefix; got: {last}"
        );
        assert!(
            !last.contains("drive-by chatter"),
            "msg-c (routed after msg-b) must stay queued for the next turn; got: {last}"
        );

        // After the prompt fires, msg-c sits alone in the silent queue —
        // msg-a was already drained into the prefix above.
        let pending = &agents.get_handle("rt1").unwrap().pending_silent;
        assert_eq!(
            pending
                .iter()
                .map(|p| p.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["msg-c"],
            "only msg-c (post-prompt drive-by) should remain silent"
        );
    }

    #[tokio::test]
    async fn catchup_runtime_does_not_replay_after_cursor_advanced_in_memory() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([make_message_row(
                "msg-a",
                "session-1",
                "human-1",
                &["agent-actor"],
                "ask once",
                "2025-05-22T01:00:01Z",
            ),]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        assert!(fixture.server.catchup_runtime("rt1").await);
        {
            let agents = fixture.server.agents.lock().await;
            assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("ask once"),);
            assert_eq!(
                agents
                    .get_handle("rt1")
                    .unwrap()
                    .last_processed_message_id
                    .as_deref(),
                Some("msg-a"),
            );
        }

        // Session refresh → runtimeStart dedup → catchup must not re-prompt.
        assert!(!fixture.server.catchup_runtime("rt1").await);
        let agents = fixture.server.agents.lock().await;
        assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("ask once"));
    }

    #[tokio::test]
    async fn catchup_runtime_skips_prompt_when_last_mention_already_answered() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-user",
                    "session-1",
                    "human-1",
                    &["agent-actor"],
                    "please review",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-agent",
                    "session-1",
                    "agent-actor",
                    &[],
                    "done reviewing",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("rt1").await;

        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.last_sent_to("rt1").is_none(),
            "answered @mention must not trigger send_prompt on catchup"
        );
        assert_eq!(
            agents
                .get_handle("rt1")
                .unwrap()
                .last_processed_message_id
                .as_deref(),
            Some("msg-user"),
        );
    }

    #[tokio::test]
    async fn plan_skips_when_last_mention_already_answered() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_agent_runtime_row(&srv, "sess-answered", None, None, "claude").await;
        mock_messages_response(
            &srv,
            "sess-answered",
            serde_json::json!([
                make_message_row(
                    "msg-user",
                    "sess-answered",
                    "human-1",
                    &["agent-actor"],
                    "ping",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-agent",
                    "sess-answered",
                    "agent-actor",
                    &[],
                    "pong",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        add_membership(&mut fixture, "sess-answered").await;

        let plan = fixture.server.plan_auto_restart_offline_sessions().await;
        assert!(
            plan.is_empty(),
            "already-answered @mention should not schedule auto_restart"
        );
    }

    #[tokio::test]
    async fn catchup_runtime_with_no_mentions_routes_everything_silent() {
        let srv = MockServer::start().await;
        auth_token_mock(&srv).await;
        mock_messages_response(
            &srv,
            "session-1",
            serde_json::json!([
                make_message_row(
                    "msg-a",
                    "session-1",
                    "human-1",
                    &[],
                    "first chatter",
                    "2025-05-22T01:00:01Z",
                ),
                make_message_row(
                    "msg-b",
                    "session-1",
                    "human-2",
                    &[],
                    "second chatter",
                    "2025-05-22T01:00:02Z",
                ),
            ]),
        )
        .await;

        let mut fixture = test_server_with_cloud_api(test_cloud_api_with_url(srv.uri()));
        fixture.server.catchup_runtime("rt1").await;

        let agents = fixture.server.agents.lock().await;
        assert!(
            agents.last_sent_to("rt1").is_none(),
            "no @-mention → no send_prompt"
        );
        assert_eq!(
            agents.get_handle("rt1").unwrap().pending_silent.len(),
            2,
            "both messages should land in silent context"
        );
    }

    fn make_stored_session(
        runtime_id: &str,
        session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
        created_at: i64,
    ) -> StoredSession {
        StoredSession {
            runtime_id: runtime_id.to_string(),
            acp_session_id: format!("acp-{runtime_id}"),
            session_id: session_id.to_string(),
            agent_type: agent_type as i32,
            workspace_id: workspace_id.to_string(),
            worktree: "/tmp/wt".to_string(),
            status: amux::AgentStatus::Active as i32,
            created_at,
            last_prompt: String::new(),
            last_output_summary: String::new(),
            tool_use_count: 0,
        }
    }

    #[test]
    fn dedup_resumable_runtimes_keeps_only_newest_for_session() {
        // Same conversation accumulated several historical runtimes across
        // restarts / model-switches / workspace-changes. The daemon is one
        // participant, so only the single newest may resume; everything else
        // is superseded — including runtimes for other agent_types/workspaces.
        let stored = vec![
            make_stored_session("rt-old", "s1", amux::AgentType::ClaudeCode, "ws-1", 100),
            make_stored_session("rt-mid", "s1", amux::AgentType::ClaudeCode, "ws-1", 200),
            make_stored_session("rt-new", "s1", amux::AgentType::ClaudeCode, "ws-1", 300),
            make_stored_session("rt-other", "s1", amux::AgentType::Codex, "ws-1", 150),
        ];

        let (keep, mut superseded) =
            crate::daemon::session_resume::dedup_resumable_runtimes(stored);
        superseded.sort();

        assert_eq!(
            keep.iter()
                .map(|s| s.runtime_id.as_str())
                .collect::<Vec<_>>(),
            vec!["rt-new"],
            "keep only the single newest runtime for the session"
        );
        assert_eq!(
            superseded,
            vec![
                "rt-mid".to_string(),
                "rt-old".to_string(),
                "rt-other".to_string()
            ],
            "every other runtime is superseded regardless of agent_type/workspace"
        );
    }

    #[test]
    fn dedup_resumable_runtimes_collapses_across_workspaces() {
        // Two live runtimes in different workspaces for the same conversation
        // each answered the same @mention (the duplicate-reply bug). Only the
        // newest survives; the cross-workspace duplicate is superseded.
        let stored = vec![
            make_stored_session("rt-a", "s1", amux::AgentType::ClaudeCode, "ws-1", 100),
            make_stored_session("rt-b", "s1", amux::AgentType::ClaudeCode, "ws-2", 50),
        ];

        let (keep, superseded) = crate::daemon::session_resume::dedup_resumable_runtimes(stored);
        assert_eq!(
            keep.iter()
                .map(|s| s.runtime_id.as_str())
                .collect::<Vec<_>>(),
            vec!["rt-a"],
            "newest runtime wins across workspaces"
        );
        assert_eq!(
            superseded,
            vec!["rt-b".to_string()],
            "older cross-workspace duplicate is superseded"
        );
    }

    #[tokio::test]
    async fn duplicate_live_message_id_is_not_sent_to_runtime_twice() {
        let mut fixture = test_server();

        fixture
            .server
            .handle_incoming(live_message("session-1", "msg-1", "first"))
            .await;
        fixture
            .server
            .handle_incoming(live_message("session-1", "msg-1", "second"))
            .await;

        let agents = fixture.server.agents.lock().await;
        assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("first"));
    }

    #[tokio::test]
    async fn live_message_model_override_is_applied_before_prompt_routing() {
        let mut fixture = test_server();

        let msg = crate::proto::teamclaw::Message {
            message_id: "msg-model-1".to_string(),
            session_id: "session-1".to_string(),
            sender_actor_id: "human-actor".to_string(),
            kind: 0,
            content: "which model?".to_string(),
            created_at: 1,
            model: "opencode/deepseek-v4-flash-free".to_string(),
            ..Default::default()
        };
        let msg_env = crate::proto::teamclaw::SessionMessageEnvelope {
            message: Some(msg),
            mention_actor_ids: vec!["agent-actor".to_string()],
            ..Default::default()
        };
        let live = crate::proto::teamclaw::LiveEventEnvelope {
            event_id: "event-model-1".to_string(),
            event_type: "message.created".to_string(),
            session_id: "session-1".to_string(),
            actor_id: "human-actor".to_string(),
            sent_at: 1,
            body: msg_env.encode_to_vec(),
        };

        fixture
            .server
            .handle_incoming(subscriber::IncomingMessage::TeamclawSessionLive {
                session_id: "session-1".to_string(),
                payload: live.encode_to_vec(),
            })
            .await;

        let agents = fixture.server.agents.lock().await;
        assert_eq!(
            agents.current_model("rt1").map(|s| s.as_str()),
            Some("opencode/deepseek-v4-flash-free")
        );
        assert_eq!(agents.last_sent_to("rt1").as_deref(), Some("which model?"));
    }

    #[tokio::test]
    async fn register_startup_workspace_bootstraps_cwd_when_store_empty() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        ts.server
            .register_startup_workspace_at(Ok(workspace_dir.clone()))
            .await;

        assert_eq!(ts.server.workspaces.workspaces.len(), 1);
        assert_eq!(
            ts.server.workspaces.workspaces[0].path,
            workspace_dir.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            ts.server.workspaces.workspaces[0].remote_workspace_id,
            "remote-ws-1"
        );
        assert!(ts.server.workspaces_path.exists());
        assert_eq!(
            mock.state().default_workspace_ids,
            vec!["remote-ws-1".to_string()]
        );
    }

    #[tokio::test]
    async fn register_startup_workspace_skips_when_store_not_empty() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        ts.server
            .workspaces
            .workspaces
            .push(crate::config::StoredWorkspace {
                workspace_id: "existing".to_string(),
                remote_workspace_id: "remote-existing".to_string(),
                path: "/tmp/existing".to_string(),
                display_name: "existing".to_string(),
                team_id: None,
            });

        ts.server
            .register_startup_workspace_at(Ok(ts._tmp.path().to_path_buf()))
            .await;

        assert_eq!(ts.server.workspaces.workspaces.len(), 1);
        assert!(mock.state().default_workspace_ids.is_empty());
        assert!(!ts.server.workspaces_path.exists());
    }

    fn seed_startup_workspace_sync(
        mock: &Arc<crate::backend::mock::MockBackend>,
        display_name: &str,
        remote_id: &str,
    ) {
        mock.state().workspace_results.insert(
            (
                "team-test".to_string(),
                "agent-actor".to_string(),
                display_name.to_string(),
            ),
            crate::backend::WorkspaceRow {
                id: remote_id.to_string(),
            },
        );
    }

    #[tokio::test]
    async fn register_startup_workspace_skips_default_when_cloud_sync_fails() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();

        ts.server
            .register_startup_workspace_at(Ok(workspace_dir.clone()))
            .await;

        assert_eq!(ts.server.workspaces.workspaces.len(), 1);
        assert!(ts.server.workspaces.workspaces[0]
            .remote_workspace_id
            .is_empty());
        assert!(mock.state().default_workspace_ids.is_empty());
        assert!(ts.server.workspaces_path.exists());

        let saved = WorkspaceStore::load(&ts.server.workspaces_path).unwrap();
        assert_eq!(saved.workspaces.len(), 1);
        assert_eq!(
            saved.workspaces[0].path,
            workspace_dir.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[tokio::test]
    async fn register_startup_workspace_persists_local_when_default_update_fails() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");
        mock.state().set_default_workspace_error = Some("cloud rejected default".to_string());

        ts.server
            .register_startup_workspace_at(Ok(workspace_dir))
            .await;

        assert_eq!(
            ts.server.workspaces.workspaces[0].remote_workspace_id,
            "remote-ws-1"
        );
        assert!(mock.state().default_workspace_ids.is_empty());
        assert!(ts.server.workspaces_path.exists());

        let saved = WorkspaceStore::load(&ts.server.workspaces_path).unwrap();
        assert_eq!(saved.workspaces[0].remote_workspace_id, "remote-ws-1");
    }

    #[tokio::test]
    async fn register_startup_workspace_calls_cloud_upsert_before_default() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        ts.server
            .register_startup_workspace_at(Ok(workspace_dir.clone()))
            .await;

        let snap = mock.state();
        assert_eq!(snap.upserted_workspaces.len(), 1);
        assert_eq!(snap.upserted_workspaces[0].team_id, "team-test");
        assert_eq!(snap.upserted_workspaces[0].agent_id, "agent-actor");
        assert_eq!(snap.upserted_workspaces[0].name, display_name);
        assert_eq!(
            snap.upserted_workspaces[0].path.as_deref(),
            Some(workspace_dir.canonicalize().unwrap().to_str().unwrap())
        );
        assert_eq!(snap.default_workspace_ids, vec!["remote-ws-1".to_string()]);
    }

    #[tokio::test]
    async fn apply_add_workspace_sets_cloud_default_workspace() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        let add = amux::AddWorkspace {
            path: workspace_dir.to_string_lossy().to_string(),
        };
        let (accepted, error, workspace) = ts.server.apply_add_workspace(&add).await;

        assert!(accepted, "add workspace failed: {error}");
        assert!(workspace.is_some());
        assert_eq!(
            mock.state().default_workspace_ids,
            vec!["remote-ws-1".to_string()]
        );
    }

    #[tokio::test]
    async fn handle_add_workspace_sock_registers_and_is_idempotent() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());
        let workspace_dir = ts._tmp.path().to_path_buf();
        let display_name = workspace_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        seed_startup_workspace_sync(&mock, &display_name, "remote-ws-1");

        let reply = ts
            .server
            .handle_add_workspace_sock(&workspace_dir.to_string_lossy())
            .await;
        let value: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(value["ok"], serde_json::json!(true), "reply: {reply}");
        assert_eq!(
            value["result"]["path"].as_str().unwrap(),
            workspace_dir.canonicalize().unwrap().to_str().unwrap()
        );
        assert!(!value["result"]["workspace_id"].as_str().unwrap().is_empty());
        assert_eq!(ts.server.workspaces.workspaces.len(), 1);

        // Re-registering the same path is idempotent: still ok, no duplicate.
        let reply2 = ts
            .server
            .handle_add_workspace_sock(&workspace_dir.to_string_lossy())
            .await;
        let value2: serde_json::Value = serde_json::from_str(&reply2).unwrap();
        assert_eq!(value2["ok"], serde_json::json!(true));
        assert_eq!(ts.server.workspaces.workspaces.len(), 1);
    }

    #[tokio::test]
    async fn apply_add_and_remove_workspace_updates_refresh_watch_registry() {
        let mut ts = test_server();
        let registry =
            crate::runtime::refresh::refresh_watch::RefreshWatchRegistry::new(Vec::new());
        ts.server.refresh_watch_registry = Some(registry.clone());

        let workspace_dir = ts._tmp.path().join("watch-me");
        std::fs::create_dir_all(&workspace_dir).unwrap();

        let add = amux::AddWorkspace {
            path: workspace_dir.to_string_lossy().to_string(),
        };
        let (accepted, error, workspace) = ts.server.apply_add_workspace(&add).await;
        assert!(accepted, "add workspace failed: {error}");

        assert_eq!(
            registry.workspace_paths().await,
            vec![workspace_dir.canonicalize().unwrap()]
        );

        let workspace_id = workspace.unwrap().workspace_id;
        let (accepted, error) = ts
            .server
            .apply_remove_workspace(&amux::RemoveWorkspace { workspace_id })
            .await;
        assert!(accepted, "remove workspace failed: {error}");
        assert!(registry.workspace_paths().await.is_empty());
    }

    #[tokio::test]
    async fn register_startup_workspace_skips_when_current_dir_unavailable() {
        let mock = Arc::new(crate::backend::mock::MockBackend::with_identity(
            "team-test",
            "agent-actor",
        ));
        let mut ts = test_server_with_cloud_api(mock.clone());

        ts.server
            .register_startup_workspace_at(Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "missing cwd",
            )))
            .await;

        assert!(ts.server.workspaces.workspaces.is_empty());
        assert!(mock.state().default_workspace_ids.is_empty());
        assert!(!ts.server.workspaces_path.exists());
    }
}
