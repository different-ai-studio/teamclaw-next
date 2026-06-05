# AI-SaaS 平台:Deploy Provider 抽象层(S4)+ 平台 Batteries 设计

> 状态:草案(brainstorming 产出,待评审)
> 日期:2026-06-05
> 范围:S4(Deploy Provider 抽象层)为主交付;附平台级 batteries 清单作为 S3/S6 的需求来源。

## 0. 背景与定位

把现有 `saas-mono`(内部名 betly,垂直攀岩 SaaS:Hono + Supabase/FC3 + TanStack admin + Taro)
与 `teamclaw`(Tauri + React 桌面 AI Agent 平台 + amuxd daemon + FC 云后端)结合,改造为一个
**面向中小商家的"商家应用 PaaS"**。

收敛后的整体架构(一句话):

> betly 去垂直化为通用 **Core SaaS**(客户/商品/销售/权限/文件/消息,API 化)→ **TeamClaw
> Desktop** 用 AI 为每个商家 **codegen 完整的 TanStack Start + Drizzle 工程** → 推 git、Coolify/
> Dokploy 编排部署 → 各自**独立 pg schema(共享实例)、独立逻辑模块** → 通过 SDK 调 Core SaaS;
> 大客户下沉独立部署。**攀岩业务重建为平台上第一个 Customer App,吃自己狗粮验证闭环。**

### 0.1 已锁定的四个架构决策(brainstorming)

1. **隔离模型 = 混合(逻辑独立、物理共享)**:每商家独立 pg schema(非独立实例)、独立逻辑模块,
   共享平台运行时与基础设施;大客户可下沉到独立部署。
2. **AI 产物 = 真实工程代码(codegen)**:AI 生成完整 TanStack Start + Drizzle 工程,作为可部署
   模块运行;创造力无上限。
3. **Core SaaS 来源 = betly 去垂直化**:攀岩业务降级为平台上第一个 Customer App(dogfood)。
4. **部署底座 v1 = Dokploy**(原生 Docker Swarm 横扩 + 可下钻底座),包在自有 `DeployProvider`
   抽象后面,预留裸 Swarm / k3s 适配器逃生口。

## 1. 架构图(端 / 云 / Core SaaS / Customer App)

```
┌──────────────────────────────────────────── 端 (Clients) ────────────────────────────────────────────┐
│  TeamClaw Desktop (Tauri+React)        iOS/Expo      商家管理员浏览器        商家终端用户浏览器/小程序      │
│   · AI 生成/编辑/预览 app                                                                                │
│   · daemon(amuxd): git/OSS·secret·ACP                                                                  │
│     │①push 生成代码     │②调平台API「给商家Y部署app」                  │管理后台(betly admin)  │访问商家应用 │
└─────┼──────────────────┼───────────────────────────────────────────────┼──────────────────────┼────────┘
      ▼                  ▼                                                 ▼                      │
┌─────────────────────────────────────────────── 云 (Cloud) ──────────────────────────────────────┼──────┐
│  ┌────────────┐   ┌──────────────────────────────┐   ╔═════════════ Core SaaS ════════════════╗  │      │
│  │ Managed Git │   │ Deploy Orchestrator (S4)      │   ║ /v1 API (FC3 serverless, 无状态)        ║  │      │
│  │ (codeup)    │◀─┐│ 常驻容器·跑在 Dokploy/Swarm    │   ║ 客户CRM·商品·销售·权限·文件·消息         ║  │      │
│  │ 每商家一repo │  ││ · DeployProvider 契约          │   ║ 多租户 tenant_id 隔离                   ║  │      │
│  └─────┬──────┘  ││ · DokployAdapter(薄映射)       │   ╚═══════╤═════════════════════╤═════════╝  │      │
│        │git-source││ · 异步job/状态/幂等            │           │core 数据             │⑥认证终端用户 │      │
│        ▼ push即部署│└──┬────────────┬───────────────┘           ▼                     │            │      │
│  ┌─────────────────────────────┐   │④SchemaProvisioner   ┌──────────────────────────────┐ │            │      │
│  │ Dokploy/Swarm + Traefik      │   │ 建 merchant schema  │ Shared Postgres + pgbouncer  │ │            │      │
│  │ (Customer App 部署底座)       │   └────────────────────▶│ core数据 │schema_A│schema_B  │ │            │      │
│  │  app容器A  app容器B  大客户独立│                        └──────────────▲───────────────┘ │            │      │
│  └──────┬──────────────────────┘    自动TLS·<merchant>.apps.<域>       │⑤app读写自己schema  │            │      │
│         │  其它云能力: OSS · MQTT · LiteLLM 网关 · CDN                  │                    │            │      │
└─────────┼───────────────────────────────────────────────────────────┼────────────────────┼────────────┼──────┘
          ▼ ═══════════ Customer App (生成的商家应用) ═══════════════════╪════════════════════╪═════════════
   ┌──────────────────────────────────────────────────────────────┐   │                    │
   │ TanStack Start + Router/Query + Drizzle (真实工程代码)          │───┘⑤自己的 pg schema  │
   │ · AI codegen 产出, push→managed git, Dokploy 构建运行          │                        │
   │ · ⑥认证终端用户   · 调 Core SaaS /v1(服务身份) ◀───────────────┼──── core 能力          │
   │ · 独立代码·独立schema·独立逻辑;大客户可下沉独立部署             │◀───────────────────────┘ 终端用户访问
   └──────────────────────────────────────────────────────────────┘
```

数据流编号:① AI 生成代码 push 到 managed git;② Desktop 调平台 API 触发部署;③ Orchestrator 经
DokployAdapter 调 Dokploy 从 git-source 构建起容器;④ SchemaProvisioner 建 `schema_<商家>`+role+DSN;
⑤ Customer App 经 pgbouncer 读写自己的 schema;⑥ Customer App 认证终端用户并以服务身份调 Core SaaS `/v1`。

## 2. 平台自身部署边界

| 工作负载 | 形态 | 部署方式 |
|---|---|---|
| Core SaaS `/v1`、auth 等**无状态请求/响应业务 API** | stateless,serverless 自动扩缩 | **留在 FC3**,无迁移理由 |
| **Deploy Orchestrator(S4)+ 长耗时/常驻活**(异步 job、状态轮询、reconcile、状态流式回传) | 长耗时、常驻,FC3 请求级+超时不适配 | **常驻容器,跑在 Dokploy/Swarm 上** |

结论:**只有 S4 编排器"想离开 FC、上 Dokploy"**(因为部署长耗时异步);其余 FC 后端继续留在 FC。
"全量搬上 Dokploy(sovereign PaaS)"是合法终局,但属**单独迁移项目**,被真实痛点驱动,不预先做。

## 3. S4 Deploy Provider — 范围

- **是**:平台调用的"部署引擎"内部契约。输入"为商家 Y 部署这个 app",输出"它在线上跑 + 有域名 +
  有自己的 DB schema"。把平台和具体部署后端(Dokploy v1 / 裸 Swarm / k3s)解耦。
- **不是**:不是 codegen、不是管平台自身基础设施、不是通用 IaC。只负责 Customer App 的部署生命周期。

## 4. 接口契约(S4 的核心交付物)

稳定、带版本的内部接口,返回**自有领域类型**而非 Dokploy 类型(适配器负责映射):

```
DeployProvider:
  provisionApp(merchantId, AppSpec)      -> AppHandle      # 注册一个 git-source app
  setEnv(AppHandle, env)                 -> void
  bindDomain(AppHandle, domain, tls)     -> void
  deploy(AppHandle, gitRef)              -> DeploymentId   # 异步
  getStatus(AppHandle | DeploymentId)    -> Status + logs
  restart / scale(AppHandle, ...)        -> void
  destroyApp(AppHandle)                  -> void           # 连带 dropSchema

SchemaProvisioner:                       # 独立子接口,便于将来拆走
  provisionSchema(merchantId)            -> { schema, role, dsn }
  dropSchema(merchantId)                 -> void

AppSpec = { name, gitRepoUrl, gitRef, build(dockerfile/buildpack),
            port, healthcheck, resources, targetGroup, env, domains }
```

## 5. 关键功能点与职责归属

**别重造 Dokploy 已白送的东西。** S4 我们真正写的是一层很薄的编排。

| # 功能点 | 我们写的代码 | 谁实际干活 |
|---|---|---|
| 1 DeployProvider 契约 | ✅ 全是我们的(核心交付) | — |
| 2 Dokploy 适配器(git-source 模式) | ✅ 薄映射层 | **构建/部署是 Dokploy 干的** |
| 3 SchemaProvisioner | ✅ 建 schema/role/DSN 编排 | PG/pgbouncer=**运维**;drizzle 迁移=**生成的 app 自跑** |
| 4 异步 job 部署模型 | ✅ 控制面(enqueue→deploymentId→轮询/回调) | — |
| 5 状态/日志回传 | ✅ 拉取+结构化+转发 | **日志/状态由 Dokploy 产出** |
| 6 域名/TLS | ⚠️ 只写 `bindDomain` 调用 | **Traefik/Dokploy 自动签证书路由**;通配 DNS=**运维一次性配** |
| 7 幂等/补偿/状态表 | ✅ 控制面逻辑 + `merchant_app` 表 | — |
| 8 凭证隔离 | ⚠️ 取用逻辑 | **secret store=daemon 已有能力**,复用 |
| 9 生命周期编排(建/更新/销毁/重启/扩缩) | ✅ 编排 | 实际起停销毁=**Dokploy 执行** |
| 10 契约测试 + 门控集成测试 | ✅ 全是我们的 | — |

## 6. 关键设计决策(已定推荐值)

1. **位置 = 服务端控制面 + 异步 job 模型**。Dokploy token / DB 超级权限绝不下放桌面;部署长耗时
   →`enqueue → deploymentId → 轮询/回调`,不做同步 HTTP。
2. **部署源 = git-source**(Dokploy 从 git 拉取构建,push 即自动部署),贴合 managed-git/codeup,
   无需自建镜像 registry。
3. **DB provision = 共享 PG 实例 + schema-per-merchant**:`merchant_<id>` schema + 最小权限 role
   (只能碰自己 schema),DSN 带 `search_path` 注入 app env;迁移由生成的 app 在 release 阶段自跑
   `drizzle-kit migrate`。
4. **状态/幂等 = 命令式 + 幂等**(按 `merchantId+appName`),v1 不做完整 reconcile loop,但保留升级
   到 desired-state 调和的路径;部分失败用有序操作 + 补偿清理。

## 7. 非功能约束

- **连接数红线**:Postgres 几千 schema 可接受,但连接数先爆 → **必须配 pgbouncer(transaction 模式)**。
- **FC 超时**:部署编排器不能跑在 FC3 同步请求里(超时)→ 常驻容器 + 异步 job。
- **凭证隔离**:Dokploy API token、DB 超级权限只在控制面 secret store;商家 app 网络上只能到
  Core SaaS API + 自己 schema。
- **后端 API 不稳定**:Dokploy/Coolify API 均 0.x、会破坏性变更 → 适配器保持极薄 + 对录制 API
  契约测试 + 钉住 Dokploy 版本。

## 8. 测试策略

- **契约测试**:任何适配器(Dokploy/Swarm/k3s/Mock)都要过统一 `DeployProvider` 契约测试。
- **集成测试**:DokployAdapter 对 docker-compose 起的临时 Dokploy 跑**门控**集成测试(CI gated)。
- **单元测试**:MockAdapter 驱动控制面生命周期(幂等、补偿、状态表)。

## 9. 平台 Batteries 清单(S3 Customer App 模板 / S6 Core SaaS 的需求来源)

**平台帮 Customer App 做完的基建越多,AI 要生成的"管道代码"越少、codegen 成功率越高,且密钥
(支付/DB/OSS)永不落进生成的代码。** betly + teamclaw 两边大半已造好;平台的活主要是"把已有能力
打包成 Customer App 能直接调的 batteries"。✅=已有可复用,🔨=需新建/改造。

### A. 身份与安全
- 🔨 终端用户认证(手机号/OTP/微信/密码)、会话、JWT(S1;betly 有 Supabase JWT 底子)
- 🔨 App→Core 服务身份 token + 商家身份注入(S1)
- ✅ RBAC/角色权限中间件(app 直接复用,betly 权限模型)
- ✅ Secret 注入(daemon secret store + S4,app 不持有原始密钥)

### B. 数据层
- 🔨 每商家 pg schema 自动 provision + 最小权限 role + DSN(S4)
- 🔨 Drizzle 脚手架 + pgbouncer 连接 + release 阶段自动迁移(模板内置)
- ✅ 基础表约定(tenant_id / 软删除 / 审计字段)脚手架(betly database-guidelines)
- 🔨 自动备份 / 数据导出 / 删除(合规)

### C. 业务能力(Core SaaS SDK)
- 🔨 客户CRM / 商品 / 销售 / 权限 / 文件 / 消息 typed SDK(OpenAPI 已有,生成 SDK + 去垂直化 API,S2/S6)
- 🔨 SDK 自动带服务身份 token、tenant 上下文、重试

### D. 部署与运维(= S4,基本全自动)
- 🔨/✅ push 即部署 · 域名 · 自动 TLS · 环境变量 · 回滚 · 健康检查 · 大客户独立部署(S4 + Dokploy 白送)。商家/AI **零运维**。

### E. 集成能力(调一下就有,密钥在平台)
- ✅ 支付(微信支付/支付宝)+ 回调对账(betly WeChat Pay)
- ✅ 通知(短信 / 微信模板消息 / 站内信 / 推送)(betly 短信微信 + teamclaw APNs)
- ✅ AI 网关(智能客服/生成,带额度计费)(teamclaw LiteLLM)
- ✅ 对象存储 + 图片处理(签名 URL,app 不碰 OSS 凭证)(betly OSS + sharp)
- ✅ CDN / 边缘防护 / 限流(teamclaw OSS-egress CDN 工程)

### F. 前端脚手架(AI 拼装而非从零写)
- ✅ UI kit / 设计系统 token / shadcn 组件(betly blocks 包 + shadcn)
- ✅ CRUD 区块 / 后台管理脚手架(betly portal-crud)
- ✅ i18n 基础设施(teamclaw i18n 体系)
- ✅ 多端壳:小程序(Taro)/ 移动端(betly Taro)

### G. 调度与可观测
- ✅ 定时任务 / 后台 job 队列(teamclaw cron + Dokploy scheduler)
- ✅ 日志 / 错误上报 / metrics(Sentry)

> 总结:端到端帮 Customer App 做完四层——① **身份**(认证+权限+密钥)② **数据**(schema+迁移+备份)
> ③ **能力**(支付/通知/存储/AI/CRM 全调 SDK)④ **运维**(部署/域名/TLS/CDN/监控全自动)。
> **AI 生成的 Customer App 实际只剩"业务逻辑 + 页面"要写**,兑现原则:门槛压到最低、上限不封顶。

## 10. 范围之外 / 后续适配器

- `SwarmAdapter`(裸 Docker Swarm,逃生口)、`K3sAdapter`(规模终局)——本 spec 只留接口位,不实现。
- 完整 desired-state reconcile loop——v1 不做,留升级路径。
- 平台后端全量迁出 FC(sovereign PaaS)——单独项目。

## 11. 子项目地图(本 spec = S4)

| # | 子项目 | 作用 | 阶段 |
|---|---|---|---|
| S0 | 仓库与骨架策略 | monorepo 怎么合、Core 落 betly 哪、teamclaw 怎么进 | 地基 |
| S1 | 认证联邦 | 三层 token(终端用户/App→Core/商家身份) | 先做,横切 |
| S2 | Core SaaS 单域契约 | 先抽客户(CRM)一个域:多租户 API + OpenAPI + SDK | MVP 纵切 |
| S3 | Customer App 运行时模板 | 最小 TanStack Start + Drizzle:认证终端用户、调 S2、独立 schema | MVP 纵切 |
| **S4** | **Deploy Provider + Dokploy** | **本 spec** | MVP 纵切 |
| S5 | TeamClaw codegen 链路 | AI 从 prompt 生成"就是 S3 那个模板" | 闭环 |
| S6 | Core SaaS 去垂直化补全 | 商品/销售/权限/文件/消息 全量 API 化 | 扩展 |
| S7 | 攀岩重建为 Customer App | 狗粮验证全链路 | 验收 |

## 12. 待解问题

1. 控制面常驻容器用什么实现栈(Node/Hono 复用 betly 体系 vs Rust)?job 队列选型?
2. `merchant_app` 状态表落在 Core 的 schema 还是独立控制面库?
3. 通配 DNS 域名根(`*.apps.<域>`)与自定义域接入流程归 S4 还是运维 runbook?
4. Dokploy 版本钉选与升级策略;API 破坏性变更的契约测试录制方式。
