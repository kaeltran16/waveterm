# OpenRouter Headless AI Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all 10 headless AI features from `claude -p` to OpenRouter's HTTP API, restoring functionality after the Claude Code removal.

**Architecture:** Add an `apiBackend` interface + `openrouterBackend` to `pkg/consult`, running alongside the existing CLI path. The backend sends OpenAI-compatible chat completions to `https://openrouter.ai/api/v1/chat/completions`, streams SSE, and reuses existing `openaichat.StreamChunk` types. Three model IDs are configurable via settings; `SpecForTier("openrouter", tier)` resolves them. Callers that hardcode `claude` binary are rewritten to use `consult.Run`.

**Tech Stack:** Go 1.23, `eventsource.NewDecoder` (already in go.mod), `openaichat.StreamChunk` (existing), `secretstore` (existing), React 19 + Tailwind 4 (settings UI)

## Global Constraints

- No new Go dependencies — reuse `eventsource.NewDecoder` and `openaichat.StreamChunk` already in go.mod
- No retry logic — callers handle failure
- OPENROUTER_KEY reused from existing secret store (no new secret name)
- Settings UI follows existing ConfigField/SectionLabel patterns in settingssurface.tsx
- All existing tests must keep passing

---

### Task 1: Settings config fields

**Files:**
- Modify: `pkg/wconfig/settingsconfig.go`
- Modify: `pkg/wconfig/metaconsts.go`

**Interfaces:**
- Produces: `SettingsType.HeadlessOpenRouterCheapModel`, `.HeadlessOpenRouterMidModel`, `.HeadlessOpenRouterLongModel` (string)
- Produces: `ConfigKey_HeadlessOpenRouterCheapModel`, `_MidModel`, `_LongModel` (string constants)

- [ ] **Step 1: Add fields to SettingsType**

In `pkg/wconfig/settingsconfig.go`, find `MemoryGardenerCooldownMins   int    `json:"memory:gardenercooldownmins,omitempty"`` and add after:

```go
HeadlessOpenRouterCheapModel string `json:"headless:openroutercheapmodel,omitempty"`
HeadlessOpenRouterMidModel   string `json:"headless:openroutermidmodel,omitempty"`
HeadlessOpenRouterLongModel  string `json:"headless:openrouterlongmodel,omitempty"`
```

- [ ] **Step 2: Add constants to metaconsts.go**

In `pkg/wconfig/metaconsts.go`, find `ConfigKey_MemoryGardenerCooldownMins` and add after:

```go
ConfigKey_HeadlessOpenRouterCheapModel     = "headless:openroutercheapmodel"
ConfigKey_HeadlessOpenRouterMidModel       = "headless:openroutermidmodel"
ConfigKey_HeadlessOpenRouterLongModel      = "headless:openrouterlongmodel"
```

- [ ] **Step 3: Verify it compiles**

Run: `go build ./pkg/wconfig/...`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add pkg/wconfig/settingsconfig.go pkg/wconfig/metaconsts.go
git commit -m "feat: add headless OpenRouter model config fields"
```

---

### Task 2: RuntimeSpec changes + apiBackend interface + run dispatch

**Files:**
- Modify: `pkg/consult/consult.go` (RuntimeSpec struct, runtimeSpecs map, SupportedRuntimes)
- Modify: `pkg/consult/exec.go` (Run function dispatch)

**Interfaces:**
- Produces: `apiBackend` interface with `Run(ctx context.Context, spec RuntimeSpec, prompt string, emit func(string)) (string, error)`
- Produces: `RuntimeSpec.ApiBackend apiBackend`, `RuntimeSpec.Model string`

- [ ] **Step 1: Add apiBackend interface and extend RuntimeSpec**

In `pkg/consult/consult.go`, after the `const` block (line 25), add:

```go
// apiBackend runs a model call over an HTTP API instead of a local CLI process.
type apiBackend interface {
	Run(ctx context.Context, spec RuntimeSpec, prompt string, emit func(string)) (string, error)
}
```

Replace the `RuntimeSpec` struct (lines 38-44) with:

```go
// RuntimeSpec is how to invoke a runtime in one-shot/print mode.
//
// Output handling (see Run in exec.go):
//   - ParseLine != nil => the CLI emits JSONL events on stdout; scan line-by-line and emit the text
//     each reply event carries. This is real incremental streaming (claude stream-json, codex --json).
//   - UsePty => the CLI only renders to a terminal and drops stdout under a pipe/subprocess. Spawn it
//     under a pty and clean the TUI stream. This is the agy non-TTY workaround (antigravity-cli#76).
//   - neither => read raw stdout chunks verbatim (used by tests / plain tools).
//
// PromptViaStdin true => pipe the prompt over stdin; false => append it as the final positional arg.
// pty mode cannot easily feed stdin, so pty runtimes pass the prompt positionally.
type RuntimeSpec struct {
	Bin            string
	BaseArgs       []string
	PromptViaStdin bool
	UsePty         bool
	ParseLine      func(line []byte) (text string, isReply bool)
	ApiBackend     apiBackend // if set, Run() calls the API instead of shelling out
	Model          string     // model id for API backends
}
```

- [ ] **Step 2: Add openrouter entry to runtimeSpecs**

In the `runtimeSpecs` map (line 56-61), add after the opencode entry:

```go
"openrouter": {ApiBackend: &openrouterBackend{}},
```

- [ ] **Step 3: Update Run() dispatch in exec.go**

Replace the `Run` function body (lines 25-30) with:

```go
func Run(ctx context.Context, spec RuntimeSpec, cwd, prompt string, emit func(string)) (string, error) {
	if spec.ApiBackend != nil {
		return spec.ApiBackend.Run(ctx, spec, prompt, emit)
	}
	if spec.UsePty {
		return runPty(ctx, spec, cwd, prompt, emit)
	}
	return runPipe(ctx, spec, cwd, prompt, emit)
}
```

- [ ] **Step 4: Update SupportedRuntimes**

In `consult.go`, replace line 223-225:

```go
func SupportedRuntimes() []string {
	return []string{"claude", "codex", "antigravity", "opencode", "openrouter"}
}
```

- [ ] **Step 5: Verify compiles (will fail until Task 3)**

Run: `go build ./pkg/consult/...`
Expected: FAIL — `undefined: openrouterBackend` (resolved in Task 3)

- [ ] **Step 6: Commit**

```bash
git add pkg/consult/consult.go pkg/consult/exec.go
git commit -m "feat: add apiBackend interface and openrouter runtime spec entry"
```

---

### Task 3: OpenRouter backend implementation

**Files:**
- Create: `pkg/consult/openrouter.go`

**Interfaces:**
- Consumes: `apiBackend`, `RuntimeSpec`, `secretstore.GetSecret`, `openaichat.StreamChunk`, `eventsource.NewDecoder`, `wconfig`
- Produces: `openrouterBackend` struct, `OpenrouterCheapModel()`, `OpenrouterMidModel()`, `OpenrouterLongModel()` (exported for memdistill/memgarden)

- [ ] **Step 1: Write the backend**

Create `pkg/consult/openrouter.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package consult

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/launchdarkly/eventsource"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/openaichat"
	"github.com/wavetermdev/waveterm/pkg/secretstore"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

const (
	openRouterChatEndpoint = "https://openrouter.ai/api/v1/chat/completions"
	openRouterSecretName   = "OPENROUTER_KEY"
	openRouterTimeout      = 5 * time.Minute
)

type openrouterBackend struct{}

func (b *openrouterBackend) Run(ctx context.Context, spec RuntimeSpec, prompt string, emit func(string)) (string, error) {
	key, exists, err := secretstore.GetSecret(openRouterSecretName)
	if err != nil {
		return "", fmt.Errorf("reading OPENROUTER_KEY: %w", err)
	}
	if !exists || key == "" {
		return "", fmt.Errorf("OpenRouter API key not configured (set OPENROUTER_KEY)")
	}

	model := spec.Model
	if model == "" {
		model = OpenrouterMidModel()
	}

	body := map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
		"stream": true,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshaling request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, openRouterChatEndpoint, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)

	client := &http.Client{Timeout: openRouterTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("OpenRouter request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("OpenRouter API error %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}

	decoder := eventsource.NewDecoder(resp.Body)
	var full strings.Builder
	for {
		ev, derr := decoder.Decode()
		if derr != nil {
			if derr == io.EOF {
				break
			}
			return full.String(), fmt.Errorf("SSE decode error: %w", derr)
		}
		data := strings.TrimSpace(ev.Data())
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk openaichat.StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		for _, choice := range chunk.Choices {
			if choice.Delta.Content != "" {
				full.WriteString(choice.Delta.Content)
				emit(choice.Delta.Content)
			}
		}
	}
	return full.String(), nil
}

// OpenrouterCheapModel returns the configured cheap model or the default.
func OpenrouterCheapModel() string {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.HeadlessOpenRouterCheapModel != "" {
		return cfg.Settings.HeadlessOpenRouterCheapModel
	}
	return "deepseek/deepseek-v4-flash"
}

// OpenrouterMidModel returns the configured mid model or the default.
func OpenrouterMidModel() string {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.HeadlessOpenRouterMidModel != "" {
		return cfg.Settings.HeadlessOpenRouterMidModel
	}
	return "deepseek/deepseek-v4-pro"
}

// OpenrouterLongModel returns the configured long-context model or the default.
func OpenrouterLongModel() string {
	if cfg := wconfig.GetWatcher().GetFullConfig(); cfg.Settings.HeadlessOpenRouterLongModel != "" {
		return cfg.Settings.HeadlessOpenRouterLongModel
	}
	return "deepseek/deepseek-v4-pro"
}
```

- [ ] **Step 2: Verify it compiles**

Run: `go build ./pkg/consult/...`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add pkg/consult/openrouter.go
git commit -m "feat: add OpenRouter API backend to consult package"
```

---

### Task 4: SpecForTier + ModelForCorpus changes for openrouter

**Files:**
- Modify: `pkg/consult/consult.go` (SpecForTier, add CorpusModel)

**Interfaces:**
- Consumes: `OpenrouterCheapModel()`, `OpenrouterMidModel()` from openrouter.go
- Produces: `CorpusModel(cheapModel, longModel, corpus string) string`

- [ ] **Step 1: Add CorpusModel function**

In `pkg/consult/consult.go`, add after `ModelForCorpus` (line 221):

```go
// CorpusModel picks cheapModel or longModel based on whether corpus exceeds the escalation threshold.
// Callers using openrouter pass the configured model IDs; callers using claude pass CorpusCheapModel/
// CorpusLongModel. The threshold is the same for both.
func CorpusModel(cheapModel, longModel, corpus string) string {
	if len(corpus) >= CorpusEscalationBytes {
		return longModel
	}
	return cheapModel
}
```

- [ ] **Step 2: Update SpecForTier to handle openrouter**

Replace `SpecForTier` (lines 182-194) with:

```go
// SpecForTier resolves a runtime spec with the tier's model selection applied.
// For claude, it appends --model flags to BaseArgs.
// For openrouter, it sets spec.Model from the configured tier models.
// Other runtimes are returned unchanged.
func SpecForTier(runtime string, tier Tier) (RuntimeSpec, bool) {
	spec, ok := SpecFor(runtime)
	if !ok {
		return spec, false
	}
	if runtime == "openrouter" {
		switch tier {
		case TierCheap:
			spec.Model = OpenrouterCheapModel()
		case TierMid, TierCapable:
			spec.Model = OpenrouterMidModel()
		}
		return spec, true
	}
	model := modelForTier(tier)
	if model == "" || runtime != "claude" {
		return spec, ok
	}
	spec.BaseArgs = append(append([]string{}, spec.BaseArgs...), "--model", model)
	return spec, true
}
```

- [ ] **Step 3: Verify it compiles**

Run: `go build ./pkg/consult/...`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add pkg/consult/consult.go
git commit -m "feat: wire SpecForTier and CorpusModel for openrouter runtime"
```

---

### Task 5: Update and add consult tests

**Files:**
- Modify: `pkg/consult/consult_test.go`
- Create: `pkg/consult/openrouter_test.go`

- [ ] **Step 1: Update TestSpecFor_knownRuntimes for openrouter**

Replace the function (lines 14-33) with:

```go
func TestSpecFor_knownRuntimes(t *testing.T) {
	cases := map[string]struct {
		bin  string
		arg0 string
	}{
		"claude":      {"claude", "-p"},
		"codex":       {"codex", "exec"},
		"antigravity": {"agy", "-p"},
		"opencode":    {"opencode", "run"},
	}
	for rt, want := range cases {
		spec, ok := SpecFor(rt)
		if !ok {
			t.Fatalf("%s: expected ok", rt)
		}
		if spec.Bin != want.bin || len(spec.BaseArgs) == 0 || spec.BaseArgs[0] != want.arg0 {
			t.Errorf("%s: got bin=%q args=%v", rt, spec.Bin, spec.BaseArgs)
		}
	}
	// openrouter is an API runtime — no Bin, but ApiBackend must be set
	spec, ok := SpecFor("openrouter")
	if !ok {
		t.Fatal("openrouter: expected ok")
	}
	if spec.ApiBackend == nil {
		t.Error("openrouter: expected ApiBackend to be set")
	}
}
```

- [ ] **Step 2: Add openrouter SpecForTier tests**

Add after `TestSpecForTier_tiersAreDistinct` (before line 289):

```go
func TestSpecForTier_openrouterSetsModel(t *testing.T) {
	spec, ok := SpecForTier("openrouter", TierCheap)
	if !ok {
		t.Fatal("expected openrouter to resolve")
	}
	if spec.Model == "" {
		t.Fatal("cheap tier must set a model on the spec")
	}
	if spec.ApiBackend == nil {
		t.Fatal("openrouter spec must have an ApiBackend")
	}
	mid, _ := SpecForTier("openrouter", TierMid)
	if mid.Model == "" {
		t.Fatal("mid tier must set a model")
	}
	cap, _ := SpecForTier("openrouter", TierCapable)
	if cap.Model != mid.Model {
		t.Fatalf("capable must match mid tier for openrouter: %q vs %q", cap.Model, mid.Model)
	}
}
```

- [ ] **Step 3: Write openrouter tests**

Create `pkg/consult/openrouter_test.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package consult

import (
	"strings"
	"testing"
)

func TestOpenrouterModelDefaults(t *testing.T) {
	if m := "deepseek/deepseek-v4-flash"; OpenrouterCheapModel() != m {
		t.Logf("OpenrouterCheapModel: got %q, expected %q (when no config set)", OpenrouterCheapModel(), m)
	}
	if m := "deepseek/deepseek-v4-pro"; OpenrouterMidModel() != m {
		t.Logf("OpenrouterMidModel: got %q, expected %q (when no config set)", OpenrouterMidModel(), m)
	}
	if m := "deepseek/deepseek-v4-pro"; OpenrouterLongModel() != m {
		t.Logf("OpenrouterLongModel: got %q, expected %q (when no config set)", OpenrouterLongModel(), m)
	}
}

func TestCorpusModel_escalatesAtThreshold(t *testing.T) {
	cheap := "cheap-model"
	long := "long-model"
	if got := CorpusModel(cheap, long, ""); got != cheap {
		t.Fatalf("empty corpus: got %q, want %q", got, cheap)
	}
	under := strings.Repeat("x", CorpusEscalationBytes-1)
	if got := CorpusModel(cheap, long, under); got != cheap {
		t.Fatalf("under threshold: got %q, want %q", got, cheap)
	}
	atThreshold := strings.Repeat("x", CorpusEscalationBytes)
	if got := CorpusModel(cheap, long, atThreshold); got != long {
		t.Fatalf("at threshold: got %q, want %q", got, atThreshold)
	}
}
```

- [ ] **Step 4: Run all consult tests**

Run: `go test ./pkg/consult/... -v -count=1 -timeout 30s`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/consult/consult_test.go pkg/consult/openrouter_test.go
git commit -m "test: add openrouter SpecForTier and backend tests"
```

---

### Task 6: One-line runtime changes — 7 SpecForTier call sites

**Files:**
- Modify: `pkg/jarvis/classify.go:118`
- Modify: `pkg/jarvis/decompose.go:70`
- Modify: `pkg/jarviscontinuity/continuity.go:26`
- Modify: `pkg/jarvisproactive/proactive.go:30`
- Modify: `pkg/jarvisvolunteer/judge.go:25`
- Modify: `pkg/jarvisrecall/recall.go:44`
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go:177`

- [ ] **Step 1: Change all 7 sites from "claude" to "openrouter"**

In each file, find `consult.SpecForTier("claude",` and replace the `"claude"` with `"openrouter"`.

- [ ] **Step 2: Verify it compiles**

Run: `go build ./pkg/jarvis/... ./pkg/jarviscontinuity/... ./pkg/jarvisproactive/... ./pkg/jarvisvolunteer/... ./pkg/jarvisrecall/... ./pkg/wshrpc/...`
Expected: exit 0

- [ ] **Step 3: Run affected tests**

```bash
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvis/... ./pkg/jarviscontinuity/... ./pkg/jarvisproactive/... ./pkg/jarvisvolunteer/... ./pkg/jarvisrecall/... -v -count=1 -timeout 30s
```
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add pkg/jarvis/classify.go pkg/jarvis/decompose.go pkg/jarviscontinuity/continuity.go pkg/jarvisproactive/proactive.go pkg/jarvisvolunteer/judge.go pkg/jarvisrecall/recall.go pkg/wshrpc/wshserver/wshserver_jarvis.go
git commit -m "feat: switch 7 SpecForTier call sites to openrouter runtime"
```

---

### Task 7: memdistill rewrite — drop ClaudePath, use consult.Run

**Files:**
- Modify: `pkg/memdistill/distill.go`
- Modify: `pkg/memdistill/coordinator.go`
- Modify: `pkg/memdistill/queue.go`
- Modify: `pkg/memdistill/queue_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_memory.go`
- Modify: `cmd/wsh/cmd/wshcmd-agent-memory-hook.go`

**Interfaces:**
- Consumes: `consult.Run`, `consult.SpecForTier("openrouter", TierCheap)`, `consult.CorpusModel`, `consult.OpenrouterCheapModel()`, `consult.OpenrouterLongModel()`
- Produces: `distillFn` signature: `func(ctx context.Context, spec consult.RuntimeSpec, corpus string) (string, bool)`

- [ ] **Step 1: Drop ClaudePath from queue**

In `pkg/memdistill/queue.go`, change `queueState` (line 19-22):

```go
type queueState struct {
	Buckets map[string][]pendingSession `json:"buckets"`
}
```

Remove `ClaudePath string` field entirely. Change `addPending` to drop the `claudePath` parameter:

```go
func addPending(st *queueState, cwd, transcriptPath, enqueuedAt string) {
```

Remove the `ClaudePath` preservation logic inside `addPending`.

- [ ] **Step 2: Update queue tests**

In `pkg/memdistill/queue_test.go`:

```go
func TestAddPending_DedupesByPath(t *testing.T) {
	st := queueState{Buckets: map[string][]pendingSession{}}
	addPending(&st, "/repo/a", "/t/1.jsonl", "2026-07-15T00:00:00Z")
	addPending(&st, "/repo/a", "/t/1.jsonl", "2026-07-15T00:01:00Z")
	addPending(&st, "/repo/a", "/t/2.jsonl", "2026-07-15T00:02:00Z")
	if got := len(st.Buckets["/repo/a"]); got != 2 {
		t.Fatalf("bucket size = %d, want 2 (dupe path ignored)", got)
	}
}

func TestSaveLoadQueue_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "queue.json")
	st := queueState{Buckets: map[string][]pendingSession{
		"/repo/a": {{TranscriptPath: "/t/1.jsonl", EnqueuedAt: "2026-07-15T00:00:00Z"}},
	}}
	if err := saveQueue(path, st); err != nil {
		t.Fatalf("saveQueue: %v", err)
	}
	got := loadQueue(path)
	if len(got.Buckets["/repo/a"]) != 1 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}
```

- [ ] **Step 3: Drop ClaudePath from Enqueue callers**

In `pkg/wshrpc/wshserver/wshserver_memory.go` line 113, change:

```go
memdistill.Enqueue(data.Cwd, data.TranscriptPath)
```

In `cmd/wsh/cmd/wshcmd-agent-memory-hook.go` lines 56-69, remove `claudePath` lookup and stop sending it:

```go
jwt := os.Getenv(wshutil.WaveJwtTokenVarName)
if jwt == "" {
	return nil
}
if setupRpcClient(nil, jwt) != nil {
	return nil
}
_ = wshclient.MemoryEnqueueSessionCommand(RpcClient, wshrpc.CommandMemoryEnqueueSessionData{
	Cwd:            ev.Cwd,
	TranscriptPath: ev.TranscriptPath,
}, &wshrpc.RpcOpts{Timeout: 5000})
```

Remove the `ClaudePath string` field from `CommandMemoryEnqueueSessionData` in `pkg/wshrpc/wshrpctypes_memory.go` (line 101). Run `task generate` to regenerate Go and TS bindings.

- [ ] **Step 4: Rewrite buildCorpus and runDistill**

In `pkg/memdistill/distill.go`, change `buildCorpus` to return only the corpus string (line 76):

```go
func buildCorpus(sessions []pendingSession) string {
	if len(sessions) == 0 {
		return ""
	}
	perSession := int64(combinedBudget / len(sessions))
	var b strings.Builder
	for i, s := range sessions {
		fmt.Fprintf(&b, "\n\n===== SESSION %d (%s) =====\n\n", i+1, s.TranscriptPath)
		b.WriteString(readTail(s.TranscriptPath, perSession))
	}
	return b.String()
}
```

Replace `runDistill` (lines 120-138) with:

```go
func runDistill(ctx context.Context, spec consult.RuntimeSpec, corpus string) (string, bool) {
	model := consult.CorpusModel(consult.OpenrouterCheapModel(), consult.OpenrouterLongModel(), corpus)
	spec.Model = model
	prompt := batchDistillPrompt + "\n\n" + corpus
	full, err := consult.Run(ctx, spec, wavebase.HeadlessAgentCwd(), prompt, func(string) {})
	if err != nil {
		log.Printf("[memdistill] distill failed (model %s): %v\n", model, err)
		return "", false
	}
	return full, true
}
```

- [ ] **Step 5: Update coordinator distillFn signature and flush**

In `pkg/memdistill/coordinator.go`, change the `distillFn` field type (line 30):

```go
distillFn func(ctx context.Context, spec consult.RuntimeSpec, corpus string) (string, bool)
```

Change `Enqueue` signature (line 205):

```go
func Enqueue(cwd, transcriptPath string) {
```

Change the `enqueue` method signature to match (line 59):

```go
func (d *distiller) enqueue(cwd, transcriptPath string) {
```

Update `enqueue` body (lines 60-68) to drop `claudePath`. Update `flush` (lines 99-106):

```go
d.mu.Lock()
st := loadQueue(d.path)
sessions := append([]pendingSession(nil), st.Buckets[cwd]...)
d.mu.Unlock()
if len(sessions) == 0 {
	return
}

corpus := buildCorpus(sessions)
spec, _ := consult.SpecForTier("openrouter", consult.TierCheap)
raw, ok := d.distillFn(context.Background(), spec, corpus)
```

- [ ] **Step 6: Regenerate bindings**

Run: `task generate`
Expected: exit 0, no changes to unrelated files

- [ ] **Step 7: Verify it compiles**

Run: `go build ./pkg/memdistill/... ./pkg/wshrpc/... ./cmd/wsh/...`
Expected: exit 0

- [ ] **Step 8: Run tests**

```bash
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/memdistill/... -v -count=1 -timeout 30s
```
Expected: all tests PASS

- [ ] **Step 9: Commit**

```bash
git add pkg/memdistill/ pkg/wshrpc/wshrpctypes_memory.go pkg/wshrpc/wshserver/wshserver_memory.go cmd/wsh/cmd/wshcmd-agent-memory-hook.go
git add frontend/app/store/wshclientapi.ts  # generated file
git commit -m "feat: rewrite memdistill to use consult.Run, drop ClaudePath"
```

---

### Task 8: memgarden rewrite — drop hardcoded claude exec

**Files:**
- Modify: `pkg/memgarden/gardener.go`

**Interfaces:**
- Consumes: `consult.Run`, `consult.SpecForTier`, `consult.CorpusModel`
- Produces: `runGardenLLM` builds spec from CorpusModel, concatenates prompt+corpus

- [ ] **Step 1: Replace runClaudeHeadless with runGardenAPI**

In `pkg/memgarden/gardener.go`, replace `runClaudeHeadless` (lines 186-205) with:

```go
func runGardenAPI(spec consult.RuntimeSpec, prompt string) (string, bool) {
	full, err := consult.Run(context.Background(), spec, wavebase.HeadlessAgentCwd(), prompt, func(string) {})
	if err != nil {
		log.Printf("[memgarden] llm failed (model %s): %v\n", spec.Model, err)
		return "", false
	}
	return full, true
}
```

Replace `runGardenLLM` (lines 181-184):

```go
func runGardenLLM(model, prompt, corpus string) (string, bool) {
	cheap := consult.OpenrouterCheapModel()
	long := consult.OpenrouterLongModel()
	resolvedModel := consult.CorpusModel(cheap, long, corpus)
	spec, _ := consult.SpecForTier("openrouter", consult.TierCheap)
	spec.Model = resolvedModel
	fullPrompt := prompt + "\n\n" + corpus
	return runGardenAPI(spec, fullPrompt)
}
```

- [ ] **Step 2: Remove unused imports**

Remove `"os"` and `"os/exec"` from gardener.go imports (they were only used by `runClaudeHeadless`).

- [ ] **Step 3: Verify it compiles**

Run: `go build ./pkg/memgarden/...`
Expected: exit 0

- [ ] **Step 4: Run tests**

```bash
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/memgarden/... -v -count=1 -timeout 30s
```
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/memgarden/gardener.go
git commit -m "feat: rewrite memgarden to use consult.Run with openrouter"
```

---

### Task 9: reporadar synth rewrite — drop claude exec + streamFn

**Files:**
- Modify: `pkg/reporadar/synth.go`
- Modify: `pkg/reporadar/scan.go`
- Modify: `pkg/reporadar/cluster_test.go`

**Interfaces:**
- Consumes: `consult.Run`, `consult.SpecForTier("openrouter", TierMid)`
- Produces: simplified `synthesize` — no streamFn param, no custom parser

- [ ] **Step 1: Replace synthesize, remove dead code**

In `pkg/reporadar/synth.go`, delete: `synthStream` (lines 18-24), `parseSynthesisStream` (26-85), `ConfiguredRadarModel` (87-91), `disabledToolArgs` (96-98), `streamFn` type (101), `runSonnet` (103-150), `runSonnetWith` (152-159).

Replace `synthesize` (218-230) with:

```go
func synthesize(ctx context.Context, projectName, mode string, groups []CandidateGroup) (*SynthResponse, error) {
	prompt := buildSynthesisPrompt(projectName, mode, groups)
	spec, ok := consult.SpecForTier("openrouter", consult.TierMid)
	if !ok {
		return nil, fmt.Errorf("openrouter runtime not available")
	}
	full, err := consult.Run(ctx, spec, wavebase.HeadlessAgentCwd(), prompt, func(string) {})
	if err != nil {
		return nil, fmt.Errorf("radar synthesis failed: %w", err)
	}
	return parseSynthesisResponse(full)
}
```

Keep: `SynthFinding`, `SynthResponse`, `parseSynthesisResponse`, `buildSynthesisPrompt`.

- [ ] **Step 2: Drop streamFn from clusterModes**

In `pkg/reporadar/scan.go`, change `clusterModes` signature (line 231) from:

```go
func clusterModes(ctx context.Context, projectName, projectPath string, signals []waveobj.RadarSignal, modes []string, fn streamFn) ([]waveobj.RadarFinding, []waveobj.RadarModeRun) {
```

to:

```go
func clusterModes(ctx context.Context, projectName, projectPath string, signals []waveobj.RadarSignal, modes []string) ([]waveobj.RadarFinding, []waveobj.RadarModeRun) {
```

Inside `clusterModes`, replace line 241:

```go
resp, serr := synthesize(ctx, projectName, mode, groups)
```

Drop the `synthStream` var, drop `stream.modelID`, `stream.totalTokens`, `stream.haveUsage` tracking (lines 257-259). The `RadarModeRun` fields will be zero/default.

Delete `synthStreamFn` (line 168). Update call sites at lines 158 and 179:

```go
findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, cr.signals, V1Modes)
```

```go
findings, modeRuns := clusterModes(ctx, rpt.ProjectName, rpt.ProjectPath, rpt.Candidates, V1Modes)
```

- [ ] **Step 3: Update cluster tests**

In `pkg/reporadar/cluster_test.go`, remove `fn` from `clusterModes` calls (lines 37, 51). If the test defines a `fn := ...` variable, remove it.

```go
findings, runs := clusterModes(context.Background(), "pay", "/repos/pay", sigs, []string{ModeCorrectness})
```

Do the same in `pkg/reporadar/security_scan_test.go` line 34.

- [ ] **Step 4: Remove unused imports from synth.go**

Remove `"bufio"`, `"os/exec"` from `synth.go` imports if they were only used by `runSonnet`. Check `go build` for compile errors.

- [ ] **Step 5: Verify it compiles**

Run: `go build ./pkg/reporadar/...`
Expected: exit 0

- [ ] **Step 6: Run tests**

```bash
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/reporadar/... -v -count=1 -timeout 30s
```
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add pkg/reporadar/
git commit -m "feat: rewrite reporadar synth to use consult.Run with openrouter"
```

---

### Task 10: Settings UI — Headless AI section

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx`

**Interfaces:**
- Consumes: `getSettingsKeyAtom` for model config keys, `RpcApi.GetSecretsNamesCommand` for key status
- Produces: "Headless AI" section with three ConfigFields + API key status indicator

- [ ] **Step 1: Add HeadlessAISection component**

In `settingssurface.tsx`, add after the `EmbeddingsSection` function (after line 880, before the file end):

```tsx
const OPENROUTER_SECRET = "OPENROUTER_KEY";

function HeadlessAISection() {
    const cheapModel = (useAtomValue(getSettingsKeyAtom("headless:openroutercheapmodel")) as string) ?? "";
    const midModel = (useAtomValue(getSettingsKeyAtom("headless:openroutermidmodel")) as string) ?? "";
    const longModel = (useAtomValue(getSettingsKeyAtom("headless:openrouterlongmodel")) as string) ?? "";

    const [hasKey, setHasKey] = useState(false);
    useEffect(() => {
        fireAndForget(async () => {
            try {
                const names = await RpcApi.GetSecretsNamesCommand(TabRpcClient);
                setHasKey((names ?? []).includes(OPENROUTER_SECRET));
            } catch (_) {}
        });
    }, []);

    const write = (patch: Record<string, unknown>) =>
        void RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);

    return (
        <div>
            <SectionLabel>Headless AI</SectionLabel>
            <div className="mb-4 rounded-[11px] border border-border bg-surface px-4 py-3 text-[12.5px] leading-[1.6] text-muted">
                Models for background AI features (gardener, gatekeeper, recall, etc.).
                Uses OpenRouter with the{" "}
                <span className="font-semibold">{hasKey ? "stored" : "missing"}</span>{" "}
                <code className="font-mono text-[11.5px] text-secondary">OPENROUTER_KEY</code> from
                the secret store.
                Model IDs use the full <code className="font-mono text-[11.5px] text-secondary">provider/model</code> format.
            </div>
            <div>
                <ConfigField
                    title="Cheap model"
                    desc="For mechanical tasks: gatekeeper, decompose, continuity, proactive."
                    placeholder="deepseek/deepseek-v4-flash"
                    stored={cheapModel}
                    onSave={(v) => write({ "headless:openroutercheapmodel": v })}
                />
                <ConfigField
                    title="Mid model"
                    desc="For synthesis and conversation: recall, radar, Jarvis."
                    placeholder="deepseek/deepseek-v4-pro"
                    stored={midModel}
                    onSave={(v) => write({ "headless:openroutermidmodel": v })}
                />
                <ConfigField
                    title="Long-context model"
                    desc="For large-corpus tasks: distillation, gardener when corpus &ge; 400KB."
                    placeholder="deepseek/deepseek-v4-pro"
                    stored={longModel}
                    onSave={(v) => write({ "headless:openrouterlongmodel": v })}
                />
            </div>
            {!hasKey ? (
                <div className="mt-3 text-[12px] text-warning">
                    OPENROUTER_KEY not set — headless AI features are disabled until the key is configured.
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Mount the component**

Find the `<EmbeddingsSection />` usage in the main render function and add `<HeadlessAISection />` after it.

- [ ] **Step 3: Verify frontend compiles**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/settingssurface.tsx
git commit -m "feat: add Headless AI settings section for OpenRouter models"
```

---

### Task 11: Final integration verification

- [ ] **Step 1: Build the full project**

```bash
task build:backend
```
Expected: exit 0

- [ ] **Step 2: Run all affected Go tests**

```bash
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/consult/... ./pkg/memdistill/... ./pkg/memgarden/... ./pkg/reporadar/... ./pkg/jarvis/... ./pkg/jarviscontinuity/... ./pkg/jarvisproactive/... ./pkg/jarvisvolunteer/... ./pkg/jarvisrecall/... -v -count=1 -timeout 60s
```
Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: final integration verification after OpenRouter migration"
```

---
