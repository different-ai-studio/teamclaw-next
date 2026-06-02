use std::collections::HashMap;

use crate::SystemEnvContext;

pub fn merge_env_maps(
    personal: HashMap<String, String>,
    team: HashMap<String, String>,
    system: &SystemEnvContext,
) -> HashMap<String, String> {
    let mut merged = personal;
    merged.extend(team);

    if !system.device_id.is_empty() {
        merged.insert("device_id".to_string(), system.device_id.clone());
        let id = &system.device_id;
        let prefix_len = id.len().min(40);
        merged.insert(
            "tc_api_key".to_string(),
            format!("sk-tc-{}", &id[..prefix_len]),
        );
    }
    if !system.device_name.is_empty() {
        merged.insert("device_name".to_string(), system.device_name.clone());
    }

    normalize_env_map(merged)
}

/// Uppercase and dot-free aliases (daemon `normalize_env_map` + desktop OpenCode sidecar).
fn normalize_env_map(input: HashMap<String, String>) -> HashMap<String, String> {
    let mut out = input;

    let upper_additions: Vec<(String, String)> = out
        .iter()
        .filter_map(|(key, value)| {
            let upper = key.to_ascii_uppercase();
            if key == &upper || out.contains_key(&upper) {
                None
            } else {
                Some((upper, value.clone()))
            }
        })
        .collect();
    for (key, value) in upper_additions {
        out.insert(key, value);
    }

    let dot_additions: Vec<(String, String)> = out
        .iter()
        .filter_map(|(key, value)| {
            if !key.contains('.') {
                return None;
            }
            let alias = key.replace('.', "_");
            if out.contains_key(&alias) {
                None
            } else {
                Some((alias, value.clone()))
            }
        })
        .collect();
    for (key, value) in dot_additions {
        out.insert(key, value);
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(device_id: &str, device_name: &str) -> SystemEnvContext {
        SystemEnvContext {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
        }
    }

    #[test]
    fn team_overrides_personal_on_duplicate() {
        let mut personal = HashMap::new();
        personal.insert("FOO".to_string(), "personal".to_string());
        let mut team = HashMap::new();
        team.insert("FOO".to_string(), "team".to_string());

        let out = merge_env_maps(personal, team, &ctx("", ""));

        assert_eq!(out.get("FOO").map(String::as_str), Some("team"));
    }

    #[test]
    fn tc_api_key_from_device_id() {
        let device_id = "a".repeat(50);
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx(&device_id, ""));

        assert_eq!(out.get("device_id").map(String::as_str), Some(device_id.as_str()));
        let expected_key = format!("sk-tc-{}", &device_id[..40]);
        assert_eq!(out.get("tc_api_key").map(String::as_str), Some(expected_key.as_str()));
    }

    #[test]
    fn skips_tc_api_key_when_device_id_empty() {
        let out = merge_env_maps(HashMap::new(), HashMap::new(), &ctx("", "host"));

        assert!(!out.contains_key("device_id"));
        assert!(!out.contains_key("tc_api_key"));
        assert_eq!(out.get("device_name").map(String::as_str), Some("host"));
    }

    #[test]
    fn injects_device_id_and_device_name() {
        let out = merge_env_maps(
            HashMap::new(),
            HashMap::new(),
            &ctx("dev-123", "My Mac"),
        );

        assert_eq!(out.get("device_id").map(String::as_str), Some("dev-123"));
        assert_eq!(out.get("device_name").map(String::as_str), Some("My Mac"));
        assert_eq!(out.get("tc_api_key").map(String::as_str), Some("sk-tc-dev-123"));
    }

    #[test]
    fn adds_uppercase_alias_for_lowercase_key() {
        let mut personal = HashMap::new();
        personal.insert("tc_api_key".to_string(), "secret".to_string());

        let out = merge_env_maps(personal, HashMap::new(), &ctx("", ""));

        assert_eq!(out.get("tc_api_key").map(String::as_str), Some("secret"));
        assert_eq!(out.get("TC_API_KEY").map(String::as_str), Some("secret"));
    }

    #[test]
    fn adds_dot_free_alias_for_dotted_key() {
        let mut personal = HashMap::new();
        personal.insert("wecom.corp_id".to_string(), "cid".to_string());

        let out = merge_env_maps(personal, HashMap::new(), &ctx("", ""));

        assert_eq!(out.get("wecom.corp_id").map(String::as_str), Some("cid"));
        assert_eq!(out.get("wecom_corp_id").map(String::as_str), Some("cid"));
    }
}
