# Pi Auto-Title Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi sessions get a Claude-Code-style LLM-generated title in the cockpit agent tab (row + header), replacing the raw first-message head text.

**Architecture:** Claude Code self-titles by having the model summarize the task into a short title. pi has no such feature, so the waveterm backend becomes the title provider for pi: on every `agent:status` event for a pi agent without an explicit title, an in-memory cache (keyed by transcript path) serves the session title; on a cache miss the backend asynchronously reads the session's first user message, calls the cheap OpenRouter model (the same `consult.Run` path memory distillation uses) with a "title this task" prompt, falls back to the first-message head text when the LLM is unavailable, and publishes a titled `agent:status` event. The pi status extension stops sending the head-text fallback (it only reports the user's explicit pi session name), so the backend is the single source of auto titles. The frontend needs no change: the `mergeAgentStatusData` retention fix (commit 51706019) already keeps the generated title across the extension's title-less events.

**Tech Stack:** Go (wshserver event funnel, consult openrouter backend), pi extension TS (regenerated via `task sync:piartifacts`), existing vitest/go test suites.

## Global Constraints

- Do not touch `cmd/wsh/cmd/pi-status-extension.ts` by hand — edit `pi/extensions/waveterm-status.ts` and run `task sync:piartifacts`.
- Reuse the existing LLM path (`consult.Run` with runtime `"openrouter"`, tier `consult.TierCheap`) — do not add a new provider/client.
- No frontend changes: the status-store retention (agentstatusstore mergeAgentStatusData) already handles title-less events.
- Extension changes take effect on the next pi launch (pi loads extensions at startup) — note this in the final report.
- Title generation is best-effort and async; it must never block or fail the hook event path.
- Backend pure logic gets Go tests; no new SQL migrations, no new wshrpc commands.

---

### Task 1: Backend pi-title provider (Go)

**Files:**
- Create: `pkg/wshrpc/wshserver/pititle.go`
- Create: `pkg/wshrpc/wshserver/pititle_test.go`
- Modify: `pkg/wshserver/wshserver.go` (EventPublishCommand seam, ~line 165)

**Interfaces:**
- Consumes: `wps.WaveEvent`/`wps.Event_AgentStatus`, `baseds.AgentStatusData`, `consult.SpecForTier("openrouter", consult.TierCheap)` + `consult.Run`, `wps.Broker.Publish`.
- Produces:
  - `func piFirstUserMessage(path string) string` — pure; first user message text from a pi session jsonl (string content or text blocks; tool_result-only turns skipped); "" on any error.
  - `func piHeadTitle(text string) string` — pure; first non-empty line, rune-truncated to 72 (mirrors the old extension fallback).
  - `func piTitlePrompt(taskText string) string` — pure; the LLM prompt.
  - `type PiTitleProvider struct{ ... }` with `func NewPiTitleProvider(gen func(ctx context.Context, prompt string) (string, error)) *PiTitleProvider` and `func (p *PiTitleProvider) NoteEvent(ev *wps.WaveEvent)` — the funnel entry; and `func (p *PiTitleProvider) Reset()` for tests.
  - `func init()` registers a package-level `var PiTitleProviderInstance` wired to the real `consult.Run` generator (constructor pattern so tests build their own).

- [ ] **Step 1: Write the failing tests** (`pititle_test.go`)

```go
package wshserver

import (
    "context"
    "os"
    "path/filepath"
    "testing"
    "time"

    "github.com/wavetermdev/waveterm/pkg/baseds"
    "github.com/wavetermdev/waveterm/pkg/wps"
)

func writePiSession(t *testing.T, lines []string) string {
    t.Helper()
    dir := t.TempDir()
    path := filepath.Join(dir, "session.jsonl")
    data := ""
    for _, l := range lines {
        data += l + "\n"
    }
    if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
        t.Fatal(err)
    }
    return path
}

func TestPiFirstUserMessage(t *testing.T) {
    cases := []struct {
        name  string
        lines []string
        want  string
    }{
        {"string content", []string{
            `{"type":"session","id":"s1"}`,
            `{"type":"message","id":"m1","message":{"role":"user","content":"first prompt"}}`,
        }, "first prompt"},
        {"text block content", []string{
            `{"type":"message","id":"m1","message":{"role":"user","content":[{"type":"text","text":"block text"}]}}`,
        }, "block text"},
        {"skips tool_result-only turns", []string{
            `{"type":"message","id":"m1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
            `{"type":"message","id":"m2","message":{"role":"user","content":"the real ask"}}`,
        }, "the real ask"},
        {"skips assistant turns", []string{
            `{"type":"message","id":"m1","message":{"role":"assistant","content":"hi"}}`,
        }, ""},
        {"no user message", []string{`{"type":"session","id":"s1"}`}, ""},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            if got := piFirstUserMessage(writePiSession(t, tc.lines)); got != tc.want {
                t.Errorf("piFirstUserMessage = %q, want %q", got, tc.want)
            }
        })
    }
    if got := piFirstUserMessage(filepath.Join(t.TempDir(), "missing.jsonl")); got != "" {
        t.Errorf("missing file: got %q, want \"\"", got)
    }
}

func TestPiHeadTitle(t *testing.T) {
    if got := piHeadTitle(""); got != "" {
        t.Errorf("empty: got %q", got)
    }
    if got := piHeadTitle("\n\n  real task\nmore lines\n"); got != "real task" {
        t.Errorf("head line: got %q", got)
    }
    long := "x"
    for i := 0; i < 100; i++ {
        long += "y"
    }
    if got := piHeadTitle(long); len([]rune(got)) != 72 {
        t.Errorf("truncate: got %d runes, want 72", len([]rune(got)))
    }
}

func TestPiTitlePrompt(t *testing.T) {
    p := piTitlePrompt("fix the flicker")
    if p == "" || len(p) < 10 {
        t.Errorf("prompt too short: %q", p)
    }
}

func TestPiTitleProviderGeneratesOncePerTranscript(t *testing.T) {
    calls := 0
    p := NewPiTitleProvider(func(ctx context.Context, prompt string) (string, error) {
        calls++
        return "Fix agent tab flicker", nil
    })
    path := writePiSession(t, []string{`{"type":"message","id":"m1","message":{"role":"user","content":"why does the tab flicker"}}`})
    ev := piStatusEvent("block:uuid-1", "working", "", path, "sess-1")
    p.NoteEvent(ev)
    if p.Result(path, time.Second) != "Fix agent tab flicker" {
        t.Fatalf("title not generated: %+v", p)
    }
    // a second event must not regenerate (cache hit)
    p.NoteEvent(piStatusEvent("block:uuid-1", "working", "", path, "sess-1"))
    if calls != 1 {
        t.Fatalf("expected 1 LLM call, got %d", calls)
    }
    // the event is enriched synchronously on cache hit
    out := piStatusEvent("block:uuid-1", "idle", "", path, "sess-1")
    p.NoteEvent(out)
    if title := out.Data.(baseds.AgentStatusData).Title; title != "Fix agent tab flicker" {
        t.Fatalf("cache-hit enrichment missing title: %q", title)
    }
}

func TestPiTitleProviderFallsBackToHeadText(t *testing.T) {
    p := NewPiTitleProvider(func(ctx context.Context, prompt string) (string, error) {
        return "", nil // LLM returned nothing
    })
    path := writePiSession(t, []string{`{"type":"message","id":"m1","message":{"role":"user","content":"  real task line\nmore"}}`})
    p.NoteEvent(piStatusEvent("block:uuid-1", "working", "", path, "sess-1"))
    if got := p.Result(path, time.Second); got != "real task line" {
        t.Fatalf("fallback title = %q, want %q", got, "real task line")
    }
}

func TestPiTitleProviderSkipsTitledAndNonPiEvents(t *testing.T) {
    calls := 0
    p := NewPiTitleProvider(func(ctx context.Context, prompt string) (string, error) {
        calls++
        return "t", nil
    })
    // explicit title: no generation
    p.NoteEvent(piStatusEvent("block:uuid-1", "working", "user given name", "", "sess-1"))
    // non-pi agent: no generation
    ev := piStatusEvent("block:uuid-2", "working", "", "", "sess-2")
    ev.Data.(baseds.AgentStatusData).Agent = "claude"
    p.NoteEvent(ev)
    // no transcript: no generation
    p.NoteEvent(piStatusEvent("block:uuid-3", "working", "", "", "sess-3"))
    if calls != 0 {
        t.Fatalf("expected 0 LLM calls, got %d", calls)
    }
}
```

Also add a small helper to the test file:

```go
func piStatusEvent(oref, state, title, transcript, sessionID string) *wps.WaveEvent {
    return &wps.WaveEvent{
        Event:  wps.Event_AgentStatus,
        Scopes: []string{oref},
        Data: baseds.AgentStatusData{
            ORef:           oref,
            State:          state,
            Agent:          "pi",
            Title:          title,
            TranscriptPath: transcript,
            SessionID:      sessionID,
            Ts:             time.Now().UnixMilli(),
        },
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `powershell -Command "$env:CGO_CFLAGS='-O2 -g -I' + ((Get-Location).Path -replace '\\','/') + '/pkg/jarvisembed/csrc'; go test ./pkg/wshserver/ -run 'PiTitle|PiFirstUser|PiHead'"`
Expected: build failure — `pititle.go` does not exist yet.

- [ ] **Step 3: Implement `pkg/wshrpc/wshserver/pititle.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
    "bufio"
    "context"
    "encoding/json"
    "os"
    "strings"
    "sync"
    "time"

    "github.com/wavetermdev/waveterm/pkg/baseds"
    "github.com/wavetermdev/waveterm/pkg/consult"
    "github.com/wavetermdev/waveterm/pkg/wps"
)

const piTitleMax = 72 // matches the Claude hook's head-text fallback cap

// piMessageText extracts the text of a pi message entry: a bare string, or the joined text blocks
// (mirrors the pi status extension's messageText so tool_result-only user turns yield "").
func piMessageText(message map[string]any) string {
    content, ok := message["content"]
    if !ok {
        return ""
    }
    if s, ok := content.(string); ok {
        return s
    }
    blocks, ok := content.([]any)
    if !ok {
        return ""
    }
    parts := make([]string, 0, len(blocks))
    for _, b := range blocks {
        bm, ok := b.(map[string]any)
        if !ok || bm["type"] != "text" {
            continue
        }
        if s, ok := bm["text"].(string); ok && s != "" {
            parts = append(parts, s)
        }
    }
    return strings.Join(parts, " ")
}

// piFirstUserMessage returns the text of the first user message in a pi session jsonl, or "".
func piFirstUserMessage(path string) string {
    f, err := os.Open(path)
    if err != nil {
        return ""
    }
    defer f.Close()
    scanner := bufio.NewScanner(f)
    scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
    for scanner.Scan() {
        line := strings.TrimSpace(scanner.Text())
        if line == "" {
            continue
        }
        var rec struct {
            Type    string         `json:"type"`
            Message map[string]any `json:"message"`
        }
        if json.Unmarshal([]byte(line), &rec) != nil || rec.Type != "message" {
            continue
        }
        if role, _ := rec.Message["role"].(string); role != "user" {
            continue
        }
        if text := piMessageText(rec.Message); text != "" {
            return text
        }
    }
    return ""
}

// piHeadTitle is the first non-empty line of text, rune-truncated — the fallback when the LLM
// cannot produce a title.
func piHeadTitle(text string) string {
    for _, line := range strings.Split(text, "\n") {
        line = strings.TrimSpace(line)
        if line == "" {
            continue
        }
        r := []rune(line)
        if len(r) > piTitleMax {
            r = r[:piTitleMax]
        }
        return string(r)
    }
    return ""
}

// piTitlePrompt asks the model for a short task title — the same shape as Claude Code's ai-title
// request (a concise 2-8 word summary, not the raw prompt).
func piTitlePrompt(taskText string) string {
    return "Write a concise title (2-8 words) for this coding task. Reply with only the title.\n\nTask:\n" + taskText
}

// titleGenerator is the LLM seam: production uses consult.Run (openrouter cheap tier); tests inject
// a fake.
type titleGenerator func(ctx context.Context, prompt string) (string, error)

func defaultTitleGenerator(ctx context.Context, prompt string) (string, error) {
    spec, ok := consult.SpecForTier("openrouter", consult.TierCheap)
    if !ok {
        return "", nil
    }
    return consult.Run(ctx, spec, "", prompt, func(string) {})
}

// PiTitleProvider generates one LLM title per pi session (keyed by transcript path) and attaches it
// to agent:status events. Best-effort and async: generation never blocks the hook event path; on LLM
// failure the first-message head text is the fallback. An explicit user session name (non-empty
// Title on the event) always wins and is never overwritten.
type PiTitleProvider struct {
    gen  titleGenerator
    mu   sync.Mutex
    // transcriptPath -> settled title ("" marks "nothing to title"); inFlight guards concurrent gen
    cache    map[string]string
    inFlight map[string]bool
    lastState map[string]string // block oref -> most recent state, for the generated event
}

func NewPiTitleProvider(gen titleGenerator) *PiTitleProvider {
    return &PiTitleProvider{
        gen:       gen,
        cache:     make(map[string]string),
        inFlight:  make(map[string]bool),
        lastState: make(map[string]string),
    }
}

// Reset clears all state (tests).
func (p *PiTitleProvider) Reset() {
    p.mu.Lock()
    defer p.mu.Unlock()
    p.cache = make(map[string]string)
    p.inFlight = make(map[string]bool)
    p.lastState = make(map[string]string)
}

// NoteEvent observes one agent:status event. With an explicit title, the event passes through
// untouched and the provider forgets nothing (a user rename wins over any cached title). Otherwise
// a cached title is attached synchronously; a cache miss kicks off async generation.
func (p *PiTitleProvider) NoteEvent(ev *wps.WaveEvent) {
    data, ok := ev.Data.(baseds.AgentStatusData)
    if !ok || data.Agent != "pi" || data.TranscriptPath == "" {
        return
    }
    if data.Title != "" {
        return // explicit name — the user wins
    }
    p.mu.Lock()
    if data.State != "" {
        p.lastState[data.ORef] = data.State
    }
    cached, has := p.cache[data.TranscriptPath]
    if has {
        p.mu.Unlock()
        if cached != "" {
            data.Title = cached
            ev.Data = data
        }
        return
    }
    if p.inFlight[data.TranscriptPath] {
        p.mu.Unlock()
        return
    }
    p.inFlight[data.TranscriptPath] = true
    p.mu.Unlock()

    go p.generate(data)
}

// generate runs the LLM call, falls back to head text, caches, and publishes the titled event.
func (p *PiTitleProvider) generate(data baseds.AgentStatusData) {
    defer func() {
        p.mu.Lock()
        delete(p.inFlight, data.TranscriptPath)
        p.mu.Unlock()
    }()
    task := piFirstUserMessage(data.TranscriptPath)
    title := ""
    if task != "" {
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        if gen, err := p.gen(ctx, piTitlePrompt(task)); err == nil {
            title = strings.TrimSpace(gen)
        }
        cancel()
        if title == "" {
            title = piHeadTitle(task) // LLM unavailable or empty — same fallback the extension used
        }
    }
    p.mu.Lock()
    p.cache[data.TranscriptPath] = title
    state := p.lastState[data.ORef]
    p.mu.Unlock()
    if title == "" || state == "" {
        return // nothing to show, or we never saw a real state for this block
    }
    data.Title = title
    data.State = state
    data.Ts = time.Now().UnixMilli()
    wps.Broker.Publish(wps.WaveEvent{
        Event:   wps.Event_AgentStatus,
        Scopes:  []string{data.ORef},
        Persist: 1,
        Data:    data,
    })
}

// Result returns the settled title for a transcript path (tests, with a wait for async generation).
func (p *PiTitleProvider) Result(transcriptPath string, wait time.Duration) string {
    deadline := time.Now().Add(wait)
    for time.Now().Before(deadline) {
        p.mu.Lock()
        data, ok := p.cache[oref]
        p.mu.Unlock()
        if ok {
            return data
        }
        time.Sleep(10 * time.Millisecond)
    }
    return ""
}
```

- [ ] **Step 4: Wire the seam into `EventPublishCommand` (wshserver.go)**

In `func (ws *WshServer) EventPublishCommand`, after the existing Sender normalization and before `wps.Broker.Publish(data)`:

```go
if data.Event == wps.Event_AgentStatus {
    PiTitleProviderInstance.NoteEvent(&data)
}
```

And at the top of the file (or near the provider file):

```go
// PiTitleProviderInstance is the title provider for agent runtimes that do not self-title (pi).
// Wired to the real openrouter generator; tests replace it via NewPiTitleProvider.
var PiTitleProviderInstance = NewPiTitleProvider(defaultTitleGenerator)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: same command as Step 2.
Expected: all PiTitle* tests PASS.

- [ ] **Step 6: Build + vet**

Run: `powershell -Command "$env:CGO_CFLAGS='-O2 -g -I' + ((Get-Location).Path -replace '\\','/') + '/pkg/jarvisembed/csrc'; go build ./pkg/wshserver/...; go vet ./pkg/wshserver/"`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshserver/pititle.go pkg/wshrpc/wshserver/pititle_test.go pkg/wshserver/wshserver.go
git commit -m "feat(agents): backend generates an LLM title for pi sessions
...
"
```

---

### Task 2: pi status extension stops sending the head-text fallback

**Files:**
- Modify: `pi/extensions/waveterm-status.ts` (drop messageText/headLine/TITLE_MAX + the fallback loop in sessionTitle)
- Modify: `cmd/wsh/cmd/pi-status-extension.test.ts` (regenerated companion; update sessionTitle tests)
- Regenerate: `task sync:piartifacts`

**Interfaces:**
- Consumes: the backend PiTitleProvider from Task 1 (which now owns auto titles).
- Produces: `sessionTitle(sm)` returns only the explicit pi session name ("" when unset); the extension always passes `--title` (possibly empty).

- [ ] **Step 1: Write the failing tests** (update `cmd/wsh/cmd/pi-status-extension.test.ts`)

Replace the `sessionTitle` describe block: keep "prefers the explicit session name", replace the fallback tests with one asserting the fallback is now empty:

```ts
it("reports nothing when the session has no explicit name (the backend generates auto titles)", () => {
    expect(
        sessionTitle(
            sm([
                { type: "message", message: { role: "user", content: [{ type: "text", text: "first prompt" }] } },
            ])
        )
    ).toBe("");
});
```

Remove: `falls back to the first user message's head text`, `reads string content and takes the first non-empty line`, `skips tool_result-only user turns`, `truncates a long head text to 72 runes`, `returns empty when the session has no user message`, and the `reports the first-message fallback title through agentstatus` test (assert instead that `--title` is empty for a nameless session).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run cmd/wsh/cmd/pi-status-extension.test.ts`
Expected: FAIL — `sessionTitle` still returns the head text.

- [ ] **Step 3: Implement the extension change** (`pi/extensions/waveterm-status.ts`)

Delete `TITLE_MAX`, `messageText`, `headLine`; shrink `sessionTitle` to:

```ts
/** Session title for the cockpit row: pi's explicit session name, else "" — the backend
 *  (PiTitleProvider) generates auto titles from the first user message, so the extension never
 *  fabricates a fallback that would overwrite a generated one. */
export function sessionTitle(sm: any): string {
    return sm?.getSessionName?.()?.trim() ?? "";
}
```

- [ ] **Step 4: Regenerate + run tests**

Run: `task sync:piartifacts` then `npx vitest run cmd/wsh/cmd/pi-status-extension.test.ts`
Expected: PASS. `git diff cmd/wsh/cmd/pi-status-extension.ts` shows only the sessionTitle/helper removal.

- [ ] **Step 5: Commit**

```bash
git add pi/extensions/waveterm-status.ts cmd/wsh/cmd/pi-status-extension.ts cmd/wsh/cmd/pi-status-extension.test.ts
git commit -m "feat(agents): pi status extension defers auto titles to the backend
..."
```

---

### Task 3: Verify end to end

- [ ] **Step 1: Full backend + frontend checks**

Run:
- `powershell -Command "$env:CGO_CFLAGS='-O2 -g -I' + ((Get-Location).Path -replace '\\','/') + '/pkg/jarvisembed/csrc'; go test ./pkg/wshserver/ ./pkg/consult/"`
- `npx vitest run cmd/wsh/cmd/pi-status-extension.test.ts frontend/app/view/agents`
Expected: all pass.

- [ ] **Step 2: Rebuild + reinstall the extension**

Run: `task build:backend` then `wsh install-agent-hooks` (reinstalls the pi status extension with the current wsh path).
Expected: `~/.pi/agent/extensions/waveterm-status.ts` no longer contains `messageText`/`headLine`.

- [ ] **Step 3: Live sanity (optional, requires a fresh pi launch)**

Launch a pi tab with a task in the dev app; within a few seconds the row should show an LLM title (not the raw first line). Skip if the dev app is not running — the unit tests cover the data flow; note the extension change only takes effect on the next pi start.

- [ ] **Step 4: Commit any stragglers + report**

If Step 3 left changes, commit them. Report: what was built, how it degrades (no OPENROUTER key → head-text fallback; old wavesrv + new extension → project name until upgrade), and that the extension change lands on the next pi launch.
