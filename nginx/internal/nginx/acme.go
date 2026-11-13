package nginx

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"time"
)

type AcmeManager struct {
	sslDir  string
	webRoot string
}

func NewAcmeManager() *AcmeManager {
	sslDir := "/etc/nginx/ssl"
	webRoot := "/var/www/acme"
	os.MkdirAll(sslDir, 0755)
	os.MkdirAll(webRoot, 0755)
	return &AcmeManager{sslDir: sslDir, webRoot: webRoot}
}

// IssueCert 通过 HTTP-01 验证零接触签发证书
func (a *AcmeManager) IssueCert(domain string) error {
	if !domainRegex.MatchString(domain) {
		return fmt.Errorf("非法域名格式")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// 1. 调用内置 acme.sh 执行 HTTP-01 申请
	cmd := exec.CommandContext(ctx, "acme.sh", "--issue",
		"-d", domain,
		"-w", a.webRoot,
		"--server", "letsencrypt",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ACME 验证失败: %s", string(out))
	}

	// 2. 安装证书到 Nginx 专属只读 SSL 目录，并触发 Nginx 热重载
	certPath := fmt.Sprintf("%s/%s.crt", a.sslDir, domain)
	keyPath := fmt.Sprintf("%s/%s.key", a.sslDir, domain)

	installCmd := exec.Command("acme.sh", "--install-cert",
		"-d", domain,
		"--key-file", keyPath,
		"--fullchain-file", certPath,
		"--reloadcmd", "nginx -s reload",
	)
	if out, err := installCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("证书部署失败: %s", string(out))
	}

	return nil
}