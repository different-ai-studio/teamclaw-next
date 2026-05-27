use crate::backend::BackendError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PocketBaseError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("auth error: {0}")]
    Auth(String),

    #[error("config error: {0}")]
    Config(String),

    #[error("provider error: {code:?}: {message}")]
    Provider {
        code: Option<String>,
        message: String,
    },
}

pub type PocketBaseResult<T> = Result<T, PocketBaseError>;

impl From<PocketBaseError> for BackendError {
    fn from(error: PocketBaseError) -> Self {
        match error {
            PocketBaseError::Network(error) => BackendError::Provider {
                provider: "pocketbase",
                code: None,
                message: error.to_string(),
            },
            PocketBaseError::Auth(message) => BackendError::Auth(message),
            PocketBaseError::Config(message) => BackendError::Config(message),
            PocketBaseError::Provider { code, message } => BackendError::Provider {
                provider: "pocketbase",
                code,
                message,
            },
        }
    }
}
