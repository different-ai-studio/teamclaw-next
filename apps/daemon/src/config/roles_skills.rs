//! Workspace roles + skills inventory for the settings UI.
//!
//! Scans the same on-disk layouts the frontend loaders use (`.teamclaw/skills`,
//! `.teamclaw/roles`, global skill dirs, etc.) and returns a single aggregated
//! payload so the app no longer needs direct filesystem access for listing.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::workspace_control::WorkspaceControlError;

// ── DTOs (camelCase JSON for the frontend) ───────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSkillLinkDto {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleRecordDto {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub role: String,
    pub when_to_use: String,
    pub working_style: String,
    pub role_skills: Vec<RoleSkillLinkDto>,
    pub file_path: String,
    pub raw_markdown: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillDto {
    pub filename: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_name: Option<String>,
    pub content: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub dir_path: String,
    pub linked_roles: Vec<String>,
    pub is_role_skill: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesSkillsMetricsDto {
    pub roles_count: usize,
    pub skills_count: usize,
    pub linked_skills_count: usize,
    pub unlinked_skills_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesSkillsStateDto {
    pub roles: Vec<RoleRecordDto>,
    pub skills: Vec<ManagedSkillDto>,
    pub role_usage_by_skill: HashMap<String, Vec<String>>,
    pub skill_names_by_role: HashMap<String, Vec<String>>,
    pub metrics: RolesSkillsMetricsDto,
}

// ── Scanner ──────────────────────────────────────────────────────────────────

const ROLE_ROOT: &str = ".teamclaw/roles";
const ROLE_SKILL_DIR: &str = "skills";
const INHERENT_SKILL_NAMES: &[&str] = &["create-role", "macos-control", "windows-control"];

struct RawSkill {
    filename: String,
    name: String,
    invocation_name: String,
    content: String,
    source: String,
    dir_path: String,
    is_role_skill: bool,
}

struct SkillDirSpec {
    path: PathBuf,
    source: &'static str,
}

fn io_err(e: std::io::Error) -> WorkspaceControlError {
    WorkspaceControlError::Io(e.to_string())
}

fn read_clawhub_slugs(workspace_path: &Path) -> HashSet<String> {
    for lock_name in [".clawhub/lock.json", ".clawdhub/lock.json"] {
        let lock_path = workspace_path.join(lock_name);
        let Ok(content) = std::fs::read_to_string(&lock_path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        if let Some(skills) = parsed.get("skills").and_then(|v| v.as_object()) {
            return skills.keys().cloned().collect();
        }
    }
    HashSet::new()
}

fn read_json_paths(workspace_path: &Path, config_rel: &str, key: &str) -> Vec<PathBuf> {
    let config_path = workspace_path.join(config_rel);
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return vec![];
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) else {
        return vec![];
    };
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let home_str = home.to_string_lossy();
    let home_trimmed = home_str.trim_end_matches('/');

    parsed
        .pointer(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|raw| {
                    let trimmed = raw.trim();
                    if trimmed == "~" {
                        home.clone()
                    } else if let Some(rest) = trimmed.strip_prefix("~/") {
                        PathBuf::from(format!("{home_trimmed}/{rest}"))
                    } else if trimmed.starts_with('/') {
                        PathBuf::from(trimmed)
                    } else {
                        workspace_path.join(trimmed.trim_start_matches("./"))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_skill_name(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("name:") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix('#') {
            let title = rest.trim_start_matches('#').trim();
            if !title.is_empty() {
                return title.to_owned();
            }
        }
    }
    fallback.to_owned()
}

fn extract_skill_description(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.strip_prefix("description:") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_owned();
            }
        }
    }
    extract_skill_name(content, fallback)
}

fn build_invocation_name(parent_dir: &Path, filename: &str) -> String {
    parent_dir
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|scope| *scope != "skills")
        .map(|scope| format!("{scope}/{filename}"))
        .unwrap_or_else(|| filename.to_owned())
}

fn load_skills_from_dir(dir: &Path, source: &str) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut skills = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let content = std::fs::read_to_string(&skill_md).map_err(io_err)?;
        let name = extract_skill_name(&content, filename);
        skills.push(RawSkill {
            filename: filename.to_owned(),
            name: name.clone(),
            invocation_name: build_invocation_name(dir, filename),
            content,
            source: source.to_owned(),
            dir_path: dir.to_string_lossy().into_owned(),
            is_role_skill: false,
        });
    }
    Ok(skills)
}

fn source_priority(source: &str) -> u8 {
    match source {
        "local" => 0,
        "claude" => 1,
        "clawhub" => 2,
        "shared" => 3,
        "team" => 4,
        "builtin" => 5,
        "plugin" => 6,
        "global-teamclaw" => 7,
        "global-claude" => 8,
        "global-agent" => 9,
        "global-opencode" => 10,
        "opencode" => 11,
        _ => 12,
    }
}

fn classify_teamclaw_skill(filename: &str, clawhub_slugs: &HashSet<String>) -> &'static str {
    if INHERENT_SKILL_NAMES.contains(&filename) {
        "builtin"
    } else if clawhub_slugs.contains(filename) {
        "clawhub"
    } else {
        "local"
    }
}

fn load_all_skills(workspace_path: &Path, home: &Path) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    let clawhub_slugs = read_clawhub_slugs(workspace_path);
    let home_str = home.to_string_lossy();
    let home_trimmed = home_str.trim_end_matches('/');

    let mut specs = vec![
        SkillDirSpec {
            path: workspace_path.join(".teamclaw/skills"),
            source: "local",
        },
        SkillDirSpec {
            path: workspace_path.join(".opencode/skills"),
            source: "opencode",
        },
        SkillDirSpec {
            path: workspace_path.join(".claude/skills"),
            source: "claude",
        },
        SkillDirSpec {
            path: workspace_path.join(".agents/skills"),
            source: "shared",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.config/teamclaw/skills")),
            source: "global-teamclaw",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.config/opencode/skills")),
            source: "global-opencode",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.claude/skills")),
            source: "global-claude",
        },
        SkillDirSpec {
            path: PathBuf::from(format!("{home_trimmed}/.agents/skills")),
            source: "global-agent",
        },
    ];

    for extra in read_json_paths(workspace_path, "teamclaw.json", "/skills/paths") {
        specs.push(SkillDirSpec {
            path: extra,
            source: "team",
        });
    }

    let mut merged: HashMap<String, RawSkill> = HashMap::new();
    for spec in specs {
        let mut batch = load_skills_from_dir(&spec.path, spec.source)?;
        for skill in batch.drain(..) {
            let source = if spec.path.ends_with(".teamclaw/skills") {
                classify_teamclaw_skill(&skill.filename, &clawhub_slugs).to_owned()
            } else {
                skill.source.clone()
            };
            let skill = RawSkill { source, ..skill };
            match merged.get(&skill.filename) {
                Some(existing) if source_priority(&existing.source) <= source_priority(&skill.source) => {}
                _ => {
                    merged.insert(skill.filename.clone(), skill);
                }
            }
        }
    }

    Ok(merged.into_values().collect())
}

fn get_section(body: &str, heading: &str) -> String {
    let marker = format!("## {heading}");
    let mut in_section = false;
    let mut section_lines = Vec::new();
    for line in body.lines() {
        if line.trim().eq_ignore_ascii_case(marker.trim()) {
            in_section = true;
            continue;
        }
        if in_section {
            if line.starts_with("## ") {
                break;
            }
            section_lines.push(line);
        }
    }
    section_lines.join("\n").trim().to_owned()
}

fn parse_role_skill_links(section: &str) -> Vec<RoleSkillLinkDto> {
    section
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if !trimmed.starts_with('-') {
                return None;
            }
            let rest = trimmed.trim_start_matches('-').trim();
            let (name_part, desc) = rest.split_once(':')?;
            let name = name_part.trim().trim_matches('`').trim();
            if name.is_empty() {
                return None;
            }
            Some(RoleSkillLinkDto {
                name: name.to_owned(),
                description: desc.trim().to_owned(),
            })
        })
        .collect()
}

fn parse_role_markdown(content: &str, slug: &str, file_path: &Path) -> RoleRecordDto {
    let normalized = content.replace("\r\n", "\n");
    let (frontmatter, body) = if let Some(stripped) = normalized.strip_prefix("---\n") {
        if let Some((fm, body)) = stripped.split_once("\n---") {
            (Some(fm), body.trim_start_matches('\n'))
        } else {
            (None, normalized.as_str())
        }
    } else {
        (None, normalized.as_str())
    };

    let mut name = slug.to_owned();
    let mut description = String::new();
    if let Some(fm) = frontmatter {
        for line in fm.lines() {
            if let Some((k, v)) = line.split_once(':') {
                match k.trim() {
                    "name" => name = v.trim().to_owned(),
                    "description" => description = v.trim().to_owned(),
                    _ => {}
                }
            }
        }
    }

    RoleRecordDto {
        slug: slug.to_owned(),
        name,
        description,
        body: body.to_owned(),
        role: get_section(body, "Role"),
        when_to_use: get_section(body, "When to use"),
        working_style: get_section(body, "Working style"),
        role_skills: parse_role_skill_links(&get_section(body, "Available role skills")),
        file_path: file_path.to_string_lossy().into_owned(),
        raw_markdown: normalized.trim().to_owned(),
    }
}

fn role_roots(workspace_path: &Path) -> Vec<PathBuf> {
    let mut roots = vec![workspace_path.join(ROLE_ROOT)];
    for extra in read_json_paths(workspace_path, ".teamclaw/roles/config.json", "/paths") {
        if !roots.contains(&extra) {
            roots.push(extra);
        }
    }
    roots
}

fn load_all_roles(workspace_path: &Path) -> Result<Vec<RoleRecordDto>, WorkspaceControlError> {
    let mut roles = Vec::new();
    let mut seen = HashSet::new();
    for root in role_roots(workspace_path) {
        if !root.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&root).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if slug == ROLE_SKILL_DIR || seen.contains(slug) {
                continue;
            }
            let role_md = path.join("ROLE.md");
            if !role_md.is_file() {
                continue;
            }
            let content = std::fs::read_to_string(&role_md).map_err(io_err)?;
            roles.push(parse_role_markdown(&content, slug, &role_md));
            seen.insert(slug.to_owned());
        }
    }
    roles.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(roles)
}

fn load_role_managed_skills(workspace_path: &Path) -> Result<Vec<RawSkill>, WorkspaceControlError> {
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    for root in role_roots(workspace_path) {
        let role_skill_root = root.join(ROLE_SKILL_DIR);
        if !role_skill_root.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&role_skill_root).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if seen.contains(filename) {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let content = std::fs::read_to_string(&skill_md).map_err(io_err)?;
            seen.insert(filename.to_owned());
            skills.push(RawSkill {
                filename: filename.to_owned(),
                name: filename.to_owned(),
                invocation_name: filename.to_owned(),
                content,
                source: "local".to_owned(),
                dir_path: role_skill_root.to_string_lossy().into_owned(),
                is_role_skill: true,
            });
        }
    }
    Ok(skills)
}

/// Scan a workspace directory and build the aggregated roles/skills state.
pub fn scan_roles_skills_state(workspace_path: &Path) -> Result<RolesSkillsStateDto, WorkspaceControlError> {
    let home = dirs::home_dir().ok_or_else(|| {
        WorkspaceControlError::Io("home directory not found".to_owned())
    })?;

    let roles = load_all_roles(workspace_path)?;
    let normal_skills = load_all_skills(workspace_path, &home)?;
    let role_managed = load_role_managed_skills(workspace_path)?;

    let mut role_usage_by_skill: HashMap<String, Vec<String>> = HashMap::new();
    let mut skill_names_by_role: HashMap<String, Vec<String>> = HashMap::new();

    for role in &roles {
        let names: Vec<String> = role.role_skills.iter().map(|s| s.name.clone()).collect();
        skill_names_by_role.insert(role.slug.clone(), names.clone());
        for link in &role.role_skills {
            role_usage_by_skill
                .entry(link.name.clone())
                .or_default()
                .push(role.slug.clone());
        }
    }

    let mut by_key: HashMap<String, ManagedSkillDto> = HashMap::new();

    for skill in normal_skills {
        let key = format!("{}:{}", skill.dir_path, skill.filename);
        by_key.insert(
            key,
            ManagedSkillDto {
                filename: skill.filename.clone(),
                name: skill.name.clone(),
                invocation_name: Some(skill.invocation_name),
                content: skill.content.clone(),
                description: extract_skill_description(&skill.content, &skill.name),
                source: Some(skill.source),
                dir_path: skill.dir_path,
                linked_roles: role_usage_by_skill
                    .get(&skill.filename)
                    .cloned()
                    .unwrap_or_default(),
                is_role_skill: false,
            },
        );
    }

    for skill in role_managed {
        let key = format!("{}:{}", skill.dir_path, skill.filename);
        by_key.insert(
            key,
            ManagedSkillDto {
                filename: skill.filename.clone(),
                name: skill.name.clone(),
                invocation_name: Some(skill.invocation_name),
                content: skill.content.clone(),
                description: extract_skill_description(&skill.content, &skill.name),
                source: Some(skill.source),
                dir_path: skill.dir_path,
                linked_roles: role_usage_by_skill
                    .get(&skill.filename)
                    .cloned()
                    .unwrap_or_default(),
                is_role_skill: true,
            },
        );
    }

    let mut skills: Vec<ManagedSkillDto> = by_key.into_values().collect();
    skills.sort_by(|a, b| {
        a.is_role_skill
            .cmp(&b.is_role_skill)
            .then(a.filename.cmp(&b.filename))
    });

    let linked_skills_count = role_usage_by_skill
        .keys()
        .filter(|name| skills.iter().any(|s| s.filename == **name))
        .count();

    Ok(RolesSkillsStateDto {
        metrics: RolesSkillsMetricsDto {
            roles_count: roles.len(),
            skills_count: skills.len(),
            linked_skills_count,
            unlinked_skills_count: skills.len().saturating_sub(linked_skills_count),
        },
        roles,
        skills,
        role_usage_by_skill,
        skill_names_by_role,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_empty_workspace_returns_empty_state() {
        let dir = tempfile::tempdir().unwrap();
        let state = scan_roles_skills_state(dir.path()).unwrap();
        assert!(state.roles.is_empty());
        assert!(state.skills.is_empty());
        assert_eq!(state.metrics.roles_count, 0);
    }

    #[test]
    fn scan_finds_role_and_skill() {
        let dir = tempfile::tempdir().unwrap();
        let ws = dir.path();

        let skill_dir = ws.join(".teamclaw/skills/demo-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Demo Skill\ndescription: A demo\n---\n\n# Demo",
        )
        .unwrap();

        let role_dir = ws.join(".teamclaw/roles/reviewer");
        std::fs::create_dir_all(&role_dir).unwrap();
        std::fs::write(
            role_dir.join("ROLE.md"),
            "---\nname: reviewer\ndescription: Code reviewer\n---\n\n## Role\nReview code.\n",
        )
        .unwrap();

        let state = scan_roles_skills_state(ws).unwrap();
        assert_eq!(state.roles.len(), 1);
        assert_eq!(state.roles[0].slug, "reviewer");
        assert_eq!(state.skills.len(), 1);
        assert_eq!(state.skills[0].filename, "demo-skill");
    }
}
