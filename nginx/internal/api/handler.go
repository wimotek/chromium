package api

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/wimotek/nginx/internal/config"
	"github.com/wimotek/nginx/internal/nginx"
)

type Handler struct {
	cfg  *config.Config
	mgr  *nginx.Manager
	exec *nginx.Executor
	acme *nginx.AcmeManager
}

func NewHandler(cfg *config.Config, mgr *nginx.Manager, exec *nginx.Executor) *Handler {
	return &Handler{
		cfg:  cfg,
		mgr:  mgr,
		exec: exec,
		acme: nginx.NewAcmeManager(),
	}
}

// 登录接口
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}
	var creds struct{ User, Pass string }
	if err := json.NewDecoder(r.Body).Decode(&creds); err != nil {
		http.Error(w, "Bad Request", 400)
		return
	}
	if subtle.ConstantTimeCompare([]byte(creds.User), []byte(h.cfg.AdminUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(creds.Pass), []byte(h.cfg.AdminPass)) == 1 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"code": 200, "token": h.cfg.AuthToken})
		return
	}
	http.Error(w, `{"code":401,"error":"账号或密码错误"}`, http.StatusUnauthorized)
}

// 获取所有托管站点
func (h *Handler) ListSites(w http.ResponseWriter, r *http.Request) {
	sites, err := h.mgr.ListSites()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"code": 200, "data": sites})
}

// 获取指定站点配置内容
func (h *Handler) GetSite(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	content, err := h.mgr.ReadSite(domain)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"code": 200, "content": content})
}

// 保存站点配置（先验原子检查，nginx -t 失败则拒绝保存）
func (h *Handler) SaveSite(w http.ResponseWriter, r *http.Request) {
	var req struct{ Domain, Content string }
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := h.mgr.SaveSite(req.Domain, req.Content); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{"code": 400, "error": err.Error()})
		return
	}
	w.Write([]byte(`{"code":200,"msg":"配置校验通过并保存成功"}`))
}

// 删除站点
func (h *Handler) DeleteSite(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	if err := h.mgr.DeleteSite(domain); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	w.Write([]byte(`{"code":200,"msg":"站点配置已彻底清理"}`))
}

// 平滑热重载 Nginx
func (h *Handler) Reload(w http.ResponseWriter, r *http.Request) {
	if err := h.exec.Reload(); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{"code": 500, "error": err.Error()})
		return
	}
	w.Write([]byte(`{"code":200,"msg":"Nginx 毫秒级热重载完成"}`))
}

// 统一 ACME 证书签发请求体
type IssueCertRequest struct {
	Domain     string            `json:"domain"`
	Type       string            `json:"type"`        // "http" 或 "dns"
	Provider   string            `json:"provider"`    // "dns_cf", "dns_ali", "dns_dp" 等
	IsWildcard bool              `json:"is_wildcard"` // 是否签发 *.domain.com
	EnvParams  map[string]string `json:"env_params"`  // 厂商 API 密钥键值对
}

// IssueSSL 签发 SSL 证书（同时兼容 HTTP-01 与 DNS-01 泛域名）
func (h *Handler) IssueSSL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", 405)
		return
	}

	var req IssueCertRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"code":400,"error":"请求参数格式非法"}`, 400)
		return
	}

	if req.Domain == "" {
		http.Error(w, `{"code":400,"error":"必须提供申请证书的域名"}`, 400)
		return
	}

	var err error
	if req.Type == "dns" {
		// 执行 DNS-01 验证（支持泛域名与内网）
		err = h.acme.IssueCertDNS(req.Domain, req.IsWildcard, req.Provider, req.EnvParams)
	} else {
		// 执行默认 HTTP-01 验证
		err = h.acme.IssueCert(req.Domain)
	}

	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{"code": 500, "error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"code": 200,
		"msg":  "SSL 证书签发并部署成功！",
	})
}