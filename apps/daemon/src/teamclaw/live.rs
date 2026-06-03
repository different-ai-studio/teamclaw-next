use chrono::Utc;
use prost::Message;
use std::sync::Arc;
use teamclaw_transport::{DeliveryGuarantee, MessagePublisher};
use tracing::{debug, warn};
use uuid::Uuid;

use crate::mqtt::Topics;
use crate::proto::amux::Envelope as AmuxEnvelope;
use crate::proto::teamclaw::{IdeaEvent, LiveEventEnvelope, Participant, SessionMessageEnvelope};

const RUMQTTC_DEFAULT_PACKET_LIMIT_BYTES: usize = 10 * 1024;
const LIVE_EVENT_WARN_BYTES: usize = 512 * 1024;

pub struct LivePublisher {
    client: Arc<dyn MessagePublisher>,
    topics: Topics,
}

impl LivePublisher {
    pub fn new(client: Arc<dyn MessagePublisher>, team_id: String, actor_id: String) -> Self {
        Self {
            client,
            topics: Topics::new(&team_id, &actor_id),
        }
    }

    pub async fn publish_message(
        &self,
        session_id: &str,
        actor_id: &str,
        envelope: &SessionMessageEnvelope,
    ) -> crate::error::Result<()> {
        self.publish(
            "message.created",
            session_id,
            actor_id,
            envelope.encode_to_vec(),
        )
        .await
    }

    pub async fn publish_idea_event(
        &self,
        event_type: &str,
        session_id: &str,
        actor_id: &str,
        event: &IdeaEvent,
    ) -> crate::error::Result<()> {
        self.publish(event_type, session_id, actor_id, event.encode_to_vec())
            .await
    }

    /// Publishes an ACP `Envelope` (output deltas, thinking, tool_use, etc.)
    /// to the session/{id}/live channel. Wraps the envelope bytes inside a
    /// `LiveEventEnvelope` with `event_type = "acp.event"`. iOS subscribes by
    /// session_id (which it owns), so this replaces the legacy per-runtime
    /// `runtime/{id}/events` topic that required iOS to know the daemon's
    /// actor_id and the daemon-generated runtime_id.
    pub async fn publish_acp_event(
        &self,
        session_id: &str,
        actor_id: &str,
        envelope: &AmuxEnvelope,
    ) -> crate::error::Result<()> {
        self.publish("acp.event", session_id, actor_id, envelope.encode_to_vec())
            .await
    }

    pub async fn publish_presence_event(
        &self,
        event_type: &str,
        session_id: &str,
        participant: &Participant,
    ) -> crate::error::Result<()> {
        self.publish(
            event_type,
            session_id,
            &participant.actor_id,
            participant.encode_to_vec(),
        )
        .await
    }

    async fn publish(
        &self,
        event_type: &str,
        session_id: &str,
        actor_id: &str,
        body: Vec<u8>,
    ) -> crate::error::Result<()> {
        let body_len = body.len();
        let payload = LiveEventEnvelope {
            event_id: Uuid::new_v4().to_string(),
            event_type: event_type.to_string(),
            session_id: session_id.to_string(),
            actor_id: actor_id.to_string(),
            sent_at: Utc::now().timestamp(),
            body,
        }
        .encode_to_vec();
        let topic = self.topics.session_live(session_id);
        let payload_len = payload.len();

        if payload_len > LIVE_EVENT_WARN_BYTES {
            warn!(
                event_type,
                session_id,
                actor_id,
                topic,
                payload_len,
                body_len,
                "large MQTT session/live publish"
            );
        } else if payload_len > RUMQTTC_DEFAULT_PACKET_LIMIT_BYTES {
            debug!(
                event_type,
                session_id,
                actor_id,
                topic,
                payload_len,
                body_len,
                "MQTT session/live publish exceeds rumqttc default packet cap"
            );
        }

        self.client
            .publish(&topic, payload, false, DeliveryGuarantee::AtLeastOnce)
            .await?;
        Ok(())
    }
}
