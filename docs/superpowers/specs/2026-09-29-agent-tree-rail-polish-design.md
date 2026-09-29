# Agent surface: tree and details rail polish

**Status:** Shipped (run a088e568, 2026-09-29). Not yet seen live: see "Open" below.

The Agent surface's left tree (`frontend/app/view/agents/agenttree.tsx`) and right details rail
(`agentdetailsrail.tsx`, `runrailsections.tsx`, `tokenusagesection.tsx`, plus the shared
`frontend/app/element/collapsiblerail.tsx`) move onto the Jarvis brief type scale
(`frontend/app/view/jarvis/briefstyle.ts`): nothing under 10.5px, lucide icons in place of text glyphs, one
leading column, tree guides, and a per-task strip under each run.

## The design is the mockups

Two approved interactive canvases are the spec. They are gitignored, so read them from the main checkout:

- Tree: `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/agent-tree/project/`
  - `Main.dc.html` draws the column with a live-like roster. Its toggles switch between Today and Polished, and between one project and several.
  - `Agents.dc.html` shows every header, group, agent, subagent, rename and terminal state. `Runs.dc.html` shows every lead, run, worker, stage and fold state.
- Rail: `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/agent-rail/project/Main.dc.html`. It draws Today and Polished side by side, each open and with its collapsed strip. Its toggles cover session kind, agent state, run state, lead question, context, files and token usage.
- Serve both with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from the main checkout. If 8766 already answers, they are being served.

Each board's script holds two style tables, `TODAY` and `POLISHED` (search for `const POLISHED`). TODAY is a
transcription of today's classes, so **the difference between TODAY and POLISHED is the change list**; POLISHED
holds the exact values. The tree board's script also holds the row logic the mockup draws with (`runSlot`,
`stripOf`, `runComplete`, and the chip labels in `parentRows` and `workerRow`). Where this spec names a value, it
restates the table and does not override it. The one exception is the Workflow icon, below.

Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`. The mockups' hex values are those
tokens transcribed. There are no new tokens, no raw hex or rgba, and no emoji.

## Tree

1. **Type scale.**
   - Top-level names (agent, lead, run, terminal) are sans 13px medium in `text-ink-hi`. Child names (worker, stage) are sans 12.5px medium.
   - Subagent types are mono 11.5px medium in `text-secondary`.
   - Second lines are mono 10.5px in `text-muted`, 3px below the name. A worker that asks you uses `text-warning` (today `text-warning/85`).
   - The "Agents" header and the group headers (project groups, Terminals) are mono 10.5px, bold, uppercase, with `.1em` tracking. The header is `text-ink-mid` and the groups are `text-muted`.
   - Header and group counts are mono 10.5px semibold in `text-muted` (today groups use `text-feed-time`). The group divider is `bg-edge-mid`.
   - The rename box is sans 13px medium, so the name does not jump when a rename starts.
   - Row tags are all mono 10.5px: "asking" (semibold, warning), "lead" (medium, muted, see icons) and "failed" (semibold, error).
2. **Asking badges** on the header and on group rows read "N asking", not a bare number. They are mono 10.5px semibold in `text-warning` on `bg-askingbg`, with a 5px radius and no wrap.
3. **One leading column.**
   - Every row's leading mark (status dot, icon, fold mark) sits in a `w-[14px]` flex slot, centred, and every row has a 9px gap.
   - Subagent dots grow from 5px to 7px.
   - Top rows are padded 9px by 11px, child rows 7px, subagent and fold rows 6px.
4. **Tree guides replace the `Elbow` (↳).**
   - Each nesting level draws a 1px `bg-edge-strong` vertical line, absolute and the full row height, at `left-[18px]` (depth 1). Depth 2 draws a second line at `left-[35px]`.
   - Rows are padded `11 + 17 × depth` px on the left: 28px at depth 1 and 45px at depth 2 (today 44px).
   - Subagent rows are depth 1.
   - The `Elbow` component and the subagent row's inline ↳ are deleted.
5. **Fold chips.**
   - A fold chip sits at the start of the second line and says what it counts: "N workers" / "N done" (the run chip, unchanged), "N subagent(s)", and "N session(s)" for a task's extra tabs.
   - It is 18px high with a 5px radius and `pl-[3px] pr-[6px]`, mono 10.5px semibold in `text-ink-mid`, on an `edge-mid` border over `surface-hover`. The hover is unchanged.
   - The chevron is a lucide 10px `ChevronRight` or `ChevronDown`.
   - `title` tooltips are dropped. Each chip carries an `aria-label` ("Show/Hide workers", "Show/Hide subagents", "Show/Hide reviewer and earlier sessions") and `aria-expanded`.
   - A lead that also has subagents keeps its subagents chip, restyled, at the row's end, because its second line holds the workers chip.
6. **Icons (lucide-react).**
   - ▸ and ▾ become `ChevronRight` / `ChevronDown`, 10px. The chevron at the end of a fold row is `text-muted`.
   - ✓ on the done fold becomes `Check`, 11px, `text-success`.
   - ›_ becomes `SquareTerminal`, 13px, `text-muted`.
   - "→ lead" becomes `ArrowRight`, 10px, plus "lead", with a 3px gap.
7. **Leads and lead-less runs.**
   - The `Workflow` icon takes the status slot in place of the dot. Its colour is the state the dot had: `text-accent` pulsing while working, `text-warning` pulsing while asking, `text-muted` idle or standing by, and `text-muted` for a lead-less run.
   - The pulse is the existing `animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none`.
   - The icon is **13px**, as the goal settled. The mockup's svg is 12px; 13 wins.
   - The ◆ `RunGlyph` is deleted.
8. **Task strip** under a lead or run row's second line, when the run has a dag.
   - It is 3px high with a 2px gap and sits 6px below the second line. There is one `flex-1 min-w-[2px] rounded-[1.5px]` segment per task, in plan order.
   - Segment states come from `runSegments` (`runrail.ts`). Fills come from `SEG_FILL`, which moves out of `runrailsections.tsx` into the new shared `runstrip.ts`. The tree strip and the rail's run bar then read one map and cannot disagree.
   - Past 24 tasks it becomes a single done/total bar: a `bg-success` part and a `bg-edge-strong` part, flexed by count (done from `runProgress`).
   - It has `role="img"` and `aria-label` "N of M tasks done", plus ", K asking you" when any segment is asking.
9. **Completed run.**
   - The Workflow icon is `text-success` and does not pulse. The second line shows `Check` (11px) plus the land label in `text-success`.
   - Complete means the dag's status is `done` **and** `finishedRunLabel(run)` is "landed" or "run complete". "lead wrapping up" (the run still finalizing, including a final stage still verifying), "landing", "land held" and "run cancelled" are not complete, and keep today's muted label.
   - This is the pure predicate `runComplete(run)`.
10. **Stage rows.** The second line drops the role, which repeats the title: "passed · 14m", or just the age while judging. This is the pure `stageSubline(outcome, age)`.
11. **Unchanged:** selection (`bg-accentbg`), the asking row tint, `buildAgentTree`'s grouping and folding, click targets, context menus, motion and entrance guards.

## Rail

1. **Headings.**
   - There is one section-heading component, `SectionLabel`, in the new `frontend/app/view/agents/sectionlabel.tsx`. Its class is `REGION_LABEL` from `briefstyle.ts` (mono 10.5px, bold, uppercase, `.1em`) plus `text-ink-mid`, and it accepts a `className` so Needs you stays `text-warning`. It replaces the three copies in `agentdetailsrail.tsx`, `runrailsections.tsx` and `tokenusagesection.tsx`.
   - The same file exports `SubLabel`, the same class in `text-muted`. It is used for Activity, Tokens, ≈ Spend, By model, a question's header (NeedsYouCard, LeadAskCard) and "Subagent of …".
2. **Nothing below 10.5px.**
   - The lane letter box is 20px, mono 10.5px semibold in `text-ink-mid`, with the grid's first column 20px. Lane dots are 7px.
   - Lane history is mono 10.5px.
   - These are all 10.5px: the captions under the totals, the percent column (widened to 40px), the model count, the footnote, the Activity buttons and the lane question's meta line.
   - The ×N tool counts are 10.5px.
   - Subagent model names are mono 10.5px. The subagent state is mono 10.5px semibold, coloured by `SUB_COLOR`, and a failure reads "failed".
   - In the collapsed strip the badge is 16px (radius 8px, offset `-right-[8px] -top-[6px]`) with 10.5px bold text, and the percentage is 10.5px.
3. **Contrast.** Activity timestamps and the ×N tool counts move from `text-ink-faint` to `text-muted`.
4. **LaneAsk** (`runrailsections.tsx`, the lead's question under a lane) drops the `border-l-2` stripe. It becomes a card: 1px `border-edge-mid`, 8px radius, `bg-surface-raised`, padded 7px by 10px, with `ml-[35px] mr-[6px] mb-[6px]`.
5. **Icons (lucide-react).**
   - ↗ becomes `ArrowUpRight`, 11px, on View diff, timeline, "answer in …" and "plan · Task N".
   - "Show breakdown ▾" / "Hide breakdown ▴" use `ChevronDown` / `ChevronUp`, 11px.
   - "✓ Done", the run status for a done digest, becomes `Check` (12px) plus "Done".
   - The insight's ◆ becomes `Lightbulb`, 13px, `text-warning`.
   - "◂ back to" becomes `ArrowLeft` and "↑ lead" becomes `ArrowUp`, both 11px.
   - A lane whose question the lead holds shows no dot, and `ArrowRight` (10px) plus "lead" in muted. `laneRows` (`runrail.ts`) returns the text "lead" in place of "→ lead".
   - The collapsed strip's ‹ (`RailStrip` in `agentdetailsrail.tsx`) becomes `ChevronLeft`, 18px. The collapse control's › in `collapsiblerail.tsx` becomes `ChevronRight`, 16px. `CollapsibleRail` is shared, so the other rails change too, which the user accepted.
6. **Unchanged:** the rail layout and widths, the Details lines, the context meter and Compact/Clear, the NeedsYou and LeadAsk cards (apart from their label sizes), the token numbers and bars, the footer's Resume/Stop, motion, and the hover tooltips on Compact, Clear, Resume and Stop, which explain the command.

## Pure logic (a `.ts` with a `.test.ts` beside it; no render tests)

- `frontend/app/view/agents/runstrip.ts` (new):
  - `SEG_FILL`, moved verbatim from `runrailsections.tsx`, and `STRIP_MAX = 24`.
  - `taskStrip(dag, digest)` returns `{ kind: "segments", states: LaneState[] }`, or `{ kind: "bar", done, total }` past `STRIP_MAX`, or `undefined` with no dag or no tasks. It reads `runSegments`.
  - `taskStripLabel(dag, digest)` returns "N of M tasks done", plus ", K asking you" when K > 0.
    - N and M come from `runProgress(dag)`, as does the bar fallback's split. That is the count the row's visible "N/M done" text already shows, where a skipped task counts as done.
    - K counts the `asking` states in `runSegments`.
- `runComplete(run)` goes in `runmodel.ts`, beside `finishedRunLabel`. The tests cover:
  - true: dag done with no land ("run complete"), and land landed;
  - false: landing, land held, run status `finalizing` or `executing` ("lead wrapping up"), cancelled (dag or run), a dag still running, and no dag.
- `stageSubline(outcome, age)` goes in `agenttreemodel.ts`: `[outcome, age].filter(Boolean).join(" · ")`.
- The `laneRows` "lead" text change updates its existing case in `runrail.test.ts`.

## Verification

- Unit: the tests above, run by vitest through `scripts/verify.mjs`.
- Live: a new CDP scenario `agent-tree-rail`, appended at the **end** of `scripts/cdp/scenarios.mjs` and its `SCENARIOS` list. Run a2521425 is appending `narrationFeed` there, and appending last keeps a merge to an adjacent-append conflict.
  - The cockpit fixtures (`scripts/cockpit-fixtures/`) are AgentVM records only. The tree's run lineage reads real `run` and `dag` WaveObjs by `agent.runId`, and `globalStore` is not on `window`, so a fixture cannot fake a run.
  - Arrange creates a real orchestrator run with `createrun { mode: "orchestrator", deferstart: true }`. That persists it in planning with no worker spawned, and `runRoleOf` makes an agent pointing at it a lead.
  - Arrange then writes `public/cockpit-fixtures/active.json` with a roster of: that lead (its `runId` set), two asking agents in two projects, and an idle agent. It reloads the app.
  - The scenario does not submit a dag. The plan gate is gone, so `dagsubmit` would start real workers. The strip and the completed state are therefore covered by the unit tests and by the final verifier's comparison with the prototype, not by this scenario.
  - Asserts:
    - the header and group badges read "N asking";
    - the lead row's leading mark is an svg in a 14px slot;
    - no `↳`, `◆`, `▸`, `▾`, `›_`, `↗` or `‹` text remains in `[data-agent-tree]` or the rail;
    - with the lead focused, the rail's Details and Run headings compute to 10.5px and weight 700, and no text node in the tree or the rail computes below 10.5px;
    - the collapse control holds an svg.
  - Teardown deletes the fixture file, reloads, and removes the run's channel and temp dir.
- Final: `node scripts/cdp/final-verify.mjs agent-tree-rail surface-smoke`. The plan's **Prototype:** line is the tree's `Main.dc.html`.

## Scope and boundaries

- Frontend only: no wire-type, Go or generated-file change.
- Stay out of run a2521425's files (`narrationtimeline.tsx`, `agentsviewmodel.ts`, `markdownmessage.tsx`, `endedtranscript.tsx`, `narrationfeedfixture.tsx`, `modalsrenderer.tsx`) and run ba79c116's (`frontend/app/view/orchestrate/*`). `runrailsections.tsx` keeps importing `dagdigest` and `dagmodalstate` unchanged.
- The `.superpowers/design/agent-tree` and `agent-rail` folders stay; the user removes them after this ships.

## Open

- The agent header (`agentheader.tsx`) still prints a ◆ before a focused lead's name; it is outside the tree
  and the rail, so this spec did not cover it.
- Never seen live: the task strip, the completed-run state, fold chips and guides for
  workers/stages/subagents, terminal rows, and the rail's lanes, run bar and LaneAsk card. The
  `agent-tree-rail` scenario creates no dag and its fixture has no terminals or subagents.
