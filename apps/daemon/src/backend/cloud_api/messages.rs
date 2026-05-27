use super::super::{BackendResult, StoredMessage};
use super::client::empty_to_none;
use super::CloudApiBackend;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct CloudPage<T> {
    pub(super) items: Vec<T>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CloudMessage {
    pub(super) id: String,
    #[serde(rename = "sessionId")]
    pub(super) session_id: String,
    #[serde(rename = "senderActorId")]
    pub(super) sender_actor_id: Option<String>,
    pub(super) kind: String,
    pub(super) content: String,
    pub(super) metadata: Option<Value>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: DateTime<Utc>,
}

impl CloudMessage {
    pub(super) fn into_stored_message(self) -> BackendResult<StoredMessage> {
        Ok(StoredMessage {
            id: self.id,
            session_id: self.session_id,
            sender_actor_id: self.sender_actor_id.unwrap_or_default(),
            kind: self.kind,
            content: self.content,
            metadata_json: serde_json::to_string(&self.metadata.unwrap_or(Value::Null))?,
            created_at: self.created_at.timestamp(),
        })
    }
}

#[derive(Serialize)]
pub(super) struct InsertMessageRequest<'a> {
    pub(super) id: &'a str,
    #[serde(rename = "teamId")]
    pub(super) team_id: &'a str,
    #[serde(rename = "senderActorId")]
    pub(super) sender_actor_id: &'a str,
    pub(super) content: &'a str,
    pub(super) kind: &'a str,
    pub(super) metadata: Option<Value>,
    #[serde(rename = "turnId")]
    pub(super) turn_id: Option<&'a str>,
    #[serde(rename = "replyToMessageId")]
    pub(super) reply_to_message_id: Option<&'a str>,
    pub(super) model: Option<&'a str>,
    #[serde(rename = "createdAt")]
    pub(super) created_at: Option<&'a str>,
}

impl CloudApiBackend {
    pub(super) async fn messages_after_cursor_impl(
        &self,
        session_id: &str,
        after_id: Option<&str>,
    ) -> BackendResult<Vec<StoredMessage>> {
        let page: CloudPage<CloudMessage> = self
            .get(&format!("/v1/sessions/{session_id}/messages"))
            .await?;
        let mut seen_cursor = after_id.is_none();
        let mut out = Vec::new();
        for row in page.items {
            if !seen_cursor {
                seen_cursor = Some(row.id.as_str()) == after_id;
                continue;
            }
            out.push(row.into_stored_message()?);
        }
        Ok(out)
    }

    pub(super) async fn insert_gateway_message_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
    ) -> BackendResult<String> {
        let id = external_message_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "text",
                    metadata: None,
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    pub(super) async fn insert_gateway_message_with_attachments_impl(
        &self,
        session_id: &str,
        sender_actor_id: &str,
        content: &str,
        external_message_id: Option<&str>,
        attachments: Value,
    ) -> BackendResult<String> {
        let id = external_message_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let metadata = serde_json::json!({ "attachments": attachments });
        let message: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id: &id,
                    team_id: &self.cfg.team_id,
                    sender_actor_id,
                    content,
                    kind: "text",
                    metadata: Some(metadata),
                    turn_id: None,
                    reply_to_message_id: None,
                    model: None,
                    created_at: None,
                },
                Some(&id),
            )
            .await?;
        Ok(message.id)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn insert_message_impl(
        &self,
        id: &str,
        team_id: &str,
        session_id: &str,
        sender_actor_id: &str,
        kind: &str,
        content: &str,
        metadata_json: &str,
        model: &str,
        turn_id: &str,
        sequence: u64,
    ) -> BackendResult<()> {
        let metadata = serde_json::from_str(metadata_json).unwrap_or(Value::Null);
        let metadata = match metadata {
            Value::Object(mut object) => {
                object.insert("sequence".to_string(), Value::from(sequence));
                Some(Value::Object(object))
            }
            Value::Null => Some(serde_json::json!({ "sequence": sequence })),
            other => Some(serde_json::json!({ "value": other, "sequence": sequence })),
        };
        let _: CloudMessage = self
            .post(
                &format!("/v1/sessions/{session_id}/messages"),
                &InsertMessageRequest {
                    id,
                    team_id,
                    sender_actor_id,
                    content,
                    kind,
                    metadata,
                    turn_id: empty_to_none(turn_id),
                    reply_to_message_id: None,
                    model: empty_to_none(model),
                    created_at: None,
                },
                Some(id),
            )
            .await?;
        Ok(())
    }
}
