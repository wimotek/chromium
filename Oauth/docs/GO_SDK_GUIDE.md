# wimotek/Oauth Go SDK 零基础接入指南（Go Module 自动下载 + 离线单文件）

这份文档面向 **Go 初学者**：从零开始新建一个 Go 项目，通过 `go get` 自动下载 SDK（或无网络环境下单文件拷贝），10 分钟内跑通完整的 OAuth 2.0 + OIDC (PKCE S256) 登录流程。

---

## 一、先搞懂两个概念（30 秒）

1. **什么是 Go Module (`go.mod`)？**  
   就像前端的 `package.json` 或 Python 的 `requirements.txt`。只要项目目录里有一个 `go.mod` 文件，Go 工具链就能自动从 GitHub/代理服务器把依赖包下载到本地缓存，并记录版本号。
2. **`&wimotekoauth.Client{...}` 里的 `wimotekoauth` 从哪来？**  
   它是我们 SDK 文件 `client.go` 第一行声明的包名：`package wimotekoauth`。只要在你的 `main.go` 顶部 `import` 了这个包，就能直接使用 `wimotekoauth.Client`。
3. **本 SDK 为什么很轻量？**  
   `Oauth/sdk/go/client.go` 只有约 90 行代码，**只使用 Go 标准库**（零第三方依赖），并且单独提供了独立的 `Oauth/sdk/go/go.mod`，执行 `go get` 时**不会**把后端服务的 MySQL / Redis / SQLite 依赖一起拖下来。

---

## 二、前置准备：在 wimotek/Oauth 控制台创建应用

1. 登录你的 `wimotek/Oauth` 管理控制台，进入 **「应用与客户端 (Applications)」**。
2. 点击 **「新建应用」**：
   - **应用名称**：`我的 Go 测试站点`
   - **回调地址 (Redirect URI)**：填入 `http://localhost:4000/callback`（**必须和代码里完全一字不差**）
3. 创建完成后，记下这三个信息：
   - **Issuer 地址**：例如 `https://auth.your-domain.com` 或 `http://localhost:8080`
   - **Client ID**：例如 `wimotek_erp_portal`
   - **Client Secret**：点击复制并妥善保存（不要写死提交到 Git 仓库）

---

## 三、方式 A：用 `go get` 自动下载模块（推荐 · 有公网或内网 Git 仓库）

### 第 1 步：创建新项目并初始化 `go.mod`

打开终端（Windows 可用 PowerShell / Git Bash，macOS/Linux 用终端）：

```bash
mkdir my-go-app
cd my-go-app
go mod init my-go-app
```

> 执行完后会生成一个 `go.mod` 文件，内容类似：
> ```
> module my-go-app
> go 1.23
> ```

### 第 2 步：自动下载 `wimotek/Oauth` Go SDK

- **如果你在国内网络环境**，建议先配置一次 Go 国内模块镜像加速（配置一次永久生效）：

```bash
go env -w GOPROXY=https://goproxy.cn,direct
```

- **执行自动下载**：

```bash
# 当 Oauth/ 目录作为 GitHub 仓库根目录发布时（模块路径为 github.com/wimotek/oauth/sdk/go）：
go get github.com/wimotek/oauth/sdk/go@latest
```

> **提示：如果你把代码推到了自己的 GitHub / Gitee / 内网 GitLab 仓库怎么办？**
> - **如果是自己的公开仓库**（且 `sdk/go/go.mod` 在 `Oauth/sdk/go/` 子目录里）：  
>   将 `Oauth/sdk/go/go.mod` 的第一行改成你自己的仓库地址，例如 `module github.com/你的用户名/仓库名/Oauth/sdk/go`，推到 Git 并打一个版本标签（`git tag Oauth/sdk/go/v1.0.0 && git push --tags`），之后任何人执行 `go get github.com/你的用户名/仓库名/Oauth/sdk/go@v1.0.0` 即可自动下载。
> - **如果是公司内网/私有 Git 仓库**：  
>   先告诉 Go 跳过公网代理直接走 Git 拉取：
>   ```bash
>   go env -w GOPRIVATE=git.your-company.com,github.com/your-org/*
>   ```
> - **如果你还没发布 Git 仓库，或者想 10 秒钟零配置跑通**：直接看下方 **「方式 B：单文件直接复制」**，完全不需要网络！

### 第 3 步：创建可直接运行的 `main.go`

在 `my-go-app/` 目录下新建 `main.go` 并粘贴以下完整代码（**无需额外框架，不缺任何函数，复制即可运行**）：

```go
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	// 方式 A（go get 自动下载）用下面这行：
	wimotekoauth "github.com/wimotek/oauth/sdk/go"
	// 方式 B（离线单文件拷贝到 pkg/wimotekoauth/client.go）改成下面这行：
	// wimotekoauth "my-go-app/pkg/wimotekoauth"
)

var oauthClient = &wimotekoauth.Client{
	Issuer:       "http://localhost:8080",          // 替换成你的 wimotek/Oauth 访问地址
	ClientID:     "wimotek_erp_portal",             // 替换成控制台里的 Client ID
	ClientSecret: os.Getenv("OAUTH_SECRET"),        // 从环境变量读取 Client Secret
	RedirectURI:  "http://localhost:4000/callback", // 必须与控制台配置的回调地址完全一致
}

func main() {
	// 首页：显示登录按钮
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<h1>我的 Go 业务系统</h1><p><a href="/login">使用 wimotek/Oauth 登录</a></p>`)
	})

	// 第 1 步：生成带 PKCE (S256) 的授权地址，把 state 和 verifier 存入 HttpOnly Cookie 后跳转
	http.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		loginURL, state, verifier := oauthClient.BuildLoginURL()
		http.SetCookie(w, &http.Cookie{
			Name:     "oauth_state",
			Value:    state,
			Path:     "/",
			HttpOnly: true,
			MaxAge:   300, // 5 分钟有效
		})
		http.SetCookie(w, &http.Cookie{
			Name:     "oauth_verifier",
			Value:    verifier,
			Path:     "/",
			HttpOnly: true,
			MaxAge:   300,
		})
		http.Redirect(w, r, loginURL, http.StatusFound)
	})

	// 第 2 步：接收 wimotek/Oauth 回调，校验 state + PKCE 并换取用户信息
	http.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		stateCookie, err1 := r.Cookie("oauth_state")
		verifierCookie, err2 := r.Cookie("oauth_verifier")
		if err1 != nil || err2 != nil {
			http.Error(w, "缺少登录会话 Cookie，请重新访问 /login", http.StatusBadRequest)
			return
		}

		res, err := oauthClient.HandleCallback(
			r.Context(),
			r.URL.Query().Get("code"),
			r.URL.Query().Get("state"),
			stateCookie.Value,
			verifierCookie.Value,
		)
		if err != nil {
			http.Error(w, "OAuth 登录失败: "+err.Error(), http.StatusUnauthorized)
			return
		}

		// 登录完成后清理临时 Cookie
		http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: "", Path: "/", MaxAge: -1})
		http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: "", Path: "/", MaxAge: -1})

		// 这里可以把用户信息写入你自己的 Session / JWT
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "登录成功！\n姓名: %v\n邮箱: %v\n用户唯一 ID (sub): %v\n",
			res.User["name"], res.User["email"], res.User["sub"])
	})

	log.Println("业务系统已启动：http://localhost:4000")
	log.Fatal(http.ListenAndServe(":4000", nil))
}
```

### 第 4 步：设置环境变量并启动

- **macOS / Linux**：
  ```bash
  export OAUTH_SECRET="你复制的_client_secret"
  go mod tidy
  go run main.go
  ```
- **Windows (PowerShell)**：
  ```powershell
  $env:OAUTH_SECRET="你复制的_client_secret"
  go mod tidy
  go run main.go
  ```

打开浏览器访问 `http://localhost:4000`，点击 **「使用 wimotek/Oauth 登录」**，授权完成后即可看到你的姓名、邮箱和 `sub`！

---

## 四、方式 B：零依赖单文件直接复制（内网 / 离线 / 无需发布 Git 仓库）

如果你的开发环境无法访问 GitHub，或者你不想折腾 `go get` 和私有仓库权限，因为我们的 SDK **只有 1 个文件、0 个第三方依赖**，直接复制进项目即可：

1. 在你的项目目录中创建文件夹 `pkg/wimotekoauth/`：
   ```text
   my-go-app/
   ├── go.mod                   # module my-go-app
   ├── main.go                  # 上方的完整业务代码
   └── pkg/
       └── wimotekoauth/
           └── client.go        # 从 Oauth/sdk/go/client.go 或控制台「接入文档 -> Go -> 展开完整源码」复制
   ```
2. 把 `main.go` 里的 import 改成你自己的模块路径：
   ```go
   import (
       wimotekoauth "my-go-app/pkg/wimotekoauth"
   )
   ```
3. 直接运行 `go run main.go` —— **全程不需要联网下载任何依赖！**

---

## 五、常见问题排查（小白必看）

| 报错现象 | 常见原因 | 解决办法 |
| :--- | :--- | :--- |
| `invalid_request: Invalid client_id or redirect_uri` | 代码里的 `RedirectURI` 和控制台填写的不一致（例如多了一个末尾 `/` 或端口不同） | 检查 `http://localhost:4000/callback` 是否两边一字不差 |
| `go get` 卡住或提示 `i/o timeout` | 国内直连 `proxy.golang.org` 被阻断 | 执行 `go env -w GOPROXY=https://goproxy.cn,direct` 后重试，或直接改用 **方式 B 单文件复制** |
| `invalid OAuth state` | 跨域名（如 `127.0.0.1` 和 `localhost` 混用）导致浏览器没带回 `oauth_state` Cookie | 确保访问地址和 `RedirectURI` 统一使用 `localhost`（或统一用正式域名） |
| `401` 或 `user` 为空 | `OAUTH_SECRET` 环境变量未设置，导致 `ClientSecret` 为空 | 运行前确认 `echo $OAUTH_SECRET` 有值，与控制台中的 Client Secret 一致 |
| 生产环境 HTTPS 部署 | Cookie 未开启 `Secure` 标记 | 上线 HTTPS 后，在 `http.Cookie` 中加上 `Secure: true, SameSite: http.SameSiteLaxMode` |
