// Scenario `workspace-brainstorm-check`: the builder check's review, its approve bar and the run view in the 600px
// Brainstorm tab (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). WBS_KIT's fixture agent asking
// question 4; later steps rewrite the file to the check and the run.

import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { WBS_KIT } from "./scenarios-workspace-brainstorm-question.mjs";
import { BS_BUILDER_A, BS_CHECK, BS_HANDOFF_PARTS, BS_HISTORY_Q4, bsFile, bsParts } from "./scenarios-shared.mjs";

const NAME = "workspace-brainstorm-check";
const { polishWaitFor, polishNap, writeFile, BS_POLL_WAIT_MS, WAIT_MS } = RBS_KIT;
const { wbsScenario, tabOpens, setView, showInCenter, BS_IN_TAB, BS_IN_CENTER, SETTLE_MS } = WBS_KIT;

// a row's body wider than this reads as prose; below it the title and actions beside it squeezed the body
const BODY_MIN_PX = 400;
// a run id no run has: the run view draws the handed-over rows without a run behind them
const MISSING_RUN = "3b0d5e1f-9a7c-4c2e-8f10-6d2a4b9e7c31";

// after the builder check: Thresholds changed (was/why), Anti-goals new as a guess, Goals touched and settled, and
// Constraints asked, so the review has a row for each action it draws
const REVIEW_FILE = bsFile({
    done: true,
    parts: bsParts(
        { intent: "yours", goals: "yours", anti: "guess", constraints: "asked", thresholds: "guess" },
        {
            thresholds: {
                was: "Page on any partition that is behind.",
                why: "answer 4: only lag that keeps growing pages",
            },
        }
    ),
    history: BS_HISTORY_Q4,
    check: { ...BS_CHECK, yours: [{ ...BS_CHECK.yours[0], a: BS_BUILDER_A, into: "anti" }], touched: ["goals"] },
});
const RUN_FILE = bsFile({ done: true, parts: BS_HANDOFF_PARTS, history: BS_HISTORY_Q4, check: BS_CHECK, run: MISSING_RUN });

const IN_REVIEW = `${BS_IN_TAB}?.querySelector("[data-brainstorm-review]")`;
const IN_RUN = `${BS_IN_TAB}?.querySelector("[data-brainstorm-run]")`;

// each row's title and body boxes inside the scope, for "the body starts under its title"
const rowBoxes = (scope, rowSel, titleOf, bodyOf) => `(() => {
    const box = (el) => {
        const r = el?.getBoundingClientRect();
        return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) } : null;
    };
    return [...(${scope}?.querySelectorAll(${JSON.stringify(rowSel)}) ?? [])].map((row) => ({
        id: row.getAttribute(${JSON.stringify(rowSel.replace(/^\[|\]$/g, ""))}),
        title: box(${titleOf}),
        body: box(${bodyOf}),
    }));
})()`;

const stacked = (rows, min) =>
    rows.length > 0 && rows.every((r) => r.title && r.body && r.body.top >= r.title.bottom - 1 && r.body.width > min);

export const workspaceBrainstormCheck = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));

    await step("the review's rows stack their body under the title, and the key hints are not drawn", async () => {
        writeFile(ctx, REVIEW_FILE);
        const shown = await polishWaitFor(h, `${IN_REVIEW} != null`, BS_POLL_WAIT_MS);
        await polishNap(SETTLE_MS);
        const rows = await h.ev(
            rowBoxes(IN_REVIEW, "[data-brainstorm-review-row]", `row.children[1]`, `row.querySelector("[data-brainstorm-gist]")`)
        );
        const hints = await h.ev(`${BS_IN_TAB}?.querySelector("[data-brainstorm-review-hints]") != null`);
        return [shown && rows.length === 4 && stacked(rows, BODY_MIN_PX) && hints === false, { shown, rows, hints }];
    });

    await step("j still moves the review's cursor with the hints gone", async () => {
        const cursor = () =>
            h.ev(`${IN_REVIEW}?.querySelector("[data-brainstorm-review-row][data-cursor]")?.getAttribute("data-brainstorm-review-row") ?? null`);
        // the dispatcher listens on window; CDP key events often never reach the page, so the event is made there
        const press = (key) =>
            h.ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })), true`);
        await press("j");
        const first = await polishWaitFor(h, `${IN_REVIEW}?.querySelector("[data-brainstorm-review-row][data-cursor]") != null`, 2000);
        const a = await cursor();
        await press("j");
        const moved = await polishWaitFor(
            h,
            `${IN_REVIEW}?.querySelector("[data-brainstorm-review-row][data-cursor]")?.getAttribute("data-brainstorm-review-row") !== ${JSON.stringify(a)}`,
            2000
        );
        const b = await cursor();
        return [first && moved && a != null && b != null && a !== b, { first, moved, a, b }];
    });

    await step("the approve bar shows its title and run line whole, and no button sits on the text", async () => {
        const bar = await h.ev(`(() => {
            const bar = ${BS_IN_TAB}?.querySelector("[data-brainstorm-approve-bar]");
            const fit = (el) => (el ? { text: el.innerText.trim(), clipped: el.scrollWidth > el.clientWidth } : null);
            const rect = (el) => {
                const r = el.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            };
            const over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
            const title = bar?.querySelector("[data-brainstorm-approve-title]");
            const line = bar?.querySelector("[data-brainstorm-approve-line]");
            // the run line's own Change link is part of the text
            const buttons = [...(bar?.querySelectorAll("button") ?? [])].filter((b) => !line?.contains(b));
            return {
                title: fit(title),
                line: fit(line),
                overlap: title && line ? buttons.some((b) => over(rect(b), rect(title)) || over(rect(b), rect(line))) : null,
            };
        })()`);
        const ok =
            bar.title != null && bar.line != null && !bar.title.clipped && !bar.line.clipped && bar.overlap === false;
        return [ok && bar.line.text.includes("this design attached"), bar];
    });

    await step("in the Terminal center at 1600px the review keeps its key hints", async () => {
        const terminal = await setView(h, false);
        const center = await showInCenter(h, ctx, true);
        await polishNap(SETTLE_MS);
        const hints = await h.ev(`${BS_IN_CENTER}?.querySelector("[data-brainstorm-review-hints]") != null`);
        const left = await showInCenter(h, ctx, false);
        const rendered = await setView(h, true);
        const kept = await polishWaitFor(h, `${BS_IN_TAB} != null`, WAIT_MS);
        return [terminal && center && hints === true && left && rendered && kept, { terminal, center, hints, left, rendered, kept }];
    });

    await step("the run view's handed-over rows stack their body under the title", async () => {
        writeFile(ctx, RUN_FILE);
        const shown = await polishWaitFor(h, `${IN_RUN} != null`, BS_POLL_WAIT_MS);
        await polishNap(SETTLE_MS);
        const rows = await h.ev(
            rowBoxes(IN_RUN, "[data-brainstorm-handed-row]", `row.children[1]`, `row.children[2]`)
        );
        return [shown && rows.length > 0 && stacked(rows, BODY_MIN_PX), { shown, rows }];
    });
});
