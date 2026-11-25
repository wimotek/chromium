# wimotek/Oauth — OIDC / OAuth 2.0 IdP Integration Guide

## 1. OpenID Connect 1.0 / OAuth 2.0 Identity Provider

`wimotek/Oauth` acts as a standards-compliant OpenID Connect Identity Provider issuing **RS256-signed `id_token` and `access_token` JWTs**. Downstream business apps (ERP, CRM, Wiki, Grafana, GitLab, Jenkins, custom web/mobile apps, CLI tools) only need standard OIDC configuration and never need to handle upstream Microsoft, Apple, Google, WeChat, GitHub, Passkey, or Email OTP details.

---

## 2. Standard OIDC Integration Flow (Authorization Code + PKCE `S256`)

### Step 1: Register Your Business Application
Open **Admin Console -> Business Applications** and create an application with your callback URL (e.g., `https://erp.company.com/auth/callback`). Record the generated `client_id` and `client_secret`.

### Step 2: Configure Auto-Discovery
Most enterprise apps (GitLab, Grafana, Harbor, Nextcloud, Spring Security, NextAuth) only require the Discovery URL:

```text
https://<your-idp-host>/.well-known/openid-configuration
```

### Step 3: Redirect User with PKCE `S256`
Generate a random `state` (CSRF token) and `code_verifier`, compute `code_challenge = BASE64URL(SHA256(code_verifier))`, and redirect the browser to:

```text
GET /oauth/authorize
  ?response_type=code
  &client_id=<CLIENT_ID>
  &redirect_uri=<URL_ENCODED_CALLBACK>
  &scope=openid%20profile%20email%20offline_access
  &state=<CSRF_STATE>
  &code_challenge=<S256_CHALLENGE>
  &code_challenge_method=S256
```

### Step 4: Exchange Authorization Code for RS256 Tokens
On callback, verify `state`, then POST to `/oauth/token`:

```bash
curl -X POST https://<your-idp-host>/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "<AUTHORIZATION_CODE>",
    "redirect_uri": "https://erp.company.com/auth/callback",
    "client_id": "<CLIENT_ID>",
    "client_secret": "<CLIENT_SECRET>",
    "code_verifier": "<CODE_VERIFIER>"
  }'
```

### Step 5: Verify RS256 Signature via JWKS & Fetch User Profile
Verify `id_token` using the public key exposed at `GET /.well-known/jwks.json`, or call `GET /oauth/userinfo` with `Authorization: Bearer <access_token>`.

---

## 3. Cross-Device Login (OAuth 2.0 Device Flow — RFC 8628)

For CLI tools, TVs, or desktop apps:

1. `POST /oauth/device_authorization` with `{ "client_id": "<CLIENT_ID>", "scope": "openid profile email" }`.
2. Display `user_code` (e.g. `4TL8-WNMP`) and `verification_uri` (or QR code) to the user.
3. User confirms sign-in on their phone/browser.
4. Poll `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.

---

## 4. Progressive Identity Linking (JIT) & Ban Webhooks

- **JIT + Verified-Email Linking**: When a user signs in via Microsoft, Google, WeChat, GitHub, Passkey, or Email OTP and `email_verified: true`, `wimotek/Oauth` automatically links the provider onto the existing account in `user_identities` rather than creating duplicate users.
- **Downstream Session Revocation (`user.banned`)**: Register a webhook endpoint in **Identity Directory** to receive signed revocation events when an employee leaves or is banned. Verify the `X-Wimotek-Signature-256: sha256=<hex>` header with HMAC-SHA256 using constant-time comparison before revoking local sessions.
