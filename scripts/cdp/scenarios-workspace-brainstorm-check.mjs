// Scenario `workspace-brainstorm-check`: the builder check's review, its approve bar and the run view in the 600px
// Brainstorm tab (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). WBS_KIT's fixture agent asking
// question 4; later steps rewrite the file to the check and the run.

import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { WBS_KIT } from "./scenarios-workspace-brainstorm-question.mjs";
import { BS_BUILDER_A, BS_BUILDER_OPTIONS, BS_CHECK, BS_HANDOFF, BS_HANDOFF_PARTS, BS_HISTORY_Q4, bsFile, bsParts } from "./scenarios-shared.mjs";

const NAME = "workspace-brainstorm-check";
const { polishWaitFor, polishNap, writeFile, BS_POLL_WAIT_MS, WAIT_MS } = RBS_KIT;
const { wbsScenario, tabOpens, setView, showInCenter, store, ASIDE, BS_IN_TAB, BS_IN_CENTER, PANE_PX, SETTLE_MS } = WBS_KIT;
const TAB_MIN_PX = 360;

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

// the Main board's check: the one question for you, no calls, three lines already in the design
const ALREADY = [...BS_CHECK.answered, "Who owns the runbook? The enrichment team, from the recon."];
const MAIN_FILE = { ...BS_HANDOFF, check: { ...BS_CHECK, calls: [], answered: ALREADY } };
// the A2 board's check: three questions for you, the first answered, and one call on each of two parts. Thresholds is a
// review row (changed), so its link lands the cursor on a row
const A2_FILE = bsFile({
    done: true,
    parts: REVIEW_FILE.parts,
    history: BS_HISTORY_Q4,
    check: {
        yours: [
            { ...BS_CHECK.yours[0], label: "Hold the autoscaler on a page?", a: BS_BUILDER_A, into: "anti" },
            { q: "Which partitions count toward the 15-minute line?", label: "Partitions behind the 15-minute line" },
            { q: "Does a planned replay silence the heads-up too?", label: "Replays and the heads-up" },
        ],
        calls: [BS_CHECK.calls[0], BS_CHECK.calls[2]],
        answered: ALREADY,
        touched: ["goals"],
    },
});
// REVIEW_FILE's Approve blocker: Thresholds changed, Anti-goals a guess, Constraints asked with no question open
const REVIEW_BLOCKER = "Review 1 change, confirm 1 guess, 1 decision still open";
const CHECK_INTRO = "A fresh agent checked whether it could plan from this without coming back to you.";

const SUMMARY = `${BS_IN_TAB}?.querySelector("[data-brainstorm-check-summary]")`;
// the summary's state, and what its panel holds by section
const READ_SUMMARY = `(() => {
    const flat = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : null);
    const s = ${SUMMARY};
    const panel = s?.querySelector("[data-brainstorm-check-summary-panel]");
    const head = (label) => flat(panel?.querySelector('section[aria-label="' + label + '"] h3'));
    return {
        rail: ${BS_IN_TAB}?.querySelector('aside[aria-label="The builder check"]') != null,
        line: flat(s?.querySelector("[data-brainstorm-check-summary-line]")),
        expanded: s?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
        toggle: flat(s?.querySelector("button[aria-expanded]")?.lastElementChild),
        height: Math.round(panel?.getBoundingClientRect().height ?? -1),
        intro: [...(panel?.querySelectorAll("p") ?? [])].map(flat),
        forYou: head("For you"),
        queue: [...(panel?.querySelectorAll("[data-brainstorm-queue]") ?? [])].map((q) => q.getAttribute("data-brainstorm-queue")),
        decided: head("The agent decided"),
        answered: head("You answered"),
        already: head("Already in the design"),
    };
})()`;
const toggleSummary = (h) => h.ev(`(${SUMMARY}?.querySelector("button[aria-expanded]")?.click(), true)`);
const panelHeight = `Math.round(${SUMMARY}?.querySelector("[data-brainstorm-check-summary-panel]")?.getBoundingClientRect().height ?? -1)`;
// opens the summary and waits out PaneReveal's grow
const openSummary = async (h) => {
    await toggleSummary(h);
    const grown = await polishWaitFor(h, `${panelHeight} > 0`, WAIT_MS);
    await polishNap(SETTLE_MS);
    return grown;
};
const closeSummary = async (h) => {
    await toggleSummary(h);
    return polishWaitFor(h, `${panelHeight} === 0`, WAIT_MS);
};
const MAIN_BUILDER_FILE = { ...MAIN_FILE, check: { ...MAIN_FILE.check, yours: [{ ...BS_CHECK.yours[0], part: "thresholds", options: BS_BUILDER_OPTIONS }] } };
const BUILDER = `${BS_IN_TAB}?.querySelector("[data-brainstorm-builder-question]")`;
const CLICK_PROS_TOGGLE = `(() => {
    const b = ${BUILDER}?.querySelector("[data-brainstorm-proscons-toggle]");
    if (!b) return "missing";
    b.click();
    return "clicked";
})()`;
// the builder question's head row: where its toggle sits, the part link's color against the accent-soft token, and
// the track's segments
const READ_HEAD = `(() => {
    const q = ${BUILDER};
    const label = q?.querySelector("[data-brainstorm-builder-head]");
    const row = label?.parentElement;
    const toggle = q?.querySelector("[data-brainstorm-proscons-toggle]");
    const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    const probe = document.createElement("span");
    probe.style.color = "var(--color-accent-soft)";
    document.body.appendChild(probe);
    const accentSoft = getComputedStyle(probe).color;
    probe.remove();
    const link = label?.querySelector("button");
    return {
        toggle: toggle ? toggle.textContent.trim() : null,
        inHead: !!toggle && !!row && row.contains(toggle) && !row.contains(q.querySelector("h1")),
        sameLine: !!toggle && !!label && Math.abs(mid(toggle) - mid(label)) < 4,
        inAnswers: q?.querySelectorAll('[role="group"][aria-label="Answers"] [data-brainstorm-proscons-toggle]').length ?? -1,
        linkColor: link ? getComputedStyle(link).color : null,
        accentSoft,
        track: q?.querySelectorAll("[data-brainstorm-track] [data-state]").length ?? 0,
    };
})()`;
const reviewCursor =`${BS_IN_TAB}?.querySelector("[data-brainstorm-review-row][data-cursor]")?.getAttribute("data-brainstorm-review-row") ?? null`;

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

    await step("the builder's question heads at the tab's size, as the talk question does", async () => {
        writeFile(ctx, BS_HANDOFF);
        const shown = await polishWaitFor(h, `${BS_IN_TAB}?.querySelector("[data-brainstorm-builder-question] h1") != null`, BS_POLL_WAIT_MS);
        await polishNap(SETTLE_MS);
        const sizes = await h.ev(`(() => {
            const fs = (el) => (el ? getComputedStyle(el).fontSize : null);
            const q = ${BS_IN_TAB}?.querySelector("[data-brainstorm-builder-question]");
            return { h1: fs(q?.querySelector("h1")), why: fs(q?.querySelector("[data-brainstorm-why]")), head: fs(q?.querySelector("[data-brainstorm-builder-head]")) };
        })()`);
        await h.shot("cdp-shots/workspace-brainstorm-check-builder.png");
        return [shown && sizes.h1 === "20px" && sizes.why === "13px" && sizes.head === "12.5px", { shown, ...sizes }];
    });

    await step("the check's rail is one closed summary line; Show opens the intro and what was already in the design (Main)", async () => {
        writeFile(ctx, MAIN_FILE);
        const line = "A builder read the design: 4 questions, 1 for you, 3 already in the design";
        const shown = await polishWaitFor(h, `${SUMMARY}?.querySelector("[data-brainstorm-check-summary-line]")?.textContent === ${JSON.stringify(line)}`, BS_POLL_WAIT_MS);
        const closed = await h.ev(READ_SUMMARY);
        const grown = await openSummary(h);
        const opened = await h.ev(READ_SUMMARY);
        await h.shot("cdp-shots/workspace-brainstorm-check-summary-main.png");
        const shut = await closeSummary(h);
        const ok =
            shown &&
            !closed.rail &&
            closed.expanded === "false" &&
            closed.toggle === "Show" &&
            closed.height === 0 &&
            grown &&
            opened.expanded === "true" &&
            opened.toggle === "Hide" &&
            opened.height > 0 &&
            JSON.stringify(opened.intro) === JSON.stringify([CHECK_INTRO]) &&
            opened.already === "Already in the design · 3" &&
            opened.forYou == null &&
            opened.decided == null &&
            shut;
        return [ok, { shown, closed, opened, shut }];
    });

    await step("with three questions for you the open summary holds their queue and the agent's calls, whose part link moves the review cursor (A2)", async () => {
        writeFile(ctx, A2_FILE);
        const shown = await polishWaitFor(h, `${SUMMARY}?.querySelector("[data-brainstorm-check-summary-line]")?.textContent.includes("3 for you") === true`, BS_POLL_WAIT_MS);
        const grown = await openSummary(h);
        const opened = await h.ev(READ_SUMMARY);
        await h.shot("cdp-shots/workspace-brainstorm-check-summary-a2.png");
        const clicked = await h.ev(`(() => {
            const b = ${SUMMARY}?.querySelector('[data-brainstorm-call-group="thresholds"] button');
            if (!b) return "missing";
            b.click();
            return "clicked";
        })()`);
        const moved = await polishWaitFor(h, `(${reviewCursor}) === "thresholds"`, BS_POLL_WAIT_MS);
        // closed and back on the question, so the review step after this waits on its own file
        const shut = await closeSummary(h);
        await h.ev(`(${BS_IN_TAB}?.querySelector("[data-brainstorm-back]")?.click(), true)`);
        const back = await polishWaitFor(h, `${IN_REVIEW} == null`, BS_POLL_WAIT_MS);
        const ok =
            shown &&
            grown &&
            opened.forYou === "For you · 3" &&
            JSON.stringify(opened.queue) === JSON.stringify(["answered", "now", "waiting"]) &&
            opened.decided === "The agent decided · 2" &&
            opened.already === "Already in the design · 3" &&
            clicked === "clicked" &&
            moved &&
            shut &&
            back;
        return [ok, { shown, grown, opened, clicked, moved, shut, back }];
    });

    await step("the builder question's head row holds its toggle beside Builder 1 of 1, and a lone question has no track (Main)", async () => {
        writeFile(ctx, MAIN_BUILDER_FILE);
        const shown = await polishWaitFor(h, `${BUILDER}?.querySelector('[data-brainstorm-option="2"]') != null`, BS_POLL_WAIT_MS);
        await polishNap(SETTLE_MS);
        const read = () => h.ev(READ_HEAD);
        const at = await read();
        await h.shot("cdp-shots/workspace-brainstorm-check-head-main.png");
        const hide = await h.ev(CLICK_PROS_TOGGLE);
        const hidden = await polishWaitFor(h, `${BUILDER}?.querySelectorAll("[data-brainstorm-proscons]").length === 0`, WAIT_MS);
        const off = await read();
        const show = await h.ev(CLICK_PROS_TOGGLE);
        const again = await polishWaitFor(h, `${BUILDER}?.querySelectorAll("[data-brainstorm-proscons]").length === 3`, WAIT_MS);
        const on = await read();
        const ok =
            shown &&
            at.toggle === "Hide pros and cons" &&
            at.sameLine &&
            at.inHead &&
            at.inAnswers === 0 &&
            at.linkColor != null &&
            at.linkColor === at.accentSoft &&
            at.track === 0 &&
            hide === "clicked" &&
            hidden &&
            off.toggle === "Show pros and cons" &&
            show === "clicked" &&
            again &&
            on.toggle === "Hide pros and cons";
        return [ok, { shown, at, hide, hidden, off, show, again, on }];
    });

    await step("with three questions for you the track draws three segments under the same head row", async () => {
        const yours = A2_FILE.check.yours.map((y, i) => (i === 1 ? { ...y, options: BS_BUILDER_OPTIONS } : y));
        writeFile(ctx, { ...A2_FILE, check: { ...A2_FILE.check, yours } });
        const shown = await polishWaitFor(h, `${BUILDER}?.querySelectorAll("[data-brainstorm-track] [data-state]").length === 3`, BS_POLL_WAIT_MS);
        const at = await h.ev(READ_HEAD);
        return [shown && at.track === 3 && at.sameLine && at.inAnswers === 0, { shown, at }];
    });

    await step("at 360px nothing in the builder question overflows, and the closed summary spans two lines with Show on the first (A4)", async () => {
        writeFile(ctx, MAIN_BUILDER_FILE);
        const shown = await polishWaitFor(
            h,
            `${BUILDER}?.querySelector('[data-brainstorm-option="2"]') != null && ${SUMMARY}?.querySelector("[data-brainstorm-check-summary-line]")?.textContent.includes("1 for you") === true`,
            BS_POLL_WAIT_MS
        );
        await store(h, ctx, `globalStore.set(W.workspaceWidthAtom, ${TAB_MIN_PX}); return true;`);
        const narrowed = await polishWaitFor(h, `Math.round(${ASIDE}?.getBoundingClientRect().width) === ${TAB_MIN_PX}`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const fit = await h.ev(`(() => {
            const pane = ${BS_IN_TAB};
            const q = ${BUILDER};
            const bar = pane?.querySelector("[data-brainstorm-toolbar]");
            const body = q?.lastElementChild;
            const edge = pane?.getBoundingClientRect();
            const inside = (el) => {
                const r = el?.getBoundingClientRect();
                return !!r && !!edge && r.width > 0 && r.left >= edge.left - 1 && r.right <= edge.right + 1;
            };
            const toggle = q?.querySelector("[data-brainstorm-proscons-toggle]");
            const chips = [q?.querySelector("[data-brainstorm-builder-decide]"), q?.querySelector("[data-brainstorm-design-btn]")];
            const line = ${SUMMARY}?.querySelector("[data-brainstorm-check-summary-line]");
            const show = ${SUMMARY}?.querySelector("button[aria-expanded]")?.lastElementChild;
            const lineBox = line?.getBoundingClientRect();
            return {
                mainFits: !!body && body.scrollWidth <= body.clientWidth && q.scrollWidth <= q.clientWidth,
                barFits: !!bar && bar.scrollWidth <= bar.clientWidth,
                toggleInside: inside(toggle),
                chipsInside: chips.every(inside),
                lines: lineBox ? Math.round(lineBox.height / parseFloat(getComputedStyle(line).lineHeight)) : null,
                showTop: show && lineBox ? Math.round(show.getBoundingClientRect().top - lineBox.top) : null,
                expanded: ${SUMMARY}?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
            };
        })()`);
        await h.shot("cdp-shots/workspace-brainstorm-check-head-a4.png");
        await store(h, ctx, `globalStore.set(W.workspaceWidthAtom, ${PANE_PX}); return true;`);
        const restored = await polishWaitFor(h, `Math.round(${ASIDE}?.getBoundingClientRect().width) === ${PANE_PX}`, WAIT_MS);
        const ok =
            shown &&
            narrowed &&
            fit.mainFits &&
            fit.barFits &&
            fit.toggleInside &&
            fit.chipsInside &&
            fit.expanded === "false" &&
            fit.lines === 2 &&
            Math.abs(fit.showTop) <= 2 &&
            restored;
        return [ok, { shown, narrowed, fit, restored }];
    });

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

    await step("on the review the summary says all answered and opens onto what you answered, whose Changed link moves the cursor; the approve bar draws no reason row (A3)", async () => {
        const shown = await polishWaitFor(h, `${SUMMARY}?.querySelector("[data-brainstorm-check-summary-line]")?.textContent.includes("1 for you, all answered") === true`, BS_POLL_WAIT_MS);
        const read = await h.ev(READ_SUMMARY);
        const grown = await openSummary(h);
        const opened = await h.ev(READ_SUMMARY);
        const approve = await h.ev(`(() => {
            const b = ${BS_IN_TAB}?.querySelector("[data-brainstorm-approve]");
            return { disabled: b?.disabled ?? null, title: b?.title ?? null, reason: ${BS_IN_TAB}?.querySelector("[data-brainstorm-approve-reason]") != null };
        })()`);
        await h.shot("cdp-shots/workspace-brainstorm-check-summary-a3.png");
        const clicked = await h.ev(`(() => {
            const b = ${SUMMARY}?.querySelector('[data-brainstorm-answered-link="anti"]');
            if (!b) return "missing";
            b.click();
            return "clicked";
        })()`);
        const moved = await polishWaitFor(h, `(${reviewCursor}) === "anti"`, BS_POLL_WAIT_MS);
        const shut = await closeSummary(h);
        const ok =
            shown &&
            read.expanded === "false" &&
            grown &&
            opened.answered === "You answered · 1" &&
            opened.already === "Already in the design · 2" &&
            approve.disabled === true &&
            approve.title === REVIEW_BLOCKER &&
            approve.reason === false &&
            clicked === "clicked" &&
            moved &&
            shut;
        return [ok, { read, opened, approve, clicked, moved, shut }];
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
