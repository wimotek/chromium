package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"sync"
)

type DatabaseConfig struct {
	Driver string `json:"driver"` // "sqlite3" or "mysql"
	DSN    string `json:"dsn"`
}

type RedisConfig struct {
	Enabled  bool   `json:"enabled"`
	Addr     string `json:"addr"`
	Password string `json:"password,omitempty"`
	DB       int    `json:"db"`
}

type OAuthConfig struct {
	Enabled      bool   `json:"enabled"`
	IssuerURL    string `json:"issuer_url"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret,omitempty"`
	AppName      string `json:"app_name"`
}

type TurnstileConfig struct {
	Enabled   bool   `json:"enabled"`
	SiteKey   string `json:"site_key"`
	SecretKey string `json:"secret_key,omitempty"`
}

type Config struct {
	Initialized          bool            `json:"initialized"`
	IssuerURL            string          `json:"issuer_url"`
	AdminPath            string          `json:"admin_path"`
	AllowRegistration    bool            `json:"allow_registration"`
	RootRedirectEnabled  bool            `json:"root_redirect_enabled"`
	RootRedirectURL      string          `json:"root_redirect_url"`
	TrustedDeviceDays    int             `json:"trusted_device_days"`
	AuditRetentionDays   int             `json:"audit_retention_days"`
	AuditMaxRows         int             `json:"audit_max_rows"`
	BackupRetentionCount int             `json:"backup_retention_count"`
	SessionSecret        string          `json:"session_secret"`
	SEOIndexNowKey       string          `json:"seo_indexnow_key"`
	Database             DatabaseConfig  `json:"database"`
	Redis                RedisConfig     `json:"redis"`
	OAuth                OAuthConfig     `json:"oauth"`
	Turnstile            TurnstileConfig `json:"turnstile"`
}

func (c Config) IssuerHostname() string {
	u, err := url.Parse(c.IssuerURL)
	if err != nil || u.Hostname() == "" {
		return "localhost"
	}
	return u.Hostname()
}

type Manager struct {
	mu         sync.RWMutex
	configPath string
	lockPath   string
	current    Config
}

func NewManager(configPath, lockPath string) *Manager {
	return &Manager{
		configPath: configPath,
		lockPath:   lockPath,
	}
}

func DefaultConfig(dataDir string) Config {
	return Config{
		Initialized:          false,
		IssuerURL:            "https://u.wimotek.com",
		AdminPath:            "/admin",
		AllowRegistration:    false,
		RootRedirectEnabled:  false,
		RootRedirectURL:      "https://wimotek.com",
		TrustedDeviceDays:    14,
		AuditRetentionDays:   30,
		AuditMaxRows:         50000,
		BackupRetentionCount: 14,
		SessionSecret:        randomHex(32),
		SEOIndexNowKey:       randomHex(16),
		Database: DatabaseConfig{
			Driver: "sqlite3",
			DSN:    filepath.Join(dataDir, "wimotek_url.db"),
		},
		OAuth: OAuthConfig{
			Enabled:   true,
			IssuerURL: "http://ca.wimotek.com",
			ClientID:  "wimotek_c41ac24274c6",
			AppName:   "Shorten Your URL",
		},
	}
}

func (m *Manager) Load() (Config, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	dataDir := filepath.Dir(m.configPath)
	raw, err := os.ReadFile(m.configPath)
	if errors.Is(err, os.ErrNotExist) {
		m.current = DefaultConfig(dataDir)
		return m.current, nil
	}
	if err != nil {
		return Config{}, err
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.SessionSecret == "" {
		cfg.SessionSecret = randomHex(32)
	}
	if cfg.AdminPath == "" {
		cfg.AdminPath = "/admin"
	}
	if _, err := os.Stat(m.lockPath); err == nil {
		cfg.Initialized = true
	}
	m.current = cfg
	return m.current, nil
}

func (m *Manager) Get() Config {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.current
}

func (m *Manager) IsLocked() bool {
	_, err := os.Stat(m.lockPath)
	return err == nil
}

func (m *Manager) Save(cfg Config) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := m.configPath + ".tmp"
	if err := os.WriteFile(tmpPath, payload, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, m.configPath); err != nil {
		return err
	}
	m.current = cfg
	return nil
}

func (m *Manager) LockSetup() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := os.WriteFile(m.lockPath, []byte("locked\n"), 0o400); err != nil {
		return err
	}
	m.current.Initialized = true
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
