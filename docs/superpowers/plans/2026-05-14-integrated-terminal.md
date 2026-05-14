# Integrated Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code–style integrated terminal as a bottom split inside ChatPanel — local PTY, multi-tab, workspace-scoped, no MQTT coupling.

**Architecture:** `portable-pty` in Rust spawns the user's `$SHELL` with cwd at workspace path; reader thread emits batched bytes over Tauri events. React frontend uses `@xterm/xterm` to render; Zustand store holds tab metadata bucketed by workspace; xterm instances live in refs, not the store.

**Tech Stack:** Rust + `portable-pty` 0.8; React + `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links`; Zustand; Tauri 2 commands/events.

**Spec reference:** `docs/superpowers/specs/2026-05-14-integrated-terminal-design.md`

---

## File Structure

**Created:**
- `src-tauri/src/terminal/mod.rs`
- `src-tauri/src/terminal/registry.rs`
- `src-tauri/src/terminal/pty.rs`
- `src-tauri/src/terminal/ring.rs`
- `src-tauri/src/commands/terminal.rs`
- `packages/app/src/lib/terminal/client.ts`
- `packages/app/src/lib/terminal/theme.ts`
- `packages/app/src/stores/terminal-store.ts`
- `packages/app/src/stores/__tests__/terminal-store.test.ts`
- `packages/app/src/components/terminal/XtermInstance.tsx`
- `packages/app/src/components/terminal/TerminalTabBar.tsx`
- `packages/app/src/components/terminal/TerminalPanel.tsx`
- `packages/app/src/components/terminal/__tests__/XtermInstance.test.tsx`
- `tests/e2e/terminal-smoke.test.ts`

**Modified:**
- `src-tauri/Cargo.toml` — add `portable-pty`
- `src-tauri/src/lib.rs` — register state + handlers + shutdown hook
- `src-tauri/src/commands/mod.rs` — declare new module
- `packages/app/package.json` — add `@xterm/*` deps
- `packages/app/src/components/chat/ChatPanel.tsx` — mount TerminalPanel
- `packages/app/src/App.tsx` — add header icon, register keyboard shortcuts hook
- `packages/app/src/locales/en.json` and `zh-CN.json` — `terminal.*` namespace

---

## Task 1: Cargo dep + module scaffold

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/terminal/mod.rs`
- Create: `src-tauri/src/terminal/ring.rs`
- Create: `src-tauri/src/terminal/registry.rs`
- Create: `src-tauri/src/terminal/pty.rs`
- Modify: `src-tauri/src/lib.rs:1-20` (add `mod terminal;`)

- [ ] **Step 1: Add `portable-pty` to Cargo.toml**

In `src-tauri/Cargo.toml`, under `[dependencies]`, after the last existing crate:

```toml
portable-pty = "0.8"
```

- [ ] **Step 2: Create module skeletons**

`src-tauri/src/terminal/mod.rs`:

```rust
pub mod pty;
pub mod registry;
pub mod ring;

pub use registry::{Registry, TerminalId, TerminalSummary, TerminalError, TerminalStatus};
```

`src-tauri/src/terminal/ring.rs`:

```rust
//! Fixed-capacity ring buffer for PTY output replay.

pub const RING_CAPACITY: usize = 8 * 1024 * 1024; // 8 MiB

pub struct RingBuffer {
    buf: Box<[u8]>,
    head: usize,
    filled: bool,
}

impl RingBuffer {
    pub fn new() -> Self {
        Self {
            buf: vec![0u8; RING_CAPACITY].into_boxed_slice(),
            head: 0,
            filled: false,
        }
    }

    pub fn write(&mut self, _data: &[u8]) {
        unimplemented!()
    }

    pub fn snapshot(&self) -> Vec<u8> {
        unimplemented!()
    }
}

impl Default for RingBuffer {
    fn default() -> Self { Self::new() }
}
```

`src-tauri/src/terminal/registry.rs`:

```rust
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub type TerminalId = String;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalSummary {
    pub id: TerminalId,
    pub shell: String,
    pub pid: u32,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
}

#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TerminalError {
    #[error("shell not found")]
    ShellNotFound,
    #[error("cwd not allowed: {0}")]
    CwdNotAllowed(String),
    #[error("cwd not found: {0}")]
    CwdNotFound(String),
    #[error("pty closed")]
    PtyClosed,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
}

pub struct Registry {
    handles: RwLock<HashMap<TerminalId, Arc<crate::terminal::pty::PtyHandle>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self { handles: RwLock::new(HashMap::new()) }
    }
}

impl Default for Registry {
    fn default() -> Self { Self::new() }
}
```

`src-tauri/src/terminal/pty.rs`:

```rust
//! Per-PTY state. Holds the master handle, child, ring buffer, and reader thread.

use std::path::PathBuf;

pub struct PtyHandle {
    pub id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub pid: u32,
}
```

- [ ] **Step 3: Register module in lib.rs**

In `src-tauri/src/lib.rs`, add to the top-level module declarations (alphabetical order alongside `mod commands;`, `mod local_cache;` etc.):

```rust
mod terminal;
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm rust:check`
Expected: clean compile, no warnings about unused imports beyond pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/terminal/ src-tauri/src/lib.rs
git commit -m "feat(terminal): scaffold terminal module + add portable-pty dep"
```

---

## Task 2: RingBuffer implementation (TDD)

**Files:**
- Modify: `src-tauri/src/terminal/ring.rs`

- [ ] **Step 1: Write failing tests**

Append to `src-tauri/src/terminal/ring.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn small_ring(cap: usize) -> RingBuffer {
        // Test helper: construct ring with custom capacity.
        RingBuffer { buf: vec![0u8; cap].into_boxed_slice(), head: 0, filled: false }
    }

    #[test]
    fn empty_snapshot_is_empty() {
        let r = small_ring(8);
        assert!(r.snapshot().is_empty());
    }

    #[test]
    fn writes_under_capacity_are_preserved() {
        let mut r = small_ring(8);
        r.write(b"hello");
        assert_eq!(r.snapshot(), b"hello");
    }

    #[test]
    fn writes_exactly_at_capacity() {
        let mut r = small_ring(8);
        r.write(b"abcdefgh");
        assert_eq!(r.snapshot(), b"abcdefgh");
    }

    #[test]
    fn wrap_around_drops_oldest() {
        let mut r = small_ring(8);
        r.write(b"abcdefgh");
        r.write(b"ij");
        assert_eq!(r.snapshot(), b"cdefghij");
    }

    #[test]
    fn large_write_keeps_last_capacity_bytes() {
        let mut r = small_ring(4);
        r.write(b"abcdefghij");
        assert_eq!(r.snapshot(), b"ghij");
    }

    #[test]
    fn many_small_writes_after_full() {
        let mut r = small_ring(4);
        r.write(b"abcd");
        r.write(b"e");
        r.write(b"f");
        assert_eq!(r.snapshot(), b"cdef");
    }
}
```

- [ ] **Step 2: Run tests, expect failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ring::tests`
Expected: panic on `unimplemented!()`.

- [ ] **Step 3: Implement write + snapshot**

Replace the `RingBuffer` impl in `src-tauri/src/terminal/ring.rs`:

```rust
impl RingBuffer {
    pub fn new() -> Self {
        Self {
            buf: vec![0u8; RING_CAPACITY].into_boxed_slice(),
            head: 0,
            filled: false,
        }
    }

    pub fn write(&mut self, data: &[u8]) {
        let cap = self.buf.len();
        if data.is_empty() || cap == 0 {
            return;
        }

        // If the chunk is at least one full capacity, keep only the tail.
        let (slice, start_head) = if data.len() >= cap {
            let tail = &data[data.len() - cap..];
            (tail, 0usize)
        } else {
            (data, self.head)
        };

        let n = slice.len();
        let first = (cap - start_head).min(n);
        self.buf[start_head..start_head + first].copy_from_slice(&slice[..first]);
        if first < n {
            self.buf[..n - first].copy_from_slice(&slice[first..]);
        }

        let new_head = (start_head + n) % cap;
        let wrapped = start_head + n >= cap;
        self.head = new_head;
        self.filled = self.filled || wrapped || (data.len() >= cap);
    }

    pub fn snapshot(&self) -> Vec<u8> {
        if !self.filled {
            return self.buf[..self.head].to_vec();
        }
        let mut out = Vec::with_capacity(self.buf.len());
        out.extend_from_slice(&self.buf[self.head..]);
        out.extend_from_slice(&self.buf[..self.head]);
        out
    }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ring::tests`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/terminal/ring.rs
git commit -m "feat(terminal): RingBuffer with wrap-around (TDD)"
```

---

## Task 3: PtyHandle spawn + reader thread (TDD)

**Files:**
- Modify: `src-tauri/src/terminal/pty.rs`

- [ ] **Step 1: Replace `pty.rs` with full implementation + tests**

```rust
//! Per-PTY state. Holds the master handle, child, ring buffer, and reader thread.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use super::ring::RingBuffer;
use super::registry::{TerminalError, TerminalStatus};

const READER_BATCH_BYTES: usize = 4096;
const READER_FLUSH_INTERVAL: Duration = Duration::from_millis(10);

pub struct PtyHandle {
    pub id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub pid: u32,

    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    ring: Arc<Mutex<RingBuffer>>,
    status: Mutex<TerminalStatus>,
    exit_code: Mutex<Option<i32>>,
}

pub struct SpawnArgs {
    pub id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
}

pub struct EmitContext {
    /// Called with `(event_name, payload_bytes)` for data events.
    pub emit_data: Arc<dyn Fn(&str, Vec<u8>) + Send + Sync>,
    /// Called once with `(event_name, code)` when the child exits or reader stops.
    pub emit_exit: Arc<dyn Fn(&str, Option<i32>) + Send + Sync>,
}

impl PtyHandle {
    pub fn spawn(args: SpawnArgs, emit: EmitContext) -> Result<Arc<Self>, TerminalError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: args.rows, cols: args.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&args.shell);
        if shell_takes_login_flag(&args.shell) {
            cmd.arg("-l");
        }
        cmd.cwd(&args.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TEAMCLAW_TERMINAL", "1");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;

        let handle = Arc::new(Self {
            id: args.id.clone(),
            workspace_id: args.workspace_id,
            cwd: args.cwd,
            shell: args.shell,
            pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            ring: Arc::new(Mutex::new(RingBuffer::new())),
            status: Mutex::new(TerminalStatus::Running),
            exit_code: Mutex::new(None),
        });

        Self::start_reader_thread(handle.clone(), reader, emit);
        Ok(handle)
    }

    fn start_reader_thread(
        handle: Arc<Self>,
        mut reader: Box<dyn std::io::Read + Send>,
        emit: EmitContext,
    ) {
        let data_event = format!("terminal://{}/data", handle.id);
        let exit_event = format!("terminal://{}/exit", handle.id);
        let ring = handle.ring.clone();
        let weak = Arc::downgrade(&handle);

        std::thread::Builder::new()
            .name(format!("pty-reader-{}", &handle.id))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut tmp = [0u8; 4096];
                    let mut batch: Vec<u8> = Vec::with_capacity(READER_BATCH_BYTES);
                    let mut last_flush = Instant::now();

                    loop {
                        match reader.read(&mut tmp) {
                            Ok(0) => break,
                            Ok(n) => {
                                ring.lock().unwrap().write(&tmp[..n]);
                                batch.extend_from_slice(&tmp[..n]);
                                if batch.len() >= READER_BATCH_BYTES
                                    || last_flush.elapsed() >= READER_FLUSH_INTERVAL
                                {
                                    (emit.emit_data)(&data_event, std::mem::take(&mut batch));
                                    last_flush = Instant::now();
                                }
                            }
                            Err(_) => break,
                        }
                    }

                    if !batch.is_empty() {
                        (emit.emit_data)(&data_event, batch);
                    }
                }));

                let exit_code = if let Some(h) = weak.upgrade() {
                    let mut child = h.child.lock().unwrap();
                    match child.wait() {
                        Ok(status) => status.exit_code() as i32,
                        Err(_) => -1,
                    }
                } else {
                    -1
                };

                if let Some(h) = weak.upgrade() {
                    *h.status.lock().unwrap() = TerminalStatus::Exited;
                    *h.exit_code.lock().unwrap() = Some(exit_code);
                }

                let code = if result.is_err() { Some(-1) } else { Some(exit_code) };
                (emit.emit_exit)(&exit_event, code);
            })
            .expect("failed to spawn reader thread");
    }

    pub fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        if matches!(*self.status.lock().unwrap(), TerminalStatus::Exited) {
            return Err(TerminalError::PtyClosed);
        }
        let mut w = self.writer.lock().unwrap();
        w.write_all(data).map_err(|_| TerminalError::PtyClosed)?;
        w.flush().map_err(|_| TerminalError::PtyClosed)?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self.master.lock().unwrap();
        master
            .resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| TerminalError::SpawnFailed(e.to_string()))?;
        Ok(())
    }

    pub fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.ring.lock().unwrap().snapshot()
    }

    pub fn status(&self) -> TerminalStatus { *self.status.lock().unwrap() }
    pub fn exit_code(&self) -> Option<i32> { *self.exit_code.lock().unwrap() }
}

fn shell_takes_login_flag(shell: &str) -> bool {
    let name = Path::new(shell).file_name().and_then(|s| s.to_str()).unwrap_or("");
    matches!(name, "zsh" | "bash" | "sh" | "fish")
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn make_emit() -> (EmitContext, mpsc::Receiver<(String, Vec<u8>)>, mpsc::Receiver<(String, Option<i32>)>) {
        let (data_tx, data_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let data_tx = Mutex::new(data_tx);
        let exit_tx = Mutex::new(exit_tx);
        let emit = EmitContext {
            emit_data: Arc::new(move |name, bytes| {
                let _ = data_tx.lock().unwrap().send((name.to_string(), bytes));
            }),
            emit_exit: Arc::new(move |name, code| {
                let _ = exit_tx.lock().unwrap().send((name.to_string(), code));
            }),
        };
        (emit, data_rx, exit_rx)
    }

    #[test]
    fn echo_produces_output_and_exit() {
        let tmp = std::env::temp_dir();
        let (emit, data_rx, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-1".into(),
                workspace_id: "ws".into(),
                cwd: tmp.clone(),
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");

        handle.write(b"echo hello\nexit\n").expect("write");

        // Collect data events until exit fires.
        let exit_msg = exit_rx.recv_timeout(Duration::from_secs(5)).expect("exit event");
        assert!(exit_msg.0.starts_with("terminal://test-1/exit"));

        let mut buf = Vec::new();
        while let Ok((_, chunk)) = data_rx.try_recv() {
            buf.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("hello"), "expected 'hello' in output, got: {text}");
        assert!(matches!(handle.status(), TerminalStatus::Exited));
    }

    #[test]
    fn ring_buffer_replay_after_output() {
        let tmp = std::env::temp_dir();
        let (emit, _data_rx, exit_rx) = make_emit();
        let handle = PtyHandle::spawn(
            SpawnArgs {
                id: "test-2".into(),
                workspace_id: "ws".into(),
                cwd: tmp,
                shell: "/bin/sh".into(),
                cols: 80,
                rows: 24,
            },
            emit,
        )
        .expect("spawn");

        handle.write(b"printf marker_xyz\nexit\n").expect("write");
        let _ = exit_rx.recv_timeout(Duration::from_secs(5));

        let snap = handle.snapshot();
        let text = String::from_utf8_lossy(&snap);
        assert!(text.contains("marker_xyz"), "snapshot missing marker: {text}");
    }
}
```

- [ ] **Step 2: Run tests, expect pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml terminal::pty::tests --features default -- --nocapture`
Expected: 2 tests pass (skipped on Windows via `#[cfg(unix)]`).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/terminal/pty.rs
git commit -m "feat(terminal): PtyHandle spawn + reader thread"
```

---

## Task 4: Registry CRUD (TDD)

**Files:**
- Modify: `src-tauri/src/terminal/registry.rs`

- [ ] **Step 1: Write failing tests**

Append to `src-tauri/src/terminal/registry.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_registry_lists_zero() {
        let r = Registry::new();
        assert_eq!(r.list_summaries(None).len(), 0);
    }

    #[test]
    fn remove_missing_returns_none() {
        let r = Registry::new();
        assert!(r.remove("nonexistent").is_none());
    }

    #[test]
    fn get_missing_returns_none() {
        let r = Registry::new();
        assert!(r.get("nonexistent").is_none());
    }
}
```

Note: insertion + listing with real handles is exercised end-to-end via the integration tests already in `pty.rs::tests` (Task 3) and the manual smoke test in Task 6 — keeping unit tests pure means we don't need a synthetic `PtyHandle` constructor.

- [ ] **Step 2: Add CRUD methods to Registry**

Replace the existing `impl Registry { ... }` block:

```rust
impl Registry {
    pub fn new() -> Self {
        Self { handles: RwLock::new(HashMap::new()) }
    }

    pub fn insert(&self, id: TerminalId, handle: Arc<crate::terminal::pty::PtyHandle>) {
        self.handles.write().unwrap().insert(id, handle);
    }

    pub fn get(&self, id: &str) -> Option<Arc<crate::terminal::pty::PtyHandle>> {
        self.handles.read().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) -> Option<Arc<crate::terminal::pty::PtyHandle>> {
        self.handles.write().unwrap().remove(id)
    }

    pub fn list_summaries(&self, workspace_id: Option<&str>) -> Vec<TerminalSummary> {
        self.handles
            .read()
            .unwrap()
            .values()
            .filter(|h| workspace_id.is_none_or(|w| h.workspace_id == w))
            .map(|h| TerminalSummary {
                id: h.id.clone(),
                shell: h.shell.clone(),
                pid: h.pid,
                status: h.status(),
                exit_code: h.exit_code(),
            })
            .collect()
    }

    pub fn kill_all(&self) {
        for (_, h) in self.handles.write().unwrap().drain() {
            h.kill();
        }
    }
}
```

- [ ] **Step 3: Run tests, expect pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml terminal::registry::tests`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/terminal/registry.rs
git commit -m "feat(terminal): Registry CRUD"
```

---

## Task 5: Tauri commands (terminal_open, _subscribe, _write, _resize, _close, _list)

**Files:**
- Create: `src-tauri/src/commands/terminal.rs`
- Modify: `src-tauri/src/commands/mod.rs:1-40` (add `pub mod terminal;`)

- [ ] **Step 1: Add module declaration**

In `src-tauri/src/commands/mod.rs`, alphabetically with the other modules (after `team_webdav`, before `trash`):

```rust
pub mod terminal;
```

- [ ] **Step 2: Implement commands**

`src-tauri/src/commands/terminal.rs`:

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::terminal::pty::{EmitContext, PtyHandle, SpawnArgs};
use crate::terminal::registry::{Registry, TerminalError, TerminalStatus, TerminalSummary};

#[derive(serde::Serialize)]
pub struct OpenResult {
    pub id: String,
    pub shell: String,
    pub pid: u32,
}

#[derive(serde::Serialize)]
pub struct SubscribeResult {
    pub ring_snapshot: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
}

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    registry: State<'_, Arc<Registry>>,
    workspace_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    allowed_roots: Vec<String>,
) -> Result<OpenResult, TerminalError> {
    let cwd_path = canonicalize_cwd(&cwd, &allowed_roots)?;
    let shell = resolve_shell(shell);
    let id = uuid::Uuid::now_v7().to_string();

    let app_for_data = app.clone();
    let app_for_exit = app.clone();
    let emit = EmitContext {
        emit_data: Arc::new(move |name, payload| {
            let _ = app_for_data.emit(name, payload);
        }),
        emit_exit: Arc::new(move |name, code| {
            let _ = app_for_exit.emit(name, code);
        }),
    };

    let handle = PtyHandle::spawn(
        SpawnArgs {
            id: id.clone(),
            workspace_id,
            cwd: cwd_path,
            shell: shell.clone(),
            cols,
            rows,
        },
        emit,
    )?;
    let pid = handle.pid;
    registry.insert(id.clone(), handle);

    Ok(OpenResult { id, shell, pid })
}

#[tauri::command]
pub async fn terminal_subscribe(
    registry: State<'_, Arc<Registry>>,
    id: String,
) -> Result<SubscribeResult, TerminalError> {
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    Ok(SubscribeResult {
        ring_snapshot: h.snapshot(),
        cols: 80,
        rows: 24,
        status: h.status(),
        exit_code: h.exit_code(),
    })
}

#[tauri::command]
pub async fn terminal_write(
    registry: State<'_, Arc<Registry>>,
    id: String,
    data: Vec<u8>,
) -> Result<(), TerminalError> {
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    h.write(&data)
}

#[tauri::command]
pub async fn terminal_resize(
    registry: State<'_, Arc<Registry>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), TerminalError> {
    let h = registry.get(&id).ok_or(TerminalError::NotFound(id))?;
    h.resize(cols, rows)
}

#[tauri::command]
pub async fn terminal_close(
    registry: State<'_, Arc<Registry>>,
    id: String,
) -> Result<(), TerminalError> {
    if let Some(h) = registry.remove(&id) {
        h.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_list(
    registry: State<'_, Arc<Registry>>,
    workspace_id: Option<String>,
) -> Result<Vec<TerminalSummary>, TerminalError> {
    Ok(registry.list_summaries(workspace_id.as_deref()))
}

fn resolve_shell(explicit: Option<String>) -> String {
    if let Some(s) = explicit.filter(|s| !s.is_empty()) {
        return s;
    }
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && Path::new(&s).exists() {
            return s;
        }
    }
    #[cfg(target_os = "macos")]
    { return "/bin/zsh".into(); }
    #[cfg(target_os = "linux")]
    { return "/bin/bash".into(); }
    #[cfg(target_os = "windows")]
    { return "powershell.exe".into(); }
}

fn canonicalize_cwd(cwd: &str, allowed_roots: &[String]) -> Result<PathBuf, TerminalError> {
    let raw = PathBuf::from(cwd);
    let canon = match raw.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // Fall back to home dir
            return dirs::home_dir().ok_or(TerminalError::CwdNotFound(cwd.to_string()));
        }
    };

    if allowed_roots.is_empty() {
        // Defensive: never allow arbitrary cwd if frontend didn't supply roots.
        return Err(TerminalError::CwdNotAllowed(cwd.to_string()));
    }

    let allowed: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|r| PathBuf::from(r).canonicalize().ok())
        .collect();

    let permitted = allowed.iter().any(|root| canon.starts_with(root))
        || dirs::home_dir().map(|h| canon == h).unwrap_or(false);

    if !permitted {
        return Err(TerminalError::CwdNotAllowed(cwd.to_string()));
    }

    Ok(canon)
}
```

- [ ] **Step 3: Add `uuid` and `dirs` deps if not already present**

Check `src-tauri/Cargo.toml`. `uuid` is likely present; `dirs` may be — search:

```bash
grep -E '^(uuid|dirs)\s*=' src-tauri/Cargo.toml
```

If missing, add under `[dependencies]`:

```toml
uuid = { version = "1", features = ["v7"] }
dirs = "5"
```

`thiserror` is also referenced; add if missing:

```toml
thiserror = "1"
```

- [ ] **Step 4: Run `pnpm rust:check`, fix any compile errors**

Run: `pnpm rust:check`
Expected: clean compile.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/terminal.rs src-tauri/src/commands/mod.rs
git commit -m "feat(terminal): Tauri commands (open/subscribe/write/resize/close/list)"
```

---

## Task 6: Wire commands into lib.rs + shutdown hook

**Files:**
- Modify: `src-tauri/src/lib.rs:286-310` (state registration) and the `generate_handler!` macro list around line 313

- [ ] **Step 1: Add state registration**

Locate the chain of `.manage(...)` calls (around line 286-310). Insert before the closing `.invoke_handler(...)`:

```rust
.manage(std::sync::Arc::new(crate::terminal::Registry::new()))
```

- [ ] **Step 2: Add commands to handler list**

In the `tauri::generate_handler![...]` block (around line 313), alphabetically with other `terminal_*` slot (after the last `team_*` command), add:

```rust
commands::terminal::terminal_open,
commands::terminal::terminal_subscribe,
commands::terminal::terminal_write,
commands::terminal::terminal_resize,
commands::terminal::terminal_close,
commands::terminal::terminal_list,
```

- [ ] **Step 3: Add shutdown hook**

Find the `tauri::Builder::default()...build(...)` chain. Locate the `.run(...)` call (or equivalent), and add a `RunEvent::ExitRequested` handler. Pattern (insert in the existing run-event match):

```rust
.run(|app_handle, event| {
    match event {
        tauri::RunEvent::ExitRequested { .. } => {
            if let Some(registry) = app_handle.try_state::<std::sync::Arc<crate::terminal::Registry>>() {
                registry.kill_all();
            }
        }
        _ => {}
    }
})
```

If a `run` closure already exists, merge the new arm into its existing match.

- [ ] **Step 4: Run `pnpm rust:check`**

Run: `pnpm rust:check`
Expected: clean compile.

- [ ] **Step 5: Smoke-test backend via Tauri dev**

Run: `pnpm tauri:dev` (manual, time-boxed to 60s). Open dev console, run:

```js
const id = (await window.__TAURI__.core.invoke("terminal_open", {
  workspaceId: "smoke", cwd: "/tmp", cols: 80, rows: 24, allowedRoots: ["/tmp"]
})).id;
await window.__TAURI__.event.listen(`terminal://${id}/data`, e => console.log(new TextDecoder().decode(new Uint8Array(e.payload))));
await window.__TAURI__.core.invoke("terminal_write", { id, data: Array.from(new TextEncoder().encode("echo hi\n")) });
```

Expected: console logs `hi` within 100 ms. Kill via `terminal_close`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(terminal): register state + commands + shutdown hook in lib.rs"
```

---

## Task 7: Frontend deps + client wrapper

**Files:**
- Modify: `packages/app/package.json`
- Create: `packages/app/src/lib/terminal/client.ts`

- [ ] **Step 1: Add npm deps**

Run:

```bash
pnpm --filter @teamclaw/app add @xterm/xterm@^5.5 @xterm/addon-fit@^0.10 @xterm/addon-web-links@^0.11
```

- [ ] **Step 2: Implement client wrapper**

`packages/app/src/lib/terminal/client.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TerminalStatus = "running" | "exited";

export interface OpenResult {
  id: string;
  shell: string;
  pid: number;
}

export interface SubscribeResult {
  ring_snapshot: number[];
  cols: number;
  rows: number;
  status: TerminalStatus;
  exit_code: number | null;
}

export interface TerminalSummary {
  id: string;
  shell: string;
  pid: number;
  status: TerminalStatus;
  exit_code: number | null;
}

export interface OpenParams {
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  allowedRoots: string[];
}

export async function openTerminal(p: OpenParams): Promise<OpenResult> {
  return invoke<OpenResult>("terminal_open", {
    workspaceId: p.workspaceId,
    cwd: p.cwd,
    cols: p.cols,
    rows: p.rows,
    shell: p.shell,
    allowedRoots: p.allowedRoots,
  });
}

export async function subscribeTerminal(id: string): Promise<SubscribeResult> {
  return invoke<SubscribeResult>("terminal_subscribe", { id });
}

export async function writeTerminal(id: string, data: Uint8Array): Promise<void> {
  await invoke("terminal_write", { id, data: Array.from(data) });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  await invoke("terminal_resize", { id, cols, rows });
}

export async function closeTerminal(id: string): Promise<void> {
  await invoke("terminal_close", { id });
}

export async function listTerminals(workspaceId?: string): Promise<TerminalSummary[]> {
  return invoke<TerminalSummary[]>("terminal_list", { workspaceId });
}

export async function onTerminalData(
  id: string,
  cb: (chunk: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<number[]>(`terminal://${id}/data`, e => {
    cb(new Uint8Array(e.payload));
  });
}

export async function onTerminalExit(
  id: string,
  cb: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<number | null>(`terminal://${id}/exit`, e => {
    cb(e.payload);
  });
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/app/package.json packages/app/pnpm-lock.yaml packages/app/src/lib/terminal/client.ts
git commit -m "feat(terminal): xterm npm deps + Tauri client wrappers"
```

---

## Task 8: Theme bridge

**Files:**
- Create: `packages/app/src/lib/terminal/theme.ts`

- [ ] **Step 1: Implement theme bridge**

`packages/app/src/lib/terminal/theme.ts`:

```ts
import type { ITheme } from "@xterm/xterm";

function readCssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

export function buildXtermTheme(): ITheme {
  return {
    background: readCssVar("--background", "#fbfaf7"),
    foreground: readCssVar("--foreground", "#1a1a14"),
    cursor: readCssVar("--coral", "#e85a4a"),
    cursorAccent: readCssVar("--background", "#fbfaf7"),
    selectionBackground: readCssVar("--selected", "#e7e2d6"),
    // ANSI 0-15 left as xterm defaults so terminal apps' own colors render unchanged.
  };
}

export function buildXtermFont(): { fontFamily: string; fontSize: number; lineHeight: number } {
  const mono = readCssVar("--font-mono", "JetBrains Mono, ui-monospace, Menlo, monospace");
  return { fontFamily: mono, fontSize: 12, lineHeight: 1.4 };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/lib/terminal/theme.ts
git commit -m "feat(terminal): theme bridge from globals.css tokens"
```

---

## Task 9: terminal-store with unit tests

**Files:**
- Create: `packages/app/src/stores/terminal-store.ts`
- Create: `packages/app/src/stores/__tests__/terminal-store.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/app/src/stores/__tests__/terminal-store.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";

vi.mock("@/lib/terminal/client", () => ({
  openTerminal: vi.fn(async () => ({ id: "tab-1", shell: "/bin/zsh", pid: 100 })),
  closeTerminal: vi.fn(async () => {}),
  listTerminals: vi.fn(async () => []),
}));

const seedTab = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  title: "zsh",
  pid: 100,
  shell: "/bin/zsh",
  cwd: "/tmp",
  status: "running" as const,
});

describe("terminal-store", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabsByWorkspace: {},
      activeTabByWorkspace: {},
      panelOpenByWorkspace: {},
      panelHeightByWorkspace: {},
    });
  });

  test("openTerminal appends a tab and sets it active", async () => {
    await useTerminalStore.getState().openTerminal("ws1", {
      cwd: "/tmp",
      allowedRoots: ["/tmp"],
    });
    const s = useTerminalStore.getState();
    expect(s.tabsByWorkspace["ws1"]?.length).toBe(1);
    expect(s.activeTabByWorkspace["ws1"]).toBe("tab-1");
  });

  test("togglePanel flips open/closed", () => {
    useTerminalStore.getState().togglePanel("ws1");
    expect(useTerminalStore.getState().panelOpenByWorkspace["ws1"]).toBe(true);
    useTerminalStore.getState().togglePanel("ws1");
    expect(useTerminalStore.getState().panelOpenByWorkspace["ws1"]).toBe(false);
  });

  test("renameTab updates title", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().renameTab("a", "build");
    expect(useTerminalStore.getState().tabsByWorkspace["ws1"][0].title).toBe("build");
  });

  test("closeTerminal removes tab and clears active when no remain", async () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
      activeTabByWorkspace: { ws1: "a" },
    });
    await useTerminalStore.getState().closeTerminal("a");
    const s = useTerminalStore.getState();
    expect(s.tabsByWorkspace["ws1"]).toEqual([]);
    expect(s.activeTabByWorkspace["ws1"]).toBeNull();
  });

  test("closeTerminal picks neighbor when closing active", async () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1"), seedTab("b", "ws1"), seedTab("c", "ws1")] },
      activeTabByWorkspace: { ws1: "b" },
    });
    await useTerminalStore.getState().closeTerminal("b");
    expect(useTerminalStore.getState().activeTabByWorkspace["ws1"]).toBe("a");
  });

  test("markExited updates status, keeps tab present", () => {
    useTerminalStore.setState({
      tabsByWorkspace: { ws1: [seedTab("a", "ws1")] },
    });
    useTerminalStore.getState().markExited("a", 0);
    const tab = useTerminalStore.getState().tabsByWorkspace["ws1"][0];
    expect(tab.status).toBe("exited");
    expect(tab.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect fail (store doesn't exist yet)**

Run: `pnpm test:unit -- terminal-store`
Expected: import error / fail.

- [ ] **Step 3: Implement store**

`packages/app/src/stores/terminal-store.ts`:

```ts
import { create } from "zustand";
import {
  closeTerminal as closeTerminalIpc,
  listTerminals,
  openTerminal as openTerminalIpc,
} from "@/lib/terminal/client";

export type TerminalTabId = string;

export interface TerminalTab {
  id: TerminalTabId;
  workspaceId: string;
  title: string;
  pid: number;
  shell: string;
  cwd: string;
  status: "running" | "exited";
  exitCode?: number;
  exitedAt?: number;
}

interface OpenOpts {
  cwd: string;
  shell?: string;
  allowedRoots: string[];
}

interface TerminalState {
  tabsByWorkspace: Record<string, TerminalTab[]>;
  activeTabByWorkspace: Record<string, TerminalTabId | null>;
  panelOpenByWorkspace: Record<string, boolean>;
  panelHeightByWorkspace: Record<string, number>;
}

interface TerminalActions {
  openTerminal(workspaceId: string, opts: OpenOpts): Promise<void>;
  closeTerminal(id: TerminalTabId): Promise<void>;
  setActiveTab(workspaceId: string, id: TerminalTabId): void;
  renameTab(id: TerminalTabId, title: string): void;
  togglePanel(workspaceId: string): void;
  setPanelHeight(workspaceId: string, px: number): void;
  hydrateForWorkspace(workspaceId: string): Promise<void>;
  markExited(id: TerminalTabId, code: number | null): void;
}

const HEIGHT_KEY = (ws: string) => `teamclaw.terminal.height.${ws}`;
const DEFAULT_HEIGHT = 240;

function loadHeight(workspaceId: string): number {
  if (typeof localStorage === "undefined") return DEFAULT_HEIGHT;
  const v = localStorage.getItem(HEIGHT_KEY(workspaceId));
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 120 ? n : DEFAULT_HEIGHT;
}

export const useTerminalStore = create<TerminalState & TerminalActions>((set, get) => ({
  tabsByWorkspace: {},
  activeTabByWorkspace: {},
  panelOpenByWorkspace: {},
  panelHeightByWorkspace: {},

  async openTerminal(workspaceId, opts) {
    const { id, shell, pid } = await openTerminalIpc({
      workspaceId,
      cwd: opts.cwd,
      cols: 80,
      rows: 24,
      shell: opts.shell,
      allowedRoots: opts.allowedRoots,
    });
    const tab: TerminalTab = {
      id,
      workspaceId,
      title: deriveTitle(shell),
      pid,
      shell,
      cwd: opts.cwd,
      status: "running",
    };
    set(state => {
      const existing = state.tabsByWorkspace[workspaceId] ?? [];
      return {
        tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: [...existing, tab] },
        activeTabByWorkspace: { ...state.activeTabByWorkspace, [workspaceId]: id },
        panelOpenByWorkspace: { ...state.panelOpenByWorkspace, [workspaceId]: true },
        panelHeightByWorkspace: state.panelHeightByWorkspace[workspaceId]
          ? state.panelHeightByWorkspace
          : { ...state.panelHeightByWorkspace, [workspaceId]: loadHeight(workspaceId) },
      };
    });
  },

  async closeTerminal(id) {
    const state = get();
    let owner: string | undefined;
    let index = -1;
    for (const [ws, tabs] of Object.entries(state.tabsByWorkspace)) {
      const i = tabs.findIndex(t => t.id === id);
      if (i >= 0) { owner = ws; index = i; break; }
    }
    if (!owner) return;
    await closeTerminalIpc(id).catch(() => {});

    const tabs = state.tabsByWorkspace[owner];
    const nextTabs = tabs.filter(t => t.id !== id);
    let nextActive: TerminalTabId | null = state.activeTabByWorkspace[owner] ?? null;
    if (nextActive === id) {
      nextActive = nextTabs.length === 0
        ? null
        : nextTabs[Math.max(0, index - 1)].id;
    }
    set({
      tabsByWorkspace: { ...state.tabsByWorkspace, [owner]: nextTabs },
      activeTabByWorkspace: { ...state.activeTabByWorkspace, [owner]: nextActive },
    });
  },

  setActiveTab(workspaceId, id) {
    set(state => ({
      activeTabByWorkspace: { ...state.activeTabByWorkspace, [workspaceId]: id },
    }));
  },

  renameTab(id, title) {
    set(state => {
      const out: Record<string, TerminalTab[]> = {};
      for (const [ws, tabs] of Object.entries(state.tabsByWorkspace)) {
        out[ws] = tabs.map(t => (t.id === id ? { ...t, title } : t));
      }
      return { tabsByWorkspace: out };
    });
  },

  togglePanel(workspaceId) {
    set(state => ({
      panelOpenByWorkspace: {
        ...state.panelOpenByWorkspace,
        [workspaceId]: !state.panelOpenByWorkspace[workspaceId],
      },
      panelHeightByWorkspace: state.panelHeightByWorkspace[workspaceId]
        ? state.panelHeightByWorkspace
        : { ...state.panelHeightByWorkspace, [workspaceId]: loadHeight(workspaceId) },
    }));
  },

  setPanelHeight(workspaceId, px) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(HEIGHT_KEY(workspaceId), String(px));
    }
    set(state => ({
      panelHeightByWorkspace: { ...state.panelHeightByWorkspace, [workspaceId]: px },
    }));
  },

  async hydrateForWorkspace(workspaceId) {
    const summaries = await listTerminals(workspaceId).catch(() => []);
    if (summaries.length === 0) return;
    set(state => {
      const existing = state.tabsByWorkspace[workspaceId] ?? [];
      const known = new Map(existing.map(t => [t.id, t]));
      const merged: TerminalTab[] = summaries.map(s => {
        const prev = known.get(s.id);
        return prev
          ? { ...prev, status: s.status, exitCode: s.exit_code ?? undefined }
          : {
              id: s.id,
              workspaceId,
              title: deriveTitle(s.shell),
              pid: s.pid,
              shell: s.shell,
              cwd: "",
              status: s.status,
              exitCode: s.exit_code ?? undefined,
            };
      });
      return {
        tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: merged },
        activeTabByWorkspace: state.activeTabByWorkspace[workspaceId]
          ? state.activeTabByWorkspace
          : { ...state.activeTabByWorkspace, [workspaceId]: merged[0]?.id ?? null },
      };
    });
  },

  markExited(id, code) {
    set(state => {
      const out: Record<string, TerminalTab[]> = {};
      for (const [ws, tabs] of Object.entries(state.tabsByWorkspace)) {
        out[ws] = tabs.map(t =>
          t.id === id
            ? { ...t, status: "exited", exitCode: code ?? undefined, exitedAt: Date.now() }
            : t,
        );
      }
      return { tabsByWorkspace: out };
    });
  },
}));

function deriveTitle(shell: string): string {
  const base = shell.split(/[\\/]/).pop() ?? "shell";
  return base.replace(/\.exe$/, "");
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test:unit -- terminal-store`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/stores/terminal-store.ts packages/app/src/stores/__tests__/terminal-store.test.ts
git commit -m "feat(terminal): terminal-store with TDD"
```

---

## Task 10: XtermInstance component (TDD)

**Files:**
- Create: `packages/app/src/components/terminal/XtermInstance.tsx`
- Create: `packages/app/src/components/terminal/__tests__/XtermInstance.test.tsx`

- [ ] **Step 1: Write failing test**

`packages/app/src/components/terminal/__tests__/XtermInstance.test.tsx`:

```tsx
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const subscribeMock = vi.fn(async () => ({
  ring_snapshot: [104, 105, 10], // "hi\n"
  cols: 80,
  rows: 24,
  status: "running",
  exit_code: null,
}));
const onDataMock = vi.fn(async () => () => {});
const onExitMock = vi.fn(async () => () => {});
const resizeMock = vi.fn(async () => {});
const writeMock = vi.fn(async () => {});
const closeMock = vi.fn(async () => {});

vi.mock("@/lib/terminal/client", () => ({
  subscribeTerminal: subscribeMock,
  onTerminalData: onDataMock,
  onTerminalExit: onExitMock,
  resizeTerminal: resizeMock,
  writeTerminal: writeMock,
  closeTerminal: closeMock,
}));

const xtermWriteMock = vi.fn();
const xtermDisposeMock = vi.fn();

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: xtermWriteMock,
    dispose: xtermDisposeMock,
    loadAddon: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    focus: vi.fn(),
    options: {},
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

import { XtermInstance } from "@/components/terminal/XtermInstance";

describe("XtermInstance", () => {
  beforeEach(() => {
    subscribeMock.mockClear();
    xtermWriteMock.mockClear();
    xtermDisposeMock.mockClear();
    closeMock.mockClear();
  });

  afterEach(() => cleanup());

  test("on mount: subscribes and replays ring", async () => {
    render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    expect(subscribeMock).toHaveBeenCalledWith("t1");
    // ring replay
    expect(xtermWriteMock).toHaveBeenCalled();
  });

  test("on unmount: disposes xterm but does NOT call terminal_close", async () => {
    const { unmount } = render(<XtermInstance tabId="t1" active />);
    await new Promise(r => setTimeout(r, 0));
    unmount();
    expect(xtermDisposeMock).toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `pnpm test:unit -- XtermInstance`
Expected: cannot resolve component.

- [ ] **Step 3: Implement component**

`packages/app/src/components/terminal/XtermInstance.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import {
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  subscribeTerminal,
  writeTerminal,
} from "@/lib/terminal/client";
import { buildXtermFont, buildXtermTheme } from "@/lib/terminal/theme";
import { useTerminalStore } from "@/stores/terminal-store";

interface Props {
  tabId: string;
  active: boolean;
}

export function XtermInstance({ tabId, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const markExited = useTerminalStore(s => s.markExited);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let onDataDisposer: { dispose: () => void } | null = null;
    let onResizeDisposer: { dispose: () => void } | null = null;
    let cancelled = false;

    const font = buildXtermFont();
    const term = new Terminal({
      theme: buildXtermTheme(),
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      lineHeight: font.lineHeight,
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    (async () => {
      try {
        const { ring_snapshot } = await subscribeTerminal(tabId);
        if (cancelled) return;
        if (ring_snapshot.length > 0) {
          term.write(new Uint8Array(ring_snapshot));
        }
        const dims = fit.proposeDimensions();
        if (dims) await resizeTerminal(tabId, dims.cols, dims.rows);

        unlistenData = await onTerminalData(tabId, chunk => {
          term.write(chunk);
        });
        unlistenExit = await onTerminalExit(tabId, code => {
          markExited(tabId, code);
        });
        onDataDisposer = term.onData(d => {
          writeTerminal(tabId, new TextEncoder().encode(d)).catch(() => {});
        });
        onResizeDisposer = term.onResize(({ cols, rows }) => {
          resizeTerminal(tabId, cols, rows).catch(() => {});
        });
      } catch (err) {
        console.warn(`[terminal] subscribe failed for ${tabId}`, err);
      }
    })();

    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onWindowResize);
      unlistenData?.();
      unlistenExit?.();
      onDataDisposer?.dispose();
      onResizeDisposer?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tabId, markExited]);

  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus();
      fitRef.current?.fit();
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: active ? "block" : "none" }}
    />
  );
}
```

- [ ] **Step 4: Run, expect pass**

Run: `pnpm test:unit -- XtermInstance`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/terminal/XtermInstance.tsx packages/app/src/components/terminal/__tests__/XtermInstance.test.tsx
git commit -m "feat(terminal): XtermInstance component (TDD)"
```

---

## Task 11: TerminalTabBar

**Files:**
- Create: `packages/app/src/components/terminal/TerminalTabBar.tsx`

- [ ] **Step 1: Implement component**

```tsx
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/stores/terminal-store";

interface Props {
  workspaceId: string;
  workspacePath: string;
  allowedRoots: string[];
}

export function TerminalTabBar({ workspaceId, workspacePath, allowedRoots }: Props) {
  const { t } = useTranslation();
  const tabs = useTerminalStore(s => s.tabsByWorkspace[workspaceId] ?? []);
  const activeId = useTerminalStore(s => s.activeTabByWorkspace[workspaceId] ?? null);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const closeTerminal = useTerminalStore(s => s.closeTerminal);
  const setActiveTab = useTerminalStore(s => s.setActiveTab);

  return (
    <div className="flex items-center gap-1 border-b border-border bg-panel px-2 py-1">
      <span className="mr-2 text-[11px] uppercase tracking-wide text-faint">
        {t("terminal.label", "Terminal")}
      </span>
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(workspaceId, tab.id)}
          className={cn(
            "group flex items-center gap-1 rounded px-2 py-0.5 text-[12px]",
            tab.id === activeId
              ? "bg-selected text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
            tab.status === "exited" && "italic opacity-60",
          )}
        >
          <span className="font-mono">{tab.title}</span>
          {tab.status === "exited" && tab.exitCode !== undefined && (
            <span className="text-[10px] text-faint">({tab.exitCode})</span>
          )}
          <span
            role="button"
            tabIndex={-1}
            onClick={e => {
              e.stopPropagation();
              void closeTerminal(tab.id);
            }}
            className="ml-1 rounded p-0.5 opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
            title={t("terminal.closeTab", "Close terminal")}
          >
            <X className="h-3 w-3" />
          </span>
        </button>
      ))}
      <button
        onClick={() =>
          openTerminal(workspaceId, { cwd: workspacePath, allowedRoots })
        }
        className="ml-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={t("terminal.newTab", "New terminal")}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/components/terminal/TerminalTabBar.tsx
git commit -m "feat(terminal): TerminalTabBar with + / × controls"
```

---

## Task 12: TerminalPanel (split + drag resize)

**Files:**
- Create: `packages/app/src/components/terminal/TerminalPanel.tsx`

- [ ] **Step 1: Implement component**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalStore } from "@/stores/terminal-store";
import { TerminalTabBar } from "./TerminalTabBar";
import { XtermInstance } from "./XtermInstance";

interface Props {
  workspaceId: string;
  workspacePath: string;
  allowedRoots: string[];
}

const MIN_HEIGHT = 120;
const MIN_PARENT_RESERVED = 200;

export function TerminalPanel({ workspaceId, workspacePath, allowedRoots }: Props) {
  const tabs = useTerminalStore(s => s.tabsByWorkspace[workspaceId] ?? []);
  const activeId = useTerminalStore(s => s.activeTabByWorkspace[workspaceId] ?? null);
  const heightPx = useTerminalStore(
    s => s.panelHeightByWorkspace[workspaceId] ?? 240,
  );
  const setPanelHeight = useTerminalStore(s => s.setPanelHeight);
  const hydrate = useTerminalStore(s => s.hydrateForWorkspace);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const startHeight = useRef(heightPx);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void hydrate(workspaceId);
  }, [workspaceId, hydrate]);

  useEffect(() => {
    if (tabs.length === 0) {
      void openTerminal(workspaceId, { cwd: workspacePath, allowedRoots });
    }
  }, [tabs.length, workspaceId, workspacePath, allowedRoots, openTerminal]);

  const onDragMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      startY.current = e.clientY;
      startHeight.current = heightPx;
    },
    [heightPx],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dy = startY.current - e.clientY;
      const parent = containerRef.current?.parentElement;
      const parentHeight = parent?.clientHeight ?? 800;
      const next = Math.max(
        MIN_HEIGHT,
        Math.min(parentHeight - MIN_PARENT_RESERVED, startHeight.current + dy),
      );
      setPanelHeight(workspaceId, next);
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging, setPanelHeight, workspaceId]);

  return (
    <div
      ref={containerRef}
      style={{ height: heightPx }}
      className="flex shrink-0 flex-col border-t border-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        onMouseDown={onDragMouseDown}
        className="h-1 cursor-row-resize bg-transparent hover:bg-border-soft"
      />
      <TerminalTabBar
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        allowedRoots={allowedRoots}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-paper">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ visibility: tab.id === activeId ? "visible" : "hidden" }}
          >
            <XtermInstance tabId={tab.id} active={tab.id === activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/components/terminal/TerminalPanel.tsx
git commit -m "feat(terminal): TerminalPanel with split + drag resize"
```

---

## Task 13: ChatPanel integration

**Files:**
- Modify: `packages/app/src/components/chat/ChatPanel.tsx`

- [ ] **Step 1: Import TerminalPanel**

Near the other component imports at the top of `ChatPanel.tsx`:

```tsx
import { TerminalPanel } from "@/components/terminal/TerminalPanel";
import { useTerminalStore } from "@/stores/terminal-store";
```

- [ ] **Step 2: Read terminal panel state**

Inside the `ChatPanel` function body, alongside other store reads:

```tsx
const currentWorkspaceId = useWorkspaceStore(s => s.workspacePath ?? "");
const workspacePath = useWorkspaceStore(s => s.workspacePath);
const terminalOpen = useTerminalStore(
  s => Boolean(currentWorkspaceId && s.panelOpenByWorkspace[currentWorkspaceId]),
);
```

(If `workspacePath` is already destructured from the workspace store elsewhere in the file, reuse it.)

- [ ] **Step 3: Render `<TerminalPanel>` below the input area**

Find the JSX block that renders `ChatInputArea` (around line 1466 — `attachedFiles={attachedFiles}`). Immediately after the closing tag of the wrapper containing `ChatInputArea`, add:

```tsx
{terminalOpen && workspacePath && (
  <TerminalPanel
    workspaceId={workspacePath}
    workspacePath={workspacePath}
    allowedRoots={[workspacePath]}
  />
)}
```

- [ ] **Step 4: Verify build**

Run: `pnpm typecheck`
Expected: pass.

Run: `pnpm dev` (or `pnpm tauri:dev`) manually; confirm the terminal panel appears at the bottom of ChatPanel when `togglePanel` is invoked from the devtools console:

```js
useTerminalStore.getState().togglePanel(useWorkspaceStore.getState().workspacePath);
```

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/chat/ChatPanel.tsx
git commit -m "feat(terminal): mount TerminalPanel in ChatPanel bottom split"
```

---

## Task 14: Header icon + keyboard shortcuts

**Files:**
- Modify: `packages/app/src/App.tsx`

- [ ] **Step 1: Import icon and store**

In the imports block at the top of `App.tsx`:

```tsx
import { TerminalSquare } from "lucide-react";
import { useTerminalStore } from "@/stores/terminal-store";
```

- [ ] **Step 2: Add a small TerminalToggleButton component**

Hooks cannot live inside a JSX IIFE — extract a tiny component. Just above the JSX that renders the header buttons (e.g., near where `HeaderPanelTab` is defined or imported in `App.tsx`), add:

```tsx
function TerminalToggleButton({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const terminalOpen = useTerminalStore(
    s => Boolean(s.panelOpenByWorkspace[workspacePath]),
  );
  const togglePanel = useTerminalStore(s => s.togglePanel);
  return (
    <button
      className={cn(
        "ml-1 rounded p-1 transition-colors hover:bg-muted hover:text-foreground",
        terminalOpen ? "bg-muted text-foreground" : "text-muted-foreground",
      )}
      onClick={() => togglePanel(workspacePath)}
      title={t("terminal.toggle", "Toggle terminal (⌃`)")}
    >
      <TerminalSquare className="h-4 w-4" />
    </button>
  );
}
```

Then locate the `AppWindow` button block ending around line 1503. **Immediately after the closing parenthesis of that conditional** (after `)}` on line 1504), insert:

```tsx
{showWorkspaceContext && currentWorkspacePath && (
  <TerminalToggleButton workspacePath={currentWorkspacePath} />
)}
```

Note: `showWorkspaceContext` and `currentWorkspacePath` are placeholder names — adapt to the exact identifiers already used by surrounding header conditionals in `App.tsx` (likely `hasWorkspace` / `workspacePath`). Keep the structure identical.

- [ ] **Step 3: Add `useTerminalShortcuts` hook**

Below the existing `useWebviewShortcuts` definition (around line 231), add:

```tsx
function useTerminalShortcuts() {
  const togglePanel = useTerminalStore(s => s.togglePanel);
  const openTerminal = useTerminalStore(s => s.openTerminal);
  const closeTerminal = useTerminalStore(s => s.closeTerminal);
  const workspacePath = useWorkspaceStore(s => s.workspacePath);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!workspacePath) return;
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl + ` (backtick) — toggle terminal panel
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        togglePanel(workspacePath);
        return;
      }

      // Only act on Cmd+T / Cmd+W when focus is inside a terminal viewport.
      const focused = document.activeElement;
      const inTerminal = focused?.closest?.(".xterm") != null;
      if (!inTerminal) return;

      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void openTerminal(workspacePath, {
          cwd: workspacePath,
          allowedRoots: [workspacePath],
        });
        return;
      }

      if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        const state = useTerminalStore.getState();
        const activeId = state.activeTabByWorkspace[workspacePath];
        if (activeId) void closeTerminal(activeId);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspacePath, togglePanel, openTerminal, closeTerminal]);
}
```

- [ ] **Step 4: Call hook in App**

Inside the top-level `App` (or the component that calls `useWebviewShortcuts`), add the call:

```tsx
useTerminalShortcuts();
```

- [ ] **Step 5: Verify build**

Run: `pnpm typecheck && pnpm lint`
Expected: pass.

- [ ] **Step 6: Manual smoke test**

Run `pnpm tauri:dev`:
1. Open a workspace.
2. Click `TerminalSquare` icon — panel appears, a tab opens, prompt visible.
3. Type `pwd` + Enter — prints workspace path.
4. Press `⌃` + `` ` `` — panel hides.
5. Press `⌃` + `` ` `` again — panel shows, scrollback preserved.
6. With terminal focused, `⌘ + T` — second tab.
7. `⌘ + W` — active tab closes; neighbor activates.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/App.tsx
git commit -m "feat(terminal): header icon + Ctrl+\` / Cmd+T / Cmd+W shortcuts"
```

---

## Task 15: i18n entries

**Files:**
- Modify: `packages/app/src/locales/en.json`
- Modify: `packages/app/src/locales/zh-CN.json`

- [ ] **Step 1: Add English keys**

In `packages/app/src/locales/en.json`, alongside other namespaces, add:

```json
"terminal": {
  "label": "Terminal",
  "toggle": "Toggle terminal (⌃`)",
  "newTab": "New terminal",
  "closeTab": "Close terminal",
  "rename": "Rename",
  "exited": "Process exited (code {{code}}) — press Enter to restart",
  "spawnFailed": "Failed to start shell: {{message}}",
  "cwdFallback": "Workspace cwd unavailable, using home directory"
}
```

- [ ] **Step 2: Add Chinese keys**

In `packages/app/src/locales/zh-CN.json`, mirror with:

```json
"terminal": {
  "label": "终端",
  "toggle": "切换终端 (⌃`)",
  "newTab": "新建终端",
  "closeTab": "关闭终端",
  "rename": "重命名",
  "exited": "进程已退出 (code {{code}}) — 按 Enter 重启",
  "spawnFailed": "启动 shell 失败:{{message}}",
  "cwdFallback": "workspace 路径不可用,已回退到 home"
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm typecheck`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/locales/en.json packages/app/src/locales/zh-CN.json
git commit -m "feat(terminal): i18n entries (en + zh-CN)"
```

---

## Task 16: E2E smoke test

**Files:**
- Create: `tests/e2e/terminal-smoke.test.ts`

- [ ] **Step 1: Implement smoke test**

`tests/e2e/terminal-smoke.test.ts`:

```ts
import { test, expect } from "vitest";
import { spawnTauriMcpClient } from "./helpers/tauri-mcp";

test.runIf(process.platform === "darwin")(
  "integrated terminal smoke",
  async () => {
    const client = await spawnTauriMcpClient();

    // 1. Open workspace, ensure ChatPanel visible.
    await client.openWorkspace("/tmp/teamclaw-terminal-e2e");

    // 2. Click TerminalSquare icon in chat header.
    await client.clickByTitle("Toggle terminal (⌃`)");

    // 3. Wait for an xterm canvas to render.
    await client.waitFor(".xterm-screen", { timeout: 4000 });

    // 4. Type `pwd` + Enter into focused xterm.
    await client.type("pwd\n");

    // 5. Read scrollback; expect workspace path.
    const text = await client.readTerminalText();
    expect(text).toContain("/tmp/teamclaw-terminal-e2e");

    // 6. Press Ctrl+` → panel hidden.
    await client.key("Control+Backquote");
    await client.expectGone(".xterm-screen");

    // 7. Press Ctrl+` again → reattach replays scrollback.
    await client.key("Control+Backquote");
    await client.waitFor(".xterm-screen");
    const after = await client.readTerminalText();
    expect(after).toContain("/tmp/teamclaw-terminal-e2e");

    await client.close();
  },
  60_000,
);
```

(The exact helper names — `openWorkspace`, `clickByTitle`, `readTerminalText` — must match the existing `tests/e2e/helpers/*` API. Inspect `tests/e2e/helpers/` before writing; rename calls if helper names differ. If a helper does not exist, add it to the existing helpers file in the same commit.)

- [ ] **Step 2: Run E2E suite on macOS**

Run: `pnpm test:e2e:smoke -- terminal-smoke`
Expected: pass on macOS, skipped on Linux.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/terminal-smoke.test.ts
git commit -m "test(terminal): E2E smoke (toggle, pwd, hide/show replay)"
```

---

## Task 17: Final integration check

**Files:** none modified

- [ ] **Step 1: Full test suite**

Run in parallel:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

Expected: all green.

- [ ] **Step 2: Manual UX pass**

Run `pnpm tauri:build:debug`, install the binary, then walk through:

1. Open a workspace.
2. Toggle terminal via icon and via `Ctrl+\``.
3. Open second tab; switch between them.
4. Drag the splitter — height persists across toggle.
5. `pnpm install` and verify output streams without dropping.
6. Switch to another workspace, switch back — buffer intact, prompt re-focuses.
7. Type `exit` in shell — tab shows `(0)` exit code, stays present.
8. Close the app — no zombie shell processes (`ps -ef | grep zsh`).

- [ ] **Step 3: Done**

No commit needed. If issues found, file follow-up tasks; do not silently extend this plan.

---

## Open Risks / Watch Items

- **Tauri event payload encoding.** Tauri v2 should accept `Vec<u8>` payloads as raw bytes. If the wire format ends up being JSON arrays, the data event size doubles — confirm in Task 6 smoke test and adjust client.ts if needed.
- **`workspacePath` as workspaceId.** This plan uses `workspacePath` (a string) as the workspace identity key. If the project later introduces a stable workspace UUID, terminal-store buckets must migrate accordingly. Documented as a v2 follow-up.
- **xterm.js bundle size.** ~200 KB gzipped. Acceptable for v1; if frontend bundle budget tightens, consider lazy-importing the terminal subsystem only when `togglePanel` first fires.
- **macOS Sequoia PTY race.** A known portable-pty workaround `pty_fork_safety_check` is sometimes needed on newer macOS — surface if integration tests in Task 3 hang.
