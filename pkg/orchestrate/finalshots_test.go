// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func writeShotFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeShotsManifest(t *testing.T, dir string, shots []waveobj.FinalShot) {
	t.Helper()
	data, err := json.Marshal(shots)
	if err != nil {
		t.Fatal(err)
	}
	writeShotFile(t, dir, shotsManifestName, string(data))
}

// pngsOutDir is an out dir with nested PNGs and a file that is not one.
func pngsOutDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, rel := range []string{"cdp-shots/b-board.png", "cdp-shots/a-agents.png", "top.PNG", "cdp-shots/index.html"} {
		writeShotFile(t, dir, rel, "x")
	}
	return dir
}

var pngsListing = []waveobj.FinalShot{
	{Name: "a-agents", Files: []string{"cdp-shots/a-agents.png"}},
	{Name: "b-board", Files: []string{"cdp-shots/b-board.png"}},
	{Name: "top", Files: []string{"top.PNG"}},
}

var sampleShots = []waveobj.FinalShot{
	{Name: "board", Files: []string{"cdp-shots/board-1.png", "cdp-shots/board-2.png"}, Steps: []waveobj.FinalShotStep{
		{Step: "open the board", State: "pass"},
		{Step: "filter by failed", State: "fail", Detail: "the count is missing"},
		{Step: "close", State: "skip"},
	}},
	{Name: "threw", Files: []string{}, Steps: []waveobj.FinalShotStep{{Step: "scenario", State: "fail", Detail: "TypeError: x is undefined"}}},
}

func TestReadFinalShotsManifest(t *testing.T) {
	dir := pngsOutDir(t)
	writeShotsManifest(t, dir, sampleShots)

	shots, manifest := readFinalShots("dag-m", dir)

	if !manifest || !reflect.DeepEqual(shots, sampleShots) {
		t.Fatalf("a valid manifest is used as-is, got manifest=%v %+v", manifest, shots)
	}
}

func TestReadFinalShotsPlainListing(t *testing.T) {
	shots, manifest := readFinalShots("dag-p", pngsOutDir(t))

	if manifest || !reflect.DeepEqual(shots, pngsListing) {
		t.Fatalf("with no manifest every PNG is one shot, sorted by path, got manifest=%v %+v", manifest, shots)
	}
	if shots, manifest := readFinalShots("dag-p", filepath.Join(t.TempDir(), "never-made")); manifest || len(shots) != 0 {
		t.Fatalf("a missing out dir has no shots, got manifest=%v %+v", manifest, shots)
	}
}

func TestReadFinalShotsBadManifestFallsBack(t *testing.T) {
	badState := []waveobj.FinalShot{{Name: "board", Files: []string{"cdp-shots/b-board.png"}, Steps: []waveobj.FinalShotStep{{Step: "open", State: "passed"}}}}
	badStateJSON, err := json.Marshal(badState)
	if err != nil {
		t.Fatal(err)
	}
	oversized, err := json.Marshal([]waveobj.FinalShot{{Name: strings.Repeat("x", maxShotsManifestBytes), Files: []string{"top.PNG"}}})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"malformed":  `[{"name": "board", "files": [`,
		"not a list": `{"name": "board"}`,
		"oversized":  string(oversized),
		"bad state":  string(badStateJSON),
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			dir := pngsOutDir(t)
			writeShotFile(t, dir, shotsManifestName, content)

			shots, manifest := readFinalShots("dag-b", dir)

			if manifest || !reflect.DeepEqual(shots, pngsListing) {
				t.Fatalf("an unusable manifest falls back to the PNG listing, got manifest=%v %+v", manifest, shots)
			}
		})
	}
}

func TestReadFinalShotsDropsEscapingPaths(t *testing.T) {
	dir := t.TempDir()
	writeShotsManifest(t, dir, []waveobj.FinalShot{
		{Name: "board", Files: []string{"../x.png", "C:/x.png", "/x.png", `c:\x.png`, `..\x.png`, "a/../../x.png", "cdp-shots/./board.png"}},
		{Name: "gone", Files: []string{"../../etc/passwd"}, Steps: []waveobj.FinalShotStep{{Step: "open", State: "pass"}}},
	})

	shots, manifest := readFinalShots("dag-e", dir)

	want := []waveobj.FinalShot{
		{Name: "board", Files: []string{"cdp-shots/board.png"}},
		{Name: "gone", Files: []string{}, Steps: []waveobj.FinalShotStep{{Step: "open", State: "pass"}}},
	}
	if !manifest || !reflect.DeepEqual(shots, want) {
		t.Fatalf("paths outside the out dir are dropped and a scenario left with none keeps its steps, got manifest=%v %+v", manifest, shots)
	}
}

func TestFinalStageRecordsShots(t *testing.T) {
	data, err := json.Marshal(sampleShots)
	if err != nil {
		t.Fatal(err)
	}
	write := `printf '%s' '` + string(data) + `' > "$ARC_FINAL_OUT/shots.json"`
	cases := []struct {
		name  string
		exit  string
		state string
	}{
		{"passing", "exit 0", FinalState_Passed},
		{"failing", "exit 1", FinalState_Failed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := finalFixture(t, passVerify, "", write+"; "+c.exit)

			g := runFinal(t, f)

			if g.Final.State != c.state {
				t.Fatalf("want %s, got %s %q", c.state, g.Final.State, g.Final.Detail)
			}
			if !g.Final.ShotsManifest || !reflect.DeepEqual(g.Final.Shots, sampleShots) {
				t.Fatalf("the manifest is stored on the stage whatever the exit, got manifest=%v %+v", g.Final.ShotsManifest, g.Final.Shots)
			}
			if want := filepath.ToSlash(filepath.Join(finalShotsRoot(), f.dagID, "1")); g.Final.OutDir != want {
				t.Fatalf("ARC_FINAL_OUT is under the data dir, want %s got %s", want, g.Final.OutDir)
			}
		})
	}
}

func TestAppendRoundKeepsThePastFinal(t *testing.T) {
	f, _ := failedFinalFixture(t, 1)
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Final.Shots, cur.Final.ShotsManifest = sampleShots, true
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := AppendRound(f.ctx, f.dagID, "docs/fix.md", fixPlanTasks(t)); err != nil {
		t.Fatal(err)
	}

	g := f.dag(t)
	if len(g.PastFinals) != 1 {
		t.Fatalf("the failed round is kept, got %d past finals", len(g.PastFinals))
	}
	past := g.PastFinals[0]
	if past.Round != 1 || past.State != FinalState_Failed || past.Detail != "FAIL board-layout" || !past.ShotsManifest || !reflect.DeepEqual(past.Shots, sampleShots) {
		t.Fatalf("past final is round 1 as it finished, with its shots, got %+v", past)
	}
	if g.Final.Round != 2 || len(g.Final.Shots) != 0 {
		t.Fatalf("the new round starts clean, got %+v", g.Final)
	}
}

func TestSweepFinalShotsDropsOldRounds(t *testing.T) {
	root := t.TempDir()
	orig := finalShotsRoot
	finalShotsRoot = func() string { return root }
	t.Cleanup(func() { finalShotsRoot = orig })
	now := time.Now()
	age := func(rel string, d time.Duration) {
		t.Helper()
		writeShotFile(t, root, rel+"/cdp-shots/board.png", "x")
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.Chtimes(p, now.Add(-d), now.Add(-d)); err != nil {
			t.Fatal(err)
		}
	}
	day := 24 * time.Hour
	age("dag-old/1", 31*day)
	age("dag-old/2", 40*day)
	age("dag-mixed/1", 31*day)
	age("dag-mixed/2", day)

	SweepFinalShots(now)

	for rel, want := range map[string]bool{"dag-old": false, "dag-mixed/1": false, "dag-mixed/2": true} {
		_, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		if exists := err == nil; exists != want {
			t.Errorf("%s: want exists=%v, stat err %v", rel, want, err)
		}
	}
}
