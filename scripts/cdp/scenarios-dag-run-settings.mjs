// dag-run-settings: the DAG header's Run settings modal on each of its boards
// (one step per board of the design prototype, .superpowers/design/run-settings-polish).
// One orchestrator run held by deferstart in an unborn repo with a submitted 4-task dag at width 4, so no model ever
// starts and a saved width lands on the dag. Its lead is autonomous-runs' seeded tab, asking Plan review, so the
// Approvals hand-back and the resolved note can show. Saving and Refused patch SetRunSettingsCommand on the page.
import { rmSync } from "node:fs";
import {
    AUTONOMOUS_ANSWER_WAIT_MS,
    AUTONOMOUS_BACK_TO_ASK,
    AUTONOMOUS_LEAD_ASK,
    AUTONOMOUS_RESOLVED,
    autonomousLeadAsk,
    patchFixtureLead,
    raiseLeadAsk,
    rvOpenDag,
    seedAutonomousLead,
} from "./scenarios-runs.mjs";
import {
    MODELS_VIEWPORT,
    PEEKS_ESC,
    TREE_RAIL_FIXTURE,
    arrangeHeldRun,
    clickByText,
    failRpc,
    holdRpc,
    polishNap,
    polishReload,
    polishWaitFor,
    releaseRpc,
    teardownHeldRuns,
} from "./scenarios-shared.mjs";

const TITLE = "verify dag-run-settings";
const WIDTH = 4;
const TASKS = [
    { id: "t-1", label: "first" },
    { id: "t-2", label: "second" },
    { id: "t-3", label: "third" },
    { id: "t-4", label: "fourth" },
];
const SET_SETTINGS = "SetRunSettingsCommand";
const REFUSAL = "dag-run-settings refused this save on the page";
// past the modal's exit motion, well short of anything a confirm step would need
const CLOSE_MS = 2000;
const SAVE_MS = 8000;

const SAVED_DISPATCH = "Saved. Applies to future dispatches.";
const SAVED_PROFILE = "Saved to this project's Profile. New runs start with these settings.";
const SAVED_AUTONOMOUS = "Saved. The run is autonomous from now on.";
const ON_LINE = `Saving hands the waiting ${AUTONOMOUS_LEAD_ASK.header} back to the lead, and it answers everything from then on.`;

const DAG_MODAL = `document.querySelector('[data-dag-modal-kind]')`;
const ADJUST = `${DAG_MODAL}?.querySelector('[data-dag-adjust]')`;
const MODAL = `document.querySelector('[data-run-settings-modal]')`;
const CLOSE = `document.querySelector('[data-run-settings-close]')`;
const MORE = `${MODAL}?.querySelector('button[aria-label="More concurrent workers"]')`;
const APPROVALS = `${MODAL}?.querySelector('[role="group"][aria-label="Approvals"]')`;
const SAVE = `[...(${MODAL}?.querySelectorAll('footer button') ?? [])].at(-1)`;
const STATUS = `${MODAL}?.querySelector('[data-run-settings-status]')`;

// everything a board shows: the header, the width, the Approvals dial and the line under it, the resolved note,
// the footer's status and buttons, and whether every control in the body is disabled
const MODAL_STATE = `(() => {
    const m = ${MODAL};
    if (!m) return null;
    const flat = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const group = m.querySelector('[role="group"][aria-label="Approvals"]');
    const status = m.querySelector('[data-run-settings-status]');
    const buttons = [...m.querySelectorAll('footer button')];
    const body = [...m.querySelector('header').nextElementSibling.querySelectorAll('button')];
    return {
        title: flat(m.querySelector('header span')),
        subtitle: flat(m.querySelector('header span + span')),
        width: flat(m.querySelector('button[aria-label="More concurrent workers"]')?.previousElementSibling),
        pressed: [...(group?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map(flat),
        lines: [...(group?.closest('section')?.querySelectorAll('[data-crossfade]') ?? [])].map(flat),
        resolved: flat(m.querySelector('[data-jarvis-brief-sheet-resolved]')),
        status: status?.getAttribute('data-run-settings-status') ?? null,
        statusText: flat(status),
        use: { text: flat(buttons.at(-2)), disabled: buttons.at(-2)?.disabled ?? null },
        save: { text: flat(buttons.at(-1)), disabled: buttons.at(-1)?.disabled ?? null },
        bodyControls: body.length,
        bodyDisabled: body.length > 0 && body.every((b) => b.disabled),
    };
})()`;
const state = (h) => h.ev(MODAL_STATE);
const stateIs = (h, cond, ms = 5000) => polishWaitFor(h, `((s) => !!s && (${cond}))(${MODAL_STATE})`, ms);
// the one line under the Approvals panel, once its cross-fade has settled
const lineIs = (text) => `s.lines.length === 1 && s.lines[0] === ${JSON.stringify(text)}`;
const NO_CONFIRM = `![...document.querySelectorAll('button')].some((b) => ['Keep editing', 'Discard'].includes(b.textContent.trim()))`;
const BACKDROP_DOWN = `(() => {
    const backdrop = ${MODAL}?.closest('[role="dialog"]')?.parentElement;
    if (!backdrop) return false;
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
})()`;

async function openSettings(h) {
    await h.ev(`${ADJUST}?.click()`);
    return polishWaitFor(h, `!!${MORE}`, 3000);
}

// closes the modal with `how` and reports whether it went at once, with no confirm, leaving the DAG modal open
async function closeWith(h, how) {
    await h.ev(how);
    const closed = await polishWaitFor(h, `!${MODAL}`, CLOSE_MS);
    return { closed, noConfirm: await h.ev(NO_CONFIRM), dagOpen: await h.ev(`!!${DAG_MODAL}`) };
}

const dagWidth = async (h, ctx) =>
    (await h.rpc("dagstatus", { channelid: ctx.channelId, runid: ctx.runId })).group ?? null;

export const dagRunSettings = {
    name: "dag-run-settings",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            const run = await arrangeHeldRun(h, ctx, { key: "run-settings", title: TITLE, tasks: TASKS, parallelism: WIDTH });
            Object.assign(ctx, { cwd: run.cwd, channelId: run.channelId, runId: run.runId });
            await seedAutonomousLead(h, ctx);
            // the fixture roster and the channel list are both read at boot
            await polishReload(h);
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec("0. a held run with a 4-task dag at width 4 and its seeded lead were made", false, ctx.arrangeError);
            return steps;
        }
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        await h.goto("jarvis");

        // 1. Main
        const dagOpen = await rvOpenDag(h, ctx.runId);
        const opened = dagOpen && (await openSettings(h));
        await stateIs(h, `s.status === 'none'`);
        const main = await state(h);
        await h.shot("cdp-shots/run-settings-main.png");
        rec(
            "1. Main: Adjust opens Run settings with the run's name, No changes, Save disabled and Use for new runs enabled",
            opened &&
                main?.title === "Run settings" &&
                main.subtitle === TITLE &&
                main.width === String(WIDTH) &&
                main.status === "none" &&
                main.statusText === "No changes" &&
                main.save.disabled === true &&
                main.use.disabled === false,
            { dagOpen, opened, main }
        );
        if (!opened) return steps;

        // 2. Dirty
        await h.ev(`${MORE}?.click()`);
        await stateIs(h, `s.status === 'unsaved' && s.width === '${WIDTH + 1}'`);
        const dirty = await state(h);
        await h.shot("cdp-shots/run-settings-dirty.png");
        rec(
            "2. Dirty: More concurrent workers reads one past the baseline, Unsaved changes, Save enabled",
            dirty?.width === String(WIDTH + 1) &&
                dirty.status === "unsaved" &&
                dirty.statusText === "Unsaved changes" &&
                dirty.save.disabled === false,
            dirty
        );

        // 3. Saving: the save never replies until the modal is closed and opened afresh
        await holdRpc(h, SET_SETTINGS);
        await h.ev(`${SAVE}?.click()`);
        await stateIs(h, `s.save.text === 'Saving…'`);
        const saving = await state(h);
        await h.shot("cdp-shots/run-settings-saving.png");
        await releaseRpc(h, SET_SETTINGS);
        const savingClose = await closeWith(h, `${CLOSE}?.click()`);
        const reopened = await openSettings(h);
        await stateIs(h, `s.status === 'none'`);
        const fresh = await state(h);
        rec(
            "3. Saving: Save reads Saving… with the stepper, route pickers and Approvals disabled; the X closes it and the next open starts fresh",
            saving?.save.text === "Saving…" &&
                saving.bodyDisabled &&
                saving.status === "unsaved" &&
                savingClose.closed &&
                reopened &&
                fresh?.status === "none" &&
                fresh.width === String(WIDTH),
            { saving, savingClose, reopened, fresh }
        );

        // 4. Refused: the error shows and nudges again on a second refusal, and the draft stays
        await failRpc(h, SET_SETTINGS, REFUSAL);
        await h.ev(`${MORE}?.click()`);
        await stateIs(h, `s.status === 'unsaved' && s.width === '${WIDTH + 1}'`);
        await h.ev(`${SAVE}?.click()`);
        await stateIs(h, `s.status === 'error' && s.save.disabled === false`, SAVE_MS);
        const refused = await state(h);
        await h.shot("cdp-shots/run-settings-refused.png");
        // a nudge is the status remounting under a new failure count, so the old node is marked and must be replaced
        await h.ev(`(() => { const s = ${STATUS}; if (s) s.__firstRefusal = true; return !!s; })()`);
        await h.ev(`${SAVE}?.click()`);
        const nudged = await polishWaitFor(
            h,
            `((s) => !!s && s.getAttribute('data-run-settings-status') === 'error' && !s.__firstRefusal)(${STATUS})`,
            SAVE_MS
        );
        await stateIs(h, `s.save.disabled === false`);
        const again = await state(h);
        await releaseRpc(h, SET_SETTINGS);
        rec(
            "4. Refused: the refusal shows as the error with the draft kept and Save enabled, and a second refusal nudges it again",
            refused?.status === "error" &&
                refused.statusText.includes(REFUSAL) &&
                refused.width === String(WIDTH + 1) &&
                refused.save.disabled === false &&
                nudged &&
                again?.status === "error" &&
                again.statusText.includes(REFUSAL) &&
                again.width === String(WIDTH + 1),
            { refused, nudged, again }
        );

        // 5. Saved
        await h.ev(`${SAVE}?.click()`);
        await stateIs(h, `s.status === 'saved'`, SAVE_MS);
        const saved = await state(h);
        const savedGroup = await dagWidth(h, ctx);
        await h.shot("cdp-shots/run-settings-saved.png");
        rec(
            "5. Saved: the dispatch notice, Save disabled, and the dag's width is the draft's",
            saved?.statusText === SAVED_DISPATCH &&
                saved.save.disabled === true &&
                savedGroup?.parallelism === WIDTH + 1,
            { saved, dagWidth: savedGroup?.parallelism ?? null }
        );

        // 6. SavedProfile
        await h.ev(`${MODAL}?.querySelectorAll('footer button')[0]?.click()`);
        await stateIs(h, `s.status === 'saved' && s.statusText === ${JSON.stringify(SAVED_PROFILE)}`, SAVE_MS);
        const savedProfile = await state(h);
        await h.shot("cdp-shots/run-settings-savedprofile.png");
        rec(
            "6. SavedProfile: Use for new runs reads the Profile notice",
            savedProfile?.status === "saved" && savedProfile.statusText === SAVED_PROFILE,
            savedProfile
        );

        // 7. ApprovalsOn: the lead waits on Plan review, so picking Autonomous warns of the hand-back
        await raiseLeadAsk(h, ctx);
        const askBefore = await autonomousLeadAsk(h, ctx);
        await h.ev(clickByText(APPROVALS, "button", "Autonomous"));
        await stateIs(h, lineIs(ON_LINE));
        const approvalsOn = await state(h);
        await h.shot("cdp-shots/run-settings-approvalson.png");
        rec(
            "7. ApprovalsOn: picking Autonomous while the lead asks Plan review warns that saving hands it back",
            askBefore?.questions?.[0]?.header === AUTONOMOUS_LEAD_ASK.header &&
                approvalsOn?.pressed.join(",") === "Autonomous" &&
                approvalsOn.lines.join(" ") === ON_LINE &&
                approvalsOn.status === "unsaved",
            { ask: askBefore?.questions?.[0]?.header ?? null, approvalsOn }
        );

        // 8. Resolved
        await h.ev(`${SAVE}?.click()`);
        await stateIs(h, `s.status === 'saved' && s.resolved !== ''`, SAVE_MS);
        const resolved = await state(h);
        await h.shot("cdp-shots/run-settings-resolved.png");
        // the answer is typed in the background, and the server takes the question out of its registry as it starts
        let askAfter = askBefore;
        for (const until = Date.now() + AUTONOMOUS_ANSWER_WAIT_MS; askAfter != null && Date.now() < until; ) {
            await polishNap(500);
            askAfter = await autonomousLeadAsk(h, ctx);
        }
        const autoGroup = await dagWidth(h, ctx);
        rec(
            "8. Resolved: Save shows that the lead decided Plan review inside the modal, the autonomous notice, and the dag stored autonomous",
            resolved?.resolved.startsWith(`${AUTONOMOUS_LEAD_ASK.header}: the lead decided`) &&
                resolved.resolved.endsWith(AUTONOMOUS_RESOLVED) &&
                resolved.statusText === SAVED_AUTONOMOUS &&
                askAfter == null &&
                autoGroup?.autonomous === true,
            { resolved, pending: askAfter?.questions?.[0]?.header ?? null, autonomous: autoGroup?.autonomous ?? null }
        );
        // the lead has its answer, so it is working again
        await patchFixtureLead(h, ctx, false);

        // 9. ApprovalsOff
        await h.ev(clickByText(APPROVALS, "button", "Ask me"));
        await stateIs(h, lineIs(AUTONOMOUS_BACK_TO_ASK));
        const approvalsOff = await state(h);
        await h.shot("cdp-shots/run-settings-approvalsoff.png");
        rec(
            "9. ApprovalsOff: picking Ask me says the lead asks again from its next decision",
            approvalsOff?.pressed.join(",") === "Ask me" &&
                approvalsOff.lines.join(" ") === AUTONOMOUS_BACK_TO_ASK &&
                approvalsOff.status === "unsaved",
            approvalsOff
        );

        // 10. a dirty draft is dropped by Esc, the X and the backdrop alike, and the next open shows the stored settings
        const dropped = {};
        for (const [way, how] of [
            ["esc", PEEKS_ESC],
            ["x", `${CLOSE}?.click()`],
            ["backdrop", BACKDROP_DOWN],
        ]) {
            if (way !== "esc") {
                await h.ev(clickByText(APPROVALS, "button", "Ask me"));
                await stateIs(h, `s.status === 'unsaved'`);
            }
            const before = (await state(h))?.status ?? null;
            const closed = await closeWith(h, how);
            const back = await openSettings(h);
            await stateIs(h, `s.status === 'none'`);
            const after = await state(h);
            dropped[way] = { before, ...closed, back, status: after?.statusText ?? null, pressed: after?.pressed ?? null };
        }
        await h.shot("cdp-shots/run-settings-close-dirty.png");
        rec(
            "10. Close drops a dirty draft: Esc, the X and a backdrop mousedown each close at once with no confirm, the DAG modal stays, and the next open reads No changes on Autonomous",
            Object.values(dropped).every(
                (d) =>
                    d.before === "unsaved" &&
                    d.closed &&
                    d.noConfirm &&
                    d.dagOpen &&
                    d.back &&
                    d.status === "No changes" &&
                    d.pressed?.join(",") === "Autonomous"
            ),
            dropped
        );

        // 11. clean closes
        const cleanX = await closeWith(h, `${CLOSE}?.click()`);
        const backAgain = await openSettings(h);
        await stateIs(h, `s.status === 'none'`);
        const cleanEsc = await closeWith(h, PEEKS_ESC);
        await h.shot("cdp-shots/run-settings-close-clean.png");
        rec(
            "11. Clean close: with no changes the X closes it at once, and Esc closes only the Run settings modal",
            cleanX.closed && cleanX.dagOpen && backAgain && cleanEsc.closed && cleanEsc.noConfirm && cleanEsc.dagOpen,
            { cleanX, backAgain, cleanEsc }
        );
        await h.ev(PEEKS_ESC);
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`dag-run-settings teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("restore SetRunSettingsCommand", () => releaseRpc(h, SET_SETTINGS));
        await step("clear the lead's question", () => ctx.askRaised && h.rpc("agentaskclear", `block:${ctx.leadBlockId}`));
        // deleting the lead's only block deletes its tab with it, and stops the stdin sink before its repo goes
        await step("delete the lead's tab", () => ctx.leadBlockId && h.rpc("deleteblock", { blockid: ctx.leadBlockId }));
        if (ctx.wroteFixture) await step("remove the fixture roster", () => rmSync(TREE_RAIL_FIXTURE, { force: true }));
        await teardownHeldRuns(h, ctx, "dag-run-settings");
        await step("reload onto the live roster", () => h.reload());
    },
};
