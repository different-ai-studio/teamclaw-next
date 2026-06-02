use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonConfig {
    pub device: DeviceConfig,
    pub mqtt: MqttConfig,
    /// Transport selector. Defaults to MQTT when omitted so existing
    /// `daemon.toml` files keep working unchanged. Set
    /// `[transport] kind = "nats"` + `url = "nats://..."` to use NATS.
    #[serde(default)]
    pub transport: Option<TransportConfig>,
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub channels: ChannelsConfig,
    /// Stop ACP runtimes whose `last_active_at` is older than this many
    /// seconds. `None` (default) disables idle eviction. Manual stops via
    /// the RuntimeStop RPC are unaffected. Recommend ≥ 1800 (30 min) so
    /// users don't lose context mid-conversation; very short values will
    /// kill mid-stream replies that exceed the threshold.
    #[serde(default)]
    pub idle_runtime_timeout_secs: Option<u64>,
    /// Optional browser-facing HTTP/SSE API. When set, the daemon binds an
    /// axum listener alongside the existing Unix control socket. When
    /// omitted, no HTTP listener is started (the historical default).
    #[serde(default)]
    pub http: Option<HttpConfig>,
}

/// Configuration for the browser-facing HTTP+SSE listener. The listener is
/// strictly opt-in — the daemon never binds a TCP port unless this section
/// is present in `daemon.toml`. Defaults are tuned for "localhost browser
/// connecting to a single user's daemon"; cross-host deployments must set
/// `bind` + a TLS terminator in front.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpConfig {
    /// Socket address to bind. Use `127.0.0.1:0` (default) to pick an
    /// ephemeral loopback port — the actual port is written to
    /// `<config_dir>/amuxd.http.port` so clients can discover it.
    #[serde(default = "default_http_bind")]
    pub bind: String,
    /// Origins allowed by the CORS layer. `*` is rejected; supply
    /// concrete origins like `http://localhost:5173`. Empty list disables
    /// CORS (same-origin only).
    #[serde(default = "default_allowed_origins")]
    pub allowed_origins: Vec<String>,
    /// Idle session TTL. Sessions with no activity for this long are
    /// closed and removed from the registry.
    #[serde(default = "default_session_idle_ttl", with = "humantime_serde")]
    pub session_idle_ttl: std::time::Duration,
    /// SSE comment-frame heartbeat interval.
    #[serde(default = "default_heartbeat_interval", with = "humantime_serde")]
    pub heartbeat_interval: std::time::Duration,
    /// Max sessions a single session-token may own concurrently.
    #[serde(default = "default_max_sessions_per_token")]
    pub max_sessions_per_token: u32,
    /// Per-session event ring buffer size. Drives `Last-Event-ID` replay
    /// window — events beyond this point return `410 Gone`.
    #[serde(default = "default_max_event_backlog")]
    pub max_event_backlog: usize,
    /// Per-token request rate (sustained req/sec). Bursts allowed up to
    /// `rate_limit_burst`.
    #[serde(default = "default_rate_limit_rps")]
    pub rate_limit_rps: u32,
    #[serde(default = "default_rate_limit_burst")]
    pub rate_limit_burst: u32,
    /// Max concurrent SSE streams per token.
    #[serde(default = "default_max_sse_per_token")]
    pub max_sse_per_token: u32,
    /// Hard cap on POST body size in bytes (applies to /prompt etc.).
    #[serde(default = "default_max_body_bytes")]
    pub max_body_bytes: usize,
    /// Root-token file. Mode 0600. Auto-generated if missing on startup.
    #[serde(default)]
    pub token_file: Option<PathBuf>,
    /// File that receives the actually-bound port (useful when `bind`
    /// uses port 0). Defaults to `<config_dir>/amuxd.http.port`.
    #[serde(default)]
    pub port_file: Option<PathBuf>,
    /// Default scopes granted to session tokens minted via
    /// `POST /v1/auth/exchange` when the caller does not pass `scopes`.
    #[serde(default = "default_scopes")]
    pub default_scopes: Vec<String>,
}

fn default_allowed_origins() -> Vec<String> {
    // TeamClaw desktop (Tauri devUrl) and standalone Vite dev servers.
    vec![
        "http://127.0.0.1:1420".into(),
        "http://localhost:1420".into(),
        "http://127.0.0.1:5173".into(),
        "http://localhost:5173".into(),
        "http://tauri.localhost".into(),
        "tauri://localhost".into(),
        "https://tauri.localhost".into(),
    ]
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            bind: default_http_bind(),
            allowed_origins: default_allowed_origins(),
            session_idle_ttl: default_session_idle_ttl(),
            heartbeat_interval: default_heartbeat_interval(),
            max_sessions_per_token: default_max_sessions_per_token(),
            max_event_backlog: default_max_event_backlog(),
            rate_limit_rps: default_rate_limit_rps(),
            rate_limit_burst: default_rate_limit_burst(),
            max_sse_per_token: default_max_sse_per_token(),
            max_body_bytes: default_max_body_bytes(),
            token_file: None,
            port_file: None,
            default_scopes: default_scopes(),
        }
    }
}

fn default_http_bind() -> String {
    "127.0.0.1:0".into()
}
fn default_session_idle_ttl() -> std::time::Duration {
    std::time::Duration::from_secs(30 * 60)
}
fn default_heartbeat_interval() -> std::time::Duration {
    std::time::Duration::from_secs(15)
}
fn default_max_sessions_per_token() -> u32 {
    32
}
fn default_max_event_backlog() -> usize {
    1024
}
fn default_rate_limit_rps() -> u32 {
    20
}
fn default_rate_limit_burst() -> u32 {
    60
}
fn default_max_sse_per_token() -> u32 {
    8
}
fn default_max_body_bytes() -> usize {
    1024 * 1024
}
fn default_scopes() -> Vec<String> {
    // Least privilege: a token minted without an explicit `scopes` list can read
    // sessions/events/workspace config but must request `workspace:write`
    // explicitly to mutate provider/permission/MCP/skill/role state. The desktop
    // client always requests the scopes it needs, so this only narrows the
    // implicit fallback grant.
    vec![
        "sessions:read".into(),
        "sessions:write".into(),
        "events:read".into(),
        "workspace:read".into(),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MqttConfig {
    pub broker_url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

/// Top-level transport switch. When present and `kind = "nats"`, the
/// daemon connects to `url` instead of `mqtt.broker_url`. URL scheme
/// (`nats://`, `tls://`, `ws://`, `wss://`) is forwarded verbatim to
/// async-nats.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportConfig {
    #[serde(default = "default_transport_kind")]
    pub kind: TransportKind,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    Mqtt,
    Nats,
}

fn default_transport_kind() -> TransportKind {
    TransportKind::Mqtt
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default)]
    pub claude_code: Option<AgentBackendConfig>,
    #[serde(default)]
    pub opencode: Option<AgentBackendConfig>,
    #[serde(default)]
    pub codex: Option<AgentBackendConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBackendConfig {
    #[serde(default = "default_claude_binary")]
    pub binary: String,
    #[serde(default)]
    pub default_flags: Vec<String>,
}

fn default_claude_binary() -> String {
    "claude".into()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ChannelsConfig {
    #[serde(default)]
    pub discord: Option<DiscordChannel>,
    #[serde(default)]
    pub wecom: Option<WeComChannel>,
    #[serde(default)]
    pub feishu: Option<FeishuChannel>,
    #[serde(default)]
    pub kook: Option<KookChannel>,
    #[serde(default)]
    pub wechat: Option<WeChatChannel>,
    #[serde(default)]
    pub email: Option<EmailChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordChannel {
    pub enabled: bool,
    pub bot_token: String,
    #[serde(default)]
    pub default_username: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeComChannel {
    pub enabled: bool,
    /// WeCom bot id (QR-bound bot mode used by `teamclaw_gateway::wecom`).
    pub bot_id: String,
    pub secret: String,
    #[serde(default)]
    pub encoding_aes_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuChannel {
    pub enabled: bool,
    pub app_id: String,
    pub app_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KookChannel {
    pub enabled: bool,
    pub bot_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeChatChannel {
    pub enabled: bool,
    pub ilink_account: String,
    pub ilink_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailChannel {
    pub enabled: bool,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_user: String,
    pub imap_pass: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_user: String,
    pub smtp_pass: String,
    #[serde(default)]
    pub allowed_senders: Vec<String>,
}

impl DaemonConfig {
    pub fn config_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join(".amuxd")
    }

    pub fn legacy_config_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| Self::config_dir())
            .join("amux")
    }

    pub fn default_path() -> PathBuf {
        Self::migrate_legacy_file("daemon.toml")
    }

    pub fn migrate_legacy_file(file_name: &str) -> PathBuf {
        let path = Self::config_dir().join(file_name);
        let legacy_path = Self::legacy_config_dir().join(file_name);
        if !path.exists() && legacy_path.exists() {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::copy(&legacy_path, &path);
        }
        path
    }

    pub fn load(path: &Path) -> crate::error::Result<Self> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            crate::error::AmuxError::Config(format!("read {}: {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(|e| {
            crate::error::AmuxError::Config(format!("parse {}: {}", path.display(), e))
        })
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| crate::error::AmuxError::Config(e.to_string()))?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn pid_path() -> PathBuf {
        Self::config_dir().join("amuxd.pid")
    }

    pub fn lock_path() -> PathBuf {
        Self::config_dir().join("amuxd.lock")
    }

    pub fn sock_path() -> PathBuf {
        Self::config_dir().join("amuxd.sock")
    }

    pub fn http_token_path() -> PathBuf {
        Self::config_dir().join("amuxd.http.token")
    }

    pub fn http_port_path() -> PathBuf {
        Self::config_dir().join("amuxd.http.port")
    }
}

#[cfg(test)]
mod channels_tests {
    use super::*;
    #[test]
    fn channels_roundtrip_wecom() {
        let toml_src = r#"
[device]
id = "d1"
name = "Mac"

[mqtt]
broker_url = "tcp://localhost:1883"

[agents.opencode]
binary = "opencode"
default_flags = ["acp"]

[channels.wecom]
enabled = true
bot_id = "b1"
secret = "s"
encoding_aes_key = "k"
"#;
        let cfg: DaemonConfig = toml::from_str(toml_src).unwrap();
        assert!(cfg.channels.wecom.is_some());
        assert_eq!(cfg.channels.wecom.as_ref().unwrap().bot_id, "b1");
        assert_eq!(
            cfg.agents
                .opencode
                .as_ref()
                .map(|c| (c.binary.clone(), c.default_flags.clone())),
            Some(("opencode".to_string(), vec!["acp".to_string()]))
        );
    }
}

#[cfg(test)]
mod http_config_tests {
    use super::*;

    #[test]
    fn http_config_deserialize_empty_section_keeps_default_cors_origins() {
        let cfg: HttpConfig = toml::from_str(
            r#"
bind = "127.0.0.1:0"
"#,
        )
        .unwrap();
        assert!(cfg.allowed_origins.iter().any(|o| o.contains(":1420")));
        assert!(cfg.allowed_origins.iter().any(|o| o.contains("tauri.localhost")));
    }
}
