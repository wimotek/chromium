package nginx

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var domainRegex = regexp.MustCompile(`^[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,}$`)

type Manager struct {
	configDir string
	exec      *Executor
}

func NewManager(dir string, exec *Executor) *Manager {
	os.MkdirAll(dir, 0755)
	return &Manager{configDir: dir, exec: exec}
}

// ListSites 获取所有站点
func (m *Manager) ListSites() ([]string, error) {
	files, err := os.ReadDir(m.configDir)
	if err != nil {
		return nil, err
	}
	var sites []string
	for _, f := range files {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".conf") {
			sites = append(sites, strings.TrimSuffix(f.Name(), ".conf"))
		}
	}
	return sites, nil
}

// ReadSite 读取单个配置
func (m *Manager) ReadSite(domain string) (string, error) {
	if !domainRegex.MatchString(domain) {
		return "", errors.New("域名格式非法")
	}
	data, err := os.ReadFile(filepath.Join(m.configDir, domain+".conf"))
	return string(data), err
}

// SaveSite 原子写入与先验机制：临时文件 -> 语法检查 -> 原子重命名
func (m *Manager) SaveSite(domain, content string) error {
	if !domainRegex.MatchString(domain) {
		return errors.New("域名格式非法，存在越权风险")
	}

	target := filepath.Join(m.configDir, domain+".conf")
	tmp := target + ".tmp"

	if err := os.WriteFile(tmp, []byte(content), 0644); err != nil {
		return err
	}
	defer os.Remove(tmp)

	// 先行语法校验
	if err := m.exec.TestConfig(); err != nil {
		return err
	}

	return os.Rename(tmp, target)
}

// DeleteSite 删除配置
func (m *Manager) DeleteSite(domain string) error {
	if !domainRegex.MatchString(domain) {
		return errors.New("域名格式非法")
	}
	return os.Remove(filepath.Join(m.configDir, domain+".conf"))
}