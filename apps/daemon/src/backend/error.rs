use crate::supabase::error::SupabaseError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("auth error: {0}")]
    Auth(String),

    #[error("validation error: {0}")]
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
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type BackendResult<T> = Result<T, BackendError>;

impl From<SupabaseError> for BackendError {
    fn from(error: SupabaseError) -> Self {
        match error {
            SupabaseError::Network(error) => BackendError::Provider {
                provider: "supabase",
                code: None,
                message: error.to_string(),
            },
            SupabaseError::Auth(message) | SupabaseError::InvalidJwt(message) => {
                BackendError::Auth(message)
            }
            SupabaseError::InviteInvalid => {
                BackendError::Validation("invite invalid or expired".into())
            }
            SupabaseError::InviteClaimed => {
                BackendError::Validation("invite already claimed".into())
            }
            SupabaseError::Rpc { code, message } => BackendError::Provider {
                provider: "supabase",
                code,
                message,
            },
            SupabaseError::Config(message) => BackendError::Config(message),
            SupabaseError::Io(error) => BackendError::Io(error),
            SupabaseError::Serde(error) => BackendError::Serde(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_invite_invalid_to_validation() {
        let err = BackendError::from(SupabaseError::InviteInvalid);

        match err {
            BackendError::Validation(message) => {
                assert_eq!(message, "invite invalid or expired");
            }
            other => panic!("expected validation error, got {other:?}"),
        }
    }

    #[test]
    fn maps_rpc_to_supabase_provider_error() {
        let err = BackendError::from(SupabaseError::Rpc {
            code: Some("409".into()),
            message: "duplicate key".into(),
        });

        match err {
            BackendError::Provider {
                provider,
                code,
                message,
            } => {
                assert_eq!(provider, "supabase");
                assert_eq!(code.as_deref(), Some("409"));
                assert_eq!(message, "duplicate key");
            }
            other => panic!("expected provider error, got {other:?}"),
        }
    }
}
