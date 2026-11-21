package mcp

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wimotek/nginx/internal/nginx"
)

const (
	protocolVersion    = "2025-03-26"
	serverName         = "wimotek-nginx"
	serverVersion      = "1.0.0"
	maxMCPRequestBytes = 1 << 20 // 1MB
)

// Config 控制 MCP Streamable HTTP 端点的初始启用状态、只读策略、专用令牌与持久化路径
type Config struct {
	Enabled               bool
	ReadOnly              bool
	DedicatedToken        string
	FallbackTokenProvider func() string
	FilePath              string
}

type persistedSettings struct {
	Enabled        bool   `json:"enabled"`
	ReadOnly       bool   `json:"read_only"`
	DedicatedToken string `json:"dedicated_token,omitempty"`
	UpdatedAt      string `json:"updated_at,omitempty"`
}

// ToolSummary 供后台管理界面展示的 MCP 工具摘要
type ToolSummary struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Mutating    bool   `json:"mutating"`
	Allowed     bool   `json:"allowed"`
}

// SettingsView 供后台管理接口返回的 MCP 运行时状态（绝不泄露明文令牌）
type SettingsView struct {
	Enabled           bool          `json:"enabled"`
	ReadOnly          bool          `json:"read_only"`
	HasDedicatedToken bool          `json:"has_dedicated_token"`
	TokenPreview      string        `json:"token_preview"`
	Endpoint          string        `json:"endpoint"`
	ProtocolVersion   string        `json:"protocol_version"`
	Source            string        `json:"source"`
	UpdatedAt         string        `json:"updated_at,omitempty"`
	ActiveToolCount   int           `json:"active_tool_count"`
	TotalToolCount    int           `json:"total_tool_count"`
	Tools             []ToolSummary `json:"tools"`
}

// UpdateSettingsRequest 后台动态修改 MCP 配置请求体
type UpdateSettingsRequest struct {
	Enabled     bool   `json:"enabled"`
	ReadOnly    bool   `json:"read_only"`
	RotateToken bool   `json:"rotate_token"`
	CustomToken string `json:"custom_token"`
	ClearToken  bool   `json:"clear_token"`
}

// Server 零第三方依赖的纯 Go 标准库 MCP (JSON-RPC 2.0 / Streamable HTTP) 服务端
type Server struct {
	mu                    sync.RWMutex
	enabled               bool
	readOnly              bool
	dedicatedToken        string
	fallbackTokenProvider func() string
	filePath              string
	source                string
	updatedAt             string
	mgr                   *nginx.Manager
	exec                  *nginx.Executor
	acme                  *nginx.AcmeManager
}

func NewServer(cfg Config, mgr *nginx.Manager, exec *nginx.Executor, acme *nginx.AcmeManager) *Server {
	s := &Server{
		enabled:               cfg.Enabled,
		readOnly:              cfg.ReadOnly,
		dedicatedToken:        strings.TrimSpace(cfg.DedicatedToken),
		fallbackTokenProvider: cfg.FallbackTokenProvider,
		filePath:              strings.TrimSpace(cfg.FilePath),
		source:                "env",
		mgr:                   mgr,
		exec:                  exec,
		acme:                  acme,
	}
	s.loadPersisted()
	return s
}

func (s *Server) loadPersisted() {
	if s.filePath == "" {
		return
	}
	raw, err := os.ReadFile(s.filePath)
	if err != nil {
		return
	}
	var saved persistedSettings
	if err := json.Unmarshal(raw, &saved); err != nil {
		log.Printf("[WARN] 解析持久化 MCP 配置失败 (%s): %v", s.filePath, err)
		return
	}
	s.enabled = saved.Enabled
	s.readOnly = saved.ReadOnly
	s.dedicatedToken = strings.TrimSpace(saved.DedicatedToken)
	s.updatedAt = saved.UpdatedAt
	s.source = "persisted"
}

func (s *Server) savePersistedLocked() error {
	if s.filePath == "" {
		return nil
	}
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(persistedSettings{
		Enabled:        s.enabled,
		ReadOnly:       s.readOnly,
		DedicatedToken: s.dedicatedToken,
		UpdatedAt:      s.updatedAt,
	}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".mcp-atomic-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.filePath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func maskMCPToken(tok string) string {
	t := strings.TrimSpace(tok)
	if t == "" {
		return ""
	}
	if len(t) <= 12 {
		return "••••••••"
	}
	return t[:8] + "••••••••" + t[len(t)-4:]
}

func generateMCPToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "wmk_mcp_" + hex.EncodeToString(b), nil
}

// GetSettings 返回当前 MCP 运行时状态与工具开放清单（线程安全）
func (s *Server) GetSettings() SettingsView {
	s.mu.RLock()
	enabled := s.enabled
	readOnly := s.readOnly
	ded := s.dedicatedToken
	source := s.source
	updatedAt := s.updatedAt
	s.mu.RUnlock()

	all := allTools()
	summaries := make([]ToolSummary, 0, len(all))
	activeCount := 0
	for _, t := range all {
		allowed := enabled && (!readOnly || !t.mutating)
		if allowed {
			activeCount++
		}
		summaries = append(summaries, ToolSummary{
			Name:        t.Name,
			Description: t.Description,
			Mutating:    t.mutating,
			Allowed:     allowed,
		})
	}

	return SettingsView{
		Enabled:           enabled,
		ReadOnly:          readOnly,
		HasDedicatedToken: ded != "",
		TokenPreview:      maskMCPToken(ded),
		Endpoint:          "/mcp",
		ProtocolVersion:   protocolVersion,
		Source:            source,
		UpdatedAt:         updatedAt,
		ActiveToolCount:   activeCount,
		TotalToolCount:    len(all),
		Tools:             summaries,
	}
}

// UpdateSettings 后台动态更新 MCP 开关、只读模式与独立 Token，原子持久化至 /data/.mcp.json 并即时生效
func (s *Server) UpdateSettings(req UpdateSettingsRequest) (SettingsView, string, error) {
	s.mu.Lock()
	prevEnabled := s.enabled
	prevReadOnly := s.readOnly
	prevToken := s.dedicatedToken
	prevSource := s.source
	prevUpdated := s.updatedAt

	plainToken := ""
	nextToken := s.dedicatedToken

	switch {
	case req.RotateToken:
		tok, err := generateMCPToken()
		if err != nil {
			s.mu.Unlock()
			return SettingsView{}, "", fmt.Errorf("无法生成安全随机 MCP Token: %v", err)
		}
		nextToken = tok
		plainToken = tok
	case strings.TrimSpace(req.CustomToken) != "":
		ct := strings.TrimSpace(req.CustomToken)
		if len(ct) < 16 || len(ct) > 256 || strings.ContainsAny(ct, " \t\r\n\x00") {
			s.mu.Unlock()
			return SettingsView{}, "", errors.New("自定义 MCP Token 长度须为 16~256 位且不可包含空格或控制字符")
		}
		nextToken = ct
		plainToken = ct
	case req.ClearToken:
		nextToken = ""
	}

	s.enabled = req.Enabled
	s.readOnly = req.ReadOnly
	s.dedicatedToken = nextToken
	s.updatedAt = time.Now().UTC().Format(time.RFC3339)
	s.source = "persisted"

	if err := s.savePersistedLocked(); err != nil {
		s.enabled = prevEnabled
		s.readOnly = prevReadOnly
		s.dedicatedToken = prevToken
		s.source = prevSource
		s.updatedAt = prevUpdated
		s.mu.Unlock()
		return SettingsView{}, "", fmt.Errorf("保存 MCP 配置失败: %v", err)
	}
	s.mu.Unlock()

	return s.GetSettings(), plainToken, nil
}

func (s *Server) runtimeState() (enabled, readOnly bool, expectedToken string) {
	s.mu.RLock()
	enabled = s.enabled
	readOnly = s.readOnly
	ded := s.dedicatedToken
	fallback := s.fallbackTokenProvider
	s.mu.RUnlock()

	if ded != "" {
		return enabled, readOnly, ded
	}
	if fallback != nil {
		return enabled, readOnly, strings.TrimSpace(fallback())
	}
	return enabled, readOnly, ""
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type toolDefinition struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
	Annotations map[string]interface{} `json:"annotations,omitempty"`
	mutating    bool
}

type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type resourceReadParams struct {
	URI string `json:"uri"`
}

// ServeHTTP 实现 MCP 2025-03-26 Streamable HTTP 端点（POST /mcp）
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	enabled, _, expectedToken := s.runtimeState()
	if !enabled {
		http.Error(w, "MCP endpoint is disabled (enable in Admin Console or set MCP_ENABLED=true)", http.StatusNotFound)
		return
	}

	// MCP Streamable HTTP 规范安全防护：若存在浏览器 Origin 头，校验与 Host 同源以防 DNS Rebinding
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || !strings.EqualFold(parsed.Host, r.Host) {
			writeJSONError(w, http.StatusForbidden, "Forbidden origin for MCP endpoint")
			return
		}
	}

	if !authenticateToken(r, expectedToken) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="wimotek-nginx-mcp"`)
		writeJSONError(w, http.StatusUnauthorized, "Unauthorized MCP request")
		return
	}

	switch r.Method {
	case http.MethodDelete:
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodPost:
		// handled below
	default:
		w.Header().Set("Allow", "POST, DELETE")
		writeJSONError(w, http.StatusMethodNotAllowed, "Use POST for MCP Streamable HTTP JSON-RPC requests")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxMCPRequestBytes)
	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeRPC(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			Error:   &rpcError{Code: -32700, Message: "Parse error: invalid JSON payload"},
		})
		return
	}

	if req.JSONRPC != "2.0" || strings.TrimSpace(req.Method) == "" {
		writeRPC(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32600, Message: "Invalid Request: jsonrpc must be '2.0' and method is required"},
		})
		return
	}

	// JSON-RPC 通知（无 id）按规范返回 202 Accepted
	if len(req.ID) == 0 || string(req.ID) == "null" {
		if strings.HasPrefix(req.Method, "notifications/") {
			w.WriteHeader(http.StatusAccepted)
			return
		}
	}

	resp := s.dispatch(req)
	writeRPC(w, http.StatusOK, resp)
}

func authenticateToken(r *http.Request, expected string) bool {
	if expected == "" {
		return false
	}
	provided := strings.TrimSpace(r.Header.Get("X-Auth-Token"))
	if provided == "" {
		if authz := r.Header.Get("Authorization"); strings.HasPrefix(authz, "Bearer ") {
			provided = strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
		}
	}
	return provided != "" && subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func (s *Server) dispatch(req rpcRequest) rpcResponse {
	switch req.Method {
	case "initialize":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": protocolVersion,
				"capabilities": map[string]interface{}{
					"tools":     map[string]interface{}{"listChanged": false},
					"resources": map[string]interface{}{"subscribe": false, "listChanged": false},
				},
				"serverInfo": map[string]interface{}{
					"name":    serverName,
					"version": serverVersion,
				},
				"instructions": "Wimotek Nginx microkernel MCP server. Always dry-run changes with test_site_config before calling save_site_config. All mutations are protected by atomic nginx -t rollback.",
			},
		}

	case "ping":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]interface{}{},
		}

	case "tools/list":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"tools": s.visibleTools(),
			},
		}

	case "tools/call":
		var params toolCallParams
		if err := json.Unmarshal(req.Params, &params); err != nil || strings.TrimSpace(params.Name) == "" {
			return rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "Invalid params: tool name is required"},
			}
		}
		return s.handleToolCall(req.ID, params)

	case "resources/list":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"resources": []map[string]interface{}{
					{
						"uri":         "nginx://system/info",
						"name":        "Nginx Runtime & Modules",
						"description": "Nginx version, compiled modules (nginx -V), and site/certificate counts",
						"mimeType":    "application/json",
					},
					{
						"uri":         "nginx://config/main",
						"name":        "Main nginx.conf",
						"description": "Global Nginx master configuration (/data/nginx.conf)",
						"mimeType":    "text/plain",
					},
					{
						"uri":         "nginx://sites",
						"name":        "Managed Sites Inventory",
						"description": "Structured inventory of all enabled and disabled site configs",
						"mimeType":    "application/json",
					},
					{
						"uri":         "nginx://certs",
						"name":        "SSL Certificates Inventory",
						"description": "X.509 metadata and expiration countdown for installed TLS certificates (no private keys)",
						"mimeType":    "application/json",
					},
				},
			},
		}

	case "resources/templates/list":
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"resourceTemplates": []map[string]interface{}{
					{
						"uriTemplate": "nginx://sites/{domain}",
						"name":        "Site Virtual Host Config",
						"description": "Raw Nginx virtual host configuration for a specific domain",
						"mimeType":    "text/plain",
					},
				},
			},
		}

	case "resources/read":
		var params resourceReadParams
		if err := json.Unmarshal(req.Params, &params); err != nil || strings.TrimSpace(params.URI) == "" {
			return rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "Invalid params: resource uri is required"},
			}
		}
		return s.handleResourceRead(req.ID, params.URI)

	default:
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", req.Method)},
		}
	}
}

func allTools() []toolDefinition {
	return []toolDefinition{
		{
			Name:        "nginx_health",
			Description: "Check whether the Nginx master process is running and return its PID.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
			Annotations: map[string]interface{}{"readOnlyHint": true, "destructiveHint": false},
			mutating:    false,
		},
		{
			Name:        "nginx_system_info",
			Description: "Inspect Nginx version, compiled modules (nginx -V), and total site/certificate counts.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
			Annotations: map[string]interface{}{"readOnlyHint": true, "destructiveHint": false},
			mutating:    false,
		},
		{
			Name:        "list_sites",
			Description: "List all managed Nginx virtual hosts with enabled state, SSL status, mode, ports, and compression flags.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
			Annotations: map[string]interface{}{"readOnlyHint": true, "destructiveHint": false},
			mutating:    false,
		},
		{
			Name:        "get_site_config",
			Description: "Read the full Nginx configuration text for a given site domain.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"domain": map[string]interface{}{"type": "string", "description": "FQDN domain name, e.g. app.example.com"},
				},
				"required": []string{"domain"},
			},
			Annotations: map[string]interface{}{"readOnlyHint": true, "destructiveHint": false},
			mutating:    false,
		},
		{
			Name:        "get_main_config",
			Description: "Read the global /data/nginx.conf master configuration file.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
			Annotations: map[string]interface{}{"readOnlyHint": true, "destructiveHint": false},
			mutating:    false,
		},
		{
			Name:        "list_certs",
			Description: "List X.509 SSL certificate metadata (issuer, SANs, expiry countdown). Private keys are never returned.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
			Annotations: map[string]interface{}{"readOnlyHint": true, "destructiveHint": false},
			mutating:    false,
		},
		{
			Name:        "test_site_config",
			Description: "Dry-run validate a proposed Nginx site config with 'nginx -t' without modifying disk state.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"domain":  map[string]interface{}{"type": "string", "description": "Target FQDN domain name"},
					"content": map[string]interface{}{"type": "string", "description": "Proposed Nginx server block config"},
				},
				"required": []string{"domain", "content"},
			},
			Annotations: map[string]interface{}{"readOnlyHint": true, "destructiveHint": false},
			mutating:    false,
		},
		{
			Name:        "save_site_config",
			Description: "Atomically save a site Nginx config after passing 'nginx -t' (auto-rolls back on error). Optionally reload Nginx.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"domain":  map[string]interface{}{"type": "string", "description": "Target FQDN domain name"},
					"content": map[string]interface{}{"type": "string", "description": "Full Nginx server block config"},
					"reload":  map[string]interface{}{"type": "boolean", "description": "Whether to run zero-downtime nginx -s reload immediately after saving"},
				},
				"required": []string{"domain", "content"},
			},
			Annotations: map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
			mutating:    true,
		},
		{
			Name:        "toggle_site",
			Description: "Enable or disable a managed Nginx site (.conf <-> .conf.disabled) with 'nginx -t' rollback safety.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"domain":  map[string]interface{}{"type": "string", "description": "Target FQDN domain name"},
					"enabled": map[string]interface{}{"type": "boolean", "description": "true to enable, false to disable"},
					"reload":  map[string]interface{}{"type": "boolean", "description": "Whether to reload Nginx after toggling"},
				},
				"required": []string{"domain", "enabled"},
			},
			Annotations: map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
			mutating:    true,
		},
		{
			Name:        "delete_site",
			Description: "Permanently delete a site's Nginx config file (does not delete SSL certificates).",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"domain": map[string]interface{}{"type": "string", "description": "Target FQDN domain name"},
					"reload": map[string]interface{}{"type": "boolean", "description": "Whether to reload Nginx after deletion"},
				},
				"required": []string{"domain"},
			},
			Annotations: map[string]interface{}{"readOnlyHint": false, "destructiveHint": true},
			mutating:    true,
		},
		{
			Name:        "save_main_config",
			Description: "Atomically update global /data/nginx.conf after passing 'nginx -t' (auto-rolls back on error).",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"content": map[string]interface{}{"type": "string", "description": "Full nginx.conf content"},
					"reload":  map[string]interface{}{"type": "boolean", "description": "Whether to reload Nginx after saving"},
				},
				"required": []string{"content"},
			},
			Annotations: map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
			mutating:    true,
		},
		{
			Name:        "reload_nginx",
			Description: "Run 'nginx -t' and trigger zero-downtime 'nginx -s reload'.",
			InputSchema: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}},
			Annotations: map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
			mutating:    true,
		},
		{
			Name:        "issue_ssl_cert",
			Description: "Issue or renew an SSL certificate via acme.sh using HTTP-01 or allowlisted DNS-01 providers (Let's Encrypt / ZeroSSL).",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"domain":      map[string]interface{}{"type": "string", "description": "Primary FQDN domain name"},
					"type":        map[string]interface{}{"type": "string", "enum": []string{"http", "dns"}, "description": "Validation mode: http or dns"},
					"ca_server":   map[string]interface{}{"type": "string", "enum": []string{"letsencrypt", "zerossl"}},
					"provider":    map[string]interface{}{"type": "string", "description": "Allowlisted DNS provider for dns mode (dns_cf, dns_ali, dns_dp, dns_aws, dns_gd, dns_hetzner)"},
					"is_wildcard": map[string]interface{}{"type": "boolean", "description": "Issue wildcard *.domain alongside apex (dns mode only)"},
					"env_params":  map[string]interface{}{"type": "object", "additionalProperties": map[string]interface{}{"type": "string"}},
				},
				"required": []string{"domain"},
			},
			Annotations: map[string]interface{}{"readOnlyHint": false, "destructiveHint": false},
			mutating:    true,
		},
	}
}

func (s *Server) visibleTools() []toolDefinition {
	_, readOnly, _ := s.runtimeState()
	all := allTools()
	if !readOnly {
		return all
	}
	out := make([]toolDefinition, 0, len(all))
	for _, t := range all {
		if !t.mutating {
			out = append(out, t)
		}
	}
	return out
}

func (s *Server) isMutatingTool(name string) (bool, bool) {
	for _, t := range allTools() {
		if t.Name == name {
			return t.mutating, true
		}
	}
	return false, false
}

func (s *Server) handleToolCall(id json.RawMessage, params toolCallParams) rpcResponse {
	_, readOnly, _ := s.runtimeState()
	mutating, exists := s.isMutatingTool(params.Name)
	if !exists {
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      id,
			Error:   &rpcError{Code: -32602, Message: fmt.Sprintf("Unknown tool: %s", params.Name)},
		}
	}
	if mutating && readOnly {
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      id,
			Error:   &rpcError{Code: -32003, Message: fmt.Sprintf("MCP is running in read-only mode (MCP_READ_ONLY=true); tool '%s' is forbidden", params.Name)},
		}
	}

	result, err := s.executeTool(params.Name, params.Arguments)
	if err != nil {
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      id,
			Result: map[string]interface{}{
				"isError": true,
				"content": []map[string]interface{}{
					{"type": "text", "text": err.Error()},
				},
			},
		}
	}

	payloadJSON, _ := json.MarshalIndent(result, "", "  ")
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]interface{}{
			"isError": false,
			"content": []map[string]interface{}{
				{"type": "text", "text": string(payloadJSON)},
			},
			"structuredContent": result,
		},
	}
}

func (s *Server) executeTool(name string, rawArgs json.RawMessage) (interface{}, error) {
	switch name {
	case "nginx_health":
		running, pid := s.exec.CheckStatus()
		return map[string]interface{}{"running": running, "pid": pid}, nil

	case "nginx_system_info":
		build := s.exec.GetBuildInfo()
		sites, _ := s.mgr.ListSites()
		certs, _ := s.acme.ListCerts()
		enabledCount, sslCount := 0, 0
		for _, site := range sites {
			if site.Enabled {
				enabledCount++
			}
			if site.HasSSL {
				sslCount++
			}
		}
		_, readOnly, _ := s.runtimeState()
		return map[string]interface{}{
			"nginx": build,
			"summary": map[string]interface{}{
				"total_sites":   len(sites),
				"enabled_sites": enabledCount,
				"ssl_sites":     sslCount,
				"total_certs":   len(certs),
			},
			"mcp_read_only": readOnly,
		}, nil

	case "list_sites":
		sites, err := s.mgr.ListSites()
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"sites": sites}, nil

	case "get_site_config":
		var args struct {
			Domain string `json:"domain"`
		}
		if err := decodeToolArgs(rawArgs, &args); err != nil {
			return nil, err
		}
		content, enabled, err := s.mgr.ReadSite(args.Domain)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"domain": args.Domain, "enabled": enabled, "content": content}, nil

	case "get_main_config":
		content, err := s.mgr.ReadMainConfig()
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"content": content}, nil

	case "list_certs":
		certs, err := s.acme.ListCerts()
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"certs": certs}, nil

	case "test_site_config":
		var args struct {
			Domain  string `json:"domain"`
			Content string `json:"content"`
		}
		if err := decodeToolArgs(rawArgs, &args); err != nil {
			return nil, err
		}
		out, err := s.mgr.TestSiteContent(args.Domain, args.Content)
		if err != nil {
			return nil, fmt.Errorf("%v\n%s", err, out)
		}
		return map[string]interface{}{"ok": true, "output": out}, nil

	case "save_site_config":
		var args struct {
			Domain  string `json:"domain"`
			Content string `json:"content"`
			Reload  bool   `json:"reload"`
		}
		if err := decodeToolArgs(rawArgs, &args); err != nil {
			return nil, err
		}
		out, err := s.mgr.SaveSite(args.Domain, args.Content)
		if err != nil {
			return nil, fmt.Errorf("%v\n%s", err, out)
		}
		resp := map[string]interface{}{"saved": true, "domain": args.Domain, "test_output": out}
		if args.Reload {
			relOut, relErr := s.exec.Reload()
			if relErr != nil {
				return nil, fmt.Errorf("配置已保存，但热重载失败: %v\n%s", relErr, relOut)
			}
			resp["reloaded"] = true
			resp["reload_output"] = relOut
		}
		return resp, nil

	case "toggle_site":
		var args struct {
			Domain  string `json:"domain"`
			Enabled bool   `json:"enabled"`
			Reload  bool   `json:"reload"`
		}
		if err := decodeToolArgs(rawArgs, &args); err != nil {
			return nil, err
		}
		out, err := s.mgr.ToggleSite(args.Domain, args.Enabled)
		if err != nil {
			return nil, err
		}
		resp := map[string]interface{}{"domain": args.Domain, "enabled": args.Enabled, "output": out}
		if args.Reload {
			relOut, relErr := s.exec.Reload()
			if relErr != nil {
				return nil, fmt.Errorf("状态已切换，但热重载失败: %v\n%s", relErr, relOut)
			}
			resp["reloaded"] = true
			resp["reload_output"] = relOut
		}
		return resp, nil

	case "delete_site":
		var args struct {
			Domain string `json:"domain"`
			Reload bool   `json:"reload"`
		}
		if err := decodeToolArgs(rawArgs, &args); err != nil {
			return nil, err
		}
		if err := s.mgr.DeleteSite(args.Domain); err != nil {
			return nil, err
		}
		resp := map[string]interface{}{"deleted": true, "domain": args.Domain}
		if args.Reload {
			relOut, relErr := s.exec.Reload()
			if relErr != nil {
				return nil, fmt.Errorf("站点已删除，但热重载失败: %v\n%s", relErr, relOut)
			}
			resp["reloaded"] = true
			resp["reload_output"] = relOut
		}
		return resp, nil

	case "save_main_config":
		var args struct {
			Content string `json:"content"`
			Reload  bool   `json:"reload"`
		}
		if err := decodeToolArgs(rawArgs, &args); err != nil {
			return nil, err
		}
		out, err := s.mgr.SaveMainConfig(args.Content)
		if err != nil {
			return nil, fmt.Errorf("%v\n%s", err, out)
		}
		resp := map[string]interface{}{"saved": true, "test_output": out}
		if args.Reload {
			relOut, relErr := s.exec.Reload()
			if relErr != nil {
				return nil, fmt.Errorf("主配置已保存，但热重载失败: %v\n%s", relErr, relOut)
			}
			resp["reloaded"] = true
			resp["reload_output"] = relOut
		}
		return resp, nil

	case "reload_nginx":
		out, err := s.exec.Reload()
		if err != nil {
			return nil, fmt.Errorf("%v\n%s", err, out)
		}
		return map[string]interface{}{"reloaded": true, "output": out}, nil

	case "issue_ssl_cert":
		var args struct {
			Domain     string            `json:"domain"`
			Type       string            `json:"type"`
			CAServer   string            `json:"ca_server"`
			Provider   string            `json:"provider"`
			IsWildcard bool              `json:"is_wildcard"`
			EnvParams  map[string]string `json:"env_params"`
		}
		if err := decodeToolArgs(rawArgs, &args); err != nil {
			return nil, err
		}
		if err := nginx.ValidateDomain(args.Domain); err != nil {
			return nil, err
		}
		var err error
		if args.Type == "dns" {
			err = s.acme.IssueCertDNS(args.Domain, args.IsWildcard, args.Provider, args.CAServer, args.EnvParams)
		} else {
			err = s.acme.IssueCert(args.Domain, args.CAServer)
		}
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"issued": true, "domain": args.Domain}, nil

	default:
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
}

func (s *Server) handleResourceRead(id json.RawMessage, uri string) rpcResponse {
	switch {
	case uri == "nginx://system/info":
		info, _ := s.executeTool("nginx_system_info", nil)
		raw, _ := json.MarshalIndent(info, "", "  ")
		return resourceTextResponse(id, uri, "application/json", string(raw))

	case uri == "nginx://config/main":
		content, err := s.mgr.ReadMainConfig()
		if err != nil {
			return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32002, Message: err.Error()}}
		}
		return resourceTextResponse(id, uri, "text/plain", content)

	case uri == "nginx://sites":
		sites, err := s.mgr.ListSites()
		if err != nil {
			return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32002, Message: err.Error()}}
		}
		raw, _ := json.MarshalIndent(sites, "", "  ")
		return resourceTextResponse(id, uri, "application/json", string(raw))

	case uri == "nginx://certs":
		certs, err := s.acme.ListCerts()
		if err != nil {
			return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32002, Message: err.Error()}}
		}
		raw, _ := json.MarshalIndent(certs, "", "  ")
		return resourceTextResponse(id, uri, "application/json", string(raw))

	case strings.HasPrefix(uri, "nginx://sites/"):
		domain := strings.TrimPrefix(uri, "nginx://sites/")
		content, _, err := s.mgr.ReadSite(domain)
		if err != nil {
			return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -32002, Message: err.Error()}}
		}
		return resourceTextResponse(id, uri, "text/plain", content)

	default:
		return rpcResponse{
			JSONRPC: "2.0",
			ID:      id,
			Error:   &rpcError{Code: -32002, Message: fmt.Sprintf("Resource not found: %s", uri)},
		}
	}
}

func resourceTextResponse(id json.RawMessage, uri, mimeType, text string) rpcResponse {
	return rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result: map[string]interface{}{
			"contents": []map[string]interface{}{
				{
					"uri":      uri,
					"mimeType": mimeType,
					"text":     text,
				},
			},
		},
	}
}

func decodeToolArgs(raw json.RawMessage, dst interface{}) error {
	if len(raw) == 0 || string(raw) == "null" {
		return errors.New("tool arguments are required")
	}
	return json.Unmarshal(raw, dst)
}

func writeRPC(w http.ResponseWriter, status int, payload rpcResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"code":  status,
		"error": msg,
	})
}
