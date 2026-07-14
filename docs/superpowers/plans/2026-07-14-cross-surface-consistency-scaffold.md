# Cross-Surface Consistency Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce one shared surface-chrome scaffold (`SurfaceHeader`, `SurfaceEmptyState`, `SurfaceError`, `SURFACE_ROOT`) and migrate the cockpit's surfaces onto it so headers, empty states, containers, and the chrome text scale are consistent and stay consistent.

**Architecture:** A single new presentational file `frontend/app/view/agents/surfacescaffold.tsx` exports the shared chrome over existing `@theme` tokens, the existing `Skeleton`, and the existing motion tokens — no new state, no new deps. Seven surfaces adopt the full header+empty pattern; three structurally-different surfaces (agent TUI, files 2-pane, channels 2-pane) adopt only the pieces that fit. Verification is CDP screenshots + tsc, per repo convention (there is no DOM test env).

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens in `frontend/tailwindsetup.css`), jotai, `motion/react`. TypeScript checked via `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Unit tests via `vitest` (node environment).

**Spec:** `docs/superpowers/specs/2026-07-14-cross-surface-consistency-scaffold-design.md`

## Global Constraints

- **Text scale (chrome only):** use `text-primary` (titles) / `text-secondary` (body) / `text-muted` (de-emphasized) in every header/empty/error this plan touches. Do NOT do a repo-wide `ink-*` remap — only the chrome markup being edited.
- **Canonical header title:** `text-[25px] font-bold tracking-[-0.02em] text-primary`.
- **Canonical header container:** `flex flex-none items-start justify-between gap-5 bg-background px-[28px] pb-4 pt-5` + `border-b border-border` (toggleable via the `border` prop, default on).
- **Canonical surface root:** `flex h-full min-h-0 flex-col bg-background` (exported as `SURFACE_ROOT`); every surface must set its own `bg-background`.
- **No new dependencies.** No jsdom / `@testing-library`. vitest runs in the node environment — presentational components are NOT render-unit-tested; they are verified by CDP screenshots (`node scripts/cdp-shot.mjs`) and `tsc`.
- **tsc gotcha:** typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows). Baseline is exit 0 — any error it reports is yours.
- **Do not hand-edit generated files** (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, etc.). This plan touches none.
- **Git policy (overrides the TDD per-step-commit default — repo CLAUDE.md):** do NOT commit per task. Each task ends with a **checkpoint** (stage + `git status --short` + one-line summary). A single commit at the very end (Task 12) requires explicit user approval, includes the spec + this plan, and adds no co-author.
- **Windows environment:** use PowerShell or the Bash tool with POSIX syntax; never PowerShell here-strings in the Bash tool.

---

### Task 1: Build the surface scaffold

Create the three shared chrome components + the root-container constant. Pure presentational; no state.

**Files:**
- Create: `frontend/app/view/agents/surfacescaffold.tsx`

**Interfaces:**
- Produces:
  - `const SURFACE_ROOT: string`
  - `function SurfaceHeader(props: { title: string; badge?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; border?: boolean }): JSX.Element`
  - `function SurfaceEmptyState(props: { glyph?: ReactNode; title: string; body?: ReactNode; action?: { label: ReactNode; onClick: () => void; hint?: ReactNode } }): JSX.Element`
  - `function SurfaceError(props: { message: string; onRetry?: () => void }): JSX.Element`

- [ ] **Step 1: Create the file**

Create `frontend/app/view/agents/surfacescaffold.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared surface chrome — the single source of truth for cockpit surface headers, empty states, and
// load-error banners. Modeled on the original cockpit header + CockpitEmptyState.
// See docs/superpowers/specs/2026-07-14-cross-surface-consistency-scaffold-design.md.

import { cardVariants } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { motion } from "motion/react";
import type { ReactNode } from "react";

// Canonical surface root. Every surface sets its own bg-background so it renders correctly even if
// mounted outside the shell router.
export const SURFACE_ROOT = "flex h-full min-h-0 flex-col bg-background";

export function SurfaceHeader({
    title,
    badge,
    subtitle,
    actions,
    border = true,
}: {
    title: string;
    badge?: ReactNode;
    subtitle?: ReactNode;
    actions?: ReactNode;
    border?: boolean;
}) {
    return (
        <div
            className={cn(
                "flex flex-none items-start justify-between gap-5 bg-background px-[28px] pb-4 pt-5",
                border && "border-b border-border"
            )}
        >
            <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">{title}</h1>
                    {badge}
                </div>
                {subtitle != null ? <div className="mt-1 text-[13px] text-secondary">{subtitle}</div> : null}
            </div>
            {actions != null ? <div className="flex flex-none items-center gap-2">{actions}</div> : null}
        </div>
    );
}

export function SurfaceEmptyState({
    glyph,
    title,
    body,
    action,
}: {
    glyph?: ReactNode;
    title: string;
    body?: ReactNode;
    action?: { label: ReactNode; onClick: () => void; hint?: ReactNode };
}) {
    return (
        <motion.div
            key="empty"
            variants={cardVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex h-full w-full flex-col items-center justify-center px-[30px] py-12 text-center"
        >
            <div className="flex w-full max-w-[600px] flex-col items-center">
                {glyph}
                <h2 className="mb-2.5 text-[25px] font-bold tracking-[-0.02em] text-primary">{title}</h2>
                {body != null ? (
                    <div className="mb-[30px] max-w-[400px] text-[14px] leading-[1.6] text-muted">{body}</div>
                ) : null}
                {action != null ? (
                    <>
                        <motion.button
                            type="button"
                            onClick={action.onClick}
                            whileHover={{ y: -1 }}
                            whileTap={{ y: 0 }}
                            style={{
                                boxShadow:
                                    "0 14px 34px color-mix(in srgb, var(--color-accent) 34%, transparent), inset 0 1px 0 rgba(255,255,255,0.28)",
                            }}
                            className="flex cursor-pointer items-center gap-[11px] rounded-lg bg-accent px-[26px] py-3.5 text-[15px] font-bold text-background hover:bg-accenthover"
                        >
                            {action.label}
                        </motion.button>
                        {action.hint != null ? (
                            <div className="mt-[18px] text-[12.5px] text-muted">{action.hint}</div>
                        ) : null}
                    </>
                ) : null}
            </div>
        </motion.div>
    );
}

export function SurfaceError({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="mx-[28px] mt-3 flex items-center gap-3 rounded-[10px] border border-error/40 bg-error/10 px-3.5 py-2.5 text-[12.5px] text-error">
            <span className="flex-1">{message}</span>
            {onRetry != null ? (
                <button
                    type="button"
                    onClick={onRetry}
                    className="flex-none cursor-pointer rounded border border-error/40 px-2 py-0.5 font-semibold hover:bg-error/15"
                >
                    Retry
                </button>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline; the new file introduces no errors).

- [ ] **Step 3: Confirm no test regressions**

Run: `npx vitest run`
Expected: same pass count as before this task (the new file has no importers yet, so no behavior changed).

- [ ] **Step 4: Checkpoint**

```bash
git add frontend/app/view/agents/surfacescaffold.tsx
git status --short
```

State: "Task 1 done — surfacescaffold.tsx exports SURFACE_ROOT + SurfaceHeader/SurfaceEmptyState/SurfaceError; tsc clean, vitest unchanged."

---

### Task 2: Migrate the placeholder surface

The whole placeholder surface is an empty state — swap it for `SurfaceEmptyState`.

**Files:**
- Modify: `frontend/app/view/agents/placeholdersurface.tsx`

**Interfaces:**
- Consumes: `SurfaceEmptyState` (Task 1).

- [ ] **Step 1: Replace the file body**

Replace the entire contents of `frontend/app/view/agents/placeholdersurface.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SurfaceEmptyState } from "./surfacescaffold";

const TITLES: Record<string, string> = {
    files: "Files",
    memory: "Memory",
};

export function PlaceholderSurface({ surface }: { surface: string }) {
    return <SurfaceEmptyState title={TITLES[surface] ?? surface} body="Coming soon." />;
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: CDP visual check**

There is no live route that reaches `PlaceholderSurface` today (all rail surfaces are implemented), so a screenshot is not applicable. Confirm by reading the shell router: `frontend/app/view/agents/cockpitshell.tsx` renders `<PlaceholderSurface>` only in the `else` branch. Note this in the checkpoint.

- [ ] **Step 4: Checkpoint**

```bash
git add frontend/app/view/agents/placeholdersurface.tsx
git status --short
```

State: "Task 2 done — placeholder surface renders via SurfaceEmptyState; tsc clean; no live route (fallback only)."

---

### Task 3: Migrate the settings header

Normalize the settings title (26px/extrabold → canonical 25px/bold) via `SurfaceHeader`. The settings surface scrolls its body and has no border header today; keep it borderless (the title sits inside the scroll body) — pass `border={false}` and keep the surrounding scroll container.

**Files:**
- Modify: `frontend/app/view/agents/settingssurface.tsx` (header block at lines 41-51)

**Interfaces:**
- Consumes: `SurfaceHeader` (Task 1).

- [ ] **Step 1: Import the scaffold**

At the top of `frontend/app/view/agents/settingssurface.tsx`, add to the existing imports:

```tsx
import { SurfaceHeader } from "./surfacescaffold";
```

- [ ] **Step 2: Replace the title + subtitle markup**

Find this block (inside the `motion.div`, around lines 48-51):

```tsx
                    <h1 className="text-[26px] font-extrabold tracking-[-0.025em] text-primary">Settings</h1>
                    <p className="mb-9 mt-1.5 text-[13.5px] text-muted">
                        Cockpit preferences, appearance, and New Agent defaults.
                    </p>
```

Replace it with:

```tsx
                    <div className="mb-9">
                        <SurfaceHeader
                            title="Settings"
                            subtitle="Cockpit preferences, appearance, and New Agent defaults."
                            border={false}
                        />
                    </div>
```

Note: `SurfaceHeader`'s own `px-[28px] pt-5 pb-4` differs from the settings body's `px-10 py-9`. Because settings centers its content in a `max-w-[720px]` wrapper, wrap the header so its horizontal padding does not double-inset. If the CDP check (Step 4) shows the title inset too far right, change the replacement to render the header edge-to-edge by giving the wrapper `-mx-[28px]`-free layout: keep the `SurfaceHeader` as above and accept its `px-[28px]`; the title will sit ~8px left of the body text, which is acceptable. Do not add config to `SurfaceHeader` for this.

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: CDP visual check**

Ensure a dev app is running (`task dev`; if headless, `tail -f /dev/null | task dev`). Open Settings (nav rail → Settings, or set startup surface). Capture:

Run: `node scripts/cdp-shot.mjs settings-after.png`
Expected: title reads "Settings" at 25px bold (visibly lighter/smaller than the prior 26px extrabold); subtitle unchanged; the six sections below unchanged.

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/app/view/agents/settingssurface.tsx
git status --short
```

State: "Task 3 done — settings header via SurfaceHeader (25px/bold); CDP-verified."

---

### Task 4: Migrate the sessions surface

Header → `SurfaceHeader` (title + "N live" badge + subtitle + filter chips as actions); "No sessions found." → `SurfaceEmptyState`; the bare "Loading…" string → a `SkeletonLine` block. Root already equals `SURFACE_ROOT` (no change).

**Files:**
- Modify: `frontend/app/view/agents/sessionssurface.tsx` (header 84-114; loading/empty 138-141)

**Interfaces:**
- Consumes: `SurfaceHeader`, `SurfaceEmptyState` (Task 1); `SkeletonLine` (`@/app/element/skeleton`).

- [ ] **Step 1: Add imports**

At the top of `frontend/app/view/agents/sessionssurface.tsx`, add:

```tsx
import { SkeletonLine } from "@/app/element/skeleton";
import { SurfaceEmptyState, SurfaceHeader } from "./surfacescaffold";
```

- [ ] **Step 2: Replace the header block**

Find the header `<div>` (lines 84-114, from `{/* header */}` through its closing `</div>`):

```tsx
            {/* header */}
            <div className="flex-none border-b border-edge-faint px-[26px] pb-[15px] pt-5">
                <div className="mb-1 flex items-center gap-[11px]">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Sessions</h1>
                    {liveCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 rounded-sm border border-accent bg-accentbg px-2 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-soft">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            {liveCount} live
                        </span>
                    ) : null}
                    <div className="flex-1" />
                    <div className="flex items-center gap-1 rounded border border-border bg-surface p-0.5">
                        {FILTERS.map((f) => (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => setFilter(f.key)}
                                className={cn(
                                    "cursor-pointer rounded-sm px-[11px] py-[5px] text-[11px] font-semibold",
                                    filter === f.key ? "bg-accentbg text-primary" : "text-ink-mid hover:text-primary"
                                )}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                </div>
                <p className="text-[13px] text-secondary">
                    Every agent session and its activity — one timeline per run, or the full feed across all of them.
                </p>
            </div>
```

Replace it with:

```tsx
            <SurfaceHeader
                title="Sessions"
                badge={
                    liveCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 rounded-sm border border-accent bg-accentbg px-2 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-soft">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            {liveCount} live
                        </span>
                    ) : null
                }
                subtitle="Every agent session and its activity — one timeline per run, or the full feed across all of them."
                actions={
                    <div className="flex items-center gap-1 rounded border border-border bg-surface p-0.5">
                        {FILTERS.map((f) => (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => setFilter(f.key)}
                                className={cn(
                                    "cursor-pointer rounded-sm px-[11px] py-[5px] text-[11px] font-semibold",
                                    filter === f.key ? "bg-accentbg text-primary" : "text-ink-mid hover:text-primary"
                                )}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                }
            />
```

- [ ] **Step 3: Replace the loading + empty branches**

Find (lines 138-142):

```tsx
                    {base == null ? (
                        <div className="mt-8 text-center text-[13px] text-muted">Loading…</div>
                    ) : groups.length === 0 ? (
                        <div className="mt-8 text-center text-[13px] text-muted">No sessions found.</div>
                    ) : (
```

Replace with:

```tsx
                    {base == null ? (
                        <div className="mt-4 flex flex-col gap-[7px]">
                            {Array.from({ length: 6 }).map((_, i) => (
                                <SkeletonLine key={i} className="h-[58px] rounded-[11px]" />
                            ))}
                        </div>
                    ) : groups.length === 0 ? (
                        <div className="mt-6">
                            <SurfaceEmptyState title="No sessions found" body="Sessions appear here as agents run." />
                        </div>
                    ) : (
```

Note: `SurfaceEmptyState` fills `h-full`; inside the 392px scrolling list column it will center in the available height — acceptable. If the CDP check shows it stretching oddly, wrap it in `<div className="py-10">` instead of relying on `h-full`; do not change the component.

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: CDP visual check**

Open Sessions in the dev app. Inject live agents first if the roster is empty: `node scripts/inject-live-agents.mjs mixed` (see the script header for scenarios).

Run: `node scripts/cdp-shot.mjs sessions-after.png`
Expected: header spacing matches the other surfaces; "N live" badge present when live; the filter chips sit in the right slot; the list still renders. Toggle to a filter that yields zero to confirm the empty state renders.

- [ ] **Step 6: Checkpoint**

```bash
git add frontend/app/view/agents/sessionssurface.tsx
git status --short
```

State: "Task 4 done — sessions header/empty/loading on scaffold; CDP-verified."

---

### Task 5: Migrate the memory surface

Header → `SurfaceHeader` (25px title unchanged; search + Graph/List toggle + New as actions; move chrome text off `ink-*`); "No memory yet" empty → `SurfaceEmptyState`; ensure the root sets `bg-background`.

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx` (local `Header` at 54-106; root container; the inline empty at ~`p-[28px] text-[13px] text-ink-mid` "No memory yet")

**Interfaces:**
- Consumes: `SurfaceHeader`, `SurfaceEmptyState` (Task 1).

- [ ] **Step 1: Add imports**

At the top of `frontend/app/view/agents/memorysurface.tsx`, add:

```tsx
import { SurfaceEmptyState, SurfaceHeader } from "./surfacescaffold";
```

- [ ] **Step 2: Replace the local `Header` component's returned markup**

In the `Header` function (lines 57-104), replace the returned outer `<div className="flex flex-none items-center gap-[14px] px-[28px] pb-[16px] pt-[24px]">…</div>` with a `SurfaceHeader` that keeps the same subtitle content and moves the search/toggle/new into `actions`:

```tsx
    return (
        <SurfaceHeader
            border={false}
            title="Memory"
            subtitle={
                <>
                    What your agents remember · <span className="font-semibold text-primary">{count} saved</span>
                    {pending > 0 && (
                        <> · <span className="font-semibold text-asking">{pending} pending review</span></>
                    )}
                </>
            }
            actions={
                <>
                    <input
                        value={search}
                        onChange={(e) => {
                            globalStore.set(memSearchAtom, e.target.value);
                            globalStore.set(memReflowAnimatedAtom, false);
                        }}
                        placeholder="Search memory…"
                        className="w-[230px] rounded-[9px] border border-border bg-surface px-[12px] py-[8px] text-[13px] text-foreground outline-none placeholder:text-muted"
                    />
                    <div className="flex rounded-[9px] border border-edge-mid bg-surface p-[3px]">
                        <button
                            onClick={() => globalStore.set(memViewAtom, "graph")}
                            className={cn(
                                "rounded-[7px] px-[14px] py-[6px] text-[12px] font-semibold",
                                view === "graph" ? "bg-accentbg text-accent-soft" : "text-muted"
                            )}
                        >
                            Graph
                        </button>
                        <button
                            onClick={() => globalStore.set(memViewAtom, "list")}
                            className={cn(
                                "rounded-[7px] px-[14px] py-[6px] text-[12px] font-semibold",
                                view === "list" ? "bg-accentbg text-accent-soft" : "text-muted"
                            )}
                        >
                            List
                        </button>
                    </div>
                    <button
                        onClick={onNew}
                        className="flex items-center gap-[6px] rounded bg-accent px-[13px] py-[8px] text-[12.5px] font-semibold text-background hover:bg-accenthover"
                    >
                        <span className="-mt-px text-[15px] leading-none">+</span>New memory
                    </button>
                </>
            }
        />
    );
```

(Chrome text-scale: `text-ink-mid` → `text-muted`, `text-ink-hi` → `text-primary` inside this header only.)

- [ ] **Step 3: Ensure the root sets bg-background**

Find the memory surface root (the component that renders `<Header/>` — search for `className="absolute inset-0 flex"`). Change it to include `bg-background`:

```tsx
        <div className="absolute inset-0 flex bg-background">
```

- [ ] **Step 4: Replace the "No memory yet" inline empty**

Search for the inline empty (`No memory yet`) rendered as `<div className="p-[28px] text-[13px] text-ink-mid">…`. Replace that element with:

```tsx
                        <SurfaceEmptyState
                            title="No memory yet"
                            body="Notes your agents save show up here — nothing to review yet."
                        />
```

(If the string is embedded in a larger conditional, replace only the `<div>…No memory yet…</div>` node; keep the surrounding condition.)

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: CDP visual check**

Open Memory in the dev app.

Run: `node scripts/cdp-shot.mjs memory-after.png`
Expected: header matches the canonical spacing/border rule; search + toggle + New in the right slot; list/graph unchanged; the empty state (if no notes) renders centered.

- [ ] **Step 7: Checkpoint**

```bash
git add frontend/app/view/agents/memorysurface.tsx
git status --short
```

State: "Task 5 done — memory header/empty on scaffold, chrome text off ink-*; CDP-verified."

---

### Task 6: Migrate the usage header + adopt SurfaceError

Usage's header → `SurfaceHeader` (add the border-b it currently lacks); its existing `loadError` warning line → `SurfaceError`. Keep the `Segmented` toggle as `actions`.

**Files:**
- Modify: `frontend/app/view/agents/usagesurface.tsx` (header 504-524)

**Interfaces:**
- Consumes: `SurfaceHeader`, `SurfaceError` (Task 1). Uses the existing `loadError` value and `usageWindow`/`setUsageWindow`/`Segmented` already in scope.

- [ ] **Step 1: Add imports**

At the top of `frontend/app/view/agents/usagesurface.tsx`, add:

```tsx
import { SurfaceError, SurfaceHeader } from "./surfacescaffold";
```

- [ ] **Step 2: Replace the header block**

Find (lines 504-524):

```tsx
                    <div className="mb-[22px] flex items-end gap-[18px]">
                        <div className="min-w-0 flex-1">
                            <h1 className="mb-[5px] text-[25px] font-bold tracking-[-0.02em] text-primary">Usage</h1>
                            <p className="max-w-[640px] text-[13.5px] leading-[1.5] text-secondary">
                                Durable history from transcripts, plus live quota while agents run. Spend is an{" "}
                                <span className="text-muted-foreground">≈ API-equivalent</span> estimate from a bundled price
                                table — never a bill.
                            </p>
                            {loadError ? (
                                <p className="mt-1 text-[12px] text-warning">Couldn’t refresh — showing the last loaded usage.</p>
                            ) : null}
                        </div>
                        <Segmented<"7d" | "all">
                            value={usageWindow}
                            onChange={setUsageWindow}
                            options={[
                                { key: "7d", label: "7 days" },
                                { key: "all", label: "All time" },
                            ]}
                        />
                    </div>
```

Replace with:

```tsx
                    <div className="mb-[22px]">
                        <SurfaceHeader
                            border={false}
                            title="Usage"
                            subtitle={
                                <span className="max-w-[640px] leading-[1.5]">
                                    Durable history from transcripts, plus live quota while agents run. Spend is an{" "}
                                    <span className="text-muted-foreground">≈ API-equivalent</span> estimate from a bundled
                                    price table — never a bill.
                                </span>
                            }
                            actions={
                                <Segmented<"7d" | "all">
                                    value={usageWindow}
                                    onChange={setUsageWindow}
                                    options={[
                                        { key: "7d", label: "7 days" },
                                        { key: "all", label: "All time" },
                                    ]}
                                />
                            }
                        />
                        {loadError ? (
                            <SurfaceError message="Couldn’t refresh — showing the last loaded usage." />
                        ) : null}
                    </div>
```

Note: `SurfaceHeader` uses `px-[28px]`; the usage body is inside `mx-auto max-w-[1060px] px-[30px]`. The header will inset ~2px differently from the body — acceptable. Keep `border={false}` (usage scrolls; a hard border under a scrolling body reads oddly).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: CDP visual check**

Open Usage in the dev app.

Run: `node scripts/cdp-shot.mjs usage-after.png`
Expected: "Usage" title + subtitle + Segmented toggle read the same as before, now via the shared header. If `loadError` can be forced (kill wavesrv mid-session), confirm the `SurfaceError` banner renders; otherwise verify by reading the branch.

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/app/view/agents/usagesurface.tsx
git status --short
```

State: "Task 6 done — usage header on scaffold + SurfaceError adopted for loadError; CDP-verified."

---

### Task 7: Migrate the radar header

Radar's `<header>` → `SurfaceHeader`: title "Repo Radar" + "Correctness risk" badge, subtitle = scanning line + coverage chips, actions = `ScopeSelector` + re-scan button. Normalizes `text-2xl`/`px-6 py-4` (Tailwind scale) → the arbitrary-px canonical.

**Files:**
- Modify: `frontend/app/view/agents/radarsurface.tsx` (header 132-174)

**Interfaces:**
- Consumes: `SurfaceHeader` (Task 1). Uses existing `scope`, `coverage`, `isResults`, `state`, `selectScope`, `startScan`, `ScopeSelector` in scope.

- [ ] **Step 1: Add import**

At the top of `frontend/app/view/agents/radarsurface.tsx`, add:

```tsx
import { SurfaceHeader } from "./surfacescaffold";
```

- [ ] **Step 2: Replace the `<header>` block**

Find the `<header>…</header>` (lines 132-174) and replace it with:

```tsx
            <SurfaceHeader
                title="Repo Radar"
                badge={
                    <span className="rounded border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-soft">
                        Correctness risk
                    </span>
                }
                subtitle={
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="text-muted">
                            {scope ? `Scanning ${scope.name}` : "Select a registered project to scan"}
                        </span>
                        {coverage.length > 0 ? (
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-[9px] uppercase tracking-widest text-muted">Coverage</span>
                                {coverage.map((c) => (
                                    <span
                                        key={c.collector}
                                        className={cn(
                                            "font-mono text-[10px]",
                                            c.status === "ok" ? "text-success" : "text-error"
                                        )}
                                    >
                                        {c.status === "ok" ? "✓" : "✗"} {c.collector}
                                    </span>
                                ))}
                            </div>
                        ) : null}
                    </div>
                }
                actions={
                    <>
                        <ScopeSelector scope={scope} onSelect={selectScope} />
                        {isResults && scope ? (
                            <button
                                type="button"
                                onClick={() => fireAndForget(() => startScan(scope.path))}
                                className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-background"
                            >
                                {state === "partial" ? "Re-run full scan" : "Re-scan"}
                            </button>
                        ) : null}
                    </>
                }
            />
```

(Chrome text-scale: the subtitle's `text-muted-foreground` becomes `text-muted` to match the canonical subtitle tone.)

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: CDP visual check**

Open Radar in the dev app; pick a registered project as scope.

Run: `node scripts/cdp-shot.mjs radar-after.png`
Expected: "Repo Radar" now 25px (was `text-2xl`); badge, scanning line, coverage chips, scope selector, and re-scan button all present and correctly placed; header padding matches the other surfaces.

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/app/view/agents/radarsurface.tsx
git status --short
```

State: "Task 7 done — radar header on scaffold (badge + coverage subtitle + scope actions); CDP-verified."

---

### Task 8: Migrate the cockpit header

Cockpit's header is a two-row sticky (title-row + filter-chips row). Use `SurfaceHeader` (with `border={false}`) for the title row inside the existing sticky wrapper, and keep the filter-chips row below it; the sticky wrapper keeps the `border-b`. Title moves 20px → 25px; subtitle moves inline → stacked (SurfaceHeader stacks subtitle).

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (header 364-398; chips row starts 399)

**Interfaces:**
- Consumes: `SurfaceHeader` (Task 1). Uses existing `agents`, `projectCount`, `needsYou`, `RollingCount`, `ProjectSwitcher`, `liveOnly`, `cardPrefs`, `setCardPrefs`, `model` in scope.

- [ ] **Step 1: Add import**

At the top of `frontend/app/view/agents/cockpitsurface.tsx`, add:

```tsx
import { SurfaceHeader } from "./surfacescaffold";
```

- [ ] **Step 2: Replace the title-row `<div>` inside the sticky wrapper**

Keep the sticky wrapper (`<div className="sticky top-0 z-[5] shrink-0 border-b border-border bg-background px-[30px] pb-3 pt-4">`) and the chips row (from `<div className="flex flex-wrap items-center gap-2">` at line 399). Replace ONLY the title-row block (lines 365-398, `<div className="mb-3 flex items-baseline gap-3">…</div>`) with:

```tsx
                    <div className="mb-3 -mx-[30px] -mt-4">
                        <SurfaceHeader
                            border={false}
                            title="Cockpit"
                            subtitle={
                                <>
                                    {agents.length} agents · {projectCount} projects ·{" "}
                                    <span className="font-semibold text-warning">
                                        <RollingCount value={needsYou} /> need you
                                    </span>
                                </>
                            }
                            actions={
                                <>
                                    <ProjectSwitcher model={model} variant="header" />
                                    <button
                                        type="button"
                                        onClick={() => globalStore.set(model.liveOnlyAtom, !liveOnly)}
                                        className={cn(
                                            "flex cursor-pointer items-center gap-[7px] rounded border px-2.5 py-1.5 text-[12px] font-medium",
                                            liveOnly
                                                ? "border-success/60 bg-success/10 text-success"
                                                : "border-edge-mid bg-surface-raised text-muted-foreground hover:border-edge-strong"
                                        )}
                                    >
                                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                        Live only
                                    </button>
                                    {Object.values(cardPrefs).some((p) => p.fullWidth || p.heightWeight != null) ? (
                                        <button
                                            type="button"
                                            onClick={() => setCardPrefs({})}
                                            className="cursor-pointer rounded border border-edge-mid px-2.5 py-1.5 text-[12px] text-muted hover:border-edge-strong"
                                        >
                                            Reset layout
                                        </button>
                                    ) : null}
                                </>
                            }
                        />
                    </div>
```

Rationale for `-mx-[30px] -mt-4`: the sticky wrapper already pads `px-[30px] pt-4`; `SurfaceHeader` adds its own `px-[28px] pt-5`. The negative margins cancel the wrapper's padding so the shared header controls spacing and the title/chips stay vertically aligned. Verify alignment in Step 4; if the chips row drifts, drop the negative margins and instead pass a plain title-row (this is the one surface where the wrapper padding collides).

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: CDP visual check**

Open the Cockpit surface with a populated roster (`node scripts/inject-live-agents.mjs mixed`).

Run: `node scripts/cdp-shot.mjs cockpit-after.png`
Expected: "Cockpit" title now 25px; the "N agents · N projects · N need you" line sits directly under the title (stacked); ProjectSwitcher + Live-only + Reset-layout in the right slot; the four filter chips (All/Asking/Working/Idle) still render as the second row directly below, with the sticky bottom border intact. The empty state (zero agents) still renders via the existing `CockpitEmptyState` (unchanged by this task).

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/app/view/agents/cockpitsurface.tsx
git status --short
```

State: "Task 8 done — cockpit title row on SurfaceHeader (25px, stacked subtitle) inside the sticky wrapper; chips row + border preserved; CDP-verified."

---

### Task 9: Files surface — partial adoption

No page header (the "Diff" title lives in the 292px sidebar and stays). Route `EmptyCenter` through `SurfaceEmptyState` for the top-level "no source" empty; move its chrome text off `ink-*`; keep the 2-pane layout.

**Files:**
- Modify: `frontend/app/view/agents/filessurface.tsx` (`EmptyCenter` 134-136; the surface-level empty at line 329)

**Interfaces:**
- Consumes: `SurfaceEmptyState` (Task 1).

- [ ] **Step 1: Add import**

At the top of `frontend/app/view/agents/filessurface.tsx`, add:

```tsx
import { SurfaceEmptyState } from "./surfacescaffold";
```

- [ ] **Step 2: Keep the small `EmptyCenter` for in-pane messages; use `SurfaceEmptyState` for the surface-level empty**

`EmptyCenter` (a compact centered line) is correct for the *detail-pane* placeholder ("Select a file to view its changes", line 229) — keep it, but move its color off `ink-*`:

```tsx
function EmptyCenter({ msg }: { msg: string }) {
    return <div className="flex h-full items-center justify-center text-[13px] text-muted">{msg}</div>;
}
```

For the *surface-level* empty (line 329, "No agents or projects yet…"), replace:

```tsx
        return <EmptyCenter msg="No agents or projects yet — start an agent to see its changed files" />;
```

with:

```tsx
        return (
            <SurfaceEmptyState
                title="No changes to show"
                body="Start an agent or pick a project to see its changed files here."
            />
        );
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 4: CDP visual check**

Open Files with no agents/projects selected (or a fresh dev data dir via `task dev:cleardata` — only if acceptable to wipe dev data; otherwise deselect all sources).

Run: `node scripts/cdp-shot.mjs files-after.png`
Expected: the top-level empty renders the centered `SurfaceEmptyState`; selecting a source restores the 2-pane list+diff; the detail-pane "Select a file…" placeholder still reads via `EmptyCenter`.

- [ ] **Step 5: Checkpoint**

```bash
git add frontend/app/view/agents/filessurface.tsx
git status --short
```

State: "Task 9 done — files surface-level empty via SurfaceEmptyState, EmptyCenter kept for in-pane + off ink-*; 2-pane preserved; CDP-verified."

---

### Task 10: Channels surface — partial adoption

Keep the 2-pane layout and the per-channel `ChannelHeader`. Route the "No channel yet" empty through `SurfaceEmptyState`; ensure the root sets `bg-background` (it uses `absolute inset-0 flex`).

**Files:**
- Modify: `frontend/app/view/agents/channelssurface.tsx` (root 240; empty at ~380)

**Interfaces:**
- Consumes: `SurfaceEmptyState` (Task 1).

- [ ] **Step 1: Add import**

At the top of `frontend/app/view/agents/channelssurface.tsx`, add:

```tsx
import { SurfaceEmptyState } from "./surfacescaffold";
```

- [ ] **Step 2: Ensure the root sets bg-background**

Find (line 240):

```tsx
            <div className="absolute inset-0 flex">
```

Replace with:

```tsx
            <div className="absolute inset-0 flex bg-background">
```

- [ ] **Step 3: Replace the "No channel yet" empty**

Read the block around line 380 first (`grep -n "No channel yet" frontend/app/view/agents/channelssurface.tsx`, then read ~15 lines of context). It renders inside a centered wrapper like `<div className="mt-16 text-center text-[13px] text-muted">No channel yet — click …</div>`. Replace that wrapper node with:

```tsx
                                        <SurfaceEmptyState
                                            title="No channel yet"
                                            body={
                                                <>
                                                    Click <span className="text-secondary">＋ New channel</span> to create one
                                                    bound to a project.
                                                </>
                                            }
                                        />
```

Keep the surrounding conditional (only swap the empty node itself). If a sibling "Start a run in #…" empty exists in the same file with the same `text-[13px] text-muted` shape, leave it (it is per-channel run chrome, out of scope for this pass).

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 5: CDP visual check**

Open Channels with no channels created.

Run: `node scripts/cdp-shot.mjs channels-after.png`
Expected: the "No channel yet" state renders the centered `SurfaceEmptyState`; creating/selecting a channel restores the 2-pane view with its `ChannelHeader` intact.

- [ ] **Step 6: Checkpoint**

```bash
git add frontend/app/view/agents/channelssurface.tsx
git status --short
```

State: "Task 10 done — channels empty via SurfaceEmptyState + root bg-background; 2-pane + ChannelHeader preserved; CDP-verified."

---

### Task 11: Agent surface — container token only

The agent surface is a full-bleed live TUI with its own `AgentHeader` and launch hero. It gets no page header. The only consistency fix: its root does not set `bg-background`. Add it so the surface is correct if ever mounted outside the shell, matching the convention.

**Files:**
- Modify: `frontend/app/view/agents/agentsurface.tsx:82`

**Interfaces:**
- None (pure className change).

- [ ] **Step 1: Add bg-background to the root**

Find (line 82):

```tsx
            <div ref={wrapRef} tabIndex={0} data-cockpit-surface-wrap className="flex h-full w-full outline-none">
```

Replace with:

```tsx
            <div ref={wrapRef} tabIndex={0} data-cockpit-surface-wrap className="flex h-full w-full bg-background outline-none">
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: CDP visual check**

Focus a live agent (`node scripts/inject-live-agents.mjs mixed`, then open the Agent surface).

Run: `node scripts/cdp-shot.mjs agent-after.png`
Expected: the live TUI, `AgentHeader`, and launch hero look identical to before (the `bg-background` change is invisible when the terminal fills the pane; it only matters at the edges). Confirm the TUI is not visually broken.

- [ ] **Step 4: Checkpoint**

```bash
git add frontend/app/view/agents/agentsurface.tsx
git status --short
```

State: "Task 11 done — agent root sets bg-background; TUI unaffected; CDP-verified."

---

### Task 12: Full verification + single approval-gated commit

**Files:** none (verification + commit).

- [ ] **Step 1: Typecheck the whole frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (clean baseline preserved).

- [ ] **Step 2: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — same pass count as the pre-Task-1 baseline (this plan changes no logic; note the one known pre-existing Go-only failure `pkg/tsgen TestGenerateWaveEventTypes` is unrelated and not run by vitest).

- [ ] **Step 3: CDP sweep of every migrated surface**

With a populated dev app (`node scripts/inject-live-agents.mjs mixed`), screenshot each surface and eyeball for consistency (same header height, same title size 25px, same padding, borders where expected):

```bash
node scripts/cdp-shot.mjs verify-cockpit.png    # then switch surface via nav rail / palette between shots
node scripts/cdp-shot.mjs verify-sessions.png
node scripts/cdp-shot.mjs verify-usage.png
node scripts/cdp-shot.mjs verify-memory.png
node scripts/cdp-shot.mjs verify-radar.png
node scripts/cdp-shot.mjs verify-settings.png
node scripts/cdp-shot.mjs verify-files.png
node scripts/cdp-shot.mjs verify-channels.png
node scripts/cdp-shot.mjs verify-agent.png
```

Expected: the seven full-migration surfaces share one header look; files/channels/agent keep their bespoke layouts but read as the same product (tokens, empty states). Note any surface that looks off and fix before committing.

- [ ] **Step 4: Self-review the diff**

Run: `git diff --stat` then `git diff`
Confirm: only the 11 files + the new scaffold changed; no stray `ink-*` chrome left in the touched headers; no commented-out code; no debug statements; no unrelated edits.

- [ ] **Step 5: Request approval, then commit (single commit, incl. spec + plan)**

Stage everything, including the spec and this plan (they fold into the feature commit per repo policy):

```bash
git add frontend/app/view/agents/surfacescaffold.tsx \
        frontend/app/view/agents/placeholdersurface.tsx \
        frontend/app/view/agents/settingssurface.tsx \
        frontend/app/view/agents/sessionssurface.tsx \
        frontend/app/view/agents/memorysurface.tsx \
        frontend/app/view/agents/usagesurface.tsx \
        frontend/app/view/agents/radarsurface.tsx \
        frontend/app/view/agents/cockpitsurface.tsx \
        frontend/app/view/agents/filessurface.tsx \
        frontend/app/view/agents/channelssurface.tsx \
        frontend/app/view/agents/agentsurface.tsx \
        docs/superpowers/specs/2026-07-14-cross-surface-consistency-scaffold-design.md \
        docs/superpowers/plans/2026-07-14-cross-surface-consistency-scaffold.md
git status --short
```

Proposed message (present to the user; do NOT commit without explicit approval; add no co-author):

```
feat(cockpit): shared surface-chrome scaffold + migrate surfaces

Add SurfaceHeader / SurfaceEmptyState / SurfaceError + SURFACE_ROOT
(surfacescaffold.tsx) as the single source of truth for surface chrome.
Migrate 7 surfaces fully (cockpit, sessions, usage, memory, radar,
settings, placeholder) and 3 partially (files, channels, agent) onto one
canonical header, empty state, container, and text scale.
```

Ask: "Awaiting approval. Proceed with the commit? (yes/no)"

---

## Follow-ups (out of scope for this plan)

- **SurfaceError store wiring** — add error atoms + redirect the swallowed `.catch` in `memstore.loadMemory` (catch ~75), `radarstore.loadReports` (catch ~97), `channelsstore.loadChannels` (catch ~43), `filesstore.loadFilesForAgent`/`loadFilesForProject` (catch ~63/~119) to set an error atom, and render `SurfaceError` on each surface. Needs per-store load-path reads; a short standalone slice.
- **Full `ink-*` deprecation** across the ~50 child components.
- **Interaction-pattern consistency** (keyboard nav / selection model across surfaces).

## Self-Review

**1. Spec coverage:**
- Scaffold file + `SurfaceHeader`/`SurfaceEmptyState`/`SurfaceError` + `SURFACE_ROOT` → Task 1. ✓
- Canonical text scale (chrome only) → applied in Tasks 5 (memory), 7 (radar), 9 (files); constrained in Global Constraints. ✓
- Canonical header (25px, padding, border toggle) → Task 1 + Tasks 3-8. ✓
- Full migrations (cockpit, radar, sessions, usage, memory, settings, placeholder) → Tasks 8, 7, 4, 6, 5, 3, 2. ✓
- Partial migrations (agent, files, channels) → Tasks 11, 9, 10. ✓
- Loading standardized on `Skeleton` → Task 4 (sessions); usage/files/memory already use it (unchanged). ✓
- Container convention / bg-background → Tasks 5, 10, 11 (surfaces missing it); others already set it. ✓
- Testing = CDP + tsc, no DOM unit tests, no new deps → Global Constraints + every task's Steps. ✓
- Visible normalizations flagged (cockpit/channels 20→25, settings 26→25, radar Tailwind→px) → Tasks 8, 10 (channels empty only — channels title untouched, it has no page title), 3, 7. Note: channels has no page-level title to normalize (its `ChannelHeader` is per-channel and stays), so the "channels 20→25" item from the spec applies only to its empty-state copy tone, handled in Task 10. ✓
- SurfaceError full store wiring → explicitly deferred (Follow-ups) with grounded catch-site line numbers. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code; every command has expected output. The two "read context first" instructions (Task 10 Step 3 channels empty; general) point at a `grep` + narrow read because the exact surrounding lines were not captured in planning — the replacement JSX is fully specified. ✓

**3. Type consistency:** `SurfaceHeader`/`SurfaceEmptyState`/`SurfaceError` prop names (`title`, `badge`, `subtitle`, `actions`, `border`, `glyph`, `body`, `action.{label,onClick,hint}`, `message`, `onRetry`) are defined in Task 1 and consumed unchanged in Tasks 2-10. `SURFACE_ROOT` exported in Task 1; referenced as the container convention (surfaces already matching it are left as-is). `action.label` is `ReactNode` (not `string`), consistent with cockpit's future rich-label needs and the plain-string usages in Tasks 2/4/9/10. ✓
