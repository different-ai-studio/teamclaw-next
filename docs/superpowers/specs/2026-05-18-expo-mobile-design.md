# Expo Mobile Design

Date: 2026-05-18
Status: Approved for planning
Scope: Add a new Expo-based mobile app at `apps/expo` that translates the current iOS onboarding and authentication flow into React Native while stopping at a minimal post-auth app shell.

## Goal

Create a new `apps/expo` app in this monorepo that preserves the product behavior of the current iOS onboarding flow while using Expo-native patterns and tooling.

The first deliverable is a cross-platform mobile entrypoint that can:

- boot and restore an existing Supabase session
- route unauthenticated users through onboarding
- support anonymous sign-in
- support real email OTP sign-in and verification
- create a team when the user has no existing team
- enter a basic authenticated shell after setup succeeds
- sign out and return to onboarding

The first deliverable does not need to implement the full iOS app runtime, MQTT messaging, or team realtime behavior.

## Why This Shape

The current `apps/ios` app spreads onboarding behavior across SwiftUI views, `AMUXApp`, and `AMUXCore` store/coordinator logic. That logic is a useful product reference, but it is not directly reusable from Expo. Attempting to share the Swift packages or bridge them into React Native would slow the first working version and create a fragile mixed-stack boundary.

This design intentionally rebuilds the onboarding behavior in TypeScript using Expo Router and `@supabase/supabase-js`, while keeping feature semantics aligned with iOS.

## Product Scope

### In Scope

- New Expo app at `apps/expo`
- Expo Router navigation
- Onboarding flow equivalent to:
  - `WelcomeView`
  - `ChooseAuthView`
  - `LoginView`
  - `CreateTeamView`
- Startup bootstrap that restores session and determines the next route
- Real Supabase integration for:
  - session restore
  - anonymous sign-in
  - email OTP send
  - email OTP verify
  - create-team flow
  - sign-out
- Minimal authenticated shell after successful onboarding
- Workspace integration updates so the Expo app can be installed and run from this repo
- Minimal automated coverage for the onboarding state flow

### Out of Scope

- MQTT connect and reconnect flows
- Team realtime or live session sync
- Chat thread, session list, or message streaming
- SwiftData-equivalent offline cache
- Invite deep link claim flow
- Apple sign-in implementation
- Google sign-in implementation
- Full parity with `RootTabView` and downstream iOS screens
- Extracting a shared mobile core package into `packages/`

### Explicit Temporary UX Gaps

- Apple and Google sign-in buttons will render as disabled or placeholder actions with clear "coming soon" feedback
- The authenticated shell will be a stable placeholder screen, not a partial chat UI

## Architecture

### App Placement

Add a new workspace at `apps/expo`. This app is independent from `apps/ios` and does not consume Swift packages.

The app should use Expo Router for file-based navigation and React Native components for UI.

### Proposed Directory Structure

```text
apps/expo/
  app/
    _layout.tsx
    index.tsx
    welcome.tsx
    auth.tsx
    create-team.tsx
    (app)/
      _layout.tsx
      home.tsx
  src/
    features/
      onboarding/
        screens/
        components/
        onboarding-store.ts
        onboarding-reducer.ts
        onboarding-types.ts
    lib/
      supabase/
        client.ts
        config.ts
        onboarding-api.ts
    ui/
      button.tsx
      input.tsx
      card.tsx
      theme.ts
    test/
      onboarding-store.test.ts
  assets/
    ...
  app.json
  babel.config.js
  package.json
  tsconfig.json
```

The directory names may vary slightly to match Expo defaults, but the separation of concerns should stay intact:

- `app/` owns route files only
- `src/features/onboarding/` owns product flow and state
- `src/lib/supabase/` owns backend calls and configuration
- `src/ui/` owns reusable visual primitives

## State and Routing Design

### Core State Machine

The Expo app should preserve the iOS onboarding semantics with a dedicated coordinator layer implemented in TypeScript. This can be either a small reducer-backed store or a Zustand store with explicit transition functions. The important constraint is that navigation stays state-driven instead of being spread across individual screens.

Required route states:

- `loading`
- `needsAuth`
- `createTeam`
- `ready`
- `failed`

Required store fields:

- `route`
- `isBusy`
- `errorMessage`
- `pendingEmailOTPEmail`
- `currentTeam`
- `currentMemberActorId`
- `isAnonymous`

### Bootstrap Flow

On cold launch:

1. Set route to `loading`
2. Restore the Supabase session from persisted auth state
3. If no session exists, transition to `needsAuth`
4. If a session exists, query the bootstrap data needed to determine team membership
5. If the user has no teams, transition to `createTeam`
6. If the user has at least one team, set the active team context and transition to `ready`
7. If any non-auth failure occurs, transition to `failed`

This should mirror the behavioral role of `AppOnboardingCoordinator.bootstrap()` without trying to port every implementation detail.

### Router Shape

Use Expo Router with a small number of explicit screens:

- `/` as the dispatch route that redirects based on onboarding state
- `/welcome` for the initial welcome screen
- `/auth` for email OTP sign-in
- `/create-team` for first-team creation
- `/(app)/home` for the minimal authenticated shell

The router should not become the source of truth for state. It should reflect the current state from the onboarding coordinator.

## Backend Integration

### Supabase Client

The Expo app should use `@supabase/supabase-js` directly.

Configuration should come from Expo public env vars:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

This is the simplest Expo-compatible approach for the first version. Runtime server override support is intentionally deferred.

### API Surface for Phase 1

Implement a focused onboarding API module with these behaviors:

- `getCurrentSession()`
- `loadBootstrap()`
- `signInAnonymously()`
- `sendEmailOTP(email)`
- `verifyOTP(email, token)`
- `createTeam(name)`
- `signOut()`

### Bootstrap Query Semantics

The Expo implementation should align with the iOS product semantics:

- no session means auth is required
- a valid session with no team means the user must create a team
- a valid session with one or more teams means the user can enter the app shell

The data returned from `loadBootstrap()` only needs to satisfy those routing decisions plus the shell display needs. It does not need to reproduce every downstream iOS repository or store.

### Deferred Integrations

These capabilities are intentionally not included in phase 1:

- invite token claim before auth
- auth callback deep links
- Apple OAuth token exchange
- Google OAuth redirect flow
- MQTT access-token-driven reconnect behavior

Those should be added only after the basic onboarding app is stable.

## UI and Interaction Design

### Source of Truth

The Expo UI should follow the current iOS onboarding behavior and the repository-level visual intent from `AGENTS.md`, adapted to React Native constraints.

This means:

- calm paper-like surfaces
- restrained coral accent usage
- readable dense layouts with breathing room
- clear separation between primary and secondary actions

### Screens

#### Welcome

Purpose:

- establish brand and orientation
- provide one clear path into auth selection

Expected behavior:

- render the brand welcome screen
- show any boot or auth error message inline
- primary action leads to the auth choice screen

#### Auth Choice

Purpose:

- let the user choose between anonymous entry, email auth, and future social auth

Expected behavior:

- primary action: anonymous sign-in
- secondary action: continue to email OTP auth
- placeholder actions for Apple and Google can exist either here or on the auth screen, but must not imply they work today

#### Email Auth

Purpose:

- collect email
- send OTP
- verify OTP

Expected behavior:

- two-step flow in one screen or two tightly related subviews
- once OTP has been requested, the UI reflects the target email
- verify action is enabled only when the code length is valid
- failures surface inline and do not eject the user from the screen

#### Create Team

Purpose:

- allow a freshly authenticated user with no existing team to create one

Expected behavior:

- simple single-input form
- disabled submit while busy
- on success, transition directly into authenticated shell

#### Authenticated Shell

Purpose:

- provide a stable post-onboarding destination before the realtime app is implemented

Expected contents:

- current team name
- member actor id if available
- account mode indicator such as anonymous vs authenticated
- sign-out action
- one or two placeholder cards indicating the next capabilities to be added later

The shell should look intentional, not like a debug screen, but it should remain lightweight and honest about missing capabilities.

## Error Handling

Errors should stay local to the current user action whenever possible.

Rules:

- bootstrap errors that indicate missing auth route to `needsAuth`
- bootstrap errors that indicate broken configuration or backend failures route to `failed`
- form submission errors remain inline on the current screen
- a failed OTP verify attempt must not clear the pending email state
- placeholder OAuth actions should return a non-blocking informational message, not an error state

The user should never be dropped into an ambiguous blank state.

## Testing Strategy

### Automated

Add focused tests for the onboarding coordinator or reducer covering at least:

- no session -> `needsAuth`
- session with no teams -> `createTeam`
- session with team -> `ready`
- bootstrap exception -> `failed`
- OTP send success stores `pendingEmailOTPEmail`
- successful sign-out returns to auth flow

Add API-layer tests for request-level behavior when practical, especially around input/output shaping and error mapping.

### Manual Verification

Before calling the work complete, verify:

- cold launch without session
- anonymous sign-in flow
- email OTP send flow
- email OTP verify flow
- create-team flow for a new user
- relaunch with persisted session
- sign-out from shell

## Implementation Sequence

1. Create the Expo workspace and wire it into the monorepo
2. Add route structure and a minimal theme foundation
3. Build the onboarding coordinator/store and reducer tests
4. Build Supabase client/config/api helpers
5. Implement welcome, auth choice, email OTP, and create-team screens
6. Implement authenticated shell
7. Add scripts and docs needed to run the Expo app locally
8. Run the verification flow and fix rough edges

## Tradeoffs Considered

### Option A: Build `apps/expo` as a standalone Expo app

Pros:

- fastest path to a working cross-platform app
- clean Expo-native structure
- minimal coupling to Swift implementation details

Cons:

- duplicates onboarding logic in TypeScript
- creates a future need to extract shared behavior if both mobile apps remain active

### Option B: Extract a shared mobile TypeScript core first

Pros:

- cleaner long-term architecture if multiple mobile clients coexist

Cons:

- delays first delivery
- adds abstraction pressure before the Expo app behavior is proven

### Option C: Build only a mocked Expo prototype first

Pros:

- fastest UI-only turnaround

Cons:

- low product value
- high chance of rework when real auth is connected

### Chosen Direction

Choose Option A for phase 1.

It balances delivery speed, product value, and architectural clarity. Shared abstractions can be introduced later from working TypeScript code instead of speculative design.

## Open Follow-Up Work

These are expected next phases after the first Expo app lands:

- invite link handling
- Apple and Google auth
- richer authenticated navigation
- session list and chat UI
- MQTT and realtime connectivity
- local cache and offline strategy
- shared mobile domain extraction if Expo and iOS both remain active

## Acceptance Criteria

This design is successful when:

- `apps/expo` exists and runs inside the monorepo
- a user can sign in anonymously or by email OTP against the real Supabase backend
- a user with no team is routed into team creation
- a user with a team reaches an authenticated shell
- sign-out returns the app to onboarding
- the implementation does not pretend unsupported capabilities are complete

