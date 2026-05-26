use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AuthRefreshResponse {
    pub token: String,
}
