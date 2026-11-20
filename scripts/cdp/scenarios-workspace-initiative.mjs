// Scenario `workspace-initiative`: the workspace pane's Initiative tab (Tasks 1 and 4 of
// docs/superpowers/plans/2026-11-20-workspace-surfaces.md; spec 2026-11-20-workspace-surfaces-design.md). The roster is a
// fixture claude agent backed by a real tab with no controller, in the Rendered view, tagged with a real initiative made
// over RPC: 9 chunks, 6 done, chunk 6 active with 5 notes, the rest pending. Its transcript holds a `wsh effort chunk status ... done`
// card. The steps click the header's initiative chip and the card's Open link, toggle a chunk's notes, change a chunk
// through the same RPC `wsh effort` sends, narrow the pane to its minimum, and delete the initiative under the open tab.
// Teardown deletes the initiative if a step did not, and puts the pane width, default view and viewport back.

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
    toolResult,
    toolUse,
    userText,
    writeTranscript,
} from "./agent-page-fixtures.mjs";
import { polishNap, polishWaitFor, restoreLocalStorage } from "./scenarios-shared.mjs";

const NAME = "workspace-initiative";
const VIEWPORT = { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false };
const WAIT_MS = 10_000;
// longer than a tab's entrance, the body's view swap and a chunk's notes reveal
const SETTLE_MS = 700;
const WIDTH_KEY = "agent.workspace.width";
const DEFAULT_PX = 600;
const NARROW_PX = 360;
const PROMPT = "Where does the plan stand?";
const REPLY = "Two chunks are left.";
const TITLE = "verify workspace-initiative: stats and dedupe";
const CHUNKS = [
    "Decide the stats shape",
    "Count by agent",
    "Count by project",
    "Dedupe repeated reads",
    "Bench the dedupe",
    "Wire the stats panel",
    "Drop the old counter",
    "Tidy the fixtures",
    "Confirm the totals",
];
const DONE = [1, 2, 3, 4, 7, 9];
const ACTIVE = 6;
// with the "marked active" note the status change writes, the active chunk holds 5 notes
const ACTIVE_NOTES = ["Picked up the panel.", "Rows render.", "Totals wired.", "Narrow layout next."];
// a done chunk holds its "marked done" note, so it opens
const OTHER = 1;
// the pending chunk the refresh step finishes
const REFRESHED = 5;

const label = (n) => CHUNKS[n - 1];

const page = (h, body) =>
    agentPage(
        h,
        `const W = await mod("app/view/agents/workspacestore.ts");
        const ws = (id) => globalStore.get(W.workspaceAtom(id));
        ${body}`
    );

const BODY = `document.querySelector("[data-workspace-initiative]")`;
const CHIP = `document.querySelector("[data-header-initiative-link]")`;
const CARD_OPEN = `document.querySelector("[data-rendered-view] [data-initiative-card-open]")`;
const chunkSel = (n) => `${BODY}?.querySelector('[data-workspace-initiative-chunk="${n}"]')`;

// what the open tab shows: its progress, segments, chunk rows, the open chunk and its notes
const READ_BODY = `const body = ${BODY};
    const rows = [...(body?.querySelectorAll("[data-workspace-initiative-chunk]") ?? [])];
    const open = rows.filter((r) => r.querySelector('button[aria-expanded="true"]') != null);
    const notesOf = (r) => r.querySelector("[data-workspace-initiative-notes]");
    return {
        progress: body?.querySelector("[data-workspace-initiative-progress]")?.textContent.trim() ?? null,
        segments: body?.querySelectorAll("[data-chunk-segments] > span").length ?? -1,
        rows: rows.length,
        open: open.map((r) => Number(r.getAttribute("data-workspace-initiative-chunk"))),
        notesShown: rows.filter((r) => notesOf(r) != null).map((r) => Number(r.getAttribute("data-workspace-initiative-chunk"))),
        notes: open.length === 1 ? notesOf(open[0])?.querySelectorAll(":scope > div").length ?? 0 : -1,
        older: open.length === 1 ? notesOf(open[0])?.querySelector("[data-workspace-initiative-older]")?.textContent.trim() ?? null : null,
        statuses: rows.map((r) => r.querySelector("[data-workspace-initiative-status]")?.textContent.trim() ?? null),
    };`;

export const workspaceInitiative = {
    name: NAME,
    surface: "agent",
    async arrange(h) {
        const tag = Date.now().toString(36);
        const ctx = { tabIds: [], dir: mkdtempSync(join(tmpdir(), "verify-workspace-initiative-")) };
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            await h.cdp("Emulation.setDeviceMetricsOverride", VIEWPORT);
            const effort = await h.rpc("effortcreate", { title: TITLE, project: "linkshelf", chunks: CHUNKS.map((label) => ({ label })) });
            ctx.effortId = effort.effortoid;
            await h.rpc("effortmutate", {
                effortoid: ctx.effortId,
                author: "you",
                ops: [
                    ...DONE.map((n) => ({ op: "setChunkStatus", chunk: label(n), status: "done" })),
                    { op: "setChunkStatus", chunk: label(ACTIVE), status: "active" },
                    ...ACTIVE_NOTES.map((note) => ({ op: "appendNote", chunk: label(ACTIVE), note })),
                ],
            });
            const transcript = writeTranscript(join(ctx.dir, "transcripts"), `workspace-initiative-${tag}`, [
                userText(PROMPT),
                // a chunk-done card draws in the timeline with the initiative's Open link
                toolUse("toolu_wi_done", "Bash", { command: `wsh effort chunk status effort:${ctx.effortId} ${DONE[0]} done`, description: "Tick chunk 1" }),
                toolResult("toolu_wi_done", "ok"),
                assistantText(REPLY),
            ]);
            await h.goto("agent");
            await pinDefaultView(h, "rendered");
            ctx.prevWidth = await page(
                h,
                `return { atom: globalStore.get(W.workspaceWidthAtom), stored: localStorage.getItem(${JSON.stringify(WIDTH_KEY)}) };`
            );
            await page(h, `globalStore.set(W.workspaceWidthAtom, ${DEFAULT_PX}); return true;`);
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
                    effortId: ctx.effortId,
                },
            ]);
            await focusAgent(h, ctx.aId);
            if (!(await polishWaitFor(h, `document.querySelector("[data-rendered-view]") != null && ${CHIP} != null`, WAIT_MS))) {
                throw new Error("the Rendered view never drew the header's initiative chip");
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
        const read = () => page(h, READ_BODY);
        const tabsOf = () => page(h, `return { tabs: ws(${A}).tabs.map((t) => t.kind), active: ws(${A}).active, tabOpen: ws(${A}).tabs.find((t) => t.kind === "initiative")?.open };`);

        await step("initiative from header chip: a plain click opens the tab beside the transcript, the active chunk's 3 latest notes open", async () => {
            await h.ev(`${CHIP}.click()`);
            const drawn = await polishWaitFor(h, `${BODY}?.querySelector("[data-workspace-initiative-progress]") != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const strip = await page(
                h,
                `const tab = document.querySelector('${tabSel} [role="tab"]');
                return {
                    label: tab?.textContent.trim() ?? null,
                    selected: tab?.getAttribute("aria-selected") ?? null,
                    icon: tab?.querySelector("svg")?.getAttribute("class") ?? null,
                    transcript: document.querySelector("[data-rendered-view]") != null,
                };`
            );
            const f = { ...(await tabsOf()), ...strip, ...(await read()) };
            await h.shot("cdp-shots/workspace-initiative-tab.png");
            const ok =
                drawn &&
                f.transcript &&
                f.tabs.length === 1 &&
                f.active === key &&
                f.label === `Initiative · ${TITLE}` &&
                f.selected === "true" &&
                (f.icon ?? "").includes("lucide-flag") &&
                f.progress === `${DONE.length} of 9 chunks done` &&
                f.segments === 9 &&
                f.rows === 9 &&
                f.open.length === 1 &&
                f.open[0] === ACTIVE &&
                f.notes === 3 &&
                f.older === "2 older notes in Hub";
            return [ok, { drawn, ...f }];
        });

        await step("toggle chunk: clicking another chunk with notes opens it and closes the first", async () => {
            await h.ev(`${chunkSel(OTHER)}?.querySelector("button").click()`);
            await polishNap(SETTLE_MS);
            const f = { ...(await tabsOf()), ...(await read()) };
            // the first chunk holds only its "marked done" note
            const ok =
                f.open.length === 1 &&
                f.open[0] === OTHER &&
                f.notesShown.length === 1 &&
                f.notesShown[0] === OTHER &&
                f.notes === 1 &&
                f.tabOpen === OTHER &&
                f.tabs.length === 1;
            return [ok, f];
        });

        await step("initiative from card: a plain click on the card's Open link activates the same tab, no second tab", async () => {
            // another tab in front first, so the click has a tab to activate
            await page(h, `W.openWorkspaceTab(${A}, { kind: "changes", selected: null }); return true;`);
            // a finished turn may fold its work, the card with it
            await h.ev(`document.querySelector('[data-rendered-view] [data-fold][aria-expanded="false"]')?.click()`);
            const card = await polishWaitFor(h, `${CARD_OPEN} != null`, WAIT_MS);
            const before = await tabsOf();
            if (card) {
                await h.ev(`${CARD_OPEN}.click()`);
            }
            await polishNap(SETTLE_MS);
            const after = await tabsOf();
            await page(h, `W.closeWorkspaceTab(${A}, "changes"); return true;`);
            await polishNap(SETTLE_MS);
            const ok =
                card &&
                before.active === "changes" &&
                after.active === key &&
                after.tabs.filter((k) => k === "initiative").length === 1 &&
                after.tabs.length === 2;
            return [ok, { card, before, after }];
        });

        await step("ctrl peeks: Ctrl+click on the header chip opens the initiative's peek and no tab", async () => {
            const before = await tabsOf();
            await h.ev(`${CHIP}.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }))`);
            const f = await agentPage(
                h,
                `const P = await mod("app/view/jarvis/peekstore.ts");
                const deadline = Date.now() + ${WAIT_MS};
                while (globalStore.get(P.peekItemAtom) == null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
                const target = globalStore.get(P.peekItemAtom)?.target ?? null;
                P.closePeek();
                return { target };`
            );
            const after = await tabsOf();
            const ok =
                f.target?.kind === "effort" &&
                f.target?.effortId === ctx.effortId &&
                after.tabs.length === before.tabs.length &&
                after.active === before.active;
            return [ok, { ...f, before, after }];
        });

        await step("initiative refresh: a chunk status change made through wsh effort's RPC shows in the open tab without a reload", async () => {
            await h.ev(`(window.__wiNoReload = true)`);
            await h.rpc("effortmutate", {
                effortoid: ctx.effortId,
                author: "agent",
                ops: [{ op: "setChunkStatus", chunk: label(REFRESHED), status: "done" }],
            });
            const moved = await polishWaitFor(
                h,
                `${chunkSel(REFRESHED)}?.querySelector("[data-workspace-initiative-status]")?.textContent.trim() === "done"`,
                WAIT_MS
            );
            const f = { ...(await read()), sameDocument: await h.ev(`window.__wiNoReload === true`) };
            const ok = moved && f.sameDocument && f.progress === `${DONE.length + 1} of 9 chunks done` && f.rows === 9;
            return [ok, { moved, ...f }];
        });

        await step("initiative narrow: at a 360px pane no status words show and every chunk row does", async () => {
            await page(h, `globalStore.set(W.workspaceWidthAtom, ${NARROW_PX}); return true;`);
            await polishNap(SETTLE_MS);
            const f = await h.ev(`(() => {
                const body = ${BODY};
                const list = body?.querySelector('[role="list"]')?.getBoundingClientRect();
                const rows = [...(body?.querySelectorAll("[data-workspace-initiative-chunk]") ?? [])].map((r) => r.getBoundingClientRect());
                const words = [...(body?.querySelectorAll("[data-workspace-initiative-status]") ?? [])];
                return {
                    width: Math.round(body?.getBoundingClientRect().width ?? 0),
                    rows: rows.length,
                    rowsInside: list ? rows.filter((r) => r.height > 0 && r.top >= list.top - 1 && r.bottom <= list.bottom + 1).length : -1,
                    wordsShown: words.filter((w) => getComputedStyle(w).display !== "none").length,
                };
            })()`);
            await h.shot("cdp-shots/workspace-initiative-narrow.png");
            await page(h, `globalStore.set(W.workspaceWidthAtom, ${DEFAULT_PX}); return true;`);
            const ok = f.width > 0 && f.width <= NARROW_PX && f.rows === 9 && f.rowsInside === 9 && f.wordsShown === 0;
            return [ok, f];
        });

        await step("initiative gone: after the initiative is deleted the tab says so, and Close tab removes it", async () => {
            await h.rpc("effortdelete", { effortoid: ctx.effortId });
            ctx.effortDeleted = true;
            const gone = await polishWaitFor(h, `${BODY}?.querySelector("[data-workspace-initiative-gone]") != null`, WAIT_MS);
            await polishNap(SETTLE_MS);
            const text = await h.ev(`(${BODY}?.querySelector("[data-workspace-initiative-gone]")?.innerText ?? "").replace(/\\s+/g, " ").trim()`);
            await h.shot("cdp-shots/workspace-initiative-gone.png");
            await h.ev(`${BODY}?.querySelector("[data-workspace-initiative-close]")?.click()`);
            await polishNap(SETTLE_MS);
            const after = await tabsOf();
            const ok = gone && text.includes("This initiative is gone") && after.tabs.length === 0;
            return [ok, { gone, text, after }];
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
                    `W.closeWorkspaceTab(${JSON.stringify(ctx.aId)}, ${JSON.stringify(`initiative:${ctx.effortId}`)});
                    W.closeWorkspaceTab(${JSON.stringify(ctx.aId)}, "changes");
                    return true;`
                )
            );
        }
        if (ctx.prevWidth != null) {
            await step("restore the pane width", () =>
                page(
                    h,
                    `globalStore.set(W.workspaceWidthAtom, ${JSON.stringify(ctx.prevWidth.atom)});
                    ${restoreLocalStorage(WIDTH_KEY, ctx.prevWidth.stored)};
                    return true;`
                )
            );
        }
        if (ctx.effortId && !ctx.effortDeleted) {
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
