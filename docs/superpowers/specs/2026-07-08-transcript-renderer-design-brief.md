# Design brief — Cockpit transcript renderer

**For:** design (visual + interaction)
**Product:** Wave Terminal (fork) — an agent-cockpit UI that supervises many live AI coding agents (Claude Code, Codex) at once.
**Surface:** the per-agent **transcript feed** inside each agent card.

## What this is

The cockpit shows a grid of **agent cards** (2 columns × 3 rows fills one screen; each card min ~96px tall, resizable). Each card streams a **live transcript** of one coding agent working: the agent's prose, the user's messages, and the tool calls it makes (Read, Grep, Edit, Bash, …). It updates in real time as the agent works.

## Goal

Redesign the transcript feed to feel like the **Claude mobile app conversation view**, adapted to this cockpit.

## Current state (what ships today)

- **Assistant message** — small accent avatar + prose. Markdown is rendered, but code blocks are plain/unstyled.
- **User message** — right-aligned rounded bubble with a small "You" label.
- **Tool call** — one dim monospace line: `[✓/✗] VERB target` (e.g. `✓ EDITED auth.ts`). No output or detail is shown.
- **Burst** — 3+ consecutive tool calls collapse into one summary line.

## Known problems

- **Tool results are discarded.** You can't see a diff, command output, grep matches, or an error message — only a pass/fail glyph.
- **Code blocks aren't styled** — no language label, copy, or syntax highlighting.
- **No way to inspect what a tool actually did.**

## Constraints

- **Small card among many.** The feed lives in a compact card; operators scan several agents at once. Screen space is scarce.
- **Live / streaming.** Content appends in real time; a card shows a pulsing indicator while its agent is actively working.
- **Two runtimes, one contract.** Claude Code and Codex transcripts both feed the same render model, so the design must be tool/verb-driven, not vendor-specific.
- **Deterministic, LLM-free.** Nothing is summarized by a model — everything shown is parsed straight from the raw transcript JSONL. The raw lines *do* contain each tool's inputs and results (file contents, grep matches, diffs, command output, exit codes, error text); these are currently discarded but available to use.
- **Dark theme, WebView2 (Chromium).** Modern CSS is fine.

## Visual system (exact tokens)

Periwinkle accent. Fonts: **Hanken Grotesk** (sans), **JetBrains Mono** (mono/code).

```
Surfaces  bg #0c0e11 · surface #0e1116 · raised #13171d · code #0b0d10 · card-lane #12161b · selected #1a222c
Text      primary #e6e9ed · secondary #cfd5db · ink-mid #9aa3ad · muted #6b7178 · faint #4f565f
Borders   border #1c2128 · edge-mid #20262e · edge-strong #2a313a · edge-faint #161a20
Accent    #7c95ff (main) · soft #aebfff · bg rgba(124,149,255,.12)
Status    success #54c79a · error #e0726c · asking/amber #e6b450
Feed meta tool label #777f89 · tool summary #9aa3ad · faint meta #4f565f
Provider  claude #d97757 · codex #96aacd
Radii     sm 6 · base 8 · lg 12
```
