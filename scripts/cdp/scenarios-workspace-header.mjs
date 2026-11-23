// Scenario `workspace-header`: the Rendered header's checkout facts (Task 3 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; Main board). A temp git repo holds a linked worktree with two
// changed files; a real orchestrator run held in planning (no model starts) makes a fixture claude agent working in
// that worktree its lead, and a second fixture agent works in the repo's clean main checkout. The lead's transcript
// makes the two edits; a third file someone else wrote stays off its changes row. Both are real tabs with
// no controller. The lead's user-owned asks are injected into the page's ask map. Teardown closes what the steps
// opened, cancels the run, deletes its channel and the repo, and puts back the default view.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { git, polishNap, polishWaitFor, teardownFixtureRun } from "./scenarios-shared.mjs";

const NAME = "workspace-header";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than the pane's reveal and a TickNumber's roll
const SETTLE_MS = 700;
const BRANCH = "feature-header";
const WORKTREE = ".worktrees/header";
// the lead's edits: two lines added to a.txt, one line of b.txt rewritten; not the stray file beside them
const CHIP_TEXT = "2 files +3 −1";
// the records sit a minute after the seed commit, so the session-start anchor is that commit whatever the clocks' rounding
const AHEAD_MS = 60_000;
const CHIP_TITLE = "Open the Changes tab";
const DOC_TITLES = { "first.md": "First notes", "second.md": "Second notes" };
const ask = (n) => ({ taskid: "t-1", askid: `fx-header-ask-${n}`, owner: "user", questions: [], blockoref: "", ts: n });

const HEADER = `document.querySelector("[data-agent-header]")`;
// the checkout's changes moved from the header to the first row of the message box
const CHIP = `document.querySelector("[data-rendered-composer] [data-composer-changes]")`;
const RUN_LINK = `${HEADER}?.querySelector("[data-header-run-link]")`;
const DOCS_LINK = `${HEADER}?.querySelector("[data-header-docs-link]")`;
const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
// the app's Markdown draws an h1 as a .heading.is-1 block
const DOCS_H1 = `(${PANE}?.querySelector("[data-docs-body] .heading.is-1")?.textContent ?? "").trim()`;

const LIB = `
    const W = await mod("app/view/agents/workspacestore.ts");
    const ws = (id) => globalStore.get(W.workspaceAtom(id));
    const header = () => ${HEADER};
    const slash = (p) => (p ?? "").replace(/\\\\/g, "/").toLowerCase();
`;
const page = (h, body) => agentPage(h, `${LIB} ${body}`);

// what the header says, for the steps to compare
const headerFacts = (h) =>
    page(
        h,
        `const hd = header();
        const link = ${RUN_LINK};
        const chip = ${CHIP};
        const wt = hd?.querySelector("[data-header-worktree]");
        const asks = link?.querySelector("[data-header-run-asks]");
        return {
            subline: flat(hd?.querySelector("[data-agent-subline]")),
            branchIcon: hd?.querySelector("[data-agent-subline] svg.lucide-git-branch") != null,
            worktree: wt ? { text: flat(wt), title: slash(wt.title), dir: wt.getAttribute("dir") } : null,
            actions: flat(hd?.querySelector("[data-agent-actions]")),
            link: link ? flat(link) : null,
            asks: asks ? { label: asks.getAttribute("aria-label"), text: flat(asks), dot: asks.querySelector(".bg-warning") != null } : null,
            chip: chip ? { text: flat(chip.querySelector("[data-composer-changes-summary]")), title: chip.title } : null,
        };`
    );

const setAsks = (h, runId, asks) =>
    page(
        h,
        `const C = await mod("app/view/agents/childaskstore.ts");
        globalStore.set(C.childAsksAtom, (prev) => ({ ...prev, ${JSON.stringify(runId)}: ${JSON.stringify(asks)} }));
        return true;`
    );

// the labels the header's right-click menu offers, read from the menu atom the host renders
const menuLabels = (h) =>
    page(
        h,
        `const { contextMenuAtom, closeContextMenu } = await mod("app/store/contextmenu.ts");
        header().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
        await until(() => globalStore.get(contextMenuAtom) != null, 2000);
        const items = globalStore.get(contextMenuAtom)?.items ?? [];
        closeContextMenu();
        return items.map((i) => i.label).filter(Boolean);`
    );

const rosterAgent = (id, blockId, name, transcriptPath, extra = {}) => ({
    id,
    name,
    project: "fx-header",
    task: "workspace header fixture",
    state: "idle",
    agent: "claude",
    model: "claude-opus-5-5",
    blockId,
    transcriptPath,
    ...extra,
});

function makeRepo(ctx) {
    const repo = ctx.cwd;
    git(repo, "init", "-q", "--initial-branch=main");
    // the transcripts sit in the repo, ignored like the worktree, so the main checkout stays clean
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\n.transcripts/\n");
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "b.txt"), "one\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "seed");
    const wt = join(repo, ...WORKTREE.split("/"));
    git(repo, "worktree", "add", "-q", "-b", BRANCH, wt);
    writeFileSync(join(wt, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(wt, "b.txt"), "uno\n");
    writeFileSync(join(wt, "stray.txt"), "written by someone else\n");
    return wt;
}

// the Edit calls that made the worktree's a.txt and b.txt, so the lead's changes row counts them as its own
function leadTranscript(ctx, name) {
    const t0 = Date.now() + AHEAD_MS;
    let n = 0;
    const at = () => ({ cwd: ctx.wt, ts: new Date(t0 + n++ * 1000).toISOString() });
    const edit = (id, file, from, to) => [
        toolUse(id, "Edit", { file_path: join(ctx.wt, file), old_string: from, new_string: to }, at()),
        toolResult(id, "ok", at()),
    ];
    return writeTranscript(join(ctx.cwd, ".transcripts"), name, [
        userText("Tidy the lead notes.", at()),
        ...edit("tu-a", "a.txt", "one\n", "one\ntwo\nthree\n"),
        ...edit("tu-b", "b.txt", "one\n", "uno\n"),
        assistantText("The lead notes are tidy.", at()),
    ]);
}

// two Markdown docs in a folder of their own, so the repo's checkouts stay clean; the later write is the newest
function makeDocs(ctx, tag) {
    ctx.docsDir = mkdtempSync(join(tmpdir(), "verify-workspace-header-docs-"));
    const t0 = Date.now() - 10 * 60_000;
    const at = (n) => ({ cwd: ctx.docsDir, ts: new Date(t0 + n * 60_000).toISOString() });
    const write = (id, name, n) => {
        writeFileSync(join(ctx.docsDir, name), `# ${DOC_TITLES[name]}\n\nBody.\n`);
        return [toolUse(id, "Write", { file_path: join(ctx.docsDir, name), content: "" }, at(n)), toolResult(id, "ok", at(n))];
    };
    return writeTranscript(join(ctx.docsDir, "transcripts"), `header-docs-${tag}`, [
        userText("Write the notes down.", at(0)),
        ...write("w-first", "first.md", 1),
        ...write("w-second", "second.md", 2),
        assistantText("The notes are written.", at(3)),
    ]);
}

async function focusRendered(h, id, name) {
    await focusAgent(h, id);
    const ok = await polishWaitFor(
        h,
        `(${HEADER}?.textContent ?? "").includes(${JSON.stringify(name)}) && document.querySelector("[data-rendered-composer]") != null`,
        WAIT_MS
    );
    if (!ok) throw new Error(`${name} never showed the Rendered view`);
}

export const workspaceHeader = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], cwd: mkdtempSync(join(tmpdir(), "verify-workspace-header-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            ctx.wt = makeRepo(ctx);
            const wslist = await h.rpc("workspacelist", null);
            const ch = await h.rpc("createchannel", { name: `verify-${NAME}`, projectpath: ctx.cwd });
            ctx.channelId = ch.oid;
            const created = await h.rpc("createrun", {
                channelid: ctx.channelId,
                workspaceid: wslist[0].workspacedata.oid,
                goal: `verify ${NAME}: do nothing`,
                runtime: "claude",
                mode: "orchestrator",
                deferstart: true,
            });
            ctx.runId = created.run.id;
            ctx.landPath = created.run.landpath;

            await h.goto("agent");
            await pinDefaultView(h, "rendered");
            const path = (n) =>
                writeTranscript(join(ctx.cwd, ".transcripts"), `header-${n}-${tag}`, [
                    userText(`Tidy the ${n} notes.`),
                    assistantText(`The ${n} notes are tidy.`),
                ]);
            // the rail reads the block's cwd before the transcript's
            const lead = await makeTab(h, ctx, {
                label: `header-lead-${tag}`,
                blockMeta: { view: "term", controller: null, "cmd:cwd": ctx.wt },
            });
            const clean = await makeTab(h, ctx, {
                label: `header-clean-${tag}`,
                blockMeta: { view: "term", controller: null, "cmd:cwd": ctx.cwd },
            });
            const docs = await makeTab(h, ctx, {
                label: `header-docs-${tag}`,
                blockMeta: { view: "term", controller: null, "cmd:cwd": ctx.cwd },
            });
            Object.assign(ctx, {
                docsId: docs.tabId,
                docsName: `header-docs-${tag}`,
                leadId: lead.tabId,
                leadName: `header-lead-${tag}`,
                cleanId: clean.tabId,
                cleanName: `header-clean-${tag}`,
            });
            await setRoster(h, [
                rosterAgent(lead.tabId, lead.blockId, ctx.leadName, leadTranscript(ctx, `header-lead-${tag}`), {
                    runId: ctx.runId,
                }),
                rosterAgent(clean.tabId, clean.blockId, ctx.cleanName, path("clean")),
                rosterAgent(docs.tabId, docs.blockId, ctx.docsName, makeDocs(ctx, tag)),
            ]);
            await focusRendered(h, ctx.leadId, ctx.leadName);
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
        const L = JSON.stringify(ctx.leadId);
        const runTab = `run:${ctx.runId}`;
        await focusRendered(h, ctx.leadId, ctx.leadName);

        await step("the subline shows the branch and the linked worktree, its full path as the title", async () => {
            await polishWaitFor(h, `${HEADER}?.querySelector("[data-header-worktree]") != null && ${RUN_LINK} != null`, WAIT_MS);
            const f = await headerFacts(h);
            const wtPath = ctx.wt.replace(/\\/g, "/").toLowerCase();
            const ok =
                f.subline.includes(BRANCH) &&
                f.branchIcon &&
                f.worktree?.text === WORKTREE &&
                f.worktree?.title === wtPath &&
                f.worktree?.dir === "rtl" &&
                f.subline.indexOf(BRANCH) < f.subline.indexOf(WORKTREE) &&
                f.subline.indexOf(WORKTREE) < f.subline.indexOf("orchestrator run");
            return [ok, { ...f, wtPath }];
        });

        await step("with no ask waiting on you the run link carries no count", async () => {
            // let the run's ask binding settle first, so the injected asks are not read over
            await polishNap(SETTLE_MS);
            const f = await headerFacts(h);
            return [f.link != null && f.asks == null, f];
        });

        await step("one user-owned ask: the run link shows the amber dot and 1", async () => {
            await setAsks(h, ctx.runId, [ask(1)]);
            ctx.asksInjected = true;
            await polishWaitFor(h, `${RUN_LINK}?.querySelector("[data-header-run-asks]") != null`, WAIT_MS);
            const f = await headerFacts(h);
            return [f.asks?.dot === true && f.asks.text === "1" && f.asks.label === "1 waiting on you", f.asks];
        });
        await h.shot("cdp-shots/workspace-header-main.png");

        // 12: the count rolls, the old value leaving while the new one rises in
        await step("a second ask rolls the run link's count from 1 to 2 (12)", async () => {
            const r = await page(
                h,
                `const roll = () => ${RUN_LINK}?.querySelector("[data-header-run-asks] .tabular-nums");
                const seen = [];
                let on = true;
                const tick = () => {
                    const n = roll()?.children.length ?? 0;
                    if (n !== seen.at(-1)) seen.push(n);
                    if (on) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
                const C = await mod("app/view/agents/childaskstore.ts");
                globalStore.set(C.childAsksAtom, (prev) => ({ ...prev, ${JSON.stringify(ctx.runId)}: ${JSON.stringify([ask(1), ask(2)])} }));
                await nap(${SETTLE_MS});
                on = false;
                return { spans: seen, text: flat(roll()) };`
            );
            return [r.spans.includes(2) && r.spans.at(-1) === 1 && r.text === "2", r];
        });

        await step(`the message box's changes row reads the worktree's changes, "${CHIP_TEXT}"`, async () => {
            await polishWaitFor(h, `${CHIP} != null`, WAIT_MS);
            const f = await headerFacts(h);
            return [f.chip?.text === CHIP_TEXT && f.chip.title === CHIP_TITLE && !/file/.test(f.actions), { chip: f.chip, actions: f.actions }];
        });

        await step("a plain click on the changes row opens the Changes tab beside the transcript, and the row stays", async () => {
            await h.ev(`${CHIP}.click()`);
            await polishNap(SETTLE_MS);
            const r = await page(
                h,
                `return {
                    surface: globalStore.get(agentsModel().surfaceAtom),
                    pane: document.querySelector("[data-workspace-pane]")?.dataset.workspacePane ?? null,
                    tab: document.querySelector('[data-workspace-tab="changes"]') != null,
                    active: ws(${L}).active,
                    row: ${CHIP} != null,
                };`
            );
            return [r.surface === "agent" && r.pane === "open" && r.tab && r.active === "changes" && r.row, r];
        });

        await step("a plain click on the run link opens the Run tab beside the transcript", async () => {
            await h.ev(`${RUN_LINK}.click()`);
            await polishNap(SETTLE_MS);
            const r = await page(
                h,
                `return {
                    surface: globalStore.get(agentsModel().surfaceAtom),
                    tab: document.querySelector('[data-workspace-tab=${JSON.stringify(runTab)}]') != null,
                    active: ws(${L}).active,
                    sheet: document.querySelector("[data-run-sheet]") != null,
                };`
            );
            return [r.surface === "agent" && r.tab && r.active === runTab && !r.sheet, r];
        });
        await h.shot("cdp-shots/workspace-header-run-tab.png");

        await step("beside the open pane the subline clips its facts and keeps the run link whole", async () => {
            const r = await page(
                h,
                `const line = header()?.querySelector("[data-agent-subline]")?.getBoundingClientRect();
                const link = ${RUN_LINK}?.getBoundingClientRect();
                const wt = header()?.querySelector("[data-header-worktree]");
                return {
                    lineRight: line ? Math.round(line.right) : null,
                    linkRight: link ? Math.round(link.right) : null,
                    worktreeW: wt ? Math.round(wt.getBoundingClientRect().width) : null,
                    worktreeClipped: wt ? wt.scrollWidth > wt.clientWidth : null,
                };`
            );
            return [r.linkRight != null && r.linkRight <= r.lineRight, r];
        });

        await step("Ctrl+click on the run link peeks the run instead, and opens no tab", async () => {
            const before = await page(h, `return ws(${L});`);
            // a real ctrl+click, so the gesture reaches React as the user's would
            const at = await h.ev(`(() => { const r = ${RUN_LINK}.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
            for (const type of ["mousePressed", "mouseReleased"]) {
                await h.cdp("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1, modifiers: 2 });
            }
            const peeked = await polishWaitFor(h, `document.querySelector('[data-pet-peek-item="run"]') != null`, WAIT_MS);
            const after = await page(h, `return ws(${L});`);
            await h.shot("cdp-shots/workspace-header-peek.png");
            // a real key event: the popup handles Escape on its dialog, which holds focus, not on the document
            for (const type of ["keyDown", "keyUp"]) {
                await h.cdp("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
            }
            const closed = await polishWaitFor(h, `document.querySelector("[data-pet-peek-item]") == null`, WAIT_MS);
            return [peeked && closed && JSON.stringify(after) === JSON.stringify(before), { peeked, closed, before, after }];
        });

        await step('the header menu in Rendered has no "Show details" or "Hide details"', async () => {
            const labels = await menuLabels(h);
            return [labels.length > 0 && !labels.some((l) => /details/i.test(l)), labels];
        });

        await step("a clean checkout shows its branch and no changes row", async () => {
            await focusRendered(h, ctx.cleanId, ctx.cleanName);
            const loaded = await polishWaitFor(h, `(${HEADER}?.querySelector("[data-agent-subline]")?.textContent ?? "").includes("main")`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await headerFacts(h);
            return [loaded && f.branchIcon && f.chip == null && f.worktree == null, f];
        });

        await step("no docs link: an agent that wrote no Markdown has no docs link in its subline", async () => {
            // the clean agent is focused: wait for its Docs read to land, so an empty list is the answer, not a pending
            // or failed read
            const C = JSON.stringify(ctx.cleanId);
            const readOf = () =>
                page(h, `const S = await mod("app/view/agents/workspacedocsstore.ts"); return globalStore.get(S.agentDocsReadAtom(${C}));`);
            let read = await readOf();
            for (let waited = 0; !read?.loaded && waited < WAIT_MS; waited += 250) {
                await polishNap(250);
                read = await readOf();
            }
            await polishNap(SETTLE_MS);
            const r = await page(
                h,
                `return { link: ${DOCS_LINK} != null, subline: flat(header()?.querySelector("[data-agent-subline]")) };`
            );
            return [read?.loaded && read.failure == null && !r.link && !/\bdocs?\b/.test(r.subline), { read, ...r }];
        });

        await step("docs link: an agent that wrote two Markdown files shows 2 docs, and a click opens the Docs tab on the newest", async () => {
            await focusRendered(h, ctx.docsId, ctx.docsName);
            await polishWaitFor(h, `${DOCS_LINK} != null`, WAIT_MS);
            const D = JSON.stringify(ctx.docsId);
            const before = await page(h, `return { link: flat(${DOCS_LINK}), tabs: ws(${D}).tabs.length };`);
            await h.ev(`${DOCS_LINK}.click()`);
            await polishWaitFor(h, `${DOCS_H1} === ${JSON.stringify(DOC_TITLES["second.md"])}`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const r = await page(
                h,
                `const t = ws(${D}).tabs.find((x) => x.kind === "docs");
                return {
                    surface: globalStore.get(agentsModel().surfaceAtom),
                    active: ws(${D}).active,
                    selected: t?.selected ?? null,
                    h1: ${DOCS_H1},
                    transcript: document.querySelector("[data-rendered-view]") != null,
                    link: flat(${DOCS_LINK}),
                };`
            );
            await h.shot("cdp-shots/workspace-header-docs.png");
            const ok =
                before.link === "2 docs" &&
                before.tabs === 0 &&
                r.surface === "agent" &&
                r.active === "docs" &&
                r.selected === null &&
                r.h1 === DOC_TITLES["second.md"] &&
                r.transcript &&
                r.link === "2 docs";
            return [ok, { before, ...r }];
        });

        await step("the Terminal view's header shows none of the new facts, and keeps its details toggle", async () => {
            await focusRendered(h, ctx.leadId, ctx.leadName);
            await page(
                h,
                `const R = await mod("app/view/agents/renderedmode.ts");
                globalStore.set(R.viewModeAtom(${L}), "terminal");
                return true;`
            );
            await polishWaitFor(h, `${HEADER}?.querySelector('[data-view-toggle][aria-pressed="false"]') != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const f = await headerFacts(h);
            const labels = await menuLabels(h);
            const ok =
                f.link != null &&
                f.asks == null &&
                f.chip == null &&
                f.worktree == null &&
                !f.branchIcon &&
                !f.subline.includes(BRANCH) &&
                labels.some((l) => /^(Show|Hide) details$/.test(l));
            return [ok, { ...f, labels }];
        });
        await h.shot("cdp-shots/workspace-header-terminal.png");
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
        const ids = [ctx.leadId, ctx.cleanId, ctx.docsId].filter(Boolean);
        await step("close the workspace tabs and put back the view", () =>
            page(
                h,
                `const R = await mod("app/view/agents/renderedmode.ts");
                for (const id of ${JSON.stringify(ids)}) {
                    for (const t of [...ws(id).tabs]) W.closeWorkspaceTab(id, t.kind === "run" ? "run:" + t.runId : t.kind === "file" ? "file:" + t.path : t.kind);
                    globalStore.set(R.viewModeAtom(id), "rendered");
                }
                return true;`
            )
        );
        if (ctx.asksInjected) {
            await step("drop the injected asks", () =>
                page(
                    h,
                    `const C = await mod("app/view/agents/childaskstore.ts");
                    globalStore.set(C.childAsksAtom, (prev) => { const next = { ...prev }; delete next[${JSON.stringify(ctx.runId)}]; return next; });
                    return true;`
                )
            );
        }
        await step("restore the roster", () => restoreRoster(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("restore the default view", () => restoreDefaultView(h));
        // cancels the run, deletes its channel, reloads, and removes the run's trees and the temp repo
        await teardownFixtureRun(h, ctx, NAME);
        if (ctx.docsDir) {
            await step("remove the docs folder", () => rmSync(ctx.docsDir, { recursive: true, force: true }));
        }
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("go home", () => h.goto("cockpit"));
    },
};
