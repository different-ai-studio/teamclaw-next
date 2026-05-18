# Expo Session Messages Design

Date: 2026-05-18
Status: Approved for planning
Scope: Extend the Expo session detail route from a metadata shell into a real read-only message view backed by the live `messages` table.

## Goal

Upgrade the current Expo session detail route so an authenticated user can open a session and read its existing message history without needing desktop-only runtime features.

This phase should let a user:

- open `/(app)/sessions/[sessionId]` from the real sessions list
- load the active session within the current team scope
- read the session's existing messages in chronological order
- distinguish `loading`, `not-found`, `error`, `empty`, and `ready` states
- keep the current honest metadata shell behavior while replacing the body with a true read-only timeline

This phase does not include sending, streaming, pagination, realtime updates, or tool-call-specific rendering.

## Why This Shape

The previous sessions phase established the authenticated sessions list and a safe team-scoped detail route. The next highest-value migration step is to turn that detail route into a real read-only session view instead of a placeholder shell.

Using a read-only message slice keeps the migration on the main product path while avoiding the complexity of composer state, optimistic updates, MQTT subscriptions, and streaming assistant responses. It also creates the correct foundation for later message sending work: once the route can load and render true history, the next phases can add composer and realtime behavior incrementally instead of redesigning the page again.

## Product Scope

### In Scope

- Keep the existing authenticated detail route at `/(app)/sessions/[sessionId]`
- Continue loading team-scoped session metadata
- Add a real backend read for the current session's messages
- Render a read-only message timeline using live Supabase data
- Preserve explicit `loading`, `not-found`, `error`, `empty`, and `ready` detail states
- Keep the current back-to-list behavior and team scoping guarantees

### Out of Scope

- Sending a message
- Composer UI
- Streaming assistant output
- Tool-call cards
- Thinking blocks
- Permission request UI
- Realtime updates
- Pagination or infinite scroll
- Offline caching
- Message reactions, editing, or retry flows

### Explicit Temporary UX Gaps

- The detail screen remains read-only
- Non-text message kinds may render as a compact placeholder row rather than a fully specialized card
- No attempt is made to imitate in-progress streaming or typing states

## Current Reference Points

This phase should build directly on the existing Expo sessions slice:

- `apps/expo/app/(app)/sessions/index.tsx`
- `apps/expo/app/(app)/sessions/[sessionId].tsx`
- `apps/expo/src/features/sessions/session-api.ts`
- `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx`

It should also respect the visual language in `AGENTS.md`, especially:

- Chinese-first labels and copy
- paper / background / panel token usage
- restrained coral usage
- clearer distinction between human messages and AI messages
- honest rendering of not-yet-migrated message subtypes

## Architecture

### Route Shape

No new routes are needed.

The existing route remains:

```text
apps/expo/app/(app)/sessions/[sessionId].tsx
```

Responsibilities stay split this way:

- route file owns onboarding guard, URL param handling, and high-level load orchestration
- API layer owns Supabase reads and record mapping
- screen owns visual states and read-only timeline layout

### Feature Placement

The sessions feature should grow by adding message-specific types and read helpers inside the existing Expo sessions module:

```text
apps/expo/src/features/sessions/
  session-types.ts
  session-api.ts
  screens/
    SessionDetailScreen.tsx
  components/
    SessionRow.tsx
    SessionMessageRow.tsx
```

If message-specific route state becomes large enough, a dedicated route-local loader or small detail controller is acceptable, but it should remain scoped to this detail experience rather than becoming a generic global store.

## Data Model

### Session Summary

The current `SessionSummary` model remains in place and continues to provide:

- `sessionId`
- `teamId`
- `title`
- `summary`
- `participantCount`
- `participantActorIds`
- `lastMessagePreview`
- `lastMessageAt`
- `createdAt`
- `createdBy`

### Message Shape

Add a compact read-only message model for this phase:

- `messageId`
- `sessionId`
- `teamId`
- `senderActorId`
- `kind`
- `content`
- `model`
- `createdAt`

This shape should be enough to render a stable historical timeline without prematurely importing desktop-specific runtime concepts.

### Message Semantics

The message timeline should be sorted by `createdAt` ascending so the detail view reads from oldest to newest.

For the first pass:

- standard text messages render their content directly
- empty or whitespace-only content falls back to a safe placeholder such as `内容为空`
- unsupported message kinds render an honest row such as `暂未在移动端展开此消息类型`

## Backend Integration

### API Surface

Extend the existing session API with one additional method:

- `listMessages(teamId: string, sessionId: string): Promise<SessionMessage[]>`

This method should:

- query the authenticated Supabase client
- scope by both `team_id` and `session_id`
- return messages sorted by `created_at` ascending
- map only the fields needed for this phase

The existing `getSession(teamId, sessionId)` method continues to own the session summary fetch.

### Data Sources

This phase needs two coordinated reads for the detail route:

- `getSession(teamId, sessionId)`
- `listMessages(teamId, sessionId)`

They can be requested in parallel, but the route must preserve these rules:

- if the session cannot be found in the active team, the route becomes `not-found`
- if the session exists but there are zero messages, the route becomes `empty`
- if a request fails, the route becomes `error`
- if both succeed and messages exist, the route becomes `ready`

## UI and Interaction Design

### Detail Screen Structure

The detail screen should keep a three-part structure:

1. **Header metadata block**
   Keep title, participant count, created time, updated time, and session id visible in a compact header zone.

2. **Read-only message timeline**
   Replace the old metadata-only body with the real message list.

3. **No composer**
   Leave bottom spacing only. Do not render a disabled or fake input.

### Message Row Treatment

The timeline should use a simplified message treatment aligned with the current visual language:

- human-authored messages: right-aligned light bubble
- AI or agent-authored messages: left-aligned note-style block
- timestamps: compact mono treatment
- no coral text content

Because the Expo app does not yet have the full actor-resolution layer, the first pass may infer row treatment from known sender identity available in the current team/session context. If the sender type cannot be determined confidently, the fallback should be a neutral left-aligned paper note rather than a misleading "self" bubble.

### Empty State

If the session exists but contains no messages, show an explicit empty-state card:

- title: clear and calm, e.g. `还没有消息`
- body: explain that this session has no chat history yet
- action: keep the return-to-list affordance

This should feel intentional rather than like a broken timeline.

### Error and Not-Found States

Preserve the existing explicit state treatment:

- `loading`: show a loading card while detail data is being prepared
- `not-found`: show `Session not found` only after the request finishes without a matching session
- `error`: show a dedicated failure card and a return path

## State Management

### Route-Level Detail State

The detail route should aggregate session summary and message history into one detail state machine:

- `loading`
- `not-found`
- `error`
- `empty`
- `ready`

Recommended fields:

- `status`
- `session`
- `messages`
- `errorMessage`

This state can live in the route file or in a small detail-specific loader module. It does not need a long-lived global store yet.

### Concurrency and Navigation Safety

The route should continue protecting against stale async results when:

- the user leaves the detail screen before a request resolves
- the session id changes
- the active onboarding team changes

The existing team-scoped back-navigation behavior should stay intact.

## Testing and Verification

### Automated Coverage

This phase should add focused automated coverage for:

- message record mapping in `session-api`
- `listMessages(teamId, sessionId)` success path
- detail-state transitions:
  - `loading -> ready`
  - `loading -> empty`
  - `loading -> not-found`
  - `loading -> error`

Existing Expo tests must remain green.

### Manual Verification

With valid Expo Supabase env vars:

1. Start Expo with `pnpm expo:dev -- --clear`
2. Sign in and land on `/(app)/sessions`
3. Open a session with existing messages
4. Confirm the detail view shows chronological read-only history
5. Open a session with no messages and confirm the explicit empty state
6. Confirm there is still no composer or send action

## Acceptance Criteria

This phase is complete when:

- Expo detail route still enforces current-team scope
- session detail reads real messages from the backend
- existing message history renders in chronological order
- empty, error, and not-found states remain explicit and distinct
- no sending or fake composer UI is introduced
- `pnpm expo:test` remains green
