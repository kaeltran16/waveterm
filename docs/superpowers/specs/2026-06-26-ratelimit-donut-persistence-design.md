# Rate-Limit Donut Persistence — Design Spec

> Captured 2026-06-26. Makes the Usage surface's rate-limit **donuts** (5-hour + weekly quota
> windows, per provider) survive when no agent is running, by persisting the last-known snapshot
> and reconciling it whenever a live agent reports fresh numbers. Independent of the
> [backend usage scan](./2026-06-26-usage-backend-scan-design.md) (that reworks the *historical*
> token/spend path; this touches only the *live* quota path). Sits on top of the post-scan
> `usagesurface.tsx`.

## 1. Problem

The donuts read per-agent `AgentUsage` (`fivehourpct`/`weekpct` + resets) via
`providerPlanUsage(agents)`. That roster is built from **running sessions only**
(`liveAgentBaseAtom`), and the usage is emitted by the statusLine reporter **only while a Claude
agent is live**. So when no agent runs, the donuts vanish — even though the 5-hour/weekly quota
is slow-moving and a last-known reading is still useful. There is no standalone account-level
query (the `/api/oauth/usage` endpoint is deliberately avoided).

## 2. Locked decisions

- **Storage: `localStorage`.** Pure-FE, survives app restarts. One snapshot per provider,
  overwritten when a live agent reports fresh numbers. (First `localStorage` use in the
  frontend — sets the convention. Dev `:5174` and packaged builds keep separate copies, which
  is fine.)
- **Staleness UX: label + auto-rollover.** A saved (not-live) snapshot renders with an
  "as of {age} ago" label; if a window's `reset` timestamp has already passed, that window
  renders **empty (0%)** with the countdown dropped (the window rolled over; the new reset
  cadence is unknowable). Live snapshots render with no label.

## 3. Architecture

```
agent:status event (usage)                ┌─ recordRateLimit(provider, usage)
  agentstatusstore.ts ──────────────────┤   (only when fivehourpct/weekpct present)
   (existing: sets per-block usage atom) │            │
                                         ▼            ▼
                       ratelimitstore.ts: savedRateLimitsAtom ◄──► localStorage["wave:ratelimits"]
                                         │   { claude: SavedSnapshot, codex: SavedSnapshot }
                                         ▼
  usagesurface.tsx: mergeRateLimitWindows(livePlanUsage, saved, now) ──► donuts (+ "as of" label)
```

One new module (`ratelimitstore.ts`), one capture call (`agentstatusstore.ts`), one consumption
change (`usagesurface.tsx`). No Go, no new RPC.

## 4. `ratelimitstore.ts` (new)

### 4.1 Persisted shape — account-level fields only
```ts
export interface SavedSnapshot {
    fivehourpct?: number;
    fivehourreset?: number;   // absolute epoch seconds (matches AgentUsage)
    weekpct?: number;
    weekreset?: number;
    capturedAt: number;       // epoch ms (Date.now() at record time)
}
// localStorage["wave:ratelimits"] = Record<provider, SavedSnapshot>
```
`contextpct`/`contextmax`/`costusd` are **deliberately not persisted** — they are per-session,
not account-level, and meaningless once the session ends. The donuts only use the window fields.

### 4.2 Atom + persistence glue
- `savedRateLimitsAtom: PrimitiveAtom<Record<string, SavedSnapshot>>` — **seeded from
  localStorage at module load** (so donuts render on a fresh launch with no agent), defaulting
  to `{}` on any read/parse failure.
- `recordRateLimit(provider: string, usage: AgentUsage): void` — no-op unless `usage` carries a
  `fivehourpct` or `weekpct`; otherwise build a `SavedSnapshot` (window fields + `capturedAt =
  Date.now()`), merge into the atom under `provider`, and write through to localStorage. Write
  failures (quota/disabled) are swallowed — the in-memory atom still works for the session.

### 4.3 Pure merge (the heart, fully unit-tested)
```ts
export interface DonutWindow { pct?: number; reset?: number; }
export interface ProviderDonuts {
    provider: string;
    fivehour: DonutWindow;
    week: DonutWindow;
    stale?: { capturedAt: number };   // present iff sourced from a saved (not-live) snapshot
}

export function mergeRateLimitWindows(
    live: { provider: string; usage: AgentUsage }[],
    saved: Record<string, SavedSnapshot>,
    now: number,
): ProviderDonuts[]
```
Rules, per provider in the union of `live` keys and `saved` keys:
- **Live present** → use the live `usage` directly (`fivehour`/`week` from it), **no `stale`**.
  (The capture path has already written this same reading to `saved`, so they agree.)
- **Live absent, saved present** → build from the snapshot, applying **rollover per window**:
  if `reset != null && reset*1000 <= now`, the window rolled over → `{ pct: 0, reset: undefined }`;
  otherwise `{ pct, reset }`. Set `stale: { capturedAt }`.
- A provider whose snapshot has neither window after rollover (both rolled over and no pct) still
  renders (two empty rings + stale label) — acceptable; the label explains it.
- Sort claude-first (reuse the surface's `PROVIDER_RANK` ordering).

## 5. Capture wiring (`agentstatusstore.ts`)

At the existing usage-capture point (where `data.usage` sets `getAgentUsageAtom(data.oref)`),
add one call:

```ts
if (data.usage != null) {
    globalStore.set(getAgentUsageAtom(data.oref), data.usage);
    const provider = data.agent ?? globalStore.get(getAgentStatusAtom(data.oref))?.agent ?? "claude";
    recordRateLimit(provider, data.usage);
}
```
`recordRateLimit` self-guards on the presence of window fields, so usage-only events without
rate-limit data are ignored.

## 6. Consumption (`usagesurface.tsx`)

- Replace the live-only `planByProvider`/`planMap` with
  `mergeRateLimitWindows(providerPlanUsage([...asking, ...working, ...idle]), savedRateLimits, now)`,
  reading `savedRateLimitsAtom`.
- `providerKeys` already unions plan + token providers; the merged donut list now contributes
  the saved providers too, so a provider with only a saved snapshot still gets a section.
- Render each provider's two `Donut`s from the merged `fivehour`/`week`. When `stale` is set,
  render an **"as of {age} ago"** line beneath the donut pair (age = `now - capturedAt`, reusing
  the surface's existing relative-time formatting; a window with `reset === undefined` after
  rollover simply omits its "resets …" line — the existing `Donut` already treats `reset` as
  optional).
- The 1-second `nowAtom` tick already in the effect keeps both the countdowns and the "as of"
  age current.

## 7. Error handling

All localStorage access is best-effort: read/parse failure → `{}` (no saved snapshots); write
failure → swallowed. Malformed entries for a provider are ignored individually. Nothing throws
into the render path.

## 8. Testing

- **`mergeRateLimitWindows` (pure):** live-preferred (no `stale`); saved fallback sets `stale`;
  rollover when `reset*1000 <= now` (pct→0, reset→undefined) but not when reset is in the future;
  union of live+saved providers; claude-first order.
- **Persistence round-trip:** `recordRateLimit` writes only window fields (+`capturedAt`), drops
  context/cost; re-reading via the seed parses it back; non-window usage is a no-op; corrupt
  localStorage → `{}`. Use a mocked `localStorage`.
- **No live regression:** with a live agent present, the donut output equals today's behavior.

## 9. Out of scope / non-goals

- Cross-machine / cross-install sync (localStorage is per-origin, per-machine — intended).
- Persisting `contextpct`/`costusd` (per-session, not account-level).
- Codex donuts depend on the reporter wiring Codex `AgentUsage`; the store is provider-generic
  and will persist whatever is recorded, but Codex enablement is not part of this work.
- A backend store for rate limits — explicitly rejected in favor of pure-FE localStorage.

## 10. Self-review

- Placeholder scan: none.
- Consistency: `SavedSnapshot`, `savedRateLimitsAtom`, `recordRateLimit`, `mergeRateLimitWindows`,
  `ProviderDonuts`/`DonutWindow` names used identically across §4–§8. `reset` is epoch **seconds**
  (×1000 before comparing to `now` ms) — stated once in §4.1 and applied in §4.3.
- Scope: single surface + one new module; fits one plan.
- Ambiguity resolved: "live present" always wins and never shows `stale`, because the capture
  path keeps `saved` in lockstep with the live reading.
