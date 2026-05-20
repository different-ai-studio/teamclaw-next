# Android ↔ iOS Parity Roadmap

Target: replicate every feature, interaction, and visual treatment from
`apps/ios/` into `apps/android/`. iOS is the source of truth for product
behavior, copy, and the Hai 灰 design language (see `apps/ios/DESIGN.md`).

This file is the running gap list and phased plan. Update it as work lands.

## Status legend

- ✅ shipped & matches iOS
- 🟡 partially implemented (skeleton, missing iOS detail)
- 🟥 not yet implemented
- N/A doesn't apply to Android (platform-only)

---

## 1. Navigation & shell

| Feature                                | iOS source                                      | Android | Notes |
| -------------------------------------- | ----------------------------------------------- | :-----: | --- |
| Bottom 4-tab nav (Sessions/Ideas/Actors/Search) | `AMUXUI/Root/RootTabView.swift`        |   🟡    | scaffold landed; Ideas/Search are placeholders |
| Tab 1 — Sessions                       | `AMUXUI/SessionList/*`                          |   🟡    | list + detail exist; missing Hai paper styling, participant cluster, agent badge, daemon banner |
| Tab 2 — Ideas                          | `AMUXUI/Collab/*`                               |   🟥    | placeholder only |
| Tab 3 — Actors (Members)               | `AMUXUI/Members/*`                              |   🟡    | basic list + invite; missing Humans/Agents segmented filter, "YOU" badge |
| Tab 4 — Search                         | `AMUXCore/Search/SearchMatcher.swift`           |   🟥    | placeholder only |
| Shortcuts (in Sessions drawer)         | `AMUXUI/Shortcuts/*`                            |   🟥    | not implemented (lives inside Sessions tab on iOS) |
| Deep-link → tab + sheet                | `ContentView.swift` deep-link router            |   🟡    | parser exists, not routed to tabs yet |
| Splash → Auth → CreateTeam → Ready     | `ContentView.swift`                             |    ✅   | matched |

## 2. Auth & onboarding

| Feature                       | iOS source                                                  | Android | Notes |
| ----------------------------- | ----------------------------------------------------------- | :-----: | --- |
| Welcome / Choose / Login flow | `AMUXApp/WelcomeView.swift`, `ChooseAuthView.swift`, etc.   |    ✅   | matched |
| Email OTP                     | `Onboarding/SupabaseAppOnboardingStore.swift`               |    ✅   | matched |
| Apple Sign-In                 | `Auth/AppleSignInHandler.swift`                             |    ✅   | matched (AppAuth) |
| Google Sign-In                | `SupabaseAppOnboardingStore.signInWithGoogle`               |    ✅   | matched (Credentials API) |
| Anonymous workspace           | coordinator path                                            |    ✅   | matched |
| Invite claim                  | `claimInviteSmart`                                          |    ✅   | matched |
| ZeroAgent reminder sheet      | `Onboarding/ZeroAgentReminderSheet.swift`                   |   🟥    | not implemented |
| Upgrade anonymous account     | `Settings/UpgradeAccountSheet.swift`                        |    ✅   | matched |

## 3. Sessions (chat)

| Feature                                       | iOS source                                                | Android | Notes |
| --------------------------------------------- | --------------------------------------------------------- | :-----: | --- |
| Session list rows (preview, agent badge)      | `SessionList/SessionListContent.swift`                    |   🟡    | text-only; missing agent badge / unread dot / participant cluster |
| New-session sheet (Hai paper)                 | `SessionList/NewSessionSheet.swift`                       |   🟡    | exists; visuals need Hai paper card |
| Agent config sheet                            | `SessionList/AgentConfigSheet.swift`                      |   🟥    | not implemented |
| Daemon status banner                          | `SessionList/DaemonStatusBanner.swift`                    |   🟥    | not implemented |
| Participant cluster (avatar stack)            | `SessionList/ParticipantCluster.swift`                    |   🟥    | not implemented |
| iMessage-style bubbles                        | `AgentDetail/EventFeedView.swift`                         |   🟡    | basic bubbles; missing left/right alignment + tool/thinking renders |
| Streaming detail card                         | `AgentDetail/StreamingDetailView.swift`                   |   🟡    | streamed text but no card styling |
| Composer: text + mentions                     | `AgentDetail/SessionComposer.swift`                       |    ✅   | text + mentions ok |
| Composer: slash commands popup                | `SlashCommandsPopup`                                      |   🟡    | popup exists, styling/animation needs Hai polish |
| Composer: mention popup                       | `MentionsPopup`                                           |   🟡    | as above |
| Composer: voice + waveform                    | `AgentDetail/RecordingWaveform.swift`                     |   🟡    | system intent only; no in-app recording waveform |
| Composer: attachments drawer                  | `AgentDetail/AttachmentDrawerSheet.swift`                 |   🟥    | not implemented |
| Composer: agent chip selector                 | `AgentChipState.swift`                                    |   🟥    | not implemented |
| Markdown rendering in messages                | `Markdown/MarkdownBlock.swift`, `BlockMarkdownView.swift` |   🟡    | `MarkdownText.kt` exists; limited block types |
| Session member sheet (swipe-to-remove)        | `AgentDetail/SessionMemberSheet.swift`                    |   🟥    | not implemented |
| Add agent / add member sheets                 | `AgentDetail/AddAgentSheet.swift`, `AddMemberSheet.swift` |   🟥    | not implemented |

## 4. Ideas (collab)

| Feature                  | iOS source                            | Android | Notes |
| ------------------------ | ------------------------------------- | :-----: | --- |
| Idea list + search       | `Collab/IdeaListView.swift`           |   🟥    | not implemented |
| Idea detail (inline edit)| `Collab/IdeaDetailView.swift`         |   🟥    | not implemented |
| New idea Hai sheet       | `Collab/IdeaSheet.swift`              |   🟥    | not implemented |
| Archived ideas           | `Collab/ArchivedIdeasView.swift`      |   🟥    | not implemented |
| Idea store + repo        | `Ideas/IdeaStore.swift` + repo + sync |   🟥    | not implemented |

## 5. Members

| Feature                          | iOS source                                | Android | Notes |
| -------------------------------- | ----------------------------------------- | :-----: | --- |
| Member list                      | `Members/MemberListContent.swift`         |   🟡    | exists; missing segmented filter, "YOU" badge |
| Humans / Agents segmented filter | `Shared/SegmentedFilterBar.swift`         |   🟥    | not implemented |
| Invite sheet (Hai paper)         | `Members/MemberInviteSheet.swift`         |   🟡    | exists; needs Hai paper visuals |

## 6. Workspace management

| Feature                                    | iOS source                                       | Android | Notes |
| ------------------------------------------ | ------------------------------------------------ | :-----: | --- |
| Workspace list (swipe-delete)              | `Workspace/WorkspaceManagementView.swift`        |   🟥    | not implemented; store exists, no UI |
| Edit / create workspace sheet              | `Workspace/WorkspaceSheet.swift`                 |   🟥    | not implemented |

## 7. Shortcuts

| Feature                  | iOS source                                  | Android | Notes |
| ------------------------ | ------------------------------------------- | :-----: | --- |
| Shortcuts drawer / list  | `Shortcuts/ShortcutsDrawer.swift`           |   🟥    | not implemented |
| Shortcut webview         | `Shortcuts/ShortcutWebView.swift`           |   🟥    | not implemented |
| Shortcut menu row        | `Shortcuts/ShortcutMenuRow.swift`           |   🟥    | not implemented |
| Shortcuts store + repo   | `Shortcuts/ShortcutsStore.swift` + repo     |   🟥    | not implemented |

## 8. Settings & notifications

| Feature                       | iOS source                                  | Android | Notes |
| ----------------------------- | ------------------------------------------- | :-----: | --- |
| Settings landing              | `Settings/SettingsView.swift`               |   🟡    | exists; missing notification entry, polish |
| Notifications settings        | `Settings/NotificationsSettingsView.swift`  |   🟥    | not implemented |
| Upgrade account sheet         | `Settings/UpgradeAccountSheet.swift`        |    ✅   | matched |

## 9. Push, presence, MQTT

| Feature                       | iOS source                                  | Android | Notes |
| ----------------------------- | ------------------------------------------- | :-----: | --- |
| MQTT connect / topic schema   | `MQTT/MQTTService.swift`, `MQTTTopics.swift`|    ✅   | matched (HiveMQ) |
| MQTT trace recorder           | `MQTT/MQTTTraceRecorder.swift`              |   🟥    | not implemented |
| Push registration (APNs/FCM)  | `Push/PushService.swift`                    |   🟥    | not implemented (no FCM) |
| Push permission flow          | `Push/PushPermissionManager.swift`          |   🟥    | not implemented |
| Push preferences              | `Push/PushPreferences.swift`                |   🟥    | not implemented |
| Presence heartbeat            | `Push/PresenceHeartbeat.swift`              |   🟥    | not implemented |
| Foreground session focus      | `Push/CurrentSessionFocus.swift`            |   🟥    | not implemented |

## 10. Files & attachments

| Feature                       | iOS source                                       | Android | Notes |
| ----------------------------- | ------------------------------------------------ | :-----: | --- |
| Attachment upload manager     | `Attachments/AttachmentUploadManager.swift`      |   🟥    | not implemented |
| Camera / photos / files picker| `AttachmentDrawerSheet.swift`                    |   🟥    | not implemented |
| Upload state persistence      | `Attachments/UploadState.swift`                  |   🟥    | not implemented |
| Outbox retry                  | `Outbox/OutboxSender.swift`                      |   🟥    | not implemented |

## 11. Search

| Feature                       | iOS source                                  | Android | Notes |
| ----------------------------- | ------------------------------------------- | :-----: | --- |
| Search tab                    | (consumed in `RootTabView`)                 |   🟥    | placeholder |
| SearchMatcher                 | `Search/SearchMatcher.swift`                |   🟥    | not implemented |

## 12. Design system

| Feature                                  | iOS source                                        | Android | Notes |
| ---------------------------------------- | ------------------------------------------------- | :-----: | --- |
| Hai 6-color palette + Cinnabar/Sage      | `AMUXSharedUI/AMUXTheme.swift`                    |    ✅   | matched |
| Serif headline + Inter body              | `Font.amuxSerif(_:weight:)`                       |   🟡    | platform serif/sans-serif, not EB Garamond/Inter bundled fonts |
| JetBrains Mono for code/ids              | iOS uses SF Mono fallback                         |   🟥    | not bundled |
| `HaiSectionLabel` / `HaiSheetRow` / `HaiPaperCard` | `Shared/HaiSheet.swift`                  |   🟡    | introduced in this PR — replace ad-hoc styling site by site |
| `GlassButtonStyle` (iOS 26 glass)        | `Shared/GlassButtonStyle.swift`                   |    N/A  | iOS-only; Android uses Material 3 filled tonal |
| `LiquidGlassBar`                         | `Shared/LiquidGlassBar.swift`                     |    N/A  | iOS-only |
| `SegmentedFilterBar`                     | `Shared/SegmentedFilterBar.swift`                 |   🟥    | needed for Members + Ideas |
| `StatusBadge` / `ConnectionBanner` / `AgentStatusPill` | `AMUXSharedUI/*.swift`               |   🟥    | not yet ported |

## 13. Voice & media

| Feature                  | iOS source                          | Android | Notes |
| ------------------------ | ----------------------------------- | :-----: | --- |
| Voice-to-text (system)   | `Voice/VoiceRecorder.swift`         |   🟡    | system `RecognizerIntent`; no in-app rendering |
| In-app waveform UI       | `AgentDetail/RecordingWaveform.swift` |  🟥   | not implemented |
| Camera capture (JPEG)    | iOS `UIImagePickerController`       |   🟥    | not implemented |
| Photos picker (max 5)    | iOS `PhotosPicker`                  |   🟥    | not implemented |

## 14. Resources

| Feature                | iOS source                                | Android | Notes |
| ---------------------- | ----------------------------------------- | :-----: | --- |
| App icon               | `AppIcon.appiconset`                      |   🟡    | placeholder Android adaptive icon |
| Teamclaw logo (lobster)| `AMUXUI/Resources/Assets.xcassets/Teamclaw*` |  🟥  | not bundled |
| Claude/Codex/OpenCode logos| `AMUXUI/Resources/Assets.xcassets/*Logo*` | 🟥  | not bundled |
| EB Garamond + Inter + JetBrains Mono fonts | iOS system            | 🟥    | not bundled (use platform serif for now) |

## 15. Tests

| Feature                       | iOS source                                  | Android | Notes |
| ----------------------------- | ------------------------------------------- | :-----: | --- |
| Onboarding coordinator tests  | `AppOnboardingCoordinatorTests.swift`       |    ✅   | matched |
| ActorStore / WorkspaceStore   | `ActorStoreTests.swift` etc.                |    ✅   | matched |
| Chat timeline reducer         | `ChatTimelineReducerTests.swift`            |   🟥    | not implemented |
| Session detail VM             | `SessionDetailViewModelTests.swift`         |   🟥    | not implemented |
| Push service                  | `PushServiceTests.swift`                    |   🟥    | not implemented |
| File upload integration       | `FileUploadIntegrationTests.swift`          |   🟥    | not implemented |
| UI tests (auth, session)      | `AMUXSessionMessageRegressionTests.swift`   |    🟡   | minimal androidTest skeletons |

---

## Phased rollout

Each phase is one or more PRs into `feat/ios-android-parity`. Land in order.

### Phase 0 — Foundation (this PR)

- [x] Write this `PARITY.md`
- [x] Bottom 5-tab nav scaffold (Sessions / Ideas / Members / Shortcuts / Search)
- [x] Hai sheet primitives (`HaiPaperCard`, `HaiSectionLabel`, `HaiSheetRow`, `HaiSegmentedFilterBar`, `HaiStatusBadge`) in `core/design`
- [x] Placeholder Ideas / Shortcuts / Search tabs
- [x] Settings reachable from Sessions header (kept) + Workspace placeholder

### Phase 1 — Ideas + Workspace (full collab loop)

- `:core:ideas` module: `IdeaRecord`, `IdeaRepository`, `IdeaStore`, real-time sync
- `:feature:ideas` module: list, detail (inline edit), Hai new-idea sheet, archived view
- Workspace management screens (list + edit sheet) reachable from Sessions/Settings
- Tests: `IdeaStoreTest`, `WorkspaceManagementStoreTest`

### Phase 2 — Push notifications (FCM)

- Add FCM Gradle plugin + `google-services.json` instructions
- `:core:push` module: token registration, preference store, presence heartbeat,
  current session focus, deep-link receiver
- Foreground notification suppression; quiet-hours preference
- Settings entry → notification preferences screen
- Mirror Supabase push tables (already shared with iOS)

### Phase 3 — Attachments + Outbox

- `:core:attachments` module: upload manager (Supabase Storage), persistence,
  retry/outbox
- Composer attachment drawer (files / camera / photos / model picker)
- Photo picker via `ActivityResultContracts.PickMultipleVisualMedia` (max 5)
- Camera capture via `ActivityResultContracts.TakePicture`
- Wire upload state into chat bubble rendering

### Phase 4 — Chat polish

- Hai bubble renderer (left/right, tool_use, thinking, permission card)
- Streaming detail card styling
- Agent chip selector + persisted state per session
- Daemon status banner
- Participant cluster avatar stack
- Member sheet with swipe-to-remove
- Add agent / add member sheets

### Phase 5 — Voice waveform + agent chips polish

- In-app voice recorder (custom AudioRecord pipeline) + waveform UI
- Replace system `RecognizerIntent` flow
- Speech recognition with vocabulary boosting

### Phase 6 — Shortcuts

- `:core:shortcuts` module: store + repo + Supabase sync
- `:feature:shortcuts` module: drawer with WebView, menu rows
- Slash command integration with composer (already wired)

### Phase 7 — Search + members polish

- `:core:search` (port `SearchMatcher`): fuzzy match over sessions, ideas, actors
- Search tab UI
- Members segmented filter + "YOU" badge
- Hai invite sheet polish

### Phase 8 — Fonts + brand assets

- Bundle EB Garamond / Inter / JetBrains Mono as Compose font resources
- Bundle Teamclaw lobster + Agent logos (Claude / Codex / OpenCode / OpenAgent)
- Update Typography.kt to use bundled fonts

### Phase 9 — Test parity

- Port `ChatTimelineReducerTests`, `SessionDetailViewModelTests`,
  `PushServiceTests`, `FileUploadIntegrationTests`
- Add Compose UI tests for each major screen
- CI runs detekt + unit tests + androidTests on Android emulator

---

## Working agreements

- **iOS is source of truth.** When in doubt, open the iOS file and match
  copy, spacing, and behavior. Cite the iOS path in PR descriptions.
- **Hai discipline.** Cinnabar is the *only* accent. Never use it for
  decoration. See `apps/ios/DESIGN.md`.
- **Material 3 maps to Hai.** Don't introduce Material defaults that fight
  the palette (no purple `primary`, no blue `secondary`).
- **Per-feature modules.** Every iOS package gets a peer Android module so
  imports stay scoped. (`:core:ideas`, `:core:push`, `:core:attachments`,
  `:core:shortcuts`, `:core:search`, `:feature:ideas`, `:feature:shortcuts`.)
- **One feature per PR.** Each phase above is its own PR (or two for big
  ones). Keep the diff readable.
