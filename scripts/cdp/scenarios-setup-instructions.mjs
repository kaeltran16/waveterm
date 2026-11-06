// setup-instructions: the Setup surface's Instructions tab over the in-page agentsync simulation in
// setup-fixtures.mjs (files under a temp root), never the real agentsync RPCs or harness files.
// Each step that needs the tab's first read starts from a reloaded page, since the tab's atoms outlive a
// surface switch; a reload drops the simulation, so a fresh one is installed after it.
import {
    arrangeSetupFixture,
    assertSetupFixtureInstalled,
    controlSetupFixture,
    readSetupFixture,
    teardownSetupFixture,
} from "./setup-fixtures.mjs";
import { polishReload, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "setup-instructions";
const WIDE = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const NARROW = { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false };
const PANEL = `document.getElementById("setup-tabpanel")`;
const FILE_LIST = `document.querySelector('aside[aria-label="Instruction files"]')`;
const RAIL = `document.querySelector('aside[aria-label="Where this goes"]')`;
const EDITOR = `document.querySelector('textarea[aria-label="Instructions for every harness"]')`;
const HEADER = `document.querySelector("[data-instructions-header]")`;
const SYNC_NOW = `document.querySelector("[data-sync-now]")`;
const LOAD_FAILED = `document.querySelector("[data-load-failed]")`;
const row = (runtime) => `document.querySelector('[data-instruction-row="${runtime}"]')`;
const STATUS_FAULT = "agentsync status unreadable (fixture fault)";
const WRITE_FAULT = "steering doc is read-only (fixture fault)";
const OUTSIDE_LINE = "Outside line written by another editor.";

const q = JSON.stringify;

// restores any installed simulation, reloads, installs a fresh one with the given faults, then opens Setup
async function freshSetup(h, ctx, faults = [], viewport = WIDE) {
    if (ctx.fx) {
        const fx = ctx.fx;
        ctx.fx = null;
        await teardownSetupFixture(h, fx);
    }
    await polishReload(h);
    await h.cdp("Emulation.setDeviceMetricsOverride", viewport);
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

    await run("3. with no draft and a stale row, Sync now applies and the header turns to in sync (F2)", async () => {
        await freshSetup(h, ctx);
        const fx = ctx.fx.fixture;
        await polishWaitFor(h, `${EDITOR}?.value === ${q(fx.steering.content)}`, 10000);
        const before = {
            header: await h.ev(`${HEADER}?.textContent ?? ""`),
            syncShown: await h.ev(`!!${SYNC_NOW}`),
            dirty: await h.ev(`!!document.querySelector('[aria-label="Unsaved changes"]')`),
        };
        await h.shot("cdp-shots/setup-instructions-sync-now.png");
        await clickSel(h, "[data-sync-now]");
        const synced = await polishWaitFor(h, `(${HEADER}?.textContent ?? "").includes("3 harnesses in sync") && !${SYNC_NOW}`, 10000);
        const applied = (await readSetupFixture(h)).log.filter((e) => e.kind === "apply" && !e.dryrun).length;
        const after = await h.ev(`${HEADER}?.textContent ?? ""`);
        return {
            ok: before.syncShown && !before.dirty && before.header.includes("1 out of date") && synced && applied === 1,
            detail: { before, synced, applied, after },
        };
    });

    await run("4. a blank shared doc reads the blank copy; a mixed status reads the counted copy (F13)", async () => {
        await freshSetup(h, ctx);
        await controlSetupFixture(h, "useVariant", { key: "blank" });
        // the surface re-reads on every visit, and a clean editor takes the doc as read
        await h.goto("cockpit");
        await h.goto("setup");
        const blank = await polishWaitFor(h, `(${HEADER}?.textContent ?? "").includes("The shared doc is empty")`, 10000);
        const present = ctx.fx.fixture.status.harnesses.filter((r) => r.present).map((r) => r.runtime);
        const rows = await h.ev(`${q(present)}.map((r) => document.querySelector('[data-instruction-row="' + r + '"]')?.textContent ?? "")`);
        const blankDetail = { header: await h.ev(`${HEADER}?.textContent ?? ""`), rows, syncShown: await h.ev(`!!${SYNC_NOW}`) };
        await h.shot("cdp-shots/setup-instructions-blank.png");
        await freshSetup(h, ctx);
        // the header holds the status, then the Sync now button
        const mixed = await polishWaitFor(h, `(${HEADER}?.firstElementChild?.textContent ?? "") === "1 out of date"`, 10000);
        const mixedHeader = await h.ev(`${HEADER}?.textContent ?? ""`);
        return {
            ok: blank && rows.every((t) => t.includes("Shared doc is empty")) && !blankDetail.syncShown && mixed,
            detail: { blank: blankDetail, mixedHeader },
        };
    });

    await run("5. Pi's note shows under its row in the warn tone (F3)", async () => {
        const pi = ctx.fx.fixture.status.harnesses.find((r) => r.runtime === "pi");
        const got = await h.ev(`(() => {
            const n = ${row("pi")}?.querySelector("[data-harness-note]");
            if (!n) return null;
            const state = [...${row("pi")}.querySelectorAll("span")].find((s) => s.textContent.trim() === "In sync");
            return { text: n.textContent.trim(), warn: n.classList.contains("text-warning-soft"), belowState: !!state && n.getBoundingClientRect().top >= state.getBoundingClientRect().bottom };
        })()`);
        return { ok: !!got && got.text === pi.note && got.warn && got.belowState, detail: got };
    });

    await run("6. a harness row shows its file read-only; Shared returns to the editor with the draft (F15)", async () => {
        const claude = ctx.fx.fixture.status.harnesses.find((r) => r.runtime === "claude");
        const firstLine = ctx.fx.fixture.files.find((f) => f.path === claude.path).content.split("\n")[0];
        const draft = await typeInEditor(h, "\nA draft that must survive a preview.");
        await clickSel(h, `[data-instruction-row="claude"]`);
        const previewed = await polishWaitFor(h, `!${EDITOR} && (${PANEL}?.textContent ?? "").includes(${q(firstLine)})`, 10000);
        const pressed = await h.ev(`[${row("claude")}?.getAttribute("aria-pressed"), ${row("shared")}?.getAttribute("aria-pressed")]`);
        await h.shot("cdp-shots/setup-instructions-preview.png");
        await clickSel(h, `[data-instruction-row="shared"]`);
        const back = await polishWaitFor(h, `${EDITOR}?.value === ${q(draft)}`, 5000);
        const pressedBack = await h.ev(`[${row("claude")}?.getAttribute("aria-pressed"), ${row("shared")}?.getAttribute("aria-pressed")]`);
        return {
            ok: previewed && pressed[0] === "true" && pressed[1] === "false" && back && pressedBack[0] === "false" && pressedBack[1] === "true",
            detail: { firstLine, previewed, pressed, back, pressedBack },
        };
    });

    await run("7. the subtitle and the launch sentence read the new copy (F16)", async () => {
        const text = await panelText(h);
        const rail = await h.ev(`${RAIL}?.textContent ?? ""`);
        return {
            ok:
                text.includes("Saving writes this into each harness file listed on the left.") &&
                rail.includes("Arc also re-applies it whenever it launches an agent."),
            detail: { text: text.slice(0, 300), rail: rail.slice(0, 300) },
        };
    });

    await run("8. a 5-line Discard asks first, Cancel and typing keep the draft, 1 line goes at once, Ctrl+S saves (F17)", async () => {
        await freshSetup(h, ctx);
        const base = ctx.fx.fixture.steering.content;
        await polishWaitFor(h, `${EDITOR}?.value === ${q(base)}`, 10000);
        const five = await typeInEditor(h, "\nl1\nl2\nl3\nl4\nl5");
        await clickButton(h, "Discard");
        const armed = await polishWaitFor(h, `[...${PANEL}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Discard 5 lines")`, 3000);
        const keptWhileArmed = (await h.ev(`${EDITOR}.value`)) === five;
        await clickButton(h, "Cancel");
        const cancelled = (await h.ev(`${EDITOR}.value`)) === five && (await h.ev(`[...${PANEL}.querySelectorAll("button")].some((b) => b.textContent.trim() === "Discard")`));
        await clickButton(h, "Discard");
        await polishWaitFor(h, `[...${PANEL}.querySelectorAll("button")].some((b) => /^Discard \\d+ lines$/.test(b.textContent.trim()))`, 3000);
        await typeInEditor(h, "x");
        const disarmedByTyping = await h.ev(`![...${PANEL}.querySelectorAll("button")].some((b) => /^Discard \\d+ lines$/.test(b.textContent.trim()))`);
        await h.shot("cdp-shots/setup-instructions-discard.png");
        await clickButton(h, "Discard");
        await clickButton(h, "Discard 5 lines");
        const discardedFive = await polishWaitFor(h, `${EDITOR}?.value === ${q(base)}`, 3000);
        await typeInEditor(h, "\nOne line only.");
        await clickButton(h, "Discard");
        const oneAtOnce = await polishWaitFor(h, `${EDITOR}?.value === ${q(base)}`, 3000);
        const saved = await typeInEditor(h, "\nSaved with Ctrl+S.");
        await h.ev(`${EDITOR}.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true }))`);
        const wrote = await polishWaitFor(
            h,
            `window.__arcSetupFixture.runtime.snapshot().diskWrites.some((w) => w.content === ${q(saved)})`,
            10000
        );
        return {
            ok: armed && keptWhileArmed && cancelled && disarmedByTyping && discardedFive && oneAtOnce && wrote,
            detail: { armed, keptWhileArmed, cancelled, disarmedByTyping, discardedFive, oneAtOnce, wrote },
        };
    });

    await run("9. an outside edit then Save shows the conflict listing the outside line as added (F24)", async () => {
        await freshSetup(h, ctx);
        const base = ctx.fx.fixture.steering.content;
        await polishWaitFor(h, `${EDITOR}?.value === ${q(base)}`, 10000);
        await typeInEditor(h, "\nMy own edit.");
        await controlSetupFixture(h, "setDisk", { content: `${base}${OUTSIDE_LINE}\n` });
        const save = await h.ev(`[...${PANEL}.querySelectorAll("button")].find((b) => /^Save to /.test(b.textContent.trim()))?.textContent.trim()`);
        await clickButton(h, save);
        const listed = await polishWaitFor(h, `(document.querySelector("[data-disk-changes]")?.textContent ?? "").includes(${q(OUTSIDE_LINE)})`, 10000);
        const notice = await h.ev(`[...${PANEL}.querySelectorAll('[role="alert"]')].map((a) => a.textContent.trim()).find((t) => t.includes("Changed on disk")) ?? ""`);
        const buttons = await h.ev(`[...${PANEL}.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => t === "Reload" || t === "Overwrite")`);
        await h.shot("cdp-shots/setup-instructions-conflict.png");
        return {
            ok:
                listed &&
                notice.includes(`Added on disk${OUTSIDE_LINE}`) &&
                notice.includes("drops the lines added on disk") &&
                buttons.length === 2,
            detail: { listed, notice, buttons },
        };
    });

    await run("10. Last saved sits in the editor header, and no rail text is in the window's bottom-right corner (F25)", async () => {
        await freshSetup(h, ctx);
        await polishWaitFor(h, `!!${EDITOR}`, 10000);
        const got = await h.ev(`(() => {
            const last = document.querySelector("[data-last-saved]");
            const rail = ${RAIL};
            const corner = [];
            if (rail) {
                const walk = document.createTreeWalker(rail, NodeFilter.SHOW_TEXT);
                for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                    if (!n.textContent.trim()) continue;
                    const r = document.createRange();
                    r.selectNodeContents(n);
                    for (const b of r.getClientRects()) {
                        if (b.right > innerWidth - 120 && b.bottom > innerHeight - 120) corner.push(n.textContent.trim());
                    }
                }
            }
            return {
                last: last?.textContent.trim() ?? null,
                inEditorHeader: !!last && !rail?.contains(last) && last.getBoundingClientRect().bottom <= ${EDITOR}.getBoundingClientRect().top,
                railLastSaved: (rail?.textContent ?? "").includes("Last saved"),
                rail: !!rail,
                corner,
            };
        })()`);
        return {
            ok: !!got.last && /^Last saved /.test(got.last) && got.inEditorHeader && !got.railLastSaved && got.rail && got.corner.length === 0,
            detail: got,
        };
    });

    await run("11. at 1000x700 a long unbroken token stays inside the editor, numbers level, no rail (F19)", async () => {
        try {
            await freshSetup(h, ctx, [], NARROW);
            await controlSetupFixture(h, "useVariant", { key: "long-token" });
            await h.goto("cockpit");
            await h.goto("setup");
            const content = ctx.fx.fixture.variants["long-token"].steering.content;
            const loaded = await polishWaitFor(h, `${EDITOR}?.value === ${q(content)}`, 10000);
            const got = await h.ev(`(() => {
                const panel = ${PANEL};
                const box = ${EDITOR}.closest(".rounded");
                const top = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? NaN;
                return {
                    inner: innerWidth,
                    panelScroll: panel.scrollWidth,
                    panelClient: panel.clientWidth,
                    editorRight: box.getBoundingClientRect().right,
                    num1: top('[data-line-number="1"]'),
                    ghost1: top('[data-ghost-line="1"]'),
                    num2: top('[data-line-number="2"]'),
                    ghost2: top('[data-ghost-line="2"]'),
                    rail: !!${RAIL},
                };
            })()`);
            await h.shot("cdp-shots/setup-instructions-narrow.png");
            return {
                ok:
                    loaded &&
                    got.inner === NARROW.width &&
                    got.panelScroll <= got.panelClient &&
                    got.editorRight <= got.inner &&
                    Math.abs(got.num1 - got.ghost1) < 1 &&
                    Math.abs(got.num2 - got.ghost2) < 1 &&
                    !got.rail,
                detail: { loaded, ...got },
            };
        } finally {
            await h.cdp("Emulation.setDeviceMetricsOverride", WIDE);
        }
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
