# OpenRouter headless AI migration

## Context

All 12 headless (silent, background) AI features in the app shell out to `claude -p` — a binary that no longer exists on the operator's PATH after switching from Claude Code to OpenCode. The features are dead.

Moving to OpenRouter's OpenAI-compatible HTTP API:
- Restores all features on a single, consistent transport path
- Enables per-token pricing instead of Claude Code subscription billing
- Allows cheap models (DeepSeek V4 Flash at $0.09/MTok) for mechanical tasks
- Estimated monthly cost: ~$3.50 with the gardener cooldown already in place

## Architecture

### New API backend in pkg/consult

`consult` keeps its existing CLI path (`runPipe`/`runPty`) untouched. A new API backend runs in parallel, selected by the runtime spec.

```go
type apiBackend interface {
    Run(ctx context.Context, spec RuntimeSpec, prompt string, emit func(string)) (string, error)
}

type RuntimeSpec struct {
    Bin            string                              // CLI binary (unchanged)
    BaseArgs       []string                            // unchanged
    PromptViaStdin bool                                // unchanged
    UsePty         bool                                // unchanged
    ParseLine      func([]byte) (string, bool)         // unchanged; nil for API backends
    ApiBackend     apiBackend                          // NEW: if set, Run() calls the API
    Model          string                              // NEW: model id for API backends
}
```

`Run()` dispatches: if `spec.ApiBackend != nil`, call `spec.ApiBackend.Run(ctx, spec, prompt, emit)`; otherwise the existing `runPipe`/`runPty` path.

### OpenRouter backend

A single `openrouterBackend` in `pkg/consult/openrouter.go`:

- Reads `OPENROUTER_KEY` from the secret store (reuses the existing legacy WaveAI secret name)
- Sends OpenAI-compatible chat completion requests to `https://openrouter.ai/api/v1/chat/completions`
- Auth: `Authorization: Bearer <key>` header
- Streams SSE responses with `eventsource.NewDecoder` (already in go.mod via aiusechat deps)
- Parses delta content chunks from `choices[].delta.content`, calls `emit()` per chunk, returns accumulated text
- Reuses `StreamChunk` types from `pkg/aiusechat/openaichat/openaichat-types.go` — zero new dependencies
- 5-minute timeout per call
- No retry (callers handle failure)

### Runtime spec entry

```go
var runtimeSpecs = map[string]RuntimeSpec{
    // ... existing CLI entries unchanged ...
    "openrouter": {
        ApiBackend: &openrouterBackend{},
        DefaultModel: cheapModelFromSettings(),  // resolved at call time, not map init time
    },
}
```

No `Bin`, no `BaseArgs`, no `ParseLine` — the backend handles everything.

### Tier resolution for openrouter

`SpecForTier("openrouter", tier)` sets `spec.Model` instead of appending `--model` flags:

```go
func SpecForTier(runtime string, tier Tier) (RuntimeSpec, bool) {
    spec, ok := SpecFor(runtime)
    if !ok {
        return spec, false
    }
    model := modelForTier(tier)
    if model == "" {
        spec.Model = spec.DefaultModel  // TierCapable: use the mid-tier model
        return spec, true
    }
    spec.Model = model
    return spec, true
}
```

`modelForTier` for `openrouter` reads settings config (the `cheap`/`mid` keys above) instead of returning the hardcoded `CheapModel`/`MidModel` constants. `TierCapable` maps to `spec.DefaultModel` (the mid model). For `claude` and other CLI runtimes, `modelForTier` keeps the existing hardcoded `--model` aliases. Non-claude CLI runtimes (codex, agy, opencode) are never tiered — `SpecForTier` returns the unmodified spec for them.

`ModelForCorpus` for `openrouter` reads settings config instead of returning the hardcoded `CorpusCheapModel`/`CorpusLongModel` constants. The 400KB corpus threshold stays; the model IDs come from `headless:openroutercheapmodel` and `headless:openrouterlongmodel` respectively.

## Model mapping

Three model slots, configurable via settings, with OpenRouter `provider/model` format:

| Config key | Default | Tier | Used by |
|---|---|---|---|
| `headless:openroutercheapmodel` | `deepseek/deepseek-v4-flash` | TierCheap | classify, decompose, continuity, proactive, volunteer, gardener freshness, gardener dedup, distillation (small corpus) |
| `headless:openroutermidmodel` | `deepseek/deepseek-v4-pro` | TierMid, TierCapable | recall synthesis, radar synthesis, jarvis conversation |
| `headless:openrouterlongmodel` | `deepseek/deepseek-v4-pro` | Corpus escalation | distillation (>=400KB), gardener (>=400KB) |

Corpus escalation (`ModelForCorpus`) keeps the same 400KB threshold. The cheap model maps to the `<400KB` path; the long model maps to `>=400KB`.

### Settings config additions

`pkg/wconfig/settingsconfig.go` — three new fields on `SettingsType`:

```go
HeadlessOpenRouterCheapModel string `json:"headless:openroutercheapmodel,omitempty"`
HeadlessOpenRouterMidModel   string `json:"headless:openroutermidmodel,omitempty"`
HeadlessOpenRouterLongModel  string `json:"headless:openrouterlongmodel,omitempty"`
```

## Settings UI

New **Headless AI** section in `frontend/app/view/agents/settingssurface.tsx`, placed near the existing Embeddings section:

- Three text inputs: Cheap model, Mid model, Long model
- Pre-filled with defaults on first open
- Freeform — user types any valid OpenRouter `provider/model` string
- An "API key" status line reading the `OPENROUTER_KEY` secret:
  - Green "configured" if the key exists in the secret store
  - Amber "missing (set OPENROUTER_KEY)" if absent
- No endpoint field, no provider toggle, no enable/disable switch — the endpoint is fixed, the feature is always on if the key exists

## Call site changes

### consult.SpecForTier callers (7 sites) — one-line changes

Change `"claude"` to `"openrouter"` in every `SpecForTier` call:

| File | Change |
|---|---|
| `pkg/jarvis/classify.go:118` | `SpecForTier("openrouter", TierCheap)` |
| `pkg/jarvis/decompose.go:70` | `SpecForTier("openrouter", TierCheap)` |
| `pkg/jarviscontinuity/continuity.go:26` | `SpecForTier("openrouter", TierCheap)` |
| `pkg/jarvisproactive/proactive.go:30` | `SpecForTier("openrouter", TierCheap)` |
| `pkg/jarvisvolunteer/judge.go:25` | `SpecForTier("openrouter", TierCheap)` |
| `pkg/jarvisrecall/recall.go:44` | `SpecForTier("openrouter", TierMid)` |
| `pkg/wshrpc/wshserver/wshserver_jarvis.go:177` | `SpecForTier("openrouter", TierCheap)` |

### Direct exec callers (3 sites) — rewrite to use consult

**memdistill/distill.go** — replace `runDistill(claudePath, model, corpus)` with a `consult.Run` call:

- Build prompt via `buildCorpus` (returns corpus + model from `ModelForCorpus`)
- Call `consult.Run(ctx, spec, cwd, batchDistillPrompt, emit)` where spec is `SpecForTier("openrouter", TierCheap)` with model overridden by the corpus result
- Drop the hardcoded `exec.CommandContext(ctx, "claude", ...)` and `claudePath` parameter

**memgarden/gardener.go** — replace `runClaudeHeadless(model, prompt, corpus)` with `consult.Run`:

- Build spec via `SpecForTier("openrouter", TierCheap)` with model from `pickModel(corpus)`
- Drop the hardcoded `exec.CommandContext(ctx, "claude", "-p", "--model", model, prompt)`

**reporadar/synth.go** — replace `runSonnet` with `consult.Run`:

- Build spec via `SpecForTier("openrouter", TierMid)` (radar already uses `MidModel`)
- Remove the custom `streamFn`, `parseSynthesisStream`, `runSonnet`, `runSonnetWith` (still need `parseSynthesisResponse` for JSON parsing)
- Token tracking: capture usage from the OpenRouter API response (`usage` field on the last chunk)
- Remove `disabledToolArgs` — OpenRouter API calls have no tools to disable
- `buildSynthesisPrompt` stays; the model call is now `consult.Run(ctx, spec, HeadlessAgentCwd(), prompt, func(string){})`

## Error handling

- **Missing OPENROUTER_KEY**: `openrouterBackend.Run()` returns a clear error: "OpenRouter API key not configured (set OPENROUTER_KEY)"
- **API errors (4xx/5xx)**: returned as-is from the backend, logged by the caller
- **Network/timeout**: surfaced as the underlying error; no retry
- **Parse failure**: empty response or unparseable SSE → error; model name is included in the message
- **Consult command (Jarvis convo)**: error surfaced to the channel as a system message
- Every existing caller already handles `consult.Run` errors with logging; no new error paths needed

## Testing

- **openrouterBackend tests**: mock HTTP server returning SSE stream with known chunks, verify emit() receives correct text, verify model header is sent, verify API key header is present. No actual OpenRouter calls in unit tests.
- **SpecForTier tests**: extend existing tests for the openrouter runtime — verify TierCheap/TierMid/TierCapable resolve to the correct model strings.
- **Tier test files**: existing `tier_test.go` files in `jarvis`, `jarvisrecall`, `jarvisproactive` test that callers select the right tier; update assertions from checking `--model haiku` in BaseArgs to checking the model field on the spec.
- **Existing gardener/distill/radar tests**: verify unchanged behavior after migration to `consult.Run`. Current tests inject mock `llmFn`/`streamFn` — those seams remain.
- **Settings surface**: not unit-tested per existing convention; covered by the CDP `surface-smoke` scenario.

## Non-goals

- Provider selection (other than OpenRouter) — fixed
- Endpoint configuration — fixed to OpenRouter's chat completions URL
- Model validation — invalid model IDs fail at the API with OpenRouter's error
- Usage/cost tracking — add when there's a need; radar's existing token field stays
- OpenCode fallback — the operator explicitly wants fail-clean, not a fallback
- Retry/backoff — offline first; add if failures become common
