# Deferred work

Running log of intentionally-deferred features. Each entry records what was deferred, why,
where it would plug in, and how to pick it back up. Append new entries at the top.

## Jarvis sub-project A (Wave Vault) — memory vault coexists, unify later (2026-07-23)

Decided during the A brainstorming (spec in progress: `docs/superpowers/specs/2026-07-23-jarvis-a-wave-vault-*.md`). Sub-project A stands up a **new** git-backed Wave Vault at `~/.waveterm/vault/` (`tasks/`, `decisions/`, `attachments/`, and its own `memory/`). The pre-existing memory vault (`pkg/memvault`, `~/.waveterm/memory`, scanned alongside `~/.claude/projects` + `~/.codex/memories`) and the cockpit **Memory** surface are left **untouched** — two "durable knowledge" roots coexist for now.

- **What's deferred:** unifying the two into one collection. Long-term the vault's `memory/` should be the single durable-knowledge root; v1 does not migrate `~/.waveterm/memory` into the vault, does not repoint `memvault.VaultRoots()`, and does not rewire memvault's consumers (Memory surface, harvest/projection/recall).
- **Why:** subsuming memory pulls a data migration + all of memvault's consumers into A's scope — larger and riskier, and not needed to prove the vault substrate. Coexistence is cheap: `ScanVault` already unifies multiple roots into one wikilink graph, so A's read API can treat the legacy memory root as an extra scan root and cross-collection `[[links]]` still resolve. Markdown is canonical on both sides, so the two are reconcilable later without lock-in.
- **Where it plugs in:** `pkg/memvault` (`VaultRoots`, `DefaultVaultPath`, the `Root{Source:"vault"}` at `~/.waveterm/memory`) and the new `pkg/wavevault` vault-locate/roots. Unification = migrate the legacy memory dir under `~/.waveterm/vault/memory/`, point both packages at one root, and fold the Memory surface onto the vault read API.
- **To resume:** brainstorm/spec the memvault→Wave-Vault unification as its own slice once A/B/C are proven; migrate the memory notes, repoint the scanners, retire the duplicate root.

## Jarvis sub-project G (Plan 4) — ambient attribution ships PLACEHOLDER data (2026-07-23)

Plan 4 wires ambient attribution UI (task tags on Run/Radar/Memory rows + "relevant past decision" cards on their details) onto real objects, but the edges are **fabricated placeholder data**, not real attribution.

- **What's deferred:** the real ambient edges (which task an object belongs to; which past decisions are relevant to it). Plan 4 ships `fixtureAmbientProvider` (`frontend/app/view/agents/ambient.ts`), which derives tags/decisions **deterministically from an oref hash** — believable but fake. Task tags are non-interactive (no Tasks surface exists in v1); relevant-decision cards are marked "placeholder" via a title attribute and surface on ~half of objects.
- **Why:** the real edges come from **attribution engine D (v2)**, which does not exist yet. Shipping the provider seam + a deterministic fixture lets the UI land and be dev/CDP-verifiable now, without blocking on D.
- **Where it plugs in:** the `AmbientProvider` interface in `ambient.ts` (`tagsFor(oref)` / `decisionsFor(oref)`). `ambientviews.tsx` (`AmbientTags` / `RelevantDecisions`) reads it; the surfaces pass an oref (`run:<id>` / `radar:<id>` / `memory:<id>`).
- **To resume:** implement `AmbientProvider` backed by engine D and swap it in behind the interface — the render components and surface wiring stay unchanged.

## Jarvis sub-project F (conversation backend) — model tiering deferred (2026-07-23)

Decided during the F brainstorming (spec in progress: `docs/superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md` §F). F ships the real multi-turn, WaveObj-persisted conversation backend, but **model tiering (meta-spec invariant 2) is deferred out of F** — this is the one F-cycle deferral not otherwise tracked, so it lives here.

- **What's deferred:** the two-tier model split (cheap Haiku-class for grunt work + capable Opus/Sonnet for synthesis). F uses a **single (capable) model** for final synthesis via the existing `consult.Run` (headless `claude` CLI) path.
- **Why:** F's only model call is final synthesis — retrieval is deterministic/free. The cheap-tier consumers invariant 2 names don't exist yet: **traversal navigation → sub-project C**, **boundary summaries → sub-project E**, **draft rationale → sub-project B**. Building a two-tier abstraction with only one tier used would be a single-use abstraction (YAGNI). This is deferral, not omission — invariant 2 remains the product mandate.
- **Where it plugs in:** the model-call site in `pkg/jarvisrecall` (today `consult.Run(ctx, spec, cwd, prompt, …)`). A tier selector = choosing the CLI `--model` per call.
- **To resume:** introduce the tier selector **together with the first real cheap-tier consumer** — whichever of C (recall traversal) / E (continuity boundary summaries) lands first. Wire that consumer to the cheap tier and synthesis to the capable tier at the same time, so the abstraction arrives with ≥2 real users.

Not deferred / tracked elsewhere (recorded so a reader isn't left guessing): **continuity (E)** and **attribution (D)** are their own sub-projects with rows in the meta-spec tracking table — F only defines the F⇄E `resume(task)` seam, it doesn't implement continuity. **Attached-scope retrieval** (the `attachedorefs`-passed-but-not-retrieved gap in the Plan 2 shim) **is fixed inside F**, not deferred.

## Net-new improvement scan — un-triaged candidate backlog (2026-07-17)

A four-lane read-only scan (product/UX friction · performance · reliability/correctness · tech-debt/test-gaps)
for improvements **not** already on any backlog. Excluded by construction: the coherence audit
(`docs/agents/cockpit-coherence-audit.md` F1–F14), `channels-improvements.md`, `runs-pipeline-known-issues.md`,
every entry below in this file, and the named open threads (Jarvis fan-out v1.1, usage backend parts 2&3,
dual-answer ask, cursor-row composer, new-agent-tab integration). **Nothing here is chosen or built** — this is
a captured menu so the scan need not be re-run. Effort: S (localized FE) / M (FE+wiring or store) / L (backend+FE).

### Theme 1 — "Answer in place" triage flow dead-ends (flagship promise; all confirmed) — SHIPPED 2026-07-17

**Shipped:** T1, T2, T4, C1, C2 (T3 declined). Plan: `docs/superpowers/plans/2026-07-17-theme1-triage-flow-hardening.md`.
The T1 stale-draft cleanup runs in the always-mounted `CockpitShell` (`useResetAnswerDraftsOnAskChange`), so
it fires on every surface that answers asks — the cockpit grid AND the Channels `AskRow` — not just the
cockpit.

- **T1. Second ask from the same agent can't be answered in place** — `sentIdsAtom` is only ever added to,
  never cleared anywhere in `frontend/` (`agents.tsx:83,164-166,175`; consumed as a hard lock
  `cockpitsurface.tsx:326`, `channelsprimitives.tsx:114`; `answerbar.tsx:232-247` renders the frozen
  "✓ Answered" instead of the new question). After answering once, that agent's panel is dead for the session
  and submit is silently blocked — forcing a drop into the terminal TUI. **Highest-impact dead-end found.**
  Fix: key `sent`/selections by ask identity, or clear on the agent's `asking → working` transition. Effort M.
- **T2. Answering doesn't advance to the next waiting ask** — the Enter submit branch does no cursor move
  (`usecockpitkeyboard.ts:91-98`; `agents.tsx:161-176`); reaching the next ask is a separate `n` press, and
  there's no mouse "jump to next ask" at all (header "N need you" is static, `cockpitsurface.tsx:370-377`).
  Fix: auto-jump to `nextAskId` on successful submit. Effort S.
- **T3. Mouse single-select fires instantly & irreversibly** — one click injects the answer into the live
  agent with no confirm/undo (`answerbar.tsx:257-271`), while the keyboard path is a guarded two-step
  (`1-9` select, Enter confirm). A stray click sends a wrong instruction to Claude. Fix: require an explicit
  confirm on click too, or a brief undo window. Effort S.
- **T4. Idle reply box silently swallows messages** when the agent's terminal block is gone — the composer
  mounts unconditionally (`idlesection.tsx:60`), `send()` no-ops on missing `blockId` (`agentcomposer.tsx:47-56`)
  and Enter calls it regardless (`:63-71`) while only the button is disabled. Fix: replace the composer with a
  "session ended — Resume to continue" affordance when `blockId == null`. Effort S.
- Two smaller cousins: **new-agent modal advertises ⌘Enter but nothing wires it** (launch is mouse-only;
  `newagentmodal.tsx:625-631`, `modalshell.tsx:34-41` wires only Escape; Task field not autofocused) — Effort S;
  and **cockpit rail "Recent activity" rows are dead `<div>`s** (`cockpitrail.tsx:167-190`) while the Sessions
  feed's equivalent rows are clickable `<button>`s (`sessionssurface.tsx:245-249`) — Effort S.

### Theme 2 — Live-transcript streaming core (one confirmed bug + perf; perf UNMEASURED)

- **S1. Streams never restart after a websocket reconnect (CONFIRMED correctness bug).** Each card opens a
  `StreamAgentTranscriptCommand` with a ~1-year timeout; on a socket drop the client generator neither errors
  nor rejects, so it hangs forever, and reconnect only runs `reannounceRoutes`/`wpsReconnectHandler` — nothing
  restarts streaming RPCs. All live narration/task-chip/git-refresh silently freezes until the surface is
  remounted. Server-side, the request ctx is also `WithTimeout(1 year)` with no per-connection cancel, so the
  `streamTranscript` goroutine + fsnotify watcher leak (one per active card per reconnect).
  Evidence: `wshrpcutil-base.ts:26-72`; `ws.ts:123-152`; `wshrpcutil.ts:26-29`; `livetranscript.ts:22,34-72`;
  `usecardstreams.ts:44-69` (`streamedRef` never reconciled); `transcript.go:139-203`; `wshserver.go:2124-2136`;
  `wshutil/wshrpc.go:334-338`. Fix: on WS reconnect, restart active transcript streams (reconcile `streamedRef`/
  the `streams` map); optionally shorten the timeout with a keepalive or cancel server-side on route disconnect.
  Effort M. (Server-leak half is med-confidence — contingent on no per-connection ctx cancel, none found.)
- **S2. Fleet-wide re-render storm + O(N²) reprojection + unvirtualized narration (perf, code-inferred not
  measured — profile first per measure-before-optimizing).** The stream writes a new whole-map object per chunk
  (`livetranscript.ts:60-61`) and every consumer subscribes to the whole map, not a per-id slice
  (`agentrow.tsx:253-254`, `cockpitsurface.tsx:166-167`, `agentdetailsrail.tsx:55`, `runworkercard.tsx:30-32`);
  `AgentRow` isn't memoized (`agentrow.tsx:159`), no `selectAtom` anywhere. So any chunk re-renders the whole
  surface + every card. The FE also keeps an ever-growing `lines[]` (never trimmed, `livetranscript.ts:48,58`)
  and re-runs full `project(lines)`/`extractTasks` over the entire history on each chunk
  (`transcriptprojection.ts:106-278`) → O(total lines) per chunk. `NarrationTimeline` is unvirtualized,
  `groupTimeline` runs in render with no `useMemo` (`narrationtimeline.tsx:449`), `MarkdownMessage` re-parses
  ReactMarkdown+remarkGfm per render unmemoized (`markdownmessage.tsx:48-77`). Related: a 1s `nowAtom` tick
  re-renders the whole surface and three components each run their own 1s interval writing the same atom
  (`cockpitsurface.tsx:90,99`, `agentdetailsrail.tsx:82`, `usagesurface.tsx:477`); `liveEntriesByIdAtom` is
  never cleared on stream stop (unbounded retention, `livetranscript.ts:75-82`). Fixes cluster: per-id
  subscription (`atomFamily`/`selectAtom`) + memoize `AgentRow`/`MarkdownMessage`; incremental (stateful)
  projection or capped `lines` window; window/cap + `useMemo` the timeline; consolidate/lower the tickers;
  drop stopped ids. Effort M (recommend a CDP/React-DevTools profiler pass on a populated cockpit via
  `scripts/inject-live-agents.mjs` before committing to the refactor).
- **S1/S2 residue (post-implementation, 2026-07-17).** The slice shipped: S1 client stream restart on WS
  reconnect + server-side `WshRpc.CancelRequestsForLink` (reaps the leaked goroutine + fsnotify watcher on
  connection teardown); S2 per-id `atomFamily`/`selectAtom` slices with drop-on-stop, memoized `AgentRow`/
  `MarkdownMessage`/`groupTimeline`, capped narration render (`TIMELINE_RENDER_CAP`) + bounded projection
  window (`MAX_RETAINED_LINES`), and a single always-mounted `NowTicker` replacing three per-surface 1s
  intervals. Two follow-ups remain:
  - **Per-card-unmount-while-connected still leaks the server watcher.** The client's `gen.return()` on unmount
    sends no wire cancel, and `WshRpc.cancelRequest` only flips a bool (`wshrpc.go:266-277`) without cancelling
    the request ctx — so a card unmounted while the websocket stays up leaks its `streamTranscript` goroutine +
    fsnotify watcher until the connection drops (when `CancelRequestsForLink` reaps it) or the 1-year timeout
    fires. A durable fix needs `cancelRequest` to cancel the ctx AND the client to emit a wire cancel on
    `gen.return()`; that changes shared RPC-cancellation semantics (higher blast radius), so it was left out of
    this slice.
  - **Incremental stateful projection** remains a future option if the capped re-project (`MAX_RETAINED_LINES`
    window, re-run in full per chunk) still profiles hot on a populated cockpit. The cap already makes per-chunk
    cost O(window) not O(session); a stateful projector would make it O(chunk) — worth building only if the
    bounded re-project shows up in a profile.

### Theme 3 — Ask-channel correctness (backend)

> **Resolved 2026-07-17 (theme3-ask-channel-correctness).** Both fixes shipped, TDD'd under `-race`
> (spec via the brief; plan `docs/superpowers/plans/2026-07-17-theme3-ask-channel-correctness.md`):
> - **A1** — `Registry.Claim(oref, askid)` (atomic look-up-and-delete) now gates `DeliverAnswer`, so
>   exactly one concurrent caller injects; the loser returns `delivered=false`. `DeliverAnswer(oref, askid,
>   answers)` restores the pending on an encode error (nothing sent) but not on a mid-inject error (partial
>   prefix already sent). The Gatekeeper passes `data.AskId` (double-inject + staleness guard);
>   `AnswerAgentCommand` passes `""` (double-inject guard only). No wire/FE change (A1-b declined).
> - **A2** — a reference-counted `keyedMutex` (`pkg/wshrpc/wshserver/keyedmutex.go`) serializes
>   `spawnRunWorkers` per `runId` across the whole read→spawn→attach, making the `len(WorkerOrefs) > 0`
>   guard effective; `SpawnClaudeWorker` became a `var` seam for the concurrent spawn-once test.

- **A1. `DeliverAnswer` is not atomic and never claims the pending ask** (real, med-high confidence). It does
  `Get` → encode → inject keystrokes but never `Drop`s/claims the entry, which stays "pending" until the
  external clear hook fires `AgentAskClearCommand` later. In that window two deliveries both see `ok=true` and
  both inject a full keystroke sequence into the same picker — concrete trigger: the human answers from the
  panel during the Gatekeeper's `Classify` latency, then `Classify` returns and delivers a second (possibly
  different) selection; simpler trigger: two cockpit sessions, or a double-click. Evidence: `deliver.go:23-41`;
  `agentask.go:41-52` (only Get/Set/Drop, no atomic claim); `wshserver.go:2339-2345,2347-2358`;
  `watcher.go:104,107-116`. Fix: add `Registry.Claim(oref)` (return pending + delete under one lock); deliver
  claims-once so only the first deliverer injects. Effort S.
- **A2. `spawnRunWorkers` read-back-then-attach spans multiple transactions → possible double-spawn of a phase
  worker** (real, low-med confidence — needs a concurrent trigger on one run). The double-spawn guard is
  `len(p.WorkerOrefs) > 0`, persisted only after all spawns complete; the DB serializes single transactions
  (`SetMaxOpenConns(1)`) but not this multi-step sequence, so two concurrent `AdvanceRun`/`CreateRun` calls for
  one run can both see empty `WorkerOrefs` and both spawn. Evidence: `wshserver.go:1523-1544` (called `:1641`,
  `:1743`); `runexec.go:110-125`; `wshutil/wshrpc.go:434-439` (per-RPC goroutine). Fix: spawn+attach inside one
  `UpdateRun` transaction, or a per-run spawn mutex. Effort S–M.

### Theme 4 — Maintainability & test gaps (lower urgency) — PARTIALLY SHIPPED 2026-07-17

**Shipped 2026-07-17 (test-gaps + dedup):** #1 `runactions.test.ts`, #3 `agentcwdresolve.test.ts`, and #6
(one pure `findSessionTermBlock` in `sessionviewmodel.ts`, all 4 sidebar sites routed through it) as the
first tranche; then #2 `pkg/jarvis/watcher_test.go` (extracted pure `askAutoAnswerable`/`optionIndexInRange`
predicates from `handleAsk` and tested them) + `onexit_test.go` (`outcomeSummary`), which Theme 3 A1
unblocked when it landed. All tests mutation-verified (each fails if its guarded behavior regresses).
Spec/plan: `docs/superpowers/{specs,plans}/2026-07-17-theme4-maintainability-testgaps-first-tranche*.md`.
**Still deferred — #4 (`runbody.tsx` split) and #5 (`agentsviewmodel.ts` grid extract):** the
`theme2-streaming-core` worktree is currently locked/active and edits those exact files; per the Theme 4
brief, these move-only diffs wait until Theme 2 lands to avoid merge conflicts. Also recorded in the spec and
plan (`docs/superpowers/{specs,plans}/2026-07-17-theme4-maintainability-testgaps-first-tranche*.md`).

- **Tech-debt.** `runbody.tsx` is an 846-line god-file bundling ~17 components across unrelated concerns
  (status chrome, review gate + markdown-preview, ask card, cancel flow, blocked/starting states, orchestrator
  fan-out, phase rail, and the live shell) — fix: peel the card family into `runcards.tsx` and `PlanPreview`
  out, leave `RunBody` owning only live machinery. `agentsviewmodel.ts` is 933 lines / ~70 exports mixing ≥8
  concerns (grid geometry, ask encoding, pricing math, formatting, cursor nav, filtering, projection) — it is
  well-tested, so low risk, but the pure grid-layout cluster (`:99-103,824-958`) is cleanly extractable into
  `cardgridlayout.ts` (move its tests). `sessionsidebarmodel.ts` copy-pastes the "first `term` block with
  `cmd:cwd`" session-identity rule 4× (`:55,115,206,235`) — extract one `findSessionTermBlock(tab)` helper.
- **Test gaps** (business-critical logic with no sibling test). `runactions.ts` (run lifecycle — `confirmCancelRun`
  live-worker branch/copy `:108-123`, in-flight `Set` tracking in `stopRunWorker`/`cancelRun`). `pkg/jarvis`:
  `watcher.go` (the Gatekeeper auto-answer-vs-escalate decision + index-bounds guard, `:80-118`) and `onexit.go`
  (`outcomeSummary` pure fn `:67-77`) are the only two untested files in the package. `agentcwdresolve.ts`
  (the block→tail→head cwd precedence + tail-miss-only head read, `:35-62`; the pure `agentCwd` parser is tested,
  the fallback orchestration is not).

**Design briefs (resolved decisions, per theme)** live under `docs/superpowers/briefs/`; a downstream agent
expands each into a formal spec + plan and executes. Status:
- Theme 1 — SHIPPED 2026-07-17 (T1, T2, T4, C1, C2; T3 declined). Brief:
  `docs/superpowers/briefs/2026-07-17-theme1-triage-flow-hardening-brief.md`; plan:
  `docs/superpowers/plans/2026-07-17-theme1-triage-flow-hardening.md`.
- Theme 2 — `docs/superpowers/briefs/2026-07-17-theme2-streaming-core-brief.md` (S1 client+server; S2 full refactor).
- Theme 3 — `docs/superpowers/briefs/2026-07-17-theme3-backend-correctness-brief.md` (A1 no-wire-change; A2 guarded). **SHIPPED 2026-07-17.**
- Theme 4 — PARTIALLY SHIPPED 2026-07-17 (#1,#2,#3,#6; #4,#5 deferred pending Theme 2). Brief:
  `docs/superpowers/briefs/2026-07-17-theme4-maintainability-testgaps-brief.md`; spec/plan:
  `docs/superpowers/{specs,plans}/2026-07-17-theme4-maintainability-testgaps-first-tranche*.md`.

**To resume any of these:** read the theme's brief (or, for un-briefed themes, this entry) and run the
spec → plan → execute cycle. This entry holds the raw four-lane scan evidence; the briefs hold the resolved
design decisions.

## Arc Environment capability — declined (2026-07-16)

The Arc Environment roadmap (an agent-aware local dev-environment manager: discover services from
project manifests, launch/observe/diagnose them in dependency order, and let agents share the same
infrastructure instead of spawning duplicates) was captured 2026-07-15 as `docs/environment-roadmap.md`
and **decided against 2026-07-16, before any implementation**. Nothing was built — the roadmap was the
only artifact (doc-only commit `4e80bf4f`), now removed to keep the roadmap set honest.

**To revive:** `git show 4e80bf4f:docs/environment-roadmap.md` restores the full product + architecture
design (thesis, data contracts, deterministic detection contract, the 6-phase delivery plan, and the
Windows-local scope bound). Each phase defined its own exit evidence, so it can be picked back up as
written if the need reappears.

## Channel composer attachments — temp-file cleanup + remote-worker paths (2026-07-16)

Shipped paste/attach/drag-drop attachments in the Channels composer (spec/plan
`docs/superpowers/{specs,plans}/2026-07-16-channel-composer-attachments*.md`). Two edges deferred:

1. **Temp-file cleanup.** Each attachment is persisted via `WriteTempFileCommand`, which `os.MkdirTemp`s a
   fresh dir per file and never deletes it. v1 deliberately does not clean up (the worker may read the file
   any time after send, and lifecycle tracking is out of scope). Over time these accumulate under the OS
   temp dir. **To resume:** track written paths against the run/worker that consumed them and reap on
   worker exit (or a periodic sweep of `waveterm-*` temp dirs older than N days).

2. **Remote / WSL workers can't see local temp paths.** The temp file lands on the wavesrv (local) host;
   an SSH/WSL worktree worker resolves the injected path against *its* filesystem and won't find it. v1 is
   local-scope only (matches the "keep v1 local" principle used across Files/git). **To resume:** route the
   write to `wsh` on the worker's host (same `WriteTempFileCommand`, remote route) and inject the
   remote-side path.

No cross-reload persistence of pending attachments, no image annotation, and no Tauri native file-dialog
plugin were built (all out of scope per the spec's non-goals).

## Channel notes (merged surface) (2026-07-13)

> **Resolved 2026-07-16.** Both follow-ups shipped (plan
> `docs/superpowers/plans/2026-07-14-channel-notes-quick-run.md`, refreshed against the post-decompose tree):
> - **Channel notes** — real persisted field at `Channel.Meta["channel:notes"]` via a new
>   `SetChannelNotesCommand` (clone of `SetChannelTierCommand`; empty notes delete the key). The
>   `OverviewStrip` (`channelchrome.tsx`) now renders a controlled, debounced textarea (600ms) seeded per
>   channel; the collapsed strip shows the notes text or "No notes yet". Store action `setChannelNotes`
>   (`channelsstore.ts`) re-fetches so the snapshot-fed rail updates.
> - **Quick Run** — a real one-phase Run object: `RunMode_Quick` + `QuickPlaybook()` (single fresh-ctx
>   execute phase, no gate, no skill) + `BuildQuickPrompt` (bare headless prompt, self-reports via
>   `wsh jarvis complete`). `resolveRunPlan` maps `mode == "quick"` to the quick playbook; FE `@quick`
>   now calls `launchRun(body, {mode:"quick"})` (mirrors `@run`) instead of the ad-hoc dispatch transport,
>   so it gets its own run-strip tab + `Q` badge + Done lifecycle. TDD'd in `pkg/jarvis/run_test.go`.

The merged Channels surface (`docs/superpowers/plans/2026-07-13-channels-runs-merged-surface.md`) shows a
"Channel notes" area in its collapsible overview strip, but `waveobj.Channel` has no notes field and no
set-notes RPC exists (backend out of scope for that plan). v1 renders it as a **disabled placeholder**
("Channel notes — coming soon") so the UI is honest.

- **To resume:** add `Channel.meta["channel:notes"]` (or a dedicated field) + a `SetChannelNotesCommand`,
  regenerate types (`task generate`), then wire the notes area in `channelssurface.tsx`'s overview strip
  to a controlled textarea persisting through that RPC.

Also deferred from the same plan: a true one-phase **Quick** backend Run mode. `CreateRunCommand` still
accepts only `pipeline|orchestrator`, so `@quick` maps to the existing dispatch path (`launchAgent` + a
dispatch record) — a bare worker-tab that surfaces in the **Fleet here** rail, not the run strip. A real
one-phase Run object (which would give Quick its own run-strip tab + `Q` badge) is a backend follow-up.

## Backend legacy cleanup — deferred removals (2026-07-13) — RESOLVED 2026-07-17

All three held-back targets were retired by the builder/tsunami retirement (`e568a2b3` +
`53acb8a5` on `main`; plan `docs/superpowers/plans/2026-07-16-tsunami-builder-retirement.md`):

1. **Tsunami block controller** + `buildercontroller`/`waveapp`/`waveapputil`/`tsunamiutil`/
   `waveappstore` + the aiusechat builder mode + the builder wshrpc surface + `OType_Builder` +
   the `tsunami/` module — removed in full. The widget-app path was retired, not kept
   (`builderMode` was always false in the cockpit).
2. **`WAVETERM_ELECTRONEXECPATH`** / `GetWaveAppElectronExecPath` — removed alongside #1's consumers.
3. **The ten `window:*` / `app:*` config keys** (`window:{zoom,opacity,blur,dimensions,`
   `savelastwindow,fullscreenonlaunch,maxtabcachesize}`, `app:{globalhotkey,confirmquit,tabbar}`)
   — removed after grep-confirming zero readers.

NB (still valid, outlives this deferral): the original plan's "dead" list was **wrong** on
`autoupdate:{enabled,channel}` (read by Go telemetry → wcloud diagnostic ping) and on the
`NumWindows`/`NumTabs` telemetry fields (populated by `DBGetCount` in `main-server`) — those are
live. Grep-verify before removing any config key or telemetry field.

## Repo Radar — "Start investigation" handoff composer (2026-07-11)

> **Resolved / stale — verified shipped 2026-07-14.** The full handoff is wired end-to-end:
> `radarfindingdetail.tsx` `startInvestigation()` sets `pendingRunDraftAtom` (`runactions.ts`) →
> the Channels surface (`channelssurface.tsx`) lands it as a reviewable Run draft (editable goal,
> file chips, evidence count, "From Radar finding" badge) and `send()` calls `createRun` only on
> explicit Start. Spec/plan `docs/superpowers/{specs,plans}/2026-07-11-radar-start-investigation-composer*.md`.
>
> **Outcome loop closed (2026-07-16).** The reverse direction (Run → Radar) is now wired too, so
> `RunRadarOrigin` is no longer inert: a Run started from a finding writes a `RadarInvestigation` back onto it
> by fingerprint (create → executing, done, cancel → cancelled via `reporadar.RecordInvestigation`), `reconcile`
> carries it forward across scans, and the finding detail + list surface the outcome ("investigating" /
> "investigated" / "still detected") with a "Dismiss (addressed by run)" affordance — never auto-resolving.
> Spec/plan `docs/superpowers/{specs,plans}/2026-07-16-radar-outcome-loop*.md`.

Deferred while building the **Radar frontend surface** (spec `docs/superpowers/specs/2026-07-10-repo-radar-design.md`
§"Start investigation handoff" + §"Frontend integration"). The Radar surface itself ships complete
(all 8 scan states, findings list/detail, evidence rendering, dismiss/suppress/undo, scan/cancel/retry),
but the finding→Run handoff is **not** wired end-to-end.

- **What's deferred:** the **pending Run composer** in the *Channels* surface. Per spec §370-386,
  "Start investigation" must navigate to Channels and open a *prefilled, reviewable Run draft*
  (report ID, finding ID, fingerprint, suggested mission, affected files, evidence refs, Radar origin
  metadata) that the user edits and explicitly starts. This composer does not exist today: `createRun`
  starts a run **immediately** with no draft/review step. Building the draft-then-review affordance is
  new work in a *different* surface (Channels), so it's split out.
- **What ships in the meantime:** the "Start investigation" action is present in the finding detail but
  does not perform the full handoff. `radarmodel.ts` still builds the Run-draft payload (unit-tested per
  spec §468 — report/finding/fingerprint IDs kept distinct), so the data contract is ready; only the
  Channels consumer is missing. Exact interim behavior (disabled w/ tooltip vs. navigate-to-Channels
  without prefill) is fixed in the Radar frontend design doc.
- **Where it plugs in:** the Channels surface + `createRun` flow. Needs a "pending Run" concept
  (draft persisted or held in FE state) and a composer UI, then Radar's Run-draft payload feeds it.
- **To resume:** brainstorm/spec the pending-Run composer as its own slice, add it to the Channels
  surface, then wire Radar's existing draft payload into it and make "Start investigation" open it.

## Subagent interior view — v1 exclusions (2026-07-09)

Shipped the focused-view subagent interior (click a tree child → its live-tailing transcript swaps
into the center pane), disk-backed by `<parent>/<sessionId>/subagents/agent-*.jsonl`. Spec:
`docs/superpowers/specs/2026-07-09-subagent-interior-view-design.md` §11. Out of scope for v1:

1. **Cockpit-card fan-out badge** (`⑃ N` + peek on `agentrow.tsx`) — the deferred v1 half; brings
   fan-out to the at-a-glance grid. The focused view got the interior; the card grid did not.
2. **Codex subagents** — Codex has no confirmed per-subagent transcript files, so Codex parents show
   no children (graceful degradation). Revisit if/when Codex grows per-subagent files.
3. **Retire the vestigial hook path** — `agenthook.go` subagent deltas + `agentstatusstore`
   reducer/TTL + `baseds.AgentSubagentDelta` are no longer the tree's source (the tree now reads
   `subagentsByIdAtom`). Left dormant; `getSubagentsAtom` is now a dead export. Remove once the
   disk-source path is proven in the field (separate change, its own blast radius).
4. **Deep nesting (depth > 1)** — a subagent that itself fans out is rendered flat, not as a subtree.
5. **Workflow-orchestrated subagents degrade** (surfaced by the Phase 0 spike): 582/606 (96%) of real
   child files correlate by exact prompt-match. The other 24 are Workflow-tool / orchestration
   subagents whose parent transcript has no `Task` tool_use (16) or a substantively-different prompt
   (7). These still appear in the tree and open their interior, but with a **prompt-derived label**
   and a **perpetual "working" dot** (no parent `tool_result` to resolve ✓/✗). A future pass could
   read a terminal signal from the child file itself; a prefix-match was rejected (rescues only 1/24,
   adds collision risk). See `subagentcorrelate.ts` header.

**Update 2026-07-10 (subagent-tree-followups):** items 1, 3, and the state half of 5 shipped
(spec/plan `docs/superpowers/{specs,plans}/2026-07-10-subagent-tree-followups.md`).
- **#1 fan-out badge** — `⑃ N` + hover peek on `agentrow.tsx`, fed by `subagentsByIdAtom` via the
  extracted `useSubagentTracking` hook (also used by the cockpit grid and the Runs surface).
- **#5 done signal** — the backend tail-reads a child's last record (`lastRecordTerminal`) into
  `SubagentFileInfo.Done`; `correlateSubagents` resolves a terminated *orphan* (no parent Task
  `tool_result`) to a new neutral **`done`** state instead of a perpetual "working". Success/failure is
  still only knowable for matched children — `done` is deliberately outcome-neutral.
- **#3 hook path retired** — the rail and Runs orchestrator rows now read the disk store; the
  `AgentSubagentDelta` emission (`wshcmd-agenthook.go` **and** the `wsh agentstatus --subagent-*`
  emitter in `wshcmd-agentstatus.go`), the `agentstatusstore` reducer/TTL/idle-clear, `getSubagentsAtom`,
  and `baseds.AgentSubagentDelta` are deleted. Correction: `getSubagentsAtom` was **not** a dead export
  (it was live in the rail + Runs) — this migrated then removed it.
- **#4 deep nesting — CLOSED (no-go).** 0 nested `subagents/*/subagents` dirs across 619 real child
  files; CC writes a flat layout. Reopen only if a nested child file is observed.
- **#2 Codex subagents — remains no-go** (no per-subagent files).

## Feature-triage residue — prioritization + scoping corrections (2026-07-03)

Reconciled `docs/feature-triage.md` (2026-06-23) against the current tree. Most of that ~13-item
"Add" pile shipped (Channels, Jarvis @agent, Memory + graph, Command Palette, Activity, Sessions &
Resume, Usage, New-Agent launchers, Files accept/reject, **Git Worktrees** inside the New-Agent
launcher). The residual **not-built** items, ranked by leverage:

1. **Multi-answer ask** — **multi-SELECT SHIPPED 2026-07-03; multi-QUESTION SHIPPED 2026-07-09.** Chose the
   live-keystroke-spike path (option (a)). Drove a real CC v2.1.199 multi-select `AskUserQuestion`
   picker under a `node-pty` harness and verified the protocol *by outcome* (CC echoed back exactly the
   toggled labels), including at the real 60ms `KeystrokeDelay`. Protocol (now encoded + commented in
   `encode.go` `encodeMultiSelect`, and TDD'd in `encode_test.go`): unlike single-select (Enter
   confirms immediately), multi-select **Enter toggles** the highlighted checkbox; `ESC[B/[A` navigate;
   after the N options CC appends a "Type something" row (idx N) then a **"Submit"** row (idx N+1);
   Enter on Submit opens a "Ready to submit your answers?" review whose default confirms with **one
   more Enter**. `DeliverAnswer` (panel answers) and the Jarvis actuator are unaffected (the actuator
   only sends single indices). FE was already multi-capable (`toggleSelection`/`buildAskAnswers`/
   `canSubmitAsk`), so single-question multi-select now works end-to-end.
   **Multi-question (2026-07-09):** `EncodeAnswer`'s `len(questions) != 1` guard is gone; the new
   `encodeMultiQuestion` walks the tab bar (`←  ☐ Q1  …  ✔ Submit  →`). Protocol, verified live vs CC
   v2.1.205 with an in-repo PTY harness driving the real `EncodeAnswer` output: each tab starts at
   option 0; a **single-select** confirms *and* auto-advances to the next tab on Enter; a
   **multi-select** toggles on Enter and needs an explicit **Tab** to advance; whichever trailing type
   lands on the Submit tab, it shows a "Ready to submit your answers?" review defaulting to "Submit
   answers", so one final Enter confirms. Both labels echoed back exactly for `[single][multi]` and
   `[multi][single]` batches. FE + `DeliverAnswer` were already multi-question capable.
   **Remaining gap:** ~~free-text ("Type something") answering is still not delivered from the panel.~~
   **RESOLVED — verified shipped 2026-07-14.** Free-text is delivered end-to-end: `answerbar.tsx`
   text input → `buildAskAnswers` (emits `{text}`) → `encode.go` (`encodeSingleQuestion`/`encodeMultiQuestion`
   free-text keys + `validateFreeText`), TDD'd in `encode_test.go`. Only intentional limit: single-line
   printable text (control chars drive the picker).
2. **Sub-agent tree in the cockpit** (M→H) — the one residual item that advances the orchestration
   thesis and undoes a regression (old session sidebar had `SubagentStart`/`SubagentStop` lifecycle;
   the cockpit has zero subagent code). Best "real feature" investment.
3. **Cheap-polish bundle** — smaller and less "cheap" than the triage implied under Tauri:
   - **Open in External Editor:** ~~needs an open-semantics decision before it's buildable.~~
     **RESOLVED — verified shipped 2026-07-14.** Rides the `open_external` Tauri command via
     `getApi().openExternal` (OS default handler), wired in `filessurface.tsx:238` (row click) and
     `:444` ("Open in editor" context-menu item). No `$EDITOR`/`launch-editor` path (Node dead-end
     as noted); the OS-default-handler semantics is the shipped behavior.
   - **Jump-to-bottom pill:** ~~the most self-contained, TDD-able piece of the whole residue.~~
     **RESOLVED — verified shipped 2026-07-14.** `JumpToLatestPill` + `useStickToBottom`
     (`sticktobottom.tsx`) render the "↓ Latest" pill when scrolled up; wired into the narration card
     (`agentrow.tsx:560`) and reused in `subagentinterior.tsx` + `runworkercard.tsx`.
   - Remaining T-items (send-file, terminal path-insert, hover preview) are a later second pass.

**Deferred / skip now:** Light/System theme + editor (cosmetic M, off-thesis — Settings surface
shipped with no theme control), project-wide ripgrep search (generic IDE M), Menu-bar tray (needs a
Tauri-native rewrite).

## Backlog re-verification against the tree (2026-07-02)

A sweep of tracked-but-unverified items (memory notes + `docs/superpowers` plans) against git log
and the current tree. Several items believed "unbuilt/uncommitted" had in fact shipped; the list
below is what remains **genuinely unbuilt** after verification. The working tree was clean at the
time of the sweep, so nothing material is sitting uncommitted.

**Still unbuilt:**

- ~~**Jarvis Gatekeeper v1.1 — make-a-rule + auto-answer countdown.**~~ **DECLINED 2026-07-16 —
  reviewed, not building.** The Gatekeeper tier ships (`6c05ac3f`); v1 was intended as the whole
  trust model — the per-channel toggle is the gate, escalation is the safety valve. Both v1.1 items
  were evidence-gated in the spec and no lived-in evidence justifies either: the countdown is
  net-negative against the unattended thesis (it re-inserts the human into every routine answer), and
  make-a-rule needs proof that asks actually recur. Revive **only** on concrete usage evidence —
  recurring ask classes → make-a-rule (cheap now: the structured-principles profile-patch system is
  its natural store); classifier misfiring → tighten escalate criteria / an allow-deny list, not a
  countdown. Spec: `docs/superpowers/specs/2026-07-01-jarvis-gatekeeper-design.md`.
- ~~**Agents tab auto-fit engine (fit-one-screen).**~~ **OBSOLETE 2026-07-02 — spec superseded by
  the shipped layout.** The demotion/backgrounding half + asks-spotlight shipped
  (`partitionBackgrounded`, `backgroundedsection.tsx`, the `b` key). The remaining density engine
  (`expandedWorkingIds`/`MaxPanels`, the `MaxPanelsControl` control, the asks↔working region divider,
  the flex-share expanded-set) is **un-executable as written**: the 2026-06-23 spec assumes a
  single-column *asks-region → divider → working-region* layout, but the tab (`cockpitsurface.tsx`)
  is now a **2-column card grid** with per-card wide/height prefs and asks interleaved in-place. The
  region divider (§4) is meaningless in a unified grid; the per-row narration budget (§3) conflicts
  with the shipped per-card sizing; §9's "remove the per-row resize grip" never happened (cards still
  resize). The card grid already adapts to count (2-col) and supports demotion; a fresh density
  design against the current grid would be new work, not a re-base. Spec/plan:
  `docs/superpowers/{specs,plans}/2026-06-23-agents-tab-fit-one-screen*.md` (kept for history).
- ~~**Usage daily-series view.**~~ **RESOLVED 2026-07-02 (stale entry — already shipped).** A
  per-provider (claude/codex) daily bar chart with a tokens/spend toggle already renders in
  `usagesurface.tsx` (`DailyChart`, off `stats.daily` / `DailyUsage[]`), shipped in `fdaada6e`
  (2026-06-29) — *before* this sweep. The only per-day data still unsurfaced is a per-**model**
  daily breakdown (the payload folds per-model only into window totals, not per-day); the "daily
  sparkline/bar" this entry called for exists.
- ~~**Codex card task chip.**~~ **RESOLVED 2026-07-02.** Added `extractCodexTasks` to
  `codextranscriptprojection.ts` (latest `update_plan` → `CardTask[]`, `completed` → done) and
  registered it on the `codex` projector in `transcriptregistry.ts`. The card consumer
  (`livetranscript.ts`) already called `projector.extractTasks?.()` generically, so no consumer
  change was needed. Covered by 4 new unit tests in `codextranscriptprojection.test.ts`.
- **Multi-answer ask — server gate.** ~~single single-select only~~ **PARTIALLY RESOLVED 2026-07-03:**
  `encode.go` now supports single-question **multi-select** (verified live vs CC v2.1.199 — see the
  2026-07-03 entry at the top). The `q.MultiSelect` and `len(sel) != 1` guards are gone; the
  `len(questions) != 1` guard (multi-question batches) remains, pending a tab-navigation spike.

**Shipped since the memory notes were written (corrections, not open work):** Jarvis Delegator
fan-out (`f43768d9`), the memory force-graph (`bb4da8a1`), the Agents cursor-row composer
(`agentrow.tsx` — in place, tree clean), rate-limit donut persistence (`ratelimitstore.ts`), and the
Usage token-type (cache-read) split (`usagesurface.tsx`).

**Obsolete (not deferred — un-executable as written):** the Agents-tab motion Phase 2 plan
(`docs/plans/2026-06-19-agents-tab-motion.md`) targets `askcard.tsx`/`outputpanel.tsx`/
`sessionsidebar.tsx`/`sessionrow.tsx`/`frontend/app/tab/vtab.tsx`, all removed in the cockpit rebuild
+ Phase-5b teardown. The `motion` dep and animations landed via later work (`agentrow.tsx` uses
Reorder/AnimatePresence/layout springs); this specific plan cannot be applied.

## Agent rail "Tokens" — context occupancy, not cumulative (2026-06-26) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (deferred-token-truth-usage-polish):** the rail's "Tokens" row now shows a
> real whole-file cumulative total for the focused agent, not context occupancy. A thin
> `GetTranscriptTokensCommand` (wshserver) calls `usagestats.SumTranscript`, which reuses the Usage
> surface's Claude/Codex parser + dedupe so the accounting matches. The value loads via
> `tokenstore.ts` (`agentTokensAtom` + `loadTokensForAgent`, with a stale-load guard) from the rail
> effect in `agentdetailsrail.tsx`; a missing/unresolved transcript renders "—". The
> `contextpct × contextmax` occupancy calc and its `DefaultContextMax` fallback are deleted.

Original entry: the Agent details rail's "Tokens" row showed live *context-window occupancy*
(`round(contextpct% × contextmax)`), not cumulative tokens spent, because `AgentUsage` (the
statusLine reporter) carries no token-total field.

## New Agent → Agent tab: dev-mock handoff (2026-06-26)

When a cockpit fixture is loaded (`frontend/tauri/public/cockpit-fixtures/active.json`, dev only),
`agentsAtom`'s base is the static mock, so a launched agent's real roster row never appears there and
the pending "booting" overlay never supersedes to the live transcript. Without a fixture, dev falls
through to the live roster (`devRosterAtom` -> `liveAgentsAtom`) and the handoff works end-to-end.
Verify the launch → terminal → transcript handoff in dev with **no fixture active**, or in a packaged
build / via `scripts/inject-live-agents.mjs`.

Live-CDP finding (2026-06-26): even with no fixture, the boot→transcript auto-swap did not surface in
the dev app. The launch, new-tab roster citizenship, focused booting row, in-layout terminal, and a real
`claude` turn (with token usage) were all confirmed live — but the agent never registered as a roster
row, so the pending overlay never superseded. Cause: the external status reporter resolves `wsh` via
`shutil.which("wsh")` (`agent-status-spike/agent_status_reporter.py`), which is the **packaged Wave's**
`wsh` on PATH; its `wsh agentstatus` call lands in the packaged wavesrv, not the isolated `waveterm-dev`
instance the dev app reads. The supersede + prune logic itself is unit-tested (`agentsviewmodel.test.ts`,
`mergePendingLaunches`). To see the handoff live, run a packaged build (where dev/prod wavesrv coincide),
or point the dev terminal's `wsh` at the dev wavesrv.

## Cockpit card — fabricated data (2026-06-26) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (cockpit-card-real-data):** both card affordances now render real
> data; the `placeholderDiffStats` / `placeholderTasks` fabricators are deleted.
> - **Card diff stats** are loaded per card by `cardgitstore.ts` (`GitChangesCommand` +
>   `diffStatsFromChanges`), driven off the same rendered set as the transcript stream in
>   `cockpitsurface.tsx`: refreshed on enter, debounced 4s on transcript activity, dropped on
>   leave. A clean/non-repo/unresolvable-cwd worktree drops the id (button hides).
> - **Card task list** is the agent's latest TodoWrite, projected by
>   `transcriptprojection.extractTasks` and streamed into `livetranscript.tasksByIdAtom` from the
>   already-open transcript stream (no new RPC). Claude-only in v1.
> - **Follow-on (Codex tasks):** Codex has no TodoWrite; its `update_plan` tool could feed the same
>   chip via a `codextranscriptprojection` `extractTasks`. Not built — Codex cards stay task-less.

Original entry: the card rendered two affordances (diff stats button, `done/total` task chip +
popover) from deterministic placeholder data seeded off the agent id, because the live `AgentVM`
carried no source for them. See `docs/superpowers/specs/2026-07-01-cockpit-card-real-data-design.md`.

## Usage surface — deferred (2026-06-26)

**Permanent limitations (no honest source — not open TODOs):**
- **Rate-limit window token cap** (handoff "1.34M / 2.2M tok"): there is no faithful *limit* — the
  5h/weekly `%` is Anthropic's opaque server-side number, unrelated to any transcript token sum. The
  cockpit now shows a real *used*-token count with **no denominator** (see the resolved usage-bar
  entry); a "used / limit" ratio would require a cap Anthropic does not publish.
- **Plan-tier badge** (handoff "Max 20×" / "Tier 4"): not carried by the statusLine; the provider
  label is shown without a tier badge. No source to derive it from.

**Resolved 2026-07-01 (deferred-token-truth-usage-polish):**
- **Model-id prettifying** — DONE. `prettyModel` (`modellabel.ts`) turns raw ids into friendly labels
  (e.g. "claude-opus-4-8" → "Opus 4.8"); used in the Usage per-model bar and the rail Model row, with
  the raw id kept as a `title` tooltip. Unknown ids fall through unchanged.
- **Pricing table** — REFRESHED to current-generation rates (`usagepricing.ts`): Fable $10/$50, Opus
  $5/$25, Sonnet $3/$15, Haiku $1/$5, plus the new `fable` family. Caveat: family-substring matching
  loses the version, so a historical Opus-4.0 transcript (billed $15/$75) is priced at the current
  Opus tier — acceptable for an estimate; documented in the code.
- **Scan bound** — OBSOLETE. The `SESSION_READ_CAP`/`USAGE_READ_MAXLINES` text described the old
  frontend scan; the usage scan now runs in the Go backend (`GetUsageStatsCommand` → `usagestats`)
  which walks the transcript roots with no file/line cap.

**Still open:**
- **Codex/OpenAI token breakdown**: the parser handles Codex rollout token totals, but OpenAI has no
  5h/weekly window, so the window bars stay Claude-only and a Codex provider row appears only when
  real data exists for it.

## Files surface — deferred (v1)

- ~~**Codex cwd via tail read:**~~ **RESOLVED 2026-07-02.** `GetAgentTranscriptCommand` gained a
  `fromstart` flag (`readTranscriptHead` in `transcript.go`); `resolveCwd` (`agentcwdresolve.ts`)
  now falls back to a head read when the tail yields no cwd. Agent-agnostic — the head read only
  fires on a tail miss, so Claude keeps its `cd`-drift-correct tail resolution and long Codex
  sessions resolve their first-line `session_meta` cwd. Go test `TestReadTranscriptHead`.
- **Remote worktrees:** git runs on the wavesrv (local) host. SSH/WSL agent worktrees need the
  `GitChanges`/`GitDiff` commands routed to `wsh` on that host (same impl can live on `wsh`).
- ~~**Project picker:**~~ **RESOLVED 2026-07-02.** The Files header picker (`SourcePicker` in
  `filessurface.tsx`) now lists registered projects (from `projectsAtom`) alongside agents; picking a
  project scopes the surface to its registry `path` directly via `loadFilesForProject`
  (`filesstore.ts`) — no agent/transcript needed. The git-load core was extracted to
  `loadChangesForCwd` with a generalized `agent:`/`project:` guard token so switching source cancels
  the in-flight load. Agent picks still write the shared `focusIdAtom` (Agent-tab sync preserved); a
  project pick sets a local override. The empty state now yields only when there are no agents *and*
  no projects.
- **Agent-rail placeholders:** Branch + Files-touched in the Agent details rail (Phase 1b) can now
  be fed by `GitChangesCommand` + `gitstatus.ts`; wiring is a follow-on, not done here.
- **Live visual verification (CDP) deferred:** Task 9 of the plan (CDP screenshot vs the handoff)
  was deferred because a dev app was already bound to `:9222` and shares the `waveterm-dev` data
  home; do the visual pass when that port is free, focusing a real agent (mock roster resolves to
  "Not a git repository").

## Usage-bar token counts (fabricated) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (deferred-token-truth-usage-polish):** `FAKE_TOKEN_LIMIT` is deleted. The
> 5-hour / Weekly bars now show a **real Claude-only window-used token count** (no denominator — no
> honest ceiling exists) via `GetWindowTokensCommand` + `usagestats.WindowTokens`, summed over the
> Claude transcript root. Each window is anchored to its rate-limit reset: the frontend
> (`windowtokenstore.ts`) computes `windowStart = reset - duration` and falls back to `now - duration`
> when a reset is absent (API-key auth, or not yet reported). Codex bars carry no `used` line (rate
> limits are Claude.ai-specific). The `%` still comes from Anthropic's opaque server number.

Original entry: the usage bars rendered a `used / limit tok` line where `used = pct% × FAKE_TOKEN_LIMIT`
and the ceilings (2.2M / 44M) were hardcoded handoff values, not telemetry — `AgentUsage` carries no
token totals, only `fivehourpct`/`fivehourreset`/`weekpct`/`weekreset`.

## Agent (Focus) surface placeholders (Phase 1b)

> **Resolved 2026-06-26 (agent-rail-toggle):** git Branch + Files-touched (with per-file
> M/+/− status) are now real, sourced from `GitChangesCommand` via `railstore.ts`. cwd resolves
> from the agent's terminal-block `cmd:cwd` meta first (set by `buildLaunchMeta`, so a
> Wave-launched agent resolves its repo *before* its transcript or reporter enrichment exist),
> falling back to the transcript tail — see `agentcwdresolve.ts`; the same shared resolver fixes
> the Files surface for launched agents too. Stop/Resume are now real (ESC interrupt /
> `"continue\r"` nudge via `ControllerInputCommand`), disabled only when the agent has no live
> terminal block. The disabled **Pause** button and the placeholder **suggestion chips** were
> removed. The details rail is now toggleable (default off, `d` key / header button, persisted
> via `atomWithStorage("agent.rail.visible")`).
>
> Still data-gated: **Model** and **Cost** read the reporter-supplied `AgentVM.model` / `AgentUsage`.
> A freshly-launched agent has no `transcriptPath` and no reporter enrichment yet, so those rows show
> "—" until the external status reporter registers it (the dev wsh-routing gap — see the New-Agent
> dev-mock-handoff entry). cwd was recoverable from Wave-owned block meta; model/cost are not.
> **Tokens (total)** is now real regardless of the reporter — a whole-file transcript scan; see the
> resolved "Agent rail Tokens" entry above.

- **What:** the Agent 3-pane focus surface (`frontend/app/view/agents/agentsurface.tsx` +
  `agenttree.tsx` / `agenttranscript.tsx` / `agentdetailsrail.tsx`) renders to full handoff
  parity, but several fields/actions have no backing data and ship as marked placeholders /
  disabled affordances:
  - **git Branch** — left-tree parent subtitle + Details "Branch" row (static `main`).
  - **Files touched + per-file git status (M / + / −)** — static placeholder list in the rail.
  - **Tokens (total)** — RESOLVED 2026-07-01: the Details "Tokens" row now shows a real whole-file
    cumulative total (`GetTranscriptTokensCommand` / `tokenstore.ts`); see the resolved rail-Tokens
    entry above. (Was: derived input tokens from `contextpct × contextmax`.)
  - **Pause / Resume / Stop** — rendered disabled ("coming soon"); `Open terminal` is the only
    live lifecycle action.
  - **Suggestion chips** — footer chips above the composer are static/disabled (no generator).
- **Why deferred:** Phase 1 is "≈ no new backend" (meta-spec §8) — 1b is a pure
  view-composition pass. Git branch/status and an agent-lifecycle control RPC are backend work;
  a suggestion generator is its own feature. The user chose render-everything (placeholders +
  disabled) over omission, for handoff visual parity.
- **Where it plugs in:** git Branch + Files-touched arrive with the **P2 Files** surface (it
  needs git anyway); Pause/Resume/Stop need a lifecycle control RPC (P2/P3); Tokens-total needs
  a usage extension; suggestion chips need a generator. Each placeholder carries a
  `PLACEHOLDER`/`DISABLED` code comment pointing at spec §8.
- **To resume:** when building P2 Files, add a git-worktree info source (branch + per-file
  status) and feed the tree subtitle + Details "Branch" + the Files-touched list; for lifecycle,
  add a control RPC and enable the disabled buttons; replace the static suggestions with a
  real generator. Full detail:
  `docs/superpowers/specs/2026-06-25-cockpit-phase1b-agent-surface-design.md` §8.
- **Deferred:** 2026-06-25, during the cockpit Phase 1b Agent-surface build.

## Command palette (⌘K) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (command-palette):** shipped as a working `Ctrl+P` overlay
> (`frontend/app/cockpit/command-palette.tsx` + pure matcher `palette-match.ts`). Fuzzy-searches
> live agents (focus), resumable sessions (resume), and commands (surface nav + New agent/project);
> grouped results, arrow/Enter/Esc nav; opened by the app-bar box or global `Ctrl+P` (replaces the
> terminal's readline Ctrl+P, per user). **v1 exclusions:** read-only sessions (no `resumecommand`)
> are hidden so every row is actionable; results are grouped-by-kind, not one global score-sorted
> list. Both are reversible v2 tweaks. Original entry below.

- **What:** the centered search box in the cockpit top app bar — `Search agents, sessions,
  commands…` with a `⌘K` hint badge. Shipped as a **render-only stub**: the box is drawn to
  match the handoff, but clicking it / pressing `Ctrl+K` does nothing.
- **Why deferred:** no palette component exists anywhere in the codebase (grepped — it only
  appears in the handoff mockup). A real searchable command overlay (fuzzy match over
  agents/sessions/commands, keyboard nav, action dispatch) is its own feature, separate from
  the handoff-parity visual pass.
- **Where it plugs in:** the app-bar stub button in `frontend/app/cockpit/` (see the
  cockpit handoff-parity spec). The no-op `onClick` and a global `Ctrl+K` chord would open the
  overlay.
- **To resume:** build a palette overlay (cmdk-style), wire the stub button's `onClick` plus a
  `Ctrl+K` keybinding to open it, and feed it the roster (`model.agentsAtom`), sessions, and a
  command registry.
- **Deferred:** 2026-06-25, during the cockpit handoff-parity pass.

## Cockpit light mode (Paper theme) — 2026-07-03

The theming engine (`themes.ts`) is light-capable and the `paper` palette exists in `THEMES`, but it is
omitted from the v1 picker (`PICKER_THEMES` = dark only). A faithful light mode needs a cockpit-wide
audit of dark-assumed hardcoded colors: inline `rgba(255,255,255,α)` overlays (hover states, `.agent-md`
dividers/code fills in `tailwindsetup.css`), the hardcoded scrollbar hexes (`tailwindsetup.css`
`::-webkit-scrollbar-thumb`), `cockpit.scss` fallbacks, and the greys left fixed by `buildThemeVars`
(`muted-foreground`, `ink-mid`, `lane`, `lane-asking`, `cacheread`, `feed-*`). Convert those to themed
tokens, then set `paper.dark = true`-equivalent exposure in the picker.

## Jarvis sub-project D — attribution tuning constants (2026-07-24)

`pkg/jarvisattrib/edges.go` ships PLACEHOLDER tuning values, to be calibrated against a populated vault before v2 proactive resurfacing trusts hardened edges:
- layer confidence weights: L1=1.0, L2=0.8, L3=0.3
- probation window: 24h (`probationMs`)
- layer-3 time-box (drift decay): 30d (`timeBoxMs`)
- confidence display buckets: weak <0.4, strong ≥0.75
