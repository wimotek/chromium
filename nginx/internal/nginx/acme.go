package nginx

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type CertInfo struct {
	Domain        string   `json:"domain"`
	Issuer        string   `json:"issuer"`
	SANs          []string `json:"sans"`
	NotBefore     string   `json:"not_before"`
	NotAfter      string   `json:"not_after"`
	DaysRemaining int      `json:"days_remaining"`
	Status        string   `json:"status"` // "valid", "expiring", "expired"
	CertPath      string   `json:"cert_path"`
	KeyPath       string   `json:"key_path"`
}

// 严格白名单：允许的 DNS 验证插件与对应的环境变量密钥名，彻底阻断环境变量注入
var allowedDNSProviderEnvKeys = map[string]map[string]bool{
	"dns_cf": {
		"CF_Token":      true,
		"CF_Account_ID": true,
		"CF_Zone_ID":    true,
	},
	"dns_ali": {
		"Ali_Key":    true,
		"Ali_Secret": true,
	},
	"dns_dp": {
		"DP_Id":  true,
		"DP_Key": true,
	},
	"dns_aws": {
		"AWS_ACCESS_KEY_ID":     true,
		"AWS_SECRET_ACCESS_KEY": true,
	},
	"dns_gd": {
		"GD_Key":    true,
		"GD_Secret": true,
	},
	"dns_hetzner": {
		"HETZNER_Token": true,
	},
}

var allowedCAServers = map[string]bool{
	"letsencrypt": true,
	"zerossl":     true,
}

type AcmeManager struct {
	sslDir         string
	webRoot        string
	acmeScriptHome string
	acmeConfigHome string
	nginxBin       string
}

func NewAcmeManager(sslDir, webRoot, acmeScriptHome, acmeConfigHome, nginxBin string) *AcmeManager {
	if sslDir == "" {
		sslDir = "/data/ssl"
	}
	if webRoot == "" {
		webRoot = "/data/www/acme"
	}
	if acmeScriptHome == "" {
		acmeScriptHome = "/opt/acme.sh"
	}
	if acmeConfigHome == "" {
		acmeConfigHome = "/data/acme"
	}
	if nginxBin == "" {
		nginxBin = "nginx"
	}
	_ = os.MkdirAll(sslDir, 0755)
	_ = os.MkdirAll(webRoot, 0755)
	_ = os.MkdirAll(acmeConfigHome, 0755)
	return &AcmeManager{
		sslDir:         filepath.Clean(sslDir),
		webRoot:        filepath.Clean(webRoot),
		acmeScriptHome: filepath.Clean(acmeScriptHome),
		acmeConfigHome: filepath.Clean(acmeConfigHome),
		nginxBin:       nginxBin,
	}
}

func normalizeCAServer(ca string) string {
	ca = strings.ToLower(strings.TrimSpace(ca))
	if allowedCAServers[ca] {
		return ca
	}
	return "letsencrypt"
}

// StartAutoRenew 内置 Go 定时续签调度器（无需容器内额外运行 crond）
func (a *AcmeManager) StartAutoRenew(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 12 * time.Hour
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			log.Printf("[ACME] 执行周期性证书续签检查...")
			renewCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
			cmd := exec.CommandContext(renewCtx, "acme.sh", "--cron", "--home", a.acmeScriptHome, "--config-home", a.acmeConfigHome)
			out, err := cmd.CombinedOutput()
			cancel()
			if err != nil {
				log.Printf("[ACME] 自动续签检查返回异常: %v | %s", err, strings.TrimSpace(string(out)))
			} else {
				log.Printf("[ACME] 自动续签检查完成")
			}
		}
	}
}

// ListCerts 扫描 SSL 目录并解析真实 X.509 证书元数据
func (a *AcmeManager) ListCerts() ([]CertInfo, error) {
	files, err := os.ReadDir(a.sslDir)
	if err != nil {
		return nil, err
	}

	certs := make([]CertInfo, 0)
	now := time.Now()
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".crt") {
			continue
		}
		domain := strings.TrimSuffix(f.Name(), ".crt")
		certPath := filepath.Join(a.sslDir, f.Name())
		keyPath := filepath.Join(a.sslDir, domain+".key")

		raw, err := os.ReadFile(certPath)
		if err != nil {
			continue
		}
		block, _ := pem.Decode(raw)
		if block == nil {
			continue
		}
		parsed, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}

		days := int(math.Floor(parsed.NotAfter.Sub(now).Hours() / 24))
		status := "valid"
		if days <= 0 {
			status = "expired"
		} else if days <= 21 {
			status = "expiring"
		}

		issuer := parsed.Issuer.CommonName
		if issuer == "" && len(parsed.Issuer.Organization) > 0 {
			issuer = parsed.Issuer.Organization[0]
		}
		sans := parsed.DNSNames
		if len(sans) == 0 && parsed.Subject.CommonName != "" {
			sans = []string{parsed.Subject.CommonName}
		}

		certs = append(certs, CertInfo{
			Domain:        domain,
			Issuer:        issuer,
			SANs:          sans,
			NotBefore:     parsed.NotBefore.Format(time.RFC3339),
			NotAfter:      parsed.NotAfter.Format(time.RFC3339),
			DaysRemaining: days,
			Status:        status,
			CertPath:      certPath,
			KeyPath:       keyPath,
		})
	}

	sort.Slice(certs, func(i, j int) bool {
		return certs[i].Domain < certs[j].Domain
	})
	return certs, nil
}

// IssueCert 标准 HTTP-01 验证（需公网 80 端口，支持 Let's Encrypt / ZeroSSL）
func (a *AcmeManager) IssueCert(domain, caServer string) error {
	if err := ValidateDomain(domain); err != nil {
		return err
	}
	ca := normalizeCAServer(caServer)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "acme.sh",
		"--home", a.acmeScriptHome,
		"--config-home", a.acmeConfigHome,
		"--issue",
		"-d", domain,
		"-w", a.webRoot,
		"--server", ca,
	)

	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("HTTP-01 验证失败: %s", strings.TrimSpace(string(out)))
	}

	return a.installCert(domain)
}

// IssueCertDNS DNS-01 验证（支持泛域名 *.domain.com，严格白名单过滤厂商与凭据键名）
func (a *AcmeManager) IssueCertDNS(mainDomain string, isWildcard bool, provider, caServer string, envParams map[string]string) error {
	if err := ValidateDomain(mainDomain); err != nil {
		return err
	}
	allowedKeys, ok := allowedDNSProviderEnvKeys[provider]
	if !ok {
		return fmt.Errorf("不支持的 DNS 托管商: %s", provider)
	}
	ca := normalizeCAServer(caServer)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()

	args := []string{
		"--home", a.acmeScriptHome,
		"--config-home", a.acmeConfigHome,
		"--issue",
		"--server", ca,
		"--dns", provider,
		"-d", mainDomain,
	}
	if isWildcard {
		args = append(args, "-d", "*."+mainDomain)
	}

	cmd := exec.CommandContext(ctx, "acme.sh", args...)
	cmdEnv := os.Environ()
	for k, v := range envParams {
		if !allowedKeys[k] {
			return fmt.Errorf("不允许的 DNS 凭据参数: %s", k)
		}
		if strings.ContainsAny(v, "\r\n\x00") {
			return fmt.Errorf("凭据参数包含非法字符: %s", k)
		}
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			cmdEnv = append(cmdEnv, fmt.Sprintf("%s=%s", k, trimmed))
		}
	}
	cmd.Env = cmdEnv

	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("DNS-01 验证失败: %s", strings.TrimSpace(string(out)))
	}

	return a.installCert(mainDomain)
}

// installCert 统一部署证书到 SSL 目录并触发热重载
func (a *AcmeManager) installCert(domain string) error {
	certPath := filepath.Join(a.sslDir, domain+".crt")
	keyPath := filepath.Join(a.sslDir, domain+".key")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	installCmd := exec.CommandContext(ctx, "acme.sh",
		"--home", a.acmeScriptHome,
		"--config-home", a.acmeConfigHome,
		"--install-cert",
		"-d", domain,
		"--key-file", keyPath,
		"--fullchain-file", certPath,
		"--reloadcmd", a.nginxBin+" -s reload",
	)

	if out, err := installCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("证书安装部署失败: %s", strings.TrimSpace(string(out)))
	}
	return nil
}