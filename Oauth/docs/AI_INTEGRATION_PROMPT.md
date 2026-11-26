# 多站点样式适配与 AI 提示词集成指南

当多个不同风格的业务网站（如企业 ERP、极简文档站、暗黑开发者工具、电商商城）共用同一个 `wimotek/Oauth` 认证中心时，`wimotek/Oauth` 通过 **按应用 (`client_id`) 独立绑定登录主题** 实现「一套网关、千站千面」：

1. **按 `client_id` 自动切换样式**：当业务站跳转至 `/oauth/authorize?client_id=xxx` 或打开托管登录页 `?client_id=xxx` 时，网关自动读取该应用专属的排版布局、配色、圆角、字体、Logo、品牌文案与作用域 CSS。
2. **三种适配方式**：
   - **可视化在线编辑**：在管理控制台 **「托管登录页调试 -> 样式与排版编辑器」** 中直接挑选预设、调色、切换左右分栏 / 居中卡片 / 极简风格并实时预览保存。
   - **REST Theme API（自动化 / AI 同步）**：通过 `PUT /api/applications/{clientId}/theme` 接口直接以 JSON 推送样式，无需人工手点配置。
   - **AI 一键集成与风格同步**：把下方提示词直接发给 Cursor / Windsurf / Claude / Gemini / Copilot，让 AI 扫描你的业务站样式并自动生成调用命令与 OIDC 接入代码。

---

## 一、Theme REST API 参考

### 1. 读取指定应用的公开主题（无需鉴权）
```bash
curl "https://auth.your-domain.com/api/public/theme?client_id=wimotek_erp_portal"
```

### 2. 更新指定应用的登录页主题（需管理员 Bearer Token）
```bash
curl -X PUT "https://auth.your-domain.com/api/applications/wimotek_erp_portal/theme" \
  -H "Authorization: Bearer <ADMIN_SESSION_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "layout": "split_left",
    "surfaceMode": "light",
    "brandTitle": "Acme ERP",
    "brandSubtitle": "使用企业账号安全登录",
    "heroTitle": "统一企业身份认证中心",
    "heroSubtitle": "支持 Passkey、邮箱免密 OTP 与主流社会化登录。",
    "logoUrl": "https://erp.your-domain.com/logo.svg",
    "primaryColor": "#059669",
    "backgroundColor": "#ECFDF5",
    "cardColor": "#FFFFFF",
    "textColor": "#064E3B",
    "borderRadius": "rounded",
    "fontFamily": "sans",
    "socialLayout": "stack",
    "footerText": "Acme Corp",
    "customCss": "[data-wimotek-login-card] { box-shadow: 0 20px 50px rgba(0,0,0,0.08); }"
  }'
```

### 3. 支持的字段说明

| 字段 | 可选值 / 格式 | 说明 |
| :--- | :--- | :--- |
| `layout` | `centered` \| `split_left` \| `split_right` \| `minimal` | 居中卡片 / 左侧品牌分栏 / 右侧品牌分栏 / 极简无框 |
| `surfaceMode` | `auto` \| `light` \| `dark` | 跟随系统 / 强制浅色 / 强制深色 |
| `brandTitle` | 字符串（≤80 字符） | 登录卡片品牌标题 |
| `brandSubtitle` | 字符串（≤160 字符，可空） | 副标题（留空则自动使用多语言默认文案） |
| `heroTitle` / `heroSubtitle` | 字符串 | `split_left` / `split_right` 模式下品牌展示区文案 |
| `logoUrl` | `https://...` 或 `/...` | 自定义站点 Logo（留空显示默认图标，自动拦截 `javascript:` 等不安全协议） |
| `primaryColor` | `#RRGGBB` | 主按钮与品牌强调色 |
| `backgroundColor` | `#RRGGBB` | 登录画布背景色 |
| `cardColor` | `#RRGGBB` | 登录卡片底色 |
| `textColor` | `#RRGGBB` | 主文字颜色 |
| `borderRadius` | `sharp` \| `rounded` \| `pill` | 直角 / 现代圆角 / 胶囊圆角 |
| `fontFamily` | `sans` \| `serif` \| `mono` | 无衬线 / 衬线 / 等宽开发者字体 |
| `socialLayout` | `stack` \| `grid` | 社会化按钮单列堆叠 / 双列网格 |
| `footerText` | 字符串 | 登录卡片底部版权文字 |
| `customCss` | CSS（≤4000 字符） | 作用域 CSS 微调（自动过滤 `@import` / `javascript:` / `expression()`），推荐使用 `[data-wimotek-login-root]` 和 `[data-wimotek-login-card]` |

---

## 二、直接发给 AI 的提示词模板

你也可以直接在控制台 **「托管登录页调试 -> AI 提示词 & Theme API」** 一键复制已自动代入当前 `Issuer` 与 `client_id` 的完整提示词。

### 提示词 A：让 AI 按业务站风格自动同步登录页样式
> 分析我当前网站项目的视觉设计系统（Tailwind 配置、CSS 变量、主色、背景色、圆角、字体与 Logo），按照 `wimotek/Oauth` 的 Theme JSON Schema（`layout`、`surfaceMode`、`primaryColor`、`backgroundColor`、`cardColor`、`textColor`、`borderRadius`、`fontFamily`、`logoUrl`、`brandTitle`、`customCss`），生成最匹配的主题 JSON，并输出调用 `PUT <ISSUER>/api/applications/<CLIENT_ID>/theme` 的 `curl` 同步脚本。

### 提示词 B：让 AI 一键完成 OIDC 登录集成开发
> 为我当前项目集成 `wimotek/Oauth`（标准 OIDC 1.0 + PKCE S256），Discovery 地址为 `<ISSUER>/.well-known/openid-configuration`，Client ID 为 `<CLIENT_ID>`，Client Secret 从环境变量 `OAUTH_SECRET` 读取，回调地址为 `<REDIRECT_URI>`。实现 `/login`（生成 state 与 PKCE verifier 存入 HttpOnly Cookie 并跳转 `/oauth/authorize`）、`/callback`（校验 state、换取 Token 并调用 `/oauth/userinfo`）和 `/logout`，并按 `sub` 与已验证 `email` 绑定本地用户。
