// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// marker files in priority order; pom.xml first because the target repo is Java/Maven (spec §5)
var sessionGroupMarkers = []string{
	"pom.xml",
	"go.mod",
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"build.gradle",
	"Dockerfile",
}

// a dir name like "v1", "v2", "version-1.1" is not a useful service label; use its parent instead
var versionDirRe = regexp.MustCompile(`^(v\d+|version[-.].*)$`)

type sessionGroupCache struct {
	lock sync.Mutex
	m    map[string]*wshrpc.CommandGetSessionGroupRtnData
}

var sgCache = &sessionGroupCache{m: make(map[string]*wshrpc.CommandGetSessionGroupRtnData)}

func (c *sessionGroupCache) get(cwd string) (*wshrpc.CommandGetSessionGroupRtnData, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	v, ok := c.m[cwd]
	return v, ok
}

func (c *sessionGroupCache) set(cwd string, v *wshrpc.CommandGetSessionGroupRtnData) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.m[cwd] = v
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func findMarkerDir(dir string) (string, bool) {
	for {
		for _, marker := range sessionGroupMarkers {
			if fileExists(filepath.Join(dir, marker)) {
				return dir, true
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func findGitRoot(dir string) (string, bool) {
	for {
		if fileExists(filepath.Join(dir, ".git")) {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func labelForDir(dir string) string {
	base := filepath.Base(dir)
	if versionDirRe.MatchString(base) {
		return filepath.Base(filepath.Dir(dir))
	}
	return base
}

func computeSessionGroup(cwd string) *wshrpc.CommandGetSessionGroupRtnData {
	if markerDir, ok := findMarkerDir(cwd); ok {
		return &wshrpc.CommandGetSessionGroupRtnData{Root: markerDir, Label: labelForDir(markerDir)}
	}
	if gitRoot, ok := findGitRoot(cwd); ok {
		return &wshrpc.CommandGetSessionGroupRtnData{Root: gitRoot, Label: filepath.Base(gitRoot)}
	}
	return &wshrpc.CommandGetSessionGroupRtnData{Root: cwd, Label: filepath.Base(cwd)}
}

// resolveSessionGroup is the cached entry point used by the RPC. Cache is process-lifetime
// per spec §5 (cwd→service is stable; "auto, zero upkeep").
func resolveSessionGroup(cwd string) *wshrpc.CommandGetSessionGroupRtnData {
	if v, ok := sgCache.get(cwd); ok {
		return v
	}
	v := computeSessionGroup(cwd)
	sgCache.set(cwd, v)
	return v
}
