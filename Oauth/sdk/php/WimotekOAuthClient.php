<?php
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
            'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
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
            'header' => "Authorization: Bearer {$tokens['access_token']}\r\n",
        ]]);
        $user = json_decode(file_get_contents(rtrim($this->issuer, '/') . '/oauth/userinfo', false, $uCtx), true);

        return ['tokens' => $tokens, 'user' => $user];
    }

    private function b64url(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}
