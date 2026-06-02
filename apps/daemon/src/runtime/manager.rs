use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};
use tracing::{info, warn};
use uuid::Uuid;

use super::acp_host::AcpHostPool;
use super::adapter;
use super::handle::RuntimeHandle;
use std::sync::Arc;

use crate::backend::{AgentRuntimeUpsert, Backend};
use crate::config::DaemonConfig;
use crate::proto::amux;
use crate::runtime::turn_aggregator::TurnAggregator;
use chrono::Utc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLaunchConfig {
    pub binary: String,
    pub args: Vec<String>,
    pub backend_type: &'static str,
}

impl AgentLaunchConfig {
    pub fn new(binary: impl Into<String>, args: Vec<String>, backend_type: &'static str) -> Self {
        Self {
            binary: binary.into(),
            args,
            backend_type,
        }
    }
}

/// Environment bundle passed when spawning an ACP-backed agent runtime.
#[derive(Debug, Clone, Default)]
pub struct SpawnRuntimeEnv {
    pub extra_env: HashMap<String, String>,
    /// When true, all keys in `extra_env` override the ACP host process environment.
    pub force_env_override: bool,
    /// Original `opencode.json` before MCP placeholder resolve; restored when the
    /// last runtime on this worktree stops.
    pub opencode_json_original: Option<String>,
}

struct WorktreeOpencodeSnapshot {
    original: String,
    secrets: HashMap<String, String>,
    ref_count: u32,
}

/// Per-agent runtime state checked out of `RuntimeManager` for the duration
/// of a single gateway turn. Owning the receiver here lets the turn-await
/// loop sit on `event_rx.recv().await` without holding the global manager
/// mutex, so concurrent turns on *different* agents stay parallel.
pub struct CheckedOutTurn {
    pub agent_id: String,
    pub event_rx: mpsc::Receiver<amux::AcpEvent>,
}

/// Sanitise an arbitrary logical-session-id string into a filename-safe
/// component. The gateway-minted acp_session_id values that drive the
/// path here are already hex, but we accept anything and replace
/// non-alphanumeric chars with `_` so callers can safely include
/// binding-derived ids without worrying about `/` or `:`.
fn sanitize_for_filename(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Path of the per-session MCP config file emitted before claude-code
/// is spawned. Filename is keyed by `logical_session_id` (the amuxd-side
/// session key — for gateway sessions this is the SQL-minted
/// `acp_session_id` hex) so the same file is reused if the runtime is
/// re-spawned under the same logical id (e.g. after `/reset`).
pub fn gateway_mcp_config_path(logical_session_id: &str) -> PathBuf {
    DaemonConfig::config_dir().join("mcp-configs").join(format!(
        "{}.json",
        sanitize_for_filename(logical_session_id)
    ))
}

/// Write the per-session MCP config that points claude-code at
/// amuxd's own `mcp-server` subcommand. The resulting file path is
/// passed to claude via `--mcp-config <path>`.
///
/// `logical_session_id` is what AmuxdAcpHandle uses as its map key
/// (gateway → SQL-minted acp_session_id); the MCP server forwards it
/// back to amuxd in the `mcp-send` envelope so the right channel can
/// be routed. `binding` is the URI for the gateway chat the session
/// is bound to — used as the default target for the `send` tool.
fn write_gateway_mcp_config(
    logical_session_id: &str,
    binding: &str,
) -> crate::error::Result<PathBuf> {
    let path = gateway_mcp_config_path(logical_session_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::error::AmuxError::Agent(format!(
                "write_gateway_mcp_config: mkdir {}: {e}",
                parent.display()
            ))
        })?;
    }
    let amuxd_bin = std::env::current_exe()
        .map_err(|e| crate::error::AmuxError::Agent(format!("current_exe(): {e}")))?;
    let sock = DaemonConfig::sock_path();
    let cfg = serde_json::json!({
        "mcpServers": {
            "amuxd-send": {
                "command": amuxd_bin.to_string_lossy(),
                "args": [
                    "mcp-server",
                    format!("--session-id={}", logical_session_id),
                    format!("--binding={}", binding),
                    format!("--sock={}", sock.to_string_lossy()),
                ],
            }
        }
    });
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| {
        crate::error::AmuxError::Agent(format!("write_gateway_mcp_config: serialize: {e}"))
    })?;
    std::fs::write(&path, body).map_err(|e| {
        crate::error::AmuxError::Agent(format!(
            "write_gateway_mcp_config: write {}: {e}",
            path.display()
        ))
    })?;
    Ok(path)
}

/// Translate a gateway-facing short model name ("sonnet", "opus", "haiku")
/// to the full ACP model id used by `claude-agent-acp`. Returns `None` for
/// unknown short names so callers can fall through to passing the input
/// verbatim (supports full ids like "claude-sonnet-4-6" without a separate
/// validation branch).
pub fn model_id_for_short_name(short: &str) -> Option<String> {
    match short {
        "sonnet" => Some("claude-sonnet-4-6".to_string()),
        "opus" => Some("claude-opus-4-7".to_string()),
        "haiku" => Some("claude-haiku-4-5".to_string()),
        _ => None,
    }
}

/// Resolve the initial ACP model id to apply for a gateway/cron session,
/// given the backend that will actually run and the caller's
/// `(provider, model)` override.
///
/// The ACP model-id shape differs per backend, so the `provider` segment must
/// be handled differently:
///
/// - **Claude Code**: model ids are bare (e.g. `claude-sonnet-4-6`). Short
///   names (`sonnet`/`opus`/`haiku`) map to full ids; `provider` is irrelevant
///   because the claude-code binary is anthropic-only.
/// - **OpenCode / Codex**: the ACP model id is itself `provider/model`
///   (e.g. `scnet/MiniMax-M2.5`), so we re-join the segments. The previous
///   behavior passed only the bare `model`, producing an id the agent could
///   not match — it silently fell back to its default model. Re-joining fixes
///   that. When `provider` is empty we pass `model` through unchanged.
pub fn resolve_initial_model(agent_type: amux::AgentType, provider: &str, model: &str) -> String {
    match agent_type {
        amux::AgentType::ClaudeCode => {
            model_id_for_short_name(model).unwrap_or_else(|| model.to_string())
        }
        _ => {
            if provider.is_empty() {
                model.to_string()
            } else {
                format!("{provider}/{model}")
            }
        }
    }
}

pub struct RuntimeManager {
    agents: HashMap<String, RuntimeHandle>,
    pub aggregators: std::collections::HashMap<String, TurnAggregator>,
    launch_configs: HashMap<amux::AgentType, AgentLaunchConfig>,
    acp_host_pool: AcpHostPool,
    /// Per-worktree MCP resolve snapshots; restored when the last agent on the worktree stops.
    opencode_snapshots: HashMap<String, WorktreeOpencodeSnapshot>,
    /// Tracks the model id currently applied to each agent's ACP session.
    /// Populated on spawn (after the adapter sends the initial set_model)
    /// and updated whenever set_current_model is called. The adapter is
    /// responsible for actually calling ACP `session/set_model`; this map
    /// is the daemon-side mirror used to populate RuntimeInfo.current_model.
    current_model_per_agent: HashMap<String, String>,
    /// Most recent slash commands reported via ACP `AvailableCommandsUpdate`,
    /// keyed by agent id. Cached so a fresh subscriber on the retained
    /// `runtime/{id}/state` topic sees the same list the agent already
    /// announced earlier on the (non-retained) events topic.
    available_commands_per_agent: HashMap<String, Vec<amux::AcpAvailableCommand>>,
    backend: Option<Arc<dyn Backend>>,
    /// agent_ids that were stopped by the idle sweeper and still need their
    /// terminal `runtime/{id}/state` publish + retain clear. Drained by the
    /// main event loop via `drain_evicted`. Manual `stop_agent` calls go
    /// through the RPC handler which publishes directly, so they do NOT
    /// enter this buffer.
    evicted_pending_publish: Vec<String>,
    /// Test-only: records the last body sent per agent_id via send_prompt_raw.
    #[cfg(test)]
    last_sent: HashMap<String, String>,
    #[cfg(test)]
    send_failures: HashMap<String, String>,
    #[cfg(test)]
    permission_log: Vec<(String, bool)>,
}

impl RuntimeManager {
    pub fn new(
        launch_configs: HashMap<amux::AgentType, AgentLaunchConfig>,
        backend: Option<Arc<dyn Backend>>,
    ) -> Self {
        Self {
            agents: HashMap::new(),
            aggregators: std::collections::HashMap::new(),
            launch_configs,
            acp_host_pool: AcpHostPool::new(),
            opencode_snapshots: HashMap::new(),
            current_model_per_agent: HashMap::new(),
            available_commands_per_agent: HashMap::new(),
            backend,
            evicted_pending_publish: Vec::new(),
            #[cfg(test)]
            last_sent: HashMap::new(),
            #[cfg(test)]
            send_failures: HashMap::new(),
            #[cfg(test)]
            permission_log: Vec::new(),
        }
    }

    pub fn default_launch_configs() -> HashMap<amux::AgentType, AgentLaunchConfig> {
        HashMap::from([(
            amux::AgentType::ClaudeCode,
            AgentLaunchConfig::new("claude", Vec::new(), "claude"),
        )])
    }

    /// Agent type used for sessions where the caller doesn't specify one
    /// (currently the gateway path — WeCom/Discord/Feishu/etc.). Prefers
    /// an explicitly-configured backend (`[agents.opencode]` or
    /// `[agents.codex]` in `daemon.toml`) over the always-present
    /// ClaudeCode fallback, so a daemon set up for opencode actually
    /// routes inbound channel messages to opencode.
    pub fn default_agent_type(&self) -> amux::AgentType {
        if self.launch_configs.contains_key(&amux::AgentType::Opencode) {
            amux::AgentType::Opencode
        } else if self.launch_configs.contains_key(&amux::AgentType::Codex) {
            amux::AgentType::Codex
        } else {
            amux::AgentType::ClaudeCode
        }
    }

    pub fn launch_config_for(&self, agent_type: amux::AgentType) -> AgentLaunchConfig {
        self.launch_configs
            .get(&agent_type)
            .cloned()
            .or_else(|| {
                self.launch_configs
                    .get(&amux::AgentType::ClaudeCode)
                    .cloned()
            })
            .unwrap_or_else(|| AgentLaunchConfig::new("claude", Vec::new(), "claude"))
    }

    /// Pre-warm shared ACP hosts so the first `runtimeStart` only pays for
    /// `session/new`, not process spawn + `initialize`.
    pub async fn prewarm_acp_hosts(&mut self) {
        self.acp_host_pool
            .prewarm(&self.launch_configs)
            .await;
    }

    /// Records the latest slash-command list for an agent. Callers feed
    /// this from the adapter's translated `AvailableCommands` events so
    /// `to_proto_info` can include them in retained state.
    pub fn set_available_commands(
        &mut self,
        agent_id: &str,
        commands: Vec<amux::AcpAvailableCommand>,
    ) {
        self.available_commands_per_agent
            .insert(agent_id.to_string(), commands);
    }

    /// Records that an agent's session is now running on `model_id`.
    /// Caller is responsible for actually invoking ACP set_model on the
    /// adapter; this only updates the tracking map.
    pub fn set_current_model(&mut self, agent_id: &str, model_id: &str) {
        self.current_model_per_agent
            .insert(agent_id.to_string(), model_id.to_string());
    }

    /// Returns the model id last recorded for `agent_id`, if any.
    pub fn current_model(&self, agent_id: &str) -> Option<&String> {
        self.current_model_per_agent.get(agent_id)
    }

    /// Returns a mutable reference to the per-agent `TurnAggregator`, if any.
    /// Inserted on `spawn_agent` / `resume_agent` and removed on `stop_agent`.
    pub fn aggregator_mut(&mut self, agent_id: &str) -> Option<&mut TurnAggregator> {
        self.aggregators.get_mut(agent_id)
    }

    /// Read-only access for the publish path to read `current_turn_id`
    /// without needing a mutable borrow.
    pub fn aggregator(&self, agent_id: &str) -> Option<&TurnAggregator> {
        self.aggregators.get(agent_id)
    }

    #[allow(dead_code)]
    pub async fn spawn_agent(
        &mut self,
        agent_type: amux::AgentType,
        worktree: &str,
        prompt: &str,
        workspace_id: &str,
        remote_workspace_id: Option<&str>,
        remote_session_id: Option<&str>,
    ) -> crate::error::Result<String> {
        self.spawn_agent_with_model(
            agent_type,
            worktree,
            prompt,
            workspace_id,
            remote_workspace_id,
            remote_session_id,
            None,
            None,
            None,
            SpawnRuntimeEnv::default(),
        )
        .await
    }

    /// Variant of `spawn_agent` that pins the initial ACP model. Used by
    /// `create_gateway_session_with_model` to honour a per-session
    /// `set_model` override the gateway recorded before the first prompt.
    /// `initial_model_override` is a full model id (e.g. "claude-sonnet-4-6"),
    /// not a short name — callers map short names via `model_id_for_short_name`.
    /// `mcp_config_path`, when `Some`, is forwarded as `--mcp-config <path>`
    /// to the spawned claude-code so it can call amuxd's `send` tool.
    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_agent_with_model(
        &mut self,
        agent_type: amux::AgentType,
        worktree: &str,
        prompt: &str,
        workspace_id: &str,
        remote_workspace_id: Option<&str>,
        remote_session_id: Option<&str>,
        initial_model_override: Option<String>,
        mcp_config_path: Option<PathBuf>,
        resume_acp_session_id: Option<String>,
        runtime_env: SpawnRuntimeEnv,
    ) -> crate::error::Result<String> {
        let agent_id = Uuid::new_v4().to_string()[..8].to_string();
        let SpawnRuntimeEnv {
            extra_env,
            force_env_override,
            opencode_json_original,
        } = runtime_env;
        self.register_opencode_snapshot(worktree, opencode_json_original, &extra_env);
        let mut handle = RuntimeHandle::new(
            agent_id.clone(),
            agent_type,
            worktree.into(),
            workspace_id.into(),
        );
        handle.current_prompt = prompt.into();
        handle.session_id = remote_session_id.unwrap_or_default().to_string();
        handle.available_models = crate::runtime::models::available_models_for(agent_type);

        let launch = self.launch_config_for(agent_type);
        let is_gateway = mcp_config_path.is_some();
        let resume_requested = resume_acp_session_id.is_some();
        let (cmd_tx, startup) = self
            .acp_host_pool
            .attach_session(
                agent_type,
                &launch,
                extra_env,
                force_env_override,
                worktree.to_string(),
                resume_acp_session_id,
                mcp_config_path,
                initial_model_override.clone(),
                prompt.to_string(),
                handle.event_tx.clone(),
                is_gateway,
            )
            .await?;

        handle.cmd_tx = Some(cmd_tx);

        self.agents.insert(agent_id.clone(), handle);
        self.aggregators
            .insert(agent_id.clone(), TurnAggregator::new());

        if let Some(h) = self.agents.get_mut(&agent_id) {
            h.available_models = startup.available_models;
            h.acp_session_id = startup.acp_session_id.clone();
            h.status = amux::AgentStatus::Active;
        }
        if resume_requested {
            info!(
                agent_id,
                worktree,
                backend_session_id = %startup.acp_session_id,
                "agent attached via shared ACP host (ACP resume requested)"
            );
        } else {
            info!(
                agent_id,
                worktree,
                backend_session_id = %startup.acp_session_id,
                "agent attached via shared ACP host"
            );
        }
        if let Some(model_id) = startup.initial_model {
            self.set_current_model(&agent_id, &model_id);
        }

        self.seed_cursor_from_prior_runtime(&agent_id, remote_session_id)
            .await;

        // Upsert agent_runtimes with status="starting"; capture the returned
        // row id so catchup_runtime can use update_runtime_cursor later.
        if let Some(sb) = &self.backend {
            let acp_sid = self
                .agents
                .get(&agent_id)
                .map(|h| h.acp_session_id.clone())
                .unwrap_or_default();
            let row = AgentRuntimeUpsert {
                team_id: sb.team_id(),
                agent_id: sb.actor_id(),
                session_id: remote_session_id,
                workspace_id: remote_workspace_id,
                backend_type: launch.backend_type,
                backend_session_id: if acp_sid.is_empty() {
                    None
                } else {
                    Some(&acp_sid)
                },
                runtime_id: Some(agent_id.as_str()),
                status: "starting",
                current_model: self
                    .current_model_per_agent
                    .get(&agent_id)
                    .map(|s| s.as_str()),
                last_seen_at: Utc::now(),
            };
            match sb.upsert_agent_runtime(&row).await {
                Ok(Some(row_id)) => {
                    if let Some(handle) = self.agents.get_mut(&agent_id) {
                        handle.backend_runtime_row_id = Some(row_id);
                    }
                }
                Ok(None) => warn!(agent_id, "upsert_agent_runtime returned no row id"),
                Err(e) => warn!("agent_runtimes upsert (starting): {e}"),
            }
        }

        Ok(agent_id)
    }

    /// Carry forward the `last_processed_message_id` cursor from a prior
    /// runtime row for the same `(agent_id, session_id)` pair. Without
    /// this, a fresh ACP backend session always lands on a brand-new
    /// `agent_runtimes` row (the upsert conflict key is
    /// `(agent_id, backend_session_id)`), so `catchup_runtime` would
    /// replay the entire session history on every daemon restart. We pull
    /// the latest row and seed the in-memory handle so catchup only
    /// replays truly-new messages.
    ///
    /// No-op when there is no backend client, no session id, no prior
    /// row, or the prior row's cursor is empty. Errors are logged and
    /// swallowed — the worst case on failure is a redundant replay, not a
    /// missed message.
    pub(crate) async fn seed_cursor_from_prior_runtime(
        &mut self,
        agent_id: &str,
        remote_session_id: Option<&str>,
    ) {
        let Some(sb) = self.backend.as_ref() else {
            return;
        };
        let Some(session_id) = remote_session_id else {
            return;
        };
        match sb
            .fetch_latest_runtime_for_session(sb.actor_id(), session_id)
            .await
        {
            Ok(Some(prior)) => {
                let cursor = prior.last_processed_message_id.filter(|s| !s.is_empty());
                if let Some(cursor) = cursor {
                    if let Some(h) = self.agents.get_mut(agent_id) {
                        info!(
                            agent_id,
                            session_id,
                            cursor = %cursor,
                            "seeded last_processed_message_id from prior runtime row",
                        );
                        h.last_processed_message_id = Some(cursor);
                    }
                }
            }
            Ok(None) => {}
            Err(e) => warn!(
                agent_id,
                session_id, "fetch_latest_runtime_for_session failed: {e}"
            ),
        }
    }

    pub async fn resume_agent(
        &mut self,
        agent_id: &str,
        acp_session_id: &str,
        agent_type: amux::AgentType,
        worktree: &str,
        workspace_id: &str,
        remote_workspace_id: Option<&str>,
        remote_session_id: Option<&str>,
        prompt: &str,
        runtime_env: SpawnRuntimeEnv,
    ) -> crate::error::Result<String> {
        let SpawnRuntimeEnv {
            extra_env,
            force_env_override,
            opencode_json_original,
        } = runtime_env;
        self.register_opencode_snapshot(worktree, opencode_json_original, &extra_env);

        let mut handle = RuntimeHandle::new(
            agent_id.to_string(),
            agent_type,
            worktree.into(),
            workspace_id.into(),
        );
        handle.session_id = remote_session_id.unwrap_or_default().to_string();

        let launch = self.launch_config_for(agent_type);
        let (cmd_tx, startup) = self
            .acp_host_pool
            .attach_session(
                agent_type,
                &launch,
                extra_env,
                force_env_override,
                worktree.to_string(),
                Some(acp_session_id.to_string()),
                None,
                None,
                prompt.to_string(),
                handle.event_tx.clone(),
                false,
            )
            .await?;

        handle.cmd_tx = Some(cmd_tx);
        handle.current_prompt = prompt.to_string();
        handle.available_models = crate::runtime::models::available_models_for(agent_type);

        info!(agent_id, worktree, "agent resumed via shared ACP host");
        self.agents.insert(agent_id.to_string(), handle);
        self.aggregators
            .insert(agent_id.to_string(), TurnAggregator::new());

        let new_acp_sid = startup.acp_session_id.clone();
        if let Some(h) = self.agents.get_mut(agent_id) {
            h.available_models = startup.available_models;
            h.acp_session_id = startup.acp_session_id;
            h.status = amux::AgentStatus::Active;
        }
        if let Some(model_id) = startup.initial_model {
            self.set_current_model(agent_id, &model_id);
        }

        self.seed_cursor_from_prior_runtime(agent_id, remote_session_id)
            .await;

        // Upsert agent_runtimes with status="starting" on resume
        if let Some(sb) = &self.backend {
            let row = AgentRuntimeUpsert {
                team_id: sb.team_id(),
                agent_id: sb.actor_id(),
                session_id: remote_session_id,
                workspace_id: remote_workspace_id,
                backend_type: launch.backend_type,
                backend_session_id: if new_acp_sid.is_empty() {
                    None
                } else {
                    Some(&new_acp_sid)
                },
                runtime_id: Some(agent_id),
                status: "starting",
                current_model: self
                    .current_model_per_agent
                    .get(agent_id)
                    .map(|s| s.as_str()),
                last_seen_at: Utc::now(),
            };
            match sb.upsert_agent_runtime(&row).await {
                Ok(Some(row_id)) => {
                    if let Some(handle) = self.agents.get_mut(agent_id) {
                        handle.backend_runtime_row_id = Some(row_id);
                    }
                }
                Ok(None) => warn!(
                    agent_id,
                    "upsert_agent_runtime returned no row id on resume"
                ),
                Err(e) => warn!("agent_runtimes upsert (starting/resume): {e}"),
            }
        }

        Ok(new_acp_sid)
    }

    /// Re-bind a live runtime with freshly assembled env (after env-var edits or
    /// dedup reuse on `runtimeStart`).
    pub async fn refresh_agent_runtime_env(
        &mut self,
        agent_id: &str,
        runtime_env: SpawnRuntimeEnv,
    ) -> crate::error::Result<()> {
        let (acp_sid, agent_type, worktree, workspace_id, session_id) = {
            let Some(handle) = self.agents.get(agent_id) else {
                return Err(crate::error::AmuxError::Agent(format!(
                    "refresh_agent_runtime_env: agent {agent_id} not found"
                )));
            };
            if handle.acp_session_id.is_empty() {
                return Ok(());
            }
            (
                handle.acp_session_id.clone(),
                handle.agent_type,
                handle.worktree.clone(),
                handle.workspace_id.clone(),
                handle.session_id.clone(),
            )
        };

        self.stop_agent(agent_id).await;
        self.resume_agent(
            agent_id,
            &acp_sid,
            agent_type,
            &worktree,
            &workspace_id,
            None,
            (!session_id.is_empty()).then_some(session_id.as_str()),
            "",
            runtime_env,
        )
        .await?;
        Ok(())
    }

    pub async fn stop_agent(&mut self, agent_id: &str) -> Option<RuntimeHandle> {
        if let Some(mut handle) = self.agents.remove(agent_id) {
            self.aggregators.remove(agent_id);
            self.release_opencode_snapshot(&handle.worktree);
            handle.status = amux::AgentStatus::Stopped;
            handle.shutdown().await;
            info!(agent_id, "agent stopped");
            Some(handle)
        } else {
            None
        }
    }

    fn register_opencode_snapshot(
        &mut self,
        worktree: &str,
        original: Option<String>,
        secrets: &HashMap<String, String>,
    ) {
        let Some(original) = original else {
            return;
        };
        let entry = self
            .opencode_snapshots
            .entry(worktree.to_string())
            .or_insert_with(|| WorktreeOpencodeSnapshot {
                original: original.clone(),
                secrets: secrets.clone(),
                ref_count: 0,
            });
        entry.original = original;
        entry.secrets = secrets.clone();
        entry.ref_count = entry.ref_count.saturating_add(1);
    }

    fn release_opencode_snapshot(&mut self, worktree: &str) {
        let Some(entry) = self.opencode_snapshots.get_mut(worktree) else {
            return;
        };
        entry.ref_count = entry.ref_count.saturating_sub(1);
        if entry.ref_count > 0 {
            return;
        }
        let snapshot = self.opencode_snapshots.remove(worktree).expect("entry exists");
        if let Err(err) = teamclaw_runtime_env::mcp_resolve::restore_config(
            Path::new(worktree),
            &Some(snapshot.original),
            &snapshot.secrets,
        ) {
            warn!(
                worktree,
                error = %err,
                "failed to restore opencode.json after runtime stop"
            );
        }
    }

    fn workspace_runtime_matches(
        handle: &RuntimeHandle,
        workspace_path: &str,
        workspace_id: &str,
    ) -> bool {
        handle.worktree == workspace_path
            || handle.workspace_id == workspace_path
            || handle.workspace_id == workspace_id
    }

    /// Active runtimes bound to a workspace path or id.
    pub fn active_handles_for_workspace<'a>(
        &'a self,
        workspace_path: &'a str,
        workspace_id: &'a str,
    ) -> impl Iterator<Item = (&'a String, &'a RuntimeHandle)> + 'a {
        self.agents.iter().filter(move |(_, handle)| {
            Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
                && matches!(
                    handle.status,
                    amux::AgentStatus::Starting
                        | amux::AgentStatus::Active
                        | amux::AgentStatus::Idle
                )
        })
    }

    /// Invalidate long-lived OpenCode/Codex ACP hosts after provider credentials change.
    pub fn evict_acp_hosts_after_provider_auth_change(&mut self) {
        let removed = self.acp_host_pool.evict_agent_types(&[
            amux::AgentType::Opencode,
            amux::AgentType::Codex,
        ]);
        if removed > 0 {
            info!(
                removed,
                "evicted ACP hosts so new sessions pick up provider auth"
            );
        }
    }

    /// Stop all runtimes for a workspace (used after settings reload).
    pub async fn stop_runtimes_for_workspace(
        &mut self,
        workspace_path: &str,
        workspace_id: &str,
    ) -> usize {
        let ids: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, handle)| {
                Self::workspace_runtime_matches(handle, workspace_path, workspace_id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut stopped = 0usize;
        for id in ids {
            if self.stop_agent(&id).await.is_some() {
                stopped += 1;
            }
        }
        stopped
    }

    /// Stop every runtime whose `last_active_at` is older than
    /// `now - threshold_secs`. Skips runtimes whose `event_rx` is currently
    /// checked out (a gateway turn is in flight). Returns the list of
    /// agent_ids that were stopped — and also buffers them on
    /// `evicted_pending_publish` so the daemon main loop can clear retained
    /// state. Called by the daemon's idle sweeper task.
    pub async fn evict_idle(&mut self, threshold_secs: i64) -> Vec<String> {
        let now = chrono::Utc::now().timestamp();
        let cutoff = now - threshold_secs;
        let stale: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, h)| h.event_rx.is_some() && h.last_active_at <= cutoff)
            .map(|(id, _)| id.clone())
            .collect();
        let mut evicted = Vec::with_capacity(stale.len());
        for id in stale {
            if self.stop_agent(&id).await.is_some() {
                info!(
                    agent_id = %id,
                    threshold_secs,
                    "idle sweeper: evicted runtime"
                );
                evicted.push(id);
            }
        }
        self.evicted_pending_publish.extend(evicted.iter().cloned());
        evicted
    }

    /// Drain the buffer of idle-evicted agent_ids whose terminal MQTT state
    /// still needs publishing. Called once per main-loop tick.
    pub fn drain_evicted(&mut self) -> Vec<String> {
        std::mem::take(&mut self.evicted_pending_publish)
    }

    /// Send a prompt to an existing agent via ACP, draining any pending_silent
    /// messages as a `[Context …]` prefix first.
    /// Returns the drained message IDs (empty when no pending context existed).
    pub async fn send_prompt(
        &mut self,
        agent_id: &str,
        text: &str,
        attachment_urls: Vec<String>,
    ) -> crate::error::Result<Vec<String>> {
        let (final_text, drained_ids, drained_messages) =
            if let Some(handle) = self.agents.get_mut(agent_id) {
                let drained_messages = handle.pending_silent.clone();
                let (prefix, drained) = handle.flush_pending_silent();
                let final_text = if prefix.is_empty() {
                    text.to_string()
                } else {
                    format!("{prefix}{text}")
                };
                (final_text, drained, drained_messages)
            } else {
                return Err(crate::error::AmuxError::Agent(format!(
                    "agent {} not found",
                    agent_id
                )));
            };

        if let Err(err) = self
            .send_prompt_raw(agent_id, &final_text, attachment_urls)
            .await
        {
            if !drained_messages.is_empty() {
                if let Some(handle) = self.agents.get_mut(agent_id) {
                    let mut restored = drained_messages;
                    restored.append(&mut handle.pending_silent);
                    handle.pending_silent = restored;
                }
            }
            return Err(err);
        }
        if let Some(handle) = self.agents.get_mut(agent_id) {
            handle.status = amux::AgentStatus::Active;
            handle.current_prompt = text.to_string();
        }
        Ok(drained_ids)
    }

    /// Inner helper: send the given body to ACP without any prefix logic.
    pub async fn send_prompt_raw(
        &mut self,
        agent_id: &str,
        text: &str,
        attachment_urls: Vec<String>,
    ) -> crate::error::Result<()> {
        #[cfg(test)]
        {
            let _ = &attachment_urls;
            if let Some(message) = self.send_failures.remove(agent_id) {
                return Err(crate::error::AmuxError::Agent(message));
            }
            let event_tx = if let Some(h) = self.agents.get_mut(agent_id) {
                h.bump_activity();
                Some(h.event_tx.clone())
            } else {
                None
            };
            self.last_sent
                .insert(agent_id.to_string(), text.to_string());
            if let Some(event_tx) = event_tx {
                let text = text.to_string();
                tokio::spawn(async move {
                    let _ = event_tx
                        .send(amux::AcpEvent {
                            event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                                text,
                                is_complete: true,
                            })),
                            model: String::new(),
                        })
                        .await;
                });
            }
            return Ok(());
        }
        #[cfg(not(test))]
        {
            let handle = self.agents.get_mut(agent_id).ok_or_else(|| {
                crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
            })?;
            handle.bump_activity();
            handle.send_prompt(text, attachment_urls).await
        }
    }

    /// Public wrapper used by the SetModel RPC handler. Forwards to the
    /// adapter and immediately mirrors the choice into
    /// `current_model_per_agent` so retained `runtime/{id}/state` reflects
    /// the request without waiting for an out-of-band ack from the adapter.
    /// `runtime_id` is the same key `send_prompt` / `stop_agent` use.
    pub async fn set_model(
        &mut self,
        runtime_id: &str,
        model_id: &str,
    ) -> crate::error::Result<()> {
        self.send_set_model(runtime_id, model_id).await?;
        self.set_current_model(runtime_id, model_id);
        Ok(())
    }

    /// Apply `desired_model` when it differs from the runtime's current model.
    /// Returns true when a new model was forwarded to ACP.
    pub async fn maybe_apply_model(&mut self, runtime_id: &str, desired_model: &str) -> bool {
        let desired = desired_model.trim();
        if desired.is_empty() {
            return false;
        }
        let current = self
            .current_model(runtime_id)
            .cloned()
            .unwrap_or_default();
        if desired == current {
            return false;
        }
        match self.set_model(runtime_id, desired).await {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    runtime_id,
                    model_id = desired,
                    "maybe_apply_model failed: {e}"
                );
                false
            }
        }
    }

    /// Forward a `SetModel` command onto the agent's ACP command channel.
    /// The adapter is responsible for performing `session/set_model`; the
    /// caller is responsible for updating `current_model_per_agent` once the
    /// command has been queued (we cannot wait for the adapter to confirm
    /// without changing the channel contract).
    pub async fn send_set_model(
        &mut self,
        agent_id: &str,
        model_id: &str,
    ) -> crate::error::Result<()> {
        #[cfg(test)]
        {
            if !self.agents.contains_key(agent_id) {
                return Err(crate::error::AmuxError::Agent(format!(
                    "agent {} not found",
                    agent_id
                )));
            }
            let _ = model_id;
            return Ok(());
        }

        #[cfg(not(test))]
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;
        #[cfg(not(test))]
        let tx = handle
            .cmd_tx
            .as_ref()
            .ok_or_else(|| crate::error::AmuxError::Agent("no ACP command channel".into()))?;
        #[cfg(not(test))]
        tx.send(adapter::AcpCommand::SetModel {
            acp_session_id: handle.acp_session_id.clone(),
            model_id: model_id.to_string(),
        })
        .await
        .map_err(|_| crate::error::AmuxError::Agent("ACP command channel closed".into()))
    }

    /// Returns an agent_id whose adapter has finished initializing and is ready
    /// for prompts. Excludes Starting (transient) and dead statuses -- an agent
    /// in Starting may crash before becoming Active, and baking that into a
    /// session's `primary_agent_id` would point to a dead slot.
    /// Used to populate the `primary_agent_id` of newly created collab sessions
    /// in v1 (multi-agent sessions are out of scope).
    /// Whether any agent infrastructure is available: either an active session
    /// or a prewarmed ACP host. Used by `handle_prompt_await` to gate cron
    /// execution without requiring the Tauri app to have created a session
    /// first (which would break cron on fresh daemon starts).
    pub fn agent_count(&self) -> usize {
        self.agents.len() + self.acp_host_pool.host_count()
    }

    pub fn first_running_agent_id(&self) -> Option<String> {
        self.agents
            .iter()
            .find(|(_, h)| {
                matches!(
                    h.status,
                    amux::AgentStatus::Active | amux::AgentStatus::Idle
                )
            })
            .map(|(id, _)| id.clone())
    }

    pub fn running_agent_id_for_collab_session(&self, session_id: &str) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| {
                h.session_id == session_id
                    && matches!(
                        h.status,
                        amux::AgentStatus::Active | amux::AgentStatus::Idle
                    )
            })
            .map(|(id, _)| id.clone())
    }

    /// Cancel the current turn for an agent.
    pub async fn cancel_agent(&mut self, agent_id: &str) -> crate::error::Result<()> {
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;

        handle.cancel().await
    }

    /// Cancel the in-flight turn for the agent identified by `acp_sid`
    /// (the 36-char uuid stored on `RuntimeHandle.acp_session_id`).
    /// Used by `AmuxdAcpHandle::cancel` to translate a gateway-side logical
    /// id (resolved via `logical_to_acp`) into a runtime handle without
    /// the gateway needing to know about the daemon's 8-char `agent_id`.
    pub async fn cancel_by_acp_session(&mut self, acp_sid: &str) -> crate::error::Result<()> {
        let agent_id = self.agent_id_by_acp_session(acp_sid).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("no runtime for acp_session_id {acp_sid}"))
        })?;
        let handle = self.agents.get(&agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("handle missing for agent_id {agent_id}"))
        })?;
        handle.cancel().await
    }

    /// Reply to a pending permission request for an agent.
    pub async fn reply_permission(
        &mut self,
        agent_id: &str,
        request_id: &str,
        granted: bool,
    ) -> crate::error::Result<()> {
        #[cfg(test)]
        {
            if !self.agents.contains_key(agent_id) {
                return Err(crate::error::AmuxError::Agent(format!(
                    "agent {} not found",
                    agent_id
                )));
            }
            self.permission_log
                .push((request_id.to_string(), granted));
            return Ok(());
        }

        #[cfg(not(test))]
        let handle = self.agents.get(agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {} not found", agent_id))
        })?;
        #[cfg(not(test))]
        handle.resolve_permission(request_id, granted).await
    }

    /// Backward-compatible alias for older call sites that still speak
    /// in terms of permission resolution.
    pub async fn resolve_permission(
        &mut self,
        agent_id: &str,
        request_id: &str,
        granted: bool,
    ) -> crate::error::Result<()> {
        self.reply_permission(agent_id, request_id, granted).await
    }

    pub async fn restart_session(&mut self, agent_id: &str) -> crate::error::Result<()> {
        if self.stop_agent(agent_id).await.is_some() {
            Ok(())
        } else {
            Err(crate::error::AmuxError::Agent(format!(
                "agent {} not found",
                agent_id
            )))
        }
    }

    /// Map a command-topic runtime id to a live agent key. Desktop clients can
    /// target a stale spawn id from an old MQTT retain; when exactly one
    /// active runtime exists, route the grant/deny there instead.
    pub fn resolve_permission_runtime_key(&self, topic_runtime_id: &str) -> Option<String> {
        if self.agents.contains_key(topic_runtime_id) {
            return Some(topic_runtime_id.to_string());
        }
        let active: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, h)| {
                matches!(
                    h.status,
                    amux::AgentStatus::Starting
                        | amux::AgentStatus::Active
                        | amux::AgentStatus::Idle
                )
            })
            .map(|(id, _)| id.clone())
            .collect();
        if active.len() == 1 {
            return Some(active[0].clone());
        }
        None
    }

    /// Like [`resolve_permission`] but retargets stale topic runtime ids.
    pub async fn resolve_permission_for_topic(
        &mut self,
        topic_runtime_id: &str,
        request_id: &str,
        granted: bool,
    ) -> crate::error::Result<()> {
        let agent_key = self
            .resolve_permission_runtime_key(topic_runtime_id)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(format!("agent {} not found", topic_runtime_id))
            })?;
        if agent_key != topic_runtime_id {
            tracing::warn!(
                requested_runtime_id = topic_runtime_id,
                resolved_runtime_id = %agent_key,
                "permission response retargeted to active runtime"
            );
        }
        self.resolve_permission(&agent_key, request_id, granted)
            .await
    }

    pub fn get_handle(&self, agent_id: &str) -> Option<&RuntimeHandle> {
        self.agents.get(agent_id)
    }

    /// Find an existing live runtime matching the (session_id, agent_type,
    /// workspace_id) key. Used by `apply_start_runtime` to dedupe duplicate
    /// `RuntimeStart` RPCs from misbehaving clients into a single spawn.
    ///
    /// Bare-agent spawns (empty `session_id`) are never deduped — every such
    /// call gets its own runtime. `stop_agent` removes handles from the map,
    /// so anything present here is by definition still tracked; the caller
    /// reads `AgentStatus` off the retained state topic if it cares about
    /// liveness.
    /// Tuple-exact lookup `(session_id, agent_type, workspace_id)`.
    ///
    /// Retained for reference/tests: `apply_start_runtime` now enforces the
    /// stronger "one live runtime per session" invariant directly (reuse the
    /// tuple-exact match, supersede the rest), so this is no longer on the
    /// runtime-start hot path.
    #[allow(dead_code)]
    pub fn find_active_runtime_for(
        &self,
        session_id: &str,
        agent_type: amux::AgentType,
        workspace_id: &str,
    ) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| {
                h.session_id == session_id
                    && h.agent_type == agent_type
                    && h.workspace_id == workspace_id
                    && matches!(
                        h.status,
                        amux::AgentStatus::Starting
                            | amux::AgentStatus::Active
                            | amux::AgentStatus::Idle
                    )
            })
            .map(|(id, _)| id.clone())
    }

    pub fn get_handle_mut(&mut self, agent_id: &str) -> Option<&mut RuntimeHandle> {
        self.agents.get_mut(agent_id)
    }

    /// Advance the in-memory replay cursor after routing a session message.
    /// The backend row is updated separately; both must stay in sync so a
    /// later dedup catchup does not re-prompt already-handled rows.
    pub fn advance_message_cursor(&mut self, runtime_id: &str, message_id: &str) {
        if message_id.is_empty() {
            return;
        }
        if let Some(h) = self.agents.get_mut(runtime_id) {
            h.last_processed_message_id = Some(message_id.to_string());
        }
    }

    /// Drain events from all agents, returns (agent_id, event) pairs.
    ///
    /// Agents whose `event_rx` has been checked out by a gateway turn are
    /// skipped — that owner is responsible for forwarding/aggregating its
    /// own events for the duration of the turn and will hand the receiver
    /// back afterwards.
    pub fn poll_events(&mut self) -> Vec<(String, amux::AcpEvent)> {
        self.poll_events_inner(|_| true)
    }

    /// Drain queued ACP events only for agents accepted by `allow`. Lets a
    /// secondary consumer (e.g. the HTTP/SSE adapter) drain *only* the
    /// runtimes it owns, instead of competing with the MQTT main loop's
    /// `poll_events()` over the single-consumer per-agent channel. Events for
    /// runtimes the secondary consumer does not own stay queued for the main
    /// loop, which is what publishes them to `session/live`.
    pub fn poll_events_for(
        &mut self,
        allow: &std::collections::HashSet<String>,
    ) -> Vec<(String, amux::AcpEvent)> {
        self.poll_events_inner(|agent_id| allow.contains(agent_id))
    }

    fn poll_events_inner(
        &mut self,
        allow: impl Fn(&str) -> bool,
    ) -> Vec<(String, amux::AcpEvent)> {
        let mut events = vec![];
        for (agent_id, handle) in &mut self.agents {
            if !allow(agent_id) {
                continue;
            }
            let mut got_any = false;
            if let Some(rx) = handle.event_rx.as_mut() {
                while let Ok(event) = rx.try_recv() {
                    events.push((agent_id.clone(), event));
                    got_any = true;
                }
            }
            if got_any {
                handle.bump_activity();
            }
        }
        events
    }

    /// Look up the agent for `acp_session_id`, take its `event_rx` out of
    /// the manager-owned handle, and return the bits needed to drive a
    /// turn without holding the global mutex. Caller MUST eventually call
    /// `checkin_turn` (or the channel stays parked and `poll_events`
    /// silently drops the agent's events).
    pub fn checkout_turn_for_acp(
        &mut self,
        acp_session_id: &str,
    ) -> crate::error::Result<(CheckedOutTurn, std::sync::Arc<tokio::sync::Mutex<()>>)> {
        let agent_id = self
            .agent_id_by_acp_session(acp_session_id)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(format!(
                    "no agent for acp_session_id {acp_session_id}"
                ))
            })?;
        let handle = self.agents.get_mut(&agent_id).ok_or_else(|| {
            crate::error::AmuxError::Agent(format!("agent {agent_id} disappeared during checkout"))
        })?;
        let event_rx = handle.event_rx.take().ok_or_else(|| {
            crate::error::AmuxError::Agent(format!(
                "agent {agent_id} event_rx already checked out (concurrent turn?)"
            ))
        })?;
        let turn_lock = handle.turn_lock.clone();
        Ok((CheckedOutTurn { agent_id, event_rx }, turn_lock))
    }

    /// Hand the per-agent `event_rx` back so daemon `poll_events` resumes
    /// draining and follow-up turns can take it out again. Idempotent: if
    /// the agent has been removed in the meantime, the receiver is dropped.
    pub fn checkin_turn(&mut self, turn: CheckedOutTurn) {
        if let Some(handle) = self.agents.get_mut(&turn.agent_id) {
            handle.event_rx = Some(turn.event_rx);
        }
    }

    pub fn to_proto_agent_list(&self) -> amux::AgentList {
        amux::AgentList {
            runtimes: self
                .agents
                .iter()
                .map(|(id, h)| {
                    let current = self
                        .current_model_per_agent
                        .get(id)
                        .cloned()
                        .unwrap_or_default();
                    let commands = self
                        .available_commands_per_agent
                        .get(id)
                        .cloned()
                        .unwrap_or_default();
                    h.to_proto_info(current, commands)
                })
                .collect(),
        }
    }

    /// Build a `RuntimeInfo` for a single agent, populating the model fields
    /// from the manager's tracking state. Returns None if the agent is unknown.
    pub fn to_proto_info(&self, agent_id: &str) -> Option<amux::RuntimeInfo> {
        let handle = self.agents.get(agent_id)?;
        let current = self
            .current_model_per_agent
            .get(agent_id)
            .cloned()
            .unwrap_or_default();
        let commands = self
            .available_commands_per_agent
            .get(agent_id)
            .cloned()
            .unwrap_or_default();
        Some(handle.to_proto_info(current, commands))
    }

    #[allow(dead_code)]
    pub fn agent_ids(&self) -> Vec<String> {
        self.agents.keys().cloned().collect()
    }

    /// Return all runtime IDs whose handle has `session_id == session_id`.
    pub fn runtime_ids_for_session(&self, session_id: &str) -> Vec<String> {
        self.agents
            .iter()
            .filter(|(_, h)| h.session_id == session_id)
            .map(|(rid, _)| rid.clone())
            .collect()
    }

    /// Among in-memory runtimes bound to `session_id`, return the one with
    /// the greatest `started_at`. Defense-in-depth when multiple runtimes
    /// leaked despite the one-runtime-per-session invariant.
    pub fn newest_runtime_id_for_session(&self, session_id: &str) -> Option<String> {
        self.agents
            .iter()
            .filter(|(_, h)| h.session_id == session_id)
            .max_by_key(|(_, h)| h.started_at)
            .map(|(id, _)| id.clone())
    }

    /// Return the `agent_id` stored on the handle for the given runtime key.
    /// For handles created by spawn/resume, this equals the runtime key itself.
    pub fn agent_id_of(&self, runtime_id: &str) -> Option<String> {
        self.agents.get(runtime_id).map(|h| h.agent_id.clone())
    }

    /// Return the backend `agent_runtimes.id` for this runtime, if known.
    /// Currently `None` until Task 9 wires the upsert return value back here.
    pub fn backend_runtime_row_id(&self, runtime_id: &str) -> Option<String> {
        self.agents
            .get(runtime_id)
            .and_then(|h| h.backend_runtime_row_id.clone())
    }

    pub fn set_backend_runtime_metadata(
        &mut self,
        runtime_id: &str,
        row_id: Option<String>,
        last_processed_message_id: Option<String>,
    ) {
        if let Some(handle) = self.agents.get_mut(runtime_id) {
            if row_id.is_some() {
                handle.backend_runtime_row_id = row_id;
            }
            if last_processed_message_id.is_some() {
                handle.last_processed_message_id = last_processed_message_id;
            }
        }
    }

    // ── Gateway adapter hooks ────────────────────────────────────────────────
    //
    // The methods below are called from the `channels::AmuxdAcpHandle`
    // (impl of `teamclaw_gateway::AcpHandle`) so a gateway can drive an
    // in-process ACP agent without speaking to opencode's HTTP server.

    /// Look up an agent runtime by its ACP session id (the 36-char uuid
    /// returned by `session/new` and stored on `RuntimeHandle.acp_session_id`).
    /// Returns the daemon-side 8-char `agent_id` key used by `send_prompt`.
    pub fn agent_id_by_acp_session(&self, acp_session_id: &str) -> Option<String> {
        if acp_session_id.is_empty() {
            return None;
        }
        self.agents
            .iter()
            .find(|(_, h)| h.acp_session_id == acp_session_id)
            .map(|(id, _)| id.clone())
    }

    /// Spawn an ACP-backed agent for a freshly-bound gateway conversation.
    /// Used by `AmuxdAcpHandle::create_session`. The returned String is the
    /// agent's `acp_session_id`, which the gateway persists on its `Binding`.
    ///
    /// `logical_session_id` is the amuxd-side key the caller maps to the
    /// real ACP UUID (for gateway sessions this is the SQL-minted
    /// `acp_session_id` hex). It's used to name the per-session MCP config
    /// file and is forwarded back to amuxd by the spawned `mcp-server`.
    #[allow(dead_code)]
    pub async fn create_gateway_session(
        &mut self,
        team_id: &str,
        logical_session_id: &str,
        binding: &str,
        title: &str,
        device_id: &str,
        device_name: &str,
    ) -> crate::error::Result<String> {
        self.create_gateway_session_with_model(
            team_id,
            logical_session_id,
            binding,
            title,
            None,
            None,
            None,
            None,
            device_id,
            device_name,
        )
        .await
    }

    /// Variant of `create_gateway_session` that honours a per-session model
    /// override. The gateway's `AmuxdAcpHandle` resolves the override from
    /// its `model_override` map and passes it as `(provider, model)`. We
    /// translate the short name ("sonnet"/"opus"/"haiku") into the full ACP
    /// model id ("claude-sonnet-4-6", …) via `model_id_for_short_name`
    /// before threading through to the adapter. `provider` is currently
    /// unused (claude-code adapter == anthropic) but kept on the signature
    /// for future multi-provider routing.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_gateway_session_with_model(
        &mut self,
        team_id: &str,
        logical_session_id: &str,
        binding: &str,
        _title: &str,
        model_override: Option<(String, String)>,
        remote_session_id: Option<&str>,
        working_directory: Option<&str>,
        // Backend to run on. `None` falls back to `default_agent_type` (the
        // gateway path and "auto" cron selection); cron jobs that pin a backend
        // pass `Some(..)` so a job created for Claude does not run on OpenCode
        // just because OpenCode is the daemon default.
        agent_type_override: Option<amux::AgentType>,
        device_id: &str,
        device_name: &str,
    ) -> crate::error::Result<String> {
        // Gateway sessions don't yet have a "real" workspace concept — they
        // run against a freshly-created scratch dir so the ACP process has a
        // valid cwd. Future work can wire this through `default_workspace_id`
        // on the agent's `agents` row.
        //
        // `working_directory: Some(wd)` lets callers (e.g. cron's worktree mode)
        // spawn the agent in a directory they already prepared — amuxd does NOT
        // mkdir caller-supplied paths; the caller's lifecycle code owns that.
        // `None` keeps the legacy throwaway behavior so other gateway callers
        // (channels/acp_handle.rs etc.) are unaffected.
        let worktree = match working_directory {
            Some(wd) => wd.to_string(),
            None => {
                let scratch = format!(
                    "/tmp/amuxd-gateway-{}",
                    Uuid::new_v4().to_string()[..8].to_string()
                );
                std::fs::create_dir_all(&scratch).map_err(|e| {
                    crate::error::AmuxError::Agent(format!(
                        "create_gateway_session: mkdir {scratch}: {e}"
                    ))
                })?;
                scratch
            }
        };

        // Resolve the initial model against the backend that will actually
        // run this session. For OpenCode/Codex the ACP model id is
        // `provider/model`, so the override's provider segment must be
        // preserved — dropping it (the previous behavior) made the agent
        // silently fall back to its default model.
        let agent_type = agent_type_override.unwrap_or_else(|| self.default_agent_type());
        let initial_model: Option<String> = model_override
            .as_ref()
            .map(|(provider, model)| resolve_initial_model(agent_type, provider, model));

        // Write the MCP config BEFORE spawning claude-code so the
        // `--mcp-config` path it gets points at a real file. The config
        // mounts amuxd's own `mcp-server` subcommand which exposes the
        // `send` tool for proactive replies/file uploads back to the
        // gateway chat. Failures here are non-fatal — we still spawn
        // the agent (without the send tool) and log a warning so a
        // misconfigured config dir doesn't block gateway messaging.
        let mcp_cfg_path = match write_gateway_mcp_config(logical_session_id, binding) {
            Ok(p) => Some(p),
            Err(e) => {
                warn!(
                    error = %e,
                    binding,
                    logical_session_id,
                    "create_gateway_session: MCP config write failed; agent will spawn without send tool"
                );
                None
            }
        };

        let workspace_id = format!("gateway:{binding}");
        let skip_workspace_prepare = worktree.starts_with("/tmp/amuxd-gateway-");
        let runtime_env = crate::runtime::env_assembly::prepare_and_assemble_spawn_runtime_env(
            std::path::Path::new(&worktree),
            (!team_id.is_empty()).then_some(team_id),
            device_id,
            device_name,
            skip_workspace_prepare,
        );
        let agent_id = self
            .spawn_agent_with_model(
                agent_type,
                &worktree,
                "",
                &workspace_id,
                None,
                remote_session_id,
                initial_model,
                mcp_cfg_path,
                None,
                runtime_env,
            )
            .await?;

        let acp_sid = self
            .agents
            .get(&agent_id)
            .map(|h| h.acp_session_id.clone())
            .unwrap_or_default();

        if acp_sid.is_empty() {
            return Err(crate::error::AmuxError::Agent(
                "create_gateway_session: adapter did not report acp_session_id".into(),
            ));
        }
        Ok(acp_sid)
    }

    /// Send a prompt to the agent identified by `acp_session_id` and block
    /// until that turn's `AgentReply` text is available (or the 5-minute
    /// timeout elapses). Used by `AmuxdAcpHandle::send_prompt`.
    pub async fn send_prompt_and_await_reply(
        &mut self,
        acp_session_id: &str,
        prompt: &str,
        timeout_duration: Duration,
    ) -> crate::error::Result<super::turn_aggregator::EmittedMessage> {
        let agent_id = self
            .agent_id_by_acp_session(acp_session_id)
            .ok_or_else(|| {
                crate::error::AmuxError::Agent(format!(
                    "no agent for acp_session_id {acp_session_id}"
                ))
            })?;

        // Use send_prompt_raw to bypass the pending_silent drain — the
        // gateway already framed the prompt with sender context.
        // Gateway prompts carry no file attachments.
        self.send_prompt_raw(&agent_id, prompt, vec![]).await?;

        // Drive the per-runtime aggregator off the agent's event channel
        // until an `AgentReply` is emitted at Active→Idle. Hard cap so a
        // wedged backend can't pin a gateway worker forever.
        let deadline = std::time::Instant::now() + timeout_duration;

        loop {
            if std::time::Instant::now() >= deadline {
                return Err(crate::error::AmuxError::Agent("ACP turn timed out".into()));
            }

            // Wait for at least one event before draining.
            // NOTE: holds &mut RuntimeManager for the entire loop, so the
            // global manager mutex is locked until the turn finishes. Kept
            // for any legacy non-gateway caller; gateway agents now route
            // through `checkout_turn_for_acp` + `AmuxdAcpHandle::send_prompt`
            // which release the manager lock during `recv().await`.
            let next = {
                let handle = self.agents.get_mut(&agent_id).ok_or_else(|| {
                    crate::error::AmuxError::Agent(format!(
                        "agent {agent_id} disappeared while awaiting reply"
                    ))
                })?;
                let event_rx = handle.event_rx.as_mut().ok_or_else(|| {
                    crate::error::AmuxError::Agent(format!(
                        "agent {agent_id} event_rx checked out (a concurrent gateway turn is in progress)"
                    ))
                })?;
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                tokio::time::timeout(remaining, event_rx.recv()).await
            };

            let event = match next {
                Ok(Some(ev)) => ev,
                Ok(None) => {
                    return Err(crate::error::AmuxError::Agent(
                        "ACP event channel closed before reply".into(),
                    ));
                }
                Err(_) => {
                    return Err(crate::error::AmuxError::Agent("ACP turn timed out".into()));
                }
            };

            if let Some(amux::acp_event::Event::Error(err)) = &event.event {
                let details = if err.details.is_empty() {
                    err.message.clone()
                } else {
                    err.details.clone()
                };
                return Err(crate::error::AmuxError::Agent(format!(
                    "ACP turn failed: {details}"
                )));
            }

            // Feed the event into the aggregator and check whether an
            // AgentReply has been finalised (i.e. Active→Idle).
            let emitted = self
                .aggregators
                .get_mut(&agent_id)
                .map(|agg| agg.ingest(&event))
                .unwrap_or_default();

            for m in emitted {
                if matches!(m.kind, crate::proto::teamclaw::MessageKind::AgentReply) {
                    return Ok(m);
                }
            }
        }
    }

    /// Inject context for the agent without driving a turn. Stub for now —
    /// the underlying ACP adapter doesn't support a no-reply prompt yet, and
    /// the gateway call sites don't currently invoke this path. Returns Ok
    /// so the trait contract is satisfied.
    pub async fn inject_context(
        &self,
        _acp_session_id: &str,
        _sender_display: &str,
        _text: &str,
    ) -> crate::error::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
impl RuntimeManager {
    fn test_launch_configs() -> HashMap<amux::AgentType, AgentLaunchConfig> {
        Self::default_launch_configs()
    }

    /// Build a manager with a single dummy runtime pre-inserted, for tests.
    pub fn test_dummy_with_runtime(runtime_id: &str) -> Self {
        let mut mgr = RuntimeManager::new(Self::test_launch_configs(), None);
        let mut h = super::handle::RuntimeHandle::test_dummy();
        h.agent_id = runtime_id.to_string();
        mgr.agents.insert(runtime_id.to_string(), h);
        mgr
    }

    /// Insert a test runtime with explicit runtime_id, agent_id, and session_id.
    pub fn add_test_runtime(&mut self, runtime_id: &str, agent_id: &str, session_id: &str) {
        let mut h = super::handle::RuntimeHandle::test_dummy();
        h.agent_id = agent_id.to_string();
        h.session_id = session_id.to_string();
        self.agents.insert(runtime_id.to_string(), h);
    }

    /// Return the last body sent to the given runtime via send_prompt_raw.
    pub fn last_sent_to(&self, runtime_id: &str) -> Option<String> {
        self.last_sent.get(runtime_id).cloned()
    }

    pub fn fail_next_send_for(&mut self, runtime_id: &str, message: &str) {
        self.send_failures
            .insert(runtime_id.to_string(), message.to_string());
    }

    pub fn permission_log(&self) -> Vec<(String, bool)> {
        self.permission_log.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::super::handle::PendingMessage;
    use super::*;

    #[test]
    fn set_current_model_records_value() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.set_current_model("agent-1", "claude-sonnet-4-6");
        assert_eq!(
            mgr.current_model("agent-1").map(|s| s.as_str()),
            Some("claude-sonnet-4-6")
        );
    }

    #[test]
    fn current_model_returns_none_for_unknown_agent() {
        let mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        assert_eq!(mgr.current_model("agent-1"), None);
    }

    #[test]
    fn resolve_initial_model_claude_maps_short_name() {
        assert_eq!(
            resolve_initial_model(amux::AgentType::ClaudeCode, "anthropic", "sonnet"),
            "claude-sonnet-4-6"
        );
        assert_eq!(
            resolve_initial_model(amux::AgentType::ClaudeCode, "", "opus"),
            "claude-opus-4-7"
        );
    }

    #[test]
    fn resolve_initial_model_claude_passes_full_id_unchanged() {
        // A full claude id is not a known short name; it must pass through and
        // the provider segment must be ignored (the binary is anthropic-only).
        assert_eq!(
            resolve_initial_model(amux::AgentType::ClaudeCode, "anthropic", "claude-sonnet-4-6"),
            "claude-sonnet-4-6"
        );
    }

    #[test]
    fn resolve_initial_model_opencode_rejoins_provider() {
        // Regression: OpenCode ACP model ids are `provider/model`. Dropping the
        // provider made set_session_model miss and fall back to the default.
        assert_eq!(
            resolve_initial_model(amux::AgentType::Opencode, "scnet", "MiniMax-M2.5"),
            "scnet/MiniMax-M2.5"
        );
        assert_eq!(
            resolve_initial_model(amux::AgentType::Codex, "openai", "gpt-5.5"),
            "openai/gpt-5.5"
        );
    }

    #[test]
    fn resolve_initial_model_opencode_empty_provider_passes_model_through() {
        assert_eq!(
            resolve_initial_model(amux::AgentType::Opencode, "", "MiniMax-M2.5"),
            "MiniMax-M2.5"
        );
    }

    #[test]
    fn launch_config_for_opencode_uses_registered_backend() {
        let mut configs = RuntimeManager::test_launch_configs();
        configs.insert(
            amux::AgentType::Opencode,
            AgentLaunchConfig::new("opencode", vec!["acp".to_string()], "opencode"),
        );
        let mgr = RuntimeManager::new(configs, None);

        assert_eq!(
            mgr.launch_config_for(amux::AgentType::Opencode),
            AgentLaunchConfig::new("opencode", vec!["acp".to_string()], "opencode")
        );
    }

    // ── seed_cursor_from_prior_runtime ─────────────────────────────────────
    //
    // The spawn path calls into this helper to carry `last_processed_message_id`
    // forward from a prior agent_runtimes row. We can't easily exercise the
    // full spawn (it boots a real ACP subprocess), but we can verify the helper
    // populates the handle when (a) the Cloud API has a prior row and (b) does not
    // when the row is missing or its cursor is empty.

    use crate::backend::cloud_api::CloudApiBackend;
    use crate::provider_config::CloudApiConfig;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_cloud_api_with_url(url: String) -> Arc<dyn Backend> {
        Arc::new(CloudApiBackend::new(CloudApiConfig {
            url,
            refresh_token: "rt".into(),
            team_id: "t".into(),
            actor_id: "agent-actor".into(),
        }))
    }

    async fn auth_mock(srv: &MockServer) {
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

    fn dummy_handle(agent_id: &str, session_id: &str) -> RuntimeHandle {
        let mut h = RuntimeHandle::test_dummy();
        h.agent_id = agent_id.into();
        h.session_id = session_id.into();
        h
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_populates_handle() {
        let srv = MockServer::start().await;
        auth_mock(&srv).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "row-1",
                "backendSessionId": "acp-1",
                "lastProcessedMessageId": "msg-42"
            })))
            .mount(&srv)
            .await;

        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url(srv.uri())),
        );
        mgr.agents
            .insert("rt-X".into(), dummy_handle("rt-X", "sess-1"));

        mgr.seed_cursor_from_prior_runtime("rt-X", Some("sess-1"))
            .await;

        assert_eq!(
            mgr.agents
                .get("rt-X")
                .unwrap()
                .last_processed_message_id
                .as_deref(),
            Some("msg-42")
        );
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_noop_when_no_session_id() {
        // Without a session id we shouldn't touch the cloud backend. We deliberately
        // give the client a bogus URL so any HTTP call would explode.
        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url("http://127.0.0.1:1".into())),
        );
        mgr.agents.insert("rt-X".into(), dummy_handle("rt-X", ""));
        mgr.seed_cursor_from_prior_runtime("rt-X", None).await;
        assert!(mgr
            .agents
            .get("rt-X")
            .unwrap()
            .last_processed_message_id
            .is_none());
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_noop_when_no_prior_row() {
        let srv = MockServer::start().await;
        auth_mock(&srv).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "error": { "code": "not_found", "message": "no runtime" }
            })))
            .mount(&srv)
            .await;

        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url(srv.uri())),
        );
        mgr.agents
            .insert("rt-X".into(), dummy_handle("rt-X", "sess-1"));
        mgr.seed_cursor_from_prior_runtime("rt-X", Some("sess-1"))
            .await;
        assert!(mgr
            .agents
            .get("rt-X")
            .unwrap()
            .last_processed_message_id
            .is_none());
    }

    #[tokio::test]
    async fn seed_cursor_from_prior_runtime_noop_when_cursor_empty_string() {
        // An older daemon may have written an empty string instead of NULL.
        // Treat that as "no cursor".
        let srv = MockServer::start().await;
        auth_mock(&srv).await;
        Mock::given(method("GET"))
            .and(path("/v1/agents/runtimes/latest"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "row-1",
                "backendSessionId": "acp-1",
                "lastProcessedMessageId": ""
            })))
            .mount(&srv)
            .await;

        let mut mgr = RuntimeManager::new(
            RuntimeManager::test_launch_configs(),
            Some(test_cloud_api_with_url(srv.uri())),
        );
        mgr.agents
            .insert("rt-X".into(), dummy_handle("rt-X", "sess-1"));
        mgr.seed_cursor_from_prior_runtime("rt-X", Some("sess-1"))
            .await;
        assert!(mgr
            .agents
            .get("rt-X")
            .unwrap()
            .last_processed_message_id
            .is_none());
    }

    #[test]
    fn running_agent_id_for_collab_session_ignores_stopped_agents() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut stopped = RuntimeHandle::new(
            "stopped-1".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        stopped.session_id = "session-1".to_string();
        stopped.status = amux::AgentStatus::Stopped;

        let mut running = RuntimeHandle::new(
            "running-1".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        running.session_id = "session-1".to_string();
        running.status = amux::AgentStatus::Idle;

        mgr.agents.insert(stopped.agent_id.clone(), stopped);
        mgr.agents.insert(running.agent_id.clone(), running);

        assert_eq!(
            mgr.running_agent_id_for_collab_session("session-1")
                .as_deref(),
            Some("running-1")
        );
        assert_eq!(mgr.running_agent_id_for_collab_session("missing"), None);
    }

    #[test]
    fn find_active_runtime_for_matches_full_tuple() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut h = RuntimeHandle::new(
            "rt-1".to_string(),
            amux::AgentType::ClaudeCode,
            "/tmp/wt".to_string(),
            "ws-1".to_string(),
        );
        h.session_id = "sess-1".to_string();
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("sess-1", amux::AgentType::ClaudeCode, "ws-1"),
            Some("rt-1".to_string())
        );
        // workspace mismatch — different session in a different workspace
        // is a legitimate distinct runtime, not a dup.
        assert_eq!(
            mgr.find_active_runtime_for("sess-1", amux::AgentType::ClaudeCode, "ws-OTHER"),
            None
        );
        // session mismatch — distinct sessions on the same workspace also
        // get their own runtimes.
        assert_eq!(
            mgr.find_active_runtime_for("sess-OTHER", amux::AgentType::ClaudeCode, "ws-1"),
            None
        );
    }

    #[test]
    fn find_active_runtime_for_skips_bare_agent_spawns() {
        // Empty session_id is the bare-agent / test spawn sentinel. Two
        // such spawns must NOT dedupe into the first one — they're
        // explicit fresh runtimes.
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut h = RuntimeHandle::new(
            "rt-bare".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "".to_string(),
        );
        h.session_id = "".to_string();
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("", amux::AgentType::ClaudeCode, ""),
            None
        );
    }

    #[test]
    fn find_active_runtime_for_skips_error_agents() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let mut h = RuntimeHandle::new(
            "rt-error".to_string(),
            amux::AgentType::ClaudeCode,
            ".".to_string(),
            "workspace-1".to_string(),
        );
        h.session_id = "session-1".to_string();
        h.status = amux::AgentStatus::Error;
        mgr.agents.insert(h.agent_id.clone(), h);

        assert_eq!(
            mgr.find_active_runtime_for("session-1", amux::AgentType::ClaudeCode, "workspace-1"),
            None
        );
    }

    #[tokio::test]
    async fn send_prompt_drains_pending_silent_into_prefix() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        {
            let h = mgr.get_handle_mut("rt1").unwrap();
            h.pending_silent.push(PendingMessage {
                message_id: "m1".into(),
                sender_display: "Ann".into(),
                content: "earlier note".into(),
                created_at: 100,
            });
        }
        let drained = mgr
            .send_prompt("rt1", "real question", vec![])
            .await
            .unwrap();
        assert_eq!(drained, vec!["m1".to_string()]);
        let last = mgr.last_sent_to("rt1").unwrap();
        assert!(last.contains("Ann: earlier note"), "body was: {last}");
        assert!(last.ends_with("real question"), "body was: {last}");
    }

    #[tokio::test]
    async fn send_prompt_no_pending_sends_plain_text() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        let drained = mgr.send_prompt("rt1", "hello", vec![]).await.unwrap();
        assert!(drained.is_empty());
        assert_eq!(mgr.last_sent_to("rt1").as_deref(), Some("hello"));
    }

    #[tokio::test]
    async fn send_prompt_returns_err_for_missing_runtime() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let result = mgr.send_prompt("nonexistent", "hello", vec![]).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn send_prompt_restores_pending_silent_when_send_fails() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        {
            let h = mgr.get_handle_mut("rt1").unwrap();
            h.pending_silent.push(PendingMessage {
                message_id: "m1".into(),
                sender_display: "Ann".into(),
                content: "earlier note".into(),
                created_at: 100,
            });
        }
        mgr.fail_next_send_for("rt1", "boom");

        let result = mgr.send_prompt("rt1", "real question", vec![]).await;

        assert!(result.is_err());
        let pending = &mgr.get_handle("rt1").unwrap().pending_silent;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].message_id, "m1");
        assert!(mgr.last_sent_to("rt1").is_none());
    }

    #[tokio::test]
    async fn spawn_agent_errors_when_acp_process_cannot_spawn() {
        let mut configs = HashMap::new();
        configs.insert(
            amux::AgentType::ClaudeCode,
            AgentLaunchConfig::new(
                "/definitely/not/a/teamclaw-agent-binary",
                Vec::new(),
                "claude",
            ),
        );
        let mut mgr = RuntimeManager::new(configs, None);
        let tmp = tempfile::TempDir::new().unwrap();

        let result = mgr
            .spawn_agent_with_model(
                amux::AgentType::ClaudeCode,
                tmp.path().to_str().unwrap(),
                "",
                "workspace-1",
                None,
                None,
                None,
                None,
                None,
                SpawnRuntimeEnv::default(),
            )
            .await;

        let err = result.expect_err("missing ACP binary should fail startup");
        assert!(
            err.to_string().contains("ACP host init")
                || err.to_string().contains("ACP attach failed")
                || err.to_string().contains("spawn ACP host"),
            "got: {err}"
        );
        assert_eq!(mgr.agent_count(), 0);
    }

    // ── mention-routing accessors ─────────────────────────────────────────────

    #[test]
    fn runtime_ids_for_session_filters_by_session() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("rt1", "agent_A", "session_S");
        mgr.add_test_runtime("rt2", "agent_B", "session_S");
        mgr.add_test_runtime("rt3", "agent_C", "session_OTHER");

        let mut ids = mgr.runtime_ids_for_session("session_S");
        ids.sort();
        assert_eq!(ids, vec!["rt1", "rt2"]);
        assert_eq!(mgr.runtime_ids_for_session("session_OTHER"), vec!["rt3"]);
        assert!(mgr.runtime_ids_for_session("unknown").is_empty());
    }

    #[test]
    fn newest_runtime_id_for_session_picks_latest_started_at() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("rt-old", "agent_A", "session_S");
        mgr.add_test_runtime("rt-new", "agent_B", "session_S");
        mgr.get_handle_mut("rt-old").unwrap().started_at = 100;
        mgr.get_handle_mut("rt-new").unwrap().started_at = 200;

        assert_eq!(
            mgr.newest_runtime_id_for_session("session_S"),
            Some("rt-new".to_string())
        );
        assert_eq!(mgr.newest_runtime_id_for_session("missing"), None);
    }

    #[test]
    fn resolve_permission_runtime_key_retargets_stale_topic_to_sole_active_runtime() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("cd073767", "agent-x", "session-s");
        mgr.get_handle_mut("cd073767").unwrap().status = amux::AgentStatus::Active;

        assert_eq!(
            mgr.resolve_permission_runtime_key("ff679fef").as_deref(),
            Some("cd073767")
        );
        assert_eq!(
            mgr.resolve_permission_runtime_key("cd073767").as_deref(),
            Some("cd073767")
        );
    }

    #[test]
    fn agent_id_of_returns_handle_agent_id() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");
        assert_eq!(mgr.agent_id_of("rt1").as_deref(), Some("agent_X"));
        assert_eq!(mgr.agent_id_of("missing"), None);
    }

    #[test]
    fn backend_runtime_row_id_returns_none_when_unset() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");
        // backend_runtime_row_id defaults to None until Task 9 wires it.
        assert_eq!(mgr.backend_runtime_row_id("rt1"), None);
    }

    /// Simulate the "mentioned" branch: send_prompt is called with the message content.
    #[tokio::test]
    async fn route_mentioned_sends_prompt() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");

        // Simulates the mentioned path: directly call send_prompt (as route_session_message does).
        let mention_actor_ids = vec!["agent_X".to_string()];
        let runtime_ids = mgr.runtime_ids_for_session("session_S");
        for rid in runtime_ids {
            let agent_id = mgr.agent_id_of(&rid).unwrap();
            let mentioned = mention_actor_ids.iter().any(|m| m == &agent_id);
            if mentioned {
                mgr.send_prompt(&rid, "hi", vec![]).await.unwrap();
            }
        }

        assert_eq!(mgr.last_sent_to("rt1").as_deref(), Some("hi"));
        assert!(mgr.get_handle("rt1").unwrap().pending_silent.is_empty());
    }

    /// Simulate the "not mentioned" branch: message is queued as pending_silent.
    #[tokio::test]
    async fn route_not_mentioned_queues_silent() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("rt1", "agent_X", "session_S");

        let mention_actor_ids: Vec<String> = vec!["agent_OTHER".to_string()];
        let runtime_ids = mgr.runtime_ids_for_session("session_S");
        for rid in &runtime_ids {
            let agent_id = mgr.agent_id_of(rid).unwrap();
            let mentioned = mention_actor_ids.iter().any(|m| m == &agent_id);
            if !mentioned {
                if let Some(h) = mgr.get_handle_mut(rid) {
                    h.pending_silent.push(PendingMessage {
                        message_id: "m1".into(),
                        sender_display: "Alice".into(),
                        content: "context".into(),
                        created_at: 100,
                    });
                }
            }
        }

        assert_eq!(mgr.last_sent_to("rt1"), None);
        assert_eq!(mgr.get_handle("rt1").unwrap().pending_silent.len(), 1);
        assert_eq!(
            mgr.get_handle("rt1").unwrap().pending_silent[0].message_id,
            "m1"
        );
    }

    #[tokio::test]
    async fn send_prompt_bumps_last_active_at() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        // Reset to a known-old timestamp.
        mgr.get_handle_mut("rt1").unwrap().last_active_at = 0;
        let before = mgr.get_handle_mut("rt1").unwrap().last_active_at;
        mgr.send_prompt("rt1", "hi", vec![]).await.unwrap();
        let after = mgr.get_handle_mut("rt1").unwrap().last_active_at;
        assert!(after > before, "send_prompt should bump last_active_at");
    }

    #[test]
    fn poll_events_bumps_last_active_at_for_emitting_agents() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt1");
        mgr.get_handle_mut("rt1").unwrap().last_active_at = 0;
        // Push a fake event into the handle's channel from the sender side.
        let tx = mgr.get_handle_mut("rt1").unwrap().event_tx.clone();
        let evt = amux::AcpEvent {
            model: String::new(),
            event: None,
        };
        tx.try_send(evt).expect("event channel ready");
        let drained = mgr.poll_events();
        assert_eq!(drained.len(), 1);
        let after = mgr.get_handle_mut("rt1").unwrap().last_active_at;
        assert!(
            after > 0,
            "poll_events should bump last_active_at for agents that emitted"
        );
    }

    #[test]
    fn poll_events_for_only_drains_allowlisted_runtimes() {
        // Regression: the HTTP/SSE adapter's event pump shares the single
        // RuntimeManager with the MQTT main loop. It used to call the global
        // `poll_events()`, draining (and then silently discarding) events for
        // runtimes it did not own — starving the desktop's `session/live`
        // path. `poll_events_for` must touch ONLY the allowlisted runtimes and
        // leave everyone else's events queued for the main loop.
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-http");
        mgr.add_test_runtime("rt-mqtt", "rt-mqtt", "sess-mqtt");

        let mk = || amux::AcpEvent {
            model: String::new(),
            event: None,
        };
        let http_tx = mgr.get_handle_mut("rt-http").unwrap().event_tx.clone();
        let mqtt_tx = mgr.get_handle_mut("rt-mqtt").unwrap().event_tx.clone();
        http_tx.try_send(mk()).expect("http channel ready");
        mqtt_tx.try_send(mk()).expect("mqtt channel ready");

        // HTTP pump drains only the runtime it owns.
        let owned: std::collections::HashSet<String> =
            std::iter::once("rt-http".to_string()).collect();
        let http_drained = mgr.poll_events_for(&owned);
        assert_eq!(http_drained.len(), 1, "HTTP pump drains only its own runtime");
        assert!(
            http_drained.iter().all(|(id, _)| id == "rt-http"),
            "HTTP pump must not steal events from rt-mqtt"
        );

        // The MQTT main loop's global drain still sees rt-mqtt's untouched
        // event (and nothing left for rt-http).
        let main_drained = mgr.poll_events();
        assert_eq!(
            main_drained.len(),
            1,
            "main loop still receives the un-stolen rt-mqtt event"
        );
        assert_eq!(
            main_drained[0].0, "rt-mqtt",
            "main loop drains exactly rt-mqtt's event, not rt-http's (already taken)"
        );
    }

    #[tokio::test]
    async fn evict_idle_stops_runtimes_past_threshold() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-stale");
        let stale_ts = chrono::Utc::now().timestamp() - 3600; // 1h ago
        mgr.get_handle_mut("rt-stale").unwrap().last_active_at = stale_ts;
        mgr.add_test_runtime("rt-fresh", "rt-fresh", "sess-fresh");
        // rt-fresh was just inserted, last_active_at = 0 from test_dummy,
        // so set it to now so it isn't evicted.
        mgr.get_handle_mut("rt-fresh").unwrap().last_active_at = chrono::Utc::now().timestamp();

        let evicted = mgr.evict_idle(1800).await; // 30-minute threshold
        assert_eq!(evicted, vec!["rt-stale".to_string()]);
        assert!(mgr.get_handle("rt-stale").is_none(), "stale handle removed");
        assert!(
            mgr.get_handle("rt-fresh").is_some(),
            "fresh handle retained"
        );
    }

    #[tokio::test]
    async fn evict_idle_buffers_ids_for_drain() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-old");
        mgr.get_handle_mut("rt-old").unwrap().last_active_at = 0;
        let evicted = mgr.evict_idle(60).await;
        assert_eq!(evicted, vec!["rt-old".to_string()]);
        let drained = mgr.drain_evicted();
        assert_eq!(drained, vec!["rt-old".to_string()]);
        // Second drain returns empty.
        assert!(mgr.drain_evicted().is_empty());
    }

    #[tokio::test]
    async fn evict_idle_skips_runtimes_with_checked_out_event_rx() {
        // Mid-turn safety: a runtime whose event_rx has been taken (i.e.
        // a gateway turn is in flight) must not be evicted even if its
        // last_active_at is stale.
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-mid-turn");
        mgr.get_handle_mut("rt-mid-turn").unwrap().last_active_at = 0;
        // Simulate a checked-out event_rx by taking it directly.
        let _rx = mgr
            .get_handle_mut("rt-mid-turn")
            .unwrap()
            .event_rx
            .take()
            .expect("event_rx present");
        let evicted = mgr.evict_idle(60).await;
        assert!(
            evicted.is_empty(),
            "runtime mid-turn (event_rx None) must not be evicted"
        );
        assert!(
            mgr.get_handle("rt-mid-turn").is_some(),
            "handle must remain in map"
        );
    }

    #[tokio::test]
    async fn evict_idle_full_cycle_emits_evicted_id_for_publish() {
        let mut mgr = RuntimeManager::test_dummy_with_runtime("rt-x");
        mgr.get_handle_mut("rt-x").unwrap().last_active_at = 0;

        // First sweep: stops the runtime, buffers id.
        let evicted = mgr.evict_idle(60).await;
        assert_eq!(evicted, vec!["rt-x".to_string()]);
        assert!(mgr.get_handle("rt-x").is_none());

        // Main loop drains the buffer.
        let to_publish = mgr.drain_evicted();
        assert_eq!(to_publish, vec!["rt-x".to_string()]);

        // Second sweep: nothing left, buffer is empty.
        assert!(mgr.evict_idle(60).await.is_empty());
        assert!(mgr.drain_evicted().is_empty());
    }

    #[tokio::test]
    async fn refresh_agent_runtime_env_errors_when_agent_missing() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        let err = mgr
            .refresh_agent_runtime_env("missing-runtime", SpawnRuntimeEnv::default())
            .await
            .expect_err("missing agent should fail");
        assert!(err.to_string().contains("not found"));
    }

    #[tokio::test]
    async fn refresh_agent_runtime_env_noops_without_acp_session() {
        let mut mgr = RuntimeManager::new(RuntimeManager::test_launch_configs(), None);
        mgr.add_test_runtime("rt1", "agent-1", "session-1");
        mgr.refresh_agent_runtime_env("rt1", SpawnRuntimeEnv::default())
            .await
            .expect("empty acp_session_id should no-op");
        assert!(mgr.get_handle("rt1").is_some());
    }

    #[tokio::test]
    async fn refresh_agent_runtime_env_stops_before_failed_resume() {
        let worktree = tempfile::tempdir().unwrap();
        crate::runtime::supervisor::prepare_workspace(worktree.path()).unwrap();

        let runtime_env = crate::runtime::env_assembly::assemble_spawn_runtime_env(
            worktree.path(),
            None,
            "dev-refresh",
            "Refresh Test",
        )
        .expect("assemble env");

        let mut configs = HashMap::new();
        configs.insert(
            amux::AgentType::ClaudeCode,
            AgentLaunchConfig::new(
                "/definitely/not/a/teamclaw-agent-binary",
                Vec::new(),
                "claude",
            ),
        );
        let mut mgr = RuntimeManager::new(configs, None);
        let mut handle = super::super::handle::RuntimeHandle::test_dummy();
        handle.agent_id = "rt-refresh".to_string();
        handle.acp_session_id = "acp-existing".to_string();
        handle.worktree = worktree.path().to_string_lossy().into_owned();
        handle.workspace_id = "ws-1".to_string();
        mgr.agents.insert("rt-refresh".to_string(), handle);

        let refresh = mgr
            .refresh_agent_runtime_env("rt-refresh", runtime_env)
            .await;
        assert!(
            refresh.is_err(),
            "resume without ACP binary should fail after stop: {:?}",
            refresh
        );
        assert!(
            mgr.get_handle("rt-refresh").is_none(),
            "failed refresh should not leave a stale handle"
        );
    }
}
