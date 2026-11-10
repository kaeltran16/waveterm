// motion-code: the motion sweep's moments on the Code surface, the project Overview and the image zoom
// (docs/superpowers/plans/2026-11-10-motion-sweep.md). The Code moments run on a repo the code kit writes, opened as a
// folder the way code-stale-bar does; the zoom on code-image-zoom's own fixture; the Overview on the same repo,
// registered as a project the way project-overview does. Each moment is sampled in-page: an observer reads a value a
// node mounts with, and a frame sampler reads a value every animation frame, since a CDP round trip per sample is
// slower than the motion.
import { codeImageZoom } from "./scenarios-code-imagezoom.mjs";
import { codeEval, makeCodeRepo, openFileInCode, openFolderInCode, removeCodeRepo } from "./scenarios-code-kit.mjs";
import { closeOverview, openOverview, pageEval } from "./project-overview-kit.mjs";
import { MODELS_VIEWPORT, lookHover } from "./scenarios-shared.mjs";

// a NUL byte makes the store read it as binary, and the bytes are no PNG, so the image fails to decode
const BROKEN_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
const FILES = {
    "src/alpha.ts": "export function alpha() {\n    return 1;\n}\n\nexport function beta() {\n    return 2;\n}\n",
    "src/gamma.ts": "export const gamma = 3;\n",
    "img/broken.png": BROKEN_PNG,
    "README.md": "# motion fixture\n",
};
const ROSTER_PREFIX = "fx-now-motion-";
// the usage store's dev hook (usagestore.ts): an empty reply draws the Activity grid with no read
const USAGE_KEY = "wave:dev-usage-buckets";
const REDUCE = { features: [{ name: "prefers-reduced-motion", value: "reduce" }] };

// records each added node matching sel (itself or a descendant) with `read` (an expression of el) as it mounts
const watchAdded = (sel, read = "getComputedStyle(el).opacity") => `(() => {
    window.__mcObs?.disconnect();
    window.__mcAdded = [];
    const sel = ${JSON.stringify(sel)};
    window.__mcObs = new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            for (const el of [n, ...n.querySelectorAll(sel)]) {
                if (el.matches(sel)) window.__mcAdded.push({ key: (el.textContent ?? "").trim().slice(0, 40), value: ${read} });
            }
        }
    });
    window.__mcObs.observe(document.body, { childList: true, subtree: true });
    return true;
})()`;
const readAdded = `(() => { window.__mcObs?.disconnect(); return window.__mcAdded ?? []; })()`;

// reads body (a function body returning a value) every animation frame into window.__mcFrames[name] until stopped
const startFrames = (name, body) => `(() => {
    const f = { on: true, values: [] };
    (window.__mcFrames ??= {})[${JSON.stringify(name)}] = f;
    const read = () => { try { ${body} } catch { return null; } };
    const tick = () => {
        f.values.push(read());
        if (f.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
})()`;
const stopFrames = (name) =>
    `(() => { const f = window.__mcFrames[${JSON.stringify(name)}]; f.on = false; return f.values; })()`;
const distinct = (values) => values.filter((v, i) => v != null && v !== values[i - 1]);
const between = (values, lo, hi) => values.some((v) => v > lo && v < hi);

const TREE_ROW = (name) =>
    `[...document.querySelectorAll('[data-code-tree] [role="treeitem"]')].find((r) => r.textContent.trim() === ${JSON.stringify(name)})`;
const CHEVRON_TURN = `const c = ${TREE_ROW("src")}?.querySelector("[data-code-tree-chevron]");
    return c ? parseFloat(getComputedStyle(c).rotate) || 0 : null;`;
// the x of a transform matrix, 0 for none
const X_OF = (sel) => `const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const t = getComputedStyle(el).transform;
    return t === "none" ? 0 : Math.round(Number(t.slice(7, -1).split(",")[4]) * 10) / 10;`;
const ZOOM_SCALE = `const t = getComputedStyle(document.querySelector("[data-image-zoom-img]")).transform;
    return t === "none" ? 1 : Math.round(Number(t.slice(7, -1).split(",")[0]) * 1000) / 1000;`;
const BLAME_WIDTH = `return document.querySelector("[data-code-blame-column]")?.parentElement.offsetWidth ?? 0;`;

const setInput = (sel, value, enter = false) => `(() => {
    const input = document.querySelector(${JSON.stringify(sel)});
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    ${enter ? `input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));` : ""}
    return true;
})()`;

const nowAgent = (project, id, over = {}) => ({
    id: ROSTER_PREFIX + id,
    name: ROSTER_PREFIX + id,
    project,
    task: "Fixture task",
    state: "working",
    agent: "claude",
    model: "opus",
    activeMs: 12 * 60_000,
    blockId: `blk-${ROSTER_PREFIX}${id}`,
    activity: `${id} at work`,
    ...over,
});

export const motionCode = {
    name: "motion-code",
    surface: "code",
    async arrange(h) {
        const ctx = { project: `verify-motion-code-${Date.now().toString(36)}` };
        try {
            ctx.dir = makeCodeRepo(FILES);
            ctx.zoom = await codeImageZoom.arrange(h);
            ctx.arrangeError = ctx.zoom.arrangeError;
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok: ok === true, detail: JSON.stringify(detail) });
        const nap = (ms) => new Promise((r) => setTimeout(r, ms));
        const ev = (expr) => h.ev(expr);
        await h.cdp("Emulation.setDeviceMetricsOverride", MODELS_VIEWPORT);
        const opened = ctx.arrangeError == null && (await openFolderInCode(h, ctx.dir));
        rec("1. the fixture repo opens in Code as a folder", opened === true, { arrangeError: ctx.arrangeError ?? null, opened });
        if (opened !== true) return steps;

        // 2. expanding a directory turns its chevron and fades its new rows in; the rows already there stay put
        await ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
        await nap(300);
        await ev(watchAdded(`[data-code-tree] [role="treeitem"]`));
        await ev(startFrames("turn", CHEVRON_TURN));
        await ev(`${TREE_ROW("src")}?.click()`);
        await nap(600);
        const turn = distinct(await ev(stopFrames("turn")));
        const rows = await ev(readAdded);
        const rowsSettled = await ev(`getComputedStyle(${TREE_ROW("alpha.ts")}).opacity`);
        await h.shot("cdp-shots/motion-code-tree.png");
        rec(
            "2. expanding src turns its chevron through intermediate angles and its new rows mount at opacity 0, then settle at 1",
            turn[0] === 0 && turn.at(-1) === 90 && between(turn, 0, 90) && rows.some((r) => r.key === "alpha.ts" && r.value === "0") && rowsSettled === "1",
            { turn, rows, rowsSettled }
        );

        // 3. the inline create editor reveals, and a bad name typed into it nudges its error once
        await ev(watchAdded("[data-code-name-input]", "getComputedStyle(el.parentElement).opacity"));
        await codeEval(h, `const { startCreate } = await mod("app/view/code/codestore.ts"); startCreate(false); return true;`);
        await nap(400);
        const editorAdded = await ev(readAdded);
        await ev(setInput("[data-code-name-input]", "fine.ts"));
        await nap(400);
        await ev(startFrames("nudge", X_OF("[data-code-name-error] > span")));
        await ev(setInput("[data-code-name-input]", "a/b"));
        await nap(500);
        const nudge = distinct(await ev(stopFrames("nudge")));
        const errText = await ev(`document.querySelector("[data-code-name-error]")?.textContent ?? null`);
        await h.shot("cdp-shots/motion-code-name-error.png");
        await codeEval(h, `const { cancelEdit } = await mod("app/view/code/codestore.ts"); cancelEdit(); return true;`);
        rec(
            "3. the create editor mounts at opacity 0, and a name with a slash brings an error that nudges along x and settles at 0",
            editorAdded[0]?.value === "0" && errText != null && nudge.some((x) => x !== 0) && nudge.at(-1) === 0,
            { editorAdded, errText, nudge }
        );

        // 4. turning blame on grows its column in through intermediate widths
        const fileOpen = await openFileInCode(h, "src/alpha.ts");
        await codeEval(h, `return until(() => document.querySelector(".monaco-editor") != null && document.querySelector("[data-code-blame-toggle]") != null, 8000);`);
        await nap(400);
        await ev(startFrames("blame", BLAME_WIDTH));
        await ev(`document.querySelector("[data-code-blame-toggle]")?.click()`);
        await nap(800);
        const widths = distinct(await ev(stopFrames("blame")));
        await h.shot("cdp-shots/motion-code-blame.png");
        await ev(`document.querySelector("[data-code-blame-toggle]")?.click()`);
        await codeEval(h, `return until(() => document.querySelector("[data-code-blame-column]") == null, 4000);`);
        rec(
            "4. turning blame on grows the column from 0 through intermediate widths to its full width",
            fileOpen === true && widths[0] === 0 && widths.at(-1) > 0 && between(widths, 0, widths.at(-1)),
            { fileOpen, widths }
        );

        // 5. an image that fails to decode fades its failure in rather than cutting to it
        await ev(watchAdded(`[data-code-image-state="failed"]`));
        const imageOpen = await openFileInCode(h, "img/broken.png");
        const failed = await codeEval(h, `return until(() => document.querySelector('[data-code-image-state="failed"]') != null, 6000);`);
        await nap(500);
        const failedAdded = await ev(readAdded);
        const failedSettled = await ev(`getComputedStyle(document.querySelector('[data-code-image-state="failed"]')).opacity`);
        await h.shot("cdp-shots/motion-code-image-failed.png");
        rec(
            "5. a broken image's failure mounts at opacity 0 and settles at 1",
            imageOpen === true && failed === true && failedAdded[0]?.value === "0" && failedSettled === "1",
            { imageOpen, failed, failedAdded, failedSettled }
        );

        // 6. search: the path filters reveal, an invalid pattern nudges, and a new result set fades in
        await ev(`document.querySelector('[data-code-column-tab="search"]')?.click()`);
        await codeEval(h, `return until(() => document.querySelector("[data-code-search-input]") != null, 4000);`);
        await ev(watchAdded("[data-code-search-include]", "getComputedStyle(el.parentElement).opacity"));
        await ev(`[...document.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent.trim() === "Filter paths")?.click()`);
        await nap(400);
        const filterAdded = await ev(readAdded);
        const regexOn = await ev(`document.querySelector('[data-code-search-flag="regex"]')?.getAttribute("aria-pressed") === "true"`);
        if (!regexOn) await ev(`document.querySelector('[data-code-search-flag="regex"]')?.click()`);
        await ev(startFrames("invalid", X_OF("[data-code-search-invalid]")));
        await ev(setInput("[data-code-search-input]", "(", true));
        const invalid = await codeEval(h, `return until(() => document.querySelector("[data-code-search-invalid]") != null, 8000);`);
        await nap(500);
        const invalidX = distinct(await ev(stopFrames("invalid")));
        await ev(watchAdded(`[data-view-fade^="done:"]`));
        await ev(setInput("[data-code-search-input]", "alpha", true));
        const results = await codeEval(h, `return until(() => document.querySelector("[data-code-search-row]") != null, 8000);`);
        await nap(500);
        const resultsAdded = await ev(readAdded);
        await h.shot("cdp-shots/motion-code-search.png");
        await ev(`document.querySelector('[data-code-search-flag="regex"]')?.click()`);
        await ev(`[...document.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent.trim() === "Filter paths")?.click()`);
        rec(
            "6. the path filters mount at opacity 0, '(' as a regex nudges 'Invalid pattern', and the next result set mounts at opacity 0",
            filterAdded[0]?.value === "0" &&
                invalid === true &&
                invalidX.some((x) => x !== 0) &&
                results === true &&
                resultsAdded.some((r) => r.value === "0"),
            { filterAdded, invalid, invalidX, results, resultsAdded }
        );

        // 7. symbols: a filter that empties the outline fades the empty line in
        await openFileInCode(h, "src/alpha.ts");
        await ev(`document.querySelector('[data-code-column-tab="symbols"]')?.click()`);
        const outline = await codeEval(h, `return until(() => document.querySelector("[data-code-symbol-row]") != null, 6000);`);
        await nap(300);
        await ev(watchAdded(`[data-view-fade="empty"]`));
        await ev(setInput("[data-code-symbols-filter]", "zzq"));
        await nap(500);
        const emptyAdded = await ev(readAdded);
        await h.shot("cdp-shots/motion-code-symbols.png");
        await ev(setInput("[data-code-symbols-filter]", ""));
        rec(
            "7. filtering the outline to nothing mounts its empty line at opacity 0",
            outline === true && emptyAdded[0]?.value === "0" && /No symbols match/.test(emptyAdded[0]?.key ?? ""),
            { outline, emptyAdded }
        );

        // 8. reduced motion: a directory expands with its rows at full opacity and its chevron turned in one frame
        await ev(`document.querySelector('[data-code-column-tab="files"]')?.click()`);
        await codeEval(h, `return until(() => ${TREE_ROW("alpha.ts")} != null, 4000);`);
        await h.cdp("Emulation.setEmulatedMedia", REDUCE);
        await nap(300);
        await ev(`${TREE_ROW("src")}?.click()`);
        await codeEval(h, `return until(() => ${TREE_ROW("alpha.ts")} == null, 4000);`);
        await nap(300);
        await ev(watchAdded(`[data-code-tree] [role="treeitem"]`));
        await ev(startFrames("turn", CHEVRON_TURN));
        await ev(`${TREE_ROW("src")}?.click()`);
        await nap(600);
        const reducedTurn = distinct(await ev(stopFrames("turn")));
        const reducedRows = await ev(readAdded);
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
        rec(
            "8. under reduced motion src expands with its rows mounted at opacity 1 and the chevron at 90 with no frame between",
            reducedTurn.at(-1) === 90 &&
                reducedTurn.every((v) => v === 0 || v === 90) &&
                reducedRows.length > 0 &&
                reducedRows.every((r) => r.value === "1"),
            { reducedTurn, reducedRows }
        );

        // 9. a peek's file landing over its loading line fades in
        const peek = await codeEval(h, `
            const peek = { blockId: "motion-code-peek", bufferLine: 0, start: 0, raw: "notes.md", abs: "C:/motion/notes.md", line: null, mode: "preview" };
            const host = await mount("app/view/code/codepeekcard.tsx", "CodePeekCard",
                { peek: { ...peek, file: { kind: "loading" } }, model: {}, blockId: "motion-code-peek", side: "below" },
                { style: "width:560px;height:360px;" });
            await nap(300);
            const loading = document.querySelector('[data-look-mount="CodePeekCard"] [data-view-fade]')?.getAttribute("data-view-fade");
            const seen = [];
            const obs = new MutationObserver((muts) => {
                for (const m of muts) for (const n of m.addedNodes) {
                    if (n instanceof Element && n.matches("[data-view-fade]")) seen.push({ key: n.getAttribute("data-view-fade"), opacity: getComputedStyle(n).opacity });
                }
            });
            obs.observe(host, { childList: true, subtree: true });
            host.render({ peek: { ...peek, file: { kind: "text", text: "# Notes\\n\\nA peeked file.", git: { kind: "norepo" }, open: { projectPath: "C:/motion", rel: "notes.md" } } }, model: {}, blockId: "motion-code-peek", side: "below" });
            await nap(600);
            obs.disconnect();
            const settled = getComputedStyle(host.querySelector("[data-view-fade]")).opacity;
            return { loading, seen, settled };
        `);
        await h.shot("cdp-shots/motion-code-peek.png");
        await codeEval(h, `
            unmountAll();
            const P = await mod("app/view/code/codepeekstore.ts");
            S.globalStore.set(P.codePeekFocusedAtom, false);
            return true;
        `).catch(() => {});
        rec(
            "9. a Code peek's file landing over its loading line mounts at opacity 0 and settles at 1",
            peek?.loading === "loading|preview" && peek.seen[0]?.key === "text|preview" && peek.seen[0].opacity === "0" && peek.settled === "1",
            peek
        );

        // 10. the zoom view: a + step eases through intermediate scales, the wheel jumps, and reduced motion steps in one frame
        const zoomOpen = await openFolderInCode(h, ctx.zoom.dir);
        const guide = zoomOpen && (await openFileInCode(h, "guide.md"));
        const imgReady = guide && (await codeEval(h, `return until(() => { const i = document.querySelector("[data-code-preview] .markdown img"); return !!i && i.complete && i.naturalWidth > 0; }, 8000);`));
        const at = imgReady && (await ev(`(() => { const r = document.querySelector("[data-code-preview] .markdown img").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
        if (at) {
            await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
            await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
        }
        const zoomShown = await codeEval(h, `return until(() => document.querySelector("[data-image-zoom-readout]")?.textContent.endsWith("%"), 6000);`);
        await nap(500);
        const press = (k) => ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
        await ev(startFrames("step", ZOOM_SCALE));
        await press("+");
        await nap(700);
        const stepScales = distinct(await ev(stopFrames("step")));
        await h.shot("cdp-shots/motion-code-zoom-step.png");
        await ev(startFrames("wheel", ZOOM_SCALE));
        await ev(`(() => {
            const s = document.querySelector("[data-image-zoom-stage]"), r = s.getBoundingClientRect();
            s.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
            return true;
        })()`);
        await nap(500);
        const wheelScales = distinct(await ev(stopFrames("wheel")));
        await h.cdp("Emulation.setEmulatedMedia", REDUCE);
        await nap(300);
        await ev(startFrames("reduced", ZOOM_SCALE));
        await press("0");
        await nap(700);
        const reducedScales = distinct(await ev(stopFrames("reduced")));
        await h.cdp("Emulation.setEmulatedMedia", { features: [] });
        await press("Escape");
        await codeEval(h, `return until(() => document.querySelector("[data-image-zoom]") == null, 4000);`);
        rec(
            "10. in the zoom view + eases through intermediate scales, the wheel lands in one frame, and under reduced motion Fit lands in one frame",
            zoomShown === true &&
                stepScales.length > 2 &&
                stepScales.at(-1) > stepScales[0] &&
                // a jump can land before the sampler's first frame, so only "no frame between" is asserted
                wheelScales.at(-1) > stepScales.at(-1) &&
                wheelScales.every((v) => v === stepScales.at(-1) || v === wheelScales.at(-1)) &&
                reducedScales.at(-1) < wheelScales.at(-1) &&
                reducedScales.every((v) => v === wheelScales.at(-1) || v === reducedScales.at(-1)),
            { zoomOpen, guide, imgReady, zoomShown, stepScales, wheelScales, reducedScales }
        );

        // 11-13. the project Overview
        await h.goto("cockpit");
        const registered = await pageEval(h, `
            await ps.registerProject(${JSON.stringify(ctx.project)}, ${JSON.stringify(ctx.dir)});
            window.__motionCodePrevScope ??= S.globalStore.get(model.projectFilterAtom);
            const D = await mod("app/view/agents/devmock.ts");
            if (!("__motionCodeMock" in window)) window.__motionCodeMock = S.globalStore.get(D.devMockAgentsAtom);
            S.globalStore.set(D.devMockAgentsAtom, []);
            if (!("__motionCodeUsage" in window)) window.__motionCodeUsage = localStorage.getItem(${JSON.stringify(USAGE_KEY)});
            localStorage.setItem(${JSON.stringify(USAGE_KEY)}, JSON.stringify({ buckets: [], sessions: [] }));
            return until(() => S.globalStore.get(ps.projectsAtom)?.[${JSON.stringify(ctx.project)}] != null, 10000);
        `);
        ctx.registered = registered === true;

        // 11. Branches and History trade their skeletons for rows with a fade
        await ev(watchAdded(`[data-overview-region] [data-view-fade="rows"]`, `el.closest("[data-overview-region]").getAttribute("data-overview-region") + ":" + getComputedStyle(el).opacity`));
        const overview = await openOverview(h, ctx.project);
        await pageEval(h, `return until(() => ["branches", "history"].every((r) => overview()?.querySelector('[data-overview-region="' + r + '"] [data-view-fade="rows"]') != null), 10000);`);
        await nap(600);
        const regionsAdded = (await ev(readAdded)).map((r) => r.value);
        await h.shot("cdp-shots/motion-code-overview.png");
        rec(
            "11. the Overview's Branches and History rows mount at opacity 0 when their reads land",
            registered === true && overview?.shown === true && regionsAdded.includes("branches:0") && regionsAdded.includes("history:0"),
            { registered, overview, regionsAdded }
        );

        // 12. an Activity day's tooltip pops in
        const cell = await pageEval(h, `
            await until(() => overview()?.querySelector("[data-activity-pos]") != null, 8000);
            const c = [...overview().querySelectorAll("[data-activity-pos]")][120];
            c?.scrollIntoView({ block: "nearest" });
            await nap(150);
            const r = c?.getBoundingClientRect();
            return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        `);
        await ev(watchAdded(`[data-activity-tooltip]`));
        if (cell) {
            await lookHover(h, 1, 1);
            await lookHover(h, cell.x, cell.y);
        }
        await nap(400);
        const tipAdded = await ev(readAdded);
        const tipSettled = await ev(`getComputedStyle(document.querySelector("[data-activity-tooltip]")).opacity`).catch(() => null);
        await lookHover(h, 1, 1);
        const tipGone = await pageEval(h, `return until(() => overview()?.querySelector("[data-activity-tooltip]") == null, 2000);`);
        rec(
            "12. hovering an Activity day mounts its tooltip at opacity 0, it settles at 1 and leaves when the pointer does",
            cell != null && tipAdded[0]?.value === "0" && tipSettled === "1" && tipGone === true,
            { cell, tipAdded, tipSettled, tipGone }
        );

        // 13. Now: a row that starts running enters as a card; one that finishes moves to Finished as the same row
        const stay = nowAgent(ctx.project, "stay");
        const finisher = nowAgent(ctx.project, "finisher");
        const ROW = (section, name) =>
            `[...(overview()?.querySelectorAll('[data-overview-region="now"] [data-overview-now-row]') ?? [])].find((b) => b.closest("section")?.getAttribute("aria-label") === ${JSON.stringify(section)} && flat(b.children[1]) === ${JSON.stringify(name)})`;
        await pageEval(h, `
            const D = await mod("app/view/agents/devmock.ts");
            S.globalStore.set(D.devMockAgentsAtom, ${JSON.stringify([stay])});
            return until(() => ${ROW("Running", stay.name)} != null, 6000);
        `);
        await nap(500);
        await ev(watchAdded(`[data-overview-region="now"] [data-overview-now-row]`, `getComputedStyle(el).opacity`));
        const entered = await pageEval(h, `
            const D = await mod("app/view/agents/devmock.ts");
            S.globalStore.set(D.devMockAgentsAtom, ${JSON.stringify([stay, finisher])});
            const shown = await until(() => ${ROW("Running", finisher.name)} != null, 6000);
            await nap(600);
            return shown;
        `);
        const enterAdded = await ev(readAdded);
        await ev(startFrames("morph", `
            const o = document.querySelector("[data-project-overview]");
            const b = [...(o?.querySelectorAll('[data-overview-region="now"] section[aria-label="Finished, not read yet"] [data-overview-now-row]') ?? [])].find((x) => (x.children[1]?.textContent ?? "").trim() === ${JSON.stringify(finisher.name)});
            return b ? Math.round(b.getBoundingClientRect().top) : null;
        `));
        const moved = await pageEval(h, `
            const D = await mod("app/view/agents/devmock.ts");
            S.globalStore.set(D.devMockAgentsAtom, ${JSON.stringify([stay, { ...finisher, state: "idle", idleSince: Date.now() }])});
            const shown = await until(() => ${ROW("Finished, not read yet", finisher.name)} != null, 6000);
            await nap(700);
            return shown;
        `);
        const tops = distinct(await ev(stopFrames("morph")));
        await h.shot("cdp-shots/motion-code-now.png");
        rec(
            "13. a row that starts running mounts at opacity 0, and one that finishes travels to Finished through intermediate positions",
            entered === true &&
                enterAdded.some((r) => r.key.includes(finisher.name) && r.value === "0") &&
                moved === true &&
                tops.length > 2 &&
                between(tops, Math.min(tops[0], tops.at(-1)), Math.max(tops[0], tops.at(-1))) &&
                // it travels straight to where it lands, never past it and back in one frame
                tops.every((v) => v >= Math.min(tops[0], tops.at(-1)) && v <= Math.max(tops[0], tops.at(-1))),
            { entered, enterAdded, moved, tops }
        );
        await closeOverview(h);
        return steps;
    },
    async teardown(h, ctx) {
        await h.cdp("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
        await codeEval(h, `unmountAll(); return true;`).catch(() => {});
        await pageEval(h, `
            S.globalStore.set(model.projectOverviewAtom, null);
            const D = await mod("app/view/agents/devmock.ts");
            const rail = await mod("app/view/agents/cockpiteventsrail.tsx");
            if ("__motionCodeMock" in window) S.globalStore.set(D.devMockAgentsAtom, window.__motionCodeMock);
            S.globalStore.set(rail.agentEventsAtom, (prev) => prev.filter((e) => !String(e.focusId ?? "").startsWith(${JSON.stringify(ROSTER_PREFIX)})));
            if ("__motionCodeUsage" in window) {
                if (window.__motionCodeUsage == null) localStorage.removeItem(${JSON.stringify(USAGE_KEY)});
                else localStorage.setItem(${JSON.stringify(USAGE_KEY)}, window.__motionCodeUsage);
            }
            if ("__motionCodePrevScope" in window) S.globalStore.set(model.projectFilterAtom, window.__motionCodePrevScope ?? "all");
            delete window.__motionCodeMock;
            delete window.__motionCodeUsage;
            delete window.__motionCodePrevScope;
            return true;
        `).catch(() => {});
        if (ctx?.registered) await h.rpc("deleteproject", { name: ctx.project }).catch(() => {});
        if (ctx?.dir) removeCodeRepo(ctx.dir);
        if (ctx?.zoom) await codeImageZoom.teardown(h, ctx.zoom).catch(() => {});
    },
};
