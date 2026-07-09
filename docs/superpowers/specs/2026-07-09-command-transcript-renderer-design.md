# Command transcript renderer — design

Date: 2026-07-09
Status: approved (design), pending implementation plan
Scope: `frontend/app/view/agents/` transcript rendering (Claude Code transcripts only)

## Problem

`transcriptprojection.ts` maps every `type:"user"` transcript record to `{kind:"user", text}`, which `narrationtimeline.tsx` renders as a right-aligned "You" bubble. Three kinds of `user` records are not user prose and render badly:

1. **Slash commands** (`/clear`, `/review …`) arrive as a string containing `<command-name>…</command-name>`, `<command-message>…</command-message>`, `<command-args>…</command-args>`. The raw XML tags render inside the You bubble.
2. **Skill invocations** (`/brainstorming …`) route through a `Skill` tool_use, and Claude Code then injects the **entire skill body** as a synthetic `user` text record. Thousands of tokens of skill markdown render as a You bubble.
3. **Compaction** (`/compact` and auto-compaction) writes a synthetic `user` record (`isCompactSummary:true`) whose content is the full continuation summary. The whole summary renders as a You bubble.

Additionally, several other synthetic `user` records (local-command caveats, "Continue from where you left off", pasted-image placeholders) render as spurious You bubbles.

## Wire format (ground truth)

Verified against `~/.claude/projects/.../*.jsonl` (Claude Code 2.1.205).

**Slash command** — `type:"user"`, string content:
```
<command-name>/clear</command-name>
            <command-message>clear</command-message>
            <command-args></command-args>
```
`command-name` includes the leading slash. `command-args` may be empty. `<local-command-stdout>` output lives in a separate `type:"system"` record (already skipped by projection).

**Skill invocation** — `type:"assistant"` tool_use:
```json
{"type":"tool_use","name":"Skill","input":{"skill":"superpowers:brainstorming","args":"…"},"caller":{"type":"direct"}}
```
All observed skill calls are `caller.type:"direct"` (user-typed `/skill`). The skill body arrives as a separate `type:"user"` record with `isMeta:true` + `sourceToolUseID`.

**Compaction** — two adjacent records:
- `type:"system"`, `subtype:"compact_boundary"`, `content:"Conversation compacted"`, `compactMetadata:{trigger:"manual"|"auto", preTokens, postTokens, durationMs, …}`.
- `type:"user"`, `isCompactSummary:true`, `isVisibleInTranscriptOnly:true`, string content = full summary. (This record is **not** `isMeta`.)

**Synthetic `user` records** — `isMeta:true`. Across 30 transcripts these are exclusively: skill-body injections, `<local-command-caveat>`, "Continue from where you left off." (post-compaction), and `[Image: source:…]` placeholders. `isMeta:true` reliably means "system-injected, not a real user turn."

## Design

### New `AgentEntry` kinds (`agentsviewmodel.ts`)

```ts
| { kind: "command"; name: string; args?: string; isSkill?: boolean }
| { kind: "compaction"; trigger?: string; preTokens?: number; postTokens?: number; summary?: string }
```

`command` covers both slash commands and skills (they render as near-identical chips); `isSkill` selects the skill variant. One kind + one flag keeps parsing and rendering DRY.

### Projection (`transcriptprojection.ts`)

**`type:"user"` branch** — decide in this order, before any existing user-text handling:

1. `rec.isMeta === true` → **skip the record entirely** (skill bodies, caveats, continuation prompts, image placeholders).
2. `rec.isCompactSummary === true` → produce a **compaction** entry carrying `summary` (the string content). Never a user entry.
3. string content matching `<command-name>` → parse `name` (trimmed; normalized to exactly one leading slash) and `args` (trimmed; omitted when empty); drop `<command-message>`; push `{kind:"command", name, args}`.
4. otherwise → existing user-text handling (string or `text` blocks), unchanged.

**`type:"assistant"` branch, `Skill` tool_use** — instead of the current `{kind:"action", verb:"skill"}`, push `{kind:"command", name: leaf(input.skill), args: input.args, isSkill:true}`, where `leaf()` takes the segment after the last `:` (`superpowers:brainstorming` → `brainstorming`). Do not register it in `actionById`; any later Skill `tool_result` then finds no action and is skipped (existing behavior for unmatched results).

**New `type:"system"` branch** — `subtype:"compact_boundary"` → read `compactMetadata` into a **compaction** entry (`trigger`, `preTokens`, `postTokens`).

**Merging compaction records.** The boundary and summary are separate, adjacent records; either may be absent. Track a `lastCompaction` reference: when the boundary or summary produces a compaction entry, attach to `lastCompaction` if it exists and lacks that field, else create a new entry and set `lastCompaction`. Reset `lastCompaction = null` whenever any non-compaction entry is pushed. This is order-independent and degrades cleanly (stats-only or summary-only).

### Rendering (`narrationtimeline.tsx`)

- **`command` → `CommandChip`** — a right-aligned monospace pill.
  - Slash command (`!isSkill`): accent hue (`accent`/`accent-soft`), no glyph, name shown with its slash. Args, when present, follow behind a faint left divider.
  - Skill (`isSkill`): distinct hue, a `✦` mark, leaf name (no slash). Same args treatment.
  - Standard pill padding (not compacted).
- **`compaction` → `CompactionDivider`** — a centered horizontal marker: `— Compacted · {preTokens→postTokens} · {trigger} —`. When `summary` is present, the marker is clickable and expands a `surface-code` box rendering the summary via the existing `MarkdownMessage`. Token counts via a small `formatTokens(n)` helper (`415k`, `1.2M`).

All colors via `@theme` tokens (add a skill hue token if none fits); no raw hex, no SCSS.

### Consumers updated

- **`groupTimeline` (`agentsviewmodel.ts`)** — `command` and `compaction` are standalone timeline items (flush the current action run, then push the item). Add both to the `TimelineItem` union with an `index`.
- **`conversationText`** — include `command` as a line (`/name args`, or `✦ name args` for skills); skip `compaction` (not conversation).
- **`recentactivity.ts` `describe()`** — `command` → text `name + args`, label `"skill"` (skill) or `"command"`; `compaction` → text `"Conversation compacted"`, label `"compacted"`.

## Scope / non-goals

- **Claude only.** `codextranscriptprojection.ts` uses a different format (`$skill`, `<skill>`) and already strips it; it is untouched. Adding the new kinds to the shared unions does not affect Codex (it never emits them).
- **No new RPCs, no backend changes.** Pure frontend projection + render.
- Not addressed here (separate items from the same batch): cockpit double-click nav, Usage-tab staleness (a debugging pass).
- **Bundled into the plan** (not this design, but adjacent code — see below): markdown in the recent-activity peek.

## Bundled plan item: markdown in the recent-activity peek

Separate from the transcript-renderer design, but rides along in the same implementation plan because it touches the same recent-activity path.

**Problem.** The cockpit recent-activity peek (`cockpitsurface.tsx`, ~line 1076) renders `e.text` — the newest entry's text — raw, inline beside the agent name. When that text is a Claude message it contains markdown, so `**bold**`, `` `code` `` etc. show as literal syntax.

**Approach.** Render **inline markdown only**, condensed to a single line — not the block `MarkdownMessage`. A small `InlineMarkdown` renderer (or a `renderInline(text)` helper) handles bold/italic/inline-code/links and strips block syntax (headings, list bullets, blockquotes) and newlines to keep the peek one line. The peek stays a compact `agent-name + preview` row; no block elements, no layout growth.

**Testing.** Unit-test the inline transform: `**x**`→bold, `` `y` ``→code, `[t](u)`→link, `## h`→`h` (stripped), multi-line→single line.

## Testing

`transcriptprojection.test.ts`:
- `<command-name>` string → `{kind:"command", name, args}` (with and without args; slash normalization).
- `Skill` tool_use → `{kind:"command", name: leaf, args, isSkill:true}`; redundant skill body (`isMeta`) skipped.
- `isCompactSummary` + `compact_boundary` → one merged `{kind:"compaction", trigger, preTokens, postTokens, summary}`.
- summary-only and boundary-only → compaction entry with the available fields.
- `isMeta:true` user record → skipped (no entry).

`agentsviewmodel.test.ts`:
- `groupTimeline` passes `command`/`compaction` through as standalone items and still flushes action runs correctly.

## Resolved design choices (visual companion)

- Slash command: slash-only name, **no** glyph (the slash is the marker), standard pill density.
- Skill: **distinct** chip (own hue + `✦`), **leaf** name.
- Compaction: divider **with** trigger + token reduction; summary **expandable** (variant B), not dropped.
- Synthetic `isMeta` records: suppressed.
