# Cockpit surface polish

**Status:** Approved design, not built.

The Cockpit surface (`frontend/app/view/agents/cockpitsurface.tsx` and what it renders: `agentrow.tsx`,
`leadcard.tsx` with `leadcardmodel.ts`, `attentioncard.tsx`, `answerbar.tsx`, `cockpiteventsrail.tsx`,
`idlesection.tsx`, `backgroundedsection.tsx`, `sectionheader.tsx`, `usagemeters.tsx`, `projectswitcher.tsx`, and
the shared `statusline.tsx`) moves onto the Jarvis brief type scale (`frontend/app/view/jarvis/briefstyle.ts`):
nothing under 10.5px, lucide icons in place of text glyphs, chips that say what they count, and the tree's
Workflow mark and task strip on the lead card. Frontend only: no wire type or Go change.

## The design is the mockups

Two approved interactive canvases are the spec. They are gitignored, so read them from the main checkout:

- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/cockpit-polish/project/Main.dc.html` draws the whole
  Cockpit with a live-like roster: a running orchestrator lead card, an asking agent, a working agent, a finished
  agent, a landed run, the Events rail, and the Backgrounded and Idle sections. A toggle switches Today and Polished.
- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/cockpit-polish/project/Cards.dc.html` draws one card,
  Today and Polished side by side. Its toggles cover four agent states (working, quiet, asking, finished), twelve
  run states (planning, running, worker asks you, worker asks the lead, review failed, lead asks you, lead down,
  wrapping up, landed, cancelled, no lead, 30 tasks), the task-list popover, the subagents peek, and the lead
  transcript pane.
- Serve them with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from the main
  checkout. If port 8766 already answers, they are being served.

Each board's script holds two style tables, `TODAY` and `POLISHED` (search for `const POLISHED`). TODAY is a
transcription of today's classes, so **the difference between TODAY and POLISHED is the change list**; POLISHED
holds the exact values. The script also holds the logic the mockup draws with: `leadSlot` (the lead's leading
icon), `barVM` (the progress bar), `eventsVM` (the Events icons), and `agentCard` / `leadCard` (chip labels).
Where this spec names a value it restates the table; it does not override it.

Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`. The mockups' hex values are those
tokens transcribed. No new tokens, no raw hex or rgba, no emoji.

## Decisions

### 1. Type scale

Nothing on the Cockpit renders below 10.5px. `REGION_LABEL` is mono 10.5px bold uppercase, 0.1em tracking.

- Card names (agent and lead cards) go from mono to **sans 13.5px semibold** in `text-primary`; the project chip
  goes to 10.5px. Both live in `StatusLine` (`statusline.tsx`), which is **changed in place**: the orchestrator's
  DAG overview worker rows and DAG detail rail, which also render it, get the same name and chip.
- Section labels inside cards (Waiting, Done, Lead, Task list, Decisions in it) use `REGION_LABEL` in `text-muted`
  (`SubLabel` from `sectionlabel.tsx`, or `REGION_LABEL` directly where the element must be a button or fold).
  `leadcard.tsx`'s local `SECTION_LABEL` goes.
- The Events rail title uses `REGION_LABEL` in `text-ink-mid` (`SectionLabel`); its section headings (New · N,
  Earlier) use `REGION_LABEL` in their current colour.
- The attention banner label is `REGION_LABEL` in `text-on-warning`; its meta line and `BannerChip` are mono 10.5px.
- The finished strip's "Finished" label is `REGION_LABEL` in `text-accent-soft`; its age and diff are mono 10.5px.
- Everything else that is 9-10px today goes to 10.5px: key hints (kbd), the task popover eyebrow (`REGION_LABEL`)
  and count, the subagent peek state (coloured by state, as the mockup), the answer bar's number boxes and
  "recommended" pill (no uppercase), the "N asking you" badge (`bg-askingbg`, `text-warning`), the no-lead tag, a
  failed review's Round label (`text-error`) and number keys, a row's inline kbd, the lead pane age, Events tags
  (no uppercase) and ages, idle and backgrounded row ages (mono), the usage meters' short labels, the runtime mark,
  and the project switcher's small labels.

### 2. Chips say what they count

"⑃ 3" becomes "3 subagents"; "3/5" becomes "3/5 tasks" (the activity chip and the attention banner's chip). Chips
are 20px high, 5px radius, mono 10.5px semibold in `text-ink-mid`. The labels come from a pure function with a test.

### 3. Icons (lucide-react)

- `>_` → `SquareTerminal`; `↗` → `ArrowUpRight` (Open, Open in Code, DAG); `✓` → `Check`; `✕` → `X`; the composer
  `+` → `Plus`; `▾` / `▸` folds → `ChevronDown` / `ChevronRight`.
- The row tag `→ lead` (built in `leadcardmodel.ts`) becomes an `ArrowRight` icon plus "lead": the model says the
  row is to-lead, and the tag text drops the arrow.
- The attention banner on the Cockpit's agent and lead cards shows the pulsing on-warning dot, not ◆
  (`glyph="dot" pulse`). The Runs review gate cards (`runcards.tsx`) keep their ◆; `AttentionBanner` keeps both glyphs.
- Events rail: asked = `MessageCircleQuestion` (warning), answered = `CornerDownRight`, finished = `Check`,
  went quiet = `CircleDashed` (warning), failed = `X` (error), you told = `MessageSquare`, landed = `GitMerge`
  (success). Tones otherwise as today. A grouped run row shows `Workflow` 11px in `text-muted` before the name, in
  place of "◆ ".

### 4. Lead card leading mark

The `Workflow` icon (13px) replaces the ◆ plus status dot, matching the agent tree. `StatusLine` gains an optional
`mark` prop that replaces its `QuietDot`; the lead card passes the icon. A no-lead card shows the same icon before
the run title. Its state is a pure function in `leadcardmodel.ts`, with a test, as the mockup's `leadSlot`:

| Condition (first match) | Colour | Pulse |
|---|---|---|
| `runComplete(run)` (`runmodel.ts`) | `text-success` | no |
| no lead | `text-muted` | no |
| lead standing by (`leadStandingBy`) | `text-muted` | no |
| lead working | `text-accent` | yes |
| lead asking | `text-warning` | yes |
| otherwise (idle, cancelled) | `text-muted` | no |

"lead wrapping up" and "run cancelled" are not complete.

### 5. A complete run's activity line

When `runComplete(run)`, the activity line shows `Check` plus the land label ("landed" / "run complete") in
`text-success`. Otherwise it stays `text-accent-soft`.

### 6. One progress bar with the tree and the rail

`leadcard.tsx`'s `TONE_SEG` goes; the bar uses `taskStrip` / `taskStripLabel` / `SEG_FILL` from `runstrip.ts`.
Past `STRIP_MAX` (24) tasks it is one done/total bar. The bar is `role="img"` with `taskStripLabel` as its
`aria-label`. The colour changes this brings are accepted: merge-waiting turns green (done), reviewing turns
accent, stalled turns red, as in the rail. `LeadCardVM.segs` goes with it; `RowTone` stays because `TONE_DOT`
and `runningCount` use it. The bar's decision (segments, one bar, or none when there is no plan, plus its label)
is a `bar` field `buildLeadCard` fills from `taskStrip` / `taskStripLabel`, tested in `leadcardmodel.test.ts`.

### 7. Inline blocks

A worker's question answered inside its row, and a failed review's findings: no `border-l-2` warning stripe. A 1px
`border-edge-mid` card, 8px radius, `bg-surface-raised`, padded 9px by 11px, 30px left margin, 8px gap (POLISHED
`inline`).

### 8. Backgrounded section header

`BackgroundedSection` uses the same `SectionHeader` as Idle: dot `bg-accent/50`, "Backgrounded", the "still
running" note, the count pill, the divider. `SectionHeader`'s `caret` string becomes an `open` flag that draws
`ChevronRight` / `ChevronDown`; Idle and `backgroundagentsstrip.tsx`, its other callers, pass it too.

### 9. Unchanged

The finished plain agent keeps its accent-soft "Finished" strip (green is only for a complete run). The cockpit
layout, grid and tabs, handlers and keybindings, the narration feed inside cards, the open composer, the
Adjust/Cancel panels, the Tell input, and motion do not change.

## Shared components

`AttentionBanner` / `BannerChip` (`attentioncard.tsx`), `AnswerBar` (`answerbar.tsx`), `SectionHeader`
(`sectionheader.tsx`) and `StatusLine` (`statusline.tsx`) change in place. Their size changes reach the channel
escalation card, the child ask card, the Runs review gate, the Agent surface's answer bar, the background agents
strip, and the orchestrator DAG overview and detail rail. That is accepted.

## Testing

- Pure logic in `.ts` with a `.test.ts` beside it: the lead mark state (decision 4), the lead bar (decision 6:
  none without a plan, segments up to 24 tasks, one bar past it, and the "N of M tasks done" label), and the chip
  labels (decision 2). The Events icon map is a static lookup in the component and needs no test. No jsdom render tests.
- A CDP scenario, `cockpit-polish`, at the end of `scripts/cdp/scenarios.mjs`. `scripts/cockpit-fixtures/` holds
  agent rosters only, not runs, so the scenario uses `agent-tree-rail`'s setup: `createrun` (orchestrator,
  `deferstart`) and a fixture roster whose lead agent carries the run id. It calls **no `dagsubmit`**: a submit
  dispatches real workers before it returns. The run therefore has no plan and its card shows no bar; the bar is
  proven by the model test above. On the Cockpit it asserts: no text element inside the Cockpit surface's
  container has a computed font size under 10.5px, and the lead card's leading mark is an svg (the Workflow icon).
  Teardown removes the run, channel and fixture as `agent-tree-rail` does.
