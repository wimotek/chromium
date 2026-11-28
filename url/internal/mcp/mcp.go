package mcp

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/wimotek/url/internal/audit"
	"github.com/wimotek/url/internal/cache"
	"github.com/wimotek/url/internal/db"
)

type Server struct {
	store *db.Store
	cache cache.Store
	audit *audit.Logger
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

func NewServer(store *db.Store, cacheLayer cache.Store, auditLogger *audit.Logger) *Server {
	return &Server{store: store, cache: cacheLayer, audit: auditLogger}
}

func (s *Server) authenticateRequest(r *http.Request) (actor string, ok bool) {
	conn := s.store.DB()
	if conn == nil {
		return "", false
	}
	authz := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authz), "bearer ") {
		rawKey := strings.TrimSpace(authz[7:])
		if rawKey != "" {
			sum := sha256.Sum256([]byte(rawKey))
			keyHash := hex.EncodeToString(sum[:])
			var keyID, keyName string
			err := conn.QueryRow(
				`SELECT id, name FROM api_keys WHERE key_hash = ? AND revoked = FALSE LIMIT 1`,
				keyHash,
			).Scan(&keyID, &keyName)
			if err == nil {
				go func(id string) {
					_ = s.store.WithWriteLock(func(c *sql.DB) error {
						_, e := c.Exec(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`, id)
						return e
					})
				}(keyID)
				return "api_key:" + keyName, true
			}
		}
	}
	return "", false
}

// ServeWithActor allows authenticated dashboard sessions to invoke MCP test calls directly.
func (s *Server) ServeWithActor(w http.ResponseWriter, r *http.Request, preAuthActor string) {
	if r.Method != http.MethodPost {
		http.Error(w, "MCP endpoint expects JSON-RPC POST", http.StatusMethodNotAllowed)
		return
	}

	actor := preAuthActor
	if actor == "" {
		var ok bool
		actor, ok = s.authenticateRequest(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, rpcResponse{
				JSONRPC: "2.0",
				Error:   map[string]any{"code": -32001, "message": "Valid Bearer API Key (wmk_live_...) is required"},
			})
			return
		}
	}

	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, rpcResponse{
			JSONRPC: "2.0",
			Error:   map[string]any{"code": -32700, "message": "Invalid JSON-RPC payload"},
		})
		return
	}

	switch req.Method {
	case "initialize":
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": "2024-11-05",
				"serverInfo":      map[string]string{"name": "wimotek-url-mcp", "version": "1.1.0"},
				"capabilities":    map[string]any{"tools": map[string]any{}},
			},
		})
	case "tools/list":
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"tools": []map[string]any{
					{
						"name":        "create_short_url",
						"description": "Create a new short link with optional custom slug, domain, and SEO title",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"target_url": map[string]string{"type": "string"},
								"slug":       map[string]string{"type": "string"},
								"domain":     map[string]string{"type": "string"},
								"title":      map[string]string{"type": "string"},
							},
							"required": []string{"target_url"},
						},
					},
					{
						"name":        "list_urls",
						"description": "List active short links with click counters",
						"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
					},
					{
						"name":        "get_url_stats",
						"description": "Fetch click analytics for a given slug",
						"inputSchema": map[string]any{
							"type":       "object",
							"properties": map[string]any{"slug": map[string]string{"type": "string"}},
							"required":   []string{"slug"},
						},
					},
				},
			},
		})
	case "tools/call":
		s.handleToolCall(w, r, req, actor)
	default:
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   map[string]any{"code": -32601, "message": "Method not found"},
		})
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.ServeWithActor(w, r, "")
}

func (s *Server) handleToolCall(w http.ResponseWriter, r *http.Request, req rpcRequest, actor string) {
	var call struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &call); err != nil {
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   map[string]any{"code": -32602, "message": "Invalid tool parameters"},
		})
		return
	}

	conn := s.store.DB()
	if conn == nil {
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   map[string]any{"code": -32000, "message": "Database not initialized"},
		})
		return
	}

	switch call.Name {
	case "create_short_url":
		target, _ := call.Arguments["target_url"].(string)
		u, err := url.Parse(strings.TrimSpace(target))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			writeJSON(w, http.StatusOK, rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   map[string]any{"code": -32602, "message": "Valid http/https target_url is required"},
			})
			return
		}
		slug, _ := call.Arguments["slug"].(string)
		slug = strings.Trim(strings.TrimSpace(slug), "/")
		if slug == "" {
			b := make([]byte, 3)
			_, _ = rand.Read(b)
			slug = hex.EncodeToString(b)
		}
		dom, _ := call.Arguments["domain"].(string)
		dom = strings.TrimSpace(dom)
		if dom == "" {
			_ = conn.QueryRow(`SELECT host FROM domains WHERE is_default = TRUE LIMIT 1`).Scan(&dom)
		}
		if dom == "" {
			dom = r.Host
		}
		title, _ := call.Arguments["title"].(string)
		idBytes := make([]byte, 8)
		_, _ = rand.Read(idBytes)
		id := "lnk_" + hex.EncodeToString(idBytes)

		err = s.store.WithWriteLock(func(c *sql.DB) error {
			_, err := c.Exec(
				`INSERT INTO short_links (id, slug, domain, target_url, title, seo_description, redirect_code, owner_id) VALUES (?, ?, ?, ?, ?, '', 302, 'usr_super_admin')`,
				id, slug, dom, u.String(), title,
			)
			return err
		})
		if err != nil {
			writeJSON(w, http.StatusOK, rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   map[string]any{"code": -32000, "message": err.Error()},
			})
			return
		}
		s.audit.Record(actor, "mcp.create_short_url", "/"+slug, r.RemoteAddr, "API", "success", u.String())
		resJSON, _ := json.Marshal(map[string]any{
			"id":         id,
			"domain":     dom,
			"slug":       slug,
			"short_url":  "https://" + dom + "/" + slug,
			"target_url": u.String(),
		})
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]string{{"type": "text", "text": string(resJSON)}},
			},
		})

	case "list_urls":
		rows, err := conn.Query(`SELECT id, slug, domain, target_url, title, redirect_code, clicks, unique_clicks, enabled FROM short_links ORDER BY created_at DESC LIMIT 50`)
		if err != nil {
			writeJSON(w, http.StatusOK, rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   map[string]any{"code": -32000, "message": err.Error()},
			})
			return
		}
		defer rows.Close()
		items := make([]map[string]any, 0)
		for rows.Next() {
			var id, slug, dom, target, title string
			var redir int
			var clicks, uv int64
			var enabled bool
			if rows.Scan(&id, &slug, &dom, &target, &title, &redir, &clicks, &uv, &enabled) == nil {
				items = append(items, map[string]any{
					"id":           id,
					"slug":         slug,
					"domain":       dom,
					"target_url":   target,
					"title":        title,
					"redirectCode": redir,
					"clicks":       clicks,
					"uniqueClicks": uv,
					"enabled":      enabled,
				})
			}
		}
		resJSON, _ := json.Marshal(map[string]any{"count": len(items), "links": items})
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]string{{"type": "text", "text": string(resJSON)}},
			},
		})

	case "get_url_stats":
		slug, _ := call.Arguments["slug"].(string)
		slug = strings.Trim(strings.TrimSpace(slug), "/")
		if slug == "" {
			writeJSON(w, http.StatusOK, rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   map[string]any{"code": -32602, "message": "slug is required"},
			})
			return
		}
		var id, dom, target, title string
		var redir int
		var clicks, uv int64
		err := conn.QueryRow(
			`SELECT id, domain, target_url, title, redirect_code, clicks, unique_clicks FROM short_links WHERE slug = ? LIMIT 1`,
			slug,
		).Scan(&id, &dom, &target, &title, &redir, &clicks, &uv)
		if err != nil {
			writeJSON(w, http.StatusOK, rpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   map[string]any{"code": -32004, "message": "short link not found"},
			})
			return
		}
		resJSON, _ := json.Marshal(map[string]any{
			"id":           id,
			"slug":         slug,
			"domain":       dom,
			"target_url":   target,
			"title":        title,
			"redirectCode": redir,
			"clicks":       clicks,
			"uniqueClicks": uv,
		})
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]string{{"type": "text", "text": string(resJSON)}},
			},
		})

	default:
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   map[string]any{"code": -32601, "message": "Unknown MCP tool: " + call.Name},
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
