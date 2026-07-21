# Design brief — Open-ended improvement scan (2026-07-21)

**Date:** 2026-07-21
**Status:** Scan snapshot — candidate backlog, not yet triaged into `docs/open-issues.md` or approved for a spec.
**Source:** Fresh open-ended pass over the product (four parallel read-only scans: deferred/roadmap docs,
in-code rough-edge markers, frontend surface UX, backend reliability/perf). Captured so we don't re-scan.
**Scope note:** Evidence `file:line` anchors are as-of this date and may drift. Everything already tracked in
`docs/open-issues.md` (#1–#6) and every permanently-declined item (see the Exclusions section) was filtered
out during the scan — do not re-surface those.

Ranked by leverage (value ÷ effort) within each theme. `⨯2` marks a finding two independent scans
surfaced separately — a strong signal it is real. `V` = value, `E` = effort (S/M/L).

---

## A — Backend scaling ceiling: the channel-as-one-blob wall

The whole fleet thesis rests on a foundation that grows **O(session)**. This is the only cluster that gets
*worse* the more the product is used. Findings A1–A3 share one root cause (channel-as-one-blob on a
single-connection SQLite) but each has a distinct remediation.

| # | Finding | Evidence | V | E |
|---|---|---|---|---|
| A1 | **Channel object is append-only, rewritten + fully rebroadcast on every mutation.** Every `PostChannelMessage`, `UpdateRun`, `SetChannelRead` does a whole-object read-modify-write (all messages + all runs + sealed evidence); `SendWaveObjUpdate` then re-reads and pushes the *entire* channel to every subscriber. Nothing prunes `ch.Messages`/`ch.Runs`. | `wstore_channel.go:27` (`appendChannelMessage`), `:89` (`appendRunIn`); `wstore_dbops.go:301` (`DBUpdate` marshals full object); `wcore.go:108` (`SendWaveObjUpdate` sends full `Obj`); `wshserver_channels.go:48` | High | M–L |
| A2 | **`GetChannels` full-deserialize + linear scan on per-ask / per-exit / per-report hot paths.** `OnAgentAsk`, `OnWorkerExit`, `ReportRunPhase`, every radar scan decode *all* channels with full embedded history, then nested-scan (channels × runs × phases × orefs) to find one owner. Cost O(total channels × blob size) per event. | `wstore_channel.go:49` (`GetChannels`→`DBGetAllObjsByType`); `watcher.go:94`, `onexit.go:52`, `wshserver_runs.go:271`; scan `resolve.go:93` (`ResolveRunWorker`) | High | M |
| A3 | **Single SQLite connection (`SetMaxOpenConns(1)`) → reader starvation behind a slow writer.** A large-channel read-modify-write (A1) or a radar scan (A2) head-of-line-blocks UI-critical reads for as long as the write runs (bound by Go's single-conn serialization, *not* the SQLite `_busy_timeout=5000`, which governs cross-connection lock retries). WAL is already on, so a read-only connection pool is the standard fix (partly a deliberate write-safety tradeoff — weigh carefully). | `wstore_dbsetup.go:55` (`SetMaxOpenConns(1)`), `:51` (WAL) | High | L |

---

## B — Attention & escalation visibility: the "know when an agent needs you" promise

| # | Finding | Evidence | V | E |
|---|---|---|---|---|
| B1 | **⨯2 Standalone asking agents raise no nav-rail signal.** The "needs you" badge is channel-scoped only; an agent launched via New Agent (not dispatched by a Jarvis channel/run) that starts asking is invisible from every surface but Cockpit. Deliberate in code — there is a test literally named *"the nav-badge bug"*. | `navrail.tsx:52,85` (badge only when `key === "channels"`); `channelderive.ts:93-104`; `channelderive.test.ts:81-85` | High | M |
| B2 | **No OS/titlebar/dock badge when Arc is backgrounded.** The in-app cross-surface counter shipped (nav-rail), but if you're in another app you don't learn a worker is blocked on you. `badge.ts` `setBadge` is per-terminal-block only. | `docs/agents/channels-improvements.md §8`; `navrail.tsx`; `badge.ts` | Med | M — measure-first |

---

## C — Keyboard-first coherence: the flagship promise is half-wired

| # | Finding | Evidence | V | E |
|---|---|---|---|---|
| C1 | **⨯2 List-nav moves the cursor but nothing activates the selection** on Sessions/Radar/Memory/Files. `buildListNavBindings` binds j/k/↑/↓ only — no Enter/activation — so you can arrow to a session but must mouse-click Jump/Resume. Cockpit + Agent set the opposite expectation. | `bindings.ts:184-190`; contrast `sessionssurface.tsx:353-365` (mouse-only Jump/Resume), `usecockpitkeyboard.ts` | High | M |
| C2 | **Run-ask option badges render "1–9" on Channels but the digit handler is Cockpit-only.** The escalated-ask `AnswerBar` passes `numbered`, so badges imply keyboard selection, but on Channels they are decorative and the ask is mouse-only. Misleading affordance. | `channelsprimitives.tsx:110-119` (`AskRow` `numbered`); digit handler `usecockpitkeyboard.ts:123` (`/^[1-9]$/`→`toggleAnswer`; `:95` is the Enter→submit path); `channelssurface.tsx` registers none | High | S–M |
| C3 | **Two divergent, partial keyboard-help surfaces.** Cockpit's `?` opens a hand-written overlay listing triage keys (1–9, r, t, b, n) that are **not** in the binding registry, so the global cheat sheet (Shift+?), generated from the registry, omits them. The `?` entry point exists only in the Cockpit hints bar. | `cockpithelp.tsx:12-79`; `bindings.ts:153-160`; `shortcuts-cheatsheet.tsx:29-41` | Med | S–M |
| C4 | **Esc-to-home bound only on the Agent surface** — no global return-to-home from deep surfaces (radar/sessions/memory/files/channels/usage). The "esc — back" chip only appears in the cockpit `HintsBar` (where cockpit *is* home) and `SURFACE_HINTS.agent` (where `agent:back` is actually bound); the global footer on other surfaces (`GLOBAL_HINTS`) has no esc chip — so deep surfaces neither bind nor advertise it. | `bindings.ts:277-290` (`agent:back` gated `surface === "agent"`); `footerhints.ts:19-24` (`GLOBAL_HINTS`, no esc), `:33` (`SURFACE_HINTS.agent`); `cockpithelp.tsx:14` | Low–Med | S |

---

## D — Trust / integrity of what the cockpit reports

| # | Finding | Evidence | V | E |
|---|---|---|---|---|
| D1 | **5s RPC timeout can permanently seal *empty* evidence (+ orphan worker tabs).** FE calls `createRun`/`advanceRun` with no opts → handler ctx gets `DefaultTimeoutMs=5000`. `SealEvidence` runs inside that budget; a slow `git diff` since `BaseCommit` degrades files-touched to empty, and evidence is immutable once set — so the card shows no files **forever**. The same bounded ctx can cancel `spawnRunWorkers` mid-`CreateTab`, orphaning a tab. Small fix (detached/longer ctx for seal + spawn). Complements the already-top-priority #6. | `wshutil/wshrpc.go:357` (`DefaultTimeoutMs=5000`); `runactions.ts:62,74` (no opts); `wshserver_runs.go:232`; `evidence.go:270` (git error → empty; `GetChanges` has its own 10s timeout but derives from the 5s parent, so 5s is the tighter bound), `:249` (immutability guard); `wshserver_runs.go:352` (backfill skips sealed) | Med–High | S |
| D2 | **⨯2 Agent-tree hardcodes "main" as every agent's branch.** A Phase-1b placeholder from when branch had no source; real branch data now exists (`GitChangesCommand` → `railstore`/`gitstatus`). Every row shows a fabricated branch — actively misleading during triage. | `agenttree.tsx:93-94` (`{/* PLACEHOLDER (1b) */}` → `<div>main</div>`); real branch via `filessurface.tsx:411` | Med | S |
| D3 | **No real error state on most surfaces — failures masquerade as empty.** Only Usage has an `*ErrorAtom` + `SurfaceError`; on files/channels/sessions/memory/radar/agent a failed load/scan is swallowed to console or coerced to `[]`, so a backend failure looks identical to a genuinely empty result. | `docs/agents/cockpit-coherence-audit.md §F5`; `ErrorAtom` exists only in `usagestore.ts` | Med–High | S/surface |

---

## E — Lower-leverage polish & correctness (fold into whichever adjacent pass touches the file)

| # | Finding | Evidence | V | E |
|---|---|---|---|---|
| E1 | **⨯ StatusDot "working" color mismatch.** `files` + `channels` reimplement a local `STATE_DOT` that colors "working" `success` green vs the canonical `StatusDot` `accent`. | `channelsprimitives.tsx`, `filessurface.tsx` (local `STATE_DOT`); coherence-audit §F4 | Med | S |
| E2 | **~150 residual `ink-hi`/`ink-mid`/`ink-faint` uses** run a second text-color scale alongside canonical `primary`/`secondary`/`muted`. Mechanical, parallelizable swap. | coherence-audit §F3 + Pass B | Med | M |
| E3 | **Bare "Loading…" strings** on channels/sessions/review/settings-profilepanel instead of the shared `Skeleton` + `*LoadedAtom` gate. Pairs with D3. | coherence-audit §F6 | Low–Med | S |
| E4 | **Motion tokens unadopted** on channels/sessions/radar/agent-subagent-mount/settings-profilepanel (named intended consumers of `motiontokens.ts`) — list reflow/dropdowns/mounts snap. | coherence-audit §F8 | Med | S/M |
| E5 | **TermThemeDropdown hand-rolls a popover** (full-viewport backdrop, dismisses on backdrop-click only, **never Escape**) instead of the shared `Popover` (floating-ui `useDismiss`). Interaction bug + duplication. | coherence-audit §F12 | Med | S |
| E6 | **FE inbound-RPC handler has no timeout** — a handler that never settles never responds, so the remote caller's RPC hangs. | `wshclient.ts:96` (`// TODO implement a timeout`) | Med | S–M |
| E7 | **Duplicate "outcome" posts — dedup checks a stale pre-post snapshot, not the write.** Two near-simultaneous worker-exit signals can both see "no fresh outcome" and both post. Genuine TOCTOU, but narrow trigger: the hook fires once per process exit, so two posts need two exits (e.g. a re-dispatched/restarted worker), not a single normal exit. | `onexit.go:25` (goroutine + snapshot); `outcome.go:42` (`alreadyHasFreshOutcome`), `:64` (check-then-post) | Low–Med | S |
| E8 | **SSH/WSL connect relies on a fixed `time.Sleep(300ms)` for connserver readiness** — race-prone on slow hosts, wasteful on fast, duplicated verbatim across SSH + WSL. Needs a real readiness handshake. | `conncontroller.go:577`; `wslconn.go:346` | Med | M |
| E9 | **`wsh shell` is a broken stub on Windows** (the only packaged platform) — writes the literal `not implemented/n` (note the `/n` escape typo). | `wshcmd-shell-win.go:26` | Med–Low | S |
| E10 | **Stale "Piece 4 / not yet consumed" comments** claim Jarvis principles are inert, but they are injected into every worker/orchestrator/quick prompt + the Gatekeeper classifier. Same class: memory-graph "placeholder" comment though `MemGraph` renders. Doc/correctness integrity. | `profilepanel.tsx:8`; `wtype.go:297`; `memorysurface.tsx:6` | Med | S |
| E11 | **Files "Open in editor" builds `` `${cwd}/${path}` `` with a forward slash on the Windows-only build** — `cwd` returns backslashes → mixed-separator path to `openExternal`. Verify it resolves; a broken primary action on the diff surface. | `filessurface.tsx:242`, context-menu `488-490` | Med | S |
| E12 | **Radar loses the selected finding on nav-away** — selection in surface-local `useState`, surface unmounts on switch; Sessions/Files persist in atoms. Inconsistent. | `radarsurface.tsx:94` (`useState`) vs `sessionssurface.tsx:71` (atom) | Med | S |
| E13 | **Secondary-surface empty states are dead-ends** — Channels/Sessions/Memory/Files use plain `SurfaceEmptyState` (text only, no CTA) while Cockpit/Agent/Radar give an actionable one. | `sessionssurface.tsx:158`, `memorysurface.tsx:580`, `filessurface.tsx:355`, `channelssurface.tsx:457` | Med | S–M |
| E14 | **Trivial cleanup:** `SURFACE_ROOT` has zero call sites (every surface hand-sets `bg-background`); `PlaceholderSurface` is unreachable dead code. Fold into an adjacent pass. | coherence-audit §F13, §F14 | Low | S |
| E15 | **Favicon cache is process-memory only** (lost each restart; author intends blockstore). | `faviconcache.go:180` | Low | M |
| E16 | **`JobCmd.HandleInput` serializes all pty input under a coarse lock** across the blocking `Write`; author wants a single input loop + queue. | `jobcmd.go:179` | Med–Low | M |
| E17 | **Shell block start has no concurrent-double-start guard** — two concurrent `StartShellProc` can both pass the running-check and race. | `shellcontroller.go:394` | Low–Med | M |

---

## Backend items checked and found sound (do not chase)

RPC streaming cancellation + fsnotify teardown on ws drop (`CancelRequestsForLink`); `runSpawnLocks` keyed
mutex is ref-counted (no map leak); `consult` subprocesses killed on ctx cancel; worker-exit hook fires async
(doesn't block teardown); run-state transitions atomic within one nested `WithTx` (the single connection
actually protects correctness here). Two low-probability evidence-read edges were noted but ranked out:
`readTranscriptLines` ignores `sc.Err()` → silent truncation on a >16MB line (`evidence.go:356`), and the
transcript stream aborts if the parent `.claude/projects/<slug>` dir doesn't exist yet (`transcript.go:155`
vs the file-tolerance intent at `:160`).

---

## Exclusions (already tracked or permanently declined — do not re-surface)

- **Tracked in `docs/open-issues.md`:** #5 (remote/WSL worker host operations, deferred behind a missing
  prerequisite), #6 / 6a–6c (Sealed Run-Evidence card: files-touched over-attribution under fan-out,
  `By`-attribution, verification detail line). D1 above is adjacent to #6 but distinct (timeout → empty seal).
- **Fully designed, unshipped:** backlog-driven orchestration child-runs (spec + plan dated 2026-07-21).
- **Permanently won't-fix / declined:** cockpit light/Paper theme, Gatekeeper v1.1, Arc Environment
  capability, rate-limit token cap + plan-tier badge, Codex 5h-window bars, Codex subagents / deep nesting.
- **Named follow-ons (design already recorded elsewhere):** automatic worker-gone→blocked detection,
  lead-dies-mid-backlog restart survivability, parent-cancel cascade to children, incremental stateful
  transcript projection (#3b, measure-first YAGNI).

---

## Grouping by remediation (cross-cutting lens)

The value-themes above rank by leverage. Grouped instead by **root cause + shared remediation**, the 29
findings collapse into three workstreams plus two standalone items — a more actionable cut when scheduling,
since each workstream has one owner, one skill, and one effort profile.

**1. Compounding data model** (`A1 A2 A3`) — one root: channel-as-one-blob on single-connection SQLite; the
only cluster whose cost grows with use. Backend architecture; needs a spec (pruning/pagination + delta
broadcast + read-conn pool). = Theme A intact.

**2. Backend async & timing correctness** (`D1 E6 E7 E8 E15 E16 E17`) — scattered across Themes D/E but
mechanically identical: an operation racing a timeout, lock, or peer, producing silently-wrong or lost
state. Timeout races (D1, E6), concurrency races (E7, E17, E16), missing handshake/persistence (E8, E15).
D1 sits under "integrity" but its mechanism is a timeout race, so it belongs here. All small, no shared
design decision — a plan, not a brainstorm.

**3. Secondary-surface divergence from canon** (`B1 C1 C2 C3 C4 D2 D3 E1 E2 E3 E4 E5 E10 E11 E12 E13 E14`) —
17 findings, one root: the primary surfaces (Cockpit, Agent) set the patterns and the later secondary
surfaces (Channels, Sessions, Memory, Files, Radar, Settings) each partially reimplemented or skipped them.
This is the cockpit-coherence-audit backlog. Remediation is one strategy — extract the canonical primitive,
apply across surfaces — mostly mechanical and parallelizable, with a few genuine design calls (attention
model in B1, the keyboard-activation contract in C1).

| Canonical pattern | Divergent findings |
|---|---|
| `StatusDot` colors | E1 |
| Keyboard activation / cursor + attention model | C1, C2, C4, B1 |
| Help surface generated from binding registry | C3 |
| Error atom vs. coerced-empty | D3 |
| Actionable (CTA) empty states | E13 |
| Atom-persisted selection | E12 |
| Shared `Popover` (floating-ui `useDismiss`) | E5 |
| Motion tokens | E4 |
| Single text-color scale | E2 |
| `Skeleton` + `*LoadedAtom` gate | E3 |
| Real data / non-stale comments over placeholders | D2, E10, E11 |
| Dead scaffold removal | E14 |

**Standalone (don't force in):** `B2` (OS/dock/titlebar badge — a new capability no surface has, measure-first)
and `E9` (`wsh shell` Windows stub — a plain broken feature, one-line fix). Neither shares a root with the
clusters above.

---

## Recommendation (for whenever we pick one up)

Items that genuinely need *design* (not just execution): **Theme A** (highest leverage, the only cluster
that compounds; needs real architecture decisions on pruning/pagination + delta broadcast + a read
connection pool) and **Theme B** (most thesis-aligned UX; well-bounded). Themes C and D are mostly
"known fix, go execute" — better suited to a plan than a brainstorm — though **D1** (permanent empty
evidence) is a cheap, high-value grab that pairs naturally with open-issues #6.
