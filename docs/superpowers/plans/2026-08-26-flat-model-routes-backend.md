# Flat Model Routes — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the run route an exact `{runtime, model}` pin — model *lists* sourced from the installed harnesses (pi/opencode enumerate, claude/codex derive) with free-form ids always accepted, cached 30 min server-side with a manual refresh RPC, and the orchestrator's escalate re-queueing a failed task on any model the human picks (one judged hop).

**Architecture:** `pkg/runroute` becomes the catalog authority: `Resolve(pin)` takes a model path (namespace-validated) alongside today's byte-identical legacy tier path; new `pkg/runroute/catalog.go` enumerates/derives model lists per runtime with a TTL cache and degrades to free-form-only on probe failure. `wshrpc` gains `RefreshRouteCatalogCommand` and a `RouteCapabilityInfo` shape carrying `model/provider/contexthint/default`. The DAG planner serializes the flat catalog as allowed routes; `escalate` carries a target (runtime, model) and drops `nextTier`. `consult` tiering and openrouter headless are untouched.

**Tech Stack:** Go 1.24+, existing `pkg/waveobj`/`pkg/wshrpc`/`pkg/runroute`/`pkg/orchestrate`/`pkg/jarvis`; `task generate` for bindings; `re` regexp, stdlib only (no TOML dep — codex config is line-scanned).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-26-flat-model-routes-design.md` — follow it; the spec's decisions are binding.
- **Route = `{runtime, model}`; tier is legacy-only fallback.** `model` wins when both set. Legacy pins must resolve byte-for-byte as today.
- **No maintained static model lists.** Lists come from the harness: pi `--list-models`, opencode `models`, claude `--help` alias line, codex `config.toml`. Any probe failure degrades that runtime to free-form-only — never block route selection.
- **Catalog cache** is in-process only, 30-minute TTL, cleared by `RefreshRouteCatalogCommand`. No on-disk persistence.
- **Presence is advisory; namespace is the hard gate.** A missing-from-catalog model is a warning, never a submit error; the harness validates at spawn.
- **Escalate = one judged hop, human-chosen model.** No automatic model switching (token-cost decision, `docs/lead-authored-task-routing-roadmap.md`). `nextTier` dies; `isHigherTier` stays only for the legacy `--tier` path.
- After changing any `pkg/wshrpc` / `pkg/waveobj` type, run `task generate` and never hand-edit generated files (`pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`).
- Typecheck FE after generate: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows).
- Go test CGO gotcha: packages importing `wstore` fail to build without sqlite-vec headers. From PowerShell: `$env:CGO_CFLAGS="-I$PWD\pkg\jarvisembed\csrc"` before `go test ./pkg/...`. `pkg/runroute` is CGO-free; orchestrate/jarvis/wshserver need the flag or `task build:backend` first.
- Repo git workflow: **do not commit per task.** Stage with `git add <files>` at each task's end; the plan's final task batches everything into one commit after showing the diff summary and getting approval. Do not add co-author lines.
- Comments explain "why", never "what"; lowercase; minimal. No emojis.

---

### Task 1: Model fields on RoutePin / Run / RunSpec + binding regeneration

**Files:**
- Modify: `pkg/waveobj/wtype.go` (RoutePin ~line 240, Run ~line 258, RunSpec ~line 322)
- Create: `pkg/waveobj/routemodel_test.go`
- Generated (do not hand-edit): `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`

**Interfaces:**
- Produces: `waveobj.RoutePin{ Runtime string; Tier string; Model string }` (`json:"model,omitempty"`), `waveobj.Run.Model string` (`json:"model,omitempty"`), `waveobj.RunSpec.Model string` (`json:"model,omitempty"`). All additive — no SQL migration. Later tasks build on `pin.Model`.

- [ ] **Step 1: Write the failing JSON-contract test**

Create `pkg/waveobj/routemodel_test.go`:

```go
package waveobj

import (
	"encoding/json"
	"testing"
)

func TestRoutePinModelJSONRoundTrip(t *testing.T) {
	pin := RoutePin{Runtime: "pi", Tier: "", Model: "opencode/deepseek-v4-pro"}
	raw, err := json.Marshal(pin)
	if err != nil {
		t.Fatal(err)
	}
	var got RoutePin
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Model != pin.Model || got.Runtime != pin.Runtime {
		t.Fatalf("round trip mismatch: %+v", got)
	}
}

func TestRoutePinModelOmitEmpty(t *testing.T) {
	raw, _ := json.Marshal(RoutePin{Runtime: "claude", Tier: "capable"})
	if string(raw) != `{"runtime":"claude","tier":"capable"}` {
		t.Fatalf("empty model must be omitted, got %s", raw)
	}
}

func TestRunModelOmitEmpty(t *testing.T) {
	r := Run{Runtime: "pi", Model: "opencode/deepseek-v4-flash", Status: "executing"}
	raw, _ := json.Marshal(r)
	if !json.Valid(raw) {
		t.Fatalf("run must marshal with model set: %s", raw)
	}
	var got Run
	if json.Unmarshal(raw, &got) != nil || got.Model != r.Model {
		t.Fatalf("run model round trip failed: %+v", got)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./pkg/waveobj/ -run TestRoutePinModel -v`
Expected: compile error — `RoutePin` has no field `Model`.

- [ ] **Step 3: Add the fields**

In `pkg/waveobj/wtype.go`:

```go
type RoutePin struct {
	Runtime string `json:"runtime"`
	Tier    string `json:"tier"`
	Model   string `json:"model,omitempty"` // exact model id; empty means resolve Tier. model wins over tier
}
```

In `type Run struct` (next to `Tier`):

```go
	Model       string          `json:"model,omitempty"` // exact model id override (flat route); empty means tier
```

In `type RunSpec struct`:

```go
	Runtime string `json:"runtime,omitempty"` // harness; empty = run default
	Tier    string `json:"tier,omitempty"`
	Model   string `json:"model,omitempty"` // exact model id; empty = tier/default
	Mode    string `json:"mode,omitempty"`  // quick | pipeline | orchestrator
	Goal    string `json:"goal,omitempty"`  // per-task goal; empty = task label
```

- [ ] **Step 4: Regenerate bindings and verify the build**

Run: `task generate`
Expected: diffs appear in `frontend/types/gotypes.d.ts` (`RoutePin.model?: string;` and `Run.model?: string;` and `RunSpec.model?: string;`), `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`. Nothing else.

Then:
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (baseline is clean — any error is yours).

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./pkg/waveobj/ -run "TestRoutePinModel|TestRunModel" -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Stage**

```bash
git add pkg/waveobj/wtype.go pkg/waveobj/routemodel_test.go frontend/types/gotypes.d.ts pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts
# no commit — repo batches at the end (see Global Constraints)
```

---

### Task 2: runroute model-pin resolution + namespace validation

**Files:**
- Modify: `pkg/runroute/runroute.go`
- Modify: `pkg/runroute/runroute_test.go`

**Interfaces:**
- Consumes: `waveobj.RoutePin.Model` from Task 1.
- Produces: `runroute.Capability` gains `Model`, `Provider`, `ContextHint`, `Default string/bool` fields (json: `model,omitempty`, `provider,omitempty`, `contexthint,omitempty`, `default,omitempty`); `Tier` becomes `string` with `json:"tier,omitempty"`. `Resolve(pin waveobj.RoutePin) (Capability, error)`: `pin.Model != ""` → model path (namespace-validated, `ModelArgs ["--model", id]`, `ResolvedModel = id`); else → legacy table path, **byte-identical behavior**. New helpers: `modelNamespaceValid(runtime, model string) bool`, `modelArgsFor(runtime, model string) []string`, `resolveModelPin(pin waveobj.RoutePin) (Capability, error)`. `IsValid` now keyed on model or tier.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/runroute/runroute_test.go`:

```go
func TestResolveModelPinClaudeAlias(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "claude", Model: "opus[1m]"})
	if err != nil {
		t.Fatal(err)
	}
	if cap.ResolvedModel != "opus[1m]" || !slices.Equal(cap.ModelArgs, []string{"--model", "opus[1m]"}) {
		t.Fatalf("claude alias pin resolved wrong: %+v", cap)
	}
}

func TestResolveModelPinPiProviderID(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"})
	if err != nil {
		t.Fatal(err)
	}
	if cap.Model != "opencode/deepseek-v4-pro" || cap.ResolvedModel != "opencode/deepseek-v4-pro" {
		t.Fatalf("pi provider pin resolved wrong: %+v", cap)
	}
}

func TestResolveModelPinOpenCode(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "opencode", Model: "openai/gpt-5.4"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cap.ModelArgs, []string{"--model", "openai/gpt-5.4"}) {
		t.Fatalf("opencode args wrong: %+v", cap.ModelArgs)
	}
}

func TestResolveModelPinCodex(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "codex", Model: "gpt-5.6-sol"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cap.ModelArgs, []string{"--model", "gpt-5.6-sol"}) {
		t.Fatalf("codex args wrong: %+v", cap.ModelArgs)
	}
}

func TestResolveRejectsCrossRuntimeNamespace(t *testing.T) {
	for _, pin := range []waveobj.RoutePin{
		{Runtime: "claude", Model: "gpt-5.4"},           // openai id in claude
		{Runtime: "opencode", Model: "deepseek-v4-pro"}, // bare id, opencode requires provider/
		{Runtime: "codex", Model: "opus"},               // claude alias in codex
		{Runtime: "pi", Model: "has space/deepseek"},    // whitespace reject
	} {
		if _, err := Resolve(pin); err == nil {
			t.Errorf("expected reject for %+v", pin)
		}
	}
}

func TestResolveModelWinsOverTier(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "pi", Tier: "cheap", Model: "opencode/claude-opus-4-8"})
	if err != nil {
		t.Fatal(err)
	}
	if cap.Model != "opencode/claude-opus-4-8" {
		t.Fatalf("model must win over tier: %+v", cap)
	}
}

// legacy path must stay byte-identical: every pinned tier resolves to the same model+args as today.
func TestResolveLegacyTableUnchanged(t *testing.T) {
	for _, pin := range []waveobj.RoutePin{
		{Runtime: "pi", Tier: "cheap"}, {Runtime: "pi", Tier: "mid"}, {Runtime: "pi", Tier: "capable"},
		{Runtime: "claude", Tier: "cheap"}, {Runtime: "claude", Tier: "mid"}, {Runtime: "claude", Tier: "capable"},
		{Runtime: "codex", Tier: "capable"}, {Runtime: "opencode", Tier: "capable"},
	} {
		cap, err := Resolve(pin)
		if err != nil {
			t.Fatalf("legacy %+v: %v", pin, err)
		}
		if cap.Model != "" {
			t.Fatalf("legacy pin must not set Model: %+v", cap)
		}
	}
}

func TestIsValidModelCapability(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-flash"})
	if err != nil {
		t.Fatal(err)
	}
	if !IsValid(cap) {
		t.Fatal("resolved model capability must be valid")
	}
	forged := cap
	forged.ModelArgs = []string{"--model", "not-the-resolved-model"}
	if IsValid(forged) {
		t.Fatal("forged ModelArgs must be rejected")
	}
}
```

(The four cases above each fail their runtime's namespace rule: cross-runtime ids, provider-less opencode ids, claude aliases in codex, and whitespace. Keep this list in sync with `modelNamespaceValid`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/runroute/ -run "TestResolveModel|TestResolveRejects|TestResolveLegacy|TestResolveModelWins|TestIsValidModel" -v`
Expected: FAIL — `Resolve` has no model path / `Capability` has no `Model` field.

- [ ] **Step 3: Implement the model path**

In `pkg/runroute/runroute.go`, change `Capability` and add the model path:

```go
type Capability struct {
	Runtime       string   `json:"runtime"`
	Tier          string   `json:"tier,omitempty"`       // legacy tier pin only; "" for model pins
	Model         string   `json:"model,omitempty"`      // set on model pins; "" for legacy tier pins
	ResolvedModel string   `json:"resolvedmodel"`
	Provider      string   `json:"provider,omitempty"`   // catalog metadata, informational
	ContextHint   string   `json:"contexthint,omitempty"` // catalog metadata, informational
	Default       bool     `json:"default,omitempty"`    // catalog metadata: the harness's own default model
	ModelArgs     []string `json:"-"`
}
```

Replace `Resolve` with a model-aware dispatcher (keep the legacy loop below it):

```go
func Resolve(pin waveobj.RoutePin) (Capability, error) {
	if pin.Model != "" {
		return resolveModelPin(pin)
	}
	return resolveLegacyTier(pin)
}

func resolveLegacyTier(pin waveobj.RoutePin) (Capability, error) {
	for _, capability := range capabilityTable {
		if capability.Runtime == pin.Runtime && string(capability.Tier) == pin.Tier {
			return clone(capability), nil
		}
	}
	return Capability{}, fmt.Errorf("unsupported route runtime %q tier %q", pin.Runtime, pin.Tier)
}

func resolveModelPin(pin waveobj.RoutePin) (Capability, error) {
	if pin.Runtime == "" {
		return Capability{}, fmt.Errorf("model route requires a runtime")
	}
	if !modelNamespaceValid(pin.Runtime, pin.Model) {
		return Capability{}, fmt.Errorf("model %q is not a valid %s model id", pin.Model, pin.Runtime)
	}
	return Capability{
		Runtime:       pin.Runtime,
		Model:         pin.Model,
		ResolvedModel: pin.Model,
		ModelArgs:     modelArgsFor(pin.Runtime, pin.Model),
	}, nil
}

// modelNamespaceValid is the hard submit gate. Presence in the catalog is advisory (the harness is
// the ultimate validator at spawn); namespace membership is deterministic and cheap.
func modelNamespaceValid(runtime, model string) bool {
	switch runtime {
	case "claude":
		return claudeAliasRe.MatchString(model) || claudeFullRe.MatchString(model)
	case "pi":
		return providerModelRe.MatchString(model) || piBareRe.MatchString(model)
	case "opencode":
		return providerModelRe.MatchString(model)
	case "codex":
		return codexSafe(model)
	}
	return false
}

func modelArgsFor(runtime, model string) []string {
	switch runtime {
	case "claude", "codex", "opencode", "pi":
		return []string{"--model", model}
	}
	return nil
}
```

Update `IsValid`:

```go
func IsValid(capability Capability) bool {
	resolved, err := Resolve(waveobj.RoutePin{Runtime: capability.Runtime, Tier: capability.Tier, Model: capability.Model})
	return err == nil && resolved.ResolvedModel == capability.ResolvedModel && slices.Equal(resolved.ModelArgs, capability.ModelArgs)
}
```

Update the `capabilityTable` rows so legacy capabilities carry `Tier` as a plain string (the `Tier consult.Tier` field type change is absorbed by `C`):

```go
var capabilityTable = []Capability{
	{Runtime: "pi", Tier: string(consult.TierCheap), ResolvedModel: consult.PiCheapModel, ModelArgs: []string{"--model", consult.PiCheapModel}},
	{Runtime: "pi", Tier: string(consult.TierMid), ResolvedModel: consult.PiMidModel, ModelArgs: []string{"--model", consult.PiMidModel}},
	{Runtime: "pi", Tier: string(consult.TierCapable), ResolvedModel: consult.PiMidModel, ModelArgs: []string{"--model", consult.PiMidModel}},
	{Runtime: "claude", Tier: string(consult.TierCheap), ResolvedModel: consult.CheapModel, ModelArgs: []string{"--model", consult.CheapModel}},
	{Runtime: "claude", Tier: string(consult.TierMid), ResolvedModel: consult.MidModel, ModelArgs: []string{"--model", consult.MidModel}},
	{Runtime: "claude", Tier: string(consult.TierCapable), ResolvedModel: operatorDefault},
	{Runtime: "codex", Tier: string(consult.TierCapable), ResolvedModel: operatorDefault},
	{Runtime: "opencode", Tier: string(consult.TierCapable), ResolvedModel: operatorDefault},
}
```

Add the namespace regexes at the top of `runroute.go` (next to `operatorDefault`):

```go
import "regexp"

var (
	claudeAliasRe    = regexp.MustCompile(`^(opus|sonnet|haiku|fable|best)(\[[0-9]+m\])?$`)
	claudeFullRe     = regexp.MustCompile(`^claude-[a-zA-Z0-9-]+$`)
	providerModelRe  = regexp.MustCompile(`^[a-zA-Z0-9_-]+/[a-zA-Z0-9._:+-]+$`)
	piBareRe         = regexp.MustCompile(`^[a-zA-Z0-9._:+-]+$`)
	codexForbiddenRe = regexp.MustCompile(`[\s;&|` + "`" + `$<>'"]`)
)

func codexSafe(model string) bool {
	if model == "" {
		return false
	}
	return !codexForbiddenRe.MatchString(model)
}
```

(`regexp` joins the package imports. The `` ` `` inside the character class is escaped by string concatenation — keep that exact form so gofmt/`go vet` are happy.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/runroute/ -v`
Expected: PASS — both the new model tests and the pre-existing legacy suite (`TestCapabilities`, `TestNormalizeLegacy`, …).

- [ ] **Step 5: Stage**

```bash
git add pkg/runroute/runroute.go pkg/runroute/runroute_test.go
```

---

### Task 3: Harness-sourced model catalog + parsing

**Files:**
- Create: `pkg/runroute/catalog.go`
- Create: `pkg/runroute/catalog_test.go`

**Interfaces:**
- Consumes: `modelNamespaceValid` (not required by catalog); `harness` model not needed (runtime strings only).
- Produces:
  - `type ModelEntry struct { Runtime, Model, Provider, ContextHint string; Default bool }`
  - `var catalogCommand = func(ctx context.Context, bin string, args ...string) ([]byte, error)` — exec seam, defaults to `exec.CommandContext(...).CombinedOutput()`
  - `func enumerateCatalog(ctx context.Context, runtime string) ([]ModelEntry, error)` — per-runtime dispatch
  - `fn enumeratePi(ctx)/enumerateOpenCode(ctx)/enumerateClaude(ctx)/enumerateCodex(ctx)`
  - `func parseCodexConfig(raw string) ([]ModelEntry, error)` (exported for tests)
  - `const catalogProbeTimeout = 15 * time.Second`
  - Empty/error catalog means **free-form-only** for that runtime (module-level contract for Task 4's cache).

- [ ] **Step 1: Write the failing parse tests**

Create `pkg/runroute/catalog_test.go` — fixtures below are captured from the actual installed CLIs (2026-08-26):

```go
package runroute

import (
	"context"
	"testing"
)

const piListModelsFixture = `provider      model                            context  max-out  thinking  images
openai-codex  gpt-5.3-codex-spark              128K     128K     yes       no
openai-codex  gpt-5.6-sol                      272K     128K     yes       yes
opencode      claude-opus-4-8                  1M       128K     yes       yes
opencode      deepseek-v4-pro                  1M       384K     yes       no
`

const opencodeModelsFixture = `opencode/big-pickle
opencode/deepseek-v4-flash
opencode/deepseek-v4-pro
openai/gpt-5.4
openai/gpt-5.4-fast
`

const claudeHelpFixture = `Usage: claude [options]

Options:
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
`

const codexConfigFixture = `model = "gpt-5.6-sol"
model_reasoning_effort = "medium"

[profiles.fast]
model = "gpt-5.4-mini"

[profiles.coding]
model = "gpt-5.3-codex"
`

func TestParsePiTable(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(piListModelsFixture), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumeratePi(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("want 4 entries, got %d: %+v", len(entries), entries)
	}
	if entries[0].Model != "openai-codex/gpt-5.3-codex-spark" || entries[0].Provider != "openai-codex" {
		t.Fatalf("pi provider/model wrong: %+v", entries[0])
	}
	if entries[2].ContextHint != "1M" {
		t.Fatalf("context hint wrong: %+v", entries[2])
	}
}

func TestParseOpenCodeModels(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumerateOpenCode(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 5 || entries[3].Model != "openai/gpt-5.4" || entries[3].Provider != "openai" {
		t.Fatalf("opencode entries wrong: %+v", entries)
	}
}

func TestParseClaudeHelpAliases(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(claudeHelpFixture), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumerateClaude(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	models := map[string]bool{}
	for _, e := range entries {
		models[e.Model] = true
	}
	for _, alias := range []string{"fable", "opus", "sonnet"} {
		if !models[alias] {
			t.Fatalf("missing claude alias %q: %+v", alias, entries)
		}
	}
}

func TestParseCodexConfig(t *testing.T) {
	entries, err := parseCodexConfig(codexConfigFixture)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("want 3 codex models, got %+v", entries)
	}
	if !entries[0].Default || entries[0].Model != "gpt-5.6-sol" {
		t.Fatalf("top-level codex model should be default: %+v", entries[0])
	}
	if entries[1].Default || entries[1].Model != "gpt-5.4-mini" {
		t.Fatalf("profile model must not be default: %+v", entries[1])
	}
}

func TestEnumerateDegradesOnGarbage(t *testing.T) {
	orig := catalogCommand
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("this is not a model table\n"), nil
	}
	defer func() { catalogCommand = orig }()

	entries, err := enumeratePi(context.Background())
	if err != nil {
		t.Fatalf("garbage should degrade with an error, not panic: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("garbage must yield zero entries (free-form-only): %+v", entries)
	}
	// error must be returned when nothing parses
	if _, err := enumerateCatalog(context.Background(), "pi"); err == nil {
		t.Fatal("empty-catalog enumerator must report the failure")
	}
}

func TestEnumerateUnknownRuntime(t *testing.T) {
	if _, err := enumerateCatalog(context.Background(), "nope"); err == nil {
		t.Fatal("unknown runtime must error")
	}
}
```

Drop the trailing `var _ = reflect.DeepEqual` line and the `reflect` import — neither is used by these tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/runroute/ -run "TestParse|TestEnumerate" -v`
Expected: FAIL — `catalogCommand`, `enumeratePi`, etc. undefined.

- [ ] **Step 3: Implement `pkg/runroute/catalog.go`**

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package runroute

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ModelEntry is one selectable model for a runtime, sourced from the harness itself: enumerated
// (pi, opencode), derived from the harness's own surface (claude --help aliases, codex config), or
// free-form (accepted everywhere, never listed here). Never a maintained static catalog.
type ModelEntry struct {
	Runtime     string
	Model       string // exact id handed to the harness; pi/opencode include the provider prefix
	Provider    string // pi: provider column; opencode: id prefix; else ""
	ContextHint string // pi: context column; else ""
	Default     bool   // the harness's own configured default (claude settings.json / codex config.toml)
}

// catalogCommand is the exec seam; tests replace it to feed fixtures and count calls.
var catalogCommand = func(ctx context.Context, bin string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, bin, args...).CombinedOutput()
}

const catalogProbeTimeout = 15 * time.Second

var modelLineRe = regexp.MustCompile(`^([a-zA-Z0-9_-]+)/(.+)$`)

func enumerateCatalog(ctx context.Context, runtime string) ([]ModelEntry, error) {
	switch runtime {
	case "pi":
		return enumeratePi(ctx)
	case "opencode":
		return enumerateOpenCode(ctx)
	case "claude":
		return enumerateClaude(ctx)
	case "codex":
		return enumerateCodex(ctx)
	}
	return nil, fmt.Errorf("no catalog source for runtime %q", runtime)
}

func enumeratePi(ctx context.Context) ([]ModelEntry, error) {
	out, err := catalogCommand(ctx, "pi", "--list-models")
	if err != nil {
		return nil, err
	}
	var entries []ModelEntry
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] == "provider" {
			continue // header or blank
		}
		contextHint := ""
		if len(fields) >= 3 {
			contextHint = fields[2]
		}
		entries = append(entries, ModelEntry{Runtime: "pi", Provider: fields[0], Model: fields[0] + "/" + fields[1], ContextHint: contextHint})
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("pi --list-models returned no parseable models")
	}
	return entries, nil
}

func enumerateOpenCode(ctx context.Context) ([]ModelEntry, error) {
	out, err := catalogCommand(ctx, "opencode", "models")
	if err != nil {
		return nil, err
	}
	var entries []ModelEntry
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		m := modelLineRe.FindStringSubmatch(line)
		if m == nil {
			continue // opencode prints provider/model ids; anything else is noise or a header
		}
		entries = append(entries, ModelEntry{Runtime: "opencode", Provider: m[1], Model: line})
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("opencode models returned no parseable models")
	}
	return entries, nil
}

// enumerateClaude derives the alias set from `claude --help` — aliases are stable by design so this
// never rots, and full dated ids ride the free-form path instead of a shipped list.
func enumerateClaude(ctx context.Context) ([]ModelEntry, error) {
	out, err := catalogCommand(ctx, "claude", "--help")
	if err != nil {
		return nil, err
	}
	var entries []ModelEntry
	aliasRe := regexp.MustCompile(`'([a-zA-Z0-9]+)'`)
	lines := strings.Split(string(out), "\n")
	for i, line := range lines {
		if !strings.Contains(line, "--model") {
			continue
		}
		joined := strings.Join(lines[i:min(i+3, len(lines))], " ")
		seen := map[string]bool{}
		for _, m := range aliasRe.FindAllStringSubmatch(joined, -1) {
			if !seen[m[1]] {
				seen[m[1]] = true
				entries = append(entries, ModelEntry{Runtime: "claude", Model: m[1]})
			}
		}
		break
	}
	if defaultModel := claudeSettingsDefault(); defaultModel != "" {
		entries = append([]ModelEntry{{Runtime: "claude", Model: defaultModel, Default: true}}, entries...)
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("claude --help exposed no model aliases")
	}
	return entries, nil
}

// claudeSettingsDefault reads the operator's own model choice from ~/.claude/settings.json, the
// same file claude reads — that is the "CLI default" picker row.
func claudeSettingsDefault() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return ""
	}
	return strings.TrimSpace(cfg.Model)
}

func enumerateCodex(ctx context.Context) ([]ModelEntry, error) {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = home
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".codex", "config.toml"))
	if err != nil {
		return nil, err
	}
	entries, err := parseCodexConfig(string(raw))
	if err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("codex config.toml has no model")
	}
	return entries, nil
}

// parseCodexConfig line-scans the operator's config for `model = "…"` values — top-level is the
// active default, [profiles.*] entries are named alternates. A hand parser is enough; adding a TOML
// dependency for one key would be over-engineering.
func parseCodexConfig(raw string) ([]ModelEntry, error) {
	modelRe := regexp.MustCompile(`^\s*model\s*=\s*["']([^"']+)["']\s*$`)
	var entries []ModelEntry
	inSection := false
	topLevelSeen := false
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") {
			inSection = true
			continue
		}
		m := modelRe.FindStringSubmatch(trimmed)
		if m == nil {
			continue
		}
		def := !inSection && !topLevelSeen
		if !inSection {
			topLevelSeen = true
		}
		entries = append(entries, ModelEntry{Runtime: "codex", Model: m[1], Default: def})
	}
	return entries, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

Note: `go.mod` declares `go 1.25.6` — the `min`/`max` builtins exist, so **drop the trailing `func min`** defined in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/runroute/ -v`
Expected: PASS (all parse + degrade + legacy tests).

- [ ] **Step 5: Stage**

```bash
git add pkg/runroute/catalog.go pkg/runroute/catalog_test.go
```

---

### Task 4: Catalog cache (30-min TTL) + RefreshRouteCatalogCommand RPC

**Files:**
- Modify: `pkg/runroute/catalog.go` (cache + seams)
- Modify: `pkg/runroute/catalog_test.go` (cache tests)
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (interface + generated bindings)
- Create: `pkg/wshrpc/wshserver/wshserver_routecatalog_test.go`

**Interfaces:**
- Consumes: `ModelEntry`, `enumerateCatalog`, `catalogCommand` (Task 3).
- Produces:
  - `func ModelsForRuntime(ctx context.Context, runtime string) []ModelEntry` — cached (TTL 30 min, `nowFn` clock seam, returns a copy); on probe failure keeps stale cache if any, else empty (free-form-only).
  - `func RefreshRouteCatalog()`
  - `func CatalogHasModel(ctx context.Context, runtime, model string) bool` — presence check for advisory warnings.
  - `wshrpc.JarvisCommands.RefreshRouteCatalogCommand(ctx context.Context) error` + `WshServer` implementation.

- [ ] **Step 1: Write the failing cache tests**

Append to `pkg/runroute/catalog_test.go`:

```go
func TestCatalogCacheWithinTTL(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	calls := 0
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		calls++
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatalf("first fetch: want 5 entries, got %d", len(got))
	}
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatalf("second fetch must hit cache")
	}
	if calls != 1 {
		t.Fatalf("enumerated %d times, want 1 (cache hit)", calls)
	}
}

func TestCatalogCacheExpires(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	ModelsForRuntime(context.Background(), "opencode")
	nowFn = func() time.Time { return time.Unix(1000, 30*60+1, 0) }
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatal("expired cache must re-enumerate")
	}
}

func TestRefreshRouteCatalogClears(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	ModelsForRuntime(context.Background(), "opencode")
	RefreshRouteCatalog()
	calls := 0
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		calls++
		return []byte(opencodeModelsFixture), nil
	}
	ModelsForRuntime(context.Background(), "opencode")
	if calls != 1 {
		t.Fatalf("refresh must force a re-enumeration, got %d calls", calls)
	}
}

func TestCatalogKeepsStaleOnProbeFailure(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	ModelsForRuntime(context.Background(), "opencode")
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return nil, fmt.Errorf("cli vanished")
	}
	nowFn = func() time.Time { return time.Unix(1000, 60*60, 0) }
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 5 {
		t.Fatalf("stale cache must survive a probe failure, got %d", len(got))
	}
	nowFn = func() time.Time { return time.Unix(1000, 61*60, 0) }
	_ = ModelsForRuntime(context.Background(), "opencode")
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("garbage\n"), nil
	}
	if got := ModelsForRuntime(context.Background(), "opencode"); len(got) != 0 {
		t.Fatalf("garbage with no stale cache must yield free-form-only, got %d", len(got))
	}
}

func TestCatalogHasModel(t *testing.T) {
	origCmd, origNow := catalogCommand, nowFn
	catalogCommand = func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte(opencodeModelsFixture), nil
	}
	nowFn = func() time.Time { return time.Unix(1000, 0) }
	defer func() { catalogCommand, nowFn = origCmd, origNow }()

	if !CatalogHasModel(context.Background(), "opencode", "openai/gpt-5.4") {
		t.Fatal("listed model must be present")
	}
	if CatalogHasModel(context.Background(), "opencode", "does/not-exist") {
		t.Fatal("unlisted model must be absent")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/runroute/ -run "TestCatalog" -v`
Expected: FAIL — `ModelsForRuntime`/`nowFn`/`RefreshRouteCatalog` undefined.

- [ ] **Step 3: Implement the cache**

Append to `pkg/runroute/catalog.go`:

```go
// In-process catalog cache: model lists rotate slowly, probe spawns are not free, and repeated
// ListHarnesses calls (every picker open / launch compose) must not re-run three CLIs per open.
// Manual refresh busts it; there is deliberately no on-disk persistence — re-deriving at boot is
// cheap and a file cache would only add staleness.

type catalogEntry struct {
	models  []ModelEntry
	fetched time.Time
}

var (
	catalogMu    sync.Mutex
	catalogCache = map[string]catalogEntry{}
	nowFn        = time.Now // clock seam for tests
)

const catalogTTL = 30 * time.Minute

func ModelsForRuntime(ctx context.Context, runtime string) []ModelEntry {
	catalogMu.Lock()
	defer catalogMu.Unlock()
	return modelsForRuntimeLocked(ctx, runtime)
}

func modelsForRuntimeLocked(ctx context.Context, runtime string) []ModelEntry {
	if entry, ok := catalogCache[runtime]; ok && nowFn().Sub(entry.fetched) < catalogTTL {
		return append([]ModelEntry(nil), entry.models...)
	}
	models, err := enumerateCatalog(ctx, runtime)
	if err != nil {
		if entry, ok := catalogCache[runtime]; ok {
			return append([]ModelEntry(nil), entry.models...) // stale over none
		}
		return nil // free-form-only
	}
	catalogCache[runtime] = catalogEntry{models: models, fetched: nowFn()}
	return append([]ModelEntry(nil), models...)
}

func RefreshRouteCatalog() {
	catalogMu.Lock()
	defer catalogMu.Unlock()
	catalogCache = map[string]catalogEntry{}
}

// CatalogHasModel reports presence in the cached catalog. Advisory only: callers downgrade a miss
// to a warning — the cache can be stale and the harness validates at spawn.
func CatalogHasModel(ctx context.Context, runtime, model string) bool {
	for _, entry := range modelsForRuntimeLocked(ctx, runtime) {
		if entry.Model == model {
			return true
		}
	}
	return false
}
```

Add `"sync"` to the imports in `catalog.go`.

- [ ] **Step 4: Add the RPC + server method + regenerate**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, inside the `JarvisCommands` interface (next to `ListHarnessesCommand`):

```go
	// RefreshRouteCatalogCommand clears the cached run-route model catalog; the next
	// ListHarnessesCommand re-enumerates from the installed harnesses.
	RefreshRouteCatalogCommand(ctx context.Context) error
```

In `pkg/wshrpc/wshserver/wshserver_jarvis.go` (any method block):

```go
func (ws *WshServer) RefreshRouteCatalogCommand(ctx context.Context) error {
	runroute.RefreshRouteCatalog()
	return nil
}
```

Check `wshserver_jarvis.go` already imports `runroute` (it does — `routeCapabilitiesForProbe` uses it); if not, add the import.

Run: `task generate`
Expected: `pkg/wshrpc/wshclient/wshclient.go` gains `RefreshRouteCatalogCommand(client, opts)`; `frontend/app/store/wshclientapi.ts` gains the matching client method.

- [ ] **Step 5: Server-level test**

Create `pkg/wshrpc/wshserver/wshserver_routecatalog_test.go`:

```go
package wshserver

import (
	"context"
	"testing"
)

func TestRefreshRouteCatalogCommandReturnsNil(t *testing.T) {
	ws := &WshServer{}
	if err := ws.RefreshRouteCatalogCommand(context.Background()); err != nil {
		t.Fatalf("refresh must succeed: %v", err)
	}
}
```

Run: `go test ./pkg/wshrpc/wshserver/ -run TestRefreshRouteCatalog -v` (needs `CGO_CFLAGS`/`task build:backend` first — see Global Constraints).
Expected: PASS.

- [ ] **Step 6: Run the full suite and stage**

Run: `go test ./pkg/runroute/ ./pkg/wshrpc/wshserver/ -run "TestCatalog|TestRefreshRouteCatalog|TestListHarnesses" -v`
Expected: PASS.

```bash
git add pkg/runroute/catalog.go pkg/runroute/catalog_test.go pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_routecatalog_test.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

### Task 5: Capability shape + ListHarnesses + planner catalog wiring

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_jarvis.go` (`RouteCapabilityInfo`)
- Modify: `pkg/wshrpc/wshserver/wshserver_jarvis.go` (`ListHarnessesCommand`, `installedRunWorkerPins`, new `catalogPresenceWarnings`)
- Modify: `pkg/jarvis/plandag.go` (model-aware warning label)
- Modify: `pkg/jarvis/plandag_test.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_harness_test.go`
- Create: `pkg/wshrpc/wshserver/wshserver_jarvis_catalog_test.go`

**Interfaces:**
- Consumes: `ModelsForRuntime`, `CatalogHasModel`, `RefreshRouteCatalog` (Task 4); `ModelEntry` (Task 3).
- Produces:
  - `wshrpc.RouteCapabilityInfo{ Runtime, Tier, Model, ResolvedModel, Provider, ContextHint string; Default bool }` (json: `runtime`, `tier,omitempty`, `model,omitempty`, `resolvedmodel`, `provider,omitempty`, `contexthint,omitempty`, `default,omitempty`).
  - `ListHarnessesCommand` now returns **legacy tier capabilities unchanged** (so persisted tier pins keep rendering) **plus** one capability per catalog entry for the runtime.
  - `catalogPresenceWarnings(draft jarvis.DagPlanDraft) []string` — advisory warnings for task pins whose model is missing from the catalog.
  - `installedRunWorkerPins(ctx, results)` — flat-catalog model pins for the planner (no legacy tiers).

- [ ] **Step 1: Write the failing tests**

Extend `pkg/wshrpc/wshserver/wshserver_harness_test.go` — read the existing `TestListHarnessesAddsRouteCapabilitiesOnlyForAvailableWorkers` first and keep its assertions; add a catalog-stub case. The harness tests already stub `probeHarnesses`; add a `catalogCommand` stub for the runroute enumerator (the wshserver test package can reach the runroute seam because both are packages in this module — import `github.com/wavetermdev/waveterm/pkg/runroute`):

```go
func TestListHarnessesAddsCatalogModelCapabilities(t *testing.T) {
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("provider model context\nopencode deepseek-v4-pro 1M\n"), nil
	})()
	// probe stubs: pi installed + run-worker-capable (mirror the existing test's stub pattern)
	ws := &WshServer{}
	rtn, err := ws.ListHarnessesCommand(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var piCap *wshrpc.RouteCapabilityInfo
	for i := range rtn.Harnesses {
		h := &rtn.Harnesses[i]
		if h.Runtime != "pi" {
			continue
		}
		for j := range h.RouteCapabilities {
			if h.RouteCapabilities[j].Model == "opencode/deepseek-v4-pro" {
				piCap = &h.RouteCapabilities[j]
			}
		}
	}
	if piCap == nil {
		t.Fatalf("pi must expose a catalog model capability: %+v", rtn.Harnesses)
	}
	if piCap.ResolvedModel != "opencode/deepseek-v4-pro" {
		t.Fatalf("resolvedmodel must equal the model: %+v", piCap)
	}
}
```

Create `pkg/wshrpc/wshserver/wshserver_jarvis_catalog_test.go`:

```go
package wshserver

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestCatalogPresenceWarnings(t *testing.T) {
	defer runroute.SetCatalogCommandForTest(func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("provider model\nopencode deepseek-v4-pro\n"), nil
	})()
	draft := jarvis.DagPlanDraft{Tasks: []jarvis.DagPlanTask{
		{ID: "t-1"},
		{ID: "t-2", Route: &waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}},
		{ID: "t-3", Route: &waveobj.RoutePin{Runtime: "pi", Model: "not/in/catalog"}},
	}}
	warnings := catalogPresenceWarnings(draft)
	if len(warnings) != 1 {
		t.Fatalf("want one presence warning, got %+v", warnings)
	}
	if !strings.Contains(warnings[0], "t-3") || !strings.Contains(warnings[0], "not/in/catalog") {
		t.Fatalf("warning must name the task and model: %q", warnings[0])
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/wshrpc/wshserver/ -run "TestListHarnesses|TestCatalogPresence" -v`
Expected: FAIL — `catalogPresenceWarnings` undefined, `RouteCapabilityInfo.Model` missing, `SetCatalogCommandForTest` missing.

- [ ] **Step 3: Add the runroute test seam**

In `pkg/runroute/catalog.go`, add the test-only seam setter (production callers never touch it):

```go
// SetCatalogCommandForTest replaces the exec seam so wshserver tests feed deterministic
// catalog fixtures without spawning real CLIs. Returns a restore func.
func SetCatalogCommandForTest(fn func(ctx context.Context, bin string, args ...string) ([]byte, error)) func() {
	orig := catalogCommand
	catalogCommand = fn
	return func() { catalogCommand = orig }
}
```

- [ ] **Step 4: Implement — wshrpc shape**

In `pkg/wshrpc/wshrpctypes_jarvis.go`, change `RouteCapabilityInfo`:

```go
type RouteCapabilityInfo struct {
	Runtime       string `json:"runtime"`
	Tier          string `json:"tier,omitempty"`       // legacy tier pin only; "" for model capabilities
	Model         string `json:"model,omitempty"`      // exact model id; set on catalog capabilities
	ResolvedModel string `json:"resolvedmodel"`
	Provider      string `json:"provider,omitempty"`
	ContextHint   string `json:"contexthint,omitempty"`
	Default       bool   `json:"default,omitempty"`
}
```

- [ ] **Step 5: Implement — wshserver wiring**

In `pkg/wshrpc/wshserver/wshserver_jarvis.go`, rewrite `ListHarnessesCommand`'s capability loop:

```go
		capabilities := []wshrpc.RouteCapabilityInfo{}
		for _, capability := range routeCapabilitiesForProbe(r) {
			capabilities = append(capabilities, wshrpc.RouteCapabilityInfo{
				Runtime:       capability.Runtime,
				Tier:          capability.Tier,
				ResolvedModel: capability.ResolvedModel,
			})
		}
		for _, entry := range runroute.ModelsForRuntime(ctx, r.Spec.Runtime) {
			capabilities = append(capabilities, wshrpc.RouteCapabilityInfo{
				Runtime:       entry.Runtime,
				Model:         entry.Model,
				ResolvedModel: entry.Model,
				Provider:      entry.Provider,
				ContextHint:   entry.ContextHint,
				Default:       entry.Default,
			})
		}
```

Change `installedRunWorkerPins` to take the request ctx and emit catalog model pins only (the planner sees the flat catalog, never the legacy tiers):

```go
func installedRunWorkerPins(ctx context.Context, results []harness.ProbeResult) []waveobj.RoutePin {
	var pins []waveobj.RoutePin
	for _, result := range results {
		if !result.Installed || !result.Spec.RunWorkerCapable {
			continue
		}
		for _, entry := range runroute.ModelsForRuntime(ctx, result.Spec.Runtime) {
			pins = append(pins, waveobj.RoutePin{Runtime: entry.Runtime, Model: entry.Model})
		}
	}
	return pins
}
```

Update the call site in `JarvisPlanDagCommand`:

```go
	probes := probeHarnesses(ctx)
	...
		AllowedRoutes: installedRunWorkerPins(ctx, probes),
```

Add `catalogPresenceWarnings` (called right after `planDag` succeeds in `JarvisPlanDagCommand`, appended to `warnings`):

```go
// catalogPresenceWarnings flags task routes whose model is missing from the cached catalog.
// Advisory by design: the cache can be stale and a namespace-valid id may still be new to the
// provider, so these are warnings the human sees before launch, never submit errors.
func catalogPresenceWarnings(draft jarvis.DagPlanDraft) []string {
	var warnings []string
	for _, task := range draft.Tasks {
		if task.Route == nil || task.Route.Model == "" {
			continue
		}
		if !runroute.CatalogHasModel(context.Background(), task.Route.Runtime, task.Route.Model) {
			warnings = append(warnings, fmt.Sprintf("Task %s model %s is not in the current catalog; verify it before launch.", task.ID, task.Route.Model))
		}
	}
	return warnings
}
```

In `pkg/jarvis/plandag.go`, make the unavailable-route warning model-aware (helper next to `routeAllowed`):

```go
func routePinLabel(pin waveobj.RoutePin) string {
	if pin.Model != "" {
		return pin.Runtime + "/" + pin.Model
	}
	return pin.Runtime + "/" + pin.Tier
}
```

and in `ParsePlanDag` replace the warning line with:

```go
		warnings = append(warnings, fmt.Sprintf("Task %s route %s is unavailable and now inherits the Run route.", id, routePinLabel(*task.Route)))
```

- [ ] **Step 6: Update plandag tests for model pins**

In `pkg/jarvis/plandag_test.go`, adjust the fixture inputs: `AllowedRoutes` becomes model pins, and the prompt assertions now expect `{"runtime":"pi","model":"opencode/deepseek-v4-pro"}`-shaped serialization. Concretely: the `TestParsePlanDagAllowsExceptionalRoute`-style cases change their allowed route to `waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-flash"}` and the task's `Route` to the same; the invalid-route case uses a model not in the allowed list and asserts the warning text contains the new label (e.g. `route pi/not-allowed`). Keep `RunRoute` legacy-pin cases as-is to prove the legacy path still parses.

- [ ] **Step 7: Run tests + regenerate + verify**

Run: `go test ./pkg/runroute/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ -run "TestCatalog|TestParsePlan|TestListHarnesses|TestCatalogPresence" -v`
Expected: PASS.

Run: `task generate`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. `gotypes.d.ts` now shows the new `RouteCapabilityInfo` fields and `CommandDagActionData` is unchanged so far (Task 6 adds fields).

- [ ] **Step 8: Stage**

```bash
git add pkg/runroute/catalog.go pkg/wshrpc/wshrpctypes_jarvis.go pkg/wshrpc/wshserver/wshserver_jarvis.go pkg/wshrpc/wshserver/wshserver_harness_test.go pkg/wshrpc/wshserver/wshserver_jarvis_catalog_test.go pkg/jarvis/plandag.go pkg/jarvis/plandag_test.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

### Task 6: Escalate on a model + engine route passthrough + wsh CLI

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_dag.go` (`CommandDagActionData`)
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (`CommandCreateRunData`, `json:"model,omitempty"`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`CreateRunCommand` — resolve + persist `run.Model`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go:117` (`DagActionCommand` — pass the target pin to `ApplyAction`)
- Modify: `pkg/orchestrate/mutation.go` (`ApplyAction`, `applyActionLocked`, `escalationTarget`)
- Modify: `pkg/orchestrate/engine.go` (`effectiveTaskRoute`, `childRunFromSpec`)
- Modify: `pkg/orchestrate/retry.go` (delete `nextTier`; keep `isHigherTier` for the legacy tier path)
- Modify: `pkg/orchestrate/retry_test.go` (drop `nextTier` tests)
- Modify: `pkg/orchestrate/engine_test.go`, `pkg/orchestrate/mutation_test.go` (escalate model cases) — check existing names before editing
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag.go` (escalate `--model` / `--runtime` flags)
- Modify: `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

**Interfaces:**
- Consumes: `runroute.Resolve` (Task 2), `effectiveTaskRoute` (below), `waveobj.RunSpec.Model` (Task 1).
- Produces: `wshrpc.CommandDagActionData` gains `Runtime string json:"runtime,omitempty"` and `Model string json:"model,omitempty"`. `wshrpc.CommandCreateRunData` gains `Model string json:"model,omitempty"`. `orchestrate.ApplyAction(ctx, dagID, taskID, action string, target waveobj.RoutePin) error` — the fifth arg changes from a tier string to a RoutePin (target for escalate; ignored otherwise). `escalationTarget(task, owner, target waveobj.RoutePin) (waveobj.RoutePin, error)`.

- [ ] **Step 1: Write the failing tests**

In the orchestrate test package (find the existing escalate coverage in `mutation_test.go`/`engine_test.go` first and keep it), add model cases:

```go
func TestEscalationTargetModel(t *testing.T) {
	task := &waveobj.TaskNode{ID: "t-1", State: TaskState_Failed, RunSpec: waveobj.RunSpec{Runtime: "pi", Model: "opencode/deepseek-v4-flash"}}
	owner := &waveobj.Run{Runtime: "pi"}
	target, err := escalationTarget(task, owner, waveobj.RoutePin{Runtime: "claude", Model: "opus"})
	if err != nil {
		t.Fatal(err)
	}
	if target.Runtime != "claude" || target.Model != "opus" {
		t.Fatalf("cross-runtime model escalation failed: %+v", target)
	}
}

func TestEscalationTargetRequiresValidModel(t *testing.T) {
	task := &waveobj.TaskNode{ID: "t-1", State: TaskState_Failed, RunSpec: waveobj.RunSpec{Runtime: "pi"}}
	owner := &waveobj.Run{Runtime: "pi"}
	if _, err := escalationTarget(task, owner, waveobj.RoutePin{Runtime: "claude", Model: "gpt-5.4"}); err == nil {
		t.Fatal("cross-namespace model must be rejected")
	}
	if _, err := escalationTarget(task, owner, waveobj.RoutePin{}); err == nil {
		t.Fatal("empty target must be rejected")
	}
}

func TestEscalationTargetCapHolds(t *testing.T) {
	task := &waveobj.TaskNode{ID: "t-1", State: TaskState_Stalled, Escalations: 1, RunSpec: waveobj.RunSpec{Runtime: "pi"}}
	owner := &waveobj.Run{Runtime: "pi"}
	if _, err := escalationTarget(task, owner, waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}); err == nil {
		t.Fatal("escalations cap must refuse a second hop")
	}
}

func TestEffectiveTaskRouteModel(t *testing.T) {
	task := &waveobj.TaskNode{RunSpec: waveobj.RunSpec{Runtime: "", Model: "opencode/claude-opus-4-8"}}
	owner := &waveobj.Run{Runtime: "pi"}
	got := effectiveTaskRoute(task, owner)
	if got.Model != "opencode/claude-opus-4-8" || got.Runtime != "pi" {
		t.Fatalf("model RunSpec must inherit owner runtime: %+v", got)
	}
}
```

In `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`, extend the existing escalate plumbing test: assert `dagEscalateData` reads `--model`/`--runtime` into `data.Model`/`data.Runtime` (the existing test pattern calls `dagEscalateData` with a `cobra.Command` carrying flags — mirror it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/orchestrate/ -run "TestEscalation|TestEffectiveTaskRoute" -v` and `go test ./cmd/wsh/cmd/ -run Escalate -v` (both need the CGO_CFLAGS workaround; see Global Constraints).
Expected: FAIL — `escalationTarget` signature mismatch, `CommandDagActionData.Model` missing, `effectiveTaskRoute` ignores model.

- [ ] **Step 3: Implement**

In `pkg/wshrpc/wshrpctypes_dag.go`:

```go
type CommandDagActionData struct {
	ChannelId string `json:"channelid"`
	RunId     string `json:"runid"`
	TaskId    string `json:"taskid"`
	Action    string `json:"action"` // approve | sendback | retry | skip | escalate | cancel
	Tier      string `json:"tier,omitempty"`   // legacy escalate target tier
	Model     string `json:"model,omitempty"`  // escalate target model (exact id); wins over Tier
	Runtime   string `json:"runtime,omitempty"` // escalate target runtime; empty = task's current runtime
}
```

In `pkg/orchestrate/engine.go`, rewrite `effectiveTaskRoute` and `childRunFromSpec` (model-aware):

```go
func effectiveTaskRoute(task *waveobj.TaskNode, owner *waveobj.Run) waveobj.RoutePin {
	if task.RunSpec.Model != "" {
		runtime := task.RunSpec.Runtime
		if runtime == "" {
			runtime = owner.Runtime
		}
		return waveobj.RoutePin{Runtime: runtime, Model: task.RunSpec.Model}
	}
	if task.RunSpec.Runtime != "" || task.RunSpec.Tier != "" {
		return runroute.NormalizeLegacy(task.RunSpec.Runtime, task.RunSpec.Tier)
	}
	if owner.Model != "" {
		return waveobj.RoutePin{Runtime: owner.Runtime, Model: owner.Model}
	}
	return runroute.NormalizeLegacy(owner.Runtime, owner.Tier)
}
```

In `childRunFromSpec`, after `run.Tier = route.Tier` add:

```go
	run.Model = route.Model
```

In `pkg/orchestrate/mutation.go`, change `escalationTarget` (drop the tier ladder; `isHigherTier` remains only for the legacy `--tier` path):

```go
func escalationTarget(task *waveobj.TaskNode, owner *waveobj.Run, target waveobj.RoutePin) (waveobj.RoutePin, error) {
	if task == nil {
		return waveobj.RoutePin{}, fmt.Errorf("task is required")
	}
	if task.State != TaskState_Failed && task.State != TaskState_Stalled && task.State != TaskState_BlockedMerge {
		return waveobj.RoutePin{}, fmt.Errorf("task %q cannot be escalated from state %q", task.ID, task.State)
	}
	if task.Escalations >= 1 {
		return waveobj.RoutePin{}, fmt.Errorf("task %q is already escalated; it is blocked for the human", task.ID)
	}
	current := effectiveTaskRoute(task, owner)
	if target.Runtime == "" {
		target.Runtime = current.Runtime
	}
	if target.Model != "" {
		if _, err := runroute.Resolve(target); err != nil {
			return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
		}
		return target, nil
	}
	if target.Tier == "" {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: a target model or tier is required", task.ID)
	}
	if !isHigherTier(current.Tier, target.Tier) {
		return waveobj.RoutePin{}, fmt.Errorf("task %q tier %q is not higher than %q", task.ID, target.Tier, current.Tier)
	}
	target = waveobj.RoutePin{Runtime: target.Runtime, Tier: target.Tier}
	if _, err := runroute.Resolve(target); err != nil {
		return waveobj.RoutePin{}, fmt.Errorf("escalating %q: %w", task.ID, err)
	}
	return target, nil
}
```

Change `ApplyAction` and the `"escalate"` case:

```go
func ApplyAction(ctx context.Context, dagID, taskID, action string, target waveobj.RoutePin) error {
	err := withDagMutation(dagID, func() error {
		return applyActionLocked(ctx, dagID, taskID, action, target)
	})
	if err != nil {
		return err
	}
	return Schedule(ctx, dagID)
}
```

```go
	case "escalate":
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
		if err != nil {
			return fmt.Errorf("loading owner run: %w", err)
		}
		target, err := escalationTarget(task, owner, target)
		if err != nil {
			return err
		}
		if err := cancelAndStopTaskRun(ctx, g, taskID); err != nil {
			return err
		}
		task.RunSpec.Runtime = target.Runtime
		task.RunSpec.Tier = target.Tier
		task.RunSpec.Model = target.Model
		task.Attempts = 0
		task.LastFailureKind = ""
		task.Escalations++
		task.State = TaskState_Pending
		task.RunID = ""
		RecomputeDagStatus(g)
```

In `pkg/orchestrate/retry.go`, delete `nextTier` (unused after the above); keep `isHigherTier`.

- [ ] **Step 4: Launch path — `CommandCreateRunData.Model` + `CreateRunCommand`**

In `pkg/wshrpc/wshrpctypes_runs.go`, add the field to `CommandCreateRunData` (next to `Tier`):

```go
	Tier        string                  `json:"tier"`
	Model       string                  `json:"model,omitempty"` // exact model id; empty = tier. wins over tier
```

In `pkg/wshrpc/wshserver/wshserver_runs.go` `CreateRunCommand` (line ~310, the resolve + persist block), pass the model into `Resolve` and persist the resolved model on the run:

```go
	cap, err := runroute.Resolve(waveobj.RoutePin{Runtime: data.Runtime, Tier: data.Tier, Model: data.Model})
	if err != nil {
		return nil, err
	}
```

and after `run.Tier = cap.Tier`:

```go
	run.Model = cap.Model
```

(`cap.Tier` comes from Task 2's string-typed `Capability.Tier`; the `string(cap.Tier)` call in the existing line still compiles — leave it or simplify to `cap.Tier`.)

Extend the existing `CreateRunCommand` test suite in `pkg/wshrpc/wshserver/wshserver_run_test.go` (next to `TestCreateRunCommand_RejectsInvalidOrUnavailableRouteBeforePersistence`) with a model case: `CommandCreateRunData{Runtime: "claude", Model: "sonnet"}` (harness stubbed installed) must yield a persisted run whose `Model == "sonnet"`; and `Model: "gpt-5.4"` on runtime `claude` must be rejected before persistence.

- [ ] **Step 5: Fix the `DagActionCommand` call site**

In `pkg/wshrpc/wshserver/wshserver_dag.go:117`, replace the tier-string call:

```go
	return orchestrate.ApplyAction(ctx, run.DagORef, data.TaskId, data.Action, data.Tier)
```

with the target pin (approve/sendback/retry/skip pass an empty pin; only `escalate` fills it):

```go
	target := waveobj.RoutePin{Runtime: data.Runtime, Tier: data.Tier, Model: data.Model}
	return orchestrate.ApplyAction(ctx, run.DagORef, data.TaskId, data.Action, target)
```

- [ ] **Step 6: wsh CLI flags**

In `cmd/wsh/cmd/wshcmd-jarvisdag.go`, update `dagEscalateData` and the escalate command:

```go
func dagEscalateData(cmd *cobra.Command, args []string) (wshrpc.CommandDagActionData, error) {
	channelID, runID, err := dagIds(cmd)
	if err != nil {
		return wshrpc.CommandDagActionData{}, err
	}
	tier, _ := cmd.Flags().GetString("tier")
	model, _ := cmd.Flags().GetString("model")
	runtime, _ := cmd.Flags().GetString("runtime")
	return wshrpc.CommandDagActionData{
		ChannelId: channelID,
		RunId:     runID,
		TaskId:    args[0],
		Action:    "escalate",
		Tier:      tier,
		Model:     model,
		Runtime:   runtime,
	}, nil
}
```

and in `dagEscalateCmd` add flags plus updated short text:

```go
var dagEscalateCmd = &cobra.Command{
	Use:   "escalate <task-id>",
	Short: "re-queue a failed or stalled task on a chosen model (one judged hop)",
	Args:  cobra.ExactArgs(1),
	PreRunE: preRunSetupRpcClient,
	RunE: func(cmd *cobra.Command, args []string) error {
		data, err := dagEscalateData(cmd, args)
		if err != nil {
			return err
		}
		return wshclient.DagActionCommand(RpcClient, data, &wshrpc.RpcOpts{Timeout: 10_000})
	},
}

func init() {
	dagEscalateCmd.Flags().String("model", "", "exact model id to retry on (e.g. opencode/claude-opus-4-8)")
	dagEscalateCmd.Flags().String("runtime", "", "runtime to retry on; empty keeps the task's current runtime")
	dagEscalateCmd.Flags().String("tier", "", "legacy: retry on a higher tier (cheap|mid|capable)")
}
```

- [ ] **Step 7: Run tests + regenerate + verify**

Run: `go test ./pkg/orchestrate/ ./cmd/wsh/cmd/ -run "TestEscalation|TestEffectiveTaskRoute|Escalate" -v`
Expected: PASS. Update `retry_test.go` to drop now-deleted nextTier cases if compilation complains.

Run: `task generate`
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (`CommandDagActionData` gains `runtime`/`model` in `gotypes.d.ts`).

Run the wider suites once:

Run: `go vet ./pkg/runroute/ ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/`
Expected: clean.
Run: `go test ./pkg/runroute/ ./pkg/orchestrate/ ./pkg/jarvis/ ./cmd/wsh/cmd/ ./pkg/wshrpc/wshserver/` (with the CGO_CFLAGS workaround)
Expected: PASS.

- [ ] **Step 8: Stage**

```bash
git add pkg/wshrpc/wshrpctypes_dag.go pkg/orchestrate/mutation.go pkg/orchestrate/engine.go pkg/orchestrate/retry.go pkg/orchestrate/retry_test.go pkg/orchestrate/engine_test.go pkg/orchestrate/mutation_test.go cmd/wsh/cmd/wshcmd-jarvisdag.go cmd/wsh/cmd/wshcmd-jarvisdag_test.go pkg/wshrpc/wshserver/wshserver_dag.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

### Task 7: Full verify + simplify review + commit (approval gate)

- [ ] **Step 1: Full backend verification**

Run:
```bash
task build:backend
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
go vet ./pkg/runroute/ ./pkg/orchestrate/ ./pkg/jarvis/ ./pkg/wshrpc/wshserver/ ./cmd/wsh/cmd/
```
Expected: all clean.

- [ ] **Step 2: Simplify self-review of the changed lines**

Run: `git diff --stat` — every changed file must be one this plan touched. Then review your own diff:
- No commented-out code, no debug prints, no dead helpers (e.g. leftover `nextTier` references).
- No raw model strings outside `pkg/consult` / `pkg/runroute` / generated bindings.
- All comments "why"-only, lowercase.
- Route picker / planner can't see legacy tier capabilities for model rows (FE plan filters on `model != ""`).

- [ ] **Step 3: Show the commit and ask for approval**

```bash
git status --short
git diff --stat
```

Then present (per repo AGENTS.md — do not commit before approval):

```
Files (M/A/D) + one-line change summary each.
Message proposal:
feat(route): exact model routes from harness catalogs

Run routes become {runtime, model} pins resolved against a cached,
harness-sourced model catalog (pi/opencode enumerate, claude/codex
derive), with free-form ids, a manual refresh RPC, and model-targeted
one-hop escalate. Tier remains as the legacy fallback.
```

Awaiting approval. Proceed? (yes/no)

- [ ] **Step 4: Commit after approval**

```bash
git add -A
git commit -F /tmp/flat-model-routes-commit.txt   # or multiple -m flags; never PowerShell here-strings
```

Do NOT push. Do NOT add yourself as co-author.