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

            // --- compare: the read landing fades the column's rows in over the skeleton ---------------------------
            const compared = await motionEval(h, `
                const rowsSel = '[data-compare-column] > [data-view-swap="rows"]';
                const w = watchAdded((n) => (n.matches?.(rowsSel) ? n : null));
                document.activeElement?.blur?.();
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }));
                await until(() => q(rowsSel) != null, 10000);
                await nap(${SETTLE_MS});
                w.stop();
                return { first: w.seen[0] ?? null, settled: opacity(q(rowsSel)) };
            `);
            rec("5. compare: the column's rows fade in when the read lands", fadedIn(compared), compared);
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
        } catch (e) {
            rec("storage scenario aborted", false, String(e?.message ?? e));
        }
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", NO_MEDIA).catch(() => {});
        await h.ev(`window.__setStorageScenario?.("live")`).catch(() => {});
        await h.goto("files").catch(() => {});
        await diffReviewMarks.teardown(h, ctx.review);
        await gitHistory.teardown(h, ctx.history);
    },
};
