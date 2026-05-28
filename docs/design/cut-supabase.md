# Daemon 彻底切断 Supabase 直连 — 设计方案

状态：草案
范围：`apps/daemon/` 内所有对 Supabase 的直接 HTTP 访问与 `SupabaseBackend` / `SupabaseConfig` 类型的彻底移除。**desktop / packages/app 不在本文档范围。**

## 1. 背景

当前 daemon 内仍存在一套完整的 Supabase HTTP 客户端（`apps/daemon/src/supabase/`，4 个文件，~2700 行），并且：

- onboarding（`amuxd init <invite-url>`）直接打 Supabase `/auth/v1` + `claim_team_invite` RPC
- `SupabaseBackend` 实现 `Backend` trait，作为 `provider_config.kind == "supabase"` 时的运行时
- `provider_config.rs` 仍带 `ProviderKind::Supabase` variant，并且 `backend.toml` 缺失时回退到旧的 `supabase.toml`
- daemon 身份链路（token 续期、MQTT JWT 签发）目前以 Supabase auth refresh_token 为根

CLAUDE.md 已声明 `cloud_api` 是 canonical backend，`supabase` kind "deprecated, will be removed"。本设计落实这次移除。

## 2. 关键发现 — 比预期简单

调查后发现迁移**不需要后端新增任何 FC 端点**：

| daemon 当前依赖的 Supabase 能力 | FC / CloudApiBackend 现有等价物 |
|---|---|
| `claim_team_invite` RPC（anon） | `POST /v1/invites/claim`（已实现，返回 `actorId/teamId/displayName/refreshToken`，shape 完全对齐 `ClaimResult`） |
| `/auth/v1/token`（refresh→access） | `POST /v1/auth/refresh`（已实现） |
| `/rest/v1/*` 业务表 | `CloudApiBackend` 的全部 `Backend` trait 方法已覆盖 |
| `/storage/v1/object/attachments/*` | `CloudApiBackend::upload_*` 已覆盖（见 `cloud_api/messages.rs`） |
| Supabase access token 签 MQTT JWT | FC `/v1/auth/refresh` 返回的 access_token 已经是 MQTT broker 接受的 JWT（broker 侧 JWKS 已切换）— **需 §5 验证一次** |

`ClaimResult` / `Backend` trait shape 不需要变动。`CloudApiConfig` 与 `SupabaseConfig` 字段几乎一一对应（多了 `url` 字段，`anon_key` 不需要）。`CloudApiConfig` 现存的 `supabase_url` / `supabase_anon_key` 两字段经全仓 grep **运行时无人读取**（仅测试 fixture 填值），属于死字段，本次一并删除。

## 3. 目标状态

完成后，daemon 中：

- 不存在 `apps/daemon/src/supabase/` 目录
- 不存在 `SupabaseBackend` / `SupabaseConfig` / `SupabaseError` 类型
- `ProviderKind` 只有 `PocketBase` 和 `CloudApi` 两个 variant
- `backend.toml` 不再支持 `kind = "supabase"`；遇到旧值 → 启动报错并给出迁移提示
- `supabase.toml` 回退路径删除（参见 §6 的过渡策略）
- `Cargo.toml` 通用 deps（reqwest/jsonwebtoken/base64/aes-gcm/...）保留 — cloud_api backend 也用
- 所有源文件 grep `supabase` 大小写不敏感 **应仅命中**：MQTT broker 注释、deprecated config migration 提示文案

## 4. 迁移步骤（按 commit 顺序）

每一步都应保持 `cargo check -p amuxd` 通过；step 1–3 完成后跑 `pnpm daemon:test`。

### Step 1 — `onboarding/init.rs` 切到 CloudApiBackend

替换 `apps/daemon/src/onboarding/init.rs`：

- 把 `SupabaseBackend::new_without_persistence(SupabaseConfig{ url, anon_key, .. })` 换成 `CloudApiBackend::new(CloudApiConfig{ url: <cloud_api_url>, team_id: "", actor_id: "", refresh_token: "" })`。注意 anon claim：当前 `CloudApiBackend::claim_team_invite` 在 `post()` 内会先调 `access_token()` 拿 bearer，但邀请 claim 是 anon 操作 —— **需要让 `CloudApiBackend` 暴露一个 `claim_team_invite_anon(token)` 路径**：直接 POST 到 `/v1/invites/claim`，不带 Authorization header。FC 侧 `/v1/invites/claim` 当前是否需要 bearer，由调用决定（确认这是个小改）。
- `claim` 返回的 `refresh_token` 直接成为 `CloudApiConfig.refresh_token`，写入新的 `backend.toml`（kind = "cloud_api"）。**不再写 `supabase.toml`。**
- 验证一次 access_token：构造完整 `CloudApiBackend` 调 `access_token()`，确认 refresh→access 链路通。
- env / dotenv 读取：从 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 切到 `CLOUD_API_URL`（无 anon key 需求）。daemon 的 `.env` / `.env.example` 同步更新。
- 错误类型：函数返回类型从 `SupabaseResult<InitOutcome>` 改为 `Result<InitOutcome, BackendError>`（或者新建 `OnboardingError`，封装 `BackendError + io::Error + 配置错误`）。
- `actionable_invite_claim_error` 改为匹配 `BackendError::Rpc { message, .. }`（或 cloud_api 实际返回的 envelope）。
- 测试：6 个现有 `supabase_build_env_*` 测试 → 重写为 `cloud_api_build_env_*`；3 个 `daemon_config_for_invite` 测试无关 Supabase，保留。

### Step 2 — 删 `provider_config.rs` 中的 Supabase 分支

- 删 `ProviderKind::Supabase` variant
- 删 `ProviderConfig::Supabase(SupabaseConfig)` variant
- `BackendConfigFile.supabase` 字段删除
- `load_backend_toml` 删 `"supabase" =>` 分支；改为遇到 `"supabase"` 时返回 `ProviderConfigError::Config("backend kind 'supabase' has been removed; see docs/design/cut-supabase.md for migration")`
- `load_from_paths` 删 `legacy_supabase_path` 参数及回退分支
- 删 `CloudApiConfig.supabase_url` / `supabase_anon_key` 两个死字段
- 调用 `load_from_paths` 的地方（搜 `legacy_supabase_path`）相应清理
- 测试：删 `falls_back_to_legacy_supabase_toml_when_backend_toml_is_missing`、`backend_toml_wins_over_legacy_supabase_toml`；其他保留并清理 fixture

### Step 3 — 删 `daemon/server.rs` 中 SupabaseBackend 分支与测试

- `backend_from_provider_config()` (~257-279)：删 `ProviderConfig::Supabase => SupabaseBackend::new(...)` 分支
- 删测试 `backend_from_provider_config_initializes_supabase_backend()` (~4722-4735)

### Step 4 — 清理 runtime/manager.rs 测试

按已确认决定：直接删除 `test_supabase_with_url()` 辅助函数 + 3 个使用它的测试。CloudApiBackend 已有自己的 mock server 测试覆盖（见 `cloud_api/mod.rs` 的 `#[cfg(test)]` 模块）。

### Step 5 — 清理 backend/error.rs / backend/mod.rs / cli/clear.rs / onboarding/invite_url.rs

- `backend/error.rs`：删 `From<SupabaseError> for BackendError` 映射；删 `maps_rpc_to_supabase_provider_error` 测试
- `backend/mod.rs`：更新文档注释，删除 SupabaseBackend 提及
- `cli/clear.rs`：删 `use crate::supabase::SupabaseConfig`，相应删除 supabase.toml 清理逻辑（如果存在）；保留 backend.toml 清理
- `onboarding/invite_url.rs`：返回类型从 `SupabaseResult<ParsedInvite>` 改为 `Result<ParsedInvite, InviteUrlError>`（新建一个简单的本地错误类型，或并入 OnboardingError）

### Step 6 — 删除 `apps/daemon/src/supabase/` 目录

`rm -r apps/daemon/src/supabase/`，并从 `apps/daemon/src/lib.rs` / `main.rs` 删除 `mod supabase;`。

至此 `grep -rn "Supabase\|supabase" apps/daemon/src` 应只剩注释和 MQTT broker 相关的少量提示文案。

### Step 7 — `.env.example` / 文档清理

- `apps/daemon/.env.example`：删 `SUPABASE_URL` / `SUPABASE_ANON_KEY`，加 `CLOUD_API_URL`
- CLAUDE.md "Backend Access Boundary" 章节把 "deprecated `supabase` backend kind" 那段改成 "removed"
- 顶层 CLAUDE.md "Local files copied into new worktrees" 段提到的 daemon `.env` 描述里去掉 Supabase 字样

### Step 8 — `Cargo.toml`

通用依赖（reqwest/jsonwebtoken/base64/aes-gcm/hkdf/sha2/hex/url）都仍被 cloud_api 用，无 supabase 专属 crate，**Cargo.toml 不动**。

## 5. MQTT JWT 链路验证（现网核查 — 已完成 ✅）

核查时间：2026-05-28，对生产 FC (`https://cloud.ucar.cc`) + 生产 broker (`mqtt://ai.ucar.cc:1883`)。

| 检查项 | 结果 |
|---|---|
| `POST /v1/auth/refresh` 返回 access_token + expiresAt + 新 refreshToken | ✅ 注意请求体字段名是 camelCase `refreshToken`，不是 snake_case `refresh_token` |
| JWT payload 含 `team_id` / `actor_id` / EMQX ACL claim | ✅ 13 条 `amux/{team}/device/{actor_id}/...` allow 规则 + 兜底 `#` deny |
| 用 `actor_id` 作 username、JWT 作 password 连接 broker | ✅ CONNACK (0) |
| SUBSCRIBE 允许的 topic | ✅ SUBACK code 0 |
| SUBSCRIBE 不允许的 topic（如别的 team） | ✅ SUBACK code 0x80（拒绝） |

**意外发现 — 不阻塞但需记录**：

返回的 JWT `iss` 仍然是 `https://srhaytajyfrniuvnkfpd.supabase.co/auth/v1`。FC `/v1/auth/refresh` 在内部把请求代理给 Supabase auth 签 token，不是 FC 自签。

含义：

- **不影响本设计目标**。daemon 只跟 FC 通信，看不到 Supabase 端点。"daemon 切断 Supabase 直连"这件事可以推进。
- 但 "FC 内部彻底脱离 Supabase auth" 是另一个独立项目，不在本设计范围。
- daemon 代码里如果有任何地方校验 token `iss` / `aud` 字段（比如 PSK / JWT 验证逻辑），需要保留对 Supabase 风格 claim 的兼容。Step 1 重写时顺手 grep 一遍 `iss\|aud\|supabase\\.co` 确认。

## 6. 现网用户过渡策略

`backend.toml` + `supabase.toml` 已混合存在一段时间。删除回退后：

- 已经写过 `backend.toml`（任何 kind）的用户：无影响
- 只有 `supabase.toml`、没有 `backend.toml` 的老用户：daemon 启动会直接报错

两种处理方案，建议选 (B)：

- **(A) 一次性迁移工具**：新增 `amuxd migrate-config` 子命令，读旧 `supabase.toml` → 用其中的 `refresh_token` 调 FC `/v1/auth/refresh`（前提是 broker JWT 已统一）→ 写 `backend.toml` (kind=cloud_api)。复杂、需测试。
- **(B) 启动期友好报错**：daemon 启动检测到 `~/.amuxd/supabase.toml` 但无 `~/.amuxd/backend.toml` 时，打印明确的迁移指引：`重新执行 'amuxd init <invite-url>' 以生成 backend.toml`。简单、迁移成本由用户承担一次。**推荐 (B)。**

## 7. 不在本设计范围内的事

- `apps/desktop/src/commands/server_config.rs` 的 `supabase_url` / `supabase_anon_key` 字段删除
- `packages/app/src/lib/backend/supabase/` 前端 supabase backend module
- `packages/app/src/vite-env.d.ts` 的 `VITE_SUPABASE_*` 类型
- `services/fc/lib/supabase-repo.mjs`（FC 内部使用 Supabase 作为存储是 architectural-by-design，不属于"客户端切断"）
- 任何 iOS / Expo / Android 客户端的 Supabase 依赖

## 8. 风险

| 风险 | 缓解 |
|---|---|
| FC `/v1/auth/refresh` 的 access_token 不被 MQTT broker 接受 | §5 现网核查；阻塞设计 |
| `/v1/invites/claim` 要求 bearer，而 onboarding 是 anon 流程 | Step 1 内对 CloudApiBackend 增加 anon claim 路径 |
| 老用户 `supabase.toml` 数据被丢失 | §6 (B) 方案明确报错指引；旧文件不主动删除，用户自己决定 |
| 删除 SupabaseBackend 后某个隐蔽调用点编译失败 | `cargo check -p amuxd` 在每个 step 末跑一次 |
| 测试数据库 (services/supabase/) 的 e2e/integration 测试经由 daemon 调 Supabase | 排查 `tests/` 与 `services/supabase/` 下的 daemon 测试入口；如有依赖，迁到 cloud_api mock |

## 9. 估时

- Step 1（onboarding 切换 + 测试重写）：~3-4h
- Step 2-7（删除 + 清理）：~2-3h
- §5 现网核查：~30min
- 合计：~半个工作日

## 10. 后续

本设计落地后，desktop / packages/app 的 Supabase 残留另起一份姊妹设计（`docs/design/cut-supabase-clients.md`）。
