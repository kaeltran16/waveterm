# Agents Surface Palette Re-skin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebind every color on the Agents tab and the session-sidebar agent UI from a hardcoded GitHub-dark palette to Wave's native `@theme` design tokens, with no change to layout, spacing, type sizes, interactions, or animations.

**Architecture:** Pure visual re-skin. Static `className` colors become Tailwind theme utility classes (e.g. `bg-[#0b0e14]` → `bg-background`); inline-`style` JS color maps become CSS `var(--color-*)`. The single source of truth is the existing `@theme` block in `frontend/tailwindsetup.css`. No new constants, no abstraction layer, no backend/RPC/codegen changes. The status-reporter wire-protocol constants (`COLOR_WORKING`/`COLOR_WAITING`) are deliberately left untouched.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 (theme tokens auto-generated from `@theme`), `motion` (framer-motion) for animation (untouched here), Vitest for unit tests.

**Spec:** `docs/specs/2026-06-19-agents-tab-palette-reskin-design.md`

---

## Canonical token map (used by every task)

This is the single mapping all tasks follow. The three text tiers collapse the current grey scatter while preserving hierarchy (brightest → dimmest).

| Current hex (className) | → Tailwind class |
|---|---|
| `#0b0e14` (canvas) | `bg-background` |
| `#1c2230`, `#20242b`, `#2a2f3a`, `#2c3340` (borders) | `border-border` (or `bg-border` for divider fills) |
| `#f0f6fc`, `#e6edf3` (bright/titles) | `text-primary` |
| `#dde3ea`, `#c9d1d9`, `#adbac7`, `#9aa4b2` (mid grey) | `text-secondary` |
| `#8b949e`, `#7d8896`, `#6b7585`, `#7d8590`, `#4a5260` (dim grey) | `text-muted` (or `border-muted` for the quiet-dot border) |
| `#3fb950` (working / live / ✓) | `accent` → `bg-accent` / `text-accent` / `border-accent` |
| `#238636` (selected/submit fill) | `bg-accent/80` + `text-primary` + `hover:bg-accent` (Wave's documented accent-button idiom) |
| `#d29922` (asking / blocked) | `warning` → `bg-warning` / `text-warning` / `border-warning` |
| `#f85149` (fail / ✗) | `text-error` |
| `#429dff`, `#1f6feb` (blue active-row / "new" pill) | `accent` |

| Inline-`style` JS color | → CSS var |
|---|---|
| working | `var(--color-accent)` |
| waiting / asking | `var(--color-warning)` |
| idle / neutral marker | `var(--color-muted)` |
| failure | `var(--color-error)` |

**Kept as-is on purpose (do NOT change):** neutral white-alpha overlays (`hover:bg-white/[0.04]`, `bg-white/[0.06]`, `bg-[rgba(255,255,255,0.08)]`), the sidebar container glass (`background: rgba(0,0,0,0.55)` + `backdropFilter: blur(20px)`), the drop-shadow on the sidebar, all `rounded-*`, all `text-[Npx]` sizes, all spacing, all `motion`/`AnimatePresence` props. These are theme-neutral or out of scope; touching them would change the tuned look.

**Verification convention (every task):**
- Type check: confirm **no new TypeScript errors** in the editor's Problems pane (project convention — see `rules.md`; there is no standalone `tsc` script).
- Tests (run from the **project root**, never `cd` into a subdir): `npx vitest run <path>`.
- Commit type is `style` (visual change, no logic) per the repo's conventional-commit list.

---

## Task 1: `narrationtimeline.tsx` (leaf — the rendered transcript lines)

**Files:**
- Modify: `frontend/app/view/agents/narrationtimeline.tsx`

- [ ] **Step 1: Apply the color edits**

Make exactly these `className` substring replacements (line numbers approximate):

1. Line ~42 — latest vs non-latest message:
   - Find: `i === lastMessageIdx ? "border-l-2 border-[#3fb950] pl-2 text-[#f0f6fc]" : "text-[#dde3ea]"`
   - Replace: `i === lastMessageIdx ? "border-l-2 border-accent pl-2 text-primary" : "text-secondary"`
2. Line ~53 — action strip container:
   - Find: `"my-2.5 border-l-2 border-[#2a2f3a] pl-3.5 font-mono text-[12px] leading-7 text-[#7d8896]"`
   - Replace: `"my-2.5 border-l-2 border-border pl-3.5 font-mono text-[12px] leading-7 text-muted"`
3. Line ~55 — action verb:
   - Find: `"inline-block w-14 text-[#9aa4b2]"`
   - Replace: `"inline-block w-14 text-secondary"`
4. Line ~57 — action note:
   - Find: `<span className="text-[#6b7585]"> ({e.note})</span>`
   - Replace: `<span className="text-muted"> ({e.note})</span>`
5. Line ~66 — outcome ✓/✗:
   - Find: `e.outcome === "ok" ? "text-[#3fb950]" : "text-[#f85149]"`
   - Replace: `e.outcome === "ok" ? "text-accent" : "text-error"`

- [ ] **Step 2: Verify no TypeScript errors**

Confirm the editor Problems pane shows no new errors for `narrationtimeline.tsx`. (These are string-literal changes; type-wise they are inert.)

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/narrationtimeline.tsx
git commit -m "style(agents): re-skin narration timeline to Wave tokens"
```

---

## Task 2: `outputpanel.tsx` (the working-agent panel)

**Files:**
- Modify: `frontend/app/view/agents/outputpanel.tsx`

- [ ] **Step 1: Apply the color edits**

1. Line ~68 — panel container:
   - Find: `"relative flex h-full flex-col overflow-hidden rounded-[9px] border border-[#1c2230] bg-[#0b0e14]"`
   - Replace: `"relative flex h-full flex-col overflow-hidden rounded-[9px] border border-border bg-background"`
2. Line ~69 — header row border:
   - Find: `"flex shrink-0 items-center gap-2.5 border-b border-[#1c2230] px-[14px] py-2"`
   - Replace: `"flex shrink-0 items-center gap-2.5 border-b border-border px-[14px] py-2"`
3. Line ~73 — status dot (quiet vs working):
   - Find: `quiet ? "border border-[#4a5260] bg-transparent" : "bg-[#3fb950]"`
   - Replace: `quiet ? "border border-muted bg-transparent" : "bg-accent"`
4. Line ~78 — agent name:
   - Find: `<b className="text-[13px] text-[#e6edf3]">{agent.name}</b>`
   - Replace: `<b className="text-[13px] text-primary">{agent.name}</b>`
5. Line ~79 — project/task line:
   - Find: `"truncate text-[11.5px] text-[#6b7585]"`
   - Replace: `"truncate text-[11.5px] text-muted"`
6. Line ~83 — right meta (quiet vs active):
   - Find: `quiet ? "text-[#d29922]" : "text-[#7d8896]"`
   - Replace: `quiet ? "text-warning" : "text-muted"`
7. Line ~104 — "Open terminal" button:
   - Find: `"shrink-0 cursor-pointer rounded-[5px] border border-[#2c3340] px-2.5 py-0.5 text-[10.5px] text-[#c9d1d9] hover:bg-white/[0.04]"`
   - Replace: `"shrink-0 cursor-pointer rounded-[5px] border border-border px-2.5 py-0.5 text-[10.5px] text-secondary hover:bg-white/[0.04]"`
   - (Note: `hover:bg-white/[0.04]` is a neutral overlay — kept on purpose.)
8. Line ~122 — "↓ N new" pill:
   - Find: `"absolute bottom-3 left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-[#1f6feb] px-3 py-1 text-[11px] font-semibold text-white shadow-lg"`
   - Replace: `"absolute bottom-3 left-1/2 -translate-x-1/2 cursor-pointer rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white shadow-lg"`

- [ ] **Step 2: Verify no TypeScript errors**

Confirm no new errors for `outputpanel.tsx` in the Problems pane.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/outputpanel.tsx
git commit -m "style(agents): re-skin working output panel to Wave tokens"
```

---

## Task 3: `askcard.tsx` (the focused-ask card + answer pills)

**Files:**
- Modify: `frontend/app/view/agents/askcard.tsx`

- [ ] **Step 1: Apply the color edits**

1. Line ~29 — `QuestionGroup` top border:
   - Find: `"mt-3.5 border-t border-[#2a2f3a] pt-3.5"`
   - Replace: `"mt-3.5 border-t border-border pt-3.5"`
2. Line ~31 — question header label:
   - Find: `"mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#6b7585]"`
   - Replace: `"mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted"`
3. Line ~33 — question text:
   - Find: `"text-[14px] font-semibold text-[#e6edf3]"`
   - Replace: `"text-[14px] font-semibold text-primary"`
4. Lines ~52–55 — option pill states (selected / recommended / normal). Replace the three branch strings:
   - Find: `? "bg-[#238636] font-semibold text-white"`
   - Replace: `? "bg-accent/80 font-semibold text-primary hover:bg-accent"`
   - Find: `? "border border-[#238636] font-semibold text-[#3fb950]"`
   - Replace: `? "border border-accent font-semibold text-accent"`
   - Find: `: "border border-[#2c3340] text-[#c9d1d9]"`
   - Replace: `: "border border-border text-secondary"`
5. Line ~63 — option description (selected vs not):
   - Find: `isSelected ? "text-white/75" : "text-[#8b949e]"`
   - Replace: `isSelected ? "text-primary/75" : "text-muted"`
6. Line ~117 — card container:
   - Find: `"mb-3.5 rounded-[10px] border border-[#d29922] bg-[#d29922]/[0.05] px-[18px] py-4"`
   - Replace: `"mb-3.5 rounded-[10px] border border-warning bg-warning/5 px-[18px] py-4"`
7. Line ~120 — header dot:
   - Find: `<span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />`
   - Replace: `<span className="h-2 w-2 shrink-0 rounded-full bg-warning" />`
8. Line ~121 — agent name:
   - Find: `"shrink-0 text-[14px] text-[#e6edf3]"`
   - Replace: `"shrink-0 text-[14px] text-primary"`
9. Line ~122 — task:
   - Find: `"truncate text-[12.5px] text-[#6b7585]"`
   - Replace: `"truncate text-[12.5px] text-muted"`
10. Line ~124 — "asking · age":
    - Find: `"ml-auto shrink-0 text-[11px] text-[#d29922]"`
    - Replace: `"ml-auto shrink-0 text-[11px] text-warning"`
11. Line ~128 — "Open terminal" button:
    - Find: `"shrink-0 cursor-pointer rounded-[5px] border border-[#2c3340] px-2.5 py-0.5 text-[10.5px] text-[#c9d1d9] hover:bg-white/[0.04]"`
    - Replace: `"shrink-0 cursor-pointer rounded-[5px] border border-border px-2.5 py-0.5 text-[10.5px] text-secondary hover:bg-white/[0.04]"`
12. Lines ~157–160 — Submit button states (sent / canSubmit / disabled):
    - Find: `? "bg-[#238636] text-white"` (the `sent` branch)
    - Replace: `? "bg-accent text-primary"`
    - Find: `? "cursor-pointer bg-[#238636] text-white"`
    - Replace: `? "cursor-pointer bg-accent/80 text-primary hover:bg-accent"`
    - Find: `: "bg-[#238636]/40 text-white/50"`
    - Replace: `: "bg-accent/40 text-primary/50"`

- [ ] **Step 2: Verify no TypeScript errors**

Confirm no new errors for `askcard.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/askcard.tsx
git commit -m "style(agents): re-skin ask card and answer pills to Wave tokens"
```

---

## Task 4: `agents.tsx` (header, counts, empty state, queue rows)

**Files:**
- Modify: `frontend/app/view/agents/agents.tsx`

- [ ] **Step 1: Apply the color edits**

1. Line ~30 — `QueueRow` container:
   - Find: `"flex cursor-pointer items-center gap-2.5 rounded-[7px] border border-[#d29922]/60 bg-[#d29922]/[0.05] px-3 py-2 hover:bg-[#d29922]/10"`
   - Replace: `"flex cursor-pointer items-center gap-2.5 rounded-[7px] border border-warning/60 bg-warning/5 px-3 py-2 hover:bg-warning/10"`
2. Line ~32 — queue dot:
   - Find: `<span className="h-2 w-2 shrink-0 rounded-full bg-[#d29922]" />`
   - Replace: `<span className="h-2 w-2 shrink-0 rounded-full bg-warning" />`
3. Line ~33 — queue agent name:
   - Find: `"shrink-0 text-[12.5px] text-[#e6edf3]"`
   - Replace: `"shrink-0 text-[12.5px] text-primary"`
4. Line ~34 — queue question:
   - Find: `"truncate text-[12px] text-[#8b949e]"`
   - Replace: `"truncate text-[12px] text-muted"`
5. Line ~35 — queue age:
   - Find: `"ml-auto shrink-0 text-[10.5px] text-[#d29922]"`
   - Replace: `"ml-auto shrink-0 text-[10.5px] text-warning"`
6. Line ~127 — root container:
   - Find: `"flex h-full w-full flex-col bg-[#0b0e14] text-[#c9d1d9]"`
   - Replace: `"flex h-full w-full flex-col bg-background text-secondary"`
7. Line ~128 — header bar border:
   - Find: `"flex shrink-0 items-center justify-between border-b border-[#1c2230] px-[18px] py-3"`
   - Replace: `"flex shrink-0 items-center justify-between border-b border-border px-[18px] py-3"`
8. Line ~129 — "Agents" title:
   - Find: `<b className="text-[15px] text-[#e6edf3]">Agents</b>`
   - Replace: `<b className="text-[15px] text-primary">Agents</b>`
9. Line ~130 — counts container:
   - Find: `"flex items-center gap-1 text-[12px] text-[#6b7585]"`
   - Replace: `"flex items-center gap-1 text-[12px] text-muted"`
10. Lines ~131–132 — "asking" count + label:
    - Find: `<RollingCount value={asking.length} className="text-[#d29922]" />`
    - Replace: `<RollingCount value={asking.length} className="text-warning" />`
    - Find: `<span className="text-[#d29922]">asking</span>`
    - Replace: `<span className="text-warning">asking</span>`
11. Line ~150 — empty-state title:
    - Find: `"text-[13px] font-semibold text-[#c9d1d9]"`
    - Replace: `"text-[13px] font-semibold text-secondary"`
12. Line ~151 — empty-state hint:
    - Find: `"text-[11.5px] text-[#6b7585]"`
    - Replace: `"text-[11.5px] text-muted"`
13. Line ~180 — "N more waiting" label:
    - Find: `"text-[10.5px] uppercase tracking-wide text-[#9aa4b2]"`
    - Replace: `"text-[10.5px] uppercase tracking-wide text-secondary"`

- [ ] **Step 2: Verify no TypeScript errors**

Confirm no new errors for `agents.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/view/agents/agents.tsx
git commit -m "style(agents): re-skin agents view header and queue to Wave tokens"
```

---

## Task 5: `sessionrow.tsx` (sidebar rows — display color maps + active/blocked accents)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionrow.tsx`
- Test (run, do not edit): `frontend/app/tab/sessionsidebar/sessionrow.test.tsx`

> **Do NOT touch `sessionviewmodel.ts`.** `COLOR_WORKING`/`COLOR_WAITING` there are the reporter wire-protocol contract, not display colors (spec §4).

- [ ] **Step 1: Migrate the inline-`style` color maps to CSS vars**

1. Lines ~10–14 — `STATUS_COLOR`:
```ts
export const STATUS_COLOR: Record<SessionStatus, string> = {
    working: "var(--color-accent)",
    waiting: "var(--color-warning)",
    idle: "var(--color-muted)",
};
```
2. Lines ~23–27 — `SUBAGENT_MARKER_COLOR`:
```ts
export const SUBAGENT_MARKER_COLOR: Record<SubagentState, string> = {
    working: "var(--color-muted)",
    success: "var(--color-accent)",
    failure: "var(--color-error)",
};
```

- [ ] **Step 2: Migrate the active/blocked row accents + drop indicators**

3. Lines ~93–96 — replace the active/blocked/drop branch strings inside the `cn(...)`:
   - Find: `active && "session-row--active border-l-[#429dff] bg-[rgba(66,157,255,0.08)] hover:bg-[rgba(66,157,255,0.14)]",`
   - Replace: `active && "session-row--active border-l-accent bg-accent/10 hover:bg-accent/15",`
   - Find: `blocked && "session-row--blocked border-l-[#d29922] bg-[rgba(210,153,34,0.08)] hover:bg-[rgba(210,153,34,0.14)]",`
   - Replace: `blocked && "session-row--blocked border-l-warning bg-warning/10 hover:bg-warning/15",`
   - Find: `dropIndicator === "top" && "shadow-[inset_0_2px_0_0_#429dff]",`
   - Replace: `dropIndicator === "top" && "shadow-[inset_0_2px_0_0_var(--color-accent)]",`
   - Find: `dropIndicator === "bottom" && "shadow-[inset_0_-2px_0_0_#429dff]"`
   - Replace: `dropIndicator === "bottom" && "shadow-[inset_0_-2px_0_0_var(--color-accent)]"`
   - (Leave the `!active && !blocked && "hover:bg-[rgba(255,255,255,0.08)]"` line — neutral overlay, kept.)

- [ ] **Step 3: Migrate `SessionGroup` header greys**

4. Lines ~263–267:
   - Find: `"flex h-7 w-full cursor-pointer items-center gap-1.5 px-2 text-[11px] text-[#8b949e]"`
   - Replace: `"flex h-7 w-full cursor-pointer items-center gap-1.5 px-2 text-[11px] text-muted"`
   - Find: `"min-w-0 truncate text-[12px] font-semibold text-[#adbac7]"`
   - Replace: `"min-w-0 truncate text-[12px] font-semibold text-secondary"`
   - (The model/subagent-count badges use `bg-[rgba(255,255,255,0.06)]`/`0.08` + `text-secondary` — neutral overlays, kept.)

- [ ] **Step 4: Run the sidebar-row tests (must stay green)**

Run from project root:
```bash
npx vitest run frontend/app/tab/sessionsidebar/sessionrow.test.tsx
```
Expected: PASS. The test asserts the rendered markup contains `STATUS_COLOR.working` / `.waiting` / `.idle` and the subagent-marker colors. It imports those consts as the expected substrings, so it is self-referential and passes with the new `var(--color-*)` values (React serializes the inline style as e.g. `background-color:var(--color-accent)`, which contains the substring).

- [ ] **Step 5: Verify no TypeScript errors**

Confirm no new errors for `sessionrow.tsx`.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/tab/sessionsidebar/sessionrow.tsx
git commit -m "style(sidebar): re-skin agent status dots and row accents to Wave tokens"
```

---

## Task 6: `sessionsidebar.tsx` (sidebar header, Agents button, divider)

**Files:**
- Modify: `frontend/app/tab/sessionsidebar/sessionsidebar.tsx`

> The container glass background (`rgba(0,0,0,0.55)` + `backdropFilter: blur(20px)`) and the drop-shadow are kept (spec §3). Only the border and the agent-colored chrome migrate.

- [ ] **Step 1: Apply the color edits**

1. Line ~158 — container border:
   - Find: `"flex h-full flex-col overflow-y-auto rounded-[10px] border border-[#20242b] shadow-[0_10px_30px_rgba(0,0,0,0.5)]"`
   - Replace: `"flex h-full flex-col overflow-y-auto rounded-[10px] border border-border shadow-[0_10px_30px_rgba(0,0,0,0.5)]"`
   - (Leave line 159 `style={{ backdropFilter: ..., background: "rgba(0, 0, 0, 0.55)" }}` unchanged.)
2. Line ~163 — "Agents" button:
   - Find: `"group flex w-full shrink-0 cursor-pointer items-center gap-2 px-2 py-2 text-[13.5px] text-[#e6edf3] transition-colors hover:bg-[#d29922]/10"`
   - Replace: `"group flex w-full shrink-0 cursor-pointer items-center gap-2 px-2 py-2 text-[13.5px] text-primary transition-colors hover:bg-warning/10"`
3. Line ~167 — header dot glyph:
   - Find: `<span className="text-[#d29922]">⬤</span>`
   - Replace: `<span className="text-warning">⬤</span>`
4. Line ~177 — "N asking" badge:
   - Find: `"ml-auto rounded-[9px] bg-[#d29922] px-2 text-[10px] font-bold text-black"`
   - Replace: `"ml-auto rounded-[9px] bg-warning px-2 text-[10px] font-bold text-black"`
   - (Keep `text-black` — it's the legible foreground on the amber badge.)
5. Line ~184 — divider:
   - Find: `<div className="h-px shrink-0 bg-[#20242b]" />`
   - Replace: `<div className="h-px shrink-0 bg-border" />`
6. Line ~187 — "New Tab" button:
   - Find: `"group flex w-full shrink-0 cursor-pointer items-center gap-1.5 px-2 py-[7px] text-xs text-[#8b949e] transition-colors hover:text-primary"`
   - Replace: `"group flex w-full shrink-0 cursor-pointer items-center gap-1.5 px-2 py-[7px] text-xs text-muted transition-colors hover:text-primary"`

- [ ] **Step 2: Verify no TypeScript errors**

Confirm no new errors for `sessionsidebar.tsx`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app/tab/sessionsidebar/sessionsidebar.tsx
git commit -m "style(sidebar): re-skin sidebar header and Agents badge to Wave tokens"
```

---

## Task 7: Full-suite guard + visual verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the wire-protocol constants are untouched**

Run (from project root):
```bash
grep -nE 'COLOR_WORKING = "#3fb950"|COLOR_WAITING = "#d29922"' frontend/app/tab/sessionsidebar/sessionviewmodel.ts
```
Expected: **both lines match** (constants unchanged). If either is gone, restore it — `COLOR_WORKING`/`COLOR_WAITING` must stay `#3fb950`/`#d29922` (the reporter wire-protocol contract).

- [ ] **Step 2: Run the full agents + sidebar unit suite**

Run from project root:
```bash
npx vitest run frontend/app/view/agents frontend/app/tab/sessionsidebar
```
Expected: PASS for all, including:
- `sessionviewmodel.test.ts` → `badgeToStatus` still maps `#3fb950`→working, `#d29922`→waiting (the wire-protocol guard).
- `sessionrow.test.tsx` → renders contain the new `var(--color-*)` values.
- `agentsviewmodel.test.ts`, `transcriptprojection.test.ts`, `projectname.test.ts` → unaffected (no color logic).

- [ ] **Step 3: Visual confirmation in the running dev app**

Per `memory/cdp-verify-dev-app.md` (drive the dev Electron GUI over CDP on `:9222`), confirm with at least one asking agent and one working agent present:
- Sidebar and tab show the **same** green (working) and the **same** amber (asking) — no seam.
- States render correctly: working (accent dot, pulsing — motion unchanged), asking/blocked (warning), idle (muted), quiet (hollow muted dot + warning meta), a failed action `✗` in `error` red, the active row with an `accent` left border, the "↓ N new" pill in `accent`.
- Colors track a theme change (optional): switching Wave's theme recolors the agents surface, proving it's token-driven.

- [ ] **Step 4: (No commit)** — verification only. If any visual issue is found, fix it in the owning file and amend that file's commit or add a follow-up `style` commit.

---

## Self-review notes (already reconciled)
- **Spec coverage:** §4 approach (both mechanisms) → Tasks 1–6; §5 color map → canonical map above; §6 judgment calls (blue→accent, one-green) → applied in Tasks 1–6; §7 file list → Tasks 1–6 one-to-one; §8 testing/guard → Task 7. The §4 "do not migrate `COLOR_WORKING`/`COLOR_WAITING`" rule → enforced by Task 5 note + Task 7 Step 1.
- **No placeholders:** every edit shows the exact find/replace string.
- **Naming consistency:** token classes (`bg-background`, `text-primary/secondary/muted`, `accent`, `warning`, `error`, `border-border`) are used identically across all tasks.
