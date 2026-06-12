# 白标资产(编译期)

每个品牌一张方形源图,放在 `branding/<brand>/logo.png`(建议 1024×1024 PNG)。

在对应的构建配置里指向它:

```jsonc
// build.config.<brand>.json
{
  "app": {
    "name": "Acme",
    "shortName": "acme",
    "logo": "branding/acme/logo.png"
  }
}
```

构建前 `scripts/update-tauri-config.js`(在 `tauri:dev`/`tauri:build` 前自动运行)会:

1. 用 `app.name` 写入 `apps/desktop/tauri.conf.json` 的 `productName` 与窗口标题;
   Rust 侧窗口标题/托盘/OAuth 回调页文案也跟随该名(回落 `TeamClaw`)。
2. 用 `app.logo` 跑 `tauri icon` 生成 `apps/desktop/icons/` 整套 OS 图标
   (32/128/128@2x/.icns/.ico),并把 128px 拷成 `packages/app/public/logo.png`
   与 `logo-64.png`(登录页 / 关于页展示)。

## 用法

```bash
BUILD_ENV=acme pnpm tauri:build      # 出 Acme 品牌包
BUILD_ENV=acme pnpm tauri:dev        # 本地预览
```

## 注意

- **不填 `app.logo` 且 `name=TeamClaw` → 产物零差异**,沿用仓库内已提交的图标。
- 品牌构建会**就地覆盖**已提交的图标 / `public/logo*.png` / `tauri.conf.json`,
  工作区会变脏。CI/OEM 流程应 checkout → 应用品牌 → 构建 → 丢弃改动。
- 纯前端 `pnpm dev`(不经 Tauri)不会触发图标生成,显示的是当前已提交的 logo。
