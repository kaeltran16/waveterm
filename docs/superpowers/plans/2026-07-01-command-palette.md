# Command Palette (Ctrl+P) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the render-only command-palette stub in the cockpit app bar into a working `Ctrl+P` overlay that fuzzy-searches live agents, resumable sessions, and commands, and dispatches the selected action.

**Architecture:** A pure fuzzy matcher (unit-tested) plus a hand-rolled overlay component following the existing `NewAgentModal` pattern — a jotai visibility atom on `AgentsViewModel`, a fixed overlay rendered from `cockpit-root`, opened by a global capture-phase `Ctrl+P` chord. The palette builds a unified `PaletteItem[]` from three existing atoms; the pure ranker sees only searchable strings while action closures stay in the component.

**Tech Stack:** React 19, jotai, Tailwind 4, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-01-command-palette-design.md`

**Git note (user convention):** Do NOT commit per-task. The steps below omit per-task commits; all changes plus the spec doc fold into a single feature commit at the end (Task 8), shown for approval first.

---

## File structure

| File | Responsibility |
|---|---|
| `frontend/app/cockpit/palette-match.ts` | Pure fuzzy matcher + ranker (new) |
| `frontend/app/cockpit/palette-match.test.ts` | Unit tests for the matcher (new) |
| `frontend/app/cockpit/command-palette.tsx` | Overlay component: builds items, ranks, renders, keyboard nav (new) |
| `frontend/app/view/agents/agents.tsx` | Add `paletteOpenAtom` to `AgentsViewModel` (edit) |
| `frontend/app/view/agents/navrail.tsx` | Export `ITEMS` so the palette reuses surface labels (edit) |
| `frontend/app/cockpit/app-bar.tsx` | Wire stub `onClick`; badge `⌘K`→`⌘P` (edit) |
| `frontend/app/cockpit/cockpit-root.tsx` | Render `<CommandPalette>`; global `Ctrl+P` binding (edit) |
| `docs/deferred.md` | Mark the palette entry resolved (edit) |

---

## Task 1: Pure fuzzy matcher

**Files:**
- Create: `frontend/app/cockpit/palette-match.ts`
- Test: `frontend/app/cockpit/palette-match.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/cockpit/palette-match.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fuzzyScore, rankPaletteItems } from "./palette-match";

describe("fuzzyScore", () => {
    it("returns null when query chars are not a subsequence", () => {
        expect(fuzzyScore("xyz", "New agent")).toBeNull();
    });
    it("matches a gapped subsequence", () => {
        expect(fuzzyScore("nag", "New agent")).not.toBeNull();
    });
    it("is case-insensitive", () => {
        expect(fuzzyScore("NEW", "new agent")).not.toBeNull();
    });
    it("empty query scores 0 (not null)", () => {
        expect(fuzzyScore("", "anything")).toBe(0);
    });
    it("scores a contiguous run higher than a gapped one", () => {
        const contiguous = fuzzyScore("abc", "abcxyz")!;
        const gapped = fuzzyScore("abc", "axbxcx")!;
        expect(contiguous).toBeGreaterThan(gapped);
    });
});

describe("rankPaletteItems", () => {
    const items = [
        { search: "Profile" },
        { search: "Go to Files" },
        { search: "axbxcx" },
        { search: "abcxyz" },
    ];

    it("passes items through unchanged for an empty query", () => {
        expect(rankPaletteItems(items, "").map((i) => i.search)).toEqual(items.map((i) => i.search));
    });
    it("drops non-matches", () => {
        expect(rankPaletteItems(items, "zzz")).toEqual([]);
    });
    it("ranks a word-boundary match above a mid-word match", () => {
        // "file" starts a word in "Go to Files" but is mid-word in "Profile"
        const ranked = rankPaletteItems(items, "file").map((i) => i.search);
        expect(ranked[0]).toBe("Go to Files");
    });
    it("ranks a contiguous match above a gapped match", () => {
        const ranked = rankPaletteItems(items, "abc").map((i) => i.search);
        expect(ranked.indexOf("abcxyz")).toBeLessThan(ranked.indexOf("axbxcx"));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/cockpit/palette-match.test.ts`
Expected: FAIL — cannot resolve `./palette-match` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `frontend/app/cockpit/palette-match.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Hand-rolled fuzzy matcher for the command palette. Case-insensitive subsequence
// scoring that rewards contiguous runs and word-boundary starts and penalizes gaps.

const CONTIGUOUS_BONUS = 5;
const WORD_BOUNDARY_BONUS = 3;
const MATCH_POINT = 1;
const MAX_GAP_PENALTY = 3;

function isWordChar(ch: string): boolean {
    return /[a-z0-9]/.test(ch);
}

/**
 * Case-insensitive subsequence match. Returns a score (higher = better), or null
 * when the query chars do not all appear in order within `text`. Empty query -> 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return 0;
    }
    const t = text.toLowerCase();
    let score = 0;
    let ti = 0;
    let prevMatch = -2; // sentinel: no previous match, and not adjacent to index 0
    for (const ch of q) {
        let found = -1;
        for (let j = ti; j < t.length; j++) {
            if (t[j] === ch) {
                found = j;
                break;
            }
        }
        if (found === -1) {
            return null;
        }
        score += MATCH_POINT;
        if (found === prevMatch + 1) {
            score += CONTIGUOUS_BONUS;
        }
        if (found === 0 || !isWordChar(t[found - 1])) {
            score += WORD_BOUNDARY_BONUS;
        }
        if (prevMatch >= 0) {
            const gap = found - (prevMatch + 1);
            if (gap > 0) {
                score -= Math.min(gap, MAX_GAP_PENALTY);
            }
        }
        prevMatch = found;
        ti = found + 1;
    }
    return score;
}

/**
 * Ranks searchable items by fuzzyScore(query, item.search) descending, dropping
 * non-matches. Empty/whitespace query -> passthrough in natural (input) order.
 * Array.prototype.sort is stable, so ties keep their input order.
 */
export function rankPaletteItems<T extends { search: string }>(items: T[], query: string): T[] {
    if (query.trim() === "") {
        return items;
    }
    const scored: { item: T; score: number }[] = [];
    for (const item of items) {
        const score = fuzzyScore(query, item.search);
        if (score != null) {
            scored.push({ item, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/cockpit/palette-match.test.ts`
Expected: PASS — all 9 tests green.

---

## Task 2: Add `paletteOpenAtom` to the view model

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx:86-88`

- [ ] **Step 1: Add the atom**

In `frontend/app/view/agents/agents.tsx`, find the block:

```ts
    // New Project / New Agent modal visibility (gated overlays rendered from the cockpit root).
    newProjectOpenAtom = atom(false);
    newAgentOpenAtom = atom(false);
```

Replace it with:

```ts
    // New Project / New Agent modal + command-palette visibility (gated overlays rendered from the cockpit root).
    newProjectOpenAtom = atom(false);
    newAgentOpenAtom = atom(false);
    paletteOpenAtom = atom(false);
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline: 3 pre-existing errors in `frontend/tauri/api.test.ts` only).

---

## Task 3: Export navrail surface labels for reuse

**Files:**
- Modify: `frontend/app/view/agents/navrail.tsx:86`

- [ ] **Step 1: Export the ITEMS array**

In `frontend/app/view/agents/navrail.tsx`, change line 86 from:

```ts
const ITEMS: { key: SurfaceKey; label: string }[] = [
```

to:

```ts
export const ITEMS: { key: SurfaceKey; label: string }[] = [
```

Leave the rest of the file (including its own `ITEMS.map(...)` usage) unchanged.

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

---

## Task 4: The command-palette overlay component

**Files:**
- Create: `frontend/app/cockpit/command-palette.tsx`

- [ ] **Step 1: Write the component**

Create `frontend/app/cockpit/command-palette.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Command palette overlay (Ctrl+P). Fuzzy-searches live agents, resumable sessions,
// and cockpit commands, and dispatches the selected item's action. Hand-rolled to match
// the NewAgentModal overlay pattern (jotai visibility atom + fixed overlay from cockpit-root).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import type { Runtime } from "@/app/view/agents/launch";
import { ITEMS as SURFACE_ITEMS } from "@/app/view/agents/navrail";
import { loadSessionsArchive, sessionsArchiveAtom } from "@/app/view/agents/sessionsarchivestore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { rankPaletteItems } from "./palette-match";

type PaletteKind = "command" | "agent" | "session";

interface PaletteItem {
    key: string;
    kind: PaletteKind;
    search: string; // matched text (title + keywords)
    title: string;
    subtitle?: string;
    hint?: string; // right-aligned (session age)
    run: () => void;
}

const GROUP_ORDER: PaletteKind[] = ["command", "agent", "session"];
const GROUP_LABELS: Record<PaletteKind, string> = {
    command: "Commands",
    agent: "Agents",
    session: "Sessions",
};

export function CommandPalette({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.paletteOpenAtom);
    const agents = useAtomValue(model.agentsAtom);
    const sessions = useAtomValue(sessionsArchiveAtom);
    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const loadedRef = useRef(false);

    const close = () => globalStore.set(model.paletteOpenAtom, false);

    // Lazy-load the sessions archive on first open (as SessionsSurface does).
    useEffect(() => {
        if (open && !loadedRef.current) {
            loadedRef.current = true;
            fireAndForget(loadSessionsArchive);
        }
    }, [open]);

    // Each open: reset query + selection and focus the input after paint.
    useEffect(() => {
        if (!open) {
            return;
        }
        setQuery("");
        setSel(0);
        const raf = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [open]);

    const items = useMemo<PaletteItem[]>(() => {
        const now = Date.now();
        const commands: PaletteItem[] = [
            ...SURFACE_ITEMS.map((it) => ({
                key: `cmd:surface:${it.key}`,
                kind: "command" as const,
                search: `Go to ${it.label}`,
                title: `Go to ${it.label}`,
                run: () => {
                    globalStore.set(model.surfaceAtom, it.key);
                    close();
                },
            })),
            {
                key: "cmd:new-agent",
                kind: "command",
                search: "New agent",
                title: "New agent",
                run: () => {
                    globalStore.set(model.newAgentOpenAtom, true);
                    close();
                },
            },
            {
                key: "cmd:new-project",
                kind: "command",
                search: "New project",
                title: "New project",
                run: () => {
                    globalStore.set(model.newProjectOpenAtom, true);
                    close();
                },
            },
        ];
        const agentItems: PaletteItem[] = agents.map((a) => ({
            key: `agent:${a.id}`,
            kind: "agent" as const,
            search: `${a.name} ${a.task ?? ""} ${a.project ?? ""}`,
            title: a.task ? `${a.name} — ${a.task}` : a.name,
            subtitle: [a.project, a.state].filter(Boolean).join(" · ") || undefined,
            run: () => {
                model.openTerminal(a.id);
                close();
            },
        }));
        const sessionItems: PaletteItem[] = (sessions ?? [])
            .filter((s) => s.resumecommand)
            .map((s) => ({
                key: `session:${s.runtime}:${s.id}`,
                kind: "session" as const,
                search: `${s.task} ${s.projectname} ${s.branch}`,
                title: s.task || "(untitled session)",
                subtitle: [s.projectname, s.branch || "—", s.model || "—"].join(" · "),
                hint: formatAge(now - s.lastactivets),
                run: () => {
                    fireAndForget(() =>
                        launchAgent(model, {
                            runtime: s.runtime as Runtime,
                            startupCommand: s.resumecommand!,
                            task: "",
                            projectPath: s.projectpath,
                            projectName: s.projectname || "agent",
                        })
                    );
                    close();
                },
            }));
        return [...commands, ...agentItems, ...sessionItems];
    }, [agents, sessions, model]);

    // rankPaletteItems sorts globally by score; re-grouping by kind preserves per-kind
    // score order (stable sort). Empty query -> natural order in GROUP_ORDER.
    const ranked = useMemo(() => rankPaletteItems(items, query), [items, query]);
    const groups = GROUP_ORDER.map((kind) => ({ kind, items: ranked.filter((it) => it.kind === kind) })).filter(
        (g) => g.items.length > 0
    );
    const flat = groups.flatMap((g) => g.items);
    const selClamped = flat.length === 0 ? 0 : Math.min(sel, flat.length - 1);
    const flatIndex = new Map(flat.map((it, i) => [it.key, i]));

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => (flat.length ? (s + 1) % flat.length : 0));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => (flat.length ? (s - 1 + flat.length) % flat.length : 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            flat[selClamped]?.run();
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    };

    if (!open) {
        return null;
    }
    return (
        <div
            className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 pt-[11vh] backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                    close();
                }
            }}
        >
            <div className="flex max-h-[70vh] w-[min(640px,93vw)] flex-col overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover">
                <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-4 py-[13px]">
                    <svg
                        width="15"
                        height="15"
                        viewBox="0 0 13 13"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="shrink-0 text-muted"
                    >
                        <circle cx="5.5" cy="5.5" r="4" />
                        <path d="M9 9l3 3" strokeLinecap="round" />
                    </svg>
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSel(0);
                        }}
                        onKeyDown={onKeyDown}
                        placeholder="Search agents, sessions, commands…"
                        className="flex-1 bg-transparent text-[14px] text-primary outline-none placeholder:text-muted"
                    />
                    <span className="shrink-0 rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                        esc
                    </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto py-2">
                    {flat.length === 0 ? (
                        <div className="px-4 py-8 text-center text-[13px] text-muted">No results.</div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.kind}>
                                <div className="px-4 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                    {GROUP_LABELS[g.kind]}
                                </div>
                                {g.items.map((it) => {
                                    const myIdx = flatIndex.get(it.key)!;
                                    const active = myIdx === selClamped;
                                    return (
                                        <button
                                            key={it.key}
                                            type="button"
                                            onMouseMove={() => setSel(myIdx)}
                                            onClick={() => it.run()}
                                            className={cn(
                                                "flex w-full cursor-pointer items-center gap-3 px-4 py-[7px] text-left",
                                                active ? "bg-accentbg" : "hover:bg-surface-hover"
                                            )}
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span
                                                    className={cn(
                                                        "block truncate text-[13px]",
                                                        active ? "text-primary" : "text-secondary"
                                                    )}
                                                >
                                                    {it.title}
                                                </span>
                                                {it.subtitle ? (
                                                    <span className="block truncate font-mono text-[10.5px] text-muted">
                                                        {it.subtitle}
                                                    </span>
                                                ) : null}
                                            </span>
                                            {it.hint ? (
                                                <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                                    {it.hint}
                                                </span>
                                            ) : null}
                                            {active ? (
                                                <span className="shrink-0 font-mono text-[11px] text-accent-soft">⏎</span>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors. If `s.resumecommand!` or `s.runtime as Runtime` errors, confirm `SessionInfo` field names via `grep -n "resumecommand\|projectpath\|lastactivets" frontend/app/view/agents/sessionsarchivestore.ts` and adjust.

---

## Task 5: Wire the app-bar stub

**Files:**
- Modify: `frontend/app/cockpit/app-bar.tsx:42-54`

- [ ] **Step 1: Replace the stub button**

In `frontend/app/cockpit/app-bar.tsx`, replace:

```tsx
            {/* DEFERRED: command palette — render-only stub (docs/deferred.md) */}
            <button
                type="button"
                onClick={() => {}}
                className="mx-auto flex w-[min(520px,42%)] cursor-text items-center gap-2.5 rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-[7px] text-muted hover:border-edge-strong hover:bg-surface-hover"
            >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="5.5" cy="5.5" r="4" />
                    <path d="M9 9l3 3" strokeLinecap="round" />
                </svg>
                <span className="flex-1 text-left text-[13px]">Search agents, sessions, commands…</span>
                <span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px]">⌘K</span>
            </button>
```

with:

```tsx
            <button
                type="button"
                onClick={() => globalStore.set(model.paletteOpenAtom, true)}
                className="mx-auto flex w-[min(520px,42%)] cursor-text items-center gap-2.5 rounded-[9px] border border-edge-mid bg-surface-raised px-3 py-[7px] text-muted hover:border-edge-strong hover:bg-surface-hover"
            >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="5.5" cy="5.5" r="4" />
                    <path d="M9 9l3 3" strokeLinecap="round" />
                </svg>
                <span className="flex-1 text-left text-[13px]">Search agents, sessions, commands…</span>
                <span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[11px]">⌘P</span>
            </button>
```

(`globalStore` is already imported at the top of this file.)

---

## Task 6: Render the palette + global Ctrl+P binding

**Files:**
- Modify: `frontend/app/cockpit/cockpit-root.tsx:16` (import), `:68-72` (chord), `:115-117` (render)

- [ ] **Step 1: Import the component**

In `frontend/app/cockpit/cockpit-root.tsx`, after:

```tsx
import { CockpitAppBar } from "./app-bar";
```

add:

```tsx
import { CommandPalette } from "./command-palette";
```

- [ ] **Step 2: Add the global Ctrl+P chord**

In the capture-phase listener (`onKeyCapture`), find the surface-number block:

```tsx
            // Ctrl+1..8 -> jump directly to a surface (works on any surface, even in the terminal)
            if (!e.shiftKey && /^[1-8]$/.test(e.key)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                globalStore.set(model.surfaceAtom, SURFACE_ORDER[parseInt(e.key, 10) - 1]);
                return;
            }
```

Immediately AFTER that block, add:

```tsx
            // Ctrl+P -> toggle the command palette. Global (preempts the terminal's readline
            // Ctrl+P history-back) — intentional, matches the Ctrl+1..8 capture behavior above.
            if ((e.key === "p" || e.key === "P") && !e.shiftKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                globalStore.set(model.paletteOpenAtom, (v) => !v);
                return;
            }
```

- [ ] **Step 3: Render the overlay**

Find:

```tsx
            <NewProjectModal model={model} />
            <NewAgentModal model={model} />
            <ModalsRenderer />
```

Replace with:

```tsx
            <NewProjectModal model={model} />
            <NewAgentModal model={model} />
            <CommandPalette model={model} />
            <ModalsRenderer />
```

- [ ] **Step 4: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

---

## Task 7: Mark the deferred entry resolved

**Files:**
- Modify: `docs/deferred.md:144-159`

- [ ] **Step 1: Prepend a resolution note**

In `docs/deferred.md`, replace the heading line:

```markdown
## Command palette (⌘K)
```

with:

```markdown
## Command palette (⌘K) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (command-palette):** shipped as a working `Ctrl+P` overlay
> (`frontend/app/cockpit/command-palette.tsx` + pure matcher `palette-match.ts`). Fuzzy-searches
> live agents (focus), resumable sessions (resume), and commands (surface nav + New agent/project);
> grouped results, arrow/Enter/Esc nav; opened by the app-bar box or global `Ctrl+P` (replaces the
> terminal's readline Ctrl+P, per user). **v1 exclusions:** read-only sessions (no `resumecommand`)
> are hidden so every row is actionable; results are grouped-by-kind, not one global score-sorted
> list. Both are reversible v2 tweaks. Original entry below.
```

Leave the original entry text beneath it intact.

---

## Task 8: Full verification + single feature commit

**Files:** none (verification + commit)

- [ ] **Step 1: Run the unit tests**

Run: `npx vitest run frontend/app/cockpit/palette-match.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 2: Typecheck the whole frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the 3 baseline errors in `frontend/tauri/api.test.ts`; no others.

- [ ] **Step 3: Visual check (CDP, live dev app)**

With `task dev` running (see the dev gotcha: `tail -f /dev/null | task dev` for headless), verify in the dev app:
- Press `Ctrl+P` → palette opens, input focused.
- Type `age` → "Go to Agent" / "New agent" rank near the top; arrow-down highlights move; Enter dispatches (jumps surface / opens modal).
- Type a live agent's name → selecting it focuses the Agent surface on that agent.
- `Esc` and backdrop-click close.

Capture: `node scripts/cdp-shot.mjs palette.png`. If a fixture is loaded, agent rows come from the mock; sessions require a real archive.

- [ ] **Step 4: Show the diff for approval, then commit (per user git workflow)**

Run: `git status --short` and `git diff --stat`, then present the file list (M/A) and this message to the user and ask "Awaiting approval. Proceed? (yes/no)":

```
feat(cockpit): command palette (Ctrl+P) over agents, sessions, commands

Replace the render-only app-bar stub with a working fuzzy palette: live agents
(focus), resumable sessions (resume), and commands (surface nav + New agent/project).
Global Ctrl+P replaces the terminal's readline binding. Hand-rolled matcher + overlay,
no new deps. Closes the command-palette deferred entry.
```

Only after "yes", stage and commit (spec + plan + code together, one commit):

```bash
git add frontend/app/cockpit/palette-match.ts frontend/app/cockpit/palette-match.test.ts \
  frontend/app/cockpit/command-palette.tsx frontend/app/cockpit/app-bar.tsx \
  frontend/app/cockpit/cockpit-root.tsx frontend/app/view/agents/agents.tsx \
  frontend/app/view/agents/navrail.tsx docs/deferred.md \
  docs/superpowers/specs/2026-07-01-command-palette-design.md \
  docs/superpowers/plans/2026-07-01-command-palette.md
git commit
```

---

## Self-review

**Spec coverage:**
- Fuzzy subsequence matcher (contiguity + word-boundary) → Task 1. ✓
- `paletteOpenAtom` on the model → Task 2. ✓
- Commands (8 surface jumps + New agent + New project) → Task 4 (labels reused from navrail via Task 3). ✓
- Agents (name/task/project search, `openTerminal` dispatch) → Task 4. ✓
- Sessions (resumable-only, lazy load, `launchAgent` resume) → Task 4. ✓
- Grouped rendering, flat keyboard nav, empty-query launcher → Task 4. ✓
- App-bar wiring + `⌘K`→`⌘P` badge → Task 5. ✓
- Global capture-phase Ctrl+P + render from cockpit-root → Task 6. ✓
- Deferred entry resolved → Task 7. ✓
- Unit + visual verification → Tasks 1 & 8. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code.

**Type consistency:** `PaletteItem` (fields `key/kind/search/title/subtitle?/hint?/run`) defined in Task 4 and used consistently; `fuzzyScore`/`rankPaletteItems` signatures match between Task 1 definition and Task 4 usage; `ITEMS` export (Task 3) consumed as `SURFACE_ITEMS` (Task 4); `paletteOpenAtom` defined Task 2, used Tasks 4/5/6.
