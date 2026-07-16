# Cockpit Coherence Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one prioritized map (`docs/agents/cockpit-coherence-audit.md`) scoring every navigable cockpit surface against a fixed canon on five coherence dimensions, so the next fix pass is chosen from evidence.

**Architecture:** Fix the canon and doc skeleton once (Task 1), sweep each surface independently against that canon (Tasks 2–10, a natural fan-out), then synthesize the per-surface scorecards into a conformance grid + priority-sorted backlog + fix sequencing (Task 11), and verify provenance (Task 12). Read-only analysis — no product code is modified.

**Tech Stack:** Markdown output only. Read tools (Read/Grep/Glob) over `frontend/app/view/agents/*` and `frontend/app/element/*`. No build, no tests to add.

## Global Constraints

- **Read-only.** No file under `frontend/`, `pkg/`, `src-tauri/`, `cmd/` is modified. The only artifact created is `docs/agents/cockpit-coherence-audit.md`.
- **Every score and finding cites `file:line` evidence.** No impressionistic claims. A cell with no citation is incomplete.
- **N/A ≠ Diverges.** A dimension that structurally does not apply to a surface (e.g. a page header on the full-bleed agent TUI) is scored `N/A`, not `Diverges`.
- **Canon is grounded in existing references, not invented.** Interaction canon = `frontend/app/view/agents/usecockpitkeyboard.ts`. Chrome/state canon = `frontend/app/view/agents/surfacescaffold.tsx` (`SurfaceHeader`, `SurfaceEmptyState`, `SurfaceError`, `SURFACE_ROOT`) + `Skeleton` (`frontend/app/element/skeleton.tsx`). Motion canon = `frontend/app/element/motiontokens.ts`. Where no canon exists, record the gap; do not decide what canon should be.
- **Five dimensions, fixed:** interaction/keyboard, chrome/tokens, state coverage, motion, primitive reuse.
- **Rubric:** conformance ∈ {Conforms, Partial, Diverges, N/A}; severity ∈ {High, Med, Low}; effort ∈ {S, M, L}.
- **Commits:** batch into a single commit at the end; hold for explicit user approval (project git workflow). No per-task commits. The audit doc folds into the same commit as the design + plan.

---

### Task 1: Canon, rubric, and doc skeleton

**Files:**
- Create: `docs/agents/cockpit-coherence-audit.md`
- Read (canon references): `frontend/app/view/agents/usecockpitkeyboard.ts`, `frontend/app/view/agents/surfacescaffold.tsx`, `frontend/app/element/motiontokens.ts`, `frontend/app/element/skeleton.tsx`, `frontend/app/element/errorboundary.tsx`, `frontend/app/view/agents/sectionheader.tsx`, `frontend/app/view/agents/statusdot.tsx`, `frontend/app/store/keymodel.ts`

**Interfaces:**
- Produces: the audit doc with (a) the **Canon per dimension** section filled, (b) an empty **Conformance grid**, (c) an empty **Findings backlog**, (d) an empty **Recommended sequencing**, and (e) one empty **scorecard stub** per surface. The scorecard stub is the shared template every later task fills. Its exact shape:

```markdown
#### <surface>

| Dimension | Score | Note | Evidence |
|---|---|---|---|
| Interaction/keyboard | | | |
| Chrome/tokens | | | (ink-* count: ) |
| State coverage | | | loading / empty / error |
| Motion | | | |
| Primitive reuse | | | |

**Findings:**
- (none yet)
```

- [ ] **Step 1: Read the canon references**

Read each file in the "Files → Read" list above. For interaction, extract the exact key contract from `usecockpitkeyboard.ts` (nav keys, surface-switch keys, action letters, typing-guard). For chrome/state, extract the exact canonical classes/components from `surfacescaffold.tsx`. For motion, list the exported variants in `motiontokens.ts`. For primitive reuse, note the shared primitives (`SectionHeader`, `statusdot.tsx`, and any shared row/badge).

- [ ] **Step 2: Write the doc skeleton**

Create `docs/agents/cockpit-coherence-audit.md` with this structure (fill the Canon section from Step 1; leave grid/backlog/sequencing as empty headed sections; add one scorecard stub per surface using the template in Interfaces):

```markdown
# Cockpit Coherence Audit

> Generated per docs/superpowers/specs/2026-07-16-cockpit-coherence-audit-design.md.
> Read-only conformance audit of the navigable cockpit surfaces on five coherence dimensions.

## 1. Canon per dimension
### Interaction / keyboard — canon: usecockpitkeyboard.ts
...verbatim contract + file refs...
### Chrome / tokens — canon: surfacescaffold.tsx
...
### State coverage — canon: Skeleton + *LoadedAtom / SurfaceEmptyState / SurfaceError
...
### Motion — canon: motiontokens.ts
...
### Primitive reuse — canon: shared row/badge/section-header/status-dot primitives
...

## 2. Conformance grid
_(assembled in synthesis)_

## 3. Findings backlog
_(assembled in synthesis)_

## 4. Recommended sequencing
_(assembled in synthesis)_

## Appendix: per-surface scorecards
#### cockpit
...stub...
#### agent
...stub...
#### channels
...stub...
#### sessions
...stub...
#### files
...stub...
#### memory
...stub...
#### usage
...stub...
#### radar
...stub...
#### settings
...stub...
#### placeholder
...stub...
```

- [ ] **Step 3: Verify canon is grounded**

Confirm every claim in the Canon section cites a real `file:line` from the reference files. Where a dimension has no existing shared reference (record it explicitly as "no canon — gap"), do not invent one.

- [ ] **Step 4: Deliverable check**

The doc exists with the Canon section complete and 10 empty scorecard stubs present. No product code touched.

---

### Task 2: Sweep — cockpit surface

**Files (read):** `frontend/app/view/agents/cockpitsurface.tsx`, `usecockpitkeyboard.ts`, `cockpitemptystate.tsx`, `cockpithelp.tsx`, `agentrow.tsx`, `pendingband.tsx`, `sectionheader.tsx`, `statusdot.tsx`

**Interfaces:**
- Consumes: the canon + scorecard stub from Task 1.
- Produces: the filled `#### cockpit` scorecard (5 rows scored + evidence) and its findings.

- [ ] **Step 1: Score each dimension**

For cockpit, evaluate all five dimensions against Task 1's canon. Cockpit is the interaction reference, so it should be `Conforms` there — confirm and cite. For chrome, confirm `SurfaceHeader`/`SURFACE_ROOT` adoption and count `ink-*` usages in its subtree (`grep -rn "ink-hi\|ink-mid\|ink-faint"` over the read files). For state/motion/primitive, score with evidence.

- [ ] **Step 2: Fill the scorecard**

Write Conforms/Partial/Diverges/N/A + one-line note + `file:line` into the `#### cockpit` table. Add one `**Findings**` bullet per Partial/Diverges cell: `dimension · severity · effort · file:line · proposed canonical fix`.

- [ ] **Step 3: Provenance self-check**

Open two cited `file:line` locations and confirm they say what the score claims. Every non-N/A cell has a citation.

---

### Task 3: Sweep — agent surface (full-bleed TUI)

**Files (read):** `frontend/app/view/agents/agentsurface.tsx`, `agentlaunchhero.tsx`, `agentcomposer.tsx`, `composer-shell.tsx`, `subagentinterior.tsx`, `livetranscript.ts`, `markdownmessage.tsx`

**Interfaces:**
- Consumes: canon + stub from Task 1.
- Produces: filled `#### agent` scorecard + findings.

- [ ] **Step 1: Score each dimension**

Structurally different (full-bleed transcript, no page header). Score `N/A` where the chrome header genuinely does not apply — but still score `bg-background`/container conformance, and score interaction (does the transcript honor `Esc`/nav/typing-guard consistent with canon?), state (launch hero as empty state), motion, primitive reuse. N/A ≠ Diverges.

- [ ] **Step 2: Fill the scorecard** — as Task 2 Step 2, for `#### agent`.

- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3.

---

### Task 4: Sweep — channels surface (2-pane)

**Files (read):** `frontend/app/view/agents/channelssurface.tsx`, `channelchrome.tsx`, `channelrail.tsx`, `channelcomposers.tsx`, `channelcontextpanel.tsx`, `channelsprimitives.tsx`, `channelsstore.ts`

**Interfaces:**
- Consumes: canon + stub from Task 1.
- Produces: filled `#### channels` scorecard + findings.

- [ ] **Step 1: Score each dimension**

2-pane (rail + workspace). Score the per-channel `ChannelHeader` against canon (partial-migration surface — expect Partial on chrome). Interaction: the rail has its own keydown (`channelrail.tsx`) — compare to the cockpit contract (does `j/k`, `[`/`]` work here?). State: does it use the `Skeleton` gate / `SurfaceEmptyState` / `SurfaceError`? Motion + primitive reuse (does `channelsprimitives.tsx` duplicate shared primitives?).

- [ ] **Step 2: Fill the scorecard** — for `#### channels`.

- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3.

---

### Task 5: Sweep — sessions surface

**Files (read):** `frontend/app/view/agents/sessionssurface.tsx`, `session-models/sessionviewmodel.ts`, `session-models/sessionsidebarmodel.ts`, `recentsessionsstore.ts`, `sessionsarchivestore.ts`

**Interfaces:**
- Consumes: canon + stub from Task 1. Produces: filled `#### sessions` scorecard + findings.

- [ ] **Step 1: Score each dimension** — evaluate all five against canon; note whether the `Skeleton` gate + `SurfaceError` were adopted (the chrome scaffold said sessions should "adopt Skeleton gate / add SurfaceError" — verify it actually happened). Interaction: does sessions honor `j/k` nav and `[`/`]`?
- [ ] **Step 2: Fill the scorecard** — for `#### sessions`.
- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3.

---

### Task 6: Sweep — files surface (2-pane)

**Files (read):** `frontend/app/view/agents/filessurface.tsx`, `filesstore.ts`, `filesmotion.ts`

**Interfaces:**
- Consumes: canon + stub from Task 1. Produces: filled `#### files` scorecard + findings.

- [ ] **Step 1: Score each dimension** — 2-pane, partial-migration. Header lives in the sidebar (score `N/A` for page header if so). Note `ink-*` usage (files was a primary `ink-*` user). State: keeps its own skeletons — do they match canon? Interaction, motion (`filesmotion.ts` vs `motiontokens.ts`), primitive reuse.
- [ ] **Step 2: Fill the scorecard** — for `#### files`.
- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3.

---

### Task 7: Sweep — memory surface

**Files (read):** `frontend/app/view/agents/memorysurface.tsx`, `memgraph.tsx`, `memgraphlayout.ts`, `newmemorymodal.tsx`, `memtypes.ts`

**Interfaces:**
- Consumes: canon + stub from Task 1. Produces: filled `#### memory` scorecard + findings.

- [ ] **Step 1: Score each dimension** — list + graph views. Note `ink-*` usage (memory was a primary `ink-*` user). Interaction: graph nav (`memgraph.tsx`) vs canon nav. State: `SurfaceEmptyState`/`SurfaceError` adoption. Motion, primitive reuse.
- [ ] **Step 2: Fill the scorecard** — for `#### memory`.
- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3.

---

### Task 8: Sweep — usage surface

**Files (read):** `frontend/app/view/agents/usagesurface.tsx`, `usagestore.ts`, `tokenusagesection.tsx`, `weeklyforecast.ts`, `ratelimitstore.ts`

**Interfaces:**
- Consumes: canon + stub from Task 1. Produces: filled `#### usage` scorecard + findings.

- [ ] **Step 1: Score each dimension** — usage is the state/error reference impl (`usageErrorAtom`) — confirm it `Conforms` on state and cite. Interaction (mostly non-navigable — score `N/A`/`Partial` honestly), chrome, motion, primitive reuse.
- [ ] **Step 2: Fill the scorecard** — for `#### usage`.
- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3.

---

### Task 9: Sweep — radar surface

**Files (read):** `frontend/app/view/agents/radarsurface.tsx`, `radarstore.ts`, `reviewsurface.tsx`, `runcompletionsurface.tsx`

**Interfaces:**
- Consumes: canon + stub from Task 1. Produces: filled `#### radar` scorecard + findings (note review/runcompletion where a dimension applies).

- [ ] **Step 1: Score each dimension** — radar keeps `RadarScanStatePanel` (score state accordingly); confirm `SurfaceError` was added (scaffold said to). Interaction, chrome (`text-2xl` → canonical — verify migrated), motion, primitive reuse. Note reviewsurface's ad-hoc `"Loading…"` if still present.
- [ ] **Step 2: Fill the scorecard** — for `#### radar`.
- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3.

---

### Task 10: Sweep — settings + placeholder surfaces

**Files (read):** `frontend/app/view/agents/settingssurface.tsx`, `profilepanel.tsx`, `profilemodel.ts`, `placeholdersurface.tsx`

**Interfaces:**
- Consumes: canon + stub from Task 1. Produces: filled `#### settings` and `#### placeholder` scorecards + findings.

- [ ] **Step 1: Score each dimension for both** — settings: static form (state `N/A` for loading; keep field validation as its error model). Confirm header migrated (26px/extrabold → canonical). placeholder: should now BE a `SurfaceEmptyState` — confirm. Score interaction/chrome/motion/primitive for each.
- [ ] **Step 2: Fill both scorecards** — `#### settings` and `#### placeholder`.
- [ ] **Step 3: Provenance self-check** — as Task 2 Step 3, for both.

---

### Task 11: Synthesis — grid, backlog, sequencing

**Files:**
- Modify: `docs/agents/cockpit-coherence-audit.md` (sections 2, 3, 4)

**Interfaces:**
- Consumes: all 10 filled scorecards (Tasks 2–10).
- Produces: the conformance grid, the priority-sorted findings backlog, and the recommended fix sequencing.

- [ ] **Step 1: Build the conformance grid (section 2)**

A table: rows = the 10 surfaces, columns = the 5 dimensions, each cell = the scorecard's score (Conforms/Partial/Diverges/N/A). One glanceable grid.

- [ ] **Step 2: Consolidate the backlog (section 3)**

Collect every finding from every scorecard into one list. Each row: `surface · dimension · severity · effort · file:line · proposed canonical fix`. Sort by priority (High severity + low effort first). Deduplicate findings that are the same root divergence across surfaces (e.g. "no `j/k` nav" on N surfaces → one finding naming all N).

- [ ] **Step 3: Write recommended sequencing (section 4)**

Group the backlog into a small number of coherent fix passes (a divergence and its fix rarely stand alone — e.g. "interaction-parity pass," "`ink-*` deprecation pass," "state-coverage completion pass"). Order the passes by leverage. Every High-severity finding must appear in a pass.

- [ ] **Step 4: Deliverable check** — sections 2–4 are complete and internally consistent with the scorecards.

---

### Task 12: Verify — provenance & internal consistency

**Files:**
- Read: `docs/agents/cockpit-coherence-audit.md` + a sample of cited source locations

**Interfaces:**
- Consumes: the complete audit doc.
- Produces: a short verification note appended to the doc (or corrections applied inline).

- [ ] **Step 1: Provenance spot-check**

Sample ~10 findings across surfaces; open each cited `file:line` and confirm the source says what the finding claims. Fix any citation that doesn't resolve or doesn't match.

- [ ] **Step 2: Consistency checks**

Confirm: (a) every `Diverges`/`Partial` grid cell has at least one backlog finding (no orphan scores); (b) every High-severity finding appears in the recommended sequencing; (c) the grid cells match the per-surface scorecards.

- [ ] **Step 3: Final deliverable**

The audit doc is complete, every finding cites verified evidence, and the sequencing covers all High findings. Present the doc to the user for the fix-pass decision; hold the commit (design + plan + audit) for explicit approval per the git workflow.

---

## Self-Review

**Spec coverage:**
- Approach A (matrix-driven, canon-grounded) → Task 1 fixes canon; Tasks 2–10 score against it; Task 11 builds the matrix. ✓
- Surface set (10 surfaces) → Tasks 2–10 cover all 10 (settings+placeholder share Task 10). ✓
- 5 dimensions → every sweep task scores all five; scorecard template has all five rows. ✓
- Output format (canon → grid → backlog → sequencing, `file:line` evidence) → Task 1 skeleton + Task 11 synthesis. ✓
- Rubric (Conforms/Partial/Diverges/N/A; High/Med/Low; S/M/L) → Global Constraints + every fill step. ✓
- Structurally-different surfaces scored only where applicable (N/A ≠ Diverges) → explicit in Tasks 3, 4, 6, 8, 10 + Global Constraints. ✓
- Verification = provenance + consistency (no build gate) → Task 12. ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases." The scorecard template and doc skeleton are given as literal content; each surface task lists exact files and exact dimension hints. ✓

**Type consistency:** The scorecard template (5 rows: Interaction/keyboard, Chrome/tokens, State coverage, Motion, Primitive reuse) is identical in Task 1's Interfaces and referenced by every sweep; the finding shape (`surface · dimension · severity · effort · file:line · proposed fix`) is identical in Task 2 Step 2 and Task 11 Step 2. ✓
