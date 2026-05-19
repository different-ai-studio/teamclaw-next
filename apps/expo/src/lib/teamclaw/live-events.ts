import { fromBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
  type LiveEventEnvelope,
  type SessionMessageEnvelope,
  type Message,
} from "@teamclaw/app/proto/teamclaw_pb";

export interface DecodedLiveEvent {
  envelope: LiveEventEnvelope;
  sessionMessage?: SessionMessageEnvelope;
  message?: Message;
}

export function decodeLiveEvent(bytes: Uint8Array): DecodedLiveEvent | null {
  let envelope: LiveEventEnvelope;

  try {
    envelope = fromBinary(LiveEventEnvelopeSchema, bytes);
  } catch {
    return null;
  }

  const decoded: DecodedLiveEvent = { envelope };

  if (envelope.eventType === "message.created") {
    if (!envelope.body) {
      return null;
    }
    try {
      const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, envelope.body);
      if (!sessionMessage.message) {
        return null;
      }
      decoded.sessionMessage = sessionMessage;
      decoded.message = sessionMessage.message;
    } catch {
      return null;
    }
  }

  return decoded;
}

export function sessionIdFromTopic(topic: string): string | null {
  const match = topic.match(/^amux\/[^/]+\/session\/([^/]+)\/live$/);
  return match ? match[1] : null;
}
