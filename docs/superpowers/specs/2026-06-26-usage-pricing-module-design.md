# Usage pricing module (Codex cost + Claude 1h/5m cache) — design

Date: 2026-06-26
Status: approved, trivial-ish scope (this doc is also the plan)

## Problem

Spend comes from an inline hardcoded `PRICING` (opus/sonnet/haiku) in `usagestats.ts`:
- Codex/OpenAI models aren't priced → Codex spend reads $0.
- Claude cache *writes* are all priced at the **5m** rate, but this user runs **1h extended
  cache** (`ephemeral_1h_input_tokens`), which Anthropic bills at **2× base input** (opus $30/M,
  not $18.75/M). Cache-write spend is under-counted.

## Decision

**Bundled static price table, not a runtime LiteLLM fetch.** The cockpit is offline-first; a network
price fetch adds a dependency + failure mode for no real benefit (ccusage ships an offline snapshot
too). New `usagepricing.ts` is the single source of truth; prices sourced from LiteLLM / OpenAI rate
card and dated in a comment so they're refreshable.

## Prices (per 1M tokens, sourced 2026-06)

| family | input | output | cacheRead | cacheWrite5m | cacheWrite1h |
|---|---|---|---|---|---|
| opus | 15 | 75 | 1.5 | 18.75 | 30 |
| sonnet | 3 | 15 | 0.30 | 3.75 | 6 |
| haiku | 0.80 | 4 | 0.08 | 1.0 | 1.6 |
| gpt-5.5 | 5 | 30 | 0.50 | 0 | 0 |
| codex (gpt-5-codex) | 1.25 | 10 | 0.125 | 0 | 0 |
| gpt-5 | 1.25 | 10 | 0.125 | 0 | 0 |

OpenAI families have `cacheWrite* = 0` (OpenAI doesn't bill cache writes; Codex records carry
`cacheCreateTokens: 0` anyway). `codex-auto-review` maps to the codex family (best-effort: it's a
codex subagent alias).

## Module shape

- `MODEL_PRICES` keyed by family; `priceFor(model)` family-substring match, ordered
  `opus|sonnet|haiku` then `gpt-5.5` then `codex` then `gpt-5`; unknown → undefined → $0 (unchanged).
- `spendOf(record)` moves here. Cache-write split:
  `cache5m = cacheCreateTokens - (cacheCreate1hTokens ?? 0)` priced at `cacheWrite5m`;
  `cacheCreate1hTokens` priced at `cacheWrite1h`.
- `usagestats.ts` deletes its inline `PRICING`/`priceFor`/`spendOf` and imports `spendOf` from
  `usagepricing` (type-only back-import of `UsageRecord`, no runtime cycle). `tokensOf` unchanged.

## Record change

Add optional `cacheCreate1hTokens?: number` to `UsageRecord` (a subset of `cacheCreateTokens`, kept
so `tokensOf` stays a flat sum and existing fixtures don't churn). `extractUsage` populates it from
`usage.cache_creation.ephemeral_1h_input_tokens` (absent → 0 = treat as 5m, Anthropic's default).
`extractCodexUsage` leaves it 0.

## Visible result

Codex `Spend today/week` stops being $0; Claude cache-write spend reflects the 1h rate.

## Out of scope

Runtime price refresh; per-model spend rows in the UI (spend already aggregates into the headline);
o-series / non-codex OpenAI models beyond the families above.

## Implementation (TDD)

1. **Red** `usagepricing.test.ts`: `priceFor` family matching (opus, gpt-5.5, codex, unknown→undefined)
   and `spendOf` per family — opus mix (5m vs 1h tiers differ), gpt-5.5 = $5/$30/$0.50, unknown → 0.
2. **Green** `usagepricing.ts`.
3. Add `cacheCreate1hTokens` to `UsageRecord`; populate in `extractUsage`; red→green a test that
   `extractUsage` captures `ephemeral_1h_input_tokens`.
4. Swap `usagestats.ts` to import `spendOf`; move the existing `spendOf` describe block into
   `usagepricing.test.ts`.
5. **Verify** full `npx vitest run` + tsc; CDP confirm Codex spend non-zero and Claude spend rises.
