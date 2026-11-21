package api

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"

	"github.com/wimotek/nginx/internal/config"
	"github.com/wimotek/nginx/internal/nginx"
)

const maxRequestBodyBytes = 1 << 20 // 1MB

type Handler struct {
	cfg     *config.Config
	mgr     *nginx.Manager
	exec    *nginx.Executor
	acme    *nginx.AcmeManager
	limiter *LoginRateLimiter
}

func NewHandler(cfg *config.Config, mgr *nginx.Manager, exec *nginx.Executor, acme *nginx.AcmeManager) *Handler {
	return &Handler{
		cfg:     cfg,
		mgr:     mgr,
		exec:    exec,
		acme:    acme,
		limiter: NewLoginRateLimiter(15, 5*time.Minute),
	}
}

func writeJSON(w http.ResponseWriter, status int, payload map[string]interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]interface{}{
		"code":  status,
		"error": msg,
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst interface{}) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	dec := json.NewDecoder(r.Body)
	return dec.Decode(dst)
}

// Health 健康探针接口（供 Docker HEALTHCHECK / Kubernetes Probe 使用）
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	running, pid := h.exec.CheckStatus()
	status := http.StatusOK
	if !running {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]interface{}{
		"code":    status,
		"running": running,
		"pid":     pid,
	})
}

// Login 管理员登录接口（支持账号密码登录，附带防爆破限流）
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	if !h.limiter.Allow(r.RemoteAddr) {
		writeError(w, http.StatusTooManyRequests, "登录尝试过于频繁，请 5 分钟后再试")
		return
	}

	var creds struct {
		User  string `json:"user"`
		Pass  string `json:"pass"`
		Token string `json:"token"`
	}
	if err := decodeJSON(w, r, &creds); err != nil {
		writeError(w, http.StatusBadRequest, "请求参数格式非法")
		return
	}

	if creds.Token != "" {
		if subtle.ConstantTimeCompare([]byte(creds.Token), []byte(h.cfg.AuthToken)) == 1 {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"code":  200,
				"token": h.cfg.AuthToken,
				"user":  h.cfg.AdminUser,
			})
			return
		}
		writeError(w, http.StatusUnauthorized, "授权 Token 无效")
		return
	}

	if subtle.ConstantTimeCompare([]byte(creds.User), []byte(h.cfg.AdminUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(creds.Pass), []byte(h.cfg.AdminPass)) == 1 {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"code":  200,
			"token": h.cfg.AuthToken,
			"user":  h.cfg.AdminUser,
		})
		return
	}
	writeError(w, http.StatusUnauthorized, "账号或密码错误")
}

// SystemInfo 返回 Nginx 版本、编译参数、已启用的模块列表及站点/证书汇总
func (h *Handler) SystemInfo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	build := h.exec.GetBuildInfo()
	sites, _ := h.mgr.ListSites()
	certs, _ := h.acme.ListCerts()

	enabledSites := 0
	sslSites := 0
	for _, s := range sites {
		if s.Enabled {
			enabledSites++
		}
		if s.HasSSL {
			sslSites++
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code": 200,
		"data": map[string]interface{}{
			"nginx": build,
			"summary": map[string]interface{}{
				"total_sites":   len(sites),
				"enabled_sites": enabledSites,
				"ssl_sites":     sslSites,
				"total_certs":   len(certs),
			},
		},
	})
}

// ListSites 获取所有托管站点（包含启用状态、SSL、模式、gzip_static 标识）
func (h *Handler) ListSites(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	sites, err := h.mgr.ListSites()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code": 200,
		"data": sites,
	})
}

// GetSite 获取指定站点配置内容
func (h *Handler) GetSite(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	content, enabled, err := h.mgr.ReadSite(domain)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":    200,
		"domain":  domain,
		"enabled": enabled,
		"content": content,
	})
}

// TestSite 干跑校验指定站点配置（不落盘）
func (h *Handler) TestSite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var req struct {
		Domain  string `json:"domain"`
		Content string `json:"content"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求参数格式非法")
		return
	}
	out, err := h.mgr.TestSiteContent(req.Domain, req.Content)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"code":   400,
			"error":  err.Error(),
			"output": out,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":   200,
		"msg":    "nginx -t 语法校验通过",
		"output": out,
	})
}

// SaveSite 事务级保存站点配置（先验检查 + 失败回滚）
func (h *Handler) SaveSite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Domain  string `json:"domain"`
		Content string `json:"content"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求参数格式非法")
		return
	}
	out, err := h.mgr.SaveSite(req.Domain, req.Content)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"code":   400,
			"error":  err.Error(),
			"output": out,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":   200,
		"msg":    "配置校验通过并原子保存成功",
		"output": out,
	})
}

// ToggleSite 启用或停用指定站点
func (h *Handler) ToggleSite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	var req struct {
		Domain  string `json:"domain"`
		Enabled bool   `json:"enabled"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求参数格式非法")
		return
	}
	out, err := h.mgr.ToggleSite(req.Domain, req.Enabled)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	action := "已停用"
	if req.Enabled {
		action = "已启用"
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":   200,
		"msg":    "站点 " + req.Domain + " " + action,
		"output": out,
	})
}

// DeleteSite 删除站点
func (h *Handler) DeleteSite(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Query().Get("domain")
	if err := h.mgr.DeleteSite(domain); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code": 200,
		"msg":  "站点配置已彻底清理",
	})
}

// MainConfig 读取或更新全局 /etc/nginx/nginx.conf
func (h *Handler) MainConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		content, err := h.mgr.ReadMainConfig()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"code":    200,
			"content": content,
		})
	case http.MethodPost:
		var req struct {
			Content string `json:"content"`
		}
		if err := decodeJSON(w, r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "请求参数格式非法")
			return
		}
		out, err := h.mgr.SaveMainConfig(req.Content)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{
				"code":   400,
				"error":  err.Error(),
				"output": out,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"code":   200,
			"msg":    "主配置 nginx.conf 校验通过并已保存",
			"output": out,
		})
	default:
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
	}
}

// Reload 平滑热重载 Nginx
func (h *Handler) Reload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	out, err := h.exec.Reload()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]interface{}{
			"code":   500,
			"error":  err.Error(),
			"output": out,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":   200,
		"msg":    "Nginx 语法通过并完成零停机热重载",
		"output": out,
	})
}

// ListCerts 返回 SSL 证书资产清单
func (h *Handler) ListCerts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	certs, err := h.acme.ListCerts()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code": 200,
		"data": certs,
	})
}

type IssueCertRequest struct {
	Domain     string            `json:"domain"`
	Type       string            `json:"type"`        // "http" 或 "dns"
	CAServer   string            `json:"ca_server"`   // "letsencrypt" 或 "zerossl"
	Provider   string            `json:"provider"`    // "dns_cf", "dns_ali", "dns_dp", ...
	IsWildcard bool              `json:"is_wildcard"` // 是否同时签发 *.domain.com
	EnvParams  map[string]string `json:"env_params"`
}

// IssueSSL 签发 SSL 证书（兼容 HTTP-01 与 DNS-01 泛域名）
func (h *Handler) IssueSSL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}

	var req IssueCertRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "请求参数格式非法")
		return
	}
	if err := nginx.ValidateDomain(req.Domain); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var err error
	if req.Type == "dns" {
		err = h.acme.IssueCertDNS(req.Domain, req.IsWildcard, req.Provider, req.CAServer, req.EnvParams)
	} else {
		err = h.acme.IssueCert(req.Domain, req.CAServer)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code": 200,
		"msg":  "SSL 证书签发并部署成功",
	})
}