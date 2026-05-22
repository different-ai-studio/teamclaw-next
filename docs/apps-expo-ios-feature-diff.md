# apps/expo 与 apps/ios 功能差异文档（Goal 使用版）

生成日期：2026-05-22
范围：`apps/expo/` 与 `apps/ios/` 的移动端功能差异
方法：基于源码静态审阅生成，未运行完整 UI 手工流程或测试套件。历史 parity 文档仅作参考，本文以当前源码为准。

## 1. 状态标记

| 标记 | 含义 |
| --- | --- |
| ✅ | 两端基本一致，或差异不影响主流程 |
| 🟡 | 部分一致，有实现深度或链路差异 |
| 🔴 | 一端明显缺失，或关键链路未打通 |
| 🟦 | Expo 独有或 Expo 明显更强 |
| 🧪 | 占位、仅本地生效、或 UI 已有但未接真实链路 |

## 2. 结论先行

1. **主导航已经基本对齐。** Expo 和 iOS 都有 Sessions / Ideas / Actors(Members) / Search 四个主入口，并覆盖设置、邀请、新建会话、新建想法、快捷入口等核心移动端页面。
2. **Expo 已经不只是 onboarding demo。** 当前 `apps/expo` 已覆盖会话列表、会话详情、附件、Slash 命令、mentions、计划面板、todo dock、快捷入口、通知设置、团队与工作区管理等大量产品功能。
3. **iOS 仍然是 runtime/daemon lifecycle 与诊断能力更完整的一端，但 Expo 已补通关键 runtime、iOS/APNs 通知、OAuth 登录链路和主要 Agent 管理入口。** Expo 已接入真实 workspace / agent type 配置，并支持新建会话、添加 Agent、restart runtime、permission response 的 daemon 送达；通知侧已补 iOS APNs token 上传、前台 presence、通知 tap 跳会话；登录侧已补 Apple/Google OAuth sign-in 与匿名账号 link identity；Actor detail 已补 remove、authorized humans、agent defaults、re-invite、workspace add/remove RPC。
4. **Expo 主要风险已从“启动/授权断点”转向“平台收尾”。** 当前仍需补 Android FCM 后端派发；permission allow/deny 已从本地 toast 改为发送真实 runtime command。
5. **Expo 在部分产品管理面比 iOS 更强。** Expo 有团队列表/改名/离开团队、全局 Workspaces 管理、会话批量归档/已读未读、消息编辑/删除/回复/分享等 iOS 未明显暴露的能力。
6. **给 Goal 拆任务时，优先围绕 runtime、权限、push、登录、Agent 管理五条线。** 这些是功能可见性与真实可用性之间的主要断点。

## 3. 架构总览

| 维度 | Expo | iOS | 差异说明 |
| --- | --- | --- | --- |
| 技术栈 | Expo Router + React Native + Supabase JS + MQTT + SQLite/AsyncStorage | SwiftUI + SwiftData + AMUXCore/AMUXUI + Supabase/MQTT/native push | iOS 本地数据模型和平台能力更深；Expo 页面覆盖更快。 |
| 路由/导航 | 文件路由，Tabs + modal routes | SwiftUI TabView + NavigationStack + sheets | 主入口对齐，Expo modal 页面更多。 |
| 本地持久化 | SQLite 主要用于 outbox、connected agents；AsyncStorage 保存 pin、偏好、draft 等 | SwiftData 覆盖 session/message/actor/runtime/workspace/idea/shortcut/outbox 等 | iOS 离线缓存和迁移能力明显更完整。 |
| 实时/消息 | MQTT + Supabase fetch + durable outbox | MQTTMessageHub + SwiftData + Supabase history + reducers | 两端都有实时消息；iOS runtime 状态建模更完整。 |
| Runtime/daemon | 新建会话 spawn、添加 Agent spawn、permission response、restart runtime、workspace add/remove 已触达 daemon | session 创建、添加 agent、restart、workspace RPC、model 等链路更完整 | Expo runtime 主链路已补；iOS lifecycle/diagnostic 操作更深。 |
| Push | 有 push preference API/UI；已接入 iOS APNs token 上传、foreground presence、通知 tap/cold start 跳会话；Android FCM delivery 仍缺后端支持 | APNs 注册、token 上传、前台处理；tap 到会话仍有 TODO | Expo 已补 iOS/APNs 与 tap 主链路；剩余跨端/Android 收尾。 |

## 4. 功能差异矩阵

### 4.1 Onboarding / Auth / Team Bootstrap

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| Welcome / 选择登录方式 / 邮箱 OTP | 已实现 welcome、choose-auth、auth routes；邮箱 OTP 可用 | 已实现 LoginView / OnboardingCoordinator | ✅ | 主登录路径一致。 |
| 匿名创建私有 workspace | Expo 可创建 private workspace 并进入 app | iOS 支持 private workspace anonymous flow | ✅ | 主流程一致。 |
| Apple / Google 登录 | Expo Auth route 已接 Supabase OAuth + WebBrowser 回调 | iOS 有 Apple/Google 登录链路 | ✅ | 需在 Supabase allowlist 配置 `teamclaw://auth/callback` / Expo dev callback。 |
| 匿名账号升级 | Expo 支持 email/password upgrade，并可 link Apple/Google identity | iOS 支持 email/password + Apple credential upgrade | ✅ | Expo 用 Supabase `linkIdentity` 保留匿名用户已有数据。 |
| Invite token claim | Expo layout 处理 deep link/pending invite 并 claim | iOS bootstrap/invite token 处理更深，含 refresh token/team preference | 🟡 | Expo 主链路可用，边界能力弱于 iOS。 |

### 4.2 主导航与全局页面

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| Sessions / Ideas / Actors / Search 四 tab | `app/(app)/(tabs)/_layout.tsx` | `RootTabView.swift` | ✅ | 主信息架构一致。 |
| Settings modal | 独立 settings route，串联 edit-profile / notifications / teams / workspaces / upgrade | SettingsView 以内嵌 sections/sheets 为主 | ✅ | 两端入口形式不同。 |
| Notifications 页面 | Expo 独立 route | iOS Settings 内通知页 | ✅ | 功能深度见 Push 部分。 |
| Teams 页面 | Expo 有团队列表、rename、leave | iOS 设置中主要为当前 team 信息展示 | 🟦 | Expo 更强，但 active team switch 仍未完成。 |
| Workspaces 页面 | Expo 有全局工作区列表/创建/编辑/归档/绑定 agent | iOS 更多在 Agent/workspace 管理上下文里，用 daemon RPC | 🟡 | 两端语义不同，需统一产品决策。 |

### 4.3 Sessions 列表

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 会话列表加载 | Supabase list sessions，按日期分组，支持 refresh | SwiftData + backend refresh，当前列表为 flat list | ✅ | Expo 更接近 web/desktop 的日期分组。 |
| 搜索 | Expo sessions screen 内搜索 | iOS SessionsTab 搜索 | ✅ | 基本一致。 |
| Pin | AsyncStorage local pin | SwiftData local pin | ✅ | 均偏本地语义。 |
| Archive | Expo 单条/批量归档 | iOS swipe archive | 🟦 | Expo 有批量动作。 |
| Mark read/unread | Expo 有批量已读/未读与 unread tab badge | iOS 展示 unread dot，未见批量已读/未读 UI | 🟦 | Expo 更强。 |
| Zero agent reminder | Expo 有 no-agent CTA/reminder | iOS 有 zero-agent reminder | ✅ | 基本一致。 |
| Shortcuts drawer | Expo 会话页可打开 | iOS 会话页可打开 | ✅ | 管理深度见 Shortcuts。 |

### 4.4 新建会话 / Runtime 启动

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 选择协作者/Agent | Expo NewSessionScreen 支持选择 actors/agents | iOS NewSessionSheet 支持选择 collaborators | ✅ | UI 主体一致。 |
| 选择关联 Idea | Expo 支持 ideaId 预填/选择 | iOS 支持 linked idea | ✅ | 基本一致。 |
| 首条消息持久化 | Expo create_session 后插入 first outgoing message | iOS sendMessage(persistFirst: true) | ✅ | 链路实现不同。 |
| Agent workspace/type 配置 | Expo 已读取真实 workspaces、agent defaults/type，并将配置用于 runtime start 计划 | iOS 读取真实 WorkspaceStore/agent defaults/device id | ✅ | 已补 P0；后续仍可增强 Agent defaults 管理 UI。 |
| Runtime start / daemon spawn | Expo 新建会话后对选中 Agent 发布 `runtimeStart` RPC | iOS 新建会话后对选中 Agent 调 runtimeStartRpc | ✅ | 已补 P0；验收重点是 daemon 在线时 Agent 能实际回消息。 |

### 4.5 会话详情 / Chat

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 消息历史与实时流 | Supabase + MQTT + streaming buffers | Supabase history + MQTTMessageHub + ChatTimelineReducer | ✅ | 主阅读/收发链路一致。 |
| Durable outbox | SQLite outbox + retry | SwiftData OutboxMessage + sender | ✅ | 两端都有。 |
| Slash commands | 内置命令 + runtime dynamic commands | iOS composer 支持 Slash | ✅ | Expo 动态命令依赖 runtime info。 |
| Mentions | Expo 有 resolver/mention UI | iOS composer 支持 mentions | ✅ | 基本一致。 |
| 附件 | Expo 支持 image/audio/file pending attachments | iOS 有 attachment upload、voice recorder | ✅ | 类型细节可再验收。 |
| Plans panel / todo dock | Expo 有计划面板和 todo dock parser | iOS 有 plans/todo dock | ✅ | 主功能一致。 |
| Permission request 响应 | Expo permission banner 已发送 `grantPermission` / `denyPermission` runtime command | iOS ViewModel 有 grant/deny 处理 | ✅ | 已补 P0；成功发布后才在本地标记 resolved。 |
| Runtime bar / model prompt | Expo 有 runtime bar/model prompt | iOS 有 runtime status、model change 等能力 | 🟡 | iOS 操作更完整。 |
| Restart runtime | Expo session-members 已 best-effort stop 旧 runtime 并重新 `runtimeStart` | iOS 支持 restart runtime | ✅ | 已补；daemon 状态仍通过 runtime state topic 异步更新。 |
| 消息编辑/删除/回复/分享 | Expo 会话详情暴露 edit/delete/reply/share | iOS inspected surface 未见同等直接 UI | 🟦 | Expo 可能领先，需产品确认是否要 iOS 补齐。 |
| Streaming detail / completed turn detail | Expo 有 message cards/buffers | iOS 有更完整 StreamingDetailView/turn reducer | 🟡 | iOS runtime 调试与 ACP turn 展示更强。 |

### 4.6 会话成员 / Agent 控制

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 查看成员 | Expo session-members route | iOS SessionMembersSheet | ✅ | 基本一致。 |
| 添加 human/agent participant | Expo MemberPickerSheet + addParticipants | iOS AddAgentSheet/成员管理 | ✅ | 记录层面一致。 |
| 添加 Agent 后启动 runtime | Expo add agent 后复用 runtime start 计划并发布 daemon spawn RPC | iOS addAgent 结合 runtime start | ✅ | 已补 P0；与新建会话共用目标 device/workspace/type 解析。 |
| 移除成员/Agent | Expo 有 session participants 操作 | iOS 有 remove/restart/model 等 sheet 操作 | 🟡 | 需按角色权限逐项验收。 |
| 切模型 | Expo 有模型 prompt/展示，操作深度有限 | iOS 支持 model 变更 | 🟡 | iOS 更完整。 |

### 4.7 Ideas

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| Ideas 列表 | Expo ideas tab | iOS IdeasTab | ✅ | 基本一致。 |
| 新建/编辑/详情 | Expo new-idea/idea-detail | iOS IdeaSheet/IdeaDetailView | ✅ | 基本一致。 |
| 状态更新 | Expo 可更新 status | iOS 可更新 status | ✅ | 基本一致。 |
| Archive/restore | Expo 支持归档、Archived Ideas restore | iOS 支持归档、ArchivedIdeasView restore | ✅ | 基本一致。 |
| 从 Idea 开始会话 | Expo prefill new-session | iOS NewSessionSheet linked idea | ✅ | 基本一致。 |
| 批量归档 | Expo ideas list 有 batch archive | iOS inspected surface 未见批量归档 | 🟦 | Expo 更强。 |
| 本地缓存 | Expo 更偏在线 fetch | iOS SwiftData IdeaStore/cache | 🟡 | iOS 离线/缓存更完整。 |

### 4.8 Actors / Members / Agents

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 成员/Agent 列表 | Expo actors tab | iOS members tab | ✅ | 命名不同，主功能一致。 |
| Actor detail | Expo 有 actor-detail，含近期会话/统计/isMe/invite/管理入口 | iOS AgentDetail 更丰富 | 🟡 | iOS 仍有更多 lifecycle/debug 展示。 |
| 移除 team member/agent | Expo owner/admin 可在 Actor detail 调 `remove_team_actor` | iOS ActorStore/Detail 支持 remove/delete | ✅ | 已补团队成员/Agent 移除入口。 |
| Re-invite existing actor | Expo Actor detail 可为现有 member/agent 创建 target_actor invite 并分享 | iOS detail 支持重新邀请 | ✅ | 成员 re-invite 仍受后端匿名账号规则约束。 |
| Agent authorized humans | Expo Actor detail 可查看、授权、撤销 agent authorized members | iOS 可管理 agent authorized members | ✅ | Expo 使用 `agent_member_access` 直接读写，owner-only 管理。 |
| Agent default workspace/type | Expo Actor detail 可更新 agent default workspace/type | iOS 支持 agent defaults | ✅ | 新建会话/添加 Agent 已读取这些 defaults。 |
| Agent workspaces via daemon RPC | Expo Actor detail 已通过目标 daemon add/remove workspace；全局 Workspaces 页仍偏 Supabase CRUD | iOS Agent workspace 使用 daemon RPC add/remove/list | 🟡 | Fetch/list 与全局 Workspaces 语义仍需统一。 |
| 个人 Agent 分享到团队 | Expo Actor detail 可对 owner 的 Agent 执行 share to team / make personal | iOS Settings connected agents 支持 share to team | ✅ | 已复用 `share_agent_to_team` / `make_agent_personal` RPC。 |
| Actor metrics | Expo 统计来自 Supabase 聚合 | iOS detail 存在部分 deterministic placeholder metrics | 🟡 | iOS 某些展示需要去 placeholder 或接真实数据。 |

### 4.9 Search

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 搜索 sessions | Expo 搜索 Supabase sessions 并可跳转详情 | iOS 搜索本地 sessions 并可跳转 | ✅ | 两端一致，数据源不同。 |
| 搜索 ideas | Expo 搜索并跳转 idea detail | iOS 搜索 ideas；导航深度需产品验收 | 🟡 | Expo 跳转更直接。 |
| 搜索 actors/members | Expo 搜索并跳转 actor detail | iOS 搜索 members | ✅ | 基本一致。 |
| 搜索 runtime output/worktree | 未明确覆盖 | iOS SearchViewModel 会扫 runtime prompt/output/worktree | 🟡 | iOS 搜索范围更深。 |

### 4.10 Shortcuts

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 会话页快捷入口 drawer | Expo ShortcutsDrawer | iOS ShortcutsDrawer | ✅ | 基本一致。 |
| WebView 打开 shortcut | Expo ShortcutWebScreen | iOS ShortcutWebView | ✅ | 基本一致。 |
| 快捷入口管理页 | Expo 有 shortcuts route，支持 folders/leaves、rename/delete 等 | iOS drawer 侧更偏入口展示/设置 | 🟦 | Expo 管理更强。 |
| 本地缓存 | Expo 数据源偏 Supabase/route state | iOS CachedShortcut/SwiftData | 🟡 | iOS 缓存更完整。 |

### 4.11 Settings / Profile / Teams / Workspaces

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| 编辑 profile/avatar | Expo edit-profile route，上传 Supabase avatars | iOS Settings edit profile + PhotosPicker | ✅ | 基本一致。 |
| Sign out | Expo settings | iOS Settings | ✅ | 一致。 |
| Notification preferences | Expo notifications route | iOS NotificationsSettingsView | ✅ | push 注册差异另见 Push。 |
| Team details | Expo teams route | iOS Settings team section | ✅ | Expo 更可操作。 |
| Rename/leave team | Expo 支持 owner/admin rename 和 leave inactive team | iOS 未见同等团队管理 screen | 🟦 | Expo 更强。 |
| Active team switch | Expo teams 页面提示仍是 follow-up | iOS invite/bootstrap 会偏好 team，但未见手动 team switch | 🔴 | 两端都需要明确产品策略。 |
| Workspace CRUD | Expo 全局 CRUD/归档/绑定 agent | iOS more daemon-bound management | 🟡 | Expo UI 强，但可能没有同步 daemon 实际状态。 |

### 4.12 Notifications / Push / Presence

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| Push preference UI | Expo 有 enabled/DND/event toggles | iOS 有 enabled/DND | ✅ | Expo event toggles 当前有本地语义。 |
| Push token 注册 | Expo 已通过 `expo-notifications` 获取 iOS native APNs token 并上传 `device_push_tokens`；Android FCM 暂跳过 | APNs 注册 + token uploader | 🟡 | Expo iOS/APNs parity 已补；Android FCM 需要 schema/FC dispatcher 支持。 |
| 通知 tap 跳转会话 | Expo 已处理 notification response 与 cold start，跳到 session route | iOS 有 TODO，当前仅 log session id | 🟦 | Expo tap 路由更完整；iOS 仍需收尾。 |
| Session mute | Expo 有 session-mutes | iOS detail 有 mute preferences | ✅ | 基本一致。 |
| Presence / connected agents | Expo layout 订阅 team-scoped MQTT，并写 `client_presence` foreground lease | iOS Push/Presence/MQTT 结合 native 生命周期 | ✅ | 基本一致；Expo presence 用 AppState 驱动。 |

### 4.13 本地持久化 / 离线能力

| 功能 | Expo | iOS | 状态 | Goal 备注 |
| --- | --- | --- | --- | --- |
| Outbox 离线重试 | SQLite outbox | SwiftData outbox | ✅ | 两端都有。 |
| 会话/消息缓存 | Expo 有 detail/session cache 与在线拉取，持久化范围较轻 | SwiftData 持久化 session/message/runtime/idea/actor/workspace 等 | 🟡 | iOS 明显更强。 |
| Schema migration | Expo SQLite migration 覆盖 outbox/connected_agents/agent types | SwiftData versioned schema 更完整 | 🟡 | Expo 如要离线体验需扩展。 |
| Draft/prefs | Expo AsyncStorage 保存 drafts/pins/preferences | iOS 多数进 SwiftData/系统偏好 | ✅ | 两端都有，但机制不同。 |

## 5. Expo 落后 iOS 的优先级清单

### P0：影响“真实可用”的断点

1. **Runtime-backed 新建会话（已实现 2026-05-22）**
   - `AgentConfigSheet` 已替换为真实 workspace 数据。
   - 新建会话 runtime start 计划已携带 workspace、agent type、device target。
   - 创建会话后已调用与 iOS 等价的 runtime start / daemon spawn 链路。
   - 验收：从 Expo 创建带 Agent 的会话后，Agent 能在目标 workspace 实际启动并回消息。

2. **Expo 添加 Agent 后启动 runtime（已实现 2026-05-22）**
   - `session-members` 添加 Agent 后不再只改 participants。
   - 已复用新建会话的 runtime start 逻辑。
   - 验收：已存在会话中添加 Agent 后，Agent runtime 状态可见并可参与对话。

3. **Permission grant/deny 真实送达（已实现 2026-05-22）**
   - Expo permission banner 已构造 `RuntimeCommandEnvelope`。
   - Allow/deny 会发布到 `amux/{team}/device/{device}/runtime/{runtime}/commands`。
   - 验收：用户在 Expo 点允许后，桌面端不再需要重复处理同一个 tool permission。

4. **Push 注册与通知路由（Expo iOS/APNs 已实现 2026-05-22）**
   - Expo 已接入 `expo-notifications`，ready 后获取 iOS native APNs token 并上传。
   - Expo 已处理 notification tap 与 cold start response，落到正确 session。
   - Expo 已写 foreground presence lease，供 FC fan-out 跳过前台设备。
   - 剩余：Android FCM 需要 Supabase provider/schema 与 FC dispatcher 支持；iOS 当前 tap TODO 仍需改为实际导航。

### P1：功能完整度与管理能力

1. **Expo Apple/Google 登录与匿名升级 parity（已实现 2026-05-22）**
   - 登录页 Apple/Google 入口已接 Supabase OAuth + Expo WebBrowser。
   - OAuth callback 支持 code flow 和 implicit token flow。
   - 匿名升级页已支持 Apple/Google `linkIdentity`，保留当前匿名用户已有 workspace/team/session 数据。
   - 配置要求：Supabase Auth redirect allowlist 需包含 `teamclaw://auth/callback` 以及 Expo dev callback。

2. **Expo Agent 管理 parity（部分实现 2026-05-22）**
   - remove actor 已实现：owner/admin 可在 Actor detail 调 `remove_team_actor`，并阻止 self-removal。
   - authorized members 已实现：owner 可查看、授权、撤销 agent authorized humans。
   - agent default workspace/type 已实现：Actor detail 可调用 `update_agent_defaults`。
   - re-invite 已实现：Actor detail 可为现有 member/agent 创建 target actor invite。
   - personal agent share to team 已实现：owner 可在 Actor detail 切换 team/personal visibility。
   - agent workspaces via daemon RPC 已实现：Actor detail 可通过目标 daemon add/remove workspace。

3. **Workspace 语义统一**
   - 当前 Expo 偏 Supabase CRUD，iOS 偏 daemon RPC。
   - 需要定义“工作区记录”和“Agent 实际可访问 workspace”的一致性模型。

4. **Team switch 策略**
   - Expo Teams 页面已经提示 active team switch 是 follow-up。
   - iOS 也未见显式 team switch UI。
   - 需要决定是否支持多团队主动切换，以及缓存/订阅如何切。

### P2：体验与维护性补齐

1. **Expo 扩展本地缓存模型**
   - 如目标是接近 iOS 离线能力，需要持久化 sessions/messages/ideas/actors/workspaces，而不是只依赖在线 fetch。

2. **iOS 补 Expo 已有的批量/管理操作**
   - 会话批量归档、已读/未读。
   - Ideas 批量归档。
   - Teams 管理。
   - 消息 edit/delete/reply/share（若产品确认需要）。

3. **清理 iOS placeholder 指标**
   - Agent detail 中部分 metrics/tool usage 是 deterministic placeholder。
   - 要么接真实数据，要么降低展示层级，避免被 Goal 当成已完成能力。

## 6. Expo 独有或更强的能力

| 能力 | 说明 |
| --- | --- |
| 会话批量操作 | 批量 archive、mark read/unread、unread tab badge。 |
| Teams 管理 | team 列表、rename、leave inactive team；但 active switch 未完成。 |
| 全局 Workspaces 管理 | 创建/编辑/归档/恢复/绑定 agent；需要补 daemon 语义。 |
| 消息操作 | edit/delete/reply/share 在 Expo 会话详情中更明显。 |
| Shortcuts 管理页 | 不只是 drawer，还包含独立管理 screen。 |
| Ideas 批量归档 | Expo list 层面更强。 |

## 7. iOS 独有或更强的能力

| 能力 | 说明 |
| --- | --- |
| Runtime/daemon 操作 | Agent workspace add/remove RPC 已补；iOS 仍有更多 lifecycle/diagnostic surfaces。 |
| Push 基建 | APNs 注册、token 上传、前台处理；iOS tap 导航仍需收尾，Android FCM 后端派发仍需补。 |
| Apple/Google auth | 两端都有真实登录链路；Expo 使用 Supabase OAuth + WebBrowser，iOS 使用 native handler / Supabase auth。 |
| Agent 管理 | authorized members、defaults、workspaces、re-invite、remove、share personal agent。 |
| SwiftData 缓存 | sessions/messages/actors/ideas/runtime/workspaces/shortcuts/outbox 等模型更完整。 |
| Streaming/turn detail | ChatTimelineReducer、StreamingDetailView、completed turn 展示更深。 |

## 8. 建议拆给 Goal 的任务包

### Goal 1：Expo runtime-backed session creation parity（已实现）

**目标**：Expo 新建会话达到 iOS NewSessionSheet 的真实运行能力。

**验收**：
- AgentConfigSheet 展示真实 workspace 和 agent type。
- 新建会话 payload 写入所选 workspace/type/device。
- 创建成功后 runtime 被启动。
- 会话详情能看到 runtime 状态和 Agent 回复。

### Goal 2：Expo add-agent runtime parity（已实现）

**目标**：在已有会话添加 Agent 后，Agent 不只是 participant，而是实际启动并加入会话。

**验收**：
- session-members 添加 Agent 后调用 runtime start。
- 失败时有可恢复错误提示。
- 成功后 runtime bar / participants / message stream 状态一致。

### Goal 3：Mobile permission response parity（已实现）

**目标**：Expo 端允许/拒绝 tool permission 能真正解锁或拒绝 daemon tool call。

**验收**：
- permission event id 可被 Expo 精确识别。
- allow/deny 写回后端或 daemon。
- 桌面端/其他客户端看到状态同步变化。

### Goal 4：Push registration and notification routing（Expo iOS/APNs 已实现）

**目标**：Expo 和 iOS 都能从 push 点击进入对应会话。

**验收**：
- Expo 注册并上传 iOS APNs token。
- Expo 处理通知点击和冷启动 session deep link。
- Expo 前台 presence 生效，FC fan-out 不重复推当前前台设备。
- iOS 当前 tap TODO 改为实际导航。
- session mute 和 DND 生效。
- Android FCM token/schema/dispatcher 另开后端任务补齐。

### Goal 5：Auth parity（已实现）

**目标**：Expo 补齐 Apple/Google 登录和匿名升级策略。

**验收**：
- choose-auth/auth screen 不再展示 Coming soon。
- Apple/Google 成功后能完成 team bootstrap。
- 匿名用户升级后本地 session/team/workspace 状态不丢。

### Goal 6：Agent/admin management parity（进行中）

**目标**：Expo Actor detail 达到 iOS Agent detail 的管理深度。

**验收**：
- remove actor：已实现 owner/admin 在 Expo Actor detail 移除非自己的 actor。
- authorized humans 管理：已实现 owner 查看、授权、撤销。
- agent defaults 管理：已实现 default workspace / default type 更新。
- re-invite：已实现现有 member/agent target invite 创建、复制和分享。
- 个人 Agent 分享到团队：已实现 owner 切换 team/personal visibility。
- workspaces 通过 daemon RPC 生效：已实现 add/remove workspace RPC。

## 9. 主要源码参考

### Expo

- `apps/expo/app/_layout.tsx`
- `apps/expo/app/(app)/_layout.tsx`
- `apps/expo/app/(app)/(tabs)/_layout.tsx`
- `apps/expo/app/(app)/(tabs)/sessions/index.tsx`
- `apps/expo/app/(app)/(tabs)/sessions/[sessionId].tsx`
- `apps/expo/app/(app)/new-session.tsx`
- `apps/expo/app/(app)/session-members.tsx`
- `apps/expo/app/(app)/actor-detail.tsx`
- `apps/expo/src/features/actors/actor-management.ts`
- `apps/expo/src/features/actors/actor-api.ts`
- `apps/expo/src/features/actors/agent-access-api.ts`
- `apps/expo/app/(app)/(tabs)/ideas.tsx`
- `apps/expo/app/(app)/idea-detail.tsx`
- `apps/expo/app/(app)/(tabs)/search.tsx`
- `apps/expo/app/(app)/settings.tsx`
- `apps/expo/app/(app)/notifications.tsx`
- `apps/expo/src/features/notifications/push-registration.ts`
- `apps/expo/src/features/notifications/notification-routing.ts`
- `apps/expo/src/features/notifications/presence-api.ts`
- `apps/expo/src/features/notifications/presence-heartbeat.ts`
- `apps/expo/app/(app)/teams.tsx`
- `apps/expo/app/(app)/workspaces.tsx`
- `apps/expo/src/lib/teamclaw/runtime-rpc.ts`
- `apps/expo/app/(app)/shortcuts.tsx`
- `apps/expo/app/(app)/shortcut-web.tsx`
- `apps/expo/src/features/sessions/screens/SessionsListScreen.tsx`
- `apps/expo/src/features/sessions/screens/SessionDetailScreen.tsx`
- `apps/expo/src/features/sessions/screens/NewSessionScreen.tsx`
- `apps/expo/src/features/sessions/components/AgentConfigSheet.tsx`
- `apps/expo/src/features/shortcuts/ShortcutsDrawer.tsx`
- `apps/expo/src/features/search/screens/SearchScreen.tsx`
- `apps/expo/src/features/settings/screens/SettingsScreen.tsx`
- `apps/expo/src/features/onboarding/onboarding-oauth.ts`

### iOS

- `apps/ios/AMUXApp/ContentView.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Root/RootTabView.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Root/SessionsTab.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/SessionList/NewSessionSheet.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/AgentDetail/SessionDetailView.swift`
- `apps/ios/Packages/AMUXCore/Sources/AMUXCore/ViewModels/SessionDetailViewModel.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Members/MemberListContent.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Settings/SettingsView.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Settings/NotificationsSettingsView.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Workspace/WorkspaceManagementView.swift`
- `apps/ios/Packages/AMUXUI/Sources/AMUXUI/Shortcuts/ShortcutWebView.swift`
