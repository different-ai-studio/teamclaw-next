# Cron → amuxd Migration Design

**Date**: 2026-05-17
**Status**: Spec
**Scope**: Replace cron's OpenCode HTTP integration with an amuxd Unix-socket integration. Cron-triggered prompts run on the local amuxd's primary agent runtime. The OpenCode-specific path inside `apps/desktop/src/commands/cron/` is removed entirely. OpenCode remains in the repo for other consumers.

---

## Goals

1. All cron-triggered prompts execute on the local amuxd agent runtime instead of an OpenCode HTTP server.
2. amuxd gains a new socket command (`prompt-await`) that drives one ACP turn to completion and returns the final reply text.
3. Cron-side code paths that were specific to OpenCode (session creation, message extraction, archive checks, reconcile-via-HTTP) are deleted.

## Non-goals

- **Cross-device routing**. The local amuxd is assumed to host one primary agent runtime. Cron does not target remote agents.
- **Multi-agent selection per job**. Cron does not let a job pick a specific agent — there is only one local agent.
- **Channel session reuse**. Discord/Feishu cron output used to share session state with the user's chat thread; that semantics is dropped. Every cron run uses its own fresh ACP session.
- **Reconcile-after-restart**. When desktop restarts mid-turn, the previously-running record is marked `Stale`. No HTTP/sock probe attempts to recover the response — designing that requires a new amuxd cmd to query historical session state and is out of scope.
- **Repo-wide OpenCode removal**. OpenCode is used by other code paths (chat, gateway/email, opencode SDK in frontend); this spec only removes cron's calls.

## Decisions

- **Transport**: amuxd Unix socket (`amuxd.sock`), JSON line protocol.
- **Agent selection**: local primary agent (the daemon's own actor_id). No agent_id field added to cron job.
- **Session addressing**: cron uses its own `cron://<job_id>/<run_id>` logical key — independent of channel routing.
- **Session granularity**: per-run new session (`cron://<job_id>/<run_id>` is unique per run). No reuse across runs.
- **Reconcile**: simplified to mark Stale (no recovery).

---

## §1 amuxd: new socket command `prompt-await`

Add a new JSON envelope command on `amuxd.sock` (siblings to existing `mcp-send`):

**Request:**

```jsonc
{
  "cmd": "prompt-await",
  "session_key": "cron/<job_id>/<run_id>",
  "message": "<prompt body>",
  "working_directory": "/path/to/worktree",   // optional; cron worktree mode passes it; null otherwise
  "model_override": {                         // optional; cron job.payload.model passthrough
    "provider": "anthropic",
    "model": "sonnet"
  },
  "timeout_secs": 300                         // optional; clamped at amuxd internal max (currently 300)
}
```

**Response:**

```jsonc
{ "ok": true,  "result": { "text": "<final AgentReply text>", "acp_session_id": "<uuid>" } }
// or
{ "ok": false, "error": "ACP turn timed out" }
```

**amuxd-side wiring:**

1. New variant `SockCommand::PromptAwait { payload, reply_tx }`. The listener (around `server.rs:3099`) recognizes `cmd: "prompt-await"` and dispatches to `handle_prompt_await`.
2. `handle_prompt_await(payload)`:
   - Validate `session_key` starts with `cron/` (reject otherwise — this command is reserved for cron-style callers; misuse should be loud).
   - Validate `message` is non-empty.
   - Maintain an internal `HashMap<session_key, acp_session_id>` (call it `cron_sessions`). Look up the key; if absent, call `RuntimeManager::create_gateway_session_with_model` (or a sibling `create_logical_session`) passing `working_directory` as the worktree and `model_override` as `(provider, model)`. Capture the returned `acp_session_id` into the map.
   - Call `RuntimeManager::send_prompt_and_await_reply(acp_session_id, message)`. This already blocks up to the manager's 5-minute cap and returns the aggregated `AgentReply` text.
   - Return `{ok: true, result: { text, acp_session_id }}`.
3. Panics inside `handle_prompt_await` must be caught (e.g. `tokio::task::spawn` + `JoinHandle`, or explicit `AssertUnwindSafe + catch_unwind`) and converted to `{ok: false, error: "internal amuxd panic: <msg>"}`. A bare panic that drops the socket gives the cron client only an IO error with no diagnostic.
4. If the daemon has no primary agent runtime registered (`self.agents` is empty for `self.actor_id`), `handle_prompt_await` returns `{ok: false, error: "no local agent runtime"}` immediately rather than spawning.

**Reuse vs new-session**: with cron's "per-run new session" decision, every `prompt-await` call lands on the "absent → create" branch of `cron_sessions`. The map and the lookup-or-create structure stay (cheap insurance) so that future code paths can adopt session reuse without touching this handler.

**Channel dispatch is NOT involved.** `prompt-await` produces the AgentReply text and returns. Sending that text to a channel target (Discord/Feishu/Email/etc.) remains cron's responsibility on the desktop side.

---

## §2 cron-side sock client

New file: `apps/desktop/src/commands/cron/amuxd_client.rs`.

**Why a new file**: `scheduler.rs` is already 1779 lines; the protocol envelope and IO concerns are a clean unit to extract.

**Why async UnixStream**: cron runs inside the tokio runtime. The existing sync `std::os::unix::net::UnixStream` in `gateway/mod.rs` is fine for short Tauri-command round-trips but would block a tokio worker for up to 5 minutes during an ACP turn. Use `tokio::net::UnixStream`.

```rust
// apps/desktop/src/commands/cron/amuxd_client.rs
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

#[derive(Serialize)]
pub struct PromptAwaitRequest<'a> {
    pub cmd: &'static str,                            // always "prompt-await"
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

pub async fn prompt_await(req: PromptAwaitRequest<'_>) -> Result<PromptAwaitResponse, String> {
    let path = crate::commands::gateway::sock_path();
    let mut stream = UnixStream::connect(&path).await
        .map_err(|e| format!("amuxd unreachable at {}: {e}", path.display()))?;

    let line = serde_json::to_string(&req)
        .map_err(|e| format!("encode request: {e}"))?;
    stream.write_all(line.as_bytes()).await
        .map_err(|e| format!("amuxd sock IO (write): {e}"))?;
    stream.write_all(b"\n").await
        .map_err(|e| format!("amuxd sock IO (write nl): {e}"))?;
    stream.flush().await
        .map_err(|e| format!("amuxd sock IO (flush): {e}"))?;

    const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024; // 16 MB defensive cap
    let mut buf = Vec::with_capacity(4096);
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_RESPONSE_BYTES {
            return Err("amuxd response exceeded 16 MB".into());
        }
        match stream.read(&mut byte).await {
            Ok(0) => break,                                // EOF
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => buf.push(byte[0]),
            Err(e) => return Err(format!("amuxd sock IO (read): {e}")),
        }
    }
    let body = String::from_utf8(buf)
        .map_err(|e| format!("amuxd bad response: not utf8: {e}"))?;

    #[derive(serde::Deserialize)]
    struct Wire {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        result: Option<WireResult>,
    }
    #[derive(serde::Deserialize)]
    struct WireResult { text: String, acp_session_id: String }

    let parsed: Wire = serde_json::from_str(body.trim())
        .map_err(|e| format!("amuxd bad response: {e} (body={body:?})"))?;
    if !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| "unknown amuxd error".into()));
    }
    let r = parsed.result
        .ok_or_else(|| "amuxd bad response: ok=true but missing result".to_string())?;
    if r.text.is_empty() {
        return Err("amuxd returned empty text".into());
    }
    Ok(PromptAwaitResponse { text: r.text, acp_session_id: r.acp_session_id })
}
```

**Config touch:**

- `apps/desktop/src/commands/gateway/mod.rs`: change `fn sock_path()` from private to `pub(crate)` so cron can call it.
- `apps/desktop/src/commands/cron/mod.rs`: add `pub mod amuxd_client;`.

---

## §3 cron `execute_job` flow under amuxd

The ~100-line "Step 1: Determine session strategy" block (around `scheduler.rs:580-685`) collapses to:

```rust
let session_key = format!("cron/{}/{}", job.id, run_id);
let working_directory = wt_guard.path.clone();   // Option<String>; Some(...) only in worktree mode

let model_param = job.payload.model
    .as_ref()
    .and_then(|m| crate::commands::gateway::parse_model_preference(m));

let prompt_future = crate::commands::cron::amuxd_client::prompt_await(PromptAwaitRequest {
    cmd: "prompt-await",
    session_key: &session_key,
    message: &job.payload.message,
    working_directory: working_directory.as_deref(),
    model_override: model_param.as_ref().map(|(p, m)| ModelOverride { provider: p, model: m }),
    timeout_secs: 300,
});

// Heartbeat continues to tick while we await the response.
tokio::pin!(prompt_future);
let heartbeat_every = std::time::Duration::from_secs(CRON_RUN_HEARTBEAT_INTERVAL_SECS);
let mut heartbeat_interval = tokio::time::interval_at(
    tokio::time::Instant::now() + heartbeat_every,
    heartbeat_every,
);

let inner = loop {
    tokio::select! {
        result = &mut prompt_future => break result,
        _ = heartbeat_interval.tick() => {
            record.last_heartbeat_at = Some(Utc::now());
            self.persist_run_and_notify_ui(&record).await;
        }
    }
};

// Outer client-side timeout: amuxd's internal cap is 300s; give 30s of slack so the
// inner future can return its own error rather than us erroring with a misleading
// "exceeded" message at the boundary.
let response = match tokio::time::timeout(std::time::Duration::from_secs(330), async { inner }).await {
    Ok(Ok(r)) => { record.session_id = Some(r.acp_session_id.clone()); r.text }
    Ok(Err(e)) => return fail_run(self, record, e, &job, started_at, &my_workspace).await,
    Err(_) => return fail_run(self, record, "amuxd response exceeded 330s".into(), &job, started_at, &my_workspace).await,
};
```

**Field mapping in CronRunRecord:**

| Field | Old source | New source |
|---|---|---|
| `session_id` | OpenCode session id from `POST /session` | `acp_session_id` returned by amuxd |
| `response_summary` | text from `extract_text_parts(message_json)` truncated | `response.text` truncated (amuxd already aggregated) |
| `last_heartbeat_at` | tokio heartbeat tick | unchanged |
| `worktree_path` | worktree mode path | unchanged (cron still owns the worktree lifecycle) |

**Mode semantics (before → after):**

| Mode | Before | After |
|---|---|---|
| Discord/Feishu delivery | Reuse channel target session | New session per run; delivery unchanged |
| Email delivery | New session per run, Message-ID register on outbound | New session per run; Message-ID register unchanged |
| No delivery | New session | Same |
| Worktree | New session with `opencode_directory=<worktree>` | `working_directory: Some(<worktree>)` field on prompt_await |

**`SessionMapping` use:**
- `find_existing_session` / `delivery_to_session_key` / `store_session` — all deleted (no reuse).
- `set_model(key, model_str)` — kept, to be evaluated separately. If the UI no longer needs "show cron session's model in chat panel", drop it as a follow-up. Not deciding here.

---

## §4 Delete list

**Removed from `apps/desktop/src/commands/cron/scheduler.rs`:**

| Item | Why |
|---|---|
| Field `opencode_port: Arc<RwLock<u16>>` | amuxd transport replaces HTTP port |
| Field init in `Clone` (line 39) + `new` (line 80) | same |
| `pub async fn set_port(&self, port: u16)` | no port concept |
| `async fn create_opencode_session` | amuxd handles session creation by session_key |
| `async fn send_to_opencode` | replaced by `amuxd_client::prompt_await` |
| `fn extract_text_parts` | amuxd aggregates; no OpenCode Message parsing on the client |
| `async fn fetch_last_completed_assistant_text_since` | reconcile simplification (see below) |
| `fn extract_completed_assistant_text_for_cron_run` | same |
| `async fn find_existing_session(&CronDelivery)` | no session reuse |
| `fn delivery_to_session_key(&CronDelivery)` | same |
| `async fn store_session(&CronDelivery, &str)` | same |
| `async fn check_session_archived(port, session_id)` | OpenCode-specific |
| Const `OPENCODE_CONNECT_TIMEOUT_SECS` | only callers are above |

**Removed elsewhere (callers of `set_port`):**

- `grep -rn 'set_port\b' apps/desktop/` and delete the call sites. They typically live in `lib.rs` or a startup wiring file that knows the OpenCode port.

**Reconcile simplification:**

`reconcile_interrupted_runs` keeps its loop shape and persistence, but the per-record block stops trying to fetch assistant text from a remote session. It calls `Self::reconcile_interrupted_run(record, None, Utc::now())` for every row, which routes to the `Stale` branch (interpreted as "we don't know what happened; mark stale"). The `reconcile_interrupted_run` function itself stays — the three-branch decision (timeout / success / stale) is still used by the test suite and remains correct logic for future re-introduction of recovery.

**Kept (intentionally not touched):**

- `WorktreeGuard` creation, activation, and `Drop` cleanup
- `check_generation!` macro
- Heartbeat persistence via `tokio::select!`
- `update_job_after_run` (next-run computation)
- Delivery via `gateway::*::send_*` calls
- `SessionMapping::set_model` (kept pending UI review)

---

## §5 Error handling

All failure paths land in `CronRunRecord.error: Option<String>` and set `RunStatus::Failed`. No retry. The desktop UI already renders `error` in the run history view.

| Source | When | error string |
|---|---|---|
| daemon not running | `UnixStream::connect` fails | `amuxd unreachable at <path>: <io err>` |
| connection dropped mid-stream | write / read EOF | `amuxd sock IO (read|write|flush): <io err>` |
| malformed response | json parse fails / missing fields | `amuxd bad response: <details>` |
| amuxd internal error | response `{ok:false, error}` | passthrough — `<error>` verbatim |
| client outer timeout | `tokio::time::timeout(330s, …)` | `amuxd response exceeded 330s` |
| empty reply | `ok:true` but `text.is_empty()` | `amuxd returned empty text` |

**Daemon side error sources surface via `error` field:**

- `"missing 'session_key'"`, `"missing 'message'"`, `"session_key must start with 'cron/'"` — payload validation
- `"no local agent runtime"` — daemon hasn't onboarded yet
- `"spawn failed: <details>"` — agent spawn errored
- `"ACP turn timed out"` — amuxd's 5-min cap fired
- `"ACP event channel closed before reply"` — adapter died mid-turn
- `"internal amuxd panic: <msg>"` — catch_unwind wrapper around handler

**Guard rails preserved:**

- `check_generation!()` aborts in-flight runs when workspace switches.
- `WorktreeGuard::Drop` cleans worktrees even on spawn failure.
- Heartbeat keeps writing `last_heartbeat_at` while the prompt_await future is pending.
- Mid-turn amuxd restart → client sees EOF → "amuxd sock IO (read)" → Failed.

---

## §6 Testing

| Layer | What | Tool |
|---|---|---|
| amuxd `handle_prompt_await` | payload validation (missing `session_key`, missing `message`, non-`cron/` prefix); response envelope shape; panic-to-error wrapping | Rust unit tests in `apps/daemon/src/daemon/server.rs` (or split into `server_prompt_await.rs`). Mock `RuntimeManager` via a small trait or stub struct. Pure-function helpers extracted (e.g. `parse_prompt_await_payload`) so payload tests don't require an actor system |
| amuxd session map | first call inserts; lookup-hit path callable (defensive, even though cron only ever inserts) | same test file |
| cron client `prompt_await` | request encoding (each optional field exercised); response parsing for ok/error/missing-result/empty-text branches; IO error paths; 16 MB cap | `#[tokio::test]` spawns a `tokio::net::UnixListener` that accepts one connection, reads a line, writes a canned response, closes. Helper at `apps/desktop/src/commands/cron/amuxd_client.rs` `#[cfg(test)] mod tests` |
| cron scheduler reconcile | existing reconcile tests (lines ~1309-1456) keep passing; new test: `reconcile_interrupted_runs` with running record → status becomes `Stale`, no IO attempted | scheduler.rs `mod tests` |
| cron scheduler other | existing tests for `compute_next_run`, worktree cleanup, generation check stay passing | same |
| Manual smoke | start amuxd with primary agent → add cron job "echo hello world" → trigger → confirm `response_summary` non-empty and `acp_session_id` filled | documented in PR test plan |

**Not tested:**

- Multi-device / multi-agent routing (out of scope by user decision).
- Session reuse (decision: per-run new).
- OpenCode regression (path deleted).
- Reconcile recovery beyond "mark Stale".

**Test infrastructure changes:**

- Wrap `RuntimeManager::create_gateway_session_with_model` and `send_prompt_and_await_reply` behind a trait (e.g. `AcpEngine`) so the prompt-await handler can be tested without spawning real adapters. If introducing the trait is too invasive, fall back to extracting just `parse_prompt_await_payload` as a pure function so at least the validation layer is unit-testable.

---

## Open items (out of scope here)

1. **Reconcile-after-restart** — currently simplified to Stale. A follow-up could add an amuxd cmd `get-session-result(acp_session_id)` to recover responses produced by amuxd after a desktop crash.
2. **`SessionMapping::set_model` retention** — UI side decision; spec leaves it in place pending review.
3. **Multi-agent / per-job agent selection** — explicit non-goal here; adding it later means a new `agent_id` field on `CronJob` and resolving the binding against an agent registry.
4. **OpenCode binary in repo** — still used by other consumers (chat, gateway/email, opencode SDK). This spec does not propose removing it globally.
