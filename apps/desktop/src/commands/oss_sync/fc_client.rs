//! FC Sync API client — reqwest-based HTTP client with JWT injection
//! and FC error code mapping.
//!
//! All endpoints use `Authorization: Bearer <supabase-jwt>`.
//! FC custom PostgreSQL error codes:
//!   P0409 → SyncError::Conflict
//!   P0403 → SyncError::Auth
//!   P0410 → SyncError::SessionExpired

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::SyncError;

/// A single manifest item returned by /sync/manifest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestItem {
    pub path: String,
    pub version: i32,
    /// cipher_hash of the blob (sha256 of encrypted bytes)
    pub content_hash: Option<String>,
    pub size: Option<i64>,
    pub deleted: bool,
    pub change_seq: i64,
    pub updated_at: Option<String>,
}

/// One page of manifest results.
#[derive(Debug, Clone)]
pub struct ManifestPage {
    pub snapshot_seq: i64,
    pub items: Vec<ManifestItem>,
    pub next_cursor: Option<String>,
}

/// Result of /sync/upload/prepare.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResult {
    pub upload_session_id: String,
    pub oss_key: String,
    pub requires_upload: bool,
    pub presigned_put: Option<String>,
}

/// Result of /sync/upload/complete.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteResult {
    pub version: i32,
    pub content_hash: String,
    pub change_seq: i64,
}

/// Result of /sync/download.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub download_url: String,
    pub size: i64,
    pub ttl_sec: u64,
}

/// One version history entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: i32,
    pub parent_version: i32,
    pub content_hash: Option<String>,
    pub size: i64,
    pub deleted: bool,
    pub created_by: Option<String>,
    pub created_by_node_id: Option<String>,
    pub created_at: String,
    pub message: Option<String>,
}

/// Result of POST /v1/teams.
///
/// The Cloud API response shape: `{ id, name, slug, createdAt, aiGatewayEndpoint, litellmKey }`.
/// `aiGatewayEndpoint` and `litellmKey` are nullable when LiteLLM provisioning
/// is skipped (e.g. local dev with LITELLM_MASTER_KEY unset).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamResult {
    #[serde(rename = "id")]
    pub team_id: String,
    #[serde(rename = "slug")]
    pub team_slug: String,
    #[serde(default)]
    pub ai_gateway_endpoint: Option<String>,
    #[serde(default)]
    pub litellm_key: Option<String>,
}

pub struct FcClient {
    pub client: Client,
    pub base_url: String,
    pub jwt: String,
}

impl FcClient {
    pub fn new(base_url: String, jwt: String) -> Self {
        Self {
            client: Client::new(),
            base_url,
            jwt,
        }
    }

    /// POST /v1/teams — unified team creation. Provisions LiteLLM team + key
    /// server-side and seeds team_workspace_config in one call. The legacy
    /// `/sync/create-team` endpoint was removed in 2026-05.
    ///
    /// `node_id` is accepted for backward compatibility with the previous
    /// signature but is no longer forwarded — the /v1/teams handler derives
    /// the owning actor's node from the JWT-authenticated user.
    pub async fn create_team(
        &self,
        team_name: &str,
        _node_id: Option<&str>,
    ) -> Result<CreateTeamResult, SyncError> {
        let body = serde_json::json!({ "name": team_name });
        let resp = self.post("/v1/teams", &body).await?;
        Ok(resp)
    }

    /// POST /sync/manifest — one page.
    pub async fn manifest(
        &self,
        team_id: &str,
        after_seq: i64,
        cursor: Option<String>,
        snapshot_seq: Option<i64>,
    ) -> Result<ManifestPage, SyncError> {
        let mut body = serde_json::json!({
            "teamId": team_id,
            "afterSeq": after_seq,
        });
        if let Some(c) = cursor {
            body["cursor"] = Value::String(c);
        }
        if let Some(s) = snapshot_seq {
            body["snapshotSeq"] = Value::Number(s.into());
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawPage {
            snapshot_seq: i64,
            items: Vec<ManifestItem>,
            next_cursor: Option<String>,
        }

        let page: RawPage = self.post("/sync/manifest", &body).await?;
        Ok(ManifestPage {
            snapshot_seq: page.snapshot_seq,
            items: page.items,
            next_cursor: page.next_cursor,
        })
    }

    /// POST /sync/upload/prepare
    pub async fn upload_prepare(
        &self,
        team_id: &str,
        path: &str,
        parent_version: i32,
        content_hash: &str,
        size: u64,
        node_id: Option<&str>,
    ) -> Result<PrepareResult, SyncError> {
        let mut body = serde_json::json!({
            "teamId": team_id,
            "path": path,
            "parentVersion": parent_version,
            "contentHash": content_hash,
            "size": size,
        });
        if let Some(nid) = node_id {
            body["nodeId"] = Value::String(nid.to_string());
        }
        self.post("/sync/upload/prepare", &body).await
    }

    /// PUT blob to presigned URL.
    pub async fn put_blob(&self, presigned_url: &str, data: Vec<u8>) -> Result<(), SyncError> {
        let resp = self
            .client
            .put(presigned_url)
            .body(data)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "PUT blob failed: HTTP {}",
                resp.status()
            )));
        }
        Ok(())
    }

    /// POST /sync/upload/complete
    pub async fn upload_complete(
        &self,
        team_id: &str,
        upload_session_id: &str,
    ) -> Result<CompleteResult, SyncError> {
        let body = serde_json::json!({
            "teamId": team_id,
            "uploadSessionId": upload_session_id,
        });
        self.post("/sync/upload/complete", &body).await
    }

    /// POST /sync/download
    pub async fn download(
        &self,
        team_id: &str,
        content_hash: &str,
    ) -> Result<DownloadResult, SyncError> {
        let body = serde_json::json!({
            "teamId": team_id,
            "contentHash": content_hash,
        });
        self.post("/sync/download", &body).await
    }

    /// GET blob from presigned URL, verifying cipher_hash after download.
    pub async fn get_blob(
        &self,
        download_url: &str,
        expected_cipher_hash: &str,
    ) -> Result<Vec<u8>, SyncError> {
        let resp = self
            .client
            .get(download_url)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(SyncError::Network(format!(
                "GET blob failed: HTTP {}",
                resp.status()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?
            .to_vec();

        let actual_hash = super::crypto::sha256_hex(&bytes);
        if actual_hash != expected_cipher_hash {
            return Err(SyncError::HashMismatch {
                expected: expected_cipher_hash.to_string(),
                actual: actual_hash,
            });
        }
        Ok(bytes)
    }

    /// POST /sync/delete
    pub async fn delete_file(
        &self,
        team_id: &str,
        path: &str,
        parent_version: i32,
        node_id: Option<&str>,
    ) -> Result<(), SyncError> {
        let mut body = serde_json::json!({
            "teamId": team_id,
            "path": path,
            "parentVersion": parent_version,
        });
        if let Some(nid) = node_id {
            body["nodeId"] = Value::String(nid.to_string());
        }
        #[derive(Deserialize)]
        struct DeleteResp {}
        let _: DeleteResp = self.post("/sync/delete", &body).await?;
        Ok(())
    }

    /// GET /sync/versions — returns (versions, nextCursor).
    pub async fn list_versions(
        &self,
        team_id: &str,
        path: &str,
        cursor: Option<String>,
    ) -> Result<(Vec<VersionInfo>, Option<String>), SyncError> {
        let mut url = format!(
            "{}/sync/versions?teamId={}&path={}",
            self.base_url,
            urlencoding_simple(team_id),
            urlencoding_simple(path)
        );
        if let Some(c) = cursor {
            url.push_str(&format!("&cursor={}", urlencoding_simple(&c)));
        }
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct VersionsResp {
            versions: Vec<VersionInfo>,
            #[serde(default)]
            next_cursor: Option<String>,
        }
        let parsed: VersionsResp = map_fc_response(resp).await?;
        Ok((parsed.versions, parsed.next_cursor))
    }

    /// POST /sync/set-mode — owner-only sync_mode switch (Tranche 5).
    pub async fn set_team_sync_mode(&self, team_id: &str, mode: &str) -> Result<String, SyncError> {
        let body = serde_json::json!({ "teamId": team_id, "mode": mode });
        #[derive(serde::Deserialize)]
        struct ModeResp {
            mode: String,
        }
        let resp: ModeResp = self.post("/sync/set-mode", &body).await?;
        Ok(resp.mode)
    }

    /// POST /sync/team-mode — read sync_mode (Tranche 5).
    pub async fn get_team_sync_mode(&self, team_id: &str) -> Result<Option<String>, SyncError> {
        let body = serde_json::json!({ "teamId": team_id });
        #[derive(serde::Deserialize)]
        struct ModeResp {
            mode: Option<String>,
        }
        let resp: ModeResp = self.post("/sync/team-mode", &body).await?;
        Ok(resp.mode)
    }

    /// Generic POST helper for ad-hoc endpoints (e.g. team_share enable flow).
    /// Returns the raw JSON value on 2xx; surfaces FC error envelope on non-2xx.
    pub async fn post_json(&self, path: &str, body: &Value) -> Result<Value, SyncError> {
        self.post(path, body).await
    }

    /// Generic GET helper. Returns raw JSON value on 2xx.
    pub async fn get_json(&self, path: &str) -> Result<Value, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        map_fc_response(resp).await
    }

    /// Internal POST helper with JWT injection and error mapping.
    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
    ) -> Result<T, SyncError> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.jwt))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;
        map_fc_response(resp).await
    }
}

/// Map an HTTP response to `T` or `SyncError`, handling FC custom error codes.
async fn map_fc_response<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, SyncError> {
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if status.is_success() {
        serde_json::from_slice(&bytes)
            .map_err(|e| SyncError::Internal(format!("response parse failed: {e}")))
    } else {
        // Try to parse FC error envelope { error, code, reason, remoteVersion, remoteHash, ... }
        let body: Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let code = body["code"].as_str().unwrap_or("");
        let reason = body["reason"].as_str().unwrap_or("");

        // 409 CAS mismatch
        if status.as_u16() == 409 || code == "P0409" || reason == "cas-mismatch" {
            let remote_version = body["remoteVersion"].as_i64().map(|v| v as i32);
            let remote_cipher_hash = body["remoteHash"].as_str().map(|s| s.to_string());
            return Err(SyncError::Conflict {
                remote_version,
                remote_cipher_hash,
            });
        }

        // Auth errors
        if status.as_u16() == 403 || code == "P0403" {
            return Err(SyncError::Auth(
                body["error"].as_str().unwrap_or("forbidden").to_string(),
            ));
        }

        // Session expired / gone
        if status.as_u16() == 410 || code == "P0410" {
            return Err(SyncError::SessionExpired(
                body["error"]
                    .as_str()
                    .unwrap_or("session expired")
                    .to_string(),
            ));
        }

        // Path validation
        if status.as_u16() == 422 {
            return Err(SyncError::InvalidPath(
                body["error"].as_str().unwrap_or("invalid path").to_string(),
            ));
        }

        Err(SyncError::Internal(format!(
            "FC returned HTTP {}: {}",
            status,
            body["error"].as_str().unwrap_or("<no error message>")
        )))
    }
}

fn urlencoding_simple(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
}
