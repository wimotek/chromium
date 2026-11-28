package scheduler

import (
	"database/sql"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/wimotek/url/internal/audit"
	"github.com/wimotek/url/internal/config"
	"github.com/wimotek/url/internal/db"
)

type Scheduler struct {
	mu      sync.Mutex
	cron    *cron.Cron
	store   *db.Store
	audit   *audit.Logger
	dataDir string
}

func New(store *db.Store, auditLogger *audit.Logger, dataDir string) *Scheduler {
	return &Scheduler{
		cron:    cron.New(),
		store:   store,
		audit:   auditLogger,
		dataDir: dataDir,
	}
}

func (s *Scheduler) Start(backupRetention int) {
	cfg := config.Config{
		BackupRetentionCount: backupRetention,
		CronTasks:            config.DefaultCronTasks(),
	}
	s.StartWithConfig(cfg)
}

func (s *Scheduler) StartWithConfig(cfg config.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registerAndStartLocked(cfg)
}

func (s *Scheduler) Reload(cfg config.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cron != nil {
		ctx := s.cron.Stop()
		<-ctx.Done()
	}
	s.cron = cron.New()
	s.registerAndStartLocked(cfg)
}

func (s *Scheduler) registerAndStartLocked(cfg config.Config) {
	tasks := cfg.CronTasks
	if len(tasks) == 0 {
		tasks = config.DefaultCronTasks()
	}
	backupRetention := cfg.BackupRetentionCount
	if backupRetention <= 0 {
		backupRetention = 14
	}

	for _, task := range tasks {
		if !task.Enabled {
			continue
		}
		expr := strings.TrimSpace(task.CronExpression)
		if expr == "" {
			continue
		}

		switch task.Key {
		case "db_backup":
			if _, err := s.cron.AddFunc(expr, func() {
				path, err := s.store.Backup(backupRetention)
				if err != nil {
					log.Printf("scheduled backup failed: %v", err)
					s.audit.Record("system/cron", "db_backup", path, "127.0.0.1", "LOCAL", "failed", err.Error())
					return
				}
				s.audit.Record("system/cron", "db_backup", path, "127.0.0.1", "LOCAL", "success", "Consistent database backup completed")
			}); err != nil {
				log.Printf("invalid db_backup cron expression %q: %v", expr, err)
			}

		case "audit_rotate":
			if _, err := s.cron.AddFunc(expr, func() {
				if err := s.audit.RotateAndPrune(); err != nil {
					log.Printf("audit rotation failed: %v", err)
				}
			}); err != nil {
				log.Printf("invalid audit_rotate cron expression %q: %v", expr, err)
			}

		case "expired_cleanup":
			if _, err := s.cron.AddFunc(expr, func() {
				if s.store.DB() == nil {
					return
				}
				now := time.Now().UTC()
				_ = s.store.WithWriteLock(func(conn *sql.DB) error {
					_, _ = conn.Exec(`UPDATE short_links SET enabled = FALSE WHERE expires_at IS NOT NULL AND expires_at <= ? AND is_system_protected = FALSE`, now)
					_, _ = conn.Exec(`DELETE FROM kv_cache WHERE expires_at <= ?`, now.Unix())
					return nil
				})
			}); err != nil {
				log.Printf("invalid expired_cleanup cron expression %q: %v", expr, err)
			}
		}
	}

	s.cron.Start()
}

func (s *Scheduler) Stop() {
	s.mu.Lock()
	c := s.cron
	s.mu.Unlock()
	if c != nil {
		ctx := c.Stop()
		<-ctx.Done()
	}
}
