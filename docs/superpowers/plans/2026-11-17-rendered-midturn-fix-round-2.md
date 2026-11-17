# Fix round 2: a mixed queue runs in the order it was sent

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\f860511c\docs\superpowers\specs\2026-11-17-rendered-midturn-and-fixes-design.md`

The Final passed 89/89 but could not verify one spec rule: "When the turn ends it runs as a command ... in the order
it was sent among the queued prompts." `turnEndPlan`'s order is unit-tested. But `sendHeld` in
`claude/arc-mod/hooks/register.ts` fires each action's `$.prompt.submit` / `$.command.run` without awaiting the one
before it. Whether the engine then runs them in call order (a command arriving while the prompt before it has
started a turn, for example) depends on the engine, and reading cannot settle it.

Decision (lead): settle it live, then make the order not depend on the engine's luck. If the probe shows the engine
keeps call order for every action kind, the code stays and the evidence goes in the report. If it does not, the mod
sends the next action only once the one before it has been taken: its promise resolved for a command that starts no
turn, or the next `turn.complete` for one that does. Until it is sent, an action stays held, reported and takeable,
as at any other time. Why: the order is a spec rule, and the mod is the only part that can enforce it.

### Task 1: The mod sends a turn's held [a, b, /x, c] in that order, verified in a live session
**Files:** `claude/arc-mod/hooks/register.ts`, `claude/arc-mod/hooks/queue-core.ts`, `claude/arc-mod/hooks/queue-core.test.ts`, `cmd/wsh/cmd/claude-mod/hooks/register.ts`, `cmd/wsh/cmd/claude-mod/hooks/queue-core.ts`

**What to build:** drive a real Claude Code session with the arc mod through the live probe harness
(`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\probes\claude-mods\compactprobe\drive.cjs`, as t-5 did). While a
turn runs a long Bash call, send the queue `a`, `b`, `/x` and `c` over the control stream with `queue:true`, where
`/x` is a slash command that starts no turn (for example `/cost`) and, in a second run, one that does (a skill or
custom command). Read the transcript to see the order in which the merged `a\nb` prompt, the command and `c` were
taken. If the order holds in both runs, change no code and report the transcript evidence. If not, apply the lead's
decision above; keep `turnEndPlan`'s output unchanged and put any new pure sequencing rule in `queue-core.ts` with
its test. Then `task sync:claudemod` and commit the copies.

**Acceptance:**
- In a live session, the transcript shows the merged `a\nb` prompt taken first, then `/x` run as a command (its
  command record, never a user text), then `c`. This holds for both the no-turn command and the turn-starting one.
  The report quotes the record order.
- If code changed: a `queue-core.test.ts` case pins that an action is not released while the one before it has not
  been taken, and that a take-back between the two returns only what is still held.
- `cmd/wsh/cmd/claude-mod/hooks/*` match their `claude/arc-mod/hooks/*` sources after `task sync:claudemod`.
