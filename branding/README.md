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

## 品牌主题配色(可选,仅亮色)

在 `branding/<brand>/theme.json` 手写一份要覆盖的配色 token,并把对应
`build.config.<brand>.json` 的 `app.palette` 设成品牌文件夹名:

```jsonc
// branding/acme/theme.json — 只写要覆盖的 token,其余继承默认主题
{
  "tokens": {
    "--primary": "#0f6e62",
    "--system-accent": "#16998a",
    "--coral": "#16998a",
    "--background": "#f2f0ea",
    "--foreground": "#20242a"
  }
}
```

```jsonc
// build.config.acme.json
{ "app": { "name": "Acme", "shortName": "acme",
           "logo": "branding/acme/logo.png", "palette": "acme" } }
```

构建时 `vite.config.ts` 会生成 `:root[data-palette="acme"]{…}` 注入 `index.html`,
靠特异性压过 `.dark`(因此**仅亮色**,和内置 `teal` 一致)。

- **合法 token** = `packages/app/src/styles/globals.css` 顶层 `:root{}` 里声明的
  那些 `--xxx`;写了不存在的 token 名会**直接构建失败**(防打字静默失效)。
- 不填 `theme.json`(或 `palette` 为 `default`/`teal`)→ 不生成,产物零差异。
- token 值不得包含 `;`、`{`、`}`、`<`(防破坏 / 注入 CSS),否则构建失败。
