// motion-brainstorm: the motion sweep's moments on the brainstorm views (docs/superpowers/plans/2026-11-10-motion-sweep.md,
// Task 8). The talk agent is arranged as brainstorm-mode's are (bsArrangeAgent), the Run step as brainstorm-run-blocked's.
// Each step records frames while one state change plays: a timer samples the nodes it names every 16ms, and a
// MutationObserver records the computed style of a node as it is added, so a step can tell a node that mounted at
// opacity 0 and travelled from one that cut in.
import { BS_KIT } from "./scenarios-brainstorm.mjs";
import brainstormRun from "./scenarios-brainstorm-run.mjs";

const {
    bsArrangeAgent,
    bsShowFile,
    bsTeardownAgent,
    bsWrite,
    bsUntil,
    bsClick,
    polishWaitFor,
    polishNap,
    skipStep,
    fstWriteRun,
    BS_PANE,
    BS_FILES,
    BS_CHECK,
    BS_HANDOFF,
    BS_POLL_WAIT_MS,
} = BS_KIT;

const NAME = "motion-brainstorm";
const TOPIC = "motion-brainstorm-talk";
const RUN_SCENARIO = "brainstorm-run-blocked";
const SAMPLE_MS = 16;
// past the poller's read, the exit and the entrance
const CHANGE_WAIT_MS = BS_POLL_WAIT_MS + 3000;
const SETTLE_MS = 900;
const SHA = "5d2c8e1f0a9b7c6d5e4f3a2b1c0d9e8f7a6b5c4d";

// the asked question with pros and cons on every answer, so the toggle has something to fold
const Q4 = BS_FILES.mid.question;
const TALK = {
    ...BS_FILES.mid,
    question: {
        ...Q4,
        options: Q4.options.map((o, i) => ({ ...o, pros: [`For ${i + 1}.`], cons: [`Against ${i + 1}.`] })),
    },
};
const WORKING = { ...TALK, question: null, working: "Writing it up from your answer." };
const Q5 = { ...TALK, question: { ...TALK.question, n: 5, text: "Which partitions count toward the lag?" } };
const Q6 = { ...TALK, question: { ...TALK.question, n: 6, text: "Who hears about a lag page first?" } };
const ONE_MORE_CALL = { text: "The page links the partition's dashboard.", part: "thresholds" };
const CHECKED = { ...BS_HANDOFF, check: { ...BS_CHECK, calls: [...BS_CHECK.calls, ONE_MORE_CALL] } };

// page-side helpers every sample uses: a node's opacity, its transform and the x it is translated by
const STYLE_FNS = `
    const st = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        const m = /matrix\\(([^)]+)\\)/.exec(cs.transform);
        return { o: Number(cs.opacity), t: cs.transform, x: m ? Number(m[1].split(",")[4]) : 0 };
    };
    const pane = () => ${BS_PANE};
`;

// starts recording: sample() runs every SAMPLE_MS (a frame is kept when it differs from the last), added(n) picks the
// added nodes whose style is recorded as they attach
const startFrames = (h, sample, added = "() => false") =>
    h.ev(`(() => {
        ${STYLE_FNS}
        const sample = ${sample};
        const added = ${added};
        const rec = { frames: [], added: [], on: true };
        window.__motionBs = rec;
        let last = "";
        const tick = () => {
            if (!rec.on) return;
            let f;
            try { f = sample(); } catch (e) { f = { error: String(e) }; }
            const s = JSON.stringify(f);
            if (s !== last) { rec.frames.push(f); last = s; }
            setTimeout(tick, ${SAMPLE_MS});
        };
        tick();
        rec.mo = new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (n instanceof Element && added(n)) rec.added.push(st(n));
            }
        });
        rec.mo.observe(document.body, { childList: true, subtree: true });
        return true;
    })()`);

const stopFrames = (h) =>
    h.ev(`(() => {
        const rec = window.__motionBs;
        if (!rec) return { frames: [], added: [] };
        rec.on = false;
        rec.mo.disconnect();
        return { frames: rec.frames, added: rec.added };
    })()`);

// the frames a node was on screen in, by the key a sample stored it under
const seen = (frames, key) => frames.filter((f) => f[key] != null).map((f) => f[key]);
const settledAt = (s) => s != null && s.o === 1 && s.t === "none";
const midFade = (s) => s != null && s.o > 0 && s.o < 1;
const brief = (r) => ({ frames: r.frames.length, added: r.added, first: r.frames.slice(0, 4), last: r.frames.slice(-3) });

// the talk wrappers StepSwap moves: the motion.div around the question or the Working view
const TALK_SAMPLE = (text) => `() => {
    const q = [...(pane()?.querySelectorAll("[data-brainstorm-question]") ?? [])];
    const w = pane()?.querySelector("[data-brainstorm-working]");
    const mine = q.find((el) => el.innerText.includes(${JSON.stringify(text)}));
    const other = q.find((el) => el !== mine);
    return { next: st(mine?.parentElement), old: st(other?.parentElement), working: st(w?.parentElement) };
}`;

// one talk change: write file, wait until want's node has settled, and judge the frames between
async function talkStep(h, ctx, file, sample, added, settled) {
    await startFrames(h, sample, added);
    bsWrite(ctx, file);
    const done = await polishWaitFor(h, settled, CHANGE_WAIT_MS);
    await polishNap(SETTLE_MS);
    return { done, ...(await stopFrames(h)) };
}

async function talkSteps(h, ctx, rec) {
    const missing = await bsShowFile(h, ctx);
    if (missing != null) return rec("talk", null, `could not verify: ${missing}`, true);
    const s0 = await bsUntil(h, ctx, (s) => s.question.includes(Q4.text));
    if (!s0.ok) return rec("talk", false, "question 4 never drew");

    // 1. pros and cons fold away while still attached, then grow back in from opacity 0
    const PROS = `() => {
        const p = [...(pane()?.querySelectorAll("[data-brainstorm-proscons]") ?? [])];
        return { n: p.length, wrap: st(p[0]?.parentElement) };
    }`;
    const PROS_ADDED = `(n) => !!n.querySelector?.("[data-brainstorm-proscons]")`;
    const TOGGLE = `${BS_PANE}?.querySelector("[data-brainstorm-proscons-toggle]")`;
    await startFrames(h, PROS);
    await h.ev(`${TOGGLE}?.click()`);
    await polishNap(SETTLE_MS);
    const hide = await stopFrames(h);
    await startFrames(h, PROS, PROS_ADDED);
    await h.ev(`${TOGGLE}?.click()`);
    await polishNap(SETTLE_MS);
    const show = await stopFrames(h);
    const hideWraps = seen(hide.frames, "wrap");
    const showWraps = seen(show.frames, "wrap");
    await h.shot("cdp-shots/motion-brainstorm-1-proscons.png");
    rec(
        "1. Hide pros and cons fades them out while attached, then removes them; Show grows them back in from opacity 0 to 1",
        hideWraps.some(midFade) &&
            hide.frames.at(-1)?.n === 0 &&
            show.added.length === TALK.question.options.length &&
            show.added.every((a) => a.o === 0) &&
            showWraps.at(-1)?.o === 1 &&
            show.frames.at(-1)?.n === TALK.question.options.length,
        { hide: brief(hide), show: brief(show) }
    );

    // 2. a failed send's reason grows in and nudges once along x
    await h.ev(`(() => {
        const c = window.TabRpcClient;
        const orig = c.wshRpcCall;
        c.wshRpcCall = (command, data, opts) => {
            if (command !== "agentprompt") return orig.call(c, command, data, opts);
            c.wshRpcCall = orig;
            return Promise.reject(new Error("verify: the send was refused"));
        };
        return true;
    })()`);
    await startFrames(
        h,
        `() => {
            const e = pane()?.querySelector("[data-brainstorm-question] [data-brainstorm-error]");
            return { line: st(e), wrap: st(e?.parentElement), text: e?.innerText ?? "" };
        }`,
        `(n) => !!n.querySelector?.("[data-brainstorm-error]")`
    );
    const guessed = await bsClick(h, `${BS_PANE}?.querySelector("[data-brainstorm-question]")`, "Guess for me");
    await polishWaitFor(h, `!!${BS_PANE}?.querySelector("[data-brainstorm-question] [data-brainstorm-error]")`, 3000);
    await polishNap(SETTLE_MS);
    const err = await stopFrames(h);
    const lines = seen(err.frames, "line");
    await h.shot("cdp-shots/motion-brainstorm-2-error.png");
    rec(
        "2. a refused send's reason mounts at opacity 0, nudges along x, and settles still and opaque under the chips",
        guessed === "clicked" &&
            err.added[0]?.o === 0 &&
            lines.some((l) => Math.abs(l.x) > 0.5) &&
            settledAt(lines.at(-1)) &&
            seen(err.frames, "wrap").at(-1)?.o === 1 &&
            err.frames.at(-1)?.text.includes("the send was refused"),
        { guessed, ...brief(err) }
    );

    // 3. question 4 -> working -> question 5 slides forward, the old step leaving before the next arrives
    const toWorking = await talkStep(
        h,
        ctx,
        WORKING,
        TALK_SAMPLE(Q4.text),
        `(n) => !!n.querySelector?.("[data-brainstorm-working]")`,
        `(() => { const w = ${BS_PANE}?.querySelector("[data-brainstorm-working]")?.parentElement; return !!w && getComputedStyle(w).opacity === "1" && getComputedStyle(w).transform === "none"; })()`
    );
    const toQ5 = await talkStep(
        h,
        ctx,
        Q5,
        TALK_SAMPLE(Q5.question.text),
        `(n) => !!n.querySelector?.("[data-brainstorm-question]")`,
        `(() => { const q = ${BS_PANE}?.querySelector("[data-brainstorm-question]"); return !!q && q.innerText.includes(${JSON.stringify(Q5.question.text)}) && getComputedStyle(q.parentElement).opacity === "1" && getComputedStyle(q.parentElement).transform === "none"; })()`
    );
    const leaves = (r, key) => seen(r.frames, key).some((s) => midFade(s) && s.x < 0);
    const arrives = (r, key) => {
        const s = seen(r.frames, key);
        return r.added.some((a) => a.o === 0 && a.x > 0) && s.some((x) => x.x > 0) && settledAt(s.at(-1));
    };
    const overlap = (r, a, b) => r.frames.some((f) => f[a] != null && f[b] != null);
    await h.shot("cdp-shots/motion-brainstorm-3-question-5.png");
    rec(
        "3. question 4 -> working -> question 5: each step leaves to the left while fading, the next mounts at opacity 0 right of its place and settles; two steps never show at once",
        toWorking.done &&
            leaves(toWorking, "next") &&
            arrives(toWorking, "working") &&
            !overlap(toWorking, "next", "working") &&
            toQ5.done &&
            leaves(toQ5, "working") &&
            arrives(toQ5, "next") &&
            !overlap(toQ5, "next", "working"),
        { toWorking: brief(toWorking), toQ5: brief(toQ5) }
    );

    // 4. under reduced motion the next question replaces the last at once: no fade, no slide, no overlap
    await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    let reduced;
    try {
        await polishNap(300);
        reduced = await talkStep(
            h,
            ctx,
            Q6,
            TALK_SAMPLE(Q6.question.text),
            `(n) => !!n.querySelector?.("[data-brainstorm-question]")`,
            `(() => { const q = ${BS_PANE}?.querySelector("[data-brainstorm-question]"); return !!q && q.innerText.includes(${JSON.stringify(Q6.question.text)}); })()`
        );
    } finally {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
    }
    const nexts = seen(reduced.frames, "next");
    rec(
        "4. reduced motion: question 6 lands at full opacity with no transform in every frame, and question 5 never fades or shares a frame with it",
        reduced.done &&
            nexts.length > 0 &&
            nexts.every(settledAt) &&
            seen(reduced.frames, "old").every(settledAt) &&
            !overlap(reduced, "next", "old"),
        brief(reduced)
    );

    // 5. the builder check: one more call the agent decided rolls the rail's count
    bsWrite(ctx, BS_HANDOFF);
    const DECIDED = `${BS_PANE}?.querySelector('[data-brainstorm-check-rail] section[aria-label="The agent decided"] h3')`;
    const checkDrawn = await polishWaitFor(
        h,
        `(${DECIDED}?.querySelector(".tabular-nums")?.textContent ?? "") === "${BS_CHECK.calls.length}"`,
        CHANGE_WAIT_MS
    );
    await polishNap(SETTLE_MS);
    const want = String(BS_CHECK.calls.length + 1);
    const tick = await talkStep(
        h,
        ctx,
        CHECKED,
        `() => {
            const h3 = ${DECIDED};
            return { nums: [...(h3?.querySelectorAll(".tabular-nums > span") ?? [])].map((s) => ({ text: s.innerText, ...st(s) })) };
        }`,
        `(n) => n.matches?.(".tabular-nums > span") && n.innerText === ${JSON.stringify(want)}`,
        `(() => { const s = [...(${DECIDED}?.querySelectorAll(".tabular-nums > span") ?? [])]; return s.length === 1 && s[0].innerText === ${JSON.stringify(want)}; })()`
    );
    const nums = tick.frames.map((f) => f.nums ?? []);
    await h.shot("cdp-shots/motion-brainstorm-5-check-tick.png");
    rec(
        `5. the builder check's "The agent decided" count rolls ${BS_CHECK.calls.length} -> ${want}: the new number mounts transparent, both share a frame, and it settles alone`,
        checkDrawn &&
            tick.done &&
            tick.added.some((a) => a.o === 0) &&
            nums.some((n) => n.length === 2) &&
            nums.at(-1)?.length === 1 &&
            settledAt(nums.at(-1)?.[0]),
        { checkDrawn, ...brief(tick) }
    );
}

async function runSteps(h, run, rec) {
    if (run.ctx.arrangeError != null) return rec("run", null, `could not verify: the fixture run failed: ${run.ctx.arrangeError}`, true);
    const missing = await bsShowFile(h, run.ctx.bs);
    if (missing != null) return rec("run", null, `could not verify: ${missing}`, true);
    const failed = await polishWaitFor(h, `!!${BS_PANE}?.querySelector('[data-brainstorm-run="final-failed"]')`, CHANGE_WAIT_MS);
    // 6. the run landing draws the card's check and the Run phase's, stroke from nothing to whole
    await startFrames(
        h,
        `() => {
            const dash = (el) => (el ? parseFloat(el.getAttribute("stroke-dasharray") ?? "1") : null);
            const run = [...(pane()?.querySelectorAll("[data-brainstorm-phase] li") ?? [])].find((li) => li.innerText.trim() === "Run");
            return {
                card: dash(pane()?.querySelector("[data-brainstorm-run-card] svg path")),
                phase: dash(run?.querySelector("svg path")),
            };
        }`
    );
    await fstWriteRun(h, run.ctx.runId, (r) => ({ ...r, land: { state: "landed", commit: SHA } }));
    const merged = await polishWaitFor(h, `!!${BS_PANE}?.querySelector('[data-brainstorm-run="merged"]')`, CHANGE_WAIT_MS);
    await polishNap(SETTLE_MS);
    const drawn = await stopFrames(h);
    const draws = (key) => {
        const d = seen(drawn.frames, key);
        return d.length > 1 && d[0] < 0.5 && d.at(-1) === 1;
    };
    await h.shot("cdp-shots/motion-brainstorm-6-run-merged.png");
    rec(
        "6. the run merging while shown draws the card's check and the Run phase's check on, from a short stroke to whole",
        failed && merged && draws("card") && draws("phase"),
        { failed, merged, ...brief(drawn) }
    );
}

export const motionBrainstorm = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const talk = await bsArrangeAgent(h, TOPIC, TALK);
        const scenario = brainstormRun(BS_KIT).find((s) => s.name === RUN_SCENARIO);
        const run = { scenario, ctx: await scenario.arrange(h) };
        return { talk, run };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail, skip = false) =>
            steps.push(
                skip
                    ? skipStep(step, detail)
                    : { step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) }
            );
        await talkSteps(h, ctx.talk, rec);
        await runSteps(h, ctx.run, rec);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
        await h.ev(`window.__motionBs?.mo?.disconnect()`).catch(() => {});
        if (ctx?.talk) await bsTeardownAgent(h, ctx.talk, NAME);
        if (ctx?.run?.ctx) await ctx.run.scenario.teardown(h, ctx.run.ctx);
    },
};
