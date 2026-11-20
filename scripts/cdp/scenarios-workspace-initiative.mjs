// Scenario `workspace-initiative`: the workspace pane's Initiative tab (Task 1 of
// docs/superpowers/plans/2026-11-20-workspace-surfaces.md; spec 2026-11-20-workspace-surfaces-design.md). The roster is a
// fixture claude agent backed by a real tab with no controller, in the Rendered view, and a fixture initiative made over
// RPC. The steps open the tab through the workspace store, as a click will; later tasks add the chunk rows and the gone
// state to this file. Teardown deletes the initiative and puts the default view and the viewport back.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    agentPage,
    assistantText,
    closeTabs,
    focusAgent,
    makeTab,
    pinDefaultView,
    restoreDefaultView,
    restoreRoster,
    setRoster,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishNap, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "workspace-initiative";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than a tab's entrance and the body's view swap
const SETTLE_MS = 700;
const PROMPT = "Where does the plan stand?";
const REPLY = "Two chunks are left.";
const TITLE = "verify workspace-initiative: stats and dedupe";
const CHUNKS = ["Fixture", "Count", "Verify"];

const page = (h, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const ws = (id) => globalStore.get(W.workspaceAtom(id));
        ${body}`
    );

export const workspaceInitiative = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-initiative-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const effort = await h.rpc("effortcreate", { title: TITLE, chunks: CHUNKS.map((label) => ({ label })) });
            ctx.effortId = effort.effortoid;
            const transcript = writeTranscript(join(ctx.dir, "transcripts"), `workspace-initiative-${tag}`, [
                userText(PROMPT),
                assistantText(REPLY),
            ]);
            await h.goto("agent");
            await pinDefaultView(h, "rendered");
            const a = await makeTab(h, ctx, { label: `workspace-initiative-${tag}`, blockMeta: { view: "term", controller: null } });
            ctx.aId = a.tabId;
            await setRoster(h, [
                {
                    id: a.tabId,
                    name: `workspace-initiative-${tag}`,
                    project: "linkshelf",
                    task: "workspace initiative fixture",
                    state: "idle",
                    agent: "claude",
                    model: "claude-opus-5-5",
                    blockId: a.blockId,
                    transcriptPath: transcript,
                },
            ]);
            await focusAgent(h, ctx.aId);
            if (!(await polishWaitFor(h, `document.querySelector("[data-rendered-view]") != null`, WAIT_MS))) {
                throw new Error("the Rendered view never drew");
            }
        } catch (err) {
            ctx.arrangeError = String(err?.message ?? err);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
        if (ctx.arrangeError != null) {
            rec(`${NAME}: arrange`, false, ctx.arrangeError);
            return steps;
        }
        // one throwing step is one FAIL, not the end of the run
        const step = async (name, fn) => {
            try {
                const [ok, detail] = await fn();
                rec(name, ok, detail);
            } catch (err) {
                rec(name, false, `threw: ${err?.message ?? err}`);
            }
        };
        const A = JSON.stringify(ctx.aId);
        const key = `initiative:${ctx.effortId}`;
        const tabSel = `[data-workspace-tab=${JSON.stringify(key)}]`;

        await step("initiative tab in strip: it reads Initiative · <title> with the flag icon and is active", async () => {
            // the tab's own load is a later task's, so the title is cached the way the Brief's peek caches it
            await page(
                h,
                `const E = await mod("app/view/jarvis/effortstore.ts");
                await E.loadEffortDetail("effort:" + ${JSON.stringify(ctx.effortId)});
                W.openWorkspaceTab(${A}, { kind: "initiative", effortId: ${JSON.stringify(ctx.effortId)} });
                return true;`
            );
            const drawn = await polishWaitFor(h, `document.querySelector('${tabSel} [role="tab"]') != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await page(
                h,
                `const tab = document.querySelector('${tabSel} [role="tab"]');
                const icon = tab?.querySelector("svg");
                return {
                    tabs: ws(${A}).tabs.map((t) => t.kind),
                    active: ws(${A}).active,
                    label: tab?.textContent.trim() ?? null,
                    selected: tab?.getAttribute("aria-selected") ?? null,
                    icon: icon?.getAttribute("class") ?? null,
                    body: document.querySelector("[data-workspace-initiative=" + JSON.stringify(${JSON.stringify(ctx.effortId)}) + "]") != null,
                };`
            );
            await h.shot("cdp-shots/workspace-initiative-tab.png");
            const ok =
                drawn &&
                f.tabs.length === 1 &&
                f.active === key &&
                f.label === `Initiative · ${TITLE}` &&
                f.selected === "true" &&
                (f.icon ?? "").includes("lucide-flag") &&
                f.body;
            return [ok, { drawn, ...f }];
        });

        return steps;
    },
    async teardown(h, ctx) {
        const step = async (what, fn) => {
            try {
                await fn();
            } catch (e) {
                console.error(`${NAME} teardown: ${what} failed: ${e?.message ?? e}`);
            }
        };
        if (ctx.aId && ctx.effortId) {
            await step("close the workspace tabs", () =>
                page(h, `W.closeWorkspaceTab(${JSON.stringify(ctx.aId)}, ${JSON.stringify(`initiative:${ctx.effortId}`)}); return true;`)
            );
        }
        if (ctx.effortId) {
            await step("delete the initiative", () => h.rpc("effortdelete", { effortoid: ctx.effortId }));
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("restore the default view", () => restoreDefaultView(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};
