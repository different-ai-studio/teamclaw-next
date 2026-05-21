use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

const SERVICES_DEFAULTS_JSON: &str =
    include_str!("../../../config/services.default.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicesDefaults {
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub mqtt_host: String,
    pub mqtt_port: u16,
    pub mqtt_use_tls: bool,
}

impl ServicesDefaults {
    pub fn mqtt_broker_url(&self) -> String {
        let scheme = if self.mqtt_use_tls { "mqtts" } else { "mqtt" };
        format!("{scheme}://{}:{}", self.mqtt_host, self.mqtt_port)
    }
}

static DEFAULTS: LazyLock<ServicesDefaults> = LazyLock::new(|| {
    serde_json::from_str(SERVICES_DEFAULTS_JSON)
        .expect("config/services.default.json is malformed")
});

pub fn services_defaults() -> &'static ServicesDefaults {
    &DEFAULTS
}
