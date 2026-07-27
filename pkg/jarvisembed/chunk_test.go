// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisembed

import (
	"strings"
	"testing"
)

func TestSplitSections(t *testing.T) {
	body := "intro line\n\n## First\nalpha\n\n## Second\nbeta\n"
	got := splitSections(body)
	if len(got) != 3 {
		t.Fatalf("want 3 sections, got %d: %+v", len(got), got)
	}
	if got[0].Heading != "" || !strings.Contains(got[0].Text, "intro line") {
		t.Errorf("section 0 = %+v", got[0])
	}
	if got[1].Heading != "First" || !strings.Contains(got[1].Text, "alpha") {
		t.Errorf("section 1 = %+v", got[1])
	}
	if got[2].Idx != 2 || got[2].Heading != "Second" {
		t.Errorf("section 2 = %+v", got[2])
	}
}

func TestSplitSectionsNoHeading(t *testing.T) {
	got := splitSections("just prose, no headings")
	if len(got) != 1 || got[0].Heading != "" {
		t.Fatalf("want 1 headingless section, got %+v", got)
	}
}

func TestEmbedTextIncludesFrontmatter(t *testing.T) {
	fm := map[string]any{"ticket": "ABC-1", "objective": "do the thing"}
	txt := embedText(fm, Section{Idx: 1, Heading: "Notes", Text: "body here"})
	if !strings.Contains(txt, "ABC-1") || !strings.Contains(txt, "Notes") || !strings.Contains(txt, "body here") {
		t.Fatalf("embedText missing parts: %q", txt)
	}
}
