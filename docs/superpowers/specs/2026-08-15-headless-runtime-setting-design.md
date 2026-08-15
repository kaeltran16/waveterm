# Headless runtime setting

## Context

Every background AI feature in Arc — the Jarvis gatekeeper, task decomposition, continuity
summaries, the proactive window, recall (judge + synthesis), volunteer judging, memory
distillation, the memory gardener, repo radar, and pi auto-titles — runs one-shot consults
through `pkg/consult`. The 2026-08-07 OpenRouter migration made OpenRouter the API-backed
default for all of them: each call site hardcoded `SpecForTier("openrouter", tier)`.

Meanwhile `pkg/consult` has always shipped consult adapters for four installed harnesses
(pi, claude, codex, opencode), and `pkg/harness` is the shared catalog that knows their
identity and installation state. No user-facing choice existed: the background AI runtime
was a source-level constant, even though the machinery to make it a setting was in place.

## Goals

- One persisted setting, `headless:runtime`, selecting the consult runtime for ALL
  background AI features: `openrouter` (default) or any consult-capable installed harness
  (`pi`, `claude`, `codex`, `opencode`).
- Every background consult call site honors the setting — no feature keeps a hardcoded
  runtime.
- Corpus-size model selection (the gardener's whole-corpus pass) maps correctly per
  runtime: configured OpenRouter IDs for openrouter, the dated corpus constants for claude,
  no override for harnesses without a model knob.
- A Settings UI that shows the runtime choice with installation state, keeps the
  OpenRouter-only model fields honest when a harness is selected, and does not dominate the
  page (collapsible section).
- Unattended failure safety: a misconfigured value must degrade to the known default,
  never silently disable a feature.

## Non-goals

- **Embeddings.** A harness is an agentic CLI; it cannot produce vectors. `jarvisembed`
  stays on its BYOK OpenAI-compatible seam (`jarvis:embedbaseurl`/`model`), unchanged.
- **The interactive chat provider** (`ai:provider`). `usechat`'s provider selection is a
  separate axis and keeps its own options.
- **Per-feature runtime overrides.** One setting for all background features; split knobs
  are YAGNI until someone needs them.
- **Run workers / Pet Errand / `@ask`.** The harness-neutral design (2026-08-10) already
  owns those selectors (`harness:preferredruntime`); this setting covers only the
  unattended consult features.
- **Ranking or auto-selecting harnesses.** The catalog stays passive; the setting names
  one runtime.

## Architecture

### Setting

`headless:runtime` (string, `SettingsType.HeadlessRuntime`, schema-registered; regenerated
via `task generate`). Values are the consult runtime IDs. Empty and unknown values mean
`openrouter`.

### Resolver (`pkg/consult`)

Three functions form the single source of truth:

- `HeadlessRuntime() string` — reads the setting and validates it through `resolveHeadlessRuntime`:
  empty → `openrouter`; unknown (not in the consult registry) → log
  `[consult] headless runtime %q not recognized, falling back to openrouter` and return
  `openrouter`; valid → the configured value. Unattended features cannot prompt the user,
  so a bad value degrades to the known default instead of failing the feature.
- `HeadlessSpecForTier(tier) (RuntimeSpec, bool)` — `SpecForTier(HeadlessRuntime(), tier)`.
  Tier→model mapping is unchanged per runtime: openrouter sets `spec.Model` from the
  configured tier IDs; claude appends `--model <tier alias>`; pi/codex/opencode are
  returned unchanged (the harness uses its own configured default).
- `HeadlessCorpusSpec(corpus) (RuntimeSpec, bool)` — the gardener's whole-corpus variant.
  openrouter: `spec.Model = CorpusModel(configured cheap, configured long, corpus)`.
  claude: builds the spec from `SpecFor` and appends `--model ModelForCorpus(corpus)`
  (the dated constants — an alias would invalidate the context-window guarantee behind
  `CorpusEscalationBytes`). pi/codex/opencode: no model override.

### Call sites

All 11 hardcoded `SpecForTier("openrouter", ...)` calls now go through the resolver:

| Feature | Package | Tier |
|---|---|---|
| Gatekeeper classification | `pkg/jarvis/classify.go` | cheap |
| Task decomposition | `pkg/jarvis/decompose.go` | cheap |
| Continuity summaries | `pkg/jarviscontinuity/continuity.go` | cheap |
| Proactive window judge | `pkg/jarvisproactive/proactive.go` | cheap |
| Recall relevance judge | `pkg/jarvisrecall/judge.go` | cheap |
| Recall synthesis | `pkg/jarvisrecall/recall.go` | mid |
| Volunteer judge | `pkg/jarvisvolunteer/judge.go` | cheap |
| Memory distillation | `pkg/memdistill/coordinator.go` | cheap |
| Memory gardener (corpus) | `pkg/memgarden/gardener.go` | cheap + corpus |
| Repo radar synthesis | `pkg/reporadar/synth.go` | mid |
| pi auto-titles | `pkg/wshrpc/wshserver/pititle.go` | cheap |

Failure-mode error strings were genericized along the way ("requires the claude CLI" →
"requires a headless runtime"), since the runtime is no longer known at compile time.

## User Interface

Settings → Headless AI section (`HeadlessAISection` in `settingssurface.tsx`):

- **Runtime selector** — radio-card rows in the theme-picker language (border +
  `rounded-[11px]` + `p-[10px]`, selected = accent border + surface-hover fill + radio
  check). OpenRouter is pinned first with a live status (`default · key stored` /
  `default · key missing`, from the secret store probe); then the harness catalog rows
  (pi, claude, codex, opencode) via `ListHarnessesCommand` + the shared
  `harnessPickerItems` derivation, with `installed` / `not installed` (disabled) states.
  Uninstalled harnesses stay visible but are not selectable.
- **Model fields** — enabled only while openrouter is the runtime. A harness selection
  disables the three ConfigFields, replaces Save with an `openrouter only` mono tag, and
  adds the same tag to the Models group header. Fields stay visible so the lock is
  discoverable.
- **Key warning** — the amber "API key not set" line renders only when openrouter is the
  runtime and the key is missing (status never color alone; dot paired).
- **Collapsible section** — the whole section folds to one header row: chevron +
  "HEADLESS AI" + a right-aligned summary of the effective state (`OpenRouter · key
  stored`, `Pi · installed`, `Claude Code · not installed`, ...). Default collapsed, so
  the page stays short; the summary keeps the essentials visible without opening.
  Expanding shows the full body above.

## Error Handling

- **Unknown runtime value**: log + fall back to openrouter (see Resolver). The feature
  keeps working on the default rather than failing.
- **Uninstalled harness**: the row is disabled in the UI; if the setting still names it,
  consult.Run fails and the existing per-feature degradation applies (classify escalates,
  decompose returns the goal unsplit, judge returns `ReasonJudgeError`, titles fall back
  to no title, etc.). No path retries through another runtime.
- **Missing key (openrouter)**: existing warning line; features that probe `Available()`
  stay off until configured.
- **Harness CLI failure**: identical to today's consult failure paths — never a fallback
  to another runtime.

## Testing

- Go: `TestResolveHeadlessRuntime` (empty/known/unknown), `TestHeadlessSpecForTier_defaultsToOpenRouter`,
  `TestHeadlessCorpusSpec_defaultsToOpenRouterCorpusModel` in `pkg/consult`; the existing
  tier tests (e.g. `TestSpecForTier_openrouterSetsModel`) remain the contract for
  tier→model mapping.
- Frontend: tsc (`node --stack-size=4000`), eslint/prettier, vitest — the agents surface
  suite.
- Regeneration: `task generate` after the wconfig change (schema/settings.json +
  `frontend/types/gotypes.d.ts` + `metaconsts.go`).
- Visual: `task verify:ui` scenario for the settings surface when the dev app runs.

## Success Criteria

- Setting `headless:runtime=pi` switches every background consult to `pi --mode json
  --no-session --no-extensions`; gatekeeper/recall/gardener/radar/titles all route through
  it.
- An unknown value logs and falls back to openrouter; no feature silently disables.
- The Settings section shows the runtime with installed state, locks the openrouter-only
  model fields for harness runtimes, and collapses to a summary row.
- Embeddings configuration and behavior are byte-for-byte unchanged.
