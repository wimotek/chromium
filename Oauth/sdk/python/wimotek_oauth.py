"""Minimalist OIDC + PKCE (S256) SDK for wimotek/oauth (Python 3.9+ stdlib only)."""
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

        return {"tokens": tokens, "user": userinfo}
