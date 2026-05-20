pub mod client;
pub mod topics;

pub use client::{ClientConfig, MqttClient};

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct MqttBusInner {
    pub client: Mutex<Option<MqttClient>>,
    pub subscribed: Mutex<HashSet<String>>,
    /// True only after the event loop has observed a CONNACK and not yet seen
    /// a network/disconnect error. The `client` handle being `Some(_)` only
    /// proves the wrapper struct exists — it can outlive a broken TCP/TLS
    /// connection, which is why we need this separate flag for honest UI
    /// status.
    pub connected: AtomicBool,
}

impl MqttBusInner {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            subscribed: Mutex::new(HashSet::new()),
            connected: AtomicBool::new(false),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    pub fn set_connected(&self, value: bool) {
        self.connected.store(value, Ordering::Release);
    }

    pub async fn force_reconnect(&self) {
        self.set_connected(false);
        if let Some(client) = self.client.lock().await.as_ref() {
            let _ = client.client.disconnect().await;
        }
    }
}

pub type MqttBus = Arc<MqttBusInner>;
