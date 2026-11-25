package providers

import (
	"context"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type UserProfile struct {
	ProviderID string `json:"provider_id"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	AvatarURL  string `json:"avatar_url"`
}

type Config struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Extra        map[string]string // e.g., tenant_id, team_id, key_id, wechat_mode (qr|mp)
}

// ProviderAdapter is the extensible plugin interface.
// Adding Feishu, DingTalk, Discord, or custom OIDC/SAML only requires registering a new implementation.
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
	return r
}

func (r *Registry) Register(a ProviderAdapter) { r.adapters[a.ID()] = a }
func (r *Registry) Get(id string) (ProviderAdapter, bool) {
	a, ok := r.adapters[id]
	return a, ok
}

// --- Microsoft (Entra ID) ---
type MicrosoftAdapter struct{}

func (m *MicrosoftAdapter) ID() string { return "microsoft" }
func (m *MicrosoftAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	tenant := cfg.Extra["tenant_id"]
	if tenant == "" {
		tenant = "common"
	}
	q := url.Values{
		"client_id":     {cfg.ClientID},
		"response_type": {"code"},
		"redirect_uri":  {cfg.RedirectURI},
		"scope":         {"openid profile email User.Read"},
		"state":         {state},
	}
	return fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/authorize?%s", tenant, q.Encode()), nil
}
func (m *MicrosoftAdapter) ExchangeCode(_ context.Context, _ Config, _ string) (*UserProfile, error) {
	return nil, errors.New("configure Microsoft Entra ID tenant & secret to execute live exchange")
}

// --- Apple (Team ID / Key ID / .p8 Private Key + form_post) ---
type AppleAdapter struct{}

func (a *AppleAdapter) ID() string { return "apple" }
func (a *AppleAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	q := url.Values{
		"client_id":     {cfg.ClientID},
		"redirect_uri":  {cfg.RedirectURI},
		"response_type": {"code id_token"},
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
func (a *AppleAdapter) ExchangeCode(_ context.Context, _ Config, _ string) (*UserProfile, error) {
	return nil, errors.New("configure Apple Team ID, Key ID, and .p8 private key to execute live exchange")
}

// --- Google ---
type GoogleAdapter struct{}

func (g *GoogleAdapter) ID() string { return "google" }
func (g *GoogleAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	q := url.Values{
		"client_id":     {cfg.ClientID},
		"redirect_uri":  {cfg.RedirectURI},
		"response_type": {"code"},
		"scope":         {"openid profile email"},
		"state":         {state},
	}
	return "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode(), nil
}
func (g *GoogleAdapter) ExchangeCode(_ context.Context, _ Config, _ string) (*UserProfile, error) {
	return nil, errors.New("configure Google OAuth client_id & client_secret to execute live exchange")
}

// --- WeChat (Open Platform QR Login & Official Account MP OAuth) ---
type WeChatAdapter struct{}

func (w *WeChatAdapter) ID() string { return "wechat" }
func (w *WeChatAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	mode := cfg.Extra["wechat_mode"] // "qr" (open platform) or "mp" (official account)
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
func (w *WeChatAdapter) ExchangeCode(_ context.Context, _ Config, _ string) (*UserProfile, error) {
	return nil, errors.New("configure WeChat AppID & AppSecret to execute live exchange")
}

// --- GitHub ---
type GitHubAdapter struct{}

func (g *GitHubAdapter) ID() string { return "github" }
func (g *GitHubAdapter) BuildAuthURL(cfg Config, state string) (string, error) {
	q := url.Values{
		"client_id":    {cfg.ClientID},
		"redirect_uri": {cfg.RedirectURI},
		"scope":        {"read:user user:email"},
		"state":        {state},
	}
	return "https://github.com/login/oauth/authorize?" + q.Encode(), nil
}
func (g *GitHubAdapter) ExchangeCode(_ context.Context, _ Config, _ string) (*UserProfile, error) {
	return nil, errors.New("configure GitHub OAuth App credentials to execute live exchange")
}
