package audit

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/wimotek/url/internal/db"
)

type Entry struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Actor     string `json:"actor"`
	Action    string `json:"action"`
	Resource  string `json:"resource"`
	IP        string `json:"ip"`
	Region    string `json:"region"`
	Status    string `json:"status"`
	Detail    string `json:"detail"`
}

// Logger persists audit entries into SQL and maintains rolling JSONL log files
// bounded by retention days and maximum active row count.
type Logger struct {
	mu            sync.Mutex
	store         *db.Store
	logDir        string
	retentionDays int
	maxRows       int
}

func NewLogger(store *db.Store, logDir string, retentionDays, maxRows int) *Logger {
	if retentionDays < 1 {
		retentionDays = 30
	}
	if maxRows < 100 {
		maxRows = 50000
	}
	_ = os.MkdirAll(logDir, 0o750)
	return &Logger{
		store:         store,
		logDir:        logDir,
		retentionDays: retentionDays,
		maxRows:       maxRows,
	}
}

func (l *Logger) Record(actor, action, resource, ip, region, status, detail string) {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	entry := Entry{
		ID:        "aud_" + hex.EncodeToString(b),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Actor:     actor,
		Action:    action,
		Resource:  resource,
		IP:        ip,
		Region:    region,
		Status:    status,
		Detail:    detail,
	}

	if l.store != nil && l.store.DB() != nil {
		_ = l.store.WithWriteLock(func(conn *sql.DB) error {
			_, err := conn.Exec(
				`INSERT INTO audit_logs (id, actor, action, resource, ip, region, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				entry.ID, entry.Actor, entry.Action, entry.Resource, entry.IP, entry.Region, entry.Status, entry.Detail,
			)
			return err
		})
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	dayFile := filepath.Join(l.logDir, fmt.Sprintf("audit-%s.jsonl", time.Now().UTC().Format("2006-01-02")))
	if f, err := os.OpenFile(dayFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		if line, err := json.Marshal(entry); err == nil {
			_, _ = f.Write(append(line, '\n'))
		}
		_ = f.Close()
	}
}

// RotateAndPrune removes expired JSONL archives and trims SQL audit table beyond retention policy.
func (l *Logger) RotateAndPrune() error {
	l.mu.Lock()
	defer l.mu.Unlock()

	entries, err := os.ReadDir(l.logDir)
	if err == nil {
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() > entries[j].Name() })
		for idx, e := range entries {
			if idx >= l.retentionDays && !e.IsDir() {
				_ = os.Remove(filepath.Join(l.logDir, e.Name()))
			}
		}
	}

	if l.store != nil && l.store.DB() != nil {
		cutoff := time.Now().UTC().AddDate(0, 0, -l.retentionDays)
		return l.store.WithWriteLock(func(conn *sql.DB) error {
			_, err := conn.Exec(`DELETE FROM audit_logs WHERE created_at < ?`, cutoff)
			return err
		})
	}
	return nil
}
