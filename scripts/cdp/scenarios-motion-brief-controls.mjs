// motion-brief-controls: the motion sweep's moments on the Brief's controls and the new-run setup
// (docs/superpowers/plans/2026-11-10-motion-sweep.md). The data is brief-profile's two projects and new-run-window's
// project, planning run and recent entry, made by their own arranges. Each check samples in-page in one evaluation,
// since a CDP round trip per sample is slower than the animation it measures: an observer catches the node a change
// adds and reads it on a timer until it settles.
import { briefProfile } from "./scenarios-brief.mjs";
import { newRunWindow } from "./scenarios-palette.mjs";
import {
    MODELS_PLAN,
    MODELS_VIEWPORT,
    NEW_RUN,
    NEW_RUN_FIELD,
    NOTES_CLIP_RESTORE,
    PEEKS_ESC,
    PROFILE_MODAL,
    clickByText,
    closeProfile,
    notesClipStub,
    openAddressExpr,
    openProfileOn,
    polishNap,
    polishWaitFor,
    setInputExpr,
} from "./scenarios-shared.mjs";

const SAMPLE_MS = 16;
const TITLE_PLACEHOLDER = "e.g. Scenario gate clearance";
const NEW_INIT = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('input[placeholder="${TITLE_PLACEHOLDER}"]'))`;
const NEW_INIT_TITLE = `${NEW_INIT}?.querySelector('input[placeholder="${TITLE_PLACEHOLDER}"]')`;
const NEW_INIT_CHIPS = `[...(${NEW_INIT}?.querySelectorAll('button[aria-pressed][title]') ?? [])]`;
const CTRL_ENTER = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }))`;
const BRIEF_SHEET = `document.querySelector('[data-jarvis-brief-sheet]')`;
const SHEET_CONFIG = `${BRIEF_SHEET}?.querySelector('[data-jarvis-brief-sheet-config="editable"]')`;
const SHEET_WIDTH = `${BRIEF_SHEET}?.querySelector('input[type="number"]')`;
const REDUCE = { features: [{ name: "prefers-reduced-motion", value: "reduce" }] };

// Runs `act` and follows the first added node that is or holds `sel`: the opacity the node mounted with, whether any
// sample caught it mid-fade or `sel` mid-transform, and both once `ms` has passed.
const watchMount = (sel, act, ms = 700) => `(async () => {
    const sel = ${JSON.stringify(sel)};
    let node = null;
    let target = null;
    const read = () => ({ opacity: getComputedStyle(node).opacity, transform: getComputedStyle(target).transform });
    let first = null;
    const obs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (node != null || !(n instanceof Element)) continue;
            const t = n.matches(sel) ? n : n.querySelector(sel);
            if (t) { node = n; target = t; first = read(); }
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    ${act};
    const frames = [];
    const end = performance.now() + ${ms};
    while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, ${SAMPLE_MS}));
        if (node != null) frames.push(read());
    }
    obs.disconnect();
    if (node == null) return null;
    return {
        first,
        frames: frames.length,
        faded: frames.some((f) => Number(f.opacity) > 0 && Number(f.opacity) < 1),
        moved: frames.some((f) => f.transform !== 'none'),
        settled: { ...read(), attached: node.isConnected, text: target.textContent.replace(/\\s+/g, ' ').trim() },
    };
})()`;

// Runs `act` on an element already showing: whether it is still attached and part-faded `midMs` in, and gone later.
const watchExit = (elExpr, act, midMs = 120) => `(async () => {
    const el = ${elExpr};
    if (!el) return null;
    ${act};
    await new Promise((r) => setTimeout(r, ${midMs}));
    const mid = { attached: el.isConnected, opacity: Number(getComputedStyle(el).opacity) };
    await new Promise((r) => setTimeout(r, 800));
    return { mid, goneAfter: !el.isConnected };
})()`;

// a busy page samples slowly, so a micro fade can pass between two samples and its last frame land just short of 1:
// a mount at 0 that settles at 1 is the check, as in dag-motion
const SETTLED_OPACITY = 0.99;
const mountedFadingIn = (w) => w != null && w.first?.opacity === "0" && Number(w.settled.opacity) >= SETTLED_OPACITY;
// a freshly booted app is still busy for a moment, which stretches the first animations past their windows
const BOOT_SETTLE_MS = 1600;
const exitedFading = (w) => w != null && w.mid.attached && w.mid.opacity > 0 && w.mid.opacity < 1 && w.goneAfter;

async function openNewInitiative(h) {
    await h.ev(`document.querySelector('[data-jarvis-new-initiative]')?.click()`);
    return polishWaitFor(h, `!!${NEW_INIT_TITLE}`, 5000);
}

async function closeNewInitiative(h) {
    await h.ev(clickByText(NEW_INIT, "button", "Cancel"));
    return polishWaitFor(h, `!${NEW_INIT}`, 3000);
}

// New initiative: a refused create nudges its error in, Cancel lets the form leave through the modal's exit, and a
// reopen starts blank (the form now stays mounted while closed).
async function newInitiativeSteps(h, rec) {
    await h.goto("jarvis");
    if (!(await openNewInitiative(h))) {
        rec("1. New initiative opens its form", false, "no form");
        return;
    }
    await polishNap(BOOT_SETTLE_MS);
    const nudge = await h.ev(watchMount('[data-effort-error="title"]', CTRL_ENTER, 1200));
    rec(
        "1. creating with no title reveals the error from opacity 0 with one sideways nudge, settling still",
        mountedFadingIn(nudge) && nudge.moved && nudge.settled.transform === "none" && nudge.settled.text === "Title is required",
        JSON.stringify(nudge)
    );
    await h.shot("cdp-shots/motion-brief-controls-1-title-error.png");

    await h.ev(setInputExpr(NEW_INIT_TITLE, "verify motion-brief-controls"));
    await polishNap(200);
    const exit = await h.ev(watchExit(`${NEW_INIT}?.parentElement`, clickByText(NEW_INIT, "button", "Cancel")));
    rec("2. Cancel fades the form out while it is still attached, then removes it", exitedFading(exit), JSON.stringify(exit));

    const reopened = (await openNewInitiative(h))
        ? await h.ev(`(() => ({
            title: ${NEW_INIT_TITLE}?.value ?? null,
            errors: ${NEW_INIT}?.querySelectorAll('[data-effort-error]').length ?? null,
            create: [...(${NEW_INIT}?.querySelectorAll('button') ?? [])].at(-1)?.textContent.trim() ?? null,
        }))()`)
        : null;
    await h.shot("cdp-shots/motion-brief-controls-2-reopened.png");
    rec(
        "3. a reopened form starts blank: no title, no error, Create initiative",
        reopened?.title === "" && reopened.errors === 0 && reopened.create === "Create initiative",
        JSON.stringify(reopened)
    );
    await chipSteps(h, rec);
    await closeNewInitiative(h);
}

// Runs `act` and samples an element that stays mounted: whether any sample caught it mid-transform, and where it is
// once `ms` has passed.
const watchMove = (elExpr, act, ms = 700) => `(async () => {
    const el = ${elExpr};
    if (!el) return null;
    const frames = [];
    ${act};
    const end = performance.now() + ${ms};
    while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, ${SAMPLE_MS}));
        frames.push(getComputedStyle(el).transform);
    }
    return { frames: frames.length, moved: frames.some((t) => t !== 'none'), settled: getComputedStyle(el).transform };
})()`;
const chipNamed = (name) => `${NEW_INIT_CHIPS}.find((b) => b.title === ${JSON.stringify(name)})`;
const CHIP_ORDER = `${NEW_INIT_CHIPS}.map((b) => ({ name: b.title, pressed: b.getAttribute('aria-pressed') === 'true', mark: !!b.querySelector('[data-project-chip-mark]') }))`;
const pickedFirst = (order, name) => order?.[0]?.name === name && order[0].pressed && order[0].mark && order.slice(1).every((c) => !c.pressed && !c.mark);

// A pick moves the picked chip to the front: it slides there carrying the highlight, and under reduced motion it lands
// there at once.
async function chipSteps(h, rec) {
    const before = await h.ev(CHIP_ORDER);
    if ((before?.length ?? 0) < 3) {
        rec("4. a pick slides the picked chip to the front under the highlight", false, `chips=${JSON.stringify(before)}`);
        return;
    }
    const second = before[1].name;
    const slide = await h.ev(watchMove(chipNamed(second), `${chipNamed(second)}.click()`));
    const after = await h.ev(CHIP_ORDER);
    rec(
        "4. a pick slides the picked chip to the front mid-flight, settling there with the highlight",
        slide != null && slide.moved && slide.settled === "none" && pickedFirst(after, second),
        JSON.stringify({ before: before.map((c) => c.name), slide, after })
    );
    await h.shot("cdp-shots/motion-brief-controls-3-chip.png");

    await h.cdp("Emulation.setEmulatedMedia", REDUCE);
    try {
        await polishNap(200);
        const next = after[2].name;
        const snap = await h.ev(watchMove(chipNamed(next), `${chipNamed(next)}.click()`, 400));
        const landed = await h.ev(CHIP_ORDER);
        rec(
            "5. under reduced motion the picked chip lands in front with no frame in between",
            snap != null && !snap.moved && pickedFirst(landed, next),
            JSON.stringify({ snap, landed })
        );
    } finally {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
    }
}

// the Profile modal: switching scope fades the new face in
async function profileSteps(h, ctx, rec) {
    if (!(await openProfileOn(h, ctx.p.project))) {
        rec("6. switching the Profile to Global fades its face in", false, "the profile did not open on the project");
        return;
    }
    const fade = await h.ev(
        watchMount('[data-jarvis-profile-body="global"]', `${PROFILE_MODAL}?.querySelector('[data-jarvis-profile-tab="global"]')?.click()`)
    );
    rec("6. switching the Profile to Global fades its face in from 0 to 1", mountedFadingIn(fade), JSON.stringify(fade));
    await h.shot("cdp-shots/motion-brief-controls-4-profile-global.png");
    await closeProfile(h);
}

// New run: the project list pops in and out, orchestrator's rows reveal, a picked start fades its row in and the
// plan preview cross-fades in
async function newRunSteps(h, rec) {
    await h.ev(`document.querySelector('[data-new-run]')?.click()`);
    if (!(await polishWaitFor(h, `!!${NEW_RUN}`, 5000))) {
        rec("7. the project list fades in as it opens", false, "the New run window did not open");
        return;
    }
    await polishNap(1500);
    const list = await h.ev(watchMount('[role="listbox"][aria-label="Projects"]', `${NEW_RUN_FIELD}?.click()`, 400));
    rec("7. the project list fades in from 0 as it opens", mountedFadingIn(list), JSON.stringify(list));
    const listExit = await h.ev(
        watchExit(`${NEW_RUN}?.querySelector('[role="listbox"][aria-label="Projects"]')?.parentElement?.parentElement`, `${NEW_RUN_FIELD}?.click()`, 60)
    );
    rec("8. closing it fades the list out while attached, then removes it", exitedFading(listExit), JSON.stringify(listExit));

    // the profile may already open on orchestrator, so the window is put on quick first
    await h.ev(`[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'quick')?.click()`);
    await polishNap(600);
    const rows = await h.ev(
        watchMount(
            '[aria-label="Fewer concurrent workers"]',
            `[...(${NEW_RUN}?.querySelectorAll('button[aria-pressed]') ?? [])].find((b) => b.firstElementChild?.textContent.trim() === 'orchestrator')?.click()`,
            1200
        )
    );
    rec("9. picking orchestrator reveals its Workers at once row from opacity 0", mountedFadingIn(rows), JSON.stringify(rows));

    const start = await h.ev(
        watchMount(
            '[data-new-run-start-row="plan"]',
            `[...(${NEW_RUN}?.querySelectorAll('[role="group"][aria-label="Start from"] button') ?? [])].find((b) => b.textContent.trim() === 'Plan file')?.click()`
        )
    );
    rec("10. picking Plan file fades its row in from 0 to 1", mountedFadingIn(start), JSON.stringify(start));

    const plan = await h.ev(
        watchMount('[data-crossfade="result"]', setInputExpr(`${NEW_RUN}?.querySelector('[data-jarvis-plan-path]')`, MODELS_PLAN), 8000)
    );
    await h.shot("cdp-shots/motion-brief-controls-5-plan.png");
    rec("11. a parsed plan cross-fades its table in from 0 to 1", mountedFadingIn(plan), JSON.stringify(plan && { ...plan, settled: { ...plan.settled, text: plan.settled.text.slice(0, 60) } }));
    await h.ev(`${NEW_RUN}?.querySelector('[data-new-run-cancel]')?.click()`);
    await polishWaitFor(h, `!${NEW_RUN}`, 3000);
}

// the run sheet: the run id's copy mark cross-fades, and a refused width reveals its error
async function runSheetSteps(h, ctx, rec) {
    await h.goto("jarvis");
    await h.ev(openAddressExpr(`run:${ctx.n.runId}`));
    if (!(await polishWaitFor(h, `!!${BRIEF_SHEET}?.querySelector('[data-run-id]')`, 10000))) {
        rec("12. copying the run id cross-fades the copied mark in", false, "no run id chip on the sheet");
        return;
    }
    await h.ev(notesClipStub(false));
    let copy = null;
    try {
        copy = await h.ev(watchMount('[data-crossfade="copied"]', `${BRIEF_SHEET}?.querySelector('[data-run-id]')?.click()`, 400));
    } finally {
        await h.ev(NOTES_CLIP_RESTORE);
    }
    rec("12. copying the run id cross-fades the copied mark in from 0 to 1", mountedFadingIn(copy), JSON.stringify(copy));

    if (!(await polishWaitFor(h, `!!${SHEET_CONFIG}`, 10000))) {
        rec("13. an invalid worker width reveals its error from opacity 0", false, "no editable config line on the sheet");
        return;
    }
    await h.ev(clickByText(SHEET_CONFIG, "button", "adjust"));
    await polishWaitFor(h, `!!${SHEET_WIDTH}`, 3000);
    const width = await h.ev(`${SHEET_WIDTH}?.value ?? null`);
    const invalid = await h.ev(watchMount('[data-jarvis-brief-sheet-state="error"]', setInputExpr(SHEET_WIDTH, "99")));
    await h.shot("cdp-shots/motion-brief-controls-6-width-error.png");
    rec(
        "13. an invalid worker width reveals its error from opacity 0",
        mountedFadingIn(invalid) && invalid.settled.text.startsWith("Enter a whole number"),
        JSON.stringify(invalid)
    );
    if (width != null) await h.ev(setInputExpr(SHEET_WIDTH, width));
    await h.ev(clickByText(SHEET_CONFIG, "button", "done"));
    await h.ev(PEEKS_ESC);
}

export const motionBriefControls = {
    name: "motion-brief-controls",
    surface: "jarvis",
    async arrange(h) {
        const p = await briefProfile.arrange(h);
        const n = await newRunWindow.arrange(h);
        return { p, n };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        const arrangeError = ctx.p.arrangeError ?? ctx.n.arrangeError;
        if (arrangeError != null) {
            rec("0. brief-profile's and new-run-window's fixtures were made", false, arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await newInitiativeSteps(h, rec);
        await profileSteps(h, ctx, rec);
        await newRunSteps(h, rec);
        await runSheetSteps(h, ctx, rec);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
        await h.ev(PEEKS_ESC).catch(() => {});
        await h.ev(clickByText(NEW_INIT, "button", "Cancel")).catch(() => {});
        if (ctx.n) await newRunWindow.teardown(h, ctx.n);
        if (ctx.p) await briefProfile.teardown(h, ctx.p);
    },
};
