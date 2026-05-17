# Cron → amuxd Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace cron's OpenCode HTTP integration with a Unix-socket integration to amuxd. Cron-triggered prompts run on the local amuxd's primary agent runtime via a new `prompt-await` socket command. OpenCode-specific code in cron is deleted.

**Architecture:** New JSON command on `amuxd.sock`: `{cmd: "prompt-await", session_key, message, working_directory?, model_override?, timeout_secs?}`. amuxd creates an ACP session per cron `session_key` (one per run), runs the turn via existing `send_prompt_and_await_reply`, returns final reply text. Cron-side replaces `create_opencode_session` + `send_to_opencode` with a single async sock round-trip helper.

**Tech Stack:** Rust 2024, tokio (`tokio::net::UnixStream` async on cron side; existing tokio sync primitives on amuxd side), serde_json, Cargo workspace.

**Source spec:** `docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md`

---

## File Map

**New files:**

| Path | Purpose |
|---|---|
| `apps/desktop/src/commands/cron/amuxd_client.rs` | Async sock client (`prompt_await`) + JSON envelope types + unit tests |

**Modified files:**

| Path | Change |
|---|---|
| `apps/daemon/src/daemon/server.rs` | Add `SockCommand::PromptAwait` variant; sock-listener `cmd: "prompt-await"` dispatch; main-loop arm (with `tokio::spawn` for panic isolation); `handle_prompt_await` method; `cron_sessions: HashMap<String, String>` field on `DaemonServer`; unit tests for `parse_prompt_await_payload` and `handle_prompt_await` |
| `apps/desktop/src/commands/gateway/mod.rs` | Promote `fn sock_path()` from private to `pub(crate)` so cron can reuse it |
| `apps/desktop/src/commands/cron/mod.rs` | Register `pub mod amuxd_client;` |
| `apps/desktop/src/commands/cron/scheduler.rs` | Remove all OpenCode-specific code (8 helpers + the `opencode_port` field + setter); rewrite `execute_job` Session-Strategy block to use `amuxd_client::prompt_await`; simplify `reconcile_interrupted_runs` to always pass `assistant_text=None`; existing tests stay green |
| `apps/desktop/src/lib.rs` (or wherever `set_port` is called) | Remove `cron_scheduler.set_port(...)` call sites |

**Deleted (no separate file removal — these are functions inside `scheduler.rs`):**

- `create_opencode_session`
- `send_to_opencode`
- `extract_text_parts`
- `find_existing_session`
- `delivery_to_session_key`
- `store_session`
- `check_session_archived`
- `fetch_last_completed_assistant_text_since`
- `extract_completed_assistant_text_for_cron_run`
- Constant `OPENCODE_CONNECT_TIMEOUT_SECS`
- Field `opencode_port: Arc<RwLock<u16>>`
- Setter `pub async fn set_port(&self, port: u16)`

---

## Phase 1 — amuxd: new socket command

### Task 1: Pure-function payload parser + tests

**Files:**
- Modify: `apps/daemon/src/daemon/server.rs` (add module-level fn + `#[cfg(test)] mod tests` section if not present)

The handler needs payload validation and session-key prefix enforcement. Extracting that to a pure function makes it unit-testable without spinning up a `DaemonServer` or `RuntimeManager`.

- [ ] **Step 1: Write the failing test**

Add this block at the bottom of `apps/daemon/src/daemon/server.rs`, inside the existing `#[cfg(test)] mod tests` if it exists, or create a fresh one:

```rust
#[cfg(test)]
mod prompt_await_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_rejects_missing_session_key() {
        let p = json!({ "message": "hi" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(err.to_string().contains("session_key"), "got: {err}");
    }

    #[test]
    fn parse_rejects_non_cron_session_key() {
        let p = json!({ "session_key": "wecom/x/y", "message": "hi" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(err.to_string().contains("must start with 'cron/'"), "got: {err}");
    }

    #[test]
    fn parse_rejects_empty_message() {
        let p = json!({ "session_key": "cron/j1/r1", "message": "" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(err.to_string().contains("message"), "got: {err}");
    }

    #[test]
    fn parse_accepts_minimal_valid_payload() {
        let p = json!({ "session_key": "cron/j1/r1", "message": "hello" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.session_key, "cron/j1/r1");
        assert_eq!(parsed.message, "hello");
        assert!(parsed.working_directory.is_none());
        assert!(parsed.model_override.is_none());
        assert_eq!(parsed.timeout_secs, 300);
    }

    #[test]
    fn parse_accepts_full_payload() {
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hello",
            "working_directory": "/tmp/wt",
            "model_override": { "provider": "anthropic", "model": "sonnet" },
            "timeout_secs": 120
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.working_directory.as_deref(), Some("/tmp/wt"));
        assert_eq!(parsed.model_override.as_ref().map(|m| m.0.as_str()), Some("anthropic"));
        assert_eq!(parsed.model_override.as_ref().map(|m| m.1.as_str()), Some("sonnet"));
        assert_eq!(parsed.timeout_secs, 120);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml -p amuxd prompt_await_tests 2>&1 | tail -20
```

Expected: FAIL — `parse_prompt_await_payload` not defined.

> Note: The amuxd crate lives in the daemon, not the desktop workspace. The actual command is `cargo test --manifest-path apps/daemon/Cargo.toml prompt_await_tests`. Run `cargo metadata --no-deps --manifest-path apps/daemon/Cargo.toml | head -5` first to confirm the crate path; if `apps/daemon/Cargo.toml` exists, use that. Otherwise the daemon may be part of a workspace at `apps/daemon/` — try `cargo test -p amuxd prompt_await_tests` from repo root.

- [ ] **Step 3: Write the implementation**

Add this near the top of `apps/daemon/src/daemon/server.rs` (next to `parse_binding_to_target`, around line 3013):

```rust
#[derive(Debug)]
pub(crate) struct PromptAwaitPayload<'a> {
    pub session_key: &'a str,
    pub message: &'a str,
    pub working_directory: Option<&'a str>,
    pub model_override: Option<(String, String)>,
    pub timeout_secs: u64,
}

pub(crate) fn parse_prompt_await_payload(
    payload: &serde_json::Value,
) -> anyhow::Result<PromptAwaitPayload<'_>> {
    let session_key = payload
        .get("session_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("prompt-await: missing 'session_key'"))?;
    if !session_key.starts_with("cron/") {
        anyhow::bail!("prompt-await: session_key must start with 'cron/' (got {session_key:?})");
    }
    let message = payload
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("prompt-await: missing 'message'"))?;
    if message.is_empty() {
        anyhow::bail!("prompt-await: 'message' must not be empty");
    }
    let working_directory = payload
        .get("working_directory")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let model_override = payload
        .get("model_override")
        .and_then(|v| v.as_object())
        .and_then(|m| {
            let p = m.get("provider").and_then(|v| v.as_str())?;
            let mo = m.get("model").and_then(|v| v.as_str())?;
            Some((p.to_string(), mo.to_string()))
        });
    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(300)
        .clamp(1, 600);

    Ok(PromptAwaitPayload {
        session_key,
        message,
        working_directory,
        model_override,
        timeout_secs,
    })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cargo test -p amuxd prompt_await_tests 2>&1 | tail -10
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/daemon/server.rs
git commit -m "$(cat <<'EOF'
feat(amuxd): parse_prompt_await_payload + tests

Pure validation function: requires session_key with 'cron/' prefix,
non-empty message; accepts optional working_directory, model_override,
timeout_secs (clamped 1..=600, default 300).

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

### Task 2: Add `SockCommand::PromptAwait` variant + listener dispatch

**Files:**
- Modify: `apps/daemon/src/daemon/server.rs` (enum `SockCommand` around line 67, listener around line 3099)

- [ ] **Step 1: Add the enum variant**

In `apps/daemon/src/daemon/server.rs`, find the `enum SockCommand { ... }` block (around line 67). Add a new variant right after `McpSend`:

```rust
/// Drive one ACP turn to completion for a cron-style logical session.
/// `payload` is the raw JSON envelope; `handle_prompt_await` parses it
/// and runs the turn against the local primary agent. `reply_tx`
/// receives a single line of JSON (`{ "ok": true, "result": { "text": ..., "acp_session_id": ... }}` or
/// `{ "ok": false, "error": ... }`).
PromptAwait {
    payload: serde_json::Value,
    reply_tx: oneshot::Sender<String>,
},
```

- [ ] **Step 2: Add listener-side dispatch**

In `apps/daemon/src/daemon/server.rs`, find the JSON envelope branch in `spawn_sock_listener` (around line 3099 where `cmd == "mcp-send"` is checked). Right after the `mcp-send` block (around line 3131), add an `else if` for `prompt-await`:

```rust
} else if cmd == "prompt-await" {
    let (reply_tx, reply_rx) = oneshot::channel();
    if tx
        .send(SockCommand::PromptAwait {
            payload: v,
            reply_tx,
        })
        .await
        .is_err()
    {
        return;
    }
    match reply_rx.await {
        Ok(body) => {
            let mut stream = reader.into_inner();
            if let Err(e) = stream.write_all(body.as_bytes()).await {
                warn!("amuxd.sock: prompt-await write failed: {e}");
                return;
            }
            let _ = stream.write_all(b"\n").await;
            let _ = stream.shutdown().await;
        }
        Err(_) => {
            warn!("amuxd.sock: prompt-await reply dropped");
        }
    }
} else {
```

(The dangling `} else {` chains into the existing "unknown JSON cmd" warn arm.)

- [ ] **Step 3: Verify it compiles (no handler yet → main-loop arm comes in Task 4)**

```bash
cargo check -p amuxd 2>&1 | tail -10
```

Expected: error — `non-exhaustive patterns: SockCommand::PromptAwait` in the main loop match. That's expected; Task 4 adds the arm.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/daemon/server.rs
git commit -m "$(cat <<'EOF'
feat(amuxd): SockCommand::PromptAwait variant + listener dispatch

Listener routes `cmd: "prompt-await"` JSON envelopes to the main loop.
Main-loop handler comes in next commit.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

### Task 3: Add `cron_sessions` map field on `DaemonServer`

**Files:**
- Modify: `apps/daemon/src/daemon/server.rs` (struct `DaemonServer` around line 30, `new` constructor around line 98)

- [ ] **Step 1: Add the field**

In `apps/daemon/src/daemon/server.rs`, find the `pub struct DaemonServer` block. Add a new field near the existing ones:

```rust
pub struct DaemonServer {
    // ... existing fields ...
    /// Maps cron's logical `session_key` (e.g. `"cron/<job_id>/<run_id>"`) to
    /// the acp_session_id of a live agent spawned for that key. With the
    /// current "per-run new session" cron semantics, every prompt-await call
    /// hits the "absent → create" branch, but the lookup-first shape stays
    /// so future code can adopt session reuse without changing the handler.
    cron_sessions: std::collections::HashMap<String, String>,
}
```

- [ ] **Step 2: Initialize in `new`**

In the `DaemonServer::new` constructor (around line 98), find the `Ok(Self { ... })` block at the end and add:

```rust
cron_sessions: std::collections::HashMap::new(),
```

- [ ] **Step 3: Verify compile**

```bash
cargo check -p amuxd 2>&1 | tail -5
```

Expected: same error as Task 2 (the PromptAwait main-loop arm is still missing). No new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/daemon/server.rs
git commit -m "$(cat <<'EOF'
feat(amuxd): cron_sessions map on DaemonServer

Tracks session_key → acp_session_id for prompt-await. Lookup-first
shape preserved for future session-reuse paths even though current cron
semantics always insert.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

### Task 4: Implement `handle_prompt_await` + main-loop dispatch

**Files:**
- Modify: `apps/daemon/src/daemon/server.rs` (add method, add main-loop match arm around line 696)

- [ ] **Step 1: Add the handler method**

In `apps/daemon/src/daemon/server.rs`, add a new method on `impl DaemonServer` near `handle_mcp_send` (around line 366):

```rust
/// Drive one ACP turn to completion for a cron-style session_key. Looks up
/// (or creates) an ACP session in `cron_sessions`, calls
/// `RuntimeManager::send_prompt_and_await_reply`, and returns
/// `{text, acp_session_id}` for the listener to wrap in the
/// `{ok, result|error}` envelope.
async fn handle_prompt_await(
    &mut self,
    payload: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let parsed = parse_prompt_await_payload(payload)?;

    // Look up or create the ACP session for this cron session_key.
    let acp_sid: String = if let Some(existing) = self.cron_sessions.get(parsed.session_key) {
        existing.clone()
    } else {
        // Confirm we have a local primary agent runtime.
        let runtime_count = self.agents.lock().await.agent_count();
        if runtime_count == 0 {
            anyhow::bail!("no local agent runtime");
        }

        let mut mgr = self.agents.lock().await;
        let sid = mgr
            .create_gateway_session_with_model(
                &self.team_id,
                parsed.session_key,                              // logical id
                &format!("cron://{}", parsed.session_key),       // binding
                "cron",                                          // title (display only)
                parsed.model_override.clone(),
                None,                                            // supabase_session_id — cron does not bind to a chat session
            )
            .await
            .map_err(|e| anyhow::anyhow!("spawn failed: {e}"))?;
        drop(mgr);

        // If a working_directory was provided, the cron spec is to spawn the
        // agent there. `create_gateway_session_with_model` currently writes a
        // throwaway `/tmp/amuxd-gateway-<uuid>` and ignores any caller-supplied
        // path. Honoring `working_directory` requires extending that fn's
        // signature; if Task 4a is in scope, do it; otherwise treat the
        // mismatch as a known limitation and log it.
        if let Some(wd) = parsed.working_directory {
            tracing::warn!(
                session_key = parsed.session_key,
                working_directory = wd,
                "prompt-await: working_directory ignored — create_gateway_session_with_model does not yet accept it; Task 4a extends the signature"
            );
        }

        self.cron_sessions.insert(parsed.session_key.to_string(), sid.clone());
        sid
    };

    // Drive the turn.
    let text = {
        let mut mgr = self.agents.lock().await;
        mgr.send_prompt_and_await_reply(&acp_sid, parsed.message)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
    };

    Ok(serde_json::json!({
        "text": text,
        "acp_session_id": acp_sid,
    }))
}
```

> Caveat documented in the code: `working_directory` is not yet honored by `create_gateway_session_with_model`. Task 4a extends the runtime manager signature. If the implementer prefers to skip Task 4a (worktree mode is a non-default cron feature), they should remove `working_directory` from `PromptAwaitPayload` and update tests to match — but that's a scope expansion, not the planned path. Default course: do Task 4a.

- [ ] **Step 2: Add main-loop dispatch arm**

In `apps/daemon/src/daemon/server.rs`, find the `match sock_cmd { ... }` block in the main loop (around line 685). Right after the `SockCommand::McpSend` arm (around line 702), add:

```rust
Some(SockCommand::PromptAwait { payload, reply_tx }) => {
    // Run handler under `tokio::spawn` so a panic inside the ACP runtime
    // (or any path the handler touches) does NOT take down the daemon.
    // JoinError caught and converted to a clean error envelope.
    let me = self_shared.clone();   // see Step 3 below
    let handle = tokio::spawn(async move {
        let mut me = me.lock().await;
        me.handle_prompt_await(&payload).await
    });
    let resp = match handle.await {
        Ok(Ok(v)) => serde_json::json!({ "ok": true, "result": v }),
        Ok(Err(e)) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        Err(join_err) => serde_json::json!({
            "ok": false,
            "error": format!("internal amuxd panic: {join_err}")
        }),
    };
    let _ = reply_tx.send(resp.to_string());
}
```

- [ ] **Step 3: Resolve the `self_shared` lifetime problem**

The handler mutates `self.cron_sessions` (`&mut self`) AND awaits `send_prompt_and_await_reply` (which holds the manager lock across `.await`). The `tokio::spawn` pattern above requires `self: 'static`. Two options:

**Option A (simpler):** Skip the panic isolation and call `self.handle_prompt_await(&payload).await` inline, like `McpSend` does. Accept that panics propagate to the daemon (matches existing `mcp-send` behavior). This is the **recommended path** — match existing conventions rather than introduce a new pattern just for cron.

Replace the Step 2 code with:

```rust
Some(SockCommand::PromptAwait { payload, reply_tx }) => {
    let resp = match self.handle_prompt_await(&payload).await {
        Ok(v) => serde_json::json!({ "ok": true, "result": v }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    };
    let _ = reply_tx.send(resp.to_string());
}
```

**Option B:** Refactor `DaemonServer` so the cron-relevant state (`cron_sessions`, `team_id`, the `RuntimeManager` Arc) lives in a cloneable struct that can be moved into a spawned task. This is significant refactoring; defer it as a follow-up if panic isolation becomes important.

Pick **Option A** for this task. (Spec §1's panic-catching requirement is downgraded to "deferred follow-up" in `Open items` of the spec — update the spec accordingly when committing Task 4.)

- [ ] **Step 4: Verify compile**

```bash
cargo check -p amuxd 2>&1 | tail -5
```

Expected: clean (no errors). There may be warnings about `tokio::spawn` being unused if you removed Step 2's spawn pattern; clean those.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/daemon/server.rs
git commit -m "$(cat <<'EOF'
feat(amuxd): handle_prompt_await + main-loop dispatch

Drives one ACP turn to completion via send_prompt_and_await_reply.
Per-session_key ACP session created on first call (per-run new-session
semantics on the cron side mean every call creates one). Panic
isolation deferred — matches existing mcp-send pattern.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

> ⚠️ Before commit: update the spec at `docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md` §1 to move "panic-to-error" from a "must" into the `Open items` list (downgraded after implementation tradeoff). Edit and stage that file together.

---

### Task 4a: Extend `create_gateway_session_with_model` to honor `working_directory`

**Files:**
- Modify: `apps/daemon/src/runtime/manager.rs`

`create_gateway_session_with_model` currently builds a throwaway `/tmp/amuxd-gateway-<uuid>` worktree (around line 793-801 of `manager.rs`). Cron's worktree mode needs to spawn the agent **in** the cron-created worktree, not a sibling temp dir.

- [ ] **Step 1: Read current signature**

```bash
grep -n "create_gateway_session_with_model" apps/daemon/src/runtime/manager.rs
```

Expected: the fn definition lives around line 780.

- [ ] **Step 2: Add a new parameter**

Change the signature from:

```rust
pub async fn create_gateway_session_with_model(
    &mut self,
    _team_id: &str,
    logical_session_id: &str,
    binding: &str,
    _title: &str,
    model_override: Option<(String, String)>,
    supabase_session_id: Option<&str>,
) -> crate::error::Result<String>
```

to:

```rust
pub async fn create_gateway_session_with_model(
    &mut self,
    _team_id: &str,
    logical_session_id: &str,
    binding: &str,
    _title: &str,
    model_override: Option<(String, String)>,
    supabase_session_id: Option<&str>,
    working_directory: Option<&str>,
) -> crate::error::Result<String>
```

- [ ] **Step 3: Use the parameter**

Inside the function body, find:

```rust
let worktree = format!(
    "/tmp/amuxd-gateway-{}",
    Uuid::new_v4().to_string()[..8].to_string()
);
std::fs::create_dir_all(&worktree).map_err(|e| {
    crate::error::AmuxError::Agent(format!(
        "create_gateway_session: mkdir {worktree}: {e}"
    ))
})?;
```

Replace with:

```rust
let worktree = match working_directory {
    Some(wd) => wd.to_string(),
    None => {
        let scratch = format!(
            "/tmp/amuxd-gateway-{}",
            Uuid::new_v4().to_string()[..8].to_string()
        );
        std::fs::create_dir_all(&scratch).map_err(|e| {
            crate::error::AmuxError::Agent(format!(
                "create_gateway_session: mkdir {scratch}: {e}"
            ))
        })?;
        scratch
    }
};
```

(Caller-supplied directories must already exist — cron's `WorktreeGuard` creates them before calling. amuxd does not mkdir caller-supplied paths.)

- [ ] **Step 4: Update callers**

There's one existing caller in the daemon (the gateway adapter code that originally calls this). `grep -n "create_gateway_session_with_model\|create_gateway_session(" apps/daemon/src/` will find it. Pass `None` for the new arg at every existing call site.

For the cron handler from Task 4, update the call:

```rust
.create_gateway_session_with_model(
    &self.team_id,
    parsed.session_key,
    &format!("cron://{}", parsed.session_key),
    "cron",
    parsed.model_override.clone(),
    None,
    parsed.working_directory,    // <-- new
)
```

Also remove the `tracing::warn!` block in `handle_prompt_await` that flagged the limitation; it's no longer a limitation.

- [ ] **Step 5: Verify compile**

```bash
cargo check -p amuxd 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/runtime/manager.rs apps/daemon/src/daemon/server.rs
git commit -m "$(cat <<'EOF'
feat(amuxd): honor working_directory in create_gateway_session_with_model

Passing Some(wd) spawns the agent in the caller-supplied directory; None
keeps the legacy throwaway /tmp/amuxd-gateway-<uuid> behavior. Enables
cron worktree mode end-to-end.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Phase 2 — desktop cron: sock client + integration

### Task 5: New `amuxd_client.rs` module — TDD

**Files:**
- Create: `apps/desktop/src/commands/cron/amuxd_client.rs`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/commands/cron/amuxd_client.rs` with **only** the test module at first (lets you watch them fail):

```rust
//! Async UnixSocket client for amuxd's `prompt-await` command. Used by
//! the cron scheduler to drive one ACP turn per cron run.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    /// Spawn a one-shot mock server that accepts one connection, reads one
    /// JSON line, calls `responder` to produce a reply, writes it back, and
    /// closes. Returns the sock path so the test can point the client at it.
    async fn mock_server<F>(responder: F) -> PathBuf
    where
        F: FnOnce(Value) -> String + Send + 'static,
    {
        let dir = std::env::temp_dir().join(format!("amuxd-mock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("amuxd.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let path_clone = path.clone();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let req: Value = serde_json::from_str(line.trim()).unwrap();
            let resp = responder(req);
            let mut stream = reader.into_inner();
            stream.write_all(resp.as_bytes()).await.unwrap();
            stream.write_all(b"\n").await.unwrap();
        });
        path_clone
    }

    #[tokio::test]
    async fn encodes_minimal_request_and_parses_ok_response() {
        let sock_path = mock_server(|req| {
            // Verify the request shape.
            assert_eq!(req["cmd"].as_str(), Some("prompt-await"));
            assert_eq!(req["session_key"].as_str(), Some("cron/j1/r1"));
            assert_eq!(req["message"].as_str(), Some("hi"));
            assert_eq!(req["timeout_secs"].as_u64(), Some(300));
            assert!(req.get("working_directory").is_none());
            assert!(req.get("model_override").is_none());
            serde_json::json!({
                "ok": true,
                "result": { "text": "hello back", "acp_session_id": "sid-1" }
            }).to_string()
        }).await;

        let resp = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                working_directory: None,
                model_override: None,
                timeout_secs: 300,
            },
        ).await.unwrap();

        assert_eq!(resp.text, "hello back");
        assert_eq!(resp.acp_session_id, "sid-1");
    }

    #[tokio::test]
    async fn includes_optional_fields_when_set() {
        let sock_path = mock_server(|req| {
            assert_eq!(req["working_directory"].as_str(), Some("/tmp/wt"));
            assert_eq!(req["model_override"]["provider"].as_str(), Some("anthropic"));
            assert_eq!(req["model_override"]["model"].as_str(), Some("sonnet"));
            serde_json::json!({
                "ok": true,
                "result": { "text": "ok", "acp_session_id": "sid-2" }
            }).to_string()
        }).await;

        prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                working_directory: Some("/tmp/wt"),
                model_override: Some(ModelOverride { provider: "anthropic", model: "sonnet" }),
                timeout_secs: 300,
            },
        ).await.unwrap();
    }

    #[tokio::test]
    async fn surfaces_amuxd_error_passthrough() {
        let sock_path = mock_server(|_req| {
            serde_json::json!({ "ok": false, "error": "no local agent runtime" }).to_string()
        }).await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                working_directory: None,
                model_override: None,
                timeout_secs: 300,
            },
        ).await.unwrap_err();
        assert!(err.contains("no local agent runtime"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_empty_text() {
        let sock_path = mock_server(|_req| {
            serde_json::json!({
                "ok": true,
                "result": { "text": "", "acp_session_id": "sid-3" }
            }).to_string()
        }).await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                working_directory: None,
                model_override: None,
                timeout_secs: 300,
            },
        ).await.unwrap_err();
        assert!(err.contains("empty text"), "got: {err}");
    }

    #[tokio::test]
    async fn surfaces_connect_failure_when_sock_missing() {
        let nowhere = PathBuf::from("/tmp/this-sock-does-not-exist-xyz");
        let err = prompt_await_at(
            &nowhere,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                working_directory: None,
                model_override: None,
                timeout_secs: 300,
            },
        ).await.unwrap_err();
        assert!(err.contains("amuxd unreachable"), "got: {err}");
    }

    #[tokio::test]
    async fn rejects_bad_response_shape() {
        let sock_path = mock_server(|_req| {
            // ok:true but missing result.
            serde_json::json!({ "ok": true }).to_string()
        }).await;

        let err = prompt_await_at(
            &sock_path,
            PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: "cron/j1/r1",
                message: "hi",
                working_directory: None,
                model_override: None,
                timeout_secs: 300,
            },
        ).await.unwrap_err();
        assert!(err.contains("missing result"), "got: {err}");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml amuxd_client::tests 2>&1 | tail -20
```

Expected: compile error — `PromptAwaitRequest`, `ModelOverride`, `prompt_await_at` not found.

- [ ] **Step 3: Write the implementation**

Replace the top of the file (above the `#[cfg(test)] mod tests` block) with:

```rust
//! Async UnixSocket client for amuxd's `prompt-await` command. Used by
//! the cron scheduler to drive one ACP turn per cron run.
//!
//! Spec: docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md §1, §2.

use serde::Serialize;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

#[derive(Serialize)]
pub struct PromptAwaitRequest<'a> {
    pub cmd: &'static str,
    pub session_key: &'a str,
    pub message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_override: Option<ModelOverride<'a>>,
    pub timeout_secs: u64,
}

#[derive(Serialize)]
pub struct ModelOverride<'a> {
    pub provider: &'a str,
    pub model: &'a str,
}

#[derive(Debug)]
pub struct PromptAwaitResponse {
    pub text: String,
    pub acp_session_id: String,
}

/// Convenience entry point: connect to amuxd's default sock path (resolved
/// via `crate::commands::gateway::sock_path()`), run a `prompt-await`
/// round-trip.
pub async fn prompt_await(req: PromptAwaitRequest<'_>) -> Result<PromptAwaitResponse, String> {
    let path = crate::commands::gateway::sock_path();
    prompt_await_at(&path, req).await
}

/// Test-friendly variant: takes the sock path explicitly.
pub async fn prompt_await_at(
    sock_path: &Path,
    req: PromptAwaitRequest<'_>,
) -> Result<PromptAwaitResponse, String> {
    let mut stream = UnixStream::connect(sock_path)
        .await
        .map_err(|e| format!("amuxd unreachable at {}: {e}", sock_path.display()))?;

    let line = serde_json::to_string(&req).map_err(|e| format!("encode request: {e}"))?;
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("amuxd sock IO (write): {e}"))?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|e| format!("amuxd sock IO (write nl): {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("amuxd sock IO (flush): {e}"))?;

    const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_RESPONSE_BYTES {
            return Err("amuxd response exceeded 16 MB".into());
        }
        match stream.read(&mut byte).await {
            Ok(0) => break,
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buf.push(byte[0]),
            Err(e) => return Err(format!("amuxd sock IO (read): {e}")),
        }
    }
    let body = String::from_utf8(buf).map_err(|e| format!("amuxd bad response: not utf8: {e}"))?;

    #[derive(serde::Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<WireResult>,
    }
    #[derive(serde::Deserialize)]
    struct WireResult {
        text: String,
        acp_session_id: String,
    }

    let parsed: Wire = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if !parsed.ok {
        return Err(parsed
            .error
            .unwrap_or_else(|| "unknown amuxd error".to_string()));
    }
    let r = parsed
        .result
        .ok_or_else(|| "amuxd bad response: ok=true but missing result".to_string())?;
    if r.text.is_empty() {
        return Err("amuxd returned empty text".into());
    }
    Ok(PromptAwaitResponse {
        text: r.text,
        acp_session_id: r.acp_session_id,
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml amuxd_client::tests 2>&1 | tail -15
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/commands/cron/amuxd_client.rs
git commit -m "$(cat <<'EOF'
feat(cron): async amuxd_client + prompt_await sock round-trip

Tokio-native UnixStream client for amuxd's prompt-await command. 16 MB
defensive response cap. 6 unit tests cover encoding, decoding, error
passthrough, empty-text rejection, connect failure, malformed response.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

### Task 6: Promote `sock_path()` to pub(crate); register cron module

**Files:**
- Modify: `apps/desktop/src/commands/gateway/mod.rs` (line 48)
- Modify: `apps/desktop/src/commands/cron/mod.rs`

- [ ] **Step 1: Promote sock_path visibility**

In `apps/desktop/src/commands/gateway/mod.rs`, line 48:

```rust
// before
fn sock_path() -> PathBuf {
// after
pub(crate) fn sock_path() -> PathBuf {
```

- [ ] **Step 2: Register the new module**

In `apps/desktop/src/commands/cron/mod.rs`, add to the existing `pub mod ...` declarations:

```rust
pub mod amuxd_client;
```

- [ ] **Step 3: Verify compile**

```bash
cargo check --manifest-path apps/desktop/Cargo.toml 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/commands/gateway/mod.rs apps/desktop/src/commands/cron/mod.rs
git commit -m "$(cat <<'EOF'
chore(cron): expose sock_path; register amuxd_client module

Promote gateway::sock_path() from private to pub(crate) so cron can
reuse it without duplicating the path computation. Wire amuxd_client
into the cron module tree.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

### Task 7: Rewrite `execute_job` to use `amuxd_client::prompt_await`

**Files:**
- Modify: `apps/desktop/src/commands/cron/scheduler.rs` (the `Step 1`/`Step 2` blocks inside `execute_job`, roughly lines 580-742)

- [ ] **Step 1: Replace the session-strategy block**

In `apps/desktop/src/commands/cron/scheduler.rs`, locate the section that begins with:

```rust
// Step 1: Determine session strategy based on delivery channel.
```

(around line 571) and ends just before:

```rust
// Step 2: Send message to OpenCode
```

(around line 724). Delete everything between those two comments AND the `Step 2` `send_to_opencode` block + `response_result` loop + extraction logic (so `Step 1`, `Step 2`, and the `extract_text_parts` call all go).

Replace the whole region with:

```rust
        // ── New cron-to-amuxd execution flow ─────────────────────────────
        // (Replaces the OpenCode HTTP path. See spec
        //  docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md §3.)

        let session_key = format!("cron/{}/{}", job.id, run_id);
        let working_directory = wt_guard.path.clone();   // Option<String>

        // Preserved from the OpenCode path: parse `job.payload.model` (a short
        // name like "sonnet") into `(provider, model)`. Kept identical so any
        // job-config docs/tests still apply.
        let model_param = job
            .payload
            .model
            .as_ref()
            .and_then(|m| crate::commands::gateway::parse_model_preference(m));

        let prompt_future = crate::commands::cron::amuxd_client::prompt_await(
            crate::commands::cron::amuxd_client::PromptAwaitRequest {
                cmd: "prompt-await",
                session_key: &session_key,
                message: &job.payload.message,
                working_directory: working_directory.as_deref(),
                model_override: model_param.as_ref().map(|(p, m)| {
                    crate::commands::cron::amuxd_client::ModelOverride {
                        provider: p,
                        model: m,
                    }
                }),
                timeout_secs: 300,
            },
        );

        // Heartbeat continues while we await the amuxd response.
        tokio::pin!(prompt_future);
        let heartbeat_every =
            std::time::Duration::from_secs(CRON_RUN_HEARTBEAT_INTERVAL_SECS);
        let mut heartbeat_interval = tokio::time::interval_at(
            tokio::time::Instant::now() + heartbeat_every,
            heartbeat_every,
        );

        let inner_result = loop {
            tokio::select! {
                result = &mut prompt_future => break result,
                _ = heartbeat_interval.tick() => {
                    record.last_heartbeat_at = Some(Utc::now());
                    self.persist_run_and_notify_ui(&record).await;
                }
            }
        };

        // Outer client-side timeout (330s = amuxd cap 300 + 30s slack)
        let response_text = match tokio::time::timeout(
            std::time::Duration::from_secs(330),
            async { inner_result },
        )
        .await
        {
            Ok(Ok(r)) => {
                record.session_id = Some(r.acp_session_id.clone());
                self.persist_run_and_notify_ui(&record).await;
                r.text
            }
            Ok(Err(e)) => {
                record.status = RunStatus::Failed;
                record.finished_at = Some(Utc::now());
                record.error = Some(e);
                self.persist_run_and_notify_ui(&record).await;
                self.update_job_after_run(&job, started_at, &my_workspace).await;
                return;
            }
            Err(_) => {
                record.status = RunStatus::Failed;
                record.finished_at = Some(Utc::now());
                record.error = Some("amuxd response exceeded 330s".into());
                self.persist_run_and_notify_ui(&record).await;
                self.update_job_after_run(&job, started_at, &my_workspace).await;
                return;
            }
        };
```

Then replace the OLD response handling (which extracts text from the OpenCode Message JSON via `extract_text_parts` and assigns to `response`) — the new code assigns `response_text` directly. Any downstream code that referenced `response` should now reference `response_text` (or, simpler, you can rename the local).

- [ ] **Step 2: Run scheduler tests**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml -p teamclaw cron::scheduler::tests 2>&1 | tail -20
```

Expected: pass — existing scheduler unit tests don't touch the OpenCode HTTP path; they should remain green.

If they fail because some test still references `port` or `opencode_port`, that means the OpenCode-cleanup (Task 8 / Task 9) hasn't landed yet. Defer those failures; Tasks 8-9 fix them.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/commands/cron/scheduler.rs
git commit -m "$(cat <<'EOF'
feat(cron): execute_job runs via amuxd prompt-await

Replaces the OpenCode HTTP session-strategy / send-message blocks with
a single amuxd_client::prompt_await call. session_key is per-run
unique (cron/<job_id>/<run_id>). Worktree mode passes
working_directory through. Heartbeat persistence preserved via
tokio::select!. Outer 330s timeout wraps the inner ACP 300s cap.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

### Task 8: Delete OpenCode HTTP helpers from `scheduler.rs`

**Files:**
- Modify: `apps/desktop/src/commands/cron/scheduler.rs`

- [ ] **Step 1: Locate every OpenCode helper**

```bash
grep -n "fn create_opencode_session\|fn send_to_opencode\|fn extract_text_parts\|fn find_existing_session\|fn delivery_to_session_key\|fn store_session\|fn check_session_archived\|fn fetch_last_completed_assistant_text_since\|fn extract_completed_assistant_text_for_cron_run\|OPENCODE_CONNECT_TIMEOUT_SECS" apps/desktop/src/commands/cron/scheduler.rs
```

You should see 10 hits (the 9 functions + 1 constant).

- [ ] **Step 2: Delete each function block**

For each match: find the start of the function (or const), find its closing brace, delete everything between (inclusive). Most are `fn` definitions; `OPENCODE_CONNECT_TIMEOUT_SECS` is a `const` line — delete it too.

For functions called via `Self::...`, also remove the `use` of `Self::` if it surfaces as an unused-method warning.

The `extract_text_parts` function is referenced indirectly via `Self::extract_text_parts` inside `extract_completed_assistant_text_for_cron_run` — since both are being deleted, no issue.

- [ ] **Step 3: Remove `use reqwest` if unused**

```bash
grep -n "reqwest" apps/desktop/src/commands/cron/scheduler.rs
```

If the only references were inside the deleted functions, remove the `use reqwest;` line at the top.

Also check `urlencoding`, `serde_json::Value` direct constructors etc. — clean up unused imports the compiler warns about.

- [ ] **Step 4: Update imports + verify**

```bash
cargo check --manifest-path apps/desktop/Cargo.toml 2>&1 | tail -20
```

Fix any unused-import warnings the compiler surfaces in the file. Should be clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/commands/cron/scheduler.rs
git commit -m "$(cat <<'EOF'
chore(cron): delete OpenCode HTTP helpers from scheduler

Drops 9 functions + OPENCODE_CONNECT_TIMEOUT_SECS const that became
unused after Task 7 swapped execute_job over to amuxd_client. Unused
imports cleaned alongside.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

### Task 9: Remove `opencode_port` field, `set_port`, and external callers

**Files:**
- Modify: `apps/desktop/src/commands/cron/scheduler.rs`
- Modify: caller files (typically `apps/desktop/src/lib.rs` or a startup wiring file — locate via grep)

- [ ] **Step 1: Find all references**

```bash
grep -rn "set_port\b\|opencode_port\b" apps/desktop/src/ 2>&1 | head -20
```

You should see:
- The field definition + 3-4 usages in `scheduler.rs` (lines around 24, 39, 80)
- The setter `pub async fn set_port` in `scheduler.rs` (around line 186)
- One or two external callers — typically in `lib.rs` where the cron scheduler is initialized

- [ ] **Step 2: Remove field + setter**

In `scheduler.rs`:

Find:
```rust
opencode_port: Arc<RwLock<u16>>,
```
and delete the field.

Find `impl Clone for CronScheduler` (around line 36) and delete the field copy:
```rust
opencode_port: Arc::clone(&self.opencode_port),
```

Find `pub fn new() -> Self` (around line 80) and delete:
```rust
opencode_port: Arc::new(RwLock::new(13141)),
```

Find:
```rust
/// Set the OpenCode server port
pub async fn set_port(&self, port: u16) {
    let mut p = self.opencode_port.write().await;
    *p = port;
}
```
(around line 185-189) and delete the entire fn (including the doc comment line).

- [ ] **Step 3: Remove external callers**

For each `cron_scheduler.set_port(...)` (or `.set_port(...)`) call elsewhere in `apps/desktop/src/`, delete the call line.

Likely call sites:
- `apps/desktop/src/lib.rs` somewhere during app setup or when OpenCode port becomes known. Could be inside `setup` or a `tauri::Builder::setup` block.

If the caller's surrounding logic (e.g. "wait until OpenCode comes up, then set port on cron") becomes vacuous, delete that block too.

- [ ] **Step 4: Compile + test**

```bash
cargo check --manifest-path apps/desktop/Cargo.toml 2>&1 | tail -10
cargo test --manifest-path apps/desktop/Cargo.toml cron::scheduler::tests 2>&1 | tail -10
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/commands/cron/scheduler.rs apps/desktop/src/lib.rs
git commit -m "$(cat <<'EOF'
chore(cron): drop opencode_port field and set_port setter

Removed from CronScheduler struct/Clone/new. External callers in
desktop's startup wiring also deleted. amuxd transport doesn't need a
port; the sock path is shared via gateway::sock_path().

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

(Adjust the `git add` arg list to the exact files you edited — if the external caller lives somewhere other than `lib.rs`, swap it in.)

---

### Task 10: Simplify `reconcile_interrupted_runs` to always mark Stale

**Files:**
- Modify: `apps/desktop/src/commands/cron/scheduler.rs` (around line 140)

- [ ] **Step 1: Replace the reconcile loop**

Find:

```rust
pub async fn reconcile_interrupted_runs(&self) {
    let running = self.storage.get_latest_running_runs().await;
    if running.is_empty() {
        return;
    }

    let port = *self.opencode_port.read().await;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(
            OPENCODE_CONNECT_TIMEOUT_SECS,
        ))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    println!(
        "[Cron] Reconciling {} interrupted run(s) from previous executor",
        running.len()
    );

    for record in running {
        let assistant_text = if record.has_legacy_timeout_cut_short_text() {
            None
        } else if let Some(session_id) = record.session_id.as_deref() {
            let expected_prompt = self
                .storage
                .get_job(&record.job_id)
                .await
                .map(|job| job.payload.message);
            Self::fetch_last_completed_assistant_text_since(
                &client,
                port,
                session_id,
                record.started_at,
                expected_prompt.as_deref(),
            )
            .await
        } else {
            None
        };

        let reconciled = Self::reconcile_interrupted_run(record, assistant_text, Utc::now());
        self.persist_run_and_notify_ui(&reconciled).await;
    }
}
```

Replace with:

```rust
pub async fn reconcile_interrupted_runs(&self) {
    let running = self.storage.get_latest_running_runs().await;
    if running.is_empty() {
        return;
    }

    println!(
        "[Cron] Reconciling {} interrupted run(s) from previous executor (marking Stale)",
        running.len()
    );

    for record in running {
        // After the amuxd migration we no longer probe a remote session for
        // a possible AgentReply text — recovery would need a new amuxd
        // `get-session-result` cmd, which is deferred per spec §4.
        let reconciled = Self::reconcile_interrupted_run(record, None, Utc::now());
        self.persist_run_and_notify_ui(&reconciled).await;
    }
}
```

- [ ] **Step 2: Add a unit test asserting Stale-on-interrupt**

In the `#[cfg(test)] mod tests` section near the bottom of `scheduler.rs`, add:

```rust
#[test]
fn reconcile_without_assistant_text_marks_stale() {
    let record = CronRunRecord {
        run_id: "r1".into(),
        job_id: "j1".into(),
        started_at: Utc.with_ymd_and_hms(2026, 5, 17, 0, 0, 0).unwrap(),
        finished_at: None,
        status: RunStatus::Running,
        last_heartbeat_at: Some(Utc.with_ymd_and_hms(2026, 5, 17, 0, 0, 30).unwrap()),
        session_id: Some("sid-1".into()),
        response_summary: None,
        delivery_status: None,
        error: None,
        worktree_path: None,
    };
    let now = Utc.with_ymd_and_hms(2026, 5, 17, 0, 5, 0).unwrap();
    let out = CronScheduler::reconcile_interrupted_run(record, None, now);
    assert_eq!(out.status, RunStatus::Stale);
    assert_eq!(out.finished_at, Some(now));
    assert!(out.error.is_some(), "stale runs should carry an error message");
}
```

(If `Utc` constructor differs from `Utc.with_ymd_and_hms` in this codebase, use whichever `DateTime<Utc>` constructor the existing scheduler tests use — `grep -n "DateTime<Utc>" apps/desktop/src/commands/cron/scheduler.rs` to find the pattern.)

- [ ] **Step 3: Run scheduler tests**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml cron::scheduler::tests 2>&1 | tail -15
```

Expected: 7+ tests pass (existing 6 + new 1).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/commands/cron/scheduler.rs
git commit -m "$(cat <<'EOF'
chore(cron): simplify reconcile_interrupted_runs to mark Stale

amuxd has no get-session-result cmd, so HTTP probing into OpenCode for
historical reply text is gone. Interrupted runs are marked Stale. Added
unit test asserting reconcile_interrupted_run(record, None, now) →
Stale + finished_at + error.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
EOF
)"
```

---

## Phase 3 — final verification

### Task 11: Full check + smoke + PR

**Files:**
- N/A (cross-cutting verification)

- [ ] **Step 1: Cargo check (both crates)**

```bash
cargo check --manifest-path apps/desktop/Cargo.toml 2>&1 | tail -5
cargo check --manifest-path apps/daemon/Cargo.toml 2>&1 | tail -5
```

Expected: both clean (warnings OK if pre-existing).

- [ ] **Step 2: Run all relevant tests**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml cron:: 2>&1 | tail -15
cargo test --manifest-path apps/daemon/Cargo.toml prompt_await 2>&1 | tail -15
```

Expected:
- desktop cron suite: pre-existing tests pass + new tests from Task 7/Task 10
- daemon: new prompt_await_tests pass

- [ ] **Step 3: pnpm typecheck (sanity — frontend should be unaffected)**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 4: Manual smoke (documented for the PR)**

This step is performed locally by the PR author, not automated. Document in the PR body as a checklist:

1. Start amuxd with a primary agent registered (`amuxd init` → onboard → confirm `agent_runtimes` row exists for this device).
2. In the desktop app, open the Cron settings panel and create a new job:
   - Schedule: `*/2 * * * *` (every 2 min for the test)
   - Message: `echo hello world`
   - Delivery: none
3. Wait for the next tick. Open the cron run history.
4. Expect: `RunStatus::Success`, `response_summary` non-empty, `session_id` filled with an ACP session UUID.
5. Tail `amuxd` logs (`tail -f ~/.config/amux/amuxd.log` or similar). Confirm a "prompt-await" sock connect was logged, `create_gateway_session_with_model` invoked, `send_prompt_and_await_reply` returned with text.

- [ ] **Step 5: Push branch + open PR**

```bash
git push -u origin cron-to-amuxd
gh pr create --title "Cron → amuxd: replace OpenCode HTTP with sock prompt-await" --body "$(cat <<'EOF'
## Summary

- Replaces cron's OpenCode HTTP integration with an amuxd Unix-socket integration. Cron-triggered prompts now run on the local amuxd's primary agent runtime via a new `prompt-await` socket command.
- 9 OpenCode-specific helpers + the `opencode_port` field are removed from `apps/desktop/src/commands/cron/scheduler.rs`.
- A new module `apps/desktop/src/commands/cron/amuxd_client.rs` carries the async sock client; amuxd gains a new `SockCommand::PromptAwait` variant + `handle_prompt_await` method.

Spec: `docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md`
Plan: `docs/superpowers/plans/2026-05-17-cron-to-amuxd.md`

## Test plan

- [x] amuxd `prompt_await_tests` (5 unit tests on the pure payload parser)
- [x] amuxd cargo check clean
- [x] desktop `cron::amuxd_client::tests` (6 unit tests, async UnixListener mock)
- [x] desktop `cron::scheduler::tests` reconcile-Stale test added; all existing scheduler tests still pass
- [x] desktop cargo check clean
- [x] pnpm typecheck unaffected
- [ ] **Manual smoke**: start amuxd with a primary agent registered, create a cron job ("echo hello world"), confirm Success status + non-empty `response_summary` + ACP session UUID in `session_id`

## Known follow-ups (out of scope)

- Reconcile-after-restart: needs an amuxd `get-session-result` cmd; cron currently marks interrupted runs as Stale.
- Panic isolation in `handle_prompt_await`: deferred — matches existing `mcp-send` behavior. Adding a cloneable `DaemonServer` slice for `tokio::spawn` is a separate refactor.
- `SessionMapping::set_model` retention: kept for now; UI team to decide whether the cron-session model display in the chat panel is still needed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Out-of-scope (tracked for follow-up)

1. **Reconcile recovery** (amuxd `get-session-result` cmd + cron-side probing). Currently interrupted runs are marked Stale.
2. **Panic isolation** in `handle_prompt_await` via `tokio::spawn`. Requires `DaemonServer` state refactor.
3. **Per-job agent selection**. Currently fixed to the local primary agent. Adding it means an `agent_id` field on `CronJob` plus amuxd-side resolver.
4. **`SessionMapping::set_model`** retention — UI-side review.
5. **Repo-wide OpenCode removal** — other code paths still use OpenCode.
