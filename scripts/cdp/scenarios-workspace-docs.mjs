// Scenario `workspace-docs`: the workspace pane's Docs tab (Tasks 1 and 3 of
// docs/superpowers/plans/2026-11-20-workspace-surfaces.md; spec 2026-11-20-workspace-surfaces-design.md; boards Main and
// the Docs half of S1-States). The roster is a fixture claude agent backed by a real tab with no controller, in the
// Rendered view, whose transcript writes two Markdown docs and a .go file in a temp folder and cites a doc and the .go
// file in its reply. The steps draw the list and the rendered doc, route reply links, the step card and Open raw, narrow
// the pane, and delete a doc. The default view, the pane width and the viewport are put back in teardown.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    toolResult,
    toolUse,
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
const WIDE_PX = 600;
const NARROW_PX = 360;
// the spec is written, then the .go file, then the plan, then the spec is edited: newest first is spec, plan
const SPEC_REL = "docs/specs/2026-11-20-shelf-design.md";
const SPEC_TITLE = "Shelf tags design";
const PLAN_REL = "docs/plans/2026-11-20-shelf.md";
const PLAN_TITLE = "Shelf tags plan";
const GO_REL = "internal/shelf/shelf.go";
const GO_LINE = 3;
// the spec's Write step row
const STEP_HEAD = "Wrote 2026-11-20-shelf-design.md";
const MINUTE_MS = 60_000;

const TAB_SEL = `[data-workspace-tab="docs"]`;
const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
const ROWS = `[...(${PANE}?.querySelectorAll("[data-docs-row]") ?? [])]`;
// the app's Markdown draws an h1 as a .heading.is-1 block
const H1 = `(${PANE}?.querySelector("[data-docs-body] .heading.is-1")?.textContent ?? "").trim()`;

const page = (h, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const M = await mod("app/view/agents/workspacemodel.ts");
        const D = await mod("app/view/agents/workspacedocsstore.ts");
        const P = await mod("util/paths.ts");
        const ws = (id) => globalStore.get(W.workspaceAtom(id));
        const activeTab = (id) => ws(id).tabs.find((t) => M.tabKey(t) === ws(id).active) ?? null;
        ${body}`
    );

// the transcript's records: each write a tool call and its result, at its own minute, in the repo as cwd
function fixtureLines(repo) {
    const abs = (rel) => join(repo, rel);
    const t0 = Date.now() - 30 * MINUTE_MS;
    const opts = (minute) => ({ cwd: repo, ts: new Date(t0 + minute * MINUTE_MS).toISOString() });
    const call = (id, name, input, minute) => [toolUse(id, name, input, opts(minute)), toolResult(id, "ok", opts(minute))];
    const reply = `The plan is in \`${PLAN_REL}\`, and the shelf type in \`${GO_REL}:${GO_LINE}\`.`;
    return [
        userText(PROMPT, opts(0)),
        ...call("w-spec", "Write", { file_path: abs(SPEC_REL), content: "" }, 1),
        ...call("w-go", "Write", { file_path: abs(GO_REL), content: "" }, 2),
        ...call("w-plan", "Write", { file_path: abs(PLAN_REL), content: "" }, 3),
        ...call("e-spec", "Edit", { file_path: abs(SPEC_REL), old_string: "Tags", new_string: "tags" }, 4),
        assistantText(reply, opts(5)),
    ];
}

function makeRepo(repo) {
    for (const rel of [SPEC_REL, PLAN_REL, GO_REL]) {
        mkdirSync(join(repo, rel, ".."), { recursive: true });
    }
    writeFileSync(join(repo, SPEC_REL), `# ${SPEC_TITLE}\n\n## Intent\n\nTags group links on a shelf.\n`);
    writeFileSync(join(repo, PLAN_REL), `# ${PLAN_TITLE}\n\n## Task 1\n\nAdd the tag column.\n`);
    writeFileSync(join(repo, GO_REL), "package shelf\n\ntype Shelf struct{ Tags []string }\n");
}

export const workspaceDocs = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-docs-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            ctx.repo = join(ctx.dir, "linkshelf");
            makeRepo(ctx.repo);
            ctx.spec = join(ctx.repo, SPEC_REL);
            ctx.plan = join(ctx.repo, PLAN_REL);
            const transcript = writeTranscript(join(ctx.dir, "transcripts"), `workspace-docs-${tag}`, fixtureLines(ctx.repo));
            ctx.width = await page(h, `return globalStore.get(W.workspaceWidthAtom);`);
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

        const SPEC = JSON.stringify(ctx.spec);
        const PLAN = JSON.stringify(ctx.plan);
        // the shown doc: the active tab, its selection, and the rendered h1
        const shown = () =>
            page(
                h,
                `const t = activeTab(${A});
                return {
                    active: ws(${A}).active,
                    kind: t?.kind ?? null,
                    selected: t?.selected ?? null,
                    h1: ${H1},
                    picked: ${PANE}?.querySelector('[data-docs-row][aria-selected="true"] [data-docs-name]')?.textContent ?? null,
                };`
            );
        const closeAll = () => page(h, `for (const t of [...ws(${A}).tabs]) W.closeWorkspaceTab(${A}, M.tabKey(t)); return true;`);

        await step("docs list and rendered doc: at 600px both docs list newest first with folder and verb, the newest rendered with an h1", async () => {
            await page(h, `globalStore.set(W.workspaceWidthAtom, ${WIDE_PX}); return true;`);
            await polishWaitFor(h, `${ROWS}.length === 2 && ${H1} === ${JSON.stringify(SPEC_TITLE)}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await page(
                h,
                `const list = ${PANE}?.querySelector('[role="listbox"]');
                return {
                    label: list?.getAttribute("aria-label") ?? null,
                    paneWidth: Math.round(${PANE}?.getBoundingClientRect().width ?? 0),
                    rows: ${ROWS}.map((r) => ({
                        name: r.querySelector("[data-docs-name]")?.textContent ?? null,
                        folder: r.querySelector("[data-docs-folder]")?.innerText ?? null,
                        when: r.querySelector("[data-docs-when]")?.innerText ?? null,
                    })),
                    h1: ${H1},
                    path: ${PANE}?.querySelector("[data-docs-path]")?.textContent ?? null,
                    raw: ${PANE}?.querySelector("[data-docs-open-raw]")?.textContent ?? null,
                };`
            );
            await h.shot("cdp-shots/workspace-docs-list.png");
            const r = f.rows;
            const ok =
                f.label === "Docs written this session" &&
                f.paneWidth === WIDE_PX &&
                r.length === 2 &&
                r[0].name === "2026-11-20-shelf-design.md" &&
                r[0].folder === "docs/specs" &&
                /^edited \d\d:\d\d$/.test(r[0].when ?? "") &&
                r[1].name === "2026-11-20-shelf.md" &&
                r[1].folder === "docs/plans" &&
                /^written \d\d:\d\d$/.test(r[1].when ?? "") &&
                f.h1 === SPEC_TITLE &&
                f.path === SPEC_REL &&
                f.raw === "Open raw";
            return [ok, f];
        });

        await step("pick a doc: clicking the other row renders it", async () => {
            await h.ev(`${ROWS}[1]?.click()`);
            await polishWaitFor(h, `${H1} === ${JSON.stringify(PLAN_TITLE)}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await shown();
            const same = await page(h, `return P.sameRepoPath(activeTab(${A})?.selected ?? "", ${PLAN});`);
            await h.shot("cdp-shots/workspace-docs-pick.png");
            return [f.h1 === PLAN_TITLE && f.picked === "2026-11-20-shelf.md" && same, { ...f, same }];
        });

        await step("reply link opens docs: a reply link to a listed doc activates the Docs tab with that doc selected", async () => {
            await closeAll();
            await h.ev(
                `[...document.querySelectorAll("[data-rendered-view] [data-file-link]")].find((l) => l.getAttribute("data-file-link") === ${JSON.stringify(PLAN_REL)})?.click()`
            );
            await polishWaitFor(h, `${H1} === ${JSON.stringify(PLAN_TITLE)}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await shown();
            const same = await page(h, `return P.sameRepoPath(activeTab(${A})?.selected ?? "", ${PLAN});`);
            return [f.active === "docs" && f.h1 === PLAN_TITLE && same, { ...f, same }];
        });

        await step("step card opens docs: the Write step card's Open full view activates the Docs tab with that doc selected", async () => {
            await closeAll();
            // a finished turn's steps sit folded under its "Worked for" line
            await h.ev(`(() => {
                const fold = document.querySelector('[data-rendered-view] [data-fold][aria-expanded="false"]');
                fold?.click();
                return true;
            })()`);
            await polishWaitFor(h, `document.querySelector("[data-rendered-view] [data-step]") != null`, WAIT_MS);
            const clicked = await h.ev(`(() => {
                const step = [...document.querySelectorAll("[data-rendered-view] [data-step]")].find(
                    (s) => (s.querySelector("[data-step-head]")?.textContent ?? "").trim().startsWith(${JSON.stringify(STEP_HEAD)})
                );
                if (!step) return "no step";
                const head = step.querySelector("[data-step-head]");
                if (head?.getAttribute("aria-expanded") === "false") head.click();
                return "ok";
            })()`);
            await polishWaitFor(
                h,
                `[...document.querySelectorAll("[data-rendered-view] [data-step]")].some((s) => (s.querySelector("[data-step-head]")?.textContent ?? "").trim().startsWith(${JSON.stringify(STEP_HEAD)}) && s.querySelector('button[aria-label="Open full view"]'))`,
                WAIT_MS
            );
            await h.ev(
                `[...document.querySelectorAll("[data-rendered-view] [data-step]")].find((s) => (s.querySelector("[data-step-head]")?.textContent ?? "").trim().startsWith(${JSON.stringify(STEP_HEAD)}) && s.querySelector('button[aria-label="Open full view"]'))?.querySelector('button[aria-label="Open full view"]')?.click()`
            );
            await polishWaitFor(h, `${H1} === ${JSON.stringify(SPEC_TITLE)}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await shown();
            const same = await page(h, `return P.sameRepoPath(activeTab(${A})?.selected ?? "", ${SPEC});`);
            await h.shot("cdp-shots/workspace-docs-step-card.png");
            return [clicked === "ok" && f.active === "docs" && f.h1 === SPEC_TITLE && same, { clicked, ...f, same }];
        });

        await step("non-doc opens file: a link to the .go file opens a File tab", async () => {
            await h.ev(
                `[...document.querySelectorAll("[data-rendered-view] [data-file-link]")].find((l) => l.getAttribute("data-file-link") === ${JSON.stringify(GO_REL)})?.click()`
            );
            await polishWaitFor(h, `${PANE}?.querySelector("[data-workspace-file]") != null`, WAIT_MS);
            const f = await page(h, `const t = activeTab(${A}); return { kind: t?.kind ?? null, path: t?.path ?? null, line: t?.line ?? null };`);
            return [f.kind === "file" && f.path === GO_REL && f.line === GO_LINE, f];
        });

        await step("open raw: Open raw opens a File tab on the doc", async () => {
            await page(h, `W.openWorkspaceTab(${A}, { kind: "docs", selected: null }); return true;`);
            await polishWaitFor(h, `${PANE}?.querySelector("[data-docs-open-raw]") != null`, WAIT_MS);
            await h.ev(`${PANE}?.querySelector("[data-docs-open-raw]")?.click()`);
            await polishWaitFor(h, `${PANE}?.querySelector("[data-workspace-file]") != null`, WAIT_MS);
            const f = await page(
                h,
                `const t = activeTab(${A}); return { kind: t?.kind ?? null, same: P.sameRepoPath(t?.path ?? "", ${SPEC}), line: t?.line ?? null };`
            );
            await polishNap(SETTLE_MS);
            await h.shot("cdp-shots/workspace-docs-open-raw.png");
            return [f.kind === "file" && f.same && f.line === null, f];
        });

        await step("docs narrow: at a 360px pane, no folder and no verb shown", async () => {
            await page(h, `W.openWorkspaceTab(${A}, { kind: "docs", selected: null }); globalStore.set(W.workspaceWidthAtom, ${NARROW_PX}); return true;`);
            await polishWaitFor(h, `${ROWS}.length === 2 && Math.round(${PANE}?.getBoundingClientRect().width ?? 0) === ${NARROW_PX}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await page(
                h,
                `return {
                    paneWidth: Math.round(${PANE}?.getBoundingClientRect().width ?? 0),
                    // innerText on an element that is itself display:none still returns its text
                    folders: ${ROWS}.map((r) => r.querySelector("[data-docs-folder]")?.getClientRects().length ?? 0),
                    when: ${ROWS}.map((r) => r.querySelector("[data-docs-when]")?.innerText ?? ""),
                };`
            );
            await h.shot("cdp-shots/workspace-docs-narrow.png");
            const ok =
                f.paneWidth === NARROW_PX &&
                f.folders.every((n) => n === 0) &&
                f.when.length === 2 &&
                f.when.every((t) => /^\d\d:\d\d$/.test(t));
            await page(h, `globalStore.set(W.workspaceWidthAtom, ${WIDE_PX}); return true;`);
            return [ok, f];
        });

        await step("doc gone: after deleting a listed doc and re-reading, its row reads gone and selecting it shows No such file with its path", async () => {
            rmSync(ctx.plan);
            await page(h, `const a = globalStore.get(agentsModel().agentsAtom).find((x) => x.id === ${A}); await D.loadAgentDocs(a); return true;`);
            await polishWaitFor(h, `${ROWS}[1]?.querySelector("[data-docs-when]")?.innerText === "gone"`, WAIT_MS);
            await h.ev(`${ROWS}[1]?.click()`);
            await polishWaitFor(h, `${PANE}?.querySelector("[data-docs-gone]") != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await page(
                h,
                `const gone = ${PANE}?.querySelector("[data-docs-gone]");
                return {
                    when: ${ROWS}[1]?.querySelector("[data-docs-when]")?.innerText ?? null,
                    text: gone?.innerText ?? null,
                    path: gone?.querySelector("[data-docs-gone-path]")?.textContent ?? null,
                };`
            );
            await h.shot("cdp-shots/workspace-docs-gone.png");
            return [f.when === "gone" && (f.text ?? "").includes("No such file") && f.path === PLAN_REL, f];
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
            const A = JSON.stringify(ctx.aId);
            await step("close the workspace tabs", () =>
                page(h, `for (const t of [...ws(${A}).tabs]) W.closeWorkspaceTab(${A}, M.tabKey(t)); return true;`)
            );
        }
        if (typeof ctx.width === "number") {
            await step("restore the pane width", () => page(h, `globalStore.set(W.workspaceWidthAtom, ${ctx.width}); return true;`));
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("restore the default view", () => restoreDefaultView(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};
