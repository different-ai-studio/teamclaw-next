use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use acp::Agent as _; // bring trait methods into scope
use agent_client_protocol as acp;
use base64::Engine as _;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use tracing::{debug, error, info, warn};

use crate::proto::amux;

// ---------------------------------------------------------------------------
// Messages sent INTO the ACP LocalSet thread
// ---------------------------------------------------------------------------

/// Commands the main tokio runtime sends to the ACP thread.
pub enum AcpCommand {
    /// Send a prompt to the running session.
    Prompt {
        text: String,
        attachment_urls: Vec<String>,
    },
    /// Cancel the current turn.
    Cancel,
    /// Resolve a pending permission request.
    ResolvePermission { request_id: String, granted: bool },
    /// Switch the model used by the current session.
    SetModel { model_id: String },
    /// Shut down the agent.
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
    message: impl Into<String>,
    details: impl Into<String>,
) {
    let _ = event_tx
        .send(amux::AcpEvent {
            event: Some(amux::acp_event::Event::Error(amux::AcpError {
                message: message.into(),
                details: details.into(),
            })),
            model: String::new(),
        })
        .await;
}

// ---------------------------------------------------------------------------
// AmuxClient — implements acp::Client inside the LocalSet
// ---------------------------------------------------------------------------

struct AmuxClient {
    event_tx: mpsc::Sender<amux::AcpEvent>,
    /// Pending permission requests: request_id -> oneshot sender
    pending_permissions: Rc<RefCell<HashMap<String, oneshot::Sender<bool>>>>,
    /// Gateway runtimes have no interactive client on the other end of MQTT
    /// to approve `requestPermission` callbacks the claude-agent-acp wrapper
    /// fires for every tool use. Without auto-allow here the oneshot never
    /// resolves and every tool — including the `send` MCP tool we mounted
    /// for the gateway specifically — gets denied. Detected at construction
    /// time from whether an MCP config path was attached (gateway-only).
    is_gateway: bool,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for AmuxClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        // Extract tool info from the tool_call update
        let tool_id = args.tool_call.tool_call_id.to_string();
        let tool_name = args.tool_call.fields.title.clone().unwrap_or_default();
        let description = args
            .tool_call
            .fields
            .kind
            .map(|k| format!("{:?}", k))
            .unwrap_or_default();

        // Gateway runtimes have no human/MQTT subscriber to approve, so we
        // auto-allow here. Picks the first AllowAlways/AllowOnce option the
        // wrapper offered; falls back to a synthetic "allow" optionId.
        if self.is_gateway {
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

        // Generate a request_id for MQTT routing
        let request_id = uuid::Uuid::new_v4().to_string();

        // Send the permission request event to MQTT
        let _ = self
            .event_tx
            .send(amux::AcpEvent {
                event: Some(amux::acp_event::Event::PermissionRequest(
                    amux::AcpPermissionRequest {
                        request_id: request_id.clone(),
                        tool_name: tool_name.clone(),
                        description,
                        params: Default::default(),
                    },
                )),
                model: String::new(),
            })
            .await;

        // Create oneshot channel and wait for the response
        let (tx, rx) = oneshot::channel();
        self.pending_permissions
            .borrow_mut()
            .insert(request_id.clone(), tx);

        // Wait for the permission response from the main thread
        let granted = rx.await.unwrap_or(false);

        if granted {
            // Find the first "allow" option (AllowOnce or AllowAlways), or fall back to the first option
            let option_id = args
                .options
                .iter()
                .find(|o| {
                    matches!(
                        o.kind,
                        acp::PermissionOptionKind::AllowOnce
                            | acp::PermissionOptionKind::AllowAlways
                    )
                })
                .or_else(|| args.options.first())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("allow"));

            Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    option_id,
                )),
            ))
        } else {
            // Find the first "reject" option, or fall back to last option
            let option_id = args
                .options
                .iter()
                .find(|o| {
                    matches!(
                        o.kind,
                        acp::PermissionOptionKind::RejectOnce
                            | acp::PermissionOptionKind::RejectAlways
                    )
                })
                .or_else(|| args.options.last())
                .map(|o| o.option_id.clone())
                .unwrap_or_else(|| acp::PermissionOptionId::new("deny"));

            Ok(acp::RequestPermissionResponse::new(
                acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome::new(
                    option_id,
                )),
            ))
        }
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
        let events = translate_session_update(args.update);
        for event in events {
            let _ = self.event_tx.send(event).await;
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
            let tool_name =
                if tc.title.is_empty() || tc.title == "undefined" || tc.title.starts_with('"') {
                    kind_to_name(&tc.kind)
                } else {
                    tc.title.clone()
                };
            let description = tool_call_description(tc.raw_input.as_ref(), Some(&tc.content));
            let params = tool_call_params(tc.raw_input.as_ref());
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
                let clean_title = tcu
                    .fields
                    .title
                    .as_ref()
                    .map(|title| title.trim_matches('"').to_string())
                    .filter(|title| !title.is_empty() && title != "undefined")
                    .unwrap_or_default();
                let description = tool_call_description(
                    tcu.fields.raw_input.as_ref(),
                    tcu.fields.content.as_deref(),
                );
                let params = tool_call_params(tcu.fields.raw_input.as_ref());
                if !description.is_empty() || !clean_title.is_empty() {
                    vec![amux::AcpEvent {
                        event: Some(amux::acp_event::Event::ToolUse(amux::AcpToolUse {
                            tool_id,
                            tool_name: clean_title,
                            description,
                            params,
                            tool_kind: tcu
                                .fields
                                .kind
                                .as_ref()
                                .map(kind_to_snake)
                                .unwrap_or_default(),
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

fn kind_to_name(kind: &acp::ToolKind) -> String {
    match kind {
        acp::ToolKind::Search => "Search".into(),
        acp::ToolKind::Read => "Read".into(),
        acp::ToolKind::Edit => "Edit".into(),
        acp::ToolKind::Fetch => "WebSearch".into(),
        acp::ToolKind::Execute => "Bash".into(),
        acp::ToolKind::Delete => "Delete".into(),
        acp::ToolKind::Move => "Move".into(),
        acp::ToolKind::Think => "Think".into(),
        _ => format!("{:?}", kind),
    }
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

// ---------------------------------------------------------------------------
// Public API: spawn an ACP agent in its own thread with LocalSet
// ---------------------------------------------------------------------------

/// Spawn an ACP-speaking agent (claude-code, opencode, codex, …).
///
/// Returns a command sender that the main runtime uses to send prompts,
/// permission responses, and cancellation signals.
///
/// Events from the agent flow through `event_tx`.
///
/// `startup_tx` is fulfilled once the child process has spawned, ACP has
/// initialized, and a session has been created/resumed. Startup failures are
/// sent through it so callers do not publish a successful RuntimeStart for a
/// process that never became usable.
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
    // When `Some`, the ACP session is initialised on this model id instead of
    // the agent's reported default. Used by the gateway adapter to honour
    // per-session `set_model` overrides on first spawn. Pass a full model
    // id ("claude-sonnet-4-6"), not a short name — callers translate short
    // names via `model_id_for_short_name`.
    initial_model_override: Option<String>,
    // When `Some`, the path is forwarded as `--mcp-config <path>` to the
    // underlying claude-code child. Gateway sessions use this to mount
    // amuxd's own `mcp-server` subcommand so the agent can call the
    // `send` tool. Bare/native runtimes pass `None`.
    mcp_config_path: Option<PathBuf>,
) -> crate::error::Result<mpsc::Sender<AcpCommand>> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<AcpCommand>(64);
    let startup_reporter: StartupReporter = Arc::new(Mutex::new(Some(startup_tx)));

    // Clone event_tx so we can push an AcpError after run_acp_session
    // fails — without this, the ACP thread would log the failure and
    // silently exit, leaving iOS staring at a runtime that never replies.
    let error_tx = event_tx.clone();
    let startup_error_reporter = startup_reporter.clone();

    // Spawn a dedicated thread with its own single-threaded tokio runtime + LocalSet
    // because ACP futures are !Send.
    std::thread::Builder::new()
        .name(format!("acp-agent"))
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("failed to build tokio runtime for ACP agent");

            let local_set = tokio::task::LocalSet::new();
            rt.block_on(local_set.run_until(async move {
                if let Err(e) = run_acp_session(
                    binary,
                    args,
                    worktree,
                    initial_prompt,
                    agent_type,
                    event_tx,
                    cmd_rx,
                    resume_acp_session_id,
                    startup_reporter,
                    initial_model_override,
                    mcp_config_path,
                )
                .await
                {
                    let summary = format!("{}", e);
                    let details = format!("{:#}", e);
                    error!(error = %details, "ACP agent session failed");
                    report_startup(&startup_error_reporter, Err(details.clone()));
                    // Best-effort fanout to iOS. The receiver may already
                    // be gone (RuntimeManager teardown raced ahead) — in
                    // that case the send is a no-op and the log line
                    // above is the only record.
                    emit_acp_error(&error_tx, summary, details).await;
                }
            }));
        })
        .map_err(|e| {
            crate::error::AmuxError::Agent(format!("failed to spawn ACP thread: {}", e))
        })?;

    Ok(cmd_tx)
}

/// The main ACP session loop running inside a LocalSet.
#[allow(clippy::too_many_arguments)]
async fn run_acp_session(
    binary: String,
    args: Vec<String>,
    worktree: String,
    initial_prompt: String,
    agent_type: amux::AgentType,
    event_tx: mpsc::Sender<amux::AcpEvent>,
    mut cmd_rx: mpsc::Receiver<AcpCommand>,
    resume_acp_session_id: Option<String>,
    startup_reporter: StartupReporter,
    initial_model_override: Option<String>,
    mcp_config_path: Option<PathBuf>,
) -> anyhow::Result<()> {
    // Spawn the ACP agent process
    // Use claude-agent-acp wrapper (Node.js) which speaks ACP JSON-RPC over stdio
    // Falls back to npx if the binary is a Claude CLI path/name. The user's
    // daemon.toml may store an absolute path like ~/.local/bin/claude.
    let mut cmd = if should_use_claude_agent_acp_wrapper(&binary) {
        let mut c = tokio::process::Command::new("npx");
        c.arg("--yes").arg("@zed-industries/claude-agent-acp");
        c
    } else if (agent_type == amux::AgentType::Opencode || agent_type == amux::AgentType::Codex)
        && args.is_empty()
    {
        // Both opencode and codex CLIs expose ACP via an `acp` subcommand.
        // Operators can override this default by supplying `default_flags`
        // in daemon.toml's [agents.opencode] / [agents.codex] section.
        let mut c = tokio::process::Command::new(&binary);
        c.arg("acp");
        c
    } else {
        let mut c = tokio::process::Command::new(&binary);
        c.args(&args);
        c
    };
    // Forward per-session MCP config to the underlying claude-code so the
    // agent can call amuxd's `send` tool. The wrapper passes unknown args
    // through to claude.
    if let Some(ref cfg_path) = mcp_config_path {
        cmd.arg("--mcp-config").arg(cfg_path);
        info!(mcp_config = %cfg_path.display(), "claude-code launched with --mcp-config");
    }
    let mut child = cmd
        .current_dir(&worktree)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| anyhow::anyhow!("spawn ACP agent: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;

    // Drain stderr line-by-line so the pipe buffer can't fill up and
    // wedge the subprocess. Each line is logged at warn — claude-agent-acp
    // writes its JSON-RPC error envelopes here when something goes wrong,
    // and previously they were invisible (we piped stderr but never read
    // it), making "Internal error" failures impossible to diagnose
    // without manual reproduction outside the daemon.
    if let Some(stderr) = child.stderr.take() {
        tokio::task::spawn_local(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                warn!(target: "acp_stderr", "{}", line);
            }
        });
    }

    info!(binary = %binary, worktree = %worktree, "ACP agent process spawned");

    let pending_permissions: Rc<RefCell<HashMap<String, oneshot::Sender<bool>>>> =
        Rc::new(RefCell::new(HashMap::new()));

    let client = AmuxClient {
        event_tx: event_tx.clone(),
        pending_permissions: pending_permissions.clone(),
        is_gateway: mcp_config_path.is_some(),
    };

    // Create the ACP connection
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

    // Initialize the connection
    conn.initialize(
        acp::InitializeRequest::new(acp::ProtocolVersion::V1)
            .client_info(acp::Implementation::new("amuxd", "0.1.0").title("AMUX Daemon")),
    )
    .await
    .map_err(|e| anyhow::anyhow!("ACP initialize failed: {}", e))?;

    info!("ACP connection initialized");

    // Create or resume session
    let worktree_path = std::path::PathBuf::from(&worktree);

    // claude-agent-acp 0.x silently drops the claude-code `--mcp-config` CLI
    // flag — it expects MCP servers to be declared on the ACP `session/new`
    // payload's `mcpServers` array instead. Parse the gateway MCP config
    // file we wrote earlier back into ACP-native `McpServerStdio` entries so
    // the `send` tool actually lands in the spawned agent's tool list.
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

    // Capture both the session id AND the optional `SessionModelState` the
    // agent advertises in its session response. opencode and codex populate
    // this via the `unstable_session_model` capability; claude-agent-acp
    // currently does not, so it stays None and the hardcoded fallback table
    // takes over below.
    let (session_id, acp_model_state): (acp::SessionId, Option<acp::SessionModelState>) =
        if let Some(ref resume_id) = resume_acp_session_id {
            let resume_req = acp::ResumeSessionRequest::new(
                acp::SessionId::new(resume_id.clone()),
                worktree_path.clone(),
            );
            match conn.resume_session(resume_req).await {
                Ok(resp) => {
                    let sid = acp::SessionId::new(resume_id.clone());
                    info!(session_id = %sid, "ACP session resumed");
                    (sid, resp.models)
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
                    info!(session_id = %sid, "ACP session created (fallback)");
                    (sid, resp.models)
                }
            }
        } else {
            let resp = conn
                .new_session(build_new_req(worktree_path))
                .await
                .map_err(|e| anyhow::anyhow!("ACP new_session failed: {}", e))?;
            let sid = resp.session_id.clone();
            info!(session_id = %sid, "ACP session created");
            (sid, resp.models)
        };

    // Translate the agent-reported model list to amux's wire type, or fall
    // back to the hardcoded table for agents (claude-agent-acp today) that
    // don't implement `unstable_session_model`.
    let acp_current_model_id: Option<String> = acp_model_state
        .as_ref()
        .map(|s| s.current_model_id.0.to_string());
    let available_models: Vec<amux::ModelInfo> = match acp_model_state.as_ref() {
        Some(state) => crate::runtime::models::acp_models_to_proto(state),
        None => crate::runtime::models::available_models_for(agent_type),
    };
    info!(
        agent_type = ?agent_type,
        source = if acp_model_state.is_some() { "acp" } else { "fallback" },
        count = available_models.len(),
        "available models resolved",
    );
    // Apply the initial model before any prompt runs. Precedence:
    //   1. `initial_model_override` (gateway `set_model` chose this on spawn)
    //   2. agent-reported `current_model_id` (no set_model needed; the
    //      session is already on it)
    //   3. first entry from the fallback table (claude legacy path)
    // We only issue `session/set_model` when the chosen id differs from
    // the agent's current — otherwise we'd round-trip a no-op call.
    let initial_model: Option<String> = {
        let chosen = initial_model_override
            .clone()
            .or_else(|| acp_current_model_id.clone())
            .or_else(|| available_models.first().map(|m| m.id.clone()));
        match chosen {
            Some(model_id) if acp_current_model_id.as_ref() == Some(&model_id) => {
                info!(model_id = %model_id, "ACP session already on selected model");
                Some(model_id)
            }
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
                        // Fall back to whatever the agent already runs on,
                        // so the daemon still reports a current_model when
                        // the agent self-reported one.
                        acp_current_model_id.clone()
                    }
                }
            }
            None => None,
        }
    };
    report_startup(
        &startup_reporter,
        Ok(AcpStartupMetadata {
            available_models: available_models.clone(),
            initial_model: initial_model.clone(),
            acp_session_id: session_id.to_string(),
        }),
    );

    // Use Rc to share conn across spawn_local tasks
    let conn = Rc::new(conn);
    let (prompt_tx, mut prompt_rx) = mpsc::channel::<(String, Vec<String>)>(64);
    {
        let conn = conn.clone();
        let session_id = session_id.clone();
        let event_tx = event_tx.clone();
        tokio::task::spawn_local(async move {
            while let Some((text, attachment_urls)) = prompt_rx.recv().await {
                let _ = event_tx
                    .send(amux::AcpEvent {
                        event: Some(amux::acp_event::Event::StatusChange(
                            amux::AcpStatusChange {
                                old_status: amux::AgentStatus::Idle as i32,
                                new_status: amux::AgentStatus::Active as i32,
                            },
                        )),
                        model: String::new(),
                    })
                    .await;

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

                match result {
                    Ok(_) => {
                        let _ = event_tx
                            .send(amux::AcpEvent {
                                event: Some(amux::acp_event::Event::StatusChange(
                                    amux::AcpStatusChange {
                                        old_status: amux::AgentStatus::Active as i32,
                                        new_status: amux::AgentStatus::Idle as i32,
                                    },
                                )),
                                model: String::new(),
                            })
                            .await;
                    }
                    Err(e) => {
                        let details = format!("ACP prompt failed: {e}");
                        error!("{}", details);
                        emit_acp_error(&event_tx, "ACP prompt failed", details).await;
                    }
                }
            }
        });
    }

    // Send the initial prompt (skipped when empty — iOS new-session flow
    // now passes empty initial_prompt and delivers the user's first
    // message via session/live instead, so the runtime sees only one
    // copy of the prompt instead of two).
    if !initial_prompt.is_empty() {
        let _ = prompt_tx.send((initial_prompt, Vec::new())).await;
    }

    // Command loop: receive commands from the main runtime
    {
        let child_wait = child.wait();
        tokio::pin!(child_wait);
        loop {
            tokio::select! {
                maybe_cmd = cmd_rx.recv() => {
                    let Some(cmd) = maybe_cmd else {
                        break;
                    };
                    match cmd {
                        AcpCommand::Prompt { text, attachment_urls } => {
                            if prompt_tx.send((text, attachment_urls)).await.is_err() {
                                emit_acp_error(
                                    &event_tx,
                                    "ACP prompt failed",
                                    "ACP prompt worker stopped",
                                ).await;
                            }
                        }
                        AcpCommand::Cancel => {
                            if let Err(e) = conn
                                .cancel(acp::CancelNotification::new(session_id.clone()))
                                .await
                            {
                                warn!("ACP cancel failed: {}", e);
                            }
                        }
                        AcpCommand::ResolvePermission { request_id, granted } => {
                            if let Some(tx) = pending_permissions.borrow_mut().remove(&request_id) {
                                let _ = tx.send(granted);
                            } else {
                                warn!(request_id, "no pending permission request found");
                            }
                        }
                        AcpCommand::SetModel { model_id } => {
                            let req = acp::SetSessionModelRequest::new(
                                session_id.clone(),
                                acp::ModelId::new(model_id.clone()),
                            );
                            if let Err(e) = conn.set_session_model(req).await {
                                warn!(error = %e, model_id = %model_id, "set_session_model failed");
                            } else {
                                info!(model_id = %model_id, "set_session_model applied");
                            }
                        }
                        AcpCommand::Shutdown => {
                            info!("ACP agent shutting down");
                            break;
                        }
                    }
                }
                Some(message) = fatal_rx.recv() => {
                    return Err(anyhow::anyhow!(message));
                }
                status = &mut child_wait => {
                    let message = match status {
                        Ok(status) => format!("ACP agent process exited: {status}"),
                        Err(e) => format!("ACP agent process wait failed: {e}"),
                    };
                    return Err(anyhow::anyhow!(message));
                }
            }
        }
    }

    // Clean up: drop the child process (kill_on_drop will handle it)
    drop(child);
    info!("ACP agent thread exiting");
    Ok(())
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
    fn translates_tool_call_update_raw_input_to_tool_use_update() {
        let update = acp::ToolCallUpdate::new(
            "tool-1",
            acp::ToolCallUpdateFields::new()
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
