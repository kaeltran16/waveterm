# Codex usage parser — design

Date: 2026-06-26
Status: approved, trivial scope (this doc is also the plan)

## Problem

The Usage surface shows only Claude. Codex sessions **are** discovered (`discoverCodex` walks
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) and **are** read by the loader, but `extractUsage`
bails on `rec.type !== "assistant"` (the Claude shape). Codex never emits that type, so every Codex
file yields zero records and no "codex" provider section ever appears.

## Data facts (grounded in real sessions)

Codex token usage lives in `event_msg` lines: `payload.type === "token_count"`, `payload.info`:

```json
"info": {
  "total_token_usage": { "input_tokens", "cached_input_tokens", "output_tokens",
                         "reasoning_output_tokens", "total_tokens" },
  "last_token_usage":  { ...same shape, this turn only... },
  "model_context_window": 258400
}
```

- `total_token_usage` is **cumulative and monotonic** over the session file — the last/max event is
  the authoritative session total. (Resume starts a new file with its own cumulative; no cross-file
  history re-copy, so no Claude-style dedup is needed.)
- Summing per-turn `last_token_usage` **over-counts** (measured 11.68M vs authoritative 11.45M, ~2%).
- Bucket nesting: `cached_input_tokens ⊆ input_tokens`, `reasoning_output_tokens ⊆ output_tokens`,
  and `total_tokens = input_tokens + output_tokens`. Mapping naively into our 4-bucket `UsageRecord`
  would double-count the cache.
- The model id is **not** in the token_count event — it is `turn_context.payload.model`
  (e.g. `gpt-5.5`, `codex-auto-review`), emitted before the token_count events.

## Design

New `extractCodexUsage(lines)` in `usagestats.ts`, beside the Claude `extractUsage`. The loader
(`usagestore.ts`) dispatches by `s.agent`. The Claude path is untouched.

Single pass per session file:
1. Track the latest `turn_context.payload.model` seen (fallback `"codex"` if none).
2. Take the **max** `total_token_usage` across the file's `token_count` events (authoritative;
   max guards against any reset).
3. Emit **one `UsageRecord` per session**, `ts` = the last token_count event's timestamp, normalized
   so the existing `tokensOf`/`spendOf` stay correct without special-casing:
   - `inputTokens   = input_tokens − cached_input_tokens`  (non-cached portion)
   - `cacheReadTokens = cached_input_tokens`
   - `outputTokens  = output_tokens`  (reasoning already included)
   - `cacheCreateTokens = 0`
   - → `tokensOf` = `input + output` = Codex's own `total_tokens`. Exact.

`id` stays undefined (no dedup key needed; one record per file already).

## Decisions

- **Session-cumulative**, not per-turn deltas. Matches Codex's own accounting, avoids the 2%
  over-count. Trade-off: a session crossing midnight lands entirely on its last day (rare; Codex
  sessions are short). Accepted.
- **Cost deferred.** No `gpt-5*`/`codex` entry in `PRICING`, so Codex spend reads $0 (same honest
  under-report as any unknown model). Codex pricing folds into the broader pricing-source work
  (LiteLLM / ccusage parity), not this fix.

## Out of scope

Codex dollar pricing; model-id prettifying; precise multi-model or multi-day session attribution
(a session is treated as single-model = its latest `turn_context.model`).

## Implementation (TDD)

1. **Red** — tests in `usagestats.test.ts` for `extractCodexUsage`:
   - parses a `token_count` event into one record with normalized buckets so `tokensOf` == `total_tokens`;
   - takes the max cumulative across multiple `token_count` events (one record, not N);
   - attributes the model from the preceding `turn_context`; falls back to `"codex"` when absent;
   - ignores non-token lines / malformed JSON; returns `[]` for an empty/usageless file.
2. **Green** — implement `extractCodexUsage` in `usagestats.ts`.
3. Dispatch in `usagestore.ts`: `s.agent === "codex" ? extractCodexUsage(lines) : extractUsage(lines, "claude")`.
4. **Verify** — full `npx vitest run`; typecheck via `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Optional CDP check that a Codex section renders.
