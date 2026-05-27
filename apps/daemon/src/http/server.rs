//! axum HTTP server lifecycle.
//!
//! Exposes [`spawn`] — the single entry point the daemon's main loop calls
//! to bind a listener, install middleware (CORS, tracing, request id), and
//! drive the router until a shutdown signal arrives. Returns an
//! [`HttpHandle`] the caller can drop / `shutdown()` to tear the server
//! down cleanly.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::config::{DaemonConfig, HttpConfig};

use super::cors;
use super::routes;
use super::state::{DaemonMetadata, HttpState};
use super::tokens::{self, TokenStore};

/// Handle returned by [`spawn`]. Drop or [`HttpHandle::shutdown`] to stop
/// the listener. The handle also exposes the actually-bound port for tests
/// and for clients that need to log it.
pub struct HttpHandle {
    pub local_addr: SocketAddr,
    pub tokens: TokenStore,
    join: JoinHandle<()>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl HttpHandle {
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        let _ = (&mut self.join).await;
    }
}

impl Drop for HttpHandle {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        self.join.abort();
    }
}

/// Spawn the HTTP listener. Errors surface as `anyhow::Result` because
/// the daemon's startup path uses that as the lingua franca for early
/// bring-up failures.
pub async fn spawn(http: HttpConfig, meta: DaemonMetadata) -> anyhow::Result<HttpHandle> {
    // Resolve token + port files (defaults live in DaemonConfig::config_dir).
    let token_path = http
        .token_file
        .clone()
        .unwrap_or_else(DaemonConfig::http_token_path);
    let port_path = http
        .port_file
        .clone()
        .unwrap_or_else(DaemonConfig::http_port_path);

    let tokens =
        TokenStore::load_or_init(&token_path).map_err(|e| anyhow::anyhow!("token store: {e}"))?;

    // Parse + bind. Bind first, log second — surfaces address-in-use early.
    let addr: SocketAddr = http
        .bind
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid http.bind {:?}: {e}", http.bind))?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| anyhow::anyhow!("bind {addr}: {e}"))?;
    let local_addr = listener.local_addr()?;
    tokens::write_port_file(&port_path, local_addr.port());

    tracing::info!(
        bind = %local_addr,
        token_path = %token_path.display(),
        port_path = %port_path.display(),
        "http listener ready"
    );

    // CORS layer must be added before the router is materialised so it
    // sees preflight requests.
    let cors_layer = cors::build(&http.allowed_origins)
        .map_err(|e| anyhow::anyhow!("cors build: {}", e.detail))?;

    let state = HttpState::new(http, tokens.clone(), meta);
    let mut app: Router = routes::build(state);
    if let Some(layer) = cors_layer {
        app = app.layer(layer);
    }

    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let join = tokio::spawn(async move {
        let server = axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
        if let Err(e) = server.await {
            tracing::error!("http listener exited with error: {e}");
        } else {
            tracing::info!("http listener shut down cleanly");
        }
    });

    Ok(HttpHandle {
        local_addr,
        tokens,
        join,
        shutdown_tx: Some(shutdown_tx),
    })
}

/// Convenience helper: capture the metadata most callers want without
/// pulling DaemonConfig types into every module.
pub fn metadata(actor_id: String, backend_kind: impl Into<String>) -> DaemonMetadata {
    DaemonMetadata {
        version: env!("CARGO_PKG_VERSION"),
        started_at: chrono::Utc::now(),
        actor_id,
        backend_kind: backend_kind.into(),
    }
}

#[allow(dead_code)]
fn _arc_size_check() {
    // Force HttpState clone to be cheap (Arc fields only).
    fn assert_send<T: Send + Sync>(_: &T) {}
    let h = HttpConfig::default();
    assert_send(&Arc::new(h));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HttpConfig;

    #[tokio::test]
    async fn spawn_and_healthz_responds() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            allowed_origins: vec![],
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let meta = metadata("actor-test".into(), "test");
        let handle = spawn(cfg, meta).await.unwrap();
        let url = format!("http://{}/v1/healthz", handle.local_addr);
        let body: serde_json::Value = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert_eq!(body["status"], "ok");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn auth_exchange_requires_root_and_returns_token() {
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(token_path.clone()),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let meta = metadata("actor-x".into(), "test");
        let handle = spawn(cfg, meta).await.unwrap();
        let base = format!("http://{}", handle.local_addr);
        let root_token = std::fs::read_to_string(&token_path).unwrap();
        let root_token = root_token.trim();
        let client = reqwest::Client::new();

        // Without auth → 401.
        let resp = client
            .post(format!("{base}/v1/auth/exchange"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        assert_eq!(
            resp.headers().get("content-type").unwrap(),
            "application/problem+json"
        );

        // With root token → 200 + session token.
        let resp: serde_json::Value = client
            .post(format!("{base}/v1/auth/exchange"))
            .bearer_auth(root_token)
            .json(&serde_json::json!({"scopes":["sessions:read"], "ttl_seconds": 600}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let session_token = resp["token"].as_str().unwrap().to_string();
        assert!(!session_token.is_empty());
        assert_eq!(resp["scopes"][0], "sessions:read");

        // Session token is rejected by the root-protected endpoint.
        let resp = client
            .get(format!("{base}/v1/auth/tokens"))
            .bearer_auth(&session_token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 401);

        // But the listing succeeds with the root token.
        let listed: serde_json::Value = client
            .get(format!("{base}/v1/auth/tokens"))
            .bearer_auth(root_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed["tokens"].as_array().unwrap().len(), 1);

        handle.shutdown().await;
    }

    #[tokio::test]
    async fn info_endpoint_includes_actor() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = HttpConfig {
            bind: "127.0.0.1:0".into(),
            token_file: Some(dir.path().join("token")),
            port_file: Some(dir.path().join("port")),
            ..HttpConfig::default()
        };
        let meta = metadata("actor-abc".into(), "pocketbase");
        let handle = spawn(cfg, meta).await.unwrap();
        let url = format!("http://{}/v1/info", handle.local_addr);
        let body: serde_json::Value = reqwest::get(&url).await.unwrap().json().await.unwrap();
        assert_eq!(body["actor_id"], "actor-abc");
        assert_eq!(body["backend_kind"], "pocketbase");
        assert!(body["uptime_seconds"].as_i64().unwrap() >= 0);
        handle.shutdown().await;
    }
}
