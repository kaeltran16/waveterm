// Scenario `workspace-docs`: the workspace pane's Docs tab (Task 1 of docs/superpowers/plans/2026-11-20-workspace-surfaces.md;
// spec 2026-11-20-workspace-surfaces-design.md). The roster is a fixture claude agent backed by a real tab with no
// controller, in the Rendered view. The steps open the tab through the workspace store, as a click will; later tasks add
// the list, the rendered doc and the pushes to this file. The default view and the viewport are put back in teardown.

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

const NAME = "workspace-docs";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than a tab's entrance and the body's view swap
const SETTLE_MS = 700;
const PROMPT = "Write the plan down.";
const REPLY = "The plan is in the docs.";

const TAB_SEL = `[data-workspace-tab="docs"]`;

const page = (h, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const ws = (id) => globalStore.get(W.workspaceAtom(id));
        ${body}`
    );

export const workspaceDocs = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-docs-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const transcript = writeTranscript(join(ctx.dir, "transcripts"), `workspace-docs-${tag}`, [
                userText(PROMPT),
                assistantText(REPLY),
            ]);
            await h.goto("agent");
            await pinDefaultView(h, "rendered");
            const a = await makeTab(h, ctx, { label: `workspace-docs-${tag}`, blockMeta: { view: "term", controller: null } });
            ctx.aId = a.tabId;
            await setRoster(h, [
                {
                    id: a.tabId,
                    name: `workspace-docs-${tag}`,
                    project: "linkshelf",
                    task: "workspace docs fixture",
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

        await step("docs tab in strip: it reads Docs with the file-text icon and is active", async () => {
            await page(h, `W.openWorkspaceTab(${A}, { kind: "docs", selected: null }); return true;`);
            const drawn = await polishWaitFor(h, `document.querySelector('${TAB_SEL} [role="tab"]') != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await page(
                h,
                `const tab = document.querySelector('${TAB_SEL} [role="tab"]');
                const icon = tab?.querySelector("svg");
                return {
                    tabs: ws(${A}).tabs.map((t) => t.kind),
                    active: ws(${A}).active,
                    label: tab?.textContent.trim() ?? null,
                    selected: tab?.getAttribute("aria-selected") ?? null,
                    icon: icon?.getAttribute("class") ?? null,
                    body: document.querySelector("[data-workspace-docs]") != null,
                };`
            );
            await h.shot("cdp-shots/workspace-docs-tab.png");
            const ok =
                drawn &&
                f.tabs.length === 1 &&
                f.tabs[0] === "docs" &&
                f.active === "docs" &&
                f.label === "Docs" &&
                f.selected === "true" &&
                (f.icon ?? "").includes("lucide-file-text") &&
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
        if (ctx.aId) {
            await step("close the workspace tabs", () =>
                page(h, `W.closeWorkspaceTab(${JSON.stringify(ctx.aId)}, "docs"); return true;`)
            );
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("restore the default view", () => restoreDefaultView(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};
