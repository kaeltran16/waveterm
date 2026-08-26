# Flat model routes: exact model selection for runs and tasks

## Context

The run route is a `{runtime, tier}` pin with exactly three tiers — `cheap | mid | capable` —
resolved by a static table in `pkg/runroute`:

| runtime | cheap | mid | capable |
|---|---|---|---|
| pi | deepseek-v4-flash | deepseek-v4-pro | deepseek-v4-pro |
| claude | haiku | sonnet | *your CLI default* |
| codex / opencode | — | — | *your CLI default* |

Three problems:

1. **No exact model choice.** A run or task cannot pin a specific model (a dated id, a
   fine-tune, a provider id only one harness can reach). The orchestrator lead likewise can
   only point a task at an installed tier pin, never at a concrete model.
2. **The ladder is illusory.** For pi, `capable == mid` (both deepseek-v4-pro); for claude and
   codex, `capable` is not a model at all — it is "whatever default the operator configured".
3. **The model universe is per-harness, not global.** Every harness talks to its own
   providers (pi drives opencode + openai-codex ids; claude drives only Anthropic ids; codex
   only OpenAI). A cross-harness tier ladder gives routes that make no sense for the runtime.

## Decisions

- **A route is `{runtime, model}`.** `model` is the exact id handed to the harness
  (`--model <id>` or the API's model field). `tier` remains a legal legacy fallback: a pin
  with `tier` and no `model` resolves through today's table unchanged. When both are set,
  `model` wins. No migration — the field is additive.
- **The model list comes from the harness, never from a maintained static catalog.**
  Enumerate where the harness exposes it, derive from the harness's own surface otherwise,
  and accept free-form exact ids everywhere. Keeping a shipped list of dated model ids would
  rot exactly like the examples above; passing the operator's config through instead means
  wave maintains nothing.
- **The list is cached server-side with a manual refresh.** No repeated CLI spawns on every
  picker open; a refresh RPC busts the cache on demand.
- **Validation is namespace + presence.** An id must match its runtime's namespace rule at
  submit — that is the hard gate. Presence in the cached catalog is advisory everywhere: a
  listed id may be stale-cache-missed, and a typed id that passes namespace but is unknown
  goes through to the harness, which is the ultimate authority.
- **Escalate becomes judged, model-explicit.** The automatic `cheap→mid→capable` hop is
  already a deliberate non-goal on token-cost grounds (prompt-cache miss; see
  `docs/lead-authored-task-routing-roadmap.md`). In the flat world, `escalate` re-queues a
  failed/stalled task on any model the human picks, still capped at one hop per task.
- **Consult and openrouter-headless tiering are untouched.** `consult.Tier` and the
  `headless:openrouter*` model keys are a separate difficulty axis for one-shot calls; this
  spec only changes run-worker routes.

## Design

### 1. Domain model

`waveobj.RoutePin` gains `Model string` (`json:"model,omitempty"`). `Run` and
`TaskNode.RunSpec` gain the same field. All additive JSON — no SQL migration.

`pkg/wshrpc` capability shape: `Capability{Runtime, Model, ResolvedModel, Provider?,
ContextHint?, Default bool}` — `ModelArgs` stays non-serialized (adapter launch form). `Tier`
remains on legacy-only capability entries so persisted tier pins stay renderable.

### 2. `pkg/runroute` becomes the catalog authority

`runroute` keeps `Resolve` as the single validity boundary. Model lists per runtime:

| runtime | source | parse |
|---|---|---|
| pi | `pi --list-models` | fixed-width table: provider, model, context, max-out, thinking, images. Entries are `provider/model` ids. |
| opencode | `opencode models` | one `provider/model` id per line |
| claude | the alias line in `claude --help` | stable aliases (`fable`, `opus`, `sonnet`, `haiku`, `best`); full ids are free-form |
| codex | `~/.codex/config.toml` | top-level `model = "…"` + `[profiles.*]` `model` values — the operator's own curation |

Enumerated ids become picker rows. Every runtime additionally accepts free-form ids.

**Catalog freshness (cached, refreshable).** Enumeration results are cached in-process per
runtime with a 30-minute TTL; `ListHarnessesCommand` serves from cache. A new
`RefreshRouteCatalogCommand` clears the cache; the frontend calls it then re-runs
`loadHarnesses()`. The picker popover gets a small refresh affordance in its header row
("Run route" + ↻). No cross-restart persistence: re-deriving the lists on boot is cheap
(a few CLI spawns), and on-disk caches would only add staleness.

**Degradation.** A probe that fails (CLI missing flag version, parse mismatch, timeout)
degrades that runtime to free-form-only — route selection never blocks on a catalog fetch.
Probes are short-timeout (15s) so a hung CLI cannot stall the picker.

### 3. Validation

`Resolve(pin)`:

- `pin.Model != ""` → namespace check for the runtime (the hard gate), then a presence
  check against the cached catalog (enumerated or config-derived). Presence misses are
  warnings, never hard errors — the cache can be stale, and the harness validates at spawn.
- `pin.Model == ""` → today's legacy tier path, byte-for-byte unchanged.
- Namespace rules: claude `^(opus|sonnet|haiku|fable|best)(\[[0-9]+m\])?$` or `claude-*`;
  pi/opencode `provider/id` (`^[a-z0-9_-]+\/[a-z0-9_\-.:]+$` or bare id for pi); codex any
  config-derived value or a non-empty id with no whitespace/shell metacharacters.

`IsValid` still guards hand-built capabilities across package boundaries, now keyed on the
model path as well as the legacy tier path.

### 4. Orchestrator planning

`DagPlanInput.AllowedRoutes` becomes the serialized flat catalog (runtime + model list per
installed harness). The lead inherits the Run route by default and may pin a per-task
`{runtime, model}`; `routeAllowed` and submit validation key on model exactly as they key on
tier today. `wshserver_jarvis.go` builds the allowed list from `runroute`'s catalog instead
of the legacy pin list, and the `RunSpec` picker writes `Model` — the axis the roadmap
(`docs/lead-authored-task-routing-roadmap.md`) always intended.

### 5. Escalate

`escalationTarget` drops the tier ladder. The verb takes the target (runtime, model) from
the flat picker, validates through `runroute.Resolve`, cancels the old worker, resets
`Attempts`/`LastFailureKind`, marks pending, increments `Escalations` — same retry machinery,
one-hop cap unchanged (a second escalate refuses and the task is blocked for the human).
`nextTier`/`isHigherTier` die in the orchestrate path; `classifyFailure` and the same-tier
tool-error retry are untouched. The CLI flag `--tier` stays (legacy); `--model` is added.

### 6. Frontend

`RoutePicker` renders the grouped-by-runtime flat list (validated layout: harness sections,
provider + context sublabels from the harness report, search field, free-form "custom model
id" row at the bottom, refresh affordance in the header). The face shows
`harness label · provider/model`. `route.ts` keys `capabilityFor` on model with a tier
fallback for legacy pins; the four rungs (settings → channel → Run → task) keep their
inheritance shape. The task drawer's failed/stalled state gets `Escalate…` opening the same
picker with a "Re-queue on model" footer (validated layout); the drawer shows the
one-hop-cap notice. Settings persistence gains `harness:preferredmodel` alongside
`harness:preferredruntime`/`harness:preferredtier`.

### 7. Non-goals

No live provider model APIs (no Anthropic/OpenAI catalog fetches — nothing to key, no
network at selection time). No maintained static model lists. No automatic model switching.
No per-runtime refresh granularity (one refresh button busts all). No on-disk catalog cache.

## Testing

- `runroute`: parse fixtures for each source shape (pi table output, opencode lines, the
  claude `--help` alias line, a codex config.toml with a profile); cache TTL + refresh
  invalidation; degradation to free-form-only on garbage probe output; namespace rules;
  `Resolve` model-pin vs legacy tier-pin (legacy path byte-identical to current tables).
- `wshserver`: `ListHarnessesCommand` serves cached catalog; `RefreshRouteCatalogCommand`
  clears it; route capabilities only for installed, run-worker-capable harnesses (existing
  test extended to the new capability shape).
- `plandag`: prompt serializes the flat catalog; task pin validation keys on model.
- orchestrate: escalate with a model pin (cancel/reset/respawn, one-hop refusal);
  `nextTier` removal.
- FE: `route.ts` model-keyed capability lookup + legacy normalization; picker rendering from
  a harnesses fixture (sections, provider/context sublabels, refresh, free-form row);
  draft-model route validation on model; drawer escalate state.

## Rollout

`task generate` for the wshrpc/waveobj binding changes (`RoutePin.Model`, capability shape,
`RefreshRouteCatalogCommand`). No config or migration work. Land the planner + validation
first (behavior-safe additive), then the picker + escalate UI.