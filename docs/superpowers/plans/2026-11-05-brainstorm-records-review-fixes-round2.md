# Brainstorm pane, run records review fixes: open-issue round

> **For agentic workers:** each task below runs as one engine worker. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-11-05-brainstorm-records-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wavevault ./pkg/jarvisdossier ./pkg/jarvisattrib ./pkg/wshrpc/...`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-mode brainstorm-main brainstorm-check-review brainstorm-builder-check brainstorm-run-landed brief-peek record-band-detach-restore`

**Goal:** Close three gaps the run's tasks reported in the features they built: an anchored decision link misses a
decision added after the record was cached (F4); a detached row on the band shows the record's whole objective and no
ticket, unlike the band's other rows (F7); and `confirmDossierStatus` keeps a third copy of the status-confirm
wording that `statusConfirmCopy` was made to own (F14).

**Architecture:** An anchored open reads the record fresh instead of trusting the cache. The detached-edge RPC builds
its task with the same helper as `buildAmbient`, so label and ticket follow one rule, and the band draws the ticket
with one shared chip. `confirmDossierStatus` takes its words from `statusConfirmCopy`.

**Tech Stack:** Go (wavesrv), React 19 + jotai, vitest, CDP scenarios.

## Global Constraints

- Logic in pure model files or Go functions with tests beside them; `.tsx` only renders.
- Only existing `@theme` tokens; no new token and no raw color.
- Run lint and format only on the paths you touched. Never run prettier on `scripts/*.mjs`.
- Never attach to or kill the dev app on :9222. A snapshot review app runs there.

## Review Focus

- An anchored open must not loop or refetch on every render: one fresh read per open.
- An unanchored open keeps the cache guard (no extra RPC per peek open).
- A detached row for a record with no objective still has a label (the ticket, else the id).

---

### Task 1: An anchored record open reads the record fresh (F4)
**Depends on:** none
**Files:** `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `scripts/cdp/scenarios-brief.mjs`

**Interfaces:**
- Consumes: `reloadRecordDetail(dossierId): Promise<void>` and `loadRecordDetail(dossierId): void` from
  `jarvissubjectstore.ts`.

Cause: `selectRecord` → `openRecordPeek` (`openref.ts:560-573`) calls `loadRecordDetail`, which returns early when
`recordDetailAtom` already holds the record. A decision an agent appended since (through `wsh` or an RPC) is then
missing, so the peek neither opens its log nor flashes the decision.

- [ ] **Step 1: Write the failing test** in `openref.test.ts`, beside "opens a decision's record in the peek with the
  decision anchored": with `recordDetailAtom` already holding `task-a` (no decisions), `openAddress(model, "task:task-a",
  { sourceType: "decision", anchor: "dec-1" })` calls `GetDossierCommand` for `task-a` once. A second test: the same
  open with no anchor and a cached detail calls `GetDossierCommand` zero times.
- [ ] **Step 2:** `npx vitest run frontend/app/view/jarvis/openref.test.ts` fails on the first test.
- [ ] **Step 3: Implement.** `openRecordPeek(dossierId: string, fresh: boolean)`: `fresh` →
  `fireAndForget(() => reloadRecordDetail(dossierId))`, else `loadRecordDetail(dossierId)`. `selectRecord` passes
  `target.anchor != null`. Keep the existing comment's point that detail loads before the surface flips.
- [ ] **Step 4:** the openref tests pass.
- [ ] **Step 5: Scenario.** In `brief-peek`, add a step: with the record already opened once (detail cached), append a
  decision to it by RPC, then open that decision's address with its anchor (the same path the existing F4 anchor step
  uses). The step passes when the peek's decision log is open and contains the new decision's card. Screenshot it.
  Drop the arrange-time workaround the earlier anchor step used only if that step still passes without it; otherwise
  leave it.
- [ ] **Step 6:** `node scripts/cdp/final-verify.mjs brief-peek` passes every step (set `ARC_FINAL_OUT` to a temp dir).
- [ ] **Step 7: Commit** `fix(jarvis): an anchored record open reads the record fresh`, with a body giving the cause.

### Task 2: Detached rows label like the band; one confirm wording (F7, F14)
**Depends on:** Task 1
**Files:** `pkg/wshrpc/wshserver/wshserver_jarvis.go`, `pkg/wshrpc/wshserver/wshserver_ambient_test.go`, `frontend/app/view/jarvis/recordactions.ts`, `frontend/app/view/jarvis/recordactions.test.ts`, `frontend/app/view/jarvis/recordbandview.tsx`, `frontend/app/view/jarvis/recordpicker.tsx`, `scripts/cdp/scenarios-brief.mjs`

**Interfaces:**
- Consumes: `ambientLabel(d wshrpc.SpaceSummary) string` (`wshserver_jarvis.go:790`), `statusConfirmCopy(status):
  {title, body}` from `briefpeek.ts`.
- Produces: `ambientTask(d wshrpc.SpaceSummary) wshrpc.AmbientTask`; `DetachedEdge.ticket?: string`;
  `TicketChip({ ticket }: { ticket?: string })` exported from `recordpicker.tsx`.

Cause: `ListDetachedEdgesCommand` (`wshserver_jarvis.go:494-530`) sets `Label` to the whole objective and no `Ticket`,
while `buildAmbient` uses `ambientLabel` and sets `Ticket`.

- [ ] **Step 1: Write the failing Go test** `TestAmbientTaskLabelAndTicket` in `wshserver_ambient_test.go`, beside
  `TestAmbientLabelObjectiveAndTicket`: `ambientTask(SpaceSummary{Id: "d1", Objective: "first line\nsecond", Ticket:
  "PROJ-142"})` equals `AmbientTask{Id: "d1", Label: "first line", Ticket: "PROJ-142"}`; with an empty objective the
  label is `"PROJ-142"`; with neither, the label is `"d1"`.
- [ ] **Step 2:** `go test ./pkg/wshrpc/wshserver -run '^TestAmbientTaskLabelAndTicket$'` fails (undefined).
- [ ] **Step 3: Implement** `ambientTask` (the id when `ambientLabel` gives ""), use it in `buildAmbient`, and in
  `ListDetachedEdgesCommand` build the task from the loaded dossier's `SpaceSummary{Id, Objective, Ticket}`; when
  `LoadDossier` fails, keep today's id-only task. The test passes.
- [ ] **Step 4: Frontend, failing test first** in `recordactions.test.ts`: `loadDetachedEdges` copies each task's
  `ticket` onto its rows; and, with `@/app/store/modalmodel` mocked, `confirmDossierStatus("d1", "archived")` pushes a
  `ConfirmModal` whose `title` and `message` equal `statusConfirmCopy("archived").title` / `.body`.
- [ ] **Step 5: Implement.** `DetachedEdge.ticket?: string`, filled from the task in `loadDetachedEdges`.
  `confirmDossierStatus` takes `title` and `message` from `statusConfirmCopy(status)`; `confirmLabel` and
  `destructive` stay. Export `TicketChip` from `recordpicker.tsx` (the picker's existing ticket span, `null` when no
  ticket), and use it in the picker, in `EdgeChip` (keeping `data-jarvis-edge-ticket` on it via a prop or wrapper),
  and on the detached row after its label. The vitest file passes.
- [ ] **Step 6: Scenario.** In `record-band-detach-restore`, extend step 2 ("Not this record moves the edge to a
  Detached row that offers Restore"): the Detached row's text is `Detached · ` plus the record objective's first line
  only, and it carries the record's ticket chip. Seed the record with a two-line objective and a ticket if the
  scenario's record lacks either.
- [ ] **Step 7:** `node scripts/cdp/final-verify.mjs record-band-detach-restore brief-peek` passes every step.
- [ ] **Step 8: Commit** `fix(jarvis): detached rows label like the band; one confirm wording`.
