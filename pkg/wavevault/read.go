// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/memroots"
)

// Filter is a structured frontmatter WHERE. FrontmatterEquals matches exact string values;
// HasLink matches nodes that [[link]] to the given id. Empty fields match everything.
type Filter struct {
	FrontmatterEquals map[string]string
	HasLink           string
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
// process-wide cache, no invalidation machinery).
type Retriever struct {
	v      *Vault
	scope  Scope
	g      *graph
	loaded bool
}

func (v *Vault) Retriever(scope Scope) *Retriever {
	return &Retriever{v: v, scope: scope}
}

// frontmatterScope reads an explicit scope. Notes on disk carry it under metadata:, so that nesting is
// checked first; a top-level key is accepted too. "" means derive it from the path instead.
func frontmatterScope(fm map[string]any) string {
	if meta, ok := fm["metadata"].(map[string]any); ok {
		if s, ok := meta["scope"].(string); ok && s != "" {
			return s
		}
	}
	if s, ok := fm["scope"].(string); ok {
		return s
	}
	return ""
}

// load walks the scope's collection directories — the physical collection boundary. Every note is
// read-only by construction: resolvePath and Commit are both v.Root-scoped.
func (r *Retriever) load() error {
	if r.loaded {
		return nil
	}
	g := &graph{byID: map[string]Node{}, bodies: map[string]string{}}

	// absorb applies one file. Precedence: the vault's own copy wins an id conflict, else first-seen
	// wins. (Before mirrors there was only one root, and this was last-seen-wins by accident.)
	absorb := func(root, coll, source, p string, d os.DirEntry) {
		if d.Name() == memroots.IndexFile {
			return // an index, not knowledge — and every copy collides on the id "MEMORY"
		}
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			return // tolerant: skip unreadable files
		}
		n, body := parseNode(p, data)
		n.Collection = coll
		n.Source = source
		if coll == CollMemory {
			// scope clusters memory notes by project; a tasks/decisions subdir is not a project
			if s := frontmatterScope(n.Frontmatter); s != "" {
				n.Scope = s
			} else {
				n.Scope = memroots.ScopeForPath(root, source, p)
			}
		}
		if info, statErr := d.Info(); statErr == nil {
			n.UpdatedTs = info.ModTime().UnixMilli()
		}
		if existing, dup := g.byID[n.ID]; dup {
			if !(source == "vault" && existing.Source != "vault") {
				return // keep existing
			}
		} else {
			g.order = append(g.order, n.ID)
		}
		g.byID[n.ID] = n
		g.bodies[n.ID] = body
	}

	walk := func(root, coll, source string) {
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			absorb(root, coll, source, p, d)
			return nil
		})
	}

	for _, coll := range r.scope.Collections {
		walk(filepath.Join(r.v.Root, coll), coll, "vault")
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

// Subgraph is the assembled neighborhood: the visited nodes and the edges walked. The set of edges
// is the citation material grounding consumes.
type Subgraph struct {
	Nodes []Node
	Edges []Edge
}

// Graph returns the entire scope as a subgraph: every node (insertion order) and every resolved
// wikilink edge — the whole-vault read U3's graph surface renders. Dangling links are already excluded
// (load resolves edges against the node set).
func (r *Retriever) Graph() (*Subgraph, error) {
	if err := r.load(); err != nil {
		return nil, err
	}
	sg := &Subgraph{}
	for _, id := range r.g.order {
		sg.Nodes = append(sg.Nodes, r.g.byID[id])
	}
	sg.Edges = append(sg.Edges, r.g.edges...)
	return sg, nil
}
