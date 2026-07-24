// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"fmt"
	"sort"
	"strings"
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
	if len(sections) == 0 {
		sections = append(sections, Section{Idx: 0, Text: strings.TrimSpace(body)})
	}
	return sections
}

// embedText builds the string sent to the embedder: frontmatter as metadata
// (sorted for determinism) + the section heading + the section text.
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
	return b.String()
}
