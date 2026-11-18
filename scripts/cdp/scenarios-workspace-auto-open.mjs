// Scenario `workspace-auto-open`: what the Rendered view opens beside the transcript by itself when a turn ends
// (autoopenmodel.ts). One fixture claude agent with a canvas and no brainstorm (RBS_KIT), whose project is a git repo
// with an uncommitted change. Each step appends a turn to its transcript, or stamps its block's last edit, as the agent
// would; the started run ids are fixtures no store knows, so a Run tab shows its id. The last step makes the agent a
// lead of a held run (arrangeHeldRun), which no model ever starts.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assistantText, toolResult, toolUse } from "./agent-page-fixtures.mjs";
import { RBS_KIT } from "./scenarios-rendered-brainstorm.mjs";
import { arrangeHeldRun, git, teardownHeldRuns } from "./scenarios-shared.mjs";

const NAME = "workspace-auto-open";
const TOPIC = `auto-open-${Date.now().toString(36)}`;
const SHOT = (n, what) => `cdp-shots/workspace-auto-open-${n}-${what}.png`;
// long enough for the transcript tail and the effect to have acted, were anything going to open
const QUIET_MS = 2500;
// a first git read in a new repo can take a while
const GIT_WAIT_MS = 20_000;
const { agentPage, polishWaitFor, polishNap, WAIT_MS } = RBS_KIT;

const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
const tabSel = (key) => `[data-workspace-tab="${key}"]`;

let turn = 0;
const bashCall = (command, output) => {
    const id = `toolu_auto_open_${++turn}`;
    return [toolUse(id, "Bash", { command }), toolResult(id, output)];
};
const runStart = (runId) => bashCall(`wsh runs start "Auto-open fixture ${runId}"`, `started run ${runId} (quick, pending) in fx\n`);
const append = (ctx, lines) => appendFileSync(ctx.transcript, lines.join("\n") + "\n");

const store = (h, ctx, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const C = await mod("app/view/agents/canvasstore.ts");
        const id = ${JSON.stringify(ctx.agentId)};
        const ws = () => globalStore.get(W.workspaceAtom(id));
        ${body}`
    );

const readPane = (h, ctx) =>
    store(
        h,
        ctx,
        `const s = ws();
        const tabs = s.tabs.map((t) => (t.kind === "run" ? "run:" + t.runId : t.kind));
        return {
            shape: ${PANE}?.dataset.workspacePane ?? null,
            tabs,
            active: s.active,
            unseen: s.unseen,
            dots: tabs.filter((k) => document.querySelector('${tabSel("KEY")}'.replace("KEY", k) + " [data-workspace-tab-unseen]") != null),
            stripDot: document.querySelector("[data-workspace-strip-unseen]") != null,
        };`
    );

const waitPane = (h, ctx, cond, ms = WAIT_MS) =>
    store(h, ctx, `return until(() => { const s = ws(); const tabs = s.tabs.map((t) => (t.kind === "run" ? "run:" + t.runId : t.kind)); return ${cond}; }, ${ms});`);

const patchAgent = (h, ctx, patch) =>
    agentPage(h, `window.__cockpitRosterFixture?.patch(${JSON.stringify(ctx.agentId)}, ${JSON.stringify(patch)}); return true;`);

const stampEdit = (h, ctx) => h.rpc("setmeta", { oref: `block:${ctx.blockId}`, meta: { "agent:lasteditts": Date.now() } });

const closeAll = (h, ctx) =>
    store(h, ctx, `for (const t of [...ws().tabs]) W.closeWorkspaceTab(id, t.kind === "run" ? "run:" + t.runId : t.kind); return true;`);

async function realClick(h, expr) {
    const at = await h.ev(`(() => { const r = (${expr})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    if (at == null) return false;
    await h.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await h.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", buttons: 1, clickCount: 1 });
    await h.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", buttons: 0, clickCount: 1 });
    return true;
}

const base = RBS_KIT.scenario(NAME, { noBrainstorm: true, topic: TOPIC }, async (h, ctx, step) => {
    // the project is a repo with a change, so the agent's edits leave a diff for Changes to open
    git(ctx.cwd, "init", "-q", "--initial-branch=main");
    writeFileSync(join(ctx.cwd, "notes.md"), "notes\n");
    git(ctx.cwd, "add", "notes.md");
    git(ctx.cwd, "commit", "-q", "-m", "seed");
    writeFileSync(join(ctx.cwd, "notes.md"), "notes\nan edit the agent made\n");
    await h.rpc("setmeta", { oref: `block:${ctx.blockId}`, meta: { "cmd:cwd": ctx.cwd } });
    const project = join(ctx.cwd, ".superpowers", "design", TOPIC, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "canvas.json"), JSON.stringify({ boards: { "Main.dc.html": { w: 1440, h: 900 } }, order: ["Main.dc.html"] }));
    writeFileSync(join(project, "Main.dc.html"), `<!doctype html><title>Main</title><h1 style="font:64px sans-serif;color:#e6e9ed">Main</h1>`);

    await step("a turn that reveals a canvas and starts a run opens Canvas, the run behind it with a new dot, the diff left in the message box", async () => {
        // one turn: the agent edits, reveals and starts a run while working, then stops
        await patchAgent(h, ctx, { state: "working" });
        await store(h, ctx, `C.attachCanvas(id, { topic: ${JSON.stringify(TOPIC)}, dir: ${JSON.stringify(join(ctx.cwd, ".superpowers", "design", TOPIC))}, projectDir: ${JSON.stringify(ctx.cwd)} }, Date.now()); return true;`);
        await stampEdit(h, ctx);
        append(ctx, [...bashCall(`wsh ui reveal canvas:${TOPIC}`, ""), ...runStart("fx-auto-1"), assistantText("The mockup is up and the run started.")]);
        const diffRow = await polishWaitFor(h, `document.querySelector("[data-composer-changes]") != null`, GIT_WAIT_MS);
        await patchAgent(h, ctx, { state: "idle", idleSince: Date.now() });
        const opened = await waitPane(h, ctx, `s.active === "canvas" && tabs.includes("run:fx-auto-1")`);
        await polishNap(QUIET_MS);
        const p = await readPane(h, ctx);
        await h.shot(SHOT(1, "canvas-wins"));
        const ok =
            diffRow &&
            opened &&
            p.shape === "open" &&
            p.tabs.join() === "canvas,run:fx-auto-1" &&
            p.unseen.join() === "run:fx-auto-1" &&
            p.dots.join() === "run:fx-auto-1";
        return [ok, { diffRow, ...p }];
    });

    await step("showing the marked tab clears its dot", async () => {
        const clicked = await realClick(h, `document.querySelector('${tabSel("run:fx-auto-1")} [role="tab"]')`);
        const cleared = await waitPane(h, ctx, `s.active === "run:fx-auto-1" && s.unseen.length === 0`);
        const p = await readPane(h, ctx);
        return [clicked && cleared && p.dots.length === 0, p];
    });

    await step("while the agent works nothing opens; its turn's end adds the run behind the shown tab, marked", async () => {
        await patchAgent(h, ctx, { state: "working" });
        append(ctx, runStart("fx-auto-2"));
        await polishNap(QUIET_MS);
        const during = await readPane(h, ctx);
        await patchAgent(h, ctx, { state: "idle", idleSince: Date.now() });
        const added = await waitPane(h, ctx, `tabs.includes("run:fx-auto-2")`);
        await polishNap(700);
        const after = await readPane(h, ctx);
        await h.shot(SHOT(2, "pane-in-use"));
        const ok =
            !during.tabs.includes("run:fx-auto-2") &&
            added &&
            after.active === "run:fx-auto-1" &&
            after.unseen.join() === "run:fx-auto-2" &&
            after.dots.join() === "run:fx-auto-2";
        return [ok, { during, after }];
    });

    await step("a collapsed pane stays collapsed, and its strip shows the new dot", async () => {
        await store(h, ctx, `W.setWorkspaceCollapsed(id, true); return true;`);
        append(ctx, runStart("fx-auto-3"));
        const added = await waitPane(h, ctx, `tabs.includes("run:fx-auto-3")`);
        await polishNap(700);
        const p = await readPane(h, ctx);
        await h.shot(SHOT(3, "strip"));
        return [added && p.shape === "strip" && p.unseen.includes("run:fx-auto-3") && p.stripDot, p];
    });

    await step("an edit alone opens Changes on an empty pane", async () => {
        await closeAll(h, ctx);
        await polishWaitFor(h, `${PANE} == null`, WAIT_MS);
        await stampEdit(h, ctx);
        const opened = await waitPane(h, ctx, `s.active === "changes"`, GIT_WAIT_MS);
        await polishNap(700);
        const p = await readPane(h, ctx);
        await h.shot(SHOT(4, "changes"));
        return [opened && p.shape === "open" && p.tabs.join() === "changes", p];
    });

    await step("closing the Changes tab auto-open put there keeps the next edit's Changes closed", async () => {
        const closed = await realClick(h, `document.querySelector('${tabSel("changes")} [data-workspace-tab-close]')`);
        const gone = await polishWaitFor(h, `${PANE} == null`, WAIT_MS);
        await polishNap(1100);
        await stampEdit(h, ctx);
        await polishNap(QUIET_MS);
        const p = await readPane(h, ctx);
        return [closed && gone && p.tabs.length === 0, p];
    });

    await step("a lead's turn end opens its own run", async () => {
        const run = await arrangeHeldRun(h, ctx, { key: "auto-open-lead", title: "Auto-open lead fixture", tasks: [{ id: "t-1", label: "do nothing" }] });
        await patchAgent(h, ctx, { runId: run.runId });
        const opened = await waitPane(h, ctx, `s.active === ${JSON.stringify(`run:${run.runId}`)}`);
        await polishNap(700);
        const p = await readPane(h, ctx);
        await h.shot(SHOT(5, "lead-run"));
        return [opened && p.shape === "open" && p.tabs.join() === `run:${run.runId}`, p];
    });
});

export const workspaceAutoOpen = {
    ...base,
    async teardown(h, ctx) {
        try {
            await closeAll(h, ctx);
            await store(h, ctx, `C.detachCanvas(id); return true;`);
        } catch (e) {
            console.error(`${NAME} teardown: close the pane and the canvas failed: ${e?.message ?? e}`);
        }
        await teardownHeldRuns(h, ctx, NAME);
        await base.teardown(h, ctx);
    },
};
