# Narration timeline polish Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/util/utilfn/`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs narration-feed surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/narration-timeline/project/Main.dc.html

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the narration feed on the Jarvis brief type scale, with readable contrast and lucide icons, exactly as
the approved mockup's POLISHED tables specify.

**Architecture:** This is a restyle of one component family: `narrationtimeline.tsx` (the feed, plus
`ToolDetailBody`, which the tool detail modal shares), the Insight callout in `markdownmessage.tsx`, and one class
in `endedtranscript.tsx`. `summarizeActions` gains a `failed` count so the folded run can say "N failed". The only
logic change is that count, which is unit-tested. The rendered result is checked over CDP through a dev-only
fixture seam, because every real host of the feed needs a live session or run.

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens in `frontend/tailwindsetup.css`), lucide-react, vitest, and
the CDP scenario harness in `scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-09-29-narration-timeline-polish-design.md`. Read it first. The mockup is the
source for every value: `const POLISHED` in each of `Main.dc.html`, `ToolRows.dc.html` and `Markers.dc.html` under
`C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/narration-timeline/project/` (gitignored; read it by that
absolute path from any worktree). When this plan's code and POLISHED disagree, POLISHED wins.

## Global Constraints

- Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`. No new tokens, no raw hex or rgba, no
  emoji. The mockup's colour names map to tokens: `inkMid` is `ink-mid`, `muted` is `muted`, `faint` is `ink-faint`,
  `edgeMid` is `edge-mid`, `edgeFaint` is `edge-faint`, `edgeStrong` is `edge-strong`, `code` is `surface-code`,
  `added` is `diff-added`, `removed` is `diff-removed`, and `accentSoft` is `accent-soft`.
- No text in the feed is below 10.5px. `text-xxxs`, `text-[9px]`, `text-[9.5px]` and `text-[10px]` leave
  `narrationtimeline.tsx`; the `--text-xxxs` token stays defined.
- Frontend only: no wire-type or Go change, and no `task generate`.
- Pure logic goes in `.ts` with a `.test.ts` beside it. There are no jsdom render tests.
- Stay out of run ba79c116's files (`frontend/app/view/orchestrate/`, `timelinerail.tsx`, and the `dag-lifecycle`
  scenario inside `scripts/cdp/scenarios.mjs`) and run 02d0840e's (`pkg/orchestrate/`, `pkg/wshrpc/wshserver/`,
  `scripts/verify.mjs`).
- Do not delete `.superpowers/design/narration-timeline/`.
- Commit messages carry no `Co-Authored-By`, `Claude-Session` or other attribution trailer.
- Run prettier only on the files you touched (`npx prettier --check <paths>`), never on the tree.

## Review Focus

- A bash detail whose output holds one long unbroken token (a path or URL), in a 360px card: it wraps inside the
  panel and nothing scrolls sideways. Pinned by the Task 3 scenario at 360px.
- A bash detail with a command but no output and exit 0: the footer still shows a green `exit 0` chip. Pinned by
  the Task 3 fixture's `task check:ts` entry.
- A folded run in which every action failed, or none did: it reads "N failed" in `error` with `X`, or "all ok" in
  `muted` with `Check`. Pinned by the Task 1 unit test (counts) and the Task 3 scenario (both labels).
- The tool detail modal after the change: its bash output and read and edit lines still render unwrapped
  (`white-space: pre`), and its exit chip stays in the body. Pinned by the Task 3 scenario's modal step.
- A tool line with no detail (a bare Codex action): no pointer cursor, no hover fill, no affordance icon, and full
  opacity. The Task 3 fixture's standalone `CHANGELOG.md` read is bare, and the scenario's "nothing dimmed" step
  covers it. The cursor and hover rest on `ToolLine`'s `detail &&` guards.

---

### Task 1: Polish the feed component and count failed actions
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/agentsviewmodel.ts` (`ActionsSummary`, `summarizeActions`, around line 323)
- Test: `frontend/app/view/agents/agentsviewmodel.test.ts` (the `describe("summarizeActions")` block, around line 873)
- Modify: `frontend/app/view/agents/narrationtimeline.tsx` (whole component family)

**Interfaces:**
- Produces: `ActionsSummary.failed: number`. `outcome` stays; `agentdetailsrail.tsx` reads only `byVerb`.
- Produces: DOM hooks the Task 3 scenario reads:
  - `data-tool-panel` on the inline detail panel of `ToolLine` and `EditBurstRow`.
  - `data-fold` on the folded-run button.
  - The panel footer's `button[aria-label="Open full view"]`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("summarizeActions", ...)` in `agentsviewmodel.test.ts`:

```ts
    it("counts failed actions", () => {
        expect(summarizeActions(actions).failed).toBe(0);
        const mixed: AgentActionEntry[] = [
            { kind: "action", verb: "ran", target: "a", outcome: "fail" },
            { kind: "action", verb: "read", target: "b", outcome: "ok" },
            { kind: "action", verb: "ran", target: "c", outcome: "fail" },
        ];
        expect(summarizeActions(mixed).failed).toBe(2);
        const allFailed: AgentActionEntry[] = [
            { kind: "action", verb: "ran", target: "a", outcome: "fail" },
            { kind: "action", verb: "ran", target: "b", outcome: "fail" },
        ];
        expect(summarizeActions(allFailed).failed).toBe(2);
    });
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "summarizeActions"`
Expected: FAIL, because `failed` is `undefined`.

- [ ] **Step 3: Add the count**

In `agentsviewmodel.ts`:

```ts
export interface ActionsSummary {
    total: number;
    byVerb: { verb: string; count: number }[];
    outcome: "ok" | "fail";
    failed: number;
}

/** Pure: per-verb counts (count desc, then first appearance), the number of failed actions, and the aggregate
 *  outcome (fail if any action failed). Drives a collapsed group's summary label. */
export function summarizeActions(actions: AgentActionEntry[]): ActionsSummary {
    const order: string[] = [];
    const counts = new Map<string, number>();
    let failed = 0;
    for (const a of actions) {
        if (!counts.has(a.verb)) {
            order.push(a.verb);
        }
        counts.set(a.verb, (counts.get(a.verb) ?? 0) + 1);
        if (a.outcome === "fail") {
            failed++;
        }
    }
    const byVerb = order.map((verb) => ({ verb, count: counts.get(verb)! })).sort((x, y) => y.count - x.count);
    return { total: actions.length, byVerb, outcome: failed > 0 ? "fail" : "ok", failed };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts -t "summarizeActions"`
Expected: PASS (4 tests).

- [ ] **Step 5: Imports and shared pieces in `narrationtimeline.tsx`**

Replace the `lucide-react` import and add the brief scale import:

```tsx
import { MONO_FAINT } from "@/app/view/jarvis/briefstyle";
import { ArrowUpRight, Ban, Check, ChevronDown, ChevronRight, ChevronUp, Copy, Layers, X } from "lucide-react";
```

Add these above `ToolDetailBody`:

```tsx
// inline panels wrap long lines so a narrow card never scrolls sideways; the modal has room, so it keeps them unwrapped
function lineWrap(variant: "inline" | "modal"): string {
    return variant === "inline" ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre";
}

function ExitChip({ exit }: { exit: number }) {
    return (
        <span
            className={cn(
                "rounded-[4px] px-[7px] py-px font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em]",
                exit ? "bg-error/15 text-error" : "bg-success/15 text-success"
            )}
        >
            exit {exit}
        </span>
    );
}

function StatusSquare({ ok }: { ok: boolean }) {
    return (
        <span
            className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
                ok ? "bg-success/15 text-success" : "bg-error/15 text-error"
            )}
        >
            {ok ? <Check size={10} strokeWidth={3} aria-hidden /> : <X size={10} strokeWidth={3} aria-hidden />}
        </span>
    );
}

function Affordance({ toModal, open }: { toModal: boolean; open: boolean }) {
    const Icon = toModal ? ArrowUpRight : open ? ChevronDown : ChevronRight;
    return (
        <span className="flex shrink-0 text-muted">
            <Icon size={12} strokeWidth={2.2} aria-hidden />
        </span>
    );
}

const TOOL_ROW = "flex items-center gap-2 rounded-[6px] px-1.5 py-[3px]";
const VERB = "min-w-[50px] shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted";
const TARGET = "min-w-0 truncate font-mono text-[11.5px] text-ink-mid";
// 30px = the row's 6px padding + the 16px status square + the 8px gap, so the panel sits under the target
const DETAIL_PANEL = "mb-1.5 ml-[30px] mt-1 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code";
```

- [ ] **Step 6: Rewrite `ToolDetailBody`**

The sizes and colours apply to both variants. Only wrapping and the exit chip's place depend on `variant`.

```tsx
export function ToolDetailBody({ detail, variant }: { detail: ActionDetail; variant: "inline" | "modal" }) {
    const modal = variant === "modal";
    const pad = modal ? "px-4 py-3" : "px-[11px] py-[9px]";
    const wrap = lineWrap(variant);
    if (detail.kind === "grep") {
        return (
            <div className={pad}>
                {detail.matches.map((g, i) => (
                    <div key={i} className="flex gap-2.5 whitespace-pre font-mono text-[11.5px] leading-[1.65]">
                        <span className="shrink-0 text-muted">{g.loc}</span>
                        <span className="min-w-0 flex-1 truncate text-secondary">{g.code}</span>
                    </div>
                ))}
                {detail.more ? <div className={cn("pt-1.5", MONO_FAINT)}>{detail.more}</div> : null}
            </div>
        );
    }
    if (detail.kind === "read") {
        // syntax-highlight the file body with the feed's lightweight tokenizer (same one CodeBlock uses).
        // Kept off shiki deliberately — the feed is on the cockpit boot path.
        return (
            <div className={cn(pad, modal && "overflow-x-auto")}>
                <div className={cn("font-mono text-[11.5px] leading-[1.7]", modal && "min-w-min")}>
                    {detail.snippet.split("\n").map((ln, i) => (
                        <div key={i} className={wrap}>
                            {highlightLine(ln).map((tk, k) => (
                                <span key={k} className={tk.cls}>
                                    {tk.t}
                                </span>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        );
    }
    if (detail.kind === "bash") {
        return (
            <div>
                {detail.command ? (
                    <div
                        className={cn(
                            "flex gap-2 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.6] text-secondary [overflow-wrap:anywhere]",
                            pad
                        )}
                    >
                        <span className="shrink-0 select-none text-accent">$</span>
                        <span>{detail.command}</span>
                    </div>
                ) : null}
                {detail.output ? (
                    <pre
                        className={cn(
                            "m-0 font-mono text-[11.5px] leading-[1.7]",
                            wrap,
                            modal && "overflow-x-auto",
                            detail.command && "border-t border-edge-faint",
                            pad,
                            detail.exit ? "text-error" : "text-ink-mid"
                        )}
                    >
                        {detail.output}
                    </pre>
                ) : null}
                {/* inline, the exit chip sits in the panel footer (ToolLine) so it never scrolls away */}
                {modal ? (
                    <div className="flex items-center gap-2 px-[13px] pb-[9px]">
                        <ExitChip exit={detail.exit} />
                    </div>
                ) : null}
            </div>
        );
    }
    if (detail.kind === "skill") {
        return (
            <div className={pad}>
                <div className="flex items-center gap-2 font-mono text-[11.5px]">
                    <span className="text-syntax-keyword">skill</span>
                    <span className="text-primary">{detail.name}</span>
                </div>
                {detail.args ? (
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6] text-secondary">
                        {detail.args}
                    </pre>
                ) : null}
            </div>
        );
    }
    // edit
    return (
        <div className="flex flex-col">
            {detail.files.map((f, i) => (
                <div key={i} className="border-b border-lane last:border-b-0">
                    <div className="flex items-center gap-2.5 bg-surface px-[11px] py-[7px]">
                        <span
                            className={cn(
                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10.5px] font-bold",
                                f.badge === "A" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
                            )}
                        >
                            {f.badge}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-hi">{f.path}</span>
                        <span className="font-mono text-[10.5px] font-bold text-diff-added">+{f.adds}</span>
                        <span className="font-mono text-[10.5px] font-bold text-diff-removed">−{f.dels}</span>
                    </div>
                    <div className={cn("bg-surface-code py-1", modal && "overflow-x-auto")}>
                        <div className={modal ? "min-w-min" : undefined}>
                            {f.lines.map((l, k) => (
                                <div
                                    key={k}
                                    className={cn(
                                        "flex font-mono text-[11.5px] leading-[1.7]",
                                        wrap,
                                        l.sign === "+" ? "bg-diff-added/[0.09]" : l.sign === "-" ? "bg-diff-removed/[0.09]" : ""
                                    )}
                                >
                                    {/* the sign column stays put, so a wrapped line hangs under its own text */}
                                    <span
                                        className={cn(
                                            "w-[13px] shrink-0 text-center",
                                            l.sign === "+" ? "text-diff-added" : l.sign === "-" ? "text-diff-removed" : "text-ink-faint"
                                        )}
                                    >
                                        {l.sign}
                                    </span>
                                    <span
                                        className={cn(
                                            "min-w-0 pr-3.5",
                                            l.sign === "+" ? "text-diff-added" : l.sign === "-" ? "text-diff-removed" : "text-secondary"
                                        )}
                                    >
                                        {l.text}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
```

- [ ] **Step 7: Rewrite `ToolLine`'s JSX**

Keep its state and `onClick`; replace the returned tree. The opacities are gone, and the ↗ button becomes the
"Open full view" text button.

```tsx
    return (
        <div>
            <div onClick={onClick} className={cn(TOOL_ROW, detail && "cursor-pointer hover:bg-lane")}>
                <StatusSquare ok={ok} />
                <span className={VERB}>{action.verb}</span>
                <span className={TARGET}>{action.target}</span>
                {action.summary ? (
                    <span className={cn("shrink-0 font-mono text-[10.5px]", ok ? "text-muted" : "text-error")}>
                        {action.summary}
                    </span>
                ) : null}
                <div className="min-w-[6px] flex-1" />
                {action.durationMs ? (
                    <span className={cn("shrink-0", MONO_FAINT)}>{formatDuration(action.durationMs)}</span>
                ) : null}
                {detail ? <Affordance toModal={toModal} open={open} /> : null}
            </div>
            <AnimatePresence initial={false}>
                {detail && open && !toModal ? (
                    <motion.div
                        key="detail"
                        data-tool-panel
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className={DETAIL_PANEL}
                    >
                        <div className="max-h-[200px] overflow-auto">
                            <ToolDetailBody detail={detail} variant="inline" />
                        </div>
                        <div className="flex items-center gap-2 border-t border-edge-faint px-1.5 py-[3px]">
                            {detail.kind === "bash" ? <ExitChip exit={detail.exit} /> : null}
                            <div className="flex-1" />
                            <button
                                type="button"
                                aria-label="Open full view"
                                onClick={() => modalsModel.pushModal("AgentToolDetailModal", { action })}
                                className="inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 py-[3px] font-mono text-[10.5px] text-ink-mid hover:bg-lane hover:text-primary"
                            >
                                <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden />
                                Open full view
                            </button>
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
```

- [ ] **Step 8: Rewrite `EditBurstRow`'s JSX**

Keep its `detail`, `toModal`, `action` and `onClick`; replace the returned tree:

```tsx
    return (
        <div>
            <div onClick={onClick} className={cn(TOOL_ROW, "cursor-pointer hover:bg-lane")}>
                <StatusSquare ok />
                <span className={VERB}>edited</span>
                <span className={TARGET}>{action.target}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-diff-added">+{adds}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-diff-removed">−{dels}</span>
                <div className="min-w-[6px] flex-1" />
                <Affordance toModal={toModal} open={open} />
            </div>
            <AnimatePresence initial={false}>
                {open && !toModal ? (
                    <motion.div
                        key="detail"
                        data-tool-panel
                        variants={composerReveal}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className={DETAIL_PANEL}
                    >
                        <ToolDetailBody detail={detail} variant="inline" />
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
```

- [ ] **Step 9: Compaction and interrupted dividers**

In `CompactionDivider`, the button's children become:

```tsx
                <span className="h-px flex-1 bg-edge-mid" />
                <span className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-accent/30 bg-accent/[0.07] px-2.5 py-0.5 font-mono text-[10.5px] leading-[1.6]">
                    <span className="font-semibold uppercase tracking-[0.1em] text-accent-soft">Compacted</span>
                    {stat ? (
                        <>
                            <span className="text-ink-faint">·</span>
                            <span className="text-ink-mid">{stat}</span>
                        </>
                    ) : null}
                    {trigger ? (
                        <>
                            <span className="text-ink-faint">·</span>
                            <span className="text-muted">{trigger}</span>
                        </>
                    ) : null}
                    {canExpand ? (
                        <span className="flex text-muted">
                            {open ? <ChevronUp size={10} strokeWidth={2.4} aria-hidden /> : <ChevronDown size={10} strokeWidth={2.4} aria-hidden />}
                        </span>
                    ) : null}
                </span>
                <span className="h-px flex-1 bg-edge-mid" />
```

The summary panel's class becomes `my-2 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3`,
and its eyebrow becomes
`<div className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted">Summary — kept context</div>`.

`InterruptedDivider` becomes:

```tsx
function InterruptedDivider() {
    return (
        <div className="mt-3 flex items-center gap-2.5">
            <span className="h-px flex-1 bg-edge-mid" />
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-edge-strong bg-surface px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase leading-[1.6] tracking-[0.1em] text-ink-mid">
                <Ban size={10} strokeWidth={2.4} aria-hidden />
                Interrupted
            </span>
            <span className="h-px flex-1 bg-edge-mid" />
        </div>
    );
}
```

- [ ] **Step 10: Task notification row**

In `TaskNotificationRow`, keep the layout and ⑃ and change only these classes:
- The glyph square: `mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border font-mono text-[12px]`,
  with the same ok and warning colour classes.
- The button: `flex w-full items-center gap-2 rounded-[8px] border border-edge-mid bg-surface px-2.5 py-1.5 text-left`,
  keeping `cursor-pointer hover:border-edge-strong` / `cursor-default`.
- The "Task" label: `shrink-0 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-mid`.
- The status chip: `shrink-0 rounded-[4px] px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em]`,
  with the same ok and warning colour classes.
- The affordance:
  `{canExpand ? <span className="flex shrink-0 text-muted">{open ? <ChevronDown size={12} strokeWidth={2.2} aria-hidden /> : <ChevronRight size={12} strokeWidth={2.2} aria-hidden />}</span> : null}`.
- The result panel: `mt-1.5 overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code px-3.5 py-3`.

- [ ] **Step 11: The You bubble**

The "You" label becomes `mb-0.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-accent-soft`, and
the text `<p>` becomes `text-[13px] leading-[1.5] text-primary`.

- [ ] **Step 12: The folded run**

Replace the collapsed-group `return (<button ...>)` at the end of `NarrationTimeline`'s map:

```tsx
                const summary = summarizeActions(item.actions);
                return (
                    <button
                        key={"g" + item.startIndex}
                        type="button"
                        data-fold
                        onClick={() => expand(item.startIndex)}
                        className="my-1 flex w-full cursor-pointer items-center gap-2 rounded-[6px] border border-edge-mid px-[5px] py-[3px] text-left font-mono hover:bg-lane"
                    >
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-accent/[0.12] text-accent-soft">
                            <Layers size={11} strokeWidth={2.2} aria-hidden />
                        </span>
                        <span className="shrink-0 text-[11.5px] font-semibold text-secondary">{summary.total} tools</span>
                        <span className="min-w-0 truncate text-[10.5px] text-ink-mid">
                            {summary.byVerb.map((v) => `${v.count} ${v.verb}`).join(" · ")}
                        </span>
                        <div className="min-w-[6px] flex-1" />
                        {/* the word carries the outcome, so colour is never the only signal */}
                        {summary.failed > 0 ? (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-error">
                                <X size={10} strokeWidth={3} aria-hidden />
                                {summary.failed} failed
                            </span>
                        ) : (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-muted">
                                <Check size={10} strokeWidth={3} aria-hidden />
                                all ok
                            </span>
                        )}
                        <span className="flex shrink-0 text-muted">
                            <ChevronRight size={12} strokeWidth={2.2} aria-hidden />
                        </span>
                    </button>
                );
```

Leave the messages, `CommandChip`, `groupTimeline`, `burstRenderMode`, `detailExceedsInline`, motion and
`TIMELINE_RENDER_CAP` untouched.

- [ ] **Step 13: Check that the old classes and glyphs are gone**

Run: `grep -nE "text-xxxs|text-\[9px\]|text-\[9\.5px\]|text-\[10px\]|opacity-\[0\.(72|68)\]|text-feed-time|text-edge-strong|text-feed-label|[✓✗▶▼▲▸↗⊘]" frontend/app/view/agents/narrationtimeline.tsx`
Expected: no output. (✦ and ⑃ stay.)

- [ ] **Step 14: Typecheck, tests, format**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; the baseline is clean)
Run: `npx vitest run frontend/app/view/agents/agentsviewmodel.test.ts`
Run: `npx prettier --check frontend/app/view/agents/narrationtimeline.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts`
Expected: all pass. If prettier fails only on lines you did not touch, leave them.

- [ ] **Step 15: Commit**

```bash
git add frontend/app/view/agents/narrationtimeline.tsx frontend/app/view/agents/agentsviewmodel.ts frontend/app/view/agents/agentsviewmodel.test.ts
git commit -m "feat(agents): put the narration feed on the brief type scale with lucide icons"
```

### Task 2: Insight callout border and ended-transcript opacity
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/agents/markdownmessage.tsx` (`InsightCallout`)
- Modify: `frontend/app/view/agents/endedtranscript.tsx` (the feed container, around line 80)

**Interfaces:**
- Produces: `data-insight` on the Insight callout's root, which the Task 3 scenario reads.

- [ ] **Step 1: Rewrite `InsightCallout`**

Add `import { Lightbulb } from "lucide-react";`, then:

```tsx
function InsightCallout({ text }: { text: string }) {
    return (
        <div data-insight className="my-2.5 rounded-[8px] border border-accent/25 bg-accent/[0.05] px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.1em] text-accent-soft">
                <Lightbulb size={11} strokeWidth={2.2} aria-hidden />
                Insight
            </div>
            {renderMd(text)}
        </div>
    );
}
```

The change also reaches answerbar, planpreview and runbody, which render `MarkdownMessage`. The user approved
that.

- [ ] **Step 2: Undim the ended feed**

In `endedtranscript.tsx`, the scroller's class `h-full overflow-y-auto px-[22px] py-[12px] opacity-80` becomes
`h-full overflow-y-auto px-[22px] py-[12px]`.

- [ ] **Step 3: Typecheck and format**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Run: `npx prettier --check frontend/app/view/agents/markdownmessage.tsx frontend/app/view/agents/endedtranscript.tsx`
Run: `npx vitest run frontend/app/view/agents/insightblocks.test.ts` (the splitter is unchanged; this confirms it)
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/view/agents/markdownmessage.tsx frontend/app/view/agents/endedtranscript.tsx
git commit -m "feat(agents): border the Insight callout and stop dimming ended transcripts"
```

### Task 3: Dev-only feed fixture and the narration-feed CDP scenario
**Depends on:** Task 1, Task 2

**Files:**
- Create: `frontend/app/view/agents/narrationfeedfixture.tsx`
- Modify: `frontend/app/modals/modalsrenderer.tsx` (`REGISTRY`)
- Create: `scripts/cdp/narrationfeed.mjs`
- Modify: `scripts/cdp/scenarios.mjs`: one import line at the top, and `narrationFeed` appended to the `SCENARIOS`
  array. Touch nothing else there; run ba79c116 is editing `dag-lifecycle` in the same file.

**Interfaces:**
- Consumes: `data-tool-panel`, `data-fold` and `button[aria-label="Open full view"]` (Task 1), and `data-insight`
  (Task 2).
- Produces: `window.__narrationFeedFixture: { show(entries: AgentEntry[], width: number): void; clear(): void }`,
  in dev builds only, and the scenario `narration-feed`.

- [ ] **Step 1: Write the fixture modal and seam**

Create `frontend/app/view/agents/narrationfeedfixture.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY: one narration feed over fixture entries, so the narration-feed CDP scenario
// (scripts/cdp/narrationfeed.mjs) can check the rendered feed. Every real host of the feed needs a live
// session or run. Same seam shape as window.__waveDagModalFixture (view/orchestrate/dagmodalstate.ts).

import { ModalShell } from "@/app/modals/modalshell";
import { modalsModel } from "@/app/store/modalmodel";
import type { AgentEntry } from "./agentsviewmodel";
import { NarrationTimeline } from "./narrationtimeline";

export function NarrationFeedFixtureModal({ entries, width }: { entries: AgentEntry[]; width: number }) {
    return (
        <ModalShell open onClose={() => modalsModel.popModal()}>
            <div data-narration-fixture style={{ width }} className="max-h-[80vh] overflow-y-auto bg-surface px-3 py-2">
                <NarrationTimeline entries={entries} active={false} />
            </div>
        </ModalShell>
    );
}

if (import.meta.env.DEV && typeof window !== "undefined") {
    window.__narrationFeedFixture = {
        show: (entries, width) => modalsModel.pushModal("NarrationFeedFixtureModal", { entries, width }),
        clear: () => {
            while (modalsModel.hasOpenModals()) {
                modalsModel.popModal();
            }
        },
    };
}

declare global {
    interface Window {
        __narrationFeedFixture?: {
            show: (entries: AgentEntry[], width: number) => void;
            clear: () => void;
        };
    }
}
```

- [ ] **Step 2: Register it in dev builds only**

In `frontend/app/modals/modalsrenderer.tsx`, add
`import { NarrationFeedFixtureModal } from "@/app/view/agents/narrationfeedfixture";` and make the registry:

```tsx
const REGISTRY: Record<string, ComponentType<any>> = {
    ConfirmModal,
    MessageModal,
    AgentToolDetailModal,
    // the narration-feed CDP scenario's fixture host; import.meta.env.DEV is false in a production build
    ...(import.meta.env.DEV ? { NarrationFeedFixtureModal } : {}),
};
```

- [ ] **Step 3: Write the scenario module**

Create `scripts/cdp/narrationfeed.mjs`:

```js
// narration-feed: the narration timeline (frontend/app/view/agents/narrationtimeline.tsx) against the approved
// polish (docs/superpowers/specs/2026-09-29-narration-timeline-polish-design.md), at a card width and a narrow one.
// Every real host of the feed needs a live session or run, so the feed is mounted over the fixture below through
// the dev-only window.__narrationFeedFixture seam (frontend/app/view/agents/narrationfeedfixture.tsx).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one unbroken token, long enough to overflow a 360px panel if the line did not wrap
const LONG = "C:/Users/dev/waveterm/pkg/retry/testdata/" + "segment/".repeat(12) + "retry_loop_output.log";
const BASH_TARGET = "go test ./pkg/retry/ -run TestBackoff";
const BASH_OUT = `--- FAIL: TestBackoff (0.21s)\n    retry_test.go:42: want 3 attempts, got 4 at ${LONG}\nFAIL`;

const edit = (path, badge, text) => ({
    kind: "action",
    verb: "edited",
    target: path,
    outcome: "ok",
    detail: {
        kind: "edit",
        files: [{ path, badge, adds: 1, dels: 1, lines: [{ sign: "-", text: "for i := 0; i <= max; i++ {" }, { sign: "+", text }] }],
    },
});

// every entry kind; runs of 3+ actions fold (groupTimeline), so the pairs and the separating messages are deliberate
const ENTRIES = [
    { kind: "user", text: "tighten the retry loop and prove it with a test" },
    {
        kind: "message",
        text: "Reading the retry path first.\n\n`★ Insight ─────────────────────────────────────`\n- The loop counts from zero, so `<=` runs one extra attempt.\n`─────────────────────────────────────────────────`",
    },
    {
        kind: "action",
        verb: "grep",
        target: "attempts",
        outcome: "ok",
        summary: "2 matches",
        durationMs: 180,
        detail: {
            kind: "grep",
            matches: [
                { loc: "retry.go:18", code: "for i := 0; i <= max; i++ {" },
                { loc: "retry_test.go:42", code: "want 3 attempts" },
            ],
            more: "+3 more in 2 files",
        },
    },
    {
        kind: "action",
        verb: "ran",
        target: BASH_TARGET,
        outcome: "fail",
        summary: "1 failed",
        durationMs: 4200,
        detail: { kind: "bash", command: BASH_TARGET, output: BASH_OUT, exit: 1 },
    },
    { kind: "message", text: "The test confirms the off-by-one. Checking the callers before editing." },
    { kind: "action", verb: "read", target: "pkg/retry/retry.go", outcome: "ok", summary: "4 lines" },
    { kind: "action", verb: "read", target: "pkg/retry/backoff.go", outcome: "ok" },
    { kind: "action", verb: "ran", target: "go vet ./pkg/retry/", outcome: "fail" },
    { kind: "action", verb: "grep", target: "Retry(", outcome: "ok" },
    { kind: "message", text: "Two callers, both pass a max of 3." },
    { kind: "action", verb: "read", target: "cmd/wsh/main.go", outcome: "ok" },
    { kind: "action", verb: "read", target: "pkg/jobs/runner.go", outcome: "ok" },
    { kind: "action", verb: "grep", target: "maxAttempts", outcome: "ok" },
    { kind: "message", text: "Fixing the bound." },
    edit("pkg/retry/retry.go", "M", `for i := 0; i < max; i++ { // ${LONG}`),
    edit("pkg/retry/retry_test.go", "M", "want 3 attempts"),
    edit("pkg/retry/doc.go", "A", "// Retry runs at most max attempts."),
    { kind: "compaction", trigger: "auto", preTokens: 182000, postTokens: 24000, summary: "Kept: the retry off-by-one and its test." },
    {
        kind: "action",
        verb: "ran",
        target: "task check:ts",
        outcome: "ok",
        durationMs: 98000,
        detail: { kind: "bash", command: "task check:ts", output: "", exit: 0 },
    },
    // a bare line (no detail, as Codex actions are): no affordance, full opacity
    { kind: "action", verb: "read", target: "CHANGELOG.md", outcome: "ok" },
    { kind: "notification", summary: "Subagent checked the other retry loops", status: "completed", result: "No other loop uses `<=`." },
    { kind: "interrupted" },
    { kind: "command", name: "verify", args: "retry", isSkill: true },
    { kind: "message", text: "Bound fixed; TestBackoff passes." },
];

// the text glyphs the polish replaced with icons (✦ and ⑃ stay)
const GONE_GLYPHS = "✓✗▶▼▲▸↗⊘★";

const ROOT = `document.querySelector('[data-narration-fixture]')`;

// the feed's static checks: no text under 10.5px, nothing dimmed, no replaced glyph, the folds and the callout
const STATIC_PROBE = `(() => {
    const root = ${ROOT};
    if (!root) return null;
    const all = [...root.querySelectorAll('*')];
    const small = all
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== ''))
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 10.5)
        .map((el) => el.textContent.trim().slice(0, 30) + ' @' + getComputedStyle(el).fontSize);
    const dim = all.filter((el) => parseFloat(getComputedStyle(el).opacity) < 1).map((el) => (el.textContent || '').trim().slice(0, 30));
    const glyphs = [...${JSON.stringify(GONE_GLYPHS)}].filter((g) => root.innerText.includes(g));
    const folds = [...root.querySelectorAll('[data-fold]')].map((b) => {
        const s = getComputedStyle(b);
        return { text: b.textContent, widths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth] };
    });
    const ins = root.querySelector('[data-insight]');
    const is = ins && getComputedStyle(ins);
    return { small, dim, glyphs, folds, insight: is ? [is.borderTopWidth, is.borderRightWidth, is.borderBottomWidth, is.borderLeftWidth] : null };
})()`;

// click the row whose target span reads `text` (React delegates, so a bubbling click reaches the handler)
const clickRow = (text) => `(() => {
    const span = [...${ROOT}.querySelectorAll('span')].find((s) => s.textContent === ${JSON.stringify(text)});
    if (!span) return false;
    span.parentElement.click();
    return true;
})()`;

// the open panels: footer, wrapping and horizontal overflow
const PANEL_PROBE = `(() => [...${ROOT}.querySelectorAll('[data-tool-panel]')].map((p) => {
    const btn = p.querySelector('button[aria-label="Open full view"]');
    const pre = p.querySelector('pre');
    const footer = btn ? btn.parentElement : null;
    const body = p.firstElementChild;
    return {
        text: (p.textContent || '').slice(0, 40),
        btnText: btn ? btn.textContent.trim() : null,
        btnTitle: btn ? btn.getAttribute('title') : null,
        footer: footer ? footer.textContent : null,
        bodyHasExit: /exit \\d/i.test(footer ? body.textContent : ''),
        ws: pre ? getComputedStyle(pre).whiteSpace : null,
        overflow: Math.max(p.scrollWidth - p.clientWidth, body.scrollWidth - body.clientWidth),
    };
}))()`;

const allEqual1px = (widths) => Array.isArray(widths) && widths.every((w) => w === "1px");

async function show(h, width) {
    await h.ev(`window.__narrationFeedFixture.clear()`);
    await h.ev(`window.__narrationFeedFixture.show(${JSON.stringify(ENTRIES)}, ${width})`);
    await sleep(900); // the modal's open motion and the rows' fade-in settle before styles are read
}

async function staticSteps(h, label) {
    const s = await h.ev(STATIC_PROBE);
    if (!s) return [{ step: `[${label}] feed rendered`, ok: false, detail: "no [data-narration-fixture]" }];
    return [
        { step: `[${label}] no text below 10.5px`, ok: s.small.length === 0, detail: s.small.slice(0, 5).join(" | ") || "none" },
        { step: `[${label}] nothing dimmed`, ok: s.dim.length === 0, detail: s.dim.slice(0, 5).join(" | ") || "none" },
        { step: `[${label}] no replaced text glyphs`, ok: s.glyphs.length === 0, detail: s.glyphs.join(" ") || "none" },
        {
            step: `[${label}] folded runs: 1px border all round, "N tools", one "1 failed", one "all ok"`,
            ok:
                s.folds.length === 2 &&
                s.folds.every((f) => allEqual1px(f.widths) && /\d+ tools/.test(f.text)) &&
                s.folds.some((f) => f.text.includes("1 failed")) &&
                s.folds.some((f) => f.text.includes("all ok")),
            detail: JSON.stringify(s.folds),
        },
        { step: `[${label}] insight callout: 1px border all round`, ok: allEqual1px(s.insight), detail: JSON.stringify(s.insight) },
    ];
}

export const narrationFeed = {
    name: "narration-feed",
    surface: "cockpit",
    async arrange() {
        return {};
    },
    async assert(h) {
        const steps = [];
        let seam = false;
        for (let i = 0; i < 25 && !seam; i++) {
            seam = await h.ev(`typeof window.__narrationFeedFixture === 'object'`);
            if (!seam) await sleep(200);
        }
        steps.push({ step: "dev fixture seam present", ok: seam === true, detail: `seam=${seam}` });
        if (!seam) return steps;

        // wide: a card
        await show(h, 640);
        steps.push(...(await staticSteps(h, "640")));
        const opened = await h.ev(clickRow(BASH_TARGET));
        const openedOk = await h.ev(clickRow("task check:ts"));
        await sleep(600);
        const panels = await h.ev(PANEL_PROBE);
        const fail = panels.find((p) => p.text.includes("TestBackoff"));
        const ok = panels.find((p) => p.text.includes("task check:ts"));
        steps.push({
            step: '[640] bash panel footer: "Open full view" with aria-label and no title, exit chip in the footer only',
            ok:
                opened === true &&
                fail != null &&
                fail.btnText === "Open full view" &&
                fail.btnTitle === null &&
                /exit 1/i.test(fail.footer || "") &&
                fail.bodyHasExit === false,
            detail: JSON.stringify(fail ?? null),
        });
        steps.push({ step: "[640] bash output wraps (pre-wrap)", ok: fail?.ws === "pre-wrap", detail: `ws=${fail?.ws}` });
        steps.push({
            step: "[640] command-only bash with exit 0 shows exit 0 in the footer",
            ok: openedOk === true && ok != null && /exit 0/i.test(ok.footer || ""),
            detail: JSON.stringify(ok ?? null),
        });
        await h.shot("cdp-shots/narration-feed-wide.png");

        // "Open full view" opens the tool detail modal, which keeps its lines unwrapped
        await h.ev(`[...${ROOT}.querySelectorAll('button[aria-label="Open full view"]')][0].click()`);
        await sleep(700);
        const modalWs = await h.ev(`(() => {
            const root = ${ROOT};
            const pres = [...document.querySelectorAll('pre')].filter((p) => !root.contains(p) && (p.textContent || '').includes('TestBackoff'));
            return pres.length ? getComputedStyle(pres[pres.length - 1]).whiteSpace : null;
        })()`);
        steps.push({ step: "tool detail modal keeps unwrapped lines (white-space: pre)", ok: modalWs === "pre", detail: `ws=${modalWs}` });
        await h.shot("cdp-shots/narration-feed-modal.png");

        // narrow: the long token must wrap inside the panels, not scroll them sideways
        await show(h, 360);
        steps.push(...(await staticSteps(h, "360")));
        await h.ev(clickRow(BASH_TARGET));
        await h.ev(clickRow("3 files"));
        await sleep(600);
        const narrow = await h.ev(PANEL_PROBE);
        steps.push({
            step: "[360] bash and edit panels do not scroll sideways",
            ok: narrow.length === 2 && narrow.every((p) => p.overflow <= 1),
            detail: JSON.stringify(narrow.map((p) => ({ text: p.text, overflow: p.overflow }))),
        });
        await h.shot("cdp-shots/narration-feed-narrow.png");
        return steps;
    },
    async teardown(h) {
        await h.ev(`window.__narrationFeedFixture?.clear()`);
    },
};
```

- [ ] **Step 4: Register the scenario**

In `scripts/cdp/scenarios.mjs`, add `import { narrationFeed } from "./narrationfeed.mjs";` after the
`import { SURFACE_LABEL } from "./attach.mjs";` line, and add `narrationFeed,` as the last element of the
`export const SCENARIOS = [...]` array (after `focusDivergenceRejoin,`).

Run: `node --check scripts/cdp/narrationfeed.mjs && node --check scripts/cdp/scenarios.mjs`
Expected: no output.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 6: Run the scenario against a dev app built from this worktree**

Run: `ARC_FINAL_OUT="$(mktemp -d)" node scripts/cdp/final-verify.mjs narration-feed`
It boots its own dev app on its own ports and never touches the main dev app or the user's Arc; a cold cargo build
can take up to 10 minutes. Expected: every `narration-feed` step PASS. Then look at
`cdp-shots/narration-feed-wide.png`, `-narrow.png` and `-modal.png` (copied into `$ARC_FINAL_OUT`) beside the
mockup's Polished state (`Main.dc.html`, `ToolRows.dc.html`). A failing step names its offenders in `detail`. Fix
the component if it contradicts the spec, and fix the probe if the probe is wrong. Never loosen a check to
pass. Exit 3 means the app could not boot; its last line says why.

- [ ] **Step 7: Format and commit**

Run: `npx prettier --check frontend/app/view/agents/narrationfeedfixture.tsx frontend/app/modals/modalsrenderer.tsx`
(not the `.mjs` files: `.editorconfig` omits them and prettier would reindent them)

```bash
git add frontend/app/view/agents/narrationfeedfixture.tsx frontend/app/modals/modalsrenderer.tsx scripts/cdp/narrationfeed.mjs scripts/cdp/scenarios.mjs
git commit -m "test(cdp): narration-feed scenario over a dev-only feed fixture"
```
