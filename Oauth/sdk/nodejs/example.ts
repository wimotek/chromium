import { WimotekOAuthClient } from './wimotek-oauth';

// 1. Initialize once with your wimotek/oauth application credentials
const oauth = new WimotekOAuthClient({
  issuer: 'https://auth.example.com',
  clientId: 'app_demo_01',
  clientSecret: process.env.OAUTH_CLIENT_SECRET!,
  redirectUri: 'https://app.example.com/callback',
});

// 2. Generate login URL + PKCE session (save state & verifier in httpOnly cookie/session)
const { url, state, verifier } = oauth.createAuthSession();

// 3. In GET /callback: verify state + PKCE S256 and retrieve verified OIDC userinfo
const { user, tokens } = await oauth.handleCallback({ code: 'AUTH_CODE', state, expectedState: state, verifier });
console.log('Signed in:', user.email, Boolean(tokens.id_token));
