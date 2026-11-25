import crypto from 'node:crypto';

export interface WimotekOAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class WimotekOAuthClient {
  private readonly issuer: string;

  constructor(private readonly cfg: WimotekOAuthConfig) {
    this.issuer = cfg.issuer.replace(/\/$/, '');
  }

  createAuthSession(scope = 'openid profile email') {
    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    const url = new URL(`${this.issuer}/oauth/authorize`);
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

    const tokenRes = await fetch(`${this.issuer}/oauth/token`, {
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

    const userRes = await fetch(`${this.issuer}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = await userRes.json();
    return { tokens, user };
  }
}
