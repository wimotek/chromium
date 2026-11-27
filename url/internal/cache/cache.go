package cache

import (
	"context"
	"database/sql"
	"log"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/wimotek/url/internal/config"
	"github.com/wimotek/url/internal/db"
)

type Store interface {
	Get(ctx context.Context, key string) (string, bool)
	Set(ctx context.Context, key, val string, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
	EngineName() string
}

type HybridCache struct {
	redisClient *redis.Client
	sqlStore    *db.Store
	memMu       sync.RWMutex
	mem         map[string]memItem
}

type memItem struct {
	val       string
	expiresAt int64
}

func NewMemorySQLFallback(sqlStore *db.Store) *HybridCache {
	return &HybridCache{
		sqlStore: sqlStore,
		mem:      make(map[string]memItem),
	}
}

func NewWithFallback(cfg config.RedisConfig, sqlStore *db.Store) Store {
	hc := NewMemorySQLFallback(sqlStore)
	if !cfg.Enabled || cfg.Addr == "" {
		return hc
	}
	rdb := redis.NewClient(&redis.Options{
		Addr:        cfg.Addr,
		Password:    cfg.Password,
		DB:          cfg.DB,
		DialTimeout: 2 * time.Second,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("redis unreachable (%v), automatically falling back to SQL Cache", err)
		_ = rdb.Close()
		return hc
	}
	hc.redisClient = rdb
	return hc
}

func (c *HybridCache) EngineName() string {
	if c.redisClient != nil {
		return "redis"
	}
	return "sql_cache"
}

func (c *HybridCache) Get(ctx context.Context, key string) (string, bool) {
	if c.redisClient != nil {
		val, err := c.redisClient.Get(ctx, key).Result()
		if err == nil {
			return val, true
		}
	}

	c.memMu.RLock()
	item, ok := c.mem[key]
	c.memMu.RUnlock()
	if ok && item.expiresAt > time.Now().Unix() {
		return item.val, true
	}

	if conn := c.sqlStore.DB(); conn != nil {
		var val string
		var exp int64
		err := conn.QueryRowContext(ctx, `SELECT cache_value, expires_at FROM kv_cache WHERE cache_key = ?`, key).Scan(&val, &exp)
		if err == nil && exp > time.Now().Unix() {
			return val, true
		}
	}
	return "", false
}

func (c *HybridCache) Set(ctx context.Context, key, val string, ttl time.Duration) error {
	if c.redisClient != nil {
		if err := c.redisClient.Set(ctx, key, val, ttl).Err(); err == nil {
			return nil
		}
	}
	exp := time.Now().Add(ttl).Unix()
	c.memMu.Lock()
	c.mem[key] = memItem{val: val, expiresAt: exp}
	c.memMu.Unlock()

	if c.sqlStore.DB() != nil {
		return c.sqlStore.WithWriteLock(func(conn *sql.DB) error {
			_, err := conn.ExecContext(
				ctx,
				`INSERT INTO kv_cache (cache_key, cache_value, expires_at) VALUES (?, ?, ?)
				 ON CONFLICT(cache_key) DO UPDATE SET cache_value = excluded.cache_value, expires_at = excluded.expires_at`,
				key, val, exp,
			)
			return err
		})
	}
	return nil
}

func (c *HybridCache) Delete(ctx context.Context, key string) error {
	if c.redisClient != nil {
		_ = c.redisClient.Del(ctx, key).Err()
	}
	c.memMu.Lock()
	delete(c.mem, key)
	c.memMu.Unlock()

	if c.sqlStore.DB() != nil {
		return c.sqlStore.WithWriteLock(func(conn *sql.DB) error {
			_, err := conn.ExecContext(ctx, `DELETE FROM kv_cache WHERE cache_key = ?`, key)
			return err
		})
	}
	return nil
}
