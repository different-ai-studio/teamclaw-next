use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use acp::Agent as _; // bring trait methods into scope
use agent_client_protocol as acp;
use base64::Engine as _;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tracing::{debug, error, info, warn};

use crate::proto::amux;

#[derive(Debug, Clone)]
pub enum RuntimeEnvelope {
    TokenDelta {
        text: String,
    },
    ToolCall {
        tool_name: String,
        args: serde_json::Value,
    },
    ToolResult {
        tool_id: String,
        success: bool,
        summary: String,
    },
    MessageCompleted {
        message_id: uuid::Uuid,
        content: String,
    },
    TurnFinished {
        turn_id: uuid::Uuid,
    },
    SessionError {
        message: String,
        details: String,
    },
    StatusChanged {
        status: amux::AgentStatus,
    },
}

pub fn runtime_envelopes_from_acp_event(event: &amux::AcpEvent) -> Vec<RuntimeEnvelope> {
    match event.event.as_ref() {
        Some(amux::acp_event::Event::Output(output)) => {
            if output.text.is_empty() {
                return vec![];
            }
            if output.is_complete {
                vec![RuntimeEnvelope::MessageCompleted {
                    message_id: uuid::Uuid::new_v4(),
                    content: output.text.clone(),
                }]
            } else {
                vec![RuntimeEnvelope::TokenDelta {
                    text: output.text.clone(),
                }]
            }
        }
        Some(amux::acp_event::Event::ToolUse(tool)) => vec![RuntimeEnvelope::ToolCall {
            tool_name: tool.tool_name.clone(),
            args: serde_json::to_value(&tool.params)
                .unwrap_or_else(|_| serde_json::Value::Object(Default::default())),
        }],
        Some(amux::acp_event::Event::ToolResult(tool)) => vec![RuntimeEnvelope::ToolResult {
            tool_id: tool.tool_id.clone(),
            success: tool.success,
            summary: tool.summary.clone(),
        }],
        Some(amux::acp_event::Event::Error(err)) => vec![RuntimeEnvelope::SessionError {
            message: err.message.clone(),
            details: err.details.clone(),
        }],
        Some(amux::acp_event::Event::StatusChange(status)) => {
            vec![RuntimeEnvelope::StatusChanged {
                status: amux::AgentStatus::try_from(status.new_status)
                    .unwrap_or(amux::AgentStatus::Unknown),
            }]
        }
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Messages sent INTO the ACP LocalSet thread
// ---------------------------------------------------------------------------

/// Commands the main tokio runtime sends to a shared ACP host thread.
pub enum AcpCommand {
    /// Create or resume an ACP session on an already-initialized host.
    AttachSession {
        worktree: String,
        resume_acp_session_id: Option<String>,
        mcp_config_path: Option<PathBuf>,
        initial_model_override: Option<String>,
        initial_prompt: String,
        event_tx: mpsc::Sender<amux::AcpEvent>,
        startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
        /// Gateway sessions auto-allow tool permissions; native runtimes wait
        /// for MQTT approval.
        is_gateway: bool,
    },
    /// Drop routing state for a session; the host process keeps running.
    DetachSession { acp_session_id: String },
    /// Send a prompt to a bound session.
    Prompt {
        acp_session_id: String,
        text: String,
        attachment_urls: Vec<String>,
    },
    /// Cancel the current turn for a bound session.
    Cancel { acp_session_id: String },
    /// Resolve a pending permission request (any session on this host).
    ResolvePermission {
        request_id: String,
        granted: bool,
        /// ACP option_id when granted (e.g. OpenCode "once" / "always"). Empty = allow_once.
        option_id: Option<String>,
    },
    /// Switch the model used by a bound session.
    SetModel {
        acp_session_id: String,
        model_id: String,
    },
    /// Shut down the entire host process.
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct AcpStartupMetadata {
    pub available_models: Vec<amux::ModelInfo>,
    pub initial_model: Option<String>,
    pub acp_session_id: String,
}

type StartupReporter = Arc<Mutex<Option<oneshot::Sender<Result<AcpStartupMetadata, String>>>>>;

fn report_startup(reporter: &StartupReporter, result: Result<AcpStartupMetadata, String>) {
    if let Some(tx) = reporter.lock().ok().and_then(|mut guard| guard.take()) {
        let _ = tx.send(result);
    }
}

async fn emit_acp_error(
    event_tx: &mpsc::Sender<amux::AcpEvent>,
    acp_session_id: &str,
    message: impl Into<String>,
    details: impl Into<String>,
) {
    let message = message.into();
    let details = details.into();
    super::agent_trace::log_acp_error(acp_session_id, &message, &details);
    let _ = event_tx
        .send(amux::AcpEvent {
            event: Some(amux::acp_event::Event::Error(amux::AcpError {
                message,
                details,
            })),
            model: String::new(),
        })
        .await;
}

// ---------------------------------------------------------------------------
// AmuxClient — implements acp::Client inside the LocalSet
// ---------------------------------------------------------------------------

/// Per-session routing table inside a shared ACP host.
#[derive(Default)]
struct SessionRegistry {
    sessions: HashMap<String, SessionRoute>,
}

/// Client reply routed back to an in-flight ACP `request_permission` call.
#[derive(Debug)]
enum PermissionResolution {
    Denied,
    Granted { option_id: Option<String> },
}

struct SessionRoute {
    event_tx: mpsc::Sender<amux::AcpEvent>,
    is_gateway: bool,
    pending_permissions: HashMap<String, oneshot::Sender<PermissionResolution>>,
    /// Count of `session_notification` handlers currently between "entered"
    /// and "finished pushing their events onto `event_tx`". The ACP crate
    /// dispatches every incoming `session/update` on its own spawned task,
    /// fully decoupled from when `conn.prompt()` resolves (the prompt
    /// response is read + the response oneshot fired by the rpc reader task,
    /// see `agent-client-protocol` `rpc.rs::handle_io`). So when `prompt()`
    /// returns, the turn's trailing `AgentMessageChunk` handlers may not have
    /// pushed their `Output` onto `event_tx` yet. The prompt worker waits for
    /// this counter to go (and stay) quiescent before emitting Active->Idle,
    /// guaranteeing the turn's final text lands ahead of the turn-end marker.
    notif_inflight: Rc<Cell<usize>>,
    /// Monotonic count of `session_notification` handlers that have *finished*
    /// pushing their events onto `event_tx`. Unlike `notif_inflight` (which
    /// reads 0 both *before* a handler is dispatched and *after* it completes),
    /// this only ever moves forward, so the drain barrier can tell "a handler
    /// just completed" apart from "no handler has started yet" and extend its
    /// quiet window accordingly.
    notif_finished: Rc<Cell<u64>>,
}

/// RAII guard that marks one in-flight `session_notification` on a session
/// route: increments `inflight` on construction; on drop (panic-safe)
/// decrements `inflight` and bumps the monotonic `finished` counter.
struct NotifInflightGuard {
    inflight: Rc<Cell<usize>>,
    finished: Rc<Cell<u64>>,
}

impl NotifInflightGuard {
    fn new(inflight: Rc<Cell<usize>>, finished: Rc<Cell<u64>>) -> Self {
        inflight.set(inflight.get() + 1);
        Self { inflight, finished }
    }
}

impl Drop for NotifInflightGuard {
    fn drop(&mut self) {
        self.inflight.set(self.inflight.get().saturating_sub(1));
        self.finished.set(self.finished.get().wrapping_add(1));
    }
}

/// Block until the per-session notification dispatch pipeline is quiescent.
///
/// See `SessionRoute::notif_inflight` for why this barrier exists. The ACP
/// crate's reader (`rpc.rs::handle_io`) enqueues every trailing notification
/// onto its internal `incoming_rx` *before* it resolves the prompt response,
/// so by the time `conn.prompt()` returns the whole turn's notifications are
/// already queued. But the handlers run on a *separate* task chain:
/// `handle_incoming` pulls each notification off `incoming_rx` and `spawn`s an
/// independent handler task, and only those handler tasks push `Thinking` /
/// `Output` onto `event_tx`.
///
/// The previous implementation declared the pipeline drained after observing
/// `notif_inflight == 0` across two `yield_now()` turns. That was racy:
/// `notif_inflight` reads 0 *both* before any handler is dispatched *and*
/// after they all complete. When the crate's `BufReader` happened to read the
/// whole turn (every notification line + the prompt response) in one
/// uninterrupted burst, the prompt worker could be scheduled first and burn
/// both zero observations before `handle_incoming` ran even once — emitting
/// `Active->Idle` ahead of the turn's content. The aggregator then flushed
/// empty buffers, closed the turn, and the real chunks (arriving afterward)
/// were stranded in a never-closed follow-up turn and lost.
///
/// We can't hook the crate's dispatcher, so we settle on a *time-bounded quiet
/// window* instead. Giving the local executor real wall-clock time guarantees
/// the ready `handle_incoming` task drains `incoming_rx` (it pulls every
/// already-buffered item in a single poll) and the spawned handlers run. We
/// only return once `notif_inflight == 0` *and* no handler has finished for at
/// least `QUIET_WINDOW` — the monotonic `notif_finished` counter
/// distinguishes "a handler just completed" from "nothing started yet", so a
/// turn that is still flushing keeps extending the window while a genuinely
/// empty turn falls through after one quiet window.
async fn await_notifications_drained(registry: &Rc<RefCell<SessionRegistry>>, acp_session_id: &str) {
    // Minimum span of no-completions + zero-inflight we require before
    // declaring the pipeline drained. Comfortably longer than the few
    // scheduler ticks it takes the executor to drain `incoming_rx` and run
    // the (trivial) handler tasks, yet negligible against multi-second turns.
    const QUIET_WINDOW: Duration = Duration::from_millis(12);
    // Hard ceiling so a wedged/removed session can never pin the prompt worker.
    const MAX_WAIT: Duration = Duration::from_millis(3000);
    // Poll cadence: real sleeps (not bare yields) so the crate's reader,
    // `handle_incoming`, and the handler tasks all get wall-clock time to run.
    const TICK: Duration = Duration::from_millis(1);

    let start = Instant::now();
    let read_state = || -> Option<(usize, u64)> {
        let guard = registry.borrow();
        guard
            .sessions
            .get(acp_session_id)
            .map(|route| (route.notif_inflight.get(), route.notif_finished.get()))
    };

    // Seed with the current completion count; any forward movement marks
    // fresh activity and restarts the quiet window.
    let mut last_finished = match read_state() {
        Some((_, finished)) => finished,
        // Session detached mid-turn: nothing left to order against.
        None => return,
    };
    let mut last_activity = Instant::now();
    let finished0 = last_finished;

    loop {
        tokio::time::sleep(TICK).await;
        let (inflight, finished) = match read_state() {
            Some(state) => state,
            None => return,
        };
        if finished != last_finished {
            last_finished = finished;
            last_activity = Instant::now();
        }
        if inflight == 0 && last_activity.elapsed() >= QUIET_WINDOW {
            debug!(session = %acp_session_id, processed = finished.wrapping_sub(finished0), waited_ms = start.elapsed().as_millis() as u64, "ACP notification drain settled");
            return;
        }
        if start.elapsed() >= MAX_WAIT {
            warn!(session = %acp_session_id, processed = finished.wrapping_sub(finished0), inflight, "ACP notification drain hit MAX_WAIT");
            return;
        }
    }
}

struct AmuxClient {
    registry: Rc<RefCell<SessionRegistry>>,
}

fn permission_kind_wire(kind: acp::PermissionOptionKind) -> String {
    match kind {
        acp::PermissionOptionKind::AllowOnce => "allow_once".to_string(),
        acp::PermissionOptionKind::AllowAlways => "allow_always".to_string(),
        acp::PermissionOptionKind::RejectOnce => "reject_once".to_string(),
        acp::PermissionOptionKind::RejectAlways => "reject_always".to_string(),
        _ => "allow_once".to_string(),
    }
}

fn amux_permission_options(options: &[acp::PermissionOption]) -> Vec<amux::AcpPermissionOption> {
    options
        .iter()
        .map(|o| amux::AcpPermissionOption {
            option_id: o.option_id.to_string(),
            kind: permission_kind_wire(o.kind),
            name: o.name.clone(),
        })
        .collect()
}

fn acp_option_for_resolution(
    options: &[acp::PermissionOption],
    resolution: &PermissionResolution,
) -> acp::PermissionOptionId {
    match resolution {
        PermissionResolution::Denied => options
            .iter()
            .find(|o| {
                matches!(
                    o.kind,
                    acp::PermissionOptionKind::RejectOnce
                        | acp::PermissionOptionKind::RejectAlways
                )
            })
            .or_else(|| options.last())
            .map(|o| o.option_id.clone())
            .unwrap_or_else(|| acp::PermissionOptionId::new("deny")),
        PermissionResolution::Granted { option_id } => {
            if let Some(id) = option_id.as_deref().filter(|s| !s.is_empty()) {
                if let Some(opt) = options.iter().find(|o| o.option_id.to_string() == id) {
                    return opt.option_id.clone();
                }
                if id == "always" {
                    if let Some(opt) = options.iter().find(|o| {
                        matches!(o.kind, acp::PermissionOptionKind::AllowAlways)
                    }) {
                        return opt.option_id.clone();
                    }
                }
                if id == "once" {
                    if let Some(opt) = options.iter().find(|o| {
                        matches!(o.kind, acp::PermissionOptionKind::AllowOnce)
                    }) {
                        return opt.option_id.clone();
                    }
                }
                return acp::PermissionOptionId::new(id);
            }
            options
                .iter()
                .find(|o| matches!(o.kind, acp::PermissionOptionKind::AllowOnce))
                .or_else(|| {
                    options.iter().find(|o| {
                        matches!(o.kind, acp::PermissionOptionKind::AllowAlways)
                    })
                })
                .or_else(|| options.first())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("allow"))
        }
    }
}

fn resolve_permission_in_registry(
    registry: &RefCell<SessionRegistry>,
    request_id: &str,
    granted: bool,
    option_id: Option<String>,
) {
    let resolution = if granted {
        PermissionResolution::Granted { option_id }
    } else {
        PermissionResolution::Denied
    };
    let mut guard = registry.borrow_mut();
    for route in guard.sessions.values_mut() {
        if let Some(tx) = route.pending_permissions.remove(request_id) {
            let _ = tx.send(resolution);
            return;
        }
    }
    warn!(request_id, "no pending permission request found");
}

#[async_trait::async_trait(?Send)]
impl acp::Client for AmuxClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        let session_id = args.session_id.to_string();
        let tool_id = args.tool_call.tool_call_id.to_string();
        let tool_name = args.tool_call.fields.title.clone().unwrap_or_default();
        let description = args
            .tool_call
            .fields
            .kind
            .map(|k| format!("{:?}", k))
            .unwrap_or_default();

        let is_gateway = {
            let guard = self.registry.borrow();
            guard
                .sessions
                .get(&session_id)
                .map(|r| r.is_gateway)
                .unwrap_or(false)
        };

        if is_gateway {
            let option_id = args
                .options
                .iter()
                .find(|o| {
                    matches!(
                        o.kind,
                        acp::PermissionOptionKind::AllowAlways
                            | acp::PermissionOptionKind::AllowOnce
                    )
                })
                .or_else(|| args.options.first())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("allow"));
            info!(
                tool_id = %tool_id,
                tool_name = %tool_name,
                "auto-allow gateway tool"
            );
            return Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    option_id,
                )),
            ));
        }

        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        {
            let event_tx = {
                let mut guard = self.registry.borrow_mut();
                let Some(route) = guard.sessions.get_mut(&session_id) else {
                    warn!(session_id, "permission request for unknown session");
                    return Ok(acp::RequestPermissionResponse::new(
                        acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                            acp::PermissionOptionId::new("deny"),
                        )),
                    ));
                };
                route
                    .pending_permissions
                    .insert(request_id.clone(), tx);
                route.event_tx.clone()
            };

            let _ = event_tx
                .send(amux::AcpEvent {
                    event: Some(amux::acp_event::Event::PermissionRequest(
                        amux::AcpPermissionRequest {
                            request_id: request_id.clone(),
                            tool_name: tool_name.clone(),
                            description,
                            params: Default::default(),
                            options: amux_permission_options(&args.options),
                        },
                    )),
                    model: String::new(),
                })
                .await;
        }

        let resolution = rx
            .await
            .unwrap_or(PermissionResolution::Denied);
        let option_id = acp_option_for_resolution(&args.options, &resolution);

        Ok(acp::RequestPermissionResponse::new(
            acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                option_id,
            )),
        ))
    }

    async fn write_text_file(
        &self,
        _args: acp::WriteTextFileRequest,
    ) -> acp::Result<acp::WriteTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn read_text_file(
        &self,
        _args: acp::ReadTextFileRequest,
    ) -> acp::Result<acp::ReadTextFileResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn create_terminal(
        &self,
        _args: acp::CreateTerminalRequest,
    ) -> acp::Result<acp::CreateTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn terminal_output(
        &self,
        _args: acp::TerminalOutputRequest,
    ) -> acp::Result<acp::TerminalOutputResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn release_terminal(
        &self,
        _args: acp::ReleaseTerminalRequest,
    ) -> acp::Result<acp::ReleaseTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn wait_for_terminal_exit(
        &self,
        _args: acp::WaitForTerminalExitRequest,
    ) -> acp::Result<acp::WaitForTerminalExitResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn kill_terminal(
        &self,
        _args: acp::KillTerminalRequest,
    ) -> acp::Result<acp::KillTerminalResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn session_notification(
        &self,
        args: acp::SessionNotification,
    ) -> acp::Result<(), acp::Error> {
        let session_id = args.session_id.to_string();
        let events = translate_session_update(args.update);
        let route = {
            let guard = self.registry.borrow();
            guard.sessions.get(&session_id).map(|r| {
                (
                    r.event_tx.clone(),
                    r.notif_inflight.clone(),
                    r.notif_finished.clone(),
                )
            })
        };
        if let Some((event_tx, inflight, finished)) = route {
            // Mark this handler in-flight *before* the first await so the
            // prompt worker's drain barrier can observe it (see
            // `await_notifications_drained`). The guard clears it once all
            // sends below complete, even on early return / panic, and bumps
            // the monotonic `finished` counter so the barrier can tell a
            // just-completed handler apart from one that never started.
            let _inflight_guard = NotifInflightGuard::new(inflight, finished);
            for event in &events {
                super::agent_trace::log_acp_event(&session_id, event);
            }
            for event in events {
                let _ = event_tx.send(event).await;
            }
        } else {
            debug!(session_id, event_count = events.len(), "dropped ACP events for detached session");
        }
        Ok(())
    }

    async fn ext_method(&self, _args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        Err(acp::Error::method_not_found())
    }

    async fn ext_notification(&self, _args: acp::ExtNotification) -> acp::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SessionUpdate -> amux::AcpEvent translation
// ---------------------------------------------------------------------------

/// Read the gateway MCP config JSON we wrote earlier and translate its
/// `mcpServers` map into ACP-native `McpServer::Stdio` entries that can ride
/// on `NewSessionRequest.mcp_servers`. Returns `None` when the file has no
/// entries; bubbles up read/parse errors so callers can degrade gracefully.
fn parse_mcp_config_to_acp(path: &std::path::Path) -> anyhow::Result<Option<Vec<acp::McpServer>>> {
    let body = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let root: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    let Some(servers) = root.get("mcpServers").and_then(|v| v.as_object()) else {
        return Ok(None);
    };
    let mut out = Vec::with_capacity(servers.len());
    for (name, def) in servers.iter() {
        let command = def
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("mcp server '{name}' missing 'command'"))?;
        let args: Vec<String> = def
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut stdio = acp::McpServerStdio::new(name.clone(), std::path::PathBuf::from(command));
        if !args.is_empty() {
            stdio = stdio.args(args);
        }
        out.push(acp::McpServer::Stdio(stdio));
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

fn translate_session_update(update: acp::SessionUpdate) -> Vec<amux::AcpEvent> {
    match update {
        acp::SessionUpdate::AgentMessageChunk(chunk) => {
            let text = extract_text(&chunk.content);
            if text.is_empty() {
                return vec![];
            }
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Output(amux::AcpOutput {
                    text,
                    is_complete: false,
                })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::AgentThoughtChunk(chunk) => {
            let text = extract_text(&chunk.content);
            if text.is_empty() {
                return vec![];
            }
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::Thinking(amux::AcpThinking { text })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::ToolCall(tc) => {
            info!(
                tool_id = %tc.tool_call_id,
                title = %tc.title,
                kind = ?tc.kind,
                status = ?tc.status,
                content_count = tc.content.len(),
                has_raw_input = tc.raw_input.is_some(),
                "ACP ToolCall"
            );
            let (tool_name, params) =
                tool_use_wire_fields(&tc.kind, &tc.title, tc.raw_input.as_ref());
            let description = tool_call_description(tc.raw_input.as_ref(), Some(&tc.content));
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                    tool_id: tc.tool_call_id.to_string(),
                    tool_name,
                    description,
                    params,
                    tool_kind: kind_to_snake(&tc.kind),
                })),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::ToolCallUpdate(tcu) => {
            info!(
                tool_id = %tcu.tool_call_id,
                title = ?tcu.fields.title,
                status = ?tcu.fields.status,
                kind = ?tcu.fields.kind,
                content_count = tcu.fields.content.as_ref().map(|c| c.len()).unwrap_or(0),
                "ACP ToolCallUpdate"
            );
            let tool_id = tcu.tool_call_id.to_string();
            let status = tcu.fields.status;
            let is_completed = matches!(
                status,
                Some(acp::ToolCallStatus::Completed) | Some(acp::ToolCallStatus::Failed)
            );

            if is_completed {
                let success = matches!(status, Some(acp::ToolCallStatus::Completed));
                let has_raw_output = tcu.fields.raw_output.is_some();
                let fallback_summary = || {
                    tcu.fields.title.clone().unwrap_or_else(|| {
                        if success {
                            "completed".into()
                        } else {
                            "failed".into()
                        }
                    })
                };
                let summary = truncate_tool_summary(
                    tool_output_summary(tcu.fields.raw_output.as_ref())
                        .or_else(|| tool_content_summary(tcu.fields.content.as_deref()))
                        .unwrap_or_else(|| {
                            if has_raw_output {
                                String::new()
                            } else {
                                fallback_summary()
                            }
                        }),
                );
                vec![amux::AcpEvent {
                    event: Some(amux::acp_event::Event::ToolResult(amux::AcpToolResult {
                        tool_id,
                        success,
                        summary,
                    })),
                    model: String::new(),
                }]
            } else {
                let kind = tcu
                    .fields
                    .kind
                    .as_ref()
                    .unwrap_or(&acp::ToolKind::Other);
                let title = tcu
                    .fields
                    .title
                    .as_deref()
                    .unwrap_or_default();
                let (tool_name, params) =
                    tool_use_wire_fields(kind, title, tcu.fields.raw_input.as_ref());
                let description = tool_call_description(
                    tcu.fields.raw_input.as_ref(),
                    tcu.fields.content.as_deref(),
                );
                if !description.is_empty() || !tool_name.is_empty() {
                    vec![amux::AcpEvent {
                        event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                            tool_id,
                            tool_name,
                            description,
                            params,
                            tool_kind: kind_to_snake(kind),
                        })),
                        model: String::new(),
                    }]
                } else {
                    vec![]
                }
            }
        }
        acp::SessionUpdate::SessionInfoUpdate(info) => {
            if let acp::MaybeUndefined::Value(title) = info.title {
                // Use RawJson to carry session title update to the main runtime
                vec![amux::AcpEvent {
                    event: Some(amux::acp_event::Event::Raw(amux::AcpRawJson {
                        method: "session_title".into(),
                        json_payload: title.into_bytes(),
                    })),
                    model: String::new(),
                }]
            } else {
                vec![]
            }
        }
        acp::SessionUpdate::AvailableCommandsUpdate(upd) => {
            let commands = upd
                .available_commands
                .into_iter()
                .map(|c| {
                    let input_hint = match c.input {
                        Some(acp::AvailableCommandInput::Unstructured(u)) => u.hint,
                        _ => String::new(),
                    };
                    amux::AcpAvailableCommand {
                        name: c.name,
                        description: c.description,
                        input_hint,
                    }
                })
                .collect();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::AvailableCommands(
                    amux::AcpAvailableCommands { commands },
                )),
                model: String::new(),
            }]
        }
        acp::SessionUpdate::Plan(plan) => {
            let entries = plan
                .entries
                .into_iter()
                .map(|e| amux::AcpPlanEntry {
                    content: e.content,
                    priority: plan_priority_to_snake(&e.priority),
                    status: plan_status_to_snake(&e.status),
                })
                .collect();
            vec![amux::AcpEvent {
                event: Some(amux::acp_event::Event::PlanUpdate(amux::AcpPlanUpdate {
                    entries,
                })),
                model: String::new(),
            }]
        }
        _ => {
            debug!("unhandled SessionUpdate variant");
            vec![]
        }
    }
}

fn plan_priority_to_snake(p: &acp::PlanEntryPriority) -> String {
    match p {
        acp::PlanEntryPriority::High => "high",
        acp::PlanEntryPriority::Medium => "medium",
        acp::PlanEntryPriority::Low => "low",
        _ => "medium",
    }
    .to_string()
}

fn plan_status_to_snake(s: &acp::PlanEntryStatus) -> String {
    match s {
        acp::PlanEntryStatus::Pending => "pending",
        acp::PlanEntryStatus::InProgress => "in_progress",
        acp::PlanEntryStatus::Completed => "completed",
        _ => "pending",
    }
    .to_string()
}

fn clean_tool_title(title: &str) -> String {
    let trimmed = title.trim().trim_matches('"').trim();
    if trimmed.is_empty() || trimmed == "undefined" {
        String::new()
    } else {
        trimmed.to_string()
    }
}

/// Canonical wire id for UI routing — from ACP `ToolKind`, never from `title`.
fn kind_to_canonical_name(kind: &acp::ToolKind) -> String {
    match kind {
        acp::ToolKind::Search => "grep".into(),
        acp::ToolKind::Read => "read".into(),
        acp::ToolKind::Edit => "edit".into(),
        acp::ToolKind::Fetch => "web_search".into(),
        acp::ToolKind::Execute => "bash".into(),
        acp::ToolKind::Delete => "delete".into(),
        acp::ToolKind::Move => "move".into(),
        acp::ToolKind::Think => "think".into(),
        _ => "other".into(),
    }
}

/// Map ACP tool call to wire fields. Human `title` → params.description only.
fn tool_use_wire_fields(
    kind: &acp::ToolKind,
    title: &str,
    raw_input: Option<&serde_json::Value>,
) -> (String, HashMap<String, String>) {
    let mut params = tool_call_params(raw_input);
    let human_title = clean_tool_title(title);
    if !human_title.is_empty() && !params.contains_key("description") {
        params.insert("description".to_string(), human_title);
    }
    (kind_to_canonical_name(kind), params)
}

fn kind_to_name(kind: &acp::ToolKind) -> String {
    kind_to_canonical_name(kind)
}

// ACP ToolKind → snake_case wire string for `AcpToolUse.tool_kind`.
// Matches the ACP JSON schema serde rename so renderers can switch on
// the same vocabulary as the protocol.
fn kind_to_snake(kind: &acp::ToolKind) -> String {
    match kind {
        acp::ToolKind::Read => "read",
        acp::ToolKind::Edit => "edit",
        acp::ToolKind::Delete => "delete",
        acp::ToolKind::Move => "move",
        acp::ToolKind::Search => "search",
        acp::ToolKind::Execute => "execute",
        acp::ToolKind::Think => "think",
        acp::ToolKind::Fetch => "fetch",
        acp::ToolKind::SwitchMode => "switch_mode",
        _ => "other",
    }
    .to_string()
}

fn extract_text(content: &acp::ContentBlock) -> String {
    match content {
        acp::ContentBlock::Text(t) => t.text.clone(),
        acp::ContentBlock::Image(_) => "<image>".into(),
        acp::ContentBlock::Audio(_) => "<audio>".into(),
        acp::ContentBlock::ResourceLink(rl) => rl.uri.clone(),
        acp::ContentBlock::Resource(_) => "<resource>".into(),
        _ => String::new(),
    }
}

fn tool_call_description(
    raw_input: Option<&serde_json::Value>,
    content: Option<&[acp::ToolCallContent]>,
) -> String {
    raw_input
        .map(|v| v.to_string())
        .or_else(|| content.and_then(|items| items.first().map(|item| format!("{:?}", item))))
        .unwrap_or_default()
}

fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        _ => value.to_string(),
    }
}

fn tool_call_params(raw_input: Option<&serde_json::Value>) -> HashMap<String, String> {
    match raw_input {
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .map(|(key, value)| (key.clone(), json_value_to_string(value)))
            .collect(),
        Some(value) => HashMap::from([("input".to_string(), json_value_to_string(value))]),
        None => HashMap::new(),
    }
}

fn tool_output_summary(raw_output: Option<&serde_json::Value>) -> Option<String> {
    let value = raw_output?;
    json_tool_output_text(value).or_else(|| match value {
        serde_json::Value::Object(map) => {
            if map.contains_key("metadata") || map.contains_key("content") {
                None
            } else {
                let text = json_value_to_string(value);
                if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            }
        }
        serde_json::Value::Array(_) => None,
        _ => {
            let text = json_value_to_string(value);
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
    })
}

fn json_tool_output_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            if text.is_empty() {
                None
            } else {
                Some(text.clone())
            }
        }
        serde_json::Value::Object(map) => {
            for key in ["raw", "output", "result", "text"] {
                if let Some(summary) = map.get(key).and_then(json_tool_output_text) {
                    return Some(summary);
                }
            }

            let stdio = ["stdout", "stderr"]
                .into_iter()
                .filter_map(|key| map.get(key).and_then(json_tool_output_text))
                .filter(|text| !text.trim().is_empty())
                .collect::<Vec<_>>();
            if !stdio.is_empty() {
                return Some(stdio.join("\n"));
            }

            if let Some(summary) = map.get("metadata").and_then(json_tool_output_text) {
                return Some(summary);
            }

            map.get("content").and_then(json_content_summary)
        }
        serde_json::Value::Array(_) => json_content_summary(value),
        serde_json::Value::Null => None,
        _ => {
            let text = value.to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
    }
}

fn json_content_summary(value: &serde_json::Value) -> Option<String> {
    let items = value.as_array()?;
    let mut parts = Vec::new();
    for item in items {
        match item {
            serde_json::Value::String(text) if !text.trim().is_empty() => {
                parts.push(text.clone());
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(text)) = map.get("text") {
                    if !text.trim().is_empty() {
                        parts.push(text.clone());
                    }
                } else if let Some(text) = map.get("content").and_then(json_tool_output_text) {
                    if !text.trim().is_empty() {
                        parts.push(text);
                    }
                }
            }
            _ => {}
        }
    }
    let text = parts.join("\n\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn tool_content_summary(content: Option<&[acp::ToolCallContent]>) -> Option<String> {
    let content = content?;
    let mut parts = Vec::new();
    for item in content {
        match item {
            acp::ToolCallContent::Content(content) => {
                let text = extract_text(&content.content);
                if !text.trim().is_empty() {
                    parts.push(text);
                }
            }
            acp::ToolCallContent::Diff(_) => {}
            acp::ToolCallContent::Terminal(_) => {}
            _ => {}
        }
    }
    let text = parts.join("\n\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn truncate_tool_summary(summary: String) -> String {
    const LIMIT: usize = 20_000;
    if summary.chars().count() > LIMIT {
        format!("{}...", summary.chars().take(LIMIT).collect::<String>())
    } else {
        summary
    }
}

// ---------------------------------------------------------------------------
// Attachment → ACP ContentBlock
// ---------------------------------------------------------------------------

static IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

/// Return the (path, extension) for a URL, stripping the query string FIRST
/// so a JWT in `?token=…` (Supabase signed URLs put one there, and the JWT
/// payload contains `.` separators) does not poison the `rsplit('.')` ext
/// sniff. Without this, `eyJ.foo.bar` makes every signed image URL look
/// like it ends in `.bar` and the image gets misclassified as a non-image
/// ResourceLink.
fn path_and_ext(url: &str) -> (&str, String) {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    (path, ext)
}

/// Download a Supabase Storage URL and return the appropriate ACP ContentBlock:
/// - Image extensions → ContentBlock::Image (base64-encoded bytes)
/// - All others       → ContentBlock::ResourceLink (URL reference)
async fn build_attachment_block(url: &str) -> anyhow::Result<acp::ContentBlock> {
    let (path, ext) = path_and_ext(url);

    if IMAGE_EXTS.contains(&ext.as_str()) {
        let bytes = reqwest::get(url).await?.bytes().await?;
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => "image/png",
        };
        Ok(acp::ContentBlock::Image(acp::ImageContent::new(data, mime)))
    } else {
        let name = path.rsplit('/').next().unwrap_or("attachment").to_string();
        Ok(acp::ContentBlock::ResourceLink(acp::ResourceLink::new(
            name, url,
        )))
    }
}

fn should_use_claude_agent_acp_wrapper(binary: &str) -> bool {
    let binary_name = Path::new(binary)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(binary);

    binary_name == "claude" || binary_name == "claude-agent-acp"
}

/// Build a PATH for spawned agent runtimes that includes common user-level
/// binary directories.
///
/// amuxd is typically launched by launchd (macOS) or systemd (Linux) with a
/// minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew
/// (`/opt/homebrew/bin`), `~/.local/bin`, and the other locations where agent
/// runtimes like `npx`, `opencode`, and `claude` actually live. Without this,
/// the ClaudeCode ACP wrapper (`npx @zed-industries/claude-agent-acp`) fails to
/// spawn with `ENOENT`, surfaced to clients as the opaque "ACP host init
/// channel closed".
///
/// Inherited PATH entries keep priority; the well-known directories are
/// appended as fallbacks, and duplicates are removed preserving first
/// occurrence. The extra directories are harmless on platforms where they don't
/// exist — a non-existent PATH entry is simply skipped during lookup.
fn enriched_spawn_path(existing: Option<&str>, home: Option<&Path>) -> String {
    let mut candidates: Vec<String> = Vec::new();

    // Inherited PATH first — preserves whatever the launcher configured.
    if let Some(existing) = existing {
        candidates.extend(existing.split(':').map(|s| s.to_string()));
    }

    // Well-known user-level bin dirs that minimal launchd/systemd PATHs omit.
    if let Some(home) = home {
        for sub in [".local/bin", ".npm-global/bin", ".bun/bin", ".cargo/bin"] {
            candidates.push(home.join(sub).to_string_lossy().into_owned());
        }
    }
    for dir in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
        candidates.push(dir.to_string());
    }

    // Dedupe preserving first occurrence; drop empty segments.
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|d| !d.is_empty() && seen.insert(d.clone()))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod attachment_ext_tests {
    use super::path_and_ext;

    #[test]
    fn plain_image_url_yields_jpg() {
        let (_, ext) = path_and_ext("https://x.supabase.co/photo-abc.jpg");
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn signed_url_with_jwt_in_query_yields_image_ext_not_jwt_segment() {
        // Supabase signed URLs carry a JWT whose payload contains `.`. The
        // pre-fix code grabbed "bar" (the JWT tail) and treated the file as
        // a non-image. Verify we now strip `?token=…` first.
        let url = "https://x.supabase.co/storage/v1/object/sign/attachments/t/s/abc/photo.png?token=eyJ.foo.bar";
        let (_, ext) = path_and_ext(url);
        assert_eq!(ext, "png");
    }

    #[test]
    fn url_without_extension_returns_empty_string() {
        let (_, ext) = path_and_ext("https://x.supabase.co/storage/v1/object/sign/bin/no-ext");
        // No `.` in path → rsplit yields the whole path; ext won't match
        // any image type, so caller falls back to ResourceLink. The exact
        // value here is incidental but documenting the no-`.` case keeps
        // anyone refactoring the helper from re-introducing the bug.
        assert_ne!(ext, "jpg");
        assert_ne!(ext, "png");
    }
}

#[cfg(test)]
mod command_selection_tests {
    use super::should_use_claude_agent_acp_wrapper;

    #[test]
    fn claude_binary_name_uses_acp_wrapper() {
        assert!(should_use_claude_agent_acp_wrapper("claude"));
    }

    #[test]
    fn absolute_claude_path_uses_acp_wrapper() {
        assert!(should_use_claude_agent_acp_wrapper(
            "/Users/matt.chow/.local/bin/claude"
        ));
    }

    #[test]
    fn non_claude_binary_does_not_use_acp_wrapper() {
        assert!(!should_use_claude_agent_acp_wrapper(
            "/Users/matt.chow/.opencode/bin/opencode"
        ));
    }
}

#[cfg(test)]
mod spawn_path_tests {
    use super::enriched_spawn_path;
    use std::path::Path;

    #[test]
    fn appends_homebrew_and_user_local_to_minimal_path() {
        // launchd hands amuxd this minimal PATH, which omits Homebrew and
        // ~/.local/bin where npx/opencode/claude live.
        let path = enriched_spawn_path(
            Some("/usr/bin:/bin:/usr/sbin:/sbin"),
            Some(Path::new("/Users/x")),
        );
        let dirs: Vec<&str> = path.split(':').collect();
        assert!(
            dirs.contains(&"/opt/homebrew/bin"),
            "missing homebrew bin: {path}"
        );
        assert!(
            dirs.contains(&"/Users/x/.local/bin"),
            "missing ~/.local/bin: {path}"
        );
        // Inherited entries keep priority (come first).
        assert!(
            path.starts_with("/usr/bin:/bin:/usr/sbin:/sbin"),
            "inherited PATH not first: {path}"
        );
    }

    #[test]
    fn dedupes_existing_entries() {
        let path = enriched_spawn_path(
            Some("/opt/homebrew/bin:/usr/bin"),
            Some(Path::new("/home/u")),
        );
        let count = path
            .split(':')
            .filter(|d| *d == "/opt/homebrew/bin")
            .count();
        assert_eq!(count, 1, "duplicate homebrew entry: {path}");
    }

    #[test]
    fn handles_missing_existing_path() {
        let path = enriched_spawn_path(None, Some(Path::new("/home/u")));
        assert!(path.split(':').any(|d| d == "/home/u/.local/bin"), "{path}");
        assert!(path.split(':').any(|d| d == "/opt/homebrew/bin"), "{path}");
    }
}

// ---------------------------------------------------------------------------
// Public API: long-lived ACP host (initialize once, many session/new)
// ---------------------------------------------------------------------------

struct ActiveSession {
    prompt_tx: mpsc::Sender<(String, Vec<String>)>,
}

fn build_acp_process_command(
    binary: &str,
    args: &[String],
    agent_type: amux::AgentType,
    extra_env: &HashMap<String, String>,
    force_env_keys: &std::collections::HashSet<String>,
) -> tokio::process::Command {
    let mut cmd = if should_use_claude_agent_acp_wrapper(binary) {
        let mut c = tokio::process::Command::new("npx");
        c.arg("--yes").arg("@zed-industries/claude-agent-acp");
        c
    } else if (agent_type == amux::AgentType::Opencode || agent_type == amux::AgentType::Codex)
        && args.is_empty()
    {
        let mut c = tokio::process::Command::new(binary);
        c.arg("acp");
        c
    } else {
        let mut c = tokio::process::Command::new(binary);
        c.args(args);
        c
    };
    // amuxd is usually launched by launchd/systemd with a minimal PATH that
    // omits Homebrew and ~/.local/bin, so the agent runtime (npx/opencode/
    // claude) can't be found and spawn fails with ENOENT. Enrich PATH before
    // applying caller-supplied env so a forced PATH override still wins.
    cmd.env(
        "PATH",
        enriched_spawn_path(
            std::env::var("PATH").ok().as_deref(),
            std::env::var_os("HOME").map(PathBuf::from).as_deref(),
        ),
    );
    for (key, value) in extra_env {
        if force_env_keys.contains(key) || std::env::var_os(key).is_none() {
            cmd.env(key, value);
        }
    }
    cmd
}

/// Spawn a long-lived ACP host thread. Returns a command sender immediately;
/// `host_ready_tx` is fulfilled after ACP `initialize` completes.
pub fn spawn_acp_host(
    binary: String,
    args: Vec<String>,
    agent_type: amux::AgentType,
    extra_env: HashMap<String, String>,
    force_env_override: bool,
    host_ready_tx: oneshot::Sender<Result<(), String>>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<AcpCommand>(64);

    std::thread::Builder::new()
        .name(format!("acp-host-{agent_type:?}"))
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build tokio runtime for ACP host");

            let local_set = tokio::task::LocalSet::new();
            rt.block_on(local_set.run_until(async move {
                if let Err(e) = run_acp_host(
                    binary,
                    args,
                    agent_type,
                    extra_env,
                    force_env_override,
                    cmd_rx,
                    host_ready_tx,
                )
                .await
                {
                    error!(error = %e, "ACP host failed");
                }
            }));
        })
        .map_err(|e| {
            crate::error::AmuxError::Agent(format!("failed to spawn ACP host thread: {}", e))
        })?;

    Ok(cmd_tx)
}

/// Attach a TeamClaw runtime to an initialized ACP host via `session/new`.
#[allow(clippy::too_many_arguments)]
async fn attach_acp_session_on_conn(
    conn: &acp::ClientSideConnection,
    registry: &Rc<RefCell<SessionRegistry>>,
    agent_type: amux::AgentType,
    worktree: &str,
    resume_acp_session_id: Option<String>,
    mcp_config_path: Option<PathBuf>,
    initial_model_override: Option<String>,
    event_tx: mpsc::Sender<amux::AcpEvent>,
    is_gateway: bool,
) -> anyhow::Result<AcpStartupMetadata> {
    let worktree_path = std::path::PathBuf::from(worktree);
    let acp_mcp_servers: Vec<acp::McpServer> = match mcp_config_path.as_ref() {
        Some(p) => match parse_mcp_config_to_acp(p) {
            Ok(Some(v)) => v,
            Ok(None) => Vec::new(),
            Err(e) => {
                warn!(error = %e, "MCP config parse failed; agent will spawn without send tool");
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    let build_new_req = |cwd: std::path::PathBuf| -> acp::NewSessionRequest {
        let mut req = acp::NewSessionRequest::new(cwd);
        if !acp_mcp_servers.is_empty() {
            req = req.mcp_servers(acp_mcp_servers.clone());
        }
        req
    };

    let t_session = Instant::now();
    let (session_id, acp_lists) = if let Some(ref resume_id) = resume_acp_session_id {
        let resume_req = acp::ResumeSessionRequest::new(
            acp::SessionId::new(resume_id.clone()),
            worktree_path.clone(),
        );
        match conn.resume_session(resume_req).await {
            Ok(resp) => {
                let sid = acp::SessionId::new(resume_id.clone());
                info!(
                    session_id = %sid,
                    resume_ms = t_session.elapsed().as_millis() as u64,
                    "ACP session resumed on host"
                );
                (
                    sid,
                    (resp.models, resp.config_options),
                )
            }
            Err(e) => {
                warn!(
                    resume_id,
                    "ACP resume_session failed ({}), falling back to new_session", e
                );
                let resp = conn
                    .new_session(build_new_req(worktree_path.clone()))
                    .await
                    .map_err(|e| anyhow::anyhow!("ACP new_session failed: {}", e))?;
                let sid = resp.session_id.clone();
                info!(
                    session_id = %sid,
                    new_session_ms = t_session.elapsed().as_millis() as u64,
                    "ACP session created on host (fallback)"
                );
                (sid, (resp.models, resp.config_options))
            }
        }
    } else {
        let resp = conn
            .new_session(build_new_req(worktree_path))
            .await
            .map_err(|e| anyhow::anyhow!("ACP new_session failed: {}", e))?;
        let sid = resp.session_id.clone();
        info!(
            session_id = %sid,
            new_session_ms = t_session.elapsed().as_millis() as u64,
            "ACP session created on host"
        );
        (sid, (resp.models, resp.config_options))
    };

    let acp_session_key = session_id.to_string();
    registry.borrow_mut().sessions.insert(
        acp_session_key.clone(),
        SessionRoute {
            event_tx: event_tx.clone(),
            is_gateway,
            pending_permissions: HashMap::new(),
            notif_inflight: Rc::new(Cell::new(0)),
            notif_finished: Rc::new(Cell::new(0)),
        },
    );

    let (acp_model_state, acp_config_options) = acp_lists;
    let acp_current_model_id = crate::runtime::models::resolve_current_model_id(
        acp_model_state.as_ref(),
        acp_config_options.as_deref(),
    );
    let available_models = crate::runtime::models::resolve_available_models(
        agent_type,
        acp_model_state.as_ref(),
        acp_config_options.as_deref(),
    );
    info!(
        agent_type = ?agent_type,
        source = crate::runtime::models::available_models_source_label(
            acp_model_state.as_ref(),
            acp_config_options.as_deref(),
        ),
        count = available_models.len(),
        "available models resolved",
    );

    let initial_model: Option<String> = {
        let chosen = initial_model_override
            .clone()
            .or_else(|| acp_current_model_id.clone())
            .or_else(|| available_models.first().map(|m| m.id.clone()));
        match chosen {
            Some(model_id) if acp_current_model_id.as_ref() == Some(&model_id) => Some(model_id),
            Some(model_id) => {
                let req = acp::SetSessionModelRequest::new(
                    session_id.clone(),
                    acp::ModelId::new(model_id.clone()),
                );
                match conn.set_session_model(req).await {
                    Ok(_) => {
                        info!(model_id = %model_id, "ACP initial set_session_model applied");
                        Some(model_id)
                    }
                    Err(e) => {
                        warn!(error = %e, model_id = %model_id, "initial set_session_model failed");
                        acp_current_model_id.clone()
                    }
                }
            }
            None => None,
        }
    };

    Ok(AcpStartupMetadata {
        available_models,
        initial_model,
        acp_session_id: acp_session_key,
    })
}

fn spawn_prompt_worker(
    conn: Rc<acp::ClientSideConnection>,
    session_id: acp::SessionId,
    event_tx: mpsc::Sender<amux::AcpEvent>,
    registry: Rc<RefCell<SessionRegistry>>,
    mut prompt_rx: mpsc::Receiver<(String, Vec<String>)>,
) {
    let acp_session_key = session_id.to_string();
    tokio::task::spawn_local(async move {
        while let Some((text, attachment_urls)) = prompt_rx.recv().await {
            let attachment_count = attachment_urls.len();
            super::agent_trace::log_prompt_begin(&acp_session_key, &text, attachment_count);
            let turn_started = Instant::now();

            let status_active = amux::AcpEvent {
                event: Some(amux::acp_event::Event::StatusChange(
                    amux::AcpStatusChange {
                        old_status: amux::AgentStatus::Idle as i32,
                        new_status: amux::AgentStatus::Active as i32,
                    },
                )),
                model: String::new(),
            };
            super::agent_trace::log_acp_event(&acp_session_key, &status_active);
            let _ = event_tx.send(status_active).await;

            let mut blocks: Vec<acp::ContentBlock> = vec![text.into()];
            for url in &attachment_urls {
                match build_attachment_block(url).await {
                    Ok(block) => blocks.push(block),
                    Err(e) => warn!(url = %url, err = %e, "attachment fetch failed; skipping"),
                }
            }

            let result = conn
                .prompt(acp::PromptRequest::new(session_id.clone(), blocks))
                .await;

            // Every prompt completion — success, provider error, or cancel/
            // abort — must close the turn with Active→Idle so clients can
            // finalize partial streaming content.
            await_notifications_drained(&registry, &acp_session_key).await;
            let status_idle = amux::AcpEvent {
                event: Some(amux::acp_event::Event::StatusChange(
                    amux::AcpStatusChange {
                        old_status: amux::AgentStatus::Active as i32,
                        new_status: amux::AgentStatus::Idle as i32,
                    },
                )),
                model: String::new(),
            };
            super::agent_trace::log_acp_event(&acp_session_key, &status_idle);
            let _ = event_tx.send(status_idle).await;

            let elapsed_ms = turn_started.elapsed().as_millis() as u64;
            match result {
                Ok(_) => {
                    super::agent_trace::log_prompt_end(&acp_session_key, true, "", elapsed_ms);
                }
                Err(e) => {
                    let details = format!("ACP prompt failed: {e}");
                    super::agent_trace::log_prompt_end(&acp_session_key, false, &details, elapsed_ms);
                    emit_acp_error(
                        &event_tx,
                        &acp_session_key,
                        "ACP prompt failed",
                        details,
                    )
                    .await;
                }
            }
        }
    });
}

/// Long-lived ACP host: `initialize` once, then `session/new` per AttachSession.
async fn run_acp_host(
    binary: String,
    args: Vec<String>,
    agent_type: amux::AgentType,
    extra_env: HashMap<String, String>,
    force_env_override: bool,
    mut cmd_rx: mpsc::Receiver<AcpCommand>,
    host_ready_tx: oneshot::Sender<Result<(), String>>,
) -> anyhow::Result<()> {
    let force_env_keys: std::collections::HashSet<String> = if force_env_override {
        extra_env.keys().cloned().collect()
    } else {
        std::collections::HashSet::new()
    };
    let mut cmd = build_acp_process_command(
        &binary,
        &args,
        agent_type,
        &extra_env,
        &force_env_keys,
    );
    let mut child = cmd
        .current_dir(".")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow::anyhow!("spawn ACP host: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;

    if let Some(stderr) = child.stderr.take() {
        tokio::task::spawn_local(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!(target: "acp_stderr", "{}", line);
            }
        });
    }

    info!(binary = %binary, agent_type = ?agent_type, "ACP host process spawned");

    let registry = Rc::new(RefCell::new(SessionRegistry::default()));
    let client = AmuxClient {
        registry: registry.clone(),
    };

    let (conn, handle_io) =
        acp::ClientSideConnection::new(client, stdin.compat_write(), stdout.compat(), |fut| {
            tokio::task::spawn_local(fut);
        });

    let (fatal_tx, mut fatal_rx) = mpsc::channel::<String>(4);
    let io_fatal_tx = fatal_tx.clone();
    tokio::task::spawn_local(async move {
        let message = match handle_io.await {
            Ok(()) => "ACP IO task ended".to_string(),
            Err(e) => format!("ACP IO task ended: {e}"),
        };
        warn!("{}", message);
        let _ = io_fatal_tx.send(message).await;
    });

    let t_init = Instant::now();
    conn.initialize(
        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
            .client_info(acp::Implementation::new("amuxd", "0.1.0").title("AMUX Daemon")),
    )
    .await
    .map_err(|e| anyhow::anyhow!("ACP initialize failed: {}", e))?;

    info!(
        agent_type = ?agent_type,
        initialize_ms = t_init.elapsed().as_millis() as u64,
        "ACP host initialized"
    );
    let _ = host_ready_tx.send(Ok(()));

    let conn = Rc::new(conn);
    let mut active_sessions: HashMap<String, ActiveSession> = HashMap::new();

    let child_wait = child.wait();
    tokio::pin!(child_wait);
    loop {
        tokio::select! {
            maybe_cmd = cmd_rx.recv() => {
                let Some(cmd) = maybe_cmd else {
                    break;
                };
                match cmd {
                    AcpCommand::AttachSession {
                        worktree,
                        resume_acp_session_id,
                        mcp_config_path,
                        initial_model_override,
                        initial_prompt,
                        event_tx,
                        startup_tx,
                        is_gateway,
                    } => {
                        let startup_reporter: StartupReporter =
                            Arc::new(Mutex::new(Some(startup_tx)));
                        let attach_session_label = resume_acp_session_id
                            .as_deref()
                            .unwrap_or("new-session")
                            .to_string();
                        let attach_result = attach_acp_session_on_conn(
                            &conn,
                            &registry,
                            agent_type,
                            &worktree,
                            resume_acp_session_id,
                            mcp_config_path,
                            initial_model_override,
                            event_tx.clone(),
                            is_gateway,
                        )
                        .await;

                        match attach_result {
                            Ok(meta) => {
                                let acp_sid = meta.acp_session_id.clone();
                                let session_id = acp::SessionId::new(acp_sid.clone());
                                let (prompt_tx, prompt_rx) = mpsc::channel::<(String, Vec<String>)>(64);
                                spawn_prompt_worker(
                                    conn.clone(),
                                    session_id,
                                    event_tx.clone(),
                                    registry.clone(),
                                    prompt_rx,
                                );
                                active_sessions.insert(acp_sid.clone(), ActiveSession { prompt_tx });
                                report_startup(&startup_reporter, Ok(meta));
                                if !initial_prompt.is_empty() {
                                    if let Some(active) = active_sessions.get(&acp_sid) {
                                        let _ = active.prompt_tx.send((initial_prompt, Vec::new())).await;
                                    }
                                }
                            }
                            Err(e) => {
                                let details = format!("{e:#}");
                                report_startup(&startup_reporter, Err(details.clone()));
                                let session_label = attach_session_label.as_str();
                                emit_acp_error(
                                    &event_tx,
                                    session_label,
                                    "ACP attach failed",
                                    details,
                                )
                                .await;
                            }
                        }
                    }
                    AcpCommand::Prompt { acp_session_id, text, attachment_urls } => {
                        if let Some(active) = active_sessions.get(&acp_session_id) {
                            if active.prompt_tx.send((text, attachment_urls)).await.is_err() {
                                if let Some(route) = registry.borrow().sessions.get(&acp_session_id) {
                                    emit_acp_error(
                                        &route.event_tx,
                                        &acp_session_id,
                                        "ACP prompt failed",
                                        "ACP prompt worker stopped",
                                    )
                                    .await;
                                }
                            }
                        } else {
                            warn!(acp_session_id, "prompt for unknown session");
                        }
                    }
                    AcpCommand::Cancel { acp_session_id } => {
                        match conn
                            .cancel(acp::CancelNotification::new(acp::SessionId::new(
                                acp_session_id.clone(),
                            )))
                            .await
                        {
                            Ok(()) => {
                                super::agent_trace::log_cancel(&acp_session_id, true, "");
                            }
                            Err(e) => {
                                let err = e.to_string();
                                super::agent_trace::log_cancel(&acp_session_id, false, &err);
                                warn!(acp_session_id = %acp_session_id, error = %err, "ACP cancel failed");
                            }
                        }
                    }
                    AcpCommand::ResolvePermission {
                        request_id,
                        granted,
                        option_id,
                    } => {
                        resolve_permission_in_registry(
                            &registry,
                            &request_id,
                            granted,
                            option_id,
                        );
                    }
                    AcpCommand::SetModel { acp_session_id, model_id } => {
                        let req = acp::SetSessionModelRequest::new(
                            acp::SessionId::new(acp_session_id.clone()),
                            acp::ModelId::new(model_id.clone()),
                        );
                        if let Err(e) = conn.set_session_model(req).await {
                            warn!(error = %e, model_id = %model_id, "set_session_model failed");
                        } else {
                            info!(model_id = %model_id, "set_session_model applied");
                        }
                    }
                    AcpCommand::DetachSession { acp_session_id } => {
                        active_sessions.remove(&acp_session_id);
                        registry.borrow_mut().sessions.remove(&acp_session_id);
                        info!(acp_session_id, "ACP session detached from host");
                    }
                    AcpCommand::Shutdown => {
                        info!("ACP host shutting down");
                        break;
                    }
                }
            }
            Some(message) = fatal_rx.recv() => {
                return Err(anyhow::anyhow!(message));
            }
            status = &mut child_wait => {
                let message = match status {
                    Ok(status) => format!("ACP host process exited: {status}"),
                    Err(e) => format!("ACP host process wait failed: {e}"),
                };
                return Err(anyhow::anyhow!(message));
            }
        }
    }

    info!(agent_type = ?agent_type, "ACP host thread exiting");
    Ok(())
}

/// Legacy single-session helper used by the `amuxd acp` debug CLI.
/// Production runtimes attach via [`AcpHostPool`] instead.
#[allow(clippy::too_many_arguments)]
pub fn spawn_acp_agent(
    binary: String,
    args: Vec<String>,
    worktree: String,
    initial_prompt: String,
    agent_type: amux::AgentType,
    event_tx: mpsc::Sender<amux::AcpEvent>,
    resume_acp_session_id: Option<String>,
    startup_tx: oneshot::Sender<Result<AcpStartupMetadata, String>>,
    initial_model_override: Option<String>,
    mcp_config_path: Option<PathBuf>,
    extra_env: HashMap<String, String>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let (host_ready_tx, host_ready_rx) = oneshot::channel();
    let cmd_tx = spawn_acp_host(binary, args, agent_type, extra_env, false, host_ready_tx)?;
    let host_cmd = cmd_tx.clone();
    std::thread::Builder::new()
        .name("acp-cli-attach".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("cli attach runtime");
            rt.block_on(async move {
                if host_ready_rx.await.ok().and_then(|r| r.ok()).is_some() {
                    let _ = host_cmd
                        .send(AcpCommand::AttachSession {
                            worktree,
                            resume_acp_session_id,
                            mcp_config_path,
                            initial_model_override,
                            initial_prompt,
                            event_tx,
                            startup_tx,
                            is_gateway: false,
                        })
                        .await;
                }
            });
        })
        .map_err(|e| {
            crate::error::AmuxError::Agent(format!("failed to spawn CLI attach thread: {}", e))
        })?;
    Ok(cmd_tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_available_commands_update_without_input() {
        let upd = acp::AvailableCommandsUpdate::new(vec![acp::AvailableCommand::new(
            "clear",
            "Clear history",
        )]);
        let events = translate_session_update(acp::SessionUpdate::AvailableCommandsUpdate(upd));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::AvailableCommands(ac) => {
                assert_eq!(ac.commands.len(), 1);
                assert_eq!(ac.commands[0].name, "clear");
                assert_eq!(ac.commands[0].description, "Clear history");
                assert_eq!(ac.commands[0].input_hint, "");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_available_commands_update_with_unstructured_input() {
        let cmd = acp::AvailableCommand::new("rename", "Rename the session").input(Some(
            acp::AvailableCommandInput::Unstructured(acp::UnstructuredCommandInput::new(
                "new session name",
            )),
        ));
        let upd = acp::AvailableCommandsUpdate::new(vec![cmd]);
        let events = translate_session_update(acp::SessionUpdate::AvailableCommandsUpdate(upd));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::AvailableCommands(ac) => {
                assert_eq!(ac.commands[0].input_hint, "new session name");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn tool_use_wire_fields_maps_execute_kind_not_title() {
        let (tool_name, params) = tool_use_wire_fields(
            &acp::ToolKind::Execute,
            "Execute ps command",
            Some(&serde_json::json!({ "command": "ps aux" })),
        );
        assert_eq!(tool_name, "bash");
        assert_eq!(params.get("command"), Some(&"ps aux".to_string()));
        assert_eq!(
            params.get("description"),
            Some(&"Execute ps command".to_string())
        );
    }

    #[test]
    fn translates_tool_call_update_raw_input_to_tool_use_update() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .kind(acp::ToolKind::Search)
                .title("grep")
                .raw_input(serde_json::json!({
                    "pattern": "MQTT",
                    "path": "apps/daemon/src"
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolUse(tool) => {
                assert_eq!(tool.tool_id, "tool-1");
                assert_eq!(tool.tool_name, "grep");
                assert_eq!(
                    tool.params.get("description"),
                    Some(&"grep".to_string())
                );
                assert_eq!(tool.params.get("pattern"), Some(&"MQTT".to_string()));
                assert_eq!(
                    tool.params.get("path"),
                    Some(&"apps/daemon/src".to_string())
                );
                assert!(tool.description.contains("\"pattern\":\"MQTT\""));
                assert!(tool.description.contains("\"path\":\"apps/daemon/src\""));
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_raw_output_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Execute ps command")
                .raw_output(serde_json::json!({
                    "output": "pid command\n1 launchd"
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "pid command\n1 launchd");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_metadata_output_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("List top processes")
                .raw_output(serde_json::json!({
                    "metadata": {
                        "output": "TC_STDOUT_MARKER_20260525\n",
                        "exit": 0,
                        "description": "List top processes",
                        "truncated": false
                    }
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "TC_STDOUT_MARKER_20260525\n");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_opencode_completed_tool_call_output_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "call_00_c8LarilfiBvzfOzS2oLQ3075",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Top 10 processes by CPU")
                .content(vec!["PID %CPU COMM\n50369 opencode\n".into()])
                .raw_output(serde_json::json!({
                    "output": "PID %CPU COMM\n50369 opencode\n",
                    "metadata": {
                        "output": "PID %CPU COMM\n50369 opencode\n",
                        "exit": 0,
                        "description": "Top 10 processes by CPU",
                        "truncated": false
                    }
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "call_00_c8LarilfiBvzfOzS2oLQ3075");
                assert!(result.success);
                assert_eq!(result.summary, "PID %CPU COMM\n50369 opencode\n");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn completed_tool_call_empty_metadata_output_has_empty_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("List top processes")
                .raw_output(serde_json::json!({
                    "metadata": {
                        "output": "",
                        "exit": 0,
                        "description": "List top processes",
                        "truncated": false
                    }
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_content_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Execute ps command")
                .content(vec!["pid command\n1 launchd".into()]),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "pid command\n1 launchd");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_nested_raw_content_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Execute ps command")
                .raw_output(serde_json::json!({
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": "pid command\n1 launchd"
                            }
                        }
                    ]
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "pid command\n1 launchd");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn translates_completed_tool_call_stdout_stderr_to_result_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Failed)
                .title("Execute failing command")
                .raw_output(serde_json::json!({
                    "stdout": "before failure",
                    "stderr": "permission denied"
                })),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(!result.success);
                assert_eq!(result.summary, "before failure\npermission denied");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }

    #[test]
    fn completed_tool_call_diff_content_does_not_use_full_replacement_as_summary() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
                .status(acp::ToolCallStatus::Completed)
                .title("Edit src/main.rs")
                .content(vec![acp::Diff::new("src/main.rs", "fn main() {}\n").into()]),
        );
        let events = translate_session_update(acp::SessionUpdate::ToolCallUpdate(update));

        assert_eq!(events.len(), 1);
        match events[0].event.as_ref().expect("event") {
            amux::acp_event::Event::ToolResult(result) => {
                assert_eq!(result.tool_id, "tool-1");
                assert!(result.success);
                assert_eq!(result.summary, "Edit src/main.rs");
            }
            other => panic!("unexpected variant: {:?}", other),
        }
    }
}
