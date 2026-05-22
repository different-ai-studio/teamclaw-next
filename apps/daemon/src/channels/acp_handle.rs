//! `AcpHandle` impl: bridges `teamclaw_gateway` channels to amuxd's
//! in-process `RuntimeManager` so a chat message arriving over Discord /
//! WeCom / Feishu / etc. drives an ACP turn without going through the
//! deprecated opencode HTTP server.
//!
//! ## Logical vs real ACP session ids
//!
//! Channels persist the SQL-minted `acp_session_id` (random hex from
//! `ensure_gateway_session`) on the `sessions` row and then pass it to
//! `send_prompt`. That string is a *logical* id — it was never registered
//! with amuxd's `RuntimeManager`, which only knows real ACP UUIDs returned
//! by `session/new`.
//!
//! To bridge the two, this handle keeps an in-memory `logical_to_acp` map.
//! On `send_prompt`, if the logical id has no entry, we lazy-spawn a fresh
//! agent via `create_gateway_session` and remember the mapping. On amuxd
//! restart the map is empty, so the first prompt for each persisted session
//! re-spawns; old conversation history stays in Supabase regardless.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use teamclaw_gateway::{AcpError, AcpHandle, AcpTurnOutcome, AmuxSessionId, ModelInfo};

use crate::runtime::RuntimeManager;
use crate::supabase::SupabaseClient;

/// Cached per-session state that lets `send_prompt` decide whether the
/// incoming prompt is the FIRST one for a freshly-spawned runtime (and
/// therefore should be prefixed with the one-shot system note about the
/// `send` MCP tool). Once `was_primed` flips true we never prepend the
/// preamble again for that logical session — even across restarts the
/// `logical_to_acp` map is in-memory only, so the next spawn re-issues
/// the preamble naturally.
#[derive(Clone)]
pub struct ResolvedSession {
    real_acp_sid: String,
    binding: String,
    was_primed: bool,
}

pub struct AmuxdAcpHandle {
    pub manager: Arc<Mutex<RuntimeManager>>,
    /// Logical (SQL-minted) acp_session_id → resolved runtime metadata.
    /// Created on first `send_prompt` after a daemon start; in-memory only.
    pub logical_to_acp: Arc<Mutex<HashMap<String, ResolvedSession>>>,
    /// Team id used when lazy-spawning a runtime on first `send_prompt`.
    /// Set by the F4 wiring layer when the handle is constructed.
    pub team_id: String,
    /// Per-session model override: logical_session_id → (provider, model).
    /// Set by `set_model`; consulted at lazy-spawn time so the spawned
    /// runtime starts on the user-chosen model. In-memory only — cleared
    /// across daemon restarts (same caveat as `logical_to_acp`).
    pub model_override: Arc<Mutex<HashMap<String, (String, String)>>>,
    /// Supabase client used to look up `sessions.binding` from the
    /// SQL-minted `acp_session_id` when lazy-spawning a runtime. The
    /// binding is required to write the per-session MCP config file
    /// that mounts the `send` tool.
    pub supabase: Arc<SupabaseClient>,
}

/// Returned by `resolve_or_spawn`. `spawned` is true iff this call was
/// the one that lazy-spawned the runtime — used by `send_prompt` to
/// decide whether to prepend the system preamble.
struct ResolveOutcome {
    real_acp_sid: String,
    binding: String,
    spawned: bool,
}

impl AmuxdAcpHandle {
    /// Resolve the caller-supplied `session` (a logical id persisted on the
    /// `sessions` row) to a real ACP UUID, spawning a runtime on first use.
    /// On a fresh spawn, the matching `sessions.binding` is looked up from
    /// Supabase so it can be baked into the per-session MCP config.
    async fn resolve_or_spawn(&self, session: &AmuxSessionId) -> Result<ResolveOutcome, AcpError> {
        {
            let map = self.logical_to_acp.lock().await;
            if let Some(existing) = map.get(session) {
                return Ok(ResolveOutcome {
                    real_acp_sid: existing.real_acp_sid.clone(),
                    binding: existing.binding.clone(),
                    spawned: false,
                });
            }
        }

        // Recover the supabase session UUID + binding URI for this logical
        // session. The UUID is needed so the spawned runtime can carry it
        // on its handle, which is what daemon::server::target_sessions falls
        // back to when routing agent envelopes (otherwise gateway-spawned
        // runtimes — which never get written into the local SessionStore —
        // appear bound-less and their envelopes get dropped). The binding
        // feeds the per-session MCP config so `send` defaults to the
        // originating chat. A missing row is non-fatal; we still spawn so
        // basic prompt/reply works.
        let (supabase_session_id, binding) = match self
            .supabase
            .get_gateway_session_by_acp_id(session)
            .await
            .map_err(|e| AcpError::Create(format!("session lookup: {e}")))?
        {
            Some((id, bind)) => (Some(id), bind.unwrap_or_default()),
            None => (None, String::new()),
        };

        // Consult per-session override so the spawn picks up the desired
        // model. Stored as (provider, model); only model is threaded through
        // to the spawn — provider is currently informational (claude-code
        // binary == anthropic) but kept so future multi-provider routing
        // can dispatch on it without another schema change.
        let model_arg: Option<(String, String)> = {
            let overrides = self.model_override.lock().await;
            overrides.get(session).cloned()
        };
        let real = {
            let mut mgr = self.manager.lock().await;
            mgr.create_gateway_session_with_model(
                &self.team_id,
                session,
                &binding,
                "Gateway session",
                model_arg,
                supabase_session_id.as_deref(),
                None,
            )
            .await
            .map_err(|e| AcpError::Create(e.to_string()))?
        };

        // Insert under a write lock; if a concurrent spawn raced ahead we
        // keep the existing entry so `was_primed` reflects whichever call
        // actually delivered the preamble first.
        let mut map = self.logical_to_acp.lock().await;
        let entry = map
            .entry(session.to_string())
            .or_insert_with(|| ResolvedSession {
                real_acp_sid: real.clone(),
                binding: binding.clone(),
                was_primed: false,
            });
        let outcome = ResolveOutcome {
            real_acp_sid: entry.real_acp_sid.clone(),
            binding: entry.binding.clone(),
            spawned: true,
        };
        Ok(outcome)
    }

    /// Mark a logical session as having received its priming system
    /// preamble so subsequent `send_prompt` calls don't repeat it.
    async fn mark_primed(&self, session: &str) {
        let mut map = self.logical_to_acp.lock().await;
        if let Some(entry) = map.get_mut(session) {
            entry.was_primed = true;
        }
    }

    /// Returns true if the logical session has already received its
    /// priming preamble. Lock is held briefly — callers that want a
    /// consistent decision should pair this with `mark_primed`.
    async fn already_primed(&self, session: &str) -> bool {
        let map = self.logical_to_acp.lock().await;
        map.get(session).map(|e| e.was_primed).unwrap_or(false)
    }
}

/// Extract the channel scheme from a binding URI (`wecom://…` →
/// `wecom`). Used in the priming preamble so the agent knows which
/// gateway it's talking through. Falls back to `gateway` when the URI
/// doesn't parse cleanly.
fn channel_name_from_binding(binding: &str) -> &str {
    if binding.is_empty() {
        return "gateway";
    }
    match binding.split_once("://") {
        Some((scheme, _)) if !scheme.is_empty() => scheme,
        _ => "gateway",
    }
}

#[async_trait]
impl AcpHandle for AmuxdAcpHandle {
    async fn create_session(
        &self,
        _team_id: &str,
        binding: &str,
        _title: &str,
    ) -> Result<AmuxSessionId, AcpError> {
        // Channels never call this in the gateway-port architecture — the
        // SQL store mints the logical acp_session_id via
        // `ensure_gateway_session`. We keep a consistent implementation in
        // case future callers use it: hand back the binding as the logical
        // id; `send_prompt` will lazy-spawn on first use.
        Ok(binding.to_string())
    }

    async fn send_prompt(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<AcpTurnOutcome, AcpError> {
        let outcome = self.resolve_or_spawn(session).await?;

        // First prompt after a fresh spawn gets a one-shot system preamble
        // explaining the `send` MCP tool and its defaults. `resolve_or_spawn`
        // tells us whether this call did the spawning, but a concurrent
        // caller may have already primed the session — `already_primed`
        // settles the race so we never double-prime.
        let needs_preamble = outcome.spawned && !self.already_primed(session).await;
        let prompt = if needs_preamble {
            let channel = channel_name_from_binding(&outcome.binding);
            format!(
                "[SYSTEM] You are connected to a {channel} chat via amuxd. To send a follow-up \
message or upload a file back to this chat without waiting for the user to ask, call the `send` \
MCP tool (server name `amuxd-send`). `target` and `channel` default to the current session's \
bound chat, so a simple `send(message=\"…\")` or `send(file_path=\"/tmp/report.pdf\")` is enough.\n\n\
[{sender_display}] {text}"
            )
        } else {
            format!("[{sender_display}] {text}")
        };

        if needs_preamble {
            self.mark_primed(session).await;
        }

        // Per-session concurrency model:
        //
        //   1. Grab the per-agent `turn_lock` Arc under a brief manager
        //      lock and immediately release the manager mutex.
        //   2. Acquire `turn_lock` — serialises only *this* agent's turns.
        //      Different agents have different locks, so two concurrent
        //      wecom sessions never block each other here.
        //   3. Re-acquire the manager mutex *briefly* to send the prompt
        //      and check the agent's `event_rx` out of the handle. With
        //      `turn_lock` held the checkout cannot race.
        //   4. Drive the aggregator off the local `event_rx.recv().await`
        //      *without* holding the manager mutex. Re-lock only for the
        //      sub-millisecond `aggregator.ingest(&event)` call after each
        //      event. While we're waiting on the model, the manager mutex
        //      stays free so other sessions can poll events / spawn / etc.
        //   5. Always check the receiver back in (success or error) before
        //      dropping the turn_lock guard so `poll_events` resumes
        //      draining the next round.

        let turn_lock = {
            let mgr = self.manager.lock().await;
            let agent_id = mgr
                .agent_id_by_acp_session(&outcome.real_acp_sid)
                .ok_or_else(|| {
                    AcpError::Send(format!(
                        "no agent for acp_session_id {}",
                        outcome.real_acp_sid
                    ))
                })?;
            let handle = mgr.get_handle(&agent_id).ok_or_else(|| {
                AcpError::Send(format!("agent {agent_id} disappeared before turn"))
            })?;
            handle.turn_lock.clone()
        };
        let _turn_guard = turn_lock.lock().await;

        let (agent_id, mut event_rx) = {
            let mut mgr = self.manager.lock().await;
            let (turn, _again) = mgr
                .checkout_turn_for_acp(&outcome.real_acp_sid)
                .map_err(|e| AcpError::Send(e.to_string()))?;
            mgr.send_prompt_raw(&turn.agent_id, &prompt, vec![])
                .await
                .map_err(|e| AcpError::Send(e.to_string()))?;
            (turn.agent_id, turn.event_rx)
        };

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5 * 60);
        let result: Result<String, AcpError> = loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break Err(AcpError::Timeout);
            }
            let next = tokio::time::timeout(remaining, event_rx.recv()).await;
            let event = match next {
                Ok(Some(ev)) => ev,
                Ok(None) => {
                    break Err(AcpError::Send(
                        "ACP event channel closed before reply".into(),
                    ))
                }
                Err(_) => break Err(AcpError::Timeout),
            };
            if let Some(crate::proto::amux::acp_event::Event::Error(err)) = &event.event {
                let details = if err.details.is_empty() {
                    err.message.clone()
                } else {
                    err.details.clone()
                };
                break Err(AcpError::Send(format!("ACP turn failed: {details}")));
            }
            let emitted = {
                let mut mgr = self.manager.lock().await;
                mgr.aggregator_mut(&agent_id)
                    .map(|agg| agg.ingest(&event))
                    .unwrap_or_default()
            };
            let mut reply: Option<String> = None;
            for m in emitted {
                if matches!(m.kind, crate::proto::teamclaw::MessageKind::AgentReply) {
                    reply = Some(m.content);
                    break;
                }
            }
            if let Some(text) = reply {
                break Ok(text);
            }
        };

        {
            let mut mgr = self.manager.lock().await;
            mgr.checkin_turn(crate::runtime::CheckedOutTurn { agent_id, event_rx });
        }

        let reply_text = result?;
        Ok(AcpTurnOutcome {
            reply_text,
            completed: true,
        })
    }

    async fn inject_context(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<(), AcpError> {
        let outcome = self.resolve_or_spawn(session).await?;
        let mgr = self.manager.lock().await;
        mgr.inject_context(&outcome.real_acp_sid, sender_display, text)
            .await
            .map_err(|e| AcpError::Send(e.to_string()))
    }

    async fn cancel(&self, session: &AmuxSessionId) -> Result<(), AcpError> {
        let map = self.logical_to_acp.lock().await;
        let real = match map.get(session) {
            Some(s) => s.real_acp_sid.clone(),
            None => return Ok(()), // never spawned, nothing to cancel
        };
        drop(map);
        let mut mgr = self.manager.lock().await;
        mgr.cancel_by_acp_session(&real)
            .await
            .map_err(|e| AcpError::Send(format!("cancel failed: {e}")))
    }

    async fn reset_session(&self, session: &AmuxSessionId) -> Result<(), AcpError> {
        // Cancel + drop from map. Next send_prompt re-spawns under the
        // same logical id with a fresh runtime — preserves the gateway-side
        // identity so persisted `sessions.binding` keeps working.
        let _ = self.cancel(session).await; // best-effort
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);
        Ok(())
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, AcpError> {
        // Hardcoded for the claude-code adapter in v1 of the gateway port.
        // Future work: read from daemon.toml once we have multi-binary
        // routing (codex-cli, etc.).
        Ok(vec![
            ModelInfo {
                provider: "anthropic".into(),
                model: "sonnet".into(),
                display_name: "Claude Sonnet (default, fast)".into(),
            },
            ModelInfo {
                provider: "anthropic".into(),
                model: "opus".into(),
                display_name: "Claude Opus (high-capability)".into(),
            },
            ModelInfo {
                provider: "anthropic".into(),
                model: "haiku".into(),
                display_name: "Claude Haiku (cheapest)".into(),
            },
        ])
    }

    async fn set_model(
        &self,
        session: &AmuxSessionId,
        provider: &str,
        model: &str,
    ) -> Result<(), AcpError> {
        // Validate against list_models so /model only accepts known names.
        let valid = self.list_models().await?;
        if !valid
            .iter()
            .any(|m| m.provider == provider && m.model == model)
        {
            return Err(AcpError::Send(format!(
                "unknown model {provider}/{model}; use list_models to enumerate"
            )));
        }

        // Store override before tearing down the runtime so the lazy-spawn
        // that follows on the next prompt picks up the new model.
        {
            let mut overrides = self.model_override.lock().await;
            overrides.insert(
                session.to_string(),
                (provider.to_string(), model.to_string()),
            );
        }

        // Cancel current runtime + drop logical→acp mapping so the next
        // send_prompt lazy-spawns under the new model. Conversation context
        // is lost — same semantics as v1 /model.
        let _ = self.cancel(session).await;
        let mut map = self.logical_to_acp.lock().await;
        map.remove(session);

        Ok(())
    }
}
