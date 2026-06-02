use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::config::DaemonConfig;

#[derive(Debug, Deserialize)]
pub struct OpencodeLock {
    pub version: String,
    pub assets: HashMap<String, OpencodeAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpencodeAsset {
    pub name: String,
    #[serde(default, deserialize_with = "empty_string_as_none")]
    pub sha256: Option<String>,
}

fn empty_string_as_none<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(opt.filter(|s| !s.is_empty()))
}

impl OpencodeLock {
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(s)?)
    }
    pub fn asset_for(&self, target: &str) -> anyhow::Result<&OpencodeAsset> {
        self.assets
            .get(target)
            .ok_or_else(|| anyhow::anyhow!("no opencode asset for target {target}"))
    }
}

/// Embedded at compile time from apps/daemon/opencode.lock.json
pub const LOCK_JSON: &str = include_str!("../../opencode.lock.json");

pub fn install_dir() -> PathBuf {
    DaemonConfig::config_dir().join("bin")
}

pub fn opencode_bin_path() -> PathBuf {
    let name = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    install_dir().join(name)
}

pub fn version_file_path() -> PathBuf {
    DaemonConfig::config_dir().join(".opencode-version")
}

pub fn current_target() -> anyhow::Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        (os, arch) => anyhow::bail!("unsupported platform {os}/{arch}"),
    })
}

pub fn sha256_hex(path: &Path) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

pub fn verify_sha256(path: &Path, expected: &str) -> anyhow::Result<()> {
    let actual = sha256_hex(path)?;
    if !actual.eq_ignore_ascii_case(expected) {
        anyhow::bail!("sha256 mismatch: expected {expected}, got {actual}");
    }
    Ok(())
}

pub fn extract_opencode(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    let name = archive.file_name().and_then(|s| s.to_str()).unwrap_or_default();
    if name.ends_with(".zip") {
        extract_zip(archive, dest)
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz(archive, dest)
    } else {
        anyhow::bail!("unknown archive format: {name}")
    }
}

fn is_opencode_entry(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    base == "opencode" || base == "opencode.exe"
}

fn write_dest(dest: &Path, reader: &mut impl std::io::Read) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::File::create(dest)?;
    std::io::copy(reader, &mut out)?;
    set_executable(dest)?;
    Ok(())
}

fn extract_zip(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if is_opencode_entry(entry.name()) {
            return write_dest(dest, &mut entry);
        }
    }
    anyhow::bail!("opencode binary not found in zip")
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> anyhow::Result<()> {
    let file = std::fs::File::open(archive)?;
    let dec = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(dec);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_string_lossy().to_string();
        if is_opencode_entry(&path) {
            return write_dest(dest, &mut entry);
        }
    }
    anyhow::bail!("opencode binary not found in tar.gz")
}

fn set_executable(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)?;
    }
    let _ = path;
    Ok(())
}

const GITHUB_BASE: &str = "https://github.com/anomalyco/opencode/releases/download";

pub fn github_url(version: &str, asset: &str) -> String {
    format!("{GITHUB_BASE}/{version}/{asset}")
}

pub fn mirror_url(version: &str, asset: &str) -> Option<String> {
    std::env::var("AMUXD_OPENCODE_MIRROR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|base| format!("{}/{version}/{asset}", base.trim_end_matches('/')))
}

pub async fn download_to(url: &str, dest: &Path) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let resp = reqwest::get(url).await?.error_for_status()?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = tokio::fs::File::create(dest).await?;
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

pub async fn download_with_fallback(urls: &[String], dest: &Path) -> anyhow::Result<()> {
    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        match download_to(url, dest).await {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no download urls provided")))
}

fn resolve_binary_with(configured: Option<&str>, installed: bool) -> String {
    if let Some(b) = configured {
        // AgentBackendConfig.binary serde default is "claude" (shared default_claude_binary()).
        // When [agents.opencode] exists but omits `binary`, the value is "claude" — treat that as "not configured".
        if !b.is_empty() && b != "claude" {
            return b.to_string();
        }
    }
    if installed {
        return opencode_bin_path().to_string_lossy().to_string();
    }
    "opencode".to_string()
}

pub fn resolve_binary(configured: Option<&str>) -> String {
    resolve_binary_with(configured, opencode_bin_path().exists())
}

fn progress(event: &str, message: &str) {
    println!("{}", serde_json::json!({ "event": event, "message": message }));
}

fn installed_version() -> anyhow::Result<Option<String>> {
    let p = version_file_path();
    if p.exists() {
        Ok(Some(std::fs::read_to_string(&p)?.trim().to_string()))
    } else {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn post_process(path: &Path) {
    let _ = std::process::Command::new("xattr").arg("-cr").arg(path).status();
    let _ = std::process::Command::new("codesign")
        .args(["--force", "--sign", "-"])
        .arg(path)
        .status();
}
#[cfg(not(target_os = "macos"))]
fn post_process(_path: &Path) {}

pub async fn run_install(force: bool) -> anyhow::Result<()> {
    let lock = OpencodeLock::parse(LOCK_JSON)?;
    let target = current_target()?;
    let asset = lock.asset_for(target)?.clone();
    let dest = opencode_bin_path();

    if !force && dest.exists() && installed_version()? == Some(lock.version.clone()) {
        progress("ok", &format!("opencode {} already installed", lock.version));
        return Ok(());
    }

    progress("download", &format!("downloading opencode {}", lock.version));
    let archive = install_dir().join(&asset.name);
    let mut urls = vec![github_url(&lock.version, &asset.name)];
    if let Some(m) = mirror_url(&lock.version, &asset.name) {
        urls.push(m);
    }
    download_with_fallback(&urls, &archive).await?;

    if let Some(sha) = asset.sha256.as_deref() {
        if !sha.is_empty() {
            progress("verify", "verifying checksum");
            verify_sha256(&archive, sha)?;
        }
    }

    progress("extract", "extracting opencode");
    extract_opencode(&archive, &dest)?;
    let _ = std::fs::remove_file(&archive);
    post_process(&dest);
    std::fs::write(version_file_path(), &lock.version)?;

    progress("ok", &format!("opencode {} installed at {}", lock.version, dest.display()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lock_and_selects_asset() {
        let json = r#"{
            "version": "v1.2.3",
            "assets": {
                "aarch64-apple-darwin": { "name": "opencode-darwin-arm64.zip", "sha256": "abc" }
            }
        }"#;
        let lock = OpencodeLock::parse(json).unwrap();
        assert_eq!(lock.version, "v1.2.3");
        let asset = lock.asset_for("aarch64-apple-darwin").unwrap();
        assert_eq!(asset.name, "opencode-darwin-arm64.zip");
        assert_eq!(asset.sha256.as_deref(), Some("abc"));
    }

    #[test]
    fn empty_sha256_becomes_none() {
        let lock = OpencodeLock::parse(
            r#"{"version":"v1","assets":{"t":{"name":"a.zip","sha256":""}}}"#,
        )
        .unwrap();
        assert_eq!(lock.asset_for("t").unwrap().sha256, None);
    }

    #[test]
    fn unknown_target_errors() {
        let lock = OpencodeLock::parse(r#"{"version":"v1","assets":{}}"#).unwrap();
        assert!(lock.asset_for("mips-unknown-linux").is_err());
    }

    #[test]
    fn opencode_paths_under_amuxd_bin() {
        let dir = install_dir();
        assert!(dir.ends_with(".amuxd/bin"), "got {dir:?}");
        let bin = opencode_bin_path();
        let expected_name = if cfg!(windows) { "opencode.exe" } else { "opencode" };
        assert_eq!(bin.file_name().unwrap().to_str().unwrap(), expected_name);
        assert!(version_file_path().ends_with(".amuxd/.opencode-version"));
    }

    #[test]
    fn current_target_is_known() {
        let t = current_target().unwrap();
        assert!(t.contains('-'), "got {t}");
    }

    #[test]
    fn sha256_roundtrip_and_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("blob");
        std::fs::write(&f, b"hello").unwrap();
        let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert_eq!(sha256_hex(&f).unwrap(), expected);
        verify_sha256(&f, expected).unwrap();
        assert!(verify_sha256(&f, "deadbeef").is_err());
    }

    #[test]
    fn extracts_opencode_from_zip() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.zip");
        {
            use std::io::Write;
            let f = std::fs::File::create(&archive).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            zw.start_file("opencode", zip::write::SimpleFileOptions::default()).unwrap();
            zw.write_all(b"BINARY").unwrap();
            zw.finish().unwrap();
        }
        let dest = dir.path().join("out").join("opencode");
        extract_opencode(&archive, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"BINARY");
    }

    #[test]
    fn extracts_opencode_from_tar_gz() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("a.tar.gz");
        {
            let f = std::fs::File::create(&archive).unwrap();
            let enc = flate2::write::GzEncoder::new(f, flate2::Compression::default());
            let mut tarw = tar::Builder::new(enc);
            let data = b"TARBIN";
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            tarw.append_data(&mut header, "opencode", &data[..]).unwrap();
            tarw.into_inner().unwrap().finish().unwrap();
        }
        let dest = dir.path().join("opencode");
        extract_opencode(&archive, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"TARBIN");
    }

    #[tokio::test]
    async fn download_to_writes_body() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/asset.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"PAYLOAD".to_vec()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("asset.zip");
        download_to(&format!("{}/asset.zip", server.uri()), &dest).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"PAYLOAD");
    }

    #[test]
    fn url_builders() {
        assert_eq!(
            github_url("v1.2.3", "opencode-darwin-arm64.zip"),
            "https://github.com/anomalyco/opencode/releases/download/v1.2.3/opencode-darwin-arm64.zip"
        );
    }

    #[test]
    fn resolve_binary_precedence() {
        assert_eq!(resolve_binary_with(Some("/opt/oc"), false), "/opt/oc");
        assert_eq!(resolve_binary_with(Some("claude"), false), "opencode");
        assert_eq!(resolve_binary_with(None, false), "opencode");
        let installed = opencode_bin_path().to_string_lossy().to_string();
        assert_eq!(resolve_binary_with(None, true), installed);
    }
}
