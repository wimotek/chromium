package com.wimotek.oauth;

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
        String accessToken = tokenJson.replaceAll(".*\"access_token\"\\s*:\\s*\"([^\"]+)\".*", "$1");

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
}
