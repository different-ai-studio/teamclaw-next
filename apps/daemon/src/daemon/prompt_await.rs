#[derive(Debug)]
pub(crate) struct PromptAwaitPayload<'a> {
    pub session_key: &'a str,
    pub message: &'a str,
    /// Human-readable name of the cron job. Used to construct the cloud
    /// session title ("Cron: <job_name>"). Optional; when absent the daemon
    /// falls back to "Cron job".
    pub job_name: Option<&'a str>,
    pub working_directory: Option<&'a str>,
    pub model_override: Option<(String, String)>,
    pub timeout_secs: u64,
}

pub(crate) fn parse_prompt_await_payload(
    payload: &serde_json::Value,
) -> anyhow::Result<PromptAwaitPayload<'_>> {
    let session_key = payload
        .get("session_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("prompt-await: missing 'session_key'"))?;
    if !session_key.starts_with("cron/") {
        anyhow::bail!("prompt-await: session_key must start with 'cron/' (got {session_key:?})");
    }
    let message = payload
        .get("message")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("prompt-await: missing 'message'"))?;
    if message.is_empty() {
        anyhow::bail!("prompt-await: 'message' must not be empty");
    }
    let job_name = payload
        .get("job_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let working_directory = payload
        .get("working_directory")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let model_override = payload
        .get("model_override")
        .and_then(|v| v.as_object())
        .and_then(|m| {
            let p = m.get("provider").and_then(|v| v.as_str())?;
            let mo = m.get("model").and_then(|v| v.as_str())?;
            Some((p.to_string(), mo.to_string()))
        });
    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(300)
        .clamp(1, 600);

    Ok(PromptAwaitPayload {
        session_key,
        message,
        job_name,
        working_directory,
        model_override,
        timeout_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_rejects_missing_session_key() {
        let p = json!({ "message": "hi" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(err.to_string().contains("session_key"), "got: {err}");
    }

    #[test]
    fn parse_rejects_non_cron_session_key() {
        let p = json!({ "session_key": "wecom/x/y", "message": "hi" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(
            err.to_string().contains("must start with 'cron/'"),
            "got: {err}"
        );
    }

    #[test]
    fn parse_rejects_empty_message() {
        let p = json!({ "session_key": "cron/j1/r1", "message": "" });
        let err = parse_prompt_await_payload(&p).unwrap_err();
        assert!(err.to_string().contains("message"), "got: {err}");
    }

    #[test]
    fn parse_accepts_minimal_valid_payload() {
        let p = json!({ "session_key": "cron/j1/r1", "message": "hello" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.session_key, "cron/j1/r1");
        assert_eq!(parsed.message, "hello");
        assert!(parsed.job_name.is_none());
        assert!(parsed.working_directory.is_none());
        assert!(parsed.model_override.is_none());
        assert_eq!(parsed.timeout_secs, 300);
    }

    #[test]
    fn parse_accepts_full_payload() {
        let p = json!({
            "session_key": "cron/j1/r1",
            "message": "hello",
            "job_name": "Nightly digest",
            "working_directory": "/tmp/wt",
            "model_override": { "provider": "anthropic", "model": "sonnet" },
            "timeout_secs": 120
        });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.job_name, Some("Nightly digest"));
        assert_eq!(parsed.working_directory, Some("/tmp/wt"));
        assert_eq!(
            parsed.model_override.as_ref().map(|m| m.0.as_str()),
            Some("anthropic")
        );
        assert_eq!(
            parsed.model_override.as_ref().map(|m| m.1.as_str()),
            Some("sonnet")
        );
        assert_eq!(parsed.timeout_secs, 120);
    }

    #[test]
    fn parse_accepts_optional_job_name() {
        // Empty string is treated as absent (consistent with working_directory).
        let p = json!({ "session_key": "cron/j1/r1", "message": "hi", "job_name": "" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert!(parsed.job_name.is_none());

        // Non-empty string is preserved.
        let p = json!({ "session_key": "cron/j1/r1", "message": "hi", "job_name": "My Job" });
        let parsed = parse_prompt_await_payload(&p).unwrap();
        assert_eq!(parsed.job_name, Some("My Job"));
    }
}
