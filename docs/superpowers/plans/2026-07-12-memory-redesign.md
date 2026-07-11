# Memory Surface Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the Memory surface to match `Wave-memory.dc.html`: a first-class inline pending-review band (per-card Keep/Dismiss + Keep-all/Dismiss-all), a detail-rail pending-review mode, an enriched pending-note wire type (title/source/age), a "N saved · M pending review" subtitle, and pending nodes in the graph — reusing the existing `pkg/memvault` backend and `CollapsibleRail` detail pattern.

**Architecture:** Backend enriches `memvault.PendingNote` + the `MemoryPendingNote` wire type with `Title`/`Source`/`CapturedAt`, populated server-side in `ListPending`; `task generate` regenerates the TS bindings. The frontend adds a unified saved-or-pending selection model, a new `PendingBand` component (replacing the collapsed `ReviewTray`), a pending branch in the detail rail, a relative-age formatter, and pending nodes in `MemGraph`. Keep/Dismiss/Keep-all/Dismiss-all compose the existing `MemoryReviewAccept` / `MemoryDelete` RPCs — no new commands.

**Tech Stack:** Go (`pkg/memvault`, `pkg/wshrpc`), React 19 + jotai + Tailwind 4 (`frontend/app/view/agents`), `task generate` codegen, vitest, `go test`.

## Global Constraints

- **Go is the source of truth for wire types.** After editing `pkg/wshrpc/wshrpctypes.go`, run `task generate` to regenerate `frontend/app/store/wshclientapi.ts` + `frontend/types/gotypes.d.ts`. **Never hand-edit generated files.**
- **Typecheck command:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (plain `npx tsc` stack-overflows on this repo). Baseline is clean (exit 0) — any error it reports is yours.
- **Go tests:** `go test ./pkg/memvault/`. **Frontend tests:** `npx vitest run frontend/app/view/agents/<file>`.
- **NO per-task commits.** Per the repo's global git rule, each task ends with a **verify-only checkpoint** (test/typecheck), not a commit. All work batches into a **single commit at the very end, gated on explicit user approval**. Do not run `git commit` inside any task.
- **Timestamps:** RFC3339 UTC (`t.UTC().Format(time.RFC3339)`), matching `writeHarvestedNote` / the applied-learning work.
- **Reuse existing RPCs.** Keep = `MemoryReviewAcceptCommand({path})`; Dismiss = `MemoryDeleteCommand({path})`. No accept-with-scope, no `Pin`, no new commands.
- **Honest labels & no hidden knobs.** Keep the existing `typeMeta` labels (do not relabel to Decision/Fact/…); do not build `groupBy` or `compactPending` toggles (they are design-canvas knobs). Default: group saved by scope, show the pending preview.
- **Colors** come from existing tokens (`--color-mem-project|reference|feedback|user`, `--color-amber`, `--color-green`, `--color-red`). Do not introduce hardcoded hex.

Spec: `docs/superpowers/specs/2026-07-12-memory-redesign-design.md`.

---

## Checkpoint

Tasks 1–2 deliver the **backend enrichment** (pending notes carry title/source/age), independently shippable and testable. Tasks 3–6 deliver the **list + detail redesign** (the core of the design). Task 7 adds **pending graph nodes**. Task 8 is end-to-end visual verification.

---

### Task 1: Enrich `memvault.PendingNote` with Title / Source / CapturedAt

**Files:**
- Modify: `pkg/memvault/review.go` (the `PendingNote` struct, `ListPending`; add `pendingCapturedAt`, `pendingSource`)
- Test: `pkg/memvault/review_test.go`

**Interfaces:**
- Produces: `PendingNote` gains `Title string` (json `title`), `Source string` (json `source`), `CapturedAt string` (json `capturedat`). `ListPending` populates `Title = firstLine(body)`, `Source = pendingSource(cwd)` (`filepath.Base(cwd)`, else `"agent"`), `CapturedAt = pendingCapturedAt(filename)` (RFC3339 from the `20060102T150405.000` filename stamp, else `""`).

- [ ] **Step 1: Write the failing test**

Add to `pkg/memvault/review_test.go`:

```go
func TestListPendingEnrichedFields(t *testing.T) {
	dir := t.TempDir()
	if _, err := WritePending(dir, LearnCandidate{
		Type:  "feedback",
		Scope: "payments-api",
		Body:  "Never auto-commit without approval\nThe global CLAUDE.md forbids it.",
	}, "/home/dk/code/auth-refactor"); err != nil {
		t.Fatalf("WritePending: %v", err)
	}
	pns := ListPending(dir)
	if len(pns) != 1 {
		t.Fatalf("len = %d, want 1", len(pns))
	}
	p := pns[0]
	if p.Title != "Never auto-commit without approval" {
		t.Fatalf("Title = %q", p.Title)
	}
	if p.Source != "auth-refactor" {
		t.Fatalf("Source = %q, want auth-refactor", p.Source)
	}
	if p.CapturedAt == "" {
		t.Fatalf("CapturedAt is empty, want an RFC3339 stamp")
	}
	if _, err := time.Parse(time.RFC3339, p.CapturedAt); err != nil {
		t.Fatalf("CapturedAt %q not RFC3339: %v", p.CapturedAt, err)
	}
}

func TestPendingCapturedAt(t *testing.T) {
	got := pendingCapturedAt("20260712T101500.000-slug.md")
	if got != "2026-07-12T10:15:00Z" {
		t.Fatalf("pendingCapturedAt = %q, want 2026-07-12T10:15:00Z", got)
	}
	if s := pendingCapturedAt("no-stamp.md"); s != "" {
		t.Fatalf("stampless = %q, want empty", s)
	}
}

func TestPendingSourceFallback(t *testing.T) {
	if s := pendingSource(""); s != "agent" {
		t.Fatalf("pendingSource(\"\") = %q, want agent", s)
	}
	if s := pendingSource("/a/b/web-dashboard"); s != "web-dashboard" {
		t.Fatalf("pendingSource = %q, want web-dashboard", s)
	}
}
```

Ensure `review_test.go` imports `"time"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/memvault/ -run 'TestListPendingEnrichedFields|TestPendingCapturedAt|TestPendingSourceFallback'`
Expected: FAIL (compile error — `Title`/`Source`/`CapturedAt` fields and helpers don't exist).

- [ ] **Step 3: Add the struct fields**

In `pkg/memvault/review.go`, replace the `PendingNote` struct:

```go
// PendingNote is one queued candidate awaiting human review.
type PendingNote struct {
	Path       string `json:"path"`
	Title      string `json:"title"`
	Type       string `json:"type"`
	Scope      string `json:"scope"`
	Source     string `json:"source"`
	Body       string `json:"body"`
	Cwd        string `json:"cwd"`
	CapturedAt string `json:"capturedat"`
}
```

- [ ] **Step 4: Populate them in `ListPending` and add the helpers**

In `ListPending`, replace the append line with:

```go
		trimmed := strings.TrimSpace(body)
		cwd := pendingCwd(data)
		out = append(out, PendingNote{
			Path:       p,
			Title:      firstLine(trimmed),
			Type:       n.Type,
			Scope:      n.Scope,
			Source:     pendingSource(cwd),
			Body:       trimmed,
			Cwd:        cwd,
			CapturedAt: pendingCapturedAt(e.Name()),
		})
```

Add these helpers to `review.go` (after `pendingCwd`):

```go
// pendingSource labels where a candidate was learned: the project dir's basename, or "agent" when
// no cwd was recorded.
func pendingSource(cwd string) string {
	if cwd == "" {
		return "agent"
	}
	return filepath.Base(cwd)
}

// pendingCapturedAt parses the "20060102T150405.000" stamp WritePending prefixes onto the filename
// and returns it as RFC3339 UTC. Empty when the name has no parseable stamp.
func pendingCapturedAt(filename string) string {
	base := filepath.Base(filename)
	if len(base) < 19 {
		return ""
	}
	t, err := time.Parse("20060102T150405.000", base[:19])
	if err != nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
```

`filepath`, `time`, `strings` are already imported in `review.go`; `firstLine` lives in the same package (`learn.go`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/memvault/`
Expected: PASS (all package tests, including the three new ones).

- [ ] **Step 6: Verify-only checkpoint (no commit)**

Run: `go test ./pkg/memvault/` → PASS. Do not commit.

---

### Task 2: Thread the 3 fields through the wire type and regenerate bindings

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (the `MemoryPendingNote` struct)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (`MemoryReviewListCommand`, ~line 1727)
- Regenerated (do not hand-edit): `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces: `MemoryPendingNote` gains `Title`/`Source`/`CapturedAt` (json `title`/`source`/`capturedat`). The generated TS `MemoryPendingNote` type gains the same fields — consumed by Tasks 3–7.

- [ ] **Step 1: Extend the wire struct**

In `pkg/wshrpc/wshrpctypes.go`, replace `MemoryPendingNote`:

```go
type MemoryPendingNote struct {
	Path       string `json:"path"`
	Title      string `json:"title"`
	Type       string `json:"type"`
	Scope      string `json:"scope"`
	Source     string `json:"source"`
	Body       string `json:"body"`
	Cwd        string `json:"cwd"`
	CapturedAt string `json:"capturedat"`
}
```

- [ ] **Step 2: Copy the fields through in the server command**

In `pkg/wshrpc/wshserver/wshserver.go`, replace the `MemoryReviewListCommand` mapping line:

```go
		out[i] = wshrpc.MemoryPendingNote{
			Path:       p.Path,
			Title:      p.Title,
			Type:       p.Type,
			Scope:      p.Scope,
			Source:     p.Source,
			Body:       p.Body,
			Cwd:        p.Cwd,
			CapturedAt: p.CapturedAt,
		}
```

- [ ] **Step 3: Regenerate the bindings**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` `MemoryPendingNote` now lists `title`/`source`/`capturedat`; `wshclientapi.ts` unchanged in shape (same command). Do not edit either file by hand.

- [ ] **Step 4: Verify-only checkpoint (no commit)**

Run: `go build ./pkg/...` → exit 0.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0 (baseline clean; the new fields are additive). Do not commit.

---

### Task 3: Add the `relativeAge` formatter

**Files:**
- Modify: `frontend/app/view/agents/memtypes.ts` (append `relativeAge`)
- Test: `frontend/app/view/agents/memtypes.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `relativeAge(iso: string, now?: number): string` → `""` on empty/unparseable, `"just now"` < 45s, `"Nm ago"` / `"Nh ago"` / `"Nd ago"` otherwise. Consumed by `PendingBand` (Task 5) and the pending detail (Task 6).

- [ ] **Step 1: Write the failing test**

Create/append `frontend/app/view/agents/memtypes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { relativeAge } from "./memtypes";

describe("relativeAge", () => {
    const now = Date.parse("2026-07-12T12:00:00Z");
    it("returns empty for missing or unparseable input", () => {
        expect(relativeAge("", now)).toBe("");
        expect(relativeAge("not-a-date", now)).toBe("");
    });
    it("buckets recent times", () => {
        expect(relativeAge("2026-07-12T11:59:30Z", now)).toBe("just now");
        expect(relativeAge("2026-07-12T11:56:00Z", now)).toBe("4m ago");
        expect(relativeAge("2026-07-12T11:00:00Z", now)).toBe("1h ago");
        expect(relativeAge("2026-07-10T12:00:00Z", now)).toBe("2d ago");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/memtypes.test.ts`
Expected: FAIL ("relativeAge is not a function" / import error).

- [ ] **Step 3: Implement `relativeAge`**

Append to `frontend/app/view/agents/memtypes.ts`:

```ts
// Relative "age" for pending cards ("4m ago" / "1h ago" / "2d ago"). Empty on unparseable input.
// `now` is injectable for deterministic tests.
export function relativeAge(iso: string, now: number = Date.now()): string {
    if (!iso) return "";
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const s = Math.max(0, Math.floor((now - then) / 1000));
    if (s < 45) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/memtypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify-only checkpoint (no commit)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0. Do not commit.

---

### Task 4: Unified selection + keep/dismiss store helpers

**Files:**
- Modify: `frontend/app/view/agents/memstore.ts`
- Test: `frontend/app/view/agents/memstore.test.ts` (create if absent; else append)

**Interfaces:**
- Produces:
  - `memSelectedPendingPathAtom: PrimitiveAtom<string | null>` — non-null when a pending note is the current detail selection (takes precedence over `memSelectedIdAtom`).
  - `advanceSelection(pendingPaths: string[], removedPath: string, firstSavedId: string | null): { pendingPath: string | null; savedId: string | null }` — pure; next pending by shifted index, else previous, else fall back to first saved.
  - `keepPending(path: string): Promise<void>`, `dismissPending(path: string): Promise<void>` — accept/reject one, then advance selection.
  - `keepAllPending(): Promise<void>`, `dismissAllPending(): Promise<void>` — loop the current pending set, then clear pending selection.
- Consumes: existing `RpcApi.MemoryReviewAcceptCommand`, `RpcApi.MemoryDeleteCommand`, `loadReview`, `loadMemory`, `memPendingAtom`, `memNotesAtom`, `memSelectedIdAtom`, `memBodyAtom`, `memReflowAnimatedAtom`, `selectNote`.

- [ ] **Step 1: Write the failing test (pure reducer)**

Create/append `frontend/app/view/agents/memstore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { advanceSelection } from "./memstore";

describe("advanceSelection", () => {
    const paths = ["a", "b", "c"];
    it("picks the note that shifts into the removed index", () => {
        expect(advanceSelection(paths, "b", "s1")).toEqual({ pendingPath: "c", savedId: null });
    });
    it("falls back to the previous when the last is removed", () => {
        expect(advanceSelection(paths, "c", "s1")).toEqual({ pendingPath: "b", savedId: null });
    });
    it("falls back to the first saved when the queue empties", () => {
        expect(advanceSelection(["a"], "a", "s1")).toEqual({ pendingPath: null, savedId: "s1" });
    });
    it("returns null saved when nothing remains", () => {
        expect(advanceSelection(["a"], "a", null)).toEqual({ pendingPath: null, savedId: null });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Expected: FAIL ("advanceSelection is not a function").

- [ ] **Step 3: Add the pending-selection atom and pure reducer**

In `memstore.ts`, add near `memSelectedIdAtom`:

```ts
// Non-null when a pending candidate is the current detail selection. Pending takes precedence over
// memSelectedIdAtom; selecting a saved note (selectNote) clears this, and vice versa.
export const memSelectedPendingPathAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
```

Add the pure reducer (module scope):

```ts
// Next selection after `removedPath` leaves the pending queue: the note that shifts into its index,
// else the previous, else the first saved note. Pure so it unit-tests without RPC.
export function advanceSelection(
    pendingPaths: string[],
    removedPath: string,
    firstSavedId: string | null
): { pendingPath: string | null; savedId: string | null } {
    const idx = pendingPaths.indexOf(removedPath);
    const remaining = pendingPaths.filter((p) => p !== removedPath);
    const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[0];
    if (next) return { pendingPath: next, savedId: null };
    return { pendingPath: null, savedId: firstSavedId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts`
Expected: PASS.

- [ ] **Step 5: Clear pending selection when a saved note is selected**

In `selectNote`, add as the first line of the body (after the existing `memSelectedIdAtom` set is fine, but clear pending explicitly):

```ts
    globalStore.set(memSelectedPendingPathAtom, null); // selecting a saved note leaves pending mode
```

- [ ] **Step 6: Add keep/dismiss(+all) helpers**

Append to `memstore.ts`:

```ts
function applyPendingSelection(pendingPath: string | null, savedId: string | null): void {
    globalStore.set(memSelectedPendingPathAtom, pendingPath);
    if (pendingPath) {
        globalStore.set(memSelectedIdAtom, null);
        globalStore.set(memBodyAtom, null);
    } else if (savedId) {
        void selectNote(savedId);
    }
}

// Compute the next selection from the CURRENT atoms before the async mutation lands.
function nextAfterPending(path: string): { pendingPath: string | null; savedId: string | null } {
    const paths = globalStore.get(memPendingAtom).map((p) => p.path);
    const firstSaved = globalStore.get(memNotesAtom)[0]?.id ?? null;
    return advanceSelection(paths, path, firstSaved);
}

export async function keepPending(path: string): Promise<void> {
    const next = nextAfterPending(path);
    await RpcApi.MemoryReviewAcceptCommand(TabRpcClient, { path });
    globalStore.set(memReflowAnimatedAtom, true);
    await Promise.all([loadReview(), loadMemory()]);
    applyPendingSelection(next.pendingPath, next.savedId);
}

export async function dismissPending(path: string): Promise<void> {
    const next = nextAfterPending(path);
    await RpcApi.MemoryDeleteCommand(TabRpcClient, { path });
    globalStore.set(memReflowAnimatedAtom, true);
    await Promise.all([loadReview(), loadMemory()]);
    applyPendingSelection(next.pendingPath, next.savedId);
}

export async function keepAllPending(): Promise<void> {
    const pend = globalStore.get(memPendingAtom);
    for (const p of pend) {
        await RpcApi.MemoryReviewAcceptCommand(TabRpcClient, { path: p.path });
    }
    globalStore.set(memReflowAnimatedAtom, true);
    globalStore.set(memSelectedPendingPathAtom, null);
    await Promise.all([loadReview(), loadMemory()]);
}

export async function dismissAllPending(): Promise<void> {
    const pend = globalStore.get(memPendingAtom);
    for (const p of pend) {
        await RpcApi.MemoryDeleteCommand(TabRpcClient, { path: p.path });
    }
    globalStore.set(memReflowAnimatedAtom, true);
    globalStore.set(memSelectedPendingPathAtom, null);
    await Promise.all([loadReview(), loadMemory()]);
}
```

Retype `memPendingAtom` to the generated wire type (drop any `MemoryPendingNote`-agnostic usage — it already is `MemoryPendingNote[]`; the enriched fields are additive so no change is required beyond regeneration in Task 2).

- [ ] **Step 7: Verify-only checkpoint (no commit)**

Run: `npx vitest run frontend/app/view/agents/memstore.test.ts` → PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0. Do not commit.

---

### Task 5: `PendingBand` component; retire `ReviewTray`

**Files:**
- Create: `frontend/app/view/agents/pendingband.tsx`
- Modify: `frontend/app/view/agents/memorysurface.tsx` (import/render the band; remove `ReviewTray`)
- Delete: `frontend/app/view/agents/reviewtray.tsx`

**Interfaces:**
- Consumes: `memPendingAtom`, `memSelectedPendingPathAtom`, `keepPending`, `dismissPending`, `keepAllPending`, `dismissAllPending` (Task 4); `relativeAge` (Task 3); `typeMeta` (`memtypes.ts`).
- Produces: `export function PendingBand(): JSX.Element | null` — renders nothing when the queue is empty.

- [ ] **Step 1: Write the component**

Create `frontend/app/view/agents/pendingband.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pending-review band (Wave-memory.dc.html): agent-harvested candidates shown inline at the top of
// the Memory list. Amber-accented cards with per-card Keep/Dismiss + Keep-all/Dismiss-all; selecting
// a card opens it in the detail rail's pending mode. Replaces the old collapsed ReviewTray.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Check, X } from "lucide-react";
import { keepAllPending, dismissAllPending, keepPending, dismissPending, memPendingAtom, memSelectedPendingPathAtom, selectPending } from "./memstore";
import { relativeAge, typeMeta } from "./memtypes";

export function PendingBand() {
    const pending = useAtomValue(memPendingAtom);
    const selectedPath = useAtomValue(memSelectedPendingPathAtom);
    if (pending.length === 0) return null;
    return (
        <section className="mb-[28px] mt-[8px]">
            <div className="mb-[13px] flex items-center gap-[10px] px-px">
                <div className="h-[8px] w-[8px] animate-[pulseDot_2s_infinite] rounded-full bg-asking" />
                <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-asking">
                    Pending review
                </h2>
                <span className="rounded-[20px] bg-asking/12 px-[8px] py-[2px] font-mono text-[11px] font-semibold text-asking">
                    {pending.length}
                </span>
                <span className="text-[11.5px] text-ink-faint">harvested from your agents — keep what's worth remembering</span>
                <div className="flex-1" />
                <button
                    onClick={() => fireAndForget(keepAllPending)}
                    className="rounded-[7px] border border-success/28 bg-success/10 px-[11px] py-[5px] font-mono text-[11.5px] font-semibold text-success hover:bg-success/18"
                >
                    Keep all
                </button>
                <button
                    onClick={() => fireAndForget(dismissAllPending)}
                    className="rounded-[7px] border border-edge-mid px-[11px] py-[5px] text-[11.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-ink-hi"
                >
                    Dismiss all
                </button>
            </div>
            <div className="flex flex-col gap-[9px]">
                {pending.map((p) => {
                    const m = typeMeta(p.type);
                    const on = p.path === selectedPath;
                    const age = relativeAge(p.capturedat);
                    return (
                        <div
                            key={p.path}
                            onClick={() => selectPending(p.path)}
                            className={cn(
                                "flex cursor-pointer gap-[12px] rounded-[11px] border border-l-[3px] bg-background px-[13px] py-[12px] hover:border-edge-strong",
                                "border-l-asking",
                                on ? "border-edge-strong" : "border-edge-faint"
                            )}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="mb-[5px] flex items-center gap-[8px]">
                                    <span className={cn("flex-none rounded-[5px] px-[7px] py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[0.05em]", m.pillClass)} style={{ background: "rgba(255,255,255,0.05)" }}>
                                        {m.label}
                                    </span>
                                    <span className="truncate font-mono text-[11px] font-medium text-ink-faint">
                                        {p.source} → {p.scope || "shared"}
                                    </span>
                                    <div className="flex-1" />
                                    {age && <span className="flex-none font-mono text-[10.5px] text-ink-fainter">{age}</span>}
                                </div>
                                <div className="mb-[3px] text-[14px] font-semibold tracking-[-0.005em] text-ink-hi">{p.title}</div>
                                <div className="line-clamp-2 text-[12.5px] leading-[1.5] text-ink-mid">{p.body}</div>
                            </div>
                            <div className="flex flex-none flex-col gap-[6px] self-center">
                                <button
                                    title="Keep"
                                    onClick={(e) => { e.stopPropagation(); fireAndForget(() => keepPending(p.path)); }}
                                    className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-success/30 bg-success/10 text-success hover:bg-success/20"
                                >
                                    <Check size={14} strokeWidth={3} />
                                </button>
                                <button
                                    title="Dismiss"
                                    onClick={(e) => { e.stopPropagation(); fireAndForget(() => dismissPending(p.path)); }}
                                    className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-edge-mid text-ink-mid hover:border-error/40 hover:bg-error/8 hover:text-error"
                                >
                                    <X size={13} strokeWidth={2.6} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
```

- [ ] **Step 2: Add the `selectPending` helper the band uses**

In `memstore.ts`, append:

```ts
export function selectPending(path: string): void {
    globalStore.set(memSelectedPendingPathAtom, path);
    globalStore.set(memSelectedIdAtom, null);
    globalStore.set(memBodyAtom, null);
    globalStore.set(memRailOpenAtom, true); // open the detail rail on selection
}
```

- [ ] **Step 3: Confirm the token classes (already verified)**

The tokens this component uses are confirmed present in `frontend/tailwindsetup.css`: `--color-asking` (#e6b450, amber), `--color-success` (#54c79a, green), `--color-error` (#e0726c, red), and `@keyframes pulseDot`. Class names: `text-asking`/`bg-asking`, `text-success`/`bg-success`/`border-success`, `text-error`/`bg-error`/`border-error`, `animate-[pulseDot_2s_infinite]`. `line-clamp-2` is a built-in Tailwind 4 utility. Do not introduce new hex.

- [ ] **Step 4: Swap the band into the surface, delete `ReviewTray`**

In `memorysurface.tsx`: remove the `ReviewTray` import and its `<ReviewTray />` render; import `PendingBand`. (The band renders inside the list column in Task 6, so for this task place `<PendingBand />` is NOT yet in the list — leave the render wiring to Task 6. Here, only remove `ReviewTray` usage and delete the file.)

Delete `frontend/app/view/agents/reviewtray.tsx`.

- [ ] **Step 5: Verify-only checkpoint (no commit)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0 (no dangling `ReviewTray` import; `PendingBand` imported but its render lands in Task 6 — if tsc flags unused import, complete Task 6 in the same working session before checkpointing). Do not commit.

---

### Task 6: Subtitle, band placement, and detail-rail pending mode

**Files:**
- Modify: `frontend/app/view/agents/memorysurface.tsx`

**Interfaces:**
- Consumes: `memPendingAtom`, `memSelectedPendingPathAtom`, `keepPending`, `dismissPending` (Task 4); `PendingBand` (Task 5); `MarkdownMessage`, `typeMeta`, `relativeAge`.

- [ ] **Step 1: Subtitle → "N saved · M pending review"**

In `memorysurface.tsx` `Header`, take a `pending` count and render:

```tsx
function Header({ count, pending, onNew }: { count: number; pending: number; onNew: () => void }) {
    // ...existing view/search atoms...
    return (
        <div className="flex flex-none items-center gap-[14px] px-[28px] pb-[16px] pt-[24px]">
            <div>
                <h1 className="mb-[4px] text-[25px] font-bold tracking-[-0.02em]">Memory</h1>
                <p className="text-[13.5px] text-ink-mid">
                    What your agents remember · <span className="font-semibold text-ink-hi">{count} saved</span>
                    {pending > 0 && (
                        <> · <span className="font-semibold text-asking">{pending} pending review</span></>
                    )}
                </p>
            </div>
            {/* ...unchanged search / toggle / New... */}
        </div>
    );
}
```

Update the caller: `<Header count={notes.length} pending={pending.length} onNew={() => setNewOpen(true)} />`, reading `const pending = useAtomValue(memPendingAtom);` in `MemorySurface`.

- [ ] **Step 2: Render `<PendingBand>` atop the list column**

In `ListView` (or where the list column renders inside `MemorySurface`), place `<PendingBand />` as the first child of the `max-w-[760px]` column, above the saved groups:

```tsx
<motion.div /* ...list column... */ className="mx-auto max-w-[780px] px-[28px] pb-[60px] pt-[10px]">
    <PendingBand />
    {/* existing groups AnimatePresence... */}
</motion.div>
```

Import `PendingBand` at the top. Keep `<CleanupQueue />` and `<SyncStrip />` where they are.

- [ ] **Step 3: Detail rail — branch on pending vs saved**

In `DetailRail`, read the pending selection and render a pending detail when set:

```tsx
function DetailRail({ notes }: { notes: MemNote[] }) {
    const selectedId = useAtomValue(memSelectedIdAtom);
    const selectedPending = useAtomValue(memSelectedPendingPathAtom);
    const pending = useAtomValue(memPendingAtom);
    const body = useAtomValue(memBodyAtom);
    const edges = useAtomValue(memEdgesAtom);

    const pendingNote = selectedPending ? pending.find((p) => p.path === selectedPending) : undefined;
    const pendingIndex = pendingNote ? pending.findIndex((p) => p.path === pendingNote.path) + 1 : 0;
    // ...existing saved sel/related computation...

    const sections: RailSection[] = [
        {
            id: "detail",
            icon: RAIL_ICON.info,
            label: "Memory detail",
            content: (
                <AnimatePresence mode="wait">
                    <motion.div key={pendingNote ? pendingNote.path : sel ? sel.id : "empty"} /* ...same transition... */>
                        {pendingNote ? (
                            <PendingDetail note={pendingNote} index={pendingIndex} total={pending.length} />
                        ) : !sel ? (
                            <div className="text-[13px] text-ink-mid">Select a memory to see its content.</div>
                        ) : (
                            <DetailBody sel={sel} body={body} related={related} />
                        )}
                    </motion.div>
                </AnimatePresence>
            ),
        },
    ];
    return <CollapsibleRail openAtom={memRailOpenAtom} ariaLabel="Memory detail" sections={sections} />;
}
```

- [ ] **Step 4: Add the `PendingDetail` sub-component**

Add to `memorysurface.tsx`:

```tsx
function PendingDetail({ note, index, total }: { note: MemoryPendingNote; index: number; total: number }) {
    const m = typeMeta(note.type);
    const age = relativeAge(note.capturedat);
    return (
        <>
            <div className="mb-[15px] flex items-center gap-[8px]">
                <span className="inline-flex items-center gap-[5px] rounded-[20px] bg-asking px-[9px] py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[0.06em] text-background">
                    <span className="text-[8px]">◆</span>Pending review
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-ink-faint">{index} of {total}</span>
            </div>
            <div className="mb-[13px] flex items-center gap-[9px]">
                <span className={cn("rounded-[5px] px-[9px] py-[3px] font-mono text-[9.5px] font-semibold uppercase", m.pillClass)} style={{ background: "rgba(255,255,255,0.05)" }}>
                    {m.label}
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-ink-faint">{note.scope || "shared"}</span>
            </div>
            <h2 className="mb-[15px] text-[18px] font-bold leading-[1.3] text-foreground">{note.title}</h2>
            <div className="mb-[8px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mid">Content</div>
            <div className="mb-[14px] rounded-[10px] border border-edge-faint bg-background px-[15px] py-[13px] text-[13.5px] leading-[1.62] text-ink-hi">
                <MarkdownMessage text={note.body} />
            </div>
            <div className="mb-[22px] flex gap-[8px]">
                <button
                    onClick={() => fireAndForget(() => keepPending(note.path))}
                    className="flex flex-1 items-center justify-center gap-[7px] rounded-[9px] bg-success py-[11px] text-[13px] font-bold text-background hover:bg-success/90"
                >
                    <Check size={15} strokeWidth={3} />Keep
                </button>
                <button
                    onClick={() => fireAndForget(() => dismissPending(note.path))}
                    className="flex flex-none items-center justify-center rounded-[9px] border border-error/32 px-[15px] py-[11px] text-[13px] font-semibold text-error hover:bg-error/10"
                >
                    Dismiss
                </button>
            </div>
            <div className="mb-[6px] flex flex-col">
                <MetaRow label="Scope" value={note.scope || "shared"} border />
                <MetaRow label="Learned by" value={note.source} border />
                <MetaRow label="Captured" value={age || "—"} />
            </div>
        </>
    );
}
```

Add the imports this task needs to `memorysurface.tsx`: `Check` from `lucide-react`; `relativeAge` from `./memtypes`; `keepPending`, `dismissPending`, `memPendingAtom`, `memSelectedPendingPathAtom` from `./memstore`; `PendingBand` from `./pendingband`. `MetaRow`, `typeMeta`, `MarkdownMessage`, `cn`, `fireAndForget`, `MemoryPendingNote` (ambient) are already available.

Use whichever green/red token names Task 5 Step 3 confirmed (`green`/`green-bright` or `accept`; `error`/`red`).

- [ ] **Step 5: Verify-only checkpoint (no commit)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Run: `npx vitest run frontend/app/view/agents/` → PASS (existing suites unaffected). Do not commit.

---

### Task 7: Pending nodes in the graph

**Files:**
- Modify: `frontend/app/view/agents/memgraph.tsx`
- Modify: `frontend/app/view/agents/memorysurface.tsx` (pass `pending` to `<MemGraph>`)

**Interfaces:**
- Consumes: `memPendingAtom`.
- Produces: `MemGraph` accepts an optional `pending?: MemoryPendingNote[]` prop; pending entries render as nodes with an amber ring; the legend gains a "Pending" entry.

- [ ] **Step 1: Extend `MemGraph` props and node set**

In `memgraph.tsx`, add `pending` to the props and fold pending candidates into the node list as `{ id: "pending:"+path, title, type, deg: 0, pending: true }`. Extend `GNode` with `pending?: boolean`. Restrict the position/degree logic to treat pending nodes as isolated (deg 0). Build them alongside the existing `nodes` in the `data` useMemo, seeded from the position cache by their synthetic id.

```tsx
type GNode = { id: string; title: string; type: string; deg: number; pending?: boolean; x?: number; y?: number };
// ...in the data useMemo, after building saved `nodes`:
const pendingNodes: GNode[] = (pending ?? []).map((p) => {
    const id = "pending:" + p.path;
    const seed = seedPosition(id, edges, posCache);
    return { id, title: p.title, type: p.type, deg: 0, pending: true, ...(seed ?? {}) };
});
return { nodes: [...nodes, ...pendingNodes], links, rank: degreeRank([...nodes, ...pendingNodes]) };
```

Include `pending` in the `sig` signature so the sim rebuilds when the queue changes:
`const sig = graphSignature([...notes.map((n) => n.id), ...(pending ?? []).map((p) => "pending:" + p.path)], allEdges);`

- [ ] **Step 2: Paint pending nodes with an amber ring**

In `paintNode`, after the fill, stroke pending nodes with the amber token:

```tsx
if (node.pending) {
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = colors.pending;
    ctx.stroke();
}
```

Add `pending: c("--color-mem-feedback")` to `useThemeColors` (amber = convention token, matching the mock's pending ring). Selecting a pending graph node calls `selectPending(node.id.slice("pending:".length))` — branch `onNodeClick`:

```tsx
onNodeClick={((node: GNode) => {
    if (node.pending) selectPending(node.id.slice(8));
    else fireAndForget(() => selectNote(node.id));
}) as any}
```

Import `selectPending` from `./memstore`.

- [ ] **Step 3: Add the legend entry**

In the legend map, append a "Pending" item rendered as a ringed (not filled) amber dot:

```tsx
<div className="flex items-center gap-[6px]">
    <div className="h-[8px] w-[8px] rounded-full border-[1.5px]" style={{ borderColor: colors.pending }} />
    <span className="font-mono text-[10.5px] text-ink-mid">Pending</span>
</div>
```

- [ ] **Step 4: Pass pending from the surface**

In `memorysurface.tsx`, change the graph render to `<MemGraph notes={notes} pending={pending} filteredIds={graphFilterIds} selectedId={selectedId} />`.

- [ ] **Step 5: Verify-only checkpoint (no commit)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Run: `npx vitest run frontend/app/view/agents/` → PASS. Do not commit.

---

### Task 8: End-to-end visual verification

**Files:** none (verification only).

- [ ] **Step 1: Full checks**

Run: `go test ./pkg/memvault/ ./pkg/wshrpc/...` → PASS.
Run: `npx vitest run frontend/app/view/agents/` → PASS.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.

- [ ] **Step 2: Launch the dev app and inject pending data**

Start `task dev` (see memory: use `tail -f /dev/null | task dev` so backgrounding doesn't EOF wavesrv stdin; if a relaunch fails, free Vite's port 5174 first). Inject a populated cockpit with pending candidates: `node scripts/inject-live-agents.mjs <scenario>` and ensure the pending store (`~/.waveterm/memory-pending/`) has a few candidates (create via the distiller hook or by writing sample pending files with a stamped filename).

- [ ] **Step 3: Screenshot and compare to the mock**

Run: `node scripts/cdp-shot.mjs mem-list.png` on the Memory tab (List view) and `node scripts/cdp-shot.mjs mem-graph.png` (Graph view). Confirm against `Wave-memory.dc.html`:
- Subtitle reads "N saved · M pending review" (amber pending clause).
- Pending band: amber left-bordered cards, source→scope, age, title, 2-line preview, per-card Keep/Dismiss, Keep-all/Dismiss-all.
- Selecting a pending card → detail rail shows the "Pending review" banner, "X of N", Keep (green) / Dismiss (red), read-only Scope/Learned-by/Captured.
- Selecting a saved note → Edit/Delete detail unchanged.
- Graph view shows pending nodes with amber rings and a "Pending" legend entry.
- `CleanupQueue` still appears when prune candidates exist.

- [ ] **Step 4: Report and request commit approval**

Summarize verification results (with screenshots). Present the full diff for review. **Await explicit approval, then create a single commit** (`feat(memory): redesign pending review — inline band + detail-rail flow (Wave-memory.dc.html)`). Do not commit before approval.

---

## Self-Review

- **Spec coverage:** subtitle (T6), pending band + Keep/Dismiss/all (T5–6), detail pending mode + read-only scope (T6), backend title/source/age (T1–2), graph pending nodes + legend (T7), keep CleanupQueue (T6 leaves it in place), honest labels / no knobs / no Pin / no scope-reassign (Global Constraints + omitted by construction). All spec sections map to a task.
- **Type consistency:** `PendingNote`/`MemoryPendingNote` fields (`Title`/`Source`/`CapturedAt`, json `title`/`source`/`capturedat`) are identical across T1/T2 and consumed as `note.title`/`note.source`/`note.capturedat` in T5–7. `advanceSelection` / `keepPending` / `dismissPending` / `keepAllPending` / `dismissAllPending` / `selectPending` signatures match between T4/T5/T6/T7. `relativeAge(iso, now?)` matches T3 test.
- **Placeholder scan:** every code step carries real code; token-name confirmation (green/amber/red, pulseDot) is an explicit grep step (T5.3), not a placeholder.
```
