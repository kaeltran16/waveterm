// motion-final: the motion sweep's moments on the final stage and the screenshot viewer
// (docs/superpowers/plans/2026-11-10-motion-sweep.md, Task 5). The data is final-stage's own arrange: a git
// project's run held by a busy t-1, its dag seeded through the States rows, the lead focused with its rail open.
// Each moment is read in-page, as motion-gaps and dag-motion do: an observer records how a node looks the moment
// it is added (mid-flight), then the node is read again once it settled.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalStageScenario } from "./scenarios-runs.mjs";
import { FINAL_SHOTS_UICTX, FST_DETAIL, fstShow, polishNap, polishWaitFor, seedFinalShots, waveService } from "./scenarios-shared.mjs";

const PANE = `document.querySelector("[data-final-pane]")`;
const RAIL = `document.querySelector('aside[aria-label="Agent details"] [data-final-rail]')`;
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
    const path = el.querySelector?.("path");
    return {
        opacity: cs.opacity,
        transform: cs.transform,
        width: Math.round(el.getBoundingClientRect().width),
        dash: path ? getComputedStyle(path).strokeDasharray : null,
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
        const mid = { attached: node.isConnected, opacity: Number(getComputedStyle(node).opacity) };
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
// the step container StepSwap mounts inside the viewer's stage
const SHOT_STEP = `(n) => (n.parentElement?.matches("[data-final-shots-stage]") ? n : null)`;

// the stage's row focused, with its pane and rail; re-checked after a beat, since the arrange's own focus on the
// lead can land after this click and take the pane away
async function focusStageRow(h) {
    for (let i = 0; i < 3; i++) {
        if (await h.ev(`!!${PANE} && !!${RAIL}`)) {
            await polishNap(SETTLE_MS);
            if (await h.ev(`!!${PANE} && !!${RAIL}`)) return true;
        }
        if ((await h.activeSurfaceLabel()) !== "Agent") await h.goto("agent");
        if (!(await polishWaitFor(h, `!!${ROW}`, WAIT_MS))) return false;
        await click(h, ROW);
        await polishWaitFor(h, `!!${PANE} && !!${RAIL}`, WAIT_MS);
    }
    return h.ev(`!!${PANE} && !!${RAIL}`);
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

        // --- the pane and the rail ---
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
        // Tree passes while the pane shows it: its dot cross-fades away and a check draws on in its place
        await arm(h, "glyph", `(n) => (n.matches('[data-crossfade="pass"]') && n.closest('[data-final-pane] [data-final-step="tree"]') ? n : null)`);
        await arm(h, "check", `(n) => (n.matches("svg") && n.closest('[data-final-pane] [data-final-step="tree"]') ? n : null)`);
        const wait = await fstShow(h, ctx, "alongside");
        await polishWaitFor(h, `${paneStates}.startsWith("passed")`, WAIT_MS);
        if (!(await h.ev(`${paneStates}.startsWith("passed")`))) await wait.nudge?.();
        const glyph = await collect(h, "glyph");
        const check = await collect(h, "check", `${PANE}?.querySelector('[data-final-step="tree"] svg')`);
        rec(
            "2. a step that passes on screen swaps its mark with a cross-fade and draws its check from an empty stroke",
            fadedIn(glyph) && /^0(px)?,/.test(check.first?.dash ?? "") && /^1(px)?,/.test(check.settled?.dash ?? ""),
            { glyph, check }
        );
        await h.shot("cdp-shots/motion-final-1-check.png");

        // round 1's line in the rail opens its failure detail; the list around it follows its height
        await fstShow(h, ctx, "reviewing");
        await focusStageRow(h);
        const pastLine = `${RAIL}?.querySelector('[data-final-past-round="1"]')`;
        await polishWaitFor(h, `!!${pastLine}`, WAIT_MS);
        await arm(h, "past", `(n) => (n.querySelector?.("[data-final-past-round-detail]") ? n : null)`);
        const grow = await h.ev(`(async () => {
            const line = ${pastLine};
            if (!line) return null;
            const list = line.parentElement.parentElement;
            const box = list.parentElement.parentElement;
            line.click();
            const trace = [];
            // the box's height and clip, against the list's, every 100ms
            for (let i = 0; i < 12; i++) {
                await new Promise((r) => setTimeout(r, 100));
                trace.push([Math.round(box.getBoundingClientRect().height), getComputedStyle(box).overflow, list.offsetHeight]);
            }
            const mid = { box: trace[0][0], clip: trace[0][1], list: trace[0][2] };
            return { mid, settled: { box: box.getBoundingClientRect().height, list: list.offsetHeight }, trace };
        })()`);
        const past = await collect(h, "past");
        await h.shot("cdp-shots/motion-final-2-past-open.png");
        const pastExit = await exitOf(h, pastLine, `${pastLine}?.parentElement?.querySelector("[data-final-past-round-detail]")?.parentElement`);
        rec(
            "3. a past round's detail reveals from opacity 0, the list's height trails it clipped and then matches it, and closing fades it out attached",
            fadedIn(past) &&
                grow != null &&
                grow.mid.box < grow.mid.list - 1 &&
                grow.mid.clip === "hidden" &&
                Math.abs(grow.settled.box - grow.settled.list) <= 1 &&
                leftOnScreen(pastExit),
            { past, grow, pastExit }
        );

        // the stage fails on its own: the note fades in, without a nudge
        await focusStageRow(h);
        await arm(h, "note", `(n) => (n.matches("[data-final-note]") ? n : n.querySelector?.("[data-final-note]"))`, { frames: true });
        const failWait = await fstShow(h, ctx, "failed");
        await polishWaitFor(h, `!!${PANE}?.querySelector("[data-final-note]")`, WAIT_MS);
        const note = await collect(h, "note");
        rec("4. a failure nobody asked for fades its note in, with no nudge", fadedIn(note) && note.moved === 0, note);

        // a step that ended opens its kept output: the pane trades views with a fade, the rail reveals it beneath
        const keptDir = join(ctx.out, "1-steps");
        mkdirSync(keptDir, { recursive: true });
        writeFileSync(join(keptDir, "check.txt"), `${KEPT_MARK}\n`);
        await polishWaitFor(h, `${paneStates} === "passed,passed,passed,failed,notrun"`, WAIT_MS);
        if (!(await h.ev(`${paneStates} === "passed,passed,passed,failed,notrun"`))) await failWait.nudge?.();
        await arm(h, "paneView", `(n) => (n.matches('[data-final-pane-view="kept"]') ? n : null)`);
        await click(h, `${PANE}?.querySelector('[data-final-step="check"]')`);
        const paneView = await collect(h, "paneView");
        await click(h, `${PANE}?.querySelector('[data-final-step="check"]')`);
        await polishWaitFor(h, `!!${PANE}?.querySelector('[data-final-pane-view="outcome"]')`, WAIT_MS);
        await arm(h, "railOut", `(n) => (n.querySelector?.('[data-final-step-output="check"]') ? n : null)`);
        const railCheck = `${RAIL}?.querySelector('[data-final-step="check"]')`;
        await click(h, railCheck);
        const railOut = await collect(h, "railOut");
        const railText = await h.ev(`(${RAIL}?.textContent ?? "").includes(${JSON.stringify(KEPT_MARK)})`);
        await h.shot("cdp-shots/motion-final-3-kept.png");
        const railExit = await exitOf(h, railCheck, `${RAIL}?.querySelector('[data-final-step-output="check"]')?.parentElement`);
        rec(
            "5. a kept output fades in as the pane's view and reveals under the rail's row, and closing the rail's fades it out attached",
            fadedIn(paneView) && fadedIn(railOut) && railText && leftOnScreen(railExit),
            { paneView, railOut, railText, railExit }
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
        await arm(h, "refusal", `(n) => (n.matches("span.text-error") && n.closest("[data-final-pane]") ? n : null)`, { frames: true });
        await click(h, rerun);
        await polishWaitFor(h, `!!${PANE}?.querySelector("span.text-error")`, WAIT_MS);
        const refusal = await collect(h, "refusal");
        const refusalText = await h.ev(`${PANE}?.querySelector("span.text-error")?.textContent ?? null`);
        await h.shot("cdp-shots/motion-final-4b-refused.png");
        await seedFinalShots(h, ctx, round2Failed);
        rec(
            "6b. a rerun the engine refuses shows its reason beside the button with one nudge, and settles still",
            refusal.first != null && refusal.moved > 0 && refusal.settled?.transform === "none" && /only a failed one/.test(refusalText ?? ""),
            { refusal, refusalText }
        );

        // --- the screenshot viewer, on round 1 ---
        await arm(h, "viewer", `(n) => (n.matches("[data-final-shots-viewer]") ? n : n.querySelector?.("[data-final-shots-viewer]"))`);
        await click(h, `${PANE}?.querySelector("[data-final-shots-link]")`);
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
        const link = `${PANE}?.querySelector("[data-final-shots-link]")`;
        await polishWaitFor(h, `!${PANE}?.querySelector("[data-final-note]") && !!${link}`, WAIT_MS);
        await click(h, link);
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
