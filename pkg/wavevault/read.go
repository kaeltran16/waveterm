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
// `order`), their bodies, the text Search matches, and resolved edges.
type graph struct {
	byID     map[string]Node
	bodies   map[string]string
	searchTx map[string]string
	order    []string
	edges    []Edge
}

// contentFrontmatterKeys are the frontmatter fields that carry a note's human-readable content rather
// than structured metadata about it. Search folds these in because for whole collections the content
// lives nowhere else: a dossier's `objective` is its only prose (its body is marker comments and an
// empty `## Notes`), so matching the body alone makes dossiers unreachable by keyword entirely.
// Metadata (status/actor/provenance/created/…) is deliberately excluded — that is Filter's job, and
// folding it in would make a query containing "active" match every open note and crowd out the real
// hits, since callers cap how many seeds they keep.
var contentFrontmatterKeys = []string{"objective", "acceptance", "summary", "name", "description"}

// searchableText is the haystack for one node: its id both raw and de-slugified (ids are slugs of the
// title/objective, so "memory tab" should reach `…-memory-tab-…`), its content frontmatter, then the
// body. Built once at load rather than per query — Search is called once per keyword.
func searchableText(n Node, body string) string {
	var b strings.Builder
	b.WriteString(n.ID)
	b.WriteString("\n")
	b.WriteString(strings.ReplaceAll(n.ID, "-", " "))
	for _, k := range contentFrontmatterKeys {
		if v, ok := n.Frontmatter[k]; ok {
			fmt.Fprintf(&b, "\n%v", v)
		}
	}
	b.WriteString("\n")
	b.WriteString(body)
	return b.String()
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

// frontmatterScope reads an explicit scope. memvault writes it under metadata:, so that nesting is
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

// load walks the scope's collection directories — the physical collection boundary — plus, for the
// memory collection, the external mirror roots. Mirrors are read-only by construction: resolvePath
// and Commit are both v.Root-scoped, so nothing here can be written or committed.
func (r *Retriever) load() error {
	if r.loaded {
		return nil
	}
	g := &graph{byID: map[string]Node{}, bodies: map[string]string{}, searchTx: map[string]string{}}

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
		g.searchTx[n.ID] = searchableText(n, body)
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
		if coll == CollMemory && r.v.mirrors != nil {
			for _, m := range r.v.mirrors() {
				walk(m.Path, CollMemory, m.Source)
			}
		}
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
		text := r.g.searchTx[id]
		if idx := strings.Index(strings.ToLower(text), q); idx >= 0 {
			hits = append(hits, Hit{Node: r.g.byID[id], Snippet: snippet(text, idx, len(q))})
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

// Graph returns the entire scope as a subgraph: every node (insertion order) and every resolved
// wikilink edge — the whole-vault read U3's graph surface renders. Same derived layer Expand walks,
// without a seed/BFS. Dangling links are already excluded (load resolves edges against the node set).
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
