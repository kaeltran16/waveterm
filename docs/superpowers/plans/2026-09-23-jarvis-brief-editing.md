# Jarvis Brief Editing Layer Implementation Plan

**Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run && go test ./pkg/... ./cmd/...`
**Setup:** `task worktree:prepare`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/jarvis/... ./pkg/wshrpc/... ./pkg/waveobj/...`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an initiative's plan editable in place on the Jarvis Brief (variant A of the imported design): chunk status/rename/move/delete, stage rename/delete/add, initiative rename/details/pause/archive/delete, note edit/delete, a restyled Chunk sidebar, and an Undo toast.

**Architecture:** Two new effort ops (`editNote`, `removeNote`) are the only backend change. The frontend adds three pure modules — `trackeredit.ts` (index math), `briefundo.ts` (deferred-commit queue), `effortstore.ts` helpers (op batches) — consumed by thin views: `inlinetrackerview.tsx` (tracker editing), `chunksidebar.tsx` (sidebar), `effortcreateform.tsx` (stage syntax + edit mode). `briefsurface.tsx` wires them.

**Tech Stack:** Go (`pkg/jarvis`, `pkg/wshrpc`, `pkg/waveobj`), `task generate`, React 19 + jotai + Tailwind 4, vitest, CDP scenarios (`scripts/cdp/scenarios.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-23-jarvis-brief-editing-design.md` — read it first. Visual source of truth: `docs/prototype/jarvis-brief-editing.dc.html`, variant `a` (open it at `http://localhost:8766/` or any static server beside `docs/prototype/support.js`).

## Global Constraints

- Colours only from `@theme` tokens in `frontend/tailwindsetup.css` (`text-accent`, `text-success`, `text-warning-soft`, `text-error`, `border-border`, `bg-surface-raised`, `bg-surface-hover`, …) — never raw hex/rgba. Match the prototype's spacing and type sizes, mapped to tokens.
- Never hand-edit generated files (`frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, …); change Go and run `task generate`.
- Undo window: `UNDO_WINDOW_MS = 5000`.
- Last-chunk copy, verbatim: `An initiative keeps at least one chunk.`
- Delete-initiative confirm copy, verbatim: `Delete this initiative, its N chunks and their notes?` (N = chunk count).
- Details-mode hint, verbatim: `Chunks are edited in the plan: double-click to rename, the status pill to change status.`
- Every write goes through the Brief's `runMutation` (or the undo queue's commit), so a failed RPC is shown, never swallowed.
- Comments explain *why*, lower case, only where needed. No new SCSS. Prettier: check only files you touched (`npx prettier --check <paths>`); never on `scripts/*.mjs`.
- Commit messages `type(scope): description`, no attribution trailers.

## Review Focus

1. **Deleting every chunk.** The server's `EC-LAST-CHUNK` check only looks at the effort *before* the batch, so a stage delete covering all chunks (or a chunk delete while the others are pending deletion) would empty the initiative. Expected: refused client-side with the last-chunk copy. Pinned by `canRemove` tests in Task 2.
2. **A chunk label that is all digits (`"2"`).** `ResolveChunkIndex` reads it as an index and would edit the wrong chunk. Expected: the right chunk changes. Pinned by `chunkRef` tests in Task 2.
3. **Leaving the Brief inside the undo window.** Expected: the delete still happens. Pinned by the `flushAll` test in Task 3.
4. **Two deletes inside one window.** Expected: both commit; the toast shows the second; the first still commits on its own timer. Pinned in Task 3.
5. **A note that changed under the reader** (agent appended/removed between read and edit). Expected: `EC-STALE-NOTE`, nothing applied, error shown. Pinned in Task 1.

---

### Task 1: editNote / removeNote effort ops
**Depends on:** none

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_effort.go` (`EffortOp`)
- Modify: `pkg/waveobj/wtype.go` (`EffortNote`)
- Modify: `pkg/jarvis/effortops.go`
- Test: `pkg/jarvis/effortops_test.go` (APPEND — do not overwrite; use Edit, not Write)
- Regenerated: `task generate` outputs

**Interfaces:**
- Produces (TS, after generate): `EffortOp.notets?: number`, `EffortNote.edited?: boolean`; ops `"editNote"` `{op, chunk, at, notets, note}` and `"removeNote"` `{op, chunk, at, notets}`. Error codes `EC-STALE-NOTE`, `EC-INVALID-INDEX`, `EC-EMPTY-NOTE`.

- [ ] **Step 1: Write the failing tests** — append to `pkg/jarvis/effortops_test.go`:

```go
func mkNotedEffort() *waveobj.Effort {
	e := mkEffort()
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: "Phase 2", Note: "first"}}, "", effortNow+1); err != nil {
		panic(err)
	}
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "appendNote", Chunk: "Phase 2", Note: "second"}}, "", effortNow+2); err != nil {
		panic(err)
	}
	return e
}

func TestApplyOpsEditNoteRewritesNoteAndEvent(t *testing.T) {
	e := mkNotedEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "editNote", Chunk: "Phase 2", At: intPtr(1), NoteTs: effortNow + 1, Note: "first, fixed"}}, "", effortNow+3)
	if err != nil {
		t.Fatal(err)
	}
	n := e.Chunks[1].Notes[0]
	if n.Text != "first, fixed" || !n.Edited || n.Ts != effortNow+1 {
		t.Fatalf("note: %+v", n)
	}
	found := false
	for _, ev := range e.Events {
		if ev.Kind == "effort-note" && ev.Ts == effortNow+1 {
			found = ev.Text == "first, fixed"
		}
	}
	if !found {
		t.Fatalf("event not rewritten: %+v", e.Events)
	}
}

func TestApplyOpsRemoveNoteDropsNoteAndEvent(t *testing.T) {
	e := mkNotedEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "removeNote", Chunk: "Phase 2", At: intPtr(1), NoteTs: effortNow + 1}}, "", effortNow+3)
	if err != nil {
		t.Fatal(err)
	}
	if len(e.Chunks[1].Notes) != 1 || e.Chunks[1].Notes[0].Text != "second" {
		t.Fatalf("notes: %+v", e.Chunks[1].Notes)
	}
	for _, ev := range e.Events {
		if ev.Kind == "effort-note" && ev.Text == "first" {
			t.Fatalf("event kept: %+v", e.Events)
		}
	}
}

func TestApplyOpsNoteOpStaleTs(t *testing.T) {
	e := mkNotedEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "removeNote", Chunk: "Phase 2", At: intPtr(1), NoteTs: effortNow + 2}}, "", effortNow+3)
	expectErrCode(t, err, "EC-STALE-NOTE")
	if len(e.Chunks[1].Notes) != 2 {
		t.Fatalf("applied despite stale ts: %+v", e.Chunks[1].Notes)
	}
}

func TestApplyOpsNoteOpOutOfRange(t *testing.T) {
	e := mkNotedEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "editNote", Chunk: "Phase 2", At: intPtr(9), NoteTs: effortNow + 1, Note: "x"}}, "", effortNow+3)
	expectErrCode(t, err, "EC-INVALID-INDEX")
}

func TestApplyOpsEditNoteEmptyText(t *testing.T) {
	e := mkNotedEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "editNote", Chunk: "Phase 2", At: intPtr(1), NoteTs: effortNow + 1, Note: "   "}}, "", effortNow+3)
	expectErrCode(t, err, "EC-EMPTY-NOTE")
}

func TestApplyOpsEditStampNoteLeavesEvents(t *testing.T) {
	e := mkEffort()
	if err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "setChunkStage", Chunk: "Phase 3", Stage: "Later"}}, "", effortNow+1); err != nil {
		t.Fatal(err)
	}
	events := len(e.Events)
	err := ApplyEffortOps(e, []wshrpc.EffortOp{{Op: "editNote", Chunk: "Phase 3", At: intPtr(1), NoteTs: effortNow + 1, Note: "stage fixed"}}, "", effortNow+2)
	if err != nil {
		t.Fatal(err)
	}
	if e.Chunks[2].Notes[0].Text != "stage fixed" || len(e.Events) != events {
		t.Fatalf("notes %+v events %+v", e.Chunks[2].Notes, e.Events)
	}
}

func TestApplyOpsNoteBatchAtomic(t *testing.T) {
	e := mkNotedEffort()
	err := ApplyEffortOps(e, []wshrpc.EffortOp{
		{Op: "editNote", Chunk: "Phase 2", At: intPtr(1), NoteTs: effortNow + 1, Note: "ok"},
		{Op: "removeNote", Chunk: "Phase 2", At: intPtr(2), NoteTs: 42},
	}, "", effortNow+3)
	expectErrCode(t, err, "EC-STALE-NOTE")
	if e.Chunks[1].Notes[0].Text != "first" {
		t.Fatalf("first op applied: %+v", e.Chunks[1].Notes)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./pkg/jarvis/ -run 'NoteOp|EditNote|RemoveNote|EditStamp|NoteBatch'`
Expected: compile FAIL (`NoteTs` / `Edited` unknown).

- [ ] **Step 3: Implement**

`pkg/wshrpc/wshrpctypes_effort.go`, in `EffortOp`: extend the `Op` comment with `| editNote | removeNote`, change the `At` comment to `// addChunk insert position / moveChunk target / editNote,removeNote note index (1-based)`, change the `Note` comment to add `; editNote new text`, and add after `Note`:

```go
	NoteTs    int64  `json:"notets,omitempty"`    // editNote/removeNote: the note's ts, a stale guard beside At
```

`pkg/waveobj/wtype.go`, `EffortNote`:

```go
type EffortNote struct {
	Ts     int64  `json:"ts"`
	Text   string `json:"text"`
	Edited bool   `json:"edited,omitempty"`
}
```

`pkg/jarvis/effortops.go` — add helpers after `effortEvent`:

```go
// resolveNote finds the note an editNote/removeNote names. At is its 1-based place in the chunk's trail
// and NoteTs the stamp the caller last saw there; both must agree, because one batch can stamp several
// notes with the same ts and an index alone goes stale the moment the trail changes.
func resolveNote(c waveobj.EffortChunk, op wshrpc.EffortOp) (int, error) {
	at := derefAt(op.At)
	if at < 1 || at > len(c.Notes) {
		return -1, fmt.Errorf("EC-INVALID-INDEX: note %d out of range (1..%d)", at, len(c.Notes))
	}
	if c.Notes[at-1].Ts != op.NoteTs {
		return -1, fmt.Errorf("EC-STALE-NOTE: note %d on %q changed since it was read", at, c.Label)
	}
	return at - 1, nil
}

// noteEvent is the effort-note event a chunk note was written with (appendNote writes both with one
// stamp and one text), so the feed, which reads events, stays in step with the chunk's trail.
func noteEvent(e *waveobj.Effort, label string, n waveobj.EffortNote) int {
	for i, ev := range e.Events {
		if ev.Kind == "effort-note" && ev.Ts == n.Ts && ev.Label == label && ev.Text == n.Text {
			return i
		}
	}
	return -1
}
```

Validation pass — add a case before `case "setProject", ...`:

```go
		case "editNote", "removeNote":
			idx, err := ResolveChunkIndex(e, op.Chunk)
			if err != nil {
				return err
			}
			if _, err := resolveNote(e.Chunks[idx], op); err != nil {
				return err
			}
			if op.Op == "editNote" && strings.TrimSpace(op.Note) == "" {
				return fmt.Errorf("EC-EMPTY-NOTE: note text is empty")
			}
```

Apply pass — add cases beside `case "appendNote":`. Re-resolve (an earlier op in the same batch may have shifted the trail) and return the error, which rolls the transaction back:

```go
		case "editNote":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			ni, err := resolveNote(e.Chunks[idx], op)
			if err != nil {
				return err
			}
			// no trail stamp: this edits the trail itself, and a note about a note says nothing
			n := &e.Chunks[idx].Notes[ni]
			text := strings.TrimSpace(op.Note)
			if ev := noteEvent(e, e.Chunks[idx].Label, *n); ev >= 0 {
				e.Events[ev].Text = text
			}
			n.Text = text
			n.Edited = true
			e.Chunks[idx].UpdatedTs = now
		case "removeNote":
			idx, _ := ResolveChunkIndex(e, op.Chunk)
			ni, err := resolveNote(e.Chunks[idx], op)
			if err != nil {
				return err
			}
			c := &e.Chunks[idx]
			if ev := noteEvent(e, c.Label, c.Notes[ni]); ev >= 0 {
				e.Events = append(e.Events[:ev], e.Events[ev+1:]...)
			}
			c.Notes = append(c.Notes[:ni], c.Notes[ni+1:]...)
			c.UpdatedTs = now
```

Returning an error from the apply pass is only reachable when one batch holds two note ops on the same chunk (the first shifts the trail under the second); the frontend never sends that. Read the mutate handler in `pkg/wshrpc/wshserver/wshserver_effort.go` to confirm an error from `ApplyEffortOps` means nothing is written; if it would persist a half-applied effort, apply to a copy (`cp := *e` with its `Chunks`/`Events` slices cloned) and assign back only on success.

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/jarvis/`
Expected: PASS (all old and new).

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: `frontend/types/gotypes.d.ts` gains `notets?: number` on `EffortOp` and `edited?: boolean` on `EffortNote`. `git diff --stat` shows only generated files plus your three Go files.

- [ ] **Step 6: Commit**

```bash
git add pkg/wshrpc/wshrpctypes_effort.go pkg/waveobj/wtype.go pkg/jarvis/effortops.go pkg/jarvis/effortops_test.go frontend/types/gotypes.d.ts
git add -u
git commit -m "feat(effort): edit and remove chunk notes, keeping their feed events in step"
```

---

### Task 2: trackeredit.ts and the effortstore edit helpers
**Depends on:** none

**Files:**
- Create: `frontend/app/view/jarvis/trackeredit.ts`
- Create: `frontend/app/view/jarvis/trackeredit.test.ts`
- Modify: `frontend/app/view/jarvis/effortstore.ts` (append helpers)
- Modify: `frontend/app/view/jarvis/effortstore.test.ts` (append tests; Edit, not Write)

**Interfaces:**
- Produces (`trackeredit.ts`):
  - `type EditChunk = { label: string; stage: string }`
  - `type StageRun = { at: number; stage: string; start: number; end: number }` (`at` = run index, same as `stageRowId`'s `at`; `[start,end)` 0-based)
  - `stageRuns(chunks: EditChunk[]): StageRun[]`
  - `moveTarget(chunks: EditChunk[], label: string, dir: "up" | "down"): number | null` → 1-based `at` for `moveChunk`
  - `stageMoveTarget(chunks: EditChunk[], label: string, stage: string): number | null` → 1-based `at` for the `moveChunk` that follows `setChunkStage`
  - `stageRunLabels(chunks: EditChunk[], at: number): string[]`
  - `appendInStageAt(chunks: EditChunk[], at: number): number` → 1-based insert position for `addChunk`
  - `canRemove(chunks: EditChunk[], labels: string[]): boolean`
  - `chunkRef(chunks: EditChunk[], label: string): string`
  - `stepChunk(chunks: EditChunk[], label: string, dir: "prev" | "next"): { label: string; runAt: number } | null`
- Produces (`effortstore.ts`):
  - `type EffortDetails = { title: string; project: string; ticket: string; parent: string }`
  - `detailOps(cur: EffortDetails, next: EffortDetails): EffortOp[]`
  - `renameEffort(oref: string, title: string): Promise<void>`
  - `setEffortDetails(oref: string, cur: EffortDetails, next: EffortDetails): Promise<void>`
  - `renameChunk(oref: string, chunks: EditChunk[], label: string, next: string): Promise<void>`
  - `moveChunk(oref: string, chunks: EditChunk[], label: string, at: number): Promise<void>`
  - `moveChunkToStage(oref: string, chunks: EditChunk[], label: string, stage: string, at: number): Promise<void>`
  - `removeChunks(oref: string, chunks: EditChunk[], labels: string[]): Promise<void>`
  - `addChunkAt(oref: string, label: string, stage: string, at?: number): Promise<void>`

- [ ] **Step 1: Write the failing tests** — `frontend/app/view/jarvis/trackeredit.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    appendInStageAt,
    canRemove,
    chunkRef,
    moveTarget,
    stageMoveTarget,
    stageRunLabels,
    stageRuns,
    stepChunk,
} from "./trackeredit";

const c = (label: string, stage = "") => ({ label, stage });
// runs: 0 = A[a,b], 1 = B[c], 2 = A[d]  (the same name can head two runs)
const plan = [c("a", "A"), c("b", "A"), c("c", "B"), c("d", "A")];

describe("stageRuns", () => {
    it("splits consecutive stages into position-keyed runs", () => {
        expect(stageRuns(plan)).toEqual([
            { at: 0, stage: "A", start: 0, end: 2 },
            { at: 1, stage: "B", start: 2, end: 3 },
            { at: 2, stage: "A", start: 3, end: 4 },
        ]);
    });
});

describe("moveTarget", () => {
    it("moves within the run", () => {
        expect(moveTarget(plan, "a", "down")).toBe(2);
        expect(moveTarget(plan, "b", "up")).toBe(1);
    });
    it("stops at the run's edges", () => {
        expect(moveTarget(plan, "a", "up")).toBeNull();
        expect(moveTarget(plan, "b", "down")).toBeNull();
        expect(moveTarget(plan, "c", "up")).toBeNull();
    });
    it("is null for an unknown label", () => {
        expect(moveTarget(plan, "zz", "up")).toBeNull();
    });
});

describe("stageMoveTarget", () => {
    it("lands after the first run of the target stage", () => {
        // without c: [a,b,d] -> first A run is a,b -> insert at index 2 -> at 3
        expect(stageMoveTarget(plan, "c", "A")).toBe(3);
    });
    it("lands at the end for a stage with no run", () => {
        expect(stageMoveTarget(plan, "a", "")).toBe(4);
    });
    it("is null when the chunk is already in that stage", () => {
        expect(stageMoveTarget(plan, "a", "A")).toBeNull();
    });
});

describe("stageRunLabels / appendInStageAt", () => {
    it("names only the run at that position", () => {
        expect(stageRunLabels(plan, 0)).toEqual(["a", "b"]);
        expect(stageRunLabels(plan, 2)).toEqual(["d"]);
        expect(stageRunLabels(plan, 9)).toEqual([]);
    });
    it("inserts after the run's last chunk", () => {
        expect(appendInStageAt(plan, 0)).toBe(3);
        expect(appendInStageAt(plan, 2)).toBe(5);
    });
});

describe("canRemove", () => {
    it("refuses a removal that would empty the plan", () => {
        expect(canRemove(plan, ["a", "b", "c", "d"])).toBe(false);
        expect(canRemove(plan, ["a", "b", "c"])).toBe(true);
    });
    it("counts duplicates once", () => {
        expect(canRemove([c("a"), c("b")], ["a", "a"])).toBe(true);
    });
});

describe("chunkRef", () => {
    it("passes a normal label through", () => {
        expect(chunkRef(plan, "b")).toBe("b");
    });
    it("sends an all-digit label as its own index, because the server reads digits as an index", () => {
        const odd = [c("2"), c("x")];
        expect(chunkRef(odd, "2")).toBe("1");
    });
});

describe("stepChunk", () => {
    it("steps across runs and reports the run to open", () => {
        expect(stepChunk(plan, "b", "next")).toEqual({ label: "c", runAt: 1 });
        expect(stepChunk(plan, "c", "prev")).toEqual({ label: "b", runAt: 0 });
    });
    it("is null past either end", () => {
        expect(stepChunk(plan, "a", "prev")).toBeNull();
        expect(stepChunk(plan, "d", "next")).toBeNull();
    });
});
```

Append to `frontend/app/view/jarvis/effortstore.test.ts` (add `detailOps` to its import):

```ts
describe("detailOps", () => {
    const cur = { title: "T", project: "p", ticket: "", parent: "" };
    it("sends only what changed", () => {
        expect(detailOps(cur, { ...cur, title: " New " })).toEqual([{ op: "rename", title: "New" }]);
        expect(detailOps(cur, cur)).toEqual([]);
    });
    it("clears with empty strings and strips the effort: prefix from a parent", () => {
        expect(detailOps(cur, { ...cur, project: "", parent: "effort:abc" })).toEqual([
            { op: "setProject", project: "" },
            { op: "link", parentoid: "abc" },
        ]);
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/trackeredit.test.ts frontend/app/view/jarvis/effortstore.test.ts`
Expected: FAIL — module / export not found.

- [ ] **Step 3: Implement `trackeredit.ts`**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The index math behind editing an initiative's plan in place. Every position here is the one the
// server's effort ops take: `at` is 1-based, and moveChunk removes the chunk before inserting it, so a
// target is counted in the list WITHOUT the moving chunk.
//
// A stage is a label on a run of consecutive chunks, not a container, and the same name can head two
// runs — so a run is addressed by its position (`at`, the same key stageRowId uses), never by name.
//
// Pure: no React.

export type EditChunk = { label: string; stage: string };
export type StageRun = { at: number; stage: string; start: number; end: number };

export function stageRuns(chunks: EditChunk[]): StageRun[] {
    const runs: StageRun[] = [];
    chunks.forEach((c, i) => {
        const last = runs[runs.length - 1];
        if (last != null && last.stage === c.stage) {
            last.end = i + 1;
            return;
        }
        runs.push({ at: runs.length, stage: c.stage, start: i, end: i + 1 });
    });
    return runs;
}

const runOf = (runs: StageRun[], idx: number) => runs.find((r) => idx >= r.start && idx < r.end);

// up/down stays inside the chunk's run: crossing a boundary would silently change its stage
export function moveTarget(chunks: EditChunk[], label: string, dir: "up" | "down"): number | null {
    const idx = chunks.findIndex((c) => c.label === label);
    const run = runOf(stageRuns(chunks), idx);
    if (idx < 0 || run == null) {
        return null;
    }
    if (dir === "up") {
        return idx === run.start ? null : idx;
    }
    return idx === run.end - 1 ? null : idx + 2;
}

export function stageMoveTarget(chunks: EditChunk[], label: string, stage: string): number | null {
    const moving = chunks.find((c) => c.label === label);
    if (moving == null || moving.stage === stage) {
        return null;
    }
    const rest = chunks.filter((c) => c.label !== label);
    const run = stageRuns(rest).find((r) => r.stage === stage);
    return (run != null ? run.end : rest.length) + 1;
}

export function stageRunLabels(chunks: EditChunk[], at: number): string[] {
    const run = stageRuns(chunks)[at];
    return run == null ? [] : chunks.slice(run.start, run.end).map((c) => c.label);
}

export function appendInStageAt(chunks: EditChunk[], at: number): number {
    const run = stageRuns(chunks)[at];
    return (run != null ? run.end : chunks.length) + 1;
}

// the server only refuses removing the LAST chunk as seen before the batch, so a batch that removes
// every chunk would pass it and leave an empty initiative
export function canRemove(chunks: EditChunk[], labels: string[]): boolean {
    const gone = new Set(labels);
    return chunks.some((c) => !gone.has(c.label));
}

// ResolveChunkIndex reads an all-digit ref as a 1-based index, so such a label is sent as its position
export function chunkRef(chunks: EditChunk[], label: string): string {
    if (!/^\d+$/.test(label)) {
        return label;
    }
    const idx = chunks.findIndex((c) => c.label === label);
    return idx < 0 ? label : String(idx + 1);
}

export function stepChunk(
    chunks: EditChunk[],
    label: string,
    dir: "prev" | "next"
): { label: string; runAt: number } | null {
    const idx = chunks.findIndex((c) => c.label === label);
    const to = idx < 0 ? -1 : dir === "prev" ? idx - 1 : idx + 1;
    if (to < 0 || to >= chunks.length) {
        return null;
    }
    const run = runOf(stageRuns(chunks), to);
    return { label: chunks[to].label, runAt: run?.at ?? 0 };
}
```

- [ ] **Step 4: Append the helpers to `effortstore.ts`**

Add `import { chunkRef, type EditChunk } from "./trackeredit";` to its imports, then append:

```ts
export type EffortDetails = { title: string; project: string; ticket: string; parent: string };

const bareOid = (s: string) => s.trim().replace(/^effort:/, "");

// only what changed, so saving details that were never touched writes nothing to the trail
export function detailOps(cur: EffortDetails, next: EffortDetails): EffortOp[] {
    const ops: EffortOp[] = [];
    if (next.title.trim() !== cur.title.trim()) {
        ops.push({ op: "rename", title: next.title.trim() });
    }
    if (next.project.trim() !== cur.project.trim()) {
        ops.push({ op: "setProject", project: next.project.trim() });
    }
    if (next.ticket.trim() !== cur.ticket.trim()) {
        ops.push({ op: "setTicket", ticket: next.ticket.trim() });
    }
    if (bareOid(next.parent) !== bareOid(cur.parent)) {
        ops.push({ op: "link", parentoid: bareOid(next.parent) });
    }
    return ops;
}

export async function renameEffort(oref: string, title: string): Promise<void> {
    await mutateEffort(oref, [{ op: "rename", title: title.trim() }]);
}
export async function setEffortDetails(oref: string, cur: EffortDetails, next: EffortDetails): Promise<void> {
    const ops = detailOps(cur, next);
    if (ops.length > 0) {
        await mutateEffort(oref, ops);
    }
}
export async function renameChunk(oref: string, chunks: EditChunk[], label: string, next: string): Promise<void> {
    await mutateEffort(oref, [{ op: "renameChunk", chunk: chunkRef(chunks, label), label: next.trim() }]);
}
export async function moveChunk(oref: string, chunks: EditChunk[], label: string, at: number): Promise<void> {
    await mutateEffort(oref, [{ op: "moveChunk", chunk: chunkRef(chunks, label), at }]);
}
// one batch: a chunk restaged but not yet moved would render as a one-chunk run of its new stage
export async function moveChunkToStage(
    oref: string,
    chunks: EditChunk[],
    label: string,
    stage: string,
    at: number
): Promise<void> {
    const ref = chunkRef(chunks, label);
    await mutateEffort(oref, [
        { op: "setChunkStage", chunk: ref, stage },
        { op: "moveChunk", chunk: ref, at },
    ]);
}
// highest position first, so an index ref (see chunkRef) is never shifted by an earlier removal
export async function removeChunks(oref: string, chunks: EditChunk[], labels: string[]): Promise<void> {
    const idx = (l: string) => chunks.findIndex((c) => c.label === l);
    const ordered = [...labels].sort((a, b) => idx(b) - idx(a));
    await mutateEffort(
        oref,
        ordered.map((label) => ({ op: "removeChunk", chunk: chunkRef(chunks, label) }))
    );
}
export async function addChunkAt(oref: string, label: string, stage: string, at?: number): Promise<void> {
    await mutateEffort(oref, [{ op: "addChunk", label: label.trim(), stage: stage || undefined, at }]);
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run frontend/app/view/jarvis/trackeredit.test.ts frontend/app/view/jarvis/effortstore.test.ts && task check:ts`
Expected: PASS; tsc exit 0 (give it a 4-minute timeout).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/trackeredit.ts frontend/app/view/jarvis/trackeredit.test.ts frontend/app/view/jarvis/effortstore.ts frontend/app/view/jarvis/effortstore.test.ts
git commit -m "feat(jarvis): index math and op batches for editing an initiative's plan"
```

---

### Task 3: Deferred-commit undo queue and the Brief toast
**Depends on:** none

**Files:**
- Create: `frontend/app/view/jarvis/briefundo.ts`
- Create: `frontend/app/view/jarvis/briefundo.test.ts`
- Create: `frontend/app/view/jarvis/brieftoast.tsx`
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (mount toast, flush on unmount/beforeunload, hide pending initiative deletes)

**Interfaces:**
- Produces:
  - `UNDO_WINDOW_MS = 5000`
  - `type BriefToast = { id: number; text: string; undo?: () => void; error?: boolean }`
  - `createUndoQueue(io: { setHidden: (keys: Set<string>) => void; setToast: (t: BriefToast | null) => void; windowMs?: number })` returning `{ schedule(keys: string[], text: string, commit: () => Promise<void>): void; notify(text: string, undo?: () => void): void; error(text: string): void; flushAll(): Promise<void> }`
  - Singletons: `pendingDeleteKeysAtom: PrimitiveAtom<Set<string>>`, `briefToastAtom: PrimitiveAtom<BriefToast | null>`, `briefUndo` (the queue wired to those atoms)
  - Keys: `effortKey(oref)`, `chunkKey(oref, label)`, `noteKey(oref, label, ts)`
  - `<BriefToastView />` (reads `briefToastAtom`)

- [ ] **Step 1: Write the failing tests** — `briefundo.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoQueue, type BriefToast } from "./briefundo";

function harness() {
    const state = { hidden: new Set<string>(), toast: null as BriefToast | null };
    const q = createUndoQueue({
        setHidden: (k) => (state.hidden = k),
        setToast: (t) => (state.toast = t),
        windowMs: 5000,
    });
    return { q, state };
}

describe("createUndoQueue", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("hides at once and commits only after the window", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["chunk:e:a"], "Deleted “a”", commit);
        expect(state.hidden.has("chunk:e:a")).toBe(true);
        expect(state.toast?.undo).toBeTypeOf("function");
        await vi.advanceTimersByTimeAsync(4999);
        expect(commit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(commit).toHaveBeenCalledOnce();
        expect(state.hidden.size).toBe(0);
    });

    it("undo cancels the commit and unhides", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["chunk:e:a"], "Deleted", commit);
        state.toast?.undo?.();
        await vi.advanceTimersByTimeAsync(6000);
        expect(commit).not.toHaveBeenCalled();
        expect(state.hidden.size).toBe(0);
        expect(state.toast).toBeNull();
    });

    it("a second delete inside the window takes the toast, and the first still commits", async () => {
        const { q, state } = harness();
        const first = vi.fn(async () => {});
        const second = vi.fn(async () => {});
        q.schedule(["a"], "first", first);
        await vi.advanceTimersByTimeAsync(1000);
        q.schedule(["b"], "second", second);
        expect(state.toast?.text).toBe("second");
        expect([...state.hidden].sort()).toEqual(["a", "b"]);
        await vi.advanceTimersByTimeAsync(4000);
        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(second).toHaveBeenCalledOnce();
    });

    it("flushAll commits everything pending now", async () => {
        const { q, state } = harness();
        const commit = vi.fn(async () => {});
        q.schedule(["a"], "x", commit);
        await q.flushAll();
        expect(commit).toHaveBeenCalledOnce();
        expect(state.hidden.size).toBe(0);
        await vi.advanceTimersByTimeAsync(6000);
        expect(commit).toHaveBeenCalledOnce();
    });

    it("a failed commit unhides the item and shows the error", async () => {
        const { q, state } = harness();
        q.schedule(["a"], "x", async () => {
            throw new Error("EC-LAST-CHUNK: cannot remove the last chunk");
        });
        await vi.advanceTimersByTimeAsync(5000);
        expect(state.hidden.size).toBe(0);
        expect(state.toast?.error).toBe(true);
        expect(state.toast?.text).toContain("EC-LAST-CHUNK");
    });

    it("notify's undo runs the inverse and clears the toast", () => {
        const { q, state } = harness();
        const inverse = vi.fn();
        q.notify("Archived", inverse);
        state.toast?.undo?.();
        expect(inverse).toHaveBeenCalledOnce();
        expect(state.toast).toBeNull();
    });

    it("the toast clears itself after the window", async () => {
        const { q, state } = harness();
        q.notify("Moved");
        await vi.advanceTimersByTimeAsync(5000);
        expect(state.toast).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/jarvis/briefundo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `briefundo.ts`**

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Undo for the Brief's plan edits. removeChunk and EffortDelete drop the note trail with the object, so
// an inverse op sent after the fact cannot bring the notes back. A destructive edit therefore does not
// happen until its toast has had its window: the item is hidden at once, the RPC goes out when the
// window closes, and Undo simply cancels. Reversible edits (status, archive, move) commit at once and
// their Undo sends the inverse op instead — see notify().

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";

export const UNDO_WINDOW_MS = 5000;

export type BriefToast = { id: number; text: string; undo?: () => void; error?: boolean };

type Pending = { keys: string[]; commit: () => Promise<void>; timer: ReturnType<typeof setTimeout> };

export function createUndoQueue(io: {
    setHidden: (keys: Set<string>) => void;
    setToast: (t: BriefToast | null) => void;
    windowMs?: number;
}) {
    const windowMs = io.windowMs ?? UNDO_WINDOW_MS;
    const pending = new Map<number, Pending>();
    let nextId = 1;
    let toastId = 0;
    let toastTimer: ReturnType<typeof setTimeout> | undefined;

    const publish = () => io.setHidden(new Set([...pending.values()].flatMap((p) => p.keys)));
    const clearToast = () => {
        clearTimeout(toastTimer);
        io.setToast(null);
    };
    const show = (t: Omit<BriefToast, "id">) => {
        clearTimeout(toastTimer);
        const id = ++toastId;
        io.setToast({ ...t, id });
        // only clear the toast this call put up; a newer one keeps its own lifetime
        toastTimer = setTimeout(() => {
            if (toastId === id) {
                io.setToast(null);
            }
        }, windowMs);
    };
    const error = (text: string) => show({ text, error: true });

    const run = async (id: number): Promise<void> => {
        const p = pending.get(id);
        if (p == null) {
            return;
        }
        clearTimeout(p.timer);
        pending.delete(id);
        try {
            await p.commit();
        } catch (e) {
            error(e instanceof Error ? e.message : String(e));
        } finally {
            publish();
        }
    };

    return {
        schedule(keys: string[], text: string, commit: () => Promise<void>): void {
            const id = nextId++;
            const timer = setTimeout(() => void run(id), windowMs);
            pending.set(id, { keys, commit, timer });
            publish();
            show({
                text,
                undo: () => {
                    const p = pending.get(id);
                    if (p != null) {
                        clearTimeout(p.timer);
                        pending.delete(id);
                        publish();
                    }
                    clearToast();
                },
            });
        },
        notify(text: string, undo?: () => void): void {
            show({
                text,
                undo:
                    undo == null
                        ? undefined
                        : () => {
                              clearToast();
                              undo();
                          },
            });
        },
        error,
        async flushAll(): Promise<void> {
            await Promise.all([...pending.keys()].map(run));
        },
    };
}

export const pendingDeleteKeysAtom = atom<Set<string>>(new Set()) as PrimitiveAtom<Set<string>>;
export const briefToastAtom = atom<BriefToast | null>(null) as PrimitiveAtom<BriefToast | null>;

export const briefUndo = createUndoQueue({
    setHidden: (keys) => globalStore.set(pendingDeleteKeysAtom, keys),
    setToast: (t) => globalStore.set(briefToastAtom, t),
});

export const effortKey = (oref: string) => `effort:${oref}`;
export const chunkKey = (oref: string, label: string) => `chunk:${oref}:${label}`;
export const noteKey = (oref: string, label: string, ts: number) => `note:${oref}:${label}:${ts}`;
```

Order in `run` matters: the entry leaves `pending` before the await (so a concurrent `flushAll` cannot commit it twice), but `publish()` only runs in `finally` — after `mutateEffort` has replaced the cache — so the row is already gone from the data when it is unhidden and never flashes back.

- [ ] **Step 4: Implement `brieftoast.tsx`**

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Brief's one toast: bottom-centre over the surface, with Undo when the edit can be taken back.
// Brief-local rather than the cockpit's notificationstore, which is global and has no action button.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { briefToastAtom } from "./briefundo";

export function BriefToastView() {
    const toast = useAtomValue(briefToastAtom);
    if (toast == null) {
        return null;
    }
    return (
        <div
            role="status"
            data-jarvis-brief-toast={toast.error ? "error" : "info"}
            className="absolute bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-[9px] border border-edge-strong bg-surface-raised py-2 pl-3.5 pr-2.5 shadow-[0_12px_34px_rgba(0,0,0,.5)]"
        >
            <span className={cn("whitespace-nowrap text-[12.5px]", toast.error ? "text-error" : "text-secondary")}>
                {toast.text}
            </span>
            {toast.undo != null ? (
                <button
                    type="button"
                    data-jarvis-toast-undo
                    onClick={toast.undo}
                    className="cursor-pointer rounded-[6px] border border-edge-mid px-[9px] py-[3px] font-mono text-[10.5px] font-semibold text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                    Undo
                </button>
            ) : null}
        </div>
    );
}
```

If the shadow's `rgba` trips the no-raw-colour rule, copy whatever shadow class `BriefSheet` / `ModalShell` already uses for floating panels (grep `shadow-\[` in `frontend/app/view/jarvis/*.tsx`) instead of this literal.

- [ ] **Step 5: Wire into `briefsurface.tsx`**

Imports: add `import { BriefToastView } from "./brieftoast";` and `import { briefUndo, effortKey, pendingDeleteKeysAtom } from "./briefundo";`.

Inside `BriefSurface`, before the `lines` memo:

```tsx
    // a delete waiting out its undo window is already gone as far as the reader is concerned
    const pendingDeletes = useAtomValue(pendingDeleteKeysAtom);
    // leaving the Brief or the app inside the window still performs the delete the user did not undo;
    // beforeunload is best-effort, the RPCs are already in flight when the page goes
    useEffect(() => {
        const flush = () => void briefUndo.flushAll();
        window.addEventListener("beforeunload", flush);
        return () => {
            window.removeEventListener("beforeunload", flush);
            flush();
        };
    }, []);
```

In the `lines` memo, replace the `initiatives:` entry with:

```tsx
            initiatives: filterLines(
                effortWindow.rows
                    .filter((r) => !pendingDeletes.has(effortKey(r.oref)))
                    .map(initiativeLine),
                query
            ),
```

and add `pendingDeletes` to that memo's dependency list. (If `effortWindow.rows` items do not expose `oref`, read the type of `initiativeLine`'s argument and use its oref field; `EffortCardModel.oref` is the expected one.)

Render `<BriefToastView />` as the last child of the inner relative container that hosts `NoteSidebar` (the `<div>` closed right after the `{selectedChunk != null ? (<NoteSidebar … />) : null}` block), so it floats over the Brief's rows, not over the composer.

- [ ] **Step 6: Run tests, typecheck**

Run: `npx vitest run frontend/app/view/jarvis/briefundo.test.ts && task check:ts`
Expected: PASS, tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/briefundo.ts frontend/app/view/jarvis/briefundo.test.ts frontend/app/view/jarvis/brieftoast.tsx frontend/app/view/jarvis/briefsurface.tsx
git commit -m "feat(jarvis): hold Brief deletes for an undo window instead of losing the note trail"
```

---

### Task 4: Initiative form — `Stage: chunk` syntax and details edit mode
**Depends on:** Task 2

**Files:**
- Modify: `frontend/app/view/jarvis/effortcreateform.tsx`
- Test: `frontend/app/view/jarvis/effortcreateform.test.ts` (exists — append with Edit)

**Interfaces:**
- Consumes: `EffortDetails`, `setEffortDetails` (Task 2).
- Produces: `ParsedChunkLine = { label: string; stage: string; checked: boolean }`; `parseChunkLines(text)`; `EffortCreateForm({ onClose, edit }: { onClose: () => void; edit?: { oref: string; details: EffortDetails } })`.

- [ ] **Step 1: Write the failing tests** — append to `effortcreateform.test.ts`:

```ts
describe("parseChunkLines stages", () => {
    it("splits on the first colon-space", () => {
        expect(parseChunkLines("Phase 1: WAF scan\nPhase 1: Rule diff: prod\nloose")).toEqual([
            { label: "WAF scan", stage: "Phase 1", checked: false },
            { label: "Rule diff: prod", stage: "Phase 1", checked: false },
            { label: "loose", stage: "", checked: false },
        ]);
    });
    it("keeps a trailing colon or a colon with no space as part of the label", () => {
        expect(parseChunkLines("Note:\nhttp://x")).toEqual([
            { label: "Note:", stage: "", checked: false },
            { label: "http://x", stage: "", checked: false },
        ]);
    });
});
```

Also update every existing expectation in that file that builds a `ParsedChunkLine` literal to include `stage: ""`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run frontend/app/view/jarvis/effortcreateform.test.ts`
Expected: FAIL (no `stage` field).

- [ ] **Step 3: Implement the parse**

```ts
export interface ParsedChunkLine {
    label: string;
    stage: string;
    checked: boolean;
}

// pure parse: one chunk per line, `Stage: chunk` groups it (split on the FIRST ": ", so a label may
// itself contain one after the stage). The preview shows stage headers, so a line that merely
// contains ": " is visible as a stage before anything is created. Ticks live in the form's state.
export function parseChunkLines(text: string): ParsedChunkLine[] {
    const lines: ParsedChunkLine[] = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line === "") {
            continue;
        }
        const cut = line.indexOf(": ");
        const stage = cut > 0 ? line.slice(0, cut).trim() : "";
        const label = cut > 0 ? line.slice(cut + 2).trim() : line;
        lines.push({ label: label === "" ? line : label, stage: label === "" ? "" : stage, checked: false });
    }
    return lines;
}
```

- [ ] **Step 4: Apply stages at create, and add edit mode**

In `submit`, replace the `doneOps` block with one follow-up batch holding both stages and ticks:

```ts
            // the chunk seed carries neither status nor stage, so both land in one atomic follow-up batch
            const followOps: EffortOp[] = [
                ...lines
                    .filter((l) => l.stage !== "")
                    .map((l) => ({ op: "setChunkStage", chunk: l.label, stage: l.stage })),
                ...lines
                    .filter((l) => l.checked)
                    .map((l) => ({ op: "setChunkStatus", chunk: l.label, status: "done" })),
            ];
            if (followOps.length > 0) {
                await RpcApi.EffortMutateCommand(
                    TabRpcClient,
                    { effortoid: rtn.effortoid, ops: followOps },
                    { timeout: stateRpcTimeoutMs }
                );
            }
```

Change the signature and initial state:

```tsx
export function EffortCreateForm({
    onClose,
    edit,
}: {
    onClose: () => void;
    // details mode: the same fields over an existing initiative; its chunks are edited in the plan
    edit?: { oref: string; details: EffortDetails };
}) {
    const [title, setTitle] = useState(edit?.details.title ?? "");
    const [project, setProject] = useState(edit?.details.project ?? "");
    const [ticket, setTicket] = useState(edit?.details.ticket ?? "");
    const [parent, setParent] = useState(edit?.details.parent ?? "");
```

At the top of `submit`, after the title check and `setSubmitting(true)`, branch:

```ts
        if (edit != null) {
            try {
                await setEffortDetails(edit.oref, edit.details, { title, project, ticket, parent });
                onClose();
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setSubmitting(false);
            }
            return;
        }
```

JSX: heading `{edit != null ? "Edit initiative" : "New initiative"}`; the submit button label `{edit != null ? "Save" : <existing label>}`; wrap the whole "Chunks · one per line" block in `{edit == null ? (…) : (<span className="text-[12px] text-muted">Chunks are edited in the plan: double-click to rename, the status pill to change status.</span>)}`. Change the textarea placeholder to `{"Phase 1: WAF posture scan\nPhase 1: Rule diff vs prod\nPhase 2: N1 box upgrade"}` and the label hint beside "Chunks · one per line" to add `<span className="font-mono text-[10px] text-muted">Stage: chunk to group</span>`. In the preview list, render a stage header before a row whose stage differs from the previous row's:

```tsx
                                {lines.map((l, i) => (
                                    <Fragment key={l.label + ":" + i}>
                                        {l.stage !== "" && l.stage !== lines[i - 1]?.stage ? (
                                            <div className="px-1 pb-0.5 pt-1.5 font-mono text-[10px] font-bold uppercase tracking-[.08em] text-muted">
                                                {l.stage}
                                            </div>
                                        ) : null}
                                        <label className="…existing classes…">…existing checkbox + label…</label>
                                    </Fragment>
                                ))}
```

(move the existing `key` from `<label>` onto the `Fragment`; import `Fragment` from react and `EffortOp` is a global generated type; import `setEffortDetails, type EffortDetails` from `./effortstore`.) `canSubmit` in edit mode ignores dupes: `const canSubmit = !submitting && title.trim() !== "" && (edit != null || !dupes);`.

- [ ] **Step 5: Run tests, typecheck**

Run: `npx vitest run frontend/app/view/jarvis/effortcreateform.test.ts && task check:ts`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/effortcreateform.tsx frontend/app/view/jarvis/effortcreateform.test.ts
git commit -m "feat(jarvis): group new chunks by Stage: prefix and edit an initiative's details"
```

---

### Task 5: Editable inline tracker
**Depends on:** Task 2, Task 3, Task 4

**Files:**
- Modify: `frontend/app/view/jarvis/inlinetracker.ts` (stage row gains `at`)
- Modify: `frontend/app/view/jarvis/inlinetracker.test.ts` (assert `at`)
- Modify: `frontend/app/view/jarvis/inlinetrackerview.tsx` (`InitiativeDetail` editing; export `GLYPH`, `TONE_FG`, `STATUSES`)
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (handlers, hidden chunks, details modal, move handler)
- Modify: `frontend/app/view/jarvis/jarvisstore.ts` (`chunkMoveAtom`)
- Modify: `frontend/app/store/keybindings/bindings.ts` (Alt+↑/↓)
- Modify: `docs/keyboard-shortcuts.md` (Jarvis table)

**Interfaces:**
- Consumes: Task 2 helpers + `trackeredit`; Task 3 `briefUndo`, `chunkKey`, `effortKey`, `pendingDeleteKeysAtom`; Task 4 `EffortCreateForm` edit mode.
- Produces: `export const GLYPH`, `export const TONE_FG`, `export const STATUSES` from `inlinetrackerview.tsx`; `chunkMoveAtom: PrimitiveAtom<((dir: "up" | "down") => void) | null>` in `jarvisstore.ts`; stage `TrackerRow` has `at: number`; data attributes `data-jarvis-chunk-status`, `data-jarvis-tracker-menu`, `data-jarvis-rename-input`, `data-jarvis-add-chunk`, `data-jarvis-new-stage`, `data-jarvis-initiative-action="rename|details|pause|archive|unarchive|delete"`, `data-jarvis-delete-confirm`.

- [ ] **Step 1: Failing test for the stage row's `at`** — in `inlinetracker.test.ts`, in an existing test that expands an initiative with two stages, add:

```ts
        const stages = rows.filter((r) => r.kind === "stage");
        expect(stages.map((s) => (s.kind === "stage" ? s.at : -1))).toEqual([0, 1]);
```

Run: `npx vitest run frontend/app/view/jarvis/inlinetracker.test.ts` → FAIL.

- [ ] **Step 2: Add `at`** — in `inlinetracker.ts` change the stage variant to `{ kind: "stage"; id: string; oref: string; stage: string; fraction: string; collapsed: boolean; at: number }` and push `at` in `trackerRows`' `forEach((group, at) => …)`. Re-run → PASS.

- [ ] **Step 3: `chunkMoveAtom` and the bindings**

`jarvisstore.ts`, after `readingNoteAtom`:

```ts
// Alt+↑/↓ moves the chunk under the Brief cursor. The Brief publishes the handler while the cursor is on
// a chunk, because only it holds the plan the move is computed against.
export const chunkMoveAtom = atom<((dir: "up" | "down") => void) | null>(null) as PrimitiveAtom<
    ((dir: "up" | "down") => void) | null
>;
```

`bindings.ts`, in `buildJarvisBindings`' returned array (import `chunkMoveAtom` beside `noteChunkAtom`):

```ts
        {
            id: "jarvis:chunk-up",
            keys: "Alt:ArrowUp",
            group: "Jarvis",
            label: "Move the chunk up within its stage",
            when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,
            run: () => globalStore.get(chunkMoveAtom)?.("up"),
        },
        {
            id: "jarvis:chunk-down",
            keys: "Alt:ArrowDown",
            group: "Jarvis",
            label: "Move the chunk down within its stage",
            when: (ctx) => onStage(ctx) && globalStore.get(chunkMoveAtom) != null,
            run: () => globalStore.get(chunkMoveAtom)?.("down"),
        },
```

`docs/keyboard-shortcuts.md`, Jarvis table, add: `| \`Alt\`+\`↑\` / \`Alt\`+\`↓\` | Move the chunk under the cursor up / down within its stage |`.

- [ ] **Step 4: Rewrite `InitiativeDetail`** in `inlinetrackerview.tsx`

Export the three constants (`export const GLYPH`, `export const TONE_FG`, `export const STATUSES`). Replace the props and body of `InitiativeDetail` with the version below; keep the `pending` branch and the `facts` id/count spans as they are. Delete the old `AddChunk` component (its role moves to `AddChunkRow`).

```tsx
export type TrackerEdits = {
    oid: string; // bare effort oid, for the footer's copy button (an empty plan has no facts row)
    title: string;
    effortStatus: string; // active | paused | done | archived
    total: number;
    stages: string[]; // stageOptions(chunks), for "Move to stage"
    onSetStatus: (label: string, status: string) => void;
    onRenameChunk: (label: string, next: string) => void;
    onMoveChunk: (label: string, dir: "up" | "down") => void;
    canMove: (label: string, dir: "up" | "down") => boolean;
    onMoveToStage: (label: string, stage: string) => void;
    onDeleteChunk: (label: string) => void;
    onRenameStage: (at: number, next: string) => void;
    onDeleteStage: (at: number) => void;
    onAddChunk: (label: string, stage: string, runAt: number | null) => void;
    onRename: (title: string) => void;
    onDetails: () => void;
    onTogglePause: () => void;
    onArchive: () => void;
    onUnarchive: () => void;
    onDelete: () => void;
};

type Editing = { id: string; draft: string } | null;

export function InitiativeDetail({
    rows,
    cursor,
    edits,
    onSelectChunk,
    onToggleStage,
}: {
    rows: DetailRow[];
    cursor: string | undefined;
    edits: TrackerEdits;
    onSelectChunk: (id: string) => void;
    onToggleStage: (id: string, open: boolean) => void;
}) {
    // one menu and one inline editor at a time, across every row of this plan
    const [menu, setMenu] = useState<string | null>(null);
    const [editing, setEditing] = useState<Editing>(null);
    const [confirming, setConfirming] = useState(false);
    const [newStage, setNewStage] = useState<{ name: string; chunk: string | null } | null>(null);
    useEffect(() => {
        if (menu == null) {
            return;
        }
        const close = (e: Event) => {
            if (e instanceof KeyboardEvent) {
                if (e.key !== "Escape") {
                    return;
                }
                // the menu is the innermost layer: Escape closes it, not the sidebar or the surface
                e.stopPropagation();
            } else if ((e.target as Element | null)?.closest("[data-jarvis-tracker-menu]") != null) {
                return;
            }
            setMenu(null);
        };
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", close, true);
        return () => {
            document.removeEventListener("mousedown", close);
            document.removeEventListener("keydown", close, true);
        };
    }, [menu]);

    if (rows.length === 0) {
        return null;
    }
    const startEdit = (id: string, draft: string) => {
        setMenu(null);
        setEditing({ id, draft });
    };
    const commitEdit = (apply: (next: string) => void, before: string) => {
        const next = editing?.draft.trim() ?? "";
        setEditing(null);
        if (next !== "" && next !== before) {
            apply(next);
        }
    };
    const renameInput = (id: string, before: string, apply: (next: string) => void, cls: string) =>
        editing?.id === id ? (
            <input
                autoFocus
                data-jarvis-rename-input
                value={editing.draft}
                onChange={(e) => setEditing({ id, draft: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitEdit(apply, before)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commitEdit(apply, before);
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                    }
                }}
                className={cn(
                    "min-w-0 flex-1 rounded-[5px] border border-accent/60 bg-background px-1.5 py-px text-primary outline-none",
                    cls
                )}
            />
        ) : null;
    // the run each stage header opened, so "+ Add chunk" lands at the end of the right run
    const lastRowOfRun = new Map<string, number>();
    rows.forEach((r, i) => {
        if (r.kind === "stage") {
            lastRowOfRun.set(r.id, i);
        } else if (r.kind === "chunk") {
            const head = [...rows.slice(0, i)].reverse().find((x) => x.kind === "stage");
            if (head != null) {
                lastRowOfRun.set(head.id, i);
            }
        }
    });
    const addAfter = new Map<number, Extract<DetailRow, { kind: "stage" }>>();
    rows.forEach((r) => {
        if (r.kind === "stage" && !r.collapsed) {
            addAfter.set(lastRowOfRun.get(r.id) ?? -1, r);
        }
    });

    return (
        <div
            data-jarvis-initiative-detail="true"
            className="mb-2 rounded-b-[9px] bg-surface-selected/40 pb-[11px] pl-1.5 pr-2.5 pt-[7px]"
        >
            {rows.map((row, i) => {
                const tail = addAfter.get(i);
                const add =
                    tail != null ? (
                        <AddChunkRow
                            key={row.id + "+"}
                            placeholder={`chunk in ${tail.stage || "unstaged"}`}
                            onAdd={(label) => edits.onAddChunk(label, tail.stage, tail.at)}
                        />
                    ) : null;
                if (row.kind === "pending") {
                    return (
                        <p key={row.id} className="px-1.5 py-2 text-[12px] leading-[1.55] text-muted">
                            {row.message}
                        </p>
                    );
                }
                if (row.kind === "facts") {
                    return null; // the footer below carries the id, count and actions now
                }
                if (row.kind === "stage") {
                    const menuId = row.id + "#menu";
                    return (
                        <Fragment key={row.id}>
                            <div
                                data-jarvis-tracker-stage={row.stage}
                                aria-expanded={!row.collapsed}
                                className="relative mt-2 flex items-center gap-2 border-t border-edge-faint px-1.5 pb-1 pt-2.5"
                            >
                                <button
                                    type="button"
                                    aria-label="Toggle stage"
                                    onClick={() => onToggleStage(row.id, row.collapsed)}
                                    className={cn("w-3.5 flex-none cursor-pointer text-[10px] text-ink-mid", FOCUS)}
                                >
                                    {row.collapsed ? "▸" : "▾"}
                                </button>
                                {renameInput(row.id, row.stage, (next) => edits.onRenameStage(row.at, next), "text-[11.5px] font-semibold") ?? (
                                    <button
                                        type="button"
                                        title="Double-click to rename"
                                        onClick={() => onToggleStage(row.id, row.collapsed)}
                                        onDoubleClick={() => startEdit(row.id, row.stage)}
                                        className={cn(
                                            "min-w-0 flex-1 cursor-pointer truncate text-left text-[11.5px] font-semibold text-primary",
                                            FOCUS
                                        )}
                                    >
                                        {row.stage === "" ? "unstaged" : row.stage}
                                    </button>
                                )}
                                <StageBar fraction={row.fraction} />
                                <span className="w-7 flex-none font-mono text-[10.5px] text-muted">{row.fraction}</span>
                                <button
                                    type="button"
                                    aria-label="Stage actions"
                                    onClick={() => setMenu(menu === menuId ? null : menuId)}
                                    className={cn(
                                        "h-5 w-[22px] flex-none cursor-pointer rounded-[5px] border text-[12px] leading-none text-muted hover:text-ink-hi",
                                        menu === menuId ? "border-edge-mid" : "border-transparent",
                                        FOCUS
                                    )}
                                >
                                    ⋯
                                </button>
                                {menu === menuId ? (
                                    <Menu className="right-1 top-[calc(100%-2px)] w-40">
                                        <MenuItem onClick={() => startEdit(row.id, row.stage)}>Rename stage</MenuItem>
                                        <MenuItem
                                            danger
                                            onClick={() => {
                                                setMenu(null);
                                                edits.onDeleteStage(row.at);
                                            }}
                                        >
                                            Delete stage
                                        </MenuItem>
                                    </Menu>
                                ) : null}
                            </div>
                            {add}
                        </Fragment>
                    );
                }
                const selected = cursor === row.id;
                const label = row.row.label;
                const menuId = row.id + "#menu";
                return (
                    <Fragment key={row.id}>
                        <div className="relative">
                            <div
                                role="button"
                                tabIndex={-1}
                                aria-pressed={selected}
                                title="Click for notes · double-click to rename"
                                onClick={() => onSelectChunk(row.id)}
                                onDoubleClick={() => startEdit(row.id, label)}
                                data-jarvis-tracker-chunk={label}
                                className={cn(
                                    "my-px flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-[6px] py-[5px] pl-[7px] pr-1.5 text-left",
                                    selected ? "bg-surface-selected" : "hover:bg-surface-hover"
                                )}
                            >
                                <span aria-hidden className={cn("w-3 flex-none text-center text-[10px]", TONE_FG[row.row.tone])}>
                                    {GLYPH[row.row.tone]}
                                </span>
                                {renameInput(row.id, label, (next) => edits.onRenameChunk(label, next), "text-[12px]") ?? (
                                    <span
                                        className={cn(
                                            "min-w-0 flex-1 truncate text-[12px] leading-[1.4]",
                                            selected ? "font-semibold text-ink-hi" : "text-secondary",
                                            row.row.status === "skipped" && "line-through"
                                        )}
                                    >
                                        {label}
                                    </span>
                                )}
                                {row.notes > 0 ? (
                                    <span className="flex-none font-mono text-[10.5px] text-muted">
                                        {row.notes} {row.notes === 1 ? "note" : "notes"}
                                    </span>
                                ) : null}
                                <button
                                    type="button"
                                    title="Change status"
                                    data-jarvis-chunk-status={row.row.status}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setMenu(menu === menuId ? null : menuId);
                                    }}
                                    className={cn(
                                        "flex w-[86px] flex-none cursor-pointer items-center justify-between gap-1 rounded-[5px] border px-[7px] py-0.5 text-[11px] font-medium hover:border-edge-mid",
                                        menu === menuId ? "border-edge-mid" : "border-transparent",
                                        TONE_FG[row.row.tone],
                                        FOCUS
                                    )}
                                >
                                    {row.row.status}
                                    <span className="text-[8px] text-muted">▾</span>
                                </button>
                            </div>
                            {menu === menuId ? (
                                <Menu className="right-1 top-[calc(100%+2px)] w-[184px]">
                                    <MenuHead>Status</MenuHead>
                                    {STATUSES.map((s) => (
                                        <MenuItem
                                            key={s}
                                            active={s === row.row.status}
                                            glyph={<span className={TONE_FG[chunkTone(s)]}>{GLYPH[chunkTone(s)]}</span>}
                                            onClick={() => {
                                                setMenu(null);
                                                if (s !== row.row.status) {
                                                    edits.onSetStatus(label, s);
                                                }
                                            }}
                                        >
                                            {s}
                                        </MenuItem>
                                    ))}
                                    <MenuRule />
                                    <MenuItem onClick={() => startEdit(row.id, label)}>Rename</MenuItem>
                                    <MenuItem
                                        glyph="↑"
                                        hint="alt ↑"
                                        disabled={!edits.canMove(label, "up")}
                                        onClick={() => {
                                            setMenu(null);
                                            edits.onMoveChunk(label, "up");
                                        }}
                                    >
                                        Move up
                                    </MenuItem>
                                    <MenuItem
                                        glyph="↓"
                                        hint="alt ↓"
                                        disabled={!edits.canMove(label, "down")}
                                        onClick={() => {
                                            setMenu(null);
                                            edits.onMoveChunk(label, "down");
                                        }}
                                    >
                                        Move down
                                    </MenuItem>
                                    {edits.stages.filter((s) => s !== row.row.stage).length > 0 || row.row.stage !== "" ? (
                                        <>
                                            <MenuRule />
                                            <MenuHead>Move to stage</MenuHead>
                                            {[...edits.stages, ""]
                                                .filter((s) => s !== row.row.stage)
                                                .map((s) => (
                                                    <MenuItem
                                                        key={s || "~"}
                                                        glyph="→"
                                                        onClick={() => {
                                                            setMenu(null);
                                                            edits.onMoveToStage(label, s);
                                                        }}
                                                    >
                                                        {s || "unstaged"}
                                                    </MenuItem>
                                                ))}
                                        </>
                                    ) : null}
                                    <MenuRule />
                                    <MenuItem
                                        danger
                                        onClick={() => {
                                            setMenu(null);
                                            edits.onDeleteChunk(label);
                                        }}
                                    >
                                        Delete chunk
                                    </MenuItem>
                                </Menu>
                            ) : null}
                        </div>
                        {add}
                    </Fragment>
                );
            })}
            <NewStageRow
                state={newStage}
                onChange={setNewStage}
                onAdd={(name, chunk) => edits.onAddChunk(chunk, name, null)}
            />
            <TrackerFooter
                facts={rows.find((r): r is Extract<DetailRow, { kind: "facts" }> => r.kind === "facts") ?? null}
                edits={edits}
                confirming={confirming}
                onConfirm={setConfirming}
            />
        </div>
    );
}
```

Add the small pieces below `InitiativeDetail` (import `Fragment`, `useEffect` from react, `chunkTone` from `./effortmodel`):

```tsx
function StageBar({ fraction }: { fraction: string }) {
    const [done, total] = fraction.split("/").map(Number);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return (
        <span className="h-[3px] w-12 flex-none overflow-hidden rounded-sm bg-border">
            <span className="block h-full rounded-sm bg-success" style={{ width: `${pct}%` }} />
        </span>
    );
}

function Menu({ className, children }: { className: string; children: React.ReactNode }) {
    return (
        <div
            data-jarvis-tracker-menu
            onClick={(e) => e.stopPropagation()}
            className={cn(
                "absolute z-30 rounded-[8px] border border-edge-strong bg-surface-raised p-[5px] shadow-[0_12px_34px_rgba(0,0,0,.5)]",
                className
            )}
        >
            {children}
        </div>
    );
}

function MenuHead({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-[7px] pb-[5px] pt-1 font-mono text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">
            {children}
        </div>
    );
}

const MenuRule = () => <div className="mx-0.5 my-[5px] h-px bg-border" />;

function MenuItem({
    children,
    onClick,
    glyph,
    hint,
    active,
    danger,
    disabled,
}: {
    children: React.ReactNode;
    onClick: () => void;
    glyph?: React.ReactNode;
    hint?: string;
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2 rounded-[5px] px-[7px] py-[5px] text-left text-[12px]",
                danger ? "text-error hover:bg-error/10" : "text-secondary hover:bg-surface-hover",
                active && "bg-surface-hover",
                disabled ? "cursor-default opacity-40" : "cursor-pointer",
                FOCUS
            )}
        >
            <span className="w-3 flex-none text-center text-[10px] text-muted">{glyph}</span>
            <span className="min-w-0 flex-1 truncate">{children}</span>
            {hint != null ? <span className="font-mono text-[10.5px] text-muted">{hint}</span> : null}
        </button>
    );
}

// "+ Add chunk" at the end of a stage run: a button that becomes its own input
function AddChunkRow({ placeholder, onAdd }: { placeholder: string; onAdd: (label: string) => void }) {
    const [draft, setDraft] = useState<string | null>(null);
    if (draft == null) {
        return (
            <button
                type="button"
                data-jarvis-add-chunk
                onClick={() => setDraft("")}
                className={cn(
                    "flex cursor-pointer items-center gap-2 px-[7px] py-1 text-[11.5px] font-medium text-muted hover:text-accent-soft",
                    FOCUS
                )}
            >
                <span className="w-3 text-center">+</span>Add chunk
            </button>
        );
    }
    const commit = () => {
        const label = draft.trim();
        setDraft(null);
        if (label !== "") {
            onAdd(label);
        }
    };
    return (
        <div className="flex items-center gap-2 py-[3px] pl-[7px] pr-1.5">
            <span className="w-3 text-center text-[10px] text-muted">+</span>
            <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        commit();
                    } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setDraft(null);
                    }
                }}
                placeholder={placeholder}
                aria-label="New chunk label"
                className="min-w-0 flex-1 rounded-[5px] border border-edge-mid bg-background px-[7px] py-[3px] text-[12px] text-primary outline-none focus:border-accent/60"
            />
            <span className="font-mono text-[10.5px] text-muted">enter · esc</span>
        </div>
    );
}

// a stage is a label on chunks, so it exists only once its first chunk does: name, then first chunk
function NewStageRow({
    state,
    onChange,
    onAdd,
}: {
    state: { name: string; chunk: string | null } | null;
    onChange: (s: { name: string; chunk: string | null } | null) => void;
    onAdd: (name: string, chunk: string) => void;
}) {
    const input =
        "min-w-0 flex-1 rounded-[5px] border border-edge-mid bg-background px-[7px] py-[3px] text-[11.5px] text-primary outline-none focus:border-accent/60";
    return (
        <div className="mt-2.5 border-t border-edge-faint px-[5px] pt-2">
            {state == null ? (
                <button
                    type="button"
                    data-jarvis-new-stage
                    onClick={() => onChange({ name: "", chunk: null })}
                    className={cn(
                        "flex cursor-pointer items-center gap-2 px-0.5 py-0.5 text-[11.5px] font-semibold text-muted hover:text-accent-soft",
                        FOCUS
                    )}
                >
                    <span className="w-3 text-center">+</span>New stage
                </button>
            ) : state.chunk == null ? (
                <input
                    autoFocus
                    value={state.name}
                    onChange={(e) => onChange({ name: e.target.value, chunk: null })}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && state.name.trim() !== "") {
                            onChange({ name: state.name.trim(), chunk: "" });
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            onChange(null);
                        }
                    }}
                    placeholder="Stage name · enter, then add its first chunk"
                    className={cn(input, "w-full font-semibold")}
                />
            ) : (
                <input
                    autoFocus
                    value={state.chunk}
                    onChange={(e) => onChange({ name: state.name, chunk: e.target.value })}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && state.chunk?.trim()) {
                            onAdd(state.name, state.chunk.trim());
                            onChange(null);
                        } else if (e.key === "Escape") {
                            e.stopPropagation();
                            onChange(null);
                        }
                    }}
                    placeholder={`first chunk in ${state.name}`}
                    className={cn(input, "w-full")}
                />
            )}
        </div>
    );
}

function TrackerFooter({
    facts,
    edits,
    confirming,
    onConfirm,
}: {
    facts: Extract<DetailRow, { kind: "facts" }> | null;
    edits: TrackerEdits;
    confirming: boolean;
    onConfirm: (on: boolean) => void;
}) {
    const oid = edits.oid;
    const archived = edits.effortStatus === "archived";
    const action = (name: string, label: string, run: () => void, danger = false) => (
        <button
            type="button"
            data-jarvis-initiative-action={name}
            onClick={run}
            className={cn(SMALL_BUTTON, danger && "hover:border-error/50 hover:text-error", FOCUS)}
        >
            {label}
        </button>
    );
    return (
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-edge-faint px-1.5 pt-2.5 font-mono text-[10.5px] text-muted">
            <button
                type="button"
                title="copy this initiative's id"
                onClick={() => void navigator.clipboard?.writeText(oid)}
                className={cn("cursor-pointer hover:text-ink-hi", FOCUS)}
            >
                {oid}
            </button>
            <span>{facts?.count}</span>
            {confirming ? (
                <span
                    data-jarvis-delete-confirm
                    className="ml-auto flex items-center gap-2 rounded-[7px] border border-error/40 bg-error/10 py-[3px] pl-2.5 pr-1"
                >
                    <span className="font-sans text-[11.5px] text-error">
                        Delete this initiative, its {edits.total} chunks and their notes?
                    </span>
                    <button type="button" onClick={() => onConfirm(false)} className={cn(SMALL_BUTTON, FOCUS)}>
                        cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            onConfirm(false);
                            edits.onDelete();
                        }}
                        className={cn(
                            "cursor-pointer rounded-[5px] bg-error px-[9px] py-[3px] font-bold text-background",
                            FOCUS
                        )}
                    >
                        delete
                    </button>
                </span>
            ) : (
                <span className="ml-auto flex items-center gap-1.5">
                    {action("rename", "rename", () => edits.onRename(edits.title))}
                    {action("details", "details", edits.onDetails)}
                    {archived
                        ? action("unarchive", "unarchive", edits.onUnarchive)
                        : action("pause", edits.effortStatus === "paused" ? "resume" : "pause", edits.onTogglePause)}
                    {archived ? null : action("archive", "archive", edits.onArchive, true)}
                    {action("delete", "delete", () => onConfirm(true), true)}
                </span>
            )}
        </div>
    );
}
```

`rename` in the footer: `edits.onRename(edits.title)` is a signal, not the new title — the surface responds by putting the initiative's title into rename mode (Step 5). Replace the raw `rgba` in `Menu`'s shadow with the shadow class the codebase already uses for popovers if one exists (grep `shadow-\[` in `frontend/app/view`); if none is token-based, keep this literal (shadows are not theme colours) — note it in the commit body. If `bg-error/10` / `border-error/40` are not valid for the `error` token, use the classes `briefsurface.tsx` uses for its error chips (grep `text-error`).

- [ ] **Step 5: Wire it in `briefsurface.tsx`**

Imports: `appendInStageAt, canRemove, moveTarget, stageMoveTarget, stageRunLabels` from `./trackeredit`; `addChunkAt, moveChunk, moveChunkToStage, removeChunks, renameChunk, renameEffort, unarchiveEffort, deleteEffort` from `./effortstore` (keep the existing ones; drop `addChunkOp` if now unused); `chunkKey` from `./briefundo`; `stageOptions` from `./effortmodel`; `chunkMoveAtom` from `./jarvisstore`; `EffortCreateForm` from `./effortcreateform`; `type TrackerEdits` from `./inlinetrackerview`.

In the tracker memo, hide pending chunk deletes (and add `pendingDeletes` to its deps):

```tsx
            chunks:
                openEffort != null
                    ? effortChunkRows(openEffort).filter(
                          (r) => !pendingDeletes.has(chunkKey(openEffortORef ?? "", r.label))
                      )
                    : null,
```

After `runMutation`, add:

```tsx
    // index math runs on the server's list, pending deletes included: the server still has them
    const planChunks = useMemo(() => (openEffort != null ? effortChunkRows(openEffort) : []), [openEffort]);
    const [renamingTitle, setRenamingTitle] = useState<string | null>(null);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const lastChunkError = "An initiative keeps at least one chunk.";
    const pendingLabels = (oref: string) =>
        planChunks.filter((c) => pendingDeletes.has(chunkKey(oref, c.label))).map((c) => c.label);

    const edits = useMemo<TrackerEdits | null>(() => {
        const oref = openEffortORef;
        if (oref == null || openEffort == null) {
            return null;
        }
        const chunks = planChunks;
        const indexOf = (label: string) => chunks.findIndex((c) => c.label === label);
        const scheduleRemove = (labels: string[], text: string) => {
            if (!canRemove(chunks, [...pendingLabels(oref), ...labels])) {
                setMutateError(lastChunkError);
                return;
            }
            briefUndo.schedule(
                labels.map((l) => chunkKey(oref, l)),
                text,
                () => removeChunks(oref, chunks, labels)
            );
        };
        const status = openEffort.status;
        return {
            oid: oref.replace(/^effort:/, ""),
            title: openEffort.title,
            effortStatus: status,
            total: chunks.length,
            stages: stageOptions(chunks),
            onSetStatus: (label, next) => {
                const prev = chunks.find((c) => c.label === label)?.status ?? "pending";
                runMutation(() => setChunkStatus(oref, label, next));
                briefUndo.notify(`Marked “${label}” ${next}`, () =>
                    runMutation(() => setChunkStatus(oref, label, prev))
                );
            },
            onRenameChunk: (label, next) => runMutation(() => renameChunk(oref, chunks, label, next)),
            canMove: (label, dir) => moveTarget(chunks, label, dir) != null,
            onMoveChunk: (label, dir) => {
                const at = moveTarget(chunks, label, dir);
                if (at == null) {
                    return;
                }
                const back = indexOf(label) + 1;
                runMutation(() => moveChunk(oref, chunks, label, at));
                briefUndo.notify(`Moved “${label}” ${dir}`, () =>
                    runMutation(() => moveChunk(oref, chunks, label, back))
                );
            },
            onMoveToStage: (label, stage) => {
                const at = stageMoveTarget(chunks, label, stage);
                const prev = chunks.find((c) => c.label === label);
                if (at == null || prev == null) {
                    return;
                }
                const back = indexOf(label) + 1;
                runMutation(() => moveChunkToStage(oref, chunks, label, stage, at));
                briefUndo.notify(`Moved to ${stage || "unstaged"}`, () =>
                    runMutation(() => moveChunkToStage(oref, chunks, label, prev.stage, back))
                );
            },
            onDeleteChunk: (label) => scheduleRemove([label], `Deleted “${label}”`),
            onRenameStage: (at, next) => runMutation(() => setChunkStage(oref, stageRunLabels(chunks, at), next)),
            onDeleteStage: (at) => {
                const labels = stageRunLabels(chunks, at);
                const name = chunks.find((c) => c.label === labels[0])?.stage || "unstaged";
                scheduleRemove(
                    labels,
                    `Deleted stage “${name}” · ${labels.length} chunk${labels.length === 1 ? "" : "s"}`
                );
            },
            onAddChunk: (label, stage, runAt) =>
                runMutation(() =>
                    addChunkAt(oref, label, stage, runAt != null ? appendInStageAt(chunks, runAt) : undefined)
                ),
            onRename: (title) => setRenamingTitle(title),
            onDetails: () => setDetailsOpen(true),
            onTogglePause: () => {
                const next = status === "paused" ? "active" : "paused";
                runMutation(() => setEffortStatus(oref, next));
                briefUndo.notify(next === "paused" ? "Paused" : "Resumed", () =>
                    runMutation(() => setEffortStatus(oref, status))
                );
            },
            onArchive: () => {
                runMutation(() => setEffortStatus(oref, "archived"));
                briefUndo.notify(`Archived “${openEffort.title}”`, () => runMutation(() => unarchiveEffort(oref)));
            },
            onUnarchive: () => runMutation(() => unarchiveEffort(oref)),
            onDelete: () => {
                setOpenInitiative(null);
                briefUndo.schedule([effortKey(oref)], `Deleted “${openEffort.title}”`, () => deleteEffort(oref));
            },
        };
        // pendingDeletes is read through pendingLabels
    }, [openEffortORef, openEffort, planChunks, pendingDeletes, runMutation, setOpenInitiative]);

    // Alt+↑/↓: published only while the cursor sits on a chunk of the open plan
    const setChunkMove = useSetAtom(chunkMoveAtom);
    useEffect(() => {
        const row = tracker.rows.find((r) => r.id === cursor);
        if (edits == null || row?.kind !== "chunk") {
            setChunkMove(null);
            return;
        }
        setChunkMove(() => (dir: "up" | "down") => edits.onMoveChunk(row.row.label, dir));
        return () => setChunkMove(null);
    }, [edits, cursor, tracker.rows, setChunkMove]);
```

(`useSetAtom` from jotai; `setChunkStage` is the existing batch helper in effortstore; `setMutateError` is the existing state setter; the `effortDetailAtom` read for `openEffort` is unchanged.)

Replace the `<InitiativeDetail … />` element with the version below. While `openEffort` is still loading, `tracker.detail` holds only a `pending` row and `edits` is null, so the loading message renders on its own:

```tsx
                                                                        {edits != null ? (
                                                                            <InitiativeDetail
                                                                                rows={tracker.detail}
                                                                                cursor={cursor}
                                                                                edits={edits}
                                                                                onSelectChunk={(id) => {
                                                                                    setCursor(id);
                                                                                    setNoteChunk(id);
                                                                                    setReadingNote(null);
                                                                                }}
                                                                                onToggleStage={(id, open) =>
                                                                                    setStageOverrides((cur) => ({ ...cur, [id]: open }))
                                                                                }
                                                                            />
                                                                        ) : (
                                                                            <p className="px-3 py-2 text-[12px] text-muted">
                                                                                {tracker.detail[0]?.kind === "pending" ? tracker.detail[0].message : ""}
                                                                            </p>
                                                                        )}
```

(Note the `chunks.length === 0` case still yields a `pending` row while `openEffort` exists — `InitiativeDetail` renders it and `NewStageRow`/footer below it, so an empty plan can still be filled.)

For the title rename: pass `renaming={renamingTitle}` into the initiative `LineRow`'s place — in the Initiatives map, when `l.id === openInitiative && renamingTitle != null`, render instead of `LineRow`:

```tsx
                                                            {l.id === openInitiative && renamingTitle != null ? (
                                                                <input
                                                                    autoFocus
                                                                    data-jarvis-rename-input
                                                                    value={renamingTitle}
                                                                    onChange={(e) => setRenamingTitle(e.target.value)}
                                                                    onBlur={() => {
                                                                        const t = renamingTitle.trim();
                                                                        setRenamingTitle(null);
                                                                        if (t !== "" && openEffortORef != null && t !== openEffort?.title) {
                                                                            runMutation(() => renameEffort(openEffortORef, t));
                                                                        }
                                                                    }}
                                                                    onKeyDown={(e) => {
                                                                        if (e.key === "Enter") {
                                                                            e.currentTarget.blur();
                                                                        } else if (e.key === "Escape") {
                                                                            e.stopPropagation();
                                                                            setRenamingTitle(null);
                                                                        }
                                                                    }}
                                                                    className="my-1 w-full rounded-[6px] border border-accent/60 bg-background px-[11px] py-[5px] text-[13px] text-primary outline-none"
                                                                />
                                                            ) : (
                                                                <LineRow …existing props… />
                                                            )}
```

Details modal, next to `<BriefProfileModal … />`:

```tsx
            {detailsOpen && openEffort != null && openEffortORef != null ? (
                <EffortCreateForm
                    onClose={() => setDetailsOpen(false)}
                    edit={{
                        oref: openEffortORef,
                        details: {
                            title: openEffort.title,
                            project: openEffort.project ?? "",
                            ticket: openEffort.ticket ?? "",
                            parent: openEffort.parentoid ?? "",
                        },
                    }}
                />
            ) : null}
```

Render `mutateError` under the open plan too (it currently only reaches the sidebar): directly after the `InitiativeDetail`/pending element, add `{mutateError != null && selectedChunk == null ? <p className="px-3 pb-2 text-[11px] text-error">{mutateError}</p> : null}`.

- [ ] **Step 6: Typecheck, unit tests, formatter on touched files**

Run: `task check:ts && npx vitest run frontend/app/view/jarvis && npx prettier --check frontend/app/view/jarvis/inlinetrackerview.tsx frontend/app/view/jarvis/briefsurface.tsx frontend/app/view/jarvis/jarvisstore.ts frontend/app/store/keybindings/bindings.ts`
Expected: tsc exit 0, vitest PASS. Prettier: fix only hunks you wrote (`npx prettier --write <file>` is acceptable ONLY if `git diff` afterwards shows no changes outside your hunks; otherwise format by hand).

- [ ] **Step 7: Live check** — `tail -f /dev/null | task dev` (background). Expand a real initiative on the Brief: status pill menu changes a status and Undo reverts it; double-click renames a chunk; Move up/down and Alt+↑/↓ reorder within a stage; Move to stage; + Add chunk under a stage; + New stage → name → first chunk; stage ⋯ rename; delete a chunk → row vanishes, toast with Undo → Undo restores it with no network write; footer rename/details/pause/archive (+Undo)/delete confirm. Compare against `docs/prototype/jarvis-brief-editing.dc.html` variant `a` with `node scripts/cdp-shot.mjs cdp-shots/brief-edit.png`. Stop the dev app afterwards (and the `tail` half).

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/inlinetracker.ts frontend/app/view/jarvis/inlinetracker.test.ts frontend/app/view/jarvis/inlinetrackerview.tsx frontend/app/view/jarvis/briefsurface.tsx frontend/app/view/jarvis/jarvisstore.ts frontend/app/store/keybindings/bindings.ts docs/keyboard-shortcuts.md
git commit -m "feat(jarvis): edit an initiative's plan in place on the Brief"
```

---

### Task 6: Chunk sidebar with editable notes
**Depends on:** Task 1, Task 5

**Files:**
- Create: `frontend/app/view/jarvis/chunksidebar.tsx`
- Modify: `frontend/app/view/jarvis/inlinetrackerview.tsx` (delete `NoteSidebar` and its now-unused imports)
- Modify: `frontend/app/view/jarvis/effortfeed.ts` (`noteAt`, `edited`)
- Modify: `frontend/app/view/jarvis/effortfeed.test.ts` (append)
- Modify: `frontend/app/view/jarvis/effortstore.ts` (`editNote`, `removeNote`)
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (mount `ChunkSidebar`, prev/next, hidden notes)
- Modify: `frontend/app/store/keybindings/bindings.ts` (Escape label text only)

**Interfaces:**
- Consumes: Task 1 generated `EffortOp.notets`, `EffortNote.edited`; Task 2 `stepChunk`; Task 3 `briefUndo`, `noteKey`; Task 5 `GLYPH`, `TONE_FG`, `STATUSES`.
- Produces: `FeedEntry.noteAt?: number`, `FeedEntry.edited?: boolean`; `editNote(oref, chunk, at, ts, text)`, `removeNote(oref, chunk, at, ts)`; `ChunkSidebar` component; data attributes `data-jarvis-chunk-sidebar`, `data-jarvis-note-card`, `data-jarvis-note-edit`, `data-jarvis-note-delete`.

- [ ] **Step 1: Failing feed test** — append to `effortfeed.test.ts`:

```ts
describe("effortFeed noteAt", () => {
    const effort = {
        oid: "e",
        chunks: [
            {
                label: "A",
                status: "active",
                notes: [
                    { ts: 10, text: "marked active" },
                    { ts: 20, text: "a real note", edited: true },
                ],
            },
        ],
        events: [
            { ts: 10, kind: "chunk-status", label: "A", text: "" },
            { ts: 20, kind: "effort-note", label: "A", text: "a real note" },
        ],
    } as unknown as Effort;

    it("gives an effort-note its 1-based place in the chunk's trail, and carries edited", () => {
        const note = effortFeed(effort).find((e) => e.kind === "effort-note");
        expect(note?.noteAt).toBe(2);
        expect(note?.edited).toBe(true);
    });
    it("leaves status entries without noteAt, so they stay read-only", () => {
        const status = effortFeed(effort).find((e) => e.kind === "chunk-status");
        expect(status?.noteAt).toBeUndefined();
    });
});
```

Run: `npx vitest run frontend/app/view/jarvis/effortfeed.test.ts` → FAIL.

- [ ] **Step 2: Implement in `effortfeed.ts`**

Extend `FeedEntry` with:

```ts
    // effort-note entries located on their chunk: the note's 1-based place in that chunk's trail, the
    // key editNote/removeNote take. Absent means read-only.
    noteAt?: number;
    edited?: boolean;
```

Change `LocatedNote` to `EffortNote & { chunk: EffortChunk; at: number }` and its construction to `(chunk.notes ?? []).map((n, i) => ({ ...n, chunk, at: i + 1 }))`. In the entry object add:

```ts
                ...(ev.kind === "effort-note" && note != null ? { noteAt: note.at, edited: note.edited === true } : {}),
```

Re-run → PASS (and the whole `effortfeed.test.ts` still passes — existing `toEqual` expectations on status entries are unaffected because the spread adds nothing there; if an existing effort-note expectation uses `toEqual`, add the two fields to it).

- [ ] **Step 3: Store helpers** — append to `effortstore.ts`:

```ts
export async function editNote(oref: string, chunk: string, at: number, ts: number, text: string): Promise<void> {
    await mutateEffort(oref, [{ op: "editNote", chunk, at, notets: ts, note: text.trim() }]);
}
export async function removeNote(oref: string, chunk: string, at: number, ts: number): Promise<void> {
    await mutateEffort(oref, [{ op: "removeNote", chunk, at, notets: ts }]);
}
```

(`chunk` is passed through `chunkRef` by the caller — see Step 5.)

- [ ] **Step 4: `chunksidebar.tsx`** — the design's 460px panel:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Chunk sidebar: one chunk's status and note trail beside the Brief. Not modal — the Brief behind
// it stays live, and prev/next step the Brief's own cursor rather than keeping a second one here.
// Past the container breakpoint it floats over the index instead of compressing it (a container query:
// the Brief is the whole surface, the window is not).

import { cn } from "@/util/util";
import { useState } from "react";
import { feedRows, type FeedEntry } from "./effortfeed";
import { chunkTone } from "./effortmodel";
import { GLYPH, STATUSES, TONE_FG } from "./inlinetrackerview";

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const NOTE_PAGE = 40;
const NAV_BUTTON =
    "h-[22px] w-6 cursor-pointer rounded-[6px] border border-border bg-surface-raised text-[11px] hover:border-edge-strong disabled:cursor-default disabled:opacity-40";

export function ChunkSidebar({
    initiative,
    label,
    stage,
    status,
    position,
    feed,
    expanded,
    now,
    handle,
    error,
    onPrev,
    onNext,
    onExpand,
    onClose,
    onActivity,
    onAddNote,
    onSetStatus,
    onEditNote,
    onDeleteNote,
}: {
    initiative: string;
    label: string;
    stage: string;
    status: string;
    position: { n: number; total: number };
    feed: FeedEntry[];
    expanded: number | null;
    now: number;
    handle: string;
    error: string | null;
    onPrev: (() => void) | null;
    onNext: (() => void) | null;
    onExpand: (i: number | null) => void;
    onClose: () => void;
    onActivity: () => void;
    onAddNote: (text: string) => void;
    onSetStatus: (status: string) => void;
    onEditNote: (entry: FeedEntry, text: string) => void;
    onDeleteNote: (entry: FeedEntry) => void;
}) {
    const notes = feedRows(feed, { only: label, limit: NOTE_PAGE, now }).rows.filter((r) => r.body !== "");
    const [draft, setDraft] = useState("");
    const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
    const submit = () => {
        const text = draft.trim();
        if (text !== "") {
            onAddNote(text);
            setDraft("");
        }
    };
    const saveEdit = (entry: FeedEntry) => {
        const text = editing?.text.trim() ?? "";
        if (text === "") {
            return; // Save is disabled on empty text; the server would refuse it too (EC-EMPTY-NOTE)
        }
        setEditing(null);
        if (text !== entry.text) {
            onEditNote(entry, text);
        }
    };

    return (
        <aside
            aria-label="Chunk"
            data-jarvis-chunk-sidebar
            className="absolute inset-y-0 right-0 z-[4] flex w-[460px] flex-col overflow-hidden border-l border-border bg-background @max-[1280px]:shadow-[-18px_0_44px_var(--color-background)] @max-[980px]:w-[min(460px,92cqw)]"
        >
            <div className="flex flex-none items-center gap-2 border-b border-edge-faint px-[13px] py-[9px]">
                <span className="font-mono text-[10.5px] font-bold uppercase tracking-[.09em] text-muted">Chunk</span>
                <span className="font-mono text-[10.5px] text-muted">
                    {position.n}/{position.total}
                </span>
                <div className="flex gap-1">
                    <button type="button" aria-label="Previous chunk" title="Previous chunk (k)" disabled={onPrev == null} onClick={onPrev ?? undefined} className={cn(NAV_BUTTON, FOCUS)}>
                        ↑
                    </button>
                    <button type="button" aria-label="Next chunk" title="Next chunk (j)" disabled={onNext == null} onClick={onNext ?? undefined} className={cn(NAV_BUTTON, FOCUS)}>
                        ↓
                    </button>
                </div>
                <span className="font-mono text-[10px] text-muted">j / k</span>
                <button
                    type="button"
                    onClick={onClose}
                    className={cn(
                        "ml-auto cursor-pointer rounded-[7px] border border-border bg-surface-raised px-[9px] py-1 text-[10px] font-semibold text-muted hover:border-edge-strong hover:text-ink-hi",
                        FOCUS
                    )}
                >
                    Close
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-1.5 px-[18px] pb-3.5 pt-[15px]">
                    <div className="flex items-center gap-[7px] font-mono text-[10.5px] uppercase tracking-[.06em] text-muted">
                        <span className="truncate">{initiative}</span>
                        <span className="text-edge-strong">/</span>
                        <span className="truncate">{stage || "unstaged"}</span>
                        <button type="button" onClick={onActivity} className={cn("ml-auto cursor-pointer normal-case tracking-normal text-accent-soft hover:underline", FOCUS)}>
                            initiative activity ↗
                        </button>
                    </div>
                    <div className="text-pretty text-[16px] font-semibold leading-[1.35] text-primary">{label}</div>
                    <button
                        type="button"
                        title="Copy the CLI handle"
                        onClick={() => void navigator.clipboard?.writeText(handle)}
                        className={cn("self-start cursor-pointer font-mono text-[10.5px] text-muted hover:text-ink-hi", FOCUS)}
                    >
                        {handle} ⧉
                    </button>
                </div>
                <div className="px-[18px] pb-4">
                    <div role="radiogroup" aria-label="Status" className="grid grid-cols-6 gap-[3px] rounded-[8px] border border-border bg-surface p-[3px]">
                        {STATUSES.map((s) => {
                            const tone = chunkTone(s);
                            const on = s === status;
                            return (
                                <button
                                    key={s}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    onClick={() => !on && onSetStatus(s)}
                                    className={cn(
                                        "flex min-w-0 cursor-pointer flex-col items-center gap-0.5 rounded-[6px] border px-0.5 py-[5px] hover:bg-surface-hover",
                                        on ? "border-edge-mid bg-surface-selected" : "border-transparent",
                                        FOCUS
                                    )}
                                >
                                    <span className={cn("text-[11px] leading-none", on ? TONE_FG[tone] : "text-muted")}>{GLYPH[tone]}</span>
                                    <span className={cn("font-mono text-[9.5px]", on ? TONE_FG[tone] : "text-muted")}>{s}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="border-t border-edge-faint px-[18px] pb-[18px] pt-3">
                    <div className="mb-2 flex items-center gap-2 font-mono text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">
                        <span>Notes</span>
                        <span className="font-normal tracking-[.04em]">{notes.length}</span>
                    </div>
                    {notes.length === 0 ? (
                        <p className="text-[12px] leading-[1.6] text-muted">
                            No notes on this chunk yet. Notes from you or an agent land here.
                        </p>
                    ) : null}
                    {error != null ? <p className="mb-2 text-[11px] text-error">{error}</p> : null}
                    <div className="flex flex-col gap-2">
                        {notes.map((n, i) => {
                            const open = expanded === i;
                            const isEditing = editing?.key === n.key;
                            const editable = n.entry.noteAt != null;
                            return (
                                <div
                                    key={n.key}
                                    data-jarvis-note-card={n.key}
                                    className={cn("rounded-[8px] border bg-surface", open ? "border-edge-mid" : "border-border")}
                                >
                                    <button
                                        type="button"
                                        onClick={() => onExpand(open ? null : i)}
                                        className={cn("flex w-full cursor-pointer flex-col gap-[5px] rounded-[8px] px-[11px] py-[9px] text-left hover:bg-surface-hover", FOCUS)}
                                    >
                                        <span className="flex w-full items-center gap-[7px] font-mono text-[10.5px] text-muted">
                                            <span>
                                                {n.day || n.entry.marked}
                                                {n.entry.edited ? " · edited" : ""}
                                            </span>
                                            <span className="ml-auto">{open ? "▾" : "▸"}</span>
                                        </span>
                                        {isEditing ? null : (
                                            <span className={cn("whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] text-secondary", !open && "line-clamp-3")}>
                                                {n.body}
                                            </span>
                                        )}
                                    </button>
                                    {isEditing ? (
                                        <div className="flex flex-col gap-1.5 px-[11px] pb-2.5">
                                            <textarea
                                                autoFocus
                                                rows={6}
                                                value={editing.text}
                                                onChange={(e) => setEditing({ key: n.key, text: e.target.value })}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                                        saveEdit(n.entry);
                                                    } else if (e.key === "Escape") {
                                                        e.stopPropagation();
                                                        setEditing(null);
                                                    }
                                                }}
                                                className="w-full resize-y rounded-[7px] border border-accent/60 bg-background px-2.5 py-2 text-[12.5px] leading-[1.6] text-primary outline-none"
                                            />
                                            <div className="flex items-center gap-1.5">
                                                <span className="flex-1 font-mono text-[10.5px] text-muted">ctrl+enter save · esc cancel</span>
                                                <button type="button" onClick={() => setEditing(null)} className={cn("cursor-pointer rounded-[7px] border border-border bg-surface-raised px-[11px] py-1 text-[11px] font-semibold text-secondary", FOCUS)}>
                                                    Cancel
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={editing.text.trim() === ""}
                                                    onClick={() => saveEdit(n.entry)}
                                                    className={cn("cursor-pointer rounded-[7px] bg-accent px-[11px] py-1 text-[11px] font-bold text-background disabled:cursor-default disabled:opacity-40", FOCUS)}
                                                >
                                                    Save
                                                </button>
                                            </div>
                                        </div>
                                    ) : open && editable ? (
                                        <div className="flex gap-3 border-t border-edge-faint px-[11px] py-1.5">
                                            <button
                                                type="button"
                                                data-jarvis-note-edit
                                                onClick={() => setEditing({ key: n.key, text: n.entry.text })}
                                                className={cn("cursor-pointer font-mono text-[10.5px] text-muted hover:text-accent-soft", FOCUS)}
                                            >
                                                edit
                                            </button>
                                            <button
                                                type="button"
                                                data-jarvis-note-delete
                                                onClick={() => onDeleteNote(n.entry)}
                                                className={cn("cursor-pointer font-mono text-[10.5px] text-muted hover:text-error", FOCUS)}
                                            >
                                                delete
                                            </button>
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
            <div className="flex-none border-t border-border bg-surface px-[13px] pb-3 pt-2.5">
                <div className="flex flex-col gap-1.5 rounded-[8px] border border-edge-mid bg-background py-[7px] pl-2.5 pr-2">
                    <textarea
                        rows={3}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                submit();
                            } else if (e.key === "Escape" && draft !== "") {
                                // a half-typed note: Escape clears it before the sidebar's own Escape closes the panel
                                e.stopPropagation();
                                setDraft("");
                            }
                        }}
                        placeholder={`note on ${label}`}
                        aria-label="New note"
                        className="w-full resize-none bg-transparent text-[12.5px] leading-[1.6] text-primary outline-none"
                    />
                    <div className="flex items-center gap-2">
                        <span className="flex-1 font-mono text-[10.5px] text-muted">ctrl+enter to add</span>
                        <button
                            type="button"
                            disabled={draft.trim() === ""}
                            onClick={submit}
                            className={cn("cursor-pointer rounded-[6px] bg-accent px-[11px] py-1 text-[11px] font-bold text-background disabled:cursor-default disabled:bg-surface-raised disabled:text-muted", FOCUS)}
                        >
                            Add note
                        </button>
                    </div>
                </div>
            </div>
        </aside>
    );
}
```

If `text-edge-strong` is not a valid text token, use `text-muted` for the `/` separator. Then delete `NoteSidebar` from `inlinetrackerview.tsx` together with imports only it used (`feedRows`, `kilo`, `FeedEntry`, `NOTE_PAGE`) — keep whatever `InitiativeDetail` still needs.

- [ ] **Step 5: Mount in `briefsurface.tsx`**

Imports: `ChunkSidebar` from `./chunksidebar` (drop `NoteSidebar` from the `./inlinetrackerview` import); `editNote, removeNote` from `./effortstore`; `noteKey` from `./briefundo`; `chunkRef, stepChunk` from `./trackeredit`; `chunkRowId, stageRowId` from `./inlinetracker` (if not already imported).

In the tracker memo, hide pending note deletes from the feed:

```tsx
        const feed =
            openEffort != null
                ? effortFeed(openEffort).filter((e) => !pendingDeletes.has(noteKey(openEffortORef ?? "", e.chunk, e.ts)))
                : [];
```

Remove the reader scrim block (`{selectedChunk != null && readingNote != null ? (<div aria-hidden … />) : null}`) — there is no separate reader any more. Replace the `<NoteSidebar … />` element with:

```tsx
                {selectedChunk != null && openInitiative != null ? (
                    <ChunkSidebar
                        initiative={openEffort?.title ?? ""}
                        label={selectedChunk.row.label}
                        stage={selectedChunk.row.stage}
                        status={selectedChunk.row.status}
                        position={{
                            n: planChunks.findIndex((c) => c.label === selectedChunk.row.label) + 1,
                            total: planChunks.length,
                        }}
                        feed={tracker.feed}
                        expanded={readingNote}
                        now={Date.now()}
                        handle={`wsh effort note ${selectedChunk.oref.replace(/^effort:/, "")} "${selectedChunk.row.label}"`}
                        error={mutateError}
                        onPrev={stepTo("prev")}
                        onNext={stepTo("next")}
                        onExpand={setReadingNote}
                        onClose={closeNotes}
                        onActivity={() => openLine({ oref: selectedChunk.oref })}
                        onAddNote={(text) =>
                            runMutation(() => appendChunkNote(selectedChunk.oref, selectedChunk.row.label, text))
                        }
                        onSetStatus={(status) => edits?.onSetStatus(selectedChunk.row.label, status)}
                        onEditNote={(entry, text) =>
                            entry.noteAt != null &&
                            runMutation(() =>
                                editNote(selectedChunk.oref, chunkRef(planChunks, entry.chunk), entry.noteAt!, entry.ts, text)
                            )
                        }
                        onDeleteNote={(entry) => {
                            if (entry.noteAt == null) {
                                return;
                            }
                            const at = entry.noteAt;
                            setReadingNote(null);
                            briefUndo.schedule([noteKey(selectedChunk.oref, entry.chunk, entry.ts)], "Note deleted", () =>
                                removeNote(selectedChunk.oref, chunkRef(planChunks, entry.chunk), at, entry.ts)
                            );
                        }}
                    />
                ) : null}
```

Before the `return`, define `stepTo` (prev/next open the target's stage and move the ONE Brief cursor):

```tsx
    const stepTo = (dir: "prev" | "next"): (() => void) | null => {
        if (selectedChunk == null || openInitiative == null) {
            return null;
        }
        const visible = planChunks.filter((c) => !pendingDeletes.has(chunkKey(selectedChunk.oref, c.label)));
        const to = stepChunk(visible, selectedChunk.row.label, dir);
        if (to == null) {
            return null;
        }
        return () => {
            const stage = visible.find((c) => c.label === to.label)?.stage ?? "";
            setStageOverrides((cur) => ({ ...cur, [stageRowId(openInitiative, stage, to.runAt)]: true }));
            setCursor(chunkRowId(openInitiative, to.label));
        };
    };
```

(`stageRowId`'s `at` is the run index in `trackerRows`, which groups the list with pending deletes already filtered — the same `visible` list used here, so the ids match.)

Status changes from the sidebar reuse `edits.onSetStatus`, so they get the same Undo toast as the tracker menu.

`bindings.ts`: change `noteSidebarEscape.label` to `"Back out of the Chunk sidebar"` and its comment's first line to `// One rung per press: an expanded note card folds, then the sidebar closes.` (the logic stays: `readingNoteAtom` now means the expanded card).

- [ ] **Step 6: Typecheck, tests, prettier on touched files**

Run: `task check:ts && npx vitest run frontend/app/view/jarvis && npx prettier --check frontend/app/view/jarvis/chunksidebar.tsx frontend/app/view/jarvis/briefsurface.tsx frontend/app/view/jarvis/inlinetrackerview.tsx frontend/app/view/jarvis/effortfeed.ts frontend/app/view/jarvis/effortstore.ts`
Expected: exit 0 / PASS (format only your own hunks, as in Task 5).

- [ ] **Step 7: Live check** — dev app (`tail -f /dev/null | task dev`, rebuilt backend so the new ops exist: the dev task builds wavesrv). Open a chunk: 460px sidebar, `n/N`, ↑/↓ step across stages (collapsed target stage opens), six-cell status sets status with an Undo toast, add a note with Ctrl+Enter, expand it → edit → Ctrl+Enter saves and shows "· edited", delete → card vanishes, Undo restores, letting the toast lapse removes it for good (reload the Brief to confirm). A "marked done" status entry shows no edit/delete. Screenshot with `node scripts/cdp-shot.mjs cdp-shots/brief-chunk-sidebar.png` and compare to the prototype's sidebar. Stop the dev app.

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/jarvis/chunksidebar.tsx frontend/app/view/jarvis/inlinetrackerview.tsx frontend/app/view/jarvis/effortfeed.ts frontend/app/view/jarvis/effortfeed.test.ts frontend/app/view/jarvis/effortstore.ts frontend/app/view/jarvis/briefsurface.tsx frontend/app/store/keybindings/bindings.ts
git commit -m "feat(jarvis): the Chunk sidebar, with notes you can edit and delete"
```

---

### Task 7: CDP coverage for the editing layer
**Depends on:** Task 6

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (extend `brief-inline-tracker`; hand-formatted 4-space — never run prettier on it)

**Interfaces:**
- Consumes: data attributes from Tasks 3, 5, 6.

- [ ] **Step 1: Read the scenario** — `brief-inline-tracker` in `scripts/cdp/scenarios.mjs` (around line 4440). Note its `hasPlan` pattern: fixture data may carry no plan, in which case plan steps are reported as skipped rather than failed. Keep that pattern.

- [ ] **Step 2: Append steps** before the scenario's `return steps` (reuse its `h.ev`, `h.shot`, `steps.push` style; every step asserts, none commits a write — Undo is used so no RPC is sent):

```js
        // 3. the status pill opens a menu with the six statuses
        if (hasPlan) {
            await h.ev(`document.querySelector('[data-jarvis-chunk-status]')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            const menu = await h.ev(`(() => {
                const m = document.querySelector('[data-jarvis-tracker-menu]');
                return m ? [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) : null;
            })()`);
            const six = ["pending", "active", "blocked", "deferred", "skipped", "done"];
            steps.push({
                step: "3. the status pill opens a menu listing all six statuses",
                ok: Array.isArray(menu) && six.every((s) => menu.some((t) => t.startsWith(s))),
                detail: JSON.stringify(menu),
            });
            await h.shot("cdp-shots/brief-inline-tracker-menu.png");
            await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

            // 4. double-click renames in place
            await h.ev(`document.querySelector('[data-jarvis-tracker-chunk]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            const renaming = await h.ev(`!!document.querySelector('[data-jarvis-rename-input]')`);
            steps.push({ step: "4. double-clicking a chunk opens its rename input", ok: renaming === true, detail: String(renaming) });
            await h.ev(`document.querySelector('[data-jarvis-rename-input]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

            // 5. delete hides the row at once, and Undo brings it back without a write
            const label = await h.ev(`document.querySelectorAll('[data-jarvis-tracker-chunk]').length > 1 ? document.querySelector('[data-jarvis-tracker-chunk]').getAttribute('data-jarvis-tracker-chunk') : null`);
            if (label != null) {
                await h.ev(`document.querySelector('[data-jarvis-chunk-status]')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 200))");
                await h.ev(`[...document.querySelectorAll('[data-jarvis-tracker-menu] button')].find((b) => b.textContent.trim() === 'Delete chunk')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 200))");
                const gone = await h.ev(`!document.querySelector('[data-jarvis-tracker-chunk=${JSON.stringify(label)}]') && !!document.querySelector('[data-jarvis-toast-undo]')`);
                await h.ev(`document.querySelector('[data-jarvis-toast-undo]')?.click()`);
                await h.ev("new Promise((r) => setTimeout(r, 300))");
                const back = await h.ev(`!!document.querySelector('[data-jarvis-tracker-chunk=${JSON.stringify(label)}]')`);
                steps.push({
                    step: "5. delete hides the chunk behind an Undo toast, and Undo restores it",
                    ok: gone === true && back === true,
                    detail: JSON.stringify({ label, gone, back }),
                });
            } else {
                steps.push({ step: "5. delete + undo (skipped: the plan has one chunk)", ok: true, detail: "one chunk" });
            }

            // 6. the footer's delete asks first
            await h.ev(`document.querySelector('[data-jarvis-initiative-action="delete"]')?.click()`);
            await h.ev("new Promise((r) => setTimeout(r, 200))");
            const confirm = await h.ev(`document.querySelector('[data-jarvis-delete-confirm]')?.textContent ?? null`);
            steps.push({
                step: "6. deleting an initiative asks for confirmation first",
                ok: typeof confirm === "string" && confirm.includes("Delete this initiative"),
                detail: String(confirm),
            });
            await h.ev(`[...document.querySelectorAll('[data-jarvis-delete-confirm] button')].find((b) => b.textContent.trim() === 'cancel')?.click()`);
        } else {
            steps.push({ step: "3-6. editing layer (skipped: fixture carries no plan)", ok: true, detail: "no plan" });
        }
```

If the scenario names its plan flag differently than `hasPlan`, use its name. Note that step 5's Undo must happen inside the 5s window — the waits above total well under it.

- [ ] **Step 3: Run it against the live dev app**

Run (dev app up via `tail -f /dev/null | task dev`): `task verify:ui -- brief-inline-tracker`
Expected: all steps PASS. If the fixture has no plan so 3–6 skip, run again with the fixture bar off (live data with at least one initiative that has ≥2 chunks) and record which data it ran against in the commit body. Stop the dev app afterwards.

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp/scenarios.mjs
git commit -m "test(cdp): cover the Brief's plan editing and its undo"
```
