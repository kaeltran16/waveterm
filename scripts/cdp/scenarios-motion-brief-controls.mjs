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
    failRpc,
    holdRpc,
    lookEval,
    notesClipStub,
    openAddressExpr,
    openProfileOn,
    polishNap,
    polishWaitFor,
    releaseRpc,
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
const CREATE_REFUSAL = "motion-brief-controls refused this create on the page";
const START_REFUSAL = "motion-brief-controls refused this start on the page";
// the start resolves a route (GetJarvisProfileCommand) before it creates the run, so both are stubbed
const START_RPCS = ["CreateRunCommand", "GetJarvisProfileCommand"];

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

// Arms watchMount on the page under `key`, for a moment that plays inside another step's action; readArmed awaits it.
const armMount = (key, sel, ms = 700) => `(() => { window[${JSON.stringify(key)}] = ${watchMount(sel, "", ms)}; return true; })()`;
const readArmed = (key) => `window[${JSON.stringify(key)}]`;

// Replies to every call of an RPC after `ms`, refusing it with `message` or passing it with null, without reaching the
// server, until releaseRpc puts the original back. The delay lets a busy label be seen before it swaps back.
const replyAfter = (h, command, ms, message = null) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        (window.__heldRpc ??= {})[${JSON.stringify(command)}] ??= RpcApi[${JSON.stringify(command)}];
        RpcApi[${JSON.stringify(command)}] = () =>
            new Promise((ok, no) => setTimeout(() => (${message != null} ? no(new Error(${JSON.stringify(message)})) : ok(null)), ${ms}));
        return true;
    `);

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

// Runs `act` on an error strip already showing and samples it every frame until it detaches: the text on each frame it
// was still attached, how many of those caught its strip (or itself, when it has no strip of its own) mid-fade, and
// whether it was gone in time.
const watchLeave = (elExpr, act, fadeOf = "el.parentElement") => `(async () => {
    const el = ${elExpr};
    if (!el) return null;
    const fading = ${fadeOf};
    const frames = [];
    let on = true;
    const tick = () => {
        frames.push({ attached: el.isConnected, text: el.textContent.replace(/\\s+/g, ' ').trim(), opacity: Number(getComputedStyle(fading).opacity) });
        if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    ${act};
    const end = performance.now() + 2000;
    while (el.isConnected && performance.now() < end) await new Promise((r) => setTimeout(r, ${SAMPLE_MS}));
    await new Promise((r) => setTimeout(r, 50));
    on = false;
    const held = frames.filter((f) => f.attached);
    return { texts: [...new Set(held.map((f) => f.text))], fading: held.filter((f) => f.opacity < 0.99).length, frames: frames.length, gone: !el.isConnected };
})()`;
// left mid-fade, read `text` on every frame it was attached, and detached
const leftReading = (w, text) => w != null && w.gone && w.fading > 0 && w.texts.length === 1 && w.texts[0] === text;

// a busy page samples slowly, so a micro fade can pass between two samples and its last frame land just short of 1:
// a mount at 0 that settles at 1 is the check, as in dag-motion
const SETTLED_OPACITY = 0.99;
const mountedFadingIn = (w) => w != null && w.first?.opacity === "0" && Number(w.settled.opacity) >= SETTLED_OPACITY;
// a freshly booted app is still busy for a moment, which stretches the first animations past their windows
const BOOT_SETTLE_MS = 1600;
const exitedFading = (w) => w != null && w.mid.attached && w.mid.opacity > 0 && w.mid.opacity < 1 && w.goneAfter;
// caught mid-transform at least once, then attached and still, reading `text`
const nudged = (w, text) => w != null && w.moved && w.settled.attached && w.settled.transform === "none" && w.settled.text === text;
// a CrossFade label that mounted at 0 and settled attached at 1, reading `text`
const swappedIn = (w, text) => mountedFadingIn(w) && w.settled.attached && w.settled.text === text;

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
    await errorLeaveSteps(h, rec);
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

// A title typed in and created clears the title error, and the refused create nudges its save error in, which a retry
// clears: each strip collapses still reading its error. The retry is held, so no initiative is made, and its button
// cross-fades to Creating….
async function errorLeaveSteps(h, rec) {
    const TITLE_ERR = `${NEW_INIT}?.querySelector('[data-effort-error="title"]')`;
    const SAVE_ERR = `${NEW_INIT}?.querySelector('[data-effort-error="save"]')`;
    try {
        await failRpc(h, "EffortCreateCommand", CREATE_REFUSAL);
        await h.ev(armMount("__mbcSaveErr", '[data-effort-error="save"]', 1500));
        const title = await h.ev(watchLeave(TITLE_ERR, CTRL_ENTER));
        rec(
            "1b. creating once a title is typed collapses the title error mid-fade, reading Title is required on every attached frame, then removes it",
            leftReading(title, "Title is required"),
            JSON.stringify(title)
        );
        const saveErr = await h.ev(readArmed("__mbcSaveErr"));
        rec(
            "1c. the refused create reveals the save error from opacity 0 with one sideways nudge, settling still on the refusal",
            mountedFadingIn(saveErr) && nudged(saveErr, CREATE_REFUSAL),
            JSON.stringify(saveErr)
        );
        const refused = await polishWaitFor(h, `(${SAVE_ERR}?.textContent ?? "").trim() === ${JSON.stringify(CREATE_REFUSAL)}`, 3000);
        await polishNap(400);
        await holdRpc(h, "EffortCreateCommand");
        await h.ev(armMount("__mbcCreating", '[data-crossfade="busy"]', 1000));
        const save = refused ? await h.ev(watchLeave(SAVE_ERR, CTRL_ENTER)) : null;
        rec(
            "1d. a retry after a refused create collapses the save error mid-fade, reading the refusal on every attached frame, then removes it",
            refused && leftReading(save, CREATE_REFUSAL),
            JSON.stringify({ refused, save })
        );
        const creating = refused ? await h.ev(readArmed("__mbcCreating")) : null;
        rec(
            "1e. the held retry cross-fades Create initiative to Creating… from opacity 0, settling at 1",
            swappedIn(creating, "Creating…"),
            JSON.stringify(creating)
        );
    } finally {
        await releaseRpc(h, "EffortCreateCommand");
    }
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

// the Profile modal: switching scope fades the new face in, and Save cross-fades to Saving…
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
    await profileSaveStep(h, ctx, rec);
    await closeProfile(h);
}

// Save on an edited project profile, refused after a beat so nothing is written: its label cross-fades to Saving…
async function profileSaveStep(h, ctx, rec) {
    const APPROVALS_OFF = `${PROFILE_MODAL}?.querySelector('[role="group"][aria-label="Approvals"] button[aria-pressed="false"]')`;
    const SAVE = `[...(${PROFILE_MODAL}?.querySelectorAll('footer button') ?? [])].find((b) => b.textContent.trim() === 'Save profile')`;
    try {
        const stubbed = await replyAfter(h, "SetChannelProfileCommand", 1500, "motion-brief-controls refused this save on the page");
        // back on the project's face, an Approvals flip makes the draft dirty, so Save is enabled
        const ready =
            stubbed === true &&
            (await openProfileOn(h, ctx.p.project)) &&
            (await h.ev(`${APPROVALS_OFF}?.click() ?? true`)) &&
            (await polishWaitFor(h, `${SAVE} != null && !${SAVE}.disabled`, 3000));
        const saving = ready ? await h.ev(watchMount('[data-crossfade="saving"]', `${SAVE}?.click()`, 1000)) : null;
        await h.shot("cdp-shots/motion-brief-controls-4b-profile-saving.png");
        rec(
            "6b. Save on an edited profile cross-fades its label to Saving… from opacity 0, settling at 1",
            ready && swappedIn(saving, "Saving…"),
            JSON.stringify({ stubbed, ready, saving })
        );
        await polishWaitFor(h, `!!${PROFILE_MODAL}?.querySelector('[data-jarvis-brief-modal-state="error"]')`, 3000);
    } finally {
        await releaseRpc(h, "SetChannelProfileCommand");
    }
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
    await startErrorStep(h, rec);
    await h.ev(`${NEW_RUN}?.querySelector('[data-new-run-cancel]')?.click()`);
    await polishWaitFor(h, `!${NEW_RUN}`, 3000);
}

// a refused start nudges the footer error in; a second start clears it, and it fades out under popLayout still reading
// the refusal. The second start is held, so no run is made, and its button cross-fades to Starting…; Cancel closes the
// window over it.
async function startErrorStep(h, rec) {
    const START = `${NEW_RUN}?.querySelector('[data-new-run-start]')`;
    const ERR = `${NEW_RUN}?.querySelector('[data-new-run-error]')`;
    const REFUSED = `Error: ${START_REFUSAL}`;
    try {
        for (const c of START_RPCS) await failRpc(h, c, START_REFUSAL);
        await polishWaitFor(h, `${START} != null && !${START}.disabled`, 5000);
        const nudge = await h.ev(watchMount("[data-new-run-error]", `${START}?.click()`, 1200));
        rec(
            "11a. a refused start nudges the footer error in sideways once, settling still on the refusal",
            nudged(nudge, REFUSED),
            JSON.stringify(nudge)
        );
        const refused = await polishWaitFor(h, `(${ERR}?.textContent ?? "").trim() === ${JSON.stringify(REFUSED)}`, 4000);
        await polishNap(400);
        for (const c of START_RPCS) await holdRpc(h, c);
        await h.ev(armMount("__mbcStarting", '[data-crossfade="starting"]', 1000));
        const leave = refused ? await h.ev(watchLeave(ERR, `${START}?.click()`, "el")) : null;
        rec(
            "11b. a second start after a refused one fades the footer error out while attached, reading the refusal on every attached frame, then removes it",
            refused && leftReading(leave, REFUSED),
            JSON.stringify({ refused, error: await h.ev(`(${ERR}?.textContent ?? "").trim()`), leave })
        );
        const starting = refused ? await h.ev(readArmed("__mbcStarting")) : null;
        rec(
            "11c. the held start cross-fades Start run to Starting… from opacity 0, settling at 1",
            swappedIn(starting, "Starting…"),
            JSON.stringify(starting)
        );
    } finally {
        for (const c of START_RPCS) await releaseRpc(h, c);
    }
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
    if (width != null) {
        await settingsSaveSteps(h, rec, width);
        await approvalsNoteStep(h, rec);
    }
    await h.ev(clickByText(SHEET_CONFIG, "button", "done"));
    await h.ev(PEEKS_ESC);
}

const SHEET_SAVE = `[...(${BRIEF_SHEET}?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Save settings')`;
const SAVE_REFUSAL = "motion-brief-controls refused this save on the page";
const sheetSaveEnabled = (h) => polishWaitFor(h, `${SHEET_SAVE} != null && !${SHEET_SAVE}.disabled`, 3000);

// a refused settings save nudges its error in, and a second refusal nudges again (keyed per failure); nothing is written
async function settingsSaveSteps(h, rec, width) {
    try {
        await replyAfter(h, "SetRunSettingsCommand", 150, SAVE_REFUSAL);
        // any other valid width makes the draft dirty, so Save settings is enabled
        await h.ev(setInputExpr(SHEET_WIDTH, Number(width) === 1 ? "2" : "1"));
        const first = (await sheetSaveEnabled(h))
            ? await h.ev(watchMount('[data-jarvis-brief-sheet-state="error"]', `${SHEET_SAVE}?.click()`, 1200))
            : null;
        rec(
            "14. a refused settings save reveals its error from opacity 0 with one sideways nudge, settling still on the refusal",
            mountedFadingIn(first) && nudged(first, `Error: ${SAVE_REFUSAL}`),
            JSON.stringify(first)
        );
        const again = (await sheetSaveEnabled(h))
            ? await h.ev(watchMount('[data-jarvis-brief-sheet-state="error"]', `${SHEET_SAVE}?.click()`, 1200))
            : null;
        await h.shot("cdp-shots/motion-brief-controls-7-save-refused.png");
        rec(
            "15. a second refused save nudges its error sideways again, settling still on the refusal",
            nudged(again, `Error: ${SAVE_REFUSAL}`),
            JSON.stringify(again)
        );
    } finally {
        await releaseRpc(h, "SetRunSettingsCommand");
    }
    await h.ev(setInputExpr(SHEET_WIDTH, width));
}

// Approvals turned off on an autonomous run cross-fades its note in. A run that asks is first made autonomous through a
// save that passes on the page, so only the sheet's baseline changes and nothing is written.
async function approvalsNoteStep(h, rec) {
    const APPROVALS = (label) =>
        `[...(${BRIEF_SHEET}?.querySelectorAll('[role="group"][aria-label="Approvals"] button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
    const pressed = (label) => `${APPROVALS(label)}?.getAttribute('aria-pressed') === 'true'`;
    try {
        await replyAfter(h, "SetRunSettingsCommand", 150);
        const wasAuto = await h.ev(pressed("Autonomous"));
        if (!wasAuto) {
            await h.ev(`${APPROVALS("Autonomous")}?.click()`);
            if (await sheetSaveEnabled(h)) await h.ev(`${SHEET_SAVE}?.click()`);
            await polishWaitFor(h, `!!${BRIEF_SHEET}?.querySelector('[data-jarvis-brief-sheet-state="saved"]')`, 3000);
        }
        const autonomous = await h.ev(pressed("Autonomous"));
        const note = await h.ev(watchMount('[data-crossfade="off"]', `${APPROVALS("Ask me")}?.click()`));
        await h.shot("cdp-shots/motion-brief-controls-8-approvals-note.png");
        rec(
            "16. turning Approvals off on an autonomous run cross-fades its note in from opacity 0 to 1",
            autonomous && mountedFadingIn(note) && note.settled.attached && note.settled.text.startsWith("The lead asks you again"),
            JSON.stringify({ wasAuto, autonomous, note })
        );
        await h.ev(`${APPROVALS("Autonomous")}?.click()`);
    } finally {
        await releaseRpc(h, "SetRunSettingsCommand");
    }
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
        for (const c of ["EffortCreateCommand", "SetChannelProfileCommand", "SetRunSettingsCommand", ...START_RPCS]) {
            await releaseRpc(h, c).catch(() => {});
        }
        if (ctx.n) await newRunWindow.teardown(h, ctx.n);
        if (ctx.p) await briefProfile.teardown(h, ctx.p);
    },
};
