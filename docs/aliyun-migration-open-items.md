# 阿里云迁移 — 待办跟踪

迁移目标：RDS Supabase（`http://47.115.253.201:80`）+ FC（`https://cloud.ucar.cc`）+ EMQX（`mqtt://ai.ucar.cc:1883`）。

状态图例：`🔴 阻塞` · `🟡 进行中` · `🟢 完成` · `⚪ 可选`

---

## 事项：JWT 注入 MQTT `acl`（Custom Access Token Hook）

| 字段 | 内容 |
|------|------|
| **状态** | 🔴 阻塞（上线前必须完成） |
| **ID** | `aliyun-migration-001-acl-hook` |
| **问题** | 用户 `access_token` 中无 `acl` / `app_metadata.memberships`；EMQX 严格 topic 授权依赖 JWT 内 `acl` claim。 |
| **库侧** | 🟢 `public.amux_access_token_hook`、`public.amux_acl_rules_for` 已迁移；service role 调 RPC 可返回 ~11 条 `acl`。 |
| **GoTrue** | 🔴 未绑定 hook；签发 token 时未调用上述函数。 |

### 已尝试且无效的路径

- Supabase Studio ` /project/default/auth/hooks`：页面存在，仅骨架、无法添加 Hook。
- OpenAPI `ModifyInstanceAuthConfig`：`GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED` / `_URI` → `Invalid parameter key`（白名单不含 Hook 配置项）。
- OpenAPI `DescribeInstanceAuthInfo`：实例 `ra-supabase-mmv2yzducob1q1`（`cn-shenzhen`）可读；ConfigList 无 Custom Access Token 相关键。

### 需要做的（二选一）

1. **阿里云工单 / 平台运维** — 在 Auth（GoTrue）注入并 **重启 auth**：
   ```text
   GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED=true
   GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI=pg-functions://postgres/public/amux_access_token_hook
   ```
2. **自有运维** — 若能登录 Supabase 宿主机，在 **auth 容器** 设同上环境变量并重启。

若 Studio 下拉仅显示 `custom_access_token_hook`，可先建包装函数：

```sql
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT public.amux_access_token_hook(event); $$;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
```

### 验收标准

- [ ] 用户 **重新登录**（旧 session 无效）后，解码 `access_token` 含非空 `acl` 数组（有团队成员通常 ≥10 条，末尾含 `deny` + `#`）。
- [ ] 同 token 含 `app_metadata.memberships`（有团队时 ≥1 条）。
- [ ] EMQX：member / agent 各用正确 `actor_id` + 新 token 测 connect；关键 topic subscribe/publish 符合预期（在 EMQX 已配置读取 `acl` 的前提下）。

### 当前可并行能力（不替代本事项）

- EMQX **JWT 验签**（HS256 + JWT Secret）已通，CONNACK OK。
- Cloud API / 建团队 / bootstrap 正常。
- **无 `acl` 时**：连接可能成功，但 **不符合** TeamClaw Phase 1 的 MQTT 安全模型（见 `docs/architecture/v2.md` §4.4 三层校验）。

### 参考

- 迁移函数：见 `services/supabase/migrations/20260601000000_baseline.sql`（`amux_access_token_hook` 段）
- pgTAP：`services/supabase/tests/006_access_token_hook.sql`
- 记录日期：2026-05-30

---

## 其它迁移项（摘要）

| 事项 | 状态 |
|------|------|
| FC `SUPABASE_URL` 指向阿里云 | 🟢 |
| GitHub Secrets `SUPABASE_*` | 🟢 |
| EMQX JWT（HMAC）验签 | 🟢 |
| `GOTRUE_SITE_URL` / `API_EXTERNAL_URL` 仍为 localhost | 🟡 待改 |
| 客户端默认 `config/services.default.json`（Cloud API + MQTT，无 Supabase） | 🟢 |
| Studio Auth Hooks UI 可用 | 🔴 见本文件主事项 |
