// motion-final: the motion sweep's moments on the final stage and the screenshot viewer
// (docs/superpowers/plans/2026-11-10-motion-sweep.md, Task 5). The data is final-stage's own arrange: a git
// project's run held by a busy t-1, its dag seeded through the States rows, the lead focused with its rail open.
// Each moment is read in-page, as motion-gaps and dag-motion do: an observer records how a node looks the moment
// it is added (mid-flight), then the node is read again once it settled.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalStageScenario } from "./scenarios-final.mjs";
import { FINAL_SHOTS_UICTX, FST_DETAIL, fstShow, polishNap, polishWaitFor, seedFinalShots, waveService } from "./scenarios-shared.mjs";

const PANE = `document.querySelector("[data-final-pane]")`;
// the stage's own row has the workspace pane's Final tab beside its pane, never the details rail
const FINAL_TAB = `document.querySelector("[data-workspace-final]")`;
// the Final tab's first screenshot: the failed scenario's first, which is where the viewer opened from the old link
const TAB_SHOT = `${FINAL_TAB}?.querySelector("[data-final-tab-shot]")`;
const ROW = `document.querySelector("[data-agent-tree] [data-final-row]")`;
const VIEWER = `document.querySelector("[data-final-shots-viewer]")`;
const KEPT_MARK = "motion-final kept check output";
// past a macro entrance (360ms), and past a wait-mode step swap's exit then entrance (280 + 360ms), with room for
// the slow frames of a machine running other dev apps
const SETTLE_MS = 1500;
// the engine tick a rerun schedules, which would land over a seed written before it
const RERUN_TICK_MS = 3000;
const WAIT_MS = 10_000;

// how an element looks now: what the moments move
const READ = `(el) => {
    const cs = getComputedStyle(el);
    return {
        opacity: cs.opacity,
        transform: cs.transform,
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height),
    };
}`;

// records the first added element `match` (page-side source of el => element | null) returns, as it is added;
// with frames, also its transform every frame for 600ms, for moments that start and end at rest (a nudge)
const arm = (h, key, match, { frames = false } = {}) =>
    h.ev(`(() => {
        const read = ${READ};
        const match = ${match};
        const rec = { first: null, node: null, frames: [], addedAlone: null };
        (window.__motionFinal ??= {})[${JSON.stringify(key)}] = rec;
        const obs = new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
                const hit = n instanceof Element ? match(n) : null;
                if (!hit) continue;
                obs.disconnect();
                rec.node = hit;
                rec.first = read(hit);
                // whether the element it replaced was already gone when it arrived
                rec.addedAlone = hit.parentElement ? hit.parentElement.children.length === 1 : null;
                if (${frames}) {
                    const start = performance.now();
                    const tick = () => {
                        rec.frames.push(getComputedStyle(hit).transform);
                        if (performance.now() - start < 600) requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                }
                return;
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => obs.disconnect(), 20_000);
        return true;
    })()`);

// nowExpr: where to read the settled look when a re-render replaced the recorded node (a republished event)
const collect = async (h, key, nowExpr = "null") => {
    await polishNap(SETTLE_MS);
    // motion runs opacity as a browser animation and height in its own frames, so on a loaded machine the nap can
    // end with the height done and the fade still running (run 2089c1d0 round 3 read opacity 0.50): read the settled
    // look once the node's animations stopped, still failing a fade that ends short of 1 or never ends
    await polishWaitFor(
        h,
        `(() => {
            const n = window.__motionFinal?.[${JSON.stringify(key)}]?.node;
            return !n?.isConnected || n.getAnimations().every((a) => a.playState !== "running");
        })()`,
        WAIT_MS
    );
    return h.ev(`(() => {
        const read = ${READ};
        const rec = window.__motionFinal?.[${JSON.stringify(key)}];
        const now = rec?.node?.isConnected ? rec.node : ${nowExpr};
        return {
            first: rec?.first ?? null,
            settled: now ? read(now) : null,
            replaced: !!now && now !== rec?.node,
            moved: [...new Set(rec?.frames ?? [])].filter((t) => t !== "none").length,
            addedAlone: rec?.addedAlone ?? null,
        };
    })()`);
};

// a node that mounts at opacity 0 and settles at 1
const fadedIn = (r) => r?.first?.opacity === "0" && r.settled?.opacity === "1";

// clicks a toggle and reads the element it closes mid-exit and after: attached and part-faded, then gone
const exitOf = (h, clickExpr, nodeExpr) =>
    h.ev(`(async () => {
        const node = ${nodeExpr};
        const btn = ${clickExpr};
        if (!node || !btn) return null;
        btn.click();
        await new Promise((r) => setTimeout(r, 90));
        const mid = {
            attached: node.isConnected,
            opacity: Number(getComputedStyle(node).opacity),
            height: Math.round(node.getBoundingClientRect().height),
        };
        await new Promise((r) => setTimeout(r, 700));
        return { mid, goneAfter: !node.isConnected };
    })()`);
const leftOnScreen = (r) => r != null && r.mid.attached && r.mid.opacity > 0 && r.mid.opacity < 1 && r.goneAfter;

const click = (h, expr) =>
    h.ev(`(() => {
        const el = ${expr};
        if (!el) return false;
        el.focus?.();
        el.click();
        return true;
    })()`);

// a DOM key event at the focused element, as final-shots sends them: the viewer's keybindings listen on window
const KEY_CODES = { ArrowRight: "ArrowRight", ArrowDown: "ArrowDown", z: "KeyZ", s: "KeyS" };
const keyJs = (key) => `(() => {
    const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(KEY_CODES[key])}, bubbles: true, cancelable: true };
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
})()`;
const key = (h, k) => h.ev(keyJs(k));

const paneStates = `[...(${PANE}?.querySelectorAll("[data-final-step]") ?? [])].map((s) => s.getAttribute("data-final-step-state")).join(",")`;
const paneHead = (key) => `${PANE}?.querySelector('[data-final-step="${key}"] [data-final-step-head]')`;
// the PaneReveal a pane row's opened body sits in
const paneBodyPane = (key) => `${PANE}?.querySelector('[data-final-step-body="${key}"]')?.parentElement`;
// a refused rerun's reason, beside its button: the failed step's exit chip is a span.text-error too
const REFUSAL = `${PANE}?.querySelector("[data-final-rerun]")?.parentElement?.querySelector("span.text-error")`;
// the step container StepSwap mounts inside the viewer's stage
const SHOT_STEP = `(n) => (n.parentElement?.matches("[data-final-shots-stage]") ? n : null)`;

// the stage's row focused, with its pane and Final tab; re-checked after a beat, since the arrange's own focus on the
// lead can land after this click and take the pane away
async function focusStageRow(h) {
    for (let i = 0; i < 3; i++) {
        if (await h.ev(`!!${PANE} && !!${FINAL_TAB}`)) {
            await polishNap(SETTLE_MS);
            if (await h.ev(`!!${PANE} && !!${FINAL_TAB}`)) return true;
        }
        if ((await h.activeSurfaceLabel()) !== "Agent") await h.goto("agent");
        if (!(await polishWaitFor(h, `!!${ROW}`, WAIT_MS))) return false;
        await click(h, ROW);
        await polishWaitFor(h, `!!${PANE} && !!${FINAL_TAB}`, WAIT_MS);
    }
    return h.ev(`!!${PANE} && !!${FINAL_TAB}`);
}

export const motionFinal = {
    name: "motion-final",
    surface: "agent",
    async arrange(h) {
        return finalStageScenario.arrange(h);
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: ok === true, detail: JSON.stringify(detail) });
        rec("0. final-stage's arrange: a run with t-1 at work and the lead focused", ctx.arrangeError == null && ctx.leadFocused, {
            arrangeError: ctx.arrangeError,
            runId: ctx.runId,
            leadFocused: ctx.leadFocused,
        });
        if (ctx.arrangeError != null) return steps;

        // --- the pane ---
        await fstShow(h, ctx, "tree");
        const focused = await focusStageRow(h);

        // the End final stage form pops from its button and leaves the same way
        await arm(h, "form", `(n) => (n.closest("[data-final-pane]") && n.querySelector("[data-run-sheet-end-final]") ? n : null)`);
        await click(h, `${PANE}?.querySelector("[data-final-end]")`);
        const form = await collect(h, "form");
        const formExit = await exitOf(
            h,
            `[...(${PANE}?.querySelectorAll("[data-run-sheet-end-final] button") ?? [])].find((b) => b.textContent.trim() === "Keep running")`,
            `${PANE}?.querySelector("[data-run-sheet-end-final]")?.parentElement`
        );
        rec(
            "1. End final stage's form pops in from opacity 0 and, on Keep running, fades out attached before it is removed",
            focused && fadedIn(form) && form.first.transform !== "none" && leftOnScreen(formExit),
            { focused, form, formExit }
        );

        await focusStageRow(h);
        // Tree passes while the pane shows it: its mark slot cross-fades from the spinner to the check square
        const treeMark = `${PANE}?.querySelector('[data-final-step="tree"] [data-final-step-mark]')`;
        const markBefore = await h.ev(`${treeMark}?.getAttribute("data-final-step-mark") ?? null`);
        await arm(h, "glyph", `(n) => (n.matches('[data-crossfade="passed"]') && n.closest('[data-final-pane] [data-final-step="tree"]') ? n : null)`);
        const wait = await fstShow(h, ctx, "alongside");
        await polishWaitFor(h, `${paneStates}.startsWith("passed")`, WAIT_MS);
        if (!(await h.ev(`${paneStates}.startsWith("passed")`))) await wait.nudge?.();
        const glyph = await collect(h, "glyph");
        const markAfter = await h.ev(`(() => {
            const slot = ${treeMark};
            return {
                kind: slot?.getAttribute("data-final-step-mark") ?? null,
                glyphs: slot?.querySelectorAll("[data-crossfade]").length ?? 0,
                label: slot?.querySelector('[data-crossfade="passed"] [role="img"]')?.getAttribute("aria-label") ?? null,
            };
        })()`);
        rec(
            "2. a step that passes on screen cross-fades its mark slot from its spinner to the check square",
            markBefore === "running" && fadedIn(glyph) && markAfter.kind === "passed" && markAfter.glyphs === 1 && markAfter.label === "Succeeded",
            { markBefore, glyph, markAfter }
        );
        await h.shot("cdp-shots/motion-final-1-check.png");

        // round 1's line under the pane's steps opens its failure detail
        await fstShow(h, ctx, "reviewing");
        await focusStageRow(h);
        const pastLine = `${PANE}?.querySelector('[data-final-past-round="1"]')`;
        await polishWaitFor(h, `!!${pastLine}`, WAIT_MS);
        await arm(h, "past", `(n) => (n.querySelector?.(":scope > [data-final-past-round-detail]") && n.closest("[data-final-pane]") ? n : null)`);
        await click(h, pastLine);
        const past = await collect(h, "past");
        await h.shot("cdp-shots/motion-final-2-past-open.png");
        const pastExit = await exitOf(h, pastLine, `${pastLine}?.parentElement?.querySelector("[data-final-past-round-detail]")?.parentElement`);
        rec(
            "3. a past round's detail reveals from opacity 0 and no height, and closing fades it out attached",
            fadedIn(past) && past.first.height === 0 && past.settled?.height > 0 && leftOnScreen(pastExit),
            { past, pastExit }
        );

        // the stage fails on its own: the note fades in, without a nudge
        await focusStageRow(h);
        await arm(h, "note", `(n) => (n.matches("[data-final-note]") ? n : n.querySelector?.("[data-final-note]"))`, { frames: true });
        const failWait = await fstShow(h, ctx, "failed");
        await polishWaitFor(h, `!!${PANE}?.querySelector("[data-final-note]")`, WAIT_MS);
        const note = await collect(h, "note");
        rec("4. a failure nobody asked for fades its note in, with no nudge", fadedIn(note) && note.moved === 0, note);

        // a step that ended opens its kept output: the pane's row reveals its body in place and collapses it on a
        // second click
        const keptDir = join(ctx.out, "1-steps");
        mkdirSync(keptDir, { recursive: true });
        writeFileSync(join(keptDir, "check.txt"), `${KEPT_MARK}\n`);
        await polishWaitFor(h, `${paneStates} === "passed,passed,passed,failed,notrun"`, WAIT_MS);
        if (!(await h.ev(`${paneStates} === "passed,passed,passed,failed,notrun"`))) await failWait.nudge?.();
        await arm(h, "paneBody", `(n) => (n.querySelector?.(':scope > [data-final-step-body="check"]') && n.closest("[data-final-pane]") ? n : null)`);
        const paneClosed = await h.ev(`${paneHead("check")}?.getAttribute("aria-expanded") === "false"`);
        await click(h, paneHead("check"));
        const paneBody = await collect(h, "paneBody");
        const paneText = await h.ev(`(${paneBodyPane("check")}?.textContent ?? "").includes(${JSON.stringify(KEPT_MARK)})`);
        await h.shot("cdp-shots/motion-final-3-kept.png");
        const paneExit = await exitOf(h, paneHead("check"), paneBodyPane("check"));
        const paneCollapsed = paneExit != null && paneBody.settled != null && paneExit.mid.height < paneBody.settled.height;
        rec(
            "5. a kept output reveals in the pane's row from no height and collapses on close",
            paneClosed &&
                fadedIn(paneBody) &&
                paneBody.first.height === 0 &&
                paneBody.settled.height > 0 &&
                paneText &&
                leftOnScreen(paneExit) &&
                paneCollapsed,
            { paneClosed, paneBody, paneText, paneExit }
        );

        // the human reruns the failed stage and it fails again: this time the note nudges. Round 2, because the
        // rerun returns the round to not started, and a round 1 not started has no tree row, so no pane
        const round1 = ctx.shotsRound1;
        const round2Failed = { final: { ...round1, round: 2, detail: FST_DETAIL }, pastfinals: [round1] };
        await seedFinalShots(h, ctx, round2Failed);
        await focusStageRow(h);
        const rerun = `${PANE}?.querySelector("[data-final-rerun]")`;
        await polishWaitFor(h, `!!${rerun} && !!${PANE}?.querySelector("[data-final-note]")`, WAIT_MS);
        await click(h, rerun);
        const reset = await polishWaitFor(h, `!${rerun} && !!${PANE} && !${PANE}.querySelector("[data-final-note]")`, 15_000);
        await polishNap(RERUN_TICK_MS);
        await arm(h, "nudge", `(n) => (n.matches("[data-final-note]") ? n : n.querySelector?.("[data-final-note]"))`, { frames: true });
        await seedFinalShots(h, ctx, round2Failed);
        await polishWaitFor(h, `!!${PANE}?.querySelector("[data-final-note]")`, WAIT_MS);
        const nudge = await collect(h, "nudge", `${PANE}?.querySelector("[data-final-note]")`);
        const noteNow = await h.ev(`(() => {
            const n = ${PANE}?.querySelector("[data-final-note]");
            return n ? { transform: getComputedStyle(n).transform, same: n === window.__motionFinal?.nudge?.node } : null;
        })()`);
        rec(
            "6. after the human's rerun, the failure that answers it nudges its note sideways and settles still",
            reset && nudge.first != null && nudge.moved > 0 && noteNow?.transform === "none",
            { reset, nudge, noteNow }
        );
        await h.shot("cdp-shots/motion-final-4-nudged.png");

        // a rerun the engine refuses: the stored stage moved on, unpublished, while the page still offers Rerun
        await polishWaitFor(h, `!!${rerun}`, WAIT_MS);
        const oref = `dag:${ctx.dagId}`;
        const stored = await waveService(h, "object", "GetObject", [oref]);
        await waveService(h, "object", "UpdateObject", [{ ...stored, otype: "dag", final: { ...stored.final, state: "checking" } }, false], FINAL_SHOTS_UICTX);
        await arm(h, "refusal", `(n) => (n.matches("span.text-error") && n.parentElement?.querySelector("[data-final-rerun]") ? n : null)`, { frames: true });
        await click(h, rerun);
        await polishWaitFor(h, `!!${REFUSAL}`, WAIT_MS);
        const refusal = await collect(h, "refusal");
        const refusalText = await h.ev(`${REFUSAL}?.textContent ?? null`);
        await h.shot("cdp-shots/motion-final-4b-refused.png");
        await seedFinalShots(h, ctx, round2Failed);
        rec(
            "6b. a rerun the engine refuses shows its reason beside the button with one nudge, and settles still",
            refusal.first != null && refusal.moved > 0 && refusal.settled?.transform === "none" && /only a failed one/.test(refusalText ?? ""),
            { refusal, refusalText }
        );

        // --- the screenshot viewer, on round 1 ---
        await polishWaitFor(h, `!!${rerun} && !!${PANE}?.querySelector("[data-final-note]")`, WAIT_MS);
        await arm(h, "viewer", `(n) => (n.matches("[data-final-shots-viewer]") ? n : n.querySelector?.("[data-final-shots-viewer]"))`);
        await polishWaitFor(h, `!!${TAB_SHOT}`, WAIT_MS);
        await click(h, TAB_SHOT);
        const viewer = await collect(h, "viewer");
        const imgLoaded = `(() => { const i = ${VIEWER}?.querySelector("[data-final-shots-stage] img[alt]:not([alt=''])"); return !!i && i.complete && i.naturalWidth > 0; })()`;
        await polishWaitFor(h, imgLoaded, WAIT_MS);
        rec("7. the viewer opens from opacity 0, scaled, and settles", fadedIn(viewer) && viewer.first.transform !== "none", viewer);

        await arm(h, "next", SHOT_STEP);
        await key(h, "ArrowRight");
        const next = await collect(h, "next");
        rec(
            "8. → slides the next screenshot in from the right at opacity 0, after the last one left",
            fadedIn(next) && /^matrix\(1, 0, 0, 1, 16, 0\)$/.test(next.first.transform) && next.settled.transform === "none" && next.addedAlone === true,
            next
        );

        await arm(h, "scenario", `(n) => (n.matches("[data-final-shots-view]") ? n : null)`);
        await key(h, "ArrowDown");
        const scenario = await collect(h, "scenario");
        rec("9. ↓ fades the next scenario's view in", fadedIn(scenario), scenario);

        await polishWaitFor(h, `!${VIEWER}?.querySelector('aside[aria-label="Steps"]')`, WAIT_MS);
        await arm(h, "drawer", `(n) => (n.matches('aside[aria-label="Steps"]') ? n : null)`);
        await key(h, "s");
        const drawer = await collect(h, "drawer");
        rec(
            "10. s opens the steps drawer from no width to its 360px",
            drawer.first != null && drawer.first.width < 10 && drawer.settled?.width === 360,
            drawer
        );
        await h.shot("cdp-shots/motion-final-5-drawer.png");

        await polishWaitFor(h, imgLoaded, WAIT_MS);
        const morph = await h.ev(`(async () => {
            const img = ${VIEWER}?.querySelector("[data-final-shots-stage] img[alt]:not([alt=''])");
            if (!img) return null;
            ${keyJs("z")};
            const seen = [];
            const start = performance.now();
            await new Promise((done) => {
                const tick = () => {
                    seen.push(getComputedStyle(img).transform);
                    if (performance.now() - start < 600) requestAnimationFrame(tick);
                    else done();
                };
                requestAnimationFrame(tick);
            });
            return { moved: seen.filter((t) => t !== "none").length, last: seen.at(-1), same: img.isConnected };
        })()`);
        await h.shot("cdp-shots/motion-final-6-actual.png");
        await key(h, "z");
        rec("11. z morphs the same image to its actual size and settles untransformed", morph != null && morph.same && morph.moved > 0 && morph.last === "none", morph);

        // reduced motion: the next screenshot lands at once, with no slide and nothing left behind
        await polishNap(SETTLE_MS);
        await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
        await polishNap(300);
        await arm(h, "reduced", SHOT_STEP);
        await key(h, "ArrowRight");
        const reduced = await collect(h, "reduced");
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
        rec(
            "12. under reduced motion → swaps the screenshot at once: full opacity, untransformed, the old one already gone",
            reduced.first?.opacity === "1" && reduced.first.transform === "none" && reduced.addedAlone === true,
            reduced
        );
        await click(h, `${VIEWER}?.querySelector('button[aria-label="Close"]')`);
        await polishWaitFor(h, `!${VIEWER}`, WAIT_MS);

        // --- two rounds: the tally's counts roll on a round switch ---
        const fixed = round1.shots.map((sc) => ({ ...sc, steps: sc.steps.map((st) => ({ ...st, state: st.state === "fail" ? "pass" : st.state })) }));
        await seedFinalShots(h, ctx, { final: { ...round1, round: 2, state: "unverified", detail: "", shots: fixed }, pastfinals: [round1] });
        await polishWaitFor(h, `!${PANE}?.querySelector("[data-final-note]") && !!${TAB_SHOT}`, WAIT_MS);
        await click(h, TAB_SHOT);
        const roundBtn = (n) => `[...(${VIEWER}?.querySelectorAll('[role="group"][aria-label="Round"] button') ?? [])].find((b) => b.innerText.trim().startsWith("Round ${n}"))`;
        await polishWaitFor(h, `!!${roundBtn(1)}`, WAIT_MS);
        await polishNap(SETTLE_MS);
        const tallyBefore = await h.ev(`(${VIEWER}?.firstElementChild?.innerText ?? "").replace(/\\s+/g, " ")`);
        await arm(h, "tick", `(n) => (n.parentElement?.classList.contains("tabular-nums") && n.closest("[data-final-shots-viewer] > :first-child") ? n : null)`);
        await arm(h, "round", `(n) => (n.matches("[data-final-shots-view]") ? n : null)`);
        await click(h, roundBtn(1));
        const tick = await collect(h, "tick");
        const round = await collect(h, "round");
        const tallyAfter = await h.ev(`(${VIEWER}?.firstElementChild?.innerText ?? "").replace(/\\s+/g, " ")`);
        rec(
            "13. a round switch rolls the tally's changed count in from off its line, and fades the round's view in",
            tallyBefore !== tallyAfter && fadedIn(tick) && tick.first.transform !== "none" && tick.settled.transform === "none" && fadedIn(round),
            { tallyBefore, tallyAfter, tick, round }
        );
        await h.shot("cdp-shots/motion-final-7-round-1.png");
        await click(h, `${VIEWER}?.querySelector('button[aria-label="Close"]')`);
        await polishWaitFor(h, `!${VIEWER}`, WAIT_MS);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch((e) => {
            console.error(`motion-final teardown: reset the media emulation failed: ${e?.message ?? e}`);
        });
        await finalStageScenario.teardown(h, ctx);
    },
};
