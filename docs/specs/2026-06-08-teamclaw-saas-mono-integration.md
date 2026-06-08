# teamclaw × saas-mono 登录与租户整合方案

**状态**: 设计已锁定（2026-06-08），实施中（阶段 1 已落地）
**分支**: `agent/saasmono-integration`（worktree `.worktrees/saasmono-integration`）
**目标**: 把 teamclaw（teamclaw-v2 / teamclaw-next）的登录和多租户管理与 saas-mono（`/Volumes/openbeta/workspace/saas-mono`）整合，复用 saas-mono 的 `public.orgs` 做租户真相源。

---

## 已锁定的决定

| 决定 | 选择 |
|---|---|
| 数据库/GoTrue 拓扑 | saas-mono 的**阿里云自建 Supabase 当家**，teamclaw 迁入 → 单实例/单 GoTrue/单 auth.users |
| 实例类型 | 两边都是阿里云自建 Supabase（同架构），扩展可自由安装 |
| 租户基数 | 单 org/user（org 层）；org=租户边界，team=org 内协作单元 |
| teams 去留 | **保留 teams 表**，加 `oid` 外键列 → `public.orgs(id)`（1 org : N team，FK 列非 join 表） |
| team_id | **不做 team_id→oid 全局重命名**（避免客户端~2000 处大改） |
| 登录 | 统一一个 GoTrue 当唯一 IdP，token 互认，JWT `app_metadata.org_id` 当租户上下文 |
| 数据迁移 | **不做**（按全新状态设计） |

---

## 阶段 0 前置验证结果（teamclaw 侧，2026-06-08）

- ✅ 机制：跨 schema 外键（amux→public）+ `ALTER TABLE SET SCHEMA amux` 在 PG 18.3 实测通过（回滚事务，零残留）
- ✅ teamclaw 硬依赖扩展：`age` 1.6.0、`vector`(pgvector) 0.8.1.2、`pg_cron` 1.6、`pg_net` 0.19.6（mem0 是建在 AGE+vector 上的 schema，7 表，非扩展）
- ✅ PostgREST 暴露 schema 由容器 env `PGRST_DB_SCHEMAS` 驱动（库内 `pgrst.db_schemas` 为 null）
- 🔴 **新发现**：teamclaw 跑在 **PostgreSQL 18.3**，需确认 saas-mono 实例 PG 大版本对齐
- ⏳ 待 saas-mono 侧执行：PG 版本 / 扩展差集 / schema 命名冲突（只读查询见下）；运维：GoTrue `JWT_SECRET` 统一、`PGRST_DB_SCHEMAS` 加 amux

待在 saas-mono 实例跑的只读查询：
```sql
select version();
select name, default_version, installed_version from pg_available_extensions where installed_version is not null order by 1;
select schema_name from information_schema.schemata where schema_name in ('amux','app','agent_knowledge','mem0','mem0_graph') order by 1;
```

---

## 迁移 runbook（在我们自己的实例先跑通，最后移植 saas-mono）

**纪律**：迁移即代码（写进 `services/supabase/migrations/`）；环境梯度 local→testsupa→prod；每步过测试闸门（26 SQL RLS 测试 + FC 60 测试 + 客户端 typecheck）；每步可回滚。

> 当前执行环境：用户授权**直接在 teamclaw 生产实例 47.115.253.201** 上做（经 supabase-admin MCP）。阶段 1 纯加表安全；阶段 2 的 SET SCHEMA 是会断线的协同切换，需停机窗口 + 明确放行。

### 阶段 1 — 把 orgs 建到我们库里（纯加法）✅ 已落地
- 迁移 `20260608000000_orgs_tenant_mirror.sql`：建 `public.orgs`（saas-mono DDL 镜像）+ `public.plans`（桩，待对齐）+ `update_audit_columns()` 触发器函数。
- orgs 是 **saas-mono 拥有的镜像**，迁移幂等（`if not exists`），标注"合并实例勿重复应用、DDL 勿漂移"。
- **状态**：已在 prod 47.x 应用并验证（orgs 20 列/8 索引/审计触发器/RLS 启用；插入+更新 probe 通过、已回滚）。RLS 启用但暂无策略（仅 service_role 可访问）。
- 回滚：`drop table public.orgs, public.plans; drop function public.update_audit_columns();`

### 阶段 2 — teamclaw 业务表迁 amux + teams 加 oid（主结构改造，⚠️ 需停机窗口 + 放行）
迁移 `20260608010000_move_teamclaw_to_amux.sql`（程序化 DO 块，幂等）。

**搬迁清单（实测 42 张 public 表）**：
- **搬 amux（35 张）**：所有 teamclaw 业务表（actors/sessions/messages/teams/workspaces/ideas/members/team_members/agents/… 全集）。
- **留 public（7 张）**：`orgs`、`plans`（saas-mono 租户镜像）；`account`、`session`、`user`、`verification`、`jwks`（Better-Auth 表，阶段 3 退役，本阶段不动）。

- 2a `create schema amux` + grant usage（表权限/RLS 策略随 `SET SCHEMA` 自动迁移）+ PostgREST `PGRST_DB_SCHEMAS` 加 amux（容器 env，保留 public）。
- 2b 35 张表 `ALTER TABLE … SET SCHEMA amux`；`amux.teams` 加 `oid → public.orgs(id)`（跨 schema FK）。
- 2c **函数留 public**，仅重写函数体 `public.<被搬表> → amux.<被搬表>`（实测 app 20 + public 44 = **64 个函数**）+ search_path 补 amux。函数不搬位置 → 避开函数间互调重写和 GoTrue 钩子 `amux_access_token_hook` 的风险。
- 2d FC supabase 客户端**默认 schema 设 `amux`**（覆盖 243 处 `.from`，零改）；因函数留 public，**41 处 `.rpc` 改为 `.schema('public').rpc(...)`**（5 文件，已实测 FC 无 `.from` 碰 keep-list 表）。
- **RLS org 守卫（`team.oid == jwt.org_id`）挪到阶段 3**（依赖 token 里的 org_id）；本阶段策略保持原 team-scoped 语义随表迁移。
- 闸门：26 SQL RLS 测试 + FC 测试全绿（worktree 未装依赖时在 testsupa/装依赖后跑）。
- ⚠️ **不可灰度**：2b 一执行，FC 旧 `.from()`（默认 public）即刻全断，必须与 2d 部署 + 2a 的 PGRST 改动**协同切换** → 停机窗口。
- **✅ 干跑已验证（47.x，原子回滚零残留）**：moved **35 tables**, rewrote **64 functions**，amux/sessions/teams.oid 回滚后均无残留。
- 回滚：SET SCHEMA 反向 + drop oid + FC 默认 schema 改回 + PGRST 还原。

### 阶段 3 — 本地对齐 saas-mono 登录（Better-Auth **保留不退役**）
拆两块按 amux 依赖切：

**3A（public-only，✅ 已落地 prod）** — 迁移 `20260608020000_org_resolution.sql`：
- `public.users` 子集镜像（auth_user_id→auth.users / org_id→orgs；saas-mono 合并时拥有全表，待对齐）
- `app.current_org_id()`：先读 JWT `app_metadata.org_id`，兜底查 `public.users.org_id`（无 JWT 优雅返回 null）
- orgs RLS `orgs_view_policy`（`id = app.current_org_id()`，镜像 saas-mono；写仅 service_role 绕过）
- 状态：已应用 + 验证（users 表 / 函数 / 策略就位）。纯加表、客户端无感。

**3B（依赖 amux，✅ 已写好+干跑，待随阶段 2 落地）** — 迁移 `20260608030000_org_tenant_guards.sql`：
- `app.ensure_org_default_team(org_id)`：幂等在 org 下建默认 team（slug=org-<id>，oid=org_id），SECURITY DEFINER 绕过守卫
- `amux_access_token_hook` 增强：保留原 acl + memberships，**注入 `app_metadata.org_id`**（保留已有 claim，兜底查 public.users）；保留 `exception→return event` 防御
- `teams_org_guard`：amux.teams 上的 **restrictive** 策略（`oid is null or oid = app.current_org_id()`），与 is_team_member ANDed 做跨 org 防御
- **✅ 干跑验证（47.x，搬 teams/actors→amux + 3B + 实测 provisioning 建默认 team + 实测 hook 返回合法 jsonb，原子回滚零残留）**
- ⚠️ hook 是 GoTrue 登录钩子，改 live 有登录中断风险 → testsupa 测 + 验一次登录再上。

**待补（FC 代码，阶段 3 收尾）**：org onboarding / 首登流程里调用 `app.ensure_org_default_team`；FC 从 JWT `org_id` 取租户上下文。Better-Auth 路径整段保留并存，不动。
- 闸门：注册→org_id + public.users 行 + amux 默认 team；登录 token 带 org_id；`team.oid==org_id` 守卫生效；端到端测一次登录。

### 阶段 4 — 合并到 saas-mono（最后碰他们的实例）
- 前置：PG 版本对齐、扩展差集安装、`JWT_SECRET` 统一、saas-mono PostgREST 加 amux。
- 在 saas-mono 实例应用阶段 2 迁移（orgs 跳过，他们已有）；teamclaw FC 切 `SUPABASE_URL` + 统一密钥；切流。
- 闸门：套件在 saas-mono 重跑 + 登录 + 租户隔离冒烟。回滚：FC 指回我们实例。

---

## 剩余风险

| 项 | 级别 |
|---|---|
| GoTrue/token claims 合并（含 amux_access_token_hook，改错全员登录挂） | 🔴 |
| 阶段 2 SET SCHEMA 协同切换（live prod 会断线，需窗口） | 🔴 |
| PostgREST 暴露 amux（PGRST_DB_SCHEMAS 容器 env） | 🔴 |
| PG 大版本对齐（我们 18.3 vs saas-mono ?） | 🔴 |
| 扩展差集安装（age/pgvector/pg_cron/pg_net） | 🟡 |
| RLS 加 org 一致性守卫 | 🟡 |
| JWT secret 统一（两实例 GoTrue 密钥） | 🟡 |
| Better-Auth：**保留不退役**（用户决定），与 GoTrue 并存 | — |
| plans 桩表与 saas-mono 真实 DDL 对齐 | 🟡 |

**已消除**：多团队→单 org 不可逆收敛、team_id→oid 客户端大改、跨实例数据迁移（因"保留 teams + 不做数据迁移"）。
