package web

import "embed"

// DistFS embeds the built React/TypeScript SPA directly into the single Go binary.
//
//go:embed all:dist
var DistFS embed.FS
