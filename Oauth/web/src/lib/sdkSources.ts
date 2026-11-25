export type SdkLang = 'python' | 'nodejs' | 'go' | 'java' | 'php';

export interface EmbeddedSdkSpec {
  id: SdkLang;
  label: string;
  fileName: string;
  path: string;
  dropInPath: string;
  packageHintEn: string;
  packageHintZh: string;
  source: string;
  lineCount: number;
}

const PYTHON_SDK_SOURCE = `"""Minimalist OIDC + PKCE (S256) SDK for wimotek/oauth (Python 3.9+ stdlib only)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Dict, Tuple


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


@dataclass
class WimotekOAuthClient:
    issuer: str
    client_id: str
    client_secret: str
    redirect_uri: str

    def build_login_url(self, scope: str = "openid profile email") -> Tuple[str, str, str]:
        """Returns (authorization_url, state, code_verifier) for session storage."""
        state = _b64url(secrets.token_bytes(16))
        verifier = _b64url(secrets.token_bytes(32))
        challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())

        params = urllib.parse.urlencode({
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": scope,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        })
        return f"{self.issuer.rstrip('/')}/oauth/authorize?{params}", state, verifier

    def handle_callback(self, code: str, received_state: str, expected_state: str, verifier: str) -> Dict:
        """Validates CSRF state, exchanges code with PKCE verifier, and fetches OIDC userinfo."""
        if not expected_state or not hmac.compare_digest(received_state, expected_state):
            raise ValueError("Invalid OAuth state parameter")

        token_body = urllib.parse.urlencode({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code_verifier": verifier,
        }).encode("utf-8")

        token_req = urllib.request.Request(
            f"{self.issuer.rstrip('/')}/oauth/token",
            data=token_body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            tokens = json.loads(resp.read().decode("utf-8"))

        user_req = urllib.request.Request(
            f"{self.issuer.rstrip('/')}/oauth/userinfo",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        with urllib.request.urlopen(user_req, timeout=10) as resp:
            userinfo = json.loads(resp.read().decode("utf-8"))

        return {"tokens": tokens, "user": userinfo}`;

const NODEJS_SDK_SOURCE = `import crypto from 'node:crypto';

export interface WimotekOAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');

export class WimotekOAuthClient {
  private readonly issuer: string;

  constructor(private readonly cfg: WimotekOAuthConfig) {
    this.issuer = cfg.issuer.replace(/\\/$/, '');
  }

  createAuthSession(scope = 'openid profile email') {
    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    const url = new URL(\`\${this.issuer}/oauth/authorize\`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { url: url.toString(), state, verifier };
  }

  async handleCallback(params: {
    code: string;
    state: string;
    expectedState: string;
    verifier: string;
  }) {
    const a = Buffer.from(params.state);
    const b = Buffer.from(params.expectedState);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error('OAuth state mismatch');
    }

    const tokenRes = await fetch(\`\${this.issuer}/oauth/token\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: this.cfg.redirectUri,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code_verifier: params.verifier,
      }),
    });
    const tokens = await tokenRes.json();

    const userRes = await fetch(\`\${this.issuer}/oauth/userinfo\`, {
      headers: { Authorization: \`Bearer \${tokens.access_token}\` },
    });
    const user = await userRes.json();
    return { tokens, user };
  }
}`;

const GO_SDK_SOURCE = `package wimotekoauth

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
	AccessToken string         \`json:"access_token"\`
	IDToken     string         \`json:"id_token"\`
	User        map[string]any \`json:"user"\`
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
		AccessToken string \`json:"access_token"\`
		IDToken     string \`json:"id_token"\`
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
}`;

const JAVA_SDK_SOURCE = `package com.wimotek.oauth;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

public class WimotekOAuthClient {
    private final String issuer, clientId, clientSecret, redirectUri;
    private final HttpClient http = HttpClient.newHttpClient();

    public record AuthSession(String authUrl, String state, String codeVerifier) {}

    public WimotekOAuthClient(String issuer, String clientId, String clientSecret, String redirectUri) {
        this.issuer = issuer.replaceAll("/+$", "");
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.redirectUri = redirectUri;
    }

    public AuthSession createAuthSession() throws Exception {
        String state = randomUrlSafe(16);
        String verifier = randomUrlSafe(32);
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
        String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(digest);

        String url = issuer + "/oauth/authorize?response_type=code"
                + "&client_id=" + enc(clientId)
                + "&redirect_uri=" + enc(redirectUri)
                + "&scope=" + enc("openid profile email")
                + "&state=" + enc(state)
                + "&code_challenge=" + enc(challenge)
                + "&code_challenge_method=S256";
        return new AuthSession(url, state, verifier);
    }

    public String exchangeCodeForUserInfo(String code, String state, String expectedState, String verifier) throws Exception {
        if (!MessageDigest.isEqual(state.getBytes(), expectedState.getBytes())) {
            throw new SecurityException("OAuth state mismatch");
        }
        String form = "grant_type=authorization_code&code=" + enc(code)
                + "&redirect_uri=" + enc(redirectUri)
                + "&client_id=" + enc(clientId)
                + "&client_secret=" + enc(clientSecret)
                + "&code_verifier=" + enc(verifier);

        HttpRequest tokenReq = HttpRequest.newBuilder(URI.create(issuer + "/oauth/token"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        String tokenJson = http.send(tokenReq, HttpResponse.BodyHandlers.ofString()).body();
        String accessToken = tokenJson.replaceAll(".*\\"access_token\\"\\\\s*:\\\\s*\\"([^\\"]+)\\".*", "$1");

        HttpRequest userReq = HttpRequest.newBuilder(URI.create(issuer + "/oauth/userinfo"))
                .header("Authorization", "Bearer " + accessToken)
                .GET().build();
        return http.send(userReq, HttpResponse.BodyHandlers.ofString()).body();
    }

    private static String randomUrlSafe(int n) {
        byte[] b = new byte[n];
        new SecureRandom().nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    private static String enc(String v) { return URLEncoder.encode(v, StandardCharsets.UTF_8); }
}`;

const PHP_SDK_SOURCE = `<?php
declare(strict_types=1);

final class WimotekOAuthClient
{
    public function __construct(
        private readonly string $issuer,
        private readonly string $clientId,
        private readonly string $clientSecret,
        private readonly string $redirectUri,
    ) {}

    public function createAuthSession(string $scope = 'openid profile email'): array
    {
        $state = $this->b64url(random_bytes(16));
        $verifier = $this->b64url(random_bytes(32));
        $challenge = $this->b64url(hash('sha256', $verifier, true));

        $query = http_build_query([
            'response_type' => 'code',
            'client_id' => $this->clientId,
            'redirect_uri' => $this->redirectUri,
            'scope' => $scope,
            'state' => $state,
            'code_challenge' => $challenge,
            'code_challenge_method' => 'S256',
        ]);

        return [
            'url' => rtrim($this->issuer, '/') . '/oauth/authorize?' . $query,
            'state' => $state,
            'verifier' => $verifier,
        ];
    }

    public function handleCallback(string $code, string $state, string $expectedState, string $verifier): array
    {
        if (!hash_equals($expectedState, $state)) {
            throw new RuntimeException('Invalid OAuth state');
        }

        $ctx = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/x-www-form-urlencoded\\r\\n",
            'content' => http_build_query([
                'grant_type' => 'authorization_code',
                'code' => $code,
                'redirect_uri' => $this->redirectUri,
                'client_id' => $this->clientId,
                'client_secret' => $this->clientSecret,
                'code_verifier' => $verifier,
            ]),
        ]]);
        $tokens = json_decode(file_get_contents(rtrim($this->issuer, '/') . '/oauth/token', false, $ctx), true);

        $uCtx = stream_context_create(['http' => [
            'method' => 'GET',
            'header' => "Authorization: Bearer {$tokens['access_token']}\\r\\n",
        ]]);
        $user = json_decode(file_get_contents(rtrim($this->issuer, '/') . '/oauth/userinfo', false, $uCtx), true);

        return ['tokens' => $tokens, 'user' => $user];
    }

    private function b64url(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}`;

function countLines(src: string): number {
  return src.split('\n').length;
}

export const EMBEDDED_SDKS: Record<SdkLang, EmbeddedSdkSpec> = {
  python: {
    id: 'python',
    label: 'Python',
    fileName: 'wimotek_oauth.py',
    path: 'Oauth/sdk/python/wimotek_oauth.py',
    dropInPath: 'wimotek_oauth.py',
    packageHintEn: 'Drop-in single file (Python 3.9+ stdlib only, zero pip packages). Save the file below as wimotek_oauth.py in your project.',
    packageHintZh: '零第三方依赖单文件封装（仅用 Python 3.9+ 标准库）。将下方源码保存为 wimotek_oauth.py 即可直接 import。',
    source: PYTHON_SDK_SOURCE,
    lineCount: countLines(PYTHON_SDK_SOURCE),
  },
  nodejs: {
    id: 'nodejs',
    label: 'Node.js',
    fileName: 'wimotek-oauth.ts',
    path: 'Oauth/sdk/nodejs/wimotek-oauth.ts',
    dropInPath: './wimotek-oauth.ts',
    packageHintEn: 'Drop-in single file (Node.js 18+ built-in crypto & fetch, zero npm dependencies). Save below as wimotek-oauth.ts.',
    packageHintZh: '零 npm 依赖单文件封装（仅用 Node.js 18+ 原生 crypto 与 fetch）。将下方源码保存为 wimotek-oauth.ts 即可导入。',
    source: NODEJS_SDK_SOURCE,
    lineCount: countLines(NODEJS_SDK_SOURCE),
  },
  go: {
    id: 'go',
    label: 'Go',
    fileName: 'client.go',
    path: 'Oauth/sdk/go/client.go',
    dropInPath: 'pkg/wimotekoauth/client.go',
    packageHintEn: 'Supports Go Module auto-download (`go get github.com/wimotek/oauth/sdk/go@latest` via standalone Oauth/sdk/go/go.mod with zero server dependencies) OR zero-dependency offline single-file copy into `pkg/wimotekoauth/client.go`. Full beginner tutorial: Oauth/docs/GO_SDK_GUIDE.md.',
    packageHintZh: '支持 Go Module 自动下载（已独立提供零依赖 Oauth/sdk/go/go.mod，执行 go get github.com/wimotek/oauth/sdk/go@latest 即可自动拉取，不会拖入后端数据库依赖）；无公网/内网环境也可展开下方 93 行源码直接复制为 pkg/wimotekoauth/client.go。完整小白教程见 Oauth/docs/GO_SDK_GUIDE.md。',
    source: GO_SDK_SOURCE,
    lineCount: countLines(GO_SDK_SOURCE),
  },
  java: {
    id: 'java',
    label: 'Java',
    fileName: 'WimotekOAuthClient.java',
    path: 'Oauth/sdk/java/WimotekOAuthClient.java',
    dropInPath: 'src/main/java/com/wimotek/oauth/WimotekOAuthClient.java',
    packageHintEn: 'Drop-in single class (Java 17+ java.net.http only, zero Maven/Gradle dependencies). Place under com/wimotek/oauth/.',
    packageHintZh: '零外部依赖单文件封装（仅用 Java 17+ 标准库 java.net.http）。将下方源码放入 com/wimotek/oauth/WimotekOAuthClient.java 即可。',
    source: JAVA_SDK_SOURCE,
    lineCount: countLines(JAVA_SDK_SOURCE),
  },
  php: {
    id: 'php',
    label: 'PHP',
    fileName: 'WimotekOAuthClient.php',
    path: 'Oauth/sdk/php/WimotekOAuthClient.php',
    dropInPath: 'WimotekOAuthClient.php',
    packageHintEn: 'Drop-in single file (PHP 8.1+ stdlib only, zero Composer packages). Save below as WimotekOAuthClient.php and require_once it.',
    packageHintZh: '零 Composer 依赖单文件封装（PHP 8.1+ 标准库）。将下方源码保存为 WimotekOAuthClient.php 并 require_once 即可调用。',
    source: PHP_SDK_SOURCE,
    lineCount: countLines(PHP_SDK_SOURCE),
  },
};

export const SDK_ORDER: SdkLang[] = ['python', 'nodejs', 'go', 'java', 'php'];
