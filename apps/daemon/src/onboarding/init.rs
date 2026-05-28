use crate::backend::cloud_api::CloudApiBackend;
use crate::backend::{Backend, BackendError};
use crate::config::{AgentsConfig, DaemonConfig, DeviceConfig, MqttConfig};
use crate::onboarding::invite_url::{self, InviteUrlError, ParsedInvite};
use crate::provider_config::{CloudApiConfig, ProviderConfig};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use teamclaw_types::services_defaults::services_defaults;

fn default_mqtt_broker_url() -> String {
    services_defaults().mqtt_broker_url()
}

pub struct InitOutcome {
    pub actor_id: String,
    pub team_id: String,
    pub display_name: String,
    pub config_path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum OnboardingError {
    #[error("invite url: {0}")]
    Invite(#[from] InviteUrlError),
    #[error("backend: {0}")]
    Backend(#[from] BackendError),
    #[error("config: {0}")]
    Config(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Execute `amuxd init <teamclaw://invite?token=...>`:
///  1. parse token
///  2. anon-POST `/v1/invites/claim` → mint daemon actor + refresh_token
///  3. verify by trading refresh_token for an access_token
///  4. persist `backend.toml` with kind = "cloud_api"
///  5. write `daemon.toml` with the shared-broker defaults if absent, or
///     preserve the existing one's device.id while refreshing team_id
pub async fn run(raw_url: &str, config_path: Option<&Path>) -> Result<InitOutcome, OnboardingError> {
    let invite = invite_url::parse(raw_url)?;

    let cloud_url = cloud_api_url_from_env()?;

    // Anon claim: we don't have a refresh_token yet, so the dedicated
    // anon path POSTs without a bearer header.
    let anon_cfg = CloudApiConfig {
        url: cloud_url.clone(),
        refresh_token: String::new(),
        team_id: String::new(),
        actor_id: String::new(),
    };
    let claim_client = CloudApiBackend::new(anon_cfg);
    let claim = claim_client
        .claim_team_invite_anon(&invite.token)
        .await
        .map_err(actionable_invite_claim_error)?;

    let refresh_token = claim.refresh_token.clone().ok_or_else(|| {
        OnboardingError::Backend(BackendError::Provider {
            provider: "cloud_api",
            code: None,
            message: "claim_team_invite did not return a refresh token (kind=member?)".into(),
        })
    })?;

    let cfg = CloudApiConfig {
        url: cloud_url,
        refresh_token,
        team_id: claim.team_id.clone(),
        actor_id: claim.actor_id.clone(),
    };

    // Verify refresh → access works before persisting.
    let verify_client = CloudApiBackend::new(cfg.clone());
    verify_client.auth_token().await?;

    let path = match config_path {
        Some(p) => p.to_path_buf(),
        None => ProviderConfig::default_path()
            .map_err(|e| OnboardingError::Config(format!("backend config path: {e}")))?,
    };
    save_backend_toml(&path, &cfg)?;

    let daemon_path = DaemonConfig::default_path();
    let existing_daemon_cfg = DaemonConfig::load(&daemon_path).ok();
    let daemon_cfg = daemon_config_for_invite(
        existing_daemon_cfg,
        &claim.display_name,
        &claim.team_id,
        &claim.actor_id,
        &invite,
    );
    daemon_cfg
        .save(&daemon_path)
        .map_err(|e| OnboardingError::Config(format!("write daemon.toml: {e}")))?;

    Ok(InitOutcome {
        actor_id: claim.actor_id,
        team_id: claim.team_id,
        display_name: claim.display_name,
        config_path: path,
    })
}

/// Serialize a `CloudApiConfig` into the `[cloud_api]` section of a
/// `backend.toml` file at `path`.
fn save_backend_toml(path: &Path, cfg: &CloudApiConfig) -> Result<(), OnboardingError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = format!(
        "kind = \"cloud_api\"\n\n[cloud_api]\n\
         url = \"{}\"\n\
         refresh_token = \"{}\"\n\
         team_id = \"{}\"\n\
         actor_id = \"{}\"\n",
        cfg.url, cfg.refresh_token, cfg.team_id, cfg.actor_id,
    );
    std::fs::write(path, text)?;
    Ok(())
}

fn actionable_invite_claim_error(err: BackendError) -> OnboardingError {
    match err {
        BackendError::Provider {
            provider,
            code,
            message,
        } if message.contains("member claim requires authentication") => {
            OnboardingError::Backend(BackendError::Provider {
                provider,
                code,
                message: format!(
                    "{message}\nThis is a teammate/member invite. `amuxd init` requires an Agent invite; create one from the app's Invite dialog with Kind = Agent."
                ),
            })
        }
        other => OnboardingError::Backend(other),
    }
}

fn default_daemon_config(display_name: &str, actor_id: &str) -> DaemonConfig {
    DaemonConfig {
        device: DeviceConfig {
            id: actor_id.to_string(),
            name: display_name.to_string(),
        },
        mqtt: MqttConfig {
            broker_url: default_mqtt_broker_url(),
            username: None,
            password: None,
        },
        agents: AgentsConfig::default(),
        transport: None,
        team_id: None,
        channels: Default::default(),
        idle_runtime_timeout_secs: None,
        http: None,
    }
}

fn cloud_api_url_from_env() -> Result<String, OnboardingError> {
    let url = std::env::var("CLOUD_API_URL").ok();
    let dotenv = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(".env")).ok();
    cloud_api_url_with_dotenv(url.as_deref(), dotenv.as_deref())
}

#[cfg(test)]
fn cloud_api_url_from_env_for_test(url: Option<&str>) -> Result<String, OnboardingError> {
    cloud_api_url_with_dotenv(url, None)
}

fn cloud_api_url_with_dotenv(
    url: Option<&str>,
    dotenv: Option<&str>,
) -> Result<String, OnboardingError> {
    let dotenv = dotenv.map(parse_dotenv).unwrap_or_default();
    let url = url
        .or_else(|| dotenv.get("CLOUD_API_URL").map(String::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    url.map(str::to_string).ok_or_else(|| {
        OnboardingError::Config("CLOUD_API_URL env var required for `amuxd init`".into())
    })
}

fn parse_dotenv(contents: &str) -> HashMap<String, String> {
    contents
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), unquote_dotenv_value(value.trim())))
        })
        .collect()
}

fn unquote_dotenv_value(value: &str) -> String {
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn daemon_config_for_invite(
    existing: Option<DaemonConfig>,
    display_name: &str,
    team_id: &str,
    actor_id: &str,
    invite: &ParsedInvite,
) -> DaemonConfig {
    let mut daemon_cfg = existing.unwrap_or_else(|| default_daemon_config(display_name, actor_id));
    // device.id must equal actor_id — the broker's access-token hook
    // embeds ACL rules under `amux/{team}/device/{actor_id}/...`, so any
    // other value makes EMQX reject the daemon's CONNECT (LWT topic
    // denied).
    daemon_cfg.device.id = actor_id.to_string();
    daemon_cfg.team_id = Some(team_id.to_string());
    daemon_cfg.mqtt.broker_url = invite
        .broker_url
        .clone()
        .unwrap_or_else(default_mqtt_broker_url);
    daemon_cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_broker_url_overrides_default() {
        let cfg = daemon_config_for_invite(
            None,
            "macmini-5",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: Some("mqtts://broker.example.com:8883".into()),
            },
        );
        assert_eq!(cfg.team_id.as_deref(), Some("team-1"));
        assert_eq!(cfg.device.id, "actor-1");
        assert_eq!(cfg.device.name, "macmini-5");
        assert_eq!(cfg.mqtt.broker_url, "mqtts://broker.example.com:8883");
    }

    #[test]
    fn legacy_invite_uses_default_broker_url() {
        let cfg = daemon_config_for_invite(
            None,
            "macmini-5",
            "team-1",
            "actor-1",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: None,
            },
        );
        assert_eq!(cfg.mqtt.broker_url, default_mqtt_broker_url());
    }

    #[test]
    fn existing_device_id_is_replaced_with_actor_id() {
        // device.id MUST equal actor_id — EMQX rejects any other value
        // because the JWT ACL is keyed on actor_id. Re-init with a
        // different actor must overwrite a stale device.id.
        let cfg = daemon_config_for_invite(
            Some(DaemonConfig {
                device: DeviceConfig {
                    id: "stale-device-uuid".into(),
                    name: "existing-device".into(),
                },
                mqtt: MqttConfig {
                    broker_url: "mqtts://old.example.com:8883".into(),
                    username: None,
                    password: None,
                },
                agents: AgentsConfig::default(),
                transport: None,
                team_id: Some("team-old".into()),
                channels: Default::default(),
                idle_runtime_timeout_secs: None,
                http: None,
            }),
            "new-display-name",
            "team-2",
            "actor-2",
            &ParsedInvite {
                token: "tok".into(),
                broker_url: Some("mqtts://broker.example.com:8883".into()),
            },
        );
        assert_eq!(cfg.device.id, "actor-2");
        assert_eq!(cfg.device.name, "existing-device");
        assert_eq!(cfg.team_id.as_deref(), Some("team-2"));
        assert_eq!(cfg.mqtt.broker_url, "mqtts://broker.example.com:8883");
    }

    #[test]
    fn member_invite_claim_error_explains_agent_invite_requirement() {
        let err = actionable_invite_claim_error(BackendError::Provider {
            provider: "cloud_api",
            code: Some("401".into()),
            message: r#"{"message":"member claim requires authentication"}"#.into(),
        });

        match err {
            OnboardingError::Backend(BackendError::Provider { message, .. }) => {
                assert!(message.contains("Kind = Agent"));
                assert!(message.contains("member claim requires authentication"));
            }
            other => panic!("expected backend/provider error, got {other:?}"),
        }
    }

    #[test]
    fn cloud_api_build_env_reports_missing_url_at_runtime() {
        let err = cloud_api_url_from_env_for_test(None).unwrap_err();
        assert!(err.to_string().contains("CLOUD_API_URL"));
    }

    #[test]
    fn cloud_api_build_env_uses_supplied_value() {
        let url = cloud_api_url_from_env_for_test(Some("https://fc.example.com")).unwrap();
        assert_eq!(url, "https://fc.example.com");
    }

    #[test]
    fn cloud_api_build_env_loads_missing_value_from_dotenv_text() {
        let url = cloud_api_url_with_dotenv(
            None,
            Some(
                r#"
CLOUD_API_URL=https://fc.example.com
"#,
            ),
        )
        .unwrap();
        assert_eq!(url, "https://fc.example.com");
    }

    #[test]
    fn cloud_api_build_env_prefers_process_value_over_dotenv_text() {
        let url = cloud_api_url_with_dotenv(
            Some("https://process.example.com"),
            Some(
                r#"
CLOUD_API_URL=https://dotenv.example.com
"#,
            ),
        )
        .unwrap();
        assert_eq!(url, "https://process.example.com");
    }

    #[test]
    fn cloud_api_build_env_rejects_empty_dotenv_value() {
        let err = cloud_api_url_with_dotenv(
            None,
            Some(
                r#"
CLOUD_API_URL=
"#,
            ),
        )
        .unwrap_err();
        assert!(err.to_string().contains("CLOUD_API_URL"));
    }
}
