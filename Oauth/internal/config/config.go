package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type DBConfig struct {
	Driver string `json:"driver"` // "sqlite3" or "mysql"
	DSN    string `json:"dsn"`
}

type RedisConfig struct {
	Enabled  bool   `json:"enabled"`
	Addr     string `json:"addr"`
	Password string `json:"password,omitempty"`
	DB       int    `json:"db"`
}

type SystemConfig struct {
	Initialized bool        `json:"initialized"`
	IssuerURL   string      `json:"issuer_url"`
	Database    DBConfig    `json:"database"`
	Redis       RedisConfig `json:"redis"`
}

type Manager struct {
	mu       sync.RWMutex
	filePath string
	current  SystemConfig
}

func NewManager(dataDir string) *Manager {
	m := &Manager{
		filePath: filepath.Join(dataDir, "config.json"),
		current: SystemConfig{
			Initialized: false,
			IssuerURL:   "http://localhost:8080",
			Database: DBConfig{
				Driver: "sqlite3",
				DSN:    filepath.Join(dataDir, "wimotek_oauth.db"),
			},
		},
	}
	_ = m.load()
	return m
}

func (m *Manager) load() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	raw, err := os.ReadFile(m.filePath)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, &m.current)
}

func (m *Manager) Get() SystemConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.current
}

// CompleteSetup atomically persists configuration and locks the setup wizard permanently.
func (m *Manager) CompleteSetup(cfg SystemConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.current.Initialized {
		return errors.New("system is already initialized and locked")
	}

	cfg.Initialized = true
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	tmpPath := m.filePath + ".tmp"
	if err := os.WriteFile(tmpPath, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, m.filePath); err != nil {
		return err
	}
	m.current = cfg
	return nil
}
