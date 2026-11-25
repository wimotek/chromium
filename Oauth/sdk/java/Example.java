import com.wimotek.oauth.WimotekOAuthClient;

public class Example {
    public static void main(String[] args) throws Exception {
        var oauth = new WimotekOAuthClient(
            "https://auth.example.com", "app_demo_01", System.getenv("OAUTH_CLIENT_SECRET"), "https://app.example.com/callback"
        );
        // Step 1: Redirect user to session.authUrl() and store session.state() & session.codeVerifier()
        var session = oauth.createAuthSession();
        // Step 2: In /callback, verify PKCE S256 & fetch OIDC userinfo JSON
        String userJson = oauth.exchangeCodeForUserInfo("AUTH_CODE", session.state(), session.state(), session.codeVerifier());
        System.out.println("UserInfo: " + userJson);
    }
}
