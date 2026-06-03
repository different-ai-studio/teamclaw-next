# OpenCode Runtime Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daemon-owned runtime refresh control plane that detects OpenCode runtime-affecting changes from TeamClaw UI writes and external file edits, auto-applies them when the workspace is idle, and surfaces pending apply prompts when active runtimes exist.

**Architecture:** Add a focused `RuntimeRefreshCoordinator` in `apps/daemon/src/runtime/refresh.rs`, keep `RuntimeSupervisor::reload_workspace()` as the V1 actuator, thread refresh state into the daemon HTTP runtime status surface, then teach runtime-affecting mutation paths and filesystem watchers to report changes into the coordinator. Finish by projecting the new refresh state into the frontend with workspace-level and session-level prompts.

**Tech Stack:** Rust (`tokio`, `notify`, existing daemon HTTP/runtime modules), TypeScript/React 19, Zustand, Vitest

---

## File Structure

### New files

- `apps/daemon/src/runtime/refresh.rs`
  Daemon-owned refresh coordinator, refresh types, state machine, watcher debounce, and apply orchestration entry points.
- `apps/daemon/src/runtime/refresh_watch.rs`
  Filesystem watch bootstrap and path-to-change-kind mapping helpers so `refresh.rs` stays focused on state orchestration.
- `apps/daemon/src/http/__tests__/workspace_runtime_refresh.rs`
  Rust integration coverage for runtime status/apply-refresh HTTP behavior.
- `packages/app/src/components/chat/RuntimeRefreshNotice.tsx`
  Small presentational component for session-level refresh hint.
- `packages/app/src/components/settings/WorkspaceRuntimeRefreshBanner.tsx`
  Workspace-level banner/status row with apply action.
- `packages/app/src/components/settings/__tests__/WorkspaceRuntimeRefreshBanner.test.tsx`
  Frontend tests for banner rendering and apply action behavior.
- `packages/app/src/components/chat/__tests__/RuntimeRefreshNotice.test.tsx`
  Frontend tests for session-level hint behavior.

### Modified files

- `apps/daemon/src/runtime/mod.rs`
  Export refresh modules.
- `apps/daemon/src/runtime/supervisor.rs`
  Extend runtime status response with refresh state and route reload/apply through the coordinator.
- `apps/daemon/src/runtime/manager.rs`
  Reuse active workspace detection helpers from refresh apply decisions.
- `apps/daemon/src/http/state.rs`
  Add coordinator handle to HTTP state.
- `apps/daemon/src/http/workspaces.rs`
  Extend runtime status payload and redefine runtime reload as apply-intent semantics.
- `apps/daemon/src/daemon/server.rs`
  Construct coordinator, start watchers, and inject shared handles.
- `apps/daemon/src/config/workspace_control.rs`
  Extend `RuntimeStatus` with refresh metadata and keep `ApplyOutcome` compatibility.
- `packages/app/src/lib/daemon-local-client.ts`
  Add typed refresh payloads and apply-refresh response handling.
- `packages/app/src/components/settings/SkillsSection.tsx`
  Stop assuming save == runtime applied; optionally trigger apply endpoint only via shared banner flow.
- `packages/app/src/components/settings/EnvVarsSection.tsx`
  Same semantic cleanup for env-var saves.
- `packages/app/src/stores/provider.ts`
  Stop showing page-local restart logic and rely on shared refresh state after provider auth changes.
- `packages/app/src/components/chat/ChatPanel.tsx`
  Mount session-level runtime refresh hint.

### Existing tests to extend

- `packages/app/src/components/settings/__tests__/EnvVarsSection.reload.test.tsx`
- `packages/app/src/components/settings/__tests__/SkillsSection.test.tsx`
- `packages/app/src/stores/__tests__/provider.test.ts`
- daemon runtime / HTTP tests near `apps/daemon/src/http/workspaces.rs` and `apps/daemon/src/runtime/supervisor.rs`

---

### Task 1: Add the daemon refresh model and coordinator

**Files:**
- Create: `apps/daemon/src/runtime/refresh.rs`
- Modify: `apps/daemon/src/runtime/mod.rs`
- Modify: `apps/daemon/src/config/workspace_control.rs`
- Test: `apps/daemon/src/runtime/refresh.rs`

- [ ] **Step 1: Write the failing unit tests for refresh state and impact selection**

```rust
#[tokio::test]
async fn strongest_pending_impact_wins() {
    let coordinator = RuntimeRefreshCoordinator::new();
    coordinator
        .record_change(
            "ws-1",
            std::path::Path::new("/tmp/ws-1"),
            RefreshChangeKind::Skills,
            RefreshSource::UiMutation,
        )
        .await
        .unwrap();
    coordinator
        .record_change(
            "ws-1",
            std::path::Path::new("/tmp/ws-1"),
            RefreshChangeKind::Mcp,
            RefreshSource::FilesystemWatch,
        )
        .await
        .unwrap();

    let state = coordinator.workspace_state("ws-1").await.unwrap();
    assert_eq!(state.status, WorkspaceRefreshStatus::Pending);
    assert_eq!(state.recommended_action, RefreshRecommendedAction::ApplyChanges);
    assert_eq!(state.strongest_impact, RefreshImpact::IdleRestart);
    assert!(state.change_kinds.contains(&RefreshChangeKind::Skills));
    assert!(state.change_kinds.contains(&RefreshChangeKind::Mcp));
}

#[tokio::test]
async fn failed_apply_keeps_pending_state() {
    let coordinator = RuntimeRefreshCoordinator::new();
    coordinator
        .record_change(
            "ws-2",
            std::path::Path::new("/tmp/ws-2"),
            RefreshChangeKind::EnvVars,
            RefreshSource::UiMutation,
        )
        .await
        .unwrap();

    coordinator
        .mark_apply_failed("ws-2", "reload failed")
        .await;

    let state = coordinator.workspace_state("ws-2").await.unwrap();
    assert_eq!(state.status, WorkspaceRefreshStatus::Failed);
    assert!(state.last_error.as_deref().unwrap().contains("reload failed"));
    assert!(state.change_kinds.contains(&RefreshChangeKind::EnvVars));
}
```

- [ ] **Step 2: Run the new Rust test target and verify it fails**

Run: `cargo test -p amuxd runtime::refresh -- --nocapture`  
Expected: FAIL with missing `RuntimeRefreshCoordinator`, `RefreshChangeKind`, and refresh state types.

- [ ] **Step 3: Add the refresh domain model and minimal coordinator implementation**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RefreshChangeKind {
    Skills,
    Mcp,
    EnvVars,
    ProviderAuth,
    ProviderCatalog,
    Permissions,
    OpencodeJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshImpact {
    AppliedLive,
    IdleReload,
    IdleRestart,
    UserApplyRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRefreshStatus {
    Clean,
    Pending,
    Applying,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRefreshState {
    pub workspace_id: String,
    pub workspace_path: String,
    pub status: WorkspaceRefreshStatus,
    pub strongest_impact: RefreshImpact,
    pub recommended_action: RefreshRecommendedAction,
    pub change_kinds: std::collections::BTreeSet<RefreshChangeKind>,
    pub sources: std::collections::BTreeSet<RefreshSource>,
    pub auto_apply_blocked_by_active_runtime: bool,
    pub first_detected_at: chrono::DateTime<chrono::Utc>,
    pub last_detected_at: chrono::DateTime<chrono::Utc>,
    pub last_error: Option<String>,
}

pub struct RuntimeRefreshCoordinator {
    inner: tokio::sync::RwLock<std::collections::HashMap<String, WorkspaceRefreshState>>,
}

impl RuntimeRefreshCoordinator {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            inner: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        })
    }

    pub async fn record_change(
        &self,
        workspace_id: &str,
        workspace_path: &std::path::Path,
        kind: RefreshChangeKind,
        source: RefreshSource,
    ) -> Result<(), crate::config::workspace_control::WorkspaceControlError> {
        let now = chrono::Utc::now();
        let mut guard = self.inner.write().await;
        let entry = guard.entry(workspace_id.to_string()).or_insert_with(|| WorkspaceRefreshState {
            workspace_id: workspace_id.to_string(),
            workspace_path: workspace_path.display().to_string(),
            status: WorkspaceRefreshStatus::Pending,
            strongest_impact: impact_for_kind(kind),
            recommended_action: RefreshRecommendedAction::ApplyChanges,
            change_kinds: std::collections::BTreeSet::new(),
            sources: std::collections::BTreeSet::new(),
            auto_apply_blocked_by_active_runtime: false,
            first_detected_at: now,
            last_detected_at: now,
            last_error: None,
        });
        entry.status = WorkspaceRefreshStatus::Pending;
        entry.change_kinds.insert(kind);
        entry.sources.insert(source);
        entry.last_detected_at = now;
        entry.strongest_impact = strongest_impact(entry.change_kinds.iter().copied());
        entry.last_error = None;
        Ok(())
    }
}
```

- [ ] **Step 4: Export the refresh module and thread refresh state into `RuntimeStatus`**

```rust
// apps/daemon/src/runtime/mod.rs
pub mod refresh;
pub mod refresh_watch;

// apps/daemon/src/config/workspace_control.rs
#[derive(Debug, Serialize, Clone)]
pub struct RuntimeRefreshDto {
    pub status: String,
    pub change_kinds: Vec<String>,
    pub recommended_action: String,
    pub auto_apply_blocked_by_active_runtime: bool,
    pub last_detected_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RuntimeStatus {
    pub workspace_id: String,
    pub ready: bool,
    pub backend: String,
    pub current_model: Option<String>,
    pub refresh: Option<RuntimeRefreshDto>,
}
```

- [ ] **Step 5: Run the Rust tests again and verify they pass**

Run: `cargo test -p amuxd runtime::refresh -- --nocapture`  
Expected: PASS for the new refresh tests.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/runtime/refresh.rs apps/daemon/src/runtime/mod.rs apps/daemon/src/config/workspace_control.rs
git commit -m "feat(daemon): add runtime refresh coordinator model"
```

### Task 2: Route runtime status and apply requests through the coordinator

**Files:**
- Modify: `apps/daemon/src/runtime/supervisor.rs`
- Modify: `apps/daemon/src/http/state.rs`
- Modify: `apps/daemon/src/http/workspaces.rs`
- Modify: `apps/daemon/src/daemon/server.rs`
- Test: `apps/daemon/src/http/__tests__/workspace_runtime_refresh.rs`

- [ ] **Step 1: Write the failing HTTP/status tests**

```rust
#[tokio::test]
async fn runtime_status_includes_pending_refresh_state() {
    let fixture = WorkspaceRuntimeRefreshFixture::new().await;
    fixture
        .refresh
        .record_change(
            &fixture.workspace_id,
            fixture.workspace.path(),
            RefreshChangeKind::Skills,
            RefreshSource::UiMutation,
        )
        .await
        .unwrap();

    let resp = fixture.get_runtime_status().await;
    assert_eq!(resp.status(), axum::http::StatusCode::OK);

    let body: serde_json::Value = fixture.json(resp).await;
    assert_eq!(body["refresh"]["status"], "pending");
    assert_eq!(body["refresh"]["recommended_action"], "apply_changes");
}

#[tokio::test]
async fn apply_refresh_clears_pending_state_when_reload_succeeds() {
    let fixture = WorkspaceRuntimeRefreshFixture::new().await;
    fixture
        .refresh
        .record_change(
            &fixture.workspace_id,
            fixture.workspace.path(),
            RefreshChangeKind::EnvVars,
            RefreshSource::UiMutation,
        )
        .await
        .unwrap();

    let resp = fixture.post_apply_refresh().await;
    assert_eq!(resp.status(), axum::http::StatusCode::OK);

    let state = fixture.refresh.workspace_state(&fixture.workspace_id).await;
    assert!(state.is_none(), "successful apply should clear pending state");
}
```

- [ ] **Step 2: Run the HTTP test target and verify it fails**

Run: `cargo test -p amuxd workspace_runtime_refresh -- --nocapture`  
Expected: FAIL because runtime status has no `refresh` payload and no apply-refresh fixture wiring exists.

- [ ] **Step 3: Add coordinator handles to HTTP state and daemon server bootstrap**

```rust
// apps/daemon/src/http/state.rs
pub struct HttpState {
    pub metadata: ServerMetadata,
    pub runtime: Arc<dyn RuntimeAdapter>,
    pub runtime_supervisor: Option<Arc<RuntimeSupervisor>>,
    pub workspace_control: Option<Arc<dyn WorkspaceControlStore>>,
    pub refresh: Option<Arc<RuntimeRefreshCoordinator>>,
}

// apps/daemon/src/daemon/server.rs
let refresh = crate::runtime::refresh::RuntimeRefreshCoordinator::new();
let runtime_supervisor = Some(crate::runtime::RuntimeSupervisor::new(
    self.agents.clone(),
    refresh.clone(),
));
```

- [ ] **Step 4: Extend `RuntimeSupervisor` to expose/apply refresh state**

```rust
impl RuntimeSupervisor {
    pub fn new(
        agents: Arc<AsyncMutex<RuntimeManager>>,
        refresh: Arc<RuntimeRefreshCoordinator>,
    ) -> Arc<Self> {
        Arc::new(Self { agents, refresh })
    }

    pub async fn runtime_status(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<RuntimeStatus, WorkspaceControlError> {
        let mut status = /* existing runtime status logic */;
        status.refresh = self
            .refresh
            .workspace_state(workspace_id)
            .await
            .map(|state| state.into_runtime_refresh_dto());
        Ok(status)
    }

    pub async fn apply_refresh(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
    ) -> Result<ApplyOutcome, WorkspaceControlError> {
        self.refresh
            .apply_pending(workspace_id, workspace_path, self)
            .await
    }
}
```

- [ ] **Step 5: Teach `/runtime/reload` to behave as apply-intent semantics**

```rust
pub async fn reload_runtime(
    principal: Principal,
    State(state): State<HttpState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<ApplyResponse>, HttpError> {
    require_scope(&principal, "workspace:write")?;
    let workspace_path = decode_workspace_path(&workspace_id).map_err(map_control_err)?;

    if let Some(supervisor) = state.runtime_supervisor.as_ref() {
        let outcome = supervisor
            .apply_refresh(&workspace_id, &workspace_path)
            .await
            .map_err(map_control_err)?;
        return Ok(apply_ok(outcome));
    }

    let store = resolve_store(&state)?;
    let outcome = store.reload_runtime(&workspace_id).map_err(map_control_err)?;
    Ok(apply_ok(outcome))
}
```

- [ ] **Step 6: Run the HTTP tests again and verify they pass**

Run: `cargo test -p amuxd workspace_runtime_refresh -- --nocapture`  
Expected: PASS for runtime status and apply-refresh behavior.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/runtime/supervisor.rs apps/daemon/src/http/state.rs apps/daemon/src/http/workspaces.rs apps/daemon/src/daemon/server.rs apps/daemon/src/http/__tests__/workspace_runtime_refresh.rs
git commit -m "feat(daemon): expose runtime refresh status and apply flow"
```

### Task 3: Report TeamClaw-owned config mutations into the refresh coordinator

**Files:**
- Modify: `apps/daemon/src/http/workspaces.rs`
- Modify: `apps/daemon/src/opencode_settings/mod.rs`
- Modify: `packages/app/src/lib/daemon-local-client.ts`
- Test: `apps/daemon/src/http/__tests__/workspace_runtime_refresh.rs`
- Test: `packages/app/src/stores/__tests__/provider.test.ts`

- [ ] **Step 1: Write the failing mutation-path tests**

```rust
#[tokio::test]
async fn provider_oauth_callback_records_provider_auth_change() {
    let fixture = WorkspaceRuntimeRefreshFixture::new().await;
    fixture.complete_provider_callback("openai").await;

    let state = fixture.refresh.workspace_state(&fixture.workspace_id).await.unwrap();
    assert!(state.change_kinds.contains(&RefreshChangeKind::ProviderAuth));
}
```

```ts
it('does not show page-local restart warning when shared refresh state is pending', async () => {
  mocks.reloadDaemonRuntime.mockResolvedValue('reload_required')
  renderProviderStoreHarness()

  await act(async () => {
    await useProviderStore.getState().connectProvider('openai', {
      apiKey: 'sk-test',
    })
  })

  expect(mockToastInfo).not.toHaveBeenCalledWith(
    expect.stringContaining('Agent restart required'),
    expect.anything(),
  )
})
```

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run: `cargo test -p amuxd workspace_runtime_refresh provider_oauth_callback -- --nocapture`  
Expected: FAIL because provider callback does not record refresh changes.

Run: `pnpm exec vitest run packages/app/src/stores/__tests__/provider.test.ts`  
Expected: FAIL because provider store still owns restart messaging.

- [ ] **Step 3: Record semantic changes from all workspace-control mutation handlers**

```rust
async fn record_refresh_change(
    state: &HttpState,
    workspace_id: &str,
    workspace_path: &std::path::Path,
    kind: RefreshChangeKind,
    source: RefreshSource,
) {
    if let Some(refresh) = state.refresh.as_ref() {
        if let Err(err) = refresh
            .record_change(workspace_id, workspace_path, kind, source)
            .await
        {
            tracing::warn!(workspace_id = %workspace_id, error = %err, "failed to record runtime refresh change");
        }
    }
}

// after successful skill/mcp/permission/provider writes:
record_refresh_change(&state, &workspace_id, &workspace_path, RefreshChangeKind::Skills, RefreshSource::UiMutation).await;
record_refresh_change(&state, &workspace_id, &workspace_path, RefreshChangeKind::Mcp, RefreshSource::UiMutation).await;
record_refresh_change(&state, &workspace_id, &workspace_path, RefreshChangeKind::Permissions, RefreshSource::UiMutation).await;
```

- [ ] **Step 4: Update provider auth and frontend callers to rely on shared refresh state**

```rust
// apps/daemon/src/http/workspaces.rs
reload_runtime_after_provider_auth(&state, &workspace_id, &wpath).await;
record_refresh_change(
    &state,
    &workspace_id,
    &wpath,
    RefreshChangeKind::ProviderAuth,
    RefreshSource::UiMutation,
).await;
```

```ts
export interface RuntimeRefreshPayload {
  status: 'clean' | 'pending' | 'applying' | 'failed'
  change_kinds: string[]
  recommended_action: 'none' | 'apply_changes'
  auto_apply_blocked_by_active_runtime: boolean
  last_detected_at?: string | null
  last_error?: string | null
}

export interface DaemonRuntimeStatus {
  workspace_id: string
  ready: boolean
  backend: string
  current_model: string | null
  refresh?: RuntimeRefreshPayload | null
}
```

- [ ] **Step 5: Run the Rust and Vitest targets again and verify they pass**

Run: `cargo test -p amuxd workspace_runtime_refresh provider_oauth_callback -- --nocapture`  
Expected: PASS with provider-auth refresh state recorded.

Run: `pnpm exec vitest run packages/app/src/stores/__tests__/provider.test.ts`  
Expected: PASS with provider store no longer emitting page-local restart guidance.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/http/workspaces.rs apps/daemon/src/opencode_settings/mod.rs packages/app/src/lib/daemon-local-client.ts packages/app/src/stores/__tests__/provider.test.ts
git commit -m "feat(refresh): record UI-driven runtime-affecting changes"
```

### Task 4: Add filesystem watcher coverage for external edits

**Files:**
- Create: `apps/daemon/src/runtime/refresh_watch.rs`
- Modify: `apps/daemon/src/daemon/server.rs`
- Modify: `apps/daemon/src/runtime/refresh.rs`
- Test: `apps/daemon/src/runtime/refresh_watch.rs`

- [ ] **Step 1: Write the failing watcher/debounce tests**

```rust
#[tokio::test]
async fn skill_path_change_maps_to_skills_kind() {
    let path = std::path::Path::new("/tmp/demo/.opencode/skills/my-skill/SKILL.md");
    assert_eq!(
        classify_refresh_path(path),
        Some(RefreshChangeKind::Skills)
    );
}

#[tokio::test]
async fn burst_events_are_debounced_into_one_recorded_change() {
    let coordinator = RuntimeRefreshCoordinator::new();
    let workspace = tempfile::tempdir().unwrap();

    let debounce = RefreshDebounce::new(coordinator.clone(), std::time::Duration::from_millis(100));
    debounce.record_path_hit("ws-1", workspace.path(), RefreshChangeKind::Skills).await;
    debounce.record_path_hit("ws-1", workspace.path(), RefreshChangeKind::Skills).await;
    debounce.record_path_hit("ws-1", workspace.path(), RefreshChangeKind::Skills).await;
    debounce.flush_for_test("ws-1").await;

    let state = coordinator.workspace_state("ws-1").await.unwrap();
    assert_eq!(state.change_kinds.len(), 1);
    assert!(state.change_kinds.contains(&RefreshChangeKind::Skills));
}
```

- [ ] **Step 2: Run the watcher tests and verify they fail**

Run: `cargo test -p amuxd runtime::refresh_watch -- --nocapture`  
Expected: FAIL with missing watcher classification/debounce helpers.

- [ ] **Step 3: Implement path classification and debounce helpers**

```rust
pub fn classify_refresh_path(path: &std::path::Path) -> Option<RefreshChangeKind> {
    let text = path.to_string_lossy();
    if text.ends_with("opencode.json") {
        return Some(RefreshChangeKind::OpencodeJson);
    }
    if text.contains("/.opencode/skills/")
        || text.contains("/.teamclaw/skills/")
        || text.contains("/.config/opencode/skills/")
        || text.contains("/.config/teamclaw/skills/")
    {
        return Some(RefreshChangeKind::Skills);
    }
    None
}

pub struct RefreshDebounce {
    pending: tokio::sync::Mutex<std::collections::HashMap<String, RefreshChangeKind>>,
    coordinator: std::sync::Arc<RuntimeRefreshCoordinator>,
    delay: std::time::Duration,
}
```

- [ ] **Step 4: Start watchers from daemon server and forward events into the coordinator**

```rust
// apps/daemon/src/daemon/server.rs
crate::runtime::refresh_watch::spawn_workspace_refresh_watchers(
    refresh.clone(),
    self.workspaces.clone(),
);
```

```rust
pub fn spawn_workspace_refresh_watchers(
    refresh: Arc<RuntimeRefreshCoordinator>,
    workspaces: crate::workspace::WorkspaceRegistry,
) {
    tokio::spawn(async move {
        for workspace in workspaces.workspaces.values() {
            let Some(workspace_path) = workspace.path.as_deref() else { continue };
            watch_workspace_paths(refresh.clone(), workspace.id.clone(), std::path::PathBuf::from(workspace_path));
        }
    });
}
```

- [ ] **Step 5: Run the watcher tests again and verify they pass**

Run: `cargo test -p amuxd runtime::refresh_watch -- --nocapture`  
Expected: PASS for path classification and debounce behavior.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/runtime/refresh_watch.rs apps/daemon/src/runtime/refresh.rs apps/daemon/src/daemon/server.rs
git commit -m "feat(refresh): watch external workspace changes"
```

### Task 5: Surface refresh prompts in the frontend

**Files:**
- Create: `packages/app/src/components/settings/WorkspaceRuntimeRefreshBanner.tsx`
- Create: `packages/app/src/components/chat/RuntimeRefreshNotice.tsx`
- Modify: `packages/app/src/lib/daemon-local-client.ts`
- Modify: `packages/app/src/components/settings/SkillsSection.tsx`
- Modify: `packages/app/src/components/settings/EnvVarsSection.tsx`
- Modify: `packages/app/src/components/chat/ChatPanel.tsx`
- Test: `packages/app/src/components/settings/__tests__/WorkspaceRuntimeRefreshBanner.test.tsx`
- Test: `packages/app/src/components/chat/__tests__/RuntimeRefreshNotice.test.tsx`

- [ ] **Step 1: Write the failing frontend component tests**

```ts
it('renders a workspace banner with apply action when refresh is pending', async () => {
  render(
    <WorkspaceRuntimeRefreshBanner
      refresh={{
        status: 'pending',
        change_kinds: ['skills', 'mcp'],
        recommended_action: 'apply_changes',
        auto_apply_blocked_by_active_runtime: true,
        last_detected_at: '2026-06-03T12:34:56Z',
      }}
      onApply={vi.fn()}
    />
  )

  expect(screen.getByText('此工作区有运行时变更待应用')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '应用变更' })).toBeInTheDocument()
})

it('renders a session hint when refresh is pending for the active workspace', async () => {
  render(
    <RuntimeRefreshNotice
      refresh={{
        status: 'pending',
        change_kinds: ['skills'],
        recommended_action: 'apply_changes',
        auto_apply_blocked_by_active_runtime: true,
      }}
    />
  )

  expect(screen.getByText(/为立即生效，请先应用变更/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the frontend tests and verify they fail**

Run: `pnpm exec vitest run packages/app/src/components/settings/__tests__/WorkspaceRuntimeRefreshBanner.test.tsx packages/app/src/components/chat/__tests__/RuntimeRefreshNotice.test.tsx`  
Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the banner and session hint components**

```tsx
export function WorkspaceRuntimeRefreshBanner({
  refresh,
  onApply,
  applying = false,
}: {
  refresh: RuntimeRefreshPayload
  onApply: () => void | Promise<void>
  applying?: boolean
}) {
  if (refresh.status !== 'pending' && refresh.status !== 'failed') return null

  const kinds = refresh.change_kinds.map((kind) => kindLabel(kind)).join('、')
  return (
    <div className="rounded-[14px] border border-border bg-paper px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[13px] font-semibold text-foreground">此工作区有运行时变更待应用</p>
          <p className="text-[12px] text-muted-foreground">{kinds} 已更新。</p>
        </div>
        <button className="rounded-[8px] bg-coral px-3 py-1.5 text-[12px] font-semibold text-white" onClick={() => void onApply()} disabled={applying}>
          应用变更
        </button>
      </div>
    </div>
  )
}
```

```tsx
export function RuntimeRefreshNotice({ refresh }: { refresh?: RuntimeRefreshPayload | null }) {
  if (!refresh || refresh.status !== 'pending') return null
  return (
    <div className="rounded-[8px] border border-border bg-paper px-3 py-2 text-[12px] text-ink-2">
      {refresh.change_kinds.map(kindLabel).join('、')} 已更新。为立即生效，请先应用变更。
    </div>
  )
}
```

- [ ] **Step 4: Wire the components to daemon runtime status and apply action**

```ts
export async function getDaemonRuntimeStatus(
  workspaceId: string,
): Promise<DaemonRuntimeStatus | null> {
  const result = await daemonFetch<DaemonRuntimeStatus>(`/v1/workspaces/${workspaceId}/runtime`)
  return result.ok ? result.data : null
}
```

```tsx
const runtimeStatus = useRuntimeRefreshStatus(workspacePath)

<WorkspaceRuntimeRefreshBanner
  refresh={runtimeStatus?.refresh ?? null}
  onApply={async () => {
    await reloadDaemonRuntime(encodeWorkspaceId(workspacePath))
    await refetchRuntimeStatus()
  }}
/>;

<RuntimeRefreshNotice refresh={runtimeStatus?.refresh ?? null} />
```

- [ ] **Step 5: Run the frontend test targets and verify they pass**

Run: `pnpm exec vitest run packages/app/src/components/settings/__tests__/WorkspaceRuntimeRefreshBanner.test.tsx packages/app/src/components/chat/__tests__/RuntimeRefreshNotice.test.tsx packages/app/src/components/settings/__tests__/SkillsSection.test.tsx packages/app/src/components/settings/__tests__/EnvVarsSection.reload.test.tsx`  
Expected: PASS with shared refresh prompts replacing page-local restart semantics.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/settings/WorkspaceRuntimeRefreshBanner.tsx packages/app/src/components/chat/RuntimeRefreshNotice.tsx packages/app/src/components/settings/__tests__/WorkspaceRuntimeRefreshBanner.test.tsx packages/app/src/components/chat/__tests__/RuntimeRefreshNotice.test.tsx packages/app/src/components/settings/SkillsSection.tsx packages/app/src/components/settings/EnvVarsSection.tsx packages/app/src/components/chat/ChatPanel.tsx packages/app/src/lib/daemon-local-client.ts
git commit -m "feat(app): surface runtime refresh prompts"
```

### Task 6: End-to-end verification and cleanup

**Files:**
- Modify: `docs/superpowers/specs/2026-06-03-opencode-runtime-refresh-design.md`
- Modify: any touched source files above if verification reveals gaps
- Test: Rust + Vitest command suite below

- [ ] **Step 1: Run the daemon Rust test suite for refresh-related modules**

Run: `cargo test -p amuxd runtime::refresh runtime::refresh_watch workspace_runtime_refresh -- --nocapture`  
Expected: PASS for coordinator, watcher, and HTTP runtime-refresh flows.

- [ ] **Step 2: Run the frontend test suite for affected UX and stores**

Run: `pnpm exec vitest run packages/app/src/components/settings/__tests__/WorkspaceRuntimeRefreshBanner.test.tsx packages/app/src/components/chat/__tests__/RuntimeRefreshNotice.test.tsx packages/app/src/components/settings/__tests__/SkillsSection.test.tsx packages/app/src/components/settings/__tests__/EnvVarsSection.reload.test.tsx packages/app/src/stores/__tests__/provider.test.ts`  
Expected: PASS for shared refresh UI and provider/settings integration.

- [ ] **Step 3: Perform one manual daemon scenario check**

Run: `pnpm daemon:run`  
Expected: daemon starts cleanly and logs watcher bootstrap without panicking.

Then, in a second terminal:

Run: `touch .opencode/skills/manual-refresh/SKILL.md`  
Expected: runtime status endpoint reports `refresh.status = pending` for the workspace, and if no runtime is active the pending state clears after auto-apply.

- [ ] **Step 4: Tighten any mismatched copy, field names, or stale comments found during verification**

```ts
// Example cleanup target after verification
// Replace comments like:
// "Skills file watching is disabled - users can manually refresh if needed"
// with:
// "Refresh status is daemon-owned; file edits are detected by the daemon watcher layer."
```

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/runtime/refresh.rs apps/daemon/src/runtime/refresh_watch.rs apps/daemon/src/http/workspaces.rs apps/daemon/src/runtime/supervisor.rs packages/app/src/components/settings/WorkspaceRuntimeRefreshBanner.tsx packages/app/src/components/chat/RuntimeRefreshNotice.tsx docs/superpowers/specs/2026-06-03-opencode-runtime-refresh-design.md
git commit -m "test: verify runtime refresh control plane end to end"
```
