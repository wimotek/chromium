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
	return &AcmeManager{
		sslDir:  sslDir,
		webRoot: webRoot,
	}
}

// IssueCert 标准 HTTP-01 验证（无需 API 凭据，需公网 80 端口）
func (a *AcmeManager) IssueCert(domain string) error {
	if !domainRegex.MatchString(domain) {
		return fmt.Errorf("非法域名格式: %s", domain)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "acme.sh", "--issue",
		"-d", domain,
		"-w", a.webRoot,
		"--server", "letsencrypt",
	)

	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("HTTP-01 验证失败: %s", string(out))
	}

	return a.installCert(domain)
}

// IssueCertDNS DNS-01 验证（支持通配符 *.domain.com 及无 80 端口/内网环境）
// provider: "dns_cf", "dns_ali", "dns_dp" 等
// envParams: 动态注入厂商所需的 API Key/Secret/Token
func (a *AcmeManager) IssueCertDNS(mainDomain string, isWildcard bool, provider string, envParams map[string]string) error {
	if !domainRegex.MatchString(mainDomain) {
		return fmt.Errorf("非法根域名格式: %s", mainDomain)
	}

	// DNS 解析与全球传播需要较长时间，超时放宽至 300 秒
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()

	args := []string{
		"--issue",
		"--server", "letsencrypt",
		"--dns", provider,
		"-d", mainDomain,
	}

	// 如果勾选申请泛域名，同时签发主域名和通配符域名
	if isWildcard {
		args = append(args, "-d", "*."+mainDomain)
	}

	cmd := exec.CommandContext(ctx, "acme.sh", args...)

	// 安全环境变量注入（杜绝命令注入）
	cmdEnv := os.Environ()
	for k, v := range envParams {
		cmdEnv = append(cmdEnv, fmt.Sprintf("%s=%s", k, v))
	}
	cmd.Env = cmdEnv

	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("DNS-01 验证失败: %s", string(out))
	}

	return a.installCert(mainDomain)
}

// 统一安装部署证书到 Nginx 只读 SSL 目录，并平滑热重载 Nginx
func (a *AcmeManager) installCert(domain string) error {
	certPath := fmt.Sprintf("%s/%s.crt", a.sslDir, domain)
	keyPath := fmt.Sprintf("%s/%s.key", a.sslDir, domain)

	installCmd := exec.Command("acme.sh", "--install-cert",
		"-d", domain,
		"--key-file", keyPath,
		"--fullchain-file", certPath,
		"--reloadcmd", "nginx -s reload",
	)

	if out, err := installCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("证书安装部署失败: %s", string(out))
	}

	return nil
}