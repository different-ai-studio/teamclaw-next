use super::super::{BackendError, BackendResult};
use crate::provider_config::CloudApiConfig;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── HTTP helpers ─────────────────────────────────────────────────────────────

pub(super) fn network_error(error: reqwest::Error) -> BackendError {
    BackendError::Provider {
        provider: "cloud_api",
        code: None,
        message: error.to_string(),
    }
}

pub(super) fn request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(super) fn decode_error(status: StatusCode, envelope: Option<CloudErrorEnvelope>) -> BackendError {
    if status == StatusCode::UNAUTHORIZED {
        return BackendError::Auth(
            envelope
                .map(|e| e.error.message)
                .unwrap_or_else(|| "Cloud API unauthorized".to_string()),
        );
    }
    if status == StatusCode::NOT_FOUND {
        return BackendError::NotFound(
            envelope
                .map(|e| e.error.message)
                .unwrap_or_else(|| "not found".to_string()),
        );
    }
    BackendError::Provider {
        provider: "cloud_api",
        code: envelope.as_ref().and_then(|e| e.error.code.clone()),
        message: envelope
            .map(|e| e.error.message)
            .unwrap_or_else(|| format!("Cloud API request failed with status {status}")),
    }
}

pub(super) async fn decode_response<T>(resp: reqwest::Response) -> BackendResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(network_error)?;
    if status.is_success() {
        return serde_json::from_slice(&bytes).map_err(BackendError::from);
    }
    let envelope = serde_json::from_slice::<CloudErrorEnvelope>(&bytes).ok();
    Err(decode_error(status, envelope))
}

#[derive(Deserialize)]
pub(super) struct CloudErrorEnvelope {
    pub(super) error: CloudErrorBody,
}

#[derive(Deserialize)]
pub(super) struct CloudErrorBody {
    pub(super) code: Option<String>,
    pub(super) message: String,
}

// ── Token ─────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub(super) struct RefreshRequest<'a> {
    #[serde(rename = "refreshToken")]
    pub(super) refresh_token: &'a str,
}

/// Token response — accepts both Supabase snake_case (`access_token`) and
/// Cloud API camelCase (`accessToken`) via serde aliases.
#[derive(Deserialize)]
pub(super) struct TokenResponse {
    #[serde(alias = "accessToken")]
    pub(super) access_token: String,
}

pub(super) fn refresh_failure_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error_description")
                .or_else(|| value.get("msg"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| "failed to refresh access token".to_string())
}

// ── Cloud URL helper ───────────────────────────────────────────────────────────

pub(super) fn cloud_url(cfg: &CloudApiConfig, path: &str) -> String {
    format!(
        "{}{}",
        cfg.url.trim_end_matches('/'),
        if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        }
    )
}

pub(super) fn empty_to_none(value: &str) -> Option<&str> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}
