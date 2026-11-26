// Scenario `transcript-subagents-nowline`: running background subagents in the parent's now line. Arranged over the
// transcript-subagents fixture (transcript-subagents-fixture.mjs) with the parent idle and its turn ended; teardown
// removes it. Steps: the idle line names the most recently started child and counts both, and opens it; finishing it
// names the other with no count; a working parent carries a "1 subagent" chip at the working line's right end; the
// line leaves once the parent is idle and the last child finished.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPage } from "./agent-page-fixtures.mjs";
import { polishWaitFor } from "./scenarios-shared.mjs";
import {
    arrangeSubagentsAgent,
    finishSubagent,
    setParentState,
    SUBAGENTS,
    teardownSubagentsAgent,
    writeSubagentsFixture,
} from "./transcript-subagents-fixture.mjs";

const NAME = "transcript-subagents-nowline";
// the first listing, and the parent's debounced refresh behind it
const LOAD_WAIT_MS = 15_000;
// a finished child is read by the next 2 s poll of the listing
const POLL_WAIT_MS = 10_000;
const STATE_WAIT_MS = 5_000;
// how far the chip's right edge may sit from the working line's
const EDGE_PX = 1;

const VIEW = `document.querySelector("[data-cockpit-surface-wrap] [data-rendered-view]")`;
const LINE = `${VIEW}?.querySelector("[data-subagent-nowline]")`;
const flat = (expr) => `((${expr})?.textContent ?? "").replace(/\\s+/g, " ").trim()`;
const inLine = (sel) => flat(`${LINE}?.querySelector(${JSON.stringify(sel)})`);

const lineState = `({
    present: ${LINE} != null,
    named: ${LINE}?.querySelector("[data-subagent-named]")?.getAttribute("data-subagent-named") ?? null,
    description: ${inLine("[data-subagent-description]")},
    call: ${inLine("[data-subagent-call]")},
    elapsed: ${inLine("[data-subagent-elapsed]")},
    count: ${LINE}?.querySelector("[data-subagent-count]") != null ? ${inLine("[data-subagent-count]")} : null,
})`;

const chipState = `(() => {
    const work = ${VIEW}?.querySelector("[data-working-line]");
    const chip = work?.querySelector("[data-subagent-chip]");
    if (!chip) return { working: work != null, chip: null };
    return {
        working: true,
        chip: chip.textContent.replace(/\\s+/g, " ").trim(),
        last: work.lastElementChild === chip,
        gap: work.getBoundingClientRect().right - chip.getBoundingClientRect().right,
        idleLine: ${LINE} != null,
    };
})()`;

const focusedSubagent = (h) =>
    agentPage(
        h,
        `const S = await mod("app/view/agents/subagentsstore.ts");
        return globalStore.get(S.focusSubagentAtom)?.agentId ?? null;`
    );
const closeSubagent = (h) =>
    agentPage(
        h,
        `const S = await mod("app/view/agents/subagentsstore.ts");
        globalStore.set(S.focusSubagentAtom, null);
        return true;`
    );

export default function (_kit) {
    return [
        {
            name: NAME,
            surface: "agent",
            async arrange(h) {
                const ctx = { dir: mkdtempSync(join(tmpdir(), "verify-ts-nowline-")) };
                // a throw past this point still returns ctx, so teardown undoes whatever was already set
                try {
                    Object.assign(ctx, writeSubagentsFixture(ctx.dir, { turnEnded: true }));
                    await arrangeSubagentsAgent(h, ctx, { state: "idle" });
                } catch (e) {
                    ctx.arrangeError = String(e?.message ?? e);
                }
                return ctx;
            },
            async assert(h, ctx) {
                const steps = [];
                const rec = (step, ok, detail) => steps.push({ step, ok, detail });
                if (ctx.arrangeError != null) {
                    rec("arrange the fixture agent", false, ctx.arrangeError);
                    return steps;
                }
                const { audit, research } = SUBAGENTS;

                await polishWaitFor(
                    h,
                    `(() => { const s = ${lineState}; return s.named === ${JSON.stringify(audit.agentId)} && s.call !== "" && s.count != null; })()`,
                    LOAD_WAIT_MS
                );
                const s1 = await h.ev(lineState);
                await h.shot("cdp-shots/transcript-subagents-nowline-1-idle.png");
                await h.ev(`${LINE}?.querySelector("[data-subagent-named]")?.click()`);
                const focused1 = await focusedSubagent(h);
                await closeSubagent(h);
                rec(
                    "1. the idle parent's now line names the most recently started child with its call and elapsed, counts both, and opens it",
                    s1.named === audit.agentId &&
                        s1.description === audit.description &&
                        s1.call.startsWith("Read") &&
                        /^· \d/.test(s1.elapsed) &&
                        s1.count === "2 subagents running" &&
                        focused1 === audit.agentId,
                    JSON.stringify({ ...s1, focused: focused1 })
                );

                finishSubagent(ctx.childPaths.audit);
                await polishWaitFor(
                    h,
                    `(() => { const s = ${lineState}; return s.named === ${JSON.stringify(research.agentId)} && s.count == null; })()`,
                    POLL_WAIT_MS
                );
                const s2 = await h.ev(lineState);
                await h.shot("cdp-shots/transcript-subagents-nowline-2-one-left.png");
                rec(
                    "2. once the named child finishes, the count leaves and the other child is named",
                    s2.named === research.agentId && s2.description === research.description && s2.count == null,
                    JSON.stringify(s2)
                );

                await setParentState(h, ctx, "working");
                // the idle line plays its exit before it leaves the DOM
                await polishWaitFor(h, `(() => { const c = ${chipState}; return c.chip != null && !c.idleLine; })()`, STATE_WAIT_MS);
                const c3 = await h.ev(chipState);
                await h.shot("cdp-shots/transcript-subagents-nowline-3-chip.png");
                rec(
                    "3. the working parent's line carries the \"1 subagent\" chip at its right end",
                    c3.chip === "1 subagent" && c3.last && Math.abs(c3.gap) <= EDGE_PX && !c3.idleLine,
                    JSON.stringify(c3)
                );

                await setParentState(h, ctx, "idle");
                finishSubagent(ctx.childPaths.research);
                const gone = `${LINE} == null && ${VIEW}?.querySelector("[data-subagent-chip]") == null && ${VIEW}?.querySelector("[data-working-line]") == null`;
                await polishWaitFor(h, gone, POLL_WAIT_MS);
                const s4 = await h.ev(`({ gone: ${gone}, line: ${lineState}, chip: ${chipState} })`);
                await h.shot("cdp-shots/transcript-subagents-nowline-4-gone.png");
                rec(
                    "4. with the parent idle and the last child finished, the now line is gone",
                    s4.gone === true,
                    JSON.stringify(s4)
                );
                return steps;
            },
            teardown: teardownSubagentsAgent,
        },
    ];
}
