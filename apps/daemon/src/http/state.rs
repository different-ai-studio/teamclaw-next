//! Shared application state for the HTTP layer.
//!
//! `HttpState` is the single `Arc`-wrapped bundle the axum router hangs
//! every handler off. Keep it small and trait-object-friendly: handlers
//! that need fine-grained pieces extract from this struct rather than
//! introducing parallel statics.

use std::sync::Arc;

use crate::config::HttpConfig;

use super::tokens::TokenStore;

/// Process metadata surfaced via `/v1/info`. Filled in at startup and
/// treated as immutable thereafter.
#[derive(Debug, Clone)]
pub struct DaemonMetadata {
    pub version: &'static str,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub actor_id: String,
    pub backend_kind: String,
}

#[derive(Clone)]
pub struct HttpState {
    pub config: Arc<HttpConfig>,
    pub tokens: TokenStore,
    pub meta: Arc<DaemonMetadata>,
}

impl HttpState {
    pub fn new(config: HttpConfig, tokens: TokenStore, meta: DaemonMetadata) -> Self {
        Self {
            config: Arc::new(config),
            tokens,
            meta: Arc::new(meta),
        }
    }
}
