// motion-dag-peek: the motion sweep's moments on the DAG graph and its peeks
// (docs/superpowers/plans/2026-11-10-motion-sweep.md, Task 3), on dag-peek's arrange: t-1 dispatched, t-2 done,
// t-3 failed (Retry, Skip, Escalate…), t-4 waiting. Each moment is sampled in-page: a MutationObserver reads the style
// a node mounts with before the first paint, and a frame loop reads it while it moves, since a CDP round trip per
// sample is slower than the motion it measures.
import {
    DAG_PEEK_MODAL,
    DAG_PEEK_FINAL_SEL,
    DAG_PEEK_RAIL_LIVE,
    dagPeekCard,
    dagPeekClickNode,
    dagPeekOpen,
    dagPeekPublish,
    dagPeekScenario,
    dagPeekTaskSel,
    injectPageDag,
    rvOpenDag,
    undoPageDag,
} from "./scenarios-runs.mjs";
import { failRpc, lookEval, polishNap, polishWaitFor, releaseRpc } from "./scenarios-shared.mjs";

const REFUSAL = "motion-dag-peek refused this retry on the page";
const REFUSED_TEXT = `retry t-3 failed: ${REFUSAL}`;
// longer than the macro moments (360ms), so a sample's last frame is the settled one
const SETTLE_MS = 700;
// longer than the change flash (1.2s)
const FLASH_MS = 1600;
// a card height change smaller than this is not a resize to follow
const RESIZE_PX = 8;

const T1 = dagPeekTaskSel("t-1");
const T2 = dagPeekTaskSel("t-2");
const T3 = dagPeekTaskSel("t-3");
const IN_MODAL = "[data-dag-modal-kind]";
const PILL = `${IN_MODAL} [data-dag-status-pill]`;
const ALERT_T3 = `${T3} [role="alert"]`;

// t-2's review note: one line fits its three-line clamp, the long one is cut by it
const SHORT_NOTE = "motion-dag-peek: the commit is fine";
const LONG_NOTE = Array.from({ length: 8 }, (_, i) => `line ${i + 1}: motion-dag-peek's note outgrows the clamp`).join("\n");
const NOTE = `${dagPeekCard(T2)}?.querySelector("[data-peek-review-note]")`;
const TOGGLE = `${dagPeekCard(T2)}?.querySelector("[data-peek-review-toggle]")`;
// a verify start stamp gives t-2's card its Verify heading before any output arrives
const VERIFY_AGO_MS = 60_000;
const VERIFY_TAIL = Array.from({ length: 4 }, (_, i) => `ok\tmotion-dag-peek/pkg${i + 1}\t0.${i + 1}s`).join("\n");
const END_REASON = `${dagPeekCard(DAG_PEEK_FINAL_SEL)}?.querySelector("[data-run-sheet-end-final] textarea")`;
const END_REASON_TEXT = "motion-dag-peek ends the final stage on the page";
const END_REFUSAL = "motion-dag-peek refused the end on the page";
const CANCEL_REFUSAL = "motion-dag-peek refused the cancel on the page";

// window.__mdpStart(name, sel, pin): records the style each node matching `sel` mounts with, then every frame's for
// the pinned element (an expression, evaluated once) or else the last match, until __mdpStop(name) returns them
const WATCH_LIB = `(() => {
    window.__mdpWatch = {};
    const style = (el) => {
        const cs = getComputedStyle(el);
        return {
            opacity: cs.opacity,
            transform: cs.transform,
            anim: cs.animationName,
            h: Math.round(el.getBoundingClientRect().height),
            attached: el.isConnected,
            parentOpacity: el.parentElement ? getComputedStyle(el.parentElement).opacity : null,
            flash: typeof el.className === "string" && el.className.includes("changeFlash"),
            text: (el.textContent ?? "").trim().slice(0, 80),
            t: Math.round(performance.now()),
        };
    };
    window.__mdpStart = (name, sel, pin) => {
        const w = { sel, pin: pin ?? null, first: [], frames: [], on: true };
        window.__mdpWatch[name] = w;
        w.obs = new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (!(n instanceof Element)) continue;
                for (const el of [n, ...n.querySelectorAll(sel)]) if (el.matches(sel)) w.first.push(style(el));
            }
        });
        w.obs.observe(document.body, { childList: true, subtree: true });
        const tick = () => {
            const el = w.pin ?? [...document.querySelectorAll(sel)].at(-1);
            if (el) w.frames.push(style(el));
            if (w.on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
    };
    window.__mdpStop = (name) => {
        const w = window.__mdpWatch[name];
        if (!w) return null;
        w.on = false;
        w.obs.disconnect();
        const el = w.pin ?? [...document.querySelectorAll(w.sel)].at(-1);
        return { first: w.first, frames: w.frames, settled: el && el.isConnected ? style(el) : null };
    };
    return true;
})()`;

// answers every call of an RPC as landed, without reaching the engine, until releaseRpc puts the original back
const passRpc = (h, command) =>
    lookEval(h, `
        const { RpcApi } = await mod("app/store/wshclientapi.ts");
        (window.__heldRpc ??= {})[${JSON.stringify(command)}] ??= RpcApi[${JSON.stringify(command)}];
        RpcApi[${JSON.stringify(command)}] = () => Promise.resolve(null);
    `);

const start = (h, name, sel, pinExpr) =>
    h.ev(`window.__mdpStart(${JSON.stringify(name)}, ${JSON.stringify(sel)}, ${pinExpr ?? "null"})`);
const stop = (h, name) => h.ev(`window.__mdpStop(${JSON.stringify(name)})`);

const num = (v) => parseFloat(v ?? "");
const midFade = (f) => num(f.opacity) > 0.01 && num(f.opacity) < 0.99;
// the x of a computed transform, 0 for none
function shiftX(transform) {
    const m = /^matrix\(([^)]+)\)$/.exec(transform ?? "");
    return m ? parseFloat(m[1].split(",")[4]) : 0;
}
// a node that mounted transparent and settled opaque with no transform left on it
const fadedIn = (r) => r?.first[0]?.opacity === "0" && r.settled?.opacity === "1" && r.settled.transform === "none";
const brief = (r) => r && { first: r.first.slice(0, 3), settled: r.settled, frames: r.frames.length };

async function clickIn(h, scope, selector) {
    return h.ev(`(() => {
        const el = ${scope}?.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
    })()`);
}

const clickButton = (h, scope, label) =>
    h.ev(`(() => {
        const b = [...(${scope}?.querySelectorAll("button") ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
    })()`);

// clicks `label` in the topmost modal dialog (a confirm opens over the DAG modal), once it shows. A prefix match:
// the dialog's buttons end in their key hint (esc, the return glyph). Not a word boundary: "Keep running" runs
// straight into its "esc" hint with no space between
const clickConfirm = (h, label) =>
    lookEval(h, `
        const find = () => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => flat(b).startsWith(${JSON.stringify(label)}));
        if (!(await until(() => find() != null, 3000))) return false;
        find().click();
        return true;
    `);

export const motionDagPeek = {
    name: "motion-dag-peek",
    surface: "jarvis",
    async arrange(h) {
        return dagPeekScenario.arrange(h);
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: !!ok, detail: JSON.stringify(detail) });
        const graph = ctx.arrangeError == null && (await rvOpenDag(h, ctx.runId));
        const nodes = graph && (await polishWaitFor(h, `${DAG_PEEK_MODAL}?.querySelectorAll("[data-dag-node]").length === 5`, 10000));
        rec("0. the DAG opens with four tasks and the final node", nodes, ctx.arrangeError ?? { graph, nodes });
        if (!nodes) return steps;
        await h.ev(WATCH_LIB);

        // 1. a node's card scales and fades in beside it instead of mounting in place
        await start(h, "open", `${IN_MODAL} section[aria-label="t-1 details"]`);
        await h.ev(dagPeekClickNode("t-1"));
        const opened = await polishWaitFor(h, `!!${dagPeekCard(T1)}`, 4000);
        await polishNap(SETTLE_MS);
        const open = await stop(h, "open");
        await h.shot("cdp-shots/motion-dag-peek-open.png");
        rec(
            "1. clicking t-1 opens its card at opacity 0, scaled, and it settles at 1 with no transform",
            opened && fadedIn(open) && open.first[0].transform !== "none",
            { opened, open: brief(open) }
        );

        // 2. choosing t-3 while t-1's card is open keeps the card, fades its content and follows its height
        await clickButton(h, dagPeekCard(T1), "Read the full description");
        await polishWaitFor(h, `(${dagPeekCard(T1)}?.textContent ?? "").includes("Done when:")`, 3000);
        await polishNap(SETTLE_MS);
        await h.ev(`(window.__mdpCard = ${dagPeekCard(T1)}) != null`);
        await start(h, "column", `${IN_MODAL} section[aria-label$=" details"] > div > div > div`);
        await start(h, "height", `${IN_MODAL} section[aria-label$=" details"]`, "window.__mdpCard");
        const h0 = await h.ev(`Math.round(window.__mdpCard?.getBoundingClientRect().height ?? 0)`);
        await h.ev(dagPeekClickNode("t-3"));
        const switched = await polishWaitFor(h, `!!${dagPeekCard(T3)}`, 4000);
        await polishNap(SETTLE_MS);
        const column = await stop(h, "column");
        const height = await stop(h, "height");
        const sameCard = await h.ev(`window.__mdpCard != null && window.__mdpCard === ${dagPeekCard(T3)}`);
        const h1 = height?.settled?.h ?? null;
        const lo = Math.min(h0, h1 ?? h0);
        const hi = Math.max(h0, h1 ?? h0);
        const between = (height?.frames ?? []).filter((f) => f.h > lo + 1 && f.h < hi - 1).length;
        await h.shot("cdp-shots/motion-dag-peek-switch.png");
        rec(
            "2. choosing t-3 with t-1's card open keeps the same card, fades the new content in from 0, and the card's height moves through the frames between t-1's and t-3's",
            switched && sameCard && fadedIn(column) && h1 != null && hi - lo > RESIZE_PX && between > 0,
            { switched, sameCard, column: brief(column), h0, h1, between }
        );

        // 3. Escalate… cross-fades the panel in
        await start(h, "escalate", `${T3} [data-crossfade="escalate"]`);
        await clickIn(h, dagPeekCard(T3), '[data-dag-peek-action="escalate"]');
        const ESC = `${dagPeekCard(T3)}?.querySelector("[data-dag-peek-escalate]")`;
        const panel = await polishWaitFor(h, `!!${ESC}`, 3000);
        await polishNap(SETTLE_MS);
        const esc = await stop(h, "escalate");
        await h.shot("cdp-shots/motion-dag-peek-escalate.png");
        await clickButton(h, ESC, "Cancel");
        const cancelled = await polishWaitFor(h, `!${ESC}`, 3000);
        rec("3. Escalate… fades its panel in from 0 to 1, and Cancel takes it away", panel && fadedIn(esc) && cancelled, {
            panel,
            esc: brief(esc),
            cancelled,
        });

        // 4. a refused Retry reveals its error strip and nudges it once
        await failRpc(h, "DagActionCommand", REFUSAL);
        await start(h, "nudge", ALERT_T3);
        await clickIn(h, dagPeekCard(T3), '[data-dag-peek-action="retry"]');
        const alerted = await polishWaitFor(h, `(${dagPeekCard(T3)}?.querySelector('[role="alert"]')?.textContent ?? "").trim() === ${JSON.stringify(REFUSED_TEXT)}`, 3000);
        await polishNap(SETTLE_MS);
        const nudge = await stop(h, "nudge");
        await releaseRpc(h, "DagActionCommand");
        await h.shot("cdp-shots/motion-dag-peek-error.png");
        const shook = (nudge?.frames ?? []).filter((f) => Math.abs(shiftX(f.transform)) > 0.5).length;
        rec(
            "4. a refused Retry on t-3 reveals its error strip from opacity 0 and shakes the error along x, ending at rest",
            alerted && nudge?.first[0]?.parentOpacity === "0" && shook > 0 && nudge.settled?.transform === "none",
            { alerted, first: nudge?.first.slice(0, 2), shook, settled: nudge?.settled }
        );

        // 4b. an action that lands clears the refusal: the strip collapses still reading it, until it detaches
        await h.ev(`(window.__mdpAlert = ${dagPeekCard(T3)}?.querySelector('[role="alert"]')) != null`);
        await passRpc(h, "DagActionCommand");
        await start(h, "clear", ALERT_T3, "window.__mdpAlert");
        await clickIn(h, dagPeekCard(T3), '[data-dag-peek-action="retry"]');
        const cleared = await polishWaitFor(h, `window.__mdpAlert?.isConnected === false`, 3000);
        const clear = await stop(h, "clear");
        await releaseRpc(h, "DagActionCommand");
        const held = (clear?.frames ?? []).filter((f) => f.attached);
        const collapsing = held.filter((f) => num(f.parentOpacity) < 0.99).length;
        rec(
            "4b. a Retry that lands collapses t-3's error strip mid-fade with the refusal's text on every attached frame, then removes it",
            alerted && cleared && collapsing > 0 && held.every((f) => f.text === REFUSED_TEXT) && clear.frames.at(-1)?.attached === false,
            { cleared, collapsing, texts: [...new Set(held.map((f) => f.text))], frames: clear?.frames.length }
        );

        // 5. live lifecycle events: the first swaps the empty line for the rows with a fade, a later row enters alone
        const live = await polishWaitFor(h, DAG_PEEK_RAIL_LIVE, 10000);
        const empty = await h.ev(`!!${dagPeekCard(T3)}?.querySelector("[data-dag-peek-lifecycle-empty]")`);
        await start(h, "rows", `${T3} [data-dag-peek-lifecycle] > div:has(> [data-dag-peek-lifecycle-row])`);
        await dagPeekPublish(h, ctx, [["task-verify-started", { taskid: "t-3" }, 60_000]]);
        const firstRow = await polishWaitFor(h, `(${dagPeekCard(T3)}?.querySelectorAll("[data-dag-peek-lifecycle-row]").length ?? 0) === 1`, 5000);
        await polishNap(SETTLE_MS);
        const rows = await stop(h, "rows");
        await start(h, "row", `${T3} [data-dag-peek-lifecycle-row]`);
        await dagPeekPublish(h, ctx, [["task-verify-failed", { taskid: "t-3", reason: "exit 1" }, 0]]);
        const secondRow = await polishWaitFor(h, `(${dagPeekCard(T3)}?.querySelectorAll("[data-dag-peek-lifecycle-row]").length ?? 0) === 2`, 5000);
        await polishNap(SETTLE_MS);
        const row = await stop(h, "row");
        const rowsSettled = await h.ev(
            `[...(${dagPeekCard(T3)}?.querySelectorAll("[data-dag-peek-lifecycle-row]") ?? [])].map((r) => getComputedStyle(r).opacity)`
        );
        await h.shot("cdp-shots/motion-dag-peek-lifecycle.png");
        rec(
            "5. with t-3's Lifecycle live and empty, the first event fades the rows in from 0, and a second event's row alone enters from 0 while the first stays put",
            live &&
                empty &&
                firstRow &&
                fadedIn(rows) &&
                secondRow &&
                row?.first.length === 1 &&
                row.first[0].opacity === "0" &&
                rowsSettled.length === 2 &&
                rowsSettled.every((o) => o === "1"),
            { live, empty, rows: brief(rows), row: row && { first: row.first }, rowsSettled }
        );

        // 6. the header's Adjust label cross-fades to Done
        const ADJUST = `document.querySelector('${IN_MODAL} [data-dag-adjust]')`;
        await start(h, "adjust", `${IN_MODAL} [data-dag-adjust] [data-crossfade="done"]`);
        await h.ev(`${ADJUST}?.click()`);
        await polishNap(SETTLE_MS);
        const adjust = await stop(h, "adjust");
        const adjustText = await h.ev(`(${ADJUST}?.textContent ?? "").trim()`);
        await h.ev(`${ADJUST}?.click()`);
        await polishNap(SETTLE_MS);
        rec("6. Adjust in the DAG header fades its Done label in from 0 to 1", fadedIn(adjust) && adjustText === "Done", {
            adjust: brief(adjust),
            adjustText,
        });

        // 7. the dag moving to finalizing washes the status pill once (page-only, so the engine never sees it)
        await start(h, "flash", PILL);
        const injected = await injectPageDag(h, ctx.runId, {
            fields: { status: "finalizing", final: { state: "verifying", round: 1, startedts: Date.now() } },
        });
        const finalizing = await polishWaitFor(h, `(document.querySelector('${PILL}')?.textContent ?? "").trim() === "finalizing"`, 4000);
        await polishNap(FLASH_MS);
        const flash = await stop(h, "flash");
        const washed = (flash?.frames ?? []).filter((f) => f.flash && f.anim === "changeFlash").length;
        rec(
            "7. the dag turning finalizing plays the change flash on the status pill once, and it ends",
            injected === "ok" && finalizing && washed > 0 && flash.settled?.flash === false,
            { injected, finalizing, washed, settled: flash?.settled }
        );

        // 8. choosing the final node keeps the card; End final stage cross-fades its form in
        await h.ev(dagPeekClickNode("final"));
        const finalCard = await polishWaitFor(h, `!!${dagPeekCard(DAG_PEEK_FINAL_SEL)}?.querySelector("[data-final-end]")`, 4000);
        await start(h, "end", `${DAG_PEEK_FINAL_SEL} [data-crossfade="ending"]`);
        await clickIn(h, dagPeekCard(DAG_PEEK_FINAL_SEL), "[data-final-end]");
        await polishNap(SETTLE_MS);
        const end = await stop(h, "end");
        await h.shot("cdp-shots/motion-dag-peek-end.png");
        await clickIn(h, dagPeekCard(DAG_PEEK_FINAL_SEL), "[data-final-end]");
        await polishNap(SETTLE_MS);
        rec("8. End final stage on the final card fades its form in from 0 to 1", finalCard && fadedIn(end), {
            finalCard,
            end: brief(end),
        });

        // 9. closing the card fades it out while it stays attached, then removes it
        await start(h, "exit", `${IN_MODAL} section[aria-label$=" details"]`, dagPeekCard(DAG_PEEK_FINAL_SEL));
        await h.ev(dagPeekClickNode("final"));
        await polishNap(SETTLE_MS);
        const exit = await stop(h, "exit");
        const fading = (exit?.frames ?? []).filter((f) => f.attached && midFade(f)).length;
        const gone = (exit?.frames ?? []).at(-1)?.attached === false;
        rec("9. a second click on the final node fades its card out while it is still attached, then removes it", fading > 0 && gone, {
            fading,
            gone,
            frames: exit?.frames.length,
        });

        // 10. reduced motion: the same changes land with no intermediate frame
        await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await polishNap(300);
        await start(h, "rflash", PILL);
        const undone = await undoPageDag(h, ctx.runId);
        const running = await polishWaitFor(h, `(document.querySelector('${PILL}')?.textContent ?? "").trim() !== "finalizing"`, 4000);
        await polishNap(SETTLE_MS);
        const rflash = await stop(h, "rflash");
        const flashFrames = (rflash?.frames ?? []).filter((f) => f.flash);
        const openedT3 = await dagPeekOpen(h, T3, "t-3");
        await failRpc(h, "DagActionCommand", REFUSAL);
        await start(h, "rnudge", ALERT_T3);
        await clickIn(h, dagPeekCard(T3), '[data-dag-peek-action="retry"]');
        const rAlerted = await polishWaitFor(h, `(${dagPeekCard(T3)}?.querySelector('[role="alert"]')?.textContent ?? "").trim() === ${JSON.stringify(REFUSED_TEXT)}`, 3000);
        await polishNap(SETTLE_MS);
        const rnudge = await stop(h, "rnudge");
        await releaseRpc(h, "DagActionCommand");
        await h.shot("cdp-shots/motion-dag-peek-reduced.png");
        const rShook = (rnudge?.frames ?? []).filter((f) => Math.abs(shiftX(f.transform)) > 0.5).length;
        rec(
            "10. under reduced motion the pill's status change carries the flash class with no animation running, and a refused Retry shows its error without one frame off its rest position",
            undone === "ok" &&
                running &&
                flashFrames.length > 0 &&
                flashFrames.every((f) => f.anim === "none") &&
                openedT3 &&
                rAlerted &&
                (rnudge?.frames.length ?? 0) > 0 &&
                rShook === 0,
            { undone, running, flashFrames: flashFrames.length, anims: [...new Set(flashFrames.map((f) => f.anim))], openedT3, rAlerted, rShook }
        );
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
        await polishNap(300);

        // 11. a review note that grows past its clamp while t-2's card is open fades its toggle in
        const seededNote = await injectPageDag(h, ctx.runId, {
            tasks: { "t-2": { reviewverdict: "pass", reviewnote: SHORT_NOTE, verifystartedts: Date.now() - VERIFY_AGO_MS } },
        });
        const openedT2 = await dagPeekOpen(h, T2, "t-2");
        const shortShown = await polishWaitFor(h, `(${NOTE}?.textContent ?? "").includes(${JSON.stringify(SHORT_NOTE)})`, 4000);
        await polishNap(SETTLE_MS);
        const toggleBefore = await h.ev(`!!${TOGGLE}`);
        await start(h, "more", `${T2} [data-peek-review-toggle]`);
        const grewNote = await injectPageDag(h, ctx.runId, { tasks: { "t-2": { reviewnote: LONG_NOTE } } });
        const toggled = await polishWaitFor(h, `!!${TOGGLE}`, 4000);
        await polishNap(SETTLE_MS);
        const more = await stop(h, "more");
        await h.shot("cdp-shots/motion-dag-peek-more.png");
        rec(
            "11. t-2's short review note shows no toggle; the note growing past three lines fades Show the whole note in from 0 to 1",
            seededNote === "ok" && openedT2 && shortShown && !toggleBefore && grewNote === "ok" && toggled && fadedIn(more),
            { seededNote, openedT2, shortShown, toggleBefore, grewNote, toggled, more: brief(more) }
        );

        // 12. the toggle unclamps the note in place, and its AutoHeight moves through the heights between
        await h.ev(`(window.__mdpNoteBox = ${NOTE}?.parentElement?.parentElement) != null`);
        const n0 = await h.ev(`Math.round(window.__mdpNoteBox?.getBoundingClientRect().height ?? 0)`);
        await start(h, "note", `${T2} [data-peek-review-note]`, "window.__mdpNoteBox");
        await h.ev(`${TOGGLE}?.click()`);
        const unclamped = await polishWaitFor(h, `(${TOGGLE}?.textContent ?? "").trim() === "Show less"`, 3000);
        await polishNap(SETTLE_MS);
        const note = await stop(h, "note");
        const n1 = note?.settled?.h ?? null;
        const noteBetween = (note?.frames ?? []).filter((f) => f.h > n0 + 1 && f.h < (n1 ?? n0) - 1).length;
        await h.shot("cdp-shots/motion-dag-peek-note.png");
        rec(
            "12. Show the whole note grows the clamped note's box through the frames between its three-line and full heights",
            unclamped && n1 != null && n1 - n0 > RESIZE_PX && noteBetween > 0,
            { unclamped, n0, n1, noteBetween, frames: note?.frames.length }
        );

        // 13. Verify output arriving under t-2's Verify heading reveals the tail from height 0 and opacity 0
        const TAIL_BOX = `${T2} [data-dag-peek-verify] > div:has(> [data-peek-verify-tail])`;
        const headingOnly = await h.ev(`!!${dagPeekCard(T2)}?.querySelector("[data-dag-peek-verify]") && !${dagPeekCard(T2)}?.querySelector("[data-peek-verify-tail]")`);
        await start(h, "tail", TAIL_BOX);
        const tailInjected = await injectPageDag(h, ctx.runId, { tasks: { "t-2": { verifyoutput: VERIFY_TAIL } } });
        const tailShown = await polishWaitFor(h, `(${dagPeekCard(T2)}?.querySelector("[data-peek-verify-tail]")?.textContent ?? "").includes("ok")`, 4000);
        await polishNap(SETTLE_MS);
        const tail = await stop(h, "tail");
        const tailGrowing = (tail?.frames ?? []).filter((f) => f.h > 1 && f.h < (tail?.settled?.h ?? 0) - 1).length;
        await h.shot("cdp-shots/motion-dag-peek-verify-tail.png");
        rec(
            "13. t-2's Verify output arriving reveals its tail at height 0 and opacity 0, through the heights between, settling opaque at full height",
            headingOnly && tailInjected === "ok" && tailShown && fadedIn(tail) && tail.first[0].h === 0 && tail.settled.h > 0 && tailGrowing > 0,
            {
                headingOnly,
                tailInjected,
                tailShown,
                tail: brief(tail),
                tailGrowing,
                hs: (tail?.frames ?? []).map((f) => [f.t, f.h, f.opacity]),
            }
        );

        // 14. a refused End final stage reveals its error beside the button and nudges it once
        const finalInjected = await injectPageDag(h, ctx.runId, {
            fields: { status: "finalizing", final: { state: "verifying", round: 1, startedts: Date.now() } },
        });
        await h.ev(dagPeekClickNode("final"));
        const endable = await polishWaitFor(h, `!!${dagPeekCard(DAG_PEEK_FINAL_SEL)}?.querySelector("[data-final-end]")`, 4000);
        await clickIn(h, dagPeekCard(DAG_PEEK_FINAL_SEL), "[data-final-end]");
        const formOpen = await polishWaitFor(h, `!!${END_REASON}`, 3000);
        await h.ev(`(() => {
            const ta = ${END_REASON};
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(END_REASON_TEXT)});
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        })()`);
        await polishNap(150);
        await failRpc(h, "DagActionCommand", END_REFUSAL);
        await start(h, "endError", `${DAG_PEEK_FINAL_SEL} [role="alert"]`);
        await clickButton(h, dagPeekCard(DAG_PEEK_FINAL_SEL), "Fail");
        const endAlerted = await polishWaitFor(h, `(${dagPeekCard(DAG_PEEK_FINAL_SEL)}?.querySelector('[role="alert"]')?.textContent ?? "").includes(${JSON.stringify(END_REFUSAL)})`, 3000);
        await polishNap(SETTLE_MS);
        const endError = await stop(h, "endError");
        await releaseRpc(h, "DagActionCommand");
        await h.shot("cdp-shots/motion-dag-peek-end-error.png");
        const endShook = (endError?.frames ?? []).filter((f) => Math.abs(shiftX(f.transform)) > 0.5).length;
        // End final stage again clears the error and closes the form: the strip collapses still reading the error
        const endText = await h.ev(`((window.__mdpEndAlert = ${dagPeekCard(DAG_PEEK_FINAL_SEL)}?.querySelector('[role="alert"]'))?.textContent ?? "").trim()`);
        await start(h, "endClear", `${DAG_PEEK_FINAL_SEL} [role="alert"]`, "window.__mdpEndAlert");
        await clickIn(h, dagPeekCard(DAG_PEEK_FINAL_SEL), "[data-final-end]");
        const endCleared = await polishWaitFor(h, `window.__mdpEndAlert?.isConnected === false`, 3000);
        const endClear = await stop(h, "endClear");
        await polishNap(SETTLE_MS);
        rec(
            "14. a refused Fail in End final stage reveals its error from opacity 0 and shakes it along x, ending at rest",
            finalInjected === "ok" &&
                endable &&
                formOpen &&
                endAlerted &&
                endError?.first[0]?.parentOpacity === "0" &&
                endShook > 0 &&
                endError.settled?.transform === "none",
            { finalInjected, endable, formOpen, endAlerted, first: endError?.first.slice(0, 2), endShook, settled: endError?.settled }
        );
        const endHeld = (endClear?.frames ?? []).filter((f) => f.attached);
        const endCollapsing = endHeld.filter((f) => num(f.parentOpacity) < 0.99).length;
        rec(
            "14b. End final stage again clears the refusal: its strip collapses mid-fade with the refusal's text on every attached frame, then detaches",
            endAlerted &&
                endText.includes(END_REFUSAL) &&
                endCleared &&
                endCollapsing > 0 &&
                endHeld.every((f) => f.text === endText) &&
                endClear.frames.at(-1)?.attached === false,
            { endText, endCleared, endCollapsing, texts: [...new Set(endHeld.map((f) => f.text))], frames: endClear?.frames.length }
        );

        // 15. a refused Cancel in the DAG header reveals its error beside the button and nudges it once
        await failRpc(h, "CancelRunCommand", CANCEL_REFUSAL);
        await start(h, "cancelError", `${IN_MODAL} [data-dag-cancel-error]`);
        await h.ev(`document.querySelector('${IN_MODAL} [data-dag-cancel]')?.click()`);
        // live sessions ask first; the confirm opens over the DAG modal
        const confirmed = await clickConfirm(h, "Cancel run");
        const cancelAlerted = await polishWaitFor(h, `(document.querySelector('${IN_MODAL} [data-dag-cancel-error]')?.textContent ?? "").trim() === ${JSON.stringify(CANCEL_REFUSAL)}`, 3000);
        await polishNap(SETTLE_MS);
        const cancelError = await stop(h, "cancelError");
        await h.shot("cdp-shots/motion-dag-peek-cancel-error.png");
        const cancelShook = (cancelError?.frames ?? []).filter((f) => Math.abs(shiftX(f.transform)) > 0.5).length;
        await releaseRpc(h, "CancelRunCommand");
        rec(
            "15. a refused Cancel in the DAG header reveals its error from opacity 0 and shakes it along x, ending at rest",
            confirmed &&
                cancelAlerted &&
                cancelError?.first[0]?.parentOpacity === "0" &&
                cancelShook > 0 &&
                cancelError.settled?.transform === "none",
            { confirmed, cancelAlerted, first: cancelError?.first.slice(0, 2), cancelShook, settled: cancelError?.settled }
        );

        // 15b. Cancel again clears the refusal before its confirm opens: the strip collapses still reading it, and
        // Keep running closes the confirm without cancelling
        await h.ev(`(window.__mdpCancelAlert = document.querySelector('${IN_MODAL} [data-dag-cancel-error]')) != null`);
        await start(h, "cancelClear", `${IN_MODAL} [data-dag-cancel-error]`, "window.__mdpCancelAlert");
        await h.ev(`document.querySelector('${IN_MODAL} [data-dag-cancel]')?.click()`);
        const cancelCleared = await polishWaitFor(h, `window.__mdpCancelAlert?.isConnected === false`, 3000);
        const cancelClear = await stop(h, "cancelClear");
        const kept = await clickConfirm(h, "Keep running");
        const confirmClosed = await polishWaitFor(h, `!(document.body.textContent ?? "").includes("cancel this run?")`, 3000);
        const cancelHeld = (cancelClear?.frames ?? []).filter((f) => f.attached);
        const cancelCollapsing = cancelHeld.filter((f) => num(f.parentOpacity) < 0.99).length;
        rec(
            "15b. Cancel again clears the refusal: its strip collapses mid-fade with the refusal's text on every attached frame, then detaches, and Keep running closes the confirm",
            cancelAlerted &&
                cancelCleared &&
                cancelCollapsing > 0 &&
                cancelHeld.every((f) => f.text === CANCEL_REFUSAL) &&
                cancelClear.frames.at(-1)?.attached === false &&
                kept &&
                confirmClosed,
            { cancelCleared, cancelCollapsing, texts: [...new Set(cancelHeld.map((f) => f.text))], frames: cancelClear?.frames.length, kept, confirmClosed }
        );
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch((e) => {
            console.error(`motion-dag-peek teardown: reset the media emulation failed: ${e?.message ?? e}`);
        });
        for (const command of ["DagActionCommand", "CancelRunCommand"]) {
            await releaseRpc(h, command).catch((e) => {
                console.error(`motion-dag-peek teardown: restore RpcApi.${command} failed: ${e?.message ?? e}`);
            });
        }
        await dagPeekScenario.teardown(h, ctx);
    },
};
