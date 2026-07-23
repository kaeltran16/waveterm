// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Filter is a structured frontmatter WHERE. FrontmatterEquals matches exact string values;
// HasLink matches nodes that [[link]] to the given id. Empty fields match everything.
type Filter struct {
	FrontmatterEquals map[string]string
	HasLink           string
}

// Hit is a full-text match: the node plus a short snippet around the first match.
type Hit struct {
	Node    Node
	Snippet string
}

// NodeWithBody is a node plus its verbatim post-frontmatter body.
type NodeWithBody struct {
	Node Node
	Body string
}

// Edge is a resolved wikilink (both endpoints exist in scope).
type Edge struct {
	From string
	To   string
}

// graph is the in-memory derived layer for one Retriever's scope: nodes by id (insertion order in
// `order`), their bodies, and resolved edges.
type graph struct {
	byID   map[string]Node
	bodies map[string]string
	order  []string
	edges  []Edge
}

// Retriever is a scope-limited read handle. It scans its scope's directories once on first use and
// reuses the result for its lifetime; a new logical operation uses a fresh Retriever (no
// process-wide cache, no invalidation machinery — matches memvault's re-scan model).
type Retriever struct {
	v      *Vault
	scope  Scope
	g      *graph
	loaded bool
}

func (v *Vault) Retriever(scope Scope) *Retriever {
	return &Retriever{v: v, scope: scope}
}

// load walks only the scope's collection directories — the physical collection boundary.
func (r *Retriever) load() error {
	if r.loaded {
		return nil
	}
	g := &graph{byID: map[string]Node{}, bodies: map[string]string{}}
	for _, coll := range r.scope.Collections {
		root := filepath.Join(r.v.Root, coll)
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			data, readErr := os.ReadFile(p)
			if readErr != nil {
				return nil // tolerant: skip unreadable files
			}
			n, body := parseNode(p, data)
			n.Collection = coll
			if info, statErr := d.Info(); statErr == nil {
				n.UpdatedTs = info.ModTime().UnixMilli()
			}
			if _, dup := g.byID[n.ID]; !dup {
				g.order = append(g.order, n.ID)
			}
			g.byID[n.ID] = n
			g.bodies[n.ID] = body
			return nil
		})
	}
	for _, id := range g.order {
		for _, l := range g.byID[id].Links {
			if _, ok := g.byID[l]; ok {
				g.edges = append(g.edges, Edge{From: id, To: l})
			}
		}
	}
	r.g = g
	r.loaded = true
	return nil
}

func (r *Retriever) Query(f Filter) ([]Node, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	var out []Node
	for _, id := range r.g.order {
		if matchesFilter(r.g.byID[id], f) {
			out = append(out, r.g.byID[id])
		}
	}
	return out, nil
}

func matchesFilter(n Node, f Filter) bool {
	for k, v := range f.FrontmatterEquals {
		if fmt.Sprintf("%v", n.Frontmatter[k]) != v {
			return false
		}
	}
	if f.HasLink != "" {
		found := false
		for _, l := range n.Links {
			if l == f.HasLink {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func (r *Retriever) Search(query string) ([]Hit, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil, nil
	}
	var hits []Hit
	for _, id := range r.g.order {
		body := r.g.bodies[id]
		if idx := strings.Index(strings.ToLower(body), q); idx >= 0 {
			hits = append(hits, Hit{Node: r.g.byID[id], Snippet: snippet(body, idx, len(q))})
		}
	}
	return hits, nil
}

// snippet returns up to 40 chars of context on each side of a match.
func snippet(body string, idx, matchLen int) string {
	const pad = 40
	start := idx - pad
	if start < 0 {
		start = 0
	}
	end := idx + matchLen + pad
	if end > len(body) {
		end = len(body)
	}
	return strings.TrimSpace(body[start:end])
}

func (r *Retriever) Read(id string) (*NodeWithBody, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	n, ok := r.g.byID[id]
	if !ok {
		return nil, fmt.Errorf("wavevault: node %q not in scope", id)
	}
	return &NodeWithBody{Node: n, Body: r.g.bodies[id]}, nil
}

// ExpandOpts bounds the wikilink walk. Depth defaults to 1, Fanout to 8. (EdgeTypes — typed-edge
// filtering — is a D concern; v1 walks all [[links]].)
type ExpandOpts struct {
	Depth  int
	Fanout int
}

// Subgraph is the assembled neighborhood: the visited nodes and the edges walked. The set of edges
// is the citation material grounding consumes.
type Subgraph struct {
	Nodes []Node
	Edges []Edge
}

// Expand walks the wikilink graph breadth-first from seeds, bounded by Depth and Fanout, following
// only links whose target exists in scope (dangling links are skipped), deduping by id. A's
// deterministic traversal primitive; C drives the model seed-picking/re-expansion loop on top.
func (r *Retriever) Expand(seeds []string, opts ExpandOpts) (*Subgraph, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	if opts.Depth <= 0 {
		opts.Depth = 1
	}
	if opts.Fanout <= 0 {
		opts.Fanout = 8
	}
	visited := map[string]bool{}
	sg := &Subgraph{}
	type item struct {
		id    string
		depth int
	}
	var queue []item
	for _, s := range seeds {
		if _, ok := r.g.byID[s]; ok && !visited[s] {
			visited[s] = true
			sg.Nodes = append(sg.Nodes, r.g.byID[s])
			queue = append(queue, item{s, 0})
		}
	}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur.depth >= opts.Depth {
			continue
		}
		count := 0
		for _, l := range r.g.byID[cur.id].Links {
			if count >= opts.Fanout {
				break
			}
			if _, ok := r.g.byID[l]; !ok {
				continue // dangling
			}
			sg.Edges = append(sg.Edges, Edge{From: cur.id, To: l})
			count++
			if !visited[l] {
				visited[l] = true
				sg.Nodes = append(sg.Nodes, r.g.byID[l])
				queue = append(queue, item{l, cur.depth + 1})
			}
		}
	}
	return sg, nil
}
