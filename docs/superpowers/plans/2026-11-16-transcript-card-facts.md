# Transcript cards: engine facts, live checks, row summaries

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/wshrpc/... ./pkg/waveobj ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/orchestrate ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered narration-feed motion-agent rendered-shell transcript-base transcript-initiative transcript-dag transcript-dagactions transcript-runs transcript-agents transcript-notes transcript-arc transcript-boards transcript-live`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\rendered-view-style\project

> **For agentic workers:** each task states its decisions, files, interfaces and acceptance; you write the implementation. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the transcript-style run's open issues (run 2daac8f5, landed b2b4744f2): give the cards the engine facts they lack (chunk 19), verify by click what was only checked by presence (chunk 20), and draw the Jira board's row summary, grouped image reads and the Runs board's colour (chunk 21).

**Architecture:** The engine records what the cards read (child-ask detail, Final-failed wake text, round limits on the dag) and the frontend reads it instead of copying engine constants. Row summaries stay pure functions keyed by wsh call in `WSH_STEP_SUMMARIES`; image grouping is a pure pass over a stretch's steps in `transcriptlayout.ts`. Chunk 20 is a new CDP scenario that drives the real Go Jira client against the fake Jira server, the real brainstorm poller and the real router.

**Tech Stack:** Go (pkg/orchestrate, wsh), React 19 + jotai, vitest, CDP scenarios (`scripts/cdp`).

## Decisions beyond the design (and why)

1. **Round limits live on the dag, stamped once at creation.** `TaskGroup` gains `MaxFinalRounds` (`maxfinalrounds`) and `MaxReviewRounds` (`maxreviewrounds`), set from `orchestrate.MaxFinalRounds` / `MaxReviewRounds` in `NewTaskGroup` (`pkg/orchestrate/dag.go`), the one constructor every submitted dag goes through. Why: the cards already read the dag (`dagDataKey`), a generated constant would need a new generator path for one pair of numbers, and stamping in `persistDag` would miss the dozen direct `wstore.UpdateDag` writers. Consequence for dags created before this lands (neither field): their review and Final cards show "round N" without "of M", and a fix-round card on such a dag never reads "the last round". Accepted: no copy survives to fall back on, which is the point, and those dags are finished or finishing.
2. **The Final-failed wake names its total and commit in its first sentence:** `wake: the final stage failed on the merged result <sha7> in round <n> of <m>[, the last].`, with the ` <sha7>` dropped when the stage has no commit. `<m>` is `n` when the round is the last (a granted round past the limit included), else `MaxFinalRounds`. The sha is the 7-character short form (`shortSha` in `pkg/orchestrate/verifier.go`), as the lead reads it and as the card draws it. The frontend parses both this form and the old one (old transcripts keep old wakes); an old non-last wake shows "round N" with no total.
3. **The child-ask row carries the first question's `header` and `options` (`label`, `description`; never `preview`) and the task's `label`.** Why the first question only: `dagactioncards.ts` matches `answers[0]` against the options, so later questions' options would mislabel picks. Every new string is truncated to `MaxAskSummaryLen` like `question`.
4. **`wsh agents send --json` prints the RPC return (`CommandAgentsSendRtnData`) and refuses `--wait`.** Why: `--wait` prints a second document (the answer), and two JSON documents on stdout would break every `--json` reader, `sendModel` included. The refusal is an `EC-INVALID-ARGS` error that says to drop one of them.
5. **A step summary's colour is set per call key in the registry,** not by the summary function: `runs-attention` ("nothing waiting") is `text-secondary` as the Runs board draws it, `jira-attachments` ("3 saved") stays `text-muted` as the Jira board draws it. Both are existing `@theme` tokens; no new token.
6. **`jira-attachments` is a view key with a summary and no view:** opened, the row shows the raw tool detail as any read call without a renderer does. Its summary counts saved paths (plain output: lines that are absolute paths; `--json`: the array's length) and reads "N saved" for N > 0. A ticket with none reads "no attachments", never "0 saved": plain output holding only the stderr line `<KEY> has no attachments`, or `--json` output that is `[]` (with or without that stderr line before it). Anything else gives no summary.
7. **Image reads group when two or more consecutive steps in one stretch are successful reads whose result carries images** (`verb === "read"`, `images.length > 0`, status `ok`). The group row reads "Read N images" (N = the number of reads), starts closed, and opens to its member step rows (each draws its image card in the rendered view, as a lone image read does today). A lone image read stays a plain step. The fold phrase is unchanged: grouping is drawing, not counting.
8. **Chunk 20's checks run in Final against fakes where real data is impossible there.** Final's isolated app has no real Jira site, so "against a real Jira site" is checked as the real `wsh` + real Go Jira client against the fake Jira server (`scripts/cdp/jira-fixtures.mjs`); a step against a real site runs only when `ARC_LIVE_JIRA_KEY` is set and the app's Jira check passes on a non-fake site, and records a skip with the reason otherwise. It stays unverified in this run; the live command is `ARC_LIVE_JIRA_KEY=<KEY> task verify:ui -- transcript-live` in the dev app.
9. **Open in Jira is observed by stubbing `window.api.openExternal`** for the click (recording the URL, opening nothing), since a real browser open cannot be asserted; Open note and Open agent are observed through the router's landing (surface and selection), then the scenario returns to the transcript.
10. **The FinalFail board's "round 1 of 2" / "round 2 of 2, the last" is a mock value.** The engine's `MaxFinalRounds` is 3, and the cards draw the engine's total. `transcript-boards`' FinalFail fixture keeps its old-form wake (no sha, no total) on purpose: it doubles as the old-transcript case, and `transcript-arc` covers the new form.

## Global Constraints

- Colours only through the `@theme` tokens in `frontend/tailwindsetup.css` (`text-secondary` = #cfd5db, `text-muted` = #7f858b); no new token.
- After changing a `waveobj` type run `task generate`; never hand-edit `frontend/types/gotypes.d.ts`.
- `tsconfig` is `strict: false`: narrow ok-unions with `"reason" in result`.
- Prompt and wake text gets no phrase tests, except text another program parses: the Final-failed wake's first sentence is parsed by `arcmessagemodel.ts`, so its shape is tested.
- Scenario steps that click must leave the app where the next step expects it (return to the transcript fixture, restore stubs).
- A task that writes scenario steps runs its scenario before it completes: `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>` (never `task verify:ui`: a run tree has no dev app), and it passes.

## Review Focus

1. An old transcript's Final-failed wake (no sha, no "of"): the card still reads "Final failed · round N[, the last]" and its defects. Pinned in Task 4.
2. A dag created before this lands (no `maxfinalrounds` / `maxreviewrounds`): review and Final cards draw without a total and never "of undefined". Pinned in Task 4.
3. A child ask with several questions: the answer card's options are the first question's. Pinned in Task 2.
4. `wsh jira attachments` for a ticket with none (exit 0, a stderr line, `[]` under `--json`): "no attachments", never "1 saved" or "0 saved". Pinned in Task 5.
5. An image read still running between two finished ones: never grouped while pending. Pinned in Task 6.

---

### Task 1: Round limits on the dag (interface)
**Depends on:** none
**Files:** `pkg/waveobj/wtype.go`, `pkg/orchestrate/dag.go`, `pkg/orchestrate/dag_test.go`, `frontend/types/gotypes.d.ts`

Decision 1. **Produces:** `TaskGroup.MaxFinalRounds int \`json:"maxfinalrounds,omitempty"\`` and `TaskGroup.MaxReviewRounds int \`json:"maxreviewrounds,omitempty"\`` in `pkg/waveobj/wtype.go`, stamped in `NewTaskGroup`; `task generate` puts `maxfinalrounds?: number; maxreviewrounds?: number` on `TaskGroup` in `gotypes.d.ts`. `SameDagProposal` does not compare them.

- [ ] **Step 1: failing test** `dag_test.go` `TestNewTaskGroupStampsRoundLimits`: the group's two fields equal `MaxFinalRounds` and `MaxReviewRounds`.
- [ ] **Step 2:** `go test ./pkg/orchestrate -run 'TestNewTaskGroupStampsRoundLimits'`: FAIL. **Step 3:** implement, `task generate`. **Step 4:** PASS, plus `go test ./pkg/orchestrate -run 'NewTaskGroup|SameDagProposal'`.
- [ ] **Step 5:** commit.

### Task 2: Engine records the ask's options and the Final-failed total and commit
**Depends on:** none
**Files:** `pkg/orchestrate/askevents.go`, `pkg/orchestrate/askevents_test.go`, `pkg/orchestrate/queue.go`, `pkg/orchestrate/queue_test.go`, `pkg/orchestrate/final.go`, `pkg/orchestrate/final_test.go`, `pkg/orchestrate/finalend_test.go`, `pkg/orchestrate/verifylast_test.go`, `pkg/wshrpc/wshserver/wshserver_ask.go`

Decisions 2 and 3.

**Interfaces:**
- Wake first sentence (Task 4 parses it): `wake: the final stage failed on the merged result[ <sha7>] in round <n> of <m>[, the last].`
- child-ask event detail keys: `taskid`, `askid`, `question`, `label`, `header`, `options: [{label, description?}]` (the names `AskDetail` in `frontend/app/view/agents/dagactioncards.ts` reads).
- `RaiseChildAsk(ctx, g, target, blockOref string, q baseds.AgentAskQuestion)` replaces the `question string` parameter; it looks the task's label up in `g`. `RecordAskLifecycle` keeps its signature for answered/cleared rows; the raise records through a new `recordChildAsk` (or equivalent) that takes the question struct.
- `finalFailedWake(round, of int, sha, runID, detail string, last, autonomous bool) string`.

- [ ] **Step 1: failing tests.** `askevents_test.go` `TestChildAskRecordsHeaderOptionsAndLabel`: raise on task "t-0" labelled "truncate" with a question {header "Suffix", options [{ellipsis, "one character", preview "x"}, {dots, "ascii"}]} plus a second question; the row's detail equals `{taskid, askid, question, label:"truncate", header:"Suffix", options:[{label:"ellipsis",description:"one character"},{label:"dots",description:"ascii"}]}` (no preview, no second question). A header, option label and option description over `MaxAskSummaryLen` come back truncated. `final_test.go` `TestFinalFailedWakeNamesTotalAndCommit`: round 1 of `MaxFinalRounds` with sha "3a7f1c2" starts `wake: the final stage failed on the merged result 3a7f1c2 in round 1 of 3.`; the last round starts `... in round 3 of 3, the last.`; no commit starts `... on the merged result in round 1 of 3.`; a granted round 4 starts `... in round 4 of 4, the last.`; and through `finishFinal` the wake carries the stage's own `Commit` shortened.
- [ ] **Step 2:** `go test ./pkg/orchestrate -run 'TestChildAskRecordsHeaderOptionsAndLabel|TestFinalFailedWakeNamesTotalAndCommit'`: FAIL.
- [ ] **Step 3:** implement; update every `RaiseChildAsk` / `finalFailedWake` / child-ask `RecordAskLifecycle` caller and test listed on Files.
- [ ] **Step 4:** both tests pass, plus `go test ./pkg/orchestrate -run 'Ask|FinalFailed|Final.*Wake|VerifyLast'` and `go test ./pkg/wshrpc/wshserver -run 'Ask'`.
- [ ] **Step 5:** commit.

### Task 3: `wsh agents send --json`
**Depends on:** none
**Files:** `cmd/wsh/cmd/wshcmd-agents.go`, `cmd/wsh/cmd/wshcmd-agents_test.go`, `scripts/cdp/scenarios-transcript-agents.mjs`

Decision 4. Two pure functions beside the existing `agentsSendLines`: `agentsSendFlagsErr(asJSON, wait bool) error` (the refusal, checked before any RPC) and `agentsSendOutput(sent *wshrpc.CommandAgentsSendRtnData, asJSON bool) ([]string, error)` (one JSON line with `tabid`, `sentts`, `midturn` under `--json`, else `agentsSendLines(sent)`). `agentsSendRun` prints what `agentsSendOutput` returns.

- [ ] **Step 1: failing tests** in `wshcmd-agents_test.go`: `agentsSendFlagsErr(true, true)` errors naming both flags, the other three combinations are nil; `agentsSendOutput(&{TabId:"90d97f06", SentTs:1, MidTurn:true}, true)` is one line that unmarshals to those three fields; with `false` it equals `agentsSendLines`.
- [ ] **Step 2:** `go test ./cmd/wsh/cmd -run 'AgentsSend'`: FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: scenario step** in `transcript-agents`: an `agents send <tab> "..." --json` call whose output is that JSON with `midturn: true` draws the send card with "joined its running turn"; the existing plain-output step still draws it without. Run `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs transcript-agents`: passes.
- [ ] **Step 6:** commit.

### Task 4: Cards read the engine's facts; the copies go
**Depends on:** Task 1 (reads the generated `maxfinalrounds`/`maxreviewrounds` on `TaskGroup`)
**Chunk:** Engine: record the facts transcript cards need
**Files:** `frontend/app/view/agents/arcmessagemodel.ts`, `frontend/app/view/agents/arcmessagemodel.test.ts`, `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/dagcards.ts`, `frontend/app/view/agents/dagcards.test.ts`, `frontend/app/view/agents/wshcards-dag.tsx`, `scripts/cdp/scenarios-transcript-arc.mjs`, `scripts/cdp/scenarios-transcript-dag.mjs`

Runs beside Task 2: the wake sentence it parses is fixed by Task 2's Interfaces and appears here only as fixture text. Delete `MAX_FINAL_ROUNDS` (both copies) and `MAX_REVIEW_ROUNDS`. `WakePart` gains `of?: number` and `sha?: string`; the final-failed matcher reads `on the merged result( <sha>)? in round <n>( of <m>)?(, the last)?.` and still matches the old form. `finalRoundOf` becomes `(part: WakePart) => { round: number; of?: number } | null`: `of` is the wake's own, else `round` for a last round, else absent (the row then draws "round N"). The Final-failed row's meta becomes `round 1 of 3 · on the merged result 3a7f1c2 · 2 defects`, dropping the sha when the wake has none. `submitModel` reads the fix round's `last` from `group.maxfinalrounds` (absent: not last, decision 1); `reviewModel`'s `total` and `finalModel`'s `total` come from `group.maxreviewrounds` / `group.maxfinalrounds` and are `undefined` when the dag lacks them; `wshcards-dag.tsx` drops " of N" when `total` is undefined (it draws "round {m.round} of {m.total}" unguarded today).

- [ ] **Step 1: failing tests.** `arcmessagemodel.test.ts`: the new wake gives `{round:1, of:3, sha:"3a7f1c2", last:false}` and `finalRoundOf` `{round:1, of:3}`; the last round `{round:3, of:3}`; an old wake (`in round 1.`) still parses as final-failed with no total. `dagcards.test.ts`: review total and Final total come from the group's fields; a group without them gives `total` undefined; a fix round at `maxfinalrounds` is `last`, and on a group without the field it is not.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/arcmessagemodel.test.ts frontend/app/view/agents/dagcards.test.ts`: FAIL. **Step 3:** implement. **Step 4:** PASS, and `grep -rn "MAX_FINAL_ROUNDS\|MAX_REVIEW_ROUNDS" frontend scripts` finds nothing.
- [ ] **Step 5: scenario steps.** `transcript-arc`: the Final-failed fixture wakes use the new text; the step asserts "round 1 of 3", "on the merged result 3a7f1c2" and the defects, and one old-form wake still draws "Final failed" with its round. `transcript-dag`: seeded dags carry `maxfinalrounds: 3, maxreviewrounds: 2` (the existing "round 1 of 2" / "round 1 of 3" asserts keep passing from the dag, not a constant), and one card on a dag without them asserts "round 1" with no " of ". Run `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs transcript-arc transcript-dag`: passes.
- [ ] **Step 6:** commit.

### Task 5: Row summaries: "3 saved", and "nothing waiting" in secondary
**Depends on:** none
**Files:** `frontend/app/view/agents/wshcall.ts`, `frontend/app/view/agents/wshcall.test.ts`, `frontend/app/view/agents/wshrenderers.tsx`, `frontend/app/view/agents/wshcards-runs.tsx`, `frontend/app/view/agents/notescards.ts`, `frontend/app/view/agents/notescards.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `scripts/cdp/scenarios-transcript-boards.mjs`, `scripts/cdp/scenarios-transcript-runs.mjs`

Decisions 5 and 6. `"jira attachments"` maps to a new `WshViewKey` `"jira-attachments"`. `WSH_STEP_SUMMARIES` entries carry the summary function and its tone (`"muted" | "secondary"`); `RUNS_STEP_SUMMARIES`' `runs-attention` entry is `secondary`; the `jira-attachments` entry (wired in `wshrenderers.tsx`, its function `jiraAttachmentsStepSummary(call, output)` in `notescards.ts`) is `muted`. `narrationtimeline.tsx` draws `[data-step-summary]` with `text-secondary` or `text-muted` from the entry. Grep `WshViewKey` and `WSH_STEP_SUMMARIES` for every reader before changing the shape.

- [ ] **Step 1: failing tests.** `wshcall.test.ts`: `wsh jira attachments SIEM-1748` → `jira-attachments`, a view key. `notescards.test.ts`: three absolute paths (Windows and POSIX) → "3 saved"; `--json` with a 3-element array → "3 saved"; `SIEM-1748 has no attachments` alone → "no attachments"; `--json` output `[]`, alone or after that stderr line → "no attachments"; empty or unparseable output → undefined.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/wshcall.test.ts frontend/app/view/agents/notescards.test.ts`: FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: scenario steps.** `transcript-boards`: the Jira board's `wsh jira attachments SIEM-1748` call outputs three real-shaped saved paths, and the board expects `summaries: [["wsh jira attachments", "3 saved"]]`; the summary check also reads the summary's computed colour and expects `rgb(127, 133, 139)` there and `rgb(207, 213, 219)` for the Runs board's "nothing waiting". `transcript-runs`: the "collapsed row says nothing waiting" step also asserts its colour is the secondary token's. Run `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs transcript-boards transcript-runs`: passes.
- [ ] **Step 6:** commit.

### Task 6: Consecutive image reads draw as one "Read N images" step
**Depends on:** Task 5 (shares `narrationtimeline.tsx` and `scenarios-transcript-boards.mjs`)
**Chunk:** Step summaries for more read families
**Files:** `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `scripts/cdp/scenarios-transcript-boards.mjs`

Decision 7. **Interface:** `export type StepRowItem = { kind: "step"; step: Step } | { kind: "images"; steps: Step[] }` and `export function stepRows(steps: Step[]): StepRowItem[]` in `transcriptlayout.ts`; `layoutTranscript`'s output and `foldSummary` do not change. `StepBox` renders `stepRows(steps)`: an `images` item is a row (`data-step`, `data-step-group="images"`, `aria-expanded`) titled "Read N images" with the chevron, closed by default, opening to its member `StepRow`s with the same open/close reveal a step body uses (`composerReveal`; the one state change it adds is open/closed). Compact width draws the same row.

- [ ] **Step 1: failing tests** in `transcriptlayout.test.ts` (`describe("stepRows")`): three consecutive image reads → one `images` item of 3; one image read → a plain `step`; a pending image read between two finished ones splits them (no group of 1 either side); a non-image read or a failed read breaks a run; a text-file read with no images is never grouped.
- [ ] **Step 2:** `npx vitest run frontend/app/view/agents/transcriptlayout.test.ts`: FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: scenario step.** `transcript-boards`: the Jira board's three reads carry an image each (the `images` shape `AgentActionEntry` holds); the board asserts one closed row reading "Read 3 images" after "Save the screenshots", and that clicking it opens to three image rows. Run `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs transcript-boards`: passes.
- [ ] **Step 6:** commit.

### Task 7: Click and live checks for the Jira card, the brainstorm judge and the Open links
**Depends on:** Task 4 (shares `arcmessagerow.tsx`), Task 5 (shares `notescards.ts`)
**Chunk:** Verify live: Jira card, brainstorm judge, card Open links
**Files:** `scripts/cdp/scenarios-transcript-live.mjs`, `scripts/cdp/scenarios.mjs`, `frontend/app/view/agents/notescards.ts`, `frontend/app/view/agents/notescards.test.ts`, `frontend/app/view/agents/wshcards-notes.tsx`, `frontend/app/view/agents/wshcards-agents.tsx`, `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/narrationfeedfixture.tsx`, `frontend/app/view/agents/brainstormpoller.ts`, `frontend/app/view/agents/brainstormstore.ts`, `frontend/app/view/jarvis/openref.ts`

Decisions 8 and 9. A new scenario `transcript-live` (registered in `scripts/cdp/scenarios.mjs`), built on `transcript-fixture.mjs`, `jira-fixtures.mjs` (`startFakeJira`, `connectFakeJira`, `disconnectJira`) and `notes-wsh.mjs` (`runWsh`, the real built `wsh` in a terminal of the app). Each step cleans up after itself (Jira disconnected, fake server stopped, note deleted, stubs restored, back on the transcript). Steps:
1. **jira show through the real client:** `runWsh` `wsh jira show PAY-318 --json` and plain against the fake site; a transcript holding both calls with their real outputs. With `JiraShowCommand` refused on the page, the `--json` call's view still draws the ticket (key, summary, type · status, attachments, Open in Jira) from its output: the `--json` branch. With it allowed, the plain call's view draws from the real RPC.
2. **Open in Jira:** with `window.api.openExternal` stubbed to record, a click records the fake site's browse URL for PAY-318.
3. **Open note:** a real note made through the app's RPC; the note-add card for its id; a click lands on the note's surface with that note selected.
4. **Open agent:** an agent the scenario makes live the way the cockpit scenarios do; the agents-read card for its tab; a click lands on the Agent surface with that agent selected.
5. **Brainstorm judge from the real poller:** a real `brainstorm.json` (a judged question) written under a temp project's `.superpowers/brainstorm/<topic>/`, attached so the brainstorm poller (`tauriBrainstormIO`) reads it from disk, with `ctx.brainstormFile` set from the agent's `session:brainstorm` tab meta where the fixture seam (`narrationfeedfixture.tsx`) can host it; the judge card draws the pick from what the poller read. If ctx cannot come from a real tab, inject `ctx.brainstormFile` and say so in the report as unverified.
6. **Real Jira site:** decision 8; skip with the reason when `ARC_LIVE_JIRA_KEY` is unset or the site is the fake.

Fix any defect a step finds in a file on the Files line, with a failing unit test first where the defect is in a pure model (`notescards.ts`). A defect whose fix needs a file not on the line is not fixed here: report it as an open issue with the failing step. The report says exactly what stays unverified (at least step 6 in Final, and step 5's ctx if injected).

- [ ] **Step 1:** write the scenario steps. **Step 2:** `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs transcript-live`: every step but 6 passes, 6 skips with its reason.
- [ ] **Step 3:** for each defect found: failing test, fix, `npx vitest run <its test>` PASS, scenario rerun.
- [ ] **Step 4:** commit.
