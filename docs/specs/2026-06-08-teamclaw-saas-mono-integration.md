# teamclaw × saas-mono 登录与租户整合 —— 统一 Spec & 执行计划

**单一事实来源**。状态：实施中。最后更新 2026-06-08。
**分支**：`agent/saasmono-integration`（worktree `.worktrees/saasmono-integration`）。
**提交**：`934613fa`(S1) · `647597d1`(S2) · `349375ff`(S3)。

---

## 1. 目标

让 teamclaw 复用 saas-mono 的 `public.orgs` 做租户真相源、共用一套登录（GoTrue），
两个产品最终跑在 **saas-mono 的阿里云自建 Supabase** 上：saas-mono 占 `public`，
teamclaw 全部业务表搬到 `amux` schema 隔离。

## 2. 锁定的决定

| # | 决定 |
|---|---|
| D1 | saas-mono 的自建 Supabase **当家**，teamclaw 迁入（单实例/单 GoTrue/单 auth.users） |
| D2 | 租户：**单 org/user**；org=租户边界，team=org 内协作单元 |
| D3 | **保留 teams 表**，加 `oid` 外键 → `public.orgs(id)`（1 org:N team，FK 列非 join 表） |
| D4 | **不重命名 team_id**（客户端继续用 teamId，零大改） |
| D5 | 登录：统一一个 GoTrue，JWT `app_metadata.org_id` 当租户上下文 |
| D6 | **不做数据迁移**（按全新状态设计） |
| D7 | **Better-Auth 保留不退役**，与 GoTrue 并存（account/session/user/verification/jwks 不动） |

## 3. 目标架构

```
saas-mono 自建 Supabase（唯一实例 / 唯一 GoTrue / 唯一 auth.users）
├── public  (saas-mono 拥有)
│   ├── orgs   ← 唯一租户真相源
│   ├── users  ← auth_user_id→auth.users, org_id→orgs（单 org/user）
│   ├── plans
│   └── account/session/user/verification/jwks ← Better-Auth（保留）
└── amux   (teamclaw 拥有，35 张业务表)
    ├── teams        ← 加 oid → public.orgs(id)
    ├── actors / team_members / sessions / messages / ...（team_id 不变）
    └── (RAG: ag_catalog/mem0/dataset_* 按需装扩展后迁入)
租户隔离：amux.teams.oid 传递性归属唯一 org + RLS teams_org_guard + is_team_member
登录：GoTrue 签发 token，amux_access_token_hook 注入 app_metadata.org_id + memberships + acl
```

---

## 4. 当前状态总表（← 看这里就不乱）

| 阶段 | 内容 | 状态 | 落点 |
|---|---|---|---|
| **S1** | `public.orgs` + `plans` 桩 + `update_audit_columns()` | ✅ **已上 prod 47.x** | 迁移 `20260608000000` |
| **S3A** | `public.users` 子集镜像 + `app.current_org_id()` + orgs RLS | ✅ **已上 prod 47.x** | 迁移 `20260608020000` |
| **S2** | 35 业务表 public→amux + teams.oid + 重写 64 函数 | 🟡 写好+**干跑验证过**，未应用 | 迁移 `20260608010000` |
| **S2d** | FC 默认 schema=amux + 41 个 .rpc→`.schema('public')` | 🟢 改好 + **typecheck 干净**（5 个错经还原对比证实 pre-existing） | FC 5 文件 |
| **S3B** | provisioning 默认 team + hook 注 org_id + teams_org_guard | 🟡 写好+**干跑验证过**，未应用 | 迁移 `20260608030000` |
| **S3-FC.1** | create_team 加 p_oid + FC createTeam 传 token org_id | 🟡 写好+**干跑(功能)验证**+typecheck 干净 | 迁移 `20260608040000` + supabase-repo.ts |
| **S3-FC.2** | 匿名 lazy-provision 个人 org（createTeam 路径，无 org 时 ensure_personal_org） | ✅ **已上 prod**（public-only）+ 干跑功能验证 + FC typecheck 干净 | 迁移 `20260608050000` + supabase-repo.ts |
| **S3-FC.3** | claim_team_invite 换 org（严格单 org，清理弃用个人 org） | ⬜ 未写（独立子项） | 迁移 + FC |
| **S4** | 在 saas-mono 实例落地 + 切流 | ⬜ 未开始 | 跨实例 |

**prod 47.x 此刻实况**：已永久存在 `public.orgs/plans/users` 镜像 + `app.current_org_id()` + orgs RLS。
全是加法，对现有 teamclaw 和四端客户端**无感**。amux 搬迁与 S3B 守卫/钩子**尚未应用**。

---

## 5. 执行计划（线性，含验证/回滚）

### ✅ 已完成
- **S1 / S3A** 已应用 prod 并验证（表/函数/策略/触发器就位，回滚事务实测插入通过，零残留）。

### ⬜ Step A — FC 代码收尾（S2d 校验 + S3-FC，可现在做，不碰实例）
1. worktree 装依赖 → 跑 `pnpm --filter fc typecheck` + FC 测试，给 S2d 的 41 处 .rpc 改动兜底。
2. 写 S3-FC：org onboarding/首登流程调用 `app.ensure_org_default_team(org_id)`；FC 从 JWT `app_metadata.org_id` 解析租户上下文（替代信客户端传的 team 作租户边界）。
3. 闸门：typecheck + FC 测试全绿。
4. 回滚：纯代码，分支可弃。

### ⬜ Step B — testsupa 预演（强烈建议，先于 prod 切）
1. 在 testsupa 顺序应用 S1→S3A→S2→S3B。
2. 改 testsupa PostgREST `PGRST_DB_SCHEMAS` 加 `amux`。
3. 部署带 S2d 的 FC 指向 testsupa。
4. 闸门：26 个 SQL RLS 测试 + FC 测试全绿；**端到端验一次登录**（确认 token 带 org_id、hook 没挂）。
5. 这步把所有 🔴 风险（hook、PGRST、协同切）在非生产先趟一遍。

### ⬜ Step C — prod 切换（停机窗口，⚠️ 不可灰度）
**必须三件事同一窗口一起做**（否则 FC 旧 `.from()` 默认 public 即刻全断）：
1. 我跑迁移 `20260608010000`(S2) + `20260608030000`(S3B)。
2. 你改 prod PostgREST 容器 `PGRST_DB_SCHEMAS` 加 `amux`（保留 public）+ 重启。
3. 你部署带 S2d + S3-FC 的 FC。
4. 闸门：登录冒烟 + 租户隔离冒烟。
5. 回滚：SET SCHEMA 反向 + drop teams.oid/守卫 + FC 默认 schema 改回 + PGRST 还原 + hook 还原。

### ⬜ Step D — 合并到 saas-mono（S4，最后）
前置（先在 saas-mono 实例跑只读查询确认）：
```sql
select version();  -- 对齐我们 PG 18.3
select name, installed_version from pg_available_extensions where installed_version is not null order by 1;  -- 差集：age 1.6.0 / vector 0.8.1.2 / pg_cron / pg_net
select schema_name from information_schema.schemata where schema_name in ('amux','app','agent_knowledge','mem0','mem0_graph');  -- 命名冲突
```
+ 装扩展差集、统一 GoTrue `JWT_SECRET`、saas-mono PGRST 加 amux。
然后在 saas-mono 实例应用 S2/S3B（S1/S3A 的 orgs/users/plans 跳过——saas-mono 已有），FC 切 `SUPABASE_URL`+统一密钥，切流。

---

## 6. 风险登记

| 风险 | 级别 | 缓解 |
|---|---|---|
| S3B hook 改 live 致登录中断 | 🔴 | Step B testsupa 先测登录；hook 有 exception→return event 防御 |
| 协同切窗口（S2+PGRST+FC 必须同时） | 🔴 | Step C 窗口；Step B 先预演 |
| PostgREST 暴露 amux（PGRST_DB_SCHEMAS 容器 env，非 config.toml） | 🔴 | Step B/C 清单 |
| saas-mono PG 大版本对齐（我们 18.3） | 🔴 | Step D 前置只读查询 |
| 扩展差集（age/pgvector/pg_cron/pg_net） | 🟡 | Step D 前置 |
| FC S2d 未 typecheck | 🟡 | Step A |
| plans/users 子集镜像 vs saas-mono 全表对齐 | 🟡 | Step D 前对齐 DDL |
| JWT secret 统一 | 🟡 | Step D |

**已消除**：多团队→单 org 收敛、team_id→oid 客户端大改、跨实例数据迁移（因 D3+D6）。

## 7. 关键技术事实（避免重复踩）

- prod 47.x = 生产，自建 Supabase，PG **18.3**；supabase-admin MCP 指向它。
- `apply_migration` 缺 DATABASE_URL 不可用 → 用 `execute_sql` 应用；干跑 = 整段塞 DO 块末尾 `raise exception` 原子回滚。
- 42 张 public 表：搬 amux 35 张；留 public 7 张（orgs/plans + 5 张 Better-Auth）。
- 函数留 public，只重写函数体 `public.<表>→amux.<表>`（64 个）+ search_path 补 amux；因此 41 个 FC `.rpc` 要 `.schema('public')`。
- saas-mono signup 的 orgId 是**必填输入**（org 先存在，不在 signup 建 org）→ provisioning = 挂到已有 org 时建默认 team。
- create_team RPC 签名：`(p_name, p_slug, p_litellm_team_id, p_ai_gateway_endpoint, p_display_name)` → S3-FC 加 `p_oid`。
- claim_team_invite(p_token)：①认领预建匿名 member 槽（target_actor_id，校验 is_anonymous，给该匿名用户发 session）②已登录/匿名用户 `auth.uid()` 直接加入 invite 的 team（插 actor/member/team_members）。

## 8. 匿名登录 & 协作边界（决定：仅本组织内 / 严格单 org）

teamclaw 用 GoTrue 匿名用户（`auth.users.is_anonymous`），首启 bootstrap 建个人 team。
整合后：

**匿名 = 一人个人 org（lazy-provision，已实现 S3-FC.2）**
- createTeam 路径：caller 无 org 时调 `public.ensure_personal_org()`（幂等：建个人 org + `public.users(auth_user_id, org_id)`，受 `uq_users_auth_user_id` 唯一约束保单 org/user + 并发兜底）。
- 首个 team = 客户端 bootstrap 显式调的 `POST /v1/teams`，被 S3-FC.1 用该个人 org 盖 `oid`（**不另建默认 team,避免重复**）。`app_metadata.org_id` 由 hook 从 public.users 注入 token。
- `ensure_org_default_team`（S3B）保留给"saas-mono 已有 org → 建默认 teamclaw team"那条路径。

**升级（匿名→正式邮箱/手机/Apple）**
- GoTrue 升级保留同一 `auth.users.id` → org_id + 数据**无缝继承**，零迁移。✅ 天然干净。

**协作边界 = 仅本组织内（严格单 org）**
- 用户的所有 actors/teams 都在其唯一 org 内；`teams_org_guard`（oid = current_org_id）**保持不变**。
- **invite-claim = 换 org**：用户认领指向 org Y 的 team 邀请时，其 org 重置为 Y，原匿名个人 org X（及其默认 team）并入/弃用。
- ⚠️ **待实现（claim 改造）**：`claim_team_invite` 需在加入 invite team 时把 claimer 的 `public.users.org_id` + `auth.users` 的 `app_metadata.org_id` 改成该 team 的 `oid`，并清理其被弃用的个人 org（否则 claimer 会同时挂在 X、Y 两个 org 的 team 上，违反严格单 org）。这是 S3 之后的独立子项。
