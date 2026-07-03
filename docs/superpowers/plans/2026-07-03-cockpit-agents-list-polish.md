# Cockpit Agents-list polish (A + B + D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the asking cards on the Cockpit surface — one readable copy of the ask question, consistent submit hint, composer collapsed by default, content-fit card height, tokenized brand colors, and a richer empty state.

**Architecture:** Pure frontend. The Agents view is a projection of atoms with import-free pure helpers (`agentsviewmodel.ts`) + thin React. New display logic goes into a unit-tested pure helper; styling/layout changes are verified visually over CDP against the dev app (no render harness exists for the cockpit). `AnswerBar` gains an opt-in `hideQuestion` so the card's pinned band can own the question while Channels keeps rendering its own.

**Tech Stack:** React 19, Tailwind v4 (`@theme` tokens), jotai, motion/react (`Reorder`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-cockpit-agents-list-polish-design.md`

---

## ⚠️ Git deviation from the skill default

This repo's owner uses a STRICT git rule: **batch all changes into ONE commit at the end, never commit without explicit approval, no per-task commits.** So each task below ends with a **Checkpoint** (verify, do not commit). The single commit is Task 9, gated on approval. Do not run `git commit` before Task 9.

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `frontend/app/view/agents/agentsviewmodel.ts` | new pure `answerHint()` | 1 |
| `frontend/app/view/agents/agentsviewmodel.test.ts` | `answerHint` unit tests | 1 |
| `frontend/app/view/agents/answerbar.tsx` | `hideQuestion` prop; footer hint via `answerHint` | 2 |
| `frontend/app/view/agents/agentrow.tsx` | band = single readable question source; pass `hideQuestion`; composer collapse + extracted reply chips; content-fit height | 3, 4, 5 |
| `frontend/tailwindsetup.css` | brighter `--color-ask-question`; `--color-provider-claude/codex` | 3, 6 |
| `frontend/app/view/agents/themes.ts` | higher `--color-ask-question` lighten factor | 3 |
| `frontend/app/view/agents/cockpitsurface.tsx` | tokenized `PROVIDER_DOT`; empty-state CTA | 6, 7 |
| `frontend/app/view/agents/agentrow.tsx` (+ maybe `agentcomposer.tsx`) | horizontal-overflow artifact fix | 8 |

## Verification commands (used throughout)

- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — baseline is exit 0; any error is yours. (Bare `npx tsc` stack-overflows — do not use it.)
- **Unit test:** `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
- **Visual (CDP):** the dev app is running with the debug port on `:9222`.
  1. `node scripts/gen-cockpit-fixtures.mjs <mixed|all-asking|heavy|empty>`
  2. Reload the dev app (Ctrl+R in the app, or a CDP `Page.reload`) so `loadDevMockRoster()` re-fetches the fixture.
  3. `node scripts/cdp-shot.mjs cdp-shots/<name>.png` and read the PNG.
  - Clear when done: `node scripts/gen-cockpit-fixtures.mjs --clear`.

---

## Task 1: Pure `answerHint()` helper (TDD)

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (add after `canSubmitAsk`, ~line 458)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `agentsviewmodel.test.ts`. First extend the import on line 2 to include `answerHint` (add it to the existing `{ ... }` list). Then append:

```ts
describe("answerHint", () => {
    const q = (multiSelect = false): AgentAskQuestion => ({
        question: "Q?",
        options: [{ label: "a" }, { label: "b" }],
        multiSelect,
    });
    it("empty when no questions", () => {
        expect(answerHint([], {}, true)).toBe("");
    });
    it("single single-select, numbered: prompts 1–9 or click", () => {
        expect(answerHint([q()], {}, true)).toBe("Press 1–9 or click to answer");
    });
    it("single single-select, not numbered: prompts click only", () => {
        expect(answerHint([q()], {}, false)).toBe("Click to answer");
    });
    it("single multi-select: press Enter to submit", () => {
        expect(answerHint([q(true)], {}, true)).toBe("press Enter to submit");
    });
    it("multi question single-select: shows answered progress", () => {
        expect(answerHint([q(), q()], { 0: new Set([1]) }, true)).toBe("1/2 answered");
    });
    it("multi question with a multi-select: progress + Enter", () => {
        expect(answerHint([q(), q(true)], { 0: new Set([0]) }, true)).toBe("1/2 answered · press Enter to submit");
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t answerHint`
Expected: FAIL — `answerHint` is not exported / not a function.

- [ ] **Step 3: Implement `answerHint`**

Add to `agentsviewmodel.ts` immediately after `canSubmitAsk` (after line 458):

```ts
/** Pure: the single muted footer hint for an ask, so one consistent line always renders.
 *  - one single-select question: prompt to answer (mentions 1–9 only when the picker is numbered)
 *  - one multi-select question: "press Enter to submit" (multi-select needs a confirm)
 *  - multiple questions: "N/M answered", plus "press Enter to submit" if any is multi-select */
export function answerHint(
    questions: AgentAskQuestion[],
    selections: Record<number, Set<number>>,
    numbered: boolean
): string {
    if (questions.length === 0) {
        return "";
    }
    const total = questions.length;
    const needsConfirm = questions.some((q) => q.multiSelect);
    if (total === 1 && !needsConfirm) {
        return numbered ? "Press 1–9 or click to answer" : "Click to answer";
    }
    const parts: string[] = [];
    if (total > 1) {
        const answered = questions.filter((_, qi) => (selections[qi]?.size ?? 0) > 0).length;
        parts.push(`${answered}/${total} answered`);
    }
    if (needsConfirm) {
        parts.push("press Enter to submit");
    }
    return parts.join(" · ");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t answerHint`
Expected: PASS (6 tests).

- [ ] **Step 5: Checkpoint (no commit)**

Run the full file: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts` — expected all green. Do not commit.

---

## Task 2: `AnswerBar` — `hideQuestion` prop + unified footer hint

**Files:**
- Modify: `frontend/app/view/agents/answerbar.tsx`

- [ ] **Step 1: Add `hideQuestion` to `QuestionGroup`**

In `QuestionGroup`'s props (answerbar.tsx ~line 44-56) add `hideQuestion?: boolean`, and guard the header + question block (lines 63-69) so it renders only when not hidden. Replace:

```tsx
    return (
        <div className="mt-3">
            {question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {question.header}
                </div>
            ) : null}
            <div className="text-[13px] font-semibold text-primary">{question.question}</div>
```

with:

```tsx
    return (
        <div className={hideQuestion ? "" : "mt-3"}>
            {!hideQuestion && question.header ? (
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {question.header}
                </div>
            ) : null}
            {!hideQuestion ? (
                <div className="text-[13px] font-semibold text-primary">{question.question}</div>
            ) : null}
```

Add `hideQuestion,` to the destructured params of `QuestionGroup`.

- [ ] **Step 2: Thread `hideQuestion` through `AnswerBar`**

In `AnswerBar`'s props (line 184-204) add `hideQuestion?: boolean` and destructure it. In `renderGroup` (line 221) pass it to `QuestionGroup`:

```tsx
    const renderGroup = (qi: number) => (
        <QuestionGroup
            question={questions[qi]}
            accent={accent}
            numbered={numbered}
            hideQuestion={hideQuestion}
            selections={selections[qi] ?? new Set()}
            onClickOption={(oi) => {
```

- [ ] **Step 3: Replace both footer hints with `answerHint`**

Import it: add `answerHint,` to the existing `agentsviewmodel` import (line 5).

Single-question branch (lines 244-251) — replace the `needsConfirm ? ...` line:

```tsx
    if (questions.length === 1) {
        return (
            <div className={className}>
                {renderGroup(0)}
                {(() => {
                    const hint = answerHint(questions, selections, !!numbered);
                    return hint ? <div className={cn(hideQuestion ? "mt-2" : "mt-2", "text-[11px] text-muted")}>{hint}</div> : null;
                })()}
            </div>
        );
    }
```

Multi-question branch (lines 278-281) — replace the `{answeredCount}/... ` block:

```tsx
            {renderGroup(idx)}
            {(() => {
                const hint = answerHint(questions, selections, !!numbered);
                return hint ? <div className="mt-2 text-[11px] text-muted">{hint}</div> : null;
            })()}
```

Remove the now-unused `answeredCount` const (line 254) and `needsConfirm` const (line 220) if they are no longer referenced. (Verify with the typecheck in Step 4 — TS will flag unused locals only if the config does; if not, delete them anyway to keep the diff clean.)

- [ ] **Step 4: Checkpoint (no commit)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. No commit.

---

## Task 3: `agentrow` band = single readable question source

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`
- Modify: `frontend/tailwindsetup.css`
- Modify: `frontend/app/view/agents/themes.ts`

- [ ] **Step 1: Sync the band question to the active question**

In `agentrow.tsx`, replace line 192:

```tsx
    const question = agent.ask?.questions?.[0]?.question;
```

with (uses the existing `activeQuestion` prop; clamps to a valid index):

```tsx
    const qs = agent.ask?.questions ?? [];
    const qIdx = Math.min(activeQuestion ?? 0, Math.max(0, qs.length - 1));
    const question = qs[qIdx]?.question;
```

- [ ] **Step 2: Make the band question readable + drop AnswerBar's copy**

Replace the band question paragraph (line 338-340):

```tsx
                    {question ? (
                        <p className="text-[13px] font-medium leading-[1.5] text-ask-question">{question}</p>
                    ) : null}
```

with (14px, semibold):

```tsx
                    {question ? (
                        <p className="text-[14px] font-semibold leading-[1.5] text-ask-question">{question}</p>
                    ) : null}
```

Then pass `hideQuestion` to the card's `AnswerBar` (line 386-398), so the question only shows in the band:

```tsx
                {asking && hasQuestions ? (
                    <AnswerBar
                        agent={agent}
                        selections={selections}
                        sent={sent}
                        numbered
                        hideQuestion
                        activeQuestion={activeQuestion}
                        onToggle={onToggleAnswer}
                        onSubmit={onSubmitAnswer}
                        onSelectQuestion={onSelectQuestion}
                        className="shrink-0 border-t border-edge-mid px-3 py-2"
                    />
                ) : null}
```

- [ ] **Step 3: Raise `--color-ask-question` contrast (static token)**

In `frontend/tailwindsetup.css` line 61, replace:

```css
    --color-ask-question: #eddcb8; /* asking-band question prose */
```

with:

```css
    --color-ask-question: #f7efd9; /* asking-band question prose (brightened for readability) */
```

- [ ] **Step 4: Raise `--color-ask-question` contrast (runtime themes)**

In `frontend/app/view/agents/themes.ts` line 214, replace:

```ts
        "--color-ask-question": lighten(p.warning, 0.42),
```

with:

```ts
        "--color-ask-question": lighten(p.warning, 0.6),
```

- [ ] **Step 5: Checkpoint (typecheck + visual)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Visual: `node scripts/gen-cockpit-fixtures.mjs mixed`, reload, `node scripts/cdp-shot.mjs cdp-shots/task3.png`, read it. Confirm on `loom`/`obsidian` the question appears **once** (in the band), is clearly readable, and the options render below without a second question line. No commit.

> If the color still reads low-contrast, tune `#f7efd9` lighter and the `lighten` factor up, re-shoot. Adjust both in lockstep so themed and default match.

---

## Task 4: `agentrow` composer collapse + persistent reply chips

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`

- [ ] **Step 1: Stop asking cards from force-expanding the composer**

Replace line 196:

```tsx
    const showComposer = composerOpen || asking;
```

with:

```tsx
    const showComposer = composerOpen;
```

- [ ] **Step 2: Restructure the footer — one bordered region: reply chips (asking) above the composer/collapsed row**

Replace the whole composer block (lines 400-445, the `{showComposer ? (...) : (...)}`) with:

```tsx
                {/* footer: reply chips (asking, always visible) above the composer, which collapses
                    to a slim "+ message… R" row by default and expands on R / click */}
                <div className="shrink-0 border-t border-edge-mid">
                    {asking && agent.ask?.replySuggestions?.length ? (
                        <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                            {agent.ask.replySuggestions.map((s, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (composerOpen) {
                                            composerRef.current?.fill(s);
                                        } else {
                                            onOpenComposer();
                                            requestAnimationFrame(() => composerRef.current?.fill(s));
                                        }
                                    }}
                                    className="cursor-pointer whitespace-nowrap rounded-[7px] border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] text-warning hover:border-warning/55 hover:bg-warning/20"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {showComposer ? (
                        <div
                            className="flex flex-col gap-1.5 px-3 py-2"
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                        >
                            <AgentComposer
                                ref={composerRef}
                                blockId={agent.blockId}
                                placeholder={`message ${agent.name}…`}
                                onEscape={onComposerEscape}
                                className="border-t-0 px-0 py-0"
                            />
                        </div>
                    ) : (
                        <div
                            onClick={(e) => {
                                e.stopPropagation();
                                onOpenComposer();
                            }}
                            className="flex cursor-text items-center gap-2 px-3 py-1.5 hover:bg-surface-hover"
                        >
                            <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[5px] border border-edge-mid text-[10px] leading-none text-muted">
                                +
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{`message ${agent.name}…`}</span>
                            <span className="shrink-0 rounded-[5px] border border-edge-mid px-1.5 py-0.5 font-mono text-[9.5px] text-muted">
                                R
                            </span>
                        </div>
                    )}
                </div>
```

Note: the reply-chip markup and the collapsed-row markup are moved verbatim from the old block; only the outer bordering changed (one `border-t` on the wrapper; the inner rows no longer carry `border-t border-edge-mid`), and chips now render outside the `showComposer` gate.

- [ ] **Step 3: Checkpoint (typecheck + visual)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Visual: with `mixed` still injected, `node scripts/cdp-shot.mjs cdp-shots/task4.png`, read it. Confirm asking cards now show the slim `+ message… R` row (not a full textarea), pressing `r` on the cursor card expands it, and the card is noticeably shorter. If a fixture has `replySuggestions`, confirm the chips still show while collapsed. No commit.

---

## Task 5: `agentrow` content-fit height + jank guard

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx`

- [ ] **Step 1: Add min/max height constants**

Below `const DEFAULT_CARD_HEIGHT = 280;` (line 27) add:

```tsx
const MIN_CARD_HEIGHT = 120; // content-fit floor when a card hasn't been manually resized
const MAX_CARD_HEIGHT = 420; // content-fit cap; the feed scrolls past this
```

- [ ] **Step 2: Content-fit the card unless manually resized**

Replace the `Reorder.Item` `style` (line 235) and `layout` (line 233).

Replace `layout` (line 233) with:

```tsx
            layout="position"
```

Replace line 235:

```tsx
            style={{ ...cardSpanStyle({ wide }), height: `${height ?? DEFAULT_CARD_HEIGHT}px` }}
```

with:

```tsx
            style={{
                ...cardSpanStyle({ wide }),
                ...(height != null
                    ? { height: `${height}px` }
                    : { minHeight: MIN_CARD_HEIGHT, maxHeight: MAX_CARD_HEIGHT }),
            }}
```

(`onResizeStart` already falls back to `cardRef.current?.offsetHeight ?? DEFAULT_CARD_HEIGHT`, so manual resize still works; `DEFAULT_CARD_HEIGHT` stays as that fallback.)

- [ ] **Step 3: Checkpoint (typecheck + visual across fixtures)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Visual:
- `mixed`: short asks shrink to content; no big empty gap under options.
- `heavy`: `node scripts/gen-cockpit-fixtures.mjs heavy`, reload, `node scripts/cdp-shot.mjs cdp-shots/task5-heavy.png` — a long-feed card caps at ~420px and its feed scrolls; the card does not run off-screen.
- Drag-reorder a card (via CDP `Input.dispatch*` or manual) and confirm position still animates but heights don't visibly "breathe" as transcripts stream.

No commit.

> Fallback if `layout="position"` still janks on stream: set a reduced fixed default (`height ?? 220`) instead of content-fit and note the tradeoff back to the user before proceeding.

---

## Task 6: Tokenize brand colors

**Files:**
- Modify: `frontend/tailwindsetup.css`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

- [ ] **Step 1: Add provider tokens**

In `frontend/tailwindsetup.css`, in the `@theme` block near the avatar palette (after line 63 `--color-on-warning`), add:

```css
    /* Provider brand identity (not theme-derived; single source for the plan-strip dots) */
    --color-provider-claude: #d97757;
    --color-provider-codex: #96aacd;
```

- [ ] **Step 2: Use the tokens in `PROVIDER_DOT`**

In `cockpitsurface.tsx` line 74, replace:

```tsx
const PROVIDER_DOT: Record<string, string> = { claude: "bg-[#d97757]", codex: "bg-[#96aacd]" };
```

with:

```tsx
const PROVIDER_DOT: Record<string, string> = { claude: "bg-provider-claude", codex: "bg-provider-codex" };
```

- [ ] **Step 3: Checkpoint (typecheck + visual)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Visual: with `mixed` injected + rail open, `node scripts/cdp-shot.mjs cdp-shots/task6.png` — the Claude (clay) and Codex (periwinkle) dots in the Usage rail look identical to before (Tailwind v4 `@theme` HMR-reloads the utility). No commit.

---

## Task 7: Empty-state CTA

**Files:**
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

- [ ] **Step 1: Add a "+ New agent" button to the empty state**

Replace the empty block (cockpitsurface.tsx lines 587-595):

```tsx
                    {empty ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-[18px] text-center">
                            <div className="text-[18px] opacity-40">🤖</div>
                            <div className="text-[13px] font-semibold text-secondary">No active agents</div>
                            <div className="text-[11px] text-muted">
                                Agents appear here the moment one starts working or asks a question.
                            </div>
                        </div>
                    ) : null}
```

with:

```tsx
                    {empty ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-[18px] text-center">
                            <div className="text-[18px] opacity-40">🤖</div>
                            <div className="text-[13px] font-semibold text-secondary">No active agents</div>
                            <div className="max-w-[280px] text-[11px] text-muted">
                                Agents appear here the moment one starts working or asks a question.
                            </div>
                            <button
                                type="button"
                                onClick={() => globalStore.set(model.newAgentOpenAtom, true)}
                                className="mt-1 cursor-pointer rounded-[8px] border border-accent/50 bg-accent/10 px-3 py-1.5 text-[12px] font-medium text-accent hover:border-accent hover:bg-accent/15"
                            >
                                + New agent
                            </button>
                        </div>
                    ) : null}
```

(`globalStore` and `model` are already in scope in this component.)

- [ ] **Step 2: Checkpoint (typecheck + visual)**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
Visual: `node scripts/gen-cockpit-fixtures.mjs empty`, reload, `node scripts/cdp-shot.mjs cdp-shots/task7-empty.png` — CTA renders; clicking it opens the New Agent modal. No commit.

---

## Task 8: Kill the horizontal-scrollbar artifact + feed top-clip

**Files:**
- Modify: `frontend/app/view/agents/agentrow.tsx` (and only if traced there, `frontend/app/view/agents/agentcomposer.tsx`)

- [ ] **Step 1: Locate the overflowing node (measurement, not guessing)**

With `mixed` injected, attach CDP and run this over the page `Runtime.evaluate` (adapt the existing attach pattern in `scripts/cdp-shot.mjs`; expression below):

```js
(() => {
  const card = document.querySelector('[data-agent-id]');
  const out = [];
  card && card.querySelectorAll('*').forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1) {
      out.push({ cls: el.className?.toString?.().slice(0, 80), sw: el.scrollWidth, cw: el.clientWidth });
    }
  });
  return JSON.stringify(out, null, 2);
})()
```

Record which element(s) overflow horizontally.

- [ ] **Step 2: Apply the minimal constraint the measurement points to**

- If the overflowing node is a flex child that isn't allowed to shrink, add `min-w-0` to it.
- If it's a scroll container leaking a horizontal scrollbar, add `overflow-x-hidden`.
- If it traces to the composer textarea, add `min-w-0` (already present) — check the composer wrapper row in `agentcomposer.tsx:58` and add `min-w-0` there if needed.

Make the single smallest change that removes the horizontal overflow. Do not restyle unrelated nodes.

- [ ] **Step 3: Checkpoint (visual)**

Re-run the Step 1 measurement — expected empty array. `node scripts/cdp-shot.mjs cdp-shots/task8.png` — no horizontal scrollbar under any card; the feed's first line is fully visible at rest (not clipped). No commit.

> If Step 1 returns an empty array on first run, the artifact was resolved by the Task 4/5 restructure. Record that in the checkpoint note and skip Step 2.

---

## Task 9: Final verification + single commit (after approval)

**Files:** none new.

- [ ] **Step 1: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 2: Full unit suite for the view**

Run: `npx vitest run frontend/app/view/agents/`
Expected: all green (existing tests + the new `answerHint` tests).

- [ ] **Step 3: Final visual sweep**

Re-shoot `mixed`, `all-asking`, `heavy`, `empty` and read each PNG. Confirm against the spec's acceptance points: single readable question, consistent hint, collapsed composer, content-fit + capped height, tokenized dots, empty-state CTA, no horizontal scrollbar.

- [ ] **Step 4: Clear the dev fixture**

Run: `node scripts/gen-cockpit-fixtures.mjs --clear` (then reload once to confirm the live/empty path is restored).

- [ ] **Step 5: Show the diff and request approval**

Show `git status` (M list) + a one-line summary per file and the proposed message, then ask: "Awaiting approval. Proceed? (yes/no)". Do not commit until the answer is yes.

Proposed commit (subject < 72 chars):

```
polish(cockpit): dedupe + readable ask question, collapse composer, content-fit cards

- AnswerBar hideQuestion so the pinned band is the single, readable question source
- unify the submit hint via a pure, tested answerHint()
- asking cards collapse the composer by default (reply chips stay); content-fit height
- tokenize provider brand colors; add a New-agent CTA to the empty state
```

- [ ] **Step 6: Commit (only after "yes")**

```bash
git add frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts \
  frontend/app/view/agents/answerbar.tsx frontend/app/view/agents/agentrow.tsx \
  frontend/app/view/agents/cockpitsurface.tsx frontend/app/view/agents/themes.ts \
  frontend/tailwindsetup.css \
  docs/superpowers/specs/2026-07-03-cockpit-agents-list-polish-design.md \
  docs/superpowers/plans/2026-07-03-cockpit-agents-list-polish.md
git commit
```

(The spec + plan fold into this feature commit per repo convention. Add `agentcomposer.tsx` to the `git add` list only if Task 8 modified it.)

---

## Self-review notes

- **Spec coverage:** A.dedupe → Tasks 2+3; A.readability → Task 3; A.submit-hint → Tasks 1+2; B.composer-collapse → Task 4; B.content-fit → Task 5; B.overflow-artifact → Task 8; D.tokens → Task 6; D.empty-state → Task 7. All spec sections mapped.
- **Type consistency:** `answerHint(questions, selections, numbered)` defined in Task 1, imported+called identically in Task 2; `hideQuestion` prop added in Task 2, passed in Task 3; `MIN/MAX_CARD_HEIGHT` defined+used in Task 5.
- **Non-goals honored:** no grid-layout redesign, no backend/RPC/`task generate`, no motion beyond the `layout="position"` jank guard.
