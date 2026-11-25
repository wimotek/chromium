package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Context represents one CA server connection profile (aligned with `step context`).
type Context struct {
	Name               string `json:"name"`
	CAURL              string `json:"ca_url"`
	Fingerprint        string `json:"fingerprint"`
	RootCertPath       string `json:"root_cert_path"`
	Token              string `json:"token,omitempty"`
	TokenMasked        string `json:"token_masked,omitempty"`
	InsecureSkipVerify bool   `json:"insecure_skip_verify,omitempty"`
	UpdatedAt          int64  `json:"updated_at"`
}

// ManagedCert tracks a certificate stored on disk for inspection and automated renewal.
type ManagedCert struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Context       string   `json:"context"`
	Profile       string   `json:"profile"`
	CommonName    string   `json:"common_name"`
	SANs          []string `json:"sans"`
	UPN           string   `json:"upn,omitempty"`
	Email         string   `json:"email,omitempty"`
	KeyType       string   `json:"key_type"`
	CertPath      string   `json:"cert_path"`
	KeyPath       string   `json:"key_path"`
	SerialHex     string   `json:"serial_hex"`
	NotBefore     int64    `json:"not_before"`
	NotAfter      int64    `json:"not_after"`
	RenewBefore   string   `json:"renew_before"` // e.g. "33%" or "168h" or "15d"
	AutoRenew     bool     `json:"auto_renew"`
	ReloadCommand string   `json:"reload_command,omitempty"`
	Status        string   `json:"status"` // active | revoked | error
	LastRenewedAt int64    `json:"last_renewed_at"`
	LastError     string   `json:"last_error,omitempty"`
	CreatedAt     int64    `json:"created_at"`
}

// State is persisted at <BaseDir>/state.json with strict 0600 permissions.
type State struct {
	CurrentContext string                 `json:"current_context"`
	Contexts       map[string]Context     `json:"contexts"`
	ManagedCerts   []ManagedCert          `json:"managed_certs"`
	AutoRenewMin   int                    `json:"auto_renew_interval_min"`
}

// Manager manages ~/.wimotek contexts, root CA trust files, and local managed certificates.
type Manager struct {
	BaseDir  string
	CertsDir string
}

// Open initializes the client config manager at baseDir (defaults to $WIMOTEK_PATH or ~/.wimotek).
func Open(baseDir string) (*Manager, error) {
	dir := strings.TrimSpace(baseDir)
	if dir == "" {
		dir = strings.TrimSpace(os.Getenv("WIMOTEK_PATH"))
	}
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve home directory: %w", err)
		}
		dir = filepath.Join(home, ".wimotek")
	}
	absBase, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	certsDir := filepath.Join(absBase, "certs")
	for _, sub := range []string{absBase, filepath.Join(absBase, "contexts"), certsDir} {
		if err := os.MkdirAll(sub, 0o700); err != nil {
			return nil, fmt.Errorf("create config directory %s: %w", sub, err)
		}
	}
	return &Manager{BaseDir: absBase, CertsDir: certsDir}, nil
}

func (m *Manager) statePath() string {
	return filepath.Join(m.BaseDir, "state.json")
}

// Load reads state.json, returning an initialized empty State if it does not exist yet.
func (m *Manager) Load() (*State, error) {
	st := &State{
		Contexts:     map[string]Context{},
		ManagedCerts: []ManagedCert{},
		AutoRenewMin: 30,
	}
	raw, err := os.ReadFile(m.statePath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return st, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(raw, st); err != nil {
		return nil, fmt.Errorf("parse state.json: %w", err)
	}
	if st.Contexts == nil {
		st.Contexts = map[string]Context{}
	}
	if st.ManagedCerts == nil {
		st.ManagedCerts = []ManagedCert{}
	}
	if st.AutoRenewMin <= 0 {
		st.AutoRenewMin = 30
	}
	return st, nil
}

// Save atomically persists state.json with 0600 permissions.
func (m *Manager) Save(st *State) error {
	if st.Contexts == nil {
		st.Contexts = map[string]Context{}
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := m.statePath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.statePath())
}

// ContextRootPath returns the root_ca.crt path for a named context.
func (m *Manager) ContextRootPath(name string) (string, error) {
	safe, err := SanitizeName(name)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(m.BaseDir, "contexts", safe)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(dir, "root_ca.crt"), nil
}

// SaveContext creates or updates a named CA context and writes its Root CA PEM to disk.
func (m *Manager) SaveContext(ctxRec Context, rootPEM []byte, setCurrent bool) (*Context, error) {
	safeName, err := SanitizeName(ctxRec.Name)
	if err != nil {
		return nil, err
	}
	ctxRec.Name = safeName
	ctxRec.CAURL = strings.TrimRight(strings.TrimSpace(ctxRec.CAURL), "/")
	if ctxRec.CAURL == "" {
		return nil, errors.New("ca_url is required")
	}

	rootPath, err := m.ContextRootPath(safeName)
	if err != nil {
		return nil, err
	}
	if len(rootPEM) > 0 {
		if err := os.WriteFile(rootPath, rootPEM, 0o644); err != nil {
			return nil, fmt.Errorf("write root_ca.crt: %w", err)
		}
	}
	ctxRec.RootCertPath = rootPath
	ctxRec.UpdatedAt = time.Now().Unix()

	st, err := m.Load()
	if err != nil {
		return nil, err
	}
	// Preserve existing token if omitted during update
	if ctxRec.Token == "" {
		if prev, ok := st.Contexts[safeName]; ok {
			ctxRec.Token = prev.Token
		}
	}
	ctxRec.TokenMasked = MaskSecret(ctxRec.Token)
	st.Contexts[safeName] = ctxRec
	if setCurrent || st.CurrentContext == "" {
		st.CurrentContext = safeName
	}
	if err := m.Save(st); err != nil {
		return nil, err
	}
	// Also write step-compatible defaults.json under ~/.wimotek/config/defaults.json for active context
	if st.CurrentContext == safeName {
		_ = m.writeStepDefaults(ctxRec)
	}
	return &ctxRec, nil
}

func (m *Manager) writeStepDefaults(c Context) error {
	cfgDir := filepath.Join(m.BaseDir, "config")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		return err
	}
	payload, _ := json.MarshalIndent(map[string]string{
		"ca-url":      c.CAURL,
		"fingerprint": c.Fingerprint,
		"root":        c.RootCertPath,
	}, "", "  ")
	return os.WriteFile(filepath.Join(cfgDir, "defaults.json"), payload, 0o600)
}

// GetContext retrieves a named context or the current active context when name is empty.
func (m *Manager) GetContext(name string) (*Context, error) {
	st, err := m.Load()
	if err != nil {
		return nil, err
	}
	target := strings.TrimSpace(name)
	if target == "" {
		target = st.CurrentContext
	}
	if target == "" {
		return nil, errors.New("no CA context configured; run 'wimotek-cli ca bootstrap' first")
	}
	rec, ok := st.Contexts[target]
	if !ok {
		return nil, fmt.Errorf("context %q not found", target)
	}
	rec.TokenMasked = MaskSecret(rec.Token)
	return &rec, nil
}

// ListContexts returns all contexts sorted by name, with raw tokens redacted when redactTokens is true.
func (m *Manager) ListContexts(redactTokens bool) (string, []Context, error) {
	st, err := m.Load()
	if err != nil {
		return "", nil, err
	}
	out := make([]Context, 0, len(st.Contexts))
	for _, c := range st.Contexts {
		c.TokenMasked = MaskSecret(c.Token)
		if redactTokens {
			c.Token = ""
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return st.CurrentContext, out, nil
}

// SelectContext sets the active context.
func (m *Manager) SelectContext(name string) (*Context, error) {
	st, err := m.Load()
	if err != nil {
		return nil, err
	}
	c, ok := st.Contexts[name]
	if !ok {
		return nil, fmt.Errorf("context %q not found", name)
	}
	st.CurrentContext = name
	if err := m.Save(st); err != nil {
		return nil, err
	}
	_ = m.writeStepDefaults(c)
	return &c, nil
}

// RemoveContext deletes a saved context.
func (m *Manager) RemoveContext(name string) error {
	st, err := m.Load()
	if err != nil {
		return err
	}
	if _, ok := st.Contexts[name]; !ok {
		return fmt.Errorf("context %q not found", name)
	}
	delete(st.Contexts, name)
	if st.CurrentContext == name {
		st.CurrentContext = ""
		for k := range st.Contexts {
			st.CurrentContext = k
			break
		}
	}
	return m.Save(st)
}

// ResolveConfinedCertPath ensures any web-requested file path remains strictly inside CertsDir.
func (m *Manager) ResolveConfinedCertPath(relName string) (string, error) {
	clean := filepath.Clean(strings.TrimSpace(relName))
	if clean == "" || clean == "." || strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		return "", errors.New("filename must be a safe relative path inside the managed certs directory")
	}
	full := filepath.Join(m.CertsDir, clean)
	absFull, err := filepath.Abs(full)
	if err != nil {
		return "", err
	}
	absBase, err := filepath.Abs(m.CertsDir)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(absFull, absBase+string(os.PathSeparator)) {
		return "", errors.New("path escapes managed certs directory")
	}
	if err := os.MkdirAll(filepath.Dir(absFull), 0o700); err != nil {
		return "", err
	}
	return absFull, nil
}

// UpsertManagedCert saves or updates a managed local certificate entry.
func (m *Manager) UpsertManagedCert(rec ManagedCert) (*ManagedCert, error) {
	st, err := m.Load()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	if rec.ID == "" {
		rec.ID = RandomID(8)
	}
	if rec.CreatedAt == 0 {
		rec.CreatedAt = now
	}
	if rec.RenewBefore == "" {
		rec.RenewBefore = "33%"
	}
	if rec.Status == "" {
		rec.Status = "active"
	}
	updated := false
	for i := range st.ManagedCerts {
		if st.ManagedCerts[i].ID == rec.ID {
			st.ManagedCerts[i] = rec
			updated = true
			break
		}
	}
	if !updated {
		st.ManagedCerts = append([]ManagedCert{rec}, st.ManagedCerts...)
	}
	if err := m.Save(st); err != nil {
		return nil, err
	}
	return &rec, nil
}

// DeleteManagedCert removes a managed certificate entry from tracking (does not delete files unless requested).
func (m *Manager) DeleteManagedCert(id string) error {
	st, err := m.Load()
	if err != nil {
		return err
	}
	filtered := make([]ManagedCert, 0, len(st.ManagedCerts))
	for _, c := range st.ManagedCerts {
		if c.ID != id {
			filtered = append(filtered, c)
		}
	}
	st.ManagedCerts = filtered
	return m.Save(st)
}

// SanitizeName validates a context or file slug (alphanumeric, -, _).
func SanitizeName(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "default", nil
	}
	if len(s) > 64 {
		return "", errors.New("name must be <= 64 characters")
	}
	for _, r := range s {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.'
		if !ok {
			return "", fmt.Errorf("invalid character %q in name %q", r, s)
		}
	}
	if strings.Contains(s, "..") {
		return "", errors.New("invalid '..' sequence in name")
	}
	return s, nil
}

// MaskSecret redacts all but the last 4 characters of a token.
func MaskSecret(v string) string {
	s := strings.TrimSpace(v)
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		return "****"
	}
	return "****" + s[len(s)-4:]
}

// RandomID returns n random bytes as lowercase hex.
func RandomID(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
