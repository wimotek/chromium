package geoip

import (
	"net/http"
	"os"
	"strings"
)

type Location struct {
	CountryCode string
	Region      string
	City        string
}

// Locator resolves visitor geography using CDN headers (CF-IPCountry / X-Geo-*)
// and optional local GeoLite2-City.mmdb when provisioned under /data.
type Locator struct {
	mmdbPath string
}

func NewLocator(mmdbPath string) *Locator {
	return &Locator{mmdbPath: mmdbPath}
}

func (l *Locator) HasMMDB() bool {
	info, err := os.Stat(l.mmdbPath)
	return err == nil && !info.IsDir() && info.Size() > 0
}

func (l *Locator) Lookup(r *http.Request) Location {
	if cc := strings.TrimSpace(r.Header.Get("CF-IPCountry")); cc != "" && cc != "XX" {
		return Location{
			CountryCode: strings.ToUpper(cc),
			Region:      strings.TrimSpace(r.Header.Get("CF-Region")),
			City:        strings.TrimSpace(r.Header.Get("CF-IPCity")),
		}
	}
	if cc := strings.TrimSpace(r.Header.Get("X-Geo-Country")); cc != "" {
		return Location{
			CountryCode: strings.ToUpper(cc),
			Region:      strings.TrimSpace(r.Header.Get("X-Geo-Region")),
			City:        strings.TrimSpace(r.Header.Get("X-Geo-City")),
		}
	}
	return Location{
		CountryCode: "LOCAL",
		Region:      "Private Network",
		City:        "Direct",
	}
}
