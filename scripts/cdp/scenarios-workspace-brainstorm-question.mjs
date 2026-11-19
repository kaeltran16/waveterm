// Scenario `workspace-brainstorm-question`: the workspace pane's Brainstorm tab at the pane's 600px
// (docs/superpowers/plans/2026-11-19-brainstorm-tab-polish.md). One fixture claude agent in the Rendered view
// (RBS_KIT arranges it) with an asking brainstorm, its Brainstorm tab open beside the transcript at 600px, and the same
// brainstorm in the Terminal center at the 1600px viewport, where it is wide.
//
// WBS_KIT is what the four workspace-brainstorm-* scenarios share: each opens the tab the same way and puts the
// viewport, the width preference and the tabs back in teardown. Each later task adds its steps to its own file.

import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { BS_HISTORY, BS_Q4, bsFile, bsParts, restoreLocalStorage } from "./scenarios-shared.mjs";

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

export const workspaceBrainstormQuestion = wbsScenario(NAME, async (h, ctx, step) => {
    await step("the 600px Brainstorm tab shows the asking question, and the pane reads itself narrow", () => tabOpens(h, ctx));

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
});
