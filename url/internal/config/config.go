package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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
	Enabled       bool   `json:"enabled"`
	AutoRedirect  bool   `json:"auto_redirect"`
	IssuerURL     string `json:"issuer_url"`
	ClientID      string `json:"client_id"`
	ClientSecret  string `json:"client_secret,omitempty"`
	RedirectURI   string `json:"redirect_uri"`
	WebhookSecret string `json:"webhook_secret,omitempty"`
	AppName       string `json:"app_name"`
}

type TurnstileConfig struct {
	Enabled   bool   `json:"enabled"`
	SiteKey   string `json:"site_key"`
	SecretKey string `json:"secret_key,omitempty"`
}

type AntiBotConfig struct {
	Mode               string `json:"mode"` // "builtin", "turnstile", "off"
	LoginMaxAttempts   int    `json:"login_max_attempts"`
	LoginWindowMinutes int    `json:"login_window_minutes"`
	RedirectRatePerMin int    `json:"redirect_rate_per_min"`
}

type InterstitialConfig struct {
	Preset            string `json:"preset"`
	CountdownSeconds  int    `json:"countdown_seconds"`
	BrandName         string `json:"brand_name"`
	Headline          string `json:"headline"`
	Subtitle          string `json:"subtitle"`
	CtaText           string `json:"cta_text"`
	SafetyTip         string `json:"safety_tip"`
	PrimaryColor      string `json:"primary_color"`
	ShowTargetUrl     bool   `json:"show_target_url"`
	ShowSecurityBadge bool   `json:"show_security_badge"`
	ShowWechatTip     bool   `json:"show_wechat_tip"`
	UseCustomHtml     bool   `json:"use_custom_html"`
	CustomHtml        string `json:"custom_html"`
}

type CronTaskConfig struct {
	Key             string `json:"key"`
	Name            string `json:"name"`
	CronExpression  string `json:"cron_expression"`
	RetentionPolicy string `json:"retention_policy"`
	Enabled         bool   `json:"enabled"`
}

type Config struct {
	Initialized          bool               `json:"initialized"`
	IssuerURL            string             `json:"issuer_url"`
	AdminPath            string             `json:"admin_path"`
	AllowRegistration    bool               `json:"allow_registration"`
	RootRedirectEnabled  bool               `json:"root_redirect_enabled"`
	RootRedirectURL      string             `json:"root_redirect_url"`
	TrustedDeviceDays    int                `json:"trusted_device_days"`
	AuditRetentionDays   int                `json:"audit_retention_days"`
	AuditMaxRows         int                `json:"audit_max_rows"`
	BackupRetentionCount int                `json:"backup_retention_count"`
	SessionSecret        string             `json:"session_secret"`
	SEOIndexNowKey       string             `json:"seo_indexnow_key"`
	Database             DatabaseConfig     `json:"database"`
	Redis                RedisConfig        `json:"redis"`
	OAuth                OAuthConfig        `json:"oauth"`
	Turnstile            TurnstileConfig    `json:"turnstile"`
	AntiBot              AntiBotConfig      `json:"anti_bot"`
	Interstitial         InterstitialConfig `json:"interstitial"`
	CronTasks            []CronTaskConfig   `json:"cron_tasks"`
}

func (c Config) IssuerHostname() string {
	u, err := url.Parse(c.IssuerURL)
	if err != nil || u.Hostname() == "" {
		return "localhost"
	}
	return u.Hostname()
}

func (c Config) EffectiveOAuthIssuer() string {
	if v := strings.TrimSpace(os.Getenv("OAUTH_ISSUER")); v != "" {
		return strings.TrimRight(v, "/")
	}
	if strings.TrimSpace(c.OAuth.IssuerURL) != "" {
		return strings.TrimRight(c.OAuth.IssuerURL, "/")
	}
	return "https://auth.wimotek.com"
}

func (c Config) EffectiveOAuthClientID() string {
	if v := strings.TrimSpace(os.Getenv("OAUTH_CLIENT_ID")); v != "" {
		return v
	}
	if strings.TrimSpace(c.OAuth.ClientID) != "" {
		return c.OAuth.ClientID
	}
	return "wimotek_c41ac24274c6"
}

func (c Config) EffectiveOAuthSecret() string {
	if v := strings.TrimSpace(os.Getenv("OAUTH_SECRET")); v != "" {
		return v
	}
	return strings.TrimSpace(c.OAuth.ClientSecret)
}

func (c Config) EffectiveOAuthRedirectURI() string {
	if v := strings.TrimSpace(os.Getenv("OAUTH_REDIRECT_URI")); v != "" {
		return v
	}
	if strings.TrimSpace(c.OAuth.RedirectURI) != "" {
		return strings.TrimSpace(c.OAuth.RedirectURI)
	}
	return "https://wimotek.com/auth/callback"
}

func (c Config) EffectiveWebhookSecret() string {
	if v := strings.TrimSpace(os.Getenv("OAUTH_WEBHOOK_SECRET")); v != "" {
		return v
	}
	return strings.TrimSpace(c.OAuth.WebhookSecret)
}

func (c Config) EffectiveTurnstileSiteKey() string {
	if v := strings.TrimSpace(os.Getenv("TURNSTILE_SITE_KEY")); v != "" {
		return v
	}
	return strings.TrimSpace(c.Turnstile.SiteKey)
}

func (c Config) EffectiveTurnstileSecretKey() string {
	if v := strings.TrimSpace(os.Getenv("TURNSTILE_SECRET_KEY")); v != "" {
		return v
	}
	return strings.TrimSpace(c.Turnstile.SecretKey)
}

// IsOAuthActive returns true only when OAuth is explicitly enabled AND has a valid secret + issuer + client_id.
// This guarantees first-run deployments never enter an OAuth redirect loop before credentials are configured.
func (c Config) IsOAuthActive() bool {
	return c.OAuth.Enabled &&
		c.EffectiveOAuthIssuer() != "" &&
		c.EffectiveOAuthClientID() != "" &&
		c.EffectiveOAuthSecret() != ""
}

func DefaultInterstitialConfig() InterstitialConfig {
	return InterstitialConfig{
		Preset:            "safety_gate",
		CountdownSeconds:  3,
		BrandName:         "wimotek/url",
		Headline:          "您即将离开当前站点，前往外部链接",
		Subtitle:          "请确认目标网站域名可信，谨防钓鱼与账号风险。",
		CtaText:           "继续前往目标网站",
		SafetyTip:         "安全提示：目标链接已通过协议校验，请勿在陌生页面输入敏感密码。",
		PrimaryColor:      "#2563EB",
		ShowTargetUrl:     true,
		ShowSecurityBadge: true,
		ShowWechatTip:     false,
		UseCustomHtml:     false,
		CustomHtml:        "",
	}
}

func DefaultCronTasks() []CronTaskConfig {
	return []CronTaskConfig{
		{
			Key:             "db_backup",
			Name:            "数据库一致性自动备份",
			CronExpression:  "0 3 * * *",
			RetentionPolicy: "保留最近 14 份备份快照",
			Enabled:         true,
		},
		{
			Key:             "audit_rotate",
			Name:            "审计日志滚动归档与清理",
			CronExpression:  "30 3 * * *",
			RetentionPolicy: "保留最近 30 天 JSONL 归档",
			Enabled:         true,
		},
		{
			Key:             "expired_cleanup",
			Name:            "过期短链停用与缓存清理",
			CronExpression:  "0 * * * *",
			RetentionPolicy: "每小时清理过期缓存键值",
			Enabled:         true,
		},
	}
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
	oauthSecret := strings.TrimSpace(os.Getenv("OAUTH_SECRET"))
	issuer := strings.TrimSpace(os.Getenv("OAUTH_ISSUER"))
	if issuer == "" {
		issuer = "https://auth.wimotek.com"
	}
	clientID := strings.TrimSpace(os.Getenv("OAUTH_CLIENT_ID"))
	if clientID == "" {
		clientID = "wimotek_c41ac24274c6"
	}
	redirectURI := strings.TrimSpace(os.Getenv("OAUTH_REDIRECT_URI"))
	if redirectURI == "" {
		redirectURI = "https://wimotek.com/auth/callback"
	}

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
			// Default disabled on first run unless OAUTH_SECRET env is explicitly configured.
			Enabled:      oauthSecret != "",
			AutoRedirect: true,
			IssuerURL:    issuer,
			ClientID:     clientID,
			RedirectURI:  redirectURI,
			AppName:      "Shorten Your URL",
		},
		AntiBot: AntiBotConfig{
			Mode:               "builtin",
			LoginMaxAttempts:   5,
			LoginWindowMinutes: 15,
			RedirectRatePerMin: 120,
		},
		Interstitial: DefaultInterstitialConfig(),
		CronTasks:    DefaultCronTasks(),
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

	cfg := DefaultConfig(dataDir)
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.SessionSecret == "" {
		cfg.SessionSecret = randomHex(32)
	}
	if cfg.AdminPath == "" {
		cfg.AdminPath = "/admin"
	}
	// Migrate legacy issuer URL if present from older deployments
	if strings.Contains(cfg.OAuth.IssuerURL, "ca.wimotek.com") || cfg.OAuth.IssuerURL == "" {
		cfg.OAuth.IssuerURL = "https://auth.wimotek.com"
	}
	if cfg.OAuth.ClientID == "" {
		cfg.OAuth.ClientID = "wimotek_c41ac24274c6"
	}
	if cfg.OAuth.RedirectURI == "" {
		cfg.OAuth.RedirectURI = "https://wimotek.com/auth/callback"
	}
	if cfg.AntiBot.Mode == "" {
		cfg.AntiBot.Mode = "builtin"
	}
	if cfg.AntiBot.LoginMaxAttempts <= 0 {
		cfg.AntiBot.LoginMaxAttempts = 5
	}
	if cfg.AntiBot.LoginWindowMinutes <= 0 {
		cfg.AntiBot.LoginWindowMinutes = 15
	}
	if cfg.AntiBot.RedirectRatePerMin <= 0 {
		cfg.AntiBot.RedirectRatePerMin = 120
	}
	if cfg.Interstitial.Preset == "" {
		cfg.Interstitial = DefaultInterstitialConfig()
	}
	if len(cfg.CronTasks) == 0 {
		cfg.CronTasks = DefaultCronTasks()
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
