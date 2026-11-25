package wimotekoauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURI  string
}

type AuthResult struct {
	AccessToken string         `json:"access_token"`
	IDToken     string         `json:"id_token"`
	User        map[string]any `json:"user"`
}

func randomURLSafe(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (c *Client) BuildLoginURL() (authURL, state, verifier string) {
	state = randomURLSafe(16)
	verifier = randomURLSafe(32)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {c.ClientID},
		"redirect_uri":          {c.RedirectURI},
		"scope":                 {"openid profile email"},
		"state":                 {state},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
	}
	return strings.TrimRight(c.Issuer, "/") + "/oauth/authorize?" + q.Encode(), state, verifier
}

func (c *Client) HandleCallback(ctx context.Context, code, state, expectedState, verifier string) (*AuthResult, error) {
	if subtle.ConstantTimeCompare([]byte(state), []byte(expectedState)) != 1 {
		return nil, errors.New("invalid OAuth state")
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {c.RedirectURI},
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"code_verifier": {verifier},
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.Issuer, "/")+"/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var tok struct {
		AccessToken string `json:"access_token"`
		IDToken     string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return nil, err
	}

	uReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.Issuer, "/")+"/oauth/userinfo", nil)
	uReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	uResp, err := http.DefaultClient.Do(uReq)
	if err != nil {
		return nil, err
	}
	defer uResp.Body.Close()

	var user map[string]any
	_ = json.NewDecoder(uResp.Body).Decode(&user)
	return &AuthResult{AccessToken: tok.AccessToken, IDToken: tok.IDToken, User: user}, nil
}
