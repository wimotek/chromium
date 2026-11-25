# 4-line integration example using Flask + wimotek_oauth
from wimotek_oauth import WimotekOAuthClient

auth = WimotekOAuthClient(
    issuer="https://auth.example.com",
    client_id="app_demo_01",
    client_secret="your_client_secret",
    redirect_uri="https://app.example.com/callback",
)

# Step 1: Redirect user to unified login page (store state & verifier in session)
login_url, state, verifier = auth.build_login_url()

# Step 2: Inside your /callback handler, verify state + PKCE and get user profile
result = auth.handle_callback(code="AUTH_CODE", received_state=state, expected_state=state, verifier=verifier)
print("Authenticated user:", result["user"]["email"])
