package fspath

import (
	pathpkg "path"
	"strings"
)

const (
	// Separator is the path separator
	Separator = "/"
)

func Base(path string) string {
	return pathpkg.Base(ToSlash(path))
}

func ToSlash(path string) string {
	return strings.ReplaceAll(path, "\\", Separator)
}
