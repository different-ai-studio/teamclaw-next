# Channel Slash Commands — Design Spec

**Date:** 2026-06-04
**Branch:** to be created from main
**Scope:** `crates/teamclaw-gateway`

## Overview

Add a universal slash-command system to the `teamclaw-gateway` crate so every channel gateway (WeChat Work, Discord, Feishu, etc.) can interpret `/command` messages from users without each gateway implementing its own parser.

## Commands

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/help` | — | Print available commands |
| `/model` | `[name]` | No arg: list models with current marked `*`. With arg: switch model. |
| `/sessions` | `[id]` | No arg: list sessions with current marked `*`. With arg: bind session. |
| `/clear` | — | Reset the current ACP session (start fresh) |
| `/stop` | — | Cancel in-progress ACP generation |
| `/ctx` | `<text>` | Inject context without triggering a reply |

Unknown commands reply: `Unknown command. /help for list.`
Missing required argument replies: `Usage: /ctx <text>`

## Architecture

### New file: `crates/teamclaw-gateway/src/commands.rs`

**Public API:**

```rust
/// Returns Some(Command) if text starts with '/', None otherwise.
pub fn parse_command(text: &str) -> Option<Command>

/// Execute a parsed command. Calls `reply` with the response string.
/// Returns Ok(()) on success, Err on ACP/store failures.
pub async fn dispatch_command<S, A>(
    cmd: Command,
    acp: &A,
    store: &S,
    session_id: &str,
    reply: impl Fn(String) + Send,
) -> anyhow::Result<()>
where
    A: AcpHandle + Send + Sync,
    S: ChannelStore + Send + Sync,
```

**Command enum:**

```rust
pub enum Command {
    Help,
    Model(Option<String>),    // None = list, Some(name) = switch
    Sessions(Option<String>), // None = list, Some(id) = bind
    Clear,
    Stop,
    Ctx(String),
}
```

### `lib.rs` change

Add `pub mod commands;` to the module list.

### Gateway integration (wecom.rs example)

In the text-message handler, before calling `acp.send_prompt()`:

```rust
use crate::commands::{parse_command, dispatch_command};

if let Some(cmd) = parse_command(&text) {
    dispatch_command(cmd, &acp, &store, &session_id, |reply| {
        // call existing send_text helper
        send_chat_message(&ws_sink, &chat_id, &reply).await;
    }).await?;
    return Ok(());
}
// normal ACP flow continues
```

Other gateways follow the same 3-line pattern with their own `send_text` helper.

## Command Responses (plain text)

**`/help`**
```
Available commands:
/help - Show this help
/model [name] - List or switch models
/sessions [id] - List or bind sessions
/clear - Start new session
/stop - Stop current processing
/ctx <text> - Inject context without reply
```

**`/model` (no arg)**
```
Models:
* claude-sonnet-4-6 (current)
  gpt-4o
  gemini-2.0-flash
```

**`/model gpt-4o`**
```
Model set: gpt-4o
```

**`/sessions` (no arg)**
```
Sessions:
* sess_abc123 (current)
  sess_def456
```

**`/sessions sess_def456`**
```
Session: sess_def456
```

**`/clear`**
```
Session cleared.
```

**`/stop`**
```
Stopped.
```
or if nothing running:
```
Nothing running.
```

**`/ctx <text>`**
```
Context injected.
```

## Error Handling

- Unknown command → `Unknown command. /help for list.`
- Missing required arg → `Usage: /ctx <text>`
- ACP errors (e.g., `set_model` fails) → propagate as `Err`, gateway logs and optionally replies with a generic error string
- `/stop` when nothing is running → `Nothing running.` (not an error)

## Testing

Unit tests in `commands.rs`:
- `parse_command` covers: valid commands, unknown commands, missing args, extra whitespace, non-command text
- `dispatch_command` with mock `AcpHandle` + `ChannelStore` for each command variant

## File Changes Summary

```
crates/teamclaw-gateway/src/
├── commands.rs     ← NEW: parse_command, dispatch_command, Command enum
├── lib.rs          ← add: pub mod commands
└── wecom.rs        ← add: ~5 lines in text message handler

(other gateways: each adds ~5 lines when they need command support)
```

## Out of Scope

- Command permissions / access control
- Custom commands per workspace
- Command history
- Rich-text / card responses (WeChat Work card format)
