package providers

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type UserProfile struct {
	ProviderID    string `json:"provider_id"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	AvatarURL     string `json:"avatar_url"`
}

type Config struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Extra        map[string]string // e.g., tenant_id, team_id, key_id, wechat_mode (qr|mp), authorization_endpoint, token_endpoint, userinfo_endpoint
}

// ProviderAdapter is the extensible plugin interface.
type ProviderAdapter interface {
	ID() string
	BuildAuthURL(cfg Config, state string) (string, error)
	ExchangeCode(ctx context.Context, cfg Config, code string) (*UserProfile, error)
}

type Registry struct {
	adapters map[string]ProviderAdapter
}

func NewDefaultRegistry() *Registry {
	r := &Registry{adapters: make(map[string]ProviderAdapter)}
	r.Register(&MicrosoftAdapter{})
	r.Register(&AppleAdapter{})
	r.Register(&GoogleAdapter{})
	r.Register(&WeChatAdapter{})
	r.Register(&GitHubAdapter{})
	r.Register(&CustomOIDCAdapter{})
	return r
}

func (r *Registry) Register(a ProviderAdapter) { r.adapters[a.ID()] = a }
func (r *Registry) Get(id string) (ProviderAdapter, bool) {
	a, ok := r.adapters[id]
	return a, ok
}

var upstreamHTTPClient = &http.Client{Timeout: 12 * time.Second}

func decodeJWTPayloadClaims(rawJWT string) map[string]any {
	parts := strings.Split(strings.TrimSpace(rawJWT), ".")
	if len(parts) < 2 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil
	}
	return claims
}

func claimStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
}

func claimBool(m map[string]any, key string, fallback bool) bool {
	if v, ok := m[key]; ok {
		switch b := v.(type) {
		case bool:
			return b
		case string:
			return strings.EqualFold(b, "true")
		}
	}
	return fallback
}

func postFormJSON(ctx context.Context, endpoint string, form url.Values) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := upstreamHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 262144))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := claimStr(out, "error_description", "error", "message")
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d from %s", resp.StatusCode, endpoint)
		}
		return nil, errors.New(msg)
	}
	if out == nil {
		return nil, errors.New("upstream token endpoint returned non-JSON payload")
	}
	if errCode := claimStr(out, "error"); errCode != "" {
		desc := claimStr(out, "error_description")
		if desc != "" {
			return nil, fmt.Errorf("%s: %s", errCode, desc)
		}
		return nil, errors.New(errCode)
	}
	return out, nil
}

func getBearerJSON(ctx context.Context, endpoint, accessToken string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "wimotek-oauth")
	resp, err := upstreamHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 262144))
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("userinfo HTTP %d", resp.StatusCode)
	}
	return out, nil
}

// --- Microsoft (Entra ID) ---
type MicrosoftAdapter struct{}

func (m *MicrosoftAdapter) ID() string { return "microsoft" }
func (m *MicrosoftAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", errors.New("Microsoft Client ID is required")
	}
	tenant := strings.TrimSpace(cfg.Extra["tenant_id"])
	if tenant == "" {
		tenant = "common"
	}
	scopes := strings.TrimSpace(cfg.Extra["scopes"])
	if scopes == "" {
		scopes = "openid profile email User.Read"
	}
	q := url.Values{
		"client_id":     {cfg.ClientID},
		"response_type": {"code"},
		"redirect_uri":  {cfg.RedirectURI},
		"response_mode": {"query"},
		"scope":         {scopes},
		"state":         {state},
	}
	return fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/authorize?%s", url.PathEscape(tenant), q.Encode()), nil
}

func (m *MicrosoftAdapter) ExchangeCode(ctx context.Context, cfg Config, code string) (*UserProfile, error) {
	if strings.TrimSpace(cfg.ClientID) == "" || strings.TrimSpace(cfg.ClientSecret) == "" {
		return nil, errors.New("configure Microsoft Entra ID client_id & client_secret to execute live exchange")
	}
	tenant := strings.TrimSpace(cfg.Extra["tenant_id"])
	if tenant == "" {
		tenant = "common"
	}
	scopes := strings.TrimSpace(cfg.Extra["scopes"])
	if scopes == "" {
		scopes = "openid profile email User.Read"
	}
	tokenURL := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", url.PathEscape(tenant))
	tokData, err := postFormJSON(ctx, tokenURL, url.Values{
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {cfg.RedirectURI},
		"scope":         {scopes},
	})
	if err != nil {
		return nil, fmt.Errorf("microsoft token exchange failed: %w", err)
	}

	profile := &UserProfile{EmailVerified: true}
	if accessToken := claimStr(tokData, "access_token"); accessToken != "" {
		if me, meErr := getBearerJSON(ctx, "https://graph.microsoft.com/v1.0/me", accessToken); meErr == nil {
			profile.ProviderID = claimStr(me, "id")
			profile.Email = claimStr(me, "mail", "userPrincipalName")
			profile.Name = claimStr(me, "displayName", "givenName")
		}
	}
	if idToken := claimStr(tokData, "id_token"); idToken != "" {
		if claims := decodeJWTPayloadClaims(idToken); claims != nil {
			if profile.ProviderID == "" {
				profile.ProviderID = claimStr(claims, "oid", "sub")
			}
			if profile.Email == "" {
				profile.Email = claimStr(claims, "email", "preferred_username", "upn")
			}
			if profile.Name == "" {
				profile.Name = claimStr(claims, "name")
			}
		}
	}
	if profile.ProviderID == "" {
		return nil, errors.New("microsoft did not return a user identifier (oid/sub/id)")
	}
	if profile.Email == "" {
		profile.Email = profile.ProviderID + "@microsoft.local"
		profile.EmailVerified = false
	}
	if profile.Name == "" {
		profile.Name = profile.Email
	}
	return profile, nil
}

// --- Apple (Team ID / Key ID / .p8 Private Key + form_post) ---
type AppleAdapter struct{}

func (a *AppleAdapter) ID() string { return "apple" }
func (a *AppleAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", errors.New("Apple Service ID (client_id) is required")
	}
	q := url.Values{
		"client_id":     {cfg.ClientID},
		"redirect_uri":  {cfg.RedirectURI},
		"response_type": {"code"},
		"response_mode": {"form_post"},
		"scope":         {"name email"},
		"state":         {state},
	}
	return "https://appleid.apple.com/auth/authorize?" + q.Encode(), nil
}
func (a *AppleAdapter) GenerateClientSecret(teamID, keyID, clientID, p8PEM string) (string, error) {
	block, _ := pem.Decode([]byte(p8PEM))
	if block == nil {
		return "", errors.New("invalid Apple .p8 PEM private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return "", err
	}
	ecKey, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return "", errors.New("Apple .p8 key must be ECDSA P-256")
	}
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": teamID,
		"iat": now.Unix(),
		"exp": now.Add(5 * time.Minute).Unix(),
		"aud": "https://appleid.apple.com",
		"sub": clientID,
	})
	tok.Header["kid"] = keyID
	return tok.SignedString(ecKey)
}
func (a *AppleAdapter) ExchangeCode(ctx context.Context, cfg Config, code string) (*UserProfile, error) {
	clientSecret := strings.TrimSpace(cfg.ClientSecret)
	if strings.Contains(clientSecret, "BEGIN PRIVATE KEY") {
		teamID := strings.TrimSpace(cfg.Extra["team_id"])
		keyID := strings.TrimSpace(cfg.Extra["key_id"])
		if teamID == "" || keyID == "" {
			return nil, errors.New("Apple Team ID and Key ID are required to sign the .p8 client secret")
		}
		var err error
		clientSecret, err = a.GenerateClientSecret(teamID, keyID, cfg.ClientID, clientSecret)
		if err != nil {
			return nil, err
		}
	}
	if cfg.ClientID == "" || clientSecret == "" {
		return nil, errors.New("configure Apple Service ID, Team ID, Key ID, and .p8 private key")
	}
	tokData, err := postFormJSON(ctx, "https://appleid.apple.com/auth/token", url.Values{
		"client_id":     {cfg.ClientID},
		"client_secret": {clientSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {cfg.RedirectURI},
	})
	if err != nil {
		return nil, fmt.Errorf("apple token exchange failed: %w", err)
	}
	claims := decodeJWTPayloadClaims(claimStr(tokData, "id_token"))
	if claims == nil {
		return nil, errors.New("apple token response missing id_token")
	}
	sub := claimStr(claims, "sub")
	email := claimStr(claims, "email")
	if sub == "" {
		return nil, errors.New("apple id_token missing sub")
	}
	verified := claimBool(claims, "email_verified", email != "")
	if email == "" {
		email = sub + "@appleid.local"
		verified = false
	}
	return &UserProfile{
		ProviderID:    sub,
		Email:         email,
		EmailVerified: verified,
		Name:          strings.Split(email, "@")[0],
	}, nil
}

// --- Google ---
type GoogleAdapter struct{}

func (g *GoogleAdapter) ID() string { return "google" }
func (g *GoogleAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", errors.New("Google Client ID is required")
	}
	q := url.Values{
		"client_id":     {cfg.ClientID},
		"redirect_uri":  {cfg.RedirectURI},
		"response_type": {"code"},
		"scope":         {"openid profile email"},
		"state":         {state},
	}
	return "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode(), nil
}
func (g *GoogleAdapter) ExchangeCode(ctx context.Context, cfg Config, code string) (*UserProfile, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, errors.New("configure Google OAuth client_id & client_secret to execute live exchange")
	}
	tokData, err := postFormJSON(ctx, "https://oauth2.googleapis.com/token", url.Values{
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"code":          {code},
		"redirect_uri":  {cfg.RedirectURI},
		"grant_type":    {"authorization_code"},
	})
	if err != nil {
		return nil, fmt.Errorf("google token exchange failed: %w", err)
	}
	profile := &UserProfile{}
	if accessToken := claimStr(tokData, "access_token"); accessToken != "" {
		if info, err := getBearerJSON(ctx, "https://openidconnect.googleapis.com/v1/userinfo", accessToken); err == nil {
			profile.ProviderID = claimStr(info, "sub")
			profile.Email = claimStr(info, "email")
			profile.EmailVerified = claimBool(info, "email_verified", true)
			profile.Name = claimStr(info, "name")
			profile.AvatarURL = claimStr(info, "picture")
		}
	}
	if profile.ProviderID == "" {
		if claims := decodeJWTPayloadClaims(claimStr(tokData, "id_token")); claims != nil {
			profile.ProviderID = claimStr(claims, "sub")
			profile.Email = claimStr(claims, "email")
			profile.EmailVerified = claimBool(claims, "email_verified", true)
			profile.Name = claimStr(claims, "name")
		}
	}
	if profile.ProviderID == "" {
		return nil, errors.New("google userinfo missing sub")
	}
	if profile.Name == "" {
		profile.Name = profile.Email
	}
	return profile, nil
}

// --- WeChat (Open Platform QR Login & Official Account MP OAuth) ---
type WeChatAdapter struct{}

func (w *WeChatAdapter) ID() string { return "wechat" }
func (w *WeChatAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", errors.New("WeChat AppID is required")
	}
	mode := cfg.Extra["wechat_mode"]
	if mode == "mp" {
		q := url.Values{
			"appid":         {cfg.ClientID},
			"redirect_uri":  {cfg.RedirectURI},
			"response_type": {"code"},
			"scope":         {"snsapi_userinfo"},
			"state":         {state},
		}
		return "https://open.weixin.qq.com/connect/oauth2/authorize?" + q.Encode() + "#wechat_redirect", nil
	}
	q := url.Values{
		"appid":         {cfg.ClientID},
		"redirect_uri":  {cfg.RedirectURI},
		"response_type": {"code"},
		"scope":         {"snsapi_login"},
		"state":         {state},
	}
	return "https://open.weixin.qq.com/connect/qrconnect?" + q.Encode() + "#wechat_redirect", nil
}
func (w *WeChatAdapter) ExchangeCode(ctx context.Context, cfg Config, code string) (*UserProfile, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, errors.New("configure WeChat AppID & AppSecret to execute live exchange")
	}
	tokURL := fmt.Sprintf(
		"https://api.weixin.qq.com/sns/oauth2/access_token?appid=%s&secret=%s&code=%s&grant_type=authorization_code",
		url.QueryEscape(cfg.ClientID), url.QueryEscape(cfg.ClientSecret), url.QueryEscape(code),
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := upstreamHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 131072))
	var tokData map[string]any
	if err := json.Unmarshal(raw, &tokData); err != nil {
		return nil, err
	}
	if errMsg := claimStr(tokData, "errmsg"); errMsg != "" {
		return nil, fmt.Errorf("wechat error: %s", errMsg)
	}
	openid := claimStr(tokData, "unionid", "openid")
	accessToken := claimStr(tokData, "access_token")
	if openid == "" || accessToken == "" {
		return nil, errors.New("wechat did not return openid/access_token")
	}
	profile := &UserProfile{
		ProviderID:    openid,
		Email:         openid + "@wechat.local",
		EmailVerified: false,
		Name:          "WeChat User",
	}
	infoURL := fmt.Sprintf("https://api.weixin.qq.com/sns/userinfo?access_token=%s&openid=%s&lang=zh_CN", url.QueryEscape(accessToken), url.QueryEscape(claimStr(tokData, "openid")))
	if infoReq, err := http.NewRequestWithContext(ctx, http.MethodGet, infoURL, nil); err == nil {
		if infoResp, err := upstreamHTTPClient.Do(infoReq); err == nil {
			defer infoResp.Body.Close()
			infoRaw, _ := io.ReadAll(io.LimitReader(infoResp.Body, 131072))
			var info map[string]any
			if json.Unmarshal(infoRaw, &info) == nil {
				if nick := claimStr(info, "nickname"); nick != "" {
					profile.Name = nick
				}
				profile.AvatarURL = claimStr(info, "headimgurl")
			}
		}
	}
	return profile, nil
}

// --- GitHub ---
type GitHubAdapter struct{}

func (g *GitHubAdapter) ID() string { return "github" }
func (g *GitHubAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	if strings.TrimSpace(cfg.ClientID) == "" {
		return "", errors.New("GitHub Client ID is required")
	}
	q := url.Values{
		"client_id":    {cfg.ClientID},
		"redirect_uri": {cfg.RedirectURI},
		"scope":        {"read:user user:email"},
		"state":        {state},
	}
	return "https://github.com/login/oauth/authorize?" + q.Encode(), nil
}
func (g *GitHubAdapter) ExchangeCode(ctx context.Context, cfg Config, code string) (*UserProfile, error) {
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, errors.New("configure GitHub OAuth App credentials to execute live exchange")
	}
	tokData, err := postFormJSON(ctx, "https://github.com/login/oauth/access_token", url.Values{
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"code":          {code},
		"redirect_uri":  {cfg.RedirectURI},
	})
	if err != nil {
		return nil, fmt.Errorf("github token exchange failed: %w", err)
	}
	accessToken := claimStr(tokData, "access_token")
	if accessToken == "" {
		return nil, errors.New("github did not return an access_token")
	}
	info, err := getBearerJSON(ctx, "https://api.github.com/user", accessToken)
	if err != nil {
		return nil, fmt.Errorf("github user lookup failed: %w", err)
	}
	idVal := fmt.Sprintf("%v", info["id"])
	if idVal == "" || idVal == "<nil>" {
		return nil, errors.New("github user response missing id")
	}
	email := claimStr(info, "email")
	emailVerified := email != ""
	if email == "" {
		// Fetch primary verified email from /user/emails
		if req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user/emails", nil); err == nil {
			req.Header.Set("Authorization", "Bearer "+accessToken)
			req.Header.Set("Accept", "application/json")
			req.Header.Set("User-Agent", "wimotek-oauth")
			if resp, err := upstreamHTTPClient.Do(req); err == nil {
				defer resp.Body.Close()
				raw, _ := io.ReadAll(io.LimitReader(resp.Body, 131072))
				var emails []struct {
					Email    string `json:"email"`
					Primary  bool   `json:"primary"`
					Verified bool   `json:"verified"`
				}
				if json.Unmarshal(raw, &emails) == nil {
					for _, e := range emails {
						if e.Primary && e.Verified && e.Email != "" {
							email = e.Email
							emailVerified = true
							break
						}
					}
					if email == "" {
						for _, e := range emails {
							if e.Verified && e.Email != "" {
								email = e.Email
								emailVerified = true
								break
							}
						}
					}
				}
			}
		}
	}
	if email == "" {
		email = idVal + "@users.noreply.github.com"
		emailVerified = false
	}
	name := claimStr(info, "name", "login")
	if name == "" {
		name = email
	}
	return &UserProfile{
		ProviderID:    idVal,
		Email:         email,
		EmailVerified: emailVerified,
		Name:          name,
		AvatarURL:     claimStr(info, "avatar_url"),
	}, nil
}

// --- Custom OIDC ---
type CustomOIDCAdapter struct{}

func (c *CustomOIDCAdapter) ID() string { return "custom_oidc" }
func (c *CustomOIDCAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	authEndpoint := strings.TrimSpace(cfg.Extra["authorization_endpoint"])
	if authEndpoint == "" {
		return "", errors.New("custom OIDC connector is missing authorization_endpoint (use OIDC Auto-Discovery)")
	}
	parsed, err := url.Parse(authEndpoint)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return "", errors.New("invalid authorization_endpoint URL")
	}
	scopes := strings.TrimSpace(cfg.Extra["scopes"])
	if scopes == "" {
		scopes = "openid profile email"
	}
	q := parsed.Query()
	q.Set("client_id", cfg.ClientID)
	q.Set("redirect_uri", cfg.RedirectURI)
	q.Set("response_type", "code")
	q.Set("scope", scopes)
	q.Set("state", state)
	parsed.RawQuery = q.Encode()
	return parsed.String(), nil
}
func (c *CustomOIDCAdapter) ExchangeCode(ctx context.Context, cfg Config, code string) (*UserProfile, error) {
	tokenEndpoint := strings.TrimSpace(cfg.Extra["token_endpoint"])
	if tokenEndpoint == "" {
		return nil, errors.New("custom OIDC connector is missing token_endpoint")
	}
	tokData, err := postFormJSON(ctx, tokenEndpoint, url.Values{
		"client_id":     {cfg.ClientID},
		"client_secret": {cfg.ClientSecret},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {cfg.RedirectURI},
	})
	if err != nil {
		return nil, fmt.Errorf("custom OIDC token exchange failed: %w", err)
	}
	profile := &UserProfile{}
	if userinfoEndpoint := strings.TrimSpace(cfg.Extra["userinfo_endpoint"]); userinfoEndpoint != "" {
		if accessToken := claimStr(tokData, "access_token"); accessToken != "" {
			if info, err := getBearerJSON(ctx, userinfoEndpoint, accessToken); err == nil {
				profile.ProviderID = claimStr(info, "sub", "id")
				profile.Email = claimStr(info, "email")
				profile.EmailVerified = claimBool(info, "email_verified", profile.Email != "")
				profile.Name = claimStr(info, "name", "preferred_username")
				profile.AvatarURL = claimStr(info, "picture")
			}
		}
	}
	if profile.ProviderID == "" {
		if claims := decodeJWTPayloadClaims(claimStr(tokData, "id_token")); claims != nil {
			profile.ProviderID = claimStr(claims, "sub")
			profile.Email = claimStr(claims, "email", "preferred_username")
			profile.EmailVerified = claimBool(claims, "email_verified", profile.Email != "")
			profile.Name = claimStr(claims, "name")
		}
	}
	if profile.ProviderID == "" {
		return nil, errors.New("custom OIDC response did not contain a subject identifier")
	}
	if profile.Email == "" {
		profile.Email = profile.ProviderID + "@oidc.local"
		profile.EmailVerified = false
	}
	if profile.Name == "" {
		profile.Name = profile.Email
	}
	return profile, nil
}
