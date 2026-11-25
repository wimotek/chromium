package cache

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/wimotek/ca/internal/store"
)

const (
	// CRLIssuingDERKey is the canonical cache key purged upon Redis recovery and revocation.
	CRLIssuingDERKey = "crl:issuing"
	CRLIssuingPEMKey = "crl:issuing:pem"

	circuitBreakerDuration = 15 * time.Second
	healthProbeInterval    = 10 * time.Second
)

// RedisConfig defines optional Redis connectivity settings.
type RedisConfig struct {
	Addr        string
	Password    string
	UseTLS      bool
	TLSInsecure bool
}

// Status reports current HybridCache health for observability.
type Status struct {
	Mode              string `json:"mode"`
	RedisConfigured   bool   `json:"redis_configured"`
	RedisHealthy      bool   `json:"redis_healthy"`
	CircuitOpenUntil  int64  `json:"circuit_open_until"`
	FallbackSQLActive bool   `json:"fallback_sql_active"`
}

// HybridCache implements Redis-first caching with a 15-second circuit breaker,
// 10-second background health probing, seamless SQL cache_kv fallback,
// stale CRL key purge on Redis recovery, and SQL+Redis double-delete.
type HybridCache struct {
	store            *store.Store
	redis            *redis.Client
	redisConfigured  bool
	circuitOpenUntil atomic.Int64 // Unix seconds
	redisDown        atomic.Bool
	stopCh           chan struct{}
}

// NewHybridCache creates a HybridCache. If cfg.Addr is empty or unreachable,
// initialization never fails or blocks; it seamlessly falls back to SQL cache_kv.
func NewHybridCache(st *store.Store, cfg RedisConfig) *HybridCache {
	hc := &HybridCache{
		store:  st,
		stopCh: make(chan struct{}),
	}

	if cfg.Addr == "" {
		hc.redisDown.Store(true)
		return hc
	}

	opts := &redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DialTimeout:  2 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
	}
	if cfg.UseTLS {
		opts.TLSConfig = &tls.Config{
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: cfg.TLSInsecure,
		}
	}

	hc.redis = redis.NewClient(opts)
	hc.redisConfigured = true

	// Non-blocking initial check: trip circuit breaker if Redis is offline at boot.
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if err := hc.redis.Ping(ctx).Err(); err != nil {
		log.Printf("[cache] redis unreachable at startup (%v); falling back to SQL cache_kv", err)
		hc.tripBreaker()
	}

	go hc.probeLoop()
	return hc
}

// Close stops the background health probe and closes Redis client if present.
func (hc *HybridCache) Close() error {
	close(hc.stopCh)
	if hc.redis != nil {
		return hc.redis.Close()
	}
	return nil
}

// Status returns the current operating mode of the HybridCache.
func (hc *HybridCache) Status() Status {
	openUntil := hc.circuitOpenUntil.Load()
	now := time.Now().Unix()
	healthy := hc.redisConfigured && !hc.redisDown.Load() && openUntil <= now
	mode := "sql_fallback"
	if healthy {
		mode = "redis_primary"
	} else if hc.redisConfigured {
		mode = "circuit_open_sql_fallback"
	}
	return Status{
		Mode:              mode,
		RedisConfigured:   hc.redisConfigured,
		RedisHealthy:      healthy,
		CircuitOpenUntil:  openUntil,
		FallbackSQLActive: !healthy,
	}
}

func (hc *HybridCache) canUseRedis() bool {
	if !hc.redisConfigured || hc.redis == nil {
		return false
	}
	if hc.redisDown.Load() {
		return false
	}
	return time.Now().Unix() >= hc.circuitOpenUntil.Load()
}

func (hc *HybridCache) tripBreaker() {
	hc.redisDown.Store(true)
	hc.circuitOpenUntil.Store(time.Now().Add(circuitBreakerDuration).Unix())
}

// probeLoop checks Redis every 10 seconds and clears stale crl:issuing keys upon recovery.
func (hc *HybridCache) probeLoop() {
	ticker := time.NewTicker(healthProbeInterval)
	defer ticker.Stop()

	for {
		select {
		case <-hc.stopCh:
			return
		case <-ticker.C:
			if !hc.redisConfigured || hc.redis == nil {
				continue
			}
			// Only restore after circuit breaker cooldown has elapsed when down.
			if hc.redisDown.Load() && time.Now().Unix() < hc.circuitOpenUntil.Load() {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			err := hc.redis.Ping(ctx).Err()
			if err != nil {
				cancel()
				if !hc.redisDown.Load() {
					log.Printf("[cache] redis health probe failed (%v); opening 15s circuit breaker", err)
				}
				hc.tripBreaker()
				continue
			}
			if hc.redisDown.Load() {
				// CRITICAL REDLINE: Purge stale CRL keys before re-enabling Redis reads.
				_ = hc.redis.Del(ctx, CRLIssuingDERKey, CRLIssuingPEMKey).Err()
				hc.circuitOpenUntil.Store(0)
				hc.redisDown.Store(false)
				log.Printf("[cache] redis recovered; purged stale %s keys and resumed primary mode", CRLIssuingDERKey)
			}
			cancel()
		}
	}
}

// Get retrieves a cached payload from Redis or seamlessly falls back to SQL cache_kv.
func (hc *HybridCache) Get(ctx context.Context, key string) ([]byte, bool, error) {
	if hc.canUseRedis() {
		val, err := hc.redis.Get(ctx, key).Bytes()
		if err == nil {
			return val, true, nil
		}
		if errors.Is(err, redis.Nil) {
			return nil, false, nil
		}
		hc.tripBreaker()
	}
	return hc.sqlGet(ctx, key)
}

// Set stores a payload with TTL into Redis (when healthy) or SQL cache_kv.
func (hc *HybridCache) Set(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	if hc.canUseRedis() {
		if err := hc.redis.Set(ctx, key, val, ttl).Err(); err == nil {
			return nil
		}
		hc.tripBreaker()
	}
	return hc.sqlSet(ctx, key, val, ttl)
}

// Del deletes keys from active cache backend.
func (hc *HybridCache) Del(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	if hc.canUseRedis() {
		if err := hc.redis.Del(ctx, keys...).Err(); err != nil {
			hc.tripBreaker()
		}
	}
	return hc.sqlDel(ctx, keys...)
}

// DoubleDelete explicitly deletes keys from BOTH SQL cache_kv AND Redis to prevent stale CRL reads on revocation.
func (hc *HybridCache) DoubleDelete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	sqlErr := hc.sqlDel(ctx, keys...)
	if hc.redisConfigured && hc.redis != nil {
		rctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		defer cancel()
		if err := hc.redis.Del(rctx, keys...).Err(); err != nil {
			hc.tripBreaker()
		}
	}
	return sqlErr
}

// SetNX atomically sets a key only if absent (used for one-time PoW anti-replay protection).
func (hc *HybridCache) SetNX(ctx context.Context, key string, val []byte, ttl time.Duration) (bool, error) {
	if hc.canUseRedis() {
		ok, err := hc.redis.SetNX(ctx, key, val, ttl).Result()
		if err == nil {
			return ok, nil
		}
		hc.tripBreaker()
	}
	return hc.sqlSetNX(ctx, key, val, ttl)
}

// IncrWindow increments a fixed-window counter and returns the current count for distributed IP rate limiting.
func (hc *HybridCache) IncrWindow(ctx context.Context, key string, window time.Duration) (int64, error) {
	windowSec := int64(window.Seconds())
	if windowSec <= 0 {
		windowSec = 60
	}
	bucket := time.Now().Unix() / windowSec
	bucketKey := fmt.Sprintf("%s:%d", key, bucket)

	if hc.canUseRedis() {
		pipe := hc.redis.TxPipeline()
		incr := pipe.Incr(ctx, bucketKey)
		pipe.Expire(ctx, bucketKey, window+5*time.Second)
		if _, err := pipe.Exec(ctx); err == nil {
			return incr.Val(), nil
		}
		hc.tripBreaker()
	}
	return hc.sqlIncrWindow(ctx, bucketKey, window+5*time.Second)
}

func (hc *HybridCache) sqlGet(ctx context.Context, key string) ([]byte, bool, error) {
	now := time.Now().Unix()
	var val []byte
	var expiresAt int64
	err := hc.store.ReadDB.QueryRowContext(ctx, `SELECT v, expires_at FROM cache_kv WHERE k = ?`, key).Scan(&val, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if expiresAt > 0 && expiresAt <= now {
		_ = hc.sqlDel(ctx, key)
		return nil, false, nil
	}
	return val, true, nil
}

func (hc *HybridCache) sqlSet(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	expiresAt := time.Now().Add(ttl).Unix()
	return hc.store.WithTx(ctx, func(tx *sql.Tx) error {
		if hc.store.Driver == store.DriverMySQL {
			_, err := tx.ExecContext(ctx, `
				INSERT INTO cache_kv (k, v, expires_at) VALUES (?, ?, ?)
				ON DUPLICATE KEY UPDATE v=VALUES(v), expires_at=VALUES(expires_at)
			`, key, val, expiresAt)
			return err
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO cache_kv (k, v, expires_at) VALUES (?, ?, ?)
			ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at
		`, key, val, expiresAt)
		return err
	})
}

func (hc *HybridCache) sqlDel(ctx context.Context, keys ...string) error {
	return hc.store.WithTx(ctx, func(tx *sql.Tx) error {
		for _, k := range keys {
			if _, err := tx.ExecContext(ctx, `DELETE FROM cache_kv WHERE k = ?`, k); err != nil {
				return err
			}
		}
		return nil
	})
}

func (hc *HybridCache) sqlSetNX(ctx context.Context, key string, val []byte, ttl time.Duration) (bool, error) {
	now := time.Now().Unix()
	expiresAt := now + int64(ttl.Seconds())
	var inserted bool
	err := hc.store.WithTx(ctx, func(tx *sql.Tx) error {
		// Clean expired record with same key first.
		_, _ = tx.ExecContext(ctx, `DELETE FROM cache_kv WHERE k = ? AND expires_at <= ?`, key, now)

		var existing int64
		err := tx.QueryRowContext(ctx, `SELECT expires_at FROM cache_kv WHERE k = ?`, key).Scan(&existing)
		if err == nil {
			inserted = false
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO cache_kv (k, v, expires_at) VALUES (?, ?, ?)`, key, val, expiresAt)
		if err != nil {
			return err
		}
		inserted = true
		return nil
	})
	return inserted, err
}

func (hc *HybridCache) sqlIncrWindow(ctx context.Context, bucketKey string, ttl time.Duration) (int64, error) {
	now := time.Now().Unix()
	expiresAt := now + int64(ttl.Seconds())
	var count int64

	err := hc.store.WithTx(ctx, func(tx *sql.Tx) error {
		var raw []byte
		var exp int64
		err := tx.QueryRowContext(ctx, `SELECT v, expires_at FROM cache_kv WHERE k = ?`, bucketKey).Scan(&raw, &exp)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && exp <= now) {
			count = 1
			val := []byte(strconv.FormatInt(count, 10))
			if hc.store.Driver == store.DriverMySQL {
				_, err = tx.ExecContext(ctx, `
					INSERT INTO cache_kv (k, v, expires_at) VALUES (?, ?, ?)
					ON DUPLICATE KEY UPDATE v=VALUES(v), expires_at=VALUES(expires_at)
				`, bucketKey, val, expiresAt)
				return err
			}
			_, err = tx.ExecContext(ctx, `
				INSERT INTO cache_kv (k, v, expires_at) VALUES (?, ?, ?)
				ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at
			`, bucketKey, val, expiresAt)
			return err
		}
		if err != nil {
			return err
		}
		prev, _ := strconv.ParseInt(string(raw), 10, 64)
		count = prev + 1
		_, err = tx.ExecContext(ctx, `UPDATE cache_kv SET v = ?, expires_at = ? WHERE k = ?`, []byte(strconv.FormatInt(count, 10)), expiresAt, bucketKey)
		return err
	})
	return count, err
}
