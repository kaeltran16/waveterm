// Scenario `workspace-changes`: the workspace pane's Changes tab (Task 6 of
// docs/superpowers/plans/2026-11-17-workspace-pane.md; board Changes). The roster is a fixture of two claude agents
// backed by real tabs with no controller, in the Rendered view: A's block names a temp repo with two uncommitted
// edits, B's a clean one. No transcript card opens the tab yet, so the steps open it through the workspace store, as
// the header chip will. Teardown closes the workspace tabs, the tabs and the roster, and removes the temp dir.

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
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { git, polishNap, polishWaitFor } from "./scenarios-shared.mjs";

const NAME = "workspace-changes";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// a fresh app's first git reads in a new repo can take a while
const GIT_WAIT_MS = 20_000;
// past the view fade, so a read after it sees the settled body
const SETTLE_MS = 700;
const FIRST = "alpha.md";
const SECOND = "beta.md";
// a line only each file's edited side has, so the diff on screen names its file
const FIRST_MARK = "alpha edited by the fixture";
const SECOND_MARK = "beta edited by the fixture";
const LINE_RE = /^2 files \+3 −1 · main, (uncommitted|since session start)$/;

const TAB = `document.querySelector("[data-workspace-changes]")`;
const OTHER_FILE = { kind: "file", path: "notes/other.md", line: null };

// page helpers spliced into each evaluated body
const LIB = `
    const W = await mod("app/view/agents/workspacestore.ts");
    const ws = (id) => globalStore.get(W.workspaceAtom(id));
    const tab = () => ${TAB};
    // every line the diff editor draws, across both of its editors; monaco draws spaces as no-break spaces
    const lines = (root) =>
        [...(root?.querySelectorAll("[data-diff-pane] .monaco-editor .view-line") ?? [])].map((l) => l.textContent.replace(/\\u00a0/g, " ")).join("\\n");
    const tabFacts = async () => {
        const R = await mod("app/view/agents/railstore.ts");
        const rail = globalStore.get(R.railStateAtom);
        const t = tab();
        return {
            line: flat(t?.querySelector("[data-workspace-changes-line]")),
            rows: [...(t?.querySelectorAll("[data-changed-file-row]") ?? [])].map((r) => r.dataset.changedFileRow),
            selectedRow: t?.querySelector('[data-changed-file-row][aria-current="true"]')?.dataset.changedFileRow ?? null,
            railFiles: (rail?.changes?.files ?? []).map((f) => f.path + " +" + f.adds + " -" + f.dels),
            diffFile: flat(t?.querySelector("[data-diff-filename]")),
            diffText: lines(t),
            empty: document.querySelector("[data-workspace-changes-empty]")?.dataset.workspaceChangesEmpty ?? null,
        };
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
`;
const page = (h, body) => agentPage(h, `${LIB} ${body}`);
const facts = (h) => page(h, `return await tabFacts();`);
const openChanges = (h, id) => page(h, `W.openWorkspaceTab(${JSON.stringify(id)}, { kind: "changes", selected: null }); return true;`);
const waitTab = (h, cond, ms = WAIT_MS) => polishWaitFor(h, `(async () => { ${LIB} const f = await tabFacts(); return ${cond}; })()`, ms);

// what the Diff surface shows: its scope's origin, the file its diff pane draws and the pair it loaded
const diffSurface = (h) =>
    page(
        h,
        `const model = agentsModel();
        const P = await mod("app/view/agents/diffcontentstore.ts");
        const scope = globalStore.get(model.diffScopeAtom);
        return {
            surface: globalStore.get(model.surfaceAtom),
            origin: scope?.repo?.origin ?? null,
            file: flat(document.querySelector("[data-diff-pane] [data-diff-filename]")),
            pair: globalStore.get(P.diffPairAtom)?.path ?? null,
            text: lines(document),
        };`
    );

const rosterAgent = (id, blockId, name, transcriptPath) => ({
    id,
    name,
    project: name,
    task: "changes tab fixture",
    state: "idle",
    agent: "claude",
    model: "claude-opus-5-5",
    blockId,
    transcriptPath,
});

function makeRepo(root, name, files) {
    const repo = join(root, name);
    mkdirSync(repo);
    git(repo, "init", "-q", "--initial-branch=main");
    for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "seed");
    return repo;
}

async function arrangeAgentA(h, ctx) {
    await h.goto("agent");
    await pinDefaultView(h, "rendered");
    await setRoster(h, ctx.roster);
    await focusAgent(h, ctx.aId);
    if (!(await polishWaitFor(h, `document.querySelector("[data-rendered-composer]") != null`, WAIT_MS))) {
        throw new Error("agent A never showed the Rendered view");
    }
}

export const workspaceChanges = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-changes-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const edited = makeRepo(ctx.dir, "edited", { [FIRST]: "alpha\n", [SECOND]: "beta one\nbeta two\n" });
            // +2 −0 and +1 −1: the line reads +3 −1
            writeFileSync(join(edited, FIRST), `alpha\n${FIRST_MARK}\nalpha again\n`);
            writeFileSync(join(edited, SECOND), `beta one\n${SECOND_MARK}\n`);
            const clean = makeRepo(ctx.dir, "clean", { "readme.md": "clean\n" });
            const transcripts = join(ctx.dir, "transcripts");
            mkdirSync(transcripts);
            const path = (n, cwd) =>
                writeTranscript(transcripts, `changes-${n}-${tag}`, [
                    userText(`Tidy the ${n} notes.`, { cwd }),
                    assistantText(`The ${n} notes are tidy.`, { cwd }),
                ]);
            await h.goto("agent");
            // the rail reads the block's cwd before the transcript's; no controller, so no shell stamps its own
            const a = await makeTab(h, ctx, { label: `changes-a-${tag}`, blockMeta: { view: "term", controller: null, "cmd:cwd": edited } });
            const b = await makeTab(h, ctx, { label: `changes-b-${tag}`, blockMeta: { view: "term", controller: null, "cmd:cwd": clean } });
            Object.assign(ctx, { aId: a.tabId, bId: b.tabId });
            ctx.roster = [
                rosterAgent(a.tabId, a.blockId, `changes-a-${tag}`, path("edited", edited)),
                rosterAgent(b.tabId, b.blockId, `changes-b-${tag}`, path("clean", clean)),
            ];
            await arrangeAgentA(h, ctx);
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

        await step("the list and its line are the agent's rail changes (Changes board)", async () => {
            await openChanges(h, ctx.aId);
            await waitTab(h, `f.rows.length === 2 && f.line !== ""`, GIT_WAIT_MS);
            const f = await facts(h);
            // the line's +3 −1 is the sum of exactly these two
            const ok =
                f.rows.join(",") === `${FIRST},${SECOND}` &&
                f.railFiles.join(",") === `${FIRST} +2 -0,${SECOND} +1 -1` &&
                LINE_RE.test(f.line);
            return [ok, f];
        });
        await step("the first file's diff shows beside the list", async () => {
            await waitTab(h, `f.diffText.includes(${JSON.stringify(FIRST_MARK)})`, WAIT_MS);
            const f = await facts(h);
            return [f.selectedRow === FIRST && f.diffFile === FIRST && f.diffText.includes(FIRST_MARK), { selectedRow: f.selectedRow, diffFile: f.diffFile }];
        });
        await h.shot("cdp-shots/workspace-changes-first.png");
        // ViewSwap: the new file's diff fades in rather than cutting
        await step("selecting the second file swaps the diff (ViewSwap)", async () => {
            const r = await page(
                h,
                `const swap = () => tab()?.querySelector('[data-view-swap=${JSON.stringify(SECOND)}]');
                const s = sampleFrames(() => (swap() ? Number(getComputedStyle(swap()).opacity).toFixed(2) : null));
                tab().querySelector('[data-changed-file-row=${JSON.stringify(SECOND)}]').click();
                await until(async () => (await tabFacts()).diffText.includes(${JSON.stringify(SECOND_MARK)}), ${WAIT_MS});
                await nap(${SETTLE_MS});
                s.stop();
                const f = await tabFacts();
                return { opacities: s.values.map(Number), selected: ws(${A}).tabs.find((t) => t.kind === "changes")?.selected, diffFile: f.diffFile, has: f.diffText.includes(${JSON.stringify(SECOND_MARK)}) };`
            );
            const mid = r.opacities.some((o) => o > 0 && o < 1);
            return [mid && r.opacities.at(-1) === 1 && r.selected === SECOND && r.diffFile === SECOND && r.has, r];
        });
        await h.shot("cdp-shots/workspace-changes-second.png");
        await step("the selection holds across another tab and another agent", async () => {
            await page(h, `W.openWorkspaceTab(${A}, ${JSON.stringify(OTHER_FILE)}); return true;`);
            await polishNap(SETTLE_MS);
            await page(h, `W.activateWorkspaceTab(${A}, "changes"); return true;`);
            await waitTab(h, `f.diffFile !== ""`);
            const afterTab = await facts(h);
            await focusAgent(h, ctx.bId);
            await polishNap(SETTLE_MS);
            await focusAgent(h, ctx.aId);
            await waitTab(h, `f.rows.length === 2 && f.diffText.includes(${JSON.stringify(SECOND_MARK)})`, GIT_WAIT_MS);
            const afterAgent = await facts(h);
            const ok = afterTab.selectedRow === SECOND && afterTab.diffFile === SECOND && afterAgent.selectedRow === SECOND && afterAgent.diffFile === SECOND;
            return [ok, { afterTab: afterTab.diffFile, afterAgent: afterAgent.diffFile }];
        });
        await step("Open on Diff lands on the agent's scope", async () => {
            await h.ev(`${TAB}?.querySelector("[data-workspace-open-diff]")?.click()`);
            await polishWaitFor(
                h,
                `(async () => { ${LIB} const m = agentsModel(); return globalStore.get(m.surfaceAtom) === "files" && document.querySelector("[data-diff-pane] .monaco-editor") != null; })()`,
                GIT_WAIT_MS
            );
            await polishNap(SETTLE_MS);
            const d = await diffSurface(h);
            ctx.diffOwn = d.file;
            const ok = d.surface === "files" && d.origin?.kind === "agent" && d.origin?.id === ctx.aId && d.file !== "" && d.pair === d.file;
            return [ok, d];
        });
        await h.shot("cdp-shots/workspace-changes-on-diff.png");
        await step("a clean repo's tab says there are no changes", async () => {
            await focusAgent(h, ctx.bId);
            await openChanges(h, ctx.bId);
            await waitTab(h, `f.empty != null`, GIT_WAIT_MS);
            const f = await facts(h);
            const title = await h.ev(`document.querySelector("[data-workspace-changes-empty] h2")?.textContent ?? null`);
            return [f.empty === "clean" && title === "No changes", { empty: f.empty, title }];
        });
        await h.shot("cdp-shots/workspace-changes-clean.png");
        await step("after the tab shows another file, the Diff surface still shows its own selection", async () => {
            // the tab moves to whichever file the Diff surface is not showing
            const other = ctx.diffOwn === FIRST ? SECOND : FIRST;
            const mark = other === FIRST ? FIRST_MARK : SECOND_MARK;
            await focusAgent(h, ctx.aId);
            await waitTab(h, `f.rows.length === 2`, GIT_WAIT_MS);
            await h.ev(`${TAB}?.querySelector('[data-changed-file-row=${JSON.stringify(other)}]')?.click()`);
            await waitTab(h, `f.diffText.includes(${JSON.stringify(mark)})`);
            const tabFile = (await facts(h)).diffFile;
            await h.goto("files");
            await polishWaitFor(h, `document.querySelector("[data-diff-pane] .monaco-editor") != null`, GIT_WAIT_MS);
            await polishNap(SETTLE_MS);
            const d = await diffSurface(h);
            const ok =
                tabFile === other &&
                d.origin?.kind === "agent" &&
                d.origin?.id === ctx.aId &&
                d.file === ctx.diffOwn &&
                d.pair === ctx.diffOwn &&
                !d.text.includes(mark);
            return [ok, { tabFile, own: ctx.diffOwn, ...d, text: undefined }];
        });
        await h.shot("cdp-shots/workspace-changes-diff-own.png");
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
        await step("close the workspace tabs", () =>
            page(
                h,
                `for (const id of ${JSON.stringify([ctx.aId, ctx.bId].filter(Boolean))}) {
                    for (const t of [...ws(id).tabs]) W.closeWorkspaceTab(id, t.kind === "run" ? "run:" + t.runId : t.kind === "file" ? "file:" + t.path : t.kind);
                }
                return true;`
            )
        );
        await step("restore the roster", () => restoreRoster(h));
        await step("restore the default view", () => restoreDefaultView(h));
        await step("close the tabs", () => closeTabs(h, ctx));
        await step("clear the viewport", () => h.cdp("Emulation.clearDeviceMetricsOverride", {}));
        await step("remove the temp dir", () => rmSync(ctx.dir, { recursive: true, force: true }));
        await step("go home", () => h.goto("cockpit"));
    },
};
