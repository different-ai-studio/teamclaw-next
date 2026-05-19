# Expo Sessions Design

Date: 2026-05-18
Status: Approved for planning
Scope: Extend `apps/expo` beyond onboarding by translating the iOS `Sessions` tab into an Expo Router flow with a real session list and a minimal session detail shell.

## Goal

Upgrade the Expo app from an onboarding-only entrypoint into a usable post-auth session browser that follows the current iOS `Sessions` tab semantics.

This phase should let an authenticated user:

- land on a real `Sessions` screen after onboarding
- fetch and view their existing team sessions from the backend
- refresh the list manually
- open a session detail route
- view stable session metadata in that detail route
- see the `New Session` affordance in the same place as iOS, with a clear placeholder state

This phase does not include session creation, message streaming, message sending, or realtime updates.

## Why This Shape

The onboarding phase proved the Expo app can authenticate, bootstrap a team, and enter a basic authenticated shell. The next highest-value step is to translate the iOS app's first real post-auth destination: the `Sessions` tab.

Starting with the session list keeps the migration anchored to a concrete iOS behavior while avoiding the larger complexity of MQTT, runtime resolution, and chat detail streaming. It also creates a stable home route for the Expo app that can later absorb session creation and chat features without redesigning the navigation structure again.

## Product Scope

### In Scope

- Replace the current authenticated placeholder landing page with a real session list route
- Add a session detail route under the authenticated app stack
- Read session data from the real backend for the active team
- Display iOS-aligned session fields:
  - title
  - last message preview
  - participant count
  - created time
  - last message time
  - summary
- Preserve the top-right `New Session` affordance as a placeholder action
- Support loading, empty, refresh, not-found, and error states
- Keep routing driven by the existing onboarding/auth context

### Out of Scope

- Creating a new session
- Sending a message
- Streaming assistant output
- MQTT runtime state
- Realtime session subscriptions
- Search
- Pin / archive actions
- Multi-tab parity with `Ideas`, `Actors`, or `Search`
- SwiftData-equivalent offline cache

### Explicit Temporary UX Gaps

- `New Session` will render as a visible placeholder action with "coming soon" feedback
- Session detail is a metadata shell, not a live chat screen
- No empty-state branch for "no accessible agents yet" because the Expo app does not yet have the iOS actor-access layer

## iOS Reference Behavior

This phase should align with the current iOS `Sessions` tab as implemented in:

- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Root/RootTabView.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Root/SessionsTab.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/SessionList/SessionListHelpers.swift`
- `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Models/Session.swift`

The important behaviors to preserve are:

- the app lands in a dedicated `Sessions` destination after auth
- the list is sorted by recent activity, with `createdAt` as fallback
- each row emphasizes title, preview, time, and participant count
- list loading and empty states are first-class
- selecting a row navigates to a session-specific route
- the `New Session` action stays visible in the navigation chrome

The Expo version intentionally omits iOS-only behaviors tied to local storage, swipe actions, live runtime status, or message streaming.

## Architecture

### Authenticated Route Shape

The authenticated area should move from a single `home` route to a sessions-focused stack:

```text
apps/expo/app/
  (app)/
    _layout.tsx
    home.tsx           -> redirect to /sessions
    sessions/
      index.tsx
      [sessionId].tsx
```

Recommended route behavior:

- `/(app)/home` becomes a compatibility redirect to `/(app)/sessions`
- `/(app)/sessions/index` is the primary post-auth destination
- `/(app)/sessions/[sessionId]` is the session detail shell

The onboarding state machine remains the source of truth for whether the user is allowed into `/(app)`.

### Feature Placement

Add a dedicated sessions feature under `apps/expo/src/features/sessions/`:

```text
apps/expo/src/features/sessions/
  session-types.ts
  session-api.ts
  session-controller.ts
  screens/
    SessionsListScreen.tsx
    SessionDetailScreen.tsx
  components/
    SessionRow.tsx
```

Responsibilities:

- route files stay thin and translate URL params into screen props
- API module owns backend reads and mapping
- controller owns loading and refresh behavior
- screens own visual states and interaction wiring
- row component owns reusable list-row rendering

## Data Model

### Session Shape

The Expo app should use a mobile-friendly TypeScript model aligned with the iOS `Session` fields needed by this phase:

- `sessionId`
- `teamId`
- `title`
- `summary`
- `participantCount`
- `lastMessagePreview`
- `lastMessageAt`
- `createdAt`
- `createdBy`

Derived UI behavior:

- display title falls back to `Untitled Session`
- sorting key is `lastMessageAt ?? createdAt`
- detail view can show `No messages yet` when both preview and summary are empty

### Data Sources

Phase 2 needs two backend reads:

- `listSessions(teamId)`
- `getSession(sessionId)`

These reads should use the same authenticated Supabase client already established in the onboarding phase. They are plain request/response reads only, with no subscription layer and no background cache.

## Backend Integration

### API Surface

Add a focused session API with methods like:

- `listSessions(teamId: string): Promise<SessionSummary[]>`
- `getSession(sessionId: string): Promise<SessionSummary | null>`

The backend contract should map to the active team's sessions and only return the fields needed for this phase.

### Ordering and Grouping

The API should return data that can be sorted by `lastMessageAt` descending, falling back to `createdAt`. Grouping can happen client-side in this phase.

To keep this phase small, the Expo app should use a simplified group model:

- `Today`
- `Earlier`

That preserves the iOS idea of visually grouped recency without requiring the full date-bucketing fidelity yet.

## UI and Interaction Design

### Sessions List

The sessions list should follow the iOS mobile shape, not the desktop three-column shell.

Each row should include:

- title on the first line
- relative or short-form timestamp on the right
- preview text on the second line
- participant count in a lightweight meta strip

Top-level screen behavior:

- navigation title: `Sessions`
- top-right button: `New Session`
- pull-to-refresh enabled
- visible loading state before first fetch
- explicit empty state when the team has no sessions
- error state with retry when fetch fails

### New Session Placeholder

The `New Session` button should remain visible in the header to preserve iOS information architecture.

In this phase it should:

- be tappable
- show a clear placeholder response such as `New Session coming soon`
- not navigate into an unfinished flow

### Session Detail Shell

The detail route should be honest about what is implemented. It is not a fake chat screen.

Recommended content:

- title
- summary or last preview
- participant count
- created time
- updated time
- session id
- a visual block that says chat migration is coming next

If the route param is valid but the session cannot be loaded:

1. show loading while the fetch is in flight
2. show `Session not found` only after the request completes without data
3. offer a route back to the sessions list

## State Management

### List Controller

Use a small controller or reducer-backed store for the list route with explicit states:

- `idle`
- `loading`
- `loaded`
- `empty`
- `error`

Required capabilities:

- initial load
- refresh
- preserve the last loaded rows while a refresh is in flight when reasonable

### Detail Controller

The detail route can use a simpler route-local loader:

- `loading`
- `loaded`
- `notFound`
- `error`

It does not need a long-lived global store yet.

## Error Handling

The Expo app should prefer clear, user-safe copy rather than raw backend errors.

Examples:

- list fetch failure: `We couldn't load your sessions right now.`
- detail fetch failure: `We couldn't open this session right now.`
- placeholder creation action: `New Session is coming soon in Expo.`

Error handling should never invalidate the existing auth/onboarding state unless the underlying Supabase session has actually expired or been removed.

## Testing

### Automated Coverage

Add focused coverage for:

- session API mapping for `listSessions`
- session API mapping for `getSession`
- list controller transitions:
  - loading to loaded
  - loading to empty
  - loading to error
  - loaded refresh flow

### Manual Verification

Verify this phase manually with:

1. sign in through the existing Expo onboarding flow
2. confirm the authenticated landing route is `Sessions`
3. confirm existing team sessions render in sorted order
4. pull to refresh and confirm the state remains stable
5. tap a row and confirm detail metadata loads
6. tap `New Session` and confirm the placeholder feedback appears
7. validate empty and not-found states against a team or route that produces them

## Delivery Outcome

When this phase is complete, `apps/expo` should no longer feel like an onboarding demo. It should feel like the first real slice of the post-auth TeamClaw app:

- onboarding works
- team bootstrap works
- sessions list is real
- session detail is routable and stable
- the navigation structure matches the iOS app closely enough to support the next migration step

The next logical phase after this one is session creation plus chat detail migration.
