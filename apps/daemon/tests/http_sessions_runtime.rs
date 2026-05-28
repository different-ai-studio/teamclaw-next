#[path = "../src/backend/mod.rs"]
mod backend;
#[path = "../src/config/mod.rs"]
mod config;
#[path = "../src/error.rs"]
mod error;
#[path = "../src/http/mod.rs"]
mod http;
#[path = "../src/proto.rs"]
mod proto;
#[path = "../src/provider_config.rs"]
mod provider_config;
#[path = "../src/runtime/mod.rs"]
mod runtime;
#[path = "../src/supabase/mod.rs"]
mod supabase;

use std::sync::Arc;
use std::time::Duration;

use config::HttpConfig;
use http::events::SessionEvent;
use http::runtime_adapter::RuntimeManagerAdapter;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct CreatedSession {
    session_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct PromptAck {
    turn_id: Uuid,
}

struct TestApp {
    _handle: http::HttpHandle,
    client: Client,
    base: String,
    session_token: String,
}

impl TestApp {
    async fn create_session(&self, agent_type: &str, workspace_id: Option<&str>) -> CreatedSession {
        self.client
            .post(format!("{}/v1/sessions", self.base))
            .bearer_auth(&self.session_token)
            .json(&serde_json::json!({
                "agent_type": agent_type,
                "workspace_id": workspace_id,
            }))
            .send()
            .await
            .expect("create session response")
            .error_for_status()
            .expect("create session status")
            .json()
            .await
            .expect("create session body")
    }

    async fn send_prompt(&self, session_id: Uuid, text: &str) -> PromptAck {
        self.client
            .post(format!("{}/v1/sessions/{session_id}/prompt", self.base))
            .bearer_auth(&self.session_token)
            .json(&serde_json::json!({ "text": text }))
            .send()
            .await
            .expect("send prompt response")
            .error_for_status()
            .expect("send prompt status")
            .json()
            .await
            .expect("send prompt body")
    }

    async fn collect_events(&self, session_id: Uuid, turn_id: Uuid) -> Vec<SessionEvent> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let turn_id = turn_id.to_string();
        loop {
            let body: Value = self
                .client
                .get(format!(
                    "{}/v1/sessions/{session_id}/events?since=0",
                    self.base
                ))
                .bearer_auth(&self.session_token)
                .send()
                .await
                .expect("events response")
                .error_for_status()
                .expect("events status")
                .json()
                .await
                .expect("events body");
            let events: Vec<SessionEvent> =
                serde_json::from_value(body["events"].clone()).expect("events payload");
            if events.iter().any(|event| {
                event.kind.as_str() == "turn.finished"
                    && event.data.get("turn_id").and_then(Value::as_str) == Some(turn_id.as_str())
            }) {
                return events;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for turn.finished: {body}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

async fn test_app_with_runtime_adapter() -> TestApp {
    let dir = tempfile::tempdir().expect("tempdir");
    let token_path = dir.path().join("token");
    let cfg = HttpConfig {
        bind: "127.0.0.1:0".into(),
        token_file: Some(token_path.clone()),
        port_file: Some(dir.path().join("port")),
        heartbeat_interval: Duration::from_secs(5),
        ..HttpConfig::default()
    };
    let manager = Arc::new(Mutex::new(runtime::RuntimeManager::new(
        std::collections::HashMap::new(),
        None,
    )));
    let runtime = RuntimeManagerAdapter::new(manager, 256);
    let handle = http::spawn(cfg, http::server::metadata("actor".into(), "test"), runtime)
        .await
        .expect("spawn http server");
    let base = format!("http://{}", handle.local_addr);
    let root = std::fs::read_to_string(&token_path)
        .expect("read root token")
        .trim()
        .to_owned();
    let client = Client::new();
    let resp: Value = client
        .post(format!("{base}/v1/auth/exchange"))
        .bearer_auth(&root)
        .json(&serde_json::json!({ "ttl_seconds": 3600 }))
        .send()
        .await
        .expect("exchange response")
        .error_for_status()
        .expect("exchange status")
        .json()
        .await
        .expect("exchange body");
    let session_token = resp["token"].as_str().expect("session token").to_string();
    std::mem::forget(dir);

    TestApp {
        _handle: handle,
        client,
        base,
        session_token,
    }
}

#[tokio::test]
async fn session_prompt_streams_runtime_events_from_real_adapter() {
    let app = test_app_with_runtime_adapter().await;

    let created = app.create_session("opencode", Some("ws-1")).await;
    let ack = app.send_prompt(created.session_id, "hello from test").await;
    let events = app.collect_events(created.session_id, ack.turn_id).await;

    assert!(events.iter().any(|e| e.kind.as_str() == "prompt.accepted"));
    assert!(events.iter().any(|e| e.kind.as_str() == "turn.started"));
    assert!(events
        .iter()
        .any(|e| e.kind.as_str() == "message.completed"));
    assert!(events.iter().any(|e| e.kind.as_str() == "turn.finished"));
}
