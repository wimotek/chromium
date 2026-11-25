package i18n

import (
	"embed"
	"encoding/json"
	"strings"
)

//go:embed locales/*.json
var localesFS embed.FS

// SupportedLanguages lists the five built-in enterprise UI locales.
var SupportedLanguages = []string{"en", "zh-CN", "ja", "de", "ar"}

// Bundle holds embedded raw locale JSON payloads for zero-overhead serving.
type Bundle struct {
	raw map[string][]byte
}

// NewBundle loads all embedded locale JSON files into memory at startup.
func NewBundle() (*Bundle, error) {
	b := &Bundle{raw: make(map[string][]byte, len(SupportedLanguages))}
	for _, lang := range SupportedLanguages {
		data, err := localesFS.ReadFile("locales/" + lang + ".json")
		if err != nil {
			return nil, err
		}
		// Validate JSON integrity at startup.
		var check map[string]any
		if err := json.Unmarshal(data, &check); err != nil {
			return nil, err
		}
		b.raw[lang] = data
	}
	return b, nil
}

// Resolve normalizes language codes and falls back to English.
func (b *Bundle) Resolve(lang string) (string, []byte) {
	clean := strings.TrimSpace(lang)
	if data, ok := b.raw[clean]; ok {
		return clean, data
	}
	lower := strings.ToLower(clean)
	switch {
	case strings.HasPrefix(lower, "zh"):
		return "zh-CN", b.raw["zh-CN"]
	case strings.HasPrefix(lower, "ja"):
		return "ja", b.raw["ja"]
	case strings.HasPrefix(lower, "de"):
		return "de", b.raw["de"]
	case strings.HasPrefix(lower, "ar"):
		return "ar", b.raw["ar"]
	default:
		return "en", b.raw["en"]
	}
}
