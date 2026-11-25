package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embeddedDist embed.FS

// Assets returns the embedded frontend dist filesystem for single-binary serving.
func Assets() (fs.FS, error) {
	return fs.Sub(embeddedDist, "dist")
}
