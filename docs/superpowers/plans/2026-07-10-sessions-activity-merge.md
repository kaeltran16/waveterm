# Sessions + Activity Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Activity surface into a single master-detail **Sessions** surface backed by one Go parser, so the session list, the cross-session "All activity" feed, and per-session timelines all come from one source of truth.

**Architecture:** Port the frontend lifecycle-event extraction (`activityevents.ts`) into `pkg/agentsessions` so the existing per-file scan emits per-session `Events` + derived `Status`/`StartedTs`/`DurationMs` in the same pass. A new `GetSessionsActivity` RPC returns the rich shape; the lean `GetRecentSessions` stays for the launch hero. The rewritten `SessionsSurface` is master-detail: a recency-grouped session list (with a pinned "All activity"), a merged-feed right pane, and a per-session detail that reuses `NarrationTimeline`. Live agents are overlaid on the frontend (matched by transcript path) to flip Resume↔Jump. The old Activity surface + its FE extraction stack are deleted.

**Tech Stack:** Go (`pkg/agentsessions`, `pkg/wshrpc`), reflection-based wshrpc codegen (`task generate`), React 19 + jotai + Tailwind v4 `@theme` tokens, vitest, Go `testing`.

**Git policy (user override):** Per the user's CLAUDE.md, do **NOT** commit per task. Each task ends with a **Checkpoint** (run the stated verification). All changes — including this plan and the spec — fold into **one** feature commit at the end, and only **after explicit user approval**. Task-level "Checkpoint" replaces the skill's usual per-task commit.

**Spec:** `docs/superpowers/specs/2026-07-10-sessions-activity-merge-design.md`.

**Verification commands (referenced throughout):**
- Go single test: `go test ./pkg/agentsessions/ -run <TestName> -v`
- Go package: `go test ./pkg/agentsessions/`
- Go build: `go build ./...`
- Regenerate bindings: `task generate`
- Backend build (for RPC to run live): `task build:backend`
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline is clean; any error is yours)
- vitest single: `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts`
- CDP screenshot of live dev app: `node scripts/cdp-shot.mjs out.png` (dev app must be running via `task dev`)

---

## Phase 1 — Backend: lifecycle-event extraction in Go

All edits in this phase are in `pkg/agentsessions/`. The internal `SessionInfo` (agentsessions.go:27-39) gains event fields; two new pure extractors port `frontend/app/view/agents/activityevents.ts`; `scanProvider` populates the new fields in the same read it already does.

### Task 1: Shared event types + text/timestamp helpers

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go` (add types + helpers + fields)
- Test: `pkg/agentsessions/events_test.go` (create)

- [ ] **Step 1: Write the failing test**

Create `pkg/agentsessions/events_test.go`:

```go
package agentsessions

import "testing"

func TestClipText(t *testing.T) {
	if got := clipText("  hello   world  "); got != "hello world" {
		t.Errorf("clipText collapse = %q", got)
	}
	long := ""
	for i := 0; i < 120; i++ {
		long += "x"
	}
	got := clipText(long)
	if len([]rune(got)) != maxEventText {
		t.Errorf("clipText len = %d, want %d", len([]rune(got)), maxEventText)
	}
	if got[len(got)-len("…"):] != "…" {
		t.Errorf("clipText should end with ellipsis, got %q", got)
	}
}

func TestParseTs(t *testing.T) {
	if got := parseTs("2026-07-10T12:00:00.000Z"); got != 1783166400000 {
		t.Errorf("parseTs = %d", got)
	}
	if got := parseTs("garbage"); got != 0 {
		t.Errorf("parseTs(garbage) = %d, want 0", got)
	}
	if got := parseTs(""); got != 0 {
		t.Errorf("parseTs(empty) = %d, want 0", got)
	}
}

func TestCommitSubject(t *testing.T) {
	if got := commitSubject(`git commit -m "add coupon tests"`); got != "add coupon tests" {
		t.Errorf("commitSubject = %q", got)
	}
	if got := commitSubject("git commit"); got != "committed" {
		t.Errorf("commitSubject fallback = %q", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/agentsessions/ -run 'TestClipText|TestParseTs|TestCommitSubject' -v`
Expected: FAIL — `undefined: clipText`, `undefined: parseTs`, `undefined: commitSubject`, `undefined: maxEventText`.

- [ ] **Step 3: Add the types, fields, and helpers**

In `pkg/agentsessions/agentsessions.go`, add `"regexp"` to the import block. Add these fields to the `SessionInfo` struct (after `ResumeCommand`):

```go
	TranscriptPath string       // on-disk JSONL path; FE matches this against the live roster
	Status         string       // "done" | "failed" | "waiting" (FE overlays "running" for live)
	StartedTs      int64        // first event ts, UnixMilli
	DurationMs     int64        // last event ts - first event ts
	Events         []SessionEvent
```

Then add, near the bottom of the file (before `readLines`):

```go
// SessionEvent is one lifecycle event extracted from a transcript (ported from
// frontend/app/view/agents/activityevents.ts). Type ∈ started|asked|committed|errored|finished.
type SessionEvent struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
	Text string `json:"text"`
}

// sessionEvents is an extractor's full result: the ordered events plus derived summary fields.
type sessionEvents struct {
	Events     []SessionEvent
	Status     string
	StartedTs  int64
	DurationMs int64
}

const maxEventText = 100

var (
	wsRe        = regexp.MustCompile(`\s+`)
	commitRe    = regexp.MustCompile(`\bgit\s+commit\b`)
	commitMsgRe = regexp.MustCompile(`-m\s+["']([^"']+)["']`)
	exitCodeRe  = regexp.MustCompile(`Exit code:\s*(\d+)`)
)

// clipText collapses whitespace, trims, and caps at maxEventText runes with an ellipsis.
func clipText(s string) string {
	s = strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
	r := []rune(s)
	if len(r) > maxEventText {
		return strings.TrimSpace(string(r[:maxEventText-1])) + "…"
	}
	return s
}

// parseTs parses an ISO-8601 timestamp to UnixMilli, or 0 when absent/unparseable.
func parseTs(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func commitSubject(cmd string) string {
	if m := commitMsgRe.FindStringSubmatch(cmd); m != nil {
		return clipText(m[1])
	}
	return "committed"
}

// assembleEvents sorts the raw events, derives status from the last real event, prepends a synthetic
// "started" and (only for done sessions) appends a synthetic "finished", and computes duration.
func assembleEvents(raw []SessionEvent, firstTs, lastTs int64, startedText, finishedText string) sessionEvents {
	var real []SessionEvent
	for _, e := range raw {
		if e.Ts > 0 {
			real = append(real, e)
		}
	}
	sort.SliceStable(real, func(i, j int) bool { return real[i].Ts < real[j].Ts })

	status := "done"
	if n := len(real); n > 0 {
		switch real[n-1].Type {
		case "asked":
			status = "waiting"
		case "errored":
			status = "failed"
		}
	}

	var events []SessionEvent
	if firstTs > 0 {
		events = append(events, SessionEvent{Type: "started", Ts: firstTs, Text: startedText})
	}
	events = append(events, real...)
	if status == "done" && lastTs > 0 {
		events = append(events, SessionEvent{Type: "finished", Ts: lastTs, Text: finishedText})
	}
	sort.SliceStable(events, func(i, j int) bool { return events[i].Ts < events[j].Ts })

	var dur int64
	if firstTs > 0 && lastTs > firstTs {
		dur = lastTs - firstTs
	}
	return sessionEvents{Events: events, Status: status, StartedTs: firstTs, DurationMs: dur}
}
```

> Note: `1783166400000` in the test is the UnixMilli for `2026-07-10T12:00:00.000Z`. If your local `parseTs` returns a different value, the constant is wrong, not the code — recompute with `date -u -d 2026-07-10T12:00:00Z +%s000` and update the test literal.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/agentsessions/ -run 'TestClipText|TestParseTs|TestCommitSubject' -v`
Expected: PASS. (`assembleEvents` is unused until Task 2 — Go allows unused funcs, only unused locals/imports fail. If `regexp`/`sort` were already imported, no import error.)

- [ ] **Step 5: Checkpoint**

Run: `go build ./pkg/agentsessions/` — Expected: exit 0.

---

### Task 2: Claude event extractor

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go` (add `extractClaudeEvents` + line/block structs + `askText`)
- Test: `pkg/agentsessions/events_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/agentsessions/events_test.go`:

```go
func TestExtractClaudeEvents(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"2026-07-10T12:00:00.000Z","message":{"content":"Fix the coupon coverage gap"}}`,
		`{"type":"assistant","timestamp":"2026-07-10T12:00:05.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git commit -m \"add coupon tests\""}}]}}`,
		`{"type":"assistant","timestamp":"2026-07-10T12:00:08.000Z","message":{"content":[{"type":"tool_use","id":"t2","name":"AskUserQuestion","input":{"questions":[{"question":"Proceed with the migration?"}]}}]}}`,
	}
	got := extractClaudeEvents(lines)
	if got.Status != "waiting" {
		t.Errorf("status = %q, want waiting (last real event is an ask)", got.Status)
	}
	// started + committed + asked ; no finished (status != done)
	types := []string{}
	for _, e := range got.Events {
		types = append(types, e.Type)
	}
	want := []string{"started", "committed", "asked"}
	if len(types) != len(want) {
		t.Fatalf("event types = %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Fatalf("event types = %v, want %v", types, want)
		}
	}
	if got.Events[0].Text != "Fix the coupon coverage gap" {
		t.Errorf("started text = %q", got.Events[0].Text)
	}
	if got.Events[1].Text != "add coupon tests" {
		t.Errorf("committed text = %q", got.Events[1].Text)
	}
	if got.Events[2].Text != "Proceed with the migration?" {
		t.Errorf("asked text = %q", got.Events[2].Text)
	}
	if got.StartedTs != 1783166400000 {
		t.Errorf("startedTs = %d", got.StartedTs)
	}
	if got.DurationMs != 8000 {
		t.Errorf("durationMs = %d, want 8000", got.DurationMs)
	}
}

func TestExtractClaudeEvents_errorMarksFailedWithFinished(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"2026-07-10T09:00:00.000Z","message":{"content":"Migrate session store"}}`,
		`{"type":"assistant","timestamp":"2026-07-10T09:00:03.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"redis-cli ping"}}]}}`,
		`{"type":"user","timestamp":"2026-07-10T09:00:05.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true}]}}`,
	}
	got := extractClaudeEvents(lines)
	if got.Status != "failed" {
		t.Errorf("status = %q, want failed", got.Status)
	}
	last := got.Events[len(got.Events)-1]
	if last.Type != "errored" || last.Text != "failed: redis-cli ping" {
		t.Errorf("last event = %+v, want errored 'failed: redis-cli ping'", last)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/agentsessions/ -run TestExtractClaudeEvents -v`
Expected: FAIL — `undefined: extractClaudeEvents`.

- [ ] **Step 3: Implement the extractor**

Add to `pkg/agentsessions/agentsessions.go` (the `json` import is already present):

```go
type claudeEventLine struct {
	Type      string `json:"type"`
	Timestamp string `json:"timestamp"`
	Message   struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeBlock struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	ID    string `json:"id"`
	Name  string `json:"name"`
	Input struct {
		Command   string `json:"command"`
		Questions []struct {
			Question string `json:"question"`
			Header   string `json:"header"`
		} `json:"questions"`
	} `json:"input"`
	ToolUseID string `json:"tool_use_id"`
	IsError   bool   `json:"is_error"`
}

func askText(b claudeBlock) string {
	if len(b.Input.Questions) > 0 {
		q := b.Input.Questions[0]
		if q.Question != "" {
			return clipText(q.Question)
		}
		if q.Header != "" {
			return clipText(q.Header)
		}
	}
	return "asked a question"
}

// extractClaudeEvents ports frontend/app/view/agents/activityevents.ts:extractClaudeEvents. It does
// NOT gate the synthetic "finished" on liveness (Go can't know the live roster); assembleEvents only
// appends "finished" for done sessions, and the frontend strips it for live ones.
func extractClaudeEvents(lines []string) sessionEvents {
	var raw []SessionEvent
	cmdByID := map[string]string{}
	var firstTs, lastTs int64
	var firstUser, lastAssistant string
	for _, line := range lines {
		var rec claudeEventLine
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if ts := parseTs(rec.Timestamp); ts > 0 {
			if firstTs == 0 {
				firstTs = ts
			}
			lastTs = ts
		}
		ts := parseTs(rec.Timestamp)
		switch rec.Type {
		case "assistant":
			var blocks []claudeBlock
			if json.Unmarshal(rec.Message.Content, &blocks) != nil {
				continue
			}
			for _, b := range blocks {
				switch b.Type {
				case "text":
					if strings.TrimSpace(b.Text) != "" {
						lastAssistant = b.Text
					}
				case "tool_use":
					cmd := b.Input.Command
					if b.ID != "" {
						if cmd != "" {
							cmdByID[b.ID] = cmd
						} else {
							cmdByID[b.ID] = b.Name
						}
					}
					if b.Name == "AskUserQuestion" {
						raw = append(raw, SessionEvent{Type: "asked", Ts: ts, Text: askText(b)})
					} else if b.Name == "Bash" && commitRe.MatchString(cmd) {
						raw = append(raw, SessionEvent{Type: "committed", Ts: ts, Text: commitSubject(cmd)})
					}
				}
			}
		case "user":
			var str string
			if json.Unmarshal(rec.Message.Content, &str) == nil {
				if firstUser == "" && strings.TrimSpace(str) != "" {
					firstUser = str
				}
				continue
			}
			var blocks []claudeBlock
			if json.Unmarshal(rec.Message.Content, &blocks) != nil {
				continue
			}
			for _, b := range blocks {
				if b.Type == "text" && firstUser == "" && strings.TrimSpace(b.Text) != "" {
					firstUser = b.Text
				}
				if b.Type == "tool_result" && b.IsError && b.ToolUseID != "" {
					cmd := cmdByID[b.ToolUseID]
					if cmd == "" {
						cmd = "a command"
					}
					raw = append(raw, SessionEvent{Type: "errored", Ts: ts, Text: "failed: " + clipText(cmd)})
				}
			}
		}
	}
	startedText := "started session"
	if firstUser != "" {
		startedText = clipText(firstUser)
	}
	finishedText := "finished"
	if lastAssistant != "" {
		finishedText = clipText(lastAssistant)
	}
	return assembleEvents(raw, firstTs, lastTs, startedText, finishedText)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/agentsessions/ -run TestExtractClaudeEvents -v`
Expected: PASS (both `TestExtractClaudeEvents` and `TestExtractClaudeEvents_errorMarksFailedWithFinished`).

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/agentsessions/` — Expected: PASS (existing tests still green).

---

### Task 3: Codex event extractor

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go` (add `extractCodexEvents` + structs + `codexShellCommand`/`codexOutputIsError`)
- Test: `pkg/agentsessions/events_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/agentsessions/events_test.go`:

```go
func TestExtractCodexEvents(t *testing.T) {
	lines := []string{
		`{"type":"session_meta","timestamp":"2026-07-10T09:00:00.000Z","payload":{"cwd":"/home/me/payments-api","git":{"branch":"feat/redis"}}}`,
		`{"type":"response_item","timestamp":"2026-07-10T09:00:03.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Migrate to redis"}]}}`,
		`{"type":"response_item","timestamp":"2026-07-10T09:00:10.000Z","payload":{"type":"function_call","name":"shell_command","call_id":"c1","arguments":"{\"command\":\"redis-cli ping\"}"}}`,
		`{"type":"response_item","timestamp":"2026-07-10T09:00:12.000Z","payload":{"type":"function_call_output","call_id":"c1","output":"Exit code: 1\nECONNREFUSED"}}`,
	}
	got := extractCodexEvents(lines)
	if got.Status != "failed" {
		t.Errorf("status = %q, want failed", got.Status)
	}
	if got.Events[0].Type != "started" || got.Events[0].Text != "Migrate to redis" {
		t.Errorf("first event = %+v", got.Events[0])
	}
	last := got.Events[len(got.Events)-1]
	if last.Type != "errored" || last.Text != "failed: redis-cli ping" {
		t.Errorf("last event = %+v", last)
	}
}

func TestExtractCodexEvents_subagentExcluded(t *testing.T) {
	lines := []string{
		`{"type":"session_meta","timestamp":"2026-07-10T09:00:00.000Z","payload":{"cwd":"/x","thread_source":"subagent"}}`,
		`{"type":"response_item","timestamp":"2026-07-10T09:00:03.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}`,
	}
	got := extractCodexEvents(lines)
	if len(got.Events) != 0 {
		t.Errorf("subagent rollout should yield no events, got %d", len(got.Events))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/agentsessions/ -run TestExtractCodexEvents -v`
Expected: FAIL — `undefined: extractCodexEvents`.

- [ ] **Step 3: Implement the extractor**

Add to `pkg/agentsessions/agentsessions.go`:

```go
type codexEventLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

type codexPayload struct {
	Type         string          `json:"type"`
	ThreadSource string          `json:"thread_source"`
	Role         string          `json:"role"`
	Name         string          `json:"name"`
	Arguments    string          `json:"arguments"`
	CallID       string          `json:"call_id"`
	Output       json.RawMessage `json:"output"`
	Content      []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func codexShellCommand(argsRaw string) string {
	if argsRaw == "" {
		return ""
	}
	var a struct {
		Command string `json:"command"`
	}
	if json.Unmarshal([]byte(argsRaw), &a) != nil {
		return ""
	}
	return a.Command
}

func codexOutputIsError(raw json.RawMessage) bool {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return false // ported TS only inspects string output
	}
	if m := exitCodeRe.FindStringSubmatch(s); m != nil {
		return m[1] != "0"
	}
	var p struct {
		Metadata struct {
			ExitCode *int `json:"exit_code"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(s), &p) == nil && p.Metadata.ExitCode != nil {
		return *p.Metadata.ExitCode != 0
	}
	return false
}

// extractCodexEvents ports frontend/app/view/agents/activityevents.ts:extractCodexEvents.
func extractCodexEvents(lines []string) sessionEvents {
	var raw []SessionEvent
	cmdByID := map[string]string{}
	var firstTs, lastTs int64
	var firstUser, lastAssistant string
	isSubagent := false
	for _, line := range lines {
		var rec codexEventLine
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if ts := parseTs(rec.Timestamp); ts > 0 {
			if firstTs == 0 {
				firstTs = ts
			}
			lastTs = ts
		}
		ts := parseTs(rec.Timestamp)
		var p codexPayload
		if len(rec.Payload) == 0 || json.Unmarshal(rec.Payload, &p) != nil {
			continue
		}
		if rec.Type == "session_meta" {
			if p.ThreadSource == "subagent" {
				isSubagent = true
			}
			continue
		}
		if rec.Type != "response_item" {
			continue
		}
		switch p.Type {
		case "message":
			for _, b := range p.Content {
				if p.Role == "assistant" && b.Type == "output_text" && strings.TrimSpace(b.Text) != "" {
					lastAssistant = b.Text
				}
				if p.Role == "user" && b.Type == "input_text" && firstUser == "" && strings.TrimSpace(b.Text) != "" &&
					!strings.HasPrefix(b.Text, "<environment_context") && !strings.HasPrefix(b.Text, "<skill>") {
					firstUser = b.Text
				}
			}
		case "function_call":
			cmd := codexShellCommand(p.Arguments)
			if p.CallID != "" {
				if cmd != "" {
					cmdByID[p.CallID] = cmd
				} else {
					cmdByID[p.CallID] = p.Name
				}
			}
			if p.Name == "shell_command" && commitRe.MatchString(cmd) {
				raw = append(raw, SessionEvent{Type: "committed", Ts: ts, Text: commitSubject(cmd)})
			}
		case "function_call_output", "custom_tool_call_output":
			if p.CallID != "" && codexOutputIsError(p.Output) {
				cmd := cmdByID[p.CallID]
				if cmd == "" {
					cmd = "a command"
				}
				raw = append(raw, SessionEvent{Type: "errored", Ts: ts, Text: "failed: " + clipText(cmd)})
			}
		}
	}
	if isSubagent {
		return sessionEvents{Status: "done"}
	}
	startedText := "started session"
	if firstUser != "" {
		startedText = clipText(firstUser)
	}
	finishedText := "finished"
	if lastAssistant != "" {
		finishedText = clipText(lastAssistant)
	}
	return assembleEvents(raw, firstTs, lastTs, startedText, finishedText)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/agentsessions/ -run TestExtractCodexEvents -v`
Expected: PASS (both codex tests).

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/agentsessions/` — Expected: PASS.

---

### Task 4: Wire extractors into the provider scan

**Files:**
- Modify: `pkg/agentsessions/agentsessions.go` (`provider` struct + `claudeProvider`/`codexProvider` + `scanProvider`)
- Test: `pkg/agentsessions/events_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/agentsessions/events_test.go`:

```go
func TestScanProvider_populatesEventsAndStatus(t *testing.T) {
	dir := t.TempDir()
	writeJSONL(t, dir, "sess-cov.jsonl",
		`{"type":"user","timestamp":"2026-07-10T12:00:00.000Z","cwd":"/home/me/payments-api","gitBranch":"fix/cov","message":{"content":"Cover the coupon branches"}}`,
		`{"type":"assistant","timestamp":"2026-07-10T12:00:05.000Z","message":{"model":"claude-opus-4-8","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"git commit -m \"cov\""}}]}}`,
	)
	got := scanProvider(claudeProvider(dir), 0, 10)
	if len(got) != 1 {
		t.Fatalf("want 1 session, got %d", len(got))
	}
	s := got[0]
	if s.TranscriptPath == "" {
		t.Error("TranscriptPath should be set")
	}
	if s.Status != "done" {
		t.Errorf("status = %q, want done", s.Status)
	}
	if len(s.Events) == 0 {
		t.Fatal("events should be populated")
	}
	if s.Events[0].Type != "started" {
		t.Errorf("first event = %q, want started", s.Events[0].Type)
	}
	if s.StartedTs != 1783166400000 {
		t.Errorf("startedTs = %d", s.StartedTs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/agentsessions/ -run TestScanProvider_populatesEventsAndStatus -v`
Expected: FAIL — `s.TranscriptPath`/`s.Status`/`s.Events` populated as zero values (empty `TranscriptPath`, `Status == ""`), so assertions fail.

- [ ] **Step 3: Add the `events` seam + populate in scanProvider**

In `pkg/agentsessions/agentsessions.go`, add a field to the `provider` struct (after `resumeCmd`):

```go
	events    func(lines []string) sessionEvents
```

Set it in both providers. In `claudeProvider`:

```go
		resumeCmd: func(s *SessionInfo) string { return "claude --resume " + s.ID },
		events:    extractClaudeEvents,
```

In `codexProvider`:

```go
		resumeCmd: func(s *SessionInfo) string { return "codex resume " + s.ID },
		events:    extractCodexEvents,
```

Then replace the body of the `for _, c := range cands` loop in `scanProvider` (currently reads lines inside `p.extract(...)`) so lines are read once and passed to both:

```go
	for _, c := range cands {
		if limit > 0 && len(out) >= limit {
			break
		}
		lines := readLines(c.path)
		s := p.extract(c.stem, lines)
		if s == nil {
			continue
		}
		s.Runtime = p.runtime
		s.LastActiveTs = c.mtime.UnixMilli()
		s.ResumeCommand = p.resumeCmd(s)
		s.TranscriptPath = c.path
		se := p.events(lines)
		s.Events = se.Events
		s.Status = se.Status
		s.StartedTs = se.StartedTs
		s.DurationMs = se.DurationMs
		out = append(out, *s)
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/agentsessions/ -run TestScanProvider_populatesEventsAndStatus -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `go test ./pkg/agentsessions/` — Expected: PASS, including the pre-existing `TestScanRoot_readsOnlyNewestUpToLimit` (still exactly one `readLines` call per processed candidate — the monkey-patch counter is unaffected).

---

## Phase 2 — Transport: wire types, RPC, codegen, handler

### Task 5: Add `GetSessionsActivity` command end-to-end

No manual command registration exists — dispatch reflects over `WshRpcInterface` and the wire name is `strings.ToLower(method − "Command")`. Editing the interface + implementing the handler + `task generate` is the whole job.

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method + wire structs)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (handler)
- Generated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add wire types + interface method**

In `pkg/wshrpc/wshrpctypes.go`, add the interface method next to `GetRecentSessionsCommand` (line 102):

```go
	GetSessionsActivityCommand(ctx context.Context, data CommandGetSessionsActivityData) (*CommandGetSessionsActivityRtnData, error)
```

Add the wire structs next to `CommandGetRecentSessionsRtnData` (after line 876). `SessionActivity` lists all fields explicitly (no struct embedding — keeps the generated TS type flat and predictable):

```go
type SessionEvent struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
	Text string `json:"text"`
}

type SessionActivity struct {
	ID             string         `json:"id"`
	Runtime        string         `json:"runtime"`
	ProjectPath    string         `json:"projectpath"`
	ProjectName    string         `json:"projectname"`
	Branch         string         `json:"branch"`
	Task           string         `json:"task"`
	Model          string         `json:"model"`
	TokensTotal    int            `json:"tokenstotal"`
	LastActiveTs   int64          `json:"lastactivets"`
	ResumeCommand  string         `json:"resumecommand"`
	TranscriptPath string         `json:"transcriptpath"`
	Status         string         `json:"status"`
	StartedTs      int64          `json:"startedts"`
	DurationMs     int64          `json:"durationms"`
	Events         []SessionEvent `json:"events"`
}

type CommandGetSessionsActivityData struct {
	WindowDays int `json:"windowdays,omitempty"`
	Limit      int `json:"limit,omitempty"`
}

type CommandGetSessionsActivityRtnData struct {
	Sessions []SessionActivity `json:"sessions"`
}
```

- [ ] **Step 2: Implement the handler**

In `pkg/wshrpc/wshserver/wshserver.go`, add next to `GetRecentSessionsCommand` (after line 1543):

```go
func (ws *WshServer) GetSessionsActivityCommand(ctx context.Context, data wshrpc.CommandGetSessionsActivityData) (*wshrpc.CommandGetSessionsActivityRtnData, error) {
	sessions, err := agentsessions.ScanSessions(data.WindowDays, data.Limit)
	if err != nil {
		return nil, fmt.Errorf("scanning sessions: %w", err)
	}
	out := make([]wshrpc.SessionActivity, len(sessions))
	for i, s := range sessions {
		evs := make([]wshrpc.SessionEvent, len(s.Events))
		for j, e := range s.Events {
			evs[j] = wshrpc.SessionEvent{Type: e.Type, Ts: e.Ts, Text: e.Text}
		}
		out[i] = wshrpc.SessionActivity{
			ID: s.ID, Runtime: s.Runtime, ProjectPath: s.ProjectPath, ProjectName: s.ProjectName,
			Branch: s.Branch, Task: s.Task, Model: s.Model, TokensTotal: s.TokensTotal,
			LastActiveTs: s.LastActiveTs, ResumeCommand: s.ResumeCommand, TranscriptPath: s.TranscriptPath,
			Status: s.Status, StartedTs: s.StartedTs, DurationMs: s.DurationMs, Events: evs,
		}
	}
	return &wshrpc.CommandGetSessionsActivityRtnData{Sessions: out}, nil
}
```

- [ ] **Step 3: Verify Go compiles, then regenerate bindings**

Run: `go build ./...`
Expected: exit 0.

Run: `task generate`
Expected: regenerates `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`. Exit 0.

- [ ] **Step 4: Verify the generated artifacts exist**

Run: `git diff --stat frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts pkg/wshrpc/wshclient/wshclient.go`
Expected: all three show insertions.

Grep the generated FE client + type (use the Grep tool or): `grep -n "GetSessionsActivityCommand" frontend/app/store/wshclientapi.ts` and `grep -n "type SessionActivity" frontend/types/gotypes.d.ts`
Expected: `GetSessionsActivityCommand(...)` present in `wshclientapi.ts`; `type SessionActivity = { ... transcriptpath: string; status: string; startedts: number; durationms: number; events: SessionEvent[]; }` and `type SessionEvent = { type: string; ts: number; text: string; }` present in `gotypes.d.ts`.

- [ ] **Step 5: Checkpoint**

Run: `task build:backend`
Expected: exit 0 (produces `dist/bin/wavesrv` with the new command; required for the live RPC to answer during CDP verification).

---

## Phase 3 — Frontend store

### Task 6: Rewrite `sessionsarchivestore.ts` (loader + pure helpers)

**Files:**
- Modify (rewrite): `frontend/app/view/agents/sessionsarchivestore.ts`
- Modify (rewrite): `frontend/app/view/agents/sessionsarchivestore.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `frontend/app/view/agents/sessionsarchivestore.test.ts` with:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { filterByStatus, groupByRecency, mergedFeed, overlayLive, totalEvents, type LiveSession } from "./sessionsarchivestore";

const ev = (type: string, ts: number, text = ""): SessionEvent => ({ type, ts, text });

const mk = (over: Partial<SessionActivity> = {}): SessionActivity => ({
    id: "x",
    runtime: "claude",
    projectpath: "/p",
    projectname: "proj",
    branch: "main",
    task: "do the thing",
    model: "claude",
    tokenstotal: 0,
    lastactivets: 0,
    resumecommand: "claude --resume x",
    transcriptpath: "/home/me/.claude/projects/p/x.jsonl",
    status: "done",
    startedts: 0,
    durationms: 0,
    events: [ev("started", 1), ev("finished", 2)],
    ...over,
});

const mkAgent = (over: Partial<AgentVM> = {}): AgentVM =>
    ({ id: "t1", state: "working", transcriptPath: "/home/me/.claude/projects/p/x.jsonl", ...over }) as AgentVM;

describe("overlayLive", () => {
    it("flags a session live when its transcript path matches a roster agent, stripping finished", () => {
        const [s] = overlayLive([mk()], [mkAgent()], 1000);
        expect(s.live).toBe(true);
        expect(s.liveId).toBe("t1");
        expect(s.events.some((e) => e.type === "finished")).toBe(false);
    });
    it("marks needsAttention for a live asking agent", () => {
        const [s] = overlayLive([mk()], [mkAgent({ state: "asking" })], 1000);
        expect(s.needsAttention).toBe(true);
    });
    it("marks needsAttention for an ended failed session", () => {
        const [s] = overlayLive([mk({ status: "failed" })], [], 1000);
        expect(s.live).toBe(false);
        expect(s.needsAttention).toBe(true);
    });
});

describe("filterByStatus", () => {
    const list = overlayLive(
        [
            mk({ id: "a", status: "done", transcriptpath: "/other.jsonl" }),
            mk({ id: "b", status: "failed", transcriptpath: "/nope.jsonl" }),
            mk({ id: "c" }), // live (matches mkAgent path)
        ],
        [mkAgent()],
        1000
    );
    it("live keeps only live sessions", () => {
        expect(filterByStatus(list, "live").map((s) => s.id)).toEqual(["c"]);
    });
    it("done excludes live and non-done", () => {
        expect(filterByStatus(list, "done").map((s) => s.id)).toEqual(["a"]);
    });
    it("needs keeps failed/waiting/asking", () => {
        expect(filterByStatus(list, "needs").map((s) => s.id)).toEqual(["b"]);
    });
});

describe("groupByRecency", () => {
    it("splits into live / today / earlier and drops empties", () => {
        const now = new Date("2026-07-10T12:00:00Z").getTime();
        const startToday = new Date("2026-07-10T01:00:00Z").getTime();
        const yesterday = new Date("2026-07-09T12:00:00Z").getTime();
        const list = overlayLive(
            [
                mk({ id: "live", transcriptpath: "/home/me/.claude/projects/p/x.jsonl" }),
                mk({ id: "today", lastactivets: startToday, transcriptpath: "/t.jsonl" }),
                mk({ id: "old", lastactivets: yesterday, transcriptpath: "/o.jsonl" }),
            ],
            [mkAgent()],
            now
        );
        const groups = groupByRecency(list, now);
        expect(groups.map((g) => g.key)).toEqual(["live", "today", "earlier"]);
        expect(groups[0].items.map((s) => s.id)).toEqual(["live"]);
    });
});

describe("mergedFeed + totalEvents", () => {
    it("interleaves events newest-first with session context", () => {
        const list = overlayLive(
            [mk({ id: "a", task: "A task", events: [ev("started", 10, "a-start")] }, ), mk({ id: "b", task: "B task", transcriptpath: "/b.jsonl", events: [ev("committed", 20, "b-commit")] })],
            [],
            1000
        );
        const feed = mergedFeed(list);
        expect(feed[0].ts).toBe(20);
        expect(feed[0].sessionTitle).toBe("B task");
        expect(totalEvents(list)).toBe(2);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts`
Expected: FAIL — the new exports (`overlayLive`, `filterByStatus`, `groupByRecency`, `mergedFeed`, `totalEvents`, `LiveSession`) don't exist yet.

- [ ] **Step 3: Rewrite the store**

Replace the entire contents of `frontend/app/view/agents/sessionsarchivestore.ts` with:

```ts
// frontend/app/view/agents/sessionsarchivestore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Sessions surface store: the loaded SessionActivity[] from GetSessionsActivity (one Go parser feeds
// summary + per-session lifecycle events), a pure live-roster overlay, and pure grouping/filter/feed
// helpers. Replaces the retired Activity FE extraction stack (activitystore/activityevents/discovery).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import type { AgentVM } from "./agentsviewmodel";

const WINDOW_DAYS = 30;
const LIMIT = 100;

// null = not loaded yet; [] = loaded-empty.
export const sessionsArchiveAtom = atom<SessionActivity[] | null>(null) as PrimitiveAtom<SessionActivity[] | null>;

let loading = false;

export async function loadSessionsArchive(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const rtn = await RpcApi.GetSessionsActivityCommand(TabRpcClient, { windowdays: WINDOW_DAYS, limit: LIMIT });
        globalStore.set(sessionsArchiveAtom, rtn.sessions ?? []);
    } catch {
        globalStore.set(sessionsArchiveAtom, []); // scan failure should not break the surface
    } finally {
        loading = false;
    }
}

export type SessionStatusFilter = "all" | "live" | "done" | "needs";

export interface LiveSession extends SessionActivity {
    live: boolean;
    liveId?: string; // roster tabId when live (jump target)
    needsAttention: boolean;
}

function norm(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
}

// Overlay the live roster onto the scanned sessions: match on transcript path, strip the synthetic
// "finished" event for live sessions, and compute needsAttention (live+asking, or ended failed/waiting).
export function overlayLive(base: SessionActivity[], roster: AgentVM[], _now: number): LiveSession[] {
    const liveByPath = new Map<string, { id: string; asking: boolean }>();
    for (const a of roster) {
        if (a.transcriptPath) {
            liveByPath.set(norm(a.transcriptPath), { id: a.id, asking: a.state === "asking" });
        }
    }
    return base.map((s) => {
        const hit = s.transcriptpath ? liveByPath.get(norm(s.transcriptpath)) : undefined;
        const live = hit != null;
        const events = live ? s.events.filter((e) => e.type !== "finished") : s.events;
        const needsAttention = live ? !!hit?.asking : s.status === "waiting" || s.status === "failed";
        return { ...s, events, live, liveId: hit?.id, needsAttention };
    });
}

export function filterByStatus(list: LiveSession[], f: SessionStatusFilter): LiveSession[] {
    if (f === "all") {
        return list;
    }
    if (f === "live") {
        return list.filter((s) => s.live);
    }
    if (f === "done") {
        return list.filter((s) => !s.live && s.status === "done");
    }
    return list.filter((s) => s.needsAttention); // "needs"
}

export interface RecencyGroup {
    key: "live" | "today" | "earlier";
    label: string;
    items: LiveSession[];
}

export function groupByRecency(list: LiveSession[], now: number): RecencyGroup[] {
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const live: LiveSession[] = [];
    const today: LiveSession[] = [];
    const earlier: LiveSession[] = [];
    for (const s of list) {
        if (s.live) {
            live.push(s);
        } else if (s.lastactivets >= startOfToday) {
            today.push(s);
        } else {
            earlier.push(s);
        }
    }
    const desc = (a: LiveSession, b: LiveSession) => b.lastactivets - a.lastactivets;
    live.sort(desc);
    today.sort(desc);
    earlier.sort(desc);
    return (
        [
            { key: "live", label: "Live now", items: live },
            { key: "today", label: "Today", items: today },
            { key: "earlier", label: "Earlier", items: earlier },
        ] as RecencyGroup[]
    ).filter((g) => g.items.length > 0);
}

export interface MergedItem {
    key: string;
    type: string;
    ts: number;
    text: string;
    sessionKey: string; // `${runtime}:${id}` — selection target
    sessionTitle: string;
    project: string;
    runtime: string;
}

export function mergedFeed(list: LiveSession[]): MergedItem[] {
    const items: MergedItem[] = [];
    for (const s of list) {
        const sessionKey = `${s.runtime}:${s.id}`;
        for (let i = 0; i < s.events.length; i++) {
            const e = s.events[i];
            items.push({
                key: `${sessionKey}#${i}`,
                type: e.type,
                ts: e.ts,
                text: e.text,
                sessionKey,
                sessionTitle: s.task || "(untitled session)",
                project: s.projectname,
                runtime: s.runtime,
            });
        }
    }
    items.sort((a, b) => b.ts - a.ts);
    return items;
}

export function totalEvents(list: LiveSession[]): number {
    return list.reduce((n, s) => n + s.events.length, 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts`
Expected: PASS. (Typecheck runs after the surface is wired in Task 8 — `agents.tsx` still references the old atoms until then, so a repo-wide `tsc` here would show expected transient errors.)

---

### Task 7: Swap the model's Activity atoms for Sessions atoms

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx` (line 21 import; lines 89-91 atoms)

- [ ] **Step 1: Remove the ActivityType import**

In `frontend/app/view/agents/agents.tsx`, delete line 21:

```ts
import type { ActivityType } from "./activityevents";
```

Add an import for the new filter type (place it near the other `./` imports, e.g. after the `devmock` import at line 22):

```ts
import type { SessionStatusFilter } from "./sessionsarchivestore";
```

- [ ] **Step 2: Replace the two activity atoms**

In `agents.tsx`, replace lines 88-91 (the two activity atoms and their comments):

```ts
    // Activity surface: selected type filter chip (spec §4.1). Default "all".
    activityFilterAtom = atom<ActivityType | "all">("all");
    // Activity surface: selected project scope ("all" | <project>), independent of the type chip.
    activityProjectFilterAtom = atom<string>("all");
```

with:

```ts
    // Sessions surface: status filter chip (All / Live / Done / Needs attention). Default "all".
    sessionsStatusFilterAtom = atom<SessionStatusFilter>("all");
    // Sessions surface: selected left-list entry. "all" = merged feed; else "${runtime}:${id}".
    sessionsSelAtom = atom<string>("all");
```

- [ ] **Step 3: Verify no other references to the removed atoms remain in agents.tsx**

Run (Grep tool): search `activityFilterAtom|activityProjectFilterAtom|ActivityType` in `frontend/app/view/agents/agents.tsx`.
Expected: no matches.

- [ ] **Step 4: Checkpoint**

No standalone typecheck yet (the still-present `activitysurface.tsx` imports these atoms; it's deleted in Task 9). Proceed to Task 8.

---

## Phase 4 — Frontend surface

### Task 8: Rewrite `SessionsSurface` as master-detail

No render-test harness exists (CLAUDE.md); this task is verified by typecheck + CDP, not unit tests. The pure logic it depends on is already tested in Task 6.

**Files:**
- Modify (rewrite): `frontend/app/view/agents/sessionssurface.tsx`

- [ ] **Step 1: Rewrite the surface**

Replace the entire contents of `frontend/app/view/agents/sessionssurface.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Merged Sessions surface (absorbs the old Activity tab). Master-detail: a recency-grouped session
// list with a pinned "All activity" entry, a merged cross-session feed on the right, and a per-session
// detail that reuses NarrationTimeline. Live agents are overlaid (matched by transcript path) so the
// primary action is Jump (live) or Resume (ended). @theme tokens only — no hardcoded colors.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry } from "./agentsviewmodel";
import { formatAge, formatTokens } from "./agentsviewmodel";
import { codexProjection } from "./codextranscriptprojection"; // named import resolved in Step 2 note
import type { Runtime } from "./launch";
import { NarrationTimeline } from "./narrationtimeline";
import { runtimeMeta } from "./runtimemeta";
import {
    filterByStatus,
    groupByRecency,
    loadSessionsArchive,
    mergedFeed,
    overlayLive,
    sessionsArchiveAtom,
    totalEvents,
    type LiveSession,
    type SessionStatusFilter,
} from "./sessionsarchivestore";
import { projectTranscript } from "./transcriptprojection";

const EVENT_COLOR: Record<string, string> = {
    started: "var(--color-success)",
    asked: "var(--color-asking)",
    committed: "var(--color-accent)",
    errored: "var(--color-error)",
    finished: "var(--color-muted)",
};
function eventColor(t: string): string {
    return EVENT_COLOR[t] ?? "var(--color-muted)";
}

const STATUS_META: Record<string, { label: string; color: string }> = {
    running: { label: "Running", color: "var(--color-accent)" },
    done: { label: "Done", color: "var(--color-success)" },
    failed: { label: "Failed", color: "var(--color-error)" },
    waiting: { label: "Waiting", color: "var(--color-asking)" },
};
function statusOf(s: LiveSession): { label: string; color: string } {
    return s.live ? STATUS_META.running : STATUS_META[s.status] ?? STATUS_META.done;
}

const FILTERS: { key: SessionStatusFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "live", label: "Live" },
    { key: "done", label: "Done" },
    { key: "needs", label: "Needs attention" },
];

export function SessionsSurface({ model }: { model: AgentsViewModel }) {
    const base = useAtomValue(sessionsArchiveAtom);
    const roster = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);
    const [sel, setSel] = useAtom(model.sessionsSelAtom);
    const [filter, setFilter] = useAtom(model.sessionsStatusFilterAtom);

    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);

    const live = base == null ? [] : overlayLive(base, roster, now);
    const shown = filterByStatus(live, filter);
    const groups = groupByRecency(shown, now);
    const liveCount = live.filter((s) => s.live).length;
    // detail resolves against the full set so a filter chip never blanks the open session.
    const selected = sel === "all" ? undefined : live.find((s) => `${s.runtime}:${s.id}` === sel);

    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            {/* header */}
            <div className="flex-none border-b border-edge-faint px-[26px] pb-[15px] pt-5">
                <div className="mb-1 flex items-center gap-[11px]">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Sessions</h1>
                    {liveCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 rounded-[6px] border border-accent bg-accentbg px-2 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-soft">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            {liveCount} live
                        </span>
                    ) : null}
                    <div className="flex-1" />
                    <div className="flex items-center gap-1 rounded-[8px] border border-border bg-surface p-0.5">
                        {FILTERS.map((f) => (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => setFilter(f.key)}
                                className={cn(
                                    "cursor-pointer rounded-[6px] px-[11px] py-[5px] text-[11px] font-semibold",
                                    filter === f.key ? "bg-accentbg text-primary" : "text-ink-mid hover:text-primary"
                                )}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                </div>
                <p className="text-[13px] text-secondary">
                    Every agent session and its activity — one timeline per run, or the full feed across all of them.
                </p>
            </div>

            {/* body: list + detail */}
            <div className="flex min-h-0 flex-1">
                {/* LEFT · session list */}
                <div className="w-[392px] flex-none overflow-y-auto border-r border-edge-faint p-3 pb-10">
                    <button
                        type="button"
                        onClick={() => setSel("all")}
                        className={cn(
                            "mb-3.5 flex w-full items-center gap-[11px] rounded-[11px] border px-[13px] py-[11px] text-left",
                            sel === "all" ? "border-accent bg-surface-hover" : "border-border bg-surface hover:border-edge-strong"
                        )}
                    >
                        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] border border-accent bg-accentbg text-accent-soft">≡</span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold text-primary">All activity</span>
                            <span className="block font-mono text-[11px] text-muted">Merged feed · every session</span>
                        </span>
                        <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-[11px] text-secondary">
                            {totalEvents(live)}
                        </span>
                    </button>

                    {base == null ? (
                        <div className="mt-8 text-center text-[13px] text-muted">Loading…</div>
                    ) : groups.length === 0 ? (
                        <div className="mt-8 text-center text-[13px] text-muted">No sessions found.</div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.key} className="mb-3.5">
                                <div className="flex items-center gap-2.5 px-1 pb-2 pt-0.5">
                                    <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.13em] text-accent-soft">
                                        {g.label}
                                    </span>
                                    <div className="h-px flex-1 bg-edge-faint" />
                                    <span className="font-mono text-[10px] text-muted">{g.items.length}</span>
                                </div>
                                <div className="flex flex-col gap-[7px]">
                                    {g.items.map((s) => {
                                        const st = statusOf(s);
                                        const active = sel === `${s.runtime}:${s.id}`;
                                        return (
                                            <button
                                                key={`${s.runtime}:${s.id}`}
                                                type="button"
                                                onClick={() => setSel(`${s.runtime}:${s.id}`)}
                                                className={cn(
                                                    "flex flex-col gap-[7px] rounded-[11px] border px-[13px] py-[11px] text-left",
                                                    active ? "border-accent bg-surface-hover" : "border-border bg-surface hover:border-edge-strong"
                                                )}
                                            >
                                                <span className="flex items-center gap-2.5">
                                                    <span className="h-2 w-2 flex-none rounded-full" style={{ backgroundColor: st.color }} />
                                                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">
                                                        {s.task || "(untitled session)"}
                                                    </span>
                                                    <span
                                                        className="flex-none rounded-[4px] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.06em]"
                                                        style={{ color: st.color, backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}
                                                    >
                                                        {st.label}
                                                    </span>
                                                </span>
                                                <span className="flex items-center gap-2 font-mono text-[10px] text-muted">
                                                    <span className="text-secondary">{s.projectname}</span>
                                                    <span className="text-edge-strong">·</span>
                                                    <span>{s.branch || "—"}</span>
                                                    <span className="flex-1" />
                                                    <span>{runtimeMeta(s.runtime).glyph}</span>
                                                    {s.tokenstotal > 0 ? (
                                                        <>
                                                            <span className="text-edge-strong">·</span>
                                                            <span>{formatTokens(s.tokenstotal)} tok</span>
                                                        </>
                                                    ) : null}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* RIGHT · detail */}
                <div className="min-w-0 flex-1 overflow-y-auto px-7 pb-12 pt-5">
                    {selected ? (
                        <SessionDetail model={model} session={selected} now={now} />
                    ) : (
                        <MergedFeed model={model} list={live} now={now} />
                    )}
                </div>
            </div>
        </div>
    );
}

function MergedFeed({ model, list, now }: { model: AgentsViewModel; list: LiveSession[]; now: number }) {
    const feed = mergedFeed(list);
    return (
        <>
            <div className="mb-3.5 flex items-center gap-2.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.13em] text-muted">All activity</span>
                <div className="h-px flex-1 bg-edge-faint" />
                <span className="font-mono text-[10px] text-muted">{feed.length} events</span>
            </div>
            {feed.length === 0 ? (
                <div className="mt-8 text-center text-[13px] text-muted">No recent activity.</div>
            ) : (
                <div className="flex flex-col">
                    {feed.map((e) => (
                        <button
                            key={e.key}
                            type="button"
                            onClick={() => globalStore.set(model.sessionsSelAtom, e.sessionKey)}
                            className="flex gap-4 border-b border-edge-faint px-1 py-3 text-left hover:bg-surface"
                        >
                            <span className="mt-1 h-[9px] w-[9px] flex-none rounded-full" style={{ backgroundColor: eventColor(e.type) }} />
                            <span className="min-w-0 flex-1">
                                <span className="block text-[13px] leading-[1.5] text-secondary">
                                    <span className="font-mono text-[12px] font-semibold text-accent-soft">{e.sessionTitle}</span> {e.text}
                                </span>
                                <span className="mt-1 flex items-center gap-2">
                                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: eventColor(e.type) }}>
                                        {e.type}
                                    </span>
                                    <span className="font-mono text-[10.5px] text-muted">{e.project}</span>
                                    <span className="font-mono text-[10.5px] text-muted">· {now - e.ts < 60_000 ? "now" : `${formatAge(now - e.ts)} ago`}</span>
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </>
    );
}

function SessionDetail({ model, session, now }: { model: AgentsViewModel; session: LiveSession; now: number }) {
    const [entries, setEntries] = useState<AgentEntry[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        if (!session.transcriptpath) {
            setEntries([]);
            return;
        }
        fireAndForget(async () => {
            try {
                const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: session.transcriptpath, maxlines: 2000 });
                const lines = rtn.lines ?? [];
                const projected = session.runtime === "codex" ? codexProjection(lines) : projectTranscript(lines);
                if (!cancelled) {
                    setEntries(projected);
                }
            } catch {
                if (!cancelled) {
                    setEntries([]);
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [session.transcriptpath, session.runtime]);

    const st = statusOf(session);
    const rt = runtimeMeta(session.runtime);

    const act = () => {
        if (session.live && session.liveId) {
            globalStore.set(model.focusIdAtom, session.liveId);
            globalStore.set(model.terminalTargetAtom, undefined);
            globalStore.set(model.surfaceAtom, "agent");
            return;
        }
        if (session.resumecommand) {
            fireAndForget(() =>
                launchAgent(model, {
                    runtime: session.runtime as Runtime,
                    startupCommand: session.resumecommand,
                    task: "",
                    projectPath: session.projectpath,
                    projectName: session.projectname || "agent",
                })
            );
        }
    };

    const meta: { k: string; v: string }[] = [
        { k: "repo", v: session.projectname || "—" },
        { k: "branch", v: session.branch || "—" },
        { k: "duration", v: session.durationms > 0 ? formatAge(session.durationms) : "—" },
        { k: "tokens", v: session.tokenstotal > 0 ? `${formatTokens(session.tokenstotal)} tok` : "—" },
    ];

    return (
        <>
            <div className="mb-5 flex items-start gap-3.5 border-b border-edge-faint pb-4">
                <span className={cn("flex h-[42px] w-[42px] flex-none items-center justify-center rounded-[11px] border font-mono text-[15px]", rt.text, rt.softBg, rt.line)}>
                    {rt.glyph}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex items-center gap-2.5">
                        <h2 className="text-[19px] font-bold tracking-[-0.01em] text-primary">{session.task || "(untitled session)"}</h2>
                        <span className="rounded-[5px] px-1.5 py-[3px] font-mono text-[9px] font-bold uppercase tracking-[0.06em]" style={{ color: st.color, backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}>
                            {st.label}
                        </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-muted">
                        {meta.map((m) => (
                            <span key={m.k}>
                                <span className="text-edge-strong">{m.k} </span>
                                <span className="text-secondary">{m.v}</span>
                            </span>
                        ))}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={act}
                    disabled={!session.live && !session.resumecommand}
                    className={cn(
                        "flex-none cursor-pointer rounded-[8px] px-[13px] py-[7px] text-[12px] font-semibold",
                        session.live
                            ? "bg-accent text-background hover:opacity-90"
                            : "border border-border text-ink-mid hover:border-accent hover:text-accent-soft disabled:cursor-default disabled:opacity-40"
                    )}
                >
                    {session.live ? "Jump →" : "Resume →"}
                </button>
            </div>

            <div className="mb-3.5 flex items-center gap-2.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.13em] text-muted">Activity</span>
                <div className="h-px flex-1 bg-edge-faint" />
                <span className="font-mono text-[10px] text-muted">{entries?.length ?? 0} events</span>
            </div>

            {entries == null ? (
                <div className="text-[13px] text-muted">Loading transcript…</div>
            ) : entries.length === 0 ? (
                <div className="text-[13px] text-muted">No activity to show.</div>
            ) : (
                <NarrationTimeline entries={entries} active={session.live} />
            )}
        </>
    );
}
```

- [ ] **Step 2: Fix the codex projection import**

The file above imports `codexProjection` as a placeholder alias. The real export is `projectCodexTranscript` (codextranscriptprojection.ts:103). Change the import line:

```ts
import { codexProjection } from "./codextranscriptprojection"; // named import resolved in Step 2 note
```

to:

```ts
import { projectCodexTranscript } from "./codextranscriptprojection";
```

and change the one use site in `SessionDetail` from `codexProjection(lines)` to `projectCodexTranscript(lines)`.

- [ ] **Step 3: Confirm token utilities exist**

The JSX uses these Tailwind utilities: `bg-background`, `bg-surface`, `bg-surface-hover`, `bg-accent`, `bg-accentbg`, `text-primary`, `text-secondary`, `text-muted`, `text-ink-mid`, `text-accent-soft`, `text-background`, `border-border`, `border-edge-faint`, `border-edge-strong`, `border-accent`. All are used by the current `activitysurface.tsx` / `sessionssurface.tsx` (see `text-accent-soft`, `bg-accentbg`, `border-edge-faint`, `border-edge-strong` in `activitysurface.tsx`), so they resolve. If a class is missing at runtime it renders as no-op (Tailwind v4 emits nothing for unknown utilities) — verify visually in Step 5. Do NOT introduce raw hex.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (This is the first full typecheck since Task 6; it also confirms `agents.tsx` Task 7 edits and the new store all line up. `SessionActivity`/`SessionEvent` are global generated types — no import needed.)

- [ ] **Step 5: Checkpoint (deferred to Task 9 CDP)**

The surface isn't reachable until the Activity retirement (Task 9) leaves `sessions` wired in `cockpitshell`. `sessions` already routes to `SessionsSurface`, so it renders now — but full CDP verification (list, feed, Jump/Resume, chips) happens after Task 9 when the rail no longer shows Activity. Proceed to Task 9.

---

## Phase 5 — Retire the Activity surface

### Task 9: Delete Activity files and rewire consumers

**Files:**
- Delete: `frontend/app/view/agents/activitysurface.tsx`, `activitystore.ts`, `activityevents.ts`, `activitydiscovery.ts`, `activitystore.test.ts`, `activityevents.test.ts`, `activityloader.test.ts`
- Modify: `frontend/app/view/agents/cockpitshell.tsx`, `navrail.tsx`, `agents.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/store.test.ts`, `frontend/app/view/agents/cockpitprefsstore.ts`

- [ ] **Step 1: Delete the Activity source + test files**

Run:

```bash
git rm frontend/app/view/agents/activitysurface.tsx \
       frontend/app/view/agents/activitystore.ts \
       frontend/app/view/agents/activityevents.ts \
       frontend/app/view/agents/activitydiscovery.ts \
       frontend/app/view/agents/activitystore.test.ts \
       frontend/app/view/agents/activityevents.test.ts \
       frontend/app/view/agents/activityloader.test.ts
```

Expected: 7 files removed. (Do NOT delete `recentactivity.ts` / `recentactivity.test.ts` — that's the right-rail "Recent activity" peek, unrelated to the Activity surface.)

- [ ] **Step 2: Remove the `activity` branch + import from cockpitshell**

In `frontend/app/view/agents/cockpitshell.tsx`, delete the import (line 9):

```ts
import { ActivitySurface } from "./activitysurface";
```

and delete the branch (lines 66-67):

```tsx
                        ) : surface === "activity" ? (
                            <ActivitySurface model={model} />
```

- [ ] **Step 3: Remove `activity` from the SurfaceKey union + SURFACE_ORDER**

In `frontend/app/view/agents/agents.tsx`, delete `| "activity"` from the `SurfaceKey` union (line 28) and the `"activity",` entry from `SURFACE_ORDER` (line 40). The resulting order is `cockpit, agent, channels, sessions, files, memory, usage` (Ctrl+1..7; Ctrl+8 now unused since the list is 7 long — `slice(0,8)` simply yields 7 chords).

- [ ] **Step 4: Remove Activity from the NavRail**

In `frontend/app/view/agents/navrail.tsx`: remove `Activity,` from the lucide import (line 7); remove `activity: <Activity {...iconProps} />,` from `ICON` (line 26); remove `{ key: "activity", label: "Activity" },` from `ITEMS` (line 38).

- [ ] **Step 5: Remove the Activity g-leader target**

In `frontend/app/store/keybindings/bindings.ts`, delete from `GO_TARGETS` (line 18):

```ts
    { letter: "v", surface: "activity", label: "Activity" },
```

- [ ] **Step 6: Update the keybindings test fixture**

In `frontend/app/store/keybindings/store.test.ts`, delete `"activity",` from the `SURFACES` array (line 18).

- [ ] **Step 7: Add the startup-pref migration**

In `frontend/app/view/agents/cockpitprefsstore.ts`, add after the `startupSurfaceAtom` declaration (line 11):

```ts
// A persisted "activity" (the retired surface) coerces to "sessions" — its successor. Callers that seed
// surfaceAtom from the stored value must route through this so a stale key never renders a blank surface.
export function coerceStartupSurface(k: SurfaceKey | "activity"): SurfaceKey {
    return (k as string) === "activity" ? "sessions" : (k as SurfaceKey);
}
```

In `frontend/app/cockpit/cockpit-root.tsx`, change the seed line (line 57):

```ts
        globalStore.set(model.surfaceAtom, globalStore.get(startupSurfaceAtom));
```

to:

```ts
        globalStore.set(model.surfaceAtom, coerceStartupSurface(globalStore.get(startupSurfaceAtom)));
```

and add `coerceStartupSurface` to the existing `startupSurfaceAtom` import from `cockpitprefsstore` in that file (find the line importing `startupSurfaceAtom` and add `coerceStartupSurface`).

- [ ] **Step 8: Typecheck + full test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (no dangling references to the deleted modules or removed atoms).

Run: `npx vitest run frontend/app/view/agents/ frontend/app/store/keybindings/`
Expected: PASS. The retired Activity tests are gone; `store.test.ts` `assertNoConflicts` passes with the `g v` binding removed and 7 surface chords.

- [ ] **Step 9: Checkpoint — grep for stragglers**

Run (Grep tool): search `activitysurface|activitystore|activityevents|activitydiscovery|activityFilterAtom|activityProjectFilterAtom|ActivitySurface|"activity"` across `frontend/`.
Expected: no matches (except possibly `recentactivity.ts` which contains the substring "activity" in unrelated identifiers — that's fine).

---

## Phase 6 — Live verification

### Task 10: Run the dev app and verify end-to-end via CDP

**Files:** none (verification only)

- [ ] **Step 1: Build backend so the new RPC is live**

Run: `task build:backend`
Expected: exit 0.

- [ ] **Step 2: Start the dev app**

Run (background, per the dev-stdin gotcha): `tail -f /dev/null | task dev`
Wait for the Vite server on `:5174` and the WebView2 window. (Do NOT `Page.reload` over CDP — it breaks Tauri boot.)

- [ ] **Step 3: Screenshot the Sessions surface**

Navigate to Sessions (click the rail item, or `Ctrl+4` per the new order, or `g s`). Run: `node scripts/cdp-shot.mjs sessions.png` and open `sessions.png`.

Verify:
- The rail shows **no Activity** entry (Cockpit · Agent · Sessions · Channels · Diff · Radar · Memory · Usage; Settings pinned bottom).
- Sessions renders master-detail: left list has a pinned **All activity** + recency groups; right pane shows the **merged feed** by default.
- Filter chips **All / Live / Done / Needs attention** are present.

- [ ] **Step 4: Verify selection + actions**

- Click a session in the left list → right pane shows its header + a `NarrationTimeline` (transcript loads).
- A **live** session (if one is running) shows a **Jump →** button; clicking it lands on the Agent surface with that agent focused.
- An **ended** session shows **Resume →**; clicking it launches a terminal that becomes a live agent.
- The **Needs attention** chip filters to asking/failed/waiting sessions.

Screenshot each: `node scripts/cdp-shot.mjs detail.png`, `node scripts/cdp-shot.mjs needs.png`.

- [ ] **Step 5: Verify the startup-pref migration**

If a persisted `cockpit.startup.surface` of `"activity"` exists (from a prior build), the app boots to **Sessions**, not a blank surface. (Optional: set it via DevTools `localStorage`, relaunch the app process — not a CDP reload — and confirm.)

- [ ] **Step 6: Final full verification**

Run: `go test ./pkg/agentsessions/` → PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Run: `npx vitest run frontend/app/view/agents/ frontend/app/store/keybindings/` → PASS.

---

## Self-Review

**1. Spec coverage:**
- Unify parser in Go (port `activityevents.ts`) → Tasks 1-4. ✓
- New `SessionEvent`/`SessionActivity` + `GetSessionsActivity` RPC, keep lean `GetRecentSessions` → Task 5 (GetRecentSessions untouched). ✓
- Derive `Status`/`StartedTs`/`DurationMs`; `TranscriptPath` for FE matching → Tasks 1 (assemble), 4 (populate), 5 (wire field). ✓
- FE store: loader switch, `overlayLive`, `groupByRecency`, `filterByStatus`, `mergedFeed` → Task 6. ✓
- Live overlay flips Resume↔Jump; strips `finished` for live → Task 6 (`overlayLive`) + Task 8 (`act`). ✓
- "Needs attention" = asks+errors (+live asking), not failed+waiting-only → Task 6 (`needsAttention`) + `filterByStatus`. ✓
- Master-detail surface, recency groups, runtime tag kept, @theme tokens → Task 8. ✓
- Detail reuses `NarrationTimeline` via `projectTranscript`/`projectCodexTranscript` → Task 8. ✓
- Retire Activity: delete 7 files; edit shell/nav/agents/bindings/store.test; startup migration → Task 9. ✓
- Cross-project (no single-repo scoping) → surface groups by recency across all projects; no project filter added. ✓
- Testing: Go extractor tests, vitest store tests, typecheck, CDP → Tasks 1-4, 6, 8-10. ✓

**2. Placeholder scan:** The one intentional placeholder (`codexProjection` import alias in Task 8 Step 1) is explicitly corrected in Task 8 Step 2 with the real export name `projectCodexTranscript` — flagged, not left dangling. No `TBD`/`add error handling`/`similar to`. Every code step shows complete code.

**3. Type consistency:**
- `sessionEvents` (Go internal) fields `Events/Status/StartedTs/DurationMs` used identically in Tasks 1, 2, 3, 4. ✓
- `LiveSession` shape (`live`, `liveId?`, `needsAttention`, extends `SessionActivity`) defined in Task 6, consumed in Task 8. ✓
- Model atoms `sessionsStatusFilterAtom` / `sessionsSelAtom` (Task 7) match usage in Task 8. ✓
- Selection key `${runtime}:${id}` consistent between `mergedFeed.sessionKey` (Task 6), `setSel` targets, and `selected` lookup (Task 8). ✓
- Wire field names (lowercase json tags) match generated TS: `transcriptpath`, `tokenstotal`, `lastactivets`, `resumecommand`, `startedts`, `durationms` — used consistently in Task 6/8. ✓
- `GetSessionsActivityCommand({ windowdays, limit })` matches the generated data type (`windowdays?`, `limit?`). ✓

**Note for the implementer:** `AgentVM` is asserted (`as AgentVM`) in the Task 6 test fixture because only `id`/`state`/`transcriptPath` are exercised; if `overlayLive` is later extended to read another `AgentVM` field, widen the fixture. Before Task 6, confirm `AgentVM` still exposes `id`, `state`, and `transcriptPath?` (agentsviewmodel.ts:73-86) — the overlay depends on all three.
