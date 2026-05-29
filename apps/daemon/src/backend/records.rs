/// Returned by `claim_team_invite` — both member and agent branches.
/// `refresh_token` is `None` for member claims.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct ClaimResult {
    pub actor_id: String,
    pub team_id: String,
    pub actor_type: String,
    pub display_name: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct AgentRuntimeUpsert<'a> {
    pub team_id: &'a str,
    pub agent_id: &'a str,
    pub session_id: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub backend_type: &'a str,
    pub backend_session_id: Option<&'a str>,
    /// Daemon-side 8-char runtime id, the topic segment in
    /// `runtime/{runtime_id}/state`. iOS uses it to bridge a backend
    /// `agent_runtimes` row to the live MQTT-published `Runtime`. Distinct
    /// from `backend_session_id` (the 36-char ACP session id used by the
    /// daemon to resume a Claude Code session).
    pub runtime_id: Option<&'a str>,
    pub status: &'a str,
    pub current_model: Option<&'a str>,
    pub last_seen_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, serde::Serialize)]
pub struct WorkspaceUpsert<'a> {
    pub team_id: &'a str,
    pub agent_id: &'a str,
    pub name: &'a str,
    pub path: Option<&'a str>,
    pub archived: bool,
}

/// Subset of `agent_runtimes` columns read by runtime restore/catch-up flows.
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(dead_code)]
pub struct AgentRuntimeRow {
    pub id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub backend_type: String,
    #[serde(default)]
    pub backend_session_id: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub last_processed_message_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct WorkspaceRow {
    pub id: String,
}

/// A single `messages` table row returned from the backend.
#[derive(Debug, Clone)]
pub struct StoredMessage {
    pub id: String,
    pub session_id: String,
    pub sender_actor_id: String,
    #[allow(dead_code)]
    pub kind: String,
    pub content: String,
    /// Raw JSON string of the `metadata` column.
    pub metadata_json: String,
    /// Unix epoch seconds derived from the `created_at` timestamp.
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendSessionRow {
    pub id: String,
    pub team_id: String,
    #[serde(default)]
    pub created_by_actor_id: Option<String>,
    #[serde(default)]
    pub primary_agent_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub mode: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub idea_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BackendParticipantRow {
    #[allow(dead_code)]
    pub session_id: String,
    pub actor_id: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub role: Option<String>,
    pub joined_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct BackendSessionAndParticipants {
    pub session: BackendSessionRow,
    pub participants: Vec<BackendParticipantRow>,
}
