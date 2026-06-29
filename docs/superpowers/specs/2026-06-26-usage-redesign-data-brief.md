# Usage Redesign — Data Availability Brief

> Captured 2026-06-26. A **handoff brief for the Usage surface redesign**: what real data is
> available to design against, its shape, its lifetime, and its gotchas. Not a spec — a menu.
> Assumes the [backend usage scan](./2026-06-26-usage-backend-scan-design.md) has landed (it
> makes the historical data **complete** — all files, all models — and exposes per-day buckets).
>
> Rule for the designer: **design only against §1–§4 (real data). §5 is fabricated — do not
> build a view that depends on it without wiring it first.**

## 0. The one-paragraph orientation

Two independent data sources feed this surface, with **different truth and different
lifetimes**, and a good redesign should treat them as visually distinct:

- **Historical usage** — durable, complete, read from transcript files on disk. Token counts,
  spend (estimated), per-model, per-day. Always present.
- **Live rate-limit windows** — ephemeral, account-level quota %, only known while a Claude
  agent is actively running (a separate persistence effort will give them a "last seen"
  lifetime — see §4).

## 1. Historical usage — the backend bucket payload (always available)

`GetUsageStatsCommand({ windowdays })` returns a flat list of buckets. **This is the raw
material**; every historical view below is a client-side fold of it.

```ts
UsageBucket {
  provider: "claude" | "codex"
  model: string          // raw id, e.g. "claude-opus-4-8", "gpt-5.5", "claude-haiku-4-5-20251001"
  day: string            // "YYYY-MM-DD", local timezone
  input: number          // token counts, by class:
  output: number
  cacheread: number
  cachecreate: number
  cachecreate1h: number  // subset of cachecreate billed at the 1h extended-cache rate
  msgs: number           // message/record count in the bucket
}
```

Coverage after the backend-scan fix: **every transcript file within the window** (no 150-file
cap), `<synthetic>` already filtered out. `windowdays: 0` = all-time.

## 2. Views you can build from §1 (client-side, no extra calls)

| View | How it's derived | Status today |
|---|---|---|
| **Tokens today / this week** | sum `input+output+cacheread+cachecreate` over today / rolling-7-day buckets | shown now |
| **Spend today / week** ($) | `usagepricing.ts` priced per bucket, summed | shown now |
| **By model** (per provider) | group by `model`, % of provider's window tokens | shown now (was opus-only; now multi-model) |
| **Daily series** | group by `day` → sparkline / bar-by-day, per provider or per model | **available, not yet shown** |
| **Token-type split** | `input` vs `output` vs `cacheread` vs `cachecreate` | **available, not yet shown** — see §3 |
| **Per-provider totals** | group by `provider` | trivial |
| **Cache efficiency** | `cacheread / total` ratio | derivable |

Pricing lives in `frontend/app/view/agents/usagepricing.ts` (bundled LiteLLM/OpenAI table;
families: opus, sonnet, haiku, gpt-5/5.5, codex). Spend is a **client-side estimate** — no cost
is stored in transcripts, and on a subscription the real out-of-pocket is $0, so present it as
"≈ API-equivalent," not a bill.

## 3. Real snapshot (2026-06-26, for concrete sizing)

Daily tokens, last 10 active days — shows the shape a daily series would take:

| date | claude | codex |
|---|---|---|
| 06-16 | 471M | 0 |
| 06-17 | 255M | 17M |
| 06-19 | 283M | 31M |
| 06-22 | 424M | 13M |
| 06-23 | 495M | 7M |
| 06-24 | 282M | 3M |
| 06-25 | 294M | 8M |
| 06-26 | 272M | 44M |

By-model, all-time (proves the multi-model breadth now available): opus-4-8 4.2B · gpt-5.5
717M · gpt-5.4 405M · codex-auto-review 207M · sonnet-4-6 183M · opus-4-7 132M · haiku-4-5 50M
· (several smaller gpt-* models).

Token-type split, last 7d, opus-4-8: **input 3.1M · output 16.4M · cacheRead 1.69B · cacheCreate
49.6M.** Read that twice:

> **~94% of the headline token count is cache reads.** A single "tokens" number is misleading.
> The highest-value redesign move is showing the input/output/cache split (data already in §1).
> Cache reads are ~1/10th the price of input, so the token bar and the spend bar tell very
> different stories — both worth showing.

## 4. Live rate-limit windows (ephemeral — only while an agent runs)

Per-agent `AgentUsage`, emitted by the statusLine reporter during an active Claude session:

```ts
AgentUsage {
  contextpct?, contextmax?   // per-session context window (NOT account-level; dies with the session)
  costusd?                   // live session cost
  fivehourpct?, fivehourreset?   // rolling 5-hour quota window  (reset = absolute epoch seconds)
  weekpct?,    weekreset?        // weekly quota window           (reset = absolute epoch seconds)
}
```

- These drive the **donuts** ("5-hour window", "Weekly"). They are **only present while a Claude
  agent is running** — there is no standalone account-level query (the `/api/oauth/usage`
  endpoint is rate-limited and deliberately avoided). When no agent runs, the donuts are blank.
- A separate effort (the **rate-limit donut persistence spec**) will save the last-known
  snapshot per provider so the donuts survive idle, labeled "as of {age} ago", auto-rolling a
  window to empty once its `reset` time passes. **Design the donuts to accommodate a "stale /
  as-of" state**, not just live and blank.
- `fivehourreset`/`weekreset` are **absolute timestamps**, so a countdown stays correct even on
  a stale snapshot.
- Codex carries rate-limit data in-file but is **not confirmed wired** through the live roster —
  treat Codex donuts as Claude-only for now.

## 5. NOT real — do not design around these (placeholders / out of scope)

- **Per-agent token/cost on the agent cards** ("Tokens —", "Cost —") — currently dark; the
  historical scan is account/model-level, not per-agent-session-attributed.
- **Diff chips (+adds/−dels), task lists, git branch/files** on agent cards — fabricated
  placeholders (`placeholderDiffStats`, `placeholderTasks`, `PLACEHOLDER_FILES`). Unrelated to
  usage; named here only so they aren't mistaken for real usage data.

## 6. Constraints the visual should respect

- **Two trust levels on one screen** — historical (durable) vs live quota (ephemeral). Make the
  distinction legible (e.g. a "live" dot vs an "as of" label).
- **Provider-first grouping** — data is keyed `claude` / `codex`; the surface ranks claude first.
- **No network for pricing** — the table is bundled; never imply real-time prices.
- **Wide dynamic range** — daily tokens swing 0 → ~500M; spend $0 → ~$800/day notional. Charts
  need to handle both a busy day and an idle one without misleading.
