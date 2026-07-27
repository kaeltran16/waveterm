// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// Section is one embeddable unit of a node body: the text under a `##` heading
// (or the leading headingless body as section 0).
type Section struct {
	Idx     int
	Heading string
	Text    string
}

// splitSections segments a node body at `##` headings. Content before the first
// heading becomes section 0 with an empty Heading. Empty sections are dropped;
// a body with no `##` yields one section.
func splitSections(body string) []Section {
	lines := strings.Split(body, "\n")
	var sections []Section
	cur := Section{Idx: 0, Heading: ""}
	var buf []string
	flush := func() {
		txt := strings.TrimSpace(strings.Join(buf, "\n"))
		if txt != "" || cur.Heading != "" {
			cur.Text = txt
			cur.Idx = len(sections)
			sections = append(sections, cur)
		}
		buf = nil
	}
	for _, ln := range lines {
		if h := strings.TrimSpace(ln); strings.HasPrefix(h, "## ") {
			flush()
			cur = Section{Heading: strings.TrimSpace(strings.TrimPrefix(h, "## "))}
			continue
		}
		buf = append(buf, ln)
	}
	flush()
	// A body with no `##` still yields one section — but only if it has content. A wholly empty note must
	// yield none: it would otherwise become an empty embed input, and providers answer 200 with no data
	// for "", which fails the entire request and every other chunk batched alongside it.
	if len(sections) == 0 {
		if txt := strings.TrimSpace(body); txt != "" {
			sections = append(sections, Section{Idx: 0, Text: txt})
		}
	}
	return sections
}

// maxEmbedChars bounds one embed input. Embedding models cap input at a few thousand tokens
// (text-embedding-3-small: 8192); a real corpus contains notes far past that, and an overflow is not
// a graceful failure — the provider drops the vector and Embed fails the whole batch, so one big note
// leaves the entire index unbuilt. ~3 chars/token is deliberately pessimistic (code and non-English
// tokenize worse than prose) and the cap is not model-derived: baseURL/model are user-configurable,
// so this is a floor that keeps mainstream models safe rather than an exact limit.
const maxEmbedChars = 24000

// embedText builds the string sent to the embedder: frontmatter as metadata
// (sorted for determinism) + the section heading + the section text, truncated to maxEmbedChars.
func embedText(fm map[string]any, s Section) string {
	var b strings.Builder
	keys := make([]string, 0, len(fm))
	for k := range fm {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s: %v\n", k, fm[k])
	}
	if s.Heading != "" {
		fmt.Fprintf(&b, "## %s\n", s.Heading)
	}
	b.WriteString(s.Text)
	out := b.String()
	if len(out) > maxEmbedChars {
		// truncate the tail, not the head: the metadata/heading prefix is what identifies the chunk
		out = out[:maxEmbedChars]
		// ...back off to a rune boundary so the payload stays valid UTF-8
		for len(out) > 0 && !utf8.ValidString(out) {
			out = out[:len(out)-1]
		}
	}
	return out
}
