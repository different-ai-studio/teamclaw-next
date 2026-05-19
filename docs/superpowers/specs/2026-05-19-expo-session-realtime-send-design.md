# Expo Session Realtime Send Design

Date: 2026-05-19
Status: Drafted and reviewed inline

## Goal

Extend `apps/expo` from a read-only session detail experience into a minimal
interactive chat detail that can:

- send a text message from the current member actor
- persist that message to Supabase
- publish a matching `message.created` live event over MQTT
- subscribe to the current session live topic
- render subsequent agent replies that arrive over MQTT

This phase keeps scope intentionally narrow. It does not attempt to port the
full desktop runtime, global realtime session syncing, or complex message type
rendering.

## Non-Goals

This phase does not include:

- a global MQTT connection pool for every session
- session list realtime updates
- typing indicators, thinking blocks, permission requests, or tool-call cards
- offline retry queues
- attachment sending, mentions, slash commands, or multi-part message payloads
- complex background reconnect behavior beyond basic lifecycle-safe cleanup

## Product Scope

The affected route remains:

- `apps/expo/app/(app)/sessions/[sessionId].tsx`

The screen will evolve from:

- session metadata
- read-only timeline
- disabled composer shell

to:

- session metadata
- live-updating timeline for the active session
- real text composer with send action
- inline send and connection feedback

The route remains team-scoped and session-scoped. Only the currently open
session subscribes to MQTT.

## Architecture

### 1. Expo MQTT Adapter

Add a small mobile-safe MQTT adapter under:

- `apps/expo/src/lib/mqtt/expo-mqtt.ts`

This module owns:

- connect
- disconnect
- publish
- subscribe
- message listener registration

Upper layers must not depend directly on the third-party MQTT library. The
adapter surface should stay narrow so we can swap the implementation later
without rewriting feature code.

### 2. Live Event Decoder

Add:

- `apps/expo/src/lib/teamclaw/live-events.ts`

This mirrors the desktop semantic boundary for:

- decoding `LiveEventEnvelope`
- extracting `SessionMessageEnvelope` for `message.created`
- deriving session id from topic

The Expo layer should follow the same protobuf event contract already used on
desktop so sent and received messages stay semantically aligned.

### 3. Session Detail Controller

Add:

- `apps/expo/src/features/sessions/session-detail-controller.ts`

This controller becomes the single owner of:

- initial session + message bootstrap
- current session MQTT subscription lifecycle
- composer text
- send state
- connection state
- optimistic local append
- message merge and de-duplication

The route should provide:

- `teamId`
- `sessionId`
- `currentMemberActorId`
- `current user id` if needed for sender resolution fallback

The screen should remain presentational and receive already-shaped state plus
actions from the controller.

## Data Flow

### Initial Load

When the session detail route mounts for a ready onboarding state:

1. Load session metadata from `getSession(teamId, sessionId)`
2. Load persisted messages from `listMessages(teamId, sessionId)`
3. Build initial detail state
4. Connect and subscribe to:
   - `amux/{teamId}/session/{sessionId}/live`
5. Start listening for `message.created`

If metadata is missing:

- render `not-found`

If metadata loads but messages fail:

- render session metadata
- render error state for the timeline
- keep the composer available only if the controller has a valid session context

### Send Flow

Sending a text message follows this exact order:

1. Validate trimmed composer text is non-empty
2. Resolve sender actor id
3. Generate `messageId`
4. Create protobuf `Message`
5. Wrap in `SessionMessageEnvelope`
6. Wrap in `LiveEventEnvelope` with `eventType = "message.created"`
7. Insert the message row into Supabase `messages`
8. Publish the live event to the session topic
9. Optimistically merge the message into the local timeline
10. Clear composer text on success

This order intentionally preserves Supabase as the source of persisted truth
while still using MQTT as the realtime transport.

### Receive Flow

While subscribed to the current session topic:

1. Receive MQTT payload for the session live topic
2. Decode the live event
3. Ignore payloads that are not `message.created`
4. Ignore payloads that fail protobuf decode
5. Ignore messages whose `messageId` already exists locally
6. Merge new messages into the timeline in ascending created-time order

This is enough to show subsequent agent replies after a user send without
bringing in the desktop daemon runtime.

## State Model

The session detail controller should expose a state shaped like:

- `status: "loading" | "not-found" | "empty" | "ready" | "error"`
- `session`
- `messages`
- `errorMessage`
- `connectionState: "connecting" | "connected" | "disconnected"`
- `composerText`
- `isSending`
- `sendErrorMessage`

Rules:

- `status` describes the route/detail load state
- `connectionState` describes MQTT subscription state
- `sendErrorMessage` is specific to the composer
- send should be disabled when `isSending` is true
- send should also be disabled for empty trimmed input

## De-Duplication and Merge Rules

`messageId` is the only de-duplication key in this phase.

Rules:

- optimistic append inserts a local row only if `messageId` is not already present
- incoming MQTT `message.created` ignores rows with an existing `messageId`
- initial Supabase load and later MQTT events do not create a second copy of the
  same message

No fuzzy content-based or timestamp-only de-duplication is allowed.

## Sender Resolution

Prefer the already bootstrapped current member actor id from onboarding state.

If it is unavailable but the app still has enough auth context to send, the
controller may fall back to a small API helper that resolves the member actor id
for the current user and team via Supabase.

The controller must fail clearly if no sender actor can be resolved for the
current team.

## UI Changes

### Composer

Upgrade the current disabled composer shell into a real text composer that keeps
the same visual language:

- paper card container
- subtle divider between editor and footer
- `TeamClaw AI` pill remains in the footer
- icon affordances stay as non-functional placeholders for now
- coral send button becomes active when text is present

Composer behavior:

- multiline text input
- send button disabled for blank trimmed input
- send button shows loading/disabled while sending
- send failure keeps the existing text intact
- send error appears below the composer in calm but clear copy

### Timeline

Keep the current simplified message row rendering:

- own messages right aligned
- agent/other messages left aligned
- non-displayable kinds continue to fall back to honest placeholder text

No special rendering is added for:

- thinking
- permission requests
- tool calls
- structured results

## Error Handling

### Load Errors

- no session found: show `not-found`
- session load failure: route-level error
- message load failure with known session: show metadata plus timeline error

### Send Errors

- Supabase insert failure: no optimistic message, keep input text, show send error
- MQTT publish failure after successful insert: show a specific send error
  explaining that persistence succeeded but realtime distribution may be delayed;
  do not duplicate the message

### Connection Errors

- MQTT connection or subscribe failure should move `connectionState` to
  `disconnected`
- the timeline should remain usable with already-loaded persisted messages
- the composer may remain available if send prerequisites are otherwise valid

## Dependency Boundary

This phase may add one Expo-compatible MQTT client dependency in
`apps/expo/package.json`.

That dependency must stay encapsulated inside `src/lib/mqtt/expo-mqtt.ts`.
Feature-layer code should not reference library-specific APIs directly.

## Testing

Add or extend tests for:

### Session Detail Controller

- initial load to `empty`
- initial load to `ready`
- optimistic append on successful send
- duplicate `message.created` ignored by `messageId`
- subsequent agent reply inserted into the timeline
- send failure preserves `composerText`
- session-switch stale events do not mutate the next session state

### Live Event Decode

- valid `message.created` payload decodes correctly
- unrelated event types are ignored safely
- malformed payloads fail safely

### Send Persistence Mapping

- Supabase insert uses expected `messages` fields for sent text messages

### Full Expo Verification

- `pnpm expo:test`
- `pnpm --filter @teamclaw/expo exec tsc --noEmit`

## Implementation Order

1. Add spec-backed tests for controller and live-event boundaries
2. Add Expo MQTT adapter and live-event decoder
3. Add session detail controller with load/send/subscribe lifecycle
4. Upgrade the composer UI from read-only shell to interactive text composer
5. Wire the route to the controller
6. Run Expo test and typecheck verification

## Risks

### MQTT Client Behavior on Mobile

The largest unknown is the Expo-compatible MQTT library behavior on the target
mobile runtime. To contain this risk, the adapter is isolated and the rest of
the feature only depends on a small interface.

### Duplicate Messages

This risk is handled by strict `messageId`-based de-duplication across:

- initial persisted load
- optimistic append
- incoming MQTT events

### Partial Success on Send

Supabase insert may succeed while publish fails. This phase treats that as a
user-visible partial failure with preserved local clarity rather than silently
pretending success.
