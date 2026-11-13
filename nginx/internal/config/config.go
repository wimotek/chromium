package config

import (
	"os"
)

type Config struct {
	AdminUser string
	AdminPass string
	AuthToken string
	NginxDir  string
	HttpPort  string
}

func Load() *Config {
	return &Config{
		AdminUser: getEnv("ADMIN_USER", "admin"),
		AdminPass: getEnv("ADMIN_PASS", "Wimotek@2026"),
		AuthToken: getEnv("AUTH_TOKEN", "wimotek-secure-token-2026"),
		NginxDir:  getEnv("NGINX_DIR", "/etc/nginx/conf.d"),
		HttpPort:  getEnv("HTTP_PORT", ":8080"),
	}
}

func getEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}