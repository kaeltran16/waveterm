# Orchestrator small findings Implementation Plan

**Verify:** `go test ./pkg/jarvis/ ./pkg/orchestrate/ ./pkg/reporadar/ ./cmd/wsh/cmd/ && npx vitest run frontend/app/store frontend/app/view/agents`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis/ ./pkg/orchestrate/ ./cmd/wsh/cmd/`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`

> **For agentic workers:** each task is one engine worker's job. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix findings 3, 25, 24 (WOS part) and 21 from `docs/orchestrator-findings-2026-09-25.md`.
Finding 10 already shipped (a9650e6c).

**Architecture:** Four independent changes in four areas: the attention source (`pkg/jarvis` attention and
resolve, plus the `wsh runs attention` row); the Verify failure output (`pkg/orchestrate/plancmd.go`); the
WOS pushed-update race (`frontend/app/store/wos.ts`); and the sealed evidence labels
(`pkg/jarvis/evidence.go`). No task consumes another's output, so all four run in parallel.

**Tech Stack:** Go (testing stdlib), TypeScript + vitest, jotai.

**Spec:** `docs/superpowers/specs/2026-09-25-orchestrator-small-findings-design.md`

## Global Constraints

- No UI code changes: no `.tsx` edits and no new frontend tokens. Only `frontend/app/store/wos.ts` and its new test change on the frontend.
- No wshrpc/waveobj type changes. The only `pkg/waveobj/wtype.go` edit is a comment, which reaches no generated file, so `task generate` is not needed.
- Comments explain why, not what, in lower case where the surrounding code does. Match the file's idiom.
- Check only the files you touched with gofmt/prettier; never `--write` the tree.
- Tasks 1 and 4 both edit files in `pkg/jarvis`, but not the same file: Task 1 owns `attention.go`, `resolve.go`, `watcher.go` and their tests, and Task 4 owns `evidence.go`, `evidence_test.go` and `pkg/reporadar` (read only).

## Review Focus

- A goal that opens with blank lines, or whose first line is non-ASCII and longer than 80 runes: the headline is the first real line, cut on a rune boundary (Task 1, Step 1).
- Go test output with CRLF line endings, as Git Bash produces on Windows: the `--- FAIL:` block is still found (Task 2, Step 1).
- One enormous line with no newline (a minified log): the line buffer stays bounded and nothing panics (Task 2, Step 1).
- A pushed update, then `loadAndPinWaveObject` before the stale fetch settles: the caller gets the pushed object, not a pending null (Task 3, Step 1).
- A runner given by a Windows path or with `.exe` (`C:\Go\bin\go.exe test ./...`), or behind env assignments: still counts as verification (Task 4, Step 1).

---

### Task 1: Attention rows show the goal's headline and the question whole
**Depends on:** none

Finding 3. Spec §1.

**Files:**
- Modify: `pkg/jarvis/attention.go` (add `goalHeadline` beside `firstLine` ~:238; `BuildAttention` `Source: run.Goal` at ~:325, ~:483, ~:517; `dagSource` ~:690; `GatherAttentionFromLedger` ~:761)
- Modify: `pkg/jarvis/resolve.go:202-214` (`runWorkerTask`)
- Modify: `pkg/jarvis/watcher.go:113-134` (`ResolveAskOwner`, `handleAsk`)
- Modify: `cmd/wsh/cmd/wshcmd-runs.go:730` (`runsAttentionLines`)
- Test: `pkg/jarvis/attention_test.go`, `pkg/jarvis/resolve_test.go`, `pkg/jarvis/resolve_db_test.go` (3 callers of `ResolveAskOwner` at :99, :124, :146), `cmd/wsh/cmd/wshcmd-runs_test.go`

**Interfaces:**
- Produces: `func goalHeadline(goal string) string`, `const attentionSourceMaxLen = 80`, `func runWorkerSource(run *waveobj.Run, phaseIdx int) string`, and `func ResolveAskOwner(ctx context.Context, ownerORef string) (*waveobj.Channel, string, string)`, which returns channel, classifier task and attention source.

- [ ] **Step 1: Write the failing tests**

In `pkg/jarvis/attention_test.go`, append:

```go
func TestGoalHeadline(t *testing.T) {
	long := strings.Repeat("é", 100)
	cases := []struct{ goal, want string }{
		{"ship coupons", "ship coupons"},
		{"", ""},
		{"Fix five findings\nfrom the doc:\n(1) ...", "Fix five findings"},
		{"\n\n  first real line  \nsecond", "first real line"},
		{long, strings.Repeat("é", attentionSourceMaxLen-1) + "…"},
	}
	for _, c := range cases {
		if got := goalHeadline(c.goal); got != c.want {
			t.Errorf("goalHeadline(%q) = %q, want %q", c.goal, got, c.want)
		}
	}
}

func TestBuildAttentionShortensEveryGoalSource(t *testing.T) {
	goal := "Fix the attention row " + strings.Repeat("and more words ", 20) + "\n(1) a long second line"
	want := goalHeadline(goal)
	gate := gatedRun("r1", goal, 500)
	held := &waveobj.Run{ID: "r2", Goal: goal, Land: &waveobj.RunLand{State: "held", Reason: "dirty"}}
	unverified := &waveobj.Run{ID: "r3", Goal: goal, Status: RunStatus_Done,
		Evidence: &waveobj.RunEvidence{Verification: &waveobj.RunVerification{State: "unverified", Reasons: []string{"no check"}}}}
	items := BuildAttention(AttentionInput{Channels: []AttentionChannel{
		{OID: "c1", Name: "alpha", Runs: []*waveobj.Run{gate, held, unverified}},
	}})
	if len(items) != 3 {
		t.Fatalf("want 3 items, got %+v", items)
	}
	for _, it := range items {
		if it.Source != want {
			t.Errorf("%s source = %q, want %q", it.Kind, it.Source, want)
		}
	}
}
```

Check the `Land` field's type name in `pkg/waveobj/wtype.go` (grep `Land ` in the `Run` struct). If it isn't `RunLand`, use the real name. In `pkg/jarvis/resolve_test.go`, append:

```go
func TestRunWorkerSourceCarriesOnlyTheHeadline(t *testing.T) {
	run := &waveobj.Run{Goal: "ship coupons\nwith a long body the classifier needs", Phases: []waveobj.RunPhase{
		{Kind: PhaseKind_Plan, Skill: "superpowers:writing-plans"},
	}}
	if task := runWorkerTask(run, 0); !contains(task, "with a long body") {
		t.Fatalf("the classifier's task must keep the full goal: %q", task)
	}
	src := runWorkerSource(run, 0)
	if !contains(src, "ship coupons") || contains(src, "long body") || !contains(src, "superpowers:writing-plans") {
		t.Fatalf("source = %q", src)
	}
	if got := runWorkerSource(run, 5); got != "ship coupons" {
		t.Fatalf("out-of-range source = %q", got)
	}
}
```

In `pkg/jarvis/resolve_db_test.go`, update the three `ResolveAskOwner` callers to the three-value form. In `TestResolveAskOwner_Concierge`, also assert `source == "concierge task"`. In `TestResolveAskOwner_RunWorker`, assert `contains(source, "ship it")`.

In `cmd/wsh/cmd/wshcmd-runs_test.go`, append:

```go
func TestRunsAttentionLinesKeepTheQuestionWhole(t *testing.T) {
	question := "Which of these three approaches should the lead take for the merge queue? " + strings.Repeat("detail ", 20)
	items := []wshrpc.AttentionItem{{Kind: "escalation", Action: "Decide", Source: strings.Repeat("goal ", 40), Text: question + "\nsecond line"}}
	line := runsAttentionLines(items, 0)[0]
	if !strings.Contains(line, strings.Join(strings.Fields(question+" second line"), " ")) {
		t.Fatalf("the question must print whole on one line: %q", line)
	}
	if strings.Count(line, "goal") > runsGoalWidth/5 {
		t.Fatalf("the source must be clipped: %q", line)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run 'GoalHeadline|ShortensEveryGoalSource|RunWorkerSource|ResolveAskOwner' && go test ./cmd/wsh/cmd/ -run RunsAttentionLines`
Expected: compile errors (`goalHeadline`, `runWorkerSource` undefined; `ResolveAskOwner` returns 2 values).

- [ ] **Step 3: Implement**

`pkg/jarvis/attention.go`, beside `firstLine`:

```go
// attentionSourceMaxLen bounds a row's source line. A run's goal can be kilobytes; the row's text is the
// question that needs deciding, and a whole goal in front of it pushes it out of view.
const attentionSourceMaxLen = 80

// goalHeadline is the first line of a goal, cut to attentionSourceMaxLen runes, for a row that names its run.
func goalHeadline(goal string) string {
	line := strings.TrimSpace(firstLine(strings.TrimSpace(goal)))
	if r := []rune(line); len(r) > attentionSourceMaxLen {
		return string(r[:attentionSourceMaxLen-1]) + "…"
	}
	return line
}
```

In `BuildAttention`, change the three `Source: run.Goal,` lines (gate, `landHeldItem`, `unverifiedItem`) to
`Source: goalHeadline(run.Goal),`. In `dagSource`, return `goalHeadline(g.Title)` and `goalHeadline(run.Goal)`.
The `"orchestration dag"` fallback stays.

`pkg/jarvis/resolve.go` replaces `runWorkerTask`:

```go
// runWorkerTask is the classifier "task" context for a run worker: the phase it is executing, framed
// against the whole run goal. Falls back to the bare goal for an out-of-range index.
func runWorkerTask(run *waveobj.Run, phaseIdx int) string {
	return runWorkerFrame(run, phaseIdx, run.Goal)
}

// runWorkerSource is the same frame around the goal's headline, for an attention row: the row's text is
// the worker's question, and a whole goal in front of it hides it.
func runWorkerSource(run *waveobj.Run, phaseIdx int) string {
	return runWorkerFrame(run, phaseIdx, goalHeadline(run.Goal))
}

func runWorkerFrame(run *waveobj.Run, phaseIdx int, goal string) string {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return goal
	}
	p := run.Phases[phaseIdx]
	skill := p.Skill
	if skill == "" {
		skill = p.Kind
	}
	return fmt.Sprintf("%s phase (%s) of run goal: %s", p.Kind, skill, goal)
}
```

`pkg/jarvis/watcher.go`: `ResolveAskOwner` returns `(*waveobj.Channel, string, string)`. Extend its doc
comment by one sentence: the second value is the classifier's task and the third is the attention row's
source.

```go
	if m := ResolveRunWorkerFromMeta(ctx, ownerORef); m != nil {
		return m.Channel, runWorkerTask(m.Run, m.PhaseIdx), runWorkerSource(m.Run, m.PhaseIdx)
	}
	ch, task := resolveGatekeeperChannelByMeta(ctx, ownerORef)
	return ch, task, goalHeadline(task)
```

`handleAsk`: `ch, task, _ := ResolveAskOwner(ctx, ownerORef)`. `GatherAttentionFromLedger`:
`owner, _, source := ResolveAskOwner(ctx, workerORef)`, then `if source != "" { in.AskWorker[blockORef] = source }`.

`cmd/wsh/cmd/wshcmd-runs.go` `runsAttentionLines`: the row's last two fields become
`runsClip(it.Source, runsGoalWidth), strings.Join(strings.Fields(it.Text), " ")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ ./cmd/wsh/cmd/`
Expected: PASS (the whole packages, so the existing attention and runs tests still hold).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/attention.go pkg/jarvis/resolve.go pkg/jarvis/watcher.go pkg/jarvis/attention_test.go pkg/jarvis/resolve_test.go pkg/jarvis/resolve_db_test.go cmd/wsh/cmd/wshcmd-runs.go cmd/wsh/cmd/wshcmd-runs_test.go
git commit -m "fix(attention): show a run goal's headline as the source and the question whole"
```

### Task 2: A failed Verify keeps the lines that name the failing test
**Depends on:** none

Finding 25. Spec §2.

**Files:**
- Modify: `pkg/orchestrate/plancmd.go` (constants ~:16-31; `failureMarkers`/`firstFailureExcerpt` ~:56-76; `execPlanCommandEnv` ~:146; `tailBuffer` ~:170-210)
- Test: `pkg/orchestrate/plancmd_test.go`

**Interfaces:**
- Produces: `const MaxFailureBlocksLen = 4000`, `func (b *tailBuffer) failureOutput() string`. `planCommandError.output` for a failed command is now `failureOutput()`. Callers (`recordVerifyLocked`, `failureDetail`) are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/orchestrate/plancmd_test.go`:

```go
// noisyLog is what a failing, chatty Go package prints around its failing test: unindented log lines.
func noisyLog(n int) string {
	return strings.Repeat("2026/09/25 11:40:01 CreateRun: capturing dossier failed: no such file\n", n)
}

func writeAll(b *tailBuffer, parts ...string) {
	for _, p := range parts {
		b.Write([]byte(p))
	}
}

func TestFailureOutputKeepsTheFailingTestPastTheTail(t *testing.T) {
	b := &tailBuffer{max: MaxPlanOutputLen}
	writeAll(b, noisyLog(20), "--- FAIL: TestLeadComplete (0.03s)\n", "    leadcomplete_test.go:41: want done, got running\n",
		noisyLog(300), "FAIL\n", "FAIL\tgithub.com/wavetermdev/waveterm/pkg/wshrpc/wshserver\t26.299s\n")
	out := b.failureOutput()
	for _, want := range []string{"--- FAIL: TestLeadComplete", "want done, got running", "FAIL\tgithub.com/wavetermdev/waveterm/pkg/wshrpc/wshserver"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output lost %q", want)
		}
	}
	if len(out) > MaxPlanOutputLen {
		t.Fatalf("output is %d bytes, over %d", len(out), MaxPlanOutputLen)
	}
	got := failureDetail(&planCommandError{exitCode: 1, output: out})
	if !strings.HasPrefix(got, "exit 1: --- FAIL: TestLeadComplete") {
		t.Fatalf("detail = %q", got)
	}
}

func TestFailureOutputJoinsALineSplitAcrossWrites(t *testing.T) {
	b := &tailBuffer{max: MaxPlanOutputLen}
	writeAll(b, "--- FA", "IL: TestSplit (0.00s)\r\n    split_test.go:9: bro", "ken\r\n", noisyLog(300))
	out := b.failureOutput()
	if !strings.Contains(out, "--- FAIL: TestSplit") || !strings.Contains(out, "split_test.go:9: broken") || strings.Contains(out, "\r") {
		t.Fatalf("split or CRLF block not kept whole: %q", out[:200])
	}
}

func TestFailureOutputKeepsAPanicTrace(t *testing.T) {
	b := &tailBuffer{max: MaxPlanOutputLen}
	writeAll(b, "panic: runtime error: index out of range [3] with length 3\n\ngoroutine 7 [running]:\n",
		"github.com/wavetermdev/waveterm/pkg/orchestrate.pick(...)\n\t/src/pkg/orchestrate/pick.go:12 +0x1d\n", noisyLog(300))
	out := b.failureOutput()
	if !strings.Contains(out, "panic: runtime error") || !strings.Contains(out, "pick.go:12") {
		t.Fatalf("panic trace not kept: %q", out[:300])
	}
}

func TestFailureOutputCapsTheBlocks(t *testing.T) {
	b := &tailBuffer{max: MaxPlanOutputLen}
	for i := 0; i < 400; i++ {
		writeAll(b, fmt.Sprintf("--- FAIL: TestMany%d (0.00s)\n    many_test.go:1: nope\n", i))
	}
	writeAll(b, noisyLog(300))
	out := b.failureOutput()
	head, _, _ := strings.Cut(out, "\n…\n")
	if len(head) > MaxFailureBlocksLen || !strings.HasPrefix(head, "--- FAIL: TestMany0 ") {
		t.Fatalf("blocks = %d bytes, starting %q", len(head), head[:40])
	}
}

func TestFailureOutputBoundsAHugeUnterminatedLine(t *testing.T) {
	b := &tailBuffer{max: MaxPlanOutputLen}
	writeAll(b, strings.Repeat("x", 1<<20))
	if len(b.partial) > MaxFailureBlocksLen {
		t.Fatalf("partial line grew to %d bytes", len(b.partial))
	}
	if out := b.failureOutput(); len(out) > MaxPlanOutputLen {
		t.Fatalf("output %d bytes", len(out))
	}
}

func TestFailureOutputIsTheTailWhenNothingWasDropped(t *testing.T) {
	b := &tailBuffer{max: MaxPlanOutputLen}
	writeAll(b, "--- FAIL: TestSmall (0.00s)\n    small_test.go:3: nope\nFAIL\n")
	if out := b.failureOutput(); out != b.String() || strings.Count(out, "TestSmall") != 1 {
		t.Fatalf("short output must not be duplicated: %q", out)
	}
}

func TestFirstFailureExcerptPrefersTheFailingTest(t *testing.T) {
	output := "FAIL\tpkg/a\t0.1s\n" + noisyLog(2) + "--- FAIL: TestLater (0.00s)\n"
	if got := firstFailureExcerpt(output); !strings.HasPrefix(got, "--- FAIL: TestLater") {
		t.Fatalf("excerpt = %q", got)
	}
}

func TestPlanCommandFailureKeepsTheFailingTest(t *testing.T) {
	script := `printf -- '--- FAIL: TestReal (0.00s)\n    real_test.go:5: bad\n'; i=0; while [ $i -lt 300 ]; do echo "noise line $i of the package log"; i=$((i+1)); done; exit 1`
	_, err := execPlanCommand(context.Background(), t.TempDir(), script, time.Minute, nil)
	var pe *planCommandError
	if !errors.As(err, &pe) || !strings.Contains(pe.output, "--- FAIL: TestReal") || !strings.HasPrefix(failureDetail(err), "exit 1: --- FAIL: TestReal") {
		t.Fatalf("err = %v", err)
	}
}
```

The existing `TestTailBufferKeepsTheEnd` and the passing-command tests must keep passing unchanged: a
pass still returns the tail only. Add `fmt` to the test imports if it is missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run 'FailureOutput|PrefersTheFailingTest|PlanCommandFailureKeeps'`
Expected: compile errors (`failureOutput`, `MaxFailureBlocksLen`, `partial` undefined).

- [ ] **Step 3: Implement**

Constants, beside `MaxPlanOutputLen`:

```go
	// MaxFailureBlocksLen bounds the failure blocks a failed plan command keeps from its whole output. The
	// tail alone loses them: a failing Go package prints its whole log, and a chatty one pushes the failing
	// test out of the last MaxPlanOutputLen bytes.
	MaxFailureBlocksLen = 4000
	// panicBlockLines is how much of a panic's goroutine trace its block keeps.
	panicBlockLines = 20
```

Markers, two tiers:

```go
// preferredFailureMarkers open a line that names the failure itself. They win over failureMarkers
// anywhere in the output: a bare FAIL is only the package summary printed under the failing test.
var preferredFailureMarkers = []string{"--- FAIL", "panic:"}

// failureMarkers start a line of a failing stage's output. Heuristic and additive: a marker that does not
// match costs the old tail behavior, nothing worse.
var failureMarkers = []string{"FAIL", "error:", "assert"}

// firstFailureExcerpt is a window of output, within MaxFailureDetailLen, that starts at the first line a
// preferred failure marker opens, else the first line any other marker opens. It reports "" when no line does.
func firstFailureExcerpt(output string) string {
	if excerpt := excerptAtMarker(output, preferredFailureMarkers); excerpt != "" {
		return excerpt
	}
	return excerptAtMarker(output, failureMarkers)
}

func excerptAtMarker(output string, markers []string) string {
	// today's loop body, iterating markers instead of failureMarkers
}
```

`tailBuffer` gains these fields (update its doc comment: it also keeps the failure blocks it saw in the
whole stream):

```go
	total      int             // bytes written, to tell whether the tail dropped any
	partial    []byte          // the line being written, until its newline arrives; bounded by MaxFailureBlocksLen
	blocks     strings.Builder // failure blocks, earliest first, within MaxFailureBlocksLen
	blocksFull bool            // a block line did not fit: later ones are dropped, not interleaved
	inFailTest bool            // a --- FAIL block is open: indented lines continue it
	panicLeft  int             // trace lines a panic block still takes
```

`Write` starts with `b.total += len(p); b.scanLines(p)`, and its tail logic stays as it is. New methods:

```go
func (b *tailBuffer) scanLines(p []byte) {
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			b.appendPartial(p)
			return
		}
		b.appendPartial(p[:i])
		b.scanLine(strings.TrimRight(string(b.partial), "\r"))
		b.partial = b.partial[:0]
		p = p[i+1:]
	}
}

// appendPartial keeps at most MaxFailureBlocksLen of a line: a marker opens a line, so a longer one's
// rest is never needed.
func (b *tailBuffer) appendPartial(p []byte) {
	if room := MaxFailureBlocksLen - len(b.partial); room > 0 {
		b.partial = append(b.partial, p[:min(len(p), room)]...)
	}
}

func (b *tailBuffer) scanLine(line string) {
	trimmed := strings.TrimSpace(line)
	switch {
	case b.panicLeft > 0:
		b.panicLeft--
		b.keep(line)
	case strings.HasPrefix(trimmed, "--- FAIL:"):
		b.inFailTest = true
		b.keep(line)
	case strings.HasPrefix(trimmed, "panic:"):
		b.inFailTest, b.panicLeft = false, panicBlockLines
		b.keep(line)
	case strings.HasPrefix(line, "FAIL\t") || (strings.HasPrefix(line, "FAIL ") && trimmed != "FAIL"):
		b.inFailTest = false
		b.keep(line) // go test's per-package summary: which package failed
	case b.inFailTest && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")):
		b.keep(line)
	default:
		b.inFailTest = false
	}
}

func (b *tailBuffer) keep(line string) {
	if b.blocksFull || b.blocks.Len()+len(line)+1 > MaxFailureBlocksLen {
		b.blocksFull = true
		return
	}
	b.blocks.WriteString(line)
	b.blocks.WriteByte('\n')
}

// failureOutput is what a failed command records. When the tail dropped part of the output, the failure
// blocks found in the whole of it come first, so the failing test outlives a noisy package's log.
func (b *tailBuffer) failureOutput() string {
	if len(b.partial) > 0 {
		b.scanLine(strings.TrimRight(string(b.partial), "\r"))
		b.partial = b.partial[:0]
	}
	tail := b.String()
	if b.total <= b.max || b.blocks.Len() == 0 {
		return tail
	}
	head := strings.TrimSpace(b.blocks.String()) + "\n…\n"
	if room := b.max - len(head); len(tail) > room {
		tail = strings.TrimSpace(strings.ToValidUTF8(tail[len(tail)-room:], ""))
	}
	return head + tail
}
```

Add `bytes` to the imports. In `execPlanCommandEnv`, the failure path builds
`pe := &planCommandError{exitCode: -1, output: out.failureOutput()}`. The pass path still returns
`out.String()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/orchestrate/`
Expected: PASS (the whole package, so the existing tail, excerpt and Verify tests still hold).

- [ ] **Step 5: Commit**

```bash
git add pkg/orchestrate/plancmd.go pkg/orchestrate/plancmd_test.go
git commit -m "fix(orchestrate): keep a failed Verify's failing test past its output tail"
```

### Task 3: A pushed WOS update wins over an older in-flight fetch
**Depends on:** none

Finding 24, the WOS part only. Spec §3.

**Files:**
- Modify: `frontend/app/store/wos.ts` (`updateWaveObject`, ~:285-307)
- Create: `frontend/app/store/wos.test.ts`

**Interfaces:**
- Produces: nothing new. Behavior: `updateWaveObject` drops the pending fetch of the oref it updates or deletes.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/store/wos.test.ts`. It mocks only the transport boundary. `GetObject` calls
`callBackendService`, which calls `fetch` from `@/util/fetchutil` and reads `respData.data`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

// each GetObject fetch parks here until the test settles it with the object it "found"
const inflight: Array<(data: unknown) => void> = [];

vi.mock("@/util/fetchutil", () => ({
    fetch: vi.fn(
        () =>
            new Promise((resolve) =>
                inflight.push((data) => resolve({ ok: true, json: async () => ({ data }) }))
            )
    ),
}));
vi.mock("@/util/endpoints", () => ({ getWebServerEndpoint: () => "http://wavesrv.test" }));
vi.mock("@/app/store/windowtype", () => ({ isPreviewWindow: () => false }));

import { globalStore } from "./jotaiStore";
import { getWaveObjectValue, loadAndPinWaveObject, updateWaveObject } from "./wos";

const settle = () => new Promise((r) => setTimeout(r, 0));

let n = 0;
function freshRun(): { oref: string; oid: string } {
    // the WOS cache is module-global: every case gets its own object
    const oid = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    return { oref: `run:${oid}`, oid };
}

describe("wos pushed update vs in-flight fetch", () => {
    beforeEach(() => {
        inflight.length = 0;
    });

    it("keeps a pushed update when an older fetch resolves null after it", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const pushed = { otype: "run", oid, version: 1 } as unknown as WaveObj;
        updateWaveObject({ updatetype: "update", otype: "run", oid, obj: pushed } as WaveObjUpdate);
        expect(await loadAndPinWaveObject(oref)).toBe(pushed);
        inflight.shift()(null);
        await settle();
        expect(globalStore.get(wov.dataAtom).value).toBe(pushed);
    });

    it("keeps a pushed delete when an older fetch resolves the object after it", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        updateWaveObject({ updatetype: "delete", otype: "run", oid } as WaveObjUpdate);
        inflight.shift()({ otype: "run", oid, version: 1 });
        await settle();
        expect(globalStore.get(wov.dataAtom).value).toBeNull();
    });

    it("still lands a fetch nothing overtook", async () => {
        const { oref, oid } = freshRun();
        const wov = getWaveObjectValue(oref);
        const found = { otype: "run", oid, version: 3 };
        inflight.shift()(found);
        await settle();
        expect(globalStore.get(wov.dataAtom)).toEqual({ value: found, loading: false, error: false });
    });
});
```

If importing `./wos` pulls in a module that fails to load under vitest (check the error), mock that
module at its boundary the same way. Don't stub WOS's own functions. If `WaveObj`/`WaveObjUpdate`
aren't visible as globals in test files, use `as any`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/store/wos.test.ts`
Expected: the first two cases FAIL (the late fetch overwrites the pushed value), and the third passes.

- [ ] **Step 3: Implement**

In `updateWaveObject`, clear the pending fetch right before each `globalStore.set`, in the delete branch
and in the update branch (after the version check):

```ts
    if (update.updatetype == "delete") {
        dlog("WaveObj deleted", oref);
        // a pushed change is newer than any fetch still in flight: drop that fetch, or a late read of
        // the object before it existed overwrites the change and nothing refetches
        wov.pendingPromise = null;
        globalStore.set(wov.dataAtom, { value: null, loading: false, error: false });
    } else {
        ...
        dlog("WaveObj updated", oref);
        wov.pendingPromise = null;
        globalStore.set(wov.dataAtom, { value: update.obj, loading: false, error: false });
    }
```

The existing `wov.pendingPromise != localPromise` guard in `createWaveValueObject` then drops the late
result.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/store && npx prettier --check frontend/app/store/wos.ts frontend/app/store/wos.test.ts`
Expected: PASS; prettier clean for both files.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/store/wos.ts frontend/app/store/wos.test.ts
git commit -m "fix(wos): let a pushed update win over an older in-flight fetch"
```

### Task 4: Sealed evidence labels transcript commands as what the worker ran
**Depends on:** none

Finding 21. Spec §4.

**Files:**
- Modify: `pkg/jarvis/evidence.go:32-61` (`verifPattern`, `runnerPattern`, `isVerifCommand`, `classifyVerif`) and `verifAccum.addTranscript` (~:191-229)
- Modify: `pkg/waveobj/wtype.go:564` (the `EvidenceVerif.Result` comment only)
- Test: `pkg/jarvis/evidence_test.go` (table ~:25-59, `TestClassifyVerifUnknownOnEmptyResult` ~:61, result assertions ~:141, ~:324-327, ~:379, ~:586)

**Interfaces:**
- Produces: `const VerifResult_Ran = "ran"` in `pkg/jarvis`. `isVerifCommand(command string) bool` keeps its signature with new semantics. `classifyVerif` is deleted: its only caller is `addTranscript`, which already filters with `isVerifCommand`.

- [ ] **Step 1: Write the failing tests**

Replace the `classifyVerif` table test with an `isVerifCommand` table, and keep every existing case's
match expectation:

```go
func TestIsVerifCommand(t *testing.T) {
	cases := []struct {
		cmd  string
		want bool
	}{
		// existing cases (runner-led invocations classify; prose does not)
		{"pnpm test coupons", true},
		{"pnpm typecheck", true},
		{"npm run lint", true},
		{"go test ./...", true},
		{"npm test", true},
		{"vitest run", true},
		{"pytest -q", true},
		{"npx tsc --noEmit", true},
		{"pnpm build", true},
		{"echo hi && pnpm test", true},
		{"ls -la", false},
		{"git commit -m \"test: add auth\"", false},
		{"echo build it", false},
		{"git diff --stat", false},
		{"git commit -m \"build: bump deps\"", false},
		// finding 21's four commands
		{`grep -rn "landing" frontend --include=*.ts | grep -iv "^.*test" | head -20; grep -rln "landing" pkg --include=*.go`, false},
		{"go test ./pkg/jarvis/ -run EffectiveLanding 2>&1 | tail -3; go test ./pkg/orchestrate/ 2>&1 | tail -3", true},
		{"git diff frontend/types/gotypes.d.ts && go test ./pkg/jarvis/ 2>&1 | tail -30", true},
		{"sed -i '599s/a/b/' pkg/waveobj/wtype.go && task generate && go build ./... && go vet ./pkg/...", true},
		// a runner behind env, a cd, a path, or .exe
		{"CGO_ENABLED=0 GOOS=linux go test ./pkg/...", true},
		{`cd "C:/work/tree" && npm test`, true},
		{`C:\Go\bin\go.exe test ./...`, true},
		{"./node_modules/.bin/vitest run", true},
		{"node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit", true},
		// an edit or a search alone is not a check
		{"sed -i 's/test/spec/' pkg/x_test.go", false},
		{"rg -n 'go test' docs", false},
	}
	for _, c := range cases {
		if got := isVerifCommand(c.cmd); got != c.want {
			t.Errorf("isVerifCommand(%q) = %v, want %v", c.cmd, got, c.want)
		}
	}
}
```

Replace `TestClassifyVerifUnknownOnEmptyResult` with a transcript-level test. It reuses the file's
`verifToolUseLine`/`verifResultLine` helpers (read their signatures at ~:222-240):

```go
func TestTranscriptVerifsReadRanWhateverTheOutcome(t *testing.T) {
	acc := newVerifAccum()
	acc.addTranscript([]string{
		verifToolUseLine("b1", "go test ./pkg/x/ 2>&1 | tail -3"),
		verifResultLine("b1", false, "FAIL\tpkg/x\t0.4s"), // the pipe hid the failure's exit code
		verifToolUseLine("b2", "npm test"),
		verifResultLine("b2", true, "1 failing"),
		verifToolUseLine("b3", "pnpm typecheck"),
		verifResultLine("b3", false, ""),
		verifToolUseLine("b4", "go vet ./..."), // no result at all
	})
	if len(acc.out) != 4 {
		t.Fatalf("want 4 lines, got %+v", acc.out)
	}
	for _, v := range acc.out {
		if v.Result != VerifResult_Ran {
			t.Errorf("%q result = %q, want %q", v.Cmd, v.Result, VerifResult_Ran)
		}
	}
	if acc.out[0].Detail != "FAIL\tpkg/x\t0.4s" {
		t.Errorf("detail must keep the runner's summary, got %q", acc.out[0].Detail)
	}
}
```

Update the transcript-derived `Result` assertions (~:141, ~:324, ~:327, ~:379, ~:586) from
`"pass"`/`"fail"` to `VerifResult_Ran`. Keep each test's `Cmd` and `Detail` assertions. If any test
seals a dag run's evidence and asserts `dagVerifs`' `pass`/`fail`, leave that assertion as it is: those
are the engine's real results.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./pkg/jarvis/ -run 'IsVerifCommand|TranscriptVerifs|Verif|Evidence'`
Expected: FAIL. `VerifResult_Ran` is undefined, and the grep case matches today.

- [ ] **Step 3: Implement**

In `pkg/jarvis/evidence.go`, replace `runnerPattern`, `isVerifCommand` and `classifyVerif`:

```go
// VerifResult_Ran marks a verification line read from a worker's transcript. The command ran, but its exit
// status is no verdict: a pipe to tail reports tail's, and a grep that finds nothing fails. Only the
// engine's own Verify results (dagVerifs) are pass or fail.
const VerifResult_Ran = "ran"

// verifRunners are the programs that run a test, build, lint or typecheck. A command counts only when one of
// them leads a simple command in it, so a runner word elsewhere (a grep's --include=*.go) does not.
var verifRunners = map[string]bool{
	"npm": true, "pnpm": true, "yarn": true, "bun": true, "npx": true, "node": true, "go": true, "cargo": true,
	"dotnet": true, "make": true, "task": true, "mvn": true, "gradle": true, "python": true, "pytest": true,
	"vitest": true, "jest": true, "tsc": true, "eslint": true, "prettier": true, "tox": true, "flutter": true,
}

// shellSegmentSep splits a command into the simple commands it chains or pipes. A separator inside a quoted
// argument splits there too; at worst that drops a line, it never invents one.
var shellSegmentSep = regexp.MustCompile(`&&|\|\||[;|\n]`)

var envAssignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// isVerifCommand reports whether command runs a verification step: some simple command in it is led by a
// known runner and names a verification action.
func isVerifCommand(command string) bool {
	for _, seg := range shellSegmentSep.Split(command, -1) {
		fields := strings.Fields(seg)
		for len(fields) > 0 && envAssignment.MatchString(fields[0]) {
			fields = fields[1:]
		}
		if len(fields) == 0 {
			continue
		}
		runner := strings.TrimSuffix(path.Base(strings.ReplaceAll(fields[0], `\`, "/")), ".exe")
		if verifRunners[runner] && verifPattern.MatchString(seg) {
			return true
		}
	}
	return false
}
```

Add `path` to the imports. In `addTranscript`'s `tool_result` case, replace the `classifyVerif` call:

```go
				txt, _ := resultText(b.Content)
				// tool output is captured with a TTY attached, so it carries ANSI color codes
				v := waveobj.EvidenceVerif{Cmd: command, Result: VerifResult_Ran, Detail: verifSummaryLine(utilfn.StripANSI(txt))}
				if i, seen := a.idx[command]; seen {
					a.out[i] = v
				} else {
					a.idx[command] = len(a.out)
					a.out = append(a.out, v)
				}
```

The no-result loop at the end appends `Result: VerifResult_Ran`. Update the `verifPattern` comment's
"(we never invent expected steps)" only if it no longer reads true.

`pkg/waveobj/wtype.go:564`:

```go
	Result string `json:"result"` // "pass" | "fail": the engine's Verify; "ran": a worker's transcript; "unknown": older evidence
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./pkg/jarvis/ ./pkg/reporadar/`
Expected: PASS. `pkg/reporadar` still counts only `pass`/`fail`, so transcript lines no longer inflate
`VerifsPass`. That is intended (spec §4).

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvis/evidence.go pkg/jarvis/evidence_test.go pkg/waveobj/wtype.go
git commit -m "fix(evidence): report a worker's transcript checks as ran, not pass"
```
