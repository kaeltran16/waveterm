// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// seedSkill creates a canonical skill tree in the vault.
func seedSkill(t *testing.T, p Paths, name string) {
	t.Helper()
	writeFile(t, filepath.Join(p.SkillsRoot, name, skillFile), "---\nname: "+name+"\n---\nbody\n")
}

func TestSplitFrontmatterRoundTrips(t *testing.T) {
	doc := "---\nname: x\ndescription: |\n  line one\n  line two\ntool: codex\n---\n# Body\n\ntext\n"
	block, rest, ok := splitFrontmatter(doc)
	if !ok {
		t.Fatal("a fenced document must report frontmatter")
	}
	if got := "---\n" + block + "---\n" + rest; got != doc {
		t.Fatalf("round trip lost bytes:\n got %q\nwant %q", got, doc)
	}
	if _, _, ok := splitFrontmatter("# No fence\n"); ok {
		t.Error("a document without a fence has no frontmatter")
	}
	if _, _, ok := splitFrontmatter("---\nunterminated: yes\n"); ok {
		t.Error("an unterminated fence is not frontmatter")
	}
}

func TestParseFrontmatterEntriesKeepsMultilineValues(t *testing.T) {
	block := "name: x\ndescription: |\n  line one\n  line two\ntool: codex\n"
	got := parseFrontmatterEntries(block)
	if len(got) != 3 {
		t.Fatalf("entries = %#v, want three top-level keys", got)
	}
	if got[1].key != "description" || got[1].text != "description: |\n  line one\n  line two\n" {
		t.Fatalf("multi-line value not held verbatim: %q", got[1].text)
	}
	if entryText(got) != block {
		t.Fatalf("entries do not reassemble to the block: %q", entryText(got))
	}
}

// an indented line holding a colon is part of the value above, and a line before the first key has no entry to join
func TestParseFrontmatterEntriesIndentedColonsAndLeadingLines(t *testing.T) {
	block := "# leading note\nname: x\ndescription: |\n  sub: y\n\tdeep: z\ntool: codex\n"
	got := parseFrontmatterEntries(block)
	want := []fmEntry{
		{key: "name", text: "name: x\n"},
		{key: "description", text: "description: |\n  sub: y\n\tdeep: z\n"},
		{key: "tool", text: "tool: codex\n"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("entries = %#v, want %#v", got, want)
	}
}

func TestMergeFrontmatterReplacesInPlaceAndAppends(t *testing.T) {
	block := "name: x\ndescription: |\n  keep me\ntool: codex\n"
	got := mergeFrontmatter(block, parseFrontmatterEntries("tool: opencode\ncategory: orchestration\n"))
	want := "name: x\ndescription: |\n  keep me\ntool: opencode\ncategory: orchestration\n"
	if got != want {
		t.Fatalf("merge =\n%q\nwant\n%q", got, want)
	}
}

func TestApplyOverridesSynthesizesFrontmatterWhenAbsent(t *testing.T) {
	got := applyOverrides("# Just a body\n", parseFrontmatterEntries("tool: codex\n"))
	if got != "---\ntool: codex\n---\n# Just a body\n" {
		t.Fatalf("overrides dropped on an unfenced doc: %q", got)
	}
}

func TestRenderSkillAppliesDeltaAndNeverCopiesIt(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	dir := filepath.Join(p.SkillsRoot, "orchestrator")
	writeFile(t, filepath.Join(dir, skillFile), "---\nname: orchestrator\ntool: codex\n---\nshared body\n")
	writeFile(t, filepath.Join(dir, deltaDirName, "opencode.yaml"), "tool: opencode\n")
	writeFile(t, filepath.Join(dir, deltaDirName, "codex", "agents", "openai.yaml"), "display_name: Orchestrator\n")

	codex, err := renderSkill(p.SkillsRoot, "orchestrator", "codex")
	if err != nil {
		t.Fatal(err)
	}
	if string(codex[skillFile]) != "---\nname: orchestrator\ntool: codex\n---\nshared body\n" {
		t.Fatalf("codex SKILL.md = %q, want the shared text", codex[skillFile])
	}
	if string(codex[filepath.Join("agents", "openai.yaml")]) != "display_name: Orchestrator\n" {
		t.Fatalf("codex sidecar missing: %#v", keysOf(codex))
	}

	opencode, err := renderSkill(p.SkillsRoot, "orchestrator", "opencode")
	if err != nil {
		t.Fatal(err)
	}
	if string(opencode[skillFile]) != "---\nname: orchestrator\ntool: opencode\n---\nshared body\n" {
		t.Fatalf("opencode SKILL.md = %q, want the overridden tool key", opencode[skillFile])
	}
	if _, ok := opencode[filepath.Join("agents", "openai.yaml")]; ok {
		t.Error("codex's sidecar must not reach opencode")
	}
	for _, files := range []map[string][]byte{codex, opencode} {
		for rel := range files {
			if rel == deltaDirName || filepath.HasPrefix(rel, deltaDirName+string(filepath.Separator)) {
				t.Errorf("the delta directory was copied to a harness: %q", rel)
			}
		}
	}
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestReconcileSkillsWritesRealFilesAndIsIdempotent(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex", ".claude")
	seedSkill(t, p, "graphify")
	actions, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 2 {
		t.Fatalf("actions = %+v, want one write per present harness", actions)
	}
	for _, rel := range []string{filepath.Join(".codex", "skills", "graphify"), filepath.Join(".claude", "skills", "graphify")} {
		if got := readFile(t, filepath.Join(p.Home, rel, skillFile)); got != "---\nname: graphify\n---\nbody\n" {
			t.Errorf("%s SKILL.md = %q", rel, got)
		}
		if _, err := os.Stat(filepath.Join(p.Home, rel, managedMarkName)); err != nil {
			t.Errorf("%s carries no ownership mark: %v", rel, err)
		}
	}
	again, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("second reconcile = %+v, want no actions", again)
	}
	// pi has no fixed skills dir, so nothing is created for it even when its config root exists
	if _, err := os.Stat(filepath.Join(p.Home, ".pi", "agent", "skills")); !os.IsNotExist(err) {
		t.Error("pi must not get a skills directory")
	}
}

func TestReconcileSkillsNeverTouchesAnUnmanagedDirectory(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p, "graphify")
	occupied := filepath.Join(p.Home, ".codex", "skills", "graphify")
	writeFile(t, filepath.Join(occupied, skillFile), "mine\n")

	acts, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(acts) != 1 || acts[0].Kind != ActionSkillUnmanaged {
		t.Fatalf("actions = %+v, want a single unmanaged report", acts)
	}
	if got := readFile(t, filepath.Join(occupied, skillFile)); got != "mine\n" {
		t.Fatalf("the user's directory was modified: %q", got)
	}
}

func TestReconcileSkillsRemovesOnlyWhatItWrote(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p, "graphify")
	if _, err := reconcileSkills(p, false); err != nil {
		t.Fatal(err)
	}
	// the user's own directory beside a managed one; dropping the canonical skill must not take it
	mine := filepath.Join(p.Home, ".codex", "skills", "hand-written")
	writeFile(t, filepath.Join(mine, skillFile), "mine\n")
	if err := os.RemoveAll(filepath.Join(p.SkillsRoot, "graphify")); err != nil {
		t.Fatal(err)
	}
	acts, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(acts) != 1 || acts[0].Kind != ActionSkillRemove {
		t.Fatalf("actions = %+v, want a single removal", acts)
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".codex", "skills", "graphify")); !os.IsNotExist(err) {
		t.Error("the managed copy was not removed")
	}
	if got := readFile(t, filepath.Join(mine, skillFile)); got != "mine\n" {
		t.Fatalf("an unmanaged directory was removed with it: %q", got)
	}
}

func TestReconcileSkillsRewritesAnEditedCopy(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p, "graphify")
	if _, err := reconcileSkills(p, false); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(p.Home, ".codex", "skills", "graphify")
	writeFile(t, filepath.Join(target, skillFile), "edited away from canonical\n")
	writeFile(t, filepath.Join(target, "stray.txt"), "not in the render\n")
	acts, err := reconcileSkills(p, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(acts) != 1 || acts[0].Kind != ActionSkillWrite {
		t.Fatalf("actions = %+v, want a single rewrite", acts)
	}
	if got := readFile(t, filepath.Join(target, skillFile)); got != "---\nname: graphify\n---\nbody\n" {
		t.Fatalf("SKILL.md = %q, want the canonical text restored", got)
	}
	if _, err := os.Stat(filepath.Join(target, "stray.txt")); !os.IsNotExist(err) {
		t.Error("a file the render does not contain must be removed from a managed copy")
	}
}

func TestSkillRowsReportsPerHarnessState(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex", ".claude")
	seedSkill(t, p, "graphify")
	seedSkill(t, p, "initiatives")
	occupied := filepath.Join(p.Home, ".codex", "skills", "graphify")
	writeFile(t, filepath.Join(occupied, skillFile), "mine\n")
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]SkillRow{}
	for _, r := range rows {
		byName[r.Name] = r
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %+v, want one per canonical skill", rows)
	}
	if got := byName["graphify"].States["codex"]; got != stateUnmanaged {
		t.Errorf("graphify codex = %q, want unmanaged", got)
	}
	if got := byName["graphify"].States["claude"]; got != stateSynced {
		t.Errorf("graphify claude = %q, want synced", got)
	}
	if got := byName["initiatives"].States["codex"]; got != stateSynced {
		t.Errorf("initiatives codex = %q, want synced", got)
	}
}

func TestSkillRowsMarksAHarnessWithNoConfigRootAbsent(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	seedSkill(t, p, "graphify")
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	// claude has no config root here, so it is not synced at all
	if len(rows) != 1 || rows[0].States["claude"] != stateAbsent {
		t.Fatalf("rows = %+v, want claude absent", rows)
	}
}

func TestSkillRowsDiffersBeforeTheFirstApply(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	seedSkill(t, p, "graphify")
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].States["claude"] != stateDiffers {
		t.Fatalf("rows = %+v, want claude differing before the first Apply", rows)
	}
}

func TestSkillRowsReportsDeltas(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	dir := filepath.Join(p.SkillsRoot, "orchestrator")
	writeFile(t, filepath.Join(dir, skillFile), "---\nname: orchestrator\n---\nbody\n")
	writeFile(t, filepath.Join(dir, deltaDirName, "opencode.yaml"), "tool: opencode\n")
	writeFile(t, filepath.Join(dir, deltaDirName, "codex", "agents", "openai.yaml"), "display_name: x\n")
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %+v", rows)
	}
	if got := rows[0].Deltas["opencode"]; !reflect.DeepEqual(got, []string{"tool"}) {
		t.Errorf("opencode delta = %#v, want the overridden key", got)
	}
	if got := rows[0].Deltas["codex"]; !reflect.DeepEqual(got, []string{"agents/openai.yaml"}) {
		t.Errorf("codex delta = %#v, want the sidecar path", got)
	}
}

func TestSkillRowsReadsDescriptionFromFrontmatter(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	writeFile(t, filepath.Join(p.SkillsRoot, "graphify", skillFile),
		"---\nname: graphify\ndescription: turn any input into a knowledge graph\n---\n# Graphify\n")
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Description != "turn any input into a knowledge graph" {
		t.Fatalf("rows = %+v, want the frontmatter description", rows)
	}
}

func TestSkillRowsSurvivesAMissingSkillDoc(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	if err := os.MkdirAll(filepath.Join(p.SkillsRoot, "bare"), 0o755); err != nil {
		t.Fatal(err)
	}
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatalf("a skill directory without SKILL.md must not fail the read: %v", err)
	}
	if len(rows) != 1 || rows[0].Description != "" {
		t.Fatalf("rows = %+v, want one row with an empty description", rows)
	}
}

// ---- shipped skills ----

func shippedFS() fstest.MapFS {
	return fstest.MapFS{
		"runs/SKILL.md":              {Data: []byte("---\nname: runs\n---\nshipped\n")},
		"design/SKILL.md":            {Data: []byte("---\nname: design\n---\nshipped\n")},
		"design/reference/format.md": {Data: []byte("format\n")},
	}
}

func TestSeedShippedSkillsFillsAnEmptyRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "skills")
	if err := seedShippedSkills(root, shippedFS()); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(root, "design", "reference", "format.md")); got != "format\n" {
		t.Errorf("format.md = %q", got)
	}
	if got := readFile(t, filepath.Join(root, "runs", skillFile)); got != "---\nname: runs\n---\nshipped\n" {
		t.Errorf("runs SKILL.md = %q", got)
	}
	// the ownership mark belongs to harness dirs, never the vault
	if _, err := os.Stat(filepath.Join(root, "runs", managedMarkName)); !os.IsNotExist(err) {
		t.Error("seeding must not write the ownership mark into the vault")
	}
}

func TestSeedShippedSkillsOverwritesAStaleCopyAndDropsExtraFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "skills")
	writeFile(t, filepath.Join(root, "design", skillFile), "old\n")
	writeFile(t, filepath.Join(root, "design", "retired.md"), "gone\n")
	if err := seedShippedSkills(root, shippedFS()); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(root, "design", skillFile)); got != "---\nname: design\n---\nshipped\n" {
		t.Errorf("SKILL.md = %q, want the shipped copy", got)
	}
	if _, err := os.Stat(filepath.Join(root, "design", "retired.md")); !os.IsNotExist(err) {
		t.Error("a file the shipped tree does not have must be removed")
	}
}

func TestSeedShippedSkillsKeepsTheDeltaDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "skills")
	delta := filepath.Join(root, "runs", deltaDirName, "codex.yaml")
	writeFile(t, delta, "description: codex wording\n")
	if err := seedShippedSkills(root, shippedFS()); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, delta); got != "description: codex wording\n" {
		t.Errorf("delta = %q, want it preserved", got)
	}
}

func TestSeedShippedSkillsWritesNothingWhenIdentical(t *testing.T) {
	root := filepath.Join(t.TempDir(), "skills")
	if err := seedShippedSkills(root, shippedFS()); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "runs", skillFile)
	past := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatal(err)
	}
	if err := seedShippedSkills(root, shippedFS()); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !st.ModTime().Equal(past) {
		t.Errorf("mtime = %v, want %v: an identical skill must not be rewritten", st.ModTime(), past)
	}
}

func TestApplySeedsShippedSkillsOnlyWhenNotDryRun(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	p.Shipped = shippedFS()
	if _, err := Apply(p, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(p.SkillsRoot, "runs")); !os.IsNotExist(err) {
		t.Fatal("a dry run must not seed the vault")
	}
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	// seeded before the reconcile, so the same Apply projects it into the harness
	if got := readFile(t, filepath.Join(p.Home, ".codex", "skills", "runs", skillFile)); got != "---\nname: runs\n---\nshipped\n" {
		t.Errorf("codex runs SKILL.md = %q", got)
	}
}

func TestApplyLeavesShippedSkillsToTheClaudePlugin(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	p.Shipped = shippedFS()
	seedSkill(t, p, "graphify")
	// a copy an earlier Arc projected before the plugin carried the shipped skills
	stale := filepath.Join(p.Home, ".claude", "skills", "runs")
	writeFile(t, filepath.Join(stale, skillFile), "old\n")
	writeFile(t, filepath.Join(stale, managedMarkName), "")
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("a shipped skill Arc wrote into claude's skills dir must be removed: the plugin carries it")
	}
	if _, err := os.Stat(filepath.Join(p.Home, ".claude", "skills", "graphify", skillFile)); err != nil {
		t.Errorf("a vault skill Arc does not ship must still reach claude: %v", err)
	}
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, r := range rows {
		states[r.Name] = r.States["claude"]
	}
	if states["runs"] != statePlugin || states["graphify"] != stateSynced {
		t.Errorf("claude states = %v, want runs from the plugin and graphify synced", states)
	}
}

func TestSeedShippedSkillsRemovesRetiredNames(t *testing.T) {
	p := testPaths(t, "canonical\n", ".codex")
	p.Shipped = shippedFS()
	seedSkill(t, p, "cockpit-runs")
	retired := filepath.Join(p.Home, ".codex", "skills", "cockpit-runs")
	writeFile(t, filepath.Join(retired, skillFile), "---\nname: cockpit-runs\n---\nbody\n")
	writeFile(t, filepath.Join(retired, managedMarkName), "")
	if _, err := Apply(p, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(p.SkillsRoot, "cockpit-runs")); !os.IsNotExist(err) {
		t.Error("a skill Arc no longer ships under that name must leave the vault")
	}
	if _, err := os.Stat(retired); !os.IsNotExist(err) {
		t.Error("the harness copy Arc wrote for a retired name must be removed")
	}
}

// ---- links ----

// makeJunction links link to target with a Windows directory junction, skipping where the OS refuses.
func makeJunction(t *testing.T, link, target string) {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("junctions are Windows-only")
	}
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("the OS refused a junction: %v %s", err, out)
	}
}

// makeSymlink links link to target with a symlink, skipping where the OS refuses (Windows without
// developer mode).
func makeSymlink(t *testing.T, link, target string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("the OS refused a symlink: %v", err)
	}
}

// makeDirLink links with whatever this OS creates without privileges: a junction on Windows.
func makeDirLink(t *testing.T, link, target string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		makeJunction(t, link, target)
		return
	}
	makeSymlink(t, link, target)
}

// linkedSkill makes a skill tree outside every harness and links it into dir under name.
func linkedSkill(t *testing.T, p Paths, dir, name string) (link, target string) {
	t.Helper()
	target = filepath.Join(p.Home, "elsewhere", name)
	writeFile(t, filepath.Join(target, skillFile), "---\nname: "+name+"\n---\nmine, linked\n")
	link = filepath.Join(dir, name)
	makeDirLink(t, link, target)
	return link, target
}

func TestObserveSkillsLinkedEntry(t *testing.T) {
	for _, tc := range []struct {
		name string
		link func(t *testing.T, link, target string)
	}{{"junction", makeJunction}, {"symlink", makeSymlink}} {
		t.Run(tc.name, func(t *testing.T) {
			p := testPaths(t, "", ".claude")
			dir := filepath.Join(p.Home, ".claude", "skills")
			target := filepath.Join(p.Home, "elsewhere", "graphify")
			writeFile(t, filepath.Join(target, skillFile), "mine\n")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			tc.link(t, filepath.Join(dir, "graphify"), target)
			observed, err := observeSkills(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(observed) != 1 {
				t.Fatalf("observed = %+v, want the link", observed)
			}
			e := observed[0]
			if !e.Linked || e.Managed || e.Target == "" {
				t.Fatalf("entry = %+v, want linked, not managed, with its target", e)
			}
		})
	}
}

// a junction left pointing at a folder that has since moved must fail nothing, and is no skill
func TestObserveSkillsDanglingLink(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	dir := filepath.Join(p.Home, ".claude", "skills")
	link, target := linkedSkill(t, p, dir, "graphify")
	if err := os.RemoveAll(target); err != nil {
		t.Fatal(err)
	}
	observed, err := observeSkills(dir)
	if err != nil {
		t.Fatalf("a dangling link failed the read: %v", err)
	}
	for _, e := range observed {
		if e.Name == "graphify" && (e.Managed || !e.Linked) {
			t.Fatalf("entry = %+v: a dangling link is a link, never a skill", e)
		}
	}
	// the vault has a skill of the same name: still no write through it, and nothing fails
	seedSkill(t, p, "graphify")
	if _, err := Status(p); err != nil {
		t.Fatalf("Status: %v", err)
	}
	if _, err := SkillRows(p); err != nil {
		t.Fatalf("SkillRows: %v", err)
	}
	if plan, err := PlanAdopt(p, nil, nil); err != nil || len(plan.Moves) != 0 {
		t.Fatalf("PlanAdopt = %+v, %v: want no move and no error", plan, err)
	}
	if _, err := Apply(p, false); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("the reconcile recreated the link's target: %v", err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatalf("the link itself was removed: %v", err)
	}
}

func TestReconcileNeverWritesThroughLink(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	seedSkill(t, p, "graphify")
	_, target := linkedSkill(t, p, filepath.Join(p.Home, ".claude", "skills"), "graphify")
	before := readFile(t, filepath.Join(target, skillFile))

	acts, err := Apply(p, false)
	if err != nil {
		t.Fatal(err)
	}
	var linked int
	for _, a := range acts {
		if a.Kind == ActionSkillWrite {
			t.Fatalf("actions = %+v: a write through the link", acts)
		}
		if a.Kind == ActionSkillLinked {
			linked++
		}
	}
	if linked != 1 {
		t.Fatalf("actions = %+v, want the link reported once", acts)
	}
	if got := readFile(t, filepath.Join(target, skillFile)); got != before {
		t.Fatalf("the link target's SKILL.md changed: %q", got)
	}
	if _, err := os.Stat(filepath.Join(target, managedMarkName)); !os.IsNotExist(err) {
		t.Error("the ownership mark was written through the link")
	}
}

func TestSkillRowsLinkedState(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude")
	seedSkill(t, p, "graphify")
	linkedSkill(t, p, filepath.Join(p.Home, ".claude", "skills"), "graphify")
	rows, err := SkillRows(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].States["claude"] != stateLinked {
		t.Fatalf("rows = %+v, want claude linked", rows)
	}
}

func TestSkillLinksListsNonVaultLinks(t *testing.T) {
	p := testPaths(t, "canonical\n", ".claude", ".codex")
	seedSkill(t, p, "graphify")
	dir := filepath.Join(p.Home, ".claude", "skills")
	linkedSkill(t, p, dir, "graphify")
	link, target := linkedSkill(t, p, dir, "notes")
	writeFile(t, filepath.Join(p.Home, ".codex", "skills", "plain", skillFile), "mine\n")

	links, err := SkillLinks(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(links) != 1 || links[0].Runtime != "claude" || links[0].Name != "notes" || links[0].Path != link {
		t.Fatalf("links = %+v, want only claude's non-vault link notes at %s", links, link)
	}
	// a junction's target may read back with the \??\ NT prefix
	if !strings.EqualFold(filepath.Clean(strings.TrimPrefix(links[0].Target, `\??\`)), filepath.Clean(target)) {
		t.Fatalf("target = %q, want %q", links[0].Target, target)
	}
}
