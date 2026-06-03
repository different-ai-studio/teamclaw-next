use anyhow::Result;
use rumqttc::{AsyncClient, EventLoop, LastWill, MqttOptions, QoS, TlsConfiguration, Transport};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

pub struct ClientConfig {
    pub broker_host: String,
    pub broker_port: u16,
    pub client_id: String,
    pub username: String,
    pub password: String,
    pub team_id: String,
    pub use_tls: bool,
}

pub struct MqttClient {
    pub client: AsyncClient,
    pub event_loop: Arc<Mutex<EventLoop>>,
    pub client_id: String,
}

impl MqttClient {
    pub fn connect(cfg: ClientConfig) -> Result<Self> {
        let mut opts = MqttOptions::new(&cfg.client_id, &cfg.broker_host, cfg.broker_port);
        opts.set_credentials(&cfg.username, &cfg.password);
        opts.set_clean_session(false);
        opts.set_keep_alive(Duration::from_secs(30));
        // Attachments + ACP events can be a few hundred KB. Keep room.
        opts.set_max_packet_size(4 * 1024 * 1024, 4 * 1024 * 1024);

        if cfg.use_tls {
            // `TlsConfiguration::default()` (use-rustls) loads the OS native
            // trust roots and builds a `ClientConfig` with no client auth.
            // Good enough for connecting to a public broker over TLS.
            opts.set_transport(Transport::tls_with_config(TlsConfiguration::default()));
        }

        let lwt_topic = super::topics::actor_state(&cfg.team_id, &cfg.client_id);
        let lwt_payload = serde_json::json!({"status":"offline"})
            .to_string()
            .into_bytes();
        opts.set_last_will(LastWill::new(
            lwt_topic,
            lwt_payload,
            QoS::AtLeastOnce,
            true,
        ));

        let (client, event_loop) = AsyncClient::new(opts, 64);
        Ok(Self {
            client,
            event_loop: Arc::new(Mutex::new(event_loop)),
            client_id: cfg.client_id,
        })
    }
}

pub async fn run_event_loop(bus: Arc<super::MqttBusInner>, app: tauri::AppHandle, generation: u64) {
    use rumqttc::{Event, Packet};
    use tauri::Emitter;

    let mut backoff_secs: u64 = 1;
    loop {
        if bus.current_generation() != generation {
            return;
        }
        let event_loop_arc = {
            let guard = bus.client.lock().await;
            guard.as_ref().map(|c| c.event_loop.clone())
        };
        if bus.current_generation() != generation {
            return;
        }
        let Some(event_loop) = event_loop_arc else {
            if bus.current_generation() != generation {
                return;
            }
            bus.set_connected(false);
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        let mut event_loop = event_loop.lock().await;
        let poll_result = event_loop.poll().await;
        if bus.current_generation() != generation {
            return;
        }
        match poll_result {
            Ok(Event::Incoming(Packet::ConnAck(ack))) => {
                backoff_secs = 1;
                bus.set_connected(true);
                tracing::info!("mqtt CONNACK: {:?}", ack.code);
                let _ = app.emit("mqtt:connected", true);
            }
            Ok(Event::Incoming(Packet::Disconnect)) => {
                bus.set_connected(false);
                tracing::warn!("mqtt broker sent DISCONNECT");
                let _ = app.emit("mqtt:connected", false);
            }
            Ok(Event::Incoming(Packet::Publish(p))) => {
                backoff_secs = 1;
                let payload = serde_json::json!({
                    "topic": p.topic,
                    "bytes": p.payload.to_vec(),
                });
                let _ = app.emit("mqtt:envelope", payload);
            }
            Ok(_) => {
                backoff_secs = 1;
            }
            Err(e) => {
                bus.set_connected(false);
                let _ = app.emit("mqtt:connected", false);
                tracing::warn!("mqtt event loop error: {e}, retry in {backoff_secs}s");
                drop(event_loop);
                tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                backoff_secs = (backoff_secs * 2).min(60);
            }
        }
    }
}
