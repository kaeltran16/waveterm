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

// A single oversized note must not be able to kill the whole reconcile. Real corpora contain them
// (a 200k-char memory note was what surfaced this), providers cap input at a few thousand tokens,
// and OpenRouter signals the overflow as 200-with-empty-data rather than an error status — so
// without a guard the failure is both total and unreadable.
func TestEmbedTextCapsOversizedSections(t *testing.T) {
	huge := strings.Repeat("x", 300_000)
	got := embedText(map[string]any{"name": "big"}, Section{Heading: "Notes", Text: huge})
	if len(got) > maxEmbedChars {
		t.Fatalf("embedText returned %d chars, want <= %d", len(got), maxEmbedChars)
	}
	// the metadata prefix is the most identifying part; truncation must keep it
	if !strings.HasPrefix(got, "name: big\n## Notes\n") {
		t.Fatalf("truncation dropped the frontmatter/heading prefix: %.40q", got)
	}
}

// Ordinary content must pass through untouched.
func TestEmbedTextLeavesNormalSectionsAlone(t *testing.T) {
	got := embedText(map[string]any{"name": "n"}, Section{Heading: "H", Text: "short body"})
	if got != "name: n\n## H\nshort body" {
		t.Fatalf("unexpected rewrite: %q", got)
	}
}
