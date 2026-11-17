// Scenario `workspace-file`: the workspace pane's File tab (Task 7 of docs/superpowers/plans/2026-11-17-workspace-pane.md;
// the File board). The roster is a fixture claude agent backed by a real tab with no controller, in the Rendered view,
// whose transcript's reply cites two files of a temp git repo by absolute path with a line. A click on a cited path
// opens a File tab holding the Code peek, landed on that line; Esc in the card closes its tab; Open in Code lands on
// the Code surface. The default view and the viewport are put back in teardown.

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

const NAME = "workspace-file";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than a tab's entrance and the card's view swap
const SETTLE_MS = 700;
const STATS_REL = "internal/stats/stats.go";
const STATS_LINES = 60;
const STATS_LINE = 41;
const DEDUPE_REL = "internal/dedupe/dedupe.go";
const DEDUPE_LINE = 4;
const PROMPT = "Where does the tag count live?";
const ESC = { key: "Escape", code: "Escape", keyCode: 27 };

const PANE = `document.querySelector('aside[aria-label="Workspace"]')`;
const CARD = `${PANE}?.querySelector('[data-code-peek][data-peek-variant="tab"]')`;
const tabSel = (key) => `[data-workspace-tab=${JSON.stringify(key)}]`;

const page = (h, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const ws = (id) => globalStore.get(W.workspaceAtom(id));
        ${body}`
    );

function makeRepo(dir) {
    mkdirSync(join(dir, "internal", "stats"), { recursive: true });
    mkdirSync(join(dir, "internal", "dedupe"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# linkshelf\n");
    writeFileSync(
        join(dir, DEDUPE_REL),
        ["package dedupe", "", "// Key folds a link to the form two duplicates share.", "func Key(url string) string {", "\treturn url", "}", ""].join("\n")
    );
    git(dir, "init", "-q", "--initial-branch=main");
    git(dir, "-c", "core.autocrlf=false", "add", ".");
    git(dir, "-c", "core.autocrlf=false", "commit", "-q", "-m", "seed");
    // new since HEAD, so its stat reads "new file"
    const stats = Array.from({ length: STATS_LINES }, (_, i) => (i === 0 ? "package stats" : i === STATS_LINE - 1 ? "func CountByTag() map[string]int { return nil }" : `// line ${i + 1}`));
    writeFileSync(join(dir, STATS_REL), stats.join("\n") + "\n");
}

export const workspaceFile = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-file-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            ctx.repo = join(ctx.dir, "linkshelf");
            makeRepo(ctx.repo);
            const abs = (rel) => join(ctx.repo, rel).replace(/\\/g, "/");
            ctx.stats = abs(STATS_REL);
            ctx.dedupe = abs(DEDUPE_REL);
            const reply = `The count lives in \`${ctx.stats}:${STATS_LINE}\`, and the duplicate key in \`${ctx.dedupe}:${DEDUPE_LINE}\`.`;
            const transcript = writeTranscript(join(ctx.dir, "transcripts"), `workspace-file-${tag}`, [userText(PROMPT), assistantText(reply)]);
            await h.goto("agent");
            await pinDefaultView(h, "rendered");
            const a = await makeTab(h, ctx, { label: `workspace-file-${tag}`, blockMeta: { view: "term", controller: null } });
            ctx.aId = a.tabId;
            await setRoster(h, [
                {
                    id: a.tabId,
                    name: `workspace-file-${tag}`,
                    project: "linkshelf",
                    task: "workspace file fixture",
                    state: "idle",
                    agent: "claude",
                    model: "claude-opus-5-5",
                    blockId: a.blockId,
                    transcriptPath: transcript,
                },
            ]);
            await focusAgent(h, ctx.aId);
            const linked = `[...document.querySelectorAll("[data-rendered-view] [data-file-link]")].length === 2`;
            if (!(await polishWaitFor(h, linked, WAIT_MS))) throw new Error("the reply's two file links never rendered");
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
        const statsKey = `file:${ctx.stats}`;
        const dedupeKey = `file:${ctx.dedupe}`;
        const samePath = (a, b) => (a ?? "").replace(/\\/g, "/").toLowerCase() === (b ?? "").toLowerCase();
        const clickLink = (path) =>
            h.ev(`(() => {
                const link = [...document.querySelectorAll("[data-rendered-view] [data-file-link]")].find((l) => l.getAttribute("data-file-link") === ${JSON.stringify(path)});
                if (!link) return false;
                getSelection().removeAllRanges();
                link.click();
                return true;
            })()`);
        // the card once its editor has drawn the cited line as the active one
        const landedOn = (line) =>
            polishWaitFor(
                h,
                `(${CARD})?.querySelector(".line-numbers.active-line-number")?.textContent.trim() === ${JSON.stringify(String(line))}`,
                WAIT_MS
            );
        const facts = () =>
            page(
                h,
                `const card = ${CARD};
                const ed = card?.querySelector(".monaco-editor");
                const active = card?.querySelector(".line-numbers.active-line-number");
                const box = ed?.getBoundingClientRect();
                const row = active?.getBoundingClientRect();
                const highlight = card?.querySelector(".current-line");
                const label = card?.querySelector("[data-peek-path]")?.previousElementSibling;
                return {
                    tabs: ws(${A}).tabs.map((t) => t.kind + ":" + (t.path ?? "")),
                    active: ws(${A}).active,
                    shown: [...document.querySelectorAll("[data-workspace-tab]")].map((t) => t.dataset.workspaceTab),
                    tabLabel: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() ?? null,
                    card: card != null,
                    state: card?.dataset.peekState ?? null,
                    label: label?.textContent.trim() ?? null,
                    path: card?.querySelector("[data-peek-path]")?.textContent.trim() ?? null,
                    title: card?.querySelector("[data-peek-path]")?.getAttribute("title") ?? null,
                    openInHeader: card?.querySelector("[data-peek-path]")?.parentElement.querySelector("[data-peek-open]")?.textContent.trim() ?? null,
                    closeButton: card?.querySelector('button[aria-label="Close the peek"]') != null,
                    footerKeys: [...(card?.querySelectorAll("kbd") ?? [])].map((k) => k.textContent),
                    source: card?.querySelector('[data-peek-mode="source"]')?.getAttribute("aria-pressed") ?? null,
                    readOnly: (card?.textContent ?? "").includes("Read-only"),
                    stat: card?.querySelector("[data-peek-stat]")?.textContent ?? null,
                    activeLine: active?.textContent.trim() ?? null,
                    inView: box != null && row != null && row.top >= box.top && row.bottom <= box.bottom,
                    highlighted: highlight != null && highlight.getBoundingClientRect().height > 0,
                    dock: document.querySelector("[data-rendered-peek]") != null,
                };`
            );

        await step("a click on path:line in a reply opens a File tab named by its base name, in Source, the cited line highlighted and in view (File board)", async () => {
            const clicked = await clickLink(ctx.stats);
            const landed = await landedOn(STATS_LINE);
            await polishNap(SETTLE_MS);
            const f = await facts();
            const ok =
                clicked &&
                landed &&
                f.tabs.length === 1 &&
                f.active === statsKey &&
                f.shown.includes(statsKey) &&
                f.tabLabel === "stats.go" &&
                f.state === "text" &&
                f.label === "Code" &&
                f.path === STATS_REL &&
                samePath(f.title, ctx.stats) &&
                f.openInHeader === "Open in Code" &&
                !f.closeButton &&
                f.footerKeys.length === 0 &&
                f.source === "true" &&
                f.readOnly &&
                (f.stat ?? "").includes("new file") &&
                f.activeLine === String(STATS_LINE) &&
                f.inView &&
                f.highlighted &&
                !f.dock;
            return [ok, { clicked, landed, ...f }];
        });
        await h.shot("cdp-shots/workspace-file-board.png");

        await step("a second click on the same link keeps the one tab and its card open", async () => {
            await clickLink(ctx.stats);
            await polishNap(SETTLE_MS);
            const f = await facts();
            return [f.tabs.length === 1 && f.active === statsKey && f.card && f.activeLine === String(STATS_LINE), f];
        });

        await step("a link to another file adds a second File tab, landed on its line", async () => {
            const clicked = await clickLink(ctx.dedupe);
            const landed = await landedOn(DEDUPE_LINE);
            const f = await facts();
            const ok = clicked && landed && f.tabs.length === 2 && f.active === dedupeKey && f.tabLabel === "dedupe.go" && f.path === DEDUPE_REL;
            return [ok, { clicked, landed, ...f }];
        });

        await step("activating the first File tab shows its file again, on its line", async () => {
            await h.ev(`document.querySelector('${tabSel(statsKey)} [role="tab"]')?.click()`);
            const landed = await landedOn(STATS_LINE);
            const f = await facts();
            return [landed && f.active === statsKey && f.path === STATS_REL, { landed, ...f }];
        });

        await step("Esc in the card closes its tab, and the other File tab shows its file", async () => {
            const focused = await h.ev(`(() => { const c = ${CARD}; c?.focus(); return c != null && c.contains(document.activeElement); })()`);
            await h.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ESC.key, code: ESC.code, windowsVirtualKeyCode: ESC.keyCode });
            await h.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ESC.key, code: ESC.code, windowsVirtualKeyCode: ESC.keyCode });
            const closed = await polishWaitFor(h, `document.querySelector('${tabSel(statsKey)}') == null`, WAIT_MS);
            const landed = await landedOn(DEDUPE_LINE);
            const f = await facts();
            return [focused && closed && landed && f.tabs.length === 1 && f.active === dedupeKey && f.path === DEDUPE_REL, { focused, closed, landed, ...f }];
        });

        await step("Open in Code lands on the Code surface at the cited line", async () => {
            const r = await page(
                h,
                `const C = await mod("app/view/code/codestore.ts");
                (${CARD})?.querySelector("[data-peek-open]")?.click();
                await until(() => globalStore.get(C.codeFileAtom)?.path === ${JSON.stringify(DEDUPE_REL)} && globalStore.get(C.codeFileAtom)?.kind === "text", 8000);
                await until(() => flat(document.querySelector(".line-numbers.active-line-number")) === ${JSON.stringify(String(DEDUPE_LINE))} || globalStore.get(C.codePendingJumpAtom)?.line === ${DEDUPE_LINE}, 4000);
                const model = agentsModel();
                return {
                    surface: globalStore.get(model.surfaceAtom),
                    file: globalStore.get(C.codeFileAtom)?.path ?? null,
                    pending: globalStore.get(C.codePendingJumpAtom)?.line ?? null,
                    caret: flat(document.querySelector(".line-numbers.active-line-number")),
                    tabs: ws(${A}).tabs.length,
                };`
            );
            await h.shot("cdp-shots/workspace-file-code.png");
            const ok = r.surface === "code" && r.file === DEDUPE_REL && (r.pending === DEDUPE_LINE || r.caret === String(DEDUPE_LINE));
            return [ok, r];
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
                page(
                    h,
                    `for (const t of [...ws(${JSON.stringify(ctx.aId)}).tabs]) W.closeWorkspaceTab(${JSON.stringify(ctx.aId)}, "file:" + t.path);
                    return true;`
                )
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
