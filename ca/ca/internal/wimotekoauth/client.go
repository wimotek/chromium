package wimotekoauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client is a zero-dependency OAuth 2.0 + OIDC PKCE (S256) client compatible with
// github.com/wimotek/oauth/sdk/go (offline single-file equivalent).
type Client struct {
	Issuer                string
	ClientID              string
	ClientSecret          string
	RedirectURI           string
	Scopes                []string
	AuthorizationEndpoint string
	TokenEndpoint         string
	UserinfoEndpoint      string
	HTTPClient            *http.Client

	mu        sync.RWMutex
	discovery *oidcEndpoints
}

// CallbackResult contains the exchanged OAuth tokens and normalized OIDC user claims.
type CallbackResult struct {
	AccessToken string         `json:"access_token"`
	IDToken     string         `json:"id_token,omitempty"`
	TokenType   string         `json:"token_type,omitempty"`
	ExpiresIn   int            `json:"expires_in,omitempty"`
	Scope       string         `json:"scope,omitempty"`
	User        map[string]any `json:"user"`
}

type oidcEndpoints struct {
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
}

// NormalizeIssuer trims whitespace and trailing slashes and validates http/https scheme.
func NormalizeIssuer(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errors.New("oauth issuer is required")
	}
	u, err := url.Parse(trimmed)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", errors.New("oauth issuer must be a valid http(s) URL")
	}
	return u.Scheme + "://" + u.Host + strings.TrimRight(u.Path, "/"), nil
}

// ComputeCodeChallengeS256 returns BASE64URL-ENCODE(SHA256(verifier)) per RFC 7636.
func ComputeCodeChallengeS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randomURLToken(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (c *Client) resolveEndpoints(ctx context.Context) oidcEndpoints {
	issuer, err := NormalizeIssuer(c.Issuer)
	if err != nil {
		issuer = strings.TrimRight(strings.TrimSpace(c.Issuer), "/")
	}
	fallback := oidcEndpoints{
		AuthorizationEndpoint: issuer + "/oauth/authorize",
		TokenEndpoint:         issuer + "/oauth/token",
		UserinfoEndpoint:      issuer + "/oauth/userinfo",
	}
	if c.AuthorizationEndpoint != "" && c.TokenEndpoint != "" && c.UserinfoEndpoint != "" {
		return oidcEndpoints{
			AuthorizationEndpoint: c.AuthorizationEndpoint,
			TokenEndpoint:         c.TokenEndpoint,
			UserinfoEndpoint:      c.UserinfoEndpoint,
		}
	}

	c.mu.RLock()
	cached := c.discovery
	c.mu.RUnlock()
	if cached != nil {
		return c.applyOverrides(*cached)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, issuer+"/.well-known/openid-configuration", nil)
	if err == nil {
		req.Header.Set("Accept", "application/json")
		resp, doErr := c.httpClient().Do(req)
		if doErr == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK && strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") {
				var doc oidcEndpoints
				if decErr := json.NewDecoder(io.LimitReader(resp.Body, 32*1024)).Decode(&doc); decErr == nil {
					if doc.AuthorizationEndpoint != "" {
						fallback.AuthorizationEndpoint = doc.AuthorizationEndpoint
					}
					if doc.TokenEndpoint != "" {
						fallback.TokenEndpoint = doc.TokenEndpoint
					}
					if doc.UserinfoEndpoint != "" {
						fallback.UserinfoEndpoint = doc.UserinfoEndpoint
					}
				}
			}
		}
	}

	c.mu.Lock()
	c.discovery = &fallback
	c.mu.Unlock()
	return c.applyOverrides(fallback)
}

func (c *Client) applyOverrides(ep oidcEndpoints) oidcEndpoints {
	if c.AuthorizationEndpoint != "" {
		ep.AuthorizationEndpoint = c.AuthorizationEndpoint
	}
	if c.TokenEndpoint != "" {
		ep.TokenEndpoint = c.TokenEndpoint
	}
	if c.UserinfoEndpoint != "" {
		ep.UserinfoEndpoint = c.UserinfoEndpoint
	}
	return ep
}

// BuildLoginURL generates a PKCE S256 authorization URL along with CSRF state and verifier.
func (c *Client) BuildLoginURL() (loginURL, state, verifier string) {
	return c.BuildLoginURLWithParams(context.Background(), "", "")
}

// BuildLoginURLWithParams generates a PKCE S256 authorization URL using optional caller-supplied state & verifier.
func (c *Client) BuildLoginURLWithParams(ctx context.Context, state, verifier string) (string, string, string) {
	if strings.TrimSpace(state) == "" {
		state = randomURLToken(24)
	}
	if strings.TrimSpace(verifier) == "" {
		verifier = randomURLToken(32)
	}
	ep := c.resolveEndpoints(ctx)
	scopes := c.Scopes
	if len(scopes) == 0 {
		scopes = []string{"openid", "profile", "email"}
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", c.ClientID)
	q.Set("redirect_uri", c.RedirectURI)
	q.Set("scope", strings.Join(scopes, " "))
	q.Set("state", state)
	q.Set("code_challenge", ComputeCodeChallengeS256(verifier))
	q.Set("code_challenge_method", "S256")
	return ep.AuthorizationEndpoint + "?" + q.Encode(), state, verifier
}

// HandleCallback verifies CSRF state (constant-time), exchanges code + PKCE verifier, and fetches userinfo.
func (c *Client) HandleCallback(ctx context.Context, code, state, expectedState, verifier string) (*CallbackResult, error) {
	if strings.TrimSpace(code) == "" {
		return nil, errors.New("missing authorization code")
	}
	if expectedState == "" || state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(expectedState)) != 1 {
		return nil, errors.New("invalid or mismatched OAuth state")
	}
	if strings.TrimSpace(verifier) == "" {
		return nil, errors.New("missing PKCE code_verifier")
	}

	ep := c.resolveEndpoints(ctx)
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", c.RedirectURI)
	form.Set("client_id", c.ClientID)
	form.Set("code_verifier", verifier)
	if c.ClientSecret != "" {
		form.Set("client_secret", c.ClientSecret)
	}

	tokenReq, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	tokenReq.Header.Set("Accept", "application/json")

	tokenResp, err := c.httpClient().Do(tokenReq)
	if err != nil {
		return nil, fmt.Errorf("token exchange request failed: %w", err)
	}
	defer tokenResp.Body.Close()

	var tokenData struct {
		AccessToken      string `json:"access_token"`
		IDToken          string `json:"id_token"`
		TokenType        string `json:"token_type"`
		ExpiresIn        int    `json:"expires_in"`
		Scope            string `json:"scope"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.NewDecoder(io.LimitReader(tokenResp.Body, 64*1024)).Decode(&tokenData); err != nil {
		return nil, fmt.Errorf("failed to parse token response: %w", err)
	}
	if tokenResp.StatusCode >= 400 || tokenData.AccessToken == "" {
		msg := tokenData.ErrorDescription
		if msg == "" {
			msg = tokenData.Error
		}
		if msg == "" {
			msg = fmt.Sprintf("token exchange HTTP %d", tokenResp.StatusCode)
		}
		return nil, errors.New(msg)
	}

	userClaims := map[string]any{}
	if tokenData.IDToken != "" {
		if claims := decodeJWTPayloadUnsafe(tokenData.IDToken); claims != nil {
			for k, v := range claims {
				userClaims[k] = v
			}
		}
	}

	if ep.UserinfoEndpoint != "" {
		uiReq, err := http.NewRequestWithContext(ctx, http.MethodGet, ep.UserinfoEndpoint, nil)
		if err == nil {
			uiReq.Header.Set("Authorization", "Bearer "+tokenData.AccessToken)
			uiReq.Header.Set("Accept", "application/json")
			if uiResp, uiErr := c.httpClient().Do(uiReq); uiErr == nil {
				defer uiResp.Body.Close()
				if uiResp.StatusCode == http.StatusOK {
					var fetched map[string]any
					if decErr := json.NewDecoder(io.LimitReader(uiResp.Body, 64*1024)).Decode(&fetched); decErr == nil {
						for k, v := range fetched {
							userClaims[k] = v
						}
					}
				}
			}
		}
	}

	return &CallbackResult{
		AccessToken: tokenData.AccessToken,
		IDToken:     tokenData.IDToken,
		TokenType:   tokenData.TokenType,
		ExpiresIn:   tokenData.ExpiresIn,
		Scope:       tokenData.Scope,
		User:        userClaims,
	}, nil
}

func decodeJWTPayloadUnsafe(jwt string) map[string]any {
	parts := strings.Split(jwt, ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}
