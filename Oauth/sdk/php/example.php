<?php
require_once __DIR__ . '/WimotekOAuthClient.php';

$oauth = new WimotekOAuthClient(
    'https://auth.example.com', 'app_demo_01', getenv('OAUTH_CLIENT_SECRET'), 'https://app.example.com/callback'
);

// Step 1: Redirect to $session['url'] after storing state & verifier in $_SESSION
$session = $oauth->createAuthSession();

// Step 2: Inside /callback, verify PKCE S256 & retrieve authenticated user profile
$result = $oauth->handleCallback($_GET['code'], $_GET['state'], $_SESSION['oauth_state'], $_SESSION['pkce_verifier']);
echo 'Welcome, ' . htmlspecialchars($result['user']['email']);
