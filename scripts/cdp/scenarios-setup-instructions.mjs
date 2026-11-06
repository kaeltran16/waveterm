// setup-instructions: the Setup surface's Instructions tab over the in-page agentsync simulation in
// setup-fixtures.mjs (files under a temp root), never the real agentsync RPCs or harness files.
// Each step that needs the tab's first read starts from a reloaded page, since the tab's atoms outlive a
// surface switch; a reload drops the simulation, so a fresh one is installed after it.
import {
    arrangeSetupFixture,
    assertSetupFixtureInstalled,
    controlSetupFixture,
    teardownSetupFixture,
} from "./setup-fixtures.mjs";
import { polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "setup-instructions";
const WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const PANEL = `document.getElementById("setup-tabpanel")`;
const FILE_LIST = `document.querySelector('aside[aria-label="Instruction files"]')`;
const EDITOR = `document.querySelector('textarea[aria-label="Instructions for every harness"]')`;
const LOAD_FAILED = `document.querySelector("[data-load-failed]")`;
const STATUS_FAULT = "agentsync status unreadable (fixture fault)";
const WRITE_FAULT = "steering doc is read-only (fixture fault)";

const q = JSON.stringify;

// restores any installed simulation, reloads, installs a fresh one with the given faults, then opens Setup
async function freshSetup(h, ctx, faults = []) {
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
    await clickSel(h, "#setup-tab-instructions");
}

async function clickSel(h, sel) {
    if (!(await h.ev(`(() => { const b = document.querySelector(${q(sel)}); if (!b) return false; b.click(); return true; })()`))) {
        throw new Error(`nothing to click at ${sel}`);
    }
}

// the first enabled button in the tab panel whose text is exactly label
async function clickButton(h, label) {
    const clicked = await h.ev(`(() => {
        const b = [...${PANEL}.querySelectorAll("button")].find((x) => x.textContent.trim() === ${q(label)} && !x.disabled);
        if (!b) return false;
        b.click();
        return true;
    })()`);
    if (!clicked) throw new Error(`no enabled "${label}" button in the Setup panel`);
}

const panelText = (h) => h.ev(`(${PANEL}?.textContent ?? "")`);
const alerts = (h) => h.ev(`[...${PANEL}.querySelectorAll('[role="alert"]')].map((a) => a.textContent.trim())`);

// a textarea's value set the way React sees a user's typing
const typeInEditor = (h, text) =>
    h.ev(`(() => {
        const ta = ${EDITOR};
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        set.call(ta, ta.value + ${q(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return ta.value;
    })()`);

async function setupInstructionsArrange(_h) {
    return { fx: null };
}

async function setupInstructionsAssert(h, ctx) {
    const steps = [];
    const run = async (step, fn) => {
        try {
            const { ok, detail } = await fn();
            steps.push({ step, ok, detail });
        } catch (e) {
            steps.push({ step, ok: false, detail: String(e?.message ?? e) });
        }
    };

    await run("1. the tab shows the fixture's harness rows and the shared doc", async () => {
        await freshSetup(h, ctx);
        const fx = ctx.fx.fixture;
        await polishWaitFor(h, `${EDITOR}?.value === ${q(fx.steering.content)}`, 10000);
        const labels = fx.status.harnesses.map((r) => r.label);
        const got = {
            list: await h.ev(`(${FILE_LIST}?.textContent ?? "")`),
            doc: await h.ev(`${EDITOR}?.value ?? null`),
            reading: (await panelText(h)).includes("Reading…"),
        };
        await h.shot("cdp-shots/setup-instructions-main.png");
        return {
            ok: labels.every((l) => got.list.includes(l)) && got.doc === fx.steering.content && !got.reading,
            detail: { labels, ...got },
        };
    });

    await run("2. a failed first status read shows the error and Retry, never Reading…; Retry draws the rows", async () => {
        await freshSetup(h, ctx, [{ command: "agentsyncstatus", message: STATUS_FAULT, times: 1 }]);
        const shown = await polishWaitFor(h, `!!${LOAD_FAILED}`, 10000);
        const failed = {
            shown,
            text: await panelText(h),
            retry: await h.ev(`[...${PANEL}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Retry")`),
        };
        await h.shot("cdp-shots/setup-instructions-load-failed.png");
        await clickButton(h, "Retry");
        const fx = ctx.fx.fixture;
        const drawn = await polishWaitFor(h, `${EDITOR}?.value === ${q(fx.steering.content)} && !${LOAD_FAILED}`, 10000);
        const list = await h.ev(`(${FILE_LIST}?.textContent ?? "")`);
        return {
            ok:
                failed.shown &&
                failed.text.includes(STATUS_FAULT) &&
                !failed.text.includes("Reading…") &&
                failed.retry &&
                drawn &&
                fx.status.harnesses.every((r) => list.includes(r.label)),
            detail: { ...failed, text: failed.text.slice(0, 300), drawn, list },
        };
    });

    await run("2b. a Skills visit that loads leaves an Instructions error a failed save set", async () => {
        await controlSetupFixture(h, "fail", { command: "agentsyncsteeringwrite", message: WRITE_FAULT, times: 1 });
        await typeInEditor(h, "\nOne more rule.");
        await polishWaitFor(h, `[...${PANEL}.querySelectorAll("button")].some((b) => /^Save to /.test(b.textContent.trim()) && !b.disabled)`, 5000);
        const save = await h.ev(`[...${PANEL}.querySelectorAll("button")].find((b) => /^Save to /.test(b.textContent.trim()))?.textContent.trim()`);
        await clickButton(h, save);
        const saveFailed = await polishWaitFor(
            h,
            `[...${PANEL}.querySelectorAll('[role="alert"]')].some((a) => a.textContent.includes(${q(WRITE_FAULT)}))`,
            10000
        );
        await clickSel(h, "#setup-tab-skills");
        const skillsLoaded = await polishWaitFor(h, `!!document.querySelector('[role="table"][aria-label="Skills by harness"]')`, 10000);
        await clickSel(h, "#setup-tab-instructions");
        await polishWaitFor(h, `!!${EDITOR}`, 5000);
        const after = await alerts(h);
        await h.shot("cdp-shots/setup-instructions-save-error-kept.png");
        return {
            ok: saveFailed && skillsLoaded && after.some((a) => a.includes(WRITE_FAULT)),
            detail: { saveFailed, skillsLoaded, after },
        };
    });

    return steps;
}

async function setupInstructionsTeardown(h, ctx) {
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

export const setupInstructions = {
    name: NAME,
    surface: "setup",
    arrange: setupInstructionsArrange,
    assert: setupInstructionsAssert,
    teardown: setupInstructionsTeardown,
};
