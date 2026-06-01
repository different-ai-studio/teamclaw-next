//! In-daemon OpenCode **settings** HTTP surface (`opencode serve`).
//!
//! Chat/session traffic uses the ACP runtime; provider OAuth and auth-method
//! discovery use a short-lived loopback `opencode serve` per workspace, with
//! XDG dirs isolated under `<workspace>/.opencode/` (same layout as desktop).

mod client;
mod pool;

pub use client::{LiveProviderCatalog, LiveProviderSummary, OpenCodeSettingsClient};
pub use pool::OpenCodeSettingsService;

use std::path::Path;

use crate::config::provider_auth::{
    merge_live_provider_auth_methods, ProviderAuthMethodsResponse,
};

#[derive(Debug)]
pub enum OpenCodeSettingsError {
    OpencodeBinaryMissing(String),
    SpawnFailed(String),
    StartTimeout,
    Http(String),
    Api { status: u16, detail: String },
}

impl std::fmt::Display for OpenCodeSettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpencodeBinaryMissing(msg) => write!(f, "opencode binary not found: {msg}"),
            Self::SpawnFailed(msg) => write!(f, "failed to start opencode serve: {msg}"),
            Self::StartTimeout => write!(f, "opencode serve did not become ready in time"),
            Self::Http(msg) => write!(f, "opencode settings http: {msg}"),
            Self::Api { status, detail } => write!(f, "opencode settings api {status}: {detail}"),
        }
    }
}

impl std::error::Error for OpenCodeSettingsError {}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OAuthAuthorizeResult {
    pub url: String,
    pub method: String,
    pub instructions: String,
}

impl OpenCodeSettingsService {
    pub async fn provider_auth_methods(
        &self,
        workspace: &Path,
    ) -> Result<ProviderAuthMethodsResponse, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        let live = client.fetch_provider_auth_methods().await?;
        Ok(merge_live_provider_auth_methods(live))
    }

    pub async fn oauth_authorize(
        &self,
        workspace: &Path,
        provider_id: &str,
        method_index: u32,
        inputs: &std::collections::HashMap<String, String>,
    ) -> Result<OAuthAuthorizeResult, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client
            .oauth_authorize(provider_id, method_index, inputs)
            .await
    }

    pub async fn oauth_callback(
        &self,
        workspace: &Path,
        provider_id: &str,
        method_index: u32,
        code: Option<&str>,
    ) -> Result<(), OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client
            .oauth_callback(provider_id, method_index, code)
            .await?;
        self.drop_workspace_instance(workspace).await;
        Ok(())
    }

    pub async fn provider_catalog(
        &self,
        workspace: &Path,
    ) -> Result<LiveProviderCatalog, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client.fetch_provider_catalog().await
    }

    pub async fn remove_provider_auth(
        &self,
        workspace: &Path,
        provider_id: &str,
    ) -> Result<(), OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client.remove_auth(provider_id).await
    }

    pub async fn connected_provider_ids(
        &self,
        workspace: &Path,
    ) -> Result<Vec<String>, OpenCodeSettingsError> {
        let client = self.client_for_workspace(workspace).await?;
        client.fetch_connected_provider_ids().await
    }
}
