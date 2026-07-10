# Design — Plan preview in the Runs review gate

**One line:** When a run pauses at a review gate, show the actual plan
document inline in the gate card so you can read what you're approving —
instead of just its filename.

Status: design + implementation plan (combined; trivial scope). Implemented in
the same commit; the rendered gate is CDP-unverified (dev app was down).

---

## Problem

At a pipeline run's review gate you decide **approve / send back** before
execution starts. Today `ReviewGateCard` (`runssurface.tsx`) shows only the
plan **artifact's filename** (`gatePhase.artifacts[0]`) — a bare
`docs/…/plan.md` string. To actually read the plan you must leave Runs and
open the file elsewhere. The comp (`Wave-runs.dc.html`, Turn 2) shows a plan
step list in the gate; the app never surfaced the content.

The backing data exists and is real:
- `RunPhase.artifacts` are **project-relative file paths**, reported in on
  phase completion (`pkg/jarvis/run.go` `CompletePhase`), e.g. `docs/spec.md`.
- `Run.projectpath` is the absolute project root.
- The FE can read any local file via `FileReadCommand` and already does so
  elsewhere (`waveconfig-model.ts:307`).

So we can render the plan itself with **no fabrication and no new backend**.

## Approach (chosen: A — document preview)

Render the plan artifact's **markdown as-is** in a collapsible, scroll-capped
panel inside the gate. Rejected alternatives:

- **B — parse into a step list** (match the comp's bullets): step extraction
  is format-dependent and misfires on plans that don't follow a heading
  convention → fabrication risk. The comp's tidy list is a stylization.
- **C — outline + expand**: carries B's parsing fragility for the outline;
  most code for least additional value.

A is the only option with **zero fabrication risk**, and for a "should I
approve this plan?" decision the real document beats a lossy summary. It
reuses the existing markdown renderer, so it's also the least code.

## Design

**Placement.** A new preview section inside `ReviewGateCard`, between the
gate header row and the Approve / Send-back button row. Open by default (the
plan is the thing being approved), body scroll-capped at ~320px, with a
collapse toggle to reclaim height. Styling stays within the card's existing
`asking`-toned tokens (`border-asking/20`, `bg-lane-asking`); no raw hex.

**Renderer.** `MarkdownMessage` (`markdownmessage.tsx`, react-markdown +
remark-gfm) — already used by the transcript feed, chat replies, and the
memory viewer. No new dependency.

**Data flow.**
1. Pick the plan artifact: the gated phase's first artifact
   (`gatePhase.artifacts?.[0]`). One plan file per plan phase in practice.
2. Resolve the absolute path via a pure helper
   `resolveArtifactPath(projectPath, artifact)`:
   - artifact already absolute (`/…` or Windows `X:\…` / `X:/…`) → return as-is;
   - else join `projectPath` + `/` + artifact, normalizing separators so a
     Windows `projectPath` + POSIX-relative artifact still forms one path.
3. `RpcApi.FileReadCommand(TabRpcClient, { info: { path } })` →
   `base64ToString(fileData.data64)` (the `waveconfig-model.ts:307` pattern).
4. Render the decoded text with `<MarkdownMessage/>`.

**States — never fabricate, never block the decision.**
| Condition | Render |
|---|---|
| Phase has no artifact | No preview section at all; gate looks exactly as today. |
| Read in flight | Muted "Loading plan…". |
| Read error / empty file | Subtle muted line "Couldn't read plan · {filename}". Approve / Send-back stay fully enabled. |
| Loaded | Collapsible markdown preview. |

The preview is strictly informational: a failure to read it must never
disable or hide the gate's actions.

**Component shape.** A small `PlanPreview({ path }: { path: string })`
co-located in `runssurface.tsx` next to `ReviewGateCard`. Local
`useState<{ status: "loading" | "error" | "ok"; text: string }>` + a
`useEffect` keyed on `path` that fetches once on mount (fetch-eager: only one
gate is ever live, so it's a single read). `ReviewGateCard` computes the
resolved path and renders `<PlanPreview/>` only when an artifact exists.

## Scope guard

Read-only observability, consistent with the live-visibility feature it
extends. **No** engine change, **no** plan editing, **no** write path. The
disabled "Edit plan" button stays a separate future piece. Orchestrator runs
gate on a *held running* phase that may have no artifact yet — the no-artifact
state covers that (no preview, gate unchanged).

## Testing

- **Unit (Vitest):** `resolveArtifactPath` in `runmodel.test.ts` — absolute
  POSIX passthrough, absolute Windows passthrough, relative join, and
  separator normalization. This is the only logic with a deterministic
  contract; keep it pure and out of the component.
- **No jsdom harness** exists for these views (per CLAUDE.md). The fetch +
  markdown render is verified **visually over CDP** on the dev app (populated
  gate → readable plan; missing-file → subtle error, buttons still work).
  This is an explicit manual gate, not skipped silently.

## Implementation

1. **`runmodel.ts`** — add and export pure `resolveArtifactPath(projectPath,
   artifact)`. No React/jotai (matches the file's existing constraint).
2. **`runmodel.test.ts`** — add the 4 cases above.
3. **`runssurface.tsx`**
   - imports: `RpcApi` (`@/app/store/wshclientapi`), `TabRpcClient`
     (`@/app/store/wshrpcutil`), `base64ToString` (`@/util/util`),
     `MarkdownMessage` (`./markdownmessage`), `resolveArtifactPath`
     (`./runmodel`).
   - add `PlanPreview({ path })` with the load state machine above.
   - in `ReviewGateCard`, compute `artifact = gatePhase.artifacts?.[0]`; when
     present, render `<PlanPreview path={resolveArtifactPath(run.projectpath,
     artifact)} />` in the new section. Keep the filename in the header.
4. **Verify:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js
   --noEmit` (exit 0), `npx vitest run …/runmodel.test.ts`, then CDP visual
   check on a populated gate.

This spec folds into the implementing commit (per repo git convention);
it is not committed on its own.
