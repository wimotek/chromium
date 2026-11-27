package scheduler

import (
	"database/sql"
	"log"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/wimotek/url/internal/audit"
	"github.com/wimotek/url/internal/db"
)

type Scheduler struct {
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
	// Nightly database backup with retention pruning
	_, _ = s.cron.AddFunc("0 3 * * *", func() {
		path, err := s.store.Backup(backupRetention)
		if err != nil {
			log.Printf("scheduled backup failed: %v", err)
			s.audit.Record("system/cron", "db_backup", path, "127.0.0.1", "LOCAL", "failed", err.Error())
			return
		}
		s.audit.Record("system/cron", "db_backup", path, "127.0.0.1", "LOCAL", "success", "Consistent database backup completed")
	})

	// Rolling audit log rotation
	_, _ = s.cron.AddFunc("30 3 * * *", func() {
		if err := s.audit.RotateAndPrune(); err != nil {
			log.Printf("audit rotation failed: %v", err)
		}
	})

	// Hourly expired link & cache cleanup
	_, _ = s.cron.AddFunc("0 * * * *", func() {
		if s.store.DB() == nil {
			return
		}
		now := time.Now().UTC()
		_ = s.store.WithWriteLock(func(conn *sql.DB) error {
			_, _ = conn.Exec(`UPDATE short_links SET enabled = FALSE WHERE expires_at IS NOT NULL AND expires_at <= ? AND is_system_protected = FALSE`, now)
			_, _ = conn.Exec(`DELETE FROM kv_cache WHERE expires_at <= ?`, now.Unix())
			return nil
		})
	})

	s.cron.Start()
}

func (s *Scheduler) Stop() {
	ctx := s.cron.Stop()
	<-ctx.Done()
}
