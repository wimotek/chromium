package api

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// AuthMiddleware 支持 Authorization: Bearer <token> 与 X-Auth-Token 两种认证头，使用动态令牌提供器与常量时间比对
func AuthMiddleware(tokenProvider func() string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userToken := strings.TrimSpace(r.Header.Get("X-Auth-Token"))
		if userToken == "" {
			if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
				userToken = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
			}
		}

		expected := tokenProvider()
		if userToken == "" || expected == "" || subtle.ConstantTimeCompare([]byte(userToken), []byte(expected)) != 1 {
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