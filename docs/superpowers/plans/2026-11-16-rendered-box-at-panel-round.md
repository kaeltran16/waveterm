# Rendered box: one @ panel for agents and files (fix round)

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Spec:** `docs/superpowers/specs/2026-11-16-rendered-box-commands-mentions-bash-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered rendered-shell transcript-base narration-feed`

> **For agentic workers:** the task states its decisions, files and acceptance; you write the implementation and
> pick the tests. Read the spec's decisions 1-3, 9-12 and 12a first.

**Why this round:** while the run built the `@` file mention (`filemention.tsx`), main landed b18bca1e9, an `@`
picker that tags this project's live agents (`mentionpicker.tsx`, `mentionmodel.ts`) in the same box. The merge
(acfa0559a) keeps both hooks with a stopgap in `renderedcomposer.tsx`: the agent list takes `@` while it has rows
and the file panel opens otherwise. So a bare `@` never lists files, and two panels with two looks and two
Esc-dismiss rules answer the same key. The `agent-rendered` steps "rendered: @ mention" (its bare-`@` reopen
check expects the file panel) and "rendered: @ tag" pin the two halves.

### Task 1: One @ panel with an Agents group and a Files group
**Depends on:** none
**Files:** `frontend/app/view/agents/filemention.tsx`, `frontend/app/view/agents/filementionmodel.ts`, `frontend/app/view/agents/filementionmodel.test.ts`, `frontend/app/view/agents/mentionpicker.tsx`, `frontend/app/view/agents/mentionmodel.ts`, `frontend/app/view/agents/mentionmodel.test.ts`, `frontend/app/view/agents/renderedcomposer.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`

**What to build:** spec decision 12a. `@` in the Rendered box opens one `ComposerSuggest` panel (the run's
look and key line). Its first group lists this project's other live agents, using main's `mentionTargets` /
`mentionRows` / tags unchanged; its second group lists files, as decisions 10-11 say. Agent rows show only while
main's `mentionToken` matches the text before the caret (a tag query); a path query shows files only. Each agent
row keeps what main's row shows (state dot and word, tag, title, harness and short id) in the panel's row style.
A picked agent writes its tag and is remembered, so main's trailing block (`appendMentions`) is added on a prompt
send, as now; a picked file writes `@<path> ` and draws as a pill, as now. One Esc-dismiss rule
(`stillDismissed`, decision 2) covers the panel. Bash mode turns the whole panel off, and a `!` send never
carries the agents block. The panel's notes (loading, no folder, error, truncated) concern the Files group only
and never hide agent rows. Main's standalone `MentionPicker` component and the stopgap in
`renderedcomposer.tsx` are removed; where the hook lives (one hook, or `useMentions` folded into
`useFileMention`) is the worker's call, with any new pure rule in a `*model.ts` beside its test.

**Acceptance:**
- unit: a tag query yields agent rows then file rows; a path query (`@src/x`, `@a.ts`, `@"a b`) yields no agent rows;
  a bare `@` yields every target agent and then files
- unit: main's `mentionmodel.test.ts` cases still pass (add, never weaken)
- `agent-rendered` "rendered: @ tag" passes with its selectors moved to the one panel: `ask @` lists exactly the other
  fixture agents in the Agents group (agent rows keep a `data-mention-row` attribute holding the tag), Esc closes
  the panel and types no ESC, `ask @rendered-a` filters the agents to A, Tab writes `ask @<a-tag> `, and the send
  carries A's tab id
- `agent-rendered` "rendered: @ mention" passes unchanged in substance, its bare-`@` reopen included, and its
  `mention-panel` shot shows the one panel
- the composer's other steps ("rendered: slash panel", "rendered: bash mode") still pass
- every changed scenario step runs with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs agent-rendered`
