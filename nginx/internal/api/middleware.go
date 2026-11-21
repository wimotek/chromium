package api

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// AuthMiddleware 支持 Authorization: Bearer <token> 与 X-Auth-Token 两种认证头，使用常量时间比对
func AuthMiddleware(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userToken := strings.TrimSpace(r.Header.Get("X-Auth-Token"))
		if userToken == "" {
			if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
				userToken = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
			}
		}

		if userToken == "" || subtle.ConstantTimeCompare([]byte(userToken), []byte(token)) != 1 {
			writeError(w, http.StatusUnauthorized, "未授权访问或会话已失效，请重新登录")
			return
		}
		next(w, r)
	}
}

// SecurityHeadersMiddleware 注入基础安全响应头
func SecurityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

type loginAttempt struct {
	count   int
	resetAt time.Time
}

// LoginRateLimiter 简单的基于内存的登录防爆破限流器（每 IP 5 分钟内最多 15 次尝试）
type LoginRateLimiter struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempt
	limit    int
	window   time.Duration
}

func NewLoginRateLimiter(limit int, window time.Duration) *LoginRateLimiter {
	return &LoginRateLimiter{
		attempts: make(map[string]*loginAttempt),
		limit:    limit,
		window:   window,
	}
}

func (l *LoginRateLimiter) Allow(remoteAddr string) bool {
	ip, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		ip = remoteAddr
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	entry, exists := l.attempts[ip]
	if !exists || now.After(entry.resetAt) {
		l.attempts[ip] = &loginAttempt{count: 1, resetAt: now.Add(l.window)}
		return true
	}
	if entry.count >= l.limit {
		return false
	}
	entry.count++
	return true
}