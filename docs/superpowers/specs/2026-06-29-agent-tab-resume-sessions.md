# Agent tab: resume past sessions (the "No terminal running" hero)

Date: 2026-06-29
Scope: feature (new backend scan + new Agent-tab center state). Spec only — hands off to writing-plans.
Companion to `2026-06-29-agent-tab-real-tui-design.md` (the real-TUI center pane + header controls).

## Problem

The reworked handoff (`Wave-cockpit-live.dc.html`) draws a `tui.notLaunched` center state on the Agent
tab: a "No terminal running" hero with a **Launch new terminal** CTA and a **recent-sessions** list you
can click to resume (`claude --resume`). It's currently unbuildable as drawn, and unreachable: the Agent
surface only ever shows the live TUI (#1) or a bare `"No active agents."` string, and Wave has no source
of resumable past sessions.

This spec adds that source and the hero, **on the Agent tab**, with **zero changes to the live roster**.

## Decisions (locked via brainstorming, 2026-06-29)

These were settled interactively; recorded here so the plan doesn't relitigate them:

- **Session-as-row.** A resumable unit is a single past `claude` session (one transcript JSONL). The
  filename is the resume key. We do NOT invent persistent multi-session "agents" (rejected: no stable
  identity exists in Wave's data; a named-agent registry is a separate, larger feature).
- **Agent tab, center pane.** Resume lives in the Agent tab's center, not a separate Sessions nav surface
  (the `sessions` nav item stays a placeholder for now) and not as rows in the AgentTree.
- **Trigger = empty roster.** The hero replaces today's `"No active agents."` text when there is no live
  agent to focus. The live roster and its anchored-ordering logic are untouched — no dimmed/non-live rows.
- **Claude-only resume first.** Codex resume is a different mechanism; Codex sessions are shown read-only
  (no Resume) or excluded. Claude resume ships first.

## Architecture / data flow

```
~/.claude/projects/**/*.jsonl ──scan──▶ GetRecentSessions (wshrpc) ──▶ recentsessionsstore (atom)
                                                                            │
AgentSurface (empty roster) ───────────────────────────────────────▶ AgentLaunchHero
                                                                            │ resume(s)
                                                                            ▼
                                              launchAgent({ startupCommand: "claude --resume <id>", cwd })
                                                                            │
                                                              new session tab ▶ live agent ▶ real TUI (#1)
```

- **Backend `GetRecentSessions`** — a new wshrpc command mirroring `GetUsageStatsCommand`
  (wshserver.go:1473). Backed by a new `pkg/agentsessions` package that reuses `usagestats`'s
  `filepath.WalkDir` over `wavebase.GetHomeDir()/.claude/projects` (sibling to `usagestats.scanRoots`).
  Per session it extracts a lightweight record — NOT token buckets:
  `{ id, runtime, projectPath, projectName, branch, task, model, lastActiveTs, tokensTotal, status }`
  where `id` = JSONL filename stem (the `--resume` key), `projectPath`/`branch` from the transcript's
  `cwd`/`gitBranch` fields, `task` = first `type:"user"` human message (trimmed), `model` = last
  assistant model, `lastActiveTs` = file mtime / last entry. Sorted `lastActiveTs` desc, capped (~20),
  within a recency window (default 14d). Requires `task generate` for TS/Go bindings.
- **`recentsessionsstore.ts`** — a jotai atom that calls `GetRecentSessions` and caches the list;
  fetched when the hero mounts (the roster is empty), and re-fetched on demand. Dedupe note: a session
  whose id matches a currently-live agent is excluded (live agents are derivable from their transcript
  path); in practice the empty-roster trigger means none are live, so this is a guard, not a feature.
- **`agentlaunchhero.tsx`** — the center hero: a "Launch new terminal" CTA + the recent-sessions list
  (task · project · branch · model · tokens · when, newest first), each row a Resume action. Pure view
  over the store + `launchAgent`. Built to the handoff's hero (dc.html `tui.notLaunched`, lines 569-583).
- **`agentsurface.tsx`** — one branch swap: when the roster has no live agent, render `<AgentLaunchHero>`
  instead of the current `"No active agents."` block (agentsurface.tsx:54-60). No other changes.
- **Resume / launch** — both route through the existing `launchAgent` (cockpit-actions.ts:27), no new
  launch plumbing. Resume sets `projectPath = session.projectPath` and
  `startupCommand = "claude --resume <id>"`; Launch is a plain new agent. The pending/prune machinery
  (cockpitshell.tsx `usePrunePendingLaunches`) handles the transition to a live roster row.

## Components (isolation)

1. `pkg/agentsessions` (Go) — one job: list recent sessions from disk. Reuses the usagestats walk; its
   own extractor (cwd/branch/first-human/model/mtime). Unit-testable against a fixture transcript dir.
2. `GetRecentSessions` wshrpc command + generated bindings — the transport.
3. `recentsessionsstore.ts` — fetch + cache + live-dedupe. No view.
4. `agentlaunchhero.tsx` — the hero view. No fetching of its own beyond reading the store.
5. `agentsurface.tsx` — the single empty-roster → hero swap.

## Error handling

- Scan fails / no transcripts / unreadable lines → skipped silently; the hero still shows the Launch CTA
  with an empty (or "no recent sessions") list. Never errors the surface.
- Resume into a moved/deleted cwd → `launchAgent` starts the terminal there and Claude surfaces the error
  in the PTY. Mirror, don't pre-validate (matches #1's terminal-owns-its-errors stance).
- Malformed/missing fields in a transcript → that session is dropped from the list, not rendered partial.

## Deferred (noted, not built)

- **Resume while live agents are running.** The hero only shows on an empty roster, so you can't resume a
  past session while other agents run. A later enhancement could add a "resume recent" entry to the
  New-Agent launcher (newagentmodal.tsx). Out of scope here.
- **Codex resume.** Claude-only this pass.
- **Status accuracy.** `paused`/`ended`/`failed` is best-effort from the transcript tail (Claude records
  no clean exit reason). The plan may ship a coarse status (or omit it) rather than over-invest.
- **The `sessions` nav surface** stays a placeholder; this spec does not build it.

## Testing / verification

- Go: `pkg/agentsessions` record-shaping + recency/cap/sort against a fixture transcript dir.
- vitest: `recentsessionsstore` dedupe + sort; the hero's pure bits.
- Typecheck `node --stack-size=4000 …tsc.js --noEmit` (baseline has 3 pre-existing api.test.ts errors).
- CDP: with an empty roster, the hero renders; clicking a recent session launches a terminal with
  `--resume` and it becomes a live agent.

## Implementation outline (writing-plans will expand)

1. `pkg/agentsessions`: scan + extract + sort/cap; Go test against a fixture dir.
2. `GetRecentSessions` wshrpc type + wshserver handler; `task generate`.
3. `recentsessionsstore.ts`: fetch + cache + live-dedupe (+ vitest).
4. `agentlaunchhero.tsx`: hero view (CTA + resume list) wired to `launchAgent`.
5. `agentsurface.tsx`: empty-roster → hero swap.
6. Resume startup-command for Claude (`--resume <id>`); Codex read-only/excluded.
7. Tests + CDP verify.
