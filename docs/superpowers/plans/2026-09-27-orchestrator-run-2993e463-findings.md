# Orchestrator findings from run 2993e463

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/...`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke`

**Goal:** Fix four findings from watching run 2993e463: answer a run's own ask from the CLI, cut the land subject at a boundary, seal only checks as evidence, and name every blocking state on a blocked dag.

**Architecture:** Four independent fixes in four areas (`wsh runs` plus two RPCs; `pkg/orchestrate/land.go`; `pkg/jarvis/evidence.go`; `pkg/jarvis/attention.go`), then one doc task that records them in the findings doc.

**Tech Stack:** Go (wavesrv, wsh, cobra), `task generate` for the RPC bindings.

**Spec:** `docs/superpowers/specs/2026-09-27-orchestrator-run-2993e463-findings-design.md`

## Global Constraints

- Go tests that touch the store need CGO and zig: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/<pkg>/ -run <Name> -count=1`.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, ...). Change the Go types, then run `task generate`.
- Comments only for "why", lower case, like the surrounding code. No attribution trailers in commits.
- `gofmt -l` only the files you touched; never format the tree. Never run prettier on `scripts/*.mjs`.
- Don't pipe a test into `tail`/`head`/`grep` without `set -o pipefail`: the pipe hides the exit code.

## Review Focus

- A run whose lead has no pending ask: `wsh runs answer` must say `run <id> has no pending question`, not succeed silently (Task 1 test).
- A goal with no path and no sentence end, just long: the subject must still be cut at a word, within 72 runes (Task 2 long-goal case).
- A check chained after `cd` with a quoted env value (`CC="zig cc -target ..." go test`): it must still count (Task 3 table).
- A heredoc whose body holds a line that looks like a check: the body must not be sealed (Task 3 table).
- A blocked dag with a failed task and `Failures` below the limit: no `consecutive failures` text (Task 4 test).

---

### Task 1: Answer a run's own pending ask from the CLI
**Depends on:** none

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (two commands, two data types)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`RunAsksCommand`, `RunAnswerCommand`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (`pendingRunAsk` helper; `DagAnswerCommand` uses it)
- Create: `pkg/wshrpc/wshserver/wshserver_runask_test.go`
- Modify: `cmd/wsh/cmd/wshcmd-runs.go` (`runs answer`, the question block in `runs show`, the attention footer)
- Modify: `cmd/wsh/cmd/wshcmd-runs_test.go`
- Modify: `pi/skills/cockpit-runs/SKILL.md`, `docs/orchestrator-guide.md` (the `wsh runs` table near line 816)
- Generated: run `task generate`

**Interfaces:**
- Produces: `RunAsksCommand(ctx, wshrpc.CommandRunAskData) (*wshrpc.CommandDagAsksRtnData, error)`, `RunAnswerCommand(ctx, wshrpc.CommandRunAnswerData) error`, CLI `wsh runs answer <run-id> <answers-json>`.

- [ ] **Step 1: Add the RPC types.** In `wshrpctypes_runs.go`, add to the runs command interface, beside `AckRunCommand`:

```go
RunAsksCommand(ctx context.Context, data CommandRunAskData) (*CommandDagAsksRtnData, error) // the pending question on a run's own session (a lead's, or a quick run's)
RunAnswerCommand(ctx context.Context, data CommandRunAnswerData) error                      // answer a run's own pending question
```

and the types:

```go
type CommandRunAskData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
}

type CommandRunAnswerData struct {
	ChannelId string                   `json:"channelid"`
	RunId     string                   `json:"runid"`
	Answers   []baseds.AgentAnswerItem `json:"answers"`
}
```

Run `task generate`.

- [ ] **Step 2: Write the failing server test** in `wshserver_runask_test.go`. Build a fixture like `dagAskFixture` (`wshserver_dagask_test.go:28`) but without a dag: a channel, a run whose `Phases` is `[]waveobj.RunPhase{{WorkerOrefs: []string{"tab:" + tabId}}}`, and the tab and block inserted with `wstore.DBInsert`. Then:

```go
func TestRunAsksAndAnswerReachTheRunsOwnSession(t *testing.T) {
	ch, run, blockORef := runAskFixture(t)
	ws := &WshServer{}
	agentask.GlobalRegistry = agentask.MakeRegistry()
	q := baseds.AgentAskQuestion{Question: "A or B?", Options: []baseds.AgentAskOption{{Label: "A"}, {Label: "B"}}}
	agentask.GlobalRegistry.Set(blockORef, agentask.PendingAsk{AskId: "ask-lead", Questions: []baseds.AgentAskQuestion{q}, Ts: 1})
	waiter := agentask.GlobalRegistry.RegisterWaiter("ask-lead")

	asks, err := ws.RunAsksCommand(context.Background(), wshrpc.CommandRunAskData{ChannelId: ch.OID, RunId: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(asks.Asks) != 1 || asks.Asks[0].Questions[0].Question != "A or B?" || asks.Asks[0].BlockORef != blockORef {
		t.Fatalf("asks = %+v, want the run's own question", asks.Asks)
	}
	if err := ws.RunAnswerCommand(context.Background(), wshrpc.CommandRunAnswerData{
		ChannelId: ch.OID, RunId: run.ID, Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{1}}},
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-waiter:
		if len(res.Answers) != 1 || res.Answers[0].SelectedIndexes[0] != 1 {
			t.Fatalf("answer not delivered: %+v", res.Answers)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waiter never resolved")
	}
	if err := ws.RunAnswerCommand(context.Background(), wshrpc.CommandRunAnswerData{
		ChannelId: ch.OID, RunId: run.ID, Answers: []baseds.AgentAnswerItem{{SelectedIndexes: []int{0}}},
	}); err == nil || !strings.Contains(err.Error(), "has no pending question") {
		t.Fatalf("second answer err = %v, want no pending question", err)
	}
}
```

Also a case where the run has no ask: `RunAsksCommand` returns an empty `Asks`, no error.

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/wshrpc/wshserver/ -run 'RunAsks|DagAsks|DagAnswer' -count=1`. Expected: fails to compile (no `RunAsksCommand`).

- [ ] **Step 3: Implement the server.** In `wshserver_dag.go`:

```go
// pendingRunAsk finds the pending ask on one of a run's own blocks: a lead's own question, or a task worker's.
func pendingRunAsk(ctx context.Context, run *waveobj.Run) (string, agentask.PendingAsk, bool) {
	for _, bo := range orchestrate.RunBlockORefs(ctx, run) {
		if p, ok := agentask.GlobalRegistry.Get(bo); ok {
			return bo, p, true
		}
	}
	return "", agentask.PendingAsk{}, false
}
```

In `DagAnswerCommand`, keep the `len(blocks) == 0` "has no worker blocks" error, then replace the block loop with `bo, p, pending := pendingRunAsk(ctx, child)`; when `pending`, apply the existing lead-owner refusal and `AnswerAgentCommand`; otherwise the existing "has no pending ask" error. (Check the registry's `Get` return type and use it as the helper's middle return.)

In `wshserver_runs.go`:

```go
// RunAsksCommand lists the pending question on a run's own session, for `wsh runs show`. A task's asks are its
// dag's (`dag asks`); this is the lead's own AskUserQuestion, which no dag command reaches.
func (ws *WshServer) RunAsksCommand(ctx context.Context, data wshrpc.CommandRunAskData) (*wshrpc.CommandDagAsksRtnData, error) {
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return nil, fmt.Errorf("loading run: %w", err)
	}
	rtn := &wshrpc.CommandDagAsksRtnData{Asks: []wshrpc.DagAskItem{}}
	if bo, p, ok := pendingRunAsk(ctx, run); ok && len(p.Questions) > 0 {
		rtn.Asks = append(rtn.Asks, wshrpc.DagAskItem{AskId: p.AskId, Owner: p.Owner, Deadline: p.Deadline, Note: p.Note, Questions: p.Questions, BlockORef: bo, Ts: p.Ts})
	}
	return rtn, nil
}

// RunAnswerCommand answers a run's own pending question through the same delivery as the cockpit's ask card.
func (ws *WshServer) RunAnswerCommand(ctx context.Context, data wshrpc.CommandRunAnswerData) error {
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	bo, _, ok := pendingRunAsk(ctx, run)
	if !ok {
		return fmt.Errorf("run %s has no pending question", data.RunId)
	}
	return ws.AnswerAgentCommand(ctx, wshrpc.CommandAnswerAgentData{ORef: bo, Answers: data.Answers})
}
```

Run the step 2 command. Expected: PASS, and the existing `DagAsks`/`DagAnswer` tests still pass.

- [ ] **Step 4: Write the failing CLI tests** in `wshcmd-runs_test.go`. `runsShowLines` gains a last parameter `asks []wshrpc.DagAskItem`; update every existing call to pass `nil`.

```go
func TestRunsShowLinesPrintsTheRunsOwnQuestion(t *testing.T) {
	ch := &waveobj.Channel{OID: "c-1", Name: "alpha"}
	run := &waveobj.Run{ID: "r-1", Goal: "g", Status: "executing"}
	asks := []wshrpc.DagAskItem{{Questions: []baseds.AgentAskQuestion{{Header: "Path", Question: "Which path?", Options: []baseds.AgentAskOption{{Label: "A"}, {Label: "B", Description: "the other"}}}}}}
	lines := runsShowLines(ch, run, nil, 2, asks)
	for _, want := range []string{"question", "  [Path] Which path?", "    0) A", "    1) B - the other"} {
		if !slices.Contains(lines, want) {
			t.Fatalf("missing %q in:\n%s", want, strings.Join(lines, "\n"))
		}
	}
	if !slices.ContainsFunc(lines, func(l string) bool { return strings.HasPrefix(l, "answer:  wsh runs answer r-1 ") }) {
		t.Fatalf("no answer line in:\n%s", strings.Join(lines, "\n"))
	}
	if slices.Contains(runsShowLines(ch, run, nil, 2, nil), "question") {
		t.Fatal("a run with no pending question printed a question block")
	}
}
```

Also assert that `runsAttentionLines`' footer contains `wsh runs answer`. Run `go test ./cmd/wsh/cmd/ -run 'RunsShow|RunsAttention' -count=1`. Expected: FAIL.

- [ ] **Step 5: Implement the CLI.** In `wshcmd-runs.go`:

```go
func runsQuestionLines(runId string, asks []wshrpc.DagAskItem) []string {
	if len(asks) == 0 {
		return nil
	}
	lines := []string{"question"}
	for _, a := range asks {
		for _, q := range a.Questions {
			lines = append(lines, dagQuestionLines(q)...)
		}
	}
	return append(lines, fmt.Sprintf(`answer:  wsh runs answer %s '[{"selectedindexes":[0]}]'  (one item per question, in order; {"text":"..."} for free text)`, runId))
}
```

In `runsShowLines`, append `runsQuestionLines(r.ID, asks)...` right after the four initial lines (run, goal, project, status). In `runsShowRun`, read the asks and pass them, and add `"asks": asks` to the JSON map:

```go
// runsAsks reads a run's own pending question, or nil when the read fails; show is still useful without it.
func runsAsks(channelId string, run *waveobj.Run) []wshrpc.DagAskItem {
	rtn, err := wshclient.RunAsksCommand(RpcClient, wshrpc.CommandRunAskData{ChannelId: channelId, RunId: run.ID}, &wshrpc.RpcOpts{Timeout: runsReadTimeoutMs})
	if err != nil {
		fmt.Fprintf(os.Stderr, "pending question unavailable: %v\n", err)
		return nil
	}
	return rtn.Asks
}
```

Add the command, register it in `runsCmd.AddCommand`, and give it the `--channel` flag through the same loop as `show` (near line 135):

```go
var runsAnswerCmd = &cobra.Command{
	Use:     "answer <run-id> <answers-json>",
	Short:   "answer a run's own pending question, which `wsh runs show` prints (answers-json: [{\"selectedindexes\":[0]}] or [{\"text\":\"...\"}])",
	Args:    cobra.ExactArgs(2),
	PreRunE: preRunSetupRpcClient,
	RunE:    runsAnswerRun,
}

func runsAnswerRun(cmd *cobra.Command, args []string) error {
	var answers []baseds.AgentAnswerItem
	if err := json.Unmarshal([]byte(args[1]), &answers); err != nil {
		return fmt.Errorf("answers json: %w", err)
	}
	ch, run, err := runsFind(cmd, args[0])
	if err != nil {
		return err
	}
	return wshclient.RunAnswerCommand(RpcClient, wshrpc.CommandRunAnswerData{ChannelId: ch.OID, RunId: run.ID, Answers: answers}, &wshrpc.RpcOpts{Timeout: dagAnswerTimeoutMs(answers)})
}
```

The attention footer becomes: `a run's detail and its own question: wsh runs show <run-id>, answered with wsh runs answer <run-id> '<answers-json>'; its tasks' questions: wsh jarvis dag asks --channel <id> --runid <run-id>`.

Run the step 4 command. Expected: PASS.

- [ ] **Step 6: Docs.** `pi/skills/cockpit-runs/SKILL.md`: after the `wsh runs show` line, add ``- `wsh runs answer <run-id> '<answers-json>'` answers the run's own pending question (a lead's AskUserQuestion), which `wsh runs show` prints with numbered options.`` `docs/orchestrator-guide.md`, in the `wsh runs` table: ``| `wsh runs answer <run-id> <answers-json>` | answer the run's own question (the lead's), which `runs show` prints |``.

- [ ] **Step 7: Check and commit.** `go vet ./pkg/wshrpc/... ./cmd/wsh/...`, `gofmt -l` on the touched Go files, `task check:ts` (the generated TS changed). Commit: `feat(runs): answer a run's own pending question from the CLI`.

### Task 2: Cut the land subject at a sentence or word boundary
**Depends on:** none

**Files:**
- Modify: `pkg/orchestrate/land.go:338-357` (`landTitle`, new `landSubject`)
- Test: `pkg/orchestrate/land_test.go` (`TestLandTitleNamesTheChangeOnOneLine`)

**Interfaces:**
- Produces: `landSubject(s string) string` (package-private).

- [ ] **Step 1: Write the failing cases.** Replace the cases in `TestLandTitleNamesTheChangeOnOneLine` (keep its rune-limit assertion) with:

```go
long := strings.Repeat("fix the orchestrator findings ", 40)
goal2993 := `Close the last open orchestrator gaps in C:\Users\cktra\Projects\waveterm\docs\orchestrator-findings-2026-09-25.md and C:\Users\cktra\Projects\waveterm\docs\orchestrator-redesign-flaws.md. 1. Finding 22 known gap: a worker resuming after a long ask`
cases := []struct {
	name, title, goal, want string
}{
	{"the plan's title", "Coupon codes", "a goal", "Coupon codes"},
	{"the template's suffix dropped", "Orchestrator small findings Implementation Plan", "", "Orchestrator small findings"},
	{"a title that is only the suffix", " Implementation Plan", "Add coupons\nmore", "Implementation Plan"},
	{"the goal's first line with no title", "", "Add coupons\nand more", "Add coupons"},
	{"run 2993e463's goal is cut before the path", "", goal2993, "Close the last open orchestrator gaps in…"},
	{"an absolute path becomes its base name", "", `Fix the land title in C:\x\pkg\orchestrate\land.go`, "Fix the land title in land.go"},
	{"a unix path becomes its base name", "", "Fix /home/u/src/land.go, then ship", "Fix land.go, then ship"},
	{"the first sentence only", "", "Fix it. Then more", "Fix it"},
	{"a question keeps its mark", "", "Why does it hang? Find out", "Why does it hang?"},
	{"a long goal is cut at a word", "", long, "fix the orchestrator findings fix the orchestrator findings fix the…"},
	{"a long title is cut at a word", long, "", "fix the orchestrator findings fix the orchestrator findings fix the…"},
	{"one long token is clipped", "", strings.Repeat("x", 100), strings.Repeat("x", 71) + "…"},
	{"nothing to go on", "", "", "Land run r-1"},
}
```

Run: `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -run TestLandTitle -count=1`. Expected: FAIL on the path, sentence and word cases.

- [ ] **Step 2: Implement.** In `land.go`:

```go
// absPathToken is a word that is an absolute path (a drive, a share, root or home); trailing punctuation belongs
// to the sentence around it.
var absPathToken = regexp.MustCompile(`^([A-Za-z]:[\\/]|\\\\|/|~/)(.*?)([.,;:)]*)$`)

var sentenceEnd = regexp.MustCompile(`[.?!]\s`)

// landSubject makes one line of text a merge subject: absolute paths shrink to their base name, the text stops at
// its first sentence, and a subject over maxLandTitleLen is cut at a word, so it never ends inside a path.
func landSubject(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		m := absPathToken.FindStringSubmatch(w)
		if m == nil {
			continue
		}
		p := strings.TrimRight(m[1]+m[2], `\/`)
		if base := p[strings.LastIndexAny(p, `\/`)+1:]; base != "" {
			words[i] = base + m[3]
		}
	}
	s = strings.Join(words, " ")
	if loc := sentenceEnd.FindStringIndex(s); loc != nil {
		s = strings.TrimSuffix(s[:loc[0]+1], ".")
	}
	r := []rune(s)
	if len(r) <= maxLandTitleLen {
		return s
	}
	head := string(r[:maxLandTitleLen])
	if i := strings.LastIndex(head, " "); i > 0 {
		return strings.TrimRight(head[:i], ",;: ") + "…"
	}
	return clipRunes(s, maxLandTitleLen)
}
```

In `landTitle`, return `landSubject(title)` and `landSubject(strings.TrimSpace(goal))` in place of the two `clipRunes` calls. Update `landTitle`'s comment: `the plan's title, else the goal's first line, each cut by landSubject`. If `clipRunes` has no other caller left, keep it anyway (`landSubject` uses it).

Run the step 1 command. Expected: PASS. Then run the whole land suite: `go test ./pkg/orchestrate/ -run Land -count=1` with the same env.

- [ ] **Step 3: Commit.** `gofmt -l pkg/orchestrate/land.go pkg/orchestrate/land_test.go`, `go vet ./pkg/orchestrate/`. Commit: `fix(orchestrate): cut the land subject at a word, never inside a path`.

### Task 3: Seal only the check part of a command as evidence
**Depends on:** none

**Files:**
- Modify: `pkg/jarvis/evidence.go:32-75` (`verifPattern`, `isVerifCommand` → `verifChecks`), `:202-225` (`addTranscript`)
- Test: `pkg/jarvis/evidence_test.go` (`TestIsVerifCommand` → `TestVerifChecks`, a new `addTranscript` test, and any test asserting a `Cmd` that held a pipe or chain)

**Interfaces:**
- Produces: `verifChecks(command string) []string` (package-private); `isVerifCommand` is removed.

- [ ] **Step 1: Write the failing table.** Replace `TestIsVerifCommand` with `TestVerifChecks`, comparing with `slices.Equal` (nil and empty are both "no check"):

```go
func TestVerifChecks(t *testing.T) {
	nodeEdit := "cd \"C:/w\" && node -e '\nconst fs=require(\"fs\");const p=\"scripts/cdp/final-verify.test.mjs\";\nfs.writeFileSync(p,s);' && sed -n 209p scripts/cdp/final-verify.test.mjs; npx vitest run scripts/cdp/final-verify.test.mjs 2>&1 | tail -25"
	mutate := `cp scripts/cdp/final-verify.mjs "$TMP/fv.bak" && sed -i 's|a|b|' scripts/cdp/final-verify.mjs && npx vitest run scripts/cdp/final-verify.test.mjs -t "one after the other" 2>&1 | head -20; cp "$TMP/fv.bak" scripts/cdp/final-verify.mjs`
	heredoc := "node - <<'EOF'\nconst x = 1;\ngo test ./pkg/fake/\nEOF\nnpx vitest run a.test.ts"
	cases := []struct {
		cmd  string
		want []string
	}{
		{"pnpm test coupons", []string{"pnpm test coupons"}},
		{"npm run lint", []string{"npm run lint"}},
		{"npx tsc --noEmit", []string{"npx tsc --noEmit"}},
		{"echo hi && pnpm test", []string{"pnpm test"}},
		{"ls -la", nil},
		{`git commit -m "test: add auth"`, nil},
		{"echo build it", nil},
		// finding 21's four commands
		{`grep -rn "landing" frontend --include=*.ts | grep -iv "^.*test" | head -20; grep -rln "landing" pkg --include=*.go`, nil},
		{"go test ./pkg/jarvis/ -run EffectiveLanding 2>&1 | tail -3; go test ./pkg/orchestrate/ 2>&1 | tail -3", []string{"go test ./pkg/jarvis/ -run EffectiveLanding 2>&1", "go test ./pkg/orchestrate/ 2>&1"}},
		{"git diff frontend/types/gotypes.d.ts && go test ./pkg/jarvis/ 2>&1 | tail -30", []string{"go test ./pkg/jarvis/ 2>&1"}},
		{"sed -i '599s/a/b/' pkg/waveobj/wtype.go && task generate && go build ./... && go vet ./pkg/...", []string{"go build ./...", "go vet ./pkg/..."}},
		// run 2993e463's lead: an edit, then a test
		{nodeEdit, []string{"npx vitest run scripts/cdp/final-verify.test.mjs 2>&1"}},
		{mutate, []string{`npx vitest run scripts/cdp/final-verify.test.mjs -t "one after the other" 2>&1`}},
		{heredoc, []string{"npx vitest run a.test.ts"}},
		// inline scripts are edits or probes
		{`node -e 'require("fs").writeFileSync("a.test.ts", "")'`, nil},
		{`python -c "import pytest"`, nil},
		// checks by name
		{"go vet ./pkg/...", []string{"go vet ./pkg/..."}},
		{"task check:ts", []string{"task check:ts"}},
		{"npx prettier --check a.ts", []string{"npx prettier --check a.ts"}},
		{"git checkout main", nil},
		// a runner behind env (quoted too), a cd, a path, or .exe
		{"CGO_ENABLED=0 GOOS=linux go test ./pkg/...", []string{"CGO_ENABLED=0 GOOS=linux go test ./pkg/..."}},
		{`CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -count=1`, []string{`CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" go test ./pkg/orchestrate/ -count=1`}},
		{`cd "C:/work/tree" && npm test`, []string{"npm test"}},
		{`C:\Go\bin\go.exe test ./...`, []string{`C:\Go\bin\go.exe test ./...`}},
		{"node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit", []string{"node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit"}},
		{"sed -i 's/test/spec/' pkg/x_test.go", nil},
		{"rg -n 'go test' docs", nil},
	}
	for _, c := range cases {
		if got := verifChecks(c.cmd); !slices.Equal(got, c.want) {
			t.Errorf("verifChecks(%q) = %q, want %q", c.cmd, got, c.want)
		}
	}
}
```

And an accumulator test:

```go
func TestTranscriptSealsOnlyTheCheckAfterAnEdit(t *testing.T) {
	acc := newVerifAccum()
	acc.addTranscript([]string{
		verifToolUseLine("b1", `node -e 'require("fs").writeFileSync("a.ts", "x")' && npx vitest run a.test.ts 2>&1 | tail -5`),
		verifResultLine("b1", false, "Tests  1 failed"),
		verifToolUseLine("b2", `sed -i 's/x/y/' a.ts && npx vitest run a.test.ts 2>&1 | tail -5`),
		verifResultLine("b2", false, "Tests  1 passed"),
	})
	if len(acc.out) != 1 || acc.out[0].Cmd != "npx vitest run a.test.ts 2>&1" || acc.out[0].Detail != "Tests  1 passed" {
		t.Fatalf("got %+v, want one line holding only the test and its last result", acc.out)
	}
}
```

Run: `go test ./pkg/jarvis/ -run 'VerifChecks|SealsOnlyTheCheck' -count=1` (with the CGO env). Expected: fails to compile (no `verifChecks`).

- [ ] **Step 2: Implement.** In `evidence.go`:
  - `verifPattern`: add `vet|check` to the alternation.
  - Replace `envAssignment` with a leading-env matcher that takes quoted values: `var leadingEnv = regexp.MustCompile(`^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*`)`, and read the runner from `strings.Fields(leadingEnv.ReplaceAllString(seg, ""))`.
  - Add:

```go
// inlineScriptFlags make a runner run a script given inline or on stdin. That is an edit or a probe, never a
// check, even when the script names a test file.
var inlineScriptFlags = map[string]map[string]bool{
	"node":   {"-e": true, "--eval": true, "-p": true, "--print": true, "-": true},
	"bun":    {"-e": true, "--eval": true, "-p": true, "--print": true, "-": true},
	"python": {"-c": true, "-": true},
}

func inlineScript(runner string, args []string) bool {
	for _, a := range args {
		if inlineScriptFlags[runner][a] {
			return true
		}
		if !strings.HasPrefix(a, "-") {
			return false
		}
	}
	return false
}

// heredocStart opens a heredoc; a <<< herestring does not.
var heredocStart = regexp.MustCompile(`(?:^|[^<])<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`)

// stripHeredocs drops heredoc bodies, so a script's lines are never read as commands. An unterminated heredoc
// drops the rest.
func stripHeredocs(command string) string {
	lines := strings.Split(command, "\n")
	var out []string
	for i := 0; i < len(lines); i++ {
		out = append(out, lines[i])
		m := heredocStart.FindStringSubmatch(lines[i])
		if m == nil {
			continue
		}
		for i+1 < len(lines) && strings.TrimSpace(lines[i+1]) != m[1] {
			i++
		}
		i++
	}
	return strings.Join(out, "\n")
}

// verifChecks returns the simple commands in command that run a check: led by a known runner, naming a
// verification action, and not an inline script. The edits, cds and pipes around them are not checks.
func verifChecks(command string) []string {
	var checks []string
	for _, seg := range shellSegmentSep.Split(stripHeredocs(command), -1) {
		fields := strings.Fields(leadingEnv.ReplaceAllString(seg, ""))
		if len(fields) == 0 {
			continue
		}
		runner := strings.TrimSuffix(path.Base(strings.ReplaceAll(fields[0], `\`, "/")), ".exe")
		if verifRunners[runner] && !inlineScript(runner, fields[1:]) && verifPattern.MatchString(seg) {
			checks = append(checks, strings.TrimSpace(seg))
		}
	}
	return checks
}
```

  - In `addTranscript`'s `tool_use` case: `if b.Name == "Bash" { if checks := verifChecks(b.Input.Command); len(checks) > 0 { byToolID[b.ID] = strings.Join(checks, "; ") } }`. The accumulator keys on that text, so repeated runs merge.
  - Delete `isVerifCommand`; update the `verifRunners` and `shellSegmentSep` comments if they name it.

Run the step 1 command. Expected: PASS. Then run `go test ./pkg/jarvis/ -count=1` (CGO env): fix any existing test that asserted a whole piped command as `Cmd` (for example `go test ./pkg/x/ 2>&1 | tail -3` now seals as `go test ./pkg/x/ 2>&1`) by updating its expected `Cmd`, never by weakening the check.

- [ ] **Step 3: Commit.** `gofmt -l` and `go vet ./pkg/jarvis/`. Commit: `fix(jarvis): seal only the checks in a command, not the edits around them`.

### Task 4: Name every blocking state on a blocked dag
**Depends on:** none

**Files:**
- Modify: `pkg/jarvis/attention.go:260-320` (`blockedTask`, `dagBlockedReason`)
- Test: `pkg/jarvis/attention_test.go` (new tests); `pkg/jarvis/attention_dag_test.go` (existing tests that must keep passing unchanged)

- [ ] **Step 1: Write the failing tests** in `attention_test.go`:

```go
func TestBlockedReviewFailedNamesTheReviewAndItsActions(t *testing.T) {
	items := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d1", RunID: "r1", ChannelId: "c1", Status: "blocked", UpdatedTs: 5,
		Tasks: []waveobj.TaskNode{
			{ID: "t-1", Label: "Restore the steering RPCs", State: "review-failed", ReviewNote: "reviewer gave no verdict within 20m0s"},
			{ID: "t-2", State: "pending"},
		},
	}}})
	if len(items) != 1 {
		t.Fatalf("items = %+v, want the one blocked dag", items)
	}
	it := items[0]
	if want := "Review of Restore the steering RPCs failed: reviewer gave no verdict within 20m0s"; it.Text != want {
		t.Fatalf("text = %q, want %q", it.Text, want)
	}
	for _, want := range []string{"0 of 2 tasks done.", "wsh jarvis dag approve t-1", "wsh jarvis dag sendback t-1"} {
		if !strings.Contains(it.Why, want) {
			t.Fatalf("why = %q, want %q in it", it.Why, want)
		}
	}
	if strings.Contains(it.Text+it.Why, "consecutive failures") {
		t.Fatalf("a review failure read as a failure count: %q / %q", it.Text, it.Why)
	}
	if it.TaskId != "t-1" || it.Retry {
		t.Fatalf("taskid/retry = %q/%v, want t-1/false", it.TaskId, it.Retry)
	}
}

func TestBlockedReviewFailedOutranksAMerge(t *testing.T) {
	items := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d1", RunID: "r1", ChannelId: "c1", Status: "blocked",
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "blocked-merge"}, {ID: "t-2", State: "review-failed", ReviewNote: "two rounds failed"}},
	}}})
	if !strings.HasPrefix(items[0].Text, "Review of t-2 failed") || items[0].TaskId != "t-2" {
		t.Fatalf("got %q (task %q), want t-2's review first, as the digest ranks it", items[0].Text, items[0].TaskId)
	}
}

func TestBlockedFailedTaskNamesItsFailureNotACount(t *testing.T) {
	items := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d1", RunID: "r1", ChannelId: "c1", Status: "blocked", Failures: 1,
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "failed", LastFailureKind: "exited"}},
	}}})
	if items[0].Text != "t-1 failed: exited" || !strings.Contains(items[0].Why, "wsh jarvis dag retry t-1") || strings.Contains(items[0].Text, "consecutive") {
		t.Fatalf("got %q / %q", items[0].Text, items[0].Why)
	}
}

func TestBlockedWithNoNamedCauseListsTheTasks(t *testing.T) {
	items := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d1", RunID: "r1", ChannelId: "c1", Status: "blocked",
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "done"}, {ID: "t-2", State: "stalled"}},
	}}})
	if items[0].Text != "The group is blocked: t-2 is stalled" || !strings.Contains(items[0].Why, "wsh jarvis dag status") {
		t.Fatalf("got %q / %q", items[0].Text, items[0].Why)
	}
}

func TestBlockedWithNothingToNameSaysSo(t *testing.T) {
	items := BuildAttention(AttentionInput{Dags: []*waveobj.TaskGroup{{
		ID: "d1", RunID: "r1", ChannelId: "c1", Status: "blocked",
		Tasks: []waveobj.TaskNode{{ID: "t-1", State: "done"}, {ID: "t-2", State: "pending"}},
	}}})
	if items[0].Text != "The group is blocked." {
		t.Fatalf("text = %q, want no dangling list", items[0].Text)
	}
}
```

These existing tests stay as they are and must still pass: `TestDagGateAndBlockedWhyCountSkippedTasksAsFinished` (attention_test.go), and in `attention_dag_test.go` `TestBuildAttentionKeepsTheFailureCountForFailedTasks` (a failed task at `Failures` 3 keeps `3 consecutive failures — decide retry/skip.`: the circuit break is checked before a failed task) and `TestBuildAttentionDagBlocked`. Run: `go test ./pkg/jarvis/ -run 'Blocked|DagGate' -count=1` (CGO env). Expected: the new tests FAIL, the existing ones pass.

- [ ] **Step 2: Implement.** In `attention.go`:
  - A mirror constant beside the task-state ones: `maxConsecutiveFailures = 3 // mirrors orchestrate.MaxConsecutiveFailures`, and `taskStateReviewFailed = "review-failed"`, `taskStatePending = "pending"` if not already spelled.
  - `blockedTask`: a first loop returns a `review-failed` task's id with `false`, then the existing loops.
  - `dagBlockedReason`, in this order; update its doc comment to say review-failed comes first as the digest (`buildNext`) ranks it, and that at the failure limit the count wins over a failed task because it explains why dispatch stopped:
    1. review-failed: text `Review of <name> failed`, plus `: <firstLine(ReviewNote)>` when the note is not empty; why `<done> The lead was woken to judge it: approve it as it is with `wsh jarvis dag approve <id>`, send it back with `wsh jarvis dag sendback <id> "<guidance>"`, or retry or skip it.`
    2. the existing blocked-merge, verify-failed and final-stage branches, unchanged and in their current order.
    3. `g.Failures >= maxConsecutiveFailures`: the existing `<n> consecutive failures — decide retry/skip.` line and its why, unchanged.
    4. failed (so below the limit): text `<name> failed`, plus `: <LastFailureKind>` when set; why `<done> Retry it with `wsh jarvis dag retry <id>`, skip it, or escalate it to another model.`
    5. fallback: text `The group is blocked: ` + `"<name> is <state>"` joined by `, ` for each task not done, skipped or pending, or `The group is blocked.` when no task is listed; why `<done> `wsh jarvis dag status` lists each task's actions.`

Run the step 1 command, then `go test ./pkg/jarvis/ -count=1`. Expected: PASS.

- [ ] **Step 3: Commit.** `gofmt -l`, `go vet ./pkg/jarvis/`. Commit: `fix(jarvis): name a review-failed or failed task on a blocked dag, not a failure count`.

### Task 5: Record the fixes in the findings doc
**Depends on:** Task 1, Task 2, Task 3, Task 4

**Files:**
- Modify: `docs/orchestrator-findings-2026-09-25.md`

- [ ] **Step 1: Read the landed code and tests.** `git log --oneline -6`, and read the test names each of Tasks 1-4 added or changed (`git show --stat HEAD~3..HEAD` and grep for `func Test` in the changed test files).

- [ ] **Step 2: Add the Summary rows.** In the Summary table (after the row for 36), four rows in its `| # | Finding | Severity | Fix size |` form:
  - `| 37 | A lead's own AskUserQuestion can't be answered from the CLI: `wsh runs` has no answer and `dag answer` reaches only task workers | medium | fixed: `wsh runs answer`, question in `runs show` |`
  - `| 38 | The land subject falls back to the goal and is clipped mid-path (63ce6a224) | low | fixed: base names, sentence and word cut |`
  - `| 39 | Sealed `verify ran` lines include the lead's inline edits (`node -e`, `sed -i`, `cp`) | medium | fixed: only the check part is sealed |`
  - `| 40 | A review-failed task's blocked dag reads "0 consecutive failures" (dag 9b17c7e9) | medium | fixed: a reason and action per blocking state |`

- [ ] **Step 3: Add the Fixes table** at the end of the doc:

```markdown
## Fixes: run 2993e463

| # | Fix | Test |
|---|---|---|
| 37 | ... | ... |
```

One row per finding, in the style of "Fixes: the last gaps in 21, 22 and 35": what the cause was, what changed (function names in backticks), and the test names as they landed. For 37: `RunAsksCommand`/`RunAnswerCommand` over the run's own blocks (`pendingRunAsk`, shared with `dag answer`), the `question` block in `runs show`, `runs answer`, the attention footer. For 38: `landSubject`, with 2993e463's goal now `Close the last open orchestrator gaps in…`. For 39: `verifChecks` (inline scripts and heredoc bodies never count, `vet` and `check` count, a quoted env value no longer hides the runner), and that repeated runs of one test after different edits merge into one line. For 40: the order and the texts of `dagBlockedReason`, and that `blockedTask` now names a review-failed task.

Do not write the live-check note: the lead adds it after the run lands.

- [ ] **Step 4: Commit.** Commit: `docs(orchestrator): record the fixes for run 2993e463's findings`.
