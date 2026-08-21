# Orchestrator Draft Review — Structured Planning and Fast Approval

Date: 2026-08-21. Status: conversational design approved; awaiting written review.

Related:

- `docs/superpowers/specs/2026-08-20-route-chain-and-dag-modal-design.md`
- `docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md`
- `docs/superpowers/specs/2026-07-05-channels-runs-orchestrator-mode-design.md`

This spec narrows and supersedes the unfinished label-only draft-review portion of the 2026-08-20
route-chain/DAG-modal design. Its route authority, inheritance, deferred Run creation, DAG persistence,
scheduling, live modal, and launch cleanup decisions remain authoritative.

## Problem

The route-chain work established the safe creation boundary: an orchestrator submission opens a modal,
and no Run or worker exists until the user launches a valid draft. The current implementation has that
boundary but not a usable completion path:

- the composer can open `DagModalState.kind === "decomposing"`;
- the immutable draft model and live modal shell exist;
- the modal does not yet plan a structured DAG, render a draft review, or launch it;
- the existing planner contract returns only independent subtask labels.

A list of labels is not enough to authorize orchestration. It does not explain execution order,
decision boundaries, gates, or exceptional routes. Making every task and graph control visible by
default would restore control but make approval unnecessarily slow when the generated plan is already
sound.

## Goals

1. Generate a meaningful editable DAG before any Run exists.
2. Make the normal approval path a quick scan plus one explicit Launch action.
3. Surface exceptions without forcing acknowledgement of valid gates or route pins.
4. Keep precise task and dependency editing available without making it the default view.
5. Preserve the existing deferred create → submit → optional cancel transaction.
6. Make planner failure visible and recoverable without blocking a safe manual launch.

## Product decisions

1. **Dedicated planner.** Add `JarvisPlanDagCommand`; do not change
   `JarvisDecomposeCommand`, whose contract remains independent parallel subtasks.
2. **Mid-tier judgment.** Structured DAG planning uses the configured mid-tier headless model. Planning
   quality is not coupled to the proposed Run route.
3. **Bounded draft.** A generated or edited draft contains one to eight tasks.
4. **Exception-first default.** The first editable screen is a compact authorization summary, not the
   full graph editor.
5. **Validation-only launch gate.** Gates and valid task route pins are warnings to notice, not boxes to
   acknowledge. Launch is disabled only when deterministic validation fails.
6. **Focused correction.** Selecting a task or exception opens a task drawer. A full graph editor is a
   secondary view for broad structural changes.
7. **Structured proposal.** The planner proposes labels, descriptions, dependencies, gates, and
   exceptional route pins. Tasks inherit the Run route by default.
8. **Visible fallback.** Invalid planner output or planner execution failure yields an explicitly marked
   one-task draft for the original goal with Retry. RPC transport failure remains an error state.
9. **Draft remains ephemeral.** No draft is persisted. Launch is the only creation boundary.

## Architecture

### Planner command

Add a focused RPC contract:

```go
type CommandJarvisPlanDagData struct {
    ChannelId string           `json:"channelid"`
    Goal      string           `json:"goal"`
    Route     waveobj.RoutePin `json:"route"`
}

type DagPlanDraft struct {
    Title string        `json:"title"`
    Tasks []DagPlanTask `json:"tasks"`
}

type DagPlanTask struct {
    ID          string            `json:"id"`
    Label       string            `json:"label"`
    Description string            `json:"description,omitempty"`
    Deps        []string          `json:"deps,omitempty"`
    Gate        bool              `json:"gate,omitempty"`
    Route       *waveobj.RoutePin `json:"route,omitempty"`
}

type CommandJarvisPlanDagRtnData struct {
    Draft    DagPlanDraft `json:"draft"`
    Fallback bool         `json:"fallback,omitempty"`
    Warnings []string     `json:"warnings,omitempty"`
}
```

These are RPC planning types, not persisted `waveobj.TaskNode` values. Execution fields such as state,
Run ID, attempts, and timestamps cannot appear in a proposal.

The command boundary validates nonblank channel ID and goal, resolves the proposed Run route through
`runroute.Resolve`, and verifies that its harness is available for `OperationRunWorker`. Invalid input
returns an RPC error rather than a fallback plan.

### Capability input

The handler derives the planner's allowed task pins from the same installed run-worker capability data
used by `ListHarnessesCommand`. If reuse requires extracting a helper, that helper remains inside the
backend harness boundary; no second runtime/tier table is introduced.

The handler resolves the channel's effective Jarvis profile through the existing profile seam. The
planner prompt receives:

- goal, channel name, and resolved principles;
- the proposed Run route;
- the exact installed route pins it may suggest;
- a requirement to inherit the Run route unless a task has a concrete reason to differ;
- the one-to-eight task bound and strict JSON schema.

Planning uses `consult.HeadlessSpecForTier(consult.TierMid)`. The model proposes structure. It does not
decide whether its output is safe to display or launch.

### Planner package

Add focused prompt, parse, and validation logic under `pkg/jarvis`. The parser:

1. unmarshals the complete trimmed response as JSON; prose or malformed JSON is invalid;
2. requires one to eight tasks with unique nonblank raw IDs and nonblank labels;
3. requires every dependency to reference a task in the response;
4. rejects self-dependencies and cycles;
5. trims textual fields and removes duplicate dependency entries;
6. canonicalizes valid IDs by array order to `t-1`, `t-2`, and so on, rewriting dependencies through
   the same map;
7. keeps an optional route only when it exactly matches an installed allowed pin and differs from the
   proposed Run route;
8. clears a redundant pin matching the Run route to inheritance without a warning;
9. clears an invalid suggested route to inheritance and adds a task-specific warning;
10. uses the goal as the title when the returned title is blank.

A structurally invalid response is not partially repaired because guessed dependency changes could
alter execution semantics. It becomes the visible fallback instead. Route clearing is allowed because
inheritance is the safe, already-authorized route and the correction is returned as a visible warning.

### Fallback

Planner model lookup failure, model execution error, timeout, or structurally invalid output returns:

```text
Draft.Title = original goal
Draft.Tasks = [{ id: "t-1", label: original goal }]
Fallback = true
Warnings = [specific bounded reason]
```

Warnings are user-facing but must not expose raw model output, command lines, credentials, or unbounded
provider errors. Log full internal context at the backend boundary where appropriate.

An RPC transport failure cannot be converted by the frontend into fallback success. The modal remains
in a decomposing error state with Retry.

## Frontend draft model

Extend `DraftTask` with `description`. The local draft remains the single mutable proposal source:

```ts
type DraftTask = {
    id: string;
    label: string;
    description: string;
    deps: string[];
    gate: boolean;
    route: RoutePin | null;
};

type DagDraft = {
    title: string;
    parallelism: number;
    tasks: DraftTask[];
};
```

The planner response converts once into `DagDraft`. Parallelism defaults to one for a one-task draft
and two otherwise. The user may set an integer from one through eight. Draft validation adds the
eight-task bound while retaining title, label, ID, dependency, cycle, and capability checks.

`toDagSubmitPayload` maps descriptions, dependencies, gates, and optional route pins to `TaskNode`.
It remains the sole frontend conversion into the persisted submit shape.

All draft mutations remain immutable. Rejected mutations return the original object.

## Review interaction

### Modal draft views

A draft state owns a review view and optional selected task without creating parallel draft stores:

```ts
type DagDraftView = "summary" | "graph";

{ kind: "draft";
  request: DagDraftRequest;
  draft: DagDraft;
  fallback: boolean;
  warnings: string[];
  view: DagDraftView;
  selectedTaskId: string | null;
  dirty: boolean;
  error: string; }
```

Planner success initializes `dirty: false`; every accepted user mutation sets it to true. `launching`
carries the same draft, fallback, warning, and dirty values so failure can restore the exact review.
`live` remains identified by channel ID, Run ID, and DAG oref.

The modal reducer remains the transition authority. React components do not construct replacement
states ad hoc.

### Exception-first summary

Summary is the default draft view. A pure projection derives:

- title, proposed Run route, task count, and configured parallelism;
- dependency waves from the DAG;
- gates;
- pinned task routes;
- planner warnings and fallback state;
- deterministic draft validation errors.

The summary shows the execution shape and expands only exceptions. Routine tasks that inherit the Run
route stay collapsed behind **Show all tasks**. **Open graph** switches to the full structural editor.

The primary Launch action stays available when validation returns no errors. Gates, valid pins,
planner warnings, and fallback status do not independently disable it. A fallback is visibly labelled
and remains manually launchable.

### Focused task drawer

Selecting a task or exception opens a drawer over the Summary or Graph view. It edits:

- label and description;
- dependencies, using cycle-safe candidates;
- gate;
- route pin or inheritance;
- task deletion.

The drawer writes through the existing pure draft mutations. Closing it returns to the same review
view. Every edit immediately recomputes Summary; there is no save/apply copy.

The Graph view is for multi-task structural inspection and dependency work. It reads `DagDraft`
directly and opens the same drawer when a node is selected. Dependencies are changed through the
drawer's cycle-safe control; v1 does not add draggable nodes or edge drawing. The draft graph may reuse
`computeLayeredLayout` and presentational node chrome, but it must not coerce a draft into a persisted
`TaskGroup` or write it into WOS. The live `DagGraphView` continues to read only persisted TaskGroups.

### Keyboard and accessibility

- The existing semantic dialog, focus trap, restoration, and launch dismissal guard remain.
- `Ctrl+Enter` or `Cmd+Enter` launches a valid draft from the modal.
- Plain Enter remains owned by the focused field or control.
- Escape closes the drawer first, then the dismissible modal; it does nothing while launching.
- Summary exceptions and tasks use buttons with visible focus treatment, not clickable nonsemantic
  containers.
- Validation changes are announced through an `aria-live` region.
- Status uses a label or icon in addition to color.

## State and data flow

```text
orchestrator composer submit
  → openDagDraft(request)
  → decomposing
      → JarvisPlanDagCommand(channel, goal, proposed route)
      → valid/fallback response
  → summary draft
      ↔ focused task drawer
      ↔ graph editor
  → launching
      → CreateRun(deferstart=true, mode=orchestrator, explicit route)
      → DagSubmit(exact draft payload)
      → live DAG
```

The planning effect has an explicit request identity and one in-flight guard. React StrictMode,
close/reopen, Retry, or a new request cannot apply a stale result. Retry is an explicit action, not an
effect dependency trick.

Retry from a fallback with `dirty: false` may replace it directly. Once any accepted user mutation sets
`dirty: true`, Retry requires confirmation before replacing the draft. Planner success resets dirty to
false; cancelling the confirmation changes nothing.

## Launch transaction

The existing launch transaction remains authoritative:

1. Create a deferred orchestrator Run with the request's explicit runtime and tier.
2. Submit the exact validated draft payload.
3. On success, select the new Run and replace modal state with `live`.
4. On CreateRun failure, preserve the draft and do not submit or cancel.
5. On DagSubmit failure, cancel the deferred Run best-effort and preserve the exact draft.
6. If cancellation also fails, show the created Run ID and cleanup failure.

The modal cannot be dismissed while launching. No planner, Summary, drawer, or Graph action persists a
Run or DAG.

Server CreateRun and DagSubmit validation remains authoritative. Capability changes while a draft is
open therefore fail safely before worker spawn and return the user to the same draft with a contextual
route error.

## Errors and edge cases

- Empty goal or invalid proposed route: reject at the planner command boundary.
- Planner returns no tasks, more than eight tasks, duplicate IDs, unknown dependencies, a cycle, or
  blank labels: visible one-task fallback.
- Planner returns an invalid task pin: clear to inheritance and add a visible task warning.
- Planner returns duplicate dependency IDs: deduplicate without changing dependency meaning.
- Planner title is blank: use the original goal.
- RPC transport fails: decomposing error with Retry; no fallback manufactured client-side.
- User deletes a task: remove every dependency reference to it; reject deletion of the only remaining
  task.
- User attempts a cycle, duplicate dependency, self-dependency, ninth task, deletion of the only task,
  or invalid parallelism: reject the mutation without changing the draft.
- User-selected route becomes unavailable: validation disables Launch; server validation remains the
  final boundary.
- Fallback is edited, then Retry is requested: confirm replacement.
- Modal closes before Launch: no Run or TaskGroup exists.
- Submit fails after deferred creation: best-effort cancellation and contextual cleanup reporting.

## Testing

### Go

- Prompt includes the goal, channel, resolved principles, proposed Run route, exact allowed installed
  pins, schema, and one-to-eight bound; planner lookup uses `consult.TierMid`.
- Valid plan parsing covers descriptions, dependencies, gates, canonical IDs, and valid optional pins.
- Table tests cover malformed JSON, surrounding prose, zero/nine tasks, duplicate/blank IDs, blank
  labels, unknown/self dependencies, cycles, duplicate dependencies, and blank title.
- Route tests prove valid exceptional pins survive, redundant pins matching the Run route clear without
  warning, and invalid pins clear to inheritance with a warning.
- Model lookup failure, execution error, timeout, and invalid structure return the bounded fallback
  without leaking raw output.
- Planner command validates the proposed route and derives only installed run-worker pins.
- Planner command produces no Run, DAG, or worker side effect.
- Existing `ParseDecompose` and `JarvisDecomposeCommand` behavior remains unchanged.

### Frontend unit

- Planner response conversion covers normal and fallback drafts and one-task/two-task parallelism
  defaults.
- Draft model covers description edits, one-to-eight bound, immutable mutations, final-task deletion
  rejection, dependency cleanup, cycle rejection, gates, route pins, and exact submit payload.
- Summary projection covers dependency waves, routine inherited tasks, gates, pins, planner warnings,
  fallback, and validation errors.
- Launch availability proves that only validation errors block; valid gates, pins, warnings, and
  fallback do not.
- Reducer tests cover decomposing success/fallback/failure/retry, Summary/Graph switching, drawer
  selection, launching guard, failure restoration, and live success.
- Stale planner completions and StrictMode do not produce duplicate requests or replace newer state.
- Draft actions set dirty, planner success clears it, and Retry replacement requires confirmation only
  when a fallback is dirty.
- Launch orchestration retains exact create → submit → optional cancel ordering and preserves inputs.

### Build and visual verification

After RPC changes, run `task generate`; generated bindings are never hand-edited. Run targeted Go and
Vitest suites, then:

```bash
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Use `task verify:ui` against a rebuilt app to cover:

- exception-first Summary as the initial draft view;
- a clean valid plan and one-click Launch;
- gate, pinned-route, warning, fallback, and validation-error exceptions;
- focused drawer edits and Summary recomputation;
- Graph view round-trip without losing the draft;
- Retry confirmation after fallback edits;
- keyboard focus, `Ctrl/Cmd+Enter`, Escape ownership, and launch dismissal guard;
- Create failure, submit-plus-cleanup failure, and live transition;
- proof that no Run exists before Launch.

## Non-goals

- Automatic launch or acknowledgement checklists.
- Persisted or resumable drafts.
- Conversational plan revision.
- Live task, dependency, gate, or route mutation.
- Scheduler, retry, escalation, merge, ask-forwarding, or evidence redesign.
- A new runtime/model capability matrix.
- Changes to legacy independent fan-out.
- New dependencies, SCSS, or raw component colors.

## Implementation impact

The already-shipped route authority, settings/channel/run/task inheritance, run-worker launch
enforcement, composer shape/route controls, immutable draft primitives, and Stage-local live modal stay
in place.

The unfinished draft-launch tasks in
`docs/superpowers/plans/2026-08-20-route-chain-and-dag-modal.md` must not be executed verbatim after this
spec is approved. A replacement implementation plan should begin from the current `main`, reuse the
completed seams, add the dedicated planner and exception-first review, then finish live route display
and end-to-end verification without replaying shipped work.
