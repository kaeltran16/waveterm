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
import { failRpc, polishNap, polishWaitFor, releaseRpc } from "./scenarios-shared.mjs";

const REFUSAL = "motion-dag-peek refused this retry on the page";
const REFUSED_TEXT = `retry t-3 failed: ${REFUSAL}`;
// longer than the macro moments (360ms), so a sample's last frame is the settled one
const SETTLE_MS = 700;
// longer than the change flash (1.2s)
const FLASH_MS = 1600;
// a card height change smaller than this is not a resize to follow
const RESIZE_PX = 8;
// the run is live: without a lead this large, the engine's dag writes replace the finalizing copy before steps 8-10
const PAGE_DAG_AHEAD = 1000000;

const T1 = dagPeekTaskSel("t-1");
const T3 = dagPeekTaskSel("t-3");
const IN_MODAL = "[data-dag-modal-kind]";
const PILL = `${IN_MODAL} [data-dag-status-pill]`;
const ALERT_T3 = `${T3} [role="alert"]`;

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

        // 6. Adjust in the header opens the Run settings dialog, which fades in; Esc closes only it
        const ADJUST = `document.querySelector('${IN_MODAL} [data-dag-adjust]')`;
        const RS_DIALOG = `[role="dialog"]:has([data-run-settings-modal])`;
        const pressedNodes = `[...document.querySelectorAll('${IN_MODAL} [data-dag-node][aria-pressed="true"]')].map((n) => n.getAttribute("data-dag-node")).join(",")`;
        const pressedBefore = await h.ev(pressedNodes);
        await start(h, "adjust", RS_DIALOG);
        await h.ev(`${ADJUST}?.click()`);
        const adjustOpen = await polishWaitFor(h, `!!document.querySelector('${RS_DIALOG}')`, 3000);
        await polishNap(SETTLE_MS);
        const adjust = await stop(h, "adjust");
        await h.shot("cdp-shots/motion-dag-peek-adjust.png");
        await h.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
        const adjustGone = await polishWaitFor(h, `!document.querySelector('${RS_DIALOG}')`, 3000);
        await polishNap(SETTLE_MS);
        const dagStillOpen = await h.ev(`!!document.querySelector('${IN_MODAL}')`);
        const pressedAfter = await h.ev(pressedNodes);
        rec(
            "6. Adjust in the DAG header fades the Run settings dialog in from 0 to 1, and Esc closes only it, leaving the DAG modal and its selection",
            adjustOpen && fadedIn(adjust) && adjustGone && dagStillOpen === true && pressedAfter === pressedBefore,
            { adjustOpen, adjust: brief(adjust), adjustGone, dagStillOpen, pressedBefore, pressedAfter }
        );

        // 7. the dag moving to finalizing washes the status pill once (page-only, so the engine never sees it)
        await start(h, "flash", PILL);
        const injected = await injectPageDag(h, ctx.runId, {
            fields: { status: "finalizing", final: { state: "verifying", round: 1, startedts: Date.now() } },
            ahead: PAGE_DAG_AHEAD,
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
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch((e) => {
            console.error(`motion-dag-peek teardown: reset the media emulation failed: ${e?.message ?? e}`);
        });
        await releaseRpc(h, "DagActionCommand").catch((e) => {
            console.error(`motion-dag-peek teardown: restore RpcApi.DagActionCommand failed: ${e?.message ?? e}`);
        });
        await dagPeekScenario.teardown(h, ctx);
    },
};
