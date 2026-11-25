package cache

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

var ErrCacheMiss = errors.New("cache miss")

type Cache interface {
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	Get(ctx context.Context, key string) (string, error)
	Delete(ctx context.Context, key string) error
	Mode() string
	Close() error
}

// ResilientCache prefers Redis for low-latency storage of auth codes, PKCE state/nonce,
// rate limits, and token blacklists. If Redis is unconfigured or drops out at runtime,
// it transparently falls back to the SQL `sys_caches` table with periodic expiry cleanup.
type ResilientCache struct {
	rdb          *redis.Client
	db           *sql.DB
	driver       string
	redisHealthy atomic.Bool
	stopGC       chan struct{}
}

func NewResilientCache(rdb *redis.Client, db *sql.DB, driver string) *ResilientCache {
	c := &ResilientCache{
		rdb:    rdb,
		db:     db,
		driver: driver,
		stopGC: make(chan struct{}),
	}
	if rdb != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		if err := rdb.Ping(ctx).Err(); err == nil {
			c.redisHealthy.Store(true)
		}
		cancel()
	}
	go c.gcLoop()
	return c
}

func (c *ResilientCache) Mode() string {
	if c.rdb != nil && c.redisHealthy.Load() {
		return "redis"
	}
	return "sql_fallback"
}

func (c *ResilientCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	if c.rdb != nil {
		if err := c.rdb.Set(ctx, key, value, ttl).Err(); err == nil {
			c.redisHealthy.Store(true)
			return nil
		} else {
			c.redisHealthy.Store(false)
			log.Printf("[CACHE] Redis SET unavailable (%v); transparently falling back to SQL sys_caches", err)
		}
	}
	return c.sqlSet(ctx, key, value, ttl)
}

func (c *ResilientCache) Get(ctx context.Context, key string) (string, error) {
	if c.rdb != nil {
		val, err := c.rdb.Get(ctx, key).Result()
		if err == nil {
			c.redisHealthy.Store(true)
			return val, nil
		}
		if errors.Is(err, redis.Nil) {
			c.redisHealthy.Store(true)
			// Also check SQL fallback in case value was written during a brief Redis outage
		} else {
			c.redisHealthy.Store(false)
			log.Printf("[CACHE] Redis GET unavailable (%v); transparently falling back to SQL sys_caches", err)
		}
	}
	return c.sqlGet(ctx, key)
}

func (c *ResilientCache) Delete(ctx context.Context, key string) error {
	if c.rdb != nil {
		_ = c.rdb.Del(ctx, key).Err()
	}
	_, err := c.db.ExecContext(ctx, `DELETE FROM sys_caches WHERE cache_key = ?`, key)
	return err
}

func (c *ResilientCache) sqlSet(ctx context.Context, key, value string, ttl time.Duration) error {
	exp := time.Now().Add(ttl).Unix()
	var query string
	if c.driver == "mysql" {
		query = `INSERT INTO sys_caches (cache_key, cache_value, expires_at) VALUES (?, ?, ?)
		         ON DUPLICATE KEY UPDATE cache_value = VALUES(cache_value), expires_at = VALUES(expires_at)`
	} else {
		query = `INSERT INTO sys_caches (cache_key, cache_value, expires_at) VALUES (?, ?, ?)
		         ON CONFLICT(cache_key) DO UPDATE SET cache_value = excluded.cache_value, expires_at = excluded.expires_at`
	}
	_, err := c.db.ExecContext(ctx, query, key, value, exp)
	return err
}

func (c *ResilientCache) sqlGet(ctx context.Context, key string) (string, error) {
	var val string
	var exp int64
	err := c.db.QueryRowContext(ctx, `SELECT cache_value, expires_at FROM sys_caches WHERE cache_key = ?`, key).Scan(&val, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrCacheMiss
	}
	if err != nil {
		return "", err
	}
	if time.Now().Unix() > exp {
		_, _ = c.db.ExecContext(ctx, `DELETE FROM sys_caches WHERE cache_key = ?`, key)
		return "", ErrCacheMiss
	}
	return val, nil
}

func (c *ResilientCache) gcLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_, _ = c.db.ExecContext(ctx, `DELETE FROM sys_caches WHERE expires_at < ?`, time.Now().Unix())
			cancel()
		case <-c.stopGC:
			return
		}
	}
}

func (c *ResilientCache) Close() error {
	close(c.stopGC)
	if c.rdb != nil {
		return c.rdb.Close()
	}
	return nil
}
