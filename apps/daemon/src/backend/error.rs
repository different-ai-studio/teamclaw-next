use thiserror::Error;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("auth error: {0}")]
    Auth(String),

    #[error("validation error: {0}")]
    #[allow(dead_code)]
    Validation(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("{provider} provider error: {code:?}: {message}")]
    Provider {
        provider: &'static str,
        code: Option<String>,
        message: String,
    },

    #[error("config error: {0}")]
    #[allow(dead_code)]
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type BackendResult<T> = Result<T, BackendError>;
