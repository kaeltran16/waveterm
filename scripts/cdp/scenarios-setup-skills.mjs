// setup-skills: the Setup surface's Skills tab over the in-page agentsync simulation in setup-fixtures.mjs
// (files under a temp root), never the real agentsync RPCs, vault or harness skills.
// Each step that needs the tab's first read starts from a reloaded page, since the tab's atoms outlive a
// surface switch; a reload drops the simulation, so a fresh one is installed after it.
import {
    arrangeSetupFixture,
    assertSetupFixtureInstalled,
    controlSetupFixture,
    teardownSetupFixture,
} from "./setup-fixtures.mjs";
import { polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "setup-skills";
const WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const PANEL = `document.getElementById("setup-tabpanel")`;
const MATRIX = `document.querySelector('[role="table"][aria-label="Skills by harness"]')`;
const LOAD_FAILED = `document.querySelector("[data-load-failed]")`;
const SKILLS_FAULT = "agentsync skills unreadable (fixture fault)";
// the fixture's default dataset draws these groups (skillsmatrix.ts groupTitle)
const GROUPS = ["Needs a decision", "Differs between harnesses", "Same copy in 2 harnesses", "Only in Codex", "Managed by Arc"];

const q = JSON.stringify;

async function clickSel(h, sel) {
    if (!(await h.ev(`(() => { const b = document.querySelector(${q(sel)}); if (!b) return false; b.click(); return true; })()`))) {
        throw new Error(`nothing to click at ${sel}`);
    }
}

// restores any installed simulation, reloads, installs a fresh one with the given faults, then opens Skills
async function freshSkills(h, ctx, faults = []) {
    if (ctx.fx) {
        const fx = ctx.fx;
        ctx.fx = null;
        await teardownSetupFixture(h, fx);
    }
    await polishReload(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", WIDE);
    ctx.fx = await arrangeSetupFixture(h, NAME);
    for (const f of faults) await controlSetupFixture(h, "fail", f);
    await assertSetupFixtureInstalled(h);
    await h.goto("setup");
    await clickSel(h, "#setup-tab-skills");
}

const groupTitles = (h) =>
    h.ev(`[...(${MATRIX}?.querySelectorAll('[role="rowgroup"]') ?? [])].map((g) => g.getAttribute("aria-label"))`);

async function setupSkillsArrange(_h) {
    return { fx: null };
}

async function setupSkillsAssert(h, ctx) {
    const steps = [];
    const run = async (step, fn) => {
        try {
            const { ok, detail } = await fn();
            steps.push({ step, ok, detail });
        } catch (e) {
            steps.push({ step, ok: false, detail: String(e?.message ?? e) });
        }
    };

    await run("1. the matrix shows the fixture's groups", async () => {
        await freshSkills(h, ctx);
        const drawn = await polishWaitFor(h, `!!${MATRIX}`, 10000);
        const titles = await groupTitles(h);
        await h.shot("cdp-shots/setup-skills-main.png");
        return { ok: drawn && JSON.stringify(titles) === JSON.stringify(GROUPS), detail: { drawn, titles } };
    });

    await run("2. a failed first skills read shows the error and Retry, never Reading…; Retry draws the matrix", async () => {
        await freshSkills(h, ctx, [{ command: "agentsyncskills", message: SKILLS_FAULT, times: 1 }]);
        const shown = await polishWaitFor(h, `!!${LOAD_FAILED}`, 10000);
        const text = await h.ev(`(${PANEL}?.textContent ?? "")`);
        const retry = await h.ev(`[...${PANEL}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Retry")`);
        await h.shot("cdp-shots/setup-skills-load-failed.png");
        await h.ev(`[...${PANEL}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Retry")?.click()`);
        const drawn = await polishWaitFor(h, `!!${MATRIX} && !${LOAD_FAILED}`, 10000);
        const titles = await groupTitles(h);
        return {
            ok:
                shown &&
                text.includes(SKILLS_FAULT) &&
                !text.includes("Reading…") &&
                retry &&
                drawn &&
                JSON.stringify(titles) === JSON.stringify(GROUPS),
            detail: { shown, text: text.slice(0, 300), retry, drawn, titles },
        };
    });

    return steps;
}

async function setupSkillsTeardown(h, ctx) {
    const failed = [];
    const step = async (what, fn) => {
        try {
            await fn();
        } catch (e) {
            failed.push(`${what}: ${e?.message ?? e}`);
        }
    };
    if (ctx.fx) await step("restore the setup fixture", () => teardownSetupFixture(h, ctx.fx));
    // the tab's atoms still hold fixture data; a reload drops them
    await step("reload", () => polishReload(h));
    await step("return to the cockpit", () => h.goto("cockpit"));
    if (failed.length > 0) throw new Error(`${NAME} teardown: ${failed.join("; ")}`);
}

export const setupSkills = {
    name: NAME,
    surface: "setup",
    arrange: setupSkillsArrange,
    assert: setupSkillsAssert,
    teardown: setupSkillsTeardown,
};
