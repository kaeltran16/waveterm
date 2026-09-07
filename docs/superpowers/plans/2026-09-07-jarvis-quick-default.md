# Jarvis Quick Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default every new top-level launch to the existing single-worker Quick mode while retaining explicit heavier modes.

**Architecture:** The server defaults omitted top-level mode to Quick; child inheritance remains a separate policy. The composer no longer seeds its selection from profiles. Existing RPC and execution types stay unchanged.

**Tech Stack:** Go, React, TypeScript, Vitest.

## Global Constraints

- No classifier, new execution mode, automatic promotion, saved-profile migration, or scheduler changes.
- Preserve validation, draft retention, route selection, principles, evidence, and existing runs.
- No commits without separate approval. Work in the existing checkout, without unnecessary worktrees.

### Task 1: Top-level defaults

**Files:** `pkg/wshrpc/wshserver/wshserver_runs.go`, `pkg/wshrpc/wshserver/wshserver_run_test.go`.

**Interfaces:** `resolveRunPlan` retains its signature; `childRunPlan` preserves profile inheritance and pipeline fallback.

- [ ] Add table tests asserting omitted top-level mode returns `jarvis.RunMode_Quick` and `jarvis.QuickPlaybook()` for empty, pipeline, and orchestrator profiles, even with a requested gate. Assert explicit modes and custom pipeline playbooks remain honored; assert child inheritance is unchanged.
- [ ] Run `go test ./pkg/wshrpc/wshserver -run 'TestResolveRunPlan|TestChildRunPlan'` with the repository CGO include directory; confirm new default tests fail.
- [ ] Replace top-level fallback with `mode = jarvis.RunMode_Quick`. Move the old profile/pipeline fallback into `childRunPlan` before calling `resolveRunPlan`.
- [ ] Run the targeted tests again.

### Task 2: Composer and launch descriptions

**Files:** `frontend/app/view/jarvis/stagecomposer.tsx`, `frontend/app/view/agents/{runactions,composercommand,channelcomposers}.ts*`, their existing tests, `frontend/app/cockpit/{palette-launch,command-palette}.ts*` and existing palette tests.

**Interfaces:** Keep `createRun` and its RPC unchanged. Filter orchestrator-only options at the shared `createRun` boundary using `opts?.mode === "orchestrator"`. The palette no longer needs a resolved strategy argument.

- [ ] Add RPC payload tests: Quick/pipeline/omitted modes discard orchestration and worker-route options; explicit orchestrator preserves them.
- [ ] Update pending-launch footer tests to expect `→ quick run · one worker · no plan gate` regardless of profile. Update palette expectations to describe Quick rather than inherited strategy.
- [ ] Run the three targeted Vitest files and confirm expected failures.
- [ ] Initialize composer shape to `"quick"`; reset it to `"quick"` on channel change and successful launch. Remove `shapeTouched` and profile-driven shape updates. Keep explicit picker callbacks.
- [ ] Use `decision.mode` rather than stale `shape` for orchestration option assembly. Filter these options in `createRun` too, covering other callers.
- [ ] Change @run description to `selected mode · quick by default`; make the pending footer describe Quick. Remove obsolete strategy prefetch/state from the command palette and its pure builder's argument; update callers/tests.
- [ ] Run targeted frontend tests again.

### Task 3: Verify and review

- [ ] Run Go tests for `./pkg/wshrpc/wshserver ./pkg/jarvis ./pkg/orchestrate` with `CGO_CFLAGS=-IC:/Users/kael02/IdeaProjects/waveterm/pkg/jarvisembed/csrc`.
- [ ] Run relevant frontend tests and `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.
- [ ] Inspect `git diff --check` and the full changed diff for unnecessary code, stale copy, and unrelated edits.
- [ ] Attempt the existing live UI verification path for Quick initialization, late profile loading, channel resets, and explicit picker changes; report if unavailable rather than claiming coverage.
- [ ] Report changed behavior, verification, and residual limitations. Do not commit.
