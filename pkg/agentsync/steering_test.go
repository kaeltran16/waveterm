// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestApplyRegionAppendsWhenAbsent(t *testing.T) {
	got := applyRegion("# Notes\n\nsome hand-written text\n", "canonical body")
	if !strings.HasPrefix(got, "# Notes\n\nsome hand-written text\n") {
		t.Fatalf("existing content not preserved: %q", got)
	}
	if !strings.Contains(got, steeringBegin) || !strings.Contains(got, "canonical body") {
		t.Fatalf("region not appended: %q", got)
	}
}

func TestApplyRegionInsertsBeforeMemoryRegion(t *testing.T) {
	existing := "# Prefs\n\n<!-- ARC-MEMORY:BEGIN project=waveterm -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	got := applyRegion(existing, "canonical body")
	steerAt := strings.Index(got, steeringBegin)
	memAt := strings.Index(got, memoryBeginMarker)
	if steerAt < 0 || memAt < 0 || steerAt > memAt {
		t.Fatalf("steering region must precede the memory region: steer=%d mem=%d\n%s", steerAt, memAt, got)
	}
	if !strings.Contains(got, "facts") {
		t.Fatal("memory region body was lost")
	}
}

func TestApplyRegionReplacesInPlaceAndIsIdempotent(t *testing.T) {
	existing := "# Prefs\n\n<!-- ARC-MEMORY:BEGIN project=waveterm -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	once := applyRegion(existing, "first")
	updated := applyRegion(once, "second")
	if strings.Contains(updated, "first") {
		t.Fatalf("stale body survived the replace: %q", updated)
	}
	if strings.Count(updated, steeringBegin) != 1 {
		t.Fatalf("region duplicated: %q", updated)
	}
	if again := applyRegion(updated, "second"); again != updated {
		t.Fatalf("not idempotent:\nfirst:  %q\nsecond: %q", updated, again)
	}
}

func TestBlockBeforeReturnsHandWrittenPrefix(t *testing.T) {
	existing := "# Prefs\nrule one\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	if got, want := blockBefore(existing), "# Prefs\nrule one\n"; strings.TrimSpace(got) != strings.TrimSpace(want) {
		t.Fatalf("blockBefore = %q, want %q", got, want)
	}
	if got := blockBefore("no markers here\n"); strings.TrimSpace(got) != "no markers here" {
		t.Fatalf("blockBefore without markers = %q", got)
	}
}

func TestRegionBodyExtractsOnlyTheManagedText(t *testing.T) {
	existing := applyRegion("# Mine\nkeep me\n", "rule one\nrule two")
	if got, want := regionBody(existing), "rule one\nrule two"; got != want {
		t.Fatalf("regionBody = %q, want %q", got, want)
	}
	if got := regionBody("# Mine\nno region here\n"); got != "" {
		t.Fatalf("regionBody without a region = %q, want empty", got)
	}
	// an unterminated region is malformed; report nothing rather than the rest of the file
	if got := regionBody(steeringBegin + "\nhalf a region\n"); got != "" {
		t.Fatalf("regionBody of an unterminated region = %q, want empty", got)
	}
}

func TestCarriedLinesFindsOnlyRealDifferences(t *testing.T) {
	shared := "# Prefs\n\n- rule one\n- rule two\n"
	block := "# Prefs\n\n- rule two\n- rule one\n- rule three\n\n"
	got := carriedLines(block, shared)
	if !reflect.DeepEqual(got, []string{"- rule three"}) {
		t.Fatalf("carriedLines = %#v, want only the genuinely missing rule", got)
	}
	if len(carriedLines("   \n\n"+shared, shared)) != 0 {
		t.Fatal("blank lines and reordering are not differences")
	}
}

func TestMemoryRegionIsEverythingFromTheMarker(t *testing.T) {
	existing := "# Mine\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n"
	if got := memoryRegion(existing); !strings.HasPrefix(got, memoryBeginMarker) || !strings.Contains(got, "facts") {
		t.Fatalf("memoryRegion = %q", got)
	}
	if got := memoryRegion("# Mine\n"); got != "" {
		t.Fatalf("memoryRegion without a region = %q, want empty", got)
	}
}

func TestJoinOwnKeepsExactlyOneBlankLine(t *testing.T) {
	tail := renderRegion("shared")
	if got := joinOwn("# Mine\n\n\n", tail); got != "# Mine\n\n"+tail {
		t.Fatalf("joinOwn = %q", got)
	}
	if got := joinOwn("", tail); got != tail {
		t.Fatalf("an empty own block must leave the tail alone: %q", got)
	}
	if got := joinOwn("# Mine\n", ""); got != "# Mine\n" {
		t.Fatalf("an empty tail must not add a trailing blank: %q", got)
	}
}

func TestReadHarnessSplitsTheWholeFileIntoZones(t *testing.T) {
	p := testPaths(t, "shared rules\n", ".codex")
	writeFile(t, filepath.Join(p.Home, ".codex", "AGENTS.md"),
		"# Mine\n- codex only\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n")

	pi, err := ReadHarness(p, "pi")
	if err != nil {
		t.Fatal(err)
	}
	if pi.Present {
		t.Fatalf("pi = %+v, want not present", pi)
	}

	before, err := ReadHarness(p, "codex")
	if err != nil {
		t.Fatal(err)
	}
	// the point of the rewrite: an unsynced harness still shows everything the user wrote in it
	if !strings.Contains(before.Own, "- codex only") {
		t.Fatalf("own zone = %q, want the harness's own rules", before.Own)
	}
	if before.Shared != "" || before.State != "absent" {
		t.Fatalf("before = %+v, want no shared region yet", before)
	}
	if !strings.Contains(before.Memory, "facts") {
		t.Fatalf("memory zone = %q, want the memory projection", before.Memory)
	}
	if before.Carried != 2 {
		t.Fatalf("carried = %d, want the two lines the shared doc lacks", before.Carried)
	}

	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	after, err := ReadHarness(p, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if after.State != "current" || after.Shared != "shared rules" {
		t.Fatalf("after = %+v, want the shared block current", after)
	}
	if !strings.Contains(after.Own, "- codex only") {
		t.Fatal("projecting must not disturb the harness's own zone")
	}
	if after.Mtime == 0 {
		t.Fatal("a present harness doc must carry an mtime for the conflict guard")
	}
}

func TestReadHarnessRejectsAnUnknownRuntime(t *testing.T) {
	p := testPaths(t, "shared\n", ".codex")
	if _, err := ReadHarness(p, "nope"); err == nil {
		t.Fatal("an unknown runtime must be an error, not an empty document")
	}
}

func TestWriteHarnessOwnLeavesManagedRegionsByteIdentical(t *testing.T) {
	p := testPaths(t, "shared rules\n", ".codex")
	target := filepath.Join(p.Home, ".codex", "AGENTS.md")
	writeFile(t, target, "# Mine\n\n<!-- ARC-MEMORY:BEGIN project=x -->\nfacts\n<!-- ARC-MEMORY:END -->\n")
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	before := readFile(t, target)
	managed := strings.TrimPrefix(before, blockBefore(before))

	doc, err := ReadHarness(p, "codex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := WriteHarnessOwn(p, "codex", "# Mine, edited\n", doc.Mtime); err != nil {
		t.Fatal(err)
	}
	after := readFile(t, target)
	if !strings.HasPrefix(after, "# Mine, edited\n") {
		t.Fatalf("own zone not written: %q", after)
	}
	if got := strings.TrimPrefix(after, blockBefore(after)); got != managed {
		t.Fatalf("managed regions changed:\n got %q\nwant %q", got, managed)
	}
}

func TestWriteHarnessOwnRefusesAStaleBase(t *testing.T) {
	p := testPaths(t, "shared\n", ".codex")
	target := filepath.Join(p.Home, ".codex", "AGENTS.md")
	writeFile(t, target, "# Mine\n")
	res, err := WriteHarnessOwn(p, "codex", "# Theirs\n", 1)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Conflict {
		t.Fatal("a stale base mtime must be reported as a conflict")
	}
	if got := readFile(t, target); got != "# Mine\n" {
		t.Fatalf("a refused write must change nothing: %q", got)
	}
}

func TestFoldIntoSharedSeedsThenAppends(t *testing.T) {
	p := testPaths(t, "", ".claude", ".pi/agent")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n\n- rule one\n")
	writeFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"), "# Prefs\n\n- rule one\n- pi only rule\n")

	first, err := FoldIntoShared(p, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if !first.Seeded {
		t.Fatalf("first fold = %+v, want a verbatim seed", first)
	}
	// verbatim, so the heading and blank line survive rather than a flattened line list
	if got := readFile(t, p.SteeringDoc); got != "# Prefs\n\n- rule one\n" {
		t.Fatalf("shared doc = %q, want the block verbatim", got)
	}
	// the rules reach the file as a region before they leave the own zone
	claude := readFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"))
	if strings.Count(claude, "- rule one") != 1 || !strings.Contains(claude, steeringBegin) {
		t.Fatalf("claude = %q, want exactly one copy, inside the region", claude)
	}
	if strings.TrimSpace(blockBefore(claude)) != "" {
		t.Fatalf("claude own zone not cleared: %q", blockBefore(claude))
	}

	second, err := FoldIntoShared(p, "pi")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(second.Lines, []string{"- pi only rule"}) {
		t.Fatalf("second fold = %+v, want only the rule pi uniquely holds", second)
	}
	shared := readFile(t, p.SteeringDoc)
	if !strings.Contains(shared, "## From Pi") || !strings.Contains(shared, "- pi only rule") {
		t.Fatalf("shared doc = %q, want pi's rule filed under its source", shared)
	}
	if strings.Count(shared, "- rule one") != 1 {
		t.Fatalf("a rule already shared must not be appended twice: %q", shared)
	}
	pi := readFile(t, filepath.Join(p.Home, ".pi", "agent", "AGENTS.md"))
	if strings.TrimSpace(blockBefore(pi)) != "" || !strings.Contains(pi, "- pi only rule") {
		t.Fatalf("pi = %q, want its own zone cleared and the rule back via the region", pi)
	}
}

func TestFoldIntoSharedIsANoOpTheSecondTime(t *testing.T) {
	p := testPaths(t, "", ".claude")
	writeFile(t, filepath.Join(p.Home, ".claude", "CLAUDE.md"), "# Prefs\n\n- rule one\n")
	if _, err := FoldIntoShared(p, "claude"); err != nil {
		t.Fatal(err)
	}
	before := readFile(t, p.SteeringDoc)
	again, err := FoldIntoShared(p, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Lines) != 0 {
		t.Fatalf("second fold = %+v, want nothing left to move", again)
	}
	if got := readFile(t, p.SteeringDoc); got != before {
		t.Fatalf("shared doc changed on a no-op fold:\n got %q\nwant %q", got, before)
	}
}
