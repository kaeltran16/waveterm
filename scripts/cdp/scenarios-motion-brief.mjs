// motion-brief: the motion sweep's moments on the initiative brief's pages
// (docs/superpowers/plans/2026-11-10-motion-sweep.md, Task 6): Behind you's Shipped count and kind filter, the
// record peek's disclosures, runs table and inline confirm, a Runs row's Answer, Stop and chunk label, and the detail
// sheet's face swap and launch states.
// The data is brief-peek's arrange (a project with one deferred run, reloaded into the Brief) and the briefing
// fixtures; brief-peek's teardown removes it.
import { briefPeek } from "./scenarios-brief.mjs";
import { failRpc, holdRpc, lookEval, polishNap, polishWaitFor, releaseRpc, setInputExpr, setPageRoster } from "./scenarios-shared.mjs";

const BEHIND = `document.querySelector('[data-jarvis-brief-region="behind"]')`;
const SHIPPED_LABEL = "Shipped · 7 days";
// the Shipped head's count: the TickNumber after the label
const TICK = `[...(${BEHIND}?.querySelectorAll('span') ?? [])].find((s) => s.textContent === ${JSON.stringify(SHIPPED_LABEL)})?.nextElementSibling`;
const KIND = (k) => `${BEHIND}?.querySelector('[data-jarvis-run-kind] [data-filter-option="${k}"]')`;
const BAND = '[data-jarvis-brief-band="peek"]';
const SHEET = "[data-jarvis-brief-sheet]";
const RECORD_ID = "verify-motion-brief-record";
const LAUNCH_ERROR = "verify motion-brief: the launch was refused";
// long enough to clamp: the peek shows four lines and a show-full link past BODY_CLAMP_CHARS
const OBJECTIVE = `A record whose objective runs long. ${"Its body keeps going so the clamp has something to hold back. ".repeat(24)}`;
const DECISION = (n) => ({
    id: `verify-motion-brief-decision-${n}`,
    created: Date.now() - n * 60_000,
    actor: "human",
    provenance: "",
    status: "",
    links: [],
    rationale: "So the decisions disclosure has rows to reveal.",
    summary: `verify motion-brief: decision ${n}`,
});
const DETAIL = {
    id: RECORD_ID,
    ticket: "",
    objective: OBJECTIVE,
    acceptance: [],
    confidence: "",
    status: "active",
    created: 0,
    updated: 0,
    state: "",
    blockers: [],
    refs: [],
    notes: "",
    decisions: [DECISION(1), DECISION(2), DECISION(3)],
};

// Records, for each node added under the page that `match` picks, its computed opacity and transform at insertion
// (Framer writes a mount's initial values inline before the node is attached), under window.__motionBrief[name].
const watch = (name, match) => `(() => {
    const all = (window.__motionBrief ??= {});
    all[${JSON.stringify(name)}]?.obs.disconnect();
    const seen = [];
    const match = ${match};
    const obs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            const hit = match(n);
            if (hit) {
                const cs = getComputedStyle(hit);
                seen.push({ opacity: cs.opacity, transform: cs.transform, text: (hit.textContent || '').trim().slice(0, 60) });
            }
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    all[${JSON.stringify(name)}] = { obs, seen };
})()`;
const seen = (name) => `(() => {
    const w = window.__motionBrief?.[${JSON.stringify(name)}];
    w?.obs.disconnect();
    return w?.seen ?? [];
})()`;
// a mount watched at insertion: transparent, then settled opaque
const fadedIn = (first, settled) => first?.opacity === "0" && settled === "1";
const NO_TRANSFORM = (t) => t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)";

async function behindSteps(h, rec) {
    // the initiatives fixture ships three runs: one orchestrator, two quick
    await h.ev(`document.querySelector('[data-briefing-fixture="initiatives"]')?.click()`);
    // the fixture swap redraws the Brief's regions, so the steps start from one settled Behind you
    const shown = await polishWaitFor(
        h,
        `document.querySelectorAll('[data-jarvis-brief-region="behind"]').length === 1 && ${KIND("quick")} != null && (${TICK})?.textContent === "3"`,
        6000
    );
    await polishNap(900);
    await h.ev(`${BEHIND}?.scrollIntoView({ block: "center" })`);
    await polishNap(300);
    const mount = await h.ev(`(() => {
        const tick = ${TICK};
        const list = ${BEHIND}?.querySelector('[data-view-swap]');
        return { text: tick?.textContent ?? null, list: list ? getComputedStyle(list).opacity : null, swap: list?.dataset.viewSwap ?? null };
    })()`);
    rec(
        "1. the Brief mounts with Shipped's count and list drawn as they are, nothing fading",
        shown && mount.text === "3" && mount.list === "1" && mount.swap === "all",
        mount
    );

    // 2. picking quick: the list fades in and the count rolls 3 -> 2, the old value leaving while the new arrives
    await h.ev(watch("list", `(n) => n.matches('[data-view-swap="quick"]') ? n : null`));
    await h.ev(watch("tick", `(n) => { const t = ${TICK}; return t != null && n.parentElement === t ? n : null; }`));
    const roll = await h.ev(`(async () => {
        ${KIND("quick")}?.click();
        // every frame for a while: one fixed sample can land before a slow first render starts the roll
        const end = performance.now() + 300;
        let mid = [];
        while (performance.now() < end) {
            const spans = [...(${TICK}?.querySelectorAll('span.inline-block') ?? [])];
            mid = spans.map((s) => ({ text: s.textContent, opacity: Number(getComputedStyle(s).opacity) }));
            if (mid.some((s) => s.text === "3" && s.opacity < 1)) break;
            await new Promise((r) => requestAnimationFrame(r));
        }
        return { mid };
    })()`);
    await polishNap(600);
    const list = await h.ev(seen("list"));
    const tick = await h.ev(seen("tick"));
    const settled = await h.ev(`(() => {
        const tick = ${TICK};
        const list = ${BEHIND}?.querySelector('[data-view-swap]');
        return {
            text: tick?.textContent ?? null,
            spans: tick?.querySelectorAll('span.inline-block').length ?? 0,
            list: list ? getComputedStyle(list).opacity : null,
            swap: list?.dataset.viewSwap ?? null,
        };
    })()`);
    const midOld = roll.mid.find((s) => s.text === "3");
    rec(
        "2. picking quick fades the Shipped list in and rolls the count 3 -> 2, the old value still leaving mid-roll",
        fadedIn(list[0], settled.list) &&
            settled.swap === "quick" &&
            tick.some((t) => t.text === "2" && t.opacity === "0") &&
            midOld != null &&
            midOld.opacity < 1 &&
            settled.text === "2" &&
            settled.spans === 1,
        { list, tick, roll, settled }
    );
    await h.shot("cdp-shots/motion-brief-shipped.png");

    // 3. reduced motion: the count lands at once as plain text, no roll
    await h.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await polishNap(300);
    await h.ev(watch("tickReduced", `(n) => { const t = ${TICK}; return t != null && t.contains(n) && n !== t ? n : null; }`));
    const reduced = await h.ev(`(async () => {
        ${KIND("orchestrator")}?.click();
        await new Promise((r) => setTimeout(r, 40));
        const tick = ${TICK};
        return { text: tick?.textContent ?? null, children: tick?.children.length ?? null };
    })()`);
    await polishNap(300);
    const reducedAdds = await h.ev(seen("tickReduced"));
    await h.cdp("Emulation.setEmulatedMedia", { features: [] });
    rec(
        "3. under reduced motion the count lands at 1 within a frame, as plain text with no rolling copy",
        reduced.text === "1" && reduced.children === 0 && reducedAdds.length === 0,
        { reduced, reducedAdds }
    );
    await h.ev(`${KIND("all")}?.click()`);
    await polishNap(300);
}

async function peekSteps(h, rec) {
    // the record's runs held loading, so the read landing is a swap the peek is on screen for
    await holdRpc(h, "ResolveFocusScopeCommand");
    const hook = await polishWaitFor(h, `typeof window.__recordPeekFor === 'function'`, 5000);
    if (hook) await h.ev(`window.__recordPeekFor(${JSON.stringify(RECORD_ID)}, { detail: ${JSON.stringify(DETAIL)} })`);
    const ready = hook && (await polishWaitFor(h, `document.querySelector('${BAND} [data-jarvis-peek-runs-loading]') != null`, 6000));
    await polishNap(500);

    // 4. the runs read landing: the table's height follows the skeleton down to the absence line, which fades in
    const TABLE = `document.querySelector('${BAND} [data-view-swap]')?.parentElement?.parentElement`;
    const before = await h.ev(`Math.round(${TABLE}?.getBoundingClientRect().height ?? 0)`);
    await h.ev(watch("runs", `(n) => n.matches('${BAND} [data-view-swap="absent"]') ? n : null`));
    await releaseRpc(h, "ResolveFocusScopeCommand");
    const midHeight = await lookEval(h, `
        const S = await mod("app/view/jarvis/jarvissubjectstore.ts");
        await S.reloadRecordScope(${JSON.stringify(RECORD_ID)}).catch(() => {});
        await nap(90);
        return Math.round(${TABLE}?.getBoundingClientRect().height ?? 0);
    `).catch((e) => String(e?.message ?? e));
    await polishNap(700);
    const runs = await h.ev(seen("runs"));
    const after = await h.ev(`(() => {
        const swap = document.querySelector('${BAND} [data-view-swap]');
        return {
            swap: swap?.dataset.viewSwap ?? null,
            opacity: swap ? getComputedStyle(swap).opacity : null,
            height: Math.round(${TABLE}?.getBoundingClientRect().height ?? 0),
        };
    })()`);
    rec(
        "4. the runs read landing shrinks the table from the skeleton to the absence line and fades that line in",
        ready &&
            fadedIn(runs[0], after.opacity) &&
            after.swap === "absent" &&
            before > after.height &&
            typeof midHeight === "number" &&
            midHeight < before &&
            midHeight > after.height,
        { ready, before, midHeight, after, runs }
    );

    // 5. Show the full objective: the clamp lifts and the body's height grows to the whole text over the macro
    const BODY_BOX = `document.querySelector('${BAND} [data-jarvis-peek-body]')?.parentElement?.parentElement`;
    const clamped = await h.ev(`Math.round(${BODY_BOX}?.getBoundingClientRect().height ?? 0)`);
    const grow = await h.ev(`(async () => {
        document.querySelector('${BAND} [data-jarvis-peek-body-toggle]')?.click();
        await new Promise((r) => setTimeout(r, 100));
        const mid = Math.round(${BODY_BOX}?.getBoundingClientRect().height ?? 0);
        await new Promise((r) => setTimeout(r, 600));
        return { mid, full: Math.round(${BODY_BOX}?.getBoundingClientRect().height ?? 0) };
    })()`);
    rec(
        "5. showing the full objective grows its height from the clamp to the whole text, passing through between",
        clamped > 0 && grow.full > clamped && grow.mid > clamped && grow.mid < grow.full,
        { clamped, grow }
    );

    // 6. the decisions disclosure reveals from transparent, and on close fades while still attached, then leaves
    const PANE = `document.querySelector('${BAND} [data-jarvis-peek-decision-log]')?.parentElement`;
    await h.ev(watch("log", `(n) => n.querySelector?.(':scope > [data-jarvis-peek-decision-log]') ? n : null`));
    await h.ev(`document.querySelector('${BAND} [data-jarvis-peek-decisions]')?.click()`);
    await polishNap(600);
    const opened = await h.ev(seen("log"));
    const openOpacity = await h.ev(`(() => { const p = ${PANE}; return p ? getComputedStyle(p).opacity : null; })()`);
    await h.shot("cdp-shots/motion-brief-decisions.png");
    const closed = await h.ev(`(async () => {
        const pane = ${PANE};
        document.querySelector('${BAND} [data-jarvis-peek-decisions]')?.click();
        await new Promise((r) => setTimeout(r, 100));
        const mid = { attached: pane?.isConnected ?? false, opacity: pane ? Number(getComputedStyle(pane).opacity) : null };
        await new Promise((r) => setTimeout(r, 600));
        return { mid, goneAfter: pane != null && !pane.isConnected };
    })()`);
    rec(
        "6. the decisions log reveals from opacity 0 to 1, and closing fades it out attached before removing it",
        fadedIn(opened[0], openOpacity) &&
            closed.mid.attached &&
            closed.mid.opacity > 0 &&
            closed.mid.opacity < 1 &&
            closed.goneAfter,
        { opened, openOpacity, closed }
    );

    // 7. a terminal pick's confirm arrives washed once, so it reads as the answer to the click
    const flash = await h.ev(`(async () => {
        document.querySelector('${BAND} [data-jarvis-peek-status="archived"]')?.click();
        await new Promise((r) => setTimeout(r, 120));
        const c = document.querySelector('${BAND} [data-jarvis-peek-confirm]');
        const during = c ? getComputedStyle(c).animationName : null;
        await new Promise((r) => setTimeout(r, 1500));
        return { during, after: c ? getComputedStyle(c).animationName : null, still: c?.isConnected ?? false };
    })()`);
    rec(
        "7. the inline confirm arrives with the change-flash wash, which ends after its hold",
        flash.during === "changeFlash" && flash.after === "none" && flash.still,
        flash
    );
    await h.ev(
        `[...(document.querySelector('${BAND} [data-jarvis-peek-confirm]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'Cancel')?.click()`
    );
    await h.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`);
    await polishWaitFor(h, `!document.querySelector('${BAND}')`, 3000);
}

// the arranged run's Runs row, found by the line its RunRowView draws
const RUN_ROW = (runId) => `[...document.querySelectorAll('[data-jarvis-brief-region="sessions"] [data-jarvis-brief-row="session"]')].find((r) => {
    const k = Object.keys(r).find((k) => k.startsWith("__reactFiber$"));
    for (let f = k ? r[k] : null; f; f = f.return) if (f.memoizedProps?.line?.runOid) return f.memoizedProps.line.runOid === ${JSON.stringify(runId)};
    return false;
})`;
const ASKER_ID = "fx-motion-brief-asker";
const FX_EFFORT = "fx-motion-brief-effort";
const FX_EFFORT_TITLE = "verify motion-brief initiative";
// page-side lib for the run row steps: the run's cached wave object and a writer that patches it in place
const RUN_LIB = (runId) => `
    const { globalStore } = await mod("app/store/jotaiStore.ts");
    const WOS = await mod("app/store/wos.ts");
    const ref = WOS.makeORef("run", ${JSON.stringify(runId)});
    const patch = (fn) => WOS.setObjectValue(fn(WOS.getObjectValue(ref)));
    const row = () => ${RUN_ROW(runId)};
    const btn = (re) => [...(row()?.querySelectorAll("button") ?? [])].find((b) => re.test((b.textContent || "").trim()));
    // every frame until the button leaves or the time runs out: whether it was attached part way through its fade
    const sampleExit = async (el, ms) => {
        const out = [];
        const end = performance.now() + ms;
        while (performance.now() < end && el?.isConnected) {
            out.push(Number(getComputedStyle(el).opacity));
            await new Promise((r) => requestAnimationFrame(r));
        }
        return { mid: out.some((o) => o > 0 && o < 1), samples: out.length, goneAfter: el != null && !el.isConnected };
    };
`;

async function runRowSteps(h, rec, ctx) {
    if (ctx.arrangeError != null || ctx.runId == null) {
        rec("8. a run row's Stop fades out and back in", false, ctx.arrangeError ?? "arrange made no run");
        return;
    }
    // the arranged run is live data: the fixture behindSteps picked would hide it
    await lookEval(h, `
        const { briefingFixtureAtom, refreshBriefing } = await mod("app/view/jarvis/briefingstore.ts");
        (await mod("app/store/jotaiStore.ts")).globalStore.set(briefingFixtureAtom, null);
        refreshBriefing();
    `);
    const found = await polishWaitFor(h, `${RUN_ROW(ctx.runId)}?.querySelector('button[title="Stop this session"]') != null`, 20000);
    await h.ev(`${RUN_ROW(ctx.runId)}?.scrollIntoView({ block: "center" })`);
    await polishNap(600);

    // 8. the run ending takes Stop out with a fade, attached part way; the run back in planning fades it in from 0
    const stopOut = await lookEval(h, `${RUN_LIB(ctx.runId)}
        const stop = btn(/^Stop$/);
        patch((r) => ({ ...r, status: "cancelled" }));
        return await sampleExit(stop, 800);
    `);
    await h.ev(watch("stop", `(n) => n.matches?.('button[title="Stop this session"]') && ${RUN_ROW(ctx.runId)}?.contains(n) ? n : null`));
    await lookEval(h, `${RUN_LIB(ctx.runId)} patch((r) => ({ ...r, status: "planning" }));`);
    await polishNap(500);
    const stopAdds = await h.ev(seen("stop"));
    const stopSettled = await h.ev(
        `(() => { const b = ${RUN_ROW(ctx.runId)}?.querySelector('button[title="Stop this session"]'); return b ? getComputedStyle(b).opacity : null; })()`
    );
    rec(
        "8. a run ending fades its Stop out while still attached, then removes it; back in planning, Stop fades in from 0",
        found && stopOut.mid && stopOut.goneAfter && fadedIn(stopAdds[0], stopSettled),
        { found, stopOut, stopAdds, stopSettled }
    );

    // 9. the run's worker starting to ask brings Answer in from 0; the ask answered fades it out attached, then removes it
    const asker = (state) => ({
        id: ASKER_ID,
        name: "motion-brief asker",
        task: "the arranged run's worker",
        project: "verify-motion-brief",
        agent: "claude",
        model: "sonnet",
        state,
        runId: ctx.runId,
        blockId: "fx-blk-motion-brief-asker",
    });
    await h.ev(watch("answer", `(n) => n.matches?.('button') && n.textContent.trim() === 'Answer' && ${RUN_ROW(ctx.runId)}?.contains(n) ? n : null`));
    await lookEval(h, `${RUN_LIB(ctx.runId)}
        patch((r) => ({ ...r, phases: (r.phases?.length ? r.phases : [{}]).map((p, i) => (i === 0 ? { ...p, workerorefs: ["tab:${ASKER_ID}"] } : p)) }));
    `);
    await setPageRoster(h, [asker("asking")]);
    await polishNap(500);
    const answerAdds = await h.ev(seen("answer"));
    const answerSettled = await h.ev(`(() => {
        const b = [...(${RUN_ROW(ctx.runId)}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Answer");
        return b ? getComputedStyle(b).opacity : null;
    })()`);
    await h.shot("cdp-shots/motion-brief-run-answer.png");
    const answerOut = await lookEval(h, `${RUN_LIB(ctx.runId)}
        const answer = btn(/^Answer$/);
        const D = await mod("app/view/agents/devmock.ts");
        globalStore.set(D.devMockAgentsAtom, ${JSON.stringify([asker("working")])});
        return await sampleExit(answer, 800);
    `);
    rec(
        "9. the run's worker asking fades Answer in from 0; the ask ending fades it out while still attached, then removes it",
        fadedIn(answerAdds[0], answerSettled) && answerOut.mid && answerOut.goneAfter,
        { answerAdds, answerSettled, answerOut }
    );

    // 10. the run moving to another chunk washes its chunk label once, and the wash ends after its hold
    const flash = await lookEval(h, `${RUN_LIB(ctx.runId)}
        const { briefEffortIndexAtom } = await mod("app/view/jarvis/jarvisstore.ts");
        // the Brief republishes the index whenever its projection recomputes (any roster or snapshot change), so the
        // fixture effort is put back each time it is dropped, until restoreRunRow stops it
        const entry = { oref: "effort:${FX_EFFORT}", title: ${JSON.stringify(FX_EFFORT_TITLE)}, chunkStages: { "mb-a": "Alpha", "mb-b": "Beta" }, ticket: "" };
        const hold = () => {
            const cur = globalStore.get(briefEffortIndexAtom);
            if (cur.get(${JSON.stringify(FX_EFFORT)}) !== entry) globalStore.set(briefEffortIndexAtom, new Map(cur).set(${JSON.stringify(FX_EFFORT)}, entry));
        };
        window.__motionBriefIndexHold?.();
        window.__motionBriefIndexHold = globalStore.sub(briefEffortIndexAtom, hold);
        hold();
        patch((r) => ({ ...r, effortref: { effortoid: ${JSON.stringify(FX_EFFORT)}, chunklabel: "mb-a" } }));
        const chunk = () => row()?.querySelector('button[title="Open this chunk"]');
        // the hold the wash lasts, read from the token module so the step follows it
        const { CHANGE_FLASH_MS } = await mod("app/element/motiontokens.ts");
        await until(() => chunk() != null, 3000);
        // the link itself is a change; let its wash end so the move is the one measured
        await nap(CHANGE_FLASH_MS + 300);
        const before = { text: flat(chunk()), animation: chunk() ? getComputedStyle(chunk()).animationName : null };
        patch((r) => ({ ...r, effortref: { effortoid: ${JSON.stringify(FX_EFFORT)}, chunklabel: "mb-b" } }));
        await nap(120);
        const during = { text: flat(chunk()), animation: chunk() ? getComputedStyle(chunk()).animationName : null };
        await nap(CHANGE_FLASH_MS + 300);
        return { before, during, after: chunk() ? getComputedStyle(chunk()).animationName : null };
    `);
    await h.shot("cdp-shots/motion-brief-run-chunk.png");
    rec(
        "10. the run moving from one chunk to another washes the chunk label with changeFlash, then the wash ends",
        flash.before.animation === "none" &&
            flash.before.text.endsWith("Alpha") &&
            flash.during.text.endsWith("Beta") &&
            flash.during.animation === "changeFlash" &&
            flash.after === "none",
        flash
    );
    await restoreRunRow(h, ctx);
}

// the run's wave object back from the server, the roster back to live, the brief's effort index without the fixture
async function restoreRunRow(h, ctx) {
    if (ctx.runId == null) return;
    await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const WOS = await mod("app/store/wos.ts");
        const D = await mod("app/view/agents/devmock.ts");
        const { briefEffortIndexAtom } = await mod("app/view/jarvis/jarvisstore.ts");
        window.__motionBriefIndexHold?.();
        delete window.__motionBriefIndexHold;
        globalStore.set(D.devMockAgentsAtom, null);
        const index = new Map(globalStore.get(briefEffortIndexAtom));
        if (index.delete(${JSON.stringify(FX_EFFORT)})) globalStore.set(briefEffortIndexAtom, index);
        await WOS.reloadWaveObject(WOS.makeORef("run", ${JSON.stringify(ctx.runId)}));
    `);
}

async function sheetSteps(h, rec, ctx) {
    if (ctx.arrangeError != null || ctx.runId == null) {
        rec("11. the sheet's face swap fades the launcher in", false, ctx.arrangeError ?? "arrange made no run");
        return;
    }
    await h.ev(`window.__openAddress?.(${JSON.stringify(`run:${ctx.runId}`)})`);
    const NEW_RUN = `[...(document.querySelector('${SHEET}')?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === 'New run')`;
    const onRun = await polishWaitFor(h, `${NEW_RUN} != null && document.querySelector('${SHEET} [data-view-swap="run"]') != null`, 10000);
    await polishNap(600);

    // 11. New run trades the run's body for the launcher: the launcher fades in rather than cutting
    await h.ev(watch("face", `(n) => n.matches('${SHEET} [data-view-swap="launcher"]') ? n : null`));
    await h.ev(`${NEW_RUN}?.click()`);
    const onLauncher = await polishWaitFor(h, `document.querySelector('[data-jarvis-launch-goal]') != null`, 5000);
    await polishNap(500);
    const face = await h.ev(seen("face"));
    const faceSettled = await h.ev(
        `(() => { const f = document.querySelector('${SHEET} [data-view-swap="launcher"]'); return f ? getComputedStyle(f).opacity : null; })()`
    );
    rec(
        "11. New run swaps the sheet's face from the run to the launcher, fading it in from 0",
        onRun && onLauncher && fadedIn(face[0], faceSettled),
        { onRun, onLauncher, face, faceSettled }
    );
    await h.shot("cdp-shots/motion-brief-launcher.png");

    // 12. a refused launch: the error strip reveals and the line nudges once, then rests
    await lookEval(h, `
        const { globalStore } = await mod("app/store/jotaiStore.ts");
        const C = await mod("app/view/agents/runconfigstore.ts");
        globalStore.set(C.routeTouchedAtom, true);
        globalStore.set(C.runRouteAtom, { runtime: "claude" });
    `);
    await h.ev(setInputExpr(`document.querySelector('[data-jarvis-launch-goal]')`, "verify motion-brief: refused"));
    await failRpc(h, "CreateRunCommand", LAUNCH_ERROR);
    const RUN_BTN = `document.querySelector('[data-jarvis-launch-goal]')?.nextElementSibling`;
    await h.ev(watch("error", `(n) => n.querySelector?.('[data-jarvis-brief-sheet-state="error"]') ? n : null`));
    const nudge = await h.ev(`(async () => {
        const btn = ${RUN_BTN};
        const disabled = btn?.disabled ?? null;
        btn?.click();
        const samples = [];
        for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 30));
            const p = document.querySelector('${SHEET} [data-jarvis-brief-sheet-state="error"]');
            if (p) samples.push(getComputedStyle(p).transform);
        }
        return { disabled, samples };
    })()`);
    await polishNap(500);
    const errorAdds = await h.ev(seen("error"));
    const rest = await h.ev(`(() => {
        const p = document.querySelector('${SHEET} [data-jarvis-brief-sheet-state="error"]');
        return {
            text: (p?.textContent || '').trim(),
            transform: p ? getComputedStyle(p).transform : null,
            strip: p ? getComputedStyle(p.parentElement).opacity : null,
            button: (${RUN_BTN}?.textContent || '').trim(),
        };
    })()`);
    await releaseRpc(h, "CreateRunCommand");
    rec(
        "12. a refused launch reveals the error strip from 0 and nudges the line along x once, then it rests",
        nudge.disabled === false &&
            fadedIn(errorAdds[0], rest.strip) &&
            nudge.samples.some((t) => !NO_TRANSFORM(t)) &&
            rest.text.includes(LAUNCH_ERROR) &&
            NO_TRANSFORM(rest.transform) &&
            rest.button === "Run ⏎",
        { nudge, errorAdds, rest }
    );
    await h.shot("cdp-shots/motion-brief-launch-error.png");

    // 13. a retry: Run cross-fades to Starting..., and the old error strip collapses attached before it leaves
    await holdRpc(h, "CreateRunCommand");
    await h.ev(watch("starting", `(n) => n.matches('[data-crossfade="starting"]') ? n : null`));
    const retry = await h.ev(`(async () => {
        const strip = document.querySelector('${SHEET} [data-jarvis-brief-sheet-state="error"]')?.parentElement;
        ${RUN_BTN}?.click();
        await new Promise((r) => setTimeout(r, 60));
        const mid = { attached: strip?.isConnected ?? false, opacity: strip ? Number(getComputedStyle(strip).opacity) : null };
        await new Promise((r) => setTimeout(r, 500));
        const label = document.querySelector('[data-crossfade="starting"]');
        return {
            mid,
            goneAfter: strip != null && !strip.isConnected,
            button: (${RUN_BTN}?.textContent || '').trim(),
            label: label ? getComputedStyle(label).opacity : null,
        };
    })()`);
    const starting = await h.ev(seen("starting"));
    rec(
        "13. a retry cross-fades Run to Starting… and collapses the old error while it is still attached",
        fadedIn(starting[0], retry.label) &&
            retry.button === "Starting…" &&
            retry.mid.attached &&
            retry.mid.opacity > 0 &&
            retry.mid.opacity < 1 &&
            retry.goneAfter,
        { starting, retry }
    );
    await releaseRpc(h, "CreateRunCommand");
}

export const motionBrief = {
    name: "motion-brief",
    surface: "jarvis",
    async arrange(h) {
        return briefPeek.arrange(h);
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });
        await h.goto("jarvis");
        await polishNap(700);
        await behindSteps(h, rec);
        await peekSteps(h, rec);
        await runRowSteps(h, rec, ctx);
        await sheetSteps(h, rec, ctx);
        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`motion-brief teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        await step("reset the media emulation", () => h.cdp("Emulation.setEmulatedMedia", { features: [] }));
        await step("release the launch", () => releaseRpc(h, "CreateRunCommand"));
        await step("put the run row back", () => restoreRunRow(h, ctx));
        await step("close the sheet", () =>
            h.ev(`document.querySelector('button[aria-label="Close detail sheet"]')?.click()`)
        );
        await step("return the brief to its normal fixture", () =>
            h.ev(`document.querySelector('[data-briefing-fixture="normal"]')?.click()`)
        );
        await briefPeek.teardown(h, ctx);
    },
};
