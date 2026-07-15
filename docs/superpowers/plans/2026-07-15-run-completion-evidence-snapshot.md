# Run Completion — Evidence Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a run finishes cleanly, show a sealed, immutable "evidence snapshot" (completion summary, files touched, verification results, artifacts, timing) plus a phase-history timeline — derived server-side and frozen at completion.

**Architecture:** Add fields to the JSON-embedded `Run`/`RunPhase` waveobj types (no migration). A pure-where-possible `jarvis.SealEvidence` derives the snapshot from worker transcripts (`pkg/agentobserve` parsing pattern) + git (`pkg/gitinfo`), and is called (a) at the non-done→done transition in `AdvanceRunCommand`, and (b) by an idempotent `SealRunEvidenceCommand` the frontend fires to backfill pre-feature runs. The frontend renders the sealed record in a new `RunCompletion` surface that replaces `RunBody`'s terminal phase-rail view.

**Tech Stack:** Go (wavesrv, `pkg/jarvis`, `pkg/waveobj`, `pkg/wshrpc`), TypeScript + React 19 + Tailwind 4 + jotai (`frontend/app/view/agents`), Task codegen (`task generate`), vitest (frontend), `go test` (backend).

**Visual source of truth:** `wave-handoff/wave/project/Wave-run-completion.dc.html` (the Claude Design prototype; read it directly for exact layout/spacing/copy — do not render it). Recreate it in React; map its raw hex to `@theme` tokens per Global Constraints. The DC file's `<helmet>` Google-Fonts `<link>` and inline `font-family` are prototype-only — the app supplies its own fonts; the React port uses the cockpit's existing font stack (`font-mono` for the JetBrains-Mono labels), never the Google Fonts import.

## Global Constraints

- **No hand-editing generated files.** Go is the source of truth for wire/object types. After changing `pkg/waveobj` or `pkg/wshrpc/wshrpctypes.go`, run `task generate` to regenerate `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, and `frontend/types/gotypes.d.ts`.
- **No DB migration.** `Run` is embedded in `Channel.Runs` (JSON), so new `Run`/`RunPhase` fields need no migration — Go struct change + `task generate` only.
- **No raw hex colors / no new SCSS.** Map to existing `@theme` tokens in `frontend/tailwindsetup.css`; add new `--color-*` tokens there when a color is genuinely new. Use Tailwind utilities, never inline hex.
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0).
- **Backend rebuild:** after Go changes, `task build:backend` (dev app picks up regenerated TS on Vite HMR).
- **Copyright header** on every new Go/TS file:
  ```
  // Copyright 2026, Command Line Inc.
  // SPDX-License-Identifier: Apache-2.0
  ```
- **Verification is evidence-only:** list only commands that actually ran; `unknown` = ran-but-indeterminate. Never invent an "expected set".
- **Scope:** `done` runs only. No failed/cancelled evidence variants.

---

## Task 1: Data model + phase/run timestamps

**Files:**
- Modify: `pkg/waveobj/wtype.go:223-247` (add fields + evidence structs)
- Modify: `pkg/jarvis/run.go:84-159,219-251` (thread `ts` into phase-state transitions)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1864-1879` (pass `ts` from `applyRunAction`)
- Test: `pkg/jarvis/run_test.go`

**Interfaces:**
- Produces (Go, `pkg/waveobj`):
  ```go
  type RunEvidence struct {
      CapturedTs int64              `json:"capturedts"`
      Hash       string             `json:"hash"`
      Summary    string             `json:"summary,omitempty"`
      Files      []EvidenceFile     `json:"files,omitempty"`
      AddTotal   int                `json:"addtotal"`
      DelTotal   int                `json:"deltotal"`
      Verifs     []EvidenceVerif    `json:"verifs,omitempty"`
      Artifacts  []EvidenceArtifact `json:"artifacts,omitempty"`
      RuntimeMs  int64              `json:"runtimems"`
      DurationMs int64              `json:"durationms"`
  }
  type EvidenceFile struct {
      Path string `json:"path"`
      Stat string `json:"stat"` // "A" | "M" | "D"
      Add  int    `json:"add"`
      Del  int    `json:"del"`
      By   string `json:"by,omitempty"`
  }
  type EvidenceVerif struct {
      Cmd    string `json:"cmd"`
      Result string `json:"result"` // "pass" | "fail" | "unknown"
      Detail string `json:"detail,omitempty"`
  }
  type EvidenceArtifact struct {
      Path string `json:"path"`
      Kind string `json:"kind"` // "doc" | "report" | "image" | "file"
      Size int64  `json:"size"`
  }
  ```
- Produces: `Run.CompletedTs int64`, `Run.Evidence *RunEvidence`, `RunPhase.StartedTs int64`, `RunPhase.DoneTs int64`.
- Produces: `jarvis.CompletePhase(run, phaseIdx, artifacts, ts)` (added `ts int64` param), `jarvis.ApproveGate(run, ts)`, `jarvis.SendBackGate(run, ts)`.

- [ ] **Step 1: Add the evidence structs + Run/RunPhase fields**

In `pkg/waveobj/wtype.go`, extend `RunPhase` (after `Artifacts` at line 232):
```go
	Artifacts   []string     `json:"artifacts,omitempty"`
	StartedTs   int64        `json:"startedts,omitempty"` // set when the phase enters running
	DoneTs      int64        `json:"donets,omitempty"`    // set when the phase completes
```
Extend `Run` (after `CreatedTs` at line 246):
```go
	CreatedTs   int64           `json:"createdts"`
	CompletedTs int64           `json:"completedts,omitempty"` // set at seal, when Status becomes done
	Evidence    *RunEvidence    `json:"evidence,omitempty"`    // sealed once at completion; immutable
```
Add the four evidence structs (from Interfaces above) immediately after the `Run` struct.

- [ ] **Step 2: Write the failing test for timestamp recording**

In `pkg/jarvis/run_test.go`, add:
```go
func TestCompletePhaseRecordsTimestamps(t *testing.T) {
	r := NewRun("g", "ws", "/p", nil, RunMode_Pipeline, DefaultPlaybook(), 1000)
	if r.Phases[0].StartedTs != 1000 {
		t.Fatalf("first phase StartedTs = %d, want 1000", r.Phases[0].StartedTs)
	}
	r, err := CompletePhase(r, 0, nil, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if r.Phases[0].DoneTs != 2000 {
		t.Fatalf("phase0 DoneTs = %d, want 2000", r.Phases[0].DoneTs)
	}
	if r.Phases[1].StartedTs != 2000 {
		t.Fatalf("phase1 StartedTs = %d, want 2000 (successor start)", r.Phases[1].StartedTs)
	}
}
```

- [ ] **Step 3: Run it, verify it fails to compile**

Run: `go test ./pkg/jarvis/ -run TestCompletePhaseRecordsTimestamps`
Expected: FAIL — `CompletePhase` takes 3 args / `StartedTs` undefined.

- [ ] **Step 4: Thread `ts` through the engine transitions**

In `pkg/jarvis/run.go`:
- `NewRun` (line ~88): set `phases[0].StartedTs = ts` where it marks the first phase running.
- `CompletePhase` — change signature and body:
  ```go
  func CompletePhase(run waveobj.Run, phaseIdx int, artifacts []string, ts int64) (waveobj.Run, error) {
      if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
          return run, fmt.Errorf("phase index %d out of range", phaseIdx)
      }
      if run.Phases[phaseIdx].State != PhaseState_Running {
          return run, fmt.Errorf("phase %d is %q, not running", phaseIdx, run.Phases[phaseIdx].State)
      }
      run.Phases[phaseIdx].State = PhaseState_Done
      run.Phases[phaseIdx].DoneTs = ts
      run.Phases[phaseIdx].Artifacts = append(run.Phases[phaseIdx].Artifacts, artifacts...)
      if !run.Phases[phaseIdx].Gate && phaseIdx+1 < len(run.Phases) {
          run.Phases[phaseIdx+1].State = PhaseState_Running
          run.Phases[phaseIdx+1].StartedTs = ts
      }
      recomputeStatus(&run)
      return run, nil
  }
  ```
- `ApproveGate(run, ts)` — when it starts `run.Phases[gi+1]`, also `run.Phases[gi+1].StartedTs = ts`.
- `SendBackGate(run, ts)` — when it re-opens `run.Phases[gi]`, set `run.Phases[gi].StartedTs = ts`.

- [ ] **Step 5: Update the engine callers**

In `pkg/wshrpc/wshserver/wshserver.go`, `applyRunAction` (line 1864) — pass a timestamp. Change its signature to accept `ts int64` and thread it:
```go
func applyRunAction(r waveobj.Run, data wshrpc.CommandAdvanceRunData, ts int64) (waveobj.Run, error) {
	switch data.Action {
	case jarvis.RunAction_Complete:
		return jarvis.CompletePhase(r, data.PhaseIdx, data.Artifacts, ts)
	case jarvis.RunAction_Approve:
		return jarvis.ApproveGate(r, ts)
	case jarvis.RunAction_SendBack:
		return jarvis.SendBackGate(r, ts)
	case jarvis.RunAction_Hold:
		return jarvis.HoldPhase(r, data.PhaseIdx, data.Artifacts)
	case jarvis.RunAction_Triage:
		return jarvis.RecordTriage(r, data.PhaseIdx, data.Verdict, data.Note)
	default:
		return r, fmt.Errorf("unknown run action %q", data.Action)
	}
}
```
In `AdvanceRunCommand` (line 1897), capture `ts` once and pass it in:
```go
	ts := time.Now().UnixMilli()
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		next, e := applyRunAction(*r, data, ts)
		if e != nil {
			return e
		}
		*r = next
		return nil
	})
```
(Confirm `time` is imported in wshserver.go — it is; used elsewhere.)
Fix any other `CompletePhase`/`ApproveGate`/`SendBackGate` callers the compiler flags (search `jarvis.CompletePhase(`, `jarvis.ApproveGate(`, `jarvis.SendBackGate(` across the repo) by passing an appropriate `ts` (a test caller can pass a fixed literal).

- [ ] **Step 6: Run the test, verify it passes; run the package**

Run: `go test ./pkg/jarvis/`
Expected: PASS (all existing tests + the new one). Fix existing `run_test.go` calls that now need the `ts` arg (pass a literal like `0` where the value is irrelevant to that test's assertions).

- [ ] **Step 7: Regenerate bindings + build**

Run: `task generate && task build:backend`
Expected: exit 0; `frontend/types/gotypes.d.ts` now shows `RunEvidence`, `EvidenceFile`, `EvidenceVerif`, `EvidenceArtifact`, and the new `Run`/`RunPhase` fields.

- [ ] **Step 8: Commit**

```bash
git add pkg/waveobj/wtype.go pkg/jarvis/run.go pkg/jarvis/run_test.go pkg/wshrpc/wshserver/wshserver.go frontend/types/gotypes.d.ts pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts
git commit -m "feat(runs): add run/phase timestamps + evidence-snapshot types"
```

---

## Task 2: Evidence derivation helpers (pure)

**Files:**
- Create: `pkg/jarvis/evidence.go`
- Test: `pkg/jarvis/evidence_test.go`

**Interfaces:**
- Consumes: `waveobj.EvidenceFile/EvidenceVerif/EvidenceArtifact` (Task 1).
- Produces (all pure — operate on already-read strings/paths, no I/O):
  ```go
  func classifyVerif(command string, resultText string, isError bool) (kind string, result string, ok bool)
  func parseNumstatStatus(numstat, statusZ string) []waveobj.EvidenceFile
  func artifactKind(path string) string        // "doc"|"report"|"image"|"file"
  func evidenceHash(ev waveobj.RunEvidence) string
  func finalAssistantText(lines []string) string
  func verificationCommands(lines []string) []waveobj.EvidenceVerif
  ```

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvis/evidence_test.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "testing"

func TestClassifyVerif(t *testing.T) {
	cases := []struct {
		cmd       string
		isError   bool
		wantMatch bool
		wantRes   string
	}{
		{"pnpm test coupons", false, true, "pass"},
		{"pnpm typecheck", true, true, "fail"},
		{"npm run lint", false, true, "pass"},
		{"go test ./...", true, true, "fail"},
		{"ls -la", false, false, ""},              // not a verification command
		{"echo hi && pnpm test", false, true, "pass"},
	}
	for _, c := range cases {
		_, res, ok := classifyVerif(c.cmd, "", c.isError)
		if ok != c.wantMatch {
			t.Errorf("classifyVerif(%q) match=%v, want %v", c.cmd, ok, c.wantMatch)
		}
		if ok && res != c.wantRes {
			t.Errorf("classifyVerif(%q) result=%q, want %q", c.cmd, res, c.wantRes)
		}
	}
}

func TestParseNumstatStatus(t *testing.T) {
	numstat := "96\t0\tcomponents/CouponInput.tsx\n41\t12\tlib/cart/totals.ts\n"
	statusZ := "A  components/CouponInput.tsx\x00 M lib/cart/totals.ts\x00"
	files := parseNumstatStatus(numstat, statusZ)
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2", len(files))
	}
	if files[0].Stat != "A" || files[0].Add != 96 || files[0].Del != 0 {
		t.Errorf("file0 = %+v", files[0])
	}
	if files[1].Stat != "M" || files[1].Add != 41 || files[1].Del != 12 {
		t.Errorf("file1 = %+v", files[1])
	}
}

func TestArtifactKind(t *testing.T) {
	for path, want := range map[string]string{
		"docs/coupon-design.md":          "doc",
		"coverage/coupons.html":          "report",
		"screenshots/checkout.png":       "image",
		"build/out.bin":                  "file",
	} {
		if got := artifactKind(path); got != want {
			t.Errorf("artifactKind(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestFinalAssistantText(t *testing.T) {
	lines := []string{
		`{"type":"user","message":{"content":"go"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"t1"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"all done, shipped it"}]}}`,
	}
	if got := finalAssistantText(lines); got != "all done, shipped it" {
		t.Errorf("finalAssistantText = %q", got)
	}
}

func TestVerificationCommandsDedupesAndClassifies(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b1","input":{"command":"pnpm typecheck"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b1","is_error":false,"content":"0 errors"}]}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"b2","input":{"command":"pnpm test"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b2","is_error":true,"content":"1 failing"}]}}`,
	}
	v := verificationCommands(lines)
	if len(v) != 2 {
		t.Fatalf("got %d verifs, want 2", len(v))
	}
	if v[0].Result != "pass" || v[1].Result != "fail" {
		t.Errorf("results = %q,%q", v[0].Result, v[1].Result)
	}
}

func TestEvidenceHashStable(t *testing.T) {
	ev := waveobj.RunEvidence{Summary: "x", AddTotal: 3}
	if evidenceHash(ev) != evidenceHash(ev) {
		t.Error("hash not stable for identical input")
	}
}
```

- [ ] **Step 2: Run, verify it fails**

Run: `go test ./pkg/jarvis/ -run 'Verif|Numstat|ArtifactKind|FinalAssistant|EvidenceHash'`
Expected: FAIL — undefined functions.

- [ ] **Step 3: Implement `evidence.go`**

Create `pkg/jarvis/evidence.go`:
```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// verifPattern matches a shell command that is a verification step (test / lint / typecheck / build).
// Evidence-only: a command that does not match is simply not reported (we never invent expected steps).
var verifPattern = regexp.MustCompile(`\b(test|typecheck|tsc|lint|vitest|jest|pytest|go test|cargo test|build|e2e|smoke)\b`)

// classifyVerif reports whether command is a verification step and, if so, its pass/fail/unknown result.
// resultText is the tool_result body (unused for now beyond emptiness); isError is the tool_result flag.
func classifyVerif(command, resultText string, isError bool) (cmd string, result string, ok bool) {
	command = strings.TrimSpace(command)
	if command == "" || !verifPattern.MatchString(command) {
		return "", "", false
	}
	switch {
	case isError:
		return command, "fail", true
	case strings.TrimSpace(resultText) == "":
		return command, "unknown", true // ran but produced no captured result
	default:
		return command, "pass", true
	}
}

// content block with the fields evidence needs (superset of agentobserve's internal block).
type evBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Text      string          `json:"text"`
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
	Content   json.RawMessage `json:"content"` // tool_result body (string or blocks)
	Input     struct {
		Command string `json:"command"`
	} `json:"input"`
}

type evRecord struct {
	Type    string `json:"type"`
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

func evBlocks(line string) (string, []evBlock) {
	var rec evRecord
	if json.Unmarshal([]byte(strings.TrimSpace(line)), &rec) != nil {
		return "", nil
	}
	var blocks []evBlock
	if json.Unmarshal(rec.Message.Content, &blocks) != nil {
		return rec.Type, nil
	}
	return rec.Type, blocks
}

// finalAssistantText returns the text of the last assistant message that carried a text block.
func finalAssistantText(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		typ, blocks := evBlocks(lines[i])
		if typ != "assistant" {
			continue
		}
		var text strings.Builder
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				if text.Len() > 0 {
					text.WriteString("\n")
				}
				text.WriteString(strings.TrimSpace(b.Text))
			}
		}
		if text.Len() > 0 {
			return text.String()
		}
	}
	return ""
}

// resultText flattens a tool_result content (string or [{type:text,text}]) to plain text.
func resultText(raw json.RawMessage) (string, bool) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, false
	}
	var blocks []evBlock
	if json.Unmarshal(raw, &blocks) == nil {
		var b strings.Builder
		for _, blk := range blocks {
			b.WriteString(blk.Text)
		}
		return b.String(), false
	}
	return "", false
}

// verificationCommands scans a transcript for Bash verification calls and pairs each with its result.
// Deduped by command (last result wins). Order preserved by first appearance.
func verificationCommands(lines []string) []waveobj.EvidenceVerif {
	type pending struct{ command string }
	byToolID := map[string]pending{}          // tool_use id -> command awaiting a result
	idx := map[string]int{}                    // command -> position in out
	var out []waveobj.EvidenceVerif
	for _, line := range lines {
		_, blocks := evBlocks(line)
		for _, b := range blocks {
			switch b.Type {
			case "tool_use":
				if b.Name == "Bash" && verifPattern.MatchString(b.Input.Command) {
					byToolID[b.ID] = pending{command: strings.TrimSpace(b.Input.Command)}
				}
			case "tool_result":
				p, live := byToolID[b.ToolUseID]
				if !live {
					continue
				}
				delete(byToolID, b.ToolUseID)
				txt, _ := resultText(b.Content)
				cmd, res, ok := classifyVerif(p.command, txt, b.IsError)
				if !ok {
					continue
				}
				detail := firstLine(txt)
				if i, seen := idx[cmd]; seen {
					out[i] = waveobj.EvidenceVerif{Cmd: cmd, Result: res, Detail: detail}
				} else {
					idx[cmd] = len(out)
					out = append(out, waveobj.EvidenceVerif{Cmd: cmd, Result: res, Detail: detail})
				}
			}
		}
	}
	// a verification tool_use with no result at all -> unknown (ran, indeterminate)
	for _, p := range byToolID {
		if _, seen := idx[p.command]; !seen {
			idx[p.command] = len(out)
			out = append(out, waveobj.EvidenceVerif{Cmd: p.command, Result: "unknown"})
		}
	}
	return out
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// parseNumstatStatus joins `git diff --numstat` rows (adds\tdels\tpath) with `git status --porcelain -z`
// entries (XY path) into per-file evidence. Numstat drives the file set (it covers tracked + the
// synthetic untracked rows gitinfo appends); status supplies the A/M/D letter. Binary numstat ("-")
// counts as 0.
func parseNumstatStatus(numstat, statusZ string) []waveobj.EvidenceFile {
	stat := map[string]string{}
	for _, entry := range strings.Split(statusZ, "\x00") {
		if len(entry) < 3 {
			continue
		}
		xy, path := entry[:2], entry[3:]
		stat[path] = statusLetter(xy)
	}
	var out []waveobj.EvidenceFile
	for _, row := range strings.Split(numstat, "\n") {
		cols := strings.SplitN(row, "\t", 3)
		if len(cols) != 3 {
			continue
		}
		add, _ := strconv.Atoi(cols[0]) // "-" (binary) -> 0
		del, _ := strconv.Atoi(cols[1])
		path := cols[2]
		letter := stat[path]
		if letter == "" {
			letter = "M"
		}
		out = append(out, waveobj.EvidenceFile{Path: path, Stat: letter, Add: add, Del: del})
	}
	return out
}

func statusLetter(xy string) string {
	for _, c := range xy {
		switch c {
		case 'A', '?':
			return "A"
		case 'D':
			return "D"
		case 'M', 'R', 'C':
			return "M"
		}
	}
	return "M"
}

var imageExt = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true, ".webp": true}

func artifactKind(path string) string {
	switch ext := strings.ToLower(filepath.Ext(path)); {
	case ext == ".md" || ext == ".txt":
		return "doc"
	case ext == ".html" || ext == ".htm":
		return "report"
	case imageExt[ext]:
		return "image"
	default:
		return "file"
	}
}

func evidenceHash(ev waveobj.RunEvidence) string {
	ev.Hash = "" // hash excludes itself
	ev.CapturedTs = 0
	b, _ := json.Marshal(ev)
	sum := sha256.Sum256(b)
	return fmt.Sprintf("ev·%x", sum[:3])
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `go test ./pkg/jarvis/ -run 'Verif|Numstat|ArtifactKind|FinalAssistant|EvidenceHash'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/evidence.go pkg/jarvis/evidence_test.go
git commit -m "feat(runs): pure evidence-derivation helpers (verify/files/artifacts/summary)"
```

---

## Task 3: SealEvidence orchestration + completion wiring

**Files:**
- Modify: `pkg/jarvis/evidence.go` (add `SealEvidence` + `readTranscriptLines`)
- Modify: `pkg/wshrpc/wshserver/wshserver.go:1881-1921` (`AdvanceRunCommand` seal on done transition)
- Test: `pkg/jarvis/evidence_test.go`

**Interfaces:**
- Consumes: `parseNumstatStatus`, `verificationCommands`, `finalAssistantText`, `artifactKind`, `evidenceHash` (Task 2); `gitinfo.GetChanges` (`*gitinfo.Changes{Branch, StatusZ, Numstat, IsRepo}`); `waveobj.Run`.
- Produces: `func SealEvidence(ctx context.Context, run *waveobj.Run) error` — idempotent; sets `run.CompletedTs`, `run.Evidence`.

- [ ] **Step 1: Write the failing idempotence test**

In `pkg/jarvis/evidence_test.go` add:
```go
func TestSealEvidenceIdempotent(t *testing.T) {
	run := &waveobj.Run{
		ID: "r1", Status: RunStatus_Done, ProjectPath: t.TempDir(), CreatedTs: 1000,
		Phases: []waveobj.RunPhase{{Kind: PhaseKind_Execute, State: PhaseState_Done, DoneTs: 5000}},
	}
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence == nil {
		t.Fatal("evidence not sealed")
	}
	if run.CompletedTs != 5000 {
		t.Fatalf("CompletedTs = %d, want 5000 (last phase DoneTs)", run.CompletedTs)
	}
	first := run.Evidence
	if err := SealEvidence(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	if run.Evidence != first {
		t.Error("second seal recomputed evidence; must be immutable no-op")
	}
}
```
Add imports `context` to the test file.

- [ ] **Step 2: Run, verify it fails**

Run: `go test ./pkg/jarvis/ -run TestSealEvidenceIdempotent`
Expected: FAIL — `SealEvidence` undefined.

- [ ] **Step 3: Implement `SealEvidence` + transcript reader**

Append to `pkg/jarvis/evidence.go` (add imports `context`, `os`, `bufio`, `time`, and `github.com/wavetermdev/waveterm/pkg/gitinfo`):
```go
// SealEvidence derives and freezes a run's evidence snapshot. Idempotent: a run that already has
// Evidence is left untouched (immutability). Locates transcripts from phase WorkerOrefs and git data
// from ProjectPath — everything it needs is on the run. I/O failures degrade a section to empty; they
// never fail the seal (a partial snapshot beats none).
func SealEvidence(ctx context.Context, run *waveobj.Run) error {
	if run == nil || run.Evidence != nil {
		return nil
	}
	completedTs := lastPhaseDoneTs(run)
	if completedTs == 0 {
		completedTs = time.Now().UnixMilli()
	}
	run.CompletedTs = completedTs

	// transcript-derived: summary (last worker) + verifications (all workers)
	var summary string
	var verifs []waveobj.EvidenceVerif
	worker, lines := lastWorkerTranscript(run)
	if len(lines) > 0 {
		summary = finalAssistantText(lines)
		verifs = verificationCommands(lines)
	}

	// git-derived: files touched
	var files []waveobj.EvidenceFile
	var addTotal, delTotal int
	if ch, err := gitinfo.GetChanges(ctx, run.ProjectPath); err == nil && ch.IsRepo {
		files = parseNumstatStatus(ch.Numstat, ch.StatusZ)
		for i := range files {
			if worker != "" {
				files[i].By = worker
			}
			addTotal += files[i].Add
			delTotal += files[i].Del
		}
	}

	// artifacts: aggregate phase artifacts, classify + size
	var artifacts []waveobj.EvidenceArtifact
	seen := map[string]bool{}
	for _, p := range run.Phases {
		for _, a := range p.Artifacts {
			if a == "" || seen[a] {
				continue
			}
			seen[a] = true
			art := waveobj.EvidenceArtifact{Path: a, Kind: artifactKind(a)}
			if info, err := os.Stat(resolveUnder(run.ProjectPath, a)); err == nil {
				art.Size = info.Size()
			}
			artifacts = append(artifacts, art)
		}
	}

	ev := waveobj.RunEvidence{
		CapturedTs: completedTs,
		Summary:    summary,
		Files:      files, AddTotal: addTotal, DelTotal: delTotal,
		Verifs:     verifs,
		Artifacts:  artifacts,
		RuntimeMs:  activeSpanMs(run),
		DurationMs: completedTs - run.CreatedTs,
	}
	ev.Hash = evidenceHash(ev)
	run.Evidence = &ev
	return nil
}

func lastPhaseDoneTs(run *waveobj.Run) int64 {
	var ts int64
	for _, p := range run.Phases {
		if p.DoneTs > ts {
			ts = p.DoneTs
		}
	}
	return ts
}

// activeSpanMs sums each phase's [StartedTs, DoneTs] span — active compute vs wall clock.
func activeSpanMs(run *waveobj.Run) int64 {
	var sum int64
	for _, p := range run.Phases {
		if p.StartedTs > 0 && p.DoneTs > p.StartedTs {
			sum += p.DoneTs - p.StartedTs
		}
	}
	return sum
}

// lastWorkerTranscript returns the (worker tab id, transcript lines) of the last non-skipped phase's
// first worker. Empty when no worker/transcript is resolvable.
func lastWorkerTranscript(run *waveobj.Run) (string, []string) {
	for i := len(run.Phases) - 1; i >= 0; i-- {
		p := run.Phases[i]
		if p.State == PhaseState_Skipped {
			continue
		}
		for _, oref := range p.WorkerOrefs {
			if !strings.HasPrefix(oref, "tab:") {
				continue
			}
			id := strings.TrimPrefix(oref, "tab:")
			if path := TranscriptPathForTab(id); path != "" {
				if lines := readTranscriptLines(path); len(lines) > 0 {
					return id, lines
				}
			}
		}
	}
	return "", nil
}

func readTranscriptLines(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024) // transcripts have long JSONL records
	for sc.Scan() {
		if t := strings.TrimSpace(sc.Text()); t != "" {
			lines = append(lines, t)
		}
	}
	return lines
}

func resolveUnder(projectPath, artifact string) string {
	if filepath.IsAbs(artifact) {
		return artifact
	}
	return filepath.Join(projectPath, artifact)
}
```

- [ ] **Step 4: Add `TranscriptPathForTab` (transcript resolver)**

`SealEvidence` needs the on-disk transcript path for a worker tab id. Reuse the existing resolver if one exists — search: `grep -rn "func.*Transcript.*Tab\|transcriptPath\|TranscriptPath" pkg/`. The subagent/session code already maps a tab/block to its transcript (see `pkg/agentobserve/discover.go` `Resolution` and `pkg/agentsessions`). If a suitable exported helper exists (e.g. resolving a block's cwd → newest `*.jsonl`), call it; otherwise add a thin wrapper in `pkg/jarvis/evidence.go`:
```go
// TranscriptPathForTab resolves a worker tab's on-disk transcript via the block's cwd. Returns "" when
// the tab/block/transcript can't be resolved (a torn-down worker) — the caller degrades gracefully.
func TranscriptPathForTab(tabId string) string {
	ctx := context.Background()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil || len(tab.BlockIds) == 0 {
		return ""
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		return ""
	}
	cwd, _ := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if cwd == "" {
		cwd = block.Meta.GetString(waveobj.MetaKey_File, "")
	}
	if cwd == "" {
		return ""
	}
	res := agentobserve.ResolveTranscript(cwd) // returns newest claude *.jsonl for cwd, "" if none
	return res
}
```
Verify the exact resolver name/signature against `pkg/agentobserve/discover.go` before wiring; adapt the call to the real exported function (the discover package already picks the active transcript for a cwd). Add imports `wstore`, `agentobserve`, `waveobj` as needed. If no exported resolver exists, export the existing internal picker (smallest change) rather than duplicating the glob logic — do not reimplement transcript discovery.

- [ ] **Step 5: Wire the seal into `AdvanceRunCommand`**

In `pkg/wshrpc/wshserver/wshserver.go` `AdvanceRunCommand`, after the `UpdateRun` block succeeds and before `spawnRunWorkers`, detect the done transition and seal. Capture the pre-status, then:
```go
	// seal the immutable evidence snapshot on the non-done -> done transition (fresh transcripts/git).
	if run, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil &&
		run.Status == jarvis.RunStatus_Done && run.Evidence == nil {
		if serr := jarvis.SealEvidence(ctx, &run); serr == nil && run.Evidence != nil {
			ev := run.Evidence
			completedTs := run.CompletedTs
			if uerr := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
				if r.Evidence == nil { // idempotent under concurrent advances
					r.Evidence = ev
					r.CompletedTs = completedTs
				}
				return nil
			}); uerr != nil {
				log.Printf("AdvanceRun: persisting evidence for run %s failed: %v", data.RunId, uerr)
			}
		}
	}
```
(Place this after the `UpdateRun`/`err` check at line ~1907; `spawnRunWorkers` is a no-op for a done run so ordering is safe. `log` is already imported.)

- [ ] **Step 6: Run tests + build**

Run: `go test ./pkg/jarvis/ && task build:backend`
Expected: PASS + build exit 0.

- [ ] **Step 7: Commit**

```bash
git add pkg/jarvis/evidence.go pkg/jarvis/evidence_test.go pkg/wshrpc/wshserver/wshserver.go
git commit -m "feat(runs): SealEvidence + seal at run completion"
```

---

## Task 4: SealRunEvidenceCommand RPC (lazy backfill)

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go:130` (interface line) + command data struct (near line 777)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handler, after `StopRunWorkerCommand` ~line 1989)
- Regenerate: `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces (Go): `SealRunEvidenceCommand(ctx, CommandSealRunEvidenceData{ChannelId, RunId}) error`
- Produces (TS, generated): `RpcApi.SealRunEvidenceCommand(client, {channelid, runid})`

- [ ] **Step 1: Declare the command in the interface**

In `pkg/wshrpc/wshrpctypes.go`, add after the `StopRunWorkerCommand` line (130):
```go
	SealRunEvidenceCommand(ctx context.Context, data CommandSealRunEvidenceData) error                                 // derive+seal a done run's evidence if absent (idempotent backfill)
```
Add the data struct near `CommandStopRunWorkerData` (~line 777):
```go
type CommandSealRunEvidenceData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}
```

- [ ] **Step 2: Implement the handler**

In `pkg/wshrpc/wshserver/wshserver.go`, after `StopRunWorkerCommand` (line ~1989):
```go
// SealRunEvidenceCommand derives and persists a done run's evidence snapshot if it has none yet — the
// lazy backfill for runs completed before the feature existed (new runs seal at completion in
// AdvanceRun). Idempotent: a run already sealed is a no-op. Only seals runs in the done state.
func (ws *WshServer) SealRunEvidenceCommand(ctx context.Context, data wshrpc.CommandSealRunEvidenceData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if run.Status != jarvis.RunStatus_Done || run.Evidence != nil {
		return nil // nothing to seal
	}
	if serr := jarvis.SealEvidence(ctx, &run); serr != nil || run.Evidence == nil {
		return serr
	}
	ev, completedTs := run.Evidence, run.CompletedTs
	if uerr := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		if r.Evidence == nil {
			r.Evidence = ev
			r.CompletedTs = completedTs
		}
		return nil
	}); uerr != nil {
		return fmt.Errorf("persisting evidence: %w", uerr)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
```

- [ ] **Step 3: Regenerate + build**

Run: `task generate && task build:backend`
Expected: exit 0. Confirm `RpcApi.SealRunEvidenceCommand` exists in `frontend/app/store/wshclientapi.ts` and `CommandSealRunEvidenceData` in `frontend/types/gotypes.d.ts`.

- [ ] **Step 4: Smoke-test the handler compiles + validates**

Run: `go build ./... && go vet ./pkg/wshrpc/...`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(runs): SealRunEvidenceCommand for lazy evidence backfill"
```

---

## Task 5: Frontend view derivations (`runcompletion.ts`)

**Files:**
- Create: `frontend/app/view/agents/runcompletion.ts`
- Test: `frontend/app/view/agents/runcompletion.test.ts`

**Interfaces:**
- Consumes: generated `Run`, `RunPhase`, `RunEvidence`, `EvidenceFile`, `EvidenceVerif`, `EvidenceArtifact` (ambient types).
- Produces:
  ```ts
  export function runShortId(id: string): string
  export function fmtDuration(ms: number): string          // "14m 08s"
  export function fmtBytes(n: number): string               // "214 KB"
  export function fmtClock(tsMs: number): string            // "11:54"
  export type VerifTone = { icon: string; labelClass: string; badgeClass: string; borderClass: string };
  export function verifTone(result: string): VerifTone
  export function verifCounts(v: EvidenceVerif[]): { pass: number; fail: number; unknown: number }
  export function statColor(stat: string): string           // Tailwind text-* class
  export function artifactKindClass(kind: string): string
  export type PhaseNodeVM = { name: string; tag: string; detail: string; artifacts: string[]; timeLabel: string; isBoundary: boolean; isGate: boolean; notLast: boolean };
  export function phaseHistory(run: Run): PhaseNodeVM[]
  export function needsEvidenceSeal(run: Run): boolean      // done && !evidence
  ```

- [ ] **Step 1: Write failing tests**

Create `frontend/app/view/agents/runcompletion.test.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fmtBytes, fmtDuration, needsEvidenceSeal, phaseHistory, runShortId, verifCounts, verifTone } from "./runcompletion";

describe("runcompletion derivations", () => {
    it("formats a short id", () => {
        expect(runShortId("a1f9c3de-0000")).toBe("a1f9c3");
    });
    it("formats duration and bytes", () => {
        expect(fmtDuration(848000)).toBe("14m 08s");
        expect(fmtDuration(9000)).toBe("9s");
        expect(fmtBytes(214 * 1024)).toBe("214 KB");
    });
    it("maps verif tone + counts", () => {
        expect(verifTone("pass").icon).toBe("✓");
        expect(verifTone("fail").icon).toBe("✕");
        expect(verifTone("unknown").icon).toBe("?");
        const counts = verifCounts([
            { cmd: "a", result: "pass" }, { cmd: "b", result: "fail" }, { cmd: "c", result: "pass" },
        ] as EvidenceVerif[]);
        expect(counts).toEqual({ pass: 2, fail: 1, unknown: 0 });
    });
    it("builds phase history with a freshctx boundary node and gate tag", () => {
        const run = {
            id: "r", phases: [
                { kind: "brainstorm", skill: "superpowers:brainstorming", state: "done", startedts: 1000, donets: 2000 },
                { kind: "plan", skill: "superpowers:writing-plans", state: "done", gate: true, donets: 3000 },
                { kind: "execute", state: "done", freshctx: true, donets: 4000, artifacts: ["merged"] },
            ],
        } as unknown as Run;
        const nodes = phaseHistory(run);
        // brainstorm, plan(gate), execute(boundary) -> 3 nodes; the execute node is flagged isBoundary
        expect(nodes.map((n) => n.name)).toEqual(["Brainstorm", "Plan", "Execute"]);
        expect(nodes[1].isGate).toBe(true);
        expect(nodes[2].isBoundary).toBe(true);
        expect(nodes[2].notLast).toBe(false);
    });
    it("flags a done run without evidence for backfill", () => {
        expect(needsEvidenceSeal({ status: "done" } as Run)).toBe(true);
        expect(needsEvidenceSeal({ status: "done", evidence: {} } as unknown as Run)).toBe(false);
        expect(needsEvidenceSeal({ status: "executing" } as Run)).toBe(false);
    });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run frontend/app/view/agents/runcompletion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runcompletion.ts`**

Create `frontend/app/view/agents/runcompletion.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure view derivations for the run-completion (evidence-snapshot) surface: formatting, verification
// tone/counts, file-stat + artifact-kind color classes, and the phase-history node model (elevating a
// freshctx phase to its own timeline node). No React, no jotai — unit-tested in runcompletion.test.ts.

export function runShortId(id: string): string {
    return (id ?? "").replace(/-/g, "").slice(0, 6);
}

export function fmtDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m === 0) {
        return `${rem}s`;
    }
    return `${m}m ${String(rem).padStart(2, "0")}s`;
}

export function fmtBytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${Math.round(n / 1024)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtClock(tsMs: number): string {
    if (!tsMs) {
        return "—";
    }
    const d = new Date(tsMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type VerifTone = { icon: string; labelClass: string; badgeClass: string; borderClass: string };

export function verifTone(result: string): VerifTone {
    switch (result) {
        case "pass":
            return { icon: "✓", labelClass: "text-success", badgeClass: "bg-success/15 text-success", borderClass: "border-success/25" };
        case "fail":
            return { icon: "✕", labelClass: "text-error", badgeClass: "bg-error/15 text-error", borderClass: "border-error/30" };
        default:
            return { icon: "?", labelClass: "text-warning", badgeClass: "bg-warning/15 text-warning", borderClass: "border-edge-mid" };
    }
}

export function verifCounts(v: EvidenceVerif[]): { pass: number; fail: number; unknown: number } {
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const item of v ?? []) {
        if (item.result === "pass") counts.pass++;
        else if (item.result === "fail") counts.fail++;
        else counts.unknown++;
    }
    return counts;
}

export function statColor(stat: string): string {
    return stat === "A" ? "text-success" : stat === "D" ? "text-error" : "text-warning";
}

export function artifactKindClass(kind: string): string {
    switch (kind) {
        case "doc":
            return "text-accent bg-accentbg";
        case "report":
            return "text-success bg-success/15";
        case "image":
            return "text-accent-soft bg-accentbg";
        default:
            return "text-ink-mid bg-surface-hover";
    }
}

const PHASE_LABEL: Record<string, string> = {
    brainstorm: "Brainstorm",
    plan: "Plan",
    execute: "Execute",
    orchestrate: "Orchestrate",
    custom: "Custom",
};

export type PhaseNodeVM = {
    name: string;
    tag: string;
    detail: string;
    artifacts: string[];
    timeLabel: string;
    isBoundary: boolean;
    isGate: boolean;
    notLast: boolean;
};

// Phase-history node model. A gate phase carries a "gate" tag; a freshctx phase carries a "fresh ctx"
// tag and is flagged isBoundary (rendered with a squared node per the design). Detail prefers the skill.
export function phaseHistory(run: Run): PhaseNodeVM[] {
    const phases = (run.phases ?? []).filter((p) => p.state !== "skipped");
    return phases.map((p, i) => {
        const isGate = !!p.gate;
        const isBoundary = !!p.freshctx;
        return {
            name: PHASE_LABEL[p.kind] ?? p.kind,
            tag: isGate ? "gate" : isBoundary ? "fresh ctx" : "",
            detail: p.skill || p.kind,
            artifacts: p.artifacts ?? [],
            timeLabel: fmtClock(p.donets ?? p.startedts ?? 0),
            isBoundary,
            isGate,
            notLast: i < phases.length - 1,
        };
    });
}

export function needsEvidenceSeal(run: Run): boolean {
    return run?.status === "done" && !run?.evidence;
}
```

- [ ] **Step 4: Run tests, verify pass; typecheck**

Run: `npx vitest run frontend/app/view/agents/runcompletion.test.ts`
Expected: PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/runcompletion.ts frontend/app/view/agents/runcompletion.test.ts
git commit -m "feat(runs): pure view derivations for the run-completion surface"
```

---

## Task 6: RunCompletion surface

**Files:**
- Create: `frontend/app/view/agents/runcompletion.tsx`

**Interfaces:**
- Consumes: `runcompletion.ts` (Task 5); `getApi` (`@/app/store/global`); `RpcApi`/`TabRpcClient` are used by the caller (Task 7), not here.
- Produces: `export function RunCompletion({ channel, run }: { channel: Channel; run: Run }): JSX.Element`

- [ ] **Step 1: No theme changes — reuse the `accent` token family**

The evidence-snapshot chrome (sealed header, Immutable badge, diff button, fresh-ctx tag) uses the
existing themed `accent` tokens — `accent`, `accent-soft`, `accentbg` — **not** a bespoke color. This
keeps the surface theme-aware across all runtime presets; a fixed hex would clash on non-default themes.
Add no new `--color-*` tokens.

- [ ] **Step 2: Implement `runcompletion.tsx`**

Create `frontend/app/view/agents/runcompletion.tsx` (direct translation of `Wave-run-completion.dc.html`'s main pane — the left rail is the existing `channelrail`; raw hex mapped to `@theme` tokens):
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Run-completion surface (Wave-run-completion.dc.html): the sealed evidence snapshot + phase history
// shown when a run is done. Renders run.evidence (derived server-side, immutable). Replaces RunBody's
// terminal phase-rail view. Read-only — the run stays done; file/artifact clicks open in the OS editor.

import { getApi } from "@/app/store/global";
import {
    artifactKindClass,
    fmtBytes,
    fmtClock,
    fmtDuration,
    phaseHistory,
    runShortId,
    statColor,
    verifCounts,
    verifTone,
} from "./runcompletion";

function openPath(projectPath: string, rel: string) {
    const sep = projectPath.includes("\\") ? "\\" : "/";
    getApi().openExternal(rel.match(/^([/\\]|[a-zA-Z]:)/) ? rel : `${projectPath}${sep}${rel}`);
}

function StatCell({ label, value, sub, dot, valueClass }: { label: string; value: string; sub?: string; dot?: boolean; valueClass?: string }) {
    return (
        <div className="border-r border-border px-4 py-3 last:border-r-0">
            <div className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">{label}</div>
            <div className="flex items-center gap-1.5">
                {dot ? <span className="h-[7px] w-[7px] rounded-full bg-success" /> : null}
                <span className={"text-[15px] font-bold " + (valueClass ?? "text-primary")}>{value}</span>
            </div>
            {sub ? <div className="mt-0.5 font-mono text-[10.5px] text-muted">{sub}</div> : null}
        </div>
    );
}

function Section({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="border-b border-border px-[18px] py-4">
            <div className="mb-2.5 flex items-center gap-2.5">
                <div className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">{label}</div>
                <div className="flex-1" />
                {right}
            </div>
            {children}
        </div>
    );
}

export function RunCompletion({ channel, run }: { channel: Channel; run: Run }) {
    const ev = run.evidence;
    if (!ev) {
        return null;
    }
    const counts = verifCounts(ev.verifs ?? []);
    const nodes = phaseHistory(run);
    const summaryInitial = (ev.files?.[0]?.by ?? "worker").slice(0, 1).toUpperCase();
    const worker = ev.files?.[0]?.by ?? "worker";
    return (
        <div className="sc min-h-0 flex-1 overflow-y-auto">
            {/* header */}
            <div className="flex items-center gap-3 border-b border-border bg-surface px-[26px] py-[13px]">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
                        <span className="text-ink-mid">#{channel.name}</span>
                        <span>/</span>
                        <span>run {runShortId(run.id)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[16px] font-bold tracking-[-.01em] text-primary">{run.goal}</div>
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-[5px]">
                    <span className="text-[12px] text-success">✓</span>
                    <span className="font-mono text-[11px] font-bold uppercase tracking-[.02em] text-success">Done</span>
                </div>
            </div>

            <div className="px-[26px] pb-10 pt-[22px]">
                <div className="mx-auto max-w-[880px]">
                    {/* evidence snapshot card */}
                    <div className="overflow-hidden rounded-2xl border border-accent/25 bg-surface shadow-[0_20px_50px_rgba(0,0,0,.35)]">
                        {/* sealed header */}
                        <div className="flex items-center gap-3 border-b border-accent/20 bg-accentbg px-[18px] py-3.5">
                            <span className="text-[13px] text-accent">🔒</span>
                            <span className="font-mono text-[10px] font-semibold uppercase tracking-[.11em] text-accent-soft">Evidence snapshot</span>
                            <span className="rounded-[5px] border border-accent/25 bg-accentbg px-[7px] py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[.06em] text-accent-soft">Immutable</span>
                            <div className="flex-1" />
                            <span className="font-mono text-[10.5px] text-muted">sealed {fmtClock(ev.capturedts)}</span>
                            <span className="font-mono text-[10.5px] text-ink-faint">·</span>
                            <span className="font-mono text-[10.5px] text-muted">{ev.hash}</span>
                        </div>

                        {/* stat strip */}
                        <div className="grid grid-cols-4 border-b border-border">
                            <StatCell label="Status" value="Done" valueClass="text-success" dot sub="completed cleanly" />
                            <StatCell label="Runtime" value={fmtDuration(ev.runtimems)} sub="active compute" />
                            <StatCell label="Duration" value={fmtDuration(ev.durationms)} sub="wall clock" />
                            <StatCell label="Completed" value={fmtClock(ev.capturedts)} sub="today" />
                        </div>

                        {/* completion summary */}
                        <Section label="Completion summary">
                            {ev.summary ? (
                                <div className="flex items-start gap-3">
                                    <div className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-lg bg-accent font-mono text-[11px] font-bold text-background">{summaryInitial}</div>
                                    <div className="min-w-0 flex-1">
                                        <div className="mb-1.5 flex items-center gap-2">
                                            <span className="font-mono text-[12px] text-secondary">{worker}</span>
                                            <span className="rounded border border-edge-mid bg-background px-1.5 font-mono text-[9px] font-semibold uppercase tracking-[.07em] text-ink-mid">final response</span>
                                        </div>
                                        <p className="text-[13.5px] leading-[1.62] text-secondary">{ev.summary}</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-edge-mid bg-background px-3.5 py-3">
                                    <span className="text-[13px] text-muted">∅</span>
                                    <span className="text-[13px] italic text-ink-mid">No completion summary was recorded</span>
                                </div>
                            )}
                        </Section>

                        {/* files touched */}
                        <Section
                            label="Files touched"
                            right={
                                <>
                                    <span className="font-mono text-[10px] text-ink-faint">derived from worker transcripts</span>
                                    <span className="font-mono text-[11px] font-semibold text-success">+{ev.addtotal}</span>
                                    <span className="font-mono text-[11px] font-semibold text-error">−{ev.deltotal}</span>
                                </>
                            }
                        >
                            <div className="flex flex-col gap-0.5">
                                {(ev.files ?? []).map((f) => (
                                    <button
                                        key={f.path}
                                        onClick={() => openPath(run.projectpath, f.path)}
                                        className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-hover"
                                    >
                                        <span className={"w-[15px] text-center font-mono text-[11px] font-bold " + statColor(f.stat)}>{f.stat}</span>
                                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-secondary">{f.path}</span>
                                        {f.by ? <span className="font-mono text-[10px] text-muted">{f.by}</span> : null}
                                        <span className="w-[34px] text-right font-mono text-[10.5px] font-semibold text-success">+{f.add}</span>
                                        <span className="w-[30px] text-right font-mono text-[10.5px] font-semibold text-error">−{f.del}</span>
                                    </button>
                                ))}
                            </div>
                        </Section>

                        {/* verification */}
                        <Section
                            label="Verification"
                            right={
                                <>
                                    <span className="font-mono text-[10px] font-semibold text-success">{counts.pass} pass</span>
                                    <span className="font-mono text-[10px] font-semibold text-error">{counts.fail} fail</span>
                                    <span className="font-mono text-[10px] font-semibold text-warning">{counts.unknown} unknown</span>
                                </>
                            }
                        >
                            <div className="flex flex-col gap-1.5">
                                {(ev.verifs ?? []).map((v) => {
                                    const tone = verifTone(v.result);
                                    return (
                                        <div key={v.cmd} className={"flex items-center gap-2.5 rounded-[9px] border bg-background px-2.5 py-2 " + tone.borderClass}>
                                            <span className={"flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] font-mono text-[10px] font-bold " + tone.badgeClass}>{tone.icon}</span>
                                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-secondary">{v.cmd}</span>
                                            {v.detail ? <span className="font-mono text-[10.5px] text-muted">{v.detail}</span> : null}
                                            <span className={"font-mono text-[9px] font-semibold uppercase tracking-[.06em] " + tone.labelClass}>{v.result}</span>
                                        </div>
                                    );
                                })}
                                {(ev.verifs ?? []).length === 0 ? (
                                    <span className="text-[12px] italic text-ink-mid">No verification commands recorded</span>
                                ) : null}
                            </div>
                        </Section>

                        {/* artifacts */}
                        <Section label="Artifacts produced">
                            <div className="flex flex-wrap gap-2">
                                {(ev.artifacts ?? []).map((a) => (
                                    <button
                                        key={a.path}
                                        onClick={() => openPath(run.projectpath, a.path)}
                                        className="flex items-center gap-2 rounded-[9px] border border-edge-mid bg-background px-3 py-2 hover:border-edge-strong"
                                    >
                                        <span className={"rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase " + artifactKindClass(a.kind)}>{a.kind}</span>
                                        <span className="font-mono text-[12px] text-secondary">{a.path}</span>
                                        {a.size ? <span className="font-mono text-[10px] text-muted">{fmtBytes(a.size)}</span> : null}
                                        <span className="text-[11px] text-ink-faint">↗</span>
                                    </button>
                                ))}
                                {(ev.artifacts ?? []).length === 0 ? (
                                    <span className="text-[12px] italic text-ink-mid">No artifacts recorded</span>
                                ) : null}
                            </div>
                        </Section>

                        {/* diff action */}
                        <div className="flex items-center gap-3 px-[18px] py-3.5">
                            <button
                                onClick={() => getApi().openExternal(run.projectpath)}
                                className="flex items-center gap-2.5 rounded-[9px] bg-accent px-4 py-2.5 text-[12.5px] font-bold text-background hover:bg-accent/90"
                            >
                                <span className="text-[12px]">⑂</span>Open repository diff
                                <span className="font-mono text-[10.5px] text-background/60">+{ev.addtotal} −{ev.deltotal}</span>
                            </button>
                            <span className="text-[11.5px] text-muted">Snapshot is read-only — the run stays done. No approval needed.</span>
                        </div>
                    </div>

                    {/* phase history */}
                    <div className="mx-0.5 mb-3.5 mt-[26px] flex items-center gap-3">
                        <span className="font-mono text-[10px] font-semibold uppercase tracking-[.11em] text-muted">Phase history</span>
                        <div className="h-px flex-1 bg-border" />
                        <span className="font-mono text-[11px] text-muted">{nodes.length} phases · all complete</span>
                    </div>
                    <div className="pl-0.5">
                        {nodes.map((n, i) => (
                            <div key={i} className="flex gap-[15px]">
                                <div className="flex w-[38px] flex-none flex-col items-center">
                                    <div className={"flex h-[26px] w-[26px] flex-none items-center justify-center border-[1.5px] border-success/50 bg-success/15 font-mono text-[11px] font-bold text-success " + (n.isGate || n.isBoundary ? "rounded-lg" : "rounded-full")}>
                                        {n.isBoundary ? "↻" : "✓"}
                                    </div>
                                    {n.notLast ? <div className="min-h-[26px] w-0.5 flex-1 bg-success/40" /> : null}
                                </div>
                                <div className="min-w-0 flex-1 pb-4">
                                    <div className="flex items-center gap-2.5">
                                        <span className="text-[14px] font-bold text-primary">{n.name}</span>
                                        {n.tag ? (
                                            <span className={"rounded border px-1.5 py-px font-mono text-[8.5px] font-semibold uppercase tracking-[.07em] " + (n.isGate ? "border-warning/30 bg-warning/10 text-warning" : "border-accent/25 bg-accentbg text-accent-soft")}>{n.tag}</span>
                                        ) : null}
                                        <div className="flex-1" />
                                        <span className="font-mono text-[10.5px] text-muted">{n.timeLabel}</span>
                                    </div>
                                    <div className="mt-0.5 font-mono text-[11px] text-muted">{n.detail}</div>
                                    {n.artifacts.map((art) => (
                                        <button
                                            key={art}
                                            onClick={() => openPath(run.projectpath, art)}
                                            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-edge-mid bg-background px-2.5 py-1.5 hover:border-edge-strong"
                                        >
                                            <span className="rounded bg-success/15 px-1.5 py-px font-mono text-[8.5px] font-bold text-success">OUT</span>
                                            <span className="font-mono text-[11.5px] text-ink-mid">{art}</span>
                                            <span className="text-[10px] text-ink-faint">↗</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (The surface uses only existing `@theme` tokens — `accent`, `accent-soft`, `accentbg`, `success`, `error`, `warning`, `muted`, `edge-*`; Tailwind 4 derives `text-`/`bg-`/`border-` utilities from those `--color-*` names. No new tokens.)

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/runcompletion.tsx
git commit -m "feat(runs): RunCompletion evidence-snapshot surface"
```

---

## Task 7: RunBody integration + backfill trigger

**Files:**
- Modify: `frontend/app/view/agents/runbody.tsx:760-866` (`RunBody` — render `RunCompletion` for done+evidence; fire backfill otherwise)

**Interfaces:**
- Consumes: `RunCompletion` (Task 6); `needsEvidenceSeal` (Task 5); `RpcApi.SealRunEvidenceCommand` (Task 4); `RpcApi`/`TabRpcClient` (already imported in runbody.tsx).

- [ ] **Step 1: Add imports**

In `frontend/app/view/agents/runbody.tsx`, add near the existing local imports:
```tsx
import { RunCompletion } from "./runcompletion";
import { needsEvidenceSeal } from "./runcompletion";
```

- [ ] **Step 2: Render the completion surface / trigger backfill**

At the top of `RunBody`'s body (after the `now` clock effect, before the orchestrator branch at line ~814), add:
```tsx
    // done run: show the sealed evidence snapshot. If it isn't sealed yet (pre-feature run), fire the
    // idempotent backfill once — the mirrored channel update re-renders this with run.evidence present.
    useEffect(() => {
        if (needsEvidenceSeal(run)) {
            fireAndForget(() => RpcApi.SealRunEvidenceCommand(TabRpcClient, { channelid: channel.oid, runid: run.id }));
        }
    }, [run.id, run.status, run.evidence]);

    if (run.status === "done" && run.evidence) {
        return <RunCompletion channel={channel} run={run} />;
    }
```
(`fireAndForget`, `RpcApi`, `TabRpcClient`, `useEffect` are already imported.)

- [ ] **Step 3: Typecheck + existing tests**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run frontend/app/view/agents/`
Expected: exit 0; all existing agent-view tests + `runcompletion.test.ts` pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/runbody.tsx
git commit -m "feat(runs): render RunCompletion for done runs + backfill unsealed evidence"
```

---

## Task 8: Visual verification (CDP)

**Files:** none (verification only)

- [ ] **Step 1: Ensure the dev app is running with the new backend**

Run (if not already up): `task build:backend` then `tail -f /dev/null | task dev` (headless-safe; see the dev-stdin-EOF gotcha).
Wait for the Vite server on `:5174` and WebView2 debug port `:9222`.

- [ ] **Step 2: Drive a done run with sealed evidence**

Use the injection helper to create a channel with a `done` run whose phases carry artifacts + worker orefs, then open it. Run:
```bash
node scripts/inject-live-agents.mjs run-completion
```
If that scenario doesn't exist, add it to `scripts/inject-live-agents.mjs` (a channel + one pipeline run, all phases `done`, an `evidence` blob matching the `RunEvidence` shape) following the script's existing scenario pattern, then re-run.

- [ ] **Step 3: Screenshot + compare**

Run: `node scripts/cdp-shot.mjs run-completion.png`
Expected: the main pane shows the evidence-snapshot card (sealed header, 4-stat strip, summary, files, verification with pass/fail/unknown, artifacts, diff action) and the phase-history timeline below — matching `Wave-run-completion.dc.html`. Confirm: no raw-hex mismatches (colors resolve from tokens), the freshctx phase renders as a squared `↻` node, an empty-summary run shows the "No completion summary" state.

- [ ] **Step 4: Report result**

Attach the screenshot path and note any pixel deltas from the mock. If the surface renders correctly end-to-end, the feature is verified.

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Seal-at-completion (spec Backend 1) → Task 3 Step 5. Lazy backfill (Backend 2) → Task 4 + Task 7 Step 2.
- Data model incl. timestamps (spec Data model) → Task 1.
- Summary / Files / Verifs / Artifacts / Hash derivation (Backend 3) → Task 2 + Task 3.
- `runcompletion.ts` pure derivations → Task 5. `runcompletion.tsx` surface → Task 6. RunBody integration → Task 7. Theming → Task 6 Step 1.
- Evidence-only verification, done-only scope, Runtime-vs-Duration (Confirmed decisions) → Task 2 (`classifyVerif`), Task 7 (`run.status === "done"` gate), Task 3 (`activeSpanMs` vs `DurationMs`).
- Testing (Go + FE + CDP) → Tasks 1–5 tests + Task 8.

**Placeholder scan** — one intentional investigate-then-wire point: Task 3 Step 4 (`TranscriptPathForTab`) instructs verifying the exact existing transcript resolver in `pkg/agentobserve/discover.go` before wiring, rather than guessing a signature. This is a real dependency to confirm, not a skipped implementation; the fallback (export the existing internal picker) is specified. All other steps carry complete code.

**Type consistency** — `RunEvidence`/`EvidenceFile`/`EvidenceVerif`/`EvidenceArtifact` field names are identical across the Go structs (Task 1), the derivation output (Task 2/3), and the TS consumers (Tasks 5/6, via generated `gotypes.d.ts` lowercased json tags: `capturedts`, `addtotal`, `deltotal`, `runtimems`, `durationms`, `donets`, `startedts`). `SealRunEvidenceCommand`/`CommandSealRunEvidenceData` names match between interface, handler, and generated client. `classifyVerif`, `parseNumstatStatus`, `verificationCommands`, `finalAssistantText`, `artifactKind`, `evidenceHash` names match between Task 2 definitions and Task 3 usage.
