# Theme 4 Maintainability and Test Gaps — First Tranche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add regression coverage for run lifecycle and cwd resolution, then replace four copies of the session terminal-block selection rule with one tested pure helper.

**Architecture:** Keep RPC, WOS, modal, and jotai ownership unchanged. Test the existing exported behavior at module boundaries with Vitest mocks; place the new pure selector in `sessionviewmodel.ts`, while `sessionsidebarmodel.ts` remains responsible for resolving Wave objects.

**Tech Stack:** TypeScript, Vitest 3, jotai, Wave Object Store (WOS).

## Global Constraints

- Implement only Theme 4 items #1, #3, and #6 from `docs/superpowers/briefs/2026-07-17-theme4-maintability-testgaps-brief.md`.
- Preserve runtime behavior, RPC payloads, copy, atom shapes, error policy, and session ordering exactly.
- Do not touch Jarvis watcher/outcome tests, `runbody.tsx`, or the `agentsviewmodel.ts` grid extraction in this tranche.
- Do not add dependencies, configuration, generated files, persistence changes, or UI changes.
- Match existing Vitest module-mock conventions; do not add dependency-injection adapters solely for tests.
- Use the shared working tree carefully. Re-run unscoped `git status --short` before and after work; do not stage, commit, or push without explicit approval.
- Verification ends with focused Vitest, full Vitest, and the large-stack TypeScript check. No CDP run is required because rendered behavior does not change.

---

### Task 1: Cover run lifecycle boundaries

**Files:**
- Create: `frontend/app/view/agents/runactions.test.ts`
- Read only: `frontend/app/view/agents/runactions.ts`

**Interfaces:**
- Consumes: `confirmCancelRun(channelId, runId, liveCount)`, `stopRunWorker(channelId, runId, workerORef)`, `cancelRun(channelId, runId)`, `stoppingWorkerIdsAtom`, and `cancellingRunIdsAtom` from `runactions.ts`.
- Produces: direct regression coverage for confirmation branching/copy, RPC payloads, `tab:` normalization, and in-flight cleanup.

- [ ] **Step 1: Create the characterization test file**

Create `frontend/app/view/agents/runactions.test.ts` with:

```ts
import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stopRunWorkerCommand = vi.fn();
const cancelRunCommand = vi.fn();
const pushModal = vi.fn();

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        StopRunWorkerCommand: (...args: any[]) => stopRunWorkerCommand(...args),
        CancelRunCommand: (...args: any[]) => cancelRunCommand(...args),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/modalmodel", () => ({
    modalsModel: { pushModal: (...args: any[]) => pushModal(...args) },
}));

import {
    cancelRun,
    cancellingRunIdsAtom,
    confirmCancelRun,
    stopRunWorker,
    stoppingWorkerIdsAtom,
} from "./runactions";

function deferred() {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    stopRunWorkerCommand.mockReset();
    cancelRunCommand.mockReset();
    pushModal.mockReset();
    globalStore.set(stoppingWorkerIdsAtom, new Set());
    globalStore.set(cancellingRunIdsAtom, new Set());
});

describe("stopRunWorker", () => {
    it("tracks the stripped tab id while preserving the worker oref in the RPC", async () => {
        const pending = deferred();
        stopRunWorkerCommand.mockReturnValueOnce(pending.promise);

        const call = stopRunWorker("channel-1", "run-1", "tab:worker-1");

        expect([...globalStore.get(stoppingWorkerIdsAtom)]).toEqual(["worker-1"]);
        expect(stopRunWorkerCommand).toHaveBeenCalledWith(expect.anything(), {
            channelid: "channel-1",
            runid: "run-1",
            workeroref: "tab:worker-1",
        });

        pending.resolve();
        await call;
        expect(globalStore.get(stoppingWorkerIdsAtom).size).toBe(0);
    });

    it("removes the in-flight id when the RPC rejects", async () => {
        const pending = deferred();
        stopRunWorkerCommand.mockReturnValueOnce(pending.promise);
        const call = stopRunWorker("channel-1", "run-1", "worker-1");
        const rejected = expect(call).rejects.toThrow("stop failed");

        expect([...globalStore.get(stoppingWorkerIdsAtom)]).toEqual(["worker-1"]);
        pending.reject(new Error("stop failed"));

        await rejected;
        expect(globalStore.get(stoppingWorkerIdsAtom).size).toBe(0);
    });
});

describe("cancelRun", () => {
    it("tracks the run id until cancellation resolves", async () => {
        const pending = deferred();
        cancelRunCommand.mockReturnValueOnce(pending.promise);

        const call = cancelRun("channel-1", "run-1");

        expect([...globalStore.get(cancellingRunIdsAtom)]).toEqual(["run-1"]);
        expect(cancelRunCommand).toHaveBeenCalledWith(expect.anything(), {
            channelid: "channel-1",
            runid: "run-1",
        });

        pending.resolve();
        await call;
        expect(globalStore.get(cancellingRunIdsAtom).size).toBe(0);
    });

    it("removes the in-flight id when cancellation rejects", async () => {
        const pending = deferred();
        cancelRunCommand.mockReturnValueOnce(pending.promise);
        const call = cancelRun("channel-1", "run-1");
        const rejected = expect(call).rejects.toThrow("cancel failed");

        expect([...globalStore.get(cancellingRunIdsAtom)]).toEqual(["run-1"]);
        pending.reject(new Error("cancel failed"));

        await rejected;
        expect(globalStore.get(cancellingRunIdsAtom).size).toBe(0);
    });
});

describe("confirmCancelRun", () => {
    it("cancels directly when no workers are live", async () => {
        cancelRunCommand.mockResolvedValueOnce(undefined);

        confirmCancelRun("channel-1", "run-1", 0);

        expect(pushModal).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(cancelRunCommand).toHaveBeenCalledWith(expect.anything(), {
                channelid: "channel-1",
                runid: "run-1",
            })
        );
    });

    it.each([
        [1, "Stop 1 running worker and cancel this run? Completed phases, transcripts, and artifacts are kept."],
        [2, "Stop 2 running workers and cancel this run? Completed phases, transcripts, and artifacts are kept."],
    ])("confirms before stopping %i live worker(s)", async (liveCount, message) => {
        cancelRunCommand.mockResolvedValueOnce(undefined);

        confirmCancelRun("channel-1", "run-1", liveCount);

        expect(cancelRunCommand).not.toHaveBeenCalled();
        expect(pushModal).toHaveBeenCalledTimes(1);
        const [displayName, props] = pushModal.mock.calls[0];
        expect(displayName).toBe("ConfirmModal");
        expect(props).toEqual(
            expect.objectContaining({
                title: "Cancel run",
                message,
                confirmLabel: "Cancel run",
                cancelLabel: "Keep running",
                destructive: true,
            })
        );

        props.onConfirm();
        await vi.waitFor(() => expect(cancelRunCommand).toHaveBeenCalledTimes(1));
    });
});
```

- [ ] **Step 2: Run the new run-action tests**

Run:

```powershell
npx vitest run frontend/app/view/agents/runactions.test.ts
```

Expected: PASS. This is characterization coverage for already-shipped behavior; no production edit is required.

- [ ] **Step 3: Prove the branch assertion is effective**

Temporarily change `if (liveCount <= 0)` in `runactions.ts` to `if (liveCount < 0)`, run:

```powershell
npx vitest run frontend/app/view/agents/runactions.test.ts -t "cancels directly"
```

Expected: FAIL because a modal opens and the cancellation RPC is not called directly. Immediately restore `<= 0`, rerun the command, and expect PASS. Do not leave the mutation in the working tree.

- [ ] **Step 4: Prove the cleanup assertion is effective**

Temporarily remove `next.delete(runId)` from `cancelRun`'s `finally`, run:

```powershell
npx vitest run frontend/app/view/agents/runactions.test.ts -t "removes the in-flight id when cancellation rejects"
```

Expected: FAIL because `cancellingRunIdsAtom` still contains `run-1`. Restore the deletion immediately and rerun the test to PASS.

### Task 2: Cover cwd fallback orchestration

**Files:**
- Create: `frontend/app/view/agents/agentcwdresolve.test.ts`
- Read only: `frontend/app/view/agents/agentcwdresolve.ts`

**Interfaces:**
- Consumes: `resolveCwd(transcriptPath, blockId)` from `agentcwdresolve.ts`.
- Produces: regression coverage for block → tail → head precedence and the external-error boundary.

- [ ] **Step 1: Create the cwd resolver test file**

Create `frontend/app/view/agents/agentcwdresolve.test.ts` with:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAgentTranscriptCommand = vi.fn();
const loadAndPinWaveObject = vi.fn();
const makeORef = vi.fn((otype: string, oid: string) => `${otype}:${oid}`);

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetAgentTranscriptCommand: (...args: any[]) => getAgentTranscriptCommand(...args),
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({
    loadAndPinWaveObject: (...args: any[]) => loadAndPinWaveObject(...args),
    makeORef: (...args: any[]) => makeORef(...args),
}));

import { resolveCwd } from "./agentcwdresolve";

const cwdLines = (cwd: string) => [JSON.stringify({ type: "user", cwd })];

beforeEach(() => {
    getAgentTranscriptCommand.mockReset();
    loadAndPinWaveObject.mockReset();
    makeORef.mockClear();
});

describe("resolveCwd", () => {
    it("uses block cmd:cwd without reading the transcript", async () => {
        loadAndPinWaveObject.mockResolvedValueOnce({ meta: { view: "term", "cmd:cwd": "/block" } });

        await expect(resolveCwd("/transcript.jsonl", "block-1")).resolves.toBe("/block");

        expect(makeORef).toHaveBeenCalledWith("block", "block-1");
        expect(getAgentTranscriptCommand).not.toHaveBeenCalled();
    });

    it("falls through from a missing block cwd to the transcript tail", async () => {
        loadAndPinWaveObject.mockResolvedValueOnce({ meta: { view: "term" } });
        getAgentTranscriptCommand.mockResolvedValueOnce({ lines: cwdLines("/tail") });

        await expect(resolveCwd("/transcript.jsonl", "block-1")).resolves.toBe("/tail");

        expect(getAgentTranscriptCommand).toHaveBeenCalledTimes(1);
        expect(getAgentTranscriptCommand).toHaveBeenCalledWith(expect.anything(), {
            path: "/transcript.jsonl",
            maxlines: 200,
        });
    });

    it("does not read the head when the tail contains a cwd", async () => {
        getAgentTranscriptCommand.mockResolvedValueOnce({ lines: cwdLines("/tail") });

        await expect(resolveCwd("/transcript.jsonl")).resolves.toBe("/tail");

        expect(getAgentTranscriptCommand).toHaveBeenCalledTimes(1);
    });

    it("reads from the start only after a tail miss", async () => {
        getAgentTranscriptCommand
            .mockResolvedValueOnce({ lines: [JSON.stringify({ type: "assistant" })] })
            .mockResolvedValueOnce({
                lines: [JSON.stringify({ type: "session_meta", payload: { cwd: "/head" } })],
            });

        await expect(resolveCwd("/transcript.jsonl")).resolves.toBe("/head");

        expect(getAgentTranscriptCommand.mock.calls).toEqual([
            [expect.anything(), { path: "/transcript.jsonl", maxlines: 200 }],
            [expect.anything(), { path: "/transcript.jsonl", maxlines: 200, fromstart: true }],
        ]);
    });

    it("returns null for missing inputs or boundary failures", async () => {
        await expect(resolveCwd(undefined)).resolves.toBeNull();
        expect(getAgentTranscriptCommand).not.toHaveBeenCalled();

        getAgentTranscriptCommand.mockRejectedValueOnce(new Error("unavailable"));
        await expect(resolveCwd("/transcript.jsonl")).resolves.toBeNull();
    });
});
```

- [ ] **Step 2: Run the cwd resolver tests**

Run:

```powershell
npx vitest run frontend/app/view/agents/agentcwdresolve.test.ts
```

Expected: PASS. This is characterization coverage for existing orchestration.

- [ ] **Step 3: Prove the precedence assertion is effective**

Temporarily remove the early `return fromTail` from the `if (fromTail)` branch in `resolveCwd`, run:

```powershell
npx vitest run frontend/app/view/agents/agentcwdresolve.test.ts -t "does not read the head"
```

Expected: FAIL because the resolver attempts a second transcript read. Restore the return immediately and rerun the test to PASS.

### Task 3: Centralize the session terminal-block rule

**Files:**
- Modify: `frontend/app/view/agents/session-models/sessionviewmodel.ts`
- Modify: `frontend/app/view/agents/session-models/sessionviewmodel.test.ts`
- Modify: `frontend/app/view/agents/session-models/sessionsidebarmodel.ts`

**Interfaces:**
- Produces: `ResolvedSessionBlock`, `SessionTermBlock`, and `findSessionTermBlock(blocks)` from `sessionviewmodel.ts`.
- Consumed by: `sessionSidebarViewModelAtom`, `sessionCwdsAtom`, `findActiveSessionTermBlock`, and `duplicateSession` source resolution.

- [ ] **Step 1: Add failing selector tests**

Add `findSessionTermBlock` to the import from `./sessionviewmodel`, then append:

```ts
describe("findSessionTermBlock", () => {
    const resolved = (blockId: string, meta?: Record<string, any>) => ({
        blockId,
        block: meta == null ? undefined : ({ meta } as Block),
    });

    it("returns the first terminal block with a non-empty cwd", () => {
        const firstMeta = { view: "term" };
        const selectedMeta = { view: "term", "cmd:cwd": "/first", cmd: "claude" };

        expect(
            findSessionTermBlock([
                resolved("preview", { view: "preview", "cmd:cwd": "/ignored" }),
                resolved("missing", firstMeta),
                resolved("term-1", selectedMeta),
                resolved("term-2", { view: "term", "cmd:cwd": "/second" }),
            ])
        ).toEqual({ blockId: "term-1", cwd: "/first", meta: selectedMeta });
    });

    it("returns undefined when no block qualifies", () => {
        expect(
            findSessionTermBlock([
                resolved("missing-block"),
                resolved("preview", { view: "preview", "cmd:cwd": "/ignored" }),
                resolved("term", { view: "term", "cmd:cwd": "" }),
            ])
        ).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the selector tests to verify RED**

Run:

```powershell
npx vitest run frontend/app/view/agents/session-models/sessionviewmodel.test.ts -t "findSessionTermBlock"
```

Expected: FAIL because `findSessionTermBlock` is not exported.

- [ ] **Step 3: Implement the pure selector**

Add near the existing session view-model types in `sessionviewmodel.ts`:

```ts
export interface ResolvedSessionBlock {
    blockId: string;
    block: Block | null | undefined;
}

export interface SessionTermBlock {
    blockId: string;
    cwd: string;
    meta: Record<string, any>;
}

/** Pure: the first terminal block carrying the cwd that defines a session's identity. */
export function findSessionTermBlock(blocks: ResolvedSessionBlock[]): SessionTermBlock | undefined {
    for (const { blockId, block } of blocks) {
        const meta = block?.meta;
        const cwd = meta?.["cmd:cwd"];
        if (meta?.view === "term" && typeof cwd === "string" && cwd.length > 0) {
            return { blockId, cwd, meta };
        }
    }
    return undefined;
}
```

- [ ] **Step 4: Run the selector tests to verify GREEN**

Run:

```powershell
npx vitest run frontend/app/view/agents/session-models/sessionviewmodel.test.ts -t "findSessionTermBlock"
```

Expected: PASS.

- [ ] **Step 5: Add the Wave-object resolution adapter in `sessionsidebarmodel.ts`**

Import `findSessionTermBlock` and `type ResolvedSessionBlock` from `./sessionviewmodel`, then add beside the derived sidebar atom:

```ts
function resolveTabBlocks(
    tab: Tab | null | undefined,
    readBlock: (blockId: string) => Block | null | undefined
): ResolvedSessionBlock[] {
    return (tab?.blockids ?? []).map((blockId) => ({ blockId, block: readBlock(blockId) }));
}
```

This adapter only resolves ids. It must not duplicate the terminal/cwd predicate.

- [ ] **Step 6: Route `sessionSidebarViewModelAtom` through the selector**

Replace its block-selection loop with:

```ts
        const blocks = resolveTabBlocks(tab, (blockId) =>
            get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))
        );
        const termBlock = findSessionTermBlock(blocks);
        const scannedBlocks =
            termBlock == null
                ? blocks
                : blocks.slice(0, blocks.findIndex(({ blockId }) => blockId === termBlock.blockId) + 1);
        // preserve the prior loop's break at the first session terminal
        const isAgentsTab = scannedBlocks.some(({ block }) => block?.meta?.view === "agents");
        const cwd = termBlock?.cwd;
        const termBlockId = termBlock?.blockId;
```

The `scannedBlocks` slice preserves the existing loop's behavior for a mixed tab: blocks after the first qualifying terminal do not affect `isAgentsTab`.

- [ ] **Step 7: Route the other three sites through the selector**

In `sessionCwdsAtom`, replace the nested predicate loop with:

```ts
        const termBlock = findSessionTermBlock(
            resolveTabBlocks(tab, (blockId) =>
                get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))
            )
        );
        if (termBlock != null) {
            cwds.push(termBlock.cwd);
        }
```

In `findActiveSessionTermBlock`, replace its loop with:

```ts
    const termBlock = findSessionTermBlock(
        resolveTabBlocks(tab, (blockId) =>
            globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))
        )
    );
    if (termBlock == null) {
        return undefined;
    }
    return { blockId: termBlock.blockId, cwd: termBlock.cwd };
```

Rename the existing private `findSessionTermBlock(tabId)` wrapper to `resolveSessionTermBlock(tabId)` and replace its body with:

```ts
function resolveSessionTermBlock(tabId: string): SessionTermBlock | undefined {
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    return findSessionTermBlock(
        resolveTabBlocks(tab, (blockId) =>
            globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))
        )
    );
}
```

Also import `type SessionTermBlock` and update `duplicateSession` to call `resolveSessionTermBlock(sourceTabId)`. Do not change `buildDuplicateBlockMeta(source.meta)` or any later launch behavior.

- [ ] **Step 8: Run focused session-model tests and typecheck**

Run:

```powershell
npx vitest run frontend/app/view/agents/session-models/sessionviewmodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: both exit 0.

### Task 4: Final verification and diff review

**Files:**
- Verify only; no new files.

**Interfaces:**
- Consumes: all tests and selector wiring from Tasks 1–3.
- Produces: evidence that the first tranche is complete without unrelated changes.

- [ ] **Step 1: Run the focused Theme 4 tests together**

```powershell
npx vitest run frontend/app/view/agents/runactions.test.ts frontend/app/view/agents/agentcwdresolve.test.ts frontend/app/view/agents/session-models/sessionviewmodel.test.ts
```

Expected: all listed files PASS.

- [ ] **Step 2: Run the full frontend test suite**

```powershell
npx vitest run
```

Expected: exit 0.

- [ ] **Step 3: Run the large-stack TypeScript check**

```powershell
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 4: Self-review the complete diff**

Run:

```powershell
git status --short
git diff --check
git diff -- frontend/app/view/agents/runactions.test.ts frontend/app/view/agents/agentcwdresolve.test.ts frontend/app/view/agents/session-models/sessionviewmodel.ts frontend/app/view/agents/session-models/sessionviewmodel.test.ts frontend/app/view/agents/session-models/sessionsidebarmodel.ts docs/superpowers/specs/2026-07-17-theme4-maintainability-testgaps-first-tranche-design.md docs/superpowers/plans/2026-07-17-theme4-maintainability-testgaps-first-tranche.md
```

Expected: only the approved Theme 4 spec, plan, two new test files, and three session/run/cwd files are present; `git diff --check` is clean; no debug statements, commented-out code, mutation-test edits, generated changes, or unrelated formatting remain. Do not stage or commit.

---

## Addendum: Task 5 — item #2 (Jarvis test gaps), folded in 2026-07-17

Theme 3 A1 (atomic ask-claim) landed on main (`dac43d1b`) during this session, satisfying the gate the spec
named for `watcher.go`. Item #2 was executed in the same tranche.

**Files:**
- Modify: `pkg/jarvis/watcher.go` (extract two pure predicates from `handleAsk`, behavior-preserving)
- Create: `pkg/jarvis/watcher_test.go`, `pkg/jarvis/onexit_test.go`

- [x] **Step 1: Extract the pre-filter and bounds guard.** Added `askAutoAnswerable(questions)` (exactly one
  single-select question) and `optionIndexInRange(idx, q)` (`0 <= idx < len(Options)`); rewired the two inline
  conditions in `handleAsk` to call them. No behavior change.
- [x] **Step 2: Test both predicates** in `watcher_test.go` (single/multi/zero questions; in-range, one-past,
  negative, empty options).
- [x] **Step 3: Test `outcomeSummary`** in `onexit_test.go` (last-event-text wins; falls back to task when no
  events or last text empty; truncates to 160).
- [x] **Step 4: Verify.** `go test ./pkg/jarvis/` green; `go vet ./pkg/jarvis/` clean. Mutation checks: flip the
  pre-filter (allow multi-select), the bounds guard (`<=`), and the truncation (raise the cap) each turn the
  matching case red; all restored.

Still deferred: #4 (`runbody.tsx` card-family split) and #5 (`agentsviewmodel.ts` grid extract) — pending the
active Theme 2 streaming work that edits those files.
