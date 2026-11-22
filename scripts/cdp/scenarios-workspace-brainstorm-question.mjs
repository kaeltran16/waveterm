// Scenario `workspace-brainstorm-question`: the workspace pane's Brainstorm tab at the pane's 600px
// (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). One fixture claude agent in the Rendered view
// (RBS_KIT arranges it) with an asking brainstorm, its Brainstorm tab open beside the transcript at 600px, and the same
// brainstorm in the Terminal center at the 1600px viewport, where it is wide.
//
// WBS_KIT is what the four workspace-brainstorm-* scenarios share: each opens the tab the same way and puts the
// viewport, the width preference and the tabs back in teardown. Each later task adds its steps to its own file.

import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import {
    BS_BOARDS,
    BS_HANDOFF,
    BS_HISTORY,
    BS_Q4,
    BS_Q4_OPTIONS,
    BS_TOPIC,
    bsFile,
    bsParts,
    restoreLocalStorage,
} from "./scenarios-shared.mjs";

const NAME = "workspace-brainstorm-question";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const PANE_PX = 600;
const WIDTH_KEY = "agent.workspace.width";
const { agentPage, polishWaitFor, polishNap, RV, WAIT_MS } = RBS_KIT;
// longer than a tab's entrance and the pane's reveal
const SETTLE_MS = 700;

const ASIDE = `document.querySelector('aside[aria-label="Workspace"]')`;
const BS_IN_TAB = `${ASIDE}?.querySelector("[data-brainstorm-pane]")`;
const CENTER = `document.querySelector("[data-agent-center]")`;
const BS_IN_CENTER = `${CENTER}?.querySelector("[data-brainstorm-pane]")`;

// question 4 asked, three decided before it and the recon
const ASKING = bsFile({
    parts: bsParts({ intent: "yours", goals: "yours", anti: "yours", constraints: "guess", thresholds: "asked" }),
    history: BS_HISTORY,
    question: BS_Q4,
});

const store = (h, ctx, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const S = await mod("app/view/agents/brainstormstore.ts");
        const id = ${JSON.stringify(ctx.agentId)};
        ${body}`
    );

// the tab's pane as drawn: the aside's width, the active tab, whether the pane reads itself narrow, its view
const readTab = (h) =>
    h.ev(`(() => {
        const aside = ${ASIDE};
        const pane = ${BS_IN_TAB};
        return {
            width: aside ? Math.round(aside.getBoundingClientRect().width) : null,
            active: aside?.querySelector('[role="tab"][aria-selected="true"]')?.closest("[data-workspace-tab]")?.getAttribute("data-workspace-tab") ?? null,
            pane: pane != null,
            narrow: pane?.hasAttribute("data-brainstorm-narrow") ?? null,
            view: pane?.getAttribute("data-brainstorm-view") ?? null,
            transcript: ${RV} != null,
        };
    })()`);

// the width preference at 600 and the Brainstorm tab open on the asking file; true once the tab draws the question
async function openTab(h, ctx) {
    ctx.prevWidth = await store(
        h,
        ctx,
        `return { atom: globalStore.get(W.workspaceWidthAtom), stored: localStorage.getItem(${JSON.stringify(WIDTH_KEY)}) };`
    );
    await store(h, ctx, `globalStore.set(W.workspaceWidthAtom, ${PANE_PX}); W.openWorkspaceTab(id, { kind: "brainstorm" }); return true;`);
    const shown = await polishWaitFor(h, `${BS_IN_TAB}?.querySelector('[data-brainstorm-option="2"]') != null`, WAIT_MS);
    await polishNap(SETTLE_MS);
    return shown;
}

// the opening step every workspace-brainstorm-* scenario starts with
async function tabOpens(h, ctx) {
    const shown = await openTab(h, ctx);
    const t = await readTab(h);
    return [
        shown && t.width === PANE_PX && t.active === "brainstorm" && t.pane && t.narrow === true && t.view === "design" && t.transcript,
        { shown, ...t },
    ];
}

// a scenario on RBS_KIT's fixture agent asking ASKING (or opts.file) at the 1600px viewport
function wbsScenario(name, check, opts = {}) {
    const base = RBS_KIT.scenario(name, { file: ASKING, ...opts }, check);
    return {
        ...base,
        async arrange(h) {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            return base.arrange(h);
        },
        async teardown(h, ctx) {
            try {
                if (ctx.agentId) {
                    await store(
                        h,
                        ctx,
                        `for (const key of ["brainstorm", "canvas"]) W.closeWorkspaceTab(id, key);
                        S.setBrainstormMode(id, "terminal", Date.now());
                        ${
                            ctx.prevWidth != null
                                ? `globalStore.set(W.workspaceWidthAtom, ${JSON.stringify(ctx.prevWidth.atom)});
                        ${restoreLocalStorage(WIDTH_KEY, ctx.prevWidth.stored)};`
                                : ""
                        }
                        return true;`
                    );
                }
            } catch (e) {
                console.error(`${name} teardown: close the tabs failed: ${e?.message ?? e}`);
            }
            await base.teardown(h, ctx);
            await h.cdp("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
        },
    };
}

// the header's Terminal | Rendered toggle, to the view asked for
async function setView(h, rendered) {
    await h.ev(`(() => {
        const b = document.querySelector("[data-cockpit-surface-wrap] button[data-view-toggle]");
        if (b && (b.getAttribute("aria-pressed") === "true") !== ${rendered}) b.click();
        return true;
    })()`);
    return polishWaitFor(h, rendered ? `${RV} != null` : `${RV} == null`, WAIT_MS);
}

// the brainstorm in the Terminal center (its mode), or back to the terminal; true once the center shows it
async function showInCenter(h, ctx, on) {
    await store(h, ctx, `S.setBrainstormMode(id, ${JSON.stringify(on ? "brainstorm" : "terminal")}, Date.now()); return true;`);
    return polishWaitFor(h, on ? `${BS_IN_CENTER} != null` : `${BS_IN_CENTER} == null`, WAIT_MS);
}

export const WBS_KIT = {
    wbsScenario,
    tabOpens,
    openTab,
    readTab,
    store,
    setView,
    showInCenter,
    ASKING,
    ASIDE,
    BS_IN_TAB,
    CENTER,
    BS_IN_CENTER,
    PANE_PX,
    SETTLE_MS,
};

// --- the question at tab size (Task 3): the canvas's Main board, question 4 with its first two answers naming a board
// each, 4 of the 7 parts yours
const MAIN = bsFile({
    parts: bsParts({
        intent: "yours",
        goals: "yours",
        anti: "yours",
        current: "yours",
        constraints: "guess",
        thresholds: "asked",
        page: "open",
    }),
    history: BS_HISTORY,
    question: { ...BS_Q4, options: BS_Q4_OPTIONS.map((o, i) => (i < BS_BOARDS.length ? { ...o, boards: [BS_BOARDS[i]] } : o)) },
});
const LONG = (s) => `${s} It has to hold for every enrichment partition, through a rebalance, a replay and a deploy, and still read at 3am.`;
// the LA1 board: question 9 with a long why and five long answers
const LA1 = {
    ...MAIN,
    question: {
        n: 9,
        text: "When a page fires during a planned replay, what should on-call see first, and who decides whether it is silenced?",
        part: "thresholds",
        why: LONG(
            "A replay pushes lag past every line we drew, on purpose, for as long as it runs. The replay script can create an Alertmanager silence, but nothing today ties that silence to the replay that made it, so a forgotten silence can hide a real stall for days."
        ),
        options: [1, 2, 3, 4, 5].map((n) => ({
            label: `Answer ${n}: the replay script owns the silence and ends it when the replay finishes`,
            detail: LONG(`Detail ${n}: on-call sees the replay's name and owner in the page.`),
            ...(n === 1 ? { pick: true } : {}),
        })),
    },
};
const WRITING = { ...MAIN, question: null, working: "Writing “When it pages” from your answer." };
const RUN = { ...BS_HANDOFF, run: "5c1e0d7a-2b4f-4a8e-9c3d-7f6b1e2a9d40" };
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;

// an element (by its expression) has a descendant, or is itself, scrolling sideways
const SIDEWAYS = `(root) => !!root && [root, ...root.querySelectorAll("*")].some((el) => el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX))`;

// the header row of a pane: one row (every child's middle within 2px of the bar's), what it holds, whether it names
// the topic
const readBar = (h, pane, topic) =>
    h.ev(`(() => {
        const bar = ${pane}?.querySelector("[data-brainstorm-toolbar]");
        const r = bar?.getBoundingClientRect();
        const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
        const kids = bar ? [...bar.children].filter((el) => el.getBoundingClientRect().width > 0) : [];
        return {
            bar: !!bar,
            height: r ? Math.round(r.height) : null,
            oneRow: !!r && kids.every((el) => Math.abs(mid(el) - (r.top + r.height / 2)) < 2),
            phases: !!bar?.querySelector("[data-brainstorm-phase]"),
            count: (bar?.querySelector("[data-brainstorm-progress]")?.textContent ?? "").replace(/\\s+/g, " ").trim() || null,
            segments: ${pane}?.querySelectorAll("[data-brainstorm-progress] span[data-state]").length ?? 0,
            topic: (bar?.textContent ?? "").includes(${JSON.stringify(topic)}),
        };
    })()`);

const writeAndWait = async (h, ctx, file, expr) => {
    RBS_KIT.writeFile(ctx, file);
    const shown = await polishWaitFor(h, expr, RBS_KIT.BS_POLL_WAIT_MS);
    await polishNap(SETTLE_MS);
    return shown;
};

const H1_IS = (pane, text) => `(${pane}?.querySelector("[data-brainstorm-question] h1")?.textContent ?? "") === ${JSON.stringify(text)}`;
const VIEW_IS = (view) => `${BS_IN_TAB}?.getAttribute("data-brainstorm-view") === ${JSON.stringify(view)}`;

export const workspaceBrainstormQuestion = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));

    await step("Main board: one header row with the phases and the parts count, the question at tab size, board chips in rows 1 and 2", async () => {
        const bar = await readBar(h, BS_IN_TAB, ctx.topic);
        const q = await h.ev(`(() => {
            const pane = ${BS_IN_TAB};
            const fs = (el) => (el ? getComputedStyle(el).fontSize : null);
            const rows = [...(pane?.querySelectorAll('[role="group"][aria-label="Answers"] > div') ?? [])];
            const tag = pane?.querySelector('[data-crossfade="Agent’s pick"]');
            const label = tag?.closest("button")?.querySelector("[data-brainstorm-option-label]");
            const t = tag?.getBoundingClientRect();
            const l = label?.getBoundingClientRect();
            const tm = t ? t.top + t.height / 2 : null;
            return {
                track: !!pane?.querySelector("[data-brainstorm-track]"),
                h1: fs(pane?.querySelector("[data-brainstorm-question] h1")),
                why: fs(pane?.querySelector("[data-brainstorm-why]")),
                labels: rows.map((r) => fs(r.querySelector("[data-brainstorm-option-label]"))),
                badges: rows.map((r) => r.querySelector("[data-brainstorm-option] > span")?.textContent.trim() ?? null),
                tagInLine: !!t && !!l && tm >= l.top && tm <= l.bottom && t.left >= l.right - 1,
                chips: rows.map((r) => [...r.querySelectorAll("[data-brainstorm-board-chip]")].map((c) => c.getAttribute("data-brainstorm-board-chip"))),
                thumbs: pane?.querySelectorAll("[data-brainstorm-thumb]").length ?? null,
                sideways: (${SIDEWAYS})(pane),
            };
        })()`);
        await h.shot(SHOT(1, "main"));
        const ok =
            bar.oneRow && bar.height < 48 && bar.phases && bar.count === "4 of 7 parts yours" && !bar.topic && bar.segments === 0 &&
            q.track && q.h1 === "20px" && q.why === "13px" && q.labels.length === 3 && q.labels.every((x) => x === "13.5px") &&
            q.badges.join(",") === "1,2,3" && q.tagInLine &&
            JSON.stringify(q.chips) === JSON.stringify([[BS_BOARDS[0]], [BS_BOARDS[1]], []]) && q.thumbs === 0 && !q.sideways;
        return [ok, { bar, ...q }];
    });

    await step("Main board: row 1's chip opens its board in the canvas window over the pane, and the question comes back", async () => {
        const clicked = await h.ev(`(() => {
            const c = ${BS_IN_TAB}?.querySelector('[data-brainstorm-board-chip="${BS_BOARDS[0]}"]');
            if (!c) return false;
            c.click();
            return true;
        })()`);
        const opened = await polishWaitFor(h, `${VIEW_IS("design")} && !!document.querySelector("[data-canvas-window] [data-canvas-pane]")`, WAIT_MS);
        const board = await store(h, ctx, `const C = await mod("app/view/agents/canvasstore.ts"); return C.getCanvas(id)?.board ?? null;`);
        await polishNap(SETTLE_MS);
        await h.shot(SHOT(2, "chip-board"));
        await h.ev(`document.querySelector('[data-canvas-window] button[aria-label="Close"]')?.click()`);
        const back = await polishWaitFor(h, `!document.querySelector("[data-canvas-window]") && ${VIEW_IS("design")} && !!${BS_IN_TAB}?.querySelector("[data-brainstorm-question]")`, WAIT_MS);
        return [clicked && opened && board === BS_BOARDS[0] && back, { clicked, opened, board, back }];
    });

    await step("LA1 board: question 9's long why and five long answers are one scroll that reaches the last answer and the answer box", async () => {
        const shown = await writeAndWait(h, ctx, LA1, H1_IS(BS_IN_TAB, LA1.question.text));
        const r = await h.ev(`(async () => {
            const pane = ${BS_IN_TAB};
            const q = pane?.querySelector("[data-brainstorm-question]");
            const scrolls = (el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
            // the question's own scrollers, and any between it and the pane: a question that overflows unscrolled
            // is clipped, which the in-view check below catches
            const ups = [];
            for (let el = q; el && el !== pane; el = el.parentElement) ups.push(el);
            const scrollers = q ? [...ups, ...q.querySelectorAll("*")].filter(scrolls) : [];
            const sc = scrollers[0];
            if (sc) sc.scrollTop = sc.scrollHeight;
            await new Promise((res) => setTimeout(res, 400));
            const p = pane.getBoundingClientRect();
            const s = sc?.getBoundingClientRect() ?? p;
            const top = Math.max(p.top, s.top, 0);
            const bottom = Math.min(p.bottom, s.bottom, window.innerHeight);
            const inView = (el) => { const b = el?.getBoundingClientRect(); return !!b && b.height > 0 && b.top >= top - 1 && b.bottom <= bottom + 1; };
            const rows = [...q.querySelectorAll('[role="group"][aria-label="Answers"] > div')];
            return {
                scrollers: scrollers.length,
                rows: rows.length,
                lastRow: inView(rows[rows.length - 1]),
                answerBox: inView(q.querySelector("[data-brainstorm-answer]")),
                sideways: (${SIDEWAYS})(${BS_IN_TAB}),
            };
        })()`);
        await h.shot(SHOT(3, "la1"));
        return [shown && r.scrollers <= 1 && r.rows === 5 && r.lastRow && r.answerBox && !r.sideways, { shown, ...r }];
    });

    await step("the agent writing: the working line's title computes 18px", async () => {
        const shown = await writeAndWait(h, ctx, WRITING, `!!${BS_IN_TAB}?.querySelector("[data-brainstorm-working-title]")`);
        const size = await h.ev(`(() => {
            const el = ${BS_IN_TAB}?.querySelector("[data-brainstorm-working-title]");
            return el ? getComputedStyle(el).fontSize : null;
        })()`);
        await h.shot(SHOT(4, "working"));
        return [shown && size === "18px", { shown, size }];
    });

    await step("the builder check and the run view: one header row with the phases, no topic text or parts count", async () => {
        const check = await writeAndWait(h, ctx, BS_HANDOFF, VIEW_IS("check"));
        const atCheck = await readBar(h, BS_IN_TAB, ctx.topic);
        await h.shot(SHOT(5, "check"));
        const run = await writeAndWait(h, ctx, RUN, VIEW_IS("run"));
        const atRun = await readBar(h, BS_IN_TAB, ctx.topic);
        await h.shot(SHOT(6, "run"));
        const row = (b) => b.bar && b.oneRow && b.height < 48 && b.phases && b.count == null && !b.topic;
        return [check && run && row(atCheck) && row(atRun), { check, atCheck, run, atRun }];
    });

    await step("the same file in the Terminal center at 1600px still draws the 30px heading, the topic and the segments", async () => {
        const back = await writeAndWait(h, ctx, MAIN, H1_IS(BS_IN_TAB, MAIN.question.text));
        const terminal = await setView(h, false);
        const center = await showInCenter(h, ctx, true);
        await polishNap(SETTLE_MS);
        const bar = await readBar(h, BS_IN_CENTER, ctx.topic);
        const h1 = await h.ev(`(() => {
            const el = ${BS_IN_CENTER}?.querySelector("[data-brainstorm-question] h1");
            return el ? getComputedStyle(el).fontSize : null;
        })()`);
        await h.shot(SHOT(7, "center"));
        const left = await showInCenter(h, ctx, false);
        const rendered = await setView(h, true);
        return [
            back && terminal && center && h1 === "30px" && bar.topic && bar.segments > 0 && left && rendered,
            { back, terminal, center, h1, bar, left, rendered },
        ];
    });

    await step("in the Terminal center at the 1600px viewport the same brainstorm is not narrow", async () => {
        const terminal = await setView(h, false);
        const center = await showInCenter(h, ctx, true);
        await polishNap(SETTLE_MS);
        const c = await h.ev(`(() => {
            const pane = ${BS_IN_CENTER};
            return { width: pane ? Math.round(pane.getBoundingClientRect().width) : null, narrow: pane?.hasAttribute("data-brainstorm-narrow") ?? null };
        })()`);
        const left = await showInCenter(h, ctx, false);
        const rendered = await setView(h, true);
        const kept = await polishWaitFor(h, `${BS_IN_TAB} != null`, WAIT_MS);
        return [
            terminal && center && c.narrow === false && c.width >= 760 && left && rendered && kept,
            { terminal, center, ...c, left, rendered, kept },
        ];
    });
}, { file: MAIN, boards: BS_BOARDS, canvas: BS_TOPIC });
