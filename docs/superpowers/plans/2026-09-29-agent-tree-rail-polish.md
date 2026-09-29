# Agent tree and details rail polish

**Verify:** `node scripts/verify.mjs ./pkg/waveobj/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs agent-tree-rail surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/agent-tree/project/Main.dc.html

Spec: `docs/superpowers/specs/2026-09-29-agent-tree-rail-polish-design.md`. Read it first. It restates the mockups'
values and records every decision. The mockups are the design: the `POLISHED` table in each board's script (search
for `const POLISHED`) holds the exact values, and TODAY minus POLISHED is the change list. They are gitignored, so read
them by absolute path:

- tree: `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/agent-tree/project/{Main,Agents,Runs}.dc.html`
- rail: `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/agent-rail/project/Main.dc.html`

To view them, serve with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from the main
checkout, if port 8766 does not already answer.

Global constraints, for every task:

- Colours come only from `@theme` tokens (`frontend/tailwindsetup.css`): no new tokens, no raw hex or rgba in classes or styles, no emoji. `bg-askingbg`, `bg-edge-mid`, `bg-edge-strong`, `text-ink-mid` and `text-ink-hi` already exist.
- Icons come from `lucide-react`, which is already a dependency. Pass `size={N}` and `aria-hidden`, and colour them through `currentColor` (a text class).
- Frontend only: no Go, wire-type or generated-file change.
- Don't touch run a2521425's files (`narrationtimeline.tsx`, `agentsviewmodel.ts`, `markdownmessage.tsx`, `endedtranscript.tsx`, `narrationfeedfixture.tsx`, `modalsrenderer.tsx`) or run ba79c116's (`frontend/app/view/orchestrate/*`; import `dagdigest` and `dagmodalstate` as they are).
- Pure logic goes in a `.ts` with a `.test.ts` beside it. There are no jsdom or render tests.
- Only touch what the task names. Check formatting on your files only (`npx prettier --check <files>`); never `--write` the tree.
- Comments explain why, in lower case, and only when needed. Match the surrounding comment style.

---

### Task 1: Tree polish, with the shared strip model and the completed-run predicate
**Depends on:** none

Files:
- Create: `frontend/app/view/agents/runstrip.ts`, `frontend/app/view/agents/runstrip.test.ts`
- Modify: `frontend/app/view/agents/runmodel.ts` and `runmodel.test.ts` (add `runComplete`)
- Modify: `frontend/app/view/agents/agenttreemodel.ts` and `agenttreemodel.test.ts` (add `stageSubline`)
- Modify: `frontend/app/view/agents/agenttree.tsx`

Produces, for Task 3: `runstrip.ts` exports `SEG_FILL: Record<LaneState, string>`, which Task 3 makes the rail import.
Don't edit `runrailsections.tsx` here. Task 2 is editing it at the same time, and its local `SEG_FILL` stays until Task 3.

**Step 1: write the failing tests.**

`runstrip.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SEG_FILL, STRIP_MAX, taskStrip, taskStripLabel } from "./runstrip";

const task = (id: string, state: string): TaskNode => ({ id, label: id, state }) as TaskNode;
const dagOf = (...states: string[]) => ({ tasks: states.map((s, i) => task(`t-${i + 1}`, s)) }) as TaskGroup;

describe("taskStrip", () => {
    it("has no strip without a dag or tasks", () => {
        expect(taskStrip(undefined, undefined)).toBeUndefined();
        expect(taskStrip({ tasks: [] } as TaskGroup, undefined)).toBeUndefined();
    });
    it("is one segment per task in plan order", () => {
        expect(taskStrip(dagOf("done", "running", "pending", "failed"), undefined)).toEqual({
            kind: "segments",
            states: ["done", "working", "pending", "failed"],
        });
    });
    it("marks a task whose question you hold as asking", () => {
        const digest = { tasks: [{ taskid: "t-2", waitreason: "user-ask" }] } as DagStatusDigest;
        expect(taskStrip(dagOf("done", "running"), digest)).toEqual({ kind: "segments", states: ["done", "asking"] });
    });
    it("keeps segments at exactly STRIP_MAX tasks", () => {
        const s = taskStrip(dagOf(...Array(STRIP_MAX).fill("pending")), undefined);
        expect(s?.kind).toBe("segments");
    });
    it("becomes one done/total bar past STRIP_MAX", () => {
        const states = [...Array(10).fill("done"), ...Array(STRIP_MAX - 9).fill("pending")];
        expect(taskStrip(dagOf(...states), undefined)).toEqual({ kind: "bar", done: 10, total: STRIP_MAX + 1 });
    });
});

describe("taskStripLabel", () => {
    it("counts done tasks the way the row's N/M text does, skipped included", () => {
        expect(taskStripLabel(dagOf("done", "skipped", "running"), undefined)).toBe("2 of 3 tasks done");
    });
    it("names the questions waiting on you", () => {
        const digest = { tasks: [{ taskid: "t-2", waitreason: "user-ask" }] } as DagStatusDigest;
        expect(taskStripLabel(dagOf("done", "running"), digest)).toBe("1 of 2 tasks done, 1 asking you");
    });
});

describe("SEG_FILL", () => {
    it("has a token fill for every lane state", () => {
        for (const st of ["done", "working", "asking", "lead", "pending", "failed", "muted"] as const) {
            expect(SEG_FILL[st]).toMatch(/^bg-[a-z-]+$/);
        }
    });
});
```
Before relying on `waitreason: "user-ask"`, check how `workerAsk` (`runlineage.ts`) decides `owner === "you"` from a
digest, and use whatever digest shape it reads. `runrail.test.ts` builds a lead ask with `waitreason: "lead-ask"`.

In `runmodel.test.ts`, add a `describe("runComplete")` that reuses the `info(status, land, dagStatus)` helper shape of
the `finishedRunLabel` block (copy the helper into the new describe):
- true: `info("done")` and `info("done", { state: "landed" })`;
- false: `info("done", { state: "pending" })` (landing), `info("done", { state: "held" })`, `info("executing")`, `info("finalizing")`, `info("done", undefined, "cancelled")`, `info("cancelled")`, `info("done", undefined, "running")`, and a RunInfo with no `dag`.

In `agenttreemodel.test.ts`, add:
```ts
describe("stageSubline", () => {
    it("says the verdict and the age, not the role the title already names", () => {
        expect(stageSubline("passed", "14m")).toBe("passed · 14m");
    });
    it("is just the age while the stage is judging", () => {
        expect(stageSubline(undefined, "2m")).toBe("2m");
    });
});
```

**Step 2:** `npx vitest run frontend/app/view/agents/runstrip.test.ts frontend/app/view/agents/runmodel.test.ts frontend/app/view/agents/agenttreemodel.test.ts` fails, because the exports don't exist yet.

**Step 3: implement.**

`runstrip.ts`:
```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: the per-task strip a run draws, under its row in the agent tree and as the rail's Run bar. One fill map for
// both, so the two cannot disagree about a task.

import { runProgress } from "./runlineage";
import { runSegments, type LaneState } from "./runrail";

export const SEG_FILL: Record<LaneState, string> = {
    done: "bg-success",
    working: "bg-accent",
    asking: "bg-warning",
    lead: "bg-accent",
    pending: "bg-edge-strong",
    failed: "bg-error",
    muted: "bg-muted",
};

// past this many tasks the segments get too thin to read in the 248px tree, so the strip becomes one bar
export const STRIP_MAX = 24;

export type TaskStrip = { kind: "segments"; states: LaneState[] } | { kind: "bar"; done: number; total: number };

export function taskStrip(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined): TaskStrip | undefined {
    const states = runSegments(dag, digest);
    if (states.length === 0) {
        return undefined;
    }
    if (states.length > STRIP_MAX) {
        return { kind: "bar", ...runProgress(dag) };
    }
    return { kind: "segments", states };
}

export function taskStripLabel(dag: TaskGroup | undefined, digest: DagStatusDigest | undefined): string {
    const { done, total } = runProgress(dag);
    const asking = runSegments(dag, digest).filter((s) => s === "asking").length;
    return `${done} of ${total} tasks done${asking > 0 ? `, ${asking} asking you` : ""}`;
}
```
Check for an import cycle first: `runrail.ts` imports `runlineage.ts`, and `runlineage.ts` must not import `runstrip.ts`.

In `runmodel.ts`, beside `finishedRunLabel`:
```ts
const COMPLETE_LABELS = new Set(["landed", "run complete"]);

// runComplete is a run with nothing left to happen: its plan done and the run itself over and landed (or with nothing
// to land). a lead still wrapping up, a land in flight or held, and a cancelled run are not complete.
export function runComplete(run: RunInfo): boolean {
    return run.dag?.status === "done" && COMPLETE_LABELS.has(finishedRunLabel(run));
}
```
In `agenttreemodel.ts`:
```ts
export function stageSubline(outcome: StageOutcome | undefined, age: string): string {
    return [outcome, age].filter(Boolean).join(" · ");
}
```

**Step 4:** the three test files pass.

**Step 5: restyle `agenttree.tsx`** to the tree board's POLISHED table, as the spec's Tree section lists. In practice:

- **Leading slot.** Add one local `Slot` component, `flex w-[14px] shrink-0 items-center justify-center`. Put every leading mark in it: the `StatusDot`s (keep `!h-[7px] !w-[7px]`), the hollow and solid 7px dots, the stage outcome dot, the terminal icon, the lead/run icon and the fold marks. Rows use `gap-[9px]`.
- **Padding, guides and nesting.**
  - Top rows (ParentRow, RunRow, TerminalRow) are `px-[11px] py-[9px]`. WorkerRow and StageRow are `py-[7px] pl-[28px] pr-[11px]`, and nested workers are `pl-[45px]`. Subagent rows and FoldRow are `py-[6px] pl-[28px] pr-[11px]`.
  - Delete `Elbow` and the subagent row's inline ↳.
  - Add a local `Guides({ depth })` that renders `depth` spans, each `absolute inset-y-0 w-px bg-edge-strong`, at `left-[18px]` and then `left-[35px]`. Depth is 1 for worker, stage, subagent and fold rows, and 2 for nested workers. The rows are already `relative`.
- **Names.**
  - Top names are `truncate text-[13px] font-medium text-ink-hi`: the default sans, so drop `font-mono`. Child names (worker, stage) are `text-[12.5px] font-medium`. Subagent type is `font-mono text-[11.5px] font-medium text-secondary`.
  - The second line is `mt-[3px] truncate font-mono text-[10.5px] text-muted`. A worker that asks you is `text-warning`.
  - The subagent model line is `font-mono text-[10.5px] text-muted`.
- **RenameBox** is `rounded-[5px] border border-accent bg-surface px-[5px] text-[13px] font-medium text-primary`, sans.
- **Tags.**
  - "asking" is `font-mono text-[10.5px] font-semibold text-warning`, and "failed" is the same in `text-error`.
  - "→ lead" becomes `<span className="flex items-center gap-[3px] whitespace-nowrap font-mono text-[10.5px] font-medium text-muted"><ArrowRight size={10} aria-hidden />lead</span>`.
- **Fold chip.**
  - Make one local `FoldChip({ label, open, onToggle, ariaShow, ariaHide })`. It is a `<button>` with `aria-label={open ? ariaHide : ariaShow}` and `aria-expanded={open}`, and no `title`.
  - Its class is `inline-flex h-[18px] flex-none items-center gap-[3px] rounded-[5px] border border-edge-mid bg-surface-hover pl-[3px] pr-[6px] font-mono text-[10.5px] font-semibold text-ink-mid hover:border-accent hover:text-accent-soft`.
  - Its icon is `open ? <ChevronDown size={10} aria-hidden /> : <ChevronRight size={10} aria-hidden />`. Its click stops propagation.
  - It serves three chips:
    - The run chip in RunSubline keeps its label. Its aria text is "Show workers" / "Hide workers".
    - The subagents chip reads `${n} ${n === 1 ? "subagent" : "subagents"}`, with aria text "Show subagents" / "Hide subagents". On a plain agent row it is the first thing on the second line, before the branch, in a `flex min-w-0 items-center gap-[6px]` line. On a lead row it stays at the row's end.
    - The extras chip reads `${n} ${n === 1 ? "session" : "sessions"}`, with aria text "Show reviewer and earlier sessions" / "Hide reviewer and earlier sessions". It is the first thing on the worker's second line.
- **Lead and run mark.**
  - Delete `RunGlyph`. In the status slot, a lead row and RunRow draw `<Workflow size={13} aria-hidden className={...} />`.
  - For a lead, the class follows the dot's rule: `runComplete(run)` gives `text-success` with no pulse. Otherwise standing by or idle is `text-muted`, working is `text-accent`, and asking is `text-warning`, the last two with `animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none`.
  - RunRow uses `text-success` when `runComplete(run)`, else `text-muted`.
  - Check `StatusDot` for how it maps state to colour and use the same tokens.
- **RunSubline.**
  - When `runComplete(run)`, the progress text becomes `<span className="flex min-w-0 items-center gap-[5px] text-success"><Check size={11} aria-hidden className="flex-none" /><span className="truncate">{finishedRunLabel(run)}</span></span>`. The words are unchanged.
  - Under the line, when `taskStrip(run.dag, run.digest)` is defined, render the strip: `<div role="img" aria-label={taskStripLabel(run.dag, run.digest)} className="mt-[6px] flex h-[3px] gap-[2px]">`.
    - For `segments`, it holds one `<span className={cn("min-w-[2px] flex-1 rounded-[1.5px]", SEG_FILL[st])} />` per state.
    - For `bar`, it holds a `bg-success` span with `style={{ flexGrow: done }}` and a `bg-edge-strong` span with `style={{ flexGrow: total - done }}`, both `min-w-0 rounded-[1.5px]`.
  - The no-dag branch keeps its status text, restyled as a second line.
- **StageRow**'s second line is `stageSubline(outcome, formatAgeShort(displayAgeMs(agent, now)))`.
- **FoldRow.**
  - Text is `font-mono text-[10.5px] text-ink-mid`. The end chevron is a `ChevronDown`/`ChevronRight` 10px in `ml-auto flex text-muted`.
  - The done glyph is `<Check size={11} aria-hidden className="text-success" />` in the slot. The queued glyph stays the hollow 7px dot.
- **TerminalRow**'s ›_ becomes `<SquareTerminal size={13} aria-hidden className="text-muted" />` in the slot.
- **Header and groups.**
  - The "Agents" h3 is `font-mono text-[10.5px] font-bold uppercase tracking-[.1em] text-ink-mid`, and its count is `font-mono text-[10.5px] font-semibold text-muted`.
  - The group and Terminals labels are `text-[10.5px] font-bold ... text-muted`. The divider is `bg-edge-mid`. The count is `font-mono text-[10.5px] font-semibold text-muted`, with `text-feed-time` gone.
  - The header and group asking badges read `{n} asking`, as `whitespace-nowrap rounded-[5px] bg-askingbg px-[6px] py-[1px] font-mono text-[10.5px] font-semibold text-warning`. Make it one local `AskingBadge({ n })`, used in both places.
- **Unchanged:** selection and the asking tint, click and context-menu handlers, `buildAgentTree`, the motion wrappers, entrance guards and `AnimatePresence`, and the subagent reveal.

**Step 6:** run the Check command, `npx vitest run frontend/app/view/agents`, and `npx eslint frontend/app/view/agents/agenttree.tsx frontend/app/view/agents/runstrip.ts`.
Open Main.dc.html (Polished, one and several projects) beside the dev app if one runs from your worktree. You can't
arrange runs without Task 3's scenario, so a visual check of the plain agent rows, the header and the terminals is
enough here.

### Task 2: Rail polish
**Depends on:** none

Files:
- Create: `frontend/app/view/agents/sectionlabel.tsx`
- Modify: `frontend/app/view/agents/runrailsections.tsx`, `agentdetailsrail.tsx`, `tokenusagesection.tsx`
- Modify: `frontend/app/view/agents/runrail.ts` and `runrail.test.ts` (lane "lead" text)
- Modify: `frontend/app/element/collapsiblerail.tsx` (collapse icon only)

Don't touch `SEG_FILL` in `runrailsections.tsx`: Task 3 swaps it for the shared one. Don't touch `agenttree.tsx`,
`runmodel.ts`, `agenttreemodel.ts` or `runstrip.ts` (all Task 1).

**Step 1: failing test.** In `runrail.test.ts`, change the lead-ask lane expectation from `text: "→ lead"` to
`text: "lead"`. `npx vitest run frontend/app/view/agents/runrail.test.ts` fails.

**Step 2:** in `runrail.ts` `laneRow`, return `text: "lead"` for the `ask?.owner === "lead"` case. The test passes.

Also grep for other readers of the lane text (`grep -rn '"→ lead"' frontend/app`). `leadcardmodel.ts` has its own
"→ lead" tag and is out of scope: leave it.

**Step 3: `sectionlabel.tsx`.**
```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The details rail's two label levels, on the Jarvis brief scale: a section heading, and the muted label under it.

import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";

export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
    return <h3 className={cn(REGION_LABEL, "text-ink-mid", className)}>{children}</h3>;
}

export function SubLabel({ children, className }: { children: React.ReactNode; className?: string }) {
    return <span className={cn(REGION_LABEL, "text-muted", className)}>{children}</span>;
}
```
Delete the three local `SectionLabel`s and import these. Check that `cn` merges Tailwind classes, so the
`className="text-warning"` on Needs you still wins over `text-ink-mid`.

**Step 4: restyle** to the rail board's POLISHED table, as the spec's Rail section lists.

- **Sub-labels become `SubLabel`:** Activity, Tokens, ≈ Spend, By model, the question header in NeedsYouCard and LeadAskCard (`<SubLabel className="mt-[6px] inline-block">`), and "Subagent of …".
- **Lanes.**
  - The grid is `grid-cols-[20px_minmax(0,1fr)_auto]`. The key box is `h-[20px] w-[20px] ... font-mono text-[10.5px] font-semibold text-ink-mid`, and the lane dot is `h-[7px] w-[7px]`.
  - History is `truncate font-mono text-[10.5px] text-muted`.
  - For `r.state === "lead"`, drop the dot and render `<ArrowRight size={10} aria-hidden />` before the text (which is now "lead").
- **LaneAsk:**
  - The wrapper is `mb-[6px] ml-[35px] mr-[6px] rounded-[8px] border border-edge-mid bg-surface-raised px-[10px] py-[7px]`, with no `border-l-2`.
  - The meta line is `font-mono text-[10.5px] text-muted`.
- **Activity:**
  - Timestamps are `text-muted`.
  - Both buttons are `inline-flex items-center gap-[3px] ... font-mono text-[10.5px] font-semibold`.
  - "timeline ↗" becomes `timeline<ArrowUpRight size={11} aria-hidden />`.
- **↗ becomes ArrowUpRight (11px)** on "answer in {task}" and "answer in the run" (the label strings lose " ↗", and the button renders the icon after the label), "plan · Task N", and "View diff". Make those buttons `inline-flex items-center gap-[3px]`.
- **Run status.**
  - `RUN_STATUS.done.text` becomes `"Done"`. When the status shown is the done one, render `<Check size={12} aria-hidden />` before it, in an `inline-flex items-center gap-[4px]` span.
- **Task section** Lead line: "↑" becomes `<ArrowUp size={11} aria-hidden />`, in an inline-flex with a 3px gap, in both the button and the plain-text branch.
- **Token usage.**
  - The captions under the totals are `text-[10.5px]`.
  - The percent column is `w-[40px] ... text-[10.5px]`. The model count and the footnote are `text-[10.5px]`.
  - The insight ◆ becomes `<Lightbulb size={13} aria-hidden className="mt-[1px] flex-none text-warning" />`.
  - The breakdown toggle is `inline-flex items-center gap-[3px]`, reading "Show breakdown" + `ChevronDown` or "Hide breakdown" + `ChevronUp`, both 11px.
- **agentdetailsrail.tsx.**
  - Tool counts are `text-[10.5px] text-muted`.
  - The subagents list's model is `truncate font-mono text-[10.5px] text-muted`. Its state is `font-mono text-[10.5px] font-semibold`, coloured with `style={{ color: SUB_COLOR[s.state] }}` (as the subagent head does), and reads "failed" for `failure`.
  - The subagent head's state gets `font-semibold`. "◂ back to" becomes `<ArrowLeft size={11} aria-hidden />` plus "back to {name}", in an `inline-flex items-center gap-[4px]` button.
  - In RailStrip, ‹ becomes `<ChevronLeft size={18} aria-hidden />`. The badge becomes `-right-[8px] -top-[6px] h-[16px] min-w-[16px] rounded-[8px] ... text-[10.5px] font-bold`, and the percentage becomes `text-[10.5px]`.
- **collapsiblerail.tsx:** the collapse button's › becomes `<ChevronRight size={16} aria-hidden />`. Keep its `aria-label` and `title`, and make the button `flex items-center` so the icon centres. Change nothing else in that file.
- **Unchanged:** layout, widths, the Details lines, the context meter, Compact/Clear, the card bodies, the token numbers and bars, the footer, motion, and the `title`s on Compact, Clear, Resume and Stop.

**Step 5:** run the Check command, `npx vitest run frontend/app/view/agents`, and eslint on the touched files.
Compare against the rail board in Polished for each session kind.

### Task 3: One segment-colour map, and a CDP scenario for the tree and rail
**Depends on:** Task 1, Task 2

Files:
- Modify: `frontend/app/view/agents/runrailsections.tsx` (the `SEG_FILL` import only)
- Modify: `scripts/cdp/scenarios.mjs` (append at the very end)

**Step 1.** In `runrailsections.tsx`, delete the local `SEG_FILL` and import it from `./runstrip`. The rail's run bar
and the tree strip now read one map. Run the Check command.

**Step 2: scenario `agent-tree-rail`**, appended as the last scenario definition and the last entry of `SCENARIOS`.
Run a2521425 appends `narrationFeed`, so appending last keeps any merge to an adjacent-append conflict. Model it on
the existing scenarios' `arrange / assert / teardown` shape and helpers (`h.rpc`, `h.ev`). Read `scripts/cdp/verify.mjs`
and `attach.mjs` for the harness API and how viewport pinning works (pin 1600x950).

- **arrange.**
  - Make a temp dir and `createchannel { name: "verify-tree-rail", projectpath: cwd }`.
  - Call `createrun { channelid, workspaceid, goal: "verify tree rail: do nothing", runtime: "claude", mode: "orchestrator", deferstart: true }`. deferstart persists it in planning and spawns no worker, and `runRoleOf` makes an agent whose `runId` is this run a lead.
  - **Do not call `dagsubmit`**: with the plan gate gone it would start real workers.
  - Write `public/cockpit-fixtures/active.json` (the dev fixture roster; see `frontend/app/view/agents/devmock.ts` and `scripts/cockpit-fixtures/scenarios.mjs` for the AgentVM record shape). It is a JSON array of:
    - a lead `{ id: "fx-lead", name: "tree-rail lead", project: "waveterm", state: "working", runId: <run id>, blockId: "fx-blk-lead", ... }`;
    - two asking agents, one in `waveterm` and one in `siem-platform`;
    - an idle agent.
  - Reload the page (`location.reload()`), wait for `[data-agent-tree]`, go to the Agent (cockpit) surface, and click the lead row to focus it and open the rail.
- **assert:**
  1. The header or group badges contain the text "asking", for example "1 asking" on each group, since two projects are live.
  2. No text node under `[data-agent-tree]` or the rail `aside[aria-label="Agent details"]` contains `↳`, `◆`, `▸`, `▾`, `›_`, `↗` or `‹`.
  3. The lead row's first child mark is an `svg` whose parent computes to width 14px.
  4. With the lead focused, the rail's `h3` "Details" and "Run" compute to `font-size: 10.5px` and `font-weight: 700`.
  5. Walk every visible text node in the tree and the rail. None has a computed font-size under 10.5px. Report the offenders' text and size in the step detail.
  6. The collapse control (`aria-label="Collapse panel"`) contains an `svg`.
- **teardown:**
  - Delete `public/cockpit-fixtures/active.json` and reload.
  - Remove the run and its channel the way other channel scenarios clean up; grep for the channel-delete RPC they use.
  - Remove the temp dir. Every step is best-effort, and a failing step is logged, not swallowed.

**Step 3: run it live.**
- Start a dev app from this worktree the way `scripts/cdp/final-verify.mjs` does: its own ports, profile and store, never touching the user's running app. The simplest route is `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs agent-tree-rail`.
- It must pass. Check that it would fail against the old UI: step 2 and step 5 flag ↳ and the 9.5px chips.
- Open the contact sheet and compare the tree against Main.dc.html (Polished) and the rail against the rail board.
- Fix any real miss in the owning file. A styling fix in `agenttree.tsx` or the rail files belongs in this task now that both have landed.
- Never kill a `wave-tauri.exe` or `wavesrv.x64.exe` you did not start. See AGENTS.md: stop by PID only.
