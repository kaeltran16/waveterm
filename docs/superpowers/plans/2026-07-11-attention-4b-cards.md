# Attention 4b Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every "needs you" attention card in the agent cockpit with the Wave-attention-4b treatment — a neutral card surface carrying a single filled-amber banner strip — sourced from `Wave-attention-4b.dc.html` in the `wave` Claude Design project.

**Architecture:** Extract one shared primitive (`AttentionCard` shell + `AttentionBanner` strip + `BannerChip`) as the single source of truth for the 4b look, then apply it across the four attention surfaces (cockpit grid card, channel escalation, runs review gate, runs clarify/fork). A consistency sweep retires the warm-wash `bg-lane-asking` / `ask-question` / `ask-label` tokens everywhere they remain.

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens), jotai, motion/react. Existing keyframes: `breatheGlow`, `pulseDot`, `flowBar`, `settle` (defined in `frontend/tailwindsetup.css`).

## Global Constraints

- **Tokens only — no raw hex in JSX or CSS utilities.** Every color comes from an existing `@theme` token (`frontend/tailwindsetup.css`). The 4b palette already exists: amber banner fill = `warning`/`asking` (`#e6b450`); banner ink = `on-warning` (`#1a1306`); neutral card surface = `lane` (`#12161b`); body text = `primary` (`#e6e9ed`). Dimmer on-amber meta uses opacity (`text-on-warning/60`), never a new hardcoded "dim amber". This constraint is explicit user direction and matches the existing convention (see `runworkercard.tsx:9`).
- **Do not hand-edit generated files.** No `task generate` output is touched by this plan (pure frontend/CSS work).
- **Green stays working/done, red stays blocked/error, amber is only "your turn."** Do not re-tone the red `BlockedCard` (worker-exited) — it is a genuine error, not an ask.
- **No new unit tests for visual restyle; do not break existing ones.** There is no jsdom/render harness (CLAUDE.md). Testing behavior-not-internals means we do not assert className strings. Verification per task = typecheck clean + existing vitest suite green + a live CDP screenshot of the affected surface.
- **Worktree:** Execution runs in an isolated git worktree (task requirement). NOTE: the global CLAUDE.md forbids worktrees and the `superpowers:using-git-worktrees` skill; the explicit per-task instruction "Use worktree" overrides the standing rule. Create the worktree with the **native `EnterWorktree` tool** (not the forbidden skill) as the first execution step.
- **Typecheck command (tsc stack-overflows normally):** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline is exit 0; any error it reports is yours.
- **Visual-verify recipe:** with `task dev` running, `node scripts/inject-live-agents.mjs <scenario>` to populate an asking card, then `node scripts/cdp-shot.mjs <out.png>` to capture the WebView2 page. `channelssurface`/`runssurface` need a channel/run with a pending gate or escalation.

---

## File Structure

- **Create:** `frontend/app/view/agents/attentioncard.tsx` — the shared 4b primitives (`AttentionCard`, `AttentionBanner`, `BannerChip`). One responsibility: the neutral-card-plus-amber-banner treatment.
- **Modify:** `frontend/app/view/agents/agentrow.tsx` — cockpit grid card asking state → 4b.
- **Modify:** `frontend/app/view/agents/channelssurface.tsx` — `EscalationRow` → 4b; the two small `bg-lane-asking` pills (lines ~842, ~1113) swept.
- **Modify:** `frontend/app/view/agents/runssurface.tsx` — `ReviewGateCard`, `AskCard`, `TriageChip` → 4b.
- **Modify:** `frontend/app/view/agents/channelsprimitives.tsx` — `AskRow` option-list wrapper → neutral surface.
- **Modify:** `frontend/app/view/agents/agenttree.tsx` — asking-row tint → faint token amber.
- **Modify:** `frontend/tailwindsetup.css` and `frontend/app/view/agents/themes.ts` — retire `lane-asking` / `ask-question` / `ask-label` after all references are gone.

---

### Task 1: Shared 4b primitives (`attentioncard.tsx`)

**Files:**
- Create: `frontend/app/view/agents/attentioncard.tsx`

**Interfaces:**
- Produces:
  - `AttentionBanner({ label: string; meta?: string; right?: ReactNode; pulse?: boolean; glyph?: "dot" | "diamond"; className?: string })`
  - `BannerChip({ children: ReactNode })`
  - `AttentionCard({ glow?: boolean; className?: string; children: ReactNode })`
- Consumes: `cn` from `@/util/util`; `warning`, `on-warning`, `lane` tokens; `pulseDot` + `breatheGlow` keyframes.

- [ ] **Step 1: Write the file**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The 4b "attention" treatment (Wave-attention-4b.dc.html · TURN 4b, "solid callout banner"). A "needs
// you" surface reads as a neutral card carrying one filled-amber banner strip — not a warm-washed card.
// Amber lives only in the banner (bg-warning / text-on-warning, full contrast); the body sits on the
// neutral lane surface with normal light text. Shared so every attention surface (cockpit grid card,
// channel escalation, runs review gate, runs clarify/fork) reads identically. Tokens only — no raw hex.

import { cn } from "@/util/util";
import type { ReactNode } from "react";

// The amber banner strip: a leading glyph (◆ diamond, or a pulsing dot for a live ask), an uppercase
// mono label, optional meta (elapsed), and an optional right-aligned slot (e.g. a BannerChip). Ink is
// on-warning throughout; dimmer meta uses on-warning at reduced opacity so we never introduce an
// off-palette "dim amber ink".
export function AttentionBanner({
    label,
    meta,
    right,
    pulse,
    glyph = "dot",
    className,
}: {
    label: string;
    meta?: string;
    right?: ReactNode;
    pulse?: boolean;
    glyph?: "dot" | "diamond";
    className?: string;
}) {
    return (
        <div className={cn("flex shrink-0 items-center gap-2 bg-warning px-3.5 py-2", className)}>
            {glyph === "diamond" ? (
                <span className="shrink-0 font-mono text-[11px] leading-none text-on-warning">◆</span>
            ) : (
                <span
                    className={cn(
                        "h-[7px] w-[7px] shrink-0 rounded-full bg-on-warning",
                        pulse && "animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none"
                    )}
                />
            )}
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.09em] text-on-warning">
                {label}
            </span>
            {meta ? <span className="font-mono text-[9.5px] font-semibold text-on-warning/60">{meta}</span> : null}
            <div className="min-w-[6px] flex-1" />
            {right}
        </div>
    );
}

// A right-aligned chip that reads on the amber banner (e.g. "3/5"): dark ink on a faint dark tint.
export function BannerChip({ children }: { children: ReactNode }) {
    return (
        <span className="shrink-0 rounded-[5px] border border-on-warning/20 bg-on-warning/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-on-warning">
            {children}
        </span>
    );
}

// The neutral card shell: lane surface, amber hairline border, rounded + clipped so the banner's top
// corners follow the radius. `glow` adds the existing breathing drop-shadow for an unanswered ask
// (moment-3 attention). Compose AttentionBanner as its first child.
export function AttentionCard({
    glow,
    className,
    children,
}: {
    glow?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                "overflow-hidden rounded-[13px] border border-warning/40 bg-lane",
                glow && "animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none",
                className
            )}
        >
            {children}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (new file only; nothing imports it yet).

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/attentioncard.tsx
git commit -m "feat(agents): shared 4b attention-card primitives"
```

---

### Task 2: Cockpit grid card → 4b (`agentrow.tsx`)

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (asking wash `:335`, header `needs you` pill `:375-379`, asking band `:426-440`)

**Interfaces:**
- Consumes: `AttentionBanner`, `BannerChip` from `./attentioncard`; existing `formatAge(agent.activeMs)`.

- [ ] **Step 1: Import the primitives**

Add to the import block (near the other `./` imports):

```tsx
import { AttentionBanner, BannerChip } from "./attentioncard";
```

- [ ] **Step 2: Drop the warm wash — asking card goes neutral**

Replace (`:334-336`):

```tsx
                asking
                    ? "border-warning/40 bg-lane-asking animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
                    : "border-edge-mid bg-lane",
```

with:

```tsx
                asking
                    ? "border-warning/40 bg-lane animate-[breatheGlow_2.4s_ease-in-out_infinite] motion-reduce:animate-none"
                    : "border-edge-mid bg-lane",
```

- [ ] **Step 3: Remove the header `needs you` pill** (the banner now carries the signal; the amber `StatusDot` still marks the header)

Delete (`:375-379`):

```tsx
                {asking ? (
                    <span className="shrink-0 rounded-[4px] bg-warning px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.05em] text-on-warning">
                        needs you
                    </span>
                ) : null}
```

- [ ] **Step 4: Replace the asking band with the 4b banner + neutral question**

Replace the whole asking-band block (`:426-440`):

```tsx
            {/* asking band */}
            {asking ? (
                <div className="shrink-0 border-b border-edge-mid px-3.5 py-2.5">
                    <div className="mb-1.5 flex items-center gap-2">
                        <span className="font-mono text-[8.5px] font-bold uppercase tracking-[0.1em] text-ask-label">
                            Waiting on you
                        </span>
                        <div className="flex-1" />
                        {prog ? <TaskChip done={prog.done} total={prog.total} onClick={() => setTasksOpen((v) => !v)} /> : null}
                    </div>
                    {question ? (
                        <p className="text-[14px] font-semibold leading-[1.5] text-ask-question">{question}</p>
                    ) : null}
                </div>
            ) : null}
```

with:

```tsx
            {/* asking banner (4b) — amber strip carries the "your turn" signal; question reads neutral */}
            {asking ? (
                <>
                    <AttentionBanner
                        glyph="diamond"
                        label="Waiting on you"
                        meta={formatAge(agent.activeMs)}
                        pulse
                        right={
                            prog ? (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setTasksOpen((v) => !v);
                                    }}
                                    title="Show task list"
                                    className="cursor-pointer"
                                >
                                    <BannerChip>
                                        {prog.done}/{prog.total}
                                    </BannerChip>
                                </button>
                            ) : null
                        }
                    />
                    {question ? (
                        <p className="shrink-0 border-b border-edge-mid px-3.5 py-2.5 text-[14px] font-semibold leading-[1.5] text-primary">
                            {question}
                        </p>
                    ) : null}
                </>
            ) : null}
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. (`text-ask-label`/`text-ask-question` no longer referenced here; tokens still exist until Task 7.)

- [ ] **Step 6: Vitest stays green**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS (no logic changed).

- [ ] **Step 7: Visual verify**

With `task dev` running: `node scripts/inject-live-agents.mjs asking` (a scenario with an asking agent), then `node scripts/cdp-shot.mjs attention-grid.png`. Confirm: neutral card body, one filled-amber banner strip (◆ Waiting on you · age · N/N chip), question in bright neutral text, amber card border + breathing glow. No warm wash.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/agentrow.tsx
git commit -m "feat(agents): 4b banner on the cockpit asking card"
```

---

### Task 3: Channel escalation card → 4b (`channelssurface.tsx`)

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`EscalationRow`, the amber bubble at `:401-436`)

**Interfaces:**
- Consumes: `AttentionCard`, `AttentionBanner`, `BannerChip` from `./attentioncard`; existing `OptionList`, `parseCardData`, `escalationPending`, `workerFor`.

- [ ] **Step 1: Import the primitives**

Add near the other local imports in `channelssurface.tsx`:

```tsx
import { AttentionCard, AttentionBanner, BannerChip } from "./attentioncard";
```

- [ ] **Step 2: Replace the amber bubble with AttentionCard + banner**

Replace the escalation body wrapper (`:401-436`) — the `<div className={cn("rounded-[9px] border border-asking/40 bg-lane-asking ...")}>` and its contents — with the 4b card. The banner label + `from <worker>` chip live in the strip; the reason drops to muted, the question to primary, and `OptionList` renders unchanged:

```tsx
                <AttentionCard glow={pending && chosen == null}>
                    <AttentionBanner
                        label="Escalated to you — a decision Jarvis can't make"
                        pulse={pending && chosen == null}
                        right={<BannerChip>from {workerName}</BannerChip>}
                    />
                    <div className="px-3.5 py-3">
                        {card ? (
                            <>
                                {card.reason ? (
                                    <p className="mb-2 text-[12.5px] leading-[1.55] text-ink-mid">
                                        <span className="text-muted">Why I'm not deciding this: </span>
                                        {card.reason}
                                    </p>
                                ) : null}
                                <p className="mb-3 text-[14px] font-semibold leading-[1.5] text-primary">{card.question}</p>
                                {pending && chosen == null ? (
                                    <OptionList options={card.options} onPick={deliver} />
                                ) : chosen != null ? (
                                    <div className="flex items-center gap-2 text-[12px] text-secondary">
                                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                        You chose <b className="text-primary">{card.options[chosen]?.label}</b> — sent to{" "}
                                        {workerName}, resuming.
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 text-[12px] text-secondary">
                                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                        {worker ? `Answered — ${workerName} resumed.` : `${workerName} has exited.`}
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="whitespace-pre-wrap text-[13px] leading-[1.55] text-secondary">{msg.text}</div>
                        )}
                    </div>
                </AttentionCard>
```

Note: the old wrapper's `breatheGlow` moves to `AttentionCard`'s `glow` prop (same keyframe). The `Tag label="escalation"` and jarvis author row above the card are unchanged.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Vitest stays green**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS.

- [ ] **Step 5: Visual verify**

Open a channel with a pending escalation (inject or trigger one), `node scripts/cdp-shot.mjs attention-escalation.png`. Confirm: neutral card, amber banner "Escalated to you… · from <worker>", muted reason, neutral question, radio options; glow only while unanswered.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): 4b treatment on the channel escalation card"
```

---

### Task 4: Runs review gate → 4b (`runssurface.tsx`)

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (`ReviewGateCard`, `:208-254`)

**Interfaces:**
- Consumes: `AttentionCard`, `AttentionBanner` from `./attentioncard`; existing `PlanPreview`, `approveGate`, `sendBackGate`, `resolveArtifactPath`.

- [ ] **Step 1: Import the primitives**

Add near the other local imports in `runssurface.tsx`:

```tsx
import { AttentionCard, AttentionBanner } from "./attentioncard";
```

- [ ] **Step 2: Rebuild the gate with card + banner**

Replace the `ReviewGateCard` return (`:212-253`). The banner replaces the subtle header row; the amber `text-asking` label + dot become the filled strip; the artifact name moves to the banner `meta`. Buttons unchanged (accent primary "Approve", neutral "Send back"):

```tsx
    return (
        <AttentionCard className="mt-3 max-w-[760px]" >
            <AttentionBanner
                glyph="diamond"
                label="Review gate — your approval needed"
                meta={artifact ?? undefined}
            />
            <div className="px-3.5 pt-2.5 text-[11.5px] text-ink-mid">
                {run.mode === "orchestrator" ? "Plan ready — approve to let the lead proceed." : "Approve before execution starts."}
            </div>
            {artifact ? (
                <PlanPreview
                    path={resolveArtifactPath(run.projectpath, artifact)}
                    onEditorReady={(flush) => {
                        flushRef.current = flush;
                    }}
                />
            ) : null}
            <div className="flex items-center gap-2.5 px-3.5 py-3">
                <button
                    type="button"
                    onClick={() =>
                        fireAndForget(async () => {
                            await flushRef.current(); // persist any unsaved plan edit first
                            await approveGate(channelId, run.id, gateIdx);
                        })
                    }
                    className="rounded-[8px] bg-accent px-4 py-2 text-[12px] font-bold text-background hover:bg-accent/90"
                >
                    {run.mode === "orchestrator" ? "Approve & proceed" : "Approve & execute"}
                </button>
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => fireAndForget(() => sendBackGate(channelId, run.id, gateIdx))}
                    className="rounded-[8px] border border-edge-mid px-3 py-2 text-[12px] font-semibold text-secondary hover:border-asking hover:text-asking"
                >
                    Send back
                </button>
            </div>
        </AttentionCard>
    );
```

Note: `AttentionCard` uses `rounded-[13px]`; the old gate used `rounded-[12px]` — accept the shared radius for consistency. `meta` takes `undefined` (not `null`) when no artifact — coerce with `artifact ?? undefined`.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: Vitest stays green**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS (`runmodel.test.ts` etc. unaffected).

- [ ] **Step 5: Visual verify**

Open a run stopped at a plan gate, `node scripts/cdp-shot.mjs attention-gate.png`. Confirm: neutral card, amber banner "Review gate — your approval needed · <plan>.md", plan preview, Approve/Send back row.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/runssurface.tsx
git commit -m "feat(runs): 4b banner on the review gate"
```

---

### Task 5: Runs clarify/fork + shared AskRow → 4b (`runssurface.tsx`, `channelsprimitives.tsx`)

**Files:**
- Modify: `frontend/app/view/agents/runssurface.tsx` (`AskCard` `:256-268`, `TriageChip` `:316`)
- Modify: `frontend/app/view/agents/channelsprimitives.tsx` (`AskRow` wrapper `:103`)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`MessageRow` inline dispatch-asking `AskRow` caller `:486-490`)

**Interfaces:**
- Consumes: `AttentionCard`, `AttentionBanner` from `./attentioncard` (already imported in `channelssurface.tsx` since Task 3); existing `AskRow`.

**Scope note (discovered during execution):** `AskRow` has a second caller — the inline answer prompt in `MessageRow` (`channelssurface.tsx:486-490`) shown when a dispatched worker is `asking`. This is the 4b "cockpit focus feed" attention surface. Because Step 2 makes `AskRow`'s own wrapper neutral, this caller must also be wrapped in an `AttentionCard`/banner (Step 1b) so it keeps its amber cue. Both `AskRow` ask-callers then own an attention banner, so the neutral inner wrapper is correct everywhere.

- [ ] **Step 1: `AskCard` → card + banner**

Replace `AskCard` (`:256-268`). The loose label row becomes the filled banner; `AskRow` renders in the body:

```tsx
function AskCard({ model, agent, kind }: { model: AgentsViewModel; agent: AgentVM; kind: "clarify" | "fork" }) {
    return (
        <AttentionCard className="mt-3 max-w-[760px]" glow>
            <AttentionBanner
                glyph="diamond"
                label={kind === "clarify" ? "Clarifying question" : "Escalated to you — a decision Jarvis can't make"}
                pulse
            />
            <div className="px-3.5 py-3">
                <AskRow model={model} agent={agent} />
            </div>
        </AttentionCard>
    );
}
```

- [ ] **Step 1b: Wrap the inline dispatch-asking `AskRow` caller in an attention card** (`channelssurface.tsx:486-490`)

Replace:

```tsx
                {isDispatch && worker && worker.state === "asking" ? (
                    <div className="mt-2">
                        <AskRow model={model} agent={worker} />
                    </div>
                ) : null}
```

with:

```tsx
                {isDispatch && worker && worker.state === "asking" ? (
                    <AttentionCard glow className="mt-2">
                        <AttentionBanner label="Awaiting your reply" pulse />
                        <div className="px-3.5 py-3">
                            <AskRow model={model} agent={worker} />
                        </div>
                    </AttentionCard>
                ) : null}
```

(`AttentionCard`/`AttentionBanner` are already imported in this file from Task 3. Default `glyph="dot"` so `pulse` animates a visible amber dot — matching the 4b focus-feed banner.)

- [ ] **Step 2: `AskRow` wrapper goes neutral** (`channelsprimitives.tsx:103`)

Replace:

```tsx
        <div className="rounded-[9px] border border-asking/40 bg-lane-asking p-3">
```

with:

```tsx
        <div className="rounded-[9px] border border-edge-mid bg-lane p-3">
```

(`AskRow` is now always rendered inside an `AttentionCard`/banner where used for asks — the `AskCard` (Step 1) and the inline `MessageRow` caller (Step 1b) — so a neutral inner surface reads correctly against the amber banner. Both ask-callers verified: no remaining caller depends on the amber wrapper.)

- [ ] **Step 3: `TriageChip` drops the warm wash** (`runssurface.tsx:316`)

Replace:

```tsx
    const tone = quick ? "text-success border-success/40 bg-success/10" : "text-asking border-asking/40 bg-lane-asking";
```

with:

```tsx
    const tone = quick ? "text-success border-success/40 bg-success/10" : "text-asking border-asking/40 bg-warning/10";
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: Vitest stays green**

Run: `npx vitest run frontend/app/view/agents`
Expected: PASS.

- [ ] **Step 6: Visual verify**

Trigger a clarify/fork ask in a run, `node scripts/cdp-shot.mjs attention-ask.png`. Confirm neutral card + amber banner + option list; TriageChip on a plan verdict reads as a faint-amber outlined chip, not a warm block.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/agents/runssurface.tsx frontend/app/view/agents/channelsprimitives.tsx frontend/app/view/agents/channelssurface.tsx
git commit -m "feat(agents): 4b treatment on clarify/fork asks, inline focus-feed ask, and triage chip"
```

---

### Task 6: Consistency sweep — remaining `bg-lane-asking` sites

**Files:**
- Modify: `frontend/app/view/agents/agenttree.tsx` (`:76`)
- Modify: `frontend/app/view/agents/channelssurface.tsx` (`:842`, `:1113`)

**Interfaces:** none (self-contained restyle).

- [ ] **Step 1: Tree asking-row tint → faint token amber** (`agenttree.tsx:76`)

Replace:

```tsx
                    selected ? "bg-accentbg" : asking ? "bg-lane-asking" : "hover:bg-surface-hover",
```

with:

```tsx
                    selected ? "bg-accentbg" : asking ? "bg-warning/[0.06]" : "hover:bg-surface-hover",
```

- [ ] **Step 2: Sweep the two channel pills** (`channelssurface.tsx:842`, `:1113`)

In each, replace `bg-lane-asking` with `bg-warning/10` (keep the surrounding `border-asking/40` / `border-asking/50` — a faint amber tint reads correctly now that lane-asking is retired). Read each line first to preserve the rest of its className.

- [ ] **Step 3: Confirm zero remaining JSX references**

Run: `rg "bg-lane-asking|text-ask-question|text-ask-label" frontend/app`
Expected: no matches.

- [ ] **Step 4: Typecheck + vitest**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0)
Run: `npx vitest run frontend/app/view/agents` (PASS)

- [ ] **Step 5: Visual verify**

`node scripts/cdp-shot.mjs attention-tree.png` on the list/tree view with an asking agent — the row shows a faint amber tint, not the old warm block.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/agenttree.tsx frontend/app/view/agents/channelssurface.tsx
git commit -m "refactor(agents): sweep remaining warm-wash asking tints to token amber"
```

---

### Task 7: Retire the warm-wash tokens

**Files:**
- Modify: `frontend/tailwindsetup.css` (`:19`, `:64`, `:65`)
- Modify: `frontend/app/view/agents/themes.ts` (`:214-215`)

**Interfaces:** none.

- [ ] **Step 1: Re-confirm no references remain**

Run: `rg "lane-asking|ask-question|ask-label" frontend`
Expected: only the definition sites (`tailwindsetup.css`, `themes.ts`). If any JSX reference survives, return to Tasks 2–6 — do not delete a token still in use.

- [ ] **Step 2: Remove the `@theme` definitions** (`tailwindsetup.css`)

Delete these three lines:

```css
    --color-lane-asking: #14130e; /* warm-dark asking-lane fill (handoff laneBg, asking) */
```
```css
    --color-ask-question: #fcf7ec; /* asking-band question prose (bright warm-white for readability) */
    --color-ask-label: #c79a3f; /* "waiting on you" label */
```

- [ ] **Step 3: Remove the theme-derived overrides** (`themes.ts:214-215`)

Delete:

```ts
        "--color-ask-question": lighten(p.warning, 0.89),
        "--color-ask-label": darken(p.warning, 0.28),
```

Verify `lighten`/`darken` remain used elsewhere in the file (grep) before assuming any import is now dead — do not remove imports still referenced.

- [ ] **Step 4: Typecheck + vitest**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (exit 0)
Run: `npx vitest run frontend/app/view/agents` (PASS)

- [ ] **Step 5: Full visual regression pass**

Re-capture each surface (grid, escalation, gate, ask, tree) with the recipe above under at least the default theme and one alternate theme (theme switcher) to confirm the amber banner reads at full contrast in both and nothing renders an undefined-color fallback.

- [ ] **Step 6: Commit**

```bash
git add frontend/tailwindsetup.css frontend/app/view/agents/themes.ts
git commit -m "refactor(theme): retire warm-wash lane-asking/ask-question/ask-label tokens"
```

---

## Self-Review

**Spec coverage** (vs `Wave-attention-4b.dc.html` TURN 4b):
- Review gate → Task 4. ✔
- Escalated fork → Task 3 (channel) + Task 5 (runs `AskCard` fork). ✔
- Clarifying question → Task 5 (`AskCard` clarify). ✔
- Blocked on you / asking (grid + panel) → Task 2 (grid card). ✔
- Live-agents grid card BEFORE→NEW → Task 2. ✔
- "Green stays working/done, red stays blocked/error" → honored (red `BlockedCard` untouched; constraint stated). ✔
- Turns 5 & 6 (spotlight / urgency-meter / spine-pill alternatives) → intentionally **out of scope** — the task says "4b cards"; 5/6 are explicitly labelled alternatives to 4b in the design. ✔
- Cockpit focus-feed "Awaiting your reply" banner (design "In context" section) → the same `AttentionBanner` primitive is available if that surface is later re-toned; not a currently warm-washed card in our code, so not required by "replace existing attention cards." Noted, not tasked.

**Placeholder scan:** no TBD/"handle edge cases"/"similar to Task N" — every edit shows exact old→new code. ✔

**Type consistency:** `AttentionBanner` / `AttentionCard` / `BannerChip` signatures defined in Task 1 are used with matching props in Tasks 2–5 (`glyph`, `meta`, `pulse`, `right`, `glow`, `className`, `children`). `meta` is `string | undefined` — Task 4 coerces `artifact ?? undefined`. ✔

**Open decision for the reviewer:** the shared radius is `rounded-[13px]` (grid card's value); the old gate/escalation used `12px`/`9px`. The plan standardizes on `13px` for a single card shell. If a per-surface radius is required, add a `className` radius override at the call site instead of forking the primitive.
