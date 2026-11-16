# Rendered box: shell card clamp check and the bash-mode Send label (fix round)

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Spec:** `docs/superpowers/specs/2026-11-16-rendered-box-commands-mentions-bash-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered rendered-shell transcript-base narration-feed`

> **For agentic workers:** the task states its decisions, files and acceptance; you write the implementation and
> pick the tests. Read the spec's decisions 14 and 18 first.

**Why this round:** two open issues the run left in its own files. The `!` card's clamp (`shellrunrow.tsx`: 8 lines,
stdout first, then a "Show all" control) has no unit test, and no scenario step draws it, because the scenario's
runs are one line each. In bash mode the box's Send button still takes its label from `box.kind`, so it reads
"Steer" while the agent works, though the text runs as a shell command.

### Task 1: Pin the shell card's clamp and label the bash-mode Send button
**Depends on:** none
**Files:** `frontend/app/view/agents/shellrunrow.tsx`, `frontend/app/view/agents/shellrunmodel.ts`, `frontend/app/view/agents/shellrunmodel.test.ts`, `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `scripts/cdp/scenarios-agent-rendered.mjs`

**What to build:** move the card's clamp rule out of `shellrunrow.tsx` into a pure `shellrunmodel.ts`: given stdout,
stderr and whether the card is opened, it returns the stdout lines and stderr lines to show and whether a "Show
all" control draws (8 lines in all, stdout first, trailing newlines dropped, the control only when lines were
held back). `shellrunrow.tsx` renders from it, with no change in what it draws. In bash mode the Send button's
label (`aria-label` and `title`) is "Run" whatever the agent's state; outside bash mode it stays as now ("Steer"
while working, else "Send"). The label rule goes where `composerBox` already takes the bash flag
(`renderedmode.ts`), not inline in the component.

**Acceptance:**
- unit (`shellrunmodel.test.ts`): 8 lines or fewer show whole with no control; 12 stdout lines show the first 8 with
  the control; 5 stdout and 6 stderr lines show 5 stdout and 3 stderr with the control; opened shows every line and
  no control; trailing newlines do not count as lines
- unit (`renderedmode.test.ts`): the Send label is "Run" in bash mode both idle and working, and "Steer" / "Send"
  outside it as before
- `agent-rendered` "rendered: bash card" also appends a run with more than 8 output lines; its card shows 8 lines and
  a "Show all" control, and a click on it shows every line (a shot of each state)
- `agent-rendered` "rendered: bash mode" checks the Send button reads "Run" while bash mode is on
- every changed scenario step runs with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs agent-rendered`
