// motion-diff: the motion sweep's moments on the Diff surface and Settings > Storage
// (docs/superpowers/plans/2026-11-10-motion-sweep.md, Task 11). The review marks run on diff-review-marks' seeded
// repo, history and the failure panel on git-history's three projects (good, broken, plain), storage on the DEV
// mock settings-storage drives. Every moment is read in-page in one evaluation, because a CDP round trip per sample
// is slower than the fade it measures: an observer reads the opacity a node is added with (motion-gaps), a frame
// sampler what moves while it moves (dag-motion).

import { diffReviewMarks, gitHistory } from "./scenarios-files.mjs";
import { lookEval, polishNap, polishWaitFor } from "./scenarios-shared.mjs";

const REDUCE = { features: [{ name: "prefers-reduced-motion", value: "reduce" }] };
const NO_MEDIA = { features: [] };
// a fade or reveal mounts at (near) 0 and settles at 1; read this long after the change, past durMacro
const SETTLE_MS = 700;
// inside durExit (280ms): an exit is still attached and mid-fade
const MID_EXIT_MS = 110;
const MOUNTED_HIDDEN = 0.1;
// barFillClass's duration (durMacro)
const BAR_MS = "0.36s";

const MOTION_LIB = `
    const opacity = (el) => (el ? Number(getComputedStyle(el).opacity) : null);
    // the opacity each node pick(n) returns has as it is added, in order
    const watchAdded = (pick) => {
        const seen = [];
        const obs = new MutationObserver((muts) => {
            for (const m of muts) for (const n of m.addedNodes) {
                const hit = n instanceof Element ? pick(n) : null;
                if (hit) seen.push(Number(getComputedStyle(hit).opacity));
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        return { seen, stop: () => obs.disconnect() };
    };
    // every distinct value read() takes, one read per frame, until stop()
    const sampleFrames = (read) => {
        const values = [];
        let on = true;
        const tick = () => {
            const v = read();
            if (v != null && v !== values.at(-1)) values.push(v);
            if (on) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return { values, stop: () => (on = false) };
    };
    // a nudge moved x if any sampled transform is a translation off zero
    const moved = (values) => values.some((v) => v !== "none" && !/^matrix\\(1, 0, 0, 1, 0, 0\\)$/.test(v));
    const q = (sel) => document.querySelector(sel);
    const pick = async (name, readySel) => {
        q("[data-files-source-picker]")?.click();
        const opt = '[data-files-source-option=' + JSON.stringify(name) + ']';
        await until(() => q(opt) != null, 4000);
        q(opt)?.click();
        return until(() => q(readySel) != null, 15000);
    };
`;
const motionEval = (h, body) => lookEval(h, `${MOTION_LIB} ${body}`);

// answers githistory in the page with a canned value after a beat, every other command as before. The beat: an
// answer in the same tick as Retry's own clear would batch into one render, and the panel would never remount.
const STUB_BEAT_MS = 150;
const HISTORY_OK = { isrepo: true, head: "", commits: [] };
const HISTORY_FAILED = {
    ...HISTORY_OK,
    failure: { command: "git log --stubbed", exitcode: 128, stderr: "fatal: stubbed history failure" },
};
// answerExpr: a page-side expression, for an answer built from what the page holds (the folded-lanes graph)
const stubHistoryExpr = (answerExpr) => `(() => {
    const c = window.TabRpcClient;
    if (!c.__mdStubOrig) c.__mdStubOrig = c.wshRpcCall;
    const call = c.__mdStubOrig.bind(c);
    const answer = ${answerExpr};
    c.wshRpcCall = (command, data, opts) =>
        command === "githistory" ? new Promise((r) => setTimeout(() => r(answer), ${STUB_BEAT_MS})) : call(command, data, opts);
})();`;
const stubHistory = (answer) => stubHistoryExpr(JSON.stringify(answer));
// holds every githistory call until window.__mdHistoryRelease(answer), so a step reads the in-flight state
const HOLD_HISTORY = `(() => {
    const c = window.TabRpcClient;
    if (!c.__mdStubOrig) c.__mdStubOrig = c.wshRpcCall;
    const call = c.__mdStubOrig.bind(c);
    c.wshRpcCall = (command, data, opts) =>
        command === "githistory" ? new Promise((r) => (window.__mdHistoryRelease = r)) : call(command, data, opts);
})();`;
// one merge whose parents each take a lane, so past historypane's drawable lanes the rest fold. Built in the page
// (needs S and hs in scope) with the head the column already holds: the change-list poll re-reads the history when
// HEAD moves, which would race the stub.
const wideHistory = (lanes) => `(() => {
    const ts = Date.now();
    const commit = (hash, parents, subject) => ({ hash, parents, author: "verify", email: "verify@example.invalid", ts, subject });
    const tips = Array.from({ length: ${lanes} }, (_, i) => "f01d" + String(i).padStart(36, "0"));
    return {
        isrepo: true,
        head: S.globalStore.get(hs.historyHeadAtom),
        commits: [commit("f01d" + "f".repeat(36), tips, "merge ${lanes} lanes"), ...tips.map((t, i) => commit(t, [], "lane " + i))],
    };
})()`;
// historypane's MAX_LANES
const DRAWABLE_LANES = 7;
const FOLDED_FROM = 2;
const FOLDED_TO = 3;
const UNSTUB_HISTORY = `(() => {
    const c = window.TabRpcClient;
    if (c?.__mdStubOrig) { c.wshRpcCall = c.__mdStubOrig; delete c.__mdStubOrig; }
})();`;

const fadedIn = (r) => r != null && r.first != null && r.first < MOUNTED_HIDDEN && r.settled === 1;

export const motionDiff = {
    name: "motion-diff",
    surface: "files",
    async arrange(h) {
        // diff-review-marks reloads the app for fresh mark state, so it goes first
        const review = await diffReviewMarks.arrange(h);
        const history = await gitHistory.arrange(h);
        return { review, history };
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: JSON.stringify(detail) });
        const D = JSON.stringify;
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("files");
        await polishNap(400);

        try {
            // --- review marks: the count rolls, the bar eases, the last mark draws its check ---------------------
            const marked = await motionEval(h, `
                const picked = await pick(${D(ctx.review.name)}, '[data-changed-file-row="src/retry/backoff.go"]');
                await until(() => q("[data-files-reviewed]")?.dataset.done === "0", 4000);
                const tick = watchAdded((n) => (n.closest?.("[data-files-reviewed]") && n.classList?.contains("inline-block") ? n : null));
                q('[data-review-toggle="README.md"]')?.click();
                await nap(${SETTLE_MS});
                tick.stop();
                const fill = q("[data-files-reviewed] .bg-accent");
                return {
                    picked,
                    done: q("[data-files-reviewed]")?.dataset.done,
                    tick: tick.seen,
                    text: q("[data-files-reviewed]")?.textContent,
                    barMs: fill ? getComputedStyle(fill).transitionDuration : null,
                };
            `);
            rec(
                "1. a mark rolls the reviewed count (the new value rises in from opacity 0) and the bar eases its width",
                marked.picked && marked.done === "1" && marked.tick.length >= 1 && marked.tick[0] < 1 &&
                    marked.text.includes("1/4 reviewed") && marked.barMs === BAR_MS,
                marked
            );

            const drawn = await motionEval(h, `
                const dash = sampleFrames(() => q("[data-files-reviewed] svg path")?.getAttribute("stroke-dasharray") ?? null);
                q('[data-review-toggle-dir="src/retry"]')?.click();
                await until(() => q("[data-files-reviewed]")?.dataset.done === "4", 4000);
                await nap(${SETTLE_MS});
                dash.stop();
                return { done: q("[data-files-reviewed]")?.dataset.done, dash: dash.values, text: q("[data-files-reviewed]")?.textContent };
            `);
            rec(
                "2. the last mark draws the check on (its stroke passes through more than one length)",
                drawn.done === "4" && drawn.dash.length >= 2 && drawn.text.includes("all 4 reviewed"),
                drawn
            );
            await h.shot("cdp-shots/motion-diff-review-all.png");

            // --- a directory folds its rows away and unfolds them -------------------------------------------------
            const folded = await motionEval(h, `
                const dirRow = '[data-changed-dir-row="src/retry"]';
                const leaving = q('[data-changed-file-row="src/retry/policy.go"]');
                q(dirRow)?.click();
                await nap(${MID_EXIT_MS});
                const pane = leaving?.closest(".overflow-hidden");
                const mid = { attached: leaving?.isConnected ?? false, opacity: opacity(pane) };
                await nap(${SETTLE_MS});
                const goneAfter = leaving != null && !leaving.isConnected;
                const w = watchAdded((n) => (n.querySelector?.('[data-changed-file-row="src/retry/policy.go"]') && n.classList.contains("overflow-hidden") ? n : null));
                q(dirRow)?.click();
                await nap(${SETTLE_MS});
                w.stop();
                const back = q('[data-changed-file-row="src/retry/policy.go"]');
                return { mid, goneAfter, first: w.seen[0] ?? null, settled: opacity(back?.closest(".overflow-hidden")) };
            `);
            rec(
                "3. collapsing a directory keeps its rows attached mid-fade, then removes them; expanding fades them in",
                folded.mid.attached && folded.mid.opacity > 0 && folded.mid.opacity < 1 && folded.goneAfter && fadedIn(folded),
                folded
            );

            // --- reduced motion: the count lands with no roll, the check goes at once ------------------------------
            await h.cdp("Emulation.setEmulatedMedia", REDUCE);
            await polishNap(200);
            const reduced = await motionEval(h, `
                const tick = watchAdded((n) => (n.closest?.("[data-files-reviewed]") && n.classList?.contains("inline-block") ? n : null));
                q('[data-review-toggle="README.md"]')?.click();
                await until(() => q("[data-files-reviewed]")?.dataset.done === "3", 3000);
                await new Promise((r) => requestAnimationFrame(r));
                // the count line alone: the progress row also holds the Clear button
                const text = q("[data-files-reviewed] > span:not(:has(button))")?.textContent;
                const check = q("[data-files-reviewed] svg") != null;
                await nap(${SETTLE_MS});
                tick.stop();
                return { text, check, rolled: tick.seen };
            `);
            rec(
                "4. reduced motion: unmarking lands 3/4 in the next frame with no rolling copy, and the check is gone at once",
                reduced.text === "3/4 reviewed" && !reduced.check && reduced.rolled.length === 0,
                reduced
            );
            await h.cdp("Emulation.setEmulatedMedia", NO_MEDIA);
            await polishNap(200);

            // --- a file's pending-comment count ticks; Clear rolls the reviewed count down and eases the bar ------
            const commented = await motionEval(h, `
                const S = await mod("app/store/jotaiStore.ts");
                const dc = await mod("app/view/agents/diffcomments.ts");
                const source = S.globalStore.get(dc.activeCommentSourceAtom);
                if (source == null) return { source: null };
                const had = S.globalStore.get(dc.commentStoreAtom)[source.key];
                const before = new Set((had?.comments ?? []).map((c) => c.id));
                const draft = (note) => ({
                    path: "README.md", side: "modified", start: 1, end: 1, quote: ["# retry"],
                    refs: { original: { kind: "ref", ref: "HEAD" }, modified: { kind: "worktree" } }, note,
                });
                const chip = () => q('[data-changed-file-row="README.md"] [data-changed-file-comments]');
                try {
                    dc.addComment(source, draft("first"));
                    const one = await until(() => chip()?.dataset.changedFileComments === "1", 3000);
                    await nap(${SETTLE_MS});
                    const tick = watchAdded((n) => (n.closest?.("[data-changed-file-comments]") && n.classList?.contains("inline-block") ? n : null));
                    dc.addComment(source, draft("second"));
                    await until(() => chip()?.dataset.changedFileComments === "2", 3000);
                    await nap(${SETTLE_MS});
                    tick.stop();
                    const num = chip()?.querySelector(".inline-block");
                    return { source: source.key, one, tick: tick.seen, count: chip()?.dataset.changedFileComments, text: num?.textContent, settled: opacity(num) };
                } finally {
                    const added = (S.globalStore.get(dc.commentStoreAtom)[source.key]?.comments ?? []).map((c) => c.id).filter((id) => !before.has(id));
                    if (had == null) dc.discardBatch(source.key);
                    else dc.removeComments(source.key, added);
                }
            `);
            rec(
                "4b. a second pending comment on a file rolls its comment count 1 -> 2 (the new value rises in from opacity 0) and lands at 1",
                commented.source != null && commented.one && commented.count === "2" && commented.tick.length >= 1 &&
                    commented.tick[0] < 1 && commented.text === "2" && commented.settled === 1,
                commented
            );

            const cleared = await motionEval(h, `
                const fill = () => q("[data-files-reviewed] .bg-accent");
                const tick = watchAdded((n) => (n.closest?.("[data-files-reviewed]") && n.classList?.contains("inline-block") ? n : null));
                const width = sampleFrames(() => (fill() ? Math.round(fill().getBoundingClientRect().width) : null));
                const from = q("[data-files-reviewed]")?.dataset.done;
                q("[data-review-clear]")?.click();
                await until(() => q("[data-files-reviewed]")?.dataset.done === "0", 3000);
                await nap(${SETTLE_MS});
                tick.stop();
                width.stop();
                return {
                    from,
                    done: q("[data-files-reviewed]")?.dataset.done,
                    tick: tick.seen,
                    widths: width.values,
                    text: q("[data-files-reviewed] > span:not(:has(button))")?.textContent,
                    clearShown: q("[data-review-clear]") != null,
                };
            `);
            const [w0, wEnd] = [cleared.widths[0], cleared.widths.at(-1)];
            rec(
                "4c. Clear rolls the reviewed count down to 0 (the new value rises in from opacity 0), the bar eases to empty through in-between widths, and Clear leaves",
                cleared.from === "3" && cleared.done === "0" && cleared.tick.length >= 1 && cleared.tick[0] < 1 &&
                    cleared.text === "0/4 reviewed" && !cleared.clearShown && w0 > 0 && wEnd === 0 &&
                    cleared.widths.some((w) => w > wEnd && w < w0),
                cleared
            );

            // --- compare: the skeleton shows at once, then the read landing fades the column's rows in ------------
            const compared = await motionEval(h, `
                const viewSel = '[data-compare-column] > [data-view-swap]';
                const rowsSel = '[data-compare-column] > [data-view-swap="rows"]';
                // the column mounts whole, so its first view arrives inside an added subtree, not as the node
                const views = [];
                const obs = new MutationObserver((muts) => {
                    for (const m of muts) for (const n of m.addedNodes) {
                        if (!(n instanceof Element)) continue;
                        for (const hit of n.matches(viewSel) ? [n] : n.querySelectorAll(viewSel)) {
                            views.push({ key: hit.dataset.viewSwap, opacity: Number(getComputedStyle(hit).opacity) });
                        }
                    }
                });
                obs.observe(document.body, { childList: true, subtree: true });
                document.activeElement?.blur?.();
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }));
                await until(() => q(rowsSel) != null, 10000);
                await nap(${SETTLE_MS});
                obs.disconnect();
                const rows = views.find((v) => v.key === "rows");
                return { views, first: rows?.opacity ?? null, settled: opacity(q(rowsSel)) };
            `);
            rec(
                "5. compare: the skeleton shows at once (opacity 1, no fade on mount), then the column's rows fade in from 0 when the read lands and settle at 1",
                compared.views[0]?.key === "loading" && compared.views[0]?.opacity === 1 && fadedIn(compared),
                compared
            );
            await h.shot("cdp-shots/motion-diff-compare.png");
            const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", ...esc });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...esc });
            await polishWaitFor(h, `document.querySelector('[data-range-chip="compare"]')?.getAttribute("aria-pressed") !== "true"`, 4000);

            // --- history: load more enters as cards, the graph toggle fades the list ------------------------------
            const paged = await motionEval(h, `
                const picked = await pick(${D(ctx.history.names.good)}, "[data-history-row]");
                await until(() => document.querySelectorAll("[data-history-row]").length >= 50, 8000);
                const before = document.querySelectorAll("[data-history-row]").length;
                const w = watchAdded((n) => (n.matches?.("[data-history-row]") ? n : null));
                const el = q("[data-history-scroll]");
                el.scrollTop = el.scrollHeight;
                await until(() => document.querySelectorAll("[data-history-row]").length > before, 8000);
                await nap(${SETTLE_MS});
                w.stop();
                const rows = [...document.querySelectorAll("[data-history-row]")];
                return { picked, before, after: rows.length, added: w.seen, settled: opacity(rows.at(-1)) };
            `);
            rec(
                "6. a second page's rows enter as cards (added at opacity 0, settled at 1), and the first page does not replay",
                paged.picked && paged.after > paged.before && paged.added.length === paged.after - paged.before &&
                    paged.added[0] < MOUNTED_HIDDEN && paged.settled === 1,
                paged
            );

            const graph = await motionEval(h, `
                const el = q("[data-history-scroll]");
                el.scrollTop = 600;
                await nap(200);
                const top = el.scrollTop;
                const toggle = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Graph"));
                const bodySel = "[data-history-scroll] > [data-view-swap]";
                const w = watchAdded((n) => (n.matches?.(bodySel) ? n : null));
                toggle?.click();
                await nap(${SETTLE_MS});
                w.stop();
                const off = { body: q(bodySel)?.dataset.viewSwap, first: w.seen[0] ?? null, settled: opacity(q(bodySel)), top: el.scrollTop };
                toggle?.click();
                await nap(${SETTLE_MS});
                return { top, off, back: q(bodySel)?.dataset.viewSwap };
            `);
            rec(
                "7. turning the graph off fades the list in place and keeps the scroll offset",
                graph.off.body === "list:flat" && fadedIn(graph.off) && graph.off.top === graph.top && graph.back === "list:graph",
                graph
            );

            // --- the list's foot: loading -> failed -> retried, each line cross-fading in place -------------------
            const appended = await motionEval(h, `
                const S = await mod("app/store/jotaiStore.ts");
                const hs = await mod("app/view/agents/githistorystore.ts");
                const line = (key) => q('[data-history-scroll] [data-crossfade="' + key + '"]');
                const watchLine = (key) => watchAdded((n) => (n.matches?.('[data-history-scroll] [data-crossfade="' + key + '"]') ? n : null));
                const settledLine = (key) => ({ attached: line(key) != null, opacity: opacity(line(key)) });
                try {
                    ${HOLD_HISTORY}
                    // step 6 read the last page; a held read needs the store to think there is another
                    S.globalStore.set(hs.historyHasMoreAtom, true);
                    await nap(100);
                    const el = q("[data-history-scroll]");
                    el.scrollTop = 0;
                    await nap(100);
                    const wLoad = watchLine("loading");
                    const fLoad = sampleFrames(() => opacity(line("loading")));
                    el.scrollTop = el.scrollHeight;
                    await until(() => line("loading") != null, 3000);
                    await nap(${SETTLE_MS});
                    wLoad.stop();
                    fLoad.stop();
                    const loading = { first: wLoad.seen[0] ?? null, frames: fLoad.values, ...settledLine("loading"), text: line("loading")?.textContent };

                    const wFail = watchLine("failed");
                    const fFail = sampleFrames(() => opacity(line("failed")));
                    window.__mdHistoryRelease?.(${D(HISTORY_FAILED)});
                    await until(() => line("failed") != null, 3000);
                    await nap(${SETTLE_MS});
                    wFail.stop();
                    fFail.stop();
                    const failed = { first: wFail.seen[0] ?? null, frames: fFail.values, ...settledLine("failed"), loadingGone: line("loading") == null };

                    ${UNSTUB_HISTORY}
                    line("failed")?.querySelector("button")?.click();
                    await until(() => S.globalStore.get(hs.historyAppendAtom) === "idle", 8000);
                    await nap(${SETTLE_MS});
                    const retried = { state: S.globalStore.get(hs.historyAppendAtom), failedGone: line("failed") == null, loadingGone: line("loading") == null };
                    return { loading, failed, retried };
                } finally {
                    ${UNSTUB_HISTORY}
                }
            `);
            const crossedIn = (l) => l.first != null && l.first < MOUNTED_HIDDEN && l.frames.some((o) => o > 0 && o < 1) && l.attached && l.opacity === 1;
            rec(
                "7b. paging on: the 'loading commits' line cross-fades in (from 0, through in-between, settled at 1); a failed page swaps it for the retry line the same way; a retry that lands clears the foot",
                crossedIn(appended.loading) && /loading commits/.test(appended.loading.text ?? "") &&
                    crossedIn(appended.failed) && appended.failed.loadingGone &&
                    appended.retried.state === "idle" && appended.retried.failedGone && appended.retried.loadingGone,
                appended
            );

            const foldTick = await motionEval(h, `
                const S = await mod("app/store/jotaiStore.ts");
                const hs = await mod("app/view/agents/githistorystore.ts");
                const badge = () => [...document.querySelectorAll("span.text-graphlane-fold")].find((s) => /folded/.test(s.textContent));
                try {
                    ${stubHistoryExpr(wideHistory(DRAWABLE_LANES + FOLDED_FROM))}
                    hs.refreshHistory();
                    const shown = await until(() => /\\b${FOLDED_FROM} folded/.test(badge()?.textContent ?? ""), 8000);
                    await nap(${SETTLE_MS});
                    const tick = watchAdded((n) => (n.closest?.("span.text-graphlane-fold") && n.classList?.contains("inline-block") ? n : null));
                    ${stubHistoryExpr(wideHistory(DRAWABLE_LANES + FOLDED_TO))}
                    hs.refreshHistory();
                    await until(() => /\\b${FOLDED_TO} folded/.test(badge()?.textContent ?? ""), 8000);
                    await nap(${SETTLE_MS});
                    tick.stop();
                    const num = badge()?.querySelector(".inline-block");
                    return { shown, tick: tick.seen, text: badge()?.textContent, num: num?.textContent, settled: opacity(num) };
                } finally {
                    ${UNSTUB_HISTORY}
                }
            `);
            rec(
                "7c. one more folded lane rolls the header's folded count 2 -> 3 (the new value rises in from opacity 0) and lands at 1",
                foldTick.shown && foldTick.tick.length >= 1 && foldTick.tick[0] < 1 && foldTick.num === String(FOLDED_TO) &&
                    foldTick.settled === 1 && foldTick.text?.includes(`${FOLDED_TO} folded`),
                foldTick
            );

            // --- the failure panel: at once on a pick, as a card with a nudge after Retry, once --------------------
            const failure = await motionEval(h, `
                const panel = () => q("[data-git-failure]");
                const title = () => panel()?.children[1] ?? null;
                const w1 = watchAdded((n) => (n.matches?.("[data-git-failure]") ? n : null));
                await pick(${D(ctx.history.names.broken)}, "[data-git-failure]");
                await nap(${SETTLE_MS});
                w1.stop();
                const w2 = watchAdded((n) => (n.matches?.("[data-git-failure]") ? n : null));
                const shake = sampleFrames(() => (title() ? getComputedStyle(title()).transform : null));
                q("[data-git-failure-retry]")?.click();
                await nap(300);
                await until(() => panel() != null, 8000);
                await nap(${SETTLE_MS});
                w2.stop();
                shake.stop();
                const retried = { first: w2.seen.at(-1) ?? null, settled: opacity(panel()), shake: shake.values };
                await pick(${D(ctx.history.names.notRepo)}, "[data-not-a-repo]");
                const w3 = watchAdded((n) => (n.matches?.("[data-git-failure]") ? n : null));
                await pick(${D(ctx.history.names.broken)}, "[data-git-failure]");
                await nap(${SETTLE_MS});
                w3.stop();
                return { onPick: w1.seen, retried, repick: w3.seen, roles: { retry: q("[data-git-failure-retry]") != null } };
            `);
            rec(
                "8. a picked broken repo shows its failure at once; Retry's failure enters as a card and nudges; a re-pick does not replay it",
                failure.onPick.length >= 1 && failure.onPick.every((o) => o === 1) &&
                    fadedIn(failure.retried) && failure.retried.shake.some((v) => v !== "none" && v !== "matrix(1, 0, 0, 1, 0, 0)") &&
                    failure.repick.length >= 1 && failure.repick.every((o) => o === 1) && failure.roles.retry,
                failure
            );
            await h.shot("cdp-shots/motion-diff-failure.png");

            // --- the Retry one-shot is spent by the read's next outcome: a success as well as a failure -----------
            const spent = await motionEval(h, `
                const panel = () => q("[data-git-failure]");
                const title = () => panel()?.children[1] ?? null;
                const hs = await mod("app/view/agents/githistorystore.ts");
                try {
                    ${stubHistory(HISTORY_OK)}
                    q("[data-git-failure-retry]")?.click();
                    const cleared = await until(() => panel() == null, 8000);
                    await nap(${SETTLE_MS});
                    ${stubHistory(HISTORY_FAILED)}
                    const w1 = watchAdded((n) => (n.matches?.("[data-git-failure]") ? n : null));
                    const shake1 = sampleFrames(() => (title() ? getComputedStyle(title()).transform : null));
                    hs.refreshHistory();
                    await until(() => panel() != null, 8000);
                    await nap(${SETTLE_MS});
                    w1.stop();
                    shake1.stop();
                    const later = { cleared, seen: w1.seen, shake: shake1.values };

                    const w2 = watchAdded((n) => (n.matches?.("[data-git-failure]") ? n : null));
                    const shake2 = sampleFrames(() => (title() ? getComputedStyle(title()).transform : null));
                    q("[data-git-failure-retry]")?.click();
                    await nap(${STUB_BEAT_MS});
                    await until(() => panel() != null, 8000);
                    await nap(${SETTLE_MS});
                    w2.stop();
                    shake2.stop();
                    const retried = { first: w2.seen.at(-1) ?? null, settled: opacity(panel()), shake: shake2.values };
                    return { later, retried };
                } finally {
                    ${UNSTUB_HISTORY}
                }
            `);
            rec(
                "8b. a Retry whose read succeeds spends the one-shot: a failure later mounts its panel at opacity 1 and its headline does not move",
                spent.later.cleared && spent.later.seen.length >= 1 && spent.later.seen.every((o) => o === 1) && !spent.later.shake.some((v) => v !== "none" && v !== "matrix(1, 0, 0, 1, 0, 0)"),
                spent.later
            );
            rec(
                "8c. a Retry whose read fails still enters its panel as a card and nudges the headline",
                fadedIn(spent.retried) && spent.retried.shake.some((v) => v !== "none" && v !== "matrix(1, 0, 0, 1, 0, 0)"),
                spent.retried
            );

            // --- the panel's stderr block closes and opens through PaneReveal -------------------------------------
            // No git path changes a shown failure's stderr in place (every re-read clears the failure first), so the
            // step drives the store atom the panel reads, on the panel 8c left up.
            const stderr = await motionEval(h, `
                const S = await mod("app/store/jotaiStore.ts");
                const hs = await mod("app/view/agents/githistorystore.ts");
                const was = S.globalStore.get(hs.historyFailureAtom);
                if (was == null) return { was: null };
                const panel = q("[data-git-failure]");
                const paneOf = () => q("[data-git-failure] pre")?.closest(".overflow-hidden") ?? null;
                try {
                    const leaving = paneOf();
                    S.globalStore.set(hs.historyFailureAtom, { ...was, stderr: "" });
                    await nap(${MID_EXIT_MS});
                    const mid = { attached: leaving?.isConnected ?? false, opacity: opacity(leaving) };
                    await nap(${SETTLE_MS});
                    const goneAfter = leaving != null && !leaving.isConnected && paneOf() == null;
                    const w = watchAdded((n) => (n.classList?.contains("overflow-hidden") && n.querySelector?.("pre") && n.closest("[data-git-failure]") ? n : null));
                    const heights = sampleFrames(() => (paneOf() ? Math.round(paneOf().getBoundingClientRect().height) : null));
                    S.globalStore.set(hs.historyFailureAtom, { ...was, stderr: "fatal: stubbed history failure\\nhint: the block opens again" });
                    await nap(${SETTLE_MS});
                    w.stop();
                    heights.stop();
                    return {
                        mid, goneAfter, first: w.seen[0] ?? null, heights: heights.values, settled: opacity(paneOf()),
                        text: q("[data-git-failure] pre")?.textContent, samePanel: q("[data-git-failure]") === panel,
                    };
                } finally {
                    S.globalStore.set(hs.historyFailureAtom, was);
                }
            `);
            rec(
                "8d. the failure panel's stderr block closes through PaneReveal (still attached mid-fade, then gone) and opens again from height 0 and opacity 0 to settled at 1, in the same panel",
                stderr.samePanel && stderr.mid?.attached && stderr.mid.opacity > 0 && stderr.mid.opacity < 1 && stderr.goneAfter &&
                    fadedIn(stderr) && stderr.heights.length >= 3 && stderr.heights[0] < stderr.heights.at(-1) / 2 &&
                    /block opens again/.test(stderr.text ?? ""),
                stderr
            );
        } catch (e) {
            rec("diff scenario aborted", false, String(e?.message ?? e));
        }

        // --- storage: a clear's result reveals and nudges, cleared rows fold away, the totals roll ---------------
        try {
            await h.goto("settings");
            const mock = await polishWaitFor(h, `typeof window.__setStorageScenario === "function"`, 10000);
            await h.ev(`window.__setStorageScenario("storage")`);
            await h.ev(`document.querySelector('[data-section="storage"]')?.click()`);
            await polishWaitFor(h, `document.querySelector('[data-settings-section="storage"] [data-storage-row]') != null`, 5000);
            await polishNap(400);
            const cleared = await motionEval(h, `
                const pane = q('[data-settings-section="storage"]');
                const before = new Map([...pane.querySelectorAll("[data-storage-row]")].map((r) => [r.dataset.storageRow, r]));
                const notice = watchAdded((n) => (n.querySelector?.(":scope > [data-storage-result]") ? n : null));
                const tick = watchAdded((n) => (n.closest?.('[data-storage-stat="left"]') && n.classList?.contains("inline-block") ? n : null));
                const failSpan = () => q("[data-storage-result] .text-error");
                const shake = sampleFrames(() => (failSpan() ? getComputedStyle(failSpan()).transform : null));
                window.__setStorageScenario("cleared");
                await nap(${MID_EXIT_MS});
                const mid = [...before].map(([id, el]) => ({ id, attached: el.isConnected, opacity: opacity(el.parentElement) }));
                await nap(${SETTLE_MS});
                notice.stop();
                tick.stop();
                shake.stop();
                const gone = mid.filter((m) => !before.get(m.id).isConnected);
                const bar = pane.querySelector("[data-storage-row] .h-1\\\\.5 > span");
                return {
                    gone: gone.length,
                    midFade: gone.filter((m) => m.attached && m.opacity > 0 && m.opacity < 1).length,
                    notice: { first: notice.seen[0] ?? null, settled: opacity(q("[data-storage-result]")?.parentElement) },
                    shake: shake.values,
                    tick: tick.seen,
                    left: q('[data-storage-stat="left"]')?.children[1]?.textContent.trim(),
                    barMs: bar ? getComputedStyle(bar).transitionDuration : null,
                };
            `);
            rec(
                "9. cleared: the result reveals from 0 and its failure nudges; cleared rows fold away mid-fade; Left over rolls to 49 MB; bars ease",
                mock && fadedIn(cleared.notice) && cleared.shake.some((v) => v !== "none" && v !== "matrix(1, 0, 0, 1, 0, 0)") &&
                    cleared.gone > 0 && cleared.midFade === cleared.gone && cleared.tick.length >= 1 && cleared.tick[0] < 1 &&
                    cleared.left === "49 MB" && cleared.barMs === BAR_MS,
                cleared
            );
            await h.shot("cdp-shots/motion-diff-storage-cleared.png");

            const rescanned = await motionEval(h, `
                window.__setStorageScenario("scanning");
                await until(() => q("[data-storage-skeleton]") != null, 3000);
                await nap(200);
                const w = watchAdded((n) => (n.querySelector?.(":scope > [data-storage-group]") ? n : null));
                window.__setStorageScenario("storage");
                await nap(${SETTLE_MS});
                w.stop();
                const report = q('[data-settings-section="storage"] [data-storage-group]')?.parentElement;
                return { first: w.seen[0] ?? null, settled: opacity(report) };
            `);
            rec("10. a scan landing fades the report in over the skeleton", fadedIn(rescanned), rescanned);

            const labelled = await motionEval(h, `
                const sel = '[data-storage-clear] [data-crossfade^="Clearing"]';
                const before = q("[data-storage-clear] [data-crossfade]")?.textContent;
                const leaving = q("[data-storage-clear] [data-crossfade]");
                const w = watchAdded((n) => (n.matches?.(sel) ? n : null));
                const frames = sampleFrames(() => opacity(q(sel)));
                const out = sampleFrames(() => (leaving?.isConnected ? opacity(leaving) : null));
                window.__setStorageScenario("clearing");
                await nap(${SETTLE_MS});
                w.stop();
                frames.stop();
                out.stop();
                return {
                    before, first: w.seen[0] ?? null, frames: frames.values, settled: opacity(q(sel)), text: q(sel)?.textContent,
                    leavingFrames: out.values, leftAfter: leaving != null && !leaving.isConnected,
                    disabled: q("[data-storage-clear]")?.disabled ?? null,
                };
            `);
            rec(
                "11. Clear's label trades in place: 'Clear … left over' fades out while 'Clearing N of M…' fades in from 0 through in-between to settled at 1",
                /^Clear .* left over$/.test(labelled.before ?? "") && fadedIn(labelled) && labelled.frames.some((o) => o > 0 && o < 1) &&
                    labelled.leavingFrames.some((o) => o > 0 && o < 1) && labelled.leftAfter &&
                    /^Clearing \d+ of \d+…$/.test(labelled.text ?? "") && labelled.disabled === true,
                labelled
            );
        } catch (e) {
            rec("storage scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", NO_MEDIA).catch(() => {});
        await h.ev(UNSTUB_HISTORY).catch(() => {});
        await h.ev(`window.__setStorageScenario?.("live")`).catch(() => {});
        await h.goto("files").catch(() => {});
        await diffReviewMarks.teardown(h, ctx.review);
        await gitHistory.teardown(h, ctx.history);
    },
};
