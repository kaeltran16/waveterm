# Agents Timeline — Collapse Consecutive Action Runs

Date: 2026-06-23
Status: Approved (design)

## Problem

The focus-view panel (and the expanded list row) render a single chronological
`NarrationTimeline` that interleaves reasoning prose (`message`), user turns
(`user`), and tool executions (`action`). Bursts of back-to-back tool calls
(e.g. eight reads in a row) push the prose apart and off-screen, so the agent's
reasoning "story" becomes hard to follow.

We considered three fixes: (A) auto-collapse consecutive action runs, (B) a
global hide-actions toggle, (C) both. The clutter is **not uniform** — a lone
action between two paragraphs reads fine; the pain comes from *bursts*. A
targets bursts precisely while preserving causal chronology and the
"what did it touch" signal. B bluntly removes the whole category. **A was
chosen.** B/C are out of scope (see Non-Goals).

## Approach

Keep the single chronological timeline. Fold any maximal run of **3 or more
consecutive `action` entries** into one summary line that sits exactly where
the run occurred. Runs of 1–2 actions stay inline (unchanged from today).
`message` and `user` entries are never folded.

### Auto-collapse rule (live vs. settled)

- A run auto-collapses once it is **settled** — i.e. another entry follows it,
  or the agent is no longer working.
- The **active trailing run** stays expanded so the live panel still shows work
  as it lands. "Active" = `agent.state === "working"`; "trailing" = the run is
  the last item in the timeline (nothing after it).
- When the agent narrates again (a `message`/`user` follows) or goes
  idle/asking, the previously-active run folds like the rest.
- **Manual expand wins and sticks**: clicking a folded run expands it and it
  stays expanded; clicking only ever expands (folding is automatic).

## Design

### Data — grouping helper (`agentsviewmodel.ts`)

Add a pure, testable transform from `AgentEntry[]` to a list of render items:

```ts
export const CollapseRunThreshold = 3;

export type TimelineItem =
  | { kind: "message"; text: string; index: number }
  | { kind: "user"; text: string; index: number }
  | { kind: "action"; action: AgentActionEntry; index: number }      // short run (1–2), inline
  | { kind: "group"; startIndex: number; actions: AgentActionEntry[] };

export function groupTimeline(entries: AgentEntry[], threshold = CollapseRunThreshold): TimelineItem[];
```

- Walk entries; accumulate maximal runs of consecutive `action` entries. A run
  of length `>= threshold` becomes a single `group` item (keyed by the run's
  first entry index, stable because entries are append-only). Shorter runs emit
  individual `action` items. `message`/`user` pass through as themselves.
- A small summary helper derives the group's label and aggregate outcome:
  - **total** count and a per-verb breakdown ordered by count desc, then first
    appearance: `6 tools · 5 read · 1 grep`.
  - **outcome**: `fail` if any action in the run failed, else `ok`.

`recentActions` / `latestMessageText` (used for the collapsed-row preview) are
unrelated and untouched.

### Rendering (`narrationtimeline.tsx`)

- Render from `groupTimeline(entries)` instead of mapping raw entries.
- `message`, `user`, and inline `action` items render exactly as today.
- A `group` item renders as a collapsible summary line styled as a faint accent
  strip: `▸ 6 tools · 5 read · 1 grep ✓` (✗ + error color when `outcome` is
  `fail`). Clicking toggles expansion to the individual action strips.
- New prop `active?: boolean`. A group renders **expanded** when it is in the
  local expanded set **or** (`active` and it is the trailing item); otherwise
  collapsed.
- Expanded state: local `useState<Set<number>>` keyed by `startIndex`. Click a
  collapsed group → add its `startIndex`. (No need to track manual collapse;
  folding is the default.)

### Call sites

- `focusview.tsx:160` — pass `active={agent.state === "working"}`.
- `agentrow.tsx:189` — pass `active={agent.state === "working"}`.

### Visual

- Collapsed line: dim monospace, left border in `accent/50`, faint
  `accent/6` background, a `▸` chevron in accent, the count in a brighter
  secondary tone, trailing `✓`/`✗`. Matches the mockups in
  `.superpowers/brainstorm/`.
- Expand/collapse is an instant toggle (optionally a light fade reusing the
  existing entry `initial/animate`). No height-spring animation for v1 (YAGNI).

## Non-Goals

- No global hide-all-actions toggle (Option B/C). Can be added later if
  collapsing alone proves insufficient.
- No surfacing of `tool_result` content / full command args — the projection
  still discards these; the summary shows verb + target counts only.
- No height animation on expand/collapse for v1.

## Testing

- Unit tests for `groupTimeline` in `agentsviewmodel.test.ts`:
  - run of 2 actions stays inline (two `action` items, no `group`);
  - run of 3+ becomes one `group` with correct ordered verb breakdown and total;
  - `message`/`user` split adjacent runs into separate groups;
  - aggregate `outcome` is `fail` when any action failed, else `ok`.
- Component behavior (active trailing run expanded; manual expand sticks) is
  thin glue over the tested helper and is verified visually in the dev app.

## Known Minor Issues (accepted for v1)

- Manual expand/collapse changes panel height without changing `entries.length`,
  so the focus-view scroll-stick effect does not re-run on toggle. Acceptable:
  expanding a past run while stuck to bottom preserves position; not worth extra
  logic in v1.

## Implementation

TDD-first on the pure helper; the React glue is verified visually.

1. **(RED)** Add `groupTimeline` tests to `agentsviewmodel.test.ts`:
   - run of 2 actions → two inline `action` items, no `group`;
   - run of 3 → one `group`, `startIndex` = first action's entry index;
   - `message`/`user` between runs splits them into separate groups;
   - verb breakdown ordered by count desc then first appearance
     (`5 read · 1 grep`); total count correct;
   - aggregate `outcome` = `fail` if any action failed, else `ok`.
2. **(GREEN)** In `agentsviewmodel.ts`: add `CollapseRunThreshold = 3`,
   `TimelineItem`, `groupTimeline()`, and the summary helper. Tests green.
3. **(REFACTOR + glue)** Rewrite `narrationtimeline.tsx` to render from
   `groupTimeline(entries)`. Keep `message`/`user`/inline-`action` rendering
   unchanged. Add `group` rendering: collapsed summary line ↔ expanded strips.
   Add `active?: boolean` prop and local `useState<Set<number>>` of expanded
   `startIndex`es; a group is expanded when in the set OR (`active` && trailing).
4. Thread `active={agent.state === "working"}` in `focusview.tsx` and
   `agentrow.tsx`.
5. Run the agents test suite; visual-verify in the dev app (burst folds; live
   trailing run expanded; click expands and sticks).
