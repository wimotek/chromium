package nginx

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	domainRegex = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$`)
	listenRegex = regexp.MustCompile(`(?m)^\s*listen\s+([^;]+);`)
)

type SiteInfo struct {
	Domain       string   `json:"domain"`
	Enabled      bool     `json:"enabled"`
	HasSSL       bool     `json:"has_ssl"`
	Mode         string   `json:"mode"`
	GzipStatic   bool     `json:"gzip_static"`
	BrotliStatic bool     `json:"brotli_static"`
	ListenPorts  []string `json:"listen_ports"`
	SizeBytes    int64    `json:"size_bytes"`
	UpdatedAt    string   `json:"updated_at"`
}

type Manager struct {
	mu           sync.Mutex
	configDir    string
	mainConfPath string
	exec         *Executor
}

func NewManager(dir, mainConfPath string, exec *Executor) *Manager {
	_ = os.MkdirAll(dir, 0755)
	return &Manager{
		configDir:    filepath.Clean(dir),
		mainConfPath: filepath.Clean(mainConfPath),
		exec:         exec,
	}
}

func ValidateDomain(domain string) error {
	d := strings.TrimSpace(domain)
	if d == "" || len(d) > 253 || !domainRegex.MatchString(d) {
		return errors.New("域名格式非法，仅允许标准域名字符 (如 app.example.com)")
	}
	return nil
}

func (m *Manager) safeSitePath(domain string, enabled bool) (string, error) {
	if err := ValidateDomain(domain); err != nil {
		return "", err
	}
	ext := ".conf"
	if !enabled {
		ext = ".conf.disabled"
	}
	target := filepath.Clean(filepath.Join(m.configDir, domain+ext))
	prefix := m.configDir + string(os.PathSeparator)
	if !strings.HasPrefix(target, prefix) {
		return "", errors.New("路径越权，操作已拦截")
	}
	return target, nil
}

// ListSites 获取所有托管站点及结构化元数据（兼容 .conf 启用态与 .conf.disabled 停用态）
func (m *Manager) ListSites() ([]SiteInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	files, err := os.ReadDir(m.configDir)
	if err != nil {
		return nil, err
	}

	sites := make([]SiteInfo, 0, len(files))
	for _, f := range files {
		if f.IsDir() {
			continue
		}
		name := f.Name()
		var domain string
		var enabled bool
		switch {
		case strings.HasSuffix(name, ".conf"):
			domain = strings.TrimSuffix(name, ".conf")
			enabled = true
		case strings.HasSuffix(name, ".conf.disabled"):
			domain = strings.TrimSuffix(name, ".conf.disabled")
			enabled = false
		default:
			continue
		}

		fullPath := filepath.Join(m.configDir, name)
		data, readErr := os.ReadFile(fullPath)
		if readErr != nil {
			continue
		}
		fi, _ := f.Info()
		meta := ParseSiteMeta(domain, enabled, string(data))
		if fi != nil {
			meta.SizeBytes = fi.Size()
			meta.UpdatedAt = fi.ModTime().Format(time.RFC3339)
		}
		sites = append(sites, meta)
	}

	sort.Slice(sites, func(i, j int) bool {
		return sites[i].Domain < sites[j].Domain
	})
	return sites, nil
}

// ParseSiteMeta 从原生 Nginx 配置文件中提取关键运行特征
func ParseSiteMeta(domain string, enabled bool, content string) SiteInfo {
	lower := strings.ToLower(content)
	mode := "custom"
	switch {
	case strings.Contains(lower, "fastcgi_pass"):
		mode = "php"
	case strings.Contains(lower, "proxy_pass"):
		mode = "proxy"
	case strings.Contains(lower, "try_files") || strings.Contains(lower, "root "):
		mode = "static"
	}

	hasSSL := strings.Contains(lower, "ssl_certificate") || strings.Contains(lower, "443 ssl")
	gzipStatic := strings.Contains(lower, "gzip_static on") || strings.Contains(lower, "gzip_static always")
	brotliStatic := strings.Contains(lower, "brotli_static on") || strings.Contains(lower, "brotli_static always")

	portSet := make(map[string]struct{})
	var ports []string
	for _, match := range listenRegex.FindAllStringSubmatch(content, -1) {
		if len(match) < 2 {
			continue
		}
		fields := strings.Fields(match[1])
		if len(fields) == 0 {
			continue
		}
		port := fields[0]
		if _, ok := portSet[port]; !ok {
			portSet[port] = struct{}{}
			ports = append(ports, port)
		}
	}

	return SiteInfo{
		Domain:       domain,
		Enabled:      enabled,
		HasSSL:       hasSSL,
		Mode:         mode,
		GzipStatic:   gzipStatic,
		BrotliStatic: brotliStatic,
		ListenPorts:  ports,
	}
}

// ReadSite 读取单个站点配置（自动兼容启用与停用文件）
func (m *Manager) ReadSite(domain string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	activePath, err := m.safeSitePath(domain, true)
	if err != nil {
		return "", false, err
	}
	if data, err := os.ReadFile(activePath); err == nil {
		return string(data), true, nil
	}

	disabledPath, err := m.safeSitePath(domain, false)
	if err != nil {
		return "", false, err
	}
	data, err := os.ReadFile(disabledPath)
	if err != nil {
		return "", false, fmt.Errorf("站点配置不存在: %s", domain)
	}
	return string(data), false, nil
}

// TestSiteContent 干跑校验：在互斥锁保护下临时落盘校验 nginx -t，无论成功失败均立即回滚原状态
func (m *Manager) TestSiteContent(domain, content string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	target, err := m.safeSitePath(domain, true)
	if err != nil {
		return "", err
	}

	prevBytes, prevErr := os.ReadFile(target)
	existed := prevErr == nil

	if err := atomicWriteFile(target, []byte(content), 0644); err != nil {
		return "", err
	}

	testOut, testErr := m.exec.TestConfig()

	// 严格回滚到测试前状态
	if existed {
		_ = atomicWriteFile(target, prevBytes, 0644)
	} else {
		_ = os.Remove(target)
	}

	return testOut, testErr
}

// SaveSite 真正的事务级原子写入：备份旧配置 -> 原子替换目标 .conf -> 执行 nginx -t -> 失败自动回滚
func (m *Manager) SaveSite(domain, content string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	target, err := m.safeSitePath(domain, true)
	if err != nil {
		return "", err
	}
	disabledPath, _ := m.safeSitePath(domain, false)

	// 如果该站点当前处于停用态，写入停用文件前依然用真实 .conf 校验语法
	wasDisabled := false
	if _, err := os.Stat(target); os.IsNotExist(err) {
		if _, dErr := os.Stat(disabledPath); dErr == nil {
			wasDisabled = true
		}
	}

	prevBytes, prevErr := os.ReadFile(target)
	existed := prevErr == nil

	if err := atomicWriteFile(target, []byte(content), 0644); err != nil {
		return "", err
	}

	testOut, testErr := m.exec.TestConfig()
	if testErr != nil {
		// 校验失败，立即回滚原文件或删除新文件，绝不污染线上配置
		if existed {
			_ = atomicWriteFile(target, prevBytes, 0644)
		} else {
			_ = os.Remove(target)
		}
		return testOut, testErr
	}

	// 若站点原本为停用状态，保存并清除旧的 .disabled 副本使其启用
	if wasDisabled {
		_ = os.Remove(disabledPath)
	}

	return testOut, nil
}

// ToggleSite 启用或停用指定站点（.conf <-> .conf.disabled），并做 nginx -t 回滚保护
func (m *Manager) ToggleSite(domain string, enable bool) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	activePath, err := m.safeSitePath(domain, true)
	if err != nil {
		return "", err
	}
	disabledPath, err := m.safeSitePath(domain, false)
	if err != nil {
		return "", err
	}

	var src, dst string
	if enable {
		src, dst = disabledPath, activePath
	} else {
		src, dst = activePath, disabledPath
	}

	if _, err := os.Stat(src); os.IsNotExist(err) {
		if _, dstErr := os.Stat(dst); dstErr == nil {
			return "站点已处于目标状态", nil
		}
		return "", fmt.Errorf("站点不存在: %s", domain)
	}

	if err := os.Rename(src, dst); err != nil {
		return "", err
	}

	testOut, testErr := m.exec.TestConfig()
	if testErr != nil {
		_ = os.Rename(dst, src)
		return testOut, testErr
	}
	return testOut, nil
}

// DeleteSite 删除站点配置（同时清理启用或停用文件）
func (m *Manager) DeleteSite(domain string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	activePath, err := m.safeSitePath(domain, true)
	if err != nil {
		return err
	}
	disabledPath, err := m.safeSitePath(domain, false)
	if err != nil {
		return err
	}

	removed := false
	if err := os.Remove(activePath); err == nil {
		removed = true
	}
	if err := os.Remove(disabledPath); err == nil {
		removed = true
	}
	if !removed {
		return fmt.Errorf("站点配置不存在: %s", domain)
	}
	return nil
}

// ReadMainConfig 读取主配置文件 /etc/nginx/nginx.conf
func (m *Manager) ReadMainConfig() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	data, err := os.ReadFile(m.mainConfPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// SaveMainConfig 事务级更新主配置文件 /etc/nginx/nginx.conf（带 nginx -t 自动回滚）
func (m *Manager) SaveMainConfig(content string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	prevBytes, err := os.ReadFile(m.mainConfPath)
	if err != nil {
		return "", err
	}

	if err := atomicWriteFile(m.mainConfPath, []byte(content), 0644); err != nil {
		return "", err
	}

	testOut, testErr := m.exec.TestConfig()
	if testErr != nil {
		_ = atomicWriteFile(m.mainConfPath, prevBytes, 0644)
		return testOut, testErr
	}
	return testOut, nil
}

func atomicWriteFile(target string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(target)
	tmpFile, err := os.CreateTemp(dir, ".nginx-atomic-*")
	if err != nil {
		return err
	}
	tmpName := tmpFile.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Chmod(perm); err != nil {
		_ = tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, target); err != nil {
		return err
	}
	cleanup = false
	return nil
}