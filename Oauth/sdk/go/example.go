//go:build ignore

// Complete runnable example of integrating wimotek/Oauth into a Go web server.
// See Oauth/docs/GO_SDK_GUIDE.md for a beginner-friendly step-by-step tutorial.
//
// Run locally:
//   export OAUTH_SECRET="your_client_secret"
//   go run example.go
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	wimotekoauth "github.com/wimotek/oauth/sdk/go"
)

var oauthClient = &wimotekoauth.Client{
	Issuer:       "http://localhost:8080",
	ClientID:     "wimotek_erp_portal",
	ClientSecret: os.Getenv("OAUTH_SECRET"),
	RedirectURI:  "http://localhost:4000/callback",
}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<h1>My Go App</h1><a href="/login">Sign in with wimotek/Oauth</a>`)
	})

	// Step 1: Generate PKCE S256 login URL and save state + verifier in HttpOnly cookies
	http.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		loginURL, state, verifier := oauthClient.BuildLoginURL()
		http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: state, Path: "/", HttpOnly: true, MaxAge: 300})
		http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: verifier, Path: "/", HttpOnly: true, MaxAge: 300})
		http.Redirect(w, r, loginURL, http.StatusFound)
	})

	// Step 2: Handle OAuth callback, verify CSRF state + PKCE, and read user claims
	http.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		stateCookie, err1 := r.Cookie("oauth_state")
		verifierCookie, err2 := r.Cookie("oauth_verifier")
		if err1 != nil || err2 != nil {
			http.Error(w, "Missing login session cookies, please visit /login again", http.StatusBadRequest)
			return
		}

		res, err := oauthClient.HandleCallback(
			r.Context(),
			r.URL.Query().Get("code"),
			r.URL.Query().Get("state"),
			stateCookie.Value,
			verifierCookie.Value,
		)
		if err != nil {
			http.Error(w, "OAuth login failed: "+err.Error(), http.StatusUnauthorized)
			return
		}

		// Clear temporary cookies
		http.SetCookie(w, &http.Cookie{Name: "oauth_state", Value: "", Path: "/", MaxAge: -1})
		http.SetCookie(w, &http.Cookie{Name: "oauth_verifier", Value: "", Path: "/", MaxAge: -1})

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "Login success!\nUser: %v\nEmail: %v\nSub: %v\n", res.User["name"], res.User["email"], res.User["sub"])
	})

	log.Println("Demo app listening on http://localhost:4000")
	log.Fatal(http.ListenAndServe(":4000", nil))
}
