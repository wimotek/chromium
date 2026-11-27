package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type adminApiToken struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	TokenHash  string   `json:"tokenHash"`
	Scopes     []string `json:"scopes"`
	CreatedBy  string   `json:"createdBy"`
	CreatedAt  string   `json:"createdAt"`
	ExpiresAt  string   `json:"expiresAt,omitempty"`
	LastUsedAt string   `json:"lastUsedAt,omitempty"`
	RevokedAt  string   `json:"revokedAt,omitempty"`
}

type adminApiTokenDTO struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Prefix     string   `json:"prefix"`
	Scopes     []string `json:"scopes"`
	CreatedBy  string   `json:"createdBy"`
	CreatedAt  string   `json:"createdAt"`
	ExpiresAt  string   `json:"expiresAt,omitempty"`
	LastUsedAt string   `json:"lastUsedAt,omitempty"`
	Active     bool     `json:"active"`
}

func sha256Hex(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func generateAdminPAT() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "wmk_pat_" + base64.RawURLEncoding.EncodeToString(buf), nil
}

func (s *appServer) loadAdminTokensLocked(ctx context.Context) {
	if s.repo == nil {
		return
	}
	raw, ok, err := s.repo.GetSetting(ctx, "admin_api_tokens")
	if err != nil || !ok || raw == "" {
		return
	}
	var list []adminApiToken
	if json.Unmarshal([]byte(raw), &list) == nil {
		s.adminTokens = list
	}
}

func (s *appServer) persistAdminTokensLocked() {
	if s.repo == nil {
		return
	}
	if raw, err := json.Marshal(s.adminTokens); err == nil {
		_ = s.repo.SetSetting(context.Background(), "admin_api_tokens", string(raw))
	}
}

func isTokenActive(t adminApiToken, now time.Time) bool {
	if t.RevokedAt != "" {
		return false
	}
	if t.ExpiresAt != "" {
		if exp, err := time.Parse(time.RFC3339, t.ExpiresAt); err == nil && now.After(exp) {
			return false
		}
	}
	return true
}

func (s *appServer) serializeAdminTokensLocked() []adminApiTokenDTO {
	now := time.Now().UTC()
	out := make([]adminApiTokenDTO, 0, len(s.adminTokens))
	for _, t := range s.adminTokens {
		if t.RevokedAt != "" {
			continue
		}
		out = append(out, adminApiTokenDTO{
			ID:         t.ID,
			Name:       t.Name,
			Prefix:     t.Prefix,
			Scopes:     t.Scopes,
			CreatedBy:  t.CreatedBy,
			CreatedAt:  t.CreatedAt,
			ExpiresAt:  t.ExpiresAt,
			LastUsedAt: t.LastUsedAt,
			Active:     isTokenActive(t, now),
		})
	}
	return out
}

// verifyAdminAPITokenLocked validates a wmk_pat_* personal access token using SHA-256 + constant-time comparison.
func (s *appServer) verifyAdminAPITokenLocked(rawTok string) (authUser, bool) {
	if !strings.HasPrefix(rawTok, "wmk_pat_") || len(rawTok) < 24 {
		return authUser{}, false
	}
	candidateHash := sha256Hex(rawTok)
	now := time.Now().UTC()
	matchedIdx := -1
	for i := range s.adminTokens {
		if subtle.ConstantTimeCompare([]byte(s.adminTokens[i].TokenHash), []byte(candidateHash)) == 1 {
			matchedIdx = i
			break
		}
	}
	if matchedIdx == -1 || !isTokenActive(s.adminTokens[matchedIdx], now) {
		return authUser{}, false
	}

	s.adminTokens[matchedIdx].LastUsedAt = now.Format(time.RFC3339)
	s.persistAdminTokensLocked()

	// Resolve active super_admin user so account ban checks remain enforced.
	for _, u := range s.users {
		if u.Role == "super_admin" && (s.adminTokens[matchedIdx].CreatedBy == "" || strings.EqualFold(u.Email, s.adminTokens[matchedIdx].CreatedBy)) {
			if u.Status != "active" {
				return authUser{}, false
			}
			return authUser{
				Sub:      u.ID,
				Email:    u.Email,
				Name:     u.DisplayName,
				Role:     u.Role,
				Provider: "api_token",
			}, true
		}
	}
	for _, u := range s.users {
		if u.Role == "super_admin" && u.Status == "active" {
			return authUser{
				Sub:      u.ID,
				Email:    u.Email,
				Name:     u.DisplayName,
				Role:     u.Role,
				Provider: "api_token",
			}, true
		}
	}
	return authUser{
		Sub:      "admin_api_token",
		Email:    defaultStr(s.cfgMgr.Get().AdminEmail, "admin@wimotek.dev"),
		Name:     "Admin API Token",
		Role:     "super_admin",
		Provider: "api_token",
	}, true
}

// ============================================================================
// Admin API Token Management Endpoints
// ============================================================================

func (s *appServer) handleListAdminTokens(w http.ResponseWriter, r *http.Request) {
	issuer := strings.TrimRight(s.getIssuer(r), "/")
	s.mu.RLock()
	tokens := s.serializeAdminTokensLocked()
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"tokens":      tokens,
		"mcpEndpoint": issuer + "/api/mcp",
	})
}

func (s *appServer) handleCreateAdminToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name          string   `json:"name"`
		ExpiresInDays int      `json:"expiresInDays"`
		Scopes        []string `json:"scopes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json", "message": "Invalid JSON payload"})
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_name", "message": "Token name is required"})
		return
	}
	if len(name) > 80 {
		name = name[:80]
	}

	expiresDays := body.ExpiresInDays
	if expiresDays < 0 {
		expiresDays = 0
	}
	if expiresDays > 3650 {
		expiresDays = 3650
	}

	scopes := body.Scopes
	if len(scopes) == 0 {
		scopes = []string{"admin:api", "mcp:tools"}
	}

	plainToken, err := generateAdminPAT()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "token_generation_failed"})
		return
	}

	me, _ := s.currentSessionUser(r)
	createdBy := me.Email
	if createdBy == "" {
		createdBy = defaultStr(s.cfgMgr.Get().AdminEmail, "admin@wimotek.dev")
	}

	now := time.Now().UTC()
	expiresAt := ""
	if expiresDays > 0 {
		expiresAt = now.Add(time.Duration(expiresDays) * 24 * time.Hour).Format(time.RFC3339)
	}

	prefix := plainToken
	if len(prefix) > 16 {
		prefix = prefix[:16] + "..."
	}

	rec := adminApiToken{
		ID:        "tok_" + randomHex(6),
		Name:      name,
		Prefix:    prefix,
		TokenHash: sha256Hex(plainToken),
		Scopes:    scopes,
		CreatedBy: createdBy,
		CreatedAt: now.Format(time.RFC3339),
		ExpiresAt: expiresAt,
	}

	s.mu.Lock()
	s.adminTokens = append([]adminApiToken{rec}, s.adminTokens...)
	s.persistAdminTokensLocked()
	tokens := s.serializeAdminTokensLocked()
	s.mu.Unlock()

	issuer := strings.TrimRight(s.getIssuer(r), "/")
	writeJSON(w, http.StatusCreated, map[string]any{
		"token": plainToken,
		"record": adminApiTokenDTO{
			ID:        rec.ID,
			Name:      rec.Name,
			Prefix:    rec.Prefix,
			Scopes:    rec.Scopes,
			CreatedBy: rec.CreatedBy,
			CreatedAt: rec.CreatedAt,
			ExpiresAt: rec.ExpiresAt,
			Active:    true,
		},
		"tokens":      tokens,
		"mcpEndpoint": issuer + "/api/mcp",
	})
}

func (s *appServer) handleDeleteAdminToken(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	s.mu.Lock()
	found := false
	next := make([]adminApiToken, 0, len(s.adminTokens))
	for _, t := range s.adminTokens {
		if t.ID == id {
			found = true
			continue
		}
		next = append(next, t)
	}
	if !found {
		s.mu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "token_not_found"})
		return
	}
	s.adminTokens = next
	s.persistAdminTokensLocked()
	tokens := s.serializeAdminTokensLocked()
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tokens": tokens})
}

// ============================================================================
// Model Context Protocol (MCP) Streamable HTTP JSON-RPC 2.0 Endpoint (/api/mcp)
// ============================================================================

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

func mcpToolsCatalog() []map[string]any {
	return []map[string]any{
		{
			"name":        "list_applications",
			"description": "List all registered OIDC client applications (client_id, name, redirect URIs, scopes, lock status). Client secrets are redacted.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "get_login_theme",
			"description": "Retrieve the current hosted login page theme configuration for a specific OIDC client_id.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"clientId": map[string]any{"type": "string", "description": "Target application client_id"},
				},
				"required": []string{"clientId"},
			},
		},
		{
			"name":        "update_login_theme",
			"description": "Update and persist the hosted login page theme for an unlocked OIDC application.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"clientId": map[string]any{"type": "string", "description": "Target application client_id"},
					"theme":    map[string]any{"type": "object", "description": "LoginThemeConfig JSON object (layout, surfaceMode, brandTitle, primaryColor, backgroundColor, cardColor, textColor, borderRadius, fontFamily, customCss, etc.)"},
				},
				"required": []string{"clientId", "theme"},
			},
		},
		{
			"name":        "list_connectors",
			"description": "List all configured social/OIDC upstream identity connectors and their enabled status (secrets masked).",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "get_auth_policy",
			"description": "Read the global authentication methods and risk-control security policy.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "list_users",
			"description": "List identity directory users and their enabled authentication factors (no password hashes or TOTP secrets).",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
	}
}

func (s *appServer) handleMCPInfo(w http.ResponseWriter, r *http.Request) {
	issuer := strings.TrimRight(s.getIssuer(r), "/")
	writeJSON(w, http.StatusOK, map[string]any{
		"name":            "wimotek-oauth-mcp",
		"version":         "1.0.0",
		"protocolVersion": "2024-11-05",
		"transport":       "streamable-http",
		"endpoint":        issuer + "/api/mcp",
		"tools":           mcpToolsCatalog(),
	})
}

func mcpJSONRPCResult(w http.ResponseWriter, id any, result any) {
	writeJSON(w, http.StatusOK, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	})
}

func mcpJSONRPCError(w http.ResponseWriter, id any, code int, message string) {
	writeJSON(w, http.StatusOK, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

func mcpToolTextResult(payload any, isError bool) map[string]any {
	raw, _ := json.MarshalIndent(payload, "", "  ")
	return map[string]any{
		"isError": isError,
		"content": []map[string]any{
			{
				"type": "text",
				"text": string(raw),
			},
		},
	}
}

func (s *appServer) handleMCPRequest(w http.ResponseWriter, r *http.Request) {
	var req mcpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		mcpJSONRPCError(w, nil, -32700, "Parse error: invalid JSON-RPC payload")
		return
	}

	switch req.Method {
	case "initialize":
		mcpJSONRPCResult(w, req.ID, map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]any{
				"tools": map[string]any{"listChanged": false},
			},
			"serverInfo": map[string]any{
				"name":    "wimotek-oauth-mcp",
				"version": "1.0.0",
			},
		})
		return

	case "notifications/initialized":
		w.WriteHeader(http.StatusAccepted)
		return

	case "ping":
		mcpJSONRPCResult(w, req.ID, map[string]any{})
		return

	case "tools/list":
		mcpJSONRPCResult(w, req.ID, map[string]any{
			"tools": mcpToolsCatalog(),
		})
		return

	case "tools/call":
		var callParams struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &callParams); err != nil || callParams.Name == "" {
			mcpJSONRPCError(w, req.ID, -32602, "Invalid params: tool name is required")
			return
		}
		res, isErr := s.executeMCPTool(callParams.Name, callParams.Arguments)
		mcpJSONRPCResult(w, req.ID, mcpToolTextResult(res, isErr))
		return

	default:
		mcpJSONRPCError(w, req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

func (s *appServer) executeMCPTool(name string, rawArgs json.RawMessage) (any, bool) {
	switch name {
	case "list_applications":
		s.mu.RLock()
		defer s.mu.RUnlock()
		apps := make([]map[string]any, 0, len(s.apps))
		for _, a := range s.apps {
			apps = append(apps, map[string]any{
				"id":           a.ID,
				"name":         a.Name,
				"description":  a.Description,
				"clientId":     a.ClientID,
				"redirectUris": a.RedirectUris,
				"scopes":       a.Scopes,
				"locked":       a.Locked,
				"createdAt":    a.CreatedAt,
			})
		}
		return map[string]any{"applications": apps}, false

	case "get_login_theme":
		var args struct {
			ClientID string `json:"clientId"`
		}
		_ = json.Unmarshal(rawArgs, &args)
		key := strings.TrimSpace(args.ClientID)
		if key == "" {
			return map[string]any{"error": "clientId is required"}, true
		}
		s.mu.RLock()
		defer s.mu.RUnlock()
		for _, a := range s.apps {
			if a.ClientID == key || a.ID == key {
				theme := defaultLoginTheme(a.Name)
				if a.LoginTheme != nil {
					theme = normalizeLoginTheme(*a.LoginTheme, a.Name)
				}
				return map[string]any{"clientId": a.ClientID, "appName": a.Name, "locked": a.Locked, "theme": theme}, false
			}
		}
		return map[string]any{"error": "application_not_found"}, true

	case "update_login_theme":
		var args struct {
			ClientID string           `json:"clientId"`
			Theme    loginThemeConfig `json:"theme"`
		}
		if err := json.Unmarshal(rawArgs, &args); err != nil || strings.TrimSpace(args.ClientID) == "" {
			return map[string]any{"error": "clientId and theme object are required"}, true
		}
		key := strings.TrimSpace(args.ClientID)
		s.mu.Lock()
		defer s.mu.Unlock()
		for i := range s.apps {
			if s.apps[i].ClientID == key || s.apps[i].ID == key {
				if s.apps[i].Locked {
					return map[string]any{"error": "application_locked", "message": "This application is locked. Unlock it in Applications before updating its theme."}, true
				}
				normalized := normalizeLoginTheme(args.Theme, s.apps[i].Name)
				s.apps[i].LoginTheme = &normalized
				s.persistAppLocked(s.apps[i])
				return map[string]any{"ok": true, "clientId": s.apps[i].ClientID, "theme": normalized}, false
			}
		}
		return map[string]any{"error": "application_not_found"}, true

	case "list_connectors":
		s.mu.RLock()
		out := s.serializeConnectorsLocked()
		s.mu.RUnlock()
		return map[string]any{"connectors": out}, false

	case "get_auth_policy":
		s.mu.RLock()
		pol := s.policy
		s.mu.RUnlock()
		return map[string]any{"policy": pol}, false

	case "list_users":
		s.mu.RLock()
		defer s.mu.RUnlock()
		users := make([]map[string]any, 0, len(s.users))
		for _, u := range s.users {
			users = append(users, map[string]any{
				"id":             u.ID,
				"email":          u.Email,
				"displayName":    u.DisplayName,
				"role":           u.Role,
				"status":         u.Status,
				"totpEnabled":    u.TotpEnabled,
				"allowedMethods": s.effectiveUserMethodsLocked(u),
				"createdAt":      u.CreatedAt,
				"lastLoginAt":    u.LastLoginAt,
			})
		}
		return map[string]any{"users": users}, false

	default:
		return map[string]any{"error": fmt.Sprintf("unknown tool: %s", name)}, true
	}
}
