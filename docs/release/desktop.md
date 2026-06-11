# Desktop Release（Tauri）

TeamClaw 桌面端通过 **Git tag 触发 GitHub Actions**，自动构建 macOS / Windows 安装包并发布到 GitHub Releases，同时镜像到国内 OSS CDN。

## 版本号来源

以下三处必须保持一致（可用脚本校验 / 批量 bump）：

| 文件 | 字段 |
|------|------|
| `package.json` | `version` |
| `apps/desktop/Cargo.toml` | `version` |
| `apps/desktop/tauri.conf.json` | `version` |

```bash
# 查看是否一致
pnpm release:check

# 批量 bump（会先检查当前三处一致）
pnpm release:bump 0.2.1

# 发布前门禁
pnpm release:preflight
```

## 发布流程

### 1. 准备

- `main` 上 CI 全绿（lint / typecheck / unit / rust clippy）
- 如需验证本地包：`pnpm verify-release`（单架构 Tauri build，不生成 updater 签名产物）
- 若本次 release 依赖 Cloud API 变更，先确保 `services/fc/**` 已合入 `main` 且 FC Deploy 成功

### 2. Bump 版本并合入 main

```bash
pnpm release:bump 0.2.1
git add package.json apps/desktop/Cargo.toml apps/desktop/tauri.conf.json
git commit -m "chore(desktop): bump version to 0.2.1"
# 通过 PR 合入 main，不要直接推 main
```

### 3. 打 tag 触发 CI

```bash
git checkout main && git pull
pnpm release:preflight
git tag v0.2.1
git push origin v0.2.1
```

Tag 必须以 `v` 开头，匹配 `.github/workflows/release.yml` 的 `v*` 规则。

### 4. CI 产物（自动）

Workflow：`.github/workflows/release.yml`

| Job | 平台 | 产物 |
|-----|------|------|
| `release-macos` ×2 | ARM64 + Intel | `.dmg` |
| `release-windows` | x64 | NSIS `.exe` |
| `update-release-notes` | — | OSS `latest.json` 镜像 + Release 说明补充 |

Sidecar 随 Desktop 一起编译打包：`teamclaw-introspect`、`amuxd`。

### 5. 发布后验收

**GitHub Release 资产：**

- `TeamClaw_<version>_aarch64.dmg`
- `TeamClaw_<version>_x64.dmg`
- `TeamClaw_<version>_x64-setup.exe`
- `latest.json`（Tauri 自动更新清单）

**安装验证：**

```bash
# 海外（GitHub latest release）
curl -fsSL https://raw.githubusercontent.com/different-ai-studio/teamclaw-next/main/scripts/install-mac.sh | bash

# 国内（OSS 镜像，需 OSS secrets 已配置）
curl -fsSL https://teamclaw.ucar.cc/install-mac-cn.sh | bash
```

**自动更新端点（`tauri.conf.json`）：**

- `https://teamclaw.ucar.cc/releases/latest.json`
- `https://github.com/different-ai-studio/teamclaw-next/releases/latest/download/latest.json`

**通知：** Release published 后 `wecom-notify.yml` 会推送企业微信（需 `WECOM_WEBHOOK_KEY`）。

## 重新发布 / 手动触发

若某次 tag 构建失败，可在 GitHub → Actions → **Release** → **Run workflow**，输入已存在的 tag（如 `v0.2.1`）重新跑全流程。

## 必需 Secrets

| Secret | 用途 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` + `PASSWORD` | Updater 签名（缺失则构建失败） |
| `BUILD_CONFIG_PRODUCTION` | 生产 `build.config.json` |
| `DEVICE_JWT_SECRET` | 设备 JWT |
| `APPLE_CERTIFICATE` + 相关 | macOS 代码签名（缺失则 ad-hoc，用户需 `xattr`） |
| `OSS_*` | 国内 CDN 镜像（**teamclaw-next 仓库必须配置**，否则 OSS 端点不会更新） |
| `UPDATER_GITHUB_TOKEN` | macOS job 写 GitHub Release |

生产配置结构参考 `build.config.example.json`。

## 本地打包（不替代 CI 发布）

| 命令 | 说明 |
|------|------|
| `pnpm tauri:build` | 当前架构生产包 |
| `pnpm tauri:build:mac:all` | macOS 双架构 |
| `pnpm tauri:build:win` | Windows NSIS |
| `pnpm verify-release` | 快速本地 release 构建验证 |

正式发布 **只认 CI 产物**，避免本地 DMG 与线上 updater 不同步。

## macOS 用户提示

当前应用尚未 Apple 公证。首次从网络下载后需执行：

```bash
sudo xattr -dr com.apple.quarantine /Applications/Teamclaw.app
```

Release notes 中已包含此说明。
