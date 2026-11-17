// Scenario rendered-bs-run: the run card at the end of the Rendered transcript (building, merged with its final check
// passed, merged with a failed one), Close the brainstorm from the card, the gone card for a removed brainstorm with
// the header's Brainstorm switch gone, the closed row, and the unreadable card. kit is scenarios-rendered-brainstorm.mjs's
// RBS_KIT.
//
// The run is page-only: its run and dag objects are written into the page's object cache (updateWaveObject), so no
// engine runs; the card reads them as it reads a real run. Close deletes real folders in the temp project.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NAME = "rendered-bs-run";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const TOPIC = "run-memory-pressure";
const CANVAS = "final-queue";
const RUN_ID = "3f9a1c2e-5b7d-4e21-9a8c-0d6f3b1a7e42";
const DAG_ID = "7a2b9c40-1d3e-4f56-8a7b-9c0d1e2f3a4b";
const SHORT = RUN_ID.slice(0, 8);
const SHA = "9c1e2f0a1b2c3d4e5f60718293a4b5c6d7e8f901";
const SHA7 = SHA.slice(0, 7);
const TASKS = 7;
const LANDED = 4;
const SWITCH = `document.querySelector('[aria-label="Show terminal or brainstorm"]')`;
const BAD_FILE = `{ "v": 1, "title": "Run memory pressure", "parts": [`;

const part = (id, title) => ({ id, title, state: "yours", body: `${title}: settled.` });
const RUN_FILE = {
    v: 1,
    title: "Run memory pressure",
    spec: "docs/superpowers/specs/2026-11-17-run-memory-pressure-design.md",
    canvas: CANVAS,
    question: null,
    working: null,
    parts: [part("what", "What counts"), part("who", "Who it protects"), part("queue", "Final queue")],
    history: [],
    done: true,
    check: null,
    run: RUN_ID,
};

// a run's tasks: the first `landed` done and merged
const tasksOf = (landed) =>
    Array.from({ length: TASKS }, (_, i) => ({ id: `t-${i + 1}`, state: i < landed ? "done" : "", merged: i < landed }));

export default (kit) => {
    const { scenario, writeFile, waitCard, narrow, widen, agentPage, polishWaitFor, polishNap, HOST, RV, WAIT_MS, BS_POLL_WAIT_MS } =
        kit;
    const CARD = `${HOST}?.querySelector("[data-rendered-bs-run]")`;
    const GONE = `${HOST}?.querySelector("[data-rendered-bs-gone]")`;
    let version = 1;

    // writes the run and its dag into the page's object cache, newer than what it holds
    const setRun = (h, { status = "running", landed = LANDED, final, land }) => {
        version += 1;
        const dag = { otype: "dag", oid: DAG_ID, version, runid: RUN_ID, status, tasks: tasksOf(landed), ...(final ? { final } : {}) };
        const run = {
            otype: "run",
            oid: RUN_ID,
            version,
            dagoref: DAG_ID,
            status,
            basebranch: "main",
            ...(land ? { land } : {}),
        };
        return agentPage(
            h,
            `WOS.updateWaveObject({ updatetype: "update", otype: "dag", oid: ${JSON.stringify(DAG_ID)}, obj: ${JSON.stringify(dag)} });
            WOS.updateWaveObject({ updatetype: "update", otype: "run", oid: ${JSON.stringify(RUN_ID)}, obj: ${JSON.stringify(run)} });
            return true;`
        );
    };
    const BUILDING = { status: "running" };
    const MERGED = (state) => ({
        status: "done",
        landed: TASKS,
        final: { state, round: 1 },
        land: { state: "landed", commit: SHA },
    });

    // the run card as drawn
    const readRun = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const host = ${HOST};
            const card = ${CARD};
            const q = (sel) => card?.querySelector(sel);
            const detail = q("[data-rendered-bs-run-detail]")?.getBoundingClientRect();
            const close = q("[data-rendered-bs-close]");
            const cb = close?.getBoundingClientRect();
            return {
                kind: host?.getAttribute("data-rendered-bs-card") ?? null,
                compact: host?.hasAttribute("data-compact") ?? null,
                card: card != null,
                head: flat(q("[data-rendered-bs-head]")),
                status: flat(q("[data-rendered-bs-status]")),
                openRun: flat(q("[data-rendered-bs-open-run]")),
                openBrainstorm: q("[data-rendered-bs-open]") != null,
                state: q("[data-rendered-bs-run-state]")?.getAttribute("data-rendered-bs-run-state") ?? null,
                headline: flat(q("[data-rendered-bs-run-headline]")),
                detail: flat(q("[data-rendered-bs-run-detail]")),
                close: close ? { text: flat(close), disabled: close.disabled } : null,
                closeBelow: cb && detail ? cb.top >= detail.bottom - 1 : null,
                closeBeside: cb && detail ? cb.top < detail.bottom - 1 : null,
                check: q("[data-rendered-bs-run-state] svg") != null,
                dot: q("[data-rendered-bs-run-dot]") != null,
                closeError: flat(q("[data-rendered-bs-close-error]")),
                switchShown: ${SWITCH} != null,
            };
        })()`);

    const readGone = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const host = ${HOST};
            const g = ${GONE};
            const col = host?.getBoundingClientRect();
            const box = g?.getBoundingClientRect();
            return {
                kind: host?.getAttribute("data-rendered-bs-card") ?? null,
                compact: host?.hasAttribute("data-compact") ?? null,
                which: g?.getAttribute("data-rendered-bs-gone") ?? null,
                text: flat(g),
                inside: box != null && col != null ? box.left >= col.left - 1 && box.right <= col.right + 1 : null,
                run: host?.querySelector("[data-rendered-bs-run]") != null,
                switchShown: ${SWITCH} != null,
            };
        })()`);

    const drawn = (h, test, ms = WAIT_MS) => polishWaitFor(h, `(() => { const card = ${CARD}; return ${test}; })()`, ms);

    // each frame's drawn share of the check's stroke (null while there is none): motion writes pathLength as the dash
    // array's first value
    const sampleCheck = (h) =>
        h.ev(`(() => {
            const out = (window.__rbsCheck = { on: true, values: [] });
            const tick = () => {
                if (!out.on) return;
                const d = ${CARD}?.querySelector("[data-rendered-bs-run-state] svg path")?.getAttribute("stroke-dasharray");
                out.values.push(d == null ? null : Number(d.split(/[ ,]+/)[0]));
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return true;
        })()`);
    const stopSampling = (h) => h.ev(`(() => { window.__rbsCheck.on = false; return window.__rbsCheck.values; })()`);

    const brainstormError = (h, ctx) =>
        agentPage(
            h,
            `const S = await mod("app/view/agents/brainstormstore.ts");
            return S.getBrainstorm(${JSON.stringify(ctx.agentId)})?.error ?? null;`
        );

    return [
        scenario(
            NAME,
            { topic: TOPIC, canvas: CANVAS, boards: ["Main.dc.html"], file: RUN_FILE },
            async (h, ctx, step) => {
                const brainstormDir = dirname(ctx.file);
                const canvasDir = join(ctx.cwd, ".superpowers", "design", CANVAS);
                const sibling = join(ctx.cwd, ".superpowers", "keep.txt");
                writeFileSync(sibling, "stays\n");

                await step("RunStep's building: the head names the topic, Run <id> and Open run, the dot and the pane's building words, no Close", async () => {
                    await setRun(h, BUILDING);
                    await waitCard(h, "run");
                    await drawn(h, `(card?.innerText ?? "").includes("The run is building")`);
                    const r = await readRun(h);
                    await h.shot(SHOT(1, "building"));
                    const ok =
                        r.kind === "run" &&
                        r.head.startsWith("Brainstorm · ") &&
                        r.head.includes(TOPIC) &&
                        r.status === `Run ${SHORT}` &&
                        r.openRun === "Open run" &&
                        !r.openBrainstorm &&
                        r.state === "building" &&
                        r.headline === `The run is building: ${LANDED} of ${TASKS} tasks landed` &&
                        r.detail.startsWith("Tasks land on main as they pass.") &&
                        r.dot &&
                        !r.check &&
                        r.close === null &&
                        r.switchShown;
                    return [ok, r];
                });

                await step("the run merged with its final check passed draws the check, and offers Close the brainstorm with what it deletes", async () => {
                    await sampleCheck(h);
                    await setRun(h, MERGED("passed"));
                    await drawn(h, `!!card?.querySelector("[data-rendered-bs-close]")`);
                    await polishNap(900);
                    const frames = await stopSampling(h);
                    const r = await readRun(h);
                    await h.shot(SHOT(2, "merged-passed"));
                    const seen = frames.filter((v) => v != null);
                    const swapped = await h.ev(`${CARD}?.querySelector('[data-view-swap="merged"]') != null`);
                    const ok =
                        r.state === "merged" &&
                        r.headline === `Built and merged into main at ${SHA7}` &&
                        r.detail.startsWith("The final check passed. The spec stays in docs/.") &&
                        r.detail.includes(`closing deletes .superpowers/brainstorm/${TOPIC} and the ${CANVAS} canvas.`) &&
                        r.close?.text === "Close the brainstorm" &&
                        !r.close.disabled &&
                        r.check &&
                        !r.dot &&
                        r.closeBeside === true &&
                        swapped &&
                        seen.some((v) => v < 0.95) &&
                        seen.at(-1) >= 0.99;
                    return [ok, { ...r, swapped, drawn: seen.filter((v, i) => v !== seen[i - 1]).slice(0, 12) }];
                });

                await step("the narrow column stacks the run card's Close button under its text", async () => {
                    const narrowed = await narrow(h);
                    await drawn(h, `!!card?.querySelector("[data-rendered-bs-close]")`);
                    await polishNap(300);
                    const r = await readRun(h);
                    await h.shot(SHOT(3, "narrow"));
                    const widened = await widen(h);
                    const wide = await readRun(h);
                    return [
                        narrowed && r.compact === true && r.closeBelow === true && widened && wide.closeBeside === true,
                        { narrowed, widened, narrow: r, wideBeside: wide.closeBeside },
                    ];
                });

                await step("merged with a failed final check: the brainstorm stays, with its reason and no Close", async () => {
                    await setRun(h, MERGED("failed"));
                    await drawn(h, `(card?.innerText ?? "").includes("so the brainstorm stays")`);
                    const r = await readRun(h);
                    await h.shot(SHOT(4, "merged-failed"));
                    const ok =
                        r.state === "merged" &&
                        r.headline === `Built and merged into main at ${SHA7}` &&
                        r.detail === "The final check did not pass, so the brainstorm stays." &&
                        r.close === null &&
                        r.check;
                    return [ok, r];
                });

                await step("a removed brainstorm with no close record is the gone card, and the header's Brainstorm switch goes", async () => {
                    rmSync(ctx.file);
                    const shown = await polishWaitFor(h, `${GONE}?.getAttribute("data-rendered-bs-gone") === "removed"`, BS_POLL_WAIT_MS * 2);
                    const r = await readGone(h);
                    await h.shot(SHOT(5, "removed"));
                    const ok =
                        shown &&
                        r.kind === "gone" &&
                        r.text.startsWith(`${TOPIC}'s brainstorm file is gone`) &&
                        r.text.includes("It is no longer at") &&
                        r.text.includes("brainstorm.json") &&
                        r.text.endsWith("The Brainstorm switch in the header goes with it; the answers above stay in the transcript.") &&
                        r.inside === true &&
                        !r.run &&
                        !r.switchShown;
                    return [ok, { shown, ...r }];
                });

                await step("the file back: the run card returns and the Brainstorm switch with it", async () => {
                    writeFile(ctx, { ...RUN_FILE });
                    await waitCard(h, "run");
                    await drawn(h, `!!card?.querySelector("[data-rendered-bs-run-state]")`);
                    await setRun(h, MERGED("passed"));
                    await drawn(h, `!!card?.querySelector("[data-rendered-bs-close]")`);
                    const r = await readRun(h);
                    return [r.kind === "run" && r.close?.text === "Close the brainstorm" && r.switchShown, r];
                });

                await step("Close the brainstorm deletes the brainstorm and canvas folders only, and the closed row replaces the card", async () => {
                    const clicked = await h.ev(`(() => {
                        const b = ${CARD}?.querySelector("[data-rendered-bs-close]");
                        if (!b || b.disabled) return false;
                        b.click();
                        return true;
                    })()`);
                    const closed = await polishWaitFor(h, `${GONE}?.getAttribute("data-rendered-bs-gone") === "closed"`, BS_POLL_WAIT_MS * 2);
                    const r = await readGone(h);
                    await h.shot(SHOT(6, "closed"));
                    const after = {
                        brainstorm: existsSync(brainstormDir),
                        canvas: existsSync(canvasDir),
                        sibling: existsSync(sibling),
                    };
                    const ok =
                        clicked &&
                        closed &&
                        r.text === `You closed the brainstorm · its file and the ${CANVAS} canvas were deleted` &&
                        !r.run &&
                        !r.switchShown &&
                        !after.brainstorm &&
                        !after.canvas &&
                        after.sibling;
                    return [ok, { clicked, closed, after, ...r }];
                });

                await step("an unreadable brainstorm with no good file is the unreadable card with the parse error and the path, and stays inside the narrow column", async () => {
                    mkdirSync(brainstormDir, { recursive: true });
                    writeFile(ctx, BAD_FILE);
                    // a fresh state: the poller attaches the roster's brainstorm again and reads the bad file twice
                    await agentPage(
                        h,
                        `const S = await mod("app/view/agents/brainstormstore.ts");
                        S.detachBrainstorm(${JSON.stringify(ctx.agentId)});
                        return true;`
                    );
                    const shown = await polishWaitFor(h, `${GONE}?.getAttribute("data-rendered-bs-gone") === "unreadable"`, BS_POLL_WAIT_MS * 3);
                    const error = await brainstormError(h, ctx);
                    const narrowed = await narrow(h);
                    const r = await readGone(h);
                    await h.shot(SHOT(7, "unreadable"));
                    const widened = await widen(h);
                    const ok =
                        shown &&
                        error != null &&
                        r.kind === "gone" &&
                        r.text.startsWith("Arc could not read this brainstorm") &&
                        r.text.includes(error) &&
                        r.text.includes("brainstorm.json") &&
                        narrowed &&
                        r.compact === true &&
                        r.inside === true &&
                        widened;
                    return [ok, { shown, error, narrowed, widened, ...r }];
                });
            }
        ),
    ];
};
