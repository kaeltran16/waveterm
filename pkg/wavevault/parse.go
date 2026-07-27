// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package wavevault is the git-backed Wave Vault storage substrate for Jarvis v1: a deterministic
// read API (frontmatter query, full-text, wikilink expansion, content hash), a region-aware
// diff-validated write path, and ownership-staged commits. It calls no model and exposes no RPC.
package wavevault

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Node is one parsed vault file. Body is returned separately by parseNode (the graph stores it
// alongside). Collection and UpdatedTs are filled in by the scanner, not by parseNode.
type Node struct {
	ID          string         `json:"id"`
	Path        string         `json:"path"`
	Collection  string         `json:"collection"`
	Frontmatter map[string]any `json:"frontmatter"`
	Links       []string       `json:"links"`
	ContentHash string         `json:"contenthash"`
	UpdatedTs   int64          `json:"updatedts"`
}

var linkRe = regexp.MustCompile(`\[\[([^\]]+)\]\]`)

// ContentHash is the sha256 (hex) of the raw file bytes — the per-node invalidation key C keys on.
func ContentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// parseNode splits frontmatter from body, unmarshals the frontmatter into a map (order does not
// matter for querying; the write path preserves order by splicing raw text, not re-serializing this
// map), extracts deduped [[wikilinks]] in order, and hashes the raw bytes. ID is frontmatter id,
// else name, else the filename stem. Frontmatter parsing follows memvault's --- delimiter handling.
func parseNode(path string, data []byte) (Node, string) {
	n := Node{Path: path, ContentHash: ContentHash(data)}
	body := string(data)
	if strings.HasPrefix(body, "---\n") {
		if end := strings.Index(body[4:], "\n---"); end >= 0 {
			fmText := body[4 : 4+end]
			rest := body[4+end+4:]
			rest = strings.TrimLeft(rest, "\n")
			var fm map[string]any
			if err := yaml.Unmarshal([]byte(fmText), &fm); err == nil {
				n.Frontmatter = fm
			}
			body = rest
		}
	}
	if s, ok := n.Frontmatter["id"].(string); ok {
		n.ID = s
	}
	if n.ID == "" {
		if s, ok := n.Frontmatter["name"].(string); ok {
			n.ID = s
		}
	}
	if n.ID == "" {
		n.ID = strings.TrimSuffix(filepath.Base(path), ".md")
	}
	seen := map[string]bool{}
	for _, m := range linkRe.FindAllStringSubmatch(body, -1) {
		t := strings.TrimSpace(m[1])
		if t != "" && !seen[t] {
			seen[t] = true
			n.Links = append(n.Links, t)
		}
	}
	return n, body
}
