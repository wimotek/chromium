package main

import (
	"context"
	"fmt"
	wimotekoauth "github.com/wimotek/oauth/sdk/go"
)

func main() {
	client := &wimotekoauth.Client{
		Issuer:       "https://auth.example.com",
		ClientID:     "app_demo_01",
		ClientSecret: "your_client_secret",
		RedirectURI:  "https://app.example.com/callback",
	}
	// Step 1: Redirect browser to loginURL (persist state & verifier in session)
	loginURL, state, verifier := client.BuildLoginURL()
	fmt.Println("Redirect to:", loginURL)

	// Step 2: Inside /callback handler, exchange code with PKCE S256 & read userinfo
	res, err := client.HandleCallback(context.Background(), "AUTH_CODE", state, state, verifier)
	fmt.Println(res, err)
}
