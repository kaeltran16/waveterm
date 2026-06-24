# Agents Markdown Renderer — Insight Callouts, Tables & CSS Gaps

Date: 2026-06-23
Status: Approved (design)

## Problem

`MarkdownMessage` (`frontend/app/view/agents/markdownmessage.tsx`) renders every
`message` entry in the focus-panel timeline. It runs the text through
`ReactMarkdown` + `remarkGfm` with a small hand-written `.agent-md` CSS block.
Two cases render badly today, plus several markdown elements have no styling at
all:

- **Insight callouts.** The explanatory output-style block —
  `` `★ Insight ───…` `` / points / `` `───…` `` — wraps its top and bottom
  rules in backticks, so `ReactMarkdown` renders them as inline `code` spans.
  The result is two dash-filled "pills" framing the text, never a real callout.
- **Tables.** `remarkGfm` parses `| col | col |` tables, but `.agent-md` has
  **zero** `table`/`th`/`td` CSS, so they fall back to the browser's borderless
  default — cramped and unreadable. A wide table also blows out the narrow
  focus-panel width because there is no overflow handling.
- **CSS gaps.** `.agent-md` styles only `p`, `ul`/`ol`, `code`, `pre`, `h1`–`h3`.
  **Blockquotes, links, GFM task lists, and `h4`–`h6`** are unstyled and render
  just as roughly when an agent uses them.

## Approach

A presentation-only pass over `MarkdownMessage` + the `.agent-md` CSS. No change
to the data projection (`transcriptprojection.ts` still discards `tool_result`),
the `AgentEntry` model, or the action-strip rendering. The visual treatments are
the ones approved in `.superpowers/brainstorm/` (insight = "accent left-border +
label"; tables = header accent rule + subtle zebra + horizontal scroll).

Insight detection uses a **deterministic split** of the message text into
text/insight segments (model-for-judgment is not needed — the marker is a fixed
format). Considered alternatives:

- **Regex preprocess into a blockquote** — rejected: markdown has no callout
  node, so the inner bullets/bold would have to be re-encoded line-by-line.
- **Custom remark plugin** — rejected as YAGNI: a whole AST plugin for one known
  literal pattern.
- **Segment split + dedicated component (chosen).** A pure, testable function
  splits the text; insight segments render through a small `InsightCallout` that
  re-runs its inner content through the same markdown pipeline, so bullets/bold
  inside an insight still work.

## Design

### Insight split helper (`insightblocks.ts`, new — pure, testable)

```ts
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "insight"; text: string };

export function splitInsightBlocks(text: string): MessageSegment[];
```

- Scan lines. An **opener** is a line matching `/^`?★\s*Insight\b[\s─-]*`?$/`
  (tolerant of the optional wrapping backticks and the trailing rule dashes). A
  **closer** is the next line matching `/^`?[─-]{5,}`?$/` (a run of box-drawing
  `─` or hyphen dashes, optionally backtick-wrapped).
- Content lines strictly between opener and closer become one `insight` segment.
  Text before/after/between blocks becomes `text` segments. Empty text segments
  (e.g. an insight at the very start) are dropped.
- An opener with **no** matching closer is left untransformed (the whole text is
  one `text` segment) — never swallow the rest of a message on a malformed block.
- Multiple insight blocks in one message are all handled.

### `MarkdownMessage` rewrite (`markdownmessage.tsx`)

- Map `splitInsightBlocks(text)` to segments. `text` → the existing
  `ReactMarkdown` render; `insight` → `<InsightCallout>` (below).
- Add a shared `components` map to `ReactMarkdown` (used by both the top-level
  render and the one inside `InsightCallout`):
  - `a`: render `<a className="text-accent hover:underline cursor-pointer">`
    with `onClick` → `e.preventDefault(); openLink(href)` (from
    `@/store/global`), matching `element/markdown.tsx`. **Not** `target=_blank`
    (wrong under Electron).
  - `table`: wrap the table in `<div className="agent-table-wrap">` so wide
    tables scroll horizontally inside the panel instead of breaking layout.
- `InsightCallout` (same file, Tailwind utilities — consistent with the
  timeline components): accent left-border + faint accent tint + a small
  uppercase `★ Insight` label, with the inner content rendered via the same
  markdown pipeline. Approximate classes:
  `my-2.5 rounded-r border-l-2 border-accent bg-accent/[0.05] py-2 pl-3 pr-2`,
  label `mb-1 text-[10px] font-bold uppercase tracking-wider text-accent`.
  Font size inherits from the surrounding message wrapper (the `large` sizing in
  `narrationtimeline.tsx` is set on the parent), so no new prop is needed.

### `.agent-md` CSS additions (`tailwindsetup.css`)

Appended to the existing `.agent-md` block. The insight callout and links are
component-driven (Tailwind); these are for `ReactMarkdown`-generated elements:

- `.agent-table-wrap { overflow-x: auto; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; margin: 0.5em 0; }`
- `.agent-md table { border-collapse: collapse; font-size: 0.92em; white-space: nowrap; }`
- `.agent-md th { text-align: left; font-weight: 600; padding: 6px 12px; background: rgba(255,255,255,0.04); border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent); }`
- `.agent-md td { padding: 5px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }`
- `.agent-md tr:nth-child(even) td { background: rgba(255,255,255,0.015); }` (zebra)
- `.agent-md blockquote { border-left: 3px solid rgba(255,255,255,0.18); padding-left: 12px; margin: 0.4em 0; color: var(--secondary-text-color); font-style: italic; }`
- `.agent-md .task-list-item { list-style: none; }` and
  `.agent-md .task-list-item input[type="checkbox"] { margin-right: 6px; accent-color: var(--color-accent); }`
  (GFM emits `<li class="task-list-item"><input type=checkbox disabled>`)
- `.agent-md h4 { font-size: 0.95em; font-weight: 700; margin: 0.4em 0 0.15em; }`,
  `.agent-md h5 { font-size: 0.9em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }`,
  `.agent-md h6 { font-size: 0.85em; font-weight: 600; color: var(--secondary-text-color); }`

Confirmed tokens (matching the timeline's existing `text-accent` / `text-secondary`):
accent = `var(--color-accent)` (`rgb(88,193,66)`, green); secondary text =
`var(--secondary-text-color)`. The subtle backgrounds/borders use raw `rgba`
literals to match the style of the existing `.agent-md` rules. The mockups showed
a teal accent for contrast; the real accent is green and treatment A was approved
on shape, so `InsightCallout` uses `border-accent` / `bg-accent` (the green token).

## Non-Goals

- **Syntax highlighting** of fenced code blocks — out of scope (pulls in a
  highlighter dependency; separate decision). Code blocks keep today's `pre`/
  `code` styling.
- No remark/rehype plugins beyond the existing `remarkGfm`.
- No change to `transcriptprojection.ts`, the `AgentEntry` model, the action
  strips, or the collapse/group behavior.
- No raw-HTML support (`rehypeRaw` stays off — transcript text must not inject
  markup).

## Testing

- Unit tests for `splitInsightBlocks` in `insightblocks.test.ts` (pure, mirrors
  `transcriptprojection.test.ts` style):
  - plain text → one `text` segment;
  - backtick-wrapped insight block → `[text, insight, text]` with the rule lines
    stripped and inner content preserved;
  - insight block **without** backticks → still detected;
  - opener with no closer → untransformed (single `text` segment);
  - two insight blocks in one message → both produced;
  - insight at start/end → no empty `text` segments.
- CSS and the `InsightCallout` / custom-`components` rendering are thin
  presentation glue, verified visually in the dev app (CDP on :9222): insight
  callout, a wide table scrolling within the panel, blockquote, a link, a task
  list, and `h4`–`h6`.

## Implementation

TDD-first on the pure helper; the markdown/CSS glue is verified visually.

1. **(RED)** Add `insightblocks.test.ts` covering the six cases above.
2. **(GREEN)** Add `insightblocks.ts` with `MessageSegment` + `splitInsightBlocks`.
   Tests green.
3. Rewrite `markdownmessage.tsx`: segment split, shared `components` map
   (`a` → `openLink`, `table` → `.agent-table-wrap`), and the `InsightCallout`
   component (Tailwind, treatment A).
4. Append the `.agent-md` CSS in `tailwindsetup.css` (table/th/td + wrap,
   blockquote, task list, `h4`–`h6`); confirm the accent / secondary token names.
5. Run the agents test suite; visual-verify all six elements in the dev app.
