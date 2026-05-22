use agent_client_protocol as acp;

use crate::proto::amux;

/// Translate the ACP-reported model list (from
/// `SessionModelState.available_models` in the `session/new` /
/// `session/load` response) into amux's protobuf `ModelInfo` shape used
/// over MQTT. The ACP type carries `model_id` + `name`; we map them onto
/// `id` + `display_name` respectively. The optional `description` field
/// is dropped because amux's wire schema doesn't carry it yet.
///
/// Requires the `unstable_session_model` feature on
/// `agent-client-protocol`, which `amuxd` always enables (see
/// `Cargo.toml`).
pub fn acp_models_to_proto(state: &acp::SessionModelState) -> Vec<amux::ModelInfo> {
    state
        .available_models
        .iter()
        .map(|m| amux::ModelInfo {
            id: m.model_id.0.to_string(),
            display_name: m.name.clone(),
        })
        .collect()
}

/// Hardcoded model list used as a **fallback** when the ACP agent does
/// not advertise its models via the `unstable_session_model` capability
/// in `session/new` / `session/load`. Live runtimes prefer the
/// agent-reported list captured by `runtime::adapter::run_acp_session`
/// onto `RuntimeHandle::available_models`. This table is consulted only
/// for legacy claude-agent-acp (which doesn't fill `models`) and for
/// historical sessions reconstructed from `session_store`.
pub fn available_models_for(agent_type: amux::AgentType) -> Vec<amux::ModelInfo> {
    match agent_type {
        amux::AgentType::ClaudeCode => vec![
            amux::ModelInfo {
                id: "claude-haiku-4-5".to_string(),
                display_name: "Claude Haiku 4.5".to_string(),
            },
            amux::ModelInfo {
                id: "claude-sonnet-4-6".to_string(),
                display_name: "Claude Sonnet 4.6".to_string(),
            },
            amux::ModelInfo {
                id: "claude-opus-4-7".to_string(),
                display_name: "Claude Opus 4.7".to_string(),
            },
        ],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_returns_three_models_in_order() {
        let models = available_models_for(amux::AgentType::ClaudeCode);
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "claude-haiku-4-5");
        assert_eq!(models[1].id, "claude-sonnet-4-6");
        assert_eq!(models[2].id, "claude-opus-4-7");
    }

    #[test]
    fn acp_models_to_proto_maps_id_and_name() {
        let state = acp::SessionModelState::new(
            acp::ModelId::new("anthropic/claude-sonnet-4.6"),
            vec![
                acp::ModelInfo::new(
                    acp::ModelId::new("anthropic/claude-sonnet-4.6"),
                    "Claude Sonnet 4.6",
                )
                .description("balanced"),
                acp::ModelInfo::new(acp::ModelId::new("zai/glm-4.6"), "GLM-4.6"),
            ],
        );
        let out = acp_models_to_proto(&state);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "anthropic/claude-sonnet-4.6");
        assert_eq!(out[0].display_name, "Claude Sonnet 4.6");
        assert_eq!(out[1].id, "zai/glm-4.6");
        assert_eq!(out[1].display_name, "GLM-4.6");
    }

    #[test]
    fn acp_models_to_proto_empty_when_agent_reports_nothing() {
        let state = acp::SessionModelState::new(acp::ModelId::new("x"), Vec::new());
        assert!(acp_models_to_proto(&state).is_empty());
    }

    #[test]
    fn opencode_fallback_is_empty() {
        // For opencode/codex the runtime is expected to read the live
        // ACP `SessionModelState.available_models`; this fallback table
        // is intentionally empty so callers can detect "no static
        // override" and use the agent-reported list instead.
        let models = available_models_for(amux::AgentType::Opencode);
        assert!(models.is_empty());
        let models = available_models_for(amux::AgentType::Codex);
        assert!(models.is_empty());
    }
}
