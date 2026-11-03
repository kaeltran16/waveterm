# Jira integration: Final round 2 fix

All 40 Final steps passed in round 2. The final verifier found one defect: the initiatives skill's new "From a Jira ticket" section names a `wsh` command that does not exist. Spec: `docs/superpowers/specs/2026-11-03-jira-integration-design.md` ("Making an initiative from a ticket": the agent leaves a first note, "Made from <KEY>").

### Task 1: the initiatives skill uses `wsh effort chunk note`

**Depends on:** none

`skills/initiatives/SKILL.md` line 43 tells the agent to run `wsh effort note <oid> "<first chunk label>" --note "Made from <KEY>: ..."`. `cmd/wsh/cmd/wshcmd-effort.go` registers `note` only under the chunk group (`effortChunkNoteCmd`, `note <effort> <chunk> --note`, added to `effortChunkCmd`), so an agent following the skill hits an unknown-command error and never leaves the note. The Make initiative prompt in `frontend/app/view/jarvis/jiramake.ts` already uses the right form.

Files: `skills/initiatives/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/initiatives/SKILL.md` (the tracked copy `task sync:claudemod` writes; never hand-edit it).

- [ ] **Step 1:** Change line 43 to `wsh effort chunk note <oid> "<first chunk label>" --note "Made from <KEY>: <how you planned the chunks>"`. Change nothing else in the section.
- [ ] **Step 2:** Run `task sync:claudemod` so the arc mod's copy matches, and confirm with `git diff --stat` that both files changed by that one line.
- [ ] **Step 3:** Check the command shape against the CLI: `go run ./cmd/wsh effort chunk note --help` (or read `effortChunkNoteCmd`) shows `note <effort> <chunk> --note`. Grep `skills/` for any other `wsh effort note` and fix it the same way if one exists.
