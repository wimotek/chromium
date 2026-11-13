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

func (h *Handler) ListSites(w http.ResponseWriter, r *http.Request) {
	sites, err := h.mgr.ListSites()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"code": 200, "data": sites})
}

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

func (h *Handler) DeleteSite(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	if err := h.mgr.DeleteSite(domain); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	w.Write([]byte(`{"code":200,"msg":"站点配置已彻底清理"}`))
}

func (h *Handler) Reload(w http.ResponseWriter, r *http.Request) {
	if err := h.exec.Reload(); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{"code": 500, "error": err.Error()})
		return
	}
	w.Write([]byte(`{"code":200,"msg":"Nginx 毫秒级热重载完成"}`))
}

// IssueSSL 执行 ACME 证书一键申请
func (h *Handler) IssueSSL(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	if domain == "" {
		http.Error(w, `{"code":400,"error":"必须指定申请证书的域名"}`, 400)
		return
	}
	if err := h.acme.IssueCert(domain); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{"code": 500, "error": err.Error()})
		return
	}
	w.Write([]byte(`{"code":200,"msg":"SSL 证书签发并部署成功！"}`))
}