use super::super::{BackendResult, ClaimResult};
use super::client::{decode_response, network_error, request_id};
use super::CloudApiBackend;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub(super) struct ClaimInviteRequest<'a> {
    pub(super) token: &'a str,
}

#[derive(Deserialize)]
pub(super) struct CloudClaimResult {
    #[serde(rename = "actorId")]
    pub(super) actor_id: String,
    #[serde(rename = "teamId")]
    pub(super) team_id: String,
    #[serde(rename = "actorType")]
    pub(super) actor_type: String,
    #[serde(rename = "displayName")]
    pub(super) display_name: String,
    #[serde(rename = "refreshToken")]
    pub(super) refresh_token: Option<String>,
}

impl CloudApiBackend {
    pub(super) async fn claim_invite_impl(&self, token: &str) -> BackendResult<ClaimResult> {
        let access_token = self.access_token().await?;
        let url = self.cloud_url("/v1/invites/claim");
        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .header("x-request-id", request_id())
            .json(&ClaimInviteRequest { token })
            .send()
            .await
            .map_err(network_error)?;
        let row: CloudClaimResult = decode_response(resp).await?;
        Ok(ClaimResult {
            actor_id: row.actor_id,
            team_id: row.team_id,
            actor_type: row.actor_type,
            display_name: row.display_name,
            refresh_token: row.refresh_token,
        })
    }
}
