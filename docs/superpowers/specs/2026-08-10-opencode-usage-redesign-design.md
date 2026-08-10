# OpenCode usage redesign

**Date:** 2026-08-10
**Status:** design approved; implementation plan not written
**Supersedes:** the Usage deferral in `2026-08-07-opencode-support-design.md` sections 5, 10, and 11

## Why

The Usage surface currently combines two different concepts:

- live account quota reported by an agent harness; and
- historical token consumption grouped by that harness.

That model was adequate when Claude Code and Codex each implied one upstream model provider. OpenCode breaks the equivalence: it is one harness that can run models from OpenAI, Anthropic, OpenCode Go, OpenRouter, and other providers. A bucket labeled only `opencode` hides the provider and model that consumed the tokens. The app-bar 5-hour gauge is more misleading because no percentage can represent a fleet of agents using heterogeneous account and billing arrangements.

The redesign keeps the useful Usage destination, adds OpenCode's locally recorded history, separates harness identity from upstream provider/model identity, and removes the global app-bar gauge.

## Goals

- Include OpenCode activity in historical Usage.
- Make harness, upstream provider, and model separate dimensions.
- Keep trustworthy provider-specific quota readings without implying universal coverage.
- Separate source-reported cost from API-equivalent estimates.
- Represent unknown pricing as incomplete coverage, not zero estimated cost.
- Remove the app-bar usage control without replacing it with another global fleet metric.

## Non-goals

- Deriving OpenCode account quotas, reset windows, or context percentages.
- Normalizing subscription plans into a universal percentage or currency value.
- Fetching provider billing APIs.
- Maintaining a complete dynamic model-pricing catalog.
- Adding a new Models, Limits, or fleet-health surface.
- Changing per-agent context and session usage displays.

## Resolved decisions

### Keep Usage as one surface

Usage already owns historical token, model, and estimated-spend analytics. Renaming it or creating a second Models surface would duplicate that responsibility. Provider limits remain a clearly labeled section within Usage because the existing Claude signal is useful, but no empty OpenCode limit card is rendered.

### Remove usage from global chrome

`CockpitAppBar` removes its usage button and provider gauges. There is no canonical agent across the cockpit's multiple concurrent agents and harnesses, so the app bar does not substitute a selected-session model or fleet aggregate. Native window controls remain right-aligned.

### Model three independent dimensions

Every historical record and bucket carries:

- `harness`: the application that ran the session (`claude`, `codex`, or `opencode`);
- `provider`: the upstream model provider, such as `anthropic`, `openai`, or `opencode-go`; and
- `model`: the provider-local model identifier.

Historical filters use `harness`. Provider/model cards use `provider` and `model`. These meanings do not change according to the selected filter.

### Keep reported and estimated cost separate

OpenCode records a `cost` value on assistant messages. That is source-reported cost, including meaningful zero values. It is not combined with WaveTerm's API-equivalent estimate.

WaveTerm continues estimating API-equivalent cost from token classes and its bundled model price table. Tokens whose models have no known price are excluded from the estimate and reduce the displayed priced-token coverage. They never contribute a silent `$0` estimate.

## Verified OpenCode source

Current OpenCode storage under `~/.local/share/opencode/storage` contains:

- `session/<projectID>/<sessionID>.json` for session metadata;
- `message/<sessionID>/<messageID>.json` for message metadata and assistant usage; and
- `part/<messageID>/<partID>.json` for content and tool parts.

The current assistant-message shape stores these fields at the top level:

```json
{
  "role": "assistant",
  "time": { "created": 1769415689066 },
  "providerID": "openai",
  "modelID": "gpt-5.2-codex",
  "cost": 0,
  "tokens": {
    "input": 611,
    "output": 4049,
    "reasoning": 3520,
    "cache": { "read": 57088, "write": 0 }
  }
}
```

`opencode stats --days 7 --models 20` confirms that this data supports session/message counts, all recorded token classes, reported cost, and grouping by provider/model. It does not expose account quota or context-window fill.

The existing WaveTerm OpenCode session scanner expects nested model metadata and derives usage from `step-finish` parts. Its fixture does not match the verified current message shape. The implementation must correct that fixture and parser assumption rather than reuse it in the new Usage scanner.

## Data contract

`wshrpc.UsageBucket` changes to carry:

```go
type UsageBucket struct {
    Harness         string   `json:"harness"`
    Provider        string   `json:"provider"`
    Model           string   `json:"model"`
    Day             string   `json:"day"`
    Input           int      `json:"input"`
    Output          int      `json:"output"`
    Reasoning       int      `json:"reasoning"`
    CacheRead       int      `json:"cacheread"`
    CacheCreate     int      `json:"cachecreate"`
    CacheCreate1h   int      `json:"cachecreate1h"`
    ReportedCostUsd *float64 `json:"reportedcostusd,omitempty"`
    Msgs            int      `json:"msgs"`
}
```

`ReportedCostUsd` is optional so an absent report differs from a reported zero. Bucketing emits a pointer if and only if at least one source record in that bucket reports cost.

The Go record used before bucketing carries the same dimensions and token/cost fields. Bucket identity becomes `(harness, provider, model, local day)`.

Changing the wshrpc type requires `task generate`; generated Go and TypeScript files are not hand-edited.

## Backend scanning

### Claude Code

The existing transcript parser remains the source. It emits:

- `harness: "claude"`;
- `provider: "anthropic"`;
- the transcript's raw model ID; and
- no reported cost.

Its current streaming-snapshot deduplication, synthetic-record exclusion, headless-maintenance exclusion, and cache-creation handling remain unchanged.

### Codex

The existing rollout parser remains the source. It emits:

- `harness: "codex"`;
- `provider: "openai"`;
- the rollout's raw model ID; and
- no reported cost.

Its cumulative-total selection and cached-input normalization remain unchanged.

### OpenCode

A new parser scans current assistant-message JSON files. It accepts a record only when it has:

- `role: "assistant"`;
- a valid `time.created` epoch;
- non-empty `providerID` and `modelID`; and
- a token object.

It emits one record per assistant message:

- `harness: "opencode"`;
- `provider` from `providerID`;
- `model` from `modelID`;
- input, output, reasoning, cache-read, and cache-write tokens;
- reported cost, including zero; and
- local day derived from `time.created`.

Assistant messages are final records rather than cumulative streaming snapshots, so the Claude deduplication rule does not apply. Window filtering scans message files and uses message timestamps for correctness; the initial implementation does not prune by file modification time.

Missing OpenCode storage is an empty source. Malformed or incomplete files are skipped individually and do not fail the full scan.

## Frontend aggregation

The pure Usage aggregation model changes as follows:

- Daily rows hold a keyed harness series rather than fixed Claude/Codex fields.
- Harness-filtered totals, token classes, daily rows, and provider/model groups derive from one filtered bucket set.
- Provider groups aggregate models by upstream `provider`, independent of harness.
- Reasoning is a fifth token class.
- API-equivalent pricing treats reasoning tokens at the model's output-token rate.
- Estimated-spend totals track both priced tokens and all tokens in the selected scope. Pricing coverage is `tokens belonging to models with a known price / all tokens`; an empty scope reports no coverage rather than 0%.
- Reported-cost totals include only buckets with `ReportedCostUsd` present and expose which harnesses contribute.

The selected harness filter lives in an `AgentsViewModel` atom because Usage unmounts when the user switches surfaces. The default is `all`.

## Surface behavior

### Provider limits

The top section is renamed from "Live limits" to "Provider limits." It renders only providers with a trustworthy live or saved reading. Existing stale-reading, reset countdown, and Claude weekly-projection behavior remains. OpenCode receives no placeholder gauge.

When no provider has a reading, the section explains that no provider limit data is currently available without instructing the user to start a specific harness.

### Historical consumption

The historical section adds filter chips for All, Claude Code, Codex, and OpenCode. A harness appears as a filter only when records for it exist in the loaded window. Changing the filter updates every historical visualization but does not affect Provider limits.

The four summary cards are deterministic. For the seven-day window they show Tokens today, Tokens over 7 days, Reported cost over 7 days, and API-equivalent estimate over 7 days. For All time they show Tokens all time, Daily average over active days, Reported cost all time, and API-equivalent estimate all time. Token cards identify contributing harnesses in secondary text. Reported-cost cards identify contributing harnesses. Estimate cards show priced-token coverage. The existing busiest-day card is removed.

"Where it goes" adds Reasoning beside Input, Output, Cache read, and Cache write. Its spend bar remains labeled API-equivalent because reported cost cannot be allocated reliably by token class.

The daily chart remains switchable between tokens and API-equivalent spend. It stacks series by harness. Reported cost is summary-only because source coverage differs and a combined trend would invite false comparison.

Model cards group by upstream provider, show full provider/model identity, and rank models by token volume within the selected harness filter. The daily chart's metric toggle does not change model-card ordering.

### App bar

The usage button, rings, percentage text, and click-through are removed from `CockpitAppBar`. The window-control group remains at the right edge. No agent, harness, model, quota, token, cost, or fleet-health value replaces the removed control.

## Error handling

- A missing source root contributes no records.
- An unreadable or malformed usage file is skipped at the file boundary.
- A refresh error preserves the last successfully loaded data and uses the existing surface error banner.
- A reported cost of zero remains present and is displayed as reported zero.
- Unknown model pricing lowers coverage and does not add zero-priced tokens to the estimated total.
- A harness with history but no quota source appears in historical filters, not Provider limits.
- A provider with no historical records in the selected window does not render an empty model card.

## Testing

### Go

`pkg/usagestats` tests cover:

- current OpenCode top-level assistant-message parsing;
- harness/provider/model identity;
- input, output, reasoning, cache-read, and cache-write tokens;
- present zero and non-zero reported cost;
- timestamp-to-local-day conversion;
- malformed and incomplete record skipping;
- time-window filtering;
- bucket separation across harness, provider, model, and day; and
- unchanged Claude/Codex extraction and deduplication behavior.

`pkg/agentsessions` receives a current-format OpenCode fixture and assertions so its model and usage extraction matches live storage.

### Frontend

Pure Vitest coverage includes:

- harness filtering;
- dynamic daily harness series;
- upstream provider/model grouping;
- reasoning token totals;
- reported-cost presence versus reported zero;
- API-equivalent estimate coverage for mixed known and unknown models; and
- filter persistence in the view model.

Existing Usage store tests continue covering latest-request-wins refresh behavior and preservation of last-good data.

### Integration

- Run `task generate` after the wshrpc type change.
- Run focused Go tests for `pkg/usagestats` and `pkg/agentsessions` with the repository's required CGO include path.
- Run focused Usage Vitest suites.
- Run `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- Update the `usageCharts` CDP scenario to verify OpenCode filters/model cards, separate reported/estimated cost labels, pricing coverage, reasoning tokens, and absence of the app-bar usage control.

## Consequences

The Usage surface becomes accurate for heterogeneous harnesses without creating a second analytics destination. OpenCode's recorded usage becomes visible using data already present on disk. Claude's useful live quota survives, but only as a provider-specific signal. The cost display becomes more verbose because it refuses to collapse reported and estimated values into one misleading number.

The wire contract and pure frontend aggregation require a focused refactor, but no persisted database migration or new service is needed.
