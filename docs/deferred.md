# Deferred work

Running log of intentionally-deferred features. Each entry records what was deferred, why,
where it would plug in, and how to pick it back up. Append new entries at the top.

> The consolidated "what's left" view lives in `docs/open-issues.md` (2026-08-24). This file stays the
> append-only rationale log — append the full deferral here, then mirror a one-line row there. An entry
> marked RESOLVED/DECLINED is kept only while it still carries a residual or a revive condition.
>
> Pruned 2026-10-05: 27 entries whose work shipped, was retired with its subsystem, or was superseded were
> removed. Recover any of them with `git show c99f2041:docs/deferred.md`.
>
> Pruned 2026-10-16: resolved entries and those whose plug-in point is gone were removed, long-held ideas
> with no trigger moved to "Declined 2026-10-16" below, and history paragraphs were cut to their recovery
> lines. The full pre-prune text of every entry: `git show db067efe:docs/deferred.md`.

## Declined 2026-10-16 — held for weeks with no trigger

Each was held on a revive condition that never fired. Nothing here is to be resurfaced without new evidence;
the full design notes are in `git show db067efe:docs/deferred.md` under the entry named.

- **Cockpit focus remnants** (entry "Cockpit focus — deferred until evidence"): relationship annotation
  (mocked up and declined as noise 2026-10-08), companion split, time correlation, drag courier. Focus
  itself was removed 2026-10-06; peek covers side-by-side reading. Focus frontend:
  `git show 43d8365a:frontend/app/view/agents/focusstore.ts` (siblings `focusswitcher.tsx`, `focusscope.ts`,
  `focusbanner.tsx`, `focussubject.ts`, `focusfor.ts`).
- **Pet courier gestures and higher acting tiers** (entry "Jarvis pet — 2D creature"). Gatekeeper is
  declined, so the tiers have nothing to act through; the courier only made sense with the drag courier.
  Do not re-add the two top pet corners (`PET_CORNERS`): they sat on the surface heading band.
- **Resource linking beyond navigation** (Related Work, the Work Trail strip, structured refs, file/diff/commit
  targets, a shared action builder, unifying the attachment oref namespace). The spec's "Deferred until
  evidence" section keeps each settled decision:
  `docs/superpowers/specs/2026-09-15-cross-surface-resource-linking-design.md`. The **session target** in
  `openTarget` stays held below.
- **Cross-surface Back history, its context strip, and a Space filter on the Brief.** Built and unit-tested,
  never merged; parked as `09e86573` on branch `feat/surface-integration` — keep the branch as the recovery
  point. Navigation: `git show 09e86573:frontend/app/cockpit/surfacenavigation.ts`; the callers' wiring is
  `git diff eb5a3654 09e86573 -- frontend`. Back needs its own chord: Code owns `Alt+ArrowLeft/Right`.
- **Diff surface repository actions** (checkout, cherry-pick, revert from the Diff surface). Agents do the
  git writes; the surface stays read-only. The deleted revert plumbing, with tests:
  `git show 553658ba:pkg/gitinfo/gitinfo.go`, `pkg/gitinfo/gitinfo_test.go`, `pkg/wshrpc/wshrpctypes_projects.go`,
  `pkg/wshrpc/wshserver/wshserver_projects.go`, `frontend/app/view/agents/gitdiff.ts`, then `task generate`.
- **Diff surface hiding whitespace-only files.** Shift+W (`files:toggle-whitespace`) covers reading through a
  reformat. If ever built, it needs one `--numstat` / `--numstat -w` read in `gitinfo.Changes` deciding both
  the list and its counts; two reads contradict each other.
- **Lead-authored task routing, Phase 4** (the cost/outcome measurement gate). Opus stays the default worker
  (2026-09-29 A/B), so cheap-first routing waste cannot bite. Roadmap:
  `docs/superpowers/briefs/2026-08-19-lead-authored-task-routing-roadmap.md` §"Phase 4".
- **Jarvis U2 Tasks editing** (in-Wave `## Notes` editing, a decision supersede UI over the existing
  `SupersedeDecision`, manual dossier creation, live push) and **U3 graph** follow-ups (search/filter, a read
  rail, cross-surface nav out of a node, whole-vault attribution, calibrating the PLACEHOLDER edge/node
  constants in `jarvisgraphderive.ts`). Dossiers are still written, but neither was asked for since July.

## Memory hygiene: what the first version leaves out (deferred 2026-10-14)

Memory hygiene (`docs/superpowers/specs/2026-10-13-memory-hygiene-design.md`, `pkg/memhygiene`) checks
Claude Code's auto memory only. Three pieces of the spec's design were left out:

- **Pi and Codex memory** (`~/.pi/agent/memory`, `~/.codex/memories`).
  - **Why:** the same model would apply, but each harness has its own folders and its own loader, and Claude
    Code's index is the one whose size notice keeps firing.
  - **Revive when** a Pi or Codex memory index nears its harness's load limit, or a session is seen pruning
    one. Discovery, the index limits and the apply targets are the parts that change; the judge, the merge
    and the store carry over.
- **Merges across batches.** The judge sees the whole index, but a merge can name only memories in its own
  batch of up to 60 KB of bodies.
  - **Why:** related entries sit next to each other in index order, so they mostly share a batch. Merging
    across batches would need a second pass over every batch's bodies.
  - **Revive when** a check's proposals leave two memories that say one thing in different batches, seen
    on a real project.
- **A numeric retention score, and least-recently-read ordering when an index is over budget** (LRU, LFU,
  TTL as eviction rules).
  - **Why:** read counts miss most use, because the index line loads in every session. Recency alone would
    evict rules whose index line does the work.
  - **Revive if** a few weekly checks show the judge's proposals don't keep the indexes under budget.

Nothing was built for these, so there is nothing to recover from git.

## Radar (retired 2026-10-21)

- **Retired:** the Radar surface and everything behind it: the fix-sibling audit scan (`pkg/reporadar`), its
  findings and investigation runs, the audit kinds (sibling, introduced, hotspot), the Radar route settings, the
  `g r` chord, the peek view for a finding and the `radarreport:` address. This
  replaces the earlier Radar entries here: the held security-review and missing-test-coverage audit kinds
  (2026-10-13, with their probe prompts) and the metadata collectors and clustering pipeline (2026-10-06).
- **Why:** measured 2026-10-21 against the packaged store and git. 26 scans from 2026-07-13 to 2026-10-15,
  every one started by hand, none from Jul 30 to Sep 14; the newest waveterm report's 7 open findings (6 low)
  were never triaged. The fix-sibling pipeline (since 10-06) fed 7 investigation runs: 2 real fixes
  (`9db5359f`, and `3759a483` from run `22fdbe4c`), 4 that found nothing left to fix, and 1 re-run of an
  already fixed finding. The six October scans cost about 14.5M tokens, cache reads excluded. It was about 10.9k
  lines (2.7k in `pkg/reporadar` without tests), and 123 commits mention Radar, 21 of them since 10-06. On
  2026-10-08 the findings were already judged not good or stable enough to integrate elsewhere.
- **Revive when** a fix-sibling check is wanted again. Prefer a post-`fix:` agent step that reads the code for
  the same bug at sibling sites over a surface (design: `docs/superpowers/specs/2026-10-06-radar-fix-sibling-audit-design.md`).
- **Recover** with `git show b6fa1229:<path>`, the last commit with Radar in it: `pkg/reporadar/` (with each
  `_test.go`), the frontend `radar*` files under `frontend/app/view/agents/` and `frontend/app/view/jarvis/peek/`,
  and the audit prompts in `pkg/reporadar/audit.go` and `pkg/reporadar/kinds.go`. The retired metadata collectors
  are older still: `git show 78fe087a:pkg/reporadar/<file>`, where `<file>` is one of `collect.go`,
  `collect_config.go`, `collect_dependency.go`, `collect_git.go`, `collect_runs.go`, `collect_structure.go`,
  `collect_transcript.go`, `modes.go`, `prepare.go`, `security.go`, `synth.go`, `validate.go` (each with its
  `_test.go`), or the old `scan.go`, `lifecycle.go` and `types.go` they plugged into. The held security and
  test-coverage probe prompts are in the text this entry replaced: `git show dd32f48d:docs/deferred.md`.

## Sessions "All activity" feed rows peeking a run, agent or initiative (deferred 2026-10-01)

- **Deferred:** the peek gesture on the Sessions "All activity" feed, where `Main.dc.html` in the cockpit-peek mockup
  shows each row peeking a run, agent or initiative.
- **Why:** those rows link sessions today, not runs, and giving them targets was scoped out of the cockpit-peek run.
  The gesture is demonstrated on the Brief's run rows instead (CDP scenario `peek-ctrl-click`). No feed-row-to-target
  mapping was built.
- **Revive when** the feed rows carry a target (a run oref, an agent tab id or an effort id). Wire each row through
  `openOrPeek` in `frontend/app/view/jarvis/openref.ts`, the way the Brief's `openLine` does, and mark it `data-peek`.
  Nothing was built for this, so there is nothing to recover from git.

## Terminal file drop pastes the file's path (deferred 2026-09-30, declined 2026-10-21)

- **Declined 2026-10-21**, with drag-drop onto the New run goal: the user never drops files, they paste. The
  terminal's `pasteHandler` already saves a pasted image to a temp file and types its path, and the goal takes
  pasted files. The cost was lower than noted below: no surface uses HTML5 drag-and-drop (the pet drags by
  pointer events), so flipping `dragDropEnabled` would mainly need a live check of text drags in inputs.
- **Deferred:** dropping a file onto a terminal to paste its quoted path. The Electron build read the path with
  `webUtils.getPathForFile`; the Tauri port stubbed that to return `""`, so the drop handler never pasted anything.
  The stub and the handler are gone; `termwrap.ts` now only swallows the drop so the webview doesn't navigate to the file.
- **Why:** a webview `File` carries no path. Tauri's native drag-drop event does, but it needs `dragDropEnabled: true`
  on the window (`src-tauri/tauri.conf.json`), which takes HTML5 drag-and-drop away from every surface.
- **Revive when** file drops onto a terminal are wanted: listen to `getCurrentWebview().onDragDropEvent` and hit-test the
  drop position against the terminal, which needs that flag flipped and every HTML5 drag target re-checked. The old
  handler: `git show a4b5bd4f:frontend/app/view/term/termwrap.ts` (`dropHandler`).

## Final stage: a verifier's verdict held during Checking is not persisted (declined 2026-09-30)

- **Declined:** persisting the verdict of a final verifier that finishes before the stage's Check and Final
  commands. It lives in `finalRuns.verdicts` (`pkg/orchestrate/final.go`), so a wavesrv restart in that window
  loses it, and the next tick restarts the commands and replaces the verifier.
- **Why:** the commands restart anyway and take longer (the Final command is bounded at 30 min, and every final
  verifier since `0c1e4523` gave its verdict in 0.7 to 2.6 min), so the respawned verifier costs one session's
  tokens and no wall-clock. Persisting needs a `FinalStage` field and restart handling for a window no run has been
  seen to hit.
- **Revive when** a run's history shows a final verifier replaced after a restart, or restarts during Checking
  become routine (auto-update mid-run, for example).

## Run recovery after a restart — New Agent sessions (deferred 2026-09-30)

- **Deferred:** stopping a New Agent session (a block with no `agent:runid`) from replaying its launch prompt
  when its tab remounts after a restart. `shouldRelaunchWorker`
  (`frontend/app/view/agents/session-models/agentresumestore.ts`) still relaunches every such block.
- **Why:** a transcript scan on 2026-09-30 (798 claude and 353 pi sessions) found no session that re-ran its
  launch prompt after a restart: resume-on-reopen bakes `--resume`/`--session` into the block's `cmd:args`
  once the session reports its transcript.
- **Revive when** a session is seen re-running its prompt after a restart. The gate to change is
  `shouldRelaunchWorker`; nothing was built for this, so there is nothing to recover from git.

## Work on an initiative — "Save place and close" (deferred 2026-09-29)

Work on (the Brief's initiative row, `w`, and the palette's ctrl+enter) starts an agent with "where are
we" and points it at the initiative's newest note, and sends you to the agent already open on it instead
of starting a second one. What it does **not** do is capture where a session was when it closes.

- **Deferred:** the close dialog (header ✕, tree "Close agent", double ctrl+c — all `confirmCloseSession`)
  offering **Save place and close** for a session linked to an initiative. Arc would type a "record where
  we are as one left-off note" prompt into the agent, wait for a note from that session with a new
  `--left-off` flag on `wsh effort note`, then close the tab; ctrl+c in the dialog closes without saving.
- **Why:** agents already write where they are. Since note authorship shipped (2026-09-23), 23 sessions
  wrote 185 notes to initiatives, including explicit "END-OF-DAY STATE (resume here)" notes, so the newest
  note is usually the resume point. Losing mid-conversation state ("I was at question 10+") showed up once
  in 30 days of transcripts. Saving costs a turn on every close, and a full cache write when the session
  has sat idle past the cache TTL — the cost that ruled out resuming the last session instead.
- **Revive when** losing a session's place recurs. It plugs in on top of what shipped: the link is the
  tab's `session:effort`, and `confirmCloseSession` (`frontend/app/view/agents/agentactions.ts`) is the one
  place to add the option. The design was a local `.dc.html` canvas and was never committed, so there is
  nothing to recover from git; the steps above are the whole design.

## Composer attachments on a steer (2026-09-18, goal half shipped 2026-10-12)

`composerattachments.ts` and `attachmenttray.tsx` are mounted by `newruncontrol.tsx` for the New run goal.
Still deferred: WSL path translation (drag-drop onto the goal was declined 2026-10-21, see the terminal file drop entry). The Steer half (attachments in
`RunComposer`, `frontend/app/view/jarvis/briefcomposer.tsx`) was declined 2026-10-21: the user does not
attach files to a steer. Nothing was built for it, so there is nothing to recover.

## Session target in `openTarget` (2026-09-17)

The one held item of the resource-linking spec's deferrals (the rest are declined above): a session target
kind, so a Usage session page gets an open button the way a run page does. A new target kind is a union
member in `frontend/app/view/jarvis/address.ts`, a landing in `openref.ts`, and a row in `openref.test.ts`.
Revive when opening a session from Usage is wanted.

## Merge-point Verify: a failed Verify holds only its own run's merges (2026-09-15)

The timeout half is resolved: a plan command runs in a Windows job object and a timeout kills its whole tree
(`plancmd_windows.go`, `jobobject.KillTree`). Still open, and only under `--landing checkout` (a branch-landed
run, the default, merges in its own landing tree): the landing claim (`pkg/orchestrate/verify.go`) serializes
a merge and its Verify across every dag in one checkout, but a persisted `verify-failed` task holds only its
own dag's later merges, so a second orchestrator run in the same checkout lands on top of the failure.

- **Where to pick it up:** have `AutoMergeReady` scan the non-terminal dags whose owner run has the same
  `ProjectPath`.

## Codex and opencode run workers (2026-09-14)

The orchestrator redesign (`docs/superpowers/specs/2026-09-14-orchestrator-redesign-design.md` §8) scopes
run workers, both leads and task workers, to Claude Code and pi, the two harnesses the owner uses. Consults
still run on codex; only the unattended run path lost them.

- **What was removed:** `RunWorkerCapable` false for codex and opencode (`pkg/harness/catalog.go`); their arms
  of `RunWorkerSpecFor` (`pkg/jarvis/runexec.go`); the codex entry in `livenessRuntimes`
  (`pkg/orchestrate/liveness.go`); their route-table rows and `codexSafe` (`pkg/runroute/runroute.go`).
- **Recovery:** `git show adfcbebc:<path>` for each of `pkg/jarvis/runexec.go`, `pkg/orchestrate/liveness.go`,
  `pkg/runroute/runroute.go`, `pkg/harness/catalog.go` and their `_test.go`.
- **Where to pick it up:** re-add the adapter arm, the route validation (a model namespace check) and the
  `RunWorkerCapable` flag together; a runtime needs all three to dispatch, plus the redesign's per-harness
  pieces (wake, compaction rules, ask delivery) before it can lead. codex also needs its `livenessRuntimes`
  entry back.

## OpenCode in the harness catalog (2026-10-13)

OpenCode leaves the harness catalog: no Setup row, no instruction or skill sync into `~/.config/opencode`,
and no consults. It had 0 sessions in the 7 days measured; Codex had 9 and stays. Launching an OpenCode
agent tab, its status plugin and its transcripts are untouched.

- **Recovery:** `git show 51b0213a:<path>` for `pkg/harness/catalog.go`, `pkg/consult/consult.go`,
  `pkg/consult/consult_test.go`, `pkg/runroute/catalog.go`, `pkg/runroute/catalog_test.go`.

## Channel data-model scaling — what Phase 3 left behind (2026-10-06)

Phase 3 (Contract) shipped 2026-10-06: a channel row is metadata, and messages and runs live only in
`db_channelmessage` / `db_run` (spec `docs/superpowers/specs/2026-07-21-channel-data-model-scaling-design.md`).

- **A reader that crosses channels sees only each channel's newest 500 messages**
  (`wstore.DefaultChannelMessageLimit`). The needs-you count and a record's fleet read `channelMessagesAtom`,
  one `GetChannelMessages` window per channel, so a dispatch or an answered-ask card older than the window
  drops out. Not built: a query by ref (`GetMessagesByRef` is the server half). On 2026-10-06 the packaged
  store held 110 messages across 9 channels. Build it when a channel nears 500 messages.
- **A store still below migration `000023`** runs it and `000024` (which drops `db_channel_precontract`)
  before the strip pass, so it keeps no copy: back its `waveterm.db` up by hand first.
- **Whole-list reads left as they were:** the active channel re-reads its message window (newest 500) on
  every channel version bump, and the palette (`palette-data.ts`) and a channel peek (`openref.ts`) read a
  whole run list when opened. The run list itself answers a bump incrementally (`GetChannelRunChanges`).
  Revisit either on a measured cost.

## Jarvis continuity: a per-task resume card (2026-07-24)

`jarviscontinuity` writes a dossier's narrative at each rest boundary, and the pet peeks only the newest one
(`GetLatestResumeCommand`). A per-task resume card consuming `Resume` (`pkg/jarviscontinuity/continuity.go`)
is held for an ambient surface that wants it. PLACEHOLDER tuning left as is: the rest-state set
`{awaiting-review, blocked, done}` (`IsRestState`) and `continuityCaptureTimeout = 90s`
(`pkg/wshrpc/wshserver/wshserver_runs.go`).

## Arc Environment capability — declined (2026-07-16)

An agent-aware local dev-environment manager (discover services from project manifests, launch and observe
them in dependency order, let agents share them), decided against before any implementation.
**To revive:** `git show 4e80bf4f:docs/environment-roadmap.md` restores the full design and its 6-phase plan.

## Usage surface (2026-06-26)

- **Plan-tier badge — deferred, source exists.** `~/.claude/.credentials.json` → `claudeAiOauth` carries
  `subscriptionType` (`max`, already read as an account's `Plan` in `pkg/jarvis/claudeaccount.go`) and
  `rateLimitTier` (`default_claude_max_5x`, undocumented format, so fall back to the plan on an unknown
  value). Deferred because a single known account gains little from it.
- **Permanent limitations:** no rate-limit token *cap* (the 5h/weekly `%` is Anthropic's opaque number, so
  the used-token count has no denominator); no Codex window bars (OpenAI has no 5h/weekly window); pricing
  matches by family, so a historical Opus transcript is priced at the current tier.

## Diff surface — narrow-window cascade (2026-08-03)

The commit column folds to a 44px rail below 1280px (`19d324e5`). The rest of the mockup's cascade stays
declined (author-column drop, three-lane graph, history drawer, a second row density; `historypane.tsx`
keeps `ROW_H = 34`). Revive only on a narrow-window user.

## The memory subsystem and the Jarvis recall arm, removed (2026-09-22/23)

Measured before removal: note **bodies** were opened in 5.3% of 416 Claude Code sessions, and Pi was
write-only; the behaviour came from the one-line `MEMORY.md` index entries. Of 89 runs with a proactive
evaluation 14 hit and one was useful; attribution layer 4 produced 0 of 352 edges. Memory hygiene
(`pkg/memhygiene`) keeps the index small and does not revive recall.

**Revive only on evidence that note bodies, not index lines, change an agent's behaviour.**

- **Recovery:** memory, `git show f5e2179a:pkg/memvault/memvault.go` (any path; the surface is
  `frontend/app/view/agents/vaultsurface.tsx`). Recall arm, `git log --diff-filter=D --oneline -- pkg/jarvisrecall
  pkg/jarvisproactive pkg/jarvisembed` names the deleting commit, then `git show <commit>^:<path>`; the table
  comes back with `db/migrations-wstore/000020_drop_jarvisconversation.down.sql`. The deleted notes are in the
  vault repo: `git -C ~/IdeaProjects/obsidian_vault show 41047c4:memory/<name>.md`.
- **Kept:** `pkg/memroots`, `pkg/wavevault`, `pkg/agentsync`, the resume narrative (`jarviscontinuity`), the
  ledger, attribution L1–3, and OpenRouter as the headless runtime (key in `jarvis_embedapikey`, set from
  Settings → Headless AI).
- **Self-healing cleanup that must stay:** the `agent-memory-*` forms stay in `isManagedCommand`'s allowlist so
  a stale hook is recognized and pruned, and `install-agent-hooks` deletes a leftover
  `~/.pi/agent/extensions/waveterm-memory.ts`.
