# Jarvis Landing Work Briefing — Design Spec

> **Date:** 2026-08-13
>
> **Status:** Design settled; not implemented.
>
> **Roadmap:** Axis 2 of
> [`2026-08-12-jarvis-improvement-map-meta-design.md`](2026-08-12-jarvis-improvement-map-meta-design.md),
> built on the shipped work ledger in
> [`2026-08-12-jarvis-work-ledger-memory-design.md`](2026-08-12-jarvis-work-ledger-memory-design.md).

## 1. Decision

Jarvis gains a permanent, pinned **Briefing** subject that presents deterministic work state across all
projects:

1. current Wave Runs and direct live agents;
2. changes since the previous successful Briefing load;
3. evidence-sealed work shipped in the last seven days;
4. a conditional link to the canonical Needs You rail; and
5. one stateless, inline **Ask across your work** answer.

Briefing opens automatically on the first neutral Jarvis entry of each Wave launch. It remains pinned for
manual reopening, but it does not steal focus again during that launch. An explicit navigation request for
a Run, record, thread, or Radar draft always wins.

The landing facts are code-derived. A model runs only after the operator explicitly asks a question.

## 2. Why this is the remaining Axis 2 slice

Axis 1 has shipped `pkg/jarvisstate`, `JarvisStateCommand`, and `JarvisAskCommand`. They already expose
active work, shipped evidence, timeline events, a caller-supplied delta window, source health, and a
ledger-aware stateless ask. No frontend consumes either command.

The improvement map's other Axis 2 rows are now stale:

- volunteered knowledge shipped separately;
- attribution correction has backend commands and frontend controls;
- the remaining product gap is delivery: Jarvis has no work-state landing or persisted visit cursor.

The current Jarvis entry behavior restores the last valid subject, or selects the first visible channel and
opens its new-run composer. That is useful focused navigation, but it cannot answer “what is moving?” or
“what happened while I was away?” across projects.

## 3. Goals

- Make work state the predictable first Jarvis view once per Wave launch.
- Keep Briefing directly reopenable without adding a duplicate toolbar or rail action.
- Show current and changed facts without generated narrative or fabricated progress.
- Preserve focused subject navigation after the initial landing.
- Keep Needs You canonical in the existing rail rather than creating a second action list.
- Distinguish a healthy empty result from a source that was not read completely.
- Ensure a failed or partial load cannot consume unseen ledger events.
- Reuse the shipped ledger and ask commands rather than creating a UI-shaped backend API.

## 4. Non-goals

- Durable cross-run workstream progress or milestone percentages.
- Runtime task-plan progress in Briefing.
- Parsing arbitrary Markdown trackers, Jira, GitHub Projects, or repository-specific metrics.
- A model-generated landing summary.
- A dedicated `JarvisBriefingCommand`.
- A durable conversation for a Briefing-wide ask.
- Background polling, unseen badges, or live push while Briefing remains open.
- Space-scoped Briefing content.
- Detached background-agent job records or historical direct-agent session events.
- Replacing the Needs You rail.

Generic cross-project progress is deferred as a separate data-model problem in
[`docs/deferred.md`](../../deferred.md#jarvis-briefing--generic-cross-project-progress-and-durable-milestones-2026-08-13).

## 5. Terminology

- **Briefing:** the synthetic, pinned all-work Jarvis subject.
- **Visit cursor:** the persisted timestamp from which the next Briefing delta is derived.
- **Query start:** the client timestamp captured immediately before requesting work state.
- **Complete response:** an RPC response whose durable Runs and Dossiers legs both report healthy. The
  Dossiers leg includes decisions loaded from the same vault query.
- **Direct agent:** a currently working or asking interactive roster entry that is not an exact worker of a
  Wave Run. This includes a short-lived pending-launch placeholder until the hook-fed row supersedes it.
- **New shipped item:** a seven-day Shipped row whose matching `run-done` event is in the visit delta.

“Work” is not represented as one combined count. Runs and direct agents are different source kinds and
remain separately labelled. **All work** means all projects in Wave's durable Run/record ledger plus the
currently observable interactive agent roster; it does not claim to inventory every external process or
historical agent session.

## 6. Surface contract

### 6.1 Pinned subject

`◈ Briefing` is always the first Subjects row.

- It sits above the Space banner and ordinary grouped subjects.
- Space scope, text filtering, and group collapse never hide it.
- It is the first item in the same keyboard-navigation order used by the rest of Subjects.
- Its subtitle states **All work** so ignoring Space scope is explicit.
- No second Briefing button appears in the Stage header, toolbar, or rail.
- There is no unseen badge in v1 because nothing reads the ledger in the background.

Briefing has the singleton identity:

```ts
{ kind: "briefing", id: "all" }
```

It is a real `SubjectKind` for selection and Stage composition, but it is not a persisted content subject.
Selecting it must not overwrite `jarvis.subject.last`; that key continues to remember the last meaningful
channel, dossier, or conversation.

### 6.2 Automatic entry

A non-persisted launch guard implements the once-per-launch rule:

- On the first **neutral** Jarvis entry, select Briefing and consume the guard.
- Later surface switches preserve the active subject exactly.
- Clicking the pinned row manually selects Briefing at any time.
- A pending Run focus, pending Radar draft, or already selected explicit subject consumes the guard without
  selecting Briefing. There must be no intermediate Briefing flash.
- The guard survives Jarvis surface unmounts but resets when the Wave frontend reloads.

The automatic landing is consumed when navigation is decided, not when data finishes loading. A failed
Briefing load offers Retry; it does not repeatedly pull the operator back on subsequent surface switches.

### 6.3 Stage hierarchy

The Stage renders these sections in order:

1. **Needs You banner** — conditional; only when current attention exists.
2. **Active work** — Wave Runs, blocked records, and unmatched direct live agents.
3. **Since last visit** — deterministic ledger events for the visit window.
4. **Recently shipped · 7 days** — evidence-sealed completed Runs.
5. **Inline all-work answer** — present after an ask, immediately above the composer.

The Stage header names the subject **Work briefing** and its reach **All work**. It also shows the snapshot
time and a **Refresh** action; Refresh uses the same load and cursor rules as reopening Briefing. Briefing has
no channel profile, autonomy control, record band, pipeline, Fleet, grounding section, or graph button: none
has one well-defined all-work target.

The existing Stage rail remains mounted. Briefing's Needs You banner summarizes the current count and opens
the rail; it never copies the actionable rows into the Stage. Because that rail is visible beside Briefing,
its current zero-state copy (`All clear — Jarvis is handling routine asks`) must become the bounded
`No pending asks reported`; a volatile attention source cannot prove an all-clear state.

### 6.4 Row behavior

- A Run row opens its native Run through `openORef`.
- A blocked dossier or dossier event opens its record subject.
- A direct live agent row opens its terminal.
- A source with no real navigation target renders as information, not as a disabled or no-op button.
- Opening a row leaves Briefing and enters the existing scoped subject behavior. Subsequent questions are
  scoped there.

Ledger dossier targets currently use `vault:<id>` while the native router uses `task:<id>`. The Briefing
projection normalizes only dossier/blocker targets to `task:<id>`; it does not make `vault:` a global alias
for every vault collection.

## 7. Information hierarchy and duplication rules

### 7.1 Attention

Current `kind:"attention"` items produce one compact banner. Because attention is server-lifetime and
reported as volatile, absence never becomes “all clear” copy.

A current attention item is removed from Since last visit; the banner is its one representation.

### 7.2 Active work

Active rows are source-explicit:

- **Run** — goal, project, and current Run status;
- **Blocked record** — objective and blockers; a dossier without project identity is labelled **Unscoped
  record**, not assigned to a guessed project;
- **Direct agent** — name/task, runtime, project label when available, and `working` or `asking` state.

Runs sort before direct agents. Within a kind, attention-bearing/blocked states sort before ordinary working
states, then by timestamp descending, then by stable identity. No title or prompt text participates in
identity.

Do not render backend `kind:"session"` rows as current liveness. Their scanner-derived status is historical
and runtime-dependent; §8.2 defines the live source.

### 7.3 Since last visit

Delta events remain timestamp-descending. Their wording follows what the ledger actually retains:

- `run-created` → **Run started**;
- `run-done` → **Run completed**;
- `decision` → **Decision recorded**;
- `dossier` → **Record updated · current status: X**;
- `attention` → represented by the current attention banner when still present.

The ledger does not retain dossier status-transition history. The UI must not say “changed to X.”

### 7.4 Recently shipped

Recently Shipped contains only `Run.Status == "done"` rows with sealed evidence and `CompletedTs` within the
rolling seven-day window. It remains visible after the visit cursor advances.

When a matching `run-done` event is in the current delta:

- mark the Shipped row `New`;
- omit that event from Since last visit.

A completion outside the seven-day Shipped window remains in Since last visit when the cursor is old enough
to include it. This prevents promotion from hiding an older unseen completion.

## 8. Data architecture

### 8.1 One existing ledger query

Every transition into Briefing captures:

```text
queryStartedAt = Date.now()
sevenDaysAgo   = queryStartedAt - 7 days
actualCursor   = validated persisted cursor, else sevenDaysAgo
fetchSince     = min(actualCursor, sevenDaysAgo)
```

It then calls:

```ts
JarvisStateCommand({ project: "", sinceMs: fetchSince })
```

`project:""` is deliberate: Briefing always means all work, even while a Space is active.

`fetchSince` serves both requirements in one request:

- the client filters `Delta` back to `actualCursor`;
- the response still contains the stable seven-day Shipped window when the visit cursor is newer.

`FetchWorkState` currently calls `Shipped(..., 0)` and `Timeline(..., 0)`, so the command returns unbounded
historical lists despite `SinceMs` promising a window. Correct it so nonzero `SinceMs` windows Shipped,
Timeline, and Delta. `0` remains unbounded for existing callers. This is safe for the shipped stateless ask:
it already passes its explicit history window to `FetchWorkState`, and its unwindowed status/history routes
continue to pass `0`.

### 8.2 Current live agents

The session scanner is not a generic liveness or cursor-completeness source:

- Pi's session projection always reports `done` because its stored format has no lifecycle stream;
- other runtimes can retain `waiting` after the process is gone;
- scans are bounded to 30 days / 200 records, so an older visit cursor cannot make them complete; and
- `ActiveWorkItem` carries no session-to-Run identity.

Briefing therefore excludes backend `kind:"session"` rows from both Active work and Since last visit. Past
direct-agent history remains available in the Sessions surface; the Briefing does not relabel a bounded
sample as a complete bring-up window.

For current state, Briefing joins two existing sources in the frontend:

1. `WorkState.Active` for Runs, blockers, and attention;
2. `AgentsViewModel.agentsAtom`, the hook-fed interactive roster already passed into `JarvisSurface`.

Only `working` and `asking` roster entries participate. The model's pending-launch overlay counts as a Direct
agent until the real hook-fed row supersedes it. Plain terminals, idle agents, and detached background job
records stay in their existing cockpit lanes.

Add optional `WorkerORefs []string` (`workerorefs`) to Run-shaped `ActiveWorkItem` values. It is the sorted,
deduplicated union of that Run's phase worker orefs. A live agent whose `tab:<id>` occurs in any active Run
item is represented by the Run only. Other working/asking agents become Direct agent rows.

No fallback deduplication is allowed. If exact identity is unavailable, two explicitly typed rows are safer
than hiding unrelated work because their titles happen to match.

### 8.3 Pure projection

`briefingmodel.ts` takes:

```ts
WorkState
AgentVM[]
actualCursor
queryStartedAt
```

and returns a render-ready model containing:

- attention summary;
- active Run, blocker, and Direct agent rows;
- filtered/promoted delta rows;
- seven-day Shipped rows;
- source-health presentation; and
- separate Run, direct-agent, delta, and shipped counts.

It performs all ordering, exact worker suppression, window filtering, wording, and navigation normalization.
React components do not reinterpret wire kinds inline.

No arbitrary row cap ships in v1. Current-state lists and the seven-day windows are bounded by meaning, and
the Stage already scrolls. Measure the real response and render cost before introducing a cap or a dedicated
backend projection.

## 9. Visit cursor

Persist one browser-profile-wide UI cursor under:

```text
jarvis.briefing.lastseen
```

Briefing is all-project, so the cursor is not keyed by Space, project, or workspace. Multiple Wave windows
share it: a successful read in either window counts as seen for the profile.

The value is valid only when it is a finite positive integer no later than `queryStartedAt`. Missing,
malformed, nonpositive, or future values fall back to `sevenDaysAgo`.

### 9.1 Advancement rule

After a complete response is accepted, advance the stored cursor to
`max(currentStoredCursor, queryStartedAt)`, never response time. The accepted snapshot itself still uses its
captured `queryStartedAt` boundary. Re-reading before the write prevents a slower second window from
regressing a cursor another window already advanced.

This is an at-least-once boundary for the shared browser profile. An event created while the request is
running may appear in both the current snapshot and the next delta, but no event can be skipped between the
server read and a later client timestamp.

Do not advance the cursor when:

- the RPC fails or is cancelled;
- a newer request supersedes the response; or
- Runs or Dossiers source health is incomplete.

Attention health does not gate cursor advancement because attention is explicitly volatile and cannot be
replayed as a durable leg.

A partial response still renders. Keeping the cursor prevents its missing durable leg from being silently
consumed; repeated healthy-leg events are preferable to lost events. If local cursor persistence fails, keep
the accepted snapshot, report that the visit marker was not saved, and leave the prior cursor in force; the
safe consequence is repetition on the next load.

### 9.2 Request races

`briefingstore.ts` assigns a generation to every load. Only the latest generation may update the displayed
snapshot or cursor. This guards React remounts and rapid subject changes without requiring a backend write or
lock.

## 10. Source health corrections

The frontend can obey the cursor rule only if `SourceHealth` means complete, not merely “the outer call
started.” Tighten `FetchWorkState` while implementing this slice:

- any `GetChannelRuns` failure keeps the partial Run data but marks Runs unhealthy;
- any dossier or decision load failure keeps other vault data but marks Dossiers unhealthy;
- `GatherAttention` failure reports `Attention:"error"`;
- a successful attention read remains `Attention:"volatile"`;
- session scan failure continues to mark Sessions unhealthy for existing API consumers, although Briefing
  excludes that bounded leg from its delta and cursor gate.

No failure sinks the whole response. Health records whether a section can safely be read as complete.

## 11. Frontend state and components

### 11.1 New files

| File | Responsibility |
|---|---|
| `frontend/app/view/jarvis/briefingmodel.ts` | Pure projection and ordering |
| `frontend/app/view/jarvis/briefingmodel.test.ts` | Projection behavior |
| `frontend/app/view/jarvis/briefingstore.ts` | Load generation, cursor, snapshot, inline ask |
| `frontend/app/view/jarvis/briefingstore.test.ts` | Cursor and request lifecycle |
| `frontend/app/view/jarvis/briefingview.tsx` | Tailwind-only Stage body |

### 11.2 Existing integration points

- `subjects.ts` — add `briefing` kind/mark and pure subject identity.
- `subjectscolumn.tsx` — pinned row, shared keyboard order, once-per-launch landing.
- `subjectrestore.ts` / `jarvissubjectstore.ts` — briefing-safe restore and do-not-persist rule.
- `stagecompose.ts` — add `thread:"briefing"`, `recordBand:"none"`,
  `composerTarget:"jarvis-briefing"`, `showGraph:false`, and the remaining absent controls.
- `stage.tsx` — render `BriefingView`; omit graph and record/run regions.
- `stagecomposer.tsx` / `composertarget.ts` — all-work composer face.
- `stageheader.tsx` — hide graph for Briefing and host snapshot time / Refresh.
- `stagerail.tsx` — retain Needs You only for Briefing and correct its volatile zero-state copy.
- `pkg/wshrpc/wshrpctypes_jarvis.go` — optional active-Run worker orefs.
- `pkg/jarvisstate/{jarvisstate.go,fetch.go}` — worker projection, historical window, complete health.

Run `task generate` after the Go wire-type change; generated clients are never hand-edited.

## 12. Inline all-work ask

Briefing reuses the existing bottom composer position with the explicit target:

```text
ALL WORK · Ask across your work…
```

Submitting calls:

```ts
JarvisAskCommand(
  { prompt, cwd: "" },
  { timeout: 180_000 }
)
```

`cwd:""` invokes the shipped all-project scope. The raised timeout matches the CLI because the handler can
run a relevance judge and TierMid synthesis synchronously.

The latest ask state is non-persisted and launch-local:

```ts
idle | pending | answered | error
```

- One answer and its sources render immediately above the composer.
- Only one ask may be in flight. While pending, submission is disabled and labelled `Answering…`; navigation
  remains available and the module-scope request may finish off-surface.
- The next ask replaces the prior settled answer; there is no Briefing answer history.
- Leaving and returning within the launch preserves the latest result.
- It never creates a `JarvisConversation` or a Threads row.
- Known-partial work state disables the composer until a complete refresh succeeds.
- A source is a button only when `orefNavPlan` supports it after the known dossier alias
  (`sourceType:"dossier"` + `vault:<id>` → `task:<id>`). Unsupported memory, decision, or empty refs remain
  cited text rather than no-op controls.
- `notfound`, `weak`, and errors render as their existing honest terminal states.

Landing facts never fall back to this model path. The model is an operator-invoked explanation layer over
the same ledger and recall sources.

## 13. Loading, empty, and failure states

### First load

Render section-shaped loading placeholders. Do not render zero counts before a healthy response exists.

### Healthy empty

Use bounded factual copy, for example:

- `No active Wave runs.`
- `No changes in this visit window.`
- `No evidence-sealed Runs shipped in the last 7 days.`

Do not say nothing needs attention.

### Partial response

Render available sections and one source-health notice naming unavailable legs. An unavailable section is
not silently removed or shown as zero. Do not advance the visit cursor.

### Failed refresh

When a previous snapshot exists, keep it visible with `Showing previous snapshot · refresh failed` and a
Retry action. With no snapshot, show a bounded error state and Retry. Do not advance the cursor.

Briefing refreshes when transitioned into, when its visible Refresh action is used, or when an error Retry
is used. Clicking the already-selected pinned row also refreshes. It is a snapshot, not a live dashboard.

## 14. Accessibility and styling

- Use Tailwind utilities and existing `@theme` tokens; add no SCSS or raw component colors.
- Render navigable rows as semantic buttons and non-navigable facts as non-interactive elements.
- Provide one accessible name for every fragmented two-line row.
- Express kind, status, source health, and `New` in text; color is supplemental.
- Use `aria-live="polite"` for state-load and ask terminal changes.
- Keep the pinned Briefing row in the existing `j`/`k` list-navigation contract.
- Add no decorative motion required to understand state; existing reduced-motion behavior remains sufficient.

## 15. Verification

### 15.1 Go

Add tests proving:

- active Run items project sorted, deduplicated worker orefs;
- nonzero `SinceMs` windows Shipped, Timeline, and Delta;
- one bad channel Run read keeps partial rows but marks Runs unhealthy;
- one bad dossier/decision load keeps partial vault rows but marks Dossiers unhealthy;
- attention failure reports `error`, while success remains `volatile`.

Use package seams for boundary failures rather than requiring a real broken database or vault.

### 15.2 Pure frontend

Test:

- first-use seven-day fallback;
- malformed, nonpositive, and future cursor fallback;
- accepted responses advance monotonically from `queryStartedAt`, never response time;
- RPC failure, partial health, localStorage failure, and stale request generations do not advance the cursor;
- exact Run-worker suppression and no title-based dedupe;
- direct-agent and pending-launch inclusion, excluded session/background rows, and separate counts;
- attention-banner and delta deduplication;
- Shipped promotion to `New`, including an old completion outside the stable seven-day section;
- deterministic ordering and boundary timestamps;
- known dossier `vault:` → `task:` navigation normalization and non-buttons for unsupported refs;
- current-status wording for dossier events;
- neutral first entry, explicit-navigation bypass, and once-per-launch behavior;
- Briefing selection never overwrites the persisted meaningful subject;
- Space/filter/collapse never remove Briefing from the rendered or keyboard order.

### 15.3 Commands

At minimum:

```bash
task generate
go test ./pkg/jarvisstate/... ./pkg/wshrpc/wshserver/...
npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefingstore.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
task build:backend
```

Use the repository's CGO include guidance if a broader Go package command reaches `sqlite-vec`.

### 15.4 Live UI

Add a `task verify:ui -- jarvis-briefing` CDP scenario that verifies:

1. first neutral Jarvis entry opens Briefing;
2. Briefing remains pinned with an active Space and a nonmatching text filter;
3. opening a Run, leaving Jarvis, and returning preserves the Run;
4. clicking Briefing manually or using Refresh reloads it;
5. normal, attention, healthy-empty, partial-source, failed-refresh, and inline-ask states render honestly;
6. a navigable row opens the intended Run/record/agent; and
7. no Briefing-only control appears on ordinary subjects.

## 16. Consequences and reversibility

- No database migration or new durable backend object is required.
- The only new durable UI state is one localStorage timestamp.
- Removing the feature later means removing one synthetic subject and its local cursor; ledger APIs remain
  independently useful.
- The optional worker-oref field is additive on the wire.
- Query-window and source-health fixes tighten the existing documented contract rather than creating a
  parallel one.
- If measured payloads later justify a dedicated Briefing projection, `briefingmodel.ts` is the boundary it
  can replace without changing the surface contract.

## 17. Resolved decisions

| Question | Decision |
|---|---|
| Placement | Permanent pinned Briefing subject |
| Default hierarchy | Work-state-first, not action-first |
| Automatic entry | First neutral Jarvis entry once per Wave launch |
| Manual entry | Pinned row is always available |
| Space behavior | Always All work; ignores Space filtering |
| Visit cursor | Advance after a Runs+Dossiers-complete successful load |
| Cursor timestamp | Monotonic query start, shared across the browser profile |
| First opening | Last seven days |
| Recently Shipped | Stable rolling seven-day section |
| Attention | Conditional banner; rail remains canonical |
| Global ask | Stateless inline answer |
| Row ask | Open the row's native subject, then use existing scoped behavior |
| Progress | Separate future work; no fabricated percentage |
| Backend shape | Existing `JarvisStateCommand`, with additive identity/health/window corrections |
| Live updates | Refresh on entry, visible Refresh/retry, or active-row re-click; no polling or unseen badge |
