# Channels legibility — pre-send chip + real-task subline

**Date:** 2026-07-03
**Scope:** Batch A of the Channels-tab improvement backlog (`docs/agents/channels-improvements.md`
items #5 and #7). Trivial scope — this document is both the design and the plan.
**Companion:** `docs/agents/channels-flows.md` (flow reference).

## Problem

Two hands-on friction points from the 2026-07-03 CDP test pass, both pure legibility (not
correctness):

- **#5 — invisible consequences.** `@claude x` spawns a persistent worker + tab (real cost, real
  side effects); `ask @claude x` is a disposable one-shot review. They differ by one word. Nothing
  in the composer tells you which one **Send** is about to do, so it is easy to spawn a worker when
  you wanted a quick answer.
- **#7 — paraphrased worker titles read as errors.** The fleet-panel roster labels a worker by its
  AI-generated title (a paraphrase of the task). A worker dispatched with `reply with token DELEG8`
  was titled "Provide delegation token," which read like a stuck auth prompt and cost an
  investigation. The literal task the user typed is not reliably shown for a live worker.

## Design

Both fixes surface information the code **already has** — no new backend, no new state, no new RPC.

### #5 — pre-send consequence chip

The composer already computes `planMessage(draft, roster)` on send (`channelmessages.ts`). It
returns a fully discriminated `MessagePlan` union. The chip renders that same plan live as the user
types, so it is a second read of a decision the code already makes.

A new pure helper in `channelmessages.ts` maps a plan to a chip (or nothing):

```ts
export interface PlanChip { label: string; tone: "warn" | "neutral"; }

export function describePlan(
    plan: MessagePlan,
    ctx: { tier: JarvisTier; projectName: string; roster: RosterEntry[]; delegatorMode: DispatchMode }
): PlanChip | null;
```

Mapping:

| `plan.kind` | Chip label | tone | Notes |
|---|---|---|---|
| `dispatch` | `→ spawns a worker in <projectName>` | `warn` | the side-effect case #5 targets |
| `jarvis` (delegator tier, non-empty goal) | `→ Jarvis dispatches a worker` | `warn` | decided via `planDelegate` |
| `jarvis` (otherwise) | `→ asks Jarvis` | `neutral` | observe-only summary |
| `consult` | `→ one-shot review · <runtimes>` | `neutral` | `plan.runtimes.join(", ")` |
| `steer` | `→ steers <name>` | `neutral` | name resolved from `roster` by `plan.targetId`, else "worker" |
| `post` | — (returns `null`) | — | plain notes show no chip (no noise) |

The delegator branch reuses `planDelegate({ tier, defaultMode: ctx.delegatorMode, override: plan.mode,
goal: plan.text })` — the chip is a pure composition of the two functions that already exist, so no
routing logic is duplicated.

**Rendering.** The parent surface (`channelssurface.tsx`) computes
`describePlan(planMessage(draft, roster), ctx)` and passes the result as a `chip` prop to the
presentational `Composer`. `Composer` renders it in the footer row, right-aligned immediately before
**Send**, so it reads as "this is what Send does":

```
┌──────────────────────────────────────────────────────────────┐
│ @claude fix the failing auth test                              │
│                                                                │
│ [@ mention agent]        → spawns a worker in waveterm  [Send ⏎]│
└──────────────────────────────────────────────────────────────┘
```

`warn` tone uses the existing amber `--color-asking` token (already used for the rail unread badge);
`neutral` uses `--color-muted`. No raw hex — `@theme` tokens only.

### #7 — real-task subline

`buildFleetSnapshot` (`jarvisderive.ts`) already captures the literal dispatch text in `dispatchInfo`
(`{ name: m.author, task: m.text }`) but only uses it as the fallback for **gone** workers. For a
**live** worker it returns `task: live.task`, which starts `""` and is filled asynchronously from
TodoWrite/activity — i.e. not "what I asked it to do."

Fix: carry the dispatch text through for live workers too.

- Add `dispatchTask?: string` to the `WorkerState` interface.
- In `buildFleetSnapshot`, set `dispatchTask: dispatchInfo.get(oref)?.task` on **both** the live and
  gone return paths.
- In `WorkerRow` (`channelssurface.tsx`), the subline text becomes `w.dispatchTask ?? w.task`, and
  gains a `title={w.dispatchTask ?? w.task}` so the truncated line reveals in full on hover.

The AI paraphrase stays the headline (`w.name`); the subline reliably shows the ground-truth task.
Workers present only via a `directive` (steered here, dispatched elsewhere) have no `dispatchInfo`
entry, so they fall back to `w.task` — unchanged from today.

## What this does NOT do

- No change to `planMessage` / `sendChannelMessage` routing — the chip is read-only.
- No new "current activity" line in the roster (YAGNI — #7 is about the asked-for task, which is the
  ambiguity that cost the investigation).
- No always-on chip for plain posts (would be noise).

## Testing

- `channelmessages.test.ts`: add `describePlan` cases — one per `kind`; the two `warn` cases
  (`dispatch`, delegator-`jarvis` with a goal) asserting label + `tone: "warn"`; the concierge/
  gatekeeper `jarvis` case asserting `→ asks Jarvis`; `post` asserting `null`; `steer` asserting the
  roster name resolves (and falls back to "worker" when absent).
- `jarvisderive.test.ts`: add a case asserting a **live** dispatched worker surfaces its
  `dispatchTask` (distinct from an empty/derived `live.task`), and that a directive-only worker has
  `dispatchTask` undefined.
- Visual confirmation over CDP (`:9222`) is deferred, per the repo's usual cockpit pattern (no
  render-test harness).

## Implementation

1. **`channelmessages.ts`** — add `PlanChip` interface + `describePlan(plan, ctx)`. Import nothing
   new; reuse `planDelegate`, `JarvisTier`, `DispatchMode`, `RosterEntry`, `MessagePlan` (all local).
2. **`channelmessages.test.ts`** — add the `describePlan` cases above (write first; red → green).
3. **`jarvisderive.ts`** — add `dispatchTask?: string` to `WorkerState`; set it from
   `dispatchInfo.get(oref)?.task` on both return paths in `buildFleetSnapshot`.
4. **`jarvisderive.test.ts`** — add the live-worker `dispatchTask` case.
5. **`channelssurface.tsx`** —
   - import `describePlan` (+ `PlanChip` type) from `./channelmessages`;
   - at the `Composer` call site, derive the active channel's `tier` (`tierFromMeta`), `projectName`,
     and `delegatorMode` (from channel meta, default `"report"`), compute
     `describePlan(planMessage(draft, roster), ctx)`, pass as `chip` prop;
   - extend `Composer` props with `chip?: PlanChip | null` and render it in the footer row before
     the Send button, tone-mapped to `text-asking` / `text-muted`;
   - change `WorkerRow` subline to `w.dispatchTask ?? w.task` with a matching `title`.
6. **Verify** — `npx vitest run channelmessages jarvisderive`; typecheck via
   `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline: ~3 pre-existing
   `api.test.ts` errors). CDP visual check deferred.

## Source touchpoints

- `frontend/app/view/agents/channelmessages.ts` — `describePlan` (new, pure).
- `frontend/app/view/agents/jarvisderive.ts` — `WorkerState.dispatchTask`, `buildFleetSnapshot`.
- `frontend/app/view/agents/channelssurface.tsx` — `Composer` chip prop + render, `WorkerRow` subline.
- Tests: `channelmessages.test.ts`, `jarvisderive.test.ts`.
