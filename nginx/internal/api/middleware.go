package api

import (
	"crypto/subtle"
	"net/http"
)

func AuthMiddleware(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userToken := r.Header.Get("X-Auth-Token")
		// 采用常量时间比对，彻底杜绝时序侧信道攻击 (Timing Attack)
		if subtle.ConstantTimeCompare([]byte(userToken), []byte(token)) != 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code":401,"error":"未授权访问或认证已失效"}`))
			return
		}
		next(w, r)
	}
}