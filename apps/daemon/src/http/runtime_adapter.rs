//! Abstraction layer between the HTTP plane and the agent runtime.
//!
//! The HTTP layer never speaks to [`crate::runtime::RuntimeManager`]
//! directly — it goes through the [`RuntimeAdapter`] trait. This keeps
//! three things possible at once:
//!
//! 1. The HTTP routes have a small, testable surface area.
//! 2. The real `RuntimeManager` integration (which is a substantial
//!    refactor on its own) lives behind a single implementation that
//!    can ship in a follow-up PR without touching the routes.
//! 3. Integration tests drive a [`StubRuntimeAdapter`] that emits
//!    synthetic token streams — the exact same SSE pipe end-to-end,
//!    minus the agent process.
//!
//! ### Mental model
//!
//! - A `RuntimeAdapter` owns a pool of *logical sessions*. Each session
//!   has an id, an agent type, and an event broadcaster.
//! - The HTTP plane calls `create_session`, `send_prompt`, `cancel`,
//!   `close_session`. Everything else is observation via the event
//!   stream returned by `subscribe`.
//! - Events are typed [`crate::http::events::SessionEvent`]s, not raw
//!   ACP envelopes. The adapter is responsible for translating.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::errors::HttpError;
use super::events::SessionEvent;

/// Parameters accepted by [`RuntimeAdapter::create_session`].
#[derive(Debug, Clone, Deserialize)]
pub struct CreateSessionParams {
    pub agent_type: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// Snapshot a created or fetched session — returned by both
/// `create_session` and `get_session`. Pure data; cheap to clone.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSnapshot {
    pub session_id: Uuid,
    pub agent_type: String,
    pub runtime_id: String,
    pub workspace_id: Option<String>,
    pub state: SessionState,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_activity: chrono::DateTime<chrono::Utc>,
    pub last_event_seq: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    Cancelling,
    Errored,
    Closed,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptParams {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<serde_json::Value>,
    #[serde(default)]
    pub mentions: Vec<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptAck {
    pub prompt_id: Uuid,
    pub turn_id: Uuid,
}

/// Backplane the HTTP layer drives. Implementations:
///
/// - [`StubRuntimeAdapter`]: emits scripted token deltas; used by the
///   integration test suite and as a development placeholder until the
///   real `RuntimeManager` adapter ships.
/// - `RuntimeManagerAdapter` (future): proxies to the existing
///   `Arc<AsyncMutex<RuntimeManager>>` in `daemon/server.rs`.
#[async_trait]
pub trait RuntimeAdapter: Send + Sync {
    /// Whose token created this — used to scope listing/deletion. The
    /// HTTP layer caches the owner; adapters needn't persist it.
    async fn create_session(
        &self,
        owner_token_id: Uuid,
        params: CreateSessionParams,
    ) -> Result<SessionSnapshot, HttpError>;

    async fn get_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError>;

    async fn list_sessions(&self, owner_token_id: Uuid) -> Vec<SessionSnapshot>;

    async fn close_session(&self, session_id: Uuid) -> Result<(), HttpError>;

    async fn send_prompt(
        &self,
        session_id: Uuid,
        params: PromptParams,
    ) -> Result<PromptAck, HttpError>;

    async fn cancel(&self, session_id: Uuid, turn_id: Option<Uuid>) -> Result<(), HttpError>;

    /// Subscribe to live events for `session_id`. Returns a broadcast
    /// receiver pre-filled with the buffered backlog *after* `since`
    /// (when `since` is provided) plus a "fast-forward" snapshot of
    /// dropped events. Implementations should ensure ordering — the
    /// HTTP layer assumes monotonic `seq`.
    async fn subscribe(
        &self,
        session_id: Uuid,
        since: Option<u64>,
    ) -> Result<SubscriptionHandle, HttpError>;

    /// Bounded replay used by `GET /v1/sessions/:id/events`.
    async fn replay(
        &self,
        session_id: Uuid,
        since: u64,
        limit: usize,
    ) -> Result<ReplayPage, HttpError>;
}

#[derive(Debug)]
pub struct SubscriptionHandle {
    /// Events that were buffered and need to be flushed before the live
    /// stream begins. The HTTP layer drains this list first.
    pub backlog: Vec<SessionEvent>,
    /// Live channel. Receiver dropped → adapter unsubscribes.
    pub live: broadcast::Receiver<SessionEvent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplayPage {
    pub events: Vec<SessionEvent>,
    pub next_cursor: Option<u64>,
    pub window_oldest_seq: Option<u64>,
}

// ── Stub implementation ─────────────────────────────────────────────────────

use super::events::{EventKind, EventRingBuffer};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// In-memory adapter used by tests and for the development preview.
/// Emits a scripted token stream when a prompt is received; otherwise
/// behaves like a real adapter (state machine, backlog buffer, replay
/// window) so the HTTP plane is exercised end-to-end.
pub struct StubRuntimeAdapter {
    inner: Arc<StubInner>,
}

struct StubInner {
    sessions: RwLock<HashMap<Uuid, StubSession>>,
    backlog_cap: usize,
}

struct StubSession {
    snap: SessionSnapshot,
    owner_token_id: Uuid,
    tx: broadcast::Sender<SessionEvent>,
    ring: EventRingBuffer,
    next_seq: u64,
}

impl StubRuntimeAdapter {
    pub fn new(backlog_cap: usize) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(StubInner {
                sessions: RwLock::new(HashMap::new()),
                backlog_cap,
            }),
        })
    }

    fn emit(&self, session_id: Uuid, kind: EventKind, data: serde_json::Value) -> Option<u64> {
        let mut sessions = self.inner.sessions.write();
        let s = sessions.get_mut(&session_id)?;
        s.next_seq += 1;
        let event = SessionEvent::new(session_id, s.next_seq, kind, data);
        s.ring.push(event.clone());
        s.snap.last_event_seq = s.next_seq;
        s.snap.last_activity = chrono::Utc::now();
        let _ = s.tx.send(event);
        Some(s.next_seq)
    }

    fn set_state(&self, session_id: Uuid, new_state: SessionState, reason: Option<&str>) {
        // Update the snapshot's state, then emit a session.state event
        // so subscribers learn about the transition.
        {
            let mut sessions = self.inner.sessions.write();
            if let Some(s) = sessions.get_mut(&session_id) {
                s.snap.state = new_state;
            }
        }
        let mut data = serde_json::json!({"state": new_state});
        if let Some(r) = reason {
            data["reason"] = serde_json::Value::String(r.into());
        }
        self.emit(session_id, EventKind::SessionState, data);
    }
}

#[async_trait]
impl RuntimeAdapter for StubRuntimeAdapter {
    async fn create_session(
        &self,
        owner_token_id: Uuid,
        params: CreateSessionParams,
    ) -> Result<SessionSnapshot, HttpError> {
        let session_id = Uuid::new_v4();
        let now = chrono::Utc::now();
        let (tx, _rx) = broadcast::channel::<SessionEvent>(256);
        let snap = SessionSnapshot {
            session_id,
            agent_type: params.agent_type.clone(),
            runtime_id: format!("stub-rt-{}", &session_id.to_string()[..8]),
            workspace_id: params.workspace_id.clone(),
            state: SessionState::Idle,
            created_at: now,
            last_activity: now,
            last_event_seq: 0,
        };
        {
            let mut sessions = self.inner.sessions.write();
            sessions.insert(
                session_id,
                StubSession {
                    snap: snap.clone(),
                    owner_token_id,
                    tx,
                    ring: EventRingBuffer::new(self.inner.backlog_cap),
                    next_seq: 0,
                },
            );
        }
        self.emit(
            session_id,
            EventKind::SessionCreated,
            serde_json::json!({
                "session_id": session_id,
                "agent_type": params.agent_type,
            }),
        );

        if let Some(prompt) = params.initial_prompt {
            self.send_prompt(
                session_id,
                PromptParams {
                    text: prompt,
                    attachments: vec![],
                    mentions: vec![],
                    metadata: None,
                },
            )
            .await?;
        }

        Ok(snap)
    }

    async fn get_session(&self, session_id: Uuid) -> Result<SessionSnapshot, HttpError> {
        self.inner
            .sessions
            .read()
            .get(&session_id)
            .map(|s| s.snap.clone())
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))
    }

    async fn list_sessions(&self, owner_token_id: Uuid) -> Vec<SessionSnapshot> {
        self.inner
            .sessions
            .read()
            .values()
            .filter(|s| s.owner_token_id == owner_token_id)
            .map(|s| s.snap.clone())
            .collect()
    }

    async fn close_session(&self, session_id: Uuid) -> Result<(), HttpError> {
        {
            let exists = self.inner.sessions.read().contains_key(&session_id);
            if !exists {
                return Err(HttpError::session_not_found(&session_id.to_string()));
            }
        }
        self.set_state(session_id, SessionState::Closed, Some("explicit_close"));
        self.emit(
            session_id,
            EventKind::SessionClosed,
            serde_json::json!({"reason": "explicit_close"}),
        );
        Ok(())
    }

    async fn send_prompt(
        &self,
        session_id: Uuid,
        params: PromptParams,
    ) -> Result<PromptAck, HttpError> {
        {
            let sessions = self.inner.sessions.read();
            let s = sessions
                .get(&session_id)
                .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
            if matches!(s.snap.state, SessionState::Running) {
                return Err(HttpError::new(
                    super::errors::ErrorCode::SessionBusy,
                    "session is already processing a prompt",
                ));
            }
            if matches!(s.snap.state, SessionState::Closed) {
                return Err(HttpError::session_not_found(&session_id.to_string()));
            }
        }

        let prompt_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let ack = PromptAck { prompt_id, turn_id };

        self.emit(
            session_id,
            EventKind::PromptAccepted,
            serde_json::json!({
                "prompt_id": prompt_id,
                "text": params.text,
                "at": chrono::Utc::now(),
            }),
        );
        self.set_state(session_id, SessionState::Running, None);
        self.emit(
            session_id,
            EventKind::TurnStarted,
            serde_json::json!({"turn_id": turn_id, "prompt_id": prompt_id}),
        );

        // Scripted token stream — runs in background so the HTTP
        // handler can return 202 immediately.
        let adapter = self.clone();
        let text = params.text;
        tokio::spawn(async move {
            for (idx, ch) in text.chars().enumerate() {
                adapter.emit(
                    session_id,
                    EventKind::TokenDelta,
                    serde_json::json!({
                        "turn_id": turn_id,
                        "index": idx as u64,
                        "text": ch.to_string(),
                    }),
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            adapter.emit(
                session_id,
                EventKind::MessageCompleted,
                serde_json::json!({
                    "turn_id": turn_id,
                    "role": "assistant",
                    "content": text,
                    "usage": {"input": text.len(), "output": text.len()},
                }),
            );
            adapter.emit(
                session_id,
                EventKind::TurnFinished,
                serde_json::json!({"turn_id": turn_id, "reason": "stop"}),
            );
            adapter.set_state(session_id, SessionState::Idle, None);
        });

        Ok(ack)
    }

    async fn cancel(&self, session_id: Uuid, turn_id: Option<Uuid>) -> Result<(), HttpError> {
        {
            let exists = self.inner.sessions.read().contains_key(&session_id);
            if !exists {
                return Err(HttpError::session_not_found(&session_id.to_string()));
            }
        }
        self.set_state(session_id, SessionState::Cancelling, None);
        self.emit(
            session_id,
            EventKind::TurnFinished,
            serde_json::json!({"turn_id": turn_id, "reason": "cancel"}),
        );
        self.set_state(session_id, SessionState::Idle, None);
        Ok(())
    }

    async fn subscribe(
        &self,
        session_id: Uuid,
        since: Option<u64>,
    ) -> Result<SubscriptionHandle, HttpError> {
        let sessions = self.inner.sessions.read();
        let s = sessions
            .get(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        let oldest = s.ring.oldest_seq();
        if let Some(since) = since {
            if let Some(oldest) = oldest {
                if since + 1 < oldest {
                    return Err(HttpError::new(
                        super::errors::ErrorCode::EventGone,
                        format!(
                            "Last-Event-ID {since} is below window {oldest}; refetch session snapshot before reconnecting"
                        ),
                    ));
                }
            }
        }
        let backlog: Vec<_> = match since {
            Some(s_) => s.ring.replay_after(s_).cloned().collect(),
            None => s.ring.snapshot(),
        };
        let live = s.tx.subscribe();
        Ok(SubscriptionHandle { backlog, live })
    }

    async fn replay(
        &self,
        session_id: Uuid,
        since: u64,
        limit: usize,
    ) -> Result<ReplayPage, HttpError> {
        let sessions = self.inner.sessions.read();
        let s = sessions
            .get(&session_id)
            .ok_or_else(|| HttpError::session_not_found(&session_id.to_string()))?;
        let limit = limit.clamp(1, 500);
        let events = s.ring.replay_after_limited(since, limit);
        let next_cursor = events.last().map(|e| e.seq);
        Ok(ReplayPage {
            events,
            next_cursor,
            window_oldest_seq: s.ring.oldest_seq(),
        })
    }
}

// Stub needs Clone to capture itself into the spawned token-emitter
// task. Cloning shares the Arc<StubInner> so all clones observe the
// same session map.
impl Clone for StubRuntimeAdapter {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_session_full_flow() {
        let adapter = StubRuntimeAdapter::new(256);
        let token_id = Uuid::new_v4();
        let snap = adapter
            .create_session(
                token_id,
                CreateSessionParams {
                    agent_type: "stub".into(),
                    workspace_id: None,
                    model: None,
                    initial_prompt: None,
                    metadata: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(snap.state, SessionState::Idle);

        let mut sub = adapter.subscribe(snap.session_id, None).await.unwrap();
        // Backlog contains the session.created event.
        assert!(sub.backlog.iter().any(|e| e.kind == EventKind::SessionCreated));

        let ack = adapter
            .send_prompt(
                snap.session_id,
                PromptParams {
                    text: "hi".into(),
                    attachments: vec![],
                    mentions: vec![],
                    metadata: None,
                },
            )
            .await
            .unwrap();
        // Receive a few live events; should observe turn finishing.
        let mut saw_turn_finished = false;
        for _ in 0..40 {
            match tokio::time::timeout(Duration::from_millis(200), sub.live.recv()).await {
                Ok(Ok(ev)) => {
                    if ev.kind == EventKind::TurnFinished {
                        saw_turn_finished = true;
                        break;
                    }
                }
                _ => break,
            }
        }
        assert!(saw_turn_finished, "stub should finish a turn promptly");
        assert!(!ack.turn_id.is_nil());
    }

    #[tokio::test]
    async fn subscribe_below_window_returns_gone() {
        let adapter = StubRuntimeAdapter::new(2);
        let token_id = Uuid::new_v4();
        let snap = adapter
            .create_session(
                token_id,
                CreateSessionParams {
                    agent_type: "stub".into(),
                    workspace_id: None,
                    model: None,
                    initial_prompt: None,
                    metadata: None,
                },
            )
            .await
            .unwrap();
        // Force the ring buffer past `session.created` (which is seq 1).
        for _ in 0..5 {
            adapter.emit(snap.session_id, EventKind::TokenDelta, serde_json::json!({}));
        }
        let err = adapter
            .subscribe(snap.session_id, Some(1))
            .await
            .unwrap_err();
        assert_eq!(err.code, super::super::errors::ErrorCode::EventGone);
    }
}
