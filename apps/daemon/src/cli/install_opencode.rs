pub fn run(force: bool) -> anyhow::Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(crate::opencode_install::run_install(force))
}
