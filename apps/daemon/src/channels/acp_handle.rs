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

pub struct AmuxdAcpHandle {
    pub manager: Arc<Mutex<RuntimeManager>>,
    /// Logical (SQL-minted) acp_session_id → real ACP UUID returned by
    /// `RuntimeManager::create_gateway_session`. In-memory only.
    pub logical_to_acp: Arc<Mutex<HashMap<String, String>>>,
    /// Team id used when lazy-spawning a runtime on first `send_prompt`.
    /// Set by the F4 wiring layer when the handle is constructed.
    pub team_id: String,
    /// Per-session model override: logical_session_id → (provider, model).
    /// Set by `set_model`; consulted at lazy-spawn time so the spawned
    /// runtime starts on the user-chosen model. In-memory only — cleared
    /// across daemon restarts (same caveat as `logical_to_acp`).
    pub model_override: Arc<Mutex<HashMap<String, (String, String)>>>,
}

impl AmuxdAcpHandle {
    /// Resolve the caller-supplied `session` (a logical id persisted on the
    /// `sessions` row) to a real ACP UUID, spawning a runtime on first use.
    async fn resolve_or_spawn(&self, session: &AmuxSessionId) -> Result<String, AcpError> {
        let mut map = self.logical_to_acp.lock().await;
        if let Some(existing) = map.get(session) {
            return Ok(existing.clone());
        }
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
                "Gateway session",
                model_arg,
            )
            .await
            .map_err(|e| AcpError::Create(e.to_string()))?
        };
        map.insert(session.to_string(), real.clone());
        Ok(real)
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
        let real_acp_sid = self.resolve_or_spawn(session).await?;

        let mut mgr = self.manager.lock().await;
        let prompt = format!("[{sender_display}] {text}");
        let reply = mgr
            .send_prompt_and_await_reply(&real_acp_sid, &prompt)
            .await
            .map_err(|e| AcpError::Send(e.to_string()))?;
        Ok(AcpTurnOutcome {
            reply_text: reply,
            completed: true,
        })
    }

    async fn inject_context(
        &self,
        session: &AmuxSessionId,
        sender_display: &str,
        text: &str,
    ) -> Result<(), AcpError> {
        let real_acp_sid = self.resolve_or_spawn(session).await?;
        let mgr = self.manager.lock().await;
        mgr.inject_context(&real_acp_sid, sender_display, text)
            .await
            .map_err(|e| AcpError::Send(e.to_string()))
    }

    async fn cancel(&self, session: &AmuxSessionId) -> Result<(), AcpError> {
        let map = self.logical_to_acp.lock().await;
        let real = match map.get(session) {
            Some(s) => s.clone(),
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
