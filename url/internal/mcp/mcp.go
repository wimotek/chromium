package mcp

import (
	"crypto/rand"
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

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "MCP endpoint expects JSON-RPC POST", http.StatusMethodNotAllowed)
		return
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
				"serverInfo":      map[string]string{"name": "wimotek-url-mcp", "version": "1.0.0"},
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
						"description": "Create a new short link with optional custom slug, expiration, and SEO title",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"target_url": map[string]string{"type": "string"},
								"slug":       map[string]string{"type": "string"},
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
		s.handleToolCall(w, r, req)
	default:
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   map[string]any{"code": -32601, "message": "Method not found"},
		})
	}
}

func (s *Server) handleToolCall(w http.ResponseWriter, r *http.Request, req rpcRequest) {
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
		title, _ := call.Arguments["title"].(string)
		idBytes := make([]byte, 8)
		_, _ = rand.Read(idBytes)
		id := "lnk_" + hex.EncodeToString(idBytes)

		if s.store.DB() != nil {
			err := s.store.WithWriteLock(func(conn *sql.DB) error {
				_, err := conn.Exec(
					`INSERT INTO short_links (id, slug, domain, target_url, title, seo_description, owner_id) VALUES (?, ?, ?, ?, ?, '', 'mcp-agent')`,
					id, slug, r.Host, u.String(), title,
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
		}
		s.audit.Record("mcp-agent", "create_short_url", "/"+slug, r.RemoteAddr, "API", "success", u.String())
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]string{{
					"type": "text",
					"text": `{"id":"` + id + `","slug":"` + slug + `","target_url":"` + u.String() + `"}`,
				}},
			},
		})
	default:
		writeJSON(w, http.StatusOK, rpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]string{{
					"type": "text",
					"text": `{"status":"ok","tool":"` + call.Name + `"}`,
				}},
			},
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
