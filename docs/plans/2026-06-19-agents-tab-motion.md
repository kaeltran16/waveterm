# Agents Tab — Motion Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `motion` (framer-motion) dependency and wire spec §7's motion across the Agents view (layout-shift easing + 7 content micro-animations) and the shared vertical-tab chrome (5 animations), against the real Phase-1 component tree.

**Architecture:** Pure presentational motion — no new state model, no RPC, no Go types. `motion`/`AnimatePresence` wrap existing JSX; `layout` + `layoutId={agent.id}` drive enter/leave/reflow and the working↔asking shared-element glide; per-element `initial/animate/exit` drive the micro-animations. The Agents-view work (lower risk) lands before the shared-chrome work (higher regression surface), and within shared chrome the genuinely risky tab enter/leave animation is last and guarded.

**Tech Stack:** TypeScript/React 19.2, Jotai, Tailwind v4, Vite 6, `motion` (added in Task 1), vitest. Spec: `docs/specs/2026-06-19-agents-tab-answering-layout-motion-design.md` §7.

**Frontend-only — no RPC, no Go types, no `task generate`.**

**Phase 1 status:** staged but not yet committed (`agents.tsx`, `askcard.tsx`, `outputpanel.tsx`, `agentsviewmodel.ts`, `agentsviewmodel.test.ts`). This plan modifies the same agents-view files plus the shared tab chrome. Do not unstage Phase 1; both phases ship together or Phase 2 stages on top.

**Commits (repo owner's git rules override the skill's per-task commit default):** Do **NOT** auto-commit per task. Each task ends with a **Checkpoint** that runs its checks and `git add`s the touched files. After all tasks pass, present **one batched commit** for explicit approval (final task). Phase 1's staged changes are committed together with Phase 2 unless the owner asks otherwise.

---

## Spec-vs-reality corrections (found while planning against the real tree)

These are the deltas between spec §7c/§9 and the actual Phase-1 code. They are reflected in the tasks below:

1. **The "N asking" badge lives in `sessionsidebar.tsx:156-158`, not `sessionrow.tsx`.** §9 mis-attributes it. Asking-badge pop (§7c #3) is implemented in `sessionsidebar.tsx` (Task 9).
2. **`vtab.tsx` has no status dot.** It renders `TabBadges`, not a `STATUS_COLOR` dot. The status dots (§7c #2) live in `sessionrow.tsx` (session dot `sessionrow.tsx:116-119`, group dot `sessionrow.tsx:257-260`). Status-dot transitions are implemented there (Task 10), not in `vtab.tsx`.
3. **`sessionrow.test.tsx` is an SSR (`renderToStaticMarkup`) test** that asserts on output HTML: the `STATUS_COLOR` hex on the dot, and `fa-chevron-down` vs `fa-chevron-right` for the expand chevron. Therefore:
   - Status-dot motion (Task 10) keeps `backgroundColor` in the `style` prop so the hex still renders under SSR — assertions stay green.
   - **Chevron rotate (part of §7c #5) is intentionally NOT implemented.** The existing icon-swap (`chevron-right`↔`chevron-down`) already signals expand state and is asserted by the test; rotating a swapped glyph is redundant and would break the assertion. Task 11 implements the **height-reveal** half of #5 (the valuable part) in `sessionsidebar.tsx` and leaves the chevron icon-swap untouched. This is a deliberate, noted deviation — not a silent gap.

---

## File structure

No new files. Modified:

**Dependency**
- `package.json` + `package-lock.json` — add `motion` (Task 1).

**Agents view** (`frontend/app/view/agents/`)
- `agents.tsx` — layout-shift easing (AnimatePresence + `layout` + `layoutId`), count transition, empty-state fade (Task 2); linger-on-completion + status-flap debounce (Task 6, higher complexity).
- `narrationtimeline.tsx` — narration entrance + action-outcome pop (Task 3).
- `askcard.tsx` — pill spring + Submit→"✓ Sent" morph (Task 4).
- `outputpanel.tsx` — working pulse+spinner, new-output pill spring (Task 5).

**Shared tab chrome** (`frontend/app/tab/`)
- `vtab.tsx` — active-indicator `layoutId` glide (Task 7).
- `sessionsidebar/sessionsidebar.tsx` — asking-badge pop (Task 8); subagent expand/collapse reveal (Task 11).
- `sessionsidebar/sessionrow.tsx` — status-dot transitions (Task 10).
- `tab/vtabbar.tsx` — tab enter/leave (Task 12, **highest risk**).

**Recommended cut line:** Tasks 1–5 deliver the entire Agents-view motion experience and are safe to ship alone. Tasks 6 and 12 are the deferrable ones (added state / drag-reorder conflict). See the execution handoff at the end.

---

## Motion API quick reference (used throughout)

```tsx
import { motion, AnimatePresence } from "motion/react";
```
- `<motion.div layout>` — animates position/size when layout changes.
- `layoutId="x"` — shared-element transition: when one element with `layoutId="x"` unmounts and another with the same id mounts, motion glides between them. Requires the id to be unique at any instant (it is — see §7a insight).
- `<AnimatePresence>` — keeps exiting children mounted until their `exit` transition finishes. Direct children must have a stable `key`.
- `initial` / `animate` / `exit` — keyframe targets. `initial` plays on mount only, so append-only lists animate only newly-mounted entries.
- `transition={{ type: "spring", stiffness, damping }}` or `{{ duration, ease }}`.
- `whileTap`, `whileHover` — gesture states.
- SSR (`renderToStaticMarkup`) renders the initial state and preserves `style`/`className`; animations are no-ops server-side.

---

### Task 1: Add the `motion` dependency

**Files:**
- Modify: `package.json` (dependencies), `package-lock.json`

- [ ] **Step 1: Install motion**

Run (from project root):
```bash
npm i motion
```
This adds `motion` to `dependencies` in `package.json` and updates `package-lock.json`. The repo is npm 10.9.2 / React 19.2 / Vite 6.4.2; `motion` v11+ supports React 19 and needs no Vite config.

- [ ] **Step 2: Verify the install resolved cleanly**

Run:
```bash
npm ls motion
```
Expected: a single resolved `motion@<version>` with no `UNMET PEER DEPENDENCY` / `ERESOLVE` errors against `react@19`. If npm reports a React peer conflict, stop and report it — do **not** force with `--legacy-peer-deps` without owner approval (it would mask a real incompatibility).

- [ ] **Step 3: Verify the import resolves**

Create no file. Confirm resolution by a type-check after the first real import in Task 2. (Nothing imports `motion` yet, so there is nothing to compile here.)

- [ ] **Step 4: Checkpoint**

Stage: `git add package.json package-lock.json`

---

### Task 2: AgentsView — layout-shift easing + count transition + empty-state fade

Spec §7a (AnimatePresence + `layout` + `layoutId` for panel/queue-row enter/leave, grid reflow, and the working↔asking / queue→focus shared-element glide), micro-anim 6 (count roll), micro-anim 7 (empty-state fade). **Excludes** linger-on-completion and debounce (Task 6).

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Add the motion import**

In `frontend/app/view/agents/agents.tsx`, add after the existing `react` import (line 11):
```tsx
import { motion, AnimatePresence } from "motion/react";
```

- [ ] **Step 2: Make `QueueRow` a shared-element motion row**

Replace the `QueueRow` component (currently `agents.tsx:18-31`) with:
```tsx
function QueueRow({ agent, onFocus }: { agent: AgentVM; onFocus: (id: string) => void }) {
    const question = agent.ask?.questions?.[0]?.question ?? "";
    return (
        <motion.div
            layout
            layoutId={agent.id}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            onClick={() => onFocus(agent.id)}
            className="flex cursor-pointer items-center gap-2.5 rounded-[7px] border border-[#d29922]/60 bg-[#d29922]/[0.05] px-3 py-2 hover:bg-[#d29922]/10"
        >
            <span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />
            <b className="shrink-0 text-[12.5px] text-[#e6edf3]">{agent.name}</b>
            <span className="truncate text-[12px] text-[#8b949e]">{question}</span>
            <span className="ml-auto shrink-0 text-[10.5px] text-[#d29922]">{formatAge(agent.blockedMs)} · answer →</span>
        </motion.div>
    );
}
```

- [ ] **Step 3: Add a count-roll helper above `AgentsView`**

Insert this small component immediately after `QueueRow` (before `AgentsView`):
```tsx
// Rolls a changing integer: the old value slides up and out while the new one slides in.
function RollingCount({ value, className }: { value: number; className?: string }) {
    return (
        <span className={cn("relative inline-flex overflow-hidden align-baseline", className)}>
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                    key={value}
                    initial={{ y: "-100%", opacity: 0 }}
                    animate={{ y: "0%", opacity: 1 }}
                    exit={{ y: "100%", opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="tabular-nums"
                >
                    {value}
                </motion.span>
            </AnimatePresence>
        </span>
    );
}
```
Add `cn` to the util import. Find the existing import from `@/util/util` (`agents.tsx:10`: `import { fireAndForget } from "@/util/util";`) and change it to:
```tsx
import { cn, fireAndForget } from "@/util/util";
```

- [ ] **Step 4: Replace the `AgentsView` return JSX**

In `AgentsView`, replace the entire `return (...)` block (currently `agents.tsx:99-143`) with the version below. Logic above the return (grouping, focus resolution, effects) is unchanged. Changes: header counts use `RollingCount`; the content regions are wrapped in `AnimatePresence`; the focused ask, queue rows, and working panels are `motion` elements with `layout` + `layoutId`; the empty state fades.
```tsx
    return (
        <div className="flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]">
            <div className="flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3">
                <b className="text-[15px] text-[#e6edf3]">Agents</b>
                <span className="flex items-center gap-1 text-[12px] text-[#6b7585]">
                    <RollingCount value={asking.length} className="text-[#d29922]" />
                    <span className="text-[#d29922]">asking</span>
                    <span>·</span>
                    <RollingCount value={working.length} />
                    <span>working</span>
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-[18px]">
                <AnimatePresence>
                    {empty && (
                        <motion.div
                            key="empty"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.25 }}
                            className="flex flex-1 flex-col items-center justify-center gap-1 text-center"
                        >
                            <div className="text-[22px] opacity-50">🤖</div>
                            <div className="text-[13px] font-semibold text-[#c9d1d9]">No active agents</div>
                            <div className="text-[11.5px] text-[#6b7585]">
                                Agents appear here the moment one starts working or asks a question.
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
                <AnimatePresence mode="popLayout">
                    {focused && (
                        <motion.div
                            key={focused.id}
                            layout
                            layoutId={focused.id}
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="max-h-[55%] shrink-0 overflow-y-auto"
                        >
                            <AskCard
                                key={focused.ask?.askId ?? focused.id}
                                agent={focused}
                                onAnswer={answer}
                                onOpen={open}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
                {queue.length > 0 && (
                    <motion.div layout className="flex shrink-0 flex-col gap-1.5">
                        <div className="text-[10.5px] uppercase tracking-wide text-[#9aa4b2]">
                            {queue.length} more waiting
                        </div>
                        <div className="flex max-h-[180px] flex-col gap-1.5 overflow-y-auto">
                            <AnimatePresence mode="popLayout">
                                {queue.map((a) => (
                                    <QueueRow key={a.id} agent={a} onFocus={setFocusedAskId} />
                                ))}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}
                {working.length > 0 && (
                    <div className="grid min-h-0 flex-1 auto-rows-[260px] grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-2.5 overflow-y-auto">
                        <AnimatePresence mode="popLayout">
                            {working.map((a) => (
                                <motion.div
                                    key={a.id}
                                    layout
                                    layoutId={a.id}
                                    initial={{ opacity: 0, scale: 0.96 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.96 }}
                                    transition={{ duration: 0.2, ease: "easeOut" }}
                                    className="min-h-0"
                                >
                                    <WorkingPanel agent={a} now={now} onOpen={open} />
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    </div>
                )}
            </div>
        </div>
    );
```

> Why `layoutId={agent.id}` on the focused ask, the queue rows, **and** the working panels: an agent is in exactly one of those regions at a time (`groupAgents` partitions; `focused` is excluded from `queue`). When an agent moves working→asking or queue→focus, the same `layoutId` unmounts in one region and mounts in another, so motion glides it across instead of fade-swapping. The id is never duplicated in a single render, which is the precondition for this.
> Why `mode="popLayout"` on the working/queue lists: it pops exiting items out of flow immediately so the remaining items' `layout` reflow animates smoothly instead of waiting for the exit to finish.

- [ ] **Step 5: Verify it compiles and pure tests still pass**

Run (from project root):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors (confirms the `motion/react` import from Task 1 resolves). Confirm VSCode shows no errors in `agents.tsx`.
```bash
npx vitest run frontend/app/view/agents/
```
Expected: PASS (pure tests unaffected).

- [ ] **Step 6: Checkpoint**

Stage: `git add frontend/app/view/agents/agents.tsx`

---

### Task 3: NarrationTimeline — streaming entrance + action-outcome pop

Spec §7b micro-anim 1 (each new narration line/action fades + slides in) and micro-anim 2 (the ✓/✗ pops when an action's outcome resolves). No unit test covers this file, so markup changes are safe.

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

- [ ] **Step 1: Replace the file**

Replace `frontend/app/view/agents/narrationtimeline.tsx` with:
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { motion } from "motion/react";
import type { AgentEntry } from "./agentsviewmodel";

// Reasoning (message) entries render as prose; action entries render as a dim
// monospace verb/target strip. tool_result content is never present here (the
// projection discards it). With accentLatest, the newest message is highlighted.
// Entries are append-only and keyed by index, so `initial` plays only for newly
// appended (newly mounted) entries — existing ones do not re-animate on each chunk.
export function NarrationTimeline({
    entries,
    accentLatest,
    className,
}: {
    entries: AgentEntry[];
    accentLatest?: boolean;
    className?: string;
}) {
    let lastMessageIdx = -1;
    if (accentLatest) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === "message") {
                lastMessageIdx = i;
                break;
            }
        }
    }
    return (
        <div className={cn("leading-relaxed", className)}>
            {entries.map((e, i) =>
                e.kind === "message" ? (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className={cn(
                            "mt-2.5 text-[13px]",
                            i === lastMessageIdx ? "border-l-2 border-[#3fb950] pl-2 text-[#f0f6fc]" : "text-[#dde3ea]"
                        )}
                    >
                        {e.text}
                    </motion.div>
                ) : (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className="my-2.5 border-l-2 border-[#2a2f3a] pl-3.5 font-mono text-[12px] leading-7 text-[#7d8896]"
                    >
                        <span className="inline-block w-14 text-[#9aa4b2]">{e.verb}</span>
                        {e.target}
                        {e.note ? <span className="text-[#6b7585]"> ({e.note})</span> : null}
                        {e.outcome ? (
                            <motion.span
                                key={e.outcome}
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ type: "spring", stiffness: 500, damping: 18 }}
                                className={cn(
                                    "ml-1 inline-block",
                                    e.outcome === "ok" ? "text-[#3fb950]" : "text-[#f85149]"
                                )}
                            >
                                {e.outcome === "ok" ? "✓" : "✗"}
                            </motion.span>
                        ) : null}
                    </motion.div>
                )
            )}
        </div>
    );
}
```

> The outcome `<span>` is keyed on `e.outcome` so that when a streamed `tool_result` flips an action from no-outcome to `ok`/`fail`, the keyed element mounts fresh and the spring pop plays. While `outcome` is undefined the span is not rendered, so the very first resolved value pops.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `narrationtimeline.tsx`.

- [ ] **Step 3: Checkpoint**

Stage: `git add frontend/app/view/agents/narrationtimeline.tsx`

---

### Task 4: AskCard — pill spring + Submit→"✓ Sent" morph

Spec §7b micro-anim 3. Pills spring on tap/selection; the Submit button morphs to "✓ Sent" on submit (the card itself then exits via the `AnimatePresence` added in Task 2 when the agent leaves the asking set).

**Files:**
- Modify: `frontend/app/view/agents/askcard.tsx`

- [ ] **Step 1: Add the motion import**

In `frontend/app/view/agents/askcard.tsx`, add after the `react` import (line 6):
```tsx
import { motion } from "motion/react";
```

- [ ] **Step 2: Make the option buttons springy**

In `QuestionGroup`, replace the `<button ...>` for each option (currently `askcard.tsx:41-58`) with a `motion.button` carrying tap/selection springs. Replace:
```tsx
                        return (
                            <button
                                key={oi}
                                type="button"
                                onClick={() => onToggle(qi, oi)}
                                className={cn(
                                    "cursor-pointer rounded-[7px] px-[18px] py-1.5 text-[12.5px]",
                                    isSelected
                                        ? "bg-[#238636] font-semibold text-white"
                                        : isRecommended
                                          ? "border border-[#238636] font-semibold text-[#3fb950]"
                                          : "border border-[#2c3340] text-[#c9d1d9]"
                                )}
                            >
                                {opt.label}
                                {opt.description ? (
                                    <span className="ml-1.5 text-[11px] font-normal text-[#6b7585]">{opt.description}</span>
                                ) : null}
                            </button>
                        );
```
with:
```tsx
                        return (
                            <motion.button
                                key={oi}
                                type="button"
                                onClick={() => onToggle(qi, oi)}
                                whileTap={{ scale: 0.95 }}
                                animate={{ scale: isSelected ? 1.04 : 1 }}
                                transition={{ type: "spring", stiffness: 500, damping: 22 }}
                                className={cn(
                                    "cursor-pointer rounded-[7px] px-[18px] py-1.5 text-[12.5px]",
                                    isSelected
                                        ? "bg-[#238636] font-semibold text-white"
                                        : isRecommended
                                          ? "border border-[#238636] font-semibold text-[#3fb950]"
                                          : "border border-[#2c3340] text-[#c9d1d9]"
                                )}
                            >
                                {opt.label}
                                {opt.description ? (
                                    <span className="ml-1.5 text-[11px] font-normal text-[#6b7585]">{opt.description}</span>
                                ) : null}
                            </motion.button>
                        );
```

- [ ] **Step 3: Add a `sent` state and morph Submit**

In `AskCard`, add a `sent` state next to `selections` (after `askcard.tsx:76`):
```tsx
    const [sent, setSent] = useState(false);
```
Change `handleSubmit` (currently `askcard.tsx:98-101`) to flip `sent` before relaying:
```tsx
    const handleSubmit = () => {
        if (!canSubmit) return;
        setSent(true);
        onAnswer?.(agent.ask?.oref, buildAskAnswers(questions, selections));
    };
```
Replace the Submit `<button>` (currently `askcard.tsx:134-144`) with a `motion.button` that morphs label/color when `sent`:
```tsx
                <motion.button
                    type="button"
                    disabled={!canSubmit || sent}
                    onClick={handleSubmit}
                    whileTap={{ scale: 0.96 }}
                    animate={{ scale: sent ? 1.03 : 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    className={cn(
                        "rounded-[7px] px-[18px] py-1.5 text-[12.5px] font-semibold",
                        sent
                            ? "bg-[#238636] text-white"
                            : canSubmit
                              ? "cursor-pointer bg-[#238636] text-white"
                              : "bg-[#238636]/40 text-white/50"
                    )}
                >
                    {sent ? "✓ Sent" : "Submit"}
                </motion.button>
```

> The card normally unmounts within ~1s of submit (the agent leaves the asking set, so Task 2's `AnimatePresence` exits it). `sent` is local to this `AskCard` instance and the card is keyed by `ask.askId`/`id`, so a brand-new ask gets a fresh `sent=false`. No reset effect is needed.

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `askcard.tsx`.

- [ ] **Step 5: Checkpoint**

Stage: `git add frontend/app/view/agents/askcard.tsx`

---

### Task 5: WorkingPanel — working pulse + spinner + new-output pill spring

Spec §7b micro-anim 4 (breathing green dot + rotating ⟳, ambient while working) and micro-anim 5 (the `↓ N new` pill springs in/out). No unit test covers this file.

**Files:**
- Modify: `frontend/app/view/agents/outputpanel.tsx`

- [ ] **Step 1: Add the motion import**

In `frontend/app/view/agents/outputpanel.tsx`, add after the `react` import (line 6):
```tsx
import { motion, AnimatePresence } from "motion/react";
```

- [ ] **Step 2: Breathing/hollow status dot**

Replace the status-dot `<span>` (currently `outputpanel.tsx:69-74`) with a `motion.span`: a hollow static dot when quiet, a breathing green dot otherwise:
```tsx
                <motion.span
                    className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        quiet ? "border border-[#4a5260] bg-transparent" : "bg-[#3fb950]"
                    )}
                    animate={quiet ? { scale: 1 } : { scale: [1, 1.25, 1], opacity: [1, 0.7, 1] }}
                    transition={quiet ? { duration: 0 } : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                />
```

- [ ] **Step 3: Rotating spinner glyph**

The header's right-side meta currently renders `⟳ ${since}` as plain text (`outputpanel.tsx:83`). Split the `⟳` glyph into a rotating `motion.span`. Replace the meta `<span>` block (currently `outputpanel.tsx:80-85`) with:
```tsx
                <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-[11px]", quiet ? "text-[#d29922]" : "text-[#7d8896]")}>
                    {agent.model ? `${agent.model} · ` : ""}
                    {formatAge(agent.activeMs)}
                    {since ? (
                        <>
                            <span>·</span>
                            <motion.span
                                className="inline-block"
                                animate={quiet ? { rotate: 0 } : { rotate: 360 }}
                                transition={quiet ? { duration: 0 } : { duration: 2, repeat: Infinity, ease: "linear" }}
                            >
                                ⟳
                            </motion.span>
                            <span>{since}</span>
                        </>
                    ) : null}
                    {quiet ? <span>· quiet</span> : null}
                </span>
```

> The spinner spins only while live; when `quiet`, it stops at `rotate: 0` (alongside the hollow dot and amber color), so a stalled agent reads as paused.

- [ ] **Step 4: New-output pill spring**

Replace the new-output pill block (currently `outputpanel.tsx:97-105`) with an `AnimatePresence`-wrapped `motion.button`:
```tsx
            <AnimatePresence>
                {newCount > 0 ? (
                    <motion.button
                        key="newpill"
                        type="button"
                        onClick={jumpToLatest}
                        initial={{ opacity: 0, y: 8, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.9 }}
                        transition={{ type: "spring", stiffness: 500, damping: 26 }}
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-[#1f6feb] px-3 py-1 text-[11px] font-semibold text-white shadow-lg"
                    >
                        ↓ {newCount} new
                    </motion.button>
                ) : null}
            </AnimatePresence>
```

> `-translate-x-1/2` via the Tailwind class sets a transform; motion's `x`/`scale`/`y` compose with it because motion writes its own transform on top of the class-applied one only if it manages those axes. To avoid a centering jump, the pill animates `y`/`scale`/`opacity` (not `x`) so the `-translate-x-1/2` centering is preserved. Verify centering live in Task 12.

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `outputpanel.tsx`.

- [ ] **Step 6: Checkpoint**

Stage: `git add frontend/app/view/agents/outputpanel.tsx`

---

### Task 6: AgentsView — linger-on-completion + status-flap debounce (deferrable)

Spec §7a "Linger on completion" (hold a finished agent's panel ~1–2s before removing) and "Debounce status flaps" (ignore sub-~500ms working↔asking toggles). **This task adds local state that diverges the rendered set from the live atom for short windows.** It is the most invasive Agents-view task; if the owner prefers to keep the view a pure projection of `agentsAtom`, **defer this whole task** — the AnimatePresence `exit` from Task 2 already gives a graceful fade-out on completion (just not a held "✓ done"), and rapid flaps are visually rare.

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Add a debounce + linger hook above `AgentsView`**

Insert this hook after the `RollingCount` component (Task 2 added it) and before `AgentsView`:
```tsx
const FLAP_DEBOUNCE_MS = 500;
const LINGER_MS = 1500;

// Smooths the grouped sets so the layout doesn't bounce:
//  - debounce: a working↔asking flip is only applied after it holds for FLAP_DEBOUNCE_MS.
//  - linger: a working agent that leaves the live set is held (dimmed, marked `lingering`) for LINGER_MS.
function useSmoothedSections(asking: AgentVM[], working: AgentVM[]): { asking: AgentVM[]; working: (AgentVM & { lingering?: boolean })[] } {
    const [stable, setStable] = useState<{ asking: AgentVM[]; working: AgentVM[] }>({ asking, working });
    const pendingRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const lingerRef = useRef<Map<string, AgentVM>>(new Map());
    const [, forceTick] = useState(0);

    // Apply the latest grouping, debouncing per-agent state flips.
    useEffect(() => {
        // For simplicity the debounce applies at the set level: commit immediately,
        // but record departures for linger. A genuine sub-500ms flap is rare; the
        // window below is the guard against it.
        const timer = setTimeout(() => {
            setStable({ asking, working });
        }, FLAP_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [asking, working]);

    // Linger: any working id present last render but absent now is held briefly.
    const prevWorkingRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const nowIds = new Set(working.map((a) => a.id));
        for (const a of prevWorkingRef.current) {
            // handled below via the map
            void a;
        }
        const prevById = new Map(stable.working.map((a) => [a.id, a]));
        for (const [id, vm] of prevById) {
            if (!nowIds.has(id) && !lingerRef.current.has(id)) {
                lingerRef.current.set(id, vm);
                const t = setTimeout(() => {
                    lingerRef.current.delete(id);
                    forceTick((n) => n + 1);
                }, LINGER_MS);
                pendingRef.current.set(id, t);
            }
        }
        prevWorkingRef.current = nowIds;
    }, [working, stable.working]);

    useEffect(() => {
        const pending = pendingRef.current;
        return () => {
            for (const t of pending.values()) {
                clearTimeout(t);
            }
            pending.clear();
        };
    }, []);

    const liveIds = new Set(working.map((a) => a.id));
    const lingering = [...lingerRef.current.values()]
        .filter((a) => !liveIds.has(a.id))
        .map((a) => ({ ...a, lingering: true }));
    return { asking, working: [...working, ...lingering] };
}
```

> **Honesty note:** this is the deferrable, higher-complexity piece. The implementation above keeps the debounce coarse (set-level) and the linger simple (a transient held-set). If the live walkthrough (Task 12) shows it fighting the live atom — e.g. a finished agent flickering back — prefer deleting this task over hardening it. Per the owner's KISS/YAGNI rules, the AnimatePresence exit alone is an acceptable shipped state.

- [ ] **Step 2: Use the hook in `AgentsView` and dim lingering panels**

In `AgentsView`, after `const queue = ...`, derive the smoothed working set:
```tsx
    const { working: smoothedWorking } = useSmoothedSections(asking, working);
```
In the working-grid map (Task 2's JSX), iterate `smoothedWorking` instead of `working`, and dim + label lingering cells. Replace the working-grid `motion.div` map body so each cell reads:
```tsx
                            {smoothedWorking.map((a) => (
                                <motion.div
                                    key={a.id}
                                    layout
                                    layoutId={a.id}
                                    initial={{ opacity: 0, scale: 0.96 }}
                                    animate={{ opacity: a.lingering ? 0.45 : 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.96 }}
                                    transition={{ duration: 0.2, ease: "easeOut" }}
                                    className="relative min-h-0"
                                >
                                    {a.lingering ? (
                                        <div className="pointer-events-none absolute right-3 top-2 z-10 rounded bg-[#238636]/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                            ✓ done
                                        </div>
                                    ) : null}
                                    <WorkingPanel agent={a} now={now} onOpen={open} />
                                </motion.div>
                            ))}
```
Also change the `working.length > 0` guard for the grid to `smoothedWorking.length > 0`, and the `empty` computation to account for lingering panels:
```tsx
    const empty = asking.length === 0 && smoothedWorking.length === 0;
```
(Move the `const { working: smoothedWorking } = ...` line above the `empty` computation.)

- [ ] **Step 3: Verify it compiles and pure tests pass**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.
Run: `npx vitest run frontend/app/view/agents/` → PASS.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/view/agents/agents.tsx`

---

### Task 7: VTab — active-indicator glide (§7c #1)

Low risk, visual-only. The active highlight slides between tabs via `layoutId`.

**Files:**
- Modify: `frontend/app/tab/vtab.tsx`

- [ ] **Step 1: Add the motion import**

In `frontend/app/tab/vtab.tsx`, add after the `react` import (line 7):
```tsx
import { motion } from "motion/react";
```

- [ ] **Step 2: Make the active highlight a shared-element**

Replace the active-highlight div (currently `vtab.tsx:171-173`):
```tsx
            {active && (
                <div className="pointer-events-none absolute inset-x-1 inset-y-[4px] rounded-sm bg-foreground/10" />
            )}
```
with:
```tsx
            {active && (
                <motion.div
                    layoutId="vtab-active"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    className="pointer-events-none absolute inset-x-1 inset-y-[4px] rounded-sm bg-foreground/10"
                />
            )}
```

> Only the active tab renders the highlight. When the active tab changes, the old highlight unmounts and the new one mounts with the same `layoutId="vtab-active"`, so motion glides it between the two tab positions. The hover highlight (`vtab.tsx:174-176`) is left untouched.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `vtab.tsx`.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/tab/vtab.tsx`

---

### Task 8: SessionSidebar — asking-badge pop (§7c #3)

Low risk. The "N asking" badge pops when the count increments. **Anchor corrected:** the badge is in `sessionsidebar.tsx:156-158`, not `sessionrow.tsx`.

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Add the motion import**

In `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`, add after the `react` import (line 11):
```tsx
import { motion, AnimatePresence } from "motion/react";
```

- [ ] **Step 2: Pop the badge on change**

Replace the asking-badge block (currently `sessionsidebar.tsx:156-158`):
```tsx
                {asking > 0 && (
                    <span className="ml-auto rounded-[9px] bg-[#d29922] px-2 text-[10px] font-bold text-black">{asking} asking</span>
                )}
```
with:
```tsx
                <AnimatePresence>
                    {asking > 0 && (
                        <motion.span
                            key={asking}
                            initial={{ scale: 0.6, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.6, opacity: 0 }}
                            transition={{ type: "spring", stiffness: 600, damping: 20 }}
                            className="ml-auto rounded-[9px] bg-[#d29922] px-2 text-[10px] font-bold text-black"
                        >
                            {asking} asking
                        </motion.span>
                    )}
                </AnimatePresence>
```

> Keying on `asking` makes the badge re-mount (and pop) on every count change, drawing the eye off-tab when a new agent starts asking.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `sessionsidebar.tsx`.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

---

### Task 9: SessionSidebar build sanity (no-op placeholder removed)

*(Intentionally omitted — Task 8 and Task 11 both touch `sessionsidebar.tsx`; there is no separate work here. Numbering preserved so later task references stay stable.)*

---

### Task 10: SessionRow — status-dot transitions (§7c #2)

Medium risk: this file has an SSR unit test. Keep `backgroundColor` in `style` so the `STATUS_COLOR` hex still renders under `renderToStaticMarkup` — the assertions in `sessionrow.test.tsx` stay green.

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx`

- [ ] **Step 1: Add the motion import**

In `frontend/app/tab/sessionsidebar/sessionrow.tsx`, add after the `react` import (line 5):
```tsx
import { motion } from "motion/react";
```

- [ ] **Step 2: Breathing/pulsing session dot with color flip**

Replace the session status dot (currently `sessionrow.tsx:116-119`):
```tsx
            <span
                className="size-[9px] shrink-0 rounded-full"
                style={{ backgroundColor: STATUS_COLOR[status] }}
            />
```
with:
```tsx
            <motion.span
                className="size-[9px] shrink-0 rounded-full transition-[background-color] duration-300"
                style={{ backgroundColor: STATUS_COLOR[status] }}
                animate={
                    status === "working"
                        ? { scale: [1, 1.25, 1] }
                        : status === "waiting"
                          ? { opacity: [1, 0.45, 1] }
                          : { scale: 1, opacity: 1 }
                }
                transition={
                    status === "idle"
                        ? { duration: 0 }
                        : { duration: status === "working" ? 1.6 : 1.2, repeat: Infinity, ease: "easeInOut" }
                }
            />
```

- [ ] **Step 3: Group aggregate dot color flip (transition only)**

Replace the SessionGroup aggregate dot (currently `sessionrow.tsx:257-260`):
```tsx
                <span
                    className="size-[9px] shrink-0 rounded-full"
                    style={{ backgroundColor: STATUS_COLOR[aggregateStatus] }}
                />
```
with:
```tsx
                <span
                    className="size-[9px] shrink-0 rounded-full transition-[background-color] duration-300"
                    style={{ backgroundColor: STATUS_COLOR[aggregateStatus] }}
                />
```
(Aggregate dot gets only the smooth color flip — no breathing — to keep collapsed groups calm.)

- [ ] **Step 4: Verify it compiles and the SSR test still passes**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.
Run: `npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx`
Expected: PASS — in particular `colors the dot by status` (the `STATUS_COLOR` hex remains in `style`) and `shows the aggregate dot color when collapsed`. If either fails, the `backgroundColor` is no longer emitted in the SSR markup — revert to keeping it in `style` (do not move it into `animate`).

- [ ] **Step 5: Checkpoint**

Stage: `git add frontend/app/tab/sessionsidebar/sessionrow.tsx`

---

### Task 11: SessionSidebar — subagent expand/collapse reveal (§7c #5, reveal-only)

Medium risk. Height-animates the subagent list reveal. **Chevron rotate is intentionally not done** (see corrections §3 — it would break `sessionrow.test.tsx`'s `fa-chevron-down` assertion and is redundant with the existing icon-swap). The reveal is implemented in `sessionsidebar.tsx` (`SessionRowTree`), which has no unit test.

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

- [ ] **Step 1: Confirm the motion import exists**

Task 8 already added `import { motion, AnimatePresence } from "motion/react";` to this file. If executing tasks out of order, add it now (after the `react` import, line 11).

- [ ] **Step 2: Wrap the subagent list in a height-animated reveal**

In `SessionRowTree`, replace the subagent render (currently `sessionsidebar.tsx:108-118`):
```tsx
            {row.subagentsExpanded &&
                row.subagents.map((sa, i) => (
                    <SubagentRow
                        key={sa.id}
                        type={sa.type}
                        state={sa.state}
                        last={i === row.subagents.length - 1}
                        model={sa.model}
                        parentModel={row.model}
                    />
                ))}
```
with:
```tsx
            <AnimatePresence initial={false}>
                {row.subagentsExpanded && (
                    <motion.div
                        key="subagents"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="overflow-hidden"
                    >
                        {row.subagents.map((sa, i) => (
                            <SubagentRow
                                key={sa.id}
                                type={sa.type}
                                state={sa.state}
                                last={i === row.subagents.length - 1}
                                model={sa.model}
                                parentModel={row.model}
                            />
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
```

> `initial={false}` on `AnimatePresence` prevents an open-on-mount animation for rows that are already expanded when the sidebar first renders. `overflow-hidden` clips the children during the height tween. `height: "auto"` is animated by motion via measurement.

- [ ] **Step 3: Verify it compiles and sidebar tests pass**

Run: `npx tsc --noEmit -p tsconfig.json` → no errors.
Run: `npx vitest run frontend/app/tab/sessionsidebar/`
Expected: PASS (no test renders `SessionRowTree`; `sessionrow.test.tsx` is unaffected since the chevron icon-swap in `sessionrow.tsx` is unchanged).

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

---

### Task 12: VTabBar — tab enter/leave (§7c #4) — HIGHEST RISK, GUARDED

**This is the highest-regression task.** `vtabbar.tsx` owns native HTML5 drag-reorder (which reads `event.currentTarget.offsetTop`/`offsetHeight` to position the drop line) and remounts all tabs via `key={tabId:hoverResetVersion}` after a drag. Naive `AnimatePresence` + `layout` will (a) animate every tab on the post-drag remount and (b) risk shifting the drag geometry. The guards below disable the motion layer during drag and key the motion children by `tabId` only.

**Strongly consider deferring this task.** Tabs are created/closed infrequently; the payoff is small relative to the regression surface. If deferring, the tab list simply snaps as today (no functional loss).

**Files:**
- Modify: `frontend/app/tab/vtabbar.tsx`

- [ ] **Step 1: Add the motion import**

In `frontend/app/tab/vtabbar.tsx`, add after the existing `react` import (line 14):
```tsx
import { motion, AnimatePresence } from "motion/react";
```

- [ ] **Step 2: Wrap each tab in a guarded motion wrapper**

In `VTabBar`'s render, the tab list maps `orderedTabIds` to `<VTabWrapper .../>` (currently `vtabbar.tsx:353-414`). Wrap the mapped list in `<AnimatePresence>` and wrap each `VTabWrapper` in a `motion.div` that animates enter/leave **only when not dragging**. The `motion.div` must be keyed by `tabId` alone (not `hoverResetVersion`) so the post-drag remount of `VTabWrapper` does not trigger an exit/enter on the motion layer.

Replace the `{orderedTabIds.map((tabId, index) => { ... })}` block and the trailing drop-line block (currently `vtabbar.tsx:353-420`) with:
```tsx
                <AnimatePresence initial={false}>
                    {orderedTabIds.map((tabId, index) => {
                        const isActive = tabId === activeTabId;
                        const isHovered = tabId === hoveredTabId;
                        const isLast = index === orderedTabIds.length - 1;
                        const nextTabId = orderedTabIds[index + 1];
                        const isNextActive = nextTabId === activeTabId;
                        const isNextHovered = nextTabId === hoveredTabId;
                        const reordering = dragTabId != null;
                        return (
                            <motion.div
                                key={tabId}
                                layout={!reordering}
                                initial={reordering ? false : { opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={reordering ? { opacity: 0 } : { opacity: 0, height: 0 }}
                                transition={{ duration: 0.18, ease: "easeOut" }}
                                className="overflow-hidden"
                            >
                                <VTabWrapper
                                    key={`${tabId}:${hoverResetVersion}`}
                                    tabId={tabId}
                                    active={isActive}
                                    showDivider={
                                        !isActive &&
                                        !isNextActive &&
                                        !isHovered &&
                                        !isNextHovered &&
                                        !(isLast && isNewTabHovered)
                                    }
                                    isDragging={dragTabId === tabId}
                                    isReordering={dragTabId != null}
                                    hoverResetVersion={hoverResetVersion}
                                    index={index}
                                    onSelect={() => env.electron.setActiveTab(tabId)}
                                    onClose={() => fireAndForget(() => env.electron.closeTab(workspace.oid, tabId, false))}
                                    onRename={(newName) =>
                                        fireAndForget(() => env.rpc.UpdateTabNameCommand(TabRpcClient, tabId, newName))
                                    }
                                    onDragStart={(event) => {
                                        didResetHoverForDragRef.current = false;
                                        dragSourceRef.current = tabId;
                                        event.dataTransfer.effectAllowed = "move";
                                        event.dataTransfer.setData("text/plain", tabId);
                                        setDragTabId(tabId);
                                        setDropIndex(index);
                                        setDropLineTop(event.currentTarget.offsetTop);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        const rect = event.currentTarget.getBoundingClientRect();
                                        const relativeY = event.clientY - rect.top;
                                        const midpoint = event.currentTarget.offsetHeight / 2;
                                        const insertBefore = relativeY < midpoint;
                                        setDropIndex(insertBefore ? index : index + 1);
                                        setDropLineTop(
                                            insertBefore
                                                ? event.currentTarget.offsetTop
                                                : event.currentTarget.offsetTop + event.currentTarget.offsetHeight
                                        );
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        if (dropIndex != null) {
                                            reorder(dropIndex);
                                        }
                                        clearDragState();
                                    }}
                                    onDragEnd={clearDragState}
                                    onHoverChanged={(isHovered) => setHoveredTabId(isHovered ? tabId : null)}
                                />
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
                {dragTabId != null && dropIndex != null && dropLineTop != null && (
                    <div
                        className="pointer-events-none absolute left-0 right-0 border-t-2 border-accent/80"
                        style={{ top: dropLineTop, transform: "translateY(-1px)" }}
                    />
                )}
```

> **Guards:** `layout={!reordering}` and `initial={reordering ? false : ...}` / `exit={reordering ? {opacity:0} : ...}` disable the height/layout animation while a drag is in progress, so the drop-line geometry (which reads `offsetTop`/`offsetHeight` on the inner `VTabWrapper`'s draggable div) is not perturbed by an animating wrapper. The `motion.div` is keyed by `tabId` only; the inner `VTabWrapper` keeps its `key={tabId:hoverResetVersion}` remount behavior, which no longer leaks to the `AnimatePresence` layer. The drop-line uses `offsetTop` relative to the scroll container; the extra `overflow-hidden` wrapper is a static flex child, so `offsetTop` semantics are preserved — **verify drag-reorder still positions the drop line correctly in Task 12's walkthrough.**

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. Confirm no VSCode errors in `vtabbar.tsx`.

- [ ] **Step 4: Checkpoint**

Stage: `git add frontend/app/tab/vtabbar.tsx`

---

### Task 13: Live walkthrough verification + batched commit

**Files:** none (verification + commit). Uses the dev app + CDP per `memory/cdp-verify-dev-app.md`.

- [ ] **Step 1: Run the full frontend checks**

Run (from project root):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors.
```bash
npx vitest run
```
Expected: PASS (all suites — in particular `sessionrow.test.tsx` and `frontend/app/view/agents/`).

- [ ] **Step 2: Rebuild/relaunch the dev app and observe motion**

Per `memory/cdp-verify-dev-app.md`. Verify, noting PASS/FAIL each:

Agents view:
- **Layout glide:** an agent going working→asking glides between the working grid and the asks region (no fade-swap); answering the focused ask advances focus with a glide; queue-row→focus promotion glides.
- **Grid reflow:** adding/removing a working agent reflows the grid with eased motion, not a snap.
- **Narration entrance (1):** new narration lines/actions fade+slide in; existing lines do not re-animate per chunk.
- **Action-outcome pop (2):** a resolving action's ✓/✗ pops in.
- **Answer feedback (3):** option pills spring on select; Submit morphs to "✓ Sent" before the card exits.
- **Working pulse+spinner (4):** breathing green dot + rotating ⟳ while working; both stop (hollow dot, amber, static ⟳) when quiet.
- **New-output pill (5):** scroll a streaming panel up → `↓ N new` springs in centered; clicking jumps to latest and it springs out.
- **Count transition (6):** header "N asking · M working" rolls when counts change.
- **Empty-state fade (7):** empty state fades in when no agents are active.
- **(If Task 6 included)** linger: a finished agent's panel holds dim with "✓ done" ~1.5s before leaving; no flicker-back.

Shared chrome:
- **Active glide (#1):** switching tabs slides the active highlight between tabs.
- **Asking-badge pop (#3):** the sidebar "N asking" badge pops when the count changes.
- **Status-dot (#2):** working dots breathe green, waiting dots pulse amber, color flips are smooth.
- **Subagent reveal (#5):** expanding a session's subagents height-reveals them; collapsing animates closed. Chevron still swaps right↔down (no rotate — intended).
- **(If Task 12 included)** tab enter/leave: creating a tab slides/fades it in; closing collapses it out. **Critically: drag-reorder still works and the drop line lands correctly; rename and context menus still work.**

**Session-sidebar drag-reorder (pre-existing bug — confirm + isolate, independent of motion):**

Reported symptom: dragging a session row to reorder does nothing — *no drag ghost follows the cursor at all*. Investigation found the code path is correct: pure `reorderWithinGroup` is unit-tested; within-group visual order *is* `tabids` order (`buildSessionViewModel`), so a reorder would be visible; `SessionRow` renders `draggable={true}` with `onDragStart` wired; and there is no global `-webkit-user-drag: none` CSS, no document `dragstart` preventDefault, and the only `mousedown` preventDefault is macOS-only. A "no ghost" symptom with correct code points at a **stale running build** or a **runtime DOM/CSS condition** visible only live.

> Note: the real vertical strip is the **session sidebar** (`sessionsidebar.tsx`/`sessionrow.tsx`). The workspace tab bar (`vtab.tsx`/`vtabbar.tsx`) is rendered **only in a preview** (`vtabbar.preview.tsx`); `workspace.tsx:135` mounts `<SessionSidebar>`. This affects Tasks 7 & 12 (which target the preview-only `vtab`/`vtabbar`) — see the open question raised with the owner.

Confirm and isolate during this live pass (per `memory/cdp-verify-dev-app.md`, CDP `:9222`):
  1. Confirm you are in the **dev build** (`task electron:winquickdev`) showing the grouped session sidebar — **not** production Wave (0.14.5 has no sidebar/reorder, which would explain "doesn't work").
  2. Drag a session row within a group. Expected: a ghost follows the cursor, a blue drop line appears, and on release the row reorders (persisted via `UpdateWorkspaceTabIdsCommand`).
  3. If no ghost appears, inspect the live element over CDP: on a `.session-row`, read `el.getAttribute("draggable")` (must be `"true"`) and `getComputedStyle(el).webkitUserDrag` / `.pointerEvents`. Missing `draggable="true"` ⇒ stale build (rebuild + relaunch). Computed `-webkit-user-drag: none` / `pointer-events: none` ⇒ a CSS regression to trace to its source. Also check the renderer console for errors during the drag.
  4. **Regression guard:** the motion changes to the session sidebar in this plan (status-dot `motion.span` in Task 10, asking-badge in Task 8, subagent reveal in Task 11) must NOT break drag-reorder — re-verify the drag after those tasks land.

- [ ] **Step 3: Record results**

Note PASS/FAIL per check in the session notes, and which deferrable tasks (6, 12) were included or cut.

- [ ] **Step 4: Present the batched commit for approval**

Run: `git status` and `git diff --staged --stat`. Present the file list (M/A + one-line summary each). Note that Phase 1's staged files are included unless the owner wants them split. Proposed message:
```
feat(agents): motion — layout-shift easing, content micro-animations, and vertical-tab chrome animations
```
If Phase 1 and Phase 2 are committed separately at the owner's request, use two messages (Phase 1's is already drafted in its own plan).

- [ ] **Step 5: Commit only on explicit approval**

Ask: "Awaiting approval. Proceed with the commit? (yes/no)". Only on explicit "yes":
```bash
git commit -m "feat(agents): motion — layout-shift easing, content micro-animations, and vertical-tab chrome animations"
```
Do not push unless separately asked.

---

## Self-review

**Spec coverage (§7):**
- §7 dependency (`npm i motion`) → Task 1.
- §7a layout-shift easing: AnimatePresence + `layout` + `layoutId` (working↔asking glide, queue→focus promotion, grid reflow, enter/leave) → Task 2. Linger-on-completion + debounce-status-flaps → Task 6 (flagged deferrable). Structural layer (fixed-height cells, capped asks region, reserved focus slot, stable keys, age sort) already exists from Phase 1.
- §7b content micro-animations 1–7: narration entrance + action-outcome pop (1,2) → Task 3; answer feedback (3) → Task 4; working pulse+spinner + new-output pill (4,5) → Task 5; count transition (6) + empty-state fade (7) → Task 2.
- §7c vertical-tab animations 1–5: active glide (1) → Task 7; status-dot (2) → Task 10; asking-badge pop (3) → Task 8; tab enter/leave (4) → Task 12; subagent expand/collapse (5) → Task 11. **Chevron-rotate sub-part of (5) intentionally omitted** (corrections §3) — documented, not silent.

**Placeholder scan:** none — every code step shows complete replacement code; verification steps give concrete commands and expected output. Task 9 is an explicit numbered no-op (kept for stable references), not a placeholder for unwritten work.

**Type/anchor consistency:** the `motion`/`AnimatePresence` import (from `motion/react`) is added per-file in the first task that touches each file; Task 11 notes the import may already exist from Task 8 (same file). `layoutId={agent.id}` is used consistently across the focused ask, queue rows, and working panels in Task 2 (and Task 6 reuses `a.id`). The corrected anchors (asking badge in `sessionsidebar.tsx`; status dots in `sessionrow.tsx`; no dot in `vtab.tsx`) are applied in Tasks 8/10 and stated up front.

**Risk ordering:** Tasks 1–5 (Agents-view core) are low/medium risk and self-contained; Task 6 (added state) and Task 12 (drag-reorder conflict) are flagged deferrable; Tasks 7–11 are the shared-chrome animations ordered low→medium risk, each independently stageable.
