// Scenario rendered-bs-run: a brainstorm's run in the Rendered transcript is its Started run row, with no card under
// the transcript; the run's start opens the workspace pane's Brainstorm tab by itself (autoopenmodel), the row's Open
// run adds the run's tab beside, Close the brainstorm from the Brainstorm tab leaves the closed row, and the gone card
// covers a removed brainstorm (with the header's Brainstorm switch gone) and an unreadable one, each drawn on the shared
// card header and folded to its one row while the Brainstorm tab shows. kit is scenarios-rendered-brainstorm.mjs's
// RBS_KIT.
//
// The run is page-only: its run and dag objects are written into the page's object cache (updateWaveObject), so no
// engine runs; the pane reads them as it reads a real run. Close deletes real folders in the temp project.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assistantText, userText } from "./agent-page-fixtures.mjs";

const NAME = "rendered-bs-run";
const SHOT = (n, what) => `cdp-shots/${NAME}-${n}-${what}.png`;
const TOPIC = "run-memory-pressure";
const CANVAS = "final-queue";
const RUN_ID = "3f9a1c2e-5b7d-4e21-9a8c-0d6f3b1a7e42";
const DAG_ID = "7a2b9c40-1d3e-4f56-8a7b-9c0d1e2f3a4b";
const SHORT = RUN_ID.slice(0, 8);
const SHA = "9c1e2f0a1b2c3d4e5f60718293a4b5c6d7e8f901";
const TASKS = 7;
const LANDED = 4;
const SWITCH = `document.querySelector('[aria-label="Show terminal or brainstorm"]')`;
const BAD_FILE = `{ "v": 1, "title": "Run memory pressure", "parts": [`;
// the one-row card's bound: workspace-brainstorm-cards' ROW_MAX_PX (a header alone, 46px wide and 69px wrapped)
const ROW_MAX_PX = 80;
const REMOVED_TITLE = `${TOPIC}'s brainstorm file is gone`;
const UNREADABLE_TITLE = "Arc could not read this brainstorm";
const LAST_REPLY = "Run 3f9a1c2e is planning. I will answer here while it builds.";
// the line Arc sends once the run starts (brainstormLine's run), then a later exchange
const TRANSCRIPT = [
    userText("Let's think the memory pressure alerts through before building."),
    assistantText("The spec is written. Start the run when you are ready."),
    userText(`brainstorm: run ${RUN_ID}`),
    assistantText(LAST_REPLY),
];

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
    const { scenario, writeFile, narrow, widen, agentPage, polishWaitFor, HOST, PANE, RV, WAIT_MS, BS_POLL_WAIT_MS } = kit;
    const ROW = `${RV}?.querySelector('[data-pane-action="run"]')`;
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
    const MERGED_PASSED = { status: "done", landed: TASKS, final: { state: "passed", round: 1 }, land: { state: "landed", commit: SHA } };

    // the run's row and what sits under the transcript
    const readRow = (h) =>
        h.ev(`(() => {
            const flat = (el) => (el?.innerText ?? "").replace(/\\s+/g, " ").trim();
            const host = ${HOST};
            const row = ${ROW};
            const feed = ${RV}?.querySelector("[data-rendered-feed]");
            const reply = [...(feed?.querySelectorAll("*") ?? [])].find(
                (el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(LAST_REPLY)}
            );
            return {
                kind: host?.getAttribute("data-rendered-bs-card") ?? null,
                runCard: ${RV}?.querySelector("[data-rendered-bs-run]") != null,
                row: flat(row),
                open: flat(row?.querySelector("[data-run-row-open]")),
                replyAfterRow: row != null && reply != null && !!(row.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING),
                hostEmpty: (host?.innerText ?? "").trim() === "",
                switchShown: ${SWITCH} != null,
            };
        })()`);

    // the Brainstorm tab on or off, as the pane's own tab strip does
    const brainstormTab = (h, ctx, on) =>
        agentPage(
            h,
            `const W = await mod("app/view/agents/workspacestore.ts");
            ${on ? `W.openWorkspaceTab(${JSON.stringify(ctx.agentId)}, { kind: "brainstorm" });` : `W.closeWorkspaceTab(${JSON.stringify(ctx.agentId)}, "brainstorm");`}
            return true;`
        );

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
                head: flat(g?.querySelector("[data-rendered-bs-head]")),
                body: flat(g?.querySelector("[data-rendered-bs-body]")),
                row: g?.querySelector("[data-rendered-bs-row]") != null,
                rowTitle: flat(g?.querySelector("[data-rendered-bs-row-title]")),
                height: box != null ? Math.round(box.height) : null,
                errorFrame: g?.querySelector("[data-rendered-bs-frame]")?.classList.contains("border-error/45") ?? null,
                inside: box != null && col != null ? box.left >= col.left - 1 && box.right <= col.right + 1 : null,
                switchShown: ${SWITCH} != null,
            };
        })()`);

    const brainstormError = (h, ctx) =>
        agentPage(
            h,
            `const S = await mod("app/view/agents/brainstormstore.ts");
            return S.getBrainstorm(${JSON.stringify(ctx.agentId)})?.error ?? null;`
        );

    return [
        scenario(
            NAME,
            { topic: TOPIC, canvas: CANVAS, boards: ["Main.dc.html"], file: RUN_FILE, transcript: TRANSCRIPT },
            async (h, ctx, step) => {
                const brainstormDir = dirname(ctx.file);
                const canvasDir = join(ctx.cwd, ".superpowers", "design", CANVAS);
                const sibling = join(ctx.cwd, ".superpowers", "keep.txt");
                writeFileSync(sibling, "stays\n");

                await step("the run's line is the Started run row with Open run, and nothing draws under the agent's last reply", async () => {
                    await setRun(h, BUILDING);
                    const shown = await polishWaitFor(h, `(${ROW}?.innerText ?? "").includes("Open run")`, WAIT_MS);
                    const r = await readRow(h);
                    await h.shot(SHOT(1, "row"));
                    const ok =
                        shown &&
                        r.kind === "none" &&
                        !r.runCard &&
                        r.row.startsWith(`Started run ${SHORT} from the spec`) &&
                        r.open === "Open run" &&
                        r.replyAfterRow &&
                        r.hostEmpty &&
                        !r.switchShown;
                    return [ok, { shown, ...r }];
                });

                await step("the run's start opened the Brainstorm tab by itself; the row's Open run adds the run's tab beside, and closing it goes back to the Brainstorm tab's Run step", async () => {
                    const auto = await polishWaitFor(h, `${PANE}?.querySelector("[data-brainstorm-run]") != null`, WAIT_MS);
                    const clicked = await h.ev(`(() => {
                        const b = ${ROW}?.querySelector("[data-run-row-open] button");
                        if (!b) return false;
                        b.click();
                        return true;
                    })()`);
                    const opened = await polishWaitFor(h, `document.querySelector('[data-workspace-run="${RUN_ID}"]') != null`, WAIT_MS);
                    const r = await agentPage(
                        h,
                        `const W = await mod("app/view/agents/workspacestore.ts");
                        const s = globalStore.get(W.workspaceAtom(${JSON.stringify(ctx.agentId)}));
                        const out = { tabs: s.tabs.map((t) => t.kind), active: s.active };
                        W.closeWorkspaceTab(${JSON.stringify(ctx.agentId)}, "run:${RUN_ID}");
                        return out;`
                    );
                    const back = await polishWaitFor(h, `${PANE}?.querySelector("[data-brainstorm-run]") != null`, WAIT_MS);
                    await h.shot(SHOT(2, "pane"));
                    const ok =
                        auto &&
                        clicked &&
                        opened &&
                        r.active === `run:${RUN_ID}` &&
                        JSON.stringify(r.tabs) === JSON.stringify(["brainstorm", "run"]) &&
                        back;
                    return [ok, { auto, clicked, opened, back, ...r }];
                });

                await step("a removed brainstorm with no close record is the gone card on the Brainstorm header, its line in the body, and the header draws no Brainstorm switch in Rendered", async () => {
                    // the run's start left the Brainstorm tab open, which folds the card to its row
                    await brainstormTab(h, ctx, false);
                    rmSync(ctx.file);
                    const shown = await polishWaitFor(h, `${GONE}?.getAttribute("data-rendered-bs-gone") === "removed"`, BS_POLL_WAIT_MS * 2);
                    const r = await readGone(h);
                    await h.shot(SHOT(3, "removed"));
                    const ok =
                        shown &&
                        r.kind === "gone" &&
                        !r.row &&
                        r.head === `Brainstorm ${REMOVED_TITLE}` &&
                        r.body.startsWith("It is no longer at") &&
                        r.body.includes("brainstorm.json") &&
                        r.body.endsWith("The answers above stay in the transcript.") &&
                        r.inside === true &&
                        !r.switchShown;
                    return [ok, { shown, ...r }];
                });

                await step("with the Brainstorm tab open, the removed card folds to the one row: Brainstorm, the topic, its title and Open brainstorm", async () => {
                    await brainstormTab(h, ctx, true);
                    const folded = await polishWaitFor(h, `${GONE}?.querySelector("[data-rendered-bs-row]") != null`, WAIT_MS);
                    const r = await readGone(h);
                    await h.shot(SHOT(3, "removed-row"));
                    await brainstormTab(h, ctx, false);
                    const ok =
                        folded &&
                        r.which === "removed" &&
                        r.head === `Brainstorm ${TOPIC} ${REMOVED_TITLE} Open brainstorm` &&
                        r.rowTitle === REMOVED_TITLE &&
                        r.body === "" &&
                        r.height != null &&
                        r.height < ROW_MAX_PX;
                    return [ok, { folded, ...r }];
                });

                await step("the file back, merged: still no card under the transcript, and no header switch in Rendered", async () => {
                    writeFile(ctx, { ...RUN_FILE });
                    await setRun(h, MERGED_PASSED);
                    const none = await polishWaitFor(h, `${HOST}?.getAttribute("data-rendered-bs-card") === "none"`, BS_POLL_WAIT_MS * 2);
                    const r = await readRow(h);
                    return [none && !r.runCard && r.row.startsWith(`Started run ${SHORT}`) && !r.switchShown, { none, ...r }];
                });

                await step("Close the brainstorm in the pane's Brainstorm tab deletes the brainstorm and canvas folders only, and the closed row ends the transcript", async () => {
                    await agentPage(
                        h,
                        `const S = await mod("app/view/agents/brainstormstore.ts");
                        S.openBrainstormAt(${JSON.stringify(ctx.agentId)}, {});
                        return true;`
                    );
                    const ready = await polishWaitFor(h, `${PANE}?.querySelector("[data-brainstorm-close]")?.disabled === false`, WAIT_MS);
                    const clicked = await h.ev(`(() => {
                        const b = ${PANE}?.querySelector("[data-brainstorm-close]");
                        if (!b || b.disabled) return false;
                        b.click();
                        return true;
                    })()`);
                    const closed = await polishWaitFor(h, `${GONE}?.getAttribute("data-rendered-bs-gone") === "closed"`, BS_POLL_WAIT_MS * 2);
                    const r = await readGone(h);
                    await h.shot(SHOT(4, "closed"));
                    const after = {
                        brainstorm: existsSync(brainstormDir),
                        canvas: existsSync(canvasDir),
                        sibling: existsSync(sibling),
                    };
                    const ok =
                        ready &&
                        clicked &&
                        closed &&
                        r.text === `You closed the brainstorm · its file and the ${CANVAS} canvas were deleted` &&
                        !r.switchShown &&
                        !after.brainstorm &&
                        !after.canvas &&
                        after.sibling;
                    return [ok, { ready, clicked, closed, after, ...r }];
                });

                await step("an unreadable brainstorm with no good file is the error-bordered card with the parse error and the path, and stays inside the narrow column", async () => {
                    await brainstormTab(h, ctx, false);
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
                    await h.shot(SHOT(5, "unreadable"));
                    const widened = await widen(h);
                    const ok =
                        shown &&
                        error != null &&
                        r.kind === "gone" &&
                        !r.row &&
                        r.errorFrame === true &&
                        r.head === `Brainstorm ${UNREADABLE_TITLE}` &&
                        r.body.includes(error) &&
                        r.body.includes("brainstorm.json") &&
                        narrowed &&
                        r.compact === true &&
                        r.inside === true &&
                        widened;
                    return [ok, { shown, error, narrowed, widened, ...r }];
                });

                await step("with the Brainstorm tab open, the unreadable card folds to the one row: Brainstorm, the topic, its title and Open brainstorm", async () => {
                    await brainstormTab(h, ctx, true);
                    const folded = await polishWaitFor(h, `${GONE}?.querySelector("[data-rendered-bs-row]") != null`, WAIT_MS);
                    const r = await readGone(h);
                    await h.shot(SHOT(6, "unreadable-row"));
                    await brainstormTab(h, ctx, false);
                    const ok =
                        folded &&
                        r.which === "unreadable" &&
                        r.head === `Brainstorm ${TOPIC} ${UNREADABLE_TITLE} Open brainstorm` &&
                        r.rowTitle === UNREADABLE_TITLE &&
                        r.body === "" &&
                        r.height != null &&
                        r.height < ROW_MAX_PX;
                    return [ok, { folded, ...r }];
                });
            }
        ),
    ];
};
