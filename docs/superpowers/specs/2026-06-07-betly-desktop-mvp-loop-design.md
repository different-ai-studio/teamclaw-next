# Betly Desktop — 桌面 MVP 闭环设计

> 状态:草案(brainstorming 产出,待评审)
> 日期:2026-06-07
> 关系:本文是 [2026-06-05 Deploy Provider + 平台 batteries] spec 的**客户端配套**,聚焦
> TeamClaw 桌面(= Betly Desktop)这一侧要建设的能力,对应路线图 **S5(codegen 链路)+ Betly Desktop**。

## 0. 背景与范围

Betly Desktop 现在已经是"和 AI agent 对话 + 写代码 + git"的 Tauri 桌面 App。要变成"商家造自己应用
的入口",缺的是**从对话到一个可部署商家应用的完整编排链路**。本文把这条链路的桌面侧拆成四块 + 一个
横切细节(DB 迁移):

1. 工程脚手架(做成 skill 组)
2. per-app codeup git repo(复用现有 managed-git)
3. 本地/云预览(云预览先行)
4. 打通 Dokploy(走 FC,作为 DeployProvider 的 FC 适配器)
- 横切:DB 版本与迁移管理

## 1. 桌面 MVP 闭环

```
对话 ──①──► 脚手架 skill 生成完整 TanStack Start + Drizzle 工程
        ──②──► 建 per-app codeup repo + daemon push
        ──③──► 预览(MVP:Dokploy 云预览拿 URL)
        ──④──► FC 触发 Dokploy 部署 → 上线 <merchant>.apps.<域>
        ◄──── 持续演进:继续对话改 → push → 重新部署(版本可回滚)
```

把这条链打通 = Betly Desktop 的最小可用形态。优先级:**① 脚手架 skill + ④ FC 打通 Dokploy** 是闭环
关键;② 大半已有直接复用;③ 先用云预览几乎免费;**本地预览(P1)延后**。

## 2. 桌面侧能力清单(✅ 复用 / 🔨 新建)

**已有可直接复用,别重造:**

| 已有 | 用途 |
|---|---|
| ✅ ACP agent runtime(会话/对话) | "对话造软件"的对话引擎 |
| ✅ 代码编辑器(CodeMirror/Shiki/Markdown/HTML) | 编辑生成的代码 |
| ✅ daemon git(managed-git / codeup / SSH 免密) | 推生成工程到 repo |
| ✅ daemon diff + 版本历史 | 生成 app 的持续演进、回滚 |
| ✅ secret store(~/.teamclaw/secrets AES-GCM) | 注入凭证(不落代码) |
| ✅ LiteLLM AI 网关 | skills / AI 能力运行 |
| ✅ skills / .mcp 体系 | 脚手架 skill + 企业 skills 的地基 |
| ✅ workspace / Recents | 多 app 管理的雏形 |
| ✅ Cloud API client | 调 FC 的通道 |

**需新建(本 spec 范围):**

- 🔨 工程脚手架 skill 组(模块①)
- 🔨 per-app codeup repo 编排(模块②,复用 managed-git)
- 🔨 预览(模块③)
- 🔨 FC ↔ Dokploy 打通 + 桌面部署 UI(模块④)
- 🔨 DB 迁移轨道(横切,内置进脚手架)

## 3. 模块①:工程脚手架 skill 组

**做成 skill(而非 Tauri 二进制命令)**,理由:贴合 ACP agent 原生可调、模板可版本化/可共享、改模板不
用重发桌面。

- **不是空模板,而是带"轨道"的骨架**:预置 Core SaaS SDK、终端用户认证、Drizzle 配置、Dockerfile、
  部署/release 配置(含 migrate 步骤,见 §7)。**生成即可部署**——这是 harness 的落地。
- 大概是一组 skill,而非一个:
  - `create-app` — 吐出完整 TanStack Start + Drizzle 工程骨架。
  - `add-model` / `add-page` — 增量加领域模型 / 页面。
  - `wire-core` — 接入 Core SaaS 某能力(客户/商品/销售…)。
- 分工:**skill = 骨架与约束,agent = 业务血肉**。skill 保证产物"能跑、能集成、能部署",具体业务页面
  与逻辑由 agent 在对话里继续写。

## 4. 模块②:per-app codeup repo(复用 + 扩展)

teamclaw **已打通 codeup**:FC `/managed-git/create-repo` + `CODEUP_PAT` + daemon git 引擎
(clone/push、SSH 免密)。本模块只需扩展:

- **每个 Customer App = 一个独立 codeup repo**:建 app 时调 create-repo 开专属 repo,daemon
  init/commit/push 生成的工程;后续演进同一 repo。
- 注意点:per-app repo 命名 / 权限隔离;`CODEUP_PAT` 的 git-scope(此前标记"待真实跑验")。

## 5. 模块③:预览策略

**MVP 走云预览,本地预览延后(P1)。**

- **MVP — Dokploy preview 部署当预览**:push 即得一个预览 URL。慢几十秒,但**零本地依赖、且与最终
  运行环境一致**(数据、Core SaaS 连通都真)。
- **P1 — 本地 dev server**:daemon spawn `pnpm dev`(Vite / TanStack Start)+ webview 内嵌
  localhost + 热更新。难点:商家机器要有 node/pnpm(可由 daemon 首启向导统一装,已有装
  git/opencode/amuxd 先例)、首次 `pnpm install` 慢、端口管理、预览需连通 Core SaaS(测试租户/服务
  token)。
- 取舍:本地=快但重(装环境);云=慢但轻且真。MVP 性价比选云预览。

## 6. 模块④:打通 Dokploy —— 走 FC

**结论:桌面 → FC `/v1/apps/...` → Dokploy**,FC 作为 `DeployProvider` 的第一个适配器。

为什么 FC 最合适(而非 daemon 直连 / 新建常驻服务):
- **Dokploy 自身 API 是异步的**:触发部署立即返回,构建在 Dokploy 侧跑,**轮询状态**即可 → FC 只做
  一串**短调用**,每个都在 FC 超时内,不需要 sit-and-wait。
- **凭证留服务端**:`DOKPLOY_TOKEN` 放 FC env,绝不下放桌面。
- **守住边界**:符合 CLAUDE.md"Cloud API 是客户端唯一后端",桌面不直连 Dokploy。

FC 端点(都是短调用):

| 端点 | 作用 |
|---|---|
| `POST /v1/apps/:id/provision` | FC 调 Dokploy 建 git-source app + 建 pg schema |
| `POST /v1/apps/:id/deploy` | 触发 Dokploy 部署,**立即返回 deploymentId** |
| `GET /v1/apps/:id/status` | 透传 Dokploy 状态 + 日志快照(桌面轮询) |
| `POST /v1/apps/:id/rollback` · `DELETE /v1/apps/:id` | 回滚 / 销毁 |

桌面交互:点部署 → 调 FC → 轮询 `status` 显示进度/日志。

FC 够不到的(后路,不阻塞 MVP):① 实时日志流 → 用轮询快照;② 后台 reconcile / 失败重试 / 定时健康
检查 → 需要时用 GHA cron 或加小 worker。`DeployProvider` 接口不变,换/加适配器即可。

## 7. DB 版本与迁移管理(横切)

核心:**代码与库结构两条版本轴,同一真相源 = repo。**

- **生成期**:AI 改 `schema.ts` → `drizzle-kit generate` 产出**带版本号的 SQL 迁移文件**,随代码 commit。
  永不直接改线上库。
- **部署期**:部署容器的 **release / pre-start 阶段**跑 `drizzle-kit migrate`,打到**该商家自己的
  schema**(注入带 `search_path` 的 DSN)。每个 schema 有自己的 `__drizzle_migrations`,迁移**幂等、
  只跑新的**。顺序:provision schema(首次)→ 迁移 → 起新版本 → 切流量;**迁移失败即中止部署、不切
  流量**,旧版本继续跑。
- **每商家独立 schema = 各自按部署节奏迁移**,无需跨租户协调(优于 Salesforce 共享大表)。
- **安全护栏(AI 生成迁移的重点)**:
  - **破坏性变更 gate**:lint 生成的迁移,标红 `DROP COLUMN/TABLE`、`NOT NULL 无默认`、类型收窄等,
    **桌面里要商家显式确认**才放行(复用 saas-mono 的 `audit-db-migration-safety.mjs` 思路)。
  - **expand-contract**:优先加列不删列;重命名/删除拆两次部署(加→回填→下次删),中间态可回滚。
  - **迁移前备份**:apply 前对该 schema 快照(或靠 PG 定时备份)。
  - **forward-only + fix-forward**:迁移单向;坏了再写一条修正迁移,**不在生产数据上跑 down 迁移**。
- **回滚语义(UI 要讲清)**:代码可秒级回滚(Dokploy 重部署旧镜像);**库不自动回滚**,靠 gate + 备份 +
  fix-forward。代码与库回滚不对称。
- **放在哪**:迁移跑在部署容器的 release step(对着自己的 DSN),**FC 只触发部署**;这套"migrate
  release step + 安全 lint + 备份钩子"由**脚手架 skill 内置**进生成工程,商家不用管。

## 8. 依赖与边界

- **依赖 S1 认证联邦**:生成工程的终端用户认证 + 服务身份 token(调 Core SaaS)由 S1 定;桌面持有商家
  operator 身份,经 FC 注入服务凭证。
- **依赖 Core SaaS SDK**:脚手架预置的 typed SDK 来自 Core SaaS(S2/S6)。
- **与 S4 spec 关系**:S4 定义 `DeployProvider` 抽象与 schema provision;本文的模块④ = 该抽象的 **FC
  适配器**,模块⑦的 migrate = S4 中"app 自跑迁移"的具体落地。

## 9. 范围之外 / 后续

- 本地 dev server 预览(P1)。
- 实时日志流 / 后台 reconcile / 失败重试 / 定时健康检查(需要时加 worker 或 GHA cron)。
- 行业模板 / Skills 复用市场。
- 多 app 的统一升级(真代码 codegen 难统一升级,单列议题)。

## 10. 待解问题

1. 脚手架 skill 组的边界:`create-app` 一个大 skill,还是 create + 一组增量 skill?模板存哪(repo /
   skills 仓库 / FC)?
2. per-app codeup 的命名规范与权限隔离;`CODEUP_PAT` git-scope 真实验证。
3. 云预览是否复用正式部署管道(同一 Dokploy app 的 preview 环境)还是独立预览实例?
4. 迁移备份的具体手段(PG 物理备份 / 逻辑 dump / schema 快照)与成本。
5. `DeployProvider` 接口在 FC(TS)与桌面(TS)两侧的契约形态与类型共享方式。
